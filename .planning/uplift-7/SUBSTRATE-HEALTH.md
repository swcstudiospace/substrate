# Agent Substrate health (SUBSTRATE_HARDENING, uplift-7)

Date: 2026-10-15. Basis: a read-only baseline of the code (shared access layer `packages/mcp-server/src/service.ts:956`, the `Substrate` class), read-only live checks against the running service on loopback, and the fixes in PR 72. Each row says what was observed and how it was judged. Items that were not read are UNKNOWN.

## Live status (read-only)

- Planes: greptime, index, cache, hindsight, ragflow all report ok, with breakers closed.
- Ledger: writable, about 27,960 rows. Anchors: 0 rows, so no hour has ever been anchored.
- Cache: 74 hits and 477 misses.
- Services active: substrate-mcp, the herdr, muse, and grok collectors, the dispatcher, the Hermes bridge, and the connector units. The skills sync and bridge timers are installed but disabled.
- Disk: `/` is 95% used, with 22 GB free.

## Six categories

| Category | Store | Interface | Status |
| --- | --- | --- | --- |
| Memories | Postgres `memory_entries` and related tables (`index-store.ts`) | REST `/memory`, `/memory/recall`, `/brief`; MCP `memory_write`, `memory_search`, `memory_recall` | Works. Gaps below. |
| Routines | none | none | MISSING. No store, route, tool, or CLI. |
| Skills | Postgres `skills_registry` | REST and MCP propose, approve, list; CLI `substrate skills` | Works. No version check. |
| Tools | none; code-registered MCP tools (`mcp.ts`) | MCP `tools/list` | Declared in code only. No data read route. |
| Documentation | RAGFlow datasets; ingest state file | REST and MCP `docs_search`, `docs_ingest`; CLI | Works. No version check. |
| Lessons | `memory_entries` with `lesson:` subjects; no table | CLI `substrate lessons`; `/memory`; `memory_search` | Works. Supersession and dedupe are partial. |

## Findings

| # | Finding | Evidence | Judgment | Action |
| --- | --- | --- | --- | --- |
| 1 | An oversized `POST /memory` body returns a generic 500, not 413. | `server.ts` body-limit notes near 247–252; generic catch near 1499 | FAIL (confirmed by reading code) | PR 72: 413 with the existing shape, plus a test |
| 2 | Memory text longer than 4000 characters is cut silently, and the reply still says `accepted`. | `memory-write.ts:499` | FAIL (confirmed by reading code) | PR 72: additive `truncated: true` and `limit: 4000`, plus tests; the cut itself is unchanged |
| 3 | Routines have no category at all. | Baseline §2 | MISSING | Decision: report the gap only (default for q3) |
| 4 | Tools have no storage; their schemas and permissions exist only in code. | `mcp.ts:207–1194` | Expected by design | No action |
| 5 | `agent:<surface>` memories never reach the brief, and `memory_search` has no caller-surface check. | `index-store.ts:2045–2049`; `service.ts:2114–2116` | PARTIAL. Access intent is unclear. | Decision: is cross-surface readability intended? |
| 6 | Skills have no expected-version check. Content-hash upsert is first-writer-wins. | `index-store.ts:1839–1844` | PARTIAL | Gap: a version column and compare-and-set |
| 7 | Docs ingest has no expected-version check. | `docs-ingest.ts:371–401` | MISSING | Gap, same mechanism |
| 8 | Lessons: supersession exists only in the read-side digest; duplicates are caught by key only. | `lessons.ts:286–300` | PARTIAL | Gap: a subject-level versioned write for `fact`, or a documented rule |
| 9 | Corrupt-record handling for memory and skills rows is not guarded. `toSkillRow` is unguarded. | `index-store.ts:2524` | UNKNOWN for memory; FAIL-candidate for skills | Test needed |
| 10 | Isolation of the live skills and docs tests was not read. | not read | UNKNOWN | Check needed |
| 11 | The devnet anchor has never run. The key is unfunded, the timer is not installed, and the table is empty. | live checks; v1.3 audit ANCHOR-06 | BLOCKED on operator steps | SOLANA-FEASIBILITY memo |
| 12 | 43 live behaviors are still operator-gated. | v1.3 audit | HELD | Operator |

## Check families (summary)

- Round trip: supported for memories, skills, docs, and lessons. Routines missing.
- Isolation: supported where live tests use per-run markers. Skills and docs isolation UNKNOWN.
- Category rules: redaction is supported for memories and skills. Docs refuse secrets rather than redact. Routines N/A.
- Cross-agent handoff: attribution is supported; visibility is PARTIAL (finding 5).
- Concurrency: supported for memory decisions with `expected_version`. Missing for skills and docs.
- Failure modes: substrate-down returns 503, crash-mid-write has orphan recovery for memory, and malformed payloads are refused. Oversize is partial (findings 1 and 2). Corrupt records are UNKNOWN (finding 9).

## Test and check commands (discovered; not run in this step)

- `bun test` (live index tests run when `SUBSTRATE_TEST_PG_URL` is set).
- `bunx tsc --noEmit`.
- `bun run check:phase-close`.
- `bun run smoke:skills-propose`, `bun run smoke:skills-sync`, `bun run docs:golden`, `bun run rehearsal`, `bun run gate:boot`.

## Decisions requested at closeout

- Routines: keep as a reported gap (default) or build a category (scope change).
- Cross-surface memory readability (finding 5).
- Expected-version for skills and docs: gap, or build.
