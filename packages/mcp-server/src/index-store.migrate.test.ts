/**
 * Boot migration ledger (uplift-6 U6-4).
 *
 * Offline checks the step list and the lock text. Live checks need a real Postgres,
 * same as `index-store.skills.test.ts`:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.migrate
 *
 * Contention: a second session holding `pg_advisory_lock(hashtextextended(indexMigrateLockKey()::text, 0))`
 * makes `migrate` wait until `lock_timeout` (180s) and then throw. That wait is the
 * behaviour; this file does not include a 180s test. The source of `migrate` is
 * checked for the lock, the unlock, `lock_timeout`, and `schema_migrations` instead.
 */
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexStore, MIGRATION_STEPS, applicableMigrationSteps, indexMigrateLockKey } from "./index-store.ts";
import { defined } from "./test-support.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const describeLive = PG_URL ? describe : describe.skip;

describe("migration steps and the migrate lock", () => {
	test("versions are 1..N contiguous and names are unique", () => {
		const versions = MIGRATION_STEPS.map((step) => step.version);
		expect(versions).toEqual(MIGRATION_STEPS.map((_, index) => index + 1));
		expect(new Set(MIGRATION_STEPS.map((step) => step.name)).size).toBe(MIGRATION_STEPS.length);
	});

	test("the advisory lock key is a single line", () => {
		expect(indexMigrateLockKey()).toBe("substrate.index.migrate");
		expect(indexMigrateLockKey().includes("\n")).toBe(false);
	});

	test("migrate takes and releases a session lock around schema_migrations", () => {
		const source = readFileSync(join(import.meta.dir, "index-store.ts"), "utf8");
		const migrate = source.slice(source.indexOf("async migrate()"), source.indexOf("// ── graph ──"));
		expect(migrate).toContain("pg_advisory_lock");
		expect(migrate).toContain("pg_advisory_unlock");
		expect(migrate).toContain("lock_timeout");
		expect(migrate).toContain("schema_migrations");
	});
});

function timeoutMs(value: string): number {
	const text = value.trim().toLowerCase();
	const match = /^([\d.]+)\s*(ms|s|min|h)?$/.exec(text);
	if (!match) throw new Error(`unparsed timeout: ${value}`);
	const amount = Number(match[1]);
	switch (match[2]) {
		case "s":
			return amount * 1000;
		case "min":
			return amount * 60_000;
		case "h":
			return amount * 3_600_000;
		default:
			return amount;
	}
}

async function timeoutSettings(sql: SQL): Promise<{ statement: string; lock: string }> {
	const rows = (await sql`
		select current_setting('statement_timeout') as statement_timeout, current_setting('lock_timeout') as lock_timeout`) as Array<{
		statement_timeout: string;
		lock_timeout: string;
	}>;
	const row = rows[0];
	if (row === undefined) throw new Error("current_setting returned no row");
	return { statement: String(row.statement_timeout), lock: String(row.lock_timeout) };
}

describeLive("migrate against a live index", () => {
	let store: IndexStore;
	let raw: SQL;
	let pool: SQL;
	let before: { statement: string; lock: string };

	beforeAll(async () => {
		const url = defined(PG_URL, "SUBSTRATE_TEST_PG_URL");
		raw = new SQL(url);
		store = new IndexStore(url);
		// The store pool is what `migrate` reserves. A separate client would not show a poisoned session.
		pool = (store as unknown as { sql: SQL }).sql;
		before = await timeoutSettings(pool);
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await raw.end().catch(() => undefined);
		await store.close().catch(() => undefined);
	});

	test("the second migrate adds no ledger rows, and the reviews indexes match the drop", async () => {
		await store.migrate();
		const count = async (): Promise<number> => {
			const rows = (await raw`select count(*)::int as n from schema_migrations`) as Array<{ n: number }>;
			const row = rows[0];
			if (row === undefined) throw new Error("schema_migrations count returned no row");
			return Number(row.n);
		};
		const once = await count();
		const applicable = applicableMigrationSteps({ "steering-audit": false });
		expect(once).toBe(applicable.length);
		const versions = (await raw`select version from schema_migrations order by version`) as Array<{ version: number }>;
		expect(versions.map((row) => Number(row.version))).toEqual(applicable.map((step) => step.version));
		await store.migrate();
		expect(await count()).toBe(once);
		const indexes = (await raw`
			select to_regclass('memory_reviews_hash_idx') as hash_idx, to_regclass('memory_reviews_pending_idx') as pending_idx`) as Array<{
			hash_idx: string | null;
			pending_idx: string | null;
		}>;
		const index = indexes[0];
		if (index === undefined) throw new Error("index lookup returned no row");
		expect(index.hash_idx).toBeNull();
		expect(index.pending_idx).not.toBeNull();
	});

	test("deleting the highest ledger row lets that step run again without a duplicate key", async () => {
		const removed = (await raw`
			delete from schema_migrations where version = (select max(version) from schema_migrations) returning version`) as Array<{
			version: number;
		}>;
		const dropped = removed[0];
		if (dropped === undefined) throw new Error("the ledger delete returned no row");
		const version = Number(dropped.version);
		await store.migrate();
		const rows = (await raw`select count(*)::int as n from schema_migrations where version = ${version}`) as Array<{ n: number }>;
		const row = rows[0];
		if (row === undefined) throw new Error("the ledger count returned no row");
		expect(Number(row.n)).toBe(1);
	});

	test("a query after migrate sees the same statement_timeout and lock_timeout as before it", async () => {
		await store.migrate();
		const after = await timeoutSettings(pool);
		expect(timeoutMs(after.statement)).toBe(timeoutMs(before.statement));
		expect(timeoutMs(after.lock)).toBe(timeoutMs(before.lock));
	});
});
