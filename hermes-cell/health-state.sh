#!/usr/bin/env bash
# Token-free state probe: raw OAuth/auth and provider health payloads are consumed, never returned.
set -u

TENANT="${TENANT_SLUG:?set TENANT_SLUG}"
TENANT_ID="${TENANT_ID:?set TENANT_ID}"
if ! [[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ ]]; then
  printf '%s\n' '{"ok":false,"provider":"openai-codex","auth":"invalid_tenant","api":"unknown"}'
  exit 1
fi
NODE_BIN="${LIGOU_NODE_BIN:-node}"
EXPECTED_IMAGE="${HERMES_IMAGE:?set immutable HERMES_IMAGE digest}"
IMAGE_TOOL="$(cd "$(dirname "$0")" && pwd)/verify-running-image.mjs"
AUTH_TOOL="$(cd "$(dirname "$0")" && pwd)/auth-local-state.mjs"
IDENTITY_JSON="$("$NODE_BIN" "$(cd "$(dirname "$0")" && pwd)/tenant-identity.mjs" --tenant-id "$TENANT_ID" --tenant-slug "$TENANT" --json)" \
  || { echo '{"ok":false,"provider":"openai-codex","auth":"invalid_tenant","api":"unknown"}'; exit 1; }
identity_field() { "$NODE_BIN" -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(String(v[process.argv[2]]||""));' "$IDENTITY_JSON" "$1"; }
CELL="$(identity_field container_name)"
HOST_PORT="$(identity_field host_port)"
HEALTH_URL="http://127.0.0.1:${HOST_PORT}/health"
if [ -n "${HERMES_HEALTH_URL:-}" ] && [ "$HERMES_HEALTH_URL" != "$HEALTH_URL" ]; then
  echo "health_route_mismatch" >&2
  printf '%s\n' '{"ok":false,"provider":"openai-codex","auth":"unavailable","api":"unavailable"}'
  exit 1
fi

if ! "$NODE_BIN" "$IMAGE_TOOL" --container "$CELL" --expected "$EXPECTED_IMAGE" >/dev/null; then
  printf '%s\n' '{"ok":false,"provider":"openai-codex","auth":"unavailable","api":"unavailable"}'
  exit 1
fi

# ligou_auth_local_state executes inside the container; auth.json never crosses stdout.
AUTH_RAW="$(docker exec -i \
  -e LIGOU_AUTH_STATE_CLI=1 \
  -e "LIGOU_AUTH_PROBE_LABEL=auth status openai-codex" \
  "$CELL" node --input-type=module < "$AUTH_TOOL" 2>/dev/null || true)"
if printf '%s' "$AUTH_RAW" | "$NODE_BIN" -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{try{const v=JSON.parse(raw);process.exit(v?.provider==="openai-codex"&&v?.authenticated===true?0:1)}catch{process.exit(1)}});' ; then
  AUTH_STATE=ready
else
  AUTH_STATE=unavailable
fi

# Deliberately no Authorization header: this endpoint may report state only.
API_RAW="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
if printf '%s' "$API_RAW" | "$NODE_BIN" -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{try{const v=JSON.parse(raw);process.exit(v&&!Array.isArray(v)&&typeof v==="object"&&v.ok===true?0:1)}catch{process.exit(1)}});'; then
  API_STATE=ready
else
  API_STATE=unavailable
fi

if [ "$AUTH_STATE" = ready ] && [ "$API_STATE" = ready ]; then
  printf '%s\n' '{"ok":true,"provider":"openai-codex","auth":"ready","api":"ready"}'
  exit 0
fi
printf '{"ok":false,"provider":"openai-codex","auth":"%s","api":"%s"}\n' "$AUTH_STATE" "$API_STATE"
exit 1
