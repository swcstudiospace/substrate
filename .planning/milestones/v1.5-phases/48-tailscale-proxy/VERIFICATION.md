---
phase: 48-tailscale-proxy
verified: 2026-11-12T08:39:06Z
status: human_needed
score: 2/2 roadmap success criteria verified in-repo; live forwarder and cutover proof human_needed
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "2 of 2 acceptance criteria proven in-repo"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
covered_files: [".env.example", ".planning/milestones/v1.5-phases/48-tailscale-proxy/PLAN.md", ".planning/milestones/v1.5-phases/48-tailscale-proxy/SUMMARY.md", "docs/config-reference.md", "docs/data-planes.md", "docs/event-vocabulary.md", "docs/railway-tailscale.md", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/db-endpoints.test.ts", "packages/mcp-server/src/db-endpoints.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:7e22291a969b566a2edfa7f1028be8d1527fa3e59af2ed89549528280cae9b2c"
human_verification:
  - test: "Run the operator-gated forwarder cutover: set SUBSTRATE_DB_PROXY_ALLOW to the real forwarder host:port values and SUBSTRATE_DB_ENDPOINT_POLICY=enforce, then boot substrate-mcp against the live Greptime, Postgres and Dragonfly forwarders."
    expected: "Boot succeeds; every plane classifies as loopback or proxy; no plane is refused; queries reach the live stores through the forwarders."
    why_human: "Requires the tailnet forwarders, their ACL and live endpoints, which are operator-gated and were not contacted."
  - test: "After the live boot, read the ledger for db.endpoint events."
    expected: "One db.endpoint note per configured plane, with payload {action, runtime, plane, class, policy} and no URL, host or credential."
    why_human: "Requires a live ledger write; in-repo tests use a fake store."
---

# Phase 48: Secure proxy layer for the data planes Verification Report

**Phase Goal:** Greptime, Dragonfly and Timescale are reached through one secure Tailscale proxy layer with RBAC, audit and pooling.
**Verified:** 2026-11-12T08:39:06Z
**Status:** human_needed
**Re-verification:** Yes — regenerated from current code; prior report was 2026-10-21

## Goal Achievement

Roadmap success criteria (the contract): (1) all DBs accessed via a secure proxy; (2) audit events for access. RBAC and pooling are deferred (D48-f) and are not in the acceptance.

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | All DB endpoints are classified loopback / proxy / direct per plane | ✓ VERIFIED | `packages/mcp-server/src/db-endpoints.ts` (`classifyEndpoint`, `parseProxyAllow`); `db-endpoints.test.ts` 287 targeted tests pass (run with config/event-sources/flag-registry tests) |
| 2 | `SUBSTRATE_DB_ENDPOINT_POLICY=enforce` refuses boot for a direct endpoint, naming the variable and not the URL | ✓ VERIFIED | `packages/mcp-server/src/config.ts:1896-1960` (policy parse, direct refusal); `config.test.ts` passes in the same run |
| 3 | Dragonfly URL accepted only as loopback or allow-listed proxy; otherwise cache off fail-open | ✓ VERIFIED | `packages/mcp-server/src/config.ts:1985-2000` (`parseRedisUrl` refusal path); config tests pass |
| 4 | One `db.endpoint` note per configured plane at boot, payload without URL/host/credential, never blocks boot | ✓ VERIFIED | `packages/mcp-server/src/service.ts:5268-5292` (`emitDbEndpoints`), called from `packages/mcp-server/src/index.ts:194`; 5 `service.test.ts` tests for this pass when run by name (`-t "emits one greptime note|with no endpoints set|a refused Dragonfly URL|no emitted event carries|a failed write does not reject"`, 5 pass, 0 fail) |
| 5 | Event row `db.endpoint` is registered with a sample and documented | ✓ VERIFIED | `packages/mcp-server/src/event-sources.ts:1147-1160`; `docs/event-vocabulary.md:160` |
| 6 | Policy knobs are documented, flag-registered and in `.env.example` | ✓ VERIFIED | `.env.example:247`; `docs/config-reference.md:142,213`; `docs/data-planes.md:134-141,228`; `bun run config:reference -- --check` → "config reference: up to date" (exit 0) |

**Score:** 6/6 truths verified in-repo (0 behavior-unverified). Roadmap criteria: 2/2 proven in-repo.

### Out of Scope (not a gap)

RBAC and connection pooling from the phase goal are excluded from the acceptance by D48-f in CONTEXT.md. Later-phase deferral was not checked (Step 9b not run).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/db-endpoints.ts` | Pure endpoint classifier | ✓ VERIFIED | Exists, substantive, imported by `config.ts:13` |
| `packages/mcp-server/src/config.ts` | Policy settings, enforce refusal, Dragonfly rule | ✓ VERIFIED | `dbEndpoints` on config (line 281, 1108, 1152) |
| `packages/mcp-server/src/service.ts` | `emitDbEndpoints()` | ✓ VERIFIED | Line 5268; wired from `index.ts:194` |
| `packages/mcp-server/src/event-sources.ts` | `db.endpoint` row | ✓ VERIFIED | Line 1147 |
| `docs/data-planes.md` | Endpoint policy section | ✓ VERIFIED | Lines 134-141 |
| `docs/config-reference.md` | Generated reference | ✓ VERIFIED | Lines 142, 213; check passes |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `config.ts` | `db-endpoints.ts` | import `classifyEndpoint`, `parseProxyAllow` | ✓ WIRED | `config.ts:13` |
| `index.ts` | `service.ts` | `substrate.emitDbEndpoints()` at listen | ✓ WIRED | `index.ts:194` |
| `service.ts` | ledger | `db.endpoint` event payload | ✓ WIRED (in-repo) | Live ledger write not run (see Human Verification) |
| `observe.ts` | `config.dbEndpoints` | proxy-plane metric | ✓ WIRED | `observe.ts:315` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `service.ts` `emitDbEndpoints` | `classes` | `config.dbEndpoints.classes` from env URLs | Yes (config-derived) | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Classifier, config, event-sources, flag-registry tests | `bun test src/db-endpoints.test.ts src/config.test.ts src/event-sources.test.ts src/flag-registry.test.ts` (in packages/mcp-server) | 287 pass, 0 fail, exit 0 | ✓ PASS |
| Boot emit tests | `bun test src/service.test.ts -t "<5 named db endpoint tests>"` | 5 pass, 0 fail, exit 0 | ✓ PASS |
| Config reference | `bun run config:reference -- --check` | up to date, exit 0 | ✓ PASS |

### Probe Execution

No probe scripts declared or found for this phase (`scripts/*/tests/probe-*.sh` absent). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| SOTA-04 | 48-PLAN.md | TailscaleDB Secure Unified Proxy Layer | ✓ SATISFIED in repo; live proof human_needed | REQUIREMENTS.md:85, 177 ("Complete in repo; live proof operator-gated") |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (none) | - | No TBD/FIXME/XXX markers in the phase's key source and doc files | - | None |

### Human Verification Required

### 1. Operator-gated forwarder cutover

**Test:** Set `SUBSTRATE_DB_PROXY_ALLOW` to the real forwarder host:port values, set `SUBSTRATE_DB_ENDPOINT_POLICY=enforce`, and boot substrate-mcp against the live Greptime, Postgres and Dragonfly forwarders.
**Expected:** Boot succeeds; each plane classifies as loopback or proxy; no plane is refused; queries reach the live stores.
**Why human:** Needs the tailnet forwarders, their ACL and live endpoints. Operator-gated; not contacted here.

### 2. Live ledger db.endpoint events

**Test:** After the live boot, read the ledger for `db.endpoint` events.
**Expected:** One note per configured plane, payload `{action, runtime, plane, class, policy}`, no URL, host or credential.
**Why human:** Needs a live ledger write; in-repo tests use a fake store.

### Gaps Summary

No in-repo gaps. Both roadmap success criteria are implemented and the targeted tests pass. Status is `human_needed` only because the live forwarder cutover and live ledger proof are operator-gated and were not run. Not run here: the full `bun test` suite, `bunx tsc --noEmit`, `bun run check:phase-close`, and any live Postgres/Greptime/Dragonfly check (Postgres at 127.0.0.1:5432 refuses TCP).

---

_Verified: 2026-11-12T08:39:06Z_
_Verifier: Claude (gsd-verifier)_
