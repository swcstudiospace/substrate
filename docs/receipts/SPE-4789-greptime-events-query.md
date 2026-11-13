# Receipt — SPE-4789, Phase 0: the Greptime events ledger, read half

| | |
| --- | --- |
| Ticket | [SPE-4789](https://linear.app/swcstudio/issue/SPE-4789) — substrate-mcp Phase 0, Greptime events ledger |
| Run | `20260930T065417Z-39274714` (Grok Bot → Claude Code) |
| Branch | `claude/greptime-events-ledger-7kwlr2`, from `main` |
| Scope | GreptimeDB events ledger behind `substrate-mcp` only |
| Untouched | Timescale SoR, Dragonfly, Hindsight, RAGflow, and every open PR |

## What this run found, and what it did

The write half of this ticket was already merged — PR #3, `events_emit` against
Greptime with redaction, the hash chain, `append_mode` fail-closed behaviour, the
store lock and the smoke script. This run did not redo it.

What was missing was the other half of the ticket's goal: *"desk seats call
`events_emit` / events query through substrate-mcp without Greptime credentials"*.
A seat could write the trail and not read it back, so anyone who wanted to look at
`agent_events` still needed the credential the store lock exists to withhold.

Added, on the same lock:

| | |
| --- | --- |
| `GreptimeClient.queryEvents` | one SELECT built from a fixed whitelist of filterable columns; values quoted, `payload` opt-in, statement still passes `assertAppendOnly` |
| `Substrate.queryEvents` | identifier filters normalised as the write path stores them; unknown surface/kind/actor/order/date refused; an unreachable ledger is an empty window with a redacted reason |
| `events_query`, `events_verify` | read-only MCP tools on `/mcp` |
| `POST /events/query` | the same service method for callers that cannot speak MCP |
| two store-lock rules | only the ledger client and the brief may compose a statement; no tool or route may take one |

No tool accepts SQL. A query names filters; the statement is built inside the ledger
client. That is what keeps the read path from being an arbitrary door onto every row.

## PD-1 evidence

Commands as run, in the repo root. Nothing below was run against the production
ledger, and no command in this file carries a credential — the smoke script reads
`GREPTIME_*` from the environment and prints the host and database only.

### Unit and integration tests

```
$ bun test
199 pass
0 fail
```

162 before this run, 199 after: 37 new tests. The MCP tools are driven over a real
client (the SDK's in-memory transport) and the HTTP routes over a real socket, so a
tool that is unregistered or wired to the wrong argument fails the build rather than
a review.

```
$ bun run check
$ bunx tsc --noEmit
(clean)
```

### The store-lock rules bite

Both new rules were confirmed against a deliberate violation — a commented-out
`this.greptime.sql(\`SELECT 1\`)` appended to `service.ts`:

```
$ bun test packages/mcp-server/src/store-lock.test.ts
(fail) no caller reaches the ledger with SQL > only the ledger client and the brief compose statements
(fail) no caller reaches the ledger with SQL > the query tool's filters are columns this package names, not a caller's string
9 pass
2 fail
```

Reverted, and green again in the full run above. A lock that cannot fail is not a
lock.

### The smoke script, against a local fake

No live Greptime is reachable from this session and no container runtime is
available here, so `scripts/greptime-smoke.ts` was exercised against a throwaway
fake of Greptime's HTTP SQL API. The fake is **not committed**: it imitates one
server's literal dialect and statement parsing, and in the repo it would read as a
guarantee about GreptimeDB that it cannot make.

`append_mode` accepted — 20 checks, exit 0:

```
$ bun run smoke:greptime   # environment pointed at the local fake, not the VPS
  ok   migrate reaches the ledger
  ok   migrate is idempotent
  ok   agent_events is in append_mode
  ok   appended 3 chained events as smoke-f3439b5e
  ok   each event chains onto the previous one's hash
  ok   read back 3 of 3 rows
  ok   the decoy credential was redacted before it was stored
  ok   a summary with a quote and a backslash round-trips byte-identically
  ok   the hash chain over smoke-f3439b5e verifies
  ok   events_query returns 3 of 3 rows for smoke-f3439b5e
  ok   every appended event comes back under the hash it was stored with
  ok   a queried timestamp round-trips to the ISO string the chain hashed
  ok   the payload is left out of a query that did not ask for it
  ok   include_payload returns one parsed payload
  ok   a full window reports itself truncated
  ok   an ISO time window bounds a live TIMESTAMP column
  ok   a window that excludes them is empty rather than an error
  ok   a filter matching nothing is an empty window, not a failure
  ok   the client refuses UPDATE
  ok   the client refuses DELETE

20/20 checks passed.
```

`append_mode` refused by the server — fail-closed, exit 1, and the instruction
rather than six unrelated failures:

```
 FAIL  agent_events is in append_mode — recreate the table; see docs

Appends are refused while agent_events is not provably append-only — this is the fail-closed
behaviour working, not a separate fault. Recreate the table (docs/greptime-ledger.md), or re-run
with SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=true to exercise the rest of the path and knowingly
accept that a colliding event may be dropped.
```

Same server, with the operator's override — the rest of the path runs and only the
`append_mode` check fails, exit 1:

```
19/20 checks passed.
```

## Left for INFRA: the live verify

No secret reached this session, and none is needed to review the diff. The live run
belongs to whoever holds `/etc/substrate/substrate.env`:

```sh
set -a; . /etc/substrate/substrate.env; set +a
bun run smoke:greptime
```

Expect 20/20 against the production ledger. It appends four `smoke-`-tagged rows
that cannot be cleaned up — the table is append-only — and they carry no `repo`, so
no brief shows them. The checks worth watching are the new ones: an ISO literal
compared against a live `TIMESTAMP` column, and `ts` round-tripping from Greptime's
integer back to the ISO string the chain hashed. Those are the two behaviours a mock
cannot prove.

The previously reported live 11/11 predates these checks, so `events_query` against
the deployed server is unproven until that run happens. The docs say so rather than
implying otherwise.

## Credentials

- Four names, no values: `GREPTIME_URL`, `GREPTIME_USER`, `GREPTIME_PASSWORD`,
  `GREPTIME_DB`, declared in `.env.example` and filled in only at
  `/etc/substrate/substrate.env` (root-owned, `0600`, loaded by the systemd unit).
  This run added no variable and changed no name.
- The transport stays HTTPS with a per-request `Authorization` header that uses the `Basic` scheme — the
  path INFRA probed green. A Tailscale forwarder is recorded as the preferred later
  shape; it needs no new variable, and the switch is INFRA's to make.
- `store-lock.test.ts` scans every git-tracked file for a Greptime endpoint or
  credential on each run. It passes.
