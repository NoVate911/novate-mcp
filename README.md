# novate-mcp — MCP-сервер для Notion AI

FastMCP + FastAPI + Docker + Caddy + GitHub Actions (GHCR).

- Notion AI подключается к MCP: `https://ДОМЕН/mcp/`
- Панель управления проектами: `https://ДОМЕН/` (вход по DASH_TOKEN)
- Публичный просмотр проектов: `https://ДОМЕН/projects/<имя>/`

## Архитектура

Код НЕ копируется на сервер. GitHub Actions собирает Docker-образ
и публикует его в GHCR (`ghcr.io/novate911/novate-mcp`).
Сервер скачивает готовый образ: `docker compose pull`.

Три контейнера:
- mcp — FastMCP-сервер (инструменты для Notion AI), порт 8000, внутренний
- dashboard — защищённая панель управления, порт 8001, внутренний
- caddy — единственная наружная точка (80/443), HTTPS автоматически

## Одноразовая настройка репозитория

1. Запушь в репозиторий все файлы проекта, включая
   `.github/workflows/build.yml` (это и есть GitHub Action).
2. После пуша открой вкладку Actions и дождись зелёной галочки
   (образ собран и опубликован в GHCR).
3. Сделай пакет публичным, иначе сервер не сможет его скачать:
   GitHub -> профиль -> Packages -> novate-mcp -> Package settings ->
   Change visibility -> Public.
   (альтернатива: на сервере `docker login ghcr.io -u NoVate911 -p <GITHUB_TOKEN>`)

## Установка на сервер (Ubuntu 24.04)

1. DNS: A-запись домена -> IP сервера.
2. Загрузи на сервер только install.sh.
3. `bash install.sh`

   Скрипт: обновит систему, поставит Docker, настроит UFW, скачает
   из репозитория docker-compose.yml / Caddyfile / .env.example,
   создаст .env с двумя токенами (MCP_TOKEN и DASH_TOKEN),
   сделает docker compose pull и запустит контейнеры.

4. Проверки:
   - `curl -i https://ДОМЕН/mcp/` -> 401 Unauthorized
   - `https://ДОМЕН/` -> страница входа панели (логин = DASH_TOKEN)

## Панель управления

`https://ДОМЕН/` — вход по DASH_TOKEN (cookie живёт 7 дней).
Внутри: статистика (число проектов и файлов, занято/свободно на диске,
аптайм сервера), карточки проектов с размером и датой изменения,
просмотр содержимого папок и скачивание любого файла кнопкой «Скачать».
Панель видит папку проектов в режиме только-чтение: изменять файлы
может только MCP.

ВАЖНО: всё в папке projects/ публично доступно по ссылкам
`https://ДОМЕН/projects/...` (это нужно для просмотра созданных сайтов).
Панель при этом защищена токеном.

## Обновление

1. Правишь код -> пушишь в main -> Actions собирает новый образ.
2. На сервере:
   cd ~/mcp-server && docker compose pull && docker compose up -d

## Настройки (.env на сервере, в git не попадает)

| Ключ          | Что делает                                        |
|---------------|---------------------------------------------------|
| MCP_TOKEN     | Bearer-токен для подключения Notion               |
| DASH_TOKEN    | Токен входа в панель управления                   |
| DOMAIN        | Домен сервера, без https://                       |
| PROJECTS_DIR  | Папка проектов; только она доступна MCP           |

## Полезные команды (на сервере)

cd ~/mcp-server
docker compose ps
docker compose logs -f mcp          # логи MCP
docker compose logs -f dashboard    # логи панели
docker compose pull && docker compose up -d   # обновление
docker compose down
