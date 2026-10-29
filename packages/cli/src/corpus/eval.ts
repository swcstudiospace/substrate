/**
 * `substrate corpus eval` (v1.7 phase 70): the golden set of what the local scan found, optionally asked of a server.
 *
 * Read-only on both sides. The questions come from the titles, headings and opening sentences of the Markdown documents the
 * scan listed, read from the working tree; with a server they are asked of `POST /docs/search` and scored for recall at k, MRR
 * and latency. The exit code is 0 when the recall objective (`SUBSTRATE_DOCS_SLO_RECALL5`) holds and 1 when it is breached or
 * the run could not be scored in full, so a timer can alert on it. Without a server nothing is asked and the exit code is 0.
 */
import {
	documentKey,
	generateGolden,
	runLiveQueries,
	scoreRun,
	sloBreaches,
	type EvalDocument,
	type RunScore,
	type SloBreach,
	type SloThresholds,
} from "@substrate/corpus";
import { printable } from "./render.ts";
import type { Inventory } from "./inventory.ts";

/** The extensions of the documents the questions are written from. */
export const EVAL_EXTENSIONS: readonly string[] = [".md", ".markdown", ".mdx"];
/** How many unreadable documents a report names; the rest are counted. */
export const EVAL_LISTED_PROBLEMS = 10;

/** A repository the scan did not read completely: its documents may be missing from the questions, so a result over the rest is partial. */
export interface IncompleteRepo {
	repo: string;
	source: string;
	reason: string;
}

export interface EvalDocuments {
	docs: EvalDocument[];
	/** Documents the scan listed that could not be read from the working tree. */
	unreadable: { count: number; listed: string[] };
	/** Repositories the scan did not read completely (a failed `git ls-files`, a truncated tree), as its report names them. */
	incomplete: { count: number; listed: IncompleteRepo[] };
}

/** The scan's Markdown documents with their text. A file that cannot be read is counted and named, never fatal: one bad file must not stop the run. */
export function readEvalDocuments(inventory: Inventory, read: (path: string) => Uint8Array): EvalDocuments {
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	const docs: EvalDocument[] = [];
	const unreadable: EvalDocuments["unreadable"] = { count: 0, listed: [] };
	for (const entry of inventory.entries) {
		if (!EVAL_EXTENSIONS.some((extension) => entry.path.toLowerCase().endsWith(extension))) continue;
		const key = documentKey(entry.repo, entry.path);
		const file = inventory.paths.get(key);
		// An entry with no path on disk (a GitHub document) has no working tree to read.
		if (file === undefined) continue;
		try {
			docs.push({ repo: entry.repo, path: entry.path, text: decoder.decode(read(file)) });
		} catch {
			unreadable.count += 1;
			if (unreadable.listed.length < EVAL_LISTED_PROBLEMS) unreadable.listed.push(key);
		}
	}
	const skipped = inventory.report.repos.filter((repo) => !repo.complete);
	const incomplete: EvalDocuments["incomplete"] = {
		count: skipped.length,
		listed: skipped.slice(0, EVAL_LISTED_PROBLEMS).map((repo) => ({ repo: repo.repo, source: repo.source, reason: repo.incomplete ?? "incomplete" })),
	};
	return { docs, unreadable, incomplete };
}

export interface EvalServer {
	url: string;
	token: string;
	fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface EvalRequest {
	documents: EvalDocuments;
	maxQueries: number;
	thresholds: SloThresholds;
	/** Null is a dry run: the questions are counted, none is asked. */
	server: EvalServer | null;
	json: boolean;
	now: () => number;
}

export interface EvalOutcome {
	code: number;
	/** Standard output text. */
	text: string;
	/** Standard error text; empty when there is nothing to warn about. */
	warning: string;
}

function problems(documents: EvalDocuments): string[] {
	const { count, listed } = documents.unreadable;
	const lines = count === 0 ? [] : [`${count} document(s) could not be read from the working tree${listed.length === 0 ? "" : `: ${listed.join(", ")}${count > listed.length ? `, +${count - listed.length} more` : ""}`}`];
	// A result over a scan that skipped a repository is a result over part of the corpus, and says so wherever the warnings go.
	if (documents.incomplete.count > 0) lines.push(`partial scan: ${documents.incomplete.count} repository(ies) were not read completely, so the questions and the verdict cover only the rest`);
	return lines;
}

/** The human listing of the repositories the scan skipped, through `printable` (a reason carries an operating-system message). Empty for a complete scan. */
function incompleteLines(documents: EvalDocuments): string[] {
	const { count, listed } = documents.incomplete;
	if (count === 0) return [];
	const out = [`not read completely: ${count}`];
	for (const repo of listed) out.push(`  ${printable(repo.repo)} [${printable(repo.source)}]: ${printable(repo.reason)}`);
	if (count > listed.length) out.push(`  +${count - listed.length} more`);
	return out;
}

function scoreLine(score: RunScore): string {
	return `recall@1=${score.recall1.toFixed(3)} recall@5=${score.recall5.toFixed(3)} recall@10=${score.recall10.toFixed(3)} mrr=${score.mrr.toFixed(3)} p50=${score.p50Ms.toFixed(1)}ms p95=${score.p95Ms.toFixed(1)}ms`;
}

/** Generates the questions and, with a server, asks them. Never throws. */
export async function evaluateCorpus(request: EvalRequest): Promise<EvalOutcome> {
	const golden = generateGolden(request.documents.docs, { maxQueries: request.maxQueries });
	const warnings = problems(request.documents);
	const documents = request.documents.docs.length;
	const partial = request.documents.incomplete.count > 0;
	if (request.server === null) {
		const text = request.json
			? `${JSON.stringify({ mode: "dry-run", documents, questions: golden.length, partial, incomplete: request.documents.incomplete, unreadable: request.documents.unreadable, warnings })}\n`
			: [`documents read: ${documents}`, ...incompleteLines(request.documents), `questions it would ask: ${golden.length} (add --server URL to ask them)`, ""].join("\n");
		return { code: 0, text, warning: warnings.map((line) => `[substrate] corpus eval: ${printable(line)}\n`).join("") };
	}

	const live = await runLiveQueries(golden, { base: request.server.url, token: request.server.token, fetchImpl: request.server.fetchImpl, now: request.now });
	const score = scoreRun(live.results);
	const answered = live.results.length;
	const breaches: SloBreach[] = sloBreaches({ freshnessS: null, recall5: answered === 0 ? null : score.recall5, ingestDocsPerS: null }, request.thresholds);
	const notScored: string[] = [];
	if (golden.length === 0) notScored.push("no question could be generated from the documents the scan read");
	if (live.failed > 0) notScored.push(`${live.failed} question(s) failed`);
	if (live.degraded > 0) notScored.push(`${live.degraded} question(s) were answered degraded (a plane outage, not a miss)`);
	if (live.aborted !== null) notScored.push(`the run stopped early (${live.aborted})`);
	if (golden.length > 0 && answered === 0 && live.failed === 0 && live.degraded === 0 && live.aborted === null) notScored.push("no question was answered");
	// The exit code is the objective's alone: a partial scan changes the label of the verdict, never whether the run passed.
	const code = breaches.length > 0 || notScored.length > 0 ? 1 : 0;
	const allWarnings = [...warnings, ...notScored];
	const scope = partial ? ` (partial: ${request.documents.incomplete.count} repository(ies) not read completely)` : "";
	const text = request.json
		? `${JSON.stringify({
				mode: "live",
				documents,
				questions: golden.length,
				answered,
				failed: live.failed,
				degraded: live.degraded,
				aborted: live.aborted,
				partial,
				incomplete: request.documents.incomplete,
				score,
				threshold: request.thresholds.recall5,
				breaches,
				warnings: allWarnings,
				unreadable: request.documents.unreadable,
			})}\n`
		: [
				`documents read: ${documents}`,
				...incompleteLines(request.documents),
				`questions: ${golden.length}, answered ${answered}, failed ${live.failed}, degraded ${live.degraded}`,
				scoreLine(score),
				breaches.length > 0
					? `FAIL recall@5 ${score.recall5.toFixed(3)} is under the objective ${request.thresholds.recall5}${scope}`
					: `recall@5 holds the objective ${request.thresholds.recall5}${scope}`,
				"",
			].join("\n");
	return { code, text, warning: allWarnings.map((line) => `[substrate] corpus eval: ${printable(line)}\n`).join("") };
}
