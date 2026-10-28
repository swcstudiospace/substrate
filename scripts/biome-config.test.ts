/**
 * Pins the Biome rule levels in `biome.json`, so loosening the lint gate needs a deliberate change here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

type Level = "error" | "warn" | "off";
interface BiomeConfig {
	linter: { rules: Record<string, unknown> };
}

const config = JSON.parse(readFileSync(join(import.meta.dir, "..", "biome.json"), "utf8")) as BiomeConfig;
const rules = config.linter.rules;
const level = (group: string, rule: string): unknown => (rules[group] as Record<string, unknown> | undefined)?.[rule];

const PROMOTED: Record<string, readonly string[]> = {
	suspicious: ["noExplicitAny", "noProto", "noPrototypeBuiltins", "noUselessEscapeInString"],
	correctness: ["noUnusedImports", "noUnusedVariables", "noUnusedFunctionParameters"],
	style: ["useConst", "useImportType"],
	complexity: ["noCommaOperator", "useRegexLiterals"],
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

	test("noNonNullAssertion and useOptionalChain stay warnings", () => {
		expect(level("style", "noNonNullAssertion")).toBe("warn" as Level);
		expect(level("complexity", "useOptionalChain")).toBe("warn" as Level);
	});
});
