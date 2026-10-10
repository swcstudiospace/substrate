# 31-VERIFICATION.md — Phase 31 provable scope

**Branch:** `phase/31-lane-a-runtime` → PR #51 (draft). **Merge:** not performed (AGENTS.md: draft PR only, no merge/auto-merge).

## Proven in-repo (commands run 2026-10-10, this host)

| Claim | Evidence |
|---|---|
| Spike step-0 clean | `bun scripts/host-spike.ts --check` exit 0: kvm absent, no vmx/svm, 6420 served, 7411 free, 128308633600 avail, image absent, store 332755597 |
| Gated tail stops by design | `bun scripts/host-spike.ts` prints G1 banner, exit 3 |
| Spike unit tests | `bun test scripts/host-spike.test.ts`: 16/16 |
| Host package tests | `bun test packages/host/`: 182→191/191 across 13 files (with smoke + gate tests) |
| Two-VM rehearsal proof | `bun run smoke:host`: 23/23 (two openTasks → two actors, ask policy, bearer seed, labeled loopback unprivileged socketless containers, distinct tokens, gate refusal, loopback bind, unit staged) |
| Types | `bunx tsc --noEmit` clean; root `bun.lock` has zero `agentos` entries |
| Vocabulary/store locks | `bun run check:phase-close` pass (EVENT_KINDS 12, SURFACES 27) |
| Doctor gate (incl. new unit) | `bun test scripts/doctor-units.test.ts` 18/18; `--dry-run` no findings |
| No live side effects | `substrate-sandbox:0.1` still absent; September unit still installed, untouched; no image pulled/built; no `npm ci` in-repo |

## NOT proven (operator-gated, explicitly out of scope)

- G1 npm ci footprint/bytes/wall time (UNRECORDED in 31-SPIKE.md).
- G2 shared-engine session (verdict UNVERIFIED; fallback path defined but not run).
- G3 no-KVM boot (verdict UNVERIFIED; gap-not-pass rule recorded).
- G4 unit install/restart and `host-unreachable` clearing (unit staged only).
- Full `bun test`: 3154/3157 — `CLI refusals --port 7410` fails in full-suite runs but passes in isolation (121/121) and with tracked changes stashed; environment/timing-suspect, needs a re-run on the VPS host where 7410 is held. Doctor failures found during execution were fixed (unit moved to release tree, test extended).

## Pre-existing host state (untouched, flagged)

- `substrate-host.service` (September): enabled, inactive, `RIVET_RUN_ENGINE=1` — would collide on 6420 at next start; G4 replaces it.
