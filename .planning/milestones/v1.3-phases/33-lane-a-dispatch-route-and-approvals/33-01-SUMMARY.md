# Phase 33 Plan 01: Fake-host route rehearsal Summary

- phase: 33-lane-a-dispatch-route-and-approvals
- plan: 01
- status: complete
- commits: b6e9537
- requirement: LANEA-04

Proved the wired `dispatch:claude-code` route end to end with fake host transports; zero routing-logic diffs.

## Evidence
- `python3 -m pytest packages/dispatcher/tests -q`: 194 passed (178 baseline + 16 new)
- `scripts/dispatcher-driver.py`: 0 failures incl. new S11–S16 claude-code matrix
- New: `packages/dispatcher/tests/test_claude_code_route.py` (13 tests: tick→POST→RemoteTask→landed for claimed_by/state/comment shapes, ids-only body + bearer, 400/409/502 once-only host-refused, down/non-JSON/wrong-shape silent retry, exited-unclaimed + claim-timeout give-up with label removal, restart never relaunches)
- `test_host.py` +2 (non-JSON/wrong-shape → host-unreachable); `test_sessions.py` +1 (RemoteTask exited-unclaimed)
- Markers byte-identical (13, asserted in-test per D33-02)

## Deviations
- Matrix lives in `scripts/dispatcher-driver.py` S11–S16 (run by `dispatcher-smoke.ts`) instead of the TS smoke: the CLI layer is `--dry-run`-only by rule, so launch-to-landed can only run at the process layer the driver owns. Hermes cases untouched, green.
- New `test_claude_code_route.py` instead of extending `test_dispatch.py`: keeps the reviewed file untouched.

## Self-Check: PASSED
