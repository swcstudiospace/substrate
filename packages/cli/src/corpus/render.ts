/**
 * Human output of `substrate corpus`. Every function returns text ending in a newline and never prints, so the command
 * decides where it goes. Long lists are cut at a fixed limit with a line saying how many were left out.
 */
import {
	INGEST_STATUSES,
	PLAN_ACTIONS,
	documentKey,
	type CorpusAnchorResponse,
	type CorpusNeardupResponse,
	type CorpusPlanResponse,
	type CorpusProofResponse,
	type CorpusStatusResponse,
	type IngestStatus,
	type PlanItem,
} from "@substrate/corpus";
import type { Inventory } from "./inventory.ts";
import type { NeardupSelection } from "./neardup.ts";
import type { OfflineVerdict } from "./proof.ts";

/** Items listed per plan action. */
export const LIST_LIMIT = 20;
/** Repositories listed in an inventory. */
export const REPO_LIMIT = 100;

/**
 * A value that came from a file system, an origin or a server answer, safe to print: every control character (escape,
 * newline, tab, DEL, the C1 range and the Unicode line separators) is written as its escape, so a tracked file name cannot
 * rewrite the operator's terminal or forge a line of the report. JSON output keeps the raw value.
 */
export function printable(text: string): string {
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
		if (!control) out += char;
		else out += code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
	}
	return out;
}

function plural(count: number, word: string, many = `${word}s`): string {
	return `${count} ${count === 1 ? word : many}`;
}

function tally<K extends string | number>(values: Iterable<K>): Array<[K, number]> {
	const counts = new Map<K, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function more(shown: number, total: number): string {
	return total > shown ? `  ... and ${total - shown} more\n` : "";
}

export function renderInventory(inventory: Inventory): string {
	const { entries, report } = inventory;
	const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
	const out: string[] = [];
	out.push(
		`corpus scan: ${plural(entries.length, "document")}, ${bytes} bytes, ${plural(report.repos.length, "repository", "repositories")} (${plural(report.checkouts, "checkout")} found)\n`,
		`sources: ${inventory.sources.join(", ")}; tier <= ${inventory.maxTier}\n`,
		`by tier: ${tally(entries.map((entry) => entry.tier)).map(([tier, count]) => `${tier}: ${count}`).join(", ") || "none"}\n`,
		`by kind: ${tally(entries.map((entry) => entry.kind)).map(([kind, count]) => `${kind} ${count}`).join(", ") || "none"}\n`,
	);
	const { clones, worktrees, identical, identicalGroups } = report.collapsed;
	out.push(`collapsed: ${plural(clones, "clone")}, ${plural(worktrees, "linked worktree")}, ${plural(identical, "identical copy", "identical copies")} in ${plural(identicalGroups, "group")}\n`);
	const skippedTotal = Object.values(report.skippedByReason).reduce((sum, count) => sum + count, 0);
	out.push(
		skippedTotal === 0
			? "skipped: none\n"
			: `skipped: ${skippedTotal} (${Object.entries(report.skippedByReason).map(([reason, count]) => `${reason} ${count}`).join(", ")})\n`,
	);
	if (report.emptyCollections > 0) {
		out.push(`empty: ${plural(report.emptyCollections, "repository", "repositories")} read completely with no documents (still covered, so their old rows are removed)\n`);
	}
	const incomplete = report.repos.filter((repo) => !repo.complete);
	if (incomplete.length > 0) {
		out.push(`not read completely (left out of a plan's coverage): ${incomplete.length}\n`);
		for (const repo of incomplete.slice(0, LIST_LIMIT)) out.push(`  ${printable(repo.repo)} [${repo.source}]: ${printable(repo.incomplete ?? "incomplete")}\n`);
		out.push(more(LIST_LIMIT, incomplete.length));
	}
	const listed = [...report.repos].sort((a, b) => b.files - a.files || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
	out.push("repositories:\n");
	for (const repo of listed.slice(0, REPO_LIMIT)) out.push(`  ${printable(repo.repo)}  ${repo.files} files  ${repo.bytes} bytes  [${repo.source}]\n`);
	out.push(more(REPO_LIMIT, listed.length));
	if (report.notes.length > 0) {
		out.push("notes:\n");
		for (const note of report.notes.slice(0, LIST_LIMIT)) out.push(`  ${printable(note)}\n`);
		out.push(more(LIST_LIMIT, report.notes.length));
	}
	return out.join("");
}

function describeItem(item: PlanItem): string {
	const key = printable(documentKey(item.repo, item.path));
	return item.action === "rename" && item.renamedFrom !== undefined ? `${key}  (from ${printable(item.renamedFrom)})` : key;
}

export function renderPlan(plan: CorpusPlanResponse, inventory: Inventory): string {
	const { scope, report } = inventory;
	const counts = PLAN_ACTIONS.map((action) => `${action} ${plan.counts[action]}`).join(", ");
	const out: string[] = [
		`plan: ${counts} (manifest version ${plan.manifestVersion})\n`,
		`coverage: ${plural(scope.coverage.length, "repository/source pair")} read completely, tier <= ${scope.maxTier}; only manifest rows in these pairs can be tombstoned\n`,
	];
	if (scope.coverage.length === 0) out.push("coverage is empty: nothing will be tombstoned, the documents found are still planned and ingested\n");
	const left = report.repos.filter((repo) => !repo.complete);
	if (left.length > 0) {
		out.push(`left out of the coverage (${left.length}):\n`);
		for (const repo of left.slice(0, LIST_LIMIT)) out.push(`  ${printable(repo.repo)} [${repo.source}]: ${printable(repo.incomplete ?? "incomplete")}\n`);
		out.push(more(LIST_LIMIT, left.length));
	}
	if (report.notes.length > 0) {
		// Notes say what a source never reached (a repository cap, an unreadable export), which no report row can.
		out.push("notes:\n");
		for (const note of report.notes.slice(0, LIST_LIMIT)) out.push(`  ${printable(note)}\n`);
		out.push(more(LIST_LIMIT, report.notes.length));
	}
	for (const action of PLAN_ACTIONS) {
		if (action === "unchanged") continue;
		const items = plan.items.filter((item) => item.action === action);
		if (items.length === 0) continue;
		out.push(`${action} (${items.length}):\n`);
		for (const item of items.slice(0, LIST_LIMIT)) out.push(`  ${describeItem(item)}\n`);
		out.push(more(LIST_LIMIT, items.length));
	}
	return out.join("");
}

export interface IngestProblem {
	repo: string;
	path: string;
	status: IngestStatus;
	reason?: string | undefined;
}

export interface IngestSummary {
	counts: Record<IngestStatus, number>;
	/** Failed and refused documents, with a closed reason code each. */
	problems: IngestProblem[];
	manifestVersion: number | null;
}

export function renderIngest(summary: IngestSummary): string {
	const out: string[] = [`ingest: ${INGEST_STATUSES.map((status) => `${status} ${summary.counts[status]}`).join(", ")}\n`];
	for (const status of ["failed", "refused"] as const) {
		const rows = summary.problems.filter((problem) => problem.status === status);
		if (rows.length === 0) continue;
		out.push(`${status} (${rows.length}):\n`);
		for (const row of rows.slice(0, LIST_LIMIT)) out.push(`  ${printable(documentKey(row.repo, row.path))}${row.reason === undefined ? "" : `  [${printable(row.reason)}]`}\n`);
		out.push(more(LIST_LIMIT, rows.length));
	}
	return out.join("");
}

export function renderStatus(status: CorpusStatusResponse): string {
	const out: string[] = [
		`corpus: ${status.total} rows, ${status.active} active, ${status.tombstoned} tombstoned (manifest version ${status.manifestVersion})\n`,
		`last ingest: ${status.lastIngestAt ?? "never"}\n`,
		`by tier: ${status.byTier.map((row) => `${row.tier}: ${row.count}`).join(", ") || "none"}\n`,
		`by kind: ${status.byKind.map((row) => `${row.kind} ${row.count}`).join(", ") || "none"}\n`,
		"repositories:\n",
	];
	for (const row of status.byRepo.slice(0, REPO_LIMIT)) out.push(`  ${printable(row.repo)}  ${row.active} active  ${row.tombstoned} tombstoned\n`);
	out.push(more(REPO_LIMIT, status.byRepo.length));
	return out.join("");
}

/** Pairs listed in the near-duplicate section; the rest is a count. */
export const NEARDUP_LIST_LIMIT = 50;

/** Why some planned documents were not compared, one line each; nothing when every one was. */
function renderNotCompared(selection: NeardupSelection): string {
	const out: string[] = [];
	if (selection.github > 0) out.push(`${plural(selection.github, "document")} from GitHub ${selection.github === 1 ? "was" : "were"} not compared (a plan does not read them)\n`);
	if (selection.unreadable > 0) out.push(`${plural(selection.unreadable, "document")} could not be read and ${selection.unreadable === 1 ? "was" : "were"} not compared\n`);
	if (selection.overLimit > 0) out.push(`compared the first ${selection.items.length} of ${selection.candidates} documents (--neardup-max)\n`);
	return out.join("");
}

/**
 * The near-duplicate section after a plan. `reply` is null when there was nothing to send. The section says in its first line
 * that the signal is advisory: no document is dropped, skipped or tombstoned because of it.
 */
export function renderNeardup(selection: NeardupSelection, reply: CorpusNeardupResponse | null): string {
	if (reply === null) return `near-duplicates: nothing to compare\n${renderNotCompared(selection)}`;
	const out: string[] = ["near-duplicates (advisory: no document is dropped on this signal)\n"];
	if (reply.pairs.length === 0) out.push("  no pair is at or above the threshold\n");
	for (const pair of reply.pairs.slice(0, NEARDUP_LIST_LIMIT)) {
		out.push(`  ${pair.similarity.toFixed(4)}  ${printable(documentKey(pair.a.repo, pair.a.path))}  ~  ${printable(documentKey(pair.b.repo, pair.b.path))}\n`);
	}
	out.push(more(NEARDUP_LIST_LIMIT, reply.pairs.length));
	if (reply.truncated) out.push("more pairs matched than the server returned; raise --threshold to narrow them\n");
	out.push(`model: ${printable(reply.model ?? "unknown")}, dimension: ${reply.dimension ?? "unknown"}\n`);
	out.push(`compared: ${plural(reply.compared, "document")}, skipped (empty text): ${selection.items.length - reply.compared}\n`);
	out.push(renderNotCompared(selection));
	return out.join("");
}

/** The longest piece of server-supplied text a line shows. */
export const TEXT_LIMIT = 300;
/** Reasons listed under an anchor status. */
export const REASON_LIMIT = 10;

/**
 * Server or file text for a verify line: `printable` (control characters escaped) and cut at {@link TEXT_LIMIT} characters, so a
 * long reason or name cannot swamp the report.
 */
function clip(text: string): string {
	const safe = printable(text);
	return safe.length > TEXT_LIMIT ? `${safe.slice(0, TEXT_LIMIT)}...` : safe;
}

export interface VerifyReport {
	proof: CorpusProofResponse;
	offline: OfflineVerdict;
	/** Whether `--online` was given. */
	online: boolean;
	anchor: CorpusAnchorResponse | null;
	/** Why the anchor check did not run or did not answer, when `--online` was given. */
	anchorSkipped: string | null;
	/** What in the anchor answer contradicts the proof. */
	conflict: string | null;
}

/** Whether the report is a valid verification: the proof holds and the anchor answer, when there is one, does not contradict it. */
export function isValidReport(report: VerifyReport): boolean {
	return report.offline.valid && report.conflict === null;
}

function anchorLines(report: VerifyReport): string[] {
	if (!report.online) return ["anchor: not checked (use --online to ask the server)\n"];
	const { anchor } = report;
	if (anchor === null) return [`anchor: check skipped, ${clip(report.anchorSkipped ?? "no answer")}\n`];
	const lines = [`anchor: ${anchor.status}\n`];
	const signature = anchor.evidence?.signature ?? null;
	const hourlyRoot = anchor.evidence?.anchoredRoot ?? null;
	const slot = anchor.evidence?.slot ?? null;
	if (anchor.hourStart !== null) lines.push(`  hour: ${clip(anchor.hourStart)}\n`);
	if (anchor.eventId !== null) lines.push(`  root event: ${clip(anchor.eventId)}\n`);
	if (signature !== null) lines.push(`  transaction: ${clip(signature)}${slot === null ? "" : ` (slot ${slot})`}\n`);
	if (hourlyRoot !== null) lines.push(`  hourly root: ${clip(hourlyRoot)}\n`);
	for (const reason of anchor.reasons.slice(0, REASON_LIMIT)) lines.push(`  ${clip(reason)}\n`);
	lines.push(more(REASON_LIMIT, anchor.reasons.length));
	if (anchor.status === "unanchored") lines.push("  the root is not inside an anchored hour: the proof still shows the document was in the manifest with this root\n");
	return lines;
}

export function renderVerify(report: VerifyReport): string {
	const { proof, offline } = report;
	const out: string[] = [
		`document: ${clip(proof.repo)}:${clip(proof.documentPath)}\n`,
		`root: ${clip(proof.root)} (leaf ${proof.index + 1} of ${proof.treeSize}, manifest version ${proof.manifestVersion})\n`,
		offline.valid ? "proof: valid\n" : `proof: INVALID, ${clip(offline.reason)}\n`,
		...anchorLines(report),
	];
	if (report.conflict !== null) out.push(`anchor answer contradicts the proof: ${clip(report.conflict)}\n`);
	out.push(isValidReport(report) ? "result: valid\n" : "result: invalid\n");
	return out.join("");
}

export function jsonVerifyReport(report: VerifyReport): string {
	const { offline, anchor, anchorSkipped, conflict, online } = report;
	return `${JSON.stringify({ valid: isValidReport(report), offline, online, anchor, anchorSkipped, conflict }, null, 2)}\n`;
}
