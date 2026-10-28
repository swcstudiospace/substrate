/**
 * The steering audit table is created by `migrate()` only under its opt-in (phase 53, SOTA-09), proved without a
 * database. The store's connection is a fake that records every statement and answers with no rows, so the real
 * `migrate()` runs its ledger loop against it.
 */
import { describe, expect, test } from "bun:test";
import { IndexStore, MIGRATION_STEPS, applicableMigrationSteps, type MigrationOptIns } from "./index-store.ts";

const STEERING_AUDIT_DDL = "create table if not exists planning_steering_audit";
const STEERING_REASON_DDL = "add column if not exists reason text";

/** Runs `migrate()` on a store built with `optIns` and returns every statement text it issued, in order. */
async function migrateRecording(optIns: MigrationOptIns | undefined): Promise<string[]> {
	const statements: string[] = [];
	const reserved = Object.assign(
		(strings: TemplateStringsArray) => {
			statements.push(strings.join("?"));
			return Promise.resolve([]);
		},
		{
			unsafe: (text: string) => {
				statements.push(text);
				return Promise.resolve([]);
			},
			release: () => undefined,
			close: () => Promise.resolve(),
		},
	);
	const store = new IndexStore("postgres://u@localhost/x", optIns === undefined ? {} : { migrationOptIns: optIns });
	// The pool is private, so the connection is swapped through the seam the capacity test also uses.
	const internals: { sql: unknown } = store as unknown as { sql: unknown };
	internals.sql = { reserve: () => Promise.resolve(reserved) };
	await store.migrate();
	return statements;
}

describe("the steering audit table is created only under its opt-in", () => {
	test("with the opt-in off, migrate() runs the ungated steps and never creates planning_steering_audit", async () => {
		const statements = await migrateRecording({ "steering-audit": false });
		expect(statements.some((text) => text.includes("create table if not exists graph_index"))).toBe(true);
		expect(statements.some((text) => text.includes(STEERING_AUDIT_DDL))).toBe(false);
	});

	test("with no options at all, the default is off and the table is not created", async () => {
		const statements = await migrateRecording(undefined);
		expect(statements.some((text) => text.includes(STEERING_AUDIT_DDL))).toBe(false);
	});

	test("with the opt-in on, migrate() creates planning_steering_audit", async () => {
		const statements = await migrateRecording({ "steering-audit": true });
		expect(statements.some((text) => text.includes(STEERING_AUDIT_DDL))).toBe(true);
	});
});

describe("the steering audit reason column (step 34) follows the same opt-in", () => {
	test("with the opt-in off, migrate() never adds the reason column", async () => {
		const statements = await migrateRecording({ "steering-audit": false });
		expect(statements.some((text) => text.includes(STEERING_REASON_DDL))).toBe(false);
	});

	test("with no options at all, the default is off and the reason column is not added", async () => {
		const statements = await migrateRecording(undefined);
		expect(statements.some((text) => text.includes(STEERING_REASON_DDL))).toBe(false);
	});

	test("with the opt-in on, migrate() adds the reason column after it creates the table", async () => {
		const statements = await migrateRecording({ "steering-audit": true });
		const created = statements.findIndex((text) => text.includes(STEERING_AUDIT_DDL));
		const altered = statements.findIndex((text) => text.includes(STEERING_REASON_DDL));
		expect(created).toBeGreaterThanOrEqual(0);
		expect(altered).toBeGreaterThan(created);
	});

	test("the step is gated, additive and idempotent", () => {
		const step = MIGRATION_STEPS.find((candidate) => candidate.version === 34);
		expect(step?.optIn).toBe("steering-audit");
		expect(step?.sql).toContain("alter table planning_steering_audit");
		expect(step?.sql).toContain(STEERING_REASON_DDL);
		expect(step?.sql).not.toMatch(/\b(drop|delete|truncate|update)\b/i);
	});

	test("applicable steps leave 33 and 34 out when the opt-in is off and include both, in order, when it is on", () => {
		const versions = (optIns: MigrationOptIns) => applicableMigrationSteps(optIns).map((step) => step.version);
		expect(versions({ "steering-audit": false })).not.toContain(33);
		expect(versions({ "steering-audit": false })).not.toContain(34);
		const on = versions({ "steering-audit": true });
		expect(on).toContain(34);
		expect(on.indexOf(33)).toBeGreaterThanOrEqual(0);
		expect(on.indexOf(34)).toBeGreaterThan(on.indexOf(33));
	});
});
