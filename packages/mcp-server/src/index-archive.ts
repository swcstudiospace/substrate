/**
 * The verified logical export of the Postgres index (uplift-4 S2): every table
 * `IndexStore.migrate()` creates as NDJSON, a manifest written last, the offline
 * check that recomputes every size, digest and count from the files alone, and
 * the restore-to-scratch that proves an archive can rebuild an index.
 *
 * Why it exists: the only backup the index had was a manual volume snapshot
 * before a sweep, and nothing ever proved one could be restored. This turns
 * "we have a backup" into a verdict: `index verify-archive` needs no database,
 * and `index restore --scratch` loads the archive into a scratch database and
 * compares counts and the `entry_hash` digest back against the manifest.
 *
 * Layout: `<archive dir>/index-<UTC stamp>/<table>.ndjson` (one file per
 * whitelisted table, see `index-archive-spec.ts`) and `manifest.json`, which is
 * renamed into place after every data file, so its presence means the snapshot
 * is complete. A crash leaves `*.part` files, which the failed run removes.
 *
 * Nothing here composes SQL: reads and loads go through `IndexStore`'s typed
 * seams. Nothing here deletes archives, and nothing here touches production
 * writes: the export is one REPEATABLE READ READ ONLY transaction, and restore
 * refuses a URL that names the configured production database.
 *
 * Secrets: `memory_quarantine` and `memory_reviews` carry the metadata and the
 * `entry_hash` of parked writes but never their text (the spec's `withheld`
 * columns); the export refuses a row that carries a column outside the spec, so
 * a stub or a future column cannot leak one by accident.
 */
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { IndexRestoreTx, IndexSnapshotReader } from "./index-store.ts";
import {
	ARCHIVE_TABLES,
	coerceRow,
	exportedColumns,
	rowKey,
	schemaHash,
	type CoercedRow,
	type ArchiveRow,
	type ArchiveTableSpec,
} from "./index-archive-spec.ts";
import {
	ArchiveRefused,
	DEFAULT_MIN_FREE_GB,
	dfRunner,
	existingAncestor,
	freeKbOf,
	realish,
	refusedMount,
	refusedOutDir,
	type DevReader,
	type DfRunner,
	type NoteOutcome,
} from "./ledger-archive.ts";
import { redact } from "./redact.ts";
import type { EventInput } from "./types.ts";

export { ArchiveRefused };

/** The manifest's format version; a reader refuses any other. */
export const INDEX_ARCHIVE_VERSION = 1;

/** The manifest's file name inside a snapshot directory. */
export const MANIFEST_FILE = "manifest.json";

/** Snapshot files (data, `.part`, manifest, note markers) hold complete accepted memory text or its digests: owner-only whatever the process umask. */
export const PRIVATE_FILE_MODE = 0o600;
/** Snapshot directories, and the archive directory when this run has to create it: owner-only. */
export const PRIVATE_DIR_MODE = 0o700;

/** Rows per export page when the operator passes none. */
export const DEFAULT_ARCHIVE_PAGE_ROWS = 500;

/** The most rows an operator may ask for per page: the store's own page ceiling. */
export const MAX_ARCHIVE_PAGE_ROWS_CLI = 5000;

/** How long one export may run before it is abandoned and rolled back (`SUBSTRATE_INDEX_ARCHIVE_MAX_SECONDS`). */
export const DEFAULT_ARCHIVE_MAX_SECONDS = 900;

/** How many bytes one export may write (`SUBSTRATE_INDEX_ARCHIVE_MAX_BYTES`): 1 GiB, against a 500 MB production volume. */
export const DEFAULT_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;

/** The longest NDJSON line a reader will hold: a body is capped far below this, so a longer line is damage, not data. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** The env name that waives the dedicated-mount gate for a deliberate local test; the unit never sets it. */
export const INDEX_ROOTFS_ENV = "SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS";
const LEDGER_ROOTFS_ENV = "SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS";

const SNAPSHOT_RE = /^index-\d{8}T\d{6}Z$/;
const MASK64 = (1n << 64n) - 1n;

/** The export failed after it started (a deadline, the byte bound, a row outside the spec): exit 1 at the runner, nothing is left behind. */
export class IndexArchiveFailed extends Error {}

// ─── Order-independent digests ──────────────────────────────────────────────

/**
 * A digest of a SET of strings: the count, the sum and the xor of each
 * string's SHA-256 prefix, mod 2^64. Order-independent on purpose — restore
 * recomputes it from a scratch database whose collation may sort keys
 * differently from the source's, and the digest must still agree.
 */
export class SetDigest {
	private sum = 0n;
	private xor = 0n;
	private count = 0;

	add(value: string): void {
		const prefix = BigInt(`0x${new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16)}`);
		this.sum = (this.sum + prefix) & MASK64;
		this.xor ^= prefix;
		this.count++;
	}

	value(): string {
		return `${this.count}:${this.sum.toString(16).padStart(16, "0")}:${this.xor.toString(16).padStart(16, "0")}`;
	}
}

/** The digests one table's rows feed: every line, and the `entry_hash` of every row that has one. */
export class TableDigests {
	readonly rows = new SetDigest();
	readonly entryHashes: SetDigest | null;

	constructor(spec: ArchiveTableSpec) {
		this.entryHashes = spec.hasEntryHash ? new SetDigest() : null;
	}

	add(line: string, row: ArchiveRow): void {
		this.rows.add(line);
		const hash = row.entry_hash;
		if (this.entryHashes !== null && typeof hash === "string") this.entryHashes.add(hash);
	}
}

// ─── The manifest ───────────────────────────────────────────────────────────

export interface TableManifest {
	file: string;
	rows: number;
	bytes: number;
	sha256: string;
	/** The exported columns, in file order. */
	columns: string[];
	/** The columns that were not exported. */
	withheld: string[];
	/** {@link SetDigest} over every line. */
	rowDigest: string;
	/** {@link SetDigest} over every non-null `entry_hash`; absent for tables without one. */
	entryHashDigest?: string;
}

export interface IndexArchiveManifest {
	version: number;
	kind: "index-archive";
	snapshot: string;
	createdAt: string;
	/** The release the archive was written from, when it ran from a `releases/<sha>` tree. */
	releaseSha?: string;
	/** Postgres `server_version` of the source. */
	serverVersion: string;
	/** `schemaHash()` of the code that wrote it. */
	schemaHash: string;
	tables: Record<string, TableManifest>;
}

const TableManifestSchema = z.object({
	file: z.string(),
	rows: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	sha256: z.string(),
	columns: z.array(z.string()),
	withheld: z.array(z.string()),
	rowDigest: z.string(),
	entryHashDigest: z.string().optional(),
});

const ManifestSchema = z.object({
	version: z.number(),
	kind: z.literal("index-archive"),
	snapshot: z.string(),
	createdAt: z.string(),
	releaseSha: z.string().optional(),
	serverVersion: z.string(),
	schemaHash: z.string(),
	tables: z.record(z.string(), TableManifestSchema),
});

/** The snapshot directory name for an instant: `index-20261014T031500Z`. */
export function snapshotName(ms: number): string {
	return `index-${new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

/** Snapshot directories in `dir` with a manifest, newest first; an unreadable dir is empty. */
export function completeSnapshots(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => SNAPSHOT_RE.test(name) && existsSync(join(dir, name, MANIFEST_FILE)))
		.sort()
		.reverse();
}

// ─── Export ─────────────────────────────────────────────────────────────────

/** What `archiveIndex` reads from: `IndexStore` satisfies it; tests pass a stub. */
export interface IndexArchiveSource {
	withExportSnapshot<T>(work: (reader: IndexSnapshotReader) => Promise<T>): Promise<T>;
}

export interface IndexArchiveOptions {
	outDir: string;
	pageSize?: number;
	now?: () => number;
	/** The `df` reading; injected by tests. */
	df?: DfRunner;
	/** The `st_dev` reader for the mount gate; injected by tests. */
	dev?: DevReader;
	/** The free-space floor in GB; `0` disables, as for the deploy gate. */
	minFreeGb?: number;
	/** `SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS=1`: skip the dedicated-mount gate for a deliberate local test. */
	allowRootfs?: boolean;
	cwd?: string;
	releaseSha?: string;
	/** Seconds the whole export may take. */
	maxSeconds?: number;
	/** Bytes the whole export may write. */
	maxBytes?: number;
	/** Told the names of unfinished snapshot directories a killed earlier run left and this run removed. */
	onSwept?: (names: readonly string[]) => void;
	/** `chmodSync`, injected by tests to fail a mode change on a chosen file. */
	chmod?: (path: string, mode: number) => void;
}

/** One data file under construction: its `.part` path, the digest of every byte appended, and the size. */
class NdjsonPart {
	readonly part: string;
	private readonly hasher = new Bun.CryptoHasher("sha256");
	bytes = 0;

	constructor(
		readonly dir: string,
		readonly name: string,
		private readonly chmod: (path: string, mode: number) => void = chmodSync,
	) {
		this.part = join(dir, `${name}.part`);
		rmSync(this.part, { force: true });
		writeFileSync(this.part, "", { mode: PRIVATE_FILE_MODE });
	}

	append(lines: readonly string[]): void {
		const text = `${lines.join("\n")}\n`;
		appendFileSync(this.part, text);
		this.hasher.update(text);
		this.bytes += Buffer.byteLength(text);
	}

	digest(): string {
		return this.hasher.digest("hex");
	}

	commit(): void {
		// The mode is set on the `.part` before the rename, so the rename is the only step left.
		this.chmod(this.part, PRIVATE_FILE_MODE);
		renameSync(this.part, join(this.dir, this.name));
	}

	/** Remove the `.part` and, when it was already renamed into place, the data file: an abandoned export leaves neither. */
	discard(): void {
		rmSync(this.part, { force: true });
		rmSync(join(this.dir, this.name), { force: true });
	}
}

/** `work`, or a failure once `ms` have passed: the deadline lives inside the awaited operation, and a timeout is a failure. */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new IndexArchiveFailed(`${what} exceeded the export time limit`)), Math.max(1, ms));
		timer.unref?.();
		work.then(
			(value) => {
				clearTimeout(timer);
				resolvePromise(value);
			},
			(cause: unknown) => {
				clearTimeout(timer);
				reject(cause);
			},
		);
	});
}

/** Why `outDir` may not be used, thrown as a refusal before anything is created. */
export function assertArchiveDir(outDir: string, options: IndexArchiveOptions, cwd: string): void {
	const refusal = refusedOutDir(outDir, { cwd });
	if (refusal !== null) throw new ArchiveRefused(refusal);
	// The mount gate is the ledger archive's, with its own override name in the message.
	const mount = refusedMount(outDir, {
		cwd,
		...(options.dev === undefined ? {} : { dev: options.dev }),
		...(options.allowRootfs === undefined ? {} : { allowRootfs: options.allowRootfs }),
	});
	if (mount !== null) throw new ArchiveRefused(mount.replace(LEDGER_ROOTFS_ENV, INDEX_ROOTFS_ENV));
	const minFreeGb = options.minFreeGb ?? DEFAULT_MIN_FREE_GB;
	if (minFreeGb > 0) {
		// Asked of the nearest existing ancestor, like the mount gate: nothing is created until every gate has passed.
		const freeKb = freeKbOf((options.df ?? dfRunner)(existingAncestor(realish(resolve(cwd, outDir)))));
		if (freeKb === null) throw new ArchiveRefused(`cannot read free space on ${outDir}; refusing without the floor proof`);
		if (freeKb < minFreeGb * 1024 * 1024) {
			throw new ArchiveRefused(
				`refusing to archive: ${Math.floor(freeKb / 1024 / 1024)} GB free on ${outDir} is below SUBSTRATE_DEPLOY_MIN_FREE_GB=${minFreeGb}; see docs/runbooks/disk-pressure.md`,
			);
		}
	}
}

/** Best-effort cleanup: a failure to remove a leftover must never replace the error that caused the cleanup. */
function quietly(work: () => void): void {
	try {
		work();
	} catch {
		// Left for the next run's sweep.
	}
}

/** How old an unfinished snapshot directory must be before the next run removes it: a run in progress is never touched. */
export const STALE_SNAPSHOT_MS = 60 * 60 * 1000;

/** The instant a snapshot directory's name records (UTC), or `NaN`. */
function snapshotTime(name: string): number {
	const m = /^index-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(name);
	return m === null ? Number.NaN : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/**
 * Remove the unfinished snapshot directories a killed run left in `outDir`:
 * only directories named like this archive's own (`index-<stamp>`), older than
 * `minAgeMs` by the stamp in the name, with no `manifest.json`, and holding
 * nothing but the files an export writes (`<table>.ndjson`, `.part` files, the
 * manifest's `.part`). Anything else — a symlink, a file, a directory with an
 * unknown entry, a complete snapshot — is left alone. Returns the names removed.
 */
export function sweepStaleSnapshots(outDir: string, now: number, minAgeMs: number = STALE_SNAPSHOT_MS): string[] {
	let names: string[];
	try {
		names = readdirSync(outDir);
	} catch {
		return [];
	}
	const ours = new Set<string>([`${MANIFEST_FILE}.part`]);
	for (const spec of ARCHIVE_TABLES) {
		ours.add(`${spec.name}.ndjson`);
		ours.add(`${spec.name}.ndjson.part`);
	}
	const swept: string[] = [];
	for (const name of names.sort()) {
		const at = snapshotTime(name);
		if (!SNAPSHOT_RE.test(name) || !Number.isFinite(at) || now - at < minAgeMs) continue;
		const dir = join(outDir, name);
		try {
			if (!lstatSync(dir).isDirectory()) continue;
			const entries = readdirSync(dir);
			if (entries.includes(MANIFEST_FILE) || !entries.every((entry) => ours.has(entry))) continue;
			for (const entry of entries) rmSync(join(dir, entry), { force: true });
			rmdirSync(dir);
			swept.push(name);
		} catch {
			// Not removable now; reported next time it is.
		}
	}
	return swept;
}

/**
 * Archive the whole index into `<outDir>/index-<stamp>/`. Refuses — before
 * creating anything — a directory the path gates reject, one that is not on a
 * dedicated filesystem (the nearest existing ancestor's `st_dev` against `/`
 * and the release root, so an unmounted volume is caught before `mkdir`), and
 * a filesystem below the free-space floor. Then exports each whitelisted table
 * in key-ordered pages inside one REPEATABLE READ READ ONLY transaction,
 * appending each page to a `.part` file and digesting as it goes — never more
 * than one page of rows in memory — and renames the data files into place
 * before the manifest. Any failure (a deadline, the byte bound, a row carrying
 * a column outside the spec, a row count that disagrees with the snapshot's)
 * discards every `.part` file and the directory it created.
 */
export async function archiveIndex(source: IndexArchiveSource, options: IndexArchiveOptions): Promise<IndexArchiveManifest> {
	const now = options.now ?? Date.now;
	const cwd = options.cwd ?? process.cwd();
	const { outDir } = options;
	const pageSize = options.pageSize ?? DEFAULT_ARCHIVE_PAGE_ROWS;
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_ARCHIVE_PAGE_ROWS_CLI) throw new ArchiveRefused(`page size must be 1..${MAX_ARCHIVE_PAGE_ROWS_CLI}`);
	assertArchiveDir(outDir, options, cwd);

	const startedAt = now();
	const deadline = startedAt + (options.maxSeconds ?? DEFAULT_ARCHIVE_MAX_SECONDS) * 1000;
	const maxBytes = options.maxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES;
	const snapshot = snapshotName(startedAt);
	const dir = join(outDir, snapshot);
	// The one place a mode is set before a rename; injectable so a test can make it fail on a chosen file.
	const chmod = options.chmod ?? chmodSync;
	// A killed earlier run (no catch ran) leaves a manifest-less directory; sweep those, and only those, and say so.
	const swept = sweepStaleSnapshots(outDir, startedAt, Math.max(STALE_SNAPSHOT_MS, 2 * (options.maxSeconds ?? DEFAULT_ARCHIVE_MAX_SECONDS) * 1000));
	if (swept.length > 0) options.onSwept?.(swept);
	mkdirSync(outDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	try {
		mkdirSync(dir, { mode: PRIVATE_DIR_MODE });
		// Explicit, so an inherited setgid bit or default ACL on the parent cannot widen it.
		chmodSync(dir, PRIVATE_DIR_MODE);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new ArchiveRefused(`${snapshot} already exists in ${outDir}; wait a second and run again`);
		throw cause;
	}

	const opened: NdjsonPart[] = [];
	try {
		const exported = await source.withExportSnapshot(async (reader) => {
			const serverVersion = await withDeadline(reader.serverVersion(), deadline - now(), "server version");
			const tables: Record<string, { part: NdjsonPart; rows: number; digests: TableDigests }> = {};
			let written = 0;
			for (const spec of ARCHIVE_TABLES) {
				const expected = await withDeadline(reader.count(spec.name), deadline - now(), `${spec.name} count`);
				const part = new NdjsonPart(dir, `${spec.name}.ndjson`, chmod);
				opened.push(part);
				const digests = new TableDigests(spec);
				let rows = 0;
				let after: Array<string | number> | null = null;
				for (;;) {
					if (now() >= deadline) throw new IndexArchiveFailed(`export exceeded SUBSTRATE_INDEX_ARCHIVE_MAX_SECONDS=${options.maxSeconds ?? DEFAULT_ARCHIVE_MAX_SECONDS}`);
					const page: ArchiveRow[] = await withDeadline(reader.page(spec.name, after, pageSize), deadline - now(), `${spec.name} page`);
					if (page.length === 0) break;
					const lines: string[] = [];
					for (const row of page) {
						// A row must carry exactly the exported columns: a withheld column, or one the spec does not know, never reaches a file.
						const checked = coerceRow(spec, row);
						if (!checked.ok) throw new IndexArchiveFailed(`${spec.name}: a row is outside the archived shape (${checked.reason})`);
						const line = JSON.stringify(checked.row);
						digests.add(line, checked.row);
						lines.push(line);
					}
					const before = part.bytes;
					part.append(lines);
					written += part.bytes - before;
					rows += page.length;
					if (written > maxBytes) throw new IndexArchiveFailed(`export exceeded SUBSTRATE_INDEX_ARCHIVE_MAX_BYTES=${maxBytes}`);
					if (page.length < pageSize) break;
					const next = rowKey(spec, page[page.length - 1] as ArchiveRow);
					if (after !== null && after.length === next.length && after.every((value, i) => value === next[i])) {
						throw new IndexArchiveFailed(`${spec.name}: the export cursor did not advance`);
					}
					after = next;
				}
				if (rows !== expected) throw new IndexArchiveFailed(`${spec.name}: exported ${rows} rows but the snapshot counts ${expected}`);
				tables[spec.name] = { part, rows, digests };
			}
			return { serverVersion, tables };
		});

		const manifestTables: Record<string, TableManifest> = {};
		for (const spec of ARCHIVE_TABLES) {
			const done = exported.tables[spec.name];
			if (done === undefined) throw new IndexArchiveFailed(`${spec.name} was not exported`);
			manifestTables[spec.name] = {
				file: `${spec.name}.ndjson`,
				rows: done.rows,
				bytes: done.part.bytes,
				sha256: done.part.digest(),
				columns: exportedColumns(spec).map((column) => column.name),
				withheld: [...spec.withheld],
				rowDigest: done.digests.rows.value(),
				...(done.digests.entryHashes !== null ? { entryHashDigest: done.digests.entryHashes.value() } : {}),
			};
		}
		const manifest: IndexArchiveManifest = {
			version: INDEX_ARCHIVE_VERSION,
			kind: "index-archive",
			snapshot,
			createdAt: new Date(startedAt).toISOString(),
			...(options.releaseSha !== undefined ? { releaseSha: options.releaseSha } : {}),
			serverVersion: exported.serverVersion,
			schemaHash: schemaHash(),
			tables: manifestTables,
		};
		// Every fallible step but the last happens before the manifest exists: modes are set on the `.part` files
		// (and created with them), so once the manifest rename succeeds nothing can fail and leave a published,
		// half-removed snapshot.
		for (const part of opened) part.commit();
		const manifestPart = join(dir, `${MANIFEST_FILE}.part`);
		writeFileSync(manifestPart, `${JSON.stringify(manifest, null, "\t")}\n`, { mode: PRIVATE_FILE_MODE });
		chmod(manifestPart, PRIVATE_FILE_MODE);
		// Last: its presence means every data file above is complete.
		renameSync(manifestPart, join(dir, MANIFEST_FILE));
		return manifest;
	} catch (cause) {
		// The manifest is the publish marker, so it goes first: whatever else fails to be removed, nothing
		// that remains can be mistaken for a complete archive. Removal failures are not thrown over the cause.
		quietly(() => rmSync(join(dir, MANIFEST_FILE), { force: true }));
		for (const part of opened) quietly(() => part.discard());
		quietly(() => rmSync(join(dir, `${MANIFEST_FILE}.part`), { force: true, recursive: true }));
		quietly(() => rmdirSync(dir));
		throw cause;
	}
}

// ─── Reading NDJSON without holding a file ──────────────────────────────────

interface LineStats {
	bytes: number;
	/** Lines seen, including blank and over-long ones. */
	lines: number;
	/** Set once the file has been read to its end. */
	sha256: string;
	/** The file did not end with a newline. */
	unterminated: boolean;
	/** Over-long lines (over {@link MAX_LINE_BYTES}), whose text is not kept: a count and three examples, never a list that grows with the file. */
	overlong: LineTally;
}

/** How many example line numbers a {@link LineTally} keeps. */
export const TALLY_EXAMPLES = 3;

/** A count of damaged lines and the first few of their line numbers: constant memory whatever the file holds. */
export class LineTally {
	count = 0;
	/** The smallest line numbers added, at most {@link TALLY_EXAMPLES}, ascending as long as `add` is called in line order. */
	readonly examples: number[] = [];

	add(line: number): void {
		this.count++;
		if (this.examples.length < TALLY_EXAMPLES) this.examples.push(line);
	}
}

/**
 * The lines of an NDJSON file, one at a time from 1 MiB reads, so a file of any
 * size is read in bounded memory. `line` is `null` for a line over
 * {@link MAX_LINE_BYTES}: the limit is enforced while reading, never after.
 * `stats` is filled as the generator runs and holds the SHA-256 of every byte
 * once it completes.
 */
function* ndjsonLines(path: string, stats: LineStats): Generator<{ n: number; line: string | null }> {
	const fd = openSync(path, "r");
	const hasher = new Bun.CryptoHasher("sha256");
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	let carry: Buffer = Buffer.alloc(0);
	let discarding = false;
	try {
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read === 0) break;
			const chunk = buffer.subarray(0, read);
			hasher.update(chunk);
			stats.bytes += read;
			let start = 0;
			for (let at = chunk.indexOf(10, start); at !== -1; at = chunk.indexOf(10, start)) {
				const piece = chunk.subarray(start, at);
				const full = carry.length > 0 ? Buffer.concat([carry, piece]) : piece;
				carry = Buffer.alloc(0);
				stats.lines++;
				if (discarding || full.length > MAX_LINE_BYTES) {
					discarding = false;
					stats.overlong.add(stats.lines);
					yield { n: stats.lines, line: null };
				} else {
					yield { n: stats.lines, line: full.toString("utf8") };
				}
				start = at + 1;
			}
			if (!discarding) {
				// Copied: the read buffer is reused by the next read.
				const rest = Buffer.concat([carry, chunk.subarray(start)]);
				if (rest.length > MAX_LINE_BYTES) {
					discarding = true;
					carry = Buffer.alloc(0);
				} else {
					carry = rest;
				}
			}
		}
		if (carry.length > 0 || discarding) {
			stats.lines++;
			stats.unterminated = true;
			if (discarding) {
				stats.overlong.add(stats.lines);
				yield { n: stats.lines, line: null };
			} else {
				yield { n: stats.lines, line: carry.toString("utf8") };
			}
		}
		stats.sha256 = hasher.digest("hex");
	} finally {
		closeSync(fd);
	}
}

function newStats(): LineStats {
	return { bytes: 0, lines: 0, sha256: "", unterminated: false, overlong: new LineTally() };
}

// ─── Offline verify ─────────────────────────────────────────────────────────

/** The closed vocabulary of what `verify-archive` can find wrong. */
export const INDEX_MISMATCH_KINDS = ["missing-file", "size", "hash", "rowcount", "parse", "schema", "manifest"] as const;
export type IndexMismatchKind = (typeof INDEX_MISMATCH_KINDS)[number];

/** One thing `verifyIndexArchive` found wrong: a name, a kind and counts — never a row's contents. */
export interface IndexVerifyMismatch {
	kind: IndexMismatchKind;
	file?: string;
	table?: string;
	detail: string;
}

export interface IndexVerifyReport {
	ok: boolean;
	/** The directory given. */
	dir: string;
	/** The snapshot directory checked, or `null` when none had a manifest. */
	snapshot: string | null;
	tables: Record<string, { rows: number; bytes: number }>;
	mismatches: IndexVerifyMismatch[];
}

/** The snapshot directory `dir` names: itself when it holds a manifest, else its newest complete `index-*` child. */
export function resolveSnapshotDir(dir: string): string | null {
	if (existsSync(join(dir, MANIFEST_FILE))) return dir;
	const newest = completeSnapshots(dir)[0];
	return newest === undefined ? null : join(dir, newest);
}

/**
 * Check one snapshot from its files alone — no database, no network. Never
 * throws on a finding: every disagreement is a {@link IndexVerifyMismatch}.
 * In order: the manifest exists, parses and is this format; its schema hash,
 * table list, columns and withheld lists equal the running code's; every
 * table file exists with the manifest's size and SHA-256; every line is a row
 * of its table in exactly the form the export writes; line counts equal the
 * manifest's; and the row and `entry_hash` digests recomputed from the lines
 * equal the manifest's.
 */
export function verifyIndexArchive(dir: string): IndexVerifyReport {
	const mismatches: IndexVerifyMismatch[] = [];
	const report: IndexVerifyReport = { ok: false, dir, snapshot: null, tables: {}, mismatches };
	const finish = (): IndexVerifyReport => {
		report.ok = mismatches.length === 0;
		return report;
	};
	const snapshotDir = resolveSnapshotDir(dir);
	if (snapshotDir === null) {
		mismatches.push({ kind: "missing-file", file: MANIFEST_FILE, detail: `no ${MANIFEST_FILE} in ${dir} or in an index-<stamp> directory under it` });
		return finish();
	}
	report.snapshot = snapshotDir === dir ? null : snapshotDir.slice(dir.length).replace(/^\/+/, "");

	const manifestPath = join(snapshotDir, MANIFEST_FILE);
	let manifest: z.infer<typeof ManifestSchema> | null = null;
	try {
		if (statSync(manifestPath).size <= 4 * 1024 * 1024) {
			const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
			manifest = parsed.success ? parsed.data : null;
		}
	} catch {
		manifest = null;
	}
	if (manifest === null) {
		mismatches.push({ kind: "manifest", file: MANIFEST_FILE, detail: "manifest does not parse as an index archive manifest" });
		return finish();
	}
	if (manifest.version !== INDEX_ARCHIVE_VERSION) {
		mismatches.push({ kind: "manifest", file: MANIFEST_FILE, detail: `manifest version ${manifest.version} is not ${INDEX_ARCHIVE_VERSION}` });
		return finish();
	}
	if (manifest.schemaHash !== schemaHash()) {
		mismatches.push({ kind: "schema", file: MANIFEST_FILE, detail: `schema hash ${manifest.schemaHash} differs from this release's ${schemaHash()}` });
	}
	for (const name of Object.keys(manifest.tables)) {
		if (!ARCHIVE_TABLES.some((spec) => spec.name === name)) mismatches.push({ kind: "manifest", file: MANIFEST_FILE, detail: "manifest lists a table the archive does not carry" });
	}

	for (const spec of ARCHIVE_TABLES) {
		const entry = Object.hasOwn(manifest.tables, spec.name) ? manifest.tables[spec.name] : undefined;
		if (entry === undefined) {
			mismatches.push({ kind: "manifest", table: spec.name, file: MANIFEST_FILE, detail: `manifest has no entry for ${spec.name}` });
			continue;
		}
		const file = `${spec.name}.ndjson`;
		// The path is built from the spec, never from the manifest: a manifest cannot point a read elsewhere.
		if (entry.file !== file) mismatches.push({ kind: "manifest", table: spec.name, file: MANIFEST_FILE, detail: `manifest names ${spec.name}'s file differently from ${file}` });
		const columns = exportedColumns(spec).map((column) => column.name);
		if (entry.columns.join(",") !== columns.join(",") || entry.withheld.join(",") !== spec.withheld.join(",")) {
			mismatches.push({ kind: "schema", table: spec.name, file: MANIFEST_FILE, detail: `${spec.name}'s column or withheld list differs from this release's` });
		}
		if (spec.hasEntryHash && entry.entryHashDigest === undefined) {
			mismatches.push({ kind: "manifest", table: spec.name, file: MANIFEST_FILE, detail: `${spec.name} has entry hashes and the manifest carries no digest for them` });
		}
		const path = join(snapshotDir, file);
		let size: number;
		try {
			size = statSync(path).size;
		} catch {
			mismatches.push({ kind: "missing-file", table: spec.name, file, detail: `${file} is missing` });
			continue;
		}
		if (size !== entry.bytes) mismatches.push({ kind: "size", table: spec.name, file, detail: `${size} bytes, manifest says ${entry.bytes}` });

		const stats = newStats();
		const digests = new TableDigests(spec);
		const bad = new LineTally();
		for (const { n, line } of ndjsonLines(path, stats)) {
			if (line === null) continue;
			let row: CoercedRow;
			try {
				row = coerceRow(spec, JSON.parse(line));
			} catch {
				bad.add(n);
				continue;
			}
			// The line must be exactly what the export writes, so the digests below are over the same text.
			if (!row.ok || JSON.stringify(row.row) !== line) {
				bad.add(n);
				continue;
			}
			digests.add(line, row.row);
		}
		report.tables[spec.name] = { rows: stats.lines, bytes: stats.bytes };
		if (stats.sha256 !== entry.sha256) mismatches.push({ kind: "hash", table: spec.name, file, detail: `sha256 ${stats.sha256} differs from manifest ${entry.sha256}` });
		if (stats.lines !== entry.rows) mismatches.push({ kind: "rowcount", table: spec.name, file, detail: `${stats.lines} lines, manifest counts ${entry.rows}` });
		const unparsed = bad.count + stats.overlong.count + (stats.unterminated ? 1 : 0);
		if (unparsed > 0) {
			// Each tally keeps its three smallest line numbers (lines are scanned in order), so the merge is the three smallest overall.
			const first = [...bad.examples, ...stats.overlong.examples].sort((a, b) => a - b).slice(0, 3);
			mismatches.push({
				kind: "parse",
				table: spec.name,
				file,
				detail: `${unparsed} line(s) are not ${spec.name} rows in archive form${first.length > 0 ? ` (first at line ${first.join(", ")})` : ""}${stats.unterminated ? "; the file does not end with a newline" : ""}`,
			});
			continue;
		}
		if (digests.rows.value() !== entry.rowDigest) mismatches.push({ kind: "hash", table: spec.name, file, detail: "the row digest recomputed from the lines differs from the manifest" });
		if (digests.entryHashes !== null && entry.entryHashDigest !== undefined && digests.entryHashes.value() !== entry.entryHashDigest) {
			mismatches.push({ kind: "hash", table: spec.name, file, detail: "the entry_hash digest recomputed from the lines differs from the manifest" });
		}
	}
	return finish();
}

/** One sentence per mismatch kind, fixed: what an operator greps the journal for and what the tests pin. */
export const INDEX_MISMATCH_SENTENCE: Record<IndexMismatchKind, string> = {
	"missing-file": "a file the archive needs is missing",
	size: "a file's size differs from the manifest",
	hash: "a file's or its rows' digest differs from the manifest",
	rowcount: "a file's line count differs from the manifest",
	parse: "a line is not a row of its table",
	schema: "the archive's schema is not this release's",
	manifest: "the manifest does not describe these files",
};

/** A verify report as text: the verdict, then one line per mismatch — `<kind> <sentence> (<where>): <detail>`. Names and counts only. */
export function formatIndexVerifyReport(report: IndexVerifyReport): string {
	const lines = [`verify ${report.snapshot ?? report.dir}: ${report.ok ? "ok" : `${report.mismatches.length} mismatch${report.mismatches.length === 1 ? "" : "es"}`}`];
	for (const name of Object.keys(report.tables)) {
		const table = report.tables[name];
		if (table !== undefined) lines.push(`  ${name.padEnd(18)} ${String(table.rows).padStart(8)} rows ${String(table.bytes).padStart(10)} bytes`);
	}
	for (const m of report.mismatches) {
		const where = [m.table, m.file].filter((part): part is string => part !== undefined).join(" ");
		lines.push(`  ${m.kind.padEnd(12)} ${INDEX_MISMATCH_SENTENCE[m.kind]}${where ? ` (${where})` : ""}: ${m.detail}`);
	}
	return `${lines.join("\n")}\n`;
}

/** A manifest as one line per table, for the archive run's output. */
export function formatIndexManifest(manifest: IndexArchiveManifest): string {
	const lines = [`archived ${manifest.snapshot} (postgres ${manifest.serverVersion}):`];
	for (const spec of ARCHIVE_TABLES) {
		const table = manifest.tables[spec.name];
		if (table !== undefined) lines.push(`  ${spec.name.padEnd(18)} ${String(table.rows).padStart(8)} rows ${String(table.bytes).padStart(10)} bytes${table.withheld.length > 0 ? `  (withheld: ${table.withheld.join(", ")})` : ""}`);
	}
	return `${lines.join("\n")}\n`;
}

// ─── Restore to a scratch database ──────────────────────────────────────────

/** A restore refused before it wrote anything: a usage or environment fault, exit 2 at the runner. */
export class RestoreRefused extends Error {}

export interface PgTarget {
	host: string;
	port: number;
	database: string;
}

/** One IPv4 component in the forms `inet_aton` (and so libpq's resolver) accepts: decimal, `0`-prefixed octal, `0x` hex. */
function ipv4Part(text: string): number | null {
	let value: number;
	if (/^0x[0-9a-f]+$/i.test(text)) value = Number.parseInt(text.slice(2), 16);
	else if (/^0[0-7]*$/.test(text)) value = Number.parseInt(text, 8) || 0;
	else if (/^[1-9][0-9]*$/.test(text)) value = Number.parseInt(text, 10);
	else return null;
	return Number.isSafeInteger(value) ? value : null;
}

/** An IPv4 address in any `inet_aton` spelling (`127.1`, `2130706433`, `0x7f.0.0.1`, `0177.0.0.1`) as its 32-bit value, or `null` when the text is not one. */
function ipv4Value(text: string): number | null {
	const parts = text.split(".");
	if (parts.length < 1 || parts.length > 4) return null;
	const numbers: number[] = [];
	for (const part of parts) {
		const value = ipv4Part(part);
		if (value === null) return null;
		numbers.push(value);
	}
	const last = numbers[numbers.length - 1] as number;
	if (last >= 256 ** (5 - numbers.length)) return null;
	let total = last;
	for (let i = 0; i < numbers.length - 1; i++) {
		const octet = numbers[i] as number;
		if (octet > 255) return null;
		total += octet * 256 ** (3 - i);
	}
	return total;
}

/** An address's canonical name: every `127.0.0.0/8` address and `0.0.0.0` are the one host `loopback`. */
function canonicalIpv4(value: number): string {
	if (value === 0 || Math.floor(value / 2 ** 24) === 127) return "loopback";
	return [Math.floor(value / 2 ** 24), Math.floor(value / 65536) % 256, Math.floor(value / 256) % 256, value % 256].join(".");
}

/** The eight 16-bit groups of an IPv6 literal (with `::` compression and an IPv4 tail), or `null` when the text is not one. */
function ipv6Groups(text: string): number[] | null {
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const parse = (side: string): number[] | null => {
		if (side === "") return [];
		const groups: number[] = [];
		const words = side.split(":");
		for (const [i, word] of words.entries()) {
			if (word.includes(".") && i === words.length - 1) {
				const value = ipv4Value(word);
				if (value === null) return null;
				groups.push(Math.floor(value / 65536), value % 65536);
			} else if (/^[0-9a-f]{1,4}$/.test(word)) {
				groups.push(Number.parseInt(word, 16));
			} else {
				return null;
			}
		}
		return groups;
	};
	const head = parse(halves[0] ?? "");
	const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
	if (head === null || tail === null) return null;
	if (halves.length === 1) return head.length === 8 ? head : null;
	const gap = 8 - head.length - tail.length;
	return gap < 0 ? null : [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/**
 * A host as one canonical name, so two spellings of one machine compare equal:
 * case, brackets and a trailing dot are dropped; an empty host (the local
 * socket), `localhost`, every IPv4 spelling of `127.0.0.0/8` or `0.0.0.0`, and
 * `::`, `::1` and their IPv4-mapped forms (`::ffff:127.0.0.1`, `::ffff:7f00:1`)
 * are all `loopback`; any other IPv4 address (mapped or not) is its dotted
 * quad. Bun keeps these hostnames as written for a non-special scheme, so
 * `postgres://127.1/x` and `postgres://localhost/x` reach the same server.
 */
function canonicalHost(raw: string): string {
	const host = raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (host === "" || host === "localhost") return "loopback";
	if (host.includes(":")) {
		const groups = ipv6Groups(host.split("%")[0] ?? host);
		if (groups === null) return host;
		if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] === 0 || groups[7] === 1)) return "loopback";
		if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return canonicalIpv4(((groups[6] as number) * 65536) + (groups[7] as number));
		return groups.map((group) => group.toString(16)).join(":");
	}
	const value = ipv4Value(host);
	return value === null ? host : canonicalIpv4(value);
}

/**
 * The host, port and database a Postgres URL names, normalised so two spellings
 * of one database compare equal: the host as {@link canonicalHost}, the default
 * port 5432 applied, the database path without trailing slashes and with its
 * percent-escapes decoded, falling back to the user name as libpq does. `null`
 * for anything that is not a plain `postgres://` URL — and for one whose query
 * string can redirect the connection (`host`, `hostaddr`, `port`, `dbname`,
 * `service`), because the comparison would then be a guess.
 */
export function normalizePgUrl(raw: string): PgTarget | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
	for (const key of url.searchParams.keys()) {
		if (/^(host|hostaddr|port|dbname|service)$/i.test(key)) return null;
	}
	try {
		const host = canonicalHost(decodeURIComponent(url.hostname));
		const port = url.port === "" ? 5432 : Number(url.port);
		const database = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, "")) || decodeURIComponent(url.username);
		if (!Number.isInteger(port) || port < 1 || port > 65535 || database === "") return null;
		return { host, port, database };
	} catch {
		return null;
	}
}

/** `host:port/database` of a URL, or `(unreadable url)` — never the user, the password or a query string. */
export function describePgUrl(raw: string): string {
	const target = normalizePgUrl(raw);
	return target === null ? "(unreadable url)" : `${target.host === "loopback" ? "localhost" : target.host}:${target.port}/${target.database}`;
}

/**
 * Why `scratch` may not be restored into, or `null` when it may. Refused: an
 * unset production URL (so nothing is guessed), a URL either side of which
 * cannot be read, and any URL that names the production host, port and
 * database. The messages carry `host:port/database` only, never credentials.
 */
export function refusedScratchUrl(scratch: string, production: string | undefined): string | null {
	if (production === undefined || production.trim() === "") return "SUBSTRATE_PG_URL is not set, so the production database cannot be told from the scratch one; refusing to restore without that comparison";
	const prod = normalizePgUrl(production);
	if (prod === null) return "SUBSTRATE_PG_URL cannot be read as a plain postgres:// URL; refusing to restore without being able to compare it";
	const target = normalizePgUrl(scratch);
	if (target === null) return "the scratch URL is not a plain postgres:// URL (a host, dbname or service in its query string is refused); refusing to restore into it";
	if (target.host === prod.host && target.port === prod.port && target.database === prod.database) {
		return `refusing to restore into ${describePgUrl(scratch)}: it is the configured production database`;
	}
	return null;
}

/** What `restoreIndexArchive` writes into: `IndexStore` satisfies it; tests pass a stub. */
export interface RestoreTarget {
	migrate(): Promise<void>;
	withRestoreTransaction<T>(work: (tx: IndexRestoreTx) => Promise<T>): Promise<T>;
}

export interface RestoreTableResult {
	table: string;
	manifestRows: number;
	restoredRows: number;
	rowDigestOk: boolean;
	/** `null` for a table with no `entry_hash`. */
	entryHashOk: boolean | null;
	ok: boolean;
}

/** The scratch database did not come back equal to the archive; the transaction was rolled back, nothing is left loaded. */
export class RestoreMismatch extends Error {
	constructor(readonly results: RestoreTableResult[]) {
		super(`restore did not reproduce the archive: ${results.filter((result) => !result.ok).map((result) => result.table).join(", ")}`);
	}
}

/** Rows read from a file per `insert` call. */
const RESTORE_CHUNK_ROWS = 1000;
/** Rows per page when the loaded tables are read back for comparison. */
const RESTORE_VERIFY_PAGE_ROWS = 500;

/**
 * Load a verified snapshot into an empty scratch database and prove the result.
 * The archive is verified offline first and a mismatch refuses before the
 * target is touched; then `migrate()` runs on the target, every table must be
 * empty (a scratch database that already holds rows is refused), and one
 * transaction loads the tables in foreign-key order, reads each back through
 * the same keyset pages the export uses, and compares the row count, the row
 * digest and — for tables that have one — the `entry_hash` digest with the
 * manifest. Any difference throws {@link RestoreMismatch} inside the
 * transaction, which rolls back: a failed restore leaves the scratch empty.
 * Withheld columns are restored as the spec's placeholders, so those tables
 * verify on their metadata and hashes, not their text.
 */
export async function restoreIndexArchive(target: RestoreTarget, options: { dir: string }): Promise<{ snapshot: string; results: RestoreTableResult[] }> {
	const verdict = verifyIndexArchive(options.dir);
	if (!verdict.ok) {
		throw new RestoreRefused(`the archive does not verify (${[...new Set(verdict.mismatches.map((m) => m.kind))].join(", ")}); run verify-archive`);
	}
	const snapshotDir = resolveSnapshotDir(options.dir);
	if (snapshotDir === null) throw new RestoreRefused(`no ${MANIFEST_FILE} in ${options.dir}`);
	const manifest = ManifestSchema.parse(JSON.parse(readFileSync(join(snapshotDir, MANIFEST_FILE), "utf8")));

	await target.migrate();
	const results = await target.withRestoreTransaction(async (tx) => {
		for (const spec of ARCHIVE_TABLES) {
			const held = await tx.count(spec.name);
			if (held > 0) throw new RestoreRefused(`scratch table ${spec.name} already holds ${held} rows; restore needs an empty scratch database`);
		}
		for (const spec of ARCHIVE_TABLES) {
			let chunk: ArchiveRow[] = [];
			for (const { n, line } of ndjsonLines(join(snapshotDir, `${spec.name}.ndjson`), newStats())) {
				const parsed = line === null ? null : coerceRow(spec, JSON.parse(line));
				if (parsed === null || !parsed.ok) throw new RestoreRefused(`${spec.name}.ndjson line ${n} is not a ${spec.name} row`);
				chunk.push(parsed.row);
				if (chunk.length >= RESTORE_CHUNK_ROWS) {
					await tx.insert(spec.name, chunk);
					chunk = [];
				}
			}
			if (chunk.length > 0) await tx.insert(spec.name, chunk);
			// The rows carried their own identity values: move each sequence past them before anything else writes to the table.
			await tx.advanceIdentity(spec.name);
		}
		const compared: RestoreTableResult[] = [];
		for (const spec of ARCHIVE_TABLES) {
			const entry = manifest.tables[spec.name];
			if (entry === undefined) throw new RestoreRefused(`manifest has no entry for ${spec.name}`);
			const digests = new TableDigests(spec);
			let rows = 0;
			let after: Array<string | number> | null = null;
			for (;;) {
				const page: ArchiveRow[] = await tx.page(spec.name, after, RESTORE_VERIFY_PAGE_ROWS);
				for (const row of page) {
					digests.add(JSON.stringify(row), row);
					rows++;
				}
				if (page.length < RESTORE_VERIFY_PAGE_ROWS) break;
				after = rowKey(spec, page[page.length - 1] as ArchiveRow);
			}
			const rowDigestOk = digests.rows.value() === entry.rowDigest;
			const entryHashOk = digests.entryHashes === null ? null : digests.entryHashes.value() === entry.entryHashDigest;
			compared.push({ table: spec.name, manifestRows: entry.rows, restoredRows: rows, rowDigestOk, entryHashOk, ok: rows === entry.rows && rowDigestOk && entryHashOk !== false });
		}
		if (compared.some((result) => !result.ok)) throw new RestoreMismatch(compared);
		return compared;
	});
	return { snapshot: manifest.snapshot, results };
}

/** The restore verdict as a table: counts and digest verdicts per table, and where it went — host, port and database only. */
export function formatRestoreResults(results: readonly RestoreTableResult[], scratch: string): string {
	const verdict = (value: boolean | null): string => (value === null ? "-" : value ? "ok" : "DIFFERS");
	const lines = [`restore into ${scratch}: ${results.every((result) => result.ok) ? "ok" : "FAILED"}`, `  ${"table".padEnd(18)} ${"archive".padStart(8)} ${"restored".padStart(8)}  rows  entry_hash`];
	for (const result of results) {
		lines.push(`  ${result.table.padEnd(18)} ${String(result.manifestRows).padStart(8)} ${String(result.restoredRows).padStart(8)}  ${verdict(result.rowDigestOk).padEnd(6)} ${verdict(result.entryHashOk)}`);
	}
	return `${lines.join("\n")}\n`;
}

// ─── The ledger's own record of an archive ──────────────────────────────────

/**
 * The `note` that records one archive in the ledger: counts, sizes and file
 * digests per table — no rows, no path. It reuses the `note` kind on surface
 * `substrate` like every other host job; `payload.action` is `index.archive`.
 * Deterministic from the manifest, so a retried note carries exactly what the
 * first attempt would have.
 */
export function indexArchiveNote(manifest: IndexArchiveManifest): EventInput {
	const tables: Record<string, { rows: number; bytes: number; sha256: string }> = {};
	let rows = 0;
	for (const spec of ARCHIVE_TABLES) {
		const table = manifest.tables[spec.name];
		if (table === undefined) continue;
		tables[spec.name] = { rows: table.rows, bytes: table.bytes, sha256: table.sha256 };
		rows += table.rows;
	}
	return {
		surface: "substrate",
		kind: "note",
		summary: `index archive ${manifest.snapshot}: ${rows} rows in ${Object.keys(tables).length} tables`,
		session_id: `index-archive:${manifest.snapshot}`,
		payload: {
			action: "index.archive",
			runtime: "index-archive",
			snapshot: manifest.snapshot,
			createdAt: manifest.createdAt,
			serverVersion: manifest.serverVersion,
			schemaHash: manifest.schemaHash,
			tables,
			...(manifest.releaseSha !== undefined ? { releaseSha: manifest.releaseSha } : {}),
		},
	};
}

/** The marker a snapshot keeps beside its directory from before its note is first sent until the ledger has taken it. */
export interface PendingIndexNote {
	snapshot: string;
	note: EventInput;
	/** Sends the ledger has refused or that threw; `0` while the first is still in flight. */
	attempts: number;
	lastError: string | null;
	firstAttemptAt: string;
}

const PendingNoteSchema = z.object({
	snapshot: z.string(),
	note: z.looseObject({ surface: z.string(), kind: z.string(), summary: z.string() }),
	attempts: z.number(),
	lastError: z.string().nullable(),
	firstAttemptAt: z.string(),
});

/** `note-pending-<snapshot>.json`: present exactly while the snapshot exists and its note is not stored. */
export function pendingIndexNoteFile(snapshot: string): string {
	return `note-pending-${snapshot}.json`;
}

/** Snapshots with a pending-note marker in `dir`, oldest first; an unreadable dir is empty. */
export function pendingIndexNotes(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const found: string[] = [];
	for (const name of names) {
		const snapshot = /^note-pending-(index-\d{8}T\d{6}Z)\.json$/.exec(name)?.[1];
		if (snapshot !== undefined) found.push(snapshot);
	}
	return found.sort();
}

/** The marker's error text: redacted and short, because it is written to disk. */
function errorText(cause: unknown): string {
	return redact(String(cause instanceof Error ? cause.message : cause)).slice(0, 300);
}

/** One emit attempt as an outcome, never a throw: a bad note must be a pending snapshot, not a failed run. */
async function sendNote(emit: (input: EventInput) => Promise<NoteOutcome>, note: EventInput): Promise<NoteOutcome> {
	try {
		return await emit(note);
	} catch (cause) {
		return { stored: false, error: errorText(cause) };
	}
}

/** What one note attempt answers, plus why its retry marker could not be written or cleared, when it could not. */
export interface IndexNoteOutcome extends NoteOutcome {
	markerError?: string;
}

/** Write the marker atomically (tmp + rename); a failure is returned as text (redacted, short), never thrown. */
function tryWritePendingNote(dir: string, pending: PendingIndexNote): string | null {
	const marker = join(dir, pendingIndexNoteFile(pending.snapshot));
	try {
		writeFileSync(`${marker}.part`, `${JSON.stringify(pending, null, "\t")}\n`, { mode: PRIVATE_FILE_MODE });
		renameSync(`${marker}.part`, marker);
		chmodSync(marker, PRIVATE_FILE_MODE);
		return null;
	} catch (cause) {
		return `note marker not written: ${errorText(cause)}`;
	}
}

/** Remove the marker once the ledger has the note; a failure is returned as text, never thrown (the note would only be sent again). */
function tryClearPendingNote(dir: string, snapshot: string): string | null {
	try {
		rmSync(join(dir, pendingIndexNoteFile(snapshot)), { force: true });
		return null;
	} catch (cause) {
		return `note marker not cleared: ${errorText(cause)}`;
	}
}

/** The snapshot's marker, or `null` when there is none or it does not parse (a corrupt marker is rewritten on the next failure). */
export function readPendingIndexNote(dir: string, snapshot: string): PendingIndexNote | null {
	const path = join(dir, pendingIndexNoteFile(snapshot));
	if (!existsSync(path)) return null;
	try {
		const parsed = PendingNoteSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
		return parsed.success ? { ...parsed.data, note: parsed.data.note as unknown as EventInput } : null;
	} catch {
		return null;
	}
}

/**
 * Send one snapshot's note with the marker in place for the whole attempt. The
 * archive is already complete and nothing would ever re-export it, so the note
 * is the one thing no later run could redo unless something remembers it is
 * owed: the marker is written BEFORE the emit and removed only once the ledger
 * reports it stored. An emit that throws, a refused note and a process killed
 * between the manifest rename and the answer all leave the marker. A failed
 * note never fails the archive: the caller reports it and the files stay.
 */
export async function recordIndexArchiveNote(
	dir: string,
	manifest: IndexArchiveManifest,
	emit: (input: EventInput) => Promise<NoteOutcome>,
	now: () => number = Date.now,
): Promise<IndexNoteOutcome> {
	const note = indexArchiveNote(manifest);
	const previous = readPendingIndexNote(dir, manifest.snapshot);
	const pending: PendingIndexNote = {
		snapshot: manifest.snapshot,
		note,
		attempts: previous?.attempts ?? 0,
		lastError: previous?.lastError ?? null,
		firstAttemptAt: previous?.firstAttemptAt ?? new Date(now()).toISOString(),
	};
	// A marker that cannot be written (a full disk) must not turn a complete archive into a failure: the note is still
	// attempted, and the caller is told the retry guarantee does not hold for it.
	const markerFailures: string[] = [];
	const before = tryWritePendingNote(dir, pending);
	if (before !== null) markerFailures.push(before);
	const outcome = await sendNote(emit, note);
	if (outcome.stored) {
		const cleared = tryClearPendingNote(dir, manifest.snapshot);
		if (cleared !== null) markerFailures.push(cleared);
	} else {
		const after = tryWritePendingNote(dir, { ...pending, attempts: pending.attempts + 1, lastError: outcome.error ?? null });
		if (after !== null) markerFailures.push(after);
	}
	return markerFailures.length > 0 ? { ...outcome, markerError: markerFailures.join("; ") } : outcome;
}

/**
 * Send every pending note in `dir` again, oldest first, clearing each marker the
 * ledger takes. Runs at the start of every archive run, and ONLY the notes: a
 * snapshot whose note is owed is never exported again. The snapshots still
 * pending are returned, which the runner turns into exit 1.
 */
export async function retryPendingIndexNotes(
	dir: string,
	emit: (input: EventInput) => Promise<NoteOutcome>,
): Promise<{ sent: string[]; pending: Array<{ snapshot: string; attempts: number; lastError: string | null }>; markerWarnings: string[] }> {
	const sent: string[] = [];
	const pending: Array<{ snapshot: string; attempts: number; lastError: string | null }> = [];
	const markerWarnings: string[] = [];
	for (const snapshot of pendingIndexNotes(dir)) {
		const previous = readPendingIndexNote(dir, snapshot);
		if (previous === null) {
			pending.push({ snapshot, attempts: 0, lastError: "marker does not parse" });
			continue;
		}
		const outcome = await sendNote(emit, previous.note);
		if (outcome.stored) {
			const cleared = tryClearPendingNote(dir, snapshot);
			if (cleared !== null) markerWarnings.push(`${snapshot}: ${cleared}`);
			sent.push(snapshot);
			continue;
		}
		const updated: PendingIndexNote = { ...previous, attempts: previous.attempts + 1, lastError: outcome.error ?? null };
		const written = tryWritePendingNote(dir, updated);
		if (written !== null) markerWarnings.push(`${snapshot}: ${written}`);
		pending.push({ snapshot, attempts: updated.attempts, lastError: updated.lastError });
	}
	return { sent, pending, markerWarnings };
}

// ─── The runner's argument grammar ──────────────────────────────────────────

/** A flag the runner refuses; exit 2 with usage. */
export class IndexUsageError extends Error {}

export type IndexCommand =
	| { command: "archive"; out?: string | undefined; pageSize?: number | undefined; json: boolean }
	| { command: "verify-archive"; dir: string; json: boolean }
	| { command: "restore"; scratch?: string | undefined; dir: string; json: boolean };

export const INDEX_ARCHIVE_USAGE =
	"usage: index-run.ts archive [--out DIR] [--page-size N] [--json]\n" +
	"       index-run.ts verify-archive <dir> [--json]\n" +
	"       index-run.ts restore --scratch <postgres-url> <dir> [--json]\n" +
	"  --out defaults to SUBSTRATE_INDEX_ARCHIVE_DIR; verify-archive and restore take a snapshot directory or the archive directory (the newest snapshot).\n" +
	"  --scratch defaults to SUBSTRATE_INDEX_SCRATCH_URL (preferred: an argument is visible to every user in `ps`).\n" +
	"  verify-archive exits 2 on any mismatch; restore refuses the configured production database and exits 2.\n";

/**
 * The runner's argv as a command. Every value is checked here so the runner
 * can refuse with usage before it opens a config, a directory or a database;
 * an empty `--out` is the systemd expansion of an unset
 * `SUBSTRATE_INDEX_ARCHIVE_DIR`, refused by name.
 */
export function parseIndexArgs(argv: readonly string[]): IndexCommand {
	const [command, ...rest] = argv;
	const flags: Record<string, string | true> = {};
	const positional: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i] ?? "";
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const key = arg.slice(2);
		const next = rest[i + 1];
		if (key === "json" || next === undefined || next.startsWith("--")) {
			flags[key] = true;
			continue;
		}
		flags[key] = next;
		i++;
	}
	const known = (keys: string[]): void => {
		for (const key of Object.keys(flags)) {
			if (!keys.includes(key)) throw new IndexUsageError(`unknown flag --${key}`);
		}
	};
	const json = flags.json === true;
	switch (command) {
		case "archive": {
			known(["json", "out", "page-size"]);
			if (positional.length > 0) throw new IndexUsageError(`unexpected argument ${positional[0]}`);
			const out = flags.out;
			if (out === true || out === "") throw new IndexUsageError("--out needs a directory (is SUBSTRATE_INDEX_ARCHIVE_DIR unset?)");
			let pageSize: number | undefined;
			const rawSize = flags["page-size"];
			if (rawSize !== undefined) {
				if (rawSize === true || !/^\d+$/.test(rawSize) || Number(rawSize) < 1 || Number(rawSize) > MAX_ARCHIVE_PAGE_ROWS_CLI) {
					throw new IndexUsageError(`--page-size needs an integer from 1 to ${MAX_ARCHIVE_PAGE_ROWS_CLI}`);
				}
				pageSize = Number(rawSize);
			}
			return { command, out, pageSize, json };
		}
		case "verify-archive": {
			known(["json"]);
			const dir = positional[0];
			if (dir === undefined || dir === "" || positional.length > 1) throw new IndexUsageError("verify-archive needs exactly one directory");
			return { command, dir, json };
		}
		case "restore": {
			known(["json", "scratch"]);
			const dir = positional[0];
			if (dir === undefined || dir === "" || positional.length > 1) throw new IndexUsageError("restore needs exactly one archive directory");
			const scratch = flags.scratch;
			if (scratch === true || scratch === "") throw new IndexUsageError("--scratch needs a postgres URL");
			return { command, scratch, dir, json };
		}
		default:
			throw new IndexUsageError(command === undefined ? "a subcommand is required" : `unknown subcommand ${command}`);
	}
}
