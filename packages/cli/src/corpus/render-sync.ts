/**
 * Output of `substrate corpus sync|reconcile|hook` (v1.7 phase 65). Every function returns text ending in a newline and
 * never prints. A human line and the JSON form carry the same warnings: a stale mirror, a repository read incompletely, a
 * requested repository that was not found, and a lost `docs.sync` event.
 */
import { type CorpusReconcileResponse, RECONCILE_MAX_ITEMS } from "@substrate/corpus";
import type { HookReport } from "../../../collectors/src/install-git-hook.ts";
import { LIST_LIMIT, renderIngest, renderPlan } from "./render.ts";
import type { MirrorReport, SyncResult } from "./sync.ts";

/** Absent-mirror reasons that deserve a line (a stale mirror always does); no origin and nothing fetched yet are the normal working-tree case. */
const MIRROR_PROBLEMS: readonly string[] = ["clone-failed", "clone-timeout", "mirror-dir-unusable", "mirror-unmatched"];

export interface MirrorProblem {
	repo: string;
	/** `mirror-stale` for a fetch that failed over a mirror that exists, `mirror` for a mirror that could not be made or read. */
	kind: "mirror-stale" | "mirror";
	reason: string;
}

export function mirrorProblems(mirrors: readonly MirrorReport[]): MirrorProblem[] {
	const problems: MirrorProblem[] = [];
	for (const mirror of mirrors) {
		const reason = mirror.reason ?? mirror.status;
		if (mirror.status === "stale") problems.push({ repo: mirror.repo, kind: "mirror-stale", reason });
		else if (mirror.status === "absent" && MIRROR_PROBLEMS.includes(reason)) problems.push({ repo: mirror.repo, kind: "mirror", reason });
	}
	return problems;
}

function more(shown: number, total: number): string {
	return total > shown ? `  ... and ${total - shown} more\n` : "";
}

function renderMirrorProblems(mirrors: readonly MirrorReport[]): string {
	const problems = mirrorProblems(mirrors);
	const out = problems.slice(0, LIST_LIMIT).map((problem) =>
		problem.kind === "mirror-stale"
			? `mirror-stale ${problem.repo}: ${problem.reason}; the last good mirror is still read\n`
			: problem.reason === "mirror-unmatched"
				? `mirror ${problem.repo}: ${problem.reason}; coverage stays incomplete until a mirror of this origin exists\n`
				: `mirror ${problem.repo}: ${problem.reason}; read from the working tree alone\n`,
	);
	return out.join("") + more(LIST_LIMIT, problems.length);
}

/** Mirror, incomplete-read and lost-event warnings, in the same words `renderSync` uses. */
export function renderSyncWarnings(result: SyncResult): string {
	const out: string[] = [renderMirrorProblems(result.mirrors)];
	if (result.incomplete.length > 0) {
		out.push(`not read completely (their rows are not judged removed): ${result.incomplete.length}\n`);
		for (const line of result.incomplete.slice(0, LIST_LIMIT)) out.push(`  ${line}\n`);
		out.push(more(LIST_LIMIT, result.incomplete.length));
	}
	if (result.delivery !== null && !result.delivery.ok) out.push(`docs.sync event not delivered (${result.delivery.reason}); the sync itself is not affected\n`);
	return out.join("");
}

export function renderSync(result: SyncResult): string {
	const out: string[] = [`sync (${result.trigger}${result.execute ? "" : ", dry run"}): ${result.outcome}; ${result.repos.length} ${result.repos.length === 1 ? "repository" : "repositories"} read\n`];
	out.push(renderSyncWarnings(result));
	for (const label of result.notFound) out.push(`repo-not-found: ${label} is not below the roots\n`);
	if (result.plan !== null && result.inventory !== null) out.push(renderPlan(result.plan, result.inventory));
	if (result.ingest !== null) out.push(renderIngest(result.ingest));
	if (!result.execute && result.plan !== null) out.push("dry run: nothing was sent; add --execute to sync\n");
	if (result.error !== null) out.push(`error: ${result.error}\n`);
	return out.join("");
}

/** The `--json` form of a sync: counts and warnings, never the entry list. */
export function syncJson(result: SyncResult): Record<string, unknown> {
	return {
		outcome: result.outcome,
		trigger: result.trigger,
		execute: result.execute,
		repos: result.repos,
		notFound: result.notFound,
		incomplete: result.incomplete,
		mirrors: result.mirrors,
		mirrorProblems: mirrorProblems(result.mirrors),
		plan: result.plan === null ? null : { counts: result.plan.counts, manifestVersion: result.plan.manifestVersion },
		ingest: result.ingest,
		error: result.error,
		eventDelivered: result.delivery === null ? null : result.delivery.ok,
		durationMs: result.durationMs,
		lagS: result.lagS,
	};
}

export interface ReconcileView {
	sync: SyncResult;
	drift: CorpusReconcileResponse["drift"];
	repaired: CorpusReconcileResponse["repaired"];
	execute: boolean;
}

export function renderReconcile(view: ReconcileView): string {
	const { drift } = view;
	const out: string[] = [`reconcile${view.execute ? "" : " (dry run)"}: ${drift.checked} compared, ${drift.missingInPlane.length} missing from the docs plane, ${drift.orphansInPlane.length} orphaned in the plane\n`];
	out.push(renderMirrorProblems(view.sync.mirrors));
	if (drift.truncated) out.push(`the comparison was cut short (the drift is capped at ${RECONCILE_MAX_ITEMS} keys in total, or the plane listing was not complete)\n`);
	if (drift.missingInPlane.length > 0) {
		out.push("active rows whose plane document is gone:\n");
		for (const row of drift.missingInPlane.slice(0, LIST_LIMIT)) out.push(`  ${row.repo}:${row.path}\n`);
		out.push(more(LIST_LIMIT, drift.missingInPlane.length));
	}
	if (drift.orphansInPlane.length > 0) {
		out.push("plane documents no active row owns:\n");
		for (const name of drift.orphansInPlane.slice(0, LIST_LIMIT)) out.push(`  ${name}\n`);
		out.push(more(LIST_LIMIT, drift.orphansInPlane.length));
	}
	out.push(
		view.execute
			? `repaired: ${view.repaired.requeued} rows requeued, ${view.repaired.deleted} orphan documents deleted\n`
			: "dry run: nothing was changed; add --execute to requeue the missing rows and delete the orphans\n",
	);
	out.push(renderSync(view.sync));
	return out.join("");
}

export function renderHooks(reports: readonly HookReport[]): string {
	return reports.map((report) => `${report.hook}: ${report.state}${report.detail === undefined ? "" : ` (${report.detail})`}\n`).join("");
}
