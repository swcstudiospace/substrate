#!/usr/bin/env bun
/**
 * substrate-skills-sync (D-04; ported D22-01): the only writer of the live library checkout.
 *
 *   bun packages/projector/src/skills-sync.ts        # run by substrate-skills-sync.timer every 5 min
 *
 * One tick: refuse a dirty tree or a branch other than main (before any fetch), `git fetch origin
 * main`, refuse a history that is not a fast-forward, else `git merge --ff-only origin/main`; then
 * the skills projector, on every tick that got that far (so a deleted link self-heals). Every
 * refusal ends the tick with one `warning` event and no merge. Log lines:
 *   [skills-sync] ff <old>..<new> | [skills-sync] current <sha> | [skills-sync] refused <reason>
 *   | [skills-sync] cleared <reason>
 * Refusals exit 0 (a policy outcome); a failed git step or an empty library exits 1.
 *
 * Phase 22 adaptations:
 * - D22-02: the dirty check runs `git status --porcelain --untracked-files=all` and ignores only
 *   untracked (`??`) paths with a `__pycache__` segment or a `.pyc` suffix — skill scripts run
 *   through the projected links write caches into the checkout repeatedly. Any other untracked
 *   path, and any tracked change (including a tracked `.pyc`), still refuses.
 * - D22-03: every refusal warning is a host-job event (surface `substrate`, actor `agent`,
 *   `payload.action` `skills.sync`, `payload.runtime` `skills-sync`, `payload.reason`, no `repo`,
 *   hourly `session_id`), mapping onto the existing `skills.sync.refused` row.
 * - D22-04: the bearer comes from Phase 20's resolver (`resolveBearer("substrate", env)` via
 *   `postWarning`); posting stays fail-open with a 3 s timeout and a refused post never changes
 *   the tick outcome.
 * - D22-05: a warned-state file under `SUBSTRATE_SKILLS_STATE` (default
 *   `/var/lib/substrate/skills/skills-sync-warned.json`) records the refusal reason, when it
 *   began and when it was last warned. A tick warns on reason change or once per UTC day while
 *   it persists; a tick that clears the refusal logs `[skills-sync] cleared <reason>` and emits
 *   nothing (a successful sync is silent). Failed git steps warn immediately and exit 1.
 * - D22-07: `libraryDir` and `warnStateFile` are context seams; `defaultSyncOptions(env)` applies
 *   `SUBSTRATE_SKILLS_LIBRARY` and `SUBSTRATE_SKILLS_STATE`, so tests run in tmp dirs and never
 *   touch `/root/agent-skills` or `/var/lib/substrate`.
 */
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { redact } from "../../mcp-server/src/redact.ts";
import {
	defaultOptions,
	hostJobWarning,
	LIBRARY_DIR,
	postWarning,
	project,
	STATE_DIR_DEFAULT,
	utcDay,
	type EmitWarning,
} from "./skills.ts";

const RUN_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 200;

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (argv: readonly string[]) => Promise<RunResult>;

/** hostfns' runner shape: execFile with an argv (never a shell), 120 s, HOME=/root, no prompts. */
export function execFileRunner(argv: readonly string[]): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	execFile(
		argv[0] as string,
		argv.slice(1),
		{
			timeout: RUN_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
			env: { ...process.env, HOME: "/root", GIT_TERMINAL_PROMPT: "0" },
		},
		(error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
		},
	);
	return promise;
}

export interface SyncFacts {
	porcelain: string;
	branch: string;
	/** `merge-base --is-ancestor HEAD origin/main`; undefined until fetched. */
	isAncestor?: boolean;
	head?: string;
	originMain?: string;
}
export type Decision = "refuse-dirty" | "refuse-branch" | "refuse-diverged" | "fetch" | "current" | "ff";

export function decide(facts: SyncFacts): Decision {
	if (facts.porcelain.trim() !== "") return "refuse-dirty";
	if (facts.branch !== "main") return "refuse-branch";
	if (facts.isAncestor === undefined) return "fetch";
	if (!facts.isAncestor) return "refuse-diverged";
	return facts.head === facts.originMain ? "current" : "ff";
}

/**
 * Strip D22-02 ignorable lines from raw `git status --porcelain --untracked-files=all` output:
 * untracked (`??`) paths with a `__pycache__` segment or a `.pyc` suffix. Everything else —
 * any other untracked path, any tracked change (including a tracked `.pyc`) — stays.
 */
export function effectivePorcelain(raw: string): string {
	const kept: string[] = [];
	for (const line of raw.split("\n")) {
		if (line === "") continue;
		if (line.startsWith("??")) {
			const path = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
			if (path.split("/").includes("__pycache__") || path.endsWith(".pyc")) continue;
		}
		kept.push(line);
	}
	return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

export interface WarnState {
	reason: string;
	beganAt: string;
	lastWarned: string;
}

function readWarnState(file: string): WarnState | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object" && typeof (parsed as WarnState).reason === "string") {
			return parsed as WarnState;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function writeWarnState(file: string, state: WarnState): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.substrate-tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

export interface SyncContext {
	runner: Runner;
	libraryDir: string;
	/** D22-05 warned-state file; tests point it at a tmp dir. */
	warnStateFile: string;
	log: (line: string) => void;
	emitWarning: EmitWarning;
	project: () => Promise<unknown>;
	/** Injectable clock so tests prove the daily cadence without waiting. */
	clock?: () => Date;
}
export interface SyncResult {
	decision: Decision | "error";
	code: number;
}

export async function runSync(ctx: SyncContext): Promise<SyncResult> {
	const now = (ctx.clock ?? (() => new Date()))();
	const git = (...args: string[]) => ctx.runner(["git", "-C", ctx.libraryDir, ...args]);
	const warn = async (reason: string, detail?: RunResult): Promise<boolean> => {
		const tail = detail ? `: ${redact(`${detail.stdout}${detail.stderr}`.trim()).slice(-OUTPUT_TAIL_CHARS)}` : "";
		ctx.log(`[skills-sync] refused ${reason}${tail}`);
		return ctx.emitWarning(
			hostJobWarning(reason, `skills sync refused: ${reason}`, { component: "skills-sync" }, now),
		);
	};
	/** D22-05: warn on reason change or once per UTC day while the refusal persists. */
	const refusePolicy = async (reason: string): Promise<void> => {
		const day = utcDay(now);
		const prior = readWarnState(ctx.warnStateFile);
		if (prior && prior.reason === reason && prior.lastWarned.slice(0, 10) === day) {
			ctx.log(`[skills-sync] refused ${reason} (already warned ${prior.lastWarned.slice(0, 10)})`);
			return;
		}
		if (!(await warn(reason))) return;
		writeWarnState(ctx.warnStateFile, {
			reason,
			beganAt: prior && prior.reason === reason ? prior.beganAt : now.toISOString(),
			lastWarned: now.toISOString(),
		});
	};
	const failed = async (reason: string, result: RunResult): Promise<SyncResult> => {
		await warn(reason, result);
		return { decision: "error", code: 1 };
	};

	const status = await git("status", "--porcelain", "--untracked-files=all");
	if (status.code !== 0) return failed("status-failed", status);
	const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
	if (branch.code !== 0) return failed("branch-failed", branch);
	const local = { porcelain: effectivePorcelain(status.stdout), branch: branch.stdout.trim() };
	const early = decide(local);
	if (early === "refuse-dirty" || early === "refuse-branch") {
		await refusePolicy(early === "refuse-dirty" ? "dirty" : "branch");
		return { decision: early, code: 0 };
	}

	const fetched = await git("fetch", "origin", "main");
	if (fetched.code !== 0) return failed("fetch-failed", fetched);
	const ancestor = await git("merge-base", "--is-ancestor", "HEAD", "origin/main");
	if (ancestor.code !== 0 && ancestor.code !== 1) return failed("merge-base-failed", ancestor);
	const revs = await git("rev-parse", "HEAD", "origin/main");
	const [head, originMain] = revs.stdout.trim().split("\n");
	if (revs.code !== 0 || !head || !originMain) return failed("rev-parse-failed", revs);

	const decision = decide({ ...local, isAncestor: ancestor.code === 0, head, originMain });
	if (decision === "refuse-diverged") {
		await refusePolicy("diverged");
		return { decision, code: 0 };
	}
	if (decision === "ff") {
		const merged = await git("merge", "--ff-only", "origin/main");
		if (merged.code !== 0) return failed("merge-failed", merged);
		ctx.log(`[skills-sync] ff ${head}..${originMain}`);
	} else {
		ctx.log(`[skills-sync] current ${head}`);
	}
	try {
		await ctx.project();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const reason = /no library skills/.test(message) ? "empty-library" : "project-failed";
		await warn(reason);
		return { decision: "error", code: 1 };
	}
	const prior = readWarnState(ctx.warnStateFile);
	if (prior !== undefined) {
		rmSync(ctx.warnStateFile, { force: true });
		ctx.log(`[skills-sync] cleared ${prior.reason}`);
	}
	return { decision, code: 0 };
}

export interface SyncOptions {
	libraryDir: string;
	warnStateFile: string;
}

/** D22-07 seams: `SUBSTRATE_SKILLS_LIBRARY` moves the checkout, `SUBSTRATE_SKILLS_STATE` the warned file. */
export function defaultSyncOptions(env: Record<string, string | undefined> = process.env): SyncOptions {
	const stateDir = env.SUBSTRATE_SKILLS_STATE?.trim() || STATE_DIR_DEFAULT;
	return {
		libraryDir: env.SUBSTRATE_SKILLS_LIBRARY?.trim() || LIBRARY_DIR,
		warnStateFile: `${stateDir}/skills-sync-warned.json`,
	};
}

if (import.meta.main) {
	const opts = defaultSyncOptions();
	const log = (line: string) => process.stdout.write(`${line}\n`);
	const result = await runSync({
		runner: execFileRunner,
		libraryDir: opts.libraryDir,
		warnStateFile: opts.warnStateFile,
		log,
		emitWarning: postWarning,
		project: () => project(defaultOptions()),
	});
	process.exit(result.code);
}
