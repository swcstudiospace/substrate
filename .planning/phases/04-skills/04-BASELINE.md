# Phase 4 — agent-substrate, dispatcher and skill-autonomy baseline

Measured by plan 04-01 before any Phase 4 edit, on 2026-09-26 (UTC), from
`/root/src/repos/agent-substrate` at HEAD `44bad2d6036990f74b7670047db2ea6a5e333e15` (no uncommitted
change under `packages/` or `infra/`).

## Commands

```
SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test
/root/.local/share/reflex/bun/bin/bunx tsc --noEmit
cd packages/dispatcher && python3 -m pytest -q
cd /root/src/repos/skill-autonomy && python3 -m pytest -q -p no:cacheprovider
```

Type-check normalization (every Phase 4 tsc gate runs exactly this pipeline and diffs its output
against the `agent-substrate-tsc-set:` lines below):

```
{ /root/.local/share/reflex/bun/bin/bunx tsc --noEmit 2>&1; echo "tsc-exit=$?"; } | grep -E 'error TS[0-9]+|^tsc-exit=' | sed -E 's/\([0-9]+,[0-9]+\)//; s/^tsc-exit=[1-9][0-9]*$/tsc-exit=nonzero/' | sort -u
```

skill-autonomy's `pyproject.toml` already sets `addopts = "-q"`, so the command above runs at `-qq`
and prints only the progress dots (25 dots, exit 0) and no count line. The count line below comes
from the same suite run as `cd /root/src/repos/skill-autonomy && python3 -m pytest -p no:cacheprovider`
(addopts supplies the single `-q`); a gate that parses `passed`/`failed`/`FAILED` must use that form
(or add `-rfE`), not `-q -q`.

Inventory commands (paths only, no file contents):

```
ls -A /root/agent-skills | wc -l
find /root/agent-skills -maxdepth 1 -type l | wc -l
find -L /root/agent-skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l
find /root/.grok/skills -mindepth 1 -maxdepth 1 ! -type l -printf '%f\n' | sort
find <nine roots> -maxdepth 2 -xtype l 2>/dev/null | sort
ls /root/.hermes/pending/memory/*.json | wc -l
df --output=avail -B1 / | tail -n 1
```

`root-inventory:` counts every top-level entry of a root: `links` are symlinks, `real` everything
else (directories and files such as README.md); `links-to-exports` are links whose target is under
`/root/.openclaw/workspace/projects/docs-scraper/data/exports/`, `links-to-library` links whose
target is under `/root/agent-skills` (raw link target, not the resolved chain).

## Verbatim summary lines

bun test:

```
 338 pass
 0 fail
 5844 expect() calls
Ran 338 tests across 22 files. [5.29s]
```

tsc: no output, exit 0 (normalized: `tsc-exit=0`).

pytest (packages/dispatcher):

```
149 passed in 12.21s
```

pytest (skill-autonomy, `python3 -m pytest -p no:cacheprovider`; the `-q -p no:cacheprovider`
form printed 25 dots and exit 0):

```
25 passed in 1.80s
```

HEAD at measurement: `44bad2d6036990f74b7670047db2ea6a5e333e15`

## Machine-readable

agent-substrate-head=44bad2d6036990f74b7670047db2ea6a5e333e15
agent-substrate-pass=338
agent-substrate-fail=0
agent-substrate-files=22
agent-substrate-tsc=clean
agent-substrate-tsc-set: tsc-exit=0
dispatcher-pass=149
dispatcher-fail=0
skill-autonomy-pass=25
skill-autonomy-fail=0
library-entries=41
library-links=26
library-skill-md=40
root-inventory: /root/.claude/skills links=0 real=74 links-to-exports=0 links-to-library=0
root-inventory: /root/.grok/skills links=23 real=20 links-to-exports=23 links-to-library=0
root-inventory: /root/.agents/skills links=0 real=80 links-to-exports=0 links-to-library=0
root-inventory: /root/.cursor/skills links=0 real=72 links-to-exports=0 links-to-library=0
root-inventory: /root/.hermes/skills links=33 real=34 links-to-exports=20 links-to-library=13
root-inventory: /root/.omp/skills links=4 real=0 links-to-exports=0 links-to-library=4
root-inventory: /root/.openclaw/skills links=30 real=5 links-to-exports=20 links-to-library=10
root-inventory: /root/.openclaw/workspace/skills links=30 real=2 links-to-exports=20 links-to-library=10
root-inventory: /root/agent-skills links=26 real=15 links-to-exports=25 links-to-library=0
grok-real-entry: README.md
grok-real-entry: autonogrammer-operating
grok-real-entry: companion-clis
grok-real-entry: docs-scraper
grok-real-entry: flash
grok-real-entry: parallel-chat
grok-real-entry: parallel-common
grok-real-entry: parallel-extract
grok-real-entry: parallel-findall
grok-real-entry: parallel-monitor
grok-real-entry: parallel-responses
grok-real-entry: parallel-search
grok-real-entry: parallel-stock-deep-research
grok-real-entry: parallel-task
grok-real-entry: runpod
grok-real-entry: runpod-mcp
grok-real-entry: runpod-migrate
grok-real-entry: runpod-templates
grok-real-entry: runpod-usage
grok-real-entry: runpodctl
dangling-links-before=0
hermes-pending-memory=3
disk-avail-before=19997605888
phase4-baseline-t0=/var/lib/substrate/phase4-baseline/t0/20260926T033909Z

No `agent-substrate-failing-id:`, `dispatcher-failing-id:` or `skill-autonomy-failing-id:` lines:
all three suites were green at measurement. No `dangling-link:` lines: the nine roots held no
dangling link at depth ≤ 2. The one remaining `/root/agent-skills` link (26 links, 25 into the
docs-scraper exports) points at `/root/.hermes/skills/research/anda-ecosystem`.

## How later gates must compare (two-sided)

- Failures and type errors present at measurement belong to other sessions and are not to be
  repaired by Phase 4 plans; they are carried in the sets above.
- A gate fails on any new failing test id or new normalized type-error line, **and** on any
  baseline failure or baseline type error that disappears — a vanished entry fails the gate
  exactly as a new one does.
- The same rule applies to the dispatcher: a gate fails on any new `FAILED` node id and on any
  `dispatcher-failing-id:` that disappears.
- The same rule applies to skill-autonomy: a gate fails on any new `FAILED` node id and on any
  `skill-autonomy-failing-id:` that disappears (run it without the extra `-q`, see Commands).
- The pass counts must not drop below `agent-substrate-pass`, `dispatcher-pass` and
  `skill-autonomy-pass`; Phase 4 plans that add tests require the matching count to grow.
- The miner suite (`cd packages/miner && python3 -m pytest -q`) is new in Phase 4 and has no
  baseline: it must report 0 failed and at least the plan's own test count.
