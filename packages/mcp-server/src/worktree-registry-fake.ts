/**
 * The worktree registry in memory: the same contract as `PgWorktreeRegistry`, for the tests of the layers above it
 * (the routes, the tool, the service) and for `worktree-registry.testkit.ts`, which runs one set of cases against both
 * adapters so the fake cannot drift from the SQL.
 */
import type { StoredWorktree, WorktreeRecord, WorktreeRegistryStore, WorktreeStoreFilter, WorktreeStoreReport } from "./worktree-registry.ts";

interface Row {
	record: WorktreeRecord;
	host: string;
	firstSeenAt: number;
	lastSeenAt: number;
}

export class MemoryWorktreeRegistry implements WorktreeRegistryStore {
	private readonly rows = new Map<string, Row>();
	/** Reports written, so a test can assert that a refused request wrote nothing. */
	reports = 0;

	async report(input: WorktreeStoreReport): Promise<{ stored: number; removed: number }> {
		this.reports += 1;
		const seenAt = input.seenAt.getTime();
		for (const record of input.worktrees) {
			const key = `${input.host}\u0000${record.path}`;
			this.rows.set(key, { record, host: input.host, firstSeenAt: this.rows.get(key)?.firstSeenAt ?? seenAt, lastSeenAt: seenAt });
		}
		const cutoff = seenAt - input.ttlS * 1000;
		let removed = 0;
		for (const [key, row] of this.rows) {
			if (row.host === input.host && row.lastSeenAt < cutoff) {
				this.rows.delete(key);
				removed += 1;
			}
		}
		return { stored: input.worktrees.length, removed };
	}

	async list(filter: WorktreeStoreFilter): Promise<StoredWorktree[]> {
		const staleBefore = filter.staleBefore.getTime();
		const matching = [...this.rows.values()].filter((row) => {
			if (filter.repo !== null && row.record.repo !== filter.repo) return false;
			if (filter.host !== null && row.host !== filter.host) return false;
			if (filter.state === "dirty") return row.record.dirty;
			if (filter.state === "stale") return row.record.last_commit_at !== null && Date.parse(row.record.last_commit_at) < staleBefore;
			return true;
		});
		// The SQL orders with the "C" collation, which is code-unit order, as `<` is on strings.
		matching.sort((a, b) => b.lastSeenAt - a.lastSeenAt || byCodeUnit(a.host, b.host) || byCodeUnit(a.record.path, b.record.path));
		return matching.slice(0, filter.limit).map((row) => ({
			...row.record,
			host: row.host,
			first_seen_at: new Date(row.firstSeenAt).toISOString(),
			last_seen_at: new Date(row.lastSeenAt).toISOString(),
		}));
	}
}

function byCodeUnit(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}
