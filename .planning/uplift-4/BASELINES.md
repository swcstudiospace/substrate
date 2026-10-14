# Uplift 4 — baselines (captured 2026-10-14T00:43Z, read-only)

Live release: `9231f4396be5e38ef00db1313c6fae79ea2aace1` (uplift-2 plus its deploy follow-up; uplift-3 is not deployed). Everything here is a read of `/slo`, `/healthz`, `/metrics`, `systemctl`, `redis-cli`, `df`, `free`, `journalctl`, `du`; nothing was changed. Series are process-lifetime since `2026-10-13T21:32:58.788Z`.

## substrate-mcp — SLO catalogue (`/slo.results`)

| objective | observed | target | samples | status |
|---|---|---|---|---|
| brief.p95 | 759.394 | 800 | 67 | ok |
| emit.success | 1.0 | 0.995 | 77 | ok |
| lease.steal_rate | n/a | 0.005 | 0 | insufficient-data |
| quarantine.rate | n/a | 0.01 | 0 | insufficient-data |

## Planes, cache and capacity (`/healthz`, `/slo.planes`)

```
[{"id":"plane.greptime.availability","plane":"greptime","title":"greptime availability","statement":"ok / (ok+error+timeout+open) of substrate.plane.duration{plane=greptime} >= 99.00 % over the rolling hour","unit":"ratio","target":0.99,"status":"ok","observed":1,"samples":43,"detail":"43 of 43 calls ok (100.000 %) over 22 minute(s); objective is at least 99.00 %"},{"id":"plane.index.availability","plane":"index","title":"index availability","statement":"ok / (ok+error+timeout+open) of substrate.plane.duration{plane=index} >= 99.00 % over the rolling hour","unit":"ratio","target":0.99,"status":"ok","observed":1,"samples":22,"detail":"22 of 22 calls ok (100.000 %) over 22 minute(s); objective
{"cache":{"enabled":true,"connected":true,"mode":"on","hits":20,"misses":47,"bypasses":0,"errors":0,"cooldownUntil":null},"ledger":{"writable":true},"appendOnly":true,"auditRecords":7661,"graph_nodes":{"liveRows":45,"deadRows":50},"indexBytes":11891171}
```

## Brief and cache series (`/metrics`)

```
{"name":"substrate.cache.operations","points":[{"a":{"result":"miss","mode":"on"},"v":47},{"a":{"result":"hit","mode":"on"},"v":20}]}

[{"name":"substrate.tokens","points":0},{"name":"substrate.cost.usd","points":0}]
[{"surface":"omp","count":29},{"surface":"muse","count":37},{"surface":"hermes","count":1}]

```

## systemd and host

```
Type=simple
Restart=always
NotifyAccess=none
WatchdogUSec=0
NRestarts=0
Slice=substrate.slice
CPUWeight=[not set]
IOWeight=[not set]
MemoryMax=2147483648
MemorySwapMax=infinity
CPUWeight=[not set]
IOWeight=[not set]
MemoryLow=2147483648
ManagedOOMPreference=none
substrate timers listed: 0
/dev/sda1       387G  362G   25G  94% /
               total        used        free      shared  buff/cache   available
Mem:           32094       13526         497         194       19190       18568
Swap:          16383       13139        3244
 00:43:24 up 14 days,  8:04,  8 users,  load average: 2.85, 3.28, 3.46
Archived and active journals take up 329.6M in the file system.
state dir: 350M (agentos 318M, audit chain 3.8M)
release node_modules, one du invocation (hardlink-aware, newest first): 2.9G	9231f4396be5e38ef00db1313c6fae79ea2aace1/node_modules 26M	91487e764c432a71af40b045156ead1af3f8ca8c/node_modules 
```

## loopback redis

```
used_memory_human:1.23M
maxmemory_human:0B
maxmemory_policy:noeviction
evicted_keys:0
keyspace_hits:1082
keyspace_misses:471
save: 3600 1 300 100 60 10000
dbsize: 13
```
