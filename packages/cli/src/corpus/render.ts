/**
 * Human output of `substrate corpus`. Every function returns text ending in a newline and never prints, so the command
 * decides where it goes. Long lists are cut at a fixed limit with a line saying how many were left out.
 */
import {
	INGEST_STATUSES,
	PLAN_ACTIONS,
	documentKey,
	type CorpusPlanResponse,
	type CorpusScope,
	type CorpusStatusResponse,
	type IngestStatus,
	type PlanItem,
} from "@substrate/corpus";
import type { Inventory } from "./inventory.ts";

/** Items listed per plan action. */
export const LIST_LIMIT = 20;
/** Repositories listed in an inventory. */
export const REPO_LIMIT = 100;

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
	const incomplete = report.repos.filter((repo) => !repo.complete);
	if (incomplete.length > 0) {
		out.push(`not read completely (left out of a plan's scope): ${incomplete.length}\n`);
		for (const repo of incomplete.slice(0, LIST_LIMIT)) out.push(`  ${repo.repo}: ${repo.incomplete ?? "incomplete"}\n`);
		out.push(more(LIST_LIMIT, incomplete.length));
	}
	const listed = [...report.repos].sort((a, b) => b.files - a.files || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
	out.push("repositories:\n");
	for (const repo of listed.slice(0, REPO_LIMIT)) out.push(`  ${repo.repo}  ${repo.files} files  ${repo.bytes} bytes  [${repo.source}]\n`);
	out.push(more(REPO_LIMIT, listed.length));
	if (report.notes.length > 0) {
		out.push("notes:\n");
		for (const note of report.notes.slice(0, LIST_LIMIT)) out.push(`  ${note}\n`);
		out.push(more(LIST_LIMIT, report.notes.length));
	}
	return out.join("");
}

function describeItem(item: PlanItem): string {
	const key = documentKey(item.repo, item.path);
	return item.action === "rename" && item.renamedFrom !== undefined ? `${key}  (from ${item.renamedFrom})` : key;
}

export function renderPlan(plan: CorpusPlanResponse, scope: CorpusScope): string {
	const counts = PLAN_ACTIONS.map((action) => `${action} ${plan.counts[action]}`).join(", ");
	const out: string[] = [
		`plan: ${counts} (manifest version ${plan.manifestVersion})\n`,
		`scope: ${plural(scope.repos.length, "repository", "repositories")} read completely, tier <= ${scope.maxTier}, sources ${scope.sources.join(", ")}\n`,
	];
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
		for (const row of rows.slice(0, LIST_LIMIT)) out.push(`  ${documentKey(row.repo, row.path)}${row.reason === undefined ? "" : `  [${row.reason}]`}\n`);
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
	for (const row of status.byRepo.slice(0, REPO_LIMIT)) out.push(`  ${row.repo}  ${row.active} active  ${row.tombstoned} tombstoned\n`);
	out.push(more(REPO_LIMIT, status.byRepo.length));
	return out.join("");
}
