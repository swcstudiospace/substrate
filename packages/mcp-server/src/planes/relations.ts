/**
 * Phase 101 F2: deterministic relation extractor + typed retain.
 *
 * Records TS/JS imports, markdown links, and phase `Depends on` edges as
 * typed Hindsight episodes with provenance (source path + commit SHA only —
 * never secret content). Deterministic, no LLM. Bank owner is the extractor
 * surface (`RELATION_BANK_SURFACE`); one bank write per relation, no
 * dual-write. Recall joins these edges as `related` metadata via
 * `memory-recall.ts` (`attachRelated`); Phase 105 (F6) reads that metadata.
 */
import { bankForSurface, deleteDocument, RELATION_BANK_SURFACE, retainMemories } from "./hindsight.ts";
import type { FetchLike, HindsightConfig, HindsightResult, RecallHit, RetainItem } from "./hindsight.ts";

/** The relation kinds v1 extracts: TS/JS import, markdown link, phase dep. */
export type RelationKind = "import" | "md-link" | "phase-dep";

/** One directed file-to-file (or phase-to-phase) edge. */
export interface Relation {
	kind: RelationKind;
	from: string;
	to: string;
}

/** A relation with the provenance its episode carries. */
export interface RelationEdge extends Relation {
	source_path: string;
	commit: string;
}

/** The relations bank for a deployment: prefix + extractor surface. */
export function relationBank(config: HindsightConfig): string {
	return bankForSurface(config, RELATION_BANK_SURFACE);
}

/**
 * Static TS/JS imports out of `source`, attributed to `from`. Covers
 * `import x from`, side-effect `import`, `export … from`, dynamic
 * `import()`, and CommonJS `require()`. Raw specifiers are kept as `to`
 * (no path resolution — deterministic). Duplicates collapse to one edge.
 */
export function extractTsImports(from: string, source: string): Relation[] {
	const seen = new Set<string>();
	const out: Relation[] = [];
	const take = (to: string): void => {
		if (to.length === 0 || seen.has(to)) return;
		seen.add(to);
		out.push({ kind: "import", from, to });
	};
	// import x from "…", import {…} from "…", export … from "…" (incl. export *).
	for (const match of source.matchAll(/(?:import|export)[^'";]*?from\s*['"]([^'"]+)['"]/g)) {
		if (match[1] !== undefined) take(match[1]);
	}
	// Side-effect import: import "…";
	for (const match of source.matchAll(/import\s*['"]([^'"]+)['"]/g)) {
		if (match[1] !== undefined) take(match[1]);
	}
	// Dynamic import: import("…").
	for (const match of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
		if (match[1] !== undefined) take(match[1]);
	}
	// CommonJS: require("…").
	for (const match of source.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
		if (match[1] !== undefined) take(match[1]);
	}
	return out;
}

/**
 * Inline markdown links out of `source`, attributed to `from`. Relative
 * targets and `#anchor` targets are relations; absolute `http(s)`/`mailto`
 * URLs are skipped (not file edges). The raw target (anchor included) is
 * kept as `to`. Reference-style links are out of scope for v1.
 */
export function extractMdLinks(from: string, source: string): Relation[] {
	const seen = new Set<string>();
	const out: Relation[] = [];
	for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		const to = match[1];
		if (to === undefined || to.length === 0 || seen.has(to)) continue;
		if (/^(?:https?:\/\/|mailto:)/i.test(to)) continue;
		seen.add(to);
		out.push({ kind: "md-link", from, to });
	}
	return out;
}

/**
 * Phase `Depends on` edges out of `source`, attributed to `from`. Matches
 * `Depends on: A, B` (markdown-bolded or plain), strips trailing
 * parentheticals, and skips `Nothing` (no dependencies). One edge per dep.
 */
export function extractPhaseDeps(from: string, source: string): Relation[] {
	const out: Relation[] = [];
	for (const match of source.matchAll(/depends on\s*(?:\*\*)?\s*:\s*([^\n]+)/gi)) {
		const rest = (match[1] ?? "").trim();
		if (rest.length === 0 || /^nothing\b/i.test(rest)) continue;
		for (const part of rest.split(",")) {
			const to = part.replace(/\(.*\)\s*$/, "").trim().replace(/\*+$/g, "").trim();
			if (to.length === 0 || /^nothing\b/i.test(to)) continue;
			out.push({ kind: "phase-dep", from, to });
		}
	}
	return out;
}

/**
 * Every v1 relation out of `source`: TS imports + md links + phase deps,
 * deduped by (kind, from, to). Each sub-extractor only matches its own
 * syntax, so running all three unconditionally is safe for any file type.
 */
export function extractRelations(from: string, source: string): Relation[] {
	const seen = new Set<string>();
	const out: Relation[] = [];
	for (const relation of [...extractTsImports(from, source), ...extractMdLinks(from, source), ...extractPhaseDeps(from, source)]) {
		const key = `${relation.kind}${relation.from}${relation.to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(relation);
	}
	return out;
}

/**
 * The stable episode id for one relation: idempotent upsert key. Colons
 * survive because document endpoints `encodeURIComponent` the id.
 */
export function relationDocumentId(from: string, to: string, kind: RelationKind): string {
	return `rel:${kind}:${from}:${to}`;
}

/**
 * Relations as idempotent retain items (`update_mode: "replace"` over
 * `document_id` is applied by `retainMemories`). Metadata is provenance
 * only: relation kind, endpoints, source path, commit SHA.
 */
export function toRetainItems(relations: readonly Relation[], provenance: { commit: string }): RetainItem[] {
	return relations.map((relation) => ({
		content: `relation ${relation.kind} ${relation.from} -> ${relation.to}`,
		tags: ["relation", `relation:${relation.kind}`],
		metadata: {
			relation_kind: relation.kind,
			from: relation.from,
			to: relation.to,
			source_path: relation.from,
			commit: provenance.commit,
		},
		document_id: relationDocumentId(relation.from, relation.to, relation.kind),
	}));
}

/** What re-extraction changed: edges to add and episode ids to delete. */
export interface RelationDiff {
	added: Relation[];
	removed: Relation[];
}

/**
 * Diff stale relations against a fresh extraction, keyed by episode id:
 * fresh-only edges are added, stale-only ones are removed, shared ones are
 * untouched (re-retain would be identical — idempotent).
 */
export function diffRelations(oldRelations: readonly Relation[], freshRelations: readonly Relation[]): RelationDiff {
	const keyOf = (relation: Relation): string => relationDocumentId(relation.from, relation.to, relation.kind);
	const fresh = new Set(freshRelations.map(keyOf));
	const old = new Set(oldRelations.map(keyOf));
	return {
		added: freshRelations.filter((relation) => !old.has(keyOf(relation))),
		removed: oldRelations.filter((relation) => !fresh.has(keyOf(relation))),
	};
}

/**
 * Relation edges parsed back out of recalled relation episodes: the lookup
 * half of the recall join. Episodes whose metadata lacks string
 * `relation_kind`/`from`/`to` are not relation records and are skipped.
 */
export function edgesFromRelationHits(hits: readonly RecallHit[]): RelationEdge[] {
	const out: RelationEdge[] = [];
	for (const hit of hits) {
		const kind = hit.metadata.relation_kind;
		const from = hit.metadata.from ?? hit.metadata.source_path;
		const to = hit.metadata.to;
		const sourcePath = hit.metadata.source_path;
		const commit = hit.metadata.commit;
		if ((kind !== "import" && kind !== "md-link" && kind !== "phase-dep") || typeof from !== "string" || typeof to !== "string") continue;
		out.push({
			kind,
			from,
			to,
			source_path: typeof sourcePath === "string" ? sourcePath : from,
			commit: typeof commit === "string" ? commit : "",
		});
	}
	return out;
}

/**
 * The self-improvement update loop: retain added edges (idempotent upsert)
 * and delete stale episodes. Skips the retain call when nothing was added
 * (`retainMemories` forbids empty retains). Returns the applied counts.
 */
export async function syncRelations(
	config: HindsightConfig,
	bank: string,
	oldRelations: readonly Relation[],
	freshRelations: readonly Relation[],
	options: { commit: string; fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<HindsightResult<{ added: number; removed: number }>> {
	const diff = diffRelations(oldRelations, freshRelations);
	if (diff.added.length > 0) {
		const retained = await retainMemories(config, bank, toRetainItems(diff.added, { commit: options.commit }), options.fetchImpl ?? fetch, options.timeoutMs ?? 8000);
		if (!retained.ok) return retained;
	}
	for (const stale of diff.removed) {
		const deleted = await deleteDocument(config, bank, relationDocumentId(stale.from, stale.to, stale.kind), options.fetchImpl ?? fetch, options.timeoutMs ?? 4000);
		if (!deleted.ok) return deleted;
	}
	return { ok: true, value: { added: diff.added.length, removed: diff.removed.length } };
}
