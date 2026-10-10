"""Precheck for the Hermes cron job substrate-skill-miner (D22-16).

Hermes runs the job's --monitor-script before every tick and suppresses the agent run when the
script's stdout is byte-identical to the previous tick's. So the output carries no timestamps: the
newest 100 captured Cursor transcripts (by mtime, listed sorted by id with a content fingerprint)
and today's UTC date, which changes once a day and so gives the miner its daily pass over other
surfaces' sessions.

The fingerprint is the sha256 of the transcript bytes: copyTranscript replaces the same jsonl in
place, so an id alone cannot signal a new capture — a changed transcript prints a new line and the
miner runs, while an unchanged tick stays byte-identical and is skipped.

The transcripts directory is SUBSTRATE_TRANSCRIPTS_DIR when set (Phase 19's hook honors the same
variable), else the production default below. Tests always pass an explicit directory or point the
variable at a tmp dir; this module never falls back to reading anywhere else.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Mapping

TRANSCRIPTS = Path("/var/lib/substrate/transcripts/cursor")
TRANSCRIPTS_DIR_VAR = "SUBSTRATE_TRANSCRIPTS_DIR"
NEWEST = 100

def transcripts_dir(env: Mapping[str, str] | None = None) -> Path:
    """The transcripts directory: the override variable when set, else production default.

    A blank value counts as unset. Never touches the filesystem, never raises.
    """
    if env is None:
        env = os.environ
    override = (env.get(TRANSCRIPTS_DIR_VAR) or "").strip()
    return Path(override) if override else TRANSCRIPTS


def _fingerprint(path: Path) -> str:
    """The first 16 hex chars of the file's sha256, or "unreadable" when it cannot be read.

    Never raises. A stable marker either way: an unreadable file prints the same line every
    tick, and a file that becomes readable (or changes content) prints a new line.
    """
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    except OSError:
        return "unreadable"


def monitor_output(directory: Path | str | None = None, today: str = "") -> str:
    root = Path(directory) if directory is not None else transcripts_dir()
    # Cut to the newest 100 by mtime before hashing. Older retained
    # conversations are not read: their fingerprints would be discarded.
    candidates: list[tuple[float, str, Path]] = []
    if root.is_dir():
        for path in root.glob("*.jsonl"):
            try:
                if path.is_file():
                    candidates.append((path.stat().st_mtime, path.stem, path))
            except OSError:
                continue
    newest = sorted(candidates, key=lambda e: (e[0], e[1]), reverse=True)[:NEWEST]
    lines = [f"transcript {conversation_id} {_fingerprint(path)}" for _, conversation_id, path in
             sorted(newest, key=lambda e: e[1])]
    lines.append(f"day {today}")
    return "\n".join(lines) + "\n"
