---
phase: 05-docs-and-desktop
verified: 2026-09-27T06:13:35Z
status: gaps_found
score: 22/25 must-haves verified (22 verified, 3 not verified — owner skip of the docs half, override recorded, not applied)
covered_files:
  - .planning/phases/05-docs-and-desktop/05-01-INVENTORY.md
  - .planning/phases/05-docs-and-desktop/05-01-PLAN.md
  - .planning/phases/05-docs-and-desktop/05-01-SUMMARY.md
  - .planning/phases/05-docs-and-desktop/05-02-PLAN.md
  - .planning/phases/05-docs-and-desktop/05-02-SPIKE.md
  - .planning/phases/05-docs-and-desktop/05-02-SUMMARY.md
  - .planning/phases/05-docs-and-desktop/05-03-PLAN.md
  - .planning/phases/05-docs-and-desktop/05-03-SMOKE.md
  - .planning/phases/05-docs-and-desktop/05-03-SUMMARY.md
  - .planning/phases/05-docs-and-desktop/05-04-PLAN.md
  - .planning/phases/05-docs-and-desktop/05-05-PLAN.md
  - .planning/phases/05-docs-and-desktop/05-06-PLAN.md
  - .planning/phases/05-docs-and-desktop/05-06-SUMMARY.md
  - .planning/phases/05-docs-and-desktop/05-BASELINE.md
  - .planning/phases/05-docs-and-desktop/05-CONTEXT.md
  - .planning/phases/05-docs-and-desktop/05-PROOF.md
  - infra/desktop/substrate-desktop.sh
  - packages/mcp-server/src/desktop/actions.ts
  - packages/mcp-server/src/desktop/driver.ts
  - packages/mcp-server/src/mcp.ts
  - packages/mcp-server/src/service.ts
  - packages/mcp-server/src/types.ts
covered_digest: "v1:sha256:d006e4514b416f44d6a881070a30e98916426d7809b9d1344fe09ee36b02bd09"
covered_files_note: "Computed at HEAD 3ba530e with `query verification.fingerprint`. Excluded: ROADMAP.md (tracking log later phases append to); 05-RESEARCH/PATTERNS/VALIDATION/DISCOVERY/CHECK and COVERAGE.md (not plan, summary or evidence inputs); the test files (mcp.test.ts is shared with later phases). 05-04-PLAN.md and 05-05-PLAN.md are covered because their must-haves are the unmet docs half."
behavior_unverified: 0
overrides_applied: 0
owner_skip_overrides_recorded: 3 # on the three gaps below; not applied — see "Why the status is gaps_found"
gaps:
  - truth: "SC1 (re-scoped by D-01/D-03): docs.search proxies the owner's RAGFlow retrieval API (MCP name docs_search)"
    status: failed
    override: "owner-skip 2026-09-27"
    owner_answer_verbatim: "skip"
    owner_answer_source: "05-02-SPIKE.md § Owner report (Task 2 resume reply, relayed by the orchestrator on 2026-09-27)"
    reason: "Not built. The owner answered the 05-02 RAGFlow checkpoint with \"skip\" (spike_result=fail, spike_fail_reason=owner-skip); 05-04 and 05-05 never ran. Live tools/list on 127.0.0.1:7410 has no docs_search; no packages/**/docs/** or *ragflow* file exists; substrate.env has 0 RAGFLOW_* lines."
    artifacts:
      - path: "packages/mcp-server/src/mcp.ts"
        issue: "no docs_search tool registered"
      - path: "packages/mcp-server/src/docs/ragflow.ts"
        issue: "does not exist (05-04 skipped)"
    missing:
      - "05-02 T1/T4: owner RAGFlow setup (TEI bge-small, default embedding, chat model unset, API key, REGISTER_ENABLED=0, RAGFLOW_* in substrate.env) and the live contract spike"
      - "05-04: RAGFlow HTTP client, search normaliser, `substrate docs search`"
      - "05-05: docs_search MCP tool and POST /docs/search"
  - truth: "SC2: docs.ingest runs the redactor before ingesting"
    status: failed
    override: "owner-skip 2026-09-27"
    owner_answer_verbatim: "skip"
    owner_answer_source: "05-02-SPIKE.md § Owner report"
    reason: "Not built. Only the event kind `docs.ingest` exists (types.ts:40, added by 05-03 for the planned CLI); there is no ingest path, no redaction rules for the ragflow-/hyphenated sk- shapes, no fixture. 05-PROOF.md sc2_evidence=skipped-owner."
    artifacts:
      - path: "packages/mcp-server/src/types.ts"
        issue: "docs.ingest is an event kind only; nothing emits it"
    missing:
      - "05-02 T6: D-09 redact → strip images → hash order asserted on the spike"
      - "05-04: ragflow-/hyphenated sk- redaction rules, preparePage, idempotent ingest planner, `substrate docs ingest`"
      - "05-05: docs_ingest MCP tool behind the VM-guest guard, POST /docs/ingest (1 MB cap), full-corpus ingest, redaction fixture returning [REDACTED]"
      - "05-06 part 3: fixture re-check and values-file removal"
  - truth: "Proof, docs clause: an agent answers a docs question with a citation"
    status: failed
    override: "owner-skip 2026-09-27"
    owner_answer_verbatim: "skip"
    owner_answer_source: "05-02-SPIKE.md § Owner report"
    reason: "05-06 Task 1 did not run (05-PROOF.md § Skipped (owner skip); sc1_evidence=skipped-owner; proof_result=partial). No docs-mcp.json was written and no tool.call event exists."
    artifacts:
      - path: ".planning/phases/05-docs-and-desktop/05-PROOF.md"
        issue: "docs keys (docs_question … tool_call_event_has_url) absent by design"
    missing:
      - "05-06 part 1: a claude -p session cites a docs.python.org URL returned by docs_search, with a tool.call event carrying that URL"
---

# Phase 5: Docs and desktop Verification Report

**Phase Goal:** Product docs and GUI tasks reachable from any agent.
**Verified:** 2026-09-27T06:13:35Z (HEAD 3ba530e)
**Status:** gaps_found
**Re-verification:** No — initial verification

Half of the goal holds. Any agent holding an authenticated surface or the host propose key can drive
a sandboxed GUI through `desktop_run`. A real `claude -p` session did so over MCP and left 4
`desktop.action` events, which I counted again in Greptime. The docs half does not exist: the owner
answered "skip" at the 05-02 RAGFlow checkpoint, so SC1, SC2 and the docs clause of the Proof are
recorded as gaps. Each gap carries `override: owner-skip 2026-09-27`. None is marked passed.

## Why the status is gaps_found

The assignment allowed `passed` only if the gsd verifier rules let owner overrides count. They do,
but only by turning the item into `PASSED (override)` (verification-overrides.md § Impact on Overall
Status; gsd-verifier Step 3b). Phase 2 did this for its five overrides (02-VERIFICATION.md: `status:
passed`, `score: 65/65 … 5 passed by owner override`, `gaps: []`). Phase 5 cannot do the same, for
four reasons:

1. **The items are not verified.** The phase record declines to claim them: 05-PROOF.md
   `proof_result=partial`, `sc1_evidence=skipped-owner`, `sc2_evidence=skipped-owner`, and "not
   claimed". The assignment also says not to mark them passed. Once they stay unpassed, they are
   gaps, and gsd-verifier Step 9 rule 1 makes any gap `gaps_found`.
2. **The overrides guide excludes this case.** Its "When NOT to Use" list includes "the
   implementation is simply incomplete". Here the docs half has no implementation at all, not an
   alternative one. Phase 2's overrides were deviations inside delivered behaviour, and each rests
   on `owner_verified=approved` in 02-PROOF.md. 05-PROOF.md has no owner-verified line. The owner's
   only words are the checkpoint reply "skip", which accepts no verdict.
3. **No later phase takes the work (Step 9b).** ROADMAP Phase 8 SC3 marks its docs clause
   "superseded by 08-CONTEXT D-10", and no phase after 5 names docs_search, docs.ingest or RAGFlow.
   The gaps therefore cannot be moved to the deferred list.
4. **Downstream gates already expect this.** 06-01 T1 and 08-01 T1 accept
   `phase5-verification=passed` *or* an orchestrator acceptance with a verbatim
   `phase5-accepted-note:`. 08-01 adds: "for Phase 5 an acceptance citing D-10, the skipped docs
   half, is expected". The route onward is that acceptance, not a relabelled status.

The owner-skip annotations are kept on the gap entries. They are not in a top-level `overrides:`
list, because Step 3b would fuzzy-match that list on re-verification and turn the gaps into
`PASSED (override)`.

## Goal Achievement

### Observable Truths

Truths 1–5 come from the ROADMAP contract. Truths 6–25 are the must-haves of the plans that ran:
05-01, 05-02 up to its stop condition, 05-03, and the desktop half of 05-06. The must-haves of the
skipped work are folded into the three frontmatter gaps (truths 1, 2 and 4) under `missing:`: 05-02 T1/T4/T6, all of 05-04 and
05-05, and 05-06 parts 1 and 3. None of that work ran.

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | SC1: `docs.search` proxies the owner's RAGFlow retrieval API (`docs_search`) | ✗ NOT VERIFIED — owner-skip 2026-09-27 (override recorded, not applied) | Owner reply verbatim: "skip" (05-02-SPIKE.md § Owner report). Live `tools/list`: 13 tools, no `docs_search`. No docs/ragflow source. substrate.env has 0 RAGFLOW_* lines. |
| 2 | SC2: `docs.ingest` runs the redactor before ingesting | ✗ NOT VERIFIED — owner-skip 2026-09-27 (override recorded, not applied) | Same owner reply. Only the event kind exists (types.ts:40). 05-04/05-05 not executed. sc2_evidence=skipped-owner. |
| 3 | SC3 (D-16): `desktop.run` drives a dedicated webtop container on the Docker path (docker exec + xdotool/xwd; `desktop_run`) | ✓ VERIFIED | actions.ts:8 `EXEC = docker exec -e DISPLAY=:1 substrate-desktop`, argv builders for xdotool/xwd. mcp.ts:179 registers `desktop_run` → service.ts:185 `runDesktop` → driver (service.ts:113 `createDesktopDriver({ run: bufferRunner, … })`). Live: container running, tools/list lists `desktop_run`, run dr-20260927T055519Z-002e8a has 4 events. |
| 4 | Proof, docs clause: an agent answers a docs question with a citation | ✗ NOT VERIFIED — owner-skip 2026-09-27 (override recorded, not applied) | 05-PROOF.md § Skipped (owner skip). Task 1 not run. proof_result=partial. |
| 5 | Proof, GUI clause: a GUI smoke test runs in a sandbox | ✓ VERIFIED | 05-PROOF.md run 2: `claude -p` session 73e06ef7…, 1 tool_use `mcp__substrate__desktop_run`, 4/4 ok, last title `Terminal - substrate-smoke-6155f173`. Live re-check: Greptime has `desktop.action` count 4, surface `claude-code`, 0 rows with `PS1=`/`PROMPT_COMMAND`. The window titled `Terminal - substrate-smoke-6155f173` is still on the display. Pixel caveat: see Note N1. |
| 6 | 05-01: Phase 4 landed before Phase 5 started | ✓ VERIFIED | 05-BASELINE.md: `phase4-verification=accepted` with a verbatim note, library-clean=true, library-top-links=0, propose-key-mode=600. 04-VERIFICATION.md now reads `status: passed`. |
| 7 | 05-01: disk gate ≥ 10 GiB before any Phase 5 change | ✓ VERIFIED | `disk-avail-before=175147573248`. |
| 8 | 05-01 (D-14 part 4): post-Phase-4 baseline re-measured as `gate-*` keys | ✓ VERIFIED | gate-head=84c2ebc, gate-pass=503, gate-fail=0, gate-files=27, gate-tsc-set tsc-exit=0, gate-dispatcher-pass=149. |
| 9 | 05-01: rollback area with a per-plan RESTORE.d, a t0 snapshot and a MANIFEST | ✓ VERIFIED | Live: /var/lib/substrate/phase5-baseline 700 root. RESTORE.d has 05-02.md, 05-03.md, 05-06.md (each 600 root). t0-20260926T181142Z `sha256sum -c MANIFEST.sha256` passes. RESTORE.md sha256 bf326959… is unchanged. |
| 10 | 05-01 (D-15): corpus inventory recorded | ✓ VERIFIED | 05-01-INVENTORY.md: corpus_dirs=25, corpus_pages=2317, docs_python_pages=80, tracer_url=…/cmath.html. Its consumers (05-04/05-05) were skipped. |
| 11 | 05-02 (D-02): presence-only checks; no RAGFlow value recorded | ✓ VERIFIED | 05-02-SPIKE.md has only counts and modes (`ragflow_*_present=0`, `env_mode_after=600 root`). |
| 12 | 05-02: no silent fallback — on "skip" the plan stops, records spike_result=fail, and 05-04..05-06's docs half do not start; there is no substitute docs backend | ✓ VERIFIED | spike_result=fail, spike_fail_reason=owner-skip. No docs code, tool, route or CLI exists (glob, tools/list). ROADMAP c6b86c8 records the stop. |
| 13 | 05-02: its RESTORE route is written to RESTORE.d/05-02.md before any env edit | ✓ VERIFIED | restore_route_written=true (Task 1, 18:21:44Z). File is 600 root. substrate.env was never edited. |
| 14 | 05-03 (D-12/D-18): substrate-desktop runs `--pull never`, restart unless-stopped, its own volume, role label, unprivileged, no host mounts or docker socket, 1280×800, web view on 127.0.0.1:6081 only with basic auth from a 0600 env file | ✓ VERIFIED | Live `substrate-desktop.sh status`: restart=unless-stopped, ports=127.0.0.1:6081->3000, geometry=1280x800, label_role=desktop, privileged=false, mounts=volume:substrate-desktop-config->/config, docker_socket_mounted=false. `ss` shows 6081 on 127.0.0.1 only. The unauthenticated web view returns 401. The env file is 600 root. The script runs `docker run -d --pull never`. |
| 15 | 05-03: the recruitment container is never touched | ✓ VERIFIED | The script has no match for "recruitment" and no rm/stop/kill/pull. Live recruitment-desktop StartedAt is 2026-09-26T15:03:13.690881811Z (RestartCount 0), equal to 05-BASELINE `recruitment-desktop-started-at`. |
| 16 | 05-03 (D-13): closed vocabulary (≤ 50 actions, timeout 1..120 s default 30, bounded clicks, key grammar, ≤ 2,000-char text after `--`), no shell; returns {run_id, screenshots, log} plus image blocks | ✓ VERIFIED | actions.ts:47-49 (`.min(1).max(50)`, `.min(1).max(120).default(30)`), :32-33 (`.max(2000)`, control-char regex), :94 (`--`). actions.test.ts pins the exact argv table. mcp.ts:192-195 returns the JSON text followed by image blocks. `bun test packages/mcp-server/src/desktop/`: 22 pass / 0 fail. |
| 17 | 05-03 (D-13): one fail-open `desktop.action` event per action; typed text only as text_chars/text_sha256 | ✓ VERIFIED | driver.ts:287. driver.test.ts:152-201 asserts 4 events and the sha256 of the typed text. The live Greptime count shows 0 rows carrying the typed text. |
| 18 | 05-03: Buffer runner (16 MiB), XWD→PNG under /var/lib/substrate/desktop (0700/0600), retention of 200 runs and 7 days, process-wide mutex | ✓ VERIFIED | driver.ts:60 `encoding: "buffer", maxBuffer: 16 << 20`. :36-38 SHOTS_DIR, RETAIN_RUNS=200, RETAIN_MS=7 d. :302/:304 modes. Mutex test driver.test.ts:311. Live: the desktop dir is 700 root and the run-2 PNG is 600 root. |
| 19 | 05-03 (D-19): `desktop_run` refuses a caller without proposeAllowed and runs nothing | ✓ VERIFIED | mcp.ts:188-189. server.ts:94/239 wires `proposeAllowed`. Named test `D-19 desktop_run refuses a session without the host propose key`: 1 pass / 0 fail. 05-03-SMOKE records the live anonymous refusal. |
| 20 | 05-03 (D-14 part 2 tracer): a GUI smoke over a real MCP call; title contains substrate-smoke-<nonce>, PNG 1280×800, 4 events | ✓ VERIFIED | 05-03-SMOKE smoke_run_id=dr-20260926T193225Z-903657: last title `Terminal - substrate-smoke-031fd710`, 4 events. That window is still listed live. The pass rests on the title, not on pixels (N1). |
| 21 | 05-03: EVENT_KINDS gains `desktop.action` and `docs.ingest`; every rollback route goes into RESTORE.d/05-03.md first | ✓ VERIFIED | types.ts:39-41. RESTORE.d/05-03.md is 600 root. "Before its change" is taken from the 05-03-SMOKE record; I did not observe it myself. |
| 22 | 05-03: root suite and tsc two-sided green against `gate-*` | ✓ VERIFIED | 05-03: 530/0/29, tsc-exit=0. Re-confirmed by the 05-06 final gate below. Between 63d5397 and HEAD only 05-PROOF.md and 05-06-SUMMARY.md changed (`git diff --stat`). |
| 23 | 05-06 (D-14 part 2): a `claude -p` session with session-scoped `--mcp-config --strict-mcp-config` drives substrate-desktop, the key comes only from a headersHelper, 4 events, recruitment unchanged | ✓ VERIFIED | 05-PROOF: gui_mcp_server_status=connected, mcp_header_route=helper, gui_tool_calls=1, gui_input_unchanged=true. Live: the transcript has 3 `mcp__substrate__desktop_run` lines, Greptime count 4 / surface claude-code, recruitment StartedAt unchanged. |
| 24 | 05-06 (D-14 part 4): final root suite, tsc and dispatcher two-sided green | ✓ VERIFIED | At 63d5397: bun 534 pass / 0 fail / 29 files (gate 503), tsc-exit=0 with an empty diff, dispatcher 149 passed (gate 149). Failing-id diffs are empty on both sides. I did not re-run the full suite. |
| 25 | 05-06: evidence as key=value; transcripts 0600 and key-free; configs and header helper removed | ✓ VERIFIED | Live: /var/lib/substrate/proof is 700 root. Scanning it for the propose key finds 0 files. `gui-mcp.json` and `propose-header.sh` are absent (ls). The run-2 PNG sha256 fd8f5d33…, mode 600, matches gui_png_sha256. |

**Score:** 22/25 truths verified (0 present, behavior-unverified; 0 overrides applied; 3 owner-skip gaps)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `infra/desktop/substrate-desktop.sh` | idempotent `up`, key=value `status`, `--pull never` | ✓ VERIFIED | 146 lines; `status` run live (above) |
| `packages/mcp-server/src/desktop/actions.ts` | zod vocabulary, parseKeys, bounds, argv builders; `DISPLAY=:1` | ✓ VERIFIED | 111 lines; `EXEC` at :8 |
| `packages/mcp-server/src/desktop/driver.ts` | bufferRunner, decodeXwd, encodePng, createDesktopDriver; `encoding: "buffer"` | ✓ VERIFIED | 359 lines; :60 |
| `.planning/phases/05-docs-and-desktop/05-03-SMOKE.md` | container/web view/restart/GUI smoke evidence; `smoke_title=` | ✓ VERIFIED | present |
| `.planning/phases/05-docs-and-desktop/05-BASELINE.md` | `gate-head=` and gate-* keys | ✓ VERIFIED | :98-104 |
| `.planning/phases/05-docs-and-desktop/05-01-INVENTORY.md` | `corpus_pages=` | ✓ VERIFIED | :24 |
| `.planning/phases/05-docs-and-desktop/05-02-SPIKE.md` | `spike_result=` | ✓ VERIFIED | `spike_result=fail` (owner-skip) — the artifact exists; the contract keys 05-04 needed (update_method …) do not (gap 1) |
| `.planning/phases/05-docs-and-desktop/05-PROOF.md` | `proof_result=` | ✓ VERIFIED | `proof_result=partial` |
| docs client, `docs_search`/`docs_ingest`, `/docs/*`, `substrate docs` CLI, 05-04-TRACER.md, 05-05-SMOKE.md | docs half | ✗ MISSING (owner-skip) | truths 1, 2, 4 (the three frontmatter gaps) |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| mcp.ts | desktop/driver.ts | `desktop_run` → `opts.proposeAllowed` → `Substrate.runDesktop` → `stores.desktop.run` | ✓ WIRED | mcp.ts:179-192 → service.ts:185-187 → service.ts:113 |
| server.ts | mcp.ts | per-request `createMcpServer(…, { proposeAllowed })` from the caller check | ✓ WIRED | server.ts:94, :239 |
| desktop/driver.ts | substrate-desktop container | execFile `docker exec -e DISPLAY=:1 substrate-desktop` xdotool/xwd, Buffer mode | ✓ WIRED | actions.ts:8 + driver.ts:60; live runs |
| claude -p session | http://127.0.0.1:7410/mcp | `--mcp-config … --strict-mcp-config --allowedTools mcp__substrate__desktop_run` | ✓ WIRED | 05-PROOF init `substrate connected` |
| 05-BASELINE.md | later Phase 5 gates | `gate-pass=` / gate-tsc-set | ✓ WIRED | 05-06 final gate reads them |
| substrate.env | config.ts ragflow block | RAGFLOW_* | ✗ NOT_WIRED (owner-skip) | 0 lines in substrate.env; no ragflow config |
| docs_search | Greptime `tool.call` | payload.urls | ✗ NOT_WIRED (owner-skip) | tool does not exist |
| 05-01-INVENTORY.md | 05-04/05-05 | tracer_url, corpus_* | ✗ NOT_WIRED (owner-skip) | consumers skipped |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| `desktop_run` reply | `log[i].active_window` | `xdotool getactivewindow getwindowname` in the container | Yes — the live title matches the window list | ✓ FLOWING |
| `desktop_run` reply | `screenshots[]` / image block | `xwd -root -silent` → decodeXwd → encodePng | PNG 1280×800 written, sha256 matches. **Pixels lag the newest window** (N1) | ⚠️ FLOWING, content stale |
| `desktop.action` events | payload | driver `emit` → Substrate.emit → Greptime | Yes — 4 rows for run 2 | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Desktop vocabulary and driver | `SUBSTRATE_DISABLED=1 bun test packages/mcp-server/src/desktop/` | 22 pass / 0 fail / 340 expect() / 2 files | ✓ PASS |
| D-19 guard | `bun test packages/mcp-server/src/mcp.test.ts -t "D-19 desktop_run refuses a session without the host propose key"` | 1 pass / 17 filtered / 0 fail | ✓ PASS |
| Container shape | `sudo infra/desktop/substrate-desktop.sh status` | see truth 14; id 1917e37f4d54… | ✓ PASS |
| Loopback only | `ss -ltnH` for :6081/:7410 | `127.0.0.1:6081`, `127.0.0.1:7410` only | ✓ PASS |
| Web view auth | `curl -o /dev/null -w %{http_code} http://127.0.0.1:6081/` | 401 | ✓ PASS |
| substrate-mcp up, tool listed | `systemctl is-active`; `/healthz`; anonymous `tools/list` | active; 200; 13 tools incl. `desktop_run`, no `docs_search` | ✓ PASS |
| Recruitment untouched | `docker inspect … recruitment-desktop` | StartedAt 2026-09-26T15:03:13.690881811Z, RestartCount 0 | ✓ PASS |
| Run-2 events | keyed read-only Greptime `SELECT count(*) … kind='desktop.action' AND payload LIKE '%dr-20260927T055519Z-002e8a%'` | `[4, 1 surface, "claude-code", 0 typed]` | ✓ PASS |
| Proof files hygiene | `stat`, `sha256sum`, propose-key `grep -rlF` over /var/lib/substrate/proof | 700/600 root; PNG fd8f5d33…; 0 files contain the key | ✓ PASS |
| Rollback snapshot | `sha256sum -c MANIFEST.sha256` in t0-20260926T181142Z | manifest_ok | ✓ PASS |

I did not re-run the full suite, tsc or pytest. The gate numbers come from 05-06 at 63d5397 (bun
534/0/29, tsc-exit=0, dispatcher 149), and only planning docs changed between 63d5397 and HEAD. Every
live check above only read state; I made no `desktop_run` call.

### Probe Execution

No `probe-*.sh` is declared by any Phase 5 plan or summary; none exists for this phase. Step 7c: no probes.

### Requirements Coverage

No plan declares requirement IDs (`requirements: []`), and there is no .planning/REQUIREMENTS.md. The
ROADMAP success criteria above are the contract. There are no orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| infra/desktop/substrate-desktop.sh | 57 | `XXXXXX` | ℹ️ Info | mktemp template, not a debt marker |

No TBD/FIXME/XXX/TODO/placeholder markers exist in desktop/*, mcp.ts, service.ts or types.ts.

### Human Verification Required

None. The three open items are gaps, not human checks. They carry the owner's recorded skip, so the
next step is the orchestrator's decision (see Gaps Summary), not a test.

### Notes (05-06 issues, non-blocking)

- **N1 — Stale xwd pixels for the newest window (⚠️ Warning).** Run 2's PNG
  (/var/lib/substrate/desktop/dr-20260927T055519Z-002e8a/1.png, sha256 fd8f5d33…, 1280×800, 600
  root) shows an older window's contents in the new terminal's rectangle. The X server reports the
  new window as active and topmost with the smoke title. A diagnostic screenshot a minute later
  (dr-20260927T055741Z-a93dcf) showed the same pixels. The agent flagged the mismatch in its own
  answer. SC3 and the GUI-smoke clause therefore rest on title evidence (xdotool reads the title
  from the X server), and so did 05-03's smoke. The cause is inferred to be repaint starvation under
  ~70% CPU steal; nobody investigated it. Any later need for pixel-level GUI assertions needs a
  follow-up here first.
- **N2 — 7 terminal windows left in substrate-desktop (ℹ️ Info).** A live `xdotool search
  --onlyvisible --name '^Terminal'` counts 7. They include `Terminal - substrate-smoke-031fd710`
  (05-03) and `Terminal - substrate-smoke-6155f173` (05-06 run 2). Three are from 05-03's failed
  runs and two from 05-06. They exist only inside the container. RESTORE.d/05-06.md (600 root) names
  how to close them. They were not closed.
- **N3 — Linear rows created by the owner's prompt-uplift hook (⚠️ Warning, owner action).** 05-06
  run 1 ran with the owner's global SessionStart/UserPromptSubmit hooks, and the hook reported
  "Tracking · 5 issues · 31 sub-issues linked" for the proof prompt. A read-only Linear
  `list_issues` query (createdAt ≥ 05:43Z) shows 36 issues, all in team Spectrum Web Co and all
  Backlog, created between 05:49:16Z and 05:49:47Z:
  - 5 parents: SPE-4046 "[n1] Understand", SPE-4047 "[n2] Decompose", SPE-4048 "[n3] Approaches",
    SPE-4049 "[n4] Risks" and SPE-4050 "[n5] Plan".
  - 31 sub-issues, SPE-4051..SPE-4081, whose titles restate the desktop_run proof prompt.

  The plan did not create them. Nobody cleaned them up, and whether to archive or cancel them is the
  owner's call. Run 2 passed `--settings '{"disableAllHooks":true}'` (session-scoped), which
  prevented a repeat.
- **N4 — Input deviations (ℹ️ Info).** The typed text adds `unset PROMPT_COMMAND; ` (05-03 Gaps 1).
  Run 2 used settle_ms 5000 (the vocabulary maximum) and timeout 120, because run 1 typed into the
  previously focused terminal. `desktop_run` emits no `tool.call` event; its audit record is the
  `desktop.action` events.

### Gaps Summary

All three gaps have one root cause: the owner answered "skip" at the 05-02 RAGFlow checkpoint on
2026-09-27. With no RAGFlow setup there is no docs backend, and D-01 rules out a substitute. So
05-04 and 05-05 never ran, and 05-06 ran only its desktop half. The phase is internally consistent
about this. ROADMAP Phase 5 (c6b86c8) says the phase "lands on the desktop half". 05-PROOF.md says
proof_result=partial and does not claim the docs half. Phases 6 and 8 have already been re-planned
without docs symbols.

There are two ways to close the gaps, and both are the orchestrator's or owner's call:

- **Proceed on the desktop half.** Record `phase5-verification=accepted` with a verbatim
  `phase5-accepted-note:` in the 06-01 and 08-01 baselines, citing D-10 and this report. This is
  the path both gates were amended for.
- **Build the docs half later.** Re-open the docs half in a new phase: owner RAGFlow setup, then
  05-04, 05-05 and 05-06 parts 1 and 3.

No code change inside Phase 5 can close these gaps without the owner's RAGFlow inputs.

---

_Verified: 2026-09-27T06:13:35Z_
_Verifier: Claude (gsd-verifier)_
