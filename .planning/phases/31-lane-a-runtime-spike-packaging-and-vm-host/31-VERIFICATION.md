---
phase: 31-lane-a-runtime-spike-packaging-and-vm-host
verified: 2026-11-18T12:20:57Z
status: human_needed
score: 1/3 roadmap success criteria verified in code and tests; 2/3 rehearsal-proven, live operator-gated
covered_files: [".planning/milestones/v1.3-phases/31-lane-a-runtime/31-01-PLAN.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-01-SUMMARY.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-02-PLAN.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-02-SUMMARY.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-03-PLAN.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-03-SUMMARY.md", ".planning/milestones/v1.3-phases/31-lane-a-runtime/31-SPIKE.md", "infra/sandbox/Dockerfile", "infra/vps/substrate-host.service", "packages/host/src/api.ts", "packages/host/src/main.ts", "packages/host/src/sandbox-provider.ts", "packages/host/src/vm.ts", "scripts/host-smoke.ts"]
covered_digest: "v3:sha256:ac2979d6e3dd77defcb7163646ba7b46af7ff9bf5308fd475d145d726bbe0a70"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 31: Lane A runtime: spike, packaging and VM host — Verification Report

**Phase Goal:** `substrate-host` runs from `main` and gives each Graph ID its own agentos VM on this host, within the disk and port limits the host actually has.
**Verified:** 2026-11-18T12:20:57Z
**Status:** human_needed
**Re-verification:** No. The phase directory is absent from this tree; its artifacts live under `.planning/milestones/v1.3-phases/31-lane-a-runtime/`. The archived `31-VERIFICATION.md` (status `passed`, dated 2026-10-11) was read as context only. It does not satisfy the live criteria below, which the archive itself lists as operator-gated (G1–G4).

**Source of criteria:** `.planning/ROADMAP.md` Phase 31 `Success Criteria` (3 items). Plans 31-01, 31-02 and 31-03 are recorded as complete in the roadmap.

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `substrate-host.service` serves `POST /tasks` on loopback port 7411 with the rivet engine on loopback; the engine on 6420 keeps running untouched. | ? UNCERTAIN (live operator action, G4/G2) | Code: `packages/host/src/main.ts:298` `server.listen(apiPort, "127.0.0.1", …)` with `apiPort` from `SUBSTRATE_HOST_PORT` defaulting to 7411 (line 63). `packages/host/src/api.ts:4` documents `POST /tasks`, and `api.ts:60` restricts Host to loopback names. `main.ts:65` sets the engine to `http://127.0.0.1:6420`. `main.ts:71-73` refuses `RIVET_RUN_ENGINE=1` so the engine is shared, not spawned. Unit: `infra/vps/substrate-host.service` sets `SUBSTRATE_HOST_PORT=7411` and `SUBSTRATE_ENGINE_ENDPOINT=http://127.0.0.1:6420`, and it is STAGED ONLY (header comment; install/restart is gate G4). Engine-share verdict G2 is UNRECORDED in `31-SPIKE.md`. The smoke check `main binds loopback` passed. The live service has not been installed or started, so `POST /tasks` on the running service is not observed. |
| 2 | Tasks for two Graph IDs run in two separate rivet-agentos VMs, each with a Docker sandbox for native tools. | ? UNCERTAIN (rehearsal-proven with fakes; live boot G3 unverified) | Code: `packages/host/src/vm.ts:18` imports `@rivet-dev/agentos`, and `sandbox-provider.ts` provides the per-task Docker sandbox. Rehearsal: `bun scripts/host-smoke.ts` exited 0 with **38 checks green** (fakes only). Relevant passes: `two actors — 2 vm handles for 2 graph ids`; `label …` and `unprivileged …` and `no socket …` for both `ut-smoke-aaa11111` and `ut-smoke-bbb22222`; `tokens distinct`. `31-SPIKE.md` G3 (no-KVM boot) verdict is UNVERIFIED, and `/dev/kvm` was absent at the 2026-10-10 spike (not re-checked here). The real VM boot and the real sandbox image (`substrate-sandbox:0.1`, absent at spike time) were never exercised. |
| 3 | With less than 10 GiB free, any image build or pull is refused in code before it starts. | ✓ VERIFIED | `packages/host/src/sandbox-provider.ts:120` `DISK_FLOOR_BYTES = 10_737_418_240`. `checkDiskFloor` (line ~132) runs `df --output=avail -B1 /` and refuses below the floor and when df is unreadable (fail-closed). `ensureImagePulled` (line ~167) calls `checkDiskFloor` before any `docker.getImage`/`docker.pull`. The only `docker.pull` call in host source is at line 185, inside that gated function. `SandboxProvider.create()` (line ~495) routes through `ensureImagePulled`. No `docker build` call exists in `packages/host/src` or `scripts`. Targeted test `bun test packages/host/src/sandbox-provider.test.ts -t "checkDiskFloor|ensureImagePulled"`: **7 pass, 0 fail**. Smoke check `disk gate refuses` passed with message `refusing image substrate-sandbox:0.1: 10737418239 bytes free, floor 10737418240 bytes`. |

**Score:** 1/3 truths verified. Criteria 1 and 2 are not FAILED: their code and rehearsal evidence is present and wired. The remaining proof needs a live operator action (G2 engine verdict, G3 boot, G4 unit install and restart), which the planning contract places outside the executor's scope.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/host/src/main.ts` | Host entry on 127.0.0.1:7411, engine on 6420 | ✓ VERIFIED | Exists, substantive, bound loopback; smoke `main binds loopback` passed. |
| `packages/host/src/api.ts` | `POST /tasks` route | ✓ VERIFIED | Route, bearer check, JSON content-type check, loopback Host check. |
| `packages/host/src/vm.ts` | agentos VM runtime per Graph ID | ✓ VERIFIED (code) | Imports `@rivet-dev/agentos` and `@rivet-dev/agentos-sandbox`. Live boot not exercised (G3). |
| `packages/host/src/sandbox-provider.ts` | Disk gate before any image build/pull | ✓ VERIFIED | `DISK_FLOOR_BYTES`, `checkDiskFloor`, `ensureImagePulled`; 7 targeted tests pass. |
| `infra/sandbox/Dockerfile` | Sandbox image definition | ✓ VERIFIED (exists) | Pinned bun and sandbox-agent versions. The image build is an operator step (`docs/runbooks/disk-pressure.md` lists the floors). It is not run from host code. |
| `infra/vps/substrate-host.service` | Unit on 7411 with shared engine on 6420 | ⚠️ STAGED ONLY | Not installed on the host. Gate G4. |
| `scripts/host-smoke.ts` | Two-VM rehearsal proof | ✓ VERIFIED (rehearsal) | `bun scripts/host-smoke.ts`: 38 checks green, exit 0. Fakes only. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `main.ts` | `api.ts` `createApiServer` | `server.listen(apiPort, "127.0.0.1")` | ✓ WIRED | `main.ts:298`. |
| `main.ts` | rivet engine 6420 | `createClient({ endpoint: engineEndpoint })` | ✓ WIRED | `main.ts:243`, endpoint `http://127.0.0.1:6420`. |
| `sandbox-provider.ts create()` | `ensureImagePulled` | direct call before any docker call | ✓ WIRED | Line ~495. |
| `ensureImagePulled` | `checkDiskFloor` | gate first | ✓ WIRED | Gate executes before `getImage`/`pull`. |
| `infra/vps/substrate-host.service` | `main.ts` | `ExecStart=/usr/bin/node packages/host/src/main.ts` with `SUBSTRATE_HOST_PORT=7411` | ⚠️ STAGED | Not installed; G4. |

### Data-Flow Trace (Level 4)

Not applicable. The phase delivers a task API and a VM runtime; it renders no dynamic UI data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Two-VM rehearsal, loopback bind, disk-gate refusal | `bun scripts/host-smoke.ts` | 38 checks green, exit 0 (fakes only) | ✓ PASS (rehearsal) |
| Disk floor gate and no-docker-call refusal | `bun test packages/host/src/sandbox-provider.test.ts -t "checkDiskFloor|ensureImagePulled"` | 7 pass, 0 fail | ✓ PASS |
| Live `POST /tasks` on running service | not run (service not installed; operator-gated) | — | ? SKIP |

### Probe Execution

No probes declared for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| LANEA-01 | 31-01, 31-02, 31-03 | Lane A host packaging and VM runtime | ? NEEDS HUMAN (live) | Packaging and rehearsal evidence above; live boot G1–G3 unverified. |
| LANEA-05 | 31-03 | Disk floor refuses image build/pull below 10 GiB | ✓ SATISFIED | Criterion 3 evidence above. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `infra/vps/substrate-host.service` | 1-3 | Staged-only unit, explicitly documented | ℹ️ Info | Expected. Install is gate G4. |
| `infra/vps/substrate-host.service` | 11-12 | `G2` engine share marked UNVERIFIED | ⚠️ Warning | Engine env depends on an unrecorded G2 verdict. |
| `.planning/milestones/v1.3-phases/31-lane-a-runtime/31-VERIFICATION.md` | frontmatter | Prior `status: passed` with live G1–G4 listed as NOT proven | ℹ️ Info | Not carried forward. Live criteria are not proven by it. |

No `TBD`, `FIXME`, or `XXX` markers were found in the phase's host source files. No unreferenced debt markers were recorded.

### Human Verification Required

### 1. Live `substrate-host.service` serves POST /tasks on 7411 beside engine 6420

**Test:** In an operator-approved window (gate G4), install `infra/vps/substrate-host.service`, then `systemctl restart substrate-host`. Run `curl -s -X POST http://127.0.0.1:7411/tasks` with the bearer token and a valid body. Run `docker ps` and confirm `gcs-rivet-rivet-engine-1` is still healthy on 6420.
**Expected:** A 202 or 400 response from the service (not connection refused). The engine container is still running and bound to 6420. The September unit `RIVET_RUN_ENGINE=1` is no longer active.
**Why human:** Installing and restarting a systemd unit on the production host is an operator action. G2 (shared-engine session) is unrecorded in `31-SPIKE.md`.

### 2. Two Graph IDs run in two separate live rivet-agentos VMs with sandboxes

**Test:** After G3 (no-KVM boot) is run by the operator, open two tasks for two distinct Graph IDs through `POST /tasks`. Confirm two agentos VMs are running (`docker ps` shows two labelled `substrate.graph_id` sandboxes, each with `Privileged=false`, no docker socket). Dispose both and confirm the dispose hooks run.
**Expected:** Two separate VMs and two sandbox containers, one per Graph ID, with distinct tokens.
**Why human:** Real VM boot is UNVERIFIED (`/dev/kvm` absent). The sandbox image `substrate-sandbox:0.1` must be built or pulled in an operator window; the disk gate will refuse this below 10 GiB free.

### 3. Sandbox image build or pull on the host

**Test:** Confirm host free space is at least 10 GiB (`df -B1 /`), then build or pull `substrate-sandbox:0.1` in an approved window.
**Expected:** The image appears in `docker images`. Below the floor, the in-code gate refuses before any docker call.
**Why human:** The image build is an operator-run step outside host code, and it needs approval.

## Gaps Summary

No gaps block the code. All three roadmap success criteria have code evidence and no criterion is FAILED. Criteria 1 and 2 remain human-needed because their final proof is live: the shared-engine verdict (G2), the no-KVM boot (G3), and the unit install and restart (G4) are operator-gated. Criterion 3 is fully verified in code and tests. The phase directory is absent from the current tree; the artifacts are archived under `.planning/milestones/v1.3-phases/31-lane-a-runtime/`.

---

_Verified: 2026-11-18T12:20:57Z_
_Verifier: Claude (gsd-verifier)_
