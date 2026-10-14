# N6 plan — Ledger coverage probe and verified archive before TTL

## Files
- `packages/mcp-server/src/greptime.ts`: `anchorCoverage({ now })` (newest anchor, 7-day anchor window, one `date_bin`/`to_unixtime` histogram over `event_ingest`, newest `ledger archive` note bounded on `ts`); `exportWindow({ from, to, after?, limit })` (keyset on `(ts, id)`, first-ingest rows by id bounded below, receipts on every page); `firstEventMs()`; `epochMsAnyUnit` for timestamp cells in any unit. All through `sql()`, so `assertAppendOnly` holds.
- `packages/mcp-server/src/ledger-archive.ts` (new): `archiveWindow(greptime, { day, outDir, pageSize, df, minFreeGb, cwd, releaseSha })` → four files via `.part` + rename, manifest last; `verifyArchive(dir, day)` → structured report, never throws on a finding; gates (`refusedOutDir`, `freeKbOf` from `df -Pk`, closed-day rule, already-archived); day helpers; `parseLedgerArgs` grammar; text formatters.
- `packages/mcp-server/src/ledger-run.ts` (new): the runner the CLI spawns — `coverage`, `archive` (+ one `note` per day through `Substrate.emit`), `verify-archive` (no ledger needed).
- `packages/cli/src/ledger.ts` (new) + `index.ts`: `substrate ledger coverage|archive|verify-archive`, spawn-the-runner like `index sweep`.
- `packages/mcp-server/src/config.ts`: `LedgerSettings.maxUncoveredHours` (`SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS`, 2), `.archiveDir` (`SUBSTRATE_LEDGER_ARCHIVE_DIR`, null).
- `packages/mcp-server/src/service.ts`: `rowToEvent` exported; `ledgerJobs()` 60 s memo (shared in-flight, 1 s wait, failure memoised, redacted reason); `health().jobs = { ledger, ledgerReason }`.
- `infra/vps/substrate-ledger-archive.{service,timer}` + `.service.d/10-environment.conf` (03:30 UTC, `Persistent=true`, `Slice=substrate.slice`, `MemoryMax=512M`, disabled); `infra/vps/README.md`; `scripts/doctor-units.test.ts` unit list.
- Docs: `docs/greptime-ledger.md` ("Coverage and archive"; TTL precondition; config rows).

## Flags and defaults
| `SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS` | 2 — `coverage` exit 2 above it; `/healthz` reports only |
| `SUBSTRATE_LEDGER_ARCHIVE_DIR` | unset — `archive` refuses without `--out`; the unit refuses by name |
| `SUBSTRATE_DEPLOY_MIN_FREE_GB` | 5 (existing) — the archive's disk floor; `0` disables |
Timer disabled by default; nothing deletes; TTL stays the operator's switch.

## Tests (written, not run)
- `greptime.test.ts`: coverage (H-3..H-1 events, anchors H-3,H-2 → newest H-2, lag 2, uncovered [H-1]; no anchors → 48 + `more`; lag-window hour not eligible; bounded, append-only statements); `exportWindow` keyset paging against a fake that honours the predicate (3-way `ts` tie, every row once, token round-trips, no OFFSET); first-ingest collapse and lower bound; bad windows refused; `epochMsAnyUnit` units.
- `ledger-archive.test.ts`: archive → 4 files, 3 pages, manifest fields, verify ok (2 hours verified); flipped byte → `sha256` + `hash` naming the event; edited root → `root` naming the hour; fork → `chain`, prev outside window not a finding, hour `partial`; bad receipt → `anchor`, missing → `unanchored`; missing/unparseable manifest reported; refusals (floor, unreadable df, floor 0, already archived, repo root, release root, `/`, unclosed, bad day) before any write; failed page leaves nothing; day/window/floor helpers; grammar; runner process: verify-archive exit 0 → 2 after tamper, usage/refusals exit 2 with no ledger.
- `service.test.ts`: jobs memo (one read per minute, failure memoised, host scrubbed, `health()` still answers), slow read bounded, no ledger → reason; pinned health body gains `jobs`.
- `cli/src/ledger.test.ts`: argv mapping, usage exit 2 without spawn, status passthrough. `doctor-units.test.ts`: unit shape.

## Rollback
Unset the two names; leave the timer disabled or `rm` the unit files + `daemon-reload`; `jobs` is additive on `/healthz`; or `git revert` the N6 range. Archives on the mount are the operator's files.
