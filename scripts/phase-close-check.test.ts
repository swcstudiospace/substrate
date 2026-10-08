/**
 * Pure-helper tests for `scripts/phase-close-check.ts`.
 *
 * No git, no spawn, no network: every case drives the exported parsers
 * and diff helpers over inline fixture text, so this file verifies the
 * gate's verdict logic without running the gate itself.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE, diffKinds, diffSurfaces, LOCK_TESTS, missingFiles, parseEventKinds, parseSurfaces } from "./phase-close-check.ts";

const FIXTURE = `export const SWARM_SURFACES = [
	"swarm-a01-orch",
	"swarm-a15-doc",
] as const;

export const SURFACES = [
	"claude-code",
	"cursor",
	...SWARM_SURFACES,
	"substrate",
] as const;

export const EVENT_KINDS = [
	"session.start",
	"prompt",
	"note",
] as const;
`;

describe("BASELINE and LOCK_TESTS", () => {
	test("the baseline names the v1.2 commit", () => {
		expect(BASELINE).toBe("ab62c91");
	});

	test("the lock set holds the four vocabulary and audit files", () => {
		expect([...LOCK_TESTS]).toEqual([
			"packages/mcp-server/src/store-lock.test.ts",
			"packages/mcp-server/src/vocabulary-lock.test.ts",
			"packages/mcp-server/src/event-sources.test.ts",
			"packages/audit/src/policy.test.ts",
		]);
	});
});

describe("parseEventKinds", () => {
	test("extracts the quoted kinds in order", () => {
		expect(parseEventKinds(FIXTURE)).toEqual(["session.start", "prompt", "note"]);
	});

	test("returns null when the block is absent", () => {
		expect(parseEventKinds("export const X = 1;\n")).toBeNull();
	});
});

describe("parseSurfaces", () => {
	test("expands the swarm spread from the same file text", () => {
		expect(parseSurfaces(FIXTURE)).toEqual(["claude-code", "cursor", "swarm-a01-orch", "swarm-a15-doc", "substrate"]);
	});

	test("returns null when the block is absent", () => {
		expect(parseSurfaces("export const X = 1;\n")).toBeNull();
	});
});

describe("diffKinds", () => {
	test("empty when the lists are equal", () => {
		expect(diffKinds(["note", "warning"], ["note", "warning"])).toEqual([]);
	});

	test("an appended kind reads as an index-level diff line", () => {
		// An appended kind is the failure the gate must catch: EVENT_KINDS grew.
		const lines = diffKinds(["note"], ["note", "warning"]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("kinds[1]");
	});

	test("a changed kind names the index", () => {
		const lines = diffKinds(["note"], ["prompt"]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("kinds[0]");
	});
});

describe("diffSurfaces", () => {
	test("empty when current equals baseline plus substrate", () => {
		expect(diffSurfaces(["claude-code", "cursor"], ["claude-code", "cursor", "substrate"])).toEqual([]);
	});

	test("removing substrate is a surfaces diff", () => {
		// The host-job surface must stay: without it later phases cannot emit it.
		const lines = diffSurfaces(["claude-code"], ["claude-code"]);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join("\n")).toContain("surfaces[1]");
	});

	test("any other added surface is a surfaces diff", () => {
		const lines = diffSurfaces(["claude-code"], ["claude-code", "substrate", "extra"]);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join("\n")).toContain("surfaces[2]");
	});
});

describe("missingFiles", () => {
	test("names only the absent files", () => {
		const dir = mkdtempSync(join(tmpdir(), "p17-"));
		writeFileSync(join(dir, "present.ts"), "export const x = 1;\n");
		expect(missingFiles(dir, ["present.ts", "absent.ts"])).toEqual(["absent.ts"]);
	});

	test("empty when every lock file is present", () => {
		const dir = mkdtempSync(join(tmpdir(), "p17-"));
		writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
		expect(missingFiles(dir, ["a.ts"])).toEqual([]);
	});
});
