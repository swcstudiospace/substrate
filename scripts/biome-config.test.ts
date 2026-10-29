/**
 * Pins the Biome rule levels in `biome.json`, so loosening the lint gate needs a deliberate change here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

type Level = "error" | "warn" | "off";
interface BiomeConfig {
	linter: { enabled?: boolean; rules: Record<string, unknown> };
}

const config = JSON.parse(readFileSync(join(import.meta.dir, "..", "biome.json"), "utf8")) as BiomeConfig;
const rules = config.linter.rules;
const level = (group: string, rule: string): unknown => (rules[group] as Record<string, unknown> | undefined)?.[rule];

const PROMOTED: Record<string, readonly string[]> = {
	suspicious: ["noExplicitAny", "noProto", "noPrototypeBuiltins", "noUselessEscapeInString"],
	correctness: ["noUnusedImports", "noUnusedVariables", "noUnusedFunctionParameters"],
	style: ["useConst", "useImportType", "noNonNullAssertion"],
	complexity: ["noCommaOperator", "useRegexLiterals", "useOptionalChain"],
};
const OFF: Record<string, readonly string[]> = {
	suspicious: ["noTemplateCurlyInString"],
	complexity: ["useLiteralKeys"],
	style: ["useTemplate"],
};

describe("biome.json", () => {
	test("keeps the recommended preset", () => {
		expect(rules.preset).toBe("recommended");
	});

	test("the linter is enabled", () => {
		expect(config.linter.enabled).toBe(true);
	});

	for (const [group, names] of Object.entries(PROMOTED)) {
		for (const name of names) {
			test(`${group}/${name} is an error`, () => {
				expect(level(group, name)).toBe("error" as Level);
			});
		}
	}

	for (const [group, names] of Object.entries(OFF)) {
		for (const name of names) {
			test(`${group}/${name} is off`, () => {
				expect(level(group, name)).toBe("off" as Level);
			});
		}
	}

	test("no rule is off except the documented three", () => {
		const off: string[] = [];
		const walk = (path: string, node: unknown): void => {
			if (node === "off") off.push(path);
			else if (typeof node === "object" && node !== null) {
				const record = node as Record<string, unknown>;
				if (record.level === "off") off.push(path);
				else for (const [key, child] of Object.entries(record)) walk(path === "" ? key : `${path}/${key}`, child);
			}
		};
		walk("", rules);
		const documented = Object.entries(OFF).flatMap(([group, names]) => names.map((name) => `${group}/${name}`));
		expect(off.sort()).toEqual(documented.sort());
	});
});
