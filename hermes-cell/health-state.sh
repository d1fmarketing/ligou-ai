#!/usr/bin/env bash
# Token-free state probe: raw OAuth/auth and provider health payloads are consumed, never returned.
set -u

TENANT="${TENANT_SLUG:?set TENANT_SLUG}"
if ! [[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ ]]; then
  printf '%s\n' '{"ok":false,"provider":"openai-codex","auth":"invalid_tenant","api":"unknown"}'
  exit 1
fi
CELL="ligou-cell-${TENANT}"
HEALTH_URL="${HERMES_HEALTH_URL:-http://127.0.0.1:8642/health}"

AUTH_RAW="$(docker exec "$CELL" hermes auth status openai-codex --json 2>/dev/null || true)"
if printf '%s' "$AUTH_RAW" | grep -Eqi '"authenticated"[[:space:]]*:[[:space:]]*true|logged[[:space:]]+in'; then
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
