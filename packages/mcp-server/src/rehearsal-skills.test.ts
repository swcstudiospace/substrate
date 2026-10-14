/**
 * The skills fixture and the recording `gh`.
 *
 * `fakeGh` is pure and is covered on literals. The builder runs real `git` on a throwaway
 * repository inside a temporary run directory, and the installed script is spawned the way
 * the engine spawns `gh`: with an allowlisted environment and nothing else.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_STATE, fakeGh, fakeGhScript, readState, runFakeGh, writeState, type FakeGhState } from "./rehearsal-fake-gh.ts";
import { FIXTURE_REPO, SEED_SKILL, buildSkillsFixture, removeSkillsFixture, skillsPaths } from "./rehearsal-skills.ts";

const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const tempRun = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "substrate-skills-fixture-"));
	made.push(dir);
	return dir;
};
const freshState = (): FakeGhState => ({ ...EMPTY_STATE, prs: [], calls: [] });

const createArgv = (head: string, repo = FIXTURE_REPO) => ["pr", "create", "--repo", repo, "--head", head, "--base", "main", "--title", "skill(x): proposal", "--body", "b"];

describe("fakeGh", () => {
	test("pr create numbers the PRs and answers a URL under the library's slug", () => {
		const state = freshState();
		const first = fakeGh(createArgv("skill/omp/a-1-abcd"), state);
		const second = fakeGh(createArgv("skill/omp/b-2-abcd"), state);

		expect(first).toEqual({ code: 0, stdout: `https://github.com/${FIXTURE_REPO}/pull/1\n`, stderr: "" });
		expect(second.stdout).toBe(`https://github.com/${FIXTURE_REPO}/pull/2\n`);
		expect(state.prs.map((pr) => [pr.number, pr.head, pr.state, pr.base])).toEqual([
			[1, "skill/omp/a-1-abcd", "OPEN", "main"],
			[2, "skill/omp/b-2-abcd", "OPEN", "main"],
		]);
	});

	test("pr view answers the state, url and number the engine asks for, and 1 for an unknown PR", () => {
		const state = freshState();
		fakeGh(createArgv("h"), state);
		const url = `https://github.com/${FIXTURE_REPO}/pull/1`;

		const view = fakeGh(["pr", "view", url, "--json", "state,url,number"], state);
		expect(view.code).toBe(0);
		expect(JSON.parse(view.stdout)).toEqual({ state: "OPEN", url, number: 1 });

		state.prs[0]!.state = "CLOSED";
		expect(JSON.parse(fakeGh(["pr", "view", url, "--json", "state,url,number"], state).stdout).state).toBe("CLOSED");

		const missing = fakeGh(["pr", "view", `https://github.com/${FIXTURE_REPO}/pull/99`], state);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("no pull requests found");
	});

	test("pr list answers only the open PRs for that head in that library", () => {
		const state = freshState();
		fakeGh(createArgv("skill/omp/a-1-abcd"), state);
		state.prs[0]!.state = "CLOSED";
		fakeGh(createArgv("skill/omp/a-1-abcd"), state);
		fakeGh(createArgv("skill/omp/other"), state);
		fakeGh(createArgv("skill/omp/a-1-abcd", "someone/else"), state);

		const listed = fakeGh(["pr", "list", "--repo", FIXTURE_REPO, "--head", "skill/omp/a-1-abcd", "--state", "open", "--json", "url,number"], state);
		expect(JSON.parse(listed.stdout)).toEqual([{ url: `https://github.com/${FIXTURE_REPO}/pull/2`, number: 2, state: "OPEN" }]);
		expect(JSON.parse(fakeGh(["pr", "list", "--repo", FIXTURE_REPO, "--head", "nope"], state).stdout)).toEqual([]);
	});

	test("a second open pull request for the same head and base is refused", () => {
		const state = freshState();
		expect(fakeGh(createArgv("skill/omp/a-1-abcd"), state).code).toBe(0);
		const again = fakeGh(createArgv("skill/omp/a-1-abcd"), state);
		expect(again.code).toBe(1);
		expect(again.stderr).toContain("already exists");
		expect(state.prs).toHaveLength(1);
		expect(state.next).toBe(2);
	});

	test("every invocation is recorded first, the unsupported ones included", () => {
		const state = freshState();
		fakeGh(createArgv("h"), state);
		fakeGh(["api", "user"], state);
		fakeGh(["pr", "merge", "1"], state);
		expect(state.calls.map((argv) => argv.slice(0, 2).join(" "))).toEqual(["pr create", "api user", "pr merge"]);
	});

	test("anything but the three questions is refused with exit 2, never answered", () => {
		for (const argv of [["api", "user"], ["auth", "status"], ["pr", "merge", "1"], ["pr", "close", "1"], [], ["pr"]]) {
			const result = fakeGh(argv, freshState());
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("fake gh");
		}
	});

	test("an ownerless lock older than the bound is reclaimed", () => {
		const run = tempRun();
		const statePath = join(run, "gh-state.json");
		writeState(statePath, { next: 1, prs: [], calls: [] });
		const lock = `${statePath}.lock`;
		mkdirSync(lock);
		const old = new Date(Date.now() - 10_000);
		utimesSync(lock, old, old);
		expect(runFakeGh(createArgv("skill/omp/a-1-abcd"), statePath)).toBe(0);
		expect(existsSync(lock)).toBe(false);
		expect(readState(statePath).next).toBe(2);
	});
	test("concurrent children recovering one ownerless lock serialize, each with its own PR", async () => {
		const run = tempRun();
		const statePath = join(run, "gh-state.json");
		writeState(statePath, { next: 1, prs: [], calls: [] });
		const lock = `${statePath}.lock`;
		mkdirSync(lock);
		const old = new Date(Date.now() - 10_000);
		utimesSync(lock, old, old);
		const modulePath = join(import.meta.dir, "rehearsal-fake-gh.ts");
		const driver = join(run, "driver.ts");
		writeFileSync(
			driver,
			`import { runFakeGh } from ${JSON.stringify(modulePath)};\n` +
				`process.exit(runFakeGh(["pr", "create", "--repo", ${JSON.stringify(FIXTURE_REPO)}, "--head", process.argv[2] ?? "", "--base", "main", "--title", "skill(x): proposal", "--body", "b"], ${JSON.stringify(statePath)}));\n`,
		);
		const count = 8;
		const procs = Array.from({ length: count }, (_, i) =>
			Bun.spawn(["bun", driver, `skill/omp/c-${i}-abcd`], {
				env: { PATH: process.env.PATH ?? "", HOME: run },
				stdout: "ignore",
				stderr: "pipe",
			}),
		);
		const codes = await Promise.all(procs.map((proc) => proc.exited));
		const errors = (await Promise.all(procs.map((proc) => new Response(proc.stderr).text()))).filter((text) => text.length > 0);
		expect(`${codes}:${errors}`).toBe(`${Array(count).fill(0)}:`);
		const final = readState(statePath);
		expect(final.next).toBe(count + 1);
		expect(final.prs).toHaveLength(count);
		expect(new Set(final.prs.map((pr) => pr.number)).size).toBe(count);
		expect(existsSync(lock)).toBe(false);
	});

	test("pr create and pr list refuse missing arguments instead of guessing", () => {
		expect(fakeGh(["pr", "create", "--repo", FIXTURE_REPO], freshState()).code).toBe(2);
		expect(fakeGh(["pr", "list", "--repo", FIXTURE_REPO], freshState()).code).toBe(2);
	});
});

describe("the installed gh script", () => {
	test("answers as a child with an allowlisted environment, keeping the state in its file", () => {
		const run = tempRun();
		const fixture = buildSkillsFixture(run);
		const env = { PATH: process.env.PATH ?? "", HOME: run, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
		const gh = (...argv: string[]) => Bun.spawnSync([fixture.gh, ...argv], { env });
		const ref = Bun.spawnSync(["git", "--git-dir", fixture.origin, "update-ref", "refs/heads/skill/omp/a-1-abcd", "refs/heads/main"], { env });
		expect(ref.exitCode).toBe(0);

		const created = gh(...createArgv("skill/omp/a-1-abcd"));
		expect(created.exitCode).toBe(0);
		expect(created.stdout.toString()).toBe(`https://github.com/${FIXTURE_REPO}/pull/1\n`);

		const viewed = gh("pr", "view", `https://github.com/${FIXTURE_REPO}/pull/1`, "--json", "state,url,number");
		expect(JSON.parse(viewed.stdout.toString()).state).toBe("OPEN");

		expect(gh("api", "user").exitCode).toBe(2);
		const state = readState(fixture.ghState);
		expect(state.prs).toHaveLength(1);
		expect(state.calls).toHaveLength(3);
	});

	test("is a bun script with this module and its own state path baked in", () => {
		const script = fakeGhScript({ bun: "/usr/bin/bun", statePath: "/run/x/gh-state.json" });
		expect(script.split("\n")[0]).toBe("#!/bin/sh");
		expect(script).toContain("--no-env-file");
		expect(script).toContain('"/run/x/gh-state.json"');
		expect(script).toContain("rehearsal-fake-gh.ts");
	});

	test("two concurrent creates do not share a pull request number", async () => {
		const run = tempRun();
		const fixture = buildSkillsFixture(run);
		const env = { PATH: process.env.PATH ?? "", HOME: run, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
		for (const head of ["a", "b"]) {
			const ref = Bun.spawnSync(["git", "--git-dir", fixture.origin, "update-ref", `refs/heads/${head}`, "refs/heads/main"], { env });
			expect(ref.exitCode).toBe(0);
		}
		const spawn = (head: string) => Bun.spawn([fixture.gh, ...createArgv(head)], { env, stdout: "pipe", stderr: "pipe" });
		const first = spawn("a");
		const second = spawn("b");
		const [left, right, leftCode, rightCode] = await Promise.all([
			new Response(first.stdout).text(),
			new Response(second.stdout).text(),
			first.exited,
			second.exited,
		]);
		expect(leftCode).toBe(0);
		expect(rightCode).toBe(0);
		expect(new Set([left.trim(), right.trim()]).size).toBe(2);
		expect(readState(fixture.ghState).prs).toHaveLength(2);
	});

	test("refuses a head that was never pushed", () => {
		const run = tempRun();
		const fixture = buildSkillsFixture(run);
		const env = { PATH: process.env.PATH ?? "", HOME: run, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
		const gh = (...argv: string[]) => Bun.spawnSync([fixture.gh, ...argv], { env });
		const missing = gh(...createArgv("skill/omp/missing"));
		expect(missing.exitCode).toBe(1);
		expect(missing.stderr.toString()).toContain("does not exist");
		expect(readState(fixture.ghState).prs).toEqual([]);
	});
});

describe("buildSkillsFixture", () => {
	test("builds a bare library seeded on main, a one-branch mirror, and a recording gh", () => {
		const run = tempRun();
		const fixture = buildSkillsFixture(run);
		const git = (cwd: string, ...args: string[]) =>
			Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: run, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).stdout.toString().trim();

		expect(fixture.origin).toBe(join(run, "skills-fixture", `${FIXTURE_REPO}.git`));
		expect(git(fixture.origin, "rev-parse", "--is-bare-repository")).toBe("true");
		expect(git(fixture.origin, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual([`${SEED_SKILL}/NOTES.md`, `${SEED_SKILL}/SKILL.md`]);
		expect(git(fixture.origin, "show", `main:${SEED_SKILL}/SKILL.md`)).toContain(`name: ${SEED_SKILL}`);

		// It refuses rewrites and deletions and logs every ref update.
		expect(git(fixture.origin, "config", "receive.denyNonFastForwards")).toBe("true");
		expect(git(fixture.origin, "config", "receive.denyDeletes")).toBe("true");
		expect(git(fixture.origin, "config", "core.logAllRefUpdates")).toBe("true");

		// The mirror fetches main and only main, and starts at the library's main.
		const mirror = join(fixture.state, "mirror.git");
		expect(git(mirror, "config", "remote.origin.fetch")).toBe("+refs/heads/main:refs/heads/main");
		expect(git(mirror, "rev-parse", "main")).toBe(git(fixture.origin, "rev-parse", "main"));

		// The gh is an executable only its owner may run, and starts with no PRs.
		expect(statSync(fixture.gh).mode & 0o777).toBe(0o700);
		expect(readState(fixture.ghState)).toEqual({ next: 1, prs: [], calls: [], repo: FIXTURE_REPO, origin: fixture.origin });
	});

	test("names exactly the four server settings, all inside the run directory", () => {
		const run = tempRun();
		const fixture = buildSkillsFixture(run);
		expect(Object.keys(fixture.env).sort()).toEqual(["SUBSTRATE_SKILLS_GH", "SUBSTRATE_SKILLS_REMOTE_URL", "SUBSTRATE_SKILLS_REPO", "SUBSTRATE_SKILLS_STATE"]);
		expect(fixture.env.SUBSTRATE_SKILLS_STATE).toBe(join(run, "skills"));
		expect(fixture.env.SUBSTRATE_SKILLS_REMOTE_URL).toBe(`file://${fixture.origin}`);
		expect(fixture.env.SUBSTRATE_SKILLS_REPO).toBe(FIXTURE_REPO);
		for (const value of [fixture.env.SUBSTRATE_SKILLS_STATE, fixture.env.SUBSTRATE_SKILLS_GH, fixture.origin]) expect(value.startsWith(`${run}/`)).toBe(true);
	});

	test("is deleted and rebuilt each time, so a crashed up cannot leave a proposal behind", () => {
		const run = tempRun();
		const first = buildSkillsFixture(run);
		writeFileSync(join(first.state, "proposals.jsonl"), '{"stale":true}\n');
		writeFileSync(join(run, "skills-fixture", "marker"), "left over");
		const second = buildSkillsFixture(run);

		expect(existsSync(join(second.state, "proposals.jsonl"))).toBe(false);
		expect(existsSync(join(run, "skills-fixture", "marker"))).toBe(false);
		expect(existsSync(join(second.state, "mirror.git", "HEAD"))).toBe(true);
	});

	test("leaves no seed working tree behind", () => {
		const run = tempRun();
		buildSkillsFixture(run);
		const entries = Bun.spawnSync(["ls", join(run, "skills-fixture")]).stdout.toString().split("\n").filter(Boolean);
		expect(entries.sort()).toEqual(["gh", "gh-state.json", "rehearsal"]);
	});

	test("refuses a run directory that is not absolute", () => {
		expect(() => buildSkillsFixture("relative/run")).toThrow("not absolute");
		expect(() => skillsPaths("relative/run")).toThrow("not absolute");
	});

	test("removeSkillsFixture removes both directories and is fine when they are gone", () => {
		const run = tempRun();
		buildSkillsFixture(run);
		removeSkillsFixture(run);
		expect(existsSync(join(run, "skills"))).toBe(false);
		expect(existsSync(join(run, "skills-fixture"))).toBe(false);
		removeSkillsFixture(run);
	});

	test("the seeded library is a real proposer target: the engine's origin check accepts its URL", async () => {
		const { originMatches } = await import("./skills/propose.ts");
		const run = tempRun();
		const fixture = buildSkillsFixture(run);
		expect(originMatches(fixture.env.SUBSTRATE_SKILLS_REMOTE_URL, FIXTURE_REPO)).toBe(true);
		expect(originMatches(fixture.env.SUBSTRATE_SKILLS_REMOTE_URL, "swcstudiospace/agent-skills")).toBe(false);
		// The library is not a real owner, so a mistaken real `gh` call would find nothing to touch.
		expect(FIXTURE_REPO.startsWith("rehearsal/")).toBe(true);
		expect(lstatSync(fixture.origin).isDirectory()).toBe(true);
		expect(readFileSync(join(fixture.origin, "HEAD"), "utf8")).toContain("refs/heads/main");
	});
});
