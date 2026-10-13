/**
 * The Hindsight routing-key boot warnings (uplift-2 R3): the legacy, unread
 * `HINDSIGHT_BANK` and a URL with no `HINDSIGHT_BANKS`. Each fires once per
 * boot, from the one warning loop in `index.ts`, and names keys, never values.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hindsightConfigWarnings, loadConfig } from "./config.ts";

describe("hindsightConfigWarnings", () => {
	test("the legacy single-bank key warns once and names the replacement", () => {
		const warnings = hindsightConfigWarnings(loadConfig({ HINDSIGHT_BANK: "pd-grok-bot", HINDSIGHT_URL: "http://fake", HINDSIGHT_BANKS: "sub-cursor" }));
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("HINDSIGHT_BANK is set");
		expect(warnings[0]).toContain("HINDSIGHT_BANKS");
		expect(warnings[0]).not.toContain("pd-grok-bot");
	});

	test("a URL without a bank list warns once about caller-only recall", () => {
		const warnings = hindsightConfigWarnings(loadConfig({ HINDSIGHT_URL: "http://fake", HINDSIGHT_API_KEY: "k" }));
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("HINDSIGHT_BANKS is empty");
		expect(warnings[0]).toContain("caller's own bank");
		expect(warnings[0]).not.toContain("http://fake");
	});

	test("both conditions give two warnings; a clean or absent configuration gives none", () => {
		expect(hindsightConfigWarnings(loadConfig({ HINDSIGHT_BANK: "x", HINDSIGHT_URL: "http://fake" })).length).toBe(2);
		expect(hindsightConfigWarnings(loadConfig({}))).toEqual([]);
		expect(hindsightConfigWarnings(loadConfig({ HINDSIGHT_URL: "http://fake", HINDSIGHT_BANKS: "sub-cursor sub-hermes" }))).toEqual([]);
		// Whitespace-only is unset: an env file line left blank must not warn.
		expect(hindsightConfigWarnings(loadConfig({ HINDSIGHT_BANK: "  " }))).toEqual([]);
	});

	test("presence is recorded without the value", () => {
		const config = loadConfig({ HINDSIGHT_BANK: "secret-ish", HINDSIGHT_URL: "http://fake" });
		expect(config.hindsightEnv).toEqual({ legacyBankSet: true, urlSet: true, banksSet: false });
		expect(JSON.stringify(config.hindsightEnv)).not.toContain("secret-ish");
	});

	test("the entry point reports them from its one boot-warning loop", () => {
		const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
		expect(source.match(/hindsightConfigWarnings\(config\)/g)?.length).toBe(1);
		expect(source).toMatch(/\[\s*\.\.\.configWarnings\(config\)[^\]]*hindsightConfigWarnings\(config\)[^\]]*\]/);
	});
});
