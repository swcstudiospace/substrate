/**
 * The engine against real git (no Docker, no real `gh`).
 *
 * `git` is cheap and present, so this builds actual repositories in a temp directory rather
 * than stubbing the spawn: what the engine has to get right is how git behaves — the mirror
 * refspec advancing `main`, a shared clone checking out `origin/main`, a push landing a new
 * branch over `file://` — and a stub would only prove that the author's idea of git matches
 * itself. `gh` stays an in-process fake: no test calls real `gh`.
 *
 * The fixture (bare library plus mirror) uses the same commands as the rehearsal harness.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecFileRunner, proposeSkill, ProposeFailed, type Runner, type RunResult, ROUTE_MAX_BYTES } from "./propose.ts";

const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().slice(0, 400)}`);
	}
}

function gitText(args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().slice(0, 400)}`);
	}
	return result.stdout.toString();
}

function skillMd(name: string): string {
	return `---\nname: ${name}\ndescription: Does one reusable thing.\n---\n\n# ${name}\n\n1. Step one.\n`;
}

type Fixture = { stateDir: string; bare: string; repo: string; remoteUrl: string };

/** A throwaway library at `<root>/rehearsal/agent-skills.git`, seeded with one skill, plus a mirror. */
function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "propose-git-"));
	made.push(root);
	const bare = join(root, "rehearsal", "agent-skills.git");
	git(["init", "-q", "--bare", "-b", "main", bare]);
	for (const [key, value] of [
		["receive.denyNonFastForwards", "true"],
		["receive.denyDeletes", "true"],
		["core.logAllRefUpdates", "always"],
	] as Array<[string, string]>) {
		git(["-C", bare, "config", key, value]);
	}
	const seed = join(root, "seed");
	git(["init", "-q", "-b", "main", seed]);
	mkdirSync(join(seed, "demo-skill"), { recursive: true });
	writeFileSync(join(seed, "demo-skill", "SKILL.md"), skillMd("demo-skill"));
	git(["-C", seed, "add", "."]);
	git(["-C", seed, "-c", "user.name=Substrate Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "seed"]);
	git(["-C", seed, "push", "-q", bare, "main"]);
	const stateDir = join(root, "skills");
	const mirror = join(stateDir, "mirror.git");
	git(["clone", "-q", "--bare", bare, mirror]);
	git(["-C", mirror, "config", "remote.origin.fetch", "+refs/heads/main:refs/heads/main"]);
	return { stateDir, bare, repo: "rehearsal/agent-skills", remoteUrl: `file://${bare}` };
}

type FakeGh = {
	prs: Array<{ url: string; number: number; state: "OPEN" | "CLOSED"; branch: string }>;
	next: number;
	calls: string[][];
};

/** An in-process `gh`: answers `pr create`, `pr view` and `pr list --head` from recorded PRs. */
function fakeGhRunner(fx: Fixture, fake: FakeGh): Runner {
	const gitRun = createExecFileRunner({ gh: "gh" });
	const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
	return async (argv: readonly string[]) => {
		if (argv[0] !== "gh") return gitRun(argv);
		fake.calls.push([...argv]);
		const op = argv[2];
		if (op === "create") {
			const branch = argv[argv.indexOf("--head") + 1] as string;
			const number = fake.next++;
			const url = `https://github.com/${fx.repo}/pull/${number}`;
			fake.prs.push({ url, number, state: "OPEN", branch });
			return ok(`${url}\n`);
		}
		if (op === "view") {
			const url = argv[3] as string;
			const pr = fake.prs.find((p) => p.url === url);
			if (!pr) return { code: 1, stdout: "", stderr: "no such PR" };
			return ok(JSON.stringify({ state: pr.state, url: pr.url, number: pr.number }));
		}
		if (op === "list") {
			const branch = argv[argv.indexOf("--head") + 1] as string;
			const open = fake.prs.filter((p) => p.branch === branch && p.state === "OPEN");
			return ok(JSON.stringify(open.map((p) => ({ url: p.url, number: p.number }))));
		}
		return { code: 1, stdout: "", stderr: `unexpected gh argv ${argv.join(" ")}` };
	};
}

describe("proposeSkill against real git", () => {
	test("a valid proposal opens, pushes a branch, and leaves an all-zero-old-sha reflog", async () => {
		const fx = fixture();
		const fake: FakeGh = { prs: [], next: 1, calls: [] };
		const result = await proposeSkill(
			{ name: "new-skill", files: { "SKILL.md": skillMd("new-skill") }, rationale: "because", surface: "claude-code" },
			{ maxBytes: ROUTE_MAX_BYTES, mode: "overlay", run: fakeGhRunner(fx, fake), stateDir: fx.stateDir, library: { repo: fx.repo, remoteUrl: fx.remoteUrl } },
		);
		expect(result.status).toBe("opened");
		expect(result.branch).toMatch(/^skill\/claude-code\/new-skill-\d{8}T\d{9}Z-[0-9a-f]{4}$/);
		const branch = result.branch as string;
		const sha = gitText(["--git-dir", fx.bare, "rev-parse", "--verify", `refs/heads/${branch}`]).trim();
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		const reflogPath = join(fx.bare, "logs", "refs", "heads", branch);
		expect(existsSync(reflogPath)).toBe(true);
		const lines = readFileSync(reflogPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]?.split(" ")[0]).toBe("0".repeat(40));
		expect(fake.calls.filter((argv) => argv[2] === "create")).toHaveLength(1);
		expect(existsSync(join(fx.stateDir, "proposals.jsonl"))).toBe(true);
	});

	test("a non-ascii filename is staged and the proposal opens", async () => {
		const fx = fixture();
		const fake: FakeGh = { prs: [], next: 1, calls: [] };
		const result = await proposeSkill(
			{
				name: "new-skill",
				files: { "SKILL.md": skillMd("new-skill"), "references/café.md": "notes\n" },
				rationale: "because",
				surface: "claude-code",
			},
			{ maxBytes: ROUTE_MAX_BYTES, mode: "overlay", run: fakeGhRunner(fx, fake), stateDir: fx.stateDir, library: { repo: fx.repo, remoteUrl: fx.remoteUrl } },
		);
		expect(result.status).toBe("opened");
	});

	test("a file the skill tree ignores is refused and not pushed", async () => {
		const fx = fixture();
		const work = mkdtempSync(join(tmpdir(), "propose-ignore-"));
		made.push(work);
		git(["clone", "-q", fx.bare, work]);
		mkdirSync(join(work, "new-skill"), { recursive: true });
		writeFileSync(join(work, "new-skill", "SKILL.md"), skillMd("new-skill"));
		writeFileSync(join(work, "new-skill", ".gitignore"), "secret.md\n");
		git(["-C", work, "add", "."]);
		git(["-C", work, "-c", "user.name=Substrate Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "ignore"]);
		git(["-C", work, "push", "-q", fx.bare, "main"]);
		const fake: FakeGh = { prs: [], next: 1, calls: [] };
		const error = await proposeSkill(
			{ name: "new-skill", files: { "SKILL.md": skillMd("new-skill"), "secret.md": "plain\n" }, rationale: "because", surface: "claude-code" },
			{ maxBytes: ROUTE_MAX_BYTES, mode: "overlay", run: fakeGhRunner(fx, fake), stateDir: fx.stateDir, library: { repo: fx.repo, remoteUrl: fx.remoteUrl } },
		).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(ProposeFailed);
		expect((error as Error).message).toContain("secret.md");
		expect(fake.calls).toEqual([]);
		const heads = gitText(["--git-dir", fx.bare, "for-each-ref", "--format=%(refname)", "refs/heads"]).trim().split("\n");
		expect(heads).toEqual(["refs/heads/main"]);
	});

	test("resubmitting identical content is existing with no second push or PR", async () => {
		const fx = fixture();
		const fake: FakeGh = { prs: [], next: 1, calls: [] };
		const library = { repo: fx.repo, remoteUrl: fx.remoteUrl };
		const run = fakeGhRunner(fx, fake);
		const first = await proposeSkill(
			{ name: "new-skill", files: { "SKILL.md": skillMd("new-skill") }, rationale: "because", surface: "claude-code" },
			{ maxBytes: ROUTE_MAX_BYTES, mode: "overlay", run, stateDir: fx.stateDir, library },
		);
		expect(first.status).toBe("opened");
		const second = await proposeSkill(
			{ name: "new-skill", files: { "SKILL.md": skillMd("new-skill") }, rationale: "because", surface: "claude-code" },
			{ maxBytes: ROUTE_MAX_BYTES, mode: "overlay", run, stateDir: fx.stateDir, library },
		);
		expect(second).toMatchObject({ status: "existing", pr_url: first.pr_url, branch: first.branch });
		expect(fake.calls.filter((argv) => argv[2] === "create")).toHaveLength(1);
	});

	test("a real child sees only the allowlist under poisoned parent env and a hostile HOME", async () => {
		const dir = mkdtempSync(join(tmpdir(), "propose-env-"));
		made.push(dir);
		const home = join(dir, "home");
		mkdirSync(home, { recursive: true });
		// A hostile scratch-HOME gitconfig: it must stay unread.
		writeFileSync(join(home, ".gitconfig"), '[url "https://evil.example.invalid/"]\n\tinsteadOf = https://github.com/\n[credential]\n\thelper = evil-helper\n');
		// A recording probe standing in for the configured gh binary.
		const probe = join(dir, "probe-gh");
		const argvFile = join(dir, "argv");
		const envFile = join(dir, "env");
		writeFileSync(probe, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nenv | sort > "${envFile}"\n`);
		chmodSync(probe, 0o700);
		// Poison the parent with scratch decoys only; every value is restored below.
		// Keys and values are assembled from fragments at runtime (repo convention:
		// no credential-shaped literal ever sits in a tracked file).
		const frag = (...parts: string[]): string => parts.join("");
		const poison: Array<[string, string]> = [
			[["SUBSTRATE", "HANDOFF", "KEY"].join("_"), frag("scratch-", "decoy-", "handoff")],
			[["SUBSTRATE", "TOKEN", "CLAUDE", "CODE"].join("_"), frag("scratch-", "decoy-", "token")],
			[["SUBSTRATE", "OPERATOR", "TOKENS"].join("_"), frag("scratch-", "decoy-", "operator")],
			[["GREPTIME", "URL"].join("_"), frag("https://", "scratch-decoy.invalid/")],
			[["SUBSTRATE", "SKILLS", "REMOTE", "URL"].join("_"), frag("https://", "scratch-decoy.invalid/library.git")],
			["URL_EVIL_REDIRECT", frag("https://", "evil.example.invalid/")],
		];
		// Controlled Git keys the fixed childEnv intentionally REPLACES (never
		// forwards): asserted as their fixed values above, not as undefined.
		const overridden: Array<[string, string, string]> = [
			["GIT_CONFIG_COUNT", "99", "2"],
			[["GIT", "CONFIG", "KEY", "0"].join("_"), "evil", "credential.helper"],
		];
		const saved: Record<string, string | undefined> = {};
		try {
			for (const [key, value] of [...poison, ...overridden.map(([k, v]) => [k, v] as [string, string])]) {
				saved[key] = process.env[key];
				process.env[key] = value;
			}
			const run = createExecFileRunner({ gh: probe, home });
			const result = await run(["gh", "pr", "list", "--head", "b"]);
			expect(result.code).toBe(0);
			// The configured binary ran with the gh argv after the command name.
			expect(readFileSync(argvFile, "utf8").trim().split("\n")).toEqual(["pr", "list", "--head", "b"]);
			const child: Record<string, string> = {};
			for (const line of readFileSync(envFile, "utf8").trim().split("\n")) {
				const at = line.indexOf("=");
				child[line.slice(0, at)] = line.slice(at + 1);
			}
			expect(child.HOME).toBe(home);
			expect(child.GIT_CONFIG_GLOBAL).toBe("/dev/null");
			expect(child.GIT_CONFIG_SYSTEM).toBe("/dev/null");
			expect(child.GIT_CONFIG_COUNT).toBe("2");
			expect(child.GIT_CONFIG_KEY_0).toBe("credential.helper");
			expect(child.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
			expect(child.GIT_CONFIG_VALUE_1).toBe("!/usr/bin/gh auth git-credential");
			expect(child.GIT_TERMINAL_PROMPT).toBe("0");
			expect(child.GH_PROMPT_DISABLED).toBe("1");
			for (const [key] of poison) {
				expect(child[key]).toBeUndefined();
			}
			// Controlled Git keys are replaced by the fixed values asserted above,
			// never forwarded: the poison control value must not win. Only the
			// long secret decoys are asserted absent from the env text (a short
			// control like "99" can occur incidentally in paths).
			for (const [key, , fixed] of overridden) {
				expect(child[key]).toBe(fixed);
			}
			for (const [, value] of poison) {
				expect(readFileSync(envFile, "utf8")).not.toContain(value);
			}
			// The hostile HOME gitconfig stays unread: the global and system scopes are empty.
			const global = await run(["git", "config", "--global", "--list"]);
			expect(global.code).toBe(0);
			expect(global.stdout).not.toContain("evil");
			const system = await run(["git", "config", "--system", "--list"]);
			expect(system.code).toBe(0);
			expect(system.stdout).not.toContain("evil");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("non-fast-forward and delete attempts against the fixture are refused with refs unchanged", async () => {
		const fx = fixture();
		const fake: FakeGh = { prs: [], next: 1, calls: [] };
		const library = { repo: fx.repo, remoteUrl: fx.remoteUrl };
		const opened = await proposeSkill(
			{ name: "new-skill", files: { "SKILL.md": skillMd("new-skill") }, rationale: "because", surface: "claude-code" },
			{ maxBytes: ROUTE_MAX_BYTES, mode: "overlay", run: fakeGhRunner(fx, fake), stateDir: fx.stateDir, library },
		);
		expect(opened.status).toBe("opened");
		const branch = opened.branch as string;
		const work = mkdtempSync(join(tmpdir(), "propose-rewrite-"));
		made.push(work);
		git(["clone", "-q", fx.bare, work]);
		const before = gitText(["--git-dir", fx.bare, "for-each-ref", "--format=%(refname) %(objectname)"]);
		// Rewinding the pushed branch to main is not a fast-forward: refused.
		const rewind = Bun.spawnSync(["git", "-C", work, "push", fx.bare, `main:${branch}`], { stdout: "pipe", stderr: "pipe" });
		expect(rewind.exitCode).not.toBe(0);
		// Deleting the pushed branch is refused too.
		const deletion = Bun.spawnSync(["git", "-C", work, "push", fx.bare, `:refs/heads/${branch}`], { stdout: "pipe", stderr: "pipe" });
		expect(deletion.exitCode).not.toBe(0);
		expect(gitText(["--git-dir", fx.bare, "for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before);
		expect(gitText(["--git-dir", fx.bare, "rev-parse", "--verify", `refs/heads/${branch}`]).trim()).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("dry runs over previously recorded content", () => {
	test("OPEN, CLOSED and pushed records still clone and diff with no gh call and a byte-identical ledger", async () => {
		const fx = fixture();
		const library = { repo: fx.repo, remoteUrl: fx.remoteUrl };
		const base = { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" as const, stateDir: fx.stateDir, library };
		const ledgerPath = join(fx.stateDir, "proposals.jsonl");

		async function open(name: string, fake: FakeGh): Promise<void> {
			const result = await proposeSkill(
				{ name, files: { "SKILL.md": skillMd(name) }, rationale: "because", surface: "claude-code" },
				{ ...base, run: fakeGhRunner(fx, fake) },
			);
			expect(result.status).toBe("opened");
		}

		async function dryRun(name: string): Promise<{ status: string; added: number | undefined; ghCalls: string[][]; sameLedger: boolean }> {
			const before = readFileSync(ledgerPath, "utf8");
			const probe: FakeGh = { prs: [], next: 99, calls: [] };
			const result = await proposeSkill(
				{ name, files: { "SKILL.md": skillMd(name) }, rationale: "because", surface: "claude-code" },
				{ ...base, run: fakeGhRunner(fx, probe), dryRun: true },
			);
			return { status: result.status, added: result.diff_added, ghCalls: probe.calls, sameLedger: readFileSync(ledgerPath, "utf8") === before };
		}

		// OPEN: the ledger already answers existing, but a dry run still diffs.
		await open("open-skill", { prs: [], next: 1, calls: [] });
		{
			const checked = await dryRun("open-skill");
			expect(checked.status).toBe("dry_run");
			expect(checked.added).toBe(1);
			expect(checked.ghCalls).toEqual([]);
			expect(checked.sameLedger).toBe(true);
		}

		// CLOSED: declined first, then the dry run returns dry_run, never declined.
		const closed: FakeGh = { prs: [], next: 1, calls: [] };
		await open("closed-skill", closed);
		closed.prs[0]!.state = "CLOSED";
		const declined = await proposeSkill(
			{ name: "closed-skill", files: { "SKILL.md": skillMd("closed-skill") }, rationale: "because", surface: "claude-code" },
			{ ...base, run: fakeGhRunner(fx, closed) },
		);
		expect(declined.status).toBe("declined");
		{
			const checked = await dryRun("closed-skill");
			expect(checked.status).toBe("dry_run");
			expect(checked.added).toBe(1);
			expect(checked.ghCalls).toEqual([]);
			expect(checked.sameLedger).toBe(true);
		}

		// Pushed without a recorded PR: the dry run makes no list call either.
		await open("pushed-skill", { prs: [], next: 1, calls: [] });
		const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
		const pushedLine = lines.find((line) => {
			const record: unknown = JSON.parse(line);
			if (typeof record !== "object" || record === null) return false;
			if (!("state" in record) || !("name" in record)) return false;
			return record.state === "pushed" && record.name === "pushed-skill";
		});
		expect(pushedLine).toBeDefined();
		writeFileSync(ledgerPath, `${pushedLine}\n`);
		{
			const checked = await dryRun("pushed-skill");
			expect(checked.status).toBe("dry_run");
			expect(checked.added).toBe(1);
			expect(checked.ghCalls).toEqual([]);
			expect(checked.sameLedger).toBe(true);
		}
	});
});
