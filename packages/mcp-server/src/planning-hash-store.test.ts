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
import { type IngestOutcome, type PlanningPage, planningIngestTrigger, planningPageSha } from "./docs-ingest.ts";
import { normalizeEvent } from "./event.ts";
import { IndexStore } from "./index-store.ts";
import { bunPlanningHashStore, memoryPlanningHashStore, planningDestinationKey, planningPageKey, type PlanningHashQuery, type PlanningHashStore } from "./planning-hash-store.ts";
import { planningSessionId } from "./planning/checkout.ts";
import { nodePlanningFs } from "./planning/fs.ts";
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
	/** The dataset each `ingestDocs` call named, in order: a planning page is filed under its checkout's dataset. */
	datasets: string[];
	events: EventInput[];
	refresh(): Promise<void>;
}

/** A server whose docs plane is a spy: every page it is asked to ingest succeeds unless `failing` names it. */
function server(env: Record<string, string>, store: PlanningHashStore, failing: readonly string[] = []): Run {
	const substrate = new Substrate(loadConfig({ LIGHTRAG_URL: "http://lightrag.invalid", SUBSTRATE_DOCS_BACKEND: "lightrag", SUBSTRATE_PLANNING_ROOTS: dir, ...env }), {
		index: null,
		greptime: null,
		planningHashes: store,
	});
	const batches: string[][] = [];
	const datasets: string[] = [];
	const events: EventInput[] = [];
	spyOn(substrate, "emit").mockImplementation(async (event) => {
		events.push(event);
		return { event: normalizeEvent(event, null), stored: true };
	});
	spyOn(substrate, "ingestDocs").mockImplementation(async (input): Promise<IngestOutcome> => {
		const pages = (Array.isArray(input.pages) ? input.pages : []) as Array<{ path: string; source_url: string }>;
		const paths = pages.map((page) => page.path);
		batches.push(paths);
		datasets.push(input.dataset as string);
		return {
			ok: true,
			stripped_images: 0,
			changed: true,
			results: pages.map((page) => ({ path: page.path, source_url: page.source_url, status: failing.includes(page.path) ? ("failed" as const) : ("ingested" as const), document_id: `doc-${page.path}`, content_sha256: "x" })),
		};
	});
	return {
		batches,
		datasets,
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

	test("a checkout outside the repos root is filed under its checkout key, the dataset every batch names", async () => {
		const run = server(ON, memoryPlanningHashStore());
		await run.refresh();
		const checkout = planningSessionId(nodePlanningFs(), dir);
		expect(run.datasets.length).toBeGreaterThan(0);
		expect(run.datasets.every((dataset) => dataset === checkout)).toBe(true);
	});

	test("a page the plane failed is not stored, so the next process sends it again and only it", async () => {
		const store = memoryPlanningHashStore();
		await server(ON, store, [ROADMAP]).refresh();
		const checkout = planningSessionId(nodePlanningFs(), dir);
		expect([...(await store.load()).keys()]).toEqual([planningPageKey(checkout, STATE)]);

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

describe("two checkouts with the same relative path", () => {
	const A = "wt-a";
	const B = "wt-b";
	const page = (checkout: string, body: string): PlanningPage => ({ checkout, path: STATE, body });

	test("the store holds each checkout's hash under its own key", async () => {
		const store = memoryPlanningHashStore();
		await store.save(new Map([[planningPageKey(A, STATE), "hash-a"]]));
		await store.save(new Map([[planningPageKey(B, STATE), "hash-b"]]));
		const loaded = await store.load();
		expect(loaded.size).toBe(2);
		expect(loaded.get(planningPageKey(A, STATE))).toBe("hash-a");
		expect(loaded.get(planningPageKey(B, STATE))).toBe("hash-b");
	});

	test("an edit to one checkout's page triggers that page alone, not the same path in the other checkout", () => {
		const previous = new Map([[planningPageKey(A, STATE), planningPageSha(page(A, "alpha"))], [planningPageKey(B, STATE), planningPageSha(page(B, "beta"))]]);
		const trigger = planningIngestTrigger([page(A, "alpha"), page(B, "beta, edited")], previous);
		expect(trigger.triggered).toBe(true);
		expect(trigger.keys).toEqual([planningPageKey(B, STATE)]);
		expect(trigger.paths).toEqual([STATE]);
	});

	test("a first poll triggers both copies, and a repeat of the same pages triggers neither", () => {
		const pages = [page(A, "alpha"), page(B, "beta")];
		expect(planningIngestTrigger(pages, null).keys).toEqual([planningPageKey(A, STATE), planningPageKey(B, STATE)]);
		const previous = new Map(pages.map((p) => [planningPageKey(p.checkout, p.path), planningPageSha(p)] as const));
		expect(planningIngestTrigger(pages, previous).triggered).toBe(false);
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
