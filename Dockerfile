FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir fastmcp "fastapi" "uvicorn[standard]"

# Работаем НЕ от root — отдельный пользователь
RUN useradd --create-home appuser \
    && mkdir -p /data \
    && chown -R appuser:appuser /data

COPY server.py dashboard.py ./

USER appuser

EXPOSE 8000 8001

# По умолчанию — MCP-сервер; панель запускается командой из compose
CMD ["python", "server.py"]
