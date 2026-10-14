# Phase 32 Plan 03: Containment, Worked-Node Rehearsal and Runbook Summary

---
phase: 32-lane-a-host-core
plan: "03"
subsystem: lane-a-host-core-containment
tags: [containment, bearer-scoping, rehearsal, runbook, L1-L4-gated]
requires: []
provides: [bearer-scoping, worked-node-rehearsal, runbook-tail]
affects: [32-02-restart, phase-33-lanea0406]
tech-stack:
  added: []
  patterns: [value-scan-containment, fake-end-to-end-rehearsal, gated-tail]
key-files:
  created: []
  modified:
    - packages/host/src/seed.ts
    - packages/host/src/seed.test.ts
    - packages/host/src/hostfns.test.ts
    - scripts/host-smoke.ts
    - scripts/host-smoke.test.ts
    - docs/runbooks/lane-a-host.md
decisions:
  - "D32-08 settled: bearer rides only the loopback proxy (static hostname gate, never a probe); non-loopback keeps September's headerless entry"
  - "Loopback names are 127.0.0.1, ::1 (bracket-tolerant) and localhost"
  - "Sync-fields proof uses the real HostSync over fake fetch with exact-match Notion PATCH assertion, not a shape check"
  - "Rehearsal completes before the prompt settles (the designed model flow); the settle finds the released flag"
metrics:
  duration: "~120 min"
  completed: "2026-10-11"
  tasks: 3
  commits: 3
  plan_head_before: b3d10b0
status: complete
---

## One-liner

Containment pinned by high-entropy value scans, the worked node rehearsed end to end with fakes (38/38 smoke), and the runbook defines the L1-L4 tail the executor stops at — manifest still `dormant:31`.

## What was built

- **Bearer scoping + value scans (Task 1):** `substrateProxyLoopback()` static gate + `substrateMcpUrl` seam in `seed.ts`. A planted `hb_test_<32hex>` bearer occurs in exactly the one `.claude.json` entry file (loopback) or zero files (non-loopback TEST-NET URL); the lease id in no seed file; `sessionEnv` carries the five D-08 keys only. The hostfn commit→push→pr-create sequence records no planted value in any argv or output, with fixed targets asserted.
- **Worked-node rehearsal (Task 2):** `runWorkedNode()` in `scripts/host-smoke.ts` over temp-dir `TaskStore` + sibling `LeaseStore`: open (202, 0600 lease file, seed read-back, ask-policy open) → heartbeat tick fenced on the lease → host-side commit/push/pr-create (fixed targets, one-PR-per-task, scratch excluded, no force) → `syncTask` through the real `HostSync` (Notion PATCH exact-matches the five PR fields; Linear link-only mutation; no `Status`/`issueUpdate`; no bearer/lease value in any body or header) → `complete` with DoD + lease → single release (settle after complete re-releases nothing) → approvals untouched → logs presence-only. `smoke:host` 23 → 38 checks green.
- **Runbook + L1-L4 tail (Task 3):** lease/heartbeat/re-claim table, restart-resume sequence, containment inventory, and the L1 (real VM node run) / L2 (unit install+restart) / L3 (manifest flip) / L4 (quota spend) gates — each with preconditions, run, record, rollback, and an explicit OPERATOR-GATED body marker (6 non-heading markers; manifest diff empty).

## Deviations from Plan

- **Sync-payload scanning** (Task 1 action text) landed in the Task 2 rehearsal instead of `seed.test.ts`/`hostfns.test.ts`: the scan is stronger there (real `HostSync` over fake fetch, exact PATCH match) and keeps tracker code in its owning modules.
- Related fix on this branch (counted under 32-01, not here): `231b4a5` moved `LeaseStore` to `<storage>/leases` — same-dir co-location would have let `TaskStore.list()` parse `*.lease.json` as garbage records.

## Verification (all exercised)

- `bun run smoke:host` — 38/38 green.
- `bun test packages/host/` — green (seed +5, hostfns +1).
- `bunx tsc --noEmit` — clean.
- `grep -v '^#' docs/runbooks/lane-a-host.md | grep -c OPERATOR-GATED` — 6.
- `infra/identity/clients.json` — diff empty (substrate-host row still `dormant:31`).

## Commits

- 649244f: feat(32-03): settle seeded-bearer scoping with value-scan containment tests
- 77a3253: feat(32-03): end-to-end fake rehearsal of the worked node
- 05746c3: docs(32-03): runbook lease/restart/containment plus L1-L4 gated tail

## Self-Check: PASSED

- All modified files exist; commits verified in log; smoke 38/38 re-run after the final edit.

## Known Stubs

None.

## Threat Flags

None — T-32-03a/b/c/d mitigations are the value scans, the pure-argvs + scratch guard + five-field sync proofs, and the per-gate OPERATOR-GATED markers.
