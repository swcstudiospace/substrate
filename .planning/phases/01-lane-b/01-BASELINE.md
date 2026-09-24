# Phase 1 (Lane B) — Measured test baseline

**Measured:** 2026-09-24, in this execution session, by plan `01-01` Task 3.
**Rule:** every number below was produced by running the command shown, once,
just now. Nothing here was copied from `01-RESEARCH.md` or `01-VALIDATION.md`.
Two of the numbers in those documents are already wrong (see "Corrections"), which
is precisely why later gates must compare against **this** file.

---

## Summary table

| # | Repo | Command | Measured |
|---|---|---|---|
| 1 | `hermes-plugin` | `cd /root/src/repos/hermes-plugin && python3 -m pytest -q` | **234 passed, 0 failed** |
| 2 | `hermes-engineering-board` | `cd /root/src/repos/hermes-engineering-board && .venv/bin/python -m pytest -q` | **76 passed, 0 failed** |
| 3 | `hermes-linear-connector` | `cd /root/src/repos/hermes-linear-connector && .venv/bin/python -m pytest -q` | **49 passed, 0 failed** (2 skipped) |
| 4 | `mcp` | `cd /root/src/repos/mcp && .venv/bin/python -m pytest -q` | **99 passed, 2 failed** ⚠ |
| 5 | `agent-substrate` | `cd /root/src/repos/agent-substrate && /root/.local/share/reflex/bun/bin/bun test` | **62 passed, 0 failed** |
| 6 | `claude-ultrathink-grok` | `cd /root/src/repos/claude-ultrathink-grok && /root/.local/share/reflex/bun/bin/bun test` | **246 passed, 0 failed** (re-measured 2026-09-24 by 01-08 at `0066755`, before behavior edits; no failing node ids) |
| 7 | `claude-ultrathink` | `cd /root/src/repos/claude-ultrathink && /root/.local/share/reflex/bun/bin/bun test` | **279 passed, 5 failed** ⚠ |

Row 7 is not in the plan's command list. It was added because **D-03** names
`claude-ultrathink` as one of the two repos whose pre-existing failures later
gates must compare against by identity; recording its node ids here is what makes
that check possible. Running it is read-only.

---

## Per-repo detail, with verbatim summary lines

### 1. `hermes-plugin`

```
cd /root/src/repos/hermes-plugin && python3 -m pytest -q
```

Verbatim summary line:

```
234 passed in 25.29s
```

Measured: 234 passed, 0 failed. Exit code 0. **Green.**

### 2. `hermes-engineering-board`

```
cd /root/src/repos/hermes-engineering-board && .venv/bin/python -m pytest -q
```

Verbatim summary line:

```
76 passed, 1 warning in 5.16s
```

Measured: 76 passed, 0 failed. Exit code 0. **Green.** The single warning is a
`StarletteDeprecationWarning` from `fastapi/testclient.py` in the venv — third
party, not this repo's code.

### 3. `hermes-linear-connector`

```
cd /root/src/repos/hermes-linear-connector && .venv/bin/python -m pytest -q
```

Verbatim summary line:

```
49 passed, 2 skipped in 0.45s
```

Measured: 49 passed, 0 failed, 2 skipped. Exit code 0. **Green.**

### 4. `mcp` — ⚠ RED, and **not** previously documented

```
cd /root/src/repos/mcp && .venv/bin/python -m pytest -q
```

Verbatim summary line:

```
2 failed, 99 passed in 3.98s
```

Measured: 99 passed, 2 failed. Exit code 1.

**Failing test identities:**

1. `tests/test_dedupe_waiter.py::test_wait_for_hermes_job_tracks_status_file`
   - Assertion: `assert result["status"] == "completed"`
   - Message: `AssertionError` — diff `- completed` / `+ failed`
   - Accompanying log: `WARNING grok_hermes_connector.hermes:hermes_backend.py:169 NO_RESULT_JSON handoff_id=job1`

2. `tests/test_tasks_skills.py::test_health_lists_new_capabilities`
   - Assertion: `assert data["version"].startswith("0.3")`
   - Message: `AssertionError: assert False` — `'0.4.0'.startswith('0.3')` returned `False`

**Why these are pre-existing and not caused by plan 01-01.** Plan 01-01 modified
no source file in `mcp`; its only change there was a single-path commit that
began tracking the already-present, already-untracked
`src/grok_hermes_connector/redactor.py` (commit `2a89f98`). The `mcp` checkout is
on branch `feat/linear-parentid-got-cot` and carried **nine modified, uncommitted
files** before this plan ran — including `src/grok_hermes_connector/server.py`,
`hermes_backend.py` and `tests/test_handoff_pack.py` — plus an untracked
`docs/V04_TWO_WAY.md`. The `0.4.0` vs `0.3` mismatch is the signature of a v0.4
version bump in progress against a test still asserting v0.3. That is another
session's in-flight work, the same situation D-03 describes for the two
ultrathink worktrees.

**Treatment: same as D-03 — do not repair.** These failures are outside D-03's
literal wording (which names only `claude-ultrathink` and
`claude-ultrathink-grok`), so this is a finding, not a restatement. The
no-repair rule is applied to them by the same reasoning, and is recorded here so
later gates compare `mcp` against **2 failed with these two node ids**, not
against zero.

**Reading note for a later executor.** The pytest traceback prints paths under
`/root/src/repos/grok-hermes-connector/tests/...` and shows `>   ???` instead of
source lines. That directory **does not exist**. The repo was renamed to `mcp`
and stale `__pycache__` `.pyc` files still carry the old `co_filename`. The tests
really live at `/root/src/repos/mcp/tests/`. Do not go hunting for a missing
repo, and do not treat the `???` as a broken test file.

### 5. `agent-substrate`

```
cd /root/src/repos/agent-substrate && /root/.local/share/reflex/bun/bin/bun test
```

Verbatim summary lines:

```
 62 pass
 0 fail
 136 expect() calls
Ran 62 tests across 6 files. [54.00ms]
```

Measured: 62 passed, 0 failed. Exit code 0. **Green.**

Three `[substrate] brief: ... postgres is down` lines are printed during the run.
They are expected fallback-path output from tests that exercise the
degrade-gracefully branch; they are not failures and the suite is green with them
present.

### 6. `claude-ultrathink-grok` — re-measured by 01-08 before behavior edits

```
cd /root/src/repos/claude-ultrathink-grok && /root/.local/share/reflex/bun/bin/bun test
```

Verbatim summary lines (2026-09-24, HEAD `0066755` on `milestone/v1.0-cross-runtime`, clean tree):

```
 246 pass
 0 fail
 673 expect() calls
Ran 246 tests across 21 files. [203.00ms]
```

Measured: 246 passed, 0 failed. Exit code 0. **Green.**

**Failing test identities:** none.

The earlier row (256 pass / 1 fail / 22 files at `3766efd`, node id
`src/claude/hook.test.ts > runPromptSubmit > uplift + think + track: additionalContext carries the kickoff instruction, record carries the plan`)
is stale. A later session had already seen 246 pass / 0 fail / 21 files at `a12eee1`;
this re-measure at `0066755` confirms that count before any 01-08 behavior edit.
That vanished failure belongs to branch movement that happened before this plan,
not to a Lane B repair. From this row forward, D-03 is two-sided against **0 failed
and an empty failing-node-id set**. 01-08 adds tests, so the passed count is a floor;
a new failure, or a failure that appears and then vanishes relative to this row, fails
the gate.


### 7. `claude-ultrathink` — ⚠ RED (D-03)

```
cd /root/src/repos/claude-ultrathink && /root/.local/share/reflex/bun/bin/bun test
```

Verbatim summary lines:

```
 279 pass
 5 fail
Ran 284 tests across 24 files. [219.00ms]
```

Measured: 279 passed, 5 failed. Exit code 1. Branch `feat/substrate-brief`.

**Failing test identities:**

1. `src/think/pipeline.test.ts > runThink > calls complete once for the graph then each node in order; later call sees earlier conclusion`
   - Assertion: `expect(received).toHaveLength(expected)` — `Expected length: 4`, `Received length: 6`
2. `src/think/pipeline.test.ts > runThink > node throw uses the question and continues`
   - Assertion: `expect(received).toBe(expected)` — `Expected: "Q2"`, `Received: "What subproblems must be solved, in what order, and what does each depend on?"`
3. `src/think/pipeline.test.ts > runThink concurrency > fills independent nodes together but never before their predecessors`
   - Assertion: `expect(received).toBe(expected)` — `Expected: 2`, `Received: 1`
4. `src/claude/hook.test.ts > runPromptSubmit > uplift + think + track: additionalContext carries the kickoff instruction, record carries the plan`
   - Assertion: `expect(received).toHaveLength(expected)` — `Expected length: 3`, `Received length: 5`
5. `src/claude/hook.test.ts > runPromptSubmit > no git remote detected: repo/branch stay undefined, tracking still proceeds`
   - Assertion: `expect(received).toHaveLength(expected)` — `Expected length: 3`, `Received length: 5`

Test declarations are at `src/think/pipeline.test.ts:29`, `:98`, `:115` and
`src/claude/hook.test.ts:97`, `:183`.

Note the direction: here `hook.test.ts` expects **3** and receives **5**, whereas
in `claude-ultrathink-grok` the same-named test expects **15** and receives **3**.
The two worktrees are mid-flight in different directions. A later gate that only
compared counts would miss a swap; comparing identity and direction will not.

---

## Corrections to the remembered numbers

`01-VALIDATION.md` § "Test Infrastructure" carries a baseline table dated
2026-09-24. Measured against it today:

| Repo | Documented | Measured now | Verdict |
|---|---|---|---|
| `hermes-plugin` | 234 pass | 234 passed, 0 failed | matches |
| `hermes-linear-connector` | 49 pass / 2 skip | 49 passed, 0 failed, 2 skipped | matches |
| `hermes-engineering-board` | 76 pass | 76 passed, 0 failed | matches |
| `claude-ultrathink` | 279 pass / 5 fail | 279 passed, 5 failed | matches |
| `claude-ultrathink-grok` | 256 pass / 1 fail | 256 passed, 1 failed | matches |
| `mcp` | *not listed* | **99 passed, 2 failed** | **missing from the table** |
| `agent-substrate` | *not listed* | 62 passed, 0 failed | missing from the table |

The five documented counts held. The gap is coverage, not drift: `01-VALIDATION.md`
lists five repos and omits `mcp`, which is red. A later gate driven only by that
table would have read `mcp`'s two failures as new breakage introduced by Lane B.

---

## D-03 — binding, and extended by measurement

**D-03** (CONTEXT.md § "D3 — claude-ultrathink `master` verified green`") records
that `origin/master` was verified clean this session in a throwaway worktree
(`f10e8de`: 256 pass / 0 fail), so the red baselines in `claude-ultrathink` and
`claude-ultrathink-grok` are confined to uncommitted work in those two checkouts
and are **not** regressions from the Phase 0 merge.

**No Lane B task may repair any failing test recorded in this file.** That is
D-03's rule for the two ultrathink worktrees and it is applied here to `mcp` for
the same reason: the failures belong to another session's uncommitted work, and
"fixing" them would either destroy that work or commit into a checkout Lane B
does not own. Specifically, within Lane B:

- Do not edit any of the 8 failing tests listed above.
- Do not edit the source they assert against in order to make them pass.
- Do not comment out, skip, or `.only`-filter them.
- Do not `git add`, `git commit`, `git checkout --`, `git stash` or `git clean`
  in `/root/src/repos/claude-ultrathink` or
  `/root/src/repos/claude-ultrathink-grok`. Both are active worktrees.

## How later gates must compare against this file

The gate is **two-sided**. A failure that *disappears* fails the gate exactly as
a new one does — a vanished failure means a Lane B task silently touched
another session's work, which is the outcome D-03 exists to prevent.

For each repo, a later plan's `<verify>` passes only when **both** hold:

1. The measured passed count equals the number in the summary table, and
2. The set of failing test node ids is **identical** — same ids, same count, no
   additions and no removals.

| Repo | Must stay at |
|---|---|
| `hermes-plugin` | 234 passed / 0 failed |
| `hermes-engineering-board` | 76 passed / 0 failed |
| `hermes-linear-connector` | 49 passed / 0 failed (2 skipped) |
| `mcp` | 99 passed / 2 failed — the two node ids in § 4 |
| `agent-substrate` | 62 passed / 0 failed (this count *will* rise as Lane B adds tests; the floor is 0 failed) |
| `claude-ultrathink-grok` | 246 passed / 0 failed at `0066755` — no failing node ids (§ 6). Failed count and node-id set are equalities. Passed count is a floor once 01-08 adds tests. |
| `claude-ultrathink` | 279 passed / 5 failed — the five node ids in § 7 |

`agent-substrate` is the one repo Lane B legitimately adds tests to, so its
passed count is a floor rather than an equality. Every other count is an equality.
