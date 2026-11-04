# Docs Reflect — what the docs RAG learns from being used

Tracked as REFLECT-01 to REFLECT-05 (v1.7 phase 66). The corpus (`docs/corpus.md`) answers `docs_search`. Reflect closes
the loop: it remembers what was retrieved, learns what helped, prefers the current document to the one it replaced,
writes a digest of where each repository's planning stands, and reports the questions the corpus could not answer.

Everything here is deterministic. No model scores a document, no randomness breaks a tie, and no flag turns on a model
call. The scoring and supersession code is pure (`packages/corpus/src/authority.ts`, `supersession.ts`, `reflect.ts`),
so the same inputs always give the same answer and each rule can be tested without a server.

Everything is behind a flag that defaults off or conservative (see Flags). With every flag unset, `docs_search` answers
exactly as before.

## What is recorded

| Record | Written by | Holds | Kept |
| --- | --- | --- | --- |
| Retrieval row (`corpus_retrievals`) | `docs_search`, when `SUBSTRATE_DOCS_TELEMETRY=on` | a hash of the query, a capped and redacted copy of its text (none when the redactor found a secret in it), the backend, the keys and scores of the returned documents, the best score, whether the plane answered, and in shadow mode the re-rank note | `SUBSTRATE_DOCS_TELEMETRY_RETENTION_DAYS` days |
| Feedback verdict (`corpus_feedback`) | `docs_feedback` (MCP tool and REST route) | one verdict per session and document: `helpful`, `unhelpful`, `stale`, `wrong` or `duplicate`; a later verdict of the same session for the same document replaces the earlier one | not swept by the retrieval retention |
| Supersession | scan and manifest | the `superseded_by` column of `corpus_documents` and a computed map (see below) | with the manifest row |
| Digest | `substrate corpus reflect` | one document per repository at the virtual path `.substrate/digest.md` (kind `digest`, tier 1) | replaced when its sha256 changes |

A retrieval row never holds the text of a document, and a verdict is idempotent: the same session giving the same
verdict for the same document twice changes nothing. A steering-session `docs_search` row keeps no query text, only the hash of its question, because the question may carry private steering.

## Authority: one number per document

`scoreDocument` (`packages/corpus/src/authority.ts`) turns a document's tier, kind, age, supersession and feedback into a
number from 0 to 1.

```
score = ( W_tier * tier + W_kind * kind + W_recency * recency + W_feedback * feedback ) * ( superseded ? 0.4 : 1 )
```

Every term is in 0 to 1 and the four weights sum to 1, so the score needs no clamping. The constants are fixed numbers in
`AUTHORITY_WEIGHTS`; nothing tunes them at run time.

| Constant | Value | Why |
| --- | --- | --- |
| `tier` (weight) | 0.35 | the tier is the owner's own statement of authority (`docs/corpus.md`, "Kinds and tiers"), so it weighs the most |
| `kind` (weight) | 0.20 | the kind says how often a document states what is true now; a smaller signal than the tier |
| `recency` (weight) | 0.15 | breaks ties between documents of one tier; documents age slowly |
| `feedback` (weight) | 0.30 | evidence from use is the point of reflecting, so it is the second largest term |
| `supersededFactor` | 0.4 | a superseded document stays findable but always scores below the document that replaced it |
| `recencyHalfLifeDays` | 365 | the recency term halves every year: `0.5 ^ (ageDays / 365)` |
| `unknownRecency` | 0.5 | a document whose age is unknown is neither fresh nor stale |
| `feedbackPrior` | 2 | pseudo-counts on both sides of the feedback ratio, so one vote cannot move a document from neutral to an extreme |

The tier term is 1 for tier 1, 0.6 for tier 2 and 0.3 for tier 3.

The feedback term is `(helpful + 2) / (helpful + cost * negatives + 4)`. It is 0.5 for a document with no feedback, rises
with every `helpful` and falls with every negative report. The negatives are weighted by what they say about the
document: `unhelpful` 1, `duplicate` 1, `stale` 1.5, `wrong` 2.

The kind term:

| Kind | Score | Kind | Score |
| --- | --- | --- | --- |
| `planning-state` | 1.0 | `planning-context`, `planning-summary`, `planning-verification` | 0.6 |
| `planning-roadmap`, `agents`, `adr`, `runbook`, `digest` | 0.9 | `planning-research`, `planning-milestones`, `planning-audit`, `changelog`, `greptile-kb` | 0.5 |
| `planning-requirements`, `planning-project`, `doc`, `skill` | 0.8 | `planning-plan`, `planning-other`, `other` | 0.3 |
| `readme` | 0.7 | `planning-archive` | 0.1 |

The guarantees, each pinned by a test over a grid of inputs: the score is always above 0 and at most 1; more `helpful`
never lowers it; more `unhelpful`, `stale`, `wrong` or `duplicate` never raises it; a superseded document scores strictly
below the same document not superseded; an older document never scores above a newer one; tier 1 beats tier 2 beats
tier 3; and a document with no feedback and no supersession is scored by tier, kind and age alone. A count that is
negative or not a number counts as zero and an invalid age counts as unknown, so a bad row cannot push a score out of range.

## Supersession: which document replaced which

`detectSupersession` (`packages/corpus/src/supersession.ts`) takes the active manifest rows and answers a map from the key
(`repo:path`) of each superseded document to the key of the document that supersedes it. Exactly three rules apply, in this
order, and the first rule that flags a document wins:

1. **An explicit marker.** A tier 1 or 2 document names its replacement in its front matter, and the target must be an
   active row of the same repository; otherwise the marker is ignored.

   ```
   ---
   superseded-by: docs/new-guide.md
   ---
   ```

   The value is a repository-relative path (a leading `./` is allowed, quotes are allowed). The front matter must open the
   document and close with a second `---` line, within the first 100 lines. A URL, an absolute path, a `..` segment or an
   empty value is no marker. The scanner reads the marker from the body it already read (filesystem, GitHub and Greptile
   sources) and sets `supersededBy` on the entry; the server keeps it only when it is a valid path, and an invalid marker is
   dropped, never a refusal.
2. **A live document and its milestone archive.** `.planning/milestones/<dir>/<rest>` is superseded by the live
   `.planning/<rest>` of the same repository when that row exists. The flat archive form `.planning/milestones/v1.6-ROADMAP.md`
   is superseded by the live `.planning/ROADMAP.md`. A `.planning` directory below the repository root works the same way.
   A phase document (`.planning/phases/<phase>/<file>`) is never an archive.
3. **The same path in two copy collections.** When exactly two `local/*` collections of one source hold the same relative
   path (tier 1 or 2) with different content, the copy with the older update time is superseded by the newer one. Groups of
   three or more, equal times and unparseable times are left alone.

A chain resolves to its final document (`v1 -> v2 -> v3` flags `v1` and `v2` against `v3`). A loop of markers has no current
end, so none of its members is flagged. Nothing is ever flagged across repositories or sources: a wrong "superseded" label
would hide a current document, while a missing one only costs a little ranking.

`substrate corpus plan` marks each document that carries a marker with `[superseded by <path>]`, prints how many there are,
and its `--json` output carries a `superseded` list next to the server's plan.

## Digests: where each repository's planning stands

`substrate corpus reflect` builds one digest per repository from the working-tree text of `.planning/STATE.md`,
`.planning/ROADMAP.md` and, when present, `.planning/PROJECT.md` (`buildDigest`, `packages/corpus/src/reflect.ts`). It is
extracted, not written: no model, no network and no clock.

A digest is one markdown document with a fixed shape:

```
# Documentation digest: <repo>

## Current position          the milestone and phase (STATE frontmatter), its state, the Phase and Status lines
## Recent decisions (newest first)   the last 10 bullets of the sections whose heading says "Decisions"
## Open items (unchecked in the live roadmap)   up to 20 `- [ ]` items outside <details> blocks, in roadmap order
## Project                   the first heading and first paragraph of PROJECT.md
```

A section with nothing to say reads `- none found`. Every line is cut to a fixed length, so a digest is far below the
20,000 characters the server accepts. STATE lists decisions as they were made, so the newest are its last bullets.

The text carries no timestamp (the `last_updated` of STATE is not copied), so a digest is byte-identical while its sources
are, and the server stores nothing for a run that changed nothing (`unchanged`). Its key is `corpus-digest:<repo>` and its
sha256 covers exactly the text that is sent.

A repository is digested only when it has a readable `.planning/STATE.md`. A planning file that exists but cannot be read
(empty, too large, binary, a symlink) leaves its repository out of the run with a closed reason such as `roadmap-empty`,
so a digest is never built from half of its sources and stored over a complete one. A label that two directories yield
(`duplicate-label`) is not digested.

On the server each digest goes into the docs plane as a document of kind `digest` and is retained in Hindsight as a
governed `fact` entry at repository scope with its deterministic key, replacing the earlier one. Only accepted entries
reach Hindsight (`docs/memory-governance.md`).

## Gaps: the questions the corpus could not answer

`substrate corpus status --gaps` lists the queries whose best citation scored below `SUBSTRATE_DOCS_GAP_SCORE` over the
last 30 days (a query that returned nothing counts as best 0), aggregated by query hash and ordered by how often it was
asked. A search the docs plane could not answer is left out: it says nothing about what the corpus holds. The list is the
corpus telling the owner which documents are missing.

Each row has the hash, the number of searches, the best score any of them reached, when it was last asked and the redacted,
capped text of the query when the server kept it (none when the redactor found a secret in it). The CLI escapes every control
character in text that came from the server before it prints it. `--limit N` caps the list; a value above the server limit
of 200 is lowered with a message.

Gaps need `SUBSTRATE_DOCS_TELEMETRY=on`: without retrieval rows the list is empty.

## The CLI

```
substrate corpus reflect [--repo R]... [--root DIR]... [--max-bytes N] [--server URL] [--execute] [--json]
substrate corpus status --gaps [--limit N] [--server URL] [--json]
```

`reflect` is a dry run until `--execute`: it prints the digests it would send (the text of the first five, all of them with
`--json`), the repositories it could not digest and why, and sends nothing. With `--execute` it sends them to
`POST /corpus/reflect` in requests of at most 200 digests. `--repo` limits the run to the named repositories and reports one
that is not found. Roots come from `--root`, else `SUBSTRATE_CORPUS_ROOTS`, else the default root of `substrate corpus scan`.

Exit codes: 0 when every digest was stored or unchanged (a dry run: when every repository could be digested), 1 when the
server refused the request, any digest was refused or failed, a digest got no answer, or any repository that has a STATE
could not be digested (also in a dry run), 2 for a usage error.

The server never reads a path: it receives the digest text and its sha256.

## Flags

| Flag | Values | Unset or invalid |
| --- | --- | --- |
| `SUBSTRATE_CORPUS` | `on` | off: every `/corpus/*` route answers `corpus.disabled` (503) |
| `SUBSTRATE_DOCS_TELEMETRY` | `on` | off: `docs_search` writes no retrieval row and no retention sweep runs |
| `SUBSTRATE_DOCS_TELEMETRY_RETENTION_DAYS` | integer 1 to 365 | 30 days; a value outside the range is clamped |
| `SUBSTRATE_DOCS_RERANK` | `off`, `shadow`, `on` | `off`: citations are returned in the order the plane gave them |
| `SUBSTRATE_DOCS_GAP_SCORE` | a number from 0 to 1 | 0.2 |

`docs/config-reference.md` lists every flag with the code that reads it.

`SUBSTRATE_DOCS_RERANK=on` multiplies the score of each corpus citation by `0.5 + 0.5 * authority`, so authority moves a
citation by at most half of its score: the plane's relevance still decides, and authority breaks near ties and demotes the
doubtful. Only a citation of a document the manifest holds as an active row is touched; every other citation keeps its place.
While the re-rank is `on`, each corpus citation it knows also carries `stale` and `superseded_by` (the key of the document that
replaces it, or null); in `off` and `shadow` the answer carries neither. A document is `stale` when a document supersedes it,
or when at least three readers called it stale and more did so than called it helpful.

## Reading a shadow report

`SUBSTRATE_DOCS_RERANK=shadow` leaves the answer exactly as the plane gave it and records, in the retrieval row of each
search, the order `on` would have answered and how many positions would change. It needs `SUBSTRATE_DOCS_TELEMETRY=on` to be
recorded at all. To decide whether to turn the re-rank on:

1. Count the searches whose `moved` is 0. Most of them should be: authority only breaks near ties.
2. Read the searches with a large `moved`. The documents that rose should be current tier 1 documents or ones readers
   called helpful; the documents that fell should be superseded, archived or called stale or wrong. If a document you
   trust fell, look at its feedback counts and its supersession before trusting the weights.
3. Check that no document with no feedback and no supersession moved by more than its tier, kind and age explain.
4. Turn `on` only when the moves read as improvements, and go back to `shadow` or `off` the moment they do not: both are a
   flag change with no data to undo.
