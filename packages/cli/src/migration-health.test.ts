/**
 * `substrate index migrate-health` — the CLI mirror of the `migration_health`
 * MCP tool. The ledger and fixture both have test seams, so the exit codes and
 * the output shapes are exercised without a database.
 */
import { describe, expect, test } from "bun:test";
import { MIGRATION_STEPS } from "../../mcp-server/src/index-store.ts";
import { readMigrationDigests } from "../../mcp-server/src/migration-health.ts";
import { runMigrationHealth } from "./migration-health.ts";

function deps(overrides: Partial<Parameters<typeof runMigrationHealth>[1]> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		deps: {
			env: {},
			out: (text: string) => out.push(text),
			err: (text: string) => err.push(text),
			...overrides,
		},
	};
}

describe("runMigrationHealth", () => {
	test("exit 0 and healthy text when the real fixture matches the real steps", async () => {
		const h = deps({ readApplied: async () => MIGRATION_STEPS.map((step) => step.version) });
		const code = await runMigrationHealth([], h.deps);
		expect(code).toBe(0);
		expect(h.out.join("")).toContain("migration health — healthy, 0 digest drift, 0 pending");
		expect(h.err).toEqual([]);
	});

	test("exit 1 and drift per key when a pinned digest disagrees", async () => {
		const real = readMigrationDigests();
		const drifted = { ...real };
		delete drifted["1"];
		const h = deps({ readFixture: () => drifted, readApplied: async () => MIGRATION_STEPS.map((step) => step.version) });
		const code = await runMigrationHealth([], h.deps);
		expect(code).toBe(1);
		expect(h.out.join("")).toContain("- [drift] key 1");
		expect(h.out.join("")).toContain("missing_fixture_digest");
	});

	test("--json prints the report as one JSON body", async () => {
		const h = deps({ readApplied: async () => [1] });
		const code = await runMigrationHealth(["--json"], h.deps);
		expect(code).toBe(0);
		const parsed: unknown = JSON.parse(h.out.join(""));
		if (parsed === null || typeof parsed !== "object") throw new Error("json body is not an object");
		const body = parsed as Record<string, unknown>;
		expect(body.healthy).toBe(true);
		expect(body.pending_count).toBe(MIGRATION_STEPS.length - 1);
		expect((body.pending as Array<{ version: number }>).map((entry) => entry.version)).toEqual(MIGRATION_STEPS.slice(1).map((step) => step.version));
	});

	test("without SUBSTRATE_PG_URL, pending is not compared and the exit stays 0", async () => {
		const h = deps();
		const code = await runMigrationHealth([], h.deps);
		expect(code).toBe(0);
		expect(h.out.join("")).toContain("- [info] not compared — index: SUBSTRATE_PG_URL is unset");
	});

	test("an unknown argument is usage, exit 2, with nothing on stdout", async () => {
		const h = deps({ readApplied: async () => [] });
		const code = await runMigrationHealth(["--bogus"], h.deps);
		expect(code).toBe(2);
		expect(h.out).toEqual([]);
		expect(h.err.join("")).toContain("unknown argument: --bogus");
	});
});
