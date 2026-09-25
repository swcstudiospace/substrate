# Phase 3 — agent-substrate and dispatcher baseline

Measured by plan 03-01 before any Phase 3 source edit, on 2026-09-25 (UTC), from
`/root/src/repos/agent-substrate`.

## Commands

```
SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test
/root/.local/share/reflex/bun/bin/bunx tsc --noEmit
cd packages/dispatcher && python3 -m pytest -q
```

Type-check normalization (every Phase 3 tsc gate runs exactly this pipeline and diffs its output
against the `agent-substrate-tsc-set:` lines below):

```
{ /root/.local/share/reflex/bun/bin/bunx tsc --noEmit 2>&1; echo "tsc-exit=$?"; } | grep -E 'error TS[0-9]+|^tsc-exit=' | sed -E 's/\([0-9]+,[0-9]+\)//; s/^tsc-exit=[1-9][0-9]*$/tsc-exit=nonzero/' | sort -u
```

## Verbatim summary lines

bun test:

```
 167 pass
 0 fail
 548 expect() calls
Ran 167 tests across 11 files. [291.00ms]
```

tsc: no output, exit 0 (normalized: `tsc-exit=0`).

pytest (packages/dispatcher):

```
114 passed in 1.79s
```

HEAD at measurement: `2df112c2dbbbd6a4025558867bf86b473a582680`

## Machine-readable

agent-substrate-head=2df112c2dbbbd6a4025558867bf86b473a582680
agent-substrate-pass=167
agent-substrate-fail=0
agent-substrate-tsc=clean
agent-substrate-tsc-set: tsc-exit=0
dispatcher-pass=114
dispatcher-fail=0

No `agent-substrate-failing-id:` lines and no `dispatcher-failing-id:` lines: both suites were
green at measurement.

## How later gates must compare (two-sided)

- Failures and type errors present at measurement belong to other sessions and are not to be
  repaired by Phase 3 plans; they are carried in the sets above.
- A gate fails on any new failing test id or new normalized type-error line, **and** on any
  baseline failure or baseline type error that disappears — a vanished entry fails the gate
  exactly as a new one does.
- The same rule applies to the dispatcher: a gate fails on any new `FAILED` node id and on any
  `dispatcher-failing-id:` that disappears.
- The pass counts must not drop below `agent-substrate-pass` and `dispatcher-pass`; Phase 3 plans
  that add tests require the matching count to grow.
