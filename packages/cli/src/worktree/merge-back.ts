/**
 * `substrate worktree merge-back PATH... [--execute] [--json]`: records in the ledger that a linked worktree's work is
 * already on the default branch. It never merges into the primary checkout and never removes anything: the note is the
 * proof, and the folder is kept and marked `retained`.
 *
 * Each path is decided from git as it is now, never from an inventory. A worktree is eligible only when every one of
 * these holds: it is a linked worktree of a repository git lists (the primary checkout is refused); it is clean, with no
 * uncommitted or untracked change; its head is pushed; its head is proven merged, as an ancestor of the default branch or
 * the head of a merged pull request; it holds no ignored work (a listing that could not be completed counts as work); and
 * no live graph claim is on it. A claim that could not be asked about refuses. A checkout outside every configured root
 * is not a graph checkout, so no claim can be on it and nobody is asked. A refused worktree is never recorded.
 *
 * A dry run is the default and writes nothing. With `--execute` each eligible worktree is decided again immediately before
 * its note is emitted. Every git command here is a read. Exit codes: 0 when every requested worktree was eligible and its
 * note recorded (or would be, in a dry run), 1 when any was refused or a note was not recorded, 2 for usage.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { EmitOutcome } from "../../../collectors/src/emit.ts";
import { graphIdForWorktree } from "../../../collectors/src/worktree-graph.ts";
import {
	type ClaimStatus,
	claimStatus,
	createPrShared,
	findIgnoredWork,
	inspectWorktree,
	listWorktrees,
	NOT_CHECKED,
	reloadWorktree,
	UNKNOWN_IGNORED,
	type WorktreeInfo,
} from "../../../fleet/src/index.ts";
import type { EventInput } from "../../../mcp-server/src/types.ts";
import type { WorktreeArgs } from "./args.ts";
import type { WorktreeDeps } from "./command.ts";

/** Ignored paths a refusal names before it only counts the rest. */
const IGNORED_SHOWN = 5;
const USAGE = "merge-back needs at least one worktree path: substrate worktree merge-back PATH... [--execute] [--json]\n";

type MergedVia = "default-branch" | "pull-request";
/** How the ledger took a note. `spooled` means parked for replay: the note is not recorded yet. */
type Delivery = "stored" | "refused" | "failed" | "spooled";

type Decision = { eligible: true; info: WorktreeInfo; mergedVia: MergedVia } | { eligible: false; reasons: string[] };

interface Recorded {
	path: string;
	repo: string;
	branch: string | null;
	head: string;
	merged_via: MergedVia;
	/** How the ledger took the note; null when nothing was emitted (a dry run). */
	ledger: Delivery | null;
}

interface Refused {
	path: string;
	reasons: string[];
}

function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function ignoredReason(paths: readonly string[]): string {
	const known = paths.filter((item) => item !== UNKNOWN_IGNORED);
	const parts: string[] = [];
	if (known.length > 0) {
		const more = known.length > IGNORED_SHOWN ? ` (and ${known.length - IGNORED_SHOWN} more)` : "";
		parts.push(`ignored work: ${known.slice(0, IGNORED_SHOWN).join(", ")}${more}`);
	}
	if (paths.includes(UNKNOWN_IGNORED)) parts.push("ignored files could not all be listed, so ignored work cannot be ruled out");
	return parts.join("; ");
}

/** Whether the worktree at `path` may be recorded, and if not, why. Reads git and the server only. */
async function decide(path: string, rootList: readonly string[], deps: WorktreeDeps): Promise<Decision> {
	const refuse = (reasons: string[]): Decision => ({ eligible: false, reasons });
	const listing = await listWorktrees(path, deps.git);
	if (listing === null) return refuse(["git could not list the worktrees of this path"]);
	const primary = listing.find((entry) => entry.primary);
	if (primary === undefined || primary.bare) return refuse(["the repository has no primary checkout to compare against"]);
	const entry = listing.find((item) => realPath(item.path) === realPath(path));
	if (entry === undefined) return refuse(["not a worktree of the repository git lists for this path"]);
	if (entry.primary) return refuse(["the primary checkout is never merged back"]);
	const input = await reloadWorktree(entry.path, primary.path, deps.git);
	if (input === null) return refuse(["git no longer lists this worktree"]);
	// Ignored files are asked for below through findIgnoredWork, so inspection skips its own copy of that listing.
	const info = await inspectWorktree(input, { git: deps.git, pr: createPrShared(deps.gh), measure: false, ignored: false });

	const reasons: string[] = [];
	if (info.prunable) reasons.push("the worktree directory is missing");
	if (info.dirty) reasons.push("has uncommitted or untracked changes");
	if (!info.pushed) reasons.push("head is not pushed");
	let mergedVia: MergedVia | null = null;
	if (info.merged === true) mergedVia = "default-branch";
	else if (info.pr_merged_heads.includes(info.head)) mergedVia = "pull-request";
	else reasons.push(`HEAD is not proven merged: it is not in ${info.default_ref ?? "the default branch"} and no merged pull request has it as head (pull request: ${info.pr_state})`);
	const ignored = await findIgnoredWork(info.path, info.repo_dir, deps.git);
	if (ignored.length > 0) reasons.push(ignoredReason(ignored));
	const graphId = graphIdForWorktree(info.path, rootList);
	const claim: ClaimStatus = graphId === null ? NOT_CHECKED : await claimStatus(graphId, deps.claims);
	if (claim.state === "live") reasons.push(`live claim on graph ${claim.graph_id}`);
	if (claim.state === "unverified") reasons.push(`claims-unverified: could not confirm that graph ${claim.graph_id} has no live claim (${claim.reason})`);
	if (reasons.length > 0 || mergedVia === null) return refuse(reasons);
	return { eligible: true, info, mergedVia };
}

/** The note that is the proof. It names the worktree by repository and branch, never by path. */
function mergeBackNote(info: WorktreeInfo, mergedVia: MergedVia): EventInput {
	return {
		surface: "claude-code",
		kind: "note",
		summary: `worktree merged back: ${info.repo} ${info.branch ?? info.head.slice(0, 12)}`,
		...(info.repo.startsWith("local/") ? {} : { repo: info.repo }),
		...(info.branch === null ? {} : { branch: info.branch }),
		payload: { action: "worktree.merge_back", repo: info.repo, branch: info.branch, head: info.head, merged_via: mergedVia, retained: true },
	};
}

function delivery(outcome: EmitOutcome): Delivery {
	if (outcome.kind === "stored" || outcome.kind === "refused") return outcome.kind;
	return outcome.spooled === true ? "spooled" : "failed";
}

function ledgerLine(outcome: EmitOutcome): string {
	if (outcome.kind === "stored") return "ledger: worktree.merge_back note recorded";
	const why = outcome.kind === "refused" ? `refused (HTTP ${outcome.status})` : `failed (${outcome.error ?? "no answer"})${outcome.spooled === true ? ", parked in the event spool" : ""}`;
	return `ledger: worktree.merge_back note NOT RECORDED: ${why}. The worktree is kept and nothing was merged.`;
}

/** `commandMergeBack` for `args.positional` paths; `rootList` is the configured worktree roots and is never empty here. */
export async function commandMergeBack(args: WorktreeArgs, deps: WorktreeDeps, rootList: readonly string[]): Promise<number> {
	if (args.positional.length === 0) {
		deps.err(USAGE);
		return 2;
	}
	const paths = [...new Set(args.positional.map((path) => realPath(resolve(deps.cwd, path))))];
	const recorded: Recorded[] = [];
	const refused: Refused[] = [];
	for (const path of paths) {
		const decision = await decide(path, rootList, deps);
		if (!decision.eligible) {
			refused.push({ path, reasons: decision.reasons });
			if (!args.json) deps.out(`refused ${path}: ${decision.reasons.join("; ")}\n`);
			continue;
		}
		const { info, mergedVia } = decision;
		const item: Recorded = { path, repo: info.repo, branch: info.branch, head: info.head, merged_via: mergedVia, ledger: null };
		const described = `${info.repo} ${info.branch ?? "(detached)"} at ${info.head.slice(0, 12)}, merged via ${mergedVia}`;
		if (args.execute) {
			const outcome = await deps.emit(mergeBackNote(info, mergedVia));
			item.ledger = delivery(outcome);
			if (!args.json) deps.out(`recorded ${path}: ${described}\n`);
			// A proof that was not recorded is said so on stderr in every mode: the folder is kept and the ledger has no line for it.
			if (outcome.kind === "stored") {
				if (!args.json) deps.out(`${ledgerLine(outcome)}\n`);
			} else deps.err(`${ledgerLine(outcome)}\n`);
		} else if (!args.json) deps.out(`would record ${path}: ${described}\n`);
		recorded.push(item);
	}
	const notRecorded = args.execute && recorded.some((item) => item.ledger !== "stored");
	if (args.json) {
		deps.out(`${JSON.stringify({ dry_run: !args.execute, recorded, refused: refused.map((item) => item.path), reasons: Object.fromEntries(refused.map((item) => [item.path, item.reasons])) }, null, 2)}\n`);
	} else if (args.execute) {
		deps.out(`recorded ${recorded.length} worktrees, refused ${refused.length}\n`);
	} else {
		deps.out(`dry run: ${recorded.length} worktrees would be recorded, ${refused.length} refused; nothing was written (pass --execute to record)\n`);
	}
	return refused.length === 0 && !notRecorded ? 0 : 1;
}
