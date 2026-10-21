# Memory governance

Phase 0.5. Every `memory.write` — MCP tool, REST route, hook, collector — passes
through one gate before anything reaches `memory_entries`.

## Why memory is the fail-closed plane

The substrate's other non-negotiable is **fail open**: a substrate outage must never
block a prompt, so `events.emit` hands a caller its normalised event back even when
the ledger is unreachable, and every hook exits 0 either way. That is right for
events. A lost event costs the trail and nothing else.

Memory is not events. Memory is the plane other agents *act on* — it is what the
brief puts in front of the next session as "decisions in force" and "warnings". A
memory that lands wrong does not cost a trail; it sends the next four sessions down
a road that does not exist, and nothing in the system will contradict it.

So memory fails closed:

- A write the gate cannot authorise is `denied`.
- A write it cannot classify as safe is `quarantined`.
- A write that would silently replace something another agent is acting on is a
  `conflict`.
- A write it cannot read back afterwards is `accepted` with
  `verified_persisted: false`, which a consumer must treat as not stored.

`events.emit` keeps failing open. Nothing here changes that.

## The five stages

The order is the design, not an implementation detail.

| # | Stage | Where | Failure |
|---|-------|-------|---------|
| 1 | Shape | `memory-policy.ts` | `denied` — `scope.malformed`, `kind.unknown`, `ttl.unknown`, `text.empty` |
| 2 | RBAC, default-deny | `memory-policy.ts` | `denied` — `rbac.no-grant` |
| 3 | Quarantine | `memory-classify.ts` | `quarantined` — `quarantine.secret` / `.pii` / `.speculative` |
| 4 | Exactly-once | `memory-write.ts` | `conflict` — `write.in-flight`, `write.superseded`, `idempotency.reused`, or a replay |
| 5 | Conflict, insert, read-back | `memory-write.ts` | `conflict` — `review.required`, `version.required`, `version.stale`, `version.raced`, `standing.raced` |

**Why RBAC before the content check.** Storing text from a writer that has no
business at this scope is still storing it — even in the quarantine table. A
denied caller's secret should not end up parked for a reviewer to read.

**Why the read-back.** An insert statement returning is not the same claim as a row
being in the index. `verified_persisted` is the second claim, and it is the one a
consumer has to check.

## Default-deny RBAC: surface × scope × kind

A write needs a grant naming its writer, its scope class and its kind. There is no
implicit allow.

| Grant | Surfaces | Scope | Kinds |
|-------|----------|-------|-------|
| `graph-any` | every known surface | `graph:<id>` | decision, fact, warning, handoff, todo |
| `repo-working` | every known surface | `repo:<owner/name>` | decision, fact, warning, todo |
| `agent-self` | the surface itself | `agent:<own surface>` | fact, warning, todo, handoff |
| `global-standing` | every known surface | `global` | decision, fact, warning |

**Read the gaps — they are the policy.**

- `person:<name>` appears nowhere. A note about a human is not an agent's to write.
- `repo:` carries no `handoff`. A handoff is to a session or an agent; a repo-wide
  one addresses nobody and sits in every brief forever.
- `global` carries no `todo` and no `handoff`. A global todo is nobody's todo.
- `agent:` is self-only, for writes and for reads. An agent does not write into another agent's scope. `memory_search` returns an `agent:` row only to its own surface and only in the repo it was written for: the caller names that repo with `repo`, and a caller that names none gets no `agent:` row. A row written with no repo, or from before repos were recorded, is read by no caller. The brief reads `global`, `repo:` and `graph:` only, so it never carries another agent's `agent:` notes. A `handoff` at graph scope is how one agent addresses another.
- `"*"` means every *known* surface and never an unrecognised writer. An
  unauthenticated caller arrives as `unknown` and writes nothing at all. This
  is the teeth: default-deny that a wildcard quietly defeats is not default-deny.

**Swarm surfaces (ADR 0001 S3).** The 15 `swarm-a01-orch` … `swarm-a15-doc` surfaces are
known surfaces, so the `"*"` grants above already cover them; no swarm-specific grant
exists and none is needed. Under the default grants their working set is
`decision`/`fact` at `graph:` and `repo:` scope, and `fact` (not `decision`) at their own
`agent:<surface>` scope; another surface's `agent:` scope and every `person:` scope are
refused, and `global` (`decision`/`fact`) is a proposal until a reviewer token releases
it. `warning` (gate verdicts) and `handoff` stay grantable on purpose — the ADR routes
both through this gate. `teachable` is not a memory kind. With the default grants a swarm
`decision` at `agent:` scope is denied (`rbac.no-grant`); an operator grant in
`SUBSTRATE_MEMORY_GRANTS` can widen that, so a client acts on the gate's verdict rather
than refusing the write itself. Proven in `memory-write.test.ts` ("swarm surfaces —
default-deny proven from the outside").

Passing RBAC at `global` is permission to **propose** a global memory, not to
install one — see review, below.

### Only a token names a writer

The writer a memory write is attributed to comes from the bearer token and from
nowhere else. `POST /memory` ignores `writer` in the body and `memory_write` ignores
its `surface` argument; both report the surface actually used in the reply's
`writer`, so a caller never has to guess whether its argument was taken.

This matters most where it is least obvious. A deployment with no tokens configured
accepts anonymous callers — that is what keeps a local run usable — and it is
therefore the one deployment where nothing else stops a caller naming itself
`hermes` and collecting hermes's graph, repo and `agent:hermes` grants. RBAC is
decided on the writer's name, so a caller-supplied name is a caller-supplied
permission.

A local run that wants memory writable without tokens says so explicitly, with
either a surface token — `SUBSTRATE_TOKEN_CLAUDE_CODE=…`, one list-valued variable per surface — or
a grant naming `unknown` in `SUBSTRATE_MEMORY_GRANTS`:

```json
[{ "name": "local-dev", "surfaces": ["unknown"], "scopes": ["graph", "repo"], "kinds": ["fact", "warning", "todo"] }]
```

Both are one line and both leave a record of the decision, which is the difference
between a considered exception and a hole.

Operators widen the policy with `SUBSTRATE_MEMORY_GRANTS`, a JSON array appended to
the defaults. There is deliberately no variable that narrows them: a policy you can
loosen by deleting an environment variable is not one.

## Quarantine

Three classes of text never become memory other agents act on.

| Reason | Detected by | A reviewer can release it |
|--------|-------------|---------------------------|
| `secret` | the write-path redactor changed the text | **no** |
| `pii` | email, phone, national identifier, Luhn-valid card, IBAN | yes |
| `speculative` | hedging in a `decision` or a `fact` | yes |

Quarantine is not a refusal. The entry is kept — redacted — in `memory_quarantine`
where a reviewer can see it, so the writer's work is not lost and the pattern that
caught it can be argued with. What it costs is *visibility*: nothing in
`memory_quarantine` reaches a brief or a search.

A secret is the one class no token releases. The quarantine row holds the redacted
body, so nothing the redactor caught is persisted anywhere. The named rules live in
[`redaction.md`](redaction.md): `<private>` blocks and D-04 shapes now quarantine as
`secret` through the write-path redactor.

The classifier is as much about what must **not** fire:

- `git@github.com:owner/repo.git`, `noreply@…` and `@users.noreply.github.com` are
  not PII. Quarantining a memory for recording commit provenance would teach agents
  to stop recording it.
- A phone number must carry its `+` or be introduced by a word like "phone". A
  classifier that fires on `v1.24.3-4567`, on `127.0.0.1:7410` or on a Greptime
  millisecond epoch is one operators switch off.
- A 16-digit run is a card only if it passes Luhn.
- Speculation is checked for `decision` and `fact` only. A `todo` is *supposed* to
  be about what has not happened, a `handoff` describes what is left to do, and a
  `warning` that hedges ("this might break the poller") is the warning worth
  having.
- A bare "will" is not hedging. "The runtime will be herdr" is a decision, and it
  is how most real decisions are phrased.

## Conflict strategies

A write collides with another when they share a **conflict identity**: scope, kind
and `subject`. Not the text — two statements of the same todo in different words are
the same todo. Without a `subject` there is no identity, so the entry is appended.

- **`global` → require-review.** The blast radius of a global memory is every agent
  in every repo. The write is parked in `memory_reviews` and answered `conflict /
  review.required` with the parked id. Re-submitting the same content with a
  `review_token` installs it and marks the proposal approved.

  **Approving the same content twice is not a failure.** The refusal that parks a
  proposal does not pin the key — that is what makes approval-by-resubmit work — so
  the same content can be sent again without a token and parked again. Approving
  *that* proposal used to raise a duplicate key on `memory_reviews (entry_hash,
  state)`, and it raised it **after** the entry had committed: the caller was told
  nothing was stored while the entry sat in the index. Two things fix it. Uniqueness
  on `memory_reviews` now covers the **pending** rows only, which is all parking
  needs — a retried proposal still finds its own row, and a decided one never blocks
  a new one. And resolving a proposal can no longer fail the write: the entry is
  committed and the claim records it by then, so a proposal that cannot be resolved
  is a stale row in a reviewer's queue, not a write that did not happen. Such a row
  is cleared by the next retry under the same key: the replay re-runs the release,
  which is the only path that reaches it again once the key is spent.

  **An entry resolves only the proposals it answers.** Content is not the whole of a
  proposal, and a release matched on `entry_hash` alone would resolve any of them —
  including one parked *after* the entry was written, or one asking for a different
  `ttl`. Either would take a live request out of a reviewer's queue without
  installing what it asked for, and a replay (which carries no review token, because
  the token is not part of the request identity) reaches that call. So a proposal is
  resolved only by an entry written no earlier than it was parked and holding the
  retention it asked for. Retention is the only part of the ask the queue records: a
  parked row always carries the unreviewed trust and actor, because a reviewer
  decides those. Which is why the queue shows it — a reviewer installs a proposal by
  re-submitting it, so they have to be able to see the `ttl` they need to send, or a
  `30d` proposal is installed as `permanent` and stays pending with nothing on
  screen to explain why. It is shown without a reviewer token, like `scope` and
  `kind`: a retention class names no content.

  A proposal is parked even where the same content is already in force. An earlier
  attempt at this refused to park there, and it was wrong three ways: a global
  `fact` or `warning` is append-only and its trust decays, so restating one is how
  an agent refreshes it; `entry_hash` says nothing about the `ttl` or `trust` being
  asked for; and answering `accepted` spent the content's derived key on a row that
  write never made.

- **`decision` → versioned.** Optimistic concurrency. A caller replacing a standing
  decision must send `expected_version`; a missing one is `version.required` and a
  wrong one is `version.stale`, both quoting the current version and id. On success
  the new entry is version *n+1*, `supersedes` the old, and the old is retired
  rather than deleted — "why did this change" is what a decision log is for.
  `memory_search` with `include_superseded` reads the history.

  **Every versioned conflict carries `current_version`** — `version.required`,
  `version.stale`, `version.raced` and `standing.raced` on a decision with a
  subject. It is the `version` of the decision in force *now* for that scope and
  subject, looked up when the refusal is made (after a race, that is the winner's,
  not the one the write read). `null` means nothing is in force, so the re-submit
  carries no `expected_version`. A client re-submits with `expected_version` set to
  it and the same `idempotency_key`, without re-reading memory first — which matters,
  because a plain `memory_search` matches only the body and returns the newest 100
  entries, so a decision whose body lacks its subject's words and sits under 100
  newer entries cannot be found by one search (paging by `subject_prefix`, below,
  reaches it, one page at a time). The field is absent on every other reply,
  including a non-versioned `standing.raced`, and when the gate's own lookup of the
  entry in force failed: absence never means "nothing in force", and a client that
  sees none falls back to reading the entry.
- **`todo` → last-write-wins.** A todo has one current state and no interesting
  history. Making agents version their todo list would only teach them to stop
  writing todos.
- Everything else **appends**. Three warnings about one file are three warnings.

One entry is in force per identity, and `memory_standing_idx` makes that a database
invariant rather than a convention. Which is why retiring the predecessor and
inserting the replacement are one transaction: either order as two statements leaves
a window where the invariant is false, or where a standing decision is hidden behind
a write that never landed.

**Two first writes for one subject.** Under different idempotency keys, both writers
read no standing entry, so neither retires a predecessor and nothing in the plan
tells them apart — the index is the only thing between them. The insert is
`on conflict … do nothing` over `memory_standing_idx`, so the loser blocks until the
winner commits and then writes nothing and is answered `conflict / standing.raced`,
naming the entry that won. Its key records that conflict rather than staying in
flight, so the retry the remedy asks for — with `expected_version` for a decision —
is allowed immediately rather than after the takeover timeout.

## Provenance and trust decay

Every entry carries who wrote it (`writer`, `actor`), from where (`session_id`,
`graph_id`, `repo`), on what basis (`trust`, `source_event`) and under which rule
(`grant`, in the reply).

**An agent cannot vouch for itself**, and it cannot be somebody else either: a bearer
token overrides a caller-named `surface`, and every reply reports the `writer` the
write was attributed to. Neither door honours a caller-named writer at all — see
"Only a token names a writer" above.

| Requested trust | Granted when |
|-----------------|--------------|
| `agent-claimed` | always |
| `verified-by-test` | a `source_event` **the ledger confirms exists**, or a reviewer's token |
| `human-confirmed` | a reviewer's token, only |

The ledger lookup is the point. An event id nobody checked is a string, and granting
the verified label plus its longer shelf life on the strength of one would make
`verified-by-test` a decoration rather than a claim. It is the one place the memory
path reads Greptime, it reads a single column, and it runs only for a write actually
making that claim — so an ordinary write pays nothing. No ledger, an unreachable
ledger and an unknown id are the same answer: unconfirmed, so downgraded.

Anything else is recorded as `agent-claimed` and the reply says
`trust_downgraded_from`. `actor: "human"` needs a reviewer's token too — otherwise
the highest-trust level in the system is a string any caller can type.

**Trust decays.** This is confidence, not retention: `ttl` decides when an entry is
forgotten, the shelf life decides when it stops being something another agent may
act on without checking.

| Trust | Shelf life |
|-------|-----------|
| `agent-claimed` | 14 days |
| `verified-by-test` | 30 days |
| `human-confirmed` | 180 days |

`verified-by-test` sits below `human-confirmed` on purpose: a test verifies a claim
against one commit and the code moves, while a human decision holds until somebody
revisits it.

`reverify_after` is stamped at write time from the trust that was actually granted,
and `needs_reverification` is derived on read — so an entry decays where it sits,
with no sweeper job and no hour in which a stale entry still reads as settled. A
decayed entry is still briefed; the brief appends `— needs reverification` rather
than presenting it as settled, because dropping it would lose the only record that
the decision was ever taken.

## Lifetime: what `ttl` does on read

`ttl` is retention — the other half of the sentence above. Until uplift-3 N4 nothing
read it: a `30d` note from last quarter and a `graph` decision for a graph merged
months ago were briefed and searched like a `permanent` one, and the sweeper's two
`entries-ttl-*` classes stayed report-only because deleting what the reads still
served would have changed their answers. One predicate now answers the question
everywhere, `memoryExpiry(entry, graph, now)` in `memory-policy.ts`:

| `ttl` | Expired when | `expires_at` |
|---|---|---|
| `30d` | `created + 30 days` has passed | that instant |
| `graph` | the graph it lives for is finished (a status in `TERMINAL_GRAPH_STATUSES`, the sweeper's list) or has no `graph_index` row — swept, or never registered | none: its end is an event |
| `permanent` | never | none |

The graph a `graph` entry lives for is its `graph_id`, or the id of a `graph:` scope
when the write gave none (`memoryGraphId`); an entry with neither has no graph to
live for and is expired. An indexed graph whose row carries no status is open, as
`openGraphs` reads it. A `ttl` nobody defined, or a row whose `created` cannot be
parsed, never expires: a row we cannot classify is not one to hide on the strength
of the gap.

The index applies it at the one place entries are served (`IndexStore.servable`,
shared by `memoryForBrief` and `searchMemoryPage` — so the brief, `memory_search`,
the subject listings and the agent card cannot disagree): after a page is read,
one extra bounded query fetches the `graph_index` status of every distinct graph
the page's `graph` entries name, and the predicate runs in process. Every served
entry carries `expired` (and `expires_at` where the class has one), so a reader can
see what enforcement would do before it is turned on. What happens next is
`SUBSTRATE_MEMORY_EXPIRY`:

| Mode | Reads | Brief | Sweep `entries-ttl-*` | Counter |
|---|---|---|---|---|
| `report` (default, and anything unrecognised — with a boot warning) | expired entries served, tagged `expired: true` | listed with `— expired` | count only | `substrate.memory.expired{mode=served}` |
| `enforce` | expired entries left out unless the caller passes `include_expired` | left out | deletable, still only under `SUBSTRATE_INDEX_SWEEP=apply` plus `--apply` | `substrate.memory.expired{mode=hidden}` |

`include_expired` on `memory_search` is an operator action, gated like `force` on
the operator token: an agent cannot widen its own reads by typing a flag. It is
refused under `report` too, so the rule is learned once rather than at the flip.
The counter carries `surface` (the caller), the memory `kind` and `mode`, and is
taken where the index is read — a cache hit serves a copy and counts nothing. The
cache refreshes a search or a brief at the nearest `expires_at` it holds, as it
already did at the nearest `reverify_after`; a cached answer never outlives an
entry in it. Under `enforce` the memory cache keys change (the mode is part of the
key), so a flip followed by a restart cannot be answered from `report` entries.

**The retain forward refuses an expired entry in both modes** (`retain.expired`, a
`memory.retain.failed` warning naming the `ttl` and the reason, never the body).
`report` is about what the index still serves; a Hindsight bank keeps what it is
given until replaced, and copying a dead memory into one is wrong whichever way
the reads are set. The outbox replay meets this most — an entry parked for hours
can be past its lifetime by the time its turn comes — and a refusal there is
permanent, never retried. A `graph` entry the forward cannot judge (no index at
hand, or an index read that failed) is forwarded rather than guessed dead.

No row is deleted by any of this. Under `enforce` the sweep's two `ttl` classes
gain a delete, but it runs only on `apply`, which the env and the flag gate
separately — two switches, three keys, before a `ttl` row goes. The 30-day span
of the sweep's `entries-ttl-30d` cutoff is the predicate's own constant, and the
graph class names the graph the same way `memoryGraphId` does, so the sweep removes
exactly what the reads already hide (and, for `graph` entries, only once the
`graphsDays` window has also passed).

## Exactly-once

`memory_writes` holds one row per idempotency key ever spent.

- **An explicit `idempotency_key` is exactly-once for 30 days.** That is what the
  key is for; the sweeper (below) retires the spent record after that window, so a
  replay more than 30 days later writes again.
- **No key supplied** → one is derived from the governed content, and dedupes
  retries for 24 hours. Enough to survive a crash-retry without freezing memory:
  the same fact can be restated later.
- **Only an `accepted` record replays.** A refused write left nothing behind, so
  re-asking is allowed a fresh answer — which is also what makes
  approval-by-resubmit work when the caller sends its own key.
- **A key re-used for a different request is `conflict / idempotency.reused`**, not a
  replay. A key is the caller's promise that one write happens once; it cannot also
  stand for a second, different one. Returning the original entry there would tell a
  caller that asked to store B that B is in force, and nothing in the system would
  contradict it. Only an explicit key can reach this — a derived key *is* the request.
- "Different request" is wider than different text. It covers everything the caller
  **asks to have recorded**: the content, the `ttl`, the requested `trust` and `actor`,
  the `source_event`, and the `graph_id` / `repo` that decide which briefs the entry
  reaches. The same words asking for `permanent` instead of `30d` are asking for
  retention the stored row does not have, and answering `accepted` would be a
  falsehood about state the caller is about to rely on. `session_id` is excluded: a
  retry legitimately arrives in a new session, and the session that wrote the row is
  honestly the one recorded.
- This is a *second* hash, not a wider first one. The narrow content hash is how a
  parked proposal is matched to its reviewed re-submission, which asks for different
  trust on purpose — so widening it would break the review loop. Two questions, two
  hashes.
- `SUBSTRATE_HASH_VERSION` defaults to `v1`, which leaves every stored digest valid.
  `v2` is opt-in: the content and request preimages gain `hv` (the number 2) and
  `tenant` (`swc`) inside the hash only, with no new column. A write under `v2`
  stores the v2 digest and still matches a row written under `v1`. Event hashes
  and the ledger chain are unchanged in this slice, because a hash preimage that
  is not stored would fail `verifyChain`. Hindsight document ids are unchanged.
- **No remedy ever advises a fresh key where a row may already exist under the old
  one.** A remedy is what an agent acts on, so advice that can produce a duplicate is a
  defect in the gate and not merely in the prose.
- An in-flight claim answers `conflict / write.in-flight`; one abandoned for more
  than 60 seconds is taken over.
- A write that throws **releases** its key — but only while no row can exist, which
  means only before the insert was *attempted*. A connection lost during a commit
  throws and commits, and the exception cannot tell that apart from one that wrote
  nothing; treating it as "nothing happened" is how one write becomes two entries. So
  the claim is held across the whole in-doubt window. The cost is a key held for the
  in-flight timeout after a genuine outage, after which the successor takes it over and
  either recovers the row this attempt reserved or, inheriting the same reservation,
  writes it — both exactly-once. An abandoned claim is recoverable; a duplicate entry
  is not.
- The commit is **acknowledged before the read-back**, not after. Everything after the
  insert can throw, and an unacknowledged row is a row the retry would write again.
- Each hand-over mints a **fencing token**, and every later statement about the claim
  carries it. Without one, an attempt that merely ran slow past the in-flight timeout
  could come back and finish — or delete — the claim that replaced it.
- **The insert carries the token too**, checked inside the insert's own transaction and
  under the same row lock the hand-over takes. Fencing only the bookkeeping leaves the
  timed-out attempt still running and still reaching the insert, which for an appending
  kind is two visible entries for one write — the duplicate the claim exists to
  prevent. A fenced-out attempt writes nothing and answers
  `conflict / write.superseded`; the retry that took the key over owns the write.
- A claim **reserves the id** of the row it is about to write, and a hand-over *keeps*
  the reservation rather than replacing it. So when a successor takes over an abandoned
  claim, it looks for that row first: if the dead attempt committed and died before
  acknowledging it, the entry is returned (`recovered.orphan`) rather than written a
  second time — and a recovered global write also closes the proposal it came from,
  since the acknowledgement died and not the review.
- When that row turns out not to exist, the successor inserts **under the same reserved
  id**. A crash then stays recoverable without another write, and an attempt that was
  fenced out but is still running collides on the primary key instead of adding a second
  row: sharing the reservation makes the insert itself mutually exclusive.
- That lookup's failure is **never swallowed**. An error is not evidence the row is
  absent, and treating it as such would insert a second entry under a key that already
  has one. Failing the write costs a retry, which is recoverable; a duplicate memory is
  not.

A replay re-runs the read-back, so a write that came back
`accepted / verified_persisted: false` is confirmed by retrying it with the same
key — without writing a second row.

## The reply

```jsonc
{
  "outcome": "accepted",        // accepted | conflict | quarantined | denied
  "reason": "accepted",         // machine-readable, e.g. rbac.no-grant
  "remedy": "…",                // one actionable sentence, on every outcome
  "verified_persisted": true,   // durability, separate from the decision
  "idempotency_key": "mwd_…",   // empty where nothing was spent
  "entry": { /* … */ },         // on accepted
  "strategy": "versioned",      // append | lww | versioned | require-review
  "grant": "repo-working",
  "writer": "hermes"            // who it was attributed to, which may not be who asked
}
```

Plus, where they apply: `deduplicated`, `conflict_with`, `current_version` (a
versioned conflict; see [Conflict strategies](#conflict-strategies)), `review_id`,
`quarantine_id`, `quarantine_reason`, `trust_downgraded_from`.

**The contract for anything other agents act on is
`outcome === "accepted" && verified_persisted === true`.** Both, always. This is the
same honesty split as `EmitResult.stored`: the governance decision and the
durability claim are different questions, and collapsing them would hide exactly the
state this gate exists to surface.

`POST /memory` maps it for callers that can only see a status code:

| Status | Meaning |
|--------|---------|
| 200 | accepted and read back |
| 202 | accepted, not confirmed |
| 409 | conflict |
| 422 | quarantined |
| 403 | denied by policy |
| 503 | denied because the index is missing or refusing |
| 400 | the body is not a JSON object; no audit record is written and the gate is not run |

## Reading memory back: `memory_search`

`memory_search` (MCP) is the read path. It sees exactly what is in force in
`memory_entries`: never a quarantined write or an unreviewed proposal (those live in
their own tables), and a superseded entry only with `include_superseded`. Scope is the
caller's filter, not an authorisation: reads carry no per-scope RBAC, as before.

| Argument | Meaning |
|---|---|
| `query` | Full-text over bodies (`plainto_tsquery('english', …)`). Required unless `subject_prefix` is given; empty matches every body. |
| `scope` | Exactly this scope. |
| `limit` | 1–100, default 20. |
| `include_superseded` | Also retired versions: a decision's history. |
| `include_expired` | Also entries past their `ttl` under `SUBSTRATE_MEMORY_EXPIRY=enforce` (§ Lifetime). An operator action: refused without an operator token, in either mode. |
| `subject_prefix` | Only entries whose stored subject starts with this. Normalised like a subject (`normalizeSubject`: trimmed and lowercased) and matched literally with `left()`, so `%`, `_` and `\` are characters, not LIKE patterns. An entry with no subject never matches. |
| `before` | Cursor: an ISO-8601 instant with a zone. Only entries created strictly before it. |
| `before_id` | Cursor tie-break, only with `before`: also entries created *at* `before` whose id sorts below this. |

**Without `subject_prefix`, `before` or `before_id` nothing changed**: the reply is the
bare list of the newest `limit` matches, as it always was. The only difference is a
deterministic tie-break on `id` among entries with one `created`, where the order used
to be whatever Postgres returned.

**With any of them the reply is a page**:

```json
{ "entries": [ … ], "next": { "before": "2026-10-07T12:00:00.123456Z", "before_id": "mem_…" } }
```

The order is `created desc, id desc` and the cursor is that keyset pair: a page holds
the entries strictly before `(before, before_id)` in that order. `next` is the pair of
the page's last entry whenever the page came back full, and `null` otherwise; pass it
back as `before` and `before_id` until it is null. Two properties make that exact:

- **The pair, not the timestamp.** `created` defaults to `now()`, the transaction's
  start, so every entry one transaction writes shares it. A cursor on `created` alone
  would skip or repeat whichever of them a page boundary fell between.
- **Microseconds.** `next.before` is rendered by Postgres to the microsecond it stores.
  An entry's own `created` in the reply is a JS `Date`, cut to the millisecond; used as
  a cursor it would sit after entries it was cut from and skip them. Use `next`, never
  the last entry's `created`.

`query` and `subject_prefix` combine. Listing a subject family is
`{ scope, subject_prefix: "lesson:", limit: 100 }` and then the cursor until `next` is
null; this is how [`substrate lessons`](lessons-bank.md) reads every lesson in a scope
rather than the newest 100. To page a plain query from the top, give `before` any time
later than every entry. A malformed `before`, a `before_id` without `before`, an empty
prefix, or neither `query` nor `subject_prefix` is refused with `{ "error": … }` and
reads nothing.

### Scoped paging cost

Boot migration adds the idempotent, non-partial
`memory_scope_created_id_idx (scope, created desc, id desc)` B-tree. Scoped reads
emit a direct `scope = …` predicate and paired cursors emit
`(created, id) < (…::timestamptz, …::text)`, so Postgres can seek to the boundary
and return rows in page order instead of restarting at the scope's newest row.
A timestamp-only cursor still emits `created < …` and excludes the whole tie.
Optional predicates are omitted when absent, rather than hidden inside nullable
OR conditions that inhibit index bounds in generic prepared plans.

The index includes retired entries so the same access path supports history.
Visibility, literal prefixes and full-text conditions still filter candidates;
sparse matches can require more reads than the page size. The planner may prefer
the existing full-text GIN index and a sort for selective body queries. Unscoped
reads retain their semantics but this scope-leading index does not promise a
global ordered seek. The additional index costs storage and write maintenance;
its first boot-time build follows the existing non-concurrent migration pattern.

For a deep-page plan check, run the following with
`psql "$SUBSTRATE_TEST_PG_URL" -X -v ON_ERROR_STOP=1` against an **isolated test
database after migration**, never production. The temporary copy inherits the
actual migrated indexes and disappears on rollback; no durable memory is written.
The cursor is about 90,000 entries into a 100,000-entry scope, with shared
microsecond timestamps. No planner scan method is disabled.

```sql
begin;
create temp table memory_paging_probe
  (like memory_entries including defaults including indexes) on commit drop;
insert into memory_paging_probe (id, scope, kind, body, subject, writer, created)
select 'mem_explain_' || s || '_' || lpad(g::text, 6, '0'),
       'repo:explain-' || s, 'fact', 'paging plan fixture', 'lesson:fixture', 'test',
       timestamptz '2026-01-01T00:00:00Z' + (g / 7) * interval '1 microsecond'
from generate_series(1, 100000) g cross join (values ('a'), ('b')) scopes(s);
analyze memory_paging_probe;
set local plan_cache_mode = force_generic_plan;
prepare memory_page_probe(text, timestamptz, text, text, int) as
  select *, to_char(created at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created
  from memory_paging_probe
  where scope = $1 and superseded_by is null
    and left(subject, char_length($4)) = $4
    and (created, id) < ($2, $3)
  order by created desc, id desc limit $5;
explain (analyze, buffers)
  execute memory_page_probe('repo:explain-a',
    '2026-01-01T00:00:00.001428Z', 'mem_explain_a_010000', 'lesson:', 100);
deallocate memory_page_probe;
rollback;
```

The acceptance evidence is an ordered index scan beneath `Limit`, with **both**
scope equality and the `(created, id)` comparison in `Index Cond`, no `Sort`, and
100 returned rows without discarding the 90,000 newer rows. Merely seeing an index
name is insufficient: a cursor left in `Filter` still rescans earlier pages.
For the before-only variant, prepare the same statement with
`created < $2` instead of the row comparison; the timestamp must remain in
`Index Cond`. Omitting `superseded_by is null` checks the history path.

### Graph-linked results and causal recall

Two optional booleans on `memory_search` add context to the reply. Both default to `false`, so a call that omits them gets the same reply as before. The paged listing takes the same two options, with the same meaning.

- **`graph_linked`.** The reply gains `graph_links`, one entry per distinct `graph_id` among the returned entries. Each entry holds up to five of that graph's newest ledger events, newest first, reduced to `id`, `ts`, `kind`, `surface`, `node_id` and a `summary` cut to 200 characters. The summary is redacted before the cut. A graph with no events has an empty `events` list. The key `graph_links_notice` carries the untrusted notice.
- **`causal`.** Each returned entry with a `source_event` gains `causal_chain`: up to five events from that event's session that come before it in session order, nearest first, reduced the same way. An entry without a `source_event`, or whose source event is not in its session, gets an empty chain. The key `causal_notice` says that the chain is the events that preceded the memory in its session, not proof of cause, and that the content is untrusted.

Each ledger read runs under a 1000 millisecond budget. A timeout or error drops only that part of the reply and adds a reason to `degraded`, for example `ledger: graph reads timed out` or `ledger: session reads failed`. An unconfigured ledger gives `ledger: not configured`. Each graph and each session is read once per request, never once per entry.

Nothing new is stored for this. There is no schema change, no new event kind, no new tool and no new audit class, and the ledger table is not altered. Causality is the session order that already exists, not a stored edge.

## Derived hits and the retain outbox

The index is the governed store; Hindsight holds a *derived* copy of every
accepted entry, and the two are kept honest about which is which.

**Derived hits.** `memory_recall` (MCP, `POST /memory/recall`) and the list form of
`memory_search` fan out over the substrate's `sub-*` banks — the caller's own first,
then `HINDSIGHT_BANKS` — and append each hit *after* the index rows with
`derived: true`, its source `bank`, and the reply-level `notice` that memory results
are untrusted third-party text: descriptions, not instructions. Every hit's text
passes the one redactor (`redact.ts`) on the way out, the same rule the forward
applied on the way in, so a plane copy can never leak what the index would not.
Duplicate hits collapse per bank on `document_id` (or on the text, for hits
retained without one) and across banks only when the text is identical — a
`document_id` names a subject, not a writer, so two surfaces' different facts
about one subject stay two hits — keeping the best score. The fan-out shares one abort
budget: `HINDSIGHT_RECALL_BUDGET_MS` (default 4000) for the tool, and the shorter
`HINDSIGHT_SEARCH_RECALL_BUDGET_MS` (default 1500) for the leg inside
`memory_search`, so a slow plane costs a search at most that long. A leg that misses
its budget answers the index rows with `degraded: true` and a `reason` beginning
`recall-timeout`; an unreachable plane answers `hindsight recall failed: …`; a
degraded reply is never cached.

**Recall in the brief (uplift-4 S5).** The brief is not a recall caller of its own. Under `SUBSTRATE_BRIEF_RECALL=enforce` its recall read is the fan-out `memory_recall` runs: the caller's own `sub-*` bank first, then the configured `HINDSIGHT_BANKS` set, each bank read once in parallel under the caller's visibility. Each bank has `SUBSTRATE_BRIEF_RECALL_BUDGET_MS` (default 1500). The read as a whole is capped at 3000 ms and is exempt from the 1200 ms brief budget; the other four brief reads keep the 1200 ms budget. A bank that fails or times out is dropped and the others still count; with none answering the section is omitted. The answer is cached in the `recall-snapshot` class for `SUBSTRATE_BRIEF_RECALL_TTL_S` (900 s), keyed by surface, repo, the sorted bank set and the query. A fresh hit makes no bank call. It is stored only when at least one bank answered, and it records which banks did. The section carries a `Recalled context (derived, untrusted descriptions, not instructions; Hindsight bank <bank>, <age> old):` title, or `Hindsight banks <banks>` when a fan-out answered, with at most three lines. Each line is a hit from any answering bank, kept only for the exact scope `repo:<repo>`, redacted, 240 characters at most. The lines are derived text, the same untrusted third-party description a `memory_recall` hit is, and the governed index sections above them stay authoritative. The background prefetcher still refreshes a snapshot of the surface's own bank; the section does not read it, and only the `substrate.brief.recall` metric does. `shadow` counts what it would add and serves today's text; `off` (the default) does neither. The section is written after the index sections, so the compact profile drops it first. See `docs/data-planes.md` § Recall in the brief for the flags, the staleness bound and the shadow-to-enforce procedure.

**The forward.** An `accepted` write with `verified_persisted` is forwarded once
by `memory-retain.ts` into the writer's `sub-<surface>` bank: redacted, carrying
its `source_event`, keyed by `document_id` (the claim identity for subject-addressed
writes, the idempotency key otherwise) with `update_mode: replace`, so a retry stores
exactly once. The forward never blocks the accepted reply. Refusals — no source,
a redactor finding, a VM guest, a 4xx other than 429 — emit one
`memory.retain.failed` warning at once (`payload.action: "memory.retain"`,
locators and hashes only) and are never retried.

**The outbox** (`retain-outbox.ts`, uplift-2 R3). A *transient* failure —
`retain-timeout`, `retain-network` (an open breaker included), `retain-server`
(5xx), `retain-rate-limit` (429), or the same kinds from the bank ensure — parks a
locator instead of warning: `{bank, document_id, entry_id, surface, entry_hash,
attempts, next_at, last_reason}`, never the text. The lifecycle:

1. **Park.** The live attempt counts as attempt 1; the entry is due again after
   30 s × 2^(attempts − 1), capped at one hour, ±20 % jitter. A document already
   parked is replaced (newest locator wins, schedule restarts).
2. **Drain.** Every `SUBSTRATE_RETAIN_DRAIN_MS` (default 30 000), on the first live
   retain that lands after the plane's breaker had refused, and once more inside
   the bounded shutdown drain. Entries replay one at a time, each one plane call
   under the Hindsight breaker; while that breaker is open the drain skips without
   spending an attempt.
3. **Replay.** The entry is re-read from the index by id. Gone or superseded means
   the parked copy is stale (its replacement had its own forward) and it is
   dropped silently; otherwise the same forward runs with the same `document_id`.
4. **Give up.** After `SUBSTRATE_RETAIN_MAX_ATTEMPTS` (default 10) the entry is
   dropped and the warning the live forward used to emit is emitted then, with the
   last transient reason — the trail still ends with exactly one warning, later.
   A full outbox (`SUBSTRATE_RETAIN_OUTBOX_MAX`, default 10 000) drops its oldest
   entry the same way with reason `outbox-full`.

With `SUBSTRATE_RETAIN_OUTBOX_PATH` set (the unit points it at
`/var/lib/substrate/retain-outbox.jsonl`) the queue is a 0600 append-only JSONL file
in a 0700 directory, hydrated once at boot and rewritten compactly (temp file plus
rename) after a drain changes it, so a restart mid-backoff loses nothing. Unset, the
queue lives in memory: the same retries until the process stops, and at shutdown
whatever is left gets its warning rather than vanishing. The cache is never the
queue. `Substrate.retainOutboxStats()` reports `{size, oldestAt, attemptsTotal,
durable}`. `HINDSIGHT_RETAIN_TIMEOUT_MS` (default 8000) bounds each retain POST.

A bank that answers a retain with 404 was removed out of band: the client forgets
it, ensures it again (create, pin `chunks` mode) and retries once. At boot the server
warns when the legacy, unread `HINDSIGHT_BANK` is set and when `HINDSIGHT_URL` is set
with no `HINDSIGHT_BANKS` (recall then reads the caller's own bank only).

## Draining the queue

`memory_pending` (MCP) lists pending proposals and quarantined writes. **Bodies and
subjects require a `review_token`**: redaction strips credentials, not the email
address or phone number that caused a PII quarantine, so a queue that showed every
body to every agent holding any surface token would publish exactly what quarantining
it was meant to contain — and to more readers than accepting the write would have.
Without a token a caller still learns that something is parked, where, by whom and
why, which is the part worth knowing and none of it is the payload.

A reviewer releases one by re-submitting the same content with a `review_token`: the
write is re-decided with reviewer authority, and any pending proposal with the same
content hash is marked approved and pointed at the entry that landed.

With no `SUBSTRATE_MEMORY_REVIEW_TOKENS` configured, every review path stays closed
and the queue simply fills. That is the correct default — nothing forged gets
through — but it does mean an operator who wants global memories has to configure a
token.

## Retention: what the sweeper removes

None of the governance tables was ever deleted from before `index-sweep.ts`
(`substrate index sweep`, `substrate-index-sweep.timer`). It runs as a dry-run
report unless `SUBSTRATE_INDEX_SWEEP=apply` is set, and the CLI's `--apply`
additionally requires that env — two keys to delete. What it may remove, and when:

| Rows | Window (env) | Why that is safe |
|---|---|---|
| `memory_writes`, derived key, not in flight | 7 d (`SUBSTRATE_SWEEP_DERIVED_WRITES_DAYS`) | A derived key dedupes for 24 h; after that the row is already takeable |
| `memory_writes`, explicit key, not in flight | 30 d (`SUBSTRATE_SWEEP_EXPLICIT_WRITES_DAYS`) | The exactly-once window above; a later replay is a new write |
| `memory_reviews` decided (`approved`) | 30 d (`SUBSTRATE_SWEEP_REVIEWS_DAYS`) | An audit trail, not a queue; pending rows are never touched |
| `memory_quarantine` whose `entry_hash` later landed in `memory_entries` | 30 d (`SUBSTRATE_SWEEP_QUARANTINE_DAYS`) | The reviewer re-submitted it; the parked copy is redundant |
| `memory_entries` with `superseded_by` set | 90 d (`SUBSTRATE_SWEEP_SUPERSEDED_DAYS`) | The decision log; `memory_search includeSuperseded` loses history older than this |

Counted in every report and **never deleted**: unresolved quarantine rows (the
table has no decision column, so "pending" is anything whose content never
landed). The `ttl=30d` entries older than 30 days and `ttl=graph` entries whose
graph is finished or unindexed are counted too, and deleted only under
`SUBSTRATE_MEMORY_EXPIRY=enforce` — once the reads hide them, removing them
changes no answer; see § Lifetime. The graph tables follow `docs/data-planes.md`:
terminal graphs + 90 days.

`SUBSTRATE_MEMORY_LIFECYCLE` (default `report`) adds one read on that same pair
of classes when the sweep job opens the store. It prints each candidate's entry
id, writer, bank and Hindsight document id (no subject, no body), caps the
listed ids at `SUBSTRATE_SWEEP_BATCH`, and still reports the full count.
`off` skips the read. A typo stays `report` and warns at boot. The flag never
deletes.

## Weekly mental-model refresh

A mental model is a stored answer to one source query over a Hindsight bank.
A refresh asks Hindsight to re-run that query and rewrite the content, so the
answer follows the facts it was built from. The weekly job refreshes only the
models the operator names, and nothing else.

Name them in `HINDSIGHT_MENTAL_MODELS` as `<bank>=<id>[,<id>...]` entries
separated by `;`, for example `sub-omp=mm_a,mm_b;sub-hermes=mm_c`. A bank must be
in `HINDSIGHT_BANKS`, each id matches `[A-Za-z0-9_-]` up to 80 characters, and at
most 20 models are named in total. An entry that breaks a rule is dropped with a
boot warning; the valid entries still apply. Unset, no refresh runs and no timer starts.

- **Cadence.** Every seven days, with no jitter. The first pass is seven days after
  the process starts, so nothing runs at boot. A restart starts the count again.
- **Request.** One `POST /v1/default/banks/{bank}/mental-models/{id}/refresh` per
  named model, with an empty `{}` body, so each model runs in its own trigger mode.
  The API's `{"mode": "full"}` option is not sent.
- **Result.** Hindsight answers with an `operation_id` and a `status`. `ok` in the
  ledger means Hindsight accepted the refresh. The rebuild is asynchronous, and the
  job does not wait for it.
- **Ledger.** One note per model per pass: action `memory.mental_model.refresh`,
  surface `substrate`, session `mental-model:<bank>:<id>:<ISO week>`, payload
  `{action, bank, mental_model_id, status: "ok" | "failed", reason?}`. `ok` is a
  note; `failed` is a warning. `reason` is one of `auth`, `not-found`,
  `bad-request`, `rate-limit`, `server`, `timeout`, `network`, `invalid-response`,
  `unconfigured` (the Hindsight plane is not configured) or `unexpected`.
- **Failure handling.** Fail-open: a failed model never stops the others, a ledger
  write that fails is ignored, and nothing throws. A tick while a pass is still
  running starts nothing. Shutdown clears the timer and waits for a pass in flight,
  within the shutdown flush bound.

## Running the proofs

```sh
bun test                                  # the gate's decisions, against a fake store
SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.memory index-store.search
```

The gate's decisions are proved against a fake store, because the decisions are the
point and a Postgres would only slow them down. The two races above are the
exception: they are settled by a unique index, and a fake cannot reproduce an index
rejecting the second of two inserts that each believed they were the first. So
`index-store.memory.test.ts` runs them against a real database and skips, loudly,
without one. `index-store.search.test.ts` does the same for the read side: the literal
prefix, and the cursor through ties at one timestamp and within one millisecond.

## The lock

`packages/mcp-server/src/store-lock.test.ts` fails the build if memory grows a
second door: nothing outside `packages/mcp-server/src` may name a memory table in
SQL, `insertEntry` exists in exactly two files (the SQL and the gate that decides it
may run), `Substrate` reaches memory only through `governMemoryWrite`, and no
ungoverned `writeMemory` survives on the store.

Same argument as the Greptime lock in [`greptime-ledger.md`](greptime-ledger.md):
the reason RBAC, quarantine and exactly-once cannot be forgotten is that there is
nowhere to forget them from.

## Not in this phase

- SPE-4789 (Greptime memory projection) and SPE-4792 (leases) are separate.
- Rejecting a proposal explicitly, rather than leaving it pending, has no API yet.
- The quarantine and review tables are not pruned.
