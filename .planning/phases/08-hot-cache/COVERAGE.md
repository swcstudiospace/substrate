# Coverage — Phase 8 (Hot cache)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Plans: 08-01 (phase-order gate on Phases 5/7, baseline, rollback area, Bun RedisClient TLS spike),
> 08-02 (env presence + RESTORE, owner service shell + TCP proxy, RTT gate, private CA / server cert / password),
> 08-03 (owner variables + TLS start command + env lines, live TLS smoke and budget gate),
> 08-04 (tracer: cache.ts + cached brief + healthz counters; breaker/re-arm/invalidation; deploy),
> 08-05 (docs_search and context_search caching; deploy), 08-06 (proof: warm, client-side unreachable, recovery),
> 08-07 (proxy idle probe, owner redeploy, durability, phase-end gates).
> Task references are `plan / task` (e.g. 08-04 T2). Evidence keys live in 08-BASELINE.md, 08-01-SPIKE.md,
> 08-02-TLS.md, 08-03-SMOKE.md, 08-04-TRACER.md, 08-05-SMOKE.md and 08-PROOF.md.

## ROADMAP success criteria and proof → plan/task

| Criterion | Covered by | Evidence key(s) |
|---|---|---|
| SC-1 `DRAGONFLY_URL` from `/etc/substrate/substrate.env`; the password never crosses the public Railway TCP proxy in plaintext | 08-02 T1 (presence before), 08-02 T3 (private CA, SAN = proxy domain), 08-03 T1 (owner no-echo append), 08-03 T2 (live TLS, refusals), 08-04 T1 (client only for `rediss:`; CA pinned, rejectUnauthorized), 08-04 T3 (wire capture, journal) | 08-03-SMOKE.md `env_scheme=rediss:`, `openssl_verify=0`, `tls_protocol`, `plaintext=refused…`, `wrong_ca=refused…`, `system_store=refused…`, `noauth=refused…`; 08-04-TRACER.md `pcap_tls_clienthello_seen=true`, `pcap_plaintext_hello=0`, `pcap_password_hits=0`, `journal_password_hits=0`, `journal_rediss_mentions=0`; 08-PROOF.md (08-07 T3, whole-phase journal incl. failure paths) `journal_phase_rediss_mentions=0`, `journal_phase_password_hits=0` |
| SC-2 `/brief` and `memory_brief` cached per surface, repo, branch and Graph ID with a short TTL, invalidated by new events for that repo or graph | 08-04 T1 (briefKey, 30 s TTL, REST e2e), 08-04 T2 (gen bump in emit; invalidation test), 08-04 T3 (REST + MCP hits, live invalidation) | 08-04-TRACER.md `rest_brief_equal=true`, `mcp_brief_equal=true`, per-key `rest_repeat_hit=true`, `mcp_repeat_hit=true` (PTTL not reset), `gen_bumped=true`, `invalidated_brief_has_event=true`, `invalidation_new_key_written=true`, `post_invalidation_hit=true` |
| SC-2 the brief stays inside its 1.5 s fail-open budget with Dragonfly unreachable | 08-04 T1/T2 (race, breaker, offline queue off), 08-06 T2 (black-hole outage) | 08-PROOF.md `unreachable_brief_max_ms` < 1500, `unreachable_brief_over_budget=0`, `unreachable_brief_equality=identical|drift`; 08-BASELINE.md `race-ms-ceiling` (two races + the brief tail < 1.5 s) |
| SC-3 `docs_search` and `context_search` cached by normalized query and scope with a TTL; cached values hold only already-redacted text | 08-05 T1 (queryKey, normalizeQuery, TTLs, never-cache rules, write guard), 08-05 T2 (live hits, raw values, TTLs) | 08-05-SMOKE.md `docs_variant_equal=true`, per-key `docs_repeats_hit=true`, `ctx_repeats_hit=true`, `docs_tool_call_events=5` (probe query only), `docs_raw_redaction_stable=true` (value-level `redactionStable`), `ctx_raw_redaction_stable=true`, `*_raw_token_shapes=0`, `docs_ttl_s`, `ctx_ttl_s` |
| SC-4 hit, miss and bypass counts visible on `GET /healthz` | 08-04 T1 (health().cache; e2e test), 08-04 T3, 08-05 T2, 08-06 | 08-04-TRACER.md `healthz_cache_keys=bypasses,connected,enabled,hits,misses`; 08-PROOF.md `warm_hits_delta_global`, `unreachable_bypasses_delta` (global counters, ≥ semantics; per-key PTTL proofs carry the attribution) |
| SC-4 with Dragonfly unreachable every tool still answers, uncached | 08-06 T2 (tools/list unchanged; seven-tool MCP sweep incl. events_emit; REST routes 200; POST /events 202) | 08-PROOF.md `tools_after_equal=true`, `mcp_sweep_errors=0`, `unreachable_rest_non200=0`, `unreachable_event_status=202`, `unreachable_healthz_status=200` |
| **Proof** — repeated brief, docs query and recall query served from Dragonfly (hit counts rise, latency drops); with Dragonfly unreachable the same calls return the same answers, uncached | 08-06 T1 (warm), 08-06 T2 (unreachable + recovery) | 08-PROOF.md `warm_result=pass` (per-key `*_repeats_hit=true`, `warm_src_*_equal=true`, `warm_hits_delta_global` ≥ 33, `latency_drop=true`, `*_repeats_equal=true`), `unreachable_*_equality=identical|drift` (drift only against a direct source read, named under Gaps), `proof_result=pass` |

## Decisions D-01..D-09 → plan/task

| Decision | Covered by | How |
|---|---|---|
| D-01 Dragonfly `--tls` on the main port, private CA on the VPS, SAN = TCP-proxy domain, CA pinned (`rejectUnauthorized:true`), `DFLY_requirepass`, `--primary_port_http_enabled=false`, `--bind=::`, no `--tls_ca_cert_file`, no admin port, PEMs in non-`DFLY_` variables, owner applies at a blocking checkpoint | 08-02 T2 (no DFLY_ vars), 08-02 T3 (CA, server cert, password), 08-03 T1 (owner: TLS_CERT_PEM, TLS_KEY_PEM, DFLY_requirepass, verbatim start command), 08-03 T2 (live: verify 0, HTTP console off, no client cert needed, noauth refused), 08-04 T1 (pinned client) | `server_san=DNS:<domain>`, `server_verifies=true`; `dfly_password_absent=owner-confirmed`, `start_command_verbatim`; `http_console=disabled`, `noauth=refused…` |
| D-02 `--cache_mode --maxmemory=512mb --proactor_threads=2 --dbfilename=`; no volume; RAM ≥ 768 MB; image `ghcr.io/dragonflydb/dragonfly:v2.0.0` | 08-02 T2/T3 (pinned image, memory ≥ 768, no volume), 08-03 T1 (start command), 08-03 T2 (INFO), 08-07 T1 (24 h marker key p8:persist:<stamp> set immediately before the redeploy checkpoint), 08-07 T3 (key gone after the redeploy while inside its own lifetime — independent of owner response time) | `service_memory_mb` ≥ 768; `info_version` ∋ 2.0.0, `info_maxmemory=536870912`, `info_maxmemory_policy=eviction`; `persist_key_ttl_before` ≥ 86000, `persist_key_exists_after=0`, `persistence_off=true` |
| D-03 Bun 1.4.0 built-in `RedisClient` (no new dependency): `rediss://` + `tls:{ca}`, `enableOfflineQueue:false`, `autoReconnect:true`, `connectionTimeout` ~1.5 s, every call raced against 100 ms, no-op (never null) `onclose` (#29145), `connect()` re-armed after terminal failure; verify tls.ca PEM text vs path with a throwaway `bun -e` | 08-01 T2 (spike: PEM text works, path refused — also observed at planning), 08-01 T1 (`race-ms-ceiling` from the brief tail), 08-02 T3 + 08-03 T2 (RTT / race-budget gates, amendments capped at race-ms-ceiling), 08-04 T1 (client options, race, handlers), 08-04 T2 (re-arm with unref'd backoff), 08-04/08-05/08-07 (no (08- commit touches a manifest or bun.lock) | `ca_form_decision=pem-text`; `race_budget_ok=true`, `race_ms`; cache.ts `enableOfflineQueue: false`, `CONNECT_TIMEOUT_MS = 1500`, `CALL_BUDGET_MS = <race_ms>`; no `onclose = null`; `phase8_manifest_changes=0` |
| D-04 `DRAGONFLY_URL` (`rediss://default:<pw>@<proxy-domain>:<port>`) and `DRAGONFLY_CA_FILE` (0600 root) in substrate.env; either absent → cache disabled, all calls uncached | 08-01 T1 (presence before), 08-02 T1 (RESTORE route, .env.example), 08-03 T1 (owner append, pattern check), 08-03 T2 (`ca_file_mode=600`), 08-04 T1 (loadConfig null block; disabled cache test) | `env-dragonfly-*-before=0`; `sudo grep -c` pattern counts 1/1/2; `dragonfly: null` behaviour tested (`bypasses:1`, no client built) |
| D-05 brief key `brief:v1:<surface>:<repo>:<branch>:<graph>:<gen>`, TTL 30 s; any emitted event for a repo/graph increments `gen:<repo>` / `gen:<graph>` (no SCAN deletes) | 08-04 T1 (briefKey with `<genRepo>.<genGraph>`, MGET of gens, TTL 30), 08-04 T2 (`this.cache.bump(event)` after the write; namespaced `gen:repo:` / `gen:graph:` so a same-named repo and graph never share a counter), 08-04 T3 (live invalidation) | "an event for the repo invalidates its cached brief"; `invalidated_brief_has_event=true`; no SCAN/DEL in cache.ts |
| D-06 `docs_search` TTL 1 h, `context_search` TTL 60 s, keyed by sha256(normalized query + scope); values are the already-redacted result JSON only | 08-05 T1, 08-05 T2 | `DOCS_TTL_S = 3600`, `CONTEXT_TTL_S = 60`, `queryKey`; `docs_ttl_s` ∈ (3000, 3600], `ctx_ttl_s` ∈ (0, 60]; raw values redaction-stable (value-level `redactionStable`, 08-04 — already-redacted text with newlines is cached, unredacted text never) |
| D-07 any cache error/timeout → source; breaker opens after 5 consecutive failures for 30 s; writes fire-and-forget | 08-04 T1 (race → bypass), 08-04 T2 (breaker, probe, close+re-dial, unawaited SET/INCR), 08-06 T2 (live black hole: bypasses, no hits, recovery), 08-01 T2 (`close_then_connect` → `breaker_redial`), 08-07 T1 (healthz watcher unit started before the checkpoint), 08-07 T3 (self-heal timed from the watcher's observed drop) | "opens the breaker after 5 consecutive failures"; `unreachable_cache_connected=false`, `recovered=true` (per-key hit), `recovery_hit_s` ≤ 120; `mcp_restarted=false`, `watch_disconnect_at`/`watch_reconnect_at`, `post_redeploy_reconnect_s` ≤ 180 |
| D-08 `GET /healthz` gains `cache:{enabled, connected, hits, misses, bypasses}`; status still driven by index/greptime only | 08-04 T1 (health().cache; server status expression unchanged; e2e 503 case), 08-04 T3 (live keys) | "healthz carries cache counters without changing its status"; `healthz_cache_keys=bypasses,connected,enabled,hits,misses`; `unreachable_healthz_status=200` |
| D-09 proof: rising hits and lower latency on repeated brief/docs/recall; then Dragonfly unreachable client-side (RESTORE first) and identical answers uncached inside 1.5 s | 08-06 T1 (RESTORE route + `#!/bin/bash` unblock script, syntax-checked and dry-run as a systemd unit before any rule; warm run with per-key hits and a direct source comparison), 08-06 T2 (addresses re-resolved, dead-man timer armed, then DROP rules by TAG; same answers — drift classified against the source; brief < 1.5 s; restore; recovery) | `restore_route_written=true`, `unblock_script_syntax=ok`, `unblock_shebang=ok`, `unblock_dry_run=ok`, `deadman_armed=true`; `proof_result=pass` |

## CONTEXT specifics, discretion and research open questions

| Item | Covered by | How |
|---|---|---|
| Open: TCP-proxy idle timeout — measure during the proof | 08-07 T1 | four pinned clients idle 60/180/330/630 s → `proxy_idle_timeout` (informational; autoReconnect + re-arm already handle idle closes) |
| Open: domain stability across redeploys — measure during the proof | 08-07 T2 (owner redeploy), 08-07 T3 | `proxy_domain_stable`; a change stops for an owner decision with the re-issue route in RESTORE.d/08-02.md |
| Discretion: query normalization | 08-05 T1 | NFKC + trim + whitespace collapse, case preserved (identical answers over hit rate); scope canonical JSON |
| Discretion: breaker implementation | 08-04 T2 | consecutive-failure counter over every client op, 30 s open, single half-open probe, close()+re-dial on open (half-open sockets, research §7.5) — same client or a fresh one per 08-01's observed `breaker_redial` |
| Discretion: latency measurement method | 08-01 T1, 08-06 | `curl -w %{time_total}` on REST routes; 5 uncached baseline samples; 10 warm repeats (p50/max); every unreachable call timed; hits attributed per key by PTTL (a hit never rewrites a key); equality on drift-robust projections (brief text, docs `results`, recall `results` without `score`) |
| Research OQ7 (legacy vs dual-stack Railway env) | — (not applicable) | only private networking cares; the VPS uses the public TCP proxy; `--bind=::` is in the start command anyway |
| Research OQ8 (kernel/cgroup: io_uring vs epoll, threads, memory) | 08-03 T1 | owner reports the "Kernel", "epoll", "Max memory limit", threads log lines; `--proactor_threads=2` pins the floor |
| Research OQ9 (domain stability) | 08-07 T2/T3 | see above |
| Research OQ10 (tls.ca PEM text vs path vs BunFile) | 08-01 T2 | `ca_form_decision=pem-text` (planning run: path string refused); marked RESOLVED in 08-RESEARCH-CONTRACTS.md § Open questions, as are OQ7–21 |
| Research OQ11 (`DFLY_PASSWORD` fatal?) | 08-02 T2, 08-03 T1 | avoided: only `DFLY_requirepass`; owner confirms no `DFLY_PASSWORD` |
| Research OQ12 / OQ15 (proxy idle close; first commands after idle may miss) | 08-07 T1; 08-04 T2 | measured; misses are bypasses by design, autoReconnect + re-arm restore the socket |
| Research OQ13 (mTLS) | — (deferred) | CONTEXT § Deferred Ideas; no `--tls_ca_cert_file` |
| Research OQ14 (live rediss smoke via the proxy) | 08-03 T2 | `tls_ping=PONG` with the pinned CA |
| Research OQ16 (SNI servername) | 08-02 T3 | not needed: the certificate names exactly the URL host (SAN = proxy domain) |
| Research OQ17 (URL userinfo percent-decoding) | 08-02 T3 | avoided: 48-hex password, URL-safe; `env_password_shape_ok=true` |
| Research OQ18 (pin Bun 1.4.0 vs 1.4.1–1.4.3) | 08-01 T1/T2 | no upgrade in scope; baseline records `bun-revision`, the spike must run on the same build |
| Research OQ19 (half-open detection) | 08-01 T2, 08-04 T2, 08-06 T2 | `close_then_connect` observed on Bun 1.4.0 first; breaker close()+re-dial; proven against a black hole |
| Research OQ20 (skip writes while disconnected) | 08-04 T1 | moot: offline queue off makes writes reject at once (no late queued writes) |
| Research OQ21 (AAAA-only private DNS) | — (not applicable) | no Railway-hosted consumer uses `*.railway.internal` in this phase |
| Research "Decisions this implies" D9 (Dragonfly TLS on Railway) and D10 (Bun client) | = D-01, D-03 | owner accepted both as D-01/D-03 |

## Standing rules → plan/task

| Rule | Covered by |
|---|---|
| Wave 0 gates on the prior phase having landed | 08-01 T1 (05 and 07 VERIFICATION status or verbatim orchestrator acceptance; symbol checks) |
| Disk ≥ 10 GiB at plan start | 08-01 T1 (`disk-avail-before` ≥ 10737418240) |
| Two-sided gates against a baseline re-measured in wave 0 | 08-01 T1 (baseline); 08-04 T1/T2, 08-05 T1, 08-07 T3 (gates) |
| RESTORE route before every live change | 08-01 T1 (index), 08-02 T1 (env, TLS dir, Railway), 08-02 T3 (re-issue), 08-04 T3 (disable, revert), 08-05 T2 (revert), 08-06 T1 (firewall unblock + dead-man, dry-run), 08-06 T2 (route updated first if the addresses changed), 08-07 T1 (watcher stop, marker-key removal) |
| Credentials presence-checked only; owner appends with no-echo commands | 08-01 T1, 08-02 T1, 08-03 T1 (step 4 commands; pattern counts), 08-03 T2 (in-process shape checks only) |
| Tracer-first; TDD tasks marked | 08-04 T1 `type="tracer" tdd="true"`; 08-04 T2 and 08-05 T1 `tdd="true"` |
| Explicit-path staging; commits `Refs SPE-3576` | every task's commit step and verify |
| Shared files edited additively; re-read at execution | 08-04 objective and T2 (emit beside Phase 7's forwarder), 08-05 objective |

## Explicit exclusions (not gaps)

| Item | Why |
|---|---|
| Pub/sub event fan-out, rate limiting, mTLS | CONTEXT § Deferred Ideas |
| Session store, queue | CONTEXT § Phase Boundary (caching layer only) |
| Invalidating the brief on `memory_write` or `graph_register` (they emit no event) | not in D-05 (events only); bounded by the 30 s TTL — raised as owner questions 1–2 in 08-PROOF.md `## Owner questions` (08-07 T3, `owner_questions_recorded=3`) and 08-07-SUMMARY.md |
| Invalidating docs results on `docs_ingest` | not in D-06; bounded by the 1 h TTL — raised as owner question 3 in 08-PROOF.md `## Owner questions` (08-07 T3) and 08-07-SUMMARY.md |
