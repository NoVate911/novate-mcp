import os
import shutil
import subprocess
from pathlib import Path

from fastmcp import FastMCP
from fastmcp.server.auth import StaticTokenVerifier

import settings

# ============================================================
# Настройки: .env — значения по умолчанию; переопределения из
# панели (overrides.json) имеют приоритет. Читаются при старте
# контейнера, поэтому после смены в панели: docker compose restart mcp
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


if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=8000, path="/mcp/")
