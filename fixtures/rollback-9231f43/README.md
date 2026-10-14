# rollback-9231f43 fixtures

Persisted shapes as release `9231f43` (the production release when uplifts 3 and 4
were merged) writes them. They are hand-frozen, never regenerated from the current
code: `packages/mcp-server/src/rollback-compat.test.ts` feeds them to the current
readers, and checks the current writers' real output against the contract the old
readers require. Regenerating one from the new writer would make that check
vacuous.

| File | Old writer | Old reader |
| --- | --- | --- |
| `docs-ingest.json` | `saveIngestRecords` (`docs-ingest.ts`, version 2) | `loadIngestRecords` |
| `brief-snapshot-envelope.json` | `ReadThroughCache.put` of a `brief-snapshot` | `ReadThroughCache.peek` |
| `retain-outbox.jsonl` | `RetainOutbox.append` / `compact` | `RetainOutbox.hydrate` (last line is torn on purpose) |

The values are invented; nothing here is production data.
