/**
 * The body of `POST /worktrees/report`: what this host's worktrees look like right now.
 *
 * The registry is a report the CLI posts, never something the server derives (it does not touch
 * worktrees). Only the contract's fields are sent: local facts the classifier uses (ignored file
 * names, merged pull request heads, notes) stay on the host. Graph attribution comes from the
 * configured roots through `graphIdForWorktree`.
 */
import { graphIdForWorktree } from "../../collectors/src/worktree-graph.ts";
import type { WorktreeInfo } from "./inventory.ts";
import type { PrState } from "./pr.ts";

/** The route accepts at most this many worktrees per report. */
export const MAX_REPORT_WORKTREES = 500;
export const REPORT_PROTOCOL = 1;

export interface ReportWorktree {
	path: string;
	repo: string;
	branch: string | null;
	head: string;
	base: string | null;
	dirty: boolean;
	ahead: number | null;
	behind: number | null;
	last_commit_at: string | null;
	size_bytes: number | null;
	locked: boolean;
	primary: boolean;
	pr_state: PrState;
	session_id?: string;
	graph_id?: string;
}

export interface WorktreeReport {
	protocol: typeof REPORT_PROTOCOL;
	host: string;
	reported_at: string;
	worktrees: ReportWorktree[];
}

export interface ReportOptions {
	now?: Date;
	/** Roots used for graph attribution; defaults to the collectors' configured roots. */
	roots?: readonly string[];
}

function toReportWorktree(info: WorktreeInfo, roots: readonly string[] | undefined): ReportWorktree {
	const graphId = roots === undefined ? graphIdForWorktree(info.path) : graphIdForWorktree(info.path, roots);
	return {
		path: info.path,
		repo: info.repo,
		branch: info.branch,
		head: info.head,
		base: info.base,
		dirty: info.dirty,
		ahead: info.ahead,
		behind: info.behind,
		last_commit_at: info.last_commit_at,
		size_bytes: info.size_bytes,
		locked: info.locked,
		primary: info.primary,
		pr_state: info.pr_state,
		...(graphId === null ? {} : { graph_id: graphId }),
	};
}

/** One report body from at most `MAX_REPORT_WORKTREES` of `inventory`, in the order given. */
export function buildReport(host: string, inventory: readonly WorktreeInfo[], options: ReportOptions = {}): WorktreeReport {
	return {
		protocol: REPORT_PROTOCOL,
		host,
		reported_at: (options.now ?? new Date()).toISOString(),
		worktrees: inventory.slice(0, MAX_REPORT_WORKTREES).map((info) => toReportWorktree(info, options.roots)),
	};
}

/** Every worktree of `inventory`, split into bodies the route accepts. An empty inventory is one empty report. */
export function buildReports(host: string, inventory: readonly WorktreeInfo[], options: ReportOptions = {}): WorktreeReport[] {
	const reports: WorktreeReport[] = [];
	for (let offset = 0; offset < inventory.length; offset += MAX_REPORT_WORKTREES) {
		reports.push(buildReport(host, inventory.slice(offset, offset + MAX_REPORT_WORKTREES), options));
	}
	return reports.length > 0 ? reports : [buildReport(host, [], options)];
}
