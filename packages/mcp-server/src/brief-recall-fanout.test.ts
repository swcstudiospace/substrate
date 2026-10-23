/**
 * The brief's recall read in `enforce`, end to end: the fan-out asks each configured `sub-*` bank once, a
 * fresh answer is served from the `recall-snapshot` cache with no bank call, a bank that never answers
 * does not hold the brief past its cap, a partial failure keeps the answering banks' hits, and `off` and
 * `shadow` serve exactly today's text with no fan-out call.
 */
import { describe, expect, test } from "bun:test";
import { composeBriefSections } from "./brief.ts";
import { GRAPHS_GENERATION_KEY, MEMORY_GENERATION_KEY, RECALL_GENERATION_KEY, ReadThroughCache, classOf, type CacheKeyClass, type CacheRedis } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import { fanOutBriefRecall } from "./memory-recall.ts";
import { clearEnsuredBanks, hindsightFromEnv } from "./planes/hindsight.ts";
import { BRIEF_RECALL_CAP_MS, DEFAULT_RECALL_TTL_S, RECALL_TITLE_PREFIX, briefRecallBudgetMs, buildRecallQuery, fanoutSnapshot, type RecallSnapshot } from "./recall-snapshot.ts";
import { Substrate } from "./service.ts";

const REQUEST = { repo: "acme/app", surface: "grok-bot" } as const;
const REPO = "acme/app";
const OWN_BANK = "sub-grok-bot";
const CONFIGURED = ["sub-omp", "sub-hermes", "sub-cursor", OWN_BANK];
const ENFORCE = { SUBSTRATE_BRIEF_RECALL: "enforce" };
const BANK_PATH = /\/banks\/([^/]+)\/memories\/recall$/;

class FakeRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	readonly ttls = new Map<string, number>();
	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}
	async set(key: string, value: string, ttlSeconds: number): Promise<void> {
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

/** Point the Hindsight env reads at the fake for one test, with the four banks configured; restores every touched variable. */
async function withHindsight<T>(body: () => Promise<T>): Promise<T> {
	const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	process.env.HINDSIGHT_URL = "http://fake";
	process.env.HINDSIGHT_API_KEY = "test-bearer";
	process.env.HINDSIGHT_BANKS = CONFIGURED.join(",");
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

/** One bank per surface, each with a repo-scoped memory; the scores put the own bank first and the three others after it. */
function seedBanks(fake: HindsightFake): void {
	const scoped = (id: string, text: string, score: number) => ({ id, text, document_id: `${id}-doc`, tags: [], metadata: { scope: `repo:${REPO}` }, score });
	fake.seed(OWN_BANK, [scoped("own-1", "use pnpm, not npm", 0.9)]);
	fake.seed("sub-omp", [scoped("omp-1", "omp lesson: fence the lease", 0.8)]);
	fake.seed("sub-hermes", [scoped("hermes-1", "hermes lesson: rotate keys", 0.7)]);
	fake.seed("sub-cursor", [scoped("cursor-1", "cursor lesson: index first", 0.6)]);
}

interface World {
	substrate: Substrate;
	redis: FakeRedis;
	cache: ReadThroughCache;
	fake: HindsightFake;
}

/** `onRecall` runs as a recall request leaves for Hindsight, so a test can act once a fan-out has started. */
function world(env: Record<string, string>, fake: HindsightFake, onRecall?: () => void): World {
	const redis = new FakeRedis();
	const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
	const hindsightFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		if (String(input).endsWith("/memories/recall")) onRecall?.();
		return fake.fetch(input, init);
	};
	const substrate = new Substrate(loadConfig(env), { index: null, greptime: null, cache, hindsightFetch });
	return { substrate, redis, cache, fake };
}

/**
 * Every compose reports its decisions' subjects to the recall registry, and with no index it reports none. This makes each compose of
 * one service carry `subject`, as a brief over a decision about it would. The registry is private to the service, so the reach is checked at runtime.
 */
function carryDecisionSubject(substrate: Substrate, subject: string): void {
	const recall: unknown = Reflect.get(substrate, "recall");
	if (!hasNoteSubjects(recall)) throw new Error("the service has no recall registry");
	const noteSubjects = recall.noteSubjects.bind(recall);
	recall.noteSubjects = (surface, repo, subjects) => noteSubjects(surface, repo, [...subjects, subject]);
}

function hasNoteSubjects(value: unknown): value is { noteSubjects(surface: string, repo: string, subjects: string[]): void } {
	return typeof value === "object" && value !== null && "noteSubjects" in value && typeof value.noteSubjects === "function";
}

/** The bank of every recall request the fake received, in order. */
const recallCalls = (fake: HindsightFake): string[] =>
	fake.requests.filter((request) => request.path.endsWith("/memories/recall")).map((request) => BANK_PATH.exec(request.path)?.[1] ?? "");

describe("brief recall fan-out (SUBSTRATE_BRIEF_RECALL=enforce)", () => {
	test("the fan-out asks each configured sub-* bank once, and the brief carries the answering banks' recall", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			const w = world(ENFORCE, fake);
			const text = (await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface)).text;
			expect(recallCalls(fake).sort()).toEqual([...CONFIGURED].sort());
			const lines = text.split("\n");
			const at = lines.findIndex((line) => line.startsWith(RECALL_TITLE_PREFIX));
			expect(lines[at]).toBe(`${RECALL_TITLE_PREFIX}; Hindsight banks sub-cursor, sub-grok-bot, sub-hermes, sub-omp, <1m old):`);
			expect(lines.slice(at + 1)).toEqual(["- use pnpm, not npm", "- omp lesson: fence the lease", "- hermes lesson: rotate keys"]);
		});
	});

	test("a second brief within the TTL is served from the recall cache: no bank call, and the entry records its banks", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			const w = world(ENFORCE, fake);
			const first = await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(recallCalls(fake)).toHaveLength(CONFIGURED.length);
			// A graphs bump makes the brief itself miss, so the second compose reads the recall cache; the fan-out answer is not keyed on graphs.
			await w.cache.bump(GRAPHS_GENERATION_KEY);
			const second = await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(recallCalls(fake)).toHaveLength(CONFIGURED.length);
			expect(second.text).toBe(first.text);
			const keys = w.redis.keysOf("recall-snapshot");
			expect(keys).toHaveLength(1);
			const [key] = keys;
			// The entry is held for the TTL from its fetch: at most the TTL, and no less than a second short of it.
			const ttl = w.redis.ttls.get(key ?? "") ?? -1;
			expect(ttl).toBeLessThanOrEqual(DEFAULT_RECALL_TTL_S);
			expect(ttl).toBeGreaterThanOrEqual(DEFAULT_RECALL_TTL_S - 1);
			const envelope: { v: RecallSnapshot } = JSON.parse(w.redis.values.get(key ?? "") ?? "{}");
			expect(envelope.v.banks).toEqual([...CONFIGURED].sort());
		});
	});

	test("a repeat brief with no writes makes no Hindsight recall call", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			const w = world(ENFORCE, fake);
			await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(recallCalls(fake)).toHaveLength(CONFIGURED.length);
			await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(recallCalls(fake)).toHaveLength(CONFIGURED.length);
		});
	});

	test("a memory write makes the next brief fan out again", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			const w = world(ENFORCE, fake);
			await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			// An accepted memory write bumps the memory generation (`writeMemory`), and the fan-out answer is keyed on it.
			await w.cache.bump(MEMORY_GENERATION_KEY);
			const after = await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(recallCalls(fake)).toHaveLength(2 * CONFIGURED.length);
			expect(after.text).toContain(RECALL_TITLE_PREFIX);
		});
	});

	test("a retain landing under narrow (a gen:recall bump) makes the next brief fan out again", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			const w = world({ ...ENFORCE, SUBSTRATE_CACHE_BUMP_SCOPE: "narrow" }, fake);
			await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(recallCalls(fake)).toHaveLength(CONFIGURED.length);
			// Under `narrow` a retain landing bumps the recall generation alone; the brief's own entry lists it too, so the brief refreshes as well.
			await w.cache.bump(RECALL_GENERATION_KEY);
			await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(recallCalls(fake)).toHaveLength(2 * CONFIGURED.length);
		});
	});

	test("a bank that misses its budget is dropped, and the answering banks' hits stay", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			fake.recallDelayMs["sub-omp"] = 5_000;
			const w = world({ ...ENFORCE, SUBSTRATE_BRIEF_RECALL_BUDGET_MS: "300" }, fake);
			const text = (await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface)).text;
			expect(text).toContain("Hindsight banks sub-cursor, sub-grok-bot, sub-hermes, <1m old):");
			expect(text).not.toContain("omp lesson");
			expect(text).toContain("- cursor lesson: index first");
			expect(text).toContain("- hermes lesson: rotate keys");
		});
	});

	test("when no bank answers the section is omitted, the brief stays complete, and nothing is stored", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			fake.failRecallWith = 500;
			const w = world(ENFORCE, fake);
			const detail = await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(detail.text).not.toContain("Recalled context");
			expect(detail.state).toBe("complete");
			expect(w.redis.keysOf("recall-snapshot")).toEqual([]);
		});
	});

	test("a recall read that never answers is cut at the injected cap, and the brief carries no section", async () => {
		const started = performance.now();
		const sections = await composeBriefSections(REQUEST, { index: null, greptime: null }, undefined, undefined, {
			budgetMs: 1200,
			recentWindowDays: 30,
			recall: { read: () => new Promise<RecallSnapshot | null>(() => {}), partial: () => null, ttlS: DEFAULT_RECALL_TTL_S, capMs: 50 },
		});
		expect(performance.now() - started).toBeLessThan(1000);
		expect(sections.some((section) => section.id === "recall")).toBe(false);
	});

	test("a recall read that never answers falls back to its partial snapshot at the cap", async () => {
		const partial = fanoutSnapshot(["sub-omp"], [{ bank: "sub-omp", text: "omp lesson: fence the lease", scope: `repo:${REPO}` }], REPO, OWN_BANK, Date.now());
		const sections = await composeBriefSections(REQUEST, { index: null, greptime: null }, undefined, undefined, {
			budgetMs: 1200,
			recentWindowDays: 30,
			recall: { read: () => new Promise<RecallSnapshot | null>(() => {}), partial: () => partial, ttlS: DEFAULT_RECALL_TTL_S, capMs: 50 },
		});
		expect(sections.find((section) => section.id === "recall")?.lines.join("\n")).toContain("- omp lesson: fence the lease");
	});

	test("a bank that answers after the injected cap does not hold the brief past it", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			fake.recallDelayMs["sub-omp"] = 400;
			const config = hindsightFromEnv();
			if (config === null) throw new Error("the Hindsight env is not set");
			const query = buildRecallQuery(REPO, []);
			const read = async (): Promise<RecallSnapshot | null> => {
				const answer = await fanOutBriefRecall({ config, banks: CONFIGURED, fetchImpl: fake.fetch, budgetMs: 1500 }, query, { surface: REQUEST.surface, repo: REPO });
				return answer.answered.length === 0 ? null : fanoutSnapshot(answer.answered, answer.hits, REPO, OWN_BANK, Date.now());
			};
			const started = performance.now();
			const sections = await composeBriefSections(REQUEST, { index: null, greptime: null }, undefined, undefined, {
				budgetMs: 1200,
				recentWindowDays: 30,
				recall: { read, partial: () => null, ttlS: DEFAULT_RECALL_TTL_S, capMs: 50 },
			});
			expect(performance.now() - started).toBeLessThan(300);
			expect(sections.some((section) => section.id === "recall")).toBe(false);
		});
	});

	test("the cap is BRIEF_RECALL_CAP_MS, 3000 ms", () => {
		expect(BRIEF_RECALL_CAP_MS).toBe(3000);
	});

	test("the fan-out's budget ends before the cap, and a configured budget under the cap is kept", () => {
		expect(briefRecallBudgetMs(5000)).toBeLessThan(BRIEF_RECALL_CAP_MS);
		expect(briefRecallBudgetMs(1500)).toBe(1500);
	});

	test("a bank slower than the cap is cut inside it, and the banks that answered stay in the brief", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			fake.recallDelayMs["sub-omp"] = 3500;
			const w = world({ ...ENFORCE, SUBSTRATE_BRIEF_RECALL_BUDGET_MS: "5000" }, fake);
			const text = (await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface)).text;
			expect(text).toContain(RECALL_TITLE_PREFIX);
			expect(text).toContain("- use pnpm, not npm");
			expect(text).toContain("- hermes lesson: rotate keys");
			expect(text).toContain("- cursor lesson: index first");
			expect(text).not.toContain("omp lesson");
		});
	}, 15_000);

	test("a bank that ignores the fan-out's abort is passed over at the cap, and the banks that completed stay in the brief", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			fake.recallDeafMs["sub-omp"] = 3500;
			const w = world({ ...ENFORCE, SUBSTRATE_BRIEF_RECALL_BUDGET_MS: "5000" }, fake);
			const text = (await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface)).text;
			expect(text).toContain(RECALL_TITLE_PREFIX);
			expect(text).toContain("- use pnpm, not npm");
			expect(text).toContain("- hermes lesson: rotate keys");
			expect(text).not.toContain("omp lesson");
		});
	}, 15_000);

	test("another repo's copy of the same text, scored higher on another bank, does not hide the repo's own copy", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			// The same text retained for another repo ranks first on sub-omp; the own bank's copy for this repo must survive the dedupe.
			fake.seed("sub-omp", [{ id: "omp-other", text: "use pnpm, not npm", document_id: "omp-other-doc", tags: [], metadata: { scope: "repo:other/app" }, score: 0.95 }]);
			const w = world(ENFORCE, fake);
			const text = (await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface)).text;
			expect(text.split("\n").filter((line) => line === "- use pnpm, not npm")).toHaveLength(1);
		});
	});

	test("a brief whose recall read is cut at the cap is not stored, so no later brief is served without its recall", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			fake.recallDeafMs["sub-omp"] = 3500;
			const w = world({ ...ENFORCE, SUBSTRATE_BRIEF_RECALL_BUDGET_MS: "5000" }, fake);
			const detail = await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(detail.text).toContain(RECALL_TITLE_PREFIX);
			expect(w.redis.keysOf("brief")).toEqual([]);
			expect(w.redis.keysOf("brief-snapshot")).toEqual([]);
		});
	}, 15_000);

	test("a brief whose recall read finishes inside the cap is stored", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			const w = world(ENFORCE, fake);
			await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(w.redis.keysOf("brief")).toHaveLength(1);
		});
	});

	// Real timers on purpose: the cap is a real timer in brief.ts and the fake's deaf bank is real too. A fake clock would skip the path under test.
	test("a waiter that joins a cut brief and composes again keeps its whole recall wait within the cap", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			fake.recallDeafMs["sub-omp"] = 3500;
			const firstRecall = Promise.withResolvers<void>();
			const w = world({ ...ENFORCE, SUBSTRATE_BRIEF_RECALL_BUDGET_MS: "5000" }, fake, () => firstRecall.resolve());
			const owner = w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			// The owner's first query is built before its fan-out leaves. Its compose then carries a decision subject, so the waiter's
			// reload asks a different, equally slow query and cannot join the owner's fan-out.
			await firstRecall.promise;
			carryDecisionSubject(w.substrate, "pnpm");
			const arrived = performance.now();
			await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			const waited = performance.now() - arrived;
			await owner;
			// The waiter joined the owner's brief load, which was refused storage, so it composed again.
			expect(w.cache.health().coalesced).toBe(1);
			expect(waited).toBeLessThan(BRIEF_RECALL_CAP_MS + 500);
		});
	}, 15_000);

	test("a configured one-hour TTL is the fan-out entry's life, not the 30-minute class cap", async () => {
		await withHindsight(async () => {
			const fake = new HindsightFake();
			seedBanks(fake);
			const w = world({ ...ENFORCE, SUBSTRATE_BRIEF_RECALL_TTL_S: "3600" }, fake);
			await w.substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			const [key] = w.redis.keysOf("recall-snapshot");
			const ttl = w.redis.ttls.get(key ?? "") ?? -1;
			expect(ttl).toBeLessThanOrEqual(3600);
			expect(ttl).toBeGreaterThanOrEqual(3598);
		});
	});
});

describe("brief recall fan-out is off the text for off and shadow", () => {
	test("off and shadow serve today's text, and neither calls a bank for the fan-out", async () => {
		await withHindsight(async () => {
			const offFake = new HindsightFake();
			seedBanks(offFake);
			const off = await world({}, offFake).substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(off.text).not.toContain("Recalled context");
			expect(recallCalls(offFake)).toEqual([]);

			const shadowFake = new HindsightFake();
			seedBanks(shadowFake);
			const shadow = await world({ SUBSTRATE_BRIEF_RECALL: "shadow" }, shadowFake).substrate.briefDetailed(REQUEST, undefined, REQUEST.surface);
			expect(shadow.text).toBe(off.text);
			expect(shadow.etag).toBe(off.etag);
			expect(recallCalls(shadowFake)).toEqual([]);
		});
	});
});
