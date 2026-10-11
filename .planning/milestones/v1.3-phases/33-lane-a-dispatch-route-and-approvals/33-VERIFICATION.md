---
phase: 33-lane-a-dispatch-route-and-approvals
verified: 2026-10-11T02:10:00Z
status: passed
score: 12/12 must-haves rehearsal-proven (fake-host route + approvals + 29/29 chain); live G1-G5 OPERATOR-GATED
covered_files: [".planning/phases/33-lane-a-dispatch-route-and-approvals/33-01-PLAN.md", ".planning/phases/33-lane-a-dispatch-route-and-approvals/33-01-SUMMARY.md", ".planning/phases/33-lane-a-dispatch-route-and-approvals/33-02-PLAN.md", ".planning/phases/33-lane-a-dispatch-route-and-approvals/33-02-SUMMARY.md", ".planning/phases/33-lane-a-dispatch-route-and-approvals/33-03-PLAN.md", ".planning/phases/33-lane-a-dispatch-route-and-approvals/33-03-SUMMARY.md", "docs/dispatcher.md", "docs/runbooks/dispatch-proof.md", "docs/runbooks/lane-a-host.md", "packages/dispatcher/tests/test_claude_code_route.py", "packages/dispatcher/tests/test_dispatch.py", "packages/dispatcher/tests/test_host.py", "packages/dispatcher/tests/test_sessions.py", "packages/host/src/main.ts", "packages/host/src/tasks.test.ts", "packages/host/src/tasks.ts", "packages/host/src/telegram.test.ts", "packages/host/src/telegram.ts", "scripts/dispatcher-smoke.ts", "scripts/lane-a-e2e.ts"]
covered_digest: "v3:sha256:d7eff14392e4bdd509994d815b45c2aa95c3d2fe81391dd9039ef28744077a9e"
behavior_unverified: 5
overrides_applied: 0
registration:
  previous_status: missing
  registered_at_tip: ed696ef
  origin: written fresh in the v1.3 close-out sweep from the three plan summaries (no prior phase-level report existed); every cited proof re-ran green at tip
  gaps_remaining: ["G1 label wiring live", "G2 real VM dispatch", "G3 real approvals", "G4 real push, PR, sync, gated Done", "G5 production unit activations + manifest flips"]
---

# Phase 33: Lane A dispatch route and approvals — Verification

**Phase Goal:** `dispatch:claude-code` routes to the host and a refusal becomes a once-only
comment; permission requests reach a human through single-use Approve/Deny buttons with a
timeout; the fake label-to-Done chain proves the full loop with zero live systems.
**Verified:** 2026-10-11T02:10:00Z at `main` tip `ed696ef` (PR #53 merged).
**Status:** passed, rehearsal scope. LANEA-08 G1–G5 are OPERATOR-GATED, never executed.
**Scope:** in-repo only (LANEA-04/06/08 rehearsal halves).

## Executed plans

| Plan | Commit(s) | Outcome |
|------|-----------|---------|
| 33-01 fake-host route rehearsal (LANEA-04) | b6e9537 | 13-test route file + driver S11–S16 matrix, zero routing-logic diffs |
| 33-02 approval deadlines + single-use (LANEA-06) | 49f1bdd | `deadlineMs` + tick sweep + claim-first `respondApproval`, injected-clock proofs |
| 33-03 fake chain + docs + G1–G5 tail (LANEA-08) | ac51777, 3c65364 | 29/29 one-command chain, runbook live-route section, gate-marker pin 13 |

## Evidence (all green at tip `ed696ef`, re-run 2026-10-11)

- `python3 -m pytest packages/dispatcher/tests -q`: **194 passed** (178 baseline + 16 new:
  13 claude-code route, +2 host non-JSON/wrong-shape, +1 sessions exited-unclaimed).
- `scripts/dispatcher-driver.py`: 0 failures incl. new S11–S16 claude-code matrix.
- `bun test packages/host/`: **225 pass / 0 fail** (211 baseline + 14 new: 10 tasks, 4 telegram).
- `bun scripts/lane-a-e2e.ts`: **29/29 checks green** (dispatch→POST→open→heartbeat→fake
  Approve→timeout bound→restart resume-once→re-posted approval→commit/push/PR→sync→DoD
  complete→single release→mirror→Done; refusal replays all say why once).
- `bunx tsc --noEmit`: clean. `bun run check:phase-close`: pass (EVENT_KINDS 12, SURFACES 27).
- Full `bun test`: 3136 pass / 58 skip / 1 fail (F-01 rehearsal-harness env failure,
  pre-existing phase-16 scope). Full pytest (miner + dispatcher): 246 passed.
- Gate-marker pin: `grep -v '^#' docs/runbooks/dispatch-proof.md | grep -c OPERATOR-GATED` → **13**.
- Markers byte-identical (13, asserted in-test per D33-02). Neither manifest row flipped
  (`dormant:24`, `dormant:31` per D33-08).

## NOT proven (OPERATOR-GATED G1–G5, explicitly out of scope)

- G1 label wiring live; G2 real VM dispatch; G3 real approvals (live Telegram taps);
  G4 real push, PR, sync, gated Done; G5 production unit activations + manifest flips.
- `docs/runbooks/dispatch-proof.md` holds each gate's command, proof read, and rollback;
  the executor stops at the gate banners. No quota spent, no VM booted, no unit restarted.
