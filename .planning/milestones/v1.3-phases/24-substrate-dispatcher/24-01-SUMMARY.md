# Phase 24 Plan 01: poll + node-read + worktree port — Summary

**One-liner:** September's Linear poll, substrate-mcp client and per-Graph-ID worktree modules on main, with the substrate-bearer identity.

**Tasks:** 3/3 (port linear+mcp, port worktree, port tests + bearer assertions).
**Commits:** 04f5419 (sources), 6605687 (tests).

## What was built

- `linear.py`, `worktree.py`, `__init__.py` byte-identical to `acc30a8`
  (verified by direct content diff).
- `mcp.py`: plus `resolve_substrate_bearer()` (Phase 20 order: `SUBSTRATE_TOKEN`
  → `SUBSTRATE_TOKEN_FILE` → `SUBSTRATE_TOKENS_DIR/substrate`, fail-open) and
  the `Authorization: Bearer` header on every JSON-RPC POST when resolved.
  `LinearClient` needed no change: raw-key form, key from env at runtime,
  errors carry status + ≤200 chars, never headers.
- Tests: bearer present/absent, resolver order, raw-key form pinned;
  worktree tests verbatim. `test_clients.py` + `test_worktree.py`: 38 green.

## Deviations

None — plan executed as written. (The later `remove_label` docstring reword
for the `labelIds` store-lock grep landed in the 24-02 tests commit.)

## Verification

`python3 -m pytest packages/dispatcher/tests/test_clients.py
packages/dispatcher/tests/test_worktree.py -q` green; `rg labelIds|x-substrate`
and store-lock greps clean; `Bearer` sites exactly the new call site.
Live effect: none; no production contact.
