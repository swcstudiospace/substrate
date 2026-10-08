# Phase 17: Event vocabulary and audit policy - Context

**Gathered:** 2026-10-08
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). Mapping new sources onto the existing kinds and surfaces is already the operator's decision ("`EVENT_KINDS` stays unchanged", REQUIREMENTS "Vocabulary"). One residual attribution choice is listed for the operator under "Open for the operator"; the plan uses the recommended answer unless the operator overrides it.

<domain>
## Phase Boundary

One PR on agent-substrate (FOUND-02) that settles policy before any v1.3 source or tool ships:

1. **Event mapping.** Every event source v1.3 adds has a documented, tested mapping onto the existing 12 `EVENT_KINDS` and the existing 26 `SURFACES`. The mapping is written down once, in `docs/event-vocabulary.md`, and encoded once, in a typed table inside `packages/mcp-server/src`. Later phases implement against that table and add no kind and no surface.
2. **Vocabulary lock and phase-close check.** A test pins `EVENT_KINDS` (and `SURFACES`) to their v1.2 values. A phase-close check runs `store-lock.test.ts` and diffs `EVENT_KINDS` against the v1.2 baseline commit. It passes on this phase and every later phase runs it.
3. **Sample emits.** Against the Phase 16 rehearsal harness, one sample event per mapped source is posted to `POST /events` and stored, with zero refusals.
4. **Audit policy.** `packages/audit/src/policy.ts` records fail-open or fail-closed for every MCP tool v1.3 plans to add, and `policy.test.ts` fails when a planned tool has no entry or has the opposite decision.

**Out of scope:**
- The tools, routes and collectors themselves (Phases 19–33). Phase 17 does not touch `mcp.ts` tool registration or `observe.ts` `KNOWN_TOOLS`; each tool's phase does those two registrations and inherits the audit mode decided here.
- Any change to `EVENT_KINDS`, `SURFACES`, `normalizeEvent`, `MEMORY_KINDS` or the hash chain.
- The shared redactor (Phase 18), production tokens (Phase 20).
- Fixing live producers in other repos (hermes-engineering-board, see Deferred).

**Depends on Phase 16:** the sample-emit proof runs against `bun run rehearsal up|smoke|down` and its `consumer.env`. Phase 16 is planned but not merged; Phase 17's proof plan runs only once the harness is on the branch it executes from.

</domain>

<decisions>
## Implementation Decisions

### Mapping rules (apply to every source)
- **Closed vocabulary, both enums.** No kind and no surface is added; `normalizeEvent` (`event.ts:124-131`) keeps refusing anything else. A source with no fitting surface is not emitted under a wrong one: it is dropped and counted by its emitter (LANEB-05 / A-T5 counting).
- **`payload.action` is the discriminator** for events a component records about itself, following main's existing use (`service.ts:1130` `action: "expired"`, lease events' `action: "released" | "stolen"`). September's would-be kinds become `payload.action` values: `skill.propose`, `docs.ingest`, `docs.search`, `teachable`, `anchor`, `mirror`, `dispatch`, `approval`, `skills.sync`.
- **`payload.runtime` names a non-agent producer** acting for an agent or for the host (`herdr`, `agentos`, `anchor`, `dispatcher`, `skills-sync`), as LANEB-02 already fixes for herdr.
- **The original type always travels.** Where a source has its own event type (herdr's `pane.*`), the exact type is kept in a payload field (`payload.herdr_type`), the v1.1 swarm precedent (`payload.swarm_type`, ADR 0001 risk table). An unmapped type is a test failure in that source's mapper, not a silent `note`; at runtime an unknown herdr type still becomes a `note` carrying `herdr_type`, as `grok-map.ts`'s default does.
- **Success is `note`, refusal or failure is `warning`.** Work an agent does is the work kind (`tool.call`, `session.start`, `session.end`). A refusal records rule names, reasons and hashes only, never the refused value (`auditMemoryWrite` precedent, `service.ts:719-748`).
- **Never content, only hashes and lengths** for anything sensitive: typed desktop text (length + sha256), screenshots (sha256 + dimensions, never bytes), teachables and skills (`content_sha256`), docs pages (`content_sha256`, source URL).
- **`repo` is set only where the event is work in that repo.** `brief.ts:150-157` lists the last actions per repo (every kind except `session.start`/`session.end`), so any periodic event carrying `repo` crowds a repo's brief.

### The mapping (one row per v1.3 source)

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

### Where the mapping lives and how it is enforced
- **One typed table:** `packages/mcp-server/src/event-sources.ts` exports `EVENT_SOURCES`, one entry per row above: `source`, `phase`, `kind`, `surface` rule, the `action`/`runtime` values, and a `sample()` returning a concrete `EventInput`. It imports `EventKind`/`Surface` from `types.ts`, so a kind outside the enum is a type error.
- **One document:** `docs/event-vocabulary.md` holds the table above with each rule's reason, the closed-enum rule, and the phase-close check. A test asserts the document's table and `EVENT_SOURCES` name the same sources, kinds and actions, so they cannot drift.
- **Tests in `event-sources.test.ts`:** every `sample()` passes `normalizeEvent` unchanged in kind and surface; every source named in the roadmap (herdr, Muse, Cursor stop, skills propose, docs ingest, desktop actions, anchoring, teachables) has at least one row; every row whose `repo` is set is work in that repo (no periodic job carries `repo`).
- **Later phases' mappers test against the table.** For example the Phase 19 herdr mapper asserts its output kind and action equal the `EVENT_SOURCES` row. The table is the contract; changing it is a reviewed change to `docs/event-vocabulary.md` in the same PR.

### Vocabulary lock and the phase-close check
- **`vocabulary-lock.test.ts`** in `packages/mcp-server/src` pins `EVENT_KINDS` to the v1.2 literal, in order (12 kinds), and `SURFACES` to its v1.2 literal (26 surfaces; the existing `authority.test.ts:220-227` already pins the count and order and stays). It runs in plain `bun test`, so every phase's normal verification already catches a change.
- **`scripts/phase-close-check.ts`, run as `bun run check:phase-close`.** It:
  1. runs `bun test packages/mcp-server/src/store-lock.test.ts packages/mcp-server/src/vocabulary-lock.test.ts packages/mcp-server/src/event-sources.test.ts packages/audit/src/policy.test.ts`;
  2. reads the `EVENT_KINDS` block from `git show ab62c91:packages/mcp-server/src/types.ts` (the v1.2 baseline named in STATE.md) and diffs it against the imported `EVENT_KINDS`, printing the diff on failure;
  3. exits 0 only if both pass. Git calls use `--no-optional-locks` and only read objects; it never fetches or checks out.
- **Every later phase runs it.** `docs/event-vocabulary.md` states it, and the orchestrator adds `bun run check:phase-close` to the verification of Phases 18–33 (ROADMAP bookkeeping is the orchestrator's; this phase does not edit ROADMAP or STATE).

### Sample-emit proof against the Phase 16 harness
- **`scripts/vocabulary-smoke.ts`, run as `bun run smoke:vocabulary`.** It sources only the harness's `consumer.env`, refuses a `SUBSTRATE_URL` on port 7410 or a non-loopback host (the Phase 16 smoke guard), posts every `EVENT_SOURCES` sample to `POST /events` with `SUBSTRATE_TOKEN`, and requires `202` with `stored: true` for each. Any 4xx (an unknown kind or surface) or 503 fails the run, and the count of refusals is printed (must be 0).
- **Attribution in the proof.** A non-swarm token may name another surface on `/events` (`attributedSurface`, `mcp.ts:91-97`), so the harness's default token (a non-swarm surface) can post every sample's own surface; no harness flag is needed.
- **Run-tagged.** Every sample's `session_id` and `graph_id` carry a `rh-vocab-<timestamp>` tag, and the script reads them back through `POST /events/query` to confirm one stored row per source.
- **Proof run:** `bun run rehearsal up --name p17` → `bun run smoke:vocabulary` → `bun run check:phase-close` → `bun run rehearsal down --name p17`. Isolated, no live system, no operator approval needed.

### Audit policy for the tools v1.3 adds
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

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/types.ts:30-64`: `SURFACES` (11 agents + 15 swarm = 26) and `EVENT_KINDS` (12). Unchanged since `660c56e`; v1.2 baseline commit `ab62c91`.
- `packages/mcp-server/src/event.ts:124-159`: `normalizeEvent` throws `InvalidEventError` on an unknown surface or kind; redacts and caps every field. The sample test drives it directly.
- `packages/mcp-server/src/mcp.ts:91-97`: `attributedSurface` — non-swarm callers keep body-first attribution; swarm tokens cannot name another surface.
- `packages/mcp-server/src/server.ts:330-358`: `POST /events` returns `202 {stored: true}` or `503`; `400` on an invalid event.
- `packages/collectors/src/grok-map.ts`: the existing mapper shape (`tool.call` with `tool`, `outcome`, `duration_ms`; default `note` for unknown types).
- `packages/projector/src/cursor.ts:44-46`: Cursor hooks already emit `tool.call` and `session.end` as `cursor`, `actor human`.
- `packages/audit/src/policy.ts:16-80` and `policy.test.ts`: the two sets, default-deny `auditMode`, and tests over reads, REST routes, and overlap.
- `docs/swarm-correlation.md` "The closed enum" and ADR 0001's risk table: the v1.1 precedent of mapping onto the closed set with the original type in the payload.
- Phase 16's `scripts/rehearsal.ts` and `consumer.env` (planned): `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, loopback/7410 guard.
- September reference (`acc30a8`): `herdr-map.ts`, `collectors/muse.ts` (`brief.delivered`), `cursor-stop.ts` (`session.end`), `service.ts` `proposeSkill` (`skill.propose` payload), `desktop/driver.ts` (`desktop.action` payload). Their payload fields carry over; their kinds and surfaces do not.

### Established Patterns
- `payload.action` as the discriminator inside `note`/`warning` (lease events, reap `expired`).
- Refusals as `warning` with decision, reason and ids, never the body (`auditMemoryWrite`).
- Server-side events without an agent session get their own one-event session (`graph_bind`).
- Tests live beside sources (`*.test.ts`), Bun test; scripts in `scripts/` exposed via `package.json` (`smoke:greptime`, `smoke:chaos`).
- Store lock: no `GREPTIME_` outside `packages/mcp-server/src`; the smoke talks only to `SUBSTRATE_URL`.

### Integration Points
- New: `packages/mcp-server/src/event-sources.ts`, `event-sources.test.ts`, `vocabulary-lock.test.ts`; `scripts/vocabulary-smoke.ts`, `scripts/phase-close-check.ts`; `docs/event-vocabulary.md`.
- Edited: `packages/audit/src/policy.ts`, `policy.test.ts`; `docs/mcp-audit.md`; `package.json` (`smoke:vocabulary`, `check:phase-close`; Phase 16 also adds scripts there, so expect a trivial merge).

</code_context>

<specifics>
## Specific Ideas

- The research documents disagree (SUMMARY D1): ARCHITECTURE's port map adds `herdr`, `agent.*`, `brief.delivered`, `skill.propose`, `docs.ingest`, `desktop.action`; FEATURES A-T2 maps onto existing kinds. The operator's decision is to map; every September kind in `acc30a8:packages/mcp-server/src/types.ts` is therefore re-expressed above, and ARCHITECTURE rows 65, 68, 97 and G's "add `desktop.action`" are superseded.
- Live producers that main refuses today (FEATURES P3): the herdr collector (`herdr`, `agent.*`) and the Muse writer (`brief.delivered`) are fixed by Phase 19 porting onto this mapping.
- The phase is "no later phase adds an event kind": the proof is the lock test in plain `bun test` plus the phase-close check, not a promise.

</specifics>

<deferred>
## Deferred Ideas

- **hermes-engineering-board** (`substrate_client.py:24`, FEATURES P3) emits as surface `hermes-eng-board`, which main refuses. Its mapping is surface `hermes` with `payload.runtime: "eng-board"`, recorded in `docs/event-vocabulary.md`; the fix is a change in that plugin's repo, which no v1.3 phase owns. Raise with the operator.
- Per-action event durability for `desktop_run` (stop the run when an action's event is not stored, versus continue and report) is Phase 30's decision; the recommendation recorded for it is to stop, since the tool is fail-closed and DESK-02 requires one event per action.
- A dedicated non-agent surface (for example `substrate`) for host jobs would need a reviewed `SURFACES` change; not taken in v1.3.

</deferred>

## Open for the operator

- **Which existing surface do host jobs (the anchor timer, skills sync, the dispatcher) emit under?** `SURFACES` stays closed, so a job must borrow an agent surface, and that surface is what `events_query` and the brief show. Recommendation: each job emits under the surface of the token Phase 20's identity runbook assigns it, with `payload.runtime` naming the job; the default for a job with no assigned token is `claude-code`, the fallback main already uses for unattributed server events (`attributedSurface(null)`, the reaper and `graph_bind`). Alternative: add a `substrate` surface in a dedicated reviewed PR. The plan proceeds with the recommendation.
