---
phase: 27-ledger-primitives-and-ingest-order
reviewed: 2026-10-10T00:00:00Z
depth: standard
files_reviewed: 21
files_reviewed_list:
  - packages/ledger/src/merkle.ts
  - packages/ledger/src/memo.ts
  - packages/ledger/src/period.ts
  - packages/ledger/src/rpc.ts
  - packages/ledger/src/solana.ts
  - packages/ledger/src/index.ts
  - packages/ledger/src/merkle.test.ts
  - packages/ledger/src/memo.test.ts
  - packages/ledger/src/period.test.ts
  - packages/ledger/src/rpc.test.ts
  - packages/ledger/src/solana.test.ts
  - packages/mcp-server/src/greptime.ts
  - packages/mcp-server/src/service.ts
  - packages/mcp-server/src/greptime.test.ts
  - packages/mcp-server/src/service.test.ts
  - packages/mcp-server/package.json
  - scripts/greptime-smoke.ts
  - docs/greptime-ledger.md
  - README.md
  - bun.lock
  - .planning/phases/27-ledger-primitives-and-ingest-order/27-CONTEXT.md
findings:
  critical: 0
  warning: 0
  info: 5
  total: 5
status: issues_found
---

> Recovered 2026-10-29 from an uncommitted worktree of branch swarm/v13-autonomous-integration (HEAD 76a4b2c3).
> Written 2026-10-11 to 2026-10-12 during the v1.3 autonomous integration; it describes that run and was not re-verified against main.
> Its paths and line references point at the 2026-10-11 tree, not at main.

# Phase 27: Code Review Report

**Reviewed:** 2026-10-10
**Depth:** standard
**Files Reviewed:** 21
**Status:** issues_found (0 critical / 0 warning / 5 info)

## Summary

Static-only review (no tests, builds, or runtime commands per assignment contract) of the Phase 27
commit `67cd428` (ANCHOR-01, ANCHOR-02) against its four plans, CONTEXT decisions D27-01–D27-23,
and the current worktree. Because HEAD (`4df30a0`) layers Phase 28 on top, scope was isolated with
`git diff 67cd428^..67cd428` plus `git diff 67cd428..HEAD`, so no Phase 28 code is credited to or
blamed on Phase 27.

**Verdict:** the Phase 27 composition is sound. Hour membership by first ingest record, position by
(`ingested_at`, `event_id`), RFC 6962 root over position-ordered hashes, fail-closed digest errors,
event-before-ingest ordering with stored-with-warning degradation, append-only lock compliance, and
no-backfill coverage all check out against the source. No BLOCKER- or WARNING-grade defect found.

**Layering attribution (verified by diff, not assumed):** Phase 27 added `HourLeaf`/`hourLeaves`,
`IngestNotRecorded`, `INGEST_LAG_MS`/`INGEST_BUDGET_MS`, the `event_ingest` DDL + write, the
canonical 11-column `anchors` DDL + information_schema shape check, the `append` mapping, and
`Substrate.hourDigest`. It added **zero** anchors row APIs. `AnchorRow`, `parseAnchorRow`,
`anchorsBetween`, `anchorForPeriod`, `insertAnchor`, `firstIngestMs`, `graphIngest`, the verify hour
report, and the anchor job are all Phase 28 (`589a27c`) layers. Phase 27's "writes and reads no
anchors rows" (D27-20) holds: `grep -c` for those symbols in the Phase 27 diff is 0.

**Severity equivalence:** `critical` below = BLOCKER tier; every finding carries a classification.

## Info

### IN-01: Timestamp wire contract is numeric epoch ms; ISO-string cells fail closed per D27-10/D27-13 (corrected)

**File:** `packages/mcp-server/src/greptime.ts:143-146` (`epochMs`)
**Correction:** An earlier draft of this review carried this as WR-01 with a `Date.parse` fallback
proposal. That was wrong and is withdrawn in full. The declared Phase 27 contract requires a
non-numeric ingest time to fail naming the event (D27-10 first-record rule, D27-13 fail-closed, no
partial root), and `epochMs` implements exactly that. The numeric-epoch-ms wire contract is proved
by the source and by the fresh scratch actual (47/47 on v0.14.4, which answers TIMESTAMPs as epoch
ms — the smoke itself parses with `Number()`). Production v1.1.4 behavior is an explicitly
retained operator gap (D27-23), not an observed ISO-wire failure; proposing lenient parsing invents
production output and would weaken the fail-closed validation the requirements mandate. No code
change recommended. Parent closes actual-27 coverage gaps separately.

### IN-02: `hourLeaves` accepts a non-whole-hour `startMs` without complaint

**File:** `packages/mcp-server/src/greptime.ts:868` (`hourLeaves`)
**Issue:** `hourLeaves` builds a `[startMs, hourEnd(startMs))` window for any input, including a
mid-hour timestamp, silently digesting a shifted window. The only caller (`Substrate.hourDigest`,
`service.ts:2486-2492`) validates whole-hour starts first, so this is unreachable today — but the
method is public on `GreptimeClient` and the next caller (Phase 28's job/verify) must remember to
re-validate. Consider a whole-hour guard in `hourLeaves` mirroring `hourDigest`'s.
**Fix:** throw `GreptimeError` when `startMs !== hourStart(startMs)` before the append-mode probe.

### IN-03: `pubkeyArgv` skips the validation its sibling applies

**File:** `packages/ledger/src/solana.ts:62-64`
**Issue:** `transferMemoArgv` validates absolute CLI path, amount, memo shape, pubkey charset, keypair
path, and rpc scheme; `pubkeyArgv` passes `keygen`/`keypairPath` through unchecked. No finding
against the port itself — D27-01 byte-identity forbids edits and there is no Phase 27 caller — but
Phase 28 (first caller) should validate or wrap these inputs before handing them to `execFile`.
Recorded here so the asymmetry is not mistaken for reviewed-and-safe.

### IN-04: Shape check cannot distinguish "fresh store" from "server rejects the information_schema shape"

**File:** `packages/mcp-server/src/greptime.ts:567-580`
**Issue:** By design (D27-19) the anchors drift check is silent on empty or failed reads. Consequence
worth stating plainly: if a server (e.g. production v1.1.4) ever stops answering this exact
`information_schema` shape, boot degrades to no drift warning with no signal distinguishing that
from a fresh store. The definite-mismatch path is stub-pinned and the statement parsed on scratch
v0.14.4 (the smoke `migrate()` ran it without failing the 28/28 run), so this is an evidence-limit
note, not a behavior complaint. No code change required; Phase 28's boot evidence is the natural
place to confirm the query still answers on v1.1.4.

### IN-05: Reading limits disclosed

**File:** `packages/ledger/src/rpc.ts`
**Issue:** `rpc.ts`'s implementation body (retry loop, instruction-memo extraction) was reviewed at
header/type/contract level only; confidence there rests on the byte-identity `cmp` proof and the
ported 170-line test suite recorded in `27-01-SUMMARY.md`, which was not re-executed here. Likewise
`merkle.test.ts`/`memo.test.ts`/`period.test.ts`/`solana.test.ts` bodies were sampled, not
line-audited; the RFC 6962 split logic in `merkle.ts` itself was fully traced (split at largest
power of two strictly below n verified for n = 2, 3, 4, 5) and the memo/period validators read in
full. Performance (recursive slice copies, per-500 batched round trips) is out of scope per review
v1 rules and was not assessed.

## Verified correct (no finding)

- **Event-before-ingest ordering** (`greptime.ts:687-762`): event `INSERT` precedes the ingest loop;
  every post-store failure path throws `IngestNotRecorded`; `liveAppendMode` never throws
  (`.catch(() => null)`), so a `stored:false`-after-store misreport is unreachable.
- **Stored-with-warning mapping** (`service.ts:911-922`): `IngestNotRecorded` branches first,
  `stored:true` + `INGEST_NOT_RECORDED` warning (+ dedup caveat when applicable), redacted journal
  line; other errors stay `stored:false`. `EmitResult` shape unchanged.
- **Membership/ordering** (`greptime.ts:868-933`): first-record collapse, unbounded earlier-record
  exclusion per 500-id batch, code-unit `(ingested_at, event_id)` sort, half-open window boundaries
  (`>= start`, `< hourEnd`; lookback `< start`), empty-member loops skip without emitting `IN ()`.
- **Fail-closed digest**: missing row / non-64-hex hash / double hash / non-numeric time all throw
  naming the event; never a partial root. Empty closed hour → `root:null, memo:null`.
- **UTC period/lag**: boundary belongs to the starting hour; closed exactly at `hourEnd + 300_000`;
  smoke uses exactly that boundary. Lag constant lives in `greptime.ts`, keeping `period.ts`
  byte-identical per D27-01.
- **Append-only lock**: all new statements (`CREATE`/`INSERT`/`SELECT`/`SHOW`/`DESCRIBE`) pass
  `assertAppendOnly` via `sql()`; every value passes through `this.q`; service adds no raw SQL
  (diff grep empty); `agent_events`, `EVENT_COLUMNS`, `APPEND_ONLY_VERBS` untouched.
- **No backfill, no anchors I/O**: nothing synthesizes ingest records; Phase 27 diff contains no
  anchors row read/write.
- **Smoke proof design** (`scripts/greptime-smoke.ts` §5): subset-not-exact-count assertion (correct
  against shared scratch hours), independent order recomputation from raw rows, backdated-membership
  plus empty-September-hour checks, chain-intact and hash-unchanged checks. Historical 28/28 result
  and the production schema probe are cited from the existing record, not re-claimed.
- **Docs** (`docs/greptime-ledger.md`, `README.md`): DDLs match code, dedup-by-period, ignored D-era
  column, version gap, and operator deploy steps all recorded; no host or credential present.


## Final re-audit (2026-10-11, static only)

Parent-supplied ground truth for this pass (cited, not re-run — no tests, gates, builds, lint, or
formatters executed from this review):
- Full suite: 2719 pass / 58 skip / 0 fail across 96 files, types exit 0, locks 108 pass / 0 fail
  (`local://v13-final-green-evidence.json`).
- Fresh ledger runtime on real GreptimeDB v0.14.4: 47/47 (28 ingest + 19 fake-chain), up/down exit 0,
  two owned store containers removed (`local://v13-final-runtime-evidence.json`).
- Opaque-credential failure injection: BEFORE state (smoke leak true, exit 1) moved AFTER by parent
  (migration errors 4, smoke leak false, exit 1); failure exits stay truthful.
- `redactKnown` empty-only contract preserved in source (`redact.ts:305-306`: only
  `value.length > 0` passes; short values not exempted) and restated in current docs
  (`docs/greptime-ledger.md:306-310`: known-opaque scrub before shape redaction, same boundary in
  smoke sinks, no redacted-warning-as-success verdict). Smoke statically confirmed to scrub report
  sinks (`scripts/greptime-smoke.ts:104-106`), name only the database, and exit 1/2 truthfully.
- No new error suppression in Phase 27 scope: every post-store failure surfaces as
  `IngestNotRecorded`; the null/empty-tolerant branches (append-mode probe, shape check, dialect
  probe) return unknown-and-retry or documented silent-when-unanswerable, never success.
- Current `docs/greptime-ledger.md` ledger diagnostics verified present: retry/lag/budget semantics,
  stored-with-warning, no-backfill, dedup-by-period, version gap (lines 303-336).

Final status: **0 critical / 0 warnings**. The five INFO items above are retained with their stated
bounds — they are observations and reading limits, not defects, and this report does not collapse
them into a fake `no issues` verdict. IN-01 (timestamp strictness) remains as corrected: fail-closed
per D27-10/D27-13, no `Date.parse` fallback, no production-output claims.

---

_Reviewed: 2026-10-10_
_Reviewer: Claude (gsd-code-reviewer, Phase27NativeReview)_
_Depth: standard_
_Evidence: static reading only; zero runtime/test/build/format commands executed per contract._
