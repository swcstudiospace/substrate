/**
 * Whether removing a workspace directory (`<root>/<graph_id>`) would lose work. The removal itself knows nothing
 * of git, so this runs before it: every member worktree must be clean, fully pushed and free of ignored work that
 * only it holds, and the workspace must hold no `.planning/` directory, which lives outside git.
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
 * The member worktrees below `root`. First from `collectInventory`, which finds repositories through their `.git`
 * entries; when that finds no linked worktree under the root, from the direct children of the root that have a `.git`.
 */
async function discoverMembers(root: string, git: GitRunner): Promise<Discovered> {
	const inventory = await collectInventory([root], { git, measure: false, ignored: false });
	const under = inventory.worktrees.filter((wt) => isInside(canonical(wt.path), root));
	if (under.some((wt) => !wt.primary)) return { members: under.map((wt) => ({ path: wt.path, primaryDir: wt.repo_dir })), notes: inventory.notes };
	return fromChildren(root, git, [...inventory.notes]);
}

async function fromChildren(root: string, git: GitRunner, notes: string[]): Promise<Discovered> {
	let names: string[];
	try {
		names = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return { members: [], notes: [...notes, `could not read ${root}`] };
	}
	const members = new Map<string, Member>();
	for (const name of names) {
		const child = join(root, name);
		if (!existsSync(join(child, ".git"))) continue;
		const listed = await listWorktrees(child, git);
		const primary = listed?.[0];
		if (listed === null || primary === undefined) {
			notes.push(`git worktree list failed in ${child}`);
			continue;
		}
		for (const entry of listed) {
			if (entry.bare || !isInside(canonical(entry.path), root)) continue;
			members.set(canonical(entry.path), { path: entry.path, primaryDir: primary.path });
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
 * refusals are ordered: discovery problems, then each member's reasons, then the workspace's own `.planning/`.
 */
export async function workspaceGuard(root: string, git: GitRunner, options: WorkspaceGuardOptions = {}): Promise<WorkspaceGuardResult> {
	const rootReal = canonical(resolve(root));
	const discovered = await discoverMembers(rootReal, git);
	const refusals = discovered.notes.map((note) => `could not check ${root}: ${note}`);
	const probes = await mapLimit(discovered.members, GUARD_CONCURRENCY, (member) => probe(member, git, options));
	refusals.push(...probes.flat());
	if (existsSync(join(rootReal, ".planning"))) refusals.push(PLANNING_REFUSAL);
	return { ok: refusals.length === 0, refusals };
}
