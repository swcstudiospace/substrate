/** E2 shared-context store tests (phase 82): fakes only, no live server, no real sleep. */
import { afterEach, describe, expect, test } from "bun:test";
import { ReadThroughCache, classOf, type CacheRedis } from "../cache.ts";
import { dragonflyGateVerdict, recordDragonflyGateVerdict, resetDragonflyGateVerdict } from "./dragonfly-readiness.ts";
import {
	SHARED_KIND_TTL,
	SHARED_PREFIX,
	createSharedContextStore,
	parseSharedKey,
	sharedClaimKey,
	sharedKey,
	sharedTtlS,
	stableSharedKey,
	type SharedAgent,
	type SharedKind,
	type SharedContextStore,
} from "./shared-context.ts";
import { degradedReadiness, okReadiness, unconfiguredReadiness, unavailableReadiness } from "./fixtures.ts";

const NOW = 1_700_000_000_000;

/**
 * A fake Dragonfly with TTL expiry at a controllable `now`, and the claim Lua's
 * semantics behind `eval`: the key exists (and has not expired) → `0`, else set
 * it with `EX` → `1`. One call is one atomic decision, so a won/lost pair from
 * two sequential claims is the atomicity evidence the fake can give.
 */
class FakeRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	readonly ttls: number[] = [];
	private readonly expiresAt = new Map<string, number>();
	nowMs = NOW;
	fail = false;
	sets = 0;
	evals = 0;
	lastScript = "";

	advance(ms: number): void {
		this.nowMs += ms;
	}

	private live(key: string): boolean {
		const at = this.expiresAt.get(key);
		if (at === undefined) return false;
		if (at <= this.nowMs) {
			this.expiresAt.delete(key);
			this.values.delete(key);
			return false;
		}
		return this.values.has(key);
	}

	async get(key: string): Promise<string | null> {
		if (this.fail) throw new Error("connect ECONNREFUSED");
		if (this.expiresAt.has(key) && !this.live(key)) return null;
		return this.values.get(key) ?? null;
	}

	async set(key: string, value: string, ttlSeconds: number): Promise<void> {
		this.sets += 1;
		if (this.fail) throw new Error("connect ECONNREFUSED");
		this.values.set(key, value);
		this.expiresAt.set(key, this.nowMs + ttlSeconds * 1000);
		this.ttls.push(ttlSeconds);
	}

	async incr(key: string): Promise<number> {
		if (this.fail) throw new Error("connect ECONNREFUSED");
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}

	async eval(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown> {
		this.evals += 1;
		this.lastScript = script;
		if (this.fail) throw new Error("connect ECONNREFUSED");
		expect(keys).toHaveLength(1);
		const key = keys[0] as string;
		if (this.expiresAt.has(key) && !this.live(key)) {
			// Expired: absent.
		} else if (this.values.has(key)) {
			return 0;
		}
		this.values.set(key, args[0] as string);
		this.expiresAt.set(key, this.nowMs + Number(args[1]) * 1000);
		return 1;
	}
}

function storeOf(redis: FakeRedis | null, gateMode: "off" | "enforce" = "off"): SharedContextStore {
	const cache =
		redis === null
			? new ReadThroughCache({ redis: null, enabled: false, log: () => {} })
			: new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => redis.nowMs, gateMode });
	return createSharedContextStore(cache);
}

const key = (stableKey = "sess-7") => ({ agent: "herdr" as const, graph: "ut-1", kind: "context" as const, stableKey });

afterEach(() => {
	resetDragonflyGateVerdict();
});

describe("shared namespace", () => {
	test("sharedKey builds the namespaced key and parseSharedKey is its inverse", () => {
		expect(sharedKey("claude-code", "ut-1", "output", "pane-7")).toBe("substrate:v1:shared:claude-code:ut-1:output:pane-7");
		expect(parseSharedKey("substrate:v1:shared:grok:-:recall:r9")).toEqual({ agent: "grok", graph: "-", kind: "recall", stableKey: "r9" });
		expect(parseSharedKey(sharedKey("reminiscent", "g-2", "context", "k.1"))).toEqual({ agent: "reminiscent", graph: "g-2", kind: "context", stableKey: "k.1" });
		expect(classOf(sharedKey("herdr", "ut-1", "context", "s"))).toBe("shared");
		expect(SHARED_PREFIX).toBe("substrate:v1:shared:");
	});

	test("parseSharedKey rejects anything that is not a shared-lane key", () => {
		expect(parseSharedKey("substrate:v1:brief:abc")).toBeNull();
		expect(parseSharedKey("substrate:v1:shared:herdr:ut-1:context")).toBeNull();
		expect(parseSharedKey("substrate:v1:shared:herdr:ut-1:context:k:extra")).toBeNull();
		expect(parseSharedKey("substrate:v1:shared:bogus:ut-1:context:k")).toBeNull();
		expect(parseSharedKey("substrate:v1:shared:herdr:ut-1:bogus:k")).toBeNull();
		expect(parseSharedKey("substrate:v1:shared:herdr:ut 1:context:k")).toBeNull();
		expect(parseSharedKey("")).toBeNull();
	});

	test("sharedKey throws TypeError on a bad agent, kind, graph or stable key", () => {
		expect(() => sharedKey("bogus" as unknown as SharedAgent, "ut-1", "context", "k")).toThrow(TypeError);
		expect(() => sharedKey("herdr", "ut-1", "bogus" as unknown as SharedKind, "k")).toThrow(TypeError);
		expect(() => sharedKey("herdr", "ut 1", "context", "k")).toThrow(TypeError);
		expect(() => sharedKey("herdr", "", "context", "k")).toThrow(TypeError);
		expect(() => sharedKey("herdr", "ut-1", "context", "k:x")).toThrow(TypeError);
		expect(() => sharedKey("herdr", "ut-1", "context", "")).toThrow(TypeError);
	});

	test("stableSharedKey is order-independent hex, and the claim key is the value key plus :claim", () => {
		const a = stableSharedKey({ b: 2, a: 1 });
		expect(a).toBe(stableSharedKey({ a: 1, b: 2 }));
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(sharedClaimKey("substrate:v1:shared:herdr:-:context:k")).toBe("substrate:v1:shared:herdr:-:context:k:claim");
	});

	test("per-kind TTLs are output 60, context 300, recall 600", () => {
		expect(SHARED_KIND_TTL).toEqual({ output: 60, context: 300, recall: 600 });
		expect(sharedTtlS("output")).toBe(60);
		expect(sharedTtlS("context")).toBe(300);
		expect(sharedTtlS("recall")).toBe(600);
	});
});

describe("SharedContextStore getOrLoad / put / get", () => {
	test("a miss loads once, stores under the exact namespaced key with the kind TTL, and the next call hits", async () => {
		const redis = new FakeRedis();
		const store = storeOf(redis);
		let loads = 0;
		const load = async () => {
			loads += 1;
			return { text: "held by herdr" };
		};
		expect(await store.getOrLoad({ ...key(), load })).toEqual({ text: "held by herdr" });
		expect(await store.getOrLoad({ ...key(), load })).toEqual({ text: "held by herdr" });
		expect(loads).toBe(1);
		expect(redis.values.has("substrate:v1:shared:herdr:ut-1:context:sess-7")).toBe(true);
		expect(redis.ttls).toEqual([300]);
		expect(store.health()).toMatchObject({ hits: 1, misses: 1, bypasses: 0, errors: 0, claimsWon: 0, claimsLost: 0, claimBypasses: 0 });
	});

	test("every kind writes with its own TTL", async () => {
		const redis = new FakeRedis();
		const store = storeOf(redis);
		for (const kind of ["output", "context", "recall"] as const) {
			expect(await store.put({ agent: "grok", graph: "-", kind, stableKey: `k-${kind}`, value: "v" })).toBe(true);
		}
		expect(redis.ttls).toEqual([60, 300, 600]);
		expect(await store.get<string>({ agent: "grok", graph: "-", kind: "output", stableKey: "k-output" })).toBe("v");
	});

	test("an expired key loads again and the stale value is never served", async () => {
		const redis = new FakeRedis();
		const store = storeOf(redis);
		let loads = 0;
		const load = async () => `answer-${loads++}`;
		const req = { agent: "grok" as const, graph: "-", kind: "output" as const, stableKey: "o1" };
		expect(await store.getOrLoad({ ...req, load })).toBe("answer-0");
		redis.advance(60_000);
		expect(await store.getOrLoad({ ...req, load })).toBe("answer-1");
		expect(loads).toBe(2);
		expect(redis.sets).toBe(2);
	});

	test("a falsy-but-valid value is a hit, not a miss", async () => {
		const redis = new FakeRedis();
		const store = storeOf(redis);
		let loads = 0;
		const load = async () => {
			loads += 1;
			return "";
		};
		expect(await store.getOrLoad({ ...key(), load })).toBe("");
		expect(await store.getOrLoad({ ...key(), load })).toBe("");
		expect(loads).toBe(1);
	});

	test("cache off answers the durable load, get is null, put is false", async () => {
		const store = storeOf(null);
		let loads = 0;
		const value = await store.getOrLoad({
			...key(),
			load: async () => {
				loads += 1;
				return { text: "from durable source" };
			},
		});
		expect(value).toEqual({ text: "from durable source" });
		expect(loads).toBe(1);
		expect(await store.get(key())).toBeNull();
		expect(await store.put({ ...key(), value: "v" })).toBe(false);
	});

	test("a failing server answers the durable load, counts a bypass and never throws", async () => {
		const redis = new FakeRedis();
		redis.fail = true;
		const store = storeOf(redis);
		let loads = 0;
		const value = await store.getOrLoad({
			...key(),
			load: async () => {
				loads += 1;
				return "live";
			},
		});
		expect(value).toBe("live");
		expect(loads).toBe(1);
		expect(store.health().bypasses).toBeGreaterThan(0);
		expect(await store.get(key())).toBeNull();
	});
});

describe("SharedContextStore gate (DG-1b)", () => {
	test("off with an unavailable verdict never changes behaviour", async () => {
		resetDragonflyGateVerdict();
		recordDragonflyGateVerdict(unavailableReadiness());
		const store = storeOf(new FakeRedis(), "off");
		let loads = 0;
		const load = async () => {
			loads += 1;
			return "held";
		};
		expect(await store.getOrLoad({ ...key(), load })).toBe("held");
		expect(await store.getOrLoad({ ...key(), load })).toBe("held");
		expect(loads).toBe(1);
		expect(dragonflyGateVerdict("off").state).toBe("unconfigured");
	});

	test("enforce with ok and degraded verdicts serves, with unavailable and unconfigured it bypasses to load", async () => {
		for (const [record, serves] of [
			[okReadiness(), true],
			[degradedReadiness(), true],
			[unavailableReadiness(), false],
			[unconfiguredReadiness(), false],
		] as const) {
			resetDragonflyGateVerdict();
			recordDragonflyGateVerdict(record);
			const redis = new FakeRedis();
			// Seed under the recorded verdict (writes are not blocked), then judge the read under the same verdict.
			const store = storeOf(redis, "enforce");
			expect(await store.put({ ...key("s"), value: "seeded" })).toBe(true);
			let loads = 0;
			const value = await store.getOrLoad({
				...key("s"),
				load: async () => {
					loads += 1;
					return "from durable source";
				},
			});
			if (serves) {
				expect(value).toBe("seeded");
				expect(loads).toBe(0);
			} else {
				expect(value).toBe("from durable source");
				expect(loads).toBe(1);
				expect(await store.get(key("s"))).toBeNull();
				expect(store.health().bypasses).toBeGreaterThan(0);
			}
		}
	});

	test("enforce with no recorded verdict (unconfigured) bypasses and never serves the seeded value", async () => {
		resetDragonflyGateVerdict();
		const redis = new FakeRedis();
		const seeded = storeOf(redis, "off");
		expect(await seeded.put({ ...key("s2"), value: "seeded" })).toBe(true);
		const store = storeOf(redis, "enforce");
		let loads = 0;
		const value = await store.getOrLoad({
			...key("s2"),
			load: async () => {
				loads += 1;
				return "from durable source";
			},
		});
		expect(value).toBe("from durable source");
		expect(loads).toBe(1);
		expect(await store.get(key("s2"))).toBeNull();
		expect(store.health().bypasses).toBeGreaterThan(0);
	});
});

describe("SharedContextStore claim", () => {
	test("the first claim wins, a concurrent claim on the same slot loses, another slot wins — one eval each", async () => {
		const redis = new FakeRedis();
		const store = storeOf(redis);
		const slot = { agent: "herdr" as const, graph: "ut-1", kind: "output" as const, stableKey: "slot-1" };
		expect(await store.claim({ ...slot, claimId: "c1" })).toBe("won");
		expect(redis.evals).toBe(1);
		expect(redis.lastScript).toContain("exists");
		expect(await store.claim({ ...slot, claimId: "c2" })).toBe("lost");
		expect(await store.claim({ ...slot, stableKey: "slot-2", claimId: "c3" })).toBe("won");
		expect(redis.evals).toBe(3);
		expect(store.health()).toMatchObject({ claimsWon: 2, claimsLost: 1, claimBypasses: 0 });
		// The claim holds the bare claimId on the :claim slot, not an envelope.
		expect(redis.values.get("substrate:v1:shared:herdr:ut-1:output:slot-1:claim")).toBe("c1");
	});

	test("a lost claim answers from the durable load and writes nothing", async () => {
		const redis = new FakeRedis();
		const winner = storeOf(redis);
		const loser = storeOf(redis);
		const slot = { agent: "herdr" as const, graph: "ut-1", kind: "context" as const, stableKey: "slot-9" };
		expect(await winner.claim({ ...slot, claimId: "winner" })).toBe("won");
		expect(await loser.claim({ ...slot, claimId: "loser" })).toBe("lost");
		let loads = 0;
		const value = await loser.getOrLoad({
			...slot,
			load: async () => {
				loads += 1;
				return "loser answer";
			},
		});
		expect(value).toBe("loser answer");
		expect(loads).toBe(1);
	});

	test("a gate-blocked claim is bypass with no command sent", async () => {
		resetDragonflyGateVerdict();
		recordDragonflyGateVerdict(unavailableReadiness());
		const redis = new FakeRedis();
		const store = storeOf(redis, "enforce");
		expect(await store.claim({ ...key("c1"), claimId: "x" })).toBe("bypass");
		expect(redis.evals).toBe(0);
		expect(store.health()).toMatchObject({ claimsWon: 0, claimsLost: 0, claimBypasses: 1 });
	});

	test("a client without EVAL answers bypass and cache off answers bypass", async () => {
		const noEval = new FakeRedis();
		(noEval as unknown as { eval: unknown }).eval = undefined;
		const noEvalStore = storeOf(noEval);
		expect(await noEvalStore.claim({ ...key("c2"), claimId: "x" })).toBe("bypass");
		expect(noEvalStore.health().claimBypasses).toBe(1);

		const offStore = storeOf(null);
		expect(await offStore.claim({ ...key("c3"), claimId: "x" })).toBe("bypass");
		expect(offStore.health().claimBypasses).toBe(1);
	});

	test("an empty or over-long claimId throws TypeError", async () => {
		const store = storeOf(new FakeRedis());
		await expect(store.claim({ ...key("c4"), claimId: "" })).rejects.toThrow(TypeError);
		await expect(store.claim({ ...key("c5"), claimId: "x".repeat(257) })).rejects.toThrow(TypeError);
	});
});
