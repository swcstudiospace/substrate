# Coverage — Phase 6 (Ledger)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Plans: 06-01 (phase-order gate on Phases 4/5 — Phase 5 desktop half only, docs half owner-skipped 2026-09-27 (SPE-3970), so no `docs ingest` CLI symbol is required; baseline, rollback area, pre-cutover fixture, Greptime scratch spike), 06-02 (ledger core: Merkle, memo, hours, Solana argv, devnet RPC),
> 06-03 (devnet key, substrate.env, funding checkpoint, memo spike), 06-04 (ingest chain code: hashing rules, Greptime contract, IngestChain, verify split),
> 06-05 (cutover: guarded DDL, restart, cutover record, live smoke), 06-06 (anchor job + devnet tracer), 06-07 (verify anchors, CLI),
> 06-08 (hourly timer), 06-09 (proof).
> Task references are `plan / task` (e.g. 06-06 T2). D-13..D-16 are the orchestrator-approved answers to 06-RESEARCH Open Questions 1-4 (2026-09-26), to be appended to 06-CONTEXT.md by the orchestrator.

## ROADMAP success criteria and proof → plan/task

| Criterion | Covered by | Evidence key(s) |
|---|---|---|
| SC-1 **as re-scoped by D-01**: every event is hashed on ingest over the canonical event JSON and carries `prev` (original wording "Every collector computes `hash` …" kept quoted; the orchestrator annotates ROADMAP in place) | 06-04 T1 (hash covers ingested_at; historical hashes unchanged), 06-04 T2/T3 (global chain on ingest), 06-05 T2 (live), 06-09 T3 (no producer changed; `sc1_rescope`) | 06-05-CUTOVER.md `post_cutover_hash_null=0`, `post_cutover_prev_null=1`, `post_cutover_chain_breaks=0`, `cutover_prev=null`; 06-PROOF.md `phase6_producer_changes=0`, `sc1_rescope=D-01` |
| SC-2 hourly systemd timer Merkle-roots the hour's events into a Solana **devnet** memo | 06-02 T1/T2 (RFC 6962, memo v1), 06-06 T1/T2 (job + tracer), 06-08 T1/T2 (timer, first tick, failure path), 06-09 T1 (proof hour anchored by the timer) | 06-06-TRACER.md `onchain_memo_equal=true`, `onchain_signer_ok=true`; 06-08-SMOKE.md `timer_on_calendar=hourly`, `timer_persistent=yes`, `first_tick_trigger=timer`; 06-PROOF.md `anchored_by`, `timer_ticks_observed` |
| SC-2 records root, signature and event count in an `anchors` table | 06-04 T2 (period-keyed DDL), 06-05 T1 (live re-create), 06-06 T1/T2 (LedgerStore insert, 11 columns) | 06-05-CUTOVER.md `anchors_tag_columns=0`, `anchors_columns=11`; 06-06-TRACER.md `anchors_row_root`, `anchors_row_count`, `anchors_row_tx_sig`; 06-PROOF.md `anchor_root`, `anchor_tx_sig`, `anchor_count` |
| SC-3 `substrate verify <graph_id>` recomputes the chain and checks roots against signatures | 06-04 T1/T3 (chain: pre per session, post whole-hour global), 06-07 T1-T3 (anchor check, signer trust, CLI) | 06-07-SMOKE.md `smoke_anchor_line=anchor <hour> anchored`, `pending_anchor_status=pending`, `unverified_verify_exit=1`; `pre_cutover_graphs_verified=N/N` |
| **Proof** — alter one event row, `verify` flags the graph (procedure D-12, with restore) | 06-09 T1-T3 | 06-PROOF.md `a_verify_exit=1` (`a_chain_reason=hash does not match contents`, `a_hour_status=mismatch`), `b_verify_exit=1` (`b_broken_at=b_expected_successor`, `b_hour_status=mismatch`), `a/b_restore_byte_equal=true`, `a/b_verify_after_restore_exit=0`, `final_rows_equal_originals=true`, `proof_result=pass` |

## Decisions D-01..D-16 → plan/task

| Decision | Covered by | How |
|---|---|---|
| D-01 hashing stays on ingest; no producer changes; SC1 re-worded | 06-04 T1-T3, 06-05 T2, 06-09 T3 | normalizeEvent hashes after redaction; no path under collectors/projector/host/dispatcher in any `(06-` commit (checked); SC1 re-scope handed to the orchestrator |
| D-02 one global chain; promise-serialized emit; in-memory head seeded on boot; lastHash unused | 06-04 T2 (IngestChain), 06-04 T3 (emit, seedChain, lastHash/insertEvent removed), 06-05 T2 (live) | one drain loop, `queue.splice(0)`, one INSERT per turn; head unknown → re-seed; `[substrate] chain head …` log |
| D-03 no re-chaining; cutover event recorded; per-session verify stays valid for old rows | 06-01 T1 (fixture), 06-04 T1 (absent-not-null, verifySessions), 06-05 T2 (cutover record), 06-05/06-07/06-09 (baseline graphs) | `cutover_event_id`, `cutover_hash`, `cutover_ingested_at`, `historical_rows_at_cutover`, `deployed_commit`; N/N baseline graphs at every restart |
| D-04 dedicated devnet key 0600 root; SOLANA_ANCHOR_KEYPAIR + SOLANA_RPC_URL; id.json and CLI config untouched | 06-03 T1, 06-02 T3 (argv takes the path only), 06-09 T3 | `--silent`, no `--force`, absence guard; three guarded env lines (+ non-secret SOLANA_ANCHOR_PUBKEY); `solana config get` and id.json stat compared with the baseline |
| D-05 agent airdrops; owner checkpoint only if refused | 06-03 T1 (airdrop ×3), 06-03 T2 `<precondition>` (balance ≥ 0.1 SOL; unmet only when the airdrop failed → the executor's precondition-unmet blocking-human checkpoint with the user_setup step) | `airdrop_result`; `owner_funding=not_needed|owner` |
| D-06 CLI-only memo, no new npm deps; 0-lamport spike, 1-lamport fallback | 06-02 T3 (transferMemoArgv), 06-03 T2 (spike), 06-06 T2 (ANCHOR_AMOUNT_SOL from the spike; `first_anchor_path=sent`, `output_shape_proven=true` — covers a spike recorded as `spike_output_json_keys=unobserved_landed_after_error`), 06-09 T3 (no manifest change) | `spike_amount`, `spike_memo_program`, `spike_output_json_keys`; `phase6_dependency_changes=0` |
| D-07 hourly timer (OnCalendar=hourly, Persistent=true) runs `ledger anchor`; closed, not-yet-anchored hours older than a lag; skip empty; idempotent via anchors rows; non-zero exit on RPC failure | 06-06 T2 (planAnchors, runAnchor, re-run no-op), 06-08 T1/T2 | `rerun_nothing=true`; `failure_path_exit=1` with rows unchanged; unit lines grep-checked |
| D-08 anchors in Greptime, re-created keyed by period | 06-01 T2 (spike), 06-04 T2 (guarded migrate), 06-05 T1 (live), 06-06 T1 (store) | DROP only while root is a TAG and count = 0; period_start time index, no PRIMARY KEY |
| D-09 additive `ingested_at`; hours by ingest time | 06-01 T2 (spike), 06-02 T2 (period.ts), 06-04 T1/T2, 06-05 T1 | information_schema check before ADD COLUMN; `ingested_at_column=FIELD:timestamp(3)` |
| D-10 RFC 6962 (0x00/0x01, no duplicate-last) over hashes ordered by (ingested_at, id); memo `substrate:v1:<period>:<root>:<count>` | 06-02 T1/T2, 06-06 T1 (hourDigest) | 8 reference roots; anchored memo regex; leaves recomputed |
| D-11 verify = chain + per-hour anchor check; memo fetched server-side with an RPC timeout; first mismatching hour; recent unanchored = pending; CLI thin POST, exit 0/1 | 06-04 T3 (chain half), 06-07 T1-T3 | `firstBadHour`; `SUBSTRATE_VERIFY_TIMEOUT_MS`; cmdVerify is a single `post("/verify", …)` and Phase 6 adds no ledger/greptime/ledger-verify import to the CLI (diff since the baseline head; Phase 4's in-process `skills propose` imports are expected — Phase 5's docs half, which would have added `docs ingest\|search`, was skipped by the owner) |
| D-12 proof: throwaway graph, 3 events, anchored, overwrite middle (a) stale hash, (b) recomputed hash, both flagged, restore, originals captured first | 06-09 T1-T3 | see Proof row |
| D-13 (OQ1) keep `OnCalendar=hourly` + 5 min lag; manual start only as a recorded fallback | 06-06 T2 (`ANCHOR_LAG_MS`), 06-08 T1 (units), 06-09 T1 (`anchored_by`) | pending window ≤ ~2 h stated in 06-06-TRACER Gaps and 06-PROOF Gaps |
| D-14 (OQ2) pending within 3 h of the hour's end; older unanchored hours fail | 06-07 T1 (`PENDING_MS`), 06-07 T2 | boundary test at end + 3 h − 1 ms / + 3 h |
| D-15 (OQ3) adopt an existing signer-checked on-chain memo instead of re-anchoring | 06-06 T2 | adopt tests (trusted, other signer ignored, differing root → ALARM + exit 1) |
| D-16 (OQ4) fail closed with a distinct `unverified` message | 06-07 T1-T3 | `unverified_verify_exit=1`, `unverified_message_distinct=true` (dead-RPC instance on 127.0.0.1:7419) |

## CONTEXT discretion items (research recommendations the planner adopted)

| Item | Covered by |
|---|---|
| `ts := ingested_at` for events without a client ts; strictly increasing `ingested_at` | 06-04 T2 (tests), 06-05 T2 (`smoke_ts_equals_ingested_at`, `ingested_at_strictly_increasing`) |
| Pre-insert duplicate guard for client-ts events | 06-04 T2 (NULL-safe keys, replay, nudge, 5-nudge cap), 06-05 T2 (`replay_same_id`, `collision_nudged_ms=1`) |
| Batch queued emits into one INSERT (~182 ms RTT) | 06-04 T2 ("batches queued emits into one insert", "stays under the hook budget"), 06-05 T2 (`emit_latency_max_ms` < 1500) |
| Merkle leaves are recomputed content hashes; flag stale rows | 06-06 T1 (hourDigest), 06-06 T2 (`stale_hashes`, WARNING line) |
| Non-secret `SOLANA_ANCHOR_PUBKEY`; signer check | 06-03 T1 (env line), 06-06 T2 (key match before send), 06-07 T1 (verify signer) |
| Match every Memo program ID | 06-02 T2/T3 (`MEMO_PROGRAM_IDS`), 06-03 T2 (observed program) |
| Lag value (5 min), extra anchors columns, verify reply shape, module layout, mutex design | 06-06, 06-04, 06-07 per 06-RESEARCH § Q2, § Q4, Pattern 3 |

## Orchestrator requirements → plan/task

| Requirement | Covered by |
|---|---|
| 1. Every SC (SC1 per D-01), the proof and every D-01..D-12 map to a task with an observable `<automated>` and `<fails_when>` | tables above; every auto task has both (`verify.plan-structure` valid for all nine plans) |
| 2. Live changes carry snapshot + RESTORE + guard (substrate.env, Greptime DDL, timer/service, substrate-mcp restarts, airdrop and memos) | 06-03 T1 (env snapshot, per-name guard, targeted removal route), 06-05 T1/T2 (schema guard vs snapshot, with an early-cutover branch when the schema already equals 06-04's target and substrate-mcp restarted after the 06-04 commits; DROP COLUMN/anchors routes gated on count = 0; code revert route; guarded restart), 06-07 T3 (restart route), 06-08 T1 (absence guard, listing snapshot, disable/remove route), 06-03 T1/T2 + 06-06 T2 (airdrop only below threshold; spike sent once; anchors only for planned hours, adopt instead of re-send; devnet is permanent — route is to stop using the key), 06-09 T1 (originals + RESTORE.d/06-09.md) |
| 3. Emit stays inside the 1.5 s hook budget via batched multi-row INSERTs, with a test | 06-04 T2 (two named tests), 06-05 T2 (live 20-way and 7-way bursts) |
| 4. Pre-cutover rows still verify; rowToEvent leaves ingested_at absent for NULL; regression pinned on the existing graphs | 06-01 T1 (fixture of every baseline-ok graph), 06-04 T1 (fixture test + inverse), 06-05 T2 / 06-07 T3 / 06-09 T3 (live N/N) |
| 5. Proof per D-12 with evidence in 06-PROOF.md | 06-09 T1-T3 |
| 6. checkpoint:human-action only for a refused airdrop | No static checkpoint task anywhere: the owner is reached only through 06-03 T2's precondition (funded key), which fails only when the airdrop was refused; all nine plans are `autonomous: true` |
| 7. Runs after Phases 4 and 5; shared files edited additively | 06-01 T1 phase-order gate (04/05-VERIFICATION `passed`, or `accepted` with a verbatim note; `phase45-symbols`: "skill.propose" and "docs.ingest" in types.ts, `skills propose` in the CLI — Phase 5 lands as its desktop half only, the owner skipped the docs half); 06-PATTERNS § Cross-phase file overlap; 06-04 and 06-07 objectives; server.ts and mcp.ts untouched |

## Standing rules → plan/task

| Rule | Covered by |
|---|---|
| Two-sided gates against a measured `06-BASELINE.md` | 06-01 T1; every code task's `<automated>` (bun + tsc; dispatcher in 06-04 T3, 06-07 T3, 06-09 T3) |
| Snapshot under `/var/lib/substrate/phase6-baseline/` with a RESTORE route before any live edit | 06-01 T1 (index), RESTORE.d/06-01, 06-03, 06-05, 06-07, 06-08, 06-09 |
| Read `/var/lib/substrate/phase1-baseline/RESTORE.md` before touching a Phase 1 file | 06-01 T1 reads it and records that no Phase 1 snapshotted file is in scope |
| Explicit-path staging; `Refs SPE-3576` | every task action; commit bodies checked in the verifies |
| Never print secrets (keypair contents and seed included) | `grep -c` only on substrate.env; keygen `--silent`; `stat` for key mode; evidence and journal scanned for token shapes and 64-number keypair arrays |
| Fail open for collectors | 06-04 (emit rejects with 500 exactly as when Greptime is down; hooks exit 0), 06-05 T2 (latency) |

## Capability coverage (INTEGRATE / OPT-OUT)

| capability | decision | reason |
|---|---|---|
| Greptime: `ALTER TABLE … ADD COLUMN`, guarded `DROP TABLE "anchors"`, new `CREATE TABLE` | INTEGRATE | D-08, D-09 (06-04, 06-05) |
| Greptime: `SET 'append_mode'='true'`, a tag column for `id`, a new append-mode table | OPT-OUT | rejected by research as one-way or contrary to D-09's additive ALTER |
| Greptime: re-chaining or anchoring pre-cutover rows | OPT-OUT | explicitly out of scope (D-03; CONTEXT § Not in this phase) |
| substrate-mcp: global IngestChain, `/verify` reply superset, `config.ledger` | INTEGRATE | D-02, D-11 |
| substrate-mcp: new routes or MCP tools | OPT-OUT | not needed — `/events`, `/brief`, `/verify` shapes and tool names unchanged (Phase Boundary) |
| solana-cli: `solana-keygen new/pubkey`, `solana airdrop`, `solana transfer --with-memo --output json`, `solana confirm -v`, `solana balance` | INTEGRATE | D-04, D-05, D-06 (06-03, 06-06) |
| solana-cli: `solana config set`, `~/.config/solana/id.json` | OPT-OUT | D-04 — shared config left untouched (checked) |
| devnet JSON-RPC: `getTransaction` (jsonParsed), `getSignaturesForAddress`, `getBalance` | INTEGRATE | verify and the job (06-02, 06-06, 06-07) |
| faucet.solana.com from the agent | OPT-OUT | the faucet forbids AI agents; owner route only (D-05 checkpoint) |
| systemd: `substrate-ledger-anchor.{service,timer}` | INTEGRATE | D-07 (06-08) |
| Mainnet, a paid or dedicated devnet RPC | OPT-OUT | explicitly out of scope (CONTEXT § Deferred) |
| Genesis anchor over pre-cutover hashes; `verify --all`; per-event inclusion proofs; `ledger anchor --reindex` | OPT-OUT | explicitly out of scope (CONTEXT § Deferred) |
| Client-side hashing in producers | OPT-OUT | D-01 — hashing stays on ingest |
| npm `@solana/web3.js` | OPT-OUT | D-06 — CLI only, no new dependency |
