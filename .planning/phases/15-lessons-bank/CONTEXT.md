# Phase 15: Lessons bank - Context

**Gathered:** 2026-10-07
**Status:** Executing
**Mode:** Auto-accepted. Storage was decided by the user on 2026-10-07 (the Decision sections of `docs/research/self-improving-memory-bank-proposal.md` and `docs/research/memory-bank-realtime-event-proposal.md`); everything else below is Claude's discretion within it.

<domain>
## Phase Boundary

Tier 1 of the self-improving lessons bank (SPE-5830): LES-01..05 and PROOF-04. A lesson from a finished phase is written as one governed `fact` through the existing `POST /memory` gate, recalled at GSD discuss time into CONTEXT.md, cited by entry id in PLAN.md, scored on read from appended outcome facts, and rolled up into a milestone digest fact. The commands are in `packages/cli` (`substrate lessons add|recall|digest|outcome`). The one server change is on the read side (revised after review, below): `memory_search` gains a literal `subject_prefix` filter and a keyset cursor. No table, no memory kind, no event kind, no write path, no change to `memory-write.ts`, no new `insertEntry` caller; memory-table SQL stays in `index-store.ts`, and `store-lock.test.ts` still holds.

Out: phase lifecycle events, outbox/SSE, Dragonfly, `phase_lifecycles` (Tier 2); automatic writes; vector search; lessons in the brief.

</domain>

<decisions>
## Implementation Decisions

### Fixed by the 2026-10-07 Decision
- Each lesson is one `fact` through the gate. `subject = lesson:<milestone>/<phase>/<slug>`; idempotency key from source path and content; structured header (milestone, phase, outcome, tags, source) then the lesson, body at most 4000 characters.
- Scope `repo:<owner/name>` by default (`repo-working` grant). `global` is require-review, so a global lesson is a proposal.
- Cite only `entry.id` from a reply with `outcome === "accepted" && verified_persisted === true`.
- Retrieval through `memory_search`, ranked client-side. Scores computed on read from outcome facts naming the lesson id; never mutated in place. Digest is a `fact` with `subject = lesson-digest:<milestone>`.

### Revised after review (2026-10-07): recall reads every lesson
The first cut read through `memory_search` as it stood: the newest 100 bodies per call, so recall merged a marker search with one marker+term search per query term. Review rejected that: in a busy repo an older lesson that does not share the query's words is lost behind the newest-100 window, and so are scores and digests once their family passes 100. Recall must consider every lesson in scope, so Tier 1 takes a read-side server change after all.
- **`memory_search` gains `subject_prefix`.** Normalised by `normalizeSubject` (trimmed, lowercased), matched with `left(subject, char_length(prefix)) = prefix`, so `%`, `_` and `\` are literal. `query` becomes optional when `subject_prefix` is given, so a family can be listed whole.
- **A keyset cursor, the explicit pair.** Order `created desc, id desc`; the request takes `before` (ISO-8601 `created`) and `before_id`, and returns rows strictly before `(before, before_id)` in that order, so ties at a page boundary are neither skipped nor repeated (`now()` stamps a whole transaction alike). `before` alone is strictly before the instant. Not an opaque cursor: the pair is what the order is, and a caller can read it.
- **The reply.** With any of `subject_prefix`, `before`, `before_id`: a page `{ entries, next }`, `next = { before, before_id }` of the last entry whenever the page is full, else null. `next.before` is rendered by Postgres to the microsecond; an entry's `created` is a JS `Date` cut to the millisecond and would skip entries if used as the cursor. Without them the reply is the bare list it always was; the only change is the `id` tie-break.
- **Visibility and RBAC unchanged.** Same `memory_entries` rows, superseded excluded unless `include_superseded`; quarantined and unreviewed writes are in other tables and never reachable. Reads stay unscoped by RBAC, as before.
- **The CLI pages three prefixes.** `recall` lists `lesson:` (candidates), `lesson-digest:` (ids to exclude) and `lesson-outcome:` (scores), 100 a page, until `next` is null, capped at 50 pages per family with a stderr line if hit. `digest` and the `outcome` id check page `lesson:` and `lesson-digest:`; `outcome`'s scores page `lesson-outcome:<id>`. The marker+term searches are dropped from the main path.
- **Fail-open on an older server.** One whose schema still requires `query` rejects the paged call with the SDK's "Invalid arguments for tool memory_search"; one that dropped the unknown arguments would answer a bare list. Either way the CLI falls back to the marker searches, prints one stderr line, and carries on. A 401 or an audit refusal is not taken for an older server.
- Tests: `index-store.search.test.ts` (live Postgres: literal prefix with LIKE metacharacters, the cursor through 257 entries in ties of seven and four timestamps per millisecond at page sizes 100/33/7, the no-parameter search identical to the old statement), `mcp.test.ts` (reply shapes, normalisation, refusals), `lessons.test.ts` (130 lessons under 150 newer facts, the oldest recalled, 105 prior outcomes scored, the fallback, the page cap).

### Claude's Discretion

**Transport.**
- Writes: `POST {SUBSTRATE_URL}/memory` with the body `{scope, kind: "fact", subject, text, idempotency_key}`. The writer is the bearer token's surface, as for every memory write.
- Search: REST has no search route, and adding one is not needed. The CLI POSTs one JSON-RPC `tools/call` for `memory_search` to `{SUBSTRATE_URL}/mcp` with `Accept: application/json, text/event-stream` and the bearer token. The server is stateless, so no handshake is needed, and the reply is plain JSON or one SSE `data:` line (`docs/swarm-correlation.md`). A reply without `result` is a refusal: a JSON-RPC audit error, or a plain `{error}` such as a 401.
- Reuses the CLI's conventions: `SUBSTRATE_URL` (default `http://127.0.0.1:7410`), `SUBSTRATE_TOKEN`, `SUBSTRATE_TIMEOUT_MS`. The timeout default for `lessons` is 10 s rather than 1.5 s: nothing waits on these commands, and a write cut off mid-flight has an unknown outcome.
- `parseArgs` / `str` / `list` move from `index.ts` into `args.ts` because `index.ts` dispatches at import time and `lessons.ts` needs them. The command logic sits in `lessons.ts` behind a `MemoryApi` seam (`write`, `search`, `page`) so tests drive it against a fake HTTP server.

**CLI shape.**
- `add --text T --phase P [--milestone M] [--slug S] [--tags a,b] [--outcome O] [--source PATH]`
- `add --from SUMMARY.md [--key-decisions] [--milestone M] [--phase P] [--tags a,b] [--skip slug,…]`
- `recall [QUERY] [--limit N] [--half-life DAYS]`; the query may also be `--query`.
- `digest <milestone> [--ids a,b [--unchecked]] [--text T]`
- `outcome <lesson id> --result success|partial|failure --phase P [--milestone M] [--note T] [--unchecked]`
- Every command takes `--scope S | --repo owner/name` and `--json`; `add`, `digest` and `outcome` take `--dry-run`, which is the human review step the proposal requires before a write.
- Output: one line per write, `<status> <id or -> <subject>`, followed by the gate's reason and remedy when the write did not count. Statuses: `recorded`, `duplicate`, `unverified`, `quarantined`, `denied`, `review`, `conflict`, `refused`, `unreachable`, `too-long`, `skipped`. Only `recorded` and `duplicate` print an entry id.
- Exit status: writes exit 0 only when every lesson is `recorded`/`duplicate` (or skipped), 1 otherwise, 2 on a usage error. `recall` always exits 0: it fails open, as the proposal says, with the reason on stderr and nothing on stdout.

**Defaults.**
- Scope: `--scope`, else `repo:` + `--repo`, else `repo:` + the `origin` remote slug, derived by the same `repoSlug()` that `brief`, `emit` and `drift` use.
- Milestone: `--milestone`, else the archive directory (`.planning/milestones/<m>-phases/…`), else the SUMMARY frontmatter `milestone:`, else `.planning/STATE.md` frontmatter `milestone:`.
- Phase: `--phase`, else SUMMARY frontmatter `phase:`, else the SUMMARY's directory. `--text` requires `--phase`.
- Milestone, phase, slug and tags are lowercased to `[a-z0-9._-]`, because the server lowercases subjects and the subject computed here must be the one stored.

**Body header.** Line 1 is a search marker, then `key: value` lines, a blank line, and the whitespace-collapsed lesson:
```
[lessonbank]
milestone: v1.1
phase: 08-memory-structures
outcome: success
tags: memory, governance
source: .planning/milestones/v1.1-phases/08-memory-structures/08-01-SUMMARY.md

<lesson>
```
- `outcome` is how the teaching phase went: `success` (default) | `partial` | `blocked` | `deferred`.
- The marker says the lines below it are a header. It was first also the search narrowing, because `memory_search` matched bodies only, newest 100 per call; since the revision above it is that only on the fallback to an older server. Digests and outcomes get their own words (`[lessonbankdigest]`, `[lessonbankoutcome]`) so on that fallback outcomes, which will outnumber lessons, cannot crowd lessons out of their own search. Single invented words are used because the english text-search parser keeps them as one lexeme. The subject, not the marker, decides what an entry is.
- A `lesson:` fact without the header (a swarm retro written to the same convention) still reads as a lesson; its subject supplies milestone and phase.

**Subject and slug.** `lesson:<milestone>/<phase>/<slug>`; the slug is a bullet's bold lead or the first six words that are not stopwords, at most 60 characters, cut further so the subject stays within the server's 200-character `normalizeSubject` cap. Duplicate slugs in one run get `-2`, `-3`.

**Idempotency key.** `lesson:` + sha256(`source` + `\n` + whitespace-collapsed text). `source` is the SUMMARY path relative to the checkout top level (so the cwd does not change it), or `inline:<milestone>/<phase>` for `--text` (so the same sentence added to two phases is two lessons, not an `idempotency.reused` conflict). The body sends the collapsed text too, so a re-wrapped lesson is the same request and replays.

**SUMMARY lessons section.** Top-level bullets under `## Lessons` (also `## Lesson`, `## Lessons learned`, `##` or `###`) up to the next heading of that level or higher. Indented lines and nested bullets continue a bullet; an unindented paragraph ends it. `[tags: a, b]` and `[outcome: x]` are lifted into the header; a `**bold lead**` names the slug; every lesson inherits the SUMMARY's frontmatter `tags:`. No archived v1.1 SUMMARY has this section; they record lessons-like content as frontmatter `key-decisions:`, which `--key-decisions` reads. That is how PROOF-04 draws a lesson from the v1.1 archive without editing it.

**Declarative wording.** The gate quarantines a hedged `fact` (`memory-classify.ts` `SPECULATIVE`): probably, perhaps, maybe, might, I think, I believe, not sure, unsure, unverified, untested, assume/assumes/assumed/assuming/assumption, should work, seem(s) to, appear(s) to, plan(s)/planning to, intend(s)/intending to, likely, TBD, to be decided, guess/guessing, hypothesis, hypothetical, speculat…, proposed plan, draft plan, if this works. Plus secrets and PII. A quarantined lesson is reported with its quarantine id and never retried. The CLI does not pre-screen: the gate is the one classifier, and a copy here would drift from it. The header itself contains none of these words.

**Accepted and verified only.** A reply counts only with `outcome === "accepted" && verified_persisted === true` and an entry id. `accepted` without `verified_persisted` is re-sent once under the same key (the replay re-verifies and cannot duplicate) and then reported `unverified` with no id. Quarantined, denied, review and conflict replies are reported with the gate's reason and remedy and never retried. Transport failure stops the run (later lessons are marked not sent) and says the write may have landed and that re-running is safe under the same keys.

**Ranking.** `rank = match × 0.5^(age / half-life) × (0.5 + score)`.
- match: share of query terms found, 1 per term in a tag, ½ per term only in subject or text, crude plural fold; zero-match entries are dropped, not ranked last.
- half-life 90 days (`--half-life`); limit 5, max 20 (`--limit`).
- Candidates: every `lesson:` entry in scope, paged (see the revision above). On an older server, the fallback: one marker search (newest 100 lessons) plus one marker+term search per query term (at most 6), merged by id; digests and outcomes the newest 100 of each.

**Digest.** `digest <milestone>` writes one `fact`, subject `lesson-digest:<milestone>`, body `[lessonbankdigest]`, `milestone:`, `lessons: <id, id, …>`, a blank line, a first line (`--text` or "Milestone M rolls up N lessons."), then one line per lesson with id, subject and a 200-character excerpt. Default set: every lesson whose subject is under `lesson:<milestone>/`; `--ids` names the set instead (for example the ids that milestone's plans cited), refusing ids not in the bank unless `--unchecked`. When the body would pass 4000 characters the excerpts go, then the per-lesson lines; a digest whose id list alone does not fit is refused. Key: `lesson-digest:` + sha256(milestone, sorted ids, text). Nothing is deleted (there is no delete path). Recall excludes every id listed by any digest and ranks only the newest digest per milestone in their place, so the knowledge stays recallable through one citable id.

**Outcomes and score.** `outcome <lesson id> --result success|partial|failure --phase P` writes one `fact`, subject `lesson-outcome:<lesson id>` (a `fact` at `repo:`, so the default `repo-working` grant), body `[lessonbankoutcome]`, `lesson:`, `result:`, `milestone:`, `phase:` (the citing use), then an optional note. Key: `lesson-outcome:` + sha256(lesson id, milestone/phase, result, note). The command refuses an id that is not a lesson or digest in the scope (an outcome is permanent) unless `--unchecked`, and prints the score before and after, re-read from the server. Score = (1 + Σw) / (2 + n), w = 1 / ½ / 0, counting only the newest report per citing milestone/phase, so a changed verdict replaces the old one instead of voting twice. Unreported lessons score 0.5. Nothing is stored or updated: every read recomputes it.

**Cite-by-id.** In PLAN.md, `[lesson <entry id>]` next to the task that follows from it. The id is the only stable handle: subjects are not unique (facts append), and a digest can stand in for the text.

</decisions>

<code_context>
## Existing Code Insights

- `packages/cli/src/index.ts` commands: brief, emit, run, verify, drift, handoff, evidence; `base()`, `headers()`, `timeout()` (1.5 s), `repoSlug()` from the origin remote; no tests existed for the CLI.
- `POST /memory` (`server.ts`) answers the gate's `MemoryWriteResult` with 200 / 202 (accepted, unverified) / 409 / 422 / 403 / 503. The writer is `memoryWriter(surface)`, the token's surface or `unknown`.
- `memory_search` (`mcp.ts`, `index-store.ts searchMemory`), before this phase: `plainto_tsquery('english', query)` over `body` only, exact scope, superseded excluded, newest first, limit 1..100, `query` required. This phase adds `subject_prefix`, `before`/`before_id` and `searchMemoryPage` (above). An explicit idempotency key replays the accepted entry forever with `deduplicated: true`; a different request under the same key is `conflict` / `idempotency.reused`.
- `fact` with a subject resolves `append` (`conflictPlan`), so lessons, digests and outcomes all append.
- `store-lock.test.ts` scans every `.ts` for memory-table SQL, `insertEntry`, and the Greptime env prefix; the new files contain none of them.

</code_context>

<specifics>
## Specific Ideas

PROOF-04 runs against a smoke substrate on port 7499 (smoke Postgres and GreptimeDB) with one surface token, in a per-run scope so a re-run proves something: the v1.1 `08-memory-structures` SUMMARY's key-decisions are added (one of them says "unverified" and is quarantined, which shows a hedged lesson reported and not retried), a second add returns the same ids as `duplicate`, recall cites them, an outcome moves a score from 0.50 to 0.67, and a digest makes recall cite the digest instead. Then the oldest lesson in a second scope is buried under more than 100 newer non-lesson facts and more than 100 newer lessons on other topics, and recall still cites it; a raw paged `memory_search` shows the cursor walking past the first 100. The smoke substrate must be built from this branch. Script: `/tmp/p15-lessons-proof.sh`.

</specifics>

<deferred>
## Deferred Ideas

- Feeding swarm `retro`/`pattern` facts into the bank by writing them under `lesson:` subjects (agent-swarm `swarm/memory.py`).
- Choosing where the discuss-time recall runs (GSD workflow step or a claude-ultrathink hook); `docs/lessons-bank.md` documents the manual recipe.
- Tier 2: lifecycle `note` events, outbox/SSE, Dragonfly.

</deferred>
