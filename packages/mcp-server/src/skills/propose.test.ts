/**
 * The September engine's suite, ported onto the configurable library (D21-12, D21-13).
 *
 * Fake `Runner` for everything except `writeTree` and the overlay read, which run against
 * real files; no test calls real `gh`. Real git is `propose.git.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { redact } from "../redact.ts";
import type { Surface } from "../types.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import {
	acquireLock,
	addArgv,
	branchName,
	checkoutArgv,
	cloneArgv,
	commitArgv,
	createExecFileRunner,
	diffQuietArgv,
	fetchArgv,
	legacyContentSha256,
	LIBRARY_REPO,
	LIBRARY_URL,
	mirrorOriginUrl,
	missingMirrorMessage,
	nameStatusArgv,
	originUrlArgv,
	PR_BODY_MAX,
	prBody,
	prCreateArgv,
	prListHeadArgv,
	type ProposeInput,
	type ProposeOptions,
	ProposeFailed,
	ProposeRefused,
	proposeSkill,
	prUrlOf,
	prViewArgv,
	pushArgv,
	ROUTE_MAX_BYTES,
	type RunResult,
	type Runner,
	setUrlArgv,
	stagedArgv,
	type SkillsLibrary,
	validateProposal,
	writeTree,
} from "./propose.ts";

const NAME = "demo-skill";
const PR_URL = "https://github.com/swcstudiospace/agent-skills/pull/7";
const DEAD_PID = 2147483646;
/** A throwaway library slug; its remote must end in the slug for the origin check. */
const REHEARSAL_LIBRARY: SkillsLibrary = {
	repo: "rehearsal/agent-skills",
	remoteUrl: "file:///tmp/rehearsal/agent-skills.git",
};
const REHEARSAL_PR_URL = "https://github.com/rehearsal/agent-skills/pull/9";

function skillMd(name = NAME, description = "Does one reusable thing."): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n1. Step one.\n`;
}

function input(overrides: Partial<ProposeInput> = {}): ProposeInput {
	return { name: NAME, files: { "SKILL.md": skillMd() }, rationale: "because", surface: "claude-code", ...overrides };
}

let state: string;
beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "propose-test-"));
	mkdirSync(join(state, "mirror.git"), { recursive: true });
	writeFileSync(join(state, "mirror.git", "HEAD"), "ref: refs/heads/main\n");
});
afterEach(() => {
	rmSync(state, { recursive: true, force: true });
});

/** Which step an argv is, independent of the per-propose clone path. */
function step(argv: readonly string[]): string {
	if (argv[0] === "gh") return `gh ${argv[1]} ${argv[2]}`;
	if (argv[1] === "clone") return "clone";
	const sub = argv.find((a) => ["fetch", "remote", "checkout", "add", "diff", "commit", "push", "ls-files"].includes(a)) ?? "?";
	if (sub === "remote") return argv.includes("set-url") ? "set-url" : "get-url";
	if (sub === "diff") return argv.includes("--quiet") ? "diff-quiet" : "name-status";
	return sub;
}

type FakeOptions = {
	/** Files of `<NAME>/` on origin/main, written into the clone on checkout. */
	base?: Record<string, string>;
	replies?: Record<string, Partial<RunResult>>;
	onCall?: (step: string, argv: readonly string[]) => void | Promise<void>;
};

function fake(opts: FakeOptions = {}): { run: Runner; calls: string[][]; steps: () => string[] } {
	const calls: string[][] = [];
	const replies: Record<string, Partial<RunResult>> = {
		"diff-quiet": { code: 1 },
		"get-url": { stdout: `${LIBRARY_URL}\n` },
		"gh pr create": { stdout: `${PR_URL}\n` },
		"gh pr view": { stdout: JSON.stringify({ state: "OPEN", url: PR_URL, number: 7 }) },
		"gh pr list": { stdout: "[]" },
		...opts.replies,
	};
	const run: Runner = async (argv) => {
		calls.push([...argv]);
		const s = step(argv);
		if (s === "clone") mkdirSync(argv.at(-1) as string, { recursive: true });
		if (s === "checkout" && opts.base) {
			for (const [rel, text] of Object.entries(opts.base)) {
				const target = join(argv[2] as string, NAME, rel);
				mkdirSync(join(target, ".."), { recursive: true });
				writeFileSync(target, text);
			}
		}
		await opts.onCall?.(s, argv);
		await Promise.resolve();
		const stdout = s === "ls-files" ? trackedNames(argv[2] as string) : "";
		return { code: 0, stdout, stderr: "", ...replies[s] };
	};
	return { run, calls, steps: () => calls.map(step) };
}

function options(run: Runner, overrides: Partial<ProposeOptions> = {}): ProposeOptions {
	return { maxBytes: ROUTE_MAX_BYTES, mode: "overlay", run, stateDir: state, ...overrides };
}

function ledgerLines(): Record<string, unknown>[] {
	const path = join(state, "proposals.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeLedger(line: Record<string, unknown>): void {
	const record: Record<string, unknown> = { repo: LIBRARY_REPO, ...line };
	if (line.repo === null) delete record.repo;
	writeFileSync(join(state, "proposals.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Files `git ls-files` would print after writeTree, for the fake runner. */
function trackedNames(dir: string): string {
	if (!existsSync(dir)) return "";
	const out: string[] = [];
	const walk = (current: string, rel: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			const next = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(join(current, entry.name), next);
			else out.push(next);
		}
	};
	walk(dir, "");
	return out.length > 0 ? `${out.sort().join("\0")}\0` : "";
}

function sha(inp: ProposeInput = input(), mode: "overlay" | "replace" = "overlay"): string {
	return validateProposal(inp, { maxBytes: ROUTE_MAX_BYTES, mode }).content_sha256;
}

function proposeDirEntries(): string[] {
	const root = join(state, "propose");
	return existsSync(root) ? readdirSync(root) : [];
}

function listTree(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(relative(root, full));
		}
	};
	walk(root);
	return out.sort();
}

describe("parseFrontmatter", () => {
	test("reads the fenced YAML mapping", () => {
		expect(parseFrontmatter("---\nname: a\ndescription: b\n---\nbody")).toEqual({ name: "a", description: "b" });
	});

	test("no leading fence or unparseable YAML is null", () => {
		expect(parseFrontmatter("name: a\ndescription: b\n")).toBeNull();
		expect(parseFrontmatter("# title\n---\nname: a\n---\n")).toBeNull();
		expect(parseFrontmatter("---\nname: [unclosed\ndescription: b\n---\nbody")).toBeNull();
	});
	test("accepts the byte-order mark the CLI preserves on upload", () => {
		expect(parseFrontmatter("\ufeff---\nname: a\ndescription: b\n---\nbody")).toEqual({ name: "a", description: "b" });
	});
});

/** An embedded NUL, spelled without an escape so the source never holds a control byte. */
const NUL = String.fromCharCode(0);

describe("validateProposal refusals (before any Runner call)", () => {
	const cases: Array<[string, Partial<ProposeInput>]> = [
		["name Bad_Name", { name: "Bad_Name", files: { "SKILL.md": skillMd("Bad_Name") } }],
		["name -x", { name: "-x", files: { "SKILL.md": skillMd("-x") } }],
		["name of 65 characters", { name: "a".repeat(65), files: { "SKILL.md": skillMd("a".repeat(65)) } }],
		["surface nope", { surface: "nope" as Surface }],
		["no SKILL.md", { files: { "README.md": "x" } }],
		["frontmatter name differs", { files: { "SKILL.md": skillMd("other-name") } }],
		["empty description", { files: { "SKILL.md": skillMd(NAME, '""') } }],
		["path ../x", { files: { "SKILL.md": skillMd(), "../x": "x" } }],
		["path /etc/x", { files: { "SKILL.md": skillMd(), "/etc/x": "x" } }],
		["path a/../b", { files: { "SKILL.md": skillMd(), "a/../b": "x" } }],
		["path a\\b", { files: { "SKILL.md": skillMd(), "a\\b": "x" } }],
		["path .git/config", { files: { "SKILL.md": skillMd(), ".git/config": "x" } }],
		["path refs/.hidden", { files: { "SKILL.md": skillMd(), "refs/.hidden": "x" } }],
		["path __pycache__/c.pyc", { files: { "SKILL.md": skillMd(), "__pycache__/c.pyc": "x" } }],
		["path x.pyc", { files: { "SKILL.md": skillMd(), "x.pyc": "x" } }],
		["NUL in a file", { files: { "SKILL.md": skillMd(), "scripts/a.sh": `a${NUL}b` } }],
		["NUL in rationale", { rationale: `why${NUL}now` }],
		["NUL in session_id", { session_id: `sess${NUL}x` }],
		["NUL in graph_id", { graph_id: `g${NUL}x` }],
		["remove SKILL.md", { remove: ["SKILL.md"] }],
		["remove ../x", { remove: ["../x"] }],
		["a path in both files and remove", { files: { "SKILL.md": skillMd(), "references/a.md": "x" }, remove: ["references/a.md"] }],
	];
	for (const [label, overrides] of cases) {
		test(`refuses ${label}`, async () => {
			const f = fake();
			const error = await proposeSkill(input(overrides), options(f.run)).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ProposeRefused);
			expect(f.calls).toEqual([]);
			expect(ledgerLines()).toEqual([]);
		});
	}

	test("refuses a non-string session or graph id, and never echoes the NUL text", async () => {
		for (const overrides of [
			{ session_id: 42 as unknown as string },
			{ graph_id: ["g"] as unknown as string },
		]) {
			const f = fake();
			const error = await proposeSkill(input(overrides), options(f.run)).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ProposeRefused);
			expect((error as Error).message).toContain("must be a string");
			expect(f.calls).toEqual([]);
		}
		const f = fake();
		const nul = await proposeSkill(input({ rationale: `why${NUL}now` }), options(f.run)).catch((e: unknown) => e);
		expect(nul).toBeInstanceOf(ProposeRefused);
		expect((nul as Error).message).toBe("rationale contains NUL");
		expect(f.calls).toEqual([]);
	});

	test("refuses a total over maxBytes and names the limit", async () => {
		const f = fake();
		const big = input({ files: { "SKILL.md": skillMd(), "references/big.md": "x".repeat(2_000) } });
		const error = await proposeSkill(big, options(f.run, { maxBytes: 1_000 })).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeRefused);
		expect((error as Error).message).toContain("1000");
		expect(f.calls).toEqual([]);
	});

	test("refuses a file that is also a parent of another file, before any runner call", async () => {
		const f = fake();
		const error = await proposeSkill(input({ files: { "SKILL.md": skillMd(), a: "x", "a/b.txt": "y" } }), options(f.run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeRefused);
		expect((error as Error).message).toContain("a/b.txt");
		expect(f.calls).toEqual([]);
	});

	test("refuses a credential in a path, a removal, a session id or a graph id without echoing it", async () => {
		const token = `ghp_${"C".repeat(36)}`;
		for (const overrides of [
			{ files: { "SKILL.md": skillMd(), [`notes/${token}.md`]: "x" } },
			{ remove: [`notes/${token}.md`] },
			{ session_id: token },
			{ graph_id: token },
		]) {
			const f = fake();
			const error = await proposeSkill(input(overrides), options(f.run)).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ProposeRefused);
			expect((error as Error).message).toContain("secret-like");
			expect((error as Error).message).not.toContain(token);
			expect(f.calls).toEqual([]);
		}
	});

	test("refuses frontmatter that redaction would stop being a string", async () => {
		const f = fake();
		const md = `---\nname: ${NAME}\ndescription: <private>local-only note</private>\n---\n\n# ${NAME}\n`;
		const error = await proposeSkill(input({ files: { "SKILL.md": md } }), options(f.run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeRefused);
		expect((error as Error).message).toContain("after redaction");
		expect(f.calls).toEqual([]);
	});

	test("refuses a pull request body over the cap before any runner call", async () => {
		const f = fake();
		const remove = Array.from({ length: 2_000 }, (_, i) => `references/old-${i}.md`);
		const error = await proposeSkill(input({ remove }), options(f.run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeRefused);
		expect((error as Error).message).toContain(String(PR_BODY_MAX));
		expect(f.calls).toEqual([]);
	});
});

describe("validateProposal acceptance, redaction and hashing", () => {
	test("accepts references/ and scripts/ beside SKILL.md", () => {
		const files = { "SKILL.md": skillMd(), "references/api.md": "# API\n", "scripts/run.py": "print('hi')\n" };
		const v = validateProposal(input({ files, remove: ["old.md"] }), { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" });
		expect(Object.keys(v.files).sort()).toEqual(["SKILL.md", "references/api.md", "scripts/run.py"]);
		expect(v.redactions).toEqual([]);
	});

	test("the same proposal always hashes the same; mode and removals change it", () => {
		const a = input({ files: { "references/a.md": "a", "SKILL.md": skillMd() } });
		const b = input({ files: { "SKILL.md": skillMd(), "references/a.md": "a" } });
		expect(sha(a)).toBe(sha(b));
		expect(sha(a)).not.toBe(sha(a, "replace"));
		expect(sha(a)).not.toBe(sha(input({ ...a, remove: ["x.md"] })));
	});
	test("accepts a SKILL.md with the preserved byte-order mark, bytes unchanged", () => {
		const v = validateProposal(input({ files: { "SKILL.md": `\ufeff${skillMd()}` } }), { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" });
		expect(v.files["SKILL.md"]?.startsWith("\ufeff---\n")).toBe(true);
	});

	test("a ghp_ token shape is refused with a github finding and the refusal never carries it", () => {
		const token = `ghp_${"A".repeat(36)}`;
		const md = `${skillMd()}\nexport GH=${token}\n`;
		let error: unknown;
		try {
			validateProposal(input({ files: { "SKILL.md": md } }), { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" });
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(ProposeRefused);
		const refused = error as ProposeRefused;
		expect(refused.findings).toEqual([{ file: "SKILL.md", line: 10, rule: "github" }]);
		expect(JSON.stringify({ error: refused.message, findings: refused.findings })).not.toContain(token);
	});

	test("allowDocExamples jwt turns a JWT finding into a redaction", () => {
		// Assembled at runtime: no credential shape sits in the tracked file.
		const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"].join(".");
		const md = `${skillMd()}\nExample: ${jwt}\n`;
		expect(() => validateProposal(input({ files: { "SKILL.md": md } }), { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" })).toThrow(ProposeRefused);
		const v = validateProposal(input({ files: { "SKILL.md": md } }), {
			maxBytes: ROUTE_MAX_BYTES,
			mode: "overlay",
			allowDocExamples: new Set(["jwt"]),
		});
		expect(v.redactions).toEqual([{ file: "SKILL.md", line: 10, rule: "jwt" }]);
		expect(v.files["SKILL.md"]).not.toContain(jwt);
	});
});

describe("writeTree", () => {
	function seeded(): string {
		const clone = join(state, "clone");
		mkdirSync(join(clone, NAME, "references"), { recursive: true });
		mkdirSync(join(clone, "other"), { recursive: true });
		writeFileSync(join(clone, NAME, "SKILL.md"), "old");
		writeFileSync(join(clone, NAME, "references", "x.md"), "x");
		writeFileSync(join(clone, "other", "SKILL.md"), "other");
		return clone;
	}

	test("overlay rewrites the named files and keeps the rest", () => {
		const clone = seeded();
		writeTree(clone, NAME, { "SKILL.md": "new" }, [], "overlay");
		expect(readFileSync(join(clone, NAME, "SKILL.md"), "utf8")).toBe("new");
		expect(readFileSync(join(clone, NAME, "references", "x.md"), "utf8")).toBe("x");
	});

	test("remove deletes only the listed path", () => {
		const clone = seeded();
		writeTree(clone, NAME, { "SKILL.md": "new" }, ["references/x.md"], "overlay");
		expect(listTree(join(clone, NAME))).toEqual(["SKILL.md"]);
		expect(readFileSync(join(clone, "other", "SKILL.md"), "utf8")).toBe("other");
	});

	test("replace leaves exactly the proposed files", () => {
		const clone = seeded();
		writeTree(clone, NAME, { "SKILL.md": "new", "scripts/run.sh": "echo" }, [], "replace");
		expect(listTree(join(clone, NAME))).toEqual(["SKILL.md", "scripts/run.sh"]);
		expect(listTree(clone)).toEqual([`${NAME}/SKILL.md`, `${NAME}/scripts/run.sh`, "other/SKILL.md"]);
	});

	test("nothing outside <clone>/<name>/ is created or removed", () => {
		const clone = seeded();
		const before = listTree(clone);
		expect(() => writeTree(clone, NAME, { "../other/SKILL.md": "pwn" }, [], "overlay")).toThrow();
		expect(() => writeTree(clone, NAME, { "SKILL.md": "x" }, ["../other/SKILL.md"], "overlay")).toThrow();
		expect(() => writeTree(clone, "../other", { "SKILL.md": "x" }, [], "replace")).toThrow();
		expect(listTree(clone)).toEqual(before);
		expect(readFileSync(join(clone, "other", "SKILL.md"), "utf8")).toBe("other");
		expect(existsSync(join(state, "SKILL.md"))).toBe(false);
	});

	test("a dangling symlink is removed instead of being followed", () => {
		const clone = seeded();
		const outside = join(state, "outside.txt");
		rmSync(join(clone, NAME, "SKILL.md"));
		symlinkSync(outside, join(clone, NAME, "SKILL.md"));
		writeTree(clone, NAME, { "SKILL.md": "new" }, [], "overlay");
		expect(readFileSync(join(clone, NAME, "SKILL.md"), "utf8")).toBe("new");
		expect(existsSync(outside)).toBe(false);
		expect(lstatSync(join(clone, NAME, "SKILL.md")).isSymbolicLink()).toBe(false);
	});

	test("a symlink parent is refused and the link target is untouched", () => {
		const clone = seeded();
		rmSync(join(clone, NAME, "references"), { recursive: true });
		symlinkSync(join(clone, "other"), join(clone, NAME, "references"));
		expect(() => writeTree(clone, NAME, { "references/x.md": "pwn" }, [], "overlay")).toThrow(/symlink/);
		expect(readFileSync(join(clone, "other", "SKILL.md"), "utf8")).toBe("other");
		expect(existsSync(join(clone, "other", "x.md"))).toBe(false);
	});

	test("a file where the tree has a directory is refused, naming the path", () => {
		const clone = seeded();
		expect(() => writeTree(clone, NAME, { "SKILL.md": "new", references: "x" }, [], "overlay")).toThrow(/"references" clashes/);
		expect(readFileSync(join(clone, NAME, "references", "x.md"), "utf8")).toBe("x");
	});

	test("a file under an existing file is refused, naming the parent", () => {
		const clone = seeded();
		expect(() => writeTree(clone, NAME, { "SKILL.md/a.md": "x" }, [], "overlay")).toThrow(/"SKILL\.md" exists and is not a directory/);
		expect(readFileSync(join(clone, NAME, "SKILL.md"), "utf8")).toBe("old");
	});

	test("a removal that clears the clash still applies", () => {
		const clone = seeded();
		writeTree(clone, NAME, { "SKILL.md": "new", references: "x" }, ["references"], "overlay");
		expect(readFileSync(join(clone, NAME, "references"), "utf8")).toBe("x");
	});
});

describe("branch and argv builders", () => {
	test("branchName is skill/<surface>/<name>-<UTC ms ts>-<hex>", () => {
		expect(branchName("hermes", "x", new Date("2026-09-26T10:15:00.123Z"), "a1b2")).toBe("skill/hermes/x-20260926T101500123Z-a1b2");
	});


	test("no builder carries a force or search flag, and the push has no colon refspec", () => {
		const dir = "/var/lib/substrate/skills/propose/p1";
		const br = "skill/hermes/x-20260926T101500123Z-a1b2";
		const all = [
			fetchArgv(),
			cloneArgv(dir),
			setUrlArgv(dir, LIBRARY_URL),
			checkoutArgv(dir, br),
			addArgv(dir, "x"),
			stagedArgv(dir, "x"),
			nameStatusArgv(dir),
			commitArgv(dir, "m"),
			originUrlArgv(dir),
			pushArgv(dir, br),
			prViewArgv(PR_URL),
			prListHeadArgv(br, LIBRARY_REPO),
			prCreateArgv(br, "t", "b", LIBRARY_REPO),
			diffQuietArgv(dir),
		];
		const forbidden = ["--force", "-f", "--force-with-lease", "--search"];
		for (const argv of all) for (const element of argv) expect(forbidden).not.toContain(element);
		for (const element of pushArgv(dir, br)) expect(element).not.toContain(":");
	});
});

describe("proposeSkill ledger idempotence", () => {
	test("a recorded PR that is OPEN is existing, with no clone, push or create", async () => {
		writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "b1", state: "opened", pr_url: PR_URL, pr_number: 7 });
		const f = fake();
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "existing", pr_url: PR_URL, pr_number: 7, content_sha256: sha() });
		expect(f.steps()).toEqual(["gh pr view"]);
	});
	test("a line hashed before the file/delete tags still decides the retry", async () => {
		const v = validateProposal(input(), { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" });
		writeLedger({ ts: "t", content_sha256: legacyContentSha256(v.mode, v.files, v.remove), name: NAME, surface: "claude-code", branch: "b1", state: "opened", pr_url: PR_URL, pr_number: 7 });
		const f = fake();
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "existing", pr_url: PR_URL, pr_number: 7, content_sha256: sha() });
		expect(f.steps()).toEqual(["gh pr view"]);
	});

	test("a pre-tag line for another name does not decide this proposal", async () => {
		const v = validateProposal(input(), { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" });
		writeLedger({ ts: "t", content_sha256: legacyContentSha256(v.mode, v.files, v.remove), name: "other-skill", surface: "claude-code", branch: "b1", state: "opened", pr_url: PR_URL, pr_number: 7 });
		const f = fake();
		const result = await proposeSkill(input(), options(f.run));
		expect(result.status).toBe("opened");
		expect(f.steps()).toContain("gh pr create");
	});

	test("a recorded PR the owner CLOSED is declined and remembered, with no clone, push or create", async () => {
		writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "b1", state: "opened", pr_url: PR_URL, pr_number: 7 });
		const f = fake({ replies: { "gh pr view": { stdout: JSON.stringify({ state: "CLOSED", url: PR_URL, number: 7 }) } } });
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "declined", pr_url: PR_URL });
		expect(f.steps()).toEqual(["gh pr view"]);
		expect(ledgerLines().at(-1)).toMatchObject({ content_sha256: sha(), state: "closed", pr_url: PR_URL });
	});

	test("reopen runs the normal path past a CLOSED record", async () => {
		writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "b1", state: "opened", pr_url: PR_URL, pr_number: 7 });
		const next = "https://github.com/swcstudiospace/agent-skills/pull/8";
		const f = fake({
			replies: {
				"gh pr view": { stdout: JSON.stringify({ state: "CLOSED", url: PR_URL, number: 7 }) },
				"gh pr create": { stdout: `${next}\n` },
			},
		});
		const result = await proposeSkill(input(), options(f.run, { reopen: true }));
		expect(result).toMatchObject({ status: "opened", pr_url: next, pr_number: 8 });
		expect(f.steps()).toContain("push");
	});

	test("a MERGED record runs the normal path and ends unchanged when main holds the content", async () => {
		writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "b1", state: "opened", pr_url: PR_URL, pr_number: 7 });
		const f = fake({
			replies: { "gh pr view": { stdout: JSON.stringify({ state: "MERGED", url: PR_URL, number: 7 }) }, "diff-quiet": { code: 0 } },
		});
		const result = await proposeSkill(input(), options(f.run));
		expect(result.status).toBe("unchanged");
		expect(f.steps()).toContain("clone");
		expect(f.steps()).not.toContain("push");
	});

	test("a pushed branch with no recorded PR is re-found with gh pr list --head", async () => {
		writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "skill/claude-code/b1", state: "pushed" });
		const f = fake({ replies: { "gh pr list": { stdout: JSON.stringify([{ url: PR_URL, number: 7, state: "OPEN" }]) } } });
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "existing", pr_url: PR_URL, pr_number: 7, branch: "skill/claude-code/b1" });
		expect(f.calls).toEqual([prListHeadArgv("skill/claude-code/b1", LIBRARY_REPO)]);
		expect(ledgerLines().at(-1)).toMatchObject({ state: "opened", pr_url: PR_URL, branch: "skill/claude-code/b1" });
	});

	test("a pushed branch with no PR anywhere gets gh pr create --head <branch> and no second push", async () => {
		writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "skill/claude-code/b1", state: "pushed" });
		const f = fake();
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "opened", pr_url: PR_URL, branch: "skill/claude-code/b1" });
		expect(f.steps()).toEqual(["gh pr list", "gh pr create"]);
		expect(f.calls[1]?.[6]).toBe("skill/claude-code/b1");
	});

	test("a tree identical to origin/main is unchanged: no push and no ledger line", async () => {
		const f = fake({ replies: { "diff-quiet": { code: 0 } } });
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "unchanged", content_sha256: sha() });
		expect(f.steps()).toEqual(["fetch", "clone", "set-url", "checkout", "add", "ls-files", "diff-quiet"]);
		expect(ledgerLines()).toEqual([]);
	});

	test("the normal path pushes, records pushed, creates the PR and records opened", async () => {
		const f = fake();
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "opened", pr_url: PR_URL, pr_number: 7, content_sha256: sha(), redactions: [] });
		expect(result.branch).toMatch(/^skill\/claude-code\/demo-skill-\d{8}T\d{9}Z-[0-9a-f]{4}$/);
		const lines = ledgerLines();
		expect(lines.map((line) => line.state)).toEqual(["pushed", "opened"]);
		expect(lines[1]).toMatchObject({ content_sha256: sha(), name: NAME, surface: "claude-code", branch: result.branch, pr_url: PR_URL, pr_number: 7 });
		expect(statSync(join(state, "proposals.jsonl")).mode & 0o777).toBe(0o600);
	});

	test("a PR URL from another repo is not accepted", async () => {
		const f = fake({ replies: { "gh pr create": { stdout: "https://github.com/someone/else/pull/3\n" } } });
		expect(await proposeSkill(input(), options(f.run)).catch((e: unknown) => e)).toBeInstanceOf(ProposeFailed);
	});

	test("an origin that is not the library fails before the push", async () => {
		const f = fake({ replies: { "get-url": { stdout: "https://github.com/someone/else.git\n" } } });
		const error = await proposeSkill(input(), options(f.run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeFailed);
		expect(f.steps()).not.toContain("push");
		expect(ledgerLines()).toEqual([]);
	});
	test("an unwritable ledger refuses before the push, leaving no branch to recover", async () => {
		writeFileSync(join(state, "not-a-directory"), "");
		const ledgerPath = join(state, "not-a-directory", "proposals.jsonl");
		const f = fake();
		const error = await proposeSkill(input(), options(f.run, { ledgerPath })).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeFailed);
		expect((error as Error).message).toMatch(/ledger is not writable.*refusing to push skill\//);
		expect(f.steps()).not.toContain("push");
		expect(f.steps()).not.toContain("gh pr create");
		expect(existsSync(ledgerPath)).toBe(false);
	});

	test("a ledger that breaks after the push names the branch for recovery", async () => {
		const ledgerPath = join(state, "proposals.jsonl");
		const f = fake({
			onCall: (s) => {
				if (s === "push") {
					rmSync(ledgerPath, { recursive: true, force: true });
					mkdirSync(ledgerPath, { recursive: true });
				}
			},
		});
		const error = await proposeSkill(input(), options(f.run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeFailed);
		expect((error as Error).message).toMatch(/could not record the pushed branch.*gh pr create --repo swcstudiospace\/agent-skills --head skill\/.* --base main/);
		expect(f.steps()).toContain("push");
		expect(f.steps()).not.toContain("gh pr create");
	});

	test("the capped recovery reply keeps the whole command at the longest name and repo", async () => {
		const longName = "a".repeat(64);
		const repo = `o-${"o".repeat(31)}/r-${"r".repeat(29)}`;
		expect(repo.length).toBe(65);
		const library: SkillsLibrary = { repo, remoteUrl: `file:///tmp/rehearsal/${repo}.git` };
		const ledgerPath = join(state, "proposals.jsonl");
		const f = fake({
			replies: { "get-url": { stdout: `${library.remoteUrl}\n` } },
			onCall: (s) => {
				if (s === "push") {
					rmSync(ledgerPath, { recursive: true, force: true });
					mkdirSync(ledgerPath, { recursive: true });
				}
			},
		});
		const error = await proposeSkill(
			{ name: longName, files: { "SKILL.md": skillMd(longName) }, rationale: "because", surface: "swarm-a11-devops" },
			options(f.run, { library }),
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeFailed);
		// What the caller actually sees: proposalFailure redacts and caps at 400.
		const capped = redact((error as Error).message).slice(0, 400);
		expect(capped).toContain(`--repo ${repo}`);
		expect(capped).toContain("--base main`");
	});

	test("a failing step is ProposeFailed with at most 400 redacted characters of output", async () => {
		const token = `ghp_${"B".repeat(36)}`;
		const f = fake({ replies: { push: { code: 1, stderr: `${"x".repeat(1_000)} remote rejected ${token}` } } });
		const error = await proposeSkill(input(), options(f.run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeFailed);
		const message = (error as Error).message;
		expect(message).not.toContain(token);
		expect(message).toContain("[REDACTED]");
		const output = message.slice(message.indexOf(": ") + 2);
		expect(output.length).toBeLessThanOrEqual(400);
		expect(ledgerLines()).toEqual([]);
	});

	test("the per-propose clone directory is gone on every path", async () => {
		const runs: Array<[FakeOptions, Partial<ProposeOptions>]> = [
			[{}, {}],
			[{ replies: { "diff-quiet": { code: 0 } } }, {}],
			[{ replies: { commit: { code: 1 } } }, {}],
			[{}, { dryRun: true }],
		];
		for (const [fakeOpts, optOverrides] of runs) {
			const f = fake(fakeOpts);
			await proposeSkill(input(), options(f.run, optOverrides)).catch(() => undefined);
			expect({ opts: optOverrides, left: proposeDirEntries() }).toEqual({ opts: optOverrides, left: [] });
		}
	});

	test("dryRun counts the staged diff and makes no push, gh call or ledger line", async () => {
		const f = fake({
			base: { "SKILL.md": "old", "references/a.md": "a" },
			replies: { "name-status": { stdout: `M\t${NAME}/SKILL.md\nA\t${NAME}/references/b.md\nD\t${NAME}/references/a.md\nA\t${NAME}/c.md\n` } },
		});
		const result = await proposeSkill(input(), options(f.run, { dryRun: true }));
		expect(result).toMatchObject({ status: "dry_run", diff_added: 2, diff_changed: 1, diff_deleted: 1, content_sha256: sha() });
		expect(f.steps()).toEqual(["fetch", "clone", "set-url", "checkout", "add", "ls-files", "name-status"]);
		expect(ledgerLines()).toEqual([]);
	});

	test("the overlay keeps origin/main's other files in the clone", async () => {
		let seen: string[] = [];
		const f = fake({
			base: { "SKILL.md": "old", "references/x.md": "x" },
			onCall: (s, argv) => {
				if (s === "add") seen = listTree(join(argv[2] as string, NAME));
			},
		});
		await proposeSkill(input(), options(f.run));
		expect(seen).toEqual(["SKILL.md", "references/x.md"]);
	});
});

describe("PR title and body", () => {
	test("title and body carry the hash, surface, ids, mode, removals, capped rationale and redactions", async () => {
		const f = fake();
		const md = `${skillMd()}\nAPI_KEY=abcdefghijklmnop1234\n`;
		await proposeSkill(
			input({
				files: { "SKILL.md": md },
				remove: ["references/old.md"],
				rationale: "r".repeat(3_000),
				session_id: "sess-1",
				graph_id: "graph-1",
			}),
			options(f.run),
		);
		const create = f.calls.find((argv) => step(argv) === "gh pr create") ?? [];
		const title = create[create.indexOf("--title") + 1] as string;
		const body = create[create.indexOf("--body") + 1] as string;
		expect(title).toBe(`skill(${NAME}): proposal from claude-code`);
		expect(title.length).toBeLessThanOrEqual(256);
		const hash = sha(input({ files: { "SKILL.md": md }, remove: ["references/old.md"] }));
		expect(body).toContain(`skill-content-sha256: ${hash}`);
		expect(body).toContain("claude-code");
		expect(body).toContain("sess-1");
		expect(body).toContain("graph-1");
		expect(body).toContain("overlay");
		expect(body).toContain("references/old.md");
		expect(body).toContain("r".repeat(2_000));
		expect(body).not.toContain("r".repeat(2_001));
		expect(body).toContain("Redacted spans");
		expect(body).toContain("SKILL.md:10 assignment");
		expect(body).not.toContain("abcdefghijklmnop1234");
	});

	test("a private block in the rationale is redacted before the cap, so the private text never reaches the body", () => {
		const secret = "z".repeat(2_500);
		const v = validateProposal(input(), { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" });
		const body = prBody(v, { rationale: `<private>${secret}</private>`, session_id: "sess", graph_id: "graph" });
		expect(body).not.toContain(secret);
		expect(body).toContain("[REDACTED]");
		expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
	});

	test("prBody names replace mode", () => {
		const v = validateProposal(input(), { maxBytes: ROUTE_MAX_BYTES, mode: "replace" });
		expect(prBody(v, input())).toContain("replace");
	});
});

describe("locks", () => {
	test("a lock whose PID is not alive is reclaimed", async () => {
		mkdirSync(join(state, "mirror.lock"), { recursive: true });
		writeFileSync(join(state, "mirror.lock", "pid"), String(DEAD_PID));
		mkdirSync(join(state, "locks", sha()), { recursive: true });
		writeFileSync(join(state, "locks", sha(), "pid"), String(DEAD_PID));
		const result = await proposeSkill(input(), options(fake().run));
		expect(result.status).toBe("opened");
	});

	test("a live mirror lock past the wait is ProposeFailed mirror busy", async () => {
		mkdirSync(join(state, "mirror.lock"), { recursive: true });
		writeFileSync(join(state, "mirror.lock", "pid"), String(process.pid));
		const f = fake();
		const error = await proposeSkill(input(), options(f.run, { lockWaitMs: 150 })).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeFailed);
		expect((error as Error).message).toContain("mirror busy");
		expect(f.steps()).not.toContain("fetch");
	});

	test("a live content lock past the wait is ProposeFailed proposal busy", async () => {
		mkdirSync(join(state, "locks", sha()), { recursive: true });
		writeFileSync(join(state, "locks", sha(), "pid"), String(process.pid));
		const f = fake();
		const error = await proposeSkill(input(), options(f.run, { lockWaitMs: 150 })).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeFailed);
		expect((error as Error).message).toContain("proposal busy");
		expect(f.calls).toEqual([]);
	});

	test("two concurrent identical proposals produce one gh pr create", async () => {
		const f = fake();
		const results = await Promise.all([proposeSkill(input(), options(f.run)), proposeSkill(input(), options(f.run))]);
		expect(results.map((r) => r.status).sort()).toEqual(["existing", "opened"]);
		expect(f.steps().filter((s) => s === "gh pr create")).toHaveLength(1);
		expect(f.steps().filter((s) => s === "push")).toHaveLength(1);
	});
});

describe("non-default library", () => {
	test("set-url, --repo and the PR-URL check use the configured slug and remote", async () => {
		const f = fake({
			replies: {
				"get-url": { stdout: `${REHEARSAL_LIBRARY.remoteUrl}\n` },
				"gh pr create": { stdout: `${REHEARSAL_PR_URL}\n` },
			},
		});
		const result = await proposeSkill(input(), options(f.run, { library: REHEARSAL_LIBRARY }));
		expect(result).toMatchObject({ status: "opened", pr_url: REHEARSAL_PR_URL, pr_number: 9 });
		const setUrl = f.calls.find((argv) => step(argv) === "set-url") ?? [];
		expect(setUrl.at(-1)).toBe(REHEARSAL_LIBRARY.remoteUrl);
		const create = f.calls.find((argv) => step(argv) === "gh pr create") ?? [];
		expect(create[create.indexOf("--repo") + 1]).toBe(REHEARSAL_LIBRARY.repo);
	});

	test("prUrlOf accepts only the configured slug", () => {
		expect(prUrlOf(`${PR_URL}\n`, LIBRARY_REPO)).toEqual({ url: PR_URL, number: 7 });
		expect(prUrlOf(`${PR_URL}\n`, REHEARSAL_LIBRARY.repo)).toBeNull();
		expect(prUrlOf(`${REHEARSAL_PR_URL}\n`, REHEARSAL_LIBRARY.repo)).toEqual({ url: REHEARSAL_PR_URL, number: 9 });
	});

	test("a record for another library does not decide this one", async () => {
		writeLedger({
			ts: "t",
			content_sha256: sha(),
			name: NAME,
			surface: "claude-code",
			branch: "b1",
			state: "opened",
			repo: "someone/else",
			pr_url: "https://github.com/someone/else/pull/3",
			pr_number: 3,
		});
		const f = fake();
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "opened", pr_url: PR_URL });
		expect(f.steps()).not.toContain("gh pr view");
		expect(f.steps()).toContain("push");
	});

	test("a record with no library identity is refused before any runner call", async () => {
		writeLedger({
			ts: "t",
			content_sha256: sha(),
			name: NAME,
			surface: "claude-code",
			branch: "b1",
			state: "pushed",
			repo: null,
		});
		const f = fake();
		const error = await proposeSkill(input(), options(f.run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeFailed);
		expect((error as Error).message).toContain("no library identity");
		expect(f.calls).toEqual([]);
	});

	test("a record without a slug is this library when its pull request URL says so", async () => {
		writeLedger({
			ts: "t",
			content_sha256: sha(),
			name: NAME,
			surface: "claude-code",
			branch: "b1",
			state: "opened",
			repo: null,
			pr_url: PR_URL,
			pr_number: 7,
		});
		const f = fake({ replies: { "gh pr view": { stdout: JSON.stringify({ state: "OPEN", url: PR_URL, number: 7 }) } } });
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "existing", pr_url: PR_URL, pr_number: 7 });
		expect(f.steps()).toEqual(["gh pr view"]);
	});

	test("a file named remove is not the same proposal as deleting that path", () => {
		const skill = input().files["SKILL.md"] ?? "";
		const written = sha({ ...input(), files: { "SKILL.md": skill, remove: "old.txt" } });
		const deleted = sha({ ...input(), files: { "SKILL.md": skill }, remove: ["old.txt"] });
		expect(written).not.toBe(deleted);
	});

	test("a pushed branch whose pull request was closed is declined and not created again", async () => {
		writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "skill/claude-code/b1", state: "pushed" });
		const f = fake({ replies: { "gh pr list": { stdout: JSON.stringify([{ url: PR_URL, number: 7, state: "CLOSED" }]) } } });
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "declined", pr_url: PR_URL, pr_number: 7 });
		expect(f.steps()).toEqual(["gh pr list"]);
	});
});

describe("child environment", () => {
	// Isolation is proved behaviorally, not by copying the allowlist object: see
	// propose.git.test.ts, which runs createExecFileRunner against a recording
	// executable under poisoned parent env and a hostile scratch-HOME gitconfig,
	// and the fixture's non-fast-forward/delete refusals.

	test("createExecFileRunner surfaces a missing binary as a failed run, never a throw", async () => {
		const run = createExecFileRunner({ gh: "/run/definitely-not-gh", home: "/home/svc" });
		const result = await run(["gh", "pr", "list"]);
		expect(result.code).toBeNull();
	});
});

describe("missing mirror", () => {
	test("a missing mirror.git refuses with the bootstrap before any Runner call", async () => {
		rmSync(join(state, "mirror.git"), { recursive: true, force: true });
		const f = fake();
		const error = await proposeSkill(input(), options(f.run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeFailed);
		const message = (error as Error).message;
		expect(message).toContain(join(state, "mirror.git"));
		expect(message).toContain("git clone --bare");
		expect(message).toContain("remote.origin.fetch +refs/heads/main:refs/heads/main");
		expect(f.calls).toEqual([]);
		expect(ledgerLines()).toEqual([]);
	});

	test("missingMirrorMessage renders the configured remote and path", () => {
		const message = missingMirrorMessage("/var/lib/substrate/skills/mirror.git", LIBRARY_URL);
		expect(message).toContain("/var/lib/substrate/skills/mirror.git");
		expect(message).toContain(LIBRARY_URL);
	});
});

describe("mirror origin", () => {
	function configMirror(url: string | null): void {
		if (url === null) return;
		writeFileSync(
			join(state, "mirror.git", "config"),
			`[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
		);
	}

	test("mirrorOriginUrl reads the origin url among other sections", () => {
		configMirror("https://github.com/swcstudiospace/agent-skills.git");
		expect(mirrorOriginUrl(join(state, "mirror.git"))).toBe("https://github.com/swcstudiospace/agent-skills.git");
	});

	test("mirrorOriginUrl is null without a config or an origin", () => {
		expect(mirrorOriginUrl(join(state, "mirror.git"))).toBeNull();
		writeFileSync(join(state, "mirror.git", "config"), '[core]\n\trepositoryformatversion = 0\n');
		expect(mirrorOriginUrl(join(state, "mirror.git"))).toBeNull();
	});

	test("a mirror naming the configured library proceeds", async () => {
		configMirror(LIBRARY_URL);
		const result = await proposeSkill(input(), options(fake().run));
		expect(result.status).toBe("opened");
	});

	test("a mirror pointing at another library is refused before any Runner call", async () => {
		configMirror("https://github.com/other/library.git");
		const f = fake();
		const error = await proposeSkill(input(), options(f.run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeFailed);
		expect((error as Error).message).toContain("points at");
		expect((error as Error).message).toContain(LIBRARY_REPO);
		expect(f.calls).toEqual([]);
		expect(ledgerLines()).toEqual([]);
	});
});

describe("lock takeover and release", () => {
	test("the release removes only the lock its caller still owns", async () => {
		const path = join(state, "locks", "owned");
		const release = await acquireLock(path, "proposal", 500);
		// Another process takes the path meanwhile: the stale release must not delete it.
		rmSync(path, { recursive: true, force: true });
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "pid"), "42424242");
		release();
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(join(path, "pid"), "utf8")).toBe("42424242");
		rmSync(path, { recursive: true, force: true });
	});

	test("two racers on one stale lock serialize with no stale leftovers", async () => {
		const path = join(state, "locks", "raced");
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "pid"), String(DEAD_PID));
		const first = await acquireLock(path, "proposal", 5_000);
		// The contender starts while the lock is live; releasing hands it over without a timer.
		const pending = acquireLock(path, "proposal", 5_000);
		await Promise.resolve();
		first();
		(await pending)();
		expect(existsSync(path)).toBe(false);
		expect(readdirSync(join(state, "locks")).filter((entry) => entry.includes(".stale."))).toEqual([]);
	});
});

describe("recovery from malformed gh output and failed creates", () => {
	const CLOSED_URL = "https://github.com/swcstudiospace/agent-skills/pull/6";

	for (const stdout of ["not json", "null", `"OPEN"`, "42", `{"url": "https://github.com/x/y/pull/1"}`]) {
		test(`a pushed branch with gh pr list printing ${stdout} fails closed with no push or create`, async () => {
			writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "skill/claude-code/b1", state: "pushed" });
			const before = readFileSync(join(state, "proposals.jsonl"), "utf8");
			const f = fake({ replies: { "gh pr list": { stdout } } });
			const error = await proposeSkill(input(), options(f.run)).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ProposeFailed);
			expect(f.steps()).toEqual(["gh pr list"]);
			expect(readFileSync(join(state, "proposals.jsonl"), "utf8")).toBe(before);
		});
	}

	for (const stdout of ["not json", "null", "[]", `"OPEN"`, "42", `{"state": "WEIRD"}`]) {
		test(`a recorded PR with gh pr view printing ${stdout} fails closed with no push or create`, async () => {
			writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "b1", state: "opened", pr_url: PR_URL, pr_number: 7 });
			const f = fake({ replies: { "gh pr view": { stdout } } });
			const error = await proposeSkill(input(), options(f.run)).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ProposeFailed);
			expect(f.steps()).toEqual(["gh pr view"]);
			expect(ledgerLines()).toHaveLength(1);
		});
	}

	test("mixed list rows keep OPEN precedence over CLOSED in either order", async () => {
		for (const rows of [
			[
				{ url: CLOSED_URL, number: 6, state: "CLOSED" },
				{ url: PR_URL, number: 7, state: "OPEN" },
			],
			[
				{ url: PR_URL, number: 7, state: "OPEN" },
				{ url: CLOSED_URL, number: 6, state: "CLOSED" },
			],
		]) {
			writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "skill/claude-code/b1", state: "pushed" });
			const f = fake({ replies: { "gh pr list": { stdout: JSON.stringify(rows) } } });
			const result = await proposeSkill(input(), options(f.run));
			expect(result).toMatchObject({ status: "existing", pr_url: PR_URL, pr_number: 7, branch: "skill/claude-code/b1" });
			expect(f.steps()).toEqual(["gh pr list"]);
			expect(ledgerLines().at(-1)).toMatchObject({ state: "opened", pr_url: PR_URL });
		}
	});

	test("a pushed branch whose only PR merged runs the git path on a fresh branch", async () => {
		writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "skill/claude-code/b1", state: "pushed" });
		const f = fake({ replies: { "gh pr list": { stdout: JSON.stringify([{ url: PR_URL, number: 7, state: "MERGED" }]) } } });
		const result = await proposeSkill(input(), options(f.run));
		expect(result.status).toBe("opened");
		expect(result.branch).not.toBe("skill/claude-code/b1");
		const create = f.calls.find((argv) => step(argv) === "gh pr create") ?? [];
		expect(create[create.indexOf("--head") + 1]).toBe(result.branch);
	});

	test("a create failure after the push is recovered by retry on the same branch", async () => {
		const failing = fake({ replies: { "gh pr create": { code: 1, stderr: "rejected" } } });
		const error = await proposeSkill(input(), options(failing.run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeFailed);
		const pushed = ledgerLines();
		expect(pushed.map((line) => line.state)).toEqual(["pushed"]);
		const branch = pushed[0]?.branch as string;
		expect(typeof branch).toBe("string");

		const retry = fake();
		const result = await proposeSkill(input(), options(retry.run));
		expect(result).toMatchObject({ status: "opened", pr_url: PR_URL, pr_number: 7, branch });
		expect(retry.steps()).toEqual(["gh pr list", "gh pr create"]);
	});
});

describe("dry run over previously proposed content", () => {
	function dryFake(): { run: Runner; steps: () => string[]; calls: string[][] } {
		return fake({
			base: { "SKILL.md": "old" },
			replies: { "name-status": { stdout: `M\t${NAME}/SKILL.md\n` } },
		});
	}

	test("a dry run over OPEN content still clones, stages and diffs with no gh call and no ledger write", async () => {
		writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "b1", state: "opened", pr_url: PR_URL, pr_number: 7 });
		const before = readFileSync(join(state, "proposals.jsonl"), "utf8");
		const f = dryFake();
		const result = await proposeSkill(input(), options(f.run, { dryRun: true }));
		expect(result).toMatchObject({ status: "dry_run", content_sha256: sha(), diff_changed: 1 });
		expect(f.steps()).toContain("clone");
		expect(f.steps()).toContain("name-status");
		expect(f.steps().filter((s) => s.startsWith("gh"))).toEqual([]);
		expect(f.steps()).not.toContain("push");
		expect(readFileSync(join(state, "proposals.jsonl"), "utf8")).toBe(before);
	});

	test("a dry run over CLOSED content returns dry_run, never declined, with the ledger untouched", async () => {
		writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "b1", state: "opened", pr_url: PR_URL, pr_number: 7 });
		const f = dryFake();
		const closed = fake({ replies: { "gh pr view": { stdout: JSON.stringify({ state: "CLOSED", url: PR_URL, number: 7 }) } } });
		const declined = await proposeSkill(input(), options(closed.run));
		expect(declined.status).toBe("declined");
		const before = readFileSync(join(state, "proposals.jsonl"), "utf8");
		const result = await proposeSkill(input(), options(f.run, { dryRun: true }));
		expect(result).toMatchObject({ status: "dry_run", content_sha256: sha() });
		expect(f.steps().filter((s) => s.startsWith("gh"))).toEqual([]);
		expect(readFileSync(join(state, "proposals.jsonl"), "utf8")).toBe(before);
	});

	test("a dry run over a pushed branch with no recorded PR makes no list call and writes no ledger line", async () => {
		writeLedger({ ts: "t", content_sha256: sha(), name: NAME, surface: "claude-code", branch: "skill/claude-code/b1", state: "pushed" });
		const before = readFileSync(join(state, "proposals.jsonl"), "utf8");
		const f = dryFake();
		const result = await proposeSkill(input(), options(f.run, { dryRun: true }));
		expect(result).toMatchObject({ status: "dry_run", content_sha256: sha() });
		expect(f.steps()).toContain("clone");
		expect(f.steps().filter((s) => s.startsWith("gh"))).toEqual([]);
		expect(readFileSync(join(state, "proposals.jsonl"), "utf8")).toBe(before);
	});
});

describe("engine file-text cap (internal layer only)", () => {
	// These pin the engine's INTERNAL file-text backstop only: validateProposal
	// refuses file text over maxBytes before any runner call. They do NOT close
	// the exact wire G3: the public three-door proof is the serialized
	// proposal-body UTF-8 cap enforced at the input guard (the shared
	// proposalBodyProblem / MCP-args check, transport-owned, applied before
	// token-surface injection so an exact-1M body cannot grow over the cap
	// afterwards). The whole JSON-RPC envelope is never capped: the engine only
	// ever sees the proposal body.
	const skillBytes = (): number => Buffer.byteLength(skillMd(), "utf8");

	test("file text at exactly 1_000_000 bytes is accepted; one byte more is refused before any runner call", async () => {
		const fill = "x".repeat(ROUTE_MAX_BYTES - skillBytes());
		const at = input({ files: { "SKILL.md": skillMd(), "references/big.md": fill } });
		expect(Buffer.byteLength(`${skillMd()}${fill}`, "utf8")).toBe(ROUTE_MAX_BYTES);
		expect(() => validateProposal(at, { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" })).not.toThrow();
		const over = input({ files: { "SKILL.md": skillMd(), "references/big.md": `${fill}x` } });
		const f = fake();
		const error = await proposeSkill(over, options(f.run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeRefused);
		expect(f.calls).toEqual([]);
	});

	test("multibyte text counts UTF-8 bytes, not characters", async () => {
		const head = "é".repeat(Math.floor((ROUTE_MAX_BYTES - skillBytes()) / 2));
		const pad = ROUTE_MAX_BYTES - skillBytes() - Buffer.byteLength(head, "utf8");
		const fill = head + "x".repeat(pad);
		expect(Buffer.byteLength(`${skillMd()}${fill}`, "utf8")).toBe(ROUTE_MAX_BYTES);
		expect(fill.length).toBeLessThan(ROUTE_MAX_BYTES - skillBytes());
		expect(() => validateProposal(input({ files: { "SKILL.md": skillMd(), "references/big.md": fill } }), { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" })).not.toThrow();
		const error = await proposeSkill(input({ files: { "SKILL.md": skillMd(), "references/big.md": `${fill}é` } }), options(fake().run)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeRefused);
	});

	test("escaping overhead can exceed the wire cap while the engine accepts: wire refusal belongs to the input guard", () => {
		// 999_000 quote characters are 999_000 file bytes but nearly twice as many
		// serialized bytes once escaped, so the serialized body is over the shared
		// cap while the file text is under it. This test only documents the
		// layering: refusing that body is the input guard's job (transport-owned
		// serialized-body cap before surface injection), and nothing here proves
		// the guard does it. The engine accepts its content as its internal
		// backstop permits.
		const fill = `"`.repeat(999_000);
		const body = input({ files: { "SKILL.md": skillMd(), "references/big.md": fill } });
		expect(Buffer.byteLength(`${skillMd()}${fill}`, "utf8")).toBeLessThan(ROUTE_MAX_BYTES);
		expect(Buffer.byteLength(JSON.stringify({ ...body, mode: "overlay" }), "utf8")).toBeGreaterThan(ROUTE_MAX_BYTES);
		expect(() => validateProposal(body, { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" })).not.toThrow();
	});

});
