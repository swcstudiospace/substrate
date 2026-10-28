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
 *   bun scripts/code-ratchet.ts --with-tests  also print the informational test counters
 *
 * `--write` only ever lowers: when the baseline file exists and any source
 * counter is above its baseline value, it prints the offending counters, exits
 * 1 and leaves the file untouched. Raising a baseline means deleting the file
 * deliberately, in a reviewed change, and generating it again.
 *
 * Source = every non-`*.test.ts` file under packages/** and scripts/**.
 * Test files (`*.test.ts`) are skipped unless `--with-tests` / `scan(root, { includeTests: true })`
 * asks for them; their counters are informational, are not stored in the baseline and never gate.
 *
 * Counting is syntax-based: every file is parsed once (no parent pointers, ScriptKind.TS) with the
 * TypeScript compiler API and walked with `ts.forEachChild`, so strings, template text, regex literals
 * and comments can never be mistaken for code. Comments are not AST nodes: after the walk the whole text
 * is scanned once with `ts.createScanner` (trivia kept) and every single-line and multi-line comment token
 * is read, wherever it sits (between nodes, before `else`/`finally`/a closing `)`, inside an empty block).
 * The scanner cannot tell code from string, template and regex text on its own, so the walk records the
 * span of each such literal token and the scan jumps over it. The scan only runs when the text contains
 * a substring a comment could count for. A file whose text contains none of the substrings a counter
 * needs is not parsed (a pure optimisation). The empty-catch counter inspects the block's inner text.
 *
 *   explicit_any                 every `any` type keyword (annotations, casts, generics, aliases, unions)
 *   as_unknown_as                double casts through unknown
 *   ts_suppressions              the three TypeScript suppression comments (ignore, expect-error, nocheck)
 *   lint_suppressions            biome and eslint suppression comments
 *   non_null_assertions          every postfix `!` assertion (`x!.y`, `x!()`, `x![i]`, a trailing `x!`)
 *   empty_catch                  a catch block with no statement and no comment inside the braces
 *   console_calls                console.log/error/warn/info/debug calls in packages/<pkg>/.../src
 *   process_exit_non_entrypoint  process.exit(...) calls in a file that is not a CLI entrypoint
 *   json_parse_casts             `JSON.parse(...) as <Type>` for any type except unknown and const
 *
 * A CLI entrypoint is a file that has a shebang, uses import.meta.main,
 * carries a line comment consisting of the word ratchet-entrypoint (on its own
 * line, above the guard that makes the file run), is named `*-run.ts`,
 * `index.ts` or `main.ts`, or lives under scripts/. Such files may call
 * process.exit.
 *
 * Deterministic: sorted walk, no network, node_modules, dist and .git skipped.
 * A scanned root that does not exist is skipped; any other read error throws,
 * so an incomplete scan can never pass.
 */
import { type Dirent, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import * as ts from "typescript";

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
/** `test` is present only when the scan was asked to include test files. */
export type Counters = { source: CounterSet; test?: CounterSet | undefined };
export type BaselineCounters = Partial<Record<CounterName, number>>;
export type Baseline = { _generated_by: string; source: BaselineCounters };

export const BASELINE_COMMAND = "bun scripts/code-ratchet.ts --write";
export const BASELINE_PATH = join(import.meta.dir, "code-ratchet.baseline.json");
export const LOWER_BASELINE_MESSAGE = "ratchet: lower the baseline in scripts/code-ratchet.baseline.json";

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);
const SCANNED_ROOTS = ["packages", "scripts"];

const TS_SUPPRESSION_PATTERN = /@ts-(?:ignore|expect-error|nocheck)\b/g;
const LINT_SUPPRESSION_PATTERN = /\b(?:biome-ignore|eslint-disable)/g;
const ENTRYPOINT_MARKER = /^\/\/[ \t]*ratchet-entrypoint\b/;
const PACKAGE_SOURCE_PATH = /^packages\/[^/]+\/(?:.+\/)?src\//;
const CONSOLE_METHODS = new Set(["log", "error", "warn", "info", "debug"]);
/**
 * Cheap pre-check: text with none of these substrings cannot contribute to any counter, so it is not parsed.
 * Deliberately loose (`unknown`, `console`, `exit`, `parse` rather than the exact spellings) so whitespace
 * between `as` and `unknown`, or around a member dot, can never hide a match.
 */
const COUNTER_HINTS = ["any", "!", "unknown", "@ts-", "biome-ignore", "eslint-disable", "catch", "console", "exit", "parse"];
/** A comment can only change a counter or the entrypoint fact when it holds one of these, so the comment scan is skipped without them. */
const COMMENT_HINTS = ["@ts-", "biome-ignore", "eslint-disable", "ratchet-entrypoint"];

export function isTestFile(relativePath: string): boolean {
	return relativePath.endsWith(".test.ts");
}

export function emptyCounterSet(): CounterSet {
	const set = {} as CounterSet;
	for (const name of COUNTER_NAMES) set[name] = 0;
	return set;
}

function matchCount(pattern: RegExp, text: string): number {
	let total = 0;
	for (const _match of text.matchAll(pattern)) total += 1;
	return total;
}

function skipParentheses(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (ts.isParenthesizedExpression(current)) current = current.expression;
	return current;
}

/** True for `<object>.<property>` where the object is the plain identifier `objectName`. */
function isMemberOf(expression: ts.Expression, objectName: string, property: (name: string) => boolean): boolean {
	return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === objectName && property(expression.name.text);
}

function isConstAssertionType(type: ts.TypeNode): boolean {
	return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "const";
}

/** True when the comment starts its own line (only whitespace before it), as the entrypoint marker must. */
function startsOwnLine(text: string, position: number): boolean {
	if (position === 0) return true;
	const lineStart = text.lastIndexOf("\n", position - 1) + 1;
	return text.slice(lineStart, position).trim() === "";
}

type Analysis = { counters: CounterSet; entrypoint: boolean };

/**
 * Parse once, walk once: every counter and the entrypoint facts of one file. `relativePath` is root-relative with `/` separators.
 * The walk uses `ts.forEachChild` (AST nodes only, no token objects) and no parent pointers.
 */
function analyze(relativePath: string, text: string): Analysis {
	// JSDoc parsing is skipped: comments are read by the scanner, and no counter needs the JSDoc tree.
	const sourceFile = ts.createSourceFile(
		relativePath,
		text,
		{ languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
		false,
		ts.ScriptKind.TS,
	);
	const counters = emptyCounterSet();
	const countsConsole = PACKAGE_SOURCE_PATH.test(relativePath);
	const name = basename(relativePath);
	let entrypoint =
		text.startsWith("#!") || relativePath.startsWith("scripts/") || name.endsWith("-run.ts") || name === "index.ts" || name === "main.ts";
	let processExits = 0;
	// Start -> end of every literal token whose text may look like a comment (string, template part, regex).
	const literalEnds = new Map<number, number>();

	const readComment = (kind: ts.SyntaxKind, start: number, end: number): void => {
		const comment = text.slice(start, end);
		counters.ts_suppressions += matchCount(TS_SUPPRESSION_PATTERN, comment);
		counters.lint_suppressions += matchCount(LINT_SUPPRESSION_PATTERN, comment);
		if (kind === ts.SyntaxKind.SingleLineCommentTrivia && ENTRYPOINT_MARKER.test(comment) && startsOwnLine(text, start)) entrypoint = true;
	};

	/**
	 * One linear scan of the whole text reads every comment token, wherever it sits: between AST nodes, before a
	 * token that is not a node (`else`, `finally`, `)`, `]`, `;`), or inside an empty construct. The scanner cannot tell
	 * code from string, template and regex text, so the AST walk recorded those literal spans and the scan jumps over them.
	 */
	const readComments = (): void => {
		const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
		for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
			const start = scanner.getTokenStart();
			const literalEnd = literalEnds.get(start);
			if (literalEnd !== undefined) {
				scanner.resetTokenState(literalEnd);
				continue;
			}
			if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) readComment(token, start, scanner.getTokenEnd());
		}
	};

	const countNode = (node: ts.Node): void => {
		switch (node.kind) {
			case ts.SyntaxKind.AnyKeyword:
				counters.explicit_any += 1;
				break;
			case ts.SyntaxKind.NonNullExpression:
				counters.non_null_assertions += 1;
				break;
			case ts.SyntaxKind.CatchClause: {
				const block = (node as ts.CatchClause).block;
				if (block.statements.length === 0 && text.slice(block.getStart(sourceFile) + 1, block.end - 1).trim() === "") counters.empty_catch += 1;
				break;
			}
			case ts.SyntaxKind.AsExpression: {
				const cast = node as ts.AsExpression;
				const inner = skipParentheses(cast.expression);
				if (ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword) counters.as_unknown_as += 1;
				if (
					ts.isCallExpression(inner) &&
					isMemberOf(inner.expression, "JSON", (property) => property === "parse") &&
					cast.type.kind !== ts.SyntaxKind.UnknownKeyword &&
					!isConstAssertionType(cast.type)
				) {
					counters.json_parse_casts += 1;
				}
				break;
			}
			case ts.SyntaxKind.CallExpression: {
				const callee = (node as ts.CallExpression).expression;
				if (countsConsole && isMemberOf(callee, "console", (property) => CONSOLE_METHODS.has(property))) counters.console_calls += 1;
				if (isMemberOf(callee, "process", (property) => property === "exit")) processExits += 1;
				break;
			}
			case ts.SyntaxKind.PropertyAccessExpression: {
				const access = node as ts.PropertyAccessExpression;
				if (access.name.text === "main" && ts.isMetaProperty(access.expression) && access.expression.keywordToken === ts.SyntaxKind.ImportKeyword) entrypoint = true;
				break;
			}
			case ts.SyntaxKind.StringLiteral:
			case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
			case ts.SyntaxKind.TemplateHead:
			case ts.SyntaxKind.TemplateMiddle:
			case ts.SyntaxKind.TemplateTail:
			case ts.SyntaxKind.RegularExpressionLiteral:
				// Template middle/tail tokens start at their `}`.
				literalEnds.set(node.getStart(sourceFile), node.end);
				break;
			default:
				break;
		}
	};

	const visit = (node: ts.Node): void => {
		countNode(node);
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	if (COMMENT_HINTS.some((hint) => text.includes(hint))) readComments();

	if (!entrypoint) counters.process_exit_non_entrypoint = processExits;
	return { counters, entrypoint };
}

/** True when the file is a CLI entrypoint, so it may call process.exit. */
export function isEntrypoint(relativePath: string, text: string): boolean {
	return analyze(relativePath, text).entrypoint;
}

/**
 * Count every pattern in one file. `relativePath` is root-relative with `/` separators.
 * A file whose text holds none of the substrings any counter needs is not parsed at all.
 */
export function countFile(relativePath: string, text: string): CounterSet {
	if (!COUNTER_HINTS.some((hint) => text.includes(hint))) return emptyCounterSet();
	return analyze(relativePath, text).counters;
}

function isMissingEntry(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function walk(directory: string, relativeDirectory: string, found: string[], isRoot: boolean): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch (error) {
		// Only a scanned root that does not exist (a checkout without scripts/) contributes no files.
		if (isRoot && isMissingEntry(error)) return;
		throw new Error(`code-ratchet: cannot read ${directory}: ${error instanceof Error ? error.message : String(error)}`);
	}
	entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
			walk(join(directory, entry.name), `${relativeDirectory}/${entry.name}`, found, false);
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			found.push(`${relativeDirectory}/${entry.name}`);
		}
	}
}

/** Sorted root-relative paths of every scanned `.ts` file. */
export function listFiles(root: string): string[] {
	const found: string[] = [];
	for (const scanned of SCANNED_ROOTS) walk(join(root, scanned), scanned, found, true);
	return found;
}

/** Source counters always; test counters only with `includeTests` (informational, never gating). */
export function scan(root: string, options: { includeTests?: boolean } = {}): Counters {
	const includeTests = options.includeTests === true;
	const counters: Counters = { source: emptyCounterSet(), test: includeTests ? emptyCounterSet() : undefined };
	for (const relativePath of listFiles(root)) {
		const target = isTestFile(relativePath) ? counters.test : counters.source;
		if (target === undefined) continue;
		const text = readFileSync(join(root, ...relativePath.split("/")), "utf8");
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
	return { _generated_by: String(field(parsed, "_generated_by") ?? BASELINE_COMMAND), source: read(field(parsed, "source")) };
}

/** The `test` column appears only when the scan included test files. */
export function formatTable(counters: Counters, baseline: Baseline | undefined): string {
	const testCounters = counters.test;
	const rows = [testCounters ? ["counter", "source", "baseline", "test"] : ["counter", "source", "baseline"]];
	for (const name of COUNTER_NAMES) {
		const row = [name, String(counters.source[name]), baseline ? String(baseline.source[name] ?? "?") : "-"];
		if (testCounters) row.push(String(testCounters[name]));
		rows.push(row);
	}
	const widths = rows[0]?.map((_cell, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
	return rows
		.map((row) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0))).join("  "))
		.join("\n");
}

export function serializeBaseline(counters: Counters): string {
	const source = emptyCounterSet();
	for (const name of COUNTER_NAMES) source[name] = counters.source[name];
	const baseline: Baseline = { _generated_by: BASELINE_COMMAND, source };
	return `${JSON.stringify(baseline, null, "\t")}\n`;
}

/** One line per source counter that is above the existing baseline's value. A counter the baseline lacks is not an offender. */
export function raisedCounters(source: CounterSet, baseline: BaselineCounters): string[] {
	const offenders: string[] = [];
	for (const name of COUNTER_NAMES) {
		const limit = baseline[name];
		if (typeof limit === "number" && source[name] > limit) offenders.push(`${name}: baseline ${limit} -> now ${source[name]}`);
	}
	return offenders;
}

/**
 * Write the baseline from fresh counters. When the file already exists a source counter may only stay or fall:
 * the offending counters are returned and the file is left untouched. A missing file is created (first generation).
 */
export function writeBaseline(path: string, counters: Counters): { written: boolean; offenders: string[] } {
	if (existsSync(path)) {
		const offenders = raisedCounters(counters.source, loadBaseline(path).source);
		if (offenders.length > 0) return { written: false, offenders };
	}
	writeFileSync(path, serializeBaseline(counters));
	return { written: true, offenders: [] };
}

export type CliOptions = {
	root: string;
	baselinePath: string;
	out: (text: string) => void;
	err: (text: string) => void;
};

const DEFAULT_OPTIONS: CliOptions = {
	root: join(import.meta.dir, ".."),
	baselinePath: BASELINE_PATH,
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
};

export function main(argv: string[], options: Partial<CliOptions> = {}): number {
	const { root, baselinePath, out, err } = { ...DEFAULT_OPTIONS, ...options };
	const flags = new Set(argv);
	const known = new Set(["--check", "--write", "--with-tests"]);
	for (const flag of flags) {
		if (!known.has(flag)) {
			err(`unknown argument ${flag}\nusage: bun scripts/code-ratchet.ts [--check | --write] [--with-tests]\n`);
			return 2;
		}
	}
	const counters = scan(root, { includeTests: flags.has("--with-tests") });
	if (flags.has("--write")) {
		const result = writeBaseline(baselinePath, counters);
		if (!result.written) {
			err(`ratchet: refusing to raise the baseline; fix the code, or delete ${baselinePath.split(sep).slice(-2).join("/")} in a reviewed change\n`);
			for (const line of result.offenders) err(`${line}\n`);
			return 1;
		}
		out(`${formatTable(counters, undefined)}\nwrote ${baselinePath.split(sep).slice(-2).join("/")}\n`);
		return 0;
	}
	const baseline = loadBaseline(baselinePath);
	out(`${formatTable(counters, baseline)}\n`);
	const comparison = compare(counters.source, baseline.source);
	for (const line of [...comparison.under, ...comparison.over, ...comparison.missing]) out(`${line}\n`);
	if (flags.has("--check")) return comparison.over.length > 0 || comparison.missing.length > 0 ? 1 : 0;
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
