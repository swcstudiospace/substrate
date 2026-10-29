/**
 * The corpus plan: what a bulk ingest would add, change, rename or tombstone, decided from the entries a scan reported, the
 * scope it declares and the manifest rows. Pure: no I/O, no clock, no body. Entries and scope arrive already validated
 * (`parsePlanRequest`).
 *
 * The scope is what keeps a narrow scan harmless: a row is a tombstone candidate only when its repo is in `scope.repos`
 * (the scan read it completely), its tier is at most `scope.maxTier` and its source is in `scope.sources`. A row outside
 * the scope is never touched, whatever the scan reported.
 */
import type { CorpusEntry, CorpusScope, PlanAction, PlanItem } from "@substrate/corpus";
import type { ManifestRow } from "./store.ts";

export interface CorpusPlan {
	items: PlanItem[];
	counts: Record<PlanAction, number>;
}

function keyOf(repo: string, path: string): string {
	return `${repo}\n${path}`;
}

function byPath(left: { path: string }, right: { path: string }): number {
	return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function planCorpus(entries: readonly CorpusEntry[], scope: CorpusScope, rows: readonly ManifestRow[]): CorpusPlan {
	const counts: Record<PlanAction, number> = { add: 0, change: 0, rename: 0, tombstone: 0, unchanged: 0 };
	const rowByKey = new Map<string, ManifestRow>(rows.map((row) => [keyOf(row.repo, row.path), row]));
	const reported = new Set<string>();
	const items: PlanItem[] = [];
	const adds: CorpusEntry[] = [];

	for (const entry of entries) {
		const key = keyOf(entry.repo, entry.path);
		reported.add(key);
		const row = rowByKey.get(key);
		// A tombstoned row whose key reappears is new content for the plane, so it is an add, not a change.
		if (row === undefined || row.state !== "active") {
			adds.push(entry);
		} else if (row.sha256 === entry.sha256) {
			counts.unchanged += 1;
		} else {
			counts.change += 1;
			items.push({ action: "change", repo: entry.repo, path: entry.path, sha256: entry.sha256 });
		}
	}

	const repos = new Set(scope.repos);
	const candidates = rows
		.filter((row) => row.state === "active" && repos.has(row.repo) && row.tier <= scope.maxTier && scope.sources.includes(row.source) && !reported.has(keyOf(row.repo, row.path)))
		.sort(byPath);

	// A removed row and a new entry with the same repo and sha256 are one document that moved: a rename, once.
	const addsBySha = new Map<string, CorpusEntry[]>();
	for (const entry of [...adds].sort(byPath)) {
		const group = addsBySha.get(keyOf(entry.repo, entry.sha256));
		if (group === undefined) addsBySha.set(keyOf(entry.repo, entry.sha256), [entry]);
		else group.push(entry);
	}
	const renamed = new Set<string>();
	for (const row of candidates) {
		const match = addsBySha.get(keyOf(row.repo, row.sha256))?.shift();
		if (match === undefined) {
			counts.tombstone += 1;
			items.push({ action: "tombstone", repo: row.repo, path: row.path, sha256: row.sha256 });
			continue;
		}
		renamed.add(keyOf(match.repo, match.path));
		counts.rename += 1;
		items.push({ action: "rename", repo: match.repo, path: match.path, sha256: match.sha256, renamedFrom: row.path });
	}
	for (const entry of adds) {
		if (renamed.has(keyOf(entry.repo, entry.path))) continue;
		counts.add += 1;
		items.push({ action: "add", repo: entry.repo, path: entry.path, sha256: entry.sha256 });
	}

	items.sort((left, right) => (left.repo < right.repo ? -1 : left.repo > right.repo ? 1 : byPath(left, right)));
	return { items, counts };
}
