# Phase 26 validation map

Rehearsal evidence for every provable behavior, plus the untouched G1–G4
inventory. No live system was touched: every live step below is UNRUN and
waits for operator approval per `docs/runbooks/hindsight-cache-proof.md`.

## Rehearsal evidence (all green, no live touch)

| Gate | Proven | Evidence |
|---|---|---|
| Recall client | Bearer on every authed call, absent on `/health` + `/version`; bank in path; chunks ensure (one GET when already chunks, 404-PUT-PATCH otherwise); both recall shapes; timeout-as-Result; array-detail never shown | `planes/hindsight.test.ts` (21 tests) |
| Recall tool | Bounded fan-out (caller's bank first), shared-budget slow-bank degradation to partial, source attribution, derived framing, redacted hits, empty-plus-reason on outage, unlisted-surface refusal | `memory-recall.test.ts` (16 tests incl. brief-import gate, registration pins, merge shape) |
| Retain forward | Accepted+sourced+clean forwards once per idempotency key; unaccepted silent; unsourced/unredacted/guest refused with locator warnings; plane failure warns; unconfigured silent | `memory-retain.test.ts` (8 tests) |
| Search merge | Index first and unmarked, attribution survives, outage degrades to index-only | merge tests in `memory-recall.test.ts` |
| Cache recall | Second identical recall is a hit; Dragonfly-down recall matches uncached | `cache.test.ts` |
| Claims pin | Claim newer than 60 s visible in a brief right after a cache hit, via the accept-bump mechanism (verified, not rebuilt) | `cache.test.ts` |
| Redis refusal | Loopback and `rediss://` allowed; plaintext non-loopback refused fail-open with off-with-reason health and uncached answers | `config.test.ts`, `cache.test.ts` |
| Vocabulary | `event-sources.test.ts` green unchanged; `policy.test.ts` pins `memory_recall` fail-open | existing suites |
| Types | `bunx tsc --noEmit` clean | — |

## Gated live inventory (all UNRUN)

| Gate | Step | Proof read | Rollback |
|---|---|---|---|
| G1 | Live `GET /health` + `GET /version`; record version vs `hindsight-0.9.1-openapi.json` | Version body + comparison record | None (read-only) |
| G2 | Live bank ensure + first recall on a `sub-<surface>` bank | Chunks config read-back + recall reply | `DELETE` the bank only if probe-created and otherwise empty |
| G3 | First live retain of a gate-accepted memory | Document GET by `document_id`, faithful content, no `memory.retain.failed` | `DELETE` the document by `document_id` |
| G4 | Cache/topology change + DOCS-07 headless proof (cited docs URL, cross-surface recall with source, second-brief hit, Dragonfly-down uncached brief) | Session event, recall reply, `/healthz` counters, brief equality | Previous `DRAGONFLY_URL` + `SUBSTRATE_CACHE=0` bypass |

Executor performed no live touch: no probe, no bank, no retain, no topology change ran.
