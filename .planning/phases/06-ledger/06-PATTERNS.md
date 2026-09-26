# Phase 6: Ledger — Pattern Map

**Mapped:** 2026-09-26
**Files analyzed:** 35 (agent-substrate TS 27 incl. 1 JSON fixture, infra 2, evidence 9) plus the live state each plan snapshots
**Analogs found:** 31 / 35 (no in-repo analog: the ingest promise queue, systemd `.timer` units — Phase 4 plans one but it is not executed yet —, the RFC 6962 tree, and Solana JSON-RPC reads)

All analog paths below were read at HEAD `ca82205` and are git-tracked. **Phase 6 executes after Phases 4 and 5**, so every line number cited here will have moved by then: executors read the current file and locate the symbol, never patch by line number. `packages/ledger/` holds only `package.json` (`@substrate/ledger`, a root workspace member) and an empty `src/`. The root `tsconfig.json` includes `packages/**/*.ts`, so every new ledger file is type-checked by the phase gate; it has no `resolveJsonModule`, so the JSON fixture is read with `readFileSync`, never imported.

## Cross-phase file overlap (all Phase 6 edits are additive)

| File | Phase 4 (04-03) | Phase 5 (planning) | Phase 6 edit (plan) | Rule |
|---|---|---|---|---|
| packages/mcp-server/src/types.ts | appends `docs-scraper` to SURFACES, `skill.propose` to EVENT_KINDS | may add kinds | adds `ingested_at?: string` to `SubstrateEvent` and rewords the `prev` comment (06-04 T1) | touch `SubstrateEvent` only; never reorder or drop a SURFACES/EVENT_KINDS entry |
| packages/mcp-server/src/service.ts | `proposeSkill`, `stores.skills` seam | may add docs/desktop methods and seam entries | imports; constructor builds `IngestChain`; `emit`; `seedChain`; private `rowToEvent` deleted (moved); `verifyGraph` (06-04 T3, 06-07 T2); `stores.ledger` seam entry | add seam keys, never rename existing ones; leave every other method untouched |
| packages/mcp-server/src/service.test.ts | adds skills tests | adds docs/desktop tests incl. an `insertEvent` override for the fail-open emit case (05-PATTERNS § service.test.ts) | every greptime stub and override (`lastHash`, `insertEvent`, in any form) moves to the new store contract, a throwing override stays throwing on `insertEvents`; new verifyGraph tests (06-04 T3, 06-07 T2) | contract update only; checked with a word-match grep |
| packages/mcp-server/src/config.ts | — | may add RAGFlow/desktop keys | adds `ledger: { rpcUrl, anchorPubkey, verifyRpcTimeoutMs }` (06-07 T1) | new field + new env names only |
| packages/cli/src/index.ts | adds `skills propose` subcommand (in-process `proposeSkill` imported from `mcp-server/src/skills/propose.ts`) and usage line | 05-04 adds `docs ingest\|search` subcommands, in-process (`RagflowClient.fromConfig(loadConfig(…))` from `mcp-server/src/docs/…`) | `cmdVerify` output and its own `SUBSTRATE_VERIFY_TIMEOUT_MS` (06-07 T3) | `brief`/`emit`/`skills`/`docs` untouched; `post()` gains an optional timeout argument; Phase 6 adds **no** import of ledger, greptime or ledger-verify code (the CLI's existing mcp-server imports are Phase 4/5's) — gated on `git diff <baseline head>` |
| packages/mcp-server/src/index.ts | — | — | calls `substrate.seedChain()` after `migrate()` (06-04 T3) | — |
| packages/mcp-server/src/server.ts, mcp.ts | edited | likely edited | **not edited** — `/events`, `/brief`, `/verify` request shapes and MCP tool names unchanged; `/verify`'s reply becomes a superset | — |

## File Classification

| New/Modified File | Plan | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|---|
| .planning/phases/06-ledger/06-BASELINE.md (NEW) | 06-01 | evidence | key=value | `.planning/phases/03-lane-a/03-BASELINE.md`; `04-01-PLAN.md` Task 1 key list | exact |
| packages/mcp-server/src/fixtures/pre-cutover-rows.json (NEW) | 06-01 | test fixture | — | none (first captured-data fixture); row shape = `service.ts` `verifyGraph` SELECT L507-511 | partial |
| .planning/phases/06-ledger/06-01-SPIKE.md, 06-03-SPIKE.md (NEW) | 06-01, 06-03 | evidence | key=value | `03-01-SPIKE.md`, `04-01-SPIKE.md` | exact |
| packages/ledger/src/merkle.ts (NEW) | 06-02 | pure crypto | transform | `event.ts` `sha256Hex` L25-27 (`Bun.CryptoHasher`); tree per 06-RESEARCH § Code Examples | role-match |
| packages/ledger/src/memo.ts, period.ts (NEW) | 06-02 | pure utility | transform | `hostfns.ts` limits L17-29 (exported constants) and its total validator functions | role-match |
| packages/ledger/src/solana.ts (NEW) | 06-02 | credential-spending argv builder + runner | request-response (execFile) | `packages/host/src/hostfns.ts` `Runner`/`RunResult`/`execFileRunner` L94-112, argv builders | exact (copy the shape, not the import) |
| packages/ledger/src/rpc.ts (NEW) | 06-02 | HTTP client | request-response (JSON-RPC) | `packages/mcp-server/src/linear.ts` `LinearClient` L55-100 (injectable `fetchImpl`, `AbortSignal.timeout`, typed error) | role-match |
| packages/ledger/src/*.test.ts (NEW) | 06-02, 06-06 | test | — | `packages/host/src/hostfns.test.ts` (fake Runner, argv equality); `notion.test.ts` (fake fetch) | exact |
| packages/mcp-server/src/types.ts (M) | 06-04 | contract | — | itself `SubstrateEvent` L62-81 | exact |
| packages/mcp-server/src/event.ts (M: `normalizeEvent` 3rd arg, `rowToEvent`, `verifySessions`, `verifyGlobalChain`) | 06-04 | pure core | transform | itself `normalizeEvent` L57-91, `verifyChain` L97-111; `rowToEvent` moved from `service.ts` L46-73 | exact |
| packages/mcp-server/src/event.test.ts (M) | 06-04 | test | — | itself L35-109 | exact |
| packages/mcp-server/src/greptime.ts (M: `EVENT_COLUMNS`, `columns`, guarded `migrate`, `insertEvents`, `chainHead`, `eventsAtKeys`, `hourEvents`, `lastEventBefore`; `insertEvent`/`lastHash` removed) | 06-04 | store client | CRUD over HTTP SQL | itself `migrate` L88-122, `insertEvent` L124-146, `lastHash` L149-155, `quote` L28-32 | exact |
| packages/mcp-server/src/greptime.test.ts (NEW) | 06-04 | test | — | subclass overriding `sql()` (recording fake); style of `brief.test.ts` | role-match |
| packages/mcp-server/src/chain.ts (NEW: `IngestChain`) | 06-04 | service (serializer) | event-driven queue → batch write | none; closest shapes: `Promise.withResolvers` (`hostfns.ts` L100-111), fail-open `.catch` (`service.ts` L480-493) | none |
| packages/mcp-server/src/chain.test.ts (NEW) | 06-04 | test | — | `service.test.ts` stubStores L11-34 (in-memory store object passed `as never`) | role-match |
| packages/mcp-server/src/service.ts (M) | 06-04, 06-07 | service | request-response | itself constructor seam L82-92, `emit` L130-138, `verifyGraph` L502-526 | exact |
| packages/mcp-server/src/service.test.ts (M) | 06-04, 06-07 | test | — | itself stubStores L27-32 and holderStores L382-387 | exact |
| packages/mcp-server/src/index.ts (M) | 06-04 | entrypoint | — | itself L12-18 (migrate, degraded lines) | exact |
| .planning/phases/06-ledger/06-05-CUTOVER.md (NEW) | 06-05 | evidence | key=value | `03-03-TRACER.md` | exact |
| packages/ledger/src/digest.ts (NEW) | 06-06 | pure core shared by job and verify | transform | `event.ts` `eventHash` L34-36 (recomputed leaves) | role-match |
| packages/ledger/src/store.ts (NEW: `LedgerStore`) | 06-06 | store client | CRUD over HTTP SQL | `greptime.ts` `insertEvent` L124-146 (every column quoted), `brief.ts` L118-124 (read via `sql()`) | role-match |
| packages/ledger/src/anchor.ts (NEW: `planAnchors`, `runAnchor`) | 06-06 | job (planner + executor) | batch | `packages/projector/src/cursor.ts` (idempotent re-run, log prefix) and 06-RESEARCH Pattern 2; executor stops at first failure like `hostfns.ts` `checkScratch` L123 refuses before any write | role-match |
| packages/ledger/src/cli.ts (NEW) | 06-06 | CLI entry | batch | `packages/cli/src/index.ts` `parseArgs` L37-51, `switch` L176-195; `backfill-run.ts` (env-driven one-shot using `loadConfig`) | exact |
| .planning/phases/06-ledger/06-06-TRACER.md (NEW) | 06-06 | evidence | key=value | `03-03-TRACER.md`, `03-05-TRACER.md` | exact |
| packages/mcp-server/src/ledger-verify.ts (NEW) | 06-07 | pure status logic + verifier with cache | request-response | none in repo for the status table; client side = `rpc.ts` (06-02) | partial |
| packages/mcp-server/src/ledger-verify.test.ts (NEW) | 06-07 | test | — | `event.test.ts` chain tests L74-109 | role-match |
| packages/mcp-server/src/config.ts (M) | 06-07 | config | — | itself `positiveMs` L50-53, `loadConfig` L55-83 | exact |
| packages/cli/src/index.ts (M) | 06-07 | CLI | request-response | itself `timeout()` L31-34, `post()` L73-84, `cmdVerify` L154-171 | exact |
| infra/vps/substrate-ledger-anchor.service (NEW) | 06-08 | config | — | `infra/vps/substrate-mcp.service` (bun ExecStart, EnvironmentFile, hardening) | role-match (oneshot) |
| infra/vps/substrate-ledger-anchor.timer (NEW) | 06-08 | config | — | none executed in `infra/vps` (04-03 plans `substrate-skills-sync.timer`; 06-RESEARCH § Q4 template) | none |
| .planning/phases/06-ledger/06-07-SMOKE.md, 06-08-SMOKE.md, 06-PROOF.md (NEW) | 06-07..06-09 | evidence | key=value + `## Gaps` | `03-07-SMOKE.md`, `03-PROOF.md`, `02-PROOF` conventions | exact |

## Pattern Assignments

### solana.ts — analog `packages/host/src/hostfns.ts` L94-112
Copy the shape, not the import (`hostfns.ts` pulls `options.ts`/`seed.ts`): `RunResult`, `Runner`, `execFileRunner` (execFile with an argv, never a shell, 120 s, `maxBuffer` 4 MiB, `env: { ...process.env, HOME: "/root" }`). Pure builders return exact arrays and tests assert them with `toEqual`:
```ts
export const SOLANA_CLI_DEFAULT = "/root/.local/share/solana/install/active_release/bin/solana";
transferMemoArgv({ cli, pubkey, memo, rpcUrl, keypairPath, amountSol }) =>
  [cli, "transfer", pubkey, amountSol, "--with-memo", memo, "--url", rpcUrl, "--keypair", keypairPath,
   "--fee-payer", keypairPath, "--commitment", "confirmed", "--allow-unfunded-recipient", "--output", "json"]
```
The keypair *path* may appear in argv and logs; its *contents* never do. Errors carry at most 200 characters of CLI output. Never `solana config set`; `~/.config/solana` is shared.

### rpc.ts — analog `packages/mcp-server/src/linear.ts` L55-100
`createRpc({ url, timeoutMs, attempts, backoffMs, fetchImpl?, sleep? })`; each call is one JSON-RPC POST with `AbortSignal.timeout(timeoutMs)`, retried `attempts` times with `backoffMs` between; failures throw `RpcError` whose message never includes a response body longer than 200 characters. Memo extraction per 06-RESEARCH § Code Examples: the instruction whose `programId` is in `MEMO_PROGRAM_IDS` (all three: `Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH`, `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`, `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`), `parsed` when it is a string, else base58-decoded `data`.

### event.ts — analog itself
`rowToEvent` moves here from `service.ts` L46-73 unchanged except one rule: `ingested_at` is set **only** when the column is non-null (`canonicalJson` drops `undefined`, `event.ts` L20, so every pre-cutover hash recomputes unchanged; `null` would add `"ingested_at":null` to every digest — 06-RESEARCH Pitfall 2). `normalizeEvent(input, prev, ingestedAt?)` keeps its current body and adds `ingested_at` plus the `ts := ingestedAt` default only when the third argument is given, so the existing `normalizeEvent(base, null)` tests stay valid.

### greptime.ts — analog itself
Every identifier quoted (Greptime reserves `id`); every literal through `quote()`; TIMESTAMP comparisons accept epoch-ms literals. `migrate()` guards (06-RESEARCH Summary 7): read `information_schema.columns` before `ALTER TABLE "agent_events" ADD COLUMN "ingested_at" TIMESTAMP`; drop `anchors` only while its `root` column has `semantic_type = 'TAG'` (the old `PRIMARY KEY ("root")`, observed 2026-09-26) **and** `count(*) = 0`; otherwise throw a `GreptimeError` naming the refusal so `index.ts` logs `degraded`. NULL-safe keys for the duplicate guard: `("repo" = 'x' OR ...)` is wrong for NULL — emit `"repo" IS NULL` when the value is null.

### chain.ts `IngestChain` — no analog
State `head: { hash, ingestedAtMs } | "genesis" | "unknown"`; one drain loop; `queue.splice(0)` per turn; one `insertEvents` per turn; on insert failure the head becomes `unknown` and the next turn re-seeds (06-RESEARCH § Code Examples, "The critical section, simplified"). Invalid inputs reject individually and never advance the head. The single-writer rule (only `substrate-mcp.service` emits with production credentials) is stated in the class doc comment.

### service.ts — analog itself
Constructor seam L82-92: add `ledger?` beside the existing keys (Phase 4 adds `skills?`, Phase 5 `docs?`/`desktop?`). Unlike the other keys, `ledger` defaults to a production LedgerVerifier **only when no stores object is passed** (`new Substrate(config)` in index.ts); a stores object without `ledger` (every unit test) means no anchor check — no LedgerStore read, no RPC, no clock dependence (06-07 T2, test "no ledger seam skips the anchor check"). `emit` keeps its signature `(input: EventInput) => Promise<SubstrateEvent>`, so `server.ts` `/events` (reply `{ id, ts, hash }`) and `mcp.ts` `events_emit` L121 are untouched. `verifyGraph` keeps `ok`, `events`, `brokenAt?`, `reason?` and only adds keys.

### ledger job — analogs `packages/projector/src/cursor.ts`, 06-RESEARCH Pattern 2
Pure `planAnchors(...)` tested with plain objects; `runAnchor(deps)` takes every side effect as a dependency (store, greptime, rpc, runner, clock, log). Log prefix `[ledger]`; a re-run with nothing to do prints one line and exits 0. The executor processes hours in ascending order and stops at the first failure with exit 1 and no row for the failed hour.

### cli/index.ts `verify` — analog itself L154-171
Stays a thin POST (D-11). Only change: `post(path, body, timeoutMs?)` and `cmdVerify` passing `SUBSTRATE_VERIFY_TIMEOUT_MS` (default 60 000); `brief`/`emit` keep the 1.5 s hook budget (L20). The existing `chain intact for <gid> (<n> events)` / `chain BROKEN for <gid> at <id>: <reason>` lines are kept verbatim, followed by one `anchor <period_start> <status>` line per hour.

### systemd units — analog `infra/vps/substrate-mcp.service`
```ini
[Service]
Type=oneshot
EnvironmentFile=/etc/substrate/substrate.env
Environment=HOME=/root
WorkingDirectory=/root/src/repos/agent-substrate
ExecStart=/root/.local/share/reflex/bun/bin/bun packages/ledger/src/cli.ts anchor
```
plus the hardening block copied from `substrate-mcp.service` L25-31 and `TimeoutStartSec=15min`. Timer per 06-RESEARCH § Q4 with `OnCalendar=hourly` and `Persistent=true` (D-07, D-13). Install with `sudo install -m 0644`, `daemon-reload`, `enable --now <name>.timer`; repo copy and `/etc` copy must `diff` clean.

## Shared Patterns

- **Two-sided baseline gate** (03-PATTERNS, exact pipeline, `B=.planning/phases/06-ledger/06-BASELINE.md`): normalized tsc diff against `agent-substrate-tsc-set:`; failing-id diff against `agent-substrate-failing-id:` (a vanished failure fails like a new one); pass count `-gt agent-substrate-pass` in every code task (each adds tests); dispatcher pytest diff against `dispatcher-failing-id:` with `passed -ge dispatcher-pass` in 06-04 T3, 06-07 T3 and 06-09 T3.
- **Keyed calls** run under `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env -p WorkingDirectory=/root/src/repos/agent-substrate -E HOME=/root …` and print key=value lines only. **EnvironmentFile overrides `-E`** (observed 2026-09-26: `-E FOO=cli` with `FOO=file` in the file prints `file`), so any override of a substrate.env variable (the bad-RPC failure paths) wraps the command: `… /usr/bin/env SOLANA_RPC_URL=http://127.0.0.1:9 /root/.local/share/reflex/bun/bin/bun …`.
- **systemd-run command-line expansion**: systemd expands `${…}` (and `%` specifiers) in a transient unit's command line — observed 2026-09-26: `${quote("p6_scratch_%")}` inside `bun -e` arrived as an empty string; the plan checker found bare `$HOME` inside a word passing through unchanged. The plans use the broader, safe rule: inline `bun -e` code run through systemd-run contains no `$` and no `%` — concatenate SQL with `+ quote(x)` — or lives in a `/tmp` script file (files are not expanded). Every inline snippet in the Phase 6 verifies follows this; the scratch-table, anchors-row and row-comparison snippets were run against production read-only during planning (the others need 06-04's exports).
- **Absolute binaries**: bun `/root/.local/share/reflex/bun/bin/bun`, bunx `/root/.local/share/reflex/bun/bin/bunx`, solana `/root/.local/share/solana/install/active_release/bin/solana`, solana-keygen beside it, `/usr/bin/jq`, `/usr/bin/systemd-analyze`. `solana` is not on systemd's PATH.
- **Live-file snapshot before edit** (standing rule): `/var/lib/substrate/phase6-baseline/` (0700), created by 06-01 with `RESTORE.md` as the index. Each plan snapshots into `/var/lib/substrate/phase6-baseline/06-NN/<UTC ts>/` with `MANIFEST.sha256` and writes its routes to its own `RESTORE.d/06-NN.md` **before** its first live edit. No Phase 1 snapshotted file is touched (`/var/lib/substrate/phase1-baseline/RESTORE.md` lists none of substrate.env, the units or Greptime); the index says so.
- **Evidence files**: header `# 06-NN … evidence`, "Recorded from observed output only.", the exact commands in a fenced block, `key=value` lines at column 0, exactly one `## Gaps` heading, repeated runs under `## Failed runs` indented 4 spaces. Verify loop: `for k in …; do test "$(grep -c "^$k=" $M)" = "1" || { echo "smoke missing or duplicate $k"; exit 1; }; done`. Evidence never contains a token shape or a keypair array; verifies grep for `gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-ant-|lin_api_|ntn_[A-Za-z0-9]{30,}|\[([0-9]{1,3},){63}[0-9]{1,3}\]`.
- **Secrets**: substrate.env is probed only with `sudo grep -c '^NAME='`; the keypair file is never read by anything except `solana`/`solana-keygen` given its path; keygen always `--silent`, never `--force`; `SOLANA_ANCHOR_PUBKEY` is not secret and the server holds only it.
- **Staging**: explicit paths only (`git add -- <paths>`), never `git add -A`; commit messages carry `Refs SPE-3576`; Phase 6 commit subjects start `feat(06-NN):`, `test(06-NN):` or `docs(06-NN):` so the proof can list them with `git log --grep='(06-'`.
- **Fail open**: `/events` answers 500 when the chain cannot seed or the insert fails, exactly as when Greptime is down today; producers already ignore it (hooks exit 0, 1.5 s client timeout). The anchor job and verify never write to `agent_events`.
- **Import direction**: `packages/ledger/src/{merkle,memo,period,solana,rpc}.ts` import nothing from `packages/mcp-server`; `digest.ts`, `store.ts`, `anchor.ts` and `cli.ts` import `event.ts`, `greptime.ts`, `config.ts` and `types.ts` by relative path (`../../mcp-server/src/…`, the `hostfns.ts` L11 convention); `mcp-server/src/ledger-verify.ts` and `service.ts` import `../../ledger/src/…`. No module imports a module that imports it back.

## No Analog Found

| File | Reason / guidance |
|---|---|
| packages/mcp-server/src/chain.ts | No serializer exists in the repo. Follow 06-RESEARCH § Q1 and § Code Examples exactly; test with an in-memory store whose `insertEvents` awaits a timer. |
| packages/ledger/src/merkle.ts | RFC 6962 MTH; the eight Trillian/CT reference roots in 06-RESEARCH § Code Examples are the test oracle. |
| packages/ledger/src/rpc.ts memo parsing | Solana JSON-RPC `getTransaction` (`jsonParsed`), `getSignaturesForAddress`, `getBalance`; shapes observed on devnet 4.3.0 (06-RESEARCH § Q3). |
| infra/vps/substrate-ledger-anchor.timer | First timer to execute in this repo (04-03's is planned, not run). Standard `[Timer]` + `WantedBy=timers.target`; `systemctl list-timers` shows the next run. |

## PATTERN MAPPING COMPLETE
