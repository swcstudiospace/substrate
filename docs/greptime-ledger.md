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
- `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=true` appends anyway, and every result
  carries a `warning` saying the event may be dropped.

Refusing is safe here precisely because the substrate fails open at the *client*:
the `substrate` CLI and every hook exit 0 regardless of the response, so a refused
append costs the trail, never the agent's turn.

The override exists so an operator can knowingly accept that loss while the
recreate is pending, rather than having no lever at all. It is never the quiet
path. Recreate the table and leave it unset, and append-only is enforced rather
than merely reported.

`ensureAppendMode` caches a definite answer but retries while it is still unknown,
so one transient `SHOW CREATE TABLE` failure does not leave the write path refusing
every event for the life of the process.

## What the write path guarantees

`Substrate.emit` → `normalizeEvent` → `GreptimeClient.insertEvent`.

**Redaction, before anything is stored.** `normalizeEvent` redacts every
free-text field — summary, payload, and also `repo`, `branch`, `session_id`,
`graph_id`, `node_id`, `linear_identifier`, all of which are agent-supplied.
Redaction runs *before* truncation, because truncating first could cut a token
so that its own pattern no longer matches and the fragment would be stored. The
patterns are in `redact.ts`, ported from `grok-hermes-connector`'s
`redactor.py`. There is no second chance once a row is in an append-only log.

**Caps, so one collector cannot flood a log nothing will ever reclaim.** Summary
2000 chars; each other text field 512; each string in the payload 4000; the
whole payload 16 KB, above which it is replaced by a marker rather than
half-written.

**Consistent identifiers.** `session_id`, `graph_id` and `repo` are query keys as
well as stored values — `emit` finds the previous hash by session, `verifyGraph`
reads by graph, the brief reads by repo. Because the write path redacts and caps
them, every read goes through the same `normalizeIdentifier`, so the stored and
queried forms agree by construction. Cleaning on write while querying the raw
value would mean a lookup that never matches: every event would restart its
session's chain, and verification would find no rows at all.

**The hash chain, computed on ingest.** `hash` is sha256 over the canonical JSON
of every other field, `prev` included, so reordering is detectable. `prev` is the
previous event's hash *within the session*. Phase 6 anchors hourly Merkle roots
to Solana, but you cannot retrofit integrity onto an append-only log, so the
chain is correct from row one. `substrate verify <graph_id>` recomputes it.

**Chain order, not timestamp order.** Once the table is append-only, two events
can share a millisecond and both survive — and Greptime is then free to return
them in either order. So `ORDER BY "ts"` alone is not enough: `lastHash` reads a
bounded window of a session's newest rows and takes the tip, the hash no other row
claims as its `prev`; `verifyGraph` puts each session's events in chain order
before verifying. This does not weaken verification — hashes are still recomputed,
and a spliced-out event, a tampered one or a fork all leave events that do not link
into the walk, which are kept so the break is still reported. What it stops
reporting is a database's arbitrary tie-break, which was never an integrity
property.

Two genuinely concurrent appends in one session can still read the same `prev` and
fork the chain. That is inherent to computing `prev` with a read-then-write and no
sequence column; the fork is *detected* by `verify`, not prevented.

**Append-only, structurally.** Every statement passes `assertAppendOnly` before
it leaves the client. It is deny-by-default — only `select`, `insert`, `create`,
`show`, `describe`, `explain` and `with` — so `UPDATE`, `DELETE`, `DROP`,
`TRUNCATE`, `ALTER` and `RENAME` cannot reach the ledger from this process at
all. Batched statements are refused too, since Greptime's HTTP API accepts
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

## Configuration

Four variables, read from the environment and never from this repo:

| | |
| --- | --- |
| `GREPTIME_URL` | HTTP SQL API base, e.g. `https://<service>.up.railway.app` |
| `GREPTIME_USER` | basic-auth user; sent as a header, never in the URL |
| `GREPTIME_PASSWORD` | basic-auth password |
| `GREPTIME_DB` | database; defaults to `public` |

Plus one switch, which is not a credential:

| | |
| --- | --- |
| `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` | `true` appends even when the table is not provably in `append_mode`. Unset by default, which refuses; see above. |

`.env.example` declares all four and fills none of them in. The real values live
only in `/etc/substrate/substrate.env` on the VPS — root-owned, `chmod 0600`,
loaded by the systemd unit's `EnvironmentFile`. Greptime itself runs on a Railway
account this host reaches over the public internet; INFRA owns its reachability
and the substrate never provisions it.

Every call is timed out (5 s default) and every failure is the caller's to
handle.

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
7. the client refuses `UPDATE` and `DELETE`

The rows it writes **stay in the ledger** — it is append-only, so there is
nothing to clean up. They are tagged with a `smoke-` `graph_id` and `session_id`
and `kind: "note"`, and carry no `repo`, which keeps them out of every brief.

### Verification status

Every behaviour above is covered by unit tests against a mocked Greptime
(`greptime.test.ts`, `event.test.ts`, `service.test.ts`) and the smoke script has
been exercised end to end against a local fake that simulates both SQL literal
dialects and a server that rejects `append_mode`.

**Not yet verified against live Railway Greptime.** This session has no route to
it. Two things need a live run:

- whether the deployed GreptimeDB v1.1.4 accepts `WITH ('append_mode' = 'true')`
  — if it does not, `migrate` falls back to a plain `CREATE` and warns
- the table already on Railway **does** predate `append_mode`. Check 2 will fail on
  the first live run, and because appends are fail-closed the script stops there
  rather than reporting the same cause six more times. That is the new behaviour
  working. The recreate above is out of band, with LEAD.

To exercise the rest of the write path before the recreate lands:

```sh
SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=true bun run smoke:greptime
```

which knowingly accepts that a colliding event may be dropped.
