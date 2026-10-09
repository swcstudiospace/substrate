/**
 * The skills fixture for the rehearsal harness (D21-21): everything `skills_propose` touches,
 * built inside one instance's run directory.
 *
 *   <run>/skills-fixture/rehearsal/agent-skills.git                 the "library": a bare
 *       repository seeded with one skill on `main`, refusing history rewrites and deletions
 *       and logging every ref update, so a proof can show a push was never a force-push
 *   <run>/skills-fixture/gh, gh-state.json                           the recording `gh` and its state
 *   <run>/skills/mirror.git                                           the proposer's bare mirror,
 *       fetching `main` only, as production's does
 *
 * `git` runs for real, on a throwaway repository, with the user's and the system's git
 * configuration switched off. Nothing here names a host, a token or a production path, and
 * the builder refuses a run directory that is not absolute or whose derived paths would
 * leave it. The fixture and the state are deleted and rebuilt on every call, so a crashed
 * `up` can never make the next proof answer `existing`.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FIXTURE_ENV_KEYS } from "./rehearsal-env.ts";
import { EMPTY_STATE, fakeGhScript, writeState } from "./rehearsal-fake-gh.ts";

/** The library slug the fixture answers to: what `SUBSTRATE_SKILLS_REPO` is set to and the fake PR URLs carry. */
export const FIXTURE_REPO = "rehearsal/agent-skills";

/** The skill the library starts with, so a proposal is always an overlay on something real. */
export const SEED_SKILL = "seed-skill";

export interface SkillsFixture {
	/** What the scratch server is started with, in addition to its usual environment. */
	env: Record<(typeof FIXTURE_ENV_KEYS)[number], string>;
	/** The proposer's state directory (`mirror.git`, `proposals.jsonl`, locks, clones). */
	state: string;
	/** The bare library repository the branches are pushed to. */
	origin: string;
	/** The recording `gh` and its JSON state file. */
	gh: string;
	ghState: string;
	repo: string;
}

/** The directories an instance's skills state and fixture live in, and the refusal for a run directory that cannot hold them. */
export function skillsPaths(runDir: string): { state: string; fixture: string } {
	if (!isAbsolute(runDir)) throw new Error(`skills fixture refused: run directory ${runDir} is not absolute`);
	const state = join(runDir, "skills");
	const fixture = join(runDir, "skills-fixture");
	for (const path of [state, fixture]) {
		const inside = relative(resolve(runDir), resolve(path));
		if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`skills fixture refused: ${path} is outside the run directory`);
	}
	return { state, fixture };
}

/** `git` against the throwaway repositories only: no user or system configuration, no prompts, HOME inside the run. */
function git(runDir: string, args: string[], cwd?: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			PATH: process.env.PATH ?? "",
			HOME: runDir,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
}

const AUTHOR = ["-c", "user.name=rehearsal", "-c", "user.email=rehearsal@localhost"];

/** Delete and rebuild the fixture and the proposer's state inside `runDir`. */
export function buildSkillsFixture(runDir: string): SkillsFixture {
	const { state, fixture } = skillsPaths(runDir);
	rmSync(state, { recursive: true, force: true });
	rmSync(fixture, { recursive: true, force: true });
	mkdirSync(state, { recursive: true, mode: 0o700 });
	mkdirSync(fixture, { recursive: true, mode: 0o700 });

	const origin = join(fixture, `${FIXTURE_REPO}.git`);
	mkdirSync(origin, { recursive: true });
	git(runDir, ["init", "--bare", "-q", "-b", "main", origin]);
	// Any history rewrite or deletion the proposer attempted would be refused, and every ref update is logged.
	git(runDir, ["config", "receive.denyNonFastForwards", "true"], origin);
	git(runDir, ["config", "receive.denyDeletes", "true"], origin);
	git(runDir, ["config", "core.logAllRefUpdates", "true"], origin);

	const work = mkdtempSync(join(fixture, "seed-"));
	try {
		git(runDir, ["init", "-q", "-b", "main"], work);
		mkdirSync(join(work, SEED_SKILL), { recursive: true });
		writeFileSync(
			join(work, SEED_SKILL, "SKILL.md"),
			`---\nname: ${SEED_SKILL}\ndescription: The skill the rehearsal library starts with.\n---\n\nSeed content.\n`,
		);
		writeFileSync(join(work, SEED_SKILL, "NOTES.md"), "Notes that a proposal overlays and does not delete.\n");
		git(runDir, ["add", "-A"], work);
		git(runDir, [...AUTHOR, "commit", "-q", "-m", "seed the rehearsal library"], work);
		git(runDir, ["push", "-q", origin, "main"], work);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}

	// The proposer's mirror, as production keeps it: a bare clone that fetches `main` and nothing else.
	const mirror = join(state, "mirror.git");
	git(runDir, ["clone", "-q", "--bare", `file://${origin}`, mirror]);
	git(runDir, ["config", "remote.origin.fetch", "+refs/heads/main:refs/heads/main"], mirror);

	const gh = join(fixture, "gh");
	const ghState = join(fixture, "gh-state.json");
	writeFileSync(gh, fakeGhScript({ bun: process.execPath, statePath: ghState }), { mode: 0o700 });
	chmodSync(gh, 0o700);
	writeState(ghState, { ...EMPTY_STATE, prs: [], calls: [], repo: FIXTURE_REPO, origin });

	return {
		env: {
			SUBSTRATE_SKILLS_STATE: state,
			SUBSTRATE_SKILLS_REPO: FIXTURE_REPO,
			SUBSTRATE_SKILLS_REMOTE_URL: `file://${origin}`,
			SUBSTRATE_SKILLS_GH: gh,
		},
		state,
		origin,
		gh,
		ghState,
		repo: FIXTURE_REPO,
	};
}

/** Remove the fixture and the state. A run directory that is gone already is fine. */
export function removeSkillsFixture(runDir: string): void {
	const { state, fixture } = skillsPaths(runDir);
	rmSync(state, { recursive: true, force: true });
	rmSync(fixture, { recursive: true, force: true });
	if (existsSync(state) || existsSync(fixture)) throw new Error("skills fixture could not be removed");
}
