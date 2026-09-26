---
phase: 05-docs-and-desktop
plan: 03
subsystem: desktop
tags: [wave-1, tracer, d-12, d-13, d-14, d-16, d-18, d-19, sc3, webtop, xdotool, xwd, mcp, t-05-03-01, t-05-03-02, t-05-03-04, t-05-03-05, t-05-03-06, t-05-03-07]

requires:
  - phase: 05-docs-and-desktop
    provides: 05-01 gate-* baseline (503/0/27, tsc-exit=0), recruitment-desktop StartedAt, phase5-baseline rollback area
  - phase: 04-skills
    provides: createMcpServer opts.proposeAllowed (bearer surface or host propose key) and the skills_propose refusal pattern
provides:
  - infra/desktop/substrate-desktop.sh (idempotent up, key=value status); live container substrate-desktop on 127.0.0.1:6081 with basic auth
  - packages/mcp-server/src/desktop/{actions,driver}.ts — closed action vocabulary, Buffer-mode runner, XWD→PNG, process-wide mutex, per-action events
  - MCP tool desktop_run behind the D-19 guard; Substrate.runDesktop and the desktop stores seam
  - EVENT_KINDS docs.ingest and desktop.action (substrate-mcp restarted, so 05-04's CLI can post docs.ingest with no restart)
affects: [05-04, 05-06]

actuals:
  tokens: 16500      # chars/4 over the added lines of the 8 plan commits (66,170 chars)
  tasks: 3
  commits: 9         # 7059248 c4c70b4 efce209 f86bba7 e5b196c 1780c6e b0390d8 e42d692 + this SUMMARY
plan_head_before: d9b6780

tech-stack:
  added: []
  patterns:
    - "Closed action vocabulary: strict zod discriminated union → fixed argv builders; the caller never names a program, flag or shell"
    - "Buffer-mode execFile runner for binary stdout (xwd), separate from the utf8 Runner"
    - "Module-scope promise-chain mutex for per-process exclusivity while createMcpServer is rebuilt per request"
    - "Per-call budget raced against the driver's own timer; the run deadline gates only actions that have not started"

key-files:
  created:
    - infra/desktop/substrate-desktop.sh
    - packages/mcp-server/src/desktop/actions.ts
    - packages/mcp-server/src/desktop/actions.test.ts
    - packages/mcp-server/src/desktop/driver.ts
    - packages/mcp-server/src/desktop/driver.test.ts
    - .planning/phases/05-docs-and-desktop/05-03-SMOKE.md
    - /var/lib/substrate/phase5-baseline/RESTORE.d/05-03.md (host, 0600)
    - /etc/substrate/substrate-desktop.env (host, 0600; CUSTOM_USER, PASSWORD; never printed)
    - /var/lib/substrate/desktop/ (host, 0700; screenshots 0600)
  modified:
    - packages/mcp-server/src/types.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/mcp.ts
    - packages/mcp-server/src/mcp.test.ts

key-decisions:
  - "decodeXwd accepts packed 24 bpp as well as 32 bpp: this Xvfb (-screen 0 1280x800x24) makes xwd -root write bits_per_pixel 24 with 3-byte pixels in 5,120-byte scanlines"
  - "Per-call budget 30 s (plan: 10 s), +200 ms per typed character; the post-action title read keeps its full budget past the run deadline — measured docker exec 4-7 s, xwd 8-11 s under ~75% CPU steal"
  - "GUI smoke text adds `unset PROMPT_COMMAND; ` — the image's /etc/profile.d/vte-2.91.sh re-sets the terminal title at every prompt"
  - "Refusals and failures from runDesktop are isError text (redact()ed, ≤ 400 chars); the driver re-parses DesktopRunInput itself, so the closed vocabulary holds for any caller"
  - "A failed action stops the run (no title read, no later action); retention runs after every run and removes only dr-* dirs"

patterns-established:
  - "Evidence: failed live runs kept verbatim under ## Failed runs with the fix commit that followed each"

requirements-completed: []

coverage:
  - id: D1
    description: "substrate-desktop container: loopback 6081, basic auth, 1280x800, labelled, unprivileged, named volume only, no docker socket; recruitment container untouched"
    verification:
      - kind: other
        ref: "05-03-PLAN Task 1 <verify> (exit 0, re-run at the final state)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Closed action vocabulary, Buffer runner, XWD→PNG, mutex, deadlines, per-action redaction-safe events, retention"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/desktop/actions.test.ts, packages/mcp-server/src/desktop/driver.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "desktop_run behind the D-19 guard; docs.ingest/desktop.action kinds; live GUI smoke over MCP"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/mcp.test.ts#D-19 desktop_run refuses a session without the host propose key"
        status: pass
      - kind: e2e
        ref: "05-03-SMOKE.md smoke_run_id=dr-20260926T193225Z-903657 (Task 3 <verify> exit 0)"
        status: pass
    human_judgment: false

duration: ~81min
completed: 2026-09-26
status: complete
---

# Phase 5 Plan 03: Desktop tracer — substrate-desktop, desktop_run and the GUI smoke Summary

**An agent holding the host propose key now drives a sandboxed, loopback-only webtop through one MCP call (`desktop_run`: click/type/key/screenshot → fixed xdotool/xwd argv), gets back a 1280×800 PNG and a per-action log, and leaves one redaction-safe `desktop.action` event per action; an anonymous (VM-guest) session is refused before anything runs.**

## Performance

- Duration: ~81 min (18:23Z → 19:45Z), 3 of 3 tasks, all autonomous; no checkpoint.
- Commits: 7059248 (T1), c4c70b4 + efce209 (T2 RED/GREEN), f86bba7 + e5b196c (T3 RED/GREEN),
  1780c6e and b0390d8 (live-smoke fixes), e42d692 (T3 evidence), plus this SUMMARY.

## Accomplishments

- **Container (D-12, D-18).** `substrate-desktop` 1917e37f… from the local
  linuxserver/webtop:ubuntu-xfce (`--pull never`), `restart=unless-stopped`, `ports=127.0.0.1:6081->3000`,
  `geometry=1280x800`, `label_role=desktop`, `privileged=false`,
  `mounts=volume:substrate-desktop-config->/config`, `docker_socket_mounted=false`; `ss` shows only
  127.0.0.1:6081; web view 401 without and 200 with credentials; env file `600 root`
  (CUSTOM_USER,PASSWORD); a second `up` kept the same id. recruitment-desktop StartedAt
  2026-09-26T15:03:13.690881811Z before and after every live step.
- **Driver (D-13).** Strict zod vocabulary (1..50 actions, timeout 1..120 s default 30, text ≤ 2,000
  chars with no control characters but \n/\t, 1..8 key chords), fixed argv
  (`docker exec -e DISPLAY=:1 substrate-desktop` + xdotool/xwd, text after `--`), geometry read first
  and bounds refusal before any input, Buffer runner (16 MiB), XWD→PNG under
  /var/lib/substrate/desktop/<run_id>/ (0700/0600), 200-run/7-day retention, module-scope mutex,
  one fail-open `desktop.action` event per action with typed text only as text_chars/text_sha256.
- **MCP (D-19).** `desktop_run` registered after `skills_propose`, annotations
  `{destructiveHint:false, openWorldHint:true}`; without `proposeAllowed` it returns isError
  "desktop_run needs an authenticated surface or the host propose key; nothing was run"; the reply is
  the JSON text block then one `image/png` block per screenshot.
- **Live (D-14 part 2).** substrate-mcp restarted (final 19:31:28Z), /healthz 200, 7410 on 127.0.0.1
  only; tools/list lists desktop_run; the anonymous call was refused and created nothing; the keyed
  GUI smoke `dr-20260926T193225Z-903657` ran 4/4 ok, last title
  `Terminal - substrate-smoke-031fd710`, PNG 1280×800 mode 600 whose sha256 equals the image block's,
  4 events in Greptime, 0 carrying the typed text.

## Task Commits

1. **Task 1: lifecycle script and live container** — `7059248` (feat)
2. **Task 2: action vocabulary and driver** — `c4c70b4` (test, RED), `efce209` (feat, GREEN)
3. **Task 3: desktop_run, event kinds, restart, GUI smoke** — `f86bba7` (test, RED), `e5b196c` (feat,
   GREEN), `1780c6e` (fix), `b0390d8` (fix), `e42d692` (docs, evidence)

## Verify results

- Task 1 `<verify>`: exit 0 (and exit 0 again at the final state, under a real bash).
- Task 2 `<verify>`: exit 0 — 21 pass / 0 fail across the two desktop test files; tsc set
  `tsc-exit=0` equals gate-tsc-set.
- Task 3 `<verify>`: exit 0 — named test `D-19 desktop_run refuses a session without the host propose
  key` 1 pass; targeted 40 pass / 0 fail across 3 files; root suite **530 pass / 0 fail across 29
  files** (gate 503 / 0 / 27; no failing ids either side); tsc `tsc-exit=0` (diff empty).
- The shared RESTORE.md index is unchanged (sha256 bf326959…); RESTORE.d/05-03.md is `600 root`
  with the container, volume, env-file, screenshot and code routes, each written before its change.

## TDD Gate Compliance

Both tdd tasks have a `test(...)` RED commit before their `feat(...)` GREEN commit (c4c70b4 → efce209;
f86bba7 → e5b196c). RED was observed each time (module not found; 5 of 18 mcp tests failing). The two
live-found fixes were driven the same way: the new/changed test failed first, then the fix.

## Files Created/Modified

- `infra/desktop/substrate-desktop.sh` — `up` (root, disk gate, image-local gate, env file once, create/start, wait for 1280 800) and `status`.
- `packages/mcp-server/src/desktop/actions.ts` / `actions.test.ts` — vocabulary, grammar, bounds, argv builders.
- `packages/mcp-server/src/desktop/driver.ts` / `driver.test.ts` — bufferRunner, decodeXwd, encodePng, crc32, createDesktopDriver.
- `packages/mcp-server/src/types.ts` — EVENT_KINDS + `docs.ingest`, `desktop.action`.
- `packages/mcp-server/src/service.ts` — `desktop` stores seam, `runDesktop`.
- `packages/mcp-server/src/mcp.ts` / `mcp.test.ts` — `desktop_run` and its five tests.
- `.planning/phases/05-docs-and-desktop/05-03-SMOKE.md` — Task 1 and Task 3 evidence, failed runs, Gaps.

## Decisions Made

See key-decisions in the frontmatter.

## Deviations from Plan

1. **[Rule 1 - Bug] Per-call budgets.** The live smoke's 58-character type timed out twice at the
   plan's flat 10 s: docker exec alone takes 4-7 s on this VPS (vmstat steal 71-76%, load 15-23 on
   8 vCPUs), xdotool types ~160 ms/char, and xwd takes 8-11 s. ACTION_TIMEOUT_MS is 30 s, a type
   action adds TYPE_MS_PER_CHAR 200 ms per character (xdotool's own --delay alone makes 2,000 chars
   ≥ 24 s), and the post-action title read keeps its full budget past the run deadline. The run
   deadline (1..120 s) still stops every action not yet started. Commit 1780c6e, with a new test.
2. **[Rule 1 - Bug] 24 bpp xwd.** The plan and research assumed 32 bpp and asked for 24 bpp to be
   refused; the real `xwd -root` writes bits_per_pixel 24 (3-byte pixels, 5,120-byte scanlines,
   DirectColor, ncolors 256). decodeXwd accepts 32 and packed 24 bpp; the refusal test now uses 16
   bpp. Commit b0390d8; verified on a real dump before deploying.
3. **GUI smoke text.** Typed `PS1='$ '; unset PROMPT_COMMAND; printf '\033]0;substrate-smoke-<nonce>\007'`
   instead of the plan's text without `unset PROMPT_COMMAND; `: the image's vte-2.91.sh prompt hook
   re-set the title at every prompt (failed run 3). The terminal shows the title as
   "Terminal - <title>", which the verify's "contains" check accepts.
4. **Three substrate-mcp restarts instead of one** (19:04:13Z, 19:18:59Z, 19:31:28Z), one per code
   commit; the RESTORE.d code route was extended before each.
5. **First `up` output not captured**: the harness ended that cell at 30 s during the geometry wait;
   the script finished on its own (container up, 1280 800); status and the re-run `up` are complete.
6. **Verify re-run under a real bash**: this harness's shell `grep` builtin prints nothing for
   `grep -o`, which made Task 3's last pass-count check fail spuriously once (530 pass was in the
   file). The unchanged pipeline passed under `/usr/bin/env bash` (reported to the harness).
7. **Commits carry both trailers** `Refs SPE-3576` and `Refs SPE-3970` per the assignment.

## Issues Encountered

- Three failed smoke runs (kept in 05-03-SMOKE.md § Failed runs, 2/2/4 events, none with typed
  text). A timed-out `docker exec` stops only the client; the in-container xdotool may finish, and
  the desktop keeps three extra terminal windows from those runs (inside the container only).

## User Setup Required

None. The web view is reachable only through an SSH tunnel to 127.0.0.1:6081; its basic-auth
credentials are in /etc/substrate/substrate-desktop.env (root, 0600).

## Next Phase Readiness

- 05-04's CLI can post `docs.ingest` to the live /events (kind deployed with this restart).
- 05-06 re-runs the GUI smoke from an agent: use `unset PROMPT_COMMAND` in the typed text and expect
  runs of ~45-60 s on this host under load (timeout 60 passed; 120 is the cap).

## Self-Check: PASSED

- Files exist: substrate-desktop.sh (0755), desktop/actions.ts, actions.test.ts, driver.ts, driver.test.ts, 05-03-SMOKE.md; host RESTORE.d/05-03.md 600 root, substrate-desktop.env 600 root, /var/lib/substrate/desktop 700.
- Commits exist: 7059248, c4c70b4, efce209, f86bba7, e5b196c, 1780c6e, b0390d8, e42d692.
- Throwaways removed: events-count.ts, decode-probe.ts, xwd/png probes, the mcp.test.ts backup.
