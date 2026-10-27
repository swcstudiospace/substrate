/**
 * The change between two planning indexes (phase 52). Compares path and sha256 only, so the diff carries no file text and
 * no frontmatter. Each changed path carries its sha256 before and after: an added path has no `before`, a removed path has
 * no `after`, and a path that is unreadable has a null hash. Moving between a hash and no hash counts as a change.
 *
 * A gap withholds a decision only on the side that decision depends on:
 * - A truncated index holds only the first documents by path. When either side is truncated, `removed` is null (not
 *   reported), and `added` is withheld when the previous side is truncated, because the previous index could simply not
 *   have reached that path.
 * - A removal says a document `next` no longer lists is gone. It is withheld while its directory is unlisted in `next`
 *   (`next.unlisted`), because an unlisted directory says nothing about what is there.
 * - An addition says a document `next` lists was not in `previous`. `next` lists it, so the addition does not depend on
 *   `previous`'s listing: an unlisted `previous` directory does not withhold it.
 *
 * `complete` is the single claim the event guard reads. It is false when either side is truncated OR has an unlisted
 * directory: the diff then says less than the full change, and an incomplete diff is never published. `changed` compares
 * paths both sides hold, so it is always reported.
 */

/** The fields the diff reads from a record. Every `PlanningRecord` satisfies it. */
export interface IndexedDocument {
	path: string;
	sha256: string | null;
}

/** One side of a diff: the records a planning index holds, its truncation, and its unlisted directories. */
export interface PlanningSnapshot {
	records: readonly IndexedDocument[];
	truncated: boolean;
	unlisted: readonly string[];
}

/** One changed path, with its hash on each side. `null` on a side means that side has no hash for the path. */
export interface PathChange {
	path: string;
	before: string | null;
	after: string | null;
}

export interface PlanningDiff {
	/** False when either side is truncated or has an unlisted directory. An incomplete diff is never published. */
	complete: boolean;
	added: PathChange[];
	/** Null when either side is truncated. Otherwise the removals `next` can vouch for. */
	removed: PathChange[] | null;
	changed: PathChange[];
}

export function diffPlanningIndex(previous: PlanningSnapshot, next: PlanningSnapshot): PlanningDiff {
	const beforeSha = new Map(previous.records.map((document) => [document.path, document.sha256] as const));
	const afterSha = new Map(next.records.map((document) => [document.path, document.sha256] as const));
	const untruncated = !previous.truncated && !next.truncated;
	const fullyListed = previous.unlisted.length === 0 && next.unlisted.length === 0;
	const added = previous.truncated ? [] : [...afterSha.keys()].filter((path) => !beforeSha.has(path));
	const removed = untruncated ? [...beforeSha.keys()].filter((path) => !afterSha.has(path) && !under(path, next.unlisted)) : null;
	const changed = [...afterSha.keys()].filter((path) => beforeSha.has(path) && beforeSha.get(path) !== afterSha.get(path));
	return {
		complete: untruncated && fullyListed,
		added: added.map((path) => change(path, null, afterSha.get(path) ?? null)).sort(byPath),
		removed: removed === null ? null : removed.map((path) => change(path, beforeSha.get(path) ?? null, null)).sort(byPath),
		changed: changed.map((path) => change(path, beforeSha.get(path) ?? null, afterSha.get(path) ?? null)).sort(byPath),
	};
}

function change(path: string, before: string | null, after: string | null): PathChange {
	return { path, before, after };
}

/** True when `path` lies under one of the directories `scopes` names. */
function under(path: string, scopes: readonly string[]): boolean {
	return scopes.some((scope) => path.startsWith(`${scope}/`));
}

function byPath(a: PathChange, b: PathChange): number {
	return compareText(a.path, b.path);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
