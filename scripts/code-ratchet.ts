#!/usr/bin/env bun
/**
 * Code-quality ratchet: counts a fixed set of risky patterns in the TypeScript
 * sources and refuses to let any SOURCE counter grow past the committed
 * baseline (scripts/code-ratchet.baseline.json). `bun test` enforces it via
 * scripts/code-ratchet.test.ts, in both directions: a counter above its
 * baseline is a regression, and a counter below it means the baseline must be
 * lowered, so the numbers can only move down.
 *
 *   bun scripts/code-ratchet.ts          print the counters next to the baseline
 *   bun scripts/code-ratchet.ts --check  exit 1 when a source counter exceeds its baseline
 *   bun scripts/code-ratchet.ts --write  rewrite the baseline from the current counters
 *
 * Source = every non-`*.test.ts` file under packages/** and scripts/**.
 * Test = every `*.test.ts` file there. Test counters are reported and stored
 * for information; only source counters gate.
 *
 * Counters (matches inside string literals, template text, regex literals and
 * comments are ignored, except the suppression counters, which live in comments):
 *   explicit_any                 `: any`, `as any`, `<any>`, `any[]`, `Record<string, any>`
 *   as_unknown_as                double casts through unknown
 *   ts_suppressions              the three TypeScript suppression comments (ignore, expect-error, nocheck)
 *   lint_suppressions            biome and eslint suppression comments
 *   non_null_assertions          `x!.y`, `x!;`, `x!)`, `x!,`, `x![i]` (`!=` and `!==` never match)
 *   empty_catch                  an empty catch block (no comment and no statement inside the braces)
 *   console_calls                console.log/error/warn/info/debug in packages/<pkg>/src
 *   process_exit_non_entrypoint  process.exit( in a file that is not a CLI entrypoint
 *   json_parse_casts             `JSON.parse(...) as <Type>` (one level of nested parentheses allowed)
 *
 * A CLI entrypoint is a file that has a shebang, uses import.meta.main,
 * carries a line comment consisting of the word ratchet-entrypoint (put it
 * above the guard that makes the file run), is named `*-run.ts`, `index.ts`
 * or `main.ts`, or lives under scripts/. Such files may call process.exit.
 *
 * Deterministic: sorted walk, no network, node_modules, dist and .git skipped.
 */
import { type Dirent, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";

export const COUNTER_NAMES = [
	"explicit_any",
	"as_unknown_as",
	"ts_suppressions",
	"lint_suppressions",
	"non_null_assertions",
	"empty_catch",
	"console_calls",
	"process_exit_non_entrypoint",
	"json_parse_casts",
] as const;

export type CounterName = (typeof COUNTER_NAMES)[number];
export type CounterSet = Record<CounterName, number>;
export type Counters = { source: CounterSet; test: CounterSet };
export type BaselineCounters = Partial<Record<CounterName, number>>;
export type Baseline = { _generated_by: string; source: BaselineCounters; test: BaselineCounters };

export const BASELINE_COMMAND = "bun scripts/code-ratchet.ts --write";
export const BASELINE_PATH = join(import.meta.dir, "code-ratchet.baseline.json");
export const LOWER_BASELINE_MESSAGE = "ratchet: lower the baseline in scripts/code-ratchet.baseline.json";

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);
const SCANNED_ROOTS = ["packages", "scripts"];

const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const SLASH = 47;
const STAR = 42;
const BACKSLASH = 92;
const BACKTICK = 96;
const SINGLE_QUOTE = 39;
const DOUBLE_QUOTE = 34;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "throw", "else", "do", "in", "of", "void", "delete", "await", "yield", "new"]);

function isIdentifierCode(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36 || code > 127;
}

function isWhitespaceCode(code: number): boolean {
	return code === 32 || code === 9 || code === NEWLINE || code === CARRIAGE_RETURN;
}

export type MaskedSource = {
	/** Strings, template text, regex literals and comments blanked. */
	code: string;
	/** Strings, template text and regex literals blanked; comments kept. */
	commented: string;
};

/**
 * Blank every non-code region with spaces, keeping newlines and all offsets, so
 * line structure survives and matchers cannot fire on text that is not code.
 */
export function maskSource(text: string): MaskedSource {
	const length = text.length;
	const code = new Uint16Array(length);
	const commented = new Uint16Array(length);
	for (let index = 0; index < length; index += 1) {
		const unit = text.charCodeAt(index);
		code[index] = unit;
		commented[index] = unit;
	}
	const blank = (target: Uint16Array, from: number, to: number): void => {
		for (let index = from; index < to; index += 1) {
			const unit = text.charCodeAt(index);
			target[index] = unit === NEWLINE || unit === CARRIAGE_RETURN ? unit : 32;
		}
	};
	const blankBoth = (from: number, to: number): void => {
		blank(code, from, to);
		blank(commented, from, to);
	};

	/** End index (exclusive of the closing quote) of a quoted string starting at `start`. */
	const stringEnd = (start: number, quote: number): number => {
		let index = start + 1;
		while (index < length) {
			const unit = text.charCodeAt(index);
			if (unit === BACKSLASH) index += 2;
			else if (unit === quote || unit === NEWLINE) return index;
			else index += 1;
		}
		return length;
	};

	/** Index of the closing slash of a regex literal opening at `start`, or -1 when it is not one. */
	const regexEnd = (start: number): number => {
		let inClass = false;
		let index = start + 1;
		while (index < length) {
			const unit = text.charCodeAt(index);
			if (unit === NEWLINE) return -1;
			if (unit === BACKSLASH) {
				index += 2;
				continue;
			}
			if (unit === 91) inClass = true;
			else if (unit === 93) inClass = false;
			else if (unit === SLASH && !inClass) return index;
			index += 1;
		}
		return -1;
	};

	// Brace depth inside each open `${ ... }` template expression, innermost last.
	const expressions: number[] = [];

	/** Blank template text from `from`; returns the index to resume code scanning at. */
	const templateBody = (from: number): number => {
		let index = from;
		while (index < length) {
			const unit = text.charCodeAt(index);
			if (unit === BACKSLASH) {
				index += 2;
				continue;
			}
			if (unit === BACKTICK) {
				blankBoth(from, index);
				return index + 1;
			}
			if (unit === 36 && text.charCodeAt(index + 1) === OPEN_BRACE) {
				blankBoth(from, index);
				expressions.push(0);
				return index + 2;
			}
			index += 1;
		}
		blankBoth(from, length);
		return length;
	};

	let index = 0;
	let previous = "";
	let previousWord = "";
	if (text.startsWith("#!")) {
		const end = text.indexOf("\n");
		index = end < 0 ? length : end;
		blankBoth(0, index);
	}
	while (index < length) {
		const unit = text.charCodeAt(index);
		if (unit === SLASH) {
			const next = text.charCodeAt(index + 1);
			if (next === SLASH) {
				const end = text.indexOf("\n", index);
				const stop = end < 0 ? length : end;
				blank(code, index, stop);
				index = stop;
				continue;
			}
			if (next === STAR) {
				const end = text.indexOf("*/", index + 2);
				const stop = end < 0 ? length : end + 2;
				blank(code, index, stop);
				index = stop;
				continue;
			}
			if (previous === "" || REGEX_PRECEDERS.includes(previous) || (previous === "a" && REGEX_KEYWORDS.has(previousWord))) {
				const close = regexEnd(index);
				if (close > 0) {
					blankBoth(index + 1, close);
					index = close + 1;
					previous = "a";
					previousWord = "";
					continue;
				}
			}
			previous = "/";
			previousWord = "";
			index += 1;
			continue;
		}
		if (unit === SINGLE_QUOTE || unit === DOUBLE_QUOTE) {
			const close = stringEnd(index, unit);
			blankBoth(index + 1, close);
			index = close < length && text.charCodeAt(close) === unit ? close + 1 : close;
			previous = '"';
			previousWord = "";
			continue;
		}
		if (unit === BACKTICK) {
			index = templateBody(index + 1);
			previous = '"';
			previousWord = "";
			continue;
		}
		if (unit === OPEN_BRACE) {
			if (expressions.length > 0) expressions[expressions.length - 1] = (expressions[expressions.length - 1] ?? 0) + 1;
			previous = "{";
			previousWord = "";
			index += 1;
			continue;
		}
		if (unit === CLOSE_BRACE) {
			const depth = expressions[expressions.length - 1];
			if (depth === 0) {
				expressions.pop();
				index = templateBody(index + 1);
				previous = '"';
				previousWord = "";
				continue;
			}
			if (depth !== undefined) expressions[expressions.length - 1] = depth - 1;
			previous = "}";
			previousWord = "";
			index += 1;
			continue;
		}
		if (isIdentifierCode(unit)) {
			let end = index + 1;
			while (end < length && isIdentifierCode(text.charCodeAt(end))) end += 1;
			previous = "a";
			previousWord = text.slice(index, end);
			index = end;
			continue;
		}
		if (!isWhitespaceCode(unit)) {
			previous = text[index] ?? "";
			previousWord = "";
		}
		index += 1;
	}
	const decoder = new TextDecoder("utf-16le");
	return { code: decoder.decode(code), commented: decoder.decode(commented) };
}

type RegexCounter = {
	name: CounterName;
	surface: keyof MaskedSource;
	pattern: RegExp;
};

const REGEX_COUNTERS: readonly RegexCounter[] = [
	{
		name: "explicit_any",
		surface: "code",
		pattern: /:\s*any\b|\bas\s+any\b|<any>|\bany\[\]|Record<\s*string\s*,\s*any\s*>/g,
	},
	{ name: "as_unknown_as", surface: "code", pattern: /\bas\s+unknown\s+as\b/g },
	{ name: "ts_suppressions", surface: "commented", pattern: /@ts-(?:ignore|expect-error|nocheck)\b/g },
	{ name: "lint_suppressions", surface: "commented", pattern: /\b(?:biome-ignore|eslint-disable)/g },
	{ name: "non_null_assertions", surface: "code", pattern: /[\w)\]]!(?:\.|;|\)|,|\[)/g },
	{ name: "empty_catch", surface: "commented", pattern: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g },
	{ name: "json_parse_casts", surface: "code", pattern: /JSON\.parse\((?:[^()]|\([^()]*\))*\)\s+as\s+[A-Z{]/g },
];

const CONSOLE_PATTERN = /\bconsole\.(?:log|error|warn|info|debug)\b/g;
const PROCESS_EXIT_PATTERN = /\bprocess\.exit\(/g;
const ENTRYPOINT_MARKER = /^[ \t]*\/\/[ \t]*ratchet-entrypoint\b/m;
const IMPORT_META_MAIN = /\bimport\.meta\.main\b/;
const PACKAGE_SOURCE_PATH = /^packages\/[^/]+\/(?:.+\/)?src\//;

function count(pattern: RegExp, text: string): number {
	let total = 0;
	for (const _match of text.matchAll(pattern)) total += 1;
	return total;
}

export function isTestFile(relativePath: string): boolean {
	return relativePath.endsWith(".test.ts");
}

/** True when the file is a CLI entrypoint, so it may call process.exit. */
export function isEntrypoint(relativePath: string, text: string, masked: MaskedSource = maskSource(text)): boolean {
	if (text.startsWith("#!")) return true;
	if (relativePath.startsWith("scripts/")) return true;
	const name = basename(relativePath);
	if (name.endsWith("-run.ts") || name === "index.ts" || name === "main.ts") return true;
	if (IMPORT_META_MAIN.test(masked.code)) return true;
	return ENTRYPOINT_MARKER.test(masked.commented);
}

export function emptyCounterSet(): CounterSet {
	const set = {} as CounterSet;
	for (const name of COUNTER_NAMES) set[name] = 0;
	return set;
}

/** Count every pattern in one file. `relativePath` is root-relative with `/` separators. */
export function countFile(relativePath: string, text: string): CounterSet {
	const masked = maskSource(text);
	const set = emptyCounterSet();
	for (const counter of REGEX_COUNTERS) set[counter.name] = count(counter.pattern, masked[counter.surface]);
	if (PACKAGE_SOURCE_PATH.test(relativePath)) set.console_calls = count(CONSOLE_PATTERN, masked.code);
	if (!isEntrypoint(relativePath, text, masked)) set.process_exit_non_entrypoint = count(PROCESS_EXIT_PATTERN, masked.code);
	return set;
}

function walk(directory: string, relativeDirectory: string, found: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		// A scanned root that does not exist (a checkout without scripts/) simply contributes no files.
		return;
	}
	entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
			walk(join(directory, entry.name), `${relativeDirectory}/${entry.name}`, found);
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			found.push(`${relativeDirectory}/${entry.name}`);
		}
	}
}

/** Sorted root-relative paths of every scanned `.ts` file. */
export function listFiles(root: string): string[] {
	const found: string[] = [];
	for (const scanned of SCANNED_ROOTS) walk(join(root, scanned), scanned, found);
	return found;
}

export function scan(root: string): Counters {
	const counters: Counters = { source: emptyCounterSet(), test: emptyCounterSet() };
	for (const relativePath of listFiles(root)) {
		const text = readFileSync(join(root, ...relativePath.split("/")), "utf8");
		const target = isTestFile(relativePath) ? counters.test : counters.source;
		const fileCounters = countFile(relativePath, text);
		for (const name of COUNTER_NAMES) target[name] += fileCounters[name];
	}
	return counters;
}

export type Comparison = {
	/** Counters above their baseline: regressions. */
	over: string[];
	/** Counters below their baseline: the baseline must be lowered. */
	under: string[];
	/** Counters the baseline does not list. */
	missing: string[];
};

export function compare(source: CounterSet, baseline: BaselineCounters): Comparison {
	const result: Comparison = { over: [], under: [], missing: [] };
	for (const name of COUNTER_NAMES) {
		const limit = baseline[name];
		if (typeof limit !== "number") {
			result.missing.push(`ratchet: ${name} is missing from the baseline; run ${BASELINE_COMMAND}`);
		} else if (source[name] > limit) {
			result.over.push(`ratchet: ${name} rose from ${limit} to ${source[name]}`);
		} else if (source[name] < limit) {
			result.under.push(`${LOWER_BASELINE_MESSAGE} (${name} is ${source[name]}, baseline ${limit})`);
		}
	}
	return result;
}

/** Reads one property of a parsed JSON value without asserting its shape. */
function field(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return Object.entries(value).find(([entryKey]) => entryKey === key)?.[1];
}

/** Reads the baseline file. A counter the file lacks stays absent so `compare` can report it. */
export function loadBaseline(path: string = BASELINE_PATH): Baseline {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path}: baseline must be a JSON object`);
	const read = (value: unknown): BaselineCounters => {
		const counters: BaselineCounters = {};
		for (const name of COUNTER_NAMES) {
			const entry = field(value, name);
			if (typeof entry === "number") counters[name] = entry;
		}
		return counters;
	};
	return { _generated_by: String(field(parsed, "_generated_by") ?? BASELINE_COMMAND), source: read(field(parsed, "source")), test: read(field(parsed, "test")) };
}

export function formatTable(counters: Counters, baseline: Baseline | undefined): string {
	const rows = [["counter", "source", "baseline", "test"]];
	for (const name of COUNTER_NAMES) {
		rows.push([name, String(counters.source[name]), baseline ? String(baseline.source[name] ?? "?") : "-", String(counters.test[name])]);
	}
	const widths = rows[0]?.map((_cell, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
	return rows
		.map((row) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0))).join("  "))
		.join("\n");
}

export function serializeBaseline(counters: Counters): string {
	const ordered = (set: CounterSet): CounterSet => {
		const out = emptyCounterSet();
		for (const name of COUNTER_NAMES) out[name] = set[name];
		return out;
	};
	const baseline: Baseline = { _generated_by: BASELINE_COMMAND, source: ordered(counters.source), test: ordered(counters.test) };
	return `${JSON.stringify(baseline, null, "\t")}\n`;
}

function main(argv: string[]): number {
	const root = join(import.meta.dir, "..");
	const flags = new Set(argv);
	const known = new Set(["--check", "--write"]);
	for (const flag of flags) {
		if (!known.has(flag)) {
			process.stderr.write(`unknown argument ${flag}\nusage: bun scripts/code-ratchet.ts [--check | --write]\n`);
			return 2;
		}
	}
	const counters = scan(root);
	if (flags.has("--write")) {
		writeFileSync(BASELINE_PATH, serializeBaseline(counters));
		process.stdout.write(`${formatTable(counters, undefined)}\nwrote ${BASELINE_PATH.split(sep).slice(-2).join("/")}\n`);
		return 0;
	}
	const baseline = loadBaseline();
	process.stdout.write(`${formatTable(counters, baseline)}\n`);
	const comparison = compare(counters.source, baseline.source);
	for (const line of [...comparison.under, ...comparison.over, ...comparison.missing]) process.stdout.write(`${line}\n`);
	if (flags.has("--check")) return comparison.over.length > 0 || comparison.missing.length > 0 ? 1 : 0;
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
