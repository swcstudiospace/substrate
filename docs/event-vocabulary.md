# Event vocabulary (Phase 17)

Every event source v1.3 adds maps onto the existing 12 `EVENT_KINDS` and onto
`SURFACES` — which gains exactly one reviewed system surface, `substrate`, for
host jobs — instead of inventing kinds. This document is the reviewed mapping;
`packages/mcp-server/src/event-sources.ts` encodes the same mapping as the
typed `EVENT_SOURCES` table, and `event-sources.test.ts` asserts the two name
the same sources, kinds and actions, so they cannot drift. Later phases
implement against that table and add no kind and no surface (FOUND-02).

## Mapping rules

These apply to every source:

- **Closed vocabulary, both enums.** No kind is added; the only surface added
  is `substrate` (host jobs, operator decision 2026-10-08). `normalizeEvent`
  keeps refusing anything else. A source with no fitting surface is not
  emitted under a wrong one: it is dropped and counted by its emitter.
- **Host jobs emit as `substrate`.** The hourly anchor, the skills sync, the
  dispatcher and any other non-agent host job emit under surface `substrate`,
  with `payload.runtime` naming the job (`anchor`, `skills-sync`,
  `dispatcher`, …). A `substrate` token is bound to its surface exactly like a
  swarm token: `attributedSurface` refuses it naming any other surface.
- **`payload.action` is the discriminator** for events a component records
  about itself, following the existing use (`action: "expired"` on the reap
  event, `"released"` / `"stolen"` on lease events). New concepts become
  `payload.action` values, never kinds: `skill.propose`, `docs.ingest`,
  `docs.search`, `teachable`, `anchor`, `mirror`, `dispatch`, `approval`,
  `skills.sync`, `dod`.
- **`payload.runtime` names a non-agent producer** acting for an agent or for
  the host (`herdr`, `agentos`, `anchor`, `dispatcher`, `skills-sync`).
- **The original type always travels.** Where a source has its own event type
  (herdr's `pane.*`), the exact type is kept in a payload field
  (`payload.herdr_type`), the v1.1 swarm precedent (`payload.swarm_type`). An
  unmapped type is a test failure in that source's mapper, not a silent
  `note`; at runtime an unknown herdr type still becomes a `note` carrying
  `herdr_type`.
- **Success is `note`, refusal or failure is `warning`.** Work an agent does
  is the work kind (`tool.call`, `session.start`, `session.end`). A refusal
  records rule names, reasons and hashes only, never the refused value.
- **Never content, only hashes and lengths** for anything sensitive: typed
  desktop text (length plus sha256), screenshots (sha256 plus dimensions,
  never bytes), teachables and skills (`content_sha256`), docs pages
  (`content_sha256`, source URL).
- **`repo` is set only where the event is work in that repo.** The brief
  lists recent actions per repo, so any periodic event carrying `repo` would
  crowd a repo's brief. No periodic row carries `repo`.

## The mapping

<!-- event-sources:start -->

| id | phase | kind | surface | action | runtime | repo | periodic |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `herdr.agent_detected` | 19 | `session.start` | `herdr-agent` | — | `herdr` | pane cwd slug | no |
| `herdr.status_changed` | 19 | `note` | `herdr-agent` | — | `herdr` | pane cwd slug | no |
| `herdr.pane_exited` | 19 | `session.end` | `herdr-agent` | — | `herdr` | — | no |
| `herdr.other` | 19 | `note` | `herdr-agent` | — | `herdr` | — | no |
| `muse.tool_call` | 19 | `tool.call` | `muse` | — | — | pane cwd slug, plus branch | no |
| `cursor.stop` | 19 | `session.end` | `cursor` | — | — | — | no |
| `skills.propose` | 21 | `note` | `caller` | `skill.propose` | — | `swcstudiospace/agent-skills` | no |
| `skills.propose.refused` | 21 | `warning` | `caller` | `skill.propose` | — | — | no |
| `skills.sync.refused` | 22 | `warning` | `substrate` | `skills.sync` | `skills-sync` | — | yes |
| `docs.search` | 25 | `note` | `caller` | `docs.search` | — | — | no |
| `docs.search.failed` | 25 | `warning` | `caller` | `docs.search` | — | — | no |
| `docs.ingest` | 25 | `note` | `caller` | `docs.ingest` | — | — | no |
| `docs.ingest.refused` | 25 | `warning` | `caller` | `docs.ingest` | — | — | no |
| `memory.retain.failed` | 26 | `warning` | `memory-writer` | `memory.retain` | — | — | no |
| `desktop.action` | 30 | `tool.call` | `caller` | `click`, `type`, `key`, `screenshot` | — | — | no |
| `anchor.written` | 28 | `note` | `substrate` | `anchor` | `anchor` | — | yes |
| `anchor.failed` | 28 | `warning` | `substrate` | `anchor` | `anchor` | — | yes |
| `teachable.accepted` | 29 | `note` | `memory-writer` | `teachable` | — | — | no |
| `mirror.failed` | 23 | `warning` | `lease-holder` | `mirror` | — | — | no |
| `lease.release.dod` | 23 | `note` | `lease-holder` | `released` | — | graph repo via placeOf | no |
| `dod.refused` | 23 | `warning` | `lease-holder` | `dod` | — | — | no |
| `dispatch.outcome` | 24 | `note` | `substrate` | `dispatch` | `dispatcher` | — | yes |
| `dispatch.failed` | 24 | `warning` | `substrate` | `dispatch` | `dispatcher` | — | yes |
| `lanea.session_start` | 32 | `session.start` | `claude-code` | — | `agentos` | — | no |
| `lanea.session_end` | 32 | `session.end` | `claude-code` | — | `agentos` | — | no |
| `lanea.approval` | 33 | `note` | `claude-code` | `approval` | — | — | no |
| `lanea.approval.denied` | 33 | `warning` | `claude-code` | `approval` | — | — | no |
| `muse.brief_writer` | 19 | — | — | — | — | — | no |
| `memory.retain` | 26 | — | — | — | — | — | no |
| `memory.recall` | 26 | — | — | — | — | — | no |
| `agent_card` | 29 | — | — | — | — | — | no |
| `verify` | 28 | — | — | — | — | — | no |
| `issue_get` | 23 | — | — | — | — | — | no |
| `graph_find` | 23 | — | — | — | — | — | no |
| `skills.sync` | 22 | — | — | — | — | — | no |
| `mirror` | 23 | — | — | — | — | — | no |

<!-- event-sources:end -->

Surface rule names: `herdr-agent` is the agent herdr detected, mapped onto
`SURFACES` by Phase 19's fixed table; `caller` is the authenticated caller,
never body-supplied; `memory-writer` is the memory's writer; `lease-holder`
is the lease holder. A fixed name is always that surface.

## Silent sources

These deliberately emit nothing. A successful retain and every recall emit
nothing (reads do not emit, like `memory_search`); Agent Cards and `verify`
are reads; `issue_get` and `graph_find` are reads. A successful skills sync
emits nothing — only a refusal is a warning — and the synced tree is its
trail; a successful mirror emits nothing — only a failure is a warning — and
the Linear comment is its trail. The Muse brief writer is
deliberately not an event: a `note` with `repo` per refresh would enter that
repo's brief, change it, and re-trigger itself — the written `BRIEF.md` and
the writer's local counters are its trail.

## herdr agent to surface

[UNVERIFIED] herdr's exact agent identifiers are pinned by Phase 19 from
`herdr api schema`. The fixed table maps each identifier onto `SURFACES`
(for example Claude to `claude-code`, Codex to `codex`, OpenCode to
`opencode`, Pi to `pi`, Cursor to `cursor`, Hermes to `hermes`, Omp to `omp`,
Grok to `grok-build`, Muse to `muse`). An agent with no row is not emitted
and is counted as unmapped.

## Deferred producers

The engineering-board plugin emits as surface `hermes-eng-board`, which the
substrate refuses. Its mapping is surface `hermes` with `payload.runtime`
`eng-board`, recorded here; the fix lives in that plugin's repo, which no
v1.3 phase owns.

## Host-job surface

Host jobs get their own surface (operator decision 2026-10-08): the hourly
anchor, the skills sync, the dispatcher and any other non-agent host job emit
as fixed surface `substrate` with `payload.runtime` naming the job. The
server-side token variable follows the same convention as every other
surface. A job event with no agent session gets its own one-event session
(for example `anchor` under its period start, `dispatch` under its graph id),
as the `graph_bind` note does. Exact ids are each phase's discretion.

## Lane A

Lane A sessions and approvals emit as `claude-code` with `payload.runtime`
`agentos`, not as the `rivet-agentos` surface: the surface names the Lane A
claim identity Phase 24 fixes, while `runtime` names the producer acting for
it.

## Phase-close check

`bun run check:phase-close` (plan 17-03) runs the lock tests and diffs
`EVENT_KINDS` against the v1.2 baseline. Every later phase runs it: no later
PR widens the vocabulary.
