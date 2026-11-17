---
phase: 64-embedding-fabric
milestone: v1.7
requirements: [EMB-01, EMB-02, EMB-03, EMB-04]
status: implemented and merged to main (PR #179, squash 87903465; PR #183, squash ba7cc010); TEI never contacted live, every test uses a fake
---

# 64-SUMMARY: Embedding fabric

No gsd-plan-phase run: the phase was built in one orchestrated wave of edit-only units. Decisions are in [64-CONTEXT.md](64-CONTEXT.md).

## What was built

**PR #179 (87903465): the TEI client, the cache, the fabric row.**

- `packages/mcp-server/src/planes/tei.ts`, `createTeiClient(config, deps)`: `embed`, `info`, `health`, `probe` and `snapshot`. Every call settles to `{ ok: true, ... }` or `{ ok: false, reason }` with a closed reason (`TEI_REASONS`: not-configured, breaker-open, timeout, unavailable, bad-response, model-mismatch, dim-mismatch, input-refused). `POST /embed` is sent in batches of `min(SUBSTRATE_TEI_BATCH, /info max_client_batch_size)`, retried on 429, 5xx and transport errors (4 attempts, 250 ms doubling to a 4 s cap, equal jitter, `Retry-After` honoured), 413 and 422 are permanent `input-refused`, a timeout is not retried. Text over 32 KiB is cut at a character boundary, a call takes at most 4096 texts, every float must be finite as a Float32.
- `packages/mcp-server/src/embed.ts`, `createEmbeddingService`: the one door the rest of the server embeds through. With `SUBSTRATE_EMBED_CACHE=on` it reads all keys in one `MGET`, embeds only the misses in one batch, writes them with the TTL. A dead, throwing or corrupt cache is a miss, never a failure. `embeddingDigest` is `sha256(model + "\n" + text)`.
- `packages/mcp-server/src/cache.ts`: new class `emb` in `CACHE_TTL` and `CACHE_CLASSES` (604800 s), entry shape `{ dim, b64 }` validated on read and write, `peekMany` and `putEntry`; a write with a TTL under one second writes nothing. No new redis command.
- Fabric: `tei` is the eighth resource in `packages/mcp-server/src/fabric/types.ts` (between `hindsight` and `tailscale-proxy`), with `teiRow` in `status.ts`, `gather.ts` and `fixtures.ts` updated, and the `tei-endpoint-private` check in `compliance.ts`. `packages/observability/src/breaker.ts` gained `AUX_PLANES = ["tei"]`: a plane with a gate and breaker that is not one of the six `/healthz` planes.
- Config and flags: `teiFromEnv` and the cache settings in `packages/mcp-server/src/config.ts`; `TEI_URL`, `TEI_API_KEY`, `SUBSTRATE_TEI_MODEL`, `SUBSTRATE_TEI_DIM`, `SUBSTRATE_TEI_TIMEOUT_MS`, `SUBSTRATE_TEI_BATCH`, `SUBSTRATE_EMBED_CACHE`, `SUBSTRATE_EMBED_CACHE_TTL_S` in `packages/mcp-server/src/flag-registry.ts`; `TEI_URL` is classed by `classifyEndpoint` in `db-endpoints.ts`, and `enforce` policy refuses a direct one at boot.
- Locks in `packages/mcp-server/src/store-lock.test.ts`: no package outside `mcp-server` imports the client, no committed file carries a TEI endpoint or key, and no file outside an allow-list reads `TEI_URL`, `TEI_API_KEY` or builds an `/embed` request.
- `docs/embedding-fabric.md`, plus `docs/data-planes.md`, `docs/observability.md`, the data-planes dashboard (`infra/vps/dashboards/substrate-data-planes.json`) and `.env.example`.

**PR #183 (ba7cc010): near-duplicates.**

- `packages/corpus/src/similarity.ts`: `nearDuplicates` (pairwise cosine, threshold inclusive, capped, deterministic order) already existed from phase 63 (a1d6e8f7). This PR added `nearDuplicatesYielding`, which releases the event loop between blocks of work and honours an `AbortSignal`.
- `packages/corpus/src/protocol.ts`: the request and reply types, `DEFAULT_NEARDUP_THRESHOLD` 0.92, `DEFAULT_NEARDUP_PAIRS` 200.
- `packages/mcp-server/src/corpus/neardup.ts` `corpusNeardupReply`, `validate.ts` `parseNeardupRequest`, route `POST /corpus/neardup` in `server.ts` (audited as a `corpus_status` read, fail-open, admission class `read`): embeds up to 1000 excerpts of at most 4000 characters through `EmbeddingService`, returns the pairs with model, dimension, `compared`, `truncated` and `skipped`. A service failure is `503 corpus.embeddings-unavailable` with the closed reason.
- `packages/cli/src/corpus/neardup.ts`, `index.ts`, `render.ts`, `client.ts`: `substrate corpus plan --neardup [--threshold 0.5-1] [--neardup-max N]` reads a bounded prefix (16000 bytes, 4000 characters) of each local document the plan would write, sends one request, prints the pairs after the plan, and adds one `neardup` key to `--json`.
- `docs/corpus.md` (section "Near-duplicates (advisory)") and `docs/runbooks/corpus-ingest.md`.

## Key decisions

- **D64-1, D64-3, D64-5 held.** The client is new; the cache is cache-only with a TTL on every key and no new command; the near-duplicate signal is reported, never acted on.
- **D64-4 held, with one name.** TEI is the eighth resource, named `tei` in the report. The PR #179 commit text calls it `embeddings`; the code and docs say `tei`.
- **D64-2 refined.** Pinning is optional: with a pin unset, the first model `/info` names (or the first vector length) is learned and held. A pinned model that `/info` does not name is refused. During review this grew into a sticky refusal: once `/info` names another model, every call answers `model-mismatch` until a later `/info` names the expected one, and a failed `/info` read does not lift it.
- **One door to the client.** `EmbeddingService` is the only consumer of the client; the near-duplicate route takes a `Pick<EmbeddingService, "embed">`.
- **Fail-closed egress.** Excerpts go only to the TEI endpoint, which the compliance check requires to be loopback or an allowed proxy. No text, excerpt or URL is placed in a reply, audit record or log.

## Deviations from the plan

- ROADMAP criterion 1 and the tests call the fake "a fake TEI server". It is an injected `fetch` that records each request, not a listening server.
- ROADMAP criterion 1 says a model or dimension other than `SUBSTRATE_TEI_MODEL` and `SUBSTRATE_TEI_DIM` is refused. That holds when the flags are set; unset, the client learns them. A timeout is answered at once and not retried (the docs give the reason: a wedged server would only cost another timeout).
- ROADMAP criterion 2 says keyed "by model and sha256". The key is one digest of the model, a newline and the text, not the model next to a text hash.
- ROADMAP criterion 3 lists the breaker among the row's contents. The row has `state`, `endpointClass` and a `detail` of model, model source, dimension and latency; the breaker only sets `state` (open is `unavailable`, half-open is `degraded`). The compliance check is `tei-endpoint-private`; unset is `NOT_APPLICABLE`, never a pass.
- ROADMAP criterion 4 says `nearDuplicates` "returns pairs above a threshold": a pair at the threshold is included. The route clamps a threshold of 1 to 0.999999 so identical vectors still match. `--neardup` also exits 1 when the comparison fails, after printing the plan.
- The ROADMAP header says Phase 63 supplies a "planner hook". There is none: near-duplicates are a separate route and a CLI flag. The plan, its coverage and every ingest are identical with or without `--neardup`.
- PR #179 text says "SUBSTRATE_TEI_URL"; the variable is `TEI_URL`.

## Findings

Review findings on PR #179 (seven fix rounds, from the commit messages), nearly all in the model check:

- A failed `/info` recheck turned a model refusal into success; the refusal is now remembered until `/info` names the expected model.
- The input limit was checked after the cache and de-duplication shortened the list; it now counts the original input. A vector is checked for finite values after the Float32 narrowing on the fresh and the cached path.
- Concurrent calls shared one in-flight check regardless of their timeout; sharing is now limited to equal timeouts, checks are numbered in start order, and a check that started before a refusal cannot lift it when it replies late. A fresh verdict is preferred to an older check still in flight.
- The readiness probe now records a model switch it sees, and an embed that outlives a refusal discards what it fetched, so nothing is cached under the wrong model. A matching probe lifts a refusal but does not freshen the verdict, so a client that never verified still reads the server's batch limit.

PR #183 (an initial commit and two fix commits):

- Round 1 (commit subject only): a bounded prefix read instead of the whole file, a comparison that yields to other requests, and the egress wording.
- Round 2: the excerpt is read after the scan, so a document swapped for a symlink would have sent its target's text. The reader opens without following a link and without blocking on a pipe, requires a regular file, and requires the size the scan recorded.

Residuals are listed in [64-VERIFICATION.md](64-VERIFICATION.md).

## What remains

- Operator: make a TEI forwarder reachable from the host, set `TEI_URL` (and `TEI_API_KEY`), copy the model and dimension the fabric row shows into the two pin flags, then enable `SUBSTRATE_EMBED_CACHE`. The URL, model, dimension and batch limit are not recorded in the repository (D64 open facts).
- No run against a real TEI has happened; the vector dimension, latency and cache hit rate on real documents are unknown.
- Nothing consumes near-duplicates but the printed plan section; acting on them (for example in ingest) is not built and was ruled out by D64-5.
