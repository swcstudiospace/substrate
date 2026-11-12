/**
 * The standalone `substrate` build (scripts/build-binaries.ts). The commands whose runners the artifact does not
 * include are refused by name before anything is spawned; every other command runs the CLI unchanged.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STANDALONE_REFUSALS, TARGETS, buildSteps, guardedEntry, guardedEntrySource, importSpecifier } from "./build-binaries.ts";

const CLI = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes the guard exactly as the build does, into a fresh directory outside the checkout. */
function writeGuard(): string {
	const dir = mkdtempSync(join(tmpdir(), "substrate-guard-"));
	dirs.push(dir);
	const file = join(dir, "substrate.ts");
	writeFileSync(file, guardedEntrySource(importSpecifier(dir, CLI)));
	return file;
}

describe("standalone substrate guard", () => {
	test.each(STANDALONE_REFUSALS.map(({ command }) => [command]))("refuses `%s` by name with exit 2 and never runs the CLI", (command) => {
		const result = spawnSync(process.execPath, [writeGuard(), command, "sweep"], { encoding: "utf8" });
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`substrate ${command} is not available in the standalone binary`);
	});

	test("every other command runs the CLI unchanged", () => {
		const guarded = spawnSync(process.execPath, [writeGuard()], { encoding: "utf8" });
		const direct = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
		expect(guarded.status).toBe(direct.status);
		expect(guarded.stdout).toBe(direct.stdout);
		expect(guarded.stderr).toBe(direct.stderr);
	});
});

describe("buildSteps", () => {
	test("the standalone substrate compiles its guard entry; substrate-mcp compiles its own entry", () => {
		const steps = buildSteps(TARGETS);
		// argv: build, --compile, --target=<t>, <entry>, --outfile, <outfile>
		const entries = (name: string) => steps.filter((step) => step.name === name).map((step) => step.argv[3]);
		expect(entries("substrate")).toEqual(TARGETS.map(() => guardedEntry("substrate")));
		expect(entries("substrate-mcp")).toEqual(TARGETS.map(() => "packages/mcp-server/src/index.ts"));
	});
});
