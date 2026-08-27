FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir fastmcp

# Работаем НЕ от root — отдельный пользователь
RUN useradd --create-home appuser \
    && mkdir -p /data \
    && chown -R appuser:appuser /data

COPY server.py .

USER appuser

EXPOSE 8000

CMD ["python", "server.py"]
