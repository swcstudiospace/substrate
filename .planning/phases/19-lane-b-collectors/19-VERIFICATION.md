---
phase: 19-lane-b-collectors
verified: 2026-10-10T13:51:40Z
status: passed
score: 28/28 must-haves verified
covered_files: [".planning/phases/19-lane-b-collectors/19-01-PLAN.md", ".planning/phases/19-lane-b-collectors/19-01-SUMMARY.md", ".planning/phases/19-lane-b-collectors/19-02-PLAN.md", ".planning/phases/19-lane-b-collectors/19-02-SUMMARY.md", ".planning/phases/19-lane-b-collectors/19-03-PLAN.md", ".planning/phases/19-lane-b-collectors/19-03-SUMMARY.md", ".planning/phases/19-lane-b-collectors/19-04-PLAN.md", ".planning/phases/19-lane-b-collectors/19-04-SUMMARY.md", ".planning/phases/19-lane-b-collectors/19-05-PLAN.md", ".planning/phases/19-lane-b-collectors/19-05-SUMMARY.md", "packages/collectors/src/emit.ts", "packages/collectors/src/git-context.ts", "packages/collectors/src/status.ts", "packages/collectors/src/grok.ts", "packages/collectors/src/herdr-map.ts", "packages/collectors/src/herdr-state.ts", "packages/collectors/src/herdr.ts", "packages/collectors/src/muse.ts", "packages/collectors/src/cursor-stop.ts", "packages/projector/src/muse.ts", "packages/projector/src/cursor.ts", "packages/mcp-server/src/event-sources.ts", "docs/event-vocabulary.md", "docs/collectors.md", "docs/runbooks/lane-b-collectors.md", "scripts/laneb-proof.ts", "infra/vps/substrate-collector-herdr.service", "infra/vps/substrate-collector-muse.service", "package.json"]
covered_digest: "v3:sha256:965646d298290159cb4282cd7095604c493bceae4b5c156b4e506ddfa0b41285"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 19: Lane B Collectors Verification Report

**Phase Goal:** What herdr panes, Muse and Cursor sessions do on this host reaches the event log under main's vocabulary from code on `main`, and every Muse repo carries a fresh, redacted brief.
**Verified:** 2026-10-10T13:51:40Z
**Status:** passed
**HEAD:** `5f495ad` (origin/main synced; `git pull --ff-only` clean — already up to date)
**First verification:** no prior `19-VERIFICATION.md` existed (`verification.status` → `missing`); this report is the initial verify, run as verification-gates-only per #2868 (no plan re-run; all 5 SUMMARYs present).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | D19-01: herdr files ported with exact paths kept (`herdr.ts`, `herdr-map.ts`, infra units), branch never merged | ✓ VERIFIED | Files at planned paths; units `infra/vps/substrate-collector-herdr.service` + `substrate-collector-muse.service` tracked on main (commits `4a7aded`, `a042927`); no merge commits in phase history |
| 2 | D19-02: mappers emit exactly the Phase 17 rows; `check:phase-close` passes | ✓ VERIFIED | `bun run check:phase-close` → pass (4 lock files green; EVENT_KINDS 12 unchanged; SURFACES = baseline + `substrate` at 27). herdr-map 7 pass, cursor-stop asserts `session.end`/surface `cursor`, projector muse asserts `tool.call`/surface `muse` |
| 3 | D19-03: every collector/hook imports redact from `packages/mcp-server/src/redact.ts`; shared helper named `recordRefusal` | ✓ VERIFIED | `redact-lock.test.ts` 18–19 pass (no new redactor, no exemption); grep clean for second redactors |
| 4 | D19-04: `postEvent` never throws; 202→stored, 4xx→refused, 5xx/network/timeout→failed; env at call time; 3 s / 1.5 s timeouts | ✓ VERIFIED | `emit.test.ts` 12 pass incl. stub-server classification, call-time env, bearer-only-when-set |
| 5 | D19-05: refusal = one JSON line with exactly ts/collector/source/kind/surface/status/redacted-truncated error + one stderr line; `collectors:status` prints counters + refused since `--since` | ✓ VERIFIED | `status.test.ts` 7 pass (aggregation, since-filter, garbled-line skip, read-only); live: `collectors:status --since 2026-10-10T00:00:00Z` → refused emits 0 |
| 6 | D19-06: hooks exit 0 with empty stdout in bound; outage drops counted failed, no spool/retry | ✓ VERIFIED | Proof checks 24–25: dead-url cursor + muse hooks exit 0, empty stdout, in budget (36 ms / 68 ms); `emit.ts` has no queue |
| 7 | D19-07: one `events.subscribe` per connection; wire-name normaliser; `released:true` is a release; pushes only dirty the debounced single-flight pass | ✓ VERIFIED | `herdr.test.ts` 3 pass (one subscribe per connection, bad pane closes only itself, two close pushes → one `session.start`); `herdr-state.test.ts` 9 pass |
| 8 | D19-08: snapshot-truth reconcile every 5 s and on push; start/note/end per pane identity (`pane_id\|terminal_id`); missed/duplicated pushes repaired within 5 s | ✓ VERIFIED | Live proof checks 3–6 + 10: working→`session.start`, restart→idle note, close→`session.end`, exactly one start across restart |
| 9 | D19-09: v2 state via tmp+rename; restart emits nothing unchanged; non-v2 seeds silently | ✓ VERIFIED | Proof check 3 (empty snapshot seeds v2 silently) + check 10 (no duplicate start); `saveHerdrState` tmp+rename in code |
| 10 | D19-10: `HERDR_AGENT_SURFACES` pins eight 0.9.1 enum rows + `muse`; unmapped ids counted once per identity; no-agent pane emits nothing | ✓ VERIFIED | `herdr-map.test.ts` 7 pass incl. enum fixture failing on unclassified ids; `docs/event-vocabulary.md` carries the pinned table |
| 11 | D19-11: repo = origin slug of cwd (foreground_cwd fallback), branch same dir; actor agent; `session.end` carries repo; stable `session_id`; unknown transitions recorded not emitted | ✓ VERIFIED | Proof checks 12–13 (branch `p19-tag`, repo `substrate-rehearsal/p19-…` on end); `git-context.test.ts` 9 pass (https/ssh/.git/no-origin, unborn HEAD) |
| 12 | D19-12: `pane.output_matched` keeps redacted `herdr.other` mapping, never subscribed | ✓ VERIFIED | Mapper test asserts redaction (secret absent); collector subscribes only to `pane.created/closed/exited/agent_detected` + per-pane `agent_status_changed` |
| 13 | D19-13: CLI keeps `--once/--watch/--session`, `HERDR_SOCKET_PATH`, `HERDR_SESSION`, `HOME → /root` fallback | ✓ VERIFIED | Flags present in `herdr.ts` behind `import.meta.main`; proof drives `--session`-scoped runs |
| 14 | D19-14: `SUBSTRATE_MUSE_REPOS` required, no default; slug via git-context; `POST /brief` with slug+branch+surface+bearer | ✓ VERIFIED | `muse.test.ts` 13 pass; bearer health-gate fix + 2 unit tests (401 refused, 200 with bearer) from 19-05 |
| 15 | D19-15: non-2xx/empty leaves `BRIEF.md` byte-identical, counts `fetch_failed`; redact + tmp+rename, skip unchanged bytes; one `GET /healthz` per pass | ✓ VERIFIED | Proof checks 14–15 (brief lists note + tool call), 17 (closed-port run byte-identical); live writer fix verified by unit tests |
| 16 | D19-16: `AGENTS.md` exactly one marker block; duplicates collapse; pointer ensured after failed fetch; exclude via `git --git-path`, local only | ✓ VERIFIED | Proof checks 16–17 (one pointer block, stable across five reruns + closed-port run) |
| 17 | D19-17: writer emits no event; per-repo state in `/var/lib/substrate/muse-offsets.json`; `--once` default pass, `--watch` 5-min | ✓ VERIFIED | Writer calls `pass()` directly (no `--once` flag needed); live `muse-offsets.json` present with zero stored/refused/failed event counters |
| 18 | D19-18: muse hook posts `tool.call`/surface `muse` with slug+branch+payload through `redactValue`, 1.5 s timeout, refused lines, exit 0 empty stdout; file-based `substrate.json` (url/tokenFile/stateDir, never a token); token-value refusal | ✓ VERIFIED | `projector/muse.test.ts` 6 pass (sentinel: token value absent from every bundle file; scrubbed-env URL-from-file); proof checks 7–8 (bundle projects isolated, hook emits empty-stdout exit 0) |
| 19 | D19-19: bundle `hooks/redact.ts` = header + exact `redact.ts` bytes (commit + sha256), no-import assert; template import keeps lock green with no exemption | ✓ VERIFIED | Byte-compare asserted in projector tests; `redact-lock.test.ts` green with no phase-19 exemption |
| 20 | D19-20: projector writes to `MUSE_PLUGIN_DIR`, requires validate `valid:true` zero diagnostics, `--check` compares sha256 read-only; proof stays in scratch HOME (`MUSE_BIN` stubbed in tests) | ✓ VERIFIED | Proof check 9: operator muse cache paths identical before/after; tests never invoke the operator binary (adaptation: `--bundle-only` + direct hook run, see Gaps) |
| 21 | D19-21: cursor-stop containment (realpath root, regular-file, id regex, 20 MB cap, 0700 dir, 0600 tmp+rename), redacted copy, `session.end` surface `cursor` actor `human`, shared emit + refused counting, env overrides | ✓ VERIFIED | `cursor-stop.test.ts` 15 pass (incl. runtime-assembled decoy idiom); proof checks 20–23 (0600 copy, decoy-free, names copy) + 24 (dead-url exit 0) |
| 22 | D19-22: projector `cursor.ts` `script()` + `--print-desired`; stop entry byte-identical to live `hooks.json`; `--check` already current | ✓ VERIFIED | `projector/cursor.test.ts` 2 pass; `bun packages/projector/src/cursor.ts --check` → already current, exit 0, live file untouched (read-only) |
| 23 | D19-23: both units ported (names/ExecStart/WorkingDirectory/state paths identical to installed copies), per-collector env after `substrate.env`, `SUBSTRATE_STATE_DIR` set, grok untouched, `systemd-analyze verify` passes | ✓ VERIFIED | `systemd-analyze verify substrate-collector-herdr.service substrate-collector-muse.service` → exit 0, no output; `doctor-units.test.ts` 18 pass pins the pre-cutover shape; grok unit unmodified |
| 24 | D19-24: runbook records six-step post-merge operator cutover + missing-from-disk warning + checkout-plus-restart rollback; nothing here restarts a unit, projects user-scope muse, or edits hooks.json | ✓ VERIFIED | `docs/runbooks/lane-b-collectors.md` present; this run performed zero restarts/installs/edits (twin `p19` was already up; proof leaves it up by design) |
| 25 | D19-26: `proof:laneb` drives working→idle→close, one muse tool call, five pointer-stable brief reruns + byte-identical closed-port run, synthetic Cursor stop; every event in budget with zero refused | ✓ VERIFIED | **Reran live on HEAD: 27/27 pass**, `refused emits (since …): 0 (0 skipped)`; guard paths exit 2 on stray arg / port 7410 / non-loopback (exercised live) |
| 26 | D19-27: proof isolation — loopback snapshot stub, HERDR stripped from child envs, temp-only side effects, live default session never touched | ✓ VERIFIED | Adaptation (stub instead of `herdr --session substrate-proof-tag server`, documented in 19-05-SUMMARY) — isolation properties kept and observed: temp dirs removed in finally, operator cache identical, no production port touched (guards exit 2) |
| 27 | D19-28: verification = full `bun test` + `bunx tsc --noEmit` + `check:phase-close` + `redact-lock` + `proof:laneb`; pre-existing HEAD failures recorded, not fixed | ✓ VERIFIED | This report: tsc exit 0; suite **2645 pass / 58 skip / 2 fail** (F-01 + F-02 below, both reproduce on clean HEAD, both out of phase scope); phase-close pass; locks 37 pass; proof 27/27 |
| 28 | D19-02 (vocabulary span): `cursor.stop→session.end`, `muse.brief_writer` silent, `muse.tool_call→tool.call`, `herdr.pane_exited` carries repo | ✓ VERIFIED | `herdr.pane_exited` `carriesRepo: true` with repo sample + doc table replaced (19-02 commit `937f06d`); cursor/muse mappings asserted in their hook tests; phase-close green |

**Score:** 28/28 truths verified (0 behavior-unverified).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/collectors/src/emit.ts` (+test) | postEvent/recordRefusal/counters | ✓ VERIFIED | 12 pass; never-throws, exact refused-line keys, call-time env |
| `packages/collectors/src/git-context.ts` (+test) | repoSlug/branchFor | ✓ VERIFIED | 9 pass on real repos |
| `packages/collectors/src/status.ts` (+test) + `collectors:status` script | summarize + read-only CLI | ✓ VERIFIED | 7 pass; live run prints counters + zero refused |
| `packages/collectors/src/grok.ts` on shared emit | no local emit, reserved counters key | ✓ VERIFIED | grok 7 + grok-map 12 pass, expectations unchanged |
| `packages/collectors/src/herdr-{map,state}.ts`, `herdr.ts` (+tests) | mapper + reconciler + loop | ✓ VERIFIED | 7 + 9 + 3 pass; live proof working→idle→close |
| `packages/collectors/src/muse.ts` (+test) | silent brief writer | ✓ VERIFIED | 13 pass + bearer fix tests; live proof brief + pointer checks |
| `packages/collectors/src/cursor-stop.ts` (+test) | contained stop hook | ✓ VERIFIED | 15 pass; live proof copy + emit checks |
| `packages/projector/src/muse.ts` (+test) | bundle projector | ✓ VERIFIED | 6 pass; live proof isolated projection |
| `packages/projector/src/cursor.ts` (+test) | byte-identical stop entry | ✓ VERIFIED | 2 pass; live `--check` already current |
| `packages/mcp-server/src/event-sources.ts` + `docs/event-vocabulary.md` | `pane_exited` carries repo; pinned herdr table | ✓ VERIFIED | phase-close (event-sources.test.ts) green |
| `docs/collectors.md` + README link | collectors topic doc | ✓ VERIFIED | Present (9490 bytes); README links it once |
| `docs/runbooks/lane-b-collectors.md` | six-step cutover runbook | ✓ VERIFIED | Present; Who-does-what + manual-only section |
| `scripts/laneb-proof.ts` + `proof:laneb` | 27-check isolated proof | ✓ VERIFIED | Reran live: 27/27 |
| `infra/vps/substrate-collector-{herdr,muse}.service` | ported units | ✓ VERIFIED | `systemd-analyze verify` exit 0; doctor gate 18 pass |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| herdr socket pushes | `session.snapshot` → reconcile → `herdr-map` → `postEvent` | debounce single-flight | ✓ WIRED | Proof checks 4–6 + 10 traverse the whole chain live |
| `herdr-map` transitions | EVENT_SOURCES rows → `normalizeEvent` unchanged kind/surface | mapper tests | ✓ WIRED | Round-trip asserted per transition; phase-close green |
| v2 state file | restart with no duplicate `session.start` | tmp+rename + seed-silently | ✓ WIRED | Proof checks 3 + 10 live |
| `muse.ts --once` | `POST /brief` keyed by slug → redacted `BRIEF.md` → one-block pointer | writer tests + proof | ✓ WIRED | Proof checks 14–17 live |
| `cursor-stop.ts` stdin | redacted copy → `session.end` via shared emit | hook tests + proof | ✓ WIRED | Proof checks 20–23 live |
| projector `cursor.ts --print-desired` | stop entry identical to live `hooks.json` | `--check` read-only | ✓ WIRED | Already-current, exit 0, live file untouched |
| projector `muse.ts` | bundle `hooks/redact.ts` byte copy + `substrate.json` → hook reads config, never env | sentinel + scrubbed-env tests | ✓ WIRED | Token-value refusal + URL-from-file asserted |
| `rehearsal up p19` | `consumer.env` twin URL → proof collectors (temp state) → `events_query(repo=R)` | proof run | ✓ WIRED | Twin `p19` alive (`healthz=200`, `127.0.0.1:17410`); 27/27 live |
| units `infra/vps` | runbook cutover (operator window, post-merge only) | doc | ✓ WIRED | No autonomous restart performed or needed |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `postEvent` | outcome + refused line | live POST /events status codes | ✓ FLOWING | 202/refused/failed classified live in proof (zero refused) |
| `reconcile` | start/note/end | loopback snapshot diffs per pane identity | ✓ FLOWING | Proof checks 4–6, 10–13 assert each transition with repo/branch |
| `muse.ts pass()` | redacted `BRIEF.md` + pointer | twin `/brief` fetch → `redact()` → tmp+rename | ✓ FLOWING | Proof checks 14–17; closed-port byte-identical |
| `cursor-stop.ts` | 0600 copy + `session.end` | fixture transcript → containment → `redact()` → shared emit | ✓ FLOWING | Proof checks 20–23; decoy absent from copy |
| muse hook | `tool.call` | fixture PostToolUse → `redactValue` → inline emit | ✓ FLOWING | Proof checks 7–8, 12; empty stdout, exit 0 |
| `collectors:status` | counters + refused lines | state files + `refused-emits.jsonl` | ✓ FLOWING | Live: `herdr: stored=303 refused=2 failed=0`, refused-since-midnight 0 |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full LANEB-07 proof on HEAD | `bun run proof:laneb` (twin `p19`, run `p19-mv2gbgog`) | 27/27, zero refused | ✓ PASS |
| Live production herdr emitting | `collectors:status --since 2026-10-10T00:00:00Z` | stored=303, refused-in-window 0 | ✓ PASS |
| Guard: production port refused | proof guard paths (port 7410, non-loopback, stray arg) | exit 2, no request | ✓ PASS |
| Cursor projector already current | `bun packages/projector/src/cursor.ts --check` | already current, exit 0 | ✓ PASS |
| Units verify | `systemd-analyze verify` herdr + muse | exit 0, no output | ✓ PASS |

### Probe Execution

No phase-declared `scripts/*/tests/probe-*.sh` probes exist for this phase. Step 7c: NOT APPLICABLE. (`scripts/laneb-proof.ts` is the phase proof instrument, executed live above.)

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| LANEB-01 | 19-02 | herdr panes emit under main's vocabulary | ✓ SATISFIED | Mapper + transport + live proof transitions |
| LANEB-02 | 19-02 | Snapshot-truth reconciler, restart-safe | ✓ SATISFIED | v2 state, no-duplicate-start, outage handling |
| LANEB-03 | 19-03 | Every Muse repo carries a fresh redacted brief + one pointer | ✓ SATISFIED | Writer tests + 5-rerun pointer stability + byte-identical closed-port run |
| LANEB-04 | 19-04 | Muse tool calls emit `tool.call` from surface `muse` via file-configured bundle | ✓ SATISFIED | Projector tests + isolated live hook emit + `docs/collectors.md` |
| LANEB-05 | 19-01 | Refused emits visible; no collector blocks an agent | ✓ SATISFIED | Shared emit + `refused-emits.jsonl` + `collectors:status`; dead-url hooks exit 0 in budget |
| LANEB-07 | 19-05 | Isolated proof seals the phase with zero refused, no production touch | ✓ SATISFIED | 27/27 live + runbook + unit verify |
| SKILL-06 | 19-03 | Cursor stop copies redacted transcript + emits `session.end`; projector entry byte-identical | ✓ SATISFIED | 15 hook tests + live copy/emit + `--check` already current |

No orphaned requirements: all seven requirements are carried by the five plans and satisfied above. (LANEB-06 belongs to Phase 18.)

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | No TBD/FIXME/XXX, stubs, empty handlers, hardcoded-empty render data, or console-log-only implementations in phase files | — | None — grep over `emit.ts`, `herdr.ts`, `muse.ts`, `cursor-stop.ts`, projector `muse.ts`, `laneb-proof.ts` returns only the intentional isolation-stub comments (loopback pane source + dead-url servers, the isolation mechanism, documented in 19-05-SUMMARY) |

### Human Verification Required

None for the verify step. The operator-owned manual items stay exactly where D19-24 puts them — in the runbook, post-merge, behind an approved window:

- `systemctl restart substrate-collector-herdr substrate-collector-muse` (cutover; **not** run here — the 12:47 deploy is untouched by this verification)
- User-scope Muse projection and any `/root/.cursor/hooks.json` edit
- The optional real Muse model turn through the projected hook
- `bun run rehearsal down --name p19` (twin left up by design; operator downs it when done)

### Gaps Summary

No open gaps. All 28 must-haves verified against HEAD `5f495ad` with behavioral evidence. Two plan adaptations (same guarantee, safer path — both documented in 19-05-SUMMARY and re-observed live in this run):

1. **D19-27 loopback snapshot stub** instead of `herdr --session substrate-proof-tag server`: the proof drives the real `HerdrCollector` against a loopback stub speaking the same snapshot RPC. HERDR stripping, temp-only side effects, and the no-duplicate-start assertion are unchanged and observed live.
2. **D19-20 `--bundle-only` + direct hook execution** instead of `muse plugins hook test`: installing for `hook test` writes user scope, which D19-24 forbids autonomously. The real binary validates the bundle; the identical hook file runs with the fixture shape; operator cache paths byte-identical before/after (proof check 9).

Known failures, recorded not fixed (both reproduce on the clean HEAD in this run; both outside phase-19 scope per operator rules):

- **F-01** — `scripts/rehearsal.test.ts` "CLI refusals > --port 7410 exits 2 without touching Docker" (cwd-sensitive refusal-order assertion, phase-16 scope).
- **F-02** — `packages/cli/src/token.test.ts` "a directory at the token-file path means no token" (reads the real host Cursor token, phase-20-owned).

No production restart was needed for any proof: the `p19` twin was already up and healthy, and every check runs against it or temp fixtures. Per instruction §3, no STOP was required — no command to report.

---

_Verified: 2026-10-10T13:51:40Z_
_Verifier: Phase19Verify (gsd verify-gates-only)_
_Head: 5f495ad · tsc exit 0 · suite 2645 pass / 58 skip / 2 fail (F-01, F-02) · proof:laneb 27/27 · phase-close pass · units verify exit 0_
