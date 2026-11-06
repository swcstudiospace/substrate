/**
 * The corpus plan: what a bulk ingest would add, change, update, rename or tombstone, decided from the entries a scan
 * reported, the scope it declares and the manifest rows. Pure: no I/O, no clock, no body. Entries and scope arrive already
 * validated (`parsePlanRequest`).
 *
 * A row's identity is `(repo, path)`; its `source` column records which source produced it. An entry that matches an active
 * row is `unchanged` only when the sha256 AND the source, kind, tier and `superseded-by` marker agree; the same sha256 under
 * another source, kind, tier or marker is an `update` (a manifest-only refresh, no plane upload), so a document first read from GitHub and later from a
 * local clone does not keep a stale source that would hide it from a filesystem-only removal. A different sha256 is a
 * `change`.
 *
 * The scope is what keeps a narrow scan harmless: a row is a tombstone candidate only when its `(repo, source)` pair is in
 * `scope.coverage` (that source read that repository completely) and its tier is at most `scope.maxTier`. A row outside the
 * coverage is never touched, whatever the scan reported; an empty coverage tombstones nothing.
 */
import type { CorpusEntry, CorpusScope, PlanAction, PlanItem } from "@substrate/corpus";
import type { ManifestRow } from "./store.ts";

interface CorpusPlan {
	items: PlanItem[];
	counts: Record<PlanAction, number>;
}

function keyOf(repo: string, path: string): string {
	return `${repo}\n${path}`;
}

function byPath(left: { path: string }, right: { path: string }): number {
	return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/** The repositories whose manifest rows a plan needs: those entries name, and those the coverage lists. */
export function planRepos(entries: readonly CorpusEntry[], scope: CorpusScope): string[] {
	return [...new Set([...scope.coverage.map((pair) => pair.repo), ...entries.map((entry) => entry.repo)])];
}

export function planCorpus(entries: readonly CorpusEntry[], scope: CorpusScope, rows: readonly ManifestRow[]): CorpusPlan {
	const counts: Record<PlanAction, number> = { add: 0, change: 0, update: 0, rename: 0, tombstone: 0, unchanged: 0 };
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
		} else if (row.sha256 !== entry.sha256) {
			counts.change += 1;
			items.push({ action: "change", repo: entry.repo, path: entry.path, sha256: entry.sha256 });
		} else if (row.source !== entry.source || row.kind !== entry.kind || row.tier !== entry.tier || row.supersededBy !== (entry.supersededBy ?? null)) {
			counts.update += 1;
			items.push({ action: "update", repo: entry.repo, path: entry.path, sha256: entry.sha256 });
		} else {
			counts.unchanged += 1;
		}
	}

	const covered = new Set(scope.coverage.map((pair) => `${pair.repo}\n${pair.source}`));
	// A digest is written by the server (`POST /corpus/reflect`), never found by a scan, so a scan that does not report it says nothing about it.
	const candidates = rows
		.filter((row) => row.state === "active" && row.kind !== "digest" && covered.has(`${row.repo}\n${row.source}`) && row.tier <= scope.maxTier && !reported.has(keyOf(row.repo, row.path)))
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
