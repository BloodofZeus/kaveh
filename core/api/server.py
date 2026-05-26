from __future__ import annotations

import json
import subprocess
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from core.api.engine_client import EngineClient
from core.config.store import AppConfig, ConfigStore


def _write_json(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    raw = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(raw)))
    origin = handler.headers.get("Origin", "")
    if origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:"):
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Vary", "Origin")
        handler.send_header("Access-Control-Allow-Headers", "Content-Type")
        handler.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
    handler.end_headers()
    handler.wfile.write(raw)


def _read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length).decode("utf-8") if length > 0 else ""
    data = json.loads(raw) if raw.strip() else {}
    return data if isinstance(data, dict) else {}

def _list_processes() -> list[dict[str, Any]]:
    cmd = [
        "powershell",
        "-NoProfile",
        "-Command",
        "Get-Process | Select-Object -First 60 Id,ProcessName | ConvertTo-Json -Compress",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
        if proc.returncode != 0:
            return []
        raw = proc.stdout.strip()
        if not raw:
            return []
        data = json.loads(raw)
        items = data if isinstance(data, list) else [data]
        out: list[dict[str, Any]] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            pid = it.get("Id")
            name = it.get("ProcessName")
            if isinstance(pid, int) and isinstance(name, str):
                out.append({"pid": pid, "name": name})
        return out
    except Exception:
        return []


class RotationManager:
    def __init__(self, server: "_KavehPythonAPIServer") -> None:
        self._server = server
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False
        self._last_error = ""
        self._last_rotated_at: float | None = None

    def status(self) -> dict[str, Any]:
        cfg = self._server.config_store.load()
        with self._lock:
            last_rotated_at = self._last_rotated_at
            last_error = self._last_error
            running = self._running

        current = cfg.upstream_proxy_url.strip()
        pool = [x.strip() for x in cfg.proxy_rotation_pool if str(x).strip()]
        next_upstream = ""
        if pool:
            idx = cfg.proxy_rotation_index % len(pool)
            next_upstream = pool[idx]

        return {
            "running": running,
            "enabled": bool(cfg.proxy_rotation_enabled),
            "interval_sec": int(cfg.proxy_rotation_interval_sec),
            "pool_size": len(pool),
            "index": int(cfg.proxy_rotation_index),
            "current_upstream": current,
            "next_upstream": next_upstream,
            "last_rotated_at": last_rotated_at,
            "last_error": last_error,
        }

    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="kaveh-rotation", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        with self._lock:
            self._running = False
            self._stop.set()

    def rotate_once(self) -> dict[str, Any]:
        with self._lock:
            self._last_error = ""

        cfg = self._server.config_store.load()
        if cfg.upstream_proxy_chain:
            raise RuntimeError("rotation is not supported when upstream_proxy_chain is non-empty")

        pool = [x.strip() for x in cfg.proxy_rotation_pool if str(x).strip()]
        if not pool:
            if cfg.upstream_proxy_url.strip():
                pool = [cfg.upstream_proxy_url.strip()]
            else:
                raise RuntimeError("rotation pool is empty")

        idx = cfg.proxy_rotation_index % len(pool)
        upstream = pool[idx]
        next_index = cfg.proxy_rotation_index + 1

        cfg_data = cfg.to_dict()
        cfg_data["upstream_proxy_url"] = upstream
        cfg_data["proxy_rotation_index"] = next_index
        new_cfg = AppConfig.from_dict(cfg_data)
        self._server.config_store.save(new_cfg)

        client = self._server.engine_client()
        try:
            client.proxy_stop()
        except Exception:
            pass
        client.proxy_start(
            new_cfg.proxy_listen_addr,
            new_cfg.upstream_proxy_url,
            new_cfg.upstream_proxy_chain,
            new_cfg.fingerprint_user_agent,
            new_cfg.fingerprint_strip_headers,
            new_cfg.fingerprint_accept_language,
            new_cfg.fingerprint_strip_client_hints,
        )

        with self._lock:
            self._last_rotated_at = time.time()

        return {"ok": True, "upstream": upstream, "next_index": next_index}

    def _run(self) -> None:
        while True:
            if self._stop.is_set():
                return

            cfg = self._server.config_store.load()
            if not cfg.proxy_rotation_enabled:
                self._stop.wait(0.5)
                continue

            interval = int(cfg.proxy_rotation_interval_sec)
            if interval < 10:
                interval = 10

            if self._stop.wait(interval):
                return

            try:
                self.rotate_once()
            except Exception as e:
                with self._lock:
                    self._last_error = str(e)


class _Handler(BaseHTTPRequestHandler):
    server: "_KavehPythonAPIServer"

    def do_OPTIONS(self) -> None:
        _write_json(self, HTTPStatus.NO_CONTENT, {})

    def do_GET(self) -> None:
        if self.path == "/health":
            _write_json(self, HTTPStatus.OK, {"ok": True})
            return

        if self.path == "/config":
            cfg = self.server.config_store.load()
            _write_json(self, HTTPStatus.OK, cfg.to_dict())
            return

        if self.path == "/system/processes":
            _write_json(self, HTTPStatus.OK, {"processes": _list_processes()})
            return

        if self.path == "/engine/health":
            try:
                payload = self.server.engine_client().health()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/proxy/status":
            try:
                payload = self.server.engine_client().proxy_status()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/dns/status":
            try:
                payload = self.server.engine_client().dns_status()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/monitor/connections":
            try:
                payload = self.server.engine_client().monitor_connections()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/killswitch/status":
            try:
                payload = self.server.engine_client().killswitch_status()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/isolation/status":
            try:
                payload = self.server.engine_client().isolation_status()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/fingerprint/mac/adapters":
            try:
                payload = self.server.engine_client().fingerprint_mac_adapters()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return
        
        if self.path == "/engine/fingerprint/jsleak/status":
            try:
                payload = self.server.engine_client().fingerprint_jsleak_status()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/proxy/rotation/status":
            _write_json(self, HTTPStatus.OK, self.server.rotation.status())
            return

        _write_json(self, HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_PUT(self) -> None:
        if self.path != "/config":
            _write_json(self, HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        data = _read_json(self)
        cfg = AppConfig.from_dict(data)
        self.server.config_store.save(cfg)
        _write_json(self, HTTPStatus.OK, cfg.to_dict())

    def do_POST(self) -> None:
        if self.path == "/engine/proxy/start":
            cfg = self.server.config_store.load()
            try:
                payload = self.server.engine_client().proxy_start(
                    cfg.proxy_listen_addr,
                    cfg.upstream_proxy_url,
                    cfg.upstream_proxy_chain,
                    cfg.fingerprint_user_agent,
                    cfg.fingerprint_strip_headers,
                    cfg.fingerprint_accept_language,
                    cfg.fingerprint_strip_client_hints,
                )
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/proxy/stop":
            try:
                payload = self.server.engine_client().proxy_stop()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/dns/flush":
            try:
                payload = self.server.engine_client().dns_flush()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/killswitch/enable":
            try:
                payload = self.server.engine_client().killswitch_enable()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/killswitch/disable":
            try:
                payload = self.server.engine_client().killswitch_disable()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/isolation/rules":
            try:
                data = _read_json(self)
                rules = data.get("rules", [])
                payload = self.server.engine_client().isolation_set_rules(rules if isinstance(rules, list) else [])
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/isolation/enable":
            try:
                payload = self.server.engine_client().isolation_enable()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/isolation/disable":
            try:
                payload = self.server.engine_client().isolation_disable()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/fingerprint/mac/spoof":
            try:
                data = _read_json(self)
                adapter_name = str(data.get("adapter_name", ""))
                mode = str(data.get("mode", "random"))
                mac = data.get("mac")
                mac_str = str(mac) if isinstance(mac, str) else None
                payload = self.server.engine_client().fingerprint_mac_spoof(adapter_name, mode, mac_str)
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/engine/fingerprint/mac/reset":
            try:
                data = _read_json(self)
                adapter_name = str(data.get("adapter_name", ""))
                payload = self.server.engine_client().fingerprint_mac_reset(adapter_name)
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return
        
        if self.path == "/engine/fingerprint/jsleak/enable":
            cfg = self.server.config_store.load()
            try:
                payload = self.server.engine_client().fingerprint_jsleak_enable(
                    cfg.jsleak_block_webrtc,
                    cfg.jsleak_block_mdns,
                    cfg.jsleak_block_quic,
                )
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return
        
        if self.path == "/engine/fingerprint/jsleak/disable":
            try:
                payload = self.server.engine_client().fingerprint_jsleak_disable()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_GATEWAY, {"error": str(e)})
            return

        if self.path == "/proxy/rotation/start":
            self.server.rotation.start()
            _write_json(self, HTTPStatus.OK, self.server.rotation.status())
            return

        if self.path == "/proxy/rotation/stop":
            self.server.rotation.stop()
            _write_json(self, HTTPStatus.OK, self.server.rotation.status())
            return

        if self.path == "/proxy/rotation/rotate":
            try:
                payload = self.server.rotation.rotate_once()
                _write_json(self, HTTPStatus.OK, payload)
            except Exception as e:
                _write_json(self, HTTPStatus.BAD_REQUEST, {"error": str(e)})
            return

        _write_json(self, HTTPStatus.NOT_FOUND, {"error": "not found"})

    def log_message(self, format: str, *args: Any) -> None:
        return


class _KavehPythonAPIServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], project_root: Path) -> None:
        super().__init__(server_address, _Handler)
        self.project_root = project_root
        self.config_store = ConfigStore(project_root=project_root)
        self.rotation = RotationManager(self)

    def engine_client(self) -> EngineClient:
        cfg = self.config_store.load()
        return EngineClient(base_url=cfg.engine_base_url)


def serve(project_root: Path) -> None:
    store = ConfigStore(project_root=project_root)
    cfg = store.load()
    addr = (cfg.api_listen_host, cfg.api_listen_port)
    httpd = _KavehPythonAPIServer(addr, project_root=project_root)
    httpd.serve_forever()


if __name__ == "__main__":
    serve(Path(__file__).resolve().parents[2])
