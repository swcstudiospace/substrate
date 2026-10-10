---
phase: 19-lane-b-collectors
reviewed: 2026-10-10T00:00:00Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - scripts/laneb-proof.ts
  - scripts/laneb-proof.test.ts
  - packages/collectors/src/emit.ts
  - packages/collectors/src/git-context.ts
  - packages/collectors/src/status.ts
  - packages/collectors/src/herdr.ts
  - packages/collectors/src/herdr-map.ts
  - packages/collectors/src/herdr-state.ts
  - packages/collectors/src/muse.ts
  - packages/collectors/src/cursor-stop.ts
  - packages/projector/src/muse.ts
  - packages/projector/src/cursor.ts
  - infra/vps/substrate-collector-herdr.service
  - infra/vps/substrate-collector-muse.service
  - infra/vps/substrate-collector-herdr.service.d/10-environment.conf
  - infra/vps/substrate-collector-muse.service.d/10-environment.conf
findings:
  critical: 0
  warning: 0
  info: 1
  total: 1
status: clean
---

# Phase 19: Code Review Report (iteration 2 — re-review)

**Reviewed:** 2026-10-10
**Depth:** standard
**Files Reviewed:** 16 (prior 15-file scope + `scripts/laneb-proof.test.ts` guard tests)
**Status:** clean

## Summary

Re-review of Phase 19 (Lane B collectors) at the prior standard depth, reconciling
all three actionable findings from the iteration-1 review against current source
plus the parent's final evidence (`local://v13-phase19-real-runtime-evidence.json`,
transcribed in `19-PROOF.md`) and the corrected `19-05-SUMMARY.md`.

All three actionable findings are **closed with exact source evidence** (details in
"Closed Findings" below). No new BLOCKER or WARNING was found in the re-reviewed
scope; the collector/hook implementation assessment from iteration 1 stands
unchanged. The one remaining item (IN-01) is the preserved no-fix cross-phase seam,
not a defect.

Scope and provenance notes (binding):

- Source was read only; no scripts, tests, builds, lint, smoke, gates, or
  formatters were run by this reviewer. All runtime tallies cited below
  (41/41 proof, 85/0 targeted, typecheck 0, 112 lock checks, 2670/58/0 suite)
  are parent-observed evidence from `local://v13-phase19-real-runtime-evidence.json`
  as transcribed in `19-PROOF.md` — not reviewer executions. No test is asserted
  run by this reviewer.
- This review makes **no** overall merge-ready claim, **no** signed security gate
  claim, and **no** manual-approval claim. Security ownership stays with the parent
  (`19-SECURITY.md`: 18 closed / 2 low OPEN non-blocking / 0 blocking-open at the
  high-severity gate). Final phase status, fingerprint, and verifier ownership stay
  with the parent.
- No source or shared artifact was edited. This `19-REVIEW.md` is the reviewer's
  only write.

## Closed Findings (iteration-1 reconciliation)

### CR-01 (CLOSED): LANEB-07 proof now implements the contracted real-runtime path

**Previously:** `scripts/laneb-proof.ts` served `session.snapshot` from a loopback
stub (`:202-227`) and spawned the hook file directly (`--bundle-only` + hand-built
fixture), while the summary claimed LANEB-07 sealed with "Known Stubs: None".

**Now verified in current source:**

- Real proof-named server: `scripts/laneb-proof.ts:418-427` spawns
  `herdr --session substrate-proof-<tag> server` on its own socket
  (`proofSock` under the proof-owned HOME), guarded by `isProofSession`
  (`:409-413`, refusal exit 2 for non-proof names).
- Real pane lifecycle via RPC: `workspace.create` (`:442`), `pane.report_agent`
  working (`:454`), own watching-collector stop/restart with saved v2 state
  between working and idle, `pane.report_agent` idle (`:486`), `pane.close`
  (`:498`) — all against `proofSock`, never the live default session.
- Real installed Muse path: scratch-HOME validate / install-or-update / approve /
  inspect (`:515-518` and following), installed redactor/config readback (`:584`),
  real installed hook-test CLI
  `museScratch(["plugins", "hook", "test", "substrate:post-tool-use", "--fixture", ...])`
  (`:589`), with the installed-config URL-equality guard
  `assertHookTarget(installedUrl, base)` refusing (exit 2, no request) before any
  hook execution (`laneb-proof.ts:138-141`, `:571-575`).
- Per-action ten-second visibility: each observation is measured from its own
  action timestamp — `tWorking` (`:453`) → `pollFor(..., tWorking)` (`:456-459`),
  `tIdle` (`:485`) → `pollFor(..., tIdle)` (`:488-491`), `tClose` (`:497`) →
  `pollFor(..., tClose)` (`:500-503`), `tHook` (`:588`) → `pollFor(..., tHook)`
  (`:611-614`) — via the remaining-deadline `pollFor` (`:110-117`).
- Guard-test pins: `scripts/laneb-proof.test.ts:5-10` (`remainingMs` ten-second
  budget), `:12-18` (`isProofSession` ownership incl. traversal rejection),
  `:20-27` (`assertHookTarget` mismatch/empty/smoke/non-loopback refusals),
  `:29-38` (`childEnv` strips `HERDR_*`/`XDG_*`, throws on injection).
- Parent evidence records the observed run: 41/41, proof exit 0, harness up/down
  exit 0, tag `p19-mv2i83ok`, zero refused emits, operator cache paths unchanged,
  own cleanup completed (`19-PROOF.md`, from
  `local://v13-phase19-real-runtime-evidence.json`).

CR-01 is closed. The fixture-scoped 27/27 run is retained only as historical
evidence; the contradictory "sealed" / "Known Stubs: None" assertions for that
run are withdrawn (see WR-01).

### WR-01 (CLOSED): Summary now states the historical fixture truth

**Previously:** `19-05-SUMMARY.md` recorded adaptations 3–4 (loopback stub; direct
hook exec) while asserting "Known Stubs: None".

**Now verified:** the current `19-05-SUMMARY.md` carries a dated 2026-10-10
parent-observed correction block at the top that (a) names both fixture-scoped
substitutions, (b) withdraws the `Known Stubs: None` / "sealed" assertions for
the fixture-only run, (c) points at `19-PROOF.md` (41/41, tag `p19-mv2i83ok`) as
the superseding real-runtime record, (d) preserves the original executor text
verbatim as history, and (e) claims no final full-suite green pending parent
re-verification. Adaptations 3–4 are additionally re-labelled
`[FIXTURE-SCOPED, SUPERSEDED ...]`. The stale-truth defect is remediated;
historical-vs-current attribution is explicit. WR-01 is closed.

### WR-02 (CLOSED): Generated hook now emits an anomaly diagnostic on missing/unparseable config

**Previously:** `packages/projector/src/muse.ts` template `readConfig` returned
`null` and the hook body was skipped silently (exit 0, empty stdout, no line).

**Now verified in current source:**

- Template `else` branch added: `packages/projector/src/muse.ts:237-242`
  writes `[muse-hook] no substrate.json; tool call not recorded` to stderr
  before falling through to `process.exit(0)` (`:247`). Exit-0 / empty-stdout
  fail-open guarantees (D19-06/D19-18) are preserved; the damaged-bundle case is
  now visible in the journal.
- Behavioral pins: `packages/projector/src/muse.test.ts:465-502` (missing config:
  exit 0, empty stdout, exactly one stderr line, no emit, no secret/URL leak, no
  refusal file) and `:504-541` (unparseable config: same shape).

WR-02 is closed.

## Info

### IN-01: Collector bearer resolution delegates to the Phase-20-owned token contract (preserved seam, no fix)

**File:** `packages/collectors/src/emit.ts:20-24` (imports `resolveBearer` from `../../cli/src/token.ts`), `packages/cli/src/token.ts:62-77` (env → `SUBSTRATE_TOKEN_FILE` → per-surface file fallback)
**Issue:** No defect asserted — carried forward unchanged from iteration 1 as instructed. The fallback chain matches the identity-manifest shape pinned by `doctor-units.test.ts`; Phase 19 runtime behavior for unauthenticated collectors depends on a Phase 20-owned contract. Token-behavior changes (search order, new sources) must be reviewed against the identity/token contract and the host-token-read incident class, not as collector-local edits.
**Fix:** None required.

---

_Reviewed: 2026-10-10_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
