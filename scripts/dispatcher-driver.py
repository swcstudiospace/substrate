#!/usr/bin/env python3
"""Dispatcher rehearsal driver (Phase 24, DISP-08 rehearsal half).

End-to-end through the REAL dispatcher wiring — real ``tick``/``reap``,
real ``make_launch_fn``, real ``launcher.launch`` (real argv + cwd + env into
a fake ``hermes`` shell script), real git worktrees — with every external
faked: Linear and substrate-mcp over ``httpx.MockTransport``, the repo and
worktree roots under a tmp run dir, the state dir under tmp.

Nothing here may touch production: the run dir must be under the system tmp
dir (asserted), ports are never opened (transports only), and no real key is
ever read. The bun wrapper (``scripts/dispatcher-smoke.ts``) covers the
wire-level CLI layer against loopback HTTP fakes; this driver covers the
process-level layer (spawn, git, watch, persistence).

Exit 0: every scenario passed. Exit 1: a scenario failed (names it).
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
import tempfile
from functools import partial
from pathlib import Path

import httpx

from substrate_dispatcher import dispatch, launcher, worktree
from substrate_dispatcher.dispatch import tick
from substrate_dispatcher.host import HostRefused
from substrate_dispatcher.linear import Candidate
from substrate_dispatcher.sessions import SessionRegistry
from substrate_dispatcher.worktree import WorktreeRefused

SLUG = "rhsmoke/smoke-repo"
REPO_NAME = "smoke-repo"
GID = ""
FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'} {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


class World:
    """Fake Linear + fake MCP over MockTransport, with scenario state per graph."""

    def __init__(self, run_dir: Path):
        self.run_dir = run_dir
        self.candidates: list[Candidate] = []
        self.comments: dict[str, list[str]] = {}
        self.label_removals: list[tuple[str, str]] = []
        self.graphs: dict[str, dict] = {}
        self.events: list[dict] = {}
        self.graph_find_calls: list[str] = []
        self.linear_auths: list[str | None] = []
        self.mcp_auths: list[str | None] = []

    # -- Linear -----------------------------------------------------------
    def linear_handler(self, request: httpx.Request) -> httpx.Response:
        self.linear_auths.append(request.headers.get("Authorization"))
        body = json.loads(request.content)
        query, variables = body["query"], body.get("variables") or {}
        if "DispatchCandidates" in query:
            return httpx.Response(200, json={"data": {"issues": {"nodes": [self._issue(c) for c in self.candidates]}}})
        if "IssueComments" in query:
            issue_id = variables["id"]
            nodes = [{"body": b} for b in self.comments.get(issue_id, [])]
            return httpx.Response(200, json={"data": {"issue": {"comments": {"nodes": nodes}}}})
        if "commentCreate" in query:
            self.comments.setdefault(variables["input"]["issueId"], []).append(variables["input"]["body"])
            return httpx.Response(200, json={"data": {"commentCreate": {"success": True}}})
        if "issueUpdate" in query:
            self.label_removals.append((variables["id"], variables["input"]["removedLabelIds"][0]))
            return httpx.Response(200, json={"data": {"issueUpdate": {"success": True}}})
        return httpx.Response(400, json={"errors": [{"message": "unknown operation"}]})

    @staticmethod
    def _issue(c: Candidate) -> dict:
        return {
            "id": c.issue_id,
            "identifier": c.identifier,
            "team": {"id": "t-rh", "key": "RHS"},
            "labels": {"nodes": [{"id": c.dispatch_label_id, "name": c.dispatch_label}]},
        }

    # -- MCP --------------------------------------------------------------
    def mcp_handler(self, request: httpx.Request) -> httpx.Response:
        self.mcp_auths.append(request.headers.get("Authorization"))
        rpc = json.loads(request.content)
        name, args = rpc["params"]["name"], rpc["params"]["arguments"]
        if name == "graph_find":
            self.graph_find_calls.append(args.get("linear_issue_id"))
            g = self.graphs.get(args.get("linear_issue_id") or "")
            result = g["find"] if g else {"found": False, "reason": "unknown"}
            return self._rpc(rpc["id"], result)
        if name == "graph_get":
            g = next((v for v in self.graphs.values() if v["find"].get("graph_id") == args.get("graph_id")), None)
            if g is None:
                return self._rpc(rpc["id"], "No such graph.")
            return self._rpc(rpc["id"], {"graph_id": args["graph_id"], "nodes": [dict(g["node"])]})
        if name == "events_emit":
            self.events.setdefault(args.get("graph_id") or args.get("linear_identifier") or "?", []).append(args)
            return self._rpc(rpc["id"], {"stored": True})
        return self._rpc(rpc["id"], {"error": "unknown tool"}, is_error=True)

    @staticmethod
    def _rpc(rpc_id: int, result: object, is_error: bool = False) -> httpx.Response:
        text = result if isinstance(result, str) else json.dumps(result)
        payload = {"content": [{"type": "text", "text": text}], "isError": is_error}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": rpc_id, "result": payload})


def make_clients(world: World):
    from substrate_dispatcher.linear import LinearClient
    from substrate_dispatcher.mcp import McpClient

    linear = LinearClient("rh-smoke-key", transport=httpx.MockTransport(world.linear_handler))
    mcp = McpClient("http://127.0.0.1:9/mcp", transport=httpx.MockTransport(world.mcp_handler), bearer="rh-smoke-bearer")
    return linear, mcp


def fresh_repo(repos_root: Path) -> Path:
    repo = repos_root / REPO_NAME
    repo.mkdir(parents=True)
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "smoke",
        "GIT_AUTHOR_EMAIL": "smoke@example.invalid",
        "GIT_COMMITTER_NAME": "smoke",
        "GIT_COMMITTER_EMAIL": "smoke@example.invalid",
    }
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True, env=env)
    subprocess.run(["git", "commit", "-q", "--allow-empty", "-m", "smoke root"], cwd=repo, check=True, env=env)
    subprocess.run(
        ["git", "remote", "add", "origin", f"https://example.invalid/{SLUG}"],
        cwd=repo,
        check=True,
        env=env,
    )
    return repo


def write_fake_hermes(bin_path: Path, record: Path, mode_file: Path) -> None:
    bin_path.write_text(
        "#!/bin/sh\n"
        f'echo "argv: $@" >> "{record}"\n'
        f'echo "cwd: $(pwd)" >> "{record}"\n'
        f'echo "env-keys: $(env | cut -d= -f1 | sort | tr \'\\n\' \' \')" >> "{record}"\n'
        f'mode=$(cat "{mode_file}")\n'
        'case "$mode" in\n'
        "  exit1) exit 1;;\n"
        "  trap-term) trap '' TERM; sleep 30;;\n"
        "  sleep2) sleep 2;;\n"
        "  *) exit 0;;\n"
        "esac\n"
    )
    bin_path.chmod(0o755)
    mode_file.write_text("exit0")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    args = ap.parse_args()
    run_dir = Path(args.run_dir)
    if Path(tempfile.gettempdir()) not in run_dir.resolve().parents:
        print(f"FAIL run dir {run_dir} is not under the system tmp dir — refusing")
        return 1
    repos_root = run_dir / "repos"
    trees_root = run_dir / "worktrees"
    state_dir = run_dir / "state"
    bin_dir = run_dir / "bin"
    bin_dir.mkdir(parents=True)
    record = run_dir / "hermes-record.txt"
    mode_file = run_dir / "hermes-mode"
    fake_hermes = bin_dir / "hermes"
    write_fake_hermes(fake_hermes, record, mode_file)
    fresh_repo(repos_root)
    env_file = run_dir / "substrate.env"
    env_file.write_text("LINEAR_API_KEY=rh-smoke-key\n")

    world = World(run_dir)
    linear, mcp = make_clients(world)
    lines: list[str] = []
    log = lines.append
    launch_fn = dispatch.make_launch_fn(
        log=log,
        checkout=partial(worktree.repo_checkout, root=repos_root),
        ensure=partial(worktree.ensure_worktree, root=trees_root),
        state_dir=state_dir,
        hermes_bin=str(fake_hermes),
    )
    gid = lambda tag: f"rh-smoke-{os.getpid()}-{tag}"  # noqa: E731
    issue = lambda n, tag="hermes": Candidate(  # noqa: E731
        issue_id=f"i-{n}", identifier=f"RHS-{100 + n}", team_id="t-rh", team_key="RHS",
        surface=tag, dispatch_label_id=f"l-{tag}-{n}", dispatch_label=f"dispatch:{tag}",
    )
    hit = lambda g, claimed=None, state="unstarted": {  # noqa: E731
        "found": True, "graph_id": g, "node_id": "n1", "repo": SLUG, "branch": "main",
        "node": {"node_id": "n1", "state": state, "claimed_by": claimed},
    }

    def run_tick(registry, dry_run=False):
        del lines[:]
        return tick(
            linear=linear, mcp=mcp, registry=registry, launch_fn=launch_fn,
            env_file=env_file, environ={}, dry_run=dry_run, log=log,
        )

    def settle(registry, timeout: float = 15.0) -> None:
        """Wait for every registered session process to exit (fake hermes is fast)."""
        import time as _t

        deadline = _t.time() + timeout
        for session in list(registry._sessions.values()):
            while session.proc.poll() is None and _t.time() < deadline:
                _t.sleep(0.05)

    # -- S1: launch end to end -------------------------------------------
    g1 = gid("launch")
    world.candidates = [issue(1)]
    world.graphs = {"i-1": {"find": hit(g1), "node": hit(g1)["node"]}}
    reg = SessionRegistry(state_dir=state_dir)
    decisions = run_tick(reg)
    check("s1 decision is launch", [d.action for d in decisions] == ["launch"])
    check("s1 session registered", reg.active_issue_ids() == {"i-1"})
    settle(reg)
    rec = record.read_text()
    wt = trees_root / g1
    check("s1 hermes spawned once", rec.count("argv: ") == 1, rec)
    check("s1 argv headless query-file", "--query-file" in rec and "chat" in rec, rec)
    check("s1 argv no worktree/yolo/mcp-toolset",
          "--worktree" not in rec and "--yolo" not in rec and "mcp-" not in rec, rec)
    check("s1 argv toolsets terminal,file", "-t terminal,file" in rec.replace("  ", " "), rec)
    check("s1 cwd is the graph worktree", f"cwd: {wt}" in rec, rec)
    env_keys = set(rec.split("env-keys: ")[1].split())
    # PWD is added by the shell itself at startup, not passed by the dispatcher.
    check("s1 child env allowlisted",
          env_keys <= {"HOME", "PATH", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "TERM", "_", "PWD"},
          str(sorted(env_keys)))
    prompts = list((state_dir / "prompts").glob("*.md"))
    check("s1 one prompt file 0600", len(prompts) == 1 and stat.S_IMODE(prompts[0].stat().st_mode) == 0o600)
    prompt = prompts[0].read_text()
    check("s1 prompt carries bearer path not value",
          prompt.count("$(cat ${SUBSTRATE_TOKENS_DIR:-/etc/substrate/tokens}/hermes)") == 4
          and "rh-smoke-bearer" not in prompt and "rh-smoke-key" not in prompt)
    check("s1 prompt has no issue text", "Rehearsal" not in prompt)
    check("s1 outcome event launched",
          any(e.get("payload", {}).get("outcome") == "launched" for e in world.events.get(g1, [])))

    # -- S2: landed claim succeeds (fast fake already exited: landed + exit = success)
    world.graphs["i-1"]["node"] = {"node_id": "n1", "state": "unstarted", "claimed_by": "hermes"}
    reg.reap(1000.0, mcp=mcp, linear=linear, log=log)
    check("s2 no comment or label removal on landing",
          world.comments.get("i-1", []) == [] and world.label_removals == [])
    check("s2 landed exit is success not give-up",
          "i-1" not in reg.given_up and reg.active_issue_ids() == set())
    check("s2 success logged", any("after its claim" in line for line in lines))

    # -- S3: exit without claim gives up ----------------------------------
    mode_file.write_text("exit1")
    g3 = gid("unclaimed")
    world.candidates = [issue(3)]
    world.graphs = {"i-3": {"find": hit(g3), "node": hit(g3)["node"]}}
    reg3 = SessionRegistry(state_dir=state_dir)
    run_tick(reg3)
    import time as _time
    _time.sleep(0.5)
    reg3.reap(_time.time(), mcp=mcp, linear=linear, log=log)
    check("s3 exited-unclaimed comment",
          len(world.comments.get("i-3", [])) == 1 and "[exited-unclaimed]" in world.comments["i-3"][0])
    check("s3 label removed", ("i-3", "l-hermes-3") in world.label_removals)
    check("s3 given up", "i-3" in reg3.given_up and reg3.active_issue_ids() == set())
    check("s3 failed event",
          any(e.get("payload", {}).get("reason") == "exited-unclaimed" for e in world.events.get(g3, [])))

    # -- S4: restart never relaunches a give-up ---------------------------
    reg4 = SessionRegistry(state_dir=state_dir)
    check("s4 give-up re-read", "i-3" in reg4.given_up)
    n_find = len(world.graph_find_calls)
    world.candidates = [issue(3)]
    decisions = run_tick(reg4)
    check("s4 given-up skipped", [d.action for d in decisions] == ["skip"])
    check("s4 given-up never resolved", len(world.graph_find_calls) == n_find)

    # -- S5: timeout terminates, SIGKILL after grace ----------------------
    mode_file.write_text("trap-term")
    g5 = gid("timeout")
    world.candidates = [issue(5)]
    world.graphs = {"i-5": {"find": hit(g5), "node": hit(g5)["node"]}}
    reg5 = SessionRegistry(state_dir=state_dir)
    run_tick(reg5)
    s5 = reg5.get("i-5")
    assert s5 is not None
    s5.started_at = 2000.0 - 901
    reg5.reap(2000.0, mcp=mcp, linear=linear, log=log)
    check("s5 terminate sent", s5.proc.poll() is None)
    check("s5 claim-timeout comment",
          any("[claim-timeout]" in b for b in world.comments.get("i-5", [])))
    reg5.reap(2012.0, mcp=mcp, linear=linear, log=log)
    import time as _t2
    _deadline = _t2.time() + 10.0
    while s5.proc.poll() is None and _t2.time() < _deadline:
        _t2.sleep(0.05)
    check("s5 SIGKILL after grace", s5.proc.poll() is not None)
    check("s5 failed event",
          any(e.get("payload", {}).get("reason") == "claim-timeout" for e in world.events.get(g5, [])))
    s5.proc.wait()

    # -- S6: slow claim still lands (02-08 shape: running session, late evidence)
    mode_file.write_text("sleep2")
    g6 = gid("slow")
    world.candidates = [issue(6)]
    world.graphs = {"i-6": {"find": hit(g6), "node": hit(g6)["node"]}}
    reg6 = SessionRegistry(state_dir=state_dir)
    run_tick(reg6)
    reg6.reap(3000.0, mcp=mcp, linear=linear, log=log)
    check("s6 running session untouched", reg6.get("i-6") is not None and reg6.get("i-6").claimed_at is None)
    world.graphs["i-6"]["node"] = {"node_id": "n1", "state": "unstarted", "claimed_by": "hermes"}
    settle(reg6)
    reg6.reap(3001.0, mcp=mcp, linear=linear, log=log)
    check("s6 late claim lands as success",
          "i-6" not in reg6.given_up and reg6.active_issue_ids() == set()
          and any("after its claim" in line for line in lines))

    # -- S7: invalid ids refuse before any worktree -----------------------
    g7 = gid("badids")
    world.candidates = [issue(7)]
    world.graphs = {"i-7": {"find": {**hit(g7), "repo": "bad repo!"}, "node": hit(g7)["node"]}}
    reg7 = SessionRegistry(state_dir=state_dir)
    run_tick(reg7)
    check("s7 invalid-ids comment",
          any("[invalid-ids]" in b for b in world.comments.get("i-7", [])))
    check("s7 invalid-ids given up", "i-7" in reg7.given_up)
    check("s7 no worktree left behind", not (trees_root / g7).exists())

    # -- S8: refusal vocabulary -------------------------------------------
    cases = [
        ("no-node", issue(11), {"found": False, "reason": "unknown"}, "no-node"),
        ("already-claimed", issue(12), {**hit(gid("x")), "node": {"node_id": "n1", "state": "unstarted", "claimed_by": "omp"}}, "already-claimed"),
        ("not-dispatchable", issue(13, "omp"), hit(gid("y")), "not-dispatchable"),
        ("host-unreachable", issue(14, "claude-code"), hit(gid("z")), "host-unreachable"),
    ]
    for name, cand, find, marker in cases:
        wid = cand.issue_id
        world.candidates = [cand]
        world.graphs = {wid: {"find": find, "node": find.get("node", {})}}
        before = len(world.comments.get(wid, []))
        run_tick(SessionRegistry(state_dir=state_dir))
        bodies = world.comments.get(wid, [])
        check(f"s8 {name} once-only comment",
              len(bodies) == before + 1 and f"[{marker}]" in bodies[-1] and bodies[-1].startswith("substrate-dispatcher:"))
    run_tick(SessionRegistry(state_dir=state_dir))  # repeat: no duplicates
    check("s8 comments stay once-only", len(world.comments.get("i-14", [])) == 1)
    check("s8 host-unreachable emits nothing",
          all(e.get("payload", {}).get("reason") != "host-unreachable"
              for evts in world.events.values() for e in evts))

    # -- S9: double-launch matrix -----------------------------------------
    mode_file.write_text("exit0")
    g9 = gid("double")
    world.candidates = [issue(9)]
    world.graphs = {"i-9": {"find": hit(g9), "node": hit(g9)["node"]}}
    reg9 = SessionRegistry(state_dir=state_dir)
    run_tick(reg9)
    settle(reg9)
    spawns = record.read_text().count("argv: ")
    decisions = run_tick(reg9)
    check("s9 active issue skipped", [d.action for d in decisions] == ["skip"])
    check("s9 no second spawn", record.read_text().count("argv: ") == spawns)
    try:
        from substrate_dispatcher.sessions import Session
        reg9.add(reg9.get("i-9"))
        check("s9 duplicate add refused", False)
    except ValueError:
        check("s9 duplicate add refused", True)

    # -- S10: lease-id leak sweep ------------------------------------------
    leak = "lease-sweep-abcdef123456"
    world.candidates = [issue(10)]
    world.graphs = {"i-10": {"find": hit(gid("leak")), "node": {"node_id": "n1", "state": leak, "claimed_by": None}}}
    run_tick(SessionRegistry(state_dir=state_dir))
    hay = list(record.read_text().splitlines())
    for p in (state_dir / "prompts").glob("*.md"):
        hay.append(p.read_text())
    for bodies in world.comments.values():
        hay.extend(bodies)
    for evts in world.events.values():
        hay.extend(json.dumps(e) for e in evts)
    check("s10 no lease-shaped value leaks", all(leak not in h for h in hay))

    print(f"\n{len(FAILURES)} failure(s)")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
