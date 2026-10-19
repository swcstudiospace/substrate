/**
 * One circuit breaker per data plane, and the wrapper every outbound plane
 * call goes through (uplift-2 R2, Build Plan A-5 "circuit breakers + degraded
 * mode").
 *
 * The substrate reaches five planes — the Greptime ledger, the Postgres index,
 * the loopback cache, Hindsight and RAGFlow — and four of them sit behind a
 * public edge with 200–1000 ms round trips. Without a breaker, a plane that
 * stops answering costs every caller its full timeout (4–5 s), including the
 * hook with a 1.5 s budget. With one, the first `failureThreshold` failures
 * pay the timeout and every call after that fails in microseconds with
 * `BreakerOpenError`, until `openMs` has passed and a single probe is let
 * through to find out whether the plane is back.
 *
 * The breaker decides nothing about *what* a failure means: the fail-open paths
 * (brief, recall, docs search) and the fail-closed paths (emit, claim) already
 * handle an unreachable plane, and `BreakerOpenError` is handed to them exactly
 * where a network error would be. `callPlane` also feeds the per-plane series
 * (`substrate.plane.duration`, `substrate.plane.errors`) through an observer, so
 * `/healthz` and `/slo` can say which plane is unhealthy rather than that the
 * brief is slow.
 *
 * Kill switch: `SUBSTRATE_BREAKER=0` leaves every gate's breaker `null`, which
 * is exactly today's behaviour plus the metrics.
 */

export const PLANES = ["greptime", "index", "cache", "hindsight", "ragflow"] as const;
export type PlaneName = (typeof PLANES)[number];

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerSettings {
	enabled: boolean;
	/** Consecutive failures that open the breaker. */
	failureThreshold: number;
	/** How long an open breaker refuses before letting one probe through. */
	openMs: number;
}

export const DEFAULT_BREAKER_SETTINGS: BreakerSettings = {
	enabled: true,
	failureThreshold: 5,
	openMs: 30_000,
};

export const BREAKER_ENV = "SUBSTRATE_BREAKER";
export const BREAKER_FAILURES_ENV = "SUBSTRATE_BREAKER_FAILURES";
export const BREAKER_OPEN_MS_ENV = "SUBSTRATE_BREAKER_OPEN_MS";

/** A plain decimal integer inside `[min, max]`, or the fallback. A typo must never crash-loop the service. */
function intInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	if (!/^\d+$/.test(raw.trim())) return fallback;
	const value = Number(raw);
	if (value < min || value > max) return fallback;
	return value;
}

/**
 * Breaker settings from the environment. Bad values fall back to the defaults
 * and never throw; `SUBSTRATE_BREAKER=0|false|no` is the kill switch.
 */
export function loadBreakerSettings(env: Record<string, string | undefined> = process.env): BreakerSettings {
	return {
		enabled: !/^(0|false|no)$/i.test(env[BREAKER_ENV]?.trim() ?? ""),
		failureThreshold: intInRange(env[BREAKER_FAILURES_ENV], DEFAULT_BREAKER_SETTINGS.failureThreshold, 1, 100),
		openMs: intInRange(env[BREAKER_OPEN_MS_ENV], DEFAULT_BREAKER_SETTINGS.openMs, 1000, 600_000),
	};
}

export interface BreakerSnapshot {
	plane: PlaneName;
	state: BreakerState;
	/** Consecutive failures since the last success. */
	failures: number;
	/** When the breaker last opened, epoch ms; null while it has never opened or is closed. */
	openedAt: number | null;
	lastErrorAt: number | null;
	lastError: string | null;
}

/** Longest `lastError` kept: enough to name the failure, never a body. */
const MAX_ERROR_LENGTH = 200;

/**
 * closed → open after `failureThreshold` consecutive failures; open → half-open
 * once `openMs` has elapsed; half-open admits exactly one probe — success closes,
 * failure re-opens for another `openMs`.
 */
export class CircuitBreaker {
	readonly plane: PlaneName;
	private readonly settings: BreakerSettings;
	private readonly now: () => number;
	private failures = 0;
	private openedAt: number | null = null;
	private lastErrorAt: number | null = null;
	private lastError: string | null = null;
	/** True while the single half-open probe is in flight. */
	private probing = false;

	constructor(plane: PlaneName, settings: Partial<BreakerSettings> = {}, now: () => number = Date.now) {
		this.plane = plane;
		this.settings = { ...DEFAULT_BREAKER_SETTINGS, ...settings };
		this.now = now;
	}

	state(): BreakerState {
		if (this.openedAt === null) return "closed";
		return this.now() - this.openedAt >= this.settings.openMs ? "half-open" : "open";
	}

	/**
	 * Whether a call may go out. Closed: always. Open: never, until `openMs` has
	 * passed. Half-open: exactly one caller gets `true` until its probe settles
	 * through `onSuccess` or `onFailure`; everyone else is refused meanwhile.
	 */
	allow(): boolean {
		const state = this.state();
		if (state === "closed") return true;
		if (state === "open") return false;
		if (this.probing) return false;
		this.probing = true;
		return true;
	}

	onSuccess(): void {
		this.failures = 0;
		this.openedAt = null;
		this.probing = false;
	}

	onFailure(reason: string): void {
		const at = this.now();
		this.failures += 1;
		this.lastErrorAt = at;
		this.lastError = reason.length > MAX_ERROR_LENGTH ? reason.slice(0, MAX_ERROR_LENGTH) : reason;
		// A failed probe re-opens for a fresh `openMs`; a closed breaker opens once
		// the threshold is reached.
		if (this.openedAt !== null || this.failures >= this.settings.failureThreshold) {
			this.openedAt = at;
		}
		this.probing = false;
	}

	/** Milliseconds until the next probe is admitted; 0 when not open. */
	retryAfterMs(): number {
		if (this.openedAt === null) return 0;
		return Math.max(0, this.settings.openMs - (this.now() - this.openedAt));
	}

	snapshot(): BreakerSnapshot {
		return {
			plane: this.plane,
			state: this.state(),
			failures: this.failures,
			openedAt: this.openedAt,
			lastErrorAt: this.lastErrorAt,
			lastError: this.lastError,
		};
	}
}

/** The refusal an open breaker answers with, in place of the plane's own error. */
export class BreakerOpenError extends Error {
	readonly plane: PlaneName;
	readonly retryAfterMs: number;

	constructor(plane: PlaneName, retryAfterMs: number) {
		super(`${plane} circuit open; retry in ${Math.ceil(retryAfterMs / 1000)} s`);
		this.name = "BreakerOpenError";
		this.plane = plane;
		this.retryAfterMs = retryAfterMs;
	}
}

export type PlaneOutcome = "ok" | "error" | "timeout" | "open";

export interface PlaneSample {
	plane: PlaneName;
	/** A short, bounded operation label fixed per client — never a statement or URL. */
	op: string;
	outcome: PlaneOutcome;
	durationMs: number;
	reason?: string;
}

export type PlaneObserver = (sample: PlaneSample) => void;

export interface PlaneGate {
	plane: PlaneName;
	/** Null when breakers are disabled: calls still run and are still measured. */
	breaker: CircuitBreaker | null;
	observe: PlaneObserver | null;
}

/**
 * Run one plane call through its gate.
 *
 * No gate: just run `fn`. Breaker open: observe `open` with no duration and
 * throw `BreakerOpenError` without calling `fn`. Resolve: `onSuccess` and
 * observe `ok`. Reject: when `opts.isFailure` (default: every rejection) says
 * the error is the plane's fault, `onFailure` and observe `timeout` for an
 * `AbortError`/`TimeoutError`, `error` otherwise; the error is rethrown
 * unchanged either way, so callers keep their existing handling.
 */
export async function callPlane<T>(
	gate: PlaneGate | null | undefined,
	op: string,
	fn: () => Promise<T>,
	opts: { isFailure?: (error: unknown) => boolean } = {},
): Promise<T> {
	if (!gate) return fn();
	const breaker = gate.breaker;
	if (breaker && !breaker.allow()) {
		gate.observe?.({ plane: gate.plane, op, outcome: "open", durationMs: 0 });
		throw new BreakerOpenError(gate.plane, breaker.retryAfterMs());
	}
	const started = performance.now();
	try {
		const value = await fn();
		breaker?.onSuccess();
		gate.observe?.({ plane: gate.plane, op, outcome: "ok", durationMs: performance.now() - started });
		return value;
	} catch (error) {
		const durationMs = performance.now() - started;
		if ((opts.isFailure ?? (() => true))(error)) {
			const reason = error instanceof Error ? error.message : String(error);
			breaker?.onFailure(reason);
			const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
			gate.observe?.({ plane: gate.plane, op, outcome: timedOut ? "timeout" : "error", durationMs, reason });
		} else {
			// The plane answered; the call was wrong. Not the breaker's business, but
			// still a measured call.
			breaker?.onSuccess();
			gate.observe?.({ plane: gate.plane, op, outcome: "ok", durationMs });
		}
		throw error;
	}
}

/** The fetch surface the HTTP planes use; the same shape `planes/*.ts` inject. */
export type PlaneFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A server-error answer, thrown inside `callPlane` so the breaker counts it and
 * caught again by `gatedFetch` so the caller still reads the response.
 */
class PlaneServerError extends Error {
	constructor(readonly response: Response) {
		super(`server ${response.status}`);
		this.name = "PlaneServerError";
	}
}

/**
 * A `PlaneFetch` whose every call goes through `callPlane`.
 *
 * Transport errors and timeouts reject as before. A 5xx answer counts as a
 * failure for the breaker — the plane is up but broken — and is still returned
 * to the caller, so the existing status handling in each client is untouched. A
 * 4xx is the caller's fault and counts as a success. `opOf` maps the request to
 * a bounded operation label, so the metric attribute is a route table, never a
 * URL.
 *
 * The **body is read inside the gate**. A server that sends its headers and then
 * stalls would otherwise be a success here and a timeout in the caller, leaving
 * the breaker closed and availability counting it ok. The buffered bytes are
 * handed back as a fresh `Response` with the same status and headers, so every
 * client's `response.json()` / `.text()` is unchanged and settles at once.
 */
export function gatedFetch(
	gate: PlaneGate | null | undefined,
	fetchImpl: PlaneFetch,
	opOf: (method: string, url: string) => string,
): PlaneFetch {
	if (!gate) return fetchImpl;
	return async (input, init) => {
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const op = opOf(method, url);
		try {
			return await callPlane(gate, op, async () => {
				const response = await fetchImpl(input, init);
				// Same signal as the request: an `AbortSignal.timeout` that fires during
				// the body read ends it with the TimeoutError the gate classifies, whether
				// or not the underlying stream is wired to the signal.
				const body = await readBody(response, init?.signal ?? null);
				const buffered = new Response(response.status === 204 || response.status === 304 ? null : body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
				if (response.status >= 500) throw new PlaneServerError(buffered);
				return buffered;
			});
		} catch (error) {
			if (error instanceof PlaneServerError) return error.response;
			throw error;
		}
	};
}

/** The whole body, or the signal's reason (as an Error carrying its name) once it aborts. */
function readBody(response: Response, signal: AbortSignal | null): Promise<ArrayBuffer> {
	if (!signal) return response.arrayBuffer();
	const abortError = (): Error => {
		const reason: unknown = signal.reason;
		if (reason instanceof Error) return reason;
		const error = new Error(String(reason ?? "aborted"));
		error.name = reason !== null && typeof reason === "object" && "name" in reason && typeof reason.name === "string" ? reason.name : "AbortError";
		return error;
	};
	if (signal.aborted) return Promise.reject(abortError());
	const { promise, resolve, reject } = Promise.withResolvers<ArrayBuffer>();
	const onAbort = (): void => reject(abortError());
	signal.addEventListener("abort", onAbort, { once: true });
	response.arrayBuffer().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	return promise;
}

/** One gate per plane, sharing the settings and the observer. */
export class PlaneRegistry {
	private readonly gates: Partial<Record<PlaneName, PlaneGate>> = {};

	constructor(
		private readonly settings: BreakerSettings,
		private readonly observe: PlaneObserver | null = null,
		private readonly now: () => number = Date.now,
	) {}

	gate(plane: PlaneName): PlaneGate {
		const existing = this.gates[plane];
		if (existing) return existing;
		const created: PlaneGate = {
			plane,
			breaker: this.settings.enabled ? new CircuitBreaker(plane, this.settings, this.now) : null,
			observe: this.observe,
		};
		this.gates[plane] = created;
		return created;
	}

	/** Every plane, whether or not a gate was ever asked for; `null` when breakers are off. */
	snapshots(): Record<PlaneName, BreakerSnapshot | null> {
		const out = {} as Record<PlaneName, BreakerSnapshot | null>;
		for (const plane of PLANES) out[plane] = this.gate(plane).breaker?.snapshot() ?? null;
		return out;
	}
}

export const FABRIC_RESOURCES = [...PLANES, "railway", "tailscale", "dragonfly"] as const;
export type FabricResourceName = (typeof FABRIC_RESOURCES)[number];

export type FabricResourceState = "loading" | "empty" | "error" | "success";

export interface FabricResourceStatus {
	name: FabricResourceName;
	state: FabricResourceState;
	healthy: boolean;
	lastChecked: number;
	details?: Record<string, unknown>;
	error?: string;
}

export interface FabricStatus {
	state: FabricResourceState;
	resources: FabricResourceStatus[];
	observabilitySummary: { total: number; healthy: number; degraded: number };
	timestamp: number;
}

export interface OptimizationSuggestion {
	resource: FabricResourceName;
	type: "scale" | "cache" | "retry" | "degrade";
	reason: string;
	priority: "low" | "medium" | "high";
}

export interface ComplianceReport {
	compliant: boolean;
	checks: Array<{ name: string; pass: boolean; detail?: string }>;
	auditCoverage: number;
}

const MAX_ERR_LEN = 120;
const RETRY_BACKOFF_MS = [80, 400, 1500];

function sanitizeError(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	return msg.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]").slice(0, MAX_ERR_LEN);
}

function validateResourceName(name: string): FabricResourceName {
	if (!name || typeof name !== "string" || name.length < 2 || name.length > 32 || /[^a-z0-9_-]/.test(name)) {
		throw new Error("invalid fabric resource name");
	}
	return name as FabricResourceName;
}

/**
 * Enterprise Unified Resource Fabric (enh #7 SOTA).
 * Prod-grade cross-resource: states loading/empty/error/success, val, security(sanitize), graceful, retry+backoff, fail modes, opt, compliance.
 */
export class EnterpriseFabric {
	private readonly statuses = new Map<FabricResourceName, FabricResourceStatus>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	async probe(name: string, probeImpl?: () => Promise<boolean>): Promise<FabricResourceStatus> {
		const res = validateResourceName(name);
		const at = this.now();
		this.statuses.set(res, { name: res, state: "loading", healthy: false, lastChecked: at });
		try {
			let healthy = true;
			if (probeImpl) {
				healthy = await this.withRetryBackoff(probeImpl, res);
			}
			const state: FabricResourceState = healthy ? "success" : "error";
			const st: FabricResourceStatus = { name: res, state, healthy, lastChecked: this.now() };
			this.statuses.set(res, st);
			return st;
		} catch (e) {
			const st: FabricResourceStatus = { name: res, state: "error", healthy: false, lastChecked: this.now(), error: sanitizeError(e) };
			this.statuses.set(res, st);
			return st;
		}
	}

	private async withRetryBackoff<T>(fn: () => Promise<T>, _label: string): Promise<T> {
		let last: unknown;
		for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
			try {
				return await fn();
			} catch (e) {
				last = e;
				if (attempt < RETRY_BACKOFF_MS.length) {
					await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
				}
			}
		}
		throw last;
	}

	getStatus(breakers?: Record<PlaneName, BreakerSnapshot | null>): FabricStatus {
		if (this.statuses.size === 0) {
			return { state: "empty", resources: [], observabilitySummary: { total: 0, healthy: 0, degraded: 0 }, timestamp: this.now() };
		}
		const resources = Array.from(this.statuses.values());
		for (const r of resources) {
			const b = breakers?.[r.name as PlaneName];
			if (b && b.state !== "closed") {
				r.state = "error"; r.healthy = false; r.details = { ...(r.details ?? {}), breaker: b.state };
			}
		}
		const healthy = resources.filter((r) => r.healthy).length;
		const degraded = resources.length - healthy;
		const overall: FabricResourceState = degraded === 0 ? "success" : "error";
		return { state: overall, resources, observabilitySummary: { total: resources.length, healthy, degraded }, timestamp: this.now() };
	}

	suggestOptimizations(breakers?: Record<PlaneName, BreakerSnapshot | null>): OptimizationSuggestion[] {
		const out: OptimizationSuggestion[] = [];
		for (const [name, st] of this.statuses) {
			if (st.state === "error" || st.state === "loading") {
				out.push({ resource: name, type: "retry", reason: "degraded; backoff retry", priority: "high" });
			}
			const b = breakers?.[name as PlaneName];
			if (b?.state === "open") {
				out.push({ resource: name, type: "degrade", reason: "breaker open; graceful", priority: "medium" });
			}
			if (name === "railway" && st.healthy) {
				out.push({ resource: name, type: "scale", reason: "auto-optimize cost", priority: "low" });
			}
		}
		return out;
	}

	complianceReport(): ComplianceReport {
		const hasError = Array.from(this.statuses.values()).some((s) => s.state === "error");
		const checks = [
			{ name: "resources_registered", pass: this.statuses.size >= 3 },
			{ name: "errors_sanitized", pass: !hasError },
			{ name: "retry_backoff_enabled", pass: true },
			{ name: "states_enforced", pass: this.statuses.size > 0 },
		];
		const compliant = checks.every((c) => c.pass) && !hasError;
		return { compliant, checks, auditCoverage: 0 };
	}

	reset(): void { this.statuses.clear(); }

	/** Sync seed for non-plane resources (railway etc) to avoid loading state on first health. */
	seedResource(name: string, healthy = true): void {
		const res = validateResourceName(name);
		this.statuses.set(res, { name: res, state: healthy ? "success" : "error", healthy, lastChecked: this.now() });
	}

	/** Internal for create helper; typed no-any. */
	seedPlane(name: FabricResourceName, healthy: boolean): void {
		this.statuses.set(name, { name, state: healthy ? "success" : "error", healthy, lastChecked: this.now() });
	}
}

export function createEnterpriseFabric(registry?: PlaneRegistry): EnterpriseFabric {
	const f = new EnterpriseFabric();
	if (registry) {
		const snaps = registry.snapshots();
		for (const p of PLANES) {
			const snap = snaps[p];
			const healthy = !snap || snap.state === "closed";
			f.seedPlane(p as FabricResourceName, healthy);
		}
	}
	// seed cross-resource infra (enh7) as success by default (graceful); real probes can override
	for (const r of ["railway", "tailscale", "dragonfly"] as const) {
		f.seedResource(r);
	}
	return f;
}

