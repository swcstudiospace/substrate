# 06-07 verify smoke evidence

Recorded from observed output only. 2026-09-27 (UTC), from `/root/src/repos/agent-substrate`.

## Canned server (Task 1)

A throwaway `/tmp/06-07-canned.ts` (plain bun, `Bun.serve` on 127.0.0.1:0, deleted afterwards)
answered POST /verify by graph id — `ok2` → ok with two hours entries (chain "ok"), `pre` → ok with
hours [], `bad` → ok false, brokenAt `evt_x`, reason "prev does not match the preceding event", one
hour with chain "broken", `slow` → the ok2 body after 3 s — and POST /brief with an empty body after
3 s. It logged, per request, the milliseconds from arrival to the client aborting it.

Commands (`SUBSTRATE_URL=http://127.0.0.1:<port>`, SUBSTRATE_VERIFY_TIMEOUT_MS and
SUBSTRATE_TIMEOUT_MS unset unless shown):

```
bun packages/cli/src/index.ts verify ok2
bun packages/cli/src/index.ts verify pre
bun packages/cli/src/index.ts verify bad
SUBSTRATE_VERIFY_TIMEOUT_MS=1000 bun packages/cli/src/index.ts verify slow
bun packages/cli/src/index.ts verify slow
SUBSTRATE_VERIFY_TIMEOUT_MS=abc bun packages/cli/src/index.ts verify slow
SUBSTRATE_VERIFY_TIMEOUT_MS=60000 bun packages/cli/src/index.ts brief
bun packages/cli/src/index.ts verify
grep -nE 'DEFAULT_VERIFY_TIMEOUT_MS *= *[0-9]+' packages/cli/src/index.ts
```

Observed output:

```
$ verify ok2
  out| chain intact for ok2 (5 events)
  out| hour 2026-09-27T12:00:00.000Z chain ok (2 of 9 events)
  out| hour 2026-09-27T13:00:00.000Z chain ok (3 of 4 events)
  exit=0
$ verify pre
  out| chain intact for pre (3 events)
  exit=0
$ verify bad
  out| hour 2026-09-27T13:00:00.000Z chain broken (4 of 6 events)
  err| chain BROKEN for bad at evt_x: prev does not match the preceding event
  exit=1
$ SUBSTRATE_VERIFY_TIMEOUT_MS=1000 verify slow
  err| [substrate] unreachable
  exit=1                                   (server: abort /verify after 1003 ms)
$ verify slow
  out| chain intact for slow (5 events)
  out| hour 2026-09-27T12:00:00.000Z chain ok (2 of 9 events)
  out| hour 2026-09-27T13:00:00.000Z chain ok (3 of 4 events)
  exit=0  ms=3601
$ SUBSTRATE_VERIFY_TIMEOUT_MS=abc verify slow
  exit=0  ms=3604                          (non-numeric falls back to 60000; same three lines)
$ SUBSTRATE_VERIFY_TIMEOUT_MS=60000 brief
  exit=0  ms=2693                          (server: abort /brief after 1500 ms)
$ verify
  err| usage: substrate verify <graph_id>
  exit=2
41:const DEFAULT_VERIFY_TIMEOUT_MS = 60000;
```

cli_ok_exit=0
cli_ok_hour_lines=2
cli_pre_hour_lines=0
cli_broken_exit=1
cli_broken_hour_chain=broken
cli_timeout_env_honoured=true
cli_default_timeout_ms=60000
cli_brief_timeout_unchanged=true
cli_verify_env_abort_ms=1003
cli_brief_abort_ms=1500
cli_usage_exit=2

`cli_brief_timeout_unchanged` is read from the server side: with SUBSTRATE_VERIFY_TIMEOUT_MS=60000
set, the brief's request was aborted by the client 1500 ms after it arrived, before the 3 s reply.
The brief's wall-clock time (2693 ms here; 2000–2899 ms over three more runs) also includes bun
start-up and the two git subprocesses `brief` spawns for repo and branch, which took 400–900 ms on
this host under concurrent load, so a 2 s wall-clock bound is not a stable measure of the budget.

## Live (Task 2)

Read-only against production (substrate-mcp active, /healthz 200, deployed commit c2bafeb; not
edited, not restarted). Default URL http://127.0.0.1:7410, SUBSTRATE_VERIFY_TIMEOUT_MS unset (60000),
each run wall-clock timed with `date +%s%3N` around the whole process:

```
bun packages/cli/src/index.ts verify ut-ledger-smoke-20260927T130216Z
for g in <every baseline-ok-graph in 06-BASELINE.md>; do bun packages/cli/src/index.ts verify "$g"; done
```

Smoke graph output (exit 0, 1697 ms):

```
chain intact for ut-ledger-smoke-20260927T130216Z (29 events)
hour 2026-09-27T13:00:00.000Z chain ok (29 of 42 events)
```

smoke_graph_id=ut-ledger-smoke-20260927T130216Z
smoke_verify_exit=0
smoke_hour_chain=ok
smoke_hour_lines=1
smoke_verify_ms=1697

The smoke hour now holds 42 events (29 of them the smoke graph's, the rest later traffic of other
graphs in the same ingest hour); the whole hour's global chain checked ok.

Baseline graphs (each exit 0 with "chain intact for <gid> (<n> events)" and no hour line — their
rows are all pre-cutover, so hours is []):

```
ut-8a6b17d8smk-6e810294 1099 ms   ut-d09f05d6smk-62523d4b 995 ms   ut-mucem4mc-ec70360f 1402 ms
ut-mufsocbe-c7ced745 995 ms       ut-mugb3vwa-c57eb6ac 703 ms      ut-mugbqivi-752f2dad 1099 ms
ut-mughkkc0-73909228 1303 ms      ut-muh1i8pv-161a7fea 1200 ms     ut-muh1lap4-507edc27 1297 ms
ut-muh1p05f-695a18ee 1005 ms      ut-muh1trcj-90066f6e 2397 ms     ut-muh2ea68-eb8dcf1c 1398 ms
ut-muh2o0rz-5fdd249a 1097 ms      ut-muh32wc1-d14818ff 703 ms      ut-muh3nlig-97d72a43 996 ms
ut-muh424n5-667ff591 800 ms       ut-mui646lx-8f314a85 704 ms      ut-prod-test-0001 805 ms
x 1102 ms
```

pre_cutover_graphs_verified=19/19
verify_max_ms=2397

## Gaps

- Anchoring is skipped by the owner (D-17, "Skip Phase 6 anchoring"): no hour is anchored and the CLI
  prints no anchor line; the SC3 signature clause is skipped-owner. A consistent rewrite of a row and
  every later row through the head, followed by a restart, still passes the chain (T-06-07-03,
  accepted).
- verify_max_ms=2397 (ut-muh1trcj-90066f6e) is above the 1500 ms hook budget: that is the observed
  reason verify has its own 60000 ms timeout. The times are whole-process wall clock (bun start-up
  included) and were taken while the root suite ran concurrently for the Task 1 gate, so they are an
  upper bound on this host, not a server latency figure.
- The canned `cli_*` keys cannot be re-observed after /tmp/06-07-canned.ts was deleted; the ok path
  is re-checked live above and the broken path by 06-09.
