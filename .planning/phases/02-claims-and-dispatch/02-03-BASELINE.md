# Plan 02-03 — hermes-linear-connector measured baseline

**Measured:** 2026-09-25T01:10:46Z, by plan `02-03` Task 1 Step 0, **before** this plan's first edit.
Produced by running the command below once in this session; nothing copied from
`02-RESEARCH.md` or `01-BASELINE.md`.

```
cd /root/src/repos/hermes-linear-connector && .venv/bin/python -m pytest -q
```

Verbatim summary line:

```
49 passed, 2 skipped in 0.82s
```

Exit code 0. No `FAILED` lines, so there are no `connector-failing-id:` lines below.

connector-head=dc2d74dbc109829b671d24c2bbe9c3386ab3c728
connector-branch=master
connector-pass=49
connector-fail=0
connector-skip=2

## How gates compare against this file (two-sided)

- The set of failing node ids after this plan must be **identical** to the
  `connector-failing-id:` set above (currently empty): a new failure fails the gate,
  and a baseline failure that *vanishes* fails it too.
- This plan adds tests to the connector, so `connector-pass` is a floor: the passed
  count after the plan must be strictly greater than 49.
- Pre-existing failures (none at this HEAD) are recorded, not repaired.
- Measured on branch `master`; the branch was not switched.
