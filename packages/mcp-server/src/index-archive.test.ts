/**
 * The index archive without a database (uplift-4 S2): the export, the manifest,
 * the offline verifier and its closed vocabulary, the path and disk gates, the
 * secret-handling rule, the note marker, the restore refusals and a restore into
 * an in-memory target. The roundtrip against a real Postgres is
 * `index-store.archive.test.ts` (skipped without `SUBSTRATE_TEST_PG_URL`).
 *
 * Every filesystem path is a scratch directory; the mount and disk gates take
 * injected `st_dev` and `df` readings, so nothing here reads a host secret or a
 * real mount.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ARCHIVE_TABLES,
	exportedColumns,
	rowKey,
	schemaHash,
	tableSpec,
	type ArchiveColumn,
	type ArchiveRow,
	type ArchiveTableSpec,
} from "./index-archive-spec.ts";
import {
	ArchiveRefused,
	INDEX_MISMATCH_KINDS,
	INDEX_MISMATCH_SENTENCE,
	IndexArchiveFailed,
	IndexUsageError,
	RestoreMismatch,
	RestoreRefused,
	archiveIndex,
	formatIndexVerifyReport,
	indexArchiveNote,
	normalizePgUrl,
	parseIndexArgs,
	pendingIndexNoteFile,
	pendingIndexNotes,
	readPendingIndexNote,
	recordIndexArchiveNote,
	refusedScratchUrl,
	restoreIndexArchive,
	retryPendingIndexNotes,
	sweepStaleSnapshots,
	verifyIndexArchive,
	type IndexArchiveManifest,
	type IndexArchiveOptions,
	type IndexArchiveSource,
	LineTally,
	TALLY_EXAMPLES,
	type RestoreTarget,
} from "./index-archive.ts";
import type { IndexRestoreTx, IndexSnapshotReader } from "./index-store.ts";
import { loadIndexArchiveSettings, DEFAULT_INDEX_ARCHIVE_SETTINGS } from "./config.ts";
import type { EventInput } from "./types.ts";

const NOW = Date.parse("2026-10-14T03:15:00.000Z");
const SECRET_TEXT = "alice@example.test +1 555 0100 national-id 000-00-0000";

/** `/` is device 1, the release root 3, everything else a dedicated mount, 2. */
const dedicatedMount = (path: string): number => (path === "/" ? 1 : path === "/opt/agent-substrate" ? 3 : 2);
const DF_ROOMY = (): string => "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 999999999 1 999999999 1% /mnt\n";

/** One value for a column, a function of the row index alone: zero-padded, so key order is index order. */
function cell(column: ArchiveColumn, i: number): string | number | boolean | null {
	const pad = String(i).padStart(7, "0");
	if (column.type === "text") return column.name === "entry_hash" ? `hash-${pad}` : `${column.name}-${pad}`;
	if (column.type === "int") return i;
	if (column.type === "bigint") return String(i);
	if (column.type === "jsonb") return `{"i":${i}}`;
	if (column.type === "bool") return i % 2 === 0;
	return `2026-10-14T00:00:00.${String(i % 1_000_000).padStart(6, "0")}Z`;
}

function rowAt(spec: ArchiveTableSpec, i: number): ArchiveRow {
	const row: ArchiveRow = {};
	for (const column of exportedColumns(spec)) row[column.name] = cell(column, i);
	return row;
}

function counts(each = 3): Record<string, number> {
	return Object.fromEntries(ARCHIVE_TABLES.map((spec) => [spec.name, each]));
}

/** A source that makes rows on demand and records how it was read: pages asked for, the most rows any page carried. */
class StubSource implements IndexArchiveSource {
	pageCalls = 0;
	maxPageRows = 0;
	snapshots = 0;

	constructor(
		readonly sizes: Record<string, number>,
		readonly hooks: { onPage?: (table: string) => void; decorate?: (table: string, row: ArchiveRow) => ArchiveRow } = {},
	) {}

	async withExportSnapshot<T>(work: (reader: IndexSnapshotReader) => Promise<T>): Promise<T> {
		this.snapshots++;
		const served = new Map<string, number>();
		const reader: IndexSnapshotReader = {
			serverVersion: async () => "16.4",
			count: async (table) => this.sizes[table] ?? 0,
			page: async (table, after, limit) => {
				this.pageCalls++;
				this.hooks.onPage?.(table);
				const spec = tableSpec(table);
				const at = served.get(table) ?? 0;
				// The archiver continues exactly after the last row it was handed.
				if (after === null) expect(at).toBe(0);
				else expect(after).toEqual(rowKey(spec, rowAt(spec, at - 1)));
				const n = Math.max(0, Math.min(limit, (this.sizes[table] ?? 0) - at));
				this.maxPageRows = Math.max(this.maxPageRows, n);
				served.set(table, at + n);
				return Array.from({ length: n }, (_, k) => {
					const row = rowAt(spec, at + k);
					return this.hooks.decorate ? this.hooks.decorate(table, row) : row;
				});
			},
		};
		return work(reader);
	}
}

let out: string;
let cwd: string;

beforeEach(() => {
	out = mkdtempSync(join(tmpdir(), "index-archive-out-"));
	cwd = mkdtempSync(join(tmpdir(), "index-archive-cwd-"));
});
afterEach(() => {
	rmSync(out, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

function options(extra: Partial<IndexArchiveOptions> = {}): IndexArchiveOptions {
	return { outDir: out, cwd, dev: dedicatedMount, df: DF_ROOMY, minFreeGb: 5, now: () => NOW, ...extra };
}

async function archived(sizes: Record<string, number> = counts()): Promise<{ manifest: IndexArchiveManifest; dir: string }> {
	const manifest = await archiveIndex(new StubSource(sizes), options());
	return { manifest, dir: join(out, manifest.snapshot) };
}

const kindsOf = (dir: string): string[] => verifyIndexArchive(dir).mismatches.map((m) => m.kind);

/** The message a promise rejects with; the test fails when it resolves. */
async function messageOf(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (cause) {
		return String((cause as Error).message);
	}
	throw new Error("expected a rejection");
}

describe("archiveIndex", () => {
	test("writes one NDJSON file per whitelisted table and the manifest last", async () => {
		const { manifest, dir } = await archived();
		expect(manifest.snapshot).toBe("index-20261014T031500Z");
		expect(manifest.schemaHash).toBe(schemaHash());
		expect(manifest.serverVersion).toBe("16.4");
		expect(Object.keys(manifest.tables)).toEqual(ARCHIVE_TABLES.map((spec) => spec.name));
		expect(readdirSync(dir).sort()).toEqual(["manifest.json", ...ARCHIVE_TABLES.map((spec) => `${spec.name}.ndjson`)].sort());
		for (const spec of ARCHIVE_TABLES) {
			const file = join(dir, `${spec.name}.ndjson`);
			const entry = manifest.tables[spec.name];
			expect(entry?.rows).toBe(3);
			expect(entry?.bytes).toBe(statSync(file).size);
			expect(entry?.sha256).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex"));
			expect(entry?.entryHashDigest !== undefined).toBe(spec.hasEntryHash);
			// The line is the row, in column order, one per line.
			expect(readFileSync(file, "utf8").split("\n")[0]).toBe(JSON.stringify(rowAt(spec, 0)));
		}
		expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))).toEqual(manifest);
	});

	test("a failure after the first table leaves neither .part files nor a directory", async () => {
		const source = new StubSource(counts(), {
			onPage: (table) => {
				if (table === "memory_entries") throw new Error("boom");
			},
		});
		await expect(archiveIndex(source, options())).rejects.toThrow("boom");
		expect(readdirSync(out)).toEqual([]);
	});

	test("a failure after the data files were renamed into place (the manifest cannot be written) leaves no data files and no directory", async () => {
		const source = new StubSource(counts(), {
			onPage: (table) => {
				// The last table's page: every earlier table is exported, and the manifest's temp path is about to be needed.
				if (table === "memory_reviews") mkdirSync(join(out, readdirSync(out).find((name) => name.startsWith("index-")) ?? "", "manifest.json.part"));
			},
		});
		await expect(archiveIndex(source, options())).rejects.toThrow();
		expect(readdirSync(out)).toEqual([]);
	});

	test("a killed earlier run's manifest-less directory is swept by the next run and reported; nothing else is touched", async () => {
		const make = (name: string, files: Record<string, string>): void => {
			mkdirSync(join(out, name));
			for (const file of Object.keys(files)) writeFileSync(join(out, name, file), files[file] ?? "");
		};
		const stale = "index-20261014T010000Z";
		make(stale, { "graph_index.ndjson": "x\n", "graph_edges.ndjson.part": "", "manifest.json.part": "" });
		const young = "index-20261014T030000Z";
		make(young, { "graph_index.ndjson.part": "" });
		const complete = "index-20261013T010000Z";
		make(complete, { "graph_index.ndjson": "x\n", "manifest.json": "{}" });
		const foreign = "index-20261012T010000Z";
		make(foreign, { "graph_index.ndjson": "x\n", "notes.txt": "mine" });
		make("backup-old", { "graph_index.ndjson": "x\n" });
		writeFileSync(join(out, "index-20261011T010000Z"), "a file, not a directory");
		const target = mkdtempSync(join(tmpdir(), "index-archive-link-"));
		symlinkSync(target, join(out, "index-20261010T010000Z"));
		const swept: string[][] = [];
		await archiveIndex(new StubSource(counts()), options({ onSwept: (names) => swept.push([...names]) }));
		expect(swept).toEqual([[stale]]);
		expect(existsSync(join(out, stale))).toBe(false);
		for (const kept of [young, complete, foreign, "backup-old", "index-20261011T010000Z", "index-20261010T010000Z"]) expect({ kept, there: existsSync(join(out, kept)) }).toEqual({ kept, there: true });
		expect(existsSync(join(target))).toBe(true);
		rmSync(target, { recursive: true, force: true });
	});

	test("sweepStaleSnapshots on a directory that does not exist is empty, and a run with nothing to sweep never calls onSwept", async () => {
		expect(sweepStaleSnapshots(join(out, "nope"), NOW)).toEqual([]);
		let calls = 0;
		await archiveIndex(new StubSource(counts()), options({ onSwept: () => calls++ }));
		expect(calls).toBe(0);
	});

	test("the manifest is the last file written: it is absent until every data file is in place", async () => {
		let manifestSeen: boolean | null = null;
		const source = new StubSource(counts(), {
			onPage: (table) => {
				if (table === "memory_reviews") manifestSeen = readdirSync(out).some((name) => existsSync(join(out, name, "manifest.json")));
			},
		});
		await archiveIndex(source, options());
		expect(manifestSeen === false).toBe(true);
	});

	test("streams: no more than one page of rows at a time, flushed to disk page by page (100k rows)", async () => {
		const sizes = { ...counts(1), graph_edges: 100_000 };
		const seen: number[] = [];
		const part = () => {
			const dir = readdirSync(out).find((name) => name.startsWith("index-"));
			const file = dir === undefined ? null : join(out, dir, "graph_edges.ndjson.part");
			return file !== null && existsSync(file) ? statSync(file).size : 0;
		};
		const source = new StubSource(sizes, { onPage: (table) => table === "graph_edges" && seen.push(part()) });
		const manifest = await archiveIndex(source, options({ pageSize: 500 }));
		expect(manifest.tables.graph_edges?.rows).toBe(100_000);
		expect(source.maxPageRows).toBe(500);
		// 100k rows at 500 a page, plus the closing empty read when the count is a page multiple.
		expect(seen.length).toBe(201);
		// Each request found the previous pages already on disk: the file grew between every read.
		for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1] ?? 0);
	});

	test("refuses a page size outside 1..5000 before creating anything", async () => {
		for (const pageSize of [0, 5001, 1.5]) {
			await expect(archiveIndex(new StubSource(counts()), options({ pageSize }))).rejects.toBeInstanceOf(ArchiveRefused);
		}
		expect(readdirSync(out)).toEqual([]);
	});

	test("gives up past its deadline and leaves nothing behind", async () => {
		let clock = NOW;
		const source = new StubSource(counts(5000), { onPage: () => (clock += 400_000) });
		const failure = archiveIndex(source, options({ now: () => clock, maxSeconds: 900, pageSize: 100 }));
		await expect(failure).rejects.toBeInstanceOf(IndexArchiveFailed);
		await expect(failure).rejects.toThrow("SUBSTRATE_INDEX_ARCHIVE_MAX_SECONDS");
		expect(readdirSync(out)).toEqual([]);
	});

	test("stops at the byte bound and leaves nothing behind", async () => {
		const failure = archiveIndex(new StubSource(counts(500)), options({ maxBytes: 2_000, pageSize: 50 }));
		await expect(failure).rejects.toThrow("SUBSTRATE_INDEX_ARCHIVE_MAX_BYTES");
		expect(readdirSync(out)).toEqual([]);
	});

	test("a count that disagrees with the pages read is a failure, not a quiet short archive", async () => {
		const source = new StubSource(counts());
		const lying: IndexArchiveSource = {
			withExportSnapshot: (work) =>
				source.withExportSnapshot((reader) => work({ ...reader, count: async (table) => (table === "graph_index" ? 9 : (source.sizes[table] ?? 0)) })),
		};
		await expect(archiveIndex(lying, options())).rejects.toThrow("graph_index: exported 3 rows but the snapshot counts 9");
		expect(readdirSync(out)).toEqual([]);
	});

	test("two runs in one second refuse the second instead of overwriting", async () => {
		await archived();
		await expect(archiveIndex(new StubSource(counts()), options())).rejects.toBeInstanceOf(ArchiveRefused);
	});
});

describe("secret handling", () => {
	test("quarantine and review rows carry metadata and entry_hash, never body or subject", async () => {
		const { manifest, dir } = await archived();
		for (const name of ["memory_quarantine", "memory_reviews"]) {
			const spec = tableSpec(name);
			expect(spec.withheld).toEqual(["body", "subject"]);
			expect(manifest.tables[name]?.withheld).toEqual(["body", "subject"]);
			expect(manifest.tables[name]?.columns).not.toContain("body");
			expect(manifest.tables[name]?.columns).toContain("entry_hash");
			const first = JSON.parse(readFileSync(join(dir, `${name}.ndjson`), "utf8").split("\n")[0] ?? "{}") as Record<string, unknown>;
			expect(Object.keys(first)).not.toContain("body");
			expect(Object.keys(first)).not.toContain("subject");
			expect(typeof first.entry_hash).toBe("string");
		}
		// Accepted memory is the system of record and keeps its text.
		expect(manifest.tables.memory_entries?.columns).toContain("body");
	});

	test("lease_id and holder, the fencing tokens, are withheld like parked text: absent from the files, listed as withheld, refused if a row still carries them", async () => {
		const { manifest, dir } = await archived();
		for (const [table, column] of [
			["graph_nodes", "lease_id"],
			["memory_writes", "holder"],
		] as const) {
			expect(tableSpec(table).withheld).toEqual([column]);
			expect(manifest.tables[table]?.withheld).toEqual([column]);
			expect(manifest.tables[table]?.columns).not.toContain(column);
			const first = JSON.parse(readFileSync(join(dir, `${table}.ndjson`), "utf8").split("\n")[0] ?? "{}") as Record<string, unknown>;
			expect(Object.keys(first)).not.toContain(column);
			const leaky = new StubSource(counts(), { decorate: (name, row) => (name === table ? { ...row, [column]: "fencing-token" } : row) });
			await expect(archiveIndex(leaky, options({ now: () => NOW + 5_000 }))).rejects.toBeInstanceOf(IndexArchiveFailed);
		}
		expect(readdirSync(out)).toEqual([manifest.snapshot]);
	});

	test("a row that still carries a withheld column is refused whole: no file holds it", async () => {
		const leaky = new StubSource(counts(), { decorate: (table, row) => (table === "memory_quarantine" ? { ...row, body: SECRET_TEXT } : row) });
		const failure = archiveIndex(leaky, options());
		await expect(failure).rejects.toBeInstanceOf(IndexArchiveFailed);
		expect(await messageOf(failure)).not.toContain(SECRET_TEXT);
		expect(readdirSync(out)).toEqual([]);
	});

	test("so does a column the spec has never heard of", async () => {
		const source = new StubSource(counts(), { decorate: (table, row) => (table === "graph_nodes" ? { ...row, new_column: "x" } : row) });
		await expect(archiveIndex(source, options())).rejects.toBeInstanceOf(IndexArchiveFailed);
		expect(readdirSync(out)).toEqual([]);
	});
});

describe("path and disk gates", () => {
	test("refuses the root filesystem and names the override", async () => {
		const source = new StubSource(counts());
		const failure = archiveIndex(source, options({ dev: () => 1 }));
		await expect(failure).rejects.toBeInstanceOf(ArchiveRefused);
		await expect(failure).rejects.toThrow("SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS");
		expect(await messageOf(failure)).not.toContain("SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS");
		expect(source.snapshots).toBe(0);
		expect(readdirSync(out)).toEqual([]);
	});

	test("refuses a path whose filesystem cannot be read (a mount that is not there)", async () => {
		const source = new StubSource(counts());
		await expect(archiveIndex(source, options({ dev: () => null }))).rejects.toThrow("cannot read the filesystem");
		expect(source.snapshots).toBe(0);
	});

	test("refuses the release root's filesystem", async () => {
		// Only meaningful where the release root exists; the gate skips it otherwise.
		if (!existsSync("/opt/agent-substrate")) return;
		await expect(archiveIndex(new StubSource(counts()), options({ dev: (path) => (path === "/" ? 1 : 3) }))).rejects.toThrow("release root");
	});

	test("a directory that does not exist yet is judged by its nearest existing ancestor", async () => {
		const nested = join(out, "not", "yet");
		await expect(archiveIndex(new StubSource(counts()), options({ outDir: nested, dev: () => 1 }))).rejects.toBeInstanceOf(ArchiveRefused);
		expect(existsSync(join(out, "not"))).toBe(false);
	});

	test("refuses below the free-space floor, and when free space cannot be read", async () => {
		const tight = () => "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100 99 1024 99% /mnt\n";
		await expect(archiveIndex(new StubSource(counts()), options({ df: tight }))).rejects.toThrow("below SUBSTRATE_DEPLOY_MIN_FREE_GB=5");
		await expect(archiveIndex(new StubSource(counts()), options({ df: () => null }))).rejects.toThrow("cannot read free space");
		expect(readdirSync(out)).toEqual([]);
	});

	test("a floor of 0 disables the free-space gate, as for the deploy gate", async () => {
		await expect(archiveIndex(new StubSource(counts()), options({ df: () => null, minFreeGb: 0 }))).resolves.toBeDefined();
	});

	test("refuses a directory inside the working tree", async () => {
		await expect(archiveIndex(new StubSource(counts()), options({ outDir: join(cwd, "archive") }))).rejects.toThrow("working tree");
	});

	test("an unset archive directory is an empty --out, refused by name at the grammar", () => {
		expect(() => parseIndexArgs(["archive", "--out", ""])).toThrow("SUBSTRATE_INDEX_ARCHIVE_DIR");
		expect(() => parseIndexArgs(["archive", "--out"])).toThrow(IndexUsageError);
	});

	test("the runner refuses an unset archive directory by name and writes nothing (exit 2)", () => {
		const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "index-run.ts"), "archive"], {
			env: { PATH: process.env.PATH ?? "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).toBe(2);
		expect(run.stderr.toString()).toContain("SUBSTRATE_INDEX_ARCHIVE_DIR");
	});
});

describe("verifyIndexArchive", () => {
	test("a fresh archive verifies, from the snapshot directory or from the archive directory above it", async () => {
		const { dir, manifest } = await archived();
		const direct = verifyIndexArchive(dir);
		expect(direct.ok).toBe(true);
		expect(direct.tables.graph_index).toEqual({ rows: 3, bytes: manifest.tables.graph_index?.bytes ?? -1 });
		const viaParent = verifyIndexArchive(out);
		expect(viaParent.ok).toBe(true);
		expect(viaParent.snapshot).toBe(manifest.snapshot);
		expect(formatIndexVerifyReport(viaParent)).toContain("ok");
	});

	test("an archive directory with no complete snapshot is a missing-file, not a pass", () => {
		mkdirSync(join(out, "index-20261014T031500Z"));
		const report = verifyIndexArchive(out);
		expect(report.ok).toBe(false);
		expect(report.mismatches.map((m) => m.kind)).toEqual(["missing-file"]);
	});

	test("missing-file: a deleted table file", async () => {
		const { dir } = await archived();
		rmSync(join(dir, "graph_edges.ndjson"));
		expect(kindsOf(dir)).toContain("missing-file");
	});

	test("size: a file with extra bytes", async () => {
		const { dir } = await archived();
		const path = join(dir, "graph_steps.ndjson");
		writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
		expect(kindsOf(dir)).toContain("size");
	});

	test("hash: a same-size edit of one value", async () => {
		const { dir } = await archived();
		const path = join(dir, "graph_index.ndjson");
		const text = readFileSync(path, "utf8");
		const edited = text.replace("graph_id-0000001", "graph_id-0000009");
		expect(edited.length).toBe(text.length);
		writeFileSync(path, edited);
		const kinds = kindsOf(dir);
		expect(kinds).toContain("hash");
		expect(kinds).not.toContain("size");
	});

	test("rowcount: a dropped line", async () => {
		const { dir } = await archived();
		const path = join(dir, "memory_writes.ndjson");
		const lines = readFileSync(path, "utf8").split("\n");
		writeFileSync(path, lines.slice(1).join("\n"));
		expect(kindsOf(dir)).toContain("rowcount");
	});

	test("parse: a line that is not JSON, and a line that is JSON but not a row of the table", async () => {
		const { dir } = await archived();
		const path = join(dir, "graph_bindings.ndjson");
		const lines = readFileSync(path, "utf8").split("\n");
		writeFileSync(path, ["{not json", '{"correlation_id":"x"}', ...lines.slice(2)].join("\n"));
		const report = verifyIndexArchive(dir);
		const parse = report.mismatches.find((m) => m.kind === "parse");
		expect(parse?.table).toBe("graph_bindings");
		expect(parse?.detail).toContain("2 line(s)");
	});

	test("parse: a line over the length bound is refused while reading, not after", async () => {
		const { dir } = await archived();
		const path = join(dir, "graph_index.ndjson");
		writeFileSync(path, `${"x".repeat(17 * 1024 * 1024)}\n`);
		const parse = verifyIndexArchive(dir).mismatches.find((m) => m.kind === "parse");
		expect(parse?.detail).toContain("line 1");
	});

	test("schema: a manifest written under another schema hash, or another column list", async () => {
		const { dir } = await archived();
		const path = join(dir, "manifest.json");
		const manifest = JSON.parse(readFileSync(path, "utf8")) as IndexArchiveManifest;
		writeFileSync(path, JSON.stringify({ ...manifest, schemaHash: "0".repeat(64) }));
		expect(kindsOf(dir)).toContain("schema");
		const narrowed = { ...manifest, tables: { ...manifest.tables, graph_index: { ...manifest.tables.graph_index, columns: ["graph_id"] } } };
		writeFileSync(path, JSON.stringify(narrowed));
		expect(kindsOf(dir)).toContain("schema");
	});

	test("manifest: an unparseable manifest, another version, a missing table entry, and a file name that points elsewhere", async () => {
		const { dir } = await archived();
		const path = join(dir, "manifest.json");
		const manifest = JSON.parse(readFileSync(path, "utf8")) as IndexArchiveManifest;
		writeFileSync(path, "{nope");
		expect(kindsOf(dir)).toEqual(["manifest"]);
		writeFileSync(path, JSON.stringify({ ...manifest, version: 2 }));
		expect(kindsOf(dir)).toEqual(["manifest"]);
		const { graph_index: _dropped, ...rest } = manifest.tables;
		writeFileSync(path, JSON.stringify({ ...manifest, tables: rest }));
		expect(kindsOf(dir)).toContain("manifest");
		writeFileSync(path, JSON.stringify({ ...manifest, tables: { ...manifest.tables, graph_index: { ...manifest.tables.graph_index, file: "../../etc/passwd" } } }));
		expect(kindsOf(dir)).toContain("manifest");
	});

	test("the vocabulary is closed and every kind has its sentence; a report names kinds and tables, never row contents", async () => {
		expect(Object.keys(INDEX_MISMATCH_SENTENCE).sort()).toEqual([...INDEX_MISMATCH_KINDS].sort());
		expect([...INDEX_MISMATCH_KINDS]).toEqual(["missing-file", "size", "hash", "rowcount", "parse", "schema", "manifest"]);
		const { dir } = await archived();
		const path = join(dir, "memory_entries.ndjson");
		writeFileSync(path, readFileSync(path, "utf8").replace("body-0000001", "body-SECRETVALUE"));
		const report = verifyIndexArchive(dir);
		expect(report.ok).toBe(false);
		for (const mismatch of report.mismatches) expect(INDEX_MISMATCH_KINDS).toContain(mismatch.kind);
		expect(JSON.stringify(report)).not.toContain("SECRETVALUE");
		expect(formatIndexVerifyReport(report)).not.toContain("SECRETVALUE");
		expect(formatIndexVerifyReport(report)).toContain("memory_entries");
	});

	test("a 100k-row table verifies in bounded memory and the digest still matches", async () => {
		const { dir } = await archived({ ...counts(1), graph_edges: 100_000 });
		expect(verifyIndexArchive(dir).ok).toBe(true);
	});
});

describe("the ledger note", () => {
	async function manifestOf(): Promise<IndexArchiveManifest> {
		return (await archived()).manifest;
	}

	test("carries counts, sizes and digests per table and no rows or paths", async () => {
		const manifest = await manifestOf();
		const note = indexArchiveNote(manifest);
		expect(note).toMatchObject({ surface: "substrate", kind: "note", session_id: `index-archive:${manifest.snapshot}` });
		expect(note.payload).toMatchObject({ action: "index.archive", runtime: "index-archive", snapshot: manifest.snapshot });
		const text = JSON.stringify(note);
		expect(text).not.toContain(out);
		expect(text).not.toContain("body-0000000");
		expect(indexArchiveNote(manifest)).toEqual(note);
	});

	test("the marker is on disk BEFORE the emit and gone once the ledger stores the note", async () => {
		const manifest = await manifestOf();
		let markerDuringEmit: boolean | null = null;
		const outcome = await recordIndexArchiveNote(out, manifest, async () => {
			markerDuringEmit = pendingIndexNotes(out).includes(manifest.snapshot);
			return { stored: true };
		});
		expect(outcome.stored).toBe(true);
		expect(markerDuringEmit === true).toBe(true);
		expect(pendingIndexNotes(out)).toEqual([]);
	});

	test("a throwing emit leaves only the marker; the archive stays complete and verified", async () => {
		const manifest = await manifestOf();
		const outcome = await recordIndexArchiveNote(out, manifest, async () => {
			throw new Error(`ledger down at ${pgUrl({ user: "user", secret: "note-fixture-secret", host: "localhost", database: "x" })}`);
		});
		expect(outcome.stored).toBe(false);
		expect(outcome.error).not.toContain("note-fixture-secret");
		expect(pendingIndexNotes(out)).toEqual([manifest.snapshot]);
		const marker = readPendingIndexNote(out, manifest.snapshot);
		expect(marker?.attempts).toBe(1);
		expect(marker?.lastError).toContain("ledger down");
		expect(verifyIndexArchive(join(out, manifest.snapshot)).ok).toBe(true);
	});

	test("a refused note (stored:false) leaves the marker too, and attempts count up", async () => {
		const manifest = await manifestOf();
		await recordIndexArchiveNote(out, manifest, async () => ({ stored: false, error: "refused" }));
		await recordIndexArchiveNote(out, manifest, async () => ({ stored: false, error: "refused" }));
		expect(readPendingIndexNote(out, manifest.snapshot)?.attempts).toBe(2);
	});

	test("the next run retries only the note: it sends the stored note again, exports nothing, and clears the marker", async () => {
		const manifest = await manifestOf();
		await recordIndexArchiveNote(out, manifest, async () => {
			throw new Error("down");
		});
		const source = new StubSource(counts());
		const sent: EventInput[] = [];
		const retried = await retryPendingIndexNotes(out, async (input) => {
			sent.push(input);
			return { stored: true };
		});
		expect(retried).toEqual({ sent: [manifest.snapshot], pending: [], markerWarnings: [] });
		expect(sent).toEqual([indexArchiveNote(manifest)]);
		expect(pendingIndexNotes(out)).toEqual([]);
		expect(source.snapshots).toBe(0);
	});

	test("a retry that fails again keeps the marker and reports it; a marker that does not parse stays pending", async () => {
		const manifest = await manifestOf();
		await recordIndexArchiveNote(out, manifest, async () => ({ stored: false, error: "no" }));
		writeFileSync(join(out, "note-pending-index-20200101T000000Z.json"), "{broken");
		const retried = await retryPendingIndexNotes(out, async () => {
			throw new Error("still down");
		});
		expect(retried.sent).toEqual([]);
		expect(retried.pending.map((p) => p.snapshot)).toEqual(["index-20200101T000000Z", manifest.snapshot]);
		expect(readPendingIndexNote(out, manifest.snapshot)?.attempts).toBe(2);
	});

	test("a marker that cannot be written (a full disk) does not fail the note: the emit still runs and the failure comes back as markerError", async () => {
		const manifest = await manifestOf();
		// A directory where the marker's temp file goes makes the write fail the way ENOSPC would.
		mkdirSync(join(out, `${pendingIndexNoteFile(manifest.snapshot)}.part`));
		const sent: EventInput[] = [];
		const stored = await recordIndexArchiveNote(out, manifest, async (input) => {
			sent.push(input);
			return { stored: true };
		});
		expect(sent).toEqual([indexArchiveNote(manifest)]);
		expect(stored.stored).toBe(true);
		expect(stored.markerError).toContain("note marker not written");
		const refused = await recordIndexArchiveNote(out, manifest, async () => ({ stored: false, error: "refused" }));
		expect(refused.stored).toBe(false);
		expect(refused.markerError).toContain("note marker not written");
		expect(verifyIndexArchive(join(out, manifest.snapshot)).ok).toBe(true);
	});

	test("a retry whose marker update fails still reports the note pending and says why", async () => {
		const manifest = await manifestOf();
		await recordIndexArchiveNote(out, manifest, async () => ({ stored: false, error: "no" }));
		mkdirSync(join(out, `${pendingIndexNoteFile(manifest.snapshot)}.part`));
		const retried = await retryPendingIndexNotes(out, async () => ({ stored: false, error: "still no" }));
		expect(retried.pending.map((p) => p.snapshot)).toEqual([manifest.snapshot]);
		expect(retried.markerWarnings).toHaveLength(1);
		expect(retried.markerWarnings[0]).toContain("note marker not written");
	});
});

/** A Postgres URL assembled at run time from its parts, so no credential-bearing connection string is a literal in the repo. */
function pgUrl(parts: { scheme?: string; user?: string; secret?: string; host: string; port?: number; database?: string; query?: string }): string {
	const userinfo = parts.user === undefined ? "" : `${parts.user}${parts.secret === undefined ? "" : `:${parts.secret}`}@`;
	return `${parts.scheme ?? "postgres"}://${userinfo}${parts.host}${parts.port === undefined ? "" : `:${parts.port}`}/${parts.database ?? ""}${parts.query === undefined ? "" : `?${parts.query}`}`;
}

describe("scratch URL refusals", () => {
	const PROD_SECRET = "prod-fixture-secret";
	const OTHER_SECRET = "other-fixture-secret";
	const PROD = pgUrl({ user: "svc", secret: PROD_SECRET, host: "localhost", port: 5432, database: "substrate" });

	test("refuses the production URL, however it is spelled", () => {
		for (const scratch of [
			PROD,
			pgUrl({ scheme: "postgresql", user: "other", secret: OTHER_SECRET, host: "LOCALHOST", port: 5432, database: "substrate" }),
			pgUrl({ user: "x", host: "localhost.", port: 5432, database: "substrate" }),
			pgUrl({ user: "x", host: "127.0.0.1", database: "substrate", query: "sslmode=require" }),
		]) {
			// The default port is 5432 and the comparison is on host, port and database only.
			const refusal = refusedScratchUrl(scratch, PROD);
			expect(refusal).not.toBeNull();
			expect(refusal).not.toContain(PROD_SECRET);
			expect(refusal).not.toContain(OTHER_SECRET);
		}
	});

	test("loopback aliases are one host, and an omitted database falls back to the user name", () => {
		const local = pgUrl({ user: "u", host: "localhost", database: "app" });
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "127.0.0.1", port: 5432, database: "app" }), local)).not.toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "[::1]", database: "app" }), local)).not.toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "app", host: "localhost" }), local)).not.toBeNull();
	});

	test("every spelling of the loopback host is the production host: short forms, decimal, octal, hex, 127.0.0.0/8, mapped and unspecified IPv6", () => {
		for (const host of ["127.1", "127.0.0.2", "127.255.255.254", "2130706433", "0x7f.0.0.1", "0x7f000001", "0177.0.0.1", "0.0.0.0", "0", "[::]", "[::ffff:7f00:1]", "[::ffff:127.0.0.1]", "[0:0:0:0:0:ffff:7f00:2]", "LocalHost", "localhost."]) {
			const scratch = pgUrl({ user: "x", host, port: 5432, database: "substrate" });
			expect({ host, refused: refusedScratchUrl(scratch, PROD) !== null }).toEqual({ host, refused: true });
		}
	});

	test("the port is compared with the default applied, and the database after trailing slashes and percent-escapes", () => {
		const noPort = pgUrl({ user: "u", host: "localhost", database: "substrate" });
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "127.1", port: 5432, database: "substrate" }), noPort)).not.toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "127.1", database: "substrate" }), PROD)).not.toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "127.1", port: 5432, database: "substrate/" }), PROD)).not.toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "127.1", port: 5432, database: "substrate//" }), PROD)).not.toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "127.1", port: 5432, database: "subst%72ate" }), PROD)).not.toBeNull();
		// Another port or database on an alias is still another database.
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "127.1", port: 5433, database: "substrate" }), PROD)).toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "127.1", port: 5432, database: "scratch" }), PROD)).toBeNull();
	});

	test("the same aliases are recognised on the production side, and an unreadable production URL still refuses", () => {
		const alias = pgUrl({ user: "svc", host: "0x7f.0.0.1", database: "substrate" });
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "localhost", port: 5432, database: "substrate" }), alias)).not.toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "localhost", database: "scratch" }), pgUrl({ scheme: "mysql", host: "localhost", database: "x" }))).toContain("cannot be read");
	});

	test("allows another database, another port or another host", () => {
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "localhost", port: 5432, database: "scratch" }), PROD)).toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "localhost", port: 5433, database: "substrate" }), PROD)).toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "192.0.2.7", port: 5432, database: "substrate" }), PROD)).toBeNull();
		// A non-loopback address is its own host in any spelling, mapped IPv6 included.
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "[::ffff:c000:207]", database: "substrate" }), pgUrl({ user: "u", host: "192.0.2.7", database: "substrate" }))).not.toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "[::2]", database: "substrate" }), PROD)).toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "128.0.0.1", database: "substrate" }), PROD)).toBeNull();
	});

	test("refuses when the production URL is unset, empty or unreadable — it never guesses", () => {
		const scratch = pgUrl({ user: "u", host: "localhost", database: "scratch" });
		expect(refusedScratchUrl(scratch, undefined)).toContain("SUBSTRATE_PG_URL is not set");
		expect(refusedScratchUrl(scratch, "  ")).toContain("SUBSTRATE_PG_URL is not set");
		expect(refusedScratchUrl(scratch, "not a url")).toContain("cannot be read");
	});

	test("refuses a scratch URL it cannot read or whose query string can redirect the connection", () => {
		expect(refusedScratchUrl(pgUrl({ scheme: "mysql", user: "u", host: "localhost", database: "x" }), PROD)).not.toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "localhost", database: "scratch", query: "dbname=substrate" }), PROD)).not.toBeNull();
		expect(refusedScratchUrl(pgUrl({ user: "u", host: "localhost", database: "scratch", query: "host=127.0.0.2" }), PROD)).not.toBeNull();
		expect(normalizePgUrl(pgUrl({ user: "u", host: "localhost", database: "x", query: "hostaddr=127.0.0.3" }))).toBeNull();
	});

	test("the runner refuses before connecting, prints no credentials, and exits 2 (production URL and unset production URL)", () => {
		const runner = join(import.meta.dir, "index-run.ts");
		const scratchSecret = "scratch-fixture-secret";
		const same = Bun.spawnSync(
			[process.execPath, runner, "restore", "--scratch", pgUrl({ user: "other", secret: scratchSecret, host: "127.0.0.1", database: "substrate" }), "/nonexistent"],
			{ env: { PATH: process.env.PATH ?? "", SUBSTRATE_PG_URL: PROD }, stdout: "pipe", stderr: "pipe" },
		);
		expect(same.exitCode).toBe(2);
		const text = `${same.stdout.toString()}${same.stderr.toString()}`;
		expect(text).toContain("production database");
		expect(text).not.toContain(scratchSecret);
		expect(text).not.toContain(PROD_SECRET);
		const unset = Bun.spawnSync(
			[process.execPath, runner, "restore", "--scratch", pgUrl({ user: "u", secret: scratchSecret, host: "localhost", database: "scratch" }), "/nonexistent"],
			{ env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
		);
		expect(unset.exitCode).toBe(2);
		expect(unset.stderr.toString()).toContain("SUBSTRATE_PG_URL is not set");
	});
});

/** An in-memory scratch database: one transaction stages its writes and a throw discards them. */
class MemoryTarget implements RestoreTarget {
	migrated = 0;
	tables = new Map<string, ArchiveRow[]>();
	dropFromMemoryEntries = false;

	async migrate(): Promise<void> {
		this.migrated++;
	}

	async withRestoreTransaction<T>(work: (tx: IndexRestoreTx) => Promise<T>): Promise<T> {
		const staged = new Map<string, ArchiveRow[]>([...this.tables].map(([name, rows]): [string, ArchiveRow[]] => [name, [...rows]]));
		const compare = (a: ReadonlyArray<string | number>, b: ReadonlyArray<string | number>): number => {
			for (let i = 0; i < a.length; i++) {
				const left = a[i] as string | number;
				const right = b[i] as string | number;
				if (left < right) return -1;
				if (left > right) return 1;
			}
			return 0;
		};
		const tx: IndexRestoreTx = {
			serverVersion: async () => "16.4",
			count: async (table) => staged.get(table)?.length ?? 0,
			page: async (table, after, limit) => {
				const spec = tableSpec(table);
				const rows = [...(staged.get(table) ?? [])].sort((a, b) => compare(rowKey(spec, a), rowKey(spec, b)));
				return rows.filter((row) => after === null || compare(rowKey(spec, row), after) > 0).slice(0, limit);
			},
			insert: async (table, rows) => {
				const kept = this.dropFromMemoryEntries && table === "memory_entries" ? rows.slice(1) : rows;
				staged.set(table, [...(staged.get(table) ?? []), ...kept]);
			},
		};
		const result = await work(tx);
		this.tables = staged;
		return result;
	}
}

describe("restoreIndexArchive", () => {
	test("loads every table in order and reports equal counts and digests", async () => {
		const { dir } = await archived();
		const target = new MemoryTarget();
		const done = await restoreIndexArchive(target, { dir });
		expect(target.migrated).toBe(1);
		expect(done.results.map((result) => result.table)).toEqual(ARCHIVE_TABLES.map((spec) => spec.name));
		for (const result of done.results) {
			expect(result).toMatchObject({ manifestRows: 3, restoredRows: 3, rowDigestOk: true, ok: true });
			expect(result.entryHashOk).toBe(tableSpec(result.table).hasEntryHash ? true : null);
		}
	});

	test("a restore that loses a row throws RestoreMismatch naming the table and leaves the scratch empty", async () => {
		const { dir } = await archived();
		const target = new MemoryTarget();
		target.dropFromMemoryEntries = true;
		const failure = restoreIndexArchive(target, { dir });
		await expect(failure).rejects.toBeInstanceOf(RestoreMismatch);
		await expect(failure).rejects.toThrow("memory_entries");
		expect([...target.tables.values()].flat()).toEqual([]);
	});

	test("refuses an archive that does not verify before touching the scratch database", async () => {
		const { dir } = await archived();
		rmSync(join(dir, "graph_edges.ndjson"));
		const target = new MemoryTarget();
		await expect(restoreIndexArchive(target, { dir })).rejects.toBeInstanceOf(RestoreRefused);
		expect(target.migrated).toBe(0);
	});

	test("refuses a scratch database that already holds rows, naming the table", async () => {
		const { dir } = await archived();
		const target = new MemoryTarget();
		target.tables.set("graph_index", [rowAt(tableSpec("graph_index"), 99)]);
		const failure = restoreIndexArchive(target, { dir });
		await expect(failure).rejects.toBeInstanceOf(RestoreRefused);
		await expect(failure).rejects.toThrow("graph_index");
	});
});

describe("grammar and defaults", () => {
	test("parseIndexArgs: the three commands and their flags", () => {
		expect(parseIndexArgs(["archive", "--out", "/mnt/index-archive", "--page-size", "200", "--json"])).toEqual({ command: "archive", out: "/mnt/index-archive", pageSize: 200, json: true });
		expect(parseIndexArgs(["verify-archive", "/mnt/index-archive"])).toEqual({ command: "verify-archive", dir: "/mnt/index-archive", json: false });
		expect(parseIndexArgs(["restore", "--scratch", "postgres://u@localhost/s", "/mnt/index-archive"])).toEqual({
			command: "restore",
			scratch: "postgres://u@localhost/s",
			dir: "/mnt/index-archive",
			json: false,
		});
	});

	test("parseIndexArgs refuses what the runner does not take", () => {
		for (const argv of [[], ["prune"], ["archive", "--apply"], ["archive", "--page-size", "0"], ["archive", "--page-size", "5001"], ["archive", "x"], ["verify-archive"], ["restore", "/d", "--scratch"], ["restore", "--scratch", ""]]) {
			expect(() => parseIndexArgs(argv)).toThrow(IndexUsageError);
		}
	});

	test("every env knob defaults to today's behaviour: no directory, report-only age, no tune", () => {
		expect(loadIndexArchiveSettings({})).toEqual(DEFAULT_INDEX_ARCHIVE_SETTINGS);
		expect(DEFAULT_INDEX_ARCHIVE_SETTINGS).toMatchObject({ dir: null, maxAgeHours: null, tune: "off" });
		expect(loadIndexArchiveSettings({ SUBSTRATE_INDEX_ARCHIVE_DIR: "  /mnt/index-archive ", SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H: "26", SUBSTRATE_INDEX_TUNE: "APPLY" })).toMatchObject({
			dir: "/mnt/index-archive",
			maxAgeHours: 26,
			tune: "apply",
		});
		// Anything else is off, and an age that is not a positive whole number leaves the row report-only.
		expect(loadIndexArchiveSettings({ SUBSTRATE_INDEX_TUNE: "yes", SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H: "0" })).toMatchObject({ tune: "off", maxAgeHours: null });
		expect(loadIndexArchiveSettings({ SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H: "soon", SUBSTRATE_INDEX_ARCHIVE_MAX_SECONDS: "1" })).toMatchObject({ maxAgeHours: null, maxSeconds: 10 });
	});
});

describe("private modes (the archive holds accepted memory text)", () => {
	/** The permission bits of a path. */
	const modeOf = (path: string): number => statSync(path).mode & 0o777;

	test("under a permissive umask every directory and file the run creates is owner-only, the archive directory it creates included", async () => {
		const previous = process.umask(0o000);
		try {
			const fresh = join(out, "not", "yet");
			const manifest = await archiveIndex(new StubSource(counts()), options({ outDir: fresh }));
			const dir = join(fresh, manifest.snapshot);
			expect(modeOf(join(out, "not"))).toBe(0o700);
			expect(modeOf(fresh)).toBe(0o700);
			expect(modeOf(dir)).toBe(0o700);
			for (const name of readdirSync(dir)) expect({ name, mode: modeOf(join(dir, name)) }).toEqual({ name, mode: 0o600 });
			expect(readdirSync(dir)).toContain("manifest.json");
			// The note marker, written beside the snapshot, is private too.
			await recordIndexArchiveNote(fresh, manifest, async () => ({ stored: false, error: "down" }));
			expect(modeOf(join(fresh, pendingIndexNoteFile(manifest.snapshot)))).toBe(0o600);
		} finally {
			process.umask(previous);
		}
	});

	test("a restore only reads the archive: it creates no temp file beside it", async () => {
		const { dir } = await archived();
		const before = readdirSync(dir).sort();
		await restoreIndexArchive(new MemoryTarget(), { dir });
		expect(readdirSync(dir).sort()).toEqual(before);
	});
});

describe("verify keeps constant state however damaged the file is", () => {
	test("LineTally counts every line and keeps only the first three examples", () => {
		const tally = new LineTally();
		for (let line = 1; line <= 200_000; line++) tally.add(line);
		expect(tally.count).toBe(200_000);
		expect(tally.examples).toEqual([1, 2, 3]);
		expect(TALLY_EXAMPLES).toBe(3);
	});

	test("a 200k-line damaged table is reported with its count and three example lines, and a small damage report is unchanged", async () => {
		const { dir } = await archived();
		writeFileSync(join(dir, "graph_edges.ndjson"), "{bad\n".repeat(200_000));
		const parse = verifyIndexArchive(dir).mismatches.find((m) => m.kind === "parse" && m.table === "graph_edges");
		expect(parse?.detail).toBe("200000 line(s) are not graph_edges rows in archive form (first at line 1, 2, 3)");
		// Two bad lines among good ones: exactly the old wording.
		const small = await archiveIndex(new StubSource(counts()), options({ now: () => NOW + 5_000 }));
		const smallPath = join(out, small.snapshot, "graph_bindings.ndjson");
		const lines = readFileSync(smallPath, "utf8").split("\n");
		writeFileSync(smallPath, ["{not json", lines[1] ?? "", "{also not", ...lines.slice(3)].join("\n"));
		expect(verifyIndexArchive(join(out, small.snapshot)).mismatches.find((m) => m.kind === "parse")?.detail).toBe("2 line(s) are not graph_bindings rows in archive form (first at line 1, 3)");
	});
});

describe("corpus_documents in the archive", () => {
	test("is a whitelisted table keyed by (repo, path), with its signals as jsonb and its manifest sequence as the identity restore moves past", () => {
		const spec = tableSpec("corpus_documents");
		expect(ARCHIVE_TABLES.map((table) => table.name)).toContain("corpus_documents");
		expect(spec.key).toEqual(["repo", "path"]);
		expect(spec.withheld).toEqual([]);
		expect(spec.identity).toBe("manifest_seq");
		expect(spec.columns.find((column) => column.name === "signals")?.type).toBe("jsonb");
		expect(spec.columns.map((column) => column.name)).toContain("superseded_by");
	});
});
