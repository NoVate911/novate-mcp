"""Общий модуль настроек для MCP-сервера, панели и сервиса бэкапов.

Приоритет значений:
  1. Переопределение из панели (файл overrides.json в /config) — если задано
  2. Переменные окружения из .env — значения по умолчанию (главный источник)
"""

import json
import os
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
OVERRIDES_FILE = CONFIG_DIR / "overrides.json"

# Значения по умолчанию, если ключа нет ни в панели, ни в .env
DEFAULTS = {
    "DOMAIN": "",
    "PROJECTS_DIR": "./projects",
    "MCP_TOKEN": "",
    "SESSION_SECRET": "",
    "TG_CLIENT_ID": "",
    "TG_CLIENT_SECRET": "",
    "ALLOWED_TG_USERS": "",
    "TG_BOT_TOKEN": "",
    "TG_CHAT_ID": "",
    "BACKUP_INTERVAL_HOURS": "24",
    "BACKUP_KEEP": "7",
}


def read_overrides():
    """Словарь переопределений из панели. Ошибки чтения = пустой словарь."""
    try:
        data = json.loads(OVERRIDES_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def get(key):
    """Эффективное значение: переопределение панели, иначе .env, иначе дефолт."""
    ov = read_overrides().get(key)
    if isinstance(ov, str) and ov.strip():
        return ov.strip()
    return os.environ.get(key, DEFAULTS.get(key, ""))


def source(key):
    """Откуда взято текущее значение: 'panel' или 'env'."""
    ov = read_overrides().get(key)
    return "panel" if isinstance(ov, str) and ov.strip() else "env"


def set_override(key, value):
    """Сохранить переопределение (вызывает панель, у неё /config доступен на запись)."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    data = read_overrides()
    data[key] = value.strip()
    OVERRIDES_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def clear_override(key):
    """Сбросить переопределение — вернётся значение из .env."""
    data = read_overrides()
    if key in data:
        del data[key]
        OVERRIDES_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
