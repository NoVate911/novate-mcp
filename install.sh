#!/bin/bash
# ============================================================
# Установщик NoVate MCP (Ubuntu 24.04)
# MCP-сервер + веб-панель управления проектами + бэкапы в Telegram.
#
# Код проекта НЕ копируется на сервер: GitHub Actions собирает
# Docker-образы и кладёт их в GHCR (ghcr.io/novate911/novate-mcp).
# Сервер скачивает готовые образы через docker compose pull.
# Этот скрипт забирает из репозитория только 3 инфра-файла:
# docker-compose.yml, Caddyfile, .env.example
#
# Запуск от root:  bash install.sh
# ============================================================

set -e
export DEBIAN_FRONTEND=noninteractive

REPO_RAW="https://raw.githubusercontent.com/NoVate911/novate-mcp/main"
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
echo "=== [3/7] Docker ==="
apt install -y curl
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
echo "=== [5/7] Инфра-файлы из GitHub ==="
mkdir -p "$BASE_DIR"
cd "$BASE_DIR"

for f in docker-compose.yml Caddyfile .env.example; do
  if ! curl -fsSL "$REPO_RAW/$f" -o "$f"; then
    echo ""
    echo "!!! ОШИБКА: не удалось скачать $f"
    echo "    из $REPO_RAW"
    echo "    Возможные причины: репозиторий недоступен/приватный,"
    echo "    файл не запушен, нет интернета, ветка не main."
    echo "    Ничего не запущено."
    exit 1
  fi
  echo "  скачан $f"
done

# Миграция со старых версий: sites -> projects
if [ -d sites ] && [ ! -d projects ]; then
  mv sites projects
  echo "Папка sites/ переименована в projects/"
fi

echo ""
echo "=== [6/7] Настройки (.env) ==="
if [ ! -f .env ]; then
  cp .env.example .env
  MCP=$(openssl rand -hex 32)
  SESS=$(openssl rand -hex 32)
  sed -i "s|^MCP_TOKEN=.*|MCP_TOKEN=$MCP|" .env
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SESS|" .env
  echo "------------------------------------------------"
  echo "Создан .env. СОХРАНИ токен:"
  echo ""
  echo "  MCP_TOKEN (для MCP-клиента):  $MCP"
  echo ""
  echo "Также сгенерирован SESSION_SECRET (подпись сессий панели)."
  echo "Оба лежат в файле $BASE_DIR/.env"
  echo ""
  echo "Осталось заполнить в .env (nano $BASE_DIR/.env):"
  echo "  TG_CLIENT_ID / TG_CLIENT_SECRET — OIDC-приложение из @BotFather"
  echo "  ALLOWED_TG_USERS — Telegram ID, которым разрешён вход в панель"
  echo "  TG_BOT_TOKEN / TG_CHAT_ID — бот и чат для бэкапов"
  echo "------------------------------------------------"
else
  echo ".env уже существует — токены и настройки сохранены."
  # Переименование старого ключа, если обновляешься
  sed -i 's|^SITES_DIR=|PROJECTS_DIR=|' .env
  grep -q '^DOMAIN=' .env       || echo 'DOMAIN=novate-gpt.space' >> .env
  grep -q '^PROJECTS_DIR=' .env || echo 'PROJECTS_DIR=./projects' >> .env
  # DASH_TOKEN больше не используется — вход в панель через Telegram OIDC
  if grep -q '^DASH_TOKEN=' .env; then
    sed -i '/^DASH_TOKEN=/d' .env
    echo "Удалён DASH_TOKEN: вход в панель теперь через Telegram (ALLOWED_TG_USERS)."
  fi
  # Новые ключи (вход через Telegram + бэкапы)
  grep -q '^SESSION_SECRET=' .env        || echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
  grep -q '^TG_CLIENT_ID=' .env          || echo 'TG_CLIENT_ID=' >> .env
  grep -q '^TG_CLIENT_SECRET=' .env      || echo 'TG_CLIENT_SECRET=' >> .env
  grep -q '^ALLOWED_TG_USERS=' .env      || echo 'ALLOWED_TG_USERS=' >> .env
  grep -q '^TG_BOT_TOKEN=' .env          || echo 'TG_BOT_TOKEN=' >> .env
  grep -q '^TG_CHAT_ID=' .env            || echo 'TG_CHAT_ID=' >> .env
  grep -q '^BACKUP_INTERVAL_HOURS=' .env || echo 'BACKUP_INTERVAL_HOURS=24' >> .env
  grep -q '^BACKUP_KEEP=' .env           || echo 'BACKUP_KEEP=7' >> .env
fi
grep -q '^MCP_TOKEN=.' .env || { echo "ОШИБКА: в .env пустой MCP_TOKEN"; exit 1; }
if ! grep -q '^SESSION_SECRET=.' .env; then
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env
  echo "Сгенерирован SESSION_SECRET."
fi

# Подсказки про незаполненные Telegram-ключи
grep -q '^TG_CLIENT_ID=.' .env     || echo "ВНИМАНИЕ: TG_CLIENT_ID пуст — вход в панель работать не будет."
grep -q '^TG_CLIENT_SECRET=.' .env || echo "ВНИМАНИЕ: TG_CLIENT_SECRET пуст — вход в панель работать не будет."
grep -q '^ALLOWED_TG_USERS=.' .env || echo "ВНИМАНИЕ: ALLOWED_TG_USERS пуст — войти в панель никто не сможет."
grep -q '^TG_BOT_TOKEN=.' .env     || echo "ПРИМЕЧАНИЕ: TG_BOT_TOKEN пуст — бэкапы будут только локальными (папка backups/)."
grep -q '^TG_CHAT_ID=.' .env       || echo "ПРИМЕЧАНИЕ: TG_CHAT_ID пуст — бэкапы будут только локальными (папка backups/)."

PROJECTS_DIR=$(grep -E '^PROJECTS_DIR=' .env | cut -d= -f2- | tr -d "\"'")
PROJECTS_DIR=${PROJECTS_DIR:-./projects}
DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2- | tr -d "\"'")
DOMAIN=${DOMAIN:-localhost}

case "$PROJECTS_DIR" in
  /*) PROJECTS_ABS="$PROJECTS_DIR" ;;
  *)  PROJECTS_ABS="$PWD/$PROJECTS_DIR" ;;
esac

echo ""
echo "=== [7/7] Папки, образы и запуск ==="
mkdir -p "$PROJECTS_ABS"
mkdir -p "$BASE_DIR/dashboard-data"
mkdir -p "$BASE_DIR/backups"

# Перенос данных из старого named volume (самая первая версия)
if [ -z "$(ls -A "$PROJECTS_ABS" 2>/dev/null)" ]; then
  OLD_VOL=$(docker volume ls -q 2>/dev/null | grep sites_data | head -n1 || true)
  if [ -n "$OLD_VOL" ]; then
    echo "Найден старый volume '$OLD_VOL' — переношу файлы..."
    docker run --rm -v "$OLD_VOL":/from -v "$PROJECTS_ABS":/to alpine sh -c "cp -a /from/. /to/" || true
  fi
fi

# Права для пользователя контейнеров (uid 1000)
chown -R 1000:1000 "$PROJECTS_ABS" 2>/dev/null || chmod 777 "$PROJECTS_ABS"
chown -R 1000:1000 "$BASE_DIR/dashboard-data" 2>/dev/null || chmod 777 "$BASE_DIR/dashboard-data"
chown -R 1000:1000 "$BASE_DIR/backups" 2>/dev/null || chmod 777 "$BASE_DIR/backups"

# Скачиваем свежие образы, собранные GitHub Actions
if ! docker compose pull; then
  echo ""
  echo "!!! ОШИБКА: не удалось скачать образы ghcr.io/novate911/novate-mcp"
  echo "    Проверь две вещи:"
  echo "    1) GitHub Actions уже собрал образы (вкладка Actions в репозитории — зелёная галочка)"
  echo "    2) Пакет публичный: GitHub -> Packages -> novate-mcp -> Package settings ->"
  echo "       Change visibility -> Public"
  echo "    Либо авторизуйся: docker login ghcr.io -u NoVate911 -p <GITHUB_TOKEN>"
  echo "    и запусти скрипт ещё раз."
  exit 1
fi

docker compose up -d

echo ""
echo "================================================"
echo "  УСТАНОВКА ЗАВЕРШЕНА"
echo "================================================"
echo "Домен:   $DOMAIN"
echo "Проекты: $PROJECTS_ABS  (только она доступна MCP)"
echo "Бэкапы:  $BASE_DIR/backups  + отправка в Telegram"
echo ""
echo "Панель управления:  https://$DOMAIN/"
echo "  (вход через Telegram — разрешённые ID в ALLOWED_TG_USERS в .env)"
echo "MCP-эндпоинт:       https://$DOMAIN/mcp/"
echo "  (Bearer Token = MCP_TOKEN из .env — вставь в свой MCP-клиент)"
echo "Публичные проекты:  https://$DOMAIN/projects/<имя>/"
echo ""
echo "Проверка MCP: curl -i https://$DOMAIN/mcp/  (ожидается 401)"
echo ""
echo "Обновление до новой версии (после пуша в GitHub):"
echo "  cd $BASE_DIR && docker compose pull && docker compose up -d"

if [ -f /var/run/reboot-required ]; then
  echo ""
  echo "ВНИМАНИЕ: система просит перезагрузку (обновилось ядро)."
  echo "Выполни: reboot — после перезагрузки контейнеры поднимутся сами."
fi
