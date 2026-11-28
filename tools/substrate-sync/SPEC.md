# substrate-sync — SPEC

Idempotent Linear/Notion sync client with offline retry.

Files:

- `client.sh` — sync entrypoint (`sync`, `drain`, `--self-test`).
- `queue.sh` — local JSON retry queue (sourceable library + CLI).

## 1. Goals / non-goals

Goals: exactly-once-visible sync of titled records to Linear and Notion,
offline-tolerant delivery, safe re-runs, no secret leakage.

Non-goals: full Linear/GraphQL and Notion schema coverage, bidirectional
sync, conflict resolution beyond last-writer-wins update-in-place.

## 2. Idempotency

Every record carries a caller-chosen stable `key` (e.g. issue identifier or
slug). `sync_record <kind> <key> <title> <body-json>` always performs
**existence search before create**:

1. Search the backend for `key` (GraphQL `issues(filter:…)` for Linear,
   `/v1/search` for Notion, key lookup in the fixture store).
2. If found → **update in place** (same id, new title/body). Prints `updated`.
3. If absent → create. Prints `created`.

Re-running the same sync therefore converges to `updated` with no new rows.
The draining path reuses the same function, so retries cannot duplicate
either. The `--self-test` fixture run proves this: sync 3 records twice,
assert pass 2 reports `updated=3, created=0` and store counts stay `2/1`.

## 3. Offline queue (`queue.sh`)

Storage: one JSON array file (default `./.substrate-sync-queue.json`,
override with `SUBSTRATE_SYNC_QUEUE_FILE`). Entry shape:

```json
{"id": "…", "kind": "linear.issue", "op": "upsert", "key": "…",
 "payload": {"title": "…", "body": {…}}, "attempts": 0,
 "next_retry_at": 0, "enqueued_at": 123, "last_error": ""}
```

Rules:

- `queue_enqueue` dedups on `(kind, key, op)`: re-enqueue replaces the
  pending entry instead of appending a second one.
- Mutations are atomic (`jq` → temp file → `mv`) under an `flock` on
  `<queue>.lock`. Corrupt files are backed up to `<queue>.corrupt.<ts>.bak`.
- `queue_fail` applies exponential backoff
  `min(BASE * 2^(attempts-1), MAX)` via `next_retry_at`; `drain` only
  processes due entries (`next_retry_at <= now`), acks on success.
- Queue payloads carry content only — never credentials.

CLI: `queue.sh {enqueue <kind> <op> <key> <payload>|list|size|due|
ack <id>|fail <id> <error>|clear}`.

## 4. Retry / backoff

- API layer (`api_call`): retries transient statuses
  (`429/500/502/503/504`/network `000`) up to `SUBSTRATE_SYNC_MAX_ATTEMPTS`
  (default 5) with `sleep(min(BASE * 2^(n-1), MAX))`, `BASE=2s`, `MAX=60s`
  by default. Other 4xx are permanent and return immediately.
- Queue layer: `queue_fail` uses the same exponential shape with independent
  tunables `SUBSTRATE_SYNC_RETRY_BASE_SECS=5`,
  `SUBSTRATE_SYNC_RETRY_MAX_SECS=3600`.
- Fixture mode skips sleeps so tests stay fast.

## 5. Dry-run

`--dry-run` flag or `SUBSTRATE_SYNC_DRY_RUN=1`: prints the planned
`create|update` per record (resolved via the same existence search in
fixture mode) and returns `dry-run` without network calls, fixture writes,
or queue mutations.

## 6. Credentials and secret hygiene

- Env-only: `LINEAR_API_KEY`|`LINEAR_TOKEN`,
  `NOTION_API_KEY`|`NOTION_TOKEN`. No flags, no files, no defaults.
- Every log line passes through `redact()`, which scrubs `Bearer …`,
  `api-key…`, and `token…` values to `[REDACTED]` before printing.
- `curl` receives the token via header argument only; tokens never appear in
  `ps`-safe log output, queue files, or fixture stores.
- Missing credential for the requested backend is a hard error (`die`),
  never an anonymous request.

## 7. Interfaces

```bash
client.sh [--dry-run] sync <linear.issue|notion.page> <key> <title> '<body-json>'
client.sh [--dry-run] drain
client.sh --self-test
```

Exit 0 on success (including `queued` for later retry); non-zero on usage
errors, permanent API failures outside the queue path, or self-test failure.

## 8. Verification

```bash
shellcheck tools/substrate-sync/*.sh
tools/substrate-sync/client.sh --self-test
# self-test PASS: re-run created 0 duplicates (updated=3, linear=2, notion=1, queue=0)
```

Expected self-test output: first pass `created × 3`, second pass
`updated × 3 / created × 0`, store counts `linear=2, notion=1`, queue `0`,
plus a dry-run no-mutation check.
