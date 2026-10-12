// Commit, push and PR for a VM session, run on the host with the host's credentials (D-08,
// research Pattern 4, 03-01 c:hostfn_commit). No rivet import: the executors take an injected
// runner, so hostfns.test.ts drives them with fakes and vm.ts hands them execFile.
//
// The guest chooses nothing but text: the worktree is /var/lib/substrate/worktrees/<gid>, the
// branch substrate/<gid>, the repo and base branch come from graph_get, the remote is always
// origin and no argv ever carries --force or a refspec with a colon (T-03-07-01). Every argv is
// built by a pure function pinned by tests; every result is JSON with no environment content.

import { execFile } from "node:child_process";
import { redact } from "../../mcp-server/src/redact.ts";
import { worktreeFor } from "./options.ts";
import { isValidRepoSlug } from "./seed.ts";
import type { GraphView } from "./substrate.ts";
import { mutationRefusal, type TaskRecord } from "./tasks.ts";

export const PR_TITLE_MAX = 256;
export const PR_BODY_MAX = 20_000;
export const COMMIT_MESSAGE_MAX = 2_000;

/** Names the b:hooks shim and any smoke helper use inside the worktree; never committed, never pushed (T-03-07-07). */
export const SCRATCH_PREFIX = ".substrate-";
export const SCRATCH_EXCLUDE_PATHSPEC = ":(exclude,glob)**/.substrate-*";

export const COMMIT_USER_NAME = "substrate claude-code";
export const COMMIT_USER_EMAIL = "claude-code@substrate.local";

const BASE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const RUN_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 400;

export function branchFor(graphId: string): string {
	worktreeFor(graphId); // validates the id
	return `substrate/${graphId}`;
}

function requireBase(base: string): string {
	if (!BASE_BRANCH_RE.test(base) || base.includes("..") || base.endsWith(".lock")) {
		throw new Error(`invalid base branch ${JSON.stringify(base)}`);
	}
	return base;
}

/** `git -C <worktree> push origin substrate/<gid>` — nothing else, ever. */
export function pushArgv(graphId: string): string[] {
	return ["git", "-C", worktreeFor(graphId), "push", "origin", branchFor(graphId)];
}

export type PrCreateInput = { repo: string; graphId: string; base: string; title: string; body: string };

/** `gh pr create` with every target fixed by the host; only title and body are the guest's, within limits. */
export function prCreateArgv(input: PrCreateInput): string[] {
	if (!isValidRepoSlug(input.repo)) throw new Error(`invalid repo slug ${JSON.stringify(input.repo)}`);
	const title = input.title.trim();
	if (title.length === 0 || input.title.length > PR_TITLE_MAX) throw new Error(`title must be 1..${PR_TITLE_MAX} characters`);
	if (input.body.length > PR_BODY_MAX) throw new Error(`body exceeds ${PR_BODY_MAX} characters`);
	const base = requireBase(input.base);
	return ["gh", "pr", "create", "--repo", input.repo, "--head", branchFor(input.graphId), "--base", base, "--title", input.title, "--body", input.body];
}

/**
 * c:hostfn_commit: two argvs run in order on the host worktree. The add step excludes every
 * `.substrate-*` path at any depth, so a hook's scratch file can never be staged (T-03-07-07).
 */
export function commitArgv(graphId: string, message: string): [string[], string[]] {
	const worktree = worktreeFor(graphId);
	if (message.trim().length === 0 || message.length > COMMIT_MESSAGE_MAX) {
		throw new Error(`message must be 1..${COMMIT_MESSAGE_MAX} characters`);
	}
	if (message.startsWith("-")) throw new Error("message must not start with -");
	return [
		["git", "-C", worktree, "add", "-A", "--", ".", SCRATCH_EXCLUDE_PATHSPEC],
		["git", "-C", worktree, "-c", `user.name=${COMMIT_USER_NAME}`, "-c", `user.email=${COMMIT_USER_EMAIL}`, "commit", "-m", message],
	];
}

/** The paths of a `git diff --name-only` listing whose last segment starts with `.substrate-`. */
export function scratchPaths(diffNameOnly: string): string[] {
	return diffNameOnly
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && (line.split("/").at(-1) ?? "").startsWith(SCRATCH_PREFIX));
}

/** worktree.py `_origin_matches`: exactly this owner/repo (case-insensitive, `.git` ignored, path or scp suffix). */
export function originMatches(url: string, slug: string): boolean {
	let norm = url.trim().toLowerCase().replace(/\/+$/, "");
	if (norm.endsWith(".git")) norm = norm.slice(0, -".git".length);
	const want = slug.toLowerCase();
	return norm === want || norm.endsWith(`/${want}`) || norm.endsWith(`:${want}`);
}

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (argv: readonly string[]) => Promise<RunResult>;

/**
 * The production runner: execFile with an argv (never a shell), 120 s, HOME=/root so gh's stored
 * credential helper answers git and gh. Only the exit code and the two streams come back.
 */
export function execFileRunner(argv: readonly string[]): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	execFile(
		argv[0] as string,
		argv.slice(1),
		{ timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", env: { ...process.env, HOME: "/root" } },
		(error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		},
	);
	return promise;
}
function tail(result: RunResult): string {
	return redact(`${result.stdout}${result.stderr}`.trim().slice(-OUTPUT_TAIL_CHARS));
}

export type ScratchCheck = { ok: true } | { ok: false; reason: string; paths: string[] };

/**
 * Before any network call: the branch's diff against origin/<base> must list no scratch path.
 * A diff that cannot be computed refuses too — the push never runs on an unknown branch state.
 */
export async function checkScratch(input: { graphId: string; base: string; run: Runner }): Promise<ScratchCheck> {
	const base = requireBase(input.base);
	const diff = await input.run(["git", "-C", worktreeFor(input.graphId), "diff", "--name-only", `origin/${base}...HEAD`]);
	if (diff.code !== 0) return { ok: false, reason: `git diff against origin/${base} exited ${String(diff.code)}: ${tail(diff)}`, paths: [] };
	const paths = scratchPaths(diff.stdout);
	if (paths.length > 0) return { ok: false, reason: `branch contains substrate scratch files: ${paths.join(", ")}`, paths };
	return { ok: true };
}

export type HostFnStore = { get(graphId: string, nodeId: string): TaskRecord | null; save(record: TaskRecord): void };

/** What every executor receives: the graph from the actor key, the node the guest named, and the host's collaborators. */
export type HostFnContext = {
	graphId: string;
	nodeId: string;
	store: HostFnStore;
	substrate: { graphGet(graphId: string): Promise<GraphView | null> };
	run: Runner;
	log?: (line: string) => void;
};

export type HostFnError = { error: string };

type Target = { record: TaskRecord; graph: GraphView; repo: string; base: string } | HostFnError;

async function target(ctx: HostFnContext): Promise<Target> {
	const record = ctx.store.get(ctx.graphId, ctx.nodeId);
	if (!record) return { error: `no task for node ${ctx.nodeId} in this VM` };
	const refusal = mutationRefusal(record);
	if (refusal === "released") return { error: `task ${ctx.graphId}/${ctx.nodeId} already released` };
	if (refusal === "failed") return { error: `task ${ctx.graphId}/${ctx.nodeId} is failed and holds no mutation authority` };
	const graph = await ctx.substrate.graphGet(ctx.graphId);
	if (!graph) return { error: `graph ${ctx.graphId} is not registered` };
	const repo = graph.repo ?? record.repo;
	if (!isValidRepoSlug(repo)) return { error: `graph ${ctx.graphId} names no valid repo` };
	const base = graph.branch ?? "main";
	if (!BASE_BRANCH_RE.test(base) || base.includes("..")) return { error: `graph ${ctx.graphId} names no valid base branch` };
	return { record, graph, repo, base };
}

export type GitPushResult = { pushed: string; output: string } | HostFnError;

/**
 * `agentos-substrate git-push --node <nid>`: worktree on substrate/<gid>, origin naming the
 * graph's repo, no scratch path in the diff against origin/<base>, then the fixed push argv.
 */
export async function gitPush(ctx: HostFnContext): Promise<GitPushResult> {
	const t = await target(ctx);
	if ("error" in t) return t;
	const worktree = worktreeFor(ctx.graphId);
	const branch = branchFor(ctx.graphId);

	const head = await ctx.run(["git", "-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]);
	const onBranch = head.stdout.trim();
	if (head.code !== 0 || onBranch !== branch) return { error: `worktree is on ${onBranch || "an unknown ref"}, not ${branch}` };

	const origin = await ctx.run(["git", "-C", worktree, "remote", "get-url", "origin"]);
	if (origin.code !== 0 || !originMatches(origin.stdout, t.repo)) return { error: `origin does not name ${t.repo}` };

	const scratch = await checkScratch({ graphId: ctx.graphId, base: t.base, run: ctx.run });
	if (!scratch.ok) return { error: scratch.reason };

	ctx.log?.(`[substrate-host] git-push ${ctx.graphId}/${ctx.nodeId} ${branch} → ${t.repo}`);
	const push = await ctx.run(pushArgv(ctx.graphId));
	if (push.code !== 0) return { error: `git push exited ${String(push.code)}: ${tail(push)}` };
	return { pushed: branch, output: tail(push) };
}

export type PrCreateResult = { pr_url: string; pr_number: number; existing: boolean } | HostFnError;

const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/;

/** The repo's PR URL from gh's stdout (its last line), or null. */
export function prUrlOf(stdout: string, repo: string): { url: string; number: number } | null {
	for (const line of stdout.split("\n").reverse()) {
		const match = PR_URL_RE.exec(line.trim());
		if (match && match[1]?.toLowerCase() === repo.toLowerCase()) return { url: line.trim(), number: Number(match[2]) };
	}
	return null;
}

/**
 * `agentos-substrate pr-create --node <nid> --title … --body …`: one PR per task — a recorded
 * pr_url is returned as is (T-03-07-05); otherwise gh runs with the graph's repo and base and the
 * URL it prints is recorded on the task.
 */
export async function prCreate(ctx: HostFnContext & { title: string; body: string }): Promise<PrCreateResult> {
	if (ctx.title.length > PR_TITLE_MAX) return { error: `title exceeds ${PR_TITLE_MAX} characters` };
	if (ctx.body.length > PR_BODY_MAX) return { error: `body exceeds ${PR_BODY_MAX} characters` };
	const t = await target(ctx);
	if ("error" in t) return t;
	if (t.record.pr_url && t.record.pr_number !== null) return { pr_url: t.record.pr_url, pr_number: t.record.pr_number, existing: true };

	let argv: string[];
	try {
		argv = prCreateArgv({ repo: t.repo, graphId: ctx.graphId, base: t.base, title: ctx.title, body: ctx.body });
	} catch (cause) {
		return { error: cause instanceof Error ? cause.message : String(cause) };
	}
	ctx.log?.(`[substrate-host] pr-create ${ctx.graphId}/${ctx.nodeId} ${t.repo} base ${t.base}`);
	const result = await ctx.run(argv);
	if (result.code !== 0) return { error: `gh pr create exited ${String(result.code)}: ${tail(result)}` };
	const pr = prUrlOf(result.stdout, t.repo);
	if (!pr) return { error: `gh pr create printed no pull request URL for ${t.repo}` };
	const record = ctx.store.get(ctx.graphId, ctx.nodeId) ?? t.record;
	record.pr_url = pr.url;
	record.pr_number = pr.number;
	ctx.store.save(record);
	ctx.log?.(`[substrate-host] pr opened ${ctx.graphId}/${ctx.nodeId} #${pr.number}`);
	return { pr_url: pr.url, pr_number: pr.number, existing: false };
}

export type CommitResult = { committed: true; sha: string } | HostFnError;

/** c:hostfn_commit only — `agentos-substrate commit --node <nid> --message …` on the host worktree. */
export async function commit(ctx: HostFnContext & { message: string }): Promise<CommitResult> {
	if (ctx.message.length > COMMIT_MESSAGE_MAX) return { error: `message exceeds ${COMMIT_MESSAGE_MAX} characters` };
	const record = ctx.store.get(ctx.graphId, ctx.nodeId);
	if (!record) return { error: `no task for node ${ctx.nodeId} in this VM` };
	const refusal = mutationRefusal(record);
	if (refusal === "released") return { error: `task ${ctx.graphId}/${ctx.nodeId} already released` };
	if (refusal === "failed") return { error: `task ${ctx.graphId}/${ctx.nodeId} is failed and holds no mutation authority` };
	let argvs: [string[], string[]];
	try {
		argvs = commitArgv(ctx.graphId, ctx.message);
	} catch (cause) {
		return { error: cause instanceof Error ? cause.message : String(cause) };
	}
	const [add, commitArgs] = argvs;
	const added = await ctx.run(add);
	if (added.code !== 0) return { error: `git add exited ${String(added.code)}: ${tail(added)}` };
	const committed = await ctx.run(commitArgs);
	if (committed.code !== 0) return { error: `git commit exited ${String(committed.code)}: ${tail(committed)}` };
	const head = await ctx.run(["git", "-C", worktreeFor(ctx.graphId), "rev-parse", "HEAD"]);
	const sha = head.stdout.trim();
	ctx.log?.(`[substrate-host] commit ${ctx.graphId}/${ctx.nodeId} ${sha.slice(0, 12)}`);
	return { committed: true, sha };
}
