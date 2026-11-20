---
phase: 31-lane-a-runtime
verified: 2026-11-12T00:00:00Z
status: human_needed
score: 1/3 roadmap success criteria verified in-repo; 2/3 human_needed (operator-gated live G1-G4); 0 failed
covered_files: [".planning/milestones/v1.3-phases/31-lane-a-runtime/31-01-PLAN.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-01-SUMMARY.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-02-PLAN.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-02-SUMMARY.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-03-PLAN.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-03-SUMMARY.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-SPIKE.md", "docs/runbooks/lane-a-host.md", "infra/sandbox/Dockerfile", "infra/vps/substrate-host.service", "packages/host/src/api.ts", "packages/host/src/main.ts", "packages/host/src/sandbox-provider.test.ts", "packages/host/src/sandbox-provider.ts", "packages/host/src/substrate.ts", "packages/host/src/tasks.ts", "packages/host/src/vm.ts", "scripts/host-smoke.test.ts", "scripts/host-smoke.ts", "scripts/host-spike.test.ts", "scripts/host-spike.ts"]
covered_digest: "v3:sha256:342b1d4a25cee3838822f5783207692aacf40d1d890fe5a98bb80e8fa4670498"
overrides_applied: 0
---

# Phase 31: Lane A runtime — Verification

Goal (ROADMAP v1.3, phase 31): `substrate-host` runs from `main` and gives each Graph ID its own agentos VM on this host, within the disk and port limits the host has.

Requirements: LANEA-01 (runtime, VM per Graph ID, port 7411/6420), LANEA-05 (10 GiB disk gate).

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| SC1 | `substrate-host.service` serves `POST /tasks` on loopback 7411, rivet engine on loopback, engine on 6420 untouched | **human_needed** | Code: `main.ts:298` listens on `127.0.0.1`, port from `SUBSTRATE_HOST_PORT` default 7411; `main.ts:71-73` refuses `RIVET_RUN_ENGINE=1` (shared-engine mode only, G2 unverified). Unit staged at `infra/vps/substrate-host.service` (never installed). Live serving and the 6420 non-disturbance are not observed in this run; `host-spike.ts --check` shows 6420 served and 7411 free on this host, which is a precondition read, not a running-service proof. G4 (install/restart) is operator-gated. |
| SC2 | Tasks for two Graph IDs run in two separate rivet-agentos VMs, each with a Docker sandbox | **human_needed** | Rehearsal only: `bun run smoke:host` 38/38 green, including `two actors — 2 vm handles for 2 graph ids` and per-graph `substrate.graph_id` labels on two sandbox containers. The smoke uses a fake `VmHandle` and fake docker. The real rivet VM boot is unproven: G3 (no-KVM boot) is UNVERIFIED and no KVM exists on this host. Sandbox image `substrate-sandbox:0.1` is still absent. |
| SC3 | With less than 10 GiB free, any image build or pull is refused in code before it starts | **VERIFIED** | `sandbox-provider.ts:120` `DISK_FLOOR_BYTES = 10_737_418_240`; `sandbox-provider.ts:167-180` `ensureImagePulled` runs `checkDiskFloor` before any docker call and refuses on below-floor or unreadable `df` (fail-closed). `sandbox-provider.ts:495` calls it at the top of `create()`. The only `.pull(` in `packages/host/src` is `sandbox-provider.ts:185`, behind the gate. `packages/host/src/sandbox-provider.test.ts` covers refuse-below, allow-above, unreadable-df, present-skips-pull, pull-after-gate, and no docker call on refusal. |

## Must-have truths from PLAN frontmatter (condensed)

- 31-01: step-0 read-only asserts and gated tail stop: VERIFIED (`host-spike.ts --check` exit 0; `host-spike.test.ts` + `host-smoke.test.ts` 18/18 pass). Gated G1–G3 stop at the operator gate by design.
- 31-02: host package port, bearer/lease rewrite, pinned deps: VERIFIED in code (`substrate.ts`, `api.ts` bearer and 127.0.0.1 Host check, `packages/host` tests 314/314 pass).
- 31-03: main.ts checkout fix and engine env, staged unit, disk gate, two-VM rehearsal: VERIFIED for the in-repo parts (`main.ts:63-76`, `infra/vps/substrate-host.service` has `ConditionPathExists`, `EnvironmentFile`, `Restart=always`, `RestartSec=5`, no `RIVET_RUN_ENGINE`, and is not installed). Two-VM rehearsal is fake-based, see SC2.

## Verified commands (this run, 2026-11-12, no repo files changed by this run)

- `bun test packages/host/`: 314 pass / 0 fail / 12 files.
- `bun run smoke:host`: 38 checks green (fakes only).
- `bun test scripts/host-spike.test.ts scripts/host-smoke.test.ts`: 18 pass / 0 fail.
- `bun scripts/host-spike.ts --check`: exit 0. Facts: kvm absent, no vmx/svm, 6420 served, 7411 free, disk avail 26939781120 bytes (above 10737418240 floor), substrate-sandbox:0.1 absent.

Not run: `bunx tsc --noEmit`, full `bun test`, `bun run check:phase-close` (not required for the verifier's must-have checks). No live `npm ci`, image pull, `systemctl`, Docker container start, model call, or Linear/Notion call was run, and none is to be run without operator approval.

## Human verification required (operator-gated)

These are never `passed` under this phase's own rules (31-SPIKE.md, runbook docs/runbooks/lane-a-host.md):

1. G1 — `npm ci` footprint/bytes/wall time in a scratch copy (UNRECORDED).
2. G2 — shared-engine session on 6420 (verdict UNVERIFIED; fallback path defined, not run).
3. G3 — no-KVM VM boot and dispose, proving two real rivet-agentos VMs (UNVERIFIED).
4. G4 — install/restart of `substrate-host.service` and clearing of the `host-unreachable` state (unit staged only; the pre-existing September unit is still installed and untouched).

## Gaps / notes

- No BLOCKER. No must-have is FAILED.
- Prior `31-VERIFICATION.md` (status passed, paths under `.planning/phases/31-lane-a-runtime/`, which do not exist, and a `covered_digest` that no longer matches) is superseded by this file. Its "passed" status is not carried forward: its live-gate items were never run.
- `.planning/milestones/v1.3-REQUIREMENTS.md` still lists LANEA-01 and LANEA-05 as unchecked. LANEA-05 is code-verified here; LANEA-01 stays open until G1–G4.
- No `*-SECURITY.md` exists in the phase dir, so the security gate does not block.
