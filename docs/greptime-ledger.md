# GreptimeDB: the events ledger

Tracked as SPE-4789 (`swcstudiospace/programming-desk#31`), Phase 0.

## The store lock

Greptime is the **append-only events ledger and nothing else**.

| | Store | Reached through |
| --- | --- | --- |
| Events (`agent_events`) | GreptimeDB | `substrate-mcp` only |
| Memory, graphs, claims | Postgres / TimescaleDB | `substrate-mcp` only |

Three rules follow, and `packages/mcp-server/src/store-lock.test.ts` fails the
build if any of them is broken:

1. **Greptime is not the source of record for memory.** `memory_write` and
   `memory_search` go to the Postgres index and never touch Greptime. Choosing
   the memory source of record is a separate decision and out of scope here.
2. **`substrate-mcp` is the only surface that talks to Greptime.** No collector,
   CLI, hook or projector holds its own client. Redaction and the hash chain
   live on this package's write path, so a second door would be an unredacted,
   unchained one.
3. **No agent gets Greptime as an MCP server of its own.** No native Greptime
   HTTP MCP, no `AddMcpServer` entry for it in any agent's config. An agent that
   could reach Greptime directly could write an event that the chain does not
   cover and that redaction never saw.

Writes go through `events_emit` (MCP) or `POST /events` (REST, for hooks that
cannot call an MCP tool). Both call the same `Substrate.emit`.

Reads go through `events_query` and `events_verify` (MCP) or
`POST /events/query` and `POST /verify` (REST). Both call the same
`Substrate.queryEvents` and `Substrate.verifyGraph`. A seat that could only write
would have left the lock half-built: the trail exists to be read back, and a seat
that had to read it any other way would need the credential rule 2 exists to
withhold. See [Reading the ledger](#reading-the-ledger).

## Schema

`agent_events`, created by `GreptimeClient.migrate()` and idempotent on every
boot:

```sql
CREATE TABLE IF NOT EXISTS "agent_events" (
  "ts"                TIMESTAMP TIME INDEX,
  "id"                STRING,
  "surface"           STRING,
  "session_id"        STRING,
  "graph_id"          STRING,
  "node_id"           STRING,
  "linear_identifier" STRING,
  "step"              BIGINT,
  "repo"              STRING,
  "branch"            STRING,
  "actor"             STRING,
  "kind"              STRING,
  "summary"           STRING,
  "payload"           STRING,
  "hash"              STRING,
  "prev"              STRING,
  PRIMARY KEY ("surface", "repo", "graph_id", "kind")
) WITH ('append_mode' = 'true')
```

Every identifier is quoted: Greptime's parser reserves `id`, among others, and
rejects it as a bare column name.

### `event_ingest`: the order the hourly anchor reads

`migrate()` also creates the ingest table, idempotent on every boot:

```sql
CREATE TABLE IF NOT EXISTS "event_ingest" (
  "ingested_at" TIMESTAMP TIME INDEX,
  "event_id"    STRING,
  "event_ts"    TIMESTAMP,
  "graph_id"    STRING
) WITH ('append_mode' = 'true')
```

`agent_events.ts` is the **collector's** clock, so a collector that replays an old
event, or whose clock is wrong, would drop it into an hour whose root was already
anchored. `ingested_at` is the substrate's own clock, taken immediately before the
`INSERT`, so which hour an event belongs to can no longer change once that hour has
closed. `event_ts` and `graph_id` are copies for the reader's benefit; neither takes
part in ordering. The table keeps `append_mode` for the same reason `agent_events`
does, and unlike `agent_events` it has **no** plain-`CREATE` fallback: without
`append_mode` two events ingested in the same millisecond would collapse into one
record, so a server that rejects the option gets a boot warning instead.
`CREATE TABLE IF NOT EXISTS` does not add the option to a table that already
exists. Before an ingest record is written, and before hourly membership is
read, the live DDL is asked; a definite no skips the insert (writing could
replace another event's record) and refuses the hour read.

### `anchors`: one row per anchored hour

```sql
CREATE TABLE IF NOT EXISTS "anchors" (
  "period_start" TIMESTAMP TIME INDEX,
  "period_end"   TIMESTAMP,
  "root"         STRING,
  "event_count"  BIGINT,
  "memo"         STRING,
  "tx_sig"       STRING,
  "signer"       STRING,
  "cluster"      STRING,
  "slot"         BIGINT,
  "anchored_at"  TIMESTAMP,
  "stale_hashes" BIGINT
)
```

This is the shape production already has (11 columns, in this order, `ENGINE=mito`,
no tag, no rows; read-only check on 2026-10-09). The hourly anchor job (Phase 28)
writes it, one row per anchored hour, and `verifyGraph` reads it. Two things the
job inherits:

- The table has no primary key beyond the time index, so rows that share a
  `period_start` **collapse, last write wins**. Re-anchoring an hour replaces its row
  instead of adding a second, which is why the job must read the existing row before
  it writes one.
- `stale_hashes` exists only to match production. Leave it `NULL` until something
  gives it a meaning.

`migrate()` never alters this table. `CREATE TABLE IF NOT EXISTS` is a no-op against
a table that exists, so boot asks `information_schema` for the live column list and
adds a warning only when it **definitely** differs from the shape above; an empty or
failed read stays silent, since a fresh store has no table yet. An earlier,
five-column `anchors` keyed by `root` is not the production table and would not
have matched.

`agent_events` also has an `ingested_at` column in production, left by an earlier
cutover. This code neither reads nor writes it: ingest order lives in `event_ingest`,
and `agent_events` rows, hashes and columns are never altered.

### Why `append_mode` is not optional

Without it, Greptime treats primary key plus time index as the row's identity
and **deduplicates** — last write wins. Two events in the same millisecond from
one surface, repo, graph and kind would silently overwrite one another. A ledger
cannot lose a row quietly, and a lost row breaks the chain for every event after
it.

`CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so
a table created before this option was set **does not gain it on redeploy**.
`migrate()` asks `SHOW CREATE TABLE` and reports the mismatch as a boot warning:

```
[substrate] degraded — greptime: agent_events is not in append_mode — …
```

Fixing it means recreating the table, which means copying the existing rows:

```sql
CREATE TABLE "agent_events_v2" (…same columns…) WITH ('append_mode' = 'true');
INSERT INTO "agent_events_v2" SELECT * FROM "agent_events";
-- then rename, out of band: the client refuses ALTER, DROP and RENAME by design
```

Run it from Greptime's own console rather than through `substrate-mcp` — the
client will not send those statements (see below), and that is deliberate.

### Writes are fail-closed until it is recreated

A table without `append_mode` is a real, current risk, not a theoretical one:
rapid `file.edit` events from one collector share a surface, repo, graph and kind,
so two in the same millisecond is plausible and one of them is dropped.

So the substrate **refuses to append** while the ledger is not provably
append-only. A boot warning is not enough — it scrolls away and the events keep
coming — and answering `stored: true` to a write that may vanish is the one
failure an events ledger must not have. A lost row also breaks the chain for every
event after it.

Concretely, when `append_mode` is absent or cannot be confirmed:

- `emit` returns `stored: false` with the reason, and writes nothing.
- `GET /healthz` returns **503** and reports `eventsWritable: false` alongside
  `appendOnly: false | null`. Reachability and writability are separate fields on
  purpose: this is the state where `ping` succeeds while every append is refused.
  The 503 holds **even when the index is healthy and the brief still composes** —
  a deployment that configured a ledger and drops every event on the floor is not
  healthy, and a monitor watching only the status code has to see that. A run with
  no `GREPTIME_URL` at all is a different thing and is judged on its remaining
  stores, as before.
- `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=true` appends anyway, and every result
  carries a `warning` saying the event may be dropped.

Refusing is safe here precisely because the substrate fails open at the *client*:
the `substrate` CLI and every hook exit 0 regardless of the response, so a refused
append costs the trail, never the agent's turn.

The override exists so an operator can knowingly accept that loss while the
recreate is pending, rather than having no lever at all. It is never the quiet
path. Recreate the table and leave it unset, and append-only is enforced rather
than merely reported.

### The check cannot be cached for the life of the process

Recreating the table happens **outside** this process, so a permanently cached
answer would break the fix it documents: after the recreate, appends would go on
being refused and `/healthz` would stay 503 until someone thought to restart the
service. The operator would have done exactly the right thing and seen nothing
change. The converse matters too — a table swapped back to a deduplicating one
must stop being treated as safe.

So `ensureAppendMode` trusts a definite answer for 30 seconds and retries an
unknown one immediately. A recreate is picked up within the TTL, with no restart;
a transient `SHOW CREATE TABLE` failure leaves the previous answer in place rather
than widening the refusal, and is retried on the next call. The steady-state cost
is one cheap query per TTL, not one per append.

## What the write path guarantees

`Substrate.emit` → `normalizeEvent` → `GreptimeClient.insertEvent`.

**Redaction, before anything is stored.** `normalizeEvent` redacts every
free-text field — summary, payload, and also `repo`, `branch`, `session_id`,
`graph_id`, `node_id`, `linear_identifier`, all of which are agent-supplied.
Redaction runs *before* truncation, because truncating first could cut a token
so that its own pattern no longer matches and the fragment would be stored. The
patterns are in `redact.ts`, ported from `grok-hermes-connector`'s
`redactor.py`. The named rules and the D-04 classes are listed in
[`redaction.md`](redaction.md). There is no second chance once a row is in an
append-only log.

**Caps, so one collector cannot flood a log nothing will ever reclaim.** Summary
2000 chars; `session_id`, `branch`, `node_id` and `linear_identifier` 512 code units,
cut; `repo` 512 code units, refused above that instead of cut (see
[Identifiers at the 512-unit cut](#identifiers-at-the-512-unit-cut)); each string in
the payload 4000; the
whole payload 16 KB, above which it is replaced by a marker rather than
half-written.

**Consistent identifiers.** `session_id`, `graph_id` and `repo` are query keys as
well as stored values — `emit` finds the previous hash by session, `verifyGraph`
reads by graph, the brief reads by repo. Because the write path redacts and caps
them, every read goes through the same normaliser: `normalizeKey` for `session_id` and
`repo`, `normalizeIdentifier` for the rest (`packages/mcp-server/src/event.ts`). The
stored and queried forms agree by construction. Cleaning on write while querying the raw
value would mean a lookup that never matches: every event would restart its
session's chain, and verification would find no rows at all.

**The hash chain, computed on ingest.** `hash` is sha256 over the canonical JSON
of every other field, `prev` included, so reordering is detectable. `prev` is the
previous event's hash *within the session*. Phase 6 anchors hourly Merkle roots
to Solana, but you cannot retrofit integrity onto an append-only log, so the
chain is correct from row one. `substrate verify <graph_id>` recomputes it.

**Chain order, not timestamp order.** `ts` is not append order. It is
collector-supplied — the Grok collector passes a session's source timestamps
through, and its backfill pass appends events older than everything already
stored — and, now that the table is append-only, two events can also share a
millisecond and both survive, with Greptime free to return them in either order.

So `ORDER BY "ts"` cannot identify the newest event. `lastHash` reads a session's
rows (just `hash` and `prev`, so the read stays small) and takes the tip: the hash
no other row claims as its `prev`. A *window of the newest rows by `ts`* is what
must not be used — a backfilled event is the real tip while sorting last, so such
a window would leave an already-claimed hash looking unclaimed and the next append
would fork the session. The `LIMIT` in that query is a memory guard set far above
any real session, not an ordering assumption. `verifyGraph` puts each session's
events in chain order before verifying. This does not weaken verification — hashes are still recomputed,
and a spliced-out event, a tampered one or a fork all leave events that do not link
into the walk, which are kept so the break is still reported. What it stops
reporting is a database's arbitrary tie-break, which was never an integrity
property.

**The chain tip is read once per session, not once per emit (uplift-2 R5).**
`session_id` is not a key, so that read was a scan of every row ever stored, on
every event — 14,302 rows and ≈ 220 ms over the public edge per emit when it was
measured. The client now keeps each session's tip in a bounded LRU
(`SUBSTRATE_LEDGER_CHAIN_CACHE_MAX`, default 10 000 sessions): one read seeds it,
every stored event moves it to that event's hash, and an error on the event row —
a timed-out INSERT may have landed — forgets it, so the next append asks the ledger
again. An ingest record that could not be confirmed keeps the tip, because the
event row is in the ledger and the next event must chain onto it. A session the
ledger has never seen is remembered as empty, so a handoff's read and the emit
that follows share one lookup. Steady state is therefore two ledger calls per
emit — the event row and its ingest record — instead of three or four.
`SUBSTRATE_LEDGER_CHAIN_CACHE=0` turns the cache off and restores one read per
emit, with nothing else changed.

The seeding read itself is bounded to the last `SUBSTRATE_LEDGER_CHAIN_LOOKBACK_DAYS`
(default 30) of `ts`. When that window holds nothing the whole session is read
instead, so a session that fell silent for longer than the window continues its
chain rather than restarting it — an empty session costs that second read once.
The bound is a window, and the paragraph above says why windows are dangerous:
what remains uncovered is a session whose real tip is a backfilled event older
than the window *and* that this process has not yet appended to. `verify` detects
that fork as it always has, and the window is an operator knob.

**Two concurrent appends in one session cannot fork it (uplift-2 R5).** `prev`
is still a read-then-write with no sequence column, but `Substrate.emit`
serialises appends per `session_id` with a promise chain (the pattern
`completionChains` uses for node completion): the second waits for the first to
settle and reads the hash it stored. Different sessions never wait on each other,
sessionless events never wait, and an event that fails validation releases its
turn. `events_verify` is unchanged — it still recomputes the chain and still
reports a fork a different process or an older build may have written.

**Append-only, structurally.** Every statement passes `assertAppendOnly` before
it leaves the client. It is deny-by-default — only `select`, `insert`, `create`,
`show`, `describe`, `explain` and `with` — so `UPDATE`, `DELETE`, `DROP`,
`TRUNCATE`, `RENAME` and every `ALTER` cannot reach the ledger from this process
at all, with one exception that bypasses the guard for exactly one statement
shape: `ALTER TABLE "<agent_events|event_ingest>" SET 'ttl'='<validated duration>'`,
built from a typed table name and a value that has passed the duration check, sent
only by `migrate()` and only when `SUBSTRATE_LEDGER_TTL` is set (see *Retention*).
Batched statements are refused too, since Greptime's HTTP API accepts
`;`-separated ones and checking only the first verb would leave a way in. The
guard blanks string literals before reasoning about structure, so an event whose
summary contains `;` or `--` is neither mistaken for a batch nor wrongly dropped.

**Correct quoting.** Greptime's HTTP SQL API has no bind parameters, so every
value is inlined and quoting is ours to get right. Single quotes are doubled.
Backslashes are the awkward case: whether `\` inside a literal is an escape
depends on the server, and getting it wrong either corrupts the stored text —
which breaks the chain the moment the row is read back, since the hash was
computed over the text as submitted — or lets a summary close its own literal.
So the client asks: `SELECT LENGTH('a\\b')` is 3 where backslash escapes and 4
where it does not. The answer is probed once at migrate and cached, and retried on
each append until it succeeds.

While it is still unknown, an event whose stored text carries **no** backslash is
appended normally — it quotes identically either way — and one that does is
**refused**, surfacing as `stored: false`. Writing it would store text that
differs from the text its hash covers, and an append-only table cannot be
corrected: that row would fail verification for as long as it exists and take its
session's chain with it. One lost event is the cheaper failure. The payload counts
here too, since it is stored as JSON and a newline inside it reaches the column as
a two-character `\n`.

**An honest result.** `emit` returns `stored`. The substrate fails open — an
unreachable event store must never fail an agent's turn — but a caller that gets
its event back must not read that as a durable append. `POST /events` answers
`202` when the row landed and `503` when it did not; `events_emit` returns
`stored` in its JSON. The `substrate` CLI ignores the status and exits 0
regardless, because failing open is the *client's* job and this surface owes its
caller the truth. Reported errors are redacted, since a connection failure can
quote a URL.

**Ingest order.** Every stored event gets one record in `event_ingest`, written
*after* its row so a record never names an event that does not exist. An event
belongs to the UTC hour of its **first** record, and its position in that hour is
its rank by `ingested_at`, then by `event_id` in code-unit order. The server only
filters: TypeScript collapses duplicate records (a retry after an ambiguous timeout
can leave two), drops an event that has an earlier record, and sorts, so neither the
order rows come back in nor how writes interleaved can move a root. Collector `ts`
plays no part: a backdated event sits in the hour it was ingested in. The leaves of
the hour's Merkle root are the events' `agent_events` hashes, read by id; a member
with no row, a hash that is not 64 lowercase hex, or two stored hashes for one id
throws naming the event, so a digest is never a partial root.

An hour counts as closed 300 000 ms after it ends (`INGEST_LAG_MS`), far above the
write timeout. If a record lands after its hour already closed, the substrate writes
one journal line naming the event and the hour, since a root computed earlier would
differ when recomputed. If the ingest write cannot be confirmed — the attempts
failed, or the live table is not in `append_mode` — the event is still stored:
`emit` answers `stored: true` with a warning that coverage may be missing, and the
caller must not re-emit it, because a retry would store a second event. The two
attempts share a 1 s budget (`INGEST_BUDGET_MS`), inside the 1.5 s `substrate emit`
deadline and the 3 s collector and git-hook deadlines when the event row itself
landed quickly. A timeout is not proof the write was lost, so the warning does not
say the hour will be uncovered.
There is **no backfill**: events stored before this table first existed belong to no
hour, and the first anchored hour is Phase 28's decision.

### Identifiers at the 512-unit cut

Before commit `8a604455`, a `session_id`, `repo`, `branch`, `node_id` or
`linear_identifier` longer than 512 code units was cut at 512. A cut that fell inside
a surrogate pair left a lone high surrogate at the end, which the transport encodes
as U+FFFD. These rows are the **straddled rows**. Their failure mode is recorded in
`.planning/phases/73-ledger-tamper-evidence/73-VERIFICATION.md`.

A straddled row:

- fails `verifyChain` with `hash does not match contents`, because the stored form is
  not the form that was hashed. It fails closed; it is not evidence of tampering.
- is not found by a read of the same identifier, for `session_id` and `repo`, which now
  read through `normalizeKey` (`packages/mcp-server/src/event.ts`) and so no longer
  carry the dangling high. Reads of `branch`, `node_id` and `linear_identifier` have not
  been probed against a live store.
- cannot be repaired in place. `assertAppendOnly` (`packages/mcp-server/src/greptime.ts`)
  refuses any statement that is not a read or an append.

**Owner decision, 2026-11-04:** straddled rows are left as they are. No live store was
read for this section, so no ids are listed here; the scan below finds them.

**Write rules now.**

- A lone UTF-16 surrogate in any of the six text fields (`summary`, `session_id`,
  `repo`, `branch`, `node_id`, `linear_identifier`) is refused with a named error,
  `<field>_lone_surrogate` (`assertWriteTextFields`, `packages/mcp-server/src/event.ts`).
- A graph id over 512 UTF-8 bytes is refused with `graph_id_too_long`.
- A repo over 512 code units is refused with `repo_too_long: a repo may not exceed 512
  code units; got N`. A repo is never cut at write.
- **Not covered.** `branch`, `node_id` and `linear_identifier` are still cut at 512 code
  units without the dangling-high trim (`normalizeIdentifier` and `clean`). A new write
  whose cut falls inside a pair is still stored with U+FFFD in those fields.
  `session_id` and `repo` are trimmed, so the cut stores no U+FFFD for them.
- **Reads are unchanged.** A filter longer than 512 code units is still cut to 512 before
  it is compared (`normalizeIdentifier`, `normalizeKey`). This is a residual of the
  refusal, which applies at write only.

**Detection rule.** A row is affected when a field's length is 512 code units and its
last unit is U+FFFD (bytes `EF BF BD`). **NOT RUN against a live store.** Check
`character_length` and `substring` against the store's SQL functions before use.

```sql
-- NOT RUN against a live store. Verify character_length and substring against the
-- store's SQL functions before use. Column names are from the agent_events schema
-- above; "id" is quoted because it is reserved.
SELECT "id", "ts", 'session_id' AS "field" FROM "agent_events"
 WHERE character_length("session_id") = 512 AND substring("session_id", 512, 1) = '�'
UNION ALL
SELECT "id", "ts", 'repo' FROM "agent_events"
 WHERE character_length("repo") = 512 AND substring("repo", 512, 1) = '�'
UNION ALL
SELECT "id", "ts", 'branch' FROM "agent_events"
 WHERE character_length("branch") = 512 AND substring("branch", 512, 1) = '�'
UNION ALL
SELECT "id", "ts", 'node_id' FROM "agent_events"
 WHERE character_length("node_id") = 512 AND substring("node_id", 512, 1) = '�'
UNION ALL
SELECT "id", "ts", 'linear_identifier' FROM "agent_events"
 WHERE character_length("linear_identifier") = 512 AND substring("linear_identifier", 512, 1) = '�';
```

- `character_length` counts code points, not UTF-16 code units. A value that is 512 code
  units long and holds an astral character has fewer code points, so this query misses
  it. To catch those, select rows whose field ends in U+FFFD without the length test, and
  check `value.length === 512` in application code.
- The scan cannot tell a straddle from a collector that wrote U+FFFD itself at 512 units.
  Each hit needs an owner decision.
- Run it from Greptime's console, not through `substrate-mcp`, which offers no statement
  route (see [Reading the ledger](#reading-the-ledger)).

## Idempotent replay (U5-4a)

The ledger is append-only and `normalizeEvent` mints a new id, hash and row on every
call, so a client that retries an event whose first attempt timed out **after** the
ledger stored it would write a duplicate. `POST /events` therefore accepts an optional
key and a replay marker, behind `SUBSTRATE_EVENT_IDEMPOTENCY=off|accept|enforce`
(default `off`).

**Request.** The body is today's `EventInput` plus an optional
`"idempotency_key"`: 8–128 characters from `[A-Za-z0-9._:-]`. The header
`x-substrate-replay: 1` marks the request as a replay of an earlier attempt. The
client fixes the event's `ts` (ISO) and the key at its first attempt and re-sends both
unchanged; the server honours a client `ts` exactly as it always has.

| Mode | Key and marker | Lookup |
| --- | --- | --- |
| `off` (default) | Ignored unread: nothing stored, no validation, no lookup, the same statements and responses as before the flag existed. A caller-supplied payload `_ik` is left as it was. | never |
| `accept` | A valid key is stored in the event's payload under the reserved key `_ik`. | only a replay-marked request that carries a key; every other request costs zero extra reads |
| `enforce` | As `accept`. | every request that carries a key |

Under `accept` and `enforce` any payload `_ik` the caller wrote is stripped first and
never trusted. `_ik` is appended as the payload's **last** key after redaction and the
size cap, so it is inside the hashed event (no schema change, no `ALTER`: the
append-only guard is untouched) and survives a payload that was replaced for its size.
It adds at most about 140 bytes beyond the 16 000-byte payload cap.

**Lookup.** One bounded `SELECT` in `GreptimeClient.findByIdempotencyKey`: the
primary-key prefix (`surface`, `repo`, `graph_id`, `kind`; a NULL `repo` or `graph_id`
is `IS NULL`) plus the exact normalised `ts`, with the payload matched against
`…"_ik":"<key>"}` at the end of its text, at most 5 rows (`LIKE` reads `_` as a wildcard,
so a lookalike key can match too; each returned row is checked for the exact suffix, and a full read with no exact match is treated as a failed lookup — `503`, nothing written, `result=lookup_failed` — never as a miss, so an unusual key whose pattern matches five other rows in its cell can be answered 503 but never duplicated). It runs inside the per-session
emit turn (`emitChains`), so two concurrent same-key requests leave one row, and a
replay waits for the original attempt still in flight. A keyed event with no session
takes its turn on the key instead.

- **Hit:** `202` with the usual body plus `"deduplicated": true` and the **existing**
  event's `id` and `hash`. No second `agent_events` row is written and the session's
  chain tip is neither read nor moved. A hit also reads the event's `event_ingest`
  membership (one point read by event id, `GreptimeClient.cursorPosition`, the read the
  stream already uses to resolve a cursor), because the original attempt may have landed
  its row and then ended before writing the record, and a client that drops its copy on
  this answer would otherwise leave the event outside every hourly anchor.
  - Membership **found**: nothing is written and the answer is the plain hit. A second
    record is never added to an event that has one: the stream would deliver the event
    again as a new position once its original record is older than the stream's
    one-hour retry window, and the coverage histogram would count the later hour while
    `hourLeaves` (which keeps each event's earliest record) excludes it.
  - Membership **confirmed missing**: the normal path's write (`recordIngest`, same
    table, 1 s budget and two attempts) records it. It becomes the event's first record,
    so the stream, the anchor and coverage each see it once, in the hour of the
    **server's** time at the replay (the hour anchoring rule above), not the event's `ts`.
  - The membership read **fails**, or the repair write fails: nothing further is
    written, the answer is still `202` `stored: true`, and it carries the warning a
    normal append gives when its ingest write cannot be confirmed (the event is stored;
    do not re-emit it; hourly coverage may be missing). A journal line names the event
    id only. Never a 5xx, never a second event.

  A hit is counted in `substrate.events.replay{result=deduplicated}` and not as an emit,
  so the tokens and cost in its payload are not counted twice.
- **Miss:** a normal append with `_ik` stored (`result=appended`).
- **Lookup error** (an unreachable ledger, an open breaker, a malformed row): `503`
  `stored: false`, nothing written, `result=lookup_failed`. A lookup that errors is
  never read as a miss, because that would write the duplicate this exists to prevent;
  the client keeps its copy and retries.
- **Refused:** `400` with a `rule` field and the same name opening `error`, nothing
  written, `result=refused`. The closed set is `idempotency_key_type`,
  `idempotency_key_format`, `replay_ts_missing` (a replay-marked request that carries a
  key but no `ts`: a replay must carry the original `ts`, since the server would stamp
  its own clock and the lookup could never match) and `replay_ts_future` (a replay-marked
  request whose `ts`, as a string or a number, is more than 24 hours ahead of the
  server's clock). Key rules apply only when the mode is not `off`.

**What it costs.** Each lookup is one ledger read, and a hit adds a second one (the
membership read: a single event-id read of `event_ingest`; a repair write follows only
when that membership is missing). Both are expected to be cheap because the lookup
carries the key prefix and an exact time and the membership read is keyed by the event
id, but neither has been measured on the production image; an operator should `EXPLAIN`
the lookup before turning on `enforce`. `accept` costs nothing on an ordinary emit.

**Capability.** `GET /healthz` carries `"idempotency": "off" | "accept" | "enforce"`.
A client MUST NOT replay against a server that reports `off` or lacks the field: it
keeps its copy and retries later.

**Honest limits.** Dedupe applies only to replay-marked requests (or any keyed request
in `enforce`) within the same `surface`, `repo`, `graph_id`, `kind` and `ts` cell. `_ik`
is a reserved payload key. A miss costs one ledger read and a hit two. With the server
at `off`, replays can duplicate, which is why the client checks `/healthz` first.

**Enable order.** Set `SUBSTRATE_EVENT_IDEMPOTENCY=accept` on the server and confirm
`/healthz` reports it; only then enable a client spool. `enforce` is for after replays
have been seen to dedupe. Rollback is setting the variable back to `off`: `_ik` already
stored is ordinary payload data and nothing needs cleaning.

## Anchoring (Phase 28)

Every closed, non-empty UTC ingest hour is anchored exactly once on Solana
devnet — roots only, never event content — and `substrate verify <graph_id>`
checks a graph's chain and, per hour, its anchor.

**Schedule.** `substrate-anchor.timer` fires `substrate-anchor.service` hourly
(`OnCalendar=hourly`, `Persistent=true`); the service is `Type=oneshot` with no
`Restart=`, reading the pinned release on every tick. The 5-minute ingest lag
lives in the job, so an hour anchors at the second tick after it ends: pending
for about 2 h, inside verify's 3 h window. Trigger it only through `systemctl
start substrate-anchor.service` — systemd never runs a second instance of an
active oneshot, and the job re-checks the chain for the period immediately
before every send.

**Candidates.** Closed, non-empty hours with no `anchors` row, from the coverage
start (the hour of the earliest `event_ingest` record — the deploy hour, partial
but well defined), ascending, at most 24 per run, with a 7-day lookback. Empty
hours are skipped and never written. A digest error or a root mismatch emits
`anchor.failed` and the run continues with the next hour; a systemic failure
(wrong cluster, signer mismatch, unfunded key, unreadable RPC, CLI or Greptime
failure) stops the run before the next send. Exit 0 only when every candidate
was anchored or adopted, or there was nothing to do.

**Send, adopt, alarm.** The send is September's argv, unchanged: absolute CLI
path, self-transfer, `--with-memo`, devnet only, keypair as a path the CLI
reads. Preconditions, in order, before the first send: `SOLANA_ANCHOR_KEYPAIR`
absolute, `solana-keygen pubkey` equal to `SOLANA_ANCHOR_PUBKEY`, the RPC's
genesis hash devnet's, balance covering rent plus fees. Before every send the
job adopts: a signer-checked memo already on chain for that period (memo-program
instruction, payer the pubkey and signed, no error, v1 parse, period match,
same root and count) is written to the row with nothing sent. A different root
or count is the alarm: the row is written as found, `anchor.failed` carries
`root-mismatch`, `[anchor] ALARM <period>` goes to stderr, and the run exits 1.

**The row** is the 11-column shape above, `stale_hashes` always `NULL`, the
table deduplicating by `period_start`. **`anchor.written`** (`note`) and
**`anchor.failed`** (`warning`) go out on surface `substrate` with
`session_id: "anchor:<hour>"`, `payload.action: "anchor"`,
`payload.runtime: "anchor"`, no `repo`; failure reasons are the closed set
`digest-failed`, `root-mismatch`, `unfunded`, `wrong-cluster`,
`signer-mismatch`, `rpc-unreadable`, `send-failed`, `store-failed`.

**Verify states.** `verifyGraph` keeps the per-session chain check as `chain`
and adds `hours[]`, one entry per distinct hour holding the graph's events
(each event's hour is its first ingest record's), plus `uncovered` (count and
ids) and `legacy` (count and ids). `ok` is true only when the chain verifies,
every hour is `anchored` or `pending`, and no post-coverage event is uncovered:

- `anchored` — the row's `tx_sig` reads back, the memo is a signed v1 memo for
  this hour, and root and count equal the recomputed digest (and the row).
- `pending` — no row and `now < period_end + 3 h`, or the hour is not closed yet.
- `unanchored` — no row and the 3 h have passed. Fails.
- `mismatch` — recompute vs memo vs row vs period vs signer disagree, or the
  digest throws naming the event. Fails, naming the hour.
- `unverified` — devnet unreadable, the transaction not found, or
  `SOLANA_ANCHOR_PUBKEY` unset. Fails closed: a network fault never reads as anchored.

Events with no ingest record and `ts` before the coverage start are `legacy`:
counted, never failing. Events with no record at or after the coverage start
are `uncovered` and fail verify naming the event — they are not anchored, and
passing them would let an injected row through. Devnet reads run sequentially
under `SUBSTRATE_VERIFY_TIMEOUT_MS`; the CLI's `/verify` request shares that
budget. `buildGraphEvidence` calls the same verify with the hour report on, so the bundle's `anchors` are this verdict's hours (below).

**The evidence bundle.** `substrate evidence --graph <id>` and `POST /evidence` list every hour of the verify report in `anchors`, each with its `status`, `root` and `event_count`. `status` is `anchored`, `pending` or `unverified`. `unanchored`, `mismatch` and `unverified` all fail verify, so all of them read as `unverified` and carry the verify reason. An anchored hour carries its `tx_sig`, `slot` and `explorer_url`. An unverified hour carries `tx_sig` and `explorer_url` when it has an anchor row, and a pending hour carries neither. The explorer URL is the Solana devnet transaction page for the signature, `https://explorer.solana.com/tx/<sig>?cluster=devnet`, built locally with no network call.

Each teachable moment is listed in `teachables`: `graph_id`, `session_id` (when present), `event_id`, `content_sha256` (the observation digest), its `hour`, and that hour's `tx_sig` and `explorer_url` when the hour has them. A teachable is `anchored` when its hour is, because the hour's root holds the event. A teachable with no ingest record has no hour and is not anchored.

`substrate evidence` exits 1 when any hour is `unverified`, and does not fail on `pending`. The memo format, the `anchors` row and the signer are unchanged: the bundle reads what the hourly job already wrote. The live devnet send is operator-gated (`docs/agent-cards.md` G1 to G3) and is not run by the tests, which use a fake read-back.

**The D-era window keeps today's verify behaviour.** The per-session check
already reports D-era multi-event sessions (2026-09-27 to 10-01) as broken —
their `prev` is the global predecessor — and there is no `verifyGlobalChain`.
Those events are pre-coverage and `legacy` in the hour report.

**The production key is used by the production unit only.** A memo for some hour
signed by that key from any other ledger would make production alarm on that
hour forever, so the rehearsal harness never carries `SOLANA_*` names.

### Verifying a checkpoint (v1.6 phase 59)

`checkpoint_verify {ckpt_id | event_id, session_id?}` (MCP, read-only, audit fail-open) resolves a `session.checkpoint` to its hour, its Merkle inclusion proof, the anchors row and the devnet transaction, and answers with one status: `anchored` (the proof verifies against a root a known signer wrote on devnet, and the memo's count is the proof's tree size), `pending` (the hour is not closed, or its anchor may still land, about three hours), `unanchored` (the hour closed long ago and no anchors row exists), `unverified` (the chain or ledger could not settle it: no `SOLANA_ANCHOR_PUBKEY`, a refused or unreachable RPC, a devnet reset, an hour above 50 000 events; never a verdict of tampering) and `mismatch` (a read that succeeded disagrees with the ledger, or the event no longer hashes to its stored hash). With Solana or the ledger unconfigured the answer is `unverified` with the reason, and no network call is made. Nothing sends a transaction.

The signer set is the bootstrap set (`SUBSTRATE_ANCHOR_SIGNER_SET` when set, else the configured anchor key `SOLANA_ANCHOR_PUBKEY` alone) plus the `anchor.signer.rotate` notes an operator surface wrote (read by paging each operator surface's notes, 500 a page, at most 50 pages, keeping only the rotation action); when that read is cut by the cap, cannot advance or fails, a signer is not provably current: the answer carries `signer_set_complete: false` and an anchor that would verify, or a mismatch that only the signer set explains, is reported `unverified` with reason `rotation-read-incomplete`, never `anchored`. A signer whose window closed at or before the anchored hour started is a `mismatch` with reason `signer-retired` (the read was complete, so the signature is known to be by a key that no longer spoke for the ledger; `substrate session rollback` refuses on it unless `--force`). A malformed `SUBSTRATE_ANCHOR_SIGNER_SET` answers `unverified` with a fixed reason (the boot warning names the rule and field, never the value). Every answer that judged a signer carries `signer_set: {source, entries, rotation_notes_applied, rotation_issues, read_gap}` (`checkpoint_verify` and `memory_verify`), so an ignored rotation note or a truncated read is visible; see `docs/runbooks/anchor-signer-rotation.md`. A `ckpt_id` is found in the newest 500 notes of `session_id`, else of the caller's surface in the last seven days (the ledger has no read by payload); an older or foreign checkpoint needs its `event_id`. The evidence is hashes, the proof path, public keys and the transaction signature only, never event contents.

### Memo v2 and per-graph heads

From phase 73 a new hour is anchored with memo v2:

```
substrate:v2:<hour start>:<root>:<count>:<headsRoot>
```

- `<root>` and `<count>` are the v1 commitment, unchanged: the RFC 6962 root over the hour's event hashes, in ingest order.
- `<headsRoot>` is the RFC 6962 root over one head record per `(graph_id, session_id)` pair that wrote events in the hour, sorted by that pair (`packages/ledger/src/heads.ts`). A record hashes the canonical JSON of `[graphId, sessionId, periodStartMs, count, leavesRootHex, headEventId, headHashHex]` with SHA-256. `leavesRootHex` is the RFC 6962 root over one leaf per event of the pair, in chain order, where each leaf is the SHA-256 (lowercase hex) of the JSON `[event_id, hash]` for that event. Each leaf commits to the event id as well as its hash, so a stored `event_id` cannot change unseen. The head is the pair's last event in chain order. A missing `session_id` is `""`.

**`graph_chain_leaves`** holds one row per event: `period_start`, `graph_id`, `session_id`, `seq` (the chain position from 0), `event_id`, `hash`. It is append-only with no primary key, so a retried write can store a row twice. Reads collapse exact duplicates; two rows that disagree about one `seq` make the stored chain invalid. The job writes an hour's leaves before its `anchors` row, so no row exists without its leaves.

**Trust.** `substrate verify` trusts an anchored v2 hour only when:

1. the stored leaves of every graph in that hour, rebuilt into head records, reproduce the on-chain `headsRoot`; and
2. for each `(graph_id, session_id)` pair of the graph being verified, every stored leaf names an event of that pair whose recomputed content hash and stored hash both equal the leaf's hash, and no event of the pair lies outside the stored leaves.

Only the on-chain root is trusted. A head recomputed from the ledger's rows is never trusted. If (1) fails, the whole hour is untrusted, with no localisation. If (2) fails, the verdict names the first event where the chain parts from its leaves, walking the stored order: `first_differing_event_id` (an edited or rewritten event, or the first event past the stored end) or `first_missing_event_id` (a deleted or truncated event). Any contradiction of an anchored head makes `ok` false, even when the local chain check passes; a full rewrite passes that check.

**v1 hours.** Hours anchored before phase 73 carry memo v1 and no per-graph heads. They still verify for root and count, and are reported `trusted: false` with the reason `anchored with a v1 memo: no heads commitment on chain`. `ok` is unchanged for them.

**Trust reasons.** `trusted` is false, with the reason, when:

- the graph holds no events: `no events`;
- no hour of the graph is anchored: `no anchored hour`;
- an hour is pending or unanchored: `hour is <status>: no anchored head to trust`;
- the stored-leaves read outlasts the verify budget: `budget exhausted`;
- the stored-leaves read fails: `store-failed`.

`budget exhausted` and `store-failed` make `ok` false and the hour untrusted, because the chain could not be checked. They claim no tampering: the reason says what could not be read.

### Memo v3 pointers

Each graph with events in an hour also gets one pointer per hour, sent as its own transaction. The hour transaction stays v1 or v2, unchanged. The pointer memo is:

```
substrate:v3:<graph_id>:<period_start_iso>:<count>:<graph_heads_root>:<hour_tx_sig>
```

It is sent to the graph's index address: base58 of SHA-256 over `substrate:graph-index:v1\n` followed by the graph id (`packages/ledger/src/graph-index.ts`). One pointer per (graph, hour).

- **Only job-key pointers that succeeded count.** Verify counts a pointer only when the job key signed it and it succeeded on chain. A pointer the job key did not sign, or one that failed on chain, is ignored: it neither verifies nor fails the hour.
- **Graph id cap.** A graph id over 512 UTF-8 bytes is refused at write with `graph_id_too_long` (`packages/mcp-server/src/event.ts`).
- **Pre-index v2 hours.** A v2 hour that holds the graph's events but has no pointer for that graph is `ok` false, with the reason `pre-index v2 hour`: its pointer is missing, so it is not proven.
- **Unreadable chain.** An unreadable chain is `ok` false. Verify fails closed and does not read the hour as proven.
- **Alarm, no row.** An unanchored hour whose root differs from the chain's memo alarms and stores no row.

A graph id that contains a NUL byte or a lone UTF-16 surrogate is refused at write, with a named error (`graph_id_nul` and `graph_id_lone_surrogate`, `packages/mcp-server/src/event.ts`), so it never reaches a pointer. Owner-accepted, 2026-11-03, two limits remain: (a) a graph lost before its first pointer has landed verifies `ok` true and `trusted` false with the reason `no events` (Q8, pinned by `packages/mcp-server/src/service.test.ts`); (b) a pointer for an old hour is found through the RPC's transaction history for the index address, so if that history is pruned the hour passes, and detection of old hours depends on the RPC's history depth (N5).

## Reading the ledger

`events_query` is the read counterpart of `events_emit`, and the reason a desk seat
needs no Greptime credential to look at the trail.

| Filter | |
| --- | --- |
| `session_id`, `graph_id`, `node_id`, `linear_identifier` | equality |
| `repo`, `branch` | equality |
| `surface`, `kind`, `actor` | equality, against the closed sets in `types.ts` |
| `since`, `until` | inclusive bounds on `ts`, any form `new Date()` accepts |
| `limit`, `order` | 1–500 rows, default 50; `desc` (newest first) or `asc` |
| `include_payload` | off by default |

**A caller supplies values, never syntax.** The clause list is built by iterating
`QUERYABLE_COLUMNS`, so no filter can name `payload`, `hash`, another table or a
second clause; every value goes through the same `quote` the write path uses, and
the statement still passes `assertAppendOnly` on its way out. Two store-lock tests
hold this shape: only `greptime.ts` and `brief.ts` may compose a statement, and no
tool or route may take one. A `sql` tool would have made the read path an arbitrary
door onto every row in the ledger, redaction and chain notwithstanding.

**Query keys are normalised like stored ones.** `Substrate.queryEvents` runs the
`session_id` and `repo` filters through `normalizeKey`, and every other identifier
filter through `normalizeIdentifier` (`packages/mcp-server/src/service.ts`), for the
same reason `emit` looks up a session's chain tip that way. Querying the raw value
would match nothing for any identifier that redaction or the 512-code-unit cut
touched — and an empty window reads exactly like an empty ledger.

**`payload` is excluded unless asked for.** It is the one unbounded column, up to
16 KB an event, so a 500-row reply carrying it would be megabytes of MCP response
for a question the summaries usually answer.

**`ts` order is not append order.** `ts` is collector-supplied and two events can
share a millisecond, so `ORDER BY "ts"` is presentation only. `hash` and `prev` come
back on every row, so a caller can follow the chain itself, and `events_verify`
(`Substrate.verifyGraph`) is what actually recomputes it — per session, since `prev`
chains within one.

**An honest empty answer.** A filter naming a surface, kind, actor, order or date
that cannot exist is *refused* — `400` over REST, a tool error over MCP — because it
would otherwise match nothing and read as "nothing happened". A ledger that is
merely unreachable is an empty window with `error` set (`503` over REST), since a
missing store may not fail an agent's turn. `truncated` says the reply hit `limit`,
so a caller knows to narrow it rather than assuming it saw everything. A filter that
was *supplied but empty* is refused too, rather than dropped: dropping it would
widen the read to everything the other filters allow, which is the opposite of what
a caller narrowing by session asked for. Both surfaces are checked in
`Substrate.queryEvents` rather than at each route, so a JSON body posting
`{"session_id": 123}` gets a `400` naming the field instead of a `500` from
redaction being handed a number.

**A window, not a cursor.** `until` is a bound, and `truncated` is not a page
marker. Two events can share a millisecond, so re-querying from a boundary
timestamp either repeats the rows at it or skips the ones that did not fit — reading
every event that way needs a `(ts, id)` cursor, which this deliberately does not
have. `events_query` is a browse; the complete read of a session or graph is
`readEvents`, which takes no limit and is what `events_verify` walks.

Not built here: a `substrate events` CLI subcommand. Hooks and the CLI can already
reach `POST /events/query`; nothing needed it yet.

**Stream polls are bounded in time (uplift-2 R5).** `GET /events/stream` polls the
ledger every 500 ms per connection with two statements. `eventIdsAfter` finds the
positions after the cursor: its outer side was already a window from the cursor's
millisecond forward, but the anti-join that drops an event with an earlier record
probed all of `event_ingest` before the cursor. It now looks back one hour
(`INGEST_RETRY_LOOKBACK_MS`): the only way one event has two records is a retry
inside the 1 s `INGEST_BUDGET_MS` of its first attempt, so an hour is three
thousand times the gap that can exist, and the bound changes no answer. The
positions carry each event's own `ts` from its ingest record, and `eventsByIds`
brackets its row read with `"ts" BETWEEN` the earliest and the latest of them —
`id` is not a key, so `WHERE "id" IN (...)` alone scanned every row ever stored,
once per poll per stream. A caller with bare ids reads unbounded, as before.
`readEvents` and `graphIngest`, which `events_verify` walks, are unbounded on
purpose: verification must see everything.

## Health: the write probe (uplift-2 R5)

`GET /healthz` used to derive `eventsWritable` from metadata — the ledger answered
`SELECT 1`, the quoting dialect was known, `SHOW CREATE TABLE` said `append_mode`
— so a store that had stopped taking writes (a full volume, a region that would
not flush) still reported 200 while every `events_emit` answered `stored: false`.

`migrate()` now creates one more table, append-only with a one-day TTL so it never
grows past a day of one row a minute:

```sql
CREATE TABLE IF NOT EXISTS "substrate_health" (
  "ts"    TIMESTAMP TIME INDEX,
  "probe" STRING
) WITH ('append_mode' = 'true', 'ttl' = '1d')
```

A server that refuses the `ttl` option gets the table without it and a boot
warning. `GreptimeClient.writeProbe()` inserts one row (`'healthz'`, stamped now);
`probeWritable()` runs it at most once per `SUBSTRATE_LEDGER_WRITE_PROBE_S` (default
60; `0` turns probing off), shares one in-flight probe between overlapping health
calls, goes through the ledger's breaker like every other statement, and never
throws: a failure *is* the verdict. `Substrate.health()` folds it in:

```
eventsWritable = greptime && quotingDialectKnown
              && (appendOnly || SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER)
              && lastProbeOk !== false
ledger: { writable, lastProbeAt, lastProbeOk, lastProbeError }
```

A probe that has not run yet — or that is off — neither proves nor disproves, so
writability is the metadata's; a failed probe overrides it, and the existing status
rule turns `/healthz` 503 within one interval of writes failing. `lastProbeError`
has been through the redactor and had the store's URL and host scrubbed out, so
the body can carry it. An unreachable ledger is not probed — it is already not
writable, and a write that cannot connect would only charge the breaker twice.
The deploy gate (`infra/vps/deploy-release.sh`) reads the status code, so a
release onto a ledger that cannot take writes now fails its health gate.

## Capacity (uplift-2 R5)

`GreptimeClient.capacity()` reads `information_schema.region_statistics` joined to
`information_schema.tables` for the configured database — approximate, as the
server says — and answers `{ bytes, rows, tables }`, the ten largest tables by disk
each as `{ name, rows, diskBytes, sstBytes, indexBytes }`, with a table's regions
summed. `/healthz` reports it under `capacity.ledger`, beside R4's
`capacity.index`, raced against the same 1 s bound and `null` when the store does
not answer in time. The Railway volume is 500 MB; the measured ledger was 1.28 MB
for 14,302 rows (BASELINES.md), so there is room, but the number is now visible
rather than a one-off query.

**Operator cleanup: the stale pre-append table.** `agent_events_pre_append_20260930`
(9,851 rows, 1.29 MB; BASELINES.md) is, by its name, the copy kept when
`agent_events` was recreated with `append_mode`. Nothing reads it; it shows up first in
`capacity.ledger.tables`. Dropping it is an operator action — this client refuses
`DROP` by design and will not grow a path for it — taken after an export of the
table off-box, e.g. from the Greptime HTTP API with the same `events_query`-style
window read into a file outside the VPS disk:

```sql
DROP TABLE "agent_events_pre_append_20260930";
```

## Coverage and archive (uplift-3 N6)

Two things BP-7 and DP-ret ("180 days hot, then export") promised and nothing
showed: whether the hourly anchor is keeping up, and a verified export of what a
TTL would delete. Both are read-only on the ledger; the archive writes only to
the operator's directory and records one `note` per day it wrote.

### Coverage

`GreptimeClient.anchorCoverage({ now })` makes four bounded reads: the newest
`anchors.period_start`; the anchor rows of the last 7 days (the anchor job's own
lookback); one `date_bin` histogram over the same window of `event_ingest` — a
count per hour, never the rows; and the newest `ledger archive` note — by the day
in its summary, so a retried older day cannot move it backwards — on the
`substrate`/`note` series, bounded on `ts`. It answers

```
{ newestAnchoredHour, lagHours, uncoveredHours: [ISO…], more, lastArchiveWindow }
```

An hour is *eligible* once it started an hour ago and is closed (its end plus
the 5-minute ingest lag has passed) — one tick for the anchor timer, so a fresh
boundary never reads as a gap; *uncovered* when eligible, holding ingest
records and having no `anchors` row. The list is ascending, at most 48 with the
newest kept and `more: true` when it was cut. `lagHours` counts whole hours from
the newest anchored hour to the hour `now` is in, so **1 is the steady state**
and `null` means no hour was ever anchored. Membership is "has a record in the
hour", one step looser than `hourLeaves`'s first-record rule: an hour whose only
record is a retry of an event first ingested the hour before (a one-second
window at a boundary) is listed although the job rightly skips it; `substrate
verify` on the event settles it.

`substrate ledger coverage [--json]` prints it and exits 2 when the uncovered
count exceeds `SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS` (default 2) or the list was
cut, 1 when the ledger could not be read. `/healthz.jobs.ledger` carries
`{ anchorLagHours, uncoveredHours (count), more, newestAnchoredHour, lastArchiveDay,
computedAt }` from one `anchorCoverage` read memoised for 60 s in the service
(`Substrate.ledgerJobs`): overlapping health calls share the one read, a caller
waits at most the 1 s probe bound for it and otherwise gets `jobs.ledger: null`
with `jobs.ledgerReason` while the read finishes and fills the memo; a failed
read is memoised too, as `null` with its redacted, host-free reason, so an
unreachable ledger costs one attempt a minute. It never changes the status code.

### Archive

`substrate ledger archive [--until YYYY-MM-DD] [--out DIR] [--page-size N]`
(`packages/mcp-server/src/ledger-run.ts`, spawned by the CLI like `index sweep`
because the ledger client stays inside the server package) writes every closed
UTC day from the oldest event's day up to `--until` (yesterday by default; a day
closes at midnight plus the ingest lag) that has no `manifest-<day>.json` in
`--out` (default `SUBSTRATE_LEDGER_ARCHIVE_DIR`). A day with a manifest is never
rewritten. Per day:

| File | One line per | From |
| --- | --- | --- |
| `events-<day>.ndjson` | event, the exact hashed shape (`rowToEvent`), in `(ts, id)` order | `exportWindow` pages |
| `ingest-<day>.ndjson` | event with a first ingest record: `{ event_id, ingested_at, event_ts }` | same pages |
| `anchors-<day>.ndjson` | `anchors` row whose period starts in the day | same pages |
| `manifest-<day>.json` | `{ day, counts: { events, ingest, ingestMissing, anchors }, first, last, chainTip, hourlyRoots, sha256, writtenAt, releaseSha? }` | written last |

The window is the time index — `[day 00:00Z, next 00:00Z)` on `ts` — because
that is the column a TTL expires on, so every event lands in exactly one day's
archive. `GreptimeClient.exportWindow({ from, to, after?, limit })` reads it by
keyset, never OFFSET: `("ts" > a OR ("ts" = a AND "id" > b)) ORDER BY "ts", "id"
LIMIT n`, so a page costs the same on page 200 as on page one and a same-
millisecond tie is split identically on the server and in the cursor; `next` is
the last row of a full page. Each page also carries the first ingest record of
its events and the window's receipts. The ingest records are read once per day,
not per page: the first page reads every record whose `event_ts` (the event's own
`ts`) is in the window through a keyset cursor on the time index, `(ingested_at,
event_id)`, 500 rows at a time, into an id map the later pages reuse and the last
drops, capped at 500 000 events — a day above the cap refuses to archive rather
than count real events as `ingestMissing`. `ts` is collector-supplied, so a
backdated event's record is *later* than its `ts` and a future-stamped event's is
*earlier*, by any distance; keying on `event_ts` and not on `ingested_at` finds
both. `event_id` is not a key, so the bulk read is still one scan of
`event_ingest` per day (what `graphIngest` and `hourLeaves`'s lookback pay too),
not one per page. An event on a later page whose id is not in the map — its
record was stored after the map was built, as when a collector backfills the day
during the export — is looked up by id (`event_id IN (…)`, 500 at a time, under
the same `event_ts` window) and merged in before anything is counted missing, so
only an id still absent is `ingestMissing`. That lookup is also bounded on the
time index, `ingested_at >=` the start of the first read less the 5-minute
ingest lag (the margin for clock skew and a commit that lands just after the
read): a record that predates the read is already in the map, so a legacy event
from before `event_ingest` existed costs a search of the recent tail, never of
the table's history. A page whose ids are all in the map costs no extra
statement.
`hourlyRoots` are
RFC 6962 roots per *first-ingest* hour over the day's members in
`(ingested_at, event_id)` order — exactly the anchor job's grouping — and
`chainTip` is the hash of the last event in file order. Files are written as
`*.part` and renamed, data files before the manifest, so a manifest on disk
always names complete files and a crash leaves only `.part` files for the next
run to remove.

Before creating or writing anything the command refuses: a day that is not
closed; `--out` empty (what systemd expands an unset
`SUBSTRATE_LEDGER_ARCHIVE_DIR` to); a directory that is `/`, inside the working
tree, under `/opt/agent-substrate` or itself a checkout; a directory that is not
on a filesystem of its own — the `st_dev` of the nearest *existing* ancestor,
read before anything is created, must differ from that of `/` and of the
release root (devices, not `df` names: two tmpfs mounts share a name and are
different filesystems), else it refuses by name, as does an unreadable `stat`;
and a filesystem with
fewer than `SUBSTRATE_DEPLOY_MIN_FREE_GB` (5; `0` disables) gigabytes free, read
with `df -Pk` on that same ancestor as the deploy gate reads it — unreadable
refuses. The mount gate
exists because an off-box volume that did not mount after a reboot leaves its
path as a plain directory on the root disk, where `mkdir -p` would build the
archive and the free-space floor would pass on the root disk's headroom.
`SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS=1` waives only the mount gate, for a
deliberate local test on a one-disk machine; the unit never sets it. The unit
also carries `RequiresMountsFor=/mnt/ledger-archive` so systemd orders it after
the volume's mount and fails the start when that mount is down; the operator's
drop-in repeats the directive for the real `SUBSTRATE_LEDGER_ARCHIVE_DIR` when
it is elsewhere.

Each archived day is then recorded in the ledger
as a `note` on surface `substrate` (`session_id: "ledger-archive:<day>"`,
`summary: "ledger archive <day>: …"`, `payload.action: "ledger.archive"` with the
counts, cursors, chain tip and file digests — no bodies, no path), which is what
`coverage` and `/healthz` read back as the last archive window — the newest *day*
in a note's summary, not the newest write, so a late retry of an older day never
moves it backwards. A note the
ledger does not take (`stored: false`, or an emit that throws) cannot be recovered
by re-exporting — the manifest means "do not export this day again" — so the run
writes `note-pending-<day>.json` beside the manifest *before* it sends the note
and deletes it only once the ledger reports it stored (the note to send, an
attempt count and the last error): a refused note, a throwing emit and a process
killed mid-send all leave it. The day's files are never rewritten and the run
exits 1. Every
later `archive` run sends the pending notes first, oldest day first, and deletes
each marker the ledger takes; a marker whose note the ledger will not take is
counted pending and the run goes on to archive new days. Until then the day is
on disk but absent from
`coverage` and `/healthz.jobs.ledger.lastArchiveDay`, which is the truth. Exit 0
done, 1 a ledger failure or a note still pending, 2 a refusal.
`infra/vps/substrate-ledger-archive.timer` runs it daily at 03:30 UTC, disabled
until the operator mounts the off-box path (`infra/vps/README.md`, *Daily ledger
archive*).

### Verify

`substrate ledger verify-archive <dir> [--day YYYY-MM-DD]` needs no ledger. For
each manifest in the directory (or the one day) it recomputes, from the files
alone: the SHA-256 of each data file against the manifest; the line counts; every
event's `hash` as `eventHash` of the rest of the line (the recomputation
`substrate verify` makes); the chain — within a session no two events may claim
the same `prev` (a fork), counted for every non-null `prev`: a `prev` naming an
event outside the archive is a chain continuing from another day and is fine
once, but two events naming the same outside predecessor are a fork and fail —
and the chain tip; the hourly
roots from the ingest file, hour for hour against the manifest; and each hour
against its receipt: `verified` when the receipt's `event_count` equals the
members present and the roots agree, `partial` when the count differs (the hour
straddles midnight or holds a backdated event, so the rest is in another day's
archive), `unanchored` with no receipt, `mismatched` — a finding — when the
count agrees and the root does not. Every finding is `{ kind, file?, event?,
hour?, detail }` with `kind` one of `missing | manifest | sha256 | count | parse
| hash | chain | root | anchor`; the report never throws on a mismatch, and the
command exits 2 on any, 1 when there was nothing to verify.

**What this does not do.** It does not prove the archive *complete*: a backdated
event ingested after its `ts` day was archived is missing from that day's file
and will expire unarchived. `coverage` cannot see that either. The archive is a
record of what the ledger held at `writtenAt`; `substrate verify <graph_id>`
against the live ledger remains the check for recent graphs.

## Retention: opt-in TTL (uplift-2 R5)

`docs/data-planes.md` sets the ledger's policy as **"180 days hot, then export"**.
Until now no table carried a TTL (`SHOW CREATE TABLE` showed only `append_mode`).

`SUBSTRATE_LEDGER_TTL` applies it. Unset — the default — alters nothing: the client
neither sets nor unsets a TTL on its own, so a retention applied by hand is left
alone and so is a table that has none. When set, `migrate()` reads `SHOW CREATE
TABLE` for `agent_events` and `event_ingest` and sends

```sql
ALTER TABLE "agent_events" SET 'ttl'='180d';
ALTER TABLE "event_ingest" SET 'ttl'='180d';
```

only for a table whose live `ttl` differs, so a boot against tables that already
carry the policy sends nothing. Every failure is a boot warning naming the live
value, never a refusal to serve. The value is validated at config load against
Greptime's time-duration grammar (reference, *Time Durations*: integer + unit
spans such as `180d`, `4320h`, `1h30m`; no decimals, signs or hex; `forever` and
`instant` are refused because they are not retention policies) and an invalid
value refuses to boot with the reason — a retention that was set but silently
never applied would be worse. The policy value is `180d`, matching
`docs/data-planes.md`.

**What a TTL does to `events_verify`.** Expiry is the server's own asynchronous
job: rows whose `ts` is older than the TTL are deleted by Greptime, not by this
process. A verified graph whose events have all expired reads as empty; one that
straddles the boundary reports its oldest surviving event as a chain break, since
its `prev` names a row that is gone. The hourly anchors keep the roots: `anchors`
carries no TTL, so every anchored hour's Merkle root — and its devnet memo —
stays, and an exported hour can still be checked against it. What is lost is the
ability to *recompute* a root for an expired hour from the ledger itself.

**Export before expiry.** The policy says *then export*, and the VPS disk is at
94 % (BASELINES.md), so the export goes off-box. **The precondition for setting
`SUBSTRATE_LEDGER_TTL` is a verified archive of every day that would expire:**
`substrate ledger archive --until <day>` for every closed day older than the TTL
(the command writes every closed day without a manifest), then `substrate ledger
verify-archive <dir>` exiting 0, then `substrate ledger coverage` showing the last
archive window — see *Coverage and archive* above. The ingest records go with the
events, so an exported hour can be re-anchored, and the receipts go with them so
it can be checked without the ledger. Only once that verify has passed is
`SUBSTRATE_LEDGER_TTL` set; from then on the daily timer keeps the archive one
day ahead of expiry, and a day the timer missed is written by its next run.

**Rollback.** The client has no path for it, by design. Per the Greptime SQL
reference page *ALTER* (section "Unset table options"), the statement is

```sql
ALTER TABLE "agent_events" UNSET 'ttl';
ALTER TABLE "event_ingest" UNSET 'ttl';
```

run by the operator against the store, with `SUBSTRATE_LEDGER_TTL` unset in
`substrate.env` so the next boot does not set it again. The same page notes that
unsetting stops further deletion but does not restore rows already removed — which
is what the export step above is for.

## Telemetry buffer and dead-letter (phase 76)

The buffer is **off by default**. With `SUBSTRATE_EVENT_BUFFER_PATH` unset, a failed write answers `stored: false` exactly as it always has, and nothing is queued. With the path set, an event whose ledger write fails is not dropped: it waits in a bounded buffer and is retried with exponential backoff. When its retry budget is spent it is written to the dead-letter store: one record per event, carrying the event's hash and the reason. Nothing is discarded without a record.

- **Buffer.** `SUBSTRATE_EVENT_BUFFER_MAX` (default 256) bounds it. A session's events stay in chain order: while one of its events waits, a later event of that session waits behind it, and its `prev` is the hash of the event ahead of it. Hashes are never rewritten.
- **No duplicates.** Each retry first looks for the event's row by id inside its cell. A row already in `agent_events` is not inserted again, and only a missing ingest record is repaired.
- **Budget and backoff.** `SUBSTRATE_EVENT_BUFFER_MAX_ATTEMPTS` (default 10) counts the live write. The first retry waits `SUBSTRATE_EVENT_BUFFER_BACKOFF_MS` (default 1000), doubles per attempt up to `SUBSTRATE_EVENT_BUFFER_BACKOFF_CAP_MS` (default 60000), with ±20 % jitter. With the defaults the nine waits between the ten attempts total 243 s nominal (1, 2, 4, 8, 16, 32, 60, 60, 60 seconds). An outage of about four minutes, 195 to 292 s with jitter, is ridden out; a longer one spends the budget and dead-letters the event.
- **Overflow.** When the buffer is full, the oldest waiting event that is not being delivered is dead-lettered. Later events of its session are dead-lettered with it (`predecessor-dead-lettered`): they could never chain once it is missing.
- **Dead letters.** `SUBSTRATE_EVENT_DEAD_LETTER_PATH` names an append-only 0600 JSONL file, and it is required while the buffer is on: boot refuses without it, and the message names the variable. Each record holds `event_id`, `event_hash`, `reason` (`exhausted`, `overflow`, `buffer-full`, `predecessor-dead-lettered` or `abandoned`), `attempts`, `last_reason` and the whole event, so an operator can replay it by hand.
- **Durability.** Each file reports its own `durable` flag, shown in `/healthz`. The buffer's is false while its last save failed or its file could not be read at boot. The dead-letter store's is false while a record is held in memory, or while its file could not be counted at boot. A restart re-reads the buffer and retries what was waiting. At shutdown a durable buffer keeps its entries for the next boot. A buffer that is not durable gives its entries up as `abandoned`, each with a record, except pending entries (below), whose records the dead-letter store already holds. When the dead-letter file cannot be written at shutdown, each held record is reported on stderr as one JSON line of identifiers (record id, event id, hash, reason, session id and recorded time), never the summary or payload.
- **Write-ahead give-up.** An entry given up while its dead-letter record is not on disk stays in the buffer file as pending. A pending entry is never attempted, holds its place in the bound, and leaves once the store writes its record. A keyed replay of a pending entry is answered as a give-up, not as queued. When the buffer is full and nothing can be given up, the new event is refused with `stored: false` and nothing is recorded, so the caller keeps its copy.
- **Unreadable files are never rewritten.** A buffer or dead-letter file that exists but cannot be read at boot is left as it is. Its store is not durable until a boot reads it. A new dead-letter record starts on its own line after a torn tail, so the torn line is skipped and the record is kept.
- **Boot refusal.** Boot refuses when `SUBSTRATE_EVENT_BUFFER_PATH` and `SUBSTRATE_EVENT_DEAD_LETTER_PATH` name one file, because each store would rewrite the other's records.
- **Standalone jobs.** The anchor, backfill, index, index-sweep and ledger jobs run with the buffer off, as the re-anchor job does. The server alone owns the buffer files.
- **At-least-once.** A dead-letter record can be written twice when a write fails partway, or when a crash falls between a dead-letter write and the buffer's compaction. Both copies carry the same event id and hash, so the duplicate is detectable.
- **Responses.** A buffered event answers `stored: false` with `buffered: true`, and `/events` answers 503 as for any unstored event. A keyed event that is still queued answers that same queued event when replayed, so a client that resends it with its idempotency key (`SUBSTRATE_EVENT_IDEMPOTENCY` `accept` or `enforce`) does not create a second row. A given-up event answers `deadLettered: true`. Only a landed event is `stored: true`.
- **Not buffered.** A write whose chain tip cannot be read answers `stored: false` without queueing. That holds for any failure of the read, not only a breaker refusal: the event has no hash without its tip, so the caller keeps its copy. During an outage, for a session whose tip is not cached, the buffer does not hold the event. An append-mode refusal also answers `stored: false` without queueing. Queueing either would hide a configuration or read failure. With `SUBSTRATE_LEDGER_CHAIN_CACHE=0` every session write reads the tip first (a keyed replay answered from the ledger before the tip read appends no event), and a failed tip read refuses that write rather than buffering it. Once append mode is confirmed in this process, or `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` is set to `1`, `true` or `yes`, a session write whose tip is readable but whose insert fails is still buffered; a session write reaches its insert only under one of those two conditions (service.ts around line 3133). With the cache on (code read, not tested), a session's first write during an outage can be buffered and its next write is refused until the tip is readable. A sessionless write reads no tip; it is buffered during an outage once append mode is confirmed in this process, or when `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` is set to `1`, `true` or `yes`, with the cache on or off. (The switch is `chainCache` in `packages/mcp-server/src/config.ts`; the tip cache `chainTips` is null when the switch is off, in `packages/mcp-server/src/greptime.ts`; the refusal is the `chain tip unreadable` branch in `packages/mcp-server/src/service.ts`.) Owner-accepted, 2026-11-03.
- **`/healthz`.** `eventBuffer` is `{ enabled: false }` while the buffer is off. When on it reports `depth`, `max`, `oldestAt`, `durable`, `pending` (given-up entries whose dead-letter record is not yet on disk) and `deadLetter: { depth, durable }`. Depth never changes the status code. The dead-letter store is not bounded, because a bound would have to discard records; alert on its depth.
- **Residuals.** A buffered `session.end` does not wait for the ledger to close its steering session. The session is closed first, in the live store, and only then is the `session.end` note emitted (`service.ts`, `closeLiveSession`). The close does not depend on the ledger write, which may be down. While the note is buffered, `event_stored` is false, and the docs-canary note runs only for stored events. Sessionless buffered events have no chain, so they are independent entries with no ordering promise.

## Configuration

Four variables, read from the environment and never from this repo:

| | |
| --- | --- |
| `GREPTIME_URL` | HTTP SQL API base, e.g. `https://<service>.up.railway.app` |
| `GREPTIME_USER` | basic-auth user; sent as a header, never in the URL |
| `GREPTIME_PASSWORD` | basic-auth password |
| `GREPTIME_DB` | database; defaults to `public` |

Plus switches, none of which is a credential:

| | |
| --- | --- |
| `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` | `true` appends even when the table is not provably in `append_mode`. Unset by default, which refuses; see above. |
| `SUBSTRATE_LEDGER_CHAIN_CACHE` | `0`/`false`/`no` turns the per-session chain-tip cache off: one chain-tip read per emit again. Default on. |
| `SUBSTRATE_LEDGER_CHAIN_CACHE_MAX` | sessions whose tip is remembered at once, 1..1 000 000; default 10 000, least recently used evicted. |
| `SUBSTRATE_LEDGER_CHAIN_LOOKBACK_DAYS` | how far back in `ts` the one seeding read looks before it falls back to the whole session, 1..3650; default 30. |
| `SUBSTRATE_LEDGER_WRITE_PROBE_S` | seconds between `/healthz` write probes, 0..86400; default 60. `0` never probes, and `eventsWritable` is metadata-only again. |
| `SUBSTRATE_LEDGER_TTL` | retention applied to `agent_events` and `event_ingest` at boot, a Greptime duration such as `180d`. Unset by default: nothing is altered. Invalid refuses to boot. See *Retention*. |
| `SUBSTRATE_EVENT_IDEMPOTENCY` | `off` (default), `accept` or `enforce`. Anything else is `off` with a boot warning. See *Idempotent replay*. |
| `SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS` | uncovered eligible hours `substrate ledger coverage` tolerates before exiting 2, 0..100000; default 2. Report-only on `/healthz`. See *Coverage and archive*. |
| `SUBSTRATE_LEDGER_ARCHIVE_DIR` | where `substrate ledger archive` writes when `--out` is omitted, and what the archive unit's `ExecStart` expands. Unset by default: the command refuses by name. An off-box mount, never the root disk. |
| `SUBSTRATE_EVENT_BUFFER_MAX` | events the buffer holds, positive integer; default 256; read only while the buffer is on. Over it, the oldest waiting event is dead-lettered. See *Telemetry buffer*. |
| `SUBSTRATE_EVENT_BUFFER_PATH` | the buffer's file, and the switch: unset (the default) keeps the buffer off, so a failed write answers `stored: false` as before. Set, it requires `SUBSTRATE_EVENT_DEAD_LETTER_PATH`. |
| `SUBSTRATE_EVENT_BUFFER_MAX_ATTEMPTS` | write attempts per event, the live one included, positive integer; default 10; read only while the buffer is on. |
| `SUBSTRATE_EVENT_BUFFER_BACKOFF_MS` | delay before the first retry, positive integer ms; default 1000, doubling per attempt; read only while the buffer is on. |
| `SUBSTRATE_EVENT_BUFFER_BACKOFF_CAP_MS` | ceiling on one retry delay, positive integer ms; default 60000; read only while the buffer is on. |
| `SUBSTRATE_EVENT_DEAD_LETTER_PATH` | the dead-letter records' file, append-only. Required while `SUBSTRATE_EVENT_BUFFER_PATH` is set; boot refuses without it. |

Out-of-range numbers clamp and unparseable ones fall back, as the breaker settings do.

`.env.example` declares all four and fills none of them in. The real values live
only in `/etc/substrate/substrate.env` on the VPS — root-owned, `chmod 0600`,
loaded by the systemd unit's `EnvironmentFile`. Greptime itself runs on a Railway
account this host reaches over the public internet; INFRA owns its reachability
and the substrate never provisions it.

Every call is timed out (5 s default) and every failure is the caller's to
handle.

### Transport: HTTPS with Basic auth, today

`GREPTIME_URL` is the HTTP SQL API base over public HTTPS, and the credential is
sent as an `Authorization: Basic` header — built per request, never placed in the
URL, so it cannot leak through a log line, a redirect or an error this code quotes.
This is the path INFRA probed green against the Railway service, and it is the one
to keep using.

Every error the client raises for a transport failure, a non-2xx answer, an
unparseable body or a SQL error field is scrubbed of the endpoint's credentials
before it leaves `send`: the URL (and any `user:password@` in it, percent-escapes
included), the configured user and password, the `user:password` pair and the
`Basic` token, then the redactor's patterns. Warnings, `IngestNotRecorded`, the
breaker's `lastError` and the gate's observed `reason` all inherit it. A response body is
scrubbed whole and only then clipped (500 characters, 200 for non-JSON text), so a
secret that straddles the cutoff cannot leave a prefix behind; each needle is also
matched in its JSON-escaped spelling, since a JSON error body echoes `pa"ss` as `pa\"ss`.
A "table does not exist" answer is recognised from the text the store sent, before the
scrub, and carried as `GreptimeError.missingTable`, so a user named `found` cannot turn
an empty metrics history into a 503. A user or password under four characters is not
scrubbed as a bare substring; it would mangle every word of a diagnostic.

A **Tailscale forwarder** is the preferred shape later: Greptime reachable only on
the tailnet, with the VPS talking to a tailnet address instead of a public one. It
changes nothing in this package and adds no variable — `GREPTIME_URL` would simply
name the tailnet host, and Basic auth would stay on as defence in depth rather than
as the only boundary. Until INFRA has probed that path end to end, HTTPS is what the
deployment uses; the switch is theirs to make and is a one-line change in
`/etc/substrate/substrate.env`.

## Smoke test

```sh
set -a; . /etc/substrate/substrate.env; set +a
bun run smoke:greptime
```

Exits 0 when every check passes, 1 on a failure, 2 when `GREPTIME_URL` is unset.
It prints the host and database only — no credential — and checks:

1. `migrate` reaches the ledger and is idempotent
2. `agent_events` is in `append_mode`
3. three chained events append through `Substrate.emit`, each carrying the
   previous one's hash
4. a decoy credential in a summary is redacted before it is stored
5. a summary containing a quote and a backslash round-trips byte-identically —
   the check that says the quoting dialect is right, and so that the chain is
   verifiable at all
6. the chain over those events verifies
7. nine more events from three sessions, one backdated to September, each leave
   exactly one `event_ingest` record; `Substrate.hourDigest` over every hour they
   touched returns the same root and memo twice, holds the burst in ingest order
   (recomputed from the raw rows), puts the backdated event in the hour it was
   ingested in and leaves the September hour empty, and the chain and every stored
   hash are unchanged afterwards. The burst is checked as a subset of each hour,
   never against an exact count, because the ledger already holds the earlier events
8. `Substrate.queryEvents` reads those events back: the hash each was stored
   under, the `ts` round-tripping from Greptime's integer to the ISO string the
   chain hashed, `payload` in and out, `truncated`, and an ISO time window
   bounding a live `TIMESTAMP` column — the statement parsing no mock can prove
9. the client refuses `UPDATE` and `DELETE`

The rows it writes **stay in the ledger** — it is append-only, so there is
nothing to clean up. They are tagged with a `smoke-` `graph_id` and `session_id`
and `kind: "note"`, and carry no `repo`, which keeps them out of every brief.

### Verification status

Every behaviour above is covered by unit tests against a mocked Greptime
(`greptime.test.ts`, `event.test.ts`, `service.test.ts`), driven over a real MCP
client (`mcp.test.ts`, via the SDK's in-memory transport) and over a real socket
(`server.test.ts`), and the smoke script has been exercised end to end against a
local fake that simulates both SQL literal dialects and a server that rejects
`append_mode` — 20/20 with `append_mode`, and fail-closed without it.

**Live:** SYSTEMS reports `bun run smoke:greptime` passing 11/11 on the VPS after
INFRA's `append_mode` cutover — that run predates the read checks, so the live
proof of `events_query` against the deployed server is still outstanding and is
INFRA's to run. So the deployed GreptimeDB does accept
`WITH ('append_mode' = 'true')`, the recreate has happened, and the default
fail-closed write path is writable there. That run was not made from this session
and is recorded here as reported, not as something this repo verified.

**Ingest order (Phase 27):** proved on **scratch** GreptimeDB v0.14.4 only, 28/28:

```sh
bun run rehearsal up --name p27
set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p27/stores.env"; set +a
bun run smoke:greptime
bun run rehearsal down --name p27
```

Production runs v1.1.4, so how a v1.1.4 server parses the new statements is **not**
yet proved, and `event_ingest` does not exist there until the merged code first
boots (`migrate()` creates it), which is a deploy and the operator's step. The
read-only check of production's `anchors` (11 columns, no rows) is recorded above.
The memo program-id comment in `packages/ledger` (`Memo v4 … written by solana-cli
4.2.2`) is carried over unverified; the first devnet transaction in Phase 28 is the
first chance to check it.

**Hourly anchor (Phase 28):** the isolated fake-chain proof recorded 47/47 on
**scratch** GreptimeDB v0.14.4 (image `greptime/greptimedb:v0.14.4`, same as the
Phase 27 run):

```sh
bun run rehearsal up --name p28anchor --port 17441
set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p28anchor/stores.env"; set +a
bun run smoke:greptime
bun run rehearsal down --name p28anchor
```

(`--name p28anchor --port 17441`: this session's port 17410 was already held by
another rehearsal run; the name is a label only.) Section 8 of
`scripts/greptime-smoke.ts` runs the anchor job with `now` past the lag against
a local fake chain — a stub CLI at an absolute tmp path plus a loopback
JSON-RPC stub serving `getTransaction`, `getSignaturesForAddress`,
`getBalance` and `getGenesisHash` with devnet's hash — and proves all six
beats: the send path through the real CLI stub, adopt-after-crash (injected
lost row write: memo on chain, no row; next run adopts with `adopted: true`
and sends nothing), a silent re-run, untouched-verify with every hour
`anchored`, and tamper-by-append (chain still verifies; the hour reads
`mismatch` naming the hour, exit-equivalent `ok: false`). Anchor ledger events
are recorded by a fake emit, never written — a real one would land in the
anchored hour itself on the real scratch clock and move the root under proof —
and the harness carries no production key names. First run on these stores also
caught and fixed a real bug: the open current hour digested to "not closed yet"
and failed the whole verify; it now reads `pending` per D28-15, pinned by a
regression test.

**Live proof: DEFERRED.** L1–L10 need an operator-approved window with a funded
key and were **not run** from here: no devnet packet left this session (the
only chain ever touched is the loopback stub above), no production ledger row
was written, no host config or systemd step was taken. The runbook with the
per-step gates lives in `28-04-SUMMARY.md`. The 0-lamport question and the memo
program id (D27-06) stay [UNVERIFIED] until L8.

Rollback for this slice is proof-additive: delete section 8 and the tmp stub
it writes at runtime; nothing on any ledger needs undoing (production rows
from a future L7–L8, if approved, are append-only and stay, tagged proof-graph
ids).

If the table is ever recreated again while `substrate-mcp` keeps running, no
restart is needed: `ensureAppendMode` re-checks within its TTL and both the write
path and `/healthz` recover on their own.

While a ledger is *not* append-only, this exercises the rest of the write path and
knowingly accepts that a colliding event may be dropped:

```sh
SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=true bun run smoke:greptime
```
