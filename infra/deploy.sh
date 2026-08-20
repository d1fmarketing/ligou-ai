#!/usr/bin/env bash
# Build one exact clean commit, authenticate its release manifest, upload both objects, then dispatch a
# hash-bound host activation over SSM. This script never embeds secret values in SSM or logs.
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_ROOT="${LIGOU_DEPLOY_SOURCE_ROOT:-$SCRIPT_ROOT}"
NODE_BIN="${LIGOU_NODE_BIN:-node}"
WORK_BASE="${LIGOU_DEPLOY_WORK_DIR:-${TMPDIR:-/tmp}}"
REGION="${LIGOU_AWS_REGION:?set LIGOU_AWS_REGION}"
INSTANCE="${LIGOU_INSTANCE_ID:?set LIGOU_INSTANCE_ID}"
BUCKET="${LIGOU_DEPLOY_BUCKET:?set LIGOU_DEPLOY_BUCKET}"
SOURCE_ID="${LIGOU_DEPLOY_SOURCE_ID:?set LIGOU_DEPLOY_SOURCE_ID}"

[[ "$SOURCE_ROOT" = /* && -d "$SOURCE_ROOT" ]] || { echo "deploy_source_invalid" >&2; exit 2; }
[ "$(git -C "$SOURCE_ROOT" rev-parse --is-inside-work-tree 2>/dev/null || true)" = "true" ] \
  || { echo "deploy_source_invalid" >&2; exit 2; }
[[ "$WORK_BASE" = /* && "$WORK_BASE" != "/" ]] || { echo "deploy_work_dir_invalid" >&2; exit 2; }
[[ "$REGION" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || { echo "deploy_region_invalid" >&2; exit 2; }
[[ "$INSTANCE" =~ ^i-[a-f0-9]{8,32}$ ]] || { echo "deploy_instance_invalid" >&2; exit 2; }
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { echo "deploy_bucket_invalid" >&2; exit 2; }
[[ "$SOURCE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$ ]] || { echo "deploy_source_identity_invalid" >&2; exit 2; }
[ -n "${LIGOU_RELEASE_MANIFEST_KEY:-}" ] || { echo "release_manifest_key_required" >&2; exit 1; }
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "node_required" >&2; exit 1; }

if [ -n "$(git -C "$SOURCE_ROOT" status --porcelain --untracked-files=all)" ]; then
  echo "deploy_source_not_clean" >&2
  exit 1
fi
COMMIT="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "deploy_commit_invalid" >&2; exit 1; }

mkdir -p "$WORK_BASE"
RUN_DIR="$(mktemp -d "${WORK_BASE}/ligou-deploy.XXXXXX")"
cleanup() { rm -rf "$RUN_DIR"; }
trap cleanup EXIT
ARTIFACT="${RUN_DIR}/release.tar.gz"
MANIFEST="${RUN_DIR}/release.tar.gz.manifest.json"

PACKAGE_JSON="$("$NODE_BIN" "$SCRIPT_ROOT/infra/package-release.mjs" \
  --root "$SOURCE_ROOT" --output "$ARTIFACT" --commit "$COMMIT")"
ARTIFACT_HASH="$(printf '%s' "$PACKAGE_JSON" | "$NODE_BIN" -e \
  'let value="";process.stdin.on("data",c=>value+=c).on("end",()=>process.stdout.write(JSON.parse(value).artifact_sha256||""));')"
[[ "$ARTIFACT_HASH" =~ ^[a-f0-9]{64}$ ]] || { echo "deploy_artifact_hash_invalid" >&2; exit 1; }

MANIFEST_JSON="$("$NODE_BIN" "$SCRIPT_ROOT/infra/release-manifest.mjs" create \
  --artifact "$ARTIFACT" --manifest "$MANIFEST" --commit "$COMMIT" --source "$SOURCE_ID" \
  --created "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)")"
RELEASE_ID="$(printf '%s' "$MANIFEST_JSON" | "$NODE_BIN" -e \
  'let value="";process.stdin.on("data",c=>value+=c).on("end",()=>process.stdout.write(JSON.parse(value).release_id||""));')"
[[ "$RELEASE_ID" =~ ^[a-f0-9]{12}-[a-f0-9]{12}$ ]] || { echo "deploy_release_id_invalid" >&2; exit 1; }

S3_PREFIX="releases/${RELEASE_ID}"
aws s3 cp "$ARTIFACT" "s3://${BUCKET}/${S3_PREFIX}/release.tar.gz" --only-show-errors
aws s3 cp "$MANIFEST" "s3://${BUCKET}/${S3_PREFIX}/release.tar.gz.manifest.json" --only-show-errors

REMOTE_COMMAND="set -euo pipefail; \
ART=/tmp/ligou-${RELEASE_ID}.tar.gz; \
MAN=/tmp/ligou-${RELEASE_ID}.manifest.json; \
aws s3 cp s3://${BUCKET}/${S3_PREFIX}/release.tar.gz \$ART --only-show-errors; \
aws s3 cp s3://${BUCKET}/${S3_PREFIX}/release.tar.gz.manifest.json \$MAN --only-show-errors; \
ACTUAL=\$(sha256sum \$ART | awk '{print \$1}'); \
[ \"\$ACTUAL\" = ${ARTIFACT_HASH} ] || { echo release_bootstrap_hash_mismatch >&2; exit 1; }; \
BOOT=\$(mktemp -d /tmp/ligou-bootstrap.XXXXXX); \
trap 'rm -rf \"\$BOOT\" \"\$ART\" \"\$MAN\"' EXIT; \
tar -xzf \$ART -C \$BOOT infra/deploy-host.sh infra/release-manifest.mjs; \
chmod 700 \$BOOT/infra/deploy-host.sh; \
set -a; . /opt/ligou/env; set +a; \
LIGOU_DEPLOY_ROOT=/opt/ligou LIGOU_ENV_FILE=/opt/ligou/env \
  \$BOOT/infra/deploy-host.sh --artifact \$ART --manifest \$MAN --commit ${COMMIT}"
PARAMETERS="$("$NODE_BIN" -e 'process.stdout.write(JSON.stringify({commands:[process.argv[1]]}))' "$REMOTE_COMMAND")"

export AWS_DEFAULT_REGION="$REGION"
COMMAND_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --comment "ligou release ${RELEASE_ID}" \
  --parameters "$PARAMETERS" \
  --query Command.CommandId --output text)"
[[ "$COMMAND_ID" =~ ^[A-Za-z0-9-]{3,128}$ ]] || { echo "deploy_command_id_invalid" >&2; exit 1; }

STATUS=Pending
for _attempt in $(seq 1 30); do
  STATUS="$(aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in
    Success) break ;;
    Failed|Cancelled|TimedOut|Cancelling) echo "deploy_remote_failed:${STATUS}" >&2; exit 1 ;;
  esac
  sleep 5
done
[ "$STATUS" = Success ] || { echo "deploy_remote_timeout" >&2; exit 1; }

# deploy-host emits only a sanitized state JSON object.
aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE" \
  --query StandardOutputContent --output text
