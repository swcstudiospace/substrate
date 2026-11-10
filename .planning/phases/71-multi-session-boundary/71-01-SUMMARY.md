---
phase: 71-multi-session-boundary
plan: "01"
status: locally-verified-awaiting-quality
requirements: [HARD-S1]
verification: local-passed-external-quality-pending
---

# 71-01 Execution Summary

**Parent verification update:** Local implementation and exercised acceptance passed. The authoritative current evidence and remaining external sign-off are in `71-VERIFICATION.md`; earlier unexecuted notes below describe the edit-only handoff, not the final local outcome.

**PLAN COMPLETE — code production only; no runtime acceptance or Phase 71 completion claim.**

## Implemented

- Added the seven-method `LiveSessionAuthority` and real transactional Bun SQL adapter in the existing steering-session storage module. After the integration owner removed the legacy registry's last production consumer, removed its dead restart-cache factory/port/adapter rather than retaining an unused compatibility layer. Historical cache rows never grant authorization.
- Added `IndexStore.liveSessions({ leaseSeconds })` over the existing pool and mandatory additive migration **42**, `live_session_bindings`. Migration 42 has no opt-in, no cache/ledger backfill, a global identity primary key, durable hash-only binding, canonical state, SQL timestamps, permanent terminal records, and active owner/repository/identity listing indexes. No earlier migration SQL was changed.
- Issuance independently draws two 32-byte values, binds only the domain-separated SHA-256 proof hash, uses insert/conflict-do-nothing with at most four fresh-pair attempts, and returns the one-time proof only after transaction commit. SQL/entropy/commit errors return the sanitized unavailable result.
- Reads and mutations query SQL, lock the target row, then fetch `clock_timestamp()` in a **separate statement after lock acquisition**. Owner-proof ordinary transitions/heartbeat renew the lease; reads/operator queue/operator acknowledgement do not. Repo/owner/issued identity cannot be changed. Expired/closed targets refuse; close commits a retained tombstone and returns the committed SQL `closedAt`.
- Discovery applies active/lease/owner/repository/cursor filters before SQL limit. Both discovery methods return metadata only, including for operators. Operators can separately obtain a private snapshot through an explicitly authorized targeted read; optional private discovery fields are **not** implemented or claimed.
- Added reasoned legacy logical-archive exclusion: the closed compatibility hash is preserved; this is **not backup coverage**. Complete PostgreSQL-native backup must include terminal security rows. Documentary down destroys non-reuse evidence and is not an automatic rollback action.
- Added deterministic driver-boundary unit tests; a complete issuance-only deterministic integration fixture; and guarded PostgreSQL tests using two independent pools/factories, reconnect, migration-twice, wrong/absent proof, canonical state, transition races, close races, post-lock SQL-time expiry, active/tombstone collisions, filtered pagination, actual legacy-schema rows that cannot grant/revive identities, committed-but-lost responses, and disconnected-pool failure.

## Export contract for 71-03 / 71-04

New product exports from `planning/steering-sessions-store.ts`:

- `LiveSessionCaller = { surface: Surface | null; isOperator: boolean }`.
- `LiveSessionAccess = { caller: LiveSessionCaller; sessionId: string; sessionBinding?: string }`.
- `LiveSessionOperation = "private-read" | "owner-transition" | "heartbeat" | "close" | "operator-queue" | "operator-ack"`.
- `LiveSessionSnapshot = { session: SteeringSession; ownerSurface: Surface; issuedAt: string; expiresAt: string }`. No proof/hash.
- `LiveSessionMetadata = { session_id; surface; repo_id; state; updated_at; expires_at }`. No free text/hash/counts.
- `LiveSessionFailure = { ok: false; error: { code: "not-found" | "session-unavailable" } }`.
- `LiveSessionResult = { ok: true; snapshot: LiveSessionSnapshot } | LiveSessionFailure`.
- `LiveSessionIssueResult = { ok: true; snapshot: LiveSessionSnapshot; sessionBinding: string } | LiveSessionFailure`.
- `LiveSessionCloseResult = { ok: true; snapshot: LiveSessionSnapshot; closedAt: string } | LiveSessionFailure`. Close snapshot excludes private text. `closedAt` comes from committed SQL, not a client/local clock. Repeat close is not-found.
- `LiveSessionTransitionResult = { ok: true; snapshot: LiveSessionSnapshot; previous?: SteeringSessionState } | LiveSessionFailure | { ok: false; error: { code: "invalid-transition"; reason: string } }`. Invalid-transition is returned only after binding authorization; a different repo is not-found.
- `LiveSessionInput = { repoId: string; state: SteeringSessionState; steering?: string; planningHash?: string }`.
- `LiveSessionListQuery = { repoId?: string; limit: number; cursor?: string }`. Limits are integer 1..200; cursor is the exact `ls_` plus 64 lowercase hex identity. Ascending identity keyset order; no offset cursor.
- `LiveSessionListResult = { ok: true; sessions: LiveSessionMetadata[]; nextCursor?: string } | LiveSessionFailure`.
- `LiveSessionAuthority` methods:
  - `issue(input: LiveSessionInput & { caller }): Promise<LiveSessionIssueResult>`.
  - `read(access, operation): Promise<LiveSessionResult>`.
  - `transition(access, input: LiveSessionInput & { previousState?: SteeringSessionState }, operation): Promise<LiveSessionTransitionResult>`.
  - `heartbeat(access): Promise<LiveSessionResult>`.
  - `close(access): Promise<LiveSessionCloseResult>`.
  - `listVisible(caller, query: LiveSessionListQuery): Promise<LiveSessionListResult>`.
  - `listMetadata(query: LiveSessionListQuery & { repoId: string }): Promise<LiveSessionListResult>`.
- `bunLiveSessionAuthority(sql: SQL, { leaseSeconds, randomBytes? }): LiveSessionAuthority`. Random seam is test-only. Adapter accepts lease 1..86400 seconds to permit short controlled tests; production configuration is independently pinned to min60/default3600/max86400 in 71-03.
- `IndexStore.liveSessions({ leaseSeconds }): LiveSessionAuthority`.

The authority checks **target binding**, not the queue/ack effect policy. A nonoperator owner with proof can validate a queue/ack target; the shared boundary must then return operator-required403 before the effect. `transition(..., "operator-ack")` itself requires a trusted operator and never renews. Ordinary transition and heartbeat require owner+proof even for an operator. Trusted operators bypass owner/proof only for private-read/close/operator-queue/operator-ack, never existence/lease/terminal status. Caller and operation are trusted injection, not body fields.

New test-only exports from `planning/live-session.test-support.ts`:

- `TestLiveSessionAuthority` implements the whole port using deterministic issuance, hash-only proof checks, immutable owner/repository, canonical transitions, expiry, metadata policies, and retained close records. `advance(milliseconds)` controls its clock; `unavailable` injects outage. There is no put/import/reset/transfer grant API.
- `createTestLiveSessionAuthority({ nowMs?, leaseSeconds? } = {})` constructs it.
- `issueLiveSession(authority, input?: Partial<LiveSessionInput> & { caller?: LiveSessionCaller })` issues through the real port and returns successful issuance plus `sessionId` and ready-to-use `access`. Defaults: omp nonoperator, owner/name, ACTIVE. Integrations should provide their actual test caller/repository. Test-only imports must not enter product code.

## Evidence and restrictions

- Read the installed executor persona, full assigned plan, phase context/validation/research/prior-verification artifacts, applicable existing storage/migration/state/test patterns, and repository rules. Worktree briefing file is absent; parent already handled the primary briefing.
- Collected exported-symbol references using the installed TypeScript language service (mounted LSP was unavailable in this child): existing cache adapter/port, `MIGRATION_STEPS`, and `IndexStore.steeringSessions`. Re-collected references before the parent-requested dead-cache cutover: only storage and obsolete cache suites remained as cache consumers; `IndexStore.steeringSessions` had no caller. The parent/71-04 owns deletion of those obsolete suites.
- **No tests, builds, typechecks, linters, formatters, installs, codegen, git writes, SQL service connections, or runtime smoke checks were executed.** Tests described above are authored assertions, not observed passing evidence. No production effect occurred.
- Parent owns generation/appending of the migration-42 digest using the existing pure digest generator; this executor intentionally did not edit the digest JSON or handwrite hashes. Existing digest fixture will remain incomplete until that parent step.
- Service/server/MCP/integration/configuration/CLI files and ROADMAP/STATE/REQUIREMENTS were intentionally untouched; their real consumers and full end-to-end acceptance belong to subsequent assigned plans.

### Parent-requested dead-cache cutover

- Removed exported `SteeringSessionsStore`, `SteeringSessionsLoadQuery`, `bunSteeringSessionsStore`, and `IndexStore.steeringSessions()`.
- Demoted `StoredSteeringSession` and `storedSessionOf` to private implementation details still used by authoritative snapshot parsing. Retained exported pure `steeringSessionWithoutSecrets`, which the authority and shared integration fixture use.
- Kept migration 37 SQL, its opt-in history, every applied digest, the historical table, and logical-archive table compatibility unchanged. Updated only the historical table's explanatory archive exclusion, not schema or archive coverage.
- Replaced the new PG suite's deleted-adapter cache exercise with direct SQL on a connection-local historical schema fixture. The authority on that same connection must reject unissued legacy IDs and reject stale legacy rows naming an already-closed binding. There is no production legacy reader/writer shim.
- Obsolete registry/cache-only suite removal belongs to the parent/71-04 integration owner; these files were not edited here.

## Parent verification still required

After integration and parent digest generation:

```text
bun test --timeout 30000 packages/mcp-server/src/planning/live-session-authority.test.ts packages/mcp-server/src/planning/live-session-authority.pg.test.ts packages/mcp-server/src/index-store.migrate.test.ts packages/mcp-server/src/index-store.migrate-contract.test.ts
```

Controlled `SUBSTRATE_TEST_PG_URL` is required to exercise the PostgreSQL suites. Missing configuration produces skipped suites, not durability/race evidence. Parent must also run the integration/CLI/regression/type/lint gates in 71-VALIDATION.md and record actual results. No checker, Greptile, deployment, backup/restore, or overall-phase acceptance is claimed here.
