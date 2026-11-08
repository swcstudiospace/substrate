# Phase 46, criterion 4: in-repo part (run 20, 2026-11-08)

Decision: D46-6 (user, 2026-11-08). The comparator is delivered fixture-tested. The live PARITY_GATE stays a validation request.

## Delivered

- `packages/mcp-server/src/lightrag-parity.ts`: the pure `checkParityGate` function.
- `packages/mcp-server/src/lightrag-parity.test.ts`: 19 behaviour tests.

Rules:
- The record check is multiset-based. It reports `missing` and `unexpected` documents, keyed by dataset, source URL and version.
- The query check needs exactly one answer per query. Cited sources must equal the expected set. A query with two answers is a miss.
- matchRate is matched divided by total. The gate passes only when the sample is non-empty, there are no record mismatches, and matchRate is at least `requiredMatchRate`, which defaults to 1.
- Malformed input throws a TypeError.

## Verification

- `bun test packages/mcp-server/src/lightrag-parity.test.ts`: 19 pass, 0 fail.
- `bunx tsc --noEmit`: exit 0.
- `bun run lint`: exit 0, 1722 files.
- The full suite was not re-run for this unit. It adds two isolated files and changes no existing code. The last full run was green at 66f06d15.

## Acceptance status

- In-repo comparator: met.
- Criterion 4 (PARITY_GATE): NOT MET. The live gate is pending, and it is gated:
  - T5, archive with checksum: operator approval.
  - T6, deploy and probe: operator approval.
  - T7, live PARITY_GATE run against the RAGFlow export.
- Phase 46 stays open. This file does not change the phase's verification record.
