/**
 * Whether removing a workspace directory (`<root>/<graph_id>`) would lose work. The removal itself knows nothing
 * of git, so this runs before it. Every member worktree must be clean (untracked files included), fully pushed, free
 * of ignored work only it holds, and free of submodules, whose files are not checked. The workspace must hold no
 * primary checkout, no entry outside every member (a removal would delete it unchecked), and no `.planning/` directory,
 * which lives outside git.
 *
 * Read-only by construction: it runs `git status`, `git rev-list`, `git ls-files` (directly and through
 * `findIgnoredWork`), `git worktree list` and the discovery reads of `discoverRepos`. It never removes a worktree,
 * deletes a branch or writes to a repository. Every probe that fails is a refusal: an unknown fact is never a pass.
 */
import { type Dirent, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { GitRunner } from "./git.ts";
import { findIgnoredWork, type IgnoredOptions, UNKNOWN_IGNORED } from "./ignored.ts";
import { discoverRepos, listWorktrees } from "./inventory.ts";
import { mapLimit } from "./pool.ts";

export const PLANNING_REFUSAL = "workspace .planning is outside git: copy it out first";
export const PRIMARY_REFUSAL = "primary checkout inside the workspace: never removed by a workspace removal";
export const LOOSE_REFUSAL = "outside every git worktree, so removing the workspace would delete it unchecked: copy it out first";

const GUARD_CONCURRENCY = 4;
/** Ignored paths named in one refusal before the rest are counted. */
const SHOWN_IGNORED = 10;
/** `git ls-files --stage` prints a submodule (a gitlink) with this mode. */
const GITLINK_MODE = "160000 ";

export interface WorkspaceGuardOptions {
	/** Budgets for the ignored-work scan. */
	ignored?: IgnoredOptions;
}

export interface WorkspaceGuardResult {
	/** True only when every member was probed and none holds work. */
	ok: boolean;
	/** One line per reason to refuse, naming the path it concerns. */
	refusals: string[];
}

interface Member {
	path: string;
	/** The primary checkout of the member's repository: the copy `findIgnoredWork` compares against. */
	primaryDir: string;
	/** True for a primary checkout, which a workspace removal must never take. */
	primary: boolean;
}

interface Discovered {
	members: Member[];
	/** Discovery or listing that could not be completed; each one is a refusal. */
	notes: string[];
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** True when `path` is `root` or a path below it; both are canonical. */
function isInside(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The child directories of `root`; a root that cannot be read is a note and has none. Links are not directories here. */
function childDirectories(root: string, notes: string[]): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, entry.name));
	} catch {
		notes.push(`could not read ${root}`);
		return [];
	}
}

/**
 * The member worktrees below `root`, primary checkouts included. Repositories are found first: `discoverRepos` reads
 * `.git` entries to a fixed depth, and the root and its direct children that hold a `.git` are added. Each repository
 * is listed once and only the worktrees inside the root are kept, so a repository's unrelated worktrees are never
 * probed.
 */
async function discoverMembers(root: string, git: GitRunner): Promise<Discovered> {
	const discovery = await discoverRepos([root], { git });
	const notes = [...discovery.notes];
	const candidates = new Set(discovery.repos.map((repo) => canonical(repo.dir)));
	if (existsSync(join(root, ".git"))) candidates.add(root);
	for (const child of childDirectories(root, notes)) if (existsSync(join(child, ".git"))) candidates.add(canonical(child));
	const members = new Map<string, Member>();
	for (const dir of candidates) {
		const listed = await listWorktrees(dir, git);
		const primary = listed?.[0];
		if (listed === null || primary === undefined) {
			notes.push(`git worktree list failed in ${dir}`);
			continue;
		}
		for (const entry of listed) {
			const key = canonical(entry.path);
			if (entry.bare || !isInside(key, root) || members.has(key)) continue;
			members.set(key, { path: entry.path, primaryDir: primary.path, primary: entry.primary });
		}
	}
	return { members: [...members.values()], notes };
}

/**
 * The entries below `dir` that no member owns and that hold no member: a removal would delete them with nothing
 * checking them. Only real directories are searched on, so the walk is a tree that cannot revisit a directory; a
 * symbolic link is refused as it stands and its target is never read. A member's own contents are its own probes'
 * business. The root's `.planning/` has its own refusal and is skipped here.
 */
function looseRefusals(dir: string, members: readonly string[], root: string): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [`${dir}: could not be listed, so its files cannot be ruled out`];
	}
	const out: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (path === join(root, ".planning")) continue;
		if (entry.isSymbolicLink()) {
			out.push(`${path}: ${LOOSE_REFUSAL}`);
			continue;
		}
		const real = canonical(path);
		if (members.includes(real)) continue;
		if (entry.isDirectory() && members.some((member) => isInside(member, real))) out.push(...looseRefusals(path, members, root));
		else out.push(`${path}: ${LOOSE_REFUSAL}`);
	}
	return out;
}

function ignoredReasons(paths: readonly string[]): string[] {
	const known = paths.filter((path) => path !== UNKNOWN_IGNORED);
	const reasons: string[] = [];
	if (known.length > 0) {
		const more = known.length > SHOWN_IGNORED ? ` and ${known.length - SHOWN_IGNORED} more` : "";
		reasons.push(`ignored work would be lost: ${known.slice(0, SHOWN_IGNORED).join(", ")}${more}`);
	}
	if (paths.includes(UNKNOWN_IGNORED)) reasons.push("ignored files could not all be listed, so ignored work cannot be ruled out");
	return reasons;
}

/** Every reason one member must not be removed; empty when it is clean, pushed, and holds no ignored work or submodule. */
async function probe(member: Member, git: GitRunner, options: WorkspaceGuardOptions): Promise<string[]> {
	const reasons: string[] = [];
	// `--untracked-files=all` overrides `status.showUntrackedFiles`, which a user may set to hide new files.
	const status = await git(["status", "--porcelain", "--untracked-files=all"], member.path);
	if (status.code !== 0) reasons.push(`git status failed (exit ${status.code}), so uncommitted work cannot be ruled out`);
	else if (status.stdout.trim() !== "") reasons.push("uncommitted changes");
	const unpushed = await git(["rev-list", "--count", "HEAD", "--not", "--remotes"], member.path);
	const count = unpushed.stdout.trim();
	if (unpushed.code !== 0 || !/^\d+$/.test(count)) reasons.push(`git rev-list failed (exit ${unpushed.code}), so unpushed commits cannot be ruled out`);
	else if (Number(count) > 0) reasons.push(`${count} unpushed commit(s)`);
	const tracked = await git(["ls-files", "--stage", "-z"], member.path);
	if (tracked.code !== 0) reasons.push(`git ls-files failed (exit ${tracked.code}), so submodules cannot be ruled out`);
	else {
		const submodules = tracked.stdout
			.split("\0")
			.filter((entry) => entry.startsWith(GITLINK_MODE))
			.map((entry) => entry.slice(entry.indexOf("\t") + 1));
		if (submodules.length > 0) reasons.push(`contains submodule(s) at ${submodules.join(", ")}: their files are not checked`);
	}
	reasons.push(...ignoredReasons(await findIgnoredWork(member.path, member.primaryDir, git, options.ignored)));
	return reasons.map((reason) => `${member.path}: ${reason}`);
}

/**
 * Whether the workspace at `root` can be removed without losing work. Reads only: see the module comment. The
 * refusals are ordered: discovery problems, each primary checkout, loose entries, then each member's reasons (every
 * member is still probed, so its state is reported), then the workspace's own `.planning/`.
 */
export async function workspaceGuard(root: string, git: GitRunner, options: WorkspaceGuardOptions = {}): Promise<WorkspaceGuardResult> {
	const rootReal = canonical(resolve(root));
	const discovered = await discoverMembers(rootReal, git);
	const memberPaths = discovered.members.map((member) => canonical(member.path));
	const refusals = discovered.notes.map((note) => `could not check ${root}: ${note}`);
	for (const member of discovered.members) if (member.primary) refusals.push(`${member.path}: ${PRIMARY_REFUSAL}`);
	// A root that is itself a member owns everything below it, so only a root that is not one has loose entries.
	if (!memberPaths.includes(rootReal)) refusals.push(...looseRefusals(rootReal, memberPaths, rootReal));
	const probes = await mapLimit(discovered.members, GUARD_CONCURRENCY, (member) => probe(member, git, options));
	refusals.push(...probes.flat());
	if (existsSync(join(rootReal, ".planning"))) refusals.push(PLANNING_REFUSAL);
	return { ok: refusals.length === 0, refusals };
}
