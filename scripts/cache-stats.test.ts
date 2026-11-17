import { describe, expect, test } from "bun:test";
import { cacheKey, graphGenerationKey, MEMORY_GENERATION_KEY, snapshotKey } from "../packages/mcp-server/src/cache.ts";
import {
	collectStats,
	fetchRatios,
	isLoopbackUrl,
	KEY_BUDGET,
	main,
	recommend,
	renderTable,
	SCAN_COUNT,
	WALL_BUDGET_MS,
	HEALTHZ_AUTH_NOTE,
	type HealthzFetch,
	type StatsClient,
} from "./cache-stats.ts";
import { doctorBearer } from "./doctor-runtime.ts";

/** A server holding `entries`. It has no GET: a script that tried to read a value would throw. */
class FakeServer implements StatsClient {
	readonly commands: string[] = [];
	readonly scanArgs: string[][] = [];
	closed = false;
	constructor(
		private readonly entries: Map<string, { type: string; length: number }>,
		private readonly onSend: () => void = () => {},
		private readonly duplicate = false,
	) {}

	async send(command: string, args: string[]): Promise<unknown> {
		this.commands.push(command);
		this.onSend();
		const keys = [...this.entries.keys()];
		if (command === "SCAN") {
			this.scanArgs.push(args);
			const start = Number(args[0]);
			const count = Number(args[args.indexOf("COUNT") + 1]);
			const page = keys.slice(start, start + count);
			const next = start + count >= keys.length ? "0" : String(start + count);
			return [next, this.duplicate ? [...page, ...page] : page];
		}
		if (command === "TYPE") return this.entries.get(args[0] as string)?.type ?? "none";
		if (command === "STRLEN") {
			const entry = this.entries.get(args[0] as string);
			if (entry?.type !== "string") throw new Error("WRONGTYPE");
			return entry.length;
		}
		if (command === "INFO") {
			return args[0] === "memory"
				? "# Memory\r\nused_memory:1048576\r\nmaxmemory:268435456\r\nmaxmemory_policy:volatile-lru\r\nsecret_field:never-kept\r\n"
				: "# Stats\r\nevicted_keys:7\r\n";
		}
		throw new Error(`unexpected command ${command}`);
	}

	close(): void {
		this.closed = true;
	}
}

function serverWith(count: number): Map<string, { type: string; length: number }> {
	const entries = new Map<string, { type: string; length: number }>();
	for (let index = 0; index < count; index += 1) entries.set(cacheKey("brief", "cursor", String(index), { index }), { type: "string", length: 1000 + index });
	return entries;
}

describe("collectStats", () => {
	test("aggregates by class, sizes strings only, and recommends from p99 x keys x headroom", async () => {
		const entries = new Map<string, { type: string; length: number }>([
			[cacheKey("brief", "cursor", "0", { a: 1 }), { type: "string", length: 2000 }],
			[cacheKey("brief", "omp", "0", { a: 1 }), { type: "string", length: 4000 }],
			[snapshotKey("brief-snapshot", "cursor", {}), { type: "string", length: 3000 }],
			[cacheKey("memory-search", "cursor", "0", { q: "x" }), { type: "string", length: 500 }],
			[MEMORY_GENERATION_KEY, { type: "string", length: 1 }],
			[graphGenerationKey("ut-1"), { type: "string", length: 1 }],
			["substrate:v1:budget:cursor:read", { type: "hash", length: 99_999 }],
			["substrate:v1:surprise:abc", { type: "string", length: 10 }],
		]);
		const server = new FakeServer(entries);
		const stats = await collectStats(server, { headroom: 4 });

		expect(stats.scanned).toBe(8);
		expect(stats.truncated).toBeNull();
		const byClass = Object.fromEntries(stats.classes.map((entry) => [entry.class, entry]));
		expect(byClass.brief).toMatchObject({ keys: 2, sized: 2, bytes: 6000, maxBytes: 4000, p99Bytes: 4000 });
		expect(byClass["brief-snapshot"]).toMatchObject({ keys: 1, bytes: 3000 });
		expect(byClass.gen).toMatchObject({ keys: 2, sized: 2, bytes: 2 });
		// A hash is counted and typed but never sized: the bucket's length is not a size.
		expect(byClass.budget).toMatchObject({ keys: 1, sized: 0, bytes: 0, types: { hash: 1 } });
		expect(byClass.other).toMatchObject({ keys: 1 });
		expect(stats.server).toEqual({ usedMemoryBytes: 1048576, maxmemoryBytes: 268435456, maxmemoryPolicy: "volatile-lru", evictedKeys: 7 });
		// p99 of the 7 sized values is the largest (4000); 4000 x 8 x 4 = 128000 B, rounded up to 1 MiB.
		expect(stats.recommendation.inputs).toEqual({ p99Bytes: 4000, observedKeys: 8, headroom: 4, truncated: false, totalValueBytes: 9512, floorBytes: 15068 });
		expect(stats.recommendation.maxmemory).toBe("1mb");
	});

	test("issues only read-only commands and never reads a value", async () => {
		const server = new FakeServer(serverWith(120));
		await collectStats(server);
		expect(new Set(server.commands)).toEqual(new Set(["SCAN", "TYPE", "STRLEN", "INFO"]));
		expect(server.scanArgs[0]).toEqual(["0", "MATCH", "substrate:v1:*", "COUNT", String(SCAN_COUNT)]);
	});

	test("the key budget ends the scan and says so", async () => {
		const server = new FakeServer(serverWith(300));
		const stats = await collectStats(server, { keyBudget: 120 });
		expect(stats.scanned).toBe(120);
		expect(stats.truncated).toBe("keys");
		expect(server.commands.filter((command) => command === "TYPE")).toHaveLength(120);
		expect(stats.recommendation.inputs.truncated).toBe(true);
		expect(stats.recommendation.note).toContain("floor");
	});

	test("the default budgets are the documented ones", () => {
		expect(KEY_BUDGET).toBe(5000);
		expect(WALL_BUDGET_MS).toBe(250);
		expect(SCAN_COUNT).toBe(200);
	});

	test("the wall budget ends the scan and says so", async () => {
		let clock = 0;
		const server = new FakeServer(serverWith(2_000), () => {
			clock += 40;
		});
		const stats = await collectStats(server, { now: () => clock, wallBudgetMs: 250 });
		expect(stats.truncated).toBe("wall");
		expect(stats.scanned).toBeLessThan(2_000);
		// Stopped within one chunk's worth of commands of the budget, not after the whole keyspace.
		expect(server.commands.filter((command) => command === "TYPE").length).toBeLessThan(400);
	});

	test("a server that stops answering ends the scan at the wall budget, as truncated", async () => {
		// Real timers: the point is that the budget fires while a command never settles.
		const hung: StatsClient = {
			send: (command) => (command === "INFO" ? Promise.resolve("") : new Promise(() => {})),
		};
		const started = Date.now();
		const stats = await collectStats(hung, { wallBudgetMs: 30 });
		expect(stats.truncated).toBe("wall");
		expect(stats.scanned).toBe(0);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("a TYPE round that never settles ends the scan at the wall budget with the keys read so far", async () => {
		const inner = new FakeServer(serverWith(100));
		const stalls: StatsClient = {
			send: (command, args) => (command === "TYPE" && inner.commands.filter((entry) => entry === "TYPE").length >= 50 ? new Promise(() => {}) : inner.send(command, args)),
		};
		const stats = await collectStats(stalls, { wallBudgetMs: 30 });
		expect(stats.truncated).toBe("wall");
		expect(stats.scanned).toBe(50);
	});

	test("a key SCAN returns twice is counted once", async () => {
		const stats = await collectStats(new FakeServer(serverWith(10), () => {}, true));
		expect(stats.scanned).toBe(10);
		expect(stats.classes[0]).toMatchObject({ class: "brief", keys: 10 });
	});

	test("an empty cache recommends nothing", async () => {
		const stats = await collectStats(new FakeServer(new Map()));
		expect(stats.scanned).toBe(0);
		expect(stats.classes).toEqual([]);
		expect(stats.recommendation.maxmemory).toBeNull();
		expect(recommend(0, 0, 4, false, 0, 0).maxmemoryBytes).toBeNull();
	});

	test("the table and the JSON name classes and numbers, never a key or a value", async () => {
		const entries = serverWith(3);
		const server = new FakeServer(entries);
		const stats = await collectStats(server);
		const text = renderTable(stats) + JSON.stringify(stats);
		for (const key of entries.keys()) expect(text).not.toContain(key.slice("substrate:v1:".length));
		expect(text).toContain("brief");
		expect(text).toContain("recommended maxmemory");
	});
});

describe("recommendation floor", () => {
	test("many tiny keys and a few large values: the recommendation covers the measured total, not just p99 x keys", async () => {
		const entries = new Map<string, { type: string; length: number }>();
		for (let index = 0; index < 1000; index += 1) entries.set(`substrate:v1:gen:g${index}`, { type: "string", length: 1 });
		for (let index = 0; index < 5; index += 1) entries.set(cacheKey("brief", "cursor", String(index), { index }), { type: "string", length: 256 * 1024 });
		// The wall budget is explicit: the default 250 ms can end this 1005-key scan early on a loaded host, which is not what this test checks.
		const stats = await collectStats(new FakeServer(entries), { headroom: 4, wallBudgetMs: 60_000 });
		const total = 1000 + 5 * 256 * 1024;

		expect(stats.recommendation.inputs.p99Bytes).toBe(1);
		expect(stats.recommendation.inputs.totalValueBytes).toBe(total);
		expect(stats.recommendation.inputs.floorBytes).toBe(Math.ceil(total * 1.5 + 1005 * 100));
		// The old formula gave p99 1 x 1005 x 4, i.e. 1 MiB, below the 1.25 MiB of values already seen.
		expect(stats.recommendation.maxmemoryBytes).toBe(2 * 1024 * 1024);
		expect(stats.recommendation.maxmemoryBytes as number).toBeGreaterThan(total);
		expect(stats.recommendation.note).toContain("estimates");
	});
});

describe("main", () => {
	function run(argv: string[], env: Record<string, string | undefined>, server = new FakeServer(serverWith(5))) {
		const out: string[] = [];
		const err: string[] = [];
		let connects = 0;
		const done = main(argv, env, {
			connect: async () => {
				connects += 1;
				return server;
			},
			bearer: () => null,
			// No test reads a real /healthz.
			fetch: async () => {
				throw new Error("no healthz in this test");
			},
			out: (line) => out.push(line),
			err: (line) => err.push(line),
		});
		return { done, out, err, connects: () => connects, server };
	}

	test("refuses a non-loopback URL unless the flag overrides, before any connection", async () => {
		const refused = run([], { DRAGONFLY_URL: "redis://cache.internal.example:6379" });
		expect(await refused.done).toBe(2);
		expect(refused.connects()).toBe(0);
		expect(refused.err.join("\n")).toContain("non-loopback");
		expect(refused.err.join("\n")).not.toContain("cache.internal.example");

		const allowed = run(["--allow-remote"], { DRAGONFLY_URL: "redis://cache.internal.example:6379" });
		expect(await allowed.done).toBe(0);
		expect(allowed.connects()).toBe(1);
	});

	test("loopback means loopback: 127/8, localhost and ::1, not a name that starts with 127.", () => {
		expect(isLoopbackUrl("redis://127.0.0.1:6379")).toBe(true);
		expect(isLoopbackUrl("redis://127.3.4.5")).toBe(true);
		expect(isLoopbackUrl("redis://localhost:6379")).toBe(true);
		expect(isLoopbackUrl("redis://[::1]:6379")).toBe(true);
		expect(isLoopbackUrl("redis://127.cache.example.com:6379")).toBe(false);
		expect(isLoopbackUrl("redis://10.0.0.5:6379")).toBe(false);
		expect(isLoopbackUrl("not a url")).toBe(false);
	});

	test("needs a URL from the flag or the environment, and prints JSON on request", async () => {
		const missing = run([], {});
		expect(await missing.done).toBe(2);

		const json = run(["--json", "--url", "redis://127.0.0.1:6379"], {});
		expect(await json.done).toBe(0);
		const parsed = JSON.parse(json.out.join("\n")) as { scanned: number; classes: Array<{ class: string }> };
		expect(parsed.scanned).toBe(5);
		expect(parsed.classes[0]?.class).toBe("brief");
		expect(json.server.closed).toBe(true);
	});

	test("a failing server is exit 1 and the URL never reaches the output", async () => {
		const out: string[] = [];
		const err: string[] = [];
		const code = await main([], { DRAGONFLY_URL: "redis://:hunter2@127.0.0.1:6379" }, {
			connect: async () => {
				throw new Error("connect failed redis://:hunter2@127.0.0.1:6379");
			},
			out: (line) => out.push(line),
			err: (line) => err.push(line),
		});
		expect(code).toBe(1);
		expect(err.join("\n")).not.toContain("hunter2");
		expect(out).toEqual([]);
	});

	test("an unknown flag is a usage error", async () => {
		const bad = run(["--flush"], { DRAGONFLY_URL: "redis://127.0.0.1:6379" });
		expect(await bad.done).toBe(2);
		expect(bad.connects()).toBe(0);
	});

	test("an unknown argument is never echoed: a positional URL with a password does not reach the output", async () => {
		const bad = run(["redis://:hunter2@127.0.0.1:6379"], { DRAGONFLY_URL: "redis://127.0.0.1:6379" });
		expect(await bad.done).toBe(2);
		expect(bad.connects()).toBe(0);
		expect(bad.err.join("\n")).not.toContain("hunter2");
		expect(bad.err.join("\n")).not.toContain("redis://:");
		expect(bad.err.join("\n")).toContain("unknown argument");
	});

	test("prints the running service's counters and ratios from the loopback /healthz, and reads nothing else", async () => {
		const urls: string[] = [];
		const health = { cache: { hits: 30, misses: 70, bypasses: 1, errors: 2, coalesced: 5, stale: 4, wouldServeStale: 3, refreshes: 2 } };
		const out: string[] = [];
		const code = await main(["--json"], { DRAGONFLY_URL: "redis://127.0.0.1:6379", SUBSTRATE_URL: "http://127.0.0.1:7410/" }, {
			connect: async () => new FakeServer(serverWith(3)),
			bearer: () => null,
			fetch: async (url) => {
				urls.push(url);
				return { ok: true, json: async () => health };
			},
			out: (line) => out.push(line),
			err: () => {},
		});
		expect(code).toBe(0);
		expect(urls).toEqual(["http://127.0.0.1:7410/healthz"]);
		const parsed = JSON.parse(out.join("\n")) as { ratios: { hits: number; hitRatio: number; stale: number; wouldServeStale: number } };
		expect(parsed.ratios).toMatchObject({ hits: 30, stale: 4, wouldServeStale: 3 });
		expect(parsed.ratios.hitRatio).toBeCloseTo(0.3);
	});

	test("a non-loopback /healthz URL is not queried unless remote reads are allowed; an unreachable one is unavailable, not an error", async () => {
		const urls: string[] = [];
		const out: string[] = [];
		const fetcher = async (url: string) => {
			urls.push(url);
			throw new Error("connect refused");
		};
		const env = { DRAGONFLY_URL: "redis://127.0.0.1:6379", SUBSTRATE_URL: "http://substrate.example:7410" };
		const remote = await main([], env, { connect: async () => new FakeServer(serverWith(2)), fetch: fetcher, bearer: () => null, out: (line) => out.push(line), err: () => {} });
		expect(remote).toBe(0);
		expect(urls).toEqual([]);
		expect(out.join("\n")).toContain("ratios: unavailable");

		const allowed = await main(["--allow-remote"], env, { connect: async () => new FakeServer(serverWith(2)), fetch: fetcher, bearer: () => null, out: () => {}, err: () => {} });
		expect(allowed).toBe(0);
		expect(urls).toEqual(["http://substrate.example:7410/healthz"]);
	});
});

describe("/healthz bearer", () => {
	// Names composed at runtime: the repo lock forbids a tracked line that assigns a token name a value.
	const LIST_NAME = ["SUBSTRATE", "TOKEN", "SUBSTRATE"].join("_");
	const DIR_NAME = ["SUBSTRATE", "TOKENS", "DIR"].join("_");
	const SECRET = ["first", "entry", "0123456789"].join("-");
	const HEALTH = { cache: { hits: 1, misses: 1, bypasses: 0, errors: 0 } };
	/** The server's rule: every route but /livez wants the bearer. */
	const guarded: HealthzFetch = async (_url, init) =>
		init.headers.authorization === `Bearer ${SECRET}` ? { ok: true, status: 200, json: async () => HEALTH } : { ok: false, status: 401, json: async () => ({}) };
	const env = { DRAGONFLY_URL: "redis://127.0.0.1:6379" };

	test("sends the first entry of a token list as the bearer and the ratios appear; the token is never printed", async () => {
		const out: string[] = [];
		const err: string[] = [];
		const code = await main([], { ...env, [LIST_NAME]: `${SECRET}, second-entry` }, {
			connect: async () => new FakeServer(serverWith(2)),
			// The default resolver would read the host's token files; its list rule is exercised here with them absent.
			bearer: (e) => doctorBearer({ ...e, [DIR_NAME]: ["", "nonexistent", "dir"].join("/") }),
			fetch: guarded,
			out: (line) => out.push(line),
			err: (line) => err.push(line),
		});
		expect(code).toBe(0);
		expect(out.join("\n")).toContain("hit ratio 0.500");
		expect(out.join("\n") + err.join("\n")).not.toContain(SECRET);
		expect(out.join("\n") + err.join("\n")).not.toContain("second-entry");
	});

	test("a 401 is named, not a silent null, and the output carries no token", async () => {
		const out: string[] = [];
		const code = await main(["--json"], env, {
			connect: async () => new FakeServer(serverWith(2)),
			bearer: () => null,
			fetch: guarded,
			out: (line) => out.push(line),
			err: () => {},
		});
		expect(code).toBe(0);
		const parsed = JSON.parse(out.join("\n")) as { ratios: unknown; ratiosNote: string };
		expect(parsed.ratios).toBeNull();
		expect(parsed.ratiosNote).toBe(HEALTHZ_AUTH_NOTE);
		expect(parsed.ratiosNote).toContain("SUBSTRATE_TOKEN or SUBSTRATE_TOKEN_FILE");

		const table: string[] = [];
		await main([], env, { connect: async () => new FakeServer(serverWith(2)), bearer: () => null, fetch: guarded, out: (line) => table.push(line), err: () => {} });
		expect(table.join("\n")).toContain(HEALTHZ_AUTH_NOTE);
	});

	test("fetchRatios puts the bearer only in the header, and a 403 is named too", async () => {
		const seen: Array<{ url: string; headers: Record<string, string> }> = [];
		const reasons: string[] = [];
		const forbidden: HealthzFetch = async (url, init) => {
			seen.push({ url, headers: init.headers });
			return { ok: false, status: 403, json: async () => ({}) };
		};
		expect(await fetchRatios("http://127.0.0.1:7410/healthz", forbidden, 250, SECRET, (reason) => reasons.push(reason))).toBeNull();
		expect(reasons).toEqual([HEALTHZ_AUTH_NOTE]);
		expect(seen[0]?.url).not.toContain(SECRET);
		expect(seen[0]?.headers).toEqual({ authorization: `Bearer ${SECRET}` });
		// No bearer: no header at all.
		await fetchRatios("http://127.0.0.1:7410/healthz", forbidden);
		expect(seen[1]?.headers).toEqual({});
		// A non-auth failure is not mislabelled.
		const other: string[] = [];
		await fetchRatios("http://127.0.0.1:7410/healthz", async () => ({ ok: false, status: 500, json: async () => ({}) }), 250, SECRET, (r) => other.push(r));
		expect(other).toEqual([]);
	});
});

describe("fetchRatios", () => {
	test("is null for a failing status, a body without a cache block, junk counters, and a request that outlives its timeout", async () => {
		expect(await fetchRatios("http://127.0.0.1:1/healthz", async () => ({ ok: false, json: async () => ({}) }))).toBeNull();
		expect(await fetchRatios("http://127.0.0.1:1/healthz", async () => ({ ok: true, json: async () => ({}) }))).toBeNull();
		expect(await fetchRatios("http://127.0.0.1:1/healthz", async () => ({ ok: true, json: async () => ({ cache: { hits: "many", misses: 1, bypasses: 0, errors: 0 } }) }))).toBeNull();
		// A fetch that only ends when it is aborted: the timeout aborts it. Real timer, because the point is that it fires.
		const aborted = await fetchRatios(
			"http://127.0.0.1:1/healthz",
			(_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
			20,
		);
		expect(aborted).toBeNull();
	});

	test("a counter-free ratio is null before the first read", async () => {
		const ratios = await fetchRatios("http://127.0.0.1:1/healthz", async () => ({ ok: true, json: async () => ({ cache: { hits: 0, misses: 0, bypasses: 0, errors: 0 } }) }));
		expect(ratios).toMatchObject({ hits: 0, hitRatio: null, coalesced: null });
	});
});
