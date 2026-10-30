/**
 * Whether removing a workspace directory (`<root>/<graph_id>`) would lose work. The removal itself knows nothing
 * of git, so this runs before it: every member worktree must be clean, fully pushed and free of ignored work that
 * only it holds, the workspace must hold no primary checkout (a `.git` directory: a removal must never take one), and
 * the workspace must hold no `.planning/` directory, which lives outside git.
 *
 * Read-only by construction: it runs `git status`, `git rev-list`, `git ls-files` (through `findIgnoredWork`),
 * `git worktree list` and the read-only probes of `collectInventory`. It never removes a worktree, deletes a branch
 * or writes to a repository. Every probe that fails is a refusal: an unknown fact is never a pass.
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { GitRunner } from "./git.ts";
import { findIgnoredWork, type IgnoredOptions, UNKNOWN_IGNORED } from "./ignored.ts";
import { collectInventory, listWorktrees } from "./inventory.ts";
import { mapLimit } from "./pool.ts";

export const PLANNING_REFUSAL = "workspace .planning is outside git: copy it out first";
export const PRIMARY_REFUSAL = "primary checkout inside the workspace: never removed by a workspace removal";

const GUARD_CONCURRENCY = 4;
/** Ignored paths named in one refusal before the rest are counted. */
const SHOWN_IGNORED = 10;

export interface WorkspaceGuardOptions {
	/** Budgets for the ignored-work scan. */
	ignored?: IgnoredOptions;
}

export interface WorkspaceGuardResult {
	/** True only when every member was probed and none holds work. */
	ok: boolean;
	/** One line per reason to refuse, naming the worktree it concerns. */
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

/**
 * The member worktrees below `root`, primary checkouts included. `collectInventory` finds repositories through their
 * `.git` entries at any depth below the root, nested primaries too. The root and its direct children that have a `.git`
 * are listed as well, so a primary that is the root itself, or that has no linked worktree to lead the inventory to it,
 * is still found. Each worktree is named once.
 */
async function discoverMembers(root: string, git: GitRunner): Promise<Discovered> {
	const inventory = await collectInventory([root], { git, measure: false, ignored: false });
	const members = new Map<string, Member>();
	for (const wt of inventory.worktrees) {
		if (isInside(canonical(wt.path), root)) members.set(canonical(wt.path), { path: wt.path, primaryDir: wt.repo_dir, primary: wt.primary });
	}
	const direct = await fromDirectories(root, git, [...inventory.notes]);
	for (const member of direct.members) if (!members.has(canonical(member.path))) members.set(canonical(member.path), member);
	return { members: [...members.values()], notes: direct.notes };
}

async function fromDirectories(root: string, git: GitRunner, notes: string[]): Promise<Discovered> {
	let names: string[];
	try {
		names = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return { members: [], notes: [...notes, `could not read ${root}`] };
	}
	const candidates = [root, ...names.map((name) => join(root, name))].filter((dir) => existsSync(join(dir, ".git")));
	const members = new Map<string, Member>();
	for (const dir of candidates) {
		const listed = await listWorktrees(dir, git);
		const primary = listed?.[0];
		if (listed === null || primary === undefined) {
			notes.push(`git worktree list failed in ${dir}`);
			continue;
		}
		for (const entry of listed) {
			if (entry.bare || !isInside(canonical(entry.path), root)) continue;
			members.set(canonical(entry.path), { path: entry.path, primaryDir: primary.path, primary: entry.primary });
		}
	}
	return { members: [...members.values()], notes };
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

/** Every reason one member must not be removed; empty when it is clean, pushed and holds no ignored work. */
async function probe(member: Member, git: GitRunner, options: WorkspaceGuardOptions): Promise<string[]> {
	const reasons: string[] = [];
	const status = await git(["status", "--porcelain"], member.path);
	if (status.code !== 0) reasons.push(`git status failed (exit ${status.code}), so uncommitted work cannot be ruled out`);
	else if (status.stdout.trim() !== "") reasons.push("uncommitted changes");
	const unpushed = await git(["rev-list", "--count", "HEAD", "--not", "--remotes"], member.path);
	const count = unpushed.stdout.trim();
	if (unpushed.code !== 0 || !/^\d+$/.test(count)) reasons.push(`git rev-list failed (exit ${unpushed.code}), so unpushed commits cannot be ruled out`);
	else if (Number(count) > 0) reasons.push(`${count} unpushed commit(s)`);
	reasons.push(...ignoredReasons(await findIgnoredWork(member.path, member.primaryDir, git, options.ignored)));
	return reasons.map((reason) => `${member.path}: ${reason}`);
}

/**
 * Whether the workspace at `root` can be removed without losing work. Reads only: see the module comment. The
 * refusals are ordered: discovery problems, then each primary checkout, then each member's reasons (every member is
 * still probed, so its state is reported), then the workspace's own `.planning/`.
 */
export async function workspaceGuard(root: string, git: GitRunner, options: WorkspaceGuardOptions = {}): Promise<WorkspaceGuardResult> {
	const rootReal = canonical(resolve(root));
	const discovered = await discoverMembers(rootReal, git);
	const refusals = discovered.notes.map((note) => `could not check ${root}: ${note}`);
	for (const member of discovered.members) if (member.primary) refusals.push(`${member.path}: ${PRIMARY_REFUSAL}`);
	const probes = await mapLimit(discovered.members, GUARD_CONCURRENCY, (member) => probe(member, git, options));
	refusals.push(...probes.flat());
	if (existsSync(join(rootReal, ".planning"))) refusals.push(PLANNING_REFUSAL);
	return { ok: refusals.length === 0, refusals };
}
