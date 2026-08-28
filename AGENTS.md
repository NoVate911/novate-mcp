# AGENTS.md

Инструкции для ИИ-агентов, работающих с этим репозиторием.
Читай этот файл целиком перед любыми изменениями.

## Обзор проекта

**NoVate MCP** — кастомный MCP-сервер: MCP-клиенты (ИИ-агенты)
подключаются по HTTPS и получают инструменты для работы с VPS:
`run_command`, `write_file`, `read_file`, `list_files`.
Плюс веб-панель «NoVate MCP» для просмотра и скачивания проектов
(вход через Telegram OpenID Connect) и фоновый сервис бэкапов,
который архивирует проекты и отправляет архив в Telegram.

Четыре Docker-контейнера (docker-compose.yml):

- `mcp` — FastMCP-сервер (`src/server.py`, Python), внутренний порт 8000.
  Наружу не торчит; Caddy проксирует на него только путь `/mcp/`.
- `dashboard` — панель на **Bun + TypeScript** (`src/dashboard/`),
  внутренний порт 8001. Отвечает на всё, что не `/mcp/` и не `/projects/`.
- `backup` — сервис бэкапов (`src/backup.py`, Python stdlib): по расписанию
  или по файлу-триггеру от панели собирает tar.gz в `/backups` и шлёт
  его в Telegram через Bot API. Сетевых портов нет.
- `caddy` — единственная публичная точка (80/443), авто-HTTPS.

Код на сервер НЕ копируется: GitHub Actions собирает ТРИ образа
из одного multi-stage Dockerfile (target: `mcp` / `dashboard` / `backup`)
в один GHCR-пакет `ghcr.io/novate911/novate-mcp` с тегами `mcp-latest`,
`dashboard-latest` и `backup-latest`. Сервер делает `docker compose pull`.

## Структура репозитория

- `src/server.py` — MCP-сервер: инструменты, Bearer-авторизация, `safe_path`.
- `src/settings.py` — настройки (Python): overrides.json > .env > дефолты.
  Используется и mcp, и backup.
- `src/backup.py` — сервис бэкапов: расписание/триггер, tar.gz, Telegram
  Bot API (sendDocument/sendMessage), статус в last-backup.json.
- `src/dashboard/index.ts` — панель: роутер, вход через Telegram OIDC
  (state + PKCE, проверка id_token по JWKS), страницы (Bun.serve, без фреймворков).
- `src/dashboard/settings.ts` — TS-порт логики настроек. Держи в синхроне со settings.py!
- `src/dashboard/ui.ts` — дизайн-система: CSS-константа, каркасы страниц, helpers.
- `src/dashboard/client.ts` — клиентский JS; при сборке образа компилируется
  `bun build --minify` в `public/client.js`.
- `Dockerfile` — multi-stage: stage `mcp` (python:3.12-slim),
  stage `dashboard` (oven/bun:1) и stage `backup` (python:3.12-slim).
- `docker-compose.yml`, `Caddyfile`, `.env.example` — инфра-файлы, их
  install.sh скачивает на сервер из ветки main (raw.githubusercontent.com).
- `install.sh` — единственный файл, который загружается на сервер вручную.
- `.github/workflows/build.yml` — matrix-сборка всех трёх образов в GHCR.

## Setup commands

Python-часть (Python 3.12+):

```bash
pip install fastmcp
MCP_TOKEN=dev-token python src/server.py          # http://127.0.0.1:8000/mcp/
```

Панель (нужен Bun 1.x):

```bash
mkdir -p /tmp/projects /tmp/cfg /tmp/backups
cd src/dashboard
bun build ./client.ts --outdir ./public           # собрать клиентский JS
MCP_DATA_DIR=/tmp/projects CONFIG_DIR=/tmp/cfg BACKUP_DIR=/tmp/backups \
  DOMAIN=example.com TG_CLIENT_ID=123456 TG_CLIENT_SECRET=dev \
  SESSION_SECRET=dev-secret ALLOWED_TG_USERS=111222333 \
  bun run index.ts
# http://127.0.0.1:8001  (без реального домена OIDC-вход не пройдёт —
# Telegram пришлёт callback на DOMAIN; для локальных проверок верстки
# используй /login и смотри код)
```

Сервис бэкапов:

```bash
MCP_DATA_DIR=/tmp/projects CONFIG_DIR=/tmp/cfg BACKUP_DIR=/tmp/backups \
  TG_BOT_TOKEN=123:abc TG_CHAT_ID=111222333 \
  python src/backup.py
```

Сборка образов локально:

```bash
docker build --target mcp -t novate-mcp:mcp .
docker build --target dashboard -t novate-mcp:dashboard .
docker build --target backup -t novate-mcp:backup .
```

## Testing instructions

Тестового фреймворка нет — перед коммитом прогони ровно эти проверки
и убедись, что все зелёные:

```bash
# Синтаксис bash-установщика
bash -n install.sh

# Компиляция Python-кода
python3 -m py_compile src/server.py src/settings.py src/backup.py

# Проверка TS (если установлен bun) — сборка без запуска
cd src/dashboard && bun build ./index.ts --outdir /tmp/dashcheck --target bun && cd -

# Валидность YAML
python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml'))"
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml'))"

# Логика приоритетов настроек (Python-сторона)
CONFIG_DIR=/tmp/cfg MCP_TOKEN=env-token python3 - <<'EOF'
import sys; sys.path.insert(0, "src")
import settings
assert settings.get("MCP_TOKEN") == "env-token"
settings.set_override("MCP_TOKEN", "panel-token")
assert settings.get("MCP_TOKEN") == "panel-token"
settings.clear_override("MCP_TOKEN")
assert settings.get("MCP_TOKEN") == "env-token"
print("settings OK")
EOF
```

## Code style

- Комментарии и UI-строки — на русском (проект русскоязычный).
- Бренд: «NoVate MCP». НЕ упоминай конкретных MCP-клиентов в коде и
  документации — проект клиент-нейтральный.
- Python: docstring инструмента = инструкция для LLM, пиши понятно,
  с примерами путей.
- TypeScript: строгая типизация, без `any`; сервер — только встроенные
  API Bun и node:* (без npm-зависимостей!); HTML собирай template
  literals; весь CSS — в константе CSS в ui.ts.
- backup.py — только стандартная библиотека Python (никаких pip-зависимостей
  в образе backup).
- UI панели: минимализм, тёмная тема, акцент #1ED895 (переменная
  --accent), анимации только на CSS transform/opacity (GPU-дёшево),
  выделение текста запрещено (user-select: none), кроме input/textarea,
  уважай prefers-reduced-motion.
- Клиентский JS — только через src/dashboard/client.ts (собирается при
  сборке образа). Никаких inline-<script> с логикой в ui.ts.

## Как добавить новый MCP-инструмент

1. Функция в `src/server.py` с декоратором `@mcp.tool`.
2. Все файловые пути — ТОЛЬКО через `safe_path()` (защита от `../`).
3. Прогони проверки из Testing.
4. Пуш в main -> Actions -> на сервере `docker compose pull && up -d`.

## Как добавить новую настройку

Нужно трогать ПЯТЬ мест, иначе рассинхрон:

1. `.env.example` — новый ключ с комментарием.
2. `src/settings.py` — DEFAULTS.
3. `src/dashboard/settings.ts` — DEFAULTS (дублирует Python-сторону!).
4. `src/dashboard/index.ts` — список EDITABLE (или INFO_ONLY).
5. `README.md` — таблица настроек.

## Security considerations

- `.env`, `projects/`, `dashboard-data/`, `backups/` — НИКОГДА не коммитить
  (уже в .gitignore; при добавлении новых секретов дополняй .gitignore).
- `safe_path()` / `safePath()` обязательны для любых путей от клиента.
- Панель: вход только через Telegram OIDC — PKCE (S256), одноразовый state
  в подписанной cookie (10 минут), подпись id_token проверяется по JWKS
  Telegram, проверяются iss/aud/exp. Доступ — только у ID из
  ALLOWED_TG_USERS; allowlist проверяется на КАЖДЫЙ запрос.
- Сессионная cookie — HMAC-подписанная (ключ SESSION_SECRET),
  HttpOnly + Secure + SameSite=Lax, TTL 7 дней; подписи сравниваются через
  sha256 + timingSafeEqual (не сравнивай секреты напрямую — утекает длина).
- Бэкапы содержат overrides.json — там могут лежать переопределённые
  секреты. Чат TG_CHAT_ID и папка backups/ = хранилища секретов.
- Контейнеры работают не от root (uid 1000). Панель монтирует проекты
  read-only; backup монтирует проекты и /config read-only, пишет только
  в /backups; писать в /config может только панель, mcp читает ro.
- `run_command` выполняет произвольный shell внутри контейнера — это
  осознанная мощь инструмента; не выноси его за пределы контейнера.
- Порты наружу: только 80/443 (Caddy). 8000/8001 не публиковать,
  у backup портов нет вообще.

## Deployment

- Деплой = пуш в main -> GitHub Actions (matrix: mcp + dashboard + backup) ->
  GHCR -> на сервере `cd ~/mcp-server && docker compose pull && docker compose up -d`.
- Первая установка на чистый сервер: только `install.sh` (он ставит
  Docker, UFW, качает инфра-файлы из main, генерирует токены, создаёт
  папки projects/, dashboard-data/, backups/).
- GHCR-пакет должен быть public, иначе `docker compose pull` на сервере
  упадёт с 401 — это самая частая проблема.
- После обновления образа dashboard всем пользователям может понадобиться
  перелогиниться только если менялся SESSION_SECRET — иначе сессии живут.

## PR instructions

- Коммиты на русском или английском, коротко и по делу
  (напр. "dashboard: вход через Telegram OIDC").
- Перед пушем — все проверки из Testing instructions зелёные.
- Изменил поведение/настройки — обнови README.md и этот файл.

## Частые ловушки

- settings.py и settings.ts — ДВЕ реализации одной логики; меняя одну,
  меняй и вторую.
- Путь MCP-эндпоинта — ровно `/mcp/` (слеш важен).
- Папки данных на хосте должны принадлежать uid 1000 (панель — user
  `bun`, mcp и backup — user `appuser`, все uid 1000). Это касается и
  папки backups/ — иначе сервис бэкапов не сможет писать архивы.
- Caddyfile использует {$DOMAIN} — переменная приезжает из .env через
  compose environment; без неё Caddy не стартует.
- Вход в панель: DASH_TOKEN больше НЕТ. Нужны TG_CLIENT_ID/TG_CLIENT_SECRET
  (OIDC-приложение из @BotFather) и ALLOWED_TG_USERS; callback
  `https://DOMAIN/auth/callback` должен быть добавлен в доверенные
  источники бота у @BotFather, иначе Telegram не примет redirect_uri.
- ID пользователей, которым отказано во входе, панель пишет в лог
  (`docker compose logs dashboard`) — так удобно наполнять ALLOWED_TG_USERS.
- Кнопка «Сделать бэкап сейчас» в панели создаёт файл /config/backup-now —
  сервис backup следит за его mtime, не удаляй эту связку.
- Изменил client.ts — пересборка образа обязательна (bun build идёт в
  Dockerfile), локальный `bun run` без `bun build` отдаст заглушку
  вместо client.js.
- GHCR-теги сервисов: `mcp-latest` / `dashboard-latest` / `backup-latest` —
  не перепутай в docker-compose.yml.
