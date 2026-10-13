#!/usr/bin/env bun
/**
 * substrate-skills-sync (D-04): the only writer of the live library checkout.
 *
 *   bun packages/projector/src/skills-sync.ts        # run by substrate-skills-sync.timer every 5 min
 *
 * One tick: refuse a dirty tree or a branch other than main (before any fetch), `git fetch origin
 * main`, refuse a history that is not a fast-forward, else `git merge --ff-only origin/main`; then
 * the skills projector, on every tick that got that far (so a deleted link self-heals). Every
 * healthy tick then fires the `agent-skills` dataset refresh — one bounded loopback POST to the
 * substrate's `/docs/merge-trigger` with the projector's surface token: after a fast-forward with
 * the new head and tree hash, else whatever an earlier tick left pending. A refresh that could not
 * be delivered stays pending in `/var/lib/substrate/skills/refresh-pending.json` and is retried on
 * later ticks until one succeeds — a new fast-forward supersedes it. A refresh failure is one
 * stderr line and the tick still exits 0 (sync success never depends on ingest). Every refusal
 * ends the tick with one `warning` event and no merge. Log lines:
 *   [skills-sync] ff <old>..<new> | [skills-sync] current <sha> | [skills-sync] refused <reason>
 * Refusals exit 0 (a policy outcome); a failed git step exits 1.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "../../mcp-server/src/redact.ts";
import { defaultOptions, type EmitWarning, LIBRARY_DIR, postWarning, project } from "./skills.ts";

const RUN_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 200;
/** The dataset a skills-sync fast-forward refreshes (the substrate's DATASET_TRIGGERS row). */
export const SYNC_REFRESH_DATASET = "agent-skills";
/** Same budget family as the projector's fail-open POST /events. */
const REFRESH_TIMEOUT_MS = 3_000;

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (argv: readonly string[]) => Promise<RunResult>;

/** The substrate's merge-trigger door, with the projector's own surface token. */
export interface RefreshTarget {
	url: string;
	token: string;
}

/**
 * Where the refresh POST goes, or null when the projector holds no surface
 * token. The route is surface-token gated, so a tokenless POST could only
 * ever be refused — unset means off, and the tick stays silent instead of
 * guaranteeing itself a 401 every five minutes (the null-block idiom).
 */
export function refreshTarget(env: NodeJS.ProcessEnv = process.env): RefreshTarget | null {
	// The shipped unit carries SUBSTRATE_TOKEN_SUBSTRATE — the surface's own
	// name; the bare SUBSTRATE_TOKEN is the generic spelling some deployments
	// still hold. The surface token wins, then the generic one, else the
	// trigger stays off.
	const token = env.SUBSTRATE_TOKEN_SUBSTRATE?.trim() || env.SUBSTRATE_TOKEN?.trim() || "";
	if (token === "") return null;
	return { url: (env.SUBSTRATE_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, ""), token };
}

export type RefreshPostOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Fire the dataset refresh at the substrate's merge-trigger route. A refusal
 * or an unreachable substrate is a reason, never a throw — the caller owes
 * the sync one stderr line, not a failed tick.
 */
export async function postDocsRefresh(
	target: RefreshTarget,
	input: { dataset: string; commit: string; content_sha256: string },
	fetchImpl: typeof fetch = fetch,
): Promise<RefreshPostOutcome> {
	let response: Response;
	try {
		response = await fetchImpl(`${target.url}/docs/merge-trigger`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
		});
	} catch (cause) {
		return { ok: false, reason: `merge-trigger unreachable: ${String(cause instanceof Error ? cause.message : cause).slice(0, 200)}` };
	}
	if (!response.ok) return { ok: false, reason: `merge-trigger ${response.status}` };
	return { ok: true };
}

/** Where a refresh a tick could not deliver waits to be retried — beside the projector's warned-state file. */
export const REFRESH_PENDING_FILE = "/var/lib/substrate/skills/refresh-pending.json";

/** One undelivered refresh: exactly the payload the merge-trigger route takes. */
export interface PendingRefresh {
	commit: string;
	content_sha256: string;
}

const PENDING_TMP_SUFFIX = ".substrate-tmp";

/**
 * The payload an earlier tick left pending, or null when none is stored.
 *
 * A missing, corrupt or wrong-shaped file means no pending refresh, never a
 * throw: losing a retry payload costs one refresh, while refusing the tick
 * over an unreadable file would turn a state hiccup into a failed sync.
 */
export function readPendingRefresh(file: string = REFRESH_PENDING_FILE): PendingRefresh | null {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const commit = (parsed as Record<string, unknown>).commit;
		const content_sha256 = (parsed as Record<string, unknown>).content_sha256;
		if (typeof commit !== "string" || commit === "" || typeof content_sha256 !== "string" || content_sha256 === "") return null;
		return { commit, content_sha256 };
	} catch {
		return null;
	}
}

/**
 * Store the payload to retry, or clear it with null. Written through a sibling
 * temp file and renamed — the same write discipline as the projector's
 * warned-state file — so a tick that dies mid-write never leaves half a JSON
 * document behind.
 */
export function writePendingRefresh(file: string, pending: PendingRefresh | null): void {
	if (pending === null) {
		try {
			rmSync(file);
		} catch {
			// Nothing was stored, or another tick cleared it already: done either way.
		}
		return;
	}
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}${PENDING_TMP_SUFFIX}`;
	writeFileSync(tmp, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

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
	 * The `agent-skills` dataset refresh on every healthy tick (U6): fire the
	 * POST, answer with the outcome, never reject — a refused or unreachable
	 * substrate costs one stderr line, never the tick. Absent (tests, or a
	 * caller that wants no refresh): no POST, no hash read.
	 */
	notifyRefresh?: (input: { commit: string; content_sha256: string }) => Promise<RefreshPostOutcome>;
	/**
	 * The refresh an earlier tick could not deliver, if the caller keeps one:
	 * read when the refresh step begins, written after the POST settles. A
	 * missing seam means no retry and no persistence — the tick only ever
	 * delivers its own fast-forward's payload.
	 */
	loadPendingRefresh?: () => PendingRefresh | null;
	/** Persist the payload to retry, or clear it on success; the sync's state file, written tmp+rename. */
	savePendingRefresh?: (pending: PendingRefresh | null) => void;
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
	// The refresh is delivered on every healthy tick, not only on a
	// fast-forward, and what one tick cannot deliver the next tick retries: a
	// failed POST leaves its payload pending in the sync's state file, a later
	// tick retries it whether its own decision is a new fast-forward or only
	// `current`, and a delivered fast-forward supersedes an older pending
	// payload — the newest tree is the one search should end up holding. The
	// sync's success never depends on any of this: a refused, unreachable or
	// re-failing substrate is one stderr line, and the exit code still says
	// what the sync itself did.
	const pending = ctx.loadPendingRefresh?.() ?? null;
	let attempt: PendingRefresh | null = decision === "ff" ? null : pending;
	if (decision === "ff" && ctx.notifyRefresh) {
		// The content hash of the refreshed tree, as git already knows it — the same
		// hash the route's content-hash idempotency dedupes on. A tree the tick
		// cannot name leaves any pending payload in place for the next tick.
		const tree = await git("rev-parse", "HEAD^{tree}");
		if (tree.code !== 0 || tree.stdout.trim() === "") {
			process.stderr.write(`[skills-sync] docs refresh not triggered: tree hash failed\n`);
		} else {
			attempt = { commit: originMain, content_sha256: tree.stdout.trim() };
		}
	}
	if (attempt !== null && ctx.notifyRefresh) {
		const posted = await ctx
			.notifyRefresh(attempt)
			.catch((cause: unknown): RefreshPostOutcome => ({ ok: false, reason: String(cause instanceof Error ? cause.message : cause) }));
		// The pending slot is the retry's memory, not the sync's verdict: a state
		// file this tick cannot write is one stderr line, and the tick stays green
		// over the git sync and projection that did happen. The next tick simply
		// retries whatever this one could not remember.
		try {
			ctx.savePendingRefresh?.(posted.ok ? null : attempt);
		} catch (cause) {
			process.stderr.write(
				`[skills-sync] refresh-pending write failed: ${redact(String(cause instanceof Error ? cause.message : cause)).slice(-OUTPUT_TAIL_CHARS)}\n`,
			);
		}
		// Fire-and-forget: the refresh is the substrate's to lose. One stderr line;
		// the tick's exit code still says what the sync itself did.
		if (!posted.ok) {
			process.stderr.write(`[skills-sync] docs refresh not triggered: ${redact(posted.reason).slice(-OUTPUT_TAIL_CHARS)}\n`);
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
		notifyRefresh: async (input) => {
			const target = refreshTarget();
			// No projector surface token: the trigger is off, silently.
			if (!target) return { ok: true };
			return postDocsRefresh(target, { dataset: SYNC_REFRESH_DATASET, ...input });
		},
		loadPendingRefresh: () => readPendingRefresh(),
		savePendingRefresh: (pending) => writePendingRefresh(REFRESH_PENDING_FILE, pending),
	});
	process.exit(result.code);
}
