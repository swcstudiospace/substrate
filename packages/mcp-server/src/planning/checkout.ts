/**
 * What the planning plane learns about a checkout from its git data (phase 52, SOTA-08): the session it heartbeats as, its
 * branch, and the `owner/name` of its origin remote. Reads only. The observer (`observer.ts`) is the one caller that writes
 * anything, and it writes the heartbeat from these facts.
 */
import { join, resolve as resolvePath } from "node:path";
import type { PlanningFs } from "./index.ts";

/** Why a change could not be attributed to a repo. Each reason is a typed result, never an exception out of the observer. */
export type RepoUnknownReason = "no-git-entry" | "git-file-malformed" | "git-dir-unreadable" | "origin-unresolved" | "config-unreadable" | "config-missing" | "origin-missing";

/** The session a checkout heartbeats as: stable for the path, and shaped to pass the session id rule. */
export function planningSessionId(fs: PlanningFs, root: string): string {
	return `wt-${fs.sha256(new TextEncoder().encode(root)).slice(0, 24)}`;
}

/** The text of a file, or null when it is absent. Any other failure throws. */
async function textOf(fs: PlanningFs, path: string): Promise<string | null> {
	const found = await fs.statFile(path);
	if (found === null || !found.isFile) return null;
	return new TextDecoder().decode(await fs.readFile(path));
}

export type GitLayout = { ok: true; gitDir: string; commonDir: string } | { ok: false; reason: RepoUnknownReason };

/**
 * Where a checkout's git data lives. A `.git` directory is the git directory. A `.git` file (a linked worktree) names one
 * in its `gitdir:` line, relative to the checkout. That git directory's `commondir` file, when present, names the common
 * directory that holds the shared `config`. I/O failures throw; a missing or malformed layout is a typed result.
 */
export async function gitLayout(fs: PlanningFs, root: string): Promise<GitLayout> {
	const dotGit = join(root, ".git");
	const entry = await fs.statFile(dotGit);
	if (entry === null) return { ok: false, reason: "no-git-entry" };
	let gitDir = dotGit;
	if (entry.isFile) {
		const pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec((await textOf(fs, dotGit)) ?? "");
		if (pointer === null) return { ok: false, reason: "git-file-malformed" };
		gitDir = resolvePath(root, pointer[1] ?? "");
	}
	const commondir = await textOf(fs, join(gitDir, "commondir"));
	const commonDir = commondir === null ? gitDir : resolvePath(gitDir, commondir.trim());
	return { ok: true, gitDir, commonDir };
}

/** The branch a worktree's HEAD names, or `detached`. A HEAD that is absent throws. */
export async function branchOf(fs: PlanningFs, gitDir: string): Promise<string> {
	const head = await textOf(fs, join(gitDir, "HEAD"));
	if (head === null) throw new Error("HEAD is absent");
	const ref = /^ref:[ \t]*refs\/heads\/(.+?)[ \t]*$/m.exec(head);
	return ref === null ? "detached" : (ref[1] ?? "detached");
}

export type RepoLookup = { state: "known"; repo: string } | { state: "unknown"; reason: RepoUnknownReason; transient: boolean };

/**
 * What asking git for a checkout's origin URL came to. `value` is git's effective answer, includes resolved; `none` is git
 * saying there is no such key; `failed` is git running but not answering (a timeout, a signal, or an error exit); `unavailable`
 * is git not being runnable at all (no binary, no such directory), the one case the caller may read the config file itself.
 */
export type OriginUrlResult = { kind: "value"; url: string } | { kind: "none" } | { kind: "failed" } | { kind: "unavailable" };

/** Asks git for the `remote.origin.url` of the checkout at `root`. It never throws. */
export type OriginUrlRunner = (root: string) => Promise<OriginUrlResult>;

/** The longest `git config` may take before the answer is `failed`. */
export const ORIGIN_URL_TIMEOUT_MS = 3000;

/** The only variables the git child sees: where to find git and the user's config, and no prompt. No repository-selecting variable (`GIT_DIR` and the like) and no secret passes. */
const GIT_CHILD_ENV = ["PATH", "HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"];

/** What one fixed-argv git run came to: it exited (`exit`), ran but could not answer (a signal or the timeout, `failed`), or could not run at all (`unavailable`). */
export type GitRunResult = { kind: "exit"; code: number; stdout: string } | { kind: "failed" } | { kind: "unavailable" };

/** Runs `git <args>` in `root`. It never throws. */
export type GitRunner = (root: string, args: readonly string[]) => Promise<GitRunResult>;

/** Runs git in `root` with a fixed argv, no shell, an allowlisted environment and a timeout. */
export const spawnGit: GitRunner = async (root, args) => {
	const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
	for (const name of GIT_CHILD_ENV) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	try {
		const proc = Bun.spawn(["git", ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: ORIGIN_URL_TIMEOUT_MS, killSignal: "SIGKILL" });
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (proc.signalCode !== null) return { kind: "failed" };
		return { kind: "exit", code, stdout };
	} catch (error) {
		// Bun throws from `spawn` itself when the binary or the working directory is absent; that is "git cannot run".
		return error instanceof Error && "code" in error && error.code === "ENOENT" ? { kind: "unavailable" } : { kind: "failed" };
	}
};

/**
 * An origin-URL runner over a git runner. Git's own answer for `remote.origin.url` is asked first: git resolves `include.path`
 * and `includeIf` files, the system and global config, and the last `url` in the file, which a read of `.git/config` alone
 * cannot. Exit 1 is git's "no such key" only when git actually read the repository's config. A checkout owned by another user
 * and outside `safe.directory` also exits 1 for `git config`, having skipped the repository config, so on exit 1 (or an empty
 * answer) `git rev-parse --git-dir` is asked in the same checkout: when it fails, git did not accept the repository and the
 * answer is `failed`, never `none`. Any other nonzero exit, a signal, or the timeout is a failure to answer.
 */
export function originUrlRunner(run: GitRunner): OriginUrlRunner {
	return async (root) => {
		const asked = await run(root, ["config", "--get", "remote.origin.url"]);
		if (asked.kind !== "exit") return asked;
		if (asked.code !== 0 && asked.code !== 1) return { kind: "failed" };
		const url = asked.code === 0 ? asked.stdout.trim() : "";
		if (url !== "") return { kind: "value", url };
		const accepted = await run(root, ["rev-parse", "--git-dir"]);
		return accepted.kind === "exit" && accepted.code === 0 ? { kind: "none" } : { kind: "failed" };
	};
}

/** Git's own answer for `remote.origin.url` in the checkout at `root`. It never throws. */
export const gitOriginUrl: OriginUrlRunner = originUrlRunner(spawnGit);

/**
 * The `owner/name` of the `origin` remote. Git is asked first, run in the checkout, so an origin defined in an included
 * config file is found as it is by every git command. The common directory's `config` is read directly only when git cannot
 * run at all. A definitive absence (no git entry, git saying there is no origin, or no config) is `transient: false`. An
 * answer that failed for any other reason (a git error or timeout, or a config that could not be read) is `transient: true`:
 * the caller must not advance its baseline on it, so the change is published by the next successful read.
 */
export async function repoOf(fs: PlanningFs, root: string, originUrl: OriginUrlRunner = gitOriginUrl): Promise<RepoLookup> {
	let layout: GitLayout;
	try {
		layout = await gitLayout(fs, root);
	} catch {
		return { state: "unknown", reason: "git-dir-unreadable", transient: true };
	}
	if (!layout.ok) return { state: "unknown", reason: layout.reason, transient: false };
	const asked = await originUrl(root);
	if (asked.kind === "failed") return { state: "unknown", reason: "origin-unresolved", transient: true };
	if (asked.kind === "none") return { state: "unknown", reason: "origin-missing", transient: false };
	if (asked.kind === "value") {
		const repo = repoFromUrl(asked.url);
		return repo === null ? { state: "unknown", reason: "origin-missing", transient: false } : { state: "known", repo };
	}
	let config: string | null;
	try {
		config = await textOf(fs, join(layout.commonDir, "config"));
	} catch {
		return { state: "unknown", reason: "config-unreadable", transient: true };
	}
	if (config === null) return { state: "unknown", reason: "config-missing", transient: false };
	const repo = repoFromGitConfig(config);
	return repo === null ? { state: "unknown", reason: "origin-missing", transient: false } : { state: "known", repo };
}

/**
 * The `owner/name` of the `origin` remote in a git config, read by git's rules: a section name and a key name are
 * case-insensitive, a header may be indented, whitespace around a name or `=` is ignored, and the subsection in quotes is
 * case-sensitive. A header that is not `[remote "origin"]` ends the origin section, whatever its indentation. The last `url`
 * in the origin section is the one git reads. A comment line, and a comment after a value, are not part of the value.
 */
export function repoFromGitConfig(text: string): string | null {
	let inOrigin = false;
	let url: string | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const header = /^\[\s*([A-Za-z][A-Za-z0-9.-]*)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
		if (header) {
			inOrigin = (header[1] ?? "").toLowerCase() === "remote" && header[2] === "origin";
			continue;
		}
		const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
		if (inOrigin && entry !== null && (entry[1] ?? "").toLowerCase() === "url") url = unquoted(withoutComment(entry[2] ?? ""));
	}
	if (url === null) return null;
	return repoFromUrl(url);
}

/** The `owner/name` a remote URL names, in its ssh, https or scp-like form, or null when it names none. */
function repoFromUrl(url: string): string | null {
	const match = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
	return match ? `${match[1]}/${match[2]}` : null;
}

/** The value without a trailing comment. Git ends a value at a `#` or `;` that is outside double quotes. */
function withoutComment(value: string): string {
	let quoted = false;
	for (let index = 0; index < value.length; index += 1) {
		const char = value.charAt(index);
		if (char === '"') quoted = !quoted;
		else if (!quoted && (char === "#" || char === ";")) return value.slice(0, index).trim();
	}
	return value.trim();
}

/** A value with one matching pair of surrounding quotes removed. A value without them is returned as it is. */
function unquoted(value: string): string {
	const pair = /^(["'])(.*)\1$/.exec(value);
	return pair ? (pair[2] ?? "") : value;
}
