---
phase: 52-planning-awareness-core
requirements: [SOTA-08]
status: verified with gaps (see VERIFICATION.md: criteria 1, 3 and 4 FAIL)
---

# 52-SUMMARY: planning index, session presence and change diffs

## What was executed

Read-only verification on `gsd/p52-wiring` at `3126296f7ac58544fc1f2409c96126af70ef5473`, in `/root/src/worktrees/as-p52-wiring`. No tests, typecheck, lint, install or gate was run. Work consisted of:

- Reading CONTEXT.md, PLAN.md, every non-test module under `packages/mcp-server/src/planning/`, the planning entries in `packages/audit/src/policy.ts`, the planning rows in `docs/config-reference.md`, and the planning wiring in `mcp.ts`, `service.ts`, `config.ts`, `flag-registry.ts`, `event-sources.ts`.
- Grep sweeps for delete and write verbs, clock reads, environment reads, absolute paths, and host, port and scheme literals.
- Listing the planning test names for the criteria evidence.
- Checking the branch diff against the merge-base for `package.json` and lock-file changes.

No code was changed by this phase's verification. Verdicts and evidence are in VERIFICATION.md.

## Phase commits

Merge-base with `origin/main`: `0df730ecd42e8a152fd73f1b6b5db04dc170b413`. The branch has 88 commits past it, 29 of them merges. The list below is `git log --oneline` filtered to subjects that name `phase 52`: 37 commits. The merges of `gsd/p52-planning-core`, and the phase 51, CI and muse merges, are not listed.

```
3126296 fix(planning): adopt observePlanningChange for the baseline and the publish (phase 52, SOTA-08)
fc678b1 fix(planning): a failed publish holds the baseline so the change is re-sent (phase 52, SOTA-08)
a680493 fix(planning): every scan becomes the next baseline; only complete diffs publish (phase 52, SOTA-08)
03797dd fix(planning): key outlives the largest freshness window by a margin (phase 52, SOTA-08)
4b8f3ff fix(planning): publish before advancing the baseline; re-send a change whose publish fails (phase 52, SOTA-08)
c3eecbe fix(planning): a diff with an unlisted directory is incomplete, so it is never published (phase 52, SOTA-08)
2cc1394 fix(planning): include truncated in a planning note only when a list was truncated (phase 52, SOTA-08)
85223dd test(planning): read truncated counts without indexed access (phase 52, SOTA-08)
435cb8e fix(planning): listings stat nothing, and links are probed only as far as the cutoff (phase 52, SOTA-08)
cd89bc3 fix(planning): quoted origins, byte-budgeted change notes (phase 52, SOTA-08)
6201930 fix(planning): an unlisted previous directory does not withhold an addition (phase 52, SOTA-08)
9070f70 fix(planning): list phase directories during resolution so a failed listing sorts at its path (phase 52, SOTA-08)
b1bfedc fix(planning): carry unlisted into the status snapshot, gate openRead in the slow-scan test, keep the baseline on transient config failures (phase 52, SOTA-08)
9553a20 fix(planning): stop resolving phase directories at the cutoff, keeping path order (phase 52, SOTA-08)
294f841 fix(planning): heartbeat reads, monotonic baseline, worktree git layout, typed repo reasons (phase 52, SOTA-08)
04f17eb fix(planning): bound every presence reply by the command deadline (phase 52, SOTA-08)
2049405 fix(planning): a failed directory read makes its documents unknown, not removed (phase 52, SOTA-08)
c92e43b test(planning): expect the server-stamped heartbeat in the SCAN dedupe test (phase 52, SOTA-08)
d70ea54 fix(planning): bound stat and probe calls in flight to a fixed limit (phase 52, SOTA-08)
bd50307 fix(planning): keep directory errors in path order under a cutoff (phase 52, SOTA-08)
cee2826 fix(planning): adapt the planning reader to the truncation-aware diff (phase 52, SOTA-08)
ebf6812 fix(planning): explicit null checks for probe narrowing (phase 52, SOTA-08)
421f1c9 fix(planning): add complete to the diff literal in events test (phase 52, SOTA-08)
78e568d Merge origin/gsd/p52-planning-core (679064f) into gsd/p52-wiring (phase 52, SOTA-08)
679064f fix(planning): stop collecting at maxFiles+1 candidates, in path order (phase 52, SOTA-08)
d59ff96 fix(planning): report dangling planning links as error records (phase 52, SOTA-08)
f36f73c fix(planning): read documents through one verified descriptor, capped at maxBytes+1 (phase 52, SOTA-08)
d4597c7 fix(planning): withhold removals from a truncated index diff (phase 52, SOTA-08)
b21fde9 fix(planning): read each presence key once when SCAN repeats it (phase 52, SOTA-08)
cfc5387 fix(planning): accept trailing whitespace after the opening frontmatter fence (phase 52, SOTA-08)
38f8a23 fix(planning): create checkout .git directory in read fixtures (phase 52, SOTA-08)
0f0b860 feat(planning): planning.changed ledger row, docs and wiring status (phase 52, SOTA-08)
23d4503 feat(planning): planning_status and planning_sessions read-only tools (phase 52, SOTA-08)
5c396fd feat(planning): presence backend with bounded enumeration and server-side expiry (phase 52, SOTA-08)
7bc5c1b fix(planning): register SUBSTRATE_PLANNING_* flags (phase 52, SOTA-08)
7449bfa fix(planning): typed test assertions and TTL zero bound (phase 52, SOTA-08)
afa4205 feat(planning): file-first planning index, presence and change diffs (phase 52, SOTA-08)
```

The other commits in the range are phase 51 (fabric) and phase 48 work, and CI and muse commits, pulled in by merges.

## Deviations from PLAN.md

1. W6, TimescaleDB history: not built. Only `InMemoryHistorySink` exists (`presence.ts:106`). PLAN marks it blocked on an operator-gated migration. CONTEXT D52-b is therefore unmet in production.
2. W6, ledger write from a read: implemented (`read.ts:257-263`). PLAN requires the reviewer to accept or reject it before the phase closes. That decision is still open.
3. Read path writes: PLAN W2 and W3 describe both tools as read-only. The code also writes a presence heartbeat on every call (`read.ts:152`, `read.ts:182`). This is not recorded as a decision in PLAN.
4. CONTEXT D52-h says the adapter "cannot report stale". PLAN W5 chose the server TIME clock instead, and classification reports `stale` (`presence.ts:64-65`). The PLAN decision supersedes D52-h; it is recorded here.
5. Success criteria 1 and 3 (index keyed by content hash with incremental equality; hashes on the change event) are not in PLAN tasks T2 or T6. They are unimplemented, as VERIFICATION.md records.
6. PLAN's wiring section permits the edits to `mcp.ts`, `policy.ts`, `flag-registry.ts` and `config.ts`. Those are not deviations.
7. `.planning/ROADMAP.md` on this branch and on `origin/main` has no phase 52 entry. The criteria were taken from the verification assignment.

## New dependencies

None. `git diff 0df730e HEAD` shows no change to any `package.json` or lock file. The presence client uses Bun's built-in `RedisClient` from the `bun` module (`presence-client.ts:11`). `zod` (`^4.6.5`, `packages/mcp-server/package.json:13`) predates this phase and is used by `presence.ts:12`.
