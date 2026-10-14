"""Precheck for the Hermes cron job substrate-skill-miner (D-13).

Hermes runs the job's --monitor-script before every tick and suppresses the agent run when the
script's stdout is byte-identical to the previous tick's. So the output carries no timestamps: the
newest 100 captured Cursor transcripts (by mtime, listed sorted by id) and today's UTC date, which
changes once a day and so gives the miner its daily pass over other surfaces' sessions.
"""

from __future__ import annotations

from pathlib import Path

TRANSCRIPTS = Path("/var/lib/substrate/transcripts/cursor")
NEWEST = 100


def monitor_output(directory: Path | str = TRANSCRIPTS, today: str = "") -> str:
    root = Path(directory)
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
