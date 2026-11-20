/**
 * The index archive against a real Postgres (uplift-4 S2): archive → verify →
 * restore into a scratch database, with counts and hashes equal; the keyset
 * cursor over real multi-page tables; one snapshot across a concurrent write;
 * the schema whitelist against `information_schema` and `pg_index`; a
 * quarantine row's text and the fencing tokens never leaving the box; the
 * lease-table tune and the HOT/dead ratios.
 *
 * Skipped unless a database is given, like `index-store.sweep.test.ts`:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.archive
 *
 * The restore target is a throwaway database created on the same server and
 * dropped afterwards; when the test role may not create databases, the
 * restore tests skip themselves rather than touching the source database.
 * Every row written here carries `RUN` in its id, and `afterAll` removes them.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIVE_TABLES, exportedColumns, type ArchiveTableSpec, type ColumnType } from "./index-archive-spec.ts";
import { archiveIndex, refusedScratchUrl, restoreIndexArchive, verifyIndexArchive, type IndexArchiveSource } from "./index-archive.ts";
import { IndexStore } from "./index-store.ts";
import { defined } from "./test-support.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const describeLive = PG_URL ? describe : describe.skip;
const RUN = `ut-archtest-${Date.now().toString(36)}`;
const SECRET_BODY = `${RUN} reach alice at alice@example.test or +1 555 0100`;
const LEASE_TOKEN = `lease-token-${RUN}`;
const HOLDER_TOKEN = `holder-token-${RUN}`;
const id = (name: string): string => `${RUN}-${name}`;

/** `/` is device 1, the release root 3 (where it exists), everything else a dedicated mount 2: the scratch dir under tmp is the "archive volume". The real `st_dev` of /tmp may equal the release root's on a one-disk host, which the gate rightly refuses. */
const dedicated = (path: string): number => (path === "/" ? 1 : path === "/opt/agent-substrate" ? 3 : 2);
const roomy = (): string => "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 999999999 1 999999999 1% /mnt\n";

/** Each archive in this file is stamped a distinct second, so two never collide on a snapshot name. */
const BASE = Date.now();
const at = (n: number) => (): number => BASE + n * 5_000;

/** `information_schema.columns.data_type` for each archive column type. */
const PG_DATA_TYPE: Record<ColumnType, string> = { text: "text", int: "integer", smallint: "smallint", bigint: "bigint", bool: "boolean", timestamptz: "timestamp with time zone", jsonb: "jsonb" };

let store: IndexStore;
let raw: SQL;
let out: string;
let cwd: string;
let scratchUrl: string | null = null;
let scratchName: string | null = null;

/** The test URL with its database replaced. */
function withDatabase(url: string, database: string): string {
	const parsed = new URL(url);
	parsed.pathname = `/${database}`;
	return parsed.toString();
}

/** An independent oracle for what an export should hold: the table read directly, in key order, rendered the way the archive writes values. */
async function directRows(spec: ArchiveTableSpec): Promise<Array<Record<string, unknown>>> {
	const columns = exportedColumns(spec)
		.map((column) =>
			column.type === "timestamptz"
				? `to_char("${column.name}" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "${column.name}"`
				: column.type === "bigint" || column.type === "jsonb"
					? `"${column.name}"::text as "${column.name}"`
					: `"${column.name}"`,
		)
		.join(", ");
	const keys = spec.key.map((name) => `"${name}"`).join(", ");
	const rows = (await raw.unsafe(`select ${columns} from "${spec.name}" order by ${keys}`)) as Array<Record<string, unknown>>;
	return rows.map((row) => Object.fromEntries(exportedColumns(spec).map((column) => [column.name, row[column.name] ?? null])));
}

function fileRows(dir: string, spec: ArchiveTableSpec): unknown[] {
	return readFileSync(join(dir, `${spec.name}.ndjson`), "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

describeLive("index archive against a live index", () => {
	beforeAll(async () => {
		store = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		raw = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await store.migrate();
		out = mkdtempSync(join(tmpdir(), "index-archive-live-"));
		cwd = mkdtempSync(join(tmpdir(), "index-archive-cwd-"));
		await seed();
		const name = `substrate_restore_${Date.now().toString(36)}`;
		try {
			await raw.unsafe(`create database "${name}"`);
			scratchName = name;
			scratchUrl = withDatabase(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"), name);
		} catch {
			scratchUrl = null;
		}
	});

	afterAll(async () => {
		if (!PG_URL) return;
		const like = `${RUN}%`;
		for (const table of ["graph_edges", "graph_steps", "graph_bindings", "graph_nodes"]) {
			await raw.unsafe(`delete from ${table} where graph_id like $1`, [like]).catch(() => undefined);
		}
		await raw`delete from graph_index where graph_id like ${`%${RUN}%`}`.catch(() => undefined);
		await raw`delete from memory_entries where id like ${like}`.catch(() => undefined);
		await raw`delete from memory_reviews where id like ${like}`.catch(() => undefined);
		await raw`delete from memory_quarantine where id like ${like}`.catch(() => undefined);
		await raw`delete from memory_writes where idempotency_key like ${like}`.catch(() => undefined);
		await raw`delete from context_matrix_entries where entry_id like ${like}`.catch(() => undefined);
		await raw`delete from corpus_documents where repo like ${like}`.catch(() => undefined);
		if (scratchName !== null) await raw.unsafe(`drop database if exists "${scratchName}" with (force)`).catch(() => undefined);
		await raw.end().catch(() => undefined);
		await store.close().catch(() => undefined);
		rmSync(out, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	/** At least three rows in every table, several steps per node: with a page size of 2 every table needs a second page, so the keyset cursor really runs. */
	async function seed(): Promise<void> {
		for (const name of ["g1", "g2", "g3"]) await raw`insert into graph_index (graph_id, repo, status) values (${id(name)}, 'r', 'open')`;
		await raw`insert into graph_nodes (graph_id, node_id, state, claimed_by, lease_id, lease_expires_at, lease_epoch)
			values (${id("g1")}, 'n1', 'claimed', 'omp', ${LEASE_TOKEN}, now() + interval '1 hour', 7)`;
		for (const [graph, node] of [["g1", "n2"], ["g1", "n3"], ["g2", "n1"]] as const) {
			await raw`insert into graph_nodes (graph_id, node_id, state) values (${id(graph)}, ${node}, 'todo')`;
		}
		for (const [from, to] of [["n1", "n2"], ["n2", "n3"], ["n1", "n3"]] as const) {
			await raw`insert into graph_edges (graph_id, from_node, to_node, kind) values (${id("g1")}, ${from}, ${to}, 'blocks')`;
		}
		for (const [node, step] of [["n1", 1], ["n1", 2], ["n1", 3], ["n2", 1]] as const) {
			await raw`insert into graph_steps (graph_id, node_id, step, state) values (${id("g1")}, ${node}, ${step}, 'todo')`;
		}
		for (const name of ["corr1", "corr2", "corr3"]) await raw`insert into graph_bindings (correlation_id, graph_id) values (${id(name)}, ${id("g1")})`;
		await raw`insert into memory_entries (id, scope, kind, body, writer, entry_hash, created)
			values (${id("m1")}, 'global', 'fact', ${`${RUN} ünïcode "quoted" body\nline two`}, 'omp', ${`hash-${RUN}-1`}, '2026-10-14T03:15:00.123456Z')`;
		for (const name of ["m2", "m3", "m4"]) {
			await raw`insert into memory_entries (id, scope, kind, body, writer, entry_hash) values (${id(name)}, 'global', 'fact', ${`${RUN} body ${name}`}, 'omp', ${`hash-${RUN}-${name}`})`;
		}
		for (const name of ["w1", "w2", "w3"]) {
			await raw`insert into memory_writes (idempotency_key, explicit, outcome, entry_id, entry_hash, holder)
				values (${id(name)}, true, 'accepted', ${id("m1")}, ${`hash-${RUN}-1`}, ${`${HOLDER_TOKEN}-${name}`})`;
		}
		for (const name of ["q1", "q2", "q3"]) {
			await raw`insert into memory_quarantine (id, scope, kind, body, subject, writer, entry_hash, reason, detail)
				values (${id(name)}, 'global', 'fact', ${SECRET_BODY}, ${SECRET_BODY}, 'omp', ${`hash-${RUN}-${name}`}, 'pii', 'the text carried an email address')`;
		}
		for (const name of ["r1", "r2", "r3"]) {
			await raw`insert into memory_reviews (id, scope, kind, body, subject, writer, entry_hash, reason)
				values (${id(name)}, 'global', 'fact', ${SECRET_BODY}, ${SECRET_BODY}, 'omp', ${`hash-${RUN}-${name}`}, 'review')`;
		}
		for (const [name, kind] of [["cm1", "decision"], ["cm2", "fact"], ["cm3", "todo"]] as const) {
			await raw`insert into context_matrix_entries (entry_id, milestone, phase, source_path, source_sha256, entry_kind, body_redacted)
				values (${id(name)}, 'm1', 'p1', 'docs/plan.md', ${"0".repeat(64)}, ${kind}, ${`${RUN} ${name} body`})`;
		for (const name of ["d1", "d2", "d3"]) {
			await raw`insert into corpus_documents (repo, path, kind, tier, sha256, bytes, source, state, ingested_at)
				values (${`${RUN}/seed`}, ${`doc-${name}.md`}, 'doc', 2, ${"0".repeat(64)}, 10, 'fs', 'active', now())`;
		}
	}

	test("the closed whitelist is exactly what migrate() created: every table, column, type and primary key", async () => {
		for (const spec of ARCHIVE_TABLES) {
			const columns = (await raw`
				select column_name, data_type, is_nullable from information_schema.columns
				where table_schema = current_schema() and table_name = ${spec.name}`) as Array<Record<string, unknown>>;
			const live = new Map(columns.map((row) => [String(row.column_name), row]));
			expect([...live.keys()].sort()).toEqual(spec.columns.map((column) => column.name).sort());
			for (const column of spec.columns) {
				expect({ table: spec.name, column: column.name, type: String(live.get(column.name)?.data_type) }).toEqual({ table: spec.name, column: column.name, type: PG_DATA_TYPE[column.type] });
			}
			// A withheld column is restored as its placeholder: NULL needs a nullable column, text needs a text one.
			for (const name of spec.withheld) {
				expect(Object.hasOwn(spec.placeholders, name)).toBe(true);
				if (spec.placeholders[name] === null) expect({ table: spec.name, column: name, nullable: live.get(name)?.is_nullable }).toEqual({ table: spec.name, column: name, nullable: "YES" });
				else expect(live.get(name)?.data_type).toBe("text");
			}
			const key = (await raw`
				select a.attname as name
				from pg_index i
				cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
				join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
				where i.indrelid = ${spec.name}::text::regclass and i.indisprimary
				order by k.ord`) as Array<Record<string, unknown>>;
			// The keyset the export pages by is the primary key, in order: a different key would page over the wrong order and skip or repeat rows.
			expect({ table: spec.name, key: key.map((row) => String(row.name)) }).toEqual({ table: spec.name, key: [...spec.key] });
		}
		const tables = (await raw`
			select table_name from information_schema.tables
			where table_schema = current_schema() and table_type = 'BASE TABLE' and (table_name like 'graph\_%' or table_name like 'memory\_%' or table_name like 'context\_matrix\_%' or table_name = 'corpus_documents')`) as Array<Record<string, unknown>>;
		expect(tables.map((row) => String(row.table_name)).sort()).toEqual(ARCHIVE_TABLES.map((spec) => spec.name).sort());
	});

	test("with a page size of 2 every table pages through the keyset cursor, and the export equals a direct ordered select of the table", async () => {
		const manifest = await archiveIndex(store, { outDir: out, cwd, dev: dedicated, df: roomy, minFreeGb: 5, pageSize: 2, now: at(1) });
		const dir = join(out, manifest.snapshot);
		for (const spec of ARCHIVE_TABLES) {
			// Three seeded rows at least, so the second page (whose statement carries the cursor) ran for this table.
			expect(manifest.tables[spec.name]?.rows ?? 0).toBeGreaterThanOrEqual(3);
			expect({ table: spec.name, rows: fileRows(dir, spec) }).toEqual({ table: spec.name, rows: await directRows(spec) });
		}
		expect(verifyIndexArchive(dir).ok).toBe(true);
	});

	test("archive → verify → restore into a scratch database: counts and hashes equal, fencing tokens and parked text left behind", async () => {
		const manifest = await archiveIndex(store, { outDir: out, cwd, dev: dedicated, df: roomy, minFreeGb: 5, pageSize: 2, now: at(2) });
		const dir = join(out, manifest.snapshot);
		expect(manifest.tables.memory_entries?.rows).toBeGreaterThanOrEqual(4);
		expect(manifest.serverVersion.length).toBeGreaterThan(0);
		// The fencing tokens are in no file.
		for (const name of readdirSync(dir)) {
			const text = readFileSync(join(dir, name), "utf8");
			expect(text).not.toContain(LEASE_TOKEN);
			expect(text).not.toContain(HOLDER_TOKEN);
		}

		const report = verifyIndexArchive(out);
		expect(report.mismatches).toEqual([]);
		expect(report.ok).toBe(true);

		if (scratchUrl === null) return;
		expect(refusedScratchUrl(scratchUrl, PG_URL)).toBeNull();
		const scratch = new IndexStore(scratchUrl);
		try {
			const done = await restoreIndexArchive(scratch, { dir });
			for (const result of done.results) {
				expect(result.restoredRows).toBe(manifest.tables[result.table]?.rows ?? -1);
				expect(result.ok).toBe(true);
			}
			// The accepted entry came back byte for byte, microsecond timestamp included.
			const restored = new SQL(scratchUrl);
			try {
				const rows = (await restored`select body, to_char(created at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created from memory_entries where id = ${id("m1")}`) as Array<Record<string, unknown>>;
				expect(rows[0]?.body).toBe(`${RUN} ünïcode "quoted" body\nline two`);
				expect(rows[0]?.created).toBe("2026-10-14T03:15:00.123456Z");
				// The lease came back without its fencing token, and the claim without its holder.
				const nodes = (await restored`select lease_epoch::text as epoch, lease_id, claimed_by from graph_nodes where graph_id = ${id("g1")} and node_id = 'n1'`) as Array<Record<string, unknown>>;
				expect(nodes[0]).toMatchObject({ epoch: "7", lease_id: null, claimed_by: "omp" });
				const writes = (await restored`select holder, entry_hash from memory_writes where idempotency_key = ${id("w1")}`) as Array<Record<string, unknown>>;
				expect(writes[0]).toMatchObject({ holder: null, entry_hash: `hash-${RUN}-1` });
				// A withheld body is restored as the placeholder, and the hash is the original's.
				const parked = (await restored`select body, subject, entry_hash from memory_quarantine where id = ${id("q1")}`) as Array<Record<string, unknown>>;
				expect(parked[0]?.body).toBe("[withheld by index-archive]");
				expect(parked[0]?.subject).toBeNull();
				expect(parked[0]?.entry_hash).toBe(`hash-${RUN}-q1`);
				// The manifest's identity sequence was moved past the restored rows: the next write takes a number above all of them.
				const top = (await restored`select max(manifest_seq)::text as top from corpus_documents`) as Array<Record<string, unknown>>;
				const fresh = (await restored`insert into corpus_documents (repo, path, kind, tier, sha256, bytes, source, state)
					values (${`${RUN}/after`}, 'after.md', 'doc', 1, ${"0".repeat(64)}, 1, 'fs', 'active') returning manifest_seq::text as seq`) as Array<Record<string, unknown>>;
				expect(BigInt(String(fresh[0]?.seq))).toBeGreaterThan(BigInt(String(top[0]?.top)));
			} finally {
				await restored.end().catch(() => undefined);
			}
			// A second restore into the now-populated scratch refuses, and changes nothing.
			await expect(restoreIndexArchive(scratch, { dir })).rejects.toThrow("already holds");
		} finally {
			await scratch.close().catch(() => undefined);
		}
	});

	test("a quarantine or review row's text never reaches a file", async () => {
		const manifest = await archiveIndex(store, { outDir: out, cwd, dev: dedicated, df: roomy, minFreeGb: 5, now: at(3) });
		const dir = join(out, manifest.snapshot);
		for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name), "utf8")).not.toContain("alice@example.test");
		const quarantine = readFileSync(join(dir, "memory_quarantine.ndjson"), "utf8");
		expect(quarantine).toContain(`hash-${RUN}-q1`);
		expect(quarantine).toContain("the text carried an email address");
		for (const spec of ARCHIVE_TABLES.filter((table) => table.withheld.length > 0)) {
			expect(exportedColumns(spec).map((column) => column.name)).not.toContain("body");
		}
	});

	test("the export is one snapshot: a row another connection commits between two page reads is not in the archive", async () => {
		const late = `zzzzzzzz-${RUN}-late`;
		let inserted = false;
		// The late row sorts after every key, so a read that is not on the snapshot would meet it on a later page.
		const racing: IndexArchiveSource = {
			withExportSnapshot: (work) =>
				store.withExportSnapshot((reader) =>
					work({
						...reader,
						page: async (table, after, limit) => {
							if (table === "graph_index" && after !== null && !inserted) {
								inserted = true;
								await raw`insert into graph_index (graph_id, repo, status) values (${late}, 'r', 'open')`;
							}
							return reader.page(table, after, limit);
						},
					}),
				),
		};
		try {
			const manifest = await archiveIndex(racing, { outDir: out, cwd, dev: dedicated, df: roomy, minFreeGb: 5, pageSize: 2, now: at(4) });
			expect(inserted).toBe(true);
			// It was committed (the table has it now), and the archive does not.
			const live = (await raw`select count(*)::int as n from graph_index where graph_id = ${late}`) as Array<Record<string, unknown>>;
			expect(live[0]?.n).toBe(1);
			expect(readFileSync(join(out, manifest.snapshot, "graph_index.ndjson"), "utf8")).not.toContain(late);
			expect(verifyIndexArchive(join(out, manifest.snapshot)).ok).toBe(true);
		} finally {
			await raw`delete from graph_index where graph_id = ${late}`.catch(() => undefined);
		}
	});

	test("the real mount gate still refuses: a directory on the root filesystem's device is not an archive volume", async () => {
		await expect(archiveIndex(store, { outDir: out, cwd, dev: () => 1, df: roomy, minFreeGb: 5 })).rejects.toThrow("SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS");
	});

	test("the snapshot reader counts through the whitelist and refuses any other table name before a statement exists", async () => {
		await store.withExportSnapshot(async (reader) => {
			expect(await reader.count("graph_index")).toBeGreaterThanOrEqual(1);
			await expect(reader.page("not_a_table", null, 10)).rejects.toThrow("not an archived index table");
			await expect(reader.page("graph_index", null, 0)).rejects.toThrow("page size");
			// Two reads in one snapshot agree on the same table even while the pool keeps writing.
			expect(await reader.count("graph_nodes")).toBe(await reader.count("graph_nodes"));
		});
	});

	test("capacity() reports graph_nodes' hot-update and dead ratios as numbers or null", async () => {
		const capacity = await store.capacity();
		expect(capacity.graphNodes).not.toBeNull();
		for (const ratio of [capacity.graphNodes?.hotUpdateRatio, capacity.graphNodes?.deadRatio]) {
			expect(ratio === null || (typeof ratio === "number" && ratio >= 0 && ratio <= 1)).toBe(true);
		}
	});

	test("the lease-table tune is off by default and, when applied, is idempotent and drops no index", async () => {
		expect(store.tune).toBe("off");
		const indexes = async (): Promise<string[]> =>
			((await raw`select indexname from pg_indexes where tablename = 'graph_nodes' order by indexname`) as Array<Record<string, unknown>>).map((row) => String(row.indexname));
		const before = await indexes();
		const tuned = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"), { tune: "apply" });
		try {
			await tuned.migrate();
			expect(await tuned.tuneGraphNodes()).toBe("already");
			const options = (await raw`select array_to_string(reloptions, ',') as options from pg_class where oid = 'graph_nodes'::regclass`) as Array<Record<string, unknown>>;
			expect(String(options[0]?.options)).toContain("fillfactor=70");
			expect(String(options[0]?.options)).toContain("autovacuum_vacuum_scale_factor=0.02");
			expect(await indexes()).toEqual(before);
		} finally {
			await tuned.close().catch(() => undefined);
		}
	});
});
