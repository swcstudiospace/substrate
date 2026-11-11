#!/usr/bin/env bun
/**
 * The PARITY_GATE CLI (SOTA-02, Phase 46, T3): `bun scripts/parity-gate.ts --part A|B`. Read-only: it reads the docs state
 * file, lists the plane's documents (`POST /documents/paginated`), and asks the frozen sample of `/query`. It writes
 * nothing to any store.
 *
 * Exit codes: 0 the part passed; 1 the part failed, or the plane could not be read; 2 the arguments are bad, or
 * `LIGHTRAG_URL` is unset, in which case no socket is opened.
 *
 * The reach is read by `lightragFromEnv` (config.ts), the one LightRAG reader. The output carries counts, the mode and
 * per-query hit flags only: never a key, a host, a document id, or a source URL. A plane failure is printed as its
 * category (`reasonCategory`), because transport text can carry the plane's address.
 */
import { readFile } from "node:fs/promises";
import { type LightragConfig, lightragFromEnv } from "../packages/mcp-server/src/config.ts";
import { checkRecordMapping, FROZEN_SAMPLE, manifestRecords, PARITY_THRESHOLD, runSample, SAMPLE_TOP_K } from "../packages/mcp-server/src/parity-gate.ts";
import { createLightragBulkPlane } from "../packages/mcp-server/src/planes/lightrag-bulk.ts";
import { DEFAULT_QUERY_MODE, type FetchLike, retrieveChunks } from "../packages/mcp-server/src/planes/lightrag.ts";

export type Part = "A" | "B";

const USAGE = "usage: parity-gate --part A|B";

/** The one `--part` argument: the part, or the reason the arguments were refused. */
export function parsePartArgs(argv: readonly string[]): { part: Part } | { reason: string } {
	const value = argv[1];
	if (argv.length === 2 && argv[0] === "--part" && (value === "A" || value === "B")) return { part: value };
	return { reason: USAGE };
}

export interface ParityOutcome {
	exitCode: 0 | 1 | 2;
	report: Record<string, unknown>;
}

/** Test seam: the fetch the plane is read through. Absent in the CLI, where the global fetch is used. */
export interface ParityDeps {
	fetch?: FetchLike;
}

const refused = (part: Part, reason: string): ParityOutcome => ({ exitCode: 2, report: { part, ok: false, reason } });

/** The only plane failure reasons a report may print: transport text can carry the plane's address, so it is never echoed. */
const REASON_CATEGORY = /^lightrag(?: unreachable| circuit open| code \d+| \d{3})?$/;

/** A plane failure reason as the report prints it: its category only, or `plane-unavailable` for anything unrecognised. */
export function reasonCategory(reason: string): string {
	const head = (reason.split(":")[0] ?? "").trim();
	return REASON_CATEGORY.test(head) ? head : "plane-unavailable";
}

/** Part A: the docs state records against the plane's documents. */
export async function runPartA(part: Part, env: Record<string, string | undefined>, config: LightragConfig, deps: ParityDeps = {}): Promise<ParityOutcome> {
	const file = env.SUBSTRATE_DOCS_STATE_FILE?.trim();
	if (!file) return refused(part, "SUBSTRATE_DOCS_STATE_FILE is unset");
	let state: unknown;
	try {
		state = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return refused(part, "the docs state file is unreadable or not JSON");
	}
	const records = manifestRecords(state);
	if (records === null) return refused(part, "the docs state file has no records table");
	const listing = await createLightragBulkPlane(config, deps).listDocuments();
	if (!listing.ok) return { exitCode: 1, report: { part, ok: false, reason: listing.reason } };
	const result = checkRecordMapping(records, listing.documents, listing.truncated, listing.otherDocumentIds);
	const mismatches: Record<string, number> = {};
	for (const mismatch of result.mismatches) mismatches[mismatch.kind] = (mismatches[mismatch.kind] ?? 0) + 1;
	const report: Record<string, unknown> = {
		part,
		ok: result.ok,
		records: result.records,
		plane_documents: result.documents,
		other_documents: listing.otherDocumentIds.length,
		truncated: listing.truncated,
		mismatches,
		mismatch_count: result.mismatches.length,
	};
	if (result.reason !== undefined) report.reason = result.reason;
	return { exitCode: result.ok ? 0 : 1, report };
}

/** Part B: the frozen sample against `/query`, in the mode the server is configured for. */
export async function runPartB(part: Part, config: LightragConfig, deps: ParityDeps = {}): Promise<ParityOutcome> {
	const mode = config.queryMode ?? DEFAULT_QUERY_MODE;
	const result = await runSample(FROZEN_SAMPLE, async (question) => {
		const outcome = await retrieveChunks(config, { question, topK: SAMPLE_TOP_K, mode }, deps.fetch);
		if (!outcome.ok) return { ok: false, reason: reasonCategory(outcome.reason) };
		return { ok: true, sources: outcome.chunks.map((chunk) => chunk.source_url ?? chunk.document_name) };
	});
	return {
		exitCode: result.ok ? 0 : 1,
		report: {
			part,
			ok: result.ok,
			mode,
			top_k: SAMPLE_TOP_K,
			queries: result.queries,
			passes: result.passes,
			rate: result.rate,
			threshold: PARITY_THRESHOLD,
			results: result.results,
		},
	};
}

/**
 * The whole CLI as a function of its arguments and environment: the outcome, with nothing written and no exit set. The
 * entry point below prints the report and sets the exit code. Without `LIGHTRAG_URL` it returns before any plane read.
 */
export async function runParity(argv: readonly string[], env: Record<string, string | undefined>, deps: ParityDeps = {}): Promise<ParityOutcome> {
	const parsed = parsePartArgs(argv);
	if ("reason" in parsed) return { exitCode: 2, report: { ok: false, reason: parsed.reason } };
	const config = lightragFromEnv(env);
	if (config === null) return refused(parsed.part, "LIGHTRAG_URL is unset; no socket was opened");
	return parsed.part === "A" ? runPartA(parsed.part, env, config, deps) : runPartB(parsed.part, config, deps);
}

if (import.meta.main) {
	const outcome = await runParity(process.argv.slice(2), process.env);
	process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
	process.exitCode = outcome.exitCode;
}
