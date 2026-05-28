from __future__ import annotations

from pathlib import Path

from core.api.server import serve


def main() -> None:
    serve(Path.cwd())


if __name__ == "__main__":
    main()
