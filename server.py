import os
import subprocess
from pathlib import Path

from fastmcp import FastMCP
from fastmcp.server.auth import StaticTokenVerifier

# ============================================================
# Все настройки приходят из .env (через env_file в docker-compose.yml)
# ============================================================

# Секретный токен доступа (обязателен, генерируется install.sh)
MCP_TOKEN = os.environ.get("MCP_TOKEN")
if not MCP_TOKEN:
    raise RuntimeError("MCP_TOKEN is not set! Проверь файл .env")

# Папка ВНУТРИ контейнера, в которую смонтирована папка SITES_DIR с хоста.
# Все инструменты работают только внутри неё. Менять имеет смысл
# только вместе с путём монтирования в docker-compose.yml.
DATA_DIR = Path(os.environ.get("MCP_DATA_DIR", "/data")).resolve()

# Публичный домен сервера (используется в описаниях инструментов)
DOMAIN = os.environ.get("DOMAIN", "").strip()
SITES_URL = f"https://{DOMAIN}/sites/" if DOMAIN else ""

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
    f"Рабочая директория строго ограничена разрешённой папкой ({DATA_DIR}).\n"
)
if SITES_URL:
    _run_desc += f"Всё созданное в ней видно в браузере: {SITES_URL}<путь>\n"


@mcp.tool(description=_run_desc)
def run_command(command: str, timeout: int = 120) -> str:
    """Args:
        command: Команда для выполнения (например, "mkdir -p coffee").
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
    """Создать или перезаписать текстовый файл в разрешённой папке сервера.

    Args:
        path: Путь относительно разрешённой папки (например, "coffee/index.html").
        content: Полное содержимое файла.
    """
    target = safe_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Записано {len(content)} символов в {target}"


@mcp.tool
def read_file(path: str) -> str:
    """Прочитать текстовый файл из разрешённой папки сервера.

    Args:
        path: Путь относительно разрешённой папки (например, "coffee/index.html").
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
    """Показать список файлов и папок в разрешённой папке сервера.

    Args:
        path: Подпапка относительно разрешённой папки (по умолчанию — вся она).
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
