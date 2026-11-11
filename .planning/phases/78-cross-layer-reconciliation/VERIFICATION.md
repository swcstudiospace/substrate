# Phase 78: Cross-layer reconciliation - Verification

Commands and counts are from this session. Nothing was run against a live ledger, index or cache: every store is a fake.

## Criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run. | **Met** (forget pair) | `cross-layer-reconcile.test.ts`: "a clean run reports every layer and writes nothing" (layer counts exact; ledger writes, index marks and cache writes all empty); "a clean run plans nothing and writes no plan record"; "a planted in-force entry is reported with its first key and the per-layer counts" (first `mem_b`, `in-force`, forget id and note id; index `inForce 2`); "a missing cache mark is reported under the mark key" (first key `gen:forgotten`). |
| 2 | Repair is a separate confirmed step with a plan record, following the corpus delete rules. | **Met** | "a planned repair records one plan and changes nothing"; "apply without a confirmed plan id is refused and writes nothing" (four refused shapes, no write); "apply with a plan id that is not a stored plan is refused"; "apply refuses a note that is not a plan, and a plan whose items were altered after it was written" (digest mismatch); "apply marks the planned entries, leaves unplanned and superseded rows alone, and records what it did" (only `mem_b` marked, `mem_z` untouched, `mem_c` held by another forget kept, `reconcile.applied` recorded); "a planned entry another writer marks before the apply is skipped as raced"; "a repeat apply marks nothing new"; "an index write that fails stops the apply with its reason and no record". Corpus rules: scope ("a full window page is reported as truncated and plans nothing", "a forget note that names fewer entries than it touched is partial", key cap test), never overwrite, never delete, planned keys only. |

## Required test set (phase brief)

| Brief item | Test |
|---|---|
| Clean run writes nothing | "a clean run reports every layer and writes nothing" |
| Planted mismatch reported with its first key | "a planted in-force entry is reported with its first key and the per-layer counts" |
| Per-layer counts | "a clean run reports every layer and writes nothing"; "a planted in-force entry ..." (exact `layers` objects) |
| Repair refused without a confirmed plan | "apply without a confirmed plan id is refused and writes nothing" |
| Repair with a confirmed plan applies only the planned keys | "apply marks the planned entries, leaves unplanned and superseded rows alone, and records what it did" |

## Other behaviour covered

- Settle margin: "a note newer than the settle margin is not judged yet".
- Mark lifetime and cache states: "a cache mark older than the forget is stale"; "a forget older than the mark's lifetime is not checked"; "a disabled cache is not checked".
- Consistent states: "an entry a later superseder or another forget holds is consistent"; "an entry the index no longer has is absent".
- Failure values: "a layer that cannot be read is a failure with its reason"; "a rejected option is a programmer error".
- Plan not stored: "a plan that is not stored is reported, and nothing is repaired".
- Applied note not stored: "an applied note the ledger refuses is reported, and the repairs stay made".
- Ledger adapter: three tests (window read with payload and truncation; undecodable payload and bad ts; emit on the reconcile's surface).

## Results

- `bun test packages/mcp-server/src/cross-layer-reconcile.test.ts`: **29 pass, 0 fail**, 103 expect() calls (final run).
- `bunx tsc --noEmit` in `packages/mcp-server`: **exit 0**, run after the implementation and before the final test-only
  edits and the import-order change.

## Not run (narrow-test rule)

- Adjacent suites that exercise the three edited stores were not run: `cache.test.ts`, `greptime.test.ts`,
  the `index-store*.test.ts` suites, and the store-lock and flag-registry tests. The main agent should run them once.
- `biome` or other linting was not run.
- No live ledger, Timescale or Dragonfly check.
