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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
