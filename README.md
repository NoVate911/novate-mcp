<div align="center">

# 🚀 NoVate MCP

**Собственный MCP-сервер для Notion AI на твоём VPS.**
Notion AI получает инструменты для выполнения команд и работы с файлами
на сервере, а ты — красивую веб-панель для управления проектами.

[![Build](https://github.com/NoVate911/novate-mcp/actions/workflows/build.yml/badge.svg)](https://github.com/NoVate911/novate-mcp/actions/workflows/build.yml)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![FastMCP](https://img.shields.io/badge/FastMCP-2.x-6e56cf)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Caddy](https://img.shields.io/badge/Caddy-2-1F88C0)

</div>

---

## ✨ Возможности

- 🤖 **4 инструмента для Notion AI** — `run_command`, `write_file`, `read_file`, `list_files`
- 📊 **Панель «NoVate MCP»** — статистика сервера, проекты, просмотр и скачивание файлов прямо в браузере
- ⚙️ **Настройки из панели** — переопределение значений из `.env` с кнопкой возврата к дефолту
- 🔐 **Безопасность по кругу** — Bearer-токен для MCP, HMAC-логин для панели, изоляция папки, контейнеры не от root
- 🌍 **Публичные сайты** — всё, что ИИ создаст в проекте, сразу открывается по ссылке
- 🔄 **CI/CD из коробки** — пуш в `main` → GitHub Actions → GHCR → `docker compose pull` на сервере

## 🏗 Архитектура

```
Notion AI ──HTTPS + Bearer──┐
                            ▼
                    novate-gpt.space (Caddy, авто-HTTPS)
                            │
            ┌───────────────┼─────────────────┐
            ▼               ▼                 ▼
         /mcp/          /projects/            /
            │               │                 │
            ▼               ▼                 ▼
      mcp:8000      статика проектов   dashboard:8001
      (FastMCP,     (публичный          (панель, вход по
       4 инстр.)     просмотр сайтов)    DASH_TOKEN)
                            │
                            ▼
                  ./projects на сервере —
                  единственная папка, доступная MCP
```

## 📁 Структура проекта

| Путь | Назначение |
|---|---|
| `src/server.py` | MCP-сервер: инструменты, Bearer-авторизация, защита путей |
| `src/dashboard.py` | Веб-панель: логин, проекты, файлы, настройки |
| `src/settings.py` | Настройки: переопределения панели → `.env` → дефолты |
| `Dockerfile` | Один образ для обоих сервисов |
| `docker-compose.yml` | Три контейнера: mcp, dashboard, caddy |
| `Caddyfile` | Маршруты `/mcp/`, `/projects/`, `/` + HTTPS |
| `.env.example` | Шаблон всех настроек |
| `install.sh` | Полный установщик: система, Docker, UFW, токены, запуск |
| `.github/workflows/build.yml` | GitHub Action: сборка образа в GHCR |
| `AGENTS.md` | Инструкции для ИИ-агентов |

## 🚀 Быстрый старт

### Шаг 1. Подготовь репозиторий (один раз)

1. Запушь все файлы в репозиторий, включая `.github/workflows/build.yml`.
2. Вкладка **Actions** → дождись зелёной галочки ✅ (образ собран в GHCR).
3. **Сделай пакет публичным** (по умолчанию GHCR-пакеты приватные!):
   GitHub → Packages → `novate-mcp` → Package settings → Change visibility → **Public**.

### Шаг 2. Сервер (Ubuntu 24.04)

Нужны: VPS, домен с A-записью на IP сервера, доступ по SSH.

```bash
# Загрузи install.sh на сервер, затем:
bash install.sh
```

Скрипт сам: обновит систему → поставит Docker → настроит UFW →
скачает инфра-файлы из репозитория → сгенерирует токены →
сделает `docker compose pull` → запустит всё.

### Шаг 3. Проверка

```bash
curl -i https://ДОМЕН/mcp/      # ожидается: 401 Unauthorized
```

- `https://ДОМЕН/` — страница входа панели (логин = `DASH_TOKEN` из `~/mcp-server/.env`)
- `https://ДОМЕН/projects/` — публичный просмотр проектов

### Шаг 4. Подключение Notion

В Notion: подключение MCP-сервера с параметрами:

| Параметр | Значение |
|---|---|
| URL | `https://ДОМЕН/mcp/` |
| Аутентификация | Bearer Token |
| Токен | `MCP_TOKEN` из `~/mcp-server/.env` |

> ⚠️ Требуется тариф Notion **Business/Enterprise** и включённые
> Custom MCP servers в Settings → Notion AI → AI connectors.

## 📊 Панель управления

Вход по `DASH_TOKEN` (подписанная cookie живёт 7 дней):

- **Проекты** — карточки с размером, числом файлов, датой изменения,
  кнопка «открыть сайт ↗» на публичную страницу.
- **Файлы** — навигация по папкам, скачивание любого файла.
- **Статистика** — проектов/файлов, занято и свободно на диске, аптайм.
- **Настройки** — переопределение значений из `.env` (см. ниже).

Панель монтирует проекты в режиме **только чтение**: изменять файлы
может только MCP через Notion AI.

## ⚙️ Настройки

Все значения живут в `.env` на сервере (не коммитится!).
Приоритет: **переопределение в панели** > **`.env`** (значения по умолчанию).

| Ключ | Назначение | Смена из панели |
|---|---|---|
| `MCP_TOKEN` | Bearer-токен для Notion | ✅ + `docker compose restart mcp`, затем новый токен в Notion |
| `DASH_TOKEN` | Токен входа в панель | ✅ применяется сразу |
| `DOMAIN` | Домен сервера | ✅ для ссылок; HTTPS-домен Caddy — только через `.env` + install.sh |
| `PROJECTS_DIR` | Папка проектов | 👀 только просмотр (это монтирование Docker) |

Кнопка **«По умолчанию»** в панели удаляет переопределение —
снова действует значение из `.env`.

## 🔐 Безопасность

- MCP отвергает запросы без токена (проверка: `curl` выше отдаёт 401).
- Все файловые операции ограничены папкой проектов — защита от `../` в коде
  + Docker-монтирование только этой папки.
- `run_command` выполняется **внутри контейнера**, а не на хосте.
- Контейнеры работают не от root (uid 1000).
- Наружу открыты только 80/443 (UFW + Caddy); порты 8000/8001 внутренние.
- Всё в `projects/` публично по ссылкам `/projects/...` — это нужно для
  просмотра созданных сайтов. Панель при этом защищена токеном.

## 🔄 Обновление

```bash
# 1. Запушил изменения в main -> Actions собрал новый образ
# 2. На сервере:
cd ~/mcp-server
docker compose pull
docker compose up -d
```

## 🛠 Полезные команды

```bash
cd ~/mcp-server
docker compose ps                    # статус контейнеров
docker compose logs -f mcp           # логи MCP-сервера
docker compose logs -f dashboard     # логи панели
docker compose restart               # перезапуск
docker compose down                  # остановить всё
```

## 🧰 Стек

**FastMCP** · **FastAPI** · **Docker Compose** · **Caddy** · **GitHub Actions** · **GHCR**

---

<div align="center">
Сделано с ❤️ для Notion AI
</div>
