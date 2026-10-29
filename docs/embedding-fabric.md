# Embedding fabric (phase 64)

Substrate embeds text with the owner's TEI (Hugging Face text-embeddings-inference) service. This page covers the client, the cache and the fabric row. The rest of the server embeds through one door, `EmbeddingService` in `packages/mcp-server/src/embed.ts`, and never through the client directly. The data-plane view of the same service is in [data-planes](data-planes.md#embeddings-tei-phase-64).

TEI is private: the Railway service has no public address, so the host reaches it through a forwarder, the way it reaches the other Railway planes ([railway-tailscale](railway-tailscale.md)). The URL as seen from the host, the model the service runs, its vector dimension and its batch limit are **not recorded in this repository**; the operator supplies the URL and the client reads the rest from `GET /info`.

## Flags

| Variable | Default | Meaning |
|---|---|---|
| `TEI_URL` | unset | Base URL. Unset, the service is unconfigured: every call answers `not-configured` and nothing is sent. |
| `TEI_API_KEY` | unset | Sent as `Authorization: Bearer ...` when set. Never logged, never in a status row, never in a reason. |
| `SUBSTRATE_TEI_MODEL` | learned | The model `GET /info` must name. |
| `SUBSTRATE_TEI_DIM` | learned | The length every vector must have. |
| `SUBSTRATE_TEI_TIMEOUT_MS` | 10000 | Timeout of each request (100 to 120000). |
| `SUBSTRATE_TEI_BATCH` | 32 | Most texts per `/embed` request (1 to 512). The server's `max_client_batch_size` can only lower it. |
| `SUBSTRATE_EMBED_CACHE` | off | `on` caches vectors in Dragonfly. |
| `SUBSTRATE_EMBED_CACHE_TTL_S` | 604800 | Seconds a cached vector lives (60 to 2592000). |

The reference table, with the unset behaviour of each, is in [config-reference](config-reference.md).

## The client

`createTeiClient(config, deps)` in `packages/mcp-server/src/planes/tei.ts` has `embed(texts)`, `info()`, `health()` and `probe()`. Every call settles to a value and never rejects. `embed` answers `{ ok: true, vectors: Float32Array[], model, dim }` or `{ ok: false, reason }`.

| Reason | When |
|---|---|
| `not-configured` | `TEI_URL` is unset. Nothing is sent. |
| `breaker-open` | The `tei` plane's circuit breaker is open. No request is made. |
| `timeout` | A request outlived `SUBSTRATE_TEI_TIMEOUT_MS`. It is not retried: a wedged server would only cost another timeout. |
| `unavailable` | A transport error, 429 or 5xx that outlasted its retries, or a 401, 403 or 404. |
| `bad-response` | A 400, or a body that is not one non-empty vector of numbers that are finite as 32-bit floats per input (`1e100` is finite as a double and Infinity as a float, so it is refused). |
| `model-mismatch` | `GET /info` names a model other than the pinned one. |
| `dim-mismatch` | A vector's length differs from the pinned dimension, or vectors in one answer differ. |
| `input-refused` | 413 or 422 (a permanent refusal of that input), or more than 4096 texts in one call (counted before duplicates are removed). |

- **Batching.** The input is split to `min(SUBSTRATE_TEI_BATCH, max_client_batch_size)`; the limit is learned from `/info` once. Batches go one after another and the vectors come back in input order. If any batch fails the call fails; no partial answer is returned.
- **Retries.** 429, 5xx and transport errors are retried up to four attempts with exponential backoff (250 ms, doubling, capped at 4 s) and equal jitter; a `Retry-After` in seconds raises the wait to at most the cap. Each attempt goes through the breaker, so the breaker opens mid-call and the rest of the call answers `breaker-open`.
- **Model and dimension.** Vectors of two models are not comparable, so none are returned for the wrong one. `/info` is read on the first call and again every ten minutes; the length is checked on every answer. A pin left unset is learned from the first good answer and held for the life of the process. A failed recheck of a model that was verified keeps that verdict and asks again on the next call; a failed first check is the call's answer. A refusal is different: once `/info` has named a model other than the expected one, every call answers `model-mismatch` until a later `/info` names the expected model again, and a failed `/info` read in between does not lift it (it fails closed). Each call reads `/info` while a refusal stands. The `timeoutMs` override of a call applies to every request made for it, the `/info` of the model check included.
- **Long text.** A text over 32 768 UTF-16 units is cut there, never inside a surrogate pair. The request also sets `truncate: true`, so the server's own token limit applies.
- **Empty input** is an empty success with no request.

## The cache

`SUBSTRATE_EMBED_CACHE=on` puts `EmbeddingService` in front of the client. The key is `substrate:v1:emb:<sha256 of model + "\n" + text>` and the value is `{ dim, b64 }`, the Float32 bytes in base64. Every write carries `SUBSTRATE_EMBED_CACHE_TTL_S`. The input limit (4096 texts) is checked on the original count before any text is hashed, deduplicated or looked up, so a call answers `input-refused` the same way with the cache on or off. A call reads all its keys in one `MGET`, embeds only the misses in one batch (a text repeated within the call is embedded once) and writes them; it stops writing at the first refused write. A cache that is off, down or returning a corrupt value costs a miss, never a failure. A hit whose dimension is not the current one is ignored, and so is one whose bytes hold NaN or an infinity: the class shape check decodes the vector, so such a value is a miss counted as a cache error and is never written. A call reads nothing until the model and the dimension are both known, pinned or learned from an earlier answer, because the key needs the model and a hit is compared with the dimension; so with a pin unset, the first call after a start is all misses. It still writes.

Dragonfly stays cache-only. Production's instance is a loopback redis with a 256 MB `volatile-lru` limit, so an entry holds nothing but the vector: about 2 KB at 384 dimensions, which is roughly 100 000 entries in 200 MB. No redis command was added; `cache-conformance.test.ts` still closes the set.

## The fabric row

`fabric_status` reports `tei` as the eighth resource, between `hindsight` and `tailscale-proxy`. It is `unconfigured` without `TEI_URL`. Configured, it shows the endpoint class of `TEI_URL`, the breaker state, and a `detail` of `model`, `modelSource`, `dimension` and `latencyMs`. `model` is the pin, else the model a first embed learned, else the model `GET /info` last named, and `modelSource` says which of `pinned`, `learned`, `observed` or `none` it is (`none` only while `model` is null). An observed model is only what TEI reported: it never keys the cache and never counts as a pin. `dimension` is the pin, else the length of the last good vector. `latencyMs` is the round trip of the last successful request. The row is `ok` only when `GET /health` answered, `GET /info` answered and named the pinned model, and the breaker is closed. The probe asks `/health` first and then `/info`, one try each, one after the other inside one deadline of one second. Side by side, a half-open breaker (which admits one request) would refuse the second, so a TEI that had just recovered would still read as down; in sequence the first probe after recovery reports it available. The probe is shared by fabric calls within a two-second window; `/healthz` never makes it.

`fabric_compliance` adds the check `tei-endpoint-private`: FAIL when `TEI_URL` is neither loopback nor a host and port in `SUBSTRATE_DB_PROXY_ALLOW`, NOT_APPLICABLE when it is unset. Under `SUBSTRATE_DB_ENDPOINT_POLICY=enforce` such a URL refuses boot instead, naming `TEI_URL` and never the URL. The text sent to TEI is document content, which is why the endpoint must stay private.

The breaker is the plane `tei`. It is not one of the six planes in `/healthz` and has no SLO; its calls are recorded as `substrate.plane.duration{plane=tei}`.

## Turning it on

1. Make TEI reachable from the host through a forwarder and list its `host:port` in `SUBSTRATE_DB_PROXY_ALLOW` (or bind the forwarder on loopback).
2. Set `TEI_URL`, and `TEI_API_KEY` if the service is guarded. Restart `substrate-mcp`.
3. Call `fabric_status`. The `tei` row should be `ok`. With only `TEI_URL` set its `detail.model` already shows the model `GET /info` named, with `detail.modelSource: "observed"`, so there is something to copy before anything has embedded. Copy that model into `SUBSTRATE_TEI_MODEL`, and the dimension (`detail.dimension`, filled by the first embed) into `SUBSTRATE_TEI_DIM`, so a later change of model is refused instead of learned.
4. Set `SUBSTRATE_EMBED_CACHE=on` only when Dragonfly is the loopback redis. Watch `bun scripts/cache-stats.ts` for the `emb` class.

Rollback: unset `TEI_URL` (nothing is sent), or set `SUBSTRATE_EMBED_CACHE=off` to stop reading and writing the cache. Cached vectors expire by TTL; nothing needs deleting.

## Not done here

No component embeds anything yet; the service and its cache are the product of this change. The near-duplicate detection of phase 64 is a consumer of `EmbeddingService`. LightRAG's own embedding binding is not touched.
