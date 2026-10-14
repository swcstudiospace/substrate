# Uplift 01 SUMMARY — Gate verdicts as events (memory plane)

**Graph:** `ut-mv5r71hp-65f7b012` · **Plan:** `01-PLAN.md` · **Refs:** SPE-10477, SPE-5056 · **Date:** 2026-10-12

## What shipped

Every `memory.write` governance verdict now lands on the ledger through the **one** existing emitter, `service.ts` `auditMemoryWrite`:

- `accepted` (verified) → `note`, summary `memory.write accepted: <kind> at <scope>` — previously accepted writes left **no** ledger trace; this was the real delta.
- `conflict` → `note`; `quarantined` / `denied` → `warning` — unchanged semantics, already shipped by the v1.3 audit.
- Payload: `{ outcome, reason?, scope, kind, strategy?, review_id?, quarantine_id? }`; redaction at source; unknown writer surface → stderr-only trail; emission is fail-open and never fails the write.

Registered as four typed event sources (`memory.write.accepted/conflict/quarantined/denied`, kind note/note/warning/warning, surface rule `memory-writer`, no action column — the payload carries no `action`), with `docs/event-vocabulary.md` rows inside the locked markers.

## Deviations from the plan, and why

1. **One emitter, not a gate-level emitter.** The first implementation added a parallel `emitVerdict` inside `memory-write.ts`; inspection showed `auditMemoryWrite` already emitted conflict/quarantined/denied — a second path double-emitted and broke `service.test.ts`'s exactly-one-event assertion. Reverted the gate-level path; the service audit was extended to accepted instead. The gate stays pure decision + store.
2. **ADR S5 scope clarification (recorded for the operator).** ADR 0001 §S5 (SPE-5056) is about **swarm SDLC gate verdicts** (quality/review/security conjunction, `tool.call` for drift visibility) — a different, larger feature than this item. PROJECT.md's next-goal line motivated this item; what ships here is the memory-governance trail completion (accepted-visibility), not S5 proper. The swarm-gate S5 remains operator backlog; this item does not claim it.
3. **Accepted sample carries no `reason`.** A plain acceptance has none; the sample tests the common case (recovered-orphan acceptances can carry a reason, and the emitter spreads it when present).

## Volume note

One extra `note` per accepted memory write (memory writes are governed, human-scale operations — consistent with the per-call notes `skills.propose` / `docs.*` already emit). Bounded by the write path itself; no periodic sources added.

## Verification (exercised)

- `bun test packages/mcp-server` — **0 fail** (1921 tests; new: accepted emits exactly one note without entry text; unknown-writer acceptance emits nothing; conflict note carries reason; quarantined warning carries `quarantine_id`)
- `bun run check:phase-close` — **pass** (4 lock files green; EVENT_KINDS 12; SURFACES 27)
- `bunx tsc --noEmit` — clean
- Full `bun test` — 1 fail = the recorded F-01 environment-sensitive guard only
- Secrets scan over the diff — one explained hit (planted fixture `ghp_aaaa…` in a leak test)

## Deferred / surprises

- Surprise: S5's ledger-visible-gates intent was already ¾ met by the v1.3 audit for the memory plane; the honest gap was accepted-verdict invisibility.
- Not done here: ADR S5 swarm-gate verdicts (cross-repo, agent-swarm) — remains operator backlog.
