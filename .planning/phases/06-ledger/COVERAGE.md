# Coverage — Phase 6 (Ledger)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Plans: 06-01 (phase-order gate on Phases 4/5 — Phase 5 desktop half only, docs half owner-skipped 2026-09-27 (SPE-3970), so no `docs ingest` CLI symbol is required; baseline, rollback area, pre-cutover fixture, Greptime scratch spike), 06-02 (ledger core: Merkle, memo, hours, Solana argv, devnet RPC),
> 06-03 (devnet key, substrate.env, funding checkpoint, memo spike), 06-04 (ingest chain code: hashing rules, Greptime contract, IngestChain, verify split),
> 06-05 (cutover: guarded DDL, restart, cutover record, live smoke), ~~06-06 (anchor job + devnet tracer)~~ skipped-owner, 06-07 (verify CLI: per-hour chain lines, own timeout — revised),
> ~~06-08 (hourly timer)~~ skipped-owner, 06-09 (chain-only proof — revised).
> Task references are `plan / task` (e.g. 06-09 T2). D-13..D-16 are the orchestrator-approved answers to 06-RESEARCH Open Questions 1-4 (2026-09-26), recorded in 06-CONTEXT.md.
>
> **Revision 2026-09-27 — D-17, owner skipped anchoring (SPE-3970).** At 06-03's funding checkpoint the owner answered (verbatim) "Skip Phase 6 anchoring": the devnet key could not be funded. Status `skipped-owner (D-17)` below means that coverage is intentionally absent. Affected: SC2 in full, SC3's signature clause, D-12 step 2 and (b)'s anchor catch, 06-03 T2, 06-06, 06-08 and the anchor half of 06-07. Remaining order: 06-04 (wave 2) → 06-05 (wave 3) → 06-07 (wave 4; revised to chain-only CLI output and its own timeout) → 06-09 (wave 5; revised to a chain-only proof).

## ROADMAP success criteria and proof → plan/task

| Criterion | Covered by | Evidence key(s) |
|---|---|---|
| SC-1 **as re-scoped by D-01**: every event is hashed on ingest over the canonical event JSON and carries `prev` (original wording "Every collector computes `hash` …" kept quoted; the orchestrator annotates ROADMAP in place) | 06-04 T1 (hash covers ingested_at; historical hashes unchanged), 06-04 T2/T3 (global chain on ingest), 06-05 T2 (live), 06-09 T1-T3 (chain-only proof; no producer changed; `sc1_rescope`) | 06-05-CUTOVER.md `post_cutover_hash_null=0`, `post_cutover_prev_null=1`, `post_cutover_chain_breaks=0`, `cutover_prev=null`; 06-PROOF.md `phase6_producer_changes=0`, `sc1_rescope=D-01` |
| SC-2 hourly systemd timer Merkle-roots the hour's events into a Solana **devnet** memo | **skipped-owner (D-17)** — 06-06 and 06-08 not executed; the 06-02 Merkle/memo/solana/rpc code exists and is unit-tested but is never called on-chain | 06-03-SUMMARY.md `owner_funding=owner-skip`, `spike_result=skipped-owner`; 06-PROOF.md `sc2_status=skipped-owner-D-17` |
| SC-2 records root, signature and event count in an `anchors` table | **skipped-owner (D-17)** — the period-keyed table exists (06-04 T2 DDL, 06-05 T1 live re-create, 11 columns) but is never written | 06-05-CUTOVER.md `anchors_columns=11`, `anchors_rows=0`; 06-PROOF.md `anchors_rows_final=0` |
| SC-3 `substrate verify <graph_id>` recomputes the chain | 06-04 T1/T3 (chain: pre per session, post whole-hour global with boundary prev), 06-05 T2 (live), 06-07 T1/T2 (CLI per-hour chain lines, own 60 s timeout), 06-09 T1-T3 | 06-05-CUTOVER.md `post_cutover_chain_breaks=0`, `smoke_graph_verify_ok=true`; 06-07-SMOKE.md `smoke_hour_chain=ok`, `pre_cutover_graphs_verified=N/N`, `cli_timeout_env_honoured=true`; 06-PROOF.md `a_hour_chain=broken`, `b_hour_chain=broken` |
| SC-3 … and checks roots against signatures | **skipped-owner (D-17)** — no anchors, no memos; the signer-checked memo read, pending/unanchored/mismatch/unverified states were removed from 06-07 | 06-PROOF.md `sc3_signature_clause=skipped-owner-D-17` |
| **Proof** — alter one event row, `verify` flags the graph (procedure D-12, chain-only per D-17, with restore) | 06-09 T1-T3 | 06-PROOF.md `b_detectable_by_chain=true` (successor located in H before any write), `a_verify_exit=1` (`a_chain_reason=hash does not match contents` at event 2, `a_hour_chain=broken`), `b_verify_exit=1` (`b_chain_reason=prev does not match the preceding event`, `b_broken_at=b_expected_successor=middle_successor`, `b_caught_by=chain-prev-linkage`), `a/b_restore_byte_equal=true`, `a/b_verify_after_restore_exit=0`, `final_rows_equal_originals=true`, `proof_result=pass` |

## Decisions D-01..D-17 → plan/task

| Decision | Covered by | How |
|---|---|---|
| D-01 hashing stays on ingest; no producer changes; SC1 re-worded | 06-04 T1-T3, 06-05 T2, 06-09 T3 | normalizeEvent hashes after redaction; no path under collectors/projector/host/dispatcher in any `(06-` commit (checked); SC1 re-scope handed to the orchestrator |
| D-02 one global chain; promise-serialized emit; in-memory head seeded on boot; lastHash unused | 06-04 T2 (IngestChain), 06-04 T3 (emit, seedChain, lastHash/insertEvent removed), 06-05 T2 (live) | one drain loop, `queue.splice(0)`, one INSERT per turn; head unknown → re-seed; `[substrate] chain head …` log |
| D-03 no re-chaining; cutover event recorded; per-session verify stays valid for old rows | 06-01 T1 (fixture), 06-04 T1 (absent-not-null, verifySessions), 06-05 T2 (cutover record), 06-05 T2 / 06-07 T2 / 06-09 T3 (baseline graphs) | `cutover_event_id`, `cutover_hash`, `cutover_ingested_at`, `historical_rows_at_cutover`, `deployed_commit`; N/N baseline graphs at every restart |
| D-04 dedicated devnet key 0600 root; SOLANA_ANCHOR_KEYPAIR + SOLANA_RPC_URL; id.json and CLI config untouched | 06-03 T1 (done), 06-02 T3 (argv takes the path only), 06-09 T3 | `--silent`, no `--force`, absence guard; three guarded env lines (+ non-secret SOLANA_ANCHOR_PUBKEY), kept unused after D-17 (removal: RESTORE.d/06-03.md); `solana config get` and id.json stat compared with the baseline (`solana_config_rpc_final`) |
| D-05 agent airdrops; owner checkpoint only if refused | 06-03 T1 (airdrop ×3, refused), 06-03 T2 precondition checkpoint (owner reached) | `airdrop_result`; `owner_funding=owner-skip` — the owner answered "Skip Phase 6 anchoring" → D-17 |
| D-06 CLI-only memo, no new npm deps; 0-lamport spike, 1-lamport fallback | CLI-only / no-new-deps half: 06-02 T3 (transferMemoArgv, unit only), 06-09 T3 (`phase6_dependency_changes=0`). Memo spike and sends: **skipped-owner (D-17)** (06-03 T2, 06-06 T2 not run) | `spike_result=skipped-owner`; `phase6_dependency_changes=0` |
| D-07 hourly timer (OnCalendar=hourly, Persistent=true) runs `ledger anchor`; closed, not-yet-anchored hours older than a lag; skip empty; idempotent via anchors rows; non-zero exit on RPC failure | **skipped-owner (D-17)** — 06-06 T2 and 06-08 not executed | — |
| D-08 anchors in Greptime, re-created keyed by period | 06-01 T2 (spike), 06-04 T2 (guarded migrate), 06-05 T1 (live; kept deliberately — migrate() runs on every boot and the table stays empty under D-17) | DROP only while root is a TAG and count = 0; period_start time index, no PRIMARY KEY; `anchors_rows=0` (06-05), `anchors_rows_final=0` (06-09) |
| D-09 additive `ingested_at`; hours by ingest time | 06-01 T2 (spike), 06-02 T2 (period.ts), 06-04 T1/T2, 06-05 T1 | information_schema check before ADD COLUMN; `ingested_at_column=FIELD:timestamp(3)` |
| D-10 RFC 6962 (0x00/0x01, no duplicate-last) over hashes ordered by (ingested_at, id); memo `substrate:v1:<period>:<root>:<count>` | 06-02 T1/T2 (unit, done). On-chain use (06-06 T1 hourDigest): **skipped-owner (D-17)** | 8 reference roots; anchored memo regex |
| D-11 verify = chain + per-hour anchor check; memo fetched server-side with an RPC timeout; first mismatching hour; recent unanchored = pending; CLI thin POST, exit 0/1 | Chain half: 06-04 T3 (server), 06-07 T1/T2 (CLI per-hour chain lines, `SUBSTRATE_VERIFY_TIMEOUT_MS`, thin POST). Anchor half (memo fetch, RPC timeout, pending, first mismatching hour by anchor): **skipped-owner (D-17)** | cmdVerify is a single `post("/verify", …)` and Phase 6 adds no ledger/greptime/ledger-verify import to the CLI (diff since the baseline head; Phase 4's in-process `skills propose` imports are expected — Phase 5's docs half, which would have added `docs ingest\|search`, was skipped by the owner); `cli_default_timeout_ms=60000` |
| D-12 proof: throwaway graph, 3 events, anchored, overwrite middle (a) stale hash, (b) recomputed hash, both flagged, restore, originals captured first | 06-09 T1-T3 (chain-only). Step 2 (wait until anchored) and (b)'s anchor catch: **skipped-owner (D-17)**; (b) is flagged by the global chain's prev linkage at the middle event's successor, located in H before any write | see Proof row |
| D-13 (OQ1) keep `OnCalendar=hourly` + 5 min lag; manual start only as a recorded fallback | **skipped-owner (D-17)** — moot without a timer | — |
| D-14 (OQ2) pending within 3 h of the hour's end; older unanchored hours fail | **skipped-owner (D-17)** — removed from 06-07 | — |
| D-15 (OQ3) adopt an existing signer-checked on-chain memo instead of re-anchoring | **skipped-owner (D-17)** — 06-06 not executed | — |
| D-16 (OQ4) fail closed with a distinct `unverified` message | **skipped-owner (D-17)** — removed from 06-07 | — |
| D-17 owner skipped Solana anchoring ("Skip Phase 6 anchoring", 2026-09-27; key unfunded) | 06-CONTEXT D-17; revision notes in 06-05, 06-06, 06-07, 06-08, 06-09; 06-09 T3 | `sc2_status=skipped-owner-D-17`, `sc3_signature_clause=skipped-owner-D-17`, `anchors_rows_final=0`; residual risk (consistent rewrite through the head plus restart) stated in 06-PROOF.md Gaps |

## CONTEXT discretion items (research recommendations the planner adopted)

| Item | Covered by |
|---|---|
| `ts := ingested_at` for events without a client ts; strictly increasing `ingested_at` | 06-04 T2 (tests), 06-05 T2 (`smoke_ts_equals_ingested_at`, `ingested_at_strictly_increasing`) |
| Pre-insert duplicate guard for client-ts events | 06-04 T2 (NULL-safe keys, replay, nudge, 5-nudge cap), 06-05 T2 (`replay_same_id`, `collision_nudged_ms=1`) |
| Batch queued emits into one INSERT (~182 ms RTT) | 06-04 T2 ("batches queued emits into one insert", "stays under the hook budget"), 06-05 T2 (`emit_latency_max_ms` < 1500) |
| Merkle leaves are recomputed content hashes; flag stale rows | **skipped-owner (D-17)** (06-06 not executed) |
| Non-secret `SOLANA_ANCHOR_PUBKEY`; signer check | 06-03 T1 (env line, unused); signer check **skipped-owner (D-17)** |
| Match every Memo program ID | 06-02 T2/T3 (`MEMO_PROGRAM_IDS`, unit only); observed program (06-03 T2) **skipped-owner (D-17)** |
| Lag value (5 min), extra anchors columns, verify reply shape, module layout, mutex design | 06-04 (anchors columns, verify reply shape, mutex) per 06-RESEARCH § Q2, § Q4, Pattern 3; lag value skipped-owner (D-17) |

## Orchestrator requirements → plan/task

| Requirement | Covered by |
|---|---|
| 1. Every SC (SC1 per D-01), the proof and every D-01..D-12 map to a task with an observable `<automated>` and `<fails_when>` | tables above; every auto task has both (`verify.plan-structure` valid for all nine plans). Exceptions are the rows marked skipped-owner (D-17): SC2, SC3's signature clause, D-07, D-12 step 2, and the on-chain half of D-06/D-10/D-11 |
| 2. Live changes carry snapshot + RESTORE + guard (substrate.env, Greptime DDL, substrate-mcp restarts, airdrop; timer/service and memos skipped-owner under D-17) | 06-03 T1 (env snapshot, per-name guard, targeted removal route; airdrop only below threshold, refused — nothing sent), 06-05 T1/T2 (schema guard vs snapshot, with an early-cutover branch when the schema already equals 06-04's target and substrate-mcp restarted after the 06-04 commits; DROP COLUMN/anchors routes gated on count = 0; code revert route; guarded restart), 06-09 T1 (originals + RESTORE.d/06-09.md). 06-07 (revised) makes no live change (CLI only, no restart). 06-06 T2 memos and 06-08 T1 units: skipped-owner (D-17) |
| 3. Emit stays inside the 1.5 s hook budget via batched multi-row INSERTs, with a test | 06-04 T2 (two named tests), 06-05 T2 (live 20-way and 7-way bursts) |
| 4. Pre-cutover rows still verify; rowToEvent leaves ingested_at absent for NULL; regression pinned on the existing graphs | 06-01 T1 (fixture of every baseline-ok graph), 06-04 T1 (fixture test + inverse), 06-05 T2 / 06-07 T2 / 06-09 T3 (live N/N) |
| 5. Proof per D-12 with evidence in 06-PROOF.md | 06-09 T1-T3 (chain-only per D-17) |
| 6. checkpoint:human-action only for a refused airdrop | No static checkpoint task anywhere: the owner was reached only through 06-03 T2's precondition (funded key) after the airdrop was refused, and answered "Skip Phase 6 anchoring" (D-17); all nine plans are `autonomous: true` and no remaining plan has a human checkpoint |
| 7. Runs after Phases 4 and 5; shared files edited additively | 06-01 T1 phase-order gate (04/05-VERIFICATION `passed`, or `accepted` with a verbatim note; `phase45-symbols`: "skill.propose" and "docs.ingest" in types.ts, `skills propose` in the CLI — Phase 5 lands as its desktop half only, the owner skipped the docs half); 06-PATTERNS § Cross-phase file overlap; 06-04 and 06-07 objectives (revised 06-07 edits only packages/cli/src/index.ts); server.ts and mcp.ts untouched |

## Standing rules → plan/task

| Rule | Covered by |
|---|---|
| Two-sided gates against a measured `06-BASELINE.md` | 06-01 T1; every code task's `<automated>` (bun + tsc; dispatcher in 06-04 T3, 06-07 T2, 06-09 T3) |
| Snapshot under `/var/lib/substrate/phase6-baseline/` with a RESTORE route before any live edit | 06-01 T1 (index), RESTORE.d/06-01, 06-03, 06-05, 06-09 (06-07 revised makes no live edit; RESTORE.d/06-08 skipped-owner, D-17) |
| Read `/var/lib/substrate/phase1-baseline/RESTORE.md` before touching a Phase 1 file | 06-01 T1 reads it and records that no Phase 1 snapshotted file is in scope |
| Explicit-path staging; `Refs SPE-3576` (revised plans also add `Refs SPE-3970`) | every task action; commit bodies checked in the verifies |
| Never print secrets (keypair contents and seed included) | `grep -c` only on substrate.env; keygen `--silent`; `stat` for key mode; evidence and journal scanned for token shapes and 64-number keypair arrays |
| Fail open for collectors | 06-04 (emit rejects with 500 exactly as when Greptime is down; hooks exit 0), 06-05 T2 (latency) |

## Capability coverage (INTEGRATE / OPT-OUT)

| capability | decision | reason |
|---|---|---|
| Greptime: `ALTER TABLE … ADD COLUMN`, guarded `DROP TABLE "anchors"`, new `CREATE TABLE` | INTEGRATE | D-08, D-09 (06-04, 06-05) |
| Greptime: `SET 'append_mode'='true'`, a tag column for `id`, a new append-mode table | OPT-OUT | rejected by research as one-way or contrary to D-09's additive ALTER |
| Greptime: re-chaining or anchoring pre-cutover rows | OPT-OUT | explicitly out of scope (D-03; CONTEXT § Not in this phase) |
| substrate-mcp: global IngestChain, `/verify` reply superset (chain, hours) | INTEGRATE | D-02, D-11 chain half (06-04) |
| substrate-mcp: `config.ledger`, LedgerVerifier, verifyGraph anchor check | OPT-OUT | skipped-owner (D-17) — no anchors to check |
| substrate-mcp: new routes or MCP tools | OPT-OUT | not needed — `/events`, `/brief`, `/verify` shapes and tool names unchanged (Phase Boundary) |
| solana-cli: `solana-keygen new/pubkey`, `solana airdrop`, `solana balance` | INTEGRATE | D-04, D-05 (06-03 T1, done; the key stays unfunded and unused) |
| solana-cli: `solana transfer --with-memo --output json`, `solana confirm -v` | OPT-OUT | skipped-owner (D-17) — 06-03 T2 and 06-06 not run; 06-02's argv builder stays unit-tested only |
| solana-cli: `solana config set`, `~/.config/solana/id.json` | OPT-OUT | D-04 — shared config left untouched (checked) |
| devnet JSON-RPC: `getTransaction` (jsonParsed), `getSignaturesForAddress`, `getBalance` | OPT-OUT (runtime) | skipped-owner (D-17) — 06-02's reader exists and is unit-tested; verify and the job never call it |
| faucet.solana.com from the agent | OPT-OUT | the faucet forbids AI agents; the owner route was reached at 06-03 T2 and answered "Skip Phase 6 anchoring" (D-17) |
| systemd: `substrate-ledger-anchor.{service,timer}` | OPT-OUT | skipped-owner (D-17) — 06-08 not executed |
| Mainnet, a paid or dedicated devnet RPC | OPT-OUT | explicitly out of scope (CONTEXT § Deferred) |
| Genesis anchor over pre-cutover hashes; `verify --all`; per-event inclusion proofs; `ledger anchor --reindex` | OPT-OUT | explicitly out of scope (CONTEXT § Deferred) |
| Client-side hashing in producers | OPT-OUT | D-01 — hashing stays on ingest |
| npm `@solana/web3.js` | OPT-OUT | D-06 — CLI only, no new dependency |
