#!/usr/bin/env bash
# Controlled one-time migration from a legacy combined Hermes volume to the
# tenant-scoped cognitive + model-auth layout. A successful run intentionally
# leaves the controller stopped for an authoritative external URL switch.
set -Eeuo pipefail

RUNTIME_ROOT="${LIGOU_RUNTIME_ROOT:?set LIGOU_RUNTIME_ROOT}"
TENANT_ID="${TENANT_ID:?set TENANT_ID}"
TENANT_SLUG="${TENANT_SLUG:?set TENANT_SLUG}"
HERMES_IMAGE="${HERMES_IMAGE:?set immutable HERMES_IMAGE}"
HERMES_API_KEY="${HERMES_API_KEY:?set HERMES_API_KEY}"
OLD_CELL="${LIGOU_LEGACY_HERMES_CELL:?set LIGOU_LEGACY_HERMES_CELL}"
OLD_VOLUME="${LIGOU_LEGACY_HERMES_VOLUME:?set LIGOU_LEGACY_HERMES_VOLUME}"
CONTROLLER_UNIT="${LIGOU_CONTROLLER_UNIT:-ligou-controller}"
REGISTRY="${LIGOU_TENANT_REGISTRY:-/opt/ligou/tenant-runtime-registry.json}"
STATE_ROOT="${LIGOU_TENANT_STATE_ROOT:-/opt/ligou/tenants}"
REPLY_FILE="$(mktemp /tmp/ligou-hermes-migration.XXXXXX)"
MUTATION_STARTED=0
AUTH_COPIED=0
REGISTRY_HASH_BEFORE=""
export TENANT_ID TENANT_SLUG HERMES_IMAGE HERMES_API_KEY LIGOU_TENANT_REGISTRY="$REGISTRY" LIGOU_TENANT_STATE_ROOT="$STATE_ROOT"

cleanup_reply() { rm -f "$REPLY_FILE"; }
trap cleanup_reply EXIT

runtime_field() {
  node -e 'const v=JSON.parse(process.argv[1]);const k=process.argv[2];if(!Object.hasOwn(v,k))process.exit(1);process.stdout.write(String(v[k]));' "$RUNTIME_JSON" "$1"
}

run_helper() {
  local command="$1"
  shift
  docker run --rm --network none --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    --user 10000:10000 --cap-drop ALL --security-opt no-new-privileges:true \
    "$@" --entrypoint /bin/bash "$HERMES_IMAGE" -Eeuo pipefail -c "$command"
}

copy_cognitive_state() {
  docker run --rm --network none --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    --user 10000:10000 --cap-drop ALL --security-opt no-new-privileges:true \
    -v "${OLD_VOLUME}:/src:ro" -v "${NEW_COGNITIVE}:/opt/data" \
    -v "${RUNTIME_ROOT}/hermes-cell/copy-cognitive-state.py:/copy-cognitive-state.py:ro" \
    --entrypoint python3 "$HERMES_IMAGE" \
    /copy-cognitive-state.py --source /src --destination /opt/data
}

copy_auth_to_old() {
  run_helper \
    'test -f /src/auth.json; cp /src/auth.json /dst/auth.json; chmod 600 /dst/auth.json' \
    -v "${NEW_AUTH}:/src:ro" -v "${OLD_VOLUME}:/dst"
}

controller_healthy() {
  curl -fsS --max-time 3 http://127.0.0.1:8790/health 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const v=JSON.parse(s);process.exit((v.controller_ok===true||v.ok===true)&&v.openai===true?0:1)}catch{process.exit(1)}});'
}

rollback() {
  local original_status=$?
  trap - ERR INT TERM
  set +e
  local rollback_ok=1
  local recovered=0
  if [ "$MUTATION_STARTED" -eq 1 ]; then
    docker stop -t 20 "$NEW_CELL" >/dev/null 2>&1 || true
    if [ "$AUTH_COPIED" -eq 1 ]; then copy_auth_to_old >/dev/null 2>&1 || rollback_ok=0; fi
    docker start "$OLD_CELL" >/dev/null 2>&1 || rollback_ok=0
    systemctl start "$CONTROLLER_UNIT" >/dev/null 2>&1 || rollback_ok=0
    for _attempt in $(seq 1 20); do
      if [ "$(docker inspect -f '{{.State.Running}}' "$OLD_CELL" 2>/dev/null)" = true ] \
        && [ "$(systemctl is-active "$CONTROLLER_UNIT" 2>/dev/null)" = active ] \
        && controller_healthy; then
        recovered=1
        break
      fi
      sleep 1
    done
    [ "$(docker inspect -f '{{.State.Running}}' "$OLD_CELL" 2>/dev/null)" = true ] || rollback_ok=0
    [ "$(systemctl is-active "$CONTROLLER_UNIT" 2>/dev/null)" = active ] || rollback_ok=0
    [ "$recovered" -eq 1 ] || rollback_ok=0
    controller_healthy || rollback_ok=0
    [ "$(sha256sum "$REGISTRY" | awk '{print $1}')" = "$REGISTRY_HASH_BEFORE" ] || rollback_ok=0
  fi
  if [ "$rollback_ok" -eq 1 ]; then
    printf '%s\n' '{"ok":false,"rollback":"applied"}' >&2
    exit "$original_status"
  fi
  printf '%s\n' '{"ok":false,"rollback":"failed"}' >&2
  exit 70
}
trap rollback ERR INT TERM

printf '%s\n' 'stage=preflight'
[[ "$HERMES_IMAGE" =~ ^[^[:space:]@]+(:[^[:space:]@]+)?@sha256:[a-f0-9]{64}$ ]]
[ "$OLD_CELL" = "ligou-cell-${TENANT_SLUG}" ]
[ "$(systemctl is-active "$CONTROLLER_UNIT")" = active ]
[ "$(docker inspect -f '{{.State.Running}}' "$OLD_CELL")" = true ]
docker inspect --format '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$OLD_CELL" | grep -Fx "${OLD_VOLUME} /opt/data" >/dev/null
[ -f "${RUNTIME_ROOT}/hermes-cell/tenant-compose.mjs" ]
[ -f "${RUNTIME_ROOT}/hermes-cell/auth-local-state.mjs" ]
[ -f "${RUNTIME_ROOT}/hermes-cell/action-contract.mjs" ]
[ -f "${RUNTIME_ROOT}/hermes-cell/copy-cognitive-state.py" ]
[ -f "$REGISTRY" ]
node -e '
const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const row=v?.tenants?.[process.argv[2]];
if(!row||row.slug!==process.argv[3]||!Number.isSafeInteger(row.host_port))process.exit(1);
' "$REGISTRY" "$TENANT_ID" "$TENANT_SLUG"
REGISTRY_HASH_BEFORE="$(sha256sum "$REGISTRY" | awk '{print $1}')"
RUNTIME_JSON="$(node "${RUNTIME_ROOT}/hermes-cell/tenant-compose.mjs" --print-runtime)"
NEW_CELL="$(runtime_field container_name)"
NEW_AUTH="$(runtime_field model_auth_volume)"
NEW_COGNITIVE="$(runtime_field cognitive_volume)"
HOST_PORT="$(runtime_field host_port)"
[ "$(runtime_field tenant_id)" = "$TENANT_ID" ]
[ "$(runtime_field tenant_slug)" = "$TENANT_SLUG" ]
[ "$(runtime_field image)" = "$HERMES_IMAGE" ]
[ "$OLD_VOLUME" != "$NEW_AUTH" ]
[ "$OLD_VOLUME" != "$NEW_COGNITIVE" ]
[ "$NEW_AUTH" != "$NEW_COGNITIVE" ]
[ -z "$(docker ps -q --filter volume="$NEW_AUTH")" ]
[ -z "$(docker ps -q --filter volume="$NEW_COGNITIVE")" ]
docker volume create "$NEW_AUTH" >/dev/null
docker volume create "$NEW_COGNITIVE" >/dev/null
(
  cd "${RUNTIME_ROOT}/hermes-cell"
  node tenant-compose.mjs config >/dev/null
)
[ "$(sha256sum "$REGISTRY" | awk '{print $1}')" = "$REGISTRY_HASH_BEFORE" ]

MUTATION_STARTED=1
printf '%s\n' 'stage=quiesce'
systemctl stop "$CONTROLLER_UNIT"
docker stop -t 30 "$OLD_CELL" >/dev/null

printf '%s\n' 'stage=cognitive_copy'
copy_cognitive_state

printf '%s\n' 'stage=auth_copy'
run_helper \
  'test -f /src/auth.json; rm -f /opt/model-auth/auth.json /opt/model-auth/auth.lock; cp /src/auth.json /opt/model-auth/auth.json; chmod 600 /opt/model-auth/auth.json' \
  -v "${OLD_VOLUME}:/src:ro" -v "${NEW_AUTH}:/opt/model-auth"
AUTH_COPIED=1

printf '%s\n' 'stage=start_new'
(
  cd "${RUNTIME_ROOT}/hermes-cell"
  node tenant-compose.mjs up -d --force-recreate >/dev/null
)

printf '%s\n' 'stage=health'
healthy=0
for _attempt in $(seq 1 45); do
  if bash "${RUNTIME_ROOT}/hermes-cell/health-state.sh" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
[ "$healthy" -eq 1 ]

printf '%s\n' 'stage=inference'
SYSTEM_PROMPT="$(<"${RUNTIME_ROOT}/hermes-cell/config/action-system-prompt.txt")"
payload="$(jq -nc --arg system "$SYSTEM_PROMPT" '{
  model:"hermes",stream:false,
  response_format:{type:"json_schema",json_schema:{name:"ligou_safe_action",strict:true,schema:{
    type:"object",additionalProperties:false,
    properties:{action:{type:"string",enum:["continue_standard_flow","open_team_case","confirm_schedule_later","offer_language_choice","offer_accessibility_support"]}},
    required:["action"]
  }}},
  messages:[
    {role:"system",content:$system},
    {role:"user",content:"{\"schema\":\"ligou.hermes.context.v1\",\"topic\":\"customer_upset\",\"service\":{\"id\":\"plumbing\",\"approved\":true},\"business\":{\"vertical\":\"plumbing\"},\"authority\":{\"auth_epoch\":1,\"policy_epoch\":1},\"operations\":{\"hours_configured\":true}}"}
  ]
}')"
http="$({
  printf 'header = "Authorization: Bearer %s"\n' "$HERMES_API_KEY"
  printf 'header = "Content-Type: application/json"\n'
  printf 'header = "X-Hermes-Session-Key: tenant:%s:cutover"\n' "$TENANT_SLUG"
} | curl -sS --max-time 120 -o "$REPLY_FILE" -w '%{http_code}' --config - \
  --data "$payload" "http://127.0.0.1:${HOST_PORT}/v1/chat/completions")"
if [ "$http" != 200 ]; then printf 'inference_http=%s\n' "$http" >&2; false; fi
action="$(node "${RUNTIME_ROOT}/hermes-cell/action-contract.mjs" --response "$REPLY_FILE")"
case "$action" in
  continue_standard_flow|open_team_case|confirm_schedule_later|offer_language_choice|offer_accessibility_support) ;;
  *) echo 'inference_action_invalid' >&2; false ;;
esac

printf '%s\n' 'stage=leak_scan'
docker exec -i "$NEW_CELL" python3 - <<'PY'
import json, re, stat
from pathlib import Path

auth = Path("/opt/model-auth/auth.json")
assert auth.is_file()
raw = json.loads(auth.read_text())
sensitive, stack = [], [raw]
pattern = re.compile(r"(?:access|refresh|id)?_?token|api_?key|secret", re.I)
while stack:
    value = stack.pop()
    if isinstance(value, dict):
        sensitive.extend(str(item).encode() for key, item in value.items() if pattern.search(str(key)) and isinstance(item, str) and len(item) >= 16)
        stack.extend(value.values())
    elif isinstance(value, list):
        stack.extend(value)
assert sensitive
root, hits = Path("/opt/data"), []
assert not list(root.rglob("auth.json"))
for candidate in root.rglob("*"):
    try:
        info = candidate.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 67_108_864: continue
        content = candidate.read_bytes()
        if any(token in content for token in sensitive): hits.append(str(candidate.relative_to(root)))
    except (OSError, PermissionError):
        pass
assert not hits, "cognitive_contains_model_auth"
PY

[ "$(sha256sum "$REGISTRY" | awk '{print $1}')" = "$REGISTRY_HASH_BEFORE" ]
MUTATION_STARTED=0
trap - ERR INT TERM
printf '%s\n' '{"ok":true,"new_cell":"ready","inference":"accepted","auth_leak":false,"controller":"stopped_for_env_switch"}'
