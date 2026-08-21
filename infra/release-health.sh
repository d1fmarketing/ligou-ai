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

if [[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ ]] \
  && [[ "$TENANT_ID" =~ ^[a-f0-9-]{36}$ ]] && [[ "$PORT" =~ ^[0-9]{2,5}$ ]]; then
  CONTROLLER_RAW="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
  if printf '%s' "$CONTROLLER_RAW" | grep -Eqi '"ok"[[:space:]]*:[[:space:]]*true' \
    && printf '%s' "$CONTROLLER_RAW" | grep -Eqi '"openai"[[:space:]]*:[[:space:]]*true'; then
    CONTROLLER_STATE=ready
  fi

  if [[ "${SUPABASE_URL:-}" =~ ^https://[A-Za-z0-9.-]+/?$ ]] && [ -n "${SUPABASE_PUBLISHABLE_KEY:-}" ]; then
    SUPABASE_RAW="$(curl -fsS --max-time 5 \
      "${SUPABASE_URL%/}/rest/v1/tenants?select=id&limit=1" \
      -H "apikey: ${SUPABASE_PUBLISHABLE_KEY}" \
      -H 'Accept: application/json' 2>/dev/null || true)"
    if printf '%s' "$SUPABASE_RAW" | grep -Eq '^[[:space:]]*\['; then
      SUPABASE_STATE=ready
    fi
  fi

  if TENANT_ID="$TENANT_ID" TENANT_SLUG="$TENANT" HERMES_HEALTH_URL="${HERMES_HEALTH_URL:-${HERMES_URL:-}}" \
    "${ROOT}/hermes-cell/health-state.sh" >/dev/null 2>&1; then
    HERMES_STATE=ready
  fi
fi

if [ "$CONTROLLER_STATE" = ready ] && [ "$SUPABASE_STATE" = ready ] && [ "$HERMES_STATE" = ready ]; then
  printf '%s\n' '{"ok":true,"controller":"ready","supabase":"ready","hermes":"ready"}'
  exit 0
fi
printf '{"ok":false,"controller":"%s","supabase":"%s","hermes":"%s"}\n' \
  "$CONTROLLER_STATE" "$SUPABASE_STATE" "$HERMES_STATE"
exit 1
