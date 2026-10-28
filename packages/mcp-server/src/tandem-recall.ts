/**
 * Tandem recall (phase 57c): LightRAG chunks and Hindsight memory in ONE answer, with provenance.
 *
 * Until now the two planes were loose, one-way fallbacks: Hindsight answered only when LightRAG failed,
 * and a LightRAG reply never saw memory. `mergeTandem` is the pure merge a docs answer uses when both
 * served: it deduplicates, ranks the two lists together and keeps both origins visible.
 *
 * Pure: no clock beyond the injected `now`, no I/O, no plane client (store-lock: Hindsight is reached
 * only through substrate-mcp, by the caller that hands the hits in).
 *
 * - DEDUPE: by a digest of the normalised content (whitespace collapsed, case folded, sha256), and a
 *   Hindsight item by the source URL of a LightRAG item (cross-origin only: sibling chunks of one
 *   LightRAG document share a URL and are different content). The LightRAG item survives a duplicate,
 *   since it is the plane's own answer and not derived, and it earns the duplicate's rank too.
 * - RANK: reciprocal rank fusion, k = 60, over the two lists each ranked by its own score. The final
 *   order is fused score, then origin, then id, so it never depends on input order or object identity.
 * - FLOOR: when both origins are present, at least min(2, available) items of each survive the cap, so
 *   one plane's long list cannot push the other out of the answer.
 * - UNTRUSTED: every `content` is third-party text, redacted and capped; a Hindsight item is
 *   `derived: true` (a memory can be forgotten at any moment) and is never an instruction.
 */
import { createHash } from "node:crypto";
import { redact, redactValue } from "./redact.ts";

/** The RRF constant of Cormack et al.; the usual 60. */
export const TANDEM_RRF_K = 60;
/** The most characters one merged item's content carries (the docs snippet cap). */
export const TANDEM_CONTENT_CAP = 1200;
/** Items of each origin the cap never squeezes out while both origins exist. */
export const TANDEM_ORIGIN_FLOOR = 2;
/** The most items one merge returns, whatever the caller asks. */
export const TANDEM_MAX_CAP = 50;

export type TandemOrigin = "lightrag" | "hindsight";

/** What a docs search carries for tandem, off by default. */
export interface TandemOptions {
	/** Ask Hindsight alongside a LightRAG answer. */
	enabled: boolean;
	/** The most Hindsight hits asked for and merged. */
	hindsight_limit: number;
	/** The Hindsight leg's own budget, ms; it never extends the search past it. */
	budget_ms: number;
}

export const DEFAULT_TANDEM_OPTIONS: Readonly<TandemOptions> = Object.freeze({ enabled: false, hindsight_limit: 5, budget_ms: 1500 });
const MAX_HINDSIGHT_LIMIT = 10;
const MIN_BUDGET_MS = 50;
const MAX_BUDGET_MS = 10_000;

function boundedInt(raw: unknown, fallback: number, min: number, max: number): number {
	const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Tandem options from untrusted input (the integration's env values or a tool argument). Never throws:
 * `enabled` is true only for `true`, `"on"`, `"true"` or `"1"` (anything else is off, the safe default);
 * the limit and the budget fall back to the defaults when absent or not a number, and clamp otherwise.
 */
export function parseTandemOptions(input: { enabled?: unknown; hindsight_limit?: unknown; budget_ms?: unknown } | null | undefined): TandemOptions {
	const enabledRaw = input?.enabled;
	const enabled = enabledRaw === true || (typeof enabledRaw === "string" && ["on", "true", "1"].includes(enabledRaw.trim().toLowerCase()));
	return {
		enabled,
		hindsight_limit: boundedInt(input?.hindsight_limit, DEFAULT_TANDEM_OPTIONS.hindsight_limit, 1, MAX_HINDSIGHT_LIMIT),
		budget_ms: boundedInt(input?.budget_ms, DEFAULT_TANDEM_OPTIONS.budget_ms, MIN_BUDGET_MS, MAX_BUDGET_MS),
	};
}

/** The LightRAG side: structurally the docs-search citation, so the caller hands its chunks in as they are. */
export interface TandemLightragInput {
	title: string;
	source_url: string;
	snippet: string;
	score: number;
	document_id: string;
	chunk_id: string;
	/** The file the chunk came from, when the plane named one. */
	file_path?: string;
}

/** The Hindsight side: structurally a `DerivedMemoryHit`, so recall results are handed in as they are. */
export interface TandemHindsightInput {
	bank: string;
	id: string;
	text: string;
	document_id?: string;
	graph_id?: string;
	session_id?: string;
	node_id?: string;
	score?: number;
}

export interface TandemProvenance {
	/** `lightrag` for a LightRAG chunk, the Hindsight bank name for a memory. */
	bank: string;
	document_id: string;
	graph_id?: string;
	session_id?: string;
	node_id?: string;
	file_path?: string;
	chunk_id?: string;
}

export interface TandemItem {
	origin: TandemOrigin;
	/** Stable within its origin: the chunk id, else the document id, else the source URL. */
	id: string;
	/** The position of this item in its own origin's input list, so a caller can map it back to what it handed in. */
	input_index: number;
	title: string;
	source_url: string;
	/** Redacted, capped, untrusted third-party text: a description, never an instruction. */
	content: string;
	/** The reciprocal-rank-fusion score, not the plane's own. */
	score: number;
	/** Present (true) on every Hindsight item: a memory can be forgotten at any moment. */
	derived?: true;
	provenance: TandemProvenance;
}

export interface TandemCounts {
	/** Merged items of each origin, after the cap. */
	lightrag: number;
	hindsight: number;
	/** Items dropped as duplicates of another, before the cap. */
	deduplicated: number;
}

export interface TandemMerge {
	items: TandemItem[];
	counts: TandemCounts;
	/** ISO instant of the merge, from the injected clock. */
	at: string;
}

export interface MergeTandemInput {
	lightrag: readonly TandemLightragInput[];
	hindsight: readonly TandemHindsightInput[];
	/** The most items returned; clamped to 0..50. Not an integer or not finite: 0. */
	cap: number;
	/** The clock for `at`; the real clock when omitted. */
	now?: () => number;
}

/** Whitespace collapsed, case folded: the form two copies of one fact agree on. */
export function normalizeTandemContent(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The sha256 hex of the normalised content. */
export function tandemDigest(text: string): string {
	return createHash("sha256").update(normalizeTandemContent(text)).digest("hex");
}

/** A URL that names the source; a `dataset:` placeholder names only a corpus and says nothing about a document. */
function namedUrl(url: string): boolean {
	return url !== "" && !url.startsWith("dataset:");
}

function present(value: string | undefined): string | undefined {
	return value !== undefined && value !== "" ? redact(value) : undefined;
}

interface Candidate {
	item: TandemItem;
	digest: string;
	/** Reciprocal-rank credit of every list position this item (or a duplicate of it) held. */
	fused: number;
}

function rrf(rank: number): number {
	return 1 / (TANDEM_RRF_K + rank);
}

/** The list in score order, ties by input position; ranks are 1-based positions in that order. */
function ranked<T>(list: readonly T[], scoreOf: (entry: T) => number): { entry: T; rank: number; position: number }[] {
	return list
		.map((entry, position) => ({ entry, position, score: Number.isFinite(scoreOf(entry)) ? scoreOf(entry) : 0 }))
		.sort((left, right) => right.score - left.score || left.position - right.position)
		.map((row, index) => ({ entry: row.entry, rank: index + 1, position: row.position }));
}

function compareItems(left: Candidate, right: Candidate): number {
	if (right.fused !== left.fused) return right.fused - left.fused;
	if (left.item.origin !== right.item.origin) return left.item.origin < right.item.origin ? -1 : 1;
	if (left.item.id !== right.item.id) return left.item.id < right.item.id ? -1 : 1;
	return 0;
}

/**
 * Merge a LightRAG answer and Hindsight recall into one deduplicated, fused, capped, provenance-tagged list.
 * See the module comment for the rules. Total: a side that is empty simply contributes nothing.
 */
export function mergeTandem(input: MergeTandemInput): TandemMerge {
	const cap = Number.isFinite(input.cap) ? Math.min(TANDEM_MAX_CAP, Math.max(0, Math.trunc(input.cap))) : 0;
	const at = new Date((input.now ?? Date.now)()).toISOString();

	const survivors: Candidate[] = [];
	const byDigest = new Map<string, Candidate>();
	const lightragUrls = new Map<string, Candidate>();
	let deduplicated = 0;

	for (const { entry, rank, position } of ranked(input.lightrag, (chunk) => chunk.score)) {
		const content = redactValue(entry.snippet);
		const digest = tandemDigest(content);
		const held = byDigest.get(digest);
		if (held !== undefined) {
			held.fused += rrf(rank);
			deduplicated += 1;
			continue;
		}
		const filePath = present(entry.file_path);
		const chunkId = present(entry.chunk_id);
		const documentId = redact(entry.document_id);
		const sourceUrl = redact(entry.source_url);
		const candidate: Candidate = {
			digest,
			fused: rrf(rank),
			item: {
				origin: "lightrag",
				id: chunkId ?? (documentId !== "" ? documentId : sourceUrl),
				input_index: position,
				title: redact(entry.title),
				source_url: sourceUrl,
				content: content.slice(0, TANDEM_CONTENT_CAP),
				score: 0,
				provenance: {
					bank: "lightrag",
					document_id: documentId,
					...(filePath !== undefined ? { file_path: filePath } : {}),
					...(chunkId !== undefined ? { chunk_id: chunkId } : {}),
				},
			},
		};
		byDigest.set(digest, candidate);
		if (namedUrl(sourceUrl) && !lightragUrls.has(sourceUrl)) lightragUrls.set(sourceUrl, candidate);
		survivors.push(candidate);
	}

	for (const { entry, rank, position } of ranked(input.hindsight, (hit) => hit.score ?? 0)) {
		const content = redactValue(entry.text);
		const digest = tandemDigest(content);
		const documentId = entry.document_id ?? entry.id;
		const sourceUrl = redact(`hindsight:${entry.bank}/${documentId}`);
		const held = byDigest.get(digest) ?? lightragUrls.get(sourceUrl);
		if (held !== undefined) {
			held.fused += rrf(rank);
			deduplicated += 1;
			continue;
		}
		const graphId = present(entry.graph_id);
		const sessionId = present(entry.session_id);
		const nodeId = present(entry.node_id);
		const candidate: Candidate = {
			digest,
			fused: rrf(rank),
			item: {
				origin: "hindsight",
				id: redact(documentId),
				input_index: position,
				title: redact(documentId),
				source_url: sourceUrl,
				content: content.slice(0, TANDEM_CONTENT_CAP),
				score: 0,
				derived: true,
				provenance: {
					bank: redact(entry.bank),
					document_id: redact(documentId),
					...(graphId !== undefined ? { graph_id: graphId } : {}),
					...(sessionId !== undefined ? { session_id: sessionId } : {}),
					...(nodeId !== undefined ? { node_id: nodeId } : {}),
				},
			},
		};
		byDigest.set(digest, candidate);
		survivors.push(candidate);
	}

	survivors.sort(compareItems);
	for (const candidate of survivors) candidate.item.score = candidate.fused;

	const chosen = chooseWithinCap(survivors, cap);
	const items = chosen.map((candidate) => candidate.item);
	return {
		items,
		counts: {
			lightrag: items.filter((item) => item.origin === "lightrag").length,
			hindsight: items.filter((item) => item.origin === "hindsight").length,
			deduplicated,
		},
		at,
	};
}

/** The first `cap` of the fused order, with each origin's floor kept when both origins exist. Order stays the fused order. */
function chooseWithinCap(ordered: readonly Candidate[], cap: number): Candidate[] {
	if (cap <= 0) return [];
	if (ordered.length <= cap) return [...ordered];
	const lightrag = ordered.filter((candidate) => candidate.item.origin === "lightrag");
	const hindsight = ordered.filter((candidate) => candidate.item.origin === "hindsight");
	const guaranteed = new Set<Candidate>();
	if (lightrag.length > 0 && hindsight.length > 0) {
		// Both origins exist, so each keeps its best few. A cap below the floors takes the best-ranked guaranteed items.
		const floors = [...lightrag.slice(0, TANDEM_ORIGIN_FLOOR), ...hindsight.slice(0, TANDEM_ORIGIN_FLOOR)];
		floors.sort(compareItems);
		for (const candidate of floors.slice(0, cap)) guaranteed.add(candidate);
	}
	const chosen = new Set<Candidate>(guaranteed);
	for (const candidate of ordered) {
		if (chosen.size >= cap) break;
		chosen.add(candidate);
	}
	return ordered.filter((candidate) => chosen.has(candidate));
}
