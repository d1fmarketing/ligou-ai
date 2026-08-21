#!/usr/bin/env bash
# Consistent cognitive-state backup with an authenticated manifest. The separate Hermes model-auth
# volume is never mounted at /opt/data and is forbidden by the manifest scanner.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${LIGOU_NODE_BIN:-node}"
MANIFEST_TOOL="${ROOT}/infra/backup-manifest.mjs"
IDENTITY_TOOL="${ROOT}/hermes-cell/tenant-identity.mjs"
TENANT="${TENANT_SLUG:?set TENANT_SLUG}"
TENANT_ID="${TENANT_ID:?set TENANT_ID}"
BUCKET="${LIGOU_BACKUP_BUCKET:?set LIGOU_BACKUP_BUCKET}"
SOURCE_ID="${LIGOU_BACKUP_SOURCE_ID:?set LIGOU_BACKUP_SOURCE_ID}"
IMAGE="${HERMES_IMAGE:?set immutable HERMES_IMAGE digest}"
RETENTION_DAYS="${LIGOU_BACKUP_RETENTION_DAYS:-30}"

[[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ ]] || { echo "tenant_invalid" >&2; exit 2; }
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { echo "backup_bucket_invalid" >&2; exit 2; }
[[ "$SOURCE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$ ]] || { echo "backup_source_invalid" >&2; exit 2; }
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -ge 1 ] && [ "$RETENTION_DAYS" -le 3650 ] \
  || { echo "backup_retention_invalid" >&2; exit 2; }
[ -n "${LIGOU_BACKUP_MANIFEST_KEY:-}" ] || { echo "manifest_key_required" >&2; exit 1; }
[[ "$IMAGE" =~ ^[^[:space:]@]+(:[^[:space:]@]+)?@sha256:[a-f0-9]{64}$ ]] || { echo "hermes_image_digest_required" >&2; exit 1; }
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "node_required" >&2; exit 1; }

IDENTITY_JSON="$("$NODE_BIN" "$IDENTITY_TOOL" --tenant-id "$TENANT_ID" --tenant-slug "$TENANT" --json)"
identity_field() {
  "$NODE_BIN" -e 'const value=JSON.parse(process.argv[1]);const field=process.argv[2];if(!Object.hasOwn(value,field))process.exit(1);process.stdout.write(String(value[field]));' "$IDENTITY_JSON" "$1"
}
WORK="$(identity_field backup_work_dir)"
CELL="$(identity_field container_name)"
ARCHIVE_PREFIX="$(identity_field archive_prefix)"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="${ARCHIVE_PREFIX}-${STAMP}.zip"
MANIFEST_NAME="${NAME}.manifest.json"
REMOTE_ARCHIVE="/tmp/${NAME}"
LOCAL_ARCHIVE="${WORK}/${NAME}"
LOCAL_MANIFEST="${WORK}/${MANIFEST_NAME}"

mkdir -p "$WORK"
RUNNING="$(docker inspect --format '{{.State.Running}}' "$CELL" 2>/dev/null || true)"
[ "$RUNNING" = "true" ] || { echo "backup_cell_unavailable" >&2; exit 1; }

cleanup_remote() {
  docker exec "$CELL" rm -f "$REMOTE_ARCHIVE" >/dev/null 2>&1 || true
}
trap cleanup_remote EXIT

docker exec "$CELL" hermes backup -o "$REMOTE_ARCHIVE" >/dev/null
docker cp "${CELL}:${REMOTE_ARCHIVE}" "$LOCAL_ARCHIVE" >/dev/null
cleanup_remote
trap - EXIT

"$NODE_BIN" "$MANIFEST_TOOL" create \
  --archive "$LOCAL_ARCHIVE" \
  --manifest "$LOCAL_MANIFEST" \
  --tenant "$TENANT_ID" \
  --source "$SOURCE_ID" \
  --hermes-image "$IMAGE" \
  --created "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >/dev/null

aws s3 cp "$LOCAL_ARCHIVE" "s3://${BUCKET}/cells/${TENANT_ID}/${NAME}" --sse AES256 --only-show-errors
aws s3 cp "$LOCAL_MANIFEST" "s3://${BUCKET}/cells/${TENANT_ID}/${MANIFEST_NAME}" --sse AES256 --only-show-errors

# Bounded local cleanup only. Remote retention is an S3 lifecycle policy.
find "$WORK" -type f \( -name "hermes-${TENANT}-*.zip" -o -name "hermes-${TENANT}-*.zip.manifest.json" \) \
  -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true

printf '{"ok":true,"tenant":"%s","archive":"%s","manifest":true}\n' "$TENANT" "$NAME"
