# Два образа из одного Dockerfile (target = сервис).
# GitHub Actions собирает оба (matrix), на сервере — только pull.

# ===== MCP-сервер (Python + FastMCP) =====
FROM python:3.12-slim AS mcp

WORKDIR /app

RUN pip install --no-cache-dir fastmcp

# Работаем НЕ от root — отдельный пользователь
RUN useradd --create-home appuser \
    && mkdir -p /data /config \
    && chown -R appuser:appuser /data /config

COPY src/server.py src/settings.py ./

USER appuser

EXPOSE 8000

CMD ["python", "server.py"]


# ===== Панель «NoVate MCP» (TypeScript + Bun) =====
FROM oven/bun:1 AS dashboard

WORKDIR /app

COPY src/dashboard/ ./

# Клиентский JS: TS -> минифицированный бандл (единственный build-шаг)
RUN bun build ./client.ts --outdir ./public --minify \
    && mkdir -p /data /config \
    && chown -R bun:bun /data /config

USER bun

EXPOSE 8001

CMD ["bun", "index.ts"]
