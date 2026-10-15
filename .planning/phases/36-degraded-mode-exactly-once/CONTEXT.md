# Phase 36 CONTEXT: degraded-mode-exactly-once

Gap (MILESTONE-AUDIT rows 23-25, item 3): with the substrate unavailable a dependent client
must finish degraded, and queued writes must apply exactly once. Audit status was FAIL: "503
exists; no queued replay for memory or skills; untested."

## 503 sources on the write paths (read, file:line)

Memory (`POST /memory`):
- `server.ts:1070-1084` the route. It passes the whole body, including `idempotency_key`, to
  `substrate.writeMemory`, then answers `memoryWriteStatus(result)`.
- `server.ts:410-422` `memoryWriteStatus`. Any `denied` whose reason starts with `store.` is 503
  (line 421). Other denials are 403.
- `service.ts:1874-1885` `writeMemory`. No index configured gives `denied / store.unavailable`.
- `service.ts:1906-1921` the gate call is wrapped. A throw gives `denied / store.write-failed`
  (line 1913) and sets `commitUncertain` (line 1921), because the row may have committed.

Skills (`POST /skills/approve`, `POST /skills/propose`):
- `service.ts:2812` and `2841`: `SkillApprovalFailed(503)` when the index is absent or
  `decideSkill` throws. `server.ts:1426-1453` maps it.
- Propose has no 503 of its own. Its failures map to 4xx or 5xx by `proposalFailure`
  (`server.ts:1397-1424`).

## Exactly-once that already exists

Memory (`MemoryWriteRequest.idempotency_key`, `types.ts:318-324`):
- Explicit key claimed in the same Postgres as the entry: `memory_writes` (`index-store.ts:434`),
  `claimWrite` (`index-store.ts:1377`), insert fenced on the claim (`insertEntry`).
- Claim step: `memory-write.ts:658-671`. Replay: `memory-write.ts:1033` (`replay`), which
  returns `deduplicated: true` for an accepted record.
- Explicit keys never expire (`memory-write.ts:66`). Keyless writes get a derived key, window
  24 h (`memory-write.ts:358-365`, `DERIVED_KEY_WINDOW_MS`). That is the behaviour to keep.
- Existing coverage: `memory-write.test.ts:1395` ("the same explicit key never writes twice"),
  `:1446` (failure before insert releases the key), `:1145` (committed-but-unacknowledged row is
  recovered), `index-store.memory.test.ts` (live PG).

Skills:
- Approve is idempotent on its natural key (repo, name, pr_number) in one transaction under a
  row lock (`index-store.ts:1856-1923`). A repeat answers `exists` with no second row and no
  event (`skills/registry.ts:28`; `skills-approve.test.ts:357`).
- Propose is idempotent by content hash through the local proposal ledger and `gh pr view` /
  `gh pr list --head` (`skills/propose.ts:720-749`, `:811-892`). It writes git, gh and a JSONL
  file, so it cannot keep a key in the index database.

## Dependent in-repo clients

1. Lessons CLI, `packages/cli/src/lessons.ts`. The only in-repo writer of memory that runs as a
   client. It uses `POST /memory` (`:939-941`, `send` at `:888-898`).
   - Explicit deterministic keys are sent (`:1315`, `:1591`, `:1687`).
   - A 503 is parsed as a gate reply, not as a transport failure. `interpret` maps
     `outcome: "denied"` to status `denied` (`:759-760`). So an outage is reported as a refusal,
     even though the remedy text says "retry once it is reachable".
   - `writeGoverned` (`:1114-1157`) retries only on `unverified`. It returns `unreachable`
     solely for a transport throw (`:1130-1136`). There is no queue and no degraded state.
2. Skills CLI, `packages/cli/src/skills.ts`. `propose` (`:234-266`) and `approve` (`:404-439`).
   A 5xx is `status=failed` and exit 1. Nothing is queued.
3. Omp skill client, `packages/projector/omp/substrate-skills.ts:205-240`. Already queues the
   exact propose body to `~/.omp/agent/substrate-pending/` on 5xx, 401 or transport error
   (`:208-212`). It is drained by the bridge (`packages/miner/src/substrate_miner/bridge.py:52`,
   `docs/skills-plane.md:20-23`). A skill-side queue therefore already exists, outside this phase.
4. MCP `memory_write` (`mcp.ts:348`). Agent-facing tool; not a queued client.

## Decisions taken

- D1. Memory needs no new key field. `idempotency_key` already exists, is named consistently
  with events (`idempotency_key`), and is stored in the same DB. Adding a second key would split
  the claim from the write. Tests only.
- D2. Skills get no new key store in this phase. Approve and propose already dedupe on their
  natural identities, in the DB (approve) or the ledger (propose). A new `skills_idempotency`
  table would be a second mechanism with no in-repo caller. Reported as GREY_AREA.
- D3. Keyless memory behaviour is unchanged. A keyless identical retry dedupes for 24 h today.
  The brief's "a write without a key still writes each time" is read as "new content writes
  each time". Asserted, not altered.
- D4. Step 3 (queue in the lessons CLI) is stopped and reported. See SUMMARY.md.
- D5. The live-PG takeover case cannot be tested: the PG store reads staleness from the database
  clock (`index-store.ts:1387-1405`), so the in-flight timeout cannot be fast-forwarded. The
  immediate retry (conflict, one row) is tested live; the takeover is covered by the fake store.
