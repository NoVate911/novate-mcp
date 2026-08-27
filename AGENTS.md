# AGENTS.md

Инструкции для ИИ-агентов, работающих с этим репозиторием.
Читай этот файл целиком перед любыми изменениями.

## Обзор проекта

**NoVate MCP** — кастомный MCP-сервер: MCP-клиенты (ИИ-агенты)
подключаются по HTTPS и получают инструменты для работы с VPS:
`run_command`, `write_file`, `read_file`, `list_files`.
Плюс веб-панель «NoVate MCP» для просмотра и скачивания проектов.

Три Docker-контейнера (docker-compose.yml):

- `mcp` — FastMCP-сервер (`src/server.py`, Python), внутренний порт 8000.
  Наружу не торчит; Caddy проксирует на него только путь `/mcp/`.
- `dashboard` — панель на **Bun + TypeScript** (`src/dashboard/`),
  внутренний порт 8001. Отвечает на всё, что не `/mcp/` и не `/projects/`.
- `caddy` — единственная публичная точка (80/443), авто-HTTPS.

Код на сервер НЕ копируется: GitHub Actions собирает ДВА образа
из одного multi-stage Dockerfile (target: `mcp` / `dashboard`) в один
GHCR-пакет `ghcr.io/novate911/novate-mcp` с тегами `mcp-latest` и
`dashboard-latest`. Сервер делает `docker compose pull`.

## Структура репозитория

- `src/server.py` — MCP-сервер: инструменты, Bearer-авторизация, `safe_path`.
- `src/settings.py` — настройки для MCP (Python): overrides.json > .env > дефолты.
- `src/dashboard/index.ts` — панель: роутер, auth, страницы (Bun.serve, без фреймворков).
- `src/dashboard/settings.ts` — TS-порт логики настроек. Держи в синхроне со settings.py!
- `src/dashboard/ui.ts` — дизайн-система: CSS-константа, каркасы страниц, helpers.
- `src/dashboard/client.ts` — клиентский JS; при сборке образа компилируется
  `bun build --minify` в `public/client.js`.
- `Dockerfile` — multi-stage: stage `mcp` (python:3.12-slim) и
  stage `dashboard` (oven/bun:1).
- `docker-compose.yml`, `Caddyfile`, `.env.example` — инфра-файлы, их
  install.sh скачивает на сервер из ветки main (raw.githubusercontent.com).
- `install.sh` — единственный файл, который загружается на сервер вручную.
- `.github/workflows/build.yml` — matrix-сборка обоих образов в GHCR.

## Setup commands

Python-часть (Python 3.12+):

```bash
pip install fastmcp
MCP_TOKEN=dev-token python src/server.py          # http://127.0.0.1:8000/mcp/
```

Панель (нужен Bun 1.x):

```bash
mkdir -p /tmp/projects /tmp/cfg
cd src/dashboard
bun build ./client.ts --outdir ./public           # собрать клиентский JS
MCP_DATA_DIR=/tmp/projects DASH_TOKEN=dev CONFIG_DIR=/tmp/cfg bun run index.ts
# http://127.0.0.1:8001
```

Сборка образов локально:

```bash
docker build --target mcp -t novate-mcp:mcp .
docker build --target dashboard -t novate-mcp:dashboard .
```

## Testing instructions

Тестового фреймворка нет — перед коммитом прогони ровно эти проверки
и убедись, что все зелёные:

```bash
# Синтаксис bash-установщика
bash -n install.sh

# Компиляция Python-кода
python3 -m py_compile src/server.py src/settings.py

# Проверка TS (если установлен bun) — сборка без запуска
cd src/dashboard && bun build ./index.ts --outdir /tmp/dashcheck --target bun && cd -

# Валидность YAML
python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml'))"
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml'))"

# Логика приоритетов настроек (Python-сторона)
CONFIG_DIR=/tmp/cfg DASH_TOKEN=env-token python3 - <<'EOF'
import sys; sys.path.insert(0, "src")
import settings
assert settings.get("DASH_TOKEN") == "env-token"
settings.set_override("DASH_TOKEN", "panel-token")
assert settings.get("DASH_TOKEN") == "panel-token"
settings.clear_override("DASH_TOKEN")
assert settings.get("DASH_TOKEN") == "env-token"
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

- `.env`, `projects/`, `dashboard-data/` — НИКОГДА не коммитить
  (уже в .gitignore; при добавлении новых секретов дополняй .gitignore).
- `safe_path()` / `safePath()` обязательны для любых путей от клиента.
- Панель: токены сравниваются через sha256 + timingSafeEqual (не
  сравнивай токены напрямую — утекает длина), cookie — HMAC-подписанная,
  HttpOnly + Secure + SameSite=Lax, security-заголовки на HTML-ответах.
- Контейнеры работают не от root (uid 1000). Панель монтирует проекты
  read-only; писать в /config может только панель, mcp читает ro.
- `run_command` выполняет произвольный shell внутри контейнера — это
  осознанная мощь инструмента; не выноси его за пределы контейнера.
- Порты наружу: только 80/443 (Caddy). 8000/8001 не публиковать.

## Deployment

- Деплой = пуш в main -> GitHub Actions (matrix: mcp + dashboard) ->
  GHCR -> на сервере `cd ~/mcp-server && docker compose pull && docker compose up -d`.
- Первая установка на чистый сервер: только `install.sh` (он ставит
  Docker, UFW, качает инфра-файлы из main, генерирует токены).
- GHCR-пакет должен быть public, иначе `docker compose pull` на сервере
  упадёт с 401 — это самая частая проблема.

## PR instructions

- Коммиты на русском или английском, коротко и по делу
  (напр. "dashboard: переписал панель на Bun + TS").
- Перед пушем — все проверки из Testing instructions зелёные.
- Изменил поведение/настройки — обнови README.md и этот файл.

## Частые ловушки

- settings.py и settings.ts — ДВЕ реализации одной логики; меняя одну,
  меняй и вторую.
- Путь MCP-эндпоинта — ровно `/mcp/` (слеш важен).
- Папки данных на хосте должны принадлежать uid 1000 (панель — user
  `bun`, mcp — user `appuser`, оба uid 1000).
- Caddyfile использует {$DOMAIN} — переменная приезжает из .env через
  compose environment; без неё Caddy не стартует.
- Изменил client.ts — пересборка образа обязательна (bun build идёт в
  Dockerfile), локальный `bun run` без `bun build` отдаст заглушку
  вместо client.js.
- GHCR-теги сервисов: `mcp-latest` / `dashboard-latest` — не перепутай
  в docker-compose.yml.
