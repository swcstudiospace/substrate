# Phase 78: Cross-layer reconciliation - Plan

## Tasks

1. **Read the three layers.** Add `GreptimeClient.readEvent(id)` (payload included, by id), `IndexStore.memoryMarkers(ids)`
   (`superseded_by` per id, bounded by `MAX_FORGET_LOOKUP_IDS`), and `ReadThroughCache.readForgetMark()` (returns
   `disabled`, `absent` or `present` with its time, and throws when the read fails). No schema change.
2. **Reconcile core.** `cross-layer-reconcile.ts`: ports (`ReconcileLedger`, `ReconcileIndex`, `ReconcileCache`), the forget
   note reader, the ledger -> index and ledger -> cache judgements, the report, and `runScheduledReconcile`.
3. **Plan and apply.** `planRepair` (one `reconcile.plan` note, only on a complete read with items) and `applyRepair`
   (confirmation by plan id, stored-plan validation and digest, planned keys only, `reconcile.applied` note).
4. **Ledger adapter.** `ledgerFromSubstrate`: reads with payload, oldest first, a full page is truncated; writes through
   `Substrate.emit` on the reconcile's surface.
5. **Tests.** `cross-layer-reconcile.test.ts` with fakes for all three layers, recording writes.
6. **Docs.** A section in `docs/greptime-ledger.md`.

## Acceptance (from the phase brief)

- A clean run writes nothing (no ledger write, no index mark, no cache write).
- A planted mismatch is reported with its first key and the per-layer counts.
- Repair is refused without a confirmed plan id (no write of any kind).
- A repair with a confirmed plan applies only the planned keys.

## Roadmap criteria

1. A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run.
2. Repair is a separate confirmed step with a plan record, following the corpus delete rules.

## Out of scope

- Wiring the function into service startup or a systemd timer (the brief says no units).
- Index -> ledger judgement (no window to read it by; needs a schema decision).
- Hindsight plane deletion from a repair.
- Any change to ROADMAP.md or STATE.md.
