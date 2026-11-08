/**
 * `substrate worktree` under the repository scope (phase 72).
 *
 * The local commands run git on the paths they are given, so every such path is placed before the command runs:
 *
 * - a root must lie inside a registered directory of a repository the surface is granted;
 * - `--repo` names a granted repository (`owner/name`) or a directory that lies inside one;
 * - `provision` checks its `--repo` checkout and the target it creates, which must sit in the same repository;
 * - `merge-back` and `guard` check each path they are given.
 *
 * A refusal exits 2 with the reason and runs no git: the dispatcher calls {@link scopeRefusal} before any command. Scoping
 * off (`SUBSTRATE_REPO_SCOPES` unset) changes nothing. A malformed registry or grant refuses, as it refuses the server's boot.
 *
 * The local commands act as surface `claude-code`, the surface they post and claim as. Their grant is read from the CLI's
 * own environment, the same variables the server reads. A refusal is audited as a ledger warning that names the reason and a
 * digest of the requested value; the write is fail-open, so a ledger that is down never lets a refused command run.
 */
import { resolve } from "node:path";
import {
	authorizeRepo,
	authorizeRepoPath,
	REPO_REFUSAL_MESSAGES,
	repoRefusalPayload,
	repoScopeFromEnv,
	type RepoGate,
	type RepoScope,
	type RepoRefusalReason,
	scopeRepoId,
} from "../../../mcp-server/src/repo-scope.ts";
import type { WorktreeArgs } from "./args.ts";
import type { WorktreeDeps } from "./command.ts";

/** The surface the local worktree commands act as. */
export const LOCAL_SURFACE = "claude-code" as const;

interface Refused {
	reason: RepoRefusalReason;
	requested: string;
	route: string;
}

/**
 * The directory `provision` creates: `--path` when given, else the branch name under the first root. Null when neither is
 * available, which the command reports as a usage error.
 */
export function provisionTarget(args: WorktreeArgs, cwd: string, firstRoot: string | undefined): string | null {
	if (args.path !== undefined) return resolve(cwd, args.path);
	if (firstRoot === undefined || args.branch === undefined) return null;
	return resolve(firstRoot, args.branch.replace(/[\\/]/g, "-"));
}

/** `--repo` names a repository when it is `owner/name`; anything else (an absolute or dotted directory) is a directory. */
function namesRepository(value: string): boolean {
	return scopeRepoId(value) !== "";
}

function refusedBy(gate: RepoGate, requested: string, route: string): Refused | null {
	return gate.ok ? null : { reason: gate.reason, requested, route };
}

function firstRefusal(scope: RepoScope, args: WorktreeArgs, cwd: string, rootList: readonly string[]): Refused | null {
	const route = `worktree_${args.command}`;
	const checks: Array<Refused | null> = [];
	if (args.command === "provision") {
		const repoDir = args.repo === undefined ? null : resolve(cwd, args.repo);
		const repoGate = repoDir === null ? null : authorizeRepoPath(scope, LOCAL_SURFACE, repoDir, null);
		if (repoDir !== null && repoGate !== null) checks.push(refusedBy(repoGate, args.repo ?? repoDir, route));
		const target = provisionTarget(args, cwd, rootList[0]);
		if (target !== null && repoGate?.ok) {
			checks.push(refusedBy(authorizeRepoPath(scope, LOCAL_SURFACE, target, repoGate.repo), target, route));
		}
		return checks.find((check): check is Refused => check !== null) ?? null;
	}
	if (args.command === "guard") {
		for (const dir of [...args.positional, ...args.roots]) checks.push(refusedBy(authorizeRepoPath(scope, LOCAL_SURFACE, resolve(cwd, dir), null), dir, route));
		return checks.find((check): check is Refused => check !== null) ?? null;
	}
	if (args.repo !== undefined) {
		const gate = namesRepository(args.repo)
			? authorizeRepo(scope, LOCAL_SURFACE, args.repo)
			: authorizeRepoPath(scope, LOCAL_SURFACE, resolve(cwd, args.repo), null);
		checks.push(refusedBy(gate, args.repo, route));
	}
	if (args.command === "merge-back") {
		for (const path of args.positional) checks.push(refusedBy(authorizeRepoPath(scope, LOCAL_SURFACE, resolve(cwd, path), null), path, route));
	}
	for (const root of rootList) checks.push(refusedBy(authorizeRepoPath(scope, LOCAL_SURFACE, root, null), root, route));
	return checks.find((check): check is Refused => check !== null) ?? null;
}

/**
 * The refusal message for `args`, or null when the command may run. Called once, before any git call, with the roots the
 * command would use. Audits a refusal fail-open.
 */
export async function scopeRefusal(args: WorktreeArgs, deps: WorktreeDeps, rootList: readonly string[]): Promise<string | null> {
	const parsed = repoScopeFromEnv(deps.env);
	if (!parsed.ok) return `${parsed.problem}; nothing was run\n`;
	if (!parsed.value.enforced) return null;
	const refused = firstRefusal(parsed.value, args, deps.cwd, rootList);
	if (refused === null) return null;
	await deps.emit({
		surface: LOCAL_SURFACE,
		kind: "warning",
		summary: `repo request refused: ${refused.reason}`,
		payload: repoRefusalPayload(refused.route, refused.reason, refused.requested),
	});
	return `refused: ${REPO_REFUSAL_MESSAGES[refused.reason]}; nothing was run\n`;
}
