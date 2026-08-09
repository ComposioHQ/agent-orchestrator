#!/usr/bin/env python3
"""Create a consistent, recoverable AO SQLite clone for desktop development."""

from __future__ import annotations

import argparse
import datetime as dt
import os
from pathlib import Path
import sqlite3
import tempfile


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-data-dir", required=True, type=Path)
    parser.add_argument("--target-data-dir", required=True, type=Path)
    return parser.parse_args()


def unique_backup_path(target: Path) -> Path:
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = target.with_name(f"{target.name}.previous-{stamp}")
    suffix = 1
    while candidate.exists():
        candidate = target.with_name(f"{target.name}.previous-{stamp}-{suffix}")
        suffix += 1
    return candidate


def clone_database(source_data_dir: Path, target_data_dir: Path) -> tuple[Path, Path, Path | None]:
    source_db = (source_data_dir.expanduser().resolve() / "ao.db").resolve()
    target_data_dir = target_data_dir.expanduser().resolve()
    target_db = target_data_dir / "ao.db"
    if not source_db.is_file():
        raise FileNotFoundError(f"source AO database does not exist: {source_db}")
    if source_db == target_db:
        raise ValueError("source and target AO databases must be different")

    target_data_dir.parent.mkdir(parents=True, exist_ok=True)
    temporary_dir = Path(tempfile.mkdtemp(prefix=f".{target_data_dir.name}.clone-", dir=target_data_dir.parent))
    temporary_db = temporary_dir / "ao.db"
    backup_path: Path | None = None
    try:
        with sqlite3.connect(f"file:{source_db}?mode=ro", uri=True) as source:
            with sqlite3.connect(temporary_db) as destination:
                source.backup(destination)
                integrity = destination.execute("PRAGMA integrity_check").fetchone()
                if integrity != ("ok",):
                    raise RuntimeError(f"cloned AO database failed integrity check: {integrity!r}")
        os.chmod(temporary_db, 0o600)

        if target_data_dir.exists():
            backup_path = unique_backup_path(target_data_dir)
            target_data_dir.rename(backup_path)
        temporary_dir.rename(target_data_dir)
    except Exception:
        if backup_path is not None and not target_data_dir.exists() and backup_path.exists():
            backup_path.rename(target_data_dir)
        if temporary_dir.exists():
            for child in temporary_dir.iterdir():
                child.unlink()
            temporary_dir.rmdir()
        raise

    return source_db, target_db, backup_path


def main() -> None:
    args = parse_args()
    source, target, previous = clone_database(args.source_data_dir, args.target_data_dir)
    print(f"source={source}")
    print(f"target={target}")
    print(f"previous={previous or ''}")


if __name__ == "__main__":
    main()
