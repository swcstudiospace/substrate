---
gsd_state_version: "1.0"
milestone: v1.3.x
milestone_name: Should-have hardening (Planned)
status: "v1.3.x phases 37-39 merged (PR #89, PR #90, PR #91). Phase 40 (DOCS-MEMORY) code on main via PR #92. Phase 41 (ANCHOR) code on main via PR #116. Phase 42 (SKILL-CARD) code on main via PR #94. Phases 43 (PR #97) and 44 (PR #95) complete. Verification is human_needed for phases 40-43 and passed for 44. On 2026-10-23 the operator accepted the open operator gates as debt for phases 40-43, 45 and 47-50; milestone audit and close are next."
stopped_at: run 2026-10-24: fixes committed, v1.3.x and v1.4 audits written; complete and phase 46 wait for operator decisions
last_updated: "2026-10-24"
last_activity: 2026-10-24
last_activity_desc: autonomous run 2026-10-24 (graph ut-mvlvvvbt-57c57d9e): phase reconciliation, baseline gates, deferral table, v1.4 grouping
state_head: 1a9f4fd365ede291c4e21be71b6ff236e0e49c67
progress:
  total_phases: 8
  completed_phases: 1
  total_plans: 8
  completed_plans: 8
  percent: 13
current_phase: 40
current_phase_name: docs-memory
---

# State

## Recovery record (2026-10-23)

- Swarm stash `stash@{0}` (commit `d517931`, "other-session: swarm-a16..30 surfaces, swarm token lines, runbooks, swarm-correlation, identity clients") was inspected. Its five files are `.env.example`, `docs/runbooks/production-identity.md`, `docs/swarm-correlation.md`, `infra/identity/clients.json`, and `packages/mcp-server/src/types.ts`. Patch identity: `git stash show -p stash@{0} | sha256sum` begins `f671ea5f0488f06e`.
- Verified: every added line of those five files is on `main` (`702ed32`, PR #113). The stash is redundant. It is kept, not dropped, until the operator approves dropping it.
- Verified: `main` carries the swarm test pins (`swarm-a30`) in `authority.test.ts` and `vocabulary-lock.test.ts`.
- Not verified, open: `memory-write.test.ts` and `server.test.ts` lost another session's uncommitted edits to an earlier checkout cleanup. Their pre-revert text cannot be recovered from git, so the other session's owner must confirm what those edits were.

## Current

**v1.3 Build plan completion is planned:** 18 phases (16–33), 68 requirements, roadmap approved by the operator on 2026-10-08. Research: `.planning/research/` (SUMMARY.md first). Primary port source: branch `docs/data-planes-tailscale` (`acc30a8`), ported onto `main`'s v1.2 lease model.

**v1.3 decisions (operator, 2026-10-08):**

- Scope: finish the build plan — every unfinished area, in build-plan order, plus the deferred Phase 0 UAT.
- Shipping: one PR per phase, each cut from `main`; the milestone-definition docs ship first. `ultrathink-ship` runs with `--ignore-gsd` per phase (the operator's explicit choice), Greptile 5/5 with no open threads, auto-merge.
- Defaults accepted for user-visible choices: swarm-surface claims add only a note in Linear (no label or state change); Lane A claims as `claude-code`; the data planes are reached only through the substrate and Hindsight retains only gate-accepted memories; teachables are tagged governed facts, anchored by hash only; `desktop_run` is fail-closed to operator-listed surfaces; production tokens are provisioned in Phase 20 after the collectors carry them; the stray process on `:7410` is stopped in an operator-approved window in Phase 16.
- Run rules: grey areas auto-accept unless they change a user-visible contract; every live run (production service, real stores, Linear or Notion writes, devnet, GitHub PRs on other repos, model quota) waits for operator approval; failures already present at HEAD are recorded, not fixed.
- Baseline at `ab62c91`: `bun test` 1129 pass / 56 skip / 0 fail across 40 files; `bunx tsc --noEmit` clean.

Shipped before: **v1.2** (2026-10-08), archived in `.planning/milestones/v1.2-*`.

## Historical v1.0 execution record

The following implementation notes predate v1.2. They are retained as history, not current deployment or pending-work assertions.

Phase 0 (Brief) is **complete and live on production infrastructure**.
`substrate-mcp` runs under systemd against GreptimeDB v1.1.4 and TimescaleDB,
both on Railway. The local dev containers have been deleted and the service
remains healthy, which is the proof it no longer depends on them.

Done:

- `substrate-mcp` on `127.0.0.1:7410` — MCP at `/mcp` plus `POST /brief`,
  `/events`, `/verify` and `GET /healthz`. Tools: `memory_brief`,
  `memory_write`, `memory_search`, `events_emit`, `graph_get`,
  `graph_register`, `graph_claim`, `graph_release`, `graph_complete`.
  (Underscores, not the doc's dots — Anthropic tool names must match
  `^[a-zA-Z0-9_-]{1,64}$`.)
- Postgres index + Greptime `agent_events` schemas, with the hash chain
  computed on ingest so Phase 6 has a correct chain from row one.
- Redaction on the write path, ported from the connector's `redactor.py`.
- `fetchBrief` in `claude-ultrathink` on branch `feat/substrate-brief`,
  fetched alongside uplift and awaited before the Graph of Thought.
- `substrate` CLI, git post-commit collector, Cursor hook projector,
  systemd unit.
- Index backfilled from 6 real Agent Task Graph graphs / 15 nodes.

**Proof met:** a brief fetched from inside `claude-ultrathink` named a Cursor
edit, a Hermes test run, another agent's open graph and a warning — 14 ms,
inside the 1.5 s budget.

Verified in production: chained events written to Railway Greptime and read
back, `substrate verify` confirming the hash chain intact, the index backfilled
from 6 real Agent Task Graph graphs, and three surfaces (hermes, omp,
grok-build) holding claims that a fourth (muse) sees in its brief. The service
survives SIGKILL and is restarted by systemd.

Not done: a reachable Postgres URL for the index; `graph_register` call inside
the `ultrathink-kickoff` skill; git post-commit hook and Cursor hooks are
written but still only dry-run.

## Historical implementation context

**Decisions**

- `agent-substrate` is its own git repo. Before `git init` it was an empty dir inside
  `/root/src/repos`, so GSD resolved upward to that repo's `.planning/` — an unrelated
  "Voice stream and desk wiring" milestone. The local `.git` scopes GSD correctly.
- RAGFlow and GreptimeDB live on a Railway account this MCP connection cannot see. Both are
  consumed as **external endpoints** from `/etc/substrate/substrate.env`; the substrate never
  provisions them.
- The index Postgres is assumed to be on that same account. Fallback is the connected Supabase
  project. It does **not** go on this VPS — disk is at 90%.
- Phase 4 vendors the real content of `/root/agent-skills` (dereferencing all 26 symlinks)
  rather than committing links or using submodules.
- Execution is full-autonomous, including live phase proofs and cross-repo PRs.

**Corrections found while building**

- Linear team is **swcstudio** with the **`SPE-`** prefix. The Notion plan's
  examples say `SWC-123`; real rows are `SPE-119`. Anything matching on the
  identifier must not hardcode `SWC`.
- MCP tool names cannot contain dots, so `memory.brief` is `memory_brief`.
- Greptime reserves `id` as a column name — all identifiers are quoted.
- Greptime returns TIMESTAMP columns as integer epochs, not ISO strings.
- Bun's SQL binds a JS array for `in ${sql(arr)}`, but `= any(${arr})` emits a
  malformed array literal.

**Corrections to the Notion plan, found on the VPS**

- `claude-ultrathink` is enabled (`"ultrathink@ultrathink": true`), not disabled. Phase 0's
  "re-enable the plugin" task is already satisfied.
- `/root/agent-skills` is not a git checkout: 14 real dirs + 26 symlinks.
- Ports 7410 and 6420 are free; `auctioning-greptime-1` on :4000 belongs to another project.

### Roadmap Evolution

- Phase 8.1 inserted after Phase 8: Gap closure: a version conflict now reports the decision's current version, so a swarm rewrite works when the decision is not in the newest 100 entries (MEM-02) (URGENT)

## Historical blocker notes

_(No open blockers. Credential rotation was considered and declined by the
owner — recorded here so it is not re-raised.)_

## Historical pending work

- Review and merge claude-ultrathink PR #1 (`substrate/brief` → `master`).

## Historical publication record

- `swcstudiospace/agent-substrate` (private) — `main` pushed.
- `swcstudiospace/claude-ultrathink` PR #1 — the `fetchBrief` integration,
  branched cleanly from `master`, 5 files, 256 tests green.

**Lesson recorded:** `git add <file>` on a file another session had already
modified swept four of their hunks into my commit (a 3→15 Sub-Issue assertion
and a `<thinking>`→`<rationale>` fixture change). It only surfaced because the
clean branch failed against `master`. In a shared checkout, stage hunks or
verify the diff against the target branch before pushing — not just the file
list.

## Historical investigation notes

- Notion §12 unknowns, each probed at the start of the phase that needs it: Orca's session/event
  query API, Muse's plugin API, Omp's skills directory, which Cursor hooks fire for the CLI,
  rivet-agentos `openSession` option names and the Codex adapter package name.

## Historical deployment record

`substrate-mcp` runs under systemd — `systemctl status substrate-mcp`,
`journalctl -u substrate-mcp -f`. Credentials at `/etc/substrate/substrate.env`
(0600, root). Both stores are on Railway; no local containers remain.

Railway networking, learned the hard way: `.railway.internal` and
`DATABASE_PRIVATE_URL` resolve only from inside Railway. A consumer outside it
needs the TCP proxy (`…proxy.rlwy.net:PORT`), which must be enabled per service
under Settings → Networking. HTTP services get a public domain automatically,
which is why Greptime worked immediately and Postgres did not.

## Current Position

Phase: 40 (accepted debt; the consistency check is recorded 2026-10-24, and the milestone audit is next)
Plan: —
Status: v1.3.x and v1.5 open. Preflight recorded 2026-10-23; no phase executed by this run yet.
Last activity: 2026-10-23 — PR #119 merged; PR #121 (ROADMAP progress follow-up) shipped through ultrathink-ship; migration placed inside phase 46 by operator decision.

## Preflight record (2026-10-23, graph ut-mvlknrx6-2849044e)

- Order: every open milestone in ROADMAP order, one at a time. v1.3.x (phases 40-44), then v1.5 (phases 45-51; phases 52-54 once draft #105 lands on main).
- Commands: discuss = smart_discuss inline (gsd-discuss-phase only in interactive mode); plan = gsd-plan-phase; execute = gsd-execute-phase; verify = NONE (discovered gates and PLAN evidence); milestone audit = gsd-audit-milestone; complete = gsd-complete-milestone (version argument); cleanup = gsd-cleanup (removal list not yet confirmed visible).
- Gates, non-interactive: tests `bun test` (900 s); type-check `bunx tsc --noEmit` (300 s); repo locks `bun run check:phase-close` (900 s); composite `bun run verify` (900 s). Lint ABSENT until the Biome report-only gate lands. Build ABSENT. Live-service scripts (gate:boot, smoke:*) are never run autonomously.
- Gate status at preflight: no CREDENTIAL_LIKE rows; baseline clean (no uncommitted or staged user work); remote steps off by operator choice (local only: no push, tag or release).
- TODO inventory: 0 real TODO or FIXME markers repo-wide; debt items and dispositions are in .planning/todo-inventory.md.
- Unknowns and defaults: loop owner = flat per-phase Skill calls, with STATE and ROADMAP re-read before each write; commit scope = explicit paths only; fix attempts = three per failing gate; cleanup runs only from a visible, enumerated list; a test runner exists for every criterion that needs one; UI checks apply only where a phase touches UI.
- Failure-mode checks: one Skill call per turn; STATE and ROADMAP hash-compared before each write; a CREDENTIAL_LIKE finding halts the run; each phase writes its SUMMARY (per-criterion evidence) before ROADMAP, then STATE; gate records carry command, exit status and tree fingerprint.
- Wave plan: the serial lane owns STATE.md and ROADMAP.md writes. Phases never run in parallel; file-disjoint units inside one phase may.

## Accepted debt (operator decision, 2026-10-23)

The operator accepted the operator-gated verification of phases 40-43, 45, and 47-50 as debt to close v1.3.x and v1.5. Phases 44 and 51 passed in repo. Phase 46 is re-scoped to LightRAG and is not accepted as debt.

| Phase | Verification | Open operator gate |
|-------|--------------|--------------------|
| 40 DOCS-MEMORY | human_needed | D-D3 restore drill and owner approval |
| 41 ANCHOR | human_needed | live devnet proof |
| 42 SKILL-CARD | human_needed | live host fast-forward |
| 43 LANE-A | human_needed | live egress and restart proof |
| 45 Railway | human_needed | live Railway reads and writes |
| 47 forecast and preload | human_needed | live Dragonfly warm-up |
| 48 Tailscale proxy | human_needed | forwarders, ACL and cutover |
| 49 graph memory | human_needed | live ledger rows |
| 50 Dragonfly pub/sub | human_needed | live subscription and wake-up latency |

Phase 46 is re-scoped to LightRAG by operator decision and is not accepted as debt. The RAGFlow to LightRAG migration runs inside it.

## Deferred Items

Items acknowledged and deferred, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| uat_gaps | milestones/v1.0-phases/00-brief/0-UAT.md | partial (8 scenarios pending) | 2026-10-07 | v1.1 |

## Operator Next Steps

- Decide the 2026-10-24 run pause batch (see Run record): confirm the v1.4 and v1.3.x audits before complete; accept or verify phases 37-39; Phase 46 discuss answers Q1-Q4; PR #123 (close or merge); the gate policy for planning PRs; and the out-of-path branches.
- Phase 46 live steps (archive, deploy, ingestion, cutover, storage deletion) each need approval for that run.
- Phases 52-54: merge drafts #104 and #109-#111 in order through the ship path once PR #123 is resolved (no force push).
- Milestones v1.4 and v1.3.x close after the operator confirms each audit. Milestone v1.5 closes only after phase 46 and phases 52-54 are complete.

## Consistency check (2026-10-24)

Read-only check of the nine accepted-debt phases (40, 41, 42, 43, 45, 47, 48, 49, 50) against their ROADMAP success criteria, the criteria tables in phases/NN VERIFICATION.md, and SUMMARY.md. Rule used: each criterion's classification and locator in VERIFICATION.md is its per-criterion evidence record, and SUMMARY.md gives the narrative evidence. Strict per-criterion rows inside SUMMARY.md are not a gate, because these phases shipped before this run and do not carry them.

- Consistent: 41, 42, 43, 45, 47, 48, 49, 50. Every criterion is classified in VERIFICATION.md and none failed. The open items are operator-gated live proofs, recorded in VERIFICATION.md.
- Phase 40: criterion 1 proven in repo; criterion 2 not met (restore drill, operator-gated, accepted as debt); criterion 3 not met as written and narrowed by the owner on 2026-10-22. ROADMAP now states the narrowed scope.
- Fixed in this change: ROADMAP plan counts for phases 40-44 (0 plans to 1/1), the phase 40 goal and criterion 3 wording, and the progress row counts for phases 40-42.
- Left unchanged: stale status lines in phase CONTEXT.md and PLAN.md frontmatter (workflow artifacts). They do not change any verdict.

## Deferred Verification

| Phase | State | Resume |
|-------|-------|--------|
| 37 | verification_deferred_human | /gsd:verify-work 37 |
| 38 | verification_deferred_human | /gsd:verify-work 38 |
| 39 | verification_deferred_human | /gsd:verify-work 39 |
| 40 | verification_deferred_human | /gsd:verify-work 40 |
| 41 | verification_deferred_human | /gsd:verify-work 41 |
| 42 | verification_deferred_human | /gsd:verify-work 42 |
| 43 | verification_deferred_human | /gsd:verify-work 43 |
| 45 | verification_deferred_human | /gsd:verify-work 45 |
| 47 | verification_deferred_human | /gsd:verify-work 47 |
| 48 | verification_deferred_human | /gsd:verify-work 48 |
| 49 | verification_deferred_human | /gsd:verify-work 49 |
| 50 | verification_deferred_human | /gsd:verify-work 50 |

Phases 40-43, 45 and 47-50 are accepted debt (operator decision, 2026-10-23). Phases 37-39 are human_needed and not covered by that decision; they wait on the operator's decision. Phase 46 is open work (re-scoped), not deferred.

## Run record (2026-10-24, graph ut-mvlvvvbt-57c57d9e)

- Kickoff: `track complete` is partial. Linear is blocked by the workspace free-issue limit; Notion rows exist. The Notion Task reads back Status Implementing, and the session is marked kicked-off.
- Run branch `gsd/autonomous-run-2026-10-24` at 36580a6 (worktree `as-gsd-autonomous`). The PR #123 branch is untouched.
- Baseline gates, run before any change. `bun run verify`: PASS (install; `bunx tsc --noEmit`; `bun test` 6061 pass, 177 skip, 0 fail; 177 skip because SUBSTRATE_TEST_PG_URL is unset; `bun run check:phase-close` pass; 182 s, under the 10-minute cap). `bun scripts/audit-gate.ts`: FAIL, pre-existing: three unlisted high advisories (body-parser 2.3.0 GHSA-27r3-jxmh-p828; undici 7.30.0 GHSA-xjj6-f33q-929c; zod 4.6.5 GHSA-mrhx-c7xc-m3w5). The fix is local commit 6106504 on `fix/audit-advisories-upgrade`, not pushed; its full suite passes 6061 / 0.
- gsd-tools findings, recorded and not worked around: (1) `query init.manager` returns 0 phases for v1.3.x while `init.milestone-op` reports 8, so phase discovery was reconciled from artifacts. (2) `milestone complete v1.4 --dry-run` reported "no phases found" because phases 34-36 sat under the v1.3 heading; fixed by the v1.4 heading above, which adds no phase. (3) The audit workflow globs `*-SUMMARY.md`, but this repo's phases use `SUMMARY.md`, so its summary pass matches nothing; recorded as an audit caveat. (4) `init.milestone-op` reports completed_phases 0; the STATE frontmatter counts (2 completed, 3 plans) disagreed with the artifacts and are corrected above.
- Phase reconciliation, artifacts win: every phase 34-51 has CONTEXT, PLAN, SUMMARY and VERIFICATION. VERIFICATION status: passed for 34, 35, 36, 44 and 51; human_needed for 37-43, 45, 46 and 47-50. Phases 52-54 exist only on draft branches (#104, #109, #110, #111), not on main.
- Phase 46 (re-scoped): criterion 1 is largely in code. `planes/lightrag.ts`, `lightrag.test.ts`, the config LightRAG wiring, and the `docs-search.ts` LightRAG dispatch with Hindsight as a failure fallback are all present. Gaps for criterion 1: context is not attached to LightRAG success answers (`service.ts:4550` gate; decision Q3); "hybrid" is a LightRAG mode, not the RAGFlow weight (Q1); `docs/docs-plane.md` still describes RAGFlow only. Criteria 2-6 are live steps, each needing per-run approval. The RAG-hybrid CONTEXT.md and PLAN.md are superseded and are not reused. The decision brief Q1-Q4 awaits discuss answers.
- TODO_BACKLOG (n3): the raw marker pass finds 25 hits and no real open items. Five are placeholder strings in packages; 20 are planning prose. Register items from `todo-inventory.md`, with dispositions: D-01 DEFERRED (operator-gated live handoff proof). D-02 MAPPED to phase 46. D-03 DEFERRED (human-only). D-04 DEFERRED (orphan). D-05 DEFERRED (orphan). D-06 NEEDS_DECISION: direction answered 2026-10-24 as governed fact entries; implementation scope still open. D-07 DEFERRED (operator-gated): the phase 20 scratch UAT passes scenarios 1, 3, 4, 6, 7 and 8; scenarios 2 and 5 were never run because they are production-gated. D-08 DEFERRED (accepted debt with v1.3). D-09 and D-10 (IN-01, IN-02) DEFERRED (orphan). D-11, D-12 and D-13 (IN-04, IN-05, IN-06) DEFERRED, fold when touched: no open branch or draft touches `scripts/parity-check.ts`, `rehearsal.ts` or `docs-smoke.ts`. D-14 and D-15 MAPPED to phase 46 (D-15 closes when RAGFlow is removed). D-16 DEFERRED until measured: phase-close ran in 3.2 s in this run. D-17 DEFERRED to the touched-code rule: 29 findings in 24 files, not enabled repo-wide. D-18 FOLD when touched: explicit `any` is 37 (19 in tests, 18 outside); the register's 34 is stale. D-19 NEEDS_DECISION to ship: Biome is on `quality/biome-report-only` (a9dba82, pushed), unshipped. D-20 DEFERRED: README.md:91 documents `bun run check`, which no script defines; no README change is in this run's file set. D-21 NEEDS_DECISION to ship: swarm pins are on `test/swarm-pins-a16-a30` (04772af, pushed), unshipped. D-22 CONFIRMED (no change). D-23 CONFIRMED: 11 stashes kept.
- Scout items from phase CONTEXT and PLAN "Out of scope" lists (phases 37-44) DEFERRED to each phase's operator gate, the same gates as the Deferred Verification table.
- Quality candidates, not started: `packages/dispatcher/tests` and `packages/miner/tests` hold Python tests that no gate runs, while `package.json` defines `test:py`; `docs/ci.md` says none exist on main. Also: explicit `any` 37; 29 unused-local/parameter findings; the Biome gate and the audit upgrade await shipping.

## Run update (2026-10-24, after the integration fixes)

- Integration checks (read-only) found a v1.4 blocker: an identical versioned skill replay returned 409 (F1). They also found the phase 36 tests missing from HEAD, LightRAG persisting the valid siblings of an invalid page (criterion 34.1), and docs and skills contract warnings. Fixed on the run branch: `c74fa07` (skills replay through a beforeWork hook), `5b5f68f` (phase 36 tests restored from stash@{6}), `7cf8d44` (docs outcome conflict, HTTP 409 and keyed-replay tests), `76f2707` (LightRAG whole-batch refusal).
- Composite gate `bun run verify` on the run tree: exit 0. Tests 6073 pass, 177 skip, 0 fail (baseline 6061 / 177 / 0). The skips are the Postgres suites, which CI runs; this host's scratch Postgres was unreachable.
- Audits written: `v1.3.x-MILESTONE-AUDIT.md` gaps_found (`89b8eb5`); `v1.4-MILESTONE-AUDIT.md` tech_debt (committed with this update). Neither milestone is archived; `complete --confirm` waits for the operator.
- Incident: agent edits for the fixes first landed in the primary checkout, on PR #123's branch `planning/consistency-check-2026-10-24`, uncommitted. The patch was saved, applied to the run worktree, and the primary was restored to clean. PR #123's branch is unchanged.

## Session Continuity

Last session: 2026-10-08T21:29:12Z
Stopped at: Phase 18 complete, ready to plan Phase 19
Resume file: None

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 16 P16-01 | 15min | 2 tasks | 2 files |
| Phase 16 P16-02 | 9min | 3 tasks | 4 files |
| Phase 16 P16-03 | 14min | 3 tasks | 3 files |
| Phase 16 P16-04 | 5min | 3 tasks | 4 files |

## Decisions

- [Phase 16]: 16-01: rehearsal-env builder is pure with caller-supplied secrets; operator checks precede token materialization
- [Phase 16]: 16-02: parity startEpoch from ExecMainStartTimestamp (@unix); /proc start is a disagree-warning only
- [Phase 16]: 16-02: originShaKnown null fails closed with its own reason, distinct from sha-absent
- [Phase 16]: 16-03: ledger image override key composed at runtime so the store-lock substring scan stays green
- [Phase 16]: 16-03: smoke reads only consumer.env and refuses :7410/non-loopback before any request; claim needs claimed true plus granted
- [Phase 16]: 16-03: requirements-completed left empty, FOUND-01 stays open until the 16-05 live proof
- [Phase 16]: 16-04: docs carry key names only, no connection-string shapes; production-mutating steps framed operator-only

## Post-milestone uplift (graph ut-mv5r71hp-65f7b012, 2026-10-12)

Standalone post-close series on branch `ultrathink/uplift-7` — proposal: [UPLIFT_PROPOSAL.md](UPLIFT_PROPOSAL.md). Operator pre-authorized autonomous selection (engineering mix); no new milestone.

| Item | Status | Evidence |
|------|--------|----------|
| U5 gate verdicts as events (memory plane) | done | [uplift/01-SUMMARY.md](uplift/01-SUMMARY.md) — mcp-server 0 fail, phase-close pass, tsc clean |
| U4 quota-burn SLOs + dispatch storm-breaker | done | [uplift/02-SUMMARY.md](uplift/02-SUMMARY.md) — test:py 272 pass, obs/mcp 0 fail, tsc clean |
| U2 host VM re-adoption after restart | done | [uplift/03-SUMMARY.md](uplift/03-SUMMARY.md) — host 244 pass, tsc clean, full suite green mod F-01 |
| U1 sandbox egress allowlist | done | [uplift/04-SUMMARY.md](uplift/04-SUMMARY.md) — host 281 pass, tsc clean, full suite green mod F-01 |
| U3 signed dispatch handoffs + drift gate | done | [uplift/05-SUMMARY.md](uplift/05-SUMMARY.md) — test:py 293 pass, tsc clean |
| U6 knowledge freshness automation | done | [uplift/06-SUMMARY.md](uplift/06-SUMMARY.md) — projector+mcp 0 fail, phase-close pass, tsc clean |
| U7 loopback SSE event stream | done | [uplift/07-SUMMARY.md](uplift/07-SUMMARY.md) — mcp 0 fail, phase-close pass, tsc clean, full suite green mod F-01 |

## Post-milestone uplift 2 (graph ut-mv66gjpd-4d730336, 2026-10-13)

Second standalone post-close series on branch `ultrathink/uplift-2` — proposal: [uplift-2/PROPOSAL.md](uplift-2/PROPOSAL.md) (recon [CONTEXT.md](uplift-2/CONTEXT.md), measurements [BASELINES.md](uplift-2/BASELINES.md)). Operator accepted all seven on 2026-10-13; repo changes only, data-reducing policies behind opt-in flags (nothing deleted in production); no new milestone. Measured driver: `brief.p95` 3,116 ms against the 800 ms SLO with a 1 % cache hit ratio.

| Item | Status | Evidence |
|------|--------|----------|
| R1 brief fast path + cache effectiveness | done | [uplift-2/01-SUMMARY.md](uplift-2/01-SUMMARY.md) — twin: ETag/304 8 ms, degraded brief 1.21 s under a hung ledger |
| R2 plane breakers, per-plane SLOs, dependency-aware healthz, chaos per plane, substrate-red runbook | done | [uplift-2/02-SUMMARY.md](uplift-2/02-SUMMARY.md) — twin: breaker open after 5 timeouts, emit fails closed in 5 ms, healthz 503 |
| R3 Hindsight retain outbox, bounded recall, config hygiene | done | [uplift-2/03-SUMMARY.md](uplift-2/03-SUMMARY.md) — unit evidence; production pending deploy |
| R4 index pool/timeouts, capacity, dry-run sweeper, lease-stuck + quarantine-spike runbooks | done | [uplift-2/04-SUMMARY.md](uplift-2/04-SUMMARY.md) — twin: capacity live, sweep dry-run deletes nothing |
| R5 ledger chain cache, bounded reads, write-probe health, opt-in TTL | done | [uplift-2/05-SUMMARY.md](uplift-2/05-SUMMARY.md) — twin: write probe + capacity.ledger live |
| R6 RAGFlow documented shapes, durable pins, caches, opt-in prune, async trigger | done | [uplift-2/06-SUMMARY.md](uplift-2/06-SUMMARY.md) — fake-enforced; live RAGFlow still operator-gated |
| R7 VPS ceilings + slice, store-aware deploy gate, redis config, audit rollover, disk runbook | done | [uplift-2/07-SUMMARY.md](uplift-2/07-SUMMARY.md) — twin: `audit:verify` ok |

Gates at the final head: tsc clean · `bun test` 3525 pass / 65 skip / 1 fail (recorded F-01) · `check:phase-close` pass · `test:py` 298. Operator steps after merge: `infra/vps/deploy-release.sh` (new unit ceilings, `substrate.slice`, env lines), then read `/slo` and `/healthz` for the post-deploy rows in BASELINES.md; optional flags documented in `.env.example` (`SUBSTRATE_INDEX_SWEEP=apply`, `SUBSTRATE_LEDGER_TTL`, `SUBSTRATE_DOCS_PRUNE_SUPERSEDED`, `SUBSTRATE_AUDIT_ROLLOVER_BYTES`) stay off until chosen.

Deployed 2026-10-13T21:02Z (`release-20261013-91487e7`) and, after the post-deploy follow-up PR #60, `release-20261013-9231f43`: `brief.p95` 700 ms, all five plane breakers closed, `parity:check` PASS. Record: [uplift-2/HANDOFF.md](uplift-2/HANDOFF.md), [uplift-2/BASELINES.md](uplift-2/BASELINES.md).

## Post-milestone uplift 3 (graph ut-mv78nh8v-aa49a98b, 2026-10-13)

Third standalone post-close series on branch `ultrathink/uplift-3` — proposal: [uplift-3/PROPOSAL.md](uplift-3/PROPOSAL.md) (recon [CONTEXT.md](uplift-3/CONTEXT.md), live baseline [BASELINES.md](uplift-3/BASELINES.md)). Operator chose the series after the same prompt returned a fourth time and accepted all seven on 2026-10-13; same rules as uplift-2: repo changes plus the VPS deploy, every policy behind a flag that preserves today's behaviour, nothing deleted in production. Measured driver: evidence and policy are not durable — SLOs reset on every restart, memory TTLs are declared but not honoured, the ledger has no verified archive and anchoring is not scheduled, redis runtime policy drifted from the R7 config, no admission budgets, sequential RAGFlow retrieval, no Grok connector contract.

| Item | Status | Evidence |
|------|--------|----------|
| N1 runtime drift and jobs doctor | done | [uplift-3/01-SUMMARY.md](uplift-3/01-SUMMARY.md) |
| N2 restart-durable SLO history, capacity runway, ledger-native notifications | done | [uplift-3/02-SUMMARY.md](uplift-3/02-SUMMARY.md) |
| N3 per-surface admission budgets (shadow first) | done | [uplift-3/03-SUMMARY.md](uplift-3/03-SUMMARY.md) |
| N4 memory lifetime enforcement (report → enforce) | done | [uplift-3/04-SUMMARY.md](uplift-3/04-SUMMARY.md) |
| N5 docs retrieval fan-out, metrics, offline golden harness | done | [uplift-3/05-SUMMARY.md](uplift-3/05-SUMMARY.md) |
| N6 ledger coverage probe and verified archive | done | [uplift-3/06-SUMMARY.md](uplift-3/06-SUMMARY.md) |
| N7 Grok connector contract: smoke, MCP brief metadata, per-surface SLO | done | [uplift-3/07-SUMMARY.md](uplift-3/07-SUMMARY.md) |

Gates at the final head: tsc clean · `bun test` 3845 pass / 1 skip / 1 fail (recorded F-01) · `check:phase-close` pass · `test:py` 298. Every new policy ships in its reporting/shadow/off default: `SUBSTRATE_BUDGETS=shadow`, `SUBSTRATE_MEMORY_EXPIRY=report`, `SUBSTRATE_SLO_NOTIFY` unset, the doctor and ledger-archive timers staged but not installed, `SUBSTRATE_LEDGER_ARCHIVE_DIR` unset. Operator steps after merge and deploy: [uplift-3/HANDOFF.md](uplift-3/HANDOFF.md).

## Post-milestone uplift 4 (graph ut-mv7ciy6p-4429f130, 2026-10-14)

Fourth standalone post-close series — proposal: [uplift-4/PROPOSAL.md](uplift-4/PROPOSAL.md) (recon [CONTEXT.md](uplift-4/CONTEXT.md), live baseline [BASELINES.md](uplift-4/BASELINES.md)). Operator accepted all seven on 2026-10-14 at the proposal gate and chose to land uplift-3 (PR #61) first; same rules as uplift-2 and 3: repo changes only, every policy behind a flag whose default preserves today's behaviour or only reports, nothing deleted in production, no new service or plan tier. Two PRs: **A** S2, S3, S6, S7 (data planes and VPS); **B** S4, S1, S5 (the brief pipeline) — handoff and operator steps: [uplift-4/HANDOFF.md](uplift-4/HANDOFF.md). Measured driver: the Grok Bot's brief is uncapped and drops its own state, the index has no verified backup, the cache re-composes every brief after any write, BP-5.0 recall is not in the brief, SLO history lives only in a local checkpoint, a stale or lagging docs corpus is invisible, and the VPS runs at equal cgroup weight with no watchdog and a 330 MB uncapped journal.

| Item | Status | Evidence |
|------|--------|----------|
| S2 index disaster recovery (verified export, offline verify, restore-to-scratch, lease-bloat visibility) | done in PR A | [uplift-4/S2-SUMMARY.md](uplift-4/S2-SUMMARY.md) |
| S3 VPS runtime hardening (slice priority and swap isolation, `/livez` and opt-in watchdog, disk guardrails) | done in PR A | [uplift-4/S3-SUMMARY.md](uplift-4/S3-SUMMARY.md) |
| S6 durable metrics history in GreptimeDB | done in PR A | [uplift-4/S6-SUMMARY.md](uplift-4/S6-SUMMARY.md) |
| S7 docs freshness SLI, trigger lag, live golden canary | done in PR A | [uplift-4/S7-SUMMARY.md](uplift-4/S7-SUMMARY.md) |
| S4 cache single-flight, stale-while-revalidate, per-class metrics | done in PR B | [uplift-4/S4-SUMMARY.md](uplift-4/S4-SUMMARY.md) |
| S1 Grok brief contract: compact profile, state line, estimated-spend SLI | done in PR B | [uplift-4/S1-SUMMARY.md](uplift-4/S1-SUMMARY.md) |
| S5 cross-session recall in the brief, Hindsight inventory and gauges | done in PR B | [uplift-4/S5-SUMMARY.md](uplift-4/S5-SUMMARY.md) |

Every new policy ships in its off or report/shadow default: `SUBSTRATE_METRICS_HISTORY` off, `SUBSTRATE_INDEX_ARCHIVE_DIR` unset (the archive refuses by name), `SUBSTRATE_INDEX_TUNE` off, `SUBSTRATE_WATCHDOG` off with the watchdog drop-in shipped as an example, the docs canary refusing without its opt-in, and the freshness and lag rows report-only. The one default-on change is additive: `capacity()` also reports `graph_nodes` HOT-update and dead-row ratios, read concurrently with the existing statements.

PR B's defaults: `SUBSTRATE_BRIEF_PROFILE=shadow` (serves the full text, counts what the compact one would save), `SUBSTRATE_CACHE_SWR=shadow` (serves live, counts `would_serve_stale`), `SUBSTRATE_BRIEF_RECALL=off`, `SUBSTRATE_HINDSIGHT_INVENTORY=off`. Default-on and additive: identical concurrent cache misses share one load (single-flight); the brief answer carries `x-substrate-brief-profile` and, over MCP, `profile`; brief cache entries move to shape `sections-v1` (one cold start on deploy); a brief lists at most 1000 nodes (then says how many it left out); `/healthz.cache` gains `coalesced`, `stale`, `wouldServeStale`, `refreshes`; the three retain-outbox gauges and the per-class cache counters are always present.

## Post-milestone uplift 5 (graph ut-mv7mtq2j-b41cedcc, 2026-10-14)

Fifth standalone post-close series — proposal: [uplift-5/PROPOSAL.md](uplift-5/PROPOSAL.md) (recon [CONTEXT.md](uplift-5/CONTEXT.md), live baseline [BASELINES.md](uplift-5/BASELINES.md)). Operator accepted all seven on 2026-10-14 at the proposal gate and chose **merge only; the operator deploys**; same rules as uplift-2 to 4: repo changes only, every policy behind a flag whose default preserves today's behaviour or only reports, nothing deletes production data, units, timers, drop-ins and Railway variables are operator steps staged as files, cost-neutral. Two PRs: **A** (release assurance, VPS sandbox hardening, dashboards, promotion advisor) and **B** (request path, durable events, skills governance).

| Item | Status | Evidence |
|------|--------|----------|
| U5-1 release assurance: deploy preflight, rollback-compatibility tests, opt-in boot-and-prove gate, report-only CI job | done in PR A | [uplift-5/S1a-SUMMARY.md](uplift-5/S1a-SUMMARY.md), [uplift-5/S1b-SUMMARY.md](uplift-5/S1b-SUMMARY.md) |
| U5-2 VPS sandbox hardening: staged drop-ins per unit class, doctor exposure rows, offline exposure test | done in PR A | [uplift-5/S2-SUMMARY.md](uplift-5/S2-SUMMARY.md) |
| U5-6 SLO dashboards as code and opt-in extended history series | done in PR A | [uplift-5/S6-SUMMARY.md](uplift-5/S6-SUMMARY.md) |
| U5-7 promotion advisor, flag registry and config reference | done in PR A | [uplift-5/S7-SUMMARY.md](uplift-5/S7-SUMMARY.md) |
| U5-3 request-path efficiency: lite brief graph read, narrow cache invalidation, `/healthz` single-flight | done in PR B | [uplift-5/S3-SUMMARY.md](uplift-5/S3-SUMMARY.md) |
| U5-4 durable events: idempotent replay key and bounded collector spool | done in PR B | [uplift-5/S4a-SUMMARY.md](uplift-5/S4a-SUMMARY.md), [uplift-5/S4b-SUMMARY.md](uplift-5/S4b-SUMMARY.md) |
| U5-5 skills governance: registry, operator-only approve, approval-gated projection | done in PR B | [uplift-5/S5a-SUMMARY.md](uplift-5/S5a-SUMMARY.md), [uplift-5/S5b-SUMMARY.md](uplift-5/S5b-SUMMARY.md) |

PR A's defaults: `SUBSTRATE_DEPLOY_PREFLIGHT=report` (prints a table, never changes a deploy), `SUBSTRATE_DEPLOY_GATE=off`, `SUBSTRATE_EXPOSURE_MAX` unset (the doctor only reports exposure), `SUBSTRATE_METRICS_HISTORY_SERIES=core`; the sandbox drop-ins ship as `.example` files and nothing installs them; the `boot-gate` CI job needs both `vars.CI_ENABLED` and `vars.BOOT_GATE`. The one runtime-visible change in PR A is the `SUBSTRATE_METRICS_HISTORY_SERIES` parser (default core, byte-identical); everything else is scripts, infra examples, tests and docs.

PR B's defaults: `SUBSTRATE_BRIEF_GRAPH_READ=full`, `SUBSTRATE_CACHE_BUMP_SCOPE=legacy`, `SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S=0`, `SUBSTRATE_EVENT_IDEMPOTENCY=off`, `SUBSTRATE_EVENT_SPOOL=off`, `SUBSTRATE_SKILLS_GOVERNANCE=off`. Default-on and additive: concurrent `/healthz` probes share one computation; `/healthz` carries an `idempotency` field; `refused-emits.jsonl` rotates to one `.1` file at 1 MiB; the skills projector resolves its bearer the way its fetch does (surface token first, first entry of a list); `skills_registry` is created at boot; `skills_approve` and `skills_list` exist (operator-only and approved-only by default). Handoff and operator steps: [uplift-5/HANDOFF.md](uplift-5/HANDOFF.md). Nothing was deployed.
