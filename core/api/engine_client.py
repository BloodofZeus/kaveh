from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class EngineClient:
    base_url: str

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        url = self.base_url.rstrip("/") + path
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url=url, method=method, data=data, headers=headers)
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(req, timeout=5) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as e:
            try:
                raw = e.read().decode("utf-8")
                payload = json.loads(raw) if raw.strip() else {}
                if isinstance(payload, dict) and "error" in payload:
                    raise RuntimeError(str(payload["error"])) from e
            except Exception:
                pass
            raise RuntimeError(f"engine http error: {e.code}") from e
        except urllib.error.URLError as e:
            raise RuntimeError("engine unreachable") from e

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health")

    def proxy_status(self) -> dict[str, Any]:
        return self._request("GET", "/proxy/status")

    def proxy_start(
        self,
        listen_addr: str,
        upstream: str,
        upstream_chain: list[str],
        user_agent: str,
        strip_headers: bool,
        accept_language: str,
        strip_client_hints: bool,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/proxy/start",
            {
                "listen_addr": listen_addr,
                "upstream": upstream,
                "upstream_chain": upstream_chain,
                "user_agent": user_agent,
                "strip_headers": strip_headers,
                "accept_language": accept_language,
                "strip_client_hints": strip_client_hints,
            },
        )

    def proxy_stop(self) -> dict[str, Any]:
        return self._request("POST", "/proxy/stop")

    def dns_status(self) -> dict[str, Any]:
        return self._request("GET", "/dns/status")

    def dns_interfaces(self) -> dict[str, Any]:
        return self._request("GET", "/dns/interfaces")

    def dns_flush(self) -> dict[str, Any]:
        return self._request("POST", "/dns/flush")

    def dns_set(self, interface_name: str, servers: list[str]) -> dict[str, Any]:
        return self._request("POST", "/dns/set", {"confirm": True, "interface_name": interface_name, "servers": servers})

    def dns_enforce_status(self) -> dict[str, Any]:
        return self._request("GET", "/dns/enforce/status")

    def dns_enforce(self, servers: list[str]) -> dict[str, Any]:
        return self._request("POST", "/dns/enforce", {"confirm": True, "servers": servers})

    def dns_unenforce(self) -> dict[str, Any]:
        return self._request("POST", "/dns/unenforce", {"confirm": True})

    def monitor_connections(self) -> dict[str, Any]:
        return self._request("GET", "/monitor/connections")

    def monitor_blocks(self) -> dict[str, Any]:
        return self._request("GET", "/monitor/blocks")

    def monitor_block(self, remote_ip: str) -> dict[str, Any]:
        return self._request("POST", "/monitor/block", {"confirm": True, "remote_ip": remote_ip})

    def monitor_unblock(self, remote_ip: str) -> dict[str, Any]:
        return self._request("POST", "/monitor/unblock", {"confirm": True, "remote_ip": remote_ip})

    def monitor_clear_blocks(self) -> dict[str, Any]:
        return self._request("POST", "/monitor/clear_blocks", {"confirm": True})

    def killswitch_status(self) -> dict[str, Any]:
        return self._request("GET", "/killswitch/status")

    def killswitch_enable(self) -> dict[str, Any]:
        return self._request("POST", "/killswitch/enable", {"confirm": True})

    def killswitch_disable(self) -> dict[str, Any]:
        return self._request("POST", "/killswitch/disable")

    def isolation_status(self) -> dict[str, Any]:
        return self._request("GET", "/isolation/status")

    def isolation_set_rules(self, rules: list[dict[str, Any]]) -> dict[str, Any]:
        return self._request("PUT", "/isolation/rules", {"rules": rules})

    def isolation_enable(self) -> dict[str, Any]:
        return self._request("POST", "/isolation/enable")

    def isolation_disable(self) -> dict[str, Any]:
        return self._request("POST", "/isolation/disable")

    def fingerprint_mac_adapters(self) -> dict[str, Any]:
        return self._request("GET", "/fingerprint/mac/adapters")

    def fingerprint_mac_spoof(self, adapter_name: str, mode: str, mac: str | None) -> dict[str, Any]:
        payload: dict[str, Any] = {"confirm": True, "adapter_name": adapter_name, "mode": mode}
        if mac is not None:
            payload["mac"] = mac
        return self._request("POST", "/fingerprint/mac/spoof", payload)

    def fingerprint_mac_reset(self, adapter_name: str) -> dict[str, Any]:
        return self._request("POST", "/fingerprint/mac/reset", {"confirm": True, "adapter_name": adapter_name})

    def fingerprint_jsleak_status(self) -> dict[str, Any]:
        return self._request("GET", "/fingerprint/jsleak/status")

    def fingerprint_jsleak_enable(self, block_webrtc: bool, block_mdns: bool, block_quic: bool) -> dict[str, Any]:
        return self._request(
            "POST",
            "/fingerprint/jsleak/enable",
            {"confirm": True, "block_webrtc": block_webrtc, "block_mdns": block_mdns, "block_quic": block_quic},
        )

    def fingerprint_jsleak_disable(self) -> dict[str, Any]:
        return self._request("POST", "/fingerprint/jsleak/disable")
