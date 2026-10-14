---
phase: 26-hindsight-recall-and-dragonfly-cache
verified: 2026-10-11T02:10:00Z
status: passed
score: 9/9 must-haves rehearsal-proven (fake-plane recall/retain/merge/cache); live G1-G4 OPERATOR-GATED
covered_files: [".env.example", ".planning/phases/26-hindsight-recall-and-dragonfly-cache/26-01-PLAN.md", ".planning/phases/26-hindsight-recall-and-dragonfly-cache/26-01-SUMMARY.md", ".planning/phases/26-hindsight-recall-and-dragonfly-cache/26-02-PLAN.md", ".planning/phases/26-hindsight-recall-and-dragonfly-cache/26-02-SUMMARY.md", ".planning/phases/26-hindsight-recall-and-dragonfly-cache/26-03-PLAN.md", ".planning/phases/26-hindsight-recall-and-dragonfly-cache/26-03-SUMMARY.md", "docs/data-planes.md", "docs/runbooks/hindsight-cache-proof.md", "packages/mcp-server/src/cache.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/hindsight-fake.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-recall.test.ts", "packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/memory-retain.test.ts", "packages/mcp-server/src/memory-retain.ts", "packages/mcp-server/src/memory-search.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planes/hindsight.test.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/store-lock.test.ts"]
covered_digest: "v3:sha256:1476e7cbe463b141bbff0fe16c7f4e0db6d0ec08d151d792e1c70cb0247f84ed"
behavior_unverified: 4
overrides_applied: 0
registration:
  previous_status: missing
  registered_at_tip: ed696ef
  digest_check: recall/retain/cache/hindsight sources byte-identical since PR #49 (059939ec); later additive diffs limited to index-store (+2), server (+21: phase-29 card routes), package.json — feature tests re-run green at tip (see confirmation below)
  gaps_remaining: ["G1 live reachability/version probe", "G2 live bank ensure + first recall", "G3 first live retain", "G4 live cache/topology change + DOCS-07 headless proof"]
---

# Phase 26 verification (provable-without-gates scope)

**Status:** rehearsal PROVEN. Live scope (G1–G4) explicitly gated out —
see OPERATOR APPROVAL NEEDED in the phase report.

## Proven without gates

- Recall contract: bounded fan-out over the explicit `sub-*` bank list
  (caller's bank first, one shared abort budget), at most 4 hits per bank,
  source-bank attribution, redacted hits framed derived with the
  untrusted-memory notice; empty-plus-reason errors, never a throw; reads
  emit nothing; the brief's compose path never imports the client
  (anti-pattern gate). Unlisted surfaces refused without shared-bank
  fallback; `pd-*` desk banks rejected at parse and resolve.
- Retain contract: only accepted plus verified_persisted plus sourced
  memories forward, redacted with refuse-on-finding, idempotent by
  subject-stable document identity (supersedes replace, appends keep the
  key); per-document acceptance-order chaining (a stalled older forward
  cannot overwrite its replacement); post-success generation bump (no
  stale recall window); refusal or failure warns locator-only;
  VM guests refused; unconfigured plane silent; forward never blocks the
  write; shutdown drains in flight retains bounded (10 s).
- Search merge: index entries first and unmarked, plane hits appended
  derived with scope locator; requested scope filters the plane leg;
  outage yields index-only with reason, never stored; merged shape caches
  under a shape-marked key (pre-upgrade bare lists never hit); paged
  search stays index-only (cursor integrity).
- Cache deltas: recall answers cache under memory-search class semantics
  (600 s, generation-bound, degraded never stored); claims-freshness pin
  via the accept-bump mechanism plus an end-to-end write-to-brief proof;
  plaintext non-loopback `redis://` refused fail-open (strict loopback
  IPv4, DNS names rejected) with off-with-reason health; guest recalls
  refused before the cache lookup.
- Substrate-only door: store-lock fails on Hindsight MCP wiring,
  out-of-package client imports, `HINDSIGHT_*` reads outside `mcp-server`,
  and committed plane endpoints or credentials (routing values exempt).
- `bun test`: 2843 pass / 58 skip / 1 fail (recorded F-01 rehearsal-harness
  env failure, unchanged from baseline).
- `bunx tsc --noEmit`: clean. `pytest`: 230 passed. Phase-close check:
  pass (4 lock files green, EVENT_KINDS 12, SURFACES 27).
- Greptile: 3 review rounds (13 + 5 + 5 findings); every actionable item
  fixed with proof tests (freshness bumps, degraded no-store, scope
  filtering, stable identities, shape-marked keys, created flag, strict
  loopback, guest refusals, write-path claims proof, bodyless 204,
  health reasons, bank namespace, shutdown drain, forward ordering);
  round-3 findings re-emitted already-fixed items verbatim with no new
  findings (disposition with file-line evidence posted on PR #49).

## Gated out (NOT proven, NOT run)

G1 first live reachability/version probe; G2 live bank ensure plus first
live recall; G3 first live retain of a gate-accepted memory; G4 any live
cache/topology change plus the DOCS-07 headless proof
(`docs/runbooks/hindsight-cache-proof.md` holds each gate's proof read
and rollback).

## State flip

Verification state for the rehearsal scope is flipped via gsd-tools by the
executing agent after merge; the live G1–G4 tail remains `OPERATOR-GATED`
in STATE.md until the operator completes the runbook.

---

## Close-out sweep tip confirmation (2026-10-11, HEAD `ed696ef`, PR #53 merged)

Recall/retain/cache/hindsight sources byte-identical since PR #49 (`059939ec`); later
additive diffs limited to `index-store.ts` (+2), `server.ts` (+21 card routes),
`package.json`. Feature tests re-run at tip (`memory-recall + memory-retain + cache +
planes/hindsight`, inside the 272-test 25/26/29 run): **all green, 0 fail**. Full
`bun test` 3136 pass / 58 skip / 1 fail (F-01 only), `bunx tsc --noEmit` clean, pytest
246 passed, `check:phase-close` pass. Live G1–G4 (+DOCS-07) stay OPERATOR-GATED — never run.
