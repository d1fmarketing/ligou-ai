#!/usr/bin/env python3
"""Fail closed while adding a dedicated Hermes authentication filesystem."""

import os
from pathlib import Path


AUTH_PATH = Path(os.environ.get("LIGOU_HERMES_AUTH_SOURCE", "/opt/hermes/hermes_cli/auth.py"))
STAGE2_PATH = Path(os.environ.get("LIGOU_HERMES_STAGE2_SOURCE", "/opt/hermes/docker/stage2-hook.sh"))


def replace_exact(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"patch_source_mismatch:{label}:{count}")
    return text.replace(old, new, 1)


auth = AUTH_PATH.read_text(encoding="utf-8")
auth = replace_exact(
    auth,
    'def _auth_file_path() -> Path:\n    path = get_hermes_home() / "auth.json"\n',
    '''def _auth_home_path() -> Path:
    raw = os.environ.get("HERMES_AUTH_HOME", "").strip()
    if not raw:
        return get_hermes_home()
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise RuntimeError("auth_home_must_be_absolute")
    auth_home = candidate.resolve(strict=False)
    hermes_home = get_hermes_home().resolve(strict=False)
    if auth_home == hermes_home:
        raise RuntimeError("auth_home_must_not_equal_hermes_home")
    try:
        auth_home.relative_to(hermes_home)
    except ValueError:
        pass
    else:
        raise RuntimeError("auth_home_must_not_be_inside_hermes_home")
    try:
        hermes_home.relative_to(auth_home)
    except ValueError:
        pass
    else:
        raise RuntimeError("hermes_home_must_not_be_inside_auth_home")
    return auth_home


def _auth_file_path() -> Path:
    path = _auth_home_path() / "auth.json"
''',
    "auth_file_path",
)
auth = replace_exact(
    auth,
    '    try:\n        from hermes_constants import get_default_hermes_root\n',
    '''    if os.environ.get("HERMES_AUTH_HOME", "").strip():
        # The dedicated auth root is canonical. Never fall back to cognitive state.
        return None
    try:
        from hermes_constants import get_default_hermes_root
''',
    "global_auth_fallback",
)
AUTH_PATH.write_text(auth, encoding="utf-8")


stage2 = STAGE2_PATH.read_text(encoding="utf-8")
stage2 = replace_exact(
    stage2,
    'HERMES_HOME="${HERMES_HOME:-/opt/data}"\nINSTALL_DIR="/opt/hermes"\n',
    'HERMES_HOME="${HERMES_HOME:-/opt/data}"\nHERMES_AUTH_HOME="${HERMES_AUTH_HOME:-$HERMES_HOME}"\nINSTALL_DIR="/opt/hermes"\n',
    "stage2_auth_env",
)
stage2 = replace_exact(
    stage2,
    'actual_hermes_uid=$(id -u hermes)\n\npath_has_symlink_component() {\n',
    '''actual_hermes_uid=$(id -u hermes)

auth_home_resolved="$(realpath -m "$HERMES_AUTH_HOME")"
hermes_home_resolved="$(realpath -m "$HERMES_HOME")"
case "$HERMES_AUTH_HOME" in
    /*) ;;
    *) echo "[stage2] ERROR: auth_home_must_be_absolute" >&2; exit 1 ;;
esac
if [ "$auth_home_resolved" = "$hermes_home_resolved" ]; then
    echo "[stage2] ERROR: auth_home_must_not_equal_hermes_home" >&2
    exit 1
fi
case "$auth_home_resolved/" in
    "$hermes_home_resolved/"*) echo "[stage2] ERROR: auth_home_must_not_be_inside_hermes_home" >&2; exit 1 ;;
esac
case "$hermes_home_resolved/" in
    "$auth_home_resolved/"*) echo "[stage2] ERROR: hermes_home_must_not_be_inside_auth_home" >&2; exit 1 ;;
esac
mkdir -p "$HERMES_AUTH_HOME"
chown hermes:hermes "$HERMES_AUTH_HOME"
chmod 700 "$HERMES_AUTH_HOME"
for auth_file in auth.json auth.lock; do
    if [ -e "$HERMES_AUTH_HOME/$auth_file" ]; then
        chown hermes:hermes "$HERMES_AUTH_HOME/$auth_file"
        chmod 600 "$HERMES_AUTH_HOME/$auth_file"
    fi
done

path_has_symlink_component() {
''',
    "stage2_auth_bootstrap",
)
stage2 = replace_exact(
    stage2,
    '    auth.json auth.lock .env \\\n',
    '    .env \\\n',
    "stage2_loose_auth_files",
)
stage2 = stage2.replace('"$HERMES_HOME/auth.json"', '"$HERMES_AUTH_HOME/auth.json"')
if '"$HERMES_HOME/auth.json"' in stage2:
    raise SystemExit("patch_source_mismatch:stage2_auth_references_remaining")
STAGE2_PATH.write_text(stage2, encoding="utf-8")
