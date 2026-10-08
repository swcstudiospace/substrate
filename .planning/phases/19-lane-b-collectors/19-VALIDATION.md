---
phase: "19"
slug: "lane-b-collectors"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-08"
---

# Phase 19 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (Bun 1.4.0), tests beside sources as `*.test.ts`; typecheck with `bunx tsc --noEmit` |
| **Config file** | none (`package.json` `"test": "bun test"`); `tsconfig.json` |
| **Quick run command** | `bun test ./packages/collectors/src/<file>.test.ts` (one file per command) |
| **Full suite command** | `bun test && bunx tsc --noEmit` (baseline at `ab62c91`: 1129 pass / 56 skip / 0 fail, plus Phases 16-18 additions) |
| **Phase gates** | `bun run check:phase-close` (Phase 17), `bun test ./packages/mcp-server/src/redact-lock.test.ts`, `bun test ./packages/mcp-server/src/store-lock.test.ts`, `bun run proof:laneb` |
| **Estimated runtime** | quick about 2 s per file; full about 120 s; proof about 90 s |

---

## Sampling Rate

- **After every task commit:** the touched file's single-file `bun test` plus `bunx tsc --noEmit`
- **After every plan wave:** full `bun test`, `redact-lock.test.ts`, `store-lock.test.ts`, `bun run check:phase-close`
- **Before `/gsd:verify-work`:** full suite green against the baseline and `bun run proof:laneb` green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

Plan and task ids are filled in by the planner; the rows below are the requirement-to-test contract from `19-RESEARCH.md` "Validation Architecture".

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| LANEB-05 | `postEvent` maps 202→stored, 4xx→refused, 5xx/network/timeout→failed; never throws; bearer only when token set | unit | `bun test ./packages/collectors/src/emit.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-05 | Refused line holds only `ts,collector,source,kind,surface,status,error`; error redacted and truncated | unit | `bun test ./packages/collectors/src/emit.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-02 | `repoSlug` (https/ssh/`.git`/no origin) and `branchFor` | unit | `bun test ./packages/collectors/src/git-context.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-02 | Every transition conforms to its `EVENT_SOURCES` row and survives `normalizeEvent`; enum fixture fully classified; `muse` row; wire-name normaliser (both spellings, `released`) | unit | `bun test ./packages/collectors/src/herdr-map.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-01 | Reconcile: start/note/end, `unknown` suppression, pane-id reuse, agent change, first-run seeding, restart emits nothing for unchanged panes | unit | `bun test ./packages/collectors/src/herdr-state.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-01 | Transport: one subscribe per connection; bad pane closes only its connection; debounce yields one start for two pushes | unit (fake ND-JSON socket) | `bun test ./packages/collectors/src/herdr.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-03 | Good fetch → redacted BRIEF (tmp+rename); failed fetch or `/healthz` greptime false → byte-identical; no `/events` call | unit | `bun test ./packages/collectors/src/muse.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-03 | Pointer idempotent ×6, duplicate blocks collapse, outside bytes identical; `.substrate/` excluded via `--git-path` (repo + worktree) | unit | `bun test ./packages/collectors/src/muse.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-04 | Bundle: `hooks/redact.ts` = header + exact source bytes; `hooks/substrate.json` has url/tokenFile/stateDir and no token value | unit | `bun test ./packages/projector/src/muse.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-04 | Generated hook against a stub server: `tool.call` from `muse` with slug and branch; dead URL → exit 0, empty stdout, < 2 s; 4xx → refused line | integration (spawn) | `bun test ./packages/projector/src/muse.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-04 | Template passes the redaction lock with no exemption | lock | `bun test ./packages/mcp-server/src/redact-lock.test.ts` | ✅ after Phase 18 | ⬜ pending |
| SKILL-06 | Ported cursor-stop guards + env path overrides + refused counting; nothing on stdout | unit | `bun test ./packages/collectors/src/cursor-stop.test.ts` | ❌ W0 | ⬜ pending |
| SKILL-06 | `--print-desired` `stop` entry equals the live string; `--check` on an equal fixture exits 0 | unit (spawn) | `bun test ./packages/projector/src/cursor.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-05 | `collectors:status` summarises counters and refused lines since `--since`; skips unparsable lines | unit | `bun test ./packages/collectors/src/status.test.ts` | ❌ W0 | ⬜ pending |
| LANEB-02 | `herdr.pane_exited` row carries repo | unit (Phase 17 table) | `bun test ./packages/mcp-server/src/event-sources.test.ts` | ✅ after Phase 17 | ⬜ pending |
| LANEB-01/03 | Units: names, ExecStart, WorkingDirectory and state paths unchanged; new EnvironmentFile/Environment lines; syntax valid | static | `systemd-analyze verify infra/vps/substrate-collector-herdr.service infra/vps/substrate-collector-muse.service` | ❌ W0 | ⬜ pending |
| LANEB-07 | End-to-end isolated proof (harness twin, named herdr session, scratch Muse HOME) | e2e | `bun run proof:laneb` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/collectors/src/{emit,git-context,herdr-map,herdr-state,herdr,muse,cursor-stop,status}.test.ts`
- [ ] `packages/projector/src/{muse,cursor}.test.ts`
- [ ] Fixtures: verbatim herdr probe lines (both spellings), the 17-id `IntegrationTarget` list, the Muse `hook test` fixture format
- [ ] `package.json` scripts `proof:laneb`, `collectors:status`
- Framework install: none needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Production units restarted onto `main`, plugin projected into user-scope Muse, Cursor hooks `--check` current | LANEB-01, LANEB-03, LANEB-04, SKILL-06 | Live system; operator-approved window after merge (D19-24) | Follow `docs/runbooks/lane-b-collectors.md`; read `bun run collectors:status` afterwards |
| A real Muse model turn emits `tool.call` | LANEB-04 | Spends model quota; optional, operator-approved | Headless Muse turn in a scratch repo with the scratch-HOME projection |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
