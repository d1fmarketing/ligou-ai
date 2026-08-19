#!/usr/bin/env bash
# Materializa /opt/ligou/env a partir do SSM (/ligou/*).
#
# Por que existe: o deploy antigo fazia `echo "$K=$V"`, e um valor multi-linha (a chave PEM da service
# account do Google) partia o arquivo — o systemd lia só a primeira linha e a variável chegava vazia no
# processo. Sintoma real (2026-08-19): o adapter escolhia o Google (porque GOOGLE_CALENDAR_ID existia),
# a chave vinha undefined, todo freeBusy virava `unknown` e o agente dizia honestamente que não conseguia
# confirmar horário — parecendo "falta credencial" quando a credencial estava lá.
#
# Aqui cada valor vira UMA linha com \n escapado, que é exatamente o formato que calendar.ts espera
# (`GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n")`).
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
ENV_FILE=/opt/ligou/env
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

aws ssm get-parameters-by-path --path /ligou/ --with-decryption --region "$REGION" \
  --query 'Parameters[].[Name,Value]' --output json > "$TMP"

python3 - "$TMP" "$ENV_FILE" <<'PY_INNER'
import json, os, sys
rows = json.load(open(sys.argv[1]))
out = []
for name, value in rows:
    key = name.rsplit("/", 1)[-1]
    # One line per var, SINGLE-QUOTED: values contain spaces ("-----BEGIN PRIVATE KEY-----") and without
    # quotes both bash `source` and systemd EnvironmentFile stop at the first space. Real newlines become
    # the two-character sequence \n, which is what calendar.ts un-escapes.
    v = (value or "").replace(chr(92), chr(92) * 2).replace(chr(10), chr(92) + "n")
    v = v.replace("'", "'\\''")  # close-quote, escaped quote, reopen
    out.append(f"{key}='{v}'")
dst = sys.argv[2]
with open(dst, "w") as f:
    f.write("\n".join(sorted(out)) + "\n")
os.chmod(dst, 0o600)
print(f"env: {len(out)} vars -> {dst}")
PY_INNER
