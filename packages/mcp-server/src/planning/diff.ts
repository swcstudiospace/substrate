/**
 * The change between two planning indexes (phase 52). Compares path and sha256 only, so the
 * diff carries no file text and no frontmatter. A file that is unreadable has a null hash, and
 * moving between a hash and no hash counts as a change.
 *
 * Two kinds of gap make a path unknown rather than changed:
 * - A truncated index holds only the first documents by path, so a path missing from it proves
 *   nothing. When either side is truncated the diff is partial: `removed` is null (not reported),
 *   and `added` is withheld too when the previous side is truncated, because the previous index
 *   could simply not have reached that path.
 * - A directory the walk could not list (`unlisted`) leaves its documents unknown. A document under
 *   an unlisted directory is therefore never reported as removed in `next`, nor as added when
 *   `previous` could not list it. `changed` compares paths both sides hold, so it is always reported.
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
	/** False when either side was truncated. Then `removed` is null and `added` may be withheld. */
	complete: boolean;
	added: string[];
	removed: string[] | null;
	changed: string[];
}

export function diffPlanningIndex(previous: PlanningSnapshot, next: PlanningSnapshot): PlanningDiff {
	const before = new Map(previous.records.map((document) => [document.path, document.sha256] as const));
	const after = new Map(next.records.map((document) => [document.path, document.sha256] as const));
	const complete = !previous.truncated && !next.truncated;
	const added = previous.truncated ? [] : [...after.keys()].filter((path) => !before.has(path) && !under(path, previous.unlisted));
	const removed = complete ? [...before.keys()].filter((path) => !after.has(path) && !under(path, next.unlisted)) : null;
	const changed = [...after.keys()].filter((path) => before.has(path) && before.get(path) !== after.get(path));
	return {
		complete,
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
