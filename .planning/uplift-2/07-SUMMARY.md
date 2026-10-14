# 07 — R7 VPS guardrails: summary

Proposal `PROPOSAL.md` §R7. Plan `07-PLAN.md`. Baselines `BASELINES.md`.

## What changed

1. **Resource ceilings.** New `infra/vps/substrate.slice` (`MemoryLow=2G`). Every `substrate-*` unit now carries `Slice=substrate.slice` plus its ceilings in the unit file itself, each with a comment citing the 2026-10-13 measurement (mcp 53 MB RSS, 88 MB peak): mcp `MemoryHigh=1G MemoryMax=2G TasksMax=512 CPUQuota=200%`; grok/herdr/muse collectors `MemoryMax=512M TasksMax=256`; dispatcher and host `MemoryMax=4G TasksMax=1024`; anchor, skills-sync, skills-bridge oneshots `MemoryMax=1G`. `Restart=` lines untouched.
2. **Deploy gate.** `deploy-release.sh`: `require_free_space` (`df -Pk` on the release root, before `build_release`; message names `docs/runbooks/disk-pressure.md`) and `stores_ok` after the `/healthz` poll. The poll now keeps the passing response body in a 0600 temp file (no second request) and the gate requires `index === true` when `SUBSTRATE_PG_URL` is set in the env file, `eventsWritable === true` when `GREPTIME_URL` is (presence by `grep -q '^NAME=.'`, never a value), and no `planes.*.breaker.state === "open"` when `planes` is present (R2 confirmed the shape). Failure takes the existing auto-rollback path. `rollback` and a custom `SUBSTRATE_HEALTH_CMD` are not store-gated.
3. **Redis.** `infra/vps/redis-substrate.conf` (`maxmemory 256mb`, `maxmemory-policy volatile-lru`, `save ""`, `appendonly no`, loopback `bind`; header cites the `docs/data-planes.md` cache row, the `include` install and the TTL/counter invariant behind the policy) and `infra/vps/redis-server.service.d/10-substrate-limits.conf` (`MemoryMax=768M`). README carries the operator install lines.
4. **Audit-chain rollover.** `packages/audit/src/log.ts`: `rolloverBytes` option (undefined → `SUBSTRATE_AUDIT_ROLLOVER_BYTES`, unset/0/invalid → null). An append that would pass the limit first renames the active file to `<path>.<firstSeq>-<lastSeq>.jsonl` (same dir, chmod 0600) and the record opens a fresh active file at the same path with `prev` = closed tip; checkpoint untouched; never mid-record; a failed rename appends to the old file and retries later. `open` recovers the tip from the newest segment when the active file is absent/empty (crash between rename and first write). `scan` (hence `verify`, `readAll`, `verifiedView`, `/evidence`) walks closed segments in order then the active file through one `ChainWalker`, and returns `segments`/`firstSeq`/`lastSeq`. New `report()` for a read-only verifier that never opens the log (anchors to the checkpoint; missing segments → missing history). Exported helpers `segmentPath`, `parseSegmentName`, `orderSegments`, `listAuditSegments`, `rolloverBytesFromEnv`; active file now created 0600. `scripts/audit-verify.ts` + `bun run audit:verify [--path <file>]` prints `{segments, records, firstSeq, lastSeq, ok}` (+ `unparseable`, `brokenAt`, `reason` when not ok); exit 0/1/2.
5. **Runbook** `docs/runbooks/disk-pressure.md`: consumers, reclaim order with commands (release prune via re-deploy, `docker image prune -a`, `docker builder prune`, named `docker volume rm` with the other-projects warning, journal vacuum), the three floors (deploy 5 GB, rehearsal 2 GiB, sandbox 10 GiB), what to record.

## Files

Modified: `infra/vps/substrate-mcp.service`, `substrate-collector-grok.service`, `substrate-collector-herdr.service`, `substrate-collector-muse.service`, `substrate-dispatcher.service`, `substrate-host.service`, `substrate-anchor.service`, `substrate-skills-sync.service`, `substrate-skills-bridge.service`, `infra/vps/deploy-release.sh`, `infra/vps/deploy-release.test.ts`, `infra/vps/README.md`, `packages/audit/src/log.ts`, `packages/audit/src/log.test.ts`, `packages/audit/src/index.ts`, `package.json` (`audit:verify`), `docs/mcp-audit.md`.
Created: `infra/vps/substrate.slice`, `infra/vps/redis-substrate.conf`, `infra/vps/redis-server.service.d/10-substrate-limits.conf`, `scripts/audit-verify.ts`, `scripts/audit-verify.test.ts`, `docs/runbooks/disk-pressure.md`, `.planning/uplift-2/07-PLAN.md`, `07-SUMMARY.md`, `env-notes/07.md`.
Not touched: `scripts/doctor-units.ts` / its test (it loads only `*.service` files and their `.d` dirs; the slice and the redis drop-in are invisible to it), `.env.example`, `README.md`, `packages/mcp-server`, `packages/cli`, `record.ts` (no record-shape change needed).

## Knobs

| Name | Default | Scope |
|---|---|---|
| `SUBSTRATE_DEPLOY_MIN_FREE_GB` | 5 (`0` off) | deploy script shell env |
| `SUBSTRATE_HEALTH_REQUIRE_STORES` | 1 | deploy script shell env |
| `SUBSTRATE_HEALTH_ENV_FILE` | `/etc/substrate/substrate.env` | deploy script shell env (names only) |
| `SUBSTRATE_AUDIT_ROLLOVER_BYTES` | unset → never rolls | `substrate.env`; `.env.example` block in `env-notes/07.md` |

## Tests added (not run — orchestrator)

- `infra/vps/deploy-release.test.ts`: floor refuses (nothing built, runbook named) / accepts / lower floor / `0` / invalid; gate pass with closed + half-open + null breakers and one curl call; `index=false` rolls back without printing a value; `eventsWritable=false` and a missing field fail closed; unnamed stores not required (local-dev and ledger-only shapes); open breaker rolls back; body without `planes`; `SUBSTRATE_HEALTH_REQUIRE_STORES=0` keeps status-only; custom health command reads no body. Harness: curl stub honours `-o`, new `df` stub, `SUBSTRATE_HEALTH_ENV_FILE` defaults to an absent harness file.
- `packages/audit/src/log.test.ts` "rollover by size": boundary roll → `1-2`, `3-4` segments at 0600, whole lines only, exact sizes; new active first record `prev` = closed tip and checkpoint carried; verify/readAll/verifiedView/report across 2 segments plus a never-opened reader; tampered segment → `brokenAt: 2`, removed first segment → head check, everything removed → missing history; restart continuation incl. the rename-then-crash case; null option / env parsing / `rolloverLimit`; strict segment names and ordering.
- `scripts/audit-verify.test.ts`: arg parsing, output shape (ok / broken / empty), directory ordering, `run` across segments (exit 0, no record field printed), missing segment (exit 1), checkpoint past files (exit 1), verifying writes nothing.

## Rollback

Units: reinstall previous unit files, `daemon-reload` (slice inert without members). Deploy gate: `SUBSTRATE_HEALTH_REQUIRE_STORES=0`, `SUBSTRATE_DEPLOY_MIN_FREE_GB=0`. Audit: unset `SUBSTRATE_AUDIT_ROLLOVER_BYTES` — existing segments remain readable and are still walked. Redis: drop the `include` line and the drop-in, `daemon-reload`, restart.

## Deviations from the proposal

- Ceilings live in the unit files, not in `.d/` drop-ins (assignment: unit files are the source of truth; `deploy-release.sh`/README already describe how they are installed).
- No `substrate audit verify` CLI subcommand (`packages/cli` is owned by another task this wave); `bun run audit:verify` is the entry.
- The store gate reuses the body of the poll that passed instead of fetching `/healthz` again, so the verdict is about the same response as the status code and the curl count is unchanged.
- `scripts/doctor-units.ts` untouched: nothing enumerates the new files, so nothing went red.
- `scripts/audit-verify.ts` constructs no `AuditLog` (redact-lock: only `observe.ts` may); it calls the pure, read-only `verifyAuditSegments(path)` exported from `log.ts`, which `AuditLog.report()` also uses on an unopened log. The file walk, checkpoint reader and verdict judge are module-level and shared with `scan`/`verify`.
- `deploy-release.test.ts` composes the ledger key name at runtime (store-lock forbids the literal token in any `.ts` outside the ledger client).

## Post-deploy measurement pending (BASELINES.md)

| Metric | Baseline | After (pending) |
|---|---|---|
| `MemoryMax` on every `substrate-*` unit | `infinity` | `systemctl show -p MemoryMax,TasksMax,Slice substrate-*.service` |
| `/healthz` store-gated deploy | status only | first health-checked deploy log shows no `healthz reports` line, or the rollback reason |
| free disk at deploy | 22 GB free, no floor | `df -h /` recorded in `docs/runbooks/disk-pressure.md` |
| audit file size | 3.55 MB single file, 0.9 MB/day | `bun run audit:verify` → `segments ≥ 1`, each ≤ `SUBSTRATE_AUDIT_ROLLOVER_BYTES`, `ok: true` |
| loopback redis | `maxmemory 0`, `noeviction`, RDB on | `redis-cli config get maxmemory maxmemory-policy save appendonly` |

## Greptile round 1 (PR #59)

- **Rollover races audit readers** (`log.ts`, P2). `walkAuditFiles` listed the segments once and read the active file after awaiting them, so a roll in that window hid the new segment and the active file began past the skipped records — an intact chain reported as a `seq` jump. Fix: each pass snapshots the segment list, reads it and the active file, then re-lists; if a segment appeared or the active file's first `seq` is not the newest segment's `lastSeq + 1`, the pass is discarded and the walk starts over with a fresh walker and sink (`begin()`), at most `MAX_WALK_ATTEMPTS = 3` times. A chain genuinely broken at the boundary fails the same check every time and is reported after the last attempt as the walker found it. `scan`, `verify`, `verifiedView`, `readAll`, `report` and `verifyAuditSegments` all go through it. Tests (`log.test.ts`): a roll injected between the listing and the read (`begin` on pass 1 appends through a rollover-enabled writer) → pass 1 saw `[3]`, pass 2 `[1,2,3]`, `attempts: 2`, verdict ok through `verify()` and `verifyAuditSegments`; a dropped first line of the active file → `attempts: 3`, `brokenAt: 6`; a steady chain → one pass.
- **Eviction can revive stale answers** (`redis-substrate.conf`, P2). `allkeys-lru` could evict a `substrate:v1:gen:*` counter (INCR, no TTL) while a generation-0 answer (TTL) survived; the reader treats a missing counter as 0 and would hit that answer after a write had invalidated it. Fix: `maxmemory-policy volatile-lru` — only TTL-bearing keys (answers, snapshots) are evictable, counters never — with the invariant in the file header and `infra/vps/README.md`; `docs/data-planes.md` does not name the policy, so it is unchanged. When no expiring key is left, writes are refused rather than a counter removed; the cache is fail-open.

## Greptile round 2 (PR #59)

- **Partial writes mimic lost history** (`log.ts:331`, P2). A process killed partway through the *first* append after a roll leaves an active file with bytes but no complete record. `open` consulted the newest closed segment only when the active file was absent or empty (`recovered.size === 0`), so this case fell through to the checkpoint comparison with `foundSeq: 0` and every checkpointed record was reported as missing history — records that sat intact in the segment. Fix: the fallback now keys on `recovered.exhausted` (the whole active file was scanned and holds nothing readable) rather than on size, so the segment's last record is the chain's position in this case too; the active file's size is kept so the fragment is terminated at open like any other, left in place, and counted by `verify` as one unparseable line (`reason: … could not be parsed`, not `missing history`). The next record chains `prev` to the segment's tip and the next roll names its segment from the segment's `lastSeq + 1`. A file too large to have been scanned to its head (`exhausted: false`) still refuses, since records past the window would outrank any segment. Test: `a write cut in half right after a roll recovers from the closed segment, not as missing history`.

## Greptile round 3 (PR #59)

- **Damaged audit writes look clean** (`log.ts:338`, P2, follow-up to round 2). After the closed-segment recovery the active file can be a terminated fragment and nothing else, with `activeFirstSeq = chainSeq + 1`. If fragment + next record exceeded `rolloverBytes`, the roll renamed the fragment to a reversed range (`4-3`), which `parseSegmentName` rejects — the verifier never read it and the damaged write verified `ok: true`. Fix: `rollover` returns when `activeFirstSeq > chainSeq` (the file holds no committed record), so the record is appended into that file and the roll waits for the record after it; the fragment then closes inside a readable `4-4` segment as the one unparseable line `verify` already reports. Every other roll rule is unchanged; the file overshoots the limit by one record, once. Test: `a fragment-only active file is never rolled under a reversed range the verifier would skip` — fragment longer than a record, reopen, append seq 4 → no roll, every name in the directory parses as `first-last` with `first <= last`, active = fragment + seq 4, `report()` `{segments: 2, records: 4, lastSeq: 4, ok: false, unparseable: 1}`; append seq 5 → `mcp-audit.jsonl.4-4.jsonl` holds fragment + seq 4, active holds seq 5, writer and fresh reader both report `{segments: 3, records: 5, ok: false, unparseable: 1}`.

## Gates

Final head of `ultrathink/uplift-2` (all seven items merged): `bunx tsc --noEmit` clean · `bun test` **3525 pass / 65 skip / 1 fail** — the 1 fail is the recorded F-01 environment-sensitive guard (`scripts/rehearsal.test.ts` `--port 7410`), failing identically on `main`, recorded not fixed · `bun run check:phase-close` pass (4 lock files green; EVENT_KINDS 12; SURFACES 27) · `bun run test:py` 298 passed. Live smoke on the scratch rehearsal twin (`bun run rehearsal up --name uplift2`, scratch Postgres 16 + GreptimeDB v0.14.4 on loopback, commit `1fe624a`): `bun run rehearsal smoke` 4/4 (brief, emit, register, claim). 

R7 on the twin: `bun run audit:verify --path <run-dir>/mcp-audit.jsonl` → `{segments:0, records:16, firstSeq:1, lastSeq:16, ok:true}` (rollover off by default, so one segment). `bun test infra/vps scripts/audit-verify.test.ts packages/audit` green incl. the deploy-gate and rollover cases; `systemd-analyze verify` on the slice/unit files raised nothing beyond the host-specific `ConditionPathExists`/interpreter paths. Unit ceilings take effect when the operator installs the units (`infra/vps/README.md`).
