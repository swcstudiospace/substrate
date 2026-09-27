---
phase: 06-ledger
verified: 2026-09-27T13:34:21Z
status: gaps_found
score: 46/48 must-haves verified (46 verified, 2 not verified — owner skip of Solana anchoring, D-17; override recorded, not applied)
covered_files:
  - .planning/phases/06-ledger/06-01-PLAN.md
  - .planning/phases/06-ledger/06-01-SPIKE.md
  - .planning/phases/06-ledger/06-01-SUMMARY.md
  - .planning/phases/06-ledger/06-02-PLAN.md
  - .planning/phases/06-ledger/06-02-SUMMARY.md
  - .planning/phases/06-ledger/06-03-PLAN.md
  - .planning/phases/06-ledger/06-03-SPIKE.md
  - .planning/phases/06-ledger/06-03-SUMMARY.md
  - .planning/phases/06-ledger/06-04-PLAN.md
  - .planning/phases/06-ledger/06-04-SUMMARY.md
  - .planning/phases/06-ledger/06-05-CUTOVER.md
  - .planning/phases/06-ledger/06-05-PLAN.md
  - .planning/phases/06-ledger/06-05-SUMMARY.md
  - .planning/phases/06-ledger/06-06-PLAN.md
  - .planning/phases/06-ledger/06-07-PLAN.md
  - .planning/phases/06-ledger/06-07-SMOKE.md
  - .planning/phases/06-ledger/06-07-SUMMARY.md
  - .planning/phases/06-ledger/06-08-PLAN.md
  - .planning/phases/06-ledger/06-09-PLAN.md
  - .planning/phases/06-ledger/06-09-SUMMARY.md
  - .planning/phases/06-ledger/06-BASELINE.md
  - .planning/phases/06-ledger/06-CONTEXT.md
  - .planning/phases/06-ledger/06-PROOF.md
  - packages/cli/src/index.ts
  - packages/ledger/src/memo.ts
  - packages/ledger/src/merkle.ts
  - packages/ledger/src/period.ts
  - packages/ledger/src/rpc.ts
  - packages/ledger/src/solana.ts
  - packages/mcp-server/src/chain.ts
  - packages/mcp-server/src/event.ts
  - packages/mcp-server/src/fixtures/pre-cutover-rows.json
  - packages/mcp-server/src/greptime.ts
  - packages/mcp-server/src/index.ts
  - packages/mcp-server/src/service.ts
  - packages/mcp-server/src/types.ts
covered_digest: "v1:sha256:060ba793f265e90381ba9f58e1fc88c296eb13ad841caac537812a794fb0aa2f"
covered_files_note: "Computed at HEAD 040e248 with `query verification.fingerprint`. Excluded: ROADMAP.md (a tracking log that later phases append to); 06-RESEARCH/PATTERNS/VALIDATION/CHECK and COVERAGE.md (not plan, summary or evidence inputs); the test files (service.test.ts is shared with later phases). 06-06-PLAN.md and 06-08-PLAN.md are covered because their must-haves are the unmet anchoring half."
behavior_unverified: 0
overrides_applied: 0
owner_skip_overrides_recorded: 2 # on the two gaps below; not applied — see "Why the status is gaps_found"
gaps:
  - truth: "SC2: an hourly systemd timer Merkle-roots the hour's events into a Solana devnet memo and records root, signature and event count in an anchors table"
    status: failed
    override: "owner-skip 2026-09-27"
    owner_answer_verbatim: "Skip Phase 6 anchoring"
    owner_answer_source: "06-03-SUMMARY.md key-decisions and § Funding attempts (06-03 Task 2 funding checkpoint); 06-CONTEXT.md D-17"
    reason: "Not built. The dedicated devnet key (Fku22yAX…Pjivq) was never funded: 3 RPC airdrops and a retry were refused, the PoW faucet did not build, and the balance was 0 lamports when the owner answered. No memo was ever sent. 06-06 and 06-08 did not run. Live: `anchors` has 0 rows (read-only count), no substrate-ledger* unit file exists, infra/vps has no ledger unit, and packages/ledger/src has no anchor.ts, digest.ts, store.ts or cli.ts."
    artifacts:
      - path: "packages/ledger/src/anchor.ts"
        issue: "does not exist (06-06 skipped)"
      - path: "infra/vps/substrate-ledger-anchor.timer"
        issue: "does not exist (06-08 skipped)"
      - path: "anchors (Greptime table)"
        issue: "period-keyed, 11 columns, 0 rows; nothing writes it"
    missing:
      - "06-03 Task 2 (D-06): a funded devnet key and the send-once 0-lamport memo spike (spike_amount, spike_output_json_keys, spike_memo_program)"
      - "06-06: hourDigest, LedgerStore, `ledger anchor` job with D-13 lag and D-15 adopt, plus the live devnet tracer (06-06-TRACER.md)"
      - "06-08: substrate-ledger-anchor.{service,timer} (OnCalendar=hourly, Persistent=true) installed, a first timer tick, and the dead-RPC failure-path run"
  - truth: "SC3, signature clause: `substrate verify <graph_id>` checks roots against signatures"
    status: failed
    override: "owner-skip 2026-09-27"
    owner_answer_verbatim: "Skip Phase 6 anchoring"
    owner_answer_source: "06-03-SUMMARY.md; 06-CONTEXT.md D-17 (\"The signature clause of SC3\" is listed under Skipped (owner))"
    reason: "Not built. The 06-07 revision is chain-only by design. The CLI and server have no anchor status, memo fetch, signer check, pending or unverified state, and no SOLANA_* read (a git grep of packages/mcp-server/src and packages/cli/src for SOLANA_ or the ledger rpc/solana/memo/merkle modules finds 0 matches). Because nothing is anchored, D-12's anchor half (step 2, and the anchor catch in step 3 (b)) did not run either (06-PROOF.md § Gaps)."
    artifacts:
      - path: "packages/mcp-server/src/service.ts"
        issue: "verifyGraph reports the chain only; there is no per-hour anchor check"
      - path: "packages/cli/src/index.ts"
        issue: "prints `hour … chain <ok|broken>` only; there is no anchor line"
    missing:
      - "06-07 anchor half (D-11, D-14, D-16): recompute each hour's root and count, fetch the memo by tx_sig, check the signer against SOLANA_ANCHOR_PUBKEY, and report pending/unverified states"
      - "D-12 step 2 and the anchor catch in step 3 (b): wait for the timer to anchor the proof hour, then show that a consistent rewrite fails against the on-chain root"
---

# Phase 6: Ledger Verification Report

**Phase Goal:** Tamper-evident history.
**Verified:** 2026-09-27T13:34:21Z (HEAD 040e248)
**Status:** gaps_found
**Re-verification:** No — initial verification

The chain half of the goal holds on production. Since the 13:02:16Z cutover, substrate-mcp is the only
writer. It hashes every event on ingest over redacted canonical JSON, with a global `prev` and a
hashed `ingested_at`. I read all 69 post-cutover rows back read-only. They form one unbroken chain
from the recorded genesis `evt_5d1b8c40…`: 1 null prev, 0 hash mismatches, and `ingested_at` is
strictly increasing. `substrate verify` recomputes that chain per ingest hour. The 06-09 proof showed
that altering one row makes it fail, whether the attacker keeps the stale hash or recomputes it.

The anchoring half does not exist. At 06-03's funding checkpoint the owner answered "Skip Phase 6
anchoring" (D-17). As a result SC2 and SC3's roots-against-signatures clause are gaps. Each carries
`override: owner-skip 2026-09-27`, and neither is marked passed.

## Why the status is gaps_found

I followed the rule the Phase 5 verifier used (05-VERIFICATION.md § Why the status is gaps_found):

1. **The items are not verified.** The phase record itself declines to claim them. 06-PROOF.md
   records `sc2_status=skipped-owner-D-17` and `sc3_signature_clause=skipped-owner-D-17`. ROADMAP
   Phase 6 says "SC2 … and SC3's roots-against-signatures clause are not delivered". The assignment
   also says not to mark them passed. Since they stay unpassed, they are gaps, and gsd-verifier
   Step 9 rule 1 turns any gap into `gaps_found`.
2. **The overrides guide excludes this case.** An override only counts once it becomes `PASSED
   (override)` (verification-overrides.md § Impact on Overall Status). The guide's "When NOT to Use"
   list, however, includes "The implementation is simply incomplete". Anchoring has no
   implementation, not even an alternative one. The owner's only words are the checkpoint answer
   "Skip Phase 6 anchoring". That answer accepts that the work is not done; it does not rule that
   the work is done.
3. **No later phase takes the work (Step 9b).** ROADMAP Phases 7 and 8 do not mention anchor,
   devnet, Solana or Merkle. The gaps therefore cannot move to the deferred list.
4. **The downstream gate already provides the route onward.** 07-01 T1 accepts
   `phase6-verification=passed` *or* an orchestrator acceptance recorded as `phase6-verification=accepted`
   with a verbatim `phase6-accepted-note:`. The three Phase 6 contract strings it checks are
   present: `ingested_at?: string`, `export class IngestChain` and `export const EVENT_COLUMNS`. So is
   `cutover_ingested_at=2026-09-27T13:02:16.494Z` in 06-05-CUTOVER.md.

The owner-skip annotations are kept on the gap entries. They are not in a top-level `overrides:`
list, because Step 3b would fuzzy-match such a list on re-verification and turn the gaps into
`PASSED (override)`.

## Goal Achievement

### Observable Truths

Truths 1–5 come from the ROADMAP contract. SC3 is split into its chain clause and its signature
clause, because D-17 skips only the second. Truths 6–48 are the must-haves of the plans that ran:
06-01, 06-02, 06-03 up to its funding checkpoint, 06-04, 06-05, the chain-only 06-07 and the
chain-only 06-09. The per-plan "root suite and tsc two-sided green" truths are merged into truth 48.
The must-haves of the skipped work are folded into the two frontmatter gaps under `missing:`: 06-03
Task 2, all of 06-06 and 06-08, and the anchor half of 06-07 and D-12. None of that work ran.

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | SC1 (re-scoped by D-01): every event is hashed on ingest over the canonical event JSON and carries `prev` | ✓ VERIFIED | event.ts:100-106: the summary and payload are redacted, then `hash: eventHash(unhashed)`. `canonicalJson` sorts keys (:24). Every ingest route goes through `Substrate.emit` → `chain.append` (service.ts:155; server.ts:126 `/events`; mcp.ts:138 `events_emit`). The only `INSERT INTO "agent_events"` in packages/ is `insertEvents` (greptime.ts:242), called only by IngestChain (chain.ts:196). Live read-only: 69 post-cutover rows, 0 null hash, 0 recompute mismatches, 1 null prev (= genesis evt_5d1b8c40…), `verifyGlobalChain(all, null)` = ok. Pre-cutover rows stay at 6043, equal to `historical_rows_at_cutover`, so no row was written without `ingested_at` after the cutover. |
| 2 | SC2: hourly timer Merkle-roots each hour into a Solana devnet memo; root/signature/count in `anchors` | ✗ NOT VERIFIED — owner-skip 2026-09-27 (override recorded, not applied) | Owner answer verbatim: "Skip Phase 6 anchoring" (06-03-SUMMARY; D-17). `anchors` has 0 rows (live). There are 0 `substrate-ledger*` unit files and no anchor/digest/store/cli module. The Solana CLI RPC is still `http://127.0.0.1:8899`. |
| 3 | SC3, chain clause: `substrate verify <graph_id>` recomputes the chain | ✓ VERIFIED | service.ts:564-609 checks pre-cutover rows per session with `verifySessions`. For each ingest hour that holds a post-cutover row of the graph, it runs `hourEvents(start, start+HOUR_MS)` plus `lastEventBefore(start)`, and `verifyGlobalChain` recomputes every hash and checks each prev (event.ts:198-219). cli/index.ts:185 makes one `post("/verify", …, verifyTimeout())` and prints one hour line per hour (:199-202). Live, run by me: smoke graph exit 0 `hour 2026-09-27T13:00:00.000Z chain ok (29 of 69 events)`; proof graph exit 0 `… chain ok (3 of 69 events)`. |
| 4 | SC3, signature clause: verify checks roots against signatures | ✗ NOT VERIFIED — owner-skip 2026-09-27 (override recorded, not applied) | D-17 lists "The signature clause of SC3" under Skipped (owner). No anchor or signer code exists in the server or the CLI (0 matches for SOLANA_ or the ledger rpc/solana/memo/merkle imports). |
| 5 | Proof: alter one event row, and `verify` flags the graph | ✓ VERIFIED | 06-PROOF.md: (a) stale hash → exit 1, `hash does not match contents` at evt_7975e0d7… (the altered row), hour broken. (b) recomputed hash → exit 1, `prev does not match the preceding event` at evt_e4816d83… (the recorded global successor), hour broken; `b_caught_by=chain-prev-linkage`. Both restored byte-equal, verify exit 0. Live re-check: originals.json 600 root, sha256 1c6893ef…2b7d (= `originals_sha256`); live rows equal to originals 3/3 (canonical JSON); the proof graph verifies ok now. This rests on the chain alone; the anchor catch that D-12 planned is part of gap 4. |
| 6 | 06-01: phase order checked (Phase 4 passed, Phase 5 passed or accepted verbatim, symbols present) | ✓ VERIFIED | 06-BASELINE: `phase4-verification=passed`, `phase5-verification=accepted` (with the note), `phase45-symbols=present`. |
| 7 | 06-01: two-sided baseline and live inventory recorded before any Phase 6 edit | ✓ VERIFIED | 06-BASELINE: pass=534, fail=0, files=29, dispatcher-pass=149, one tsc-set line, anchors-rows=0, solana-env-lines=0, ledger-timers=0, ledger-key-present=false, 19 `baseline-ok-graph:` lines, 0 `baseline-bad-graph`. |
| 8 | 06-01: pre-cutover fixture of every baseline-ok graph row (16 columns, no ingested_at), sha256 recorded | ✓ VERIFIED | `sha256sum` of pre-cutover-rows.json = e73e05f2…d303 = `fixture-sha256`; fixture-rows=95, fixture-graphs=19. |
| 9 | 06-01: /var/lib/substrate/phase6-baseline 0700 root with RESTORE.md, RESTORE.d/06-01.md, verbatim SHOW CREATE and a manifest | ✓ VERIFIED | Live `stat`: dir 700 root; RESTORE.md and RESTORE.d/06-01, 06-03, 06-05 and 06-09 each 600 root. `sha256sum -c MANIFEST.sha256`: agent_events and anchors show-create OK. |
| 10 | 06-01: Greptime scratch spike facts recorded from observed output | ✓ VERIFIED | 06-01-SPIKE: `alter_add_column=ok`, `half_open_boundary=ok`, `multirow_insert_atomic=yes`, `agent_events_unchanged=true`. Caveat: atomicity was observed only for a type-check rejection (06-01 Gaps). |
| 11 | 06-01: nothing else live changed | ✓ VERIFIED | 06-01-SUMMARY § Verification: substrate-mcp was up from 2026-09-26 19:31:28 until the 06-05 restart; 06-05 found `schema_matches_snapshot=true` before its DDL. |
| 12 | 06-02: RFC 6962 merkleRoot, eight reference roots pinned | ✓ VERIFIED | `bun test packages/ledger/src`: 45 pass / 0 fail / 5 files. Nothing in production calls it (D-17; see Notes N2). |
| 13 | 06-02: memo v1 format/parse and all three memo program IDs | ✓ VERIFIED | Same run. The key links solana.ts:40 `parseMemo` and rpc.ts:149 `MEMO_PROGRAM_IDS` are present. |
| 14 | 06-02: half-open UTC ingest hours | ✓ VERIFIED | period.ts. It is the one ledger module in production use: service.ts:8 imports `HOUR_MS, hourIso, hourStart`. |
| 15 | 06-02: solana.ts builds a pure argv and runs it only through execFile | ✓ VERIFIED | Same test run; transferMemoArgv refuses a non-v1 memo (solana.ts:40). Never executed live (D-17). |
| 16 | 06-02: rpc.ts devnet JSON-RPC with timeout/retries; tests never touch the network | ✓ VERIFIED | Same test run. |
| 17 | 06-02: no import from packages/mcp-server; no dependency added | ✓ VERIFIED | `git grep mcp-server -- packages/ledger/src` = 0. `phase6_dependency_changes=0`: no package.json or lockfile in any `(06-` commit (name list re-run). |
| 18 | 06-03 (D-04): dedicated devnet key at /etc/substrate/ledger-devnet.json, 0600 root, never printed | ✓ VERIFIED | Live `stat`: 600 root. 06-03-SUMMARY: keygen printed one line, and token/key-array scans found 0. |
| 19 | 06-03 (D-04): exactly three SOLANA_* env lines; snapshot and RESTORE.d/06-03.md first | ✓ VERIFIED | `sudo grep -c '^SOLANA_'` = 3. RESTORE.d/06-03.md is 600 root. The lines are present but nothing reads them (N2). |
| 20 | 06-03 (D-04): id.json and the Solana CLI default config unchanged | ✓ VERIFIED | `stat -c '%Y %s' id.json` = `1789532431 235` (= baseline). `solana config get` → `http://127.0.0.1:8899`. |
| 21 | 06-03 (D-05): the airdrop was tried; the owner was asked only after funding failed, through the precondition checkpoint | ✓ VERIFIED | 06-03-SUMMARY: 3 airdrops refused, then checkpoint 1, a retry refused, and the owner's answer. The D-06 spike truth of this plan is gap 2 (missing). |
| 22 | 06-04 (D-01): substrate-mcp is the only writer and hasher; redaction before hashing; no producer file changed | ✓ VERIFIED | See truth 1. The `(06-` commit name list touches no collectors, projector, host or dispatcher path. |
| 23 | 06-04 (D-02): IngestChain serializes emits: batch per turn, strictly increasing ingested_at, global prev, one INSERT, boot seed, unknown → re-seed; lastHash/insertEvent deleted | ✓ VERIFIED | chain.ts:114-206 (`queue.splice(0)` :119, `Math.max(now, lastMs+1)` :178, `prev = event.hash` :187, one `insertEvents` :196, head unknown on failure :199); index.ts:21 `seedChain()`. The journal since the restart shows `[substrate] chain head genesis` with no degraded line. chain.test/event.test/greptime.test: 62 pass / 0 fail. |
| 24 | 06-04 (req 3): named tests pin the batching and the hook budget | ✓ VERIFIED | `bun test chain.test.ts -t 'batches queued emits into one insert\|stays under the hook budget'`: 2 pass / 0 fail. |
| 25 | 06-04: ts := ingested_at for server-timed events; NULL-safe client-ts guard (replay, +1 ms, ≤5 moves) | ✓ VERIFIED | chain.ts:152-168, 212-252. Tests "a replay of a stored row…", "different content … moves ts by 1 ms", "after 5 moves the input is rejected alone" pass in the 62. Live 06-05: `replay_same_id=true`, `collision_nudged_ms=1`. |
| 26 | 06-04 (D-09): ingested_at is hashed and absent-not-null; fixture and inverse pinned | ✓ VERIFIED | event.ts:104, :142-144. event.test "every baseline graph verifies and every stored hash recomputes unchanged", "a NULL ingested_at column still recomputes every hash", "an explicit ingested_at: null … changes every one of those hashes" pass. |
| 27 | 06-04 (D-08/D-09): guarded migrate (ALTER only when absent; drop only an empty root-TAG anchors; refuse otherwise; period-keyed CREATE) | ✓ VERIFIED | greptime.test "adds ingested_at exactly once…", "…with rows is never dropped: migrate refuses", "anchors without a root TAG … never dropped" pass. Live schema: `ingested_at` FIELD timestamp(3); anchors has 11 columns, 0 TAG, starting with `period_start`. |
| 28 | 06-04 (D-02/D-03): verify splits pre/post; post rows checked as whole ingest hours; reset/fork named | ✓ VERIFIED | service.ts:571-608; event.ts:206-213. Named test `post-cutover interleaved sessions verify as one global hour`: 1 pass / 0 fail. |
| 29 | 06-04: additive toward Phases 4/5 (server.ts and mcp.ts untouched, SURFACES/EVENT_KINDS kept, /events still answers {id, ts, hash}) | ✓ VERIFIED | `git diff --stat c31f820 HEAD -- server.ts mcp.ts` is empty. The types.ts diff since c31f820 only rewords the `prev` doc and adds `ingested_at?: string`. |
| 30 | 06-05: before the DDL, deployed commit, start time and unit hash recorded; schema equals snapshot; RESTORE.d/06-05.md first | ✓ VERIFIED | 06-05-CUTOVER: `schema_matches_snapshot=true`, `early_cutover=false`. RESTORE.d/06-05.md is 600 root. |
| 31 | 06-05 (D-08/D-09 live): ingested_at FIELD timestamp(3); anchors period-keyed, 11 columns, 0 rows | ✓ VERIFIED | Live information_schema read (truth 27); anchors count 0. |
| 32 | 06-05 (D-02 live): restart only after the DDL; /healthz 200; `chain head genesis`; no degraded line | ✓ VERIFIED | `systemctl show`: ActiveEnterTimestamp 2026-09-27 13:01:42 UTC (= `restarted_at`). /healthz 200 now. The journal shows exactly `[substrate] chain head genesis`. |
| 33 | 06-05 (D-03): cutover event recorded (id, hash, ingested_at, prev null), historical count, deployed commit | ✓ VERIFIED | CUTOVER: `cutover_event_id=evt_5d1b8c40…`, `cutover_ingested_at=2026-09-27T13:02:16.494Z`, `cutover_prev=null`, `historical_rows_at_cutover=6043`, `deployed_commit=c2bafeb…`. Live: the first post-cutover row is that id with a null prev. |
| 34 | 06-05 (D-01+D-02 live): every post-cutover row hashed, exactly one null prev, strictly increasing, 0 breaks; server-timed ts = ingested_at; replay and nudge | ✓ VERIFIED | My live read (truth 1): 69 rows, 1 null prev, strictly increasing, whole chain ok. The replay and nudge results come from CUTOVER (`replay_same_id=true`, `collision_nudged_ms=1`); I did not re-run them because they write. |
| 35 | 06-05 (req 3 live): 20 concurrent emits all 202, slowest < 1500 ms; burst of 7 < 1500 ms | ✓ VERIFIED | CUTOVER `burst_http_202=20/20`, `emit_latency_max_ms=800`, `burst7_latency_max_ms=903`. Not re-run (it writes). |
| 36 | 06-05 (req 4 live): every baseline-ok graph still verifies; smoke graph verifies on the new path | ✓ VERIFIED | Run by me through the CLI: 19/19 exit 0 (max 1198 ms, no hour lines, since they are pre-cutover only). The smoke graph exits 0 (truth 3). |
| 37 | 06-07: one `hour <period_start> chain <ok\|broken> (<g> of <h> events)` line per hours entry after the chain line | ✓ VERIFIED | cli/index.ts:197-203. Live output (truth 3). |
| 38 | 06-07: thin POST with exit 0/1; own SUBSTRATE_VERIFY_TIMEOUT_MS (60000); brief and emit keep 1500; no ledger or greptime import | ✓ VERIFIED | cli/index.ts:41, :57-60, :185, :204. 282698d touches only cli/index.ts. SMOKE: `cli_default_timeout_ms=60000`, `cli_brief_abort_ms=1500`, `cli_broken_exit=1`, `cli_usage_exit=2`. |
| 39 | 06-07 (D-17): no anchor, signer, memo, pending, unverified, config.ledger or SOLANA_* code; substrate-mcp not edited or restarted | ✓ VERIFIED | The git grep finds 0 matches. ActiveEnterTimestamp is still 13:01:42 (the 06-05 restart). No mcp-server commit after c2bafeb. |
| 40 | 06-07 live: smoke graph `hour <smoke_hour> chain ok`; baseline graphs N/N; slowest recorded | ✓ VERIFIED | SMOKE `smoke_verify_exit=0`, `smoke_hour_chain=ok`, `pre_cutover_graphs_verified=19/19`, `verify_max_ms=2397`. My re-run is in truths 3 and 36. |
| 41 | 06-09 (D-12 step 1): throwaway graph, 3 events in one session, one hour; verify 0 with `hour H chain ok` | ✓ VERIFIED | PROOF § Setup: three ids, all in hour 13:00; `verify_before_exit=0`. The graph still verifies ok live. |
| 42 | 06-09 (chain-only design): middle event's global successor found before any write, inside H | ✓ VERIFIED | PROOF: `successor_rows=1`, `middle_successor=evt_e4816d83…` (= event 3), `middle_successor_hour=13:00`, `b_detectable_by_chain=true`. The prev chain `row_3.prev = row_2.hash` is visible in the read-back. |
| 43 | 06-09 (D-12): originals captured 0600 root before any overwrite; RESTORE.d/06-09.md written | ✓ VERIFIED | Live: originals.json 600 root with the recorded sha256; RESTORE.d/06-09.md 600 root. |
| 44 | 06-09 (D-12 step 3a): stale-hash overwrite read back; verify 1, `hash does not match contents` at the middle id, hour broken | ✓ VERIFIED | PROOF § Tamper (a): `a_readback_hash_stale=true`, `a_key_rows=1`, `a_graph_rows=3`, `a_verify_exit=1`, `a_broken_at=evt_7975e0d7…`, `a_hour_chain=broken`. |
| 45 | 06-09 (D-12 step 3b, chain-only): recomputed-hash overwrite; verify 1, `prev does not match the preceding event` at the successor, hour broken | ✓ VERIFIED | PROOF § Tamper (b): `b_readback_hash_recomputed=true`, `b_verify_exit=1`, `b_broken_at` = `b_expected_successor` = evt_e4816d83…, `b_caught_by=chain-prev-linkage`. The code path is verifyGlobalChain :206-212 (prev ≠ expected, and not null or earlier → that reason). |
| 46 | 06-09 (D-12 step 4): each restore byte-equal; verify 0 with hour ok; all three rows equal the originals at the end | ✓ VERIFIED | PROOF: `a/b_restore_byte_equal=true`, `*_verify_after_restore_exit=0`, `final_rows_equal_originals=true`. My live comparison: 3/3 equal, live=3. |
| 47 | 06-09 (phase end): baseline graphs verify; no producer or manifest change; Solana config untouched; anchors 0; sc keys recorded; proof_result=pass | ✓ VERIFIED | Truths 20, 22 and 36; the anchors count is 0 live. PROOF: `sc1_rescope=D-01`, `sc2_status=skipped-owner-D-17`, `sc3_signature_clause=skipped-owner-D-17`, `proof_result=pass`. ROADMAP SC1 is annotated in place with the original wording quoted. |
| 48 | 06-02/04/07/09: root suite, tsc and dispatcher two-sided green against 06-BASELINE | ✓ VERIFIED | 06-09 Task 3 gate (after 86d5b81): bun 634 pass / 0 fail / 36 files (> 534), `tsc-exit=0` equal to the baseline set, dispatcher 149 passed with no FAILED ids. `git diff --stat 86d5b81 HEAD` shows only 06-09-SUMMARY.md, and no packages/ or infra/ commit after 282698d. I did not re-run the full suite. |

**Score:** 46/48 truths verified (0 present, behavior-unverified; 0 overrides applied; 2 owner-skip gaps)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `packages/mcp-server/src/chain.ts` | IngestChain; `queue.splice(0)` | ✓ VERIFIED | 253 lines; :119 |
| `packages/mcp-server/src/greptime.ts` | EVENT_COLUMNS, guarded migrate, insertEvents, chainHead, eventsAtKeys, hourEvents, lastEventBefore; `ADD COLUMN "ingested_at" TIMESTAMP` | ✓ VERIFIED | 294 lines; insertEvent/lastHash gone |
| `packages/mcp-server/src/event.ts` | normalizeEvent(…, ingestedAt?), rowToEvent, verifySessions, verifyGlobalChain | ✓ VERIFIED | 219 lines |
| `packages/mcp-server/src/service.ts` | emit through IngestChain, seedChain, verifyGraph split | ✓ VERIFIED | :108, :155, :162, :564 |
| `packages/cli/src/index.ts` | SUBSTRATE_VERIFY_TIMEOUT_MS, hour lines | ✓ VERIFIED | :41, :57, :199 |
| `packages/ledger/src/{merkle,memo,period,solana,rpc}.ts` | 06-02 ledger core | ✓ VERIFIED (4 of 5 ⚠️ ORPHANED by D-17) | Only period.ts has a production importer; see N2 |
| `packages/mcp-server/src/fixtures/pre-cutover-rows.json` | 95 rows, contains `"hash"` | ✓ VERIFIED | sha256 = baseline |
| `.planning/phases/06-ledger/06-BASELINE.md` | `agent-substrate-tsc-set:` | ✓ VERIFIED | |
| `.planning/phases/06-ledger/06-01-SPIKE.md` | `alter_add_column=` | ✓ VERIFIED | |
| `.planning/phases/06-ledger/06-03-SPIKE.md` | `spike_amount=` | ⚠️ PARTIAL (owner-skip) | Key, env and airdrop evidence exist; the memo-spike keys do not (gap 2, missing) |
| `.planning/phases/06-ledger/06-05-CUTOVER.md` | `cutover_event_id=` | ✓ VERIFIED | |
| `.planning/phases/06-ledger/06-07-SMOKE.md` | `smoke_hour_chain=` | ✓ VERIFIED | |
| `.planning/phases/06-ledger/06-PROOF.md` | `proof_result=` | ✓ VERIFIED | `proof_result=pass` |
| anchor.ts, digest.ts, store.ts, ledger cli.ts, 06-06-TRACER.md, substrate-ledger-anchor.{service,timer}, 06-08-SMOKE.md | anchoring half | ✗ MISSING (owner-skip) | gaps 2 and 4 |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| service.ts | chain.ts | `emit` → `this.chain.append` | ✓ WIRED | service.ts:155; server.ts:126, mcp.ts:138 call `emit` |
| chain.ts | greptime.ts | ChainStore = chainHead + insertEvents + eventsAtKeys | ✓ WIRED | chain.ts:11-13, :196, :219; service.ts:108 passes the GreptimeClient |
| service.ts | ledger/src/period.ts | `hourStart`/`HOUR_MS` bucket post rows | ✓ WIRED | service.ts:8, :579, :589 |
| index.ts | service.ts | `seedChain()` after migrate | ✓ WIRED | index.ts:21; journal `chain head genesis` |
| cli verify | POST /verify | `post("/verify", { graph_id }, verifyTimeout())` | ✓ WIRED | cli:185 → server.ts:141 → verifyGraph |
| fixture | event.test.ts | readFileSync + rowToEvent + verifySessions | ✓ WIRED | event.test.ts:219-262 |
| 06-BASELINE.md | later 06-NN gates | `agent-substrate-pass=`, `baseline-ok-graph:` | ✓ WIRED | 06-05/07/09 gates read it |
| 06-05-CUTOVER.md | 06-07 smoke | smoke_graph_id, smoke_hour | ✓ WIRED | SMOKE uses the same graph and hour |
| 06-PROOF.md | ROADMAP proof, SC1, SC3 chain clause | a/b verify exits, b_broken_at, sc keys | ✓ WIRED | `proof_result=pass` |
| solana.ts / rpc.ts | memo.ts | parseMemo / MEMO_PROGRAM_IDS | ✓ WIRED | solana.ts:40, rpc.ts:149 (the modules themselves are orphaned, N2) |
| substrate.env SOLANA_* | substrate-mcp / anchor unit | EnvironmentFile | ✗ NOT_WIRED (owner-skip) | Lines present; no reader |
| 06-03-SPIKE.md | anchor.ts | spike_amount | ✗ NOT_WIRED (owner-skip) | Neither side exists |
| anchor timer | anchor service → ledger cli.ts anchor | `Unit=` / `ExecStart` | ✗ NOT_WIRED (owner-skip) | Units not written |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| stored event | `hash`, `prev`, `ingested_at` | IngestChain turn → normalizeEvent → insertEvents → Greptime | Yes: 69 live rows chain from the genesis, 0 mismatches | ✓ FLOWING |
| `/verify` reply | `hours[].chain`, `hour_events`, `graph_events` | hourEvents + lastEventBefore → verifyGlobalChain | Yes: `29 of 69`, `3 of 69` match the live post-cutover count, since all 69 rows are in the 13:00 hour | ✓ FLOWING |
| `/verify` reply (pre) | `ok` for pre-cutover graphs | graph rows → verifySessions | Yes: 19/19 | ✓ FLOWING |
| anchors | root/tx_sig/count | — | No writer | ✗ DISCONNECTED (owner-skip, gap 2) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Chain, event and migrate units | `SUBSTRATE_DISABLED=1 bun test event.test.ts chain.test.ts greptime.test.ts` | 62 pass / 0 fail / 3 files | ✓ PASS |
| Batching and hook budget | `bun test chain.test.ts -t 'batches queued emits into one insert\|stays under the hook budget'` | 2 pass / 0 fail | ✓ PASS |
| Whole-hour verify with interleaved sessions | `bun test service.test.ts -t 'post-cutover interleaved sessions verify as one global hour'` | 1 pass / 58 filtered / 0 fail | ✓ PASS |
| Ledger core | `SUBSTRATE_DISABLED=1 bun test packages/ledger/src` | 45 pass / 0 fail / 5 files | ✓ PASS |
| Service up on the chain code | `systemctl is-active`; ActiveEnterTimestamp; `/healthz`; journal grep | active; 13:01:42 UTC; 200; `[substrate] chain head genesis`, no degraded line | ✓ PASS |
| Smoke graph verify | `bun packages/cli/src/index.ts verify ut-ledger-smoke-20260927T130216Z` | exit 0; `hour 2026-09-27T13:00:00.000Z chain ok (29 of 69 events)` | ✓ PASS |
| Proof graph verify | `… verify ut-ledger-proof-20260927T131911Z` | exit 0; `… chain ok (3 of 69 events)` | ✓ PASS |
| Baseline graphs | CLI verify of all 19 `baseline-ok-graph:` ids | 19/19 exit 0, max 1198 ms, 0 hour lines | ✓ PASS |
| Live chain, schema and anchors (read-only SELECTs) | throwaway /tmp script under `systemd-run -p EnvironmentFile=…` (deleted) | anchors 0; ingested_at FIELD timestamp(3); anchors 11 columns / 0 TAG; 69 post rows, first = cutover id, 1 null prev, 0 null hash, strictly increasing, whole chain ok, 0 recompute mismatches; pre rows 6043; proof rows equal originals 3/3 | ✓ PASS |
| Proof originals | `sudo stat`, `sudo sha256sum` | 600 root; 1c6893ef…2b7d = `originals_sha256` | ✓ PASS |
| Rollback area | `stat`; `sha256sum -c MANIFEST.sha256` | 700/600 root; both show-create files OK | ✓ PASS |
| Anchoring absent and Solana untouched | `solana config get`; `systemctl list-unit-files 'substrate-ledger*'`; `grep -c '^SOLANA_'`; key `stat` | localhost RPC; 0 units; 3 lines; key 600 root | ✓ PASS (confirms gaps 2 and 4) |

Every live check only read state. I made no emit, write or restart, and the throwaway script ran
SELECT statements only. I did not re-run the full suite, tsc or pytest. The gate numbers (bun
634/0/36, tsc-exit=0, pytest 149) come from 06-09 Task 3, and only 06-09-SUMMARY.md changed after it.

### Probe Execution

No Phase 6 plan or summary declares a `probe-*.sh`, and none exists. Step 7c: no probes.

### Requirements Coverage

Every plan has `requirements: []`, and there is no .planning/REQUIREMENTS.md. The ROADMAP success
criteria above are the contract. The plan-local "requirement 3" (hook budget) is truths 24 and 35, and
"requirement 4" (existing graphs keep verifying) is truths 8, 26 and 36. There are no orphaned
requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| — | — | TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER/"not yet implemented" | — | 0 matches in chain.ts, event.ts, greptime.ts, service.ts, index.ts, types.ts, cli/index.ts or packages/ledger/src |
| packages/ledger/src/{merkle,memo,solana,rpc}.ts | — | no production importer | ℹ️ Info | Kept on purpose by D-17 ("the 06-02 Merkle and memo code stays in the repo, but nothing calls it") |

### Human Verification Required

None. The two open items are gaps, not human checks. They carry the owner's recorded skip, so the
next step is the orchestrator's decision (see Gaps Summary), not a test.

### Notes (non-blocking)

- **N1 — Residual risk accepted with D-17 (⚠️ Warning).** Without an external anchor, a
  *consistent* rewrite passes verify. Such a rewrite changes a row and every later row through the
  head, recomputes each hash and prev in order, and then restarts substrate-mcp so the head re-seeds.
  event.test "a consistent rewrite of every event passes — only an anchor can catch it" pins this
  behaviour. SC1 plus the chain clause of SC3 therefore make the history tamper-*evident* only
  against edits that do not rewrite the chain through the head. This is the security content of
  gaps 2 and 4.
- **N2 — Unused anchoring leftovers (ℹ️ Info).** merkle.ts, memo.ts, solana.ts and rpc.ts have no
  production importer. The period-keyed `anchors` table is empty, and `migrate()` re-creates it on
  every boot (harmless while it is empty). The key /etc/substrate/ledger-devnet.json (0 lamports) and
  the three SOLANA_* lines in substrate.env stay in place and unused. RESTORE.d/06-03.md routes (a)
  and (c) remove them. D-17 left all of these in place for a later revival.
- **N3 — Whole-hour verify couples graphs (ℹ️ Info).** Every graph with a post-cutover event in an
  hour is judged on that entire hour. A single bad row therefore makes every graph of that hour read
  `broken`, as happened during the 7.4 s and 7.7 s proof windows (06-PROOF § Gaps). This follows
  from D-02 and is intended: the break is reported at the exact row id.
- **N4 — Atomicity caveat (ℹ️ Info).** Multi-row INSERT atomicity was observed only for a
  type-check rejection (06-01 Gaps). IngestChain treats any insert failure as ambiguous and re-seeds
  from Greptime (chain.ts:197-201). A partial landing would therefore show up as a fork or reset in
  verify, not as silent loss.

### Gaps Summary

Both gaps have one root cause. The owner answered "Skip Phase 6 anchoring" at 06-03's devnet funding
checkpoint on 2026-09-27, after every funding route had failed: RPC airdrops rate-limited, the PoW
faucet unbuildable, and web-faucet funding never arriving. With no funded key, no memo can be
sent. So 06-06 (anchor job and tracer) and 06-08 (hourly timer) never ran, and 06-07 and 06-09 were
revised to chain-only. The phase record agrees on this everywhere. ROADMAP Phase 6 names the skip,
06-CONTEXT D-17 lists what was skipped, and 06-PROOF.md records both SC2 and the signature clause
as `skipped-owner-D-17`.

The orchestrator or owner can close the gaps in one of two ways:

- **Proceed on the chain half.** Record `phase6-verification=accepted` with a verbatim
  `phase6-accepted-note:` in 07-BASELINE.md, citing D-17 and this report. 07-01 T1 was written to
  allow this, and the three Phase 6 contract strings and `cutover_ingested_at` it checks are present.
- **Build anchoring later.** Fund a devnet key (or use a paid RPC, which D-17 lists under Deferred),
  then revive 06-03 Task 2, 06-06, 06-08 and the anchor half of 06-07 and D-12. The rows ingested
  in the meantime would also need the deferred genesis-style anchor.

No code change inside Phase 6 can close these gaps without a funded devnet key.

---

_Verified: 2026-09-27T13:34:21Z_
_Verifier: Claude (gsd-verifier)_
