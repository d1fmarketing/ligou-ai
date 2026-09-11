#!/usr/bin/env bash
# Functional release gate. Raw payloads and credential values are consumed but never printed.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${LIGOU_ENV_FILE:-/opt/ligou/env}"
if [ ! -f "$ENV_FILE" ]; then
  printf '%s\n' '{"ok":false,"controller":"unknown","supabase":"unknown","hermes":"unknown"}'
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

TENANT="${TENANT_SLUG:-}"
TENANT_ID="${TENANT_ID:-}"
PORT="${PORT:-8790}"
CONTROLLER_STATE=unavailable
SUPABASE_STATE=unavailable
HERMES_STATE=unavailable
HERMES_REQUIRED=true

if [[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ ]] \
  && [[ "$TENANT_ID" =~ ^[a-f0-9-]{36}$ ]] && [[ "$PORT" =~ ^[0-9]{2,5}$ ]]; then
  # systemd reports the service started at exec time, before the socket binds, so the
  # first probe after a restart can hit connection-refused. Poll with a bounded deadline
  # instead of failing the release on that startup race.
  CONTROLLER_DEADLINE="${LIGOU_CONTROLLER_HEALTH_DEADLINE_S:-20}"
  [[ "$CONTROLLER_DEADLINE" =~ ^[0-9]{1,3}$ ]] || CONTROLLER_DEADLINE=20
  CONTROLLER_WAIT_START="$SECONDS"
  while :; do
    CONTROLLER_RAW="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
    if printf '%s' "$CONTROLLER_RAW" | "${LIGOU_NODE_BIN:-node}" -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{try{const v=JSON.parse(raw);process.exit(v&&!Array.isArray(v)&&typeof v==="object"&&v.ok===true&&v.openai===true?0:1)}catch{process.exit(1)}});'; then
      CONTROLLER_STATE=ready
      # Managed Live uses paid Responses delegation, not Hermes/Codex OAuth.
      # Derive this from the running controller, never an operator bypass flag.
      if printf '%s' "$CONTROLLER_RAW" | "${LIGOU_NODE_BIN:-node}" -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{try{process.exit(JSON.parse(raw).onboarding_model==="gpt-live-1"?0:1)}catch{process.exit(1)}});'; then
        HERMES_REQUIRED=false
      fi
      break
    fi
    [ $((SECONDS - CONTROLLER_WAIT_START)) -lt "$CONTROLLER_DEADLINE" ] || break
    sleep 1
  done

  if [[ "${SUPABASE_URL:-}" =~ ^https://[A-Za-z0-9.-]+/?$ ]] && [ -n "${SUPABASE_SECRET_KEY:-}" ]; then
    SUPABASE_RAW="$(curl -fsS --max-time 5 \
      -X POST "${SUPABASE_URL%/}/rest/v1/rpc/release_health_state" \
      -H "apikey: ${SUPABASE_SECRET_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
      -H 'Content-Type: application/json' \
      --data "{\"p_tenant\":\"${TENANT_ID}\",\"p_slug\":\"${TENANT}\"}" 2>/dev/null || true)"
    if printf '%s' "$SUPABASE_RAW" | "${LIGOU_NODE_BIN:-node}" -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{try{const v=JSON.parse(raw),id=process.argv[1],slug=process.argv[2];const keys=Object.keys(v||{}).sort().join(",");process.exit(keys==="ok,status,tenant_id,tenant_slug"&&v.ok===true&&v.status==="active"&&v.tenant_id===id&&v.tenant_slug===slug?0:1)}catch{process.exit(1)}});' "$TENANT_ID" "$TENANT"; then
      SUPABASE_STATE=ready
    fi
  fi

  if TENANT_ID="$TENANT_ID" TENANT_SLUG="$TENANT" HERMES_IMAGE="${HERMES_IMAGE:-}" HERMES_HEALTH_URL="${HERMES_HEALTH_URL:-}" \
    "${ROOT}/hermes-cell/health-state.sh" >/dev/null 2>&1; then
    HERMES_STATE=ready
  fi
fi

HEALTH_OK=false
if [ "$CONTROLLER_STATE" = ready ] && [ "$SUPABASE_STATE" = ready ] \
  && { [ "$HERMES_STATE" = ready ] || [ "$HERMES_REQUIRED" = false ]; }; then
  HEALTH_OK=true
fi
if [ "$HERMES_REQUIRED" = false ]; then
  printf '{"ok":%s,"controller":"%s","supabase":"%s","hermes":"%s","hermes_required":false}\n' \
    "$HEALTH_OK" "$CONTROLLER_STATE" "$SUPABASE_STATE" "$HERMES_STATE"
else
  printf '{"ok":%s,"controller":"%s","supabase":"%s","hermes":"%s"}\n' \
    "$HEALTH_OK" "$CONTROLLER_STATE" "$SUPABASE_STATE" "$HERMES_STATE"
fi
[ "$HEALTH_OK" = true ]
