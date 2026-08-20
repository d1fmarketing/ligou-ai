#!/usr/bin/env bash
# Plan v4 §4 — the cell's cognitive state is part of the AgentSpace, not a disposable cache.
# An EBS snapshot taken while SQLite is live can capture a torn database, so the real backup uses
# `hermes backup` (consistent archive of config, skills, sessions and state.db) + checksum + S3 per tenant.
# EBS snapshots stay as disaster recovery for the whole host.
#
# Runs ON the EC2 (invoked by the ligou-backup systemd timer). Restore: infra/restore.sh
set -euo pipefail

TENANT="${TENANT_SLUG:?set TENANT_SLUG}"
CELL="ligou-cell-${TENANT}"
BUCKET="${LIGOU_BACKUP_BUCKET:?set LIGOU_BACKUP_BUCKET}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="/opt/ligou/backups"
NAME="hermes-${TENANT}-${STAMP}.zip"
RETENTION_DAYS="${LIGOU_BACKUP_RETENTION_DAYS:-30}"

mkdir -p "$WORK"

if ! docker ps --format '{{.Names}}' | grep -qx "$CELL"; then
  echo "backup: cell $CELL is not running — nothing to back up" >&2
  exit 1
fi

# 1) consistent archive produced INSIDE the container (hermes owns the SQLite handles)
# NOTE: -q makes an internal state-snapshot instead of the archive; the full mode is what honours -o
docker exec "$CELL" hermes backup -o "/tmp/${NAME}" >/dev/null
docker cp "${CELL}:/tmp/${NAME}" "${WORK}/${NAME}"
docker exec "$CELL" rm -f "/tmp/${NAME}"

# 2) integrity proof travels with the artifact
SHA="$(sha256sum "${WORK}/${NAME}" | awk '{print $1}')"
SIZE="$(stat -c%s "${WORK}/${NAME}")"
if [ "$SIZE" -lt 1024 ]; then
  echo "backup: archive suspiciously small (${SIZE} bytes) — refusing to upload" >&2
  exit 1
fi
echo "${SHA}  ${NAME}" > "${WORK}/${NAME}.sha256"

# 3) upload per tenant (SSE-S3 at rest; bucket is private)
aws s3 cp "${WORK}/${NAME}" "s3://${BUCKET}/cells/${TENANT}/${NAME}" --sse AES256 --only-show-errors
aws s3 cp "${WORK}/${NAME}.sha256" "s3://${BUCKET}/cells/${TENANT}/${NAME}.sha256" --sse AES256 --only-show-errors

# 4) local retention (S3 lifecycle handles the remote side)
find "$WORK" -name "hermes-${TENANT}-*.zip*" -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true

echo "backup ok: ${NAME} (${SIZE} bytes, sha256 ${SHA:0:12}…) -> s3://${BUCKET}/cells/${TENANT}/"
