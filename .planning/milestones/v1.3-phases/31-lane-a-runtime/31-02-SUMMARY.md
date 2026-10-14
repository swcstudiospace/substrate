# Phase 31 Plan 02: Host package port Summary

---
phase: 31-lane-a-runtime
plan: "02"
subsystem: lane-a-host-port
tags: [port, lease-model, bearer-auth, host]
requires: []
provides: [host-package, bearer-substrate-client, lease-store, seed-bearer-entry]
affects: [31-03-wiring]
tech-stack:
  added: ["@agentos-software/claude-code@0.2.7 (declared exact; already in npm tree transitively)"]
  patterns: [verbatim-port, seam-rewrite, injected-fakes]
key-files:
  created:
    - packages/host/src/options.ts
    - packages/host/src/sandbox-options.ts
    - packages/host/src/hostfns.ts
    - packages/host/src/sync.ts
    - packages/host/src/telegram.ts
    - packages/host/src/mcp-proxy.ts
    - packages/host/src/audit.ts
    - packages/host/src/substrate.ts
    - packages/host/src/substrate.test.ts
    - packages/host/src/tasks.ts
    - packages/host/src/seed.ts
    - packages/host/src/vm.ts
    - packages/host/src/sandbox-provider.ts
    - packages/host/src/api.ts
    - packages/host/package-lock.json
    - infra/sandbox/Dockerfile
  modified:
    - packages/host/package.json
    - packages/host/src/seed.test.ts
decisions:
  - "substrate.ts rewritten (not ported): bearer + lease_id + heartbeat; all September method shapes kept so tasks.ts ports whole"
  - "Seed bearer rides the sessions' MCP entry as a carried header value; rotation/scoping is Phase 32 (LANEA-02/03/07)"
  - "Lock not re-resolved in-repo for the new declared dep; G1 npm ci resolves it (0.2.7 already in tree, integrity matches)"
metrics:
  duration: "~60 min"
  completed: "2026-10-10"
  tasks: 3
  tests_added: 12
status: complete
---

One-liner: fourteen host modules ported from acc30a8 with the bearer/lease auth cutover, unit-tested with fakes, install-free.

## Tasks completed

1. Leaf-module verbatim port — options, sandbox-options, hostfns, sync, telegram, mcp-proxy, audit (+ all September tests), package.json + 8,498-line lock whole with `@agentos-software/claude-code@0.2.7` added exact, Dockerfile whole. No `npm ci` executed.
2. substrate.ts bearer/lease rewrite plus seed bearer — rewritten client (host-job bearer order `SUBSTRATE_TOKEN_SUBSTRATE` → `SUBSTRATE_TOKEN` → file → tokens dir; `Authorization` on every request; `LeaseStore` 0600 files; `heartbeatDue` at half-TTL; `heartbeat` via `graph_heartbeat`; `claimAndPersist`); seed `.claude.json` substrate entry gains the bearer header via optional `substrateBearer`; tasks.ts `SubstrateLike` gains optional `bearer`, passed into `seedFiles`. New `substrate.test.ts` (10 tests: bearer order, header carriage, no-baked-secret, lease persist 0600, heartbeat); 2 bearer tests appended to `seed.test.ts`.
3. vm.ts actor port — ported whole with the three 0.2.21 workaround comments and D-13 floor; sandbox-provider + api ported whole with tests.

## Verification (all exercised)

- `bun test packages/host/`: 182 pass / 0 fail across 11 files.
- `bunx tsc --noEmit`: clean (rivet types resolve via `packages/host/node_modules`; root `bun.lock` has zero `agentos` entries).
- `bun run check:phase-close`: pass.
- `git status`: no half-install (`packages/host/node_modules` gitignored, untracked-only).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Restored dropped `graphClaim` method**
- **Found during:** Task 2 test run (`this.graphClaim is not a function`)
- **Issue:** the rewrite omitted September's `graphClaim`; `claimAndPersist` calls it.
- **Fix:** restored verbatim; 10/10 substrate tests green.

**2. [Rule 2 - Correctness] Narrowed inline-cast member reads to `in`-narrowing**
- **Found during:** Task 2 (repo `ts-no-inline-cast-access` rule)
- **Issue:** September's `(reply.result ?? {}) as {...}` member reads violate the repo lint rule in rewritten code.
- **Fix:** `in`/`typeof` narrowing in `call` and `heartbeat`; verbatim-ported files untouched.

## Known Stubs

None. The seeded bearer header is the Phase-32-owned shape (rotation/scoping deferred per out-of-scope LANEA-02/03/07), not a stub: VM calls authenticate today, and the discipline lands in Phase 32.

## Self-Check: PASSED
