# Phase 73: memo v3 design note (whole-hour removal, gap G1)

Status: design only. No code, no tests, no commit. Owner direction (2026-11-03): design and build, with the graph identity in the clear.
Tree: `/root/src/worktrees/as-gsd-v18-all`, HEAD `3f59de81`. Citations are `file:line` at that HEAD. Lines marked (c7788f9d) come from `73-VERIFICATION.md`, which used that commit.

## 0. Summary

- G1 is real in the code. `verifyGraph` learns a graph's hours from three store tables: its event rows, its `event_ingest` records and its `graph_chain_leaves` rows. Empty all three for one anchored hour and that hour leaves the verdict. The hour's anchor is still on chain, but no per-graph path reads it.
- The chain can only tell a graph's hours if the verifier can ask it. Solana cannot filter memos by content, so v3 needs an index.
- Proposal: v3 is a per-(graph, hour) pointer transaction. Its memo carries the graph id in the clear and is sent to an address derived from that graph id. The verifier lists that address to get the graph's anchored hours, without reading the store for the hour list. The hour-level v1/v2 transaction is unchanged.
- Cost: one extra devnet transaction per graph per anchored hour (5,000 lamports each), a verify cost that grows with the graph's hours, and about 1,300 changed lines (660 production, 550 test, 120 docs; section 8).
- Nothing shows a v2 memo on a live chain (section 4). Dev or devnet v2 hours with no pointers are reported as pre-index.
- Nine owner decisions are open (section 9).

## 1. The problem: a whole-hour removal passes today

### 1.1 What the attack removes

"Whole anchored hour" means, for one hour H: the graph's `agent_events` rows with `ts`/ingest in H, its `event_ingest` records, and its `graph_chain_leaves` rows. The `anchors` row and the devnet memo are untouched. The threat model names these three tables (`73-VERIFICATION.md:53`).

### 1.2 How `verifyGraph` decides what to check

| Step | Code | Effect when H is removed |
| --- | --- | --- |
| Read rows by stored graph id | `service.ts:7852` | H2's rows gone |
| Chain check per session, on rows only | `service.ts:7863-7872`, `event.ts:480-494` | H1's prefix still verifies, so `chain.ok` is true |
| Hours from rows that have ingest records | `service.ts:7950-7974` (`byHour`) | H2 absent |
| Hours from this graph's leaves | `service.ts:8035-8040`, `greptime.ts:1869-1878` (`graphChainLeafHours`) | H2 absent |
| Gap and missing sets | `service.ts:8058-8059`, `8188-8190` | both empty, since rows and ingest agree |
| Anchor row read, per hour in the set only | `service.ts:8215-8236`, `8473` (`anchorForPeriod`) | H2's row never read |
| `ok` | `service.ts:8243` | true |
| `trusted` | `service.ts:8268` | true when H1 is trusted |

`anchorsBetween` (`greptime.ts:1787`) is the only store-wide reader of `anchors`. Its callers are the anchor job (`anchor.ts:525`), `anchorCoverage` (`greptime.ts:2120`), `exportWindow` (`greptime.ts:2256`) and the re-anchor planner (`reanchor-plan-run.ts:348`). None is on the `verifyGraph` path.

### 1.3 Why the chain does not catch it

H2's hour memo commits to the heads of every graph in H2 (`memo.ts:42-46`, `anchor.ts:758`). Nothing computes "which hours does graph G have" from the chain, so H2's memo is never fetched for G. `trustHour` compares leaves only for hours already in the set (`service.ts:8288-8378`, called at `8239`).

### 1.4 Two related holes

- **Zero rows.** With no rows, ingest or leaves, `byHour` is empty, `failing` is undefined and `ok` is `chain.ok`, which is true (`service.ts:8243`). The CLI then prints `chain intact for G (0 events)` and exits 0 (`cli/src/index.ts:272-274`, `:297`). This is the single-hour form of G1.
- **Partial deletes are caught.** Removing rows but keeping ingest is caught by the missing-set check (`service.ts:8189-8190`). The gap is the removal of all three.

### 1.5 The probe

No file named `G1Probe` exists in the worktree or in `/root/src/worktrees/backups` (a grep of `packages/`, `scripts/`, `.planning/phases/`, and the backup text files found nothing). The scenario is the one `73-VERIFICATION.md:85-91` describes: anchor two hours, remove the second from the three tables, run verify. The code predicts `ok` true. I did not execute it. Section 7 defines it as a unit test.

## 2. Memo v2 as built

### 2.1 Format

| Memo | Format | Source |
| --- | --- | --- |
| v1 | `substrate:v1:<hour ISO>:<root>:<count>` | `memo.ts:9-10`, `formatMemo` `:36-39` |
| v2 | `substrate:v2:<hour ISO>:<root>:<count>:<heads_root>` | `memo.ts:11-12`, `formatMemoV2` `:42-46` |

`parseMemo` accepts v1 and v2 only (`memo.ts:61-68`). `memo.test.ts:110` pins `substrate:v3:` as unknown. Both regexes are anchored, and the ISO contains colons, so nothing is split on `:`.

### 2.2 Who writes it and where it goes

- `anchorMemo` writes v2 when a graph owns at least one event in the hour, otherwise v1 (`anchor.ts:473-476`).
- `root` and `count` are the digest over all events in the hour, all graphs together (`anchor.ts:758`).
- `heads_root` comes from `readHourHeads` (`anchor.ts:455-467`) and `buildGraphHeads` (`anchor.ts:396-440`): one record per `(graph_id, session_id)`, and one leaf per event.
- The send is `solana transfer <job pubkey> 0 --with-memo <memo>` (`solana.ts:35-63`, `AMOUNT_ZERO` at `solana.ts:12`). The job key is payer and recipient, so it appears in every anchor transaction.
- One transaction per hour. After read-back (`anchor.ts:796-819`), `storeAnchor` writes the leaves and then the row (`anchor.ts:479-482`, `:822-826`).

### 2.3 What the chain proves

- The hour's root and count, and the `heads_root` over `(graph, session)` records, were signed by the job key. The signer is judged by the signer set at block time (`service.ts:8518-8529`).
- Records are hashed (`heads.ts:25-46`). The chain carries no graph id, so the chain cannot say which graphs an hour holds. Listing the job key returns every anchor transaction, all graphs (`rpc.ts:227-242`).
- The chain does not prove the stored leaves are the real events. A verifier must recompute the leaves and see them reproduce `heads_root` (`service.ts:8328-8334`). The leaves are a store object, so deleting them is the attack.

### 2.4 What the verifier recomputes locally

- Each row's content hash, not the stored column (`service.ts:8346-8350`, `event.ts:36-38`).
- The leaves rebuilt into records (`event.ts:404-428`), which must reproduce `heads_root` (`service.ts:8331-8334`).
- Each pair against its record (`compareToAnchoredHead`, `event.ts:444-474`).

## 3. Memo v3

### 3.1 Why v3 is a per-graph transaction

The hour memo cannot carry graph identity. It is one memo per hour across all graphs (`anchor.ts:758`, one `anchors` row per hour, `greptime.ts:1818-1827`), and a list of graph ids in it has no bound. Identity in the clear therefore needs one transaction per (graph, hour). The hour transaction stays as it is, because the hour root covers all graphs and `checkHour` compares it (`service.ts:8546-8559`).

### 3.2 Exact fields

Format:

`substrate:v3:<graph_id>:<period_start_iso>:<count>:<graph_heads_root>:<hour_tx_sig>`

| Field | Source | Rule |
| --- | --- | --- |
| `graph_id` | `normalizeIdentifier` (`event.ts:197-199`, `clean` `:180-184`, `MAX_FIELD` 512 at `:168`) | Stored form. Free text, may contain `:`, spaces or newlines. |
| `period_start_iso` | the hour, as in v1/v2 | Whole UTC hour, 24 characters (`memo.ts:49-55` shape). |
| `count` | events of this graph in the hour | Integer, at least 1. |
| `graph_heads_root` | `headsRoot` over this graph's records only (`heads.ts:59-71`) | 64 lowercase hex. The same function as the hour root, filtered to one graph. |
| `hour_tx_sig` | signature of this hour's v1/v2 transaction, sent first | Base58. Lets the verifier locate the hour from the chain, not from the `anchors` row. |

Parser: `^substrate:v3:([\s\S]+):(\d{4}-\d\d-\d\dT\d\d:00:00\.000Z):([1-9]\d*):([0-9a-f]{64}):([1-9A-HJ-NP-Za-km-z]{64,90})$`. It is tail-anchored. The verifier also requires the parsed graph id to equal the id it listed, so a mis-split cannot pass.

Index address: `graphIndexAddress(G)` = base58 of SHA-256 over `"substrate:graph-index:v1\n" + G`. It is 32 bytes, holds no key, and never signs. Its only job is to appear in the account keys of G's pointer transactions.

The v2 hour memo is unchanged. v3 adds pointers beside it; it does not replace it.

### 3.3 The index

| Option | Where it lives | Verify cost | Trust | Assessment |
| --- | --- | --- | --- | --- |
| **A. Per-graph index address** (recommended) | Chain: pointer transaction names the index address in its account keys | `ceil(P/1000)` listings, plus `P` confirmations. P is G's hour count. | Chain | Solana's docs define `getSignaturesForAddress` as transactions that "reference the supplied address in `accountKeys`", limit 1 to 1000 (external docs, checked). Cost is O(G's hours). |
| B. Filter the job key's listing by graph id | Chain: memos in the job key's listing | `ceil(T/1000)`, T = all anchor transactions, all graphs | Chain | No extra account. Cost is O(all history of all graphs). |
| C. Local table `graph_anchor_index` | GreptimeDB | one query | None: the same writer can delete rows | Only a cache of pointers already confirmed on chain. It cannot be the trust source, which is the premise of G1. |
| D. Store-wide scan, no identity | Chain: every anchored hour since coverage start | one `getTransaction` per hour, all graphs | Chain | No new transactions, no v3. Any missing hour fails every graph's verdict, and cost grows with store age. |

A is recommended. Option B is the fallback if the owner rejects the extra transactions. Option D is the cheapest to build and does not meet "per graph".

Note the owner's identity-in-the-clear requirement is necessary but not sufficient. Without an index, identity in the memo still needs a listing of everything (option B). The index is what makes the lookup O(G).

### 3.4 Cost of option A

- **Fees.** Each pointer is one signature, 5,000 lamports (`anchor.ts:73-75`). With g graphs active every hour: g × 8,760 × 5,000 lamports a year. That is 0.44 SOL a year at g=10 and 4.38 SOL at g=100. Devnet only, under the existing devnet guard.
- **Transactions.** 1 + g per anchored hour, sent serially, one runner call each (`anchor.ts:774-776`).
- **Index account.** The pointer transfers 0 lamports to an unfunded address. `transferMemoArgv` already passes `--allow-unfunded-recipient` (`solana.ts:59`). Whether the runtime accepts a 0-lamport transfer to a nonexistent account is [INFERENCE] and needs a devnet probe. The fallback is to fund each index account once with the rent-exempt minimum, 890,880 lamports (`anchor.ts:73-75`).
- **Verify RPC.** One listing page per 1000 pointers, and one `getTransaction` per pointer. A graph with 8,760 hours costs 8,760 confirmations on every verify. That exceeds any verify budget (`service.ts:7847`, `8223`). See Q2.
- **Adoption window.** Pointers have the job key as payer, so they appear in the job key's listing too. `checkAdopt` reads only the newest `ADDRESS_MEMO_LIMIT` = 100 (`anchor.ts:68`, `:295`). With g=10 that covers about 9 hours, against a 168-hour lookback (`anchor.ts:65`). See Q6.
- **Re-anchor.** A devnet reset removes pointers with everything else. The re-anchor path validates only v1/v2 (`reanchor.ts:27-28`, `:510-527`) and must learn v3 (section 8).
- **Storage.** No new table. `greptime.ts` changes nothing, so D73-06 is unaffected.

### 3.5 Send order (per hour)

1. `readHourHeads` (`anchor.ts:752`).
2. Send the hour transaction, v1 or v2 (`anchor.ts:758-781`).
3. Read it back (`anchor.ts:796-819`).
4. For each graph with events in the hour, send its pointer with `hour_tx_sig`, and read each back.
5. `storeAnchor`: leaves, then the row (`anchor.ts:822-826`).

A pointer failure stops the hour before its row is stored. The next run must finish the pointers before it sends anything new, the same rule as `store-failed` (`anchor.ts:700-706`). The adopt path (`anchor.ts:657-710`) must check and complete pointers too. Today it does not check heads at all (`73-VERIFICATION.md:120`, W2).

## 4. Migration

### 4.1 Is any v2 memo on a live chain?

No, by the records and the code. I did not read the live chain or the production store, so this is inference from records, not a chain observation.

Evidence:

1. **Code.** `formatMemoV2` is reached only through `anchorMemo` (`anchor.ts:473-476`). That is called in the job's send path (`anchor.ts:758`) and in the re-anchor comparison (`reanchor.ts:525`). The comparison does not send. The job runs only from `runAnchorJob` (`anchor.ts:489`), which the timer runs.
2. **Timer and key.** `59-eternal-logging/VERIFICATION.md:32`: "no anchor transaction was sent, the key holds 0 SOL, the timer is not installed". Line 41 lists "any decision on a re-anchor mode or memo v2" as not taken. `STATE.md:580` holds "funding the anchor key, installing the anchor timer, any devnet send and the re-anchor send" as HARD_STOP, not performed.
3. **Phase 73's own records.** `73-CONTEXT.md:29` (D73-05: no devnet transaction is sent, no production DDL). `73-VERIFICATION.md:53` and its human items. Commit `4942b159`: "v2 is not yet anchored on any live chain" (2026-11-01).
4. **History.** v2 was introduced in `102e4007` (2026-11-01). `git log -S "substrate:v2:"` lists only code, test and doc commits. I searched their diffs for base58 strings of 80 to 90 characters and found no transaction signature.
5. **The first v1 send is also unrecorded.** The phase 28 live proof L1 to L10 is `behavior_unverified` (`28-PROOF-ADDENDUM.md:16`). `STATE.md:578` records that the devnet genesis constant was wrong since phase 28, which would have refused real devnet; the fix is `ccbfff2c` (2026-10-26).

Read-only checks the owner should run before any v3 cutover (not run here):

- Each store: `SELECT count(*) FROM anchors WHERE memo LIKE 'substrate:v2:%'`.
- Devnet: `addressMemos(<job pubkey>)` paged, keeping memos that start `substrate:v2:`.

A zero from both, and an uninstalled timer, closes the question. `ADR 0006` line 47 proposes a different "memo v2" (per-checkpoint). That name is already taken by the hour memo. Update the ADR when v3 lands.

### 4.2 What v3 does with v2 anchors that exist on dev or devnet

- **Hour transactions stay valid.** `checkHour` and `trustHour` read the v2 hour transaction exactly as now (`service.ts:8533-8559`, `:8332`).
- **They have no pointers.** New rule (section 5, step 7): if a graph has events in a v2 hour and the chain holds no pointer for it, that graph's verdict is a mismatch, reason "pre-index v2 hour". Dev stores therefore report `ok` false until re-anchored or re-seeded. No backfill code.
- **v1 hours are unchanged.** They stay untrusted, `ok` unchanged, as `service.ts:8302-8306` and `docs/greptime-ledger.md:565` say.
- **Readers.** `parseMemo` keeps v1 and v2 and still rejects v3 (`memo.ts:61-68`). Pointers get a separate parser, so a v2 reader never reads one as an hour memo. `checkAdopt` already skips memos that do not parse (`anchor.ts:299-300`).

## 5. The verify algorithm, step by step

Starts from the same whole-verify budget as today (`service.ts:7847`, `8223`).

1. Read G's rows, ingest and leaves hours, as today (`service.ts:7852`, `7950-7974`, `8035-8040`).
2. List G's index address with `addressMemos`, paged, `confirmed` commitment (`rpc.ts:227-242`). Keep entries that parse as v3 with graph id equal to G.
3. Confirm each kept entry with `transactionMemo`: payer equals `SOLANA_ANCHOR_PUBKEY`, `payerSigned`, `err` null, signer judged at block time as in `checkHour` (`service.ts:8518-8529`). A failed entry is a mismatch naming its signature.
4. Group by period. Two entries for one (G, period) with different `(count, graph_heads_root, hour_tx_sig)` are a mismatch, "fork". Identical duplicates collapse.
5. Hour set = the store's hours (step 1) ∪ the pointers' periods.
6. For each pointer period, read the hour transaction by the pointer's `hour_tx_sig`, not from the `anchors` row. It must be a v2 memo for that period (a v1 hour is a mismatch: "pointer names a v1 hour"). Apply `checkHour`'s checks to it: period, root, count, signer.
7. For each store hour with no pointer for G: if the hour is v2 and G has events in it, mismatch, "pre-index v2 hour". If it is v1, untrusted as today. Pending and unanchored stay as today.
8. For each pointer period: rebuild G's records from G's leaves in that hour (`headRecordsFromLeaves`, `event.ts:404-428`, filtered to G). No leaves: mismatch, "anchored hour holds N events of G on chain; the store has none" (N = `count`). Otherwise `headsRoot(G's records)` must equal `graph_heads_root`, and the leaf count must equal `count`. Otherwise mismatch, "stored leaves do not reproduce the pointer".
9. Per session: `compareToAnchoredHead` as today (`event.ts:444-474`), using G's records and G's rows.
10. Keep the hour-level check: the hour transaction's `heads_root` must reproduce from all graphs' leaves (`service.ts:8331-8334`). Its failure marks the hour a mismatch for every graph in it (Q7).
11. `ok` = today's `ok` plus any mismatch from steps 3, 4, 6 to 10. `trusted` = every hour in the set has a verified pointer and hour transaction, every pair is trusted, and no step was cut by the budget.
12. Zero rows and zero pointers: `ok` true, `trusted` false, reason "no events". This is the residual in section 6, row 6, and Q8. Zero rows with at least one pointer: `ok` false.
13. Budget: each read in steps 2 to 10 runs under the whole-verify budget. Expiry gives "budget exhausted", untrusted, `ok` false, as today (`service.ts:8326`, `8243`).

## 6. Failure modes

| # | Case | Today | With v3 | Residual |
| --- | --- | --- | --- | --- |
| 1 | Graph with no anchors; rows in an open hour | pending, `ok` true, `trusted` false | same | none |
| 2 | Graph with rows in a closed v2 hour and no pointer | `ok` false, unanchored | `ok` false, "pre-index v2 hour" | none |
| 3 | Anchored hour whose rows, ingest and leaves are gone, the only graph in it | `ok` true (G1) | `ok` false, mismatch naming the hour | none once the pointer exists; see 8 |
| 4 | Anchored hour emptied for G, other graphs keep events in it | G `ok` true; the others `ok` false (`headsRoot` mismatch) | G `ok` false from its pointer; the others unchanged | none |
| 5 | Anchored hour with no events for any graph | invisible | invisible unless a pointer exists | graph-less hours have no pointer. An empty memo is unrepresentable (`count` ≥ 1, `memo.ts:10`, `:12`). Only option D covers it. |
| 6 | Store lost a whole graph; graph id known | `ok` true, "chain intact (0 events)" | `ok` false from the pointers | a graph lost before its first anchored hour has no pointer. `ok` true, `trusted` false, "no events". Accepted residual, Q8. |
| 7 | Store lost the graph and the `anchors` table | as 6 | as 6, because pointers carry `hour_tx_sig` and need no `anchors` row | none |
| 8 | Pointer write lost after the hour transaction | adopt path misses it (W2) | no row stored; the next run completes pointers first (section 3.5); adopt path checks pointers | until repaired, the hour fails as pre-index |
| 9 | Devnet reset, or a pruned RPC with no history | unaffected | pointers unlisted, so every graph's v2 hour fails as pre-index | false alarm. Needs a re-anchor of pointers, or an archival RPC. |
| 10 | Two pointers for one (G, hour) with different content, after a lost read-back | n/a | mismatch, "fork" | none |
| 11 | Long-lived graph, P large | one check per hour | P listings and P confirmations; budget exhausted gives `ok` false | Q2 |
| 12 | Graph id near the 512-character cap | n/a | pointer about 710 bytes [INFERENCE: inside the 1232-byte transaction limit; test it] | Q4 |
| 13 | Redaction changes the graph id | normalised at write and read (`event.ts:197`) | pointer and index address use the same normalised id | none |

## 7. Test plan

Use the existing fixtures: `service.test.ts` heads-trust block `:5175`, helpers `v2World` `:5182`, `anchorOf` `:5214`, `stubOf` `:5230`, `verify` `:5243`, constants `H` `:4169`, `START_ISO` `:4171`. Targeted `bun test` only. The gate is the orchestrator's.

1. **G1Probe, two hours.** Graph `ut-1`, hours H1 and H2, each with a pointer. Remove H2 from `readEvents`, `graphIngest`, `hourChainLeaves`, `graphChainLeafHours`, `hourLeaves`, and the `anchorForPeriod` row. Expect `ok` false, `hours` contains H2 as a mismatch, `trusted` false. Expected before the change: `ok` true, the probe fails. After: passes.
   - Variant 1a: keep H2's `anchors` row.
   - Variant 1b: remove it too. The verdict must still name H2, because the pointer carries `hour_tx_sig`.
2. **Leaves-kept case.** The existing test at `service.test.ts:5518` must still pass. Add: with H2 absent from `graphChainLeafHours`, the verdict still names H2 through its pointer.
3. **Single-hour case.** One pointer hour. Remove rows, ingest, leaves and the row: `ok` false naming H. Second variant with no pointer: `ok` true, `trusted` false, "no events". This pins the residual in row 6.
4. **Pointer checks.** Fork (two contents, one period), duplicate identical entries (collapse), pointer signed by another key, count 0, bad ISO, graph id mismatch: each a mismatch.
5. **Memo.** v3 round trip; graph ids containing `:`, newline, ISO-shaped text, and 512 characters. v1 and v2 unchanged (`memo.test.ts:45`, `:72-110` pattern).
6. **Adoption window.** A listing of 100 entries, most of them pointers, still adopts the hour memo once the window is raised (Q6).
7. **Send order.** Fake runner: hour transaction, then pointers after read-back. A pointer failure stores no row, and the next run sends no new hour transaction.
8. **Budget.** A pointer listing that outlasts the budget gives "budget exhausted", `ok` false.
9. **Re-anchor.** Pointers re-sent after a reset, byte-compared with the stored memo.
10. **Fixtures.** `v2World` (`service.test.ts:5182-5202`) gains pointers. Every existing v2 test in the block needs them.

## 8. Change size, by file (estimate)

| File | Production | Tests | Change |
| --- | --- | --- | --- |
| `packages/ledger/src/memo.ts` | +50 | `memo.test.ts` +60 | v3 format and tail-anchored parser, kept apart from `parseMemo` |
| `packages/ledger/src/heads.ts` | +15 | `heads.test.ts` +15 | `graphHeadsRoot` over one graph's records |
| `packages/ledger/src/graph-index.ts` (new) | +30 | +30 | index address derivation |
| `packages/ledger/src/solana.ts` | +15 | `solana.test.ts` +20 | pointer memo, recipient is the index address |
| `packages/ledger/src/rpc.ts`, `index.ts` | +40 | `rpc.test.ts` +25 | paged index listing, memo filter, exports |
| `packages/mcp-server/src/anchor.ts` | +150 | `anchor.test.ts` +180 | pointer build, send, read-back; send order; adopt window; pointer skip; adopt path checks pointers |
| `packages/mcp-server/src/anchor-verify-deps.ts` | +30 | +20 | ports for listing and confirmation |
| `packages/mcp-server/src/service.ts` | +200, about 40 changed | `service.test.ts` +220 | steps 2 to 12, no-pointer rule, fixtures |
| `packages/mcp-server/src/event.ts` | +10 | `event.test.ts` +20 | filter to one graph's records |
| `reanchor.ts`, `reanchor-plan.ts`, `reanchor-plan-run.ts`, `reanchor-run.ts` | +120 | +120 | pointer validity, plan, resend after a reset |
| `packages/evidence/src/report.ts`, `packages/cli/src/index.ts` | +20 | +20 | pointer status, pre-index reason |
| `greptime.ts`, DDL | 0 | 0 | no new table (option A) |
| `docs/greptime-ledger.md` (memo v3, trust rule, and the `ok` line at `:575`, W6), `docs/adr/0006-memo-only-anchoring.md`, `docs/corpus-proofs.md:120`, `docs/runbooks/devnet-reset-and-reanchor.md` | 0 | docs +120 | |

Totals: about 660 production lines, 550 test lines and 120 doc lines, each within about 25%.

## 9. Open questions for the owner

**Q1. Index mechanism.**
- A. Per-graph index address on chain (recommended).
- B. Filter the job key's listing by graph id. No extra transactions. Cost grows with all history.
- C. Local table. Rejected as a trust source; usable only as a cache of confirmed pointers.
- D. Store-wide scan with no identity. No v3 needed, but any missing hour fails every graph, and cost grows with store age.
- **Recommendation: A.**

**Q2. How deeply to confirm pointers.**
- Confirm each with `getTransaction` (strict). Cost is P calls per verify, and a long-lived graph can exceed the budget, which fails closed.
- Trust the listing's memo text (cheaper). `rpc.ts:110` treats listing memos as hints, so this weakens the existing rule.
- **Recommendation: strict, under the budget.** Measure the budget for a year-old graph before choosing `SUBSTRATE_VERIFY_TIMEOUT_MS`.

**Q3. Index account funding.**
- Probe a 0-lamport transfer to an unfunded address on devnet. If accepted, nothing is funded.
- Otherwise fund each index account with 890,880 lamports once (`anchor.ts:73-75`), recoverable only by closing it.
- **Recommendation: probe first; fund only if the probe fails.**

**Q4. Graph id in the pointer.**
- Carry the full normalised id, up to the existing 512-character cap (`event.ts:168`). Pointer about 710 bytes, to be tested against the transaction limit.
- Cap the id at 128 bytes and refuse longer ones. Changes write behaviour for those graphs.
- **Recommendation: full id, tested at 512.** No write-path change.

**Q5. Pre-index v2 hours (dev or devnet only).**
- `ok` false until re-anchored or re-seeded.
- Treat them as v1 (untrusted, `ok` unchanged). Weaker: a v2 hour then never fails for a missing pointer.
- **Recommendation: `ok` false.** No live store is affected (section 4.1).

**Q6. Adoption window.**
- Raise `checkAdopt`'s read to cover (1 + g) × 168 hours, in pages of 1000.
- Keep 100. Dilution means an adopt can miss an hour whose row write was lost, and the duplicate guard at `anchor.ts:725-731` then covers it only if the row exists.
- **Recommendation: raise the window.**

**Q7. Cross-graph coupling.**
- Keep the hour-level heads check (step 10). One graph's damage fails every graph in that hour. This is today's behaviour.
- Verify per graph only, with pointers. Simpler, but one graph's damage would not fail another graph's verdict.
- **Recommendation: keep today's behaviour.**

**Q8. A graph lost before its first pointer.**
- Accept as a documented residual: `ok` true, `trusted` false, "no events".
- Add a graph registry on chain. It is a new trust root and out of scope.
- **Recommendation: accept and document.**

**Q9. Devnet cost and cadence.**
- Approve one pointer per graph per anchored hour, about 5,000 lamports each. For g graphs that is g × 0.000005 SOL an hour, on devnet only.
- Approve only the hour transactions and accept a weaker per-graph check.
- **Recommendation: approve pointers.** The owner's identity-in-the-clear direction needs them.
