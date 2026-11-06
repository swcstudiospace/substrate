// Commit, push and PR for a VM session, run on the host with the host's credentials (D-08,
// research Pattern 4, 03-01 c:hostfn_commit). No rivet import: the executors take an injected
// runner, so hostfns.test.ts drives them with fakes and vm.ts hands them execFile.
//
// The guest chooses nothing but text: the worktree is /var/lib/substrate/worktrees/<gid>, the
// branch substrate/<gid>, the repo and base branch come from graph_get, the remote is always
// origin and no argv ever carries --force or a refspec with a colon (T-03-07-01). Every argv is
// built by a pure function pinned by tests; every result is JSON with no environment content.

import { execFile } from "node:child_process";
import { closeSync, constants as fsConstants, lstatSync, openSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { redact } from "../../mcp-server/src/redact.ts";
import { worktreeFor } from "./options.ts";
import { isValidRepoSlug } from "./seed.ts";
import type { GraphView } from "./substrate.ts";
import type { TaskRecord } from "./tasks.ts";

export const PR_TITLE_MAX = 256;
export const PR_BODY_MAX = 20_000;
export const COMMIT_MESSAGE_MAX = 2_000;

/** Names the b:hooks shim and any smoke helper use inside the worktree; never committed, never pushed (T-03-07-07). */
const SCRATCH_PREFIX = ".substrate-";
const SCRATCH_EXCLUDE_PATHSPEC = ":(exclude,glob)**/.substrate-*";

const COMMIT_USER_NAME = "substrate claude-code";
const COMMIT_USER_EMAIL = "claude-code@substrate.local";

const BASE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const RUN_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 400;
const GITDIR_FILE_MAX = 4_096;
/** Config every host git call carries: hooks and fsmonitor are programs a worktree could supply, so both stay off. */
const GIT_GUARD_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

function branchFor(graphId: string): string {
	worktreeFor(graphId); // validates the id
	return `substrate/${graphId}`;
}

/** A base branch this host accepts: the BASE_BRANCH_RE shape, no `..`, no `.lock` suffix. */
function validBase(base: string): boolean {
	return BASE_BRANCH_RE.test(base) && !base.includes("..") && !base.endsWith(".lock");
}

function requireBase(base: string): string {
	if (!validBase(base)) throw new Error(`invalid base branch ${JSON.stringify(base)}`);
	return base;
}

/** A host git location: the worktree (`-C`, `--work-tree`) and the gitdir (`--git-dir`), both resolved by the host. */
export type GitSite = { worktree: string; gitDir: string };

/**
 * Every host git argv starts here: the site pinned by path, hooks and fsmonitor off. The explicit gitdir
 * means git never reads the worktree's own `.git` file, which the guest can rewrite through the mount.
 */
function gitArgv(site: GitSite, args: readonly string[]): string[] {
	return ["git", "-C", site.worktree, `--git-dir=${site.gitDir}`, `--work-tree=${site.worktree}`, ...GIT_GUARD_ARGS, ...args];
}

/** `git push origin substrate/<gid>` in the site — nothing else, ever. */
export function pushArgv(site: GitSite, graphId: string): string[] {
	return gitArgv(site, ["push", "origin", branchFor(graphId)]);
}

type PrCreateInput = { repo: string; graphId: string; base: string; title: string; body: string };

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
export function commitArgv(site: GitSite, message: string): [string[], string[]] {
	if (message.trim().length === 0 || message.length > COMMIT_MESSAGE_MAX) {
		throw new Error(`message must be 1..${COMMIT_MESSAGE_MAX} characters`);
	}
	if (message.startsWith("-")) throw new Error("message must not start with -");
	return [
		gitArgv(site, ["add", "-A", "--", ".", SCRATCH_EXCLUDE_PATHSPEC]),
		gitArgv(site, ["-c", `user.name=${COMMIT_USER_NAME}`, "-c", `user.email=${COMMIT_USER_EMAIL}`, "commit", "-m", message]),
	];
}

/** The paths of a `git diff --name-only` listing whose last segment starts with `.substrate-`. */
export function scratchPaths(diffNameOnly: string): string[] {
	return diffNameOnly
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && (line.split("/").at(-1) ?? "").startsWith(SCRATCH_PREFIX));
}

/**
 * The origin is this GitHub repo and no other: https://github.com/<owner>/<repo> or git@github.com:<owner>/<repo>,
 * optionally ending in `.git`. Owner and repo match exactly, case-insensitively.
 */
export function originMatches(url: string, slug: string): boolean {
	const [owner, repo, ...rest] = slug.toLowerCase().split("/");
	if (!owner || !repo || rest.length > 0) return false;
	const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(url.trim());
	return match?.[1]?.toLowerCase() === owner && match?.[2]?.toLowerCase() === repo;
}

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (argv: readonly string[]) => Promise<RunResult>;

/**
 * The production runner: execFile with an argv (never a shell), 120 s, HOME=/root, no system git config
 * (GIT_CONFIG_NOSYSTEM=1) and no terminal prompt (GIT_TERMINAL_PROMPT=0). Only the exit code and the two
 * streams come back.
 */
export function execFileRunner(argv: readonly string[]): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	try {
		execFile(
			argv[0] as string,
			argv.slice(1),
			{ timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", env: { ...process.env, HOME: "/root", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } },
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
	} catch (error) {
		return Promise.reject(error);
	}
	return promise;
}
function tail(result: RunResult): string {
	return redact(`${result.stdout}${result.stderr}`.trim().slice(-OUTPUT_TAIL_CHARS));
}

type ScratchCheck = { ok: true } | { ok: false; reason: string; paths: string[] };

/**
 * Before any network call: the branch's diff against origin/<base> must list no scratch path.
 * A diff that cannot be computed refuses too — the push never runs on an unknown branch state.
 */
export async function checkScratch(input: { graphId: string; base: string; run: Runner; worktreeRoot?: string | undefined }): Promise<ScratchCheck> {
	if (!validBase(input.base)) return { ok: false, reason: `invalid base branch ${JSON.stringify(input.base)}`, paths: [] };
	const resolved = siteFor(input.graphId, input.worktreeRoot);
	if ("error" in resolved) return { ok: false, reason: resolved.error, paths: [] };
	const base = input.base;
	const diff = await input.run(gitArgv(resolved.site, ["diff", "--name-only", `origin/${base}...HEAD`]));
	if (diff.code !== 0) return { ok: false, reason: `git diff against origin/${base} exited ${String(diff.code)}: ${tail(diff)}`, paths: [] };
	const paths = scratchPaths(diff.stdout);
	if (paths.length > 0) return { ok: false, reason: `branch contains substrate scratch files: ${paths.join(", ")}`, paths };
	return { ok: true };
}

type HostFnStore = { get(graphId: string, nodeId: string): TaskRecord | null; save(record: TaskRecord): void };

/** What every executor receives: the graph from the actor key, the node the guest named, and the host's collaborators. */
type HostFnContext = {
	graphId: string;
	nodeId: string;
	store: HostFnStore;
	substrate: { graphGet(graphId: string): Promise<GraphView | null> };
	run: Runner;
	/** Where worktrees live. Unset in production (worktreeFor); tests point it at a temp root. */
	worktreeRoot?: string;
	log?: (line: string) => void;
};

type HostFnError = { error: string };

type Target = { record: TaskRecord; graph: GraphView; repo: string; base: string } | HostFnError;

async function target(ctx: HostFnContext): Promise<Target> {
	const record = ctx.store.get(ctx.graphId, ctx.nodeId);
	if (!record) return { error: `no task for node ${ctx.nodeId} in this VM` };
	const graph = await ctx.substrate.graphGet(ctx.graphId);
	if (!graph) return { error: `graph ${ctx.graphId} is not registered` };
	const repo = graph.repo ?? record.repo;
	if (!isValidRepoSlug(repo)) return { error: `graph ${ctx.graphId} names no valid repo` };
	const base = graph.branch ?? "main";
	if (!validBase(base)) return { error: `graph ${ctx.graphId} names no valid base branch` };
	return { record, graph, repo, base };
}

/** The worktree the host runs git in: `<root>/<gid>` (worktreeFor unless a root is given), resolved and checked. */
function siteFor(graphId: string, worktreeRoot: string | undefined): GitSiteResult {
	const canonical = worktreeFor(graphId); // validates the graph id
	return resolveGitSite(worktreeRoot === undefined ? canonical : `${worktreeRoot}/${graphId}`);
}

type GitSiteResult = { site: GitSite } | HostFnError;

/**
 * The worktree's `.git` must be a regular file holding `gitdir: <absolute path>`, the path an existing directory
 * under `.git/worktrees/`, outside the worktree, and registered to this worktree: its `gitdir` back-pointer must name
 * this worktree's own `.git`. The guest writes the worktree, so any other shape (directory, symlink, pointer into
 * another graph's registration) is refused, never followed.
 */
function resolveGitSite(worktree: string): GitSiteResult {
	const dotGit = `${worktree}/.git`;
	let st: Stats;
	try {
		st = lstatSync(dotGit);
	} catch {
		return { error: "worktree .git is missing" };
	}
	if (!st.isFile() || st.size > GITDIR_FILE_MAX) return { error: "worktree .git is not a regular file" };
	let text: string;
	try {
		const fd = openSync(dotGit, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			text = readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return { error: "worktree .git is not a regular file" };
	}
	const line = text.replace(/\r?\n$/, "");
	const declared = line.startsWith("gitdir: ") ? line.slice("gitdir: ".length) : "";
	if (!isAbsolute(declared) || declared.includes("\n")) return { error: "worktree .git does not name a gitdir" };
	let gitDir: string;
	let worktreeReal: string;
	try {
		gitDir = realpathSync(declared);
		worktreeReal = realpathSync(worktree);
	} catch {
		return { error: "worktree .git names a gitdir that does not exist" };
	}
	if (!gitDir.includes("/.git/worktrees/")) return { error: "worktree .git names a gitdir outside .git/worktrees/" };
	if (gitDir.startsWith(`${worktreeReal}/`)) return { error: "worktree .git names a gitdir inside the worktree" };
	if (!statSync(gitDir).isDirectory()) return { error: "worktree .git names a gitdir that is not a directory" };
	if (!registeredTo(gitDir, worktreeReal)) return { error: "worktree .git names a gitdir not registered to this worktree" };
	return { site: { worktree, gitDir } };
}

/**
 * Git records each linked worktree in its gitdir: `<gitdir>/gitdir` holds the absolute path of that worktree's
 * `.git` file. A gitdir whose back-pointer names any other path (another graph's worktree included) is refused.
 */
function registeredTo(gitDir: string, worktreeReal: string): boolean {
	const backFile = `${gitDir}/gitdir`;
	let back: string;
	try {
		const st = lstatSync(backFile);
		if (!st.isFile() || st.size > GITDIR_FILE_MAX) return false;
		back = readFileSync(backFile, "utf8").replace(/\r?\n$/, "");
	} catch {
		return false;
	}
	if (!isAbsolute(back) || !back.endsWith("/.git")) return false;
	try {
		return realpathSync(dirname(back)) === worktreeReal;
	} catch {
		return false;
	}
}

type GitPushResult = { pushed: string; output: string } | HostFnError;

/**
 * `agentos-substrate git-push --node <nid>`: worktree on substrate/<gid>, origin naming the
 * graph's repo, no scratch path in the diff against origin/<base>, then the fixed push argv.
 */
export async function gitPush(ctx: HostFnContext): Promise<GitPushResult> {
	const t = await target(ctx);
	if ("error" in t) return t;
	const branch = branchFor(ctx.graphId);
	const resolved = siteFor(ctx.graphId, ctx.worktreeRoot);
	if ("error" in resolved) return resolved;
	const site = resolved.site;

	const head = await ctx.run(gitArgv(site, ["rev-parse", "--abbrev-ref", "HEAD"]));
	const onBranch = head.stdout.trim();
	if (head.code !== 0 || onBranch !== branch) return { error: `worktree is on ${onBranch || "an unknown ref"}, not ${branch}` };

	const origin = await ctx.run(gitArgv(site, ["remote", "get-url", "origin"]));
	if (origin.code !== 0 || !originMatches(origin.stdout, t.repo)) return { error: `origin does not name ${t.repo}` };

	const scratch = await checkScratch({ graphId: ctx.graphId, base: t.base, run: ctx.run, worktreeRoot: ctx.worktreeRoot });
	if (!scratch.ok) return { error: scratch.reason };

	ctx.log?.(`[substrate-host] git-push ${ctx.graphId}/${ctx.nodeId} ${branch} → ${t.repo}`);
	const push = await ctx.run(pushArgv(site, ctx.graphId));
	if (push.code !== 0) return { error: `git push exited ${String(push.code)}: ${tail(push)}` };
	return { pushed: branch, output: tail(push) };
}

type PrCreateResult = { pr_url: string; pr_number: number; existing: boolean } | HostFnError;

const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/;

/** The repo's PR URL from gh's stdout (its last line), or null. */
function prUrlOf(stdout: string, repo: string): { url: string; number: number } | null {
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

type CommitResult = { committed: true; sha: string } | HostFnError;

/** c:hostfn_commit only — `agentos-substrate commit --node <nid> --message …` on the host worktree. */
export async function commit(ctx: HostFnContext & { message: string }): Promise<CommitResult> {
	if (ctx.message.length > COMMIT_MESSAGE_MAX) return { error: `message exceeds ${COMMIT_MESSAGE_MAX} characters` };
	const record = ctx.store.get(ctx.graphId, ctx.nodeId);
	if (!record) return { error: `no task for node ${ctx.nodeId} in this VM` };
	const resolved = siteFor(ctx.graphId, ctx.worktreeRoot);
	if ("error" in resolved) return resolved;
	let argvs: [string[], string[]];
	try {
		argvs = commitArgv(resolved.site, ctx.message);
	} catch (cause) {
		return { error: cause instanceof Error ? cause.message : String(cause) };
	}
	const [add, commitArgs] = argvs;
	const added = await ctx.run(add);
	if (added.code !== 0) return { error: `git add exited ${String(added.code)}: ${tail(added)}` };
	const committed = await ctx.run(commitArgs);
	if (committed.code !== 0) return { error: `git commit exited ${String(committed.code)}: ${tail(committed)}` };
	const head = await ctx.run(gitArgv(resolved.site, ["rev-parse", "HEAD"]));
	const sha = head.stdout.trim();
	ctx.log?.(`[substrate-host] commit ${ctx.graphId}/${ctx.nodeId} ${sha.slice(0, 12)}`);
	return { committed: true, sha };
}
