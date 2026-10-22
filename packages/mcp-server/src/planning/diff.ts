/**
 * The change between two planning indexes (phase 52). Compares path and sha256 only, so the
 * diff carries no file text and no frontmatter. A file that is unreadable has a null hash, and
 * moving between a hash and no hash counts as a change.
 *
 * A gap withholds a decision only on the side that decision depends on:
 * - A truncated index holds only the first documents by path. When either side is truncated,
 *   `removed` is null (not reported), and `added` is withheld when the previous side is truncated,
 *   because the previous index could simply not have reached that path.
 * - A removal says a document `next` no longer lists is gone. It is withheld while its directory is
 *   unlisted in `next` (`next.unlisted`), because an unlisted directory says nothing about what is there.
 * - An addition says a document `next` lists was not in `previous`. `next` lists it, so the addition does
 *   not depend on `previous`'s listing: an unlisted `previous` directory does not withhold it.
 *
 * `complete` is the single claim the event guard reads. It is false when either side is truncated OR has
 * an unlisted directory: the diff then says less than the full change, and an incomplete diff is never published.
 * `changed` compares paths both sides hold, so it is always reported.
 */

/** The fields the diff reads from a record. Every `PlanningRecord` satisfies it. */
export interface IndexedDocument {
	path: string;
	sha256: string | null;
}

/** One side of a diff: the records a `buildPlanningIndex` returned, its truncation, and its unlisted directories. */
export interface PlanningSnapshot {
	records: readonly IndexedDocument[];
	truncated: boolean;
	unlisted: readonly string[];
}

export interface PlanningDiff {
	/** False when either side is truncated or has an unlisted directory. An incomplete diff is never published. */
	complete: boolean;
	added: string[];
	/** Null when either side is truncated. Otherwise the removals `next` can vouch for. */
	removed: string[] | null;
	changed: string[];
}

export function diffPlanningIndex(previous: PlanningSnapshot, next: PlanningSnapshot): PlanningDiff {
	const before = new Map(previous.records.map((document) => [document.path, document.sha256] as const));
	const after = new Map(next.records.map((document) => [document.path, document.sha256] as const));
	const untruncated = !previous.truncated && !next.truncated;
	const fullyListed = previous.unlisted.length === 0 && next.unlisted.length === 0;
	const added = previous.truncated ? [] : [...after.keys()].filter((path) => !before.has(path));
	const removed = untruncated ? [...before.keys()].filter((path) => !after.has(path) && !under(path, next.unlisted)) : null;
	const changed = [...after.keys()].filter((path) => before.has(path) && before.get(path) !== after.get(path));
	return {
		complete: untruncated && fullyListed,
		added: added.sort(compareText),
		removed: removed === null ? null : removed.sort(compareText),
		changed: changed.sort(compareText),
	};
}

/** True when `path` lies under one of the directories `scopes` names. */
function under(path: string, scopes: readonly string[]): boolean {
	return scopes.some((scope) => path.startsWith(`${scope}/`));
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
