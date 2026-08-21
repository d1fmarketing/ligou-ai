#!/usr/bin/env bash
# Future host scheduler entrypoint. Uses the service-role-only retention RPC and
# emits sanitized counts. This repository does not install or enable its timer.
set -euo pipefail
umask 077

NODE_BIN="${LIGOU_NODE_BIN:-node}"
ENV_FILE="${LIGOU_ENV_FILE:-/opt/ligou/env}"
[ -f "$ENV_FILE" ] || { echo "retention_env_required" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

[[ "${SUPABASE_URL:-}" =~ ^https://[A-Za-z0-9.-]+/?$ ]] || { echo "retention_supabase_url_invalid" >&2; exit 1; }
[ -n "${SUPABASE_SECRET_KEY:-}" ] || { echo "retention_service_key_required" >&2; exit 1; }
TRANSCRIPT_DAYS="${LIGOU_TRANSCRIPT_RETENTION_DAYS:-30}"
TRANSIENT_HOURS="${LIGOU_TRANSIENT_RETENTION_HOURS:-24}"
[[ "$TRANSCRIPT_DAYS" =~ ^[0-9]+$ ]] && [ "$TRANSCRIPT_DAYS" -ge 1 ] && [ "$TRANSCRIPT_DAYS" -le 3650 ] \
  || { echo "retention_transcript_window_invalid" >&2; exit 2; }
[[ "$TRANSIENT_HOURS" =~ ^[0-9]+$ ]] && [ "$TRANSIENT_HOURS" -ge 1 ] && [ "$TRANSIENT_HOURS" -le 8760 ] \
  || { echo "retention_transient_window_invalid" >&2; exit 2; }

IFS=$'\t' read -r TRANSCRIPT_BEFORE TRANSIENT_BEFORE < <("$NODE_BIN" -e '
const now=Date.now();const days=Number(process.argv[1]),hours=Number(process.argv[2]);
process.stdout.write(`${new Date(now-days*86400000).toISOString()}\t${new Date(now-hours*3600000).toISOString()}\n`);' \
  "$TRANSCRIPT_DAYS" "$TRANSIENT_HOURS")

RAW="$(curl -fsS --max-time 15 -X POST "${SUPABASE_URL%/}/rest/v1/rpc/purge_ephemeral_call_data" \
  -H "apikey: ${SUPABASE_SECRET_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
  -H 'Content-Type: application/json' \
  --data "{\"p_transcript_before\":\"${TRANSCRIPT_BEFORE}\",\"p_transient_before\":\"${TRANSIENT_BEFORE}\"}")"

printf '%s' "$RAW" | "$NODE_BIN" -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{try{
 const v=JSON.parse(raw),required=["transcripts_redacted","browser_rows_deleted","phone_rows_deleted","oauth_states_deleted","slot_offers_deleted","booking_quotes_deleted"];
 if(!v||Array.isArray(v)||required.some(k=>!Number.isSafeInteger(v[k])||v[k]<0))process.exit(1);
 process.stdout.write(JSON.stringify({ok:true,transcripts:v.transcripts_redacted,transport:v.browser_rows_deleted+v.phone_rows_deleted,oauth:v.oauth_states_deleted,offers:v.slot_offers_deleted,quotes:v.booking_quotes_deleted})+"\n");
}catch{process.exit(1)}});' || { echo "retention_response_invalid" >&2; exit 1; }
