# U5-4b env notes — collector / CLI event spool (client half)

Paste after the `SUBSTRATE_RETAIN_*` block in `.env.example` (or next to the collector settings). These are read by the
collectors, hooks and the `substrate` CLI, not by `substrate-mcp`; they belong in each collector's env file
(`/etc/substrate/substrate-collector-<name>.env`) and in the environment of hooks and CLI callers. The server flag they
pair with, `SUBSTRATE_EVENT_IDEMPOTENCY`, is slice U5-4a's.

```
# ── Collector event spool (uplift-5 U5-4b) ──────────────────────────────────
# off (default): a failed event is dropped and counted, exactly as before, and no spool file is touched.
# on: a retryable failure (network error, timeout, 5xx, 503 stored:false) is parked in
# ${SUBSTRATE_STATE_DIR}/event-spool.jsonl (0600) and replayed with x-substrate-replay: 1 and the same
# idempotency key. A 4xx is never parked. Turn it on only after the server reports "idempotency": "accept"
# (or "enforce") on /healthz; the client refuses to replay against a server that does not. docs/collectors.md.
SUBSTRATE_EVENT_SPOOL=off
# Most parked lines; over it the oldest is dropped with a visible `dropped` line in refused-emits.jsonl.
SUBSTRATE_EVENT_SPOOL_MAX=5000
# Most bytes in the spool file; over it the oldest are dropped, visibly.
SUBSTRATE_EVENT_SPOOL_MAX_BYTES=8388608
# Hours a parked event is kept before it is dropped, visibly, unsent.
SUBSTRATE_EVENT_SPOOL_TTL_H=48
# Delivery attempts per event, the live one included; the last failure drops it, visibly.
SUBSTRATE_EVENT_SPOOL_MAX_ATTEMPTS=12
# refused-emits.jsonl rotates to refused-emits.jsonl.1 (one rotated file) at this size.
SUBSTRATE_REFUSED_EMITS_MAX_BYTES=1048576
```

Notes for the person pasting:

- Parsing, per cap: unset/blank = default (silent); not a positive integer (incl. `0`) = default + one stderr warning;
  below the minimum = the minimum + warning (`_MAX_BYTES` min 1024; `SUBSTRATE_REFUSED_EMITS_MAX_BYTES` min 4096);
  above the ceiling = the ceiling + warning (100000 lines, 64 MiB, 720 h, 100 attempts, 64 MiB for the refused journal).
  `_MAX` / `_TTL_H` / `_MAX_ATTEMPTS` minimum is 1. Nothing throws. `SUBSTRATE_EVENT_SPOOL` unknown value = `off` + warning.
- `SUBSTRATE_STATE_DIR` (already documented) decides where both files live; herdr/grok's own state files still follow
  `SUBSTRATE_COLLECTOR_STATE`.
- No new unit and no `StateDirectory` change: the collector units already have `StateDirectory=substrate`.
