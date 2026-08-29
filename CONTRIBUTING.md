# Участие в разработке

Спасибо за интерес к NoVate MCP.

## Перед началом

- Для вопроса по эксплуатации используйте GitHub Discussions, если они включены.
- Для подтверждённой ошибки создайте Bug report.
- Для уязвимости следуйте [SECURITY.md](SECURITY.md) и не открывайте публичный Issue.
- Перед крупным изменением сначала согласуйте подход в Issue.

## Локальная разработка

Требования и команды запуска описаны в [AGENTS.md](AGENTS.md). Основные компоненты:

- Python 3.12+ для MCP и backup;
- Bun 1.x для dashboard;
- Docker для проверки образов.

## Обязательные проверки

Перед Pull Request выполните:

```bash
bash -n install.sh
python3 -m py_compile src/server.py src/settings.py src/storage.py src/backup.py
PYTHONPATH=src python3 -m unittest discover -s tests -v
cd src/dashboard && bun build ./index.ts --outdir /tmp/dashcheck --target bun && cd -
python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml'))"
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml'))"
```

Если менялась логика настроек, проверьте обе реализации: `src/settings.py` и `src/dashboard/settings.ts`.

## Pull Request

- Делайте один логический набор изменений на PR.
- Используйте короткие осмысленные коммиты.
- Не добавляйте `.env`, токены, бэкапы и пользовательские данные.
- Обновляйте README и AGENTS.md при изменении поведения, установки или конфигурации.
- Опишите способ проверки и возможные риски.
- Сохраняйте обратную совместимость или явно указывайте breaking changes.
