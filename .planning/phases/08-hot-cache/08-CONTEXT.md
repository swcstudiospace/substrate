# Phase 8: Hot cache - Context

**Gathered:** 2026-09-26
**Status:** Ready for planning
**Amended:** 2026-09-27 — D-10 (owner skipped Phase 5's docs half; SPE-3970)

<domain>
## Phase Boundary

DragonflyDB (owner's Railway) fronts substrate-mcp's slow remote reads — the brief and `context_search`
(`docs_search` dropped, D-10) — as a fail-open cache. A miss, error or Dragonfly outage always falls through to the
source. Caching layer only: not a session store, not pub/sub, not a queue (owner decision 2026-09-26).

</domain>

<decisions>
## Implementation Decisions

### Transport and security (owner accepted all, 2026-09-26)
- D-01 Dragonfly `--tls` on the main port with a private CA generated on the VPS; server cert SAN = the Railway TCP-proxy domain; CA pinned in the client (`rejectUnauthorized:true`); password via `DFLY_requirepass`; `--primary_port_http_enabled=false`; `--bind=::`; no `--tls_ca_cert_file` (would force mTLS), no admin port. PEMs go in non-`DFLY_` Railway variables (`TLS_CERT_PEM`, `TLS_KEY_PEM`); unknown `DFLY_*` vars are fatal. The owner applies the start command and variables at a blocking checkpoint (start command in 08-RESEARCH-CONTRACTS.md § "Recommended Railway setup").
- D-02 Flags `--cache_mode --maxmemory=512mb --proactor_threads=2 --dbfilename=`; no volume; service RAM ≥ 768 MB; image `ghcr.io/dragonflydb/dragonfly:v2.0.0`.
- D-03 Bun 1.4.0 built-in `RedisClient` (no new dependency): `rediss://` + `tls:{ca}`, `enableOfflineQueue:false`, `autoReconnect:true`, `connectionTimeout` ~1.5 s, every call raced against a 100 ms timer; no-op (never `null`) `onclose` handler (#29145); `connect()` re-armed after terminal failure. Verify `tls.ca` accepts PEM text vs path with a throwaway `bun -e` at plan time.
- D-04 Config: `DRAGONFLY_URL` (rediss://default:<pw>@<proxy-domain>:<port>) and `DRAGONFLY_CA_FILE` (0600 root) in `/etc/substrate/substrate.env`; either absent → cache disabled, all calls uncached.

### Cache policy (owner accepted all)
- D-05 Brief key `brief:v1:<surface>:<repo>:<branch>:<graph>:<gen>`, TTL 30 s; any emitted event for a repo/graph increments `gen:<repo>` / `gen:<graph>` counters that form part of the key (no SCAN deletes).
- D-06 `docs_search` TTL 1 h (superseded by D-10: not cached), `context_search` TTL 60 s, keyed by sha256(normalized query + scope); values are the already-redacted result JSON only.
- D-07 Any cache error/timeout → bypass to source; circuit breaker opens after 5 consecutive failures for 30 s; writes fire-and-forget.
- D-08 `GET /healthz` gains `cache:{enabled, connected, hits, misses, bypasses}`; healthz status stays driven by index/greptime only.
- D-09 Proof: repeated brief, docs and recall calls (docs superseded by D-10: brief and recall only) show rising hits and lower latency; then Dragonfly is made unreachable (client-side, e.g. firewall/env route with RESTORE first) and the same calls return identical answers uncached, inside the brief's 1.5 s budget.

### Phase 5 docs half skipped (owner decision 2026-09-27, SPE-3970)
- D-10 The owner skipped Phase 5's docs half on 2026-09-27 (05-02 resume-signal "skip"; 05-04 and 05-05 never run), so `docs_search`, `docs_ingest`, `searchDocs` and `POST /docs/*` do not exist and `docs_search` is not cached. Phase 8 caches the brief and `context_search` only: no `docs:v1:` keys, no `DOCS_TTL_S`, no docs latency baseline or docs proof probe, and 08-01's phase-order gate accepts `phase5-verification=accepted` with a note citing this decision. ROADMAP Phase 8 SC3's docs clause (and the Proof's docs query) is superseded; D-06's docs part and D-09's docs probe are superseded.

### Claude's Discretion
- Query normalization details, breaker implementation, latency measurement method.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `loadConfig` (`packages/mcp-server/src/config.ts:55-79`), `swallow()` (`brief.ts:78-84`), `/healthz` (`server.ts:104-107`), `composeBrief` in `brief.ts` and `context_search` (Phase 7) as the wrapped reads (no `docs_search`, D-10), `service.ts` emit path for generation bumps.

### Established Patterns
- RESTORE route before every live change (`/var/lib/substrate/phase8-baseline/RESTORE.d/08-NN.md`); two-sided gates; explicit-path staging; `Refs SPE-3576`.

### Integration Points
- New `packages/mcp-server/src/cache.ts`; wrappers in `service.ts`; `server.ts` healthz.

</code_context>

<specifics>
## Specific Ideas

- Contracts (Dragonfly v2.0.0 @40553fd flags, Bun 1.4.0 @34cbb9a RedisClient semantics, observed offline behaviour): `08-RESEARCH-CONTRACTS.md` §6–7.
- Open: TCP-proxy idle timeout and domain stability across redeploys — measure during the proof.

</specifics>

<deferred>
## Deferred Ideas

- Pub/sub event fan-out for dispatcher/brief writers; rate limiting; mTLS.

</deferred>
