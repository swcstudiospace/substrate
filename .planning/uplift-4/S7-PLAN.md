# S7 RAGFlow: docs freshness SLI, trigger-lag detection and an opt-in live golden canary

Worktree `/root/src/repos/.wt/u4-s7`, branch `u4/s7`. Evidence: recon lane D (RAGFlow facts, candidate 3) and S7 in the uplift-4 proposal.

## Target
`docs-datasets.ts` (+ test), `docs-freshness.ts` (new) + test, `service.ts` and `server.ts` (small hunks), `slo.ts` (+ test), `scripts/docs-golden.ts` (+ test), `infra/vps/substrate-docs-canary.{service,timer}` (staged), `docs/docs-search-ingest.md`.

## Change
1. `docs.freshness_seconds{dataset}` from the persisted `versions[].ingested_at` (no RAGFlow call); gauge and `/slo` `docs.freshness` row; report-only `SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H` (168). Label from the configured dataset names only.
2. Per-dataset bounded list (last 20) of accepted triggers `{commit, content_sha256, received_at}` in the state file (additive optional member; old files load unchanged; bogus or oversized input ignored/truncated while reading). A dataset whose newest accepted trigger has no recorded version after `SUBSTRATE_DOCS_TRIGGER_LAG_MIN` (15) is `lagging`: gauge `docs.trigger_lag_seconds{dataset}`, SLO detail, one `warning` per dataset per breach (deduped through the state file), one `note` on recovery, never failing the trigger.
3. Live canary `bun scripts/docs-golden.ts --live --emit` plus staged `substrate-docs-canary.{service,timer}` (daily, disabled; needs `SUBSTRATE_DOCS_CANARY=1` and `SUBSTRATE_DOCS_CANARY_MANIFEST`, refuses by name otherwise). Loopback `POST /docs/search` as `omp`, scores sources and commit pins, prints a table, non-zero on regression, one deduped `warning`.
4. Docs: what the SLI does and does not prove, thresholds, canary procedure, rollback.

## Acceptance
Freshness math with an injected clock over several datasets; lag including a recorded version that clears it; warning dedupe (one on breach, none while it lasts, recovery marker once); old state file loads unchanged and a 10k-row trigger list is truncated while reading; the `/slo` row only with data; canary scoring with a fake fetch (pass, wrong source, missing commit pin, refused when not configured) with injected token directory; flag-off parity (no new keys in a state file when nothing was triggered).
