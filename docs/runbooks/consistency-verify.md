# Runbook — run the cross-store memory consistency verifier, read its report, repair the safe drift

| | |
| --- | --- |
| Question | After an outage, a parked retain, a forget or a rollback: do the memory index, the Hindsight bank and the ledger still describe the same memory? |
| Trigger | A retain outbox that stayed parked, a failed forget, a restored index or plane, a rollback that forgot memory, or a scheduled check after any of those |
| Who | An operator. Every run reads the **production** index, plane and ledger with their credentials. **`--repair` and `--repair-orphans` write to the production Hindsight plane: OPERATOR ONLY. Nothing here runs automatically, no agent runs it, and no CI job does.** |
| Scope | `memory_entries` (the index, authoritative), one derived Hindsight document per retained entry (rebuildable) and the ledger's `memory.write` notes. Not LightRAG, not Dragonfly, not document text. |
| Blast radius | A plain run only reads. A repair changes plane documents (one re-retain or one delete per finding) and **never** the index or the ledger. |

## The stance

- **The ledger is the only one of the three stores that reaches the chain, and only as roots.** Devnet is evidence of a root, not storage: the anchor memo carries a period, a Merkle root and an event count, never event content, and devnet may reset and publishes no retention window (`docs/runbooks/devnet-reset-and-reanchor.md`). This verifier does **not** read the chain: it neither proves nor needs an anchor. For an anchor use `checkpoint_verify` and `memory_verify`.
- **Mainnet and testnet are out of scope**, as everywhere in this repo.
- **Integrity is not truth.** A clean report says three stores agree. It does not say what they hold is correct.

## What it compares

`packages/mcp-server/src/consistency-verify.ts` (pure, deterministic) and `packages/mcp-server/src/consistency-run.ts` (the runner that opens the stores):

- **index ↔ plane.** Every *current* entry that should be in the plane (not expired, with a `source_event`, a derivable document id, not parked in the outbox) must have its document. A *forgotten* entry (`superseded_by` starts `forgotten:`) must **not**: its absence is intended. A superseded entry owes the plane nothing. A subject-addressed document is shared by every entry with that scope, kind and subject, so a document a live entry still owns is never an orphan and never a forgotten entry's leftover.
- **index ↔ index.** Every stored `entry_hash` must equal the v1 or the v2 digest of the stored content.
- **index ↔ ledger.** Within a bounded recent window, every entry should have one accepted `memory.write` note and every such note one entry.
- Nothing printed carries content: findings hold ids, codes, bank and document ids and a fixed-template sentence.

## Run it

From the release the services run (`/opt/agent-substrate/current`), with the env file loaded by Bun so no URL or token is on a command line:

```sh
cd /opt/agent-substrate/current
bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/consistency-run.ts            # the short summary
bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/consistency-run.ts --json > ~/consistency-"$(date -u +%Y%m%dT%H%M%SZ)".json; echo "exit $?"
```

Grammar (strict: each flag at most once, a value flag takes its value as the **next** argument, never `--bank=B`, no positional argument):

```
consistency-run.ts [--json] [--bank BANK] [--limit N] [--since ISO] [--repair [--repair-orphans]]
```

| Flag | Meaning |
| --- | --- |
| `--json` | the report as byte-stable JSON (keys sorted), one trailing newline. Default: a short summary |
| `--bank BANK` | one bank only. It must start with the configured bank prefix (`HINDSIGHT_BANK_PREFIX`); a desk bank (`pd-*`) is refused and never touched |
| `--limit N` | examine at most N entries, newest first, 1 to 50 000 (default 5 000) |
| `--since ISO` | only entries created at or after this instant, with a time and a zone (`2026-10-01T00:00:00Z`) |
| `--repair` | carry out the safe repairs (below). **OPERATOR ONLY** |
| `--repair-orphans` | only together with `--repair`: also delete plane documents nothing in force owns. **OPERATOR ONLY** |

**Environment, names only (none is new):** `SUBSTRATE_PG_URL` (the index), `GREPTIME_URL` with `GREPTIME_USER`, `GREPTIME_PASSWORD`, `GREPTIME_DB` (the ledger), `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`, `HINDSIGHT_BANK_PREFIX` (the plane), `SUBSTRATE_RETAIN_OUTBOX_PATH` (read-only, to tell a parked retain from a missing one) and `HINDSIGHT_RETAIN_TIMEOUT_MS`. An unset store is refused with exit 2 and names the variable (`SUBSTRATE_PG_URL is not set`, `GREPTIME_URL is not set`, `HINDSIGHT_URL and HINDSIGHT_API_KEY must both be set`) before any connection. The runner never prints a URL, a token or entry content.

Per-run bounds, so a run is cheap and cannot walk a table: 5 000 entries, 500 findings listed, 5 000 plane documents listed, a 7-day ledger window, a 10 s timeout per read, 300 s for the whole run, 4 reads in flight. A bound that cuts a run sets `truncated: true`; counts stay exact for what was examined.

## Read the report

The summary:

```
memory consistency: DRIFT (3 findings) [truncated: a bound cut the run]
  scope    bank all, since start, 5000 entries, 4 bank(s)
  index    ok
  plane    ok
  ledger   store_unreachable (<a redacted reason>)
  finding  hash_mismatch: 1
  finding  index_entry_missing_in_plane: 2
  skipped  duplicate_document:plane_listing_unavailable
  note     retain outbox not readable: a missing document may be a parked retain
  unread   ledger: ok cannot be claimed
```

The verdict is one of `CLEAN` (no findings, every store read, no skipped check), `DRIFT (N findings)` and `INCOMPLETE` (no drift found, but a store or a check could not run). A **truncated but clean** run is still `CLEAN`: look for `[truncated…]` and widen `--limit`, or narrow with `--since` or `--bank`. In the JSON:

| Field | Meaning |
| --- | --- |
| `stores.{index,plane,ledger}.state` | `ok`, `store_unreachable` (with a redacted `reason`) or `not_checked`. A store that could not be read is never reported clean |
| `coverage.plane_listing` | `complete`, `partial`, `unavailable` (the plane has no usable listing route) or `not_checked` |
| `coverage.outbox` | `known` (the parked set was read) or `unknown` (see the limits) |
| `coverage.ledger` | `compared`, `partial` or `not_checked` |
| `coverage.banks` | per-bank plane coverage: `configured` (every bank the server is configured with: each surface's writer bank plus `HINDSIGHT_BANKS`; all of them are listed, whether or not the index has a row for them, so a bank whose rows were swept still has its orphan documents found), `examined` (documents listed and compared), `skipped` (`{bank, reason}`: the listing did not run; each one makes `ok` false) and `listing_truncated` (the `max_documents` bound cut the listing short) |
| `coverage.skipped_checks` | checks that could not run, as `<check>:<reason>`; any entry makes `ok` false |
| `counts` | exact counts: entries examined, current, superseded, forgotten, expected in the plane, parked retains, hash checked and unchecked, shared documents, ledger pairs, `findings_total`, `findings_by_code` |
| `findings[]` | sorted, at most 500: `code`, `id`, `stores`, `bank`, `document_id`, `entry_id` or `event_id`, `detail` |
| `ok`, `truncated` | the verdict; whether a bound cut the run |

```sh
bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/consistency-run.ts --json | jq '.findings[] | select(.code=="hash_mismatch")'
```

## The finding codes

| Code | What it means | Likely cause | Fix |
| --- | --- | --- | --- |
| `index_entry_missing_in_plane` | a current entry has no plane document and no retain is parked for it (or the outbox could not be read, so a parked retain is not ruled out) | a retain that failed or was lost with a memory-only outbox; a wiped or restored plane | `--repair` (action `re_retain`): re-reads the entry, requires it still current and the document still absent, then retains through the existing retain path (idempotent, replace by document id). A retain the gate refuses (expired, unsourced, unredacted, guest) is reported `skipped`, not failed |
| `forgotten_entry_in_plane` | a forgotten entry still has its plane document and no live entry shares it: the forget's plane delete is pending | a forget whose plane delete failed | `--repair` (action `delete_forgotten_document`): requires the entry still forgotten, the document present and not shared, then deletes it |
| `plane_document_orphan` | a plane document no entry accounts for: it names no entry, names an entry the index lacks, or names an entry a later write superseded | a deleted or superseded entry whose document was never removed; a document written by something else | with an entry id: `--repair --repair-orphans` (`delete_orphan_document`) deletes it if it is still orphaned. **Without an entry id: no automatic repair; inspect it by hand** |
| `duplicate_document` | a second plane document names an entry that already has its own | a retain under a changed idempotency key | `--repair --repair-orphans`, only while the entry's own document exists (otherwise `skipped`: "re-retain it first") |
| `hash_mismatch` | the stored `entry_hash` matches neither the v1 nor the v2 digest of the stored content | the row was changed after the gate wrote it, **or** a row written before the gate. Both are possible | **No automatic repair.** The index is authoritative: review the row, compare it with a backup or archive (`docs/runbooks/index-archive.md`), and treat an unexplained one as an integrity incident. Rows with an empty hash are not checked (`hash_unchecked`) |
| `index_entry_without_ledger_write` | an entry in the judged window has no accepted `memory.write` note for its writer, kind and scope within 120 s after it | a write whose note was lost; the ledger was down at that moment | **No automatic repair** (the ledger is append-only). Review by hand |
| `ledger_write_without_entry` | an accepted `memory.write` note has no entry created within 120 s before it | an idempotent replay; an entry the retention sweeper deleted; a write whose row was lost | **No automatic repair.** Review by hand; an isolated one is usually a replay |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | consistent: no findings, every store read, no skipped check |
| 1 | drift found (and everything could be read) |
| 2 | usage or refusal: a bad flag, `--bank` outside the prefix, an unset store |
| 3 | a store was unreachable or a check could not run, so `ok` cannot be claimed. It **wins over 1**: the JSON still lists the drift that was found |

A repair does not change the exit code. **Re-run the verifier to confirm.** Exit 3 is also what you get when the plane has no document listing route (see the limits): until that is settled the verifier cannot return 0, by design.

## Repair

Only two kinds of change exist, both **plane writes**: re-retain one document, or delete one document. There is no index write and no ledger write in the executor to call. `--repair` runs only when both the index and the plane were read (otherwise `repair skipped: the index and the plane must both have been read`). For each action it **re-reads the world first** and acts only if the finding still holds: `already_consistent` if someone fixed it, `skipped` if the entry or document changed in a way that makes the action unsafe, `failed` if a port threw (the reason redacted, URLs stripped). An action that is not exactly the shape the planner produces is refused (`plan refused`).

- `--repair` runs the **safe** class: `re_retain` and `delete_forgotten_document`.
- `--repair-orphans` (never alone) adds the **orphan** class: `delete_orphan_document`, for `plane_document_orphan` with an entry id and `duplicate_document`. Without it those actions are reported `skipped: orphan deletion needs --repair-orphans`.
- **A repair leaves no ledger trace.** The retain path's own warnings are captured and returned in the outcome, not emitted: write what you ran and its outcome in your incident notes.
- A plan is `complete: false` when the findings list was cut (more than 500) or a store was unreachable; repair what is listed, then re-run.
- Run it in this order: summary; `--json` saved; read the findings; `--repair`; re-run; only then `--repair --repair-orphans` if orphans remain and you have looked at them.

## Limits, stated plainly

1. **The ledger pairing is heuristic.** A `memory.write` note carries the decision, the writer surface, the canonical scope, the kind and the time, **never the entry id**. Entries and notes are therefore paired inside a bucket of writer, scope and kind, in time order, within a lag of 120 s after the entry and a skew of 30 s before it. The counts are exact within a bucket and the identity is approximate: a replayed idempotent write or a swept entry shows as `ledger_write_without_entry`. The window is the last seven days (or `--since`), and writes younger than 60 s are not judged.
2. **The Hindsight listing route is unverified.** `planes/hindsight.ts` has no document listing, so the runner asks `GET <plane>/v1/default/banks/<bank>/documents?limit=&offset=` itself and reads `items[].id` and `total`. A 404 on a bank that exists, 405, 501, a non-JSON answer or a body without `items` means the plane has no such route: the orphan and duplicate checks are **skipped and reported** (`skipped_checks: …:plane_listing_unavailable`, `coverage.plane_listing: unavailable`), never read as "no documents", and the run exits 3. This route was **not exercised against a live plane**; point lookups (`getDocument`) are used for the missing-document and forgotten-document checks either way.
3. **A memory-only outbox cannot be read.** With `SUBSTRATE_RETAIN_OUTBOX_PATH` unset the parked retains live in the server process's memory and the runner cannot see them: `coverage.outbox` is `unknown`, and an `index_entry_missing_in_plane` may be a retain still waiting. The summary says so. With the path set, the runner reads the file **without** opening it as the live outbox (that would rewrite the file the server owns) and skips lines that do not parse.
4. **Bounded scans.** Only the newest `--limit` entries are judged, and older entries' ledger notes are not. A bound that cut the run says `truncated`.
5. **Rows older than the gate have no hash** and are counted as `hash_unchecked`, not checked.
6. **It compares presence, not content.** It does not compare the plane document's text with the index text, does not read LightRAG or Dragonfly, and does not verify any anchor.
7. **It reads production under load.** Reads are bounded and concurrent up to 4; run it off peak after a large outage.

## Abort and rollback

A plain run changes nothing: stop it at any point. A repair has no undo in this tool, but it only touches the derived plane copy: a deleted plane document is rebuilt by `--repair` re-retaining its current entry, and a document re-retained by mistake is removed again by the matching delete action. The index and the ledger are never written, so the authoritative copies stay as they were.

## What this does not prove

A `CLEAN` run says the three stores agree on presence and hash, inside the bounds above. It does not say the memory is true, that the plane's text matches the index's, or that anything is anchored.
