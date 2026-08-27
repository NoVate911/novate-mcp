# AGENTS.md

Инструкции для ИИ-агентов, работающих с этим репозиторием.
Читай этот файл целиком перед любыми изменениями.

## Обзор проекта

**NoVate MCP** — кастомный MCP-сервер, к которому Notion AI подключается
по HTTPS и получает инструменты для работы с VPS: `run_command`,
`write_file`, `read_file`, `list_files`. Плюс веб-панель «NoVate MCP»
для просмотра и скачивания проектов.

Три Docker-контейнера (docker-compose.yml):

- `mcp` — FastMCP-сервер (`src/server.py`), внутренний порт 8000.
  Наружу не торчит; Caddy проксирует на него только путь `/mcp/`.
- `dashboard` — FastAPI-панель (`src/dashboard.py`), внутренний порт 8001.
  Отвечает на всё, что не `/mcp/` и не `/projects/`.
- `caddy` — единственная публичная точка (80/443), авто-HTTPS.

Код на сервер НЕ копируется: GitHub Actions собирает образ в
`ghcr.io/novate911/novate-mcp`, сервер делает `docker compose pull`.

## Структура репозитория

- `src/server.py` — MCP-сервер: инструменты, Bearer-авторизация, `safe_path`.
- `src/dashboard.py` — панель: логин, проекты, файлы, скачивание, настройки.
- `src/settings.py` — единый источник настроек: переопределения панели
  (`/config/overrides.json`) > переменные окружения из `.env` > DEFAULTS.
- `Dockerfile` — один образ для обоих сервисов (команда выбирается в compose).
- `docker-compose.yml`, `Caddyfile`, `.env.example` — инфра-файлы, их
  install.sh скачивает на сервер из ветки main (raw.githubusercontent.com).
- `install.sh` — единственный файл, который загружается на сервер вручную.
- `.github/workflows/build.yml` — сборка и пуш образа в GHCR при пуше в main.

## Setup commands

Локальная разработка (Python 3.12+):

```bash
pip install fastmcp "fastapi" "uvicorn[standard]"

# MCP-сервер локально (stdio не нужен, но нужен токен)
MCP_TOKEN=dev-token python src/server.py          # http://127.0.0.1:8000/mcp/

# Панель локально (нужны токен и существующая папка данных)
MCP_DATA_DIR=/tmp/projects DASH_TOKEN=dev CONFIG_DIR=/tmp/cfg \
  python src/dashboard.py                          # http://127.0.0.1:8001
mkdir -p /tmp/projects /tmp/cfg                    # если папок нет
```

Сборка образа локально (без GitHub Actions):

```bash
docker build -t novate-mcp:dev .
docker run --rm -e MCP_TOKEN=dev -p 8000:8000 novate-mcp:dev
```

## Testing instructions

Тестового фреймворка нет — перед коммитом прогони ровно эти проверки
и убедись, что все зелёные:

```bash
# Синтаксис bash-установщика
bash -n install.sh

# Компиляция всего Python-кода
python3 -m py_compile src/server.py src/dashboard.py src/settings.py

# Валидность YAML
python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml'))"
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml'))"

# Логика приоритетов настроек (env -> panel override -> reset)
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

- Python 3.12, комментарии и докстринги — на русском (проект русскоязычный).
- В `dashboard.py` HTML/CSS хранятся в обычных строковых константах
  (PAGE, CSS), подстановка — через токены вида `@TITLE@` и
  `str.replace(...)`, либо конкатенация. НЕ используй f-strings,
  содержащие литеральные фигурные скобки CSS — это источник багов.
- UI панели: тёмная тема (#0f1117 фон, #7c8aff акцент), русские подписи,
  выделение текста запрещено (user-select: none), кроме input/textarea.
- Бренд: «NoVate MCP» (не «NoVate Panel» и т.п.).

## Как добавить новый MCP-инструмент

1. Функция в `src/server.py` с декоратором `@mcp.tool`, docstring на
   русском — его читает LLM, пиши понятно и с примерами путей.
2. Все файловые пути — ТОЛЬКО через `safe_path()` (защита от `../`).
3. Прогони проверки из раздела Testing.
4. Пуш в main -> Actions -> на сервере `docker compose pull && up -d`.

## Как добавить новую настройку

Нужно трогать четыре места, иначе получится рассинхрон:

1. `.env.example` — новый ключ с комментарием.
2. `src/settings.py` — DEFAULTS.
3. `src/dashboard.py` — список EDITABLE (или INFO_ONLY, если в панели
   настройка только для чтения).
4. `README.md` — таблица настроек.

## Security considerations

- `.env`, `projects/`, `dashboard-data/` — НИКОГДА не коммитить
  (уже в .gitignore; при добавлении новых секретов дополняй .gitignore).
- `safe_path()` обязателен для любых путей от пользователя/LLM.
- Панель: сравнение токенов только через `hmac.compare_digest`,
  cookie — подписанная HMAC, httponly + secure + samesite.
- Контейнеры работают не от root (uid 1000). Панель монтирует проекты
  read-only; писать в /config может только панель, mcp читает ro.
- `run_command` выполняет произвольный shell внутри контейнера — это
  осознанная мощь инструмента; не выноси его за пределы контейнера.
- Порты наружу: только 80/443 (Caddy). 8000/8001 не публиковать.

## Deployment

- Деплой = пуш в main -> GitHub Actions -> GHCR -> на сервере
  `cd ~/mcp-server && docker compose pull && docker compose up -d`.
- Первая установка на чистый сервер: только `install.sh` (он ставит
  Docker, UFW, качает инфра-файлы из main, генерирует токены).
- GHCR-пакет должен быть public, иначе `docker compose pull` на сервере
  упадёт с 401 — это самая частая проблема.

## PR instructions

- Коммиты на русском или английском, коротко и по делу
  (напр. "dashboard: добавил страницу настроек").
- Перед пушем — все проверки из Testing instructions зелёные.
- Изменил поведение/настройки — обнови README.md и этот файл.

## Частые ловушки

- В описаниях инструментов не хардкодь домен — бери из `settings.get("DOMAIN")`.
- Путь MCP-эндпоинта — ровно `/mcp/` (слеш важен, Notion подключается на него).
- Папка данных на хосте должна принадлежать uid 1000, иначе контейнер
  не сможет писать (install.sh делает chown, учитывай это в новых папках).
- Caddyfile использует {$DOMAIN} — переменная приезжает из .env через
  compose environment; без неё Caddy не стартует.
