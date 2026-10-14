"""The miner cron precheck: deterministic, so an unchanged hour suppresses the Hermes agent run (D-13)."""

from __future__ import annotations

import os
from pathlib import Path

from substrate_miner.monitor import monitor_output


def transcript(directory: Path, conversation_id: str, mtime: int) -> None:
    path = directory / f"{conversation_id}.jsonl"
    path.write_text("{}\n")
    os.utime(path, (mtime, mtime))


def test_lists_transcripts_sorted_by_id_then_the_day(tmp_path):
    transcript(tmp_path, "c-conv", 300)
    transcript(tmp_path, "a-conv", 100)
    transcript(tmp_path, "b-conv", 200)
    (tmp_path / "notes.txt").write_text("ignored")
    assert monitor_output(tmp_path, "2026-09-26") == (
        "transcript a-conv\ntranscript b-conv\ntranscript c-conv\nday 2026-09-26\n"
    )


def test_keeps_only_the_newest_100_by_mtime(tmp_path):
    for i in range(105):
        transcript(tmp_path, f"conv-{i:03d}", 1_000 + i)
    lines = monitor_output(tmp_path, "2026-09-26").splitlines()
    ids = [line.split(" ", 1)[1] for line in lines[:-1]]
    assert len(ids) == 100
    assert ids == sorted(ids)
    assert "conv-004" not in ids and "conv-005" in ids and "conv-104" in ids


def test_is_byte_identical_when_nothing_changed(tmp_path):
    transcript(tmp_path, "a-conv", 100)
    assert monitor_output(tmp_path, "2026-09-26") == monitor_output(tmp_path, "2026-09-26")


def test_missing_dir_yields_only_the_day_line(tmp_path):
    assert monitor_output(tmp_path / "absent", "2026-09-26") == "day 2026-09-26\n"
