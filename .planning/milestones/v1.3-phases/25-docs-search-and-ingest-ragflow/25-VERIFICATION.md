---
phase: 25-docs-search-and-ingest-ragflow
verified: 2026-10-11T02:10:00Z
status: passed
score: 9/9 must-haves rehearsal-proven (fake-plane retrieval + ingest gates); live G1-G4 OPERATOR-GATED
covered_files: [".planning/phases/25-docs-search-and-ingest-ragflow/25-01-PLAN.md", ".planning/phases/25-docs-search-and-ingest-ragflow/25-01-SUMMARY.md", ".planning/phases/25-docs-search-and-ingest-ragflow/25-02-PLAN.md", ".planning/phases/25-docs-search-and-ingest-ragflow/25-02-SUMMARY.md", ".planning/phases/25-docs-search-and-ingest-ragflow/25-03-PLAN.md", ".planning/phases/25-docs-search-and-ingest-ragflow/25-03-SUMMARY.md", "docs/data-planes.md", "docs/docs-search-ingest.md", "docs/runbooks/docs-proof.md", "packages/cli/src/docs.ts", "packages/mcp-server/src/docs-datasets.test.ts", "packages/mcp-server/src/docs-datasets.ts", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-search.test.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planes/ragflow.test.ts", "packages/mcp-server/src/planes/ragflow.ts", "packages/mcp-server/src/ragflow-fake.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/store-lock.test.ts"]
covered_digest: "v3:sha256:0c27835fde66900d50219bb5ad7d0253f90349975371f1541196cdbb270a0e93"
behavior_unverified: 4
overrides_applied: 0
registration:
  previous_status: missing
  registered_at_tip: ed696ef
  digest_check: docs_search/ingest/datasets/ragflow sources byte-identical since PR #48 (41cb616); phases 26/29 layered additive registrations onto shared mcp/observe/server — feature tests re-run green at tip (see confirmation below)
  gaps_remaining: ["G1 live reachability/version probe", "G2 dataset discovery/creation", "G3 real ingest", "G4 real search served to an agent"]
---

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

---

## Close-out sweep tip confirmation (2026-10-11, HEAD `ed696ef`, PR #53 merged)

`docs_search`/`docs_ingest`/`docs_datasets`/`ragflow` sources byte-identical since PR #48
(`41cb616`); later additive diffs limited to shared `mcp.ts`/`observe.ts`/`server.ts`
(phase-26/29 registrations). Feature tests re-run at tip
(`docs-datasets + docs-ingest + docs-search + planes/ragflow`, inside the 272-test
25/26/29 run): **all green, 0 fail**. Full `bun test` 3136 pass / 58 skip / 1 fail
(F-01 only), `bunx tsc --noEmit` clean, pytest 246 passed, `check:phase-close` pass.
Live G1–G4 stay OPERATOR-GATED — never run.
