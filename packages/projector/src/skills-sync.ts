#!/usr/bin/env bun
/**
 * substrate-skills-sync (D-04): the only writer of the live library checkout.
 *
 *   bun packages/projector/src/skills-sync.ts        # run by substrate-skills-sync.timer every 5 min
 *
 * One tick: refuse a dirty tree or a branch other than main (before any fetch), `git fetch origin
 * main`, refuse a history that is not a fast-forward, else `git merge --ff-only origin/main`; then
 * the skills projector, on every tick that got that far (so a deleted link self-heals). Every
 * refusal ends the tick with one `warning` event and no merge. Log lines:
 *   [skills-sync] ff <old>..<new> | [skills-sync] current <sha> | [skills-sync] refused <reason>
 * Refusals exit 0 (a policy outcome); a failed git step exits 1.
 */
import { execFile } from "node:child_process";
import { redact } from "../../mcp-server/src/redact.ts";
import { defaultOptions, type EmitWarning, LIBRARY_DIR, postWarning, project } from "./skills.ts";
import { refreshLibraryCorpus, type RefreshOutcome } from "./corpus-refresh.ts";

const RUN_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 200;

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (argv: readonly string[]) => Promise<RunResult>;

/**
 * The only environment a git child receives (D22-03): PATH, HOME (inherited,
 * /root when unset for gh's stored credential), and the two no-prompt flags.
 * Never process.env wholesale — store URLs, surface tokens and the handoff
 * key cannot reach a git child. Pinned by the allowlist test.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	return {
		PATH: env.PATH ?? "/usr/bin:/bin",
		HOME: env.HOME ?? "/root",
		GIT_TERMINAL_PROMPT: "0",
		GH_PROMPT_DISABLED: "1",
	};
}

/** hostfns' runner shape: execFile with an argv (never a shell), 120 s, allowlisted env, no prompts. */
export function execFileRunner(argv: readonly string[]): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	execFile(
		argv[0] as string,
		argv.slice(1),
		{
			timeout: RUN_TIMEOUT_MS,
			maxBuffer: 4 * 1024 * 1024,
			encoding: "utf8",
			env: childEnv(),
		},
		(error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
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

export interface SyncContext {
	runner: Runner;
	libraryDir: string;
	log: (line: string) => void;
	emitWarning: EmitWarning;
	project: () => Promise<unknown>;
	/**
	 * Post the fast-forward corpus to the substrate. The default collects
	 * the library checkout and posts `docs_ingest`; tests inject a stub.
	 * Absent on ticks the harness never fast-forwards — which is every
	 * refusal and every already-current tick.
	 */
	refresh?: (commit: string) => Promise<RefreshOutcome>;
}
export interface SyncResult {
	decision: Decision | "error";
	code: number;
}

export async function runSync(ctx: SyncContext): Promise<SyncResult> {
	const git = (...args: string[]) => ctx.runner(["git", "-C", ctx.libraryDir, ...args]);
	const refuse = async (reason: string, detail?: RunResult): Promise<void> => {
		const tail = detail ? `: ${redact(`${detail.stdout}${detail.stderr}`.trim()).slice(-OUTPUT_TAIL_CHARS)}` : "";
		ctx.log(`[skills-sync] refused ${reason}${tail}`);
		await ctx.emitWarning({
			surface: "substrate",
			kind: "warning",
			actor: "agent",
			summary: `skills sync refused: ${reason}`,
			payload: { action: "skills.sync", runtime: "skills-sync", reason },
		});
	};
	const failed = async (reason: string, result: RunResult): Promise<SyncResult> => {
		await refuse(reason, result);
		return { decision: "error", code: 1 };
	};

	const status = await git("status", "--porcelain");
	if (status.code !== 0) return failed("status-failed", status);
	const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
	if (branch.code !== 0) return failed("branch-failed", branch);
	const local = { porcelain: status.stdout, branch: branch.stdout.trim() };
	const early = decide(local);
	if (early === "refuse-dirty" || early === "refuse-branch") {
		await refuse(early === "refuse-dirty" ? "dirty" : "branch");
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
		await refuse("diverged");
		return { decision, code: 0 };
	}
	if (decision === "ff") {
		const merged = await git("merge", "--ff-only", "origin/main");
		if (merged.code !== 0) return failed("merge-failed", merged);
		ctx.log(`[skills-sync] ff ${head}..${originMain}`);
	} else {
		ctx.log(`[skills-sync] current ${head}`);
	}
	await ctx.project();
	if (decision === "ff") {
		// The refresh runs after the projection, so a failed refresh never
		// blocks or rolls back the links; it only stays visible. Ticks
		// without a fast-forward post nothing.
		const refresh = ctx.refresh ?? ((commit: string) => refreshLibraryCorpus({ libraryDir: ctx.libraryDir, commit, runGit: (args) => ctx.runner(["git", "-C", ctx.libraryDir, ...args]) }));
		const refreshed = await refresh(originMain);
		if (refreshed.ok) {
			ctx.log(`[skills-sync] refreshed ${originMain} (${refreshed.stored} page(s))`);
		} else {
			ctx.log(`[skills-sync] refresh failed: ${refreshed.reason}`);
			await ctx.emitWarning({
				surface: "substrate",
				kind: "warning",
				actor: "agent",
				summary: `skills sync refresh failed: ${refreshed.reason}`,
				payload: { action: "skills.sync", runtime: "skills-sync", reason: "refresh-failed", detail: refreshed.reason },
			});
		}
	}
	return { decision, code: 0 };
}

if (import.meta.main) {
	const log = (line: string) => process.stdout.write(`${line}\n`);
	const result = await runSync({
		runner: execFileRunner,
		libraryDir: LIBRARY_DIR,
		log,
		emitWarning: postWarning,
		project: () => project(defaultOptions()),
	});
	process.exit(result.code);
}
