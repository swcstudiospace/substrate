# Lessons bank

A lesson from a finished phase becomes governed memory that a later phase can recall
and cite by id. This is Tier 1 of SPE-5830, as decided on 2026-10-07 in
[`research/self-improving-memory-bank-proposal.md`](research/self-improving-memory-bank-proposal.md#decision-2026-10-07-tier-1-storage).

**There is no lessons table, no lesson kind and no lessons write path.** Each lesson is
one `fact`, written through the same gate as every other memory (`POST /memory`), so
RBAC, quarantine and exactly-once apply to it unchanged, and `store-lock.test.ts` holds.
What the gate has no column for (milestone, phase, outcome, tags, source) travels in a
header at the top of the body. Everything derived (ranking, digests, success scores) is
computed by the `substrate` CLI when it reads, from facts that only ever append.

## Commands

```sh
substrate lessons add --from .planning/phases/15-lessons-bank/15-01-SUMMARY.md --dry-run
substrate lessons add --from .planning/phases/15-lessons-bank/15-01-SUMMARY.md
substrate lessons add --text "Leases expire lazily; no reaper is on the path." --phase 11-lease-authority --tags lease
substrate lessons recall "lease heartbeat"
substrate lessons outcome mem_… --result success --phase 12-swarm-leases
substrate lessons digest v1.1
```

| Command | Writes | Exit status |
|---|---|---|
| `add --text T --phase P [--milestone M] [--slug S] [--tags a,b] [--outcome O] [--source PATH]` | one lesson | 0 when every lesson is `recorded` or `duplicate`, else 1 |
| `add --from SUMMARY.md [--key-decisions] [--milestone M] [--phase P] [--tags a,b] [--skip slug,…]` | one lesson per bullet | same |
| `recall [QUERY] [--limit N] [--half-life DAYS]` | nothing | always 0: it fails open |
| `digest <milestone> [--ids a,b [--unchecked]] [--text T]` | one digest | 0 when `recorded` or `duplicate`, else 1 |
| `outcome <lesson id> --result success\|partial\|failure --phase P [--milestone M] [--note T] [--unchecked]` | one outcome | same |

Every command takes `--scope S` or `--repo owner/name` and `--json`. `add`, `digest` and
`outcome` take `--dry-run`, which prints the subject, key and body and sends nothing. That
is the human review step: read the dry run, drop a lesson with `--skip <slug>` or by
editing the SUMMARY, then write. A usage error exits 2.

The scope defaults to `repo:<owner/name>`, read from the `origin` remote the same way
`brief` and `drift` read it. The default grant `repo-working` lets every known surface
write a `fact` there. A `global` lesson is a proposal until a reviewer releases it; `add`
reports it as `review` with the review id.

`--milestone` defaults to the archive directory a SUMMARY was filed under
(`.planning/milestones/<milestone>-phases/…`), then the SUMMARY's frontmatter, then the
`milestone:` in `.planning/STATE.md`. `--phase` defaults to the SUMMARY's frontmatter
`phase:`, then its directory.

The CLI reads `SUBSTRATE_URL` and `SUBSTRATE_TOKEN` like every other `substrate` command.
The token decides the writer, as it does for any memory write; with no token on a
configured deployment the server answers 401, and on an anonymous one the writer is
`unknown`, which holds no grants. `SUBSTRATE_TIMEOUT_MS` defaults to 10 s for `lessons`
rather than the hooks' 1.5 s: nothing waits on a lessons command, and a write cut off
mid-flight is one whose outcome nobody knows.

Transport diagnostics remove URL userinfo, queries and fragments, redact configured
credential values and recognised credential patterns, then cap each remote diagnostic
at 200 characters. HTTP status and a scrubbed reason remain available, including for
refused writes. This affects diagnostics only: the request URL, authorization and body,
governed write decisions, and successfully recalled lesson content are not rewritten.

## What gets written

A **lesson** is a `fact` at the scope:

```text
subject:          lesson:<milestone>/<phase>/<slug>
idempotency_key:  lesson:<sha256(scope + "\n" + source path + "\n" + whitespace-collapsed text)>
body:
[lessonbank]
milestone: v1.1
phase: 08-memory-structures
outcome: success
tags: memory, governance, idempotency
source: .planning/milestones/v1.1-phases/08-memory-structures/08-01-SUMMARY.md

quarantined and review.required are returned to the caller, never retried.
```

- The slug is the first six words that carry meaning, or the bold lead of a SUMMARY
  bullet. Subjects are lowercase and at most 200 characters, which is what the server
  stores them as. Two bullets in one SUMMARY that would share a slug get `-2`, `-3`.
- `outcome` is how the phase that taught the lesson went: `success` (default),
  `partial`, `blocked` or `deferred`.
- `source` is the SUMMARY's path relative to the checkout, or
  `inline:<milestone>/<phase>` for `--text`. The key hashes the scope, the source and the
  text and nothing else, so **adding a lesson twice to one scope yields one entry**: the
  second write replays the first and comes back `duplicate` with the same id. Re-wrapping
  the text does not change the key. The scope is in the key because the server's
  idempotency keys are global; the same lesson added to another scope becomes that scope's
  own entry. Changing the header (tags, outcome) under the same key is a `conflict`
  (`idempotency.reused`): the entry already recorded stands. Digest and outcome keys
  include the scope for the same reason.
- A body longer than 4000 characters, the gate's cap, is refused before it is sent rather
  than cut.

The first header line is a marker: `[lessonbank]`, and `[lessonbankdigest]` and
`[lessonbankoutcome]` on digests and outcomes. It says the lines below it are a header,
and it is what reads fall back to on an older substrate (see [Reading the bank](#reading-the-bank)).
The subject, not the marker, decides what an entry is.

A `lesson:` fact without the header, for example a swarm retro written to the same
subject convention, is still a lesson: its subject carries the milestone and phase.

## Lessons in a SUMMARY.md

`add --from` reads every top-level bullet under a `## Lessons` heading (also `## Lesson`,
`## Lessons learned`, at `##` or `###`) up to the next heading of the same or a higher
level:

```markdown
## Lessons

- **Leases fence on epoch**: a stale holder cannot release a lease it lost. [tags: lease]
- Heartbeats stop on a `lost` or `expired` refusal and re-claim instead.
  An indented line continues the lesson above it. [tags: lease, heartbeat] [outcome: partial]
```

- One bullet is one lesson. Indented lines and nested bullets belong to the bullet above;
  an unindented paragraph ends it.
- `[tags: a, b]` and `[outcome: …]` are taken out of the text and into the header. Every
  lesson also inherits the SUMMARY's frontmatter `tags:`.
- A bold lead (`**…**`) names the slug and stays in the text.

The v1.1 archive predates this section. Its SUMMARYs record their lessons as frontmatter
`key-decisions:`, and `--key-decisions` takes those instead.

### Write lessons as facts

The gate quarantines a `fact` that hedges, and a quarantined lesson is reported with its
quarantine id and **not retried**: asking again only gets the same answer. Reword it as a
statement of what happened and add it again. The words that quarantine a `fact`
(`memory-classify.ts`, case-insensitive, whole words):

> probably, perhaps, maybe, might, I think, I believe, not sure, unsure, unverified,
> untested, assume / assumes / assumed / assuming / assumption, should work, seem(s) to,
> appear(s) to, plan(s) to / planning to, intend(s) to / intending to, likely, TBD,
> to be decided, guess / guessing, hypothesis, hypothetical, speculat…, proposed plan,
> draft plan, if this works

"Retries reuse the key, so a retry never writes twice" is a lesson. "Retries should
probably reuse the key" is a plan, and the gate treats it as one. Secrets and PII are
quarantined too (see [`memory-governance.md`](memory-governance.md#quarantine)); a secret
is the one class no reviewer can release.

A lesson counts only when the gate's reply is `accepted` **and** `verified_persisted`.
`add` prints `recorded` or `duplicate` with the entry id for those, and no id otherwise.
An accepted write that was not read back is sent once more under the same key, the one
retry that is always safe because the replay re-verifies instead of writing again; if it
is still unverified it is reported as `unverified`, without an id.

## Recall

```sh
substrate lessons recall "lease takeover heartbeat" --limit 5
```

prints a block to paste into a phase's CONTEXT.md:

```markdown
## Prior Lessons

From the lessons bank in `repo:swcstudiospace/agent-substrate` for "lease takeover heartbeat". Cite a lesson in PLAN.md by its entry id, as `[lesson <id>]`.

- `mem_3f…` lesson:v1.2/11-lease-authority/heartbeats-stop-lost-expired-refusal (v1.2/11-lease-authority; success; score 0.67 from 1 outcome; 2026-10-09): Heartbeats stop on a lost or expired refusal… [tags: lease, heartbeat]
```

Ranking is done by the CLI:

$$\text{rank} = \text{match} \times 0.5^{\,\text{age}/\text{half-life}} \times (0.5 + \text{score})$$

- **match** is the share of query terms the entry carries: a term found in a tag counts 1,
  a term found only in the subject or text counts ½. An entry that matches no term is left
  out. A plural `s` is folded, so `leases` finds `lease`.
- **age** halves the weight every `--half-life` days (default 90).
- **score** is the read-time success score below, 0.5 when nobody has reported on the
  lesson.
- `--limit` defaults to 5 (at most 20). Digested lessons are left out in favor of their
  digests. Earlier partial batches remain candidates until a newer digest of the same
  milestone covers every id in the earlier batch; disjoint or partially overlapping
  batches do not replace one another.

The candidates are every lesson in the scope, every digest and every outcome, read as
described next; ranking happens over all of them.

## Reading the bank

Every read lists a subject family whole. `recall` pages three prefixes in the scope:
`lesson:` (the candidates), `lesson-digest:` (the digests, and the ids they exclude) and
`lesson-outcome:` (the reports the scores are computed from). `digest` and the id check in
`outcome` page `lesson:` and `lesson-digest:`; `outcome`'s scores page
`lesson-outcome:<id>`. Each is `memory_search` with `subject_prefix` and no `query`, 100
entries a page, following the keyset cursor (`next: { before, before_id }`, ordered
`created desc, id desc`) until it comes back null. See
[`memory-governance.md`](memory-governance.md#reading-memory-back-memory_search) for the
contract.

So a lesson is found however many newer entries sit above it, lessons or not. The
earlier design read the newest 100 bodies carrying the marker, plus the newest 100 per
query term; in a busy repo that lost older lessons that did not share the query's words,
and lost scores and digests outright once a family passed 100.

- **A page cap.** One family is read to at most 50 pages (5000 entries). Hitting it is
  said on stderr (`stopped reading lesson: entries … after 50 pages`), and the
  not-in-the-bank messages of `digest --ids` and `outcome` say how far they looked.
- **An older substrate.** One whose `memory_search` predates `subject_prefix` rejects the
  call (its schema still requires `query`). The CLI then falls back to the earlier
  marker searches: one for every lesson plus one per query term (at most six), and one
  each for digests and outcomes, the newest 100 each. It says so in one line on stderr
  and carries on; recall still never fails a session. A 401 or any other refusal is not
  taken for an older server: it is reported as the bank not answering.

**Recall fails open.** If the substrate does not answer, or refuses the search, nothing
is printed on stdout, the reason goes to stderr, and the exit status is 0: a phase that
cannot reach the bank goes ahead without prior lessons rather than not at all.

## Digests

```sh
substrate lessons digest v1.1 --dry-run
substrate lessons digest v1.1
```

writes one `fact` with subject `lesson-digest:<milestone>`:

```text
[lessonbankdigest]
milestone: v1.1
lessons: mem_a…, mem_b…, mem_c…

Milestone v1.1 rolls up 3 lessons.
- mem_a… lesson:v1.1/08-memory-structures/…: what it said
```

- By default it rolls up every lesson filed under the milestone (`lesson:<milestone>/…`).
  `--ids a,b` names the set instead, for example the lessons the
  milestone's plans cited; an id that is not a lesson in the scope is refused unless
  `--unchecked`. `--text` supplies a summary in place of the generated first line;
  it is required when any selected id has no readable lesson content.
- **Nothing is deleted.** There is no delete path, and the originals stay readable through
  `memory_search`. Recall leaves the listed ids out and cites the digest instead.
- The `lessons:` line is the contract. Generated digests retain a subject and an excerpt
  (up to 200 characters) for every selected lesson. If those lines and all ids do not fit
  within 4000 characters, the command refuses without writing: split the set with
  `--ids`, or provide a concise `--text` summary that preserves the lessons' topics.
  With explicit `--text`, the per-lesson lines can be omitted, but the summary and every
  id must still fit. An ids-only digest with a generic roll-up sentence is never generated.
- The key hashes the scope, milestone, sorted ids and text, so re-running a digest over
  the same lessons is the same entry.

## Outcomes and the success score

After a phase that cited a lesson is verified, report how the lesson worked out:

```sh
substrate lessons outcome mem_3f… --result success --phase 12-swarm-leases --note "Takeover held under load."
```

This appends one `fact` with subject `lesson-outcome:<lesson id>`, in the `repo-working`
grant like the lesson itself:

```text
[lessonbankoutcome]
lesson: mem_3f…
result: success
milestone: v1.2
phase: 12-swarm-leases

Takeover held under load.
```

It prints the lesson's score before and after. **Nothing is mutated in place**: the
lesson's entry is never touched, and a score is never stored. It is computed on every
read from the outcome facts that name the lesson:

$$\text{score} = \frac{1 + \sum w}{2 + n}, \qquad w_{\text{success}} = 1,\ w_{\text{partial}} = \tfrac12,\ w_{\text{failure}} = 0$$

where $n$ counts one report per citing phase, the newest. When timestamps tie at
JavaScript's millisecond precision, the server's newest-first order decides which
report counts. A phase that changes its verdict appends another outcome, and the newer
one replaces the older in the score instead of adding another vote.

The key hashes the scope, lesson id, citing milestone/phase, result and
whitespace-collapsed note, plus the id of that phase's newest prior report with a
different result or note (when one exists). Identical retries skip identical reports
when finding that prior state, so they reuse the key even after persistence. A
success → failure → success correction therefore appends a new success rather than
replaying the first one. Note-only corrections follow the same rule; reports from
another phase or scope do not change this key.

`outcome` refuses an id that is not a lesson or digest in the scope, because an outcome
is permanent; `--unchecked` records it anyway. An outcome body exceeding 4000 characters
(including its header) is refused before writing, also during `--dry-run`; shorten the
note and try again.

## In the GSD loop

Lessons are retrieved only at discuss time, cited by id in the plan, reported on after
verification, and written at phase close.

1. **Discuss.** Before writing `CONTEXT.md`, recall with the phase goal's key words and
   paste the block in as its own section:

   ```sh
   substrate lessons recall "lease heartbeat takeover" >> .planning/phases/12-swarm-leases/CONTEXT.md
   ```

   An empty block (`No lessons … matched`) is a real answer; no output at all means the
   bank was unreachable (see stderr).
2. **Plan.** Where a task follows from a lesson, cite it by entry id in `NN-MM-PLAN.md`:
   `… heartbeat at a third of the TTL [lesson mem_3f…].` The id is the only stable
   reference: subjects are not unique, and the text can be rolled into a digest.
3. **Verify.** For each cited lesson, record whether it held:
   `substrate lessons outcome <id> --result success|partial|failure --phase <phase>`.
4. **Phase close.** Put the phase's lessons under `## Lessons` in its SUMMARY.md, review
   them with `substrate lessons add --from <SUMMARY> --dry-run`, then write them.
5. **Milestone close.** `substrate lessons digest <milestone>`.

## Not in Tier 1

- Phase lifecycle events, an outbox, SSE and Dragonfly: Tier 2. If lifecycle events are
  built they are `note` events with a payload type, because `EVENT_KINDS` is closed.
- Automatic writes. Every write is a command a human runs after reading the dry run.
- Similarity search. Recall is keyword and tag matching over every lesson in the scope.
- Lessons in the brief. `brief` shows decisions and warnings, never facts, so lessons
  reach a phase only through `recall`.
