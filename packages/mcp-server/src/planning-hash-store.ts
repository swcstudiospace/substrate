/**
 * Where the planning refresh keeps the hash of each `.planning/` page it last put into the docs plane (v1.7 phase 65).
 *
 * The refresh used to keep them in a map in memory, so every restart re-ingested every planning page. With
 * `SUBSTRATE_PLANNING_HASH_STORE=on` the map is loaded once from a store behind this port and the pages a batch put into the
 * plane are written back, so a restart ingests only what changed. The port is small on purpose: the Postgres adapter is a
 * table keyed by path (`planning_page_hashes`, migration step 38), the in-memory adapter serves a deployment with no index
 * and the tests.
 *
 * A store never deletes: a page removed from the repository leaves its row, which costs nothing (the refresh only looks
 * up pages it scanned) and is bounded by {@link PLANNING_HASH_MAX_ROWS} on the way back in.
 */
import type { SQL } from "bun";

/** Most rows one `load` reads; a table that grew past it (pages removed over years) loads its first rows by path, and the rest are re-ingested once. */
export const PLANNING_HASH_MAX_ROWS = 50_000;

export interface PlanningHashStore {
	/** Every stored `path -> sha256`, at most {@link PLANNING_HASH_MAX_ROWS}. Rejects when the store cannot be read. */
	load(): Promise<Map<string, string>>;
	/** Upserts these entries (and nothing else). Rejects when the store cannot be written. */
	save(entries: ReadonlyMap<string, string>): Promise<void>;
}

/** The adapter for tests and for a deployment with no index: the map lives and dies with the process. */
export function memoryPlanningHashStore(initial: ReadonlyMap<string, string> = new Map()): PlanningHashStore {
	const held = new Map(initial);
	return {
		async load() {
			return new Map(held);
		},
		async save(entries) {
			for (const [path, sha] of entries) held.set(path, sha);
		},
	};
}

/** The Bun SQL adapter over `planning_page_hashes` (migration step 38). */
export function bunPlanningHashStore(sql: SQL): PlanningHashStore {
	return {
		async load() {
			const rows: Array<Record<string, unknown>> = await sql`select path, sha256 from planning_page_hashes order by path limit ${PLANNING_HASH_MAX_ROWS}`;
			const loaded = new Map<string, string>();
			for (const row of rows) if (typeof row.path === "string" && typeof row.sha256 === "string") loaded.set(row.path, row.sha256);
			return loaded;
		},
		async save(entries) {
			for (const [path, sha] of entries) {
				await sql`
					insert into planning_page_hashes (path, sha256, updated_at) values (${path}, ${sha}, now())
					on conflict (path) do update set sha256 = excluded.sha256, updated_at = now()`;
			}
		},
	};
}
