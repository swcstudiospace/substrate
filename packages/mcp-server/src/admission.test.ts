/**
 * Admission budgets (uplift-3 N3).
 *
 * The bucket is pinned through the TS reference (`bucketStep`) and through
 * `Admission` driving a fake `EVAL` that executes that reference, so the
 * decision path — modes, bypasses, rounding, the key and argument contract the
 * Lua is called with — is covered without a socket. The Lua text itself is
 * pinned by its contract here and run against a real redis in the smoke.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ADMISSION_CLASSES, ADMISSION_DECISIONS, type AdmissionClass } from "@substrate/observability";
import {
	ADMISSION_MODES,
	ANONYMOUS_IDENTITY,
	Admission,
	BUDGET_SCRIPT,
	DEFAULT_CLASS,
	MCP_ROUTE,
	MONITOR_ROUTES,
	ROUTE_CLASSES,
	TOOL_CLASSES,
	admitBatch,
	bucketStep,
	bucketTtlMs,
	budgetBody,
	budgetKey,
	budgetRefusal,
	limitFor,
	retryAfterSeconds,
	routeClass,
	toolClass,
	type AdmissionSettings,
	type AdmissionVerdict,
	type BucketState,
} from "./admission.ts";
import type { CacheRedis, ScriptOutcome } from "./cache.ts";
import { DEFAULT_BUDGETS, loadAdmissionSettings } from "./config.ts";
import { defined } from "./test-support.ts";
import { createTestLiveSessionAuthority, issueLiveSession } from "./planning/live-session.test-support.ts";
import { LiveSessionBoundary, type LiveSessionInvocation } from "./planning/steering-tools.ts";
import { SURFACES, type EventInput } from "./types.ts";

/**
 * A redis whose `EVAL` executes `bucketStep` for `BUDGET_SCRIPT`, keeping the
 * state and TTL the script would write. The plain commands are enough for a
 * `ReadThroughCache` to be built over it (the HTTP tests do).
 */
export class FakeBudgetRedis implements CacheRedis {
	readonly buckets = new Map<string, { state: BucketState; ttlMs: number }>();
	readonly calls: Array<{ script: string; keys: readonly string[]; args: readonly string[] }> = [];
	readonly values = new Map<string, string>();
	/** When set, every command rejects with this message. */
	fail: string | null = null;
	/** When set, `EVAL` resolves this instead of the bucket's reply. */
	reply: unknown = undefined;

	async get(key: string): Promise<string | null> {
		if (this.fail) throw new Error(this.fail);
		return this.values.get(key) ?? null;
	}

	async set(key: string, value: string): Promise<void> {
		if (this.fail) throw new Error(this.fail);
		this.values.set(key, value);
	}

	async incr(key: string): Promise<number> {
		if (this.fail) throw new Error(this.fail);
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}

	async eval(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown> {
		this.calls.push({ script, keys, args });
		if (this.fail) throw new Error(this.fail);
		if (this.reply !== undefined) return this.reply;
		if (script !== BUDGET_SCRIPT) throw new Error("unknown script");
		const [rps, burst, now, cost] = args.map(Number) as [number, number, number, number];
		const key = defined(keys[0], "key");
		const step = bucketStep(this.buckets.get(key)?.state ?? null, { rps, burst }, now, cost);
		this.buckets.set(key, { state: step.state, ttlMs: step.ttlMs });
		return [step.allowed ? 1 : 0, step.tokensLeft, step.retryAfterMs];
	}
}

const LIMIT = { rps: 10, burst: 20 };

describe("bucketStep, the reference the Lua mirrors", () => {
	test("a new bucket starts full and a debit leaves burst minus cost", () => {
		const step = bucketStep(null, LIMIT, 1_000, 1);
		expect(step.allowed).toBe(true);
		expect(step.tokensLeft).toBe(19);
		expect(step.retryAfterMs).toBe(0);
		expect(step.state).toEqual({ tokens: 19, at: 1_000 });
	});

	test("refills rate × elapsed and never above the burst", () => {
		const drained = { tokens: 0, at: 1_000 };
		// 250 ms at 10 rps is 2.5 tokens: enough for one, 1.5 left, floored to 1.
		const some = bucketStep(drained, LIMIT, 1_250, 1);
		expect(some.allowed).toBe(true);
		expect(some.tokensLeft).toBe(1);
		expect(some.state.tokens).toBe(1.5);
		// An hour idle refills to the burst, not to 36 000.
		const idle = bucketStep(drained, LIMIT, 3_601_000, 1);
		expect(idle.state.tokens).toBe(19);
	});

	test("a refusal reports the wait until the cost has refilled and debits nothing", () => {
		const low = { tokens: 0.5, at: 1_000 };
		const step = bucketStep(low, LIMIT, 1_000, 1);
		expect(step.allowed).toBe(false);
		// 0.5 tokens short at 10 rps is 50 ms.
		expect(step.retryAfterMs).toBe(50);
		expect(step.state.tokens).toBe(0.5);
		expect(step.tokensLeft).toBe(0);
	});

	test("a clock that went backwards refills nothing rather than debiting", () => {
		const step = bucketStep({ tokens: 3, at: 5_000 }, LIMIT, 4_000, 1);
		expect(step.state.tokens).toBe(2);
		expect(step.state.at).toBe(4_000);
	});

	test("a cost above the burst is never admitted, even from a full bucket", () => {
		const step = bucketStep(null, LIMIT, 1_000, 21);
		expect(step.allowed).toBe(false);
		expect(step.retryAfterMs).toBe(100);
	});

	test("the TTL is the refill time of a full burst, never under a second", () => {
		expect(bucketTtlMs(LIMIT)).toBe(2_000);
		expect(bucketTtlMs({ rps: 100, burst: 10 })).toBe(1_000);
		expect(bucketTtlMs({ rps: 0.5, burst: 4 })).toBe(8_000);
		expect(bucketStep(null, { rps: 3, burst: 10 }, 0, 1).ttlMs).toBe(3_334);
	});

	test("Retry-After is the ceiling in whole seconds and never 0 for a refusal", () => {
		expect(retryAfterSeconds(50)).toBe(1);
		expect(retryAfterSeconds(1_000)).toBe(1);
		expect(retryAfterSeconds(1_001)).toBe(2);
		expect(retryAfterSeconds(0)).toBe(1);
	});
});

describe("the Lua text's contract", () => {
	test("one key, four arguments, no server clock, a three-integer reply with a TTL", () => {
		expect(BUDGET_SCRIPT).toContain("KEYS[1]");
		for (const index of [1, 2, 3, 4]) expect(BUDGET_SCRIPT).toContain(`ARGV[${index}]`);
		expect(BUDGET_SCRIPT).not.toContain("ARGV[5]");
		expect(BUDGET_SCRIPT).not.toContain("KEYS[2]");
		// Time is the process's `now_ms`, so a fake clock decides the same way redis does.
		expect(BUDGET_SCRIPT).not.toContain("TIME");
		expect(BUDGET_SCRIPT).toContain("redis.call('HMGET', KEYS[1], 't', 'at')");
		expect(BUDGET_SCRIPT).toContain("redis.call('HSET', KEYS[1], 't', tostring(tokens), 'at', tostring(now))");
		expect(BUDGET_SCRIPT).toContain("redis.call('PEXPIRE', KEYS[1], ttl)");
		expect(BUDGET_SCRIPT).toContain("local ttl = math.max(1000, math.ceil(burst * 1000 / rps))");
		expect(BUDGET_SCRIPT.trimEnd().endsWith("return {allowed, math.floor(tokens), retry}")).toBe(true);
	});

	test("the key is the cache prefix's budget class, by identity and class", () => {
		expect(budgetKey("grok-bot", "read")).toBe("substrate:v1:budget:grok-bot:read");
		expect(budgetKey(ANONYMOUS_IDENTITY, "coordination")).toBe("substrate:v1:budget:anonymous:coordination");
	});
});

function settings(over: Partial<AdmissionSettings> = {}): AdmissionSettings {
	return {
		mode: "enforce",
		classes: { read: { rps: 1, burst: 2 }, write: { rps: 1, burst: 1 }, coordination: { rps: 5, burst: 5 } },
		anonymous: { rps: 1, burst: 1 },
		overrides: {},
		...over,
	};
}

function admissionOver(redis: FakeBudgetRedis, over: Partial<AdmissionSettings> = {}, clock: { now: number } = { now: 10_000 }) {
	const recorded: AdmissionVerdict[] = [];
	const admission = new Admission(settings(over), {
		script: async (script, keys, args) => ({ ok: true, value: await redis.eval(script, keys, args) }),
		now: () => clock.now,
		record: (verdict) => recorded.push(verdict),
	});
	return { admission, recorded, clock };
}

describe("Admission", () => {
	test("calls the script with the bucket key, the limit, the process clock and the cost", async () => {
		const redis = new FakeBudgetRedis();
		const { admission } = admissionOver(redis, {}, { now: 12_345.6 });
		const verdict = await admission.admit({ surface: "cursor", klass: "read", cost: 1 });

		expect(verdict).toMatchObject({ decision: "allowed", surface: "cursor", klass: "read", cost: 1, tokensLeft: 1, retryAfterS: 0 });
		expect(redis.calls).toEqual([{ script: BUDGET_SCRIPT, keys: ["substrate:v1:budget:cursor:read"], args: ["1", "2", "12345", "1"] }]);
	});

	test("enforce refuses the (burst + 1)th call with a Retry-After of at least one second, and admits again after it", async () => {
		const redis = new FakeBudgetRedis();
		const { admission, recorded, clock } = admissionOver(redis);
		const request = { surface: "cursor" as const, klass: "read" as const, cost: 1 };
		expect((await admission.admit(request)).decision).toBe("allowed");
		expect((await admission.admit(request)).decision).toBe("allowed");
		const refused = await admission.admit(request);
		expect(refused).toMatchObject({ decision: "limited", retryAfterMs: 1_000, retryAfterS: 1, tokensLeft: 0 });
		clock.now += 1_000;
		expect((await admission.admit(request)).decision).toBe("allowed");
		expect(recorded.map((entry) => entry.decision)).toEqual(["allowed", "allowed", "limited", "allowed"]);
	});

	test("shadow decides and records shadow_limited but never answers limited", async () => {
		const redis = new FakeBudgetRedis();
		const { admission, recorded } = admissionOver(redis, { mode: "shadow" });
		const request = { surface: "cursor" as const, klass: "write" as const, cost: 1 };
		await admission.admit(request);
		const second = await admission.admit(request);
		expect(second.decision).toBe("shadow_limited");
		expect(second.retryAfterS).toBe(1);
		expect(recorded.map((entry) => entry.decision)).toEqual(["allowed", "shadow_limited"]);
	});

	test("off runs no script and records nothing", async () => {
		const redis = new FakeBudgetRedis();
		const { admission, recorded } = admissionOver(redis, { mode: "off" });
		const verdict = await admission.admit({ surface: "cursor", klass: "read", cost: 1 });
		expect(verdict.decision).toBe("bypass");
		expect(redis.calls).toEqual([]);
		expect(recorded).toEqual([]);
	});

	test("a cache that fails, refuses, or answers nonsense is a recorded bypass, never a refusal", async () => {
		const recorded: AdmissionVerdict[] = [];
		const outcomes: Array<() => Promise<ScriptOutcome>> = [
			async () => ({ ok: false, reason: "cache off" }),
			async () => {
				throw new Error("breaker open");
			},
			async () => ({ ok: true, value: "PONG" }),
			async () => ({ ok: true, value: [1] }),
			async () => ({ ok: true, value: ["x", "y", "z"] }),
		];
		const admission = new Admission(settings(), {
			script: () => defined(outcomes.shift(), "outcome")(),
			now: () => 1,
			record: (verdict) => recorded.push(verdict),
		});
		for (let index = 0; index < 5; index += 1) {
			const verdict = await admission.admit({ surface: "omp", klass: "read", cost: 1 });
			expect(verdict).toMatchObject({ decision: "bypass", tokensLeft: null, retryAfterS: 0 });
		}
		expect(recorded.map((entry) => entry.decision)).toEqual(["bypass", "bypass", "bypass", "bypass", "bypass"]);
	});

	test("a reply of numeric strings is still read, as a real redis client may hand integers back", async () => {
		const redis = new FakeBudgetRedis();
		redis.reply = ["0", "0", "1500"];
		const { admission } = admissionOver(redis);
		const verdict = await admission.admit({ surface: "omp", klass: "read", cost: 1 });
		expect(verdict).toMatchObject({ decision: "limited", retryAfterMs: 1_500, retryAfterS: 2 });
	});

	test("a recorder that throws does not fail the decision", async () => {
		const admission = new Admission(settings(), {
			script: async () => ({ ok: true, value: [1, 1, 0] }),
			record: () => {
				throw new Error("sink broke");
			},
		});
		expect((await admission.admit({ surface: "omp", klass: "read", cost: 1 })).decision).toBe("allowed");
	});

	test("untokened callers share the anonymous bucket; a surface's bucket is its own", async () => {
		const redis = new FakeBudgetRedis();
		const { admission } = admissionOver(redis);
		expect((await admission.admit({ surface: null, klass: "read", cost: 1 })).decision).toBe("allowed");
		const second = await admission.admit({ surface: null, klass: "read", cost: 1 });
		expect(second).toMatchObject({ decision: "limited", surface: ANONYMOUS_IDENTITY });
		expect((await admission.admit({ surface: "grok-bot", klass: "read", cost: 1 })).decision).toBe("allowed");
		expect([...redis.buckets.keys()]).toEqual(["substrate:v1:budget:anonymous:read", "substrate:v1:budget:grok-bot:read"]);
	});

	test("coordination is its own bucket, so an exhausted read budget never refuses a heartbeat", async () => {
		const redis = new FakeBudgetRedis();
		const { admission } = admissionOver(redis);
		for (let index = 0; index < 3; index += 1) await admission.admit({ surface: "hermes", klass: "read", cost: 1 });
		expect((await admission.admit({ surface: "hermes", klass: "read", cost: 1 })).decision).toBe("limited");
		expect((await admission.admit({ surface: "hermes", klass: "coordination", cost: 1 })).decision).toBe("allowed");
	});

	test("a per-surface override replaces the class default for that surface only", () => {
		const configured = settings({ overrides: { "grok-bot": { read: { rps: 50, burst: 100 } } } });
		expect(limitFor(configured, "grok-bot", "read")).toEqual({ rps: 50, burst: 100 });
		expect(limitFor(configured, "grok-bot", "write")).toEqual({ rps: 1, burst: 1 });
		expect(limitFor(configured, "cursor", "read")).toEqual({ rps: 1, burst: 2 });
		expect(limitFor(configured, null, "read")).toEqual({ rps: 1, burst: 1 });
	});
});

describe("admitBatch", () => {
	test("costs one token per member of each class and admits when every class has room", async () => {
		const redis = new FakeBudgetRedis();
		const { admission } = admissionOver(redis, { classes: { read: { rps: 1, burst: 3 }, write: { rps: 1, burst: 2 }, coordination: { rps: 1, burst: 1 } } });
		const calls = [{ tool: "memory_brief" }, { tool: "events_emit" }, { tool: "graph_get" }, { tool: "graph_heartbeat" }, { tool: "memory_write" }];
		expect(await admitBatch(admission, "cursor", calls)).toBeNull();
		expect(redis.calls.map((call) => [call.keys[0], call.args[3]])).toEqual([
			["substrate:v1:budget:cursor:read", "2"],
			["substrate:v1:budget:cursor:write", "2"],
			["substrate:v1:budget:cursor:coordination", "1"],
		]);
	});

	test("a batch over one class's budget is refused by that class, reads first, with no coordination token spent", async () => {
		const redis = new FakeBudgetRedis();
		const { admission } = admissionOver(redis, { classes: { read: { rps: 1, burst: 1 }, write: { rps: 1, burst: 5 }, coordination: { rps: 1, burst: 5 } } });
		const refused = await admitBatch(admission, "cursor", [{ tool: "graph_heartbeat" }, { tool: "graph_get" }, { tool: "memory_search" }]);
		expect(refused).toMatchObject({ decision: "limited", klass: "read", cost: 2 });
		expect(redis.buckets.has("substrate:v1:budget:cursor:coordination")).toBe(false);
	});

	test("a request with no tool calls costs nothing", async () => {
		const redis = new FakeBudgetRedis();
		const { admission } = admissionOver(redis);
		expect(await admitBatch(admission, "cursor", [])).toBeNull();
		expect(redis.calls).toEqual([]);
	});

	test("in shadow a batch over budget is admitted", async () => {
		const redis = new FakeBudgetRedis();
		const { admission, recorded } = admissionOver(redis, { mode: "shadow", classes: { read: { rps: 1, burst: 1 }, write: { rps: 1, burst: 1 }, coordination: { rps: 1, burst: 1 } } });
		expect(await admitBatch(admission, "cursor", [{ tool: "graph_get" }, { tool: "graph_get" }])).toBeNull();
		expect(recorded.map((entry) => entry.decision)).toEqual(["shadow_limited"]);
	});
});

describe("the refusal bodies", () => {
	const verdict: AdmissionVerdict = { decision: "limited", surface: "cursor", klass: "write", cost: 3, tokensLeft: 0, retryAfterMs: 2_400, retryAfterS: 3 };

	test("the REST body carries the class and the wait and nothing else", () => {
		expect(budgetBody(verdict)).toEqual({ error: "budget", class: "write", retry_after_s: 3 });
	});

	test("the MCP body is one JSON-RPC error per member with the same data, and a single request is not wrapped", () => {
		const batch = budgetRefusal([{ id: 1 }, { id: "b" }, { method: "tools/call" }], verdict);
		expect(batch).toEqual([
			{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: expect.stringContaining("retry after 3 s"), data: { error: "budget", class: "write", retry_after_s: 3 } } },
			{ jsonrpc: "2.0", id: "b", error: expect.objectContaining({ data: { error: "budget", class: "write", retry_after_s: 3 } }) },
			{ jsonrpc: "2.0", id: null, error: expect.objectContaining({ code: -32000 }) },
		]);
		expect(budgetRefusal({ id: 4 }, verdict)).toMatchObject({ id: 4, error: { data: { class: "write" } } });
		expect(JSON.stringify(batch)).not.toContain("cursor");
	});
});

describe("the class tables are exhaustive over what the server serves", () => {
	const serverSource = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
	const mcpSource = readFileSync(join(import.meta.dir, "mcp.ts"), "utf8");
	const servedRoutes = new Set([...serverSource.matchAll(/url\.pathname === "([^"]+)"/g)].map((match) => defined(match[1])));
	const registeredTools = new Set([...mcpSource.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((match) => defined(match[1])));

	test("every route server.ts matches on is classified, exempt, or the MCP door — and nothing stale is listed", () => {
		expect(servedRoutes.size).toBeGreaterThan(10);
		const classified = new Set([...Object.keys(ROUTE_CLASSES), ...Object.keys(MONITOR_ROUTES), MCP_ROUTE]);
		expect([...servedRoutes].filter((route) => !classified.has(route))).toEqual([]);
		expect([...classified].filter((route) => !servedRoutes.has(route))).toEqual([]);
	});

	test("live lifecycle admission is method-aware and shares the mutation tool classes", () => {
		expect(routeClass("GET", "/steering/sessions")).toBe("read");
		expect(routeClass("POST", "/steering/sessions")).toBe("write");
		for (const [route, tool] of [
			["/steering/sessions", "docs_steering_session"],
			["/steering/sessions/heartbeat", "steering_session_heartbeat"],
			["/steering/sessions/close", "steering_session_close"],
			["/steering/queue", "steering_queue"],
			["/steering/acknowledge", "steering_acknowledge"],
		] as const) {
			expect(routeClass("POST", route)).toBe("write");
			expect(toolClass(tool)).toBe("write");
		}
		for (const route of ["/steering/directives", "/steering/wait", "/session/context"]) expect(routeClass("GET", route)).toBe("read");
		for (const tool of ["steering_list", "steering_wait", "live_session_discovery", "session_context"]) expect(toolClass(tool)).toBe("read");
	});

	test("every registered MCP tool has an explicit admission class", () => {
		expect(registeredTools.size).toBeGreaterThan(20);
		expect([...registeredTools].filter((tool) => !Object.hasOwn(TOOL_CLASSES, tool))).toEqual([]);
	});

	test("the coordination class is exactly the lease tools", () => {
		const coordination = Object.entries(TOOL_CLASSES).filter(([, klass]) => klass === "coordination").map(([tool]) => tool).sort();
		expect(coordination).toEqual(["coord_reap_leases", "graph_claim", "graph_complete", "graph_heartbeat", "graph_release"]);
	});

	test("the skills registry doors: approve is a write, list a read, on both the tool and the route", () => {
		expect({ approve: toolClass("skills_approve"), list: toolClass("skills_list") }).toEqual({ approve: "write", list: "read" });
		expect({ approve: routeClass("POST", "/skills/approve"), list: routeClass("GET", "/skills") }).toEqual({ approve: "write", list: "read" });
	});

	test("the worktree claims read is a read on the route, and the tool it is audited under is a read too", () => {
		expect({ route: routeClass("GET", "/worktrees/claims"), tool: toolClass("graph_get") }).toEqual({ route: "read", tool: "read" });
	});

	test("the anchor verification tools are reads: they read the ledger and devnet and write nothing", () => {
		expect({ checkpoint: toolClass("checkpoint_verify"), memory: toolClass("memory_verify") }).toEqual({ checkpoint: "read", memory: "read" });
	});

	test("the session rollback tools: the plan is a read, the checkpoint and the commit are writes", () => {
		expect({ plan: toolClass("session_rollback_plan"), checkpoint: toolClass("session_checkpoint"), commit: toolClass("session_rollback_commit") }).toEqual({
			plan: "read",
			checkpoint: "write",
			commit: "write",
		});
	});

	test("an unknown route or tool is a read; monitor GETs and /mcp are not metered here; a POST to a monitor path is", () => {
		expect(DEFAULT_CLASS).toBe("read");
		expect(routeClass("POST", "/not-a-route")).toBe("read");
		expect(toolClass("not_a_tool")).toBe("read");
		expect(routeClass("GET", "/healthz")).toBeNull();
		expect(routeClass("GET", "/metrics")).toBeNull();
		expect(routeClass("GET", "/slo")).toBeNull();
		expect(routeClass("POST", "/healthz")).toBe("read");
		expect(routeClass("POST", "/mcp")).toBeNull();
		expect(routeClass("GET", "/events/stream")).toBe("read");
		expect(routeClass("POST", "/events")).toBe("write");
		expect(routeClass("POST", "/handoff")).toBe("write");
		// Prototype names are not routes or tools.
		expect(routeClass("POST", "constructor")).toBe("read");
		expect(toolClass("__proto__")).toBe("read");
	});

	test("the label sets the metric is bounded by are the ones the decision uses", () => {
		expect([...ADMISSION_CLASSES]).toEqual(["read", "write", "coordination"]);
		expect([...ADMISSION_DECISIONS]).toEqual(["allowed", "limited", "shadow_limited", "bypass"]);
		const classes = new Set<AdmissionClass>([...Object.values(ROUTE_CLASSES), ...Object.values(TOOL_CLASSES)]);
		expect([...classes].sort()).toEqual([...ADMISSION_CLASSES].sort());
	});
});

describe("loadAdmissionSettings", () => {
	test("shadow by default with the documented limits, and the surfaces have no overrides", () => {
		const parsed = loadAdmissionSettings({});
		expect(parsed.mode).toBe("shadow");
		expect(parsed.classes).toEqual({ read: { rps: 20, burst: 40 }, write: { rps: 10, burst: 20 }, coordination: { rps: 30, burst: 60 } });
		expect(parsed.anonymous).toEqual({ rps: 2, burst: 4 });
		expect(parsed.overrides).toEqual({});
		expect(DEFAULT_BUDGETS.read).toEqual({ rps: 20, burst: 40 });
	});

	test("the mode is one of the three, case-insensitively; anything else is shadow", () => {
		expect([...ADMISSION_MODES]).toEqual(["off", "shadow", "enforce"]);
		expect(loadAdmissionSettings({ SUBSTRATE_BUDGETS: "ENFORCE " }).mode).toBe("enforce");
		expect(loadAdmissionSettings({ SUBSTRATE_BUDGETS: "off" }).mode).toBe("off");
		expect(loadAdmissionSettings({ SUBSTRATE_BUDGETS: "on" }).mode).toBe("shadow");
	});

	test("class limits parse, a fractional rate is kept, and junk keeps the default", () => {
		const parsed = loadAdmissionSettings({
			SUBSTRATE_BUDGET_READ_RPS: "0.5",
			SUBSTRATE_BUDGET_READ_BURST: "3.9",
			SUBSTRATE_BUDGET_WRITE_RPS: "nope",
			SUBSTRATE_BUDGET_WRITE_BURST: "0",
			SUBSTRATE_BUDGET_COORDINATION_RPS: "-1",
			SUBSTRATE_BUDGET_ANONYMOUS_RPS: "1",
			SUBSTRATE_BUDGET_ANONYMOUS_BURST: "1",
		});
		expect(parsed.classes.read).toEqual({ rps: 0.5, burst: 3 });
		expect(parsed.classes.write).toEqual({ rps: 10, burst: 20 });
		expect(parsed.classes.coordination).toEqual({ rps: 30, burst: 60 });
		expect(parsed.anonymous).toEqual({ rps: 1, burst: 1 });
	});

	test("a per-surface override fills the half it leaves out from the class limit", () => {
		const parsed = loadAdmissionSettings({
			SUBSTRATE_BUDGET_READ_BURST: "50",
			SUBSTRATE_BUDGET_GROK_BOT_READ_RPS: "5",
			SUBSTRATE_BUDGET_SWARM_A01_ORCH_COORDINATION_BURST: "120",
			SUBSTRATE_BUDGET_CURSOR_WRITE_RPS: " ",
		});
		expect(parsed.overrides).toEqual({
			"grok-bot": { read: { rps: 5, burst: 50 } },
			"swarm-a01-orch": { coordination: { rps: 30, burst: 120 } },
		});
		expect(limitFor(parsed, "grok-bot", "read")).toEqual({ rps: 5, burst: 50 });
		expect(limitFor(parsed, "cursor", "write")).toEqual({ rps: 10, burst: 20 });
	});

	test("every surface has a spelling an override can use", () => {
		for (const surface of SURFACES) {
			const spelled = surface.toUpperCase().replace(/-/g, "_");
			expect(spelled).toMatch(/^[A-Z0-9_]+$/);
			const parsed = loadAdmissionSettings({ [`SUBSTRATE_BUDGET_${spelled}_WRITE_BURST`]: "7" });
			expect(parsed.overrides[surface]?.write).toEqual({ rps: 10, burst: 7 });
		}
	});
});

describe("mandatory live principal budgets", () => {
	const caller = { surface: "cursor", isOperator: false } as const;
	for (const mode of ["off", "shadow", "enforce"] as const) test(`random targets cannot evade the principal bucket in ${mode}`, async () => {
		const authority = createTestLiveSessionAuthority();
		const read = spyOn(authority, "read");
		const refused: EventInput[] = [];
		let inferred = 0;
		const boundary = new LiveSessionBoundary({
			authority, settings: settings({ mode, classes: { read: { rps: 0.01, burst: 1 }, write: { rps: 0.01, burst: 1 }, coordination: { rps: 1, burst: 1 } } }),
			nowMs: () => 1_000,
			resolveDirective: () => { inferred++; return null; },
			recordRefusal: async (event) => { refused.push(event); throw new Error("injected refusal sink outage"); },
		});
		const firstId = `ls_${"1".padStart(64, "0")}`;
		expect(await boundary.prepare({ caller, tool: "steering_list", args: {}, operation: "private-read", sessionId: firstId })).toEqual({ status: "refused", error: { code: "not-found" } });
		expect(read).toHaveBeenCalledTimes(1);
		expect(refused).toHaveLength(1);
		expect(refused[0]).toMatchObject({ payload: { action: "steering.refused", target_sha256: createHash("sha256").update(`substrate.live-session-refusal.v1\0${firstId}`).digest("hex") } });
		expect(JSON.stringify(refused)).not.toContain(firstId);
		for (let index = 2; index <= 200; index++) {
			const result = await boundary.prepare({ caller, tool: "steering_list", args: { session_binding: "b".repeat(64) }, operation: "private-read", sessionId: `ls_${index.toString(16).padStart(64, "0")}` });
			expect(result).toMatchObject({ status: "refused", error: { code: "principal-rate-limited" } });
		}
		expect(read).toHaveBeenCalledTimes(1);
		expect(refused).toHaveLength(1);
		const ack: LiveSessionInvocation = { caller, tool: "steering_acknowledge", args: {}, operation: "operator-ack", directiveId: "first-directive" };
		expect(await boundary.prepare(ack)).toEqual({ status: "refused", error: { code: "not-found" } });
		expect(inferred).toBe(1);
		expect(await boundary.prepare({ ...ack, directiveId: "second-directive" })).toMatchObject({ status: "refused", error: { code: "principal-rate-limited" } });
		expect(inferred).toBe(1);
		expect(refused).toHaveLength(2);
		// Inspect cardinality without adding a production test-only grant or reset method.
		const buckets: unknown = Reflect.get(boundary, "buckets");
		expect(buckets).toBeInstanceOf(Map);
		if (!(buckets instanceof Map)) throw new Error("expected bounded principal map");
		expect([...buckets.keys()].sort()).toEqual(["cursor:read", "cursor:write"]);
	});

	test("batch reservation refuses before lookup and release rechecks spend no second token", async () => {
		const authority = createTestLiveSessionAuthority();
		const entry = await issueLiveSession(authority, { caller });
		const read = spyOn(authority, "read");
		const refused: EventInput[] = [];
		const boundary = new LiveSessionBoundary({
			authority, settings: settings({ classes: { read: { rps: 0.01, burst: 1 }, write: { rps: 1, burst: 1 }, coordination: { rps: 1, burst: 1 } } }),
			nowMs: () => 1_000,
			resolveDirective: () => null,
			recordRefusal: async (event) => { refused.push(event); return true; },
		});
		const invocation: LiveSessionInvocation = { caller, tool: "steering_list", args: {}, operation: "private-read", sessionId: entry.sessionId, sessionBinding: entry.sessionBinding };
		expect(await boundary.prepareBatch([invocation, invocation])).toMatchObject({ status: "refused", error: { code: "principal-rate-limited" } });
		expect(read).not.toHaveBeenCalled();
		expect(refused).toEqual([]);
		const prepared = await boundary.prepare(invocation);
		if ("status" in prepared) throw new Error("one allowed token must remain after the refused batch");
		await boundary.recheck(prepared);
		await boundary.recheck(prepared);
		expect(read).toHaveBeenCalledTimes(3);
		expect(await boundary.prepare(invocation)).toMatchObject({ status: "refused", error: { code: "principal-rate-limited" } });
		expect(read).toHaveBeenCalledTimes(3);
	});
});
