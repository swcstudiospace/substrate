---
phase: 07-recall
plan: 03
subsystem: redaction
tags: [wave-1, tdd, d-04, redact, sc2, t-07-03-01, t-07-03-02, t-07-03-03, t-07-03-04]

requires:
  - phase: 07-recall
    plan: 01
    provides: 07-BASELINE.md (agent-substrate-pass=634, tsc clean, head 4fa90f2…); 07-01-INVENTORY.md (11/11 D-04 classes unchanged by redact())
provides:
  - redact.ts RULES — <private> block (first), AKIA, AIza, xoxb-, npm_, glpat-, dop_v1_, sk-proj-, pk-/rk- shapes, case-insensitive api_key/apiKey/api-key assignment
  - redact.test.ts "redact D-04 classes" — 6 tests, fixtures built at run time
  - /var/lib/substrate/phase7-baseline/RESTORE.d/07-03.md (host, 0600 root) — executable code route with the literal baseline head
affects: [07-04, 07-05, 07-06]

actuals:
  tasks: 1
  commits: 2
plan_head_before: 60047760a3bd662d82fb67d097aa8f084dd63c7c

key-files:
  created:
    - /var/lib/substrate/phase7-baseline/RESTORE.d/07-03.md (host, 0600)
  modified:
    - packages/mcp-server/src/redact.ts
    - packages/mcp-server/src/redact.test.ts

key-decisions:
  - "Planner's regexes used as given; <private> rule placed before the PEM rule, token shapes after sk-(?!ant-) and before the JWT rule, api-key rule right after the upper-case KEY rule"
  - "Fixtures use the deterministic rnd(alphabet, n) generator from the plan's interfaces, so the committed test file contains no string matching any D-04 shape"
---

# Phase 7 Plan 03: D-04 redaction classes Summary

`redact()` — the write-path redactor and 07-04's forward-time redactor — now removes every class
agentmemory's `/remember` would have stored verbatim: `<private>…</private>` blocks, AWS `AKIA`,
Google `AIza`, Slack `xoxb-`, `npm_`, GitLab `glpat-`, DigitalOcean `dop_v1_`, OpenAI `sk-proj-`,
`pk-`/`rk-` keys and case-insensitive `api_key`/`apiKey`/`api-key` assignments. Additive only; no
restart (the rules go live at the next substrate-mcp restart — 07-05's planned one, or any unplanned
one; the code route is already in RESTORE.d/07-03.md).

## Commits

| Step | Commit | Files |
|------|--------|-------|
| RESTORE route (host, before the first commit) | — | /var/lib/substrate/phase7-baseline/RESTORE.d/07-03.md |
| RED | 3e0f515 | packages/mcp-server/src/redact.test.ts |
| GREEN | cc124b5 | packages/mcp-server/src/redact.ts |

## TDD Gate Compliance

- RED (3e0f515): `bun test redact.test.ts` → 27 pass / 4 fail. Failing: "D-04 redacts every class
  agentmemory's /remember does not filter", "D-04 keeps the assignment key and drops only the value",
  "D-04 multi-line private block", "D-04 redactValue reaches the new rules through its string path" —
  the classes 07-01-INVENTORY.md recorded as unchanged (11/11). "D-04 leaves near-miss shapes alone"
  and "D-04 redaction is idempotent" already held (controls and a no-op second pass are true of the
  old rules too) and were kept green through GREEN.
- GREEN (cc124b5): redact.test.ts + event.test.ts 64/0; packages/mcp-server/src/skills 111/0.
- REFACTOR: none needed.

## Verification

- Plan `<verify>`: exit 0. RESTORE.d/07-03.md is `600 root`, holds the literal head
  `4fa90f2…ae24..HEAD`, the `(07-03\)` grep and the revert line with no `$H`/`$S`/`<…>`; its git log
  selects both 07-03 commits. redact.ts has every class rule; redact.test.ts has 0 D-04 token-shape
  matches; redact.test.ts 31/0; each of the five named tests runs and passes via `-t`; the redact.ts
  diff against the baseline head removes no non-comment line; both commits carry Refs SPE-3576.
- Two-sided gate vs 07-BASELINE.md: tsc set `tsc-exit=0` (no diff); no failing ids (no diff);
  root suite 640 pass / 0 fail across 36 files > agent-substrate-pass=634.
- `/healthz` on the running service answered 200 when the route was written (the route's own check).

## Deviations from Plan

- **Sixth test added.** The behaviour list's redactValue bullet has no quoted name; it is pinned as
  "D-04 redactValue reaches the new rules through its string path" beside the five named tests.
- **Docblock line rewritten, not appended.** The module docblock's list sentence was extended in
  place ("…passworded connection URLs, and the classes agentmemory's /remember does not filter
  (D-04)."), so the diff removes one comment line — allowed by the verify's non-comment check.
- STATE.md / ROADMAP.md not updated (orchestrator constraint for this shared checkout).

## Threat Flags

None beyond the plan's register: no new endpoint, no restart, no live call.

## Self-Check: PASSED

- FOUND: packages/mcp-server/src/redact.ts, packages/mcp-server/src/redact.test.ts, /var/lib/substrate/phase7-baseline/RESTORE.d/07-03.md
- FOUND commits: 3e0f515, cc124b5
