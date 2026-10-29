"""Per-Graph-ID git worktrees (D-12).

A dispatched session works in ``/var/lib/substrate/worktrees/<graph_id>`` on branch
``substrate/<graph_id>``. The worktree is reused when git already has it registered, created
from the existing branch when only the branch exists, and created with a new branch otherwise.
Creation is refused when ``/`` has less than the free-disk floor (``SUBSTRATE_WORKTREE_MIN_FREE_GB``,
default 5 GiB), and no git command runs in that case.
Every git call is an argv list (never a shell), and nothing here ever deletes a directory or
checks out a branch in the main checkout.
"""

from __future__ import annotations

import logging
import math
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable, Mapping

GRAPH_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
REPO_SLUG_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
WORKTREES_ROOT = Path("/var/lib/substrate/worktrees")
REPOS_ROOT = Path("/root/src/repos")
DEFAULT_MIN_FREE_GB = 5
MIN_FREE_ENV = "SUBSTRATE_WORKTREE_MIN_FREE_GB"
BRANCH_PREFIX = "substrate/"

Runner = Callable[..., subprocess.CompletedProcess]
logger = logging.getLogger(__name__)


def min_free_gb(env: Mapping[str, str] | None = None) -> float:
    """The free-disk floor in GiB: ``SUBSTRATE_WORKTREE_MIN_FREE_GB`` or the default of 5.

    An unparsable, non-finite or non-positive value falls back to the default with a log line,
    so a typo never turns the floor off.
    """
    raw = (os.environ if env is None else env).get(MIN_FREE_ENV)
    if raw is None or raw.strip() == "":
        return float(DEFAULT_MIN_FREE_GB)
    try:
        value = float(raw)
    except ValueError:
        value = float("nan")
    if not math.isfinite(value) or value <= 0:
        logger.warning("%s=%r is not a positive number; using %d GB", MIN_FREE_ENV, raw, DEFAULT_MIN_FREE_GB)
        return float(DEFAULT_MIN_FREE_GB)
    return value


def min_free_bytes(env: Mapping[str, str] | None = None) -> int:
    """The floor in bytes, read from the environment at call time."""
    return int(min_free_gb(env) * 1024**3)


class WorktreeRefused(Exception):
    """The dispatcher will not prepare this worktree.

    ``marker`` is a stable key for once-only Linear comments: "invalid-graph-id", "no-checkout",
    "low-disk", "path-conflict", or "git-failed" when a git command itself fails.
    """

    def __init__(self, reason: str, marker: str) -> None:
        super().__init__(reason)
        self.reason = reason
        self.marker = marker


def validate_graph_id(graph_id: str) -> str:
    """Return graph_id when it is safe as both a path component and a git ref component."""
    if (
        not isinstance(graph_id, str)
        or not GRAPH_ID_RE.fullmatch(graph_id)
        or ".." in graph_id
        or graph_id.endswith(".lock")
        or graph_id.endswith(".")
    ):
        raise WorktreeRefused(f"invalid graph id {graph_id!r}", "invalid-graph-id")
    return graph_id


def _git(run: Runner, repo: Path, *args: str) -> subprocess.CompletedProcess:
    return run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=False)


def _origin_matches(url: str, slug: str) -> bool:
    """True when the origin URL names exactly this owner/repo (case-insensitive, .git ignored)."""
    norm = url.strip().lower().rstrip("/")
    if norm.endswith(".git"):
        norm = norm[: -len(".git")]
    want = slug.lower()
    return norm == want or norm.endswith("/" + want) or norm.endswith(":" + want)


def repo_checkout(slug: str, *, root: Path = REPOS_ROOT, run: Runner = subprocess.run) -> Path:
    """Map an ``owner/name`` slug to its checkout ``<root>/<name>``, verified by its origin URL."""
    if not isinstance(slug, str) or not REPO_SLUG_RE.fullmatch(slug):
        raise WorktreeRefused(f"invalid repo slug {slug!r}", "no-checkout")
    root = Path(root)
    path = root / slug.split("/")[1]
    if path.resolve().parent != root.resolve():
        raise WorktreeRefused(f"repo slug {slug!r} escapes {root}", "no-checkout")
    if not (path / ".git").exists():
        raise WorktreeRefused(f"no git checkout for {slug} at {path}", "no-checkout")
    origin = _git(run, path, "remote", "get-url", "origin")
    if origin.returncode != 0 or not _origin_matches(origin.stdout, slug):
        raise WorktreeRefused(f"checkout {path} is not origin {slug}", "no-checkout")
    return path


def _registered(run: Runner, repo: Path, path: Path) -> bool:
    listing = _git(run, repo, "worktree", "list", "--porcelain")
    if listing.returncode != 0:
        raise WorktreeRefused(
            f"git worktree list failed in {repo}: {listing.stderr.strip()[:200]}", "git-failed"
        )
    wanted = {str(path), str(path.resolve())}
    return any(
        line.startswith("worktree ") and line[len("worktree "):] in wanted
        for line in listing.stdout.splitlines()
    )


def _ref_exists(run: Runner, repo: Path, ref: str) -> bool:
    return _git(run, repo, "rev-parse", "--verify", "--quiet", ref).returncode == 0


def ensure_worktree(
    repo: Path,
    graph_id: str,
    base_branch: str | None,
    *,
    root: Path = WORKTREES_ROOT,
    run: Runner = subprocess.run,
    disk_usage: Callable[[str], Any] = shutil.disk_usage,
) -> Path:
    """Return the graph's worktree, creating it only with at least the free-disk floor free on /."""
    gid = validate_graph_id(graph_id)
    root = Path(root)
    path = root / gid
    if path.resolve().parent != root.resolve():
        raise WorktreeRefused(f"worktree path {path} escapes {root}", "invalid-graph-id")

    free = disk_usage("/").free
    floor = min_free_bytes()
    if free < floor:
        raise WorktreeRefused(
            f"only {free / 1024**3:.1f} GB free on /; a worktree needs at least {floor / 1024**3:g} GB",
            "low-disk",
        )

    repo = Path(repo)
    if _registered(run, repo, path):
        if path.is_dir():
            return path
        raise WorktreeRefused(
            f"{path} is registered with git but missing on disk (git worktree prune needed)",
            "path-conflict",
        )
    if path.exists():
        raise WorktreeRefused(f"{path} exists but is not a registered worktree", "path-conflict")

    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    branch = BRANCH_PREFIX + gid
    if _ref_exists(run, repo, f"refs/heads/{branch}"):
        add = _git(run, repo, "worktree", "add", str(path), branch)
    else:
        base = "HEAD"
        if base_branch and _ref_exists(run, repo, f"refs/heads/{base_branch}"):
            base = base_branch
        add = _git(run, repo, "worktree", "add", "-b", branch, str(path), base)
    if add.returncode != 0:
        raise WorktreeRefused(
            f"git worktree add failed for {gid}: {add.stderr.strip()[:200]}", "git-failed"
        )
    return path
