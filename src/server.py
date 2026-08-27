import os
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
    tokens={MCP_TOKEN: {"client_id": "notion-ai", "scopes": ["read", "write"]}}
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


if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=8000, path="/mcp/")
