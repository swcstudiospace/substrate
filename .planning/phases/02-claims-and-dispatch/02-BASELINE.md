# Phase 2 — agent-substrate baseline

Measured by plan 02-01 before any Phase 2 source edit, on 2026-09-25 (UTC), from
`/root/src/repos/agent-substrate`.

## Commands

```
SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test
/root/.local/share/reflex/bun/bin/bunx tsc --noEmit
```

Type-check normalization (the tsc gates in 02-01, 02-05 and 02-06 run exactly this pipeline and
diff its output against the `agent-substrate-tsc-set:` lines below):

```
{ /root/.local/share/reflex/bun/bin/bunx tsc --noEmit 2>&1; echo "tsc-exit=$?"; } | grep -E 'error TS[0-9]+|^tsc-exit=' | sed -E 's/\([0-9]+,[0-9]+\)//; s/^tsc-exit=[1-9][0-9]*$/tsc-exit=nonzero/' | sort -u
```

## Verbatim summary lines

bun test:

```
 76 pass
 0 fail
Ran 76 tests across 8 files. [122.00ms]
```

tsc: no output, exit 0 (normalized: `tsc-exit=0`).

HEAD at measurement: `585f06d4d97af1d5f5e934a2feb21d3122f41754`

## Machine-readable

agent-substrate-head=585f06d4d97af1d5f5e934a2feb21d3122f41754
agent-substrate-pass=76
agent-substrate-fail=0
agent-substrate-tsc=clean
agent-substrate-tsc-set: tsc-exit=0

No `agent-substrate-failing-id:` lines: the suite was green at measurement.

## How later gates must compare (two-sided)

- Failures and type errors present at measurement belong to other sessions and are not to be
  repaired by Phase 2 plans; they are carried in the sets above.
- A gate fails on any new failing test id or new normalized type-error line, **and** on any
  baseline failure or baseline type error that disappears — a vanished entry fails the gate
  exactly as a new one does.
- The pass count must not drop below `agent-substrate-pass`; plans that add tests require it to
  grow.
