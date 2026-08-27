# novate-mcp — MCP-сервер для Notion AI

FastMCP + FastAPI + Docker + Caddy + GitHub Actions (GHCR).

- Notion AI подключается к MCP: `https://ДОМЕН/mcp/`
- Панель управления «NoVate MCP»: `https://ДОМЕН/` (вход по DASH_TOKEN)
- Публичный просмотр проектов: `https://ДОМЕН/projects/<имя>/`

## Структура репозитория

    ├── .github/workflows/build.yml   # GitHub Action: сборка образа в GHCR
    ├── src/
    │   ├── server.py                 # MCP-сервер (инструменты для Notion AI)
    │   ├── dashboard.py              # Панель управления (веб)
    │   └── settings.py               # Общий модуль настроек (.env + overrides)
    ├── Dockerfile                    # Один образ для обоих сервисов
    ├── docker-compose.yml            # Инфраструктура (уезжает на сервер)
    ├── Caddyfile                     # Маршруты + HTTPS (уезжает на сервер)
    ├── .env.example                  # Шаблон настроек (уезжает на сервер)
    ├── .gitignore
    ├── install.sh                    # Установщик (единственный файл для сервера)
    └── README.md

## Архитектура

Код НЕ копируется на сервер. GitHub Actions собирает Docker-образ
и публикует его в GHCR (`ghcr.io/novate911/novate-mcp`).
Сервер скачивает готовый образ: `docker compose pull`.

Три контейнера:
- mcp — FastMCP-сервер, внутренний порт 8000
- dashboard — защищённая панель «NoVate MCP», внутренний порт 8001
- caddy — единственная наружная точка (80/443), HTTPS автоматически

## Настройки и их приоритет

Источники значений (по приоритету):
1. Панель (переопределения, хранятся в dashboard-data/overrides.json)
2. .env на сервере — значения по умолчанию (главный источник)

На странице «Настройки» в панели видно каждое значение и его источник
(бейдж «панель» или «.env»). «По умолчанию» удаляет переопределение.

| Ключ          | Где применяется                                                  |
|---------------|------------------------------------------------------------------|
| DASH_TOKEN    | Вход в панель; переопределение действует сразу                   |
| MCP_TOKEN     | Bearer-токен Notion; после смены: docker compose restart mcp     |
| DOMAIN        | Ссылки в панели — сразу; MCP — после restart; HTTPS-домен Caddy  |
|               | меняется только через .env + install.sh                          |
| PROJECTS_DIR  | Только .env + install.sh (монтирование Docker, в панели read-only)|

## Одноразовая настройка репозитория

1. Запушь все файлы, включая `.github/workflows/build.yml`.
2. Вкладка Actions -> дождись зелёной галочки (образ в GHCR).
3. Сделай пакет публичным: GitHub -> Packages -> novate-mcp ->
   Package settings -> Change visibility -> Public.
   (альтернатива: `docker login ghcr.io -u NoVate911 -p <TOKEN>` на сервере)

## Установка на сервер (Ubuntu 24.04)

1. DNS: A-запись домена -> IP сервера.
2. Загрузи на сервер только install.sh.
3. `bash install.sh`
4. Проверки:
   - `curl -i https://ДОМЕН/mcp/` -> 401 Unauthorized
   - `https://ДОМЕН/` -> страница входа панели

## Обновление

1. Правишь код -> пушишь в main -> Actions собирает новый образ.
2. На сервере:  cd ~/mcp-server && docker compose pull && docker compose up -d

## Полезные команды (на сервере)

cd ~/mcp-server
docker compose ps
docker compose logs -f mcp          # логи MCP
docker compose logs -f dashboard    # логи панели
docker compose pull && docker compose up -d   # обновление
docker compose down
