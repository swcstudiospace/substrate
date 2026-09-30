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
| 4 | Exactly-once | `memory-write.ts` | `conflict` — `write.in-flight`, `write.superseded`, or a replay |
| 5 | Conflict, insert, read-back | `memory-write.ts` | `conflict` — `review.required`, `version.required`, `version.stale`, `version.raced` |

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
- `agent:` is self-only. An agent does not write into another agent's scope; that
  is what a `handoff` at graph scope is for.
- `"*"` means every *known* surface and never an unrecognised writer. An
  unauthenticated caller arrives as `unknown` and writes nothing at all. This
  is the teeth: default-deny that a wildcard quietly defeats is not default-deny.

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
either a token in `SUBSTRATE_TOKENS` or a grant naming `unknown` in
`SUBSTRATE_MEMORY_GRANTS`:

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
body, so nothing the redactor caught is persisted anywhere.

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
- **`decision` → versioned.** Optimistic concurrency. A caller replacing a standing
  decision must send `expected_version`; a missing one is `version.required` and a
  wrong one is `version.stale`, both quoting the current version and id. On success
  the new entry is version *n+1*, `supersedes` the old, and the old is retired
  rather than deleted — "why did this change" is what a decision log is for.
  `memory_search` with `include_superseded` reads the history.
- **`todo` → last-write-wins.** A todo has one current state and no interesting
  history. Making agents version their todo list would only teach them to stop
  writing todos.
- Everything else **appends**. Three warnings about one file are three warnings.

One entry is in force per identity, and `memory_standing_idx` makes that a database
invariant rather than a convention. Which is why retiring the predecessor and
inserting the replacement are one transaction: either order as two statements leaves
a window where the invariant is false, or where a standing decision is hidden behind
a write that never landed.

## Provenance and trust decay

Every entry carries who wrote it (`writer`, `actor`), from where (`session_id`,
`graph_id`, `repo`), on what basis (`trust`, `source_event`) and under which rule
(`grant`, in the reply).

**An agent cannot vouch for itself**, and it cannot be somebody else either: a bearer
token overrides a caller-named `surface`, and every reply reports the `writer` the
write was attributed to. On `POST /memory` a body-supplied writer is honoured only on
a deployment with no tokens configured at all.

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

## Exactly-once

`memory_writes` holds one row per idempotency key ever spent.

- **An explicit `idempotency_key` is exactly-once and never expires.** That is what
  the key is for.
- **No key supplied** → one is derived from the governed content, and dedupes
  retries for 24 hours. Enough to survive a crash-retry without freezing memory:
  the same fact can be restated later.
- **Only an `accepted` record replays.** A refused write left nothing behind, so
  re-asking is allowed a fresh answer — which is also what makes
  approval-by-resubmit work when the caller sends its own key.
- An in-flight claim answers `conflict / write.in-flight`; one abandoned for more
  than 60 seconds is taken over.
- A write that throws **releases** its key — but only while nothing has committed. Once
  the entry exists the claim is kept, because an abandoned claim is recoverable and a
  duplicate entry is not.
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
- A claim **reserves the id** of the row it is about to write. So when a successor takes
  over an abandoned claim, it looks for that row first: if the dead attempt committed
  and died before acknowledging it, the entry is returned (`recovered.orphan`) rather
  than written a second time.

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

Plus, where they apply: `deduplicated`, `conflict_with`, `review_id`,
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
