/**
 * Request-path efficiency (uplift-5 U5-3): `SUBSTRATE_BRIEF_GRAPH_READ`,
 * `SUBSTRATE_CACHE_BUMP_SCOPE` and the `/healthz` single flight with its capacity memo.
 *
 * Every store is a fake and every ordering is proved by a gate the test opens, not by a
 * guessed duration. The cache classes are proved end to end through `Substrate`, so a
 * policy that drops a generation from an entry is caught by a stale read, not by reading
 * the generation list: each class below is checked against the mutation that must
 * invalidate it and the one that must not.
 */
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { composeBrief } from "./brief.ts";
import { GRAPHS_GENERATION_KEY, MEMORY_GENERATION_KEY, RECALL_GENERATION_KEY, ReadThroughCache, type CacheRedis } from "./cache.ts";
import { loadConfig, requestPathConfigWarnings, type SubstrateConfig } from "./config.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import { IndexStore, type IndexCapacity } from "./index-store.ts";
import { FakeStore } from "./memory-write.test.ts";
import { createObservability } from "./observe.ts";
import { clearEnsuredBanks } from "./planes/hindsight.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import type { MemoryWriteResult } from "./types.ts";

// ── config ───────────────────────────────────────────────────────────────────

describe("request-path config", () => {
	test("unset flags are today's behaviour and warn about nothing", () => {
		const config = loadConfig({});
		expect(config.requestPath).toEqual({ briefGraphRead: "full", cacheBumpScope: "legacy", healthzIndexCapacityMemoS: 0, problems: [] });
		expect(requestPathConfigWarnings(config)).toEqual([]);
		// An empty value is unset, not a typo.
		expect(requestPathConfigWarnings(loadConfig({ SUBSTRATE_BRIEF_GRAPH_READ: " ", SUBSTRATE_CACHE_BUMP_SCOPE: "", SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: " " }))).toEqual([]);
	});

	test("the vocabulary is case- and space-insensitive and the memo is floored", () => {
		const config = loadConfig({ SUBSTRATE_BRIEF_GRAPH_READ: " LITE ", SUBSTRATE_CACHE_BUMP_SCOPE: "Narrow", SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: " 12 " });
		expect(config.requestPath).toEqual({ briefGraphRead: "lite", cacheBumpScope: "narrow", healthzIndexCapacityMemoS: 12, problems: [] });
	});

	test("a value outside the vocabulary keeps the default and is named, so a typo never switches a policy on", () => {
		const config = loadConfig({ SUBSTRATE_BRIEF_GRAPH_READ: "fast", SUBSTRATE_CACHE_BUMP_SCOPE: "wide", SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: "soon" });
		expect(config.requestPath).toMatchObject({ briefGraphRead: "full", cacheBumpScope: "legacy", healthzIndexCapacityMemoS: 0 });
		const warnings = requestPathConfigWarnings(config);
		expect(warnings).toHaveLength(3);
		expect(warnings.join("\n")).toContain('SUBSTRATE_BRIEF_GRAPH_READ="fast"');
		expect(warnings.join("\n")).toContain('SUBSTRATE_CACHE_BUMP_SCOPE="wide"');
		expect(warnings.join("\n")).toContain('SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S="soon"');
	});

	test("a fractional memo is floored and named, so 0.5 is not silently 0", () => {
		const half = loadConfig({ SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: "0.5" });
		expect(half.requestPath.healthzIndexCapacityMemoS).toBe(0);
		expect(requestPathConfigWarnings(half)).toHaveLength(1);
		const fraction = loadConfig({ SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: "12.9" });
		expect(fraction.requestPath.healthzIndexCapacityMemoS).toBe(12);
		expect(requestPathConfigWarnings(fraction)[0]).toContain("using 12 s");
	});

	test("the capacity memo is capped at 300 s and a negative one is refused", () => {
		const capped = loadConfig({ SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: "9999" });
		expect(capped.requestPath.healthzIndexCapacityMemoS).toBe(300);
		expect(requestPathConfigWarnings(capped)).toHaveLength(1);
		const negative = loadConfig({ SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: "-5" });
		expect(negative.requestPath.healthzIndexCapacityMemoS).toBe(0);
		expect(requestPathConfigWarnings(negative)).toHaveLength(1);
		expect(loadConfig({ SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: "300" }).requestPath.problems).toEqual([]);
	});
});

// ── the brief's graph read ───────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface FakeGraph {
	row: Row;
	nodes: Row[];
}

/**
 * A stand-in for the index connection that answers the graph statements by table and
 * remembers which tables were asked for, in order. `hold` keeps every statement open until
 * the test releases it, so concurrency is observable; `fail` rejects the named tables.
 */
function fakeSql(graphs: Record<string, FakeGraph>, options: { hold?: boolean; fail?: string[] } = {}): FakeSql {
	const statements: string[] = [];
	const open: Array<() => void> = [];
	let maxOpen = 0;
	const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> => {
		const table = /from (graph_\w+)/.exec(strings.join("?"))?.[1] ?? "unknown";
		statements.push(table);
		const id = String(values[0]);
		const graph = Object.hasOwn(graphs, id) ? graphs[id] : undefined;
		const rows = table === "graph_index" ? (graph ? [graph.row] : []) : table === "graph_nodes" ? (graph?.nodes ?? []) : [];
		const broken = options.fail?.includes(table) === true;
		return new Promise<Row[]>((resolve, reject) => {
			const settle = () => (broken ? reject(new Error(`${table} is down`)) : resolve(rows));
			if (!options.hold) return settle();
			open.push(settle);
			maxOpen = Math.max(maxOpen, open.length);
		});
	};
	return { sql, statements, open, maxOpen: () => maxOpen };
}

/** What `fakeSql` hands back: the connection stand-in and what it saw. */
interface FakeSql {
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;
	statements: string[];
	open: Array<() => void>;
	maxOpen: () => number;
}

function storeOn(fake: FakeSql): IndexStore {
	const store = new IndexStore("postgres://u@localhost/x");
	const internals = store as unknown as { sql: unknown };
	internals.sql = fake.sql;
	return store;
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function graphRow(overrides: Row = {}): Row {
	return {
		graph_id: "g1",
		notion_task_page: null,
		repo: "acme/app",
		branch: "main",
		surface: "cursor",
		status: "In Progress",
		pr_url: null,
		created: iso(-86_400_000),
		updated: iso(-60_000),
		...overrides,
	};
}

function nodeRow(nodeId: string, overrides: Row = {}): Row {
	return {
		graph_id: "g1",
		node_id: nodeId,
		linear_issue_id: null,
		linear_identifier: null,
		notion_page: null,
		state: "pending",
		claimed_by: null,
		claimed_at: null,
		claim_session: null,
		lease_id: null,
		lease_expires_at: null,
		lease_heartbeat_at: null,
		lease_epoch: 0,
		...overrides,
	};
}

/** Held, lapsed, finished, canceled, linked and plain nodes, in an order the brief must keep. */
function manyNodes(count: number): Row[] {
	return Array.from({ length: count }, (_, i) => {
		const id = `n${String(i).padStart(2, "0")}`;
		switch (i % 5) {
			case 0:
				return nodeRow(id, { state: "completed", claimed_by: "omp" });
			case 1:
				return nodeRow(id, { claimed_by: "cursor", claimed_at: iso(-3_600_000), claim_session: "s1", lease_id: `lease-${i}`, lease_expires_at: iso(600_000), lease_epoch: 1 });
			case 2:
				return nodeRow(id, { claimed_by: "hermes", claimed_at: iso(-7_200_000), claim_session: "s2", lease_id: `lease-${i}`, lease_expires_at: iso(-120_000), lease_epoch: 2 });
			case 3:
				return nodeRow(id, { state: "canceled" });
			default:
				return nodeRow(id, { linear_identifier: `LIN-${i}` });
		}
	});
}

const SHAPES: Array<{ name: string; graphs: Record<string, FakeGraph>; expects: string[] }> = [
	{ name: "a graph with no nodes", graphs: { g1: { row: graphRow(), nodes: [] } }, expects: ["In Progress · Agent cursor · PR none yet"] },
	{
		name: "many nodes: held, lapsed, done, canceled, linked",
		graphs: { g1: { row: graphRow(), nodes: manyNodes(40) } },
		expects: ["held by cursor 1h ago", "free — hermes's lease expired", "done (omp)", "n03 canceled", "n04 LIN-4 pending"],
	},
	{
		name: "held and lapsed leases only",
		graphs: { g1: { row: graphRow(), nodes: [manyNodes(3)[1] as Row, manyNodes(3)[2] as Row] } },
		expects: ["held by cursor", "lease expired"],
	},
	{
		name: "a graph with a pull request",
		graphs: { g1: { row: graphRow({ pr_url: "https://example.test/pr/1", status: "In Review" }), nodes: manyNodes(6) } },
		expects: ["In Review · Agent cursor · PR https://example.test/pr/1"],
	},
	{ name: "a graph the index does not hold", graphs: {}, expects: ["This graph is not in the index yet."] },
];

async function briefOf(store: IndexStore, mode: "full" | "lite") {
	const failed: string[] = [];
	const refreshAt: Array<number | null> = [];
	const index = {
		getGraph: (id: string) => store.getGraph(id),
		getGraphForBrief: (id: string) => store.getGraphForBrief(id),
		openGraphs: async () => [],
		memoryForBrief: async () => [],
	};
	const text = await composeBrief(
		{ repo: "acme/app", graph_id: "g1", surface: "cursor" },
		{ index: index as never, greptime: null },
		(at) => {
			refreshAt.push(at);
		},
		(source) => {
			failed.push(source);
		},
		{ graphRead: mode },
	);
	return { text, failed, refreshAt };
}

describe("SUBSTRATE_BRIEF_GRAPH_READ=lite", () => {
	beforeEach(() => setSystemTime(new Date(NOW)));
	afterEach(() => setSystemTime());

	for (const shape of SHAPES) {
		test(`the brief text, refresh deadline and failures are the same as full for ${shape.name}`, async () => {
			const full = await briefOf(storeOn(fakeSql(shape.graphs)), "full");
			const lite = await briefOf(storeOn(fakeSql(shape.graphs)), "lite");
			// Not vacuous: the shape renders what it was built to render.
			for (const fragment of shape.expects) expect(full.text).toContain(fragment);
			expect(lite.text).toBe(full.text);
			expect(lite.refreshAt).toEqual(full.refreshAt);
			expect(lite.failed).toEqual(full.failed);
			expect(lite.failed).toEqual([]);
		});
	}

	test("a graph-scoped read is two statements, not four, and they are in flight together", async () => {
		const graphs = { g1: { row: graphRow(), nodes: manyNodes(5) } };
		const full = fakeSql(graphs);
		await storeOn(full).getGraph("g1");
		expect(full.statements).toEqual(["graph_index", "graph_nodes", "graph_steps", "graph_edges"]);

		const held = fakeSql(graphs, { hold: true });
		const pending = storeOn(held).getGraphForBrief("g1");
		await settle();
		// Nothing has been answered and both statements are already asked for.
		expect(held.open).toHaveLength(2);
		expect(held.maxOpen()).toBe(2);
		for (const release of held.open.splice(0)) release();
		const view = await pending;
		expect(held.statements).toEqual(["graph_index", "graph_nodes"]);
		expect(view?.nodes).toHaveLength(5);
		expect(view?.steps).toEqual([]);
		expect(view?.edges).toEqual([]);

		// The full read, by contrast, is waiting on its first statement.
		const serial = fakeSql(graphs, { hold: true });
		const slow = storeOn(serial).getGraph("g1");
		await settle();
		expect(serial.open).toHaveLength(1);
		serial.open.splice(0)[0]?.();
		await settle();
		serial.open.splice(0)[0]?.();
		await settle();
		serial.open.splice(0)[0]?.();
		await settle();
		serial.open.splice(0)[0]?.();
		await slow;
	});

	test("a failed index read, or a failed node read under a row, is the same failed graph source as full", async () => {
		const graphs = { g1: { row: graphRow(), nodes: manyNodes(3) } };
		for (const table of ["graph_index", "graph_nodes"]) {
			const full = await briefOf(storeOn(fakeSql(graphs, { fail: [table] })), "full");
			const lite = await briefOf(storeOn(fakeSql(graphs, { fail: [table] })), "lite");
			expect(full.failed).toEqual(["graph"]);
			expect(lite.failed).toEqual(["graph"]);
			expect(lite.text).toBe(full.text);
		}
	});

	test("a node read that fails for a graph with no row is a missing graph, as it is for full", async () => {
		const full = await briefOf(storeOn(fakeSql({}, { fail: ["graph_nodes"] })), "full");
		const lite = await briefOf(storeOn(fakeSql({}, { fail: ["graph_nodes"] })), "lite");
		expect(full.failed).toEqual([]);
		expect(lite.failed).toEqual([]);
		expect(lite.text).toBe(full.text);
		expect(lite.text).toContain("This graph is not in the index yet.");
	});

	test("the service reads the lite view only when the flag says so", async () => {
		const calls: string[] = [];
		const index = {
			getGraph: async () => {
				calls.push("full");
				return null;
			},
			getGraphForBrief: async () => {
				calls.push("lite");
				return null;
			},
			openGraphs: async () => [],
			memoryForBrief: async () => [],
		};
		const request = { surface: "cursor" as const, repo: "acme/app", graph_id: "g1" };
		await new Substrate(loadConfig({}), { index: index as never, greptime: null, steering: { history: null, liveSessions: null } }).brief(request);
		await new Substrate(loadConfig({ SUBSTRATE_BRIEF_GRAPH_READ: "lite" }), { index: index as never, greptime: null, steering: { history: null, liveSessions: null } }).brief(request);
		expect(calls).toEqual(["full", "lite"]);
	});
});

// ── cache invalidation scope ─────────────────────────────────────────────────

class FakeRedis implements CacheRedis {
	readonly values = new Map<string, string>();

	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}

	async set(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}

	async incr(key: string): Promise<number> {
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

function hindsightEnv(): () => void {
	const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	process.env.HINDSIGHT_URL = "http://fake";
	process.env.HINDSIGHT_API_KEY = "test-bearer";
	process.env.HINDSIGHT_BANKS = "sub-cursor";
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

const GRANTS = `[{"surfaces":["cursor"],"scopes":["graph"],"kinds":["fact","decision"]}]`;
const REPO_REQUEST = { surface: "cursor" as const, repo: "acme/app" };
const GRAPH_REQUEST = { surface: "cursor" as const, repo: "acme/app", graph_id: "ut-1" };
const RULE = "fence every handoff";

/** One substrate over fakes, and what a test needs to drive and observe it. */
interface World {
	substrate: Substrate;
	redis: FakeRedis;
	fake: HindsightFake;
	/** Index reads the cache is supposed to save, by class. */
	loads: { brief: number; graph: number; page: number; search: number };
	state: { status: string; lease: string };
	write: (text: string) => Promise<MemoryWriteResult>;
	/** Open the held retains and wait for every forward to finish. */
	landRetains: () => Promise<void>;
	recalled: () => Promise<string[]>;
	searched: () => Promise<string[]>;
	paged: () => Promise<string[]>;
}

async function withWorld(env: Record<string, string>, run: (world: World) => Promise<void>): Promise<void> {
	const restore = hindsightEnv();
	clearEnsuredBanks();
	try {
		await run(build(env));
	} finally {
		restore();
	}
}

/**
 * The memory-write store with a graph, a searchable index and a recording Hindsight
 * whose retains are held until `landRetains()`.
 */
function build(env: Record<string, string>): World {
	const store = new FakeStore();
	const state = { status: "active", lease: new Date(Date.now() + 3_600_000).toISOString() };
	const loads = { brief: 0, graph: 0, page: 0, search: 0 };
	const graphView = () => ({
		graph_id: "ut-1",
		notion_task_page: null,
		repo: "acme/app",
		branch: null,
		surface: "cursor",
		status: state.status,
		pr_url: null,
		created: null,
		updated: null,
		nodes: [
			{
				graph_id: "ut-1",
				node_id: "n1",
				linear_issue_id: null,
				linear_identifier: null,
				notion_page: null,
				state: "in_progress",
				claimed_by: "cursor",
				claimed_at: new Date(Date.now() - 600_000).toISOString(),
				claim_session: "s1",
				lease_id: "lease-1",
				lease_expires_at: state.lease,
				lease_heartbeat_at: null,
				lease_epoch: 1,
			},
		],
		steps: [],
		edges: [],
	});
	const index = Object.assign(store, {
		async memoryForBrief() {
			loads.brief += 1;
			return store.standing();
		},
		async getGraph() {
			loads.graph += 1;
			return graphView();
		},
		async registerGraph(plan: { status?: string }) {
			state.status = plan.status ?? state.status;
			return graphView();
		},
		async heartbeatNode() {
			state.lease = new Date(Date.parse(state.lease) + 3_600_000).toISOString();
			return { ok: true, node: graphView().nodes[0], lease: { holder: null }, decision: { ok: true } };
		},
		async searchMemory() {
			loads.search += 1;
			return store.standing();
		},
		async searchMemoryPage() {
			loads.page += 1;
			return { entries: store.standing(), next: null };
		},
	});
	const fake = new HindsightFake();
	fake.seed("sub-cursor", []);
	const gate = Promise.withResolvers<void>();
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if ((init?.method ?? "GET").toUpperCase() === "POST" && new URL(href).pathname.endsWith("/memories")) await gate.promise;
		return fake.fetch(input, init);
	};
	const redis = new FakeRedis();
	const substrate = new Substrate(loadConfig({ SUBSTRATE_MEMORY_GRANTS: GRANTS, ...env }), {
		index: index as never,
		steering: { history: null, liveSessions: null },
		greptime: null,
		cache: new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => 1_000 }),
		hindsightFetch: fetch,
	});
	const write = (text: string) =>
		substrate.writeMemory({ scope: "graph:ut-1", kind: "decision", subject: "handoff-rule", text, writer: "cursor", source_event: "evt_e2e" });
	return {
		substrate,
		redis,
		fake,
		loads,
		state,
		write,
		/** Open the held retains and wait for every forward to finish. */
		landRetains: async () => {
			gate.resolve();
			await substrate.drainPendingRetains(5000);
		},
		recalled: async () => (await substrate.recallMemories({ query: "handoff" }, "cursor")).results.map((hit) => hit.text),
		searched: async () => (await substrate.searchMemory("handoff", undefined, undefined, undefined, "cursor")).derived.map((hit) => hit.text),
		paged: async () => (await substrate.searchMemoryPage({ query: "handoff" }, "cursor")).entries.map((entry) => entry.text),
	};
}

const SCOPES = ["legacy", "narrow"] as const;

describe("SUBSTRATE_CACHE_BUMP_SCOPE", () => {
	for (const scope of SCOPES) {
		// The flag only moves the retain's bump; everything an accepted write changes is visible at once in both.
		describe(scope, () => {
			test("brief: an accepted write is seen at once; the retain flushes the brief under legacy only", async () => {
				await withWorld({ SUBSTRATE_CACHE_BUMP_SCOPE: scope }, async (world) => {
					expect(await world.substrate.brief(GRAPH_REQUEST)).not.toContain(RULE);
					expect(world.loads.brief).toBe(1);

					const written = await world.write(RULE);
					expect(written.outcome).toBe("accepted");
					// The retain is still held, so this brief is cached between the accept and the retain.
					expect(await world.substrate.brief(GRAPH_REQUEST)).toContain(RULE);
					expect(world.loads.brief).toBe(2);

					await world.landRetains();
					expect(world.fake.retains).toHaveLength(1);
					expect(await world.substrate.brief(GRAPH_REQUEST)).toContain(RULE);
					expect(await world.substrate.brief(REPO_REQUEST)).toContain(RULE);
					// Narrow: one flush for the whole write. Legacy: the retain flushed the graph brief again, and the repo brief
					// that had never been read since the accept is a first read in both.
					expect(world.loads.brief).toBe(scope === "narrow" ? 3 : 4);
					expect(world.redis.values.get(MEMORY_GENERATION_KEY)).toBe(scope === "narrow" ? "1" : "2");
					expect(world.redis.values.get(RECALL_GENERATION_KEY)).toBe(scope === "narrow" ? "1" : undefined);
				});
			});

			test("memory search (paged, index only): the accept flushes it, the retain does not under narrow", async () => {
				await withWorld({ SUBSTRATE_CACHE_BUMP_SCOPE: scope }, async (world) => {
					expect(await world.paged()).toEqual([]);
					await world.write(RULE);
					expect(await world.paged()).toEqual([RULE]);
					expect(world.loads.page).toBe(2);
					await world.landRetains();
					expect(await world.paged()).toEqual([RULE]);
					expect(world.loads.page).toBe(scope === "narrow" ? 2 : 3);
				});
			});

			test("memory search (merged) and recall search: a retain that lands is never hidden behind a recall cached in the gap", async () => {
				await withWorld({ SUBSTRATE_CACHE_BUMP_SCOPE: scope }, async (world) => {
					await world.write(RULE);
					// The accept has flushed everything and the retain is still held: Hindsight has nothing, and both answers are cached that way.
					expect(await world.recalled()).toEqual([]);
					expect(await world.searched()).toEqual([]);
					await world.landRetains();
					expect(world.fake.retains).toHaveLength(1);
					// Only the retain changed Hindsight, so only the retain's own bump can have flushed these two entries.
					expect(await world.recalled()).toContain(RULE);
					expect(await world.searched()).toContain(RULE);
				});
			});

			test("graph view and brief: a heartbeat flushes the graph view; the brief keeps its entry under narrow, and shows the same text", async () => {
				await withWorld({ SUBSTRATE_CACHE_BUMP_SCOPE: scope }, async (world) => {
					const before = await world.substrate.brief(GRAPH_REQUEST);
					const repoBefore = await world.substrate.brief(REPO_REQUEST);
					const viewBefore = await world.substrate.getGraph("ut-1", "cursor");
					expect(world.loads.brief).toBe(2);
					expect(world.loads.graph).toBe(2);

					const beat = await world.substrate.heartbeatNode("ut-1", "n1", "lease-1", "cursor", 3600);
					expect(beat.ok).toBe(true);

					// A heartbeat never changes what a brief prints, so what is served is the same either way.
					expect(await world.substrate.brief(GRAPH_REQUEST)).toBe(before);
					expect(await world.substrate.brief(REPO_REQUEST)).toBe(repoBefore);
					expect(world.loads.brief).toBe(scope === "narrow" ? 2 : 3);
					// The graph view prints the lease expiry, so it is flushed by a heartbeat under both, and is current.
					const viewAfter = await world.substrate.getGraph("ut-1", "cursor");
					expect(viewAfter?.nodes[0]?.lease_expires_at).not.toBe(viewBefore?.nodes[0]?.lease_expires_at);
					expect(viewAfter?.nodes[0]?.lease_expires_at).toBe(world.state.lease);
					expect(world.redis.values.get(GRAPHS_GENERATION_KEY)).toBeUndefined();
				});
			});

			test("graph write: every cached brief, the merged search and the graph view are flushed and current", async () => {
				await withWorld({ SUBSTRATE_CACHE_BUMP_SCOPE: scope }, async (world) => {
					expect(await world.substrate.brief(GRAPH_REQUEST)).toContain("active");
					await world.substrate.brief(REPO_REQUEST);
					await world.searched();
					await world.substrate.getGraph("ut-1", "cursor");
					const briefs = world.loads.brief;
					const searches = world.loads.search;
					const views = world.loads.graph;

					await world.substrate.registerGraph({ graph_id: "ut-1", status: "blocked" } as never);

					expect(await world.substrate.brief(GRAPH_REQUEST)).toContain("blocked");
					await world.substrate.brief(REPO_REQUEST);
					await world.searched();
					expect((await world.substrate.getGraph("ut-1", "cursor"))?.status).toBe("blocked");
					expect(world.loads.brief).toBe(briefs + 2);
					expect(world.loads.search).toBe(searches + 1);
					expect(world.loads.graph).toBeGreaterThan(views);
				});
			});

			test("an accepted write flushes a recall cached before it, ahead of its retain", async () => {
				await withWorld({ SUBSTRATE_CACHE_BUMP_SCOPE: scope }, async (world) => {
					expect(await world.recalled()).toEqual([]);
					const asked = world.fake.recalls().length;
					await world.recalled();
					expect(world.fake.recalls().length).toBe(asked);
					await world.write(RULE);
					// The accept moved the memory generation, which the recall entry lists under both scopes: this one asks Hindsight again.
					expect(await world.recalled()).toEqual([]);
					expect(world.fake.recalls().length).toBe(asked + 1);
				});
			});

			test("an outbox replay is the retain landing: recall is current, the brief and paged search flush under legacy only", async () => {
				await withWorld({ SUBSTRATE_CACHE_BUMP_SCOPE: scope }, async (world) => {
					world.fake.failRetainWith = 503;
					await world.write(RULE);
					await world.landRetains();
					expect(world.substrate.retainOutboxStats().size).toBe(1);
					expect(await world.substrate.brief(GRAPH_REQUEST)).toContain(RULE);
					expect(await world.paged()).toEqual([RULE]);
					expect(await world.recalled()).toEqual([]);
					const briefs = world.loads.brief;
					const pages = world.loads.page;

					world.fake.failRetainWith = null;
					await world.substrate.drainRetainOutbox({ all: true });
					expect(world.substrate.retainOutboxStats().size).toBe(0);

					expect(await world.recalled()).toContain(RULE);
					await world.substrate.brief(GRAPH_REQUEST);
					await world.paged();
					expect(world.loads.brief).toBe(scope === "narrow" ? briefs : briefs + 1);
					expect(world.loads.page).toBe(scope === "narrow" ? pages : pages + 1);
				});
			});
		});
	}

	test("the default is legacy: a retain moves the memory generation and nothing writes the recall one", async () => {
		await withWorld({}, async (world) => {
			await world.write(RULE);
			await world.landRetains();
			expect(world.redis.values.get(MEMORY_GENERATION_KEY)).toBe("2");
			expect(world.redis.values.has(RECALL_GENERATION_KEY)).toBe(false);
		});
	});
});

// ── /healthz ─────────────────────────────────────────────────────────────────

/** Poll until `condition` holds; the polled facts are counters the server's own code moves. */
async function until(condition: () => boolean): Promise<void> {
	// One turn of the event loop per check: the counters move when the server's own callbacks run, so no wall-clock wait is needed.
	for (let i = 0; i < 5000 && !condition(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
	expect(condition()).toBe(true);
}

const SIZE: IndexCapacity = { databaseBytes: 1000, tables: [], graphNodes: null };

describe("GET /healthz single flight", () => {
	const running: Array<() => void> = [];
	afterAll(() => {
		for (const close of running) close();
	});

	/** A server whose `/healthz` arrivals are counted by the one place the handler reads `healthzCacheMs`. */
	async function serve(env: Record<string, string>, index: Record<string, unknown>) {
		const config: SubstrateConfig = loadConfig(env);
		let arrivals = 0;
		const ttl = config.healthzCacheMs;
		Object.defineProperty(config, "healthzCacheMs", {
			enumerable: true,
			get() {
				arrivals += 1;
				return ttl;
			},
		});
		const observability = createObservability(config, env);
		await observability.start();
		const substrate = new Substrate(config, { index: index as never, greptime: null, steering: { history: null, liveSessions: null } }, observability.observer);
		const server = createHttpServer(substrate, config, observability, { now: () => 1_000_000 });
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address() as AddressInfo;
		const base = `http://127.0.0.1:${address.port}`;
		running.push(() => {
			observability.stop();
			server.close();
		});
		return { base, substrate, arrivals: () => arrivals };
	}

	function slowIndex() {
		const gate = Promise.withResolvers<boolean>();
		const calls = { ping: 0, capacity: 0 };
		return {
			gate,
			calls,
			index: {
				ping: () => {
					calls.ping += 1;
					return gate.promise;
				},
				capacity: async () => {
					calls.capacity += 1;
					return SIZE;
				},
			},
		};
	}

	test("probes that arrive while a compute runs share it: one ping, one answer", async () => {
		const slow = slowIndex();
		const harness = await serve({ SUBSTRATE_HEALTHZ_CACHE_MS: "5000" }, slow.index);
		const probes = Array.from({ length: 6 }, () => fetch(`${harness.base}/healthz`));
		await until(() => harness.arrivals() === 6);
		expect(slow.calls.ping).toBe(1);
		slow.gate.resolve(true);
		const bodies = await Promise.all((await Promise.all(probes)).map(async (response) => ({ status: response.status, body: (await response.json()) as { index: boolean; cachedAt: string; stale: boolean } })));
		expect(slow.calls.ping).toBe(1);
		for (const answer of bodies) {
			expect(answer.status).toBe(200);
			expect(answer.body.index).toBe(true);
			expect(answer.body.cachedAt).toBe(bodies[0]?.body.cachedAt as string);
			// They waited for a compute; none of them was served from the memo.
			expect(answer.body.stale).toBe(false);
		}
		// And the next probe inside the window is the memo.
		const next = (await (await fetch(`${harness.base}/healthz`)).json()) as { stale: boolean };
		expect(next.stale).toBe(true);
		expect(slow.calls.ping).toBe(1);
	});

	test("a compute that throws fails its joiners and is not joined by the next probe", async () => {
		const slow = slowIndex();
		const harness = await serve({ SUBSTRATE_HEALTHZ_CACHE_MS: "5000" }, slow.index);
		const gate = Promise.withResolvers<never>();
		spyOn(harness.substrate, "health").mockImplementationOnce(() => gate.promise);
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const probes = [fetch(`${harness.base}/healthz`), fetch(`${harness.base}/healthz`), fetch(`${harness.base}/healthz`)];
			await until(() => harness.arrivals() === 3);
			gate.reject(new Error("boom"));
			expect((await Promise.all(probes)).map((response) => response.status)).toEqual([500, 500, 500]);
			slow.gate.resolve(true);
			const recovered = await fetch(`${harness.base}/healthz`);
			expect(recovered.status).toBe(200);
			expect(slow.calls.ping).toBe(1);
		} finally {
			stderr.mockRestore();
		}
	});

	test("with the memo off every concurrent probe computes, as before", async () => {
		const slow = slowIndex();
		const harness = await serve({ SUBSTRATE_HEALTHZ_CACHE_MS: "0" }, slow.index);
		const probes = Array.from({ length: 3 }, () => fetch(`${harness.base}/healthz`));
		await until(() => harness.arrivals() === 3);
		await until(() => slow.calls.ping === 3);
		slow.gate.resolve(true);
		for (const response of await Promise.all(probes)) expect(response.status).toBe(200);
		expect(slow.calls.ping).toBe(3);
	});
});

describe("SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S", () => {
	beforeEach(() => setSystemTime(new Date(NOW)));
	afterEach(() => setSystemTime());

	function substrateWith(env: Record<string, string>, capacity: () => Promise<IndexCapacity>) {
		const samples: number[] = [];
		const calls = { capacity: 0 };
		const index = {
			ping: async () => true,
			capacity: () => {
				calls.capacity += 1;
				return capacity();
			},
		};
		const substrate = new Substrate(loadConfig(env), { index: index as never, greptime: null, steering: { history: null, liveSessions: null } }, { capacity: (sample: { databaseBytes: number }) => samples.push(sample.databaseBytes) });
		return { substrate, calls, samples };
	}

	test("unset, every computed body measures the capacity", async () => {
		const { substrate, calls, samples } = substrateWith({}, async () => SIZE);
		expect((await substrate.health()).capacity.index).toEqual(SIZE);
		await substrate.health();
		expect(calls.capacity).toBe(2);
		expect(samples).toEqual([1000, 1000]);
	});

	test("a report is reused for the memo and measured again when it ages out", async () => {
		const { substrate, calls, samples } = substrateWith({ SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: "60" }, async () => ({ ...SIZE, databaseBytes: 1000 + calls.capacity }));
		expect((await substrate.health()).capacity.index?.databaseBytes).toBe(1001);
		setSystemTime(new Date(NOW + 59_999));
		expect((await substrate.health()).capacity.index?.databaseBytes).toBe(1001);
		expect(calls.capacity).toBe(1);
		setSystemTime(new Date(NOW + 60_000));
		expect((await substrate.health()).capacity.index?.databaseBytes).toBe(1002);
		expect(calls.capacity).toBe(2);
		// One runway sample per measurement, not per body.
		expect(samples).toEqual([1001, 1002]);
	});

	test("a wall clock that steps back expires the report instead of reusing it forever", async () => {
		const { substrate, calls } = substrateWith({ SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: "60" }, async () => SIZE);
		await substrate.health();
		setSystemTime(new Date(NOW - 3_600_000));
		await substrate.health();
		expect(calls.capacity).toBe(2);
	});

	test("the memo is capped: a larger setting reuses a report for 300 s and no longer", async () => {
		const { substrate, calls } = substrateWith({ SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: "99999" }, async () => SIZE);
		await substrate.health();
		setSystemTime(new Date(NOW + 299_999));
		await substrate.health();
		expect(calls.capacity).toBe(1);
		setSystemTime(new Date(NOW + 300_000));
		await substrate.health();
		expect(calls.capacity).toBe(2);
	});

	test("a measurement that fails stores nothing: the next body measures again", async () => {
		let failing = true;
		const { substrate, calls } = substrateWith({ SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: "60" }, async () => {
			if (failing) throw new Error("index is down");
			return SIZE;
		});
		expect((await substrate.health()).capacity.index).toBeNull();
		failing = false;
		expect((await substrate.health()).capacity.index).toEqual(SIZE);
		expect(calls.capacity).toBe(2);
	});

	test("bodies computed while a measurement is running join it", async () => {
		const gate = Promise.withResolvers<IndexCapacity>();
		const { substrate, calls } = substrateWith({ SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S: "60" }, () => gate.promise);
		const bodies = [substrate.health(), substrate.health(), substrate.health()];
		gate.resolve(SIZE);
		for (const body of await Promise.all(bodies)) expect(body.capacity.index).toEqual(SIZE);
		expect(calls.capacity).toBe(1);
	});
});
