# Uplift 2 handoff — seven data-plane improvements delivered

**Graph:** `ut-mv66gjpd-4d730336` · **Date:** 2026-10-13 · **Branch:** `ultrathink/uplift-2` → `main` (PR via `ultrathink-ship`, Greptile 5/5 + CI `verify` gate, squash auto-merge, as PR #58 did)

## Stage 1 — GSD phases (empty)

`gsd-autonomous` discovery: `.planning/ROADMAP.md` v1.3 18/18 complete, VALIDATION PASS, milestone archived at `ab0dff1`, STATE.md `Awaiting next milestone` → zero incomplete phases. As on 2026-10-12 the work ran as a standalone post-close series under `.planning/uplift-2/`; no new milestone, no ROADMAP change, milestone audit/complete/cleanup not applicable.

## Stage 2 — recon, baselines, proposal, acceptance

[CONTEXT.md](CONTEXT.md) (per-service record, Build Plan citable index, q1–q4 resolved from evidence), [BASELINES.md](BASELINES.md) (read-only production measurements: `brief.p95` **3,116 ms** vs 800, cache **1 %** hit ratio, 172 ms warm / 1 s cold Postgres round trips over the public proxy, ≈ 220–250 ms Greptime/Hindsight/RAGFlow edges, no retention on two 500 MB volumes, every substrate unit `MemoryMax=infinity`), [PROPOSAL.md](PROPOSAL.md) (12 candidates → 7 ranked by alignment × impact ÷ risk). Operator answer: **Accept all 7 and implement**.

## Stage 3 — the seven (one commit series each; merged in three waves)

| # | Item | Headline effect | Switch |
|---|---|---|---|
| R1 | Brief fast path + cache effectiveness | four source reads in parallel under `SUBSTRATE_BRIEF_BUDGET_MS` (1200); `ETag`/304; `X-Substrate-Brief: complete\|degraded\|snapshot` + `-Failed`; last-good snapshot class; heartbeat bumps only its graph; MGET generations; memoised `/healthz`; muse collector sends `If-None-Match` | budget 0, snapshot TTL 0, healthz cache 0 |
| R2 | Plane breakers, per-plane SLOs, dependency-aware health | `CircuitBreaker`/`PlaneRegistry`/`callPlane`/`gatedFetch` around all five planes; `substrate.plane.duration/errors`; `/healthz.planes` + `capacity`; `/slo.planes` rolling-hour availability; `smoke:chaos --plane`; `docs/runbooks/substrate-red.md` | `SUBSTRATE_BREAKER=0` |
| R3 | Hindsight outbox + bounded recall | durable JSONL retain outbox (0600 under StateDirectory) with 30 s→1 h backoff, replay by entry id; recall budgets 4000/1500 ms; cross-bank dedupe; bank re-ensure on 404; boot warnings for `HINDSIGHT_BANK` / missing `HINDSIGHT_BANKS`; `docs/grok-bot.md` corrected | outbox path unset = memory-only; attempts 1 = pre-R3 |
| R4 | TimescaleDB hygiene + retention sweeper | `SUBSTRATE_PG_*` pool/timeouts/`application_name`; `capacity()`; `index.sweep` dry-run by default (`substrate index sweep`, daily timer, two keys to apply); runbooks lease-stuck, quarantine-spike; `docs/data-planes.md` index row corrected | `SUBSTRATE_INDEX_SWEEP=off\|dry-run\|apply` |
| R5 | GreptimeDB ledger efficiency + honest health | per-session chain-tip LRU + emit serialisation (no forks); bounded `lastHash`, brief and SSE reads; `substrate_health` write probe folded into `eventsWritable`; `capacity.ledger`; opt-in `SUBSTRATE_LEDGER_TTL` (ALTER only on difference, `UNSET` to roll back) | chain cache 0; probe 0; TTL unset |
| R6 | RAGFlow docs plane | client aligned to the documented HTTP API shapes (multipart upload, parse, list status, delete, retrieval knobs) with the fake enforcing them; versions/pins persisted (state file v2) so citations carry real commits; dataset-list + `docs-search` caches; opt-in superseded-document prune; `POST /docs/merge-trigger` → 202 + background job (`?wait=1` keeps sync); unit sets the state file | prune off; knobs = RAGFlow defaults |
| R7 | VPS guardrails | `substrate.slice` + per-unit `MemoryHigh/Max`, `TasksMax`, `CPUQuota`; `deploy-release.sh` free-disk floor + store-aware health gate; loopback redis drop-in config; in-process audit-chain rollover with `bun run audit:verify` across segments; `docs/runbooks/disk-pressure.md` | rollover unset; gate `SUBSTRATE_HEALTH_REQUIRE_STORES=0` |

## Green-check evidence (final head)

- `bunx tsc --noEmit` clean · `bun test` **3525 pass / 65 skip / 1 fail** (recorded F-01, identical on `main`) · `bun run check:phase-close` pass (EVENT_KINDS 12, SURFACES 27, 4 locks) · `bun run test:py` 298 pass.
- Rehearsal twin (scratch Postgres 16 + GreptimeDB v0.14.4, loopback): `rehearsal smoke` 4/4; `/brief` ETag → 304 in 8 ms; ledger container paused → brief 200 in 1.21 s marked `degraded`/`recent actions`, breaker open after 5 timeouts, emit 503 in 5 ms (`circuit open; retry in 30 s`), `/healthz` 503 with `eventsWritable:false`; after unpause breaker closed, brief `complete` in 16 ms, `plane.greptime.availability` breached 63 % over 30 samples; `capacity.index`/`capacity.ledger` live; sweep dry-run deleted nothing; `audit:verify` ok.
- Secrets/hostname scan of the diff against `main`: no credential value, no Railway/tailnet hostname.
- CI on the PR (self-hosted runner, scratch Postgres 16) caught what the pure tests could not: the two-phase sweep passed its picked ids as `$1::jsonb`, which makes Bun's driver JSON-encode the JS string into a JSON *string* scalar (`cannot extract elements from a scalar`, 22023); `$1::text::jsonb` types the parameter as text first. Reproduced and fixed against a local scratch Postgres; the DB-backed `index-store.sweep.test.ts` now runs green locally with `SUBSTRATE_TEST_PG_URL` set.
- The same CI run failed `http.test.ts` "the audit record carries keys plus digest only" once at 2,013 ms: the runner shares this host with a concurrent local `bun test`, and `desktop_run`'s host-wide lock is a fixed loopback port (`DESKTOP_LOCK_PORT` 45931, D30-21), so the CI run was refused as busy after the 2 s identity wait. Production's audit shows no `desktop_run` in that window. Not a code defect of this series; avoid running the full suite on the VPS while its own CI test job is running.

## What the operator does next

1. ~~Merge lands → `infra/vps/deploy-release.sh`~~ **Done 2026-10-13T21:02Z** at the operator's request: tag `release-20261013-91487e7`, the six running units' files replaced (`Slice=substrate.slice` + ceilings; `substrate-mcp` also gains the retain-outbox and docs-state `Environment=` lines) with `substrate.slice` installed, previous unit files kept under `/root/substrate-units-backup-<ts>/`; the script's gates passed (26 GB free, `index`/`eventsWritable` true, no open breaker) and `previous → ff71394` is the rollback (`deploy-release.sh rollback`). Not restarted: `substrate-dispatcher` and `substrate-host` take their ceilings at their next restart; `substrate-skills-{bridge,sync}` unit files were left as installed (the repo versions need `/etc/substrate/substrate-bridge.env` and `substrate-skills-sync.env`, Phase 22 operator steps). The index-sweep timer and the redis drop-in stay opt-in (step 3).
2. Read `/slo` (`brief.p95`, `plane.*.availability`) and `/healthz` (`planes`, `capacity`, `ledger`) after a day; fill the day rows in BASELINES.md. The T+5 min readings are there already, with the finding they produced: every production brief was `degraded` because `openGraphs` was N+1 over the Railway proxy — fixed in the follow-up on `ultrathink/uplift-2-deploy` together with `parity:check`'s `substrate.slice` expectation; deploy that tag the same way.
3. Opt-ins when wanted, each reversible: `SUBSTRATE_INDEX_SWEEP=apply` after a Railway volume snapshot (runbook), `SUBSTRATE_LEDGER_TTL=180d` after the export step (`docs/greptime-ledger.md`), `SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1`, `SUBSTRATE_AUDIT_ROLLOVER_BYTES`, the redis drop-in.
4. Env hygiene surfaced by recon (outside this repo): set `HINDSIGHT_BANKS`, drop legacy `HINDSIGHT_BANK`, decide the Railway Dragonfly keep/decommission, prune docker/containerd (~25 GB), remove the historic `substrate.env.bak-*` copies.

## Explicitly out of scope (recorded)

Backlog from PROPOSAL.md: per-surface rate limiting, `tenant=swc`, tiered memory/context budget (programming-desk side), RAG golden-question harness. Live RAGFlow and Hindsight proofs (Phase 25/26 G1–G4) stay operator-gated; the forwarder cutover (D-T6) is the operator's networking task.
