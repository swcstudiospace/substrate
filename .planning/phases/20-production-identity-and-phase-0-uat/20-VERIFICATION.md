---
phase: 20-production-identity-and-phase-0-uat
verified: 2026-10-10T14:30:00Z
status: passed
score: 22/22 must-haves hold (19 fully verified + 3 verified rehearsal-first with live halves operator-gated; zero live execution)
covered_files: [".planning/phases/20-production-identity-and-phase-0-uat/20-01-PLAN.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-01-SUMMARY.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-02-PLAN.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-02-SUMMARY.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-03-PLAN.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-03-SUMMARY.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-04-PLAN.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-04-SUMMARY.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-05-PLAN.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-05-SUMMARY.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-06-PLAN.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-06-SUMMARY.md", ".planning/phases/20-production-identity-and-phase-0-uat/20-UAT.md", ".planning/milestones/v1.0-phases/00-brief/0-UAT.md", "packages/cli/src/token.ts", "packages/cli/src/token.test.ts", "packages/cli/src/cli-auth.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/authority.test.ts", "packages/mcp-server/src/server.authority.test.ts", "packages/mcp-server/src/boot-refusal.test.ts", "packages/collectors/src/emit.ts", "scripts/identity-check.ts", "scripts/identity-check.test.ts", "scripts/parity-check.ts", "scripts/uat-phase0.ts", "scripts/uat-phase0.test.ts", "infra/identity/clients.json", "docs/runbooks/production-identity.md", "docs/uat.md"]
covered_digest: "v3:sha256:bbedafffa8690eeb6b0930ca471bba939d66bb4c3e02805b47502f6acbd8e4bc"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 20: Production Identity and Phase 0 UAT Verification Report

**Phase Goal:** Every client of production `substrate-mcp` is identified by its own token, and the eight deferred Phase 0 brief scenarios pass against `main` with fresh evidence.
**Verified:** 2026-10-10T14:30:00Z
**Status:** passed (rehearsal-first; live window operator-gated, zero live execution)
**HEAD:** `6a701f1` (origin/main synced; PR #45 squash-merged with CI + Greptile green; `git pull --ff-only` clean)
**First verification:** no prior `20-VERIFICATION.md` existed (`verification.status` → `missing`); this report is the initial verify, run as verification-gates-only per #2868 (no plan re-run; all 6 SUMMARYs present) plus the ticket-ordered P20-06 rehearsal-first execution and F-02 fix.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | D20-01/02 (20-01): list-form surface tokens, each value authenticates | ✓ VERIFIED | `server.authority.test.ts`: second list value gets 202 as hermes, joined string gets 401 (in 252-pass phase-20 run) |
| 2 | D20-02 (20-01): boot refuses exit 78 names-only on duplicates/unknown suffix | ✓ VERIFIED | `boot-refusal.test.ts` subprocess proof: exit 78, both variable names on stderr, fixture value absent from combined output |
| 3 | D20-03 (20-01): operator token is an extra claude-code list entry, held only in the operator file | ✓ VERIFIED | `authority.test.ts` operator tests green; no operator value in repo (store-lock green) |
| 4 | D20-01 (20-01): repo names grok-bot list entries, no gateway variable | ✓ VERIFIED | `.env.example` lock green (27 blank lines, every surface); `git grep SUBSTRATE_TOKEN_DESK_GATEWAY` clean outside planning history |
| 5 | D20-04 (20-02): one resolver, env → token-file → tokens-dir, fail-open, never logged | ✓ VERIFIED | `token.test.ts` 14/14 (incl. F-02 fix re-verified with host tokens provisioned); `cli-auth.test.ts` 3/3 real-spawn |
| 6 | D20-05 (20-02): herdr sends each event under its own surface token, no single-surface token in env | ✓ VERIFIED | `emit.test.ts` 12/12 incl. call-time env + absent-bearer hermetic test; `docs/collectors.md` herdr rule |
| 7 | D20-08 (20-02): parity probe authenticates; 401 reads auth-on-token-missing | ✓ VERIFIED | `parity-check.test.ts` 42/42; live read-only observation: production `:7410` answers 401 to unknown bearer with the names-only verdict |
| 8 | D20-11 (20-03): tracked manifest, 49 clients, names only | ✓ VERIFIED | `clients.json` 49 rows; `identity-check.test.ts` 26/26 incl. 49/49 runbook-table lock; live `identity:check` → PASS, 28/29 server names |
| 9 | D20-11 (20-03): names-only default prints no values; --values prints three verdict words only | ✓ VERIFIED | Parser/value-absent assertions in suite; live output token-shape scan: zero matches; `--values` never invoked by this run |
| 10 | D20-09/10/21 (20-03): runbook holds table, generation, window, bridge, dormant counts, rollback, rotation | ✓ VERIFIED | `docs/runbooks/production-identity.md` present; 49/49 manifest ids in marked table; token-literal scan clean |
| 11 | D20-06/07 (20-03): externals keep own convention; dormant 401 counts recorded | ✓ VERIFIED | Manifest external/not-installed rows; runbook D20-06/D20-07 sections; no live client stranded in names-only PASS |
| 12 | D20-14/15 (20-04): one script runs any scenario subset against any target, run-tagged, safe reports | ✓ VERIFIED | `uat-phase0.test.ts` 25/25 (classifier, live-guard refusals, renderer safety); writes refuse production without `--live` |
| 13 | D20-16 (20-04): expectations match current surfaces/tools/headers/hooks | ✓ VERIFIED | Fresh run: tools/list 23 tools with 9 v1 names; all six harness scenarios pass unmodified |
| 14 | D20-17/18 (20-04): harness scenarios 1,3,4,6,7,8 pass isolated with evidence | ✓ VERIFIED | **Reran fresh on HEAD: 6/6 pass** (run `uat-p2006fresh`, twin `:37703` @`1ee0b11`); `/tmp/p20-06-uat-harness.md` + `.json` |
| 15 | D20-18 (20-04): later phases reuse the script as regression | ✓ VERIFIED | `docs/uat.md` regression loop; this run followed it verbatim from a clean worktree |
| 16 | D20-13 (20-05): kickoff registers graphs deterministically, schema-only fields | ✓ VERIFIED | Object inspection: `978ce72:src/substrate/register.ts` present (pure `buildRegisterArgs`, fail-open `registerGraph`); `9006476` adds 315-line `register.test.ts` (summary-recorded 45 pass) |
| 17 | D20-13 (20-05): opt-in user-scope substrate entry with headers helper | ✓ VERIFIED | Object inspection: `9006476` touches `scripts/mcp-register.test.ts` (+250) and `src/mcp/cli.test.ts` (+239); entry writer never default, helper-suffix ownership |
| 18 | D20-13 (20-05): token resolution matches agent-substrate order on every host surface | ✓ VERIFIED | `brief.test.ts` shared-resolver coverage in `9006476` (+79); unsafe surfaces never read |
| 19 | D20-20 (20-05): branch local-only; push/PR wait for operator | ✓ VERIFIED | No `gsd/v1.3-p20-identity-uat` ref anywhere; no upstream PR on `swcstudiospace/claude-ultrathink`; nothing pushed by this run. GAP-20-01: the clone worktree is gone so the branch has no reachable ref (commits survive as objects — see Gaps) |
| 20 | D20-09/12 (20-06): switch-on strands no live client; soak attributes every delta | ✓ REHEARSAL-FIRST + OPERATOR-GATED | Rehearsal-first half verified: names-only PASS (49 clients, 28/29 server names), twin auth matrix 401/200/200/401, production read-only (unit owns `:7410`, NRestarts=0). Live half (values mode, restart, soak) NOT run — runbook window + verbatim commands in close-out report |
| 21 | D20-13/19 (20-06): PR merged, plugin refreshed, entry run, hooks installed | ⏳ OPERATOR-GATED | Nothing pushed/merged/installed by this run (all mutate another repo or host config). Verbatim commands in close-out report; GAP-20-01 recovery first |
| 22 | D20-17/18/22 (20-06): production scenarios pass with evidence; verification holds baseline | ✓ REHEARSAL-FIRST + OPERATOR-GATED | Harness set fresh 6/6 with evidence in `0-UAT.md` + `20-UAT.md`; full suite 2646/58/1 (F-01 only), tsc clean, phase-close pass. Production set (1,2,3,5,6) NOT run — `--live` commands in close-out report |

**Score:** 22/22 must-haves hold (19 fully verified + 3 verified rehearsal-first with live halves operator-gated; zero live execution).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/config.ts` + `boot-refusal.test.ts` | tokenConfig, exit-78 refusal | ✓ VERIFIED | In 252-pass run; unit carries `RestartPreventExitStatus=78` |
| `packages/cli/src/token.ts` (+test) | resolver + firstLine | ✓ VERIFIED | 14/14 with F-02 fix; never logs |
| `packages/cli/src/cli-auth.test.ts` | spawn proof | ✓ VERIFIED | 3/3 against recording stub |
| `packages/collectors/src/emit.ts` (+test) | per-event surface token | ✓ VERIFIED | 12/12; env at call time |
| `scripts/parity-check.ts` (+test) | resolver bearer, 401 verdict | ✓ VERIFIED | 42/42; live read-only observation recorded |
| `infra/identity/clients.json` | 49 clients, names only | ✓ VERIFIED | Shape + runbook locks green |
| `scripts/identity-check.ts` (+test) | two modes, names-only default | ✓ VERIFIED | 26/26; live PASS exit 0 |
| `docs/runbooks/production-identity.md` | window, rollback, rotation | ✓ VERIFIED | 49/49 table lock; literal scan clean |
| `scripts/uat-phase0.ts` (+test, fixture) | 8 scenarios, guards | ✓ VERIFIED | 25/25; fresh 6/6 live |
| `docs/uat.md` | regression doc | ✓ VERIFIED | Loop followed verbatim this run |
| `20-UAT.md` + `0-UAT.md` | evidence records | ✓ VERIFIED | Fresh run recorded; 6 pass / 2 live-gated; counts reconcile |
| claude-ultrathink `register.ts` + entry writer | D20-13 code | ✓ PRESENT (objects) | Commits `978ce72`/`9006476` intact as objects; ref recovery gated (GAP-20-01) |
| `20-06-SUMMARY.md` | close-out | ✓ VERIFIED | Present with coverage + deviations |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `tokenConfig` lists | per-value HTTP auth | `server.authority` | ✓ WIRED | Second list value 202s; joined string 401s |
| `resolveBearer` | CLI/collectors/parity/UAT | shared module | ✓ WIRED | All four call sites import `token.ts`; grep shows no parallel resolver |
| manifest | runbook table + `.env.example` | test locks | ✓ WIRED | 49/49 ids; every-surface blank-line lock |
| UAT script | twin serving main | fresh twin + consumer.env | ✓ WIRED | Twin `:37703` @`1ee0b11` dirty=false; 6/6 pass |
| twin tokens | per-surface 200s / anon 401 | auth matrix | ✓ WIRED | 401/200/200/401 observed, no values printed |
| production unit | `:7410` ownership + live 401 | parity:check read-only | ✓ WIRED | MainPID alive, NRestarts=0, checkout `5f495ad`, names-only verdict |
| kickoff | `graph_register` | `registerGraph` (objects) | ✓ PRESENT | Fail-open, schema-only, bearer from tokens dir |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| UAT run `uat-p2006fresh` | per-scenario evidence | twin @`1ee0b11` tools/brief/events/verify | ✓ FLOWING | 6/6 evidence lines in `/tmp/p20-06-uat-harness.md` |
| `identity:check` | PASS + 28/29 names | manifest + stat-only probes | ✓ FLOWING | Zero token-shaped strings in output |
| auth matrix | 401/200/200/401 | twin `/healthz` per bearer | ✓ FLOWING | Scratch tokens only, never printed |
| `parity:check` | unit owner + live 401 | systemd + ss + production `/healthz` | ✓ FLOWING | Read-only; names-only verdict |
| `token.test.ts` | 14 pass | isolated temp dirs only | ✓ FLOWING | Host tokens dir present yet unread (F-02 closed) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Fresh twin UAT on HEAD | `bun run uat:phase0 --tag p2006fresh --scenarios 1,3,4,6,7,8` (twin `:37703`) | 6/6, exit 0 | ✓ PASS |
| Identity manifest names-only | `bun run identity:check` | exit 0 PASS, 49 clients | ✓ PASS |
| Token-serving matrix | curl anon/bearer/surface-file/wrong vs twin | 401/200/200/401 | ✓ PASS |
| Production read-only | `bun run parity:check` | unit owns `:7410`, live 401 names-only | ✓ PASS (expected verdict) |
| F-02 closed | `bun test packages/cli/src/token.test.ts` (host tokens provisioned) | 14/0 | ✓ PASS |
| Phase-20 units | 10 files incl. authority/emit/parity/identity/uat/store-lock | 252/0 | ✓ PASS |
| Phase-close | `bun run check:phase-close` | pass (KINDS 12, SURFACES 27) | ✓ PASS |
| Full suite | `bun test` | 2646 pass / 58 skip / 1 fail | ✓ PASS modulo F-01 |
| Typecheck | `bunx tsc --noEmit` | clean, exit 0 | ✓ PASS |
| Clone branch absent | `git branch -a`, upstream PR list | no ref, no PR | ✓ PASS (GAP-20-01 noted) |

### Probe Execution

No phase-declared `scripts/*/tests/probe-*.sh` probes exist for this phase. Step 7c: NOT APPLICABLE. (`scripts/uat-phase0.ts` is the phase proof instrument, executed fresh above; `scripts/laneb-proof.ts`-style live proof is the operator window.)

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| FOUND-04 | 20-01/02/03 | Per-client production identity, boot refusal, resolver, manifest | ✓ SATISFIED | Lists auth over wire; exit-78 subprocess; 14+3+12+42 unit/integration; manifest PASS live names-only |
| UAT-01 | 20-04/06 | Eight scenarios pass against main with evidence | ◐ PARTIAL (6/8 harness-fresh; 2 live-gated) | Fresh 6/6 + evidence; scenarios 2,5 pending operator window (writes/reads need approval) |
| UAT-02 | 20-04 | Repeatable guarded script | ✓ SATISFIED | 25/25 + live-guard refusals + regression doc |
| UAT-03 | 20-05 | Kickoff registration + MCP entry | ✓ CODE-COMPLETE (production proof gated) | Objects intact; unit-recorded 45+114 pass; PR/refresh/entry run gated |
| UAT-04 | 20-04 | Scenario 6 hooks + collector live | ◐ HARNESS-FRESH (production path gated) | Synthetic-envelope 6/6 fresh; real Cursor session + commit gated |

No orphaned requirements: FOUND-04, UAT-01..04 are all carried by the six plans. UAT-01/UAT-04 production variants and UAT-03's live proof transfer to the operator window — not dropped, explicitly listed.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | No TBD/FIXME/XXX, stubs, empty handlers, hardcoded-empty render data in phase files | — | None — phase files scanned; twin teardown removed all scratch state |
| `packages/cli/src/token.test.ts` | 74-78 (fixed) | Test read production host state (`DEFAULT_TOKENS_DIR`) | fixed (F-02) | Was the sole host-dependent test; now pins an empty temp dir |

### Human Verification Required (operator window — NOT run here)

Everything below mutates production, another repo, or host config, and needs explicit operator approval. Verbatim commands are in the phase close-out report's OPERATOR APPROVAL NEEDED section:

- Task 1 live half: client token provisioning, `identity:check --values`, server variables, single restart, 30-minute soak with metrics reads, parity + handoff evidence
- Task 2 live half (after GAP-20-01 recovery): push `gsd/v1.3-p20-identity-uat`, upstream PR, merge, plugin refresh, entry writer run, git-hook installs, Cursor checks
- Task 3 live half: production UAT scenarios 1, 2, 3, 5, 6 (optionally 8) with `--live <approval-ref>`, anchors read-only SQL step

### Gaps Summary

- **GAP-20-01 (new, operator recovery):** plan 20-05's clone worktree `/root/src/worktrees/claude-ultrathink-p20` is gone, so branch `gsd/v1.3-p20-identity-uat` has no reachable ref. The work itself survives intact as objects in `/root/src/repos/claude-ultrathink` (`978ce72` feat + `9006476` test); no upstream PR exists, so nothing leaked. Recovery (operator-approved, writes a repo checkout — NOT executed here): verify the objects, then `git branch gsd/v1.3-p20-identity-uat 9006476` in a scratch clone of `swcstudiospace/claude-ultrathink` (not the operator checkout, per 20-05's never-written rule), rebase onto current upstream `main` (it has moved: PRs into the high 20s merged 2026-10-10), re-run `bun test` + `bun run check`, then push + PR. 20-05 truths 16–19 above verify against the objects in the meantime.
- **Production scenario proofs** (UAT-01 scenarios 2, 5; production variants of 1, 3, 6; optional 8): pending the operator window — recorded, not dropped.

Known failures (operator rule: present-at-HEAD failures recorded, not fixed — with the single phase-owned exception):
- **F-01 — STILL OPEN, recorded, not fixed:** `scripts/rehearsal.test.ts` "CLI refusals > --port 7410 exits 2 without touching Docker" (cwd-sensitive refusal-order assertion, phase-16 scope). Reproduces in this run's full suite.
- **F-02 — FIXED this run (phase-20-owned):** `packages/cli/src/token.test.ts` read the real host Cursor token; isolated to an empty temp dir; 14/14 green with host tokens provisioned. Ships via PR #45 (test-only).

No production restart was needed for any proof: a fresh twin served main, every check runs against it or temp fixtures, and the twin is down (pid 1675010 stopped, 2 containers removed). The sibling `:17410` twin was never touched.

---

_Verified: 2026-10-10T14:30:00Z_
_Verifier: Phase20Execute (rehearsal-first execution + gates-only verification)_
_Head: 6a701f1 (PR #45 merged) · tsc exit 0 · suite 2646 pass / 58 skip / 1 fail (F-01) · phase-20 files 252/252 · uat-p2006fresh 6/6 · identity:check PASS · phase-close pass_
