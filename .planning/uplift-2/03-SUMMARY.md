# R3 summary — Hindsight: durable retain outbox, bounded recall, cleaner config, doc fixes

## What changed

- **Retain outbox** (`packages/mcp-server/src/retain-outbox.ts`, new): `RetainOutbox` with entries `{id, bank, document_id, entry_id, surface, entry_hash, session_id?, attempts, next_at, last_reason, enqueued_at}` — locators and hashes, never text. Memory-only when `SUBSTRATE_RETAIN_OUTBOX_PATH` is unset; durable otherwise: 0600 append-only JSONL in a 0700 directory, hydrated once in the constructor (last line per `bank document_id` wins, malformed lines skipped and counted on stderr), rewritten compactly via `tmp + rename` after a drain that changed state, after `forget`, after a bound drop and once at hydrate. Bound `SUBSTRATE_RETAIN_OUTBOX_MAX` (10 000) drops the oldest with `onDrop(entry, "outbox-full")`; `SUBSTRATE_RETAIN_MAX_ATTEMPTS` (10, live attempt included) drops with `"exhausted"`; `abandonAll()` drops with `"abandoned"`. `retainBackoffMs(attempt, random)` = 30 s × 2^attempt, base capped at 1 h, ±20 % jitter. `drain(deliver, {all})` is serial, single-flight (overlapping calls share one pass), skips entirely when `allow()` is false (breaker open) without spending an attempt and remembers that in `held()`. `stats()` → `{size, oldestAt, attemptsTotal, durable}`. `TRANSIENT_RETAIN_REASONS` is the closed enqueue set.
- **Forward** (`memory-retain.ts`): split into `forwardRetain` (gate on `accepted && verified_persisted`) → `forwardEntry`, plus `replayRetain(deps, target)` for the outbox (source = the entry's own `source_event`). `RetainDeps` gains `outbox?: RetainOutboxSink` and `retainTimeoutMs?`. A transient failure (`retain-timeout|network|server|rate-limit`, and the same kinds as `ensure-bank-*`) that the sink takes returns `{queued: true}` and emits nothing; refusals and other 4xx warn at once as before. `retain-not-found` (404) → `forgetEnsuredBank`, one re-ensure, one retry; a second 404 is reported. `emitRetainWarning` is exported so the outbox's deferred warning is byte-for-byte today's shape (`hindsight retain failed: <reason> (<bank>/<document_id>)`, payload `{action: "memory.retain", reason, bank, document_id, entry_hash}`, `session_id` when known).
- **Recall** (`memory-recall.ts`): `DEFAULT_RECALL_BUDGET_MS`; a bank aborted by the shared budget fails with `budget exceeded` and the reply's `reason` leads with `recall-timeout:` (outage keeps `hindsight recall failed:`, other partials keep `partial recall:`); `dedupeHits` collapses on `document_id ?? text` keeping the best score (ties keep the earlier, i.e. caller's, bank) before the sort.
- **Plane** (`planes/hindsight.ts`): `forgetEnsuredBank(config, bank)`.
- **Service** (`service.ts`): one contiguous R3 field block (`retainOutbox`, `retainDrainTimer`, `retainRecoverPending`) after `retainChains`; the outbox is built in the constructor with `allow = breaker.state() !== "open"` and `onDrop` → `emitRetainWarning`; the write-path forward uses `retainDeps(hindsight)` (live sink: enqueue, start the unref'd interval timer, flag recovery when the breaker is not closed) and on success `forget`s the parked copy and calls `afterLiveRetain()` (drains the backlog with `all: true` once after a gate-held or breaker-open period); `searchMemory` passes `hindsightBudgets.searchRecallBudgetMs`; `recallMemories(input, surface, budgetMs?)` defaults to `hindsightBudgets.recallBudgetMs`; `drainPendingRetains(timeoutMs, {abandon})` waits for in-flight forwards, then gives the outbox one due pass inside the remaining bound, and with `abandon` (shutdown) a memory-only outbox warns for each leftover; new public `drainRetainOutbox({all})` and `retainOutboxStats()`; `deliverParkedRetain` re-reads by `index.readEntry(entry_id)` (existing method — no `index-store.ts` change), `gone` when missing or `superseded_by` is set, transient `index-unreachable` when the read throws.
- **Entry point** (`index.ts`): `hindsightConfigWarnings` in the one boot-warning loop; shutdown calls `drainPendingRetains(SHUTDOWN_RETAIN_MS, { abandon: true })`.
- **Config** (`config.ts`, append-only under `// uplift-2 R3`): `hindsightBudgets {recallBudgetMs, searchRecallBudgetMs, retainTimeoutMs}`, `retainOutbox {path, max, maxAttempts, drainMs}`, `hindsightEnv {legacyBankSet, urlSet, banksSet}` (presence only); `DEFAULT_SEARCH_RECALL_BUDGET_MS`, `DEFAULT_RETAIN_TIMEOUT_MS`, `positiveIntOr`, `hindsightConfigWarnings` (legacy `HINDSIGHT_BANK`; `HINDSIGHT_URL` without `HINDSIGHT_BANKS`).
- **Unit** (`infra/vps/substrate-mcp.service`): one `Environment=SUBSTRATE_RETAIN_OUTBOX_PATH=/var/lib/substrate/retain-outbox.jsonl` with a comment, under `StateDirectoryMode`.
- **Docs**: `docs/grok-bot.md` intro, access-path paragraph, "What substrate-mcp implements" (adapters since Phases 25/26, env keys per process, breaker, tools and REST twins), new "The double retain" (`pd-*` by the gateway, `sub-grok-bot` by the forward, what the outbox changes) and "The brief's ETag" (R1's `ETag`/`X-Substrate-Brief`), data-planes paragraph corrected. `docs/memory-governance.md` new "Derived hits and the retain outbox" section (derived framing, untrusted notice, redaction on read, budgets, forward, outbox lifecycle, durable vs memory-only, env names, 404 re-ensure, boot warnings).

## Files

Created: `packages/mcp-server/src/retain-outbox.ts`, `packages/mcp-server/src/retain-outbox.test.ts`, `packages/mcp-server/src/memory-recall-budget.test.ts`, `packages/mcp-server/src/hindsight-config-warnings.test.ts`, `.planning/uplift-2/03-PLAN.md`, `.planning/uplift-2/03-SUMMARY.md`, `.planning/uplift-2/env-notes/03.md`.
Modified: `packages/mcp-server/src/{memory-retain,memory-recall,service,index,config}.ts`, `packages/mcp-server/src/planes/hindsight.ts`, `infra/vps/substrate-mcp.service`, `docs/grok-bot.md`, `docs/memory-governance.md`.
Existing test files edited: none (`memory-retain.test.ts`, `memory-recall.test.ts`, `planes/hindsight.test.ts` expectations all still hold: a forward without a sink warns as before; the slow-bank reason still names the bank).
Worktree-only convenience, untracked: `packages/mcp-server/node_modules` symlink to the main checkout's (gitignored) so `bun -e` module loads resolve `@substrate/*`.

## Knobs

| Variable | Default | Notes |
| --- | --- | --- |
| `SUBSTRATE_RETAIN_OUTBOX_PATH` | unset (memory-only) | unit sets `/var/lib/substrate/retain-outbox.jsonl` |
| `SUBSTRATE_RETAIN_OUTBOX_MAX` | 10000 | oldest dropped with warning `outbox-full` |
| `SUBSTRATE_RETAIN_MAX_ATTEMPTS` | 10 | live attempt included; `1` = pre-R3 behaviour |
| `SUBSTRATE_RETAIN_DRAIN_MS` | 30000 | interval; also after recovery and at shutdown |
| `HINDSIGHT_RECALL_BUDGET_MS` | 4000 | `memory_recall` fan-out |
| `HINDSIGHT_SEARCH_RECALL_BUDGET_MS` | 1500 | recall leg inside `memory_search` |
| `HINDSIGHT_RETAIN_TIMEOUT_MS` | 8000 | one retain POST |

Backoff: 30 s, 60 s, 2 m, 4 m, 8 m, 16 m, 32 m, 1 h, 1 h (±20 %) — ten attempts span about 3 h (11,010 s at the jitter midpoint).

## Tests added (written, not run here)

`retain-outbox.test.ts`: backoff schedule + jitter bounds + ten-attempt span; enqueue for 5xx/429/transport/timeout/breaker-open and never for 400/unsourced/unredacted; no-sink warning shape unchanged; 404 evicts + re-ensures once (request trail), second 404 reported; in-memory enqueue/replace/stats; due-only drain, backoff on transient, drop on delivered/gone; exhausted drop reason; permanent drop silent; bound → `outbox-full`; open breaker → no attempt spent, half-open admits the probe; `forget`/`abandonAll`; overlapping drains share a pass; durable file 0600/0700, hydrate order, compaction after hydrate and drain, empty file after full delivery, malformed lines skipped, bound at hydrate, missing file; Substrate-level: park without warning then replay after recovery, replay skips gone/superseded, live success forgets the parked copy, exhausted warning equals today's payload, memory-only abandons with a warning at shutdown while durable keeps the entry on disk.
`memory-recall-budget.test.ts`: `recall-timeout` reason on budget miss vs `hindsight recall failed` on outage; merge carries the reason; `Substrate.searchMemory` uses the shorter budget while `recallMemories` uses its own; dedupe best score / text key / tie keeps earlier bank / applied before sort; config defaults and fallbacks for all seven knobs.
`hindsight-config-warnings.test.ts`: legacy key warns once naming the replacement, URL-without-banks warns once, both → two, none/clean/blank → none, presence recorded without the value, `index.ts` wires the function exactly once in the single boot loop.

## Rollback

`git revert` the R3 range. Without a code change: `SUBSTRATE_RETAIN_MAX_ATTEMPTS=1` restores one-attempt-one-warning; unsetting `SUBSTRATE_RETAIN_OUTBOX_PATH` (or removing the unit line) keeps the queue in memory only.

## Deviations and why

- **`degraded` stays boolean.** `RecallReply.degraded` and `MergedMemoryResults.degraded` are `boolean` and every caller, cache `store` predicate and the chaos smoke read them as such; the `recall-timeout` marker is the `reason` prefix (`recall-timeout: <bank>: budget exceeded`) rather than a string-valued `degraded`. Shape stays `{…, degraded: true, reason}` as today.
- **`ensure-bank-*` transient kinds enqueue too.** An outage shows first at the bank-config GET, before any retain POST; keying only on `retain-*` would drop every forward of an outage at the ensure step and the outbox would never fire.
- **No `/healthz` change.** `health()` has no per-plane extras hook, so the stats are `Substrate.retainOutboxStats()` as the assignment allowed.
- **No `index-store.ts` edit.** `readEntry(id)` already exists on `IndexStore`/`MemoryStore`.
- **`drainPendingRetains` grew an `{abandon}` option** instead of a second shutdown method, so `index.ts` keeps one call; memory-only leftovers at shutdown get the warning they would have had rather than vanishing silently (durable leftovers persist).
- **Recovery trigger** is "first live success while entries were parked under a non-closed breaker or a drain was gate-held", tracked by a flag plus `outbox.held()`, since the breaker exposes no close event.
- `drainRetainOutbox({all})` is public (recovery path, shutdown and tests use it); replay reasons `index-unreachable` and `replay-threw: …` can appear as `last_reason` when the index read or the replay itself fails.

## Before / after (BASELINES.md rows)

| Row | Baseline | After |
| --- | --- | --- |
| Hindsight: retains that reach the plane after a transient error | 0 % (one warning, memory lost; "retain/recall volumes unknown") | expected 100 % within the ≈ 3 h backoff; post-deploy measurement pending — read `substrate.plane.duration{plane=hindsight,op=retain}` and count `memory.retain.failed` warnings over a day |
| `memory_search` while Hindsight is slow | waits the full 4 s fan-out | ≤ 1.5 s + index time (`HINDSIGHT_SEARCH_RECALL_BUDGET_MS`); post-deploy measurement pending — `substrate.request.duration{route=/memory}`/tool `memory_search` p95 during a Hindsight slow period |
| Duplicate hits across banks | not measured | collapse on `document_id`; post-deploy measurement pending |
| `HINDSIGHT_BANK` set, `HINDSIGHT_BANKS` unset in production | silent | two boot warnings on the next deploy (journal) |

## Gates

Final head of `ultrathink/uplift-2` (all seven items merged): `bunx tsc --noEmit` clean · `bun test` **3525 pass / 65 skip / 1 fail** — the 1 fail is the recorded F-01 environment-sensitive guard (`scripts/rehearsal.test.ts` `--port 7410`), failing identically on `main`, recorded not fixed · `bun run check:phase-close` pass (4 lock files green; EVENT_KINDS 12; SURFACES 27) · `bun run test:py` 298 passed. Live smoke on the scratch rehearsal twin (`bun run rehearsal up --name uplift2`, scratch Postgres 16 + GreptimeDB v0.14.4 on loopback, commit `1fe624a`): `bun run rehearsal smoke` 4/4 (brief, emit, register, claim). 

R3: unit coverage only on the twin (Hindsight is not configured there; the config warnings and outbox are exercised by `retain-outbox.test.ts`, `memory-recall-budget.test.ts`, `hindsight-config-warnings.test.ts`). Production forward/recall timings: post-deploy measurement pending.
