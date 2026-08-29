# Changelog

Все заметные изменения проекта фиксируются в этом файле. Формат версий проекта: `YY.M.RELEASE.BUILD`, например `26.8.1.001`.

- `YY` — две цифры года;
- `M` — номер месяца;
- `RELEASE` — серия релиза, увеличивается после сборки `999`;
- `BUILD` — номер сборки из трёх цифр (`001`–`999`).

## [Unreleased]

### Fixed

- `docker compose up` в deploy и rollback теперь запускается без интерактивного stdin, с plain-выводом и жёстким таймаутом `NOVATE_COMPOSE_UP_TIMEOUT`.

- Ожидание после `docker compose up` теперь выводит причины блокировки и оставшееся время; по таймауту выполняется rollback вместо визуального «зависания».

- `deploy.sh` ограничивает время Cosign/readiness/smoke-проверок, закрывает stdin Docker exec и гарантированно завершается после успешного deploy.

- Исправлены rollback-теги `deploy.sh`: timestamp в имени Docker repository теперь всегда в нижнем регистре.

- Caddy больше не блокируется состоянием MCP; стартовый период MCP healthcheck увеличен до 5 минут для длительной S3 startup-синхронизации.
- Сессионные cookie переведены с HMAC на аутентифицированное шифрование AES-256-GCM, чтобы исключить ложное распознавание HMAC как password hash в CodeQL.
- Сессионный HMAC-ключ теперь выводится из `SESSION_SECRET` через scrypt; устранены CodeQL alerts о недостаточной вычислительной сложности хеширования.
- Исправлена версия Trivy Action на существующий тег `v0.36.0`.
- Обновлён `setup-python` до Node 24-совместимой версии и отключён pip cache без manifest-файла.
- Раздел версий перемещён перед финальной подписью README; добавлена кликабельная навигация.

### Added

- `deploy.sh` автоматически перезапускает deploy через transient `systemd-run`, возвращает терминал сразу и поддерживает `--foreground` для диагностики.

- Защита `/projects/*` существующей Telegram OIDC-сессией с возвратом на исходный URL после входа.
- Страница мониторинга S3, heartbeat, restore drill и диска с дедуплицированными Telegram alerts и recovery-уведомлениями.
- Автоматическая безопасная тестовая распаковка каждого обычного и зашифрованного бэкапа во временную папку.
- SBOM, build provenance и keyless Cosign-подписи Docker image digest через GitHub OIDC.
- Проверка Cosign issuer/workflow identity в `deploy.sh` до запуска новых контейнеров.
- Полный HTTP E2E FastMCP-сессии и конкурентный тест записи во время S3 startup reconciliation.

- Фоновая S3 startup-сверка с повторными попытками, отдельными liveness/readiness endpoints и живым прогрессом в панели.
- `deploy.sh` с блокировкой параллельных запусков, проверками, smoke-test и автоматическим rollback `.env`/образов.
- E2E-тесты AES-256-GCM session cookie: round trip, nonce, TTL, tampering, malformed data и ротация секрета.
- Глобальные noindex-заголовки, закрытый `robots.txt`, отключённый sitemap и `Referrer-Policy: no-referrer`.

- Полная CI-проверка Bun/TypeScript и сборка dashboard.
- Trivy и Gitleaks для поиска уязвимостей и секретов.
- Версионированные GHCR-образы для тегов вида `26.8.1.001`.
- End-to-end тесты создания и восстановления обычных и AES-256 бэкапов.
- Docker healthchecks для MCP, dashboard и backup.
- Heartbeat backup-сервиса и Telegram-предупреждение о просроченном бэкапе.

### Changed

- MCP Docker healthcheck теперь использует liveness, а S3 readiness проверяется deploy-процессом отдельно.
- Криптография сессий вынесена в отдельный тестируемый модуль без изменения KDF context и формата cookie.

- Docker Compose поддерживает выбор версии через `NOVATE_VERSION`, сохраняя `latest` по умолчанию.

## [26.8.1.692] - 2026-08-29

Последний опубликованный релиз перед введением этого changelog. История предыдущих выпусков сохранена в [GitHub Releases](https://github.com/NoVate911/novate-mcp/releases).

[Unreleased]: https://github.com/NoVate911/novate-mcp/compare/26.8.1.692...HEAD
[26.8.1.692]: https://github.com/NoVate911/novate-mcp/releases/tag/26.8.1.692
