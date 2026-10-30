/**
 * The planning refresh's durable page hashes (v1.7 phase 65): the adapters, and the refresh itself over two `Substrate`
 * instances that share one store, the way a restart shares the index. The docs plane is replaced by a spy on `ingestDocs`, so
 * what is asserted is which pages the refresh sent, not what LightRAG did with them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import type { IngestOutcome } from "./docs-ingest.ts";
import { normalizeEvent } from "./event.ts";
import { IndexStore } from "./index-store.ts";
import { bunPlanningHashStore, memoryPlanningHashStore, planningDestinationKey, type PlanningHashQuery, type PlanningHashStore } from "./planning-hash-store.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";
import type { EventInput } from "./types.ts";

const STATE = ".planning/STATE.md";
const ROADMAP = ".planning/ROADMAP.md";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "planning-hashes-"));
	mkdirSync(join(dir, ".planning"));
	writeFileSync(join(dir, STATE), "# State\n\nPhase 65.\n");
	writeFileSync(join(dir, ROADMAP), "# Roadmap\n\nPhase 65: doc watch.\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface Run {
	/** The pages each `ingestDocs` call carried, in order. */
	batches: string[][];
	events: EventInput[];
	refresh(): Promise<void>;
}

/** A server whose docs plane is a spy: every page it is asked to ingest succeeds unless `failing` names it. */
function server(env: Record<string, string>, store: PlanningHashStore, failing: readonly string[] = []): Run {
	const substrate = new Substrate(loadConfig({ LIGHTRAG_URL: "http://lightrag.invalid", ...env }), {
		index: null,
		greptime: null,
		planningBaseDir: dir,
		planningHashes: store,
	});
	const batches: string[][] = [];
	const events: EventInput[] = [];
	spyOn(substrate, "emit").mockImplementation(async (event) => {
		events.push(event);
		return { event: normalizeEvent(event, null), stored: true };
	});
	spyOn(substrate, "ingestDocs").mockImplementation(async (input): Promise<IngestOutcome> => {
		const paths = (Array.isArray(input.pages) ? input.pages : []).map((page: { path: string }) => page.path);
		batches.push(paths);
		return {
			ok: true,
			stripped_images: 0,
			changed: true,
			results: paths.map((path) => ({ path, source_url: `file:///${path}`, status: failing.includes(path) ? ("failed" as const) : ("ingested" as const), document_id: `doc-${path}`, content_sha256: "x" })),
		};
	});
	return {
		batches,
		events,
		async refresh() {
			substrate.startPlanningPoll();
			await substrate.planningRefreshIdle();
			substrate.stopPlanningPoll();
		},
	};
}

const ON = { SUBSTRATE_PLANNING_HASH_STORE: "on" };

describe("the in-memory adapter", () => {
	test("save upserts what it is given and keeps the rest; load answers a copy, so a caller cannot edit the store", async () => {
		const store = memoryPlanningHashStore(new Map([["a.md", "1"]]));
		await store.save(new Map([["b.md", "2"]]));
		await store.save(new Map([["a.md", "3"]]));
		const loaded = await store.load();
		expect([...loaded].sort()).toEqual([
			["a.md", "3"],
			["b.md", "2"],
		]);
		loaded.set("c.md", "9");
		expect((await store.load()).has("c.md")).toBe(false);
	});

	test("the destination key is a hash of the docs URL, stable, and not the URL", () => {
		const url = "http://lightrag.internal:9621";
		expect(planningDestinationKey(url)).toBe(planningDestinationKey(url));
		expect(planningDestinationKey(url)).not.toBe(planningDestinationKey("http://other.internal:9621"));
		expect(planningDestinationKey(url)).not.toContain(url);
		expect(planningDestinationKey(url)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("the Postgres adapter's destination scope", () => {
	test("a destination change misses the old hashes, so those pages are not treated as already ingested", async () => {
		const rows: Array<Record<string, unknown>> = [];
		const sql: PlanningHashQuery = async (strings, ...values) => {
			const text = strings.join("?");
			if (text.includes("select")) return rows.filter((row) => row.destination === values[0]);
			const [destination, path, sha256] = values;
			const existing = rows.find((row) => row.destination === destination && row.path === path);
			if (existing === undefined) rows.push({ destination, path, sha256 });
			else existing.sha256 = sha256;
			return [];
		};
		const first = bunPlanningHashStore(sql, planningDestinationKey("http://plane-a"));
		await first.save(new Map([["ROADMAP.md", "hash-1"]]));
		const second = bunPlanningHashStore(sql, planningDestinationKey("http://plane-b"));
		expect(await second.load()).toEqual(new Map());
		expect((await first.load()).get("ROADMAP.md")).toBe("hash-1");
		expect(JSON.stringify(rows)).not.toContain("http://plane-a");
	});
});

describe("the planning refresh with the hash store on", () => {
	test("a second server over the same store ingests nothing unchanged, and exactly the changed page after an edit", async () => {
		const store = memoryPlanningHashStore();
		const first = server(ON, store);
		await first.refresh();
		expect(first.batches.flat().sort()).toEqual([ROADMAP, STATE]);

		// A restart: a new process with no memory, the same store.
		const second = server(ON, store);
		await second.refresh();
		expect(second.batches).toEqual([]);
		expect(second.events).toEqual([]);

		writeFileSync(join(dir, ROADMAP), "# Roadmap\n\nPhase 65: doc watch, shipped.\n");
		const third = server(ON, store);
		await third.refresh();
		expect(third.batches.flat()).toEqual([ROADMAP]);
		expect(third.events.map((event) => event.payload?.paths)).toEqual([[ROADMAP]]);
	});

	test("a page the plane failed is not stored, so the next process sends it again and only it", async () => {
		const store = memoryPlanningHashStore();
		await server(ON, store, [ROADMAP]).refresh();
		expect([...(await store.load()).keys()]).toEqual([STATE]);

		const next = server(ON, store);
		await next.refresh();
		expect(next.batches.flat()).toEqual([ROADMAP]);
	});

	test("with the flag off nothing is read or written: a restart ingests every page again and the store stays empty", async () => {
		const store = memoryPlanningHashStore();
		await server({}, store).refresh();
		const restarted = server({}, store);
		await restarted.refresh();
		expect(restarted.batches.flat().sort()).toEqual([ROADMAP, STATE]);
		expect((await store.load()).size).toBe(0);
	});

	test("a store that cannot be read costs one full ingest and the pass still completes; one that cannot be written does not fail it either", async () => {
		const unreadable: PlanningHashStore = {
			load: async () => {
				throw new Error("connection refused");
			},
			save: async () => undefined,
		};
		const read = server(ON, unreadable);
		await read.refresh();
		expect(read.batches.flat().sort()).toEqual([ROADMAP, STATE]);
		expect(read.events).toHaveLength(1);

		const unwritable: PlanningHashStore = {
			load: async () => new Map(),
			save: async () => {
				throw new Error("read-only transaction");
			},
		};
		const write = server(ON, unwritable);
		await write.refresh();
		expect(write.batches.flat().sort()).toEqual([ROADMAP, STATE]);
		expect(defined(write.events[0], "the planning note").payload?.action).toBe("docs.planning");
	});
});

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const MARKER = `ut-planning-hashes-${Date.now().toString(36)}`;
const describeLive = PG_URL ? describe : describe.skip;

// Needs a database (migration step 39):  SUBSTRATE_TEST_PG_URL=postgres://… bun test planning-hash-store
describeLive("the Postgres adapter against a live index", () => {
	let index: IndexStore;
	let cleanup: SQL;

	beforeAll(async () => {
		index = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await index.migrate();
		cleanup = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await cleanup`delete from planning_page_hashes where path like ${`${MARKER}/%`}`.catch(() => undefined);
		await cleanup.close().catch(() => undefined);
		await index.close().catch(() => undefined);
	});

	test("save upserts by path and load reads it back, so a second store object sees what the first wrote", async () => {
		const destination = planningDestinationKey("http://lightrag.test");
		const written = index.planningHashStore(destination);
		await written.save(
			new Map([
				[`${MARKER}/a.md`, "1"],
				[`${MARKER}/b.md`, "2"],
			]),
		);
		await written.save(new Map([[`${MARKER}/a.md`, "3"]]));
		const loaded = await index.planningHashStore(destination).load();
		expect(loaded.get(`${MARKER}/a.md`)).toBe("3");
		expect(loaded.get(`${MARKER}/b.md`)).toBe("2");
		expect(await index.planningHashStore(planningDestinationKey("http://other.test")).load()).toEqual(new Map());
	});
});
