#!/usr/bin/env bash
# Safe default: authenticate and import into a disposable, network-isolated cognitive volume.
# --apply is allowed only after disposable memory/skill/session/health smoke checks pass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${LIGOU_NODE_BIN:-node}"
MANIFEST_TOOL="${ROOT}/infra/backup-manifest.mjs"
ARCHIVE_TOOL="${ROOT}/infra/archive-safety.mjs"
CAPTURE_TOOL="${ROOT}/infra/capture-restore-inputs.mjs"
HEALTH_TOOL="${ROOT}/hermes-cell/health-state.sh"
IDENTITY_TOOL="${ROOT}/hermes-cell/tenant-identity.mjs"
TENANT_COMPOSE="${ROOT}/hermes-cell/tenant-compose.mjs"
TENANT="${TENANT_SLUG:?set TENANT_SLUG}"
TENANT_ID="${TENANT_ID:?set TENANT_ID}"
IMAGE="${HERMES_IMAGE:?set immutable HERMES_IMAGE digest}"
APPLY=0
KEY=""
LOCAL_ARCHIVE=""
LOCAL_MANIFEST=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --key) [ "$#" -ge 2 ] || { echo "restore_argument_missing" >&2; exit 2; }; KEY="$2"; shift 2 ;;
    --archive) [ "$#" -ge 2 ] || { echo "restore_argument_missing" >&2; exit 2; }; LOCAL_ARCHIVE="$2"; shift 2 ;;
    --manifest) [ "$#" -ge 2 ] || { echo "restore_argument_missing" >&2; exit 2; }; LOCAL_MANIFEST="$2"; shift 2 ;;
    *) echo "restore_argument_unknown" >&2; exit 2 ;;
  esac
done

[[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ ]] || { echo "tenant_invalid" >&2; exit 2; }
[[ "$TENANT_ID" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] \
  || { echo "tenant_id_invalid" >&2; exit 2; }
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "node_required" >&2; exit 1; }
[ -n "${LIGOU_BACKUP_MANIFEST_KEY:-}" ] || { echo "manifest_key_required" >&2; exit 1; }
[[ "$IMAGE" =~ ^[^[:space:]@]+(:[^[:space:]@]+)?@sha256:[a-f0-9]{64}$ ]] || { echo "hermes_image_digest_required" >&2; exit 1; }

RESTORE_LOCK_HELD=0
RESTORE_TEST_LOCK_DIR=""
SCRATCH=""
CHECK_CELL=""
CHECK_VOLUME=""
CHECK_CREATED=0
CHECK_STARTED=0
INTERRUPTED=0
ACTIVE_COGNITIVE=""

release_restore_lock() {
  if [ "$RESTORE_LOCK_HELD" -eq 1 ] && [ -n "$RESTORE_TEST_LOCK_DIR" ]; then
    rmdir "$RESTORE_TEST_LOCK_DIR" >/dev/null 2>&1 || true
  fi
  RESTORE_LOCK_HELD=0
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e
  if [ "$CHECK_STARTED" -eq 1 ]; then
    docker rm -f "$CHECK_CELL" >/dev/null 2>&1
    CHECK_STARTED=0
  fi
  if [ "$status" -ne 0 ] && [ "$CHECK_CREATED" -eq 1 ] && [ -n "$CHECK_VOLUME" ]; then
    local registry_volume
    registry_volume="$(registry_cognitive_volume 2>/dev/null || true)"
    if [ "$registry_volume" = "$CHECK_VOLUME" ]; then
      if rollback_activation; then
        remove_owned_inactive_stage || true
        if [ "$INTERRUPTED" -eq 1 ]; then echo "restore_interrupted_rollback_applied" >&2; fi
      else
        echo "restore_interrupted_rollback_failed" >&2
      fi
    elif [ "$registry_volume" = "$ACTIVE_COGNITIVE" ]; then
      if recreate_cell && live_smoke; then
        remove_owned_inactive_stage || true
        if [ "$INTERRUPTED" -eq 1 ]; then echo "restore_interrupted_no_promotion" >&2; fi
      else
        echo "restore_interrupted_rollback_failed" >&2
      fi
    else
      echo "restore_registry_state_unknown" >&2
    fi
  fi
  if [ "$CHECK_CREATED" -eq 1 ]; then remove_owned_inactive_stage || true; fi
  if [ -n "$SCRATCH" ]; then rm -rf "$SCRATCH"; fi
  release_restore_lock
  exit "$status"
}
trap cleanup EXIT
trap 'INTERRUPTED=1; exit 130' INT
trap 'INTERRUPTED=1; exit 143' TERM
trap 'INTERRUPTED=1; exit 129' HUP

# Production lock identity is fixed and derives only from the immutable tenant UUID.
# The temporary-directory variant exists solely for the local command-double harness.
if [ "${LIGOU_RESTORE_TEST_HARNESS:-0}" = 1 ]; then
  RESTORE_TEST_STATE="$("$NODE_BIN" -e 'const fs=require("node:fs"),path=require("node:path");const value=path.resolve(process.argv[1]);process.stdout.write(path.join(fs.realpathSync(path.dirname(value)),path.basename(value)))' "${LIGOU_TENANT_STATE_ROOT:-.}")"
  RESTORE_TEST_ROOT="$(dirname "$RESTORE_TEST_STATE")"
  RESTORE_TEST_REGISTRY="$("$NODE_BIN" -e 'const fs=require("node:fs"),path=require("node:path");const value=path.resolve(process.argv[1]);process.stdout.write(path.join(fs.realpathSync(path.dirname(value)),path.basename(value)))' "${LIGOU_TENANT_REGISTRY:-.}")"
  RESTORE_TEST_DOCKER="$(command -v docker 2>/dev/null || true)"
  if [ -n "$RESTORE_TEST_DOCKER" ]; then
    RESTORE_TEST_DOCKER="$("$NODE_BIN" -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$RESTORE_TEST_DOCKER")"
  fi
  case "$RESTORE_TEST_STATE" in
    /tmp/*|/var/folders/*|/private/var/folders/*) RESTORE_TEST_LOCK_ROOT="${RESTORE_TEST_STATE}/.restore-locks" ;;
    *) echo "restore_test_harness_forbidden" >&2; exit 2 ;;
  esac
  case "$RESTORE_TEST_REGISTRY" in "$RESTORE_TEST_ROOT"/*) ;; *) echo "restore_test_harness_forbidden" >&2; exit 2 ;; esac
  case "$RESTORE_TEST_DOCKER" in "$RESTORE_TEST_ROOT"/*) ;; *) echo "restore_test_harness_forbidden" >&2; exit 2 ;; esac
  mkdir -p "$RESTORE_TEST_LOCK_ROOT"
  chmod 700 "$RESTORE_TEST_LOCK_ROOT"
  RESTORE_TEST_LOCK_DIR="${RESTORE_TEST_LOCK_ROOT}/${TENANT_ID}.lock"
  if ! mkdir "$RESTORE_TEST_LOCK_DIR" 2>/dev/null; then
    echo "restore_tenant_locked" >&2
    exit 75
  fi
  RESTORE_LOCK_HELD=1
else
  RESTORE_LOCK_ROOT="/opt/ligou/restore-locks"
  mkdir -p "$RESTORE_LOCK_ROOT"
  chmod 700 "$RESTORE_LOCK_ROOT"
  [ -x /usr/bin/flock ] || { echo "flock_required" >&2; exit 1; }
  RESTORE_LOCK_PATH="${RESTORE_LOCK_ROOT}/${TENANT_ID}.lock"
  exec 8>>"$RESTORE_LOCK_PATH"
  chmod 600 "$RESTORE_LOCK_PATH"
  if ! /usr/bin/flock -n -E 75 8; then
    echo "restore_tenant_locked" >&2
    exit 75
  fi
  RESTORE_LOCK_HELD=1
fi

IDENTITY_JSON="$("$NODE_BIN" "$IDENTITY_TOOL" --tenant-id "$TENANT_ID" --tenant-slug "$TENANT" --json)"
identity_field() {
  "$NODE_BIN" -e 'const value=JSON.parse(process.argv[1]);const field=process.argv[2];if(!Object.hasOwn(value,field))process.exit(1);process.stdout.write(String(value[field]));' "$IDENTITY_JSON" "$1"
}
RESTORE_WORK="$(identity_field restore_work_dir)"
CELL="$(identity_field container_name)"
ARCHIVE_PREFIX="$(identity_field archive_prefix)"
ACTIVE_COGNITIVE="$(identity_field cognitive_volume)"
mkdir -p "$RESTORE_WORK"
chmod 700 "$RESTORE_WORK"
SCRATCH="$(mktemp -d "${RESTORE_WORK}/run.XXXXXX")"

cell_active() {
  [ "$(docker inspect --format '{{.State.Running}}' "$CELL" 2>/dev/null || true)" = "true" ]
}

live_smoke() {
  cell_active \
    && docker exec "$CELL" hermes memory list --json >/dev/null \
    && docker exec "$CELL" hermes skills list --json >/dev/null \
    && docker exec "$CELL" hermes sessions list --json >/dev/null \
    && TENANT_ID="$TENANT_ID" TENANT_SLUG="$TENANT" HERMES_IMAGE="$IMAGE" "$HEALTH_TOOL" >/dev/null
}

activate_volume() {
  local next="$1" expected="$2"
  if [ "${LIGOU_RESTORE_TEST_HARNESS:-0}" = 1 ] && [ "${LIGOU_RESTORE_TEST_FAIL_CAS:-0}" = 1 ] \
    && [ "$next" = "$CHECK_VOLUME" ]; then return 1; fi
  if [ "${LIGOU_RESTORE_TEST_HARNESS:-0}" = 1 ] && [ "${LIGOU_RESTORE_TEST_FAIL_ROLLBACK_CAS:-0}" = 1 ] \
    && [ "$next" = "$ACTIVE_COGNITIVE" ] && [ "$expected" = "$CHECK_VOLUME" ]; then return 1; fi
  "$NODE_BIN" "$IDENTITY_TOOL" --tenant-id "$TENANT_ID" --tenant-slug "$TENANT" --activate-cognitive "$next" --expected "$expected" --json >/dev/null
}

recreate_cell() {
  TENANT_ID="$TENANT_ID" TENANT_SLUG="$TENANT" HERMES_IMAGE="$IMAGE" "$NODE_BIN" "$TENANT_COMPOSE" up -d --force-recreate >/dev/null
}

rollback_activation() {
  activate_volume "$ACTIVE_COGNITIVE" "$CHECK_VOLUME" \
    && recreate_cell \
    && live_smoke
}

registry_cognitive_volume() {
  "$NODE_BIN" "$IDENTITY_TOOL" --tenant-id "$TENANT_ID" --tenant-slug "$TENANT" --field cognitive_volume
}

remove_owned_inactive_stage() {
  [ "$CHECK_CREATED" -eq 1 ] && [ -n "$CHECK_VOLUME" ] || return 1
  local registry_volume
  registry_volume="$(registry_cognitive_volume)" || return 1
  [ "$registry_volume" != "$CHECK_VOLUME" ] || return 1
  docker volume rm "$CHECK_VOLUME" >/dev/null 2>&1 || return 1
  CHECK_CREATED=0
}

if [ -n "$LOCAL_ARCHIVE" ] || [ -n "$LOCAL_MANIFEST" ]; then
  [ -n "$LOCAL_ARCHIVE" ] && [ -n "$LOCAL_MANIFEST" ] || { echo "restore_local_pair_required" >&2; exit 1; }
  CAPTURE_JSON="$($NODE_BIN "$CAPTURE_TOOL" --archive "$LOCAL_ARCHIVE" --manifest "$LOCAL_MANIFEST" --scratch "$SCRATCH")"
  ARCHIVE="$($NODE_BIN -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(String(v.archive||""));' "$CAPTURE_JSON")"
  MANIFEST="$($NODE_BIN -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(String(v.manifest||""));' "$CAPTURE_JSON")"
  LOCAL_ARCHIVE=""
  LOCAL_MANIFEST=""
else
  BUCKET="${LIGOU_BACKUP_BUCKET:?set LIGOU_BACKUP_BUCKET}"
  if [ -z "$KEY" ]; then
    KEY="$(aws s3 ls "s3://${BUCKET}/cells/${TENANT_ID}/" \
      | awk '{print $4}' | grep -E "^${ARCHIVE_PREFIX}-[0-9]{8}T[0-9]{6}Z(-[a-f0-9]{32})?[.]zip$" | sort | tail -1)"
    [ -n "$KEY" ] || { echo "backup_not_found" >&2; exit 1; }
  fi
  [[ "$KEY" =~ ^${ARCHIVE_PREFIX}-[0-9]{8}T[0-9]{6}Z(-[a-f0-9]{32})?[.]zip$ ]] || { echo "backup_key_invalid" >&2; exit 2; }
  ARCHIVE="${SCRATCH}/${KEY}"
  MANIFEST="${SCRATCH}/${KEY}.manifest.json"
  aws s3 cp "s3://${BUCKET}/cells/${TENANT_ID}/${KEY}" "$ARCHIVE" --only-show-errors
  aws s3 cp "s3://${BUCKET}/cells/${TENANT_ID}/${KEY}.manifest.json" "$MANIFEST" --only-show-errors
fi

"$NODE_BIN" "$MANIFEST_TOOL" verify --archive "$ARCHIVE" --manifest "$MANIFEST" --tenant "$TENANT_ID" --hermes-image "$IMAGE" >/dev/null
"$NODE_BIN" "$ARCHIVE_TOOL" extract "$ARCHIVE" "${SCRATCH}/validated" >/dev/null
ARCHIVE_ID="$("$NODE_BIN" -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(value.archive?.id||""));' "$MANIFEST")"
[[ "$ARCHIVE_ID" =~ ^[a-f0-9]{64}$ ]] || { echo "archive_identity_invalid" >&2; exit 1; }
if [ "$APPLY" -eq 1 ]; then
  CHECK_VOLUME="ligou-${TENANT_ID}-hermes-cognitive-stage-${ARCHIVE_ID}"
  CHECK_CELL="${ARCHIVE_PREFIX}-restore-stage-${ARCHIVE_ID}"
else
  CHECK_VOLUME="${ARCHIVE_PREFIX}-restore-check-$$"
  CHECK_CELL="${ARCHIVE_PREFIX}-restore-check-$$"
fi

if docker volume inspect "$CHECK_VOLUME" >/dev/null 2>&1; then
  echo "restore_stage_volume_exists" >&2
  exit 1
fi

docker volume create "$CHECK_VOLUME" >/dev/null
CHECK_CREATED=1
if ! docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=volume,source=${CHECK_VOLUME},target=/opt/data" \
  --mount "type=bind,source=${ARCHIVE},target=/restore/input.zip,readonly" \
  "$IMAGE" hermes import /restore/input.zip --yes >/dev/null; then
  echo "disposable_import_failed" >&2
  exit 1
fi

docker run -d --name "$CHECK_CELL" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=volume,source=${CHECK_VOLUME},target=/opt/data" \
  "$IMAGE" gateway run >/dev/null
CHECK_STARTED=1

disposable_health=0
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec "$CHECK_CELL" sh -c \
    'curl -fsS --max-time 3 http://127.0.0.1:8642/health | grep -Eq '"'"'"ok"[[:space:]]*:[[:space:]]*true|"status"[[:space:]]*:[[:space:]]*"ok"'"'"'' \
    >/dev/null 2>&1; then
    disposable_health=1
    break
  fi
  sleep 1
done

if [ "$disposable_health" -ne 1 ] \
  || ! docker exec "$CHECK_CELL" sh -c 'test ! -e /root/.hermes/auth.json' >/dev/null \
  || ! docker exec "$CHECK_CELL" hermes memory list --json >/dev/null \
  || ! docker exec "$CHECK_CELL" hermes skills list --json >/dev/null \
  || ! docker exec "$CHECK_CELL" hermes sessions list --json >/dev/null; then
  echo "disposable_smoke_failed" >&2
  exit 1
fi

if [ "$APPLY" -eq 0 ]; then
  printf '%s\n' '{"ok":true,"mode":"verify-only","disposable":true,"credentials":false}'
  exit 0
fi

docker rm -f "$CHECK_CELL" >/dev/null
CHECK_STARTED=0

test_interrupt() {
  local boundary="$1"
  if [ "${LIGOU_RESTORE_TEST_HARNESS:-0}" = 1 ] && [ "${LIGOU_RESTORE_TEST_INTERRUPT_AFTER:-}" = "$boundary" ]; then
    case "$RESTORE_WORK" in /tmp/*|/var/folders/*) kill -TERM $$ ;; *) echo "restore_test_harness_forbidden" >&2; exit 2 ;; esac
  fi
}

test_interrupt before_cas
if ! activate_volume "$CHECK_VOLUME" "$ACTIVE_COGNITIVE"; then
  echo "restore_stage_activation_failed" >&2
  exit 1
fi
test_interrupt registry_promotion

if ! recreate_cell; then
  if rollback_activation; then
    remove_owned_inactive_stage || true
    echo "restore_activation_failed_rollback_applied" >&2
  else
    echo "restore_activation_failed_rollback_failed" >&2
  fi
  exit 1
fi
test_interrupt container_recreate

if ! live_smoke; then
  if rollback_activation; then
    remove_owned_inactive_stage || true
    echo "restore_health_failed_rollback_applied" >&2
  else
    echo "restore_health_failed_rollback_failed" >&2
  fi
  exit 1
fi
test_interrupt live_smoke

CHECK_CREATED=0
printf '{"ok":true,"mode":"apply","disposable":true,"staged_volume":true,"archive_id":"%s"}\n' "$ARCHIVE_ID"
