/**
 * Cross-session recall in the brief, end to end (uplift-4 S5): the service
 * with a fake index, a fake cache server and the fake banks server. Proves the
 * default (`off`) is byte-identical to the pre-change brief with zero
 * Hindsight calls, `shadow` measures and serves today's text, `enforce`
 * appends the section from the fan-out answer (cached when fresh, else live), the mode is in every key the
 * text lives under, the compact profile drops the section first, and the
 * prefetcher reads the surface's OWN bank only.
 */
import { describe, expect, test } from "bun:test";
import { SubstrateInstruments, findCounter, sumCounter } from "@substrate/observability";
import { MAX_BRIEF_NODES, MAX_NODE_LABEL_CHARS, composeBrief } from "./brief.ts";
import { MAX_ENCODED_CHARS, decodeSections, encodeSections, utf8Bytes } from "./brief-profile.ts";
import { CACHE_TTL, GRAPHS_GENERATION_KEY, MEMORY_GENERATION_KEY, ReadThroughCache, cacheKey, classOf, snapshotKey, type CacheKeyClass, type CacheRedis } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import { resolveRecallBanks } from "./memory-recall.ts";
import { FakeStore } from "./memory-write.test.ts";
import { clearEnsuredBanks } from "./planes/hindsight.ts";
import { RECALL_TITLE_PREFIX, buildRecallQuery, fanoutSnapshotArgs, recallSnapshotArgs, type RecallSnapshot } from "./recall-snapshot.ts";
import { Substrate, briefEtag, type SubstrateObserver } from "./service.ts";

const SECRET = `ghp_${"a".repeat(40)}`;
const REQUEST = { repo: "acme/app", surface: "grok-bot" } as const;
const WITH_GRAPH = { ...REQUEST, graph_id: "ut-1" } as const;
const OWN_BANK = "sub-grok-bot";
const REPO = "acme/app";
const CONFIGURED = ["sub-omp", "sub-hermes", "sub-cursor", OWN_BANK];
const ENFORCE = { SUBSTRATE_BRIEF_RECALL: "enforce" };

// ── fixtures ─────────────────────────────────────────────────────────────────

function entry(kind: "decision" | "warning", text: string, extra: Record<string, unknown> = {}) {
	return {
		id: `m-${kind}-${text.length}`,
		kind,
		text,
		writer: "hermes",
		trust: "human-confirmed",
		version: 1,
		created: new Date(Date.now() - 3 * 3_600_000).toISOString(),
		...extra,
	};
}

/** Long enough that the compact rendering is past the 512-byte cap floor. */
const MEMORY = [
	entry("decision", `quote versions in every conflict reply ${"a".repeat(180)}`, { subject: "lease fencing" }),
	entry("decision", `never retain unredacted text ${"b".repeat(180)}`, { subject: "retain hygiene" }),
	entry("decision", `brief reads recall from the cache ${"c".repeat(180)}`),
	entry("warning", `the bank prefix is sub- ${"d".repeat(180)}`, { subject: "bank prefix" }),
];

function graph() {
	return {
		graph_id: "ut-1",
		notion_task_page: null,
		repo: "acme/app",
		branch: "main",
		surface: "grok-bot",
		status: "active",
		pr_url: null,
		created: null,
		updated: null,
		nodes: [{ graph_id: "ut-1", node_id: "n1", linear_identifier: null, state: "todo", lease_epoch: 1 }],
		steps: [],
		edges: [],
	};
}

function indexOf(options: { failGraph?: () => boolean; nodes?: number; memory?: typeof MEMORY } = {}) {
	return {
		getGraph: async () => {
			if (options.failGraph?.()) throw new Error("postgres is down");
			const view = graph();
			if (options.nodes !== undefined) {
				view.nodes = Array.from({ length: options.nodes }, (_, i) => ({ graph_id: "ut-1", node_id: `n${i}`, linear_identifier: null, state: "todo", lease_epoch: 1 }));
			}
			return view;
		},
		openGraphs: async () => [],
		memoryForBrief: async () => options.memory ?? MEMORY,
	};
}

class FakeRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	readonly ttls = new Map<string, number>();
	failRecallGet = false;
	failRecallSet = false;
	async get(key: string): Promise<string | null> {
		if (this.failRecallGet && classOf(key) === "recall-snapshot") throw new Error("cache read failed");
		return this.values.get(key) ?? null;
	}
	async set(key: string, value: string, ttlSeconds: number): Promise<void> {
		if (this.failRecallSet && classOf(key) === "recall-snapshot") throw new Error("cache write failed");
		this.values.set(key, value);
		this.ttls.set(key, ttlSeconds);
	}
	async incr(key: string): Promise<number> {
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
	keysOf(klass: CacheKeyClass): string[] {
		return [...this.values.keys()].filter((key) => classOf(key) === klass);
	}
}

/** Point the Hindsight env reads at the fake for one test, with several banks configured; restores every touched variable. */
async function withHindsight<T>(body: () => Promise<T>): Promise<T> {
	const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	process.env.HINDSIGHT_URL = "http://fake";
	process.env.HINDSIGHT_API_KEY = "test-bearer";
	process.env.HINDSIGHT_BANKS = `sub-omp,sub-hermes,sub-cursor,${OWN_BANK}`;
	clearEnsuredBanks();
	try {
		return await body();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function seedBanks(fake: HindsightFake): void {
	fake.seed(OWN_BANK, [
		{ id: "g1", text: "use pnpm, not npm", document_id: "mwd_g1", type: "world", tags: [], metadata: { scope: "repo:acme/app" }, score: 0.9 },
		{ id: "g2", text: "another repo's rule", document_id: "mwd_g2", tags: [], metadata: { scope: "repo:acme/other" }, score: 0.8 },
		{ id: "g3", text: `deploy token ${SECRET} rotates weekly`, document_id: "mwd_g3", tags: [], metadata: { scope: "repo:acme/app" }, score: 0.7 },
	]);
	// The other banks rank below the own bank's hits, so the brief's first lines are the surface's own memories.
	for (const other of ["sub-omp", "sub-hermes", "sub-cursor"]) {
		fake.seed(other, [{ id: `${other}-1`, text: `private to ${other}`, document_id: `${other}-doc`, tags: [], metadata: { scope: "repo:acme/app" }, score: 0.5 }]);
	}
}

interface World {
	substrate: Substrate;
	redis: FakeRedis;
	cache: ReadThroughCache;
	fake: HindsightFake;
	instruments: SubstrateInstruments;
	briefRecall: Array<{ surface: string; result: string }>;
	prefetch: Array<{ surface: string; result: string }>;
}

function world(env: Record<string, string>, options: { redis?: FakeRedis; fake?: HindsightFake; index?: object; cacheOff?: boolean } = {}): World {
	const redis = options.redis ?? new FakeRedis();
	const fake = options.fake ?? new HindsightFake();
	if (options.fake === undefined) seedBanks(fake);
	const cache = options.cacheOff === true ? new ReadThroughCache({ redis: null, enabled: false, log: () => {} }) : new ReadThroughCache({ redis, enabled: true, log: () => {} });
	const instruments = new SubstrateInstruments();
	const briefRecall: World["briefRecall"] = [];
	const prefetch: World["prefetch"] = [];
	const observer: SubstrateObserver = {
		briefRecall: (sample) => {
			briefRecall.push(sample);
			instruments.recordBriefRecall(sample as never);
		},
		recallPrefetch: (sample) => {
			prefetch.push(sample);
			instruments.recordRecallPrefetch(sample as never);
		},
		hindsightOutbox: (sample) => instruments.setHindsightOutbox(sample),
	};
	const substrate = new Substrate(loadConfig(env), { index: (options.index ?? indexOf()) as never, greptime: null, cache, hindsightFetch: fake.fetch }, observer);
	return { substrate, redis, cache, fake, instruments, briefRecall, prefetch };
}

/** Write the own-bank prefetch snapshot the way the prefetcher would, `ageMs` old: the brief's recall metric reads it as its `look`. The section is the fan-out answer (`seedFanout`). */
function seedSnapshot(redis: FakeRedis, ageMs: number, hits: RecallSnapshot["hits"] = [{ text: "use pnpm, not npm", type: "world" }], surface = "grok-bot"): void {
	const bank = `sub-${surface}`;
	const snapshot: RecallSnapshot = { bank, at: new Date(Date.now() - ageMs).toISOString(), hits };
	redis.values.set(snapshotKey("recall-snapshot", surface, recallSnapshotArgs("acme/app", bank)), JSON.stringify({ v: snapshot }));
}

/** The banks a surface's fan-out reads, sorted: the resolution the service makes from HINDSIGHT_BANKS. */
function fanoutBanks(surface: string): string[] {
	const resolved = resolveRecallBanks(surface, CONFIGURED, "sub-");
	if ("refused" in resolved) throw new Error(resolved.refused);
	return [...resolved.banks].sort();
}

/**
 * Write a fan-out answer the way the brief's read stores it, `ageMs` old, naming the surface's banks. The entry sits under the
 * key a read computes with both generations unset (each reads as 0), so it is held until a write moves one of them.
 */
function seedFanout(redis: FakeRedis, ageMs: number, hits: RecallSnapshot["hits"] = [{ text: "use pnpm, not npm", type: "world" }], surface = "grok-bot"): void {
	const snapshot: RecallSnapshot = { bank: `sub-${surface}`, banks: fanoutBanks(surface), at: new Date(Date.now() - ageMs).toISOString(), hits };
	const args = fanoutSnapshotArgs(REPO, fanoutBanks(surface), buildRecallQuery(REPO, []));
	const unsetGenerations = "0:0";
	redis.values.set(cacheKey("recall-snapshot", surface, unsetGenerations, args), JSON.stringify({ v: snapshot }));
}

function counted(instruments: SubstrateInstruments, name: string, where: Record<string, string> = {}): number {
	const counter = findCounter(instruments.snapshot(), name);
	return counter === null ? 0 : sumCounter(counter, where);
}

function gauge(instruments: SubstrateInstruments, name: string): number | null {
	const metric = instruments.snapshot().find((candidate) => candidate.name === name);
	return metric !== undefined && metric.kind === "gauge" ? (metric.points[0]?.value ?? null) : null;
}

const recalledRequests = (fake: HindsightFake) => fake.requests.filter((request) => request.path.endsWith("/memories/recall"));

// ── off: today's brief ───────────────────────────────────────────────────────

describe("SUBSTRATE_BRIEF_RECALL=off (the default)", () => {
	test("the text, the etag and the cache keys are today's and Hindsight is never called", async () => {
		await withHindsight(async () => {
			const w = world({});
			const detail = await w.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface);
			const expected = await composeBrief(WITH_GRAPH, { index: indexOf() as never, greptime: null }, undefined, undefined, { budgetMs: 1200, recentWindowDays: 30 });
			expect(detail.text).toBe(expected);
			expect(detail.etag).toBe(briefEtag(expected));
			expect(detail.text).not.toContain("Recalled context");
			// The last-good snapshot lives under the pre-S5 key: no recall field in its arguments.
			expect(w.redis.keysOf("brief-snapshot")).toEqual([snapshotKey("brief-snapshot", "grok-bot", { repo: "acme/app", branch: null, graph_id: "ut-1" })]);
			expect(w.redis.keysOf("recall-snapshot")).toEqual([]);
			expect(w.fake.requests).toEqual([]);
			expect(w.briefRecall).toEqual([]);
			expect(w.prefetch).toEqual([]);
		});
	});

	test("nothing starts and a tick or a flush calls nothing", async () => {
		await withHindsight(async () => {
			const w = world({});
			expect(w.substrate.startRecall()).toEqual({ recall: false, inventory: false });
			await w.substrate.briefDetailed(REQUEST, undefined, (REQUEST).surface);
			await w.substrate.runRecallTick();
			await w.substrate.flushRecallRetain();
			await w.substrate.stopRecall();
			expect(w.fake.requests).toEqual([]);
			expect(w.substrate.hindsightInventoryHealth()).toBeNull();
		});
	});
});

// ── shadow ───────────────────────────────────────────────────────────────────

describe("SUBSTRATE_BRIEF_RECALL=shadow", () => {
	test("the prefetch runs and would_include is counted, while the served text is exactly today's", async () => {
		await withHindsight(async () => {
			const off = world({});
			const baseline = await off.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface);

			const w = world({ SUBSTRATE_BRIEF_RECALL: "shadow" });
			const cold = await w.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface);
			expect(w.briefRecall).toEqual([{ surface: "grok-bot", result: "cold" }]);
			expect(w.fake.requests).toEqual([]);

			await w.substrate.runRecallTick();
			expect(recalledRequests(w.fake)).toHaveLength(1);
			expect(w.prefetch).toEqual([{ surface: "grok-bot", result: "ok" }]);
			const [key] = w.redis.keysOf("recall-snapshot");
			expect(key).toBeDefined();
			expect(w.redis.ttls.get(key!)).toBe(CACHE_TTL["recall-snapshot"]);

			await w.cache.bump(MEMORY_GENERATION_KEY);
			const warm = await w.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface);
			expect(w.briefRecall.at(-1)).toEqual({ surface: "grok-bot", result: "would_include" });
			expect(counted(w.instruments, "substrate.brief.recall", { result: "would_include" })).toBe(1);
			for (const served of [cold, warm]) {
				expect(served.text).toBe(baseline.text);
				expect(served.etag).toBe(baseline.etag);
			}
		});
	});

	test("a brief without a repo is counted disabled and registers nothing", async () => {
		await withHindsight(async () => {
			const w = world({ SUBSTRATE_BRIEF_RECALL: "shadow" });
			await w.substrate.briefDetailed({ surface: "grok-bot" }, undefined, ({ surface: "grok-bot" }).surface);
			await w.substrate.runRecallTick();
			expect(w.briefRecall).toEqual([{ surface: "grok-bot", result: "disabled" }]);
			expect(w.fake.requests).toEqual([]);
		});
	});
});

// ── enforce ──────────────────────────────────────────────────────────────────

describe("SUBSTRATE_BRIEF_RECALL=enforce", () => {
	test("a warm snapshot becomes the Recalled context section, with its bank and age, counted included", async () => {
		await withHindsight(async () => {
			// The query follows the subjects the last brief composed. With none, every brief here asks the same question, so a repeat brief's key is the first one's.
			const subjectFree = { index: indexOf({ memory: [] }) };
			const off = await world({}, subjectFree).substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			const w = world(ENFORCE, subjectFree);
			const cold = await w.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			expect(cold.text).toContain(RECALL_TITLE_PREFIX);
			expect(recalledRequests(w.fake)).toHaveLength(CONFIGURED.length);
			expect(w.briefRecall).toEqual([{ surface: "grok-bot", result: "included" }]);

			const fannedOut = recalledRequests(w.fake).length;
			// A graphs bump makes the brief itself miss; the held fan-out answer is served with no bank call.
			await w.cache.bump(GRAPHS_GENERATION_KEY);
			const warm = await w.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			expect(recalledRequests(w.fake)).toHaveLength(fannedOut);
			expect(w.briefRecall.at(-1)).toEqual({ surface: "grok-bot", result: "included" });
			const lines = warm.text.split("\n");
			const at = lines.findIndex((line) => line.startsWith(RECALL_TITLE_PREFIX));
			expect(at).toBeGreaterThan(0);
			expect(lines[at - 1]).toBe("");
			// The title names every bank that answered, and the age.
			for (const bank of CONFIGURED) expect(lines[at]).toContain(bank);
			expect(lines[at]).toContain("<1m old):");
			expect(lines.slice(at + 1)).toEqual(["- use pnpm, not npm (world)", "- deploy token [REDACTED] rotates weekly", "- private to sub-omp"]);
			expect(warm.etag).not.toBe(off.etag);
			expect(warm.text.slice(0, off.text.length)).toBe(off.text);
		});
	});

	test("a stale fan-out answer, a cold one and a failing cache each fan out live and keep the section; a failing store leaves the brief complete", async () => {
		await withHindsight(async () => {
			const stale = world(ENFORCE);
			// Older than the 900 s TTL, inside the second half of its life: not fresh, so the brief asks the banks again.
			seedFanout(stale.redis, 1.5 * 900 * 1000);
			const staleBrief = await stale.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			expect(staleBrief.text).toContain(RECALL_TITLE_PREFIX);
			expect(recalledRequests(stale.fake)).toHaveLength(CONFIGURED.length);
			expect(stale.briefRecall).toEqual([{ surface: "grok-bot", result: "included" }]);

			// Past twice the TTL the entry is cold even where the cache did not expire it: the same live fan-out.
			const ancient = world(ENFORCE);
			seedFanout(ancient.redis, 3 * 900 * 1000);
			expect((await ancient.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface)).text).toContain(RECALL_TITLE_PREFIX);
			expect(recalledRequests(ancient.fake)).toHaveLength(CONFIGURED.length);

			const cold = world(ENFORCE);
			expect((await cold.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface)).text).toContain(RECALL_TITLE_PREFIX);
			expect(recalledRequests(cold.fake)).toHaveLength(CONFIGURED.length);

			// A failing read answers live even when a fresh answer is stored.
			const failing = world(ENFORCE);
			seedFanout(failing.redis, 1000);
			failing.redis.failRecallGet = true;
			const failed = await failing.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			expect(failed.text).toContain(RECALL_TITLE_PREFIX);
			expect(failed.state).toBe("complete");
			expect(recalledRequests(failing.fake)).toHaveLength(CONFIGURED.length);

			// A failing store is no error to the brief: it is complete, carries its section, and keeps no answer.
			const unstored = world(ENFORCE);
			unstored.redis.failRecallSet = true;
			const brief = await unstored.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			expect(brief.state).toBe("complete");
			expect(brief.text).toContain(RECALL_TITLE_PREFIX);
			expect(unstored.redis.keysOf("recall-snapshot")).toEqual([]);
		});
	});

	test("a prefetch that fails stores nothing, and the brief still serves the stored fan-out answer", async () => {
		await withHindsight(async () => {
			const w = world(ENFORCE, { index: indexOf({ memory: [] }) });
			await w.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			const stored = w.redis.keysOf("recall-snapshot");
			expect(stored).toHaveLength(1);
			w.fake.failRecallWith = 500;
			await w.substrate.runRecallTick();
			expect(w.prefetch).toEqual([{ surface: "grok-bot", result: "error" }]);
			expect(w.redis.keysOf("recall-snapshot")).toEqual(stored);
			const afterTick = recalledRequests(w.fake).length;
			// A graphs bump makes the brief itself miss; the fan-out answer is keyed on memory and recall, so it stays held.
			await w.cache.bump(GRAPHS_GENERATION_KEY);
			const brief = await w.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			// Served from the answer the first brief stored: no bank is asked, and the section is there.
			expect(recalledRequests(w.fake)).toHaveLength(afterTick);
			expect(brief.text).toContain(RECALL_TITLE_PREFIX);
		});
	});

	test("a repeat brief within the TTL makes no Hindsight recall, and a brief after a memory generation bump fans out once", async () => {
		await withHindsight(async () => {
			// Subject-free memory: the query, so the key, is the same for every brief here.
			const w = world(ENFORCE, { index: indexOf({ memory: [] }) });
			await w.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			const fannedOut = recalledRequests(w.fake).length;
			expect(fannedOut).toBe(CONFIGURED.length);

			await w.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			expect(recalledRequests(w.fake)).toHaveLength(fannedOut);

			// The fan-out answer is keyed on the memory generation: a memory write makes the next brief fan out once more.
			await w.cache.bump(MEMORY_GENERATION_KEY);
			const after = await w.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			expect(recalledRequests(w.fake)).toHaveLength(fannedOut + CONFIGURED.length);
			expect(after.text).toContain(RECALL_TITLE_PREFIX);
		});
	});

	test("the degraded snapshot a failing source falls back to stores the recall lines but serves none of them", async () => {
		await withHindsight(async () => {
			let failing = false;
			const w = world({ SUBSTRATE_BRIEF_RECALL: "enforce" }, { index: indexOf({ failGraph: () => failing }) });
			seedFanout(w.redis, 1000);
			const complete = await w.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface);
			expect(complete.state).toBe("complete");
			expect(complete.text).toContain("- use pnpm, not npm (world)");
			const [snapshotEntry] = w.redis.keysOf("brief-snapshot");
			const stored = JSON.parse(w.redis.values.get(snapshotEntry!)!) as { v: { sections: Array<{ id: string }> } };
			expect(stored.v.sections.map((section) => section.id)).toContain("recall");

			failing = true;
			await w.cache.bump(MEMORY_GENERATION_KEY);
			const degraded = await w.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface);
			expect(degraded.state).toBe("snapshot");
			expect(degraded.text).not.toContain("Recalled context");
			expect(degraded.text).not.toContain("- use pnpm, not npm (world)");
		});
	});
});

// ── whose recall it is ───────────────────────────────────────────────────────

describe("recall belongs to the bearer's own surface", () => {
	const GROK_BUILD = { repo: "acme/app", graph_id: "ut-1", surface: "grok-build" } as const;

	test("a grok-bot bearer naming surface=grok-build gets no recall, registers nothing, and never meets the cached brief written for grok-build", async () => {
		await withHindsight(async () => {
			const redis = new FakeRedis();
			const fake = new HindsightFake();
			seedBanks(fake);
			seedFanout(redis, 1000, [{ text: "grok-build's private lesson" }], "grok-build");

			const real = world(ENFORCE, { redis, fake });
			const own = await real.substrate.briefDetailed(GROK_BUILD, undefined, "grok-build");
			expect(own.text).toContain(RECALL_TITLE_PREFIX);
			expect(own.text).toContain("- grok-build's private lesson");

			// Same cache, same plane: the spoofing caller's bearer is grok-bot.
			const spoof = world(ENFORCE, { redis, fake });
			const spoofed = await spoof.substrate.briefDetailed(GROK_BUILD, undefined, "grok-bot");
			expect(spoofed.text).not.toContain("Recalled context");
			expect(spoofed.text).not.toContain("grok-build's private lesson");
			expect(spoofed.text).not.toContain("sub-grok-build");
			expect(spoof.briefRecall).toEqual([{ surface: "grok-build", result: "disabled" }]);
			await spoof.substrate.runRecallTick();
			expect(spoof.prefetch).toEqual([]);
			expect(fake.requests).toEqual([]);
			// It still gets a real brief: the recall-off one, under the recall-off key.
			const plain = await world({}, { redis, fake }).substrate.briefDetailed(GROK_BUILD, undefined, "grok-build");
			expect(spoofed.text).toBe(plain.text);
			expect(spoofed.etag).toBe(plain.etag);
		});
	});

	test("an anonymous caller gets no recall either, whatever surface it names", async () => {
		await withHindsight(async () => {
			const w = world(ENFORCE);
			seedFanout(w.redis, 1000, [{ text: "grok-bot's own lesson" }]);
			for (const bearer of [undefined, null]) {
				const brief = await w.substrate.briefDetailed(WITH_GRAPH, undefined, bearer);
				expect(brief.text).not.toContain("Recalled context");
			}
			expect(w.briefRecall.map((sample) => sample.result)).toEqual(["disabled", "disabled"]);
			await w.substrate.runRecallTick();
			expect(w.fake.requests).toEqual([]);
		});
	});

	test("the bearer that IS the surface gets it, and a mismatched caller afterwards does not", async () => {
		await withHindsight(async () => {
			const w = world(ENFORCE);
			seedFanout(w.redis, 1000, [{ text: "grok-bot's own lesson" }]);
			expect((await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot")).text).toContain("- grok-bot's own lesson");
			expect((await w.substrate.briefDetailed(WITH_GRAPH, undefined, "omp")).text).not.toContain("grok-bot's own lesson");
		});
	});
});

describe("recall needs the cache", () => {
	test("with the cache off a brief is counted disabled, nothing is registered and no Hindsight call is made", async () => {
		await withHindsight(async () => {
			const w = world({ SUBSTRATE_BRIEF_RECALL: "enforce" }, { cacheOff: true });
			const brief = await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
			expect(brief.text).not.toContain("Recalled context");
			await w.substrate.runRecallTick();
			await w.substrate.flushRecallRetain();
			expect(w.briefRecall).toEqual([{ surface: "grok-bot", result: "disabled" }]);
			expect(w.prefetch).toEqual([]);
			expect(w.fake.requests).toEqual([]);
		});
	});
});

// ── keys ─────────────────────────────────────────────────────────────────────

describe("the bank is in every key the brief text lives under", () => {
	test("changing HINDSIGHT_BANK_PREFIX changes the answer key and the snapshot key; off keeps today's", async () => {
		await withHindsight(async () => {
			const redis = new FakeRedis();
			const fake = new HindsightFake();
			seedBanks(fake);
			seedFanout(redis, 1000);
			const before = await world({ SUBSTRATE_BRIEF_RECALL: "enforce" }, { redis, fake }).substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
			expect(before.text.split("\n").find((line) => line.startsWith(RECALL_TITLE_PREFIX))).toContain(OWN_BANK);
			const keysBefore = new Set([...redis.keysOf("brief"), ...redis.keysOf("brief-snapshot")]);
			expect(keysBefore.size).toBe(2);

			process.env.HINDSIGHT_BANK_PREFIX = "alt-";
			try {
				const after = await world({ SUBSTRATE_BRIEF_RECALL: "enforce" }, { redis, fake }).substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
				// The old entry is not served: a new bank has no snapshot yet, so no section, and new keys were written.
				expect(after.text).not.toContain(OWN_BANK);
				expect(after.text).not.toContain("Recalled context");
				const keysAfter = new Set([...redis.keysOf("brief"), ...redis.keysOf("brief-snapshot")]);
				expect(keysAfter.size).toBe(4);
				// Off keeps the pre-change key whatever the prefix.
				await world({}, { redis, fake }).substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
				expect(redis.keysOf("brief-snapshot")).toContain(snapshotKey("brief-snapshot", "grok-bot", { repo: "acme/app", branch: null, graph_id: "ut-1" }));
			} finally {
				delete process.env.HINDSIGHT_BANK_PREFIX;
			}
		});
	});
});

describe("the degraded last-good snapshot carries no derived recall", () => {
	test("a snapshot served because a source is down drops the recall section, in the text and the sections", async () => {
		await withHindsight(async () => {
			let failing = false;
			const w = world({ SUBSTRATE_BRIEF_RECALL: "enforce", SUBSTRATE_BRIEF_PROFILE: "enforce" }, { index: indexOf({ failGraph: () => failing }) });
			seedSnapshot(w.redis, 1000);
			const complete = await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
			expect(complete.text).toContain("Recalled context");
			failing = true;
			await w.cache.bump(MEMORY_GENERATION_KEY);
			for (const profile of ["full", "compact"] as const) {
				const degraded = await w.substrate.briefDetailed(WITH_GRAPH, profile, "grok-bot");
				expect(degraded.state).toBe("snapshot");
				expect(degraded.text).not.toContain("Recalled context");
				expect(degraded.text).not.toContain("use pnpm, not npm");
				expect(degraded.text).toContain("quote versions in every conflict reply");
			}
		});
	});
});

describe("node labels", () => {
	const labelled = (id: string) => ({
		...indexOf(),
		getGraph: async () => ({ ...graph(), nodes: [{ graph_id: "ut-1", node_id: id, linear_identifier: null, state: "todo", lease_epoch: 1 }] }),
	});

	test("a label of MAX_NODE_LABEL_CHARS characters prints whole; one more is cut with an ellipsis", async () => {
		const exact = await world({}, { index: labelled("n".repeat(MAX_NODE_LABEL_CHARS)) }).substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
		expect(exact.text).toContain(`Nodes: ${"n".repeat(MAX_NODE_LABEL_CHARS)} todo`);
		const over = await world({}, { index: labelled("n".repeat(MAX_NODE_LABEL_CHARS + 1)) }).substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
		expect(over.text).toContain(`Nodes: ${"n".repeat(MAX_NODE_LABEL_CHARS - 1)}… todo`);
	});

	test("the cut never splits a surrogate pair", async () => {
		const brief = await world({}, { index: labelled(`${"a".repeat(MAX_NODE_LABEL_CHARS - 2)}😀😀😀`) }).substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
		expect(brief.text).toContain(`${"a".repeat(MAX_NODE_LABEL_CHARS - 2)}😀… todo`);
		expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(brief.text)).toBe(false);
	});
});

describe("the largest brief the compose step allows", () => {
	test("the maximum node count with maximum-length labels encodes under the cache cap, decodes, and the second call is a cache hit", async () => {
		await withHindsight(async () => {
			const longest = (i: number) => `${i}`.padStart(6, "n") + "\"".repeat(MAX_NODE_LABEL_CHARS);
			const index = {
				...indexOf(),
				getGraph: async () => ({
					...graph(),
					nodes: Array.from({ length: MAX_BRIEF_NODES + 500 }, (_, i) => ({ graph_id: "ut-1", node_id: longest(i), linear_identifier: null, state: "todo", lease_epoch: 1 })),
				}),
			};
			const w = world({}, { index });
			const first = await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
			expect(first.state).toBe("complete");
			const [key] = w.redis.keysOf("brief");
			const entry = JSON.parse(w.redis.values.get(key!)!) as { v: string };
			expect(entry.v.length).toBeLessThan(MAX_ENCODED_CHARS * 0.75);
			expect(decodeSections(entry.v)).not.toBeNull();
			expect(decodeSections(encodeSections(decodeSections(entry.v)!))).not.toBeNull();
			const hits = w.cache.health().hits;
			const again = await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
			expect(again.text).toBe(first.text);
			expect(w.cache.health().hits).toBeGreaterThan(hits);
		});
	});
});

describe("a brief too large to cache", () => {
	test("is composed once: the live sections are used directly, never decoded back", async () => {
		const huge = [1, 2, 3, 4].map((n) => entry("decision", `d${n} ${"x".repeat(300_000)}`));
		let graphReads = 0;
		const index = { ...indexOf(), getGraph: async () => { graphReads += 1; return graph(); }, memoryForBrief: async () => huge };
		const w = world({}, { index });
		const first = await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
		expect(first.state).toBe("complete");
		expect(first.text).toContain("d4 ");
		expect(graphReads).toBe(1);
	});

	test("a node label is bounded at compose time", async () => {
		const index = {
			...indexOf(),
			getGraph: async () => ({ ...graph(), nodes: [{ graph_id: "ut-1", node_id: "n".repeat(5000), linear_identifier: null, state: "todo", lease_epoch: 1 }] }),
		};
		const w = world({}, { index });
		const brief = await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
		expect(brief.text).not.toContain("n".repeat(MAX_NODE_LABEL_CHARS + 100));
		expect(brief.text).toContain(`${"n".repeat(MAX_NODE_LABEL_CHARS - 1)}…`);
	});
});

describe("recallHealth", () => {
	test("is absent while recall is off and reports capacity and saturation otherwise", async () => {
		await withHindsight(async () => {
			expect(world({}).substrate.recallHealth()).toBeNull();
			const w = world({ SUBSTRATE_BRIEF_RECALL: "shadow" });
			await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
			expect(w.substrate.recallHealth()).toEqual({ mode: "shadow", capacity: 32, wanted: 1, saturated: false });
		});
	});
});

describe("an oversized brief and the recall-free fallback", () => {
	test("a complete brief too large to keep its sections saves recall-free fallback text: a later source failure serves no recall", async () => {
		await withHindsight(async () => {
			const huge = [1, 2, 3, 4].map((n) => entry("decision", `big${n} ${"x".repeat(300_000)}`));
			let failing = false;
			const index = { ...indexOf({ failGraph: () => failing }), memoryForBrief: async () => huge };
			const w = world({ SUBSTRATE_BRIEF_RECALL: "enforce" }, { index });
			seedSnapshot(w.redis, 1000);
			const complete = await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
			expect(complete.text).toContain("Recalled context");
			const [key] = w.redis.keysOf("brief-snapshot");
			const stored = JSON.parse(w.redis.values.get(key!)!) as { v: { text: string; sections?: unknown } };
			expect(stored.v.sections).toBeUndefined();
			expect(stored.v.text).not.toContain("Recalled context");
			failing = true;
			await w.cache.bump(MEMORY_GENERATION_KEY);
			const degraded = await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
			expect(degraded.state).toBe("snapshot");
			expect(degraded.text).not.toContain("Recalled context");
			expect(degraded.text).not.toContain("use pnpm, not npm");
		});
	});
});

describe("a graph past the cached encoding's caps", () => {
	test("1500 nodes: the notice is its own line, and the compact omitted count is exact", async () => {
		const w = world({ SUBSTRATE_BRIEF_PROFILE: "enforce" }, { index: indexOf({ nodes: 1500 }) });
		const full = await w.substrate.briefDetailed(WITH_GRAPH, "full", "grok-bot");
		const lines = full.text.split("\n");
		const at = lines.findIndex((line) => line.startsWith("Nodes: n0 todo"));
		expect(lines[at + 1]).toBe("… and 500 more nodes not listed");
		expect(lines[at]).not.toContain("not listed");
		const compact = await w.substrate.briefDetailed(WITH_GRAPH, "compact", "grok-bot");
		expect(compact.profile).toBe("compact");
		const rows = compact.text.split("\n");
		// 1000 listed, 12 shown: 988 held back by the profile and 500 left out at compose time.
		expect(rows.filter((line) => /^- n\d+ todo$/.test(line))).toHaveLength(12);
		expect(rows.at(-1)).toBe("...omitted: nodes 1488 (profile=compact; request profile=full)");
		expect(utf8Bytes(compact.text)).toBeLessThanOrEqual(3500);
	});

	test("2500 nodes: the brief lists the first 1000 and says so, and the second call is a cache hit", async () => {
		const w = world({}, { index: indexOf({ nodes: 2500 }) });
		const first = await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
		expect(first.state).toBe("complete");
		expect(first.text).toContain("… and 1500 more nodes not listed");
		expect(first.text).toContain("Nodes: n0 todo · n1 todo");
		expect(first.text).toContain("n999 todo");
		expect(first.text).not.toContain("n1000 todo");
		const hitsBefore = w.cache.health().hits;
		let reads = 0;
		const index = w.substrate as unknown as { index: { getGraph: () => Promise<unknown> } };
		const original = index.index.getGraph;
		index.index.getGraph = async () => {
			reads += 1;
			return original();
		};
		const second = await w.substrate.briefDetailed(WITH_GRAPH, undefined, "grok-bot");
		expect(second.text).toBe(first.text);
		expect(reads).toBe(0);
		expect(w.cache.health().hits).toBeGreaterThan(hitsBefore);
		// The last-good snapshot decodes again too.
		const [key] = w.redis.keysOf("brief-snapshot");
		const stored = JSON.parse(w.redis.values.get(key!)!) as { v: { sections?: unknown } };
		expect(stored.v.sections).toBeDefined();
	});
});

describe("the recall mode is in every key the brief text lives under", () => {
	test("a shadow entry is never served as enforce, nor the reverse, nor either as off", async () => {
		await withHindsight(async () => {
			const redis = new FakeRedis();
			const fake = new HindsightFake();
			seedBanks(fake);
			const shadow = world({ SUBSTRATE_BRIEF_RECALL: "shadow" }, { redis, fake });
			const enforce = world({ SUBSTRATE_BRIEF_RECALL: "enforce" }, { redis, fake });
			const off = world({}, { redis, fake });

			const shadowText = (await shadow.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface)).text;
			seedSnapshot(redis, 1000);
			const enforceText = (await enforce.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface)).text;
			expect(shadowText).not.toContain("Recalled context");
			expect(enforceText).toContain("Recalled context");
			// Shadow and off still read their own entries, written before the snapshot warmed.
			expect((await shadow.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface)).text).toBe(shadowText);
			expect((await off.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface)).text).toBe(shadowText);

			const snapshots = new Set(redis.keysOf("brief-snapshot"));
			expect(snapshots).toEqual(
				new Set([
					snapshotKey("brief-snapshot", "grok-bot", { repo: "acme/app", branch: null, graph_id: "ut-1" }),
					snapshotKey("brief-snapshot", "grok-bot", { repo: "acme/app", branch: null, graph_id: "ut-1", recall: "shadow", recallBank: OWN_BANK }),
					snapshotKey("brief-snapshot", "grok-bot", { repo: "acme/app", branch: null, graph_id: "ut-1", recall: "enforce", recallBank: OWN_BANK }),
				]),
			);
			expect(new Set(redis.keysOf("brief")).size).toBe(3);
		});
	});
});

// ── the compact profile ──────────────────────────────────────────────────────

describe("the compact profile", () => {
	test("drops the recall section first and says exactly how many lines it dropped", async () => {
		await withHindsight(async () => {
			const compactEnv = { SUBSTRATE_BRIEF_RECALL: "enforce", SUBSTRATE_BRIEF_PROFILE: "enforce" };
			// The roomy brief fits, so it carries the whole section; the lines it holds are what a tight brief must drop.
			const roomy = world(compactEnv);
			const wide = await roomy.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			expect(wide.text).toContain(RECALL_TITLE_PREFIX);
			expect(roomy.briefRecall).toEqual([{ surface: "grok-bot", result: "included" }]);
			const lines = wide.text.split("\n");
			const at = lines.findIndex((line) => line.startsWith(RECALL_TITLE_PREFIX));
			const end = lines.indexOf("", at + 1);
			const recalled = lines.slice(at + 1, end === -1 ? undefined : end).length;
			expect(recalled).toBeGreaterThan(0);

			// The same compact brief with recall off is the reference: a tight brief must be exactly it, plus the OMITTED line.
			const plain = await world(compactEnv, { cacheOff: true }).substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			expect(plain.profile).toBe("compact");
			expect(plain.text).not.toContain(RECALL_TITLE_PREFIX);
			const omittedLine = `\n...omitted: recalled ${recalled} (profile=compact; request profile=full)`;
			const cap = utf8Bytes(plain.text) + utf8Bytes(omittedLine);
			expect(cap).toBeGreaterThan(512);

			const tight = world({ ...compactEnv, SUBSTRATE_BRIEF_COMPACT_BYTES: String(cap) });
			const dropped = await tight.substrate.briefDetailed(WITH_GRAPH, undefined, WITH_GRAPH.surface);
			expect(dropped.text).toBe(`${plain.text}${omittedLine}`);
			expect(dropped.text).not.toContain(RECALL_TITLE_PREFIX);
			expect(utf8Bytes(dropped.text)).toBeLessThanOrEqual(cap);
			// The section was composed and then cut by the byte cap: the counter must not claim delivery.
			expect(tight.briefRecall).toEqual([{ surface: "grok-bot", result: "dropped_by_cap" }]);
		});
	});
});

// ── the prefetcher through the service ───────────────────────────────────────

describe("the prefetch through the service", () => {
	test("one recall on the surface's own bank, never the HINDSIGHT_BANKS fan-out, with a low budget and 400 tokens", async () => {
		await withHindsight(async () => {
			const w = world({ SUBSTRATE_BRIEF_RECALL: "shadow" });
			await w.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface);
			await w.substrate.runRecallTick();
			// Four banks are configured; only the surface's own is touched, by any request at all.
			expect(w.fake.requests.map((request) => request.path)).toEqual([`/v1/default/banks/${OWN_BANK}/memories/recall`]);
			const [body] = w.fake.recalls() as Array<{ query: string; budget: string; max_tokens: number }>;
			expect(body?.budget).toBe("low");
			expect(body?.max_tokens).toBeLessThanOrEqual(400);
			expect(body?.query).toContain("acme/app");
			// The subjects of the composed brief's decisions and warnings shaped the query, at most three of them.
			expect(body?.query).toContain("lease fencing");
			expect(body?.query).toContain("retain hygiene");
		});
	});

	test("only the repo's own scope is kept, and a secret-like string is redacted before the snapshot is stored", async () => {
		await withHindsight(async () => {
			const w = world({ SUBSTRATE_BRIEF_RECALL: "shadow" });
			await w.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface);
			await w.substrate.runRecallTick();
			const [key] = w.redis.keysOf("recall-snapshot");
			const raw = w.redis.values.get(key!)!;
			expect(raw).not.toContain("ghp_");
			expect(raw).not.toContain("another repo's rule");
			expect(raw).not.toContain("private to");
			const stored = JSON.parse(raw) as { v: RecallSnapshot };
			expect(stored.v.bank).toBe(OWN_BANK);
			expect(stored.v.hits.map((hit) => hit.text)).toEqual(["use pnpm, not npm", "deploy token [REDACTED] rotates weekly"]);
		});
	});

	test("an open breaker sends no call and is counted", async () => {
		await withHindsight(async () => {
			const w = world({ SUBSTRATE_BRIEF_RECALL: "shadow", SUBSTRATE_BREAKER_FAILURES: "1" });
			await w.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface);
			w.fake.failRecallWith = 500;
			await w.substrate.runRecallTick();
			expect(w.prefetch).toEqual([{ surface: "grok-bot", result: "error" }]);
			expect(w.substrate.planes.gate("hindsight").breaker?.state()).toBe("open");
			const before = w.fake.requests.length;
			// The failed pair is retried on a later tick; another pair is due now and meets the open breaker.
			await w.substrate.briefDetailed({ repo: "acme/other", surface: "grok-bot" }, undefined, ({ repo: "acme/other", surface: "grok-bot" }).surface);
			await w.substrate.runRecallTick();
			expect(w.prefetch.at(-1)).toEqual({ surface: "grok-bot", result: "skipped_breaker" });
			expect(w.fake.requests.length).toBe(before);
		});
	});

	test("an unconfigured Hindsight sends nothing: the brief is disabled and the tick has nothing to do", async () => {
		const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"];
		const saved = new Map(names.map((name) => [name, process.env[name]]));
		for (const name of names) delete process.env[name];
		try {
			const w = world({ SUBSTRATE_BRIEF_RECALL: "enforce" });
			await w.substrate.briefDetailed(WITH_GRAPH, undefined, (WITH_GRAPH).surface);
			await w.substrate.runRecallTick();
			expect(w.briefRecall).toEqual([{ surface: "grok-bot", result: "disabled" }]);
			expect(w.prefetch).toEqual([]);
			expect(w.fake.requests).toEqual([]);
		} finally {
			for (const [name, value] of saved) {
				if (value !== undefined) process.env[name] = value;
			}
		}
	});
});

// ── the post-retain hook ─────────────────────────────────────────────────────

const GRANTS = `[{"surfaces":["cursor"],"scopes":["graph","repo"],"kinds":["fact","decision"]}]`;

function retainWorld(env: Record<string, string>) {
	const fake = new HindsightFake();
	const redis = new FakeRedis();
	const store = new FakeStore();
	// The fake store holds the memory table; the brief's reads over it are empty.
	Object.assign(store, { getGraph: async () => null, openGraphs: async () => [], memoryForBrief: async () => [] });
	const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
	const instruments = new SubstrateInstruments();
	const prefetch: Array<{ surface: string; result: string }> = [];
	const substrate = new Substrate(
		loadConfig({ SUBSTRATE_MEMORY_GRANTS: GRANTS, ...env }),
		{ index: store as never, greptime: null, cache, hindsightFetch: fake.fetch },
		{
			recallPrefetch: (sample) => prefetch.push(sample),
			hindsightOutbox: (sample) => instruments.setHindsightOutbox(sample),
		},
	);
	return { substrate, fake, redis, instruments, prefetch };
}

describe("afterLiveRetain", () => {
	test("a retain schedules a refresh of that surface's wanted pairs, and the next brief carries what was retained", async () => {
		await withHindsight(async () => {
			const w = retainWorld({ SUBSTRATE_BRIEF_RECALL: "enforce" });
			const request = { repo: "acme/app", surface: "cursor" } as const;
			await w.substrate.briefDetailed(request, undefined, (request).surface);
			const beforeRetain = recalledRequests(w.fake).length;

			const written = await w.substrate.writeMemory({ scope: "repo:acme/app", kind: "fact", subject: "handoff-rule", text: "fence every handoff", writer: "cursor", source_event: "evt_e2e" });
			expect(written.outcome).toBe("accepted");
			await w.substrate.drainPendingRetains(2000);
			// The debounce is a 5 s unref'd timer; the test runs its body now.
			await w.substrate.flushRecallRetain();
			const refreshes = recalledRequests(w.fake).slice(beforeRetain);
			expect(refreshes.map((call) => call.path)).toEqual(["/v1/default/banks/sub-cursor/memories/recall"]);
			expect(w.prefetch).toEqual([{ surface: "cursor", result: "ok" }]);

			const callsBefore = recalledRequests(w.fake).length;
			const brief = await w.substrate.briefDetailed(request, undefined, (request).surface);
			// The retain moved the memory generation, so the brief's fan-out misses and asks each bank once.
			expect(recalledRequests(w.fake)).toHaveLength(callsBefore + fanoutBanks("cursor").length);
			expect(brief.text).toContain(RECALL_TITLE_PREFIX);
			expect(brief.text).toContain("- fence every handoff");
		});
	});

	test("a retain on a surface nobody asked about, or with recall off, refreshes nothing", async () => {
		await withHindsight(async () => {
			const enforce = retainWorld({ SUBSTRATE_BRIEF_RECALL: "enforce" });
			await enforce.substrate.writeMemory({ scope: "repo:acme/app", kind: "fact", subject: "handoff-rule", text: "fence every handoff", writer: "cursor", source_event: "evt_e2e" });
			await enforce.substrate.drainPendingRetains(2000);
			await enforce.substrate.flushRecallRetain();
			expect(recalledRequests(enforce.fake)).toEqual([]);

			const off = retainWorld({});
			await off.substrate.briefDetailed({ repo: "acme/app", surface: "cursor" }, undefined, ({ repo: "acme/app", surface: "cursor" }).surface);
			await off.substrate.writeMemory({ scope: "repo:acme/app", kind: "fact", subject: "handoff-rule", text: "fence every handoff", writer: "cursor", source_event: "evt_e2e" });
			await off.substrate.drainPendingRetains(2000);
			await off.substrate.flushRecallRetain();
			expect(recalledRequests(off.fake)).toEqual([]);
		});
	});
});

// ── the outbox gauges ────────────────────────────────────────────────────────

describe("the retain outbox gauges", () => {
	test("exist from boot with no flag and follow the outbox", async () => {
		await withHindsight(async () => {
			const w = retainWorld({});
			expect(gauge(w.instruments, "substrate.hindsight.retain_outbox.size")).toBe(0);
			expect(gauge(w.instruments, "substrate.hindsight.retain_outbox.oldest_age_seconds")).toBe(0);
			expect(gauge(w.instruments, "substrate.hindsight.retain_outbox.durable")).toBe(0);

			w.fake.failRetainWith = 503;
			await w.substrate.writeMemory({ scope: "repo:acme/app", kind: "fact", subject: "handoff-rule", text: "fence every handoff", writer: "cursor", source_event: "evt_e2e" });
			await w.substrate.drainPendingRetains(2000);
			expect(gauge(w.instruments, "substrate.hindsight.retain_outbox.size")).toBe(1);
			expect(gauge(w.instruments, "substrate.hindsight.retain_outbox.oldest_age_seconds")).toBeGreaterThanOrEqual(0);

			w.fake.failRetainWith = null;
			await w.substrate.drainRetainOutbox({ all: true });
			expect(gauge(w.instruments, "substrate.hindsight.retain_outbox.size")).toBe(0);
			// Reading the gauges for /metrics makes no plane call.
			const before = w.fake.requests.length;
			expect(w.substrate.hindsightGauges()).toEqual([]);
			expect(w.fake.requests.length).toBe(before);
		});
	});
});

// ── the cache class ──────────────────────────────────────────────────────────

describe("the recall-snapshot cache class", () => {
	test("is generation-free: the key does not move with the memory generation", async () => {
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		const snapshot: RecallSnapshot = { bank: OWN_BANK, at: new Date().toISOString(), hits: [{ text: "a" }] };
		expect(await cache.put("recall-snapshot", "grok-bot", recallSnapshotArgs("acme/app", OWN_BANK), snapshot, 900)).toBe(true);
		await cache.bump(MEMORY_GENERATION_KEY);
		expect(await cache.peekQuiet<RecallSnapshot>("recall-snapshot", "grok-bot", recallSnapshotArgs("acme/app", OWN_BANK))).toEqual(snapshot);
		expect(redis.keysOf("recall-snapshot")).toEqual([snapshotKey("recall-snapshot", "grok-bot", recallSnapshotArgs("acme/app", OWN_BANK))]);
	});

	test("refuses a value of the wrong shape, and the key holds the surface, the repo and the bank", async () => {
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		expect(await cache.put("recall-snapshot", "grok-bot", {}, { bank: 1 }, 900)).toBe(false);
		const keyOf = (surface: string, repo: string, bank: string) => snapshotKey("recall-snapshot", surface, recallSnapshotArgs(repo, bank));
		const keys = new Set([keyOf("grok-bot", "acme/app", OWN_BANK), keyOf("omp", "acme/app", OWN_BANK), keyOf("grok-bot", "acme/other", OWN_BANK), keyOf("grok-bot", "acme/app", "other-sub-grok-bot")]);
		expect(keys.size).toBe(4);
	});
});
