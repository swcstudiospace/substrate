/**
 * The change between two planning indexes (phase 52). Compares path and sha256 only, so the
 * diff carries no file text and no frontmatter. A file that is unreadable has a null hash, and
 * moving between a hash and no hash counts as a change.
 */

/** The two fields the diff reads. Every `PlanningRecord` satisfies it. */
export interface IndexedDocument {
	path: string;
	sha256: string | null;
}

export interface PlanningDiff {
	added: string[];
	removed: string[];
	changed: string[];
}

export function diffPlanningIndex(previous: readonly IndexedDocument[], next: readonly IndexedDocument[]): PlanningDiff {
	const before = new Map(previous.map((document) => [document.path, document.sha256] as const));
	const after = new Map(next.map((document) => [document.path, document.sha256] as const));
	const added = [...after.keys()].filter((path) => !before.has(path));
	const removed = [...before.keys()].filter((path) => !after.has(path));
	const changed = [...after.keys()].filter((path) => before.has(path) && before.get(path) !== after.get(path));
	return { added: added.sort(compareText), removed: removed.sort(compareText), changed: changed.sort(compareText) };
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
