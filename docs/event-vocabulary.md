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
  `index.archive`, `alert`, and the v1.6 actions `session.checkpoint`, `session.rollback`,
  `session.rollback.refused`, `memory.forget`, `memory.capsule.export`,
  `memory.capsule.redact`, `anchor.signer.rotate`, `anchor.reanchor`, and the v1.7 actions `docs.corpus.ingest`, `docs.corpus.refused`,
  `docs.corpus.root`, `worktrees.report` and `worktree.prune`.
- **Reserved actions are not writable through `events_emit` or `POST /events`.** A reader trusts `anchor.signer.rotate`, `anchor.reanchor`, `session.checkpoint`, `session.rollback`,
  `session.rollback.refused`, `session.rollback.forget_batch`, `memory.forget` and `docs.corpus.root` by their action alone, and the event carries no proof of its writer, so both
  doors refuse them with a `reserved-action` error (nothing written) unless the caller is an operator emitting as its own surface; the server's own emits do not
  pass those doors (`RESERVED_NOTE_ACTIONS` in `packages/mcp-server/src/reserved-actions.ts` is the one list). `docs.canary` is the one host-job action in it: the docs canary's
  report feeds the recall gauge and the `corpus` fabric row, so only the `substrate` token acting as itself may write it, and an operator's token is refused too.
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
  `warning` per changed failing set, with `payload.failing[{fixture, failed}]`, and (v1.7 phase 70) one `note` per
  run that measured the golden set, with `payload.golden_recall5` and `golden_asked`, which the warning also carries
  as `golden_recall5` when it was measured;
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
| `docs.corpus.ingest` | 63 | `note` | `caller` | `docs.corpus.ingest` | — | — | no |
| `docs.corpus.refused` | 63 | `warning` | `caller` | `docs.corpus.refused` | — | — | no |
| `docs.corpus.root` | 69 | `note` | `substrate` | `docs.corpus.root` | — | — | no |
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
| `docs.canary.report` | 70 | `note` | `substrate` | `docs.canary` | `docs-canary` | — | yes |
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
| `session.checkpoint` | 55 | `note` | `caller` | `session.checkpoint` | — | — | no |
| `session.rollback` | 55 | `note` | `caller` | `session.rollback` | — | — | no |
| `session.rollback.refused` | 55 | `warning` | `caller` | `session.rollback.refused` | — | — | no |
| `memory.forget` | 57 | `note` | `caller` | `memory.forget` | — | — | no |
| `memory.capsule.export` | 60 | `note` | `caller` | `memory.capsule.export` | — | — | no |
| `memory.capsule.redact` | 60 | `note` | `caller` | `memory.capsule.redact` | — | — | no |
| `anchor.signer.rotate` | 59 | `note` | `caller` | `anchor.signer.rotate` | — | — | no |
| `anchor.reanchor` | 59 | `note` | `caller` | `anchor.reanchor` | — | — | no |
| `planning.changed` | 52 | `note` | `substrate` | — | — | origin remote of the planning checkout | no |
| `steering.queued` | 58 | `note` | `substrate` | `steering.queued` | — | — | no |
| `worktrees.report` | 68 | `note` | `caller` | `worktrees.report` | — | — | no |
| `worktree.prune` | 68 | `note` | `caller` | `worktree.prune` | — | the pruned worktree's repository (omitted for a local-only one) | no |
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

The four `memory.write.*` rows share one emitter (`auditMemoryWrite`) and no `payload.action`; the payload keys
are `outcome`, `reason` (`accepted` on a plain acceptance), `scope`, `kind`, `strategy`, `review_id` and
`quarantine_id`. An accepted write adds `entry_id`: the id of the entry the gate stored, read from the gate's
result and never from the request, so a caller cannot choose it. It is a payload key on the existing `note`
(or, for an accepted write the read-back could not verify, `warning`), not a new kind or surface. Refused,
quarantined and conflicting writes stored nothing and carry no `entry_id`. Events written before the key
existed lack it; the consistency verifier pairs those by writer, scope, kind and time
([consistency-verify.md](runbooks/consistency-verify.md#limits-stated-plainly)).

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

## Session checkpoint and rollback events

Phase 55 defines the ledger events for session checkpoints and rollbacks, using existing
kinds only. Each is emitted from the caller's own surface (the authenticated caller, never
body-supplied) with `session_id` set to the session it concerns, so it chains into that
session. None carries `repo` (a per-turn checkpoint would crowd a repo's brief) or a
`runtime`. The contract is encoded and validated in
`packages/mcp-server/src/session-events.ts`. The tools `session_checkpoint`,
`session_rollback_plan` and `session_rollback_commit` (registered in `mcp.ts`, admitted in
`admission.ts`, listed in `packages/audit/src/policy.ts`) build and emit them, and the
`substrate session` CLI reaches them over the MCP endpoint (`/mcp`); see the tools paragraph below.
`checkpoint_verify` and `memory_verify` are read-only tools that resolve a checkpoint or a
memory entry to its hourly root and emit nothing.

- `session.checkpoint` (`note`, `payload.action: "session.checkpoint"`): `ckpt_id`
  (`ckpt_` + 26 characters of `0-9a-z`), `seq` (integer >= 1, per session), `trigger`
  (`turn`, `plan-step`, `steering`, `manual`, `pre-restore`, `baseline`), `git_tree` (40 or
  64 lowercase hex), optional `git_base_commit` (same), optional `branch` (<= 200),
  `manifest_sha256` (64 hex), `file_count`, `skipped_count` (integers >= 0), optional
  `transcript_ref`, optional `chain_head {event_id, hash}`, optional `plan_ref {phase?,
  step?}` (each <= 64), optional `prev_ckpt_id` and optional `taken_at_ms` (integer >= 0,
  epoch milliseconds when the client pinned the snapshot; a checkpoint written without it stays valid).
- `transcript_ref`: `surface` (a `SURFACES` member), `session_locator` (1..128, an opaque
  id such as a session uuid or conversation id, never a path: no `/`, `\`, `~` or space),
  optional `entry_id` (1..64), optional `turn_no` (integer >= 0), optional
  `parent_entry_id` (1..64), optional `prefix_sha256` (64 hex). At least one of `entry_id`
  and `turn_no` is required.
- `session.rollback` (`note`, `payload.action: "session.rollback"`): `rollback_id` (`rb_` +
  26 characters), `from_ckpt_id`, `to_ckpt_id`, `target_event_id`, `target_hash` (64 hex),
  `pre_restore_tree` (git hex), `pre_restore_ckpt_id`, `files_added`, `files_modified`,
  `files_deleted` (integers >= 0), `memory {superseded_entries, forgotten_documents}` and
  `transcript` (`moved-leaf`, `marker-only`, `unsupported`, `stale`).
- `session.rollback.refused` (`warning`, `payload.action: "session.rollback.refused"`):
  `reason` (`not-authorized`, `session-busy`, `target-not-found`, `chain-unverified`,
  `hash-mismatch`, `drift-detected`, `ledger-down`, `blob-missing`, `transcript-stale`,
  `invalid-request`), optional `to_ckpt_id`, optional `detail` (<= 300; the ledger redacts it).

**No content.** These payloads carry ids, counts and digests only: never file, diff, patch,
transcript or memory content. The validators reject any key that looks like content (`body`,
`content`, `text`, `bytes`, `diff`, `patch`, file contents), any unknown key, and any payload
over the ledger's 16000-byte cap.

**Rollback is an event, not a mutation.** A rollback is a NEW `session.rollback` event that
points at an earlier one through `target_event_id` and `target_hash`; the append-only ledger
is never rewritten or deleted from. A refused rollback is a `session.rollback.refused`
warning.

**The three tools (v1.6 phase 61).** `session_checkpoint` appends a `session.checkpoint` note as the caller's surface and attaches the ledger chain position (`chain_head`, the session's newest event, observed by the server) itself; a checkpoint id already recorded answers `stored: false` with the existing event. `session_rollback_plan` (read only) answers the target checkpoint, the later ones, the anchor verdict (`null` when it cannot be computed in time; it never blocks), how many of the caller's memory entries written in the session after the checkpoint a rollback would forget, and a `plan_digest` over the rollback id, session, target checkpoint and its event hash, and the sorted ids that would be forgotten, never over the later checkpoints. `session_rollback_commit` appends `session.rollback.refused`, or for `committed` recomputes the plan (a different digest answers `stale-plan` and changes nothing), forgets the memory after the target in batches of 50 (`memory.forget`, reason `rollback`; rows and ledger stay, recall stops serving them, Hindsight documents are deleted) and appends ONE `session.rollback` note with the real totals; it is idempotent by `rollback_id`. A checkpoint belongs to the surface that recorded it: another surface's checkpoint answers `not-found` (the CLI treats that as the `target-not-found` refusal). The server never touches a worktree and never reads a transcript. A commit made without a server plan (`local_only`) is accepted on the same checks and its note's summary says the checkpoint was not anchored.

**Which memory a rollback reaches.** The memory cut of a checkpoint is the EARLIER of its ledger record time and its `taken_at_ms`, so a checkpoint taken offline and recorded hours later still forgets what was written in between. A `taken_at_ms` more than 30 days before the record time or more than 30 seconds after it is ignored (the record time stands) and the `session_checkpoint` answer carries a warning that names why. The upper bound is `until_ms` (an integer, epoch milliseconds, on both `session_rollback_plan` and `session_rollback_commit`): memory created AFTER it belongs to the new timeline the session began once the rollback started and is never forgotten, so a commit delivered late (an offline rollback synced hours later) does not forget it. `until_ms` must not be more than 30 seconds ahead of the server clock or before the cut; absent means now. The CLI sets it to the instant the rollback began and keeps it in the pending journal, so a later sync plans and commits with the same bound. The plan digest covers the forgotten entry ids, so it covers the bound through them: a commit sent with another bound than its plan answers `stale-plan`.

**Anchoring.** The events ride the existing hourly Merkle root to Solana devnet with no
ledger, memo or anchors change (roots only, never event contents). Anchoring lags the hour
close by about an hour plus the 5 minute ingest lag, and `substrate verify` reports the hour
`pending` for up to 3 hours.

**Idempotent replay.** A checkpoint is sent with `idempotency_key` `ckpt:<session token>:<seq>`
and a rollback with `rb:<session token>:<rollback_id>`, plus the original `ts` on a replay. The
ledger only honours the key under `SUBSTRATE_EVENT_IDEMPOTENCY=accept` or `enforce`; the default
`off` ignores it, so a retried event would append a duplicate. A refusal carries no key: a
repeated refusal is a new fact.

## Memory forget events

Phase 57 defines the ledger note for forgetting memory, using an existing kind only. One
`note` per forget call (`payload.action: "memory.forget"`), emitted from the caller's own
surface with the target session's `session_id`; it carries no `repo` and no `runtime`. The
contract is encoded and validated in `packages/mcp-server/src/memory-forget.ts`. It is wired
to the service as `memoryForget` in `service.ts`, an internal method with no MCP tool or HTTP
route of its own: `session_rollback_commit` calls it for the entries a rollback forgets. The
Phase 60 and Phase 59 notes `memory.capsule.export`, `memory.capsule.redact`,
`anchor.signer.rotate` and `anchor.reanchor` are caller-surface notes with their own builders
(`capsule.ts`, `signer-set.ts`, `reanchor-plan.ts`). `substrate capsule` posts the two capsule
notes through the CLI event path (`packages/cli/src/capsule.ts`); an operator posts the signer
rotation with `events_emit` (`docs/runbooks/anchor-signer-rotation.md`). `anchor.reanchor` is written by the
operator-run `reanchor-run.ts --execute` (`reanchor.ts`) as an operator surface, in the hour's anchor session
(`anchor:<YYYY-MM-DDTHH>`), with idempotency key `reanchor:<period_start>:<new_tx_sig>`. The verifier
(`anchor-verify-deps.ts`, `followReanchor`) reads it from an operator surface only, as a pointer to the replacement
transaction, and still judges that transaction from the chain; the `anchors` row is never rewritten
(`docs/runbooks/devnet-reset-and-reanchor.md`). No other code emits it. The server emits none of them by itself.

- Payload: `forget_id` (`fg_` + 26 lowercase hex, derived from the sorted entry ids, the
  reason and the rollback or checkpoint id, so a retried call reuses it), `reason`
  (`rollback`, `expiry`, `operator`), `actor` (`agent`, `human`), `entry_count` (1..200),
  `entry_ids` (the first 50, sorted), `counts {marked, already_forgotten, already_superseded,
  missing}` and `plane {deleted, absent, pending, skipped}` (each sums to `entry_count`), and
  optional `session_id`, `checkpoint_id` and `rollback_id`.
- **Forgotten, not deleted.** The index row stays; its `superseded_by` is set to the marker
  `forgotten:<forget_id>`, so the brief and `memory_search` (without `include_superseded`)
  stop serving it at once. Its plane document is deleted afterwards; a plane failure never
  undoes the mark and is retried by re-running the same request. The ledger is never rewritten.
- **No content.** The note carries ids and counts only, never memory text.

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
