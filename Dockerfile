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

COPY src/server.py src/settings.py src/storage.py src/healthcheck.py ./

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5m --retries=5 \
  CMD ["python", "healthcheck.py", "tcp", "127.0.0.1", "8000"]

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:8001/login');if(!r.ok)process.exit(1)"]

CMD ["bun", "index.ts"]


# ===== Сервис бэкапов (Python, только stdlib) =====
FROM python:3.12-slim AS backup

WORKDIR /app

# Работаем НЕ от root — отдельный пользователь
RUN useradd --create-home appuser \
    && mkdir -p /data /config /backups \
    && chown -R appuser:appuser /data /config /backups

COPY src/backup.py src/settings.py src/healthcheck.py ./

USER appuser

HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
  CMD ["python", "healthcheck.py", "backup", "/backups/.backup-heartbeat.json", "180"]

CMD ["python", "backup.py"]
