---
phase: 73-ledger-tamper-evidence
verified: 2026-11-03T12:49:50Z
status: human_needed
score: 8/8 must-haves verified (T2 counted as PASSED override)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "docs/greptime-ledger.md", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:bba50839c8e2cedf05695dbb4a1078dcb1ad449300a5577538cadc77271a5370"
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
  previous_verified: 2026-11-03T12:44:59Z
  previous_scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD 6644698e"
  scope: "worktree /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 046fbe05 (6644698e plus one doc commit, 046fbe05, docs/greptime-ledger.md line 979)"
  reason: "046fbe05 is a doc-only commit. Two precision fixes in the phase 76 buffer section (docs/greptime-ledger.md line 979): the keyed-replay parenthetical says appends no event, and the first SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER mention names the accepted values. packages/ is identical to 6644698e. Each claim was judged against the code it describes and holds. No verdict change."
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
    why_human: "Extends the owner's W-L1 remedy to other free-text fields. Probe evidence in the warnings below."
  - test: "HARD-S3: decide whether scheduled verification is in this phase or a later one, and name the trusted earlier proof for it"
    expected: "A decision recorded against REQUIREMENTS.md:114 and :135."
    why_human: "Scope decision. Still open."
  - test: "W4: restate or retire the recorded label 'No verdict-level payload test'"
    expected: "A restated gap that names the missing test, or retirement of the label. service.test.ts:5386 asserts verdict-level fields."
    why_human: "The label has no definition in the repo beyond the prior record. Owner call."
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from stored rows, and the verified head is anchored.
**Verified:** 2026-11-03T12:49:50Z
**Status:** human_needed
**Re-verification:** Yes. Previous record 6644698e, status human_needed, score 8/8.

## Scope and method

- Worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `046fbe05`. Read-only: no code edits, no commits. The only write is this file.
- Changes since 6644698e: `046fbe05` only, a doc commit. `git diff --stat 6644698e 046fbe05` lists `docs/greptime-ledger.md` alone, one line (979). `packages/` is identical between the two commits, so the code references of the 6644698e record stand. See Judgement: 046fbe05 doc wording.
- Owner decisions taken into account: W-L1 refusal (d23a919a commit message, 2026-11-03); Q8 and N5 accepted as documented limits, not closed (6644698e, 2026-11-03). Both are judged as documented, not as closed.
- Targeted runs at 046fbe05 (one `bun test` command, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, `--timeout 30000`):
  1. `bun test packages/ledger/src/memo.test.ts packages/mcp-server/src/event.test.ts packages/mcp-server/src/anchor.test.ts`: **150 pass, 0 fail**, 513 expect calls, 1079 ms. Whole files ran, so every new surrogate test ran. Same count as 6644698e.
  2. Service named subset (`service.test.ts -t ...`, 32 pass, 0 fail): carried from 6644698e and not re-run this pass; the code is unchanged and the one-command limit applies. Includes Q8 (`service.test.ts:5843`).
- Ad hoc Bun probes, not run this pass (carried from 6644698e; code unchanged): the lone-surrogate regex on nine edge strings; `redact` idempotence on seven samples; the lone-surrogate hash comparison on four write fields (below).
- Debt markers (TBD, FIXME, XXX) in the changed files: none.
- Probes (Step 7c): none declared or present.
- Fingerprint: `gsd_run query verification.fingerprint` over the same 13 files as the prior record. The digest moved from `8a23…` to `bba5…`. The only covered file that changed is `docs/greptime-ledger.md` (one line, 046fbe05); the code files are identical to 6644698e.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1 | SC1: an edited payload, a deleted middle event, truncated last events and a full rewrite are each compared with the saved head; the first differing or first missing id is named | ✓ VERIFIED | Named runs pass in run 2: `service.test.ts:5386` (first_differing), `:5398` (middle deletion), `:5414` (truncation, first_missing), `:5513` (full rewrite). No chain-check code changed since f86388cf. |
| T2 | SC2: each graph's chain head is recorded in the hourly anchor and the recorded head is the trusted proof | ✓ PASSED (override) | Memo v2 `heads_root` (`memo.ts:41-46`), per-session head records (`packages/ledger/src/heads.ts`), trust against the on-chain root (`service.ts:8409`, `:8470`). Owner override 2026-11-02, commitment reading only; carried, acceptance not re-obtained. |
| T3 | G1: an anchored hour removed from `agent_events`, `event_ingest` and `graph_chain_leaves` fails the verdict and is named | ✓ VERIFIED for pointer-listed hours, bounded by Q8 and N5 (accepted limits) | Pass: `service.test.ts:5810` (1a), `:5819` (1b), `:5827` (single hour with pointer), `:5594` and `:5644` (rows and ingest removed, leaves kept). Q8 (`:5843`) pins `ok` true for a graph with no landed pointer; N5 is a pruned listing. Both are accepted limits, not closed. |
| T4 | The hourly job sends every closed hour's pointers for every graph id the write path accepts, so the job does not halt on a valid event | ✓ VERIFIED for NUL and lone surrogate at write and before send | NUL: `event.ts:244`, `anchor.ts:958-967`, tests `event.test.ts:309-311`, `anchor.test.ts:1519`. Lone surrogate: `event.ts:246` and `memo.ts:103`, tests `event.test.ts:314-342`, `memo.test.ts:156-166`. Accepted ids pass `redact` idempotently (probe), so the pre-send `normalizeIdentifier` equality holds. Pre-fix stored rows are open (stored-id item, below). |
| T5 | N1/W2: the hour is sent, then pointers, then the row; a pointer failure stores no row; an unanchored mismatch stores no row | ✓ VERIFIED | Whole-file pass of `anchor.test.ts`. Order `:1343`, pointer failure `:1363`, alarm `:473`, `:495`, `:518`. Code: alarm no row `anchor.ts:868-875`, adopt heads mismatch no row `:886-896`, pointers after read-back then row last `:1044-1056`. |
| T6 | N2: the adoption window covers the lookback's newer transactions | ✓ VERIFIED | Whole-file pass; regression `anchor.test.ts:1404`. Code `anchor.ts:850`, `:315` ((1 + g) x 168), `greptime.ts:1900-1905`. |
| T7 | N3: verify counts only job-key pointers that succeeded; other entries are ignored; a job-key pointer naming another hour still fails | ✓ VERIFIED (verify side) | Pass: `service.test.ts:5877`, `:5889`, `:5898`, `:5907`, `:5916`, `:5926`. Code `service.ts:875-893`, `:924-960`. Anchor side (`anchor.ts:633`, `:643`) still has no test (W-N3c). |
| T8 | Refused `SOLANA_RPC_URL`: no chain read, `ok` false, `trusted` false, a named reason | ✓ VERIFIED | Pass: `service.test.ts:4283`. Code `service.ts:8020-8025`, `config.ts:906-910`. |

**Score:** 8/8 truths verified (T2 counted as PASSED override). Presence-only truths: none. Behavior unverified: 0.

### Judgement: the lone-surrogate refusal (d23a919a) is closed at write and at the memo

- **Write.** `LONE_SURROGATE_RE` (`event.ts:222`) matches a high surrogate not followed by a low one, or a low surrogate not preceded by a high one. `normalizeGraphId` (`event.ts:241`) checks NUL first (`:244`), then the surrogate (`:246`), then the 512-byte cap. The class is `GraphIdLoneSurrogateError` (`:227`), an `InvalidEventError`, so `POST /events` answers 400 (`server.ts:2429`). The one graph id constructor is `normalizeEvent` (`event.ts:346`).
- **Buffered path.** Events are built before they are buffered (`service.ts:3124` builds, `:3177` enqueues `build: () => event`). A new buffered event cannot carry a lone surrogate. Only pre-fix durable entries replay unnormalised (W-B2b, stored-id item).
- **Memo.** `formatMemoV3` (`memo.ts:99`, check `:103`) refuses it too. Its only production caller is `pointerPlans` (`anchor.ts:553-562`), which runs pre-send at `anchor.ts:958-967` and again for the real signature at `:1045`. A refusal there stops the hour before any transaction goes out.
- **Regex.** Nine edge strings, probed: a well-formed pair, an astral code point, U+10FFFF and plain ids are accepted. A lone high at the end, a lone low at the start, a high followed by a high, a low after a pair and a low before a pair are refused, each naming the first offending code unit. Matches the named tests.
- **Named tests.** `event.test.ts:314`, `:319`, `:324` (high followed by high), `:328` (named subclass), `:339` (accept astral and pair); `memo.test.ts:156` (refusal naming the code unit), `:166` (round trip of astral ids). All in run 1.
- **Accepted-id consistency.** Any id accepted by `normalizeGraphId` is at most 512 UTF-8 bytes, so at most 512 UTF-16 units. `clean` cuts to 512 units and `redact` is idempotent on the samples probed, so `pointerPlans`' `normalizeIdentifier(graphId) === graphId` holds for every id the write path accepts. [INFERENCE for `redact` idempotence beyond the seven samples.]
- **Gap (warning, W-L1t).** No anchor-level lone-surrogate test exists beside `anchor.test.ts:1519`. The pre-send refusal is covered only at the memo layer. A fixture would need a stored lone surrogate, which only pre-fix state can produce, so the gap is in coverage, not in the refusal.

### Judgement: 046fbe05 doc wording (line 979, phase 76 buffer section)

- **Changed text.** The keyed-replay parenthetical now says "appends no event" where it said "is not a write". The first `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` mention now names the accepted values. Both are precision fixes; neither changes the meaning.
- **Replay.** `replayOutcome` (`service.ts:3056-3089`) returns `deduplicated` with no insert, and `appendChained` returns it (`:3097-3099`) before the tip read (`:3113`). A failed lookup returns at `:3110`, also before the tip read and with no insert. The lookup runs only when `mode` is `enforce` or the replay option is set (`:2993`), the case the parenthetical describes. Holds.
- **Allowed values.** `allowDeduplicatingLedger` matches `/^(1|true|yes)$/i` (`config.ts:1194`). Holds.
- **Cache switch.** `SUBSTRATE_LEDGER_CHAIN_CACHE` is off for `0|false|no` (`config.ts:2439`), which leaves `chainTips` null (`greptime.ts:798`). With it off, every session write reads the tip (`greptime.ts:1484`), and a failed read refuses at `service.ts:3126-3128` before any buffering. Holds.
- **Cache on (code read, not tested).** A failed insert deletes the cached tip (`greptime.ts:1287`), so the next write re-reads it and is refused while the tip is unreadable. Matches the sentence.
- **Append-mode gate.** `service.ts:3133-3138` returns unbuffered on refusal, as the doc says. Holds.
- **Verdict effect.** None. The line sits in the phase 76 section (`docs/greptime-ledger.md:963-982`), outside the v3 section (`:577-593`) this phase judges. No code changed.
- **Spot-checks at 046fbe05.** Code is unchanged, so the 6644698e references were rechecked: event.ts `:222`, `:227`, `:244`, `:246`, `:346`; memo.ts `:96`, `:103`; anchor.ts `:85`, `:553-562`, `:958-967`; service.ts `:887-888`, `:917-918`, `:8020-8025`; config.ts `:1207`; service.test.ts `:5843`. `anchor.test.ts` has no surrogate test (W-L1t stands). `summary`, `session_id` and `repo` have no surrogate refusal at write (W-L2 stands).

### Judgement: Q8 and N5 are accepted limits, not closed

- **Q8.** `service.test.ts:5843` pins a graph whose only hour lost its pointer and its rows: `ok` true, `trusted` false, reason `no events`. `readPointerChecks` returns no pointers and `verifyGraph` finds no events. This is a literal miss of "deletion is detected" for a graph with no landed pointer. Accepted by the owner on 2026-11-03 and written in `docs/greptime-ledger.md` (v3 section). A consumer must read `trusted`, not `ok` alone, for this case. Not closed.
- **N5.** `service.ts:917-918` fails closed only when the pointer listing is incomplete (budget or page cap). A complete listing that lacks an old pointer passes that hour. No test pins it; the depth is unmeasured (operator item 4). The docs state it. Accepted, not closed.
- **Effect on the goal sentence.** "Deletion is detected" holds for hours whose pointer the RPC lists, and for graphs with at least one landed pointer. Under the owner's acceptance this does not block the phase. It must be read as an exception to the goal sentence, not as a closure of it.

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/ledger/src/memo.ts` | v3 format, byte-capped id, tail-anchored parse, lone-surrogate refusal | ✓ VERIFIED | `:96` regex, `:103` refusal, `:82` cap, `:106-122` parse. `parseMemoV3` does not refuse: argv-read memos are UTF-8 and cannot carry a lone surrogate. |
| `packages/mcp-server/src/event.ts` | Write-time byte cap, NUL and lone-surrogate refusal | ✓ VERIFIED | `:222` regex, `:227` class, `:244` NUL, `:246` lone surrogate, `:248-250` byte cap, `:346` sole graph id constructor. |
| `packages/mcp-server/src/anchor.ts` | Pre-send plan, NUL and surrogate refusal, adopt, alarm, pointers, window | ✓ VERIFIED | `pointerPlans` `:553-562`; pre-send `:958-967`; post-read-back pointers `:1045`; alarm `:868-896`; window `:315`, `:850`. |
| `packages/mcp-server/src/service.ts` | Pointer judgement, RPC guard, buffer enqueue after normalisation | ✓ VERIFIED | `:875-893`, `:917-960`, `:3124`, `:3177`, `:8020-8025`. Unchanged since 97defd59. |
| `packages/mcp-server/src/greptime.ts` | `lookbackGraphCount`, sole `agent_events` writer | ✓ VERIFIED | `:1900-1905`; `insertEvent` `:1248`, INSERT `:1282`. Unchanged. |
| `docs/greptime-ledger.md` | Memo v3 section: pointers, cap, refusals, accepted limits | ✓ VERIFIED | v3 section (`:577-593`) states the NUL and lone-surrogate refusal and Q8, N5 as owner-accepted limits (6644698e). |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `normalizeEvent` | `normalizeGraphId` | `graph_id` at event.ts:346 | ✓ WIRED | NUL and lone surrogate refused at write. |
| `normalizeGraphId` | `formatMemoV3` | stored id carried whole in the pointer | ✓ WIRED | Byte cap, NUL and lone surrogate each refused upstream and again in `formatMemoV3`. |
| `pointerPlans` | hour transaction | refusal before any send | ✓ WIRED | `anchor.ts:553-562`; pre-send `:958-967`. |
| buffered write | `normalizeEvent` | build before enqueue | ✓ WIRED | `service.ts:3124`, `:3177`. |
| `checkAdopt` window | `lookbackGraphCount` | `(1 + g) x 168` | ✓ WIRED | `anchor.ts:315`, `:850`. |
| `judgePointer` candidacy | `readPointerChecks` | ignored entries neither verified nor failed | ✓ WIRED | `service.ts:887-888`. |
| `verifyGraph` guard | `hourReport` | refused RPC returns before any read | ✓ WIRED | `service.ts:8020-8025`. |
| SQL transport (`insertEvent`) | stored `graph_id` and other text fields | form-urlencoded body via `URLSearchParams` | ⚠️ PARTIAL | A lone surrogate is stored as U+FFFD for every text field, not only graph id. See W-L2. |

## Data-Flow Trace (Level 4)

Chain and pointer data come from the store (`readEvents`, `hourLeaves`, `graphChainLeafHours`) and from RPC (`addressSignaturePage`, `transactionMemo`). Real queries, not static returns: ✓ FLOWING. The pointer memo's graph id comes from the store read (`readHourHeads` → `eventsByIds`), so a stored NUL or over-512 id is refused by `pointerPlans` before any send (test `anchor.test.ts:1519`).

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Memo, event and anchor targeted run | `bun test` on memo.test.ts, event.test.ts, anchor.test.ts | 150 pass, 0 fail | ✓ PASS |
| Service named subset (criterion 1, G1, Q8, N3, RPC guard, no events) | `bun test service.test.ts -t "..."` (run at 6644698e, carried) | 32 pass, 0 fail | ✓ PASS (carried) |
| Lone-surrogate regex edge cases | ad hoc Bun probe, nine strings | pairs, astral and U+10FFFF accepted; each lone surrogate refused by its code unit | ✓ PASS |
| `redact` idempotence on accepted-id samples | ad hoc Bun probe, seven strings | idempotent on all | ✓ PASS |
| Lone surrogate in `summary`, `session_id`, `repo` | ad hoc Bun probe: `normalizeEvent`, then `eventHash` of in-memory event vs the U+FFFD round-trip form | accepted at write; hashes differ for all three | ✗ FAIL (W-L2) |
| `graph_id` with lone surrogate at write | ad hoc Bun probe through `normalizeEvent` | refused, `graph_id_lone_surrogate`, U+D800 | ✓ PASS |

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
| `packages/mcp-server/src/event.ts` | 346 and `normalizeEvent` text fields | Lone surrogate accepted in `summary`, `session_id`, `repo` | ⚠️ Warning | W-L2: fail-closed false verify on affected graphs. |
| `packages/mcp-server/src/anchor.test.ts` | 1494-1530 | No lone-surrogate test beside the NUL test | ⚠️ Warning | W-L1t: coverage gap at the pre-send layer. |
| `packages/mcp-server/src/anchor.ts` | 633-643 | Anchor-side payer and err skip in `completePointers` untested | ⚠️ Warning | W-N3c |
| `packages/ledger/src/memo.test.ts` | 231-241 | Transaction overhead hand-counted, not measured from `transferArgv` | ⚠️ Warning | B1 model unverified against the CLI's layout (operator item 2). |

No 🛑 blockers. Debt markers: none.

## Warnings and new findings (not gaps)

- **W-L2 (new, scope extension). Lone surrogate in other write-path text fields.** d23a919a refuses a lone surrogate in `graph_id` only. Probe: `summary`, `session_id` and `repo` are accepted at write, and for each the in-memory `eventHash` differs from the hash of the U+FFFD form the store keeps (SQL transport replaces it, shown in the prior record's probe). The event hash is taken over the surrogate form (`eventHash` over `canonicalJson`, event.ts:36-37), so a stored row no longer recomputes to its hash. Consequence: `verifyChain` fails that graph, so verdict `ok` false and `trusted` false, fail closed. It is not a tamper miss. [INFERENCE for no halt: the hour root reads the stored hash column (D73-03 note), and heads come from store reads, so the hourly job does not halt on these rows. Not observed in a live store.] Owner decision: extend the refusal to every write-path text field, the same remedy as W-L1, or record the fail-closed verdict as accepted. Not fixed here: this pass is read-only.
- **W-B2b (carried, stored state). Buffer replay skips normalisation.** `service.ts:3214` replays durable entries through `insertEvent` without `normalizeEvent`. New entries are normalised before they are buffered (`:3124`, `:3177`), so only pre-fix durable entries can reach the store unchecked. Buffer off by default. Part of the stored-id item.
- **Stored-id item (carried; no repair decided).** Pre-fix rows with a stored NUL or over-512 graph id halt a live anchor run at the first such hour (pre-send `anchor.ts:958-967`; every later hour waits). Pre-fix rows with a lone surrogate are stored as U+FFFD, so they are indistinguishable from real U+FFFD in a scan. Operator check: `SELECT count(*) FROM agent_events WHERE octet_length(graph_id) > 512`, and a NUL scan on `graph_id`.
- **W-N3b (carried).** Third-party grief at a graph's index address. Verify fails closed (budget exhausted, `service.ts:937`). Open.
- **W-N3c (carried).** The anchor-side N3 skip (`anchor.ts:633`, `:643`) has no test.
- **W-N4 (carried; owner decided fail closed).** Verify needs devnet even with no anchored hour (`service.ts:912-916`). Decided; no change.
- **W-N6 (carried).** `POINTER_REFUSED_RE` (`anchor.ts:85`) matches any "transaction simulation failed". Refusal text unobserved (operator item 1).
- **W-N7 (carried, partial).** `73-MEMO-V3-DESIGN.md` does not carry the deviations listed in the 9ab6f111 commit message. Open.
- **W-N8 (carried).** Budget not measured for a year-old graph (`config.ts:1207`). Operator item 5.
- **Read-side cut (carried).** `normalizeIdentifier` still cuts a longer id to 512 units on reads (`event.ts:198-200`), so a read of an over-long stored id can match another graph. Open.
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
7. **W-L2: lone surrogates in `summary`, `session_id` and `repo`.** Refuse at write, as `graph_id` is refused, or accept the fail-closed verdict.
8. **HARD-S3: scheduled verification.** Scope decision recorded against `REQUIREMENTS.md:114` and `:135`.
9. **W4: restate or retire the recorded label.**

Accepted limits, recorded and not closed (owner-accepted 2026-11-03; no human item):

- **Q8.** A graph whose only hour lost its pointer and rows verifies `ok` true, `trusted` false, `no events` (`service.test.ts:5843`).
- **N5.** A pruned RPC history for an index address passes the hour for hours older than that depth (`service.ts:917-918`).

## Open items (named, kept open)

- **Phase 73 N5.** Accepted limit; depth unmeasured (operator item 4).
- **Phase 73 Q8.** Accepted limit; pinned by `service.test.ts:5843`.
- **Phase 73 W3, W4, W5, HARD-S3, N6, N8.** Open, as above.
- **Stored over-512-byte, NUL, or pre-fix lone-surrogate graph ids.** No repair decided. Blocks a live anchor run against a store that holds such rows. Operator item 3; owner item 6.
- **W-L2 (new).** Lone surrogate in other text fields. Owner item 7.
- **W-L1t, W-B2b, W-N3b, W-N3c, W-N7, read-side cut.** Warnings above.
- **Live devnet sends and live store scans.** Operator items 1 to 5.
- **Phases 72, 75, 76, 77, 78.** Not re-judged here.

## Does any open item block the phase goal?

- **No code-level item blocks the goal as ROADMAP states it.** SC1 (T1) and SC2 (T2, by override) hold; T3 holds for pointer-listed hours; T4 and the surrogate refusal are closed for graph ids at write and at the memo.
- **Q8 and N5 are exceptions to "deletion is detected."** The owner has accepted both as documented limits. They do not block under that acceptance, but they bound the claim and must be quoted with it.
- **The stored-id item is the one open item with a blocking effect, and it is operational.** It halts a live anchor run on any store that holds an over-512 or NUL graph id, so the anchored-head half cannot proceed there until the owner decides. It does not block the verification code.
- **Live anchoring has not run (D73-05).** The anchored half is proven against the fake runner and fake Greptile only. Operator items 1 and 2 gate production readiness; they are not code blockers.
- **W-L2 does not block the goal.** It fails closed (a false verify on affected graphs) and never hides a tamper. It is a correctness defect the owner should decide alongside W-L1.
- **HARD-S3 does not block the ROADMAP goal sentence or SC1/SC2.** It blocks closure of the HARD-S3 requirement.

## Gaps Summary

No gaps. No truth is FAILED. No artifact is MISSING or STUB. No key link is NOT_WIRED. No 🛑 blocker. The status is `human_needed` because the human-verification section is non-empty (operator checks, owner decisions on the stored-id item, W-L2 and HARD-S3, and the W4 label), not because of a failed truth.

## Verdict

**Status: human_needed.** Score 8/8 truths verified (T2 by override). W-L1 and W-DOC are closed. Q8 and N5 are accepted limits, not closed. New warning W-L2 is recorded for the owner. No change in verdict at 046fbe05: the one doc line changed sits in the phase 76 buffer section, outside the phase 73 v3 section.

---

_Verified: 2026-11-03T12:44:59Z_
_Verifier: Claude (gsd-verifier)_
