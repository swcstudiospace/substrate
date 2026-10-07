---
phase: 09-ultrathink-integration
plan: 01
subsystem: claude-ultrathink hook / substrate client
tags: [ultrathink, substrate, ledger, fail-open, graph-id]
provides:
  - one fail-open `note` plan event per planned prompt, carrying the Graph ID
  - HookDeps.emit seam
  - per-graph session id `<host session>:<graph id>`
key-files:
  created: []
  modified:
    - src/claude/hook.ts
    - src/claude/hook.test.ts
    - src/substrate/brief.ts
    - src/substrate/brief.test.ts
    - CHANGELOG.md
    - README.md
    - docs/privacy.md
    - docs/configuration.md
    - docs/architecture.md
key-decisions:
  - Emit only from runPromptSubmit after a successful session write; src/host/plan.ts reaches the same function, so no double emit.
  - Session id `<host session>:<graph id>` so per-session hash chains never interleave graphs.
  - Payload is Graph ID, host, repo slug, branch, node count; never prompt, spec or plan text.
  - Request bounded by the planning budget (AbortSignal combined with the 1.5 s timeout; skipped when the budget is spent); elapsed time in the summary includes the wait.
  - No graph registration from the hook (ADR keeps graph tools MCP-only; kickoff skill registers via MCP).
completed: 2026-10-07
status: complete
---

# 09-01 Summary

PR claude-ultrathink #19, branch `feat/substrate-plan-event`, commits `9ef87a6` + `6b3a76f`.

## What changed
- `runPromptSubmit` sends one `note` event via `emitEvent` after planning and writing the session record, through the new `HookDeps.emit` seam.
- Nothing is sent without a substrate URL or with `SUBSTRATE_DISABLED=1`. Skipped prompts, fallback specs, unknown sessions and failed state writes emit nothing. A rejecting or throwing emitter leaves the hook result identical.
- Greptile follow-up (`6b3a76f`): the request is bounded by the planning budget (AbortSignal combined with the 1.5 s timeout, skipped when the budget is spent) and the summary's elapsed time includes the wait.
- `docs/privacy.md` lists the request; CHANGELOG, README, configuration and architecture docs updated.

## Evidence
- Branch: `tsc` clean, 2241 pass / 0 fail.
- Live S1 smoke (/tmp/s1-live-smoke.sh, 24/24): the ultrathink `emitEvent` client was accepted by the live server and its note stored under the same Graph ID.
- Greptile review on #19 in progress; findings so far fixed in `6b3a76f`.

## Deliberate exclusions
- No hook-side graph registration (would need a REST door the ADR does not allow).

## Separate, out of scope
PR claude-ultrathink #18 (teach autonomous capture, published in this run from a commit that was only on local main) has 6 open Greptile findings in its own feature (`src/teach/skills.ts`, `docs/privacy.md`). Outside v1.1; left for the user.
