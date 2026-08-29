# Changelog

Все заметные изменения проекта фиксируются в этом файле. Формат версий проекта: `YY.M.RELEASE.BUILD`, например `26.8.1.001`.

- `YY` — две цифры года;
- `M` — номер месяца;
- `RELEASE` — серия релиза, увеличивается после сборки `999`;
- `BUILD` — номер сборки из трёх цифр (`001`–`999`).

## [Unreleased]

### Fixed

- Сессионный HMAC-ключ теперь выводится из `SESSION_SECRET` через scrypt; устранены CodeQL alerts о недостаточной вычислительной сложности хеширования.
- Исправлена версия Trivy Action на существующий тег `v0.36.0`.
- Обновлён `setup-python` до Node 24-совместимой версии и отключён pip cache без manifest-файла.
- Раздел версий перемещён перед финальной подписью README; добавлена кликабельная навигация.

### Added

- Полная CI-проверка Bun/TypeScript и сборка dashboard.
- Trivy и Gitleaks для поиска уязвимостей и секретов.
- Версионированные GHCR-образы для тегов вида `26.8.1.001`.
- End-to-end тесты создания и восстановления обычных и AES-256 бэкапов.
- Docker healthchecks для MCP, dashboard и backup.
- Heartbeat backup-сервиса и Telegram-предупреждение о просроченном бэкапе.

### Changed

- Docker Compose поддерживает выбор версии через `NOVATE_VERSION`, сохраняя `latest` по умолчанию.

## [26.8.1.692] - 2026-08-29

Последний опубликованный релиз перед введением этого changelog. История предыдущих выпусков сохранена в [GitHub Releases](https://github.com/NoVate911/novate-mcp/releases).

[Unreleased]: https://github.com/NoVate911/novate-mcp/compare/26.8.1.692...HEAD
[26.8.1.692]: https://github.com/NoVate911/novate-mcp/releases/tag/26.8.1.692
