# AGENTS.md

Инструкции для ИИ-агентов, работающих с этим репозиторием.
Читай этот файл целиком перед любыми изменениями.

## Обзор проекта

**NoVate MCP** — кастомный MCP-сервер: MCP-клиенты (ИИ-агенты)
подключаются по HTTPS и получают инструменты для работы с VPS:
`run_command`, `write_file`, `read_file`, `list_files`,
`search_in_files`, `delete_file`, `move_file`, `server_stats`,
`run_background`/`poll_task`, `make_backup`.
Плюс веб-панель «NoVate MCP» для просмотра и скачивания проектов,
загрузки проверенных локальных бэкапов и тост-уведомлений
(вход через Telegram OpenID Connect), а также фоновый сервис бэкапов,
который архивирует проекты и отправляет архив в Telegram.

Четыре Docker-контейнера (docker-compose.yml):

- `mcp` — FastMCP-сервер (`src/server.py`, Python), внутренний порт 8000.
  Наружу не торчит; Caddy проксирует на него только путь `/mcp/`.
- `dashboard` — панель на **Bun + TypeScript** (`src/dashboard/`),
  внутренний порт 8001. Отвечает на всё, что не `/mcp/` и не `/projects/`.
- `backup` — сервис бэкапов (`src/backup.py`, Python stdlib + openssl CLI):
  по расписанию или по файлу-триггеру от панели собирает tar.gz в `/backups`,
  шлёт в Telegram через Bot API, при BACKUP_PASSWORD шифрует (AES-256, .enc)
  и по запросу панели восстанавливает проекты из архива (перед этим делает
  страховочный бэкап). Сетевых портов нет.
- `caddy` — единственная публичная точка (80/443), авто-HTTPS.

Код на сервер НЕ копируется: GitHub Actions собирает ТРИ образа
из одного multi-stage Dockerfile (target: `mcp` / `dashboard` / `backup`)
в один GHCR-пакет `ghcr.io/novate911/novate-mcp` с тегами `mcp-latest`,
`dashboard-latest` и `backup-latest`. Сервер делает `docker compose pull`.

## Структура репозитория

- `src/server.py` — MCP-сервер: инструменты, Bearer-авторизация, `safe_path`.
- `src/settings.py` — настройки (Python): overrides.json > .env > дефолты.
  Используется и mcp, и backup.
- `src/storage.py` — storage-слой MCP: LocalStorage/S3Storage, boto3,
  delta-sync shell-команд, безопасный startup merge и исключения.
- `src/backup.py` — сервис бэкапов: расписание/триггер, tar.gz, AES-256
  (openssl CLI), восстановление, Telegram Bot API, статус в last-backup.json.
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
pip install fastmcp boto3
MCP_TOKEN=dev-token S3_ENABLED=false python src/server.py          # http://127.0.0.1:8000/mcp/
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
  TG_BOT_TOKEN=... TG_CHAT_ID=... python src/backup.py
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
python3 -m py_compile src/server.py src/settings.py src/storage.py src/backup.py

# Storage + MCP integration tests (реальный S3 не нужен — используется FakeS3)
PYTHONPATH=src python3 -m unittest discover -s tests -v

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

## S3 storage

- `/data` всегда остаётся обычной POSIX FS на bind mount `PROJECTS_DIR`.
  S3/FUSE/s3fs/rclone mount запрещены; S3 — только постоянная копия через API.
- Все детали S3 находятся в `src/storage.py`; публичные MCP tool names и параметры
  не меняются. `S3_ENABLED=false` обязан сохранять прежнее локальное поведение.
- S3-параметры startup-only и читаются напрямую из `.env`, не из overrides.json.
  Dashboard показывает только read-only статус; secret key никогда не выводится,
  access key маскируется. Изменение требует `docker compose up -d`.
- `write_file` синхронизирует один файл; delete — object/prefix; move — Copy+Delete.
  `run_command` и `run_background` сравнивают metadata snapshot и передают только delta.
- `/tmp/mcp-tasks`, `node_modules`, `.git`, `.cache`, tmp, логи, pycache и служебные
  триггеры не синхронизируются. Пользовательские исключения добавляет `S3_EXCLUDE`.
- Startup merge не удаляет и не перезаписывает существующие локальные файлы:
  скачивает отсутствующие из S3, загружает локальные и при конфликте выбирает
  локальную версию (это восстанавливает S3 после ранее неудачного PUT).
- Перед обязательной S3-операцией записывай desired state в постоянный outbox
  `/storage-state/s3-state.json`; успешная операция удаляет запись, ошибка получает
  exponential backoff. Не обходи outbox в новых mutation points.
- Maintenance worker повторяет outbox и раз в `S3_RECONCILE_INTERVAL` сверяет
  manifest, `/data` и S3. Dashboard-команды читает из `/config/s3-action.json`.
- `/storage-state/status.json` — единственный UI-контракт статуса; он не содержит
  credentials. Docker volume `storage_state` монтируется MCP rw, dashboard ro и не доступен Caddy.
- Любая обязательная ошибка S3 должна быть явно возвращена; secret key не логировать.
  Boto3 dependency есть только в MCP image. Backup остаётся stdlib-only.
- После restore backup пишет `/data/.s3-sync-needed`; MCP watcher синхронизирует delta.
  S3 и tar.gz backup — независимые механизмы.

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

Исключение: чисто инфра/startup-переменные окружения, которые не поддерживают
runtime override (`TZ`, `S3_*`): `.env.example`, README и read-only статус панели.
S3 credentials намеренно не добавляются в EDITABLE или overrides.json.

## Telegram OIDC: устройство и отладка

Вход в панель — manual Authorization Code Flow против oauth.telegram.org.
Эндпоинты (сверены с /.well-known/openid-configuration):
`/auth` → редирект с `code` → POST `/token` (Basic auth + PKCE) →
`id_token` (JWT), подпись проверяется по JWKS.

Креды и URL настраиваются в **мини-приложении @BotFather** (кнопка «Open»
в чате с ним, НЕ текстовые команды): выбрать бота → **Bot Settings →
Web Login**. Там выдаются Client ID + Client Secret (парой!) и там же
**Allowed URLs**: нужно добавить ОБА адреса — origin `https://DOMAIN`
и callback `https://DOMAIN/auth/callback`. Client Secret — это НЕ токен
бота (токен бота Telegram в роли client secret отклоняет).

Коды ошибок панели (`/login?err=...`) и их причины:

- `state` — state-cookie просрочена (TTL 10 мин) или не сошлась.
  Лечится просто повторным входом со страницы /login.
- `exchange` — не удался обмен кода на токен. Точная причина — в логах
  (`docker compose logs dashboard`): **Telegram отвечает HTTP 200 даже на
  ошибки**, тело вида `{"error":"..."}`:
  - `invalid_client` — неверная пара Client ID/Client Secret: секрет не
    из раздела Web Login, перевыпущен, или застрявший OIDC-конфиг бота
    (известный баг BotFather, tdlib/telegram-bot-api#836 — лечится
    созданием НОВОГО бота и переносом Web Login на него).
  - `invalid_grant` — код просрочен или уже использован (код одноразовый:
    нельзя обновлять страницу /auth/callback?code=...), реже — расхождение
    PKCE или redirect_uri.
- `verify` — id_token не прошёл проверку (подпись/iss/aud/exp) — деталь
  в логах.
- `denied` — Telegram ID не в ALLOWED_TG_USERS; сам ID написан в логах
  панели — так и наполняется список разрешённых.

Технические особенности реализации (важно при правках auth-кода):

- Token-эндпоинт: проверять поле `error` в JSON, а НЕ HTTP-статус (см. выше).
- `aud` и `sub` в id_token могут приходить ЧИСЛАМИ (Client ID числовой) —
  приводить к строке перед сравнением с TG_CLIENT_ID / ALLOWED_TG_USERS.
- base64url собирается вручную из base64 (replace `+/=`) — не полагаться
  на `digest("base64url")` / `toString("base64url")` рантайма.
- JWKS кэшируются в памяти на 1 час; если kid из JWT не найден и ключ
  в наборе один — берётся он.
- Сессия — аутентифицированная AES-256-GCM cookie (ключ из SESSION_SECRET через scrypt): uid + name + ts.
  Allowlist ALLOWED_TG_USERS проверяется на КАЖДЫЙ запрос.

## Security considerations

- `.env`, `projects/`, `dashboard-data/`, `backups/` — НИКОГДА не коммитить
  (уже в .gitignore; при добавлении новых секретов дополняй .gitignore).
- `safe_path()` / `safePath()` обязательны для любых путей от клиента.
- Панель: вход только через Telegram OIDC — PKCE (S256), одноразовый state
  в подписанной cookie (10 минут), подпись id_token проверяется по JWKS
  Telegram, проверяются iss/aud/exp. Доступ — только у ID из
  ALLOWED_TG_USERS; allowlist проверяется на КАЖДЫЙ запрос.
- Сессионная cookie — зашифрованная и аутентифицированная AES-256-GCM (ключ из SESSION_SECRET через scrypt),
  HttpOnly + Secure + SameSite=Lax, TTL 7 дней; подписи сравниваются через
  scrypt-derived AES-256-GCM key; целостность проверяет GCM authentication tag (не заменяй это прямым сравнением или быстрым password hash).
- Бэкапы содержат overrides.json — там могут лежать переопределённые
  секреты. Чат TG_CHAT_ID и папка backups/ = хранилища секретов.
- Контейнеры работают не от root (uid 1000). Панель монтирует проекты
  read-only; backup монтирует проекты в rw (нужно для восстановления —
  запускается только из авторизованной панели, перед восстановлением
  делается страховочный бэкап), /config read-only, пишет в /backups;
  писать в /config может только панель, mcp читает ro.
- Панель и backup шлют алерты в Telegram (TG_BOT_TOKEN → TG_CHAT_ID):
  входы, отклонённые попытки, смена настроек (только имя ключа, без
  значения), восстановления, сбои бэкапов.
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
- Изменения в .env применяются ТОЛЬКО пересозданием контейнера:
  `docker compose up -d` (compose сам увидит изменение env_file).
  `docker compose restart` НЕ перечитывает .env! Исключение: новый MCP_TOKEN,
  сохранённый панелью в overrides.json, MCP-процесс замечает и применяет через re-exec.
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
  из мини-приложения @BotFather (Web Login) и ALLOWED_TG_USERS; Allowed URLs
  у бота должны содержать и origin, и /auth/callback — иначе Telegram не
  примет redirect_uri (подробности в разделе «Telegram OIDC»).
- Кнопка «Сделать бэкап сейчас» в панели создаёт файл /config/backup-now —
  сервис backup следит за его mtime, не удаляй эту связку.
- Восстановление — через /config/restore-now: панель пишет туда ИМЯ архива,
  backup следит за парой (имя, mtime); старые триггеры при рестарте не
  выполняются. Имя валидируется регэкспом и там, и там.
- Шифрование бэкапов — через openssl CLI, он уже есть в python:3.12-slim,
  ничего доустанавливать в образ не надо.
- Фоновые задачи (run_background/poll_task): логи в /tmp/mcp-tasks контейнера
  mcp — эфемерны (перезапуск чистит) и нарочно вне /data, чтобы не попадать
  на публичный /projects/ и в бэкапы.
- make_backup пишет триггер /data/.backup-now; backup следит за ОБОИМИ
  триггерами (/config/backup-now от панели и этот). /config для mcp остаётся
  read-only — иначе MCP мог бы переписать overrides.json (эскалация в панель).
- Время внутри контейнеров: TZ из .env + /etc/localtime (смонтирован ro).
  Помни: `docker compose restart` НЕ перечитывает .env — нужен `up -d`.
- Проверить, что значение из .env реально доехало до контейнера:
  `grep '^KEY=' .env | cut -d= -f2- | tr -d '\n' | sha256sum` и
  `docker compose exec <service> sh -c 'printf %s "$KEY"' | sha256sum` —
  хэши должны совпасть (без `tr -d` хэш от файла будет с переводом строки
  и НЕ совпадёт — это не признак проблемы).
- Изменил client.ts — пересборка образа обязательна (bun build идёт в
  Dockerfile), локальный `bun run` без `bun build` отдаст заглушку
  вместо client.js.
- Панель использует `tar` для временных архивов проектов и проверки бэкапов,
  а `openssl` — для проверки загружаемых `.enc`; оба пакета ставятся в
  dashboard-stage Dockerfile. Временные файлы держи только в `/tmp` и удаляй.
- Панель монтирует `/backups` на запись только для уже проверенных загрузок.
  Никогда не сохраняй загруженный архив до полной проверки имени, структуры,
  путей и типов файлов. Лимит загрузки — 512 МБ.
- Кнопка «Открыть сайт» показывается только если в корне проекта есть
  обычный файл `index.html`. Скачивание проектов и папок потоковое в формате ZIP:
  `zip -r -1 -q -` пишет прямо в HTTP-ответ. ZIP выбран ради корректных размеров,
  быстрого открытия и нативного извлечения в Windows; временный файл не создаётся.
- Краткие сообщения об успехах и ошибках показывай через `toast()` из ui.ts;
  `.note` оставляй для постоянного статуса и подтверждений.
- Обычные настройки в панели показывают эффективное значение только в input: их
  можно дополнять, менять и очищать. Не дублируй значение отдельным текстом.
  Бейдж источника `.env` / `панель` располагается рядом с названием параметра.
  Пустая строка в overrides.json — осознанное переопределение, а не fallback к .env;
  settings.py и settings.ts синхронны.
- Локально генерируются только MCP_TOKEN, SESSION_SECRET и BACKUP_PASSWORD.
  TG_CLIENT_SECRET и TG_BOT_TOKEN выдаёт Telegram — оставляй ручную замену.
  Сгенерированный секрет показывается один раз в постоянном тосте для копирования.
- Не монтируй Docker socket в dashboard ради рестартов: это root-доступ к хосту.
  MCP_TOKEN применяется наблюдателем в server.py через безопасный re-exec процесса.
- PROJECTS_DIR нужен settings/install/compose, но не должен отображаться в панели:
  это Docker-монтирование, которое нельзя менять во время работы.
- Поиск и фильтры работают на клиенте по `data-filter-*`: сервер добавляет
  нормализованное имя, тип, mtime, размер и число файлов, client.ts фильтрует
  и сортирует без запросов и перезагрузки. `client.js` отдаётся с `no-store` и
  version query, чтобы старый бандл не ломал realtime. В таблице всегда показывай
  mtime и рекурсивный размер папок; папки скачиваются потоковым ZIP.
- Все тосты обязаны закрываться: обычные через 5 секунд, тост с новым секретом
  через 15 секунд. Постоянные тосты без таймера запрещены.
- Загрузка бэкапа использует одну кнопку-label со скрытым file input; после выбора
  `client.ts` сразу вызывает `requestSubmit()`. Не добавляй отдельную submit-кнопку.
- В карточке проекта размер показывается только в метаданных, не дублируется возле действий.
- Настройки разделены на клиентские вкладки Telegram, Доступ и безопасность,
  Бэкапы. Категория задаётся `EditableSetting.section`; после save/reset/generate
  сервер возвращает пользователя на вкладку изменённого параметра.
- DOMAIN, как и PROJECTS_DIR, не показывается в настройках панели: DOMAIN меняется
  только через `.env` + `install.sh`, поскольку связан с Caddy и Telegram callback.
- Telegram-уведомления используют HTML parse mode, визуальные заголовки и переносы.
  Все динамические значения обязательно экранируй через `tgEsc()` / `html.escape()`.
- UI использует Manrope, а технические значения — JetBrains Mono через Google Fonts
  с системными fallback-шрифтами. Все form controls наследуют основной шрифт.
- S3_ENABLED=true требует S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET и
  S3_REGION. Endpoint для Reg.Ru бери из панели «Хранилище S3 → Ключи доступа»;
  обычно это https://s3.regru.cloud, но не хардкодь его в runtime.
- GHCR-теги сервисов: `mcp-latest` / `dashboard-latest` / `backup-latest` —
  не перепутай в docker-compose.yml.


## Release, CI and health rules

- Формат релиза строго `YY.M.RELEASE.BUILD`: год, месяц, серия релиза и
  трёхзначная сборка. Пример: `26.8.1.001`. После `999` увеличивай RELEASE и
  начинай BUILD с `001`.
- Push тега релиза публикует `mcp-<version>`, `dashboard-<version>` и
  `backup-<version>`. Push в main публикует только соответствующие `*-latest`.
- `NOVATE_VERSION` в `.env` выбирает единый суффикс всех трёх образов; по
  умолчанию `latest`. Не смешивай версии сервисов без отдельного обоснования.
- Перед PR обязательны Python tests, `py_compile`, `bash -n`, YAML/Compose,
  `bun run typecheck` и `bun run build` из `src/dashboard`.
- Security workflow использует Gitleaks и Trivy; не ослабляй HIGH/CRITICAL
  enforcement без документированного исключения.
- MCP и dashboard healthchecks проверяют локальные порты. MCP start-period —
  минимум 5 минут из-за возможного долгого S3 startup merge. Backup healthcheck
  читает `/backups/.backup-heartbeat.json`; heartbeat обновляется каждый цикл.
- Никогда не блокируй запуск Caddy условием `service_healthy`: сбой или прогрев
  одного backend не должен отключать панель, публичные проекты и остальные маршруты.
- Просроченным считается бэкап старше `BACKUP_STALE_AFTER_HOURS`, а если
  переменная пуста — старше max(2 интервала, интервал + 1 час). Telegram-alert
  отправляется один раз до следующей успешной копии.
- E2E-тесты бэкапа обязаны проверять обычный и AES-256 round trip, включая
  автоматический pre-restore snapshot.
- Все пользовательские изменения фиксируй в секции Unreleased CHANGELOG.md.
