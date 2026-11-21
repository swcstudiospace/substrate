/**
 * `migration_health` (read-only): the pure comparison over the steps, the pinned
 * digests and the ledger rows (`migration-health.ts`), plus the service
 * gathering (`Substrate.migrationHealth`) and the MCP door. Offline: no
 * database, no network.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrationDigests, stepDigest } from "../../../scripts/migration-digests.ts";
import { loadConfig } from "./config.ts";
import { MIGRATION_STEPS, type MigrationStep } from "./index-store.ts";
import { createMcpServer } from "./mcp.ts";
import {
	analyzeMigrationHealth,
	formatMigrationHealth,
	migrationStepDigest,
	parseMigrationDigests,
	readMigrationDigests,
} from "./migration-health.ts";
import { Substrate } from "./service.ts";

function step(version: number, sql: string, extra: Partial<MigrationStep> = {}): MigrationStep {
	return { version, name: `s${version}`, sql, ...extra };
}

const steps = [step(1, "create table if not exists a (id int)"), step(2, "create index if not exists a_idx on a (id)"), step(3, "create table if not exists b (id int)")];
const fixture = migrationDigests(steps);

describe("digest agreement", () => {
	test("migrationStepDigest is the same definition as scripts/migration-digests.ts stepDigest, over every real step", () => {
		for (const real of MIGRATION_STEPS) expect(migrationStepDigest(real)).toBe(stepDigest(real));
	});

	test("the committed fixture matches the real steps, and reports healthy with everything applied", () => {
		const report = analyzeMigrationHealth({
			steps: MIGRATION_STEPS,
			fixture: readMigrationDigests(),
			appliedVersions: MIGRATION_STEPS.map((real) => real.version),
		});
		expect(report.drift).toEqual([]);
		expect(report.pending).toEqual([]);
		expect(report.unknown_applied).toEqual([]);
		expect(report.healthy).toBe(true);
		expect(report.unavailable).toEqual([]);
		expect(report.step_count).toBe(MIGRATION_STEPS.length);
	});

	test("readMigrationDigests returns the committed fixture", () => {
		expect(readMigrationDigests()).toEqual(JSON.parse(JSON.stringify(migrationDigests(MIGRATION_STEPS))));
	});
});

describe("drift per key", () => {
	test("an edited step reports key, expected and actual, and is unhealthy", () => {
		const edited = [steps[0]!, step(2, "create index if not exists a_idx on a (id, other)"), steps[2]!];
		const report = analyzeMigrationHealth({ steps: edited, fixture, appliedVersions: [1, 2, 3] });
		expect(report.drift).toEqual([
			{ key: "2", name: "s2", expected: fixture["2"]!, actual: migrationStepDigest(edited[1]!), kind: "edited" },
		]);
		expect(report.healthy).toBe(false);
	});

	test("a step with no pinned digest reports missing_fixture_digest with a null expected", () => {
		const { "2": _dropped, ...partial } = fixture;
		const report = analyzeMigrationHealth({ steps, fixture: partial, appliedVersions: [1, 2, 3] });
		expect(report.drift).toEqual([
			{ key: "2", name: "s2", expected: null, actual: migrationStepDigest(steps[1]!), kind: "missing_fixture_digest" },
		]);
	});

	test("a pinned digest whose step is gone reports unknown_step with a null name and actual", () => {
		const withoutTwo = [steps[0]!, steps[2]!];
		const report = analyzeMigrationHealth({ steps: withoutTwo, fixture, appliedVersions: [1, 3] });
		expect(report.drift).toEqual([{ key: "2", name: null, expected: fixture["2"]!, actual: null, kind: "unknown_step" }]);
	});

	test("drift is ordered by numeric key, not fixture iteration order", () => {
		const edited = [step(1, "create table if not exists a (id int) -- edited"), steps[1]!, step(3, "create table if not exists b (id int) -- edited")];
		const report = analyzeMigrationHealth({ steps: edited, fixture, appliedVersions: [1, 2, 3] });
		expect(report.drift.map((entry) => entry.key)).toEqual(["1", "3"]);
	});
});

describe("pending and unknown applied", () => {
	test("pending is ordered by version and excludes applied versions", () => {
		const report = analyzeMigrationHealth({ steps, fixture, appliedVersions: [2] });
		expect(report.pending.map((entry) => entry.version)).toEqual([1, 3]);
		expect(report.applied_versions).toEqual([2]);
	});

	test("applied versions are de-duplicated and sorted ascending", () => {
		const report = analyzeMigrationHealth({ steps, fixture, appliedVersions: [2, 1, 2] });
		expect(report.applied_versions).toEqual([1, 2]);
	});

	test("an applied version no current step names is unknown_applied and makes the report unhealthy", () => {
		const report = analyzeMigrationHealth({ steps, fixture, appliedVersions: [1, 2, 3, 99] });
		expect(report.unknown_applied).toEqual([99]);
		expect(report.healthy).toBe(false);
	});

	test("opt-in steps are pending only when their opt-in is on", () => {
		const gated = [step(1, "create table if not exists a (id int)"), step(2, "create table if not exists audit (id int)", { optIn: "steering-audit" })];
		const gatedFixture = migrationDigests(gated);
		expect(analyzeMigrationHealth({ steps: gated, fixture: gatedFixture, appliedVersions: [], optIns: {} }).pending.map((entry) => entry.version)).toEqual([1]);
		expect(analyzeMigrationHealth({ steps: gated, fixture: gatedFixture, appliedVersions: [], optIns: { "steering-audit": true } }).pending.map((entry) => entry.version)).toEqual([1, 2]);
		expect(analyzeMigrationHealth({ steps: gated, fixture: gatedFixture, appliedVersions: [] }).pending.map((entry) => entry.version)).toEqual([1, 2]);
	});
});

describe("unreadable records degrade to not compared", () => {
	test("a null fixture skips drift and names it, without inventing agreement", () => {
		const report = analyzeMigrationHealth({ steps, fixture: null, appliedVersions: [1, 2, 3] });
		expect(report.drift).toEqual([]);
		expect(report.unavailable).toEqual(["fixture: index-store.migrations.digests.json could not be read"]);
	});

	test("a null ledger skips pending and names it", () => {
		const report = analyzeMigrationHealth({ steps, fixture, appliedVersions: null });
		expect(report.pending).toEqual([]);
		expect(report.unavailable).toEqual(["index: schema_migrations could not be read"]);
	});

	test("a caller-supplied index note is not duplicated by the ledger note", () => {
		const report = analyzeMigrationHealth({ steps, fixture, appliedVersions: null, unavailable: ["index: not configured"] });
		expect(report.unavailable).toEqual(["index: not configured"]);
	});
});

describe("fixture parsing", () => {
	test("accepts a version -> 64-hex object", () => {
		expect(parseMigrationDigests({ "1": "a".repeat(64) })).toEqual({ "1": "a".repeat(64) });
	});

	test("rejects non-objects, bad keys and bad digests", () => {
		expect(() => parseMigrationDigests(null)).toThrow();
		expect(() => parseMigrationDigests([])).toThrow();
		expect(() => parseMigrationDigests({ x: "a".repeat(64) })).toThrow();
		expect(() => parseMigrationDigests({ "1": "not-hex" })).toThrow();
		expect(() => parseMigrationDigests({ "1": "A".repeat(64) })).toThrow();
	});
});

describe("text format", () => {
	test("names drift per key, pending steps and unreadable records", () => {
		const edited = [steps[0]!, step(2, "create index if not exists a_idx on a (id, other)"), steps[2]!];
		const text = formatMigrationHealth(analyzeMigrationHealth({ steps: edited, fixture, appliedVersions: [1], unavailable: ["index: not configured"] }));
		expect(text).toContain("migration health — unhealthy, 1 digest drift, 2 pending");
		expect(text).toContain("- [drift] key 2 (s2): edited");
		expect(text).toContain("- [pending] step 2 (s2)");
		expect(text).toContain("- [pending] step 3 (s3)");
		expect(text).toContain("- [info] not compared — index: not configured");
	});

	test("a healthy report reads healthy", () => {
		const text = formatMigrationHealth(analyzeMigrationHealth({ steps, fixture, appliedVersions: [1, 2, 3] }));
		expect(text.startsWith("migration health — healthy, 0 digest drift, 0 pending")).toBe(true);
	});
});

describe("Substrate.migrationHealth", () => {
	test("with no index, drift is still compared and pending is not compared", async () => {
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });
		const report = await substrate.migrationHealth();
		expect(report.drift).toEqual([]);
		expect(report.pending).toEqual([]);
		expect(report.unavailable).toEqual(["index: not configured"]);
		expect(report.healthy).toBe(true);
	});

	test("a failing ledger read degrades to not compared rather than throwing", async () => {
		const substrate = new Substrate(loadConfig({}), {
			index: {
				migrationOptIns: {},
				appliedMigrationVersions: async () => {
					throw new Error("postgres is down");
				},
			} as never,
			greptime: null,
			steering: { history: null, liveSessions: null },
		});
		const report = await substrate.migrationHealth();
		expect(report.drift).toEqual([]);
		expect(report.pending).toEqual([]);
		expect(report.unavailable).toEqual(["index: schema_migrations could not be read"]);
	});

	test("pending comes from the ledger through the index, in application order", async () => {
		const substrate = new Substrate(loadConfig({}), {
			index: {
				migrationOptIns: {},
				appliedMigrationVersions: async () => MIGRATION_STEPS.slice(0, -1).map((real) => real.version),
			} as never,
			greptime: null,
			steering: { history: null, liveSessions: null },
		});
		const report = await substrate.migrationHealth();
		expect(report.pending.map((entry) => entry.version)).toEqual([MIGRATION_STEPS[MIGRATION_STEPS.length - 1]!.version]);
		expect(report.healthy).toBe(true);
	});
});

describe("MCP migration_health", () => {
	async function connect() {
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client;
	}

	test("the tool is listed, read-only, and reports the real fixture against a missing index", async () => {
		const client = await connect();
		const tools = (await client.listTools()).tools;
		const tool = tools.find((candidate) => candidate.name === "migration_health");
		expect(tool?.annotations?.readOnlyHint).toBe(true);
		const result = await client.callTool({ name: "migration_health", arguments: {} });
		expect(result.isError).toBeFalsy();
		const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
		const body = JSON.parse(text) as Record<string, unknown>;
		expect(body.drift_count).toBe(0);
		expect(body.unavailable).toEqual(["index: not configured"]);
	});

	test("format text answers printable lines instead of the report", async () => {
		const client = await connect();
		const result = await client.callTool({ name: "migration_health", arguments: { format: "text" } });
		const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
		expect(text.startsWith("migration health — ")).toBe(true);
	});
});
