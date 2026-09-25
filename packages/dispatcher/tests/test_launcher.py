"""D-13 launcher: argv, scrubbed environment, template-only prompt and the launch side effects."""

from __future__ import annotations

import inspect
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from substrate_dispatcher.launcher import build_argv, child_env, launch, render_prompt

IDS = dict(
    identifier="SWC-465",
    graph_id="ut-mugb3vwa-c57eb6ac",
    node_id="n1",
    repo="swcstudiospace/agent-substrate",
    worktree="/var/lib/substrate/worktrees/ut-mugb3vwa-c57eb6ac",
)
SURFACE = '"surface":"hermes"'


def test_build_argv_shape_without_yolo_or_handoff_wrapper():
    argv = build_argv(
        "/state/prompts/p.md", hermes_bin="/usr/local/bin/hermes", toolsets="terminal,file",
        max_turns=60, run_budget=3600, model="",
    )
    assert argv == [
        "/usr/local/bin/hermes", "chat", "--query-file", "/state/prompts/p.md", "-Q",
        "--pass-session-id", "--source", "substrate-dispatcher", "--max-turns", "60",
        "--run-budget", "3600", "-t", "terminal,file",
    ]
    assert "--yolo" not in argv
    assert "--worktree" not in argv
    assert not any("dispatch_handoff" in part for part in argv)


def test_build_argv_passes_the_dispatch_model_last():
    argv = build_argv(
        "/state/prompts/p.md", hermes_bin="/usr/local/bin/hermes", toolsets="terminal,file",
        max_turns=60, run_budget=3600, model="claude-opus-5.5",
    )
    assert argv[-4:] == ["-t", "terminal,file", "-m", "claude-opus-5.5"]
    assert argv.count("-m") == 1


def test_dispatch_model_comes_from_env_and_unset_means_hermes_default():
    # Imported fresh so the module-level default reads the environment each time.
    base = {k: v for k, v in os.environ.items() if k != "SUBSTRATE_DISPATCH_MODEL"}
    base["PYTHONPATH"] = os.pathsep.join(sys.path)
    code = "from substrate_dispatcher.launcher import build_argv; print(build_argv('/p.md'))"
    unset = subprocess.run([sys.executable, "-c", code], env=base, capture_output=True, text=True, check=True)
    assert "'-m'" not in unset.stdout
    set_ = subprocess.run(
        [sys.executable, "-c", code], env={**base, "SUBSTRATE_DISPATCH_MODEL": "claude-opus-5.5"},
        capture_output=True, text=True, check=True,
    )
    assert "'-m', 'claude-opus-5.5'" in set_.stdout


def test_default_toolsets_are_builtins_without_mcp_linear():
    # 02-09: Hermes v0.21.4 rejects "mcp-linear"; import fresh with the override unset.
    env = {k: v for k, v in os.environ.items() if k != "SUBSTRATE_DISPATCH_TOOLSETS"}
    env["PYTHONPATH"] = os.pathsep.join(sys.path)
    default = subprocess.run(
        [sys.executable, "-c", "from substrate_dispatcher.launcher import DEFAULT_TOOLSETS as t; print(t)"],
        env=env, capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert default == "terminal,file"
    assert not any(t.startswith("mcp-") for t in default.split(","))


def test_child_env_keeps_allowlist_and_drops_secrets():
    env = child_env({
        "HOME": "/root", "PATH": "/usr/bin", "LINEAR_API_KEY": "k", "SUBSTRATE_PG_URL": "p",
        "GREPTIME_PASSWORD": "g", "NOTION_API_KEY": "n",
    })
    assert env == {"HOME": "/root", "PATH": "/usr/bin", "TERM": "dumb"}


def test_child_env_defaults_home():
    assert child_env({"PATH": "/usr/bin"})["HOME"] == "/root"


def test_render_prompt_carries_ids_and_claim_first():
    prompt = render_prompt(**IDS)
    for value in IDS.values():
        assert value in prompt
    assert "graph_claim" in prompt
    assert SURFACE in prompt
    assert prompt.index("graph_claim") < prompt.index("graph_complete")


def test_render_prompt_step4_completes_as_hermes_with_the_claim_session():
    prompt = render_prompt(**IDS)
    step4 = prompt[prompt.index("(4)"):prompt.index("(5)")]
    assert "graph_complete" in step4
    assert SURFACE in step4
    assert "session id" in step4
    assert "same session id" in step4


def _tool_arguments(prompt: str, name: str) -> dict:
    """The JSON arguments of the prompt's tools/call for `name`, parsed from the curl line."""
    match = re.search(r'"name":"%s","arguments":(\{.*?\})\}\}' % re.escape(name), prompt)
    assert match, f"no tools/call for {name}"
    return json.loads(match.group(1))


def test_render_prompt_step3_fetches_the_issue_with_issue_get_for_its_own_ids():
    # Regression: WR-05 — the prompt used to point at a Linear tool Hermes does not have.
    prompt = render_prompt(**IDS)
    assert _tool_arguments(prompt, "issue_get") == {"graph_id": IDS["graph_id"], "node_id": IDS["node_id"]}


def test_render_prompt_orders_claim_then_issue_get_then_complete():
    prompt = render_prompt(**IDS)
    assert prompt.index("graph_claim") < prompt.index('"name":"issue_get"') < prompt.index("graph_complete")


def test_render_prompt_step5_releases_as_hermes_with_the_claim_session_and_stops():
    prompt = render_prompt(**IDS)
    assert prompt.index("(4)") < prompt.index("(5)")
    step5 = prompt[prompt.index("(5)"):]
    args = _tool_arguments(step5, "graph_release")
    assert args["graph_id"] == IDS["graph_id"]
    assert args["node_id"] == IDS["node_id"]
    assert args["surface"] == "hermes"
    assert "session_id" in args
    assert "same session id you passed to graph_claim" in step5
    assert "stop" in step5


def test_render_prompt_step3_frames_issue_text_as_a_task_description_without_an_own_linear_tool():
    prompt = render_prompt(**IDS)
    step3 = prompt[prompt.index("(3)"):prompt.index("(4)")]
    assert "Linear tool" not in prompt
    assert "UNTRUSTED" in step3
    assert "task description only" in step3


def test_render_prompt_takes_ids_only_and_no_issue_text():
    assert set(inspect.signature(render_prompt).parameters) == {"identifier", "graph_id", "node_id", "repo", "worktree"}


@pytest.mark.parametrize(
    "field, bad",
    [
        ("identifier", "swc-465"),
        ("identifier", "SWC-465; rm -rf /"),
        ("node_id", "n1 extra"),
        ("node_id", "x" * 33),
        ("graph_id", "../etc"),
        ("repo", "a/../b"),
        ("worktree", "relative/path"),
    ],
)
def test_render_prompt_rejects_unvalidated_values(field, bad):
    with pytest.raises(ValueError):
        render_prompt(**{**IDS, field: bad})


class FakePopen:
    def __init__(self) -> None:
        self.calls: list[tuple[list[str], dict]] = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        return type("Proc", (), {"pid": 4242})()


def test_launch_writes_private_prompt_and_starts_hermes_in_worktree(tmp_path: Path):
    popen = FakePopen()
    worktree = tmp_path / "wt" / IDS["graph_id"]
    environ = {"HOME": "/root", "PATH": "/usr/bin", "LINEAR_API_KEY": "k"}

    launched = launch(
        **{**IDS, "worktree": worktree}, popen=popen, state_dir=tmp_path / "state",
        environ=environ, clock=lambda: 1_790_000_000.0,
    )

    (argv, kwargs), = popen.calls
    assert launched.pid == 4242
    assert launched.prompt_path.parent == tmp_path / "state" / "prompts"
    assert launched.log_path.parent == tmp_path / "state" / "sessions"
    assert launched.prompt_path.name == f"{IDS['graph_id']}-n1-20260921T141320Z.md"
    assert launched.log_path.exists()
    assert stat.S_IMODE(launched.prompt_path.stat().st_mode) == 0o600
    assert launched.prompt_path.read_text() == render_prompt(**{**IDS, "worktree": worktree})
    assert argv[:4] == [argv[0], "chat", "--query-file", str(launched.prompt_path)]
    assert "--yolo" not in argv
    assert kwargs["cwd"] == str(worktree)
    assert kwargs["env"] == {"HOME": "/root", "PATH": "/usr/bin", "TERM": "dumb"}
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["stderr"] is subprocess.STDOUT
    assert kwargs["stdout"].name == str(launched.log_path)


def test_launch_propagates_spawn_failure_and_closes_log(tmp_path: Path):
    opened = []

    def popen(argv, **kwargs):
        opened.append(kwargs["stdout"])
        raise FileNotFoundError(argv[0])

    with pytest.raises(FileNotFoundError):
        launch(**IDS, popen=popen, state_dir=tmp_path / "state", environ={})
    assert opened[0].closed
