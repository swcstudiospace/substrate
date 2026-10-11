# Phase 28: Hourly anchor job and verify - Context

**Gathered:** 2026-10-09
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). Answers that change what the operator sees (the tamper proof's chain, the live re-run proof, how `verify` treats events with no ingest record) are recommended defaults the plan uses, and they are listed under "Open for the operator".

<domain>
## Phase Boundary

One PR on agent-substrate (ANCHOR-03, ANCHOR-04, ANCHOR-05, ANCHOR-06). Every closed, non-empty UTC ingest hour is anchored exactly once on Solana devnet, and `substrate verify <graph_id>` / `POST /verify` check a graph's chain and, per hour, its anchor.

1. **The anchor job.** A one-shot entry point inside `packages/mcp-server/src` (store lock rule 1) run by `substrate-anchor.timer` (`OnCalendar=hourly`, `Persistent=true`). For each closed, non-empty, not-yet-anchored hour it computes `Substrate.hourDigest`, adopts an existing signer-checked memo for that period if one is on chain, otherwise sends the memo through the solana CLI (keypair path only, devnet only), writes the production 11-column `anchors` row, and emits `anchor.written` / `anchor.failed` as surface `substrate`. A root mismatch raises an alarm and exits 1.
2. **Per-hour verify.** `Substrate.verifyGraph` keeps the per-session chain check and adds an hour report: for every ingest hour holding one of the graph's events, recompute the root and compare it with the memo read back from devnet by `tx_sig`. States: `anchored`, `pending` (≤ 3 h after close), `unanchored`, `mismatch`, `unverified` (fail-closed). The CLI, `POST /verify` and `events_verify` share that verdict.
3. **Units and docs.** `infra/vps/substrate-anchor.{service,timer}` plus drop-in, `.env.example`, `docs/greptime-ledger.md`, `infra/vps/README.md`.
4. **Proof (ANCHOR-06).** Isolated: unit tests plus a scratch tamper run on the Phase 16 harness against a local fake chain. Live (operator-approved window, funded key): one real devnet anchor read back, the untouched proof graph verifying with every hour anchored, and a re-run that adopts the existing memo.

**Depends on Phase 27 code** (`@substrate/ledger`, `event_ingest`, `GreptimeClient.hourLeaves`, `Substrate.hourDigest`, `INGEST_LAG_MS`, canonical `anchors` DDL). Execution starts from a base where Phase 27 has merged; Phase 28 planning reads Phase 27's plans as the interface contract (`/root/src/worktrees/agent-substrate-v13-p27/.planning/phases/27-ledger-primitives-and-ingest-order/`).

**Out of scope:**
- Anchors in the evidence bundle (FEATURES E-D1); `buildGraphEvidence` stays chain-only.
- Teachable anchoring and Agent Cards (Phase 29).
- A repair sweep for events whose ingest record failed (D27-09); still deferred.
- Changing how the D-era global-chain window (2026-09-27 to 10-01) verifies (D28-22).
- Any `ALTER`/`DROP` of `anchors`, `event_ingest` or `agent_events`; new `EVENT_KINDS` or `SURFACES` (Phase 17 lock); new redaction rules (Phase 18 owns `redact.ts`).
- Mainnet, a paid RPC, or event content on chain (roots only, build plan §11).

</domain>

<decisions>
## Implementation Decisions

### Where the job runs and how it is scheduled
- **D28-01: The job is a one-shot process inside `packages/mcp-server/src`, not a route.**
  - `anchor.ts` holds the logic (pure orchestration over injected `greptime`, `Substrate`, `Runner`, `Rpc`, clock); `anchor-run.ts` is the thin entry point (`backfill-run.ts` precedent) that builds them from `loadConfig()` and the `SOLANA_*` env.
  - Store lock rule 1 holds without editing `store-lock.test.ts`: only `greptime.ts` composes SQL; `anchor.ts` calls typed methods. `packages/ledger` stays pure (D27-04).
  - Rejected: a loopback `POST /anchor` on substrate-mcp. It would put the signing path and a 120 s CLI call inside the long-lived server and make any token holder a potential trigger.
- **D28-02: Units `infra/vps/substrate-anchor.service` (`Type=oneshot`, no `Restart=`) and `substrate-anchor.timer` (`OnCalendar=hourly`, `Persistent=true`, `Unit=substrate-anchor.service`).**
  - The service follows `substrate-mcp.service`: `WorkingDirectory=/opt/agent-substrate/current`, `ConditionPathExists` on the entry, the same absolute bun, `SyslogIdentifier=substrate-anchor`, the same hardening block, `StateDirectory=substrate`.
  - Drop-in `substrate-anchor.service.d/10-environment.conf` loads `/etc/substrate/substrate.env`. The job is a store client in the same trust domain as the server (Greptime credentials plus the `SOLANA_*` lines September left there, D-04). `doctor-units`' `shared-env` rule targets collectors only, so the doctor stays green.
  - `deploy-release.sh` already refuses a release missing any `ExecStart` entry beside it; it restarts only the units in `SUBSTRATE_RELEASE_UNITS`, and a oneshot reads `current` on every tick, so a deploy needs no change to the script.
- **D28-03: Single instance.** systemd never runs a second instance of an active oneshot unit, and the job re-checks the chain for the period immediately before every send (D28-08). The README says to trigger it only through `systemctl start substrate-anchor.service`. A separate lock file is at the planner's discretion.
- **D28-04: Timing is D-13's.** The timer is literally `OnCalendar=hourly`; the 5-minute lag lives in the job (`INGEST_LAG_MS`, D27-16). An hour is anchored at the second tick after it ends, so it is pending for about 2 h, inside the 3 h window.

### Which hours, and in what order
- **D28-05: Candidates are closed, non-empty hours with no `anchors` row, from the coverage start, ascending, at most 24 per run.**
  - Coverage start is the hour of the earliest `event_ingest` record (the deploy hour, partial but well defined, D27-12). No hour before it is ever anchored.
  - Each run reads the `anchors` rows in the candidate window with one typed read. Empty hours (`event_count: 0`, `root: null`) are skipped and never written.
  - A bounded lookback (planner's choice, e.g. 7 days) keeps the reads cheap; an hour older than the lookback with no row is reported by `verify` as `unanchored`.
- **D28-06: Per-hour integrity failures do not block later hours; systemic failures stop the run.**
  - Per hour: a digest error (D27-13: missing row, malformed or duplicate hash) or a root mismatch emits `anchor.failed`, and the run continues with the next hour.
  - Systemic: wrong cluster, signer mismatch, unfunded key, RPC unreadable, CLI failure or Greptime failure stop the run before the next send.
  - Exit 0 only when every candidate was anchored or adopted (or there was nothing to do: `[anchor] nothing to anchor`); exit 1 otherwise, so the unit shows failed and the next tick retries.

### Sending, adopting and the alarm
- **D28-07: The send is September's D-06 argv, unchanged.** `transferMemoArgv` from `@substrate/ledger`: absolute CLI path, self-transfer, `--with-memo`, `--url`, `--keypair <path>`, `--fee-payer <path>`, `--commitment confirmed`, `--output json`, run through `execFileRunner` (no shell). The keypair is only ever a path; the job never opens it (`solana-keygen pubkey <path>` is the CLI reading it).
  - Preconditions, in order, before the first send of a run: `SOLANA_ANCHOR_KEYPAIR` absolute; `solana-keygen pubkey` equals `SOLANA_ANCHOR_PUBKEY`; the RPC's genesis hash is devnet's (a `getGenesisHash` read added to `rpc.ts`, the only edit to a ported file, recorded in the summary); balance covers the rent-exempt minimum plus fees.
  - Amount: the 0-lamport self-transfer, with `AMOUNT_ONE_LAMPORT` as the fallback if devnet refuses it in the live window. September's spike never ran, so this is `[UNVERIFIED]` until the first live send; the job never retries a send with a different amount on its own.
- **D28-08: Adopt before every send (D-15).** For each candidate, list the key's recent signatures (`addressMemos`), and for any listing hinting at a v1 memo for that period confirm it with `transactionMemo` (memo-program instruction, `payer === SOLANA_ANCHOR_PUBKEY`, `payerSigned`, `err === null`).
  - Same root and count as the recomputed digest: adopt it, write the row with that `tx_sig` and slot, send nothing, emit `anchor.written` with `adopted: true`.
  - Different root or count: **alarm**. Write the row as found (the on-chain memo's root, count, `tx_sig`), emit `anchor.failed` with `reason: "root-mismatch"`, print `[anchor] ALARM <period>: chain root <x> != recomputed <y>` on stderr, and exit 1. The row makes `verify` report that hour as `mismatch` from then on, and the alarm is not re-raised every hour for something nothing can undo.
  - No memo found: send, read the transaction back by signature, write the row.
- **D28-09: The `anchors` row is the production 11-column shape (D27-17).** `period_start`, `period_end`, `root`, `event_count`, `memo`, `tx_sig`, `signer` (the pubkey), `cluster` (`"devnet"`), `slot` (from the read-back), `anchored_at` (job clock), `stale_hashes` NULL. Written by a new typed `GreptimeClient` insert after the adopt check; the table deduplicates by `period_start`, so it is never written for an hour that already has a row.
- **D28-10: Events, surface `substrate` (Phase 17).** `anchor.written` (`note`) and `anchor.failed` (`warning`) exactly as `EVENT_SOURCES` samples them: `session_id: "anchor:<YYYY-MM-DDTHH>"`, `payload.action: "anchor"`, `payload.runtime: "anchor"`, no `repo`. Emitted in-process through `Substrate.emit`, so no `substrate` token is needed. CLI and RPC output quoted in `reason` passes through `redact()` (27-RESEARCH redaction note). `anchor.failed` reasons are a closed set: `digest-failed`, `root-mismatch`, `unfunded`, `wrong-cluster`, `signer-mismatch`, `rpc-unreadable`, `send-failed`, `store-failed`.
- **D28-11: Configuration.** `SOLANA_RPC_URL` (default `https://api.devnet.solana.com`), `SOLANA_ANCHOR_KEYPAIR`, `SOLANA_ANCHOR_PUBKEY` (non-secret), optional `SOLANA_CLI` (default `SOLANA_CLI_DEFAULT`). `.env.example`'s stale `SOLANA_CLUSTER` / `SOLANA_KEYPAIR_PATH` lines are replaced by these names. Missing config makes the job exit 2 with a usage line and send nothing.
- **D28-12: The production key is used by the production unit only.** A memo for period H signed by that key from any other ledger would make production alarm on H. The rehearsal harness never carries `SOLANA_*` names, and the README says so.

### Per-hour verify
- **D28-13: One verdict, three doors.** `Substrate.verifyGraph` gains the hour report; `POST /verify`, `events_verify` and `substrate verify` return it. `buildGraphEvidence` calls it with anchors off and stays chain-only.
- **D28-14: The response is additive.** `ok`, `events`, `brokenAt`, `reason` keep their meaning; new fields: `chain` (`{ ok, brokenAt?, reason? }`), `hours[]` (`{ period_start, status, event_count, root, tx_sig?, slot?, reason? }`), `uncovered` (count plus ids). `ok` is true only when the chain verifies, every hour is `anchored` or `pending`, and no post-coverage event is uncovered (D28-17).
- **D28-15: Hour statuses.**
  - `anchored`: the row's `tx_sig` reads back from devnet, the memo comes from a memo-program instruction signed by `SOLANA_ANCHOR_PUBKEY` with `err === null`, it parses as v1, its period is the hour, and its root and count equal the recomputed digest.
  - `pending`: no row and `now < period_end + 3 h` (`PENDING_MS`, D-14), or the hour is not closed yet.
  - `unanchored`: no row and the 3 h have passed. Fails.
  - `mismatch`: recomputed root or count differs from the memo, the row disagrees with the memo, the memo names another period or signer, or the digest throws (naming the event). Fails, naming the hour.
  - `unverified`: devnet unreadable, the transaction not found, or `SOLANA_ANCHOR_PUBKEY` unset (D-16). Fails closed.
- **D28-16: Which hours.** The graph's events are read as today; their ingest records come from a new typed read of `event_ingest` by stored (normalised) `graph_id`; each event's hour is its first record's (D27-10). Each distinct hour is digested whole (all graphs), then checked once.
- **D28-17: Events with no ingest record.** Events whose `ts` is before the coverage start are `legacy` (counted, not a failure, as the operator accepted in Phase 27). An event with no ingest record and `ts` at or after the coverage start is `uncovered` and fails `verify` naming the event: it is not anchored, and passing it would let an injected row through. (Recommended default; see "Open for the operator".)
- **D28-18: Bounded devnet reads.** RPC reads use `createRpc` with a per-call timeout and bounded attempts, a small concurrency cap across hours, and `SUBSTRATE_VERIFY_TIMEOUT_MS` (ARCHITECTURE env list) as the whole-verify budget; the CLI's `/verify` request uses the same budget instead of the brief timeout.
- **D28-19: CLI output and exit codes.** One line for the chain, one per hour (`<period> anchored <tx_sig>`, `<period> pending`, …). A `mismatch` prints `hour <period> does not match its anchor: <reason>`; an `unverified` hour prints D-16's distinct line `[substrate] verify could not check devnet for <period>: <reason>`. Exit 0 iff `ok`; 1 otherwise (including unreachable substrate); 2 on usage.

### Proof (ANCHOR-06)
- **D28-20: Isolated tamper proof on a fake chain.** On the Phase 16 harness (`bun run rehearsal up --name p28`, sourced `stores.env`), a scratch run:
  1. emits a proof graph's events,
  2. runs the anchor job with `now` past the lag against a local fake chain (a stub solana CLI at an absolute path plus a loopback JSON-RPC stub serving `getTransaction`, `getSignaturesForAddress`, `getBalance`, `getGenesisHash` with devnet's hash),
  3. verifies the untouched graph with every hour `anchored`,
  4. re-runs the job and shows it sends nothing,
  5. simulates a crash between send and row write (memo on the fake chain, no row) and shows the next run adopts it,
  6. alters one event, the last of its session, with its hash recomputed so the per-session chain still verifies, and shows `verify` exits 1 naming that hour as `mismatch`.
  - The alteration exercises the root comparison, not just the duplicate-hash guard: research picks the mechanism (preferred: a scratch ledger with `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=1` so an overwrite replaces the row; fallback: a duplicate row, which D27-13 makes a digest error naming the event). It is driven from `scripts/greptime-smoke.ts` (the named store-lock exemption) or a sibling script that reaches Greptime only through `Substrate`/`GreptimeClient` typed methods; a new exemption must be argued in `store-lock.test.ts`.
- **D28-21: Live proof, operator-approved window, funded key.** After the deploy and timer install (live steps below): the timer anchors a closed hour holding a fresh proof graph's events; the memo read back by `tx_sig` equals the recomputed root and count and is signed by `SOLANA_ANCHOR_PUBKEY`; `substrate verify <proof graph>` exits 0 with every hour `anchored`; a second `systemctl start substrate-anchor.service` sends nothing (key signature list and balance unchanged), and a re-run for that hour (`anchor-run.ts --period <H>`, which takes the adopt path for an already-anchored hour) sends nothing, leaves the `anchors` row unchanged, and emits one `anchor.written` with `adopted: true`. The memo program id seen on devnet settles D27-06.
- **D28-22: The D-era window keeps today's verify behaviour.** Main's per-session check already reports D-era multi-event sessions as broken (their `prev` is the global predecessor), and D27-11 leaves the D-era `ingested_at` column unread, so `verifyGlobalChain` is not ported. Those events are pre-coverage and `legacy` in the hour report. Recorded in `docs/greptime-ledger.md`; any change is a later decision.

### Claude's Discretion
- File and method names (`anchor.ts`/`anchor-run.ts`, `anchorsBetween`/`insertAnchor`/`firstIngestMs`/`graphIngest`), constants (`PENDING_MS`, `MAX_HOURS_PER_RUN`, lookback, RPC timeouts, concurrency), and whether a lock file backs D28-03.
- The `--period <H>` and `--dry-run` flag shapes on `anchor-run.ts`.
- The fake-chain harness layout (inside `greptime-smoke.ts` or a sibling) and the tamper mechanism, per research.
- Plan split and wave layout.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 27 (contract, not yet on `main`): `@substrate/ledger` `merkleRootHex`, `formatMemo`, `parseMemo`, `MEMO_RE`, `MEMO_PROGRAM_IDS`, `stripListingPrefix`, `hourStart`/`hourEnd`/`hourIso`/`isClosed`/`closedHours`, `HOUR_MS`; `rpc.ts` `createRpc` (`transactionMemo`, `addressMemos`, `balance`, `RpcError`, `bs58decode`); `solana.ts` `transferMemoArgv`, `pubkeyArgv`, `keygenPath`, `parseSignature`, `execFileRunner`, `Runner`, `AMOUNT_ZERO`, `AMOUNT_ONE_LAMPORT`, `SOLANA_CLI_DEFAULT`. In `mcp-server`: `GreptimeClient.hourLeaves`, `Substrate.hourDigest(periodStartMs, now)` returning `{ period_start, period_end, event_count, root, memo, event_ids }`, `INGEST_LAG_MS = 300_000`, the `event_ingest` table (`ingested_at`, `event_id`, `event_ts`, `graph_id`) and the canonical 11-column `anchors` DDL.
- `acc30a8:.planning/phases/06-ledger/06-06-PLAN.md` (anchor job + tracer), `06-07` (verify anchor half), `06-08` (timer), `06-CONTEXT.md` D-04..D-16: September's never-executed design, the source of D28-05..D28-15. Read with `git show acc30a8:<path>`.
- `packages/mcp-server/src/backfill-run.ts`: the one-shot entry-point precedent (`loadConfig()`, `new Substrate(...)`, exit codes).
- `packages/mcp-server/src/event-sources.ts` :304-347: the `anchor.written` / `anchor.failed` rows and samples the job must match.
- `scripts/greptime-smoke.ts`: the exempt live harness; Phase 16's `bun run rehearsal up|down --name <n>` and `stores.env`.
- `Substrate.verifyGraph` (`service.ts` :1428), `verifyChain`/`inChainOrder` (`event.ts` :177-222), `POST /verify` (`server.ts` :665), `events_verify` (`mcp.ts` :436), `cmdVerify` (`cli/src/index.ts` :144), `buildGraphEvidence` (`observe.ts` :556).

### Established Patterns
- Only `greptime.ts` and `brief.ts` compose SQL; every statement passes `assertAppendOnly` (INSERT and SELECT only here). Typed methods, values never syntax.
- Fail closed where integrity is claimed (`unverified` is a failure; an `evidence` chain that could not be verified exits 1), fail open for producers.
- `service.test.ts` injects structural stubs; `greptime.test.ts` stubs `fetch` and asserts SQL text; `solana.test.ts`/`rpc.test.ts` already inject `Runner` and `fetchImpl`.
- Units: pinned release `WorkingDirectory`, absolute bun, drop-in `EnvironmentFile`, hardening block; `scripts/doctor-units.ts --dry-run` must stay green over `infra/vps`.
- Doc voice: long-form rationale in comments and `docs/greptime-ledger.md`.

### Integration Points
- `greptime.ts`: typed reads of `anchors` (window and single period), the `anchors` insert, the coverage-start read, and the graph's ingest records.
- `service.ts`: `verifyGraph` hour report; anchors off for evidence.
- `server.ts` `/verify`, `mcp.ts` `events_verify` (description updated), `cli/src/index.ts` `cmdVerify` (output, timeout, exit codes).
- `config.ts`: `SOLANA_RPC_URL`, `SOLANA_ANCHOR_PUBKEY`, `SUBSTRATE_VERIFY_TIMEOUT_MS` for verify; the job reads its own `SOLANA_*`.
- `packages/ledger/src/rpc.ts`: `getGenesisHash` (only edit to a ported file).
- `infra/vps/`: the two units, the drop-in, README section; `.env.example`; `docs/greptime-ledger.md` (anchoring, verify states, D-era note).

</code_context>

<specifics>
## Specific Ideas

- Requirement wording is the contract. ANCHOR-03: "a re-run adopts an existing signer-checked memo, and a root mismatch raises an alarm and exits 1". ANCHOR-04: "only the keypair path on the command line, on devnet only", the row's ten named fields (the eleventh production column, `stale_hashes`, stays NULL). ANCHOR-05: "`pending` for up to 3 h after it closes and `unverified` (fail-closed) when devnet cannot be read". ANCHOR-06: tamper "on a scratch ledger", exit 1 "naming that hour".
- Roots only, never event contents, on devnet only (PROJECT.md; build plan §11). The memo is exactly `MEMO_RE`.
- The devnet key held 0 SOL in September (FEATURES P12). One send costs 5,000 lamports; the balance must also keep the account rent-exempt (~0.00089 SOL). About 1 devnet SOL lasts years at 24 sends a day. Funding is an operator step.

</specifics>

<deferred>
## Deferred Ideas

- Anchors in the evidence bundle with an explorer link per hour (FEATURES E-D1).
- Recording the anchored event ids or a digest of them, so `verify` can tell "late ingest record" from "altered" (PITFALLS 9). No `anchors` column exists for it and `ALTER` is out; an `anchor.written` payload digest is the likely home.
- A repair sweep for events whose ingest record failed (D27-09).
- A legacy verifier for the D-era global-chain window (`verifyGlobalChain`).
- Giving `stale_hashes` a meaning (recomputed-hash count at anchor time).
- Moving the signing key off the shared env file into a job-only env file.

</deferred>

## Open for the operator

Recommended defaults the plan uses; each changes what the operator sees.

1. **The tamper proof runs against a local fake chain, not devnet (D28-20).** Why: a scratch memo signed with the production key for hour H would make production alarm on H forever (D28-12), and the root comparison is the same code either way. Alternative: a second, separately funded scratch key on real devnet.
2. **The live "re-run adopts" proof (D28-21)** is a second timer run that sends nothing, plus `anchor-run.ts --period <H>` taking the adopt path for the anchored hour. The crash-between-send-and-write adoption is proven on the fake chain only, because reproducing it live would mean deleting a production `anchors` row, which the append-only client refuses.
3. **An event stored after coverage began but without an ingest record fails `verify` (D28-17).** Why: it is not anchored, and passing it would let an injected row through. Effect: a graph holding an event whose ingest record failed (the D27-09 warning) stays `ok: false` until a repair sweep exists. Alternative: report such events and keep `ok: true`.

## Live steps (each needs operator approval)

| # | What | Why | Kind |
|---|------|-----|------|
| L1 | Check `/etc/substrate/substrate.env` holds `SOLANA_RPC_URL`, `SOLANA_ANCHOR_KEYPAIR`, `SOLANA_ANCHOR_PUBKEY` (`grep -c '^NAME='`, names only), the key file's owner and mode (`stat`, never contents), `solana --version`, and `solana-keygen pubkey` against `SOLANA_ANCHOR_PUBKEY` | Preconditions for D28-07/D28-11 | read-only |
| L2 | Read the key's devnet balance (`getBalance`) | Funding status | read-only (devnet) |
| L3 | Fund the devnet key (operator) | Sends need fees and rent (key held 0 SOL) | write (devnet) |
| L4 | Add any missing `SOLANA_*` line to `substrate.env` | Config for job and verify | write (host config) |
| L5 | Deploy a release holding Phases 27 and 28 (`deploy-release.sh`, restarts substrate-mcp; `migrate()` creates `event_ingest`) | Coverage starts at this restart | write (production service) |
| L6 | Install `substrate-anchor.service`/`.timer` and the drop-in, `daemon-reload`, `enable --now substrate-anchor.timer`; doctor read-only after | The hourly job | write (systemd) |
| L7 | Emit a fresh proof graph's events into production | The anchored hour must hold a known graph | write (production ledger) |
| L8 | The first real anchor (timer tick, or `systemctl start substrate-anchor.service` as a recorded fallback) | ANCHOR-06 devnet anchor; settles the 0-lamport question and the memo program id | write (devnet + `anchors` row + ledger event) |
| L9 | Read the memo back by `tx_sig`; `substrate verify <proof graph>` | ANCHOR-06 read-back and untouched-graph verify | read-only (devnet, production ledger) |
| L10 | Second `systemctl start substrate-anchor.service` and `anchor-run.ts --period <H>` | ANCHOR-06 re-run adopts; must send nothing | read-only on devnet; may write an `anchor.written` (`adopted: true`) event |
