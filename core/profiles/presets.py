from __future__ import annotations

from core.config.store import AppConfig


def apply_profile(cfg: AppConfig) -> AppConfig:
    p = (cfg.ui_profile or "custom").strip().lower()
    if p not in {"light", "moderate", "high", "custom"}:
        p = "custom"

    if p == "light":
        data = cfg.to_dict()
        data["ui_profile"] = "light"
        data["proxy_rotation_enabled"] = False
        data["jsleak_block_webrtc"] = False
        data["jsleak_block_mdns"] = False
        data["jsleak_block_quic"] = False
        data["fingerprint_strip_headers"] = True
        data["fingerprint_strip_client_hints"] = False
        data["dns_enforce"] = False
        return AppConfig.from_dict(data)

    if p == "moderate":
        data = cfg.to_dict()
        data["ui_profile"] = "moderate"
        data["proxy_rotation_enabled"] = False
        data["jsleak_block_webrtc"] = True
        data["jsleak_block_mdns"] = True
        data["jsleak_block_quic"] = False
        data["fingerprint_strip_headers"] = True
        data["fingerprint_strip_client_hints"] = True
        data["dns_enforce"] = False
        return AppConfig.from_dict(data)

    if p == "high":
        data = cfg.to_dict()
        data["ui_profile"] = "high"
        data["proxy_rotation_enabled"] = True
        data["proxy_rotation_interval_sec"] = max(600, int(cfg.proxy_rotation_interval_sec or 600))
        data["jsleak_block_webrtc"] = True
        data["jsleak_block_mdns"] = True
        data["jsleak_block_quic"] = True
        data["fingerprint_strip_headers"] = True
        data["fingerprint_strip_client_hints"] = True
        if not cfg.dns_servers:
            data["dns_servers"] = ["9.9.9.9", "149.112.112.112"]
        return AppConfig.from_dict(data)

    data = cfg.to_dict()
    data["ui_profile"] = "custom"
    return AppConfig.from_dict(data)

