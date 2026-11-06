/**
 * How old the newest index archive is (uplift-4 S2): the read behind
 * `/healthz.jobs.index.lastArchiveAt`, the `substrate.index.archive.age_seconds`
 * gauge and the `index.archive.age` objective.
 *
 * The truth is the archive directory itself: a snapshot counts only when its
 * `manifest.json` exists, because the archive writes the manifest last, so
 * "newest snapshot with a manifest" is exactly "newest complete archive". The
 * ledger `note` an archive run emits is the same fact for the ledger's readers;
 * this reads the files so it needs no ledger query and keeps working while the
 * ledger is down.
 *
 * `/healthz` must never wait on a mount: the read uses asynchronous file calls,
 * is memoised for {@link INDEX_ARCHIVE_MEMO_MS}, and callers share one read in
 * flight. A hung mount leaves one stuck read, not one per poll, and the caller
 * bounds its own wait.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ARCHIVE_TABLE_NAMES } from "./index-archive-spec.ts";

/** How long one directory read serves every caller. */
const INDEX_ARCHIVE_MEMO_MS = 60_000;

/** Snapshot directories whose manifest is tried, newest first, before the read gives up: a damaged manifest must not hide an older good one, and a flood of directories must not make the read unbounded. */
const MAX_MANIFESTS_TRIED = 5;

/** The largest manifest read: a manifest lists ten tables, so anything bigger is damage. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const SNAPSHOT_RE = /^index-\d{8}T\d{6}Z$/;

interface IndexArchiveStatus {
	/** The newest complete snapshot's `createdAt`, or `null` when the directory holds none. */
	lastArchiveAt: string | null;
	snapshot: string | null;
	/** Seconds from `lastArchiveAt` to the read; `null` with no snapshot. */
	ageSeconds: number | null;
}

/** What one read answers: the status, or `null` and why the directory could not be read. */
export interface IndexArchiveReading {
	status: IndexArchiveStatus | null;
	reason: string | null;
}

/** What the watch reads of a manifest: its kind and time, and each table's data file name and size (the full check is `verify-archive`'s). */
const WatchedManifest = z.object({
	kind: z.literal("index-archive"),
	createdAt: z.string(),
	tables: z.record(z.string(), z.object({ file: z.string(), bytes: z.number() })),
});

/**
 * Whether every archived table's data file the manifest lists is on disk with the listed size: ten `stat`s, no
 * reads. A manifest over missing or truncated files is not a backup, however it got that way. The file names are
 * taken from the closed table list, never from the manifest, so a manifest cannot point a stat elsewhere.
 */
async function dataFilesPresent(snapshotDir: string, tables: z.infer<typeof WatchedManifest>["tables"]): Promise<boolean> {
	for (const name of ARCHIVE_TABLE_NAMES) {
		const entry = Object.hasOwn(tables, name) ? tables[name] : undefined;
		if (entry === undefined || entry.file !== `${name}.ndjson`) return false;
		if ((await stat(join(snapshotDir, entry.file))).size !== entry.bytes) return false;
	}
	return true;
}

/** The newest complete snapshot's `createdAt` in `dir`, by directory name; `null` when none has a readable manifest over its data files. */
async function newestArchive(dir: string): Promise<{ snapshot: string; createdAt: number } | null> {
	const names = (await readdir(dir)).filter((name) => SNAPSHOT_RE.test(name)).sort().reverse();
	for (const snapshot of names.slice(0, MAX_MANIFESTS_TRIED)) {
		const path = join(dir, snapshot, "manifest.json");
		try {
			if ((await stat(path)).size > MAX_MANIFEST_BYTES) continue;
			const parsed = WatchedManifest.safeParse(JSON.parse(await readFile(path, "utf8")));
			const createdAt = parsed.success ? Date.parse(parsed.data.createdAt) : Number.NaN;
			if (parsed.success && Number.isFinite(createdAt) && (await dataFilesPresent(join(dir, snapshot), parsed.data.tables))) return { snapshot, createdAt };
		} catch {
			// No manifest (an incomplete snapshot) or one that does not parse: not an archive; try the next older one.
		}
	}
	return null;
}

export class IndexArchiveWatch {
	private memo: { at: number; reading: IndexArchiveReading } | null = null;
	private inFlight: Promise<void> | null = null;
	/** The newest archive time any read has seen (ms); survives a later unreadable read. */
	private newestAt: number | null = null;

	constructor(
		readonly dir: string,
		private readonly ttlMs: number = INDEX_ARCHIVE_MEMO_MS,
	) {}

	/**
	 * The archive's status as of `now`, from the memo while it is fresh. A stale
	 * memo starts one read shared by every caller that arrives while it runs; a
	 * failed read is memoised too — as `null` with a short reason — so an
	 * unreadable directory costs one attempt a minute. Never throws.
	 */
	async read(now: number = Date.now()): Promise<IndexArchiveReading> {
		const fresh = this.memo !== null && now - this.memo.at < this.ttlMs;
		if (!fresh) {
			this.inFlight ??= this.refresh(now).finally(() => {
				this.inFlight = null;
			});
			await this.inFlight;
		}
		// The memo's reading was taken at `memo.at`; the age is as of this call.
		const reading = this.memo?.reading ?? { status: null, reason: "archive directory has not been read yet" };
		if (reading.status === null || reading.status.lastArchiveAt === null) return reading;
		return { ...reading, status: { ...reading.status, ageSeconds: Math.max(0, Math.round((now - Date.parse(reading.status.lastArchiveAt)) / 1000)) } };
	}

	/**
	 * The newest complete archive's creation time in ms, from what the last read
	 * saw — synchronously, for a metric snapshot. A stale memo starts one
	 * background refresh (shared with `read`) so the next snapshot is current.
	 * An unreadable directory keeps the last archive time it ever saw, so the
	 * age keeps growing instead of the series disappearing; `null` until a read
	 * has found an archive.
	 */
	peekCreatedAt(now: number = Date.now()): number | null {
		if (this.inFlight === null && (this.memo === null || now - this.memo.at >= this.ttlMs)) {
			this.inFlight = this.refresh(now).finally(() => {
				this.inFlight = null;
			});
		}
		return this.newestAt;
	}

	private async refresh(now: number): Promise<void> {
		try {
			const newest = await newestArchive(this.dir);
			if (newest !== null) this.newestAt = newest.createdAt;
			this.memo = {
				at: now,
				reading: {
					status: newest === null ? { lastArchiveAt: null, snapshot: null, ageSeconds: null } : { lastArchiveAt: new Date(newest.createdAt).toISOString(), snapshot: newest.snapshot, ageSeconds: Math.max(0, Math.round((now - newest.createdAt) / 1000)) },
					reason: null,
				},
			};
		} catch (cause) {
			// The error code only: a message may quote the path, and `/healthz` is unauthenticated.
			const code = (cause as NodeJS.ErrnoException).code;
			this.memo = { at: now, reading: { status: null, reason: `archive directory could not be read${typeof code === "string" ? ` (${code})` : ""}` } };
		}
	}
}

type IndexArchiveSloStatus = "ok" | "breached" | "insufficient-data" | "report-only";

/** The `index.archive.age` row on `/slo`: report-only until `SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H` is set. */
export interface IndexArchiveSloResult {
	id: "index.archive.age";
	title: string;
	statement: string;
	status: IndexArchiveSloStatus;
	/** Hours since the newest complete archive, or `null` when none was read. */
	observed: number | null;
	unit: "hours";
	/** The configured ceiling in hours, or `null` while the row is report-only. */
	target: number | null;
	detail: string;
}

/**
 * Judge a reading against the ceiling. With no ceiling the row only reports
 * (`report-only`) whatever the age is; with one, an age at or under it is `ok`,
 * an older archive — or none at all in a readable directory — is `breached`,
 * and an unreadable directory is `insufficient-data` (the age is unknown, not
 * old). Pure: the clock is the reading's own.
 */
export function evaluateIndexArchiveSlo(reading: IndexArchiveReading, maxAgeHours: number | null): IndexArchiveSloResult {
	const base = {
		id: "index.archive.age" as const,
		title: "Index archive age",
		statement: maxAgeHours === null ? "newest complete index archive age (report-only: SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H unset)" : `newest complete index archive is at most ${maxAgeHours} h old`,
		unit: "hours" as const,
		target: maxAgeHours,
	};
	if (reading.status === null) {
		return { ...base, status: maxAgeHours === null ? "report-only" : "insufficient-data", observed: null, detail: reading.reason ?? "the archive directory could not be read" };
	}
	if (reading.status.ageSeconds === null) {
		return { ...base, status: maxAgeHours === null ? "report-only" : "breached", observed: null, detail: "no complete index archive in the archive directory" };
	}
	const hours = Math.round((reading.status.ageSeconds / 3600) * 10) / 10;
	const detail = `newest archive ${reading.status.snapshot ?? ""} written ${reading.status.lastArchiveAt ?? ""}`;
	if (maxAgeHours === null) return { ...base, status: "report-only", observed: hours, detail };
	return { ...base, status: reading.status.ageSeconds <= maxAgeHours * 3600 ? "ok" : "breached", observed: hours, detail };
}
