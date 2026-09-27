# Phase 6 — agent-substrate, dispatcher and live ledger baseline

Measured by plan 06-01 before any Phase 6 source or live edit, on 2026-09-27 (UTC), from
`/root/src/repos/agent-substrate`, after Phase 4 and Phase 5 (desktop half only; the owner
skipped the docs half) landed.

## Commands

```
SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test
/root/.local/share/reflex/bun/bin/bunx tsc --noEmit
cd packages/dispatcher && python3 -m pytest -q
```

Type-check normalization (every Phase 6 tsc gate runs exactly this pipeline and diffs its output
against the `agent-substrate-tsc-set:` lines below):

```
{ /root/.local/share/reflex/bun/bin/bunx tsc --noEmit 2>&1; echo "tsc-exit=$?"; } | grep -E 'error TS[0-9]+|^tsc-exit=' | sed -E 's/\([0-9]+,[0-9]+\)//; s/^tsc-exit=[1-9][0-9]*$/tsc-exit=nonzero/' | sort -u
```

Live inventory (read-only; the probe was a throwaway /tmp/06-01-probe.ts, deleted afterwards, run
once under the keyed line with `-E P6_SNAPSHOT=<snapshot>`):

```
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env -p WorkingDirectory=/root/src/repos/agent-substrate -E HOME=/root -E P6_SNAPSHOT=/var/lib/substrate/phase6-baseline/06-01/20260927T063414Z /root/.local/share/reflex/bun/bin/bun /tmp/06-01-probe.ts
sudo sh -c 'cd $S && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256'
sha256sum packages/mcp-server/src/fixtures/pre-cutover-rows.json
grep -cE "<the 06-PATTERNS token-shape regex>" packages/mcp-server/src/fixtures/pre-cutover-rows.json
sudo grep -c '^SOLANA_' /etc/substrate/substrate.env
systemctl list-timers --all --no-pager | grep -c ledger
/root/.local/share/solana/install/active_release/bin/solana --version
/root/.local/share/solana/install/active_release/bin/solana config get
stat -c '%Y %s' /root/.config/solana/id.json
test ! -e /etc/substrate/ledger-devnet.json
df --output=avail -B1 / | tail -n 1
```

The probe counted agent_events rows, graph rows, distinct graphs, prev-null rows, max ts and
future-ts rows, anchors rows, anchors.root's semantic_type and agent_events' ingested_at column
through information_schema.columns; timed five `SELECT 1`; wrote `SHOW CREATE TABLE` for
agent_events and anchors verbatim into the snapshot; POSTed `/verify` for every distinct graph id;
selected the 16 verifyGraph columns for every row of the ok graphs
(`ORDER BY "graph_id", "ts", "id"`), re-scanned summary and payload with `redact()` (no graph
excluded) and wrote them to the fixture. The fixture token-shape scan printed `0`.

## Verbatim summary lines

bun test:

```
 534 pass
 0 fail
 6987 expect() calls
Ran 534 tests across 29 files. [19.70s]
```

tsc: no output, exit 0 (normalized: `tsc-exit=0`).

pytest (packages/dispatcher):

```
149 passed in 33.60s
```

solana:

```
solana-cli 4.2.2 (src:e29e5d91; feat:21b0d33a, client:Agave)
RPC URL: http://127.0.0.1:8899 
```

HEAD at measurement: `c31f820f906ba973994f1d4d6f408ca580a042d3`

## Machine-readable

phase4-verification=passed
phase5-verification=accepted
phase5-accepted-note: Owner skipped the Phase 5 docs half on 2026-09-27 (05-02 resume-signal "skip") and accepted the resulting verification gaps ("Accept gaps, continue"): SC1, SC2 and the docs clause of the Proof are not delivered this milestone; SC3 and the GUI-smoke clause are verified (05-VERIFICATION.md).
phase45-symbols=present
agent-substrate-head=c31f820f906ba973994f1d4d6f408ca580a042d3
agent-substrate-pass=534
agent-substrate-fail=0
agent-substrate-files=29
agent-substrate-tsc=clean
agent-substrate-tsc-set: tsc-exit=0
dispatcher-pass=149
dispatcher-fail=0
greptime-rows=5619
greptime-graph-rows=95
greptime-graphs=19
greptime-prev-null=5122
greptime-max-ts=2026-09-27T06:32:40.387Z
greptime-future-ts=0
greptime-rtt-ms: 202
greptime-rtt-ms: 198
greptime-rtt-ms: 200
greptime-rtt-ms: 204
greptime-rtt-ms: 196
greptime-rtt-ms-max=204
anchors-rows=0
anchors-root-tag=true
events-ingested-at=absent
baseline-ok-graph: ut-8a6b17d8smk-6e810294
baseline-ok-graph: ut-d09f05d6smk-62523d4b
baseline-ok-graph: ut-mucem4mc-ec70360f
baseline-ok-graph: ut-mufsocbe-c7ced745
baseline-ok-graph: ut-mugb3vwa-c57eb6ac
baseline-ok-graph: ut-mugbqivi-752f2dad
baseline-ok-graph: ut-mughkkc0-73909228
baseline-ok-graph: ut-muh1i8pv-161a7fea
baseline-ok-graph: ut-muh1lap4-507edc27
baseline-ok-graph: ut-muh1p05f-695a18ee
baseline-ok-graph: ut-muh1trcj-90066f6e
baseline-ok-graph: ut-muh2ea68-eb8dcf1c
baseline-ok-graph: ut-muh2o0rz-5fdd249a
baseline-ok-graph: ut-muh32wc1-d14818ff
baseline-ok-graph: ut-muh3nlig-97d72a43
baseline-ok-graph: ut-muh424n5-667ff591
baseline-ok-graph: ut-mui646lx-8f314a85
baseline-ok-graph: ut-prod-test-0001
baseline-ok-graph: x
pre-cutover-graphs-ok=19/19
fixture-rows=95
fixture-graphs=19
fixture-sha256=e73e05f2bc99898f5d5705972046224b7fe73bf14eee35d8b23d74fcceb7d303
solana-env-lines=0
ledger-timers=0
solana-version=solana-cli 4.2.2 (src:e29e5d91; feat:21b0d33a, client:Agave)
solana-config-rpc=http://127.0.0.1:8899
solana-id-json-stat=1789532431 235
ledger-key-present=false
disk-avail-before=196306694144
phase6-baseline-snapshot=/var/lib/substrate/phase6-baseline/06-01/20260927T063414Z

No `agent-substrate-failing-id:` lines and no `dispatcher-failing-id:` lines: both suites were
green at measurement. No `baseline-bad-graph:` lines: every graph verified ok. No
`fixture-excluded-graph:` lines: no fixture row's summary or payload is changed by `redact()`.

Snapshot MANIFEST (`sudo sh -c 'cd <snapshot> && sha256sum -c --quiet MANIFEST.sha256'`):

```
960364e3aa5ad3c7d80e601f844b95c65c53b7e0450a2fc607384ee6956ede99  ./greptime/agent_events.show-create.txt
1040360df6e1966260e7b06bbcb2b9359e265e02c3189e368241e5a9856e3fc7  ./greptime/anchors.show-create.txt
```

## How later gates must compare (two-sided)

- Failures and type errors present at measurement belong to other sessions and are not to be
  repaired by Phase 6 plans; they are carried in the sets above.
- A gate fails on any new failing test id or new normalized type-error line, **and** on any
  baseline failure or baseline type error that disappears — a vanished entry fails the gate
  exactly as a new one does.
- The same rule applies to the dispatcher: a gate fails on any new `FAILED` node id and on any
  `dispatcher-failing-id:` that disappears.
- The pass counts must not drop below `agent-substrate-pass` and `dispatcher-pass`; Phase 6 plans
  that add tests require the matching count to grow.
- The baseline-ok-graph set must stay ok after every substrate-mcp change: every
  `baseline-ok-graph:` id must still answer `ok` from `POST /verify`. A `baseline-bad-graph:` id
  (none at measurement) is carried, not repaired.
- Greptime counts (`greptime-rows`, `greptime-graph-rows`, `greptime-graphs`) are live and grow
  with traffic; later gates compare them as lower bounds, never for equality. `anchors-rows=0`,
  `events-ingested-at=absent`, `solana-env-lines=0`, `ledger-timers=0` and
  `ledger-key-present=false` are the pre-Phase-6 state the owning plans change.
