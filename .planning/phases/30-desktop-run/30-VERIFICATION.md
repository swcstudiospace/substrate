---
phase: 30-desktop-run
verified: 2026-10-11T00:00:00Z
status: passed
score: 5/5 must-haves verified
covered_files: [".planning/phases/30-desktop-run/30-01-PLAN.md", ".planning/phases/30-desktop-run/30-01-SUMMARY.md", ".planning/phases/30-desktop-run/30-02-PLAN.md", ".planning/phases/30-desktop-run/30-02-SUMMARY.md", ".planning/phases/30-desktop-run/30-03-PLAN.md", ".planning/phases/30-desktop-run/30-03-SUMMARY.md", ".planning/phases/30-desktop-run/30-04-PLAN.md", ".planning/phases/30-desktop-run/30-04-SUMMARY.md", ".planning/phases/30-desktop-run/30-05-PLAN.md", ".planning/phases/30-desktop-run/30-05-SUMMARY.md", ".planning/phases/30-desktop-run/30-06-PLAN.md", ".planning/phases/30-desktop-run/30-06-SUMMARY.md", ".planning/phases/30-desktop-run/30-07-PLAN.md", ".planning/phases/30-desktop-run/30-07-SUMMARY.md", ".planning/phases/30-desktop-run/30-CONTEXT.md", ".planning/phases/30-desktop-run/30-N1-SPIKE.md", ".planning/phases/30-desktop-run/30-PROOF.md", ".planning/phases/30-desktop-run/30-REVIEW.md", ".planning/phases/30-desktop-run/30-SECURITY.md", ".planning/phases/30-desktop-run/30-VALIDATION.md", "README.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/runbooks/desktop.md", "infra/desktop/substrate-desktop.sh", "package.json", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/desktop/actions.test.ts", "packages/mcp-server/src/desktop/actions.ts", "packages/mcp-server/src/desktop/config.test.ts", "packages/mcp-server/src/desktop/driver.test.ts", "packages/mcp-server/src/desktop/driver.ts", "packages/mcp-server/src/desktop/png.test.ts", "packages/mcp-server/src/desktop/png.ts", "packages/mcp-server/src/desktop/tool.test.ts", "packages/mcp-server/src/event-sources.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/rehearsal-env.test.ts", "packages/mcp-server/src/rehearsal-env.ts", "packages/mcp-server/src/service.ts", "scripts/desktop-smoke.test.ts", "scripts/desktop-smoke.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts", "scripts/substrate-desktop.test.ts"]
covered_digest: "v3:sha256:e7aa6dbbf4914d99cd871254e095ee24dff1a5fcfd0e0c03fd4403bdf739d965"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 30: desktop_run Verification Report

**Phase Goal:** An authenticated agent can drive the dedicated webtop desktop and see the result, through a closed vocabulary that leaves an audit trail and exposes nothing else on the host.
**Verified:** 2026-10-11T00:00:00Z
**Status:** passed
**Re-verification:** No — initial verification (no prior 30-VERIFICATION.md existed)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `desktop_run` accepts only click, type, key and screenshot, at most 50 actions, a 1–120 s timeout, a fixed `docker exec` argv and one run at a time; screenshots return as MCP image blocks and are kept at mode 0600 for 200 runs or 7 days (SC1 / DESK-01) | ✓ VERIFIED | `packages/mcp-server/src/desktop/actions.ts:9` fixed `EXEC = ["docker","exec","-e","DISPLAY=:1","substrate-desktop"]`; `:48-50` strict object, actions 1..50, timeout int 1..120 default 30; `:95,99,103` type text after `--`, key with `--clearmodifiers --`, xwd root capture; `driver.ts:74-92` child env PATH/HOME only, Buffer execFile, 16 MiB maxBuffer, never a shell; `:137-225` host-wide loopback mutex + module busy flag, finally release; `:243-255,404-412,483-484` generated run dir 0700, PNG files 0600, 200-run/7-day prune; `mcp.ts:948-957` success returns text plus PNG image blocks, unstored failure returns isError with no image blocks. Parent final gates 2718/58/0 (96 files), types 0 — `local://v13-final-green-evidence.json`. |
| 2 | Each action produces one event under an existing kind, typed text is recorded only as its length and sha256, and no image block enters the audit record (SC2 / DESK-02) | ✓ VERIFIED | `driver.ts:390-395,436-454` per-action `tool.call` emit with `text_len`/`text_sha256`, screenshot `sha256`/dims, tightened key rule (`:260-304` verbatim only for non-shift-modifier chords or fixed non-printing keys, else `keys_len`/`keys_sha256`); no title/path/image bytes in payload; `:85-92,232-240,414-418,452` fixed diagnostics, shared redact, 300-char event-error cap; `stored:false`/throwing emit stops run with no image blocks (`:410-413,436-464`); `observe.ts:322-346` `KNOWN_TOOLS` holds `desktop_run`; `packages/audit/src/record.ts:180-194,224-247` stores arg keys + canonical digest only; `policy.ts:29` `desktop_run` fail-closed; `http.test.ts:1763-1771` asserts exact submitted `arg_keys=['actions']` digest differs from empty-object digest with no typed text/base64. Parent proof: 5/5 hash-only ledger rows, 2 content-free fail-closed audit records (`30-PROOF.md` §2, `local://v13-final-runtime-evidence.json`). |
| 3 | `desktop_run` serves only operator-listed surfaces: unlisted-with-valid-token, anonymous, and VM-guest callers are each refused with a test for each, and it is fail-closed in audit policy (SC3 / DESK-03) | ✓ VERIFIED | `config.ts:367-377,416-419` empty allowlist means nobody, unknown names dropped; `service.ts:746-760` refusal order anonymous → unlisted → unwired → no-ledger → busy, each "nothing was run", operator authority never consulted; `mcp.ts:933-951` registers strict `DesktopRunInput` object itself (unknown `surface` key rejected, propose header ignored); `server.ts:400-410,463-467,850-870` bearer→surface before body, 401 before runner/audit, audit awaited before dispatch; `http.test.ts:1679-1747` real-HTTP 401 zero-run/zero-audit, valid-schema spoof/propose-header zero-execution/zero-events, operator-marked unlisted bearer refused zero-runner/zero-events; `tool.test.ts:139-300` MCP anonymous/unlisted/operator/no-ledger/unwired/busy refusals. Parent proof: unlisted-token isError refusal, tokenless MCP 401 (`local://v13-final-runtime-evidence.json` desktop block). Scope note: the smoke's 5→5 event comparison queries the LISTED surface only (`desktop-smoke.ts:789-797`, retained security limitation per 30-SECURITY.md) — authorization itself is proven by the real-HTTP zero-runner/zero-event tests above, not by the smoke query scope; no unlisted-surface query scope is claimed. |
| 4 | The lifecycle script runs the container only with ≥ 10 GiB free, `--pull never`, loopback port 6081 behind basic auth, unprivileged and without the Docker socket, and never touches `recruitment-desktop` (SC4 / DESK-04) | ✓ VERIFIED | `infra/desktop/substrate-desktop.sh:20-27` names only `substrate-desktop`, role label `org.swcstudio.substrate.role=desktop`, `PUBLISH=127.0.0.1:6081:3000`, `MIN_FREE_BYTES=10737418240`; `:53-67` auth env file generated once under umask 077, mktemp, chmod 600, rename, never echoed; `:76-105` bounded (timeout 10) positive local-endpoint gate with refusing failure branch before image/env-file/create/start; `:107-123` role-gated reuse, `--pull never`, loopback-only publish, named volume, no `--privileged`/socket/host-bind; `up`/`status` only — no `rm`/`stop`/`kill`/`pull`, no `recruitment` string in any recorded argv; `substrate-desktop.test.ts:175-415` PATH-stub assertions for all gates plus failed-locality refusal with no image/run/start/env-file. Parent proof: `status` shows ports 127.0.0.1:6081→3000, privileged=false, docker_socket_mounted=false, role desktop; unrelated desktop authoritative absent→absent, untouched. `bash -n` 0, `shellcheck` 0 per final green evidence. |
| 5 | A headless session's `desktop_run` returns a screenshot whose pixels show the typed marker, one event per action lands, and `recruitment-desktop` is untouched (SC5 / DESK-05) | ✓ VERIFIED | `scripts/desktop-smoke.ts` scripted raw-JSON-RPC MCP session with harness allowlisted token, no model (tool-call timeout = run timeout + 60 s, above the 120 s ceiling); nonce-RGB marker (`nonceRgb` one channel ≥ 0xC0), `findBand` exact-RGB count/rect/solid, `BAND_MIN_PIXELS=1500`; asserts band in returned image block with baseline none, block=file=event sha equality, 5/5 stored `tool.call` rows with `text_sha256`, fail-closed content-free audit, unlisted isError + no-token 401 + credentialless-6081 401, unchanged unrelated-desktop snapshot (present/absent/error triple, probe error FAILs never absence), status lines. `30-N1-SPIKE.md`: three measured as-ported XWD→PNG repeats, each 9120 exact-RGB px / baseline 0 / solid 480×19, per-call timings + host steal 0–9.15%, `n1_reproduced=false`, no capture fix, `actions.ts`/`driver.ts` unchanged. `30-PROOF.md` §2: corrected separate parent run `v13-proof-230c1bd0` 20/20 exit 0 (band 9120/baseline 0/solid 480×19, 2 PNG blocks 532677+325285 bytes, 5 hash-only rows, 2 audit records, absent→absent, up/proof/down each exit 0, 2 owned stores removed, all owned terminals closed, dedicated desktop left running). First run 18/20 exit 1 preserved as FAIL (§3), never renamed. Observed PNG visual is the marker band only; no production MCP request, model turn, or quota spent. |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/desktop/actions.ts` | Closed vocab, strict schema, fixed argv | ✓ VERIFIED | Strict 4-action object, 1..50, timeout 1..120 dflt 30; EXEC prefix; text/key terminators; geometry/bounds |
| `packages/mcp-server/src/desktop/png.ts` | XWD decode / PNG encode | ✓ VERIFIED | Ported codec; independent-RGB/CRC/filter assertions in `png.test.ts:53-147` per VALIDATION |
| `packages/mcp-server/src/desktop/driver.ts` | Executor: env allowlist, budgets, mutex, events, locality fail-closed | ✓ VERIFIED | PATH/HOME-only child env; locality probe `:353-360` rejects timeout/nonzero/empty/non-unix before geometry/input/capture/events; hash-only payloads; stop-on-unstored; retention |
| `packages/mcp-server/src/desktop/actions.test.ts` | Schema/argv/bounds coverage | ✓ VERIFIED | `:21-107` strict schema, text/key grammar, option-text after `--`, no-shell, display edges |
| `packages/mcp-server/src/desktop/driver.test.ts` | Driver behavior coverage | ✓ VERIFIED | Locality refusals `:415-531` with zero events; mutex/release `:702-805`; deadline `:230-249,606-648`; privacy `:104-241,549-580,653-672` |
| `packages/mcp-server/src/desktop/tool.test.ts` | MCP gate coverage | ✓ VERIFIED | Strict/refusal/no-ledger/unwired/busy `:139-362`; operator-unlisted refused; image/digest equality |
| `packages/mcp-server/src/desktop/config.test.ts` | Allowlist parsing | ✓ VERIFIED | Fail-closed empty/valid/unknown, name-only warnings, dir fallback/override |
| `packages/mcp-server/src/config.ts` + `index.ts` | `desktopSurfaces`/`desktopDir` + warnings wiring | ✓ VERIFIED | Parse `:367-377,416-419`; warnings `:648-665`; `index.ts:46-47` sibling wiring |
| `packages/mcp-server/src/service.ts` | `runDesktop` refusal order | ✓ VERIFIED | `:746-760` anonymous/unlisted/unwired/no-ledger/busy, "nothing was run" |
| `packages/mcp-server/src/mcp.ts` | Tool registration | ✓ VERIFIED | `:941-960` strict `DesktopRunInput`, image-block success, redacted ≤400 errors |
| `packages/mcp-server/src/observe.ts` | `KNOWN_TOOLS` entry | ✓ VERIFIED | `:346` `desktop_run`; audit-before-dispatch `:380-438` |
| `packages/mcp-server/src/event-sources.ts` + `docs/event-vocabulary.md` | Corrected `desktop.action` sample | ✓ VERIFIED | Sample/summary/session/click/key fields match D30-11 contract; kind/surface/tool/action unchanged |
| `packages/mcp-server/src/http.test.ts` | Real-HTTP gate tests | ✓ VERIFIED | `:1683-1771` 401s, spoof/header isolation, operator-unlisted refusal, exact arg digest |
| `packages/mcp-server/src/rehearsal-env.ts` + `scripts/rehearsal.ts` | `--desktop-surfaces` harness flag | ✓ VERIFIED | Subset-of-surfaces check, anonymous refusal, `SUBSTRATE_DESKTOP_SURFACES` + per-run `SUBSTRATE_DESKTOP_DIR` |
| `infra/desktop/substrate-desktop.sh` + `scripts/substrate-desktop.test.ts` | Lifecycle + hermetic tests | ✓ VERIFIED | Gates/argv above; stub-PATH tests, syntax + shellcheck 0 |
| `scripts/desktop-smoke.ts` + `scripts/desktop-smoke.test.ts` | Headless proof client + helper tests | ✓ VERIFIED | D30-19 battery; nonce/marker/band/guard/envelope tests; snapshot present/absent/error triple |
| `docs/runbooks/desktop.md` + `README.md` + `docs/mcp-audit.md` + `package.json` | Docs + smoke script entry | ✓ VERIFIED | Runbook (allowlist, lifecycle, auth path-only, retention, hashing + never-type-secrets, egress/timeout/50-shot residuals, rollback); README prose; audit fail-closed mark; `smoke:desktop` |
| `30-N1-SPIKE.md` + `30-PROOF.md` | Spike verdict + proof record | ✓ VERIFIED | 3/3 fresh-as-ported repeats; corrected 20/20 + preserved 18/20 FAIL |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| `driver.ts` | `png.ts` + `redact.ts` | imports `decodeXwd`/`encodePng`, shared `redact` (single redactor) | WIRED | Source imports read; redact-lock forbids a second redactor |
| `driver.ts` run() | `Substrate.emit` | per-call `emit` param, `stored` read | WIRED | `service.ts` passes `Substrate.emit`; `stored:false` stops run |
| `config.desktopSurfaces` | `service.ts runDesktop` | gate reads set | WIRED | Refusal order verified by T/H tests |
| `desktopConfigWarnings` | `index.ts` boot | concatenated beside swarm warnings | WIRED | Token-free name-only warnings |
| `mcp.ts` handler | driver result | refused→refusal, failed→isError json, success→text+image blocks | WIRED | Image/error boundaries tested |
| `rehearsal.ts runUp` | `buildRehearsalEnv` | `desktopSurfaces` passthrough; runDir desktop dir | WIRED | Harness env round-trip tested |
| `desktop-smoke.ts` | twin `/mcp` + ledger + audit file | raw JSON-RPC, `POST /events/query`, audit JSONL scan | WIRED | Parent 20/20 run exercised the full chain |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `driver.ts` screenshot | PNG bytes | `xwd -root -silent` via fixed argv → `decodeXwd`/`encodePng` | Yes — parent 9120-px marker band decoded from returned block, block=file=event sha | ✓ FLOWING |
| `driver.ts` events | `tool.call` rows | `emit()` per executed action with length/hash payloads | Yes — 5/5 stored rows, `text_sha256` = typed-text sha | ✓ FLOWING |
| `mcp.ts` reply | image blocks | driver `images[]` | Yes — 2 PNG blocks returned; cleared on unstored failure | ✓ FLOWING |
| `observe.ts` audit | `desktop_run` records | `auditToolCalls` before dispatch, keys + digest | Yes — 2 fail-closed content-free records | ✓ FLOWING |

### Behavioral Spot-Checks

Step 7b: SKIPPED by role contract — verifier runs no tests/builds/gates/scripts (parent-owned execution only). Behavioral evidence is parent-observed and attributed: N1 three as-ported repeats (9120/0/solid 480×19 each, timings + steal sampled, `local://v13-phase30-spike-evidence.json`), corrected desktop proof 20/20 exit 0 (`local://v13-final-runtime-evidence.json`, `30-PROOF.md` §2), final source-union gates 2718/58/0 + types 0 + locks 108/0/0 + shell 0 (`local://v13-final-green-evidence.json`, latest actually-exercised count after tautology deletion; preceding 2719/58/0 is the real earlier run, not inferred).

### Probe Execution

No phase-declared `probe-*.sh` paths exist for Phase 30; conventional `scripts/*/tests/probe-*.sh` absent. Not applicable — DESK-05 proof route is `scripts/desktop-smoke.ts` (parent-executed 20/20, recorded above).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| DESK-01 | 30-01 | Closed vocab, 50-action cap, 1–120 s timeout, fixed argv, one-run mutex, PNG image blocks, 0600/200-run/7-day retention | ✓ SATISFIED | Truth 1; A/P/D1–D4; G1–G4 FILLED (VALIDATION) |
| DESK-02 | 30-01, 30-04 | One event per action under existing kind; text as length+sha256; no image in audit | ✓ SATISFIED | Truth 2; D1/D4/H/V/Q; G8 FILLED |
| DESK-03 | 30-02, 30-04 | Operator allowlist only; unlisted/anonymous/VM-guest refusals with a test each; fail-closed audit | ✓ SATISFIED | Truth 3; C/T/H/Q; G5–G6 FILLED |
| DESK-04 | 30-03 | Lifecycle: 10 GiB gate, `--pull never`, loopback 6081 + basic auth, unprivileged, no socket, never touches recruitment-desktop | ✓ SATISFIED | Truth 4; L; syntax/shellcheck 0 |
| DESK-05 | 30-05, 30-06, 30-07 | Isolated headless proof: pixels show marker, one event per action, recruitment-desktop untouched | ✓ SATISFIED | Truth 5; E/R/S/N; N1 3/3; corrected 20/20 |

No orphaned requirements: REQUIREMENTS.md maps exactly DESK-01..05 to Phase 30, and plans 30-01..30-07 claim all five (30-01: DESK-01/02; 30-02: DESK-03; 30-03: DESK-04; 30-04: DESK-01/02/03; 30-05/06/07: DESK-05).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | `TODO`/`FIXME`/`XXX`/`TBD`/placeholder/unstubbed-empty-return scan over `desktop/`, `desktop-smoke.ts`, `substrate-desktop.sh` | None found | `return null` hits are legitimate boundary-reader narrowing (`readBlock`/`readShot`/`readRow`/snapshot fns), not stubs; no debt markers, no new `refactor-deadline` preferences introduced |

### Native Gates (read, not run by verifier)

- **Review (30-REVIEW.md):** 22 files, 0 critical / 0 warnings / 5 infos, G1–G8 closed; static only.
- **Security (30-SECURITY.md):** SECURED — 28/32 closed, 16/16 high closed, 0 blocking open; 4 open non-blocking below-high proposed accepts WITHOUT approved acceptance record (T-30-07 medium egress, T-30-13 low post-timeout in-container input, T-30-30 medium 50-screenshot reply size, T-30-SC low supply-chain rationale). Former blockers T-30-01 (driver locality) and T-30-14 (lifecycle locality) closed in code with regression assertions. No risk accepted by the auditor.
- **Validation (30-VALIDATION.md):** GAPS FILLED, Nyquist-compliant for the local contract — 17/17 tasks mapped, G1–G8 FILLED with actual assertion ranges exercised by the parent final suite; incidental deletions reconciled without repinning; historical 18/20 preserved FAIL.
- **Source-union gates:** full suite **2718 pass / 58 skip / 0 fail** across 96 files (latest actually exercised; tautology deletion delta from the real earlier 2719/58/0), types exit 0, phase-close locks 108/0/0 across 4 files with EVENT_KINDS 12 / SURFACES 27, `bash -n` 0 / `shellcheck` 0, formatter none configured and none claimed.

### Explicit Operator / Follow-On Limits (not Phase 30 gaps)

- Phase 20 production identity/allowlist/client/UAT checkpoints and the exposed Cursor credential's operator rotation remain pending and operator-owned; local proof closes none of them.
- Deliberately operator-owned follow-ons stay explicit per existing plans: 21 real-GH first PR belongs to 22; 27 v1.14 deploy/devnet belongs to 28; 30 production identity belongs to 20. Not scope shrink.
- Residuals documented in runbook, not newly fixed and not blocking under the high threshold: unsalted short-value hash inference warning, bridge egress, stale in-container work after client timeout, uncapped 50-screenshot reply size.
- Dirty integration source provenance: final receipts describe owned corrections pending commit at execution — not a main-merge, release, or deployment receipt. No ROOT state/ROADMAP/REQUIREMENTS completion claimed; Phase 20 is NOT called complete.

### Gaps Summary

None. Every declared DESK-01..05 requirement and all five roadmap success criteria hold in current source with parent-observed behavioral evidence, all native gates current (review clean, security SECURED with only below-threshold unapproved proposes, validation GAPS FILLED), and the full 2718/58/0 + types + locks + shell gates green. The four below-high proposed accepts remain unapproved by design and stay below the configured high threshold — no fake closure.

---

_Verified: 2026-10-11T00:00:00Z_
_Verifier: Claude (gsd-verifier, Phase30GoalVerifier)_
