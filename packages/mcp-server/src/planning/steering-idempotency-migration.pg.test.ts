/**
 * Migration 43 (`planning_steering_idempotency`, under the steering-audit opt-in): up, down, then up again, on a throwaway database
 * created from the scratch URL and dropped afterwards. The shared test database is never altered, and no real store is touched.
 * Gated on SUBSTRATE_TEST_PG_URL; the role in that URL must be allowed to create and drop databases.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { IndexStore, MIGRATION_STEPS } from "../index-store.ts";
import { defined } from "../test-support.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const describeLive = PG_URL ? describe : describe.skip;
const STEP = defined(
	MIGRATION_STEPS.find((step) => step.version === 43),
	"migration 43",
);
const MIGRATION_TIMEOUT_MS = 120_000;

function withDatabase(url: string, database: string): string {
	const parsed = new URL(url);
	parsed.pathname = `/${database}`;
	return parsed.toString();
}

/** What migration 43 adds, read from the catalog: its two tables, the column, and the check constraints on the column. */
async function shapeOf(db: SQL) {
	const audit = await db`select to_regclass('planning_steering_audit')::text as relation`;
	const tables = await db`select table_name from information_schema.tables where table_schema = current_schema() and table_name in ('planning_steering_sequence', 'planning_steering_replay') order by table_name`;
	const columns = await db`select data_type, is_nullable from information_schema.columns where table_schema = current_schema() and table_name = 'planning_steering_audit' and column_name = 'delivery_sequence'`;
	const checks = await db`select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'planning_steering_audit'::regclass and conname = 'planning_steering_audit_delivery_sequence_check'`;
	return {
		audit: audit[0]?.relation ?? null,
		tables: tables.map((row: { table_name: unknown }) => String(row.table_name)),
		columns: columns.map((row: { data_type: unknown; is_nullable: unknown }) => ({ dataType: String(row.data_type), nullable: String(row.is_nullable) })),
		checks: checks.map((row: { definition: unknown }) => String(row.definition)),
	};
}

describeLive("migration 43 up and down on a throwaway database", () => {
	const name = `substrate_m43_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
	let admin: SQL | null = null;

	beforeAll(async () => {
		admin = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await admin.unsafe(`create database "${name}"`);
	});

	afterAll(async () => {
		if (admin === null) return;
		await admin.unsafe(`drop database if exists "${name}" with (force)`);
		await admin.close();
	});

	test(
		"up adds the tables, the column and its check; down removes exactly those; up again restores them",
		async () => {
			const url = withDatabase(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"), name);
			const store = new IndexStore(url, { migrationOptIns: { "steering-audit": true, "steering-sessions": false } });
			const db = new SQL(url);
			try {
				await store.migrate();
				const up = await shapeOf(db);
				expect(up.audit).toBe("planning_steering_audit");
				expect(up.tables).toEqual(["planning_steering_replay", "planning_steering_sequence"]);
				expect(up.columns).toEqual([{ dataType: "bigint", nullable: "YES" }]);
				expect(up.checks).toHaveLength(1);
				expect(up.checks[0]).toContain("delivery_sequence >= 1");

				await db.unsafe(defined(STEP.down, "migration 43 down"));
				expect(await shapeOf(db)).toEqual({ audit: "planning_steering_audit", tables: [], columns: [], checks: [] });

				await db.unsafe(STEP.sql);
				expect(await shapeOf(db)).toEqual(up);
			} finally {
				await db.close();
				await store.close();
			}
		},
		MIGRATION_TIMEOUT_MS,
	);
});
