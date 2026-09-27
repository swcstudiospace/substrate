# Phase 7 — agent-substrate, dispatcher and live recall baseline

Measured by plan 07-01 before any Phase 7 source edit and after Phase 6 landed, on 2026-09-27 (UTC),
from `/root/src/repos/agent-substrate`.

## Commands

```
SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test
/root/.local/share/reflex/bun/bin/bunx tsc --noEmit
cd packages/dispatcher && python3 -m pytest -q
```

Type-check normalization (every Phase 7 tsc gate runs exactly this pipeline and diffs its output
against the `agent-substrate-tsc-set:` lines below):

```
{ /root/.local/share/reflex/bun/bin/bunx tsc --noEmit 2>&1; echo "tsc-exit=$?"; } | grep -E 'error TS[0-9]+|^tsc-exit=' | sed -E 's/\([0-9]+,[0-9]+\)//; s/^tsc-exit=[1-9][0-9]*$/tsc-exit=nonzero/' | sort -u
```

## Verbatim summary lines

bun test:

```
 634 pass
 0 fail
 7799 expect() calls
Ran 634 tests across 36 files. [50.70s]
```

A first run at load average ~30 on 8 cores (another session's work) reported `633 pass / 1 fail`:
`graph_release / graph_complete owner surface (WR-02) > graph_release: an authenticated caller naming
another surface is refused with no write` timed out at 5000 ms. `mcp.test.ts` alone then passed 18/18
in 7.6 s and the full suite re-run passed 634/0 at lower load; the recorded baseline is the re-run.
A later gate that sees that single id fail by timeout under heavy load should re-run before calling
it a regression.

tsc: no output, exit 0 (normalized: `tsc-exit=0`).

pytest (packages/dispatcher):

```
149 passed in 56.30s
```

HEAD at measurement: `4fa90f2ff9eabbe4d25ed2a6632f7a77f509ae24`

## Phase order (Phase 7 depends on Phase 6)

`.planning/phases/06-ledger/06-VERIFICATION.md` has `status: gaps_found`; the orchestrator accepted it
(answer recorded verbatim on the `phase6-accepted-note:` line). The three Phase 6 symbols exist
(`ingested_at?: string` in types.ts, `export class IngestChain` in chain.ts, `export const EVENT_COLUMNS`
in greptime.ts) and 06-05-CUTOVER.md records the live cutover. `docs_search` is absent from mcp.ts
(the Phase 5 docs half was owner-skipped); 07-04's interfaces describe the open-search pattern.

## Machine-readable

phase6-verification=accepted
phase6-accepted-note: Owner skipped Phase 6 devnet anchoring on 2026-09-27 ("Skip Phase 6 anchoring", 06-CONTEXT D-17) and accepted the resulting verification gaps ("Accept gaps, continue"): SC2 and SC3's roots-against-signatures clause are not delivered this milestone; SC1, SC3's chain recomputation and the chain-only tamper Proof are verified (06-VERIFICATION.md).
phase6-symbols=present
phase6-cutover-ingested-at=2026-09-27T13:02:16.494Z
phase5-docs-search=absent
agent-substrate-head=4fa90f2ff9eabbe4d25ed2a6632f7a77f509ae24
agent-substrate-pass=634
agent-substrate-fail=0
agent-substrate-files=Ran 634 tests across 36 files
agent-substrate-tsc=clean
agent-substrate-tsc-set: tsc-exit=0
dispatcher-pass=149
dispatcher-fail=0
disk-avail-before=193814814720
substrate-mcp-active-since=Sun 2026-09-27 13:01:42 UTC
agentmemory-url-lines=0
agentmemory-secret-lines=0
substrate-token-lines=0
claude-hindsight-mcp=present
claude-hindsight-hooks=3
claude-substrate-mcp=absent
hermes-memory-provider=supermemory
hermes-substrate-mcp=absent
agentmemory-native=absent
hindsight-procs=0
hindsight-data-files=63
phase7-baseline-t0=/var/lib/substrate/phase7-baseline/t0-20260927T165601Z

No `agent-substrate-failing-id:` lines and no `dispatcher-failing-id:` lines: both suites were
green at measurement.

## How later gates must compare (two-sided)

- Failures and type errors present at measurement belong to other sessions and are not to be
  repaired by Phase 7 plans; they are carried in the sets above.
- A gate fails on any new failing test id or new normalized type-error line, **and** on any
  baseline failure or baseline type error that disappears — a vanished entry fails the gate
  exactly as a new one does.
- The same rule applies to the dispatcher: a gate fails on any new `FAILED` node id and on any
  `dispatcher-failing-id:` that disappears.
- The pass counts must not drop below `agent-substrate-pass` and `dispatcher-pass`; every Phase 7
  code task adds tests, so its agent-substrate pass count must exceed `agent-substrate-pass`.
