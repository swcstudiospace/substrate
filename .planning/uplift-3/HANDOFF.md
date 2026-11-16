# Uplift 3 handoff — seven durability and policy improvements delivered

Branch `ultrathink/uplift-3` (graph `ut-mv78nh8v-aa49a98b`), merged through PR → CI → Greptile 5/5 → `ultrathink-ship`, then deployed with `infra/vps/deploy-release.sh` as uplift-2 was. Proposal and acceptance: [PROPOSAL.md](PROPOSAL.md); recon: [CONTEXT.md](CONTEXT.md); live numbers before and after: [BASELINES.md](BASELINES.md).

## The seven (one SUMMARY each)

| # | Item | What is live after deploy | Switch (default) |
|---|---|---|---|
| N1 | Runtime drift and jobs doctor | `bun run doctor:runtime` (table/JSON, exit 2 on drift); `substrate-doctor.{service,timer}` staged in `infra/vps/` | timer not installed; `SUBSTRATE_DOCTOR_EMIT` unset |
| N2 | Restart-durable SLO history, capacity runway, notifications | SLO checkpoint under `StateDirectory`, `/slo.history`, `/slo.capacity`, `breached` folds planes + burn | checkpoint on (path exists); `SUBSTRATE_SLO_NOTIFY` unset; `SUBSTRATE_INDEX_VOLUME_BYTES` unset |
| N3 | Per-surface admission budgets | token buckets per surface × class in the loopback redis, `substrate.admission.decisions`, `/slo.admission` | `SUBSTRATE_BUDGETS=shadow` (never refuses) |
| N4 | Memory lifetime enforcement | `expired`/`expires_at` tags on served entries, `substrate.memory.expired`, retain-forward refuses expired | `SUBSTRATE_MEMORY_EXPIRY=report` |
| N5 | Docs retrieval fan-out, metrics, golden harness | concurrent per-dataset retrieval under one budget, `degraded_datasets`, `substrate.docs.*`, `/slo.docs`, `bun run docs:golden` | `SUBSTRATE_DOCS_SEARCH_BUDGET_MS=4000` |
| N6 | Ledger coverage probe and verified archive | `substrate ledger coverage|archive|verify-archive`, `/healthz.jobs.ledger`; `substrate-ledger-archive.{service,timer}` staged | timer not installed; `SUBSTRATE_LEDGER_ARCHIVE_DIR` unset (archive refuses by name) |
| N7 | Grok connector contract | MCP `memory_brief` structured `etag`/`state`/`failed_sources`/`snapshot_at` + `if_none_match`, `substrate.brief.result`, `/slo.surfaces`, `bun run smoke:grok` | none (additive) |

## What the operator does next

1. **Deploy** (done in the same session when this file says so in BASELINES.md): tag on `main`, `SUBSTRATE_HEALTH_TOKEN_FILE=/etc/substrate/tokens/omp infra/vps/deploy-release.sh <tag>`; the gate still refuses below 5 GB free and on a non-writable store. Nothing else to install for the request path.
2. **Read the doctor and act on its rows**: `bun run doctor:runtime` from `/opt/agent-substrate/current`. Today it names the redis rollout debt (install `infra/vps/redis-substrate.conf` + the `redis-server.service.d` drop-in, README "Loopback redis"), the missing `substrate-anchor.timer` (BP-7; README "Hourly anchor job"), the two skills units still in `system.slice`, and the legacy `HINDSIGHT_BANK` key. Optional: install `substrate-doctor.{service,timer}` and set `SUBSTRATE_DOCTOR_EMIT=1` on its drop-in so drift lands on the ledger as `warning` events.
3. **Switch the policies when the shadow numbers look right**, each one env var and a restart: `SUBSTRATE_BUDGETS=enforce` after `/slo.admission` and `substrate.admission.decisions{decision=shadow_limited}` show the limits bite only where intended (per-surface overrides exist); `SUBSTRATE_MEMORY_EXPIRY=enforce` after `substrate.memory.expired{mode=served}` has been read for a few days (the sweep's `entries-ttl-*` classes then delete only under `SUBSTRATE_INDEX_SWEEP=apply` + `--apply`); `SUBSTRATE_SLO_NOTIFY=1` (and optionally `SUBSTRATE_SLO_WEBHOOK_URL`) once the checkpoint has an epoch ≥ 2; `SUBSTRATE_INDEX_VOLUME_BYTES` to the Railway volume size so `capacity.index.runway_days` starts judging after 24 h of samples.
4. **Archive before any ledger TTL**: mount an off-box path, set `SUBSTRATE_LEDGER_ARCHIVE_DIR` on the archive unit's drop-in, install and enable `substrate-ledger-archive.timer`, run `bun run ledger:coverage` and `substrate ledger verify-archive <dir>`; only with every expiring day verified set `SUBSTRATE_LEDGER_TTL` (`docs/greptime-ledger.md`, "Coverage and archive").
5. **Grok gateway adoption** (programming-desk, outside this repo; `docs/grok-bot.md` lists the steps): send `if_none_match` / `If-None-Match` from the stored ETag, propagate `X-Substrate-Brief`, route docs through substrate `docs_search`. `bun run smoke:grok` (grok-bot bearer from `SUBSTRATE_TOKENS_DIR`) is the contract check; exit 0 is green.

## Rollback

Every item is a flag or an uninstalled unit: `SUBSTRATE_BUDGETS=off`, `SUBSTRATE_MEMORY_EXPIRY=report`, `SUBSTRATE_SLO_NOTIFY` unset, `SUBSTRATE_SLO_CHECKPOINT=off`, `SUBSTRATE_DOCS_SEARCH_BUDGET_MS=0`; the doctor, archive and smoke scripts are inert unless run; the MCP brief fields are additive. Code rollback is `infra/vps/deploy-release.sh rollback` (previous release kept), the unit files unchanged by this series.

## Explicitly out of scope (recorded)

Backlog from PROPOSAL.md: Hindsight outbox gauges + bank inventory, cache miss coalescing, chaos smoke in CI, usage/spend views, recall-to-brief snapshot, snapshot-gated sweep apply, lifecycle purge, `tenant=swc`, the gateway docs cutover. Live RAGFlow (retired) and Hindsight proofs (Phase 25/26 G1–G4) stay operator-gated.
