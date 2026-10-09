"""The miner cron precheck: deterministic, so an unchanged hour suppresses the Hermes agent run (D22-16).

Plus the miner SKILL.md pins (D22-17): at most 3 skills per run through skill_manage, and no path
into the live checkout. Every test uses tmp dirs or an explicit directory; none reads the real
transcripts directory.
"""

from __future__ import annotations

import os
from pathlib import Path

from substrate_miner.monitor import TRANSCRIPTS, monitor_output, transcripts_dir

SKILL_MD = Path(__file__).resolve().parents[1] / "skills" / "substrate-skill-miner" / "SKILL.md"


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


def test_transcripts_dir_override_selects_env_dir(tmp_path, monkeypatch):
    override = tmp_path / "elsewhere"
    override.mkdir()
    monkeypatch.setenv("SUBSTRATE_TRANSCRIPTS_DIR", str(override))
    assert transcripts_dir() == override
    transcript(override, "a-conv", 100)
    assert monitor_output(None, "2026-09-26") == "transcript a-conv\nday 2026-09-26\n"


def test_blank_override_falls_back_to_production_default(monkeypatch):
    monkeypatch.setenv("SUBSTRATE_TRANSCRIPTS_DIR", "  ")
    assert transcripts_dir() == TRANSCRIPTS


def test_no_override_is_the_production_default(monkeypatch):
    monkeypatch.delenv("SUBSTRATE_TRANSCRIPTS_DIR", raising=False)
    assert transcripts_dir() == TRANSCRIPTS
    assert str(TRANSCRIPTS) == "/var/lib/substrate/transcripts/cursor"


def test_skill_md_pins_at_most_3_through_skill_manage():
    text = SKILL_MD.read_text()
    assert "at most 3" in text
    assert "skill_manage" in text


def test_skill_md_has_no_live_checkout_path():
    text = SKILL_MD.read_text()
    assert "/root/src/" not in text
    assert "/opt/agent-substrate" not in text
