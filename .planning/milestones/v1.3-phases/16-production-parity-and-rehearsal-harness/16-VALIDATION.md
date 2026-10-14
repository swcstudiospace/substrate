---
phase: "16"
slug: "production-parity-and-rehearsal-harness"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-08"
---

# Phase 16 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (Bun 1.4.0); typecheck `bunx tsc --noEmit` (tsconfig includes `packages/**/*.ts`, `scripts/**/*.ts`) |
| **Config file** | none (no `bunfig.toml`); `tsconfig.json` |
| **Quick run command** | `bun test packages/mcp-server/src/rehearsal-env.test.ts packages/mcp-server/src/store-lock.test.ts scripts/` |
| **Full suite command** | `bun test && bunx tsc --noEmit` (baseline at `ab62c91`: 1129 pass / 56 skip / 0 fail; tsc clean) |
| **Unit lint** | `systemd-analyze verify infra/vps/substrate-mcp.service` |
| **Estimated runtime** | quick ~10 s; full ~120 s |

---

## Sampling Rate

- **After every task commit:** Run the quick run command
- **After every plan wave:** Run `bun test && bunx tsc --noEmit`
- **Before `/gsd:verify-work`:** Full suite green, `systemd-analyze verify` exit 0, isolated harness proof recorded, approved `parity:check` run recorded
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

Requirement-level map from `16-RESEARCH.md` § Validation Architecture; task IDs are bound by the PLAN files. Statuses audited 2026-10-08 by validate-phase (state A) against plans 16-01..16-05 and their SUMMARYs.

| Requirement | Behavior | Threat Ref | Test Type | Automated Command | File Exists | Status |
|-------------|----------|------------|-----------|-------------------|-------------|--------|
| FOUND-01 | Server env built from an allowlist only; inherited store/token/API-key/`OTEL_*` vars absent | T-16 env leak | unit | `bun test packages/mcp-server/src/rehearsal-env.test.ts` (`allowlist`: sentinel leak + exact key set) | ✅ | ✅ green |
| FOUND-01 | Built env round-trips through `loadConfig`: loopback stores, one token per surface, operator ⊆ tokens, audit path in run dir; `--anonymous` gives anonymous config | T-16 env leak | unit | `bun test packages/mcp-server/src/rehearsal-env.test.ts` (`buildRehearsalEnv round-trip`) | ✅ | ✅ green |
| FOUND-01 | Loopback assertion refuses non-loopback hosts and foreign ports | T-16 prod write | unit | `bun test packages/mcp-server/src/rehearsal-env.test.ts` (`refusals`; round-trip pins store URLs to exactly the given scratch ports). `assertLoopback` checks hosts only: store ports come solely from the harness's own `docker port`, and production ports are refused at the CLI (`refusePort`, `refuseSmokeUrl` in `scripts/rehearsal.test.ts`) | ✅ | ✅ green |
| FOUND-01 | Port refusal (7410/7411/6420, in-use), `--name`/`--surfaces`/`--operator` validation, `down` pid-ownership refusal, smoke URL guard, spawn argv has `--no-env-file` and no secret | T-16 wrong-kill, prod write | unit | `bun test scripts/rehearsal.test.ts` (validate-phase added exact no-value spawn argv and a docker `-e` by-name source scan) | ✅ | ✅ green |
| FOUND-01 | Store lock stays green | T-16 secrets in repo | unit (existing) | `bun test packages/mcp-server/src/store-lock.test.ts` | ✅ | ✅ green |
| FOUND-01 | Live isolated harness: up → smoke (brief, emit, register+claim) → loopback-only peers → down → no labelled container, run dir gone | T-16 prod write | live-isolated (Docker) | `bun run rehearsal up && bun run rehearsal smoke && bun run rehearsal down` | ✅ proof recorded (`0f947e1`, run tag `rh-p16-proof-mv00v314`, `docs/runbooks/production-parity.md`) | ✅ green |
| FOUND-03 | Parsers (`systemctl show`, `ss -ltnp`, cgroup, `/proc` start time, reflog) and parity verdict | — | unit | `bun test scripts/parity-check.test.ts` (validate-phase added cwd ≠ WorkingDirectory, unanswered healthz, unaskable origin sha, shared/unknown MainPID, unknown epochs, matching baseline, full failure list, `*:PORT` wildcard) | ✅ | ✅ green |
| FOUND-03 | Unit file lints with the `ConditionPathExists` guard | — | lint | `systemd-analyze verify infra/vps/substrate-mcp.service` (exit 0, re-run 2026-10-08) | ✅ | ✅ green |
| FOUND-03 | Live read-only check reproduces criterion 3 | — | live, operator-approved | `bun run parity:check` | ✅ proof recorded (`4c22138`: exit 0 PASS, MainPID 1525582 owns :7410, healthz 200) | ✅ green (manual-only, see below) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `packages/mcp-server/src/rehearsal-env.test.ts` — FOUND-01 env allowlist, round-trip, loopback (computed Greptime keys only)
- [x] `scripts/rehearsal.test.ts` — FOUND-01 guards (must not contain `GREPTIME_`)
- [x] `scripts/parity-check.test.ts` — FOUND-03 parsers and verdict (fixtures from research §8, no secrets)

No framework install needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Production `/healthz` answers 200 from `main` | FOUND-03 | Touches production; operator-approved read-only probe | Run `bun run parity:check` in the approved proof step; record output in `docs/runbooks/production-parity.md`. Recorded 2026-10-08 (`4c22138`): exit 0 PASS, healthz 200 |
| `rh-` tagged rows in production Greptime and Postgres = 0 | FOUND-01 | Needs production credentials agents may not read | Operator runs the two read-only `count(*)` statements from the runbook and reports both numbers. Recorded 2026-10-08 (`c51637c`): both 0 |
| Operator window confirmation (stray pid 3149064 retired ~17:14 UTC 2026-10-08) | FOUND-03 | Operator action, already confirmed in 16-CONTEXT.md "Operator answers" | Record actor and time in the runbook. Recorded in `docs/runbooks/production-parity.md` header (`fd4a075`) |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (16-05 tasks 2–3 are production probes, MISSING by design and listed under Manual-Only)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-10-08 (validate-phase, non-interactive run: gap gate took the recommended "Fix all gaps" option)

## Validation Audit 2026-10-08

| Metric | Count |
|---|---|
| Gaps found | 2 |
| Resolved | 2 |
| Escalated | 0 |
