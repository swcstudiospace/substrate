---
phase: 02-claims-and-dispatch
reviewed: 2026-09-25T07:20:00Z
depth: standard
files_reviewed: 33
files_reviewed_list:
  - "agent-substrate: git diff 585f06d..7079fab -- packages infra (29 files)"
  - "hermes-linear-connector: git diff dc2d74d..HEAD (4 files, /v1/complete-issue)"
findings:
  critical: 0
  warning: 5
  info: 3
  total: 8
status: issues_found
---

# Phase 2: Code Review

Reviewer: gsd-code-reviewer role (read-only). Scope: Phase 2 source diffs only. Planning docs not reviewed.

## Warnings

### WR-01 — DoD gate 5 s abort is shorter than the connector's 30 s Linear call
`packages/mcp-server/src/dod-gate.ts:12`, `:56-62`; `service.ts:331-345`. A client abort does not cancel the sync FastAPI handler, so a 5–30 s Linear call leaves the issue Done in Linear while substrate reports `completed:false`, keeps the claim, skips `Mirror.done`, and a retry's `mirror.review` moves Done back to In Review. **Fix:** gate timeout above the connector's (≈35 s); treat a timeout as unknown and re-read the issue state. Confidence 0.7.

### WR-02 — release/complete take the owner surface from the payload
`packages/mcp-server/src/mcp.ts:208-209`, `:234`; `service.ts:27-32`. `surface ?? callerSurface` lets a token holder assert another surface; the claim session id is public (Linear comment, claim event). Live only once `SUBSTRATE_TOKEN_*` is configured (production is anonymous today). **Fix:** prefer `callerSurface`; reject a payload surface that differs from an authenticated one. Confidence 0.6.

### WR-03 — release write is not conditional on the checked claim
`service.ts:260-264`, `:311-312`, `:342`; `index-store.ts:215`, `:227-231`. Ownership is checked on a snapshot; the UPDATE has no `claimed_by`/`claim_session` predicate, so a same-surface re-claim inside the window is cleared by the old session. **Fix:** compare-and-set UPDATE `… where claimed_by = $surface and claim_session = $session returning node_id`; zero rows → `released:false`. Confidence 0.5.

### WR-04 — real-mode `--once` launches escape the D-14 watch
`packages/dispatcher/src/substrate_dispatcher/__main__.py:130-140`. One tick launches Hermes, then the process exits with its registry and lock: no 900 s timeout, no SIGTERM→SIGKILL, and a second `--once` can double-launch. 02-09 had restricted `--once` to `--dry-run`; 02-07 lifted that. **Fix:** reject `--once` without `--dry-run`, or keep reaping until the registry is empty. Confidence 0.8.

### WR-05 — dispatched Hermes is told to use a Linear tool it does not have
`launcher.py:62-66`, `:33`, `:136-141`. Every dispatched session claims and then stops, leaving a claim held by an ended session. Owner-accepted as a Phase 2 shortfall (02-PROOF.md Gap 3, verification override 2). **Fix:** a read-only issue-fetch tool on substrate-mcp (it holds `LINEAR_API_KEY`), pointed to by the ids-only prompt, plus a "call graph_release and stop if you cannot do the work" step. Confidence 0.75.

## Info

### IN-01 — the env allowlist does not keep secrets from a root Hermes
`launcher.py:136-141`; `infra/vps/substrate-dispatcher.service:10-20`. No `User=`: dispatcher and Hermes run as root with terminal/file tools and can read `/etc/substrate/substrate.env` (Linear key, workspace-wide Notion PAT, Postgres URL, Greptime password), and could set Done bypassing the gate. **Fix:** run Hermes as an unprivileged user that cannot read `/etc/substrate`, or document the root trust assumption. Confidence 0.55.

### IN-02 — prompt ids validated after the worktree is created
`dispatch.py:211-214`; `launcher.py:83-86`. An out-of-pattern node id creates the worktree, then raises a non-`WorktreeRefused` `ValueError`, logged every 30 s forever with no comment or give-up. **Fix:** validate before checkout/ensure; map `ValueError` to a once-only marker. Confidence 0.6.

### IN-03 — index writes after a gate approval are unguarded
`service.ts:340-344`. A Postgres error after Linear is Done skips `Mirror.done` and the `complete` event; a retry moves Done back to In Review. **Fix:** once `gate.completed`, catch and warn on index writes so `Mirror.done` and the event always run. Confidence 0.5.

## Fix pass (2026-09-25, autonomous code-review fix chain)

| ID | Status | Commit |
|---|---|---|
| WR-01 | fixed — gate timeout 35 s (`SUBSTRATE_DOD_GATE_TIMEOUT_MS`); timeout settled by the issue's Linear state; retry on a Done issue skips review and gate | a63fddb |
| WR-02 | fixed — authenticated callerSurface wins; a different payload surface is refused with no write; anonymous mode unchanged | e74ce9a |
| WR-03 | fixed — `releaseNode` is compare-and-set on claimed_by + claim_session; 0 rows → `released:false` / warning after approval | 21667e9 |
| WR-04 | fixed — `--once` requires `--dry-run` (exit 2); the unit runs the loop | 41c5089 |
| WR-05 | open — owner decision (owner-accepted shortfall in 02-PROOF.md) | — |
| IN-01 | open — owner decision (privilege model for dispatched Hermes) | — |
| IN-02 | fixed — ids validated before checkout/worktree; once-only `invalid-ids` comment and give-up | a0c5b11 |
| IN-03 | fixed — index writes after gate approval warn instead of throwing | 7b8ad5c |

Gate after fixes: agent-substrate 167 pass / 0 fail, tsc exit 0; dispatcher 114 passed. substrate-mcp restarted 07:27:18Z, healthz index+greptime true, mirror linear+notion on.
