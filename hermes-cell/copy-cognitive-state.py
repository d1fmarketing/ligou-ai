#!/usr/bin/env python3
"""Verified one-way copy from a stopped legacy Hermes volume into cognition."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat


EXCLUDED_PARTS = {
    ".cache",
    ".codex",
    ".git",
    ".ssh",
    "backups",
    "lazy-packages",
    "model-auth",
    "node_modules",
    "state-snapshots",
}
EXCLUDED_NAMES = {
    ".env",
    "auth.json",
    "auth.lock",
    "credentials.json",
    "cron.pid",
    "gateway.lock",
    "gateway.pid",
    "gateway_state.json",
    "processes.json",
}
REQUIRED_PATHS = ("memories", "skills", "sessions", "state.db")


def excluded(relative: Path) -> bool:
    lowered = tuple(part.lower() for part in relative.parts)
    return bool(set(lowered) & EXCLUDED_PARTS) or (lowered and lowered[-1] in EXCLUDED_NAMES)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inventory(root: Path) -> tuple[list[Path], list[tuple[str, int, str]]]:
    directories: list[Path] = []
    files: list[tuple[str, int, str]] = []
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        relative_root = current_path.relative_to(root)
        kept_dirs = []
        for dirname in sorted(dirnames):
            relative = relative_root / dirname
            candidate = root / relative
            if excluded(relative):
                continue
            if candidate.is_symlink():
                raise RuntimeError("cognitive_symlink_forbidden")
            kept_dirs.append(dirname)
            directories.append(relative)
        dirnames[:] = kept_dirs
        for filename in sorted(filenames):
            relative = relative_root / filename
            if excluded(relative):
                continue
            candidate = root / relative
            info = candidate.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError("cognitive_non_regular_forbidden")
            files.append((relative.as_posix(), info.st_size, sha256(candidate)))
    return sorted(directories), sorted(files)


def clear_destination(destination: Path) -> None:
    for child in destination.iterdir():
        if child.is_symlink() or child.is_file():
            child.unlink()
        elif child.is_dir():
            shutil.rmtree(child)
        else:
            raise RuntimeError("cognitive_destination_non_regular")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    args = parser.parse_args()
    source = Path(args.source).resolve(strict=True)
    destination = Path(args.destination).resolve(strict=True)
    if source == destination or source == Path("/") or destination == Path("/"):
        raise RuntimeError("cognitive_copy_target_invalid")
    for required in REQUIRED_PATHS:
        if not (source / required).exists():
            raise RuntimeError("cognitive_required_state_missing")

    source_dirs, source_files = inventory(source)
    if not source_files:
        raise RuntimeError("cognitive_source_empty")
    clear_destination(destination)
    for relative in source_dirs:
        (destination / relative).mkdir(parents=True, exist_ok=True)
    for relative, _size, _digest in source_files:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, target, follow_symlinks=False)

    _destination_dirs, destination_files = inventory(destination)
    if destination_files != source_files:
        raise RuntimeError("cognitive_copy_verification_failed")
    if any(path.name.lower() == "auth.json" for path in destination.rglob("*")):
        raise RuntimeError("cognitive_auth_forbidden")

    counts = {}
    for required in ("memories", "skills", "sessions"):
        prefix = f"{required}/"
        counts[required] = sum(1 for relative, _size, _digest in source_files if relative.startswith(prefix))
        if counts[required] < 1:
            raise RuntimeError("cognitive_required_state_empty")
    print(json.dumps({
        "ok": True,
        "files": len(source_files),
        "bytes": sum(size for _relative, size, _digest in source_files),
        "required": counts,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
