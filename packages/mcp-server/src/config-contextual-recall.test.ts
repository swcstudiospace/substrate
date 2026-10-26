/**
 * The v1.6 phase 57c recall flags in `loadConfig`: `SUBSTRATE_DOCS_TANDEM`, `SUBSTRATE_DOCS_TANDEM_LIMIT`,
 * `SUBSTRATE_DOCS_TANDEM_BUDGET_MS` and `SUBSTRATE_BRIEF_RECALL_SCOPE`.
 *
 * What must hold: both policies are OFF by default and unset or blank flags say nothing; a value outside the
 * vocabulary keeps the default and is named, so a typo never switches a policy on; a number that is not a
 * whole number keeps the default, and one outside its range is capped to the nearest bound; every problem is a
 * boot warning that reaches the entry point's one warning loop. Pure: no environment, no network.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contextualRecallConfigWarnings, loadConfig } from "./config.ts";

const DEFAULTS = { tandem: { enabled: false, hindsight_limit: 5, budget_ms: 1500 }, recallScope: "off" as const, problems: [] };

describe("contextual recall config: defaults", () => {
	test("unset flags are off, 5 hits and 1500 ms, and say nothing", () => {
		const config = loadConfig({});
		expect(config.contextualRecall).toEqual(DEFAULTS);
		expect(contextualRecallConfigWarnings(config)).toEqual([]);
	});

	test("blank values are unset, not typos", () => {
		const config = loadConfig({
			SUBSTRATE_DOCS_TANDEM: "  ",
			SUBSTRATE_DOCS_TANDEM_LIMIT: "",
			SUBSTRATE_DOCS_TANDEM_BUDGET_MS: " ",
			SUBSTRATE_BRIEF_RECALL_SCOPE: "",
		});
		expect(config.contextualRecall).toEqual(DEFAULTS);
		expect(contextualRecallConfigWarnings(config)).toEqual([]);
	});

	test("an explicit off is the default without a warning", () => {
		const config = loadConfig({ SUBSTRATE_DOCS_TANDEM: "off", SUBSTRATE_BRIEF_RECALL_SCOPE: "off" });
		expect(config.contextualRecall).toEqual(DEFAULTS);
	});
});

describe("contextual recall config: valid values", () => {
	test("on, graph and in-range numbers are taken, case- and space-insensitively", () => {
		const config = loadConfig({
			SUBSTRATE_DOCS_TANDEM: " ON ",
			SUBSTRATE_DOCS_TANDEM_LIMIT: " 7 ",
			SUBSTRATE_DOCS_TANDEM_BUDGET_MS: "250",
			SUBSTRATE_BRIEF_RECALL_SCOPE: " Graph ",
		});
		expect(config.contextualRecall).toEqual({ tandem: { enabled: true, hindsight_limit: 7, budget_ms: 250 }, recallScope: "graph", problems: [] });
		expect(contextualRecallConfigWarnings(config)).toEqual([]);
	});

	test("the range bounds themselves are valid, not capped", () => {
		for (const [limit, budget] of [
			["1", "50"],
			["10", "10000"],
		] as const) {
			const config = loadConfig({ SUBSTRATE_DOCS_TANDEM_LIMIT: limit, SUBSTRATE_DOCS_TANDEM_BUDGET_MS: budget });
			expect(config.contextualRecall.tandem).toMatchObject({ hindsight_limit: Number(limit), budget_ms: Number(budget) });
			expect(config.contextualRecall.problems).toEqual([]);
		}
	});

	test("the two policies are independent", () => {
		expect(loadConfig({ SUBSTRATE_DOCS_TANDEM: "on" }).contextualRecall).toMatchObject({ tandem: { enabled: true }, recallScope: "off" });
		expect(loadConfig({ SUBSTRATE_BRIEF_RECALL_SCOPE: "graph" }).contextualRecall).toMatchObject({ tandem: { enabled: false }, recallScope: "graph" });
	});
});

describe("contextual recall config: typos keep the default and are named", () => {
	test("a tandem value outside off/on is off, so a typo never switches the policy on", () => {
		// "true" and "1" are accepted by the tandem option parser for tool arguments, but the env vocabulary is off|on only.
		for (const typo of ["yes", "true", "1", "onn", "enabled"]) {
			const config = loadConfig({ SUBSTRATE_DOCS_TANDEM: typo });
			expect(config.contextualRecall.tandem.enabled).toBe(false);
			expect(config.contextualRecall.problems).toEqual([`SUBSTRATE_DOCS_TANDEM="${typo}" is neither off nor on; running as off`]);
		}
	});

	test("a scope outside off/graph is off and named", () => {
		for (const typo of ["graphs", "repo", "on", "all"]) {
			const config = loadConfig({ SUBSTRATE_BRIEF_RECALL_SCOPE: typo });
			expect(config.contextualRecall.recallScope).toBe("off");
			expect(config.contextualRecall.problems).toEqual([`SUBSTRATE_BRIEF_RECALL_SCOPE="${typo}" is neither off nor graph; running as off`]);
		}
	});

	test("a number that is not a whole number keeps the default and names the variable", () => {
		for (const bad of ["abc", "1.5", "-3", "5ms", "0x10", "1e3", "NaN"]) {
			const config = loadConfig({ SUBSTRATE_DOCS_TANDEM_LIMIT: bad, SUBSTRATE_DOCS_TANDEM_BUDGET_MS: bad });
			expect(config.contextualRecall.tandem).toEqual({ enabled: false, hindsight_limit: 5, budget_ms: 1500 });
			expect(config.contextualRecall.problems).toEqual([
				`SUBSTRATE_DOCS_TANDEM_LIMIT=${JSON.stringify(bad)} is not a whole number; using 5`,
				`SUBSTRATE_DOCS_TANDEM_BUDGET_MS=${JSON.stringify(bad)} is not a whole number; using 1500`,
			]);
		}
	});

	test("every problem is named, in a fixed order", () => {
		const config = loadConfig({
			SUBSTRATE_DOCS_TANDEM: "maybe",
			SUBSTRATE_DOCS_TANDEM_LIMIT: "many",
			SUBSTRATE_DOCS_TANDEM_BUDGET_MS: "soon",
			SUBSTRATE_BRIEF_RECALL_SCOPE: "nowhere",
		});
		expect(config.contextualRecall.problems.map((problem) => problem.split("=")[0])).toEqual([
			"SUBSTRATE_DOCS_TANDEM",
			"SUBSTRATE_BRIEF_RECALL_SCOPE",
			"SUBSTRATE_DOCS_TANDEM_LIMIT",
			"SUBSTRATE_DOCS_TANDEM_BUDGET_MS",
		]);
		expect(config.contextualRecall.tandem).toEqual({ enabled: false, hindsight_limit: 5, budget_ms: 1500 });
		expect(config.contextualRecall.recallScope).toBe("off");
	});
});

describe("contextual recall config: out-of-range numbers are capped and named", () => {
	test("the limit is capped to 1..10", () => {
		const low = loadConfig({ SUBSTRATE_DOCS_TANDEM_LIMIT: "0" });
		expect(low.contextualRecall.tandem.hindsight_limit).toBe(1);
		expect(low.contextualRecall.problems).toEqual(['SUBSTRATE_DOCS_TANDEM_LIMIT="0" is outside 1..10; using 1']);
		const high = loadConfig({ SUBSTRATE_DOCS_TANDEM_LIMIT: "99" });
		expect(high.contextualRecall.tandem.hindsight_limit).toBe(10);
		expect(high.contextualRecall.problems).toEqual(['SUBSTRATE_DOCS_TANDEM_LIMIT="99" is outside 1..10; using 10']);
	});

	test("the budget is capped to 50..10000 ms", () => {
		const low = loadConfig({ SUBSTRATE_DOCS_TANDEM_BUDGET_MS: "10" });
		expect(low.contextualRecall.tandem.budget_ms).toBe(50);
		expect(low.contextualRecall.problems).toEqual(['SUBSTRATE_DOCS_TANDEM_BUDGET_MS="10" is outside 50..10000; using 50']);
		const high = loadConfig({ SUBSTRATE_DOCS_TANDEM_BUDGET_MS: "99999" });
		expect(high.contextualRecall.tandem.budget_ms).toBe(10_000);
		expect(high.contextualRecall.problems).toEqual(['SUBSTRATE_DOCS_TANDEM_BUDGET_MS="99999" is outside 50..10000; using 10000']);
	});

	test("a capped value does not change the other flags", () => {
		const config = loadConfig({ SUBSTRATE_DOCS_TANDEM: "on", SUBSTRATE_DOCS_TANDEM_LIMIT: "500", SUBSTRATE_BRIEF_RECALL_SCOPE: "graph" });
		expect(config.contextualRecall.tandem).toEqual({ enabled: true, hindsight_limit: 10, budget_ms: 1500 });
		expect(config.contextualRecall.recallScope).toBe("graph");
	});
});

describe("contextual recall config: boot warnings", () => {
	test("the warnings are the problems, as a copy the caller cannot use to edit the config", () => {
		const config = loadConfig({ SUBSTRATE_DOCS_TANDEM: "yes", SUBSTRATE_DOCS_TANDEM_LIMIT: "0" });
		const warnings = contextualRecallConfigWarnings(config);
		expect(warnings).toEqual(config.contextualRecall.problems);
		expect(warnings).toHaveLength(2);
		warnings.push("tampered");
		expect(config.contextualRecall.problems).toHaveLength(2);
	});

	test("the entry point reports them from its one boot-warning loop", () => {
		const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
		expect(source.match(/contextualRecallConfigWarnings\(config\)/g)?.length).toBe(1);
		expect(source).toMatch(/\[\s*\.\.\.configWarnings\(config\)[^\]]*contextualRecallConfigWarnings\(config\)[^\]]*\]/);
	});
});
