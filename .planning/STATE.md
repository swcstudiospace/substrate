---
gsd_state_version: "1.0"
milestone: v1.3
milestone_name: Build plan completion
current_phase: 20
current_phase_name: Production identity and Phase 0 UAT
status: Blocked on Phase 20-06 operator checkpoints and Phase 28 live gates
stopped_at: Seven phases sealed; operator identity/client/UAT and live-anchor evidence remain pending
last_updated: "2026-10-11T04:13:19.227Z"
last_activity: 2026-10-11
last_activity_desc: Sealed Phases 21, 27 and 30 after complete real isolated proofs; retained operator-only checkpoints
state_head: 76a4b2c3834cb363e6a620451b47fc0f5ab71811
progress:
  total_phases: 18
  completed_phases: 7
  total_plans: 50
  completed_plans: 49
  percent: 39
---

# State

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

Phase: 20 — Production identity and Phase 0 UAT
Plan: 20-01 through 20-05 implemented; 20-06 human actions 0/3
Status: Blocked on Phase 20-06 operator checkpoints and Phase 28 live gates
Last activity: 2026-10-11 — Seven of eighteen phases sealed; no milestone closure or main merge

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| uat_gaps | milestones/v1.0-phases/00-brief/0-UAT.md | partial (8 scenarios pending) | 2026-10-07 | v1.1 |

## Operator Next Steps

- Complete the Phase 20-06 operator window and record values-free identity, client installation, soak and production UAT evidence; do not start a new milestone.
- Rotate/revoke the exposed Cursor surface credential through the documented list-form rotation procedure; test isolation is fixed, credential rotation is not performed.

## Session Continuity

Last session: 2026-10-11
Stopped at: Seven phases sealed; operator identity/client/UAT and live-anchor evidence remain pending
Resume file: .planning/phases/20-production-identity-and-phase-0-uat/20-06-PLAN.md

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

## Project Reference

See: `.planning/PROJECT.md`; current source and evidence checkpoint recorded after Phases 21, 27 and 30.

**Core value:** Every agent on the host shares one brief, one event log, one governed memory plane, one skills library and one Graph ID.
**Current focus:** Phase 20 identity/client readiness and production UAT; no live action is self-approved.

## Needs Human

| Phase | Gate | Minimum action |
| --- | --- | --- |
| 20 | `20-06` three `checkpoint:human-action` tasks | Operator completes client-first readiness/identity, approved client and plugin installation, soak and actual production UAT with values-free evidence. |
| 20 | Cursor credential containment | Operator rotates/revokes the Cursor surface credential exposed by the pre-existing unsafe resolver test; no token value is recorded here. |
| 28 | `28-04` live L1–L10 | Separate approved funded-devnet/deploy/timer/production-write window and actual memo readback/adoption evidence; fake-chain47/47 is not a live seal. |
| Delivery | Protected-main/remote review gate | Desk Quality through Programming Lead and authorized human landing; this cloud session never merges, enables auto-merge, force-pushes or deletes branches. PR34 remains4/5 and PR41 remains1/5 on current exact heads. |

### Recovery and current evidence

- Phase 19's old fixture-only proof was replaced by actual proof-named herdr and installed Muse CLI behavior: 41/41 checks, zero refusals, owned cleanup; canonical `19-VERIFICATION.md` passes.
- Final Phase 19 gates: 85 targeted pass/0 fail, typecheck exit 0, 112 lock checks/0 fail, full suite 2670 pass/58 skip/0 fail; skip counts are not proof.
- The documented Phase 20-05 commits `978ce72` and `9006476` exist in the claude-ultrathink object database. Its missing worktree was restored at `9006476` to `/root/src/worktrees/claude-ultrathink-p20` on `gsd/v1.3-p20-identity-uat`; no stable checkout, installed plugin or live client configuration was changed.
- Native GSD dispatch does not require the separate AgentSwarm runner's signing keys. The discarded signing-key route is not a milestone blocker.
- User checkout changes observed concurrently on `phase/22-skills-sync-bridge-miners` are not owned by this run and remain untouched.
- Phases 21, 27 and 30 passed fresh native goal verification and canonical `phase.complete`; total7/18 (39%). Their named requirements and every existing plan/task were reconciled without replaying implemented work.
- Latest source gate:2718pass/58skip/0fail across96files, types0, unchanged credential/vocabulary locks108pass/0fail, bash syntax0/shellcheck0. The preceding2719pass run was before deletion of one never-passed-to-SUT framing tautology, not an inferred count.
- Separate real isolated proofs: basic harness4/4, skills3doors47/47 with real Git/recording gh, ledger47/47 (28 ingest checks plus19 fake-chain checks), desktop20/20 and vocabulary29/29. Up/down0, two owned stores removed, every owned terminal closed; no production/model/devnet/main-merge action.
- Desktop N1: three measured fresh-as-ported repeats, each9120 solid480×19 pixels with baseline0; current20/20 is separate from historical18/20 FAIL. Failed Docker locality now refuses before input/lifecycle effects; authoritative unrelated-desktop absence never substitutes for a failed probe.
- Phase 20-05 recovered client actually passed159tests/typecheck0 and repeated scratch MCP registration plus graph readback. Names-only identity metadata check passed0 with zero missing/stranded/error entries; bearer equality, installed plugin, rotation, soak and production UAT remain unproved.
- Native security now has zero high blocking threats for21/27/30 at the unchanged high threshold. Six below-threshold proposed acceptances remain unapproved; no acceptance or production approval was fabricated.
- Source corrections committed at `76a4b2c`; user checkout/installed clients remain untouched. Existing exact-head remote review scores: PR34=4/5, PR40=5/5, PR41=1/5, PR42=5/5; score alone does not establish open-thread/CI readiness. No review was triggered or PR merged.
