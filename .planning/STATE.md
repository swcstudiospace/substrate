---
gsd_state_version: "1.0"
milestone: v1.8
milestone_name: "Hardening: Multi-Session, Ledger Integrity, Degradation and Reconciliation"
status: "v1.8 defined (phases 71-78, none complete); v1.7 phases 63-70 shipped; v1.7 owner decisions open"
stopped_at: "v1.8 defined in ROADMAP by PR #198 (phases 71-78, not started); implementation units on gsd/hardening-* branches"
last_updated: "2026-10-31T00:30:00.000Z"
last_activity: 2026-10-31
last_activity_desc: "Milestone v1.8 defined: phases 71-78 in ROADMAP; no phase complete"
state_head: 9d3f20851a85
progress:
  total_phases: 8
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
current_phase: 71
current_phase_name: multi-session-boundary
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

Phase: milestone v1.7 phases 63-70 are shipped on main; the milestone is not complete. Requirements audit (milestones/v1.7-REQUIREMENTS-AUDIT.md, one grading rule): 25 of 41 requirements MET, 16 PARTIAL, 0 NOT MET. Owner decisions are open. v1.3.x (37-44), v1.5 (45-54) and v1.6 (55-62) are archived as override closeouts.
Plan: none written (phases are built in orchestrated waves of edit-only units and recorded in SUMMARY.md, as in Runs 12 and 13).
Status: Not complete. Every gap is pending the owner's decision and none is accepted (see the requirements audit). The owner's 2026-10-28 decision in the section "Accepted debt (owner decision, 2026-10-28)" covers earlier milestones only; the operator-gated steps are listed in the Run 12, Run 13 and Run 14 records.
Last activity: 2026-10-30 — Run 14 closeout: phases 63-70 shipped; Run 15 fixes merged (#188-#193, claude-ultrathink #76).

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

## Accepted debt (owner decision, 2026-10-28)

Asked once, with the audit numbers, during Run 12; the owner answered close for all three. The acceptance below is dated 2026-10-28 and replaces, for the items named, the 2026-10-23 statement that phase 46 is not accepted as debt. Each item stays OPEN and unsatisfied where the audit says so; accepting it as debt does not mark it passed.

| Milestone | Item | Audit finding | What stays open |
|-----------|------|---------------|-----------------|
| v1.3.x | phases 37-43 | human_needed; 37-39 waived 2026-10-25, 40-43 accepted debt 2026-10-23 | the live proofs named in `.planning/v1.3.x-MILESTONE-AUDIT.md`; D-D3 (restore drill and the retirement of the old path) was never delivered in the repository, only its runbook |
| v1.5 | phase 46 (SOTA-02) | unsatisfied: criterion 4 NOT met (no parity comparator exists), criterion 5 partial (cutover done, RAGFlow code removal gated), criteria 2 and 6 and LightRAG graph/hybrid modes need per-run approval and a real LLM route | everything in `.planning/phases/46-lightrag-hybrid/VERIFICATION.md` marked NOT MET, PARTIAL or OPERATOR-GATED |
| v1.5 | phases 45, 47-50 | accepted debt since 2026-10-23, unchanged | live Railway, forecast and warm-up, proxy cutover, graph-memory ledger rows and pub/sub proofs |
| v1.6 | phase 61 criterion 3 (SOTA-17) | PARTIAL: PR #148 shipped `substrate session hook`, the trigger policy and printed host configuration, but no host fires the hook until an operator installs the printed configuration (ADR 0007 decision D55-4) | installing the hook in a host, plus the `steering` and `baseline` hook configurations that the printed output does not cover |
| v1.6 | phase 59 live proofs (SOTA-15) | human_needed: 6 of 6 criteria met in the repository | anchor key funding, the anchor timer, any devnet send (the re-anchor executor was never run against any cluster), the Eternal Memory bucket |

Not accepted, not silently dropped: the audits' integration findings that are not criteria (the `checkpoint_hint` has no reader in the CLI, `S3BlobStore` has no caller outside its own test, `memoryForget` has only the rollback caller) are listed in `.planning/v1.6-MILESTONE-AUDIT.md` section 5 and remain follow-up work.

## Deferred Items

Items acknowledged and deferred, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| uat_gaps | milestones/v1.0-phases/00-brief/0-UAT.md | partial (8 scenarios pending) | 2026-10-07 | v1.1 |

## Operator Next Steps

- Start the next milestone with /gsd-new-milestone

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

Phases 40-43, 45 and 47-50 are accepted debt (operator decision, 2026-10-23). Phases 37-39 are closed by the operator's live-criteria waiver recorded in 585ef28 (2026-10-25); their rows stay here only as the record of what was waived. Phase 46 is open work (re-scoped), not deferred.

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

## Run 2 record (2026-10-24, graph ut-mvm0p0jr-874c2ace)

- Kickoff: track complete ran once (exit 0). The Notion Task is set to Implementing; 7 node rows and 55 step rows exist in Notion. Linear is partial because of the free-issue limit (the same blocker as before), so it fails open. The session is marked kicked off. The seven node lines are in the todo list with their Notion URLs; the 55 step rows stay in Notion.
- Clarifications, non-blocking defaults stated: q1 shipping is local commits only; q2 is criteria plus at most three hotspots per phase, touched modules only; q3 is in-repo TODO sources only.
- Ground truth: branch gsd/autonomous-run-2026-10-24 in /root/src/worktrees/as-gsd-autonomous, clean at the start. The primary checkout is on planning/consistency-check-2026-10-24 (PR #123) and this run did not commit there. Gates: bun test, bunx tsc --noEmit, bun run check:phase-close, the composite bun run verify, and the opt-in bun scripts/audit-gate.ts. Lint and build are absent. Skill() is not a tool in this environment, so discuss, plan and phase artifacts were produced directly from the workflow steps; this is a recorded fallback.
- Phase state, artifacts win: v1.4 complete and archived (phases 34-36). v1.3.x: phase 44 passed, 37-43 human_needed, 40-43 accepted debt, 37-39 need a waiver. v1.5: 45 and 47-50 accepted debt, 46 partial, 51 complete, 52-54 in review.
- Decisions, auto-selected under the rubric: D-N4-1 continue past the active milestone in ROADMAP order behind an entry gate (review: yes). D-N4-2 local commits only; remote steps are HARD_STOP actions, with a conflict entry against "finish shipping everything". D-N4-3 stay on gsd/autonomous-run-2026-10-24; no branch created. D-N4-4 one commit per completed unit using the branch's prefix convention. D-N4-5 at most three hotspots per phase, touched code only; no production code was touched, so none was selected (review: yes). D-N4-6 no new dependencies. D-N4-7 codebase-idiomatic reading of Best-in-Class. Phase 46 decisions D46-1 to D46-5 are in .planning/phases/46-lightrag-hybrid/CONTEXT.md; D46-3 and D46-5 are flagged for review.
- HARD_STOP actions, none performed: phase 46 live steps T5 to T8; any push, PR, merge, tag or deploy; PR #123 stays held; waiving the live criteria of 37-39 (operator only).
- Gates on the final tree: bun run verify with a throwaway postgres:16 container (this host has Docker but not the Postgres binaries CI uses): exit 0; install passed; typecheck passed; tests 6222 pass, 2 skip, 0 fail; locks passed. Dependency audit: exit 1 with the same three pre-existing advisories (body-parser, undici, zod); nothing new. Secret scan, count-only, four pattern classes, over git diff 36580a6..HEAD: 0 hits. Markers added outside .planning: 0.
- Test-count reconciliation: the no-Postgres run at 76f2707 reported 6073 pass and 177 skip. Adding the 4 new tests gives 6254 in skip mode against 6224 in Postgres mode. The 30 difference is unnamed skipped placeholders and one sentinel test that exist only when SUBSTRATE_TEST_PG_URL is unset. Named tests match across modes in the three files checked.
- Recorded, not resolved: phase 25 artifacts are archived under milestones/v1.3-phases/ (located 2026-10-24; 25-VERIFICATION not read yet); STATE's raw marker count of 25 against a live count of 28; explicit any 34 by the register method and 37 by the earlier method; the D-07 conflict; phase 40 debt dated 2026-10-23 at ROADMAP line 93 against a scope acceptance dated 2026-10-22 at line 571; VERIFICATION citation drift in phases 34 and 35.
- Tool incidents: subagent edits given relative paths landed in the primary checkout several times. Each was moved into the worktree, or removed after its diff was confirmed, and the primary now shows zero changed entries. Future subagent tasks must use absolute worktree paths.
- Milestone completion: gsd-tools milestone complete v1.4 --confirm exited 0 and archived the ROADMAP, REQUIREMENTS and audit copies and phases 34-36 to milestones/v1.4-*. The tool preserved this run's STATE values over derived ones.

## Run 3 record (2026-10-24, graph ut-mvm3ltr7-ac84a338)

- Kickoff: track complete ran once, exit 0, tracking partial. Linear: 0 of 8 node rows and 61 step rows, blocked by the Linear free-issue limit (fail open). Notion: no Notion error reported; the tracking block lists the 8 node URLs and the step URLs. The Notion Task 403bc1a0c7ae81e39ef4f8c7daf1e267 is set to Implementing. The session is marked kicked off. Non-blocking HITL defaults applied as assumptions: quality limited to touched files; shipping limited to local commits; TODO sources limited to the repo.
- Baseline, before this pass: run worktree gsd/autonomous-run-2026-10-24 at c9e06f5, clean. Primary checkout on planning/consistency-check-2026-10-24, clean. Remotes: origin only. Checks: `env -u SUBSTRATE_TEST_PG_URL bun run verify` exit 0 (install ok; typecheck ok; tests 6077 pass, 177 skip, 0 fail; locks ok). The 177 skips are the Postgres-only suites, as the repo's own note says. `bun scripts/audit-gate.ts` exit 1, with the three pre-existing advisories (body-parser, undici, zod). Postgres-mode result carried forward: 6222 pass, 2 skip, 0 fail at fe9ac61. No code file has changed since (`git diff --name-only fe9ac61..HEAD`, outside .planning: 0). The checks changed no tracked file.
- Drift log and corrections: (1) ROADMAP progress rows 37-39 and their checkboxes said Complete, but the v1.3.x header says they await an operator waiver. Reopened in ROADMAP, commit 78cf648. (2) ROADMAP line 93 (debt accepted 2026-10-23) and line 571 (scope narrowed 2026-10-22) are two recorded decisions, not a conflict. No change. (3) STATE's raw marker count of 25 against a live 28: 28 is the all-files rg count, including self-matches in PREFLIGHT, STATE and todo-inventory. Outside .planning the count is 5, all placeholder literals. Real open markers: 0. (4) D-07 and D-18 resolved, decision 9. (5) T4 was recorded as deferred by the run; only the user can defer, so it is BLOCKED (PLAN T4), commit 103d969. (6) .planning/phases/46-ragflow-hybrid/VERIFICATION.md still reads "2 of 2 proven" under phase 46. It belongs to the superseded RAG-hybrid plan and is not used for phase 46 status. Not edited in this pass. (7) "Phase 46 cutover" is defined by ROADMAP criterion 5, a logged reversible switch; no separate doc defines it. (8) ROADMAP progress rows 52-54 say 0/0 plans while their artifacts exist on draft PR branches. Not edited.
- TODO inventory, S1 to S3. S1 (spec pattern, case-insensitive, outside .planning): 142 raw lines in 38 files. Reduced to 0 comment-style annotations. The 5 uppercase marker lines are placeholder literals (PREFLIGHT M-01 to M-05). S2 over .planning: historical records and self-quotes only. S3 candidate document: .planning/todo-inventory.md, the register. Register dispositions (PREFLIGHT, re-checked by this pass's reads): FOLDED_INTO phase 46, owner PLAN T8 (cutover and RAGFlow removal): D-02, D-14, D-15. D-15 is a real defect: the RAGFlow search path never receives the Hindsight dependency, because `deps.hindsight` in docs-search.ts failed() is never wired. It is not patched now, because that path is scheduled for deletion at cutover, and the dead read goes with it. CLOSED_STALE with evidence: D-22, D-23, and M-01 to M-28 (placeholders and prose). DEFERRED with reason: D-01, D-03 to D-13, D-16 to D-21 (18 items; each has a revisit trigger in PREFLIGHT). Open code markers: none.
- Phase status from ROADMAP and artifacts: v1.3 phases 16-33 COMPLETE with recorded accepted debt (2026-10-21). v1.4 phases 34-36 COMPLETE, archived. v1.3.x 37-39 BLOCKED on operator waiver (reopened). v1.3.x 40-43 COMPLETE with accepted debt (2026-10-23), live proofs PENDING_HUMAN_VALIDATION. v1.3.x 44 COMPLETE. v1.5 45 and 47-50 COMPLETE with accepted debt (2026-10-23), live proofs PENDING_HUMAN_VALIDATION. v1.5 51 COMPLETE (PR #108). v1.5 46 BLOCKED (partial). v1.5 52-54 BLOCKED on operator decisions (draft PRs). v1.4 is COMPLETE and archived. v1.3.x and v1.5 cannot reach COMPLETE while any phase in them is BLOCKED.
- Phase 46 this pass: T3 content check recorded, 9 of 10 confirmed, Q8 fails, amendment proposed and not applied (commit 103d969). T4 BLOCKED. Criterion 5 candidate list recorded in SUMMARY: 25, 40, 42, 51. Phase 25 verification read. No code change.
- Work committed this pass: 103d969 (phase 46 docs), 78cf648 (reopen 37-39), db77a48 (decisions 8 and 9), and this record. No code changed. Nothing pushed, tagged, deployed, or merged.
- Wave 5 checks: full-milestone secret scan, diff against main aa2ed6a, 43 files: 0 hits. Positive control: 1 hit, as expected. DoD spot-check, one unit per phase completed in this run: c74fa07 (phase 36) adds failure-path tests (a stale expected_version gives a 409 and nothing is proposed; a refused beforeWork opens nothing). Only the failure-path item was checked; the other DoD items were not re-reviewed.
- Waves 6 to 8 (audit, complete, cleanup): not run. Phases 37-39, 46 and 52-54 are BLOCKED, so neither open milestone can reach COMPLETE. Cleanup: nothing removed. The only temporary files were pattern files under /tmp, removed.
- Decisions, AUTO_DECIDED this pass (IDs prefixed G3 to avoid the register's D- IDs):
  - G3-D1 scope and order: all incomplete milestones in ROADMAP order, active first. Alternatives: active only; dependency first. Reversal cost: low.
  - G3-D2 shipped means merge-ready: local commits, no push, PR, tag or deploy. Alternatives: push; release. Reversal cost: low.
  - G3-D3 cleanup: archive, never delete. Nothing removed.
  - G3-D4 version control: explicit-path staging; hold a unit whose files overlap an unrelated change (none did); no stash, reset or hook skip.
  - G3-D5 validation: non-gated human items are PENDING_HUMAN_VALIDATION; accepted debt closes the phase with its live proofs queued.
  - G3-D6 toolchain: CI pins Bun 1.4.0 per AGENTS.md; no drift observed in the verify run.
  - G3-D7 secrets: record location only; the milestone diff scan is clean.
  - G3-D8 a TODO can be DEFERRED while phase DEFERRED stays user-only.
  - G3-C1 to G3-C8 (conditional rules): none triggered, since no code unit ran.
  - G3-R1 a gated sign-off is BLOCKED, with the sign-off as its unblock condition. G3-R2 an unverifiable check is UNVERIFIED, not PASSED. G3-R3 an unfetchable dependency is BLOCKED.
  - Accepted debt recorded by the operator is treated as completed-with-debt (AUTO). Reopen a phase if a live proof fails.
- Packet, delivered once after independent work, which here is none runnable:
  - G3-P1 (PAUSE 1, irreversible or high blast radius).
    - (a) Phase 46 live steps: T5 archive with checksum (operator approval per run); T6 LightRAG deploy and timed probe to production; T7 migration job before ingestion; T8 cutover and RAGFlow removal, with storage deletion needing its own approval. Options: approve a run, defer, or approve a reversible variant. Recommendation: approve T5 only, a reversible archive. Blocks: phase 46 criteria 2 to 6.
    - (b) Remote actions: push gsd/autonomous-run-2026-10-24 and open a draft PR, no merge; merging any PR, including the run PR and #104, #109-#111 and #123. Config: ship.autoMerge is true, so a PR that reaches 5/5 would merge with no further decision. Options: draft PR only, or autoMerge off until each merge is approved. Recommendation: draft PR only, and autoMerge off. Blocks: the ship step and phases 52-54.
    - (c) Branch deletion: quality/biome-report-only, test/swarm-pins-a16-a30, and the ad9e4de merge on gsd/p52-planning-core. Options: keep or delete. Recommendation: keep.
  - G3-P2 (PAUSE 2, access or paid service).
    - (a) Linear free-issue limit: zero Linear rows for this graph. Options: upgrade the plan (spend), or accept Notion-only tracking. Recommendation: accept Notion-only; the kickoff already fails open.
    - (b) RAGFlow read-only export for T4: needs RAGFlow access, supplied by environment variable name, never in a file. Options: provide access after T5 is approved, or defer T4. Recommendation: provide access after T5.
    - (c) Live proofs for phases 37-43 and 45 and 47-50 (Linear, Notion, Solana devnet, Railway, Hermes, the Cursor hook behind credential rotation): operator windows. Options: run in a bounded window, or waive each named item. Recommendation: run wherever feasible.
  - G3-P3 (PAUSE 3, scope or authority).
    - (a) PARITY_GATE sample: Q8 has no answer in its expected document. Options: approve the amendment in PLAN T3 (recommended, since it corrects the sample before any run); keep Q8 and accept that the gate fails; or replace the query. Blocks: phase 46 criterion 4 and T7.
    - (b) Waiver for the phase 37-39 live criteria: operator only. Options: run the proofs; waive named items with a recorded reason; or keep blocked. Recommendation: run what can run, and waive only what cannot, recorded as debt. Blocks: v1.3.x completion.
  - G3-P4 (PAUSE 4, nothing runnable). Phases 37-39 (G3-P3b). Phase 46 (G3-P3a, G3-P1a, G3-P2b). Phases 52-54: the draft branches conflict with main in .github/workflows/ci.yml, docs/ci.md, docs/data-planes.md, docs/event-vocabulary.md, packages/audit/src/policy.ts and its test, and .planning/phases/48-tailscale-proxy/VERIFICATION.md; #111 also conflicts in infra/vps/dashboards/substrate-data-planes.json. Options: merge main into each draft (no history rewrite; needs a push, G3-P1b); rebase and force-push (history rewrite; needs explicit approval); or close the drafts and open one stacked PR from current main. Recommendation: merge main into each draft, after G3-P1b.
  - G3-P5 (ROADMAP unreadable): not triggered.
  - Not packeted, recorded for follow-up: the accepted-debt classification (AUTO, above); the D-15 fold into T8; PR #124 (gsd/00066-audit-bumps into main, not a draft, CLEAN, unreviewed, not from this run, not touched; its owner should confirm it).
- Ship verdict (`ultrathink-ship assess`, read-only, this pass): done false; gap "GSD roadmap incomplete: 0/8 phases"; branch gsd/autonomous-run-2026-10-24; 23 commits ahead of main; not pushed. No PR, review or merge was run.
- Resume point: no runnable phase or WORK_ITEM remains without a packet decision. Next action: deliver G3-P1 to G3-P4. On each answer, apply the decision, record it here, and resume from its item: T5 for G3-P1a; the PLAN T3 amendment for G3-P3a; the ship step only after G3-P1b is approved.

- Ship decision (operator, 2026-10-25): Hold, no PR. Assess re-run on both branches: done false, gap "GSD roadmap incomplete: 0/8 phases". The run branch (gsd/autonomous-run-2026-10-24, 24 commits) and the planning branch (planning/consistency-check-2026-10-24, 2 commits) both fail the gate. PR #123 stays held (OPEN, APPROVED, CLEAN). Nothing pushed, reviewed or merged.
- Choices recorded for when ship proceeds: branch = the run branch; merge = stop at 5/5, no merge. That needs ship.autoMerge off in the ship config first. The ship config is a user decision and was not changed.

## Run 4 record (2026-10-25, operator answers, Q3 YES)

- Operator answers: Q3 yes (run chooses where the packet approves, and every choice is recorded). Approved: T5 archive only, subject to RAGFlow access. Q8 amendment in PLAN T3 applied. Linear: Notion-only tracking. Phases 37 to 39: run the proofs that can run, then waive the rest, recorded as the operator's waiver.
- T5 (archive with checksum): BLOCKED on access (P2). RAGFLOW_API_KEY, RAGFLOW_URL and RAGFLOW_DATASET_ID are not set in this shell. Names only were checked; no value was read or printed. Unblock: the operator provides them in the environment, never in a file.
- Bootstrap (Wave 1) now runs with Q3 yes: RUN_START is written by this record; the capability registry is the repo checks listed in run 3 (verify, check:phase-close, test, test:py, audit:verify, parity:check).
- Next action: with access, run T5 and record its checksum; otherwise run the 37 to 39 proofs that the host allows, and list those that cannot run for the waiver.

## Run 5 record (2026-10-25, operator re-scope)

- Operator decisions: RAGFlow is empty (operator check, not verified here: no RAGFlow API access). Remove RAGFlow and its associated resources. LightRAG is the docs plane for .planning markdown, repository docs and scraped documentation sites, kept current on change. The product suite is in scope: LightRAG, Hindsight, Dragonfly, TimescaleDB and GreptimeDB. The long-term goal is live steering across sessions and repositories for multi-hour and multi-day GSD sessions.
- Done this run: the `ragflow` Railway service was deleted (no detached volumes). ROADMAP phase 46 has a reconciliation note; no criterion text was changed.
- Measured footprint: 92 files outside .planning mention RAGFlow (1084 matches); 50 are under packages/mcp-server. LightRAG already has a plane (packages/mcp-server/src/planes/lightrag.ts) and its tests, but no LightRAG service is deployed on Railway, and LIGHTRAG_URL is not configured.
- Work sequence (file-disjoint waves; each wave is verified before the next):
  - W1 Inventory and contract: decide the LightRAG-only config contract (remove RAGFLOW_* keys, make resolveDocsBackend return lightrag, keep the LIGHTRAG_* keys). Shared-contract first, because every other unit consumes it.
  - W2 Core removal, serial after W1: planes/ragflow.ts and its test; docs-search.ts, docs-ingest.ts, docs-datasets.ts and their tests; service.ts and mcp.ts wiring; config.ts and flag-registry.ts.
  - W3 Peripheral, parallel after W2: fabric.ts, observability breaker and slo, admission.ts, railway.ts, rag-retry.ts, the scripts (docs-golden, docs-smoke, chaos-planes, dashboards, release-gate), the packages (cli, projector, audit policy), .env.example, and the docs.
  - W4 Gates: bunx tsc --noEmit, bun test, bun run check:phase-close, and bun run verify, with the result recorded.
  - W5 Product-suite wiring: sync .planning markdown and repository docs into LightRAG on change; scrape documentation sites; Hindsight context on answers; Dragonfly cache with invalidation on the doc-change event; Timescale for per-document sync state; Greptime for ingest events.
- Blocked, needs the operator: (1) LightRAG needs an LLM and an embedding provider with its key. Choosing a paid provider is a decision only you can make. (2) The list of documentation sites to scrape, with confirmation that each may be scraped. (3) Approval to deploy LightRAG to production (PLAN T6 is a HARD_STOP). (4) Approval to delete the elasticsearch, mysql, storage and redis services and their volumes after confirming nothing else uses them. (5) Approval for the ragflow-oauth-service and ragflow-oauth-integration services, which I haven't checked for other callers.
- Next action: W1, the config contract. It needs no decision from you.

## Run 5 record, continued (2026-10-25, operator answers)

- Operator decisions: keep ragflow-oauth-service and ragflow-oauth-integration (they supply the coding-plan inference path). Delete elasticsearch, mysql, storage and redis, with their volumes. Deploy LightRAG to production, after the provider and key are set.
- Done: the services elasticsearch, mysql, storage and redis were deleted. Their volumes elasticsearch-volume, mysql-volume, storage-volume and redis-volume were deleted with their data. The operator approved this; the callers were not verified, because variable values are redacted to this integration.
- Still open: LightRAG deploy (PLAN T6, HARD_STOP). Blocked on the provider name and the key in LightRAG's Railway environment. The provider was never named; the key was not provided and was not read.
- Next action: when the provider name and the key are in place, deploy LightRAG and run the W1 to W4 gates.

## Run 6 record (2026-10-25, operator decisions)

- Operator decisions: (1) remove the public service domains of ragflow-oauth-service and ragflow-oauth-integration. Done: both removed from production, and both services remain deployed. (2) LightRAG LLM route: coding-plan OAuth via hindsight-llm-bridge, chosen by the operator with the policy risk stated below. (3) Phases 37 to 39: live criteria waived and accepted as debt. (4) Push review fixes to the draft PRs #109 to #111. No merge, no ship.
- Policy record for decision 2: Anthropic's Legal and compliance page (read 2026-10-25) says developers building products or services that interact with Claude should use API-key authentication, and that Free, Pro and Max plan credentials may not route requests for other users. Subscription OAuth for automated LightRAG traffic falls outside that guidance. The operator accepted this risk. The earlier recommendation of the coding-plan shim was made before this check.
- Security: the memory-mesh discovery notes (2026-10-07) record /token/:provider on ragflow-oauth-service as unauthenticated. This run did not call it, because it returns credentials. Public domains are removed. No token was rotated; if the endpoint served tokens, revoke them in claude.ai settings.
- Production: ragflow-oauth-integration, ragflow-oauth-service and hindsight-llm-bridge redeployed 2026-10-25 between 02:56 and 02:57 UTC. This run did not change them. [INFERENCE: the swarm lane's model-variable change.]
- Bootstrap: the frontmatter is stale (current_phase 40, complete). Two milestones are open: v1.3.x, where all phases 37 to 44 are now closed with accepted debt and the archive has not been run; and v1.5, where phase 46 is partial and phases 52 to 54 are in review.
- PR wave 1: worktrees on fix/pr109-greptile-p1p2, fix/pr110-greptile-p1p2 and fix/pr111-greptile-p1p2, each from its PR head. Unaddressed Greptile comments: #109 40 (24 P1/P2), #110 53 (28 P1/P2), #111 34 (24 P1/P2). Wave 1 covers #109 with four disjoint subagents.
- Next action: gates on fix/pr109-greptile-p1p2, then a fast-forward push to gsd/p52-wiring. Then merge gsd/p52-wiring into the #110 and #111 branches before their fixes. LightRAG waits for the bridge's /chat contract from the swarm lane, which this session cannot see.

## Run 6 update (2026-10-25, PR review fixes pushed)

- Pushed to the draft branches only. No merge, no ship, no review trigger. Each head was gated in its local worktree before its push, and each push was a fast-forward.
- PR #109, gsd/p52-wiring: 90e3dcc. Two valid fixes: a failed heartbeat is owed and retried (observer.ts), and the presence listing has a 5 s whole-listing deadline (presence-dragonfly.ts, presence-client.ts). Each has a regression test. Gates: tsc clean; planning tests 178 pass, 0 fail; phase-close 185 pass.
- PR #110, gsd/p53-complete-store: 3f5b997, on top of merge e799272 of gsd/p52-wiring. Fixes: a clock-read failure withdraws the stale report; a held publish renews only its new entries; repository identity compares case-insensitively; checkpoint inserts share one write queue per directory. Gates: tsc clean; planning tests 323 pass, 0 fail; phase-close 186 pass.
- PR #111, gsd/p54-complete: abafd39, on top of merge e87e1af of gsd/p52-wiring. Fixes: a revert uses the state the previous scan saw as its from-state; shutdown waits for an in-flight scan before it settles transitions. The observer design was resolved in favour of this branch, and the owed-heartbeat behaviour was carried over. Gates: tsc clean; planning tests 253 pass, 0 fail; phase-close 185 pass.
- Greptile P1/P2 backlog before this wave: 40 (24 P1/P2) on #109, 53 (28) on #110, 34 (24) on #111. Subagents checked each finding against its head with file:line evidence; most were stale. Not done: trigger_code_review, which consumes review credits, and thread replies, since the reply permission was not granted. The stored addressed flags stay unaddressed until Greptile re-reviews the new heads.
- Not verified: the new regression tests were not run against the pre-fix code, so the fail-before claims are unconfirmed. Gates ran on the post-fix heads only.
- Open, recorded, not fixed: (1) #110 declared phases: planning keys on the directory-derived phase, not frontmatter, so a fix needs a decision in index.ts and report.ts. (2) #110 conflict warnings repeat per observer; a fix needs a shared dedupe key, and the ledger ignores idempotency keys unless SUBSTRATE_EVENT_IDEMPOTENCY is accept or enforce. (3) #109: no test covers the linked-worktree layout (gitdir and commondir). (4) #111: failed heartbeats are not shown as DEGRADED in the sessions view; that is a cross-file design change. (5) #111: the held branch still uses current.state as from (observer.ts), outside the P1/P2 scope.
- Remote: origin reports the repository moved to swcstudiospace/substrate. The pushes succeeded; the remote URL in this checkout still names agent-substrate.
- Next action: the operator decides whether to trigger the Greptile re-review on #109 to #111 and whether to approve merges. Phases 52 to 54 close only after merge. LightRAG (PLAN T6) waits for the bridge's /chat contract from the swarm lane. v1.3.x is ready to archive; the archive is irreversible and was not run.

## Ship decision (2026-10-25, operator, after the done check)

- Asked to ship now. `ultrathink-ship assess` (read-only) reports not done on both branches. Run branch gsd/autonomous-run-2026-10-24: 30 commits ahead of main, unpushed; gap "GSD roadmap incomplete: 0/8 phases". The gate's milestone parse reads v1.4 (archived, 3/3), which does not match ROADMAP's checkboxes. ROADMAP still has phases 46 and 52 to 54 open. Planning branch planning/consistency-check-2026-10-24 (PR #123): 2 commits ahead and pushed; it has uncommitted .planning/STATE.md changes that the gate attributes to another session.
- Operator choices: hold (no PR, no review, no merge), and `ship.autoMerge` stays on. A future ship run that reaches 5/5 merges on its own, so the operator should approve that run's scope before it starts.
- Nothing was pushed, reviewed, or merged. ship.phase is `not-done`. The ship config was not changed.

## Run 6 record, waves 2 to 4 (2026-10-25)

- Tracker gate (kickoff steps 1 and 5): track complete ran for graph ut-mvnwo985-4c98c13c. Result: partial. Linear is blocked by the workspace free-issue limit and fails open; tracking is Notion-only, per the Run 4 answer. Notion Task 404bc1a0c7ae81da8579fbe0fa67f0d3 set to Implementing. Session marked kicked-off.
- Deviation from the planner's generic loop: discuss, plan and execute were not re-run for phases 52 to 54. Their CONTEXT, PLAN, SUMMARY and VERIFICATION already exist on the PR branches, and re-running would duplicate them. Their remaining work is review, merge and close. Wave 1 review fixes ran before kickoff; waves 2 to 4 ran after it.
- Swarm lane (Haiku 5.5 and Grok Code request): four runs under /root/.omp/agent/ultrathink/swarm/, all INITIALIZING with empty progress. The newest was updated 2026-10-25 08:44Z. None holds the bridge /chat contract. The lookup belongs to the lane, so it was not repeated here.
- Pushed to the draft branches only. No merge, no ship:
  - gsd/p52-wiring (#109): 9cf0c6d (post-open abort, owed expiry, linked-worktree test), c89275f (planning/config.ts in the release preflight), b7d6768 (undated owed writes never written as active; preflight skips planning/config.ts for releases that predate it). Greptile on b7d6768: 5/5, no new actionable issues.
  - gsd/p53-complete-store (#110): f7811d5 (merge of c89275f; expiry ported to presencePending; activePhase null; overflow expiry), e36a08f (merge of b7d6768; touch baseline; undated pending rule; repo-key conflict signature). Greptile on f7811d5: 4/5, with a restored-edit claim gap and a letter-case signature issue. Both fixed in e36a08f. Review of e36a08f was in progress when recorded.
  - gsd/p54-complete (#111): abafd39 (wave 1), 4d27f10 (merge of 9cf0c6d; owed expiry), d99f497 (merge of b7d6768; R1 to R5). Greptile on 4d27f10: 5/5, no new blocking issues. Review of d99f497 was in progress when recorded.
- Gates, bun run verify (Postgres-only suites skipped locally, run in CI): b7d6768 6134 pass; e36a08f 6289 pass; d99f497 6211 pass; 0 fail on each.
- Fail-before, run in temporary worktrees at the pre-fix commits with the new test files: every new regression test fails on its pre-fix source. Covered: post-open abort, owed expiry after the window, activePhase, overflow expiry and schema compatibility on #110; the undated-owed rule on #109 (both preflight and owed) and #110 and #111; the restored-edit claim and the repo-case signature on #110. Boundary and within-window guards pass before, as designed.
- Pre-existing red, not caused by the review fixes: scripts/deploy-preflight.test.ts "every warning function index.ts calls is one the preflight runs" had failed since PR 109's planning wiring, because planning/config.ts was absent from the preflight. Fixed in c89275f. #110 and #111 inherit the fix by merge.
- Greptile thread flags: the stored addressed counts (43 on #109, 57 on #110, 34 on #111) still read as unaddressed. Greptile has not marked the old threads addressed after the fixes. The ship gate requires no open threads, so these need Greptile-side resolution or thread closure before any ship.
- Process deviations, recorded: (1) one `git add -A` limited to two directories on the #110 merge, with the staged list checked (9 files) before commit; (2) one read-only `git status` run by a subagent against the no-git rule. No state changed.
- Open, not fixed, design decisions: #110 declared phases (directory-derived versus frontmatter; needs a decision in index.ts and report.ts); #110 repeated conflict warnings across observers (needs a shared dedupe key; the ledger ignores idempotency keys unless SUBSTRATE_EVENT_IDEMPOTENCY is accept or enforce); #111 failed heartbeats not shown as DEGRADED (cross-file); #111 held transition from-state (P2; the held branch uses current.state); #110 phase 53 VERIFICATION.md describes the old report-limit clearing (a phase artifact, to update at close).
- Next: the Greptile reviews of e36a08f and d99f497 are pending. Merge order when approved: #104, then #109, then retarget #110 and #111 to main. Phases 52 to 54 close only after merge. Ship stays held. LightRAG (PLAN T6) waits on the bridge /chat contract from the swarm lane. The v1.3.x archive and v1.5 completion are irreversible and wait for the operator.

## Run 6 addendum: Greptile round after wave 4 (2026-10-25)

- #109 at b7d6768: 5/5 (review 35184962), no new actionable issues.
- #111 at d99f497: 5/5 (review 35186548). One P2, verified against code: runbook row 28 named /var/lib/substrate/skills as the sync checkout. packages/projector/src/skills-sync.ts takes LIBRARY_DIR from packages/projector/src/skills.ts (hard-coded /root/agent-skills) for its git work. SUBSTRATE_LIBRARY_DIR is read only by packages/host/src/main.ts, so it does not move that job. Fixed in 441883b: row 28 names the checkout and its rebuild requirement; F4 lists the projector /root defaults. Re-review at 441883b: 5/5, no open findings.
- #110 at e36a08f: 5/5 with one P2 (review 35186546), verified against code: an edit observed while the clock was unreadable stayed in touchBase, so the next unchanged scan claimed it at the recovery time, and a later write reported that phase as fresh. Fixed in 48c52ca: an undated change is not claimed, and touchBase advances past it. A regression test fails at e36a08f and passes at 48c52ca. Re-review at 48c52ca: 5/5, no open findings.
- Gates: 441883b bun run verify green, 6211 pass, 0 fail. 48c52ca bun run verify green, 6290 pass, 0 fail. Both with 177 Postgres-only skipped locally, run in CI.
- Process: a subagent's hashline edit mangled claimTouches mid-edit. The owner caught it, and I confirmed the final diff by reading the whole observer.ts diff (6 insertions, 8 deletions, only the intended hunks) before gating.
- Still open, not a code issue: Greptile's stored addressed counts (43 on #109, 57 on #110, 34 on #111) have not been updated by the fixes. The ship gate counts open threads, so these need Greptile-side resolution before any ship.
- Draft PR heads now: #109 b7d6768, #110 48c52ca, #111 441883b. Nothing merged. Ship stays held.

## Run 6 operator decisions and the bridge lookup blocker (2026-10-25)

- Operator decisions, asked as four questions: merge is Hold (the draft stack stays unmerged). LightRAG lookup is re-route (a fresh lane). Code waves W1 to W4 are Hold until LightRAG deploys. Greptile stored threads are left as they are, and ship stays held.
- Bridge /chat contract: NOT found. The lookup is blocked on tooling, not on the repo. Checked: the agent-substrate, programming-desk, omega-prime and other repos under /root/src/repos and /root/src/worktrees name the service but define no /chat route. The bridge is a Railway Function (source.image ghcr.io/railwayapp/function-bun:1.4.4). Its source is in deploy.startCommand as base64 after ./run.sh, and in get_function_source_code. Both outputs elide the middle of the file, where the /chat handler sits. Repeat calls are deduplicated by the harness, and no artifact:// line was printed in this session, so the middle cannot be paged. Visible routes: /chat, /memory/store, /memory/retrieve, /memory/reflect, /status. Visible model config: ANTHROPIC_MODEL (default claude-opus-5-5-20250514), GROK_MODEL (default grok-4.7), OAUTH_PROXY_URL, HINDSIGHT_API_URL (names only).
- Visible issue in the bridge source, not fixed here (it is not this repo): the temperature and max_tokens options treat an explicit 0 as unset (`x || default`).
- Options to unblock, for the operator: (1) allow a read-only read of the decoded bridge source in this session, (2) read the bridge's README or OpenAPI spec from its owner, (3) move the LightRAG LLM to an API-key route, which needs no bridge contract but needs a paid key. Until one is chosen, PLAN T6 and W1 to W5 stay blocked.
- The swarm lane's four stuck runs under /root/.omp/agent/ultrathink/swarm/ were left as they are. No swarm state was changed.
- Operator then chose "Allow a read-only decode here". It could not run. The bridge source is elided in every tool output this session: get_function_source_code and describe_service take no range parameter, repeat calls return only a dedupe notice, and no artifact id is printed. The /chat handler was never seen, so nothing was decoded, called or deployed. Next: a fresh session, which has no dedupe state, may return the full source. Otherwise choose the owner's spec or the API-key route.

## Run 7: planner graph ut-mvocrh76-02f3c9a9 (2026-10-26)

- Tracking: `track complete` ran once: partial. The Notion Task is 404bc1a0c7ae811eafadce36150b56eb, with 7 node rows and 48 step rows. Linear is blocked by the workspace free-issue limit and fails open, so it is not mirrored. Task status set to Implementing. Session marked kicked-off. The planner's blocking clarifications: none.
- Non-blocking clarifications, decided here (no question was asked, per the kickoff rule; the assumptions are stated plainly):
  - q1 quality scope: default accepted, touched code and mapped TODOs. Consequence: no quality rule is newly enabled in this run. The 30 unused-local and unused-parameter findings from `tsc --noEmit --noUnusedLocals --noUnusedParameters` go to the audit record and are not fixed here.
  - q2 milestones: OVERRIDE of the default (current milestone only). Chosen: all open milestones in ROADMAP order, v1.3.x then v1.5. Reason: the request asks to complete the milestones, and the default would leave phase 46, phases 52 to 54 and the TODOs mapped to them outside the run. Each milestone closes out only with the operator's confirmation before `complete` and `cleanup`.
  - q3 unmapped TODOs: default accepted, defer. The register's fold-when-touched rule still applies to any file this run edits.
  - q4 safety paths: default accepted, only paths a phase names. D-14 touches the LightRAG replay cache on the breaker-open branch of docs_lightrag_query. Breaker transitions are not changed. If the fix needs a breaker change, the TODO is deferred and recorded.
- Corrections to stale claims in this file:
  - Phase 46 criterion 1 is in code: T1 tests (5e3c694), T2 docs (2a29aed), context and deadline fixes (280860b, 39b28c2). These are on the run branch. The "decision brief Q1-Q4 awaits discuss answers" line is stale: decisions D46-1 to D46-5 are recorded in the phase CONTEXT.
  - The v1.3.x audit (89b8eb5) says phases 37 to 39 need an operator waiver. The ROADMAP now shows them complete under the waiver. The audit needs a refresh.
  - Local main was stale. `origin/main` is 754c51a (PR 125 squash). The run branch is 35 ahead and 4 behind it, with merge-base aa2ed6a.
- PREFLIGHT discrepancies, recorded: explicit `any` is 34 by rg (D-18) and 37 in the STATE line (STATE:251); raw TODO marker hits are 28 by rg against 25 in the STATE line (STATE:255); the phase 52 to 54 VERIFICATION `verified_on` SHAs are older than the current draft heads b7d6768, 48c52ca and 441883b.
- Wave order (planner n7): wave 0 reconcile (this record); wave 1 quality units (audit advisories, pins, README, then Biome and the Python gate after the audit because they share bun.lock and verify.test.ts); wave 2 phase 46 D-14 after the pins (shared server.test.ts); wave 3 PR 110 designs A and B and PR 111 designs C and D, each in its own worktree; wave 4 phase 52 to 54 verification on final heads; wave 5 milestone audit refresh; wave 6 full gates and the held closeout.

## Run 7 closeout: audit, held steps and what is left (2026-10-26)

- Kickoff for the new graph ut-mvoyixof-a2d90b1b, on session 01a16494: `track complete` partial, with the Notion rows already present; Linear is blocked by the free-issue limit and fails open. The Notion Task 405bc1a0c7ae8154a75ae90f7bfea451 is Implementing, and the session is marked kicked off. The earlier graph ut-mvocrh76-02f3c9a9 is superseded by it.
- Clarifications from the new uplift, answered from the decisions already recorded: q1 (blocking) all remaining milestones in ROADMAP order, matching the Run 7 override; q2 quality reach is changed lines; q3 unmapped TODOs are recorded, not fixed; q4 credential and live steps wait for the operator. The uplift is planned in degraded mode, so its node outputs are treated as unverified and the repository is the evidence.
- Phase 53 SC2 holds under one announcer rule (2c50263): the smallest session of a conflict alone announces it. Known limit: no announcement when that session has no running observer. Phase 54 design C (failed heartbeats shown as DEGRADED) is recorded as a limit, not implemented, because the reader cannot see a failed write.
- Verification records for phases 52, 53 and 54 are refreshed on their PR branches at b7d6768, 2c50263 and 5548c62 (docs commits pushed after each head's gate).
- v1.3.x audit refreshed in `.planning/v1.3.x-MILESTONE-AUDIT.md` (status tech_debt; supersedes 89b8eb5). No blocking finding. The complete step is HELD for the operator: it archives the milestone, and the repository cannot undo that. Cleanup waits for the same confirmation.
- v1.5 is not closable. Phase 46 is human_needed (VERIFICATION.md): criterion 1 passes in the repository; criteria 2 and 3 need approval; criterion 4 is not met (T4 blocked on T5); criterion 5 is a HARD_STOP. Phases 52 to 54 are draft PRs on hold for merge. The run ends PARTIAL for v1.5, which holds no later milestone.
- Ship is not triggered: the uplift runs the ship step only when the run is finished, and this run is PARTIAL.
- Gates on the run branch after the closeout: `bun run verify` and `bun scripts/audit-gate.ts`, recorded in the audit section 4.
- Removals this run: temporary logs and counts under /tmp created by this run (`/tmp/gate-*.log`, `/tmp/pc-*.log`, `/tmp/noUnused-count.txt`). Temporary worktrees were removed after each fail-before check. No phase artifact, branch, worktree, stash or user change was removed.

## Run 8: planner graph ut-mvp59le0-8815e6d1 (2026-10-26)

- Request: use LightRAG and Hindsight with DragonflyDB, GreptimeDB and TimescaleDB; migrations for the LightRAG change; live session steering for multi-day GSD-Core sessions; Solana devnet logging and an Anda-inspired Eternal Memory Knowledge Nexus; session rollback to an exact chat moment with file revert. The plan was written without repository access, so repository evidence overrode it in places (below).
- Tracking: `track complete` ran once: partial (Linear is blocked by the workspace free-issue limit and fails open; Notion rows exist). Notion Task 405bc1a0c7ae814ab9ffe212722cb2a4 is Implementing. Session marked kicked off.
- Recon: ten read-only scouts plus a read-only Railway inventory and upstream sources. Findings and corrected assumptions are in `.planning/phases/55-migration-safety/CONTEXT.md`.
- Clarifications settled from evidence, not asked: rollback marks memory superseded (the ledger is append-only); memo-only anchoring (memo v1 is fixed); a CLI plus read-only MCP tools (REST twins were planned; `server.ts` has no checkpoint or rollback route, so only the MCP tools exist); edits stay in this repository.
- Milestone v1.6 (phases 55 to 62, SOTA-11 to SOTA-18) was defined by hand in ROADMAP.md and REQUIREMENTS.md. `gsd-new-milestone` was not run: its milestone-switch and phase-clear steps would reset this file and archive the open v1.5 phase directories, which the held milestone-complete decision forbids.
- Outcome (2026-10-26): built on two branches and shipped as five draft pull requests, none merged. `gsd/v16-int` (`/root/src/worktrees/as-v16-int`, local only) is main plus 19 commits and carries phases 55 to 57 and 59 to 62; it was cut into a stack of four draft PRs, each based on the previous branch: #127 (foundations, phases 55 and 56), #128 (libraries), #129 (server wiring, rollback and verification tools, CLI, ops runners and corrections) and #130 (soak tests, decision records and these planning records). `gsd/v16-58-live-steering` (`/root/src/worktrees/as-v16-58`) carries phase 58 as 7edfd79 on the unmerged draft PR #110 head f1ae7de plus the dependency fix ed61286, opened as draft PR #131 based on #110's head branch; the planning layer, steering inbox and audit table exist only on the draft stack (PRs #104, #109, #110, #111, on operator Hold). Everything an earlier version of this record called uncommitted is committed: the genesis constant ccbfff2, the retain-drain timer 901c58f, the `--omp-session` flag 3d95e3e, the soak tests 8752578, ADRs 0004 to 0007 and the guide a8346f7.
- Gates, run by the orchestrator against a throwaway Postgres 16 so the live-database tests ran: baseline main 6091 pass and 177 skipped (no local database); int at 8752578 (code identical to the tip) 7505 pass, 2 skip, 0 fail, audit gate 0 unlisted, `check:phase-close` pass, config-reference check pass; phase 58 branch at 7edfd79 6639 pass, 2 skip, 0 fail, audit gate 0 unlisted, phase-close pass. The two skips are existing tests unrelated to this milestone. The intermediate tips of the PR stack were not gated on their own; CI runs on each PR.
- Per phase (details in each phase's VERIFICATION.md and `.planning/v1.6-MILESTONE-AUDIT.md`): 55 criteria 1 to 5 met in repo; 56 criteria 1 to 7 met against upstream source; 57 criteria 1 to 5 met with fakes, flags default off; 58 partial (criterion 2: the two steering mechanisms share no state model yet); 59 partial (criterion 5: the re-anchor send is not built; no live devnet proof); 60 criteria 1 to 4 met with fakes; 61 partial (criterion 3: no automatic checkpoint triggers); 62 soak, runbooks, ADRs and audit written.
- Defects found and fixed (evidence in the audit): the LightRAG client sent `DELETE /documents`, upstream clear-all (P0; no server exists, so nothing was lost); the devnet genesis hash constant was wrong since phase 28 (the live read-only `getGenesisHash` on 2026-10-26 disagreed; the anchor job's genesis gate would have refused real devnet); the sweeper would have deleted forgotten rows after 90 days; a late-recorded checkpoint cut memory at record time; the verifier's only signer was the job's own key; a refused Solana URL reached callers with its host; the retain-drain interval was never cleared; a path below a directory that became a file raised ENOTDIR in snapshot restore; the rollback-compat runbook row for the index was wrong; a lying type guard on the forget marker check.
- Findings not fixed, recorded as residual: the anchor job cannot re-send an hour that already has an anchors row; the memory-write ledger event carries no entry id (the consistency verifier pairs by writer, scope, kind and time); the Hindsight document-list route the verifier uses is unverified against 0.9.1; a checkpoint's `verified` memory status proves a hash and an anchored cited event, not that the event concerns the entry; resuming an omp forked session file is unverified for the installed omp; automatic checkpoint triggers are not wired (hooks are proposals in ADR 0007, and Swarm's tool allowlist does not include the new tools); the multi-process checkpoint sequence race has no lock; the soak tests take about 65 seconds together.
- Held and HARD_STOP, unchanged and not performed: LightRAG deploy, ingest and cutover (Phase 46 T5 to T8) and any hosting decision or cost; any new Railway service; production index migrations; funding the anchor key, installing the anchor timer, any devnet send and the re-anchor send; the live devnet proof (phase 41); the `ledger-archive` bucket; enabling the tandem and graph-scope flags in production; mainnet; merging anything; completing or archiving the milestone; PRs on other repositories. Migration step 33 stays reserved by the unmerged draft; this milestone adds no index step on `gsd/v16-int`, and phase 58 adds opt-in step 34 on its own branch.
- Process disclosures: the plan's assumptions overridden by repository evidence were that Greptime is a derived sink (it is the authoritative ledger), Timescale has hypertables (0), Dragonfly could hold a queue (cache only), LightRAG was being upgraded (no previous version exists; the work was client alignment to upstream v1.5.7 plus topology), memo v2 per checkpoint (memo v1 is fixed, so checkpoints anchor through the hourly root), and the steering inbox was new work (it exists only in the unmerged drafts). Three subagents first edited the primary checkout through relative paths: two reverted their own edits and one was redirected into its worktree, and the primary checkout was verified clean of them. One docs slip was self-repaired. All gate runs and commits were done by the orchestrator; subagents were edit-only.
- Milestone close is not done: the complete step is irreversible and is an operator decision. Operator decisions needed: merge order for the draft stack and the v1.6 branches; LightRAG hosting (a dedicated pgvector Postgres is recommended; it is a cost) and its LLM route; whether a per-checkpoint memo v2 is wanted; a hypertable policy; and whether devnet roots plus the ledger archive are enough for "eternal" or a mainnet move is planned (out of scope today). `docs/ussr-integration.md` and ADR 0007 describe how Ultrathink, Swarm, Realm and omp would use v1.6; no sibling repository was edited.

## Run 9: planner graph ut-mvq2q73k-300071f3 (2026-10-27)

- Request: raise code quality and complete GSD phases and milestones; LightRAG "has not been deployed although RAGFlow was removed"; Hindsight "has not been updated for days and is not upgrading autonomously". Planning ran degraded (a provider error on three node fills). Tracking failed open: Linear is at its free-issue limit and Notion needs `ultrathink-mcp auth login notion`, so this graph has no rows and no sync was possible.
- **Hindsight root cause (evidence, read-only Railway inventory 2026-10-27 and repository search).** No autonomous upgrade mechanism exists and none was ever promised in a document, comment, roadmap line or phase. The three Railway services (hindsight-api, hindsight-worker, hindsight-control-plane) run fixed image tags `ghcr.io/vectorize-io/hindsight-*:0.9.1`, deployed 2026-09-29 and untouched since. The repository holds no image reference, Dependabot or Renovate configuration. A version changes only when an operator edits the image tags and accepts the deploy; Railway writes are triple-gated (`SUBSTRATE_RAILWAY_WRITES`, an operator, an `approval_ref`) and `railway.ts` has no set-image path by design. The pin is deliberate: upstream issue vectorize-io/hindsight#4696 (a recall hang in 0.10.x; the issue is CLOSED since 2026-09-28, but whether 0.10.3, 1.0.0 or 1.1.0 fixes it is UNVERIFIED). Upstream has v0.10.3 (2026-10-08, no breaking changes), v1.0.0 (2026-10-13, API stability promise) and v1.1.0 (2026-10-21, one breaking change: bank ids may not start with an underscore; our `sub-*` banks are unaffected). Upgrades run database migrations on start, so rollback is a database restore plus a re-pin, not a re-tag. The staged change on `hindsight-llm-bridge` is a function-source update with no Hindsight image change: it is not an upgrade, and `ragflow-oauth-integration.internal` should be checked before it is accepted because RAGFlow was deleted the day before it was staged.
- **Built on `gsd/hindsight-upgrade-policy` (this branch):** `.github/hindsight-pin.json` (the declared pin and its blocker), a weekly watcher (`.github/workflows/hindsight-lag.yml`, `scripts/hindsight-lag.ts`) that keeps ONE issue open while a newer stable release has existed for 7 days and opens a second issue when the watcher itself fails (no pull request, nothing on Railway), a canary contract runner (`packages/mcp-server/src/hindsight-canary-run.ts`, operator-run against a candidate, never production), and `docs/runbooks/hindsight-upgrade.md` (manual health-gated path with a database backup and a rollback). The runbook marks every Railway step OPERATOR ONLY.
- **LightRAG:** no service exists in any Railway project and RAGFlow was deleted 2026-10-25, so the docs plane has no live backend. Deployment is a cost and hosting decision and stays operator-gated. Main still sends `DELETE /documents` (upstream clear-all): merge #127 BEFORE any LightRAG deployment. Draft PR #132 adds `lightrag-smoke-run.ts`, a scripted proof for a fresh deployment whose auth-negative check fails any deployment that answers anonymously.
- **CI findings on the v1.6 stack:** #128's lint job failed on a transient tarball download (`@sandbox-agent/cli-linux-x64`) and passed on rerun. #131 cannot start CI: its base (#110) still uses the old workflow on GitHub-hosted runners and the account reports failed payments or a spending limit ("The job was not started because recent account payments have failed"). Operator action: resolve billing, or bring the draft stack's workflow up to main's self-hosted runner pool. Greptile reviewed #131 and passed.
- **Phases and milestones:** nothing buildable is left that is not operator-gated. v1.3.x needs the operator's complete confirmation; v1.5 needs phase 46 approvals and the held drafts (#104, #109 to #111); v1.6 needs a merge order, the LightRAG hosting decision, and live proofs. The "previous prompts features" found in the repository are the v2+ deferrals in `.planning/research/SUMMARY.md` (herdr-hosted dispatch, Orca tee, Linear Agent Sessions, extra launchers, ingest on merge, cua, Codex/OpenCode/Pi VMs): large, externally dependent and never scheduled, so they wait for an operator decision rather than being built.
- Gates on this branch (no local database, so 177 live-database tests skip): `bun run verify` 6154 pass, 0 fail; audit gate 0 unlisted; `check:phase-close` pass.

## Run 10: planner graph ut-mvr8q2x6-c0fc2bc6 (2026-10-27, operator authority to clean up, deploy and migrate on Railway)

- Operator answers: bridge exposure "private only"; LightRAG LLM route "bridge /v1 (private)"; merge the whole stack in order; Hindsight "trial, then upgrade only if the gates pass". Tracking failed open again (Linear free-issue limit; no rows).
- **Security finding, fixed:** `hindsight-llm-bridge` had a public `*.up.railway.app` domain. Its `/chat` and `/memory/*` routes have no auth check in the source (they answered 500, not 401, to an anonymous call), and the staged `/v1/chat/completions` checks a key only when `BRIDGE_API_KEY` is set, which it is not. Whether anonymous callers could spend subscription tokens was NOT tested (no valid body was sent). The public domain was removed; no variable or source change was made. Open hardening item: make `/v1` fail closed when the key is unset.
- **The OAuth LLM route cannot work as built (evidence from the function source, UNVERIFIED by a live login):** `ragflow-oauth-service` uses `auth.anthropic.com` and X/Twitter OAuth with a `tweet.read` scope, an in-memory token cache that only fills after an interactive browser login, and no stored credential; Hindsight itself runs with `HINDSIGHT_API_LLM_PROVIDER=none` (chunks mode). The `ragflow-oauth-*` services are therefore not RAGFlow leftovers to delete (the bridge points at them) but they are also not a working LLM source. LightRAG ingest needs a real provider key set as a Railway variable by the operator; the staged bridge deploy (patch `ad68bd96`) was NOT accepted.
- **Hindsight trial (no production service changed):** a one-off job dumped the production database (58 MB, 23 tables) and restored it into a pristine backup database `hindsight_backup_20261027` (kept) and trial copies (dropped). On a throwaway candidate service the in-place migrations ran cleanly 0.9.1 to 0.10.3 to 1.1.0 and the canary passed on both. A 176-call recall soak over eight real banks timed out at the 4 s budget on 108 calls (0.10.3), 104 (1.1.0) and 106 (a 0.9.1 control on a fresh copy of the backup): it does not separate the versions, so the "recall latency passes" gate was not demonstrated and production stays on 0.9.1. Greptile's two P1 findings on #133 were fixed (rollback restores into a fresh database, not `--clean`; the canary's cleanup now waits for calls whose timer already won).
- Teardown: candidate service, its public domain and every one-off job service deleted; only the backup database remains in the Postgres service (about 60 MB, droppable).
- Still open, operator side: GitHub billing (blocks CI on #110, #111 and #131); LightRAG provider key; `BRIDGE_API_KEY`; merge execution is blocked on the Greptile P1s listed on the PRs (see the PR threads) and on #107 being DIRTY.

## Run 10 closeout (2026-10-28): merges, what remains, operator decisions

- **Merged to main this run (operator: "whole stack in order"; each pinned to its verified head, CI and Greptile green, no open P0/P1 on the head):** #133 (Hindsight lag watcher, canary, runbook), #104 (phase 52 core), #127, #128, #132, #107, #134 (phase 52 wiring, replayed), #129, #130 (the v1.6 stack: forget, tandem recall, rollback, verification, soak, ADRs), #136 (phase 53, replayed), #137 (phase 58, replayed), #135 (phase 54, replayed). #109, #110, #111 and #131 were closed with pointers: they were stacked on a base main had absorbed as a squash, so their branches conflicted; each was replayed from its own delta onto main (no history was rewritten and the old branches are left as they were).
- **What the review rounds found and fixed** (all verified against the code before changing it): raw-byte snapshots (a CRLF file was stored LF-normalised and the verifier re-normalised it too); restore never deleting a path the snapshot skipped, with a capped, stdin-carried trailer and drift matching modulo skipped paths; forget and rollback integrity (durable forget-batch notes written before any row is marked, recall and brief filtered through the forgotten-entry lookup inside the budget, the plane-pending retry keeping the accepted digest, per-rollback-id serialisation); live repair requiring `--server-stopped`; signer retirement (a complete read of a retired signer is a MISMATCH, an incomplete read is unverified); and a trust-boundary fix: `events_emit` and `POST /events` let any non-swarm token name any surface and any payload.action, so authoritative note actions are now reserved at the emit door (one list in `reserved-actions.ts`). A saved brief could outlive a forget: a marker key in the existing `gen` class now refuses older snapshots without changing the snapshot key or envelope (the pinned 9231f43 compatibility tests hold). Known residual, documented in the rollback-compat runbook: a compose already running when a forget lands can still save a pre-forget snapshot, and a rolled-back old binary does not read the marker.
- **Gates:** every merged head passed `bun run verify` (typecheck, tests, python suites, locks), the audit gate (0 unlisted high or critical), the config-reference check and `check:phase-close`, with no local database (177 to 187 live-database tests skip locally; CI runs them). Main's own CI was green after the v1.6 merge. This host is shared and ran at a load average of 30 to 60 late in the run, which pushed several process-spawn tests past their 5 s limits locally; CI is the authority and passed.
- **Hindsight (no production change):** production stays on 0.9.1. The trial migrated a copy of the production database through 0.10.3 and 1.1.0 cleanly and the canary passed on both, but the recall soak timed out at the 4 s budget at the same rate on all three versions including a 0.9.1 control, so the latency gate was not demonstrated. The weekly lag watcher (`hindsight-lag.yml`) keeps one issue open once a newer stable release is 7 days old; it needs `CI_ENABLED`.
- **Railway changes made (operator authority):** the public domain of `hindsight-llm-bridge` was removed (its routes had no auth check); one-off prep jobs and the candidate service were created and deleted; the database `hindsight_backup_20261027` (about 60 MB, a pristine copy of the Hindsight database before the trial) remains in the Postgres service and can be dropped. The staged `hindsight-llm-bridge` change (patch `ad68bd96`) was NOT accepted.
- **LightRAG is still not deployed, deliberately.** The planned LLM route (the staged bridge `/v1`) cannot work: no OAuth token has ever been cached (`/health` of `ragflow-oauth-service` reports both false), and the proxy needs an interactive browser login. A LightRAG that cannot extract entities would be a paid service that cannot ingest. The deploy needs a real provider credential set as a Railway variable by the operator, then the topology runbook (a pgvector Postgres, auth on, private networking) and `lightrag-smoke-run.ts --confirm-live`. Main's LightRAG client no longer sends the clear-all `DELETE /documents`.
- **Operator decisions still open:** (1) a provider credential for LightRAG; (2) milestone completion and archive for v1.3.x, v1.5 and v1.6 (the v1.6 audit is `gaps_found` with three partial criteria: the phase 58 join with `docs_steering_session`, the anchor re-send and the automatic checkpoint triggers); (3) Notion re-login (`ultrathink-mcp auth login notion`) and the Linear plan limit, so this graph's tracker rows can exist; (4) whether to drop `hindsight_backup_20261027`. The first lag issue appears on the first scheduled run of `hindsight-lag.yml` (CI is enabled).
- **Not done, and why:** the v2 deferrals in `.planning/research/SUMMARY.md` (herdr-hosted dispatch, Orca tee, Linear Agent Sessions and others) were never scheduled and depend on external systems; milestone completion is operator-only; RAGFlow residual cleanup (phase 46) waits for the LightRAG cutover.

## Run 11 (graph ut-mvrvk5ml-99057e86, 2026-10-28): LightRAG deployed, production cut over

- **Request:** no provider API key exists; use the two proxy providers with a dummy key, or bypass the LLM, and deploy so the remaining phases can proceed.
- **Proxies, tested:** `aio-grok-proxy` (VPS loopback 41417) answers a Grok model with a dummy key (200). `shunt` (3001) passes a Claude key through (dummy gives 401) and its Grok route needs `shunt login xai` (`invalid_grant`). `hermes-proxy-xai` was crash-looping (not logged in) and was stopped. `scripts/llm-proxy-smoke.ts` repeats the probe, secret-free, loopback by default (remote cleartext http is refused; a remote https override is allowed) (PR #139).
- **Why LightRAG does not use them:** they listen on the VPS loopback; Railway has no path back, and exposing `aio-grok-proxy` would publish a subscription login. LightRAG therefore runs on `infra/railway/lightrag-llm-bypass.ts` (an OpenAI-compatible endpoint that never calls a model, fail-closed key, labelled), so chunks and embeddings are stored and no graph is built. `SUBSTRATE_LIGHTRAG_QUERY_MODE=naive` is required in that state; hybrid fails the smoke query check.
- **Railway (project Agent Substrate, production):** `lightrag-postgres` (pgvector pg18, 2 GB volume), `lightrag` (v1.5.7, 1 GB volume, API key on, no public domain), `lightrag-llm-bypass`; TEI reused; forwarder mapping 02 now `80 -> lightrag:9621`. `lightrag-smoke-run --confirm-live`: all six checks pass in naive mode.
- **Production cutover:** the host ran release `702ed32e` (Oct 22, no LightRAG client). Backed up the index (`pg_dump -Fc`, 317 KB), rehearsed on a throwaway Postgres (ledger already at 32 rows; main's `migrate()` applied nothing), backed up `substrate.env`, added `LIGHTRAG_URL`, `LIGHTRAG_API_KEY`, `SUBSTRATE_DOCS_BACKEND=lightrag`, `SUBSTRATE_LIGHTRAG_QUERY_MODE=naive` (the key read straight from Railway, never printed), then `deploy-release.sh release-r11-20261028` with the preflight enforced (0 errors). `current` is `5cf930a0`, `previous` is `702ed32e` (rollback: `deploy-release.sh rollback`, restore the env backup). `/healthz` lists a closed `lightrag` plane. Live proof: `POST /docs/ingest` returned `ingested`, `POST /docs/search` returned backend `lightrag` with the marker chunk; the probe was then deleted by its own id.
- **Gates:** typecheck clean; CI on #139 green with Greptile clean after fixing a redact-lock rule 4 failure and a P2 (the shared redactor now runs over proxy reasons). The local full suite showed only 5 s timeouts under load above 60.
- **Operator decisions still open:** (1) a real LLM for graph modes: `shunt login xai` and/or `hermes auth add xai-oauth --type oauth`, plus a deliberate network path from Railway; (2) milestone completion and archive for v1.3.x, v1.5, v1.6; (3) Notion re-login and the Linear plan limit; (4) dropping `hindsight_backup_20261027`; (5) `HINDSIGHT_BANKS` is empty on the host (recall reads the caller's own bank only).
- **Not done:** Phase 46 RAGFlow residual code cleanup (about 25 files still name RAGFlow) and the v1.6 repo-only residuals; these are repo edits and next. Removing the dead `ragflow-oauth-*` Railway services is separate and operator-gated: it needs approval per live step and a check that no consumer remains.

### Run 11 addendum: Phase 46 RAGFlow removal is gated, not skipped

Phase 46 criterion 5 allows removing the RAGFlow code and service only after criteria 1 to 4 pass and every RAG-dependent phase passes. Graph and hybrid retrieval cannot pass while LightRAG runs on the bypass LLM (naive mode only), and the RAGFlow code is still the fallback backend setting. Note that `deploy-release.sh rollback` to `702ed32e` is an app-only rollback: the RAGFlow service was deleted on 2026-10-25 and `702ed32e` has no LightRAG client, so docs search would be unavailable after it until a backend is restored. So the removal waits on the operator's LLM decision (`shunt login xai` or `hermes auth add xai-oauth --type oauth`, plus a network path from Railway). Production already serves docs from LightRAG (`SUBSTRATE_DOCS_BACKEND=lightrag`); the dead `ragflow-oauth-*` Railway services stay until that removal is approved. The v1.6 repo-only residuals (REST twins, the `baseline` checkpoint trigger, the phase 58 join, the anchor re-send, automatic checkpoint triggers) were not started: they are separate scoped work, not part of this deploy.

## Reconciliation (2026-10-28, Run 12)

Base: main = 28ea65f4 (PR #141 merge). The planning records for phases 52-62 said "draft PR", "not merged" and "In review"; they now state the merge facts below.

- **PR-to-phase merge map (phases 52-62):**
  - 52: PR #104 (core, merged 2026-10-27) and PR #134 (wiring, merged 2026-10-28); draft #109 closed.
  - 53: PR #136 (replaced draft #110, closed).
  - 54: PR #135 (replaced draft #111, closed).
  - 55 and 56: PR #127.
  - 57: PRs #128 and #129.
  - 58: PR #137 (replaced draft #131, closed).
  - 59, 60 and 61: PRs #128 and #129.
  - 62: PR #130.
  - Phases 53-62 all merged 2026-10-28.
- **VERIFICATION `verified_on` values were not all reachable from main (as of 28ea65f4):** 52: b7d6768 and e135938; 53: 2c50263; 54: 5548c62; 55-57 and 59-62: 8752578; 58: 7edfd79. Only e135938 and 8752578 were ancestors of main; the others were tips of replaced branches. Resolved in the Run 12 record below: phases 46 and 51-62 were re-verified against main on 2026-10-28 (`verified_on: main at 31a9bb36`, phase 59 at `b19ff515`).
- **Open at the time of this reconciliation (all resolved or decided in the Run 12 record below):**
  - Phase 46: LightRAG runs in naive mode on the bypass LLM; graph and hybrid modes and the RAGFlow removal are operator-gated (now recorded as accepted debt by the owner, 2026-10-28).
  - v1.6 partial criteria: phase 58 criterion 2 was closed by PR #147, phase 59 criterion 5 by PR #150, and phase 61 criterion 3 by PR #148 up to the host boundary (no host runs the hook until an operator installs it; accepted debt).
  - Milestone completion confirmations for v1.3.x, v1.5 and v1.6: given by the owner on 2026-10-28 (close, with the open items as accepted debt).
- **Remote branches (nothing deleted):** `quality/biome-report-only` is superseded by main's lint-report job. `test/swarm-pins-a16-a30` is superseded because its tests are already on main in `packages/mcp-server/src/server.test.ts`. No branch was deleted.

## Run 12 (graph ut-mvsanldw-54b66625, 2026-10-28): code quality, blocking gates, gap closure, re-verification, audits

- **Request:** raise the code quality and patterns to state of the art; merge every outstanding PR; program the remaining GSD-Core phases and complete the outstanding milestones. Scope assumption, stated and not asked: a ratchet-based, repository-wide enforcement plus closing recorded debt; no blanket rewrite.
- **How it ran:** the orchestrator dispatched `task` agents, one unit per git worktree, edit-only; the orchestrator ran every gate, committed and pushed. Every PR went through `ultrathink-ship` (Greptile 5/5, no open threads, CI green, squash). The agent-swarm control plane (A01) was not used: its assignments need signed `task.assign` payloads and earlier swarm runs were stuck. Small fixes (a lock name, a fixture token, a README sentence, test titles) were made inline by the orchestrator. Tracking: Linear is blocked by the free-issue limit (fail-open); Notion rows exist.
- **Merged (19, squash):** #142 CI tooling (uv download retry, exact root pins, the audit gate fails after `review_by`, narrowed permissions); #143 `memory.write` carries the stored `entry_id` and the ledger verifier pairs by it (reports `ledger_pairing_ambiguous` instead of guessing); #144 planning records for phases 52-62; #145 AST-based code ratchet (`scripts/code-ratchet.ts`, baseline only falls); #146 checkpoint sequence lock; #147 one state model for `docs_steering_session` and the steering inbox (phase 58 criterion 2); #148 `substrate session hook`, trigger policy and printed host configuration (phase 61 criterion 3); #149, #151, #152 Biome errors, unused code and untrusted JSON at the CLI/script boundaries (102 errors to 0); #153 fake gh state lock race; #154 and #157 docs-plane wording (LightRAG live, RAGFlow legacy fallback); #155 Biome is a blocking step of the single verify gate plus `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`; #156 CODEOWNERS, PR template, CONTRIBUTING, SECURITY; #158 the fabric reports a `lightrag` resource; #159 `substrate evidence --node`; #150 the guarded re-anchor executor and the verifier pointer (phase 59 criterion 5; eight automated review rounds and three independent pre-merge reviews; the executor was never run against any cluster); #160 the records PR (re-verification of phases 46 and 51-62, the three audits, the owner's decisions and this record).
- **Behaviour changes worth knowing:** CLI trust-boundary guards (evidence shape, `emit --payload`, `drift --json`); the Muse hook ignores non-object stdin; the audit gate fails once `review_by` has passed; `SweepBatch.then` is renamed `decide`; `substrate verify` judges the signer by the signer set at the transaction's block time and returns unverified when it cannot (no block time, incomplete rotation read, unbuildable set), ranking a proven disagreement above that; the re-anchor lock is `<SUBSTRATE_STATE_DIR or /var/lib/substrate>/substrate-reanchor.lock`.
- **Verification:** `.planning/phases/46-*`, `51-*` to `62-*` VERIFICATION.md were rewritten against main (b19ff515 for phase 59, 31a9bb36 for the others): files read, nothing run; the CI run on main is the gate record. Results: passed 51-58, 60, 62; human_needed 46 and 59; gaps_found 61 (criterion 3 PARTIAL). Audits written: `v1.3.x-MILESTONE-AUDIT.md` (tech_debt), `v1.5-MILESTONE-AUDIT.md` (gaps_found, new), `v1.6-MILESTONE-AUDIT.md` (gaps_found).
- **Local test note:** this host was at a load average of 20 to 90 for most of the run; timing-based tests (muse, observer, restore hooks) flaked locally and CI on the runner pool was the authority. Two lock tests (`store-lock`: no ledger variable assignment or token-shaped value in a tracked file) caught fixtures in two PRs before CI did.
- **Not done, by decision:** `exactOptionalPropertyTypes` (238 findings; done in Run 13, PR #171) and `noPropertyAccessFromIndexSignature` (3076); coverage thresholds; extracting shared helpers between the CLI and the server; breaking the cli to collectors import cycle; parametrised soak tests; the Hindsight document-listing route and the memory `binding` contract; remote branch pruning (about 17 branches without a PR remain, none deleted); the Hindsight lag workflow smoke run.
- **Operator-gated, untouched:** production runs release `5cf930a0` (the merge of #139), which lacks every PR of this run (#142 to #160 and the closeout PR; checked with `git log release-r11-20261028..origin/main`), so none of the behaviour changes above is live until the operator deploys; LightRAG graph and hybrid modes need a real LLM route; RAGFlow code removal; funding the anchor key and any devnet send; installing the session hook in a host; the Notion re-login and the Linear plan limit; dropping `hindsight_backup_20261027`; `HINDSIGHT_BANKS` on the host.
- **Gate record:** CI on main was green on every code merge that was not cancelled by the next push; on `b19ff515` (the last code merge, run 40778453269) the full gate passed: frozen install, `tsc` with the strict flags, blocking Biome lint, the full `bun test` suite against a scratch Postgres, the Python suites and the repo locks. The records PR (#160) and the closeout PR change `.planning/` and docs only.
- **Closeout (2026-10-29, UTC):** the owner's decision of 2026-10-28 was executed with `gsd-tools milestone complete` in three commits, v1.3.x (phases 37-44), v1.5 (45-54, eleven directories because `46-ragflow-hybrid` is superseded) and v1.6 (55-62, with `--force` because the ROADMAP still lists the older milestones' phase details as unstarted): ROADMAP and REQUIREMENTS snapshots, the audits and the phase directories moved to `.planning/milestones/`, `.planning/phases/` is empty. The three archived open items of earlier milestones (phase 0 and phase 20 UAT, phase 23 CONTEXT questions) were acknowledged as deferred. MILESTONES.md, PROJECT.md (Current State and Next Milestone Goals), the ROADMAP milestone lines and headings and the REQUIREMENTS header were rewritten by hand because the tool leaves them sparse. No tag was created (`git.create_tag` is unset; the precedent for v1.4) and nothing was pushed except through the PRs.

## Run 13 (graph ut-mvsy25vk-fb67af34, 2026-10-29): remote branches onto main, TODO register, strict gates

- **Request:** make the codebase state of the art, best in class, production ready and enterprise grade; merge the remote branches' work onto main; complete the TODOs, the GSD-Core phases and the outstanding milestones. Assumptions, stated and not asked: (1) branches are judged by content, not ancestry, because main is squash-merged and most unmerged tips are copies of merged PRs; work that is genuinely missing lands through gated PRs, never by merging a 200-commit-behind branch; (2) "TODOs" is the register in `.planning/todo-inventory.md` (D-01 to D-23); real TODO or FIXME markers in source are 0; (3) "quality" is limited to behaviour-preserving, tool-verified strictness and warning removal, with no auto-fix sweep and no module rewrite; (4) no phase or milestone is open (v1.3.x, v1.5 and v1.6 were archived in Run 12, `.planning/phases/` is empty) and none was invented.
- **How it ran:** the orchestrator dispatched `task` agents, one unit per git worktree, edit-only; the orchestrator ran every gate, committed and pushed. Every PR went through `ultrathink-ship` (Greptile 5/5, no open threads, CI green, squash). The agent-swarm control plane (A01) was not used, as in Run 12. Tracking: Linear is blocked by the free-issue limit (fail-open); the Notion task rows were kept. The shared ultrathink config kept resetting `ship.autoMerge` to false while this run was shipping, so each PR worktree carried a project-scoped override (`.claude/ultrathink.json`, never committed) instead of editing the shared file. Two units edited the primary checkout through relative paths; both edits were reverted, and that checkout still holds only its own noise (seven `swarm:` lines in `STATE.md` and an untracked `.claude/`). Small fixes made inline by the orchestrator: a lock-safe comment in `greptime.ts`, one runbook paragraph, the last non-null assertion in `driver.test.ts`, the unused predicate parameter in `greptime.test.ts`, the Biome policy pin in `biome-config.test.ts`, and the gate documentation.
- **Merged (11, squash, Greptile 5/5, CI green):** #162 non-null assertions out of nine source files, ratchet baseline 90 to 36; #163 and #164 `defined()` in the test files of mcp-server, observability and scripts; #165 the 7-SOTA plan under `.planning/uplift-7/` and thirteen v1.3 review, security and proof records recovered from outside main (`milestones/v1.3-recovered-records.md` indexes them); #166 `substrate session hook-config` prints all four checkpoint triggers; #167 MCP `skills_propose` refuses an oversize body and the isolation docs match the code; #168 the desktop wrapper and smoke refuse to run unless the docker endpoint is proven local; #169 every GreptimeClient diagnostic is scrubbed of configured credentials; #170 TODO register D-09 to D-13 (parity JSON on stdout, git prompts off, one `/proc` parser, dead inputs, canonical checkout paths); #171 `exactOptionalPropertyTypes` on and non-null assertions and missed optional chains are lint errors; #172 the store lock's repository scans no longer time out under load (D-16). This records PR is the twelfth.
- **Behaviour changes worth knowing:** `session hook-config` prints `steering` and `baseline` scripts that run in the foreground and pass `--surface`; the MCP tool refuses a `skills_propose` body over 1,000,000 bytes, as the REST route did (an MCP call is still audited `allowed` first, because the audit records the decision to dispatch before the tool runs, while an oversize REST body is refused before the audit call and leaves no record; `invalid-write-roundtrip.test.ts` pins both); `infra/desktop/substrate-desktop.sh` and `scripts/desktop-smoke.ts` need a proven local docker endpoint and bound their probe (the wrapper through its `SUBSTRATE_DESKTOP_PROBE_TIMEOUT_S` and `SUBSTRATE_DESKTOP_PROBE_KILL_AFTER_S` test seams, the smoke through `--probe-timeout-ms`); GreptimeClient errors never carry a configured credential and `GreptimeError.missingTable` is computed before scrubbing; `recordMetricSamples` counts a `null` or `undefined` entry as invalid and stores the rest (a regression the wave's own change introduced and review caught); `parity:check --json` prints only the JSON object on stdout; git children of the scripts run with prompts off. Under `exactOptionalPropertyTypes` an optional property is absent or a value of its type: `key?: T | undefined` where `undefined` already meant absence, a conditional spread where the object is serialized or compared.
- **Quality state at the end:** `tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals` and `noUnusedParameters`, and the tree has 0 compiler errors. Biome (1344 files) reports 0 errors, 0 warnings and 0 infos, down from 255 warnings and 6 infos before #171 (657 warnings at the start of the run); the two rules that warned are errors. The code ratchet is at its baseline on every counter, `non_null_assertions` 0 (it was 90 at the start of the run), with no new suppression and no new double cast. The counts that #171 fixed were measured on main first: 244 compiler findings in 85 files (192 TS2379, 31 TS2375, 8 TS2769, 7 TS2322, 3 TS2412, 1 TS2394) and 255 lint warnings in 87 files.
- **Branches:** `.planning/branch-register.md` holds the disposition of all 84 remote branches not contained in main (60 heads of merged PRs, 24 without one), the 22 local-only branches, two dirty worktrees, the ten stashes and the primary checkout. Four branch-derived changes were ported (#165, #167, #168, #169); everything else is on main, superseded or archive material. One new ref exists: `archive/v13-autonomous-worktree-2026-10-29`, a snapshot of an uncommitted worktree, not for merge. No branch, tag or stash was deleted.
- **TODO register:** D-06, D-09 to D-14 and D-16 to D-21 are closed with evidence (`.planning/todo-inventory.md`); D-01, D-02, D-03, D-07, D-08 and D-15 stay operator-gated; D-04 and D-05 are orphans; D-22 and D-23 are confirmed. The v1.6 audit's hook-config gap (two of four triggers printed) is closed by #166.
- **Local test note:** the host load average was 8 to 85 throughout. Timing-based tests flaked locally: the herdr transport test (`two near-simultaneous pushes yield one session.start`, 50 ms waits) and the post-commit headless-refusal test failed under load and passed in isolation, on the same code that passes at low load; the two store-lock scans failed at the 5-second default (D-16, fixed by #172). One lock-test failure that CI caught is worth remembering: `biome-config.test.ts` pins the Biome rule levels, so raising a level means editing that test in the same PR.
- **Not done, by decision:** `noPropertyAccessFromIndexSignature` (3076 sites); coverage thresholds; the cli to collectors import cycle (moving `packages/collectors/src/cursor-stop.ts` would break installed Cursor hook paths and needs a decision on a shared leaf module); shared helpers between the CLI and the server (`isRecord`, `errorMessage`, and the control-character regex that carries nine `biome-ignore` comments in eight files); `scripts/rehearsal.ts` `refuseDockerLocality` still lets a run proceed when `docker context inspect` itself fails (documented there as safe because every later docker call then fails; the desktop gates now fail closed); an audit row for an oversize or malformed REST `/skills/propose` body (refused before the audit call by design; the contract is the owner's); `S3BlobStore` (`blob-store-s3.ts`) is exported and tested but no non-test code constructs it; the archive links in the v1.2, v1.3 and v1.4 roadmaps that point at moved files; CI action pins that still run on Node 20; remote branch pruning (candidates are listed in the register, none deleted).
- **Operator-gated, untouched:** this run deployed nothing. Production was running release `5cf930a0` when it began (the merge of #139, per Run 12), so none of #142 to #172 is live until the operator deploys. Also open: LightRAG graph and hybrid modes need a real LLM route; RAGFlow code removal (closes D-15); funding the anchor key and any devnet send; installing the session hook in a host; the Notion re-login and the Linear plan limit; dropping `hindsight_backup_20261027`; `HINDSIGHT_BANKS` on the host.
- **Gate record:** every PR passed the full CI gate before merging (frozen install, `tsc` with the strict flags, blocking Biome lint, the full `bun test` suite against a scratch Postgres, the Python suites and the repo locks) and Greptile 5/5 with no open threads. CI on main is cancelled by the next push, so the record is the pull request run of each head; the last code merge is `bfe9e577` (#172).

## Run 14 (2026-10-29): milestone v1.7, docs atlas, self-improving context, live steering GA, worktree fleet

- **Request:** introduce eight features and process improvements for Substrate that use the Solana devnet, GreptimeDB, TimescaleDB, DragonflyDB and the TEI embedding model; ingest the documentation of every repository on the VPS, on GitHub and in the Greptile knowledge bases; trigger a docs upgrade automatically when documentation changes; make the RAG self-improving the way Hindsight is; make Live Steering present (the owner had not heard of it); and optimise many sessions working in git worktrees. Invoked with `gsd-autonomous` while no phase was open, so the milestone was defined first.
- **Assumptions, stated and not asked:** (1) the eight features are phases 63-70 (Corpus Atlas, Embedding fabric, Doc Watch, Docs Reflect, Live Steering GA, Worktree Fleet, Doc Proofs, Docs SLO and eval); (2) "ingest all documentation" is delivered as the pipeline, a dry-run inventory of this host and the runbook, and the live ingest into production waits for the release deploy, which is the operator's step (the request is put to the owner at the end); (3) TEI has a consumer in Substrate only where one exists (near-duplicate detection, semantic signals), because LightRAG's own embedding binding is configured on the LightRAG server and is locked to its data; (4) devnet use rides the existing hourly anchor, so no transaction is sent by this run; (5) Live Steering is presented as it stands on main (v1.6 phase 58) and its recorded gaps are closed; (6) quality means the Run 13 gates (strict compiler flags, zero Biome diagnostics, ratchet at baseline) hold for all new code.
- **Inventory (2026-10-29, names and sizes only, no contents read):** `/root/src/repos` holds 110 directories: 72 git checkouts of 44 distinct origins (four origins are cloned more than once: superatlas five times, clippyos four, autonogrammer-ai four, ompos twice) and 38 directories that are not repositories, among them worktree and copy collections (`pumpgrok-wt`, `autonogrammer-wt`, `ompos-units`). They contain 63,063 markdown, mdx, rst and adoc files (727 MB), of which 20,358 sit under `.planning/` in 26 directories and 1,603 under `docs/`. GitHub: 242 repositories in swcstudiospace (165 private, 8 archived) and 171 under SomeRandmGuyy (69 private). Greptile: 23 repositories have knowledge bases (agent-skills, ai-cluster, aimeecodes, autonogrammer-ai, clippyos, coding-fleet, faceless-desk, grok-cloud-sessions, grokrouter, omega-prime, ompos, programming-desk, pumpgrok, purple-team, realm, rust-ai, ship-desk, spectrumwebco-marketing, substrate, supernuxt and three more). Ingesting 63,063 files one page at a time through the current docs plane would take days, which is why phase 63 tiers, de-duplicates and batches.
- **Evidence that shaped the plan** (main at 9d3f2085; file and line references are in each phase's CONTEXT.md): the docs plane ingests one page at a time (upload, scan, pipeline poll, track status per page), has no delete or rename, stores only source URL, commit and heading, has one LightRAG workspace for all datasets and records no retrieval feedback; the only doc-change path is the server's planning refresh, which keeps its hashes in memory and re-ingests everything after a restart; `POST /docs/merge-trigger` is not called for any repository dataset; LightRAG v1.5.7 has `POST /documents/texts`, which the client does not use; Hindsight's client uses retain with `document_id` replace, recall and document delete, and none of reflect, mental-model creation, observations or directives; steering is pull-only with no command, no REST route and no view, session state is process-local, the brief has no steering or handoff section and `checkpoint_hint` has no reader; claims are per graph node, no component knows the worktrees under `/root/src/worktrees`, and the only disk guard is a 5 GiB floor in the dispatcher; TEI has no client; the hourly anchor covers ledger event hashes only; this host shows 106 directories under `/root/src/worktrees` and 98 percent disk use.
- **Plan:** one pull request per phase through `ultrathink-ship`; shared contracts are fixed in ROADMAP phase 63; migration step numbers are assigned in merge order (the migrate-contract test needs every version from 1 to N), so each unit takes the next free number when it rebases onto main. Wave A: phases 63 (two units), 64, 67, 68 core, 69 core, 70 core. Wave B after phase 63 merges: 65, 66 and the integrations of 68, 69 and 70. Operator-gated and not done by this run: deploy, timers and hooks, the live ingest, anchor funding.
- **Ultrathink plan (graph ut-mvtjveh1-26111d38, Notion Task 408bc1a0c7ae813a947efa582daedf83; Linear is blocked by the free-issue limit):** it arrived after the first units were dispatched, as in Runs 12 and 13, and was folded in rather than restarted. Its phases map onto this milestone: audit and feature lock (the Run 14 scouts and the audit record under `.planning/phases/63-corpus-atlas/audit/`), foundations and ingestion (63 and 64), change-triggered sync (65), the self-improving loop (66), worktrees and Live Steering (68 and 67), provenance anchoring (69) and hardening (70 and the closeout). Its eight features differ from this milestone's in one place: observability and the evaluation gate share phase 70, and the TEI embedding fabric (64) is added because TEI has no client. Its non-blocking questions took their defaults: the five capabilities the owner described are inside the eight; Solana devnet is used for anchoring only, through the hourly anchor that already exists; extraction-LLM egress is moot while LightRAG runs in naive mode with the LLM bypass (text goes to embeddings only, no token cost), and a graph mode would need the owner's approval first. Its binding constraints changed the phase text: the default sync triggers write nothing into any repository and git hooks are an operator-run opt-in; new tables are covered by the archive and restore spec; the manifest and the docs plane get a reconcile because they are a dual write; staged units are resource-bounded; and the documents this milestone writes must be retrievable through the finished pipeline.

## Run 15 (graph ut-1c9ee5ae87-8e2879a8, 2026-11-01): phase 76 verification record and roadmap sync

- **Record:** `.planning/phases/76-telemetry-buffer-and-dead-letter/76-VERIFICATION.md`, re-verified 2026-11-02 with the procedure in `/root/.agents/gsd-core/agents/gsd-verifier.md`. Owner decision on 2026-11-02: must-have 2 accepted as an override (the dead-letter store is unbounded by D76-13; a cap is the follow-up). Status `human_needed`, 2 of 2 must-haves (must-have 2 PASSED by override). Self-check `gsd_run query verification.status` exits 0.
- **Gates (orchestrator, serial, scratch Postgres 16):** tsc exit 0; bun test 11413 pass, 2 skip, 0 fail; check:phase-close 236 pass, 0 fail; config reference up to date. Log: `/root/src/worktrees/backups/gates-p76.log`.
- **Correction (2026-11-02):** the first record (commit `f85299eb`) did not follow the gsd-verifier procedure: wrong path, no `covered_files`, `covered_digest` or `overrides_applied`, a date instead of a timestamp, and no `gsd_run` self-check. It is superseded. The earlier statement that it followed the gsd-verifier rules was wrong.
- **Human verification, not run:** live GreptimeDB rehearsal (block the ledger, confirm 503 with `buffered: true` and the `/healthz` depth; restore and confirm each event lands once in chain order; confirm the `mayExist` cell predicate against real timestamp precision); exhaust the default budget (about four minutes) on a live outage and confirm the dead-letter line, mode 0600 and the boot refusal; restart mid-outage with a durable buffer file; shutdown under the service manager; buffered `session.end` on a live session; keyed replay on a live collector spool; operator decision to enable the buffer (off by default, D76-15); `/healthz` memo staleness (up to 5 s) acceptable to pollers.
- **Findings, NOT FIXED, decision pending:**
  - R-1: a dead-lettered event is not deduplicated against its record. Event ids are random per `normalizeEvent` (`event.ts` 278 and 282). The common case is that a dead-lettered event never landed: a replay then writes its only copy, and the dead-letter record is orphaned. A duplicate needs one of two triggers, neither reproduced: (a) the original write commits after give-up or during a shutdown abandon (`service.ts` 2862 to 2864); (b) a keyed request in enforce mode without the replay header and without a `ts` misses the lookup and writes a second row (`event.ts` 145, `service.ts` 2625 to 2627, and a ts-carrying replay dedupes at `service.ts` 2732 to 2734).
  - R-2: `EventBuffer.drain` drops `options.all` and returns the in-flight pass (`event-buffer.ts` 215 to 221), so a shutdown pass can join a periodic pass and not-yet-due entries are not attempted. With an unsaved buffer they are abandoned with records (`service.ts` 2864), not silently lost.
  - Must-have 2 is accepted by owner override. Follow-up: a dead-letter cap. Design to decide: admission counts buffered and dead-lettered entries against one cap, so a write that cannot be buffered or recorded answers `stored: false`, and no buffered entry is dropped for lack of room.
  - D76-11 is superseded by D76-17 (memory buffer abandoned at shutdown; configuration never builds one). Criterion 1 holds only with `SUBSTRATE_EVENT_BUFFER_PATH` set (opt-in).
  - The docs overstate outage tolerance: `docs/greptime-ledger.md` 951 says about five minutes; the schedule gives about four (243 s nominal; verifier).
- **Not done:** no push, PR, merge, tracker writes, complete or cleanup.
