/**
 * The body of `POST /worktrees/report`: what this host's worktrees look like right now.
 *
 * The registry is a report the CLI posts, never something the server derives (it does not touch
 * worktrees). Only the contract's fields are sent: local facts the classifier uses (ignored file
 * names, merged pull request heads, notes) stay on the host. Graph attribution comes from the
 * configured roots through `graphIdForWorktree`.
 */
import { WORKTREE_REPORT_MAX_BYTES, WORKTREE_REPORT_MAX_ITEMS } from "../../mcp-server/src/worktree-registry.ts";
import { graphIdForWorktree } from "../../collectors/src/worktree-graph.ts";
import type { WorktreeInfo } from "./inventory.ts";
import type { PrState } from "./pr.ts";

/** The route accepts at most this many worktrees per report. */
export const MAX_REPORT_WORKTREES = WORKTREE_REPORT_MAX_ITEMS;
/** Headroom under the route's byte limit, so a body the server measures a little differently still fits. */
export const REPORT_BYTE_MARGIN = 16 * 1024;
/** The most UTF-8 bytes of JSON one report body may take: the route's limit minus the margin. */
export const MAX_REPORT_BYTES = WORKTREE_REPORT_MAX_BYTES - REPORT_BYTE_MARGIN;
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

export interface SkippedWorktree {
	path: string;
	reason: string;
}

export interface ReportPlan {
	/** Bodies the route accepts, in the order of the inventory. Never empty: an empty inventory is one empty report. */
	reports: WorktreeReport[];
	/** Worktrees that cannot be sent, each with why; the rest are unaffected. */
	skipped: SkippedWorktree[];
}

/**
 * Every worktree of `inventory`, packed in order into bodies that stay within both route limits: at most
 * `MAX_REPORT_WORKTREES` rows and at most `MAX_REPORT_BYTES` of UTF-8 JSON (long non-ASCII paths make the second
 * limit bind long before the first). A row that cannot fit even in a body of its own is skipped with a reason
 * instead of being sent, because the route would answer 413 and the rest of the fleet would go unreported.
 */
export function buildReports(host: string, inventory: readonly WorktreeInfo[], options: ReportOptions = {}): ReportPlan {
	const reports: WorktreeReport[] = [];
	const skipped: SkippedWorktree[] = [];
	// The body without rows; each row adds its own bytes and one comma between neighbours.
	const empty = buildReport(host, [], options);
	const envelope = Buffer.byteLength(JSON.stringify(empty), "utf8");
	let rows: ReportWorktree[] = [];
	let bytes = envelope;
	const flush = (): void => {
		if (rows.length === 0) return;
		reports.push({ ...empty, worktrees: rows });
		rows = [];
		bytes = envelope;
	};
	for (const info of inventory) {
		const row = toReportWorktree(info, options.roots);
		const size = Buffer.byteLength(JSON.stringify(row), "utf8");
		if (envelope + size > MAX_REPORT_BYTES) {
			skipped.push({ path: info.path, reason: `its report row alone is ${size} bytes; a report body may hold at most ${MAX_REPORT_BYTES}` });
			continue;
		}
		if (rows.length >= MAX_REPORT_WORKTREES || bytes + 1 + size > MAX_REPORT_BYTES) flush();
		// A comma separates a row from the one before it; the first row of a body has none.
		bytes += (rows.length === 0 ? 0 : 1) + size;
		rows.push(row);
	}
	flush();
	return { reports: reports.length > 0 ? reports : [empty], skipped };
}
