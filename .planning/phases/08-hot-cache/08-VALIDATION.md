---
phase: "8"
slug: "hot-cache"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-26"
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `08-CONTEXT.md` (owner-accepted D-01..D-09), `08-RESEARCH-CONTRACTS.md` §6–7 and plans
> 08-01..08-07 (the test file names below are the ones the plans create or extend). The criterion and
> decision coverage matrices are in `COVERAGE.md`.

---

## Test Infrastructure

Phase 8 touches `packages/mcp-server` (new cache.ts; config, service, server and their tests),
`.env.example`, and live state: the owner's Railway Dragonfly service (variables, start command, TCP
proxy), `/etc/substrate/substrate.env` (two owner-appended lines), `/etc/substrate/dragonfly-tls/`,
substrate-mcp restarts, and — during the proof only — tagged iptables/ip6tables OUTPUT rules. Phase 8
runs **after Phase 7** (and Phase 5's docs half); its baseline is measured then (08-01), never copied.

| Property | Value |
|----------|-------|
| **Framework (TS)** | `bun test` (repo root, colocated `*.test.ts`) + `bunx tsc --noEmit` (root tsconfig includes `packages/**/*.ts`; bun-types 1.4.2 types `RedisClient`). |
| **Framework (Python)** | `packages/dispatcher` pytest — untouched by Phase 8; regression gate in 08-07. |
| **Unit seam** | `createHotCache(config, { client, readCa, now, log })` — a fake RESP client (ok / reject / never-settle per method, call counts, a fireable onclose) and an injected clock; no network in unit tests. |
| **Local spike** | 08-01 Task 2: Bun.listen TLS RESP3 fake on 127.0.0.1 with throwaway openssl CAs (no Railway). |
| **Live reads** | Dragonfly through keyed throwaway scripts (`sudo systemd-run … -p EnvironmentFile=/etc/substrate/substrate.env … bun /tmp/<script>.ts`; no `$`/`%` inline) that print key=value only; `openssl s_client`/`curl --cacert` for TLS; the service through `curl 127.0.0.1:7410` REST and MCP JSON-RPC; `tcpdump` for the SC1 wire check. |
| **Quick run command** | `SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test packages/mcp-server/src/cache.test.ts packages/mcp-server/src/service.test.ts packages/mcp-server/src/server.test.ts` |
| **Full suite command** | `cd /root/src/repos/agent-substrate && SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test && /root/.local/share/reflex/bun/bin/bunx tsc --noEmit && (cd packages/dispatcher && python3 -m pytest -q)` |
| **Estimated runtime** | < 30 s per suite (owner checkpoints, the 11-minute idle probe and the proof excluded) |

| Repo / package | Quick run command | Baseline (re-measured by 08-01 into `08-BASELINE.md`) |
|---|---|---|
| agent-substrate (TS) | `SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test` | re-measured after Phase 7 (`agent-substrate-pass=`) |
| agent-substrate (tsc) | normalized `bunx tsc --noEmit` pipeline (03-BASELINE.md) | re-measured (`agent-substrate-tsc-set:`) |
| dispatcher (Python) | `cd packages/dispatcher && python3 -m pytest -q` | re-measured (`dispatcher-pass=`) |
| live latency (uncached) | 5× POST /brief, /docs/search, /context/search | `brief-ms-p50=` (~700 ms at planning), `docs-ms-p50=`, `ctx-ms-p50=` |

Two-sided rule (standing): every code task diffs failing ids and the normalized tsc set against
`08-BASELINE.md`; a failure or type error that **disappears** fails the gate like a new one; the pass
count must exceed `agent-substrate-pass` (every code task adds tests). The dispatcher gate runs in
08-07 T3. Every substrate-mcp restart (08-04 T3, 08-05 T2) is guarded by a clean `packages/` tree and a
RESTORE route written first, and must return /healthz 200 with the index/greptime fields unchanged.

Execution note: `.planning/config.json` has `workflow.use_worktrees: false`; the plans form one chain
(waves 0–6, one plan per wave). Owner checkpoints: 08-02 T2 (service shell + TCP proxy), 08-03 T1
(variables, start command, env lines), 08-07 T2 (redeploy). Decision stops (not checkpoints, messaged to
the orchestrator): 08-02 T3 RTT gate and 08-03 T2 race-budget gate, 08-07 T3 domain change.

Planning-time observations (2026-09-26, not a substitute for 08-01): Bun 1.4.0+34cbb9a40 `tls.ca`
accepts PEM text / Buffer / BunFile / [PEM text] and refuses a path string; an idle connected client does
not keep the process alive; a TLS client dialling a plaintext port waits the full connectionTimeout;
ICMP RTT VPS → existing Railway TCP proxy 96–99 ms, SELECT 1 on an established connection ~200 ms. close() then connect() on the same RedisClient re-dialled and served (plaintext fake, 2026-09-27). redact() over serialized JSON rejects already-redacted text followed by a newline (plan-checker reproduction), hence the value-level redactionStable guard.

---

## Sampling Rate

- **After every task commit:** the targeted test file(s) (each code task's `<automated>` starts with them).
- **After every code task:** full `bun test` + normalized tsc, two-sided against 08-BASELINE.md; no manifest/lockfile change.
- **Live smoke per plan:** the key=value lines in `08-01-SPIKE.md`, `08-02-TLS.md`, `08-03-SMOKE.md`, `08-04-TRACER.md`, `08-05-SMOKE.md`, `08-PROOF.md`, each checked by the plan's verify, plus a fresh live read (healthz, s_client, iptables-save, file modes) that must agree with the evidence.
- **Before `/gsd:verify-work`:** all suites green against the baseline, every evidence file complete, `08-PROOF.md` with `proof_result=pass` and `phase8_result=pass`.
- **Max feedback latency:** 30 seconds for unit gates.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Criterion / Decision | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|----------------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 0 | standing rules (phase order, baseline, RESTORE), D-03 budget ceiling (`race-ms-ceiling` from the brief tail), D-04 precondition | T-08-01-01, -03 | env only via `grep -c`; RTT probe prints one number; no credential URL in the baseline | live measure | key checks on 08-BASELINE.md; VERIFICATION status re-read; symbol greps; rollback dir mode; race-ms-ceiling ≥ 100 | ❌ W0 | ⬜ pending |
| 08-01-02 | 01 | 0 | D-03 (tls.ca form, refusals, offline/race timing, idle process exit, close-then-connect; research OQ10, OQ19) | T-08-01-02 | loopback-only fake, throwaway keys deleted | local spike | 08-01-SPIKE.md keys (`ca_form_decision=pem-text`, race 95–250 ms, 0 unhandled rejections, `idle_client_keeps_process=false`, `breaker_redial` consistent with `close_then_connect`) | ❌ W0 | ⬜ pending |
| 08-02-01 | 02 | 1 | D-04 (presence first), standing RESTORE rule, docs (.env.example) | T-08-02-02 | routes before change; empty template values | live + file | 08-02-TLS.md keys; RESTORE.d/08-02.md mode and routes; .env.example greps | ❌ | ⬜ pending |
| 08-02-02 | 02 | 1 | D-01, D-02 (owner service shell, region, memory, TCP proxy) | T-08-02-01, -04, -06 | inert start command before the proxy exists; no DFLY_ variable | owner checkpoint | reply recorded; parsed in 08-02-03 | n/a | ⬜ pending |
| 08-02-03 | 02 | 1 | D-01 (CA, SAN, password), D-03 (RTT gate; amendment ≤ race-ms-ceiling) | T-08-02-02, -03, -05 | keys/password straight into 0600 files; never printed; re-issue route works after the 08-03 shred (in-place host:port rewrite, no re-append) | live | 08-02-TLS.md keys; live SAN + `openssl verify`; modes; no PEM/48-hex in evidence; route text checked | ❌ | ⬜ pending |
| 08-03-01 | 03 | 2 | D-01, D-02, D-04 (owner variables, TLS start command, env lines) | T-08-03-03 | no-echo appends; presence by pattern count | owner checkpoint | `sudo grep -c` pattern checks (1/1/2, 600 root) | n/a | ⬜ pending |
| 08-03-02 | 03 | 2 | SC1, D-01, D-02, D-03 (live gate ≤ race-ms-ceiling) | T-08-03-01..06 | negatives never carry the real password; pinned CA; HTTP console off; password file and server key shredded (idempotent for a re-issue re-run) | live smoke | 08-03-SMOKE.md keys; live `openssl s_client` verify 0; env/TLS-dir checks | ❌ | ⬜ pending |
| 08-04-01 | 04 | 3 | D-03, D-04, D-05 (read path), D-08, SC2, SC4 — **tracer** | T-08-04-01, -02, -04 | rediss-only client (refusal logs "not a TLS URL", never the URL); CA pinned; offline queue off; race; value-level redactionStable guard | unit + e2e + live one-shot | `bun test cache.test.ts server.test.ts service.test.ts` ("healthz carries cache counters without changing its status"); 08-04-TRACER.md tracer_* keys; gate (manifest check over (08- commits) | ❌ | ⬜ pending |
| 08-04-02 | 04 | 3 | D-05 (invalidation), D-07 (breaker with observed `breaker_redial`, re-arm, fire-and-forget, write guard) | T-08-04-01..04 | never blocks or fails a caller; never logs the password; already-redacted text is cacheable | unit | `bun test cache.test.ts service.test.ts` ("opens the breaker after 5 consecutive failures", "re-arms connect after a terminal close", "never logs the password", "caches already-redacted text", "an event for the repo invalidates its cached brief"); `this.forwarder?.enqueue(` count ≥ 2; gate | ✅ extend | ⬜ pending |
| 08-04-03 | 04 | 3 | SC1 (wire), SC2 (REST + MCP brief, invalidation live), SC4 (healthz), D-08 | T-08-04-01, -05 | RESTORE first; guarded restart; tcpdump ready before restart; pcap/journal password checks; per-key expiry_stable attribution (key exists and its absolute expiry = read time + PTTL is unchanged across the repeat, ≥ 1 s gap) | live | 08-04-TRACER.md keys (`rest_repeat_hit`, `mcp_repeat_hit`, `gen_bumped`, `invalidation_new_key_written`, `post_invalidation_hit`); live healthz cache keys; RESTORE.d/08-04.md | ❌ | ⬜ pending |
| 08-05-01 | 05 | 4 | D-06, SC3; discretion (normalization) | T-08-05-01, -04, -05, -06 | redacted values only; never cache errors or fail-open empties; tool.call on hits | unit | `bun test cache.test.ts service.test.ts server.test.ts mcp.test.ts` ("docs_search is served from the cache on a repeat", "context_search never caches a fail-open empty"); gate | ✅ extend | ⬜ pending |
| 08-05-02 | 05 | 4 | SC3 live, SC4 (docs/recall counters) | T-08-05-01, -04 | raw values redaction-stable (value-level), 0 token shapes, TTL-bounded; tool.call count filtered to the probe query | live | 08-05-SMOKE.md keys (`docs_repeats_hit`, `ctx_repeats_hit` by expiry_stable); RESTORE.d/08-05.md; live healthz | ❌ | ⬜ pending |
| 08-06-01 | 06 | 5 | Proof / D-09 (warm half); discretion (latency method) | T-08-06-01, -03, -04, -05 | unblock route + `#!/bin/bash` script before any rule, dry-run as a systemd unit; no ::ffff: addresses | live | 08-PROOF.md setup/warm keys (per-key `*_repeats_hit`, `warm_src_*_equal`); route/script modes, shebang, `bash -n`, TAG and addresses | ❌ | ⬜ pending |
| 08-06-02 | 06 | 5 | Proof / D-09 (unreachable half), SC2 (1.5 s), SC4 (every tool answers), D-07 live | T-08-06-01, -02, -05 | addresses re-resolved first; TAG-only deletion; dead-man via /bin/bash; drift classified against a direct source read; recovery without restart | live | 08-PROOF.md unreachable/recovery keys (`unreachable_*_equality` identical or substantiated drift); live iptables/ip6tables-save 0 tagged; timer inactive; healthz connected | ❌ | ⬜ pending |
| 08-07-01 | 07 | 6 | CONTEXT open item (proxy idle timeout); D-02/D-07 evidence setup | T-08-07-02, -05 | RESTORE first; 24 h marker key; watcher unit (5 s, 4 h cap) | live probe | 08-PROOF.md `## Final` idle, persist_key_*, watcher_* keys; unit active | ❌ | ⬜ pending |
| 08-07-02 | 07 | 6 | CONTEXT open item (domain stability across redeploys) | T-08-07-01 | none secret | owner checkpoint | reply recorded | n/a | ⬜ pending |
| 08-07-03 | 07 | 6 | D-02 (no persistence, owner-latency independent), D-07 (self-heal timed from the drop), D-03 (no new dependency), SC1 journal hygiene (whole phase), owner questions, standing gates | T-08-07-01, -03, -04, -05 | scope and manifest checks over every (08- commit; watcher stopped | live + full gate | 08-PROOF.md final keys; live re-run of bun/tsc/pytest two-sided; iptables/TLS-dir/env/healthz checks | ❌ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `08-BASELINE.md` — phase-order gate (05/07 VERIFICATION or recorded acceptance), bun/tsc/dispatcher two-sided keys, healthz shape, env presence counts, TLS dir absent, 0 p8-proof rules, bun revision/types, uncached latency samples, disk ≥ 10 GiB (08-01 Task 1).
- [ ] `/var/lib/substrate/phase8-baseline/` (0700) with `RESTORE.md` index and `RESTORE.d/08-01.md` (08-01 Task 1).
- [ ] Bun RedisClient TLS spike → `08-01-SPIKE.md` with `ca_form_decision`, `close_then_connect`/`breaker_redial` and `idle_client_keeps_process=false` (08-01 Task 2).
- [ ] `cache.test.ts` is created by 08-04 Task 1 (TDD, before cache.ts); no other scaffold is needed — service/server tests exist and are extended.
- [ ] No npm/pip install anywhere in the phase (D-03: Bun's built-in RedisClient); 08-04, 08-05 and 08-07 check manifests and bun.lock.

---

## Manual-Only Verifications

| Behavior | Criterion | Why Manual | Test Instructions |
|---|---|---|---|
| Creating the Dragonfly service, region, memory, TCP proxy | D-01, D-02 | The Railway project is visible only to the owner | 08-02 Task 2 checkpoint; the agent parses the reply and pings the domain (Task 3). |
| Railway variables, TLS start command, deploy-log review, env appends | D-01, D-02, D-04 | Owner account and owner terminal; the agent must never see the key or password | 08-03 Task 1 checkpoint; presence-only pattern counts; 08-03 Task 2 proves the result from the VPS. |
| Redeploying Dragonfly | CONTEXT open item (domain stability) | Owner account | 08-07 Task 2 checkpoint; 08-07 Task 3 checks domain, flush and self-heal from the VPS. |
| Moving the service or amending the 100 ms budget | D-03 | Owner decision if the RTT gate fails | 08-02 Task 3 / 08-03 Task 2 stop and message the orchestrator; the answer is recorded verbatim with `race_ms`. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or are owner checkpoints with presence-only verification
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all ❌ W0 references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] Baselines re-measured before the first edit (08-01); gates two-sided against 08-BASELINE.md
- [ ] Every live edit outside the repo preceded by a RESTORE.d route (08-02, 08-04, 08-05, 08-06, 08-07)
- [ ] Live hit/miss claims attributed per key (expiry_stable: exists at both reads, absolute expiry unchanged within 250 ms, ≥ 1 s gap), not by global /healthz deltas; equality checks drift-classified against a direct source read
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
