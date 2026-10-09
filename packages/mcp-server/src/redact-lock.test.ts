/**
 * The redaction lock, enforced against the tree rather than only written down.
 *
 * Five rules that a reviewer would otherwise have to remember:
 *
 *   1. Every redactor import resolves to the shared module. If a collector, the
 *      CLI or a future package imported `redact` from anywhere else, its
 *      publication path would follow a second rule table — and the reason one
 *      table guards every path is that there is no second door past it.
 *   2. No second redactor is defined. A local `redactSecrets`, `TokenRedactor`
 *      or `scanSkill*` would drift from the shared rules silently, so even a
 *      definition that today delegates is refused: the name is the door.
 *   3. No second marker. `[REDACTED…]` literals and `.replace` calls with a
 *      `REDACTED` replacement are how a hand-rolled step spells its output;
 *      the shared module owns that spelling.
 *   4. No hand-rolled credential-shape detector. A regex or `RegExp` holding a
 *      prefix the shared module names (`ghp_`, `sk-ant-`, `AKIA`, …) is a
 *      redactor in waiting. Runtime-assembled decoys (a template string, not a
 *      pattern) stay legal.
 *   5. Injected seams stay injected. `packages/audit` and
 *      `packages/observability` take `redact` as a parameter because importing
 *      it back would be a cycle; the companion rule below pins that the only
 *      non-test constructions still pass the shared `redact`.
 *
 * The lock is a check on the repository, not on installed artifacts: a copy of
 * the module under an installed path is built from this file, not a second
 * source, so no exemption for it exists here.
 *
 * See `docs/redaction.md`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REDACTION_RULES } from "./redact.ts";
import type { RedactionRuleName } from "./redact.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const IGNORED = /(?:^|\/)(?:node_modules|\.git|dist|build|\.venv|venv|__pycache__)\//;

/** The one module every publication path redacts through. */
const SHARED_REDACT = join("packages", "mcp-server", "src", "redact.ts");

/** An offender names its file, line and rule — never the matched value. */
type Offender = string;

function lineAt(body: string, index: number): number {
	return body.slice(0, index).split("\n").length;
}

/**
 * `dot: true` matters more than it looks: an MCP server is registered in
 * `.mcp.json` or `.cursor/mcp.json`, and a scan that skipped dotfiles would let
 * exactly the wiring this file forbids through.
 */
async function filesMatching(pattern: string): Promise<string[]> {
	const found: string[] = [];
	for await (const path of new Bun.Glob(pattern).scan({ cwd: ROOT, dot: true })) {
		if (!IGNORED.test(path)) found.push(path);
	}
	return found;
}

function read(path: string): string {
	return readFileSync(join(ROOT, path), "utf8");
}

/**
 * Every tracked-or-new source the lock watches: `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`/
 * `.py`/`.sh` under `packages/`, `scripts/` and `infra/`, plus extensionless files
 * whose text starts with a shebang (today only the post-commit hook). The glob
 * also sees untracked new files, which is what keeps a fresh second redactor
 * from landing uncommitted. `redact.ts` itself and test files are excluded.
 *
 * The extension/shebang filter runs before `read()`: a tracked directory symlink
 * never qualifies, so `read()` can never throw `EISDIR` on one.
 */
async function scopeFiles(): Promise<string[]> {
	const all = await filesMatching("{packages,scripts,infra}/**/*");
	return all.filter((path) => {
		if (path === SHARED_REDACT) return false;
		if (path.endsWith(".test.ts") || /(?:^|\/)test_[^/]*\.py$/.test(path) || /_test\.py$/.test(path)) return false;
		if (/\.(?:ts|tsx|js|mjs|cjs|py|sh)$/.test(path)) return true;
		if (path.endsWith("/")) return false;
		try {
			if (!statSync(join(ROOT, path)).isFile()) return false;
		} catch {
			return false;
		}
		return read(path).startsWith("#!");
	});
}

// ── Rule 1: imports resolve to the shared module ─────────────────────────────

/** Bindings only the shared module may provide. */
const BINDING = /\b(?:redactValue|redactKnown|redactSkillContent|scanSkillFiles|REDACTED|redact)\b/;

/**
 * Line-anchored: a code-generation template holding an import inside a string
 * literal starts with a quote, so it never matches. Type-only imports are kept
 * (`(?:type\s+)?` is optional, not excluding): `import type { redact }` from
 * anywhere else would still be a second door. Multi-line import clauses match
 * because the clause class includes whitespace.
 */
const IMPORT =
	/^[ \t]*(?:import|export)\s+(?:type\s+)?((?:[\w$*\s,]|\{[^}]*\})+?)\s*\bfrom\s*["']([^"']+)["']/gm;
const DYNAMIC = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const PY_FROM_IMPORT = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/gm;
const PY_IMPORT = /^\s*import\s+[\w.]*redact\b/gm;

function specBasename(spec: string): string {
	return (spec.split("/").pop() ?? spec).replace(/\.[A-Za-z0-9]+$/, "");
}

function resolvesToShared(fromFile: string, spec: string): boolean {
	const withExt = /\.[A-Za-z0-9]+$/.test(spec) ? spec : `${spec}.ts`;
	return resolve(ROOT, dirname(fromFile), withExt) === join(ROOT, SHARED_REDACT);
}

function rule1Offenders(file: string, body: string): Offender[] {
	const offenders: Offender[] = [];
	for (const match of body.matchAll(IMPORT)) {
		const clause = match[1] ?? "";
		const spec = match[2] ?? "";
		if (BINDING.test(clause) || /redact/i.test(specBasename(spec))) {
			if (!resolvesToShared(file, spec)) offenders.push(`${file}:${lineAt(body, match.index ?? 0)} rule-1-import`);
		}
	}
	for (const match of body.matchAll(DYNAMIC)) {
		const spec = match[1] ?? "";
		if (/redact/i.test(specBasename(spec)) && !resolvesToShared(file, spec)) {
			offenders.push(`${file}:${lineAt(body, match.index ?? 0)} rule-1-import`);
		}
	}
	// A Python import can never resolve to the TypeScript module, so any match offends.
	for (const match of body.matchAll(PY_FROM_IMPORT)) {
		if (/redact/i.test(match[1] ?? "") || BINDING.test(match[2] ?? "")) {
			offenders.push(`${file}:${lineAt(body, match.index ?? 0)} rule-1-import`);
		}
	}
	for (const match of body.matchAll(PY_IMPORT)) {
		offenders.push(`${file}:${lineAt(body, match.index ?? 0)} rule-1-import`);
	}
	return offenders;
}

// ── Rule 2: no second redactor is defined ─────────────────────────────────────

const REDACTOR_NAME = String.raw`(?:redact\w*|\w*Redactor|scan\w*Secret\w*|scanSkill\w*)`;
const DEFINITIONS = [
	new RegExp(String.raw`\bfunction\s*\*?\s*(${REDACTOR_NAME})\s*[<(]`, "g"),
	new RegExp(
		String.raw`\b(?:const|let|var)\s+(${REDACTOR_NAME})\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::[^=]+?)?=>|[A-Za-z_$][\w$]*\s*=>)`,
		"g",
	),
	new RegExp(
		String.raw`^\s*(?:(?:public|private|protected|static|async|override)\s+)*(${REDACTOR_NAME})\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{=;]+)?\{`,
		"gm",
	),
	new RegExp(String.raw`\bclass\s+(\w*Redactor)\b`, "g"),
	new RegExp(String.raw`^\s*(?:async\s+)?def\s+(${REDACTOR_NAME})\s*\(`, "gm"),
	new RegExp(String.raw`^\s*(?:function\s+)?(${REDACTOR_NAME})\s*\(\)\s*\{`, "gm"),
];

/**
 * Deliberately deaf to the shapes the tree already holds: `const redacted =`
 * binds the past participle, not a redactor; `const redact = this.deps.redact`
 * aliases the injected seam (an allowlisted path, skipped below); a `redact:`
 * parameter annotates rather than defines.
 */
function rule2Offenders(file: string, body: string): Offender[] {
	const offenders: Offender[] = [];
	for (const pattern of DEFINITIONS) {
		for (const match of body.matchAll(pattern)) {
			offenders.push(`${file}:${lineAt(body, match.index ?? 0)} rule-2-definition`);
		}
	}
	return offenders;
}

// ── Rule 3: no second marker ──────────────────────────────────────────────────

const MARKER_LITERAL = /["'`][^"'`\n]*\[REDACTED/;
const MARKER_REPLACE = /\.replace(?:All)?\s*\([^;]*?,\s*REDACTED\s*\)/;

function rule3Offenders(file: string, body: string): Offender[] {
	return body
		.split("\n")
		.flatMap((line, index) =>
			MARKER_LITERAL.test(line) || MARKER_REPLACE.test(line) ? [`${file}:${index + 1} rule-3-marker`] : [],
		);
}

// ── Rule 4: no hand-rolled credential-shape detector ──────────────────────────

/**
 * Regex-literal bodies, pulled only where a `/` can open one (the preceding
 * character class keeps `a / b` division out: the identifier before the slash
 * never qualifies). `//` and `/*` comments are excluded by the lookahead.
 */
const REGEX_LITERAL = /(?:^|[=(,:;!&|?{}[\s])\/(?![*/])((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/[dgimsuyv]*/g;
const REGEXP_NEW = /new\s+RegExp\(\s*(?:"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|(\/[^/\n]+\/[dgimsuyv]*))/g;
const PY_PATTERN_ARG =
	/\bre\.(?:compile|search|match|fullmatch|sub|findall|finditer|split)\(\s*r?(?:"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)')/g;
const SHELL_TOOL_LINE = /^.*\b(?:grep|sed|awk|perl)\b.*$/gm;

/**
 * Which named event rule carries a fixed credential prefix worth scanning for,
 * and which is contextual (a generic `key = value` shape no prefix can name
 * without flagging half the tree). The `Record` type makes `tsc` fail when a
 * later phase adds a rule without deciding. `openai` needs its negative
 * lookahead spelled out because the rule source holds it literally while a
 * bare `sk-` also sits inside words like `task-graph`.
 */
const DETECTOR: Record<RedactionRuleName, RegExp | null> = {
	"private-tag": /<private>/,
	pem: /PRIVATE KEY/,
	tailscale: /tskey-/,
	password: null,
	"password-env": null,
	daytona: null,
	vault: null,
	assignment: null,
	"api-key-lower": null,
	authorization: null,
	bearer: null,
	"url-password": null,
	"linear-api": /lin_api_/,
	"linear-oauth": /lin_oauth_/,
	notion: /ntn_/,
	github: /gh\[pousr\]_|\bgh[pousr]_/,
	"github-pat": /github_pat_/,
	xai: /xai-/,
	anthropic: /sk-ant-/,
	openai: /sk-\(\?!ant-\)|(?<![A-Za-z0-9])sk-/,
	aws: /AKIA/,
	google: /AIza/,
	slack: /xoxb-/,
	npm: /npm_/,
	gitlab: /glpat-/,
	digitalocean: /dop_v1_/,
	"openai-proj": /sk-proj-/,
	"pk-rk": /\(\?:pk\|rk\)-|(?<![A-Za-z0-9])[pr]k-/,
	jwt: /eyJ/,
	"keypair-array": null,
};

function patternCandidates(file: string, body: string): string[] {
	const candidates: string[] = [];
	for (const match of body.matchAll(REGEX_LITERAL)) candidates.push(match[1] ?? "");
	for (const match of body.matchAll(REGEXP_NEW)) candidates.push(match[1] ?? match[2] ?? match[3] ?? "");
	for (const match of body.matchAll(PY_PATTERN_ARG)) candidates.push(match[1] ?? match[2] ?? "");
	if (file.endsWith(".sh") || !/\.[A-Za-z0-9]+$/.test(file)) {
		for (const match of body.matchAll(SHELL_TOOL_LINE)) candidates.push(match[0] ?? "");
	}
	return candidates;
}

function rule4Offenders(file: string, body: string): Offender[] {
	const offenders: Offender[] = [];
	const detectors = Object.entries(DETECTOR).filter((entry): entry is [string, RegExp] => entry[1] !== null);
	body
		.split("\n")
		.forEach((line, index) => {
			const hit = patternCandidates(file, line).some((candidate) =>
				detectors.some(([, detector]) => detector.test(candidate)),
			);
			if (hit) offenders.push(`${file}:${index + 1} rule-4-detector`);
		});
	return offenders;
}

// ── Rule 5: injected seams stay injected ──────────────────────────────────────

/**
 * The files allowed to take `redact` as a parameter instead of importing it.
 * The redactor lives in `packages/mcp-server`, which depends on these packages;
 * importing it back would be a cycle. Naming them rather than exempting their
 * directories wholesale means the next file that wants a seam has to be argued
 * for here.
 */
const INJECTED_SEAMS: Record<string, string> = {
	"packages/audit/src/log.ts":
		"the redactor lives in `packages/mcp-server`, which depends on this package; importing it back would be a cycle",
	"packages/audit/src/record.ts":
		"the redactor lives in `packages/mcp-server`, which depends on this package; importing it back would be a cycle",
	"packages/observability/src/otlp.ts":
		"the redactor lives in `packages/mcp-server`, which depends on this package; importing it back would be a cycle",
};

const OBSERVE = join("packages", "mcp-server", "src", "observe.ts");

function callArgs(body: string, callIndex: number): string | null {
	const open = body.indexOf("(", callIndex);
	if (open < 0) return null;
	let depth = 0;
	for (let i = open; i < body.length; i++) {
		if (body[i] === "(") depth++;
		else if (body[i] === ")") {
			depth--;
			if (depth === 0) return body.slice(open + 1, i);
		}
	}
	return null;
}

describe("redaction lock", () => {
	test("rule 1: every redactor import resolves to the shared module", async () => {
		const offenders: Offender[] = [];
		for (const file of await scopeFiles()) offenders.push(...rule1Offenders(file, read(file)));

		expect(offenders).toEqual([]);
	});

	test("rule 2: no second redactor is defined", async () => {
		const offenders: Offender[] = [];
		for (const file of await scopeFiles()) {
			if (file in INJECTED_SEAMS) continue;
			offenders.push(...rule2Offenders(file, read(file)));
		}

		expect(offenders).toEqual([]);
	});

	test("rule 3: no second marker", async () => {
		const offenders: Offender[] = [];
		for (const file of await scopeFiles()) {
			if (file in INJECTED_SEAMS) continue;
			offenders.push(...rule3Offenders(file, read(file)));
		}

		expect(offenders).toEqual([]);
	});

	test("rule 4: no hand-rolled credential-shape detector", async () => {
		const offenders: Offender[] = [];
		for (const file of await scopeFiles()) {
			if (file in INJECTED_SEAMS) continue;
			offenders.push(...rule4Offenders(file, read(file)));
		}

		expect(offenders).toEqual([]);
	});

	test("every non-null detector matches its own rule pattern source", () => {
		for (const [name, detector] of Object.entries(DETECTOR)) {
			if (detector === null) continue;
			const rule = REDACTION_RULES.find((entry) => entry.name === name);
			expect(rule, name).toBeDefined();
			expect({ name, matched: detector.test(rule!.pattern.source) }).toEqual({ name, matched: true });
		}
	});

	test("lock scope holds the shebang hook and never the shared module or a test file", async () => {
		const scope = await scopeFiles();

		expect(scope).toContain("packages/collectors/src/git/post-commit");
		expect(scope).toContain(OBSERVE);
		expect(scope).not.toContain(SHARED_REDACT);
		expect(scope.filter((path) => path.endsWith(".test.ts"))).toEqual([]);
	});

	test("the injected-seam allowlist is exactly the three cycle-bound files", () => {
		expect(Object.keys(INJECTED_SEAMS).sort()).toEqual([
			"packages/audit/src/log.ts",
			"packages/audit/src/record.ts",
			"packages/observability/src/otlp.ts",
		]);
	});

	test("injected seams still accept the shared redactor", () => {
		for (const [file, reason] of Object.entries(INJECTED_SEAMS)) {
			expect(reason.length > 0, file).toBe(true);
			expect({ file, accepts: /redact\??:\s*\(text:\s*string\)\s*=>\s*string/.test(read(file)) }).toEqual({
				file,
				accepts: true,
			});
		}
	});

	test("AuditLog and OtlpExporter are constructed only in observe.ts with the shared redact", async () => {
		// Asserted as a set rather than a ceiling: the failure mode is a *new*
		// caller reaching past the seam, and that shows up here as an extra path.
		const callers = (await scopeFiles())
			.filter((file) => /new\s+(?:AuditLog|OtlpExporter)\s*\(/.test(read(file)))
			.sort();

		expect(callers).toEqual([OBSERVE]);

		const observe = read(OBSERVE);
		for (const match of observe.matchAll(/new\s+(?:AuditLog|OtlpExporter)\s*\(/g)) {
			const args = callArgs(observe, match.index ?? 0) ?? "";
			expect({ call: match[0]?.trim(), shared: /[{,]\s*redact\s*[,}]|redact\s*:\s*redact/.test(args) }).toEqual({
				call: match[0]?.trim(),
				shared: true,
			});
		}
		expect(observe).toContain('import { redact } from "./redact.ts";');
	});

	test("no outside file calls the seam builders with a redactor of its own", async () => {
		const callers = (await scopeFiles())
			.filter((file) => !file.startsWith(join("packages", "audit") + "/"))
			.filter((file) => /\b(?:buildRecord|sanitizeField|argDigest)\s*\(/.test(read(file)));

		expect(callers).toEqual([]);
	});
});

describe("detector self-tests", () => {
	// Every prefix below is assembled at runtime from fragments, never written
	// whole, so no literal token shape sits in git. The bodies echo in the
	// assertions without ever carrying a real value: only canary words and
	// character classes.
	const GH = "gh" + "p_";
	const SK_ANT = "sk-an" + "t-";
	const LIN_API = "lin" + "_api_";
	const LIN_OAUTH = "lin" + "_oauth_";
	const GITHUB_PAT = "github" + "_pat_";

	const RULE1_OFFENDERS: Array<{ file: string; body: string }> = [
		// A copied redact.ts under another package: the binding is right, the path is not.
		{ file: "packages/collectors/src/copy.ts", body: 'import { redact } from "./redact.ts";' },
		// A binding the module never exports, from a redactor-sounding module.
		{ file: "packages/cli/src/tool.ts", body: 'import { scrub } from "../lib/redactor.ts";' },
		// A multi-line clause still names the binding on its `from` line.
		{
			file: "packages/mcp-server/src/dup.ts",
			body: 'import {\n\ttype SkillFileHit,\n\tscanSkillFiles,\n} from "./copy.ts";',
		},
		// A Python import can never resolve to the TypeScript module.
		{ file: "packages/miner/mine.py", body: "from substrate.redact import redact" },
		{ file: "packages/miner/mine.py", body: "import substrate.redact" },
	];

	const RULE1_NON_OFFENDERS: Array<{ file: string; body: string }> = [
		// The CLI import of the shared module.
		{
			file: "packages/cli/src/lessons.ts",
			body: 'import { REDACTED, redact, redactValue } from "../../mcp-server/src/redact.ts";',
		},
		// The scripts import of the shared module.
		{
			file: "scripts/greptime-smoke.ts",
			body: 'import { REDACTED } from "../packages/mcp-server/src/redact.ts";',
		},
		// A future skills/propose import of the shared module.
		{
			file: "packages/mcp-server/src/skills/propose.ts",
			body: 'import { redact, redactSkillContent, scanSkillFiles } from "../redact.ts";',
		},
		// Type-only imports are kept, and this one resolves.
		{
			file: "packages/mcp-server/src/service.ts",
			body: 'import type { RedactionRuleName } from "./redact.ts";',
		},
		// A code-generation template holding an import inside a string literal
		// starts with a quote, so the anchored match never sees it.
		{
			file: "packages/projector/src/muse.ts",
			body: '\'import { redact, redactValue } from "__REDACT_MODULE__";\'',
		},
	];

	const RULE2_OFFENDERS: string[] = [
		"function redactSecrets(value: string): string {\n\treturn value;\n}",
		"export const redactLine = (line: string): string => line;",
		"class TokenRedactor {\n\tclean(value: string): string {\n\t\treturn value;\n\t}\n}",
		"const scanForSecrets = async (t: string) => t;",
		"def redact_secrets(value):\n\treturn value",
	];

	const RULE2_NON_OFFENDERS: string[] = [
		// The past participle every call site holds is not a definition.
		"const redacted = redact(value).slice(0, limit);",
		// The injected-seam signatures, verbatim from the tree.
		"redact: (text: string) => string = (text) => text,",
		"private readonly deps: { fetch?: FetchLike; redact?: (text: string) => string } = {},",
		"// redaction happens on the write path, never in the collector",
	];

	const RULE3_OFFENDERS: string[] = [
		'const tag = "[REDACTED]";',
		// The hand-rolled step this phase migrated out of lessons.ts.
		"cleaned = cleaned.replaceAll(secret, REDACTED);",
	];

	const RULE3_NON_OFFENDERS: string[] = [
		// The smoke harness reads the marker through the imported binding.
		"summaries.some((summary) => summary.includes(REDACTED))",
		// A generic replace spelling no marker is just string code.
		"out = out.replace(pattern, replacement);",
	];

	// One planted offender per non-null detector: a hand-rolled pattern holding
	// the shape the shared rule names, in the form a copy would take (a regex
	// literal, a `RegExp`, a `re.compile`, a shell `grep`).
	const SHAPE_OFFENDERS: Array<{ rule: RedactionRuleName; file: string; body: string }> = [
		{ rule: "private-tag", file: "shape.ts", body: `const closed = /<${"priv" + "ate>"}[\\s\\S]*?<\\/private>/.test(text);` },
		{ rule: "pem", file: "shape.ts", body: `new RegExp("-----BEGIN ${"RSA PRIV" + "ATE KEY"}-----")` },
		{ rule: "tailscale", file: "shape.ts", body: `const key = /${"tskey" + "-"}[A-Za-z0-9_-]+/;` },
		{ rule: "linear-api", file: "shape.ts", body: `if (/${LIN_API}[A-Za-z0-9]{20,}/.test(id)) {` },
		{ rule: "linear-oauth", file: "shape.ts", body: `if (/${LIN_OAUTH}[A-Za-z0-9]{20,}/.test(id)) {` },
		{ rule: "notion", file: "shape.ts", body: `if (/${"nt" + "n_"}[A-Za-z0-9]{30,}/.test(id)) {` },
		{ rule: "github", file: "shape.ts", body: `const found = /${GH}[A-Za-z0-9]{36}/g.test(value);` },
		{ rule: "github-pat", file: "shape.ts", body: `if (/${GITHUB_PAT}[A-Za-z0-9_]{20,}/.test(id)) {` },
		{ rule: "xai", file: "shape.ts", body: `if (/${"xa" + "i-"}[A-Za-z0-9]{20,}/.test(id)) {` },
		{ rule: "anthropic", file: "shape.ts", body: `if (/${SK_ANT}[A-Za-z0-9_-]{20,}/.test(id)) {` },
		{ rule: "openai", file: "shape.ts", body: `if (/${"sk" + "-"}[A-Za-z0-9]{20,}/.test(id)) {` },
		{ rule: "aws", file: "mine.py", body: `m = re.compile(r"${"AK" + "IA"}[0-9A-Z]{16}")` },
		{ rule: "google", file: "shape.ts", body: `if (/${"AI" + "za"}[0-9A-Za-z_-]{35}/.test(id)) {` },
		{ rule: "slack", file: "shape.ts", body: `new RegExp("${"xox" + "b-"}[0-9]+")` },
		{ rule: "npm", file: "shape.ts", body: `if (/${"np" + "m_"}[A-Za-z0-9]{36}/.test(id)) {` },
		{ rule: "gitlab", file: "scan.sh", body: `grep -E '${"glp" + "at-"}[0-9A-Za-z_-]{20,}' scope.txt` },
		{ rule: "digitalocean", file: "shape.ts", body: `if (/${"dop" + "_v1_"}[a-f0-9]{64}/.test(id)) {` },
		{ rule: "openai-proj", file: "shape.ts", body: `if (/${"sk-pr" + "oj-"}[A-Za-z0-9_-]{20,}/.test(id)) {` },
		{ rule: "pk-rk", file: "shape.ts", body: `if (/(?:${"pk" + "|rk"})-[A-Za-z0-9_-]{20,}/.test(key)) {` },
		{ rule: "jwt", file: "shape.ts", body: `if (/${"e" + "yJ"}[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}/.test(id)) {` },
	];

	const RULE4_NON_OFFENDERS: string[] = [
		// The runtime-assembled smoke decoy is a string, not a detector.
		'const DECOY = `' + GH + '${"A".repeat(36)}`;',
		// Division is not a regex literal.
		"const ratio = a / b / c;",
		"if (done / total > 0.5) {",
		// A comment naming a shape detects nothing.
		"// tokens shaped like " + GH + "… are redacted on write",
	];

	test("rule 1 catches planted offenders and passes the shared-module imports", () => {
		for (const { file, body } of RULE1_OFFENDERS) {
			expect({ body, caught: rule1Offenders(file, body).length > 0 }).toEqual({ body, caught: true });
		}
		for (const { file, body } of RULE1_NON_OFFENDERS) {
			expect({ body, offenders: rule1Offenders(file, body) }).toEqual({ body, offenders: [] });
		}
	});

	test("rule 2 catches planted definitions and passes usages and seam signatures", () => {
		for (const body of RULE2_OFFENDERS) {
			expect({ body, caught: rule2Offenders("shape.ts", body).length > 0 }).toEqual({ body, caught: true });
		}
		for (const body of RULE2_NON_OFFENDERS) {
			expect({ body, offenders: rule2Offenders("shape.ts", body) }).toEqual({ body, offenders: [] });
		}
	});

	test("rule 3 catches planted markers and passes the binding read", () => {
		for (const body of RULE3_OFFENDERS) {
			expect({ body, caught: rule3Offenders("shape.ts", body).length > 0 }).toEqual({ body, caught: true });
		}
		for (const body of RULE3_NON_OFFENDERS) {
			expect({ body, offenders: rule3Offenders("shape.ts", body) }).toEqual({ body, offenders: [] });
		}
	});

	test("every non-null detector catches its planted offender through the pipeline", () => {
		const uncovered = Object.entries(DETECTOR)
			.filter((entry): entry is [string, RegExp] => entry[1] !== null)
			.map(([name]) => name)
			.filter((name) => !SHAPE_OFFENDERS.some((planted) => planted.rule === name));
		expect(uncovered).toEqual([]);
		for (const { rule, file, body } of SHAPE_OFFENDERS) {
			const detector = DETECTOR[rule];
			expect(detector, rule).not.toBeNull();
			expect({ rule, caught: detector!.test(body) }).toEqual({ rule, caught: true });
			expect({ rule, extracted: patternCandidates(file, body).some((candidate) => detector!.test(candidate)) }).toEqual({ rule, extracted: true });
			expect({ rule, pipeline: rule4Offenders(file, body).length > 0 }).toEqual({ rule, pipeline: true });
		}
	});

	test("rule 4 passes the decoy, division and comments", () => {
		for (const body of RULE4_NON_OFFENDERS) {
			expect({ body, offenders: rule4Offenders("shape.ts", body) }).toEqual({ body, offenders: [] });
		}
		expect(RULE4_NON_OFFENDERS[0]).toContain('${"A".repeat(36)}');
		expect(RULE4_NON_OFFENDERS[3]).toContain(GH);
	});
});
