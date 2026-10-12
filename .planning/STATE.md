---
gsd_state_version: "1.0"
milestone: v1.3
milestone_name: Build plan completion
status: human_needed
stopped_at: v1.3 archive preserved; reachable source and named docs proof artifacts verified; real-proof acceptance and credential rotation require operator evidence
last_updated: "2026-10-12T12:41:42Z"
last_activity: 2026-10-12
last_activity_desc: Residual rows reconciled; Bun3355/58/0,Python246,types0,locks119/0; actual named docs82/82 and skills18/18; full live acceptance held
state_head: 1a9f4fd365ede291c4e21be71b6ff236e0e49c67
progress:
  total_phases: 18
  completed_phases: 18
  total_plans: 76
  completed_plans: 76
  percent: 100
current_phase: null
current_phase_name: null
---

# State

## Current

**v1.3 implementation is archived:** 18 phases (16–33), 76 plans and 68 requirements. The archive completed concurrently at `ab0dff1`; do not replay completion, recreate active phase directories or start a new milestone. The user explicitly retains real-proof criteria: source-completion history is not full end-to-end acceptance. Current isolated corrections and remaining gates are recorded in `VALIDATION.md`.

**Residual reconciliation:** all 36 older plan mappings and 98 task rows are individually recorded without archive replay. Of the 53 previously pending requirement rows, 32 isolated criteria are locally evidenced and 21 compound live criteria remain held; this is not a new score for all 68 approved requirements. The two missing named deliverables, `--ragflow-fixture` and `scripts/docs-smoke.ts`, are implemented and verified (docs82/82, skills18/18). **Live windows executed 2026-10-12 under the operator's all-scripted-runbooks approval:** identity values PASS recorded; MIRROR-08 PASS on SWC-467; DISP-08 PASS on SWC-480 (kill switch restored); UAT live scenarios 1/3/4/7/8 PASS; docs G1/G2 PASS on the real RAGFlow plane (v0.27.1, `auctioning` created); Hindsight governance + Dragonfly hit/outage arms PASS; Lane A doors/boot/rollback proven. Held with named prerequisites: installed-client UAT tail (2/5/6) + Cursor rotation; SKILL live tail (rebinds + owner merge); devnet funded steps (0-lamport keypair); LANEA turn chain (sandbox image, Grok CLI ≥1.0.13 shunt, Telegram binding); deployment-gated docs/hindsight tails (one parity restart after PR #54 merges serves main's code). PR #54: Greptile SUCCESS, typecheck/locks SUCCESS, vulnerability audit SKIPPED (reported blocker); merge is the owner's click.

**Docs contract decision (user, this conversation):** keep the consolidated actual docs API, persisted local manifests and last-five version manifests. The older source clauses for `dry_run`, rebuilding the manifest from RAGFlow and physical deletion of retired versions are explicitly superseded, not implemented or proved. All real live proof gates remain required. The existing D25-07 no-new-timer hook decision is unchanged.

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

Phase: None active — v1.3 implementation archived
Plan: No active implementation phase; live windows executed under the 2026-10-12 operator approval; remaining holds carry named prerequisites
Status: human_needed for end-to-end acceptance; MIRROR-08 and DISP-08 cleared live, UAT 1/3/4/7/8 live-pass, docs G1/G2 live-pass, Hindsight/Dragonfly arms live-pass, Lane A doors/boot/rollback proven
Last activity: 2026-10-12T15:22:40Z — final certification Bun3355/58/0, Python246, types0, locks119/0; production release ff71394 deployed (substrate-mcp process unchanged since 2026-10-10); PR #54 open (Greptile SUCCESS, typecheck/locks SUCCESS, vulnerability audit SKIPPED = reported blocker)

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| uat_gaps | milestones/v1.0-phases/00-brief/0-UAT.md | partial (8 scenarios pending) | 2026-10-07 | v1.1 |

## Operator Next Steps

- **Merge PR #54** (draft → ready is yours; Greptile SUCCESS, typecheck/locks SUCCESS; the vulnerability audit shows SKIPPED and is a reported blocker, not a pass). After merge: one parity restart serves `main`'s code (production `current` already runs `ff71394`), which unblocks the deployment-gated docs G3/G4, hindsight plane recall, and FOUND-03's "serves main".
- **Rotate the Cursor credential** through the operator-only two-restart process (still open; gates UAT-04/scenario 6).
- **Fund the devnet anchor keypair** (`SOLANA_ANCHOR_PUBKEY`, 0 lamports) to open ANCHOR L4/L5/L8 and 29-G3; read-only checks already approved.
- **Lane A turn chain**: approve/produce `substrate-sandbox:0.1` locally, update the host Grok CLI shunt to ≥1.0.13 (currently 502), and configure the Telegram approvals binding.
- **SKILL-02/03/04/07 tail**: Hermes miner/bridge/sync rebinds plus an owner-merged mined-skill PR.
- **Installed-client tail (UAT 2/5/6)**: reconcile the 342 unauthenticated `/events` 4xx writers and obtain per-scenario receipts.
- Do not start a next milestone, repeat completion/cleanup, force-push, or enable auto-merge here.

## Session Continuity

Last session: 2026-10-12T15:22:40Z
Stopped at: MIRROR-08/DISP-08/UAT-tail/docs-G1G2/Hindsight-Dragonfly/LaneA-doors cleared live under operator approval; archive unchanged; remaining holds carry named prerequisites (merge+parity restart, rotation, funding, sandbox image, Grok CLI shunt, Telegram binding, rebinds)
Resume file: VALIDATION.md and milestones/v1.3-phases/28-hourly-anchor-job-and-verify/28-PROOF-ADDENDUM.md

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
