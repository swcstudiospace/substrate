#!/usr/bin/env bun
/**
 * The PARITY_GATE CLI (SOTA-02, Phase 46, T3): `bun scripts/parity-gate.ts --part A|B`. Read-only: it reads the docs state
 * file, lists the plane's `corpus:` documents (`POST /documents/paginated`), and asks the frozen sample of `/query`. It writes
 * nothing to any store.
 *
 * Exit codes: 0 the part passed; 1 the part failed, or the plane could not be read; 2 the arguments are bad, or
 * `LIGHTRAG_URL` is unset, in which case no socket is opened.
 *
 * The reach is read by `lightragFromEnv` (config.ts), the one LightRAG reader. The output carries counts, the mode and
 * per-query hit flags only: never a key, a host, a document id, or a source URL.
 */
import { readFile } from "node:fs/promises";
import { type LightragConfig, lightragFromEnv } from "../packages/mcp-server/src/config.ts";
import { checkRecordMapping, FROZEN_SAMPLE, manifestRecords, PARITY_THRESHOLD, runSample, SAMPLE_TOP_K } from "../packages/mcp-server/src/parity-gate.ts";
import { createLightragBulkPlane } from "../packages/mcp-server/src/planes/lightrag-bulk.ts";
import { DEFAULT_QUERY_MODE, retrieveChunks } from "../packages/mcp-server/src/planes/lightrag.ts";

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

const refused = (part: Part, reason: string): ParityOutcome => ({ exitCode: 2, report: { part, ok: false, reason } });

/** Part A: the docs state records against the plane's `corpus:` documents. */
export async function runPartA(part: Part, env: Record<string, string | undefined>, config: LightragConfig): Promise<ParityOutcome> {
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
	const listing = await createLightragBulkPlane(config).listDocuments();
	if (!listing.ok) return { exitCode: 1, report: { part, ok: false, reason: listing.reason } };
	const result = checkRecordMapping(records, listing.documents, listing.truncated);
	const mismatches: Record<string, number> = {};
	for (const mismatch of result.mismatches) mismatches[mismatch.kind] = (mismatches[mismatch.kind] ?? 0) + 1;
	const report: Record<string, unknown> = {
		part,
		ok: result.ok,
		records: result.records,
		plane_documents: result.documents,
		truncated: listing.truncated,
		mismatches,
		mismatch_count: result.mismatches.length,
	};
	if (result.reason !== undefined) report.reason = result.reason;
	return { exitCode: result.ok ? 0 : 1, report };
}

/** Part B: the frozen sample against `/query`, in the mode the server is configured for. */
export async function runPartB(part: Part, config: LightragConfig): Promise<ParityOutcome> {
	const mode = config.queryMode ?? DEFAULT_QUERY_MODE;
	const result = await runSample(FROZEN_SAMPLE, async (question) => {
		const outcome = await retrieveChunks(config, { question, topK: SAMPLE_TOP_K, mode });
		if (!outcome.ok) return { ok: false, reason: outcome.reason };
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

if (import.meta.main) {
	const parsed = parsePartArgs(process.argv.slice(2));
	let outcome: ParityOutcome;
	if ("reason" in parsed) {
		outcome = { exitCode: 2, report: { ok: false, reason: parsed.reason } };
	} else {
		const config = lightragFromEnv(process.env);
		if (config === null) outcome = refused(parsed.part, "LIGHTRAG_URL is unset; no socket was opened");
		else outcome = parsed.part === "A" ? await runPartA(parsed.part, process.env, config) : await runPartB(parsed.part, config);
	}
	process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
	process.exitCode = outcome.exitCode;
}
