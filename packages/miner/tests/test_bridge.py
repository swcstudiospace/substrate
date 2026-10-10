"""The Hermes pending-skill bridge against tmp dirs and httpx.MockTransport (D22-08..D22-13).

September's grouping/replay cases ported onto bearer auth, plus the v1.3 rules:
per-surface tokens with single-token refusal (D22-09), the final/non-final
reply matrix (D22-10), queue mtime quiet (D22-11) and dry-run (D22-12).
Everything runs in tmp dirs with injected transports; no test touches
~/.hermes, /root/.omp, /root/.grok or /var/lib/substrate.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import httpx
import pytest

from substrate_miner import bridge
from substrate_miner import token as token_module
from substrate_miner.__main__ import main as miner_main
from substrate_miner.bridge import (
    NoToken,
    ProposeClient,
    Record,
    Skip,
    base_tree,
    classify,
    drain_queue,
    group_by_name,
    hermes_local_names,
    load_pending,
    proposal_for,
    ready,
    replay,
    run_once,
)

KEY = "ab" * 32
OMP_KEY = "cd" * 32
GROK_KEY = "ef" * 32
NOW = 1_800_000_000.0
SKILL = "---\nname: {name}\ndescription: A test skill.\n---\n\n# {name}\n\nStep one.\n"


# --- fixtures ---------------------------------------------------------------------------------


@pytest.fixture
def env(tmp_path: Path):
    pending = tmp_path / "hermes" / "pending" / "skills"
    pending.mkdir(parents=True)
    library = tmp_path / "library"
    (library / "lib-skill" / "references").mkdir(parents=True)
    (library / "lib-skill" / "SKILL.md").write_text(SKILL.format(name="lib-skill"))
    (library / "lib-skill" / "references" / "a.md").write_text("alpha\n")
    hermes_skills = tmp_path / "hermes" / "skills"
    (hermes_skills / "research" / "local-skill").mkdir(parents=True)
    (hermes_skills / "research" / "local-skill" / "SKILL.md").write_text(SKILL.format(name="local-skill"))
    tokens = tmp_path / "tokens"
    tokens.mkdir()
    (tokens / "hermes").write_text(KEY + "\n")
    (tokens / "omp").write_text(OMP_KEY + "\n")
    (tokens / "grok-build").write_text(GROK_KEY + "\n")
    state = tmp_path / "state"
    return {
        "tmp": tmp_path,
        "pending": pending,
        "library": library,
        "hermes_skills": hermes_skills,
        "tokens_dir": tokens,
        "log": state / "bridge-log.jsonl",
        "held": state / "bridge-held.json",
    }


def token_env(env, **extra):
    return {"SUBSTRATE_TOKENS_DIR": str(env["tokens_dir"]), **extra}


def stage(pending: Path, rid: str, payload: dict, *, created_at: float = NOW - 600, origin: str = "foreground",
          summary: str = "gist", subsystem: str = "skills") -> Path:
    path = pending / f"{rid}.json"
    path.write_text(json.dumps({
        "id": rid, "subsystem": subsystem, "action": payload.get("action", ""), "summary": summary,
        "origin": origin, "created_at": created_at, "payload": payload,
    }))
    return path


def rec(rid: str, payload: dict, *, created_at: float = NOW - 600, origin: str = "foreground") -> Record:
    return Record(id=rid, action=payload.get("action", ""), origin=origin, created_at=created_at,
                  summary="gist", payload=payload, path=Path(f"/nonexistent/{rid}.json"))


def mock_client(env, handler, tokens=None) -> tuple[ProposeClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    all_tokens = {"hermes": KEY, "omp": OMP_KEY, "grok-build": GROK_KEY}
    client = ProposeClient("http://substrate.test", tokens=all_tokens if tokens is None else tokens,
                           transport=httpx.MockTransport(wrapped))
    return client, seen


def run(env, client, **kwargs):
    return run_once(client, pending_dir=env["pending"], library=env["library"], hermes_skills=env["hermes_skills"],
                    log_path=env["log"], held_path=env["held"], now=NOW, **kwargs)


def drain(env, queue: Path, surface: str, client, **kwargs):
    return drain_queue(queue, surface, client, log_path=env["log"], now=NOW, **kwargs)


def log_lines(env) -> list[dict]:
    if not env["log"].exists():
        return []
    return [json.loads(line) for line in env["log"].read_text().splitlines() if line.strip()]


def lib_patch(env, rid="aaaa0001", **extra):
    return stage(env["pending"], rid, {"action": "patch", "name": "lib-skill", "old_string": "Step one.",
                                        "new_string": "Step one, then two.", "replace_all": False}, **extra)


def reply(status: int, body: dict):
    return lambda request: httpx.Response(status, json=body)


OPENED = {"status": "opened", "pr_url": "https://github.com/swcstudiospace/agent-skills/pull/9", "pr_number": 9}


# --- load / group / ready ---------------------------------------------------------------------


def test_load_pending_keeps_skills_records_only(env):
    stage(env["pending"], "aaaa0001", {"action": "edit", "name": "x", "content": "c"})
    stage(env["pending"], "bbbb0002", {"action": "edit", "name": "x", "content": "c"}, subsystem="memory")
    records = load_pending(env["pending"])
    assert [r.id for r in records] == ["aaaa0001"]


def test_load_pending_never_reads_pending_memory(tmp_path):
    memory = tmp_path / "pending" / "memory"
    memory.mkdir(parents=True)
    (memory / "aaaa0001.json").write_text(json.dumps({
        "id": "aaaa0001", "subsystem": "skills", "action": "edit", "summary": "gist",
        "origin": "foreground", "created_at": NOW - 600,
        "payload": {"action": "edit", "name": "x", "content": "c"}}))
    assert load_pending(memory) == []


def test_group_by_name_keys_batch_operations_by_their_names():
    records = [
        rec("r1", {"action": "batch", "operations": [
            {"action": "edit", "name": "one", "content": "a"},
            {"action": "edit", "name": "two", "content": "b"}]}),
        rec("r2", {"action": "edit", "name": "two", "content": "c"}),
    ]
    groups = group_by_name(records)
    assert [r.id for r in groups["one"]] == ["r1"]
    assert [r.id for r in groups["two"]] == ["r1", "r2"]


def test_ready_waits_for_a_quiet_period():
    group = [rec("r1", {"action": "edit", "name": "x", "content": "c"}, created_at=NOW - 300),
             rec("r2", {"action": "edit", "name": "x", "content": "d"}, created_at=NOW - 100)]
    assert ready(group, NOW) is False
    assert ready(group, NOW + 61) is True


# --- replay -----------------------------------------------------------------------------------


BASE = {"SKILL.md": "line one\nline two\nline two\n", "references/a.md": "alpha\n"}


def test_replay_create_and_edit_set_skill_md():
    created = replay({}, [rec("r1", {"action": "create", "name": "x", "content": "new"})], "x")
    assert created["SKILL.md"] == "new"
    edited = replay(BASE, [rec("r1", {"action": "edit", "name": "x", "content": "edited"})], "x")
    assert edited["SKILL.md"] == "edited" and edited["references/a.md"] == "alpha\n"


def test_replay_write_file_then_remove_file():
    group = [rec("r1", {"action": "write_file", "name": "x", "file_path": "references/x.md", "file_content": "X"},
                 created_at=NOW - 300),
             rec("r2", {"action": "remove_file", "name": "x", "file_path": "references/a.md"},
                 created_at=NOW - 200)]
    out = replay(BASE, group, "x")
    assert out["references/x.md"] == "X"
    assert "references/a.md" not in out


def test_replay_patch_once_all_and_in_a_file():
    once = replay(BASE, [rec("r1", {"action": "patch", "name": "x", "old_string": "line two",
                                    "new_string": "LINE"})], "x")
    assert once["SKILL.md"].count("LINE") == 1
    everything = replay(BASE, [rec("r1", {"action": "patch", "name": "x", "old_string": "line two",
                                          "new_string": "LINE", "replace_all": True})], "x")
    assert everything["SKILL.md"].count("LINE") == 2
    ref = replay(BASE, [rec("r1", {"action": "patch", "name": "x", "file_path": "references/a.md",
                                   "old_string": "alpha", "new_string": "beta"})], "x")
    assert ref["references/a.md"] == "beta\n"


def test_replay_applies_batch_operations_in_order_and_records_by_created_at():
    group = [
        rec("r2", {"action": "edit", "name": "x", "content": "third"}, created_at=NOW - 100),
        rec("r1", {"action": "batch", "operations": [
            {"action": "edit", "name": "x", "content": "first"},
            {"action": "edit", "name": "x", "content": "second"}]}, created_at=NOW - 300),
    ]
    assert replay(BASE, group, "x")["SKILL.md"] == "third"


def test_replay_patch_miss_is_skipped():
    with pytest.raises(Skip, match="patch did not apply"):
        replay(BASE, [rec("r1", {"action": "patch", "name": "x", "old_string": "absent", "new_string": "y"})], "x")


def test_replay_delete_is_skipped():
    with pytest.raises(Skip, match="deletes are not proposed"):
        replay(BASE, [rec("r1", {"action": "delete", "name": "x"})], "x")


@pytest.mark.parametrize("path", ["../x", "notes/x.md", "/etc/x", "references/../../x"])
def test_replay_refuses_paths_outside_the_allowed_dirs(path):
    with pytest.raises(Skip):
        replay(BASE, [rec("r1", {"action": "write_file", "name": "x", "file_path": path, "file_content": "x"})], "x")


def test_replay_write_to_templates_skill_md_does_not_replace_root_skill_md():
    base = {"SKILL.md": "root instructions\n", "templates/SKILL.md": "template\n"}
    out = replay(base, [rec("r1", {"action": "write_file", "name": "x", "file_path": "templates/SKILL.md",
                                   "file_content": "template v2\n"})], "x")
    assert out["templates/SKILL.md"] == "template v2\n"
    assert out["SKILL.md"] == "root instructions\n"


def test_replay_root_skill_md_only_from_the_bare_path():
    out = replay(BASE, [rec("r1", {"action": "write_file", "name": "x", "file_path": "SKILL.md",
                                   "file_content": "root v2"})], "x")
    assert out["SKILL.md"] == "root v2"
    with pytest.raises(Skip):
        replay(BASE, [rec("r1", {"action": "write_file", "name": "x", "file_path": "other/SKILL.md",
                                 "file_content": "x"})], "x")


# --- local names / classify -------------------------------------------------------------------


def test_hermes_local_names_real_dirs_only(tmp_path):
    root = tmp_path / "skills"
    (root / "plain").mkdir(parents=True)
    (root / "plain" / "SKILL.md").write_text("s")
    (root / "research" / "nested").mkdir(parents=True)
    (root / "research" / "nested" / "SKILL.md").write_text("s")
    (root / ".hidden").mkdir(parents=True)
    (root / ".hidden" / "SKILL.md").write_text("s")
    (root / "plainlink").symlink_to(root / "plain")
    assert hermes_local_names(root) == {"plain", "nested"}


def test_classify_scopes_the_bridge_to_library_and_new_foreground_creates():
    lib, local = {"lib-skill"}, {"local-skill"}
    assert classify([rec("r1", {"action": "edit", "name": "lib-skill", "content": "c"})], lib, local)[0] == "library"
    assert classify([rec("r1", {"action": "create", "name": "fresh", "content": "c"})], lib, local)[0] == "new"
    assert classify([rec("r1", {"action": "create", "name": "fresh", "content": "c"}, origin="background")],
                    lib, local) == ("hold", "new-skill-not-foreground")
    assert classify([rec("r1", {"action": "patch", "name": "local-skill", "old_string": "a", "new_string": "b"})],
                    lib, local) == ("hold", "hermes-local")
    assert classify([rec("r1", {"action": "edit", "name": "unknown", "content": "c"})],
                    lib, local) == ("hold", "no-base")


# --- proposal_for / base_tree -----------------------------------------------------------------


def test_proposal_for_sends_changed_files_plus_skill_md_and_a_remove_list():
    base = {"SKILL.md": "s", "references/a.md": "a", "references/b.md": "b"}
    replayed = {"SKILL.md": "s2", "references/a.md": "a"}
    files, remove = proposal_for(base, replayed)
    assert files == {"SKILL.md": "s2"}
    assert remove == ["references/b.md"]


def test_proposal_for_a_large_skill_with_one_patched_reference_names_two_files():
    base = {"SKILL.md": "s", **{f"references/r{i:02d}.md": f"r{i}" for i in range(59)}}
    replayed = dict(base)
    replayed["references/r07.md"] = "changed"
    files, remove = proposal_for(base, replayed)
    assert sorted(files) == ["SKILL.md", "references/r07.md"]
    assert remove == []


def test_proposal_for_without_skill_md_is_skipped():
    with pytest.raises(Skip, match="no SKILL.md"):
        proposal_for({"SKILL.md": "s"}, {"references/a.md": "a"})


def test_base_tree_reads_text_files_and_is_empty_for_unknown_names(env):
    skill = env["library"] / "lib-skill"
    (skill / "binary.bin").write_bytes(b"\x00\x01\x02")
    (skill / "cached.pyc").write_bytes(b"fake")
    tree = base_tree(env["library"], "lib-skill")
    assert tree == {"SKILL.md": SKILL.format(name="lib-skill"), "references/a.md": "alpha\n"}
    assert base_tree(env["library"], "missing") == {}


def _git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True,
                   env={**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
                         "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                         "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def test_library_behind_is_none_outside_a_checkout(tmp_path):
    assert bridge.library_behind(tmp_path) is None


def test_library_behind_reads_local_refs_without_fetching(tmp_path):
    _git(tmp_path, "init", "-b", "main", "-q")
    (tmp_path / "SKILL.md").write_text("s")
    _git(tmp_path, "add", "SKILL.md")
    _git(tmp_path, "commit", "-qm", "one")
    _git(tmp_path, "update-ref", "refs/remotes/origin/main", "HEAD")
    assert bridge.library_behind(tmp_path) is False
    (tmp_path / "other.md").write_text("o")
    _git(tmp_path, "add", "other.md")
    _git(tmp_path, "commit", "-qm", "two")
    assert bridge.library_behind(tmp_path) is False
    _git(tmp_path, "checkout", "-qb", "side", "HEAD~1")
    (tmp_path / "side.md").write_text("s")
    _git(tmp_path, "add", "side.md")
    _git(tmp_path, "commit", "-qm", "three")
    side = subprocess.run(["git", "-C", str(tmp_path), "rev-parse", "HEAD"], check=True,
                           capture_output=True, text=True).stdout.strip()
    _git(tmp_path, "checkout", "-q", "main")
    _git(tmp_path, "update-ref", "refs/remotes/origin/main", side)
    assert bridge.library_behind(tmp_path) is True


def test_refresh_origin_main_sees_a_merge_the_last_sync_missed(tmp_path):
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(origin, "init", "-b", "main", "-q")
    (origin / "SKILL.md").write_text("v1\n")
    _git(origin, "add", "SKILL.md")
    _git(origin, "commit", "-qm", "one")
    clone = tmp_path / "clone"
    subprocess.run(["git", "clone", "-q", str(origin), str(clone)], check=True)
    assert bridge.library_behind(clone) is False
    (origin / "SKILL.md").write_text("v2\n")
    _git(origin, "add", "SKILL.md")
    _git(origin, "commit", "-qm", "two")
    # The clone's remote-tracking ref is still v1, which is what a bridge that
    # does not fetch would treat as current.
    assert bridge.library_behind(clone) is False
    assert bridge.refresh_origin_main(clone) is True
    assert bridge.library_behind(clone) is True


def test_run_once_holds_a_library_group_while_behind(env, monkeypatch, capsys):
    lib_patch(env)
    monkeypatch.setattr(bridge, "library_behind", lambda library: True)
    client, seen = mock_client(env, reply(200, OPENED))
    result = run(env, client)
    assert result.held == 1 and result.proposed == 0 and seen == []
    assert json.loads(env["held"].read_text()) == {"aaaa0001": "library-behind"}


def test_run_once_dry_run_reports_hold_while_behind(env, monkeypatch, capsys):
    lib_patch(env)
    monkeypatch.setattr(bridge, "library_behind", lambda library: True)
    client, _ = mock_client(env, reply(200, OPENED))
    result = run(env, client, dry_run=True)
    assert result.held == 0 and result.kept == 0
    assert "hold:library-behind" in capsys.readouterr().out


def test_run_once_fetches_origin_main_once_for_every_library_group(env, monkeypatch):
    (env["library"] / "other-skill").mkdir()
    (env["library"] / "other-skill" / "SKILL.md").write_text(SKILL.format(name="other-skill"))
    lib_patch(env)
    stage(env["pending"], "bbbb0002", {"action": "patch", "name": "other-skill", "old_string": "Step one.",
                                        "new_string": "Step one, then two.", "replace_all": False})
    fetches = []
    monkeypatch.setattr(bridge, "refresh_origin_main", lambda library: fetches.append(str(library)) or True)
    monkeypatch.setattr(bridge, "library_behind", lambda library: False)
    client, _ = mock_client(env, reply(200, OPENED))
    result = run(env, client)
    assert result.proposed == 2
    assert len(fetches) == 1


def test_run_once_skips_the_fetch_when_no_group_is_a_library_skill(env, monkeypatch):
    stage(env["pending"], "cccc0001", {"action": "create", "name": "mined-skill",
                                        "content": SKILL.format(name="mined-skill")})
    fetches = []
    monkeypatch.setattr(bridge, "refresh_origin_main", lambda library: fetches.append(library) or True)
    client, _ = mock_client(env, reply(200, OPENED))
    assert run(env, client).proposed == 1
    assert fetches == []


def test_run_once_proposes_once_the_library_is_current(env, monkeypatch):
    lib_patch(env)
    monkeypatch.setattr(bridge, "library_behind", lambda library: False)
    client, seen = mock_client(env, reply(200, OPENED))
    result = run(env, client)
    assert result.proposed == 1 and seen != []


# --- token resolver (D22-09) ------------------------------------------------------------------


def test_token_resolve_reads_first_line_per_surface(env):
    assert token_module.resolve("hermes", token_env(env)) == KEY
    assert token_module.resolve("omp", token_env(env)) == OMP_KEY
    assert token_module.resolve("grok-build", token_env(env)) == GROK_KEY


def test_token_resolve_missing_means_no_token(env):
    assert token_module.resolve("hermes", {"SUBSTRATE_TOKENS_DIR": str(env["tmp"] / "absent")}) is None
    (env["tokens_dir"] / "empty").write_text("\n")
    assert token_module.resolve("empty", token_env(env)) is None


def test_token_resolve_rejects_bad_surfaces_and_oversize_files(env):
    assert token_module.resolve("../hermes", token_env(env)) is None
    assert token_module.resolve("HAS CAPS", token_env(env)) is None
    (env["tokens_dir"] / "hermes").write_text("x" * 5000)
    assert token_module.resolve("hermes", token_env(env)) is None


def test_token_resolve_uses_default_dir_when_unset(monkeypatch):
    monkeypatch.delenv("SUBSTRATE_TOKENS_DIR", raising=False)
    assert token_module.resolve("hermes", {"SUBSTRATE_TOKENS_DIR": "/no/tokens"}) is None


def test_single_token_refusal_names_the_variable_never_a_value():
    assert token_module.single_token_refusal({"SUBSTRATE_TOKEN": "sekret"}) == "SUBSTRATE_TOKEN"
    assert token_module.single_token_refusal({"SUBSTRATE_TOKEN_FILE": "/run/tok"}) == "SUBSTRATE_TOKEN_FILE"
    assert token_module.single_token_refusal({"SUBSTRATE_TOKEN": "  "}) is None
    assert token_module.single_token_refusal({}) is None


def test_bridge_main_refuses_when_a_single_token_variable_is_set(monkeypatch, capsys):
    monkeypatch.setenv("SUBSTRATE_TOKEN", "sekret-value")
    assert miner_main(["bridge", "--once"]) == 1
    err = capsys.readouterr().err
    assert "SUBSTRATE_TOKEN" in err and "sekret-value" not in err


def test_bridge_main_refuses_on_the_token_file_variable(monkeypatch, capsys):
    monkeypatch.setenv("SUBSTRATE_TOKEN_FILE", "/run/tok")
    assert miner_main(["bridge", "--once"]) == 1
    assert "SUBSTRATE_TOKEN_FILE" in capsys.readouterr().err


# --- run_once dispositions --------------------------------------------------------------------


def test_run_once_opened_sends_bearer_and_contract_body_then_unlinks_and_logs(env):
    lib_patch(env, "aaaa0001", created_at=NOW - 900)
    client, seen = mock_client(env, reply(200, OPENED))
    result = run(env, client)
    assert result.proposed == 1 and not (env["pending"] / "aaaa0001.json").exists()
    assert seen[0].headers["authorization"] == f"Bearer {KEY}"
    body = json.loads(seen[0].content)
    assert body["surface"] == "hermes" and body["name"] == "lib-skill"
    assert set(body) >= {"name", "files", "rationale"}
    [line] = log_lines(env)
    assert line["status"] == "opened"
    assert KEY not in env["log"].read_text()


def test_run_once_sends_a_remove_list_for_files_the_replay_deleted(env):
    stage(env["pending"], "aaaa0001", {"action": "remove_file", "name": "lib-skill", "file_path": "references/a.md"})
    client, seen = mock_client(env, reply(200, OPENED))
    run(env, client)
    body = json.loads(seen[0].content)
    assert body["remove"] == ["references/a.md"]


def test_run_once_proposes_a_new_foreground_create(env):
    stage(env["pending"], "cccc0001", {"action": "create", "name": "mined-skill",
                                        "content": SKILL.format(name="mined-skill")})
    client, seen = mock_client(env, reply(200, OPENED))
    assert run(env, client).proposed == 1
    assert json.loads(seen[0].content)["files"] == {"SKILL.md": SKILL.format(name="mined-skill")}


@pytest.mark.parametrize("status", ["opened", "existing", "unchanged", "declined"])
def test_run_once_each_final_200_status_deletes(env, status):
    path = lib_patch(env)
    client, _ = mock_client(env, reply(200, {"status": status, "pr_url": "https://example.test/p/1"}))
    result = run(env, client)
    assert result.proposed == 1 and not path.exists()
    assert log_lines(env)[0]["status"] == status


def test_run_once_dry_run_reply_status_keeps(env):
    path = lib_patch(env)
    client, seen = mock_client(env, reply(200, {"status": "dry_run"}))
    result = run(env, client)
    assert seen and result.kept == 1 and path.exists()


@pytest.mark.parametrize("status", [401, 403])
def test_run_once_dry_run_auth_failure_is_not_ok_but_touches_nothing(env, capsys, status):
    path = lib_patch(env)
    client, _ = mock_client(env, reply(status, {"error": "refused"}))
    result = run(env, client, dry_run=True)
    assert result.ok is False
    assert result.kept == 1 and path.exists()
    assert not env["held"].exists() and not env["log"].exists()


def test_run_once_400_unlinks_and_logs_rejected_with_rules(env):
    lib_patch(env)
    client, _ = mock_client(env, reply(400, {"error": "secret-like content",
                                              "findings": [{"file": "SKILL.md", "line": 1, "rule": "github"}]}))
    result = run(env, client)
    assert result.rejected == 1 and not (env["pending"] / "aaaa0001.json").exists()
    [line] = log_lines(env)
    assert line["status"] == "rejected" and line["error"] == "secret-like content" and line["rules"] == ["github"]


def test_run_once_413_holds_as_oversize_and_does_not_resend(env):
    path = lib_patch(env)
    client, seen = mock_client(env, reply(413, {"error": "too large"}))
    result = run(env, client)
    assert path.exists() and result.held == 1
    [line] = log_lines(env)
    assert line["status"] == "held" and line["reason"] == "oversize" and line["id"] == "aaaa0001"
    client2, seen2 = mock_client(env, reply(200, OPENED))
    assert run(env, client2).held == 1 and seen2 == []


def test_run_once_never_sends_a_body_over_the_route_cap(env, monkeypatch):
    monkeypatch.setattr(bridge, "ROUTE_MAX_BYTES", 2_000)
    path = stage(env["pending"], "aaaa0001", {"action": "write_file", "name": "lib-skill",
                                              "file_path": "references/big.md", "file_content": "x" * 5_000})
    client, seen = mock_client(env, reply(200, OPENED))
    run(env, client)
    assert seen == [] and path.exists()
    [line] = log_lines(env)
    assert line["status"] == "held" and line["reason"] == "oversize"


@pytest.mark.parametrize("status,ok", [(401, False), (403, False), (502, True), (503, True), (418, True)])
def test_run_once_non_final_statuses_keep_records(env, status, ok):
    path = lib_patch(env)
    client, seen = mock_client(env, reply(status, {"error": "later"}))
    result = run(env, client)
    assert seen and path.exists() and result.kept == 1 and result.ok is ok
    assert log_lines(env) == []


def test_run_once_transport_error_keeps_records(env):
    path = lib_patch(env)

    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    client, _ = mock_client(env, boom)
    result = run(env, client)
    assert path.exists() and log_lines(env) == [] and result.kept == 1


def test_run_once_missing_token_keeps_everything_and_reports_failure(env):
    path = lib_patch(env)
    client, seen = mock_client(env, reply(200, OPENED), tokens={})
    result = run(env, client)
    assert result.ok is False and seen == [] and path.exists() and log_lines(env) == []


def test_run_once_no_token_mid_tick_keeps_the_rest(env):
    stage(env["pending"], "aaaa0001", {"action": "create", "name": "aaa-fresh",
                                        "content": SKILL.format(name="aaa-fresh")}, created_at=NOW - 900)
    lib = lib_patch(env, "zzzz0009", created_at=NOW - 900)

    calls = []

    class Flaky(ProposeClient):
        def post(self, body, surface):
            calls.append(body)
            if len(calls) == 1:
                return 200, dict(OPENED)
            raise NoToken("lost")

    client = Flaky("http://substrate.test", tokens={"hermes": KEY})
    try:
        result = run(env, client)
    finally:
        client.close()
    assert result.proposed == 1 and result.ok is False and result.kept == 1
    assert not (env["pending"] / "aaaa0001.json").exists() and lib.exists()


def test_run_once_waits_for_the_quiet_period(env):
    path = lib_patch(env, created_at=NOW - 30)
    client, seen = mock_client(env, reply(200, OPENED))
    result = run(env, client)
    assert result.waiting == 1
    assert seen == [] and path.exists() and log_lines(env) == []


def test_run_once_holds_hermes_local_once_and_prunes_held_state(env):
    path = stage(env["pending"], "dddd0001", {"action": "patch", "name": "local-skill", "old_string": "Step one.",
                                               "new_string": "Step two."})
    client, _ = mock_client(env, reply(200, OPENED))
    assert run(env, client).held == 1 and path.exists()
    first = log_lines(env)
    assert run(env, client).held == 1 and log_lines(env) == first
    path.unlink()
    run(env, client)
    assert "dddd0001" not in json.loads(env["held"].read_text())


def test_run_once_skip_holds_every_record_of_the_group(env):
    a = lib_patch(env, "aaaa0001", created_at=NOW - 900)
    b = stage(env["pending"], "aaaa0002", {"action": "patch", "name": "lib-skill", "old_string": "absent",
                                            "new_string": "y"}, created_at=NOW - 800)
    client, seen = mock_client(env, reply(200, OPENED))
    result = run(env, client)
    assert seen == [] and result.held == 2 and a.exists() and b.exists()
    lines = log_lines(env)
    assert {line["reason"] for line in lines} == {"patch did not apply"}


LIBRARY_HOLDS = {
    "oversize": None,
    "patch": {"action": "patch", "name": "lib-skill", "old_string": "absent", "new_string": "y"},
    "path": {"action": "write_file", "name": "lib-skill", "file_path": "notes/x.md", "file_content": "x"},
    "delete": {"action": "delete", "name": "lib-skill"},
}


@pytest.mark.parametrize("case", sorted(LIBRARY_HOLDS))
def test_library_holds_resolve_by_propose_or_reject_never_approve(env, case):
    if case == "oversize":
        lib_patch(env)
        client, _ = mock_client(env, reply(413, {"error": "too large"}))
    else:
        stage(env["pending"], "aaaa0001", LIBRARY_HOLDS[case])
        client, _ = mock_client(env, reply(200, OPENED))
    run(env, client)
    [line] = log_lines(env)
    resolve = line["resolve"]
    assert "substrate skills propose" in resolve and "hermes token file" in resolve
    assert "/skills reject aaaa0001" in resolve
    assert "Never `/skills approve" in resolve
    assert resolve.count("/skills approve") == 1
    assert "may approve" not in resolve
    assert "SUBSTRATE_TOKEN" not in resolve


# --- dry-run (D22-12) ---------------------------------------------------------------------------


def test_dry_run_posts_dry_run_true_and_mutates_nothing(env, capsys):
    path = lib_patch(env, created_at=NOW - 900)
    client, seen = mock_client(env, reply(200, {"status": "dry_run"}))
    result = run(env, client, dry_run=True)
    assert seen and json.loads(seen[0].content)["dry_run"] is True
    assert path.exists()
    assert not env["held"].exists() and not env["log"].exists()
    assert result.kept == 1 and result.proposed == 0
    out = capsys.readouterr().out
    assert "name=lib-skill" in out and "surface=hermes" in out
    assert "aaaa0001" in out and "dry_run" in out


def test_dry_run_hold_prints_without_writing_held_state(env, capsys):
    path = stage(env["pending"], "dddd0001", {"action": "patch", "name": "local-skill", "old_string": "Step one.",
                                               "new_string": "Step two."})
    client, seen = mock_client(env, reply(200, OPENED))
    run(env, client, dry_run=True)
    assert seen == [] and path.exists() and not env["held"].exists()
    out = capsys.readouterr().out
    assert "hold:hermes-local" in out and "dddd0001" in out


# --- queue drain ------------------------------------------------------------------------------


def queued(directory: Path, name: str, surface: str, *, mtime: float = NOW - 600) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}-20260926T090000Z.json"
    path.write_text(json.dumps({"name": name, "files": {"SKILL.md": SKILL.format(name=name)},
                                "rationale": "queued", "surface": surface}))
    os.utime(path, (mtime, mtime))
    return path


def test_drain_queue_posts_bodies_unchanged_and_removes_on_200(env):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "omp-skill", "omp")
    original = json.loads(path.read_text())
    client, seen = mock_client(env, reply(200, OPENED))
    result = drain(env, queue, "omp", client)
    assert result.proposed == 1 and not path.exists()
    assert json.loads(seen[0].content) == original
    assert seen[0].headers["authorization"] == f"Bearer {OMP_KEY}"


def test_drain_queue_uses_each_surface_token(env):
    hermes_q = env["tmp"] / "hermes-queue"
    grok_q = env["tmp"] / "grok-queue"
    queued(hermes_q, "h-skill", "hermes")
    queued(grok_q, "g-skill", "grok-build")
    client, seen = mock_client(env, reply(200, OPENED))
    drain(env, hermes_q, "hermes", client)
    drain(env, grok_q, "grok-build", client)
    assert [r.headers["authorization"] for r in seen] == [f"Bearer {KEY}", f"Bearer {GROK_KEY}"]


@pytest.mark.parametrize("status", [400, 413])
def test_drain_queue_moves_refused_bodies_to_rejected(env, status):
    queue = env["tmp"] / "grok-queue"
    path = queued(queue, "grok-skill", "grok-build")
    client, _ = mock_client(env, reply(status, {"error": "refused"}))
    drain(env, queue, "grok-build", client)
    assert not path.exists() and (queue / "rejected" / path.name).exists()
    [line] = log_lines(env)
    assert line["status"] == "rejected" and line["error"] == "refused"


@pytest.mark.parametrize("status,ok", [(401, False), (403, False), (502, True), (503, True), (418, True)])
def test_drain_queue_keeps_bodies_on_non_final_statuses(env, status, ok):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "omp-skill", "omp")
    client, _ = mock_client(env, reply(status, {"error": "later"}))
    result = drain(env, queue, "omp", client)
    assert path.exists() and result.kept == 1 and result.ok is ok


def test_drain_queue_keeps_bodies_on_a_transport_error(env):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "omp-skill", "omp")

    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    client, _ = mock_client(env, boom)
    assert drain(env, queue, "omp", client).kept == 1
    assert path.exists()


def test_drain_queue_rejects_a_body_claiming_another_surface(env):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "sneaky", "claude-code")
    client, seen = mock_client(env, reply(200, OPENED))
    drain(env, queue, "omp", client)
    assert seen == [] and (queue / "rejected" / path.name).exists()


def test_drain_queue_with_a_missing_token_keeps_everything(env):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "omp-skill", "omp")
    client, seen = mock_client(env, reply(200, OPENED), tokens={})
    result = drain(env, queue, "omp", client)
    assert result.ok is False and seen == [] and path.exists()


def test_drain_queue_keeps_a_young_file_by_mtime(env):
    queue = env["tmp"] / "grok-queue"
    path = queued(queue, "grok-skill", "grok-build", mtime=NOW - 30)
    client, seen = mock_client(env, reply(200, OPENED))
    result = drain(env, queue, "grok-build", client)
    assert seen == [] and path.exists() and result.kept == 1


def test_drain_queue_dry_run_posts_dry_run_and_mutates_nothing(env, capsys):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "omp-skill", "omp")
    client, seen = mock_client(env, reply(200, {"status": "dry_run"}))
    result = drain(env, queue, "omp", client, dry_run=True)
    assert seen and json.loads(seen[0].content)["dry_run"] is True
    assert path.exists() and not (queue / "rejected").exists() and not env["log"].exists()
    assert result.kept == 1 and result.proposed == 0
    out = capsys.readouterr().out
    assert "omp-skill" in out and "surface=omp" in out and "dry_run" in out


@pytest.mark.parametrize("status", [401, 403])
def test_drain_queue_dry_run_auth_failure_is_not_ok_but_keeps_the_file(env, status):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "omp-skill", "omp")
    client, _ = mock_client(env, reply(status, {"error": "refused"}))
    result = drain(env, queue, "omp", client, dry_run=True)
    assert result.ok is False
    assert path.exists() and not (queue / "rejected").exists() and not env["log"].exists()
