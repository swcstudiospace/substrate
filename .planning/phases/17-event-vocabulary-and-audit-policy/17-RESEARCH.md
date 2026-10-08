# Phase 17: Event vocabulary and audit policy - Research

**Researched:** 2026-10-08
**Domain:** Closed event vocabulary (TypeScript const enums + typed mapping table), Bun test guards, read-only git baseline diff, HTTP sample-emit smoke against the Phase 16 rehearsal harness, audit-mode policy sets
**Confidence:** HIGH (all load-bearing facts read from the worktree at `dcc4f4c` / baseline `ab62c91` this session; Phase 16 contracts are planned, not merged, and are marked as such)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Mapping rules (apply to every source)
- **Closed vocabulary, both enums.** No kind and no surface is added; `normalizeEvent` (`event.ts:124-131`) keeps refusing anything else. A source with no fitting surface is not emitted under a wrong one: it is dropped and counted by its emitter (LANEB-05 / A-T5 counting).
- **`payload.action` is the discriminator** for events a component records about itself, following main's existing use (`service.ts:1130` `action: "expired"`, lease events' `action: "released" | "stolen"`). September's would-be kinds become `payload.action` values: `skill.propose`, `docs.ingest`, `docs.search`, `teachable`, `anchor`, `mirror`, `dispatch`, `approval`, `skills.sync`.
- **`payload.runtime` names a non-agent producer** acting for an agent or for the host (`herdr`, `agentos`, `anchor`, `dispatcher`, `skills-sync`), as LANEB-02 already fixes for herdr.
- **The original type always travels.** Where a source has its own event type (herdr's `pane.*`), the exact type is kept in a payload field (`payload.herdr_type`), the v1.1 swarm precedent (`payload.swarm_type`, ADR 0001 risk table). An unmapped type is a test failure in that source's mapper, not a silent `note`; at runtime an unknown herdr type still becomes a `note` carrying `herdr_type`, as `grok-map.ts`'s default does.
- **Success is `note`, refusal or failure is `warning`.** Work an agent does is the work kind (`tool.call`, `session.start`, `session.end`). A refusal records rule names, reasons and hashes only, never the refused value (`auditMemoryWrite` precedent, `service.ts:719-748`).
- **Never content, only hashes and lengths** for anything sensitive: typed desktop text (length + sha256), screenshots (sha256 + dimensions, never bytes), teachables and skills (`content_sha256`), docs pages (`content_sha256`, source URL).
- **`repo` is set only where the event is work in that repo.** `brief.ts:150-157` lists the last actions per repo (every kind except `session.start`/`session.end`), so any periodic event carrying `repo` crowds a repo's brief.

#### The mapping (one row per v1.3 source)

| Source (phase) | Kind | Surface | Payload / notes |
|---|---|---|---|
| herdr agent detected (19) | `session.start` | the agent herdr detected, mapped to `SURFACES` | `runtime: "herdr"`, `herdr_type`, `pane_id`; `repo` = origin slug of the pane cwd |
| herdr status change (19) | `note` | same | `runtime: "herdr"`, `herdr_type`, `status`, `pane_id`; `repo` set (LANEB-02, it is meant to reach the brief) |
| herdr pane exited (19) | `session.end` | same | `runtime: "herdr"`, `herdr_type`, `pane_id` |
| herdr output matched / other types (19) | `note` | same | `runtime: "herdr"`, `herdr_type`; matched text redacted |
| Muse tool call, PostToolUse hook (19) | `tool.call` | `muse` | `tool`, `outcome`, `duration_ms` (grok-map shape); `repo` and `branch` from git |
| Muse brief writer (19) | **no event** | — | Deliberately not an event: a `note` with `repo` per 5-minute refresh would enter that repo's brief, change it, and re-trigger itself. The written `BRIEF.md` and the writer's local counters are its trail; fetch failures are counted, not emitted |
| Cursor `stop` hook (19) | `session.end` | `cursor` | `actor: "human"` (as the projector's existing hooks), `session_id` = conversation id, `conversation_id`, `transcript_ref`, `status`, `reason?` |
| `skills_propose` outcome (21) | `note` | the authenticated caller's surface (never body-supplied) | `action: "skill.propose"`, `name`, `status` (`opened`/`existing`/`declined`/`unchanged`), `pr_url`, `content_sha256`; `repo` = `swcstudiospace/agent-skills` |
| `skills_propose` refused (21) | `warning` | same | `action: "skill.propose"`, `status: "refused"`, `reason`, rule names only |
| skills sync refusal (22) | `warning` | the sync job's token surface | `action: "skills.sync"`, `runtime: "skills-sync"`, `reason` (`dirty`/`off-branch`/`diverged`) |
| `docs_search` (25) | `note` | caller | `action: "docs.search"`, `dataset_ids`, `urls` (returned source URLs, DOCS-01), `count`; an error is a `warning` with `reason` |
| `docs_ingest` (25) | `note` | caller | `action: "docs.ingest"`, `dataset_id`, `source_url`, `content_sha256`, `status` (`uploaded`/`unchanged`) |
| `docs_ingest` refused (25) | `warning` | caller | `action: "docs.ingest"`, `status: "refused"`, `reason`, rule names only |
| Hindsight retain failure (26) | `warning` | the memory's writer | `action: "memory.retain"`, `reason`; a successful retain and every recall emit nothing (reads do not emit, like `memory_search`) |
| `desktop_run`, one per action (30) | `tool.call` | caller | `tool: "desktop_run"`, `action` (`click`/`type`/`key`/`screenshot`), `run_id`, `i`, `ok`, `ms`; typed text as `text_len` + `text_sha256`; screenshots as `sha256`, `width`, `height` |
| Hourly anchor written or adopted (28) | `note` | the anchor job's token surface | `action: "anchor"`, `runtime: "anchor"`, `period_start`, `period_end`, `root`, `event_count`, `tx_sig`, `cluster`, `adopted`; it lands in the hour after the one it anchors |
| Anchor root mismatch or send failure (28) | `warning` | same | `action: "anchor"`, `runtime: "anchor"`, `period_start`, `reason` |
| Teachable accepted (29) | `note` | the memory writer | `action: "teachable"`, `memory_id`, `subject`, `content_sha256`; never the text. Emitted on an accepted, verified teachable `fact` write (main emits nothing for accepted writes today), which puts it inside the hourly anchor's coverage (CARD-03) |
| Claim-mirror failure (23) | `warning` | the lease holder | `action: "mirror"`, `target` (`linear`/`notion`), `op`, `reason` (MIRROR B-T5: one per failed target) |
| DoD gate (23) | existing lease events | holder | Existing release/complete events keep their shape; the gated path adds `payload.dod`; a gate refusal or error is a `warning` with `action: "dod"`, `reason` |
| Dispatcher outcome (24) | `note` / `warning` | the dispatcher's token surface | `action: "dispatch"`, `runtime: "dispatcher"`, `outcome`, `graph_id`; the launched agent's own events use its own surface |
| Lane A VM session (32) | `session.start` / `session.end` | `claude-code` | `runtime: "agentos"`, `graph_id`, `node_id` |
| Lane A permission request (33) | `note` / `warning` | `claude-code` | `action: "approval"`, `decision` (`requested`/`approved`/`denied`/`timeout`) |

- Agent Cards (29) and `verify` (28) are reads and emit nothing; `issue_get` and `graph_find` (23) emit nothing.
- **herdr agent → surface.** A fixed table maps herdr's agent identifiers onto `SURFACES` (for example Claude → `claude-code`, Codex → `codex`, OpenCode → `opencode`, Pi → `pi`, Cursor → `cursor`, Hermes → `hermes`, Omp → `omp`, Grok → `grok-build`, Muse → `muse`). herdr 0.9.1's exact identifiers are `[UNVERIFIED]`; Phase 19 pins them from `herdr api schema`. An agent with no row is not emitted and is counted as unmapped.
- **Sessions for job events.** A job event with no agent session gets its own one-event session, as `graph_bind`'s note does (`service.ts:825-829`), for example `anchor:<period_start>` and `dispatch:<graph_id>:<ts>`. Exact ids are each phase's discretion.

#### Where the mapping lives and how it is enforced
- **One typed table:** `packages/mcp-server/src/event-sources.ts` exports `EVENT_SOURCES`, one entry per row above: `source`, `phase`, `kind`, `surface` rule, the `action`/`runtime` values, and a `sample()` returning a concrete `EventInput`. It imports `EventKind`/`Surface` from `types.ts`, so a kind outside the enum is a type error.
- **One document:** `docs/event-vocabulary.md` holds the table above with each rule's reason, the closed-enum rule, and the phase-close check. A test asserts the document's table and `EVENT_SOURCES` name the same sources, kinds and actions, so they cannot drift.
- **Tests in `event-sources.test.ts`:** every `sample()` passes `normalizeEvent` unchanged in kind and surface; every source named in the roadmap (herdr, Muse, Cursor stop, skills propose, docs ingest, desktop actions, anchoring, teachables) has at least one row; every row whose `repo` is set is work in that repo (no periodic job carries `repo`).
- **Later phases' mappers test against the table.** For example the Phase 19 herdr mapper asserts its output kind and action equal the `EVENT_SOURCES` row. The table is the contract; changing it is a reviewed change to `docs/event-vocabulary.md` in the same PR.

#### Vocabulary lock and the phase-close check
- **`vocabulary-lock.test.ts`** in `packages/mcp-server/src` pins `EVENT_KINDS` to the v1.2 literal, in order (12 kinds), and `SURFACES` to its v1.2 literal (26 surfaces; the existing `authority.test.ts:220-227` already pins the count and order and stays). It runs in plain `bun test`, so every phase's normal verification already catches a change.
- **`scripts/phase-close-check.ts`, run as `bun run check:phase-close`.** It:
  1. runs `bun test packages/mcp-server/src/store-lock.test.ts packages/mcp-server/src/vocabulary-lock.test.ts packages/mcp-server/src/event-sources.test.ts packages/audit/src/policy.test.ts`;
  2. reads the `EVENT_KINDS` block from `git show ab62c91:packages/mcp-server/src/types.ts` (the v1.2 baseline named in STATE.md) and diffs it against the imported `EVENT_KINDS`, printing the diff on failure;
  3. exits 0 only if both pass. Git calls use `--no-optional-locks` and only read objects; it never fetches or checks out.
- **Every later phase runs it.** `docs/event-vocabulary.md` states it, and the orchestrator adds `bun run check:phase-close` to the verification of Phases 18–33 (ROADMAP bookkeeping is the orchestrator's; this phase does not edit ROADMAP or STATE).

#### Sample-emit proof against the Phase 16 harness
- **`scripts/vocabulary-smoke.ts`, run as `bun run smoke:vocabulary`.** It sources only the harness's `consumer.env`, refuses a `SUBSTRATE_URL` on port 7410 or a non-loopback host (the Phase 16 smoke guard), posts every `EVENT_SOURCES` sample to `POST /events` with `SUBSTRATE_TOKEN`, and requires `202` with `stored: true` for each. Any 4xx (an unknown kind or surface) or 503 fails the run, and the count of refusals is printed (must be 0).
- **Attribution in the proof.** A non-swarm token may name another surface on `/events` (`attributedSurface`, `mcp.ts:91-97`), so the harness's default token (a non-swarm surface) can post every sample's own surface; no harness flag is needed.
- **Run-tagged.** Every sample's `session_id` and `graph_id` carry a `rh-vocab-<timestamp>` tag, and the script reads them back through `POST /events/query` to confirm one stored row per source.
- **Proof run:** `bun run rehearsal up --name p17` → `bun run smoke:vocabulary` → `bun run check:phase-close` → `bun run rehearsal down --name p17`. Isolated, no live system, no operator approval needed.

#### Audit policy for the tools v1.3 adds
- **Decided here, encoded now.** `policy.ts` gains the planned tools in the existing two sets, under a comment naming this phase; `auditMode` is unchanged. A tool that lands later already has its mode the first time it is called.

| Tool (phase) | Mode | Why |
|---|---|---|
| `skills_propose` (21) | fail-closed | Opens a PR other agents will receive after merge; a proposal nobody recorded is an unaudited publication |
| `docs_ingest` (25) | fail-closed | Writes a shared dataset every agent reads; it is also a publication path |
| `desktop_run` (30) | fail-closed | Acts on a desktop (DESK-03 fixes this) |
| `docs_search` (25) | fail-open | A read inside an agent's turn |
| `issue_get` (23) | fail-open | A read of untrusted tracker text |
| `graph_find` (23) | fail-open | A read of the index. The research table (ARCHITECTURE Pattern 2) put it fail-closed without a reason; main's stated policy (`policy.ts:28-44`, `docs/mcp-audit.md` "Fail open, fail closed") is that every read is fail-open, and an unlisted read failing closed is the bug v1.2 fixed. The dispatcher's claim that follows is fail-closed anyway |
| `memory_recall` (26) | fail-open | The recall tool's name is fixed here as `memory_recall`; a read like `memory_search`. If Phase 26 serves recall only as derived `memory_search` results, it removes the entry in its own PR |
| `agent_card` (29, REST route) | fail-open | The Agent Card route is a read, audited under this name |

  REST twins (`POST /skills/propose`, `/docs/search`, `/docs/ingest`, `/issue`) are audited under their tool's own name, as `/memory` is audited as `memory_write` (`server.ts:374-382`), and inherit that mode. If Phase 28 adds an anchor route, it is a shared-state write and fail-closed; its name and entry land with it.
- **Test.** `policy.test.ts` holds its own literal table of the planned tools and their modes, independent of `policy.ts`, and asserts each tool is explicitly in the matching set (not fail-closed by default) and not in the other. Removing an entry or flipping it fails the test. The existing "the two lists do not overlap" test stays.
- **`docs/mcp-audit.md`** "Fail open, fail closed" table gains the planned tools, marked by phase, and links to `docs/event-vocabulary.md`.
- **Registration stays with each tool's phase.** `mcp.ts` `registerTool` and `observe.ts` `KNOWN_TOOLS` (and `KNOWN_ROUTES`/`auditedRest` for REST twins) are added when the tool lands; Phases 21, 23, 25, 26, 29 and 30 each name those registrations in their own criteria.

### Claude's Discretion
- The exact field names inside `EVENT_SOURCES` entries and the shape of `sample()`.
- Whether the document-vs-table test parses the Markdown table or a fenced block.
- Session-id formats for job events and run tags.
- Whether `phase-close-check.ts` spawns `bun test` once or per file, and whether it prints JSON.
- Whether `policy.test.ts` also scans `mcp.ts` for `registerTool("…")` names and asserts each is explicitly in one set (a cheap guard against a later phase registering a tool with no decision).

### Deferred Ideas (OUT OF SCOPE)
- **hermes-engineering-board** (`substrate_client.py:24`, FEATURES P3) emits as surface `hermes-eng-board`, which main refuses. Its mapping is surface `hermes` with `payload.runtime: "eng-board"`, recorded in `docs/event-vocabulary.md`; the fix is a change in that plugin's repo, which no v1.3 phase owns. Raise with the operator.
- Per-action event durability for `desktop_run` (stop the run when an action's event is not stored, versus continue and report) is Phase 30's decision; the recommendation recorded for it is to stop, since the tool is fail-closed and DESK-02 requires one event per action.
- A dedicated non-agent surface (for example `substrate`) for host jobs would need a reviewed `SURFACES` change; not taken in v1.3.

### Open for the operator (from CONTEXT, plan proceeds with the recommendation)
- Host jobs (anchor timer, skills sync, dispatcher) emit under the surface of the token Phase 20's identity runbook assigns them, with `payload.runtime` naming the job; default `claude-code` (the existing `attributedSurface(null)` fallback).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FOUND-02 | `EVENT_KINDS` is unchanged after every phase, each new event source documents its mapping onto existing kinds and surfaces, and `packages/mcp-server/src/store-lock.test.ts` passes at every phase close. The audit policy records fail-open or fail-closed for every tool v1.3 adds, and a policy test catches a missing or contrary entry. [VERIFIED: .planning/REQUIREMENTS.md:25] | Baseline enum literals quoted below (§ Verified in-repo values); `EVENT_SOURCES` row inventory (§ Pattern 1); doc-vs-table parse design (§ Pattern 2); phase-close check design incl. the Bun missing-file trap (§ Pattern 3, Pitfall 1); smoke design against `consumer.env` and `/events` + `/events/query` (§ Pattern 4); policy-set edits and test (§ Pattern 5); no existing test breaks when planned names are added (§ Pitfall 6) |
</phase_requirements>

## Summary

Phase 17 is pure policy-and-guard work on top of code that already enforces the closed vocabulary. `normalizeEvent` (`packages/mcp-server/src/event.ts:124-131`) throws `InvalidEventError` for any kind outside `EVENT_KINDS` (12) or surface outside `SURFACES` (26); `POST /events` turns that into a 400. Nothing in Phase 17 touches that path. The work is: (1) one side-effect-free typed table `EVENT_SOURCES` in `packages/mcp-server/src/event-sources.ts` whose `sample()`s are concrete `EventInput`s; (2) `docs/event-vocabulary.md` with a machine-parsable table between HTML comment markers; (3) a literal lock test; (4) `scripts/phase-close-check.ts`, which spawns Bun tests and diffs `EVENT_KINDS` against the git object at `ab62c91`; (5) `scripts/vocabulary-smoke.ts`, an HTTP-only client of the Phase 16 harness; (6) eight planned tool names added to `FAIL_CLOSED_TOOLS`/`FAIL_OPEN_TOOLS`, with a test that holds its own literal table of them.

Every load-bearing fact checks out against the worktree. `types.ts` is byte-identical to `ab62c91` (`git diff --quiet ab62c91 HEAD -- types.ts event.ts policy.ts` → unchanged). `ab62c91` is an ancestor of HEAD and readable through the shared `.git` (`/root/src/repos/agent-substrate/.git`). `POST /events/query` filters by exact `graph_id`/`session_id` and returns up to 500 rows with payloads, so run-tagged readback works. All 19 `registerTool` names in `mcp.ts` and all 8 `auditedRest` names in `server.ts` are already in one of the two sets, so a scan guard passes at HEAD. No existing test asserts the sets equal the served tools, so adding unserved planned names breaks nothing. The comment at `policy.ts:36-41` and the line at `docs/mcp-audit.md:233` both say "exhaustive over the tools this substrate serves", and both must be reworded.

Three traps the planner must design around. First, `bun test ./a.test.ts ./missing.test.ts` exits **0** when one of the listed files is missing, as long as another matches (probed below). The phase-close check must assert that each file exists. Second, `store-lock.test.ts` scans **every tracked file**, including `.planning/*.md`, `docs/*.md` and the new scripts, for a substrate-token assignment shape and for Greptime credential shapes. Writing the token key followed by `:`/`=` and a 16+ character identifier in code or docs fails the lock. Third, Phase 16 is not merged and Phase 17's PR is cut from `main`. `vocabulary-smoke.ts` therefore cannot import `scripts/rehearsal.ts` or `rehearsal-env.ts`. It must carry its own small pure guard and `consumer.env` parser, matching the Phase 16 contract: `export KEY='value'` lines in `${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/<name>/consumer.env`.

**Primary recommendation:** Build in two waves. Wave 1 covers the table, doc, lock, policy, phase-close check and smoke, plus pure-function tests for each; it is green in plain `bun test` with no Docker. Wave 2 is the isolated proof (`rehearsal up --name p17` → `smoke:vocabulary --name p17` → `check:phase-close` → `rehearsal down --name p17`). It is gated on `scripts/rehearsal.ts` existing on the executing branch.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Closed enum enforcement (kind/surface) | API / Backend (`event.ts` `normalizeEvent`) | — | Unchanged. Already the single write-path gate (`event.ts:124-131`) |
| Mapping contract (`EVENT_SOURCES`) | Shared library module in `packages/mcp-server/src` (types only) | Collectors/projector import it in later phases | Collectors already import `../../mcp-server/src/types.ts` (`grok-map.ts:9`), so the module must stay side-effect-free and import only `types.ts` |
| Mapping documentation | `docs/event-vocabulary.md` | `docs/mcp-audit.md`, `docs/swarm-correlation.md` link to it | Locked location |
| Vocabulary lock | Test (`vocabulary-lock.test.ts`, plain `bun test`) | Phase-close script (git baseline diff) | The literal test catches drift on every run. The git diff catches an edit that changes the enum *and* the literal together |
| Phase-close gate | Repo ops script (`scripts/phase-close-check.ts`) | git (read-only object read) | No CI in repo (`.github/` absent, verified). The orchestrator runs it |
| Sample-emit proof | Ops script, HTTP-only client (`scripts/vocabulary-smoke.ts`) | Phase 16 harness (scratch server + stores) | Store lock: scripts reach the ledger only through `SUBSTRATE_URL` |
| Audit mode decisions | `packages/audit/src/policy.ts` sets | `server.ts` `auditedRest` / `observe.ts` consume `auditMode` | `auditMode` is unchanged; only the set contents change |

## Project Constraints (from AGENTS.md)

No `CLAUDE.md`; `AGENTS.md` exists. No `.claude/skills/` or `.agents/skills/` directories in the worktree.

- Read `.substrate/BRIEF.md` at the start of work in this repo; never edit it by hand. [VERIFIED: AGENTS.md:1-5]
- **Draft PR only.** Do not merge, enable auto-merge, force-push or delete branches. (The v1.3 run rules in STATE.md layer the operator's own ship flow on top; executors follow the orchestrator.) [VERIFIED: AGENTS.md:11]
- **No secrets.** Never print, commit or echo tokens, keys, passphrases or bus secrets. Reference env vars by name only. Never write tailnet names or internal hostnames into the repo, PR or transcript. [VERIFIED: AGENTS.md:12]
- **Greptile gate.** Never claim merge-ready while a Greptile finding is open. FAILED, SKIPPED or unavailable is a blocker. [VERIFIED: AGENTS.md:13]
- Orchestrator path rules for this run: write only under `/root/src/worktrees/agent-substrate-v13-p17`. Never touch the operator checkout. Never modify `.planning/STATE.md`, `.planning/ROADMAP.md` or `.planning/state.json`. Git reads use `--no-optional-locks`.

## Verified In-Repo Values

Each value below was read from the worktree this session. Values in code skeletons later in this document come from these quotes or from CONTEXT decisions (cited).

**`EVENT_KINDS`** [VERIFIED: packages/mcp-server/src/types.ts:50-63, identical at `ab62c91`]:
```ts
export const EVENT_KINDS = [
	"session.start",
	"prompt",
	"claim",
	"tool.call",
	"file.edit",
	"shell",
	"commit",
	"pr",
	"handoff",
	"session.end",
	"note",
	"warning",
] as const;
```

**`SURFACES`** [VERIFIED: packages/mcp-server/src/types.ts:11-27, 30-43]: `"claude-code", "cursor", "hermes", "omp", "muse", "grok-build", "grok-bot", "codex", "opencode", "pi", "rivet-agentos", ...SWARM_SURFACES`. `SWARM_SURFACES` = `"swarm-a01-orch"`, `"swarm-a02-req"`, `"swarm-a03-arch"`, `"swarm-a04-uxd"`, `"swarm-a05-be"`, `"swarm-a06-fe"`, `"swarm-a07-data"`, `"swarm-a08-qa"`, `"swarm-a09-rev"`, `"swarm-a10-sec"`, `"swarm-a11-devops"`, `"swarm-a12-rel"`, `"swarm-a13-obs"`, `"swarm-a14-maint"`, `"swarm-a15-doc"`. That makes 11 + 15 = 26. `authority.test.ts:220-227` already pins `toHaveLength(15)`, `toHaveLength(26)` and the A01..A15 order.

**`FAIL_CLOSED_TOOLS`** [VERIFIED: packages/audit/src/policy.ts:16-26]: `"graph_claim", "graph_release", "graph_complete", "graph_register", "graph_heartbeat", "graph_bind", "memory_write", "coord_handoff", "coord_reap_leases"` (9).

**`FAIL_OPEN_TOOLS`** [VERIFIED: packages/audit/src/policy.ts:45-68]: MCP reads `"memory_brief", "memory_search", "memory_pending", "events_query", "events_verify", "graph_get", "coord_handoff_verify", "coord_handoff_list", "coord_drift_scan"`; `"events_emit"`; REST `"brief", "events", "verify", "drift", "healthz", "metrics", "slo", "evidence"` (18).

**`auditMode`** [VERIFIED: packages/audit/src/policy.ts:77-80]: `if (FAIL_OPEN_TOOLS.has(tool)) return "fail-open"; return "fail-closed";`. Default-deny, unchanged by this phase.

**Registered MCP tools** [VERIFIED: probe over `mcp.ts` `registerTool(` lines]: `coord_drift_scan coord_handoff coord_handoff_list coord_handoff_verify coord_reap_leases events_emit events_query events_verify graph_bind graph_claim graph_complete graph_get graph_heartbeat graph_register graph_release memory_brief memory_pending memory_search memory_write` (19, each already in exactly one set).

**REST audit names** [VERIFIED: probe over `server.ts` `auditedRest(res, observability, surface, "…"`]: `brief coord_handoff drift events events_query evidence memory_write verify` (8, all in a set).

**Query limits** [VERIFIED: packages/mcp-server/src/greptime.ts:75-76]: `export const MAX_QUERY_LIMIT = 500;` `export const DEFAULT_QUERY_LIMIT = 50;`

**Event field caps** [VERIFIED: packages/mcp-server/src/event.ts:52-55]: `const MAX_SUMMARY = 2000; const MAX_FIELD = 512; const MAX_PAYLOAD_STRING = 4000; const MAX_PAYLOAD_BYTES = 16_000;`

**`POST /events` contract** [VERIFIED: packages/mcp-server/src/server.ts:330-358]: audited as `"events"`. `attributedSurface(surface, body.surface)` returns 403 `{ error }` on refusal. On success the reply is `sendJson(res, result.stored ? 202 : 503, { id, ts, hash, stored, error?, warning? })`. An invalid event throws `InvalidEventError` → 400 (per CONTEXT `server.ts:330-358`; the catch path was not re-read this session).

**`POST /events/query` contract** [VERIFIED: server.ts:362-370; service.ts:613-642; greptime.ts:529-551]: audited as `"events_query"`. Filters `session_id`, `graph_id`, `node_id`, `linear_identifier`, `repo`, `branch` are **exact-match** (`"${column}" = ${this.q(value)}`), plus `surface`, `kind`, `actor`, `since`, `until`, `limit`, `order`, `include_payload`. The reply is `{ events, count, truncated }`, or `{ events: [], count: 0, truncated: false, error }` with HTTP 503 when the ledger fails. There is no prefix match, so readback must use the exact run-tag value.

**Attribution** [VERIFIED: packages/mcp-server/src/mcp.ts:91-97]: a non-swarm caller gets `{ surface: (supplied as Surface | null | undefined) ?? callerSurface ?? "claude-code" }`. A body surface always wins for a non-swarm token.

**Store-lock scans that hit new files** [VERIFIED: packages/mcp-server/src/store-lock.test.ts:72, 95, 98-131]:
- `const CREDENTIAL = /GREPTIME_(?:URL|USER|PASSWORD)["']?\s*[:=]\s*["']?[^\s"']/i;`: applied to every tracked file.
- `const TOKEN_LITERAL = /SUBSTRATE_TOKEN[A-Z0-9_]*["']?[ \t]*[:=][ \t]*["']?(?!process\.env|os\.environ|Bun\.env|env\.)[\w.~+/=-]{16,}/;`: applied to every tracked file (`git ls-files`), including `.planning/**` and `docs/**`.
- Any `**/*.ts` outside `packages/mcp-server/src` (except `scripts/greptime-smoke.ts`) must not contain `GREPTIME_`, must not import a `greptime` module, and must not contain `(FROM|INTO|UPDATE|TABLE)\s+"?agent_events"?`.

**Phase 16 consumer contract (PLANNED, not merged)** [CITED: 16-CONTEXT.md:38-39, 79-90; 16-01-PLAN.md:160-162; 16-03-PLAN.md:114, 125]:
- Run dir: `${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/<name>/`, mode 0700, holding `consumer.env` (0600).
- `consumer.env` keys: `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, `SUBSTRATE_REHEARSAL_TOKENS_DIR`, `SUBSTRATE_REHEARSAL_NAME`, `SUBSTRATE_TEST_PG_URL`. It holds no Greptime key.
- Format: `toShellExports` writes "single-quoted export KEY equals value lines".
- Default port 17410. The harness refuses 7410, 7411 and 6420. The default surfaces are `claude-code,cursor,hermes,omp`, so `SUBSTRATE_TOKEN` is the `claude-code` token, a non-swarm surface.
- The smoke URL guard is planned inside `scripts/rehearsal.ts`, but its export name is **not pinned** in any Phase 16 plan.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Bun runtime + `bun:test` | 1.4.0 (`bun --version`, VERIFIED) | Tests, scripts, `Bun.spawnSync`, `fetch` | Repo standard. `package.json` `engines.bun >=1.4.0` |
| TypeScript | `^5.7.0` devDependency (package.json:28) | `bunx tsc --noEmit` typecheck; `tsconfig.json:16` includes `scripts/**/*.ts` | Repo standard |
| git CLI | system | Read `ab62c91:packages/mcp-server/src/types.ts` | Already used read-only by `packages/mcp-server/src/git.ts` and `store-lock.test.ts` (`git ls-files -z`) |

### Supporting
None. No new dependency.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Regex-parse the git blob's `EVENT_KINDS` block | Write the blob to a temp file and `import()` it | Executes code read from git and needs a temp file. The block is a flat string-literal array (verified shape), so a regex is safe and enough |
| Markdown table between HTML comment markers | Fenced ```json block in the doc | JSON is easier to parse but unreadable as a reviewed doc table. Markers keep one human table. Precedent: `AGENTS.md:1,5` uses `<!-- substrate-brief:start -->`/`end` markers |
| Own `consumer.env` parser + URL guard in `vocabulary-smoke.ts` | Import Phase 16's `scripts/rehearsal.ts` guard | Phase 16 is unmerged, and its guard name is unpinned. Importing would break `tsc` on a branch cut from `main` |

**Installation:** none.

## Package Legitimacy Audit

No external packages are installed by this phase. The `package-legitimacy` seam was not run because there is nothing to check.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| — | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                      (reviewed PR, Phase 17)
 docs/event-vocabulary.md  <──── parsed by ────  event-sources.test.ts ────> EVENT_SOURCES (event-sources.ts)
   <!-- event-sources:start -->                     │  each sample() ──> normalizeEvent()  (kind/surface/payload unchanged)
   | id | phase | kind | surface | action | ...     │  roadmap-source coverage, repo-rule, no-content keys
   <!-- event-sources:end -->                        │
                                                     ▼
 types.ts EVENT_KINDS/SURFACES ──> vocabulary-lock.test.ts (literal pins, plain `bun test`)

 bun run check:phase-close ──> scripts/phase-close-check.ts
        ├─ assert each listed test file exists ──> spawn `bun test ./store-lock ./vocabulary-lock ./event-sources ./policy`
        ├─ git --no-optional-locks show ab62c91:packages/mcp-server/src/types.ts ──> regex EVENT_KINDS block
        │        └─ diff vs imported EVENT_KINDS ──> print diff on mismatch
        └─ exit 0 only if both pass (2 if baseline object missing)

 bun run smoke:vocabulary --name p17 ──> scripts/vocabulary-smoke.ts
        ├─ read ${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p17/consumer.env  (ignore process.env)
        ├─ guard: loopback host? port != 7410/7411/6420? ── no ──> exit 2, no request sent
        ├─ for each EVENT_SOURCES sample: {...sample, session_id: tag-<id>, graph_id: tag}
        │        POST /events (Bearer SUBSTRATE_TOKEN) ──> expect 202 {stored:true}; else count refusal
        ├─ POST /events/query {graph_id: tag, include_payload: true, limit: 500, order: "asc"}
        │        match each posted id/session_id ──> kind, surface, payload.action/runtime equal sample
        └─ print refusals=0, stored=N/N, readback=N/N ; exit 0 | 1

 packages/audit/src/policy.ts  FAIL_CLOSED_TOOLS += skills_propose, docs_ingest, desktop_run
                               FAIL_OPEN_TOOLS   += docs_search, issue_get, graph_find, memory_recall, agent_card
        └─ policy.test.ts: own literal PLANNED table ──> explicit set membership, not in other set
                           + scan mcp.ts registerTool names / server.ts auditedRest names ──> each in exactly one set
```

### Recommended Project Structure
```
packages/mcp-server/src/
├── event-sources.ts          # EVENT_SOURCES + SILENT_SOURCES; imports only ./types.ts; no side effects
├── event-sources.test.ts     # doc==table, normalizeEvent round-trip, coverage, repo rule, no-content keys
└── vocabulary-lock.test.ts   # EVENT_KINDS (12, ordered) and SURFACES (26, ordered) literal pins
packages/audit/src/
├── policy.ts                 # + Phase 17 planned entries under a comment; doc comment reworded
└── policy.test.ts            # + PLANNED_V13 literal table test; + registerTool/auditedRest scan (discretion, recommended)
scripts/
├── phase-close-check.ts      # exports pure parseEventKinds/diffKinds/missingFiles; main() under import.meta.main
├── phase-close-check.test.ts # pure-function tests (no git, no spawn)
├── vocabulary-smoke.ts       # exports pure parseConsumerEnv/refuseTarget/runTagged; main() under import.meta.main
└── vocabulary-smoke.test.ts  # pure-function tests (no network)
docs/
├── event-vocabulary.md       # new: rules, marked table, silent sources, deferred producers, phase-close check
└── mcp-audit.md              # edited: table gains planned tools by phase; "exhaustive" sentence reworded; link
package.json                  # + "smoke:vocabulary", "check:phase-close" (Phase 16 also adds two entries: trivial merge)
```
Test discovery: `bun test` from the root finds `*.test.ts` recursively, and `tsconfig.json:16` includes `"scripts/**/*.ts"` [VERIFIED: tsconfig.json:16; CITED: 16-RESEARCH.md:448]. A `scripts/*.test.ts` is typechecked and run by the existing commands, so no config change is needed.

### Pattern 1: `EVENT_SOURCES`: one typed row per (source, kind)

**What:** Each entry has exactly one `kind` and one concrete `sample()`. CONTEXT rows that list two kinds (dispatcher, Lane A session, Lane A approval, docs_search success/error) split into two entries. That way every entry has one sample, the smoke posts one event per entry, and a later mapper asserts against one row. Sources that deliberately emit nothing go in a separate `SILENT_SOURCES` list, so the doc table covers them but the smoke does not post them.

**Recommended entry shape** (field names are Claude's discretion per CONTEXT):
```ts
// Source: CONTEXT "Where the mapping lives"; types from packages/mcp-server/src/types.ts:44,64,70-85
import type { EventInput, EventKind, Surface } from "./types.ts";

export type SurfaceRule =
	| { fixed: Surface }          // muse, cursor, claude-code (Lane A)
	| "herdr-agent"               // herdr's detected agent → SURFACES via Phase 19's fixed table
	| "caller"                    // authenticated caller, never body-supplied
	| "job-token"                 // the job's token surface (Phase 20), default claude-code
	| "memory-writer"
	| "lease-holder";

export interface EventSource {
	id: string;                   // stable key shared with docs/event-vocabulary.md, e.g. "herdr.status_changed"
	phase: number;
	kind: EventKind;              // type error if outside EVENT_KINDS
	surface: SurfaceRule;
	actions?: readonly string[];  // payload.action values this row may carry (discriminator, or desktop's action)
	runtime?: string;             // payload.runtime
	carriesRepo: boolean;         // true only where the event is work in that repo
	periodic: boolean;            // job/timer emitter; periodic rows must not carry repo
	sample(): EventInput;         // concrete, deterministic, no ts
}
```

**Recommended row inventory.** IDs are recommendations. Kinds, surfaces, action and runtime values are copied from the CONTEXT mapping table; surfaces shown are the sample's concrete pick.

| id | phase | kind | sample surface (rule) | actions | runtime | repo | periodic |
|---|---|---|---|---|---|---|---|
| `herdr.agent_detected` | 19 | session.start | claude-code (herdr-agent) | — | herdr | yes (pane cwd slug) | no |
| `herdr.status_changed` | 19 | note | claude-code (herdr-agent) | — | herdr | yes (LANEB-02) | no |
| `herdr.pane_exited` | 19 | session.end | claude-code (herdr-agent) | — | herdr | no | no |
| `herdr.other` | 19 | note | claude-code (herdr-agent) | — | herdr | no | no |
| `muse.tool_call` | 19 | tool.call | muse (fixed) | — | — | yes (+branch) | no |
| `cursor.stop` | 19 | session.end | cursor (fixed), `actor: "human"` | — | — | no | no |
| `skills.propose` | 21 | note | claude-code (caller) | skill.propose | — | yes (`swcstudiospace/agent-skills`) | no |
| `skills.propose.refused` | 21 | warning | claude-code (caller) | skill.propose | — | no | no |
| `skills.sync.refused` | 22 | warning | claude-code (job-token) | skills.sync | skills-sync | no | yes |
| `docs.search` | 25 | note | claude-code (caller) | docs.search | — | no | no |
| `docs.search.failed` | 25 | warning | claude-code (caller) | docs.search | — | no | no |
| `docs.ingest` | 25 | note | claude-code (caller) | docs.ingest | — | no | no |
| `docs.ingest.refused` | 25 | warning | claude-code (caller) | docs.ingest | — | no | no |
| `memory.retain.failed` | 26 | warning | hermes (memory-writer) | memory.retain | — | no | no |
| `desktop.action` | 30 | tool.call | claude-code (caller) | click, type, key, screenshot | — | no | no |
| `anchor.written` | 28 | note | claude-code (job-token) | anchor | anchor | no | yes |
| `anchor.failed` | 28 | warning | claude-code (job-token) | anchor | anchor | no | yes |
| `teachable.accepted` | 29 | note | hermes (memory-writer) | teachable | — | no | no |
| `mirror.failed` | 23 | warning | claude-code (lease-holder) | mirror | — | no | no |
| `lease.release.dod` | 23 | note | claude-code (lease-holder) | released | — | yes (existing `placeOf`) | no |
| `dod.refused` | 23 | warning | claude-code (lease-holder) | dod | — | no | no |
| `dispatch.outcome` | 24 | note | claude-code (job-token) | dispatch | dispatcher | no | yes |
| `dispatch.failed` | 24 | warning | claude-code (job-token) | dispatch | dispatcher | no | yes |
| `lanea.session_start` | 32 | session.start | claude-code (fixed) | — | agentos | no | no |
| `lanea.session_end` | 32 | session.end | claude-code (fixed) | — | agentos | no | no |
| `lanea.approval` | 33 | note | claude-code (fixed) | approval | — | no | no |
| `lanea.approval.denied` | 33 | warning | claude-code (fixed) | approval | — | no | no |

`SILENT_SOURCES` (doc rows with Kind `—`): `muse.brief_writer` (19), `memory.retain` success and `memory.recall` (26), `agent_card` and `verify` reads (28/29), `issue_get` and `graph_find` (23).

The `released` action for `lease.release.dod` is main's existing release decision [VERIFIED: lease.ts:408 `action: "released"`; service.ts:1047-1063 emits `kind: decision.action === "forced" ? "warning" : "note"` with `payload: { action: decision.action, lease_epoch, ... }`]. Phase 23 only adds `payload.dod`.

`hermes-eng-board` (deferred) belongs in a separate, unparsed "Deferred producers" section of the doc. Its fix lives in another repo.

### Pattern 2: Doc-vs-table drift test (marked Markdown table)

**What:** `docs/event-vocabulary.md` wraps the one machine-checked table in `<!-- event-sources:start -->` / `<!-- event-sources:end -->`. The test reads the file from the repo root and parses the rows between the markers. It then asserts that the set of ids equals `EVENT_SOURCES ∪ SILENT_SOURCES` ids, and that each row's kind and actions match.

**Example:**
```ts
// Source: repo-root read pattern from packages/mcp-server/src/authority.test.ts:238
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOC = join(import.meta.dir, "..", "..", "..", "docs", "event-vocabulary.md");

export function parseMarkedTable(markdown: string): Array<Record<string, string>> {
	const start = markdown.indexOf("<!-- event-sources:start -->");
	const end = markdown.indexOf("<!-- event-sources:end -->");
	if (start < 0 || end < start) throw new Error("event-sources markers missing");
	const rows = markdown.slice(start, end).split("\n").filter((line) => line.trimStart().startsWith("|"));
	const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/`/g, ""));
	const [header, , ...body] = rows; // header, separator, rows
	const keys = cells(header ?? "");
	return body.map((line) => Object.fromEntries(cells(line).map((value, i) => [keys[i] ?? `col${i}`, value])));
}
```
Doc rules this imposes: no `|` inside cells (write `note / warning`, never `note | warning`), the id column holds exactly the `EVENT_SOURCES` id, the kind column holds one kind or `—`, and the actions column holds comma-separated values or `—`.

### Pattern 3: Phase-close check (pure core, thin CLI)

**What:** Export pure helpers and keep the effects in `main()` behind `import.meta.main`. This follows the planned Phase 16 pattern (16-PATTERNS.md:476-478) and `packages/projector/src/swarm-workspace.ts`. Spawn with a fixed argv, no shell and a timeout, as `packages/mcp-server/src/git.ts:40-49` does.

```ts
// Source: git.ts:40-49 spawn shape; types.ts:50-63 block shape
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EVENT_KINDS } from "../packages/mcp-server/src/types.ts";

export const BASELINE = "ab62c91"; // v1.2 baseline, .planning/STATE.md:33
const ROOT = join(import.meta.dir, "..");
export const LOCK_TESTS = [
	"packages/mcp-server/src/store-lock.test.ts",
	"packages/mcp-server/src/vocabulary-lock.test.ts",
	"packages/mcp-server/src/event-sources.test.ts",
	"packages/audit/src/policy.test.ts",
] as const;

export function parseEventKinds(source: string): string[] | null {
	const block = /export const EVENT_KINDS = \[([\s\S]*?)\] as const;/.exec(source)?.[1];
	return block === undefined ? null : [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

export function diffKinds(baseline: readonly string[], current: readonly string[]): string[] {
	const out: string[] = [];
	const n = Math.max(baseline.length, current.length);
	for (let i = 0; i < n; i++) if (baseline[i] !== current[i]) out.push(`[${i}] ${baseline[i] ?? "∅"} → ${current[i] ?? "∅"}`);
	return out;
}

export function missingFiles(root: string, files: readonly string[]): string[] {
	return files.filter((file) => !existsSync(join(root, file)));
}

function baselineTypes(): string | null {
	const run = Bun.spawnSync(
		["git", "--no-optional-locks", "-C", ROOT, "show", `${BASELINE}:packages/mcp-server/src/types.ts`],
		{ stdout: "pipe", stderr: "pipe", timeout: 5000, env: { ...minimalEnv(), GIT_OPTIONAL_LOCKS: "0" } },
	);
	return run.exitCode === 0 ? run.stdout.toString() : null;
}
// main(): missing → exit 2; spawn [process.execPath, "test", ...LOCK_TESTS.map(f => `./${f}`)] with stdio inherit;
// baseline null → exit 2 "baseline not in this clone (shallow?) — never fetched by this script";
// diff non-empty → print it, exit 1; else exit 0 if tests passed.
```
`minimalEnv()` should carry `PATH` and `HOME`, and should drop `GIT_DIR`/`GIT_WORK_TREE` if set, so the read cannot be redirected. Spawning `bun test` once with all four `./`-prefixed paths is fine, provided `missingFiles` runs first (see Pitfall 1).

Probe this session [VERIFIED: `git --no-optional-locks show ab62c91:packages/mcp-server/src/types.ts` returned 398 non-empty lines; `git --no-optional-locks merge-base --is-ancestor ab62c91 HEAD` → true; git common dir `/root/src/repos/agent-substrate/.git`].

### Pattern 4: Vocabulary smoke (HTTP-only, harness-only)

**What:** Read only the instance's `consumer.env` file, never `process.env` for URL or token. Refuse before any request. Post every sample with run-tagged ids, then read back by `graph_id`.

```ts
// Source: Phase 16 contract (16-CONTEXT.md:38,79-90; 16-03-PLAN.md:114,122,125); server.ts:330-370
export function parseConsumerEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const m = /^export ([A-Z][A-Z0-9_]*)='((?:[^']|'\\'')*)'$/.exec(line.trim());
		if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/'\\''/g, "'");
	}
	return out;
}

const PRODUCTION_PORTS = new Set([7410, 7411, 6420]); // 16-CONTEXT.md:59
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** null when the target is a scratch loopback server; otherwise the reason it is refused. */
export function refuseTarget(raw: string | undefined): string | null {
	if (!raw) return "consumer.env has no SUBSTRATE_URL";
	let url: URL;
	try { url = new URL(raw); } catch { return "SUBSTRATE_URL is not a URL"; }
	if (!LOOPBACK.has(url.hostname)) return `non-loopback host ${url.hostname}`;
	const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
	if (PRODUCTION_PORTS.has(port)) return `port ${port} is a production port`;
	return null;
}
```
Flow in `main(argv)`: `--name` defaults to `default`, matching the harness; the proof passes `--name p17`. Resolve `${XDG_RUNTIME_DIR || "/tmp"}/substrate-rehearsal/<name>/consumer.env`. If it is missing → exit 2. Parse it, then run `refuseTarget` → exit 2. Read the token into a local (`const bearer = env.SUBSTRATE_TOKEN`). Let `tag = rh-vocab-<Date.now()>`. For each entry, POST `{ ...entry.sample(), session_id: `${tag}-${entry.id}`, graph_id: tag }` with `authorization: Bearer <bearer>` and `content-type: application/json`, with a per-request `AbortSignal.timeout` as `chaos-smoke.ts` does. Count as a refusal anything other than `202` with `stored === true`. Then POST `/events/query` `{ graph_id: tag, include_payload: true, limit: 500, order: "asc" }`. Require HTTP 200 and no `error`. Match each posted `id` (returned in the 202 body) to a row, and compare `kind`, `surface`, `payload.action` and `payload.runtime`. Print only ids, counts, statuses and the run tag, never the token or reply bodies. Exit 0 / 1 / 2.

Retry readback a few times (for example 5 × 500 ms) before failing. Read-after-write visibility on Greptime v0.14.4 standalone was not probed `[ASSUMED]`.

### Pattern 5: Planned tools in the audit policy

```ts
// policy.ts, inside FAIL_CLOSED_TOOLS after "coord_reap_leases":
	// v1.3 tools, decided in Phase 17 (docs/event-vocabulary.md, docs/mcp-audit.md). Each is
	// registered by its own phase; its mode is fixed here so its first call is already decided.
	"skills_propose", // Phase 21
	"docs_ingest", // Phase 25
	"desktop_run", // Phase 30
// FAIL_OPEN_TOOLS, after the REST block:
	// v1.3 reads, decided in Phase 17. Registered by their own phases.
	"docs_search", // Phase 25
	"issue_get", // Phase 23
	"graph_find", // Phase 23
	"memory_recall", // Phase 26
	"agent_card", // Phase 29, REST route
```
```ts
// policy.test.ts: a literal table independent of policy.ts (CONTEXT "Test")
const PLANNED_V13 = {
	skills_propose: "fail-closed", docs_ingest: "fail-closed", desktop_run: "fail-closed",
	docs_search: "fail-open", issue_get: "fail-open", graph_find: "fail-open",
	memory_recall: "fail-open", agent_card: "fail-open",
} as const;
test("every tool v1.3 plans has its decided mode, explicitly", () => {
	for (const [tool, mode] of Object.entries(PLANNED_V13)) {
		const [mine, other] = mode === "fail-open" ? [FAIL_OPEN_TOOLS, FAIL_CLOSED_TOOLS] : [FAIL_CLOSED_TOOLS, FAIL_OPEN_TOOLS];
		expect({ tool, listed: mine.has(tool), contrary: other.has(tool) }).toEqual({ tool, listed: true, contrary: false });
		expect(auditMode(tool)).toBe(mode);
	}
});
```
Recommended discretionary guard: read `../../mcp-server/src/mcp.ts` and `server.ts` text from `packages/audit/src/policy.test.ts`. Extract `/registerTool\(\s*"([a-z_]+)"/g` and `/auditedRest\(res, observability, surface, "([a-z_]+)"/g`, and assert each name is in exactly one set. At HEAD all 19 and 8 names already are (verified above), so it passes now, and it fails if a later phase registers a tool with no decision. `registerTool(` and the name are on separate lines (mcp.ts:178-179), so the regex needs `\s*`.

### Anti-Patterns to Avoid
- **Importing `scripts/rehearsal.ts` or `rehearsal-env.ts` from Phase 17 code.** They are not on `main`, and Phase 17's PR is cut from `main`. `tsc` fails.
- **Defaulting `SUBSTRATE_URL` to `http://127.0.0.1:7410`.** `chaos-smoke.ts:51` does exactly that, and it points at production. The vocabulary smoke must have no default and must refuse 7410.
- **Reading `SUBSTRATE_URL`/`SUBSTRATE_TOKEN` from `process.env` in the smoke.** CONTEXT says it "sources only the harness's consumer.env". A stray shell export could otherwise aim it at production.
- **`event-sources.ts` importing `event.ts`, `service.ts` or anything with side effects.** Phase 19 collectors will import it (`../../mcp-server/src/event-sources.ts`, the same path style as `grok-map.ts:9`).
- **Putting a `ts` in `sample()`.** The collector-supplied `ts` would make samples look historical and would skew `since`/`until` readback. Let ingest stamp it.
- **`node_id` on `tool.call` samples.** `drift.ts:382-397` raises `work.unclaimed` for a work kind (`tool.call` is in `WORK_KINDS`, drift.ts:38) carrying `graph_id` + `node_id` with no lease. That is harmless on scratch but misleading, and it would teach later mappers a bad shape.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Kind/surface validation of samples | A second allow-list check | `normalizeEvent` from `event.ts` in the test | It is the production gate. A copy can drift |
| Redaction expectations | A re-implementation of rules in the test | Deep-equal `normalizeEvent(sample).payload` to `sample.payload` | This proves the sample shapes survive the real redactor (`redact.ts`) |
| Ledger readback | Any SQL or Greptime client in the script | `POST /events/query` | The store lock forbids anything else outside `packages/mcp-server/src` |
| Spawning git/bun | `child_process.exec` with a shell string | `Bun.spawnSync([...argv])` with timeout (git.ts:40-49) | No shell injection surface, bounded |
| Lock test of SURFACES count | A new count test | Keep `authority.test.ts:220-227`; add a full ordered literal in `vocabulary-lock.test.ts` | CONTEXT keeps the existing test |

**Key insight:** every enforcement already exists on the write path. This phase adds *pins* (a literal, a git baseline, a doc-parse) so that a change to the vocabulary has to come through a reviewed diff in three places at once.

## Common Pitfalls

### Pitfall 1: `bun test` silently skips a missing file when another file matches
**What goes wrong:** The phase-close check reports green while `event-sources.test.ts` or `vocabulary-lock.test.ts` is missing or renamed.
**Why it happens:** Bun treats arguments as path filters. If at least one matches, it runs that file and exits 0. It errors only when *nothing* matches.
**Evidence** [VERIFIED: probe this session, Bun 1.4.0]:
```
$ bun test ./packages/audit/src/policy.test.ts ./packages/mcp-server/src/nope.test.ts
 0 fail
 52 expect() calls
Ran 12 tests across 1 file. [6.00ms]
exit=0
$ bun test ./packages/mcp-server/src/nope.test.ts
Test filter "./packages/mcp-server/src/nope.test.ts" had no matches in --cwd="/root/src/worktrees/agent-substrate-v13-p17"
exit=1
```
**How to avoid:** `missingFiles(ROOT, LOCK_TESTS)` before spawning, with exit 2 if any are missing. Alternatively, spawn per file. Unit-test `missingFiles`.
**Warning signs:** "Ran N tests across 3 files" when 4 are listed.

### Pitfall 2: The store lock scans every tracked file, planning docs included
**What goes wrong:** `bun test` fails `no tracked file assigns a substrate token a value` or the Greptime credential scan, because of a line in `scripts/vocabulary-smoke.ts`, `docs/event-vocabulary.md` or a `.planning/phases/17-*/*.md` file.
**Why it happens:** `TOKEN_LITERAL` (store-lock.test.ts:95) matches the token key name followed by optional quote, `:` or `=`, then any 16+ chars from `[\w.~+/=-]`, unless they start with `process.env`, `os.environ`, `Bun.env` or `env.`. An object literal mapping that key to a long local identifier matches, for example a property access 16+ characters long. So does a doc example showing the key `=` a hex value. `CREDENTIAL` (line 72) does the same for the Greptime URL/user/password keys. `trackedFiles()` is `git ls-files`, so `.planning` is covered (commit_docs is true).
**How to avoid:** Read the token by property access (`env.SUBSTRATE_TOKEN`), and keep it in a short-named local such as `bearer`. In docs, name keys in prose or tables (`` `SUBSTRATE_TOKEN` ``) and never show them assigned. Never write a Greptime key name in any new `.ts` outside `packages/mcp-server/src`; the phase needs none.
**Warning signs:** The store-lock offender list names a new file.

### Pitfall 3: Sample payload keys that trip `SENSITIVE_KEY` redaction
**What goes wrong:** A sample stores `[REDACTED]` where a value was expected, and the readback comparison or the deep-equal test fails.
**Why it happens:** `redactValue` replaces the whole value of any key matching `/(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|credential|private[_-]?key)/i`, unless the key is a counter key with a numeric value [VERIFIED: redact.ts:66, 82-83, 98-108].
**How to avoid:** None of the CONTEXT payload keys match (`transcript_ref`, `herdr_type`, `content_sha256`, `text_sha256`, `tx_sig`, `pr_url`, …). Keep it that way, and let the deep-equal test enforce it. Bare 64-hex and base58 values match no current rule [VERIFIED: redact.ts:18-50]. Phase 18 confirmed by peer message that its ported rules all need literal prefixes and do not widen `SENSITIVE_KEY` [CITED: agent message from Phase18DiscussPlan.Research18, 2026-10-08].
**Warning signs:** `[REDACTED]` in a readback payload.

### Pitfall 4: "action" means two things
**What goes wrong:** The doc-vs-table test or a later mapper treats `desktop_run`'s `payload.action` (`click`/`type`/`key`/`screenshot`) as a component discriminator, or rejects it.
**Why it happens:** CONTEXT keeps `payload.action` as the discriminator for self-recorded `note`/`warning` events. For the `desktop_run` `tool.call` it is the desktop action [CONTEXT mapping table]. Lease events already use `action` for `released`/`forced`/`stolen`/`expired`.
**How to avoid:** Model `actions` as the set of permitted `payload.action` values per row, not as a single discriminator. The doc column lists all of them.

### Pitfall 5: The baseline commit is absent in a shallow clone
**What goes wrong:** `git show ab62c91:…` fails in a depth-1 clone (a cloud agent, for example), and a naive script treats "no baseline" as "no diff".
**How to avoid:** Exit 2 with an explicit message. Never fetch, because the CONTEXT forbids it. The plain-`bun test` literal lock still covers that clone.

### Pitfall 6: Adding planned-but-unserved names to the policy sets
**What goes wrong (feared):** An existing test asserts the sets equal the served tools.
**Finding:** No such test exists. The only consumers of the sets and of `auditMode` are `policy.test.ts`, `chaos.test.ts` (`auditMode` on existing tools), `observe.ts:371,396`, `server.ts:181` and the re-export in `packages/audit/src/index.ts:50-52` [VERIFIED: grep this session]. `observe.ts` `KNOWN_TOOLS` is a separate set (observe.ts:309), and `toolLabel` maps unknown names to `"unrecognized"`; that is untouched, and planned tools label as `unrecognized` until their phase registers them. The "unknown tool is fail-closed" test uses `"some_new_tool"` and `""` (policy.test.ts:23-24), neither of which is planned.
**What does need editing:** The prose claim "The two sets below are exhaustive over the tools in `mcp.ts` and the REST routes in `server.ts`" (policy.ts:39-41), and the line "**Both lists are exhaustive over the tools this substrate serves**" (docs/mcp-audit.md:233). Both should say the sets are exhaustive over served tools **plus** the tools v1.3 plans, marked by phase.

### Pitfall 7: Run tags and the `rh-` production-count proof
**What goes wrong:** A run tag that does not start with `rh-` escapes Phase 16's operator-approved "rh- tag count in production must be 0" convention.
**How to avoid:** Use `rh-vocab-<epoch-ms>` for `graph_id`, and `rh-vocab-<epoch-ms>-<entry id>` for `session_id`. That is about 60 chars, well under `MAX_FIELD = 512`. One session per sample keeps every chain one event long, so `lastHash` lookups stay trivial.

### Pitfall 8: `skills.propose` sample carries `repo`
**What goes wrong:** Someone reads the "periodic rows carry no repo" test as "no row carries repo" and strips it.
**How to avoid:** Test `!(entry.periodic && sample.repo)` and `Boolean(sample.repo) === entry.carriesRepo`. The CONTEXT sets `repo` for herdr detected/status, Muse tool call and `skills.propose`. The existing lease release events already carry repo via `placeOf`.

## Code Examples

### Lock test (literal, ordered)
```ts
// Source: values VERIFIED from packages/mcp-server/src/types.ts:11-63
import { expect, test } from "bun:test";
import { EVENT_KINDS, SURFACES } from "./types.ts";

test("EVENT_KINDS is the v1.2 closed set, in order", () => {
	expect([...EVENT_KINDS]).toEqual([
		"session.start", "prompt", "claim", "tool.call", "file.edit", "shell",
		"commit", "pr", "handoff", "session.end", "note", "warning",
	]);
});

test("SURFACES is the v1.2 closed set, in order", () => {
	expect([...SURFACES]).toEqual([
		"claude-code", "cursor", "hermes", "omp", "muse", "grok-build", "grok-bot", "codex", "opencode", "pi", "rivet-agentos",
		"swarm-a01-orch", "swarm-a02-req", "swarm-a03-arch", "swarm-a04-uxd", "swarm-a05-be", "swarm-a06-fe", "swarm-a07-data",
		"swarm-a08-qa", "swarm-a09-rev", "swarm-a10-sec", "swarm-a11-devops", "swarm-a12-rel", "swarm-a13-obs", "swarm-a14-maint",
		"swarm-a15-doc",
	]);
});
```

### Sample round-trip through the real write-path gate
```ts
// Source: normalizeEvent signature VERIFIED event.ts:124 `normalizeEvent(input: EventInput, prev: string | null)`
import { normalizeEvent } from "./event.ts";
import { EVENT_SOURCES } from "./event-sources.ts";

test("every sample is stored as written: same kind, surface and payload", () => {
	for (const source of EVENT_SOURCES) {
		const sample = source.sample();
		const stored = normalizeEvent(sample, null);
		expect({ id: source.id, kind: stored.kind, surface: stored.surface, payload: stored.payload })
			.toEqual({ id: source.id, kind: source.kind, surface: sample.surface, payload: sample.payload ?? {} });
	}
});
```

### Roadmap-source coverage
```ts
const ROADMAP_SOURCES = ["herdr.", "muse.", "cursor.stop", "skills.propose", "docs.ingest", "desktop.", "anchor.", "teachable."];
test("every source the roadmap names has a row", () => {
	for (const prefix of ROADMAP_SOURCES) expect({ prefix, rows: EVENT_SOURCES.some((s) => s.id.startsWith(prefix)) })
		.toEqual({ prefix, rows: true });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| September branch widened `EVENT_KINDS` with `"agent.detected", "agent.status", "agent.exited", "brief.delivered", "release", "complete", "skill.propose", "docs.ingest", "desktop.action"` [VERIFIED: `git show acc30a8:packages/mcp-server/src/types.ts` lines 20-42] and a `"herdr"` surface (`acc30a8:packages/collectors/src/herdr-map.ts:58`) | Closed 12 kinds / 26 surfaces. New sources map onto them with `payload.action`/`runtime`/`herdr_type` | Operator decision for v1.3 (REQUIREMENTS.md:16) | Every September port (Phases 19–33) rewrites kind/surface and keeps payload fields |
| September herdr types `pane.agent_detected`, `pane.agent_status_changed`, `pane.exited`, `pane.output_matched` → own kinds [VERIFIED: acc30a8 herdr-map.ts:63-103] | → `session.start` / `note` / `session.end` / `note`, with `herdr_type` carrying the exact type | Phase 17 | Phase 19 mapper tests against `EVENT_SOURCES` |
| September desktop recorded typed text as `text_chars` + `text_sha256`, screenshots as `screenshot_sha256` [VERIFIED: acc30a8 desktop/driver.ts:287,308] | CONTEXT fixes `text_len` + `text_sha256`, and `sha256`, `width`, `height` | Phase 17 | Phase 30 renames fields when porting; the table is the contract |
| Cursor stop: `session.end` with `conversation_id`, `transcript_ref`, `status`, `reason` [VERIFIED: acc30a8 cursor-stop.ts:141-171] | Same payload, surface `cursor`, `actor: "human"` (projector hook precedent, projector/src/cursor.ts:46) | — | Ports unchanged apart from attribution |

**Deprecated/outdated:** ARCHITECTURE research rows that add kinds (`herdr`, `agent.*`, `brief.delivered`, `skill.propose`, `docs.ingest`, `desktop.action`) are superseded (CONTEXT "Specific Ideas").

## Runtime State Inventory

Not a rename or migration phase. Included only to rule out state that would outlive a code change.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None. Phase 17 writes only to scratch Greptime via the harness, and that store is discarded by `rehearsal down` (tmpfs, 16-CONTEXT.md:42) | none |
| Live service config | None. No production emit or tool registration in this phase | none |
| OS-registered state | None | none |
| Secrets/env vars | Reads `SUBSTRATE_URL`/`SUBSTRATE_TOKEN` by name from the harness `consumer.env` only; no new variable | none |
| Build artifacts | None | none |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Greptime v0.14.4 standalone shows an inserted row to an immediate `SELECT`; a short retry covers any lag | Pattern 4 | Readback flakes; mitigated by bounded retry |
| A2 | Phase 16's `toShellExports` writes exactly `export KEY='value'` with POSIX `'\''` escaping (the plan says "single-quoted export KEY equals value lines" but shows no literal) | Pattern 4 | The parser misses keys and the smoke exits 2. Mitigation: at execution time, check the merged `rehearsal-env.ts` `toShellExports` and its test, and align the regex |
| A3 | The Phase 16 harness merges (or is on the executing branch) before Phase 17's proof wave | Validation | The proof wave blocks. Wave 1 is unaffected |
| A4 | `POST /events` returns 400 for `InvalidEventError` (from CONTEXT; the catch block was not re-read this session) | Pattern 4 | Only the refusal path's status changes; the smoke treats any non-202 as a refusal anyway |
| A5 | The recommended `EVENT_SOURCES` ids, split rows and `SILENT_SOURCES` list are my design inside the CONTEXT discretion; they are not operator-confirmed | Pattern 1 | Cosmetic; later phases test against whatever ids ship |

## Open Questions

1. **Does Phase 16 export a reusable smoke URL guard / `consumer.env` reader?**
   - What we know: 16-03 plans a "smoke URL guard" inside `scripts/rehearsal.ts` and `toShellExports` in `rehearsal-env.ts`. Neither name is pinned for reuse, and neither is on `main`.
   - Recommendation: Phase 17 ships its own `refuseTarget` and `parseConsumerEnv` with tests. A later cleanup may dedupe once both are on `main`, but do not create that coupling now.
2. **Should `phase-close-check` also diff `SURFACES` against the baseline?**
   - What we know: CONTEXT locks the `EVENT_KINDS` diff. `SURFACES` is pinned by the literal test. In the git blob, `SURFACES` uses `...SWARM_SURFACES`, so the regex parse must expand it.
   - Recommendation: optional and cheap (parse both blocks, substitute the spread). Leave it to the planner. It is not required by SC-3.
3. **Proof command line.** CONTEXT writes `bun run smoke:vocabulary` without `--name`. The smoke must resolve the `p17` instance, so the plan should run `bun run smoke:vocabulary --name p17` (Bun forwards trailing args to the script). The alternative is defaulting `--name` to `default`, matching the harness default.
4. **Lane A uses `claude-code` while `rivet-agentos` is a surface** [VERIFIED: types.ts:41]. CONTEXT locks `claude-code` + `runtime: "agentos"`, because the agent in the VM is Claude Code. Record the reason in the doc, so a reviewer does not "fix" it.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | all tests/scripts | ✓ | 1.4.0 | — |
| git (with `ab62c91` reachable) | phase-close-check | ✓ | object present; ancestor of HEAD | exit 2 in shallow clones |
| Docker | proof wave (via Phase 16 harness) | ✓ | 29.6.2 | — |
| `postgres:16-alpine`, `greptime/greptimedb:v0.14.4` images | proof wave | ✓ (both present locally) | — | none (harness is `--pull never`) |
| Free disk | harness preflight (~2 GB floor) | ✓ | 20 GB free on `/` (95% used) | — |
| Port 17410 | harness default | ✓ free at research time | — | `--port 0` |
| Phase 16 `scripts/rehearsal.ts` on branch | proof wave | ✗ (planned, not merged) | — | none; proof wave waits (A3) |

**Missing dependencies with no fallback:** The Phase 16 harness on the executing branch, for the proof wave only.
**Missing dependencies with fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `bun:test` (Bun 1.4.0) |
| Config file | none (root `bun test` discovery; `tsconfig.json:16` includes `scripts/**/*.ts`) |
| Quick run command | `bun test ./packages/mcp-server/src/vocabulary-lock.test.ts ./packages/mcp-server/src/event-sources.test.ts ./packages/audit/src/policy.test.ts ./scripts/phase-close-check.test.ts ./scripts/vocabulary-smoke.test.ts ./packages/mcp-server/src/store-lock.test.ts` |
| Full suite command | `bun test && bunx tsc --noEmit` (baseline at `ab62c91`: 1129 pass / 56 skip / 0 fail across 40 files, tsc clean; STATE.md:33) |
| Phase gate | `bun run check:phase-close` (exit 0) + isolated proof |

### Phase Requirements → Test Map
| Req / SC | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FOUND-02 / SC-1 | Doc's marked table and `EVENT_SOURCES ∪ SILENT_SOURCES` name the same ids, kinds and actions | unit | `bun test ./packages/mcp-server/src/event-sources.test.ts` | ❌ Wave 0 |
| FOUND-02 / SC-1 | Every roadmap source (herdr, Muse, Cursor stop, skills propose, docs ingest, desktop, anchoring, teachables) has ≥1 row | unit | same | ❌ Wave 0 |
| FOUND-02 / SC-1 | Repo rule: periodic rows carry no `repo`; `carriesRepo` matches the sample | unit | same | ❌ Wave 0 |
| FOUND-02 / SC-1 | No-content rule: no sample payload key in {`text`, `content`, `body`, `bytes`, `image`, `png`} (discretion, recommended) | unit | same | ❌ Wave 0 |
| FOUND-02 / SC-2 | `EVENT_KINDS` literal (12, ordered) and `SURFACES` literal (26, ordered) | unit | `bun test ./packages/mcp-server/src/vocabulary-lock.test.ts` | ❌ Wave 0 |
| FOUND-02 / SC-2 | Every sample passes `normalizeEvent` with kind, surface and payload unchanged | unit | `bun test ./packages/mcp-server/src/event-sources.test.ts` | ❌ Wave 0 |
| FOUND-02 / SC-2 | Smoke guards: `refuseTarget` refuses 7410/7411/6420 and non-loopback hosts, accepts `127.0.0.1:17410`; `parseConsumerEnv` round-trips quoted values incl. `'\''`; run-tag helper keeps ids `rh-` prefixed and ≤ 512 chars | unit | `bun test ./scripts/vocabulary-smoke.test.ts` | ❌ Wave 0 |
| FOUND-02 / SC-2 | One sample per mapped source stored over the wire, 0 refusals, readback N/N | live-isolated (Docker, Phase 16 harness) | `bun run rehearsal up --name p17 && bun run smoke:vocabulary --name p17; bun run rehearsal down --name p17` | ❌ proof step |
| FOUND-02 / SC-3 | `parseEventKinds` extracts the 12 kinds from the baseline blob text; `diffKinds` reports index-level changes; `missingFiles` catches an absent test file | unit | `bun test ./scripts/phase-close-check.test.ts` | ❌ Wave 0 |
| FOUND-02 / SC-3 | Phase-close check passes on this phase | script | `bun run check:phase-close` | ❌ Wave 0 |
| FOUND-02 / SC-3 | Store lock still green with new scripts and docs | unit (existing) | `bun test ./packages/mcp-server/src/store-lock.test.ts` | ✅ |
| FOUND-02 / SC-4 | Each planned tool is explicitly in its decided set and not in the other; `auditMode` equals the decision | unit | `bun test ./packages/audit/src/policy.test.ts` | ✅ (file exists; new test ❌ Wave 0) |
| FOUND-02 / SC-4 | Every `registerTool` / `auditedRest` name is in exactly one set (discretion, recommended) | unit | same | ❌ Wave 0 |
| FOUND-02 / SC-4 | Existing policy tests (overlap, default-deny, reads fail-open) unchanged and green | unit (existing) | same | ✅ |

Negative checks for the verifier (each should make the named test fail; do them by temporary local edit, never committed):
- Append `"agent.detected"` to `EVENT_KINDS` → `vocabulary-lock.test.ts` fails, and `check:phase-close` exits 1 with `[12] ∅ → agent.detected`.
- Edit both `EVENT_KINDS` and the lock literal → `check:phase-close` still exits 1 (git baseline diff).
- Delete `"desktop_run"` from `FAIL_CLOSED_TOOLS`, or move it to `FAIL_OPEN_TOOLS` → `policy.test.ts` fails.
- Rename `event-sources.test.ts` → `check:phase-close` exits 2 (missing file), not 0.
- Change a doc row's kind → `event-sources.test.ts` fails.

### Sampling Rate
- **Per task commit:** quick run command above (< 2 s; store-lock + policy measured at 177 ms this session).
- **Per wave merge:** `bun test && bunx tsc --noEmit`.
- **Phase gate:** `bun run check:phase-close` exit 0, then the isolated proof (`rehearsal up --name p17` → `smoke:vocabulary --name p17` → `check:phase-close` → `rehearsal down --name p17`; afterwards `docker ps -a --filter label=substrate.rehearsal=p17` is empty).

### Wave 0 Gaps
- [ ] `packages/mcp-server/src/vocabulary-lock.test.ts`: SC-2 literal pins
- [ ] `packages/mcp-server/src/event-sources.test.ts`: SC-1/SC-2 table, doc and sample tests
- [ ] `scripts/phase-close-check.test.ts`: SC-3 pure helpers
- [ ] `scripts/vocabulary-smoke.test.ts`: SC-2 guard/parser
- [ ] `packages/audit/src/policy.test.ts`: new planned-tools test (+ optional scan)
- No framework install needed.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (uses existing bearer tokens; no change) | `surfaceForToken` unchanged |
| V3 Session Management | no | — |
| V4 Access Control | yes (attribution) | `attributedSurface` unchanged. Samples rely on non-swarm body attribution. `skills_propose` surface is "never body-supplied" (enforced in Phase 21, documented here) |
| V5 Input Validation | yes | `normalizeEvent` closed enums + caps; samples are proven against it |
| V6 Cryptography | no (sha256 only as content fingerprints, computed by later phases) | `node:crypto` `createHash` when needed |
| V7 Error Handling & Logging | yes | Audit modes via `auditMode`. Fail-closed for publication/actuation tools, fail-open for reads |
| V8 Data Protection | yes | Hashes/lengths never content; the smoke prints no token or reply bodies; nothing secret in tracked files (store lock) |
| V14 Configuration | yes | Store lock unchanged; no Greptime key in new scripts; smoke reads only scratch `consumer.env` |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Smoke aimed at production :7410 writes 28 fake events into the real ledger | Tampering | `refuseTarget` before any request; ignore `process.env`; read only the named instance's `consumer.env`; no default URL |
| Token printed in smoke/phase-close output or committed in docs | Information disclosure | Print ids, counts, statuses only. `TOKEN_LITERAL` lock covers tracked files |
| A write tool lands later with no audit decision and runs fail-open | Elevation / Repudiation | Default-deny `auditMode` (unchanged), explicit planned entries, `registerTool` scan guard |
| A read misclassified fail-closed, so an audit-sink outage takes out reads | Denial of service | Planned reads in `FAIL_OPEN_TOOLS`; test asserts explicit membership |
| Enum widened in a later PR, which changes hash-chain semantics silently | Tampering | Literal lock + git baseline diff in every phase's verification |
| Sensitive content (typed text, screenshots, skill bodies) in the append-only ledger | Information disclosure | Mapping rule: hashes and lengths only; no-content key test on samples |
| Phase-close check mutates the shared `.git` (index refresh, fetch) | Tampering (operator checkout) | `git --no-optional-locks` + `GIT_OPTIONAL_LOCKS=0`, `show` only, fixed argv, no fetch/checkout |

## Sources

### Primary (HIGH confidence, read this session)
- `packages/mcp-server/src/types.ts:11-85`: enums and `EventInput`
- `packages/mcp-server/src/event.ts:52-55, 82-84, 108-159`: caps, `normalizeEvent`
- `packages/mcp-server/src/redact.ts:1-110`: rules, `SENSITIVE_KEY`, `COUNTER_KEY`
- `packages/mcp-server/src/mcp.ts:70-97, 372-407`: attribution, `events_query` schema; registerTool name probe
- `packages/mcp-server/src/server.ts:200-370`: `auditedRest`, `/events`, `/events/query`
- `packages/mcp-server/src/service.ts:540-642, 825-834, 1040-1066, 1123-1132`: emit, queryEvents, graph_bind note, release and reaper events
- `packages/mcp-server/src/greptime.ts:75-76, 529-551`: limits, exact-match WHERE
- `packages/mcp-server/src/brief.ts:148-164`: repo recent-actions query excludes session kinds
- `packages/mcp-server/src/drift.ts:38, 382-397`: `WORK_KINDS`, `work.unclaimed`
- `packages/mcp-server/src/lease.ts:399-411`: release decision actions
- `packages/mcp-server/src/store-lock.test.ts:72, 95-131, 249-362`: scans
- `packages/mcp-server/src/authority.test.ts:220-227`: SURFACES pin
- `packages/mcp-server/src/git.ts:17-49`: spawn pattern
- `packages/audit/src/policy.ts`, `policy.test.ts`: sets, tests
- `packages/collectors/src/grok-map.ts:9, 89-155`; `packages/projector/src/cursor.ts:42-47`
- `scripts/chaos-smoke.ts:51-120`; `scripts/greptime-smoke.ts:33-37`; `package.json`; `tsconfig.json`
- `docs/mcp-audit.md:222-239`; `docs/swarm-correlation.md:164-168`; `docs/adr/0001-…md:601`
- `git show acc30a8:` `types.ts`, `collectors/src/herdr-map.ts`, `collectors/src/cursor-stop.ts`, `mcp-server/src/desktop/driver.ts`
- Bun 1.4.0 probes: missing-file test filter behavior; lock tests pass (30 pass, 177 ms)

### Secondary (MEDIUM: planned, not merged)
- `.planning/phases/16-*/16-CONTEXT.md`, `16-01-PLAN.md`, `16-03-PLAN.md`, `16-PATTERNS.md`, `16-RESEARCH.md:445-448`: harness, `consumer.env`, guard contracts

### Tertiary (LOW)
- Greptime read-after-write timing (A1), not probed

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. No new dependencies; Bun/tsc/git verified in place.
- Architecture: HIGH. Every integration point read; the only planned-not-merged input (Phase 16) is isolated behind a self-contained guard.
- Pitfalls: HIGH. Bun missing-file behavior and store-lock regexes verified by probe/read; redaction keys checked against `redact.ts`.

**Research date:** 2026-10-08
**Valid until:** 2026-11-07 (stable internal code; re-check Phase 16 `toShellExports` format when it merges)
