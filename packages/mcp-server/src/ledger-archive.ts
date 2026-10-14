/**
 * The verified off-box ledger archive (uplift-3 N6): one closed UTC day of
 * `agent_events` as NDJSON, its first-ingest membership, its anchor receipts
 * and a manifest, written atomically to an operator-mounted directory; and the
 * offline check that recomputes every hash, the chain links, the hourly RFC 6962
 * roots and the file digests from the files alone.
 *
 * This is what has to exist before `SUBSTRATE_LEDGER_TTL` is switched on:
 * `docs/data-planes.md` says "180 days hot, then export", and expiry removes the
 * ability to recompute a root from the live ledger (`docs/greptime-ledger.md`,
 * *Retention*). A day archived here can be verified without the ledger, and its
 * hours checked against the anchor receipts that never expire.
 *
 * The window is the time index: `[day 00:00Z, next day 00:00Z)` on `ts`, read
 * through `GreptimeClient.exportWindow` in keyset pages. That is the column a
 * TTL expires on, so every event lands in exactly one day archive. Hourly roots
 * are grouped by each event's *first ingest* hour, the way the anchor job
 * groups them; an ingest hour whose members straddle midnight (or hold a
 * backdated event whose `ts` is in another day) is only partly in this archive,
 * and verify reports it as `partial` against its receipt rather than as a
 * mismatch — the receipt's `event_count` says how many members the hour had.
 *
 * Nothing here composes SQL and nothing here deletes: the archive reads through
 * the typed seams, writes `*.part` files and renames them, and the TTL stays the
 * operator's switch.
 */
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HOUR_MS, hourIso, hourStart, merkleRootHex } from "@substrate/ledger";
import { z } from "zod";
import { eventHash } from "./event.ts";
import { redact } from "./redact.ts";
import type { AnchorCoverage, ExportCursor, ExportPage, ExportWindowQuery } from "./greptime.ts";
import { ARCHIVE_NOTE_PREFIX, INGEST_LAG_MS } from "./greptime.ts";
import { rowToEvent } from "./service.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

const DAY_MS = 24 * HOUR_MS;

/** A UTC calendar day, the only key an archive is addressed by. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The release root on the VPS; an archive under it would expire with the next prune, and it is the root disk. */
export const RELEASE_ROOT = "/opt/agent-substrate";

/** The floor `substrate ledger archive` applies when the env does not say otherwise: the deploy gate's 5 GB. */
export const DEFAULT_MIN_FREE_GB = 5;

/** Rows per export page when the operator passes none: the read cap, so a day is as few statements as it can be. */
export const DEFAULT_PAGE_SIZE = 500;

/** The archive refused before writing anything: a usage or environment fault, exit 2 at the CLI. */
export class ArchiveRefused extends Error {}

/** A record of what one day's archive holds, written last so its presence means the archive is complete. */
export interface ArchiveManifest {
	day: string;
	counts: {
		events: number;
		/** Events on the day with a first ingest record; `ingestMissing` is the rest (legacy rows predate `event_ingest`). */
		ingest: number;
		ingestMissing: number;
		anchors: number;
	};
	/** The first and last events in `(ts, id)` order; `null` on an empty day. */
	first: ExportCursor | null;
	last: ExportCursor | null;
	/** The hash of the last event in `(ts, id)` order — what a reader of the next window continues from. `null` on an empty day. */
	chainTip: string | null;
	/** RFC 6962 root per first-ingest hour (ISO hour start → 64-hex), over the day's members in `(ingested_at, event_id)` order. */
	hourlyRoots: Record<string, string>;
	/** SHA-256 of each data file as written, keyed by file name. */
	sha256: Record<string, string>;
	writtenAt: string;
	/** The release the archive was written from, when it ran from a `releases/<sha>` tree. */
	releaseSha?: string;
}

/** The `df -Pk -- <path>` runner; `null` means it could not be read, which refuses (fail closed). */
export type DfRunner = (path: string) => string | null;

/** The real one: POSIX output, kilobyte blocks, the same reading `deploy-release.sh` takes. */
export const dfRunner: DfRunner = (path) => {
	try {
		return execFileSync("df", ["-Pk", "--", path], { encoding: "utf8", timeout: 10_000 });
	} catch {
		return null;
	}
};

/**
 * The free kilobytes in `df -Pk` output: the fourth field of its second line,
 * exactly as `deploy-release.sh` reads it (`read -r _ _ _ avail _`). `null`
 * when the output is not that shape — the floor gate then refuses rather than
 * guessing that an unreadable disk has room.
 */
export function freeKbOf(output: string | null): number | null {
	if (output === null) return null;
	const avail = (output.split("\n")[1] ?? "").trim().split(/\s+/)[3] ?? "";
	return /^\d{1,15}$/.test(avail) ? Number(avail) : null;
}

/** The archive file names for a day, in the order they are written. */
export function archiveFiles(day: string): { events: string; ingest: string; anchors: string; manifest: string } {
	return {
		events: `events-${day}.ndjson`,
		ingest: `ingest-${day}.ndjson`,
		anchors: `anchors-${day}.ndjson`,
		manifest: `manifest-${day}.json`,
	};
}

/** `YYYY-MM-DD` of the UTC day holding `ms`. */
export function dayOf(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** Whether `day` is a real UTC calendar day in the `YYYY-MM-DD` form. */
export function isDay(day: string): boolean {
	if (!DAY_RE.test(day)) return false;
	const ms = Date.parse(`${day}T00:00:00.000Z`);
	return Number.isFinite(ms) && dayOf(ms) === day;
}

/** The half-open `ts` window of a day, as the export seam takes it. */
export function dayWindow(day: string): { from: string; to: string } {
	if (!isDay(day)) throw new ArchiveRefused(`not a UTC day: ${JSON.stringify(day)} (expected YYYY-MM-DD)`);
	const from = Date.parse(`${day}T00:00:00.000Z`);
	return { from: new Date(from).toISOString(), to: new Date(from + DAY_MS).toISOString() };
}

/**
 * A day is closed once its last hour is: midnight plus `INGEST_LAG_MS`. The same
 * rule the anchor job applies to hours, so an archive never races a record that
 * is still landing in the day's last hour.
 */
export function isDayClosed(day: string, now: number): boolean {
	const { to } = dayWindow(day);
	return now >= Date.parse(to) + INGEST_LAG_MS;
}

/** The newest day that is closed at `now`, or `null` right after midnight while yesterday is still inside the lag. */
export function newestClosedDay(now: number): string | null {
	const yesterday = dayOf(now - DAY_MS);
	return isDayClosed(yesterday, now) ? yesterday : null;
}

/** Days with a `manifest-<day>.json` in `dir`, ascending; an unreadable dir is empty. */
export function archivedDays(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const days: string[] = [];
	for (const name of names) {
		const day = /^manifest-(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1];
		if (day !== undefined && isDay(day)) days.push(day);
	}
	return days.sort();
}

/**
 * Every day from `firstDay` to `until` inclusive that has no manifest in `dir`
 * yet, ascending — what one `substrate ledger archive --until` run writes.
 * A day with a manifest is never rewritten: the manifest is the archive's own
 * record of completeness, and re-exporting over it would replace a verified
 * file with an unverified one.
 */
export function daysToArchive(options: { firstDay: string; until: string; dir: string }): string[] {
	if (!isDay(options.firstDay) || !isDay(options.until)) throw new ArchiveRefused("days must be YYYY-MM-DD");
	const done = new Set(archivedDays(options.dir));
	const out: string[] = [];
	const end = Date.parse(`${options.until}T00:00:00.000Z`);
	for (let ms = Date.parse(`${options.firstDay}T00:00:00.000Z`); ms <= end; ms += DAY_MS) {
		const day = dayOf(ms);
		if (!done.has(day)) out.push(day);
	}
	return out;
}

/** The nearest existing ancestor's real path joined with the rest, so a dir that does not exist yet still resolves symlinks above it. */
function realish(path: string): string {
	let probe = path;
	const tail: string[] = [];
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) return path;
		tail.unshift(basename(probe));
		probe = parent;
	}
	return join(realpathSync(probe), ...tail);
}

/**
 * Why `outDir` must not be used, or `null` when it may. Refused: the root
 * directory, anything inside the working tree the command runs from (a checkout
 * or a release), anything under the release root, and any directory that is
 * itself a checkout. An archive is the one copy that must outlive a deploy's
 * prune and the VPS disk, and all of those are exactly what it is being moved
 * away from.
 */
export function refusedOutDir(outDir: string, options: { cwd: string; releaseRoot?: string }): string | null {
	const target = realish(resolve(options.cwd, outDir));
	const tree = realish(resolve(options.cwd));
	const releaseRoot = options.releaseRoot ?? RELEASE_ROOT;
	const inside = (root: string): boolean => target === root || target.startsWith(`${root}/`);
	if (target === "/") return "refusing the filesystem root as an archive directory";
	if (inside(tree)) return `refusing ${outDir}: inside the working tree ${tree}`;
	if (inside(releaseRoot)) return `refusing ${outDir}: inside the release root ${releaseRoot}`;
	if (existsSync(join(target, "package.json")) && existsSync(join(target, ".git"))) {
		return `refusing ${outDir}: it is a checkout`;
	}
	return null;
}

/** The nearest existing ancestor of `path`, itself included: what the filesystem can be asked about before the directory exists. */
function existingAncestor(path: string): string {
	let probe = path;
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) return probe;
		probe = parent;
	}
	return probe;
}

/** The device number (`st_dev`) a path lives on, or `null` when it cannot be read; injected by tests, which need no real mounts. */
export type DevReader = (path: string) => number | null;

/** The real one: `stat`'s device, which names the mounted filesystem the path is on, whatever the volume is called. */
export const devReader: DevReader = (path) => {
	try {
		return statSync(path).dev;
	} catch {
		return null;
	}
};

/**
 * Why `outDir` is not on a dedicated archive filesystem, or `null` when it is.
 *
 * The question is asked of the nearest *existing* ancestor, before anything
 * is created: after a reboot with the archive volume not yet mounted, the
 * configured path's parent is a plain directory on the root disk, and a
 * `mkdir -p` there would quietly build the archive on the one disk it exists
 * to leave — with the free-space floor passing, because the root disk has
 * room. So the ancestor's `st_dev` must differ from that of `/` and of the
 * release root (when it exists). Devices are compared, not `df`'s device
 * names: two tmpfs or overlay mounts share a name and are different
 * filesystems, and btrfs subvolumes with different names can share a device.
 * An unreadable `stat` refuses. `allowRootfs` — `SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS=1`
 * — is for a deliberate local test on a machine with one disk, and the refusal
 * names it so the operator sees what they are overriding.
 */
export function refusedMount(
	outDir: string,
	options: { cwd: string; dev?: DevReader; releaseRoot?: string; allowRootfs?: boolean },
): string | null {
	if (options.allowRootfs === true) return null;
	const dev = options.dev ?? devReader;
	const target = realish(resolve(options.cwd, outDir));
	const ancestor = existingAncestor(target);
	const here = dev(ancestor);
	const root = dev("/");
	if (here === null || root === null) {
		return `cannot read the filesystem of ${outDir} (stat on ${here === null ? ancestor : "/"}); refusing without proof it is a dedicated mount`;
	}
	const override = "mount the archive volume first, or set SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS=1 for a deliberate local test";
	if (here === root) return `refusing ${outDir}: it is on the root filesystem (device ${here}); ${override}`;
	const releaseRoot = options.releaseRoot ?? RELEASE_ROOT;
	if (existsSync(releaseRoot)) {
		const release = dev(releaseRoot);
		if (release === null) return `cannot read the filesystem of the release root ${releaseRoot}; refusing without proof ${outDir} is a dedicated mount`;
		if (release === here) return `refusing ${outDir}: it shares the release root's filesystem (device ${here}); ${override}`;
	}
	return null;
}

/**
 * The release sha when `cwd` is (or links to) a `releases/<sha>` tree, as
 * `deploy-release.sh` lays them out; `undefined` from a checkout.
 */
export function releaseShaOf(cwd: string): string | undefined {
	let real: string;
	try {
		real = realpathSync(cwd);
	} catch {
		return undefined;
	}
	const match = /\/releases\/([0-9a-f]{7,40})$/.exec(real);
	return match?.[1];
}

/** What `archiveWindow` needs beyond the day: where, how big the pages, and the gates' inputs. */
export interface ArchiveOptions {
	day: string;
	outDir: string;
	pageSize?: number;
	now?: () => number;
	/** The `df` reading; injected by tests. */
	df?: DfRunner;
	/** The `st_dev` reader for the mount gate; injected by tests. */
	dev?: DevReader;
	/** The free-space floor in GB; `0` disables, as for the deploy gate. */
	minFreeGb?: number;
	/** `SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS=1`: skip the dedicated-mount gate for a deliberate local test. */
	allowRootfs?: boolean;
	cwd?: string;
	releaseSha?: string;
}

/** One data file under construction: its `.part` path, the digest of every byte appended, and the line count. */
class PartFile {
	readonly part: string;
	private readonly hasher = new Bun.CryptoHasher("sha256");
	lines = 0;

	constructor(
		readonly dir: string,
		readonly name: string,
	) {
		this.part = join(dir, `${name}.part`);
		rmSync(this.part, { force: true });
		writeFileSync(this.part, "");
	}

	append(records: readonly unknown[]): void {
		if (records.length === 0) return;
		const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		appendFileSync(this.part, text);
		this.hasher.update(text);
		this.lines += records.length;
	}

	digest(): string {
		return this.hasher.digest("hex");
	}

	/** Rename into place; the `.part` never survives a success. */
	commit(): void {
		renameSync(this.part, join(this.dir, this.name));
	}

	discard(): void {
		rmSync(this.part, { force: true });
	}
}

/** The leaf of one archived event in its first-ingest hour. */
interface ArchivedLeaf {
	event_id: string;
	ingested_at: number;
	hash: string;
}

/** Roots per first-ingest hour over `(ingested_at, event_id)`-ordered leaves; throws naming the hour when a leaf is not a hash. */
function hourlyRootsOf(leaves: readonly ArchivedLeaf[]): Record<string, string> {
	const byHour = new Map<number, ArchivedLeaf[]>();
	for (const leaf of leaves) {
		const hour = hourStart(leaf.ingested_at);
		const bucket = byHour.get(hour);
		if (bucket) bucket.push(leaf);
		else byHour.set(hour, [leaf]);
	}
	const roots: Record<string, string> = {};
	for (const hour of [...byHour.keys()].sort((a, b) => a - b)) {
		const members = (byHour.get(hour) ?? []).sort(
			(a, b) => a.ingested_at - b.ingested_at || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0),
		);
		try {
			roots[hourIso(hour)] = merkleRootHex(members.map((member) => member.hash));
		} catch (cause) {
			throw new Error(`hour ${hourIso(hour)}: ${String(cause instanceof Error ? cause.message : cause)}`);
		}
	}
	return roots;
}

/**
 * Archive one closed day. Refuses — before creating or writing anything — a
 * day that is not closed, an output directory the path gates reject
 * ({@link refusedOutDir}), one that is not on a dedicated filesystem
 * ({@link refusedMount}: the root disk or the release root's, told by
 * `st_dev` of the nearest existing ancestor so an unmounted volume is caught
 * before `mkdir -p` could build the archive on the root disk), a filesystem
 * with fewer than `minFreeGb` free (`df -Pk` on the same ancestor; unreadable refuses), and a
 * day that already has a manifest. Then pages the window through
 * `exportWindow`, appending each page to the three `.part` files and digesting
 * as it goes, computes the hourly roots over what it wrote, and renames the
 * data files into place before the manifest — so a `manifest-<day>` on disk
 * always names complete files, and a crash leaves only `.part` files, which
 * the next run removes.
 */
export async function archiveWindow(
	greptime: { exportWindow(query: ExportWindowQuery): Promise<ExportPage> },
	options: ArchiveOptions,
): Promise<ArchiveManifest> {
	const now = options.now ?? Date.now;
	const cwd = options.cwd ?? process.cwd();
	const { day, outDir } = options;
	const { from, to } = dayWindow(day);
	if (!isDayClosed(day, now())) throw new ArchiveRefused(`day ${day} is not closed yet (midnight plus ${INGEST_LAG_MS / 1000} s)`);
	const refusal = refusedOutDir(outDir, { cwd });
	if (refusal !== null) throw new ArchiveRefused(refusal);
	const df = options.df ?? dfRunner;
	const mount = refusedMount(outDir, { cwd, dev: options.dev, allowRootfs: options.allowRootfs });
	if (mount !== null) throw new ArchiveRefused(mount);
	const minFreeGb = options.minFreeGb ?? DEFAULT_MIN_FREE_GB;
	if (minFreeGb > 0) {
		// Asked of the nearest existing ancestor, like the mount gate: the directory is not created until every gate has passed.
		const freeKb = freeKbOf(df(existingAncestor(realish(resolve(cwd, outDir)))));
		if (freeKb === null) throw new ArchiveRefused(`cannot read free space on ${outDir}; refusing without the floor proof`);
		const floorKb = minFreeGb * 1024 * 1024;
		if (freeKb < floorKb) {
			throw new ArchiveRefused(
				`refusing to archive: ${Math.floor(freeKb / 1024 / 1024)} GB free on ${outDir} is below SUBSTRATE_DEPLOY_MIN_FREE_GB=${minFreeGb}; see docs/runbooks/disk-pressure.md`,
			);
		}
	}
	mkdirSync(outDir, { recursive: true });
	const files = archiveFiles(day);
	if (existsSync(join(outDir, files.manifest))) throw new ArchiveRefused(`day ${day} is already archived in ${outDir} (${files.manifest} exists)`);

	const events = new PartFile(outDir, files.events);
	const ingest = new PartFile(outDir, files.ingest);
	const anchors = new PartFile(outDir, files.anchors);

	const leaves: ArchivedLeaf[] = [];
	let first: ExportCursor | null = null;
	let last: ExportCursor | null = null;
	let chainTip: string | null = null;
	let anchorCount = 0;
	let ingestMissing = 0;
	try {
		let after: ExportCursor | undefined;
		let firstPage = true;
		for (;;) {
			const page = await greptime.exportWindow({ from, to, after, limit: options.pageSize ?? DEFAULT_PAGE_SIZE });
			const parsed: SubstrateEvent[] = page.events.map(rowToEvent);
			const hashes = new Map<string, string>();
			for (const event of parsed) {
				hashes.set(event.id, event.hash);
				const at = { ts: event.ts, id: event.id };
				first ??= at;
				last = at;
				chainTip = event.hash;
			}
			events.append(parsed);
			const rows = page.ingest.filter((row) => hashes.has(row.event_id));
			for (const row of rows) {
				leaves.push({ event_id: row.event_id, ingested_at: Date.parse(row.ingested_at), hash: hashes.get(row.event_id) ?? "" });
			}
			ingest.append(rows);
			ingestMissing += parsed.length - rows.length;
			if (firstPage) {
				anchors.append(page.anchors);
				anchorCount = page.anchors.length;
				firstPage = false;
			}
			if (page.next === null) break;
			if (after !== undefined && after.ts === page.next.ts && after.id === page.next.id) {
				throw new Error(`export cursor did not advance past ${after.ts}/${after.id}`);
			}
			after = page.next;
		}
		const manifest: ArchiveManifest = {
			day,
			counts: { events: events.lines, ingest: ingest.lines, ingestMissing, anchors: anchorCount },
			first,
			last,
			chainTip,
			hourlyRoots: hourlyRootsOf(leaves),
			sha256: { [files.events]: events.digest(), [files.ingest]: ingest.digest(), [files.anchors]: anchors.digest() },
			writtenAt: new Date(now()).toISOString(),
			...(options.releaseSha !== undefined ? { releaseSha: options.releaseSha } : {}),
		};
		events.commit();
		ingest.commit();
		anchors.commit();
		const manifestPart = join(outDir, `${files.manifest}.part`);
		writeFileSync(manifestPart, `${JSON.stringify(manifest, null, "\t")}\n`);
		renameSync(manifestPart, join(outDir, files.manifest));
		return manifest;
	} catch (cause) {
		events.discard();
		ingest.discard();
		anchors.discard();
		throw cause;
	}
}

/** One thing `verifyArchive` found wrong; `kind` is closed so a caller can act on it. */
export interface VerifyMismatch {
	kind: "missing" | "manifest" | "sha256" | "count" | "parse" | "hash" | "chain" | "root" | "anchor";
	file?: string;
	event?: string;
	hour?: string;
	detail: string;
}

/** The offline verdict on one day's archive. `ok` is `mismatches.length === 0`; partial and unanchored hours are reported, never failures. */
export interface VerifyReport {
	ok: boolean;
	day: string;
	dir: string;
	counts: { events: number; ingest: number; anchors: number };
	hours: {
		/** Hours whose receipt names the same member count and the recomputed root equals it. */
		verified: number;
		/** Hours with a receipt whose member count differs: part of the hour is in another day's archive. */
		partial: number;
		/** Hours in the archive with no receipt. */
		unanchored: number;
		/** Hours whose receipt names the same count and a different root. */
		mismatched: number;
	};
	mismatches: VerifyMismatch[];
}

/** The non-empty lines of an NDJSON file, each parsed, with the line number of anything that does not parse. */
function readNdjson(path: string): { records: unknown[]; bad: number[] } {
	const records: unknown[] = [];
	const bad: number[] = [];
	const lines = readFileSync(path, "utf8").split("\n");
	lines.forEach((line, index) => {
		if (line.trim() === "") return;
		try {
			records.push(JSON.parse(line));
		} catch {
			bad.push(index + 1);
		}
	});
	return { records, bad };
}

// The archive's file shapes, parsed once at the boundary. Loose where verify
// recomputes anyway (a wrong count is a `count` finding, not a parse failure)
// and strict only on the fields the checks below read.
const CursorSchema = z.object({ ts: z.string(), id: z.string() });
const ManifestSchema = z.object({
	day: z.string(),
	counts: z.object({
		events: z.number(),
		ingest: z.number(),
		ingestMissing: z.number(),
		anchors: z.number(),
	}),
	first: CursorSchema.nullable(),
	last: CursorSchema.nullable(),
	chainTip: z.string().nullable(),
	hourlyRoots: z.record(z.string(), z.string()),
	sha256: z.record(z.string(), z.string()),
	writtenAt: z.string(),
	releaseSha: z.string().optional(),
});
/** An event line: `id` and `hash` are what the checks key on; the rest is whatever was hashed. */
const EventLineSchema = z.looseObject({ id: z.string(), hash: z.string(), session_id: z.string().nullable(), prev: z.string().nullable(), ts: z.string() });
const IngestLineSchema = z.object({ event_id: z.string(), ingested_at: z.string(), event_ts: z.string() });
/** A receipt line: only the period, root and count are compared; the signature fields ride along. */
const AnchorLineSchema = z.looseObject({ period_start: z.string(), root: z.string(), event_count: z.number() });

/**
 * Check one day's archive from its files alone. Never throws on a finding:
 * every disagreement is a {@link VerifyMismatch} and the report says which.
 *
 * In order: the manifest parses and names this day; every data file exists
 * and its SHA-256 equals the manifest's; line counts equal the manifest's
 * counts; every event line parses and its `hash` equals `eventHash` of the
 * rest (the same recomputation `substrate verify` makes); within each session
 * no two events claim the same `prev` (a fork) — counted for every non-null
 * `prev`, including one naming an event outside the archive: that is a chain
 * continuing from another day and is fine once, but two claimants of it are
 * still a fork;
 * the last event's hash equals `chainTip`; the hourly roots recomputed from
 * the ingest file equal the manifest's, hour for hour; and each hour with a
 * receipt in the anchors file either matches it (`verified`), holds fewer
 * members than the receipt counts (`partial` — the rest are in another day)
 * or disagrees on the root at equal count (`mismatched`, a finding).
 */
export function verifyArchive(dir: string, day: string): VerifyReport {
	const files = archiveFiles(day);
	const mismatches: VerifyMismatch[] = [];
	const report: VerifyReport = {
		ok: false,
		day,
		dir,
		counts: { events: 0, ingest: 0, anchors: 0 },
		hours: { verified: 0, partial: 0, unanchored: 0, mismatched: 0 },
		mismatches,
	};
	const finish = (): VerifyReport => {
		report.ok = mismatches.length === 0;
		return report;
	};

	const manifestPath = join(dir, files.manifest);
	if (!existsSync(manifestPath)) {
		mismatches.push({ kind: "missing", file: files.manifest, detail: `no ${files.manifest} in ${dir}` });
		return finish();
	}
	let manifest: z.infer<typeof ManifestSchema> | null = null;
	try {
		const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
		manifest = parsed.success ? parsed.data : null;
	} catch {
		manifest = null;
	}
	if (manifest === null) {
		mismatches.push({ kind: "manifest", file: files.manifest, detail: "manifest does not parse as an archive manifest" });
		return finish();
	}
	if (manifest.day !== day) mismatches.push({ kind: "manifest", file: files.manifest, detail: `manifest names day ${manifest.day}, not ${day}` });

	for (const name of [files.events, files.ingest, files.anchors]) {
		const path = join(dir, name);
		if (!existsSync(path)) {
			mismatches.push({ kind: "missing", file: name, detail: `${name} is missing` });
			continue;
		}
		const actual = new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
		const expected = manifest.sha256[name];
		if (expected === undefined) mismatches.push({ kind: "sha256", file: name, detail: `manifest carries no sha256 for ${name}` });
		else if (expected !== actual) mismatches.push({ kind: "sha256", file: name, detail: `sha256 ${actual} differs from manifest ${expected}` });
	}
	if (mismatches.some((m) => m.kind === "missing")) return finish();

	const eventsRead = readNdjson(join(dir, files.events));
	const ingestRead = readNdjson(join(dir, files.ingest));
	const anchorsRead = readNdjson(join(dir, files.anchors));
	for (const [name, read] of [
		[files.events, eventsRead],
		[files.ingest, ingestRead],
		[files.anchors, anchorsRead],
	] as const) {
		for (const line of read.bad) mismatches.push({ kind: "parse", file: name, detail: `line ${line} is not JSON` });
	}
	report.counts = { events: eventsRead.records.length + eventsRead.bad.length, ingest: ingestRead.records.length + ingestRead.bad.length, anchors: anchorsRead.records.length + anchorsRead.bad.length };
	const countOf = (name: string, expected: number, actual: number): void => {
		if (expected !== actual) mismatches.push({ kind: "count", file: name, detail: `${actual} lines, manifest counts ${expected}` });
	};
	countOf(files.events, manifest.counts.events, report.counts.events);
	countOf(files.ingest, manifest.counts.ingest, report.counts.ingest);
	countOf(files.anchors, manifest.counts.anchors, report.counts.anchors);

	// Hashes: each line is the hashed shape, so `eventHash` over everything but `hash` must give `hash`.
	const events: Array<z.infer<typeof EventLineSchema>> = [];
	const hashes = new Map<string, string>();
	eventsRead.records.forEach((record, index) => {
		const line = EventLineSchema.safeParse(record);
		if (!line.success) {
			mismatches.push({ kind: "parse", file: files.events, detail: `record ${index + 1} is not an event` });
			return;
		}
		const { hash, ...rest } = line.data;
		// The line was written from a `SubstrateEvent` and `eventHash` canonicalises
		// keys, so the parsed object minus `hash` is the shape that was hashed.
		const recomputed = eventHash(rest as unknown as Omit<SubstrateEvent, "hash">);
		if (recomputed !== hash) mismatches.push({ kind: "hash", event: line.data.id, detail: `hash ${hash} does not match contents (${recomputed})` });
		if (hashes.has(line.data.id)) mismatches.push({ kind: "chain", event: line.data.id, detail: "event id appears twice" });
		hashes.set(line.data.id, hash);
		events.push(line.data);
	});

	// Chain: within a session a hash is claimed as `prev` by at most one event,
	// whether or not the claimed hash is in this archive. A `prev` naming a hash
	// outside the window is the chain continuing from an earlier day — allowed —
	// but two events naming it are still a fork, and the only way to see that
	// fork from this day's files is to count every claim.
	const bySession = new Map<string, Array<z.infer<typeof EventLineSchema>>>();
	for (const event of events) {
		const key = event.session_id ?? "";
		const bucket = bySession.get(key);
		if (bucket) bucket.push(event);
		else bySession.set(key, [event]);
	}
	for (const [session, members] of bySession) {
		const claimed = new Map<string, string>();
		for (const event of members) {
			if (event.prev === null) continue;
			const earlier = claimed.get(event.prev);
			if (earlier !== undefined) {
				mismatches.push({
					kind: "chain",
					event: event.id,
					detail: `session ${session || "(none)"}: prev ${event.prev.slice(0, 12)}… is also claimed by ${earlier} (fork)`,
				});
			} else {
				claimed.set(event.prev, event.id);
			}
		}
	}
	const tip = events.length > 0 ? (events[events.length - 1]?.hash ?? null) : null;
	if (tip !== manifest.chainTip) mismatches.push({ kind: "chain", detail: `chain tip ${tip ?? "none"} differs from manifest ${manifest.chainTip ?? "none"}` });
	const firstEvent = events[0];
	const lastEvent = events[events.length - 1];
	const sameCursor = (a: ExportCursor | null, b: { ts: string; id: string } | undefined): boolean =>
		(a === null && b === undefined) || (a !== null && b !== undefined && a.ts === b.ts && a.id === b.id);
	if (!sameCursor(manifest.first, firstEvent)) mismatches.push({ kind: "manifest", detail: "manifest.first is not the first event in the file" });
	if (!sameCursor(manifest.last, lastEvent)) mismatches.push({ kind: "manifest", detail: "manifest.last is not the last event in the file" });

	// Roots: leaves from the ingest file, hashes from the events file.
	const leaves: ArchivedLeaf[] = [];
	ingestRead.records.forEach((record, index) => {
		const line = IngestLineSchema.safeParse(record);
		if (!line.success) {
			mismatches.push({ kind: "parse", file: files.ingest, detail: `record ${index + 1} is not an ingest row` });
			return;
		}
		const hash = hashes.get(line.data.event_id);
		const ingestedAt = Date.parse(line.data.ingested_at);
		if (hash === undefined) {
			mismatches.push({ kind: "missing", file: files.ingest, event: line.data.event_id, detail: "ingest row names an event not in the events file" });
			return;
		}
		if (!Number.isFinite(ingestedAt)) {
			mismatches.push({ kind: "parse", file: files.ingest, event: line.data.event_id, detail: "ingested_at is not an instant" });
			return;
		}
		leaves.push({ event_id: line.data.event_id, ingested_at: ingestedAt, hash });
	});
	let roots: Record<string, string> = {};
	try {
		roots = hourlyRootsOf(leaves);
	} catch (cause) {
		mismatches.push({ kind: "root", detail: `cannot recompute roots: ${String(cause instanceof Error ? cause.message : cause)}` });
	}
	const hoursSeen = new Set([...Object.keys(roots), ...Object.keys(manifest.hourlyRoots)]);
	for (const hour of [...hoursSeen].sort()) {
		const recomputed = roots[hour];
		const recorded = manifest.hourlyRoots[hour];
		if (recomputed === undefined) mismatches.push({ kind: "root", hour, detail: "manifest names an hour the files hold no members for" });
		else if (recorded === undefined) mismatches.push({ kind: "root", hour, detail: "the files hold members for an hour the manifest has no root for" });
		else if (recomputed !== recorded) mismatches.push({ kind: "root", hour, detail: `recomputed ${recomputed} differs from manifest ${recorded}` });
	}

	// Receipts: the anchors file against the recomputed roots.
	const membersPerHour = new Map<string, number>();
	for (const leaf of leaves) {
		const hour = hourIso(leaf.ingested_at);
		membersPerHour.set(hour, (membersPerHour.get(hour) ?? 0) + 1);
	}
	const receipts = new Map<string, z.infer<typeof AnchorLineSchema>>();
	anchorsRead.records.forEach((record, index) => {
		const line = AnchorLineSchema.safeParse(record);
		if (!line.success) {
			mismatches.push({ kind: "parse", file: files.anchors, detail: `record ${index + 1} is not an anchor row` });
			return;
		}
		const start = Date.parse(line.data.period_start);
		if (!Number.isFinite(start)) {
			mismatches.push({ kind: "parse", file: files.anchors, detail: `record ${index + 1} has a period_start that is not an instant` });
			return;
		}
		receipts.set(hourIso(start), line.data);
	});
	for (const hour of [...new Set([...Object.keys(roots), ...receipts.keys()])].sort()) {
		const receipt = receipts.get(hour);
		const root = roots[hour];
		const members = membersPerHour.get(hour) ?? 0;
		if (receipt === undefined) {
			report.hours.unanchored += 1;
			continue;
		}
		if (receipt.event_count !== members || root === undefined) {
			report.hours.partial += 1;
			continue;
		}
		if (receipt.root === root) report.hours.verified += 1;
		else {
			report.hours.mismatched += 1;
			mismatches.push({ kind: "anchor", hour, detail: `recomputed root ${root} differs from the receipt ${receipt.root} at equal count ${members}` });
		}
	}
	return finish();
}

// ─── The ledger's own record of an archived day ─────────────────────────────

/** What one emit attempt answers; the shape `Substrate.emit` already has, narrowed to what the marker needs. */
export interface NoteOutcome {
	stored: boolean;
	error?: string;
}

/**
 * The `note` that records one archived day in the ledger: counts, cursors,
 * chain tip and file digests — no bodies and no path. It is what `coverage`
 * and `/healthz.jobs.ledger.lastArchiveDay` read back, so an archive the
 * ledger does not know about is, to every monitor, an archive that did not
 * happen. Deterministic from the manifest, so a retried note carries exactly
 * what the first attempt would have.
 */
export function archiveNote(manifest: ArchiveManifest): EventInput {
	return {
		surface: "substrate",
		kind: "note",
		summary: `${ARCHIVE_NOTE_PREFIX}${manifest.day}: ${manifest.counts.events} events, ${manifest.counts.ingest} ingest rows, ${manifest.counts.anchors} receipts`,
		session_id: `ledger-archive:${manifest.day}`,
		payload: {
			action: "ledger.archive",
			runtime: "ledger-archive",
			day: manifest.day,
			counts: manifest.counts,
			first: manifest.first,
			last: manifest.last,
			chainTip: manifest.chainTip,
			hours: Object.keys(manifest.hourlyRoots).length,
			sha256: manifest.sha256,
			...(manifest.releaseSha !== undefined ? { releaseSha: manifest.releaseSha } : {}),
		},
	};
}

/** The marker a day keeps beside its manifest from before its note is first sent until the ledger has taken it. */
export interface PendingNote {
	day: string;
	note: EventInput;
	/** Sends the ledger has refused or that threw; `0` while the first is still in flight. */
	attempts: number;
	lastError: string | null;
	firstAttemptAt: string;
}

const PendingNoteSchema = z.object({
	day: z.string(),
	note: z.looseObject({ surface: z.string(), kind: z.string(), summary: z.string() }),
	attempts: z.number(),
	lastError: z.string().nullable(),
	firstAttemptAt: z.string(),
});

/** `note-pending-<day>.json`: present exactly while the day's files exist and its note does not. */
export function pendingNoteFile(day: string): string {
	return `note-pending-${day}.json`;
}

/** Days with a pending-note marker in `dir`, ascending; an unreadable dir is empty. */
export function pendingNoteDays(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const days: string[] = [];
	for (const name of names) {
		const day = /^note-pending-(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1];
		if (day !== undefined && isDay(day)) days.push(day);
	}
	return days.sort();
}

/** The error text of a failed emit, redacted and short: it is written to a marker on disk. */
function noteErrorOf(cause: unknown): string {
	return redact(String(cause instanceof Error ? cause.message : cause)).slice(0, 300);
}

/**
 * One emit attempt as an outcome, never a throw: `Substrate.emit` throws on
 * an input it refuses, and one bad note must be a pending day, not the end
 * of the run that would have archived every later one.
 */
async function sendNote(emit: (input: EventInput) => Promise<NoteOutcome>, note: EventInput): Promise<NoteOutcome> {
	try {
		return await emit(note);
	} catch (cause) {
		return { stored: false, error: noteErrorOf(cause) };
	}
}

/** Write the day's marker atomically, like the data files. */
function writePendingNote(dir: string, pending: PendingNote): void {
	const marker = join(dir, pendingNoteFile(pending.day));
	writeFileSync(`${marker}.part`, `${JSON.stringify(pending, null, "\t")}\n`);
	renameSync(`${marker}.part`, marker);
}

/**
 * Send one day's note, with the marker in place for the whole attempt. The
 * archive files are already in place and the manifest means "do not export
 * this day again", so the note is the one thing no later run could redo
 * unless something remembers it is owed. The marker is therefore written
 * *before* the emit and removed only once the ledger reports it stored: an
 * emit that throws, a process killed between the manifest rename and the
 * answer, and a refused note all leave the marker for the next run. Written
 * atomically like the data files. Returns the outcome (a throw is a
 * `stored: false` with the redacted message).
 */
export async function recordArchiveNote(
	dir: string,
	manifest: ArchiveManifest,
	emit: (input: EventInput) => Promise<NoteOutcome>,
	now: () => number = Date.now,
): Promise<NoteOutcome> {
	const note = archiveNote(manifest);
	const previous = readPendingNote(dir, manifest.day);
	const pending: PendingNote = {
		day: manifest.day,
		note,
		attempts: previous?.attempts ?? 0,
		lastError: previous?.lastError ?? null,
		firstAttemptAt: previous?.firstAttemptAt ?? new Date(now()).toISOString(),
	};
	writePendingNote(dir, pending);
	const outcome = await sendNote(emit, note);
	if (outcome.stored) {
		rmSync(join(dir, pendingNoteFile(manifest.day)), { force: true });
		return outcome;
	}
	writePendingNote(dir, { ...pending, attempts: pending.attempts + 1, lastError: outcome.error ?? null });
	return outcome;
}

/** The day's marker, or `null` when there is none or it does not parse (a corrupt marker is rewritten on the next failure). */
export function readPendingNote(dir: string, day: string): PendingNote | null {
	const path = join(dir, pendingNoteFile(day));
	if (!existsSync(path)) return null;
	try {
		const parsed = PendingNoteSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
		// The marker was written from an `EventInput`; the schema checks the three fields every event has.
		return parsed.success ? { ...parsed.data, note: parsed.data.note as unknown as EventInput } : null;
	} catch {
		return null;
	}
}

/**
 * Send every pending note in `dir` again, oldest day first, clearing each
 * marker the ledger takes and updating the rest. Runs at the start of every
 * archive run so a day whose note was refused yesterday is recorded today
 * without the operator doing anything. An emit that throws — a marker that
 * parses but holds a note the ledger will not take — counts that day as
 * pending and the loop goes on, so one bad marker cannot stop the run before
 * it archives anything new. What it returns is the days still pending, which
 * the runner turns into exit 1: the files are safe, but the ledger's record
 * is incomplete and a monitor should know.
 */
export async function retryPendingNotes(
	dir: string,
	emit: (input: EventInput) => Promise<NoteOutcome>,
): Promise<{ sent: string[]; pending: Array<{ day: string; attempts: number; lastError: string | null }> }> {
	const sent: string[] = [];
	const pending: Array<{ day: string; attempts: number; lastError: string | null }> = [];
	for (const day of pendingNoteDays(dir)) {
		const previous = readPendingNote(dir, day);
		if (previous === null) {
			// Unreadable marker: nothing to resend from it. Leave it for the operator; it still counts as pending.
			pending.push({ day, attempts: 0, lastError: "marker does not parse" });
			continue;
		}
		const outcome = await sendNote(emit, previous.note);
		if (outcome.stored) {
			rmSync(join(dir, pendingNoteFile(day)), { force: true });
			sent.push(day);
			continue;
		}
		const updated: PendingNote = { ...previous, attempts: previous.attempts + 1, lastError: outcome.error ?? null };
		writePendingNote(dir, updated);
		pending.push({ day, attempts: updated.attempts, lastError: updated.lastError });
	}
	return { sent, pending };
}

// ─── The runner's argument grammar and report text ──────────────────────────

/** A flag the runner refuses; exit 2 with usage. */
export class LedgerUsageError extends Error {}

export type LedgerCommand =
	| { command: "coverage"; json: boolean }
	| { command: "archive"; until?: string; out?: string; pageSize?: number; json: boolean }
	| { command: "verify-archive"; dir: string; day?: string; json: boolean };

export const LEDGER_USAGE =
	"usage: ledger-run.ts coverage [--json]\n" +
	"       ledger-run.ts archive [--until YYYY-MM-DD] [--out DIR] [--page-size N] [--json]\n" +
	"       ledger-run.ts verify-archive <dir> [--day YYYY-MM-DD] [--json]\n" +
	"  --until defaults to yesterday (UTC); --out to SUBSTRATE_LEDGER_ARCHIVE_DIR.\n" +
	"  coverage exits 2 above SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS; verify-archive exits 2 on any mismatch.\n";

/**
 * The runner's argv as a command. Every value is checked here so the runner
 * can refuse with usage before it opens a config or a directory: a day must be
 * a UTC day, a page size a positive integer, and `--out` an empty string is
 * the systemd expansion of an unset `SUBSTRATE_LEDGER_ARCHIVE_DIR`, refused
 * by name.
 */
export function parseLedgerArgs(argv: readonly string[]): LedgerCommand {
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
		if (key === "json") {
			flags.json = true;
			continue;
		}
		if (next === undefined || next.startsWith("--")) {
			flags[key] = true;
			continue;
		}
		flags[key] = next;
		i++;
	}
	const known = (keys: string[]): void => {
		for (const key of Object.keys(flags)) {
			if (!keys.includes(key)) throw new LedgerUsageError(`unknown flag --${key}`);
		}
	};
	const day = (key: string): string | undefined => {
		const value = flags[key];
		if (value === undefined) return undefined;
		if (value === true || !isDay(value)) throw new LedgerUsageError(`--${key} needs a UTC day (YYYY-MM-DD)`);
		return value;
	};
	const json = flags.json === true;
	switch (command) {
		case "coverage":
			known(["json"]);
			if (positional.length > 0) throw new LedgerUsageError(`unexpected argument ${positional[0]}`);
			return { command, json };
		case "archive": {
			known(["json", "until", "out", "page-size"]);
			if (positional.length > 0) throw new LedgerUsageError(`unexpected argument ${positional[0]}`);
			const out = flags.out;
			if (out === true || out === "") throw new LedgerUsageError("--out needs a directory (is SUBSTRATE_LEDGER_ARCHIVE_DIR unset?)");
			let pageSize: number | undefined;
			if (flags["page-size"] !== undefined) {
				const raw = flags["page-size"];
				if (raw === true || !/^\d+$/.test(raw) || Number(raw) < 1) throw new LedgerUsageError("--page-size needs a positive integer");
				pageSize = Number(raw);
			}
			return { command, until: day("until"), out, pageSize, json };
		}
		case "verify-archive": {
			known(["json", "day"]);
			const dir = positional[0];
			if (dir === undefined || dir === "" || positional.length > 1) throw new LedgerUsageError("verify-archive needs exactly one directory");
			return { command, dir, day: day("day"), json };
		}
		default:
			throw new LedgerUsageError(command === undefined ? "a subcommand is required" : `unknown subcommand ${command}`);
	}
}

/** `substrate ledger coverage` as text: one line per fact, the uncovered hours listed, the archive window last. */
export function formatCoverage(coverage: AnchorCoverage, maxUncoveredHours: number): string {
	const lines = [
		`ledger coverage`,
		`  newest anchored hour  ${coverage.newestAnchoredHour ?? "none"}`,
		`  anchor lag            ${coverage.lagHours === null ? "n/a" : `${coverage.lagHours} h`}`,
		`  uncovered hours       ${coverage.uncoveredHours.length}${coverage.more ? "+" : ""} (limit ${maxUncoveredHours})`,
	];
	for (const hour of coverage.uncoveredHours) lines.push(`    ${hour}`);
	lines.push(
		`  last archive          ${coverage.lastArchiveWindow ? `${coverage.lastArchiveWindow.day} (written ${coverage.lastArchiveWindow.writtenAt})` : "none recorded"}`,
	);
	return `${lines.join("\n")}\n`;
}

/** One archived day as a line: counts, the window and the hours it rooted. */
export function formatManifest(manifest: ArchiveManifest): string {
	const hours = Object.keys(manifest.hourlyRoots).length;
	return `archived ${manifest.day}: ${manifest.counts.events} events, ${manifest.counts.ingest} ingest rows (${manifest.counts.ingestMissing} without), ${manifest.counts.anchors} receipts, ${hours} hours rooted\n`;
}

/**
 * One sentence per mismatch kind, fixed: the text an operator greps the journal
 * for, and what `ledger-archive.test.ts` pins. `detail` carries the specifics
 * (the hash, the hour, the counts) after it.
 */
export const MISMATCH_SENTENCE: Record<VerifyMismatch["kind"], string> = {
	missing: "a file the archive needs is missing",
	manifest: "the manifest does not describe these files",
	sha256: "a file's digest differs from the manifest",
	count: "a file's line count differs from the manifest",
	parse: "a line does not parse",
	hash: "an event's hash does not match its contents",
	chain: "the chain does not link",
	root: "an hourly root differs from the manifest",
	anchor: "an hourly root differs from its receipt",
};

/** A verify report as text: the verdict, the hour tallies, then one line per mismatch — `<kind> <sentence> (<where>): <detail>`. */
export function formatVerifyReport(report: VerifyReport): string {
	const lines = [
		`verify ${report.day} in ${report.dir}: ${report.ok ? "ok" : `${report.mismatches.length} mismatch${report.mismatches.length === 1 ? "" : "es"}`}`,
		`  events ${report.counts.events}, ingest ${report.counts.ingest}, receipts ${report.counts.anchors}`,
		`  hours verified ${report.hours.verified}, partial ${report.hours.partial}, unanchored ${report.hours.unanchored}, mismatched ${report.hours.mismatched}`,
	];
	for (const m of report.mismatches) {
		const where = [m.file, m.hour, m.event].filter((part): part is string => part !== undefined).join(" ");
		lines.push(`  ${m.kind.padEnd(8)} ${MISMATCH_SENTENCE[m.kind]}${where ? ` (${where})` : ""}: ${m.detail}`);
	}
	return `${lines.join("\n")}\n`;
}
