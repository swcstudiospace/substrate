# The MCP audit chain

Tracked as SPE-4793. Owned by `packages/audit`; wired into `substrate-mcp` by
`packages/mcp-server/src/observe.ts`.

One hash-chained record per call an agent made to `substrate-mcp`, and whether it
was **allowed** or **denied**.

## Why this is not an `agent_events` row

Greptime holds the substrate's *application* events — what agents did: edits,
commits, claims, handoffs. This chain holds what agents **asked substrate-mcp to
do**. Keeping them apart is the design, not an accident of layering:

1. **An audit must survive the thing it audits.** Greptime is an external service
   on a Railway account, reached over the public internet, and appends to it are
   fail-closed. A Greptime outage is exactly when the record of what was denied
   matters most — and an audit living in the store that is down records nothing.
2. **`agent_events` is agent-writable.** Any surface with a token can append to it
   through `events_emit`. An audit trail the audited party can write to is not one.
3. **They answer different questions, on different retention.** A denied
   `graph_claim` does not belong in every brief's "recent actions", which is what a
   `tool.call` row in `agent_events` would become.

Both chains use the **same digest construction** — sha256 over canonical JSON with
`prev` inside the hash, so events cannot be reordered undetected — and
`packages/audit/src/record.test.ts` pins the two encoders byte-for-byte against
shared fixtures. That gives one verifier's reasoning to the other without a runtime
dependency either way, which would be a cycle: `mcp-server` depends on `audit`.

## The sink

One JSON object per line, opened `O_APPEND`, **single writer**. `substrate-mcp` is
the only process that writes it, which is what lets `seq` and `prev` need no
coordination — the same property that makes `agent_events` redacted and chained.

A local file rather than a remote one, for reason 1 above.

```
SUBSTRATE_AUDIT_PATH=/var/lib/substrate/mcp-audit.jsonl
```

`infra/vps/substrate-mcp.service` carries `StateDirectory=substrate`, so systemd
creates `/var/lib/substrate` at 0700 and keeps it writable under
`ProtectSystem=full`. A chain that lands in a directory the unit cannot write is a
chain that refuses every fail-closed tool.

Unset, the chain lives **in memory**: verifiable, bounded, and gone at restart.
That is the local-dev shape. `GET /healthz` reports `auditDurable: false` and the
service says so at boot, so a deployment cannot end up in it by accident. The
parent directory is created on open, and writability is proved then — an operator
hears about an unwritable path at boot rather than when the first claim is refused.

It has no compaction and no rotation. Plan for `logrotate` with `copytruncate`
**off** — truncating the file mid-chain is indistinguishable from tampering to
`verify`. Rotate by moving the file and restarting the service, which starts a
fresh chain whose first record has `prev: null`; keep the rotated files, since the
chain they hold is only verifiable as a whole.

## The record

```json
{
  "seq": 412,
  "ts": "2026-09-30T06:54:39.128Z",
  "surface": "hermes",
  "tool": "graph_claim",
  "transport": "mcp",
  "decision": "denied",
  "mode": "fail-closed",
  "reason": "refusing graph_claim: the MCP audit chain could not take the record — …",
  "graph_id": "ut-mfk2p3-9a3b1c7d",
  "node_id": "n4",
  "session_id": "sess-…",
  "actor": null,
  "arg_keys": ["graph_id", "node_id", "session_id"],
  "arg_digest": "9f2b…",
  "prev": "a71c…",
  "hash": "c0de…"
}
```

### Arguments are never stored

Only the argument **names**, sorted, and a sha256 over their canonical form.

Storing the arguments would make the audit a second, permanent copy of everything
every agent ever sent to the substrate — memory bodies, prompts, summaries — in a
file that exists to be read by whoever is investigating an incident. The digest
keeps the property that matters: an investigator holding a request can prove it is
the one that was allowed, byte for byte, because the digest is over the canonical
form of exactly those arguments.

`reason` is redacted before it is stored. A denial routinely quotes an error, and
an error routinely quotes a connection URL. The redactor is **injected** rather
than imported — it lives in `packages/mcp-server`, which depends on this package.

### Verification

`verifyAuditChain` recomputes the chain and reports the first record that does not
verify, four ways:

- **contents do not match the hash** — a record was edited in place;
- **`prev` does not match the preceding record** — a record was removed;
- **`seq` jumped** — the chain was rewritten well enough to still link, which is
  what someone who removed a record and re-chained the rest would produce. The
  sequence number is what still gives it away;
- **the chain does not open at `seq: 1` with `prev: null`** — the *first* record was
  removed. Only the head can be removed without breaking any later link: the
  untouched second record becomes the new head, its own hash verifies, and every
  later `prev` and `seq` still follows it. Checking the head is the only thing that
  catches it, which is exactly why the head is checked rather than assumed.

The consequence is deliberate: a file rotated without restarting the writer does not
open at `seq: 1`, and is reported broken rather than verified in isolation. That is
the truth about such a file — the chain it holds is only verifiable together with the
one it continues.

**An unparseable line fails the verdict.** A process killed mid-write leaves a
partial one; it is counted and reported, never removed, because this is an
append-only file and a verifier reporting a bad line is better than a writer having
quietly deleted evidence. But it is not reported *beside* an `ok: true`: a record
that cannot be read cannot be verified, and "cannot be verified" is not "verified" —
the evidence bundle reads `ok` alone, so an intact verdict over a file with a hole in
it would be an attestation the data does not support. A hash or `prev` mismatch is
named ahead of it, because that identifies a specific position and the unparseable
count cannot — the line that would have named the position is the one that cannot be
parsed. Such a verdict carries `brokenAt: NO_POSITION`, and a reader of it (the
evidence bundle, the HTML document) reports the reason alone rather than putting a
sentinel in front of an auditor.

Two things protect the record that follows a fragment:

- the chain is continued from the last *parseable* record, because treating a partial
  line as the tip would chain every later record onto a hash no verifier can
  recompute;
- **the fragment is terminated with a newline before anything else is appended.**
  Without that, the next record was written straight onto it and the two joined into
  one unparseable line — swallowing the new record while `append` reported
  `written: true`, so a fail-closed tool ran with no readable record of it. The
  fragment itself is untouched: still there, still unparseable, still counted. Only
  its ability to consume the next record is removed. The same check runs after any
  failed append, since `appendFileSync` can write part of a line and then throw.

The chain tip advances **only on a successful write**, for the same reason.

## Fail open, fail closed

| | Tools | Why |
| --- | --- | --- |
| **fail-open** | `memory_brief`, `memory_search`, `graph_get`, `events_emit`, and the `/brief`, `/events`, `/verify`, `/evidence` routes | These sit inside a prompt's hook budget. The substrate is not allowed to fail an agent's turn, and an unwritable audit file is not a reason to start. The call still produces a record; it is just not a gate. |
| **fail-closed** | `graph_claim`, `graph_release`, `graph_complete`, `graph_register`, `memory_write` | Everything that grants or transfers exclusive ownership of a node, or writes shared state another agent will act on. A claim nobody recorded is how two agents end up holding one node, and the whole point of `graph_claim` is that they cannot. |

**An unknown tool is fail-closed.** Deny by default, like `assertAppendOnly` in the
ledger client: a tool added without a decision about its audit mode is caught the
first time it is called rather than becoming a permanent hole.

## The gate sits in front of the dispatcher

`handleMcp` audits the `tools/call` requests in the JSON-RPC body **before** it
connects the transport. A fail-closed tool therefore cannot run unaudited even by
accident, because nothing dispatches it until the chain has taken the record — the
same reasoning that puts `assertAppendOnly` in the ledger client rather than at
each call site.

A refusal is a JSON-RPC error with code `-32000` and **HTTP 200**: the request was
well-formed and the refusal is the answer to it, which is what an MCP client knows
how to read.

A batch is refused **whole**. Dispatching the allowed half would leave the caller
holding a partial result it has no way to tell from a complete one, and MCP clients
send one call per request in practice, so nothing real pays for the strictness.

Because of that, **fail-closed calls in a batch are recorded first**, whatever order
they arrived in. Only a fail-closed append can produce a denial, so doing those first
means a refused batch leaves no `allowed` record for a fail-open member that never
ran — which is what recording each call as the loop reached it used to produce. Within
the fail-closed group a denial can still follow an earlier success; the chain is
append-only, so that record cannot be withdrawn, and a **correction** is appended
instead: a `denied` record under the tool name `batch`, saying how many calls were
recorded as allowed and that none of them was dispatched. An append-only chain is
corrected by appending, never by editing.

The correction is written **once per graph the batch touched**, not once per batch. A
record carries a single `graph_id` and `substrate evidence` selects by exactly that
field, so a correction naming no graph would be filtered out of every bundle while the
earlier `allowed` record — which does name its graph — was kept. That graph's evidence
would then show a claim as allowed with nothing saying it never ran, which is the
reading the correction exists to prevent. Each affected graph gets its own, counting
only its own calls; a call that named no graph is corrected under a null one, the same
place its `allowed` record sits.

Handshake traffic — `initialize`, `tools/list`, notifications — is not audited. A
trail of handshakes buries the decisions it exists to show.

## REST is audited on the same chain

A hook process cannot call an MCP tool, so REST is the door it uses. If only the
MCP transport were audited, `/events` would be an unaudited door to the same action
**by design** — the exact shape of hole the store lock exists to close. So
`/brief`, `/events`, `/verify` and `/evidence` are audited too, with
`transport: "rest"`.

`/healthz`, `/metrics` and `/slo` are not: they are monitoring traffic, no agent
action is behind them, and a trail dominated by a Prometheus scrape is one nobody
reads.

At roughly 400 bytes a record, a host doing a thousand prompts a day writes well
under a megabyte a day.

## `substrate evidence`

```sh
substrate evidence --graph ut-mfk2p3-9a3b1c7d                       # JSON to stdout
substrate evidence --graph ut-mfk2p3-9a3b1c7d --out evidence.html   # the document
```

The bundle is composed by `substrate-mcp`, not by the CLI: that is the process
holding the metric snapshot and the audit chain, and a second composer would be a
second answer to the same question. `POST /evidence` is the same thing over HTTP.

The CLI always fetches it as **JSON** and renders the HTML from that same bundle —
rendering is presentation, not composition. Asking the server for HTML gave the
command a document it could not read, so `--format html` skipped the chain and SLO
checks and exited 0 over a breached objective. Asking twice would be worse: the two
bundles are taken at different instants, so the verdict could describe numbers the
document does not contain.

It carries both chain verdicts, the SLO results with their sample counts, the
allowed/denied tally for that graph, and the tokens and cost attributed to it.

The HTML is **one self-contained file** — no external script, stylesheet, font or
fetch. Evidence has to render years from now, from a filesystem, with no network;
and a page that fetched anything would also tell someone it had been opened. The
machine-readable bundle is embedded in it verbatim, so the document and the JSON
cannot disagree.

Unlike `brief` and `emit`, the command **exits non-zero** — on an unreachable
substrate, a chain that does not verify, or a breached objective. It does not sit
in a hook, and a document nobody can tell from a missing one is not evidence.

### It is a stub, and says so

The bundle carries `"stub": true` and a `pending` list naming what it cannot yet
attest to:

- the Solana devnet Merkle anchor and signature over the hour containing these
  events — **Phase 6**;
- the per-node cross-check against the Linear issue and Notion page states —
  **Phase 2**;
- model spend reconciled against the provider's own billing, rather than as
  collectors reported it.

Naming them beats letting their absence read as nothing to report. An evidence
document that overstates itself is worse than one that is honestly partial.

Only audit records naming the graph are included. A record with no `graph_id`
belongs to no graph, and folding those in would make every bundle a copy of the
whole trail; when a bundle has none, it says which.
