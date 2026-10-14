# v1.3 Milestone Validation — Build plan completion

**Validated:** 2026-10-11 (UTC) at tip `b3ab09b`
**Scope:** Phases 16–33 (18 phases, 68 approved requirements)
**Verdict:** **PASS with recorded gated remainders** — every phase implemented and verified at the milestone tip; 43 live-tail behaviors across 11 phases are explicitly gated and unproven, each recorded with proof + rollback in its phase runbook/validation map.

## Success criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Finish the build plan — every unfinished area, in build-plan order | ✅ | 18/18 phases executed; PRs #31–#53 merged; all code on `main` |
| Every phase verified at the milestone tip | ✅ | 18/18 `verification_status: passed` (final sweep `b3ab09b`); 6 phases fully verified with zero gaps (16, 18, 19, 20, 21, 23) |
| Gated live tails do not block milestone closure | ✅ (convention) | 43 `behavior_unverified` items across 11 phases (22:6, 24:8, 25:4, 26:4, 27:1, 28:2, 29:3, 30:2, 31:4, 32:4, 33:5) — each with proof, rollback, and runbook pointer |
| One PR per phase, Greptile-reviewed, merged | ✅ | PRs #31, #33, #35 (pre-session), #45–#53; Greptile findings addressed or dispositioned on-PR |
| Failures at HEAD recorded, not fixed | ✅ | F-01 (rehearsal `--port 7410` cwd-sensitive guard) recorded in every affected verification; F-02 fixed by its owning phase (20) |
| Suite health at tip | ✅ | bun 3136 pass / 58 skip / 1 recorded env fail; pytest 246; tsc clean; phase-close pass (EVENT_KINDS 12, SURFACES 27); store/redact/vocabulary locks green |

## Phase outcome table

| Phase | Outcome | Verification | Gated remainders |
| --- | --- | --- | --- |
| 16 Production parity & rehearsal harness | complete | passed (refreshed) | — |
| 17 Event vocabulary & audit policy | complete | passed (pre-session) | — |
| 18 Guard rails & shared redactor | complete | passed (refreshed) | — |
| 19 Lane B collectors | complete | passed (refreshed) | — |
| 20 Production identity & Phase 0 UAT | complete | passed | switch window executed 2026-10-10 (soak clean); scenarios 2+5 pass live |
| 21 skills_propose | complete | passed (refreshed) | first real agent-skills PR → phase 22 tail |
| 22 Skills sync, bridge, miners | complete | passed/partial (bu=6) | cutover chain + client rebinds (8 steps, runbook) |
| 23 Claim mirror & DoD gate | complete | passed (refreshed) | MIRROR-08 live proof (SWC-467) scripted, NOT RUN |
| 24 substrate-dispatcher | complete | passed/partial (bu=8) | env provisioning, DISP-08 window, unit restart, state review |
| 25 Docs search & ingest (RAGFlow) | complete | passed | G1–G4 (probe, datasets, ingest, served search) |
| 26 Hindsight recall & Dragonfly cache | complete | passed | G1–G4 (probe, bank/recall, retain, topology + headless proof) |
| 27 Ledger primitives & ingest order | complete | passed (refreshed) | gap unchanged (bu=1) |
| 28 Hourly anchor job & verify | complete | passed (refreshed) | devnet L1–L10 deferred; v1.1.4 anchors cadence acceptance |
| 29 Agent Cards & teachables | complete | passed | G1 spec diff, G2 publication, G3 devnet-backed teachable |
| 30 desktop_run | complete (7/7) | passed | live proof chain, N1 spike ladder, allowlist+restart |
| 31 Lane A runtime (spike/host) | complete | passed | G1 npm ci, G2 engine session, G3 no-KVM boot, G4 unit install |
| 32 Lane A host core | complete | passed | L1 VM-backed node run, L2 unit, L3 manifest, L4 quota |
| 33 Lane A dispatch route & approvals | complete | passed | G1–G5 (label wiring, VM dispatch, approvals, push/PR/Done, activations) |

## Suite evidence at tip (`b3ab09b`)

- `bun test`: **3136 pass / 58 skip / 1 fail** — the 1 fail is the recorded F-01 environment-sensitive guard (behavior intact, fails identically on main)
- `pytest`: **246 passed** (miner 52 + dispatcher 194)
- `bunx tsc --noEmit`: clean
- `check:phase-close`: pass — EVENT_KINDS 12 (closed, phase-17 lock), SURFACES 27
- Locks: store-lock, redact-lock, vocabulary-lock, phase-close locks all green

## Requirement coverage

All 68 approved requirements map to phases 16–33 and are implemented on `main`. REQUIREMENTS DESK traceability checkboxes remain Pending per the recorded convention (verified phases 27/28/30 precedent) — flip at operator milestone-acceptance. Live-tail UAT for gated behaviors is tracked per phase in `behavior_unverified` frontmatter and the runbooks listed below.

## Gated remainders ledger (43 items — one operator window set)

Runbooks holding every proof + rollback: `docs/runbooks/production-identity.md` (identity evidence table), `dispatch-proof.md` (NOT RUN), `docs-proof.md`, `hindsight-cache-proof.md`, `mirror-proof.md`, `lane-a-host.md`, phase VALIDATION maps (22, 24, 25, 26, 28, 29, 30, 31, 32, 33). No live step has been executed by an agent; the identity switch (phase 20) ran in an operator-approved window on 2026-10-10 with clean soak.

## Non-goals held

RAGFlow/Hindsight MCP in agent configs (D9/D25-01/D26-01); Hindsight as store of record; new EVENT_KINDS (12 held); Dragonfly as queue/lock; auto-merging skills; agent-side credential handling.
