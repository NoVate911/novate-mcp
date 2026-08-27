#!/bin/bash
# ============================================================
# ПОЛНАЯ УСТАНОВКА MCP-СЕРВЕРА ДЛЯ NOTION AI (Ubuntu 24.04)
#
# Загрузи этот один файл на сервер и запусти от root:
#   bash install.sh
#
# Скрипт сделает всё сам:
#   1. Обновит систему (apt update && apt upgrade)
#   2. Установит Docker (если ещё не установлен)
#   3. Настроит файрвол UFW (SSH + порты 80/443)
#   4. Создаст файлы проекта в ~/mcp-server
#   5. Создаст .env и сгенерирует токен (при первом запуске)
#   6. Создаст разрешённую папку и перенесёт данные
#      из старого Docker-volume (если обновляешься со старой версии)
#   7. Соберёт и запустит контейнеры
#
# Повторный запуск безопасен: .env не перезаписывается,
# а файлы кода (server.py и др.) приводятся к эталонным версиям.
# Если правил код под себя — не запускай install.sh, а используй:
#   cd ~/mcp-server && docker compose up -d --build
# ============================================================

set -e
export DEBIAN_FRONTEND=noninteractive

# Проект всегда живёт здесь, независимо от того, куда загружен скрипт
BASE_DIR="${BASE_DIR:-$HOME/mcp-server}"

echo ""
echo "=== [1/7] Проверка прав ==="
if [ "$EUID" -ne 0 ]; then
  echo "Нужны права root. Запусти: sudo bash install.sh"
  exit 1
fi

echo ""
echo "=== [2/7] Обновление системы (может занять несколько минут) ==="
apt update
apt upgrade -y

echo ""
echo "=== [3/7] Установка Docker ==="
if command -v docker >/dev/null 2>&1; then
  echo "Docker уже установлен — пропускаю."
else
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ОШИБКА: плагин docker compose не найден после установки."
  exit 1
fi

echo ""
echo "=== [4/7] Настройка файрвола UFW ==="
apt install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH   # ВАЖНО: иначе потеряешь SSH-доступ
ufw allow 80/tcp    # HTTP (нужен для получения HTTPS-сертификата)
ufw allow 443/tcp   # HTTPS
ufw --force enable

echo ""
echo "=== [5/7] Файлы проекта в $BASE_DIR ==="
mkdir -p "$BASE_DIR"
cd "$BASE_DIR"

cat > server.py << 'PYEOF'
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
PYEOF

cat > Dockerfile << 'DEOF'
FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir fastmcp

# Работаем НЕ от root — отдельный пользователь
RUN useradd --create-home appuser \
    && mkdir -p /data \
    && chown -R appuser:appuser /data

COPY server.py .

USER appuser

EXPOSE 8000

CMD ["python", "server.py"]
DEOF

cat > docker-compose.yml << 'YMLEOF'
# Все значения ${...} подставляются из файла .env автоматически
services:
  mcp:
    build: .
    container_name: fastmcp-server
    restart: unless-stopped
    env_file: .env
    volumes:
      # MCP видит ТОЛЬКО папку SITES_DIR из .env — больше ничего на сервере
      - ${SITES_DIR:-./sites}:/data
    networks:
      - web

  caddy:
    image: caddy:2
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      # Домен для Caddyfile берётся из .env
      - DOMAIN=${DOMAIN:-localhost}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
      - ${SITES_DIR:-./sites}:/srv/sites:ro
    networks:
      - web
    depends_on:
      - mcp

volumes:
  caddy_data:
  caddy_config:

networks:
  web:
YMLEOF

cat > Caddyfile << 'CEOF'
# {$DOMAIN} подставляется из .env (передаётся через docker-compose)
{$DOMAIN} {
	# MCP-эндпоинт -> контейнер с FastMCP
	handle /mcp* {
		reverse_proxy mcp:8000
	}

	# Статика: всё, что ИИ создаст в разрешённой папке, видно в браузере
	handle_path /sites/* {
		root * /srv/sites
		file_server browse
	}

	# Всё остальное — заглушка-проверка
	handle {
		respond "MCP server is running. Endpoint: /mcp/" 200
	}
}
CEOF

cat > .env.example << 'EEOF'
# ============ СЕКРЕТ ============
# Токен доступа к MCP. Сгенерировать: openssl rand -hex 32
# (install.sh сделает это автоматически при первом запуске)
MCP_TOKEN=

# ============ ОСНОВНЫЕ НАСТРОЙКИ ============
# Домен сервера. Только домен: без https:// и без слэша в конце.
DOMAIN=novate-gpt.space

# Папка на сервере, к которой получает доступ MCP.
# Всё внутри неё видно в браузере по адресу https://DOMAIN/sites/...
# Относительный путь считается от папки mcp-server.
SITES_DIR=./sites
EEOF

echo "Файлы проекта записаны."

echo ""
echo "=== [6/7] Настройки (.env) ==="
if [ ! -f .env ]; then
  cp .env.example .env
  TOKEN=$(openssl rand -hex 32)
  sed -i "s|^MCP_TOKEN=.*|MCP_TOKEN=$TOKEN|" .env
  echo "------------------------------------------------"
  echo "Сгенерирован токен (СОХРАНИ ЕГО — нужен для Notion):"
  echo ""
  echo "  $TOKEN"
  echo ""
  echo "Он также лежит в файле $BASE_DIR/.env"
  echo "------------------------------------------------"
else
  echo ".env уже существует — токен и настройки сохранены."
  grep -q '^MCP_TOKEN=.' .env || { echo "ОШИБКА: в .env пустой MCP_TOKEN"; exit 1; }
  grep -q '^DOMAIN=' .env    || echo 'DOMAIN=novate-gpt.space' >> .env
  grep -q '^SITES_DIR=' .env || echo 'SITES_DIR=./sites' >> .env
fi

SITES_DIR=$(grep -E '^SITES_DIR=' .env | cut -d= -f2- | tr -d "\"'")
SITES_DIR=${SITES_DIR:-./sites}
DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2- | tr -d "\"'")
DOMAIN=${DOMAIN:-localhost}

# Абсолютный путь папки (для volume в Docker)
case "$SITES_DIR" in
  /*) SITES_ABS="$SITES_DIR" ;;
  *)  SITES_ABS="$PWD/$SITES_DIR" ;;
esac

echo ""
echo "=== [7/7] Папка данных и запуск ==="
mkdir -p "$SITES_ABS"

# Перенос данных из старого named volume (при обновлении со старой версии)
if [ -z "$(ls -A "$SITES_ABS" 2>/dev/null)" ]; then
  OLD_VOL=$(docker volume ls -q 2>/dev/null | grep sites_data | head -n1 || true)
  if [ -n "$OLD_VOL" ]; then
    echo "Найден старый volume '$OLD_VOL' — переношу файлы в $SITES_ABS ..."
    docker run --rm -v "$OLD_VOL":/from -v "$SITES_ABS":/to alpine sh -c "cp -a /from/. /to/" || true
  fi
fi

# Права для пользователя контейнера (uid 1000), иначе MCP не сможет писать
chown -R 1000:1000 "$SITES_ABS" 2>/dev/null || chmod 777 "$SITES_ABS"

docker compose up -d --build

echo ""
echo "================================================"
echo "  УСТАНОВКА ЗАВЕРШЕНА"
echo "================================================"
echo "Домен:  $DOMAIN"
echo "Папка:  $SITES_ABS  (только она доступна MCP)"
echo "Токен:  смотри в $BASE_DIR/.env (MCP_TOKEN)"
echo ""
echo "Проверки:"
echo "  curl -i https://$DOMAIN/mcp/   (ожидается 401 Unauthorized)"
echo "  https://$DOMAIN/sites/         (файлы в браузере)"
echo ""
echo "Подключение в Notion:"
echo "  URL:   https://$DOMAIN/mcp/"
echo "  Auth:  Bearer Token = MCP_TOKEN из .env"

if [ -f /var/run/reboot-required ]; then
  echo ""
echo "ВНИМАНИЕ: система просит перезагрузку (обновилось ядро)."
echo "Выполни: reboot — после перезагрузки контейнеры поднимутся сами."
fi
