/**
 * `IndexStore.migrate()` against a recording fake connection (phase 55). No database: the fake stands in for the
 * reserved Postgres connection through `IndexStoreOptions.sql`, keeps a ledger in memory, and records every statement
 * the migrator sends, so the ORDER of its work is what is asserted:
 *
 *   - the advisory lock is taken before any DDL and released in `finally`;
 *   - `lock_timeout` and `statement_timeout` are set, then RESET;
 *   - each missing version runs in its own BEGIN..COMMIT together with its `schema_migrations` insert;
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
	INDEX_MIGRATE_STATEMENT_TIMEOUT_MS,
	IndexStore,
	MIGRATION_STEPS,
	applicableMigrationSteps,
	indexMigrateLockKey,
} from "./index-store.ts";

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Normalised step text -> version, so a recorded `unsafe(step.sql)` is labelled `ddl <version>`. */
const DDL_VERSION = new Map(MIGRATION_STEPS.map((step) => [squash(step.sql), step.version]));

interface FakeOptions {
	/** Versions already in `schema_migrations`. */
	applied?: readonly number[];
	/** `unsafe(step.sql)` for this version throws. */
	failDdlAt?: number;
	/** The advisory unlock query throws, as on a connection that died mid-migration. */
	failUnlock?: boolean;
	/** The opt-in migrations the store runs; absent is every opt-in off, the store's default. */
	migrationOptIns?: { "steering-audit": boolean };
}

/** A recording stand-in for `sql.reserve()`'s connection, with a transactional in-memory `schema_migrations`. */
function fakeIndex(options: FakeOptions = {}) {
	const events: string[] = [];
	const ledger = new Set(options.applied ?? []);
	const tables = new Set<string>();
	let pending: number[] = [];

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
				return [];
			}
			if (query.startsWith("insert into schema_migrations")) {
				const version = values[0] as number;
				expect(values[1]).toBe(MIGRATION_STEPS.find((step) => step.version === version)?.name);
				events.push(`ledger ${version}`);
				pending.push(version);
				return [];
			}
			if (query === "commit") {
				events.push("commit");
				for (const version of pending) ledger.add(version);
				pending = [];
				return [];
			}
			if (query === "rollback") {
				events.push("rollback");
				pending = [];
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
				if (lockTimeout) events.push(`set lock_timeout ${lockTimeout[1]}`);
				else if (statementTimeout) events.push(`set statement_timeout ${statementTimeout[1]}`);
				else if (text === "RESET lock_timeout") events.push("reset lock_timeout");
				else if (text === "RESET statement_timeout") events.push("reset statement_timeout");
				else if (text === "drop index if exists memory_reviews_hash_idx") events.push("drop memory_reviews_hash_idx");
				else if (/^drop table if exists \w+$/.test(text)) {
					const table = text.slice("drop table if exists ".length);
					tables.delete(table);
					events.push(`drop table ${table}`);
				} else if (ddl !== undefined) {
					events.push(`ddl ${ddl}`);
					if (options.failDdlAt === ddl) throw new Error(`boom at step ${ddl}`);
					const created = /^create table if not exists (\w+)/i.exec(text);
					if (created?.[1]) tables.add(created[1]);
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
	return { store, events, ledger, tables, reserved };
}

/** The steps `migrate()` runs by default: every opt-in off, so the opt-in step 33 is neither run nor ledgered. */
const ALL = applicableMigrationSteps({ "steering-audit": false }).map((step) => step.version);
const ALL_WITH_STEERING_AUDIT = applicableMigrationSteps({ "steering-audit": true }).map((step) => step.version);

const PROLOGUE = [
	`set lock_timeout ${INDEX_MIGRATE_LOCK_TIMEOUT_MS}`,
	`set statement_timeout ${INDEX_MIGRATE_LOCK_TIMEOUT_MS}`,
	"lock",
	`set statement_timeout ${INDEX_MIGRATE_STATEMENT_TIMEOUT_MS}`,
	"create ledger",
];
const EPILOGUE = ["drop memory_reviews_hash_idx", "unlock", "reset lock_timeout", "reset statement_timeout", "release"];

/** What `migrate()` must send when `applied` is already in the ledger and nothing fails. */
function expectedRun(applied: ReadonlySet<number>, versions: readonly number[] = ALL): string[] {
	const body: string[] = [];
	for (const version of versions) {
		body.push(`check ${version}`);
		if (!applied.has(version)) body.push("begin", `ddl ${version}`, `ledger ${version}`, "commit");
	}
	return [...PROLOGUE, ...body, ...EPILOGUE];
}

const isDdl = (event: string): boolean => event.startsWith("ddl ") || event === "begin" || event === "commit" || event.startsWith("ledger ");

describe("IndexStore.migrate() against a fake connection", () => {
	test("the harness itself: every step's text is distinct, so a recorded DDL maps to exactly one version", () => {
		expect(DDL_VERSION.size).toBe(MIGRATION_STEPS.length);
	});

	test("the opt-in step 33 is skipped by default: no check, no DDL, no ledger row", async () => {
		const { store, events, ledger } = fakeIndex();
		await store.migrate();
		expect(ALL).not.toContain(33);
		expect(events).not.toContain("check 33");
		expect(events).not.toContain("ddl 33");
		expect(ledger.has(33)).toBe(false);
	});

	test("with the steering-audit opt-in, step 33 applies in its own transaction and its down drops the table again", async () => {
		const step = MIGRATION_STEPS.find((candidate) => candidate.version === 33);
		expect(step?.name).toBe("planning_steering_audit");
		expect(step?.down).toBe("drop table if exists planning_steering_audit");
		const { store, events, ledger, tables, reserved } = fakeIndex({ migrationOptIns: { "steering-audit": true } });
		await store.migrate();
		expect(ALL_WITH_STEERING_AUDIT).toEqual([...ALL, 33]);
		expect(events).toEqual(expectedRun(new Set(), ALL_WITH_STEERING_AUDIT));
		expect(ledger.has(33)).toBe(true);
		expect(tables.has("planning_steering_audit")).toBe(true);

		await reserved.unsafe(step?.down ?? "");
		expect(tables.has("planning_steering_audit")).toBe(false);
		expect(events.at(-1)).toBe("drop table planning_steering_audit");
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
			`set statement_timeout ${INDEX_MIGRATE_STATEMENT_TIMEOUT_MS}`,
			"reset lock_timeout",
			"reset statement_timeout",
		]);
		expect(events.indexOf("reset lock_timeout")).toBeGreaterThan(events.indexOf("unlock"));
	});

	test("each step is its own transaction: ledger insert between its DDL and its COMMIT, never across steps", async () => {
		const { store, events } = fakeIndex();
		await store.migrate();
		const body = events.slice(PROLOGUE.length, events.length - EPILOGUE.length);
		expect(body).toHaveLength(ALL.length * 5);
		ALL.forEach((version, index) => {
			expect(body.slice(index * 5, index * 5 + 5)).toEqual([`check ${version}`, "begin", `ddl ${version}`, `ledger ${version}`, "commit"]);
		});
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
		const applied = events.filter((event) => event.startsWith("ddl ")).map((event) => Number(event.slice(4)));
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
