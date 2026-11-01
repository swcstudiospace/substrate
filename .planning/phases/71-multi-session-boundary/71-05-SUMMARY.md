# 71-05 Summary: Greptile remediation for PR #199

## Scope

Closes the six open Greptile P2 review threads on PR #199 (`gsd/hardening-s1`, head `d535f8c6`). The fixes land on `gsd/v18-p71-greptile-fixes` and are pushed as a fast-forward to the same PR branch. No roadmap scope changed. HARD-S1 and the five Phase 71 criteria are unchanged.

## Shipped

| Thread | Fix | Files |
|---|---|---|
| server.ts:2652 Tool errors lose MCP replies | Invalid live-tool arguments on `/mcp` answer as a JSON-RPC `isError` tool result that keeps the caller's id, at HTTP 200. Unexpected faults are logged under a correlation id and answered as `internal error`. | `packages/mcp-server/src/server.ts`, `mcp.steering.test.ts` |
| service.ts:2231 Private briefs exceed their budget | The private brief path races the whole authority-and-composition sequence against the brief budget. A timeout is `session-unavailable` and returns no detail. | `packages/mcp-server/src/service.ts`, `service.test.ts` |
| service.ts:5853 Search ignores supplied directions | A supplied `steering` wins over stored session directions; stored directions fill in only when none is supplied; an explicit empty string suppresses stored directions. Non-string values are refused at the boundary. | same |
| binding-record.ts:142 Dead records block new sessions | `reclaimDeadBindingRecords` clears only records that the server answers `session-not-found` for. `open` runs it only at capacity, before `client.open`, so no identity is issued on a failed sweep. | `packages/cli/src/steer/binding-record.ts`, `binding-record.test.ts`, `index.ts`, `index.test.ts` |
| steering-sessions-store.ts:213 Discovery scans expired history | A bounded expiry pass (`EXPIRY_PASS_LIMIT` = 100) marks expired, open sessions terminal and clears their free text, keeping the identity. It runs once before each new session is issued, best-effort; discovery and the digest stay read-only. No migration. | `packages/mcp-server/src/planning/steering-sessions-store.ts`, `live-session-authority.test.ts`, `live-session-authority.pg.test.ts` |
| index.test.ts:265 Discovery shortens every handle | The session column width is derived from the handle format (`ls_` plus 64 characters, 67 total), so a full handle prints intact. The test asserts the full handle round-trips through the `queue`, `list` and `close` parser. | `packages/cli/src/steer/render.ts`, `index.test.ts` |

## Decisions

1. **Dead-record sweep runs only at capacity.** The failure needs a full directory. Sweeping on every open would cost up to 256 server calls. Rejected: sweep on every open.
2. **Corrupt or misfiled binding records are an explicit invalid error, never dead.** Auto-deleting them would destroy evidence. Consequence: one corrupt file blocks `open` until an operator removes it.
3. **Only `session-not-found` counts as dead.** The server answers not-found for expired, closed, foreign and wrong-proof targets alike, so that is the only answer the sweep may act on. Every other failure throws.
4. **Capacity refusal reuses `PERSISTENCE_FAILED`.** The brief required the same error as the full-directory path. Its text says the unused issued identity expires, which is inaccurate when nothing was issued. Changing that wording is an owner decision (follow-up 1).
5. **New sweep-error message.** `open` prints "could not be checked; no identity was issued" and exits 1 when a liveness check fails for a reason other than not-found. Before this change that path had no message. Flagged for owner review.
6. **Expiry is a bounded write on the issue path, best-effort.** Each new session issue first runs one bounded pass that marks up to 100 expired, open sessions terminal and keeps their identity. A failure is reported to stderr with a correlation id and the error class only, and does not fail the issue. Discovery and the session digest issue no writes, so the digest stays read-only as designed (criterion 5). Rejected: expiry on read paths, which made the documented read-only digest write. Rejected: deleting rows, and a schema change.
7. **Search steering precedence follows the thread.** The supplied value is authoritative. Non-string values are refused at the boundary; the non-live path previously ignored them silently.
8. **MCP faults are tool errors, not transport errors.** A caller can correct a tool error. Previously it got a bare HTTP 400 without a JSON-RPC envelope, or a 500.

## Verification

Run by the orchestrator in `/root/src/worktrees/as-gsd-v18-p71` after the five fix units reported. Scratch PostgreSQL 16 in a loopback Docker container on port 55433, database `substrate_test`. Bun ran inside a bubblewrap sandbox with `/etc/substrate` masked and the scratch URL passed through the environment only.

| Gate (CI command) | Result |
|---|---|
| `bunx tsc --noEmit` | exit 0 |
| `bunx biome lint --reporter=summary .` | exit 0, 1650 files |
| `bun test` (full repository, live PostgreSQL), one run after the expiry move, 0711 temp root | 11,623 pass, 2 skip, 0 fail, 427 files (11,625 tests) |
| `python3 -m pytest packages/miner/tests packages/dispatcher/tests` | 330 passed |
| `bun run check:phase-close` | 4 lock files green; `EVENT_KINDS` unchanged at 12; `SURFACES` at baseline plus `substrate`, 42 |
| `bun scripts/audit-gate.ts` | 0 unlisted high or critical; 5 accepted, none expired |

The 2 skips are the existing guarded cases: the rehearsal-twin fixture and live loopback Redis, which is unset here.

**Environment note.** The first full run had one failure, `substrate-desktop.sh without root > up refuses without root`. Its privilege-dropping fixture could not traverse the owned `TMPDIR`, which `mktemp` had created at mode 0700. Setting that temp root to 0711 made the file pass 23 of 23. The test was not changed. The bubblewrap command and this prerequisite are recorded in the bun-worktree-credential-isolation skill.

Not run: `gate:boot` (report-only, Docker-bound, CI `boot-gate`) and live-service smokes, which are never run autonomously.

## Status

- Local criteria: 5 of 5, per `71-VERIFICATION.md`. The expiry move keeps criterion 5 true by construction: the session digest issues no writes, and its regression tests pass in the single run above.
- Phase 71 remains **human_needed**. The Desk Quality / Programming Lead Greptile review of the remediation commits has not been observed. The Desk SendToAgent connector is not mounted in this autonomous session, so the handoff could not be sent from here.
- Not merge-ready. Not phase-complete. Not auto-merged.

## Follow-ups (not in this change)

1. Owner decision: wording of the capacity refusal (see Decision 4).
2. Partial index on `expires_at` for open rows, if `EXPLAIN` shows a sequential scan under load. This needs a migration and its own review.
3. Export the handle length from `binding-record.ts` and import it in `render.ts`, to remove the duplicated `ls_` plus 64 derivation.
4. Expiry emits no `steering.session_ended` event, which was already true before this change. Downstream consumers that need it need their own decision.
5. Pool pressure: `sharedDeadline` has no abort handle, so a stalled `FOR UPDATE` keeps its pool connection until the statement timeout. The caller is released on time.
