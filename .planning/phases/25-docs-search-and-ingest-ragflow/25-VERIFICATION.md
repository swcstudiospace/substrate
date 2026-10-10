# Phase 25 verification (provable-without-gates scope)

**Status:** rehearsal PROVEN. Live scope (G1–G4) explicitly gated out —
see OPERATOR APPROVAL NEEDED in the phase report.

## Proven without gates

- Retrieval contract: every retrieval carries explicit `dataset_ids`
  with `page_size <= 10` pinned on the wire; the fake 400s without them
  and the client throws pre-network (anti-pattern gate).
- Citation shape: at most 10 results with title, source URL, heading
  path, commit (dataset-pin fallback), redacted snippet <= 1,200 chars,
  score and ids; untrusted framing; URL-listing note event;
  empty-plus-reason errors. All returned text fields redacted.
- Ingest gates: all six refusals fail closed with locator-only warnings
  (body AND metadata scanned); remote images stripped and counted; hash
  idempotency keyed by dataset plus URL; concurrent retries serialize
  (divergent bodies recheck-then-upload); replacements report superseded
  ids; records persist across restarts (chained atomic saves).
- Dataset lifecycle: resolve-by-name, create-on-miss with TEI bge-small,
  last-five versions with monotonic numbers, warn-once
  `skills-sync-not-live` degradation with pin-aged serve.
- Substrate-only door: store-lock fails on RAGFlow MCP wiring,
  out-of-package client imports, and committed plane credentials.
- `bun test`: 2775 pass / 58 skip / 1 fail (recorded F-01 rehearsal-harness
  env failure, unchanged from baseline).
- `bunx tsc --noEmit`: clean. `pytest`: 230 passed. Phase-close check:
  pass (4 lock files green, EVENT_KINDS 12, SURFACES 27).
- Greptile: 12 review threads across two rounds, all addressed and
  re-reviewed green (metadata scanning, path normalization, record keys,
  upload serialization, superseded ids, restart persistence, body caps,
  parse budget, divergent retries, atomic saves, CLI timeout).

## Gated out (NOT proven, NOT run)

G1 first live reachability/version probe; G2 dataset
discovery/creation; G3 any real ingest; G4 any real search served to an
agent (`docs/runbooks/docs-proof.md` holds each gate's command, proof
read and rollback).

## State flip

Verification state for the rehearsal scope is flipped via gsd-tools by the
executing agent after merge; the live G1–G4 tail remains `OPERATOR-GATED`
in STATE.md until the operator completes the runbook.
