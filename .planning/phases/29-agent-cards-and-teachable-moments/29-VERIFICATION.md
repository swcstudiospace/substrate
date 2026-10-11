---
phase: 29-agent-cards-and-teachable-moments
verified: 2026-10-11T02:10:00Z
status: passed
score: 12/12 must-haves rehearsal-proven (CARD-01..04 + teachable corpus); live G1/G2/G3 OPERATOR-GATED
covered_files: [".planning/phases/29-agent-cards-and-teachable-moments/29-01-PLAN.md", ".planning/phases/29-agent-cards-and-teachable-moments/29-01-SUMMARY.md", ".planning/phases/29-agent-cards-and-teachable-moments/29-02-PLAN.md", ".planning/phases/29-agent-cards-and-teachable-moments/29-02-SUMMARY.md", ".planning/phases/29-agent-cards-and-teachable-moments/29-03-PLAN.md", ".planning/phases/29-agent-cards-and-teachable-moments/29-03-SUMMARY.md", "docs/agent-cards.md", "packages/mcp-server/src/agent-card.fixtures.ts", "packages/mcp-server/src/agent-card.test.ts", "packages/mcp-server/src/agent-card.ts", "packages/mcp-server/src/server.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/teachable-anchor.test.ts", "packages/mcp-server/src/teachable.fixtures.ts", "packages/mcp-server/src/teachable.test.ts", "packages/mcp-server/src/teachable.ts"]
covered_digest: "v3:sha256:18d9f62419b3dedc0be2c2f06e380ca1f234ab92cda354e35d9cec480c216632"
behavior_unverified: 3
overrides_applied: 0
registration:
  previous_status: missing
  registered_at_tip: ed696ef
  digest_check: card/teachable sources byte-identical since PR #50 (bc8f839) — no later phase touched them; feature tests re-run green at tip (see confirmation below)
  gaps_remaining: ["G1 published A2A spec fetch + validator diff (UNVERIFIED pending G1)", "G2 loopback card read per surface + publication decision", "G3 devnet-backed teachable anchor + verify proof hour"]
---

# Phase 29: Agent Cards and teachable moments — Verification

**Verified:** 2026-10-10 at main tip `bc8f839` (PR #50 squash-merged).
**Scope:** in-repo only. CARD-01..CARD-04 rehearsal half; G1/G2/G3 are
operator windows, never executed by agents.

## Executed plans

| Plan | Commit(s) | Outcome |
|------|-----------|---------|
| 29-01 teachable write path | b9ba253 | Predicate + sample-shaped `note` emit + 6-row corpus, pinned |
| 29-02 card builder + route | 3eacfae | Builder, UNVERIFIED validator, reader, loopback route |
| 29-03 anchor proof + docs | 7d4324e | Scratch coverage proof, card e2e, `docs/agent-cards.md` |
| Review fixes (Greptile r1) | 7eace4b | All 5 findings addressed (see below) |
| Summaries | 12c6eea | 29-01/02/03-SUMMARY.md with evidence |

## Evidence (all green at merge)

- `bun test` full suite: 2887 pass / 58 skip / 1 fail — the 1 fail is
  `scripts/rehearsal.test.ts --port 7410`, which fails identically on main
  (production-checkout guard fires first in this environment). Pre-existing,
  unrelated, out of scope.
- `pytest`: 230 passed.
- `bunx tsc --noEmit`: clean.
- `bun run check:phase-close`: pass — EVENT_KINDS at 12, SURFACES at 27.
- CI on PR #50: "Typecheck, tests and repo locks" SUCCESS; Greptile Review
  SUCCESS (initial 4/5 review with 1 P1 + 4 P2, all fixed, re-review green).
- PR: https://github.com/swcstudiospace/agent-substrate/pull/50 (squash-merged as `bc8f839`).

## Greptile r1 findings — disposition

1. **P1 reader shared cutoff** — fixed: `writer` + `kind` filter before paging
   (new optional `MemorySearch` predicates, same SQL pattern); `isTeachable`
   still decides each row.
2. **P2 empty slug as skill** — fixed: reader reuses `isTeachable`; test added.
3. **P2 replay double-emit** — fixed: `deduplicated` replays trail nothing;
   replay test added. Residual: a crash between insert and ack recovered under
   the same key (`recovered.orphan`) trails nothing — accepted as best-effort
   trail semantics.
4. **P2 stale warnings hidden** — fixed: `needs_reverification` entries carry
   a "Check this advice before use. " prefix; test added.
5. **P2 versioning claim wrong** — fixed: `fact` is append-only
   (`conflictPlan`); docs + module comment now say revisions supersede by
   recency, newest first.

## Live-tail status

Nothing live ran in this phase. No devnet transaction, no spec fetch, no card
served beyond loopback, no `SOLANA_*` credentials anywhere (proof uses a fake
in-process pubkey through the config object).

## OPERATOR APPROVAL NEEDED

The following gated steps were recorded verbatim from the phase plans and
have NOT been executed. Each needs explicit operator approval:

- **G1:** Fetch the published A2A spec
  (`https://a2a-protocol.org/latest/specification/`) and diff its Agent Card
  required fields against the in-repo validator set; record confirmation or
  correction in the phase report. (read-only, network read; rollback: none)
- **G2:** Read a loopback card per surface
  (`GET /.well-known/agent-card.json?surface=<name>` × 27); decide whether
  any card is published beyond loopback (none in v1.3 — exposure is a
  separate operator decision). (read-only loopback; rollback: stop
  serving / restrict)
- **G3:** With the funded devnet key: emit a proof teachable into
  production, let the hourly timer anchor its hour, read the memo back by
  `tx_sig`, `substrate verify <proof graph>` shows the teachable hour
  `anchored`. (write: production ledger + devnet + `anchors` row + ledger
  event; rollback: none needed — one proof hour stands as history)

---

## Close-out sweep tip confirmation (2026-10-11, HEAD `ed696ef`, PR #53 merged)

Card/teachable sources byte-identical since PR #50 (`bc8f839`) — no later phase touched
them. Feature tests re-run at tip (`agent-card + teachable + teachable-anchor`, inside the
272-test 25/26/29 run): **all green, 0 fail**. Full `bun test` 3136 pass / 58 skip / 1 fail
(F-01 only), `bunx tsc --noEmit` clean, pytest 246 passed, `check:phase-close` pass.
Live G1/G2/G3 stay OPERATOR-GATED — never run.
