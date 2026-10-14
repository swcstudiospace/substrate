# Uplift 03 PLAN — Host re-adopts running VMs after restart

**Graph:** `ut-mv5r71hp-65f7b012` · **Proposal:** `.planning/UPLIFT_PROPOSAL.md` §U2 · **Refs:** SPE-10477

## Scope (files)

- `packages/host/src/main.ts` — boot-time reconciliation call
- `packages/host/src/tasks.ts` — task-state persistence (0600 state file) + re-attach logic
- `packages/host/src/sandbox-provider.ts` — enumerate live sandboxes; terminate by id
- `packages/host/src/*.test.ts` — reconciliation tests with the fake provider

## Change

1. Task state gains a durable record (0600 file beside the lease record; same config idiom as the lease persistence) mapping sandbox/VM id → graph/node task, written when a task opens a sandbox.
2. On boot, before serving: enumerate live sandboxes from the provider; for each:
   - id in task state → re-attach: resume the task loop (heartbeat + continuation prompt path already exists for restart-survival)
   - id unknown but carrying the host's own label prefix (host-stamped label, e.g. `substrate-host/<boot-id>` on the container) → terminate, one `warning` event `payload.action: "host.orphan"`
   - unlabeled/foreign → report to stderr only, never touched
3. Reconciliation is best-effort: provider enumeration failure → proceed to serve with one stderr warning (fail-open boot).

## Acceptance (orchestrator-verified)

- `bun test packages/host` green incl. new tests: known sandbox re-attached; labeled orphan terminated with warning event; foreign sandbox only reported; provider-down boots anyway
- `bunx tsc --noEmit` clean; full `bun test` no new failures
