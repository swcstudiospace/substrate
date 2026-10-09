"""Precheck for the Hermes cron job substrate-skill-miner (D22-16).

Hermes runs the job's --monitor-script before every tick and suppresses the agent run when the
script's stdout is byte-identical to the previous tick's. So the output carries no timestamps: the
newest 100 captured Cursor transcripts (by mtime, listed sorted by id) and today's UTC date, which
changes once a day and so gives the miner its daily pass over other surfaces' sessions.

The transcripts directory is SUBSTRATE_TRANSCRIPTS_DIR when set (Phase 19's hook honors the same
variable), else the production default below. Tests always pass an explicit directory or point the
variable at a tmp dir; this module never falls back to reading anywhere else.
"""

from __future__ import annotations

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


def monitor_output(directory: Path | str | None = None, today: str = "") -> str:
    root = Path(directory) if directory is not None else transcripts_dir()
    entries: list[tuple[float, str]] = []
    if root.is_dir():
        for path in root.glob("*.jsonl"):
            try:
                if path.is_file():
                    entries.append((path.stat().st_mtime, path.stem))
            except OSError:
                continue
    newest = sorted(entries, key=lambda e: (e[0], e[1]), reverse=True)[:NEWEST]
    lines = [f"transcript {conversation_id}" for conversation_id in sorted(cid for _, cid in newest)]
    lines.append(f"day {today}")
    return "\n".join(lines) + "\n"
