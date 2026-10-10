---
phase: 19-lane-b-collectors
fixed_at: 2026-10-10
status: all_fixed
fix_scope: critical_warning
findings_in_scope: 3
fixed: 3
skipped: 0
iteration: 2
---

# Phase 19 review remediation

| Finding | Disposition | Observed evidence |
|---|---|---|
| CR-01 | Fixed | Actual proof-named herdr server and watching collector, persisted-state restart, real scratch Muse install/approve/inspect/hook-test, pre-execution installed URL guard and ten-second action-to-observation bounds; parent real proof tag `p19-mv2i83ok`, 41/41 checks, own up/down exit 0. |
| WR-01 | Fixed | Original fixture-only adaptations and historical metrics retained; misleading sealed/no-stubs claims withdrawn. `19-PROOF.md` records the corrected real-runtime evidence separately. |
| WR-02 | Fixed | Missing or malformed generated-hook configuration emits one safe stderr diagnostic while preserving exit 0, empty stdout and no emit; behavioral tests pass. |
| IN-01 | No fix required | Shared Phase-20 bearer-resolution seam preserved; no collector-local authentication change. |

## Parent verification

- Targeted edited union: 85 pass, 0 fail across 6 files.
- Typecheck: exit 0.
- Phase-close: 112 pass, 0 fail; 12 event kinds and 27 surfaces.
- Full suite: 2670 pass, 58 skip, 0 fail across 96 files.
- Real-runtime proof: 41/41 checks; no model, default herdr session, production store or user-scope install requested.
- Collector unit syntax: `systemd-analyze verify` exit 0.
- Iteration-2 source re-review: `19-REVIEW.md` status `clean`.

These are parent-observed results, not checks run by implementers or reviewers. Final canonical phase verification remains a separate gate. Production cutover and the exposed Cursor credential's operator-controlled rotation are not performed or self-approved by this report.
