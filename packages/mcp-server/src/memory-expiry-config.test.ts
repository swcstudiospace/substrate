/**
 * `SUBSTRATE_MEMORY_EXPIRY` (uplift-3 N4): `report` unless the operator says
 * `enforce`, and never `enforce` by typo — anything unrecognised is `report`
 * with one boot warning from the one warning loop in `index.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, memoryExpiryConfigWarnings } from "./config.ts";

describe("SUBSTRATE_MEMORY_EXPIRY", () => {
	test("unset, blank and report are report; enforce is enforce, whatever the case or spacing", () => {
		expect(loadConfig({}).memoryExpiry).toBe("report");
		expect(loadConfig({ SUBSTRATE_MEMORY_EXPIRY: "   " }).memoryExpiry).toBe("report");
		expect(loadConfig({ SUBSTRATE_MEMORY_EXPIRY: "report" }).memoryExpiry).toBe("report");
		expect(loadConfig({ SUBSTRATE_MEMORY_EXPIRY: " Enforce " }).memoryExpiry).toBe("enforce");
		expect(loadConfig({ SUBSTRATE_MEMORY_EXPIRY: "ENFORCE" }).memoryExpiry).toBe("enforce");
		for (const env of [{}, { SUBSTRATE_MEMORY_EXPIRY: "enforce" }, { SUBSTRATE_MEMORY_EXPIRY: "report" }]) {
			expect(loadConfig(env).memoryExpiryRejected).toBeNull();
			expect(memoryExpiryConfigWarnings(loadConfig(env))).toEqual([]);
		}
	});

	test("anything else is report, remembered for one boot warning that names the key and says nothing is hidden", () => {
		// The failure this prevents: `enforc` or `true` quietly meaning either mode.
		for (const raw of ["enforc", "true", "1", "delete", "off"]) {
			const config = loadConfig({ SUBSTRATE_MEMORY_EXPIRY: raw });
			expect(config.memoryExpiry).toBe("report");
			expect(config.memoryExpiryRejected).toBe(raw);
			const warnings = memoryExpiryConfigWarnings(config);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("SUBSTRATE_MEMORY_EXPIRY");
			expect(warnings[0]).toContain(raw);
			expect(warnings[0]).toContain("running as report");
		}
	});

	test("the entry point reports it from its one boot-warning loop", () => {
		const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
		expect(source.match(/memoryExpiryConfigWarnings\(config\)/g)?.length).toBe(1);
		expect(source).toMatch(/\[\.\.\.configWarnings\(config\)[^\]]*memoryExpiryConfigWarnings\(config\)[^\]]*\]/);
	});
});
