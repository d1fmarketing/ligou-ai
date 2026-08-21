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
IDENTITY_JSON="$("$NODE_BIN" "$(cd "$(dirname "$0")" && pwd)/tenant-identity.mjs" --tenant-id "$TENANT_ID" --tenant-slug "$TENANT" --json)" \
  || { echo '{"ok":false,"provider":"openai-codex","auth":"invalid_tenant","api":"unknown"}'; exit 1; }
identity_field() { "$NODE_BIN" -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(String(v[process.argv[2]]||""));' "$IDENTITY_JSON" "$1"; }
CELL="$(identity_field container_name)"
if [ -n "${HERMES_HEALTH_URL:-}" ]; then
  HEALTH_URL="$HERMES_HEALTH_URL"
else
  HOST_PORT="$(identity_field host_port)"
  HEALTH_URL="http://127.0.0.1:${HOST_PORT}/health"
fi

AUTH_RAW="$(docker exec "$CELL" hermes auth status openai-codex --json 2>/dev/null || true)"
if printf '%s' "$AUTH_RAW" | "$NODE_BIN" -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{try{const v=JSON.parse(raw);process.exit(v?.provider==="openai-codex"&&v?.authenticated===true?0:1)}catch{process.exit(1)}});' ; then
  AUTH_STATE=ready
else
  AUTH_STATE=unavailable
fi

# Deliberately no Authorization header: this endpoint may report state only.
API_RAW="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
if printf '%s' "$API_RAW" | grep -Eqi '"ok"[[:space:]]*:[[:space:]]*true|"status"[[:space:]]*:[[:space:]]*"ok"'; then
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
