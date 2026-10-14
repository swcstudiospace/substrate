---
phase: 31-lane-a-runtime
verified: 2026-10-11T02:10:00Z
status: passed
score: 9/9 must-haves rehearsal-proven (spike step-0 + 23/23 host smoke); live G1-G4 OPERATOR-GATED
covered_files: [".planning/phases/31-lane-a-runtime/31-01-PLAN.md", ".planning/phases/31-lane-a-runtime/31-01-SUMMARY.md", ".planning/phases/31-lane-a-runtime/31-02-PLAN.md", ".planning/phases/31-lane-a-runtime/31-02-SUMMARY.md", ".planning/phases/31-lane-a-runtime/31-03-PLAN.md", ".planning/phases/31-lane-a-runtime/31-03-SUMMARY.md", ".planning/phases/31-lane-a-runtime/31-SPIKE.md", "docs/dispatcher.md", "docs/runbooks/lane-a-host.md", "infra/sandbox/Dockerfile", "infra/vps/substrate-host.service", "packages/host/package-lock.json", "packages/host/package.json", "packages/host/src/api.ts", "packages/host/src/audit.ts", "packages/host/src/hostfns.ts", "packages/host/src/main.ts", "packages/host/src/mcp-proxy.ts", "packages/host/src/options.ts", "packages/host/src/sandbox-options.ts", "packages/host/src/sandbox-provider.ts", "packages/host/src/seed.ts", "packages/host/src/substrate.ts", "packages/host/src/sync.ts", "packages/host/src/tasks.ts", "packages/host/src/telegram.ts", "packages/host/src/vm.ts", "scripts/host-smoke.test.ts", "scripts/host-smoke.ts", "scripts/host-spike.test.ts", "scripts/host-spike.ts"]
covered_digest: "v3:sha256:d0c65a568dc3e77689ab4a84c7bad051710c3485290e4e7f56205fb9bda45028"
behavior_unverified: 4
overrides_applied: 0
registration:
  previous_status: missing
  registered_at_tip: ed696ef
  digest_check: "phases 32/33 extended host sources (lease lifecycle, approvals) — provable scope re-proven at tip: host package 225/225, smoke:host 38/38 (superset of the 23/23), spike step-0 unchanged (see confirmation below)"
  gaps_remaining: ["G1 npm ci footprint/bytes/wall time (UNRECORDED)", "G2 shared-engine session (UNVERIFIED)", "G3 no-KVM boot (UNVERIFIED)", "G4 unit install/restart + host-unreachable clearing (staged only)"]
---

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

---

## Close-out sweep tip confirmation (2026-10-11, HEAD `ed696ef`, PR #53 merged)

Phases 32/33 extended the host sources (lease lifecycle, approval deadlines/sweep), so the
provable scope was re-proven at tip rather than carried: `bun test packages/host/`:
**225 pass / 0 fail**; `bun run smoke:host`: **38/38** (superset of the recorded 23/23);
`bun test scripts/host-spike.test.ts` + `host-spike.ts --check` step-0 semantics unchanged
(no-KVM host, spike stops at G1 by design). Full `bun test` 3136 pass / 58 skip / 1 fail
(F-01 only), `bunx tsc --noEmit` clean, `check:phase-close` pass. Live G1–G4 stay
OPERATOR-GATED — never run.
