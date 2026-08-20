#!/bin/bash
# Deploy do Ligou para uma EC2 sem porta de entrada: tarball via S3 + comando via SSM.
# Uso: LIGOU_DEPLOY_BUCKET=... LIGOU_INSTANCE_ID=... infra/deploy.sh
set -euo pipefail
export AWS_DEFAULT_REGION="${LIGOU_AWS_REGION:?set LIGOU_AWS_REGION}"
INSTANCE="${LIGOU_INSTANCE_ID:?set LIGOU_INSTANCE_ID}"
BUCKET="${LIGOU_DEPLOY_BUCKET:?set LIGOU_DEPLOY_BUCKET}"
STAMP=$(date +%Y%m%d-%H%M%S)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> packing $ROOT -> s3://$BUCKET/app-$STAMP.tar.gz (instance $INSTANCE)"
tar -C "$ROOT" --exclude node_modules --exclude .git --exclude 'dist' --exclude '.env*' \
  -czf /tmp/ligou-app.tar.gz voice-controller hermes-cell supabase infra
aws s3 cp /tmp/ligou-app.tar.gz "s3://$BUCKET/app-$STAMP.tar.gz" --only-show-errors

echo "==> deploying via SSM"
CMD_ID=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --comment "ligou deploy $STAMP" \
  --parameters "commands=[
    'set -e',
    'aws s3 cp s3://$BUCKET/app-$STAMP.tar.gz /tmp/app.tar.gz --only-show-errors',
    'mkdir -p /opt/ligou/app && rm -rf /opt/ligou/app.new && mkdir /opt/ligou/app.new',
    'tar -xzf /tmp/app.tar.gz -C /opt/ligou/app.new',
    'rm -rf /opt/ligou/app.old && (mv /opt/ligou/app /opt/ligou/app.old 2>/dev/null || true) && mv /opt/ligou/app.new /opt/ligou/app',
    ': > /opt/ligou/env && chmod 600 /opt/ligou/env',
    'install -m 700 /opt/ligou/app/infra/pull-env.sh /opt/ligou/pull-env.sh && /opt/ligou/pull-env.sh',
    'cd /opt/ligou/app/voice-controller && /usr/local/bin/bun install --production 2>&1 | tail -1',
    'systemctl enable ligou-controller >/dev/null 2>&1 || true',
    'systemctl restart ligou-controller && sleep 2 && systemctl is-active ligou-controller'
  ]" --query Command.CommandId --output text)
echo "command: $CMD_ID"
for i in $(seq 1 30); do
  STATUS=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  [ "$STATUS" = "Success" ] && break
  [ "$STATUS" = "Failed" ] && { aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE" --query StandardErrorContent --output text | tail -20; exit 1; }
  sleep 5
done
echo "==> status: $STATUS"
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE" --query StandardOutputContent --output text | tail -5
