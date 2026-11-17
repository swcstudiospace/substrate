/**
 * The PARITY_GATE comparator (SOTA-02, Phase 46, T3). Pure checks with injected reads: the CLI in
 * `scripts/parity-gate.ts` does the I/O, and this module does none.
 *
 * Part A, record mapping. Each `lightrag::` record of the docs state file is matched to its LightRAG document by the
 * plane document id the ingest recorded. The plane listing (`POST /documents/paginated`) returns only the id and the
 * `file_path` of a document (`planes/__fixtures__/lightrag-v1.5.7-routes.json`, route `paginated`), so the name is the
 * one place a listing carries dataset, source and version: `corpus:<repo>:<path>@<sha12>`. A matched pair compares
 * dataset (`dataset_id` to repo), source URL (`source_url` to path) and version (`sha` to the 12-character sha prefix).
 * A `file://` source URL (docs-ingest stores one) matches on its trailing path segments. A flattened ingest name
 * (`docs__x.md`) carries the path only, so it confirms the source and is an unverifiable name for dataset and version.
 * Zero mismatches is the pass. A record with no document, a document with no record, and any field that differs are
 * each a mismatch. A truncated listing and an empty record set fail closed: neither proves a match.
 *
 * Part B, sample. Each frozen question is asked of `/query`. It passes when one of the top-five citations comes from
 * the expected document. The gate passes when the match rate meets the threshold (D3, agent default, pending
 * operator: 100 percent, so one miss fails).
 */
import { CORPUS_NAME_PREFIX, parseCorpusDocumentName } from "@substrate/corpus";
import { documentName } from "./planes/lightrag.ts";

/** One `lightrag::` record of the docs state file, with the fields the mapping reads. */
export interface ManifestRecord {
	/** The LightRAG document id the ingest resolved (`IngestRecord.document_id`); empty when it never resolved. */
	documentId: string;
	datasetId: string;
	sourceUrl: string;
	/** The content hash the ingest recorded (`IngestRecord.sha`). */
	sha: string;
}

/** One `corpus:`-named document the plane listed: its id and the name it was stored under. */
export interface PlaneDocument {
	id: string;
	name: string;
}

export type MappingMismatch =
	| { kind: "record-without-document"; documentId: string }
	| { kind: "document-without-record"; id: string }
	| { kind: "unparseable-name"; id: string }
	| { kind: "dataset-mismatch"; id: string }
	| { kind: "source-url-mismatch"; id: string }
	| { kind: "version-mismatch"; id: string }
	| { kind: "unverifiable-name"; id: string };

export interface RecordMappingResult {
	ok: boolean;
	records: number;
	documents: number;
	mismatches: MappingMismatch[];
	/** Why the check failed closed before comparing, when it did. */
	reason?: string;
}

/**
 * Compares the manifest's `lightrag::` records with the plane's documents. A `corpus:` name carries dataset, path and sha; a
 * flattened name carries the path only. `listingTruncated` is the plane's
 * own answer that its listing is incomplete: a document missing from a truncated listing proves nothing, so it fails.
 */
export function checkRecordMapping(records: readonly ManifestRecord[], documents: readonly PlaneDocument[], listingTruncated: boolean): RecordMappingResult {
	const base = { records: records.length, documents: documents.length };
	if (listingTruncated) return { ok: false, ...base, mismatches: [], reason: "plane listing is truncated: a missing document proves nothing" };
	if (records.length === 0) return { ok: false, ...base, mismatches: [], reason: "no lightrag records to compare: refusing to pass an empty check" };

	const byId = new Map<string, PlaneDocument>();
	for (const document of documents) byId.set(document.id, document);
	const referenced = new Set<string>();
	const mismatches: MappingMismatch[] = [];

	for (const record of records) {
		const document = record.documentId.length > 0 ? byId.get(record.documentId) : undefined;
		if (document === undefined) {
			mismatches.push({ kind: "record-without-document", documentId: record.documentId });
			continue;
		}
		referenced.add(document.id);
		if (!document.name.startsWith(CORPUS_NAME_PREFIX)) {
			// A flattened ingest name carries the path only: it can confirm the source, never the dataset or the version.
			if (!flattenedNameMatches(record.sourceUrl, document.name)) mismatches.push({ kind: "source-url-mismatch", id: document.id });
			mismatches.push({ kind: "unverifiable-name", id: document.id });
			continue;
		}
		const name = parseCorpusDocumentName(document.name);
		if (name === null) {
			mismatches.push({ kind: "unparseable-name", id: document.id });
			continue;
		}
		if (record.datasetId !== name.repo) mismatches.push({ kind: "dataset-mismatch", id: document.id });
		if (!sourceMatchesPath(record.sourceUrl, name.path)) mismatches.push({ kind: "source-url-mismatch", id: document.id });
		if (!record.sha.startsWith(name.sha12)) mismatches.push({ kind: "version-mismatch", id: document.id });
	}
	for (const document of documents) {
		if (!referenced.has(document.id)) mismatches.push({ kind: "document-without-record", id: document.id });
	}
	return { ok: mismatches.length === 0, ...base, mismatches };
}

/**
 * Whether a record's source names the repo-relative path. A stored repo-relative source must equal it. A `file://` source is
 * absolute, so the path must be its trailing segments, at a `/` boundary: `xdocs/a.md` does not name `docs/a.md`.
 */
function sourceMatchesPath(sourceUrl: string, repoPath: string): boolean {
	const decoded = safeDecode(sourceUrl.trim());
	if (!decoded.startsWith("file://")) return decoded === repoPath;
	const absolute = decoded.slice("file://".length).replace(/^\/+/, "");
	return absolute === repoPath || absolute.endsWith(`/${repoPath}`);
}

/**
 * Whether a flattened ingest name (`documentName`) is what a record's source flattens to. The name keeps the path under the
 * repo and no repo or sha, so every trailing run of segments is tried: `file:///srv/docs/a.md` flattens to `docs__a.md`, and
 * `file:///srv/xdocs/a.md` does not.
 */
export function flattenedNameMatches(sourceUrl: string, name: string): boolean {
	const decoded = safeDecode(sourceUrl.trim());
	if (!decoded.startsWith("file://")) return documentName(decoded) === name;
	const absolute = decoded.slice("file://".length);
	for (let start = 0; start < absolute.length; start += 1) {
		if (start > 0 && absolute[start - 1] !== "/") continue;
		if (documentName(absolute.slice(start)) === name) return true;
	}
	return false;
}

/**
 * The `lightrag::` records of a parsed docs state file (version 2 or 1: both keep `records`). A record whose fields
 * are malformed is kept with empty fields, so it surfaces as a mismatch and is never silently dropped. Null when the
 * file has no records table.
 */
export function manifestRecords(state: unknown): ManifestRecord[] | null {
	if (state === null || typeof state !== "object" || !("records" in state)) return null;
	const table = state.records;
	if (table === null || typeof table !== "object" || Array.isArray(table)) return null;
	const out: ManifestRecord[] = [];
	for (const [key, value] of Object.entries(table)) {
		if (!key.startsWith("lightrag::")) continue;
		const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
		out.push({
			documentId: typeof record.document_id === "string" ? record.document_id : "",
			datasetId: typeof record.dataset_id === "string" ? record.dataset_id : "",
			sourceUrl: typeof record.source_url === "string" ? record.source_url : "",
			sha: typeof record.sha === "string" ? record.sha : "",
		});
	}
	return out;
}

/** One question of the frozen PARITY sample. The wording is fixed; see the "Frozen sample" table in 46-PLAN.md. */
export interface SampleQuery {
	id: string;
	question: string;
	/** The repo-relative document a passing answer cites. */
	expectedSource: string;
}

/**
 * The ten governing queries (archived v1.5 PLAN, T3, with Q8 amended 2026-10-25). `parity-gate.test.ts` checks that this
 * list matches the frozen table in 46-PLAN.md, so the two cannot drift apart.
 */
export const FROZEN_SAMPLE: readonly SampleQuery[] = [
	{ id: "Q1", question: "Which LightRAG query mode does docs_search use by default?", expectedSource: "docs/docs-plane.md" },
	{ id: "Q2", question: "How does docs ingest refuse secrets or unsourced pages?", expectedSource: "docs/docs-search-ingest.md" },
	{ id: "Q3", question: "How is Hindsight memory governed for retained memories?", expectedSource: "docs/memory-governance.md" },
	{ id: "Q4", question: "How are Greptime ledger events stored and read?", expectedSource: "docs/greptime-ledger.md" },
	{ id: "Q5", question: "What is the closed event vocabulary?", expectedSource: "docs/event-vocabulary.md" },
	{ id: "Q6", question: "How does the redactor treat secrets in output?", expectedSource: "docs/redaction.md" },
	{ id: "Q7", question: "How does the substrate dispatcher start a Hermes session?", expectedSource: "docs/dispatcher.md" },
	{ id: "Q8", question: "What does the skills propose flow check before it opens a pull request?", expectedSource: "docs/skills-propose.md" },
	{ id: "Q9", question: "How does the Railway service connect over Tailscale?", expectedSource: "docs/railway-tailscale.md" },
	{ id: "Q10", question: "What does the MCP audit log record?", expectedSource: "docs/mcp-audit.md" },
];

/** The default match threshold: D3 (agent default, pending operator). One miss in ten fails it. */
export const PARITY_THRESHOLD = 1;

/** The top-k a sample query asks for: the docs_search default limit, so a pass means a citation the caller would see. */
export const SAMPLE_TOP_K = 5;

/** The citation sources a query answered with, in rank order, or the reason it did not answer. */
export type SampleQueryOutcome = { ok: true; sources: string[] } | { ok: false; reason: string };

/**
 * Whether one citation source names the expected document. A corpus name resolves to its path, a `file://` URL to its
 * path, and a flattened ingest name (`docs__x.md`) to the document it was built from. A suffix match needs a `/` before
 * it, so `xdocs/x.md` does not match `docs/x.md`.
 */
export function citationMatches(source: string, expectedSource: string): boolean {
	const decoded = safeDecode(source.trim());
	const corpus = parseCorpusDocumentName(decoded);
	const path = corpus !== null ? corpus.path : decoded.replace(/^file:\/\//, "").replace(/^\.?\/+/, "");
	return path === expectedSource || path.endsWith(`/${expectedSource}`) || path === documentName(expectedSource);
}

function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

export interface SampleQueryResult {
	id: string;
	hit: boolean;
	/** The reason a query did not answer; absent when it answered (hit or miss). */
	reason?: string;
}

export interface SampleResult {
	ok: boolean;
	queries: number;
	passes: number;
	rate: number;
	threshold: number;
	results: SampleQueryResult[];
}

/**
 * Asks each sample question once, in order, and scores it. A query that does not answer is a miss with its reason. The
 * gate passes only when there is at least one query and the match rate is at least `threshold`.
 */
export async function runSample(
	sample: readonly SampleQuery[],
	query: (question: string) => Promise<SampleQueryOutcome>,
	threshold: number = PARITY_THRESHOLD,
): Promise<SampleResult> {
	const results: SampleQueryResult[] = [];
	for (const item of sample) {
		const outcome = await query(item.question);
		if (!outcome.ok) {
			results.push({ id: item.id, hit: false, reason: outcome.reason });
			continue;
		}
		const hit = outcome.sources.slice(0, SAMPLE_TOP_K).some((source) => citationMatches(source, item.expectedSource));
		results.push({ id: item.id, hit });
	}
	const passes = results.filter((result) => result.hit).length;
	const rate = results.length === 0 ? 0 : passes / results.length;
	return { ok: results.length > 0 && rate >= threshold, queries: results.length, passes, rate, threshold, results };
}
