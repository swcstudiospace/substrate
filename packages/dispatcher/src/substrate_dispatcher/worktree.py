"""Per-Graph-ID git worktrees (D-12).

A dispatched session works in ``<root>/<graph_id>`` on branch
``substrate/<graph_id>``. The worktree is reused when git already has it registered, created
from the existing branch when only the branch exists, and created with a new branch otherwise.
The root is the first absolute entry of ``SUBSTRATE_WORKTREE_ROOTS`` (the same variable the fleet and the collector
read), else ``/var/lib/substrate/worktrees``. Creation is refused when the filesystem that holds the root has less than
the free-disk floor (``SUBSTRATE_WORKTREE_MIN_FREE_GB``, default 5 GiB), and no git command runs in that case.
Repository checkouts are looked up under the same roots (else ``REPOS_ROOT``), and a repository outside them is refused.
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
from typing import Any, Callable, Mapping, Sequence

GRAPH_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
REPO_SLUG_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
WORKTREES_ROOT = Path("/var/lib/substrate/worktrees")
REPOS_ROOT = Path("/root/src/repos")
ROOTS_ENV = "SUBSTRATE_WORKTREE_ROOTS"
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


def worktree_roots(env: Mapping[str, str] | None = None) -> list[Path]:
    """The absolute entries of ``SUBSTRATE_WORKTREE_ROOTS`` in the order written, normalised and de-duplicated.

    A relative or blank entry is dropped, as the fleet and the collector drop it, so the three readers agree.
    """
    raw = (os.environ if env is None else env).get(ROOTS_ENV, "")
    roots: list[Path] = []
    for part in raw.split(":"):
        entry = part.strip()
        if not entry or not os.path.isabs(entry):
            continue
        normal = Path(os.path.normpath(entry))
        if normal not in roots:
            roots.append(normal)
    return roots


def worktree_root(env: Mapping[str, str] | None = None) -> Path:
    """Where a graph's worktree is created: the first configured root, else ``WORKTREES_ROOT``.

    The collector attributes a path to the first root that contains it, so the first root is the one that keeps a
    dispatched worktree attributed to its graph.
    """
    roots = worktree_roots(env)
    return roots[0] if roots else WORKTREES_ROOT


def _space_probe(path: Path) -> Path:
    """The nearest existing ancestor of ``path``: the filesystem a worktree created there would use."""
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return probe


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


def repo_roots(env: Mapping[str, str] | None = None) -> list[Path]:
    """Where a repository checkout may sit: the configured roots, else ``REPOS_ROOT``.

    Read from the environment at call time. A repository outside every root is not dispatched.
    """
    return worktree_roots(env) or [REPOS_ROOT]


def repo_checkout(slug: str, *, roots: Sequence[Path] | None = None, run: Runner = subprocess.run) -> Path:
    """Map an ``owner/name`` slug to its checkout ``<root>/<name>`` under the first root that holds one, verified by origin.

    ``roots`` defaults to :func:`repo_roots`. A slug whose checkout lies under no root is refused, so the configured
    roots bound which repositories the dispatcher checks out.
    """
    if not isinstance(slug, str) or not REPO_SLUG_RE.fullmatch(slug):
        raise WorktreeRefused(f"invalid repo slug {slug!r}", "no-checkout")
    name = slug.split("/")[1]
    search = repo_roots() if roots is None else [Path(root) for root in roots]
    path: Path | None = None
    for root in search:
        candidate = root / name
        if candidate.resolve().parent != root.resolve():
            raise WorktreeRefused(f"repo slug {slug!r} escapes {root}", "no-checkout")
        if (candidate / ".git").exists():
            path = candidate
            break
    if path is None:
        listed = ", ".join(str(root) for root in search) or "no root"
        raise WorktreeRefused(f"no git checkout for {slug} under {listed}", "no-checkout")
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
    root: Path | None = None,
    run: Runner = subprocess.run,
    disk_usage: Callable[[str], Any] = shutil.disk_usage,
) -> Path:
    """Return the graph's worktree, creating it only with the free-disk floor free on the filesystem that holds the root.

    ``root`` defaults to :func:`worktree_root`, read from the environment at call time.
    """
    gid = validate_graph_id(graph_id)
    root = worktree_root() if root is None else Path(root)
    path = root / gid
    if path.resolve().parent != root.resolve():
        raise WorktreeRefused(f"worktree path {path} escapes {root}", "invalid-graph-id")

    probe = _space_probe(root)
    free = disk_usage(str(probe)).free
    floor = min_free_bytes()
    if free < floor:
        raise WorktreeRefused(
            f"only {free / 1024**3:.1f} GB free on {probe}; a worktree needs at least {floor / 1024**3:g} GB",
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
