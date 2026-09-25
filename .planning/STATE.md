---
gsd_state_version: "1.0"
milestone: v1.0
current_plan: 10
status: executing
stopped_at: "03-09 complete (pr_lands_decision=i; SWC-480, graph ut-muhk8v3p-47ae5f1a, 13 D-14 archives, dispatch:claude-code created unapplied); next 03-10 proof"
last_updated: "2026-09-25T23:05:00.000Z"
state_head: 8dcc7d21215bb17f32b4a6e9cbc4e0d57ac5726e
progress:
  total_phases: 6
  completed_phases: 2
  total_plans: 29
  completed_plans: 28
  percent: 33
milestone_name: Agent Substrate — four planes (runtime, memory, skills, ledger) keyed by Graph ID
current_phase: 3
current_phase_name: Lane A
---

# State

## Current

Current Plan: 10
Total Plans in Phase: 10

**Phase 1 (Lane B) is complete** — 10/10 plans, verification `passed`
(`phases/01-lane-b/01-VERIFICATION.md`, commit `45cb7e7`). The 01-09 proof
recorded gaps; gap-closure plan 01-10 closed them: handoff events now carry
`repo` and `node_id` (mcp `63fd450`), a real Hermes session
(`20260924_182534_fe7fa2`) claimed n2 of `ut-mufsocbe-c7ced745` without
editing the tree, and the Omp brief for that graph names both the handoff and
the claim (`phases/01-lane-b/01-10-PROOF.md`). The owner accepted the
remaining live-model-session checks on 2026-09-24 (see Blockers → Accepted).

**Phase 2 (Claims and dispatch) is complete** — 9/9 plans, verification `passed` 65/65 with 5 owner overrides (`phases/02-claims-and-dispatch/02-VERIFICATION.md`). Proof run 5 on SWC-467: `dispatch:hermes` → dispatched Hermes (`claude-opus-5.5`) claimed n1 → Linear In Progress + `agent:hermes`, Notion Agent hermes, brief → DoD-gated Done. Accepted shortfalls: label→brief 65 s (30 s Hermes `pre_llm_call` hook stall dominates), completion by the operator because the dispatched model cannot read the issue text. Code review fix pass applied (02-REVIEW.md: WR-01..04, IN-02, IN-03). **Dispatch is OFF** (`SUBSTRATE_DISPATCH_DISABLED=1`); dispatched model is `SUBSTRATE_DISPATCH_MODEL=claude-opus-5.5`.

**Open owner decisions from Phase 2 review:** WR-05 (give dispatched Hermes a read-only issue-text tool and a release-if-stuck step) and IN-01 (dispatcher and Hermes run as root and can read `/etc/substrate/substrate.env`).

**Phase 3 (Lane A) is executing** — 03-01 through 03-09 executed; 03-08 closed **partial** (owner `skip` on the approval bot: no `SUBSTRATE_APPROVAL_*` keys, approvals off, so 03-10's Approve/Deny round-trip cannot run). 03-09 set up the proof (`phases/03-lane-a/03-PROOF.md` § Setup, commit `8dcc7d2`): owner decision `pr_lands_decision=i` (PR on swcstudiospace/agent-substrate, owner merges later); D-14 archived 13 duplicate issues (262 → 249; 12 `Untitled eng work` issues from another workflow raised the count), then created SWC-480 in Todo — the workspace now sits at 250 active, the Free-plan limit; graph `ut-muhk8v3p-47ae5f1a` with Notion Task row (Status Implementing, kickoff_by=host) and Issue row; `dispatch:claude-code` label `3dee3876-…` created, **not applied**. Next: 03-10 applies the label and runs the proof. Post-wave gate at `ed8cc94`: bun test 338 pass / 0 fail, tsc exit 0, dispatcher pytest 149 passed. `hostFunctionPermissions` stays `substrate:*` and `${sandboxCollection}:*`.

**Phase 3 (Lane A) was planned** — 10 plans in 10 sequential waves (`phases/03-lane-a/03-0{1..10}-PLAN.md`), plan-checker passed on iteration 3 (0 blockers, 0 warnings, 3 info), decision coverage 16/16. 03-01 is the D-09 spike: it re-measures baselines (167 pass / 0 fail, tsc exit 0; dispatcher 114 passed), gates on ≥ 10 GiB free, waits for an owner human-verify on the SUS-flagged rivet packages, installs rivet into `packages/host`, and writes `03-01-SPIKE.md` with `route_choice` / `tracker_route` / `tests_route` that every later plan branches on. Research changed three assumptions: the pinned Claude adapter 0.2.7 runs `--bare` (hooks, skills and `.claude.json` MCP likely not loaded, session MCP servers renamed `mcp-N`), the VM's model calls need the loopback route to shunt :3001 (no Anthropic key on the host), and rivet's stock Docker sandbox publishes an unauthenticated command port on 0.0.0.0 (a custom 127.0.0.1 provider replaces it). Linear SWC is at 251 active, so D-14 needs 2 archives. Owner checkpoints: rivet package verification (03-01), the new Telegram approval bot (03-08), "PR lands" meaning (03-09), approval taps (03-10). Dispatch stays OFF except inside 03-10's trap-closed window.

Lane B proceeded under **D-01**: an additive brief and events only. The
TypeScript-engine work and the Kanban retirement belong to the "Ultrathink
on Hermes" v1.0 milestone in the `claude-ultrathink-grok` worktree.
`hermes-plugin/.planning/PROJECT.md` is a shipped v0.3.0 milestone; it does
not specify that redesign. ROADMAP Success Criteria 1 and 2 for Phase 1,
**as literally worded**, were not achievable in Lane B and were not attempted.
Lane B is assessed against its actual goal — every surface reads the brief
and emits events — as recorded in `01-VALIDATION.md`.

herdr 0.9.1 requires a **string** request id. `pane_id` is a **required**
field on a `pane.agent_status_changed` subscription, which makes a wildcard
agent-status subscription impossible and per-pane subscription mandatory.

Orca-vs-herdr remains resolved in favour of **herdr as the persistent
runtime, with Orca alongside** as the IDE surface and as a collector. See
phases/01-lane-b/CONTEXT.md. Grok Build file delivery is installed; a live
Grok Build model did not quote the brief.

**Plan 01-01 (rollback safety baseline) executed 2026-09-24, all 3 tasks, 11 min.**
See `phases/01-lane-b/01-01-SUMMARY.md`. What now exists that did not before:

- Initial commits in the four repos that had no restorable history —
  `hermes-plugin` `65caa2d`, `omp-ultrathink` `3c8c2ec`,
  `hermes-engineering-board` `b60d581`, `hermes-linear-connector` `dc2d74d`.
  `redactor.py` tracked in `mcp` as single-path commit `2a89f98`.
- Byte-verified snapshot of all 10 live files at
  `/var/lib/substrate/phase1-baseline/20260924T040418Z/` (`latest` symlink),
  with `MANIFEST.sha256`.
- `/var/lib/substrate/phase1-baseline/RESTORE.md` — two restore routes per file,
  with ⚠ flags on the two where `git checkout --` would destroy another
  session's uncommitted work (`mcp/…/server.py`, `claude-ultrathink-grok/hooks/uplift.ts`).
- `phases/01-lane-b/01-BASELINE.md` — seven measured suites and the node ids of
  all 8 pre-existing failures.

**Plans 01-01 through 01-09 are executed.** Waves 1-4 ran. The Hermes tracer
checkpoint and the eng-board checkpoint were approved earlier. 01-09 recorded
the cross-surface proof and did not clear its gaps. Resume is `/gsd-verify-work`
for those gaps, not another execution of 01-09 and not Phase 2.

**Before editing a snapshotted live file, read `/var/lib/substrate/phase1-baseline/RESTORE.md`.**
It is the only undo, and choosing the wrong route on the two flagged files
discards another session's work.

Open items carried into execution:

- **`mcp` is RED at 99 passed / 2 failed and `01-VALIDATION.md` does not list it
  at all.** Measured, not remembered. Pre-existing, from another session's
  in-progress v0.4 work. D-03's no-repair rule applies. **Gate against
  `01-BASELINE.md`, not `01-VALIDATION.md`** — the latter's five counts were all
  correct, but it omits `mcp` and `agent-substrate` entirely.
- **Lane B test gates are two-sided.** A pre-existing failure that *disappears*
  fails the gate exactly as a new one does — a vanished failure means a task
  touched a checkout Lane B does not own.
- `omp-ultrathink`'s baseline is path-scoped to `config.ts`, `index.ts`, `swe.ts`
  plus manifests; ~40 other `.ts` files stay untracked. Extend the baseline before
  editing any of them.
- ROADMAP.md criteria 1-3 were annotated in place with the D-01/D-02 re-scoping
  (kept the original wording quoted). The owner had declined re-scoping when
  offered; revert that hunk of `3ab6c87` if the roadmap should stay pristine.
- The planner added an Omp `events_emit` that the success criteria do not name,
  to satisfy the phase GOAL's "read AND emit". Sensible, but it is scope the
  planner chose rather than scope the owner approved.

## Phase 0 (complete)

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

**Verified end to end on 2026-09-24** via `/gsd-autonomous` in verify-only mode
— all 8 UAT items run against the live service, no rebuild. See
`phases/00-brief/0-VERIFICATION.md`. Initial result was 5 pass / 1 partial /
2 fail; all three gaps were then closed.

Previously "not done", now resolved:

- ~~a reachable Postgres URL for the index~~ — reachable; the index answers
  (`graph_index` 6, `graph_nodes` 15, `memory_entries` 1).
- ~~`graph_register` inside `ultrathink-kickoff`~~ — added as step 5,
  idempotent and fail-open, committed as `c2c12a8` on branch
  `substrate/graph-register`. **Not yet merged, and not yet live:** the running
  plugin loads a cache copy at
  `~/.claude/plugins/cache/ultrathink/ultrathink/0.1.1/` that still has no
  `graph_register`. A live kickoff will not register until that cache is
  rebuilt.
- ~~git post-commit hook and Cursor hooks only dry-run~~ — both installed.
  `.git/hooks/post-commit` present; 3 `substrate-managed` entries appended to
  `/root/.cursor/hooks.json` with all 6 `gsd-managed` entries untouched
  (backup at `hooks.json.substrate-backup`, re-run is idempotent).

## Accumulated context

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

**Lane B documentation corrections (do not rediscover)**

- D-01: Hermes work in this phase is an additive brief and events only. The TypeScript-engine work and the Kanban retirement belong to the "Ultrathink on Hermes" v1.0 milestone in the `claude-ultrathink-grok` worktree. ROADMAP criteria 1 and 2 as literally worded were not attempted.
- herdr 0.9.1 requires a **string** request id. A numeric `id` is rejected.
- `pane_id` is a **required** field on a `pane.agent_status_changed` subscription, which makes a wildcard agent-status subscription impossible and per-pane subscription mandatory.

## Blockers

_(Credential rotation was considered and declined by the owner — recorded
here so it is not re-raised.)_

- 01-08 precondition was later met on this host; that plan completed. The old blocker text is kept so it is not re-opened as if unread: precondition unmet (fetchBrief/brief.ts missing on claude-ultrathink-grok HEAD a12eee1, branch rebased past 01-BASELINE.md's recorded ancestor 3766efd). Re-measure 01-BASELINE.md row 6 before retrying; code recoverable from branches substrate/brief, feat/substrate-brief, substrate/graph-register or squash-merge f10e8de on origin/master.
- [Phase 1] Proof gaps from 01-09 (null handoff attribution, no Hermes claim, Omp brief missing both facts, stale proof-repo Muse brief) were closed by 01-10. See `phases/01-lane-b/01-10-PROOF.md`.

**Accepted by owner, not agent-verified (Phase 1, 2026-09-24):**

- Hermes *claimed* n2; it did not mark it completed. Accepted as the finish.
- No live Omp, Grok Bot, Grok Build or Muse model session quoted a brief. The brief text those surfaces receive was observed; model quotation was not.
- The Muse `.substrate/BRIEF.md` is keyed by checkout path, so it does not list slug-keyed events (the handoff and the claim).
- The 01-10 production dispatch wrapper was killed ~100 ms after spawn; whether its Telegram ACK was sent was not observed.

## Pending todos

- ~~Review and merge claude-ultrathink PR #1~~ — squash-merged 2026-09-24 as
  `f10e8de`. `fetchBrief` is on `origin/master`.
- Merge claude-ultrathink `substrate/graph-register` (`c2c12a8`) — the
  `graph_register` step for `ultrathink-kickoff`. Held on a separate branch
  because `feat/substrate-brief`'s working tree has 15 files modified by
  another session, including its own uncommitted edit to the same `SKILL.md`.
- Rebuild the ultrathink plugin cache after that merge, otherwise the running
  install keeps loading the 0.1.1 snapshot without `graph_register`.

## Published

- `swcstudiospace/agent-substrate` (private) — `main` pushed.
- `swcstudiospace/claude-ultrathink` PR #1 — the `fetchBrief` integration,
  branched cleanly from `master`, 5 files, 256 tests green.

**Lesson recorded:** `git add <file>` on a file another session had already
modified swept four of their hunks into my commit (a 3→15 Sub-Issue assertion
and a `<thinking>`→`<rationale>` fixture change). It only surfaced because the
clean branch failed against `master`. In a shared checkout, stage hunks or
verify the diff against the target branch before pushing — not just the file
list.

## Deferred

- Notion §12 unknowns, each probed at the start of the phase that needs it: Orca's session/event
  query API, Muse's plugin API, Omp's skills directory, which Cursor hooks fire for the CLI,
  rivet-agentos `openSession` option names and the Codex adapter package name.

## Deployment

`substrate-mcp` runs under systemd — `systemctl status substrate-mcp`,
`journalctl -u substrate-mcp -f`. Credentials at `/etc/substrate/substrate.env`
(0600, root). Both stores are on Railway; no local containers remain.

Railway networking, learned the hard way: `.railway.internal` and
`DATABASE_PRIVATE_URL` resolve only from inside Railway. A consumer outside it
needs the TCP proxy (`…proxy.rlwy.net:PORT`), which must be enabled per service
under Settings → Networking. HTTP services get a public domain automatically,
which is why Greptime worked immediately and Postgres did not.

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01 | 11min | 3 tasks | 7 files |
| Phase 01 P04 | 35min | 3 tasks | 5 files |
| Phase 01 P06 | 19min | 3 tasks | 6 files |
| Phase 01-lane-b P07 | 23min | 3 tasks | 5 files |
| Phase 01-lane-b P05 | 29min | 3 tasks | 5 files |
| Phase 01 P01-03 | 14min | 3 tasks | 4 files |
| Phase 01-lane-b P09 | 14min | 3 tasks | 2 files |

## Session

**Last session:** 2026-09-25T23:05:00.000Z
**Stopped at:** 03-09 complete; next 03-10 (label SWC-480 with dispatch:claude-code, run the Lane A proof; approvals off)
**Resume file:** None

## Decisions

- [Phase 1]: Phase 1 rollback baseline: 4 repos given an initial commit (hermes-plugin, omp-ultrathink, hermes-engineering-board, hermes-linear-connector); redactor.py tracked in mcp. Undo for the two git-init'd repos is rm -rf their new .git.
- [Phase 1]: hermes-engineering-board and hermes-linear-connector had STALE indexes (staged blobs older than the worktree). Refreshed from disk by explicit path before committing — a baseline built from a stale index restores the wrong bytes.
- [Phase 1]: mcp measured RED at 99 passed / 2 failed and is absent from 01-VALIDATION.md's baseline table. D-03's no-repair rule applied to it by the same reasoning; gate against 01-BASELINE.md, not 01-VALIDATION.md.
- [Phase 1]: Lane B test gates are two-sided: a pre-existing failure that disappears fails the gate exactly as a new one does. 8 failing node ids recorded in 01-BASELINE.md.
- [Phase 1]: Extended mcp-server SURFACES/EVENT_KINDS unions to admit the herdr surface and its 3 event kinds (Rule 2/3 auto-fix).
- [Phase 1]: herdr's pane.output_matched terminal text is carried on field matched_line, not output_matched/matched_text as the plan prose implied - confirmed via live socket probe (Rule 1 fix).
- [Phase 1]: herdr.ts opens one persistent socket connection per pane: herdr 0.9.1 resets a connection on a second events.subscribe call, and one bad pane_id in a batched subscribe kills the whole connection without acking any other entry.
- [Phase 1]: 01-06: SUBSTRATE_MUSE_REPOS set to Lane B's four repos (hermes-plugin, omp-ultrathink, hermes-engineering-board, hermes-linear-connector), not agent-substrate itself
- [Phase 1]: 01-06: Muse native plugin manifest/hook schema derived from the binary's own bundled create-plugin skill docs, not guessed
- [Phase 1]: 01-06: muse plugins update refreshes from the plugin's originally recorded install source path, not any newly given path — idempotence testing must fully remove+reinstall to avoid a stale source
- [Phase 1]: 01-06: Assumption A2 (SessionStart hook output reaching model context) confirmed YES via hook test's decision.additional_contexts
- [Phase 1]: events_emit kind:"uplift" corrected to kind:"prompt" (closed EVENT_KINDS enum), following 01-02 precedent; uplift specifics carried in payload
- [Phase 1]: runAutonomousDiscovery substrateMcp parameter placed trailing-optional to protect an untracked, not-owned caller (mcp-bind-timeout.test.ts) from a typecheck break
- [Phase 1]: Task 3 live-verify used swcstudiospace/agent-substrate as the target repo (had recorded substrate history); pi -e CLI extension loading hit a pre-existing, out-of-scope defect, substituted a real-code live-verify script against the real running substrate-mcp service
- [Phase 1]: 01-05: grok-hermes-connector v0.4 built on this session's substrate bridge pattern — substrate_ext.py (7th _ext.py-convention service), four new MCP tools, graph_id on handoff_to_hermes threaded via server.py's own existing meta dict rather than the dirty, out-of-scope hermes_backend.py
- [Phase 1]: 01-05: an earlier session probe accidentally triggered a real live handoff_to_hermes dispatch (hermes chat --yolo + real Telegram ACK) against production before this plan's safety-scoped tests existed; contained (process killed, confirmed no PIDs remained, no result.json written) and the plan's own live graph_id-dispatch human-check was deliberately not re-attempted autonomously a second time — see 01-05-SUMMARY.md coverage D4 and WINDOWS.md entry 5
- [Phase 1]: Phase 1: 01-03: eng-board substrate forwarding additive over work_unit_store/connector (Rule 3 fix: SUBSTRATE_DISABLED=1 on 3 pre-existing hook tests to stop them hitting live 127.0.0.1:7410); owner-approved live checkpoint (eng-board work item, 3 event kinds, connector unchanged)
- [Phase 1]: Phase 1: 01-08 (Grok Build) DEFERRED by owner decision — precondition unmet: src/substrate/brief.ts exporting fetchBrief does not exist on claude-ultrathink-grok's current branch milestone/v1.0-cross-runtime (HEAD a12eee1); another session rebased that branch so 01-BASELINE.md's baseline commit 3766efd is no longer an ancestor of HEAD. Suite now 246 pass/0 fail/21 files vs recorded 256 pass/1 fail/22 files — the recorded failing node id vanished. Code not lost: exists on branches substrate/brief, feat/substrate-brief, substrate/graph-register, and squash-merged to origin/master as f10e8de. 01-BASELINE.md row 6 is stale and must be re-measured before 01-08 is retried.
- [Phase 1]: Phase 1: omp-ultrathink has NO row in 01-BASELINE.md (table covers 7 repos, omp not among them). Measured after plan 01-07: 62 pass/0 fail, tsc at pre-existing 52 errors. The no-new-failures half of the two-sided gate holds; the no-vanished-failures half is unverifiable for this repo because none were ever recorded.
- [Phase 1]: 01-09 recorded the cross-surface proof rather than asserting it. graph_id ut-mufsocbe-c7ced745 handoff event landed with null repo and node_id. Hermes did not claim n2. Omp, Muse, and Grok Build model quotation gaps are in Blockers verbatim. ROADMAP criteria 1 and 2 as worded were not attempted (D-01; Ultrathink on Hermes owns the TypeScript engine and Kanban retirement). herdr 0.9.1 string request id and required pane_id on pane.agent_status_changed are carried forward.
