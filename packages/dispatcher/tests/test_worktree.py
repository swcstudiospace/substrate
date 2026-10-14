"""D-12 worktree: validation, checkout mapping, create/reuse/branch cases and the disk floor."""

from __future__ import annotations

import subprocess
from collections import namedtuple
from pathlib import Path

import pytest

from substrate_dispatcher.worktree import (
    MIN_FREE_BYTES,
    WorktreeRefused,
    ensure_worktree,
    repo_checkout,
    validate_graph_id,
)

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
        assert path == "/"
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
