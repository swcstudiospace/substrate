# Uplift 03 SUMMARY — Host re-adopts running VMs after restart

**Graph:** `ut-mv5r71hp-65f7b012` · **Plan:** `03-PLAN.md` · **Refs:** SPE-10477 · **Date:** 2026-10-12

## What shipped

- **Sandbox state store** (`tasks.ts` `SandboxStateStore`): one 0600 JSON file (`SUBSTRATE_SANDBOX_STATE` override, else `<RIVETKIT_STORAGE_PATH||/var/lib/substrate/agentos>/sandboxes.json`) mapping sandbox id → `{graph_id, node_id, task, opened_at}`; atomic tmp+rename; every operation best-effort (failed write = one stderr warning, never a task failure). `substrateDocker.create()` records the id only after a successful start; `destroy()` forgets on both the normal and AutoRemove/404 paths.
- **Boot reconciliation** (`tasks.ts` `reconcileSandboxes` + `main.ts` wiring): the old D-04 blanket sweep (which force-removed every host-labeled container including in-flight tasks') is replaced. Before serving, the host enumerates ALL live containers via the new provider `listSandboxes()` (dockerode `listContainers({all:true})`) and classifies each against the state file:
  - host-labeled + state entry + live unreleased task → **re-attached**: the record stays in flight so the existing D-07 `resumeInterrupted` pass sends the continuation and rearms the heartbeat (mechanism reused, not duplicated);
  - host-labeled but unknown to state → **terminated**, one `warning` event `{action: "host.orphan", sandbox_id}`;
  - unlabeled/foreign → stderr note only, never touched; stale entries whose sandbox vanished are dropped (phantom hygiene).
  - Enumeration failure → one stderr warning, boot proceeds (fail-open); per-container terminate failure logs and continues; the function never throws.
- Constraint disclosed: rivet constructs the provider per graph inside `vm.ts` (outside this item's file scope), so the provider learns only `graph_id`; `node_id`/`task` are written null and re-attachment joins on `graph_id` via the existing `taskFor`. The schema carries the richer fields for callers that know more.

## Deviations from the plan

- Reconciliation source is **provider enumeration** (docker listContainers all:true), not state-file probing — the plan offered either; enumeration is what lets foreign/unlabeled containers be reported at all. The state file is the join key, not the source of truth.
- `vm.ts`/`options.ts` untouched (plan anticipated options.ts only if config lived there — it did not).

## Verification (exercised)

- `bun test packages/host` — **244 pass / 0 fail**: known running labeled sandbox re-attached (resume continuation asserted via the reused harness); labeled/test-run-labeled orphans terminated with exact `host.orphan` payloads; released-task stale entry dropped; exited known sandbox not re-adopted; foreign container only reported; enumeration failure boots clean; 0600 round-trip; AutoRemove-path forget.
- `bunx tsc --noEmit` clean; full `bun test` 3179 pass / 1 fail (recorded F-01 only).
- A corrective pass fixed three test-fake/harness breaks the first pass left (missing `listContainers` members, a non-async harness with `await`, a nonexistent result property) — root cause was test code; product code needed no changes.

## Deferred / surprises

- The first pass's runtime error masked its whole test file — caught only because the orchestrator re-ran the gates (per contract).
