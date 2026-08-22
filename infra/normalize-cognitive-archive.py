#!/usr/bin/env python3
"""Repack a raw `hermes backup` zip under the single cognitive/ root that
archive-safety and the restore pipeline require.

The raw archive comes from our own cell, but a compromised cell must not be
able to smuggle entries past the signed manifest, so names, entry types and
size budgets are enforced here fail-closed with the same rules archive-safety
applies afterwards. Directory entries are preserved (an empty memory/ root is
a legal cognitive state); symlinks and other non-regular entries abort."""
import argparse
import json
import os
import re
import stat
import sys
import zipfile

MAX_FILES = 10_000
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
FORBIDDEN_SEGMENTS = {
    ".hermes", ".codex", ".ssh", "hermes-model-auth", "model-auth",
    "credentials", "secrets", "tokens",
}
FORBIDDEN_BASENAMES = {"auth.json", "credentials.json", "id_rsa", "id_ed25519", "docker.sock"}
SENSITIVE_SEGMENT = re.compile(r"credential|secret|access[_-]?token|refresh[_-]?token")
NESTED_ARCHIVE = re.compile(r"\.(?:zip|tar|tgz|gz|7z|rar)$")
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def fail(token):
    print(token, file=sys.stderr)
    sys.exit(1)


def validate_name(name):
    if not name or CONTROL_CHARS.search(name) or name.startswith("/") or "\\" in name:
        fail("normalize_forbidden_path")
    segments = [segment for segment in name.split("/") if segment]
    if not segments or any(segment in ("..", ".") for segment in segments):
        fail("normalize_forbidden_path")
    lower = [segment.lower() for segment in segments]
    if any(segment in FORBIDDEN_SEGMENTS for segment in lower):
        fail("normalize_forbidden_path")
    if any(segment == ".env" or segment.startswith(".env.") for segment in lower):
        fail("normalize_forbidden_path")
    if lower[-1] in FORBIDDEN_BASENAMES:
        fail("normalize_forbidden_path")
    if any(SENSITIVE_SEGMENT.search(segment) for segment in lower):
        fail("normalize_forbidden_path")
    if not name.endswith("/") and NESTED_ARCHIVE.search(lower[-1]):
        fail("normalize_forbidden_path")


def write_normalized(source, infos, scratch):
    actual_total = 0
    with zipfile.ZipFile(scratch, "w", zipfile.ZIP_DEFLATED) as target:
        for info in sorted(infos, key=lambda entry: entry.filename):
            renamed = f"cognitive/{info.filename}"
            if info.is_dir():
                directory = zipfile.ZipInfo(
                    renamed if renamed.endswith("/") else f"{renamed}/",
                    date_time=info.date_time,
                )
                directory.external_attr = info.external_attr
                target.writestr(directory, b"")
                continue
            with source.open(info) as reader:
                payload = reader.read(MAX_FILE_BYTES + 1)
            if len(payload) != info.file_size or len(payload) > MAX_FILE_BYTES:
                fail("normalize_size_mismatch")
            actual_total += len(payload)
            if actual_total > MAX_EXPANDED_BYTES:
                fail("normalize_expanded_too_large")
            entry = zipfile.ZipInfo(renamed, date_time=info.date_time)
            entry.external_attr = info.external_attr
            entry.compress_type = zipfile.ZIP_DEFLATED
            target.writestr(entry, payload)


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        source = zipfile.ZipFile(args.input)
    except (OSError, zipfile.BadZipFile):
        fail("normalize_input_unreadable")

    infos = source.infolist()
    seen = set()
    file_count = 0
    declared_total = 0
    for info in infos:
        validate_name(info.filename)
        normalized = info.filename.rstrip("/")
        if normalized in seen:
            fail("normalize_duplicate_entry")
        seen.add(normalized)
        if info.is_dir():
            continue
        mode = info.external_attr >> 16
        if mode and not stat.S_ISREG(mode):
            fail("normalize_non_regular_entry")
        file_count += 1
        declared_total += info.file_size
        if info.file_size > MAX_FILE_BYTES:
            fail("normalize_file_too_large")
    if file_count > MAX_FILES:
        fail("normalize_too_many_files")
    if declared_total > MAX_EXPANDED_BYTES:
        fail("normalize_expanded_too_large")

    scratch = f"{args.output}.tmp"
    try:
        write_normalized(source, infos, scratch)
    except BaseException:
        try:
            os.remove(scratch)
        except OSError:
            pass
        raise
    os.replace(scratch, args.output)
    os.chmod(args.output, 0o600)
    print(json.dumps({"ok": True, "files": file_count, "bytes": os.path.getsize(args.output)}))


if __name__ == "__main__":
    main()
