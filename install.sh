#!/bin/bash
# ============================================================
# Установщик MCP-сервера для Notion AI (Ubuntu 24.04)
#
# Файлы проекта (server.py, Dockerfile, docker-compose.yml,
# Caddyfile, .env.example) НЕ вшиты в этот скрипт — они
# скачиваются из GitHub-репозитория, чтобы всегда брать
# последние версии.
#
# Запуск от root:  bash install.sh
# ============================================================

set -e
export DEBIAN_FRONTEND=noninteractive

# Откуда скачивать проект и куда ставить
REPO_URL="https://github.com/NoVate911/novate-mcp.git"
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
echo "=== [3/7] Docker и git ==="
apt install -y git curl
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
echo "=== [5/7] Файлы проекта из GitHub ==="
echo "Репозиторий: $REPO_URL"

# Быстрая проверка доступности репозитория ДО любых изменений
if ! git ls-remote "$REPO_URL" HEAD >/dev/null 2>&1; then
  echo ""
  echo "!!! ОШИБКА: не могу получить доступ к репозиторию:"
  echo "    $REPO_URL"
  echo ""
  echo "    Возможные причины:"
  echo "    - репозиторий приватный или удалён"
  echo "    - опечатка в URL"
  echo "    - на сервере нет доступа в интернет"
  echo ""
  echo "    Ничего не изменено, установка остановлена."
  exit 1
fi

if [ -d "$BASE_DIR/.git" ]; then
  # Проект уже клонирован ранее — просто тянем последнюю версию
  echo "Папка $BASE_DIR уже связана с репозиторием — обновляю (git pull)..."
  if ! git -C "$BASE_DIR" pull --ff-only; then
    echo ""
    echo "!!! ОШИБКА: git pull не удался — в $BASE_DIR есть локальные изменения."
    echo "    Разберись с ними вручную, либо сохрани .env и sites/,"
    echo "    удали папку $BASE_DIR и запусти скрипт заново."
    exit 1
  fi
else
  BACKUP_DIR=""
  if [ -d "$BASE_DIR" ]; then
    echo "Папка $BASE_DIR существует (без git) — сохраняю .env и sites/, заменяю файлы..."
    BACKUP_DIR=$(mktemp -d)
    if [ -f "$BASE_DIR/.env" ]; then cp "$BASE_DIR/.env" "$BACKUP_DIR/.env"; fi
    if [ -d "$BASE_DIR/sites" ]; then cp -a "$BASE_DIR/sites" "$BACKUP_DIR/sites"; fi
    rm -rf "$BASE_DIR"
  fi
  if ! git clone "$REPO_URL" "$BASE_DIR"; then
    echo "!!! ОШИБКА: не удалось клонировать репозиторий."
    exit 1
  fi
  if [ -n "$BACKUP_DIR" ]; then
    if [ -f "$BACKUP_DIR/.env" ]; then
      cp "$BACKUP_DIR/.env" "$BASE_DIR/.env"
      echo "Файл .env восстановлен (токен сохранён)."
    fi
    if [ -d "$BACKUP_DIR/sites" ]; then
      mkdir -p "$BASE_DIR/sites"
      cp -a "$BACKUP_DIR/sites/." "$BASE_DIR/sites/"
      echo "Папка sites/ восстановлена."
    fi
    rm -rf "$BACKUP_DIR"
  fi
fi
cd "$BASE_DIR"
echo "Файлы проекта на месте: $(ls -1 | tr '\n' ' ')"

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
echo "Репозиторий: $REPO_URL"
echo "Домен:       $DOMAIN"
echo "Папка:       $SITES_ABS  (только она доступна MCP)"
echo "Токен:       смотри в $BASE_DIR/.env (MCP_TOKEN)"
echo ""
echo "Проверки:"
echo "  curl -i https://$DOMAIN/mcp/   (ожидается 401 Unauthorized)"
echo "  https://$DOMAIN/sites/         (файлы в браузере)"
echo ""
echo "Подключение в Notion:"
echo "  URL:   https://$DOMAIN/mcp/"
echo "  Auth:  Bearer Token = MCP_TOKEN из .env"
echo ""
echo "Обновление до последней версии из GitHub:"
echo "  bash $BASE_DIR/install.sh"

if [ -f /var/run/reboot-required ]; then
  echo ""
  echo "ВНИМАНИЕ: система просит перезагрузку (обновилось ядро)."
  echo "Выполни: reboot — после перезагрузки контейнеры поднимутся сами."
fi
