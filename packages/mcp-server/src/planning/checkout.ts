/**
 * What the planning plane learns about a checkout from its git data (phase 52, SOTA-08): the session it heartbeats as, its
 * branch, and the `owner/name` of its origin remote. Reads only. The observer (`observer.ts`) is the one caller that writes
 * anything, and it writes the heartbeat from these facts.
 */
import { join, resolve as resolvePath } from "node:path";
import type { PlanningFs } from "./index.ts";

/** Why a change could not be attributed to a repo. Each reason is a typed result, never an exception out of the observer. */
export type RepoUnknownReason = "no-git-entry" | "git-file-malformed" | "git-dir-unreadable" | "config-unreadable" | "config-missing" | "origin-missing";

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
 * The `owner/name` of the `origin` remote, read from the common git directory's config. A definitive absence (no git entry,
 * no config, no origin) is `transient: false`. A read that failed for any other reason (denied, I/O, or removed between the
 * stat and the read) is `transient: true`: the caller must not advance its baseline on it, so the change is published by the
 * next successful read.
 */
export async function repoOf(fs: PlanningFs, root: string): Promise<RepoLookup> {
	let layout: GitLayout;
	try {
		layout = await gitLayout(fs, root);
	} catch {
		return { state: "unknown", reason: "git-dir-unreadable", transient: true };
	}
	if (!layout.ok) return { state: "unknown", reason: layout.reason, transient: false };
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

/** Parses the `origin` URL of a git config into `owner/name`. Only the two trailing path segments are kept. */
export function repoFromGitConfig(text: string): string | null {
	const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(text);
	const url = section ? /^\s*url\s*=\s*(.+?)\s*$/m.exec(section[1] ?? "") : null;
	if (!url) return null;
	const match = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(unquoted(url[1] ?? ""));
	return match ? `${match[1]}/${match[2]}` : null;
}

/** A value with one matching pair of surrounding quotes removed. A value without them is returned as it is. */
function unquoted(value: string): string {
	const pair = /^(["'])(.*)\1$/.exec(value);
	return pair ? (pair[2] ?? "") : value;
}
