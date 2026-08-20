#!/usr/bin/env bash
# Safe default: authenticate and import into a disposable, network-isolated cognitive volume.
# --apply is allowed only after disposable memory/skill/session/health smoke checks pass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${LIGOU_NODE_BIN:-node}"
MANIFEST_TOOL="${ROOT}/infra/backup-manifest.mjs"
ARCHIVE_TOOL="${ROOT}/infra/archive-safety.mjs"
HEALTH_TOOL="${ROOT}/hermes-cell/health-state.sh"
TENANT="${TENANT_SLUG:?set TENANT_SLUG}"
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
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "node_required" >&2; exit 1; }
[ -n "${LIGOU_BACKUP_MANIFEST_KEY:-}" ] || { echo "manifest_key_required" >&2; exit 1; }
[[ "$IMAGE" =~ ^[^[:space:]@]+(:[^[:space:]@]+)?@sha256:[a-f0-9]{64}$ ]] || { echo "hermes_image_digest_required" >&2; exit 1; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ligou-restore.XXXXXX")"
CHECK_CELL="restore-check-${TENANT}-$$"
CHECK_VOLUME="restore-check-${TENANT}-$$"
CHECK_CREATED=0
CHECK_STARTED=0

cleanup() {
  set +e
  if [ "$CHECK_STARTED" -eq 1 ]; then docker rm -f "$CHECK_CELL" >/dev/null 2>&1; fi
  if [ "$CHECK_CREATED" -eq 1 ]; then docker volume rm "$CHECK_VOLUME" >/dev/null 2>&1; fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

if [ -n "$LOCAL_ARCHIVE" ] || [ -n "$LOCAL_MANIFEST" ]; then
  [ -n "$LOCAL_ARCHIVE" ] && [ -f "$LOCAL_ARCHIVE" ] || { echo "archive_required" >&2; exit 1; }
  [ -n "$LOCAL_MANIFEST" ] && [ -f "$LOCAL_MANIFEST" ] || { echo "manifest_required" >&2; exit 1; }
  ARCHIVE="$LOCAL_ARCHIVE"
  MANIFEST="$LOCAL_MANIFEST"
else
  BUCKET="${LIGOU_BACKUP_BUCKET:?set LIGOU_BACKUP_BUCKET}"
  if [ -z "$KEY" ]; then
    KEY="$(aws s3 ls "s3://${BUCKET}/cells/${TENANT}/" \
      | awk '{print $4}' | grep -E "^hermes-${TENANT}-[0-9]{8}T[0-9]{6}Z[.]zip$" | sort | tail -1)"
    [ -n "$KEY" ] || { echo "backup_not_found" >&2; exit 1; }
  fi
  [[ "$KEY" =~ ^hermes-${TENANT}-[0-9]{8}T[0-9]{6}Z[.]zip$ ]] || { echo "backup_key_invalid" >&2; exit 2; }
  ARCHIVE="${SCRATCH}/${KEY}"
  MANIFEST="${SCRATCH}/${KEY}.manifest.json"
  aws s3 cp "s3://${BUCKET}/cells/${TENANT}/${KEY}" "$ARCHIVE" --only-show-errors
  aws s3 cp "s3://${BUCKET}/cells/${TENANT}/${KEY}.manifest.json" "$MANIFEST" --only-show-errors
fi

"$NODE_BIN" "$MANIFEST_TOOL" verify --archive "$ARCHIVE" --manifest "$MANIFEST" --tenant "$TENANT" --hermes-image "$IMAGE" >/dev/null
"$NODE_BIN" "$ARCHIVE_TOOL" extract "$ARCHIVE" "${SCRATCH}/validated" >/dev/null

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

CELL="ligou-cell-${TENANT}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_NAME="rollback-${TENANT}-${STAMP}.zip"
ROLLBACK_LOCAL="${SCRATCH}/${ROLLBACK_NAME}"
TARGET_NAME="restore-${TENANT}-${STAMP}.zip"

if ! docker exec "$CELL" hermes backup -o "/tmp/${ROLLBACK_NAME}" >/dev/null \
  || ! docker cp "${CELL}:/tmp/${ROLLBACK_NAME}" "$ROLLBACK_LOCAL" >/dev/null \
  || ! docker exec "$CELL" rm -f "/tmp/${ROLLBACK_NAME}" >/dev/null; then
  echo "rollback_snapshot_failed" >&2
  exit 1
fi

cell_active() {
  [ "$(docker inspect --format '{{.State.Running}}' "$CELL" 2>/dev/null || true)" = "true" ]
}

live_smoke() {
  cell_active \
    && docker exec "$CELL" hermes memory list --json >/dev/null \
    && docker exec "$CELL" hermes skills list --json >/dev/null \
    && docker exec "$CELL" hermes sessions list --json >/dev/null \
    && TENANT_SLUG="$TENANT" HERMES_IMAGE="$IMAGE" "$HEALTH_TOOL" >/dev/null
}

apply_rollback() {
  docker cp "$ROLLBACK_LOCAL" "${CELL}:/tmp/${ROLLBACK_NAME}" >/dev/null \
    && docker exec "$CELL" hermes import "/tmp/${ROLLBACK_NAME}" --yes >/dev/null \
    && docker restart "$CELL" >/dev/null \
    && live_smoke
}

if ! docker cp "$ARCHIVE" "${CELL}:/tmp/${TARGET_NAME}" >/dev/null \
  || ! docker exec "$CELL" hermes import "/tmp/${TARGET_NAME}" --yes >/dev/null \
  || ! docker restart "$CELL" >/dev/null; then
  if apply_rollback; then
    echo "restore_import_failed_rollback_applied" >&2
  else
    echo "restore_import_failed_rollback_failed" >&2
  fi
  exit 1
fi

if ! live_smoke; then
  if apply_rollback; then
    echo "restore_health_failed_rollback_applied" >&2
  else
    echo "restore_health_failed_rollback_failed" >&2
  fi
  exit 1
fi

docker exec "$CELL" rm -f "/tmp/${TARGET_NAME}" "/tmp/${ROLLBACK_NAME}" >/dev/null 2>&1 || true
printf '%s\n' '{"ok":true,"mode":"apply","disposable":true,"rollback_snapshot":true}'
