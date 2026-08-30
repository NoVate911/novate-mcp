"""Фоновый сервис бэкапов NoVate MCP.

Что делает:
  - раз в BACKUP_INTERVAL_HOURS часов (и по кнопке «Сделать бэкап сейчас»
    в панели) собирает tar.gz-архив проектов и настроек панели;
  - если задан BACKUP_PASSWORD — шифрует архив (AES-256 через openssl):
    в хранилище и в Telegram уходит файл .enc;
  - хранит BACKUP_KEEP последних архивов локально в /backups;
  - отправляет архив в Telegram: бот TG_BOT_TOKEN -> чат TG_CHAT_ID;
  - по запросу из панели восстанавливает проекты из выбранного архива
    (перед восстановлением автоматически делает страховочный бэкап);
  - при ошибках бэкапа/восстановления шлёт уведомление в Telegram;
  - пишет статус последнего бэкапа в /backups/last-backup.json
    (его показывает панель на странице «Бэкапы»).

Настройки перечитываются каждый цикл, поэтому переопределения из панели
применяются без перезапуска контейнера (в течение минуты).
"""

import html
import json
import os
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import settings

DATA_DIR = Path(os.environ.get("MCP_DATA_DIR", "/data"))
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", "/backups"))

# Панель создаёт этот файл кнопкой «Сделать бэкап сейчас»,
# а MCP-инструмент make_backup — файл .backup-now в папке проектов
TRIGGER_FILE = CONFIG_DIR / "backup-now"
MCP_TRIGGER_FILE = DATA_DIR / ".backup-now"
# Панель пишет сюда ИМЯ архива кнопкой «Восстановить»
RESTORE_FILE = CONFIG_DIR / "restore-now"
# После восстановления MCP синхронизирует изменившуюся локальную копию с S3.
S3_SYNC_TRIGGER = DATA_DIR / ".s3-sync-needed"
# Статус последнего бэкапа для страницы «Бэкапы» в панели
STATE_FILE = BACKUP_DIR / "last-backup.json"
# Heartbeat читается Docker healthcheck; файл не содержит секретов.
HEARTBEAT_FILE = BACKUP_DIR / ".backup-heartbeat.json"

# Лимит sendDocument у Telegram-ботов — 50 МБ, берём с запасом
MAX_TG_BYTES = 45 * 1024 * 1024
# Пауза между проверками «пора ли делать бэкап»
CHECK_EVERY = 60

# Допустимое имя архива: плоское, без путей и подкаталогов
ARCHIVE_RE = re.compile(r"^[\w.-]+\.tar\.gz(\.enc)?$")

# Генерируемые и служебные данные не нужны в резервных копиях проектов.
# Символические и жёсткие ссылки также пропускаются: restore drill намеренно
# запрещает их, чтобы архив нельзя было использовать для выхода за /data.
BACKUP_EXCLUDED_NAMES = {"node_modules", ".git", ".cache", "tmp", "__pycache__"}
BACKUP_EXCLUDED_SUFFIXES = (".pyc", ".log")


def backup_tar_filter(member: tarfile.TarInfo) -> tarfile.TarInfo | None:
    """Исключить генерируемые данные и ссылки из создаваемого tar.gz."""
    normalized = member.name.replace("\\", "/").strip("/")
    parts = tuple(part for part in normalized.split("/") if part)
    if member.issym() or member.islnk():
        return None
    if any(part in BACKUP_EXCLUDED_NAMES for part in parts):
        return None
    if parts and parts[-1].endswith(BACKUP_EXCLUDED_SUFFIXES):
        return None
    return member


def project_path_is_excluded(path: Path) -> bool:
    """Те же исключения для счётчика файлов, что и для tar-архива."""
    try:
        parts = path.relative_to(DATA_DIR).parts
    except ValueError:
        return True
    return (
        path.is_symlink()
        or any(part in BACKUP_EXCLUDED_NAMES for part in parts)
        or (bool(parts) and parts[-1].endswith(BACKUP_EXCLUDED_SUFFIXES))
    )


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
    """Число сохраняемых файлов в проектах (для подписи к бэкапу)."""
    total = 0
    for p in DATA_DIR.rglob("*"):
        if not project_path_is_excluded(p) and p.is_file():
            total += 1
    return total


def make_archive(tag: str = "") -> Path:
    """tar.gz: проекты (/data) + настройки панели (overrides.json).

    tag — метка в имени (например, страховочный снапшот "-pre-restore"),
    чтобы снапшот не перезаписал сам исходный архив при совпадении секунды.
    """
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    while True:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        out = BACKUP_DIR / f"novate-backup-{stamp}{tag}.tar.gz"
        # Имя должно быть свободно и в открытом, и в зашифрованном виде
        if not out.exists() and not Path(str(out) + ".enc").exists():
            break
        time.sleep(1.1)
    with tarfile.open(out, "w:gz") as tar:
        if DATA_DIR.is_dir():
            tar.add(DATA_DIR, arcname="projects", filter=backup_tar_filter)
        overrides = CONFIG_DIR / "overrides.json"
        if overrides.is_file():
            tar.add(overrides, arcname="dashboard-data/overrides.json")
    return out


def encrypt_archive(archive: Path, password: str) -> Path:
    """AES-256-CBC через openssl CLI; незашифрованный оригинал удаляется."""
    out = archive.with_name(archive.name + ".enc")
    subprocess.run(
        ["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-salt",
         "-pass", "pass:" + password, "-in", str(archive), "-out", str(out)],
        check=True, capture_output=True,
    )
    archive.unlink()
    return out


def decrypt_archive(src: Path, password: str, out: Path) -> None:
    """Расшифровка .enc обратно в tar.gz (openssl CLI)."""
    subprocess.run(
        ["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2",
         "-pass", "pass:" + password, "-in", str(src), "-out", str(out)],
        check=True, capture_output=True,
    )


def maybe_encrypt(archive: Path):
    """Если задан BACKUP_PASSWORD — шифруем. Возвращает (путь, зашифрован_ли)."""
    password = settings.get("BACKUP_PASSWORD")
    if not password:
        return archive, False
    try:
        return encrypt_archive(archive, password), True
    except Exception as e:
        # openssl недоступен или упал — бэкап не теряем, шлём открытым
        log(f"ВНИМАНИЕ: шифрование не удалось ({e}), архив оставлен открытым")
        return archive, False


def prune() -> None:
    """Удаляет старые архивы, оставляя BACKUP_KEEP самых свежих."""
    archives = sorted(
        (p for p in BACKUP_DIR.glob("novate-backup-*") if p.is_file()),
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
            f"Content-Type: application/octet-stream\r\n\r\n"
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


def tg_text(text: str) -> None:
    """Текстовое уведомление в Telegram (алерты). Ошибки — только в лог."""
    token = settings.get("TG_BOT_TOKEN")
    chat_id = settings.get("TG_CHAT_ID")
    if not token or not chat_id:
        return
    try:
        tg_api(token, "sendMessage", {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        })
    except Exception as e:
        log(f"не удалось отправить уведомление: {e}")


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
                   {"chat_id": chat_id, "caption": caption, "parse_mode": "HTML"},
                   "document", archive)
        else:
            tg_api(token, "sendMessage", {
                "chat_id": chat_id,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
                "text": caption + (
                    f"\n\n⚠️ <b>Файл не прикреплён</b>\n"
                    f"Размер архива — {size / 1048576:.1f} МБ, что превышает лимит "
                    "Telegram Bot API (50 МБ).\n"
                    "Архив сохранён на сервере и доступен в разделе «Бэкапы»."
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


def restore_drill_enabled() -> bool:
    return (settings.get("BACKUP_RESTORE_DRILL") or "true").strip().lower() in {"1", "true", "yes", "on"}


def verify_restore_archive(archive: Path, expected_files: int | None = None) -> dict:
    """Расшифровать и распаковать архив во временную папку, не меняя /data."""
    started = time.time()
    result = {"time": datetime.now(timezone.utc).isoformat(), "file": archive.name}
    try:
        with tempfile.TemporaryDirectory(prefix="novate-restore-drill-") as temp_name:
            temp = Path(temp_name)
            work = archive
            if archive.name.endswith(".enc"):
                password = settings.get("BACKUP_PASSWORD")
                if not password:
                    raise RuntimeError("BACKUP_PASSWORD не задан для проверки зашифрованного архива")
                work = temp / "backup.tar.gz"
                decrypt_archive(archive, password, work)
            extracted = 0
            extracted_bytes = 0
            destination = temp / "restored"
            destination.mkdir()
            with tarfile.open(work, "r:gz") as tar:
                for member in tar.getmembers():
                    normalized = member.name.replace("\\", "/").strip("/")
                    parts = [part for part in normalized.split("/") if part]
                    if not parts or parts[0] != "projects":
                        continue
                    if any(part in {".", ".."} for part in parts) or member.issym() or member.islnk():
                        raise RuntimeError(f"небезопасный объект в архиве: {member.name}")
                    relative = Path(*parts[1:])
                    target = destination / relative
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                    elif member.isfile():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        source = tar.extractfile(member)
                        if source is None:
                            raise RuntimeError(f"не удалось прочитать {member.name}")
                        with target.open("wb") as output:
                            while chunk := source.read(1024 * 1024):
                                output.write(chunk)
                                extracted_bytes += len(chunk)
                        extracted += 1
            if expected_files is not None and extracted != expected_files:
                raise RuntimeError(f"ожидалось файлов: {expected_files}, распаковано: {extracted}")
            result.update(state="ok", files=extracted, bytes=extracted_bytes,
                          duration_seconds=round(time.time() - started, 3))
    except Exception as exc:
        result.update(state="error", error=str(exc), duration_seconds=round(time.time() - started, 3))
    (BACKUP_DIR / ".restore-drill.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def run_backup(reason: str) -> None:
    log(f"старт бэкапа ({reason})")
    try:
        archive = make_archive()
        files = count_project_files()
        archive, encrypted = maybe_encrypt(archive)
        size = archive.stat().st_size
        if restore_drill_enabled():
            verification = verify_restore_archive(archive, files)
        else:
            verification = {"state": "skipped", "file": archive.name,
                            "time": datetime.now(timezone.utc).isoformat()}
            (BACKUP_DIR / ".restore-drill.json").write_text(json.dumps(verification, ensure_ascii=False, indent=2), encoding="utf-8")
        prune()
        caption = (
            "🗄 <b>Резервная копия создана</b>\n\n"
            f"<b>Файл:</b> <code>{html.escape(archive.name)}</code>\n"
            f"<b>Размер:</b> {size / 1048576:.2f} МБ\n"
            f"<b>Файлов:</b> {files}\n"
            f"<b>Запуск:</b> {html.escape(reason)}\n"
            f"<b>Защита:</b> {'AES-256 🔐' if encrypted else 'без шифрования'}\n"
            f"<b>Restore drill:</b> {'успешно ✅' if verification.get('state') == 'ok' else 'ошибка ❌' if verification.get('state') == 'error' else 'отключён'}"
        )
        if encrypted:
            caption += (
                "\n\n<i>Для расшифровки используйте BACKUP_PASSWORD и команду:</i>\n"
                "<code>openssl enc -d -aes-256-cbc -pbkdf2 -in &lt;файл&gt; "
                "-out backup.tar.gz</code>"
            )
        if verification.get("state") == "error":
            tg_text(
                "🚨 <b>Проверка восстановления не пройдена</b>\n\n"
                f"<b>Архив:</b> <code>{html.escape(archive.name)}</code>\n"
                f"<b>Причина:</b> {html.escape(str(verification.get('error', 'unknown')))}"
            )
        tg = send_to_telegram(archive, caption)
        log(f"готово: {archive.name} ({size} байт), telegram={tg}, encrypted={encrypted}")
        write_status({
            "time": datetime.now(timezone.utc).isoformat(),
            "file": archive.name, "size": size, "files": files,
            "telegram": tg, "reason": reason, "encrypted": encrypted,
            "verification": verification,
        })
    except Exception as e:
        log(f"ОШИБКА: {e}")
        tg_text(
            "⚠️ <b>Ошибка резервного копирования</b>\n\n"
            f"<b>Запуск:</b> {html.escape(reason)}\n"
            f"<b>Причина:</b> {html.escape(str(e))}"
        )
        write_status({
            "time": datetime.now(timezone.utc).isoformat(),
            "error": str(e), "reason": reason,
        })


def do_restore(name: str) -> None:
    """Восстановить проекты из архива (кнопка «Восстановить» в панели).

    Перед перезаписью проектов автоматически делается страховочный бэкап.
    Настройки панели (dashboard-data) из архива НЕ восстанавливаются.
    """
    if not ARCHIVE_RE.match(name):
        raise ValueError(f"недопустимое имя архива: {name!r}")
    src = BACKUP_DIR / name
    if not src.is_file():
        raise FileNotFoundError(name)
    log(f"восстановление из {name}")
    snapshot, _ = maybe_encrypt(make_archive(tag="-pre-restore"))
    log(f"страховочный бэкап перед восстановлением: {snapshot.name}")
    prune()

    work = src
    tmp = None
    if src.name.endswith(".enc"):
        password = settings.get("BACKUP_PASSWORD")
        if not password:
            raise RuntimeError("архив зашифрован, а BACKUP_PASSWORD не задан")
        tmp = BACKUP_DIR / (src.name + ".dec.tmp")
        decrypt_archive(src, password, tmp)
        work = tmp
    try:
        restored = 0
        with tarfile.open(work, "r:gz") as tar:
            for member in tar.getmembers():
                # Восстанавливаем только содержимое projects/
                if not member.name.startswith("projects/"):
                    continue
                rel = member.name[len("projects/"):]
                if not rel:
                    continue
                member.name = rel
                tar.extract(member, DATA_DIR, filter="data")
                restored += 1
        log(f"восстановлено объектов: {restored}")
        if os.environ.get("S3_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}:
            S3_SYNC_TRIGGER.write_text(str(time.time_ns()), encoding="utf-8")
        tg_text(
            "✅ <b>Восстановление завершено</b>\n\n"
            f"<b>Архив:</b> <code>{html.escape(name)}</code>\n"
            f"<b>Восстановлено объектов:</b> {restored}\n"
            f"<b>Страховочная копия:</b> <code>{html.escape(snapshot.name)}</code>"
        )
        write_status({
            "time": datetime.now(timezone.utc).isoformat(),
            "restore": f"ok: {name} (объектов: {restored})",
            "file": snapshot.name, "size": snapshot.stat().st_size,
            "reason": "страховочный перед восстановлением",
        })
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def last_run_time() -> float:
    """Время последнего бэкапа из state-файла (0 — бэкапов ещё не было)."""
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return datetime.fromisoformat(data["time"]).timestamp()
    except Exception:
        return 0.0


def last_success_time() -> float:
    """Время последней успешной копии; ошибки не считаются успехом."""
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if data.get("error") or not data.get("file"):
            return 0.0
        return datetime.fromisoformat(data["time"]).timestamp()
    except Exception:
        return 0.0


def stale_after_seconds() -> float:
    """Через сколько без успешной копии отправлять предупреждение."""
    raw = os.environ.get("BACKUP_STALE_AFTER_HOURS", "").strip()
    if raw:
        try:
            return max(float(raw), 0.08) * 3600
        except ValueError:
            log(f"некорректный BACKUP_STALE_AFTER_HOURS={raw!r}; используется авто-порог")
    interval = interval_seconds()
    return max(interval * 2, interval + 3600)


def write_heartbeat(state: str = "ok") -> None:
    """Атомарно обновить heartbeat для Docker healthcheck."""
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        tmp = HEARTBEAT_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({
            "updated": time.time(),
            "state": state,
        }, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, HEARTBEAT_FILE)
    except OSError as exc:
        log(f"не удалось обновить heartbeat: {exc}")


def check_stale_backup(now: float, last_success: float, started_at: float,
                       alerted: bool) -> bool:
    """Один раз предупредить в Telegram, пока успешные копии просрочены."""
    reference = last_success or started_at
    age = max(0.0, now - reference)
    threshold = stale_after_seconds()
    if age <= threshold:
        return False
    if not alerted:
        tg_text(
            "⏰ <b>Резервная копия просрочена</b>\n\n"
            f"<b>Без успешной копии:</b> {age / 3600:.1f} ч\n"
            f"<b>Порог предупреждения:</b> {threshold / 3600:.1f} ч\n"
            "Проверьте <code>docker compose logs backup</code>, свободное место "
            "и настройки BACKUP_PASSWORD."
        )
        log(f"отправлено предупреждение о просроченном бэкапе ({age / 3600:.1f} ч)")
    return True


def trigger_mtime() -> float:
    """mtime самого свежего файла-триггера бэкапа — от панели или от
    MCP-инструмента make_backup (0 — триггеров нет)."""
    mtimes = []
    for f in (TRIGGER_FILE, MCP_TRIGGER_FILE):
        try:
            mtimes.append(f.stat().st_mtime)
        except OSError:
            pass
    return max(mtimes, default=0.0)


def restore_request():
    """Запрос на восстановление от панели: (имя архива, mtime) или None."""
    try:
        st = RESTORE_FILE.stat()
    except OSError:
        return None
    try:
        name = RESTORE_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        name = ""
    return (name, st.st_mtime)


def main() -> None:
    log("сервис бэкапов запущен")
    started_at = time.time()
    # Перезапуск контейнера не должен порождать лишний бэкап —
    # время последнего запуска восстанавливаем из state-файла.
    last_run = last_run_time()
    last_success = last_success_time()
    stale_alerted = False
    # Старые файлы-триггеры (созданные до рестарта) — не новые команды.
    last_trigger = trigger_mtime()
    last_restore = restore_request()
    write_heartbeat("starting")
    while True:
        loop_state = "ok"
        try:
            req = restore_request()
            if req is not None and req != last_restore:
                last_restore = req
                if req[0]:
                    try:
                        do_restore(req[0])
                    except Exception as e:
                        log(f"ОШИБКА восстановления: {e}")
                        tg_text(
                            "⚠️ <b>Ошибка восстановления</b>\n\n"
                            f"<b>Архив:</b> <code>{html.escape(req[0])}</code>\n"
                            f"<b>Причина:</b> {html.escape(str(e))}"
                        )
                        write_status({
                            "time": datetime.now(timezone.utc).isoformat(),
                            "restore": f"error: {e}",
                        })
                    last_run = time.time()
            trig = trigger_mtime()
            if trig > last_trigger:
                last_trigger = trig
                run_backup("вручную из панели")
                last_run = time.time()
            elif time.time() - last_run >= interval_seconds():
                run_backup("по расписанию")
                last_run = time.time()
            last_success = last_success_time()
            stale_alerted = check_stale_backup(
                time.time(), last_success, started_at, stale_alerted,
            )
        except Exception as e:
            loop_state = "error"
            log(f"ОШИБКА цикла: {e}")
        write_heartbeat(loop_state)
        time.sleep(CHECK_EVERY)


if __name__ == "__main__":
    main()
