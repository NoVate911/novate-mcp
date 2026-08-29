import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from fastmcp import FastMCP
from fastmcp.server.auth import StaticTokenVerifier

import settings

# ============================================================
# Настройки: .env — значения по умолчанию; переопределения из
# панели (overrides.json) имеют приоритет. MCP_TOKEN читается при старте,
# а фоновый наблюдатель автоматически перезапускает процесс при его смене.
# ============================================================

# Секретный токен доступа (обязателен, генерируется install.sh)
MCP_TOKEN = settings.get("MCP_TOKEN")
if not MCP_TOKEN:
    raise RuntimeError("MCP_TOKEN is not set! Проверь файл .env")

# Папка ВНУТРИ контейнера, в которую смонтирована папка PROJECTS_DIR с хоста.
# Все инструменты работают только внутри неё.
DATA_DIR = Path(os.environ.get("MCP_DATA_DIR", "/data")).resolve()

# Публичный домен сервера (используется в описаниях инструментов)
DOMAIN = settings.get("DOMAIN")
PROJECTS_URL = "https://" + DOMAIN + "/projects/" if DOMAIN else ""

# Авторизация: только запросы с заголовком "Authorization: Bearer <MCP_TOKEN>"
auth = StaticTokenVerifier(
    tokens={MCP_TOKEN: {"client_id": "mcp-client", "scopes": ["read", "write"]}}
)

mcp = FastMCP(name="VPS Tools", auth=auth)


def safe_path(path: str) -> Path:
    """Разрешаем пути только внутри DATA_DIR (защита от выхода через ../)."""
    target = (DATA_DIR / path.lstrip("/")).resolve()
    if target != DATA_DIR and DATA_DIR not in target.parents:
        raise ValueError(f"Путь '{path}' выходит за пределы разрешённой папки")
    return target


_run_desc = (
    "Выполнить shell-команду на сервере в изолированном Docker-контейнере.\n\n"
    f"Рабочая директория строго ограничена папкой проектов ({DATA_DIR}).\n"
)
if PROJECTS_URL:
    _run_desc += f"Созданные проекты видны в браузере: {PROJECTS_URL}<имя проекта>\n"


@mcp.tool(description=_run_desc)
def run_command(command: str, timeout: int = 120) -> str:
    """Args:
        command: Команда для выполнения (например, "mkdir -p landing").
        timeout: Лимит времени в секундах (по умолчанию 120, максимум 600).
    """
    timeout = min(max(timeout, 1), 600)
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=DATA_DIR,
            timeout=timeout,
            capture_output=True,
            text=True,
        )
        output = f"$ {command}\nexit code: {result.returncode}"
        if result.stdout:
            output += f"\n\nstdout:\n{result.stdout[-4000:]}"
        if result.stderr:
            output += f"\n\nstderr:\n{result.stderr[-4000:]}"
        return output
    except subprocess.TimeoutExpired:
        return f"$ {command}\nКоманда превысила лимит {timeout} секунд"


@mcp.tool
def write_file(path: str, content: str) -> str:
    """Создать или перезаписать текстовый файл в папке проектов на сервере.

    Args:
        path: Путь относительно папки проектов (например, "landing/index.html").
        content: Полное содержимое файла.
    """
    target = safe_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Записано {len(content)} символов в {target}"


@mcp.tool
def read_file(path: str) -> str:
    """Прочитать текстовый файл из папки проектов на сервере.

    Args:
        path: Путь относительно папки проектов (например, "landing/index.html").
    """
    target = safe_path(path)
    if not target.is_file():
        return f"Файл не найден: {path}"
    text = target.read_text(encoding="utf-8", errors="replace")
    if len(text) > 20000:
        return text[:20000] + "\n... (обрезано)"
    return text


@mcp.tool
def list_files(path: str = ".") -> str:
    """Показать список проектов и файлов на сервере.

    Args:
        path: Подпапка относительно папки проектов (по умолчанию — вся она).
    """
    target = safe_path(path)
    if not target.is_dir():
        return f"Папка не найдена: {path}"
    lines = []
    for p in sorted(target.rglob("*")):
        prefix = "[DIR] " if p.is_dir() else "[FILE] "
        lines.append(prefix + str(p.relative_to(DATA_DIR)))
        if len(lines) >= 500:
            lines.append("... (обрезано)")
            break
    return "\n".join(lines) if lines else "(пусто)"


@mcp.tool
def search_in_files(query: str, path: str = ".", max_results: int = 50) -> str:
    """Искать текст в содержимом файлов проектов (как grep, без регулярных выражений).

    Args:
        query: Строка для поиска (обычный текст, регистр учитывается).
        path: Подпапка для поиска относительно папки проектов
              (например, "landing"; по умолчанию — все проекты).
        max_results: Максимум совпадений в ответе (по умолчанию 50, максимум 200).
    """
    if not query:
        return "Пустой запрос"
    target = safe_path(path)
    if not target.is_dir():
        return f"Папка не найдена: {path}"
    max_results = min(max(max_results, 1), 200)
    hits = []
    for p in sorted(target.rglob("*")):
        if not p.is_file():
            continue
        try:
            if p.stat().st_size > 5 * 1024 * 1024:
                continue  # слишком большие файлы пропускаем
            text = p.read_text(encoding="utf-8", errors="strict")
        except (UnicodeDecodeError, OSError):
            continue  # бинарные и недоступные файлы пропускаем
        for lineno, line in enumerate(text.splitlines(), 1):
            if query in line:
                rel = p.relative_to(DATA_DIR)
                hits.append(f"{rel}:{lineno}: {line.strip()[:200]}")
                if len(hits) >= max_results:
                    return "\n".join(hits) + "\n... (обрезано — уточни запрос или путь)"
    return "\n".join(hits) if hits else "Совпадений нет"


@mcp.tool
def delete_file(path: str) -> str:
    """Удалить файл или папку в папке проектов на сервере.

    Args:
        path: Путь относительно папки проектов (например, "landing/draft.html").
              Папка удаляется вместе со всем содержимым.
    """
    target = safe_path(path)
    if target == DATA_DIR:
        return "Нельзя удалить корневую папку проектов"
    if not target.exists():
        return f"Не найдено: {path}"
    if target.is_dir():
        shutil.rmtree(target)
        return f"Удалена папка с содержимым: {path}"
    target.unlink()
    return f"Удалён файл: {path}"


@mcp.tool
def move_file(src: str, dst: str) -> str:
    """Переместить или переименовать файл/папку в папке проектов.

    Args:
        src: Откуда (например, "landing/old.html").
        dst: Куда (например, "landing/new.html"). Недостающие папки создаются.
    """
    source = safe_path(src)
    dest = safe_path(dst)
    if source == DATA_DIR or dest == DATA_DIR:
        return "Нельзя перемещать корневую папку проектов"
    if not source.exists():
        return f"Не найдено: {src}"
    if dest.exists():
        return f"Уже существует: {dst}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(dest))
    return f"Перемещено: {src} -> {dst}"


# ============================================================
# Статистика сервера и фоновые задачи
# ============================================================

def _human(n: float) -> str:
    size = float(n)
    for unit in ["Б", "КБ", "МБ", "ГБ", "ТБ"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} ПБ"


@mcp.tool
def server_stats() -> str:
    """Показать состояние сервера: нагрузка, память, диск, аптайм, проекты.
    Возвращает сводку по хосту (вид из контейнера)."""
    cores = os.cpu_count() or 1
    try:
        l1, l5, l15 = os.getloadavg()
    except OSError:
        l1 = l5 = l15 = 0.0

    mem_total = mem_avail = 0
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                mem_total = int(line.split()[1]) * 1024
            elif line.startswith("MemAvailable:"):
                mem_avail = int(line.split()[1]) * 1024
    except OSError:
        pass
    mem_used = mem_total - mem_avail
    mem_pct = round(mem_used * 100 / mem_total) if mem_total else 0

    du = shutil.disk_usage(str(DATA_DIR))

    up = 0.0
    try:
        up = float(Path("/proc/uptime").read_text().split()[0])
    except OSError:
        pass
    uptime = f"{int(up // 86400)} дн {int((up % 86400) // 3600)} ч"

    proj_names = []
    proj_files = 0
    proj_size = 0
    if DATA_DIR.is_dir():
        for d in sorted(DATA_DIR.iterdir()):
            if d.is_dir() and not d.name.startswith("."):
                proj_names.append(d.name)
        for f in DATA_DIR.rglob("*"):
            try:
                if f.is_file():
                    proj_files += 1
                    proj_size += f.stat().st_size
            except OSError:
                pass

    return "\n".join([
        "Сервер (вид из контейнера):",
        f"CPU: {cores} ядер, нагрузка {l1:.2f} / {l5:.2f} / {l15:.2f} (1/5/15 мин)",
        f"Память: {_human(mem_used)} из {_human(mem_total)} ({mem_pct}%)",
        f"Диск с проектами: занято {_human(du.used)}, свободно {_human(du.free)} из {_human(du.total)}",
        f"Аптайм: {uptime}",
        f"Проекты: {len(proj_names)} шт ({proj_files} файлов, {_human(proj_size)})"
        + (": " + ", ".join(proj_names) if proj_names else ""),
    ])


# Фоновые задачи: логи лежат в /tmp контейнера — нарочно ВНЕ /data,
# чтобы не публиковаться на /projects/ и не попадать в бэкапы.
# Перезапуск контейнера очищает задачи и логи.
TASKS_DIR = Path("/tmp/mcp-tasks")
_tasks: dict = {}


@mcp.tool
def run_background(command: str) -> str:
    """Запустить shell-команду в фоне в папке проектов (для долгих задач:
    сборки, деплои, генерации), не блокируя ответ.

    Args:
        command: Команда (например, "npm install && npm run build").

    Вернёт ID задачи. Статус и лог смотри через poll_task(task_id).
    """
    TASKS_DIR.mkdir(parents=True, exist_ok=True)
    task_id = uuid.uuid4().hex[:8]
    log_file = TASKS_DIR / f"{task_id}.log"
    with open(log_file, "w", encoding="utf-8") as f:
        proc = subprocess.Popen(
            command, shell=True, cwd=DATA_DIR,
            stdout=f, stderr=subprocess.STDOUT, text=True,
            start_new_session=True,
        )
    _tasks[task_id] = proc
    return (
        "Задача " + task_id + " запущена (PID " + str(proc.pid) + ").\n"
        "Проверка статуса: poll_task(\"" + task_id + "\")"
    )


@mcp.tool
def poll_task(task_id: str, tail: int = 40) -> str:
    """Проверить статус и лог фоновой задачи, запущенной run_background.

    Args:
        task_id: ID задачи (8 символов из ответа run_background).
        tail: Сколько последних строк лога показать (по умолчанию 40, максимум 200).
    """
    if not re.fullmatch(r"[0-9a-f]{8}", task_id):
        return "Некорректный ID задачи (нужны 8 hex-символов из run_background)"
    log_file = TASKS_DIR / f"{task_id}.log"
    proc = _tasks.get(task_id)
    if proc is not None:
        rc = proc.poll()
        status = "выполняется" if rc is None else f"завершена с кодом {rc}"
    elif log_file.exists():
        status = "процесс не найден (контейнер перезапускался?) — вот лог"
    else:
        return f"Задача {task_id} не найдена"
    out = f"Задача {task_id}: {status}"
    if log_file.exists():
        lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
        tail = min(max(tail, 1), 200)
        if lines:
            out += "\n--- лог (последние строки) ---\n" + "\n".join(lines[-tail:])
    return out


# Файл-триггер для сервиса бэкапов: он следит и за /config/backup-now
# (кнопка в панели), и за этим файлом в папке проектов (этот инструмент).
BACKUP_TRIGGER = DATA_DIR / ".backup-now"


@mcp.tool
def make_backup() -> str:
    """Запустить бэкап проектов вне расписания (как кнопка в панели).

    Архив появится в панели (раздел «Бэкапы») и придёт в Telegram
    (если настроены TG_BOT_TOKEN и TG_CHAT_ID). Запуск занимает до минуты.
    """
    BACKUP_TRIGGER.write_text(str(int(time.time())), encoding="utf-8")
    return ("Бэкап запущен. Готовый архив появится в панели (раздел «Бэкапы») "
            "и в Telegram в течение минуты.")


def watch_mcp_token() -> None:
    """Перезапускает MCP-процесс, когда панель сгенерировала новый токен."""
    while True:
        time.sleep(2)
        token = settings.get("MCP_TOKEN")
        if token and token != MCP_TOKEN:
            print("MCP_TOKEN изменён — перезапуск MCP-процесса", flush=True)
            os.execv(sys.executable, [sys.executable, *sys.argv])


if __name__ == "__main__":
    threading.Thread(target=watch_mcp_token, daemon=True).start()
    mcp.run(transport="http", host="0.0.0.0", port=8000, path="/mcp/")
