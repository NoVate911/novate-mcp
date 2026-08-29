# Три образа из одного Dockerfile (target = сервис).
# GitHub Actions собирает все (matrix), на сервере — только pull.

# ===== MCP-сервер (Python + FastMCP) =====
FROM python:3.12-slim AS mcp

WORKDIR /app

RUN pip install --no-cache-dir fastmcp boto3

# Работаем НЕ от root — отдельный пользователь
RUN useradd --create-home appuser \
    && mkdir -p /data /config /storage-state \
    && chown -R appuser:appuser /data /config /storage-state

COPY src/server.py src/settings.py src/storage.py ./

USER appuser

EXPOSE 8000

CMD ["python", "server.py"]


# ===== Панель «NoVate MCP» (TypeScript + Bun) =====
FROM oven/bun:1 AS dashboard

WORKDIR /app

# ZIP-скачивание проектов и проверка/расшифровка загружаемых бэкапов
RUN apt-get update \
    && apt-get install -y --no-install-recommends zip tar openssl \
    && rm -rf /var/lib/apt/lists/*

COPY src/dashboard/ ./

# Клиентский JS: TS -> минифицированный бандл (единственный build-шаг)
RUN bun build ./client.ts --outdir ./public --minify \
    && mkdir -p /data /config /backups /storage-state \
    && chown -R bun:bun /data /config /backups /storage-state

USER bun

EXPOSE 8001

CMD ["bun", "index.ts"]


# ===== Сервис бэкапов (Python, только stdlib) =====
FROM python:3.12-slim AS backup

WORKDIR /app

# Работаем НЕ от root — отдельный пользователь
RUN useradd --create-home appuser \
    && mkdir -p /data /config /backups \
    && chown -R appuser:appuser /data /config /backups

COPY src/backup.py src/settings.py ./

USER appuser

CMD ["python", "backup.py"]
