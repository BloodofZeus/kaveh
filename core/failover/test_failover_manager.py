from __future__ import annotations

import unittest

from core.config.store import AppConfig
from core.failover.manager import FailoverManager


class _InMemoryStore:
    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg

    def load(self) -> AppConfig:
        return self._cfg

    def save(self, cfg: AppConfig) -> None:
        self._cfg = cfg


class _EngineClient:
    def __init__(self) -> None:
        self.started: list[dict] = []
        self.stopped = 0

    def proxy_stop(self) -> None:
        self.stopped += 1

    def proxy_start(
        self,
        proxy_listen_addr: str,
        upstream_proxy_url: str,
        upstream_proxy_chain: list[str],
        fingerprint_user_agent: str,
        fingerprint_strip_headers: bool,
        fingerprint_accept_language: str,
        fingerprint_strip_client_hints: bool,
    ) -> None:
        self.started.append(
            {
                "proxy_listen_addr": proxy_listen_addr,
                "upstream_proxy_url": upstream_proxy_url,
                "upstream_proxy_chain": list(upstream_proxy_chain),
            }
        )


class _Audit:
    def __init__(self) -> None:
        self.entries: list[tuple[str, str]] = []

    def log(self, level: str, event_type: str, message: str, data=None) -> None:
        self.entries.append((level, event_type))


class _Server:
    def __init__(self, cfg: AppConfig) -> None:
        self.config_store = _InMemoryStore(cfg)
        self._client = _EngineClient()
        self.audit = _Audit()

    def engine_client(self) -> _EngineClient:
        return self._client


class FailoverManagerTests(unittest.TestCase):
    def test_trigger_switches_to_next_backup_and_increments_index(self) -> None:
        cfg = AppConfig(
            upstream_proxy_url="http://primary:8080",
            failover_enabled=True,
            failover_backups=["http://b1:8080", "http://b2:8080"],
            failover_index=0,
        )
        srv = _Server(cfg)
        mgr = FailoverManager(srv)

        st1 = mgr.trigger()
        self.assertEqual(st1["index"], 1)
        self.assertEqual(srv.config_store.load().upstream_proxy_url, "http://b1:8080")
        self.assertEqual(len(srv.engine_client().started), 1)

        st2 = mgr.trigger()
        self.assertEqual(st2["index"], 2)
        self.assertEqual(srv.config_store.load().upstream_proxy_url, "http://b2:8080")
        self.assertEqual(len(srv.engine_client().started), 2)

        st3 = mgr.trigger()
        self.assertEqual(st3["index"], 3)
        self.assertEqual(srv.config_store.load().upstream_proxy_url, "http://b1:8080")
        self.assertEqual(len(srv.engine_client().started), 3)

    def test_trigger_sets_error_when_no_backups(self) -> None:
        cfg = AppConfig(
            upstream_proxy_url="http://primary:8080",
            failover_enabled=True,
            failover_backups=[],
            failover_index=0,
        )
        srv = _Server(cfg)
        mgr = FailoverManager(srv)

        st = mgr.trigger()
        self.assertEqual(st["last_error"], "no failover backups configured")
        self.assertEqual(srv.config_store.load().upstream_proxy_url, "http://primary:8080")
        self.assertEqual(len(srv.engine_client().started), 0)

    def test_trigger_works_even_if_rotation_enabled_force_path(self) -> None:
        cfg = AppConfig(
            upstream_proxy_url="http://primary:8080",
            proxy_rotation_enabled=True,
            failover_enabled=True,
            failover_backups=["http://b1:8080"],
            failover_index=0,
        )
        srv = _Server(cfg)
        mgr = FailoverManager(srv)

        st = mgr.trigger()
        self.assertEqual(st["last_error"], "")
        self.assertEqual(srv.config_store.load().upstream_proxy_url, "http://b1:8080")


if __name__ == "__main__":
    unittest.main()
