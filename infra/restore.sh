#!/usr/bin/env bash
# Plan v4 §4 — a backup nobody restored is a rumour. Verifies checksum, then restores a cell's cognitive
# state (memory, skills, sessions, config) from S3. By default it VERIFIES into a scratch dir without
# touching the live cell; pass --apply to actually replace the running cell's state.
#
#   infra/restore.sh                      # verify the latest backup end-to-end (safe, default)
#   infra/restore.sh --apply              # restore the latest into the live cell (stops/starts it)
#   infra/restore.sh --key <s3-key>       # pick a specific archive
set -euo pipefail

TENANT="${TENANT_SLUG:-rocha-plumbing}"
CELL="ligou-cell-${TENANT}"
BUCKET="${LIGOU_BACKUP_BUCKET:-ligou-backups-330140023537}"
APPLY=0
KEY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --key) KEY="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$KEY" ]; then
  KEY="$(aws s3 ls "s3://${BUCKET}/cells/${TENANT}/" | grep -E '\.zip$' | sort | tail -1 | awk '{print $4}')"
  [ -n "$KEY" ] || { echo "restore: no backup found for ${TENANT}" >&2; exit 1; }
fi

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

aws s3 cp "s3://${BUCKET}/cells/${TENANT}/${KEY}" "${SCRATCH}/${KEY}" --only-show-errors
aws s3 cp "s3://${BUCKET}/cells/${TENANT}/${KEY}.sha256" "${SCRATCH}/${KEY}.sha256" --only-show-errors 2>/dev/null || true

# 1) integrity
if [ -f "${SCRATCH}/${KEY}.sha256" ]; then
  EXPECTED="$(awk '{print $1}' "${SCRATCH}/${KEY}.sha256")"
  ACTUAL="$(sha256sum "${SCRATCH}/${KEY}" | awk '{print $1}')"
  [ "$EXPECTED" = "$ACTUAL" ] || { echo "restore: CHECKSUM MISMATCH — refusing" >&2; exit 1; }
  echo "checksum ok (${ACTUAL:0:12}…)"
fi

# 2) content proof — a valid cell backup must carry real state, not an empty shell
unzip -qq -o "${SCRATCH}/${KEY}" -d "${SCRATCH}/extracted"
FOUND_DB="$(find "${SCRATCH}/extracted" -name 'state.db' | head -1 || true)"
[ -n "$FOUND_DB" ] || { echo "restore: archive has no state.db — not a usable cell backup" >&2; exit 1; }
if command -v sqlite3 >/dev/null 2>&1; then
  INTEG="$(sqlite3 "$FOUND_DB" 'pragma integrity_check;' 2>/dev/null | head -1)"
  [ "$INTEG" = "ok" ] || { echo "restore: sqlite integrity_check said '${INTEG}'" >&2; exit 1; }
  echo "sqlite integrity ok"
fi
echo "archive verified: $(du -h "${SCRATCH}/${KEY}" | awk '{print $1}'), state.db present"

if [ "$APPLY" -eq 0 ]; then
  echo "VERIFY-ONLY (default). Re-run with --apply to restore into the live cell."
  exit 0
fi

# 3) apply: stop the cell, swap state, start it back
echo "applying restore into ${CELL}…"
docker stop "$CELL" >/dev/null
docker cp "${SCRATCH}/${KEY}" "${CELL}:/tmp/restore.zip"
docker start "$CELL" >/dev/null
sleep 5
docker exec "$CELL" sh -c 'hermes import /tmp/restore.zip --yes 2>/dev/null || hermes import /tmp/restore.zip; rm -f /tmp/restore.zip'
docker restart "$CELL" >/dev/null
echo "restore applied — verify with: docker exec ${CELL} hermes auth status openai-codex"
