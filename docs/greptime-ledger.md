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

**The hash chain, computed on ingest.** `hash` is sha256 over the canonical JSON
of every other field, `prev` included, so reordering is detectable. `prev` is the
previous event's hash *within the session*. Phase 6 anchors hourly Merkle roots
to Solana, but you cannot retrofit integrity onto an append-only log, so the
chain is correct from row one. `substrate verify <graph_id>` recomputes it.

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
where it does not. The answer is probed once at migrate and cached. Until it is
known, the client assumes the escaping dialect, whose failure mode is a doubled
backslash rather than an injection.

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
- whether the table already on Railway predates `append_mode`, which it almost
  certainly does, since it was created before this change. Expect check 2 to
  fail on the first live run and need the recreate above.

Run `bun run smoke:greptime` on the VPS to close both.
