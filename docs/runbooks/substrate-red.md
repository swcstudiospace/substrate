# Runbook — substrate red

| | |
| --- | --- |
| Requirement | uplift-2 R2 (Build Plan A-5 "Runbooks: substrate red", A-3, SPE-10665 / SPE-10667) |
| Symptoms | `GET /healthz` answers non-200; `bun run parity:check` FAIL on the healthz criterion; a `planes.<name>.breaker.state` of `open` in `/healthz`; a `plane.<name>.availability` objective `breached` in `/slo`; a Railway store down (Greptime, TimescaleDB, Hindsight, RAGFlow) or the loopback redis stopped; agents reporting degraded briefs, recalls or docs searches |
| Measured | 2026-10-13 baseline (`.planning/uplift-2/BASELINES.md`): `/healthz` mean 598 ms; brief p95 3,116 ms; Greptime / Hindsight / RAGFlow edge TTFB ≈ 220–250 ms; TimescaleDB cold connect 1,057 ms; time-to-degraded answer during an outage 4–5 s before breakers, < 50 ms once a breaker is open |
| Scope | `substrate-mcp.service` on `127.0.0.1:7410` and the five data planes it reaches |
| Untouched | The collectors, dispatcher, host, skills sync, surface tokens, event mapping, the stores' own data |

## What "red" means, and what it does not

The status code of `/healthz` comes from two things only: a configured ledger
that cannot be written (`eventsWritable: false` → 503) and neither the index nor
the ledger answering (→ 503). Everything else in the body — `planes`,
`capacity`, `cache`, `auditDurable` — is **report-only**. A Hindsight or RAGFlow
outage never turns `/healthz` red; it turns the plane's row red and degrades the
reads that plane serves. So the first question is always *which plane*, and
`/healthz` now answers it.

Operator only, in an approved window for anything beyond reading. Commands as
run, from a session on the host. No command below carries a credential; variable
names only.

## Triage

1. **The unit.**

   ```sh
   systemctl status substrate-mcp
   journalctl -u substrate-mcp --since '-15 min' --no-pager
   ```

   `Restart=always` recovers a crash; a crash loop shows as a growing
   `NRestarts` and a journal full of boot lines. A boot line names the stores it
   found (`listening on … (index + greptime, …)`); a missing store at boot is a
   configuration problem, not an outage.

2. **`/healthz`, field by field.**

   ```sh
   curl -s http://127.0.0.1:7410/healthz | jq .
   ```

   | Field | Red when | Means |
   | --- | --- | --- |
   | HTTP status | `503` | ledger configured but not writable, or neither index nor ledger answering — the only two things that set the code |
   | `greptime` | `false` | the ledger did not answer `SELECT 1` |
   | `eventsWritable` | `false` while `greptime: true` | reachable but refusing: `appendOnly: false` (table not append-only, `docs/greptime-ledger.md`) or `quotingDialectKnown: false` |
   | `index` | `false` | the TimescaleDB ping (1 s bound) failed |
   | `capacity.index` | `null` while `index: true` | the size query outlasted 1 s — slow, not down |
   | `planes.<name>.ok` | `false` | that plane's bounded probe failed this request; `null` = not configured (or, for the cache, no command yet) |
   | `planes.<name>.breaker.state` | `open` | `SUBSTRATE_BREAKER_FAILURES` consecutive failures; every call to that plane is refused in microseconds until `SUBSTRATE_BREAKER_OPEN_MS` passes, then one probe; `half-open` = the probe is in flight |
   | `planes.<name>.lastErrorAt` / `breaker.lastError` | recent | when and why it last failed (message truncated, never a body) |
   | `cache.mode` | `degraded` | the last cache command failed; reads bypass to the source. `cooldownUntil` set = a failed connect, no reconnect attempt for 5 s |
   | `auditDurable` | `false` | the MCP audit chain is in memory; fail-closed tools refuse. Not a 503, but a deployment fact |

3. **`/slo`: which plane, how long.**

   ```sh
   curl -s http://127.0.0.1:7410/slo | jq '{breached, planes: [.planes[] | {id, status, observed, samples, detail}]}'
   ```

   `breached` is the catalogue's list (`brief.p95`, `emit.success`, …).
   `planes[]` is one `plane.<name>.availability` per plane over the rolling hour:
   `breached` means more than 1 % of that plane's calls in the last hour did not
   get an answer (timeouts, errors and breaker refusals all count);
   `insufficient-data` right after a restart is normal (two `/slo` reads are the
   first sample); `unconfigured` is a plane this deployment does not have.

4. **Parity.** `bun run parity:check --json` — the unit owns the port and serves
   the pinned release. A FAIL that names only `healthz` is this runbook; a FAIL
   naming the pid, cgroup or release is [`production-parity.md`](production-parity.md).

5. **Chaos expectations.** During a plane outage the substrate is behaving when:

   | Path | Expected | Where to see it |
   | --- | --- | --- |
   | `POST /events`, `emit` | **fail-open**: answers with the normalised event, `stored: false`, 503 | `substrate.emit.total{outcome=dropped}` |
   | `graph_claim` | **fail-closed**: `decision: revoked`, node quarantined, both halves on the audit chain | `/evidence`, `substrate.lease.claims` |
   | `POST /brief` | **fail-open**: 200 inside the hook's budget; the source that failed is left out | `substrate.brief.duration{outcome=error}` |
   | `memory_recall` | **fail-open**: `degraded: true`, reason containing `circuit open` or `unreachable` | `/memory/recall` |
   | `docs_search` | **fail-open**: `{chunks: [], degraded: true, reason: "ragflow circuit open"}` | `/docs/search` |
   | cache | **fail-open**: `mode: degraded`, every read bypasses to the source | `substrate.cache.operations{result=bypass}` |

   `bun run smoke:chaos -- --plane <name>` asserts exactly this over the wire
   (`docs/observability.md`, "The chaos smoke"); run it against the rehearsal
   twin, never against production during an incident.

## Kill switch

If a breaker is refusing a plane that is demonstrably healthy — `ok: true` on
every read while `breaker.state` stays `open`, or a `lastError` that names a
4xx the plane is right to send — the breaker, not the plane, is the problem:

```sh
# /etc/substrate/substrate.env (root-owned, 0600): add or set, then restart.
SUBSTRATE_BREAKER=0
systemctl restart substrate-mcp
curl -s http://127.0.0.1:7410/healthz | jq '.planes[].breaker'   # every entry null
```

`SUBSTRATE_BREAKER=0` restores exactly the pre-R2 behaviour: every call reaches
the plane and waits out its own timeout; the plane series are still recorded.
Tune rather than disable when the plane is merely slow:
`SUBSTRATE_BREAKER_FAILURES` (default 5, 1–100) and `SUBSTRATE_BREAKER_OPEN_MS`
(default 30000, 1000–600000). A value outside its range falls back to the
default and never crash-loops the service.

## Rollback

When the red followed a deploy, roll the release back before chasing a store:

```sh
infra/vps/deploy-release.sh rollback
bun run parity:check --json
curl -s http://127.0.0.1:7410/healthz | jq '{status: .eventsWritable, planes: (.planes | map_values(.ok))}'
```

`rollback` restarts the default unit pair on the `previous` release and polls
`/healthz`. The first successful publish has no `previous`; see
[`production-parity.md`](production-parity.md) for that case. Rolling back does
not touch any store: a plane that was down stays down, and the breakers in the
old release (if it predates R2) are simply absent.

## When the plane really is down

- **Greptime** (ledger): `eventsWritable: false`; emits fail open, claims fail
  closed. Nothing to do on the host but wait or roll the store; `docs/greptime-ledger.md`
  for an unwritable-but-reachable table.
- **TimescaleDB** (index): `index: false`; the brief composes from the ledger
  alone, claims and memory writes refuse. Check `capacity.index` on recovery —
  a database near its 500 MB volume is the next incident
  ([`disk-pressure.md`](disk-pressure.md) for the host side).
- **Hindsight / RAGFlow**: `planes.<name>.ok: false`; recalls and docs searches
  answer degraded, retains warn. No status change; agents keep working from the
  index.
- **loopback redis** (cache): `cache.mode: degraded`, `cooldownUntil` set;
  `systemctl status redis-server`. Every read bypasses; nothing is lost.

A breaker closes itself: `openMs` after it opened, one probe goes out, and a
success closes it. No restart is needed for recovery.

## Evidence to record

One row per incident, newest last. Values from `/healthz`, `/slo` and the
journal; never an environment value.

| Date (UTC) | Trigger | Plane(s) | `/healthz` status | breaker opened at → closed at | brief p95 during | action (none / kill switch / rollback) | follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-13 (baseline, no incident) | uplift-2 R2 shipped | — | 200 | — | 3,116 ms (pre-R1) | none | post-deploy: read `/healthz.planes` and `/slo.planes` once per plane |
