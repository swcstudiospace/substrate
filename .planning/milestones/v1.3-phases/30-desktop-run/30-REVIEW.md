---
phase: 30-desktop-run
reviewed: 2026-10-11T00:00:00Z
depth: standard
files_reviewed: 22
files_reviewed_list:
  - packages/mcp-server/src/desktop/actions.ts
  - packages/mcp-server/src/desktop/png.ts
  - packages/mcp-server/src/desktop/driver.ts
  - packages/mcp-server/src/desktop/actions.test.ts
  - packages/mcp-server/src/desktop/driver.test.ts
  - packages/mcp-server/src/desktop/tool.test.ts
  - packages/mcp-server/src/config.ts
  - packages/mcp-server/src/service.ts
  - packages/mcp-server/src/mcp.ts
  - packages/mcp-server/src/index.ts
  - packages/mcp-server/src/observe.ts
  - packages/mcp-server/src/event-sources.ts
  - packages/mcp-server/src/rehearsal-env.ts
  - scripts/rehearsal.ts
  - scripts/desktop-smoke.ts
  - infra/desktop/substrate-desktop.sh
  - docs/event-vocabulary.md
  - docs/runbooks/desktop.md
  - docs/mcp-audit.md
  - README.md
  - .planning/phases/30-desktop-run/30-N1-SPIKE.md
  - .planning/phases/30-desktop-run/30-PROOF.md
findings:
  critical: 0
  warning: 0
  info: 5
  total: 5
status: issues_found
---

> Recovered 2026-10-29 from an uncommitted worktree of branch swarm/v13-autonomous-integration (HEAD 76a4b2c3).
> Written 2026-10-11 to 2026-10-12 during the v1.3 autonomous integration; it describes that run and was not re-verified against main.
> Its paths and line references point at the 2026-10-11 tree, not at main.

# Phase 30: Code Review Report

**Reviewed:** 2026-10-11T00:00:00Z — final re-audit (static only, no checks
run) over the corrected sources plus parent's green evidence.
**Depth:** standard (per-file reads plus cross-file tracing of the
driver→service→mcp→audit chain and the smoke→ledger→audit battery)
**Files Reviewed:** 22
**Status:** issues_found (5 info; no blockers, no warnings)

## Summary

Reviewed the DESK-01..05 static surface: the closed action vocabulary and
fixed argv (`actions.ts`), the XWD/PNG codec (`png.ts`), the executor with
its child-env allowlist, budgets, busy mutex and event emission
(`driver.ts`), the allowlist/dir config gate (`config.ts`, `index.ts`), the
six-step refusal order (`service.ts`), the strict-schema tool registration
(`mcp.ts`), the `KNOWN_TOOLS` entry (`observe.ts`), the corrected
`desktop.action` sample (`event-sources.ts`, `event-vocabulary.md`), the
harness flag (`rehearsal-env.ts`, `rehearsal.ts`), the lifecycle script
(`substrate-desktop.sh`), the headless proof client (`desktop-smoke.ts`),
and the landing docs (runbook, `mcp-audit.md`, `README.md`).

The security-critical paths hold: fixed `EXEC` prefix on every action argv
with `type` text after `--`; child env is PATH/HOME only; `failure()` and
`bufferRunner` never echo stderr/argv into stored events; per-action payloads
carry lengths plus hashes with the tightened key rule pinned both verbatim
and hashed in `driver.test.ts`; screenshots travel only in the tool reply;
`stored:false` stops the run with no image blocks; audit records carry keys
plus digest with a fail-closed assertion in the smoke; the lifecycle script
names only `substrate-desktop`, refuses remote docker endpoints, and keeps
the auth file at 0600 with the password never echoed.

Final re-audit confirms the two corrections that closed the earlier gaps:
the driver locality preflight now fails closed on unknown, failed, empty,
timed-out and non-local probes (each pinned with calls limited to the probe
argv and zero events), and the lifecycle `require_local_docker` dies on
inspect failure under a 10 s bound instead of proceeding. The
`snapshotRecruitment` present/absent/error triple is fail-closed as read
(any `error` never equals any state, including itself).

No source files were modified by this review. No tests, builds, lints,
gates, or live runs were executed by this review — static reading only, per
the role contract. All gate numbers below are parent-observed evidence
repeated from the cited records, not exercised here.

## Live and gate evidence on record (read, not exercised by this review)

- **30-PROOF.md §2: corrected real-runtime proof PASSED 20/20,
  2026-10-11.** Named twin `v13-proof-230c1bd0` (`omp` allowlisted,
  `cursor` unlisted): band 9120 px solid 480x19 with baseline 0 in the
  returned block; 2/2 PNG blocks decoded with block=file=event sha match
  (stored sizes 532677 and 325285 bytes); 5/5 stored `tool.call` rows with
  hashes only; unlisted-token refusal with surface events 5→5; tokenless MCP
  401 and unauthenticated-6081 401; 2 fail-closed content-free audit
  records; `recruitment_snapshot=absent→absent` on a successful exact-name
  inventory; desktop status loopback/unprivileged/no-socket/role-desktop.
  Up, proof and down each exited 0; two owned store containers removed;
  every proof-owned terminal closed; dedicated desktop left running.
- **30-PROOF.md §3 preserves the first run as FAILED 18/20** (old
  null-on-error snapshot conflated legitimate absence with probe failure).
  It is kept as a FAIL, not renamed — the 20/20 is a separate observed run.
- **30-N1-SPIKE.md: `n1_reproduced=false`.** Three measured as-ported
  XWD→PNG repeats, each 9120 solid px / baseline 0, with per-call timings
  and host steal sampled (0–9.15%). No capture fix applied; `actions.ts` /
  `driver.ts` unchanged — consistent with the code as read. No title-based
  pass anywhere.
- **Final source-union gates** per `local://v13-final-green-evidence.json`
  (worktree rev `4df30a0` plus owned corrections): full suite 2719 pass /
  58 skip / 0 fail across 96 files; `tsc` exit 0; phase-close 108/0/0 with
  `EVENT_KINDS=12`, `SURFACES=27`; `bash -n` and `shellcheck` exit 0.
- **Scope boundary:** parent records no production MCP request, model turn,
  credential read/rotation, service restart, main merge, or unrelated
  container change. This review fabricates none: no production or model
  evidence is claimed here.

## Pending (not findings — phase owner seals)

- Corrected sources are still pending commit (dirty worktree at re-audit);
  the seal belongs to the phase owner after the native
  review/security/Nyquist/goal-verification reports are all current.
- Phase 20 production identity/client/UAT checkpoints and the exposed
  Cursor credential's operator rotation remain pending per 30-PROOF.md §4;
  this Phase 30 review closes no identity or milestone scope.

## Info

### IN-01 (ex-WR-01, downgraded): `contextArgv()` absent from the actions-level builder table

**File:** `packages/mcp-server/src/desktop/actions.test.ts:75-114`
**Reassessment:** Downgraded — no pin demanded. The fixed-argv safety of the
locality probe is proven behaviorally at the consumer level: the
fail-closed preflight describes assert exact argv (`calls` equal to
`[contextArgv()]` plus geometry sequencing) and pin refusal-before-input
for every probe outcome (`driver.test.ts:415-518`: non-local, failed,
unknown, empty, timed-out, each with zero events and zero emit calls). An
actions-level snapshot row would duplicate that pin, not fix a consumer bug.
Residual observation only: the "every builder" wording of the table test is
stale now that a seventh builder exists.

### IN-02 (ex-WR-02, downgraded): pre-input refusal wording consistency

**Files:** `packages/mcp-server/src/desktop/driver.ts` (bounds/locality/
geometry/lock throws), `packages/mcp-server/src/service.ts:738-767`
**Reassessment:** Downgraded — no wording change demanded. Exact "nothing
was run" wording must not become a permanent wording test, and early
PRE-INPUT failures versus after-partial-run failures are distinguished by
effect assertions that already exist (bounds: calls limited to probe plus
geometry with zero events; locality: calls limited to the probe with zero
emit calls). No action required; any future message-clarity work must stay
grounded in those no-effect assertions.

### IN-03: Live smoke accepts any key-payload form for the key row

**File:** `scripts/desktop-smoke.ts` (`expectedDigest` / `eventsOk` check)
**Issue:** For the `key` action row the smoke accepts whatever payload shape
arrives (`return expected.action === "key"`), without asserting the tightened
D30-11 form. The unit level pins both directions (`driver.test.ts:104-232`:
`ctrl+alt+t` verbatim, `shift+a`/`KP_1`/`space` hashed), so this is a
proof-strength gap only, and the dump-wide `dumpedHoldsTyped` plus `iVBOR`
scans still catch actual content leaks. With the fixed `ctrl+alt+t` chord the
dangerous regression direction cannot manifest through this chord.
**Fix (optional, owner's call):** assert the key row carries the verbatim
form, e.g.
```ts
if (expected.action === "key" && "keys" in payload && payload.keys === "ctrl+alt+t") return true;
```

### IN-04: Refusal-clean event comparison is bounded by `limit: 100`

**File:** `scripts/desktop-smoke.ts` (`queryDesktopIds`)
**Issue:** The unlisted-token probe proves "no new event" by comparing the
surface's `desktop_run` id lists before and after, but the query caps at
`limit: 100` oldest-first. Past 100 stored rows the comparison still passes
while a wrongly-run action hides beyond the window. Harmless in practice —
each proof runs against a fresh harness ledger with a handful of rows — but
the check degrades silently on a reused instance.
**Fix (optional):** fail the check (rather than compare) when either list
reaches the limit, or page the query.

### IN-05: Two small edge-message delays, no behavior impact

**Files:** `packages/mcp-server/src/desktop/driver.ts`
(`readDesktopIdentity`), `infra/desktop/substrate-desktop.sh` (`cmd_up`)
**Issue:** (a) A cross-process busy refusal waits up to
`LOCK_IDENTITY_TIMEOUT_MS` (2 s) for the holder to name its run, so "refused
at once" (D30-08) is really "within ~2 s" on the contended path; a null
identity then names run `unknown`. (b) In `cmd_up`, if `df` fails the
`avail` variable is empty/non-numeric and `[ "$avail" -ge ... ]` exits via
`set -e` with a test-error line instead of the `die` message. Both are
fail-closed and cosmetic.
**Fix (optional):**
```sh
case "$avail" in ''|*[!0-9]*) die "could not read free disk space";; esac
```

---

_Reviewed: 2026-10-11T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer, Phase30NativeReview)_
_Depth: standard_
