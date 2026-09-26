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

## Post-Phase-4 re-measure (05-01, D-14 part 4)

Measured 2026-09-26 (UTC) at HEAD `84c2ebc90117dc1018bf525349be3778fc1ba92f` (post-Phase-4: plans
04-01..04-11 landed; working tree held only `.planning/config.json`, `.planning/state.json` and
untracked `issues/`, none of them code). Same three commands and tsc normalization as § Commands.

Phase 5 gates compare against the gate-* keys below; the agent-substrate-* keys above are the pre-Phase-4 measurement and are kept for history.

bun test:

```
 503 pass
 0 fail
Ran 503 tests across 27 files. [40.80s]
```

tsc (normalized):

```
tsc-exit=0
```

pytest (packages/dispatcher):

```
149 passed in 43.90s
```

No `gate-failing-id:` and no `gate-dispatcher-failing-id:` lines: both suites were green.

### Machine-readable (gate-*)

gate-head=84c2ebc90117dc1018bf525349be3778fc1ba92f
gate-pass=503
gate-fail=0
gate-files=27
gate-tsc-set: tsc-exit=0
gate-dispatcher-pass=149
gate-dispatcher-fail=0

### Precondition (Phase 4 landed)

phase4-verification=accepted
phase4-accepted-note: Orchestrator acceptance 2026-09-26: Phase 4 code has landed — plans 04-01..04-11 are executed with SUMMARY/SMOKE evidence and the library chain is live; only the proof plan 04-12 remains, re-scoped by the owner on 2026-09-26 from a Cursor session to an Omp session and re-planned in parallel; 04-VERIFICATION.md follows that proof.
library-head=34b32e27870c49d84e166830033b42f011eaf96e
library-branch=main
library-clean=true
library-top-links=0
propose-key-mode=600

Library: `/root/agent-skills` is a work tree on `main`, `status --porcelain` empty, origin
`https://github.com/swcstudiospace/agent-skills.git`, no top-level symlinks. Phase 4 symbols present:
`export function proposeAllowed` (skills/propose-auth.ts), `class BodyTooLargeError` (server.ts),
`"skill.propose"` and `"docs-scraper"` (types.ts), `export function redactSkillContent` (redact.ts),
`skills propose` (cli/src/index.ts). `sudo stat -c '%a %U'` on the propose key printed `600 root`
(the key was not read).

### Disk gate and live state at t0

disk-avail-before=175147573248
recruitment-desktop-id=19f317246866698aa89761c50959d8185754a574df743eac638c76278aff75d0
recruitment-desktop-started-at=2026-09-26T15:03:13.690881811Z
substrate-mcp-active-since=Sat 2026-09-26 15:00:52 UTC
phase5-baseline-t0=/var/lib/substrate/phase5-baseline/t0-20260926T181142Z

Rollback area: `/var/lib/substrate/phase5-baseline/` (0700 root) with `RESTORE.md` (0600, the
index; written only by 05-01), `RESTORE.d/` (0700, empty; one file per live-changing plan) and the
t0 snapshot above (docker-ps.tsv, docker-volumes.txt, listeners.txt, etc-substrate.listing,
substrate-env.presence — counts only, units.sha256, MANIFEST.sha256).
