---
phase: 32-lane-a-host-core
verified: 2026-10-11T02:10:00Z
status: passed
score: 12/12 must-haves rehearsal-proven (lease lifecycle + 38/38 worked-node smoke); live L1-L4 OPERATOR-GATED
covered_files: [".planning/phases/32-lane-a-host-core/32-01-PLAN.md", ".planning/phases/32-lane-a-host-core/32-01-SUMMARY.md", ".planning/phases/32-lane-a-host-core/32-02-PLAN.md", ".planning/phases/32-lane-a-host-core/32-02-SUMMARY.md", ".planning/phases/32-lane-a-host-core/32-03-PLAN.md", ".planning/phases/32-lane-a-host-core/32-03-SUMMARY.md", "docs/runbooks/lane-a-host.md", "infra/vps/substrate-host.service", "packages/host/src/hostfns.test.ts", "packages/host/src/seed.test.ts", "packages/host/src/substrate.test.ts", "packages/host/src/substrate.ts", "packages/host/src/sync.test.ts", "packages/host/src/tasks.test.ts", "packages/host/src/tasks.ts", "scripts/host-restart.test.ts", "scripts/host-smoke.test.ts", "scripts/host-smoke.ts"]
covered_digest: "v3:sha256:166b439fa48b0d46b71fedf4ea1b16b48c49c917e9ab8859904adeb3c288f548"
behavior_unverified: 4
overrides_applied: 0
registration:
  previous_status: missing
  registered_at_tip: ed696ef
  digest_check: "phase 33 extended tasks.ts (+93 approval deadlines/sweep) + tasks.test.ts (+165) and added telegram.ts tests; manifest still dormant:31; lease/restart proofs re-run green at tip (see confirmation below)"
  gaps_remaining: ["L1 real VM-backed node run (isolated graph + throwaway repo)", "L2 production unit install/restart", "L3 manifest dormant:31 -> live flip", "L4 real claude-code quota spend outside L1"]
---

# 32-VERIFICATION.md — Phase 32 provable scope

**Branch:** `phase/32-lane-a-host-core` → PR #52. **Merge:** performed 2026-10-11T00:53:55Z (`gh pr ready` n/a — already ready; `gh pr merge --merge --auto` per the v1.3 recorded shipping decision: one PR per phase, Greptile clean, auto-merge).

## Proven in-repo (commands run 2026-10-11, this host, merge commit a11354e)

| Claim | Evidence |
|---|---|
| Lease lifecycle wired (32-01) | `bun test packages/host/src/tasks.test.ts`: 54/54, incl. 14 lease tests (persist-then-verify, 0600 file, presence-only logs, tick/re-claim/fail-closed, single release, fenced completion) |
| Containment pinned (32-03) | seed +5, hostfns +1 value-scan tests; planted bearer in exactly the one entry file (or zero when headerless) |
| Worked-node rehearsal (32-03) | `bun run smoke:host`: 38/38 (23 inherited + 15 worked: open, 0600 lease, seed, ask-policy, heartbeat, commit, push, one-PR, targets, real-HostSync PR-fields-only sync, complete+DoD+lease, single release, approvals untouched, presence-only logs) |
| Restart survival (32-02) | `bun test scripts/host-restart.test.ts`: 2/2 (kill mid-turn → one resume:1 continuation, third boot silent; route failure isolates) |
| Full bun suite | 3122 pass / 58 skip / 1 fail across 124 files — the 1 fail is pre-existing environmental (see below) |
| Python gates | `pytest packages/miner/tests packages/dispatcher/tests`: 230 passed |
| Types | `bunx tsc --noEmit` clean |
| Vocabulary/store locks | `bun run check:phase-close` pass (EVENT_KINDS 12, SURFACES 27) |
| Doctor gate (incl. staged unit) | `bun test scripts/doctor-units.test.ts` 18/18 |
| PR gates | CI "Typecheck, tests and repo locks" pass; Greptile Review pass; no Greptile findings outstanding |
| Manifest untouched | `infra/identity/clients.json` diff empty — substrate-host row still `dormant:31` |
| No live side effects | No VM booted, no unit installed/restarted, no manifest flip, no quota spent; all proofs use fakes |

## The 1 bun failure (pre-existing, recorded not fixed)

- `CLI refusals --port 7410 exits 2 without touching Docker` (`scripts/rehearsal.test.ts`) fails in full-suite runs AND filtered runs on this host: the rehearsal guard refuses the production checkout path (`/root/src/repos/agent-substrate`) before reaching the port check, so stderr names the checkout refusal instead of `reserved`. Both files (`scripts/rehearsal.ts`, `scripts/rehearsal.test.ts`) are untouched by this phase — environmental, out of scope per contract.

## NOT proven (OPERATOR-GATED L1–L4, explicitly out of scope)

- L1 real VM-backed node run on an isolated graph + throwaway repo (quota + Docker spend).
- L2 production unit install/restart with the one-resume-pass verification.
- L3 manifest `dormant:31` → `live` flip.
- L4 any real `claude-code` quota spend outside L1's window.
- Runbook defines each gate with preconditions, run, record, and rollback; the executor stops at L1.

---

## Close-out sweep tip confirmation (2026-10-11, HEAD `ed696ef`, PR #53 merged)

Phase 33 extended `tasks.ts` (+93 approval deadlines/sweep) and `tasks.test.ts` (+165) and
added the `telegram.ts` tests, so the lease proofs were re-run at tip rather than carried:
`bun test packages/host/`: **225 pass / 0 fail**; `bun run smoke:host`: **38/38**;
`bun test scripts/host-restart.test.ts scripts/doctor-units.test.ts`: **20/20**. Manifest
empty (`dormant:31`). Full `bun test` 3136 pass / 58 skip / 1 fail (F-01 only),
`bunx tsc --noEmit` clean, `check:phase-close` pass. Live L1–L4 stay OPERATOR-GATED —
never run.
