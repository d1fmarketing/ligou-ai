#!/bin/bash
# Deploy do Ligou para a EC2 (ligou-host-01) — sem porta de entrada: tarball via S3 + comando via SSM.
# Uso: infra/deploy.sh [instance-id]
set -euo pipefail
export AWS_DEFAULT_REGION=us-east-1
INSTANCE="${1:-$(aws ec2 describe-instances --filters Name=tag:Name,Values=ligou-host-01 Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)}"
BUCKET=ligou-deploy-330140023537
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
    'for P in \$(aws ssm get-parameters-by-path --path /ligou/ --with-decryption --query \"Parameters[].Name\" --output text --region us-east-1); do K=\$(basename \$P); V=\$(aws ssm get-parameter --name \$P --with-decryption --query Parameter.Value --output text --region us-east-1); echo \"\$K=\$V\" >> /opt/ligou/env; done',
    'cd /opt/ligou/app/voice-controller && /usr/local/bin/bun install --production 2>&1 | tail -1',
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
