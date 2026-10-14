/**
 * The read-only Hindsight inventory (uplift-4 S5): the plane's new GETs and
 * their closed op labels, the probe's bounds (pages, banks, names, one shared
 * deadline), the drift report, the gauges whose `bank` label can only be a
 * configured name, and `/healthz` / `/metrics` over a real socket. The plane is
 * the recording fake; nothing here writes to it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import {
	GAUGE_BANK_FACTS,
	GAUGE_BANK_FAILED,
	GAUGE_BANK_LAST_WRITE_AGE,
	GAUGE_BANK_PENDING,
	HindsightInventory,
	INVENTORY_MEMO_MS,
	MAX_DRIFT_NAMES,
	MAX_INVENTORY_BANKS,
	loadInventoryConfig,
	resolveInventoryBanks,
	safeBankName,
	type HindsightInventoryDeps,
} from "./hindsight-inventory.ts";
import { createObservability } from "./observe.ts";
import {
	BANK_LIST_PAGE,
	MAX_LISTED_BANKS,
	bankConfig,
	bankStats,
	hindsightOp,
	listBanks,
	type FetchLike,
	type HindsightConfig,
} from "./planes/hindsight.ts";
import type { TimerHandle, TimerSeam } from "./recall-snapshot.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

const CONFIG: HindsightConfig = { url: "http://fake", apiKey: "test-bearer", bankPrefix: "sub-" };
const T0 = Date.parse("2026-10-14T09:00:00.000Z");
const HOSTILE = 'sub-evil\n"; drop table<script>';

// ── fakes ────────────────────────────────────────────────────────────────────

class Handle implements TimerHandle {
	cleared = false;
	unrefed = false;
	constructor(
		readonly kind: "interval" | "timeout",
		readonly ms: number,
	) {}
	unref(): void {
		this.unrefed = true;
	}
}

class FakeTimers implements TimerSeam {
	readonly handles: Handle[] = [];
	setInterval(_handler: () => void, ms: number): TimerHandle {
		const handle = new Handle("interval", ms);
		this.handles.push(handle);
		return handle;
	}
	setTimeout(_handler: () => void, ms: number): TimerHandle {
		const handle = new Handle("timeout", ms);
		this.handles.push(handle);
		return handle;
	}
	clearInterval(handle: TimerHandle): void {
		(handle as Handle).cleared = true;
	}
	clearTimeout(handle: TimerHandle): void {
		(handle as Handle).cleared = true;
	}
}

interface Call {
	method: string;
	path: string;
	signal: AbortSignal | null;
}

interface Rig {
	inventory: HindsightInventory;
	fake: HindsightFake;
	calls: Call[];
	clock: { at: number };
	timers: FakeTimers;
}

function seed(fake: HindsightFake, bank: string, facts = 0): void {
	fake.seed(
		bank,
		Array.from({ length: facts }, (_, i) => ({ id: `${bank}-${i}`, text: `fact ${i}`, document_id: `${bank}-doc-${i}`, tags: [], metadata: {} })),
	);
}

function rig(options: {
	enabled?: boolean;
	banks?: string[] | null;
	fake?: HindsightFake;
	hindsight?: HindsightConfig | null;
	breakerOpen?: boolean;
	fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	budgetMs?: number;
} = {}): Rig {
	const fake = options.fake ?? new HindsightFake();
	const calls: Call[] = [];
	const clock = { at: T0 };
	const timers = new FakeTimers();
	const underlying = options.fetchImpl ?? fake.fetch;
	const fetchImpl: FetchLike = async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, signal: init?.signal ?? null });
		return underlying(input, init);
	};
	const deps: HindsightInventoryDeps = {
		config: { enabled: options.enabled ?? true, intervalS: 60 },
		hindsight: () => (options.hindsight === undefined ? CONFIG : options.hindsight),
		banks: () => (options.banks === undefined ? null : options.banks),
		fetchImpl,
		breakerOpen: () => options.breakerOpen === true,
		now: () => clock.at,
		timers,
		...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
	};
	return { inventory: new HindsightInventory(deps), fake, calls, clock, timers };
}

const bankCalls = (calls: readonly Call[]) => calls.filter((call) => call.path.startsWith("/v1/default/banks"));
const listCalls = (calls: readonly Call[]) => calls.filter((call) => call.path === "/v1/default/banks");

// ── the plane's GETs ─────────────────────────────────────────────────────────

describe("hindsightOp", () => {
	test("is a fixed table: the new reads have their own labels and nothing else grew", () => {
		expect(hindsightOp("GET", "http://fake/v1/default/banks?limit=50&offset=0")).toBe("bank-list");
		expect(hindsightOp("GET", "http://fake/v1/default/banks/sub-cursor/stats")).toBe("bank-stats");
		expect(hindsightOp("GET", "http://fake/v1/default/banks/sub-cursor/config")).toBe("bank-config");
		const closed = new Set(["health", "version", "recall", "retain", "document", "bank-config", "bank-list", "bank-stats", "bank-create", "bank-delete", "other"]);
		const probes: Array<[string, string]> = [
			["GET", "http://fake/health"],
			["GET", "http://fake/version"],
			["POST", "http://fake/v1/default/banks/sub-x/memories/recall"],
			["POST", "http://fake/v1/default/banks/sub-x/memories"],
			["GET", "http://fake/v1/default/banks/sub-x/documents/d1"],
			["GET", "http://fake/v1/default/banks"],
			["GET", `http://fake/v1/default/banks/${encodeURIComponent(HOSTILE)}/stats`],
			["GET", `http://fake/v1/default/banks/${encodeURIComponent(HOSTILE)}/config`],
			["PUT", `http://fake/v1/default/banks/${encodeURIComponent(HOSTILE)}`],
			["DELETE", "http://fake/v1/default/banks/sub-x"],
			["GET", "http://fake/something/else"],
		];
		for (const [method, url] of probes) expect(closed.has(hindsightOp(method, url))).toBe(true);
	});
});

describe("listBanks", () => {
	test("reads bounded pages and stops at the end of the list", async () => {
		const fake = new HindsightFake();
		for (let i = 0; i < 130; i++) seed(fake, `sub-b${i}`);
		const { calls } = rig({ fake });
		const listed = await listBanks(CONFIG, async (input, init) => {
			calls.push({ method: "GET", path: new URL(String(input)).pathname, signal: init?.signal ?? null });
			return fake.fetch(input, init);
		});
		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		expect(listed.value.banks).toHaveLength(130);
		expect(listed.value.truncated).toBe(false);
		expect(listCalls(calls)).toHaveLength(Math.ceil(130 / BANK_LIST_PAGE));
	});

	test("never reads past 200 banks and says the list was cut", async () => {
		const fake = new HindsightFake();
		for (let i = 0; i < 250; i++) seed(fake, `sub-b${i}`);
		const { calls } = rig({ fake });
		const listed = await listBanks(CONFIG, async (input, init) => {
			calls.push({ method: "GET", path: new URL(String(input)).pathname, signal: init?.signal ?? null });
			return fake.fetch(input, init);
		});
		expect(listed.ok && listed.value.banks.length).toBe(MAX_LISTED_BANKS);
		expect(listed.ok && listed.value.truncated).toBe(true);
		expect(listCalls(calls)).toHaveLength(MAX_LISTED_BANKS / BANK_LIST_PAGE);
	});

	test("exactly 200 banks is a complete list", async () => {
		const fake = new HindsightFake();
		for (let i = 0; i < 200; i++) seed(fake, `sub-b${i}`);
		const listed = await listBanks(CONFIG, fake.fetch);
		expect(listed.ok && listed.value.truncated).toBe(false);
		expect(listed.ok && listed.value.banks.length).toBe(200);
	});

	test("a failing page fails the listing instead of reading as a short list", async () => {
		const fake = new HindsightFake();
		seed(fake, "sub-a");
		fake.failListWith = 503;
		const listed = await listBanks(CONFIG, fake.fetch);
		expect(listed).toMatchObject({ ok: false, error: { kind: "server" } });
	});

	test("an entry without a text bank id is skipped, and a mistyped count is null", async () => {
		const body = { banks: [{ bank_id: 7 }, { bank_id: "sub-a", fact_count: "many", last_write_at: 5 }, { name: "no id" }], total: 3 };
		const listed = await listBanks(CONFIG, async () => Response.json(body));
		expect(listed).toEqual({ ok: true, value: { banks: [{ bank_id: "sub-a", fact_count: null, last_write_at: null }], truncated: false } });
	});
});

describe("bankStats and bankConfig", () => {
	test("read the backlog, the last write and the extraction mode", async () => {
		const fake = new HindsightFake();
		seed(fake, "sub-a", 2);
		fake.statsOverride["sub-a"] = { pending_operations: 3, failed_operations: 1, last_memory_write_at: "2026-10-14T08:00:00.000Z" };
		expect(await bankStats(CONFIG, "sub-a", fake.fetch)).toEqual({ ok: true, value: { pending_operations: 3, failed_operations: 1, last_write_at: "2026-10-14T08:00:00.000Z" } });
		expect(await bankConfig(CONFIG, "sub-a", fake.fetch)).toEqual({ ok: true, value: { retain_extraction_mode: "chunks" } });
	});

	test("a missing bank is a not-found error, never a write", async () => {
		const fake = new HindsightFake();
		expect(await bankStats(CONFIG, "sub-none", fake.fetch)).toMatchObject({ ok: false, error: { kind: "not-found" } });
		expect(await bankConfig(CONFIG, "sub-none", fake.fetch)).toMatchObject({ ok: false, error: { kind: "not-found" } });
		expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
		expect(fake.banks.size).toBe(0);
	});
});

// ── settings ─────────────────────────────────────────────────────────────────

describe("loadInventoryConfig", () => {
	test("off by default, 60 s, no warnings", () => {
		expect(loadInventoryConfig({})).toEqual({ enabled: false, intervalS: 60, warnings: [] });
	});

	test("on is exactly on; a typo stays off and says so; the interval floors at 30 s", () => {
		expect(loadInventoryConfig({ SUBSTRATE_HINDSIGHT_INVENTORY: "ON" }).enabled).toBe(true);
		const typo = loadInventoryConfig({ SUBSTRATE_HINDSIGHT_INVENTORY: "yes" });
		expect(typo.enabled).toBe(false);
		expect(typo.warnings.join(" ")).toContain("stays off");
		const fast = loadInventoryConfig({ SUBSTRATE_HINDSIGHT_INVENTORY_INTERVAL_S: "3" });
		expect(fast.intervalS).toBe(30);
		expect(fast.warnings).toHaveLength(1);
		expect(loadInventoryConfig({ SUBSTRATE_HINDSIGHT_INVENTORY_INTERVAL_S: "later" }).intervalS).toBe(60);
	});
});

describe("safeBankName and resolveInventoryBanks", () => {
	test("a plane name keeps only plain characters and 64 of them", () => {
		expect(safeBankName(HOSTILE)).toBe("sub-evil????drop?table?script?");
		expect(safeBankName("s".repeat(200))).toHaveLength(64);
	});

	test("the configured list is deduplicated and capped at 16", () => {
		const many = Array.from({ length: 30 }, (_, i) => `sub-c${i}`);
		expect(resolveInventoryBanks([...many, ...many])).toHaveLength(MAX_INVENTORY_BANKS);
		expect(resolveInventoryBanks(null)).toEqual([]);
	});
});

// ── the probe ────────────────────────────────────────────────────────────────

describe("HindsightInventory", () => {
	test("off: no call, no block, no gauges, no timer", async () => {
		const { inventory, calls, timers } = rig({ enabled: false, banks: ["sub-a"] });
		expect(await inventory.refresh()).toBeNull();
		expect(await inventory.refresh({ force: true })).toBeNull();
		expect(inventory.start()).toBe(false);
		expect(inventory.health()).toBeNull();
		expect(inventory.gauges()).toEqual([]);
		expect(calls).toEqual([]);
		expect(timers.handles).toEqual([]);
	});

	test("reports drift by name, calls only the configured banks, and labels gauges only from the configured list", async () => {
		const fake = new HindsightFake();
		seed(fake, "sub-grok-bot", 4);
		seed(fake, "sub-omp", 2);
		seed(fake, "sub-extra", 9);
		seed(fake, HOSTILE, 1);
		seed(fake, "pd-desk", 7);
		fake.banks.get("sub-omp")!.mode = "server-default";
		fake.statsOverride["sub-grok-bot"] = { pending_operations: 3, failed_operations: 1 };
		fake.lastWriteAt["sub-grok-bot"] = new Date(T0 - 90_000).toISOString();
		const { inventory, calls, clock } = rig({ fake, banks: ["sub-grok-bot", "sub-omp", "sub-missing"] });

		const report = await inventory.refresh();
		expect(report?.ok).toBe(true);
		expect(report?.drift.missing).toEqual(["sub-missing"]);
		expect(report?.drift.notChunks).toEqual(["sub-omp"]);
		expect([...(report?.drift.unconfigured ?? [])].sort()).toEqual(["sub-evil????drop?table?script?", "sub-extra"].sort());
		expect(report?.drift.more).toBe(0);
		// The deployment's own `pd-*` bank is outside the prefix: neither drift nor a call.
		expect(JSON.stringify(report?.drift)).not.toContain("pd-desk");
		expect(JSON.stringify(report?.drift)).not.toContain("<script>");

		// One list page, then stats and config for the two configured banks the plane has. Nothing else, and nothing but GETs.
		expect(bankCalls(calls).map((call) => `${call.method} ${call.path}`).sort()).toEqual(
			[
				"GET /v1/default/banks",
				"GET /v1/default/banks/sub-grok-bot/config",
				"GET /v1/default/banks/sub-grok-bot/stats",
				"GET /v1/default/banks/sub-omp/config",
				"GET /v1/default/banks/sub-omp/stats",
			].sort(),
		);
		expect(fake.requests.every((request) => request.method === "GET")).toBe(true);

		const gauges = inventory.gauges();
		expect(new Set(gauges.map((sample) => sample.attributes.bank))).toEqual(new Set(["sub-grok-bot", "sub-omp"]));
		const read = (name: string, bank: string) => gauges.find((sample) => sample.name === name && sample.attributes.bank === bank)?.value;
		expect(read(GAUGE_BANK_FACTS, "sub-grok-bot")).toBe(4);
		expect(read(GAUGE_BANK_PENDING, "sub-grok-bot")).toBe(3);
		expect(read(GAUGE_BANK_FAILED, "sub-grok-bot")).toBe(1);
		expect(read(GAUGE_BANK_LAST_WRITE_AGE, "sub-grok-bot")).toBe(90);
		// The age keeps growing between probes: it is read against the clock, not frozen.
		clock.at += 30_000;
		expect(inventory.gauges().find((sample) => sample.name === GAUGE_BANK_LAST_WRITE_AGE && sample.attributes.bank === "sub-grok-bot")?.value).toBe(120);
		for (const sample of gauges) expect(Object.keys(sample.attributes)).toEqual(["bank"]);
	});

	test("a server that caps pages below 50 does not end the list early while the total says more", async () => {
		const fake = new HindsightFake();
		for (let i = 0; i < 120; i++) seed(fake, `sub-b${i}`);
		fake.listPageCap = 25;
		const { calls } = rig({ fake });
		const listed = await listBanks(CONFIG, async (input, init) => {
			calls.push({ method: "GET", path: new URL(String(input)).pathname, signal: init?.signal ?? null });
			return fake.fetch(input, init);
		});
		expect(listed.ok && listed.value.banks).toHaveLength(120);
		expect(listed.ok && listed.value.truncated).toBe(false);
		expect(listCalls(calls)).toHaveLength(5);
	});

	test("a configured bank past a capped first page is present, not missing, and keeps its gauges", async () => {
		const fake = new HindsightFake();
		for (let i = 0; i < 60; i++) seed(fake, `sub-b${i}`, 1);
		fake.listPageCap = 25;
		const { inventory } = rig({ fake, banks: ["sub-b55"] });
		const report = await inventory.refresh();
		expect(report?.drift.missing).toEqual([]);
		expect(inventory.gauges().some((sample) => sample.attributes.bank === "sub-b55" && sample.name === GAUGE_BANK_FACTS)).toBe(true);
	});

	test("a server that never ends its pages is cut at the page bound and said to be", async () => {
		const forever: FetchLike = async () => Response.json({ banks: [{ bank_id: 7 }], total: 1_000_000 });
		const listed = await listBanks(CONFIG, forever);
		expect(listed.ok && listed.value.truncated).toBe(true);
	});

	test("the health block names the same facts and never a plane string as a label", async () => {
		const fake = new HindsightFake();
		seed(fake, "sub-a", 1);
		seed(fake, HOSTILE, 1);
		const { inventory } = rig({ fake, banks: ["sub-a"] });
		expect(inventory.health()).toMatchObject({ checkedAt: null, ok: null, banks: [] });
		await inventory.refresh();
		const block = inventory.health();
		expect(block?.ok).toBe(true);
		expect(block?.upstreamBanks).toBe(2);
		expect(block?.banks.map((bank) => bank.bank)).toEqual(["sub-a"]);
		expect(block?.drift.unconfigured).toEqual([safeBankName(HOSTILE)]);
		expect(JSON.stringify(block)).not.toContain("<script>");
	});

	test("per-bank calls cover at most 16 configured banks", async () => {
		const fake = new HindsightFake();
		const names = Array.from({ length: 20 }, (_, i) => `sub-c${i}`);
		for (const name of names) seed(fake, name);
		const { inventory, calls } = rig({ fake, banks: names });
		const report = await inventory.refresh();
		expect(report?.banks).toHaveLength(MAX_INVENTORY_BANKS);
		expect(calls.filter((call) => call.path.endsWith("/stats"))).toHaveLength(MAX_INVENTORY_BANKS);
		expect(calls.filter((call) => call.path.endsWith("/config"))).toHaveLength(MAX_INVENTORY_BANKS);
		// The four banks past the cap are never read; the deployment has them and the probe's list does not, so they show as unconfigured.
		expect(report?.drift.missing).toEqual([]);
		expect(report?.drift.unconfigured).toEqual(["sub-c16", "sub-c17", "sub-c18", "sub-c19"]);
	});

	test("a drift list is cut at 20 names and counts the rest", async () => {
		const fake = new HindsightFake();
		for (let i = 0; i < 30; i++) seed(fake, `sub-x${i}`);
		const { inventory } = rig({ fake, banks: [] });
		const report = await inventory.refresh();
		expect(report?.drift.unconfigured).toHaveLength(MAX_DRIFT_NAMES);
		expect(report?.drift.more).toBe(10);
	});

	test("one deadline, shared by every call, rides each request", async () => {
		const fake = new HindsightFake();
		seed(fake, "sub-a");
		seed(fake, "sub-b");
		const { inventory, calls } = rig({ fake, banks: ["sub-a", "sub-b"] });
		await inventory.refresh();
		expect(calls.length).toBeGreaterThan(3);
		expect(new Set(calls.map((call) => call.signal)).size).toBe(1);
		expect(calls[0]?.signal).not.toBeNull();
	});

	test("a plane that stalls is cut by that deadline and reported as a timeout", async () => {
		// The deadline is an AbortSignal built inside the probe; there is no seam for its clock, so this one waits 1 ms for real.
		const stalled = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("deadline"), { name: "TimeoutError" })), { once: true });
			});
		const { inventory } = rig({ banks: ["sub-a"], fetchImpl: stalled, budgetMs: 1 });
		const report = await inventory.refresh();
		expect(report).toMatchObject({ ok: false, reason: "timeout" });
		expect(inventory.gauges()).toEqual([]);
	});

	test("an unwell plane stops the probe: the first failing bank halts the rest", async () => {
		const fake = new HindsightFake();
		for (const name of ["sub-a", "sub-b", "sub-c"]) seed(fake, name);
		const failing = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
			String(input).endsWith("/stats") ? Promise.resolve(Response.json({ detail: "down" }, { status: 503 })) : fake.fetch(input, init);
		const { inventory, calls } = rig({ fake, banks: ["sub-a", "sub-b", "sub-c"], fetchImpl: failing });
		const report = await inventory.refresh();
		expect(report?.banks.map((bank) => bank.error)).toEqual(["server", "skipped", "skipped"]);
		expect(bankCalls(calls).map((call) => call.path)).toEqual(["/v1/default/banks", "/v1/default/banks/sub-a/stats"]);
	});

	test("an open breaker, an unconfigured plane and a failing listing are reports with a fixed reason, never plane text", async () => {
		const open = rig({ banks: ["sub-a"], breakerOpen: true });
		expect(await open.inventory.refresh()).toMatchObject({ ok: false, reason: "circuit-open" });
		expect(open.calls).toEqual([]);

		const none = rig({ banks: ["sub-a"], hindsight: null });
		expect(await none.inventory.refresh()).toMatchObject({ ok: false, reason: "unconfigured" });
		expect(none.calls).toEqual([]);

		const fake = new HindsightFake();
		fake.failListWith = 503;
		const down = rig({ fake, banks: ["sub-a"] });
		const report = await down.inventory.refresh();
		expect(report).toMatchObject({ ok: false, reason: "server" });
		expect(down.inventory.health()).toMatchObject({ ok: false, reason: "server", upstreamBanks: null });
		expect(down.inventory.gauges()).toEqual([]);
	});

	test("single-flight and a 60 s memo: concurrent callers share one probe, a young one is served again, force and age reprobe", async () => {
		const fake = new HindsightFake();
		seed(fake, "sub-a");
		const { inventory, calls, clock } = rig({ fake, banks: ["sub-a"] });
		const [first, second] = await Promise.all([inventory.refresh(), inventory.refresh()]);
		expect(second).toBe(first);
		expect(listCalls(calls)).toHaveLength(1);

		clock.at += INVENTORY_MEMO_MS - 1;
		expect(await inventory.refresh()).toBe(first);
		expect(listCalls(calls)).toHaveLength(1);

		await inventory.refresh({ force: true });
		expect(listCalls(calls)).toHaveLength(2);
		clock.at += INVENTORY_MEMO_MS;
		await inventory.refresh();
		expect(listCalls(calls)).toHaveLength(3);
	});

	test("start schedules one unref'd interval and a first probe; stop clears it and waits for the probe in flight", async () => {
		const fake = new HindsightFake();
		seed(fake, "sub-a");
		const { inventory, timers, calls } = rig({ fake, banks: ["sub-a"] });
		expect(inventory.start()).toBe(true);
		expect(inventory.start()).toBe(false);
		const [interval] = timers.handles.filter((handle) => handle.kind === "interval");
		expect(interval?.ms).toBe(60_000);
		expect(interval?.unrefed).toBe(true);
		await inventory.stop();
		expect(interval?.cleared).toBe(true);
		expect(inventory.last()?.ok).toBe(true);
		expect(listCalls(calls)).toHaveLength(1);
	});
});

// ── /healthz and /metrics over a socket ──────────────────────────────────────

const running: Array<{ close(): void }> = [];

async function serve(env: Record<string, string>, fake: HindsightFake) {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const substrate = new Substrate(config, { index: null, greptime: null, hindsightFetch: fake.fetch } as ConstructorParameters<typeof Substrate>[1], observability.observer);
	const server = createHttpServer(substrate, config, observability);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	running.push({
		close() {
			observability.stop();
			server.close();
		},
	});
	return { substrate, base: `http://127.0.0.1:${port}` };
}

afterAll(() => {
	for (const harness of running) harness.close();
});

async function withHindsightEnv<T>(body: () => Promise<T>): Promise<T> {
	const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	process.env.HINDSIGHT_URL = "http://fake";
	process.env.HINDSIGHT_API_KEY = "test-bearer";
	process.env.HINDSIGHT_BANKS = "sub-grok-bot,sub-missing";
	try {
		return await body();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

describe("GET /healthz and GET /metrics", () => {
	test("off: /healthz has no hindsight block, no inventory call is made, and the outbox gauges are still served", async () => {
		await withHindsightEnv(async () => {
			const fake = new HindsightFake();
			seed(fake, "sub-grok-bot", 1);
			const { base } = await serve({}, fake);
			const health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
			expect("hindsight" in health).toBe(false);
			const metrics = (await (await fetch(`${base}/metrics`)).json()) as { metrics: Array<{ name: string; kind: string; points: Array<{ value: number }> }>; gauges?: unknown[] };
			const outbox = metrics.metrics.filter((metric) => metric.name.startsWith("substrate.hindsight.retain_outbox."));
			expect(outbox.map((metric) => metric.name).sort()).toEqual([
				"substrate.hindsight.retain_outbox.durable",
				"substrate.hindsight.retain_outbox.oldest_age_seconds",
				"substrate.hindsight.retain_outbox.size",
			]);
			for (const metric of outbox) expect(metric.kind).toBe("gauge");
			expect(metrics.gauges ?? []).toEqual([]);
			expect(fake.requests.filter((request) => request.path === "/v1/default/banks" || request.path.endsWith("/stats"))).toEqual([]);
		});
	});

	test("on: the probed block is additive, the bank gauges ride under gauges, and no existing field changes", async () => {
		await withHindsightEnv(async () => {
			const fake = new HindsightFake();
			seed(fake, "sub-grok-bot", 3);
			seed(fake, "sub-extra", 1);
			seed(fake, HOSTILE, 1);
			const { substrate, base } = await serve({ SUBSTRATE_HINDSIGHT_INVENTORY: "on" }, fake);
			await substrate.refreshHindsightInventory();
			const health = (await (await fetch(`${base}/healthz`)).json()) as {
				planes: unknown;
				cache: unknown;
				hindsight: { ok: boolean; drift: { missing: string[]; unconfigured: string[] }; banks: Array<{ bank: string; facts: number }> };
			};
			expect(health.planes).toBeDefined();
			expect(health.cache).toBeDefined();
			expect(health.hindsight.ok).toBe(true);
			expect(health.hindsight.drift.missing).toEqual(["sub-missing"]);
			expect(health.hindsight.drift.unconfigured.sort()).toEqual([safeBankName(HOSTILE), "sub-extra"].sort());
			expect(health.hindsight.banks.find((bank) => bank.bank === "sub-grok-bot")?.facts).toBe(3);

			const metrics = (await (await fetch(`${base}/metrics`)).json()) as { gauges?: Array<{ name: string; attributes: { bank: string }; value: number }> };
			const facts = (metrics.gauges ?? []).filter((gauge) => gauge.name === GAUGE_BANK_FACTS);
			expect(facts).toEqual([expect.objectContaining({ attributes: { bank: "sub-grok-bot" }, value: 3 })]);
			expect(JSON.stringify(metrics)).not.toContain("<script>");
		});
	});
});
