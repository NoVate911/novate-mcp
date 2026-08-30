#!/usr/bin/env bash
set -Eeuo pipefail

BASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REQUEST="$BASE_DIR/dashboard-data/deploy-request.json"
PROCESSING="$BASE_DIR/dashboard-data/deploy-request.processing.json"
STATUS="$BASE_DIR/dashboard-data/deploy-status.json"
LOG_DIR="$BASE_DIR/.deploy"
PUBLIC_LOG_DIR="$BASE_DIR/dashboard-data/deploy-logs"
HISTORY="$BASE_DIR/dashboard-data/deploy-history.json"

[[ -f "$REQUEST" ]] || exit 0
mkdir -p "$LOG_DIR" "$PUBLIC_LOG_DIR"
if ! mv "$REQUEST" "$PROCESSING" 2>/dev/null; then
  exit 0
fi

write_status() {
  local state="$1" version="$2" message="$3" log_file="${4:-}"
  STATUS_PATH="$STATUS" STATE="$state" VERSION="$version" MESSAGE="$message" LOG_FILE="$log_file" \
    python3 - <<'PY'
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

status = Path(os.environ["STATUS_PATH"])
status.parent.mkdir(parents=True, exist_ok=True)
payload = {
    "state": os.environ["STATE"],
    "version": os.environ["VERSION"],
    "message": os.environ["MESSAGE"],
    "log_file": os.environ["LOG_FILE"],
    "updated_at": datetime.now(timezone.utc).isoformat(),
}
fd, temp_name = tempfile.mkstemp(prefix="deploy-status-", dir=status.parent)
with os.fdopen(fd, "w", encoding="utf-8") as output:
    json.dump(payload, output, ensure_ascii=False, indent=2)
os.chmod(temp_name, 0o644)
os.replace(temp_name, status)
PY
}

version="$(REQUEST_PATH="$PROCESSING" python3 - <<'PY'
import json
import os
from pathlib import Path
value = json.loads(Path(os.environ["REQUEST_PATH"]).read_text(encoding="utf-8"))
print(value.get("version", ""))
PY
)"

if [[ ! "$version" =~ ^[0-9]{2}\.(0?[1-9]|1[0-2])\.[1-9][0-9]*\.[0-9]{3}$ ]]; then
  write_status "error" "$version" "Запрос отклонён: недопустимая версия."
  rm -f "$PROCESSING"
  exit 2
fi

stamp="$(date -u +%Y%m%dt%H%M%Sz)"
log_file="$LOG_DIR/panel-deploy-$stamp.log"
write_status "running" "$version" "Обновление запущено. Панель может временно переподключиться." "$log_file"

set +e
/usr/bin/bash "$BASE_DIR/deploy.sh" "$version" --foreground >"$log_file" 2>&1
code=$?
set -e

public_log="$PUBLIC_LOG_DIR/$(basename "$log_file")"
tail -c 524288 "$log_file" > "$public_log" 2>/dev/null || true
chmod 640 "$public_log" 2>/dev/null || true
if (( code == 0 )); then
  final_state="success"
  final_message="Версия $version установлена, проверки готовности пройдены."
else
  final_state="error"
  final_message="Обновление завершилось ошибкой; deploy.sh выполнил rollback."
fi
write_status "$final_state" "$version" "$final_message" "$public_log"
HISTORY_PATH="$HISTORY" VERSION="$version" STATE="$final_state" MESSAGE="$final_message" LOG_FILE="$(basename "$public_log")" REQUEST_PATH="$PROCESSING" python3 - <<'PYH'
import json, os, tempfile
from datetime import datetime, timezone
from pathlib import Path
path=Path(os.environ['HISTORY_PATH'])
try: data=json.loads(path.read_text(encoding='utf-8'))
except Exception: data={'items':[]}
try: request=json.loads(Path(os.environ['REQUEST_PATH']).read_text(encoding='utf-8'))
except Exception: request={}
item={'id':datetime.now(timezone.utc).strftime('%Y%m%dt%H%M%Sz'),'version':os.environ['VERSION'],'state':os.environ['STATE'],'message':os.environ['MESSAGE'],'log':os.environ['LOG_FILE'],'requestedAt':request.get('requested_at',''),'requestedBy':request.get('requested_by',''),'finishedAt':datetime.now(timezone.utc).isoformat()}
data['items']=[item,*data.get('items',[])][:100]
fd,tmp=tempfile.mkstemp(prefix='deploy-history-',dir=path.parent)
with os.fdopen(fd,'w',encoding='utf-8') as out: json.dump(data,out,ensure_ascii=False,indent=2)
os.chmod(tmp,0o644); os.replace(tmp,path)
PYH
rm -f "$PROCESSING"
exit "$code"
