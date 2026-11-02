# Phase 78 summary: cross-layer reconciliation

Status: executed. Verification `human_needed` (`78-VERIFICATION.md`, fourth pass at HEAD cb56ec2a): must-have 2 VERIFIED, must-have 1 PRESENT_BEHAVIOR_UNVERIFIED. This summary was written by hand as a manual fallback; see Deviations.

Branch `gsd/v18-p78-reconcile`, base `0a1f7c68` (the integration tree with phases 73, 75 and 76). Commits: `3ad7bc12` the feature, `1e592b8c` first-pass fixes, `16513b53` failed-flush count and timer test, `cb56ec2a` failure-path tests. Not merged into `gsd/v18-int-73-75-76`; that is an owner decision.

## What was built

- `packages/mcp-server/src/reconcile.ts`: pure comparators. Leases compare by identity only (surface, session, epoch); expiry and heartbeats are excluded. Memory writes compare both ways over the window. Generation orphans compare `gen:graph:<id>` keys against `graph_index`. `buildReport` never returns clean when any layer is truncated.
- `reconcile-read.ts`, `reconcile-run.ts`: ledger and index readers with caps (`ledgerRows` 500, `ledgerLookups` 200, `indexRows` 5000, `cacheKeys` 10000). Truncation is reported, not hidden.
- `reconcile-repair.ts`: a plan record (`substrate.reconcile.plan.v1`) with a findings digest. Dry run is the default. A digest mismatch or a live orphan the plan does not name refuses the run. Execute flushes `substrate:v1:*` only, and counts each batch as it is removed.
- `reconcile-main.ts`, `scripts/reconcile.ts`: the CLI. The only place that builds the Greptime client and the index store for this feature, which the store-lock test requires. Exit codes are in `docs/reconcile.md`.
- `cache.ts`: `scanKeys` (reports `truncated` when the cache is off), `unlinkKeys(keys, onBatch?)`.
- `service.ts`: an unref'd timer behind `SUBSTRATE_RECONCILE_INTERVAL_S` (default 0, off). Each tick runs one read-only report and writes one log line.
- `config.ts`, `flag-registry.ts`, `.env.example`, `docs/config-reference.md`, `docs/reconcile.md`, the `reconcile` package script.

## Verification history

- Pass 1: `gaps_found`. BLOCKER: `readLedgerLatestLeases` used `latest ??= transition.hold`, which also replaces `null`, so an older grant overwrote a newer release and a freed node matched the index. A false clean that every gate missed, because no test covered it. Fixed; regression test added.
- Pass 1 also found: a failed flush recorded `repaired: 0` after batches were removed; plan items were not checked against the live report; the CLI had no tests; the timer had no test.
- Pass 2: `human_needed`. Fixed the flush count (callback), the plan gating tests, the timer gate test and the doc exit codes.
- Pass 3: `human_needed`, unchanged, with the failing-scan branch listed as untested.
- Pass 4: `human_needed`, final. Failing-scan and failed-flush CLI tests added; no new findings in the code.

## Decisions carried from the context

- D78-5, H4: the repair is a whole-prefix flush of `substrate:v1:*`, not a targeted delete. Deleting a generation counter alone can revive a stale answer. Recorded as a design decision in `docs/reconcile.md`.
- D78-7: the timer is off by default; a tick writes only its log line.
- The ledger and the index are never repaired.

## Deviations

- Records were written as a manual fallback: the phase summary is hand-written, and the STATE and ROADMAP edits are a manual fallback to the GSD workflow (approved by the owner; recorded as Run 16 in STATE.md).
- The verification record itself was produced by the real gsd-verifier procedure, through a subagent, and its self-check was run each time.
- The scheduled timer lives in `service.ts`, not in a separate module.
- The flags were documented after their example lines were added to `.env.example`.
- The lookup cap and the failure-path result file were added during execution after pass 1.
- A CLI test uses the bracket form `env["GREPTIME_URL"] = ...` to pass the no-secrets scan; the value is loopback. The same form is used in `anchor-run.test.ts`.
- The gate run for the first final tree was voided by a full root filesystem (see Run 16 in STATE.md); the same tree was re-gated green.

## Open, human

1. Scheduled tick on a clean fixture: one `clean:true` line, no ledger, index or cache write, single-flight. No test calls the tick.
2. Cache-off scheduled counts read 0, not absent. A design decision for the owner.
3. Live Dragonfly SCAN and UNLINK at production key counts (H5).
4. Live GreptimeDB `queryEvents` for lease kinds in a busy window.
5. Live CLI run with real stores: exit codes and the result file.
