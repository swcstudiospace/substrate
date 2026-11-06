/**
 * The environment-read scanner behind the flag-registry lock (uplift-5 U5-7).
 *
 * `scanSource` reads one TypeScript file's text and returns every environment
 * variable NAME it reads, so `flag-registry.test.ts` can demand that each one
 * has a row in `flag-registry.ts`. It takes text (and `scanFiles` a file list)
 * rather than walking the tree itself, so the test can feed it a planted
 * fixture and prove an unregistered read is caught.
 *
 * Forms that count as a read:
 * - an access: `process.env.NAME`, `env.NAME`, `env["NAME"]`, `io.env.NAME`,
 *   `parentEnv.NAME` (any identifier ending in `env`/`Env`);
 * - a helper call by name: `env("NAME")` (packages/host/src/main.ts), any
 *   upper-case name whatever its prefix;
 * - destructuring: `const { NAME, OTHER: alias } = process.env` (none exists in
 *   the repo today; the form is covered so the first one cannot slip through);
 * - a whole string literal that is a variable name under a known prefix
 *   (`"SUBSTRATE_X"`), which is how this repo declares names it reads later
 *   (`INDEX_ROOTFS_ENV`, name tables). The prefix list was derived from every
 *   name the repo's access and helper-call reads use, so it holds exactly the
 *   prefixes that exist (`ENV_NAME_PREFIXES`); a new prefix is first seen
 *   through an access or helper call and then needs adding here for literals;
 * - a prefix that is completed at run time (`SUBSTRATE_TOKEN_${…}`, or the
 *   literal `"SUBSTRATE_TOKEN_"`), reported as a `template` so the registry
 *   must hold a family with that prefix.
 *
 * Scope and blind spots (stated, not hidden): TypeScript under `packages/**` and
 * `scripts/**` only, tests excluded. NOT covered: the Python dispatcher and the
 * infra shell (`infra/vps/*.sh`); a name built by concatenation with no literal
 * prefix; a lookup by a variable key (`process.env[key]` where `key` comes from
 * a list: its literals are found only under a known prefix, so the docker
 * client's own variables are exempt rows); a read through an object that is not
 * named `…env`/`…Env` (`const e = process.env; e.NAME`); and aliasing through
 * a wrapper that is not named like an env reader.
 *
 * Side-effect-free apart from reading the files it is handed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The registry declares names; reading its own rows as reads would make every row vouch for itself. */
const DECLARATION_FILES: ReadonlySet<string> = new Set(["packages/mcp-server/src/flag-registry.ts"]);

/** Prefixes under which a whole string literal counts as an environment name. */
const ENV_NAME_PREFIXES: readonly string[] = [
	"SUBSTRATE",
	"HINDSIGHT",
	"RAGFLOW",
	"GREPTIME",
	"DRAGONFLY",
	"OTEL",
	"SOLANA",
	"NOTION",
	"LINEAR",
	"HERMES",
	"GROK",
	"MUSE",
	"HERDR",
	"CHAOS",
	"RIVET",
	"RIVETKIT",
	"DOCKER",
	"CLAUDE",
].map((word) => `${word}_`);

type EnvReadForm = "access" | "literal" | "template";

export interface EnvRead {
	/** The variable name, or for `template` the prefix that is completed at run time. */
	name: string;
	form: EnvReadForm;
	file: string;
	/** 1-based. */
	line: number;
}

/** Blanks comments, keeping line numbers. Heuristic and line-based: a `//` or `/*` inside a string is not a comment. */
function stripComments(source: string): string {
	const out: string[] = [];
	let inBlock = false;
	for (const raw of source.split("\n")) {
		let line = raw;
		if (inBlock) {
			const end = line.indexOf("*/");
			if (end < 0) {
				out.push("");
				continue;
			}
			line = line.slice(end + 2);
			inBlock = false;
		}
		// A `/* … */` that opens and closes on this line, after whitespace or at its start.
		line = line.replace(/(^|\s)\/\*(?=[*\s])[\s\S]*?\*\//g, "$1");
		const open = /(^|\s)\/\*(?=[*\s]|$)/.exec(line);
		if (open !== null) {
			line = line.slice(0, open.index);
			inBlock = true;
		}
		// A trailing `// …` counts only when the text before it has balanced quotes.
		const slashes = /(^|\s)\/\//.exec(line);
		if (slashes !== null) {
			const before = line.slice(0, slashes.index);
			const quotes = (before.match(/(?<!\\)["'`]/g) ?? []).length;
			if (quotes % 2 === 0) line = before;
		}
		out.push(line);
	}
	return out.join("\n");
}

const ACCESS_DOT = /(?<![A-Za-z0-9_$])[A-Za-z_]*[eE]nv\??\.([A-Z][A-Z0-9_]*)\b/g;
const ACCESS_INDEX = /(?<![A-Za-z0-9_$])[A-Za-z_]*[eE]nv\??\[\s*(["'`])([A-Za-z0-9_]+)\1\s*\]/g;
/** A helper that reads the environment by name: `env("NAME")`, `getEnv("NAME")`; any upper-case name, whatever its prefix. */
const ACCESS_CALL = /(?<![A-Za-z0-9_$.])[A-Za-z_]*[eE]nv\s*\(\s*(["'`])([A-Z][A-Z0-9_]*)\1\s*[,)]/g;
/** `const { NAME, OTHER: alias = "x" } = process.env` (also `Bun.env`, `import.meta.env`, any `…env`/`…Env` object); the braces may span lines. */
const DESTRUCTURE = /\{([^{}]*)\}\s*=\s*(?:process\.env|Bun\.env|import\.meta\.env|[A-Za-z_]*[eE]nv)\b(?!\s*[.([])/g;
const PREFIX_ALTERNATION = ENV_NAME_PREFIXES.map((prefix) => prefix.replace(/_$/, "")).join("|");
const LITERAL_NAME = new RegExp(`(["'\`])((?:${PREFIX_ALTERNATION})(?:_[A-Z0-9]+)+)\\1`, "g");
const LITERAL_PREFIX = new RegExp(`(["'\`])((?:${PREFIX_ALTERNATION})_(?:[A-Z0-9]+_)*)\\1`, "g");
const TEMPLATE_PREFIX = new RegExp(`\`((?:${PREFIX_ALTERNATION})_(?:[A-Z0-9]+_)*)\\$\\{`, "g");

function lineOf(text: string, index: number): number {
	let line = 1;
	for (let at = text.indexOf("\n"); at >= 0 && at < index; at = text.indexOf("\n", at + 1)) line += 1;
	return line;
}

/** Every environment read in one file's text. `file` is only a label. */
export function scanSource(file: string, source: string): EnvRead[] {
	const text = stripComments(source);
	const reads: EnvRead[] = [];
	const push = (name: string, form: EnvReadForm, index: number): void => {
		reads.push({ name, form, file, line: lineOf(text, index) });
	};
	// A match whose capture group or index is missing carries no name to report, so it is skipped.
	const pushGroup = (pattern: RegExp, group: number, form: EnvReadForm): void => {
		for (const match of text.matchAll(pattern)) {
			const name = match[group];
			const index = match.index;
			if (name === undefined || index === undefined) continue;
			push(name, form, index);
		}
	};
	pushGroup(ACCESS_DOT, 1, "access");
	pushGroup(ACCESS_INDEX, 2, "access");
	pushGroup(ACCESS_CALL, 2, "access");
	for (const match of text.matchAll(DESTRUCTURE)) {
		const list = match[1];
		const index = match.index;
		if (list === undefined || index === undefined) continue;
		for (const part of list.split(",")) {
			const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part)?.[1];
			if (name !== undefined && /^[A-Z][A-Z0-9_]*$/.test(name)) push(name, "access", index);
		}
	}
	pushGroup(LITERAL_NAME, 2, "literal");
	pushGroup(LITERAL_PREFIX, 2, "template");
	pushGroup(TEMPLATE_PREFIX, 1, "template");
	return reads;
}

/** Reads of the given files, paths taken relative to `root` (absolute paths pass through). */
export function scanFiles(files: readonly string[], root = ""): EnvRead[] {
	const reads: EnvRead[] = [];
	for (const file of files) reads.push(...scanSource(file, readFileSync(root === "" ? file : join(root, file), "utf8")));
	return reads;
}

/** `packages/**` and `scripts/**` TypeScript, tests excluded: the surface that can read the process environment in production. */
export async function envReadSources(root: string): Promise<string[]> {
	const found: string[] = [];
	for (const pattern of ["packages/**/*.ts", "scripts/**/*.ts"]) {
		for await (const path of new Bun.Glob(pattern).scan({ cwd: root, dot: false })) {
			if (path.endsWith(".test.ts") || path.endsWith(".d.ts") || DECLARATION_FILES.has(path)) continue;
			if (path.split("/").some((part) => part === "node_modules" || part === "dist")) continue;
			found.push(path);
		}
	}
	return found.sort();
}
