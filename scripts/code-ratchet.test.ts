import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type Baseline,
	type BaselineCounters,
	COUNTER_NAMES,
	type Comparison,
	type CounterName,
	type CounterSet,
	compare,
	countFile,
	emptyCounterSet,
	LOWER_BASELINE_MESSAGE,
	loadBaseline,
	maskSource,
	scan,
	serializeBaseline,
} from "./code-ratchet.ts";

const SOURCE_PATH = "packages/demo/src/lib.ts";

function counted(name: CounterName, text: string, path: string = SOURCE_PATH): number {
	return countFile(path, text)[name];
}

function lines(...parts: string[]): string {
	return parts.join("\n");
}

describe("masking", () => {
	test("keeps length and line structure", () => {
		const text = lines("// c: any", "const s = 'x: any';", "/* a", "b */ const t = `y", "z`;");
		const masked = maskSource(text);
		expect(masked.code.length).toBe(text.length);
		expect(masked.commented.length).toBe(text.length);
		expect(masked.code.split("\n").length).toBe(text.split("\n").length);
	});

	test("ignores an apostrophe inside a comment", () => {
		expect(counted("explicit_any", lines("// don't", "const v: any = 1;"))).toBe(1);
	});

	test("a quote inside a regex literal does not open a string", () => {
		expect(counted("explicit_any", lines("const re = /[\"']/g;", "const v: any = 1;"))).toBe(1);
	});

	test("a division is not a regex literal", () => {
		expect(counted("explicit_any", lines("const h = a / b;", "const v: any = c / d;"))).toBe(1);
	});

	test("code in a template expression counts, template text does not", () => {
		expect(counted("explicit_any", "const a = `x: any ${b as any} y as any`;")).toBe(1);
	});

	test("nested templates and braces inside an expression", () => {
		expect(counted("explicit_any", "const a = `a ${`b: any`} c`;")).toBe(0);
		expect(counted("explicit_any", "const a = `a ${{ k: 1 }.k as any} c`;")).toBe(1);
	});

	test("an escaped quote does not end a string", () => {
		expect(counted("explicit_any", 'const s = "a\\"b: any";')).toBe(0);
	});

	test("a shebang line is not parsed as a regex", () => {
		expect(counted("explicit_any", lines("#!/usr/bin/env bun", "const v: any = 1;"))).toBe(1);
	});
});

describe("explicit_any", () => {
	test("matches the five explicit forms once each", () => {
		expect(counted("explicit_any", "const a: any = 1;")).toBe(1);
		expect(counted("explicit_any", "const a = b as any;")).toBe(1);
		expect(counted("explicit_any", "const a = <any>b;")).toBe(1);
		expect(counted("explicit_any", "let a: any[] = [];")).toBe(1);
		expect(counted("explicit_any", "let a = c as any[];")).toBe(1);
		expect(counted("explicit_any", "let a: Record<string, any> = {};")).toBe(1);
		expect(counted("explicit_any", "let a: Promise<any>;")).toBe(1);
	});

	test("does not match look-alikes, strings, comments or regexes", () => {
		expect(counted("explicit_any", "const many = 1; const company: string = 'x';")).toBe(0);
		expect(counted("explicit_any", "const a: anything = 1;")).toBe(0);
		expect(counted("explicit_any", "const a = z.any(); const b = x.any;")).toBe(0);
		expect(counted("explicit_any", "const a = { anyOf: 1 };")).toBe(0);
		expect(counted("explicit_any", "// const a: any = 1;")).toBe(0);
		expect(counted("explicit_any", "/* b as any */ const a = 1;")).toBe(0);
		expect(counted("explicit_any", 'const s = "as any";')).toBe(0);
		expect(counted("explicit_any", "const re = /: any/;")).toBe(0);
	});
});

describe("as_unknown_as", () => {
	test("matches a double cast", () => {
		expect(counted("as_unknown_as", "const a = b as unknown as Foo;")).toBe(1);
		expect(counted("as_unknown_as", "const a = b as unknown as Foo; const c = d as unknown as Bar;")).toBe(2);
	});

	test("does not match a single cast, a comment or a string", () => {
		expect(counted("as_unknown_as", "const a = b as unknown;")).toBe(0);
		expect(counted("as_unknown_as", "// b as unknown as Foo")).toBe(0);
		expect(counted("as_unknown_as", 'const s = "b as unknown as Foo";')).toBe(0);
	});
});

describe("ts_suppressions", () => {
	test("matches the three TypeScript suppression comments", () => {
		expect(counted("ts_suppressions", "// @ts-ignore\nconst a = 1;")).toBe(1);
		expect(counted("ts_suppressions", "// @ts-expect-error: reason\nconst a = 1;")).toBe(1);
		expect(counted("ts_suppressions", "/* @ts-nocheck */")).toBe(1);
	});

	test("does not match a string literal or ordinary comments", () => {
		expect(counted("ts_suppressions", 'const s = "@ts-ignore";')).toBe(0);
		expect(counted("ts_suppressions", "// ts-ignore without the at sign")).toBe(0);
	});
});

describe("lint_suppressions", () => {
	test("matches biome and eslint suppression comments", () => {
		expect(counted("lint_suppressions", "// biome-ignore lint/suspicious/noExplicitAny: reason\nconst a = 1;")).toBe(1);
		expect(counted("lint_suppressions", "// eslint-disable-next-line no-console\nconst a = 1;")).toBe(1);
		expect(counted("lint_suppressions", "/* eslint-disable */")).toBe(1);
	});

	test("does not match a string literal", () => {
		expect(counted("lint_suppressions", 'const s = "biome-ignore";')).toBe(0);
	});
});

describe("non_null_assertions", () => {
	test("matches the five assertion shapes", () => {
		expect(counted("non_null_assertions", "const v = a!.b;")).toBe(1);
		expect(counted("non_null_assertions", "const v = a!;")).toBe(1);
		expect(counted("non_null_assertions", "f(a!);")).toBe(1);
		expect(counted("non_null_assertions", "f(a!, b);")).toBe(1);
		expect(counted("non_null_assertions", "const v = a![0];")).toBe(1);
		expect(counted("non_null_assertions", "const v = a!.b!.c;")).toBe(2);
		expect(counted("non_null_assertions", "const v = f()!.b;")).toBe(1);
		expect(counted("non_null_assertions", "const v = a[0]!.b;")).toBe(1);
	});

	test("does not match inequality, negation, strings or comments", () => {
		expect(counted("non_null_assertions", "if (a != b) {}")).toBe(0);
		expect(counted("non_null_assertions", "if (a !== b) {}")).toBe(0);
		expect(counted("non_null_assertions", "if (!a.b) {}")).toBe(0);
		expect(counted("non_null_assertions", "const v = !y.z;")).toBe(0);
		expect(counted("non_null_assertions", "const v = !!y;")).toBe(0);
		expect(counted("non_null_assertions", 'const s = "a!.b";')).toBe(0);
		expect(counted("non_null_assertions", "// a!.b")).toBe(0);
		expect(counted("non_null_assertions", "const s = `wow!.`;")).toBe(0);
	});
});

describe("empty_catch", () => {
	test("matches a catch with no comment and no statement", () => {
		expect(counted("empty_catch", "try { x(); } catch {}")).toBe(1);
		expect(counted("empty_catch", "try { x(); } catch (e) {}")).toBe(1);
		expect(counted("empty_catch", "try { x(); } catch (e) { }")).toBe(1);
		expect(counted("empty_catch", "try {\n\tx();\n} catch (e: unknown) {\n\t\n}")).toBe(1);
	});

	test("does not match a commented or non-empty catch", () => {
		expect(counted("empty_catch", "try { x(); } catch { /* why */ }")).toBe(0);
		expect(counted("empty_catch", "try { x(); } catch {\n\t// why\n}")).toBe(0);
		expect(counted("empty_catch", "try { x(); } catch (e) { log(e); }")).toBe(0);
		expect(counted("empty_catch", "try { x(); } catch { return; }")).toBe(0);
		expect(counted("empty_catch", 'const s = "catch {}";')).toBe(0);
		expect(counted("empty_catch", "const s = `try { x(); } catch {}`;")).toBe(0);
	});
});

describe("console_calls", () => {
	test("counts the five console methods in a package src file", () => {
		expect(counted("console_calls", "console.log(1);")).toBe(1);
		expect(counted("console_calls", "console.error(1); console.warn(1); console.info(1); console.debug(1);")).toBe(4);
	});

	test("ignores other methods, comments, strings and files outside packages/*/src", () => {
		expect(counted("console_calls", "console.table(1);")).toBe(0);
		expect(counted("console_calls", "// console.log(1)")).toBe(0);
		expect(counted("console_calls", 'const s = "console.log(1)";')).toBe(0);
		expect(counted("console_calls", "console.log(1);", "scripts/tool.ts")).toBe(0);
		expect(counted("console_calls", "console.log(1);", "packages/demo/omp/tool.ts")).toBe(0);
	});
});

describe("process_exit_non_entrypoint", () => {
	const exit = "process.exit(1);";

	test("counts an exit in library code", () => {
		expect(counted("process_exit_non_entrypoint", exit)).toBe(1);
		expect(counted("process_exit_non_entrypoint", `${exit} ${exit}`)).toBe(2);
	});

	test("every entrypoint form is exempt", () => {
		expect(counted("process_exit_non_entrypoint", `#!/usr/bin/env bun\n${exit}`)).toBe(0);
		expect(counted("process_exit_non_entrypoint", `if (import.meta.main) ${exit}`)).toBe(0);
		expect(counted("process_exit_non_entrypoint", `// ratchet-entrypoint: reason\n${exit}`)).toBe(0);
		expect(counted("process_exit_non_entrypoint", exit, "packages/demo/src/thing-run.ts")).toBe(0);
		expect(counted("process_exit_non_entrypoint", exit, "packages/demo/src/index.ts")).toBe(0);
		expect(counted("process_exit_non_entrypoint", exit, "packages/demo/src/main.ts")).toBe(0);
		expect(counted("process_exit_non_entrypoint", exit, "scripts/tool.ts")).toBe(0);
	});

	test("a marker or import.meta.main that is not a real comment or code does not exempt the file", () => {
		expect(counted("process_exit_non_entrypoint", `const s = \`\n// ratchet-entrypoint\n\`;\n${exit}`)).toBe(1);
		expect(counted("process_exit_non_entrypoint", `const s = "import.meta.main";\n${exit}`)).toBe(1);
		expect(counted("process_exit_non_entrypoint", `/* ratchet-entrypoint */\n${exit}`)).toBe(1);
		expect(counted("process_exit_non_entrypoint", `x = 1; // ratchet-entrypoint\n${exit}`)).toBe(1);
	});

	test("ignores exitCode, comments and strings", () => {
		expect(counted("process_exit_non_entrypoint", "process.exitCode = 1;")).toBe(0);
		expect(counted("process_exit_non_entrypoint", "// process.exit(1)")).toBe(0);
		expect(counted("process_exit_non_entrypoint", 'const s = "process.exit(1)";')).toBe(0);
		expect(counted("process_exit_non_entrypoint", "const s = `a.then(() => process.exit(0))`;")).toBe(0);
	});
});

describe("json_parse_casts", () => {
	test("matches a cast to a named or inline object type", () => {
		expect(counted("json_parse_casts", "const a = JSON.parse(text) as Foo;")).toBe(1);
		expect(counted("json_parse_casts", "const a = JSON.parse(text) as { a: number };")).toBe(1);
		expect(counted("json_parse_casts", 'const a = JSON.parse(readFileSync(p, "utf8")) as Foo;')).toBe(1);
	});

	test("does not match unknown, const, annotations, comments or strings", () => {
		expect(counted("json_parse_casts", "const a = JSON.parse(text) as unknown;")).toBe(0);
		expect(counted("json_parse_casts", "const a: unknown = JSON.parse(text);")).toBe(0);
		expect(counted("json_parse_casts", "const a = JSON.parse(text) as const;")).toBe(0);
		expect(counted("json_parse_casts", "// JSON.parse(text) as Foo")).toBe(0);
		expect(counted("json_parse_casts", 'const s = "JSON.parse(text) as Foo";')).toBe(0);
	});
});

describe("scan", () => {
	const directories: string[] = [];

	afterEach(() => {
		while (directories.length > 0) {
			const directory = directories.pop();
			if (directory) rmSync(directory, { recursive: true, force: true });
		}
	});

	function fixture(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "substrate-code-ratchet-"));
		directories.push(root);
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
		}
		return root;
	}

	test("separates source from test files and skips node_modules, dist and non-ts files", () => {
		const root = fixture({
			"packages/demo/src/a.ts": "const a: any = 1;\nconsole.log(a);\n",
			"packages/demo/src/a.test.ts": "const a: any = 1;\nconst b: any = 2;\n",
			"packages/demo/node_modules/dep/index.ts": "const a: any = 1;\n",
			"packages/demo/dist/out.ts": "const a: any = 1;\n",
			"packages/demo/src/notes.md": "const a: any = 1;\n",
			"scripts/tool.ts": "const a = b as unknown as C;\nprocess.exit(1);\n",
			"elsewhere/x.ts": "const a: any = 1;\n",
		});
		const counters = scan(root);
		expect(counters.source.explicit_any).toBe(1);
		expect(counters.source.console_calls).toBe(1);
		expect(counters.source.as_unknown_as).toBe(1);
		expect(counters.source.process_exit_non_entrypoint).toBe(0);
		expect(counters.test.explicit_any).toBe(2);
		expect(counters.test.console_calls).toBe(0);
	});

	test("an absent scripts directory is not an error", () => {
		const root = fixture({ "packages/demo/src/a.ts": "const a = 1;\n" });
		expect(scan(root).source).toEqual(emptyCounterSet());
	});
});

describe("compare", () => {
	function sourceWith(overrides: Partial<CounterSet>): CounterSet {
		return { ...emptyCounterSet(), ...overrides };
	}

	test("equal counters are clean", () => {
		const baseline = sourceWith({ explicit_any: 3 });
		expect(compare(sourceWith({ explicit_any: 3 }), baseline)).toEqual({ over: [], under: [], missing: [] });
	});

	test("a counter above its baseline is a regression", () => {
		const result = compare(sourceWith({ empty_catch: 2 }), sourceWith({ empty_catch: 1 }));
		expect(result.over).toEqual(["ratchet: empty_catch rose from 1 to 2"]);
		expect(result.under).toEqual([]);
	});

	test("a counter strictly below its baseline demands a lower baseline", () => {
		const result = compare(sourceWith({ explicit_any: 2 }), sourceWith({ explicit_any: 3 }));
		expect(result.over).toEqual([]);
		expect(result.under).toHaveLength(1);
		expect(result.under[0]).toContain(LOWER_BASELINE_MESSAGE);
		expect(result.under[0]).toContain("ratchet: lower the baseline in scripts/code-ratchet.baseline.json");
		expect(result.under[0]).toContain("explicit_any");
	});

	test("a counter missing from the baseline is reported", () => {
		const baseline: BaselineCounters = { ...emptyCounterSet() };
		delete baseline.json_parse_casts;
		const result = compare(emptyCounterSet(), baseline);
		expect(result.missing).toHaveLength(1);
		expect(result.missing[0]).toContain("json_parse_casts");
	});
});

describe("baseline file", () => {
	test("serializeBaseline round-trips through loadBaseline", () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-code-ratchet-"));
		try {
			const counters = { source: { ...emptyCounterSet(), explicit_any: 4 }, test: { ...emptyCounterSet(), as_unknown_as: 7 } };
			const path = join(root, "baseline.json");
			writeFileSync(path, serializeBaseline(counters));
			const loaded = loadBaseline(path);
			expect(loaded.source).toEqual(counters.source);
			expect(loaded.test).toEqual(counters.test);
			expect(loaded._generated_by).toBe("bun scripts/code-ratchet.ts --write");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("repository ratchet", () => {
	let cached: { comparison: Comparison; baseline: Baseline } | undefined;

	function repositoryComparison(): { comparison: Comparison; baseline: Baseline } {
		if (cached === undefined) {
			const baseline = loadBaseline();
			cached = { baseline, comparison: compare(scan(join(import.meta.dir, "..")).source, baseline.source) };
		}
		return cached;
	}

	test("the baseline names every counter", () => {
		const { baseline } = repositoryComparison();
		for (const name of COUNTER_NAMES) expect(typeof baseline.source[name]).toBe("number");
	}, 30_000);

	test("no source counter exceeds its baseline", () => {
		const { comparison } = repositoryComparison();
		expect(comparison.missing).toEqual([]);
		expect(comparison.over).toEqual([]);
	}, 30_000);

	test("the ratchet is tight: no source counter sits below its baseline", () => {
		const { comparison } = repositoryComparison();
		expect(comparison.under).toEqual([]);
	}, 30_000);
});
