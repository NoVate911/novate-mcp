# MCP-сервер для Notion AI (FastMCP + Docker + Caddy)

Сервер с инструментами run_command / write_file / read_file / list_files.
Notion AI подключается по адресу https://DOMAIN/mcp/
Всё, что ИИ создаст, видно в браузере на https://DOMAIN/sites/...

## Установка с нуля — ОДИН файл

Нужен только install.sh — он содержит все остальные файлы внутри себя.

1. Подготовь DNS: A-запись домена -> IP сервера.
2. Загрузи install.sh на сервер (scp / SFTP), в любое место.
3. На сервере:  bash install.sh

   Скрипт сам: обновит систему, поставит Docker, настроит UFW,
   создаст проект в ~/mcp-server, сгенерирует токен и всё запустит.

4. Сохрани токен, который покажет скрипт (он также в ~/mcp-server/.env).
5. Проверка: curl -i https://ДОМЕН/mcp/  (ожидается 401 Unauthorized)

Если в конце появится просьба перезагрузки — выполни reboot,
контейнеры поднимутся автоматически.

## Настройки (.env)

Все важные настройки лежат в одном файле ~/mcp-server/.env:

| Ключ       | Что делает                                                          |
|------------|---------------------------------------------------------------------|
| MCP_TOKEN  | Секретный токен доступа (Bearer). Генерируется install.sh           |
| DOMAIN     | Домен сервера, без https:// — например novate-gpt.space             |
| SITES_DIR  | Папка на сервере, к которой у MCP есть доступ. Только она одна      |

Доступ ограничен: файловые инструменты не могут выйти за пределы SITES_DIR
(защита от ../ в коде), а контейнер в принципе видит из хостовой системы
только эту папку — она смонтирована как volume. Остальная ФС внутри
контейнера — это сам образ, а не твой сервер.

## Поведение при повторном запуске install.sh

- .env НЕ перезаписывается (токен и настройки сохраняются;
  недостающие ключи дописываются).
- Файлы кода (server.py, Dockerfile, docker-compose.yml, Caddyfile)
  приводятся к эталонным версиям из скрипта.
- Если правил код под себя — обновляйся без install.sh:
  cd ~/mcp-server && docker compose up -d --build

## Подключение в Notion

- URL: https://ДОМЕН/mcp/
- Аутентификация: Bearer Token = MCP_TOKEN из .env
- Если не подключается со слэшем — попробуй без: https://ДОМЕН/mcp
- Требуется тариф Business/Enterprise и включённые Custom MCP servers
  в Settings → Notion AI → AI connectors

## Полезные команды

cd ~/mcp-server
docker compose ps                 # статус
docker compose logs -f mcp        # логи MCP-сервера
docker compose restart            # перезапуск
docker compose up -d --build      # пересборка после правок кода
docker compose down               # остановить всё

Смена токена: поменяй MCP_TOKEN в .env → docker compose up -d
→ обнови токен в подключении Notion.
