/**
 * Omp extension: Agent Substrate usage in the Omp TUI (design v3).
 *
 * Installed as a symlink: ~/.omp/agent/extensions/substrate-status.ts → this file, the same way
 * substrate-skills.ts is installed. Omp's loader auto-discovers that directory and accepts symlinks.
 *
 * What it shows is the server's own counters, not Omp's tool calls. Omp has no substrate MCP server
 * (mcp.json has no substrate entry), so tool calls made inside Omp are not counted here. The substrate
 * attributes traffic to surface "omp" itself; this extension reads GET /metrics and GET /healthz and
 * turns consecutive polls into deltas.
 *
 * - Chrome: session start clears the `substrate` footer and the below-editor widget before the first
 *   probe, and every render clears them again. Those slots are not part of this plugin. An older install
 *   drops them. Usage still reaches the Ultrathink bar.
 * - Usage: IN_USE when an omp change was seen in the last five minutes; otherwise NOT_OBSERVED_IN_WINDOW.
 *   The window and every time shown are this viewer's poll clock, because /metrics carries no event timestamps.
 * - Coverage: the known clients are the token file names in SUBSTRATE_TOKENS_DIR, with omp always included.
 *   A known client with no counters is NOT_INSTRUMENTED. One with counters is OBSERVED when it changed in the
 *   window, else NO_ACTIVITY_IN_WINDOW. A counted surface outside the list is UNREGISTERED_CLIENT: shown, not dropped.
 * - /substrate: one fresh probe (or the poll already in flight), then the usage definition, coverage, omp counters,
 *   planes, cache and ledger. On error the counters are labelled last known, and the line says to run /substrate again.
 * - Ultrathink bar: after clearing those slots, publishes `busStatus` on the `substrate:status` event-bus channel,
 *   and republishes when `substrate:status-request` arrives. See the docs.
 *
 * Auth: both polls send the omp bearer whenever one resolves. /metrics may require it once the server has tokens
 * configured. An unauthenticated loopback GET answered 200 when checked on 2026-10-15, so it is not assumed.
 *
 * Monitoring routes (/healthz, /metrics, /livez, /slo, /slo/history) are left out of the request counts.
 * Without that, this extension's own polls would appear as omp requests and NOT_OBSERVED_IN_WINDOW would never show.
 *
 * Fail-open: a failed probe shows its reason and keeps the last good snapshot. No hook throws out.
 * The bearer is resolved per probe, sent only as the Authorization header, and never stored, logged,
 * or returned in any output string.
 *
 * No import from the Omp package or the repo's module graph: the types below are structural copies.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";

export type Env = Record<string, string | undefined>;
export type ReadFile = (path: string) => string | null;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type ReadDir = (path: string) => string[] | null;

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

/** Coverage of one known client, or of a counted surface outside the known list. */
export type Coverage = "OBSERVED" | "NO_ACTIVITY_IN_WINDOW" | "NOT_INSTRUMENTED" | "UNREGISTERED_CLIENT";

export interface ClientRow {
	name: string;
	coverage: Coverage;
	counters: Totals;
}

export interface State {
	sessionId: string | undefined;
	last: Snapshot | null;
	lastDelta: Totals | null;
	lastProbe: ProbeStatus | null;
	/** Coverage as of the last good poll. A failed poll reports this, not the live known list. */
	lastCoverage: { observed: number; known: number } | null;
	lastPollAt: number | null;
	/** Poll time at which each surface last showed a change, keyed by surface name. */
	surfaceActiveAt: Record<string, number>;
	/** The known clients: omp plus the token file names. The poller sets this before each probe. */
	known: string[];
	recent: Recent[];
	/** The poll in flight, if any. A refresh made meanwhile awaits this same promise. */
	inFlight: Promise<void> | null;
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

export interface OmpEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
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
	/** Shared Omp event bus. Optional: without it the Ultrathink bar publisher does nothing. */
	events?: OmpEventBus;
}

export const SUBSTRATE_STATUS_CHANNEL = "substrate:status";
export const SUBSTRATE_STATUS_REQUEST = "substrate:status-request";
const BUS_REASON_MAX = 40;

/** The payload on SUBSTRATE_STATUS_CHANNEL. These keys and types are the bar contract. */
export interface SubstrateBusStatus {
	v: 1;
	state: "checking" | "ok" | "error" | "access-denied";
	usage: "IN_USE" | "NOT_OBSERVED_IN_WINDOW" | "UNKNOWN";
	omp: Totals | null;
	coverage: { observed: number; known: number } | null;
	planesDown: number | null;
	updatedAt: string;
	reason: string | null;
}

const DEFAULT_BASE = "http://127.0.0.1:7410";
const DEFAULT_TOKENS_DIR = "/etc/substrate/tokens";
const SURFACE = "omp";
const MAX_TOKEN_FILE_BYTES = 4096;
/** Per request. A cold /healthz can take longer than one second. */
export const PROBE_TIMEOUT_MS = 3000;
/** How long /substrate waits for a poll already in flight before it renders what it has. */
export const SUBSTRATE_WAIT_MS = 4000;
const POLL_MS = 30_000;
const USAGE_WINDOW_MS = 5 * 60_000;
const FOOTER_MAX = 79;
export const AUTH_REQUIRED = "auth required";
export const AUTH_FAILED = "auth failed";
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
		lastCoverage: null,
		lastPollAt: null,
		surfaceActiveAt: {},
		known: [SURFACE],
		recent: [],
		inFlight: null,
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

interface JsonFailure {
	ok: false;
	reason: string;
	/** The HTTP status when the server answered; null for a transport failure or an unreadable body. */
	status: number | null;
}

type JsonResult = { ok: true; json: unknown } | JsonFailure;

async function getJson(url: string, token: string | null, fetchImpl: FetchLike): Promise<JsonResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
		const response = await fetchImpl(url, { headers, signal: controller.signal });
		if (!response.ok) return { ok: false, reason: `http ${response.status}`, status: response.status };
		const text = await response.text();
		try {
			return { ok: true, json: JSON.parse(text) };
		} catch {
			return { ok: false, reason: "parse", status: null };
		}
	} catch {
		return { ok: false, reason: controller.signal.aborted ? "timeout" : "unreachable", status: null };
	} finally {
		clearTimeout(timer);
	}
}

/** A 401 or 403 is an auth failure: "auth required" when no token was sent, "auth failed" when one was. */
function failure(result: JsonFailure, token: string | null): ProbeResult {
	if (result.status === 401 || result.status === 403) {
		return { ok: false, reason: token ? AUTH_FAILED : AUTH_REQUIRED };
	}
	return { ok: false, reason: result.reason };
}

/**
 * One poll: GET /metrics and GET /healthz in parallel, each bounded by PROBE_TIMEOUT_MS, both with the
 * omp bearer when one resolves. Returns the parsed snapshot, or a short reason (timeout, http <status>,
 * unreachable, parse, auth required, auth failed). Never throws.
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
	if (!metrics.ok) return failure(metrics, token);
	if (!health.ok) return failure(health, token);
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
	const sameRun = prev !== null && prev.metrics.startedAt === snapshot.metrics.startedAt;
	let omp: Totals = { req: 0, emit: 0, tool: 0 };
	if (prev && sameRun) {
		omp = diffTotals(surfaceTotals(prev.metrics, SURFACE), surfaceTotals(snapshot.metrics, SURFACE));
		for (const name of Object.keys(snapshot.metrics.surfaces)) {
			const delta = diffTotals(surfaceTotals(prev.metrics, name), surfaceTotals(snapshot.metrics, name));
			if (delta.req + delta.emit + delta.tool > 0) state.surfaceActiveAt[name] = at;
		}
	}
	state.last = snapshot;
	state.lastCoverage = busCoverage(state, at);
	state.lastDelta = omp;
	state.lastProbe = { ok: true, reason: null, at };
	if (omp.req + omp.emit + omp.tool > 0) state.recent = [...state.recent, { at, delta: omp }].slice(-3);
}

/**
 * Run one probe into the state. A failure keeps the last good snapshot. While a poll is in flight, a
 * refresh returns that same promise, so every caller sees the result of the poll already running.
 */
export function refresh(state: State, deps: ProbeDeps = {}): Promise<void> {
	if (state.inFlight) return state.inFlight;
	const now = deps.now ?? Date.now;
	state.lastPollAt = now();
	const task = (async (): Promise<void> => {
		try {
			const result = await probe(deps);
			const at = now();
			if (result.ok) applySnapshot(state, result.snapshot, at);
			else state.lastProbe = { ok: false, reason: result.reason, at };
		} finally {
			state.inFlight = null;
		}
	})();
	state.inFlight = task;
	return task;
}

/** Waits for a task for at most `ms`. A slower task keeps running; its result lands in the state when it finishes. */
async function settleWithin(task: Promise<void>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	try {
		await Promise.race([task, deadline]);
	} finally {
		clearTimeout(timer);
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

/** Drops control and bidi-override characters, so a name from the server cannot move the cursor or reorder a line. */
export function safeText(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
		const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
		if (!control && !bidi) out += ch;
	}
	return out;
}

const KNOWN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The known clients: omp first, then the token file names in SUBSTRATE_TOKENS_DIR that are plain names. */
export function knownClients(env: Env, readDir: ReadDir): string[] {
	const dir = (env.SUBSTRATE_TOKENS_DIR ?? "").trim() || DEFAULT_TOKENS_DIR;
	const others = new Set<string>();
	for (const name of readDir(dir) ?? []) {
		if (name !== SURFACE && KNOWN_NAME.test(name)) others.add(name);
	}
	return [SURFACE, ...[...others].sort()];
}

/** The names of the regular files in a directory, symlinks followed. A folder is not a client. Null when the directory cannot be read. */
export function readTokenNames(dir: string): string[] | null {
	try {
		return readdirSync(dir).filter((name) => {
			try {
				return statSync(join(dir, name)).isFile();
			} catch {
				return false;
			}
		});
	} catch {
		return null;
	}
}

function inWindow(at: number | undefined, now: number): boolean {
	return at !== undefined && now - at < USAGE_WINDOW_MS;
}

function usageOf(state: State, now: number): "IN_USE" | "NOT_OBSERVED_IN_WINDOW" {
	return inWindow(state.surfaceActiveAt[SURFACE], now) ? "IN_USE" : "NOT_OBSERVED_IN_WINDOW";
}

function isAuth(reason: string | null): boolean {
	return reason === AUTH_REQUIRED || reason === AUTH_FAILED;
}

/** One row per known client, then any counted surface outside the list. Counters come from the last good snapshot. */
export function coverageRows(state: State, now: number): ClientRow[] {
	const parsed = state.last?.metrics ?? null;
	const countersOf = (name: string): Totals => {
		const c = parsed ? surfaceTotals(parsed, name) : emptyCounters();
		return { req: c.req, emit: c.emit, tool: c.tool };
	};
	const emitting = (totals: Totals): boolean => totals.req + totals.emit + totals.tool > 0;
	const rows: ClientRow[] = [];
	for (const name of state.known) {
		const counters = countersOf(name);
		let coverage: Coverage = "NOT_INSTRUMENTED";
		if (emitting(counters)) coverage = inWindow(state.surfaceActiveAt[name], now) ? "OBSERVED" : "NO_ACTIVITY_IN_WINDOW";
		rows.push({ name, coverage, counters });
	}
	const known = new Set(state.known);
	for (const name of Object.keys(parsed?.surfaces ?? {}).sort()) {
		const counters = countersOf(name);
		if (!known.has(name) && emitting(counters)) rows.push({ name, coverage: "UNREGISTERED_CLIENT", counters });
	}
	return rows;
}

const USAGE_CAPTION = `usage: IN_USE = an omp read or write counted by the substrate in the last ${USAGE_WINDOW_MS / 60_000} min; NOT_OBSERVED_IN_WINDOW = none in that window; UNKNOWN = the source is unavailable. Counts are the server's, not Omp tool calls.`;

/** The footer line: checking, ACCESS_DENIED, ERROR, or usage with planes and the poll time. Never shows zeros for an unknown value. */
export function formatFooter(state: State, now: number): string {
	if (!state.lastProbe) return "substrate · checking";
	if (!state.lastProbe.ok) return clip(errorFooter(state));
	const snap = state.last;
	if (!snap) return "substrate · checking";
	const delta = state.lastDelta ?? { req: 0, emit: 0, tool: 0 };
	const down = Object.entries(snap.health.planes)
		.filter(([, plane]) => !plane.ok)
		.map(([name]) => safeText(name))
		.sort();
	const planes = down.length === 0 ? "planes ok" : down.length === 1 ? `${down[0]} down` : `${down.length} planes down`;
	return clip(`substrate · ${usageOf(state, now)} · omp +${delta.req} req +${delta.emit} emit · ${planes} · ${hhmm(state.lastProbe.at)}`);
}

function errorFooter(state: State): string {
	const reason = state.lastProbe?.reason ?? null;
	if (isAuth(reason)) return `substrate · ACCESS_DENIED ${reason}`;
	const seen = state.last ? `last good ${hhmm(state.last.at)}` : "no data yet";
	return `substrate · ERROR (${reason ?? "unknown"}) · ${seen} · /substrate retries`;
}

/** Widget lines: a caption that states the feed cap and the refresh, then the last three polls with a nonzero omp change. Empty when there are none. */
export function formatWidget(state: State): string[] {
	const rows = state.recent
		.slice(-3)
		.map((entry) => `${hhmm(entry.at)}  +${entry.delta.req} req  +${entry.delta.emit} emit  +${entry.delta.tool} tool`);
	if (rows.length === 0) return [];
	return [`omp changes, newest last · feed cap 3 polls · refresh every ${POLL_MS / 1000} s`, ...rows];
}

/** The one hint line for an auth failure. It names where the token comes from and never includes its value. */
function authHint(reason: string): string {
	if (reason === AUTH_REQUIRED) {
		return "hint: set SUBSTRATE_TOKEN, SUBSTRATE_TOKEN_FILE, or the omp file in SUBSTRATE_TOKENS_DIR";
	}
	return "hint: the omp token was refused; check SUBSTRATE_TOKEN, SUBSTRATE_TOKEN_FILE, or the omp token file";
}

/** Lines for /substrate: the probe state and usage definition, omp counters, client coverage, planes, cache and ledger. */
export function formatSummary(state: State, now: number): string[] {
	const probeStatus = state.lastProbe;
	if (!probeStatus) return ["substrate: checking, no probe yet"];
	const reason = probeStatus.reason;
	if (!probeStatus.ok && reason !== null && isAuth(reason)) {
		return [`substrate: ACCESS_DENIED (${reason})`, authHint(reason)];
	}
	const lines = [probeStatus.ok ? `substrate: OK, updated ${hhmm(probeStatus.at)}` : `substrate: ERROR (${reason ?? "unknown"})`];
	lines.push(USAGE_CAPTION);
	if (!probeStatus.ok) lines.push("retry: run /substrate again");
	const snap = state.last;
	if (!snap) return lines;
	const basis = probeStatus.ok ? "" : " (last known)";
	const omp = surfaceTotals(snap.metrics, SURFACE);
	const usage = probeStatus.ok ? usageOf(state, now) : "UNKNOWN";
	const stamp = probeStatus.ok ? `counted since ${snap.metrics.startedAt}` : `last good at ${hhmm(snap.at)}`;
	lines.push(`omp: ${usage} · req ${omp.req}, emit ${omp.emit}, tool ${omp.tool} · ${stamp}`);
	const asOf = probeStatus.ok ? now : snap.at;
	const rows = coverageRows(state, asOf);
	const known = rows.filter((row) => row.coverage !== "UNREGISTERED_CLIENT");
	const missing = known.filter((row) => row.coverage === "NOT_INSTRUMENTED").map((row) => safeText(row.name));
	const banner = missing.length > 0 ? `; NOT_INSTRUMENTED: ${missing.join(", ")}; the headline covers observed clients only` : "";
	lines.push(`coverage${basis}: ${known.length - missing.length} of ${known.length} known clients observed${banner}`);
	for (const row of known) {
		const shown =
			row.coverage === "NOT_INSTRUMENTED"
				? row.coverage
				: `${row.coverage} · req ${row.counters.req}, emit ${row.counters.emit}, tool ${row.counters.tool}`;
		lines.push(`  ${safeText(row.name)}: ${shown}`);
	}
	const unregistered = rows
		.filter((row) => row.coverage === "UNREGISTERED_CLIENT")
		.map((row) => `${safeText(row.name)} req ${row.counters.req}, emit ${row.counters.emit}, tool ${row.counters.tool}`);
	if (unregistered.length > 0) lines.push(`unregistered (counted, not in the known list): ${unregistered.join("; ")}`);
	const planes = Object.entries(snap.health.planes).map(
		([name, plane]) => `${safeText(name)} ${plane.ok ? "ok" : "down"}${plane.breaker ? ` (${safeText(plane.breaker)})` : ""}`,
	);
	lines.push(`planes${basis}: ${planes.length > 0 ? planes.join(", ") : "none reported"}`);
	lines.push(`cache: hits ${snap.health.cacheHits ?? "n/a"}, misses ${snap.health.cacheMisses ?? "n/a"}`);
	lines.push(`ledger rows ${snap.health.ledgerRows ?? "n/a"}, anchors rows ${snap.health.anchorRows ?? "n/a"}`);
	return lines;
}

/** The reason as the bar carries it: at most BUS_REASON_MAX characters. */
function busReason(reason: string | null): string | null {
	return reason === null ? null : reason.slice(0, BUS_REASON_MAX);
}

type BusFields = Pick<SubstrateBusStatus, "state"> & Partial<Omit<SubstrateBusStatus, "v" | "state">>;

function busFrame({ state, ...rest }: BusFields): SubstrateBusStatus {
	return { v: 1, state, usage: "UNKNOWN", omp: null, coverage: null, planesDown: null, updatedAt: "", reason: null, ...rest };
}

function ompTotals(snap: Snapshot): Totals {
	const c = surfaceTotals(snap.metrics, SURFACE);
	return { req: c.req, emit: c.emit, tool: c.tool };
}

/** Known clients only. Observed: counted, and not NOT_INSTRUMENTED. */
function busCoverage(state: State, asOf: number): { observed: number; known: number } {
	const rows = coverageRows(state, asOf).filter((row) => row.coverage !== "UNREGISTERED_CLIENT");
	return { observed: rows.filter((row) => row.coverage !== "NOT_INSTRUMENTED").length, known: rows.length };
}

/**
 * The Ultrathink bar's view of the state. Pure: `now` is the only clock. Counts come from the last good
 * snapshot. An auth failure carries no counts.
 */
export function busStatus(state: State, now: number): SubstrateBusStatus {
	const probe = state.lastProbe;
	const snap = state.last;
	if (!probe) return busFrame({ state: "checking" });
	if (!probe.ok && isAuth(probe.reason)) {
		return busFrame({ state: "access-denied", updatedAt: hhmm(probe.at), reason: busReason(probe.reason) });
	}
	if (!snap) return busFrame(probe.ok ? { state: "checking" } : { state: "error", reason: busReason(probe.reason) });
	if (!probe.ok) {
		return busFrame({
			state: "error",
			omp: ompTotals(snap),
			coverage: state.lastCoverage,
			planesDown: Object.values(snap.health.planes).filter((plane) => !plane.ok).length,
			updatedAt: hhmm(snap.at),
			reason: busReason(probe.reason),
		});
	}
	return busFrame({
		state: "ok",
		usage: usageOf(state, now),
		omp: ompTotals(snap),
		coverage: busCoverage(state, now),
		planesDown: Object.values(snap.health.planes).filter((plane) => !plane.ok).length,
		updatedAt: hhmm(probe.at),
		reason: null,
	});
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
	const reloadKnown = (): void => {
		state.known = knownClients(process.env, readTokenNames);
	};

	const dropChrome = (ctx: OmpContext): void => {
		try {
			ctx.ui.setStatus("substrate", undefined);
			ctx.ui.setWidget("substrate", undefined, { placement: "belowEditor" });
		} catch {}
	};

	const render = (ctx: OmpContext): void => {
		dropChrome(ctx);
		publish();
	};

	const publish = (): void => {
		try {
			pi.events?.emit(SUBSTRATE_STATUS_CHANNEL, busStatus(state, Date.now()));
		} catch {}
	};
	try {
		pi.events?.on(SUBSTRATE_STATUS_REQUEST, () => publish());
	} catch {}

	const poll = async (ctx: OmpContext, force: boolean): Promise<void> => {
		lastCtx = ctx;
		if (!force && !shouldPoll(Date.now(), state.lastPollAt, POLL_MS)) return;
		reloadKnown();
		await refresh(state);
		render(ctx);
	};

	pi.on("session_start", (_event, ctx) =>
		guard(async () => {
			dropChrome(ctx);
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
				reloadKnown();
				await settleWithin(refresh(state), SUBSTRATE_WAIT_MS);
				render(ctx);
				ctx.ui.notify(formatSummary(state, Date.now()).join("\n"), state.lastProbe?.ok ? "info" : "warning");
			} catch {
				ctx.ui.notify("substrate: status unavailable", "error");
			}
		},
	});
}
