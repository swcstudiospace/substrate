/**
 * The prune decision for one inspected worktree, as a pure function of facts already gathered.
 *
 * `never` is for anything whose removal could lose work or break a live session. `safe` needs every
 * one of: clean, head pushed, idle past the threshold (by last commit and by newest file), the
 * current HEAD proven merged, and no live graph claim. A branch name or a pull-request state alone proves
 * nothing: a branch can gain commits after its pull request merged and still be clean and pushed, so the proof
 * is the commit itself, either in the default branch or equal to the head commit of a merged pull request
 * (a squash merge leaves HEAD out of the default branch, so the PR head comparison is what proves it).
 * A live claim on the worktree's graph is a session at work in a checkout whose files may not have changed:
 * `never`. A claim that could not be checked is an unknown, and an unknown fact is never evidence: it lands in `review`.
 */
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { type ClaimStatus, NOT_CHECKED } from "./claims.ts";
import type { WorktreeInfo } from "./inventory.ts";

export type PruneClass = "safe" | "review" | "never";

export interface PruneClassification {
	class: PruneClass;
	reasons: string[];
}

export interface PruneContext {
	/** The caller's working directory: a worktree that contains it is never removed. */
	cwd: string;
	idleDays: number;
	now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const IGNORED_SHOWN = 5;

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function contains(parent: string, child: string): boolean {
	const base = real(parent);
	const target = real(child);
	return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function idleReason(label: string, iso: string | null, ctx: PruneContext): string | null {
	if (iso === null) return `${label} is unknown`;
	const age = ctx.now.getTime() - new Date(iso).getTime();
	if (!(age >= ctx.idleDays * DAY_MS)) return `${label} ${iso} is within the last ${ctx.idleDays} days`;
	return null;
}

export function classifyForPrune(info: WorktreeInfo, ctx: PruneContext, claim: ClaimStatus = NOT_CHECKED): PruneClassification {
	const never: string[] = [];
	if (info.primary) never.push("primary checkout");
	if (contains(info.path, ctx.cwd)) never.push("contains the current working directory");
	if (info.locked) never.push("locked");
	if (claim.state === "live") {
		const first = claim.claims[0];
		const detail = first === undefined ? "" : ` (node ${first.node_id}${first.holder === null ? "" : `, held by ${first.holder.surface}`}${first.expires_at === null ? "" : `, until ${first.expires_at}`})`;
		never.push(`live claim on graph ${claim.graph_id}${detail}`);
	}
	if (info.dirty) never.push("has uncommitted or untracked changes");
	if (never.length === 0 && info.prunable) {
		return { class: "review", reasons: ["git lists it but the directory is missing; git worktree prune drops the record"] };
	}
	const mergedByPr = info.pr_merged_heads.includes(info.head);
	// A merged pull request's head is kept by GitHub, so it counts as pushed even after the branch is deleted.
	if (!info.pushed && !mergedByPr) {
		never.push(info.detached ? "detached HEAD with commits that are on no remote branch" : "head is not pushed");
	}
	if (never.length > 0) return { class: "never", reasons: never };

	const review: string[] = [];
	if (claim.state === "unverified") review.push(`claims-unverified: could not confirm that graph ${claim.graph_id} has no live claim (${claim.reason})`);
	if (info.ignored_work.length > 0) {
		const shown = info.ignored_work.slice(0, IGNORED_SHOWN).join(", ");
		const more = info.ignored_work.length > IGNORED_SHOWN ? ` (and ${info.ignored_work.length - IGNORED_SHOWN} more)` : "";
		// git worktree remove deletes ignored files without asking, so they count as work.
		review.push(`ignored-files: ${shown}${more}`);
	}
	const idleCommit = idleReason("last commit time", info.last_commit_at, ctx);
	if (idleCommit !== null) review.push(idleCommit);
	const idleFiles = idleReason("last file activity", info.last_activity_at, ctx);
	if (idleFiles !== null) review.push(idleFiles);
	let proof: string | null = null;
	if (info.merged === true) proof = `HEAD is in ${info.default_ref ?? "the default branch"}`;
	else if (mergedByPr) proof = `HEAD is the head commit of merged pull request${info.pr_number === null ? "" : ` #${info.pr_number}`}`;
	else if (info.pr_state === "merged") review.push("branch advanced after its pull request merged: HEAD is not the merged head and not in the default branch");
	else if (info.merged === false) review.push(`HEAD is not in ${info.default_ref ?? "the default branch"} and no merged pull request has it as head (pull request: ${info.pr_state})`);
	else review.push(`cannot prove HEAD is merged (pull request: ${info.pr_state}, default branch ${info.default_ref ?? "unknown"})`);
	if (review.length > 0) return { class: "review", reasons: review };
	return { class: "safe", reasons: ["clean", "head pushed", ...(proof === null ? [] : [proof]), `idle for at least ${ctx.idleDays} days`] };
}
