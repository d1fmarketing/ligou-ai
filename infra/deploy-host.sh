#!/usr/bin/env bash
# Host-side immutable release activation. The artifact/manifest are verified before extraction.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${LIGOU_NODE_BIN:-node}"
BUN_BIN="${LIGOU_BUN_BIN:-/usr/local/bin/bun}"
DEPLOY_ROOT="${LIGOU_DEPLOY_ROOT:-/opt/ligou}"
SERVICE="${LIGOU_SERVICE_NAME:-ligou-controller}"
DISCOVERY_SERVICE="${LIGOU_DISCOVERY_SERVICE_NAME:-ligou-discovery-supervisor}"
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
[[ "$DISCOVERY_SERVICE" =~ ^[A-Za-z0-9@_.-]{1,80}$ ]] \
  && [ "$DISCOVERY_SERVICE" != "$SERVICE" ] \
  || { echo "discovery_service_name_invalid" >&2; exit 2; }
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "release_commit_invalid" >&2; exit 2; }
[ -f "$ARTIFACT" ] && [ -f "$MANIFEST" ] || { echo "release_inputs_required" >&2; exit 1; }
[ -n "${LIGOU_RELEASE_MANIFEST_KEY:-}" ] || { echo "release_manifest_key_required" >&2; exit 1; }
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "node_required" >&2; exit 1; }

mkdir -p "$DEPLOY_ROOT"
TEST_LOCK_DIR=""
STAGING=""
cleanup_deploy() {
  set +e
  if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then rm -rf "$STAGING"; fi
  if [ -n "$TEST_LOCK_DIR" ]; then rmdir "$TEST_LOCK_DIR" >/dev/null 2>&1 || true; fi
}
trap cleanup_deploy EXIT INT TERM HUP

if [ "${LIGOU_DEPLOY_TEST_HARNESS:-0}" = 1 ]; then
  case "$DEPLOY_ROOT" in
    /tmp/*|/var/folders/*) TEST_LOCK_DIR="${DEPLOY_ROOT}/.deploy-test-lock" ;;
    *) echo "deploy_test_harness_forbidden" >&2; exit 2 ;;
  esac
  if ! mkdir "$TEST_LOCK_DIR" 2>/dev/null; then echo "release_activation_locked" >&2; exit 75; fi
else
  [ -x /usr/bin/flock ] || { echo "flock_required" >&2; exit 1; }
  exec 9>"${DEPLOY_ROOT}/deploy.lock"
  if ! /usr/bin/flock -n -E 75 9; then echo "release_activation_locked" >&2; exit 75; fi
fi

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

IFS=$'\t' read -r RELEASE_ID SIGNED_IMAGE SIGNED_NODE SIGNED_BUN < <("$NODE_BIN" -e \
  'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write([v.release_id||"",v.runtime?.hermes?.image||"",v.runtime?.node?.version||"",v.runtime?.bun?.version||""].join("\t")+"\n");' \
  "$MANIFEST")
[[ "$RELEASE_ID" =~ ^[a-f0-9]{40}-[a-f0-9]{64}$ ]] || { echo "release_id_invalid" >&2; exit 1; }
[[ "${HERMES_IMAGE:-}" =~ ^[^[:space:]@]+(:[^[:space:]@]+)?@sha256:[a-f0-9]{64}$ ]] \
  && [ "$HERMES_IMAGE" = "$SIGNED_IMAGE" ] || { echo "hermes_image_release_mismatch" >&2; exit 1; }
[ "$("$NODE_BIN" --version 2>/dev/null)" = "v${SIGNED_NODE}" ] || { echo "node_runtime_mismatch" >&2; exit 1; }
[ "$("$BUN_BIN" --version 2>/dev/null)" = "$SIGNED_BUN" ] || { echo "bun_runtime_mismatch" >&2; exit 1; }

FINAL="${DEPLOY_ROOT}/releases/${RELEASE_ID}"
STAGING="${DEPLOY_ROOT}/releases/.staging-${RELEASE_ID}-$$"
[ ! -e "$FINAL" ] && [ ! -e "$STAGING" ] || { echo "release_already_exists" >&2; exit 1; }
mkdir "$STAGING"

tar -xzf "$ARTIFACT" -C "$STAGING"
[ -f "$STAGING/voice-controller/package.json" ] \
  && [ -f "$STAGING/discovery-supervisor/package.json" ] \
  && [ -f "$STAGING/discovery-supervisor/bun.lock" ] \
  && [ -f "$STAGING/hermes-cell/validate-config.mjs" ] \
  && [ -f "$STAGING/infra/ligou-discovery-supervisor.service" ] \
  && [ -f "$STAGING/infra/release-health.sh" ] \
  || { echo "release_content_invalid" >&2; exit 1; }
"$NODE_BIN" "$STAGING/hermes-cell/validate-config.mjs" --root "$STAGING" --json >/dev/null
(cd "$STAGING/voice-controller" && "$BUN_BIN" install --production --frozen-lockfile >/dev/null)
(cd "$STAGING/discovery-supervisor" && "$BUN_BIN" install --production --frozen-lockfile >/dev/null)
cp "$MANIFEST" "$STAGING/.ligou-release-manifest.json"
chmod 600 "$STAGING/.ligou-release-manifest.json"
mv "$STAGING" "$FINAL"
STAGING=""

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
  [ -f "$APP_LINK/.ligou-release-manifest.json" ] || { echo "legacy_release_manifest_missing" >&2; exit 1; }
  LEGACY_ID="$("$NODE_BIN" -e 'const v=require(process.argv[1]);process.stdout.write(String(v.release_id||""))' "$APP_LINK/.ligou-release-manifest.json")"
  [[ "$LEGACY_ID" =~ ^[A-Za-z0-9._-]{1,120}$ ]] || { echo "legacy_release_identity_invalid" >&2; exit 1; }
  LEGACY="${DEPLOY_ROOT}/releases/${LEGACY_ID}"
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
if [ ! -L "$APP_LINK" ] || [ "$(resolve_link "$APP_LINK")" != "$CURRENT_LINK" ]; then
  atomic_link "$CURRENT_LINK" "$APP_LINK"
fi

release_identity_matches() {
  local release="$1" expected
  [ -f "$release/.ligou-release-manifest.json" ] || return 1
  expected="$("$NODE_BIN" -e \
    'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(v.release_id||""));' \
    "$release/.ligou-release-manifest.json")"
  [ "$expected" = "$(basename "$release")" ]
}

current_points_to() {
  [ -L "$CURRENT_LINK" ] \
    && [ "$("$NODE_BIN" -e 'const fs=require("node:fs");process.stdout.write(fs.realpathSync(process.argv[1]));' "$CURRENT_LINK" 2>/dev/null || true)" \
      = "$("$NODE_BIN" -e 'const fs=require("node:fs");process.stdout.write(fs.realpathSync(process.argv[1]));' "$1" 2>/dev/null || true)" ]
}

DISCOVERY_WAS_ACTIVE=0
if systemctl is-active --quiet "$DISCOVERY_SERVICE"; then
  DISCOVERY_WAS_ACTIVE=1
fi

release_services_active() {
  systemctl is-active --quiet "$SERVICE" \
    && { [ "$DISCOVERY_WAS_ACTIVE" = 0 ] \
      || systemctl is-active --quiet "$DISCOVERY_SERVICE"; }
}

restart_release_services() {
  systemctl restart "$SERVICE" >/dev/null \
    && { [ "$DISCOVERY_WAS_ACTIVE" = 0 ] \
      || systemctl restart "$DISCOVERY_SERVICE" >/dev/null; }
}

release_smoke() {
  local release="$1"
  release_identity_matches "$release" \
    && current_points_to "$release" \
    && release_services_active \
    && LIGOU_ENV_FILE="${LIGOU_ENV_FILE:-${DEPLOY_ROOT}/env}" "$release/infra/release-health.sh" >/dev/null
}

rollback_recovered() {
  atomic_link "$PREVIOUS" "$CURRENT_LINK" \
    && restart_release_services \
    && release_smoke "$PREVIOUS"
}

if ! release_identity_matches "$PREVIOUS"; then
  echo "rollback_target_identity_invalid" >&2
  exit 1
fi

if ! atomic_link "$FINAL" "$CURRENT_LINK"; then
  if rollback_recovered; then
    write_result "$RELEASE_ID" rolled_back activation_failed not_run not_run
    echo "release_activation_failed_rollback_applied" >&2
  else
    write_result "$RELEASE_ID" rollback_failed activation_failed not_run not_run
    echo "release_activation_failed_rollback_failed" >&2
  fi
  exit 1
fi

if ! restart_release_services || ! release_services_active; then
  if rollback_recovered; then
    write_result "$RELEASE_ID" rolled_back service_failed not_run not_run
    echo "release_service_failed_rollback_applied" >&2
  else
    write_result "$RELEASE_ID" rollback_failed service_failed not_run not_run
    echo "release_service_failed_rollback_failed" >&2
  fi
  exit 1
fi

if ! RELEASE_HEALTH_RESULT="$(LIGOU_ENV_FILE="${LIGOU_ENV_FILE:-${DEPLOY_ROOT}/env}" "$FINAL/infra/release-health.sh")"; then
  if rollback_recovered; then
    write_result "$RELEASE_ID" rolled_back failed unknown unknown
    echo "release_health_failed_rollback_applied" >&2
  else
    write_result "$RELEASE_ID" rollback_failed failed unknown unknown
    echo "release_health_failed_rollback_failed" >&2
  fi
  exit 1
fi

if ! release_identity_matches "$FINAL" || ! current_points_to "$FINAL"; then
  if rollback_recovered; then
    write_result "$RELEASE_ID" rolled_back identity_failed not_run not_run
    echo "release_identity_failed_rollback_applied" >&2
  else
    write_result "$RELEASE_ID" rollback_failed identity_failed not_run not_run
    echo "release_identity_failed_rollback_failed" >&2
  fi
  exit 1
fi

# Record only sanitized observed states. A managed voice release can be healthy
# while the separately reported legacy Hermes dependency is unavailable.
read -r HEALTH_CONTROLLER HEALTH_SUPABASE HEALTH_HERMES < <(printf '%s' "$RELEASE_HEALTH_RESULT" | "$NODE_BIN" -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{let value={};try{value=JSON.parse(raw)||{}}catch{};process.stdout.write(["controller","supabase","hermes"].map(key=>["ready","unavailable","unknown"].includes(value[key])?value[key]:"unknown").join(" ")+"\n")});')
write_result "$RELEASE_ID" activated "$HEALTH_CONTROLLER" "$HEALTH_SUPABASE" "$HEALTH_HERMES"
printf '{"ok":true,"release_id":"%s","status":"activated"}\n' "$RELEASE_ID"
