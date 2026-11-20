# Phase 76: Telemetry buffer and dead-letter — Operator UAT

**Phase:** 76-telemetry-buffer-dead-letter
**Created:** 2026-11-19 (from VERIFICATION.md `human_needed`, 2/2 success criteria verified in repo code)
**Status:** deferred — operator gates only; all repo-verified parts are in VERIFICATION.md with `file:line` evidence.
**code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply)**

Each item below names the operator action, the exact expected result, and a resume command. Work them in order; none require code changes unless the decision in item 2 or 3 says otherwise.

## 1. Systemd paths (operator gate)

**Why deferred:** `infra/vps/substrate-mcp.service` and its `.d` drop-ins set neither `SUBSTRATE_LEDGER_BUFFER_PATH` nor `SUBSTRATE_LEDGER_DEAD_LETTER_PATH`, so production runs memory-only (CONTEXT D76-11). A memory-only restart loses parked events; shutdown dead-letters them (`index.ts:255` abandon pass) and memory-only dead letters are lost at exit.

**Steps:**

1. Pick a state directory (e.g. `/var/lib/substrate/`) owned by the service user, mode `0700`.
2. In `infra/vps/substrate-mcp.service` (or a `.d` drop-in), set:
   ```
   SUBSTRATE_LEDGER_BUFFER_PATH=/var/lib/substrate/event-buffer.jsonl
   SUBSTRATE_LEDGER_DEAD_LETTER_PATH=/var/lib/substrate/dead-letters.jsonl
   ```
   Bounds stay flag-driven: `SUBSTRATE_LEDGER_BUFFER_MAX` (default 1000), `SUBSTRATE_LEDGER_BUFFER_MAX_ATTEMPTS` (default 10), `SUBSTRATE_LEDGER_DEAD_LETTER_MAX` (default 10000).
3. `systemctl daemon-reload && systemctl restart substrate-mcp`.

**Expected:** Buffer and dead-letter files are created `0600` under the state directory. After a restart with a parked event, `curl localhost:PORT/healthz` reports `eventBuffer.pending >= 1`, `eventBuffer.durable: true`, `eventBuffer.deadLetters.durable: true` (shape from `service.ts:9028` `eventBufferHealth()`).

**Resume command:** after daemon-reload + restart, `curl -s localhost:PORT/healthz | jq .eventBuffer` and confirm `pending >= 1` with both `durable` fields true after a restart that had a parked event.

## 2. Claim-withdrawal policy (operator gate)

**Why deferred:** Since `e20f3634` a parked claim is recorded and kept (`service.ts:5607`: `recorded = emitted.stored || emitted.buffered === true`); withdrawal happens only for dead-lettered or refused events. If a parked event is lost (memory-only restart — see item 1 — or a crash), its claim stays held with no ledger event behind it.

**Steps:** Record the decision — either (a) phase-78 reconcile releases or re-emits claims held for events that never landed, or (b) an operator procedure documents how to release such a claim. Write the decision into the phase CONTEXT/SUMMARY or an ADR; if it needs code, open a follow-up plan and re-verify.

**Expected:** A recorded decision with an owning path (reconcile job or operator procedure) for held claims whose buffered event never lands.

**Resume command:** append the decision to `.planning/phases/76-telemetry-buffer-dead-letter/CONTEXT.md` (and `docs/observability.md` if operators need it), then note the outcome in this file.

## 3. D76-01 scope decision (refusals before the write)

**Why deferred:** The buffer takes a failed `insertEvent` only (CONTEXT D76-01). Two refusals before the write stay `stored: false` with no buffering: a chain tip that cannot be read (the event's hash is over an unknown `prev`) and a ledger that is not append-only. The phase goal says "No event is dropped silently", so this needs an explicit call.

**Steps:** Decide between (a) buffering those inputs with the hash computed at drain time once the tip is known, or (b) an explicit accepted-loss statement that also covers long ledger outages (the ~13.5-minute retry window from `SUBSTRATE_LEDGER_BUFFER_MAX_ATTEMPTS=10` bounds tolerance). Reflect the decision in `docs/greptime-ledger.md` "Not covered" and CONTEXT D76-01.

**Expected:** A written decision on D76-01, visible in the docs' "Not covered" section either way.

**Resume command:** edit `docs/greptime-ledger.md` and `CONTEXT.md` with the decision, then re-run verification for phase 76.
