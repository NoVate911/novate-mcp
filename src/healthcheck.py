#!/usr/bin/env python3
"""Минимальные healthchecks без сторонних зависимостей."""

import json
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def check_tcp(host: str, port: str) -> None:
    with socket.create_connection((host, int(port)), timeout=3):
        pass


def check_http(url: str, expected: str) -> None:
    # urlopen поднимает HTTPError на 4xx/5xx, поэтому ожидаемый не-2xx
    # статус (например, 401) берётся из самого исключения.
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    if status != int(expected):
        raise RuntimeError(f"unexpected HTTP status {status}")


def check_backup(path: str, max_age: str) -> None:
    heartbeat = Path(path)
    data = json.loads(heartbeat.read_text(encoding="utf-8"))
    updated = float(data["updated"])
    age = time.time() - updated
    if age < 0 or age > float(max_age):
        raise RuntimeError(f"backup heartbeat age is {age:.1f}s")


def main() -> None:
    if len(sys.argv) == 4 and sys.argv[1] == "tcp":
        check_tcp(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 4 and sys.argv[1] == "http":
        check_http(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 4 and sys.argv[1] == "backup":
        check_backup(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit("usage: healthcheck.py tcp HOST PORT | http URL STATUS | backup FILE MAX_AGE")


if __name__ == "__main__":
    main()
