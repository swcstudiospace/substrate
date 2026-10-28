/**
 * Building trees from the worktree and reading them back.
 *
 * The tree is built in a TEMPORARY index (`GIT_INDEX_FILE` inside the git directory), so the real
 * index, HEAD, branch, stash and refs are never touched. The candidate file list is enumerated with
 * `git ls-files` and filtered here (name rules first, then size) before a single byte is hashed;
 * the filtered list is fed to `git hash-object --no-filters --stdin-paths` and `update-index
 * --index-info` on stdin, so a large worktree cannot overflow argv, an excluded file is never read
 * and the stored bytes are the exact bytes on disk (no attribute or config conversion).
 */

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readlinkSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";
import { GitCommandError, SnapshotPolicyError, UnsupportedPathError } from "./errors.ts";
import { ancestorsOf, assertSafeRelativePath, comparePaths, decodePath, isObjectId } from "./paths.ts";
import { excludedByName } from "./policy.ts";
import { git, gitText, gitTry, type RepoContext } from "./runner.ts";
import type { EntryMode, ResolvedPolicy, Snapshot, SnapshotEntry, SkippedPath } from "./types.ts";

const ENTRY_MODES: readonly string[] = ["100644", "100755", "120000"];
const GITLINK_MODE = "160000";

export function splitNul(buffer: Buffer): Buffer[] {
	const parts: Buffer[] = [];
	let start = 0;
	for (let i = 0; i < buffer.length; i++) {
		if (buffer[i] === 0) {
			parts.push(buffer.subarray(start, i));
			start = i + 1;
		}
	}
	if (start < buffer.length) parts.push(buffer.subarray(start));
	return parts;
}

export function assertObjectId(value: string, what: string): void {
	if (!isObjectId(value)) throw new SnapshotPolicyError(`${what} is not a full object id`);
}

export async function assertTreeExists(ctx: RepoContext, tree: string, what = "tree"): Promise<void> {
	assertObjectId(tree, what);
	const result = await gitTry(ctx, ["cat-file", "-e", `${tree}^{tree}`]);
	if (result.code !== 0) {
		throw new SnapshotPolicyError(`${what} ${tree.slice(0, 12)} is not a tree in the object database`);
	}
}

/** Every entry of a tree, recursively, sorted by path bytes. Refuses gitlinks and unsafe paths. */
export async function lsTree(ctx: RepoContext, tree: string): Promise<SnapshotEntry[]> {
	assertObjectId(tree, "tree");
	const output = await git(ctx, ["ls-tree", "-r", "-z", "--full-tree", tree]);
	const entries: SnapshotEntry[] = [];
	for (const record of splitNul(output)) {
		const tab = record.indexOf(9);
		if (tab < 0) throw new GitCommandError("git ls-tree produced an unparseable record");
		const [mode, type, sha] = record.subarray(0, tab).toString("ascii").split(" ");
		const path = decodePath(record.subarray(tab + 1));
		assertSafeRelativePath(path);
		if (mode === undefined || type !== "blob" || sha === undefined || !ENTRY_MODES.includes(mode) || !isObjectId(sha)) {
			throw new UnsupportedPathError(
				path,
				mode === GITLINK_MODE ? "submodule (gitlink) entries are not supported" : `unsupported entry ${mode ?? "?"} ${type ?? "?"}`,
			);
		}
		entries.push({ path, mode: mode as EntryMode, type: "blob", sha });
	}
	return entries.sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * The manifest hash: sha256 over the lines `mode SP type SP sha SP path LF`, sorted by path bytes,
 * path bytes verbatim. Paths that are not valid UTF-8 or that contain a line break are refused
 * earlier (UnsupportedPathError), so a line is never ambiguous.
 */
export function manifestOf(entries: readonly SnapshotEntry[]): string {
	const sorted = [...entries].sort((a, b) => comparePaths(a.path, b.path));
	const hash = createHash("sha256");
	for (const entry of sorted) hash.update(`${entry.mode} ${entry.type} ${entry.sha} ${entry.path}\n`);
	return hash.digest("hex");
}

/** Every directory that holds at least one entry of the tree. */
export function directoriesOf(entries: readonly SnapshotEntry[]): Set<string> {
	const dirs = new Set<string>();
	for (const entry of entries) for (const dir of ancestorsOf(entry.path)) dirs.add(dir);
	return dirs;
}

type Candidate = { path: string; bytes: Buffer; dir: boolean; gitlink: boolean };

/**
 * Every path git considers part of the worktree: the tracked ones, the untracked and not ignored
 * ones, and the ignored ones under the allowlist. Nested repositories appear as directories.
 */
async function enumerate(ctx: RepoContext, policy: ResolvedPolicy): Promise<Map<string, Candidate>> {
	const candidates = new Map<string, Candidate>();
	const add = (bytes: Buffer, gitlink: boolean): void => {
		const dir = bytes.length > 0 && bytes[bytes.length - 1] === 0x2f;
		const clean = dir ? bytes.subarray(0, bytes.length - 1) : bytes;
		const key = clean.toString("latin1");
		const existing = candidates.get(key);
		if (existing) {
			existing.gitlink ||= gitlink;
			existing.dir ||= dir;
			return;
		}
		candidates.set(key, { path: clean.toString("utf8"), bytes: clean, dir, gitlink });
	};
	for (const record of splitNul(await git(ctx, ["ls-files", "-z", "-s"]))) {
		const tab = record.indexOf(9);
		if (tab < 0) throw new GitCommandError("git ls-files produced an unparseable record");
		add(record.subarray(tab + 1), record.subarray(0, 6).toString("ascii") === GITLINK_MODE);
	}
	for (const record of splitNul(await git(ctx, ["ls-files", "-z", "-o", "--exclude-standard"]))) add(record, false);
	if (policy.ignoredAllowlist.length > 0) {
		const pathspecs = policy.ignoredAllowlist.map((entry) => `:(literal)${entry}`);
		const args = ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--", ...pathspecs];
		for (const record of splitNul(await git(ctx, args))) add(record, false);
	}
	return candidates;
}

/**
 * Ignored files are not snapshotted, but an ignored file that looks like a secret (a git-ignored
 * `.env` is the common case) is still reported so the operator sees that it exists and is left alone.
 * Ignored directories are listed collapsed and not entered.
 */
async function ignoredSecrets(ctx: RepoContext, policy: ResolvedPolicy): Promise<string[]> {
	const found: string[] = [];
	const output = await git(ctx, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"]);
	for (const record of splitNul(output)) {
		if (record[record.length - 1] === 0x2f) continue;
		const path = record.toString("utf8");
		if (excludedByName(path, policy) === "secret-pattern") found.push(path);
	}
	return found;
}

/** True when every ancestor directory of `path` is a real directory (not a symlink, not a file). */
function parentsAreDirectories(root: string, path: string, cache: Map<string, boolean>): boolean {
	for (const dir of ancestorsOf(path)) {
		let ok = cache.get(dir);
		if (ok === undefined) {
			try {
				ok = lstatSync(join(root, dir)).isDirectory();
			} catch {
				// A missing ancestor means the path does not exist in the worktree (deleted tracked file).
				ok = false;
			}
			cache.set(dir, ok);
		}
		if (!ok) return false;
	}
	return true;
}

export type BuiltTree = { tree: string; skipped: SkippedPath[]; included: string[] };

/**
 * Store every included path as its RAW bytes and return the `update-index --index-info -z` records.
 *
 * `git add` would run the repository's attribute-driven conversions (`text=auto`, `eol`, `ident`,
 * clean/smudge filters, `core.autocrlf`) and store the converted blob, losing the original bytes;
 * restore writes blobs back verbatim and the verification re-hash would convert the same way, so the
 * loss would go unnoticed. `hash-object --no-filters` hashes the file as is, whatever `.gitattributes`,
 * `.git/info/attributes` or the config say. A symlink is hashed from its link target (hash-object
 * would follow the link). The mode follows git's own rule: 120000 for a link, 100755 when the owner
 * execute bit is set, 100644 otherwise.
 */
async function hashRawEntries(ctx: RepoContext, paths: readonly string[]): Promise<Buffer[]> {
	const modes = new Map<string, EntryMode>();
	const shas = new Map<string, string>();
	const files: string[] = [];
	for (const path of paths) {
		const stat = lstatSync(join(ctx.root, path));
		if (stat.isSymbolicLink()) {
			modes.set(path, "120000");
			const target = readlinkSync(join(ctx.root, path), { encoding: "buffer" });
			shas.set(path, (await gitText(ctx, ["hash-object", "-w", "--no-filters", "--stdin"], { input: target })).trim());
		} else {
			modes.set(path, (stat.mode & 0o100) !== 0 ? "100755" : "100644");
			files.push(path);
		}
	}
	if (files.length > 0) {
		// `--stdin-paths` unquotes a line that starts with a double quote; `./` keeps such a name literal.
		const input = `${files.map((path) => (path.startsWith('"') ? `./${path}` : path)).join("\n")}\n`;
		const lines = (await gitText(ctx, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { input })).split("\n");
		if (lines.length !== files.length) throw new GitCommandError("git hash-object returned an unexpected number of ids");
		for (const [index, path] of files.entries()) shas.set(path, (lines[index] ?? "").trim());
	}
	return paths.map((path) => {
		const sha = shas.get(path);
		if (sha === undefined || !isObjectId(sha)) throw new GitCommandError("git hash-object did not return an object id");
		return Buffer.concat([Buffer.from(`${modes.get(path)} ${sha}\t`, "ascii"), Buffer.from(path, "utf8"), Buffer.from([0])]);
	});
}

/** Build the tree of the worktree's current file state under a policy, without touching the real index. */
export async function buildTree(ctx: RepoContext, policy: ResolvedPolicy): Promise<BuiltTree> {
	const candidates = await enumerate(ctx, policy);
	const skipped = new Map<string, SkippedPath>();
	const included: string[] = [];
	const parentCache = new Map<string, boolean>();

	for (const candidate of candidates.values()) {
		const verdict = excludedByName(candidate.path, policy, candidate.dir);
		if (verdict === "excluded") continue;
		if (verdict === "secret-pattern") {
			skipped.set(candidate.path, { path: candidate.path, reason: "secret-pattern" });
			continue;
		}
		if (candidate.gitlink || candidate.dir) {
			skipped.set(candidate.path, { path: candidate.path, reason: "unsupported-submodule" });
			continue;
		}
		const path = decodePath(candidate.bytes);
		assertSafeRelativePath(path);
		if (!parentsAreDirectories(ctx.root, path, parentCache)) continue;
		let stat: Stats;
		try {
			stat = lstatSync(join(ctx.root, path));
		} catch {
			// Tracked in the index but deleted from the worktree: not part of the file state.
			continue;
		}
		if (stat.isDirectory()) continue;
		if (stat.isSymbolicLink()) {
			included.push(path);
		} else if (stat.isFile()) {
			if (stat.size > policy.maxFileBytes) skipped.set(path, { path, reason: "too-large" });
			else included.push(path);
		} else {
			skipped.set(path, { path, reason: "unsupported-filetype" });
		}
	}
	for (const path of await ignoredSecrets(ctx, policy)) {
		skipped.set(path, { path, reason: "secret-pattern" });
	}
	included.sort(comparePaths);

	const indexFile = join(ctx.gitDir, `substrate-index-${randomBytes(8).toString("hex")}`);
	const env = { GIT_INDEX_FILE: indexFile };
	try {
		await git(ctx, ["read-tree", "--empty"], { env });
		if (included.length > 0) {
			const records = await hashRawEntries(ctx, included);
			await git(ctx, ["update-index", "-z", "--index-info"], { env, input: Buffer.concat(records) });
		}
		const tree = await gitText(ctx, ["write-tree"], { env });
		assertObjectId(tree, "write-tree output");
		return { tree, skipped: [...skipped.values()].sort((a, b) => comparePaths(a.path, b.path)), included };
	} finally {
		rmSync(indexFile, { force: true });
		rmSync(`${indexFile}.lock`, { force: true });
	}
}

/** A Snapshot of a tree already in the object database. */
export async function snapshotOfTree(
	ctx: RepoContext,
	tree: string,
	extra: { skipped: SkippedPath[]; headCommit: string | null; branch: string | null },
): Promise<Snapshot> {
	const entries = await lsTree(ctx, tree);
	return {
		version: 1,
		tree,
		headCommit: extra.headCommit,
		branch: extra.branch,
		manifestSha256: manifestOf(entries),
		entries,
		skipped: extra.skipped,
		createdAt: ctx.now().toISOString(),
	};
}

export async function buildSnapshot(ctx: RepoContext, policy: ResolvedPolicy): Promise<Snapshot> {
	const built = await buildTree(ctx, policy);
	const head = await gitTry(ctx, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
	const branch = await gitTry(ctx, ["symbolic-ref", "-q", "--short", "HEAD"]);
	return snapshotOfTree(ctx, built.tree, {
		skipped: built.skipped,
		headCommit: head.code === 0 ? head.stdout.toString("utf8").trim() : null,
		branch: branch.code === 0 ? branch.stdout.toString("utf8").trim() : null,
	});
}

export type RawChange = {
	status: "A" | "D" | "M" | "T";
	srcMode: string;
	dstMode: string;
	srcSha: string;
	dstSha: string;
	path: string;
};

/** `git diff-tree -r -z --raw --no-renames` between two trees. */
export async function diffTrees(ctx: RepoContext, from: string, to: string): Promise<RawChange[]> {
	assertObjectId(from, "tree");
	assertObjectId(to, "tree");
	const output = await git(ctx, ["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", from, to]);
	const parts = splitNul(output);
	const changes: RawChange[] = [];
	for (let i = 0; i < parts.length; i += 2) {
		const meta = parts[i]?.toString("ascii");
		const pathBytes = parts[i + 1];
		if (meta === undefined || pathBytes === undefined || !meta.startsWith(":")) {
			throw new GitCommandError("git diff-tree produced an unparseable record");
		}
		const [srcMode, dstMode, srcSha, dstSha, status] = meta.slice(1).split(" ");
		if (
			srcMode === undefined ||
			dstMode === undefined ||
			srcSha === undefined ||
			dstSha === undefined ||
			(status !== "A" && status !== "D" && status !== "M" && status !== "T")
		) {
			throw new GitCommandError("git diff-tree produced an unexpected status");
		}
		const path = decodePath(pathBytes);
		assertSafeRelativePath(path);
		changes.push({ status, srcMode, dstMode, srcSha, dstSha, path });
	}
	return changes;
}
