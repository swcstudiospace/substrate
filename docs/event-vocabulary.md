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

- **Closed vocabulary, both enums.** No kind is added; the only surfaces added since v1.2
  are `substrate` (host jobs, operator decision 2026-10-08) and the 15 reviewed swarm
  surfaces `swarm-a16-cloud` … `swarm-a30-custody` (`REVIEWED_SURFACE_ADDITIONS` in
  `scripts/phase-close-check.ts`). `normalizeEvent`
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
  `payload.action` values, never kinds: `skill.propose`, `skill.approve`,
  `skill.decline`, `skill.retire`, `skill.approve.refused`, `docs.ingest`,
  `docs.search`, `teachable`, `anchor`, `mirror`, `dispatch`, `approval`,
  `skills.sync`, `dod`, `doctor`, `slo.transition`, `docs.freshness`, `docs.canary`,
  `index.archive`, `alert`.
- **`payload.runtime` names a non-agent producer** acting for an agent or for
  the host (`herdr`, `agentos`, `anchor`, `dispatcher`, `skills-sync`,
  `doctor` — the runtime doctor, uplift-3 N1, one `warning` per drift class
  with `payload.class` and `payload.checks[{check, expected, actual}]`; never
  a value from an env file; `slo` — the SLO notifier, uplift-3 N2, one
  `warning` per sustained breach or open breaker and one `note` per sustained
  recovery, with `payload.objective`, `state`, `observed`, `target`, deduped
  through the SLO checkpoint so a restart never repeats a transition;
  `docs-freshness` — uplift-4 S7, one `warning` per dataset per breach when an
  accepted merge-trigger has no recorded ingest after
  `SUBSTRATE_DOCS_TRIGGER_LAG_MIN` and one `note` when it clears, with
  `payload.state`, `dataset`, `commit`, `lag_seconds`, deduped through the
  docs state file; `docs-canary` — the opt-in live golden canary, one
  `warning` per changed failing set, with `payload.failing[{fixture, failed}]`;
  `index-archive` — uplift-4 S2, one `note` per finished index snapshot with
  `payload.snapshot`, `createdAt`, `serverVersion`, `schemaHash` and per-table
  `rows`, `bytes`, `sha256`, never rows or a path; `alert` — uplift-4 S3, one
  `warning` from `substrate-alert@.service` when a watched unit fails, with
  `payload.unit` and `payload.result`).
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
- **Desktop action payloads (`desktop.action`)** name hashes, never values:
  `type` carries `text_len` plus `text_sha256`; `screenshot` carries `sha256`
  plus `width` and `height`; `click` carries `x`, `y`, `button`, `double`;
  `key` carries `keys` verbatim only for modifier chords and fixed
  non-printing keys, otherwise `keys_len` plus `keys_sha256`. The active-window
  title and screenshot path travel in the tool reply, never in the event.
- **`repo` is set only where the event is work in that repo.** The brief
  lists recent actions per repo, so any periodic event carrying `repo` would
  crowd a repo's brief. No periodic row carries `repo`.

## The mapping

<!-- event-sources:start -->

| id | phase | kind | surface | action | runtime | repo | periodic |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `herdr.agent_detected` | 19 | `session.start` | `herdr-agent` | — | `herdr` | pane cwd slug | no |
| `herdr.status_changed` | 19 | `note` | `herdr-agent` | — | `herdr` | pane cwd slug | no |
| `herdr.pane_exited` | 19 | `session.end` | `herdr-agent` | — | `herdr` | pane cwd slug | no |
| `herdr.other` | 19 | `note` | `herdr-agent` | — | `herdr` | — | no |
| `muse.tool_call` | 19 | `tool.call` | `muse` | — | — | pane cwd slug, plus branch | no |
| `cursor.stop` | 19 | `session.end` | `cursor` | — | — | — | no |
| `skills.propose` | 21 | `note` | `caller` | `skill.propose` | — | `swcstudiospace/agent-skills` | no |
| `skills.propose.refused` | 21 | `warning` | `caller` | `skill.propose` | — | — | no |
| `skills.propose.failed` | 21 | `warning` | `caller` | `skill.propose` | — | — | no |
| `skills.approve` | 21 | `note` | `caller` | `skill.approve` | — | `swcstudiospace/agent-skills` | no |
| `skills.decline` | 21 | `note` | `caller` | `skill.decline` | — | `swcstudiospace/agent-skills` | no |
| `skills.retire` | 21 | `note` | `caller` | `skill.retire` | — | `swcstudiospace/agent-skills` | no |
| `skills.approve.refused` | 21 | `warning` | `caller` | `skill.approve.refused` | — | — | no |
| `skills.sync.refused` | 22 | `warning` | `substrate` | `skills.sync` | `skills-sync` | — | yes |
| `docs.search` | 25 | `note` | `caller` | `docs.search` | — | — | no |
| `docs.search.failed` | 25 | `warning` | `caller` | `docs.search` | — | — | no |
| `docs.ingest` | 25 | `note` | `caller` | `docs.ingest` | — | — | no |
| `docs.ingest.refused` | 25 | `warning` | `caller` | `docs.ingest` | — | — | no |
| `memory.retain.failed` | 26 | `warning` | `memory-writer` | `memory.retain` | — | — | no |
| `memory.write.accepted` | 26 | `note` | `memory-writer` | — | — | — | no |
| `memory.write.conflict` | 26 | `note` | `memory-writer` | — | — | — | no |
| `memory.write.quarantined` | 26 | `warning` | `memory-writer` | — | — | — | no |
| `memory.write.denied` | 26 | `warning` | `memory-writer` | — | — | — | no |
| `desktop.action` | 30 | `tool.call` | `caller` | `click`, `type`, `key`, `screenshot` | — | — | no |
| `anchor.written` | 28 | `note` | `substrate` | `anchor` | `anchor` | — | yes |
| `anchor.failed` | 28 | `warning` | `substrate` | `anchor` | `anchor` | — | yes |
| `doctor.drift` | 33 | `warning` | `substrate` | `doctor` | `doctor` | — | yes |
| `slo.transition` | 33 | `warning` | `substrate` | `slo.transition` | `slo` | — | yes |
| `slo.recovered` | 33 | `note` | `substrate` | `slo.transition` | `slo` | — | yes |
| `docs.freshness` | 25 | `warning` | `substrate` | `docs.freshness` | `docs-freshness` | — | yes |
| `docs.freshness.recovered` | 25 | `note` | `substrate` | `docs.freshness` | `docs-freshness` | — | yes |
| `docs.canary` | 25 | `warning` | `substrate` | `docs.canary` | `docs-canary` | — | yes |
| `index.archive` | 28 | `note` | `substrate` | `index.archive` | `index-archive` | — | yes |
| `alert` | 33 | `warning` | `substrate` | `alert` | `alert` | — | yes |
| `teachable.accepted` | 29 | `note` | `memory-writer` | `teachable` | — | — | no |
| `mirror.failed` | 23 | `warning` | `lease-holder` | `mirror` | — | — | no |
| `mirror.ok` | 38 | `note` | `lease-holder` | `mirror` | — | — | no |
| `mirror.relation.ok` | 38 | `note` | `substrate` | `mirror` | — | — | no |
| `mirror.relation.failed` | 38 | `warning` | `substrate` | `mirror` | — | — | no |
| `lease.release.dod` | 23 | `note` | `lease-holder` | `released` | — | graph repo via placeOf | no |
| `dod.refused` | 23 | `warning` | `lease-holder` | `dod` | — | — | no |
| `dod.approved` | 38 | `note` | `lease-holder` | `dod` | — | graph repo via placeOf | no |
| `memory.mental_model.refresh` | 40 | `note` | `substrate` | `memory.mental_model.refresh` | — | — | yes |
| `memory.mental_model.refresh.failed` | 40 | `warning` | `substrate` | `memory.mental_model.refresh` | — | — | yes |
| `dispatch.outcome` | 24 | `note` | `substrate` | `dispatch` | `dispatcher` | — | yes |
| `dispatch.failed` | 24 | `warning` | `substrate` | `dispatch` | `dispatcher` | — | yes |
| `lanea.session_start` | 32 | `session.start` | `claude-code` | — | `agentos` | — | no |
| `lanea.session_end` | 32 | `session.end` | `claude-code` | — | `agentos` | — | no |
 | `lanea.approval` | 33 | `note` | `claude-code` | `approval` | `agentos` | — | no |
 | `lanea.approval.denied` | 33 | `warning` | `claude-code` | `approval` | `agentos` | — | no |
| `railway.scale.applied` | 45 | `note` | `substrate` | `railway.scale` | `railway` | — | no |
| `railway.scale.refused` | 45 | `warning` | `substrate` | `railway.scale` | `railway` | — | no |
| `railway.deploy.applied` | 45 | `note` | `substrate` | `railway.deploy` | `railway` | — | no |
| `railway.deploy.refused` | 45 | `warning` | `substrate` | `railway.deploy` | `railway` | — | no |
| `db.endpoint` | 48 | `note` | `substrate` | `db.endpoint` | `mcp-server` | — | no |
| `muse.brief_writer` | 19 | — | — | — | — | — | no |
| `memory.retain` | 26 | — | — | — | — | — | no |
| `memory.recall` | 26 | — | — | — | — | — | no |
| `agent_card` | 29 | — | — | — | — | — | no |
| `verify` | 28 | — | — | — | — | — | no |
| `issue_get` | 23 | — | — | — | — | — | no |
| `graph_find` | 23 | — | — | — | — | — | no |
| `skills.sync` | 22 | — | — | — | — | — | no |
| `railway.list` | 45 | — | — | — | — | — | no |
| `railway.monitor` | 45 | — | — | — | — | — | no |
| `railway.scale_suggest` | 45 | — | — | — | — | — | no |
| `railway.cost` | 45 | — | — | — | — | — | no |

<!-- event-sources:end -->

Surface rule names: `herdr-agent` is the agent herdr detected, mapped onto
`SURFACES` by Phase 19's fixed table; `caller` is the authenticated caller,
never body-supplied; `memory-writer` is the memory's writer; `lease-holder`
is the lease holder. A fixed name is always that surface.

The three `skills.propose` rows share `payload.action: "skill.propose"` and are told
apart by kind and `payload.status`: a `note` for an outcome, a `warning` with status
`refused` for a guard's refusal, a `warning` with status `failed` for a git or `gh`
step that failed. Their payloads carry hashes, names and rule names, never skill
content; the detail is in [skills-propose.md](skills-propose.md).

The four `skills.approve`, `skills.decline`, `skills.retire` and `skills.approve.refused`
rows are the operator's decisions on the skills registry (`skills_approve`, uplift-5 S5a):
a `note` carrying `name`, `pr_number`, `pr_url`, `decided_by` and, for approve and retire,
the `merge_sha` the decision is about; a `warning` for an attempt the rules refused,
carrying `decision`, `name` when it was a valid one, and `rule` from a closed list and no
free text. A decision that changed nothing (`exists`) emits nothing. See
[skills-propose.md](skills-propose.md#approving-a-skill).

The Railway write rows (Phase 45, D45-f) are `railway.scale` and `railway.deploy`, both
from the fixed `substrate` surface with `runtime` `railway`. An applied write is a `note`;
a write the gate refused, or that failed at Railway, is a `warning`. Their payloads carry
`action`, `runtime`, `status`, `environment_id`, `service_id`, the refusal code when there
is one, and the approval reference when one was valid. They never carry the token or a
request body. The four Railway reads emit nothing (D45-b).

## Silent sources

These deliberately emit nothing. A successful retain and every recall emit
nothing (reads do not emit, like `memory_search`); Agent Cards and `verify`
are reads; `issue_get` and `graph_find` are reads. A successful skills sync
emits nothing — only a refusal is a warning — and the synced tree is its
trail. The Muse brief writer is
deliberately not an event: a `note` with `repo` per refresh would enter that
repo's brief, change it, and re-trigger itself — the written `BRIEF.md` and
the writer's local counters are its trail.

The Railway reads (`railway_list`, `railway_monitor`, `railway_scale_suggest`, `railway_cost`)
emit nothing: an advisory scale suggestion is never applied, and the cost report is read,
not recorded.

## herdr agent to surface

Pinned from herdr 0.9.1's `IntegrationTarget` enum (`herdr api schema`) plus
the separate Muse reporter row. `HERDR_AGENT_SURFACES` in
`packages/collectors/src/herdr-map.ts` is the same table.

| herdr agent | surface |
| --- | --- |
| `claude` | `claude-code` |
| `codex` | `codex` |
| `opencode` | `opencode` |
| `pi` | `pi` |
| `omp` | `omp` |
| `hermes` | `hermes` |
| `cursor` | `cursor` |
| `grok` | `grok-build` |
| `muse` | `muse` |

`muse` is not an enum id. Muse reports `agent: "muse"` through
`pane.report_agent`, which takes a free-form string. The remaining enum ids
(`copilot`, `devin`, `droid`, `kimi`, `kilo`, `qodercli`, `qwen`,
`mastracode`, `antigravity_cli`) and any unknown id are not emitted. They
are counted as unmapped, by agent id. A pane with no agent emits nothing.

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
