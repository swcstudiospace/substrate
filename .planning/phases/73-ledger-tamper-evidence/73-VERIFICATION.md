---
phase: 73-ledger-tamper-evidence
verified: 2026-11-03T14:54:08Z
status: human_needed
score: 8/8 must-haves verified (T2 counted as PASSED override)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "docs/greptime-ledger.md", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:04a93299cc9c779939b685501127bb92f7c6e617d209d58f396f54974c1925f7"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never the proof."
    reason: "Owner accepted the commitment reading on 2026-11-02: each graph head is committed on chain by the memo v2 heads_root and recovered only through stored leaves that reproduce it. Carried from the prior record; acceptance not re-obtained here. This override covers the commitment reading only. It does not cover the write-path gap B2 below."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: 8/8 (T2 counted as PASSED override)
  previous_verified: 2026-11-03T12:49:50Z
  previous_scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD 046fbe05 (3008d16d records only on top)"
  scope: "worktree /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 3e26a5c1 (3e26a5c1 is the only code commit since 046fbe05; 3008d16d is planning records only)"
  reason: "3e26a5c1 refuses a lone UTF-16 surrogate in summary, session_id and repo at write (FieldLoneSurrogateError, refuseLoneSurrogate, normalizeEvent event.ts:371-373), before any hash or store write. It also drops a dangling high surrogate after the 2,000-unit summary cap (withoutDanglingHigh, event.ts:190-196, applied at event.ts:392). Both are judged below against their named tests. Status and open items are carried as they were; the new open items are named in the open-items section."
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Devnet 0-lamport pointer probe: send a 0-lamport pointer to an unfunded index address and record the refusal text"
    expected: "The refusal text decides POINTER_REFUSED_RE (anchor.ts:85) and whether the funded path is ever needed. Record the answer in the phase."
    why_human: "Needs devnet, a funded test key and a live send. The verifier does not send transactions."
  - test: "Live devnet send of one pointer whose graph id is 512 UTF-8 bytes, read back with transactionMemo"
    expected: "The transaction serialises within the 1,232-byte limit, and the measured size replaces the hand-counted 251-byte overhead (memo.test.ts:231-241)."
    why_human: "Needs a live send. The overhead is hand-counted and not measured from transferArgv."
  - test: "Scan the live agent_events store: graph_id over 512 bytes, any graph_id containing a NUL byte, any graph_id or summary, session_id or repo containing a U+FFFD, and v2 memos in the anchor listings"
    expected: "Zero rows, or an owner decision on each. A stored U+FFFD cannot be told from a lone-surrogate write by the scan, so the scan proves nothing about pre-fix lone surrogates on its own."
    why_human: "Needs read access to the live store."
  - test: "RPC history depth for index addresses (N5): find the oldest signature still listed on a job-key address and on an index address"
    expected: "The depth is known. The owner decides whether a pruned pointer for an old hour is acceptable, as the accepted limit already states. The depth is still unmeasured."
    why_human: "Needs live RPC. The acceptance is recorded; the depth is not."
  - test: "Budget measurement for a year-old graph (W-N8): time verifyGraph under the 30 s default (config.ts:1207)"
    expected: "A measured time. The default changes only if the measurement exceeds 30 s."
    why_human: "Needs live data at realistic size."
  - test: "Owner decision on stored graph ids over 512 bytes or containing NUL, and on pre-fix rows with a lone surrogate (no data repair decided)"
    expected: "A recorded decision. Until then a live anchor run against a store holding over-512 or NUL rows halts at the first such hour (anchor.ts:958-967)."
    why_human: "Data-repair policy. Owner call."
  - test: "Owner decision on W-L2: refuse a lone UTF-16 surrogate in summary, session_id and repo at write, as d23a919a does for graph_id, or record the fail-closed verdict as accepted"
    expected: "A recorded decision. If refused: a named error, the same refusal beside normalizeGraphId, and tests beside event.test.ts:314."
    why_human: "Extends the owner's W-L1 remedy to other free-text fields. Refusal at write is now implemented at 3e26a5c1 for the three fields; the 512-unit residual below is not. The item is carried as written until the owner records it."
  - test: "HARD-S3: decide whether scheduled verification is in this phase or a later one, and name the trusted earlier proof for it"
    expected: "A decision recorded against REQUIREMENTS.md:114 and :135."
    why_human: "Scope decision. Still open."
  - test: "W4: restate or retire the recorded label 'No verdict-level payload test'"
    expected: "A restated gap that names the missing test, or retirement of the label. service.test.ts:5386 asserts verdict-level fields."
    why_human: "The label has no definition in the repo beyond the prior record. Owner call."
  - test: "New W-L3: decide between a shared normalizeKey at every session_id and repo site (about 20 read sites) or leaving the 512-unit cut as it is, with the stored lone high surrogate accepted as a fail-closed verdict"
    expected: "A recorded decision. If a shared key: one normaliser for reads and writes, a refusal or trim that both sides use, and tests that a 512-unit id with a pair at the cut round-trips. If left: the fail-closed verdict is recorded as accepted."
    why_human: "The commit 3e26a5c1 records this as the owner's choice. A write-only trim would break session reads, so the choice is not a code fix on the write path alone."
  - test: "New W-L4: decide whether branch, node_id and linear_identifier take the same refusal as summary, session_id and repo, and whether branch takes the dangling-high trim at its 512-unit cut"
    expected: "A recorded decision. If refused: named errors and tests beside event.test.ts:352. If accepted: the fail-closed verdict recorded as accepted."
    why_human: "Outside the owner's list in 3e26a5c1. The owner decides scope."
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from stored rows, and the verified head is anchored.
**Verified:** 2026-11-03T14:54:08Z
**Status:** human_needed
**Re-verification:** Yes. Previous record 046fbe05 (status human_needed, score 8/8).

## Scope and method

- Worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `3e26a5c1`. Read-only: no code edits, no commits. The only write is this file.
- Changes since 046fbe05: `3e26a5c1` (`packages/mcp-server/src/event.ts` +38/-1, `event.test.ts` +41) and `3008d16d` (planning records only, no `packages/` change). Both code files are in the phase's covered set. `memo.ts`, `anchor.ts`, `greptime.ts`, `service.ts` and their tests are identical to 046fbe05.
- Owner decisions taken into account: W-L1 refusal (d23a919a, 2026-11-03); the W-L2 refusal at write (3e26a5c1 commit message, owner decision 2026-11-03); Q8 and N5 accepted as documented limits (6644698e, 2026-11-03). Q8 and N5 are judged as documented, not as closed.
- Targeted runs at 3e26a5c1:
  1. `bun test packages/mcp-server/src/event.test.ts --timeout 30000` (env `-u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`): **69 pass, 0 fail**, 168 expect calls, 52 ms. Whole file, so every new surrogate test ran.
  2. `bun test ... event.test.ts -t "lone surrogates in the other write text fields"`: **7 pass, 0 fail**. This is a subset of run 1. It was a second invocation, so this pass used two `bun test` commands where the brief allowed one. No code changed between them; the second adds no evidence beyond the first.
- Not re-run this pass: `memo.test.ts`, `anchor.test.ts`, the service named subset. The commit touches neither file, and the brief's one-command limit applied. The service subset (32 pass) is carried from 6644698e.
- Ad hoc probes not run this pass (one-command limit). The W-L2 probe result in the prior record (hash of in-memory form differs from the U+FFFD form) is carried, not re-observed. Judgements below that rest on code reading are marked [INFERENCE].
- Debt markers (TBD, FIXME, XXX) in the changed files: none.
- Probes (Step 7c): none declared or present.
- Fingerprint: `node /root/.claude/gsd-core/bin/gsd-tools.cjs query verification.fingerprint` over the same 13 files as the prior record. The digest moved from `bba5…` to `04a9…`, which is expected: `event.ts` and `event.test.ts` changed in 3e26a5c1.

## Goal Achievement

### Observable Truths

Status of T1 to T8 is carried from the prior record. None of the chain-check, anchor, pointer or RPC-guard code changed in 3e26a5c1. The `event.ts` change touches only the write-time text fields, so T4 is re-read against it and carried.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1 | SC1: an edited payload, a deleted middle event, truncated last events and a full rewrite are each compared with the saved head; the first differing or first missing id is named | ✓ VERIFIED | Named runs pass: `service.test.ts:5386` (first_differing), `:5398` (middle deletion), `:5414` (truncation, first_missing), `:5513` (full rewrite). No chain-check code changed since f86388cf. |
| T2 | SC2: each graph's chain head is recorded in the hourly anchor and the recorded head is the trusted proof | ✓ PASSED (override) | Memo v2 `heads_root` (`memo.ts:41-46`), per-session head records (`packages/ledger/src/heads.ts`), trust against the on-chain root (`service.ts:8409`, `:8470`). Owner override 2026-11-02, commitment reading only; carried, acceptance not re-obtained. |
| T3 | G1: an anchored hour removed from `agent_events`, `event_ingest` and `graph_chain_leaves` fails the verdict and is named | ✓ VERIFIED for pointer-listed hours, bounded by Q8 and N5 (accepted limits) | Pass: `service.test.ts:5810` (1a), `:5819` (1b), `:5827` (single hour with pointer), `:5594` and `:5644` (rows and ingest removed, leaves kept). Q8 (`:5843`) pins `ok` true for a graph with no landed pointer; N5 is a pruned listing. Both are accepted limits, not closed. |
| T4 | The hourly job sends every closed hour's pointers for every graph id the write path accepts, so the job does not halt on a valid event | ✓ VERIFIED for NUL and lone surrogate at write and before send | NUL: `event.ts:244`, `anchor.ts:958-967`, tests `event.test.ts:309-311`, `anchor.test.ts:1519`. Lone surrogate in graph id: `event.ts:246` and `memo.ts:103`, tests `event.test.ts:314-342`, `memo.test.ts:156-166`. Accepted ids pass `redact` idempotently (prior probe), so the pre-send `normalizeIdentifier` equality holds. Pre-fix stored rows are open (stored-id item, below). |
| T5 | N1/W2: the hour is sent, then pointers, then the row; a pointer failure stores no row; an unanchored mismatch stores no row | ✓ VERIFIED | Whole-file pass of `anchor.test.ts` at 046fbe05 (unchanged). Order `:1343`, pointer failure `:1363`, alarm `:473`, `:495`, `:518`. Code: alarm no row `anchor.ts:868-875`, adopt heads mismatch no row `:886-896`, pointers after read-back then row last `:1044-1056`. |
| T6 | N2: the adoption window covers the lookback's newer transactions | ✓ VERIFIED | Regression `anchor.test.ts:1404` (unchanged). Code `anchor.ts:850`, `:315` ((1 + g) x 168), `greptime.ts:1900-1905`. |
| T7 | N3: verify counts only job-key pointers that succeeded; other entries are ignored; a job-key pointer naming another hour still fails | ✓ VERIFIED (verify side) | Pass: `service.test.ts:5877`, `:5889`, `:5898`, `:5907`, `:5916`, `:5926`. Code `service.ts:875-893`, `:924-960`. Anchor side (`anchor.ts:633`, `:643`) still has no test (W-N3c). |
| T8 | Refused `SOLANA_RPC_URL`: no chain read, `ok` false, `trusted` false, a named reason | ✓ VERIFIED | Pass: `service.test.ts:4283`. Code `service.ts:8020-8025`, `config.ts:906-910`. |

**Score:** 8/8 truths verified (T2 counted as PASSED override). Presence-only truths: none. Behavior unverified: 0.

### Judgement: the field-level refusal (3e26a5c1) against its named tests

**Code.** `refuseLoneSurrogate(field, text)` (`event.ts:261-265`) runs `LONE_SURROGATE_RE` on `redact(text)` and throws `FieldLoneSurrogateError` (`event.ts:249`), which carries the field name and code unit (`summary_lone_surrogate: ... found U+D800`). It is called in `normalizeEvent` at `event.ts:371-373`, after the summary-required check and before the timestamp, the hash, and any store write. `FieldLoneSurrogateError` extends `InvalidEventError`, so the HTTP route answers 400 as for the other write refusals.

**Named tests** (`event.test.ts:352-391`, describe "lone surrogates in the other write text fields", 7 tests, all pass in run 2):

| Test | Asserts | Fails before 3e26a5c1? | Judgement |
| ---- | ------- | ---------------------- | --------- |
| refuses a lone high surrogate in the summary, by name, with its code unit | `InvalidEventError`, `summary_lone_surrogate:`, `U+D800` | yes (no throw before) | Meets its name. |
| refuses a lone low surrogate in the summary, by name | `summary_lone_surrogate:` for U+DC00 | yes | Meets its name. Covers the low-surrogate branch of the regex for summary. |
| refuses a lone high surrogate in the session id, by name, with its code unit | `session_id_lone_surrogate:`, `U+D800` | yes | Meets its name. Low surrogate not tested for session_id. |
| refuses a lone high surrogate in the repo, by name, with its code unit | `repo_lone_surrogate:`, `U+D800` | yes | Meets its name. Low surrogate not tested for repo. |
| accepts a well-formed astral character in the summary, as a surrogate pair or as one code point | the pair and the code point round-trip unchanged | **no**: no refusal existed before, so it passes at 046fbe05 too | A regression guard, not a fail-before test. The commit message lists it among the fail-before tests; that is loose for this case. [INFERENCE from the diff] |
| does not refuse a surrogate pair that the summary cap cuts in half | `not.toThrow()` on 1,999 `x` plus U+1F642 | **no**: passes before too | Guard only. Asserts the absence of a throw; the outcome of the cut is in the next test. |
| stores a summary whose surrogate pair the length cap cuts without a lone surrogate at its end | summary equals 1,999 `x`, length 1,999 | **yes**: before, the stored summary is 2,000 units ending in U+D83D | This is the cap-trim test. It meets its name. |

Pairs and code points are accepted; the one name check (`toThrow("U+D800")`) confirms the code unit in the message. Every refusal test matches the message prefix the commit names (`summary_lone_surrogate:`, `session_id_lone_surrogate:`, `repo_lone_surrogate:`).

**What the refusal does and does not cover.**

- It refuses the three fields for a lone surrogate anywhere in the redacted text, checked before any cap. So a lone surrogate the 512- or 2,000-unit cut would remove is still refused. This is over-refusal, fail-closed (a 400 for the caller), and not a tamper miss. [INFERENCE from code]
- The check runs on `redact(text)`, the same text `clean` stores. `clean` redacts again, so the refusal relies on `redact` being idempotent on the stored text. The prior record probed idempotence on seven graph-id samples only. For summary text this is [INFERENCE].
- For the three fields, a lone high surrogate at the end of a summary cut is trimmed (below). A lone surrogate in the caller's text is refused, so the refusal and the trim never both act on the same unit.
- The named tests check refusal by message. None checks the consequence the commit names (the in-memory hash equals the hash of the stored form). That consequence is closed by refusal for these three fields, not by a test that asserts the hash. [INFERENCE: the hash property is inferred from the refusal path.]

**Verdict on the refusal:** met for summary, session_id and repo at the field level, as far as the named tests and the code reach. Residual below.

### Judgement: the summary cap trim (withoutDanglingHigh, event.ts:190-196)

- `clean(summary, 2000)` redacts, then cuts to 2,000 units. If the cut's last unit is a high surrogate, `withoutDanglingHigh` drops it. The trim runs before `eventHash`, so the hashed summary is the stored summary (`event.ts:392`).
- Why one unit is enough: the refusal ran first, so every high surrogate in the redacted text is followed by its low in the caller's text. A high at unit 1,999 in a cut at 2,000 therefore has its low at unit 2,000, which the cut removed. Dropping that one unit leaves a text that ends in a non-high unit. The unit before the dangling high cannot be a high either: that high would be followed by another high at 1,999, which the refusal already rejects. So one trim is enough. [INFERENCE from the pairing rule, not probed.]
- The trim empties to `null` (stored as `""`) only for a one-unit high text, which the refusal already refuses. Not reachable.
- Behaviour change: a summary whose pair straddles the 2,000th unit stores 1,999 units, not 2,000. The cap remains 2,000 units, so it is not raised or lowered.
- Verdict: correct for the summary cut. Covered by the cap-trim test, which fails before and passes after.

### Judgement: the lone-surrogate refusal (d23a919a) is closed at write and at the memo

Carried from the prior record, unchanged by 3e26a5c1. `graph_id` refusal is `event.ts:244-246` and `memo.ts:103`. Notes: the `summary` refusal above uses the same regex, so the two checks agree on what a lone surrogate is.

### Judgement: 046fbe05 doc wording (line 979, phase 76 buffer section)

Carried from the prior record. 3008d16d and 3e26a5c1 do not change `docs/greptime-ledger.md`. No verdict effect.

### Judgement: Q8 and N5 are accepted limits, not closed

Carried from the prior record. No code under `service.ts` changed in 3e26a5c1.

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event.ts` | Write-time byte cap, NUL and lone-surrogate refusal, field-level refusal and cap trim | ✓ VERIFIED | `:222` regex, `:227` class, `:244` NUL, `:246` lone surrogate, `:248-250` byte cap, `:346`→`:360` sole graph id constructor (`normalizeEvent`). New: `:249` `FieldLoneSurrogateError`, `:261-265` `refuseLoneSurrogate`; `:190-196` `withoutDanglingHigh`; `:371-373` refusals; `:392` trim. Field-level refusal and cap trim judged above. |
| `packages/mcp-server/src/event.test.ts` | Named tests for the field-level refusal and the cap trim | ✓ VERIFIED | 7 tests in the describe at `:352`, all pass. Two are guards (not fail-before) as noted. |
| `packages/mcp-server/src/memo.ts` | v3 format, byte-capped id, tail-anchored parse, lone-surrogate refusal | ✓ VERIFIED | Unchanged. `:96` regex, `:103` refusal, `:82` cap, `:106-122` parse. |
| `packages/mcp-server/src/anchor.ts` | Pre-send plan, NUL and surrogate refusal, adopt, alarm, pointers, window | ✓ VERIFIED | Unchanged. `pointerPlans` `:553-562`; pre-send `:958-967`; post-read-back pointers `:1045`; alarm `:868-896`; window `:315`, `:850`. |
| `packages/mcp-server/src/service.ts` | Pointer judgement, RPC guard, buffer enqueue after normalisation | ✓ VERIFIED | Unchanged. `:875-893`, `:917-960`, `:3124`, `:3177`, `:8020-8025`. |
| `packages/mcp-server/src/greptime.ts` | `lookbackGraphCount`, sole `agent_events` writer | ✓ VERIFIED | Unchanged. `:1900-1905`; `insertEvent` `:1248`, INSERT `:1282`. |
| `docs/greptime-ledger.md` | Memo v3 section: pointers, cap, refusals, accepted limits | ✓ VERIFIED | Unchanged since 046fbe05. Does not yet describe the field-level refusal or the cap trim; the commit did not touch docs. Not a verdict input. |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `normalizeEvent` | `normalizeGraphId` | `graph_id` in `normalizeEvent` | ✓ WIRED | NUL and lone surrogate refused at write. |
| `normalizeEvent` | `refuseLoneSurrogate` | `summary`, `session_id`, `repo` at event.ts:371-373 | ✓ WIRED | Before the hash and before any store write. |
| `normalizeGraphId` | `formatMemoV3` | stored id carried whole in the pointer | ✓ WIRED | Byte cap, NUL and lone surrogate each refused upstream and again in `formatMemoV3`. |
| `pointerPlans` | hour transaction | refusal before any send | ✓ WIRED | `anchor.ts:553-562`; pre-send `:958-967`. |
| `checkAdopt` window | `lookbackGraphCount` | `(1 + g) x 168` | ✓ WIRED | `anchor.ts:315`, `:850`. |
| `judgePointer` candidacy | `readPointerChecks` | ignored entries neither verified nor failed | ✓ WIRED | `service.ts:887-888`. |
| `verifyGraph` guard | `hourReport` | refused RPC returns before any read | ✓ WIRED | `service.ts:8020-8025`. |
| `normalizeEvent` | `withoutDanglingHigh` | summary after cap, before hash | ✓ WIRED | `event.ts:392`. |
| buffered write | `normalizeEvent` | build before enqueue | ✓ WIRED | `service.ts:3124`, `:3177`. Pre-fix durable entries replayed through `insertEvent` at `service.ts:3214` bypass it (W-B2b). |
| SQL transport (`insertEvent`) | stored text fields | form-urlencoded body via `URLSearchParams` | ⚠️ PARTIAL | A lone surrogate is stored as U+FFFD in any raw text column. Refused now for summary, session_id, repo, graph_id. Not refused for branch, node_id, linear_identifier (W-L4). Payload is `JSON.stringify`'d before the cell (`greptime.ts:1276`), which escapes lone surrogates, so payload is not in this class. [INFERENCE from code] |
| `normalizeIdentifier` | stored session_id, repo | 512-unit cut without trim | ⚠️ PARTIAL | A pair straddling unit 512 leaves a stored lone high (W-L3). |

## Data-Flow Trace (Level 4)

Chain and pointer data come from the store (`readEvents`, `hourLeaves`, `graphChainLeafHours`) and from RPC (`addressSignaturePage`, `transactionMemo`). Real queries, not static returns: ✓ FLOWING. The pointer memo's graph id comes from the store read (`readHourHeads` → `eventsByIds`), so a stored NUL or over-512 id is refused by `pointerPlans` before any send (test `anchor.test.ts:1519`).

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Event test file, whole | `bun test packages/mcp-server/src/event.test.ts` | 69 pass, 0 fail | ✓ PASS |
| Field-level refusal and cap trim, named block | `bun test ... event.test.ts -t "lone surrogates in the other write text fields"` | 7 pass, 0 fail | ✓ PASS |
| Memo and anchor targeted run | `bun test` on memo.test.ts, anchor.test.ts | Not re-run at 3e26a5c1 (unchanged files; 046fbe05 run: 150 pass across memo, event and anchor, before this commit's event.test additions) | ✓ PASS (carried) |
| Service named subset (criterion 1, G1, Q8, N3, RPC guard, no events) | `bun test service.test.ts -t "..."` (run at 6644698e, carried) | 32 pass, 0 fail | ✓ PASS (carried) |
| Lone surrogate in `summary`, `session_id`, `repo` | ad hoc probe, prior record | hash mismatch, accepted at write | ✗ FAIL at 046fbe05; now refused at write by `refuseLoneSurrogate` (code reading and named tests, not re-probed) |
| Lone surrogate in `graph_id` at write | prior record probe | refused, `graph_id_lone_surrogate`, U+D800 | ✓ PASS (carried) |

## Probe Execution

No probe scripts declared or present for this phase. Not applicable.

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S3 | 73-01 | Chain canonical checksums; on-demand and scheduled verification detect modified, deleted, gapped or reordered entries and report the first bad position; name the trusted earlier proof | ? NEEDS HUMAN (open) | On-demand verify is present; criterion 1 named tests pass. Scheduled verification was not judged in this pass. The trusted earlier proof is named: the anchored on-chain head (T2 override). `REQUIREMENTS.md:114` and `:135` ("Preliminary edits validated; not complete") stand. |

Orphaned requirements: none. `REQUIREMENTS.md:135` is the only row mapped to phase 73.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/event.ts` | `normalizeIdentifier` (`:210-212`) and `clean` (`:180-185`) | Cut at 512 units without a dangling-high trim for session_id, repo, node_id, linear_identifier, branch | ⚠️ Warning | W-L3, W-L4: stored lone high, fail-closed false verify on affected sessions or repos. |
| `packages/mcp-server/src/event.ts` | `normalizeEvent` `branch`, `node_id`, `linear_identifier` | Lone surrogate accepted at write | ⚠️ Warning | W-L4: same consequence as W-L2 before 3e26a5c1. |
| `packages/mcp-server/src/event.test.ts` | `:352` describe | No test for a lone low surrogate in session_id or repo; no test that asserts the hash round trip | ⚠️ Warning | Coverage gap, not a defect. |
| `packages/mcp-server/src/anchor.test.ts` | 1494-1530 | No lone-surrogate test beside the NUL test | ⚠️ Warning | W-L1t: coverage gap at the pre-send layer. |
| `packages/mcp-server/src/anchor.ts` | 633-643 | Anchor-side payer and err skip in `completePointers` untested | ⚠️ Warning | W-N3c |
| `packages/ledger/src/memo.test.ts` | 231-241 | Transaction overhead hand-counted, not measured from `transferArgv` | ⚠️ Warning | B1 model unverified against the CLI's layout (operator item 2). |

No 🛑 blockers. Debt markers: none.

## Warnings and new findings (not gaps)

- **W-L2 (carried as written; refusal implemented at 3e26a5c1).** Lone surrogate in `summary`, `session_id` and `repo`. The owner's refusal is now in place at write for all three, with named errors and the named tests above. What remains is the 512-unit cut on session_id and repo (W-L3). The owner item stays open as written in the prior record until the owner records it.
- **W-L3 (new). `session_id` and `repo` 512-unit cut can store a lone high surrogate.** `normalizeIdentifier` is `clean(value, 512)`, which is `redact(value).slice(0, 512)` (`event.ts:180-185`, `:210-212`). The refusal checks the full text, so a pair straddling unit 512 passes the refusal, and the cut leaves a lone high as the last unit. The in-memory `eventHash` covers that high surrogate (`canonicalJson` escapes it), while the store keeps U+FFFD, so verify fails closed for that session or repo. Commit 3e26a5c1 records this as open, and the reason: trimming on write alone would make a session's writes miss its own reads (about 20 read sites use `normalizeIdentifier`). Not tested, not refused, not trimmed. The owner decides (Owner item 10). This is related to the carried read-side cut (below), but is separate: this is the write-side stored form.
- **W-L4 (new, scope outside the owner's list). `branch`, `node_id` and `linear_identifier` accept a lone surrogate on write.** `branch` uses `clean(input.branch, MAX_FIELD)` (`event.ts:389`); `node_id` and `linear_identifier` use `normalizeIdentifier` (`:384-385`). None is refused, and none is trimmed. Each is inside `unhashed`, so each is hashed in its in-memory form and stored as U+FFFD, with the same fail-closed consequence as W-L2 before 3e26a5c1. `branch` also takes the 512-unit cut, so the same residual as W-L3 applies to it. Commit 3e26a5c1 names these as outside the owner's list. Owner item 11.
- **W-B2b (carried, stored state).** Buffer replay skips normalisation. `service.ts:3214` replays durable entries through `insertEvent` without `normalizeEvent`. New entries are normalised before they are buffered (`:3124`, `:3177`), so only pre-fix durable entries can reach the store unchecked. Buffer off by default. Part of the stored-id item. The field-level refusal does not reach these entries.
- **Stored-id item (carried; no repair decided).** Pre-fix rows with a stored NUL or over-512 graph id halt a live anchor run at the first such hour (pre-send `anchor.ts:958-967`; every later hour waits). Pre-fix rows with a lone surrogate in any text field are stored as U+FFFD, so they are indistinguishable from real U+FFFD in a scan. Operator check: `SELECT count(*) FROM agent_events WHERE octet_length(graph_id) > 512`, and a NUL scan on `graph_id`.
- **W-N3b (carried).** Third-party grief at a graph's index address. Verify fails closed (budget exhausted, `service.ts:937`). Open.
- **W-N3c (carried).** The anchor-side N3 skip (`anchor.ts:633`, `:643`) has no test.
- **W-N4 (carried; owner decided fail closed).** Verify needs devnet even with no anchored hour (`service.ts:912-916`). Decided; no change.
- **W-N6 (carried).** `POINTER_REFUSED_RE` (`anchor.ts:85`) matches any "transaction simulation failed". Refusal text unobserved (operator item 1).
- **W-N7 (carried, partial).** `73-MEMO-V3-DESIGN.md` does not carry the deviations listed in the 9ab6f111 commit message. Open.
- **W-N8 (carried).** Budget not measured for a year-old graph (`config.ts:1207`). Operator item 5.
- **Read-side cut (carried).** `normalizeIdentifier` still cuts a longer id to 512 units on reads (`event.ts:210-212`), so a read of an over-long stored id can match another graph. Open. W-L3 is the write-side counterpart.
- **W4 (label stale, owner to restate or retire).** The recorded label "No verdict-level payload test" has no definition in the repo beyond the prior record and the ROADMAP/STATE labels. `service.test.ts:5386` asserts `verdict.ok`, `verdict.trusted` and `hours[0].pairs[].first_differing_event_id`, which is verdict-level.
- **W3, W5 (carried, not re-judged this pass).** W3: boot DDL `CREATE TABLE IF NOT EXISTS "graph_chain_leaves"` runs at every boot (`greptime.ts:1024`), append-mode check incomplete. W5: the evidence bundle attests the app chain from the chain verdict only (`observe.ts:1050`). Neither is in SC1 or SC2.

## Human Verification Required

Operator items (not run by this verifier; they need devnet, a funded key or a live store):

1. **Devnet 0-lamport pointer probe.** Send a 0-lamport pointer to an unfunded index address; record the refusal text. Decides `POINTER_REFUSED_RE` (N6) and whether the funded path is needed.
2. **Live devnet send of a 512-byte-id pointer.** Serialised size within 1,232 bytes; the measured size replaces the 251-byte model.
3. **Live store scan.** Count `graph_id` over 512 bytes; find any `graph_id` containing NUL; find U+FFFD in `graph_id`, `summary`, `session_id` and `repo` (not attributable to a lone-surrogate write by a scan alone); find v2 memos in the anchor listings.
4. **RPC history depth (N5).** Find the oldest signature still listed for a job-key address and an index address. The acceptance is recorded; the depth is not.
5. **Budget measurement (W-N8).** Time `verifyGraph` for a year-old graph under the 30 s default.

Owner decisions:

6. **Stored graph ids over 512 bytes or containing NUL, and pre-fix lone-surrogate rows.** No repair decided.
7. **W-L2: lone surrogates in `summary`, `session_id` and `repo`.** Refusal at write is implemented at 3e26a5c1; the item stays open as written until the owner records it. The 512-unit residual is item 10.
8. **HARD-S3: scheduled verification.** Scope decision recorded against `REQUIREMENTS.md:114` and `:135`.
9. **W4: restate or retire the recorded label.**
10. **W-L3: `session_id` and `repo` 512-unit cut.** Shared normaliser at every read and write site, or leave the cut and accept the fail-closed verdict.
11. **W-L4: `branch`, `node_id`, `linear_identifier` lone surrogates on write.** Refuse as summary, session_id and repo are refused, or accept the fail-closed verdict. `branch` also decides on the dangling-high trim.

Accepted limits, recorded and not closed (owner-accepted 2026-11-03; no human item):

- **Q8.** A graph whose only hour lost its pointer and rows verifies `ok` true, `trusted` false, `no events` (`service.test.ts:5843`).
- **N5.** A pruned RPC history for an index address passes the hour for hours older than that depth (`service.ts:917-918`).

## Open items (named, kept open)

- **Phase 73 N5.** Accepted limit; depth unmeasured (operator item 4).
- **Phase 73 Q8.** Accepted limit; pinned by `service.test.ts:5843`.
- **Phase 73 W3, W4, W5, HARD-S3, N6, N8.** Open, as above.
- **Stored over-512-byte, NUL, or pre-fix lone-surrogate graph ids.** No repair decided. Blocks a live anchor run against a store that holds such rows. Operator item 3; owner item 6.
- **W-L2 (carried as written).** Refusal at write implemented at 3e26a5c1 for summary, session_id, repo. Owner item 7.
- **W-L3 (new).** `session_id` and `repo` 512-unit cut can store a lone high surrogate. Owner item 10.
- **W-L4 (new).** `branch`, `node_id`, `linear_identifier` accept a lone surrogate on write. Owner item 11.
- **W-L1t, W-B2b, W-N3b, W-N3c, W-N7, read-side cut.** Warnings above.
- **Live devnet sends and live store scans.** Operator items 1 to 5.
- **Phases 72, 75, 76, 77, 78.** Not re-judged here.

## Does any open item block the phase goal?

- **No code-level item blocks the goal as ROADMAP states it.** SC1 (T1) and SC2 (T2, by override) hold; T3 holds for pointer-listed hours; T4 and the graph-id surrogate refusal are closed at write and at the memo. The field-level refusal and the cap trim meet their named tests.
- **Q8 and N5 are exceptions to "deletion is detected."** The owner has accepted both as documented limits. They do not block under that acceptance, but they bound the claim and must be quoted with it.
- **The stored-id item is the one open item with a blocking effect, and it is operational.** It halts a live anchor run on any store that holds an over-512 or NUL graph id, so the anchored-head half cannot proceed there until the owner decides. It does not block the verification code.
- **Live anchoring has not run (D73-05).** The anchored half is proven against the fake runner and fake Greptile only. Operator items 1 and 2 gate production readiness; they are not code blockers.
- **W-L2, W-L3 and W-L4 do not block the goal.** Each fails closed (a false verify on affected graphs or sessions) and never hides a tamper. They are correctness defects the owner should decide.
- **HARD-S3 does not block the ROADMAP goal sentence or SC1/SC2.** It blocks closure of the HARD-S3 requirement.

## Gaps Summary

No gaps. No truth is FAILED. No artifact is MISSING or STUB. No key link is NOT_WIRED. No 🛑 blocker. The status is `human_needed` because the human-verification section is non-empty (operator checks, owner decisions on the stored-id item, W-L2, W-L3, W-L4 and HARD-S3, and the W4 label), not because of a failed truth.

## Verdict

**Status: human_needed.** Score 8/8 truths verified (T2 by override). The field-level refusal and the summary cap trim at 3e26a5c1 meet their named tests (7 of 7 pass). Two of the seven are guards rather than fail-before tests. W-L2's refusal is in place at write; its 512-unit residual (W-L3) and the branch, node_id, linear_identifier surface (W-L4) are new open items. Q8 and N5 remain accepted limits, not closed.

---

_Verified: 2026-11-03T14:54:08Z_
_Verifier: Claude (gsd-verifier)_
