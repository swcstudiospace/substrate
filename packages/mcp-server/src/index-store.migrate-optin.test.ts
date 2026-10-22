/**
 * The steering audit table is created by `migrate()` only under its opt-in (phase 53, SOTA-09), proved without a
 * database. The store's connection is a fake that records every statement and answers with no rows, so the real
 * `migrate()` runs its ledger loop against it.
 */
import { describe, expect, test } from "bun:test";
import { IndexStore, type MigrationOptIns } from "./index-store.ts";

const STEERING_AUDIT_DDL = "create table if not exists planning_steering_audit";

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
