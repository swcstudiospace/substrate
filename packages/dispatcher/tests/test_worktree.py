"""D-12 worktree: validation, checkout mapping, create/reuse/branch cases and the disk floor."""

from __future__ import annotations

import subprocess
from collections import namedtuple
from pathlib import Path

import pytest

from substrate_dispatcher.worktree import (
    DEFAULT_MIN_FREE_GB,
    MIN_FREE_ENV,
    ROOTS_ENV,
    WorktreeRefused,
    ensure_worktree,
    min_free_bytes,
    repo_checkout,
    validate_graph_id,
    worktree_roots,
)

MIN_FREE_BYTES = DEFAULT_MIN_FREE_GB * 1024**3


@pytest.fixture(autouse=True)
def _clean_floor_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(MIN_FREE_ENV, raising=False)

GID = "ut-mufsocbe-c7ced745"
SLUG = "swcstudiospace/agent-substrate"
Usage = namedtuple("Usage", "total used free")
PLENTY = Usage(100 * 1024**3, 0, 50 * 1024**3)


def plenty(_path: str) -> Usage:
    return PLENTY


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    path = tmp_path / "repos" / "agent-substrate"
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    (path / "README").write_text("x\n")
    git(path, "add", "README")
    git(path, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init")
    git(path, "remote", "add", "origin", f"https://github.com/{SLUG}.git")
    return path


class Recorder:
    """subprocess.run stand-in that records argv and delegates to the real git."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        return subprocess.run(argv, **kwargs)

    def adds(self) -> list[list[str]]:
        return [c for c in self.calls if c[3:5] == ["worktree", "add"]]


def test_validate_graph_id_accepts_real_id():
    assert validate_graph_id(GID) == GID


@pytest.mark.parametrize("bad", ["../x", "a/b", "-x", ".x", "a..b", "x.lock", "", "a" * 200])
def test_validate_graph_id_rejects(bad):
    with pytest.raises(WorktreeRefused) as err:
        validate_graph_id(bad)
    assert err.value.marker == "invalid-graph-id"


def test_repo_checkout_maps_slug_when_origin_matches(repo: Path):
    root = repo.parent
    assert repo_checkout(SLUG, root=root) == root / "agent-substrate"


def test_repo_checkout_origin_match_is_case_insensitive_and_ignores_dot_git(repo: Path):
    git(repo, "remote", "set-url", "origin", "git@github.com:SWCStudioSpace/Agent-Substrate")
    assert repo_checkout(SLUG, root=repo.parent) == repo


@pytest.mark.parametrize(
    "slug, origin",
    [
        (SLUG, "https://github.com/someone-else/agent-substrate.git"),
        ("swcstudiospace/missing-repo", None),
        ("a/../b", None),
        ("swcstudiospace/..", None),
    ],
)
def test_repo_checkout_refuses(repo: Path, slug, origin):
    if origin:
        git(repo, "remote", "set-url", "origin", origin)
    with pytest.raises(WorktreeRefused) as err:
        repo_checkout(slug, root=repo.parent)
    assert err.value.marker == "no-checkout"


def test_ensure_worktree_creates_then_reuses(repo: Path, tmp_path: Path):
    root = tmp_path / "worktrees"
    run = Recorder()

    path = ensure_worktree(repo, GID, "main", root=root, run=run, disk_usage=plenty)

    assert path == root / GID
    assert (root.stat().st_mode & 0o777) == 0o700
    assert git(path, "rev-parse", "--abbrev-ref", "HEAD").strip() == f"substrate/{GID}"
    assert git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip() == "main"
    assert run.adds() == [
        ["git", "-C", str(repo), "worktree", "add", "-b", f"substrate/{GID}", str(path), "main"]
    ]

    again = Recorder()
    assert ensure_worktree(repo, GID, "main", root=root, run=again, disk_usage=plenty) == path
    assert again.adds() == []


def test_ensure_worktree_falls_back_to_head_for_unknown_base(repo: Path, tmp_path: Path):
    run = Recorder()
    path = ensure_worktree(repo, GID, "no-such-branch", root=tmp_path / "wt", run=run, disk_usage=plenty)
    assert run.adds()[0][-1] == "HEAD"
    assert git(path, "rev-parse", "HEAD") == git(repo, "rev-parse", "HEAD")


def test_ensure_worktree_uses_existing_branch_without_b(repo: Path, tmp_path: Path):
    git(repo, "branch", f"substrate/{GID}")
    run = Recorder()
    path = ensure_worktree(repo, GID, "main", root=tmp_path / "wt", run=run, disk_usage=plenty)
    assert run.adds() == [
        ["git", "-C", str(repo), "worktree", "add", str(path), f"substrate/{GID}"]
    ]
    assert git(path, "rev-parse", "--abbrev-ref", "HEAD").strip() == f"substrate/{GID}"


def test_ensure_worktree_refuses_unregistered_existing_path_and_keeps_it(repo: Path, tmp_path: Path):
    root = tmp_path / "wt"
    stray = root / GID
    stray.mkdir(parents=True)
    (stray / "keep.txt").write_text("mine")
    run = Recorder()

    with pytest.raises(WorktreeRefused) as err:
        ensure_worktree(repo, GID, "main", root=root, run=run, disk_usage=plenty)

    assert err.value.marker == "path-conflict"
    assert (stray / "keep.txt").read_text() == "mine"
    assert run.adds() == []


@pytest.mark.parametrize(
    "free, refused",
    [(4 * 1024**3, True), (MIN_FREE_BYTES - 1, True), (MIN_FREE_BYTES, False)],
)
def test_ensure_worktree_disk_floor(repo: Path, tmp_path: Path, free, refused):
    calls: list = []

    def run(argv, **kwargs):
        calls.append(argv)
        return subprocess.run(argv, **kwargs)

    def usage(path: str) -> Usage:
        assert path == str(tmp_path)
        return Usage(100 * 1024**3, 0, free)

    root = tmp_path / "wt"
    if refused:
        with pytest.raises(WorktreeRefused) as err:
            ensure_worktree(repo, GID, "main", root=root, run=run, disk_usage=usage)
        assert err.value.marker == "low-disk"
        assert "5 GB" in str(err.value)
        assert calls == []
        assert not root.exists()
    else:
        assert ensure_worktree(repo, GID, "main", root=root, run=run, disk_usage=usage).is_dir()


@pytest.mark.parametrize("raw", ["abc", "0", "-3", "nan", "inf", ""])
def test_min_free_bytes_falls_back_to_default_for_bad_values(raw: str):
    assert min_free_bytes({MIN_FREE_ENV: raw}) == MIN_FREE_BYTES


def test_min_free_bytes_default_when_unset():
    assert min_free_bytes({}) == MIN_FREE_BYTES


def test_min_free_bytes_reads_the_env():
    assert min_free_bytes({MIN_FREE_ENV: "20"}) == 20 * 1024**3
    assert min_free_bytes({MIN_FREE_ENV: "0.5"}) == 1024**3 // 2


def test_ensure_worktree_floor_follows_env(repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(MIN_FREE_ENV, "20")
    calls: list = []

    def run(argv, **kwargs):
        calls.append(argv)
        return subprocess.run(argv, **kwargs)

    def usage(_path: str) -> Usage:
        return Usage(100 * 1024**3, 0, 10 * 1024**3)

    with pytest.raises(WorktreeRefused) as err:
        ensure_worktree(repo, GID, "main", root=tmp_path / "wt", run=run, disk_usage=usage)
    assert err.value.marker == "low-disk"
    assert "20 GB" in str(err.value)
    assert calls == []


def test_ensure_worktree_reads_free_space_where_the_worktree_goes(repo: Path, tmp_path: Path):
    probed: list[str] = []

    def probe(path: str) -> Usage:
        probed.append(path)
        return PLENTY

    ensure_worktree(repo, GID, "main", root=tmp_path / "not-yet" / "wt", run=Recorder(), disk_usage=probe)

    assert probed == [str(tmp_path)]


def test_low_disk_refusal_names_the_filesystem_it_checked(repo: Path, tmp_path: Path):
    low = Usage(100 * 1024**3, 99 * 1024**3, 1 * 1024**3)

    with pytest.raises(WorktreeRefused) as err:
        ensure_worktree(repo, GID, "main", root=tmp_path / "wt", run=Recorder(), disk_usage=lambda _path: low)

    assert err.value.marker == "low-disk"
    assert f"free on {tmp_path};" in str(err.value)


def test_ensure_worktree_creates_under_the_configured_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    configured = tmp_path / "configured"
    monkeypatch.setenv("SUBSTRATE_WORKTREE_ROOTS", str(configured))
    repo = tmp_path / "repo"
    calls: list[list[str]] = []

    def run(argv, **kwargs):
        calls.append(list(argv))
        if argv[3:5] == ["worktree", "list"]:
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        if argv[3] == "rev-parse":
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="")
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    path = ensure_worktree(repo, GID, "main", run=run, disk_usage=plenty)

    assert path == configured / GID
    assert [c for c in calls if c[3:5] == ["worktree", "add"]] == [
        ["git", "-C", str(repo), "worktree", "add", "-b", f"substrate/{GID}", str(configured / GID), "HEAD"]
    ]


def test_ensure_worktree_reuses_a_registered_worktree_under_the_second_root(
    repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    first = tmp_path / "first"
    second = tmp_path / "second"
    second.mkdir()
    monkeypatch.setenv("SUBSTRATE_WORKTREE_ROOTS", f"{first}:{second}")
    git(repo, "worktree", "add", "-b", f"substrate/{GID}", str(second / GID), "main")
    run = Recorder()

    path = ensure_worktree(repo, GID, "main", run=run, disk_usage=plenty)

    assert path == second / GID
    assert run.adds() == []
    assert not first.exists()
    assert git(path, "rev-parse", "--abbrev-ref", "HEAD").strip() == f"substrate/{GID}"


def test_ensure_worktree_refuses_a_configured_root_entry_that_resolves_outside_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    configured = tmp_path / "configured"
    configured.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (configured / GID).symlink_to(outside / GID)
    monkeypatch.setenv("SUBSTRATE_WORKTREE_ROOTS", str(configured))

    def run(argv, **kwargs):
        raise AssertionError(f"git must not run for a refused path: {argv}")

    with pytest.raises(WorktreeRefused) as err:
        ensure_worktree(tmp_path / "repo", GID, "main", run=run, disk_usage=plenty)
    assert err.value.marker == "invalid-graph-id"


def test_worktree_roots_defaults_when_env_unset(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv(ROOTS_ENV, raising=False)
    assert worktree_roots() == [Path("/var/lib/substrate/worktrees")]


def test_worktree_roots_single_entry():
    assert worktree_roots({ROOTS_ENV: "/srv/wt"}) == [Path("/srv/wt")]


def test_worktree_roots_two_entries_keep_their_order():
    assert worktree_roots({ROOTS_ENV: "/srv/b:/srv/a"}) == [Path("/srv/b"), Path("/srv/a")]


def test_worktree_roots_trims_entries_and_drops_empty_or_relative_segments():
    raw = "  /a  :  ::/b/c/ : relative :/x/../y:/a"
    assert worktree_roots({ROOTS_ENV: raw}) == [Path("/a"), Path("/b/c"), Path("/y")]


@pytest.mark.parametrize("raw", ["", "   ", " : : "])
def test_worktree_roots_blank_value_falls_back_to_default(raw: str):
    assert worktree_roots({ROOTS_ENV: raw}) == [Path("/var/lib/substrate/worktrees")]
