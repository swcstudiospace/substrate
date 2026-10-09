---
phase: "20"
slug: "production-identity-and-phase-0-uat"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-08"
---

# Phase 20 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (Bun 1.4.0), tests beside sources as `*.test.ts`; typecheck with `bunx tsc --noEmit`. claude-ultrathink: `bun test` and `bun run check` |
| **Config file** | none (`package.json` `"test": "bun test"`); `tsconfig.json` includes `packages/**/*.ts` and `scripts/**/*.ts` |
| **Quick run command** | `bun test <touched file>.test.ts` (one file per command), plus `bun test packages/mcp-server/src/store-lock.test.ts` after any task that writes docs, `.env.example` or unit files |
| **Full suite command** | `bun test && bunx tsc --noEmit` (baseline at `ab62c91`: 1129 pass / 56 skip / 0 fail, plus Phases 16-19 additions); claude-ultrathink `bun test && bun run check` |
| **Phase gates** | `bun run check:phase-close` (Phase 17), `redact-lock.test.ts`, `store-lock.test.ts`, `bun run identity:check` (names-only), harness `bun run uat:phase0 --scenarios 1,3,4,6,7,8` |
| **Estimated runtime** | quick about 2 s per file; full about 120 s; harness UAT about 120 s |

---

## Sampling Rate

- **After every task commit:** the touched file's single-file `bun test`, `bunx tsc --noEmit`, and `store-lock.test.ts` for doc tasks
- **After every plan wave:** full `bun test && bunx tsc --noEmit`; claude-ultrathink `bun test && bun run check`
- **Before `/gsd:verify-work`:** full suites green against the baseline, phase gates green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

Plan and task ids are filled in by the planner; the rows below are the requirement-to-test contract from `20-RESEARCH.md` "Validation Architecture".

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| FOUND-04 | List form resolves each entry; duplicate value across surfaces and unknown suffix raise `ConfigError` naming variables only; single value unchanged; operator entry in a list is an operator | unit | `bun test packages/mcp-server/src/authority.test.ts` | ✅ extend | ⬜ pending |
| FOUND-04 | A second list entry authenticates over HTTP; an unknown bearer gets 401 | integration (in-process) | `bun test packages/mcp-server/src/server.authority.test.ts` | ✅ extend | ⬜ pending |
| FOUND-04 | Spawned boot with a duplicate or unknown-suffix env exits 78, names the variables, prints no value | integration (subprocess) | `bun test packages/mcp-server/src/boot-refusal.test.ts` | ❌ W0 | ⬜ pending |
| FOUND-04 | `resolveBearer` order (env, token file, tokens dir), surface validation, 4 KiB cap, fail-open on missing/EISDIR, never logs | unit | `bun test packages/cli/src/token.test.ts` | ❌ W0 | ⬜ pending |
| FOUND-04 | CLI sends the tokens-dir bearer for `--surface cursor`; env wins; no header when absent | integration (spawn CLI against `Bun.serve` stub) | `bun test packages/cli/src/cli-auth.test.ts` | ❌ W0 | ⬜ pending |
| FOUND-04 | `postEvent` default token is the event surface's file (herdr per-event tokens) | unit | `bun test packages/collectors/src/emit.test.ts` | ✅ after Phase 19 (extend) | ⬜ pending |
| FOUND-04 | `parity-check` sends the resolver's bearer; 401 reads "auth on, token missing" | unit | `bun test scripts/parity-check.test.ts` | ✅ after Phase 16 (extend) | ⬜ pending |
| FOUND-04 | Names-only parser never retains or prints values, skips continuation lines, prints only expected and unexpected `SUBSTRATE_TOKEN_*` names; `--values` prints only match/missing/mismatch; manifest ↔ runbook ↔ `.env.example` lock; herdr env with `SUBSTRATE_TOKEN` flagged | unit | `bun test scripts/identity-check.test.ts` | ❌ W0 | ⬜ pending |
| FOUND-04 | No tracked token literal, including every new doc and the manifest | lock | `bun test packages/mcp-server/src/store-lock.test.ts` | ✅ | ⬜ pending |
| FOUND-04 | `RestartPreventExitStatus=78` present; unit syntax valid | static | `systemd-analyze verify infra/vps/substrate-mcp.service` | ✅ extend | ⬜ pending |
| UAT-02 | Target classification (`PRODUCTION_PORTS`, loopback), `--live` guards, run tags, report rendering (no token, no brief body), scenario expectation functions | unit | `bun test scripts/uat-phase0.test.ts` | ❌ W0 | ⬜ pending |
| UAT-01, UAT-04 | Scenarios 1, 3, 4, 6, 7, 8 pass on the Phase 16 harness | live-isolated | `bun run rehearsal up --name p20`, then with `consumer.env` sourced `bun run uat:phase0 --scenarios 1,3,4,6,7,8 --report <path>`, then `bun run rehearsal down --name p20` | ❌ proof step | ⬜ pending |
| UAT-03 | `buildRegisterArgs` mapping, `prime-agent` omission, opt-in skip, SSE parse, 401/503/timeout → failed without throw, bearer from tokens dir; `substrate register`/`headers` CLI; `track complete` calls register once | unit (claude-ultrathink) | `bun test src/substrate/register.test.ts src/mcp/cli.test.ts` | ❌ W0 / ✅ extend | ⬜ pending |
| UAT-03 | `fetchBrief`/`emitEvent` tokens-dir bearer per surface; env wins; unsafe surface never read | unit (claude-ultrathink) | `bun test src/substrate/brief.test.ts` | ✅ extend | ⬜ pending |
| UAT-03 | `mcp-register.ts --substrate` plans `claude mcp add-json --scope user substrate …` with the header template and helper path; `--remove` only ours; refuses without a substrate URL | unit (claude-ultrathink, fake `Run`) | `bun test scripts/mcp-register.test.ts` | ✅ extend | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `20-CONTEXT.md` spelling fixed (A0); `store-lock.test.ts` green on the branch
- [ ] `packages/mcp-server/src/boot-refusal.test.ts`
- [ ] `packages/cli/src/token.test.ts`, `packages/cli/src/cli-auth.test.ts`
- [ ] `scripts/identity-check.test.ts`
- [ ] `scripts/uat-phase0.test.ts`
- [ ] claude-ultrathink `src/substrate/register.test.ts`
- Framework install: none needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Client token files written, `identity:check --values` passes, server variables added, one restart, `/metrics` shows no stranded live client over a 30-minute soak, `auditDurable: true`, signed handoff verified | FOUND-04 | Live production; operator-approved window; agents never read or write values | `docs/runbooks/production-identity.md` |
| claude-ultrathink PR pushed, merged, plugin refreshed; `mcp-register.ts --substrate` run; one real kickoff registers its graph | UAT-03 | Other repo's PR, Claude Code user config, real Linear and Notion rows | Runbook live step 6; then `bun run uat:phase0 --scenarios 5 --live <ref> --graph <gid>` |
| Git post-commit installed in the listed repos; a real Cursor session and commit emit | UAT-04 | Writes into operator repos' `.git/hooks`; live Cursor | Runbook live step 7; then `bun run uat:phase0 --scenarios 6 --live <ref>` |
| Production UAT of scenarios 1, 2, 3, 5, 6 (optionally 8); anchors shape and raw counts by read-only SQL | UAT-01 | Production reads and permanent writes need approval | Runbook live step 8; results recorded in `0-UAT.md` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
