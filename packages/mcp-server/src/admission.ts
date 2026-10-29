/**
 * Per-surface admission budgets (uplift-3 N3, Build Plan C8).
 *
 * One token bucket per authenticated surface × class, kept in the cache plane
 * under `substrate:v1:budget:<surface>:<class>` and stepped by one atomic Lua
 * `EVAL` (refill, check, debit, `PEXPIRE`). The classes are `read`, `write`
 * and `coordination`, and the third exists for one reason: a heartbeat or a
 * release must never queue behind a storm of briefs, because a lease that
 * lapses while its holder is throttled is a lease the holder loses.
 *
 * What this module decides and what it does not:
 *
 *   - **Identity is the bearer's surface.** A body-claimed `surface` is never the
 *     bucket: a caller could otherwise spend another surface's budget by naming
 *     it. Accepted untokened callers on the bridge share one `anonymous` bucket.
 *   - **The cache failing is not a refusal.** Cache off, breaker open, cooldown,
 *     timeout, a malformed reply — every one admits the request and counts a
 *     `bypass`. Admission control bounds load on the planes; it must not become a
 *     way for the cache plane to fail every other plane's callers.
 *   - **Shadow first.** `shadow` evaluates and records `shadow_limited` and never
 *     refuses, so the budgets are tuned from the metric before `enforce` turns a
 *     wrong number into a 429. `off` skips the eval entirely.
 *   - **Time comes from the process.** `now_ms` is an argument, not
 *     `redis.call('TIME')`, so the bucket is deterministic under a fake clock and
 *     the TS reference below and the Lua text decide the same way.
 *
 * `bucketStep` is the reference the Lua mirrors line for line; `admission.test.ts`
 * drives both through a fake `EVAL`, and the orchestrator's smoke runs the Lua
 * against a real redis. Keep them in step.
 */
import { ADMISSION_CLASSES, type AdmissionClass, type AdmissionDecision } from "@substrate/observability";
import { CACHE_PREFIX, type ScriptOutcome } from "./cache.ts";
import type { Surface } from "./types.ts";

export type AdmissionMode = "off" | "shadow" | "enforce";
export const ADMISSION_MODES: readonly AdmissionMode[] = ["off", "shadow", "enforce"];

/** Tokens per second and the most a bucket holds. `rps` > 0, `burst` ≥ 1. */
export interface BucketLimit {
	rps: number;
	burst: number;
}

/** From `SUBSTRATE_BUDGETS` and `SUBSTRATE_BUDGET_*`; parsed in `config.ts`. */
export interface AdmissionSettings {
	mode: AdmissionMode;
	/** The default limit per class, for every surface without an override. */
	classes: Record<AdmissionClass, BucketLimit>;
	/** Every class of the shared `anonymous` bucket. */
	anonymous: BucketLimit;
	/** `SUBSTRATE_BUDGET_<SURFACE>_<CLASS>_RPS|_BURST`, by surface then class. */
	overrides: Partial<Record<Surface, Partial<Record<AdmissionClass, BucketLimit>>>>;
}

/** The bucket identity of an untokened caller the bridge accepted. */
export const ANONYMOUS_IDENTITY = "anonymous";

export function budgetKey(identity: string, klass: AdmissionClass): string {
	return `${CACHE_PREFIX}:budget:${identity}:${klass}`;
}

/**
 * The atomic bucket step. `KEYS[1]` is the bucket; `ARGV` is `rps`, `burst`,
 * `now_ms`, `cost`. Replies `{allowed, tokens_left, retry_after_ms}` as
 * integers: `tokens_left` floored, `retry_after_ms` the wait until `cost` tokens
 * have refilled (0 when allowed). The TTL is the time an empty bucket takes to
 * refill to `burst`, never under one second, so a counter never outlives the
 * state it carries and an idle surface costs no key.
 *
 * A `cost` above `burst` is never admitted: the bucket cannot hold that many
 * tokens at once. The reply's wait is the time to refill `cost` anyway, so a
 * caller that retries learns the same answer; split the batch instead.
 */
export const BUDGET_SCRIPT = `local rps = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local state = redis.call('HMGET', KEYS[1], 't', 'at')
local tokens = tonumber(state[1])
local at = tonumber(state[2])
if tokens == nil or at == nil then
  tokens = burst
  at = now
end
local elapsed = now - at
if elapsed < 0 then elapsed = 0 end
tokens = math.min(burst, tokens + elapsed * rps / 1000)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) * 1000 / rps)
end
local ttl = math.max(1000, math.ceil(burst * 1000 / rps))
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttl)
return {allowed, math.floor(tokens), retry}`;

/** What the script keeps per bucket: the token count and when it was last stepped (epoch ms). */
export interface BucketState {
	tokens: number;
	at: number;
}

export interface BucketStep {
	allowed: boolean;
	/** Floored, as the script replies it. */
	tokensLeft: number;
	/** 0 when allowed; otherwise the wait until `cost` tokens have refilled. */
	retryAfterMs: number;
	ttlMs: number;
	/** The state the script writes back, refilled and (when allowed) debited. */
	state: BucketState;
}

/** The key's TTL: the refill time of a full burst, never under one second. */
export function bucketTtlMs(limit: BucketLimit): number {
	return Math.max(1000, Math.ceil((limit.burst * 1000) / limit.rps));
}

/**
 * The reference the Lua mirrors. A null `state` is a bucket that does not exist
 * yet, which starts full. Refill is `elapsed ms × rps / 1000`, capped at the
 * burst; a clock that went backwards refills nothing rather than debiting.
 */
export function bucketStep(state: BucketState | null, limit: BucketLimit, nowMs: number, cost: number): BucketStep {
	let tokens = state === null ? limit.burst : Math.min(limit.burst, state.tokens + (Math.max(0, nowMs - state.at) * limit.rps) / 1000);
	let allowed = false;
	let retryAfterMs = 0;
	if (tokens >= cost) {
		tokens -= cost;
		allowed = true;
	} else {
		retryAfterMs = Math.ceil(((cost - tokens) * 1000) / limit.rps);
	}
	return {
		allowed,
		tokensLeft: Math.floor(tokens),
		retryAfterMs,
		ttlMs: bucketTtlMs(limit),
		state: { tokens, at: nowMs },
	};
}

/** `Retry-After` in whole seconds: the ceiling, and never 0 for a refusal. */
export function retryAfterSeconds(retryAfterMs: number): number {
	return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

// ── class mapping ────────────────────────────────────────────────────────────

/**
 * Every REST route `server.ts` serves, by pathname. The monitor GETs are exempt
 * and `/mcp` is metered per tool call in `handleMcp`, so neither has a class
 * here; `admission.test.ts` reads `server.ts` and fails when a route is served
 * that none of the three tables names, so a new route is classified on purpose
 * rather than falling into `read` by accident.
 */
export const ROUTE_CLASSES: Readonly<Record<string, AdmissionClass>> = {
	"/brief": "read",
	"/evidence": "read",
	"/events/query": "read",
	"/events/stream": "read",
	"/memory/recall": "read",
	"/verify": "read",
	"/drift": "read",
	"/docs/search": "read",
	"/.well-known/agent-card.json": "read",
	"/events": "write",
	"/memory": "write",
	"/docs/ingest": "write",
	"/docs/merge-trigger": "write",
	"/skills/propose": "write",
	"/skills": "read",
	"/skills/approve": "write",
	"/handoff": "write",
	"/slo/history": "read",
	"/docs/lightrag/query": "read",
	"/corpus/plan": "read",
	"/corpus/status": "read",
	"/corpus/ingest": "write",
	"/corpus/reconcile": "write",
};

/** Monitoring traffic. Exempt on GET only: a POST to one of these is a 404, and a 404 is metered like any other unknown path. */
export const MONITOR_ROUTES: Readonly<Record<string, true>> = { "/healthz": true, "/metrics": true, "/slo": true, "/livez": true, "/rag/state": true };

/** Metered in `handleMcp`: the cost is the number of `tools/call` members, by each member's class. */
export const MCP_ROUTE = "/mcp";

/**
 * Every tool `mcp.ts` registers. `admission.test.ts` reads `mcp.ts` and fails on
 * a registered name this table lacks, for the same reason as the routes.
 */
export const TOOL_CLASSES: Readonly<Record<string, AdmissionClass>> = {
	memory_brief: "read",
	memory_search: "read",
	memory_recall: "read",
	memory_pending: "read",
	memory_verify: "read",
	checkpoint_verify: "read",
	session_rollback_plan: "read",
	events_query: "read",
	events_verify: "read",
	graph_get: "read",
	graph_find: "read",
	issue_get: "read",
	coord_handoff_verify: "read",
	coord_handoff_list: "read",
	coord_drift_scan: "read",
	docs_search: "read",
	docs_lightrag_query: "read",
	docs_rag_state: "read",
	memory_write: "write",
	events_emit: "write",
	session_checkpoint: "write",
	session_rollback_commit: "write",
	docs_ingest: "write",
	corpus_status: "read",
	corpus_ingest: "write",
	skills_propose: "write",
	docs_steering_session: "write",
	skills_approve: "write",
	skills_list: "read",
	railway_list: "read",
	railway_monitor: "read",
	railway_scale_suggest: "read",
	railway_cost: "read",
	fabric_status: "read",
	fabric_optimize: "read",
	fabric_compliance: "read",
	planning_status: "read",
	planning_sessions: "read",
	steering_queue: "write",
	steering_acknowledge: "write",
	steering_list: "read",
	railway_scale: "write",
	railway_deploy: "write",
	coord_handoff: "write",
	desktop_run: "write",
	graph_register: "write",
	graph_bind: "write",
	graph_claim: "coordination",
	graph_heartbeat: "coordination",
	graph_release: "coordination",
	graph_complete: "coordination",
	coord_reap_leases: "coordination",
};

/** A name neither table knows. The cheapest class, so an unclassified addition is throttled like a read, never like a heartbeat. */
export const DEFAULT_CLASS: AdmissionClass = "read";

/**
 * The class of one REST request, or null when it is not metered here: a monitor
 * GET, or `/mcp`, whose members are metered one by one.
 */
export function routeClass(method: string, pathname: string): AdmissionClass | null {
	if (method === "GET" && Object.hasOwn(MONITOR_ROUTES, pathname)) return null;
	if (pathname === MCP_ROUTE) return null;
	return (Object.hasOwn(ROUTE_CLASSES, pathname) ? ROUTE_CLASSES[pathname] : undefined) ?? DEFAULT_CLASS;
}

export function toolClass(tool: string): AdmissionClass {
	return (Object.hasOwn(TOOL_CLASSES, tool) ? TOOL_CLASSES[tool] : undefined) ?? DEFAULT_CLASS;
}

// ── the decision ─────────────────────────────────────────────────────────────

/** Runs `BUDGET_SCRIPT` atomically on the cache plane. Production is `ReadThroughCache.script`. */
export type ScriptRunner = (script: string, keys: readonly string[], args: readonly string[]) => Promise<ScriptOutcome>;

export interface AdmissionRequest {
	/** The bearer's surface; null is an accepted untokened caller. */
	surface: Surface | null;
	klass: AdmissionClass;
	/** Tokens to debit: 1 per REST request, one per `tools/call` member of an MCP batch. */
	cost: number;
}

export interface AdmissionVerdict {
	decision: AdmissionDecision;
	/** The bucket identity: the surface, or `anonymous`. Bounded, so it is a metric label. */
	surface: string;
	klass: AdmissionClass;
	cost: number;
	/** What the bucket held after this step; null on a bypass. */
	tokensLeft: number | null;
	retryAfterMs: number;
	/** `Retry-After`: ≥ 1 whenever the bucket refused, 0 otherwise. */
	retryAfterS: number;
}

export interface AdmissionOptions {
	script: ScriptRunner;
	now?: () => number;
	/** Every decision the bucket or its absence produced. `off` records nothing. */
	record?: (verdict: AdmissionVerdict) => void;
}

/** The limit one identity has for one class: the surface override, else the class default; `anonymous` has its own. */
export function limitFor(settings: AdmissionSettings, surface: Surface | null, klass: AdmissionClass): BucketLimit {
	if (surface === null) return settings.anonymous;
	return settings.overrides[surface]?.[klass] ?? settings.classes[klass];
}

export class Admission {
	private readonly script: ScriptRunner;
	private readonly now: () => number;
	private readonly record: ((verdict: AdmissionVerdict) => void) | undefined;

	constructor(
		readonly settings: AdmissionSettings,
		options: AdmissionOptions,
	) {
		this.script = options.script;
		this.now = options.now ?? Date.now;
		this.record = options.record;
	}

	/**
	 * Decide one request. Never throws: the cache failing in any way is a
	 * recorded `bypass`, because a budget that refused when its store was down
	 * would turn a cache outage into an outage of every route.
	 */
	async admit(request: AdmissionRequest): Promise<AdmissionVerdict> {
		const identity = request.surface ?? ANONYMOUS_IDENTITY;
		const limit = limitFor(this.settings, request.surface, request.klass);
		const base = { surface: identity, klass: request.klass, cost: request.cost };
		if (this.settings.mode === "off") {
			// Today's behaviour, exactly: no eval, no sample.
			return { ...base, decision: "bypass", tokensLeft: null, retryAfterMs: 0, retryAfterS: 0 };
		}
		let outcome: ScriptOutcome;
		try {
			outcome = await this.script(
				BUDGET_SCRIPT,
				[budgetKey(identity, request.klass)],
				[String(limit.rps), String(limit.burst), String(Math.floor(this.now())), String(request.cost)],
			);
		} catch (cause) {
			outcome = { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
		}
		const reply = outcome.ok ? parseReply(outcome.value) : null;
		let verdict: AdmissionVerdict;
		if (reply === null) {
			verdict = { ...base, decision: "bypass", tokensLeft: null, retryAfterMs: 0, retryAfterS: 0 };
		} else if (reply.allowed) {
			verdict = { ...base, decision: "allowed", tokensLeft: reply.tokensLeft, retryAfterMs: 0, retryAfterS: 0 };
		} else {
			verdict = {
				...base,
				decision: this.settings.mode === "enforce" ? "limited" : "shadow_limited",
				tokensLeft: reply.tokensLeft,
				retryAfterMs: reply.retryAfterMs,
				retryAfterS: retryAfterSeconds(reply.retryAfterMs),
			};
		}
		try {
			this.record?.(verdict);
		} catch {
			// A metric sink must not fail the request it is counting.
		}
		return verdict;
	}
}

/** The script's `{allowed, tokens_left, retry_after_ms}`, or null for anything else — a bypass, never a guess. */
function parseReply(value: unknown): { allowed: boolean; tokensLeft: number; retryAfterMs: number } | null {
	if (!Array.isArray(value) || value.length < 3) return null;
	const [allowed, tokensLeft, retryAfterMs] = value.map((item) => (typeof item === "number" ? item : Number(item)));
	if (allowed === undefined || tokensLeft === undefined || retryAfterMs === undefined) return null;
	if (![allowed, tokensLeft, retryAfterMs].every((item) => Number.isFinite(item))) return null;
	return { allowed: allowed === 1, tokensLeft, retryAfterMs: Math.max(0, retryAfterMs) };
}

/**
 * Admit an MCP batch: each `tools/call` member costs one token of its class, and
 * the classes are stepped in `ADMISSION_CLASSES` order — reads first, so the
 * class most likely to be exhausted refuses before a coordination token is
 * spent on a batch that will not run. The first refusal is the batch's answer;
 * a class already debited for a refused batch stays debited (MCP clients send
 * one call per request in practice, so nothing real pays for the simplicity).
 * Null means every member is admitted; a batch with no tool calls costs nothing.
 */
export async function admitBatch(
	admission: Admission,
	surface: Surface | null,
	calls: ReadonlyArray<{ tool: string }>,
): Promise<AdmissionVerdict | null> {
	const costs = new Map<AdmissionClass, number>();
	for (const call of calls) {
		const klass = toolClass(call.tool);
		costs.set(klass, (costs.get(klass) ?? 0) + 1);
	}
	for (const klass of ADMISSION_CLASSES) {
		const cost = costs.get(klass);
		if (cost === undefined) continue;
		const verdict = await admission.admit({ surface, klass, cost });
		if (verdict.decision === "limited") return verdict;
	}
	return null;
}

/** The bounded 429 body: no identity, no limit, no payload — the class and the wait. */
export function budgetBody(verdict: AdmissionVerdict): { error: "budget"; class: AdmissionClass; retry_after_s: number } {
	return { error: "budget", class: verdict.klass, retry_after_s: verdict.retryAfterS };
}

/**
 * The JSON-RPC error for a refused MCP request, one per member so a batch is
 * refused whole, the way `auditRefusal` shapes an audit denial. `data` is the
 * same bounded body the REST routes answer with.
 */
export function budgetRefusal(body: unknown, verdict: AdmissionVerdict): unknown {
	const elements = Array.isArray(body) ? body : [body];
	const responses = elements.map((element) => {
		const id = element && typeof element === "object" && "id" in element ? (element.id ?? null) : null;
		return {
			jsonrpc: "2.0" as const,
			id,
			error: {
				code: -32000,
				message: `budget: the ${verdict.klass} budget of this surface is spent; retry after ${verdict.retryAfterS} s`,
				data: budgetBody(verdict),
			},
		};
	});
	return Array.isArray(body) ? responses : responses[0];
}
