"""Фоновый сервис бэкапов NoVate MCP.

Что делает:
  - раз в BACKUP_INTERVAL_HOURS часов (и по кнопке «Сделать бэкап сейчас»
    в панели) собирает tar.gz-архив проектов и настроек панели;
  - хранит BACKUP_KEEP последних архивов локально в /backups;
  - отправляет архив в Telegram: бот TG_BOT_TOKEN -> чат TG_CHAT_ID;
  - пишет статус последнего бэкапа в /backups/last-backup.json
    (его показывает панель на странице «Бэкапы»).

Настройки перечитываются каждый цикл, поэтому переопределения из панели
применяются без перезапуска контейнера (в течение минуты).
"""

import json
import os
import tarfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import settings

DATA_DIR = Path(os.environ.get("MCP_DATA_DIR", "/data"))
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", "/backups"))

# Панель создаёт этот файл кнопкой «Сделать бэкап сейчас»
TRIGGER_FILE = CONFIG_DIR / "backup-now"
# Статус последнего бэкапа для страницы «Бэкапы» в панели
STATE_FILE = BACKUP_DIR / "last-backup.json"

# Лимит sendDocument у Telegram-ботов — 50 МБ, берём с запасом
MAX_TG_BYTES = 45 * 1024 * 1024
# Пауза между проверками «пора ли делать бэкап»
CHECK_EVERY = 60


def log(msg: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[backup {stamp}] {msg}", flush=True)


def interval_seconds() -> float:
    """Период между бэкапами в секундах (минимум ~5 минут)."""
    try:
        hours = float(settings.get("BACKUP_INTERVAL_HOURS") or "24")
    except ValueError:
        hours = 24.0
    return max(hours, 0.08) * 3600


def keep_count() -> int:
    """Сколько локальных копий хранить."""
    try:
        return max(int(settings.get("BACKUP_KEEP") or "7"), 1)
    except ValueError:
        return 7


def count_project_files() -> int:
    """Число файлов в проектах (для подписи к бэкапу)."""
    total = 0
    for p in DATA_DIR.rglob("*"):
        if p.is_file():
            total += 1
    return total


def make_archive() -> Path:
    """tar.gz: проекты (/data) + настройки панели (overrides.json)."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = BACKUP_DIR / f"novate-backup-{stamp}.tar.gz"
    with tarfile.open(out, "w:gz") as tar:
        if DATA_DIR.is_dir():
            tar.add(DATA_DIR, arcname="projects")
        overrides = CONFIG_DIR / "overrides.json"
        if overrides.is_file():
            tar.add(overrides, arcname="dashboard-data/overrides.json")
    return out


def prune() -> None:
    """Удаляет старые архивы, оставляя BACKUP_KEEP самых свежих."""
    archives = sorted(
        BACKUP_DIR.glob("novate-backup-*.tar.gz"),
        key=lambda p: p.stat().st_mtime,
    )
    for old in archives[:-keep_count()]:
        try:
            old.unlink()
            log(f"удалён старый архив {old.name}")
        except OSError:
            pass


def tg_api(token: str, method: str, fields: dict,
           file_field: str = "", file_path: Path | None = None) -> dict:
    """Вызов Telegram Bot API (JSON либо multipart для отправки файла)."""
    url = f"https://api.telegram.org/bot{token}/{method}"
    if file_field and file_path is not None:
        boundary = f"novate{int(time.time() * 1000)}"
        body = bytearray()
        for key, value in fields.items():
            body += (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{key}"\r\n\r\n'
                f"{value}\r\n"
            ).encode()
        body += (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{file_field}"; '
            f'filename="{file_path.name}"\r\n'
            f"Content-Type: application/gzip\r\n\r\n"
        ).encode()
        body += file_path.read_bytes()
        body += f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(
            url, data=bytes(body),
            headers={"Content-Type":
                     f"multipart/form-data; boundary={boundary}"},
        )
    else:
        req = urllib.request.Request(
            url, data=json.dumps(fields).encode(),
            headers={"Content-Type": "application/json"},
        )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read())


def send_to_telegram(archive: Path, caption: str) -> str:
    """Возвращает 'ok', 'skipped' (Telegram не настроен) или 'error: ...'."""
    token = settings.get("TG_BOT_TOKEN")
    chat_id = settings.get("TG_CHAT_ID")
    if not token or not chat_id:
        return "skipped"
    try:
        size = archive.stat().st_size
        if size <= MAX_TG_BYTES:
            tg_api(token, "sendDocument",
                   {"chat_id": chat_id, "caption": caption},
                   "document", archive)
        else:
            tg_api(token, "sendMessage", {
                "chat_id": chat_id,
                "text": caption + (
                    f"\n\n⚠️ Архив {size / 1048576:.1f} МБ — это больше лимита "
                    "Telegram для ботов (50 МБ). Архив сохранён на сервере: "
                    "заберите его в панели (раздел «Бэкапы») или из папки backups."
                ),
            })
        return "ok"
    except Exception as e:  # сеть/токен/чат — не роняем сервис
        return f"error: {e}"


def write_status(status: dict) -> None:
    """Статус последнего бэкапа для страницы «Бэкапы» в панели."""
    try:
        STATE_FILE.write_text(
            json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8",
        )
    except OSError:
        pass


def run_backup(reason: str) -> None:
    log(f"старт бэкапа ({reason})")
    try:
        archive = make_archive()
        size = archive.stat().st_size
        files = count_project_files()
        prune()
        caption = (
            "🗄 Бэкап NoVate MCP\n"
            f"📦 {archive.name}\n"
            f"📁 Файлов в проектах: {files}\n"
            f"💾 Размер: {size / 1048576:.2f} МБ"
        )
        tg = send_to_telegram(archive, caption)
        log(f"готово: {archive.name} ({size} байт), telegram={tg}")
        write_status({
            "time": datetime.now(timezone.utc).isoformat(),
            "file": archive.name, "size": size, "files": files,
            "telegram": tg, "reason": reason,
        })
    except Exception as e:
        log(f"ОШИБКА: {e}")
        write_status({
            "time": datetime.now(timezone.utc).isoformat(),
            "error": str(e), "reason": reason,
        })


def last_run_time() -> float:
    """Время последнего бэкапа из state-файла (0 — бэкапов ещё не было)."""
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return datetime.fromisoformat(data["time"]).timestamp()
    except Exception:
        return 0.0


def trigger_mtime() -> float:
    """mtime файла-триггера от панели (0 — триггера нет)."""
    try:
        return TRIGGER_FILE.stat().st_mtime
    except OSError:
        return 0.0


def main() -> None:
    log("сервис бэкапов запущен")
    # Перезапуск контейнера не должен порождать лишний бэкап —
    # время последнего запуска восстанавливаем из state-файла.
    last_run = last_run_time()
    # Старый trigger-файл (созданный до рестарта) — не новая команда.
    last_trigger = trigger_mtime()
    while True:
        try:
            trig = trigger_mtime()
            if trig > last_trigger:
                last_trigger = trig
                run_backup("вручную из панели")
                last_run = time.time()
            elif time.time() - last_run >= interval_seconds():
                run_backup("по расписанию")
                last_run = time.time()
        except Exception as e:
            log(f"ОШИБКА цикла: {e}")
        time.sleep(CHECK_EVERY)


if __name__ == "__main__":
    main()
