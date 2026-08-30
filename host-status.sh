#!/usr/bin/env bash
set -Eeuo pipefail
BASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$BASE_DIR/dashboard-data"
mkdir -p "$DATA_DIR/deploy-logs"
STATUS="$DATA_DIR/host-status.json"
PREFLIGHT_REQUEST="$DATA_DIR/preflight-request.json"
PREFLIGHT_STATUS="$DATA_DIR/preflight-status.json"

python_json() {
  python3 - "$@"
}

collect_status() {
  local tmp containers runner_active runner_enabled docker_state
  tmp="$(mktemp "$DATA_DIR/host-status.XXXXXX")"
  runner_active="$(systemctl is-active novate-deploy-request.path 2>/dev/null || true)"
  runner_enabled="$(systemctl is-enabled novate-deploy-request.path 2>/dev/null || true)"
  docker_state="$(systemctl is-active docker 2>/dev/null || true)"
  containers="$(docker inspect fastmcp-server mcp-dashboard novate-backup caddy 2>/dev/null || printf '[]')"
  RUNNER_ACTIVE="$runner_active" RUNNER_ENABLED="$runner_enabled" DOCKER_STATE="$docker_state" CONTAINERS="$containers" STATUS="$tmp" python3 - <<'PY'
import json, os
from datetime import datetime, timezone
raw=json.loads(os.environ.get('CONTAINERS') or '[]')
items=[]
for item in raw:
    state=item.get('State') or {}
    config=item.get('Config') or {}
    health=(state.get('Health') or {}).get('Status','нет проверки')
    image=(config.get('Image') or '').split('/')[-1]
    items.append({'name':(item.get('Name') or '').lstrip('/'),'image':image,'state':state.get('Status','unknown'),'health':health,'startedAt':state.get('StartedAt',''),'restarts':item.get('RestartCount',0)})
payload={'updatedAt':datetime.now(timezone.utc).isoformat(),'docker':os.environ['DOCKER_STATE'],'runner':{'active':os.environ['RUNNER_ACTIVE'],'enabled':os.environ['RUNNER_ENABLED']},'containers':items}
open(os.environ['STATUS'],'w').write(json.dumps(payload,ensure_ascii=False,indent=2))
PY
  chmod 644 "$tmp"
  mv -f "$tmp" "$STATUS"
}

run_preflight() {
  [[ -f "$PREFLIGHT_REQUEST" ]] || return 0
  local processing version tmp checks_ok free_kb
  processing="$DATA_DIR/preflight-request.processing.json"
  mv -f "$PREFLIGHT_REQUEST" "$processing"
  version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version",""))' "$processing")"
  tmp="$(mktemp "$DATA_DIR/preflight-status.XXXXXX")"
  checks_ok=true
  docker info >/dev/null 2>&1 || checks_ok=false
  free_kb="$(df -Pk "$BASE_DIR" | awk 'NR==2 {print $4}')"
  (( free_kb >= 1048576 )) || checks_ok=false
  for image in mcp dashboard backup; do
    docker manifest inspect "ghcr.io/novate911/novate-mcp:${image}-${version}" >/dev/null 2>&1 || checks_ok=false
  done
  VERSION="$version" OK="$checks_ok" FREE_KB="$free_kb" OUT="$tmp" python3 - <<'PY'
import json, os
from datetime import datetime, timezone
ok=os.environ['OK']=='true'
checks=[
 {'name':'Docker','ok':ok if False else None},
]
payload={'version':os.environ['VERSION'],'state':'ok' if ok else 'error','checkedAt':datetime.now(timezone.utc).isoformat(),'freeBytes':int(os.environ['FREE_KB'])*1024,'message':'Релиз готов к установке.' if ok else 'Предварительная проверка не пройдена: проверьте Docker, образы GHCR и свободное место.'}
open(os.environ['OUT'],'w').write(json.dumps(payload,ensure_ascii=False,indent=2))
PY
  chmod 644 "$tmp" && mv -f "$tmp" "$PREFLIGHT_STATUS" && rm -f "$processing"
}

collect_status
run_preflight
