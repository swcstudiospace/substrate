/**
 * The worktree registry in memory: the same contract as `PgWorktreeRegistry`, for the tests of the layers above it
 * (the routes, the tool, the service) and for `worktree-registry.testkit.ts`, which runs one set of cases against both
 * adapters so the fake cannot drift from the SQL.
 */
import type { StoredWorktree, WorktreeCandidate, WorktreeCandidateQuery, WorktreeRecord, WorktreeRegistryStore, WorktreeStoreFilter, WorktreeStoreReport } from "./worktree-registry.ts";

interface Row {
	record: WorktreeRecord;
	host: string;
	/** What the latest report said about the touched paths. A report that omitted them leaves null, as the SQL does. */
	files: string[] | null;
	filesTruncated: boolean;
	firstSeenAt: number;
	lastSeenAt: number;
}

export class MemoryWorktreeRegistry implements WorktreeRegistryStore {
	private readonly rows = new Map<string, Row>();
	/** Reports written, so a test can assert that a refused request wrote nothing. */
	reports = 0;
	/** Candidate reads served, so a test can assert that a request which asks for none reads nothing. */
	candidateReads = 0;

	async report(input: WorktreeStoreReport): Promise<{ stored: number; removed: number }> {
		this.reports += 1;
		const seenAt = input.seenAt.getTime();
		for (const reported of input.worktrees) {
			const { files, files_truncated: truncated, ...record } = reported;
			const key = `${input.host}\u0000${record.path}`;
			const kept = files ?? null;
			this.rows.set(key, {
				record,
				host: input.host,
				files: kept,
				filesTruncated: kept !== null && (truncated ?? false),
				firstSeenAt: this.rows.get(key)?.firstSeenAt ?? seenAt,
				lastSeenAt: seenAt,
			});
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
			if (filter.repos !== null && !filter.repos.includes(row.record.repo.toLowerCase())) return false;
			if (filter.host !== null && row.host !== filter.host) return false;
			if (filter.state === "dirty") return row.record.dirty;
			if (filter.state === "stale") return row.record.last_commit_at !== null && Date.parse(row.record.last_commit_at) < staleBefore;
			return true;
		});
		return newestFirst(matching).slice(0, filter.limit).map(toStored);
	}

	async candidates(query: WorktreeCandidateQuery): Promise<WorktreeCandidate[]> {
		this.candidateReads += 1;
		const wanted = query.repo.toLowerCase();
		const matching = [...this.rows.values()].filter((row) => row.record.repo.toLowerCase() === wanted);
		return newestFirst(matching)
			.slice(0, query.limit)
			.map((row) => ({ ...toStored(row), files: row.files === null ? null : [...row.files], files_truncated: row.filesTruncated }));
	}
}

function toStored(row: Row): StoredWorktree {
	return {
		...row.record,
		host: row.host,
		first_seen_at: new Date(row.firstSeenAt).toISOString(),
		last_seen_at: new Date(row.lastSeenAt).toISOString(),
	};
}

/** The SQL orders with the "C" collation, which is code-unit order, as `<` is on strings. */
function newestFirst(rows: Row[]): Row[] {
	return rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt || byCodeUnit(a.host, b.host) || byCodeUnit(a.record.path, b.record.path));
}

function byCodeUnit(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}
