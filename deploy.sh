#!/usr/bin/env bash
set -Eeuo pipefail

BASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$BASE_DIR"
TARGET_VERSION="${1:-latest}"
RUN_MODE="${2:-}"
TIMEOUT="${NOVATE_DEPLOY_TIMEOUT:-}"
if [[ -z "$TIMEOUT" && -f "$BASE_DIR/.env" ]]; then
  TIMEOUT="$(awk -F= '/^NOVATE_DEPLOY_TIMEOUT=/{print $2; exit}' "$BASE_DIR/.env")"
fi
TIMEOUT="${TIMEOUT:-600}"
COMPOSE_UP_TIMEOUT="${NOVATE_COMPOSE_UP_TIMEOUT:-180}"
export COMPOSE_ANSI=never
export COMPOSE_PROGRESS=plain
LOCK_DIR="$BASE_DIR/.deploy.lock"
STATE_DIR="$BASE_DIR/.deploy"
STAMP="$(date -u +%Y%m%dt%H%M%Sz)"
ENV_FILE="$BASE_DIR/.env"
ENV_BACKUP="$STATE_DIR/env-$STAMP"
ROLLBACK_FILE="$STATE_DIR/rollback-$STAMP.yml"
SERVICES=(mcp dashboard backup caddy)
COSIGN_IMAGE="${NOVATE_COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign:v3.1.3}"
VERIFY_SIGNATURES="${NOVATE_VERIFY_SIGNATURES:-}"
if [[ -z "$VERIFY_SIGNATURES" ]]; then
  VERIFY_SIGNATURES="$(awk -F= '/^NOVATE_VERIFY_SIGNATURES=/{print $2; exit}' "$ENV_FILE" 2>/dev/null || true)"
fi
VERIFY_SIGNATURES="${VERIFY_SIGNATURES:-true}"
SNAPSHOT_COUNT=0

[[ "$TARGET_VERSION" == "latest" || "$TARGET_VERSION" =~ ^[0-9]{2}\.(0?[1-9]|1[0-2])\.[1-9][0-9]*\.[0-9]{3}$ ]] || {
  echo "Ошибка: версия должна быть latest или YY.M.RELEASE.BUILD (например 26.8.1.001)." >&2
  exit 2
}
[[ -z "$RUN_MODE" || "$RUN_MODE" == "--foreground" ]] || {
  echo "Ошибка: поддерживается только необязательный флаг --foreground." >&2
  exit 2
}
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "Ошибка: NOVATE_DEPLOY_TIMEOUT должен быть числом секунд." >&2; exit 2; }
[[ "$COMPOSE_UP_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "Ошибка: NOVATE_COMPOSE_UP_TIMEOUT должен быть числом секунд." >&2; exit 2; }
[[ -f "$ENV_FILE" ]] || { echo "Ошибка: не найден $ENV_FILE" >&2; exit 2; }

if [[ "$RUN_MODE" != "--foreground" ]]; then
  if ! command -v systemd-run >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    echo "systemd-run недоступен; deploy продолжится в текущем терминале." >&2
  else
    unit="novate-deploy-$(date -u +%Y%m%dt%H%M%S)-$$"
    systemd-run \
      --unit="$unit" \
      --collect \
      --property=Type=exec \
      --property="WorkingDirectory=$BASE_DIR" \
      --setenv="NOVATE_DEPLOY_TIMEOUT=$TIMEOUT" \
      --setenv="NOVATE_COMPOSE_UP_TIMEOUT=$COMPOSE_UP_TIMEOUT" \
      --setenv="NOVATE_VERIFY_SIGNATURES=$VERIFY_SIGNATURES" \
      --setenv="NOVATE_COSIGN_IMAGE=$COSIGN_IMAGE" \
      /usr/bin/bash "$BASE_DIR/deploy.sh" "$TARGET_VERSION" --foreground
    echo "Deploy $TARGET_VERSION запущен в фоне: $unit"
    echo "Лог:    journalctl -fu $unit"
    echo "Статус: systemctl status $unit"
    exit 0
  fi
fi

mkdir -p "$STATE_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Ошибка: другой deploy уже выполняется ($LOCK_DIR)." >&2
  exit 3
fi
cleanup() { rm -rf "$LOCK_DIR"; }
trap cleanup EXIT

set_env_version() {
  local value="$1" tmp
  tmp="$(mktemp "$STATE_DIR/env.XXXXXX")"
  awk -v value="$value" '
    BEGIN { changed=0 }
    /^NOVATE_VERSION=/ { if (!changed) print "NOVATE_VERSION=" value; changed=1; next }
    { print }
    END { if (!changed) print "NOVATE_VERSION=" value }
  ' "$ENV_FILE" > "$tmp"
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

snapshot_images() {
  : > "$ROLLBACK_FILE"
  printf 'services:\n' >> "$ROLLBACK_FILE"
  for service in "${SERVICES[@]}"; do
    local cid image_id tag
    cid="$(docker compose ps -q "$service" 2>/dev/null || true)"
    [[ -n "$cid" ]] || continue
    image_id="$(docker inspect --format '{{.Image}}' "$cid")"
    [[ -n "$image_id" ]] || continue
    tag="novate-mcp-rollback-$STAMP:$service"
    docker image tag "$image_id" "$tag"
    printf '  %s:\n    image: %s\n' "$service" "$tag" >> "$ROLLBACK_FILE"
    SNAPSHOT_COUNT=$((SNAPSHOT_COUNT + 1))
  done
}

verify_signatures() {
  [[ "$VERIFY_SIGNATURES" =~ ^(1|true|yes|on)$ ]] || { echo "ВНИМАНИЕ: проверка подписей отключена." >&2; return 0; }
  local service ref digest_ref identity
  identity='^https://github.com/NoVate911/novate-mcp/.github/workflows/build\.yml@refs/(heads/main|tags/[0-9].*)$'
  for service in mcp dashboard backup; do
    ref="ghcr.io/novate911/novate-mcp:${service}-${TARGET_VERSION}"
    digest_ref="$(docker image inspect --format '{{index .RepoDigests 0}}' "$ref" 2>/dev/null || true)"
    [[ "$digest_ref" == *@sha256:* ]] || { echo "Не найден digest для $ref" >&2; return 1; }
    echo "Проверка Cosign-подписи: $digest_ref"
    if ! timeout 120 docker run --rm "$COSIGN_IMAGE" verify \
      --certificate-identity-regexp "$identity" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      "$digest_ref" >/dev/null </dev/null; then
      echo "Cosign-проверка не пройдена для $digest_ref" >&2
      return 1
    fi
  done
}

wait_until_ready() {
  local deadline=$((SECONDS + TIMEOUT)) service cid state health all_ok remaining
  local -a blockers
  echo "Контейнеры запущены. Ожидание health/readiness (таймаут: ${TIMEOUT} сек.)..."
  while (( SECONDS < deadline )); do
    all_ok=1
    blockers=()
    for service in "${SERVICES[@]}"; do
      cid="$(docker compose ps -q "$service" 2>/dev/null || true)"
      if [[ -z "$cid" ]]; then
        all_ok=0
        blockers+=("$service: контейнер не найден")
        continue
      fi
      state="$(docker inspect --format '{{.State.Running}}' "$cid" 2>/dev/null || true)"
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || true)"
      if [[ "$state" != "true" ]]; then
        all_ok=0
        blockers+=("$service: не запущен")
      elif [[ "$health" != "healthy" && "$health" != "none" ]]; then
        all_ok=0
        blockers+=("$service: health=$health")
      fi
    done

    if (( all_ok )); then
      if ! timeout 15 docker compose exec -T mcp \
        python healthcheck.py http http://127.0.0.1:8002/health/ready 200 \
        >/dev/null 2>&1 </dev/null; then
        all_ok=0
        blockers+=("mcp: readiness ещё не пройден")
      elif ! timeout 15 docker compose exec -T mcp python -c \
        'import urllib.request; response = urllib.request.urlopen("http://dashboard:8001/login", timeout=5); assert response.status == 200; response.close()' \
        >/dev/null 2>&1 </dev/null; then
        all_ok=0
        blockers+=("dashboard: smoke-test ещё не пройден")
      fi
    fi

    if (( all_ok )); then
      echo "Health/readiness проверки пройдены."
      return 0
    fi

    remaining=$((deadline - SECONDS))
    printf 'Ожидание, осталось до %s сек.: %s\n' "$remaining" "$(IFS='; '; echo "${blockers[*]}")"
    sleep 5
  done

  echo "Таймаут readiness после ${TIMEOUT} сек. Текущее состояние:" >&2
  docker compose ps >&2 || true
  return 1
}

rollback() {
  echo "Deploy не прошёл проверки. Выполняется автоматический rollback..." >&2
  cp "$ENV_BACKUP" "$ENV_FILE"
  if (( SNAPSHOT_COUNT > 0 )); then
    if timeout --foreground "$COMPOSE_UP_TIMEOUT" docker compose \
      -f docker-compose.yml -f "$ROLLBACK_FILE" \
      up -d --force-recreate --remove-orphans </dev/null; then
      echo "Rollback завершён: восстановлены прежние .env и локальные снимки образов." >&2
    else
      echo "ОШИБКА: docker compose не завершил rollback за ${COMPOSE_UP_TIMEOUT} сек." >&2
    fi
  else
    echo "Rollback образов невозможен: до deploy не было запущенных контейнеров." >&2
  fi
}

on_interrupt() {
  trap - INT TERM
  echo "Deploy прерван. Выполняется rollback..." >&2
  rollback
  exit 130
}
trap on_interrupt INT TERM

cp -p "$ENV_FILE" "$ENV_BACKUP"
snapshot_images
set_env_version "$TARGET_VERSION"

echo "Проверка конфигурации для версии $TARGET_VERSION..."
if ! docker compose config --quiet \
  || ! docker compose pull \
  || ! verify_signatures \
  || ! timeout --foreground "$COMPOSE_UP_TIMEOUT" docker compose up -d --remove-orphans </dev/null \
  || ! wait_until_ready; then
  rollback
  exit 1
fi

rm -f "$ROLLBACK_FILE"
find "$STATE_DIR" -type f -name 'env-*' -mtime +30 -delete 2>/dev/null || true
echo "Deploy $TARGET_VERSION завершён: контейнеры healthy, MCP readiness и dashboard smoke-test пройдены."
cleanup
trap - EXIT
exit 0
