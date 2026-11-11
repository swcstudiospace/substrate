# Live Steering

Live Steering carries operator directives to an explicitly issued live session. Public repository context is a separate, deliberately cross-session view. A directive is advice: the server never edits an agent's worktree or process.

**Phase 71 change record — implementation unverified and not deployed.** This credential cutover replaces caller-chosen registration and process-memory/restart-cache authorization. Production migration/rehearsal, backup/restore, flags, real token issuance, hooks/timers and real-host delivery were not performed for this change. Parent verification and operator release gates remain required.

## Identity, authority and lifetime

The server independently generates a public `session_id` (`ls_` plus 64 lowercase hexadecimal characters) and private `session_binding` (64 lowercase hexadecimal characters), each from 32 CSPRNG bytes. Neither derives from the other or the bearer. The handle is metadata, **not a credential**. Sessions sharing a surface token are separated by the exact binding proof, not by an ID alone.

Mandatory PostgreSQL migration **42**, `live_session_bindings`, stores the domain-separated proof hash, immutable owner surface/repository, canonical state, lease and retained terminal records. Raw proof is returned only at successful issuance after commit. Private operations check SQL; cache, presence, ledger or old `steering_sessions` rows cannot grant, transfer or revive ownership. No legacy active backfill, caller-chosen identity, re-registration, proof reset, ID reuse or tombstone-delete API exists.

`SUBSTRATE_LIVE_SESSION_LEASE_S` defaults to **3600 seconds**, bounds **60..86400**. Out-of-range integers clamp; non-integer/unparseable values fall back. Owner-proof state updates and explicit heartbeats renew; reads/listening, discovery, presence and operator queue/ack/read do **not**. Quiet hosts must heartbeat too: every **300 seconds** at default, earlier and well before expiry for shorter leases (especially below 600 seconds). CLI installs no timer. SQL time after row-lock acquisition decides liveness; local record expiry is advisory.

A partition may let the lease expire. Expiry and explicit close are terminal: stop private operations, open a new identity and retarget commands. Historical `session.end` only appends history; it neither closes nor re-registers a live identity. Close does not itself acknowledge/decline directives.

The state machine remains `ACTIVE`, `CONTEXT_REFRESH`, `PAUSED`, `RESUMED`. Owner updates enforce legal moves and optional `previous_state`; omitted steering/planning hash carry forward. Applied operator `pause` maps to `PAUSED`, applied `redirect` to `CONTEXT_REFRESH`; `annotate`/`declined` move nothing. Audited acknowledgement stands if close/outage prevents later state application. Refused/unchanged movement has no `checkpoint_hint`; a committed movement retains applied metadata even if a later authorization check withholds its hint.

## Who may do what

Private calls need an authenticated surface. Operator status derives from the bearer, never a body field or `--surface` spelling.

| Operation | Ordinary owner with exact proof | Same-surface sibling without proof / foreign caller | Trusted operator |
| --- | --- | --- | --- |
| Issue | own new identity | may issue its own, never select another handle | own new identity |
| Update / heartbeat | yes | common not-found | owner plus proof; no override/renewal of another session |
| Targeted directives/list/wait, private docs/brief | yes | common not-found | explicit private-read override |
| Explicit close | yes | common not-found | explicit close override |
| Queue / ack | `403` `operator-required` after target binding | common not-found before write policy | existing operator/principal/audit/confirm rules; proof not required |
| Discovery | own surface's active metadata, including sibling handles | no private bodies/counts | all active metadata, still no private bodies/counts |
| Redacted repository digest | existing public-redacted view, no proof | same view under existing auth/flag rules | same view |

Overrides never bypass unknown/expired/closed targets. Queue authors are authenticated operator surfaces on `SUBSTRATE_PLANNING_STEERING_PRINCIPALS`. Queue rate remains 10/minute per target by default. Directive bodies are redacted before storage, at most 4096 characters. Conflicts require confirmation when applied. Queue/ack remain **unkeyed**: no new idempotency key or binding field is required in REST bodies.

## Refusals, audit and concurrent reads

Well-shaped missing/wrong-proof, foreign, unknown, expired and closed private targets share REST **404**, the same application headers and this body:

```json
{"status":"refused","error":{"code":"not-found"}}
```

No ownership reason, target echo or audit-status decoration is included. MCP returns the same typed object with `isError: true` in its normal tool/JSON-RPC envelope (HTTP MCP is not REST 404). Invalid inputs are separate validation errors (REST 400); absent bearer on steering routes is 401. An untyped 404 may mean a disabled/missing route; a **typed** session 404 never means “old server.”

Authority/missing-schema failure is **503** `session-unavailable`. Otherwise-admitted required mutation audit failure is **503** `audit-unavailable`, before effect. Inbox `misconfigured` / `not-configured` are separate 503 cases. Mandatory principal exhaustion is **429** `principal-rate-limited`, with `retry_after_s` and `Retry-After`.

The process-local mandatory bucket keys authenticated surface and read/write class, not requested IDs. It runs even with general admission off/shadow or cache down, before authority lookup, directive inference, generic audit and refusal audit. Rechecks never recharge. Target preparation precedes generic audit, so audit outage cannot replace a target refusal. Admitted required mutations audit before effect. HTTP MCP prepares the whole batch: one live boundary/budget refusal dispatches **no member**; other request IDs receive target-independent `batch-not-dispatched`. Non-live batches retain existing behavior.

Best-effort `steering.refused` events contain fixed operation/caller metadata and domain-separated `target_sha256`, never raw target/proof/body; audit failure does not change 404. Generic live-call audit preserves canonical argument digest/key handling without plaintext live-target context; proof is never separately logged.

Private docs/brief, context/history reads and waits recheck SQL after awaits, including full/fast/snapshot/ETag paths. Close/expiry before the final read check means no private 200/204/304; unavailable authority means 503. Already-authorized/released bytes cannot be retracted. Waits hold no SQL transaction across the socket; local close wakes them and SQL rechecks at most every 1000 ms cover another instance's close. This is a read-release boundary, **not a cross-store rollback** of already accepted audited writes; acknowledgement may stand while its state application is refused.

**Mutation receipts have a different linearization point.** Pre-effect binding/audit checks remain mandatory, but successful SQL/inbox commit produces a truthful public receipt (`issued`, `updated`, `renewed`, `closed`, `queued`, `acknowledged`) even if close/expiry wins later. Receipts never echo canonical private steering/planning hash. Issuance alone returns the one-time proof to its creator as part of that committed receipt; if already closed, it is permanently unusable. Receipt success is not a promise of liveness on the next call. Issuance/update/close additionally report `event_stored` for their subsequent public ledger note; `false` does not undo committed authority state. This is distinct from required generic mutation audit, which still fails closed **before** effect.

Commit/transport failures can be uncertain, and failed local persistence can leave an unused issued identity. No error implies automatic distributed rollback or safe retry with the same identity/key. There is no proof reset/reuse: retain truthful receipts, open a new identity when needed, and let inaccessible unused identities expire.

## REST and MCP protocol

REST proof travels **only** in `X-Substrate-Session-Binding`, never URL/query or JSON body. MCP uses optional `session_binding` arguments supplied by a trusted client credential channel; never paste proofs into chat prompts/transcripts. Missing proof reaches common authorization refusal, rather than a schema-required-proof oracle.

| REST | MCP | Contract |
| --- | --- | --- |
| `POST /steering/sessions` | `docs_steering_session` without `session_id` | `{repo_id, state, steering?, planning_hash?}`; `status: issued`, public `session_id`, `repo_id`, `state`, `updated_at`, `expires_at`, `event_stored`, one-time `session_binding`; no canonical private text/hash echoed |
| No REST update endpoint | `docs_steering_session` with target/proof | `session_id`, `session_binding`, `repo_id`, `state`, optional `steering`, `planning_hash`, `previous_state`; active owner only, `status: updated` and same public metadata/`event_stored`, no proof/private text/hash; never creates unknown IDs |
| `POST /steering/sessions/heartbeat` | `steering_session_heartbeat` | REST `{session_id}`, MCP also proof; committed `status: renewed`, `session_id`, `expires_at` |
| `POST /steering/sessions/close` | `steering_session_close` | REST `{session_id}`; `status: closed`, `session_id`, committed `closed_at`, `event_stored`; repeat close not-found |
| `GET /steering/sessions?repo_id=&limit=&cursor=` | not MCP `steering_list` | metadata discovery, limit 1..100 (default 50), ascending handle keyset order, `truncated`, optional `next_cursor` |
| `GET /steering/directives?session_id=&status=` | `steering_list` with target/proof | private inbox; REST status `queued`, `acknowledged`, `all` (default), `history`, `history_truncated` |
| `GET /steering/wait?session_id=&after=&timeout_ms=` | no separate wait tool | `200 {directive, wait_ms}` or 204 plus `X-Steering-Wait-Ms`, after final read authorization |
| `POST /steering/queue` | `steering_queue` | REST `{session_id, action, body, priority?, conflicts_with_active_plan?, idempotency_key?}`; MCP uses `target_session_id`, requires priority/conflict, supports optional `plan_ref` and `idempotency_key` |
| `POST /steering/acknowledge` | `steering_acknowledge` | REST `{directive_id, outcome, confirm?, idempotency_key?}` infers target after principal admission; MCP also requires matching `session_id` and accepts `idempotency_key` |
| `POST /docs/search`, `POST /brief` | `docs_search`, `memory_brief` | historical `session_id` is attribution; explicit `steering_session_id` plus header/MCP proof selects private augmentation |
| `GET /session/context?repo_id=&session_id=&limit=` | `session_context` | redacted digest; `session_id` is self-exclusion only; a presence row past its TTL (`stale`) is left out, so the digest lists live sessions only |

Discovery rows contain only `session_id`, `surface`, `repo_id`, `state`, `updated_at`, `expires_at`, even for operators: no private direction, planning hash, directive body/count. Public repository metadata is not a private inbox.

`after` follows inbox insertion order, not wall clock. Waits above the configured ceiling clamp (default 30000 ms, bounds 1000..120000). Separate waiter-cap 429 also uses `Retry-After`. Durable inbox REST history merges up to 100 acknowledged records after restart; audit-restored records have no inferred checkpoint hint.

**Idempotency (keyed commands).** `idempotency_key` is 8 to 128 characters from `A-Z a-z 0-9 . _ : -`, the rule the event ledger uses, and is scoped to the caller's surface. An unkeyed command behaves exactly as before. A keyed command applies once:

- A keyed queue names its directive from the key, so every retry of one key from one surface is the same directive. A replay of the same request returns the original `queued` reply, with the same `sequence`, and writes nothing. A different request under the key (another session, action, priority, body or plan reference) is refused with `idempotency-conflict` (HTTP 409).
- A keyed acknowledgement replays the stored reply (including `session_state` and `checkpoint_hint`) for the same directive, outcome and confirm flag, and moves nothing again. A different request under the key is `idempotency-conflict`. A refused acknowledgement is not kept, so a retry runs it again.
- A keyed reply carries `sequence`, the directive's delivery sequence. Every REST directive carries `sequence` too (`null` when the inbox does not hold it). `/steering/wait` delivers in this order, so readers see the order commands entered the inbox.

The key index and sequence are process-local. After a restart a retry is still never applied twice, but it may not get the original reply: restored open directives can take new sequence numbers; a keyed acknowledgement of a directive acknowledged before the restart is refused as `not-found` (404), because the restored inbox holds only open directives; and a keyed queue for such a directive is refused as `audit-unavailable` (503), because the audit log already holds its queued row. A durable sequence and key index are an owner decision (see `.planning/phases/77-steering-idempotency-ordering/CONTEXT.md`).


## Flags and storage

| Variable | Effect |
| --- | --- |
| `SUBSTRATE_PLANNING_STEERING` | default off: no inbox MCP tools or `/steering/*` routes; lifecycle docs-session/heartbeat/close MCP tools register independently |
| `SUBSTRATE_PLANNING_STEERING_PRINCIPALS` | allowed operator authors; empty refuses all authors |
| `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` | opt-in migrations 33/34 and durable inbox; missing sink fails writes closed |
| `SUBSTRATE_LIVE_SESSION_LEASE_S` | default 3600 seconds, 60..86400; mandatory migration 42 has no opt-in |
| `SUBSTRATE_STEERING_SESSIONS_TABLE` | historical migration 37 selection only; runtime cache removed, applied SQL/history unchanged |
| `SUBSTRATE_STEERING_WAIT_MAX_MS` | default 30000 ms per wait |
| `SUBSTRATE_BRIEF_SESSIONS` | public digest/live brief sections; off: digest `session-context.disabled` (REST 503) |
| `SUBSTRATE_WORKTREE_REGISTRY` | independent public worktree-overlap section |

Retired restart-cache TTL configuration has no reader/example. [config-reference.md](config-reference.md) is generated by parent integration. Bindings are not disposable cache; see [native recovery requirements](runbooks/index-archive.md) and [unsafe old-code downgrade](runbooks/rollback-compat.md).

## CLI and the private record

```
substrate steer open [--repo R] [--binding-file PATH] [--json]
substrate steer heartbeat|close --session LIVE_ID [--binding-file PATH] [--json]
substrate steer forget HANDLE [--binding-file PATH] [--surface S] [--json]
substrate steer sessions [--repo R] [--limit N] [--json]
substrate steer status [--repo R] [--session LIVE_ID [--binding-file PATH]] [--json]
substrate steer queue --session LIVE_ID --action pause|redirect|annotate --body TEXT [--priority low|normal|high] [--conflicts] [--json]
substrate steer ack DIRECTIVE (--applied | --declined) [--confirm] [--json]
substrate steer list --session LIVE_ID [--binding-file PATH] [--status queued|acknowledged|all] [--json]
substrate steer listen --session LIVE_ID [--binding-file PATH] [--once] [--max-wait-ms N] [--after DIRECTIVE] [--json]
substrate steer context [--repo R] [--session HISTORICAL_ID] [--limit N] [--format text|json]
```

`forget HANDLE` removes the named local binding record without contacting the server, never prints a proof, and refuses a record that fails validation, which must then be removed by hand.

Every command takes `--surface S` (default `claude-code`). The existing resolver reads `SUBSTRATE_URL` and surface bearer (`SUBSTRATE_TOKEN` or existing token files). Repo otherwise resolves origin. Surface selection is not operator elevation.

`open` starts ACTIVE, saves proof and prints only public fields plus `binding_file`, also in JSON. Default records are `~/.local/state/substrate/live-sessions/<context-digest>.json`, binding canonical server URL, surface and exact handle. `--binding-file` selects one record, never sibling discovery. Credential-bearing/query/fragment URLs are refused for binding identity.

Version-1 records contain `version`, `server_identity`, `surface`, `session_id`, `session_binding`, `expires_at`. Files are exclusively created/published atomically, synced, **0600**, in owner-only **0700** directories. Unsafe modes/ancestors, symlinks, hardlinks, mismatch and overwrite fail closed. Bounds: 4096 bytes/record, 256 directory entries. Keep records **outside repositories/checkpoint snapshots**; never display, attach or commit them.

Explicit missing/corrupt/unsafe records fail locally. Heartbeat requires a matching record. Reads/close with absent *default* record may send an unproved request solely for server-enforced operator override, never owner authorization. Heartbeat updates expiry only; successful close removes the matching record, failed close retains it. Lost issuance/persistence has no reset: unused identity expires; open a new one.

No proof belongs in stdout/stderr, URL, argv, prompts, envelopes, audit, metrics or shared caches. Private directions may augment a checked request, but credential never enters its prompt. Private docs/memory results and brief private sections do not enter shared caches/snapshots. **Network session isolation is not process isolation**: another process under the same OS account (or root) may read the record. Use separate OS users/sandboxing for that threat.

| Exit | Meaning |
| --- | --- |
| 0 | success; listener interrupt/budget completion too |
| 1 | transport/untyped server failure, invalid response or local record failure |
| 2 | usage refused before sending |
| 3 | typed refusal, bad bearer, unavailable/disabled steering, rate limit or confirmation needed |

Typed `not-found`/`session-unavailable` terminate `listen`, not old-server fallback or endless retries. Transient transport/untyped server errors back off 1..30 seconds. `--max-wait-ms` bounds the whole command; a bounded 1000-ID set suppresses repeated output.

## A worked example

This is an operator/host procedure, **not performed for this change**. Existing bearer configuration supplies authentication. `jq` reads public command output only, never proof.

```sh
# Host side: keep historical checkpoint identity stable.
HISTORICAL_SESSION_ID=work-parser
SURFACE=omp
OPEN_RESULT="$(substrate steer open --repo acme/widgets --surface "$SURFACE" --json)"
STEERING_SESSION_ID="$(printf '%s' "$OPEN_RESULT" | jq -r '.session_id')"
BINDING_FILE="$(printf '%s' "$OPEN_RESULT" | jq -r '.binding_file')"
unset OPEN_RESULT
substrate steer status --repo acme/widgets --surface "$SURFACE"

# Operator side: host supplies public handle, never proof.
# OPERATOR_SURFACE is an existing authenticated/allowlisted operator surface.
QUEUED="$(substrate steer queue --surface "$OPERATOR_SURFACE" --session "$STEERING_SESSION_ID" --action redirect --priority high --body "First address the parser tests." --json)"
DIRECTIVE_ID="$(printf '%s' "$QUEUED" | jq -r '.directive_id')"
unset QUEUED

# Host side: selected record supplies the private header.
substrate steer list --surface "$SURFACE" --session "$STEERING_SESSION_ID" --binding-file "$BINDING_FILE"
substrate steer listen --surface "$SURFACE" --session "$STEERING_SESSION_ID" --binding-file "$BINDING_FILE" --once
substrate steer heartbeat --surface "$SURFACE" --session "$STEERING_SESSION_ID" --binding-file "$BINDING_FILE"

# Operator, only after session applies directive:
substrate steer ack "$DIRECTIVE_ID" --surface "$OPERATOR_SURFACE" --applied

# Host: private live hint; historical checkpoint label.
substrate session hook steering --session "$HISTORICAL_SESSION_ID" --steering-session "$STEERING_SESSION_ID" --binding-file "$BINDING_FILE" --surface "$SURFACE" </dev/null
substrate session checkpoints --session "$HISTORICAL_SESSION_ID" --surface "$SURFACE"
substrate steer context --repo acme/widgets --session "$HISTORICAL_SESSION_ID" --surface "$SURFACE"

# Explicit terminal host close; session.end does not do this.
substrate steer close --session "$STEERING_SESSION_ID" --binding-file "$BINDING_FILE" --surface "$SURFACE"
```

Keep configured server/surface identical throughout. The host must schedule quiet-session renewal and choose when to apply/ack; the example installs neither. Docs/brief need explicit live handle/proof for stored directions/notices, never historical `session_id` alone.


## Worktree overlap in the brief

With the worktree registry on (`SUBSTRATE_WORKTREE_REGISTRY`) and a `memory_brief` request that names both `repo` and its own `session_id`, the brief appends a `worktrees` section: other sessions' worktrees of the same repository that touch files the asking session's worktree touches. No new variable: the section follows the registry flag plus the request, and it is absent (and nothing is read) without either.

- **The caller's files** are the union of the reported `files` of the registry rows of that repository whose `session_id` is the request's `session_id`. No session named: no section, never a guess. A caller with no such row, or whose rows carry no files, gets one line (`your own worktree has not reported its files ...`) so the section never silently vanishes.
- **The others** are rows of the same repository (matched case-insensitively, as the brief scopes it) that name a session other than the caller's (an unattributed row is never "another session"), are not the primary checkout, were last seen within 24 hours and reported their files (`files: null` is unknown, not "touches nothing"). Those whose files intersect the caller's are listed, most overlapping files first, then most recently seen, at most **5**.
- **Merged and closed pull requests.** A row whose `pr_state` is `merged` or `closed` is left out only when its worktree is clean: its work has landed or been dropped. Dirty rows stay eligible because their edits may be new work. An excluded clean row also does not make the overlap check incomplete. `open`, `none`, `unknown` and an absent `pr_state` keep the row, since `unknown` is not proof of a merge.
- **Each entry** gives the host and path as the registry holds them, the branch, the session id, dirty or clean with `+ahead/-behind`, how long ago it was seen, and the overlapping files (at most 5, then `and N more`). Only files in the caller's own set are ever named; nothing of a worktree that is not in the caller's repository appears.
- **Bounds and safety.** One registry query per brief, at most 100 rows of the repository, newest first; the matching is in memory. The section is at most 1,200 characters like the other live sections and says `... and N more worktrees` when it cuts. Every string passes the redactor and control characters are shown as `\xNN`. It is read under the brief's own deadline: not ready in time, it is replaced by a one-line note (`Live worktrees not included: not ready before the brief's deadline.`), and a registry read that fails is replaced by `Live worktrees not included: the read failed.`; the rest of the brief is never held or lost.
- **Never cached, never in the snapshot.** Like the other live sections it is built per request for this caller and appended after the cached text, so it is in no cache key and no stored last-good snapshot.

The lists come from `substrate worktree scan --report` ([worktree-fleet.md](worktree-fleet.md#the-changed-files-in-a-report)); a worktree no report has attributed to a session cannot be matched to one. The attribution comes from a live claim on the worktree's graph that names one session, or from `--session ID` (or `SUBSTRATE_SESSION_ID`) given to the scan that runs in the session's worktree ([worktree-fleet.md](worktree-fleet.md#which-session-a-worktree-belongs-to)); the newest report wins, so a session's hook re-sends it with each report.

## The hooks

`substrate session hook steering` separates historical `--session` / envelope `session_id` from `--steering-session` / `steering_session_id` and `--binding-file` / `binding_file`. Flags override envelope fields; envelopes reject plaintext proof. Without explicit live handle and valid selected record it never queries private hints.

Up to five authorized hints are processed per run; consumed decisions include **both historical and live identity**, never proof. Refused/unavailable hints preserve ordinary fail-open checkpoint behavior, with sanitized verbose diagnostics, but never authorize via historical label. The context hook prints the existing redacted digest, at most 4000 characters. Hooks keep their 10-second budget and exit 0.

`substrate session hook-config steering` and `... context` **print only**: no settings/hook/timer/service install. ADR 0007 maps no host event; an operator chooses one. `substrate session hook-install claude-code --settings PATH` merges the Claude Code `Stop` hook into a settings file: a dry run unless `--write`, idempotent, never prints the file, and refuses symbolic links and malformed files. It is the only installer, and it does not run from this repository. See [session rollback](runbooks/session-rollback.md#the-steering-trigger-and-the-checkpoint_hint-reader).

## Privacy, durability and recovery limits

- **Metadata is not private content.** `session_context` / `GET /session/context` stay cross-session, bounded/redacted, with existing caps, `source`, `age_s`, provenance, truncation and historical self-exclusion; no proof required. Private inbox/body/count and stored direction access require checked target.
- **New events are public-safe; old history is unchanged.** Newly server-emitted live transitions, private docs notes, queue hints and close notes allowlist metadata only: no raw/nested direction, planning hash, proof/hash, private body/count or augmented question. Existing REST/MCP historical queries/authorization and published rows are unchanged, not retroactively confidential. Caller-controlled historical `events_emit` is not private storage.
- **No cache authority.** SQL retains identity/revocation across restart. Removed legacy cache cannot resurrect sessions; migration 37 selects historical schema only. Inbox audit is separate, never identity authority.
- **Hints are not durable transition proofs.** Restored acknowledged records have no inferred hint. An acknowledgement can stand while state application refuses; a committed state movement remains applied metadata even if a later check withholds its hint.
- **Terminal records are security state.** Complete PostgreSQL-native backup/recovery must preserve all bindings/tombstones; the closed logical archive excludes them. Stale dump/cache/ledger cannot reconstruct lost tombstones or prove permanent non-reuse. Quiesce live access on incomplete recovery; recover complete state and invalidate restored active bindings before controlled re-enable. No automatic reset/downgrade can supply missing evidence.

## What is still operator-gated

Production migration/rehearsal (including mandatory migration 42), complete native backup/restore and active invalidation, deployment, flags/principals, real bearer issuance, hook/timer installs and real-host delivery remain operator actions. None was performed/certified for this cutover. No caller-controlled legacy row backfill: clients explicitly open/retarget live identities; historical checkpoint/event labels stay stable.

Pre-proof code can bypass the boundary despite additive migration 42. It is not a safe transparent rollback: keep private endpoints inaccessible during approved recovery; never automatically run documentary down/delete tombstones. Parent must record integrated test/review results before HARD-S1 completion; this is no deployment or merge-ready claim.

See [coordination](coordination.md), [data planes](data-planes.md), [index archive](runbooks/index-archive.md) and [rollback compatibility](runbooks/rollback-compat.md).
