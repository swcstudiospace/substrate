/**
 * Omp extension: Agent Substrate usage in the Omp TUI (design v2).
 *
 * Installed as a symlink: ~/.omp/agent/extensions/substrate-status.ts → this file, the same way
 * substrate-skills.ts is installed. Omp's loader auto-discovers that directory and accepts symlinks.
 *
 * What it shows is the server's own counters, not Omp's tool calls. Omp has no substrate MCP server
 * (mcp.json has no substrate entry), so tool calls made inside Omp are not counted here. The substrate
 * attributes traffic to surface "omp" itself; this extension reads GET /metrics and GET /healthz and
 * turns consecutive polls into deltas.
 *
 * - Footer: `substrate · omp +N req · +M emit · <status>`, status healthy | idle | degraded (<plane>).
 * - Widget: the last three polls in which omp had a nonzero delta.
 * - /substrate: one fresh probe, then a summary per surface, planes, cache and ledger rows.
 *
 * Monitoring routes (/healthz, /metrics, /livez, /slo, /slo/history) are left out of the request counts.
 * Without that, this extension's own polls would appear as omp requests and "idle" would never be reached.
 *
 * Fail-open: a failed probe shows "unreachable" and keeps the last good snapshot. No hook throws out.
 * The bearer is resolved per probe, sent only as the Authorization header, and never stored, logged,
 * or returned in any output string.
 *
 * No import from the Omp package or the repo's module graph: the types below are structural copies.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clearInterval, setInterval } from "node:timers";

export type Env = Record<string, string | undefined>;
export type ReadFile = (path: string) => string | null;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Duration {
	count: number;
	sum: number;
}

export interface Totals {
	req: number;
	emit: number;
	tool: number;
}

export interface Counters extends Totals {
	requestDuration: Duration;
	briefDuration: Duration;
}

export interface ParsedMetrics {
	startedAt: string;
	surfaces: Record<string, Counters>;
}

export interface PlaneState {
	ok: boolean;
	breaker: string | null;
}

export interface ParsedHealth {
	planes: Record<string, PlaneState>;
	cacheHits: number | null;
	cacheMisses: number | null;
	ledgerRows: number | null;
	anchorRows: number | null;
}

export interface Snapshot {
	at: number;
	metrics: ParsedMetrics;
	health: ParsedHealth;
}

export type ProbeResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: string };

export interface ProbeDeps {
	fetchImpl?: FetchLike;
	env?: Env;
	readFile?: ReadFile;
	now?: () => number;
}

export interface Recent {
	at: number;
	delta: Totals;
}

export interface ProbeStatus {
	ok: boolean;
	reason: string | null;
	at: number;
}

export interface State {
	sessionId: string | undefined;
	last: Snapshot | null;
	lastDelta: Totals | null;
	lastProbe: ProbeStatus | null;
	lastPollAt: number | null;
	lastActiveAt: number | null;
	recent: Recent[];
	inFlight: boolean;
}

/** Structural subset of Omp's ExtensionContext: getSessionId is a method, so call it as one. */
export interface OmpContext {
	ui: {
		setStatus(key: string, text: string | undefined): void;
		setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	sessionManager?: { getSessionId?(): unknown };
}

export interface OmpPi {
	on(
		event: "session_start" | "agent_end" | "session_shutdown",
		handler: (event: unknown, ctx: OmpContext) => unknown,
	): void;
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: OmpContext) => Promise<void> },
	): void;
}

const DEFAULT_BASE = "http://127.0.0.1:7410";
const DEFAULT_TOKENS_DIR = "/etc/substrate/tokens";
const SURFACE = "omp";
const MAX_TOKEN_FILE_BYTES = 4096;
const TIMEOUT_MS = 1000;
const POLL_MS = 30_000;
const ACTIVE_WINDOW_MS = 5 * 60_000;
const FOOTER_MAX = 79;
/** Monitoring traffic: the substrate does not audit it and no agent action is behind it. Not counted as requests. */
const MONITORING_ROUTES: Record<string, true> = {
	"/healthz": true,
	"/metrics": true,
	"/livez": true,
	"/slo": true,
	"/slo/history": true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function emptyCounters(): Counters {
	return { req: 0, emit: 0, tool: 0, requestDuration: { count: 0, sum: 0 }, briefDuration: { count: 0, sum: 0 } };
}

export function createState(sessionId?: string): State {
	return {
		sessionId,
		last: null,
		lastDelta: null,
		lastProbe: null,
		lastPollAt: null,
		lastActiveAt: null,
		recent: [],
		inFlight: false,
	};
}

/**
 * Per-surface counter totals from a GET /metrics body. Counters sum over every point for a surface;
 * monitoring routes are skipped. Returns null when the body is not a metrics payload.
 */
export function parseMetrics(json: unknown): ParsedMetrics | null {
	if (!isRecord(json)) return null;
	const startedAt = json.startedAt;
	const metrics = json.metrics;
	if (typeof startedAt !== "string" || !Array.isArray(metrics)) return null;
	const surfaces: Record<string, Counters> = {};
	const slot = (surface: string): Counters => {
		const existing = surfaces[surface];
		if (existing) return existing;
		const created = emptyCounters();
		surfaces[surface] = created;
		return created;
	};
	for (const metric of metrics) {
		if (!isRecord(metric) || typeof metric.name !== "string" || !Array.isArray(metric.points)) continue;
		for (const point of metric.points) {
			if (!isRecord(point)) continue;
			const attrs = isRecord(point.attributes) ? point.attributes : {};
			if (typeof attrs.route === "string" && MONITORING_ROUTES[attrs.route] === true) continue;
			const surface = typeof attrs.surface === "string" ? attrs.surface : "unattributed";
			const value = num(point.value);
			const count = num(point.count);
			const sum = num(point.sum);
			switch (metric.name) {
				case "substrate.request.total":
					if (value !== null) slot(surface).req += value;
					break;
				case "substrate.emit.total":
					if (value !== null) slot(surface).emit += value;
					break;
				case "substrate.tool.calls":
					if (value !== null) slot(surface).tool += value;
					break;
				case "substrate.request.duration":
					if (count !== null && sum !== null) {
						slot(surface).requestDuration.count += count;
						slot(surface).requestDuration.sum += sum;
					}
					break;
				case "substrate.brief.duration":
					if (count !== null && sum !== null) {
						slot(surface).briefDuration.count += count;
						slot(surface).briefDuration.sum += sum;
					}
					break;
			}
		}
	}
	return { startedAt, surfaces };
}

/** One surface's counters; zeros when the surface has none. */
export function surfaceTotals(parsed: ParsedMetrics, surface: string): Counters {
	return parsed.surfaces[surface] ?? emptyCounters();
}

/** The difference between two counter readings. Clamped at zero: a counter that went down is a reset, never a negative delta. */
export function diffTotals(prev: Totals, next: Totals): Totals {
	return {
		req: Math.max(0, next.req - prev.req),
		emit: Math.max(0, next.emit - prev.emit),
		tool: Math.max(0, next.tool - prev.tool),
	};
}

/** The fields this extension reads from a GET /healthz body, or null when it is not one. */
export function parseHealthz(json: unknown): ParsedHealth | null {
	if (!isRecord(json)) return null;
	const rawPlanes = json.planes;
	if (!isRecord(rawPlanes)) return null;
	const planes: Record<string, PlaneState> = {};
	for (const [name, plane] of Object.entries(rawPlanes)) {
		if (!isRecord(plane) || typeof plane.ok !== "boolean") continue;
		const breaker = isRecord(plane.breaker) && typeof plane.breaker.state === "string" ? plane.breaker.state : null;
		planes[name] = { ok: plane.ok, breaker };
	}
	const cache = isRecord(json.cache) ? json.cache : {};
	const capacity = isRecord(json.capacity) ? json.capacity : {};
	const ledger = isRecord(capacity.ledger) ? capacity.ledger : null;
	const tables = ledger && Array.isArray(ledger.tables) ? ledger.tables : [];
	const anchors = tables.find((table): table is Record<string, unknown> => isRecord(table) && table.name === "anchors");
	return {
		planes,
		cacheHits: num(cache.hits),
		cacheMisses: num(cache.misses),
		ledgerRows: ledger ? num(ledger.rows) : null,
		anchorRows: anchors ? num(anchors.rows) : null,
	};
}

/** Poll throttle: true when no poll has run yet, or the interval has passed since the last one. */
export function shouldPoll(now: number, lastAt: number | null, intervalMs: number): boolean {
	return lastAt === null || now - lastAt >= intervalMs;
}

function readFirstLine(path: string): string | null {
	try {
		const st = statSync(path);
		if (!st.isFile() || st.size === 0 || st.size > MAX_TOKEN_FILE_BYTES) return null;
		const line = readFileSync(path, "utf8").split("\n", 1)[0]?.trim() ?? "";
		return line ? line : null;
	} catch {
		return null;
	}
}

/**
 * The bearer for surface omp, or null. Same order as substrate-skills.ts resolveBearer and
 * packages/cli/src/token.ts: SUBSTRATE_TOKEN, then SUBSTRATE_TOKEN_FILE, then the tokens-dir file named omp.
 * Resolved per probe; the value is never stored.
 */
export function resolveToken(env: Env, readFile: ReadFile): string | null {
	const direct = (env.SUBSTRATE_TOKEN ?? "").trim();
	if (direct) return direct;
	const file = (env.SUBSTRATE_TOKEN_FILE ?? "").trim();
	if (file) {
		const viaFile = readFile(file)?.trim();
		if (viaFile) return viaFile;
	}
	const dir = (env.SUBSTRATE_TOKENS_DIR ?? "").trim() || DEFAULT_TOKENS_DIR;
	const fromDir = readFile(join(dir, SURFACE))?.trim();
	return fromDir ? fromDir : null;
}

type JsonResult = { ok: true; json: unknown } | { ok: false; reason: string };

async function getJson(url: string, token: string | null, fetchImpl: FetchLike): Promise<JsonResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
		const response = await fetchImpl(url, { headers, signal: controller.signal });
		if (!response.ok) return { ok: false, reason: `http ${response.status}` };
		const text = await response.text();
		try {
			return { ok: true, json: JSON.parse(text) };
		} catch {
			return { ok: false, reason: "parse" };
		}
	} catch {
		return { ok: false, reason: controller.signal.aborted ? "timeout" : "unreachable" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * One poll: GET /metrics and GET /healthz in parallel, each bounded by 1000 ms. Returns the parsed
 * snapshot, or a short reason (timeout, http <status>, unreachable, parse). Never throws.
 */
export async function probe(deps: ProbeDeps = {}): Promise<ProbeResult> {
	const env = deps.env ?? process.env;
	const readFile = deps.readFile ?? readFirstLine;
	const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
	const now = deps.now ?? Date.now;
	const base = ((env.SUBSTRATE_URL ?? "").trim() || DEFAULT_BASE).replace(/\/+$/, "");
	const token = resolveToken(env, readFile);
	const [metrics, health] = await Promise.all([
		getJson(`${base}/metrics`, token, fetchImpl),
		getJson(`${base}/healthz`, token, fetchImpl),
	]);
	if (!metrics.ok) return { ok: false, reason: metrics.reason };
	if (!health.ok) return { ok: false, reason: health.reason };
	const parsedMetrics = parseMetrics(metrics.json);
	const parsedHealth = parseHealthz(health.json);
	if (!parsedMetrics || !parsedHealth) return { ok: false, reason: "parse" };
	return { ok: true, snapshot: { at: now(), metrics: parsedMetrics, health: parsedHealth } };
}

/**
 * Fold one good snapshot into the state. Deltas are omp's difference from the previous good poll.
 * A changed startedAt means the server restarted: this poll becomes the new baseline and its delta is zero.
 */
export function applySnapshot(state: State, snapshot: Snapshot, at: number): void {
	const prev = state.last;
	let delta: Totals = { req: 0, emit: 0, tool: 0 };
	if (prev && prev.metrics.startedAt === snapshot.metrics.startedAt) {
		delta = diffTotals(surfaceTotals(prev.metrics, SURFACE), surfaceTotals(snapshot.metrics, SURFACE));
	}
	state.last = snapshot;
	state.lastDelta = delta;
	state.lastProbe = { ok: true, reason: null, at };
	if (delta.req + delta.emit + delta.tool > 0) {
		state.lastActiveAt = at;
		state.recent = [...state.recent, { at, delta }].slice(-3);
	}
}

/** Run one probe into the state. A failure keeps the last good snapshot. At most one poll is in flight. */
export async function refresh(state: State, deps: ProbeDeps = {}): Promise<void> {
	if (state.inFlight) return;
	state.inFlight = true;
	const now = deps.now ?? Date.now;
	state.lastPollAt = now();
	try {
		const result = await probe(deps);
		const at = now();
		if (result.ok) applySnapshot(state, result.snapshot, at);
		else state.lastProbe = { ok: false, reason: result.reason, at };
	} finally {
		state.inFlight = false;
	}
}

function hhmm(at: number): string {
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

function clip(text: string): string {
	return text.length > FOOTER_MAX ? text.slice(0, FOOTER_MAX) : text;
}

/** The footer line. Priority: unreachable, then degraded, then idle (no omp delta in five minutes), then healthy. */
export function formatFooter(state: State, now: number): string {
	if (!state.lastProbe || !state.last) return "substrate · checking";
	if (!state.lastProbe.ok) return clip(`substrate · unreachable (${state.lastProbe.reason ?? "unknown"})`);
	const delta = state.lastDelta ?? { req: 0, emit: 0, tool: 0 };
	const down = Object.entries(state.last.health.planes)
		.filter(([, plane]) => !plane.ok)
		.map(([name]) => name)
		.sort();
	const idle = state.lastActiveAt === null || now - state.lastActiveAt >= ACTIVE_WINDOW_MS;
	const status = down.length > 0 ? `degraded (${down.join(",")})` : idle ? "idle" : "healthy";
	return clip(`substrate · omp +${delta.req} req · +${delta.emit} emit · ${status}`);
}

/** Widget lines for the last three polls with a nonzero omp delta. Empty when there are none. */
export function formatWidget(state: State): string[] {
	return state.recent
		.slice(-3)
		.map((entry) => `${hhmm(entry.at)}  +${entry.delta.req} req  +${entry.delta.emit} emit  +${entry.delta.tool} tool`);
}

/** Lines for the /substrate notification: a probe result, counters per surface (omp first), planes, cache and ledger. */
export function formatSummary(state: State, now: number): string[] {
	if (!state.lastProbe) return ["substrate: no probe yet"];
	const lines: string[] = [
		state.lastProbe.ok ? "substrate: ok" : `substrate: unreachable (${state.lastProbe.reason ?? "unknown"})`,
	];
	const snap = state.last;
	if (!snap) return lines;
	if (!state.lastProbe.ok) lines.push(`last good snapshot: ${formatAge(now - snap.at)} ago`);
	lines.push(`counters since ${snap.metrics.startedAt} (monitoring routes excluded):`);
	const names = [SURFACE, ...Object.keys(snap.metrics.surfaces).filter((name) => name !== SURFACE).sort()];
	for (const name of names) {
		const c = surfaceTotals(snap.metrics, name);
		lines.push(`  ${name}: req ${c.req}, emit ${c.emit}, tool ${c.tool}`);
	}
	const planes = Object.entries(snap.health.planes).map(
		([name, plane]) => `${name} ${plane.ok ? "ok" : "down"}${plane.breaker ? ` (${plane.breaker})` : ""}`,
	);
	lines.push(`planes: ${planes.length > 0 ? planes.join(", ") : "none reported"}`);
	lines.push(`cache: hits ${snap.health.cacheHits ?? "n/a"}, misses ${snap.health.cacheMisses ?? "n/a"}`);
	lines.push(`ledger rows ${snap.health.ledgerRows ?? "n/a"}, anchors rows ${snap.health.anchorRows ?? "n/a"}`);
	return lines;
}

function sessionIdOf(ctx: OmpContext): string | undefined {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Fire-and-forget: a hook never blocks Omp and never throws out. */
function guard(task: () => Promise<void>): void {
	void task().catch(() => {});
}

export default function (pi: OmpPi): void {
	let state = createState();
	let lastCtx: OmpContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const render = (ctx: OmpContext): void => {
		ctx.ui.setStatus("substrate", formatFooter(state, Date.now()));
		const lines = formatWidget(state);
		ctx.ui.setWidget("substrate", lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
	};

	const poll = async (ctx: OmpContext, force: boolean): Promise<void> => {
		lastCtx = ctx;
		if (!force && !shouldPoll(Date.now(), state.lastPollAt, POLL_MS)) return;
		await refresh(state);
		render(ctx);
	};

	pi.on("session_start", (_event, ctx) =>
		guard(async () => {
			const id = sessionIdOf(ctx);
			if (id !== state.sessionId) state = createState(id);
			clearInterval(timer);
			timer = setInterval(() => {
				const current = lastCtx;
				if (current) guard(() => poll(current, false));
			}, POLL_MS);
			timer.unref();
			await poll(ctx, true);
		}),
	);

	pi.on("agent_end", (_event, ctx) => guard(() => poll(ctx, false)));

	pi.on("session_shutdown", () => {
		clearInterval(timer);
		timer = undefined;
	});

	pi.registerCommand("substrate", {
		description: "Show Agent Substrate usage and server state",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			try {
				await refresh(state);
				render(ctx);
				ctx.ui.notify(formatSummary(state, Date.now()).join("\n"), state.lastProbe?.ok ? "info" : "warning");
			} catch {
				ctx.ui.notify("substrate: status unavailable", "error");
			}
		},
	});
}
