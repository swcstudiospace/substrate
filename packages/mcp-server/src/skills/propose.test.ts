import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Surface } from "../types.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import {
	addArgv,
	branchName,
	checkoutArgv,
	cloneArgv,
	commitArgv,
	createSkillProposer,
	fetchArgv,
	LIBRARY_URL,
	MIRROR,
	nameStatusArgv,
	originUrlArgv,
	prBody,
	prCreateArgv,
	prListHeadArgv,
	type ProposeInput,
	type ProposeOptions,
	ProposeFailed,
	ProposeRefused,
	proposeSkill,
	prViewArgv,
	pushArgv,
	ROUTE_MAX_BYTES,
	type RunResult,
	type Runner,
	setUrlArgv,
	validateProposal,
	writeTree,
} from "./propose.ts";

const NAME = "demo-skill";
const PR_URL = "https://github.com/swcstudiospace/agent-skills/pull/7";
const DEAD_PID = 2147483646;

function skillMd(name = NAME, description = "Does one reusable thing."): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n1. Step one.\n`;
}

function input(overrides: Partial<ProposeInput> = {}): ProposeInput {
	return { name: NAME, files: { "SKILL.md": skillMd() }, rationale: "because", surface: "claude-code", ...overrides };
}

let state: string;
beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "propose-test-"));
});
afterEach(() => {
	rmSync(state, { recursive: true, force: true });
});

/** Which step an argv is, independent of the per-propose clone path. */
function step(argv: readonly string[]): string {
	if (argv[0] === "gh") return `gh ${argv[1]} ${argv[2]}`;
	if (argv[1] === "clone") return "clone";
	const sub = argv.find((a) => ["fetch", "remote", "checkout", "add", "diff", "commit", "push"].includes(a)) ?? "?";
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
		return { code: 0, stdout: "", stderr: "", ...replies[s] };
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
	writeFileSync(join(state, "proposals.jsonl"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
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
});

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
		["NUL in a file", { files: { "SKILL.md": skillMd(), "scripts/a.sh": "a\u0000b" } }],
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

	test("refuses a total over maxBytes and names the limit", async () => {
		const f = fake();
		const big = input({ files: { "SKILL.md": skillMd(), "references/big.md": "x".repeat(2_000) } });
		const error = await proposeSkill(big, options(f.run, { maxBytes: 1_000 })).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProposeRefused);
		expect((error as Error).message).toContain("1000");
		expect(f.calls).toEqual([]);
	});
});

describe("validateProposal acceptance, redaction and hashing", () => {
	test("accepts references/ and scripts/ beside SKILL.md and hashes mode, files and removals", () => {
		const files = { "SKILL.md": skillMd(), "references/api.md": "# API\n", "scripts/run.py": "print('hi')\n" };
		const v = validateProposal(input({ files, remove: ["old.md"] }), { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" });
		expect(Object.keys(v.files).sort()).toEqual(["SKILL.md", "references/api.md", "scripts/run.py"]);
		expect(v.redactions).toEqual([]);
		const h = createHash("sha256");
		h.update("overlay\0");
		for (const path of ["SKILL.md", "references/api.md", "scripts/run.py"]) h.update(`${path}\0${files[path as keyof typeof files]}\0`);
		h.update("remove\0old.md\0");
		expect(v.content_sha256).toBe(h.digest("hex"));
	});

	test("the same proposal always hashes the same; mode and removals change it", () => {
		const a = input({ files: { "references/a.md": "a", "SKILL.md": skillMd() } });
		const b = input({ files: { "SKILL.md": skillMd(), "references/a.md": "a" } });
		expect(sha(a)).toBe(sha(b));
		expect(sha(a)).not.toBe(sha(a, "replace"));
		expect(sha(a)).not.toBe(sha(input({ ...a, remove: ["x.md"] })));
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
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV";
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
});

describe("branch and argv builders", () => {
	test("branchName is skill/<surface>/<name>-<UTC ms ts>-<hex>", () => {
		expect(branchName("hermes", "x", new Date("2026-09-26T10:15:00.123Z"), "a1b2")).toBe("skill/hermes/x-20260926T101500123Z-a1b2");
	});

	test("argv builders are exact", () => {
		const dir = "/var/lib/substrate/skills/propose/p1";
		const br = "skill/hermes/x-20260926T101500123Z-a1b2";
		expect(fetchArgv()).toEqual(["git", "-C", MIRROR, "fetch", "origin", "main"]);
		expect(cloneArgv(dir)).toEqual(["git", "clone", "--shared", "--no-checkout", MIRROR, dir]);
		expect(setUrlArgv(dir)).toEqual(["git", "-C", dir, "remote", "set-url", "origin", "https://github.com/swcstudiospace/agent-skills.git"]);
		expect(checkoutArgv(dir, br)).toEqual(["git", "-C", dir, "checkout", "-q", "-b", br, "origin/main"]);
		expect(addArgv(dir, "x")).toEqual(["git", "-C", dir, "add", "--", "x"]);
		expect(pushArgv(dir, br)).toEqual(["git", "-C", dir, "push", "origin", br]);
		expect(prViewArgv(PR_URL)).toEqual(["gh", "pr", "view", PR_URL, "--json", "state,url,number"]);
		expect(prListHeadArgv(br)).toEqual(["gh", "pr", "list", "--repo", "swcstudiospace/agent-skills", "--head", br, "--state", "open", "--json", "url,number"]);
		expect(prCreateArgv(br, "t", "b")).toEqual(["gh", "pr", "create", "--repo", "swcstudiospace/agent-skills", "--head", br, "--base", "main", "--title", "t", "--body", "b"]);
	});

	test("no builder carries a force or search flag, and the push has no colon refspec", () => {
		const dir = "/var/lib/substrate/skills/propose/p1";
		const br = "skill/hermes/x-20260926T101500123Z-a1b2";
		const all = [
			fetchArgv(),
			cloneArgv(dir),
			setUrlArgv(dir),
			checkoutArgv(dir, br),
			addArgv(dir, "x"),
			nameStatusArgv(dir),
			commitArgv(dir, "m"),
			originUrlArgv(dir),
			pushArgv(dir, br),
			prViewArgv(PR_URL),
			prListHeadArgv(br),
			prCreateArgv(br, "t", "b"),
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
		const f = fake({ replies: { "gh pr list": { stdout: JSON.stringify([{ url: PR_URL, number: 7 }]) } } });
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "existing", pr_url: PR_URL, pr_number: 7, branch: "skill/claude-code/b1" });
		expect(f.calls).toEqual([prListHeadArgv("skill/claude-code/b1")]);
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
		expect(f.steps()).toEqual(["fetch", "clone", "set-url", "checkout", "add", "diff-quiet"]);
		expect(ledgerLines()).toEqual([]);
	});

	test("the normal path pushes, records pushed, creates the PR and records opened", async () => {
		const f = fake();
		const result = await proposeSkill(input(), options(f.run));
		expect(result).toMatchObject({ status: "opened", pr_url: PR_URL, pr_number: 7, content_sha256: sha(), redactions: [] });
		expect(result.branch).toMatch(/^skill\/claude-code\/demo-skill-\d{8}T\d{9}Z-[0-9a-f]{4}$/);
		expect(f.steps()).toEqual(["fetch", "clone", "set-url", "checkout", "add", "diff-quiet", "commit", "get-url", "push", "gh pr create"]);
		const lines = ledgerLines();
		expect(lines.map((line) => line.state)).toEqual(["pushed", "opened"]);
		expect(lines[1]).toMatchObject({ content_sha256: sha(), name: NAME, surface: "claude-code", branch: result.branch, pr_url: PR_URL, pr_number: 7 });
		expect(statSync(join(state, "proposals.jsonl")).mode & 0o777).toBe(0o600);
		const commit = f.calls.find((argv) => step(argv) === "commit") ?? [];
		expect(commit).toContain("user.name=substrate skills");
		expect(commit).toContain("user.email=skills@substrate.local");
		expect(commit.at(-1)).toBe(`skill(${NAME}): claude-code proposal\n\nskill-content-sha256: ${sha()}\nRefs SPE-2734`);
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
		for (const [i, [fakeOpts, extra]] of runs.entries()) {
			const f = fake(fakeOpts);
			await proposeSkill(input(), options(f.run, { ...extra, ledgerPath: join(state, `ledger-${i}.jsonl`) })).catch(() => undefined);
			expect(f.steps()).toContain("clone");
			expect(proposeDirEntries()).toEqual([]);
		}
	});

	test("dryRun counts the staged diff and makes no push, gh call or ledger line", async () => {
		const f = fake({
			base: { "SKILL.md": "old", "references/a.md": "a" },
			replies: { "name-status": { stdout: `M\t${NAME}/SKILL.md\nA\t${NAME}/references/b.md\nD\t${NAME}/references/a.md\nA\t${NAME}/c.md\n` } },
		});
		const result = await proposeSkill(input(), options(f.run, { dryRun: true }));
		expect(result).toMatchObject({ status: "dry_run", diff_added: 2, diff_changed: 1, diff_deleted: 1, content_sha256: sha() });
		expect(f.steps()).toEqual(["fetch", "clone", "set-url", "checkout", "add", "name-status"]);
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

	test("prBody names replace mode", () => {
		const v = validateProposal(input(), { maxBytes: ROUTE_MAX_BYTES, mode: "replace" });
		expect(prBody(v, input())).toContain("replace");
	});
});

describe("locks", () => {
	test("the mirror lock is released after the fetch; the content lock is held through the ledger writes", async () => {
		const observed: Record<string, boolean[]> = {};
		const f = fake({
			onCall: (s) => {
				observed[s] = [existsSync(join(state, "mirror.lock")), existsSync(join(state, "locks", sha()))];
			},
		});
		await proposeSkill(input(), options(f.run));
		expect(observed.fetch).toEqual([true, true]);
		expect(observed.clone).toEqual([false, true]);
		expect(observed["gh pr create"]).toEqual([false, true]);
		expect(existsSync(join(state, "mirror.lock"))).toBe(false);
		expect(existsSync(join(state, "locks", sha()))).toBe(false);
	});

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

describe("createSkillProposer", () => {
	test("binds the runner", async () => {
		const f = fake();
		const proposer = createSkillProposer({ run: f.run });
		const result = await proposer.propose(input(), { maxBytes: ROUTE_MAX_BYTES, mode: "overlay", stateDir: state });
		expect(result.status).toBe("opened");
		expect(f.steps()).toContain("gh pr create");
	});
});
