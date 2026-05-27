from __future__ import annotations

import socket
import threading
import time
from typing import Any

from core.config.store import AppConfig
from core.profiles.presets import apply_profile


class FailoverManager:
    def __init__(self, server: Any) -> None:
        self._server = server
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False
        self._last_error = ""
        self._last_failover_at: float | None = None
        self._last_ok_at: float | None = None
        self._consecutive_failures = 0

    def status(self) -> dict[str, Any]:
        cfg = self._server.config_store.load()
        with self._lock:
            return {
                "running": self._running,
                "enabled": bool(cfg.failover_enabled),
                "interval_sec": int(cfg.failover_check_interval_sec),
                "probe_host": str(cfg.failover_probe_host),
                "backups": [x.strip() for x in cfg.failover_backups if str(x).strip()],
                "index": int(cfg.failover_index),
                "consecutive_failures": int(self._consecutive_failures),
                "last_ok_at": self._last_ok_at,
                "last_failover_at": self._last_failover_at,
                "last_error": self._last_error,
            }

    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="kaveh-failover", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        with self._lock:
            self._running = False
            self._stop.set()

    def trigger(self) -> dict[str, Any]:
        self._failover_once(force=True)
        return self.status()

    def _run(self) -> None:
        while True:
            if self._stop.is_set():
                return

            cfg = self._server.config_store.load()
            if not cfg.failover_enabled:
                self._stop.wait(0.8)
                continue

            interval = int(cfg.failover_check_interval_sec)
            if interval < 5:
                interval = 5

            ok, err = self._probe(cfg)
            if ok:
                with self._lock:
                    self._consecutive_failures = 0
                    self._last_ok_at = time.time()
                    self._last_error = ""
            else:
                with self._lock:
                    self._consecutive_failures += 1
                    self._last_error = str(err or "probe failed")
                if self._consecutive_failures >= 2:
                    self._failover_once(force=False)

            if self._stop.wait(interval):
                return

    def _probe(self, cfg: AppConfig) -> tuple[bool, str | None]:
        if cfg.proxy_rotation_enabled:
            return True, None
        if cfg.upstream_proxy_chain:
            return True, None
        if not cfg.proxy_listen_addr.strip():
            return False, "proxy_listen_addr is empty"

        host, port = _split_host_port(cfg.proxy_listen_addr, 18080)
        target = (cfg.failover_probe_host or "example.com:443").strip()
        if ":" not in target:
            target = target + ":443"

        try:
            with socket.create_connection((host, port), timeout=3) as s:
                s.settimeout(3)
                req = f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode("ascii", errors="ignore")
                s.sendall(req)
                data = s.recv(128).decode("ascii", errors="ignore")
                if "200" in data and "Connection Established" in data:
                    return True, None
                if data.startswith("HTTP/") and "200" in data:
                    return True, None
                return False, data.strip() or "non-200"
        except Exception as e:
            return False, str(e)

    def _failover_once(self, force: bool) -> None:
        with self._lock:
            self._last_error = ""

        cfg = self._server.config_store.load()
        if cfg.proxy_rotation_enabled and not force:
            with self._lock:
                self._last_error = "blocked: rotation enabled"
            return
        if cfg.upstream_proxy_chain and not force:
            with self._lock:
                self._last_error = "blocked: upstream chain enabled"
            return

        backups = [x.strip() for x in cfg.failover_backups if str(x).strip()]
        if not backups:
            with self._lock:
                self._last_error = "no failover backups configured"
            return

        idx = int(cfg.failover_index) % len(backups)
        next_upstream = backups[idx]
        next_index = int(cfg.failover_index) + 1

        cfg_data = cfg.to_dict()
        cfg_data["upstream_proxy_url"] = next_upstream
        cfg_data["failover_index"] = next_index
        new_cfg = apply_profile(AppConfig.from_dict(cfg_data))
        self._server.config_store.save(new_cfg)

        client = self._server.engine_client()
        try:
            client.proxy_stop()
        except Exception:
            pass
        try:
            client.proxy_start(
                new_cfg.proxy_listen_addr,
                new_cfg.upstream_proxy_url,
                new_cfg.upstream_proxy_chain,
                new_cfg.fingerprint_user_agent,
                new_cfg.fingerprint_strip_headers,
                new_cfg.fingerprint_accept_language,
                new_cfg.fingerprint_strip_client_hints,
            )
        except Exception as e:
            with self._lock:
                self._last_error = str(e)
            return

        with self._lock:
            self._consecutive_failures = 0
            self._last_failover_at = time.time()
            self._last_error = ""

        try:
            self._server.audit.log("warn", "failover.switch", "Proxy failover executed", {"upstream": next_upstream})
        except Exception:
            pass


def _split_host_port(addr: str, default_port: int) -> tuple[str, int]:
    addr = addr.strip()
    if not addr:
        return "127.0.0.1", default_port
    if ":" not in addr:
        return addr, default_port
    host, port_s = addr.rsplit(":", 1)
    try:
        port = int(port_s)
    except Exception:
        port = default_port
    return host, port
