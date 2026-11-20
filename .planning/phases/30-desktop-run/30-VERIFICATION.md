---
phase: 30-desktop-run
verified: 2026-11-18T12:23:16Z
status: human_needed
score: 4/5 success criteria verified in code and passing tests; 1 requires a live run (human_needed)
covered_files: [".planning/milestones/v1.3-phases/30-desktop-run/30-01-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-01-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-02-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-02-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-03-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-03-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-04-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-04-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-05-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-05-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-06-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-06-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-07-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-07-SUMMARY.md", "infra/desktop/substrate-desktop.sh", "packages/audit/src/policy.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/desktop/actions.ts", "packages/mcp-server/src/desktop/driver.ts", "packages/mcp-server/src/desktop/png.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:3a8dd50228afef60390fc18da23ab139a603bfd3b9f5f5d343e3ec373002b58c"
behavior_unverified: 0
overrides_applied: 0
re_verification: null
human_verification:
  - test: "Run the live proof chain (DESK-05): bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp; bun run smoke:desktop --name p30; bun run check:phase-close; bun run rehearsal down --name p30"
    expected: "marker run accepted with a returned screenshot whose band pixels (>= 1500) appear in the block and not in the baseline; block, stored file and event sha256 equal per shot; 5 stored tool.call rows under desktop:<run_id> with hashes only; unlisted token refused with no new row; no-token and port 6081 without credentials both 401; recruitment-desktop inspect identical before and after"
    why_human: "Drives the live substrate-desktop display (keystrokes and captures) and needs a running rehearsal stack; the pixel proof cannot be observed from source or unit tests. 30-PROOF.md records every live field as NOT-RUN."
---

# Phase 30: desktop_run Verification Report

**Phase Goal:** An authenticated agent can drive the dedicated webtop desktop and see the result, through a closed vocabulary that leaves an audit trail and exposes nothing else on the host.
**Verified:** 2026-11-18T12:23:16Z
**Status:** human_needed
**Re-verification:** No. `.planning/phases/30-desktop-run/` did not exist before this run. The phase records live under `.planning/milestones/v1.3-phases/30-desktop-run/`, and the earlier record there (`30-VERIFICATION.md`, 2026-10-10, `passed-with-gated-remainder`) was left untouched.

## Method

- Must-haves are the five ROADMAP Phase 30 success criteria (the roadmap contract). No PLAN frontmatter `must_haves` were loaded, because the plan files sit in the archive directory.
- SUMMARY and archived VERIFICATION claims were not used as evidence. Each criterion was checked against source at HEAD `357d6b15`.
- Targeted tests run (single run, no full suite):
  - `bun test packages/mcp-server/src/desktop scripts/substrate-desktop.test.ts scripts/desktop-smoke.test.ts`: 115 pass, 0 fail, 0 skip across 7 files. The root-only lifecycle cases ran, because the shell is root.
  - `bun test packages/mcp-server/src/http.test.ts -t "desktop_run at the HTTP gate"`: 6 pass, 0 fail.
- The live stack was not started. The criterion that needs it is classified human_needed.

## Goal Achievement

### Observable Truths

| # | Success criterion | Status | Evidence |
|---|---|---|---|
| 1 | `desktop_run` accepts only click/type/key/screenshot, at most 50 actions, 1-120 s timeout, fixed `docker exec` argv, one run at a time; screenshots return as MCP image blocks, stored at mode 0600, kept for 200 runs or 7 days | ✓ VERIFIED | `desktop/actions.ts`: `DesktopAction` is a discriminated union of exactly four strict types; `DesktopRunInput` has `actions.max(50)` and `timeout` `int().min(1).max(120)`; `EXEC = ["docker","exec","-e","DISPLAY=:1","substrate-desktop"]` prefixes every argv. `driver.ts`: `active` module flag plus `claimDesktopPort` loopback mutex refuse a second run (`DesktopBusy`); `writeFileSync(..., {mode: 0o600})`, dirs `0o700`; `prune()` with `RETAIN_RUNS = 200`, `RETAIN_MS = 7 days`. `mcp.ts` maps `images` to `{type:"image", mimeType:"image/png"}` blocks. Tests: `driver.test.ts` "writes a 0600 PNG", "retention keeps at most 200 runs…", "a second run while one is active is refused at once"; `actions.test.ts` "refuses an unknown type… 0/5…", "equal the fixed table exactly"; `tool.test.ts` "returns one text block plus image blocks". |
| 2 | Each action produces one event under an existing kind; typed text recorded only as length + sha256; no image block in the audit record | ✓ VERIFIED | `driver.ts` emits one `kind: "tool.call"` per executed action. `tool.call` is in `EVENT_KINDS` (`types.ts:73`). A `type` action's details are `text_len` and `text_sha256` only (`Object.assign(details, { text_len, text_sha256 })`). Screenshot details carry `sha256/width/height`, never bytes. Failed and stored-checked emit paths are covered. Tests: `driver.test.ts` "hashes key sequences that would spell text, with no keys field anywhere"; `http.test.ts` "the audit record carries keys plus digest only, in fail-closed mode" asserts the sentinel text and `iVBOR` never appear in audit records. |
| 3 | Allowlist-only: unlisted surface with valid token, anonymous caller and VM guest each refused, each with a test; `desktop_run` fail-closed in audit policy | ✓ VERIFIED | Gate in `service.ts` `runDesktop`: `callerSurface === null` refused; `!this.config.desktopSurfaces.has(callerSurface)` refused before any driver call. `config.ts` parses `SUBSTRATE_DESKTOP_SURFACES` fail-closed (empty = nobody). Tests: unlisted surface → `tool.test.ts` "an unlisted surface is refused and runs nothing" and `http.test.ts` "an unlisted surface with a valid token is refused and runs nothing" (tok-cursor). Anonymous → `tool.test.ts` "an anonymous caller is refused and runs nothing". VM guest (per 30-CONTEXT.md: a Lane A VM holds no token, so it reaches the server with no bearer) → `http.test.ts` "no bearer is 401 before the runner or the audit ever see the call" plus "a bogus bearer is 401". Audit policy: `packages/audit/src/policy.ts` lists `"desktop_run"` in the write group and does not list it in `FAIL_OPEN_TOOLS`; `auditMode()` defaults unknown tools to fail-closed. `http.test.ts` "an audit chain that will not take the record denies the fail-closed tool" and "…in fail-closed mode" confirm `mode: "fail-closed"` in the recorded audit. |
| 4 | Lifecycle script: container only with ≥10 GiB free, `--pull never`, loopback 6081 behind basic auth, unprivileged, no Docker socket, never touches `recruitment-desktop` | ✓ VERIFIED (stub-argv level) | `infra/desktop/substrate-desktop.sh`: `MIN_FREE_BYTES=10737418240` checked before any docker call; `image inspect` refuses a missing image, so there is no pull; `docker run -d --pull never ... -p 127.0.0.1:6081:3000 ... --env-file "$ENV_FILE"`, no `--privileged`, no socket mount, no host mounts; an existing container without the desktop label is refused; the script names only `substrate-desktop`. `scripts/substrate-desktop.test.ts` pins the argv (`--pull never`, `-p 127.0.0.1:6081:3000`, no `--privileged`, no `docker.sock`, no `--network host`), the 10 GiB boundary (`GATE_BYTES - 1` refused, `GATE_BYTES` accepted), non-local endpoint refusals before any run, and `assertCleanArgv` (no `recruitment`, no `rm|stop|kill|pull`). All 115 targeted tests pass. The live container state on the host was not observed. |
| 5 | Headless session's `desktop_run` returns a screenshot whose pixels show the typed marker | ? HUMAN_NEEDED | Requires the live `substrate-desktop` display and a rehearsal stack. `scripts/desktop-smoke.ts` and `scripts/desktop-smoke.test.ts` (20 helper tests, passing) implement the band finder and marker, but the end-to-end pixel result was never produced. `30-PROOF.md` marks every live field `NOT-RUN` ("live chain NOT RUN"). Not run here, per the no-live-stack rule. |

**Score:** 4/5 criteria verified; criterion 5 needs a live operator run (human_needed). No criterion FAILED. No gaps.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/mcp-server/src/desktop/actions.ts` | Closed vocabulary, argv builders | ✓ VERIFIED | Substantive; wired via `mcp.ts` import of `DesktopRunInput` and driver import |
| `packages/mcp-server/src/desktop/driver.ts` | Executor, mutex, retention, redacted events | ✓ VERIFIED | 502 lines; wired from `index.ts` (`createDesktopDriver({ run: bufferRunner, dir })`) and `service.ts` |
| `packages/mcp-server/src/desktop/png.ts` | XWD decode, PNG encode | ✓ VERIFIED | Used in `driver.ts` for screenshots; `png.test.ts` present |
| `packages/mcp-server/src/mcp.ts` (registration) | `desktop_run` tool with image blocks | ✓ VERIFIED | `registerTool("desktop_run", ...)` maps refusal/failed/result |
| `packages/mcp-server/src/service.ts` (`runDesktop`) | Allowlist and ledger gate | ✓ VERIFIED | Null surface, allowlist, driver wiring, ledger presence checked in order |
| `packages/mcp-server/src/config.ts` | `desktopSurfaces`, `desktopDir` | ✓ VERIFIED | Fail-closed empty default; unknown names dropped and warned |
| `packages/audit/src/policy.ts` | fail-closed audit mode | ✓ VERIFIED | `desktop_run` not in `FAIL_OPEN_TOOLS` |
| `infra/desktop/substrate-desktop.sh` | Lifecycle script | ✓ VERIFIED (stub level) | Gates precede every docker mutation; argv pinned by test |
| `scripts/desktop-smoke.ts` | Live proof client | ✓ VERIFIED (code) / ? live result | Live run not performed |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `mcp.ts` `desktop_run` | `Substrate.runDesktop` | `substrate.runDesktop(input, callerSurface)` | ✓ WIRED | `callerSurface` comes from the authenticated server context, never the arguments |
| `Substrate.runDesktop` | `DesktopDriver.run` | `this.desktop.run(input, { surface, emit })` | ✓ WIRED | `emit` is `this.emit(event)`, so a non-stored event stops the run (D30-12) |
| `index.ts` | `createDesktopDriver` | `{ desktop: createDesktopDriver({ run: bufferRunner, dir: config.desktopDir }) }` | ✓ WIRED | The real driver is wired only in the entry point |
| `driver.ts` `execute` | `docker exec` argv | `call(argv)` → `bufferRunner` → `execFile` (no shell) | ✓ WIRED | Child env is an allowlist (PATH, HOME) |
| `http.test.ts` gate | 401 before runner/audit | token gate in `server.ts` | ✓ WIRED | Test asserts 401, zero runner calls, zero audit records |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `.planning/milestones/v1.3-REQUIREMENTS.md` | 108-112, 215-219 | DESK-01..05 still `[ ]` / `Pending` | ℹ️ Info | Documentation drift in the archived milestone. The roadmap and PROOF record the phase as complete with a live-gated remainder. Not a code gap. |
| `packages/mcp-server/src/desktop/*.ts`, `infra/desktop/substrate-desktop.sh`, `scripts/desktop-smoke.ts` | — | Debt-marker scan (TODO/FIXME/XXX/HACK/PLACEHOLDER) | ✓ None | Only `mktemp` template `XXXXXX` matched in the shell script |

No stubs found. Desktop code paths all produce real results and are covered by behavioral tests.

### Human Verification Required

### 1. Live proof chain (DESK-05 / criterion 5)

**Test:** From the repository root, run `bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp`, then `bun run smoke:desktop --name p30`, then `bun run check:phase-close`, then `bun run rehearsal down --name p30`.
**Expected:** The marker run is accepted and its returned screenshot's band pixels (≥ 1500) appear in the block and not in the baseline. Block, stored file and event sha256 match per shot. Five `tool.call` rows exist under `desktop:<run_id>` with hashes only. The unlisted token is refused with no new row. A no-token request and a port-6081 request without credentials both return 401. `recruitment-desktop` inspect output is identical before and after.
**Why human:** It drives the live `substrate-desktop` display (keystrokes and captures) and needs a running rehearsal stack. Source and unit tests cannot show the pixels. `30-PROOF.md` and `30-N1-SPIKE.md` record these checks as NOT-RUN.

### 2. Live container state (criterion 4, advisory)

**Test:** On the host, run `sudo infra/desktop/substrate-desktop.sh status`.
**Expected:** `running=true`, `ports=127.0.0.1:6081->3000/tcp`, `privileged=false`, `docker_socket_mounted=false`, `geometry=1280x800`, `label_role=desktop`.
**Why human:** The gates are proven against stubbed docker, but the live container was not inspected.

## Gaps Summary

No gaps. Criteria 1–4 are verified in source and by a passing targeted test run (115 + 6 tests). Criterion 5 is classified human_needed because its only evidence is a live display run that was never executed (`30-PROOF.md`: NOT-RUN). The status is therefore `human_needed`, not `gaps_found`.

---

_Verified: 2026-11-18T12:23:16Z_
_Verifier: Claude (gsd-verifier)_
