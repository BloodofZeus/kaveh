from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class AuditEntry:
    ts: str
    level: str
    type: str
    message: str
    data: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "ts": self.ts,
            "level": self.level,
            "type": self.type,
            "message": self.message,
        }
        if self.data:
            out["data"] = self.data
        return out


class AuditLogger:
    def __init__(self, project_root: Path) -> None:
        data_root_raw = os.environ.get("KAVEH_DATA_DIR", "").strip()
        data_root = Path(data_root_raw) if data_root_raw else project_root
        self._path = data_root / "logs" / "kaveh_audit.jsonl"
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._path

    def log(self, level: str, event_type: str, message: str, data: dict[str, Any] | None = None) -> None:
        entry = AuditEntry(
            ts=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            level=level,
            type=event_type,
            message=message,
            data=data,
        )
        raw = json.dumps(entry.to_dict(), ensure_ascii=False)
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._path.open("a", encoding="utf-8") as f:
                f.write(raw + "\n")

    def tail(self, limit: int) -> list[dict[str, Any]]:
        if limit < 1:
            limit = 1
        if limit > 500:
            limit = 500

        with self._lock:
            if not self._path.exists():
                return []
            try:
                lines = deque(maxlen=limit)
                with self._path.open("r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            lines.append(line)
            except Exception:
                return []

        out: list[dict[str, Any]] = []
        for line in lines:
            try:
                v = json.loads(line)
                if isinstance(v, dict) and "ts" in v and "level" in v and "type" in v and "message" in v:
                    out.append(v)
            except Exception:
                continue
        return out

    def clear(self) -> None:
        with self._lock:
            if self._path.exists():
                self._path.unlink(missing_ok=True)
