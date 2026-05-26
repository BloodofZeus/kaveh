from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class AppConfig:
    engine_base_url: str = "http://127.0.0.1:51337"
    api_listen_host: str = "127.0.0.1"
    api_listen_port: int = 51338
    proxy_listen_addr: str = "127.0.0.1:18080"
    upstream_proxy_url: str = ""
    upstream_proxy_chain: list[str] = field(default_factory=list)
    proxy_rotation_enabled: bool = False
    proxy_rotation_interval_sec: int = 900
    proxy_rotation_pool: list[str] = field(default_factory=list)
    proxy_rotation_index: int = 0
    fingerprint_user_agent: str = ""
    fingerprint_strip_headers: bool = True
    fingerprint_accept_language: str = ""
    fingerprint_strip_client_hints: bool = True
    jsleak_block_webrtc: bool = True
    jsleak_block_mdns: bool = True
    jsleak_block_quic: bool = False
    dns_interface_name: str = ""
    dns_servers: list[str] = field(default_factory=list)
    dns_enforce: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "AppConfig":
        chain_raw = data.get("upstream_proxy_chain", [])
        chain: list[str] = []
        if isinstance(chain_raw, list):
            chain = [str(v) for v in chain_raw if str(v).strip()]
        pool_raw = data.get("proxy_rotation_pool", [])
        pool: list[str] = []
        if isinstance(pool_raw, list):
            pool = [str(v) for v in pool_raw if str(v).strip()]
        dns_raw = data.get("dns_servers", [])
        dns_servers: list[str] = []
        if isinstance(dns_raw, list):
            dns_servers = [str(v) for v in dns_raw if str(v).strip()]
        return AppConfig(
            engine_base_url=str(data.get("engine_base_url", "http://127.0.0.1:51337")),
            api_listen_host=str(data.get("api_listen_host", "127.0.0.1")),
            api_listen_port=int(data.get("api_listen_port", 51338)),
            proxy_listen_addr=str(data.get("proxy_listen_addr", "127.0.0.1:18080")),
            upstream_proxy_url=str(data.get("upstream_proxy_url", "")),
            upstream_proxy_chain=chain,
            proxy_rotation_enabled=bool(data.get("proxy_rotation_enabled", False)),
            proxy_rotation_interval_sec=int(data.get("proxy_rotation_interval_sec", 900)),
            proxy_rotation_pool=pool,
            proxy_rotation_index=int(data.get("proxy_rotation_index", 0)),
            fingerprint_user_agent=str(data.get("fingerprint_user_agent", "")),
            fingerprint_strip_headers=bool(data.get("fingerprint_strip_headers", True)),
            fingerprint_accept_language=str(data.get("fingerprint_accept_language", "")),
            fingerprint_strip_client_hints=bool(data.get("fingerprint_strip_client_hints", True)),
            jsleak_block_webrtc=bool(data.get("jsleak_block_webrtc", True)),
            jsleak_block_mdns=bool(data.get("jsleak_block_mdns", True)),
            jsleak_block_quic=bool(data.get("jsleak_block_quic", False)),
            dns_interface_name=str(data.get("dns_interface_name", "")),
            dns_servers=dns_servers,
            dns_enforce=bool(data.get("dns_enforce", False)),
        )


class ConfigStore:
    def __init__(self, project_root: Path) -> None:
        self._project_root = project_root
        self._path = project_root / "config" / "kaveh.json"

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> AppConfig:
        if not self._path.exists():
            cfg = AppConfig()
            self.save(cfg)
            return cfg

        raw = self._path.read_text(encoding="utf-8")
        data = json.loads(raw) if raw.strip() else {}
        if not isinstance(data, dict):
            data = {}
        return AppConfig.from_dict(data)

    def save(self, cfg: AppConfig) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cfg.to_dict(), indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self._path)
