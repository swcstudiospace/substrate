# Phase 27: Ledger primitives and ingest order - Pattern Map

**Mapped:** 2026-10-08
**Files analyzed:** 22 new or modified files (10 ported ledger files, 1 new barrel, 11 modified repo files)
**Analogs found:** 22 / 22. Every file has an in-repo analog or a byte-identical port source.

All line numbers refer to the worktree `/root/src/worktrees/agent-substrate-v13-p27` at HEAD `3971728`, unless they are prefixed `acc30a8:` (read with `git show acc30a8:<path>`) or `p16:` (the Phase 16 worktree `/root/src/worktrees/agent-substrate-v13-phase` at `39072ac`, which is read-only here). Every analog path named below is git-tracked source. There are no `.claude/` or `.agents/` skill directories and no `CLAUDE.md`, so the repo rules come from `AGENTS.md` and the store and redaction locks.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/ledger/src/merkle.ts` (+`merkle.test.ts`) | utility (pure crypto) | transform | `acc30a8:packages/ledger/src/merkle.ts` | exact (byte-identical port) |
| `packages/ledger/src/memo.ts` (+test) | utility (format/parse) | transform | `acc30a8:packages/ledger/src/memo.ts` | exact (port) |
| `packages/ledger/src/period.ts` (+test) | utility (time math) | transform | `acc30a8:packages/ledger/src/period.ts` | exact (port) |
| `packages/ledger/src/rpc.ts` (+test) | service client (JSON-RPC reader) | request-response | `acc30a8:packages/ledger/src/rpc.ts` | exact (port) |
| `packages/ledger/src/solana.ts` (+test) | utility (argv builder plus `execFile` runner) | request-response (subprocess) | `acc30a8:packages/ledger/src/solana.ts` | exact (port) |
| `packages/ledger/src/index.ts` (NEW) | barrel / package entry | n/a (re-export) | `packages/audit/src/index.ts`, `packages/evidence/src/index.ts` | exact role |
| `packages/mcp-server/package.json` | config | n/a | its own `dependencies` block (lines 7-13) | exact |
| `bun.lock` | config (lockfile) | n/a | `bun.lock:46-56` (`packages/mcp-server` workspace block) | exact |
| `packages/mcp-server/src/greptime.ts`: `IngestNotRecorded` | error class | n/a | `greptime.ts:19-22` (`GreptimeError`, `AppendOnlyViolation`) | exact |
| `greptime.ts`: `migrate()` (+`event_ingest`, canonical `anchors`, shape check) | store client (DDL) | batch / boot | `greptime.ts:343-419` (`migrate`), `:448-465` (`appendModeEnabled`), `acc30a8:greptime.ts:208-235` (`anchors` DDL, `columns()`) | exact |
| `greptime.ts`: `insertEvent()` (+ingest record) | store client (write) | CRUD append | `greptime.ts:467-488` (`insertEvent`) | exact |
| `greptime.ts`: `hourLeaves()` (NEW) | store client (read) | request-response, batched reads | `greptime.ts:513-552` (`queryEvents`), `:490-511` (`lastHash`), `acc30a8:greptime.ts:271-276` (`hourEvents`) | role-match (new composition) |
| `packages/mcp-server/src/greptime.test.ts` | test | stubbed `fetch` | `greptime.test.ts:44-74` (`defaultReply`, `insertStatement`, `stubFetch`), `:155-215`, `:288-376`, `:580-584` | exact |
| `packages/mcp-server/src/service.ts`: `append()` mapping | service | request-response | `service.ts:564-593` (`append`) | exact |
| `service.ts`: `hourDigest()` (NEW) + `HourDigest` type | service | request-response (typed read plus pure transform) | `service.ts:1428-1452` (`verifyGraph`), `:613-643` (`queryEvents`) | role-match |
| `packages/mcp-server/src/service.test.ts` | test | structural stubs | `service.test.ts:590-676` (`emit` `ledger()`), `:1363-1377`, `:1666-1694` (stderr capture) | exact |
| `scripts/greptime-smoke.ts` | live proof script | batch, live I/O | itself, `:44-57`, `:110-152`, `:231-238` | exact |
| `docs/greptime-ledger.md` | doc | n/a | its own `## Schema` (`:39-67`), `### Why append_mode is not optional` (`:69`), `## Smoke test` (`:340-367`), `### Verification status` (`:369-384`) | exact |
| `README.md:73` | doc | n/a | the neighbouring package lines `README.md:68-78` | exact |

## Pattern Assignments

### `packages/ledger/src/{merkle,memo,period,rpc,solana}.ts` and their five `*.test.ts` (utility, transform; byte-identical port)

**Source:** `acc30a8:packages/ledger/src/<file>`. No analog search is needed: D27-01 makes these a byte-identical copy.

**Port command (RESEARCH Q1):**
```bash
for f in merkle memo period rpc solana; do
  git show acc30a8:packages/ledger/src/$f.ts > packages/ledger/src/$f.ts
  git show acc30a8:packages/ledger/src/$f.test.ts > packages/ledger/src/$f.test.ts
done
# identity proof for the SUMMARY
for f in merkle memo period rpc solana; do for s in "" .test; do
  cmp <(git show acc30a8:packages/ledger/src/$f$s.ts) packages/ledger/src/$f$s.ts; done; done
```

**Import convention the port already follows** (relative `./x.ts`, which `allowImportingTsExtensions` and `verbatimModuleSyntax` in `tsconfig.json` require):
```ts
// acc30a8:packages/ledger/src/memo.ts:6
import { HOUR_MS, hourIso } from "./period.ts";
// acc30a8:packages/ledger/src/rpc.ts:7
import { MEMO_PROGRAM_IDS, stripListingPrefix } from "./memo.ts";
// acc30a8:packages/ledger/src/solana.ts:7-9
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { parseMemo } from "./memo.ts";
```

**The primitives Phase 27 calls** (verbatim, so the planner can cite them in actions):
```ts
// acc30a8:packages/ledger/src/merkle.ts:19-26 — empty input throws by design (D27-15's null root)
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
	if (leaves.length === 0) throw new Error("merkleRoot: empty input (an empty hour is never anchored)");
	...
// acc30a8:packages/ledger/src/merkle.ts:43-49
export function merkleRootHex(hashes: readonly string[]): string {
	for (const [i, h] of hashes.entries()) {
		if (!HASH_HEX_RE.test(h)) throw new Error(`merkleRootHex: entry ${i} is not 64 lowercase hex characters`);
	}
	return bytesToHex(merkleRoot(hashes.map(hexToBytes)));
}
// acc30a8:packages/ledger/src/memo.ts:22-29
export function formatMemo({ periodStartMs, rootHex, count }: Memo): string {
	if (!Number.isSafeInteger(periodStartMs) || periodStartMs % HOUR_MS !== 0) {
		throw new Error("formatMemo: period is not a whole UTC hour");
	}
	...
	return `${MEMO_PREFIX}${hourIso(periodStartMs)}:${rootHex}:${count}`;
}
// acc30a8:packages/ledger/src/period.ts:9-26
export function hourStart(ms: number): number { return Math.floor(ms / HOUR_MS) * HOUR_MS; }
export function hourEnd(hourStartMs: number): number { return hourStartMs + HOUR_MS; }
export function isClosed(hourStartMs: number, nowMs: number, lagMs: number): boolean {
	return nowMs >= hourEnd(hourStartMs) + lagMs;
}
```

**D27-06 note:** `acc30a8:packages/ledger/src/memo.ts:11` reads `/** Memo v4 (what solana-cli 4.2.2 writes), v3 and v1; readers accept any of them. */` and carries no `[UNVERIFIED]` marker. Do not edit it, because that would break byte-identity. Record the claim as unverified in the plan SUMMARY instead.

**Test idiom the port carries** (`bun:test`, relative import, fixed UTC constants): `acc30a8:packages/ledger/src/period.test.ts:1-6`
```ts
import { describe, expect, test } from "bun:test";
import { closedHours, HOUR_MS, hourEnd, hourIso, hourStart, isClosed } from "./period.ts";

const H10 = Date.UTC(2026, 8, 26, 10);
const H11 = Date.UTC(2026, 8, 26, 11);
const LAG = 5 * 60_000;
```

**Lock constraints that apply to every file under `packages/ledger/src/`** (`store-lock.test.ts:110-130`; these paths are outside `mayReachLedger`):
- no `from "...greptime..."` import and no `new GreptimeClient` (`:113`);
- no `/(FROM|INTO|UPDATE|TABLE)\s+"?agent_events"?/i` anywhere. This includes **comments and prose**, because the regex is case-insensitive, so a phrase like "reads from agent_events" trips it (`:119`);
- no `GREPTIME_` anywhere, comments included (`:127`).

The ported files are already clean (RESEARCH Q7: 63/63). The new `index.ts` header comment must keep to the same rules.

---

### `packages/ledger/src/index.ts` (NEW; barrel, re-export only)

**Analog:** `packages/audit/src/index.ts` (and `packages/evidence/src/index.ts`, `packages/observability/src/index.ts:1-30`)

**Header plus grouped `export { type X, Y } from "./file.ts"` pattern** (`packages/audit/src/index.ts:1-17,39-45`):
```ts
/**
 * `@substrate/audit` — the hash-chained record of what agents asked substrate-mcp
 * to do and whether it was allowed.
 *
 * Deliberately not `agent_events`. See the header of `record.ts` and
 * `docs/mcp-audit.md`.
 */
export {
	type AuditDecision,
	type AuditMode,
	...
	verifyAuditChain,
} from "./record.ts";

export {
	type AuditAppend,
	type AuditLogOptions,
	type MissingHistory,
	AuditLog,
	AuditUnavailableError,
} from "./log.ts";
```
`packages/evidence/src/index.ts:1-6` shows the same short "`@substrate/x` — what it is, and who calls it" header.

**Export list** (RESEARCH "Code Examples", compiled clean under main's tsconfig). Lay it out one `export { … } from "./x.ts"` block per module, in the audit-barrel style above:
- `./merkle.ts`: `bytesToHex, hexToBytes, merkleRoot, merkleRootHex`
- `./memo.ts`: `formatMemo, type Memo, MEMO_PREFIX, MEMO_PROGRAM_IDS, MEMO_RE, parseMemo, stripListingPrefix`
- `./period.ts`: `closedHours, HOUR_MS, hourEnd, hourIso, hourStart, isClosed`
- `./rpc.ts`: `type AddressMemo, bs58decode, type Commitment, createRpc, type Rpc, RpcError, type RpcOptions, type TransactionMemo`
- `./solana.ts`: `AMOUNT_ONE_LAMPORT, AMOUNT_ZERO, execFileRunner, keygenPath, parseSignature, pubkeyArgv, type Runner, type RunResult, SOLANA_CLI_DEFAULT, type TransferMemoInput, transferMemoArgv`

The header must state that the package is pure (no store client, no SQL, no environment reads). Per the lock rules above, phrase it without `GREPTIME_` and without "from/into/table agent_events". A safe wording: "`@substrate/ledger` — pure anchoring primitives: the RFC 6962 root, the v1 memo, UTC hour periods, and the Solana RPC and CLI helpers. It holds no store client and composes no SQL; the ledger client in `@substrate/mcp-server` is the only caller."

---

### `packages/mcp-server/package.json` and `bun.lock` (config)

**Analog:** the existing workspace dependencies, `packages/mcp-server/package.json:7-13`:
```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.1",
    "@substrate/audit": "workspace:*",
    "@substrate/evidence": "workspace:*",
    "@substrate/observability": "workspace:*",
    "zod": "^4.6.5"
  }
```
Insert `"@substrate/ledger": "workspace:*",` alphabetically, after `@substrate/evidence` and before `@substrate/observability`.

**`bun.lock`:** the mirror block is `bun.lock:46-56`. The resolution entry already exists at `bun.lock:81` (`"@substrate/ledger": ["@substrate/ledger@workspace:packages/ledger"]`) and the workspace at `:43`. `bun install` adds exactly one line under `"packages/mcp-server".dependencies` (RESEARCH Q3). Commit it: `--frozen-lockfile` does **not** catch its absence.

**Consumer import idiom** (bare workspace specifier, value plus `type` in one statement): `service.ts:8`
```ts
import { decideClaim, type ClaimDecision } from "@substrate/audit";
```
and `observe.ts:42`, `server.ts:27`. **Not usable from `scripts/`**: the root package has no dependency on it (RESEARCH Q3, Pitfall 8). The smoke uses the relative path (see below).

---

### `packages/mcp-server/src/greptime.ts`: `IngestNotRecorded`, `INGEST_LAG_MS`, constructor clock seam

**Analog:** `greptime.ts:17-22`
```ts
const DEFAULT_TIMEOUT_MS = 5000;

export class GreptimeError extends Error {}

/** A statement the ledger client refuses to send. See `assertAppendOnly`. */
export class AppendOnlyViolation extends GreptimeError {}
```
Add `IngestNotRecorded extends GreptimeError` here, with a one-line doc comment in the same voice, and export `INGEST_LAG_MS = 300_000` next to `DEFAULT_TIMEOUT_MS`. RESEARCH Open Question 3 recommends it lives in `greptime.ts`, which keeps `period.ts` byte-identical. Its doc comment should name its relation to the 5 s write timeout.

**Constructor DI seam** (`greptime.ts:246-249`). Add a third defaulted parameter so `new GreptimeClient(config)` (tests, `greptime.test.ts` throughout) and `new GreptimeClient(config.greptime)` (`service.ts:473`) stay valid:
```ts
	constructor(
		private readonly config: GreptimeConfig,
		private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
	) {}
```
The precedent for an injectable `now` is `ensureAppendMode(now = Date.now())` (`greptime.ts:437`).

**Imports to add** (`greptime.ts:14-15` is currently types only):
```ts
import type { GreptimeConfig } from "./config.ts";
import type { SubstrateEvent } from "./types.ts";
```
Add `import { hourEnd, hourStart, isClosed } from "@substrate/ledger";`. `greptime.ts` is the only mcp-server file that needs `hourEnd` for SQL bounds.

---

### `greptime.ts`: `migrate()` additions (store client, DDL at boot)

**Analog:** `greptime.ts:343-419`.

**Warn-don't-fail scaffold, and where the new DDL goes.** It must come after the `agent_events` try/fallback block (`:379-388`) and before the probe (`:401`), because the existing tests index `sql[0]` and `sql[1]` positionally (RESEARCH Pitfall 2):
```ts
	async migrate(): Promise<{ warnings: string[] }> {
		const warnings: string[] = [];
		...
		try {
			await this.sql(
				`CREATE TABLE IF NOT EXISTS "agent_events" (${columns}) WITH ('append_mode' = 'true')`,
			);
		} catch (cause) {
			// An older Greptime may not know the option. ...
			await this.sql(`CREATE TABLE IF NOT EXISTS "agent_events" (${columns})`);
			warnings.push(`agent_events created without append_mode: ${String(cause)}`);
		}

		await this.sql(`
			CREATE TABLE IF NOT EXISTS "anchors" (          // <- lines 390-399: REPLACE (D27-19)
				...
				PRIMARY KEY ("root")
			)
		`);

		await this.probeDialect();
		...
		return { warnings };
	}
```

**`event_ingest` DDL.** Copy the try/catch shape above, but **with no plain-CREATE fallback** in the catch: push a warning and continue. This is RESEARCH Pattern 1 and Anti-Pattern 3, because a non-append no-PK table deduplicates on the time index alone. The statement was proven on v0.14.4:
```sql
CREATE TABLE IF NOT EXISTS "event_ingest" ("ingested_at" TIMESTAMP TIME INDEX, "event_id" STRING, "event_ts" TIMESTAMP, "graph_id" STRING) WITH ('append_mode' = 'true')
```
The quoted-identifier rule comment is at `greptime.ts:353-354`. The aligned-column layout the existing DDL uses is at `:361-378`.

**Canonical `anchors` DDL.** Copy the column list verbatim from `acc30a8:packages/mcp-server/src/greptime.ts:208-222`:
```ts
		await this.sql(`
			CREATE TABLE IF NOT EXISTS "anchors" (
				"period_start" TIMESTAMP TIME INDEX,
				"period_end"   TIMESTAMP,
				"root"         STRING,
				"event_count"  BIGINT,
				"memo"         STRING,
				"tx_sig"       STRING,
				"signer"       STRING,
				"cluster"      STRING,
				"slot"         BIGINT,
				"anchored_at"  TIMESTAMP,
				"stale_hashes" BIGINT
			)
		`);
```
**Do NOT port** `acc30a8:greptime.ts:192-207`. That is the `ALTER TABLE "agent_events" ADD COLUMN` and `DROP TABLE "anchors"` path, which D27-11 and D27-19 forbid and `assertAppendOnly` refuses anyway.

**Shape check: column read.** Port the `information_schema` read from `acc30a8:greptime.ts:225-235`, keeping the `table_schema` filter (RESEARCH Pitfall 6). Use `this.q(...)`, not bare `quote(...)`, so it follows the probed dialect (`greptime.ts:273-275`):
```ts
	/** A table's columns from information_schema.columns, in table order; empty when the table is absent. */
	async columns(table: string): Promise<ColumnInfo[]> {
		const rows = await this.sql(
			`SELECT "column_name", "semantic_type", "data_type" FROM information_schema.columns WHERE "table_schema" = ${quote(this.config.db)} AND "table_name" = ${quote(table)} ORDER BY "ordinal_position"`,
		);
		return rows.map((row) => ({ name: String(row.column_name), semantic: String(row.semantic_type), type: String(row.data_type) }));
	}
```

**Shape check: silent-when-unanswerable parsing idiom.** Copy from `appendModeEnabled` (`greptime.ts:455-465`):
```ts
	async appendModeEnabled(): Promise<boolean | null> {
		const rows = await this.sql(`SHOW CREATE TABLE "agent_events"`).catch(() => null);
		if (!rows || rows.length === 0) return null;
		...
	}
```
Rules for the shape check:
- `.catch(() => [])`, and warn only when `live.length > 0 && shape !== canonical` (RESEARCH Pattern 3).
- **Never** use `SHOW CREATE TABLE` for it: every migrate test stub answers any `SHOW CREATE TABLE` with the `agent_events` DDL (`greptime.test.ts:303, 311, 329, 342, 353, 367`).
- Compare `semantic_type` too (Open Question 2), so a `root` TAG on an otherwise matching table is caught.

**Warning wording style** (it names the fix and the doc): `greptime.ts:410-413`
```ts
			warnings.push(
				"agent_events is not in append_mode — Greptime will deduplicate events sharing a primary key and " +
					"timestamp. Recreate the table with WITH ('append_mode' = 'true'); see docs/greptime-ledger.md.",
			);
```

---

### `greptime.ts`: `insertEvent()` ingest record (store client, append)

**Analog:** `greptime.ts:467-488`. Insert the new code **after** line 487 (the event `INSERT`), so the event row always lands first (D27-08):
```ts
	async insertEvent(event: SubstrateEvent): Promise<void> {
		await this.probeDialect();
		if (!this.dialectProbed && carriesBackslash(event)) {
			throw new GreptimeError(
				"refusing to append an event containing a backslash before the server's quoting dialect is known",
			);
		}
		const cell = (column: (typeof EVENT_COLUMNS)[number]): string => {
			if (column === "payload") return this.q(JSON.stringify(event.payload));
			const value = event[column];
			return value === null ? "NULL" : this.q(value as string | number);
		};
		const values = EVENT_COLUMNS.map(cell).join(", ");
		await this.sql(`INSERT INTO "agent_events" (${EVENT_COLUMN_LIST}) VALUES (${values})`);
		// <- ingest record goes here: two attempts, fresh stamp each, then IngestNotRecorded
	}
```
- **Value quoting:** every value goes through `this.q(...)`. `quote(null)` is `"NULL"` (`greptime.ts:226-227`), so a null `graph_id` needs no branch.
- **Timestamp literal:** ISO, as `queryEvents` sends it (`greptime.ts:543-544`: `"ts" >= ${this.q(query.since)}`). Use `this.q(new Date(ingestedAt).toISOString())`. Epoch integers fail inside subqueries on v0.14.4 (Pitfall 4).
- **The retry body, the late-record stderr warning and the `IngestNotRecorded` throw** are in RESEARCH "Code Examples → insertEvent". The stderr prefix convention is `[substrate] event ${event.id} …` (`service.ts:581, 590`).

---

### `greptime.ts`: `hourLeaves(startMs)` (NEW; store client, batched bounded reads)

**Analogs:**
- `queryEvents` (`greptime.ts:529-552`): composing a `WHERE` from typed values, with ISO bounds through `this.q`:
  ```ts
  		if (query.since !== undefined) where.push(`"ts" >= ${this.q(query.since)}`);
  		if (query.until !== undefined) where.push(`"ts" <= ${this.q(query.until)}`);
  		...
  		return this.sql(
  			`SELECT ${columns.map((column) => `"${column}"`).join(", ")} FROM "agent_events"` +
  				`${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}` +
  				` ORDER BY "ts" ${direction}, "id" ${direction} LIMIT ${queryLimit(query.limit)}`,
  		);
  ```
- `hasEvent` (`greptime.ts:576-579`): a narrow projection and typed return, never raw rows to the caller:
  ```ts
  	async hasEvent(eventId: string): Promise<boolean> {
  		const rows = await this.sql(`SELECT "id" FROM "agent_events" WHERE "id" = ${this.q(eventId)} LIMIT 1`);
  		return rows.length > 0;
  	}
  ```
- `chainTip` (`greptime.ts:133-138`): an exported pure helper over rows, unit-testable without `fetch`. That is a good shape if first-record collapse and ordering are split out of the method:
  ```ts
  export function chainTip(rows: Array<Record<string, unknown>>): string | null {
  	const hashes = rows.filter((row) => typeof row.hash === "string").map((row) => String(row.hash));
  	...
  }
  ```
- `acc30a8:greptime.ts:271-276` (`hourEvents`): the reference SQL shape only. It orders an `agent_events` column. Phase 27 orders the `event_ingest` rows in TypeScript instead.

**Batch cap precedent:** `MAX_QUERY_LIMIT = 500` (`greptime.ts:75`). Name the `IN` batch constant the same way (`IN_BATCH = 500`) with a doc comment.

**Doc-comment voice** (why, not what; it names the `ts`-is-not-order trap): `greptime.ts:490-511` (`lastHash`) and `:513-528` (`queryEvents`: "`ORDER BY "ts"` is presentation order, not append order…"). `hourLeaves` should state that the server only filters, and that TypeScript decides membership and order with a code-unit tiebreak.

**Full method body:** RESEARCH "Code Examples → hourLeaves", three flat statement shapes (a)/(b)/(c). Every one passes `assertAppendOnly` (`select` is in `APPEND_ONLY_VERBS`, `greptime.ts:197`). The return type `HourLeaf` is exported beside `EventQuery` (`greptime.ts:79-90` is the interface-with-doc-comment precedent).

---

### `packages/mcp-server/src/greptime.test.ts` (test, stubbed `fetch`)

**Analog:** the file itself.

**Harness helpers to reuse, not re-create** (`greptime.test.ts:37-74`):
```ts
function records(columns: string[], rows: unknown[][]) {
	return { output: [{ records: { schema: { column_schemas: columns.map((name) => ({ name })) }, rows } }] };
}
const affected = { output: [{ affectedrows: 1 }] };
function defaultReply(statement: string): unknown {
	return statement.includes("LENGTH") ? records(["n"], [[3]]) : affected;
}
/** The INSERT among the recorded statements — the probe may precede it. */
function insertStatement(sql: string[]): string {
	return sql.find((statement) => statement.startsWith("INSERT INTO")) ?? "";
}
function stubFetch(responder: (sql: string) => unknown = defaultReply): { sql: string[] } { ... }
```

**Statement-picker helper precedent** for the three hour-read shapes (`greptime.test.ts:580-584`):
```ts
describe("queryEvents", () => {
	/** The read among the recorded statements — the dialect probe precedes it. */
	function selectStatement(sql: string[]): string {
		return sql.find((statement) => statement.startsWith("SELECT") && statement.includes("agent_events")) ?? "";
	}
```

**Failing-statement responder** (an HTTP 500 for a matched statement): `greptime.test.ts:180-182`
```ts
		const { sql } = stubFetch((statement) =>
			statement.includes("LENGTH") ? new Response("nope", { status: 500 }) : affected,
		);
```
For the retry, count `INSERT INTO "event_ingest"` calls in the closure and fail the first N.

**Rejection assertion** (`greptime.test.ts:185`): `await expect(new GreptimeClient(config).insertEvent(event)).rejects.toThrow(/quoting dialect/);`. For the new class, use `.rejects.toBeInstanceOf(IngestNotRecorded)`.

**The single existing line that must change** (`greptime.test.ts:288-294`, RESEARCH Pitfall 1):
```ts
	test("a non-escaping server stores a backslash verbatim", async () => {
		...
		await client.insertEvent(normalizeEvent({ ...input, summary: "C:\\new" }, null));
		expect(sql.at(-1)).toContain("'C:\\new'");          // -> expect(insertStatement(sql)).toContain("'C:\\new'");
	});
```

**Migrate tests that constrain the new DDL** (they must stay green unedited):
- `:309-322` `sql[0]` is the append-mode `agent_events` CREATE; `warnings` `toEqual([])`; `sql.some(… '"anchors"')`.
- `:336`, `:358` `toHaveLength(1)`; `:345` `toEqual(["could not confirm agent_events is in append_mode"])`. The shape check must be silent on `[]` or an error.
- `:362-375` the fallback stub errors on **every** statement containing both `append_mode` and `CREATE`, so the `event_ingest` CREATE needs its own try/catch. The test asserts only `.some(...)` on warnings, so an extra `event_ingest` warning is fine.

**Imports to extend** (`greptime.test.ts:11-22`): add `IngestNotRecorded`, `INGEST_LAG_MS` and `type HourLeaf` if used.

**Fixture constants:** `config` and `input` (`greptime.test.ts:26-35`), and `normalizeEvent(input, null)` to build a real event (`:157`).

---

### `packages/mcp-server/src/service.ts`: `append()` mapping and `hourDigest()` (service)

**Analog for the mapping:** `service.ts:585-592`. Add an `instanceof IngestNotRecorded` branch **first** inside the existing `catch`, because it extends `GreptimeError` (RESEARCH Q4):
```ts
		try {
			await this.greptime.insertEvent(event);
			return { event, stored: true, ...(appendOnly !== true ? { warning: DEDUP_WARNING } : {}) };
		} catch (cause) {
			const error = redact(String(cause));
			process.stderr.write(`[substrate] event ${event.id} not stored — ${error}\n`);
			return { event, stored: false, error };
		}
```
**Message-constant analog** (a module-level `const`, with a JSDoc explaining the caller contract): `service.ts:262-265`
```ts
/** Told to a caller whose append landed in a ledger it knows may drop it. */
const DEDUP_WARNING =
	"agent_events is not in append_mode and SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER is set: this event may be " +
	"silently dropped if another shares its surface, repo, graph, kind and millisecond.";
```
Add `INGEST_NOT_RECORDED` beside it and join both into the single `warning?: string` (`service.ts:236-237`; Pitfall 10).

**Analog for `hourDigest`:** `verifyGraph` (`service.ts:1421-1452`): a JSDoc that explains the why, a null-ledger guard, a typed read, then a pure transform:
```ts
	/**
	 * Recompute the hash chain for one graph.
	 * ...
	 */
	async verifyGraph(
		graphId: string,
	): Promise<{ ok: boolean; events: number; brokenAt?: string; reason?: string }> {
		if (!this.greptime) return { ok: false, events: 0, reason: "greptime not configured" };
		const rows = await this.greptime.readEvents("graph_id", normalizeIdentifier(graphId) ?? graphId);
		...
		return { ok: true, events: rows.length };
	}
```
`hourDigest` **throws** rather than returning a reason (D27-15 says "refuses"). The input-check-throws precedent is `queryEvents`'s validation, `service.ts:613-635`, whose tests assert `rejects.toThrow(/…/)` at `service.test.ts:1446-1447`. For the missing ledger, use the same wording as `append`/`queryEvents`: `"GREPTIME_URL is not set"` (`service.ts:574, 635`).

**Result interface:** declare `export interface HourDigest` next to `EmitResult` (`service.ts:224-238`), with a JSDoc on each nullable field, in the same style:
```ts
export interface EmitResult {
	event: SubstrateEvent;
	/** False when the ledger is unconfigured, unreachable or refused the write. */
	stored: boolean;
	...
}
```

**Imports** (`service.ts:8, 22`):
```ts
import { decideClaim, type ClaimDecision } from "@substrate/audit";
...
import { GreptimeClient, queryLimit, type EventQuery, type QueryableColumn } from "./greptime.ts";
```
Add `import { formatMemo, hourEnd, hourStart, isClosed, merkleRootHex } from "@substrate/ledger";` after line 8, and extend line 22 with `INGEST_LAG_MS` and `IngestNotRecorded`.

**Store-lock line rules for this file** (`store-lock.test.ts:150-153, 163-168`; Pitfall 7):
- the file contains `greptime`, so it must never contain `.sql(`;
- **no line** may match `\b(?:sql|statement)\s*:` or `\bSELECT\s` (case-insensitive), **comments included**. Write "reads", "looks up" or "asks the ledger client" in `hourDigest`'s prose, never "select …".

---

### `packages/mcp-server/src/service.test.ts` (test, structural stubs)

**Stub-ledger factory analog:** `service.test.ts:590-611` (`emit` → `ledger()` and `substrateWith`):
```ts
	function ledger(options: { lastHash?: string | null; fail?: string } = {}) {
		const written: SubstrateEvent[] = [];
		return {
			written,
			greptime: {
				ensureAppendMode: async () => true,
				lastHash: async () => options.lastHash ?? null,
				insertEvent: async (event: SubstrateEvent) => {
					if (options.fail) throw new Error(options.fail);
					written.push(event);
				},
			},
		};
	}

	function substrateWith(greptime: unknown) {
		return new Substrate(loadConfig({}), { index: null, greptime: greptime as never });
	}
```
For the `IngestNotRecorded` case, have `insertEvent` push the event and then `throw new IngestNotRecorded(event.id, new Error("…"))`. Assert `stored: true`, `warning` containing the not-anchored text and `error` undefined. Mirror `:613-626` ("reports a stored event…") and the warning assertion at `:762-768` ("an operator can knowingly accept the loss, and is still told": `expect(result.warning).toContain(...)`), and add a combined `appendMode false` plus opt-in case for Pitfall 10.

**Single-method structural stub for a typed read** (the `hourDigest` tests stub only `hourLeaves`): `service.test.ts:1363-1377`
```ts
	test("verifyGraph reads by the stored form of the graph id", async () => {
		const asked: Array<[string, string]> = [];
		const greptime = {
			ensureAppendMode: async () => true,
			readEvents: async (column: "graph_id", value: string) => {
				asked.push([column, value]);
				return [];
			},
		};
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: greptime as never });
		...
	});
```

**Rows typed as Greptime returns them** (epoch-ms integers, not ISO): `service.test.ts:1170-1175`
```ts
			greptime: {
				readEvents: async () => [
					{ ...row, ts: Date.parse(row.ts), payload: JSON.stringify(row.payload), step: null },
					...
				],
			} as never,
```

**In-process stderr capture (an existing idiom).** RESEARCH Q5 says none exists, but this file already has one at `service.test.ts:1666-1694`. Reuse it for the "stderr line with the event id" assertion rather than introducing `spyOn`:
```ts
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			...
		} finally {
			process.stderr.write = original;
		}
		const log = written.join("");
```
(`spyOn(process.stderr, "write")` also works in bun:test 1.4.0 per RESEARCH, but greptime.test.ts has no stderr idiom yet. Use either one consistently in both files. This manual-swap form is the established one.)

**Imports** (`service.test.ts:1-8`): add `IngestNotRecorded` to the `./greptime.ts` import on line 3. A test that recomputes the expected root may import `merkleRootHex`/`formatMemo` from `@substrate/ledger` (it resolves after `bun install`).

**Hashes for fixtures:** real 64-hex leaves come from `sha256Hex` (`event.ts:25-27`), or use `"a".repeat(64)`-style constants. `merkleRootHex` rejects anything else (`acc30a8:merkle.ts:45-46`).

**The 17 existing `insertEvent` stubs** (lines 50, 241, 421, 601, 670, 707, 814, 898, 943, 1351 here, plus mcp, server, authority and graph-bind tests) resolve `void` or throw a plain `Error`. They are unaffected and must not be edited (RESEARCH Q4).

---

### `scripts/greptime-smoke.ts` (live proof script; named store-lock exemption)

**Analog:** the file itself. Keep every convention.

**Imports** (`greptime-smoke.ts:32-36`): relative, because a bare `@substrate/ledger` cannot resolve from `scripts/` (Pitfall 8):
```ts
import { randomUUID } from "node:crypto";
import { loadConfig } from "../packages/mcp-server/src/config.ts";
import { AppendOnlyViolation } from "../packages/mcp-server/src/greptime.ts";
import { Substrate } from "../packages/mcp-server/src/service.ts";
import { REDACTED } from "../packages/mcp-server/src/redact.ts";
```
Add `import { HOUR_MS, hourStart } from "../packages/ledger/src/index.ts";` only if needed. `INGEST_LAG_MS` comes from the `greptime.ts` import.

**Check/report harness** (`:43-48`, `:231-238`):
```ts
function check(ok: boolean, what: string, detail?: string): void {
	results.push({ ok, what, detail });
	process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
}
...
process.exit(failed.length === 0 ? 0 : 1);
```

**Section banner and emit-loop pattern** (`:110-128`):
```ts
// ── 2–3. emit a chain through the real write path ────────────────────────────
const graphId = `smoke-${randomUUID().slice(0, 8)}`;
const sessionId = `smoke-${Date.now()}`;
const common = { surface: "claude-code", kind: "note", session_id: sessionId, graph_id: graphId } as const;

const emitted = [];
for (const summary of [...]) {
	const result = await substrate.emit({ ...common, summary });
	emitted.push(result);
	if (!result.stored) check(false, `append "${summary.slice(0, 32)}…"`, result.error);
}
```
Backdated `ts`: `EventInput` accepts a collector `ts` (`event.ts:139-141`; `normalizeEvent` keeps it).

**Raw read through the client, allowed here only** (`:216-229` uses `greptime.sql(statement)` directly). Use the same `greptime.sql(...)` for the "exactly one ingest record per event" read (`SELECT "event_id", COUNT(*) AS "n" FROM "event_ingest" WHERE "event_id" IN (…) GROUP BY "event_id"`, proven on scratch).

**Placement:** add a new `// ── 5b. …` (or `// ── 7. …`) section after `// ── 4. the chain verifies` (`:150-152`) or before `// ── 6.` (`:216`). Update the header comment's numbered list (`:15-25`) and the `migrate` note handling (`:85`, `for (const warning of first.warnings) process.stdout.write(\`  note  ${warning}\n\`)`), which already prints a shape warning.

**Header env instructions** (`:6-10`, `:51-57`) name `/etc/substrate/substrate.env`. Add the scratch path that Phase 16 introduced (`p16:docs/rehearsal.md:25-34`: "`stores.env` is sourced only by proofs that legitimately hold a store client, such as `bun run smoke:greptime`…"):
```sh
bun run rehearsal up --name p27
set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p27/stores.env"; set +a
bun run smoke:greptime
bun run rehearsal down --name p27
```
Never print a credential. The script already prints only `host` and `db` (`:69-76`).

**Assertion shape for the hour digest** (Pitfall 9 and the CONTEXT D27-22 step 4 wording): subset plus relative order plus determinism across two calls, digesting every hour the burst's ingest records touch. Never `event_count === burst.length`.

---

### `docs/greptime-ledger.md` (doc)

**Analog:** its own sections.
- `## Schema` (`:39-67`): a fenced `sql` block of the exact DDL, then a paragraph of rationale. Add `event_ingest` and the canonical `anchors` in the same form, directly after the `agent_events` block.
- `### Why append_mode is not optional` (`:69-94`): a "what goes wrong without it" paragraph. This is the template for "why `event_ingest` has no plain-CREATE fallback" and for the `anchors` dedup property (last write wins on `period_start`, which Phase 28 must handle by adopting before writing; D27-20).
- `## What the write path guarantees` (`:146-236`): bold lead-in sentences (`**The hash chain, computed on ingest.**`, `**Chain order, not timestamp order.**`). Add `**Ingest order, recorded beside the event.**` in that style, covering D27-08/09/10/12/16 and noting that the D-era `agent_events.ingested_at` column is neither read nor written (D27-11). Line `:173` ("Phase 6 anchors hourly Merkle roots to Solana") is the existing forward reference to update.
- `## Smoke test` (`:340-367`): a numbered check list. Append the new checks, and add the scratch-run command block.
- `### Verification status` (`:369-384`): record "proven on v0.14.4 scratch only; production v1.1.4 gap" (D27-23) in the same "recorded as reported, not as something this repo verified" voice.
- Store-lock credential scan (`store-lock.test.ts:72-73`): name no Railway host and no `GREPTIME_*=value`.

---

### `README.md:73` (doc)

**Current:** `packages/ledger/         Greptime writer, Merkle anchor       (TS)`. That is wrong after this phase (RESEARCH "State of the Art"). Match the column alignment of the neighbouring lines `README.md:68-78`, e.g. `packages/ledger/         RFC 6962 root, memo, UTC hours (pure) (TS)`.

## Shared Patterns

### Every value is quoted by the client; callers never supply syntax
**Source:** `greptime.ts:226-231` (`quote`), `:273-275` (`this.q`), `:200-214` (`assertAppendOnly`)
**Apply to:** every new statement in `greptime.ts` (both DDLs, the shape-check read, the ingest `INSERT`, all three hour reads)
```ts
	/** Quote using whatever dialect the server reported. */
	private q(value: string | number | null): string {
		return quote(value, this.backslashEscapes);
	}
```
Timestamps go in as ISO literals via `this.q(new Date(ms).toISOString())`. They come back as epoch-ms integers, so read them with `Number(row.x)` (smoke comment `greptime-smoke.ts:171-172`; Pitfall 5).

### Warn, don't fail, at boot; fail closed on dedup risk
**Source:** `greptime.ts:343-349` (the `migrate` JSDoc) and `service.ts:240-256` (`NOT_APPEND_ONLY` rationale)
**Apply to:** the `event_ingest` CREATE failure (a warning), the `anchors` shape mismatch (a warning, silent when unreadable), and `event_ingest` getting `append_mode` with no fallback.

### Redact anything derived from an error before it leaves the process
**Source:** `service.ts:589-590`, `:641`, `:968`
```ts
			const error = redact(String(cause));
			process.stderr.write(`[substrate] event ${event.id} not stored — ${error}\n`);
```
**Apply to:** the `IngestNotRecorded` warning and stderr line in `append` (Pitfall 11). The late-record stderr line in `greptime.ts` names only the event id and the hour, so it carries no error text.

### stderr line format
**Source:** `service.ts:581, 590, 727, 968, 976`: always the `[substrate] ` prefix, then the subject (`event <id>`), an em-dash and the reason, newline-terminated.
**Apply to:** the ingest-failure line (`service.ts`) and the late-record line (`greptime.ts`).

### Test seams: injectable `now`, structural stubs `as never`
**Source:** `greptime.ts:437` (`ensureAppendMode(now = Date.now())`), `service.ts:465-475` (`stores` seam), `service.test.ts:609-611`
**Apply to:** `hourDigest(periodStartMs, now = Date.now())`, the `GreptimeClient` constructor `clock` parameter, and every new service test.

### Store and redaction locks (unedited, must stay green)
**Source:** `store-lock.test.ts:110-130` (packages outside mcp-server: no greptime import, no `agent_events` after FROM/INTO/UPDATE/TABLE, no `GREPTIME_`, comments included), `:141-170` (`service.ts`: no `.sql(`, no `sql:`/`statement:`/`SELECT ` on any line)
**Apply to:** `packages/ledger/src/*` (ported and `index.ts`) and `service.ts`. `redact-lock.test.ts` is not on this base (it arrives with Phase 18). Until then, inspect for the D18-13 rules 1-4 listed in RESEARCH Q7.

## No Analog Found

None. The nearest gaps, with the reference to use instead:

| File / unit | Role | Data Flow | Gap | Use instead |
|---|---|---|---|---|
| `greptime.ts` `hourLeaves` three-statement composition | store client | batched bounded reads | No existing method composes several dependent statements with `IN` batching | RESEARCH "Code Examples → hourLeaves" (proven on v0.14.4), styled per `queryEvents`/`hasEvent` above |
| `greptime.ts` `insertEvent` retry loop | store client | append with retry | No retry loop exists in the client (it fails fast everywhere) | RESEARCH "Code Examples → insertEvent" |

## Metadata

**Analog search scope:** `packages/mcp-server/src/` (`greptime.ts`, `greptime.test.ts`, `service.ts`, `service.test.ts`, `store-lock.test.ts`, `event.ts`), `packages/{audit,evidence,observability,ledger}/`, `scripts/`, `docs/greptime-ledger.md`, `README.md`, `bun.lock`, `tsconfig.json`, `acc30a8:packages/ledger/src/*`, `acc30a8:packages/mcp-server/src/greptime.ts`, and the Phase 16 worktree (`docs/rehearsal.md`, `scripts/rehearsal.ts`, `packages/mcp-server/src/rehearsal-env.ts`).
**Files scanned:** 24
**Pattern extraction date:** 2026-10-08
**Corrections to RESEARCH noted here:**
1. An in-process stderr-capture idiom already exists, at `service.test.ts:1666-1694`.
2. The `store-lock.test.ts:119` `agent_events` regex is case-insensitive and matches prose. That constrains comments in `packages/ledger/src/index.ts`.
3. CONTEXT D27-06 (locked) says `memo.ts` stays unedited and the unverified status goes in the SUMMARY. RESEARCH's restated D27-06 ("keeps its `[UNVERIFIED]` status") describes a marker the source does not contain. Follow CONTEXT.

## PATTERN MAPPING COMPLETE
