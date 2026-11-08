/**
 * The body of `POST /worktrees/report`: what this host's worktrees look like right now.
 *
 * The registry is a report the CLI posts, never something the server derives (it does not touch
 * worktrees). Only the contract's fields are sent: local facts the classifier uses (ignored file
 * names, merged pull request heads, notes) stay on the host. Graph attribution comes from the
 * configured roots through `graphIdForWorktree`. Session attribution comes from the caller (`options.sessions`):
 * `claimedSessions` derives it from the server's live claims, and the CLI adds the session it runs in. A worktree with
 * no entry is reported without `session_id`, and the registry stores that as NULL. When the inventory listed them, each row also carries `files` (the
 * paths it changed, at most `WORKTREE_FILES_MAX`) and `files_truncated`; `files: null` says the listing failed.
 */
import { checkWorktreeRow, WORKTREE_REPORT_MAX_BYTES, WORKTREE_REPORT_MAX_ITEMS } from "../../mcp-server/src/worktree-registry.ts";
import { graphIdForWorktree } from "../../collectors/src/worktree-graph.ts";
import { CLAIM_CONCURRENCY, type ClaimsFn, claimStatus, sessionOfClaims } from "./claims.ts";
import type { WorktreeInfo } from "./inventory.ts";
import { mapLimit } from "./pool.ts";
import type { PrState } from "./pr.ts";

/** The route accepts at most this many worktrees per report. */
export const MAX_REPORT_WORKTREES = WORKTREE_REPORT_MAX_ITEMS;
/** Headroom under the route's byte limit, so a body the server measures a little differently still fits. */
const REPORT_BYTE_MARGIN = 16 * 1024;
/** The most UTF-8 bytes of JSON one report body may take: the route's limit minus the margin. */
export const MAX_REPORT_BYTES = WORKTREE_REPORT_MAX_BYTES - REPORT_BYTE_MARGIN;
const REPORT_PROTOCOL = 1;

interface ReportWorktree {
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
	/** The changed paths the inventory listed; `null` when the listing failed; absent when it was not asked for. */
	files?: string[] | null;
	files_truncated?: boolean;
	graph_id?: string;
}

export interface WorktreeReport {
	protocol: typeof REPORT_PROTOCOL;
	host: string;
	reported_at: string;
	worktrees: ReportWorktree[];
}

interface ReportOptions {
	now?: Date;
	/** Roots used for graph attribution; defaults to the collectors' configured roots. */
	roots?: readonly string[];
	/** The session each worktree is attributed to, by path. A worktree with no entry is reported without `session_id`. */
	sessions?: ReadonlyMap<string, string>;
}

function toReportWorktree(info: WorktreeInfo, options: ReportOptions): ReportWorktree {
	const graphId = options.roots === undefined ? graphIdForWorktree(info.path) : graphIdForWorktree(info.path, options.roots);
	const sessionId = options.sessions?.get(info.path);
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
		...(sessionId === undefined ? {} : { session_id: sessionId }),
		...(graphId === null ? {} : { graph_id: graphId }),
		...(info.files === undefined ? {} : { files: info.files, files_truncated: info.files_truncated ?? false }),
	};
}

/** One report body from at most `MAX_REPORT_WORKTREES` of `inventory`, in the order given. */
export function buildReport(host: string, inventory: readonly WorktreeInfo[], options: ReportOptions = {}): WorktreeReport {
	return {
		protocol: REPORT_PROTOCOL,
		host,
		reported_at: (options.now ?? new Date()).toISOString(),
		worktrees: inventory.slice(0, MAX_REPORT_WORKTREES).map((info) => toReportWorktree(info, options)),
	};
}

interface SkippedWorktree {
	path: string;
	reason: string;
}

interface ReportPlan {
	/** Bodies the route accepts, in the order of the inventory. Never empty: an empty inventory is one empty report. */
	reports: WorktreeReport[];
	/** Worktrees that cannot be sent, each with why; the rest are unaffected. */
	skipped: SkippedWorktree[];
}

/**
 * Every worktree of `inventory`, packed in order into bodies that stay within both route limits: at most
 * `MAX_REPORT_WORKTREES` rows and at most `MAX_REPORT_BYTES` of UTF-8 JSON (long non-ASCII paths make the second
 * limit bind long before the first). A row the route's own row check would refuse (a path or a branch past its limit, a
 * label it does not accept) is skipped with the route's reason instead of being sent, because the route would refuse the
 * whole body and the rest of the fleet would go unreported. A row that passes that check is far smaller than a body, so
 * it always fits in one of its own.
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
		const row = toReportWorktree(info, options);
		// One row the route would refuse (a path or a branch past its limit, a label it does not accept) would reject the whole body.
		const accepted = checkWorktreeRow(row);
		if (!accepted.ok) {
			skipped.push({ path: info.path, reason: `the route would refuse its report row: ${accepted.problem}` });
			continue;
		}
		const size = Buffer.byteLength(JSON.stringify(row), "utf8");
		if (rows.length >= MAX_REPORT_WORKTREES || bytes + 1 + size > MAX_REPORT_BYTES) flush();
		// A comma separates a row from the one before it; the first row of a body has none.
		bytes += (rows.length === 0 ? 0 : 1) + size;
		rows.push(row);
	}
	flush();
	return { reports: reports.length > 0 ? reports : [empty], skipped };
}

/**
 * The session the server's live claims attribute each graph worktree to, by path. Asks about exactly the
 * worktrees under `roots` that belong to a graph (the condition prune uses), once per graph, with the pool prune
 * uses. Only a graph whose live claims all name one holder session attributes its worktrees (`sessionOfClaims`).
 * Fail open: a lookup that fails (or throws) leaves its worktrees unattributed and never stops the report.
 */
export async function claimedSessions(inventory: readonly WorktreeInfo[], roots: readonly string[], lookup: ClaimsFn): Promise<Map<string, string>> {
	const pathsByGraph = new Map<string, string[]>();
	for (const info of inventory) {
		const graphId = graphIdForWorktree(info.path, roots);
		if (graphId === null) continue;
		const paths = pathsByGraph.get(graphId);
		if (paths === undefined) pathsByGraph.set(graphId, [info.path]);
		else paths.push(info.path);
	}
	const answers = await mapLimit([...pathsByGraph], CLAIM_CONCURRENCY, async ([graphId, paths]) => {
		try {
			return { paths, session: sessionOfClaims(await claimStatus(graphId, lookup)) };
		} catch {
			// The lookup's contract is never to throw; if one does, its graph is unattributed like any failed lookup.
			return { paths, session: null };
		}
	});
	const sessions = new Map<string, string>();
	for (const { paths, session } of answers) {
		if (session === null) continue;
		for (const path of paths) sessions.set(path, session);
	}
	return sessions;
}
