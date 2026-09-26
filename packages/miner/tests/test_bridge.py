"""The Hermes pending-skill bridge against tmp dirs and httpx.MockTransport (D-10, W2, W3, W4, W11)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from substrate_miner import bridge
from substrate_miner.bridge import (
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
    key = tmp_path / "propose.key"
    key.write_text(KEY + "\n")
    state = tmp_path / "state"
    return {
        "tmp": tmp_path,
        "pending": pending,
        "library": library,
        "hermes_skills": hermes_skills,
        "key": key,
        "log": state / "bridge-log.jsonl",
        "held": state / "bridge-held.json",
    }


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


def mock_client(env, handler) -> tuple[ProposeClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    client = ProposeClient("http://substrate.test", key_file=env["key"], transport=httpx.MockTransport(wrapped))
    return client, seen


def run(env, client):
    return run_once(client, pending_dir=env["pending"], library=env["library"], hermes_skills=env["hermes_skills"],
                    log_path=env["log"], held_path=env["held"], now=NOW)


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
    stage(env["pending"], "aaaa0002", {"action": "add", "target": "memory"}, subsystem="memory")
    (env["pending"] / "notes.txt").write_text("not a record")
    (env["pending"] / "broken.json").write_text("{not json")
    records = load_pending(env["pending"])
    assert [r.id for r in records] == ["aaaa0001"]


def test_load_pending_never_reads_pending_memory(tmp_path):
    memory = tmp_path / "pending" / "memory"
    memory.mkdir(parents=True)
    stage(memory, "bbbb0001", {"action": "edit", "name": "x", "content": "c"})
    assert load_pending(memory) == []


def test_group_by_name_keys_batch_operations_by_their_names():
    records = [
        rec("r1", {"action": "edit", "name": "one", "content": "c"}),
        rec("r2", {"action": "batch", "operations": [
            {"action": "write_file", "name": "two", "file_path": "references/x.md", "file_content": "x"}]}),
        rec("r3", {"action": "patch", "name": "research/one", "old_string": "a", "new_string": "b"}),
    ]
    groups = group_by_name(records)
    assert sorted(groups) == ["one", "two"]
    assert [r.id for r in groups["one"]] == ["r1", "r3"]
    assert [r.id for r in groups["two"]] == ["r2"]


def test_ready_waits_for_a_quiet_period():
    group = [rec("r1", {"action": "edit", "name": "x", "content": "c"}, created_at=NOW - 300),
             rec("r2", {"action": "edit", "name": "x", "content": "c"}, created_at=NOW - 60)]
    assert ready(group, NOW) is False
    assert ready(group, NOW + 61) is True


# --- replay -----------------------------------------------------------------------------------


BASE = {"SKILL.md": "line one\nline two\nline two\n", "references/a.md": "alpha\n"}


def test_replay_create_and_edit_set_skill_md():
    created = replay({}, [rec("r1", {"action": "create", "name": "x", "content": "new"})], "x")
    assert created == {"SKILL.md": "new"}
    edited = replay(BASE, [rec("r1", {"action": "edit", "name": "x", "content": "edited"})], "x")
    assert edited["SKILL.md"] == "edited" and edited["references/a.md"] == "alpha\n"


def test_replay_write_file_then_remove_file():
    group = [rec("r1", {"action": "write_file", "name": "x", "file_path": "references/x.md", "file_content": "X"},
                 created_at=1),
             rec("r2", {"action": "remove_file", "name": "x", "file_path": "references/a.md"}, created_at=2)]
    out = replay(BASE, group, "x")
    assert out["references/x.md"] == "X"
    assert "references/a.md" not in out


def test_replay_patch_once_all_and_in_a_file():
    once = replay(BASE, [rec("r1", {"action": "patch", "name": "x", "old_string": "line two",
                                    "new_string": "LINE 2", "replace_all": False})], "x")
    assert once["SKILL.md"] == "line one\nLINE 2\nline two\n"
    every = replay(BASE, [rec("r1", {"action": "patch", "name": "x", "old_string": "line two",
                                     "new_string": "LINE 2", "replace_all": True})], "x")
    assert every["SKILL.md"] == "line one\nLINE 2\nLINE 2\n"
    ref = replay(BASE, [rec("r1", {"action": "patch", "name": "x", "file_path": "references/a.md",
                                   "old_string": "alpha", "new_string": "beta"})], "x")
    assert ref["references/a.md"] == "beta\n"


def test_replay_applies_batch_operations_in_order_and_records_by_created_at():
    group = [
        rec("late", {"action": "patch", "name": "x", "old_string": "second", "new_string": "third"}, created_at=20),
        rec("early", {"action": "batch", "operations": [
            {"action": "edit", "name": "x", "content": "first"},
            {"action": "patch", "name": "x", "old_string": "first", "new_string": "second"},
        ]}, created_at=10),
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


# --- local names / classify -------------------------------------------------------------------


def test_hermes_local_names_real_dirs_only(tmp_path):
    root = tmp_path / "skills"
    (root / "plain").mkdir(parents=True)
    (root / "plain" / "SKILL.md").write_text("x")
    (root / "cat" / "nested").mkdir(parents=True)
    (root / "cat" / "nested" / "SKILL.md").write_text("x")
    (root / ".archive" / "old").mkdir(parents=True)
    (root / ".archive" / "old" / "SKILL.md").write_text("x")
    (root / "cat" / "no-skill").mkdir()
    target = tmp_path / "elsewhere" / "linked"
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text("x")
    (root / "linked").symlink_to(target)
    assert hermes_local_names(root) == {"plain", "nested"}


def test_classify_scopes_the_bridge_to_library_and_new_foreground_creates():
    lib, local = {"lib-skill"}, {"local-skill"}
    create = {"action": "create", "name": "fresh", "content": "c"}
    assert classify([rec("r", {"action": "patch", "name": "lib-skill", "old_string": "a", "new_string": "b"})],
                    lib, local) == ("library", None)
    assert classify([rec("r", create)], lib, local) == ("new", None)
    assert classify([rec("r", {"action": "edit", "name": "local-skill", "content": "c"})],
                    lib, local) == ("hold", "hermes-local")
    assert classify([rec("r", create, origin="background_review")], lib, local) == ("hold", "new-skill-not-foreground")
    assert classify([rec("r", {"action": "patch", "name": "fresh", "old_string": "a", "new_string": "b"})],
                    lib, local) == ("hold", "no-base")


# --- proposal_for / base_tree -----------------------------------------------------------------


def test_proposal_for_sends_changed_files_plus_skill_md_and_a_remove_list():
    base = {"SKILL.md": "s", "references/a.md": "a", "references/b.md": "b"}
    replayed = {"SKILL.md": "s", "references/a.md": "A", "scripts/new.sh": "n"}
    files, remove = proposal_for(base, replayed)
    assert files == {"SKILL.md": "s", "references/a.md": "A", "scripts/new.sh": "n"}
    assert remove == ["references/b.md"]


def test_proposal_for_a_large_skill_with_one_patched_reference_names_two_files():
    base = {"SKILL.md": "s", **{f"references/r{i:02d}.md": f"r{i}" for i in range(59)}}
    replayed = dict(base, **{"references/r07.md": "patched"})
    files, remove = proposal_for(base, replayed)
    assert sorted(files) == ["SKILL.md", "references/r07.md"]
    assert remove == []


def test_proposal_for_without_skill_md_is_skipped():
    with pytest.raises(Skip, match="no SKILL.md"):
        proposal_for({"SKILL.md": "s"}, {"references/a.md": "a"})


def test_base_tree_reads_text_files_and_is_empty_for_unknown_names(env):
    skill = env["library"] / "lib-skill"
    (skill / "__pycache__").mkdir()
    (skill / "__pycache__" / "m.cpython-312.pyc").write_bytes(b"\x00\x01")
    (skill / "assets").mkdir()
    (skill / "assets" / "logo.bin").write_bytes(b"\xff\xfe\x00")
    tree = base_tree(env["library"], "lib-skill")
    assert sorted(tree) == ["SKILL.md", "references/a.md"]
    assert base_tree(env["library"], "missing") == {}


# --- run_once dispositions --------------------------------------------------------------------


def test_run_once_opened_sends_key_and_contract_body_then_unlinks_and_logs(env):
    lib_patch(env, "aaaa0001", created_at=NOW - 900)
    stage(env["pending"], "aaaa0002", {"action": "write_file", "name": "lib-skill", "file_path": "references/b.md",
                                       "file_content": "beta\n"}, created_at=NOW - 800, summary="add b")
    client, seen = mock_client(env, reply(200, OPENED))
    result = run(env, client)
    assert result.ok and result.proposed == 1
    assert len(seen) == 1
    request = seen[0]
    assert request.headers["x-substrate-propose-key"] == KEY
    assert request.url.path == "/skills/propose"
    body = json.loads(request.content)
    assert body["name"] == "lib-skill" and body["surface"] == "hermes"
    assert sorted(body["files"]) == ["SKILL.md", "references/b.md"]
    assert "Step one, then two." in body["files"]["SKILL.md"]
    assert "remove" not in body
    assert "aaaa0001" in body["rationale"] and "aaaa0002" in body["rationale"] and "add b" in body["rationale"]
    assert list(env["pending"].iterdir()) == []
    [line] = log_lines(env)
    assert line["name"] == "lib-skill" and line["status"] == "opened"
    assert sorted(line["ids"]) == ["aaaa0001", "aaaa0002"]
    assert line["pr_url"] == OPENED["pr_url"] and "ts" in line
    assert KEY not in env["log"].read_text()


def test_run_once_sends_a_remove_list_for_files_the_replay_deleted(env):
    stage(env["pending"], "aaaa0001", {"action": "remove_file", "name": "lib-skill", "file_path": "references/a.md"})
    client, seen = mock_client(env, reply(200, OPENED))
    run(env, client)
    body = json.loads(seen[0].content)
    assert body["files"] == {"SKILL.md": SKILL.format(name="lib-skill")}
    assert body["remove"] == ["references/a.md"]


def test_run_once_proposes_a_new_foreground_create(env):
    stage(env["pending"], "cccc0001", {"action": "create", "name": "mined-skill",
                                       "content": SKILL.format(name="mined-skill")})
    client, seen = mock_client(env, reply(200, OPENED))
    assert run(env, client).proposed == 1
    assert json.loads(seen[0].content)["files"] == {"SKILL.md": SKILL.format(name="mined-skill")}


def test_run_once_declined_unlinks_and_logs_declined(env):
    lib_patch(env)
    closed = {"status": "declined", "pr_url": "https://github.com/swcstudiospace/agent-skills/pull/3"}
    client, _ = mock_client(env, reply(200, closed))
    run(env, client)
    assert list(env["pending"].iterdir()) == []
    [line] = log_lines(env)
    assert line["status"] == "declined" and line["pr_url"] == closed["pr_url"]


def test_run_once_400_unlinks_and_logs_rejected_with_rules(env):
    lib_patch(env)
    refused = {"error": "secret-like content", "findings": [{"file": "SKILL.md", "line": 3, "rule": "github"}]}
    client, _ = mock_client(env, reply(400, refused))
    run(env, client)
    assert list(env["pending"].iterdir()) == []
    [line] = log_lines(env)
    assert line["status"] == "rejected" and line["error"] == "secret-like content" and line["rules"] == ["github"]


def test_run_once_413_holds_as_oversize_and_does_not_resend(env):
    path = lib_patch(env)
    client, seen = mock_client(env, reply(413, {"error": "body too large"}))
    run(env, client)
    run(env, client)
    assert path.exists()
    assert len(seen) == 1
    [line] = log_lines(env)
    assert line["status"] == "held" and line["reason"] == "oversize" and line["id"] == "aaaa0001"


def test_run_once_never_sends_a_body_over_the_route_cap(env, monkeypatch):
    monkeypatch.setattr(bridge, "ROUTE_MAX_BYTES", 2_000)
    path = stage(env["pending"], "aaaa0001", {"action": "write_file", "name": "lib-skill",
                                              "file_path": "references/big.md", "file_content": "x" * 5_000})
    client, seen = mock_client(env, reply(200, OPENED))
    run(env, client)
    assert seen == [] and path.exists()
    [line] = log_lines(env)
    assert line["status"] == "held" and line["reason"] == "oversize"


@pytest.mark.parametrize("status", [401, 502])
def test_run_once_401_and_5xx_keep_records_and_log_nothing(env, status):
    path = lib_patch(env)
    client, _ = mock_client(env, reply(status, {"error": "nope"}))
    result = run(env, client)
    assert path.exists() and log_lines(env) == []
    assert result.kept == 1
    assert result.ok is (status != 401)


def test_run_once_transport_error_keeps_records(env):
    path = lib_patch(env)

    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    client, _ = mock_client(env, boom)
    result = run(env, client)
    assert path.exists() and log_lines(env) == [] and result.kept == 1


def test_run_once_missing_key_keeps_everything_and_reports_failure(env):
    path = lib_patch(env)
    env["key"].unlink()
    client, seen = mock_client(env, reply(200, OPENED))
    result = run(env, client)
    assert result.ok is False
    assert seen == [] and path.exists() and log_lines(env) == []


def test_run_once_waits_for_the_quiet_period(env):
    path = lib_patch(env, created_at=NOW - 30)
    client, seen = mock_client(env, reply(200, OPENED))
    run(env, client)
    assert seen == [] and path.exists() and log_lines(env) == []


def test_run_once_holds_hermes_local_once_and_prunes_held_state(env):
    path = stage(env["pending"], "dddd0001", {"action": "patch", "name": "local-skill", "old_string": "Step one.",
                                              "new_string": "Step one."})
    client, seen = mock_client(env, reply(200, OPENED))
    run(env, client)
    run(env, client)
    assert seen == [] and path.exists()
    [line] = log_lines(env)
    assert line["status"] == "held" and line["reason"] == "hermes-local" and line["id"] == "dddd0001"
    assert "/skills approve dddd0001" in line["resolve"] and "/skills reject dddd0001" in line["resolve"]
    assert "dddd0001" in json.loads(env["held"].read_text())
    path.unlink()
    run(env, client)
    assert "dddd0001" not in json.loads(env["held"].read_text())


def test_run_once_skip_holds_every_record_of_the_group(env):
    a = lib_patch(env, "aaaa0001", created_at=NOW - 900)
    b = stage(env["pending"], "aaaa0002", {"action": "patch", "name": "lib-skill", "old_string": "absent",
                                           "new_string": "y"}, created_at=NOW - 800)
    client, seen = mock_client(env, reply(200, OPENED))
    run(env, client)
    assert seen == [] and a.exists() and b.exists()
    lines = log_lines(env)
    assert sorted(line["id"] for line in lines) == ["aaaa0001", "aaaa0002"]
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
    assert "substrate skills propose --dir" in resolve and "--surface hermes" in resolve
    assert "/skills reject aaaa0001" in resolve
    assert "Never `/skills approve" in resolve
    assert resolve.count("/skills approve") == 1
    assert "may approve" not in resolve


# --- queue drain ------------------------------------------------------------------------------


def queued(directory: Path, name: str, surface: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}-20260926T090000Z.json"
    path.write_text(json.dumps({"name": name, "files": {"SKILL.md": SKILL.format(name=name)},
                                "rationale": "queued", "surface": surface}))
    return path


def test_drain_queue_posts_bodies_unchanged_and_removes_on_200(env):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "omp-skill", "omp")
    original = json.loads(path.read_text())
    client, seen = mock_client(env, reply(200, OPENED))
    result = drain_queue(queue, "omp", client, log_path=env["log"])
    assert result.proposed == 1 and not path.exists()
    assert json.loads(seen[0].content) == original
    assert seen[0].headers["x-substrate-propose-key"] == KEY


@pytest.mark.parametrize("status", [400, 413])
def test_drain_queue_moves_refused_bodies_to_rejected(env, status):
    queue = env["tmp"] / "grok-queue"
    path = queued(queue, "grok-skill", "grok-build")
    client, _ = mock_client(env, reply(status, {"error": "refused"}))
    drain_queue(queue, "grok-build", client, log_path=env["log"])
    assert not path.exists() and (queue / "rejected" / path.name).exists()
    [line] = log_lines(env)
    assert line["status"] == "rejected" and line["error"] == "refused"


@pytest.mark.parametrize("status", [401, 503])
def test_drain_queue_keeps_bodies_on_401_and_5xx(env, status):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "omp-skill", "omp")
    client, _ = mock_client(env, reply(status, {"error": "later"}))
    result = drain_queue(queue, "omp", client, log_path=env["log"])
    assert path.exists() and result.kept == 1 and result.ok is (status != 401)


def test_drain_queue_keeps_bodies_on_a_transport_error(env):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "omp-skill", "omp")

    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    client, _ = mock_client(env, boom)
    assert drain_queue(queue, "omp", client, log_path=env["log"]).kept == 1
    assert path.exists()


def test_drain_queue_rejects_a_body_claiming_another_surface(env):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "sneaky", "claude-code")
    client, seen = mock_client(env, reply(200, OPENED))
    drain_queue(queue, "omp", client, log_path=env["log"])
    assert seen == [] and (queue / "rejected" / path.name).exists()


def test_drain_queue_with_an_unreadable_key_keeps_everything(env):
    queue = env["tmp"] / "omp-queue"
    path = queued(queue, "omp-skill", "omp")
    env["key"].unlink()
    client, seen = mock_client(env, reply(200, OPENED))
    result = drain_queue(queue, "omp", client, log_path=env["log"])
    assert result.ok is False and seen == [] and path.exists()
