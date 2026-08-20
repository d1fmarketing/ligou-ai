#!/usr/bin/env bash
# Host-side immutable release activation. The artifact/manifest are verified before extraction.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${LIGOU_NODE_BIN:-node}"
BUN_BIN="${LIGOU_BUN_BIN:-/usr/local/bin/bun}"
DEPLOY_ROOT="${LIGOU_DEPLOY_ROOT:-/opt/ligou}"
SERVICE="${LIGOU_SERVICE_NAME:-ligou-controller}"
RESULTS_FILE="${LIGOU_DEPLOY_RESULTS_FILE:-${DEPLOY_ROOT}/deploy-results.jsonl}"
ARTIFACT=""
MANIFEST=""
COMMIT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact) [ "$#" -ge 2 ] || { echo "release_argument_missing" >&2; exit 2; }; ARTIFACT="$2"; shift 2 ;;
    --manifest) [ "$#" -ge 2 ] || { echo "release_argument_missing" >&2; exit 2; }; MANIFEST="$2"; shift 2 ;;
    --commit) [ "$#" -ge 2 ] || { echo "release_argument_missing" >&2; exit 2; }; COMMIT="$2"; shift 2 ;;
    *) echo "release_argument_unknown" >&2; exit 2 ;;
  esac
done

[[ "$DEPLOY_ROOT" = /* && "$DEPLOY_ROOT" != "/" && "$DEPLOY_ROOT" != "/opt" ]] || { echo "deploy_root_invalid" >&2; exit 2; }
[[ "$SERVICE" =~ ^[A-Za-z0-9@_.-]{1,80}$ ]] || { echo "service_name_invalid" >&2; exit 2; }
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "release_commit_invalid" >&2; exit 2; }
[ -f "$ARTIFACT" ] && [ -f "$MANIFEST" ] || { echo "release_inputs_required" >&2; exit 1; }
[ -n "${LIGOU_RELEASE_MANIFEST_KEY:-}" ] || { echo "release_manifest_key_required" >&2; exit 1; }
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "node_required" >&2; exit 1; }

mkdir -p "$DEPLOY_ROOT/releases"
touch "$RESULTS_FILE"
chmod 600 "$RESULTS_FILE"

write_result() {
  local release_id="$1" status="$2" controller="$3" supabase="$4" hermes="$5"
  local at
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"at":"%s","release_id":"%s","commit_sha":"%s","status":"%s","checks":{"controller":"%s","supabase":"%s","hermes":"%s"}}\n' \
    "$at" "$release_id" "$COMMIT" "$status" "$controller" "$supabase" "$hermes" >> "$RESULTS_FILE"
}

if ! "$NODE_BIN" "$SCRIPT_DIR/release-manifest.mjs" verify \
  --artifact "$ARTIFACT" --manifest "$MANIFEST" --commit "$COMMIT" >/dev/null 2>&1; then
  write_result unverified verification_failed not_run not_run not_run
  echo "release_verification_failed" >&2
  exit 1
fi

RELEASE_ID="$("$NODE_BIN" -e \
  'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(value.release_id||""));' \
  "$MANIFEST")"
[[ "$RELEASE_ID" =~ ^[a-f0-9]{12}-[a-f0-9]{12}$ ]] || { echo "release_id_invalid" >&2; exit 1; }

FINAL="${DEPLOY_ROOT}/releases/${RELEASE_ID}"
STAGING="${DEPLOY_ROOT}/releases/.staging-${RELEASE_ID}-$$"
[ ! -e "$FINAL" ] && [ ! -e "$STAGING" ] || { echo "release_already_exists" >&2; exit 1; }
mkdir "$STAGING"
cleanup_staging() { [ ! -d "$STAGING" ] || rm -rf "$STAGING"; }
trap cleanup_staging EXIT

tar -xzf "$ARTIFACT" -C "$STAGING"
[ -f "$STAGING/voice-controller/package.json" ] \
  && [ -f "$STAGING/hermes-cell/validate-config.mjs" ] \
  && [ -f "$STAGING/infra/release-health.sh" ] \
  || { echo "release_content_invalid" >&2; exit 1; }
"$NODE_BIN" "$STAGING/hermes-cell/validate-config.mjs" --root "$STAGING" --json >/dev/null
(cd "$STAGING/voice-controller" && "$BUN_BIN" install --production --frozen-lockfile >/dev/null)
mv "$STAGING" "$FINAL"
trap - EXIT

atomic_link() {
  local target="$1" link="$2" next="${2}.next.$$"
  rm -f "$next"
  ln -s "$target" "$next"
  "$NODE_BIN" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$next" "$link"
}

resolve_link() {
  local link="$1" target
  target="$(readlink "$link")"
  if [[ "$target" = /* ]]; then printf '%s\n' "$target"; else printf '%s/%s\n' "$(dirname "$link")" "$target"; fi
}

CURRENT_LINK="${DEPLOY_ROOT}/current"
APP_LINK="${DEPLOY_ROOT}/app"
PREVIOUS=""
if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS="$(resolve_link "$CURRENT_LINK")"
elif [ -L "$APP_LINK" ]; then
  PREVIOUS="$(resolve_link "$APP_LINK")"
  atomic_link "$PREVIOUS" "$CURRENT_LINK"
elif [ -d "$APP_LINK" ]; then
  LEGACY="${DEPLOY_ROOT}/releases/legacy-$(date -u +%Y%m%dT%H%M%SZ)"
  [ ! -e "$LEGACY" ] || { echo "legacy_release_conflict" >&2; exit 1; }
  mv "$APP_LINK" "$LEGACY"
  PREVIOUS="$LEGACY"
  atomic_link "$PREVIOUS" "$CURRENT_LINK"
else
  echo "rollback_target_missing" >&2
  exit 1
fi
case "$PREVIOUS" in
  "${DEPLOY_ROOT}/releases/"*) [ -d "$PREVIOUS" ] || { echo "rollback_target_invalid" >&2; exit 1; } ;;
  *) echo "rollback_target_invalid" >&2; exit 1 ;;
esac
if [ -e "$APP_LINK" ] && [ ! -L "$APP_LINK" ]; then
  echo "app_activation_target_invalid" >&2
  exit 1
fi

rollback_links() {
  atomic_link "$PREVIOUS" "$CURRENT_LINK" \
    && atomic_link "$PREVIOUS" "$APP_LINK" \
    && systemctl restart "$SERVICE" >/dev/null
}

if ! atomic_link "$FINAL" "$CURRENT_LINK" || ! atomic_link "$FINAL" "$APP_LINK"; then
  rollback_links || true
  write_result "$RELEASE_ID" rolled_back activation_failed not_run not_run
  echo "release_activation_failed_rollback_applied" >&2
  exit 1
fi

if ! systemctl restart "$SERVICE" >/dev/null || ! systemctl is-active --quiet "$SERVICE"; then
  if rollback_links; then
    write_result "$RELEASE_ID" rolled_back service_failed not_run not_run
    echo "release_service_failed_rollback_applied" >&2
  else
    write_result "$RELEASE_ID" rollback_failed service_failed not_run not_run
    echo "release_service_failed_rollback_failed" >&2
  fi
  exit 1
fi

if ! LIGOU_ENV_FILE="${LIGOU_ENV_FILE:-${DEPLOY_ROOT}/env}" "$FINAL/infra/release-health.sh" >/dev/null; then
  if rollback_links; then
    write_result "$RELEASE_ID" rolled_back failed unknown unknown
    echo "release_health_failed_rollback_applied" >&2
  else
    write_result "$RELEASE_ID" rollback_failed failed unknown unknown
    echo "release_health_failed_rollback_failed" >&2
  fi
  exit 1
fi

write_result "$RELEASE_ID" activated ready ready ready
printf '{"ok":true,"release_id":"%s","status":"activated"}\n' "$RELEASE_ID"
