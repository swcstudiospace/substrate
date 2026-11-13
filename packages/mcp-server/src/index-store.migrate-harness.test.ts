/**
 * `IndexStore.migrate()` against a recording fake connection (phase 55). No database: the fake stands in for the
 * reserved Postgres connection through `IndexStoreOptions.sql`, keeps a ledger in memory, and records every statement
 * the migrator sends, so the ORDER of its work is what is asserted:
 *
 *   - the advisory lock is taken before any DDL and released in `finally`;
 *   - `lock_timeout` and `statement_timeout` are set, then RESET;
 *   - each missing transactional version runs in its own BEGIN..COMMIT together with its `schema_migrations` insert; a
 *     non-transactional one (step 48) runs its statements one at a time with no BEGIN;
 *   - a failing step rolls back, inserts no ledger row, rethrows, and still releases the lock;
 *   - a second run over a fully ledgered state issues no DDL;
 *   - a partially ledgered state applies exactly the missing versions, in order.
 *
 * The live counterparts (a real Postgres, `SUBSTRATE_TEST_PG_URL`) are in `index-store.migrate.test.ts`.
 */
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import {
	INDEX_MIGRATE_LOCK_TIMEOUT_MS,
	INDEX_MIGRATE_DDL_LOCK_TIMEOUT_MS,
	INDEX_MIGRATE_STATEMENT_TIMEOUT_MS,
	IndexStore,
	MIGRATION_STEPS,
	PLANNING_HASH_TABLE_REPAIR,
	applicableMigrationSteps,
	indexMigrateLockKey,
	migrationStatements,
} from "./index-store.ts";

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Normalised statement text -> version, so a recorded `unsafe(...)` is labelled `ddl <version>`. A transactional step is one unit; a non-transactional step is one unit per statement. */
const DDL_VERSION = new Map(
	MIGRATION_STEPS.flatMap((step) => (step.transactional === false ? migrationStatements(step.sql) : [step.sql]).map((text) => [squash(text), step.version] as const)),
);

interface FakeOptions {
	/** Versions already in `schema_migrations`. */
	applied?: readonly number[];
	/** `unsafe(step.sql)` for this version throws. */
	failDdlAt?: number;
	/** The advisory unlock query throws, as on a connection that died mid-migration. */
	failUnlock?: boolean;
	/** The opt-in migrations the store runs; absent is every opt-in off, the store's default. */
	migrationOptIns?: { "steering-audit": boolean; "steering-sessions"?: boolean };
	/** A table lock held by another session at this version: the wait ends only at `lock_timeout`, and with none set the fake reports a hang. */
	lockContendedAt?: number;
}

/** A recording stand-in for `sql.reserve()`'s connection, with a transactional in-memory `schema_migrations`. */
function fakeIndex(options: FakeOptions = {}) {
	const events: string[] = [];
	const ledger = new Set(options.applied ?? []);
	const tables = new Set<string>();
	const columns = new Set<string>();
	let pending: number[] = [];
	let inTransaction = false;
	let lockTimeoutMs: number | undefined;

	const reserved = Object.assign(
		async (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>> => {
			const query = squash(strings.join("?")).toLowerCase();
			if (query.startsWith("select pg_advisory_lock(")) {
				expect(values).toEqual([indexMigrateLockKey()]);
				events.push("lock");
				return [];
			}
			if (query.startsWith("select pg_advisory_unlock(")) {
				expect(values).toEqual([indexMigrateLockKey()]);
				events.push("unlock");
				if (options.failUnlock) throw new Error("connection lost");
				return [];
			}
			if (query.startsWith("create table if not exists schema_migrations")) {
				events.push("create ledger");
				return [];
			}
			if (query.startsWith("select version from schema_migrations where version =")) {
				const version = values[0] as number;
				events.push(`check ${version}`);
				return ledger.has(version) ? [{ version }] : [];
			}
			if (query === "begin") {
				events.push("begin");
				inTransaction = true;
				return [];
			}
			if (query.startsWith("insert into schema_migrations")) {
				const version = values[0] as number;
				expect(values[1]).toBe(MIGRATION_STEPS.find((step) => step.version === version)?.name);
				events.push(`ledger ${version}`);
				if (inTransaction) pending.push(version);
				else ledger.add(version);
				return [];
			}
			if (query === "commit") {
				events.push("commit");
				for (const version of pending) ledger.add(version);
				pending = [];
				inTransaction = false;
				return [];
			}
			if (query === "rollback") {
				events.push("rollback");
				pending = [];
				inTransaction = false;
				return [];
			}
			events.push(`unexpected query: ${query}`);
			return [];
		},
		{
			unsafe: async (sql: string): Promise<Array<Record<string, unknown>>> => {
				const text = squash(sql);
				const lockTimeout = /^SET lock_timeout = (\d+)$/.exec(text);
				const statementTimeout = /^SET statement_timeout = (\d+)$/.exec(text);
				const ddl = DDL_VERSION.get(text);
				if (lockTimeout) {
					lockTimeoutMs = Number(lockTimeout[1]);
					events.push(`set lock_timeout ${lockTimeout[1]}`);
				} else if (statementTimeout) events.push(`set statement_timeout ${statementTimeout[1]}`);
				else if (text === "RESET lock_timeout") {
					lockTimeoutMs = undefined;
					events.push("reset lock_timeout");
				} else if (text === "RESET statement_timeout") events.push("reset statement_timeout");
				else if (text === "drop index if exists memory_reviews_hash_idx") events.push("drop memory_reviews_hash_idx");
				else if (text === squash(PLANNING_HASH_TABLE_REPAIR)) events.push("repair planning_page_hashes");
				else if (/^drop table if exists \w+$/.test(text)) {
					const table = text.slice("drop table if exists ".length);
					tables.delete(table);
					events.push(`drop table ${table}`);
				} else if (/^alter table \w+ drop column if exists \w+$/.test(text)) {
					const [table, column] = text.slice("alter table ".length).split(" drop column if exists ") as [string, string];
					columns.delete(`${table}.${column}`);
					events.push(`drop column ${table}.${column}`);
				} else if (ddl !== undefined) {
					events.push(`ddl ${ddl}`);
					if (options.failDdlAt === ddl) throw new Error(`boom at step ${ddl}`);
					if (options.lockContendedAt === ddl) {
						// Another session holds a table lock: the wait ends at lock_timeout, or never.
						events.push(`lock wait ${ddl} ${lockTimeoutMs ?? "none"}`);
						if (lockTimeoutMs === undefined || lockTimeoutMs <= 0) throw new Error(`unbounded lock wait at step ${ddl}: migrate would hang`);
						throw Object.assign(new Error("canceling statement due to lock timeout"), { errno: "55P03" });
					}
					const created = /^create table if not exists (\w+)/i.exec(text);
					if (created?.[1]) tables.add(created[1]);
					const added = /^alter table (\w+) add column if not exists (\w+)/i.exec(text);
					if (added?.[1] && added[2]) columns.add(`${added[1]}.${added[2]}`);
				} else events.push(`unexpected unsafe: ${text}`);
				return [];
			},
			release: (): void => {
				events.push("release");
			},
			close: async (): Promise<void> => {
				events.push("close");
			},
		},
	);

	const sql = { reserve: async () => reserved } as unknown as SQL;
	const store = new IndexStore("postgres://unused.invalid/index", { sql, ...(options.migrationOptIns ? { migrationOptIns: options.migrationOptIns } : {}) });
	return { store, events, ledger, tables, columns, reserved };
}

/** The steps `migrate()` runs by default: every opt-in off, so the opt-in steps 33 and 34 are neither run nor ledgered. */
const ALL = applicableMigrationSteps({ "steering-audit": false, "steering-sessions": false }).map((step) => step.version);
const ALL_WITH_STEERING_AUDIT = applicableMigrationSteps({ "steering-audit": true }).map((step) => step.version);

const PROLOGUE = [
	`set lock_timeout ${INDEX_MIGRATE_LOCK_TIMEOUT_MS}`,
	`set statement_timeout ${INDEX_MIGRATE_LOCK_TIMEOUT_MS}`,
	"lock",
	`set lock_timeout ${INDEX_MIGRATE_DDL_LOCK_TIMEOUT_MS}`,
	`set statement_timeout ${INDEX_MIGRATE_STATEMENT_TIMEOUT_MS}`,
	"create ledger",
];
const EPILOGUE = ["drop memory_reviews_hash_idx", "repair planning_page_hashes", "unlock", "reset lock_timeout", "reset statement_timeout", "release"];

const STEP_BY_VERSION = new Map(MIGRATION_STEPS.map((step) => [step.version, step]));

/** A transactional step is one BEGIN..COMMIT; a non-transactional step (48) has no transaction and one DDL event per statement. */
const transactional = (version: number): boolean => STEP_BY_VERSION.get(version)?.transactional !== false;

/** What `migrate()` must send when `applied` is already in the ledger and nothing fails. */
function expectedRun(applied: ReadonlySet<number>, versions: readonly number[] = ALL): string[] {
	const body: string[] = [];
	for (const version of versions) {
		body.push(`check ${version}`);
		if (applied.has(version)) continue;
		if (transactional(version)) body.push("begin", `ddl ${version}`, `ledger ${version}`, "commit");
		else {
			const statements = migrationStatements(STEP_BY_VERSION.get(version)?.sql ?? "");
			body.push(...statements.map(() => `ddl ${version}`), `ledger ${version}`);
		}
	}
	return [...PROLOGUE, ...body, ...EPILOGUE];
}

const isDdl = (event: string): boolean => event.startsWith("ddl ") || event === "begin" || event === "commit" || event.startsWith("ledger ");

describe("IndexStore.migrate() against a fake connection", () => {
	test("the harness itself: every statement's text is distinct, so a recorded DDL maps to exactly one version", () => {
		const units = MIGRATION_STEPS.reduce((count, step) => count + (step.transactional === false ? migrationStatements(step.sql).length : 1), 0);
		expect(DDL_VERSION.size).toBe(units);
	});

	test("the opt-in steps 33 and 34 are skipped by default: no check, no DDL, no ledger row", async () => {
		const { store, events, ledger } = fakeIndex();
		await store.migrate();
		expect(ALL).not.toContain(33);
		expect(ALL).not.toContain(34);
		for (const version of [33, 34]) {
			expect(events).not.toContain(`check ${version}`);
			expect(events).not.toContain(`ddl ${version}`);
			expect(ledger.has(version)).toBe(false);
		}
	});

	test("with the steering-audit opt-in, steps 33 and 34 each apply in their own transaction and their downs reverse them", async () => {
		const table = MIGRATION_STEPS.find((candidate) => candidate.version === 33);
		const reason = MIGRATION_STEPS.find((candidate) => candidate.version === 34);
		expect(table?.name).toBe("planning_steering_audit");
		expect(table?.down).toBe("drop table if exists planning_steering_audit");
		expect(reason?.name).toBe("planning_steering_audit_reason");
		expect(reason?.down).toBe("alter table planning_steering_audit drop column if exists reason");
		const { store, events, ledger, tables, columns, reserved } = fakeIndex({ migrationOptIns: { "steering-audit": true } });
		await store.migrate();
		expect(ALL_WITH_STEERING_AUDIT).toEqual([...ALL, 33, 34, 44, 45].sort((a, b) => a - b));
		expect(events).toEqual(expectedRun(new Set(), ALL_WITH_STEERING_AUDIT));
		expect(ledger.has(33)).toBe(true);
		expect(ledger.has(34)).toBe(true);
		expect(tables.has("planning_steering_audit")).toBe(true);
		expect(columns.has("planning_steering_audit.reason")).toBe(true);

		await reserved.unsafe(reason?.down ?? "");
		expect(columns.has("planning_steering_audit.reason")).toBe(false);
		expect(tables.has("planning_steering_audit")).toBe(true);
		expect(events.at(-1)).toBe("drop column planning_steering_audit.reason");

		await reserved.unsafe(table?.down ?? "");
		expect(tables.has("planning_steering_audit")).toBe(false);
		expect(events.at(-1)).toBe("drop table planning_steering_audit");
	});

	test("with the steering-sessions opt-in, step 37 applies in its own transaction and its down reverses it; off, it is skipped and not ledgered", async () => {
		const step = MIGRATION_STEPS.find((candidate) => candidate.version === 37);
		expect(step?.name).toBe("steering_sessions");
		expect(step?.down).toBe("drop table if exists steering_sessions");
		const withSessions = applicableMigrationSteps({ "steering-audit": false, "steering-sessions": true }).map((candidate) => candidate.version);
		expect(withSessions).toEqual([...ALL, 37].sort((a, b) => a - b));
		const on = fakeIndex({ migrationOptIns: { "steering-audit": false, "steering-sessions": true } });
		await on.store.migrate();
		expect(on.events).toEqual(expectedRun(new Set(), withSessions));
		expect(on.ledger.has(37)).toBe(true);
		expect(on.tables.has("steering_sessions")).toBe(true);
		await on.reserved.unsafe(step?.down ?? "");
		expect(on.tables.has("steering_sessions")).toBe(false);

		const off = fakeIndex({ migrationOptIns: { "steering-audit": true, "steering-sessions": false } });
		await off.store.migrate();
		expect(off.ledger.has(37)).toBe(false);
		expect(off.tables.has("steering_sessions")).toBe(false);
	});

	test("an empty ledger: the full ordered sequence, one BEGIN..COMMIT with the ledger insert per step", async () => {
		const { store, events, ledger } = fakeIndex();
		await store.migrate();
		expect(events).toEqual(expectedRun(new Set()));
		expect([...ledger]).toEqual(ALL);
	});

	test("the lock is taken before any DDL and released after the last statement", async () => {
		const { store, events } = fakeIndex();
		await store.migrate();
		const lock = events.indexOf("lock");
		const firstDdl = events.findIndex(isDdl);
		const unlock = events.indexOf("unlock");
		const lastDdl = events.map(isDdl).lastIndexOf(true);
		expect(lock).toBeGreaterThanOrEqual(0);
		expect(lock).toBeLessThan(events.indexOf("create ledger"));
		expect(events.indexOf("create ledger")).toBeLessThan(firstDdl);
		expect(unlock).toBeGreaterThan(lastDdl);
		expect(events.at(-1)).toBe("release");
	});

	test("lock_timeout and statement_timeout are set to the migrate values and then RESET", async () => {
		const { store, events } = fakeIndex();
		await store.migrate();
		expect(events.filter((event) => event.startsWith("set ") || event.startsWith("reset "))).toEqual([
			`set lock_timeout ${INDEX_MIGRATE_LOCK_TIMEOUT_MS}`,
			`set statement_timeout ${INDEX_MIGRATE_LOCK_TIMEOUT_MS}`,
			`set lock_timeout ${INDEX_MIGRATE_DDL_LOCK_TIMEOUT_MS}`,
			`set statement_timeout ${INDEX_MIGRATE_STATEMENT_TIMEOUT_MS}`,
			"reset lock_timeout",
			"reset statement_timeout",
		]);
		expect(events.indexOf("reset lock_timeout")).toBeGreaterThan(events.indexOf("unlock"));
	});

	test("a DDL step that times out on a table lock is reported as a failed migrate, not a hang", async () => {
		const failAt = 7;
		const { store, events, ledger } = fakeIndex({ lockContendedAt: failAt });
		await expect(store.migrate()).rejects.toThrow("canceling statement due to lock timeout");
		expect(INDEX_MIGRATE_DDL_LOCK_TIMEOUT_MS).toBeLessThan(INDEX_MIGRATE_LOCK_TIMEOUT_MS);
		expect(events).toContain(`lock wait ${failAt} ${INDEX_MIGRATE_DDL_LOCK_TIMEOUT_MS}`);
		expect(events.slice(-9)).toEqual([`check ${failAt}`, "begin", `ddl ${failAt}`, `lock wait ${failAt} ${INDEX_MIGRATE_DDL_LOCK_TIMEOUT_MS}`, "rollback", "unlock", "reset lock_timeout", "reset statement_timeout", "release"]);
		expect(events).not.toContain(`ledger ${failAt}`);
		expect(events.some((event) => event.startsWith("ddl ") && Number(event.slice(4)) > failAt)).toBe(false);
		expect([...ledger]).toEqual(ALL.filter((version) => version < failAt));
	});

	test("each transactional step is its own transaction, with the ledger insert between its DDL and its COMMIT; step 48 has no BEGIN", async () => {
		const { store, events } = fakeIndex();
		await store.migrate();
		const body = events.slice(PROLOGUE.length, events.length - EPILOGUE.length);
		let at = 0;
		for (const version of ALL) {
			if (transactional(version)) {
				expect(body.slice(at, at + 5)).toEqual([`check ${version}`, "begin", `ddl ${version}`, `ledger ${version}`, "commit"]);
				at += 5;
			} else {
				const sql = STEP_BY_VERSION.get(version)?.sql ?? "";
				const run = [`check ${version}`, ...migrationStatements(sql).map(() => `ddl ${version}`), `ledger ${version}`];
				expect(body.slice(at, at + run.length)).toEqual(run);
				at += run.length;
			}
		}
		expect(at).toBe(body.length);
		expect(body.filter((event) => event === "begin")).toHaveLength(ALL.filter(transactional).length);
	});

	test("a failing step rolls back, inserts no ledger row, rethrows, and still releases the lock", async () => {
		const failAt = 7;
		const { store, events, ledger } = fakeIndex({ failDdlAt: failAt });
		await expect(store.migrate()).rejects.toThrow(`boom at step ${failAt}`);
		const done = PROLOGUE.length + (failAt - 1) * 5;
		expect(events.slice(0, done)).toEqual(expectedRun(new Set()).slice(0, done));
		expect(events.slice(-8)).toEqual([`check ${failAt}`, "begin", `ddl ${failAt}`, "rollback", "unlock", "reset lock_timeout", "reset statement_timeout", "release"]);
		expect(events).not.toContain(`ledger ${failAt}`);
		expect(events).not.toContain("drop memory_reviews_hash_idx");
		expect(events.some((event) => event.startsWith("ddl ") && Number(event.slice(4)) > failAt)).toBe(false);
		expect([...ledger]).toEqual(ALL.filter((version) => version < failAt));
	});

	test("a second run over a fully ledgered state issues no DDL, transaction or ledger write", async () => {
		const { store, events, ledger } = fakeIndex({ applied: ALL });
		await store.migrate();
		expect(events.filter(isDdl)).toEqual([]);
		expect(events).toEqual(expectedRun(new Set(ALL)));
		expect([...ledger]).toEqual(ALL);
	});

	test("two runs in a row: the second applies nothing the first already ledgered", async () => {
		const first = fakeIndex();
		await first.store.migrate();
		const second = fakeIndex({ applied: [...first.ledger] });
		await second.store.migrate();
		expect(second.events.filter(isDdl)).toEqual([]);
	});

	test("a partially ledgered state (1..k) applies exactly k+1..N, in order", async () => {
		const k = 10;
		const { store, events, ledger } = fakeIndex({ applied: ALL.filter((version) => version <= k) });
		await store.migrate();
		const applied = [...new Set(events.filter((event) => event.startsWith("ddl ")).map((event) => Number(event.slice(4))))];
		expect(applied).toEqual(ALL.filter((version) => version > k));
		expect(events).toEqual(expectedRun(new Set(ALL.filter((version) => version <= k))));
		expect([...ledger].sort((a, b) => a - b)).toEqual(ALL);
	});

	test("the ledger is by presence: one missing version below the top is applied, the rest are skipped", async () => {
		const missing = 5;
		const { store, events } = fakeIndex({ applied: ALL.filter((version) => version !== missing) });
		await store.migrate();
		expect(events.filter((event) => event.startsWith("ddl "))).toEqual([`ddl ${missing}`]);
	});

	test("step 48 runs outside any transaction: its statements go one at a time, and its ledger row follows the last one", async () => {
		const { store, events, ledger } = fakeIndex({ applied: ALL.filter((version) => version !== 48) });
		await store.migrate();
		const at = events.indexOf("check 48");
		expect(events[at - 1]).toBe("check 47");
		expect(events.slice(at, at + 4)).toEqual(["check 48", "ddl 48", "ddl 48", "ledger 48"]);
		expect(events[at + 4]).toBe("drop memory_reviews_hash_idx");
		expect(ledger.has(48)).toBe(true);
	});

	test("a failing step 48 has no BEGIN or ROLLBACK, writes no ledger row, rethrows, and still releases the lock", async () => {
		const { store, events, ledger } = fakeIndex({ applied: ALL.filter((version) => version !== 48), failDdlAt: 48 });
		await expect(store.migrate()).rejects.toThrow("boom at step 48");
		expect(events.slice(-6)).toEqual(["check 48", "ddl 48", "unlock", "reset lock_timeout", "reset statement_timeout", "release"]);
		expect(events).not.toContain("rollback");
		expect(events).not.toContain("ledger 48");
		expect(ledger.has(48)).toBe(false);
	});

	test("migrationStatements keeps a dollar-quoted block and quoted semicolons whole, and splits the rest", () => {
		const step48 = MIGRATION_STEPS.find((candidate) => candidate.version === 48);
		const statements = migrationStatements(step48?.sql ?? "");
		expect(statements).toHaveLength(2);
		expect(statements[0]?.startsWith("do $$")).toBe(true);
		expect(statements[0]?.endsWith("$$")).toBe(true);
		expect(statements[1]?.startsWith("create index concurrently if not exists memory_forgotten_at_idx")).toBe(true);
		expect(migrationStatements("select 'a;b'; select 2;")).toEqual(["select 'a;b'", "select 2"]);
		expect(migrationStatements("select 'it''s;'; select $t$x;y$t$")).toEqual(["select 'it''s;'", "select $t$x;y$t$"]);
	});

	test("a failed unlock discards the connection instead of returning it to the pool, and the error surfaces", async () => {
		const { store, events } = fakeIndex({ applied: ALL, failUnlock: true });
		await expect(store.migrate()).rejects.toThrow("connection lost");
		expect(events.at(-1)).toBe("close");
		expect(events).not.toContain("release");
	});

	test("a step failure is not masked by a failing unlock: the step's error is the one thrown", async () => {
		const { store, events } = fakeIndex({ failDdlAt: 2, failUnlock: true });
		await expect(store.migrate()).rejects.toThrow("boom at step 2");
		expect(events.at(-1)).toBe("close");
	});
});
