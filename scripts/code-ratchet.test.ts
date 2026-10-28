import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	formatTable,
	isEntrypoint,
	LOWER_BASELINE_MESSAGE,
	listFiles,
	loadBaseline,
	main,
	raisedCounters,
	scan,
	serializeBaseline,
	writeBaseline,
} from "./code-ratchet.ts";

const SOURCE_PATH = "packages/demo/src/lib.ts";

function counted(name: CounterName, text: string, path: string = SOURCE_PATH): number {
	return countFile(path, text)[name];
}

function lines(...parts: string[]): string {
	return parts.join("\n");
}

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

describe("explicit_any", () => {
	test("counts every explicit any type once", () => {
		expect(counted("explicit_any", "const a: any = 1;")).toBe(1);
		expect(counted("explicit_any", "const a = b as any;")).toBe(1);
		expect(counted("explicit_any", "const a = <any>b;")).toBe(1);
		expect(counted("explicit_any", "let a: any[] = [];")).toBe(1);
		expect(counted("explicit_any", "let a = c as any[];")).toBe(1);
		expect(counted("explicit_any", "let a: Record<string, any> = {};")).toBe(1);
		expect(counted("explicit_any", "let a: Promise<any>;")).toBe(1);
	});

	test("counts aliases, unions and padded generics", () => {
		expect(counted("explicit_any", "type Result = any;")).toBe(1);
		expect(counted("explicit_any", "type Value = string | any;")).toBe(1);
		expect(counted("explicit_any", "let a: Promise< any >;")).toBe(1);
		expect(counted("explicit_any", "function f(a: any, b: any): any {}")).toBe(3);
	});

	test("a division after a postfix operator does not hide a cast", () => {
		expect(counted("explicit_any", "const x = n++ / (value as any) / 2;")).toBe(1);
	});

	test("a regex literal after a statement head is not code", () => {
		expect(counted("explicit_any", "if (ready) /: any/.test(text);")).toBe(0);
		expect(counted("explicit_any", "const re = /: any/;")).toBe(0);
		expect(counted("explicit_any", lines("const re = /[\"']/g;", "const v: any = 1;"))).toBe(1);
	});

	test("a division is not a regex literal", () => {
		expect(counted("explicit_any", lines("const h = a / b;", "const v: any = c / d;"))).toBe(1);
	});

	test("code in a template expression counts, template text does not", () => {
		expect(counted("explicit_any", "const a = `x: any ${b as any} y as any`;")).toBe(1);
		expect(counted("explicit_any", "const a = `a ${`b: any`} c`;")).toBe(0);
		expect(counted("explicit_any", "const a = `a ${{ k: 1 }.k as any} c`;")).toBe(1);
	});

	test("an apostrophe in a comment, an escaped quote and a shebang do not confuse it", () => {
		expect(counted("explicit_any", lines("// don't", "const v: any = 1;"))).toBe(1);
		expect(counted("explicit_any", 'const s = "a\\"b: any";')).toBe(0);
		expect(counted("explicit_any", lines("#!/usr/bin/env bun", "const v: any = 1;"))).toBe(1);
	});

	test("does not count look-alikes, strings or comments", () => {
		expect(counted("explicit_any", "const many = 1; const company: string = 'x';")).toBe(0);
		expect(counted("explicit_any", "const a: anything = 1;")).toBe(0);
		expect(counted("explicit_any", "const a = z.any(); const b = x.any;")).toBe(0);
		expect(counted("explicit_any", "const a = { anyOf: 1 };")).toBe(0);
		expect(counted("explicit_any", "// const a: any = 1;")).toBe(0);
		expect(counted("explicit_any", "/* b as any */ const a = 1;")).toBe(0);
		expect(counted("explicit_any", 'const s = "as any";')).toBe(0);
	});
});

describe("as_unknown_as", () => {
	test("counts a double cast", () => {
		expect(counted("as_unknown_as", "const a = b as unknown as Foo;")).toBe(1);
		expect(counted("as_unknown_as", "const a = b as unknown as Foo; const c = d as unknown as Bar;")).toBe(2);
		expect(counted("as_unknown_as", "const a = (b as unknown) as Foo;")).toBe(1);
	});

	test("does not count a single cast, a comment or a string", () => {
		expect(counted("as_unknown_as", "const a = b as unknown;")).toBe(0);
		expect(counted("as_unknown_as", "const a = b as Foo as Bar;")).toBe(0);
		expect(counted("as_unknown_as", "// b as unknown as Foo")).toBe(0);
		expect(counted("as_unknown_as", 'const s = "b as unknown as Foo";')).toBe(0);
	});
});

describe("ts_suppressions", () => {
	test("counts the three TypeScript suppression comments", () => {
		expect(counted("ts_suppressions", "// @ts-ignore\nconst a = 1;")).toBe(1);
		expect(counted("ts_suppressions", "// @ts-expect-error: reason\nconst a = 1;")).toBe(1);
		expect(counted("ts_suppressions", "/* @ts-nocheck */")).toBe(1);
		expect(counted("ts_suppressions", "const a = 1; // @ts-ignore")).toBe(1);
		expect(counted("ts_suppressions", "const a = 1;\n// @ts-ignore\nconst b = 2;")).toBe(1);
		expect(counted("ts_suppressions", "const a = f(/* @ts-ignore */ 1);")).toBe(1);
		expect(counted("ts_suppressions", "if (a) {\n\t// @ts-expect-error: later\n}")).toBe(1);
	});

	test("every comment is counted exactly once", () => {
		expect(counted("ts_suppressions", "// @ts-ignore\n// @ts-ignore\nconst a = 1;\n/* @ts-nocheck */")).toBe(3);
	});

	test("does not count strings, templates, regexes or ordinary comments", () => {
		expect(counted("ts_suppressions", 'const s = "@ts-ignore";')).toBe(0);
		expect(counted("ts_suppressions", "const s = `// @ts-ignore`;")).toBe(0);
		expect(counted("ts_suppressions", "const r = /@ts-ignore/;")).toBe(0);
		expect(counted("ts_suppressions", "// ts-ignore without the at sign")).toBe(0);
	});
});

describe("lint_suppressions", () => {
	test("counts biome and eslint suppression comments", () => {
		expect(counted("lint_suppressions", "// biome-ignore lint/suspicious/noExplicitAny: reason\nconst a = 1;")).toBe(1);
		expect(counted("lint_suppressions", "// eslint-disable-next-line no-console\nconst a = 1;")).toBe(1);
		expect(counted("lint_suppressions", "/* eslint-disable */")).toBe(1);
	});

	test("does not count strings or templates", () => {
		expect(counted("lint_suppressions", 'const s = "biome-ignore";')).toBe(0);
		expect(counted("lint_suppressions", "const s = `// eslint-disable`;")).toBe(0);
	});
});

describe("non_null_assertions", () => {
	test("counts every postfix assertion", () => {
		expect(counted("non_null_assertions", "const v = a!.b;")).toBe(1);
		expect(counted("non_null_assertions", "const v = a!;")).toBe(1);
		expect(counted("non_null_assertions", "f(a!);")).toBe(1);
		expect(counted("non_null_assertions", "f(a!, b);")).toBe(1);
		expect(counted("non_null_assertions", "const v = a![0];")).toBe(1);
		expect(counted("non_null_assertions", "const v = a!.b!.c;")).toBe(2);
		expect(counted("non_null_assertions", "const v = f()!.b;")).toBe(1);
		expect(counted("non_null_assertions", "const v = a[0]!.b;")).toBe(1);
	});

	test("counts a called assertion and one that ends a line", () => {
		expect(counted("non_null_assertions", "callback!();")).toBe(1);
		expect(counted("non_null_assertions", "const v = x!\nconst w = 1;")).toBe(1);
		expect(counted("non_null_assertions", "const v = x!")).toBe(1);
	});

	test("does not count inequality, negation, strings or comments", () => {
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
	test("counts a catch with no comment and no statement", () => {
		expect(counted("empty_catch", "try { x(); } catch {}")).toBe(1);
		expect(counted("empty_catch", "try { x(); } catch (e) {}")).toBe(1);
		expect(counted("empty_catch", "try { x(); } catch (e) { }")).toBe(1);
		expect(counted("empty_catch", "try {\n\tx();\n} catch (e: unknown) {\n\t\n}")).toBe(1);
	});

	test("a commented or non-empty catch is accepted", () => {
		expect(counted("empty_catch", "try { x(); } catch { /* why */ }")).toBe(0);
		expect(counted("empty_catch", "try { x(); } catch {\n\t// why\n}")).toBe(0);
		expect(counted("empty_catch", "try { x(); } catch (e) { log(e); }")).toBe(0);
		expect(counted("empty_catch", "try { x(); } catch { return; }")).toBe(0);
	});

	test("comment text, strings and templates never count", () => {
		expect(counted("empty_catch", "// Example: try { work(); } catch {}\nconst a = 1;")).toBe(0);
		expect(counted("empty_catch", "/* try { work(); } catch {} */ const a = 1;")).toBe(0);
		expect(counted("empty_catch", 'const s = "catch {}";')).toBe(0);
		expect(counted("empty_catch", "const s = `try { x(); } catch {}`;")).toBe(0);
	});

	test("a real empty catch still counts next to a comment example", () => {
		expect(counted("empty_catch", lines("// Example: try { work(); } catch {}", "try { x(); } catch {}"))).toBe(1);
	});
});

describe("console_calls", () => {
	test("counts the five console methods in a package src file", () => {
		expect(counted("console_calls", "console.log(1);")).toBe(1);
		expect(counted("console_calls", "console.error(1); console.warn(1); console.info(1); console.debug(1);")).toBe(4);
		expect(counted("console_calls", "console.log(1);", "packages/demo/pkg/src/deep/x.ts")).toBe(1);
	});

	test("ignores other methods, comments, strings and files outside packages/*/src", () => {
		expect(counted("console_calls", "console.table(1);")).toBe(0);
		expect(counted("console_calls", "// console.log(1)")).toBe(0);
		expect(counted("console_calls", 'const s = "console.log(1)";')).toBe(0);
		expect(counted("console_calls", "const s = `console.log(1)`;")).toBe(0);
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

	test("ignores exitCode, comments, strings and template text", () => {
		expect(counted("process_exit_non_entrypoint", "process.exitCode = 1;")).toBe(0);
		expect(counted("process_exit_non_entrypoint", "// process.exit(1)")).toBe(0);
		expect(counted("process_exit_non_entrypoint", 'const s = "process.exit(1)";')).toBe(0);
		expect(counted("process_exit_non_entrypoint", "const s = `a.then(() => process.exit(0))`;")).toBe(0);
	});

	test("a call inside a template expression is a call", () => {
		expect(counted("process_exit_non_entrypoint", "const s = `${process.exit(1)}`;")).toBe(1);
	});

	test("isEntrypoint reports the same facts", () => {
		expect(isEntrypoint("packages/demo/src/lib.ts", "const a = 1;")).toBe(false);
		expect(isEntrypoint("packages/demo/src/lib.ts", "if (import.meta.main) run();")).toBe(true);
		expect(isEntrypoint("packages/demo/src/lib.ts", "#!/usr/bin/env bun\nrun();")).toBe(true);
		expect(isEntrypoint("scripts/tool.ts", "run();")).toBe(true);
	});
});

describe("json_parse_casts", () => {
	test("counts a cast to any named, inline, lowercase or primitive type", () => {
		expect(counted("json_parse_casts", "const a = JSON.parse(text) as Foo;")).toBe(1);
		expect(counted("json_parse_casts", "const a = JSON.parse(text) as { a: number };")).toBe(1);
		expect(counted("json_parse_casts", 'const a = JSON.parse(readFileSync(p, "utf8")) as Foo;')).toBe(1);
		expect(counted("json_parse_casts", "const a = JSON.parse(bucket) as string[];")).toBe(1);
		expect(counted("json_parse_casts", "const a = JSON.parse(bucket) as string;")).toBe(1);
		expect(counted("json_parse_casts", "const a = JSON.parse(bucket) as Record<string, number>;")).toBe(1);
		expect(counted("json_parse_casts", "const a = (JSON.parse(text)) as Foo;")).toBe(1);
	});

	test("does not count unknown, const, annotations, comments or strings", () => {
		expect(counted("json_parse_casts", "const a = JSON.parse(text) as unknown;")).toBe(0);
		expect(counted("json_parse_casts", "const a: unknown = JSON.parse(text);")).toBe(0);
		expect(counted("json_parse_casts", "const a = JSON.parse(text) as const;")).toBe(0);
		expect(counted("json_parse_casts", "const a = JSON.parse(text) as unknown as Foo;")).toBe(0);
		expect(counted("json_parse_casts", "const a = other.parse(text) as Foo;")).toBe(0);
		expect(counted("json_parse_casts", "// JSON.parse(text) as Foo")).toBe(0);
		expect(counted("json_parse_casts", 'const s = "JSON.parse(text) as Foo";')).toBe(0);
	});
});

describe("pre-check and comment collection", () => {
	test("a file with no counter substring counts zero", () => {
		expect(countFile(SOURCE_PATH, "const a = 1;\nexport { a };\n")).toEqual(emptyCounterSet());
	});

	test("a file whose only matches are inside a comment is parsed and counts zero", () => {
		const text = lines("// any ! as unknown as X JSON.parse(x) console.log(y) process.exit(1) catch (e) {}", "const a = 1;");
		expect(countFile(SOURCE_PATH, text)).toEqual(emptyCounterSet());
	});

	test("a file whose only matches are in strings counts zero", () => {
		const text = 'const s = "any ! as unknown as X JSON.parse(x) console.log(y) process.exit(1)";\n';
		expect(countFile(SOURCE_PATH, text)).toEqual(emptyCounterSet());
	});

	test("suppression comments between nodes and at the end of the file are all counted once", () => {
		const text = lines("// @ts-ignore", "const a = 1; // biome-ignore lint: reason", "function f() {", "\t// @ts-expect-error", "\treturn 1;", "}", "/* eslint-disable */");
		const counters = countFile(SOURCE_PATH, text);
		expect(counters.ts_suppressions).toBe(2);
		expect(counters.lint_suppressions).toBe(2);
	});
});

describe("scan", () => {
	const files = {
		"packages/demo/src/a.ts": "const a: any = 1;\nconsole.log(a);\n",
		"packages/demo/src/a.test.ts": "const a: any = 1;\nconst b: any = 2;\n",
		"packages/demo/node_modules/dep/index.ts": "const a: any = 1;\n",
		"packages/demo/dist/out.ts": "const a: any = 1;\n",
		"packages/demo/src/notes.md": "const a: any = 1;\n",
		"scripts/tool.ts": "const a = b as unknown as C;\nprocess.exit(1);\n",
		"elsewhere/x.ts": "const a: any = 1;\n",
	};

	test("skips test files, node_modules, dist and non-ts files by default", () => {
		const counters = scan(fixture(files));
		expect(counters.source.explicit_any).toBe(1);
		expect(counters.source.console_calls).toBe(1);
		expect(counters.source.as_unknown_as).toBe(1);
		expect(counters.source.process_exit_non_entrypoint).toBe(0);
		expect(counters.test).toBeUndefined();
	});

	test("includeTests adds the informational test counters without changing the source counters", () => {
		const root = fixture(files);
		const counters = scan(root, { includeTests: true });
		expect(counters.source).toEqual(scan(root).source);
		expect(counters.test?.explicit_any).toBe(2);
		expect(counters.test?.console_calls).toBe(0);
	});

	test("the table has a test column only when test counters were scanned", () => {
		const root = fixture(files);
		expect(formatTable(scan(root), undefined).split("\n")[0]).not.toContain("test");
		expect(formatTable(scan(root, { includeTests: true }), undefined).split("\n")[0]).toContain("test");
	});

	test("the CLI prints test counters only with --with-tests", () => {
		const root = fixture(files);
		const baselinePath = join(fixture({}), "baseline.json");
		const output: string[] = [];
		const options = { root, baselinePath, out: (text: string) => output.push(text), err: () => undefined };
		expect(main(["--write"], options)).toBe(0);
		output.length = 0;
		expect(main([], options)).toBe(0);
		expect(output.join("").split("\n")[0]).not.toContain("test");
		output.length = 0;
		expect(main(["--with-tests"], options)).toBe(0);
		expect(output.join("").split("\n")[0]).toContain("test");
	});

	test("an absent scripts directory is not an error", () => {
		const root = fixture({ "packages/demo/src/a.ts": "const a = 1;\n" });
		expect(scan(root).source).toEqual(emptyCounterSet());
	});

	test("a scanned root that cannot be read as a directory is an error, never a silent skip", () => {
		const root = fixture({ packages: "not a directory", "scripts/tool.ts": "const a = 1;\n" });
		expect(() => listFiles(root)).toThrow(/packages/);
		expect(() => scan(root)).toThrow(/packages/);
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
	test("serializeBaseline round-trips through loadBaseline and has no test section", () => {
		const root = fixture({});
		const counters = { source: { ...emptyCounterSet(), explicit_any: 4 }, test: { ...emptyCounterSet(), as_unknown_as: 7 } };
		const path = join(root, "baseline.json");
		writeFileSync(path, serializeBaseline(counters));
		const loaded = loadBaseline(path);
		expect(loaded.source).toEqual(counters.source);
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort()).toEqual(["_generated_by", "source"]);
		expect(loaded._generated_by).toBe("bun scripts/code-ratchet.ts --write");
	});
});

describe("--write refuses to raise a baseline", () => {
	function countersWith(source: Partial<CounterSet>): { source: CounterSet } {
		return { source: { ...emptyCounterSet(), ...source } };
	}

	test("raisedCounters names only counters above their baseline value", () => {
		const offenders = raisedCounters({ ...emptyCounterSet(), explicit_any: 3, empty_catch: 1 }, { explicit_any: 1, empty_catch: 1 });
		expect(offenders).toEqual(["explicit_any: baseline 1 -> now 3"]);
		expect(raisedCounters({ ...emptyCounterSet(), explicit_any: 9 }, {})).toEqual([]);
	});

	test("writeBaseline creates a missing file, lowers freely and refuses to raise", () => {
		const path = join(fixture({}), "baseline.json");
		expect(writeBaseline(path, countersWith({ explicit_any: 2 })).written).toBe(true);
		expect(loadBaseline(path).source.explicit_any).toBe(2);

		expect(writeBaseline(path, countersWith({ explicit_any: 1 })).written).toBe(true);
		expect(loadBaseline(path).source.explicit_any).toBe(1);

		const before = readFileSync(path, "utf8");
		const refused = writeBaseline(path, countersWith({ explicit_any: 2 }));
		expect(refused).toEqual({ written: false, offenders: ["explicit_any: baseline 1 -> now 2"] });
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("the CLI exits 1, names the counter and leaves the file untouched when a counter rose", () => {
		const root = fixture({ "packages/demo/src/a.ts": "const a: any = 1;\n" });
		const baselinePath = join(fixture({}), "baseline.json");
		const output: string[] = [];
		const errors: string[] = [];
		const options = { root, baselinePath, out: (text: string) => output.push(text), err: (text: string) => errors.push(text) };

		expect(main(["--write"], options)).toBe(0);
		expect(loadBaseline(baselinePath).source.explicit_any).toBe(1);
		const generated = readFileSync(baselinePath, "utf8");

		writeFileSync(join(root, "packages/demo/src/a.ts"), "const a: any = 1;\nconst b: any = 2;\n");
		expect(main(["--write"], options)).toBe(1);
		expect(errors.join("")).toContain("explicit_any: baseline 1 -> now 2");
		expect(readFileSync(baselinePath, "utf8")).toBe(generated);
		expect(main(["--check"], options)).toBe(1);

		writeFileSync(join(root, "packages/demo/src/a.ts"), "const a = 1;\n");
		expect(main(["--write"], options)).toBe(0);
		expect(loadBaseline(baselinePath).source.explicit_any).toBe(0);
		expect(main(["--check"], options)).toBe(0);
	});

	test("an unknown argument is refused", () => {
		const errors: string[] = [];
		expect(main(["--force-raise"], { root: fixture({}), baselinePath: join(fixture({}), "baseline.json"), err: (text) => errors.push(text) })).toBe(2);
		expect(errors.join("")).toContain("--force-raise");
	});
});

describe("repository ratchet", () => {
	let cached: { comparison: Comparison; baseline: Baseline } | undefined;

	// One default (source-only) scan shared by the three tests below.
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
	}, 120_000);

	test("no source counter exceeds its baseline", () => {
		const { comparison } = repositoryComparison();
		expect(comparison.missing).toEqual([]);
		expect(comparison.over).toEqual([]);
	});

	test("the ratchet is tight: no source counter sits below its baseline", () => {
		const { comparison } = repositoryComparison();
		expect(comparison.under).toEqual([]);
	});
});
