---
phase: 30-desktop-run
verified: 2026-10-10T22:40:46Z
status: passed
score: 12/12 must-haves verified
covered_files: [".planning/phases/30-desktop-run/30-01-PLAN.md", ".planning/phases/30-desktop-run/30-01-SUMMARY.md", ".planning/phases/30-desktop-run/30-02-PLAN.md", ".planning/phases/30-desktop-run/30-02-SUMMARY.md", ".planning/phases/30-desktop-run/30-03-PLAN.md", ".planning/phases/30-desktop-run/30-03-SUMMARY.md", ".planning/phases/30-desktop-run/30-04-PLAN.md", ".planning/phases/30-desktop-run/30-04-SUMMARY.md", ".planning/phases/30-desktop-run/30-05-PLAN.md", ".planning/phases/30-desktop-run/30-05-SUMMARY.md", ".planning/phases/30-desktop-run/30-06-PLAN.md", ".planning/phases/30-desktop-run/30-06-SUMMARY.md", ".planning/phases/30-desktop-run/30-07-PLAN.md", ".planning/phases/30-desktop-run/30-07-SUMMARY.md", ".planning/phases/30-desktop-run/30-CONTEXT.md", ".planning/phases/30-desktop-run/30-N1-SPIKE.md", ".planning/phases/30-desktop-run/30-PATTERNS.md", ".planning/phases/30-desktop-run/30-PROOF.md", ".planning/phases/30-desktop-run/30-RESEARCH.md", ".planning/phases/30-desktop-run/30-VALIDATION.md", ".env.example", "README.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/runbooks/desktop.md", "infra/desktop/substrate-desktop.sh", "package.json", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/desktop/actions.test.ts", "packages/mcp-server/src/desktop/actions.ts", "packages/mcp-server/src/desktop/config.test.ts", "packages/mcp-server/src/desktop/driver.test.ts", "packages/mcp-server/src/desktop/driver.ts", "packages/mcp-server/src/desktop/png.test.ts", "packages/mcp-server/src/desktop/png.ts", "packages/mcp-server/src/desktop/tool.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/rehearsal-env.test.ts", "packages/mcp-server/src/rehearsal-env.ts", "packages/mcp-server/src/service.ts", "scripts/desktop-smoke.test.ts", "scripts/desktop-smoke.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts", "scripts/substrate-desktop.test.ts"]
covered_digest: "v3:sha256:6a3afd94017115d9d32a15ee26337bfe2c9c1d8e97cf05d66144ff5adfe9770e"
behavior_unverified: 2
overrides_applied: 0
---

# Phase 30: desktop_run Verification Report

**Phase Goal:** An authenticated agent can drive the dedicated webtop desktop and see the result, through a closed vocabulary that leaves an audit trail and exposes nothing else on the host.
**Verified:** 2026-10-10 at main tip `1dd3d1f` (origin synced, `git pull --ff-only` clean).
**Status:** passed-with-gated-remainder — 12/12 provable must-haves verified; the two
behaviours that need the live display (pixel proof chain, N1 ladder) are recorded
NOT-RUN with verbatim operator procedures and were never executed or faked.
**Scope:** in-repo only (DESK-01..DESK-05 rehearsal half). Live webtop driving is
operator-gated per the v1.3 run rules and the 30-07 live-step policy.
**Base:** phase-30 merge `b16a766` (PR #31 squash, DESK-01..DESK-05) plus phases 26–29;
`packages/mcp-server/src/desktop/` is byte-identical between the merge and this tip.

## Executed plans

| Plan | Commit(s) | Outcome |
|------|-----------|---------|
| 30-01 desktop driver + codec | feb31ab, bf57b35, 59e20dd | Six locked deltas ported; actions/driver/png + tests |
| 30-02 allowlist + dir config | d30f7e2, 29f1858, c8190f2 | `desktopSurfaces`/`desktopDir`, warnings sibling, absolute-dir rule |
| 30-03 lifecycle script | 15c5a77, 4f05d2c, b66798b | `substrate-desktop.sh` ported, gates + argv pinned |
| 30-04 MCP registration | b5369db, 3087799, 5bd1d69, fccbfb7 | `desktop_run` registered, refusal matrix proven |
| 30-05 harness flag | c589e01, acab493, 85f42ed | `--desktop-surfaces` flag + env, subset guard |
| 30-06 N1 spike | 875bfad | Ladder + NOT-RUN verdicts; explicit no-change (status: blocked by live-gate, by design) |
| 30-07 smoke + proof + docs | 0e7b951, 2848d94, 1ed425c | Smoke client + 24 helper tests, PROOF with NOT-RUN fields, runbook + audit mark |
| Greptile r1 + docker refusal | 3a14051, ef61ea2 | Review threads addressed; non-local engine refused |
| Greptile r2 + mutex + socket | 76c8f46, e86de3d, ba233b1 | Second-round findings, OS-held port mutex, accepted-socket sink |
| Merge | b16a766 | PR #31 squash-merged; all of the above in main |

No plan was re-run for this verification (#2868): 30-07 already carries a complete
SUMMARY; 30-06 is intentionally `status: blocked` (live-gated spike record, not a failure).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | DESK-01 vocabulary: only click/type/key/screenshot, ≤ 50 actions, 1–120 s timeout, fixed `docker exec` argv, `--`, no shell | ✓ VERIFIED | `actions.test.ts` 10/10 pass (vocabulary, limits, argv table, bounds refusal) |
| 2 | DESK-01 pixels: XWD 24/32 bpp decode, PNG encode/decode round trip | ✓ VERIFIED | `png.test.ts` 6/6 pass |
| 3 | DESK-01 driver: one run at a time (OS-held port mutex), deadline budgets, 0600/0700 modes, retention 200 runs / 7 d, child env PATH/HOME only | ✓ VERIFIED | `driver.test.ts` 24/24 pass; mutex + socket-sink fixes in-tree |
| 4 | DESK-01 tool shape: text block + MCP image blocks, strict schema | ✓ VERIFIED | `tool.test.ts` 10/10 pass (in-memory MCP) |
| 5 | DESK-02 events: one `tool.call` per executed action; typed text as length + sha256 only; image bytes never in events; refusals/not-started actions emit nothing; `stored:false` stops | ✓ VERIFIED | `driver.test.ts` event block + `http.test.ts` audit cases; 84/84 http pass |
| 6 | DESK-02 audit: record holds arg keys + digest only, no typed text, no `iVBOR`; `desktop_run` fail-closed in policy | ✓ VERIFIED | `policy.test.ts` fail-closed pin + `mcp-audit.md` fail-closed row names `desktop_run` (2 mentions); `check:phase-close` pass |
| 7 | DESK-03 allowlist: `SUBSTRATE_DESKTOP_SURFACES` parsed to a set, unknown names dropped + warned by name, empty means nobody; unlisted-valid-token, anonymous and VM-guest refusals each tested | ✓ VERIFIED | `config.test.ts` 6/6 (parsing, warnings, absolute-dir) + `tool.test.ts` refusals + `http.test.ts` guest 401s |
| 8 | DESK-04 lifecycle: `up` only with ≥ 10 GiB free, `--pull never`, loopback 6081 behind basic auth, unprivileged, no Docker socket, non-local engine refused, `recruitment-desktop` never touched | ✓ VERIFIED | `substrate-desktop.test.ts` 21/21 pass (PATH-stub gates + argv) incl. non-local-engine refusal |
| 9 | DESK-05 harness: `--desktop-surfaces` subset-guarded, `SUBSTRATE_DESKTOP_DIR=<runDir>/desktop` | ✓ VERIFIED | `rehearsal-env.test.ts` 30/30 + `rehearsal.test.ts` flag cases |
| 10 | DESK-05 smoke helpers: nonce channel ≥ 0xC0, marker parses under `DesktopRunInput`, exact-RGB band finder, guards refuse production ports and non-loopback; hermetic refusal probes exit 2 with zero requests sent | ✓ VERIFIED | `desktop-smoke.test.ts` 24/24 pass; three exit-2 probes recorded in 30-PROOF.md §1 |
| 11 | D30-21 docs: README `## Desktop` prose + runbook (allowlist, lifecycle, auth file by path, retention incl. September-PNG note, hashing rule, never-type-secrets, egress/timeout residuals, rollback, ownership) + audit landed mark; `desktop.action` named as a kind nowhere in docs | ✓ VERIFIED | `grep -c desktop_run` README 1 / runbook 6 / mcp-audit 2; `desktop.action` appears in docs only as a payload/source-row name, and in code only as the `event-sources.ts` row mapped to the existing `tool.call` kind |
| 12 | DESK-05 proof record: chain implemented as code (`rehearsal up` → `smoke:desktop` → `check:phase-close` → `rehearsal down`), every live verdict field NOT-RUN with procedure, no gap claimed without ladder evidence (D30-18) | ✓ VERIFIED | `30-PROOF.md` (band/sha/event/audit/refusal/6081/inspect/status fields all NOT-RUN; hermetic numbers observed); `30-N1-SPIKE.md` five-step ladder with preconditions |

**Score:** 12/12 truths verified.

### Behavior Not Verified

- **Live pixel proof chain (DESK-05 live half, operator gate).** No headless session has
  driven the real `substrate-desktop` display, so `band_pixels`, the three sha256
  equalities, the 5/5 `tool.call` rows, audit silence on live records, the unlisted/no-token
  live refusals, the 6081 401 line, the before/after `recruitment-desktop` inspects and the
  status key lines stay **[UNVERIFIED]**. Procedure recorded verbatim in `30-PROOF.md` §2;
  not run here, never simulated.
- **N1 capture-path ladder (30-06, operator gate).** The five-step spike (as-ported path,
  delayed second capture, stacking/map check, `xrefresh` candidate, September layout) needs
  the live X display; verdict fields (`n1_reproduced`, `capture_path`, `settle_ms`, timings,
  steal) stay **[UNVERIFIED]**. Until it runs, the smoke reports a gap rather than a pixel
  pass if the band is absent (D30-18). Recorded verbatim in `30-N1-SPIKE.md`; not run here.

## Gate Evidence

| Gate | Result |
|---|---|
| `git pull --ff-only` | Already up to date (origin synced, HEAD `1dd3d1f`) |
| `bunx tsc --noEmit` | exit 0, clean |
| full `bun test` | 2891 pass / 58 skip / 1 fail (109 files) — the 1 fail is the known pre-existing environmental `scripts/rehearsal.test.ts` `--port 7410` guard-order assertion (F-01 baseline; fails identically on main without this phase) |
| desktop suites | actions 10, png 6, driver 24, tool 10, config 6, smoke 24, substrate-desktop 21 — 101/101, 0 fail |
| http + rehearsal-env | 84 + 30 pass, 0 fail |
| `bun run check:phase-close` | pass — 4 lock files green; EVENT_KINDS 12, SURFACES 27 |
| `pytest` | 230 passed |
| PR #31 | squash-merged as `b16a766`; Greptile reviews COMMENTED (two rounds, all threads addressed in-tree: r1 `3a14051`, docker refusal `ef61ea2`, r2 `76c8f46`, port mutex `e86de3d`, socket sink `ba233b1`); phase-30 branch fully superseded, no follow-up PR (all phase-30 files byte-identical main-vs-branch) |

### Post-merge drift review (`b16a766..1dd3d1f`)

Fourteen covered files changed after the phase-30 merge (phases 25–29): `service.ts`
+1531/−5 (docs commands, Hindsight recall merge), `config.ts` +227 (token-config refactor,
SOLANA_*, ingest roots), `mcp.ts` +137 (`memory_recall`, recall merge), `http.test.ts` +79,
`package.json` scripts (later-phase smokes), plus `.env.example`, `event-sources.ts`,
`index.ts`, `observe.ts`, `rehearsal-env.ts`, `rehearsal.test.ts`. Desktop-related drift
lines are import/adjacency-only (e.g. `desktop_run` listed beside new tool names, `DesktopDriver`
import lines re-sorted); zero changed lines alter a desktop code path, and
`packages/mcp-server/src/desktop/` is byte-untouched. All phase-30 unit pins re-proven
green at this tip (101/101 desktop, http 84, rehearsal-env 30, phase-close pass, tsc clean,
pytest 230). Full suite matches the 2891/58/1 line (baseline growth is later-phase tests).

## Review

- **Code review (self):** 0 critical. The drift diff was read in full: additive later-phase
  commands and recall-merge only; no desktop line altered. The recorded 30-06 no-change
  decision stands (no capture fix without spike evidence).
- **Security review:** fixed `docker exec` argv, no shell, child env PATH/HOME only;
  bearer tokens read from harness token files, never printed (smoke output hashes/sizes/counts
  only — T-30-05); 6081 check expects 401 without reading the env file (T-30-08);
  `recruitment-desktop` inspect-only fixed argv (T-30-12); egress accepted by design,
  loopback-only (T-30-07); screenshots under run dir, removed at teardown (T-30-06); no new
  dependency (T-30-SC). No `GREPTIME_` outside the MCP package, no token literals, no second
  redactor, no new EVENT_KINDS/SURFACES entries (phase-close pins both).
- **Nyquist validation:** every requirement-level behaviour has an automated command that
  passed, except the two operator-gated behaviours above, recorded as DEFERRED with per-step
  gates — no silent pass.

## Operator Steps Recorded

Production allowlist + restart deferred to an operator-approved window after merge (see
`docs/runbooks/desktop.md`): set `SUBSTRATE_DESKTOP_SURFACES` in the service environment
(code default empty = nobody; runbook suggests `omp` as first entry), restart production
onto this code; Phase 20 production tokens are the prerequisite for any non-anonymous
production caller. First production run prunes the old September run PNGs (operator already
accepted copying the evidence PNGs aside). No secret value recorded anywhere: file paths and
variable names only.

## Verification path (close-out)

Path A (verify-resume): all seven PLANs carry SUMMARYs (30-06 intentionally
`status: blocked` — a live-gated spike record, counted as executed), code merged via
PR #31 (`b16a766`, ancestor of HEAD), no prior VERIFICATION.md. Per close-out rules no plan
was re-run (#2868): gates only, live steps recorded verbatim, never run. Digest
`v3:sha256:6a3afd…fe9770e` fingerprints the 50 covered files at this tip.

## OPERATOR APPROVAL NEEDED

The following gated steps were recorded verbatim from the phase plans and have NOT been
executed. Each needs explicit operator approval:

- **Live proof chain (30-07 task 2 / 30-PROOF.md §2):** with the labelled
  `substrate-desktop` container up on `127.0.0.1:6081`, run in order
  `bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp`,
  then `bun run smoke:desktop --name p30`, then `bun run check:phase-close`, then
  `bun run rehearsal down --name p30`, and fill the NOT-RUN verdict fields with the
  observed numbers — or a stated gap per D30-18 if the band is stale. (drives the shared
  display with keystrokes + captures; scrubs harness containers on teardown; rollback:
  `rehearsal down` removes the run dir)
- **N1 spike ladder (30-06 / 30-N1-SPIKE.md steps 1–5):** execute the ladder against the
  local container (as-ported capture, delayed second capture, stacking/map/workspace check,
  `xrefresh` candidate, September layout) and fill `n1_reproduced`/`capture_path`/`settle_ms`/
  timings/steal. (reads the live X display; rollback: none — read-only probes plus one
  marker run inside the dedicated container)
- **Production allowlist + restart:** set `SUBSTRATE_DESKTOP_SURFACES` in the production
  service environment and restart production onto this code. (production change; rollback:
  unset the variable → every call refused)
- **Optional `claude -p` session:** a model-driven session with the allowlisted token as an
  extra proof. (spends model quota; rollback: none)
