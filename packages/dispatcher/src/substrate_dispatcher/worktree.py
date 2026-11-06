"""Per-Graph-ID git worktrees (D-12).

A dispatched session works in ``<root>/<graph_id>`` on branch ``substrate/<graph_id>``, where ``<root>``
is the first of ``SUBSTRATE_WORKTREE_ROOTS`` (default ``/var/lib/substrate/worktrees``). The worktree is
reused when git already has it registered under any configured root, created from the existing branch when
only the branch exists, and created with a new branch otherwise.
Creation is refused when the filesystem it lands on (the nearest existing directory at or above the first root)
has less than the free-disk floor (``SUBSTRATE_WORKTREE_MIN_FREE_GB``, default 5 GiB); no git command runs then.
Every git call is an argv list (never a shell), and nothing here ever deletes a directory or
checks out a branch in the main checkout.
"""

from __future__ import annotations

import logging
import math
import os
import posixpath
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
ROOTS_ENV = "SUBSTRATE_WORKTREE_ROOTS"
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


def worktree_roots(env: Mapping[str, str] | None = None) -> list[Path]:
    """The directories that hold worktrees, in the order ``SUBSTRATE_WORKTREE_ROOTS`` gives them.

    Parsed as the fleet parses it (``worktreeRootsFromEnv``): colon separated, each entry trimmed, entries
    that are empty or not absolute dropped, the rest normalised and de-duplicated. Unset, or with no usable
    entry, the single default ``WORKTREES_ROOT`` is returned.
    """
    raw = (os.environ if env is None else env).get(ROOTS_ENV) or ""
    roots: list[str] = []
    for part in raw.split(":"):
        entry = part.strip()
        if not entry.startswith("/"):
            continue
        normal = "/" + posixpath.normpath(entry).lstrip("/")
        if normal not in roots:
            roots.append(normal)
    return [Path(root) for root in roots] or [WORKTREES_ROOT]


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


def _existing_ancestor(path: Path) -> Path:
    """The nearest directory at or above ``path`` that exists: the filesystem a worktree created there lands on."""
    probe = Path(path)
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    return probe


def ensure_worktree(
    repo: Path,
    graph_id: str,
    base_branch: str | None,
    *,
    root: Path | None = None,
    run: Runner = subprocess.run,
    disk_usage: Callable[[str], Any] = shutil.disk_usage,
) -> Path:
    """Return the graph's worktree, creating it only with at least the free-disk floor free under the root it lands in.

    ``root`` pins one directory. Unset, the configured roots are used: a worktree git already has under any
    of them is returned, and a new one is created under the first.
    """
    gid = validate_graph_id(graph_id)
    roots = [Path(root)] if root is not None else worktree_roots()
    for candidate_root in roots:
        candidate = candidate_root / gid
        if candidate.resolve().parent != candidate_root.resolve():
            raise WorktreeRefused(f"worktree path {candidate} escapes {candidate_root}", "invalid-graph-id")

    # The worktree is created under roots[0], so the floor is read where it will land: the nearest directory above it that exists.
    probe = _existing_ancestor(roots[0])
    free = disk_usage(str(probe)).free
    floor = min_free_bytes()
    if free < floor:
        raise WorktreeRefused(
            f"only {free / 1024**3:.1f} GB free on {probe}; a worktree needs at least {floor / 1024**3:g} GB",
            "low-disk",
        )

    repo = Path(repo)
    for candidate_root in roots:
        candidate = candidate_root / gid
        if _registered(run, repo, candidate):
            if candidate.is_dir():
                return candidate
            raise WorktreeRefused(
                f"{candidate} is registered with git but missing on disk (git worktree prune needed)",
                "path-conflict",
            )
    path = roots[0] / gid
    if path.exists():
        raise WorktreeRefused(f"{path} exists but is not a registered worktree", "path-conflict")

    roots[0].mkdir(mode=0o700, parents=True, exist_ok=True)
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
