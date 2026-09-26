# Phase 5 — agent-substrate and dispatcher baseline

Measured before any Phase 5 source edit, on 2026-09-25 (UTC), from
`/root/src/repos/agent-substrate`. Working tree at measurement: only `.planning/config.json`,
`.planning/state.json` (GSD's own), untracked `.planning/milestone.lock`,
`.planning/phases/04-skills/04-RESEARCH.md` (Phase 4 session) and `issues/`.

## Commands

```
SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test
/root/.local/share/reflex/bun/bin/bunx tsc --noEmit
cd packages/dispatcher && python3 -m pytest -q
```

Type-check normalization (same pipeline as 03-BASELINE.md; every Phase 5 tsc gate diffs its
output against the `agent-substrate-tsc-set:` lines below):

```
{ /root/.local/share/reflex/bun/bin/bunx tsc --noEmit 2>&1; echo "tsc-exit=$?"; } | grep -E 'error TS[0-9]+|^tsc-exit=' | sed -E 's/\([0-9]+,[0-9]+\)//; s/^tsc-exit=[1-9][0-9]*$/tsc-exit=nonzero/' | sort -u
```

## Verbatim summary lines

bun test:

```
 338 pass
 0 fail
Ran 338 tests across 22 files. [1146.00ms]
```

tsc: no output, exit 0 (normalized: `tsc-exit=0`).

pytest (packages/dispatcher):

```
149 passed in 2.33s
```

HEAD at measurement: `b86679396cc408171de621cb4653f655307b3a76`

## Machine-readable

agent-substrate-head=b86679396cc408171de621cb4653f655307b3a76
agent-substrate-pass=338
agent-substrate-fail=0
agent-substrate-tsc=clean
agent-substrate-tsc-set: tsc-exit=0
dispatcher-pass=149
dispatcher-fail=0

No `agent-substrate-failing-id:` and no `dispatcher-failing-id:` lines: both suites were green.

## How later gates must compare (two-sided)

- A gate fails on any new failing test id or new normalized type-error line, **and** on any
  baseline failure or type error that disappears.
- Same rule for the dispatcher (`FAILED` node ids).
- Pass counts must not drop below `agent-substrate-pass` / `dispatcher-pass`; Phase 5 plans that
  add tests require the matching count to grow.
- Phase 4 runs in the same checkout. If a Phase 4 commit lands between measurement and a Phase 5
  gate, re-measure at that commit before gating and record the new counts here, rather than
  attributing Phase 4's deltas to Phase 5.
