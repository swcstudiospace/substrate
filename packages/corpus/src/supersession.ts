/**
 * Which documents a newer one replaces (v1.7 phase 66, decision D66-5).
 *
 * Pure: rows in, a map out. Exactly three rules, applied in this order, and the first rule that flags a document wins:
 *
 *  1. an explicit `superseded-by` marker on the document, when its target is a row of the same repository;
 *  2. a live document and its milestone archive: `.planning/milestones/<dir>/<rest>` (or the flat `.planning/milestones/v<version>-<name>`)
 *     is superseded by the live `.planning/<rest>` (or `.planning/<name>`) of the same repository, when that row exists;
 *  3. the same path in exactly two `local/*` copy collections of one source with different sha256: the older copy is
 *     superseded by the newer one.
 *
 * Nothing is inferred across unrelated repositories or sources, and an ambiguous case is left unflagged: a wrong
 * "superseded" label would hide a current document, while a missing one only costs a little ranking.
 */
import { isValidPath } from "./names.ts";
import { type CorpusSource, type DocKind, type DocTier, documentKey } from "./protocol.ts";

export interface SupersessionRow {
	repo: string;
	path: string;
	sha256: string;
	tier: DocTier;
	kind: DocKind;
	source: CorpusSource;
	/** ISO 8601 time the row last changed. */
	updatedAt: string;
	/** The explicit marker recorded for the row, a repo-relative path. */
	supersededBy?: string | undefined;
}

/** The front-matter marker is only looked for in the first lines of a document, so a huge body costs nothing. */
const MAX_FRONT_MATTER_LINES = 100;
const MARKER_KEY = "superseded-by";
const LOCAL_PREFIX = "local/";
const PLANNING_SEGMENT = ".planning";
const MILESTONES_SEGMENT = "milestones";
/** `v1.6-ROADMAP.md`: the flat name of an archived planning file, the version prefix then the live file name. */
const FLAT_ARCHIVE_NAME = /^v[0-9][0-9A-Za-z.]*-(.+)$/;

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function unquote(value: string): string {
	const first = value[0];
	if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1).trim();
	return value;
}

/**
 * The explicit `superseded-by` front-matter marker of a document body: a repo-relative path, else null. The front matter
 * must open the document (after an optional byte-order mark) with a `---` line and close with another within the first
 * lines. A value that is not a valid relative path (a URL, an absolute path, `..`, empty) is no marker.
 */
export function supersededByMarker(body: string): string | null {
	const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/, MAX_FRONT_MATTER_LINES);
	if (lines[0]?.trim() !== "---") return null;
	let marker: string | null | undefined;
	for (const line of lines.slice(1)) {
		if (line.trim() === "---") return marker ?? null;
		const colon = line.indexOf(":");
		if (marker !== undefined || colon === -1 || line.slice(0, colon).trim().toLowerCase() !== MARKER_KEY) continue;
		const value = unquote(line.slice(colon + 1).trim()).replace(/^\.\//, "");
		marker = isValidPath(value) ? value : null;
	}
	// No closing line: the opening `---` was a rule, not front matter.
	return null;
}

/** The marker an entry of this tier carries: only tier 1 and 2 documents are read for one, bulk and historical tier 3 never are. */
export function entrySupersededBy(tier: DocTier, body: string): string | undefined {
	return tier <= 2 ? (supersededByMarker(body) ?? undefined) : undefined;
}

/** Rule 2: the live path an archived planning path was superseded by, or null when the path is not an archive. */
function liveCounterpart(path: string): string | null {
	const segments = path.split("/");
	const planningAt = segments.findIndex((segment) => segment.toLowerCase() === PLANNING_SEGMENT);
	if (planningAt === -1 || segments[planningAt + 1]?.toLowerCase() !== MILESTONES_SEGMENT) return null;
	const below = segments.slice(planningAt + 2);
	const prefix = segments.slice(0, planningAt + 1);
	if (below.length >= 2) return [...prefix, ...below.slice(1)].join("/");
	const flat = FLAT_ARCHIVE_NAME.exec(below[0] ?? "")?.[1];
	return flat === undefined ? null : [...prefix, flat].join("/");
}

/**
 * Key (`documentKey`) of a superseded document -> key of the document that supersedes it, resolved to the end of its
 * chain. Deterministic whatever the order of `rows`. A chain that loops (two markers that point at each other) has no
 * current document, so none of its members is flagged.
 */
export function detectSupersession(rows: readonly SupersessionRow[]): Map<string, string> {
	// One row per key; a repeated key keeps the row that sorts last, so the input order never matters.
	const byKey = new Map<string, SupersessionRow>();
	for (const row of [...rows].sort(
		(a, b) => compareText(documentKey(a.repo, a.path), documentKey(b.repo, b.path)) || compareText(a.source, b.source) || compareText(a.sha256, b.sha256),
	)) {
		byKey.set(documentKey(row.repo, row.path), row);
	}
	const direct = new Map<string, string>();
	const flag = (from: string, to: string): void => {
		if (from !== to && !direct.has(from)) direct.set(from, to);
	};

	const ordered = [...byKey.entries()].sort((a, b) => compareText(a[0], b[0]));
	for (const [key, row] of ordered) {
		if (row.supersededBy !== undefined && row.tier <= 2 && isValidPath(row.supersededBy)) {
			const target = documentKey(row.repo, row.supersededBy);
			if (byKey.has(target)) flag(key, target);
		}
	}
	for (const [key, row] of ordered) {
		const live = liveCounterpart(row.path);
		if (live === null) continue;
		const target = documentKey(row.repo, live);
		if (byKey.has(target)) flag(key, target);
	}

	// Rule 3 groups the tier 1 and 2 rows of local copy collections by path; only a group of exactly two is judged.
	const copies = new Map<string, Array<[string, SupersessionRow]>>();
	for (const [key, row] of ordered) {
		if (!row.repo.startsWith(LOCAL_PREFIX) || row.tier > 2) continue;
		copies.set(row.path, [...(copies.get(row.path) ?? []), [key, row]]);
	}
	for (const group of copies.values()) {
		const [first, second] = group;
		if (group.length !== 2 || first === undefined || second === undefined) continue;
		const [firstKey, a] = first;
		const [secondKey, b] = second;
		if (a.repo === b.repo || a.source !== b.source || a.sha256 === b.sha256) continue;
		const aTime = Date.parse(a.updatedAt);
		const bTime = Date.parse(b.updatedAt);
		if (Number.isNaN(aTime) || Number.isNaN(bTime) || aTime === bTime) continue;
		if (aTime < bTime) flag(firstKey, secondKey);
		else flag(secondKey, firstKey);
	}

	const resolved = new Map<string, string>();
	for (const from of [...direct.keys()].sort(compareText)) {
		const seen = new Set<string>([from]);
		let target = direct.get(from);
		while (target !== undefined && direct.has(target) && !seen.has(target)) {
			seen.add(target);
			target = direct.get(target);
		}
		// A target that is itself flagged here means the walk met a loop: the chain has no current end.
		if (target !== undefined && !direct.has(target)) resolved.set(from, target);
	}
	return resolved;
}
