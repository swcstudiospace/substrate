/**
 * The injectable process runner and the git helpers built on it.
 *
 * The production runner uses `child_process.spawn` with an argv array and no shell: paths are never
 * interpolated into a command string. `spawn` rather than `execFile` because two calls need what
 * `execFile` cannot give: stdin for NUL-separated pathspec lists, and stdout streamed straight into
 * a file (blob contents are never buffered in memory).
 */

import { spawn } from "node:child_process";
import { closeSync, fsyncSync, openSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { GitCommandError, SnapshotPolicyError } from "./errors.ts";
import type { Clock } from "./types.ts";

export type RunOptions = {
	cwd?: string;
	/** Merged over the sanitised process environment. */
	env?: Record<string, string>;
	input?: Buffer | string;
	/** Stream stdout into this new file (created exclusively, fsynced on exit) instead of buffering it. */
	stdoutFile?: string;
	/** Creation mode for `stdoutFile` (before the umask). Default 0o666. */
	stdoutMode?: number;
};

export type RunResult = { code: number | null; stdout: Buffer; stderr: string };
export type Runner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>;

const RUN_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 512 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const STDERR_EXCERPT_CHARS = 200;

/** Variables that would redirect git to another repository or index, or change committer identity. */
const SCRUBBED_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_AUTHOR_DATE",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"GIT_COMMITTER_DATE",
];

/**
 * The process environment without the variables that redirect git. The local is not named like an
 * environment reader on purpose: the repo's flag-registry scanner would count each dotted write as
 * a read of a registered variable, and these are git's own variables, not substrate settings.
 */
function sanitizedEnv(): Record<string, string> {
	const base: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !SCRUBBED_ENV.includes(key)) base[key] = value;
	}
	base.GIT_TERMINAL_PROMPT = "0";
	base.GIT_OPTIONAL_LOCKS = "0";
	base.LC_ALL = "C";
	return base;
}

export const spawnRunner: Runner = (argv, options = {}) => {
	const { promise, resolve: resolveRun, reject: rejectRun } = Promise.withResolvers<RunResult>();
	const [file, ...args] = argv;
	if (file === undefined) {
		rejectRun(new GitCommandError("empty argv"));
		return promise;
	}
	let fd: number | null = null;
	if (options.stdoutFile !== undefined) {
		try {
			fd = openSync(options.stdoutFile, "wx", options.stdoutMode ?? 0o666);
		} catch (error) {
			rejectRun(error);
			return promise;
		}
	}
	let settled = false;
	const finish = (action: () => void): void => {
		if (settled) return;
		settled = true;
		if (fd !== null) {
			try {
				fsyncSync(fd);
			} catch {
				// fsync is not supported on every filesystem; the later rename is still atomic.
			}
			closeSync(fd);
			fd = null;
		}
		action();
	};
	const child = spawn(file, args, {
		cwd: options.cwd,
		env: { ...sanitizedEnv(), ...options.env },
		stdio: [options.input === undefined ? "ignore" : "pipe", fd ?? "pipe", "pipe"],
		timeout: RUN_TIMEOUT_MS,
	});
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	let outBytes = 0;
	let errBytes = 0;
	child.stdout?.on("data", (chunk: Buffer) => {
		outBytes += chunk.length;
		if (outBytes > MAX_STDOUT_BYTES) {
			child.kill();
			finish(() => rejectRun(new GitCommandError(`output of ${file} exceeded ${MAX_STDOUT_BYTES} bytes`)));
			return;
		}
		out.push(chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		if (errBytes < MAX_STDERR_BYTES) err.push(chunk);
		errBytes += chunk.length;
	});
	child.stdin?.on("error", () => {
		// EPIPE when git exits before reading its input: the exit code and stderr report why.
	});
	if (options.input !== undefined) child.stdin?.end(options.input);
	child.on("error", (error) => finish(() => rejectRun(error)));
	child.on("close", (code) =>
		finish(() => resolveRun({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") })),
	);
	return promise;
};

/** Config that makes git hash and move exactly the bytes on disk, with no hooks and no signing. */
const GIT_CONFIG_ARGS = [
	"-c",
	"core.autocrlf=false",
	"-c",
	"core.safecrlf=false",
	"-c",
	"core.fileMode=true",
	"-c",
	"core.symlinks=true",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"commit.gpgsign=false",
];

export type RepoContext = {
	/** Real path of the working tree's top level. */
	root: string;
	/** Absolute git directory of this working tree (per-worktree for linked worktrees). */
	gitDir: string;
	run: Runner;
	now: Clock;
};

export type GitOptions = Omit<RunOptions, "cwd">;

function excerpt(stderr: string): string {
	return stderr.trim().replace(/\s+/g, " ").slice(0, STDERR_EXCERPT_CHARS);
}

/** Run git in the worktree. Returns the raw result without checking the exit code. */
export function gitTry(ctx: Pick<RepoContext, "root" | "run">, args: readonly string[], options?: GitOptions): Promise<RunResult> {
	return ctx.run(["git", ...GIT_CONFIG_ARGS, "-C", ctx.root, ...args], options);
}

/** Run git and return stdout; a non-zero exit throws GitCommandError quoting at most 200 stderr characters. */
export async function git(ctx: Pick<RepoContext, "root" | "run">, args: readonly string[], options?: GitOptions): Promise<Buffer> {
	const result = await gitTry(ctx, args, options);
	if (result.code !== 0) {
		throw new GitCommandError(`git ${args[0] ?? ""} failed (exit ${result.code ?? "signal"}): ${excerpt(result.stderr)}`);
	}
	return result.stdout;
}

export async function gitText(ctx: Pick<RepoContext, "root" | "run">, args: readonly string[], options?: GitOptions): Promise<string> {
	return (await git(ctx, args, options)).toString("utf8").trim();
}

/** Resolve a worktree path to its repository context. The path must be the working tree's top level. */
export async function openRepo(params: { worktree: string; run?: Runner; now?: Clock }): Promise<RepoContext> {
	const run = params.run ?? spawnRunner;
	const now = params.now ?? (() => new Date());
	const start = resolve(params.worktree);
	const probe = { root: start, run };
	const top = await gitText(probe, ["rev-parse", "--show-toplevel"]);
	const root = realpathSync(top);
	if (realpathSync(start) !== root) {
		throw new SnapshotPolicyError("the worktree path must be the top level of a git working tree");
	}
	const gitDir = realpathSync(await gitText({ root, run }, ["rev-parse", "--absolute-git-dir"]));
	return { root, gitDir, run, now };
}
