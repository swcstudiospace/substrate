"""Per-surface bearer resolution for the miner bridge (D22-09).

Mirrors Phase 20's order (``packages/cli/src/token.ts``) for the tokens dir
only: ``<SUBSTRATE_TOKENS_DIR or /etc/substrate/tokens>/<surface>``. The token
is the file's first line (4 KiB cap); the surface is validated against
``^[a-z0-9][a-z0-9-]{0,63}$`` before it is joined to a path; any error means
"no token". Values are never logged — this module has no logging at all, and
callers must not log what it returns.

Because one bridge process serves three surfaces, a single-token variable in
the environment would silently mis-attribute every proposal. The bridge
refuses to run while one is set: see :func:`single_token_refusal`.
"""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path
from typing import Mapping

#: Token-file variable naming one file (the herdr precedent, D20-05).
TOKEN_FILE_VAR = "SUBSTRATE_TOKEN_FILE"
#: Direct single-token variable.
DIRECT_VAR = "SUBSTRATE_TOKEN"
#: Tokens-dir override variable.
TOKENS_DIR_VAR = "SUBSTRATE_TOKENS_DIR"

#: Built-in tokens dir, used when the environment names none.
DEFAULT_TOKENS_DIR = "/etc/substrate/tokens"

#: Token files hold one short value; anything larger is not one.
MAX_TOKEN_FILE_BYTES = 4096

#: Caller-controlled surfaces are validated before they are joined to a path.
SURFACE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def first_line(path: Path | str) -> str | None:
    """The first line of a token file, trimmed, or None when unusable.

    Missing paths, non-files, empty or oversize files, unreadable files and
    empty first lines all mean None. Never raises, never logs.
    """
    try:
        info = os.stat(path)
        if not stat.S_ISREG(info.st_mode):
            return None
        if info.st_size == 0 or info.st_size > MAX_TOKEN_FILE_BYTES:
            return None
        with open(path, "rb") as handle:
            raw = handle.read(info.st_size)
    except OSError:
        return None
    try:
        line = raw.decode("utf-8").split("\n", 1)[0].strip()
    except UnicodeDecodeError:
        return None
    return line or None


def resolve(surface: str, env: Mapping[str, str] | None = None) -> str | None:
    """The bearer for ``surface`` from the tokens dir, or None.

    Only the tokens-dir step of Phase 20's order is mirrored here: the direct
    and token-file variables are refused outright (see
    :func:`single_token_refusal`), never read.
    """
    if env is None:
        env = os.environ
    if not SURFACE_RE.fullmatch(surface):
        return None
    directory = (env.get(TOKENS_DIR_VAR) or "").strip() or DEFAULT_TOKENS_DIR
    return first_line(Path(directory) / surface)


def single_token_refusal(env: Mapping[str, str] | None = None) -> str | None:
    """The single-token variable refusing this run, or None when clear.

    Returns the variable *name* only — never a value — so the caller can name
    it in its refusal line.
    """
    if env is None:
        env = os.environ
    if (env.get(DIRECT_VAR) or "").strip():
        return DIRECT_VAR
    if (env.get(TOKEN_FILE_VAR) or "").strip():
        return TOKEN_FILE_VAR
    return None
