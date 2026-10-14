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

It has no compaction. It **rolls over by size** when `SUBSTRATE_AUDIT_ROLLOVER_BYTES`
is set, and never otherwise — see the next section. Do not point `logrotate` at it:
`copytruncate` truncates the file mid-chain, which is indistinguishable from
tampering to `verify`, and a plain rename behind the writer's back leaves it
appending to a file it has lost the name of.

### Rollover: one chain, several files

```
SUBSTRATE_AUDIT_ROLLOVER_BYTES=52428800
```

Unset, `0` or anything that is not a positive integer means the file is never
rolled, which is what every deployment before this setting did. Set, the writer
itself closes the active file once the *next* record would take it past that many
bytes:

1. the active file is renamed to `<path>.<firstSeq>-<lastSeq>.jsonl` in the same
   directory, mode 0600 — `mcp-audit.jsonl.1-9000.jsonl`, say;
2. a fresh active file starts at the **same** `path`, and its first record carries
   `prev` = the closed segment's tip hash. The chain never breaks: `seq` keeps
   counting and every `prev` still names the record before it, whichever file that
   record is in;
3. the checkpoint is carried forward untouched — it names the tip's `seq` and
   `hash`, not the tip's file.

A roll happens *between* records, never through one: the record that did not fit is
written whole into the new file, so no segment ends in half a line. A rename that
fails leaves the active file where it is and the record is appended there; the roll
is retried on the next append. The writer reads the setting itself, so a test, a
script and the service roll by one rule.

**Verification walks the segments.** `verify`, `/evidence`, `readAll` and
`scripts/audit-verify.ts` read every closed segment in sequence order and then the
active file through one `ChainWalker`, so a verdict always covers every record ever
appended, and a segment that is missing, edited, or does not continue the one
before it is reported exactly as a gap inside a single file would be. A closed
segment verified *alone* does not open at `seq: 1` and is rightly reported broken —
the chain it holds is only verifiable together with the segments before it. Keep
every segment.

```sh
bun run audit:verify                      # SUBSTRATE_AUDIT_PATH
bun run audit:verify --path /var/lib/substrate/mcp-audit.jsonl
# {"segments":2,"records":18412,"firstSeq":1,"lastSeq":18412,"ok":true}
```

It is read-only: it never opens the log for writing (the service is the single
writer), asks no store anything, and prints counts and positions only. It anchors to
`<path>.checkpoint` the way boot does, so segments deleted after their records were
committed read as **missing history** rather than as a shorter chain. Exit 0 when the
chain verifies, 1 when it does not, 2 on a usage error. Nothing is pruned
automatically; `docs/runbooks/disk-pressure.md` says what may be reclaimed on this
host, and audit segments are not on that list.

**Recovery after a roll.** A process that dies between renaming the active file and
writing the next record leaves no active file beside a closed segment. Boot reads
the newest segment's tail for the chain's position, checks it against the
checkpoint, and continues from it — `/healthz` does not report missing history for
that, because none is missing.

**The manual procedure still works** as the fallback when rollover is off: stop the
service, move the file *and* `<path>.checkpoint` aside together, start the service.
That starts a fresh chain whose first record has `prev: null`; the moved files hold
a complete, verifiable chain of their own. Moving the file without the checkpoint
makes the new chain report **missing history** — which is the point of the
checkpoint. A rolled-over chain needs none of this.

### The checkpoint, and telling a fresh install from a deleted file

Beside the file sits `<path>.checkpoint`: the last `seq` and `hash` this process
committed, rewritten after every append through a temporary file and a rename, so a
crash leaves either the old one or the new one and never half of each.

It exists because "the file holds no records" had two possible causes and the writer
could not tell them apart. A fresh installation legitimately starts at `seq: 1`. A
deployment whose audit file was deleted or truncated also has no records — and started
at `seq: 1` too, whereupon the new chain verified as intact and an evidence bundle
attested to it without a word about the decisions that had disappeared. That is the one
failure an audit cannot be allowed to have: the reader of an evidence document has
nothing else to go on.

With the checkpoint, the states are distinct:

| | |
| --- | --- |
| no checkpoint, no file | a fresh install. `seq` starts at 1. |
| checkpoint at `seq: N`, file holds `N` with the checkpointed hash | sound. The chain continues from the file. |
| checkpoint at `seq: N`, file accounts for fewer | **missing history.** |
| checkpoint at `seq: N`, file holds `N` with a *different* hash | **rewritten history.** |

The last row is why the checkpoint stores the **hash** and not just the count. Comparing
sequence numbers alone accepted a file replaced with a different, internally consistent
chain that happened to end at the committed `seq`: every hash and `prev` in it follows,
it opens at `seq: 1`, and nothing contradicted it — whereupon the next append rewrote the
checkpoint to match the impostor, so the substitution erased its own evidence. The
checkpoint read **at boot** is the anchor for the life of the process, and `scan` checks
the record at its `seq` against it on every verification, which also covers a file
replaced while the process is running and a file *ahead* of the checkpoint (where the tip
alone proves nothing).

In the last state the chain resumes from the checkpoint rather than from 1 — so nothing
reuses a sequence number, and the file's own first record is no longer `seq: 1`, which
means the head check reports the gap on the file's own terms as well. `verify` says so
outright for as long as the process lives, `/evidence` carries a note, and the service
warns at boot. **Appending still works**: refusing every fail-closed tool forever after a
disk mishap would be an outage in the name of an audit.

An unreadable or malformed checkpoint is treated as absent. A false alarm about tampering
is its own kind of damage, and a torn checkpoint is not evidence of loss.

### Recovery reads the tail, and grows the window when it has to

At boot only the file's tail is read, because an audit log has no compaction. A fixed
64 KiB window assumed the last record fit in it, and `params.name` in a JSON-RPC envelope
is a caller-supplied string — so the size was the caller's to choose. A record past the
window filled it with nothing but its own fragments, recovery found no complete record,
and the writer restarted at `seq: 1` on top of a file that already held a chain: every
later fail-closed call then appended to something no verifier could reconstruct.

Two things close that, and both are needed:

- **records are size-bounded.** Every stored field is capped (`MAX_RECORD_BYTES`), and
  the recovery window is never smaller than that bound — so "the last record did not fit"
  is a state this writer cannot produce.
- **the scan doubles its way back** to `maxScanBytes` before giving up, so a long record
  written by some other version of this code is found rather than skipped past.

If there are bytes and still no readable record, and no checkpoint to fall back on, the
chain **refuses to append at all**: `durable: false` with a reason at boot, every
fail-closed tool refused, and every fail-open call recorded as lost. That is the
fail-closed answer to a position that is not known, rather than a `seq: 1` written on top
of somebody's chain.

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

The consequence is deliberate: a closed segment, or a file rotated behind the
writer's back, does not open at `seq: 1`, and is reported broken when verified in
isolation. That is the truth about such a file — the chain it holds is only
verifiable together with the one it continues, which is why every verify path
walks the closed segments before the active file (see "Rollover" above).

The head check applies to a **file**, which holds every record ever appended. A
memory-only chain answers from a bounded tail (`maxRetained`), so once it has dropped
anything it opens past `seq: 1` legitimately, and `verify` skips the head check for
it. Requiring genesis of a window is a false alarm in the same bundle the real check
exists to protect, and a false alarm there costs the check its credibility. The
exemption is not available to a file.

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
| **fail-open** | every read — `memory_brief`, `memory_search`, `memory_pending`, `events_query`, `events_verify`, `graph_get`, `coord_handoff_verify`, `coord_handoff_list`, `coord_drift_scan` — plus `events_emit`, and the `/brief`, `/events`, `/events/query`, `/verify`, `/drift`, `/evidence` routes | These sit inside a prompt's hook budget. The substrate is not allowed to fail an agent's turn, and an unwritable audit file is not a reason to start. The call still produces a record; it is just not a gate. |
| **fail-closed** | `graph_claim`, `graph_release`, `graph_complete`, `graph_register`, `graph_heartbeat`, `graph_bind`, `memory_write`, `coord_handoff`, `coord_reap_leases`, `desktop_run` | Everything that grants or transfers exclusive ownership of a node, or writes shared state another agent will act on. A claim nobody recorded is how two agents end up holding one node, and the whole point of `graph_claim` is that they cannot. |

### Planned in v1.3

The audit mode of every MCP tool v1.3 plans to add is decided here, before any of
them ships, so no publication path ever runs undecided. Each tool's own phase does
its `registerTool` and `KNOWN_TOOLS` registration and inherits the mode below.
The event side of the same contract — which kinds and surfaces v1.3 sources emit —
lives in [event-vocabulary.md](event-vocabulary.md).

| Tool (phase) | Mode | Why |
| --- | --- | --- |
| `skills_propose` (21, **landed**) | fail-closed | Opens a PR other agents will receive after merge; a proposal nobody recorded is an unaudited publication. Served as the MCP tool and as `POST /skills/propose`, which is audited under the same name before any git work and answers `503` when the chain cannot take the record. |
| `docs_ingest` (25) | fail-closed | Writes a shared dataset every agent reads; it is also a publication path. |
| `desktop_run` (30) | fail-closed | Acts on a desktop — landed in Phase 30 (DESK-03 covered by unit and HTTP tests; live desktop smoke NOT-RUN). |
| `docs_search` (25) | fail-open | A read inside an agent's turn. |
| `issue_get` (23) | fail-open | A read of untrusted tracker text. |
| `graph_find` (23) | fail-open | A read of the index. |
| `memory_recall` (26) | fail-open | A read like `memory_search`. |
| `agent_card` (29) | fail-open | The Agent Card REST route is a read, audited under this name. |

**An unknown tool is fail-closed.** Deny by default, like `assertAppendOnly` in the
ledger client: a tool added without a decision about its audit mode is caught the
first time it is called rather than becoming a permanent hole.

**Both lists cover the tools this substrate serves plus the v1.3 planned tools marked by phase**, and `policy.test.ts`
pins that. Default-deny is there to catch a tool nobody has decided about; it is not
meant to be what carries the decision for one somebody has. Leaving the read tools out
of the fail-open list meant an unwritable audit file refused `events_query`,
`events_verify`, `memory_pending`, `coord_handoff_list` and `coord_drift_scan` while
both their backing stores were healthy — the audit sink failing took out reads it exists
not to gate.

## REST is audited under the same names, and honours the same modes

Every route that reaches the service goes through one wrapper, `auditedRest`, under the
MCP tool's own name where there is one: `POST /memory` is audited as `memory_write` and
`POST /handoff` as `coord_handoff`, so one action does not appear in the trail twice
under two names. Only `/healthz`, `/metrics`, `/slo`, `/slo/history` and `/livez` are exempt; no agent action is
behind them and a trail dominated by a Prometheus scrape is one nobody reads. `/slo/history` is served
beside `/slo` under the same bearer rule (a token, unless `SUBSTRATE_ALLOW_ANONYMOUS=1`) and is
admission-metered as a `read` (`ROUTE_CLASSES`).

REST twins of planned v1.3 tools (`POST /skills/propose` has landed, see
[skills-propose.md](skills-propose.md); `/docs/search`,
`/docs/ingest`, `/issue`) are audited under their tool's own name when they land,
and inherit that tool's mode.

**A REST route inherits its tool's mode, denial included.** Auditing MCP `memory_write`
as fail-closed while `POST /memory` wrote shared memory unaudited left the policy with an
unlocked door beside it — and a hook, which cannot call an MCP tool, walks through that
door by design. A fail-closed route the chain will not record is answered **503** with
the reason: an audit sink that cannot take the record is an outage of this substrate,
not a permission decision about the caller, and a hook reading only the status code must
not learn "you may not" from it.

The mode decides for an *unexpected* fault in the audit path too, not only for a sink
that refused. A body can overflow the argument encoder — `canonicalJson` is recursive, so
deep enough nesting throws inside the body-size limit — and treating that as a denial
made a fault in the audit able to refuse `/brief`, which is fail-open precisely so the
substrate cannot fail an agent's turn. The audit becoming a new way to lose a brief is
the thing the mode exists to prevent. So a fail-open route is served with the fault on
stderr, and a fail-closed route is refused, where the unrecorded write is the worse
outcome.

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

`/healthz`, `/metrics`, `/slo`, `/slo/history` and `/livez` are not: they are monitoring traffic, no agent
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

"Does not verify" covers a chain that **could not** be verified, not only one that came
back broken. Each chain carries a `state`, because `ok` alone could not tell the two
apart:

| `state` | | exit |
| --- | --- | --- |
| `verified` | the chain was recomputed and holds | 0 |
| `broken` | it does not verify | non-zero |
| `unverifiable` | it exists and the store would not answer | non-zero |
| `not-configured` | this deployment has no such chain | 0 |

Checking `ok === false` alone meant a Greptime outage produced a bundle whose app chain
was `unknown` and an exit status of 0, as long as no objective happened to be breached —
so a caller that trusted the status shipped an unverified document as a verified one. The
document is still written in that case, because an operator investigating the outage needs
it, and it says **unverified** on its face.

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

### One pass over the audit file

Verifying the chain and then selecting the graph's records used to be two whole reads and
two whole parses of a file with no compaction, with the request's own record appended
between them — so an ordinary authenticated `/evidence` call cost twice the trail, and a
few in a row could take down a process every prompt on this host waits for.

`verifiedView` does both in one streaming pass: the file is read a line at a time rather
than as one string, the chain is checked incrementally by the same rules
`verifyAuditChain` applies in memory (one `ChainWalker`, so the two cannot drift), and
what is held is *this graph's* records rather than all of them, bounded at
`MAX_EVIDENCE_RECORDS`. The cost is therefore proportional to the graph being asked
about, whatever the file grew to around it, and the chain verdict still covers every
record in it.

Two things about that window matter more than the bound itself.

**It keeps the newest records, not the first.** A claim withdrawal and a batch correction
come, by construction, *after* the record they correct — so a window over the oldest
records dropped exactly the decisions a reader of the tally is looking for.

**The tally is not bounded with the listing.** Counting from the listed window reported a
busy graph as having only the decisions that happened to be listed, which is a wrong
number rather than a partial one, and a note saying "truncated" does not make it right.
So the counting is separated from the keeping: every matching record goes through
`StatsAccumulator` (the fold `auditStats` is also written in terms of, so the two cannot
disagree) and only a window is retained. The bundle says how many records name the graph,
how many are listed, and that the tally covers all of them.

Two consequences of separating them, both handled:

- **The breakdown is bounded even though the totals are not.** `tool` comes from a JSON-RPC
  `params.name` and is audited *before* the dispatcher validates it, so the set of distinct
  names in a file is a caller's to choose — and a tally over every record rather than over
  the window made that set what `/evidence` builds and serialises. Past `MAX_TALLY_KEYS` the
  breakdown collapses into `_overflow`, the same trade `MetricRegistry` makes; the totals
  stay exact and the breakdown still sums to them.
- **The window is a ring.** Appending and dropping the first entry shifted the whole window
  per matching record, so a graph past the cap paid O(n·window) on the very request this
  single-pass rework exists to make cheap. One write per match, one rotation at the end.

**The graph id is sanitised the same way the records were.** `buildRecord` redacts and
caps `graph_id` like every other stored field, so a graph whose identifier contains a
credential-shaped substring is stored under its redacted form — and selecting on the raw
identifier matched none of its own records, so its bundle silently omitted every decision
made about it. The query is normalised to the stored form, which is what the ledger
already does for the same reason (`verifyGraph` reads by `normalizeIdentifier(graphId)`).
The residual cost is that two identifiers cleaning to the same string are
indistinguishable once stored, so the selection may hold another graph's decisions and
nothing in the file can separate them. A note saying so is **not** enough: the bundle is
labelled for one graph and a reader takes its tally as that graph's. So it is a state
instead — `audit.attribution` is `ambiguous`, and `substrate evidence` exits non-zero on it
exactly as it does for a chain it could not verify. The records are still listed, because an
investigator needs them; what the bundle no longer does is claim they are one graph's.

**The bundle also names the graph in its stored form, not the string it was asked with.**
An evidence bundle is written to a file, served over HTTP and archived, and a caller can put
a credential in a graph id — so echoing the raw identifier carried into the document, and
into the HTML rendered from it, exactly the value every other field went to the trouble of
removing. For every ordinary `ut-…` identifier the two forms are the same string.

The real remedy is upstream of all of this: a graph identifier that redaction changes is not
usable as a key, and rejecting it at registration would remove the collision everywhere
rather than reporting it. That is a change to the shared event path rather than to these
packages, so it is noted here rather than made.

**The same key reads the usage back.** The metric attribute holds the normalised
`graph_id` too — the observer is handed the identifier off the *stored* event, and
`normalizeIdentifier` is the same redact-then-cap as `sanitizeField` — so looking usage up
with the raw id matched nothing and the bundle reported no tokens or cost at all, which a
reader cannot tell from a graph that spent nothing. `storedGraphId` is what `buildEvidence`
selects on, so the audit records and the usage are keyed alike.

## What a record keeps of its caller, and what it does not

Arguments are never stored — only their names and a digest. On top of that, **every
stored field is redacted and capped**, not just `reason`:

`surface`, `tool`, `graph_id`, `node_id`, `session_id`, `actor` and the argument names all
arrive from the request envelope, and the gate runs *before* any tool validates them. A
credential in `graph_id` on a call that was then refused and never ran reached the file
verbatim — in the one file that exists to be read during an incident, while the app-event
write path would have stripped the same string. The trail must not be the more attractive
copy of the two.

The caps (`MAX_IDENTIFIER` 512, matching `MAX_FIELD` on the event path; `MAX_TOOL_NAME`;
`MAX_ARG_KEYS` × `MAX_ARG_KEY`; `MAX_REASON`) do a second job: they are what makes a
record's size the writer's to decide rather than a caller's, which is what recovery and a
bounded file both rest on.

The **digest is untouched** by any of it. Its whole job is proving that a request an
investigator holds is the one that was allowed, byte for byte; digesting a redacted copy
would break that for every request with a credential-shaped string anywhere in it.
