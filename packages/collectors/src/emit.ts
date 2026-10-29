/**
 * Shared fail-open emit client for every Phase 19 collector and hook.
 *
 * One convention (D19-04): `SUBSTRATE_URL` (default `http://127.0.0.1:7410`)
 * and `SUBSTRATE_TOKEN` as a bearer token when set, both read at call time so
 * tests and long-running collectors never pin a stale value. Timeouts are 3 s
 * in long-running collectors and at most 1.5 s in hooks (D19-06); the caller
 * passes its bound, this module never waits past it for the network. With the
 * spool on, a failed attempt then parks the event on disk, which can add up to
 * 500 ms of waiting for the spool's lock and, when a cap was crossed, one
 * compaction on top of the bound.
 *
 * Outcomes (D19-04): 202 is `stored`, any 4xx is `refused`, and 5xx, network
 * errors or timeouts are `failed`. `postEvent` never throws. With
 * `SUBSTRATE_EVENT_SPOOL` off (the default) a failed event is dropped and
 * counted, exactly as before, and this module touches no spool file at all.
 *
 * Refusals are visible (D19-05): `recordRefusal` appends one JSON line holding
 * exactly `ts`, `collector`, `source`, `kind`, `surface`, `status` and `error`
 * to `${SUBSTRATE_STATE_DIR:-/var/lib/substrate}/refused-emits.jsonl` — never
 * the event's summary or payload, with the server's error through `redact()`
 * and truncated to 200 chars — plus one stderr line for the journal. That file
 * is capped (`SUBSTRATE_REFUSED_EMITS_MAX_BYTES`, default 1 MiB): at the cap it
 * is renamed to `refused-emits.jsonl.1` (one rotated file, replacing the last)
 * and a fresh file starts, so it can no longer grow without bound.
 *
 * The event spool (uplift-5 U5-4b, `SUBSTRATE_EVENT_SPOOL=on`): the first
 * attempt of every event is redacted, stamped with its `ts` and an
 * idempotency key, and sent as `{ ...event, ts, idempotency_key }`. A
 * retryable failure (network error, timeout, 5xx, 503 `stored:false`) parks
 * that exact body in `spool.ts`'s file; a 4xx is permanent, is logged as a
 * refusal and is never spooled. `postEvent` and the hooks that call it only
 * append. `drainEventSpool` replays parked events with `x-substrate-replay: 1`
 * and the same body, and only after `GET /healthz` says the server's
 * `idempotency` is `accept` or `enforce`: against `off` the server ignores the
 * key and a replay of an event whose first attempt actually landed would write
 * a second row, so the spool is kept and tried again later. A replay that the
 * server dedupes (202 with `deduplicated`) is a delivery. Drops (overflow, TTL,
 * attempts, oversize, an unwritable spool) are written as `dropped` lines to
 * the refused file so nothing disappears silently.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveBearer } from "../../cli/src/token.ts";
import { redact, redactValue } from "../../mcp-server/src/redact.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";
import {
	contentKey,
	canonicalJson,
	EventSpool,
	IDEMPOTENCY_KEY_PATTERN,
	spoolConfig,
	type SpoolDelivery,
	type SpoolDrainReport,
	type SpoolDropReport,
	type SpoolConfig,
	type SpoolEntry,
} from "./spool.ts";

/** Long-running collectors wait this long for one emit (D19-06). */
export const COLLECTOR_TIMEOUT_MS = 3000;
/** Hooks never wait past this (D19-06). */
export const HOOK_TIMEOUT_MS = 1500;
/** Long-running collectors replay the spool on this cadence. */
export const SPOOL_DRAIN_MS = 30_000;

const DEFAULT_URL = "http://127.0.0.1:7410";
const DEFAULT_STATE_DIR = "/var/lib/substrate";
const REFUSED_FILE = "refused-emits.jsonl";
const SPOOL_FILE = "event-spool.jsonl";
const MAX_ERROR_CHARS = 200;
const DEFAULT_REFUSED_MAX_BYTES = 1_048_576;
const MIN_REFUSED_MAX_BYTES = 4096;
const MAX_REFUSED_MAX_BYTES = 64 * 1024 * 1024;
/** How long one `/healthz` answer is trusted before a replay pass asks again. */
const PROBE_TTL_MS = 15_000;
/** A repeated reason for holding the spool is logged at most this often. */
const HELD_LOG_INTERVAL_MS = 60_000;
const DEFAULT_DRAIN_BUDGET_MS = 10_000;

/** The state-file key long-running collectors count outcomes under. */
export const COUNTERS_KEY = "counters";

export type EmitOutcome =
	| { kind: "stored" }
	| { kind: "refused"; status: number; error?: string | undefined }
	/** `spooled` is set when the event was parked for replay: the live attempt failed, the event is not lost. */
	| { kind: "failed"; status?: number; error?: string | undefined; spooled?: true };

export interface PostEventOptions {
	/** Per-call bound; collectors pass 3000, hooks at most 1500. */
	timeoutMs?: number;
	/** Collector name for the refused line, e.g. "grok". */
	collector?: string;
	/** Phase 17 row id for the refused line; defaults to the collector. */
	source?: string;
	/** Override for `SUBSTRATE_URL` (tests, hooks without env). */
	url?: string;
	/** Override for `SUBSTRATE_TOKEN` (tests, hooks without env). */
	token?: string;
	/**
	 * A stable idempotency key for this event when the caller has one that is
	 * better than its content (grok: file + offset + session). Used only with the
	 * spool on, and only when it matches `[A-Za-z0-9._:-]{8,128}`; otherwise the
	 * key is derived from the event's content.
	 */
	idempotencyKey?: string;
}

export interface EmitCounters {
	stored: number;
	refused: number;
	failed: number;
}

/** Zeroed counters; extra collector keys (unmapped, fetch_failed) live beside these. */
export function emptyCounters(): EmitCounters {
	return { stored: 0, refused: 0, failed: 0 };
}

/** Bump the counter matching an outcome. Returns the same object. */
export function countOutcome<C extends EmitCounters>(counters: C, outcome: EmitOutcome): C {
	if (outcome.kind === "stored") counters.stored += 1;
	else if (outcome.kind === "refused") counters.refused += 1;
	else counters.failed += 1;
	return counters;
}

function stateDir(): string {
	return process.env.SUBSTRATE_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
}

function refusedMaxBytes(): number {
	const raw = process.env.SUBSTRATE_REFUSED_EMITS_MAX_BYTES?.trim();
	if (!raw) return DEFAULT_REFUSED_MAX_BYTES;
	if (!/^\d{1,12}$/.test(raw) || Number(raw) < 1) {
		warnOnce([`SUBSTRATE_REFUSED_EMITS_MAX_BYTES must be a positive integer; using ${DEFAULT_REFUSED_MAX_BYTES}`]);
		return DEFAULT_REFUSED_MAX_BYTES;
	}
	const value = Number(raw);
	if (value < MIN_REFUSED_MAX_BYTES) {
		warnOnce([`SUBSTRATE_REFUSED_EMITS_MAX_BYTES is below the minimum ${MIN_REFUSED_MAX_BYTES}; using ${MIN_REFUSED_MAX_BYTES}`]);
		return MIN_REFUSED_MAX_BYTES;
	}
	if (value > MAX_REFUSED_MAX_BYTES) {
		warnOnce([`SUBSTRATE_REFUSED_EMITS_MAX_BYTES is above the ceiling ${MAX_REFUSED_MAX_BYTES}; using ${MAX_REFUSED_MAX_BYTES}`]);
		return MAX_REFUSED_MAX_BYTES;
	}
	return value;
}

/**
 * One line into the refused journal, rotating first when it is at the cap.
 * `rename` replaces any previous `.1`, so at most two files exist; the rotation
 * happens before the append, so the newest line is always in the live file.
 * Never throws.
 */
function appendRefusedLine(line: string): void {
	try {
		const dir = stateDir();
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			// A read-only state dir still gets the journal line on stderr.
		}
		const path = join(dir, REFUSED_FILE);
		try {
			if (statSync(path).size >= refusedMaxBytes()) renameSync(path, `${path}.1`);
		} catch {
			// No file yet, or a rotation another process already did.
		}
		appendFileSync(path, `${line}\n`);
	} catch {
		// The refusal counts even when the file is unwritable.
	}
}

function stderrLine(text: string): void {
	try {
		process.stderr.write(text);
	} catch {
		// Never throw from a reporting path.
	}
}

export interface RefusalInput {
	event: EventInput;
	collector: string;
	source: string;
	status: number;
	error?: string | undefined;
	/** The line's `kind`; the event's own kind unless a caller (the spool's `dropped` lines) says otherwise. */
	kind?: string;
}

/**
 * One refused emit, where the operator can see it: a single small O_APPEND
 * line plus one stderr line. Never throws; a refusal the module cannot record
 * is still a refusal the journal shows.
 */
export function recordRefusal(input: RefusalInput): void {
	const safeError = redact(input.error ?? `http ${input.status}`).slice(0, MAX_ERROR_CHARS);
	appendRefusedLine(
		JSON.stringify({
			ts: new Date().toISOString(),
			collector: input.collector,
			source: input.source,
			kind: input.kind ?? input.event.kind,
			surface: input.event.surface,
			status: input.status,
			error: safeError,
		}),
	);
	const what = input.kind === "dropped" ? "dropped spooled event" : "refused emit";
	stderrLine(
		`[collectors] ${what} collector=${input.collector} source=${input.source} status=${input.status} error=${safeError}\n`,
	);
}

async function serverError(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as { error?: unknown };
		return typeof body.error === "string" ? body.error : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// The spool: first-attempt stamping, append on a retryable failure, replay.
// ---------------------------------------------------------------------------

const warnedConfig = new Set<string>();

function warnOnce(lines: readonly string[]): void {
	for (const line of lines) {
		if (warnedConfig.has(line)) continue;
		warnedConfig.add(line);
		stderrLine(`[collectors] event spool config: ${line}\n`);
	}
}

/** What a dropped spool entry leaves in the refused journal: one line per sampled entry, one summary line for the rest. */
function recordSpoolDrop(report: SpoolDropReport): void {
	for (const entry of report.sample) {
		recordRefusal({
			event: entry.event,
			collector: entry.collector,
			source: entry.source,
			status: 0,
			kind: "dropped",
			error: `spool-${report.cause} event_kind=${entry.event.kind}`,
		});
	}
	const more = report.count - report.sample.length;
	if (more > 0) {
		const first = report.sample[0];
		recordRefusal({
			event: { surface: first?.event.surface ?? "substrate", kind: "warning", summary: "-" },
			collector: first?.collector ?? "spool",
			source: first?.source ?? "spool",
			status: 0,
			kind: "dropped",
			error: `spool-${report.cause} more=${more}`,
		});
	}
}

let cachedSpool: { signature: string; spool: EventSpool } | null = null;

/**
 * The spool for this process's current environment, whatever the flag says.
 * `substrate spool status` reads through this; emit and replay go through
 * `eventSpool`, which is null while the flag is off.
 */
export function openEventSpool(env: NodeJS.ProcessEnv = process.env): { spool: EventSpool; config: SpoolConfig } {
	const config = spoolConfig(env);
	warnOnce(config.warnings);
	const dir = env.SUBSTRATE_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
	const path = join(dir, SPOOL_FILE);
	const signature = `${path}|${config.max}|${config.maxBytes}|${config.ttlMs}|${config.maxAttempts}`;
	if (cachedSpool?.signature !== signature) {
		cachedSpool = {
			signature,
			spool: new EventSpool({
				path,
				max: config.max,
				maxBytes: config.maxBytes,
				ttlMs: config.ttlMs,
				maxAttempts: config.maxAttempts,
				onDrop: recordSpoolDrop,
			}),
		};
	}
	return { spool: cachedSpool.spool, config };
}

/** The spool when `SUBSTRATE_EVENT_SPOOL=on`; null otherwise, and then nothing on disk is touched. */
export function eventSpool(env: NodeJS.ProcessEnv = process.env): EventSpool | null {
	const config = spoolConfig(env);
	warnOnce(config.warnings);
	return config.mode === "on" ? openEventSpool(env).spool : null;
}

/** An event as it is fixed at its first attempt: redacted, stamped, keyed, and serialized once. */
export interface PreparedEvent {
	event: EventInput;
	key: string;
	body: string;
}

const REDACTED_FIELDS = ["session_id", "graph_id", "node_id", "linear_identifier", "repo", "branch", "summary"] as const;

/**
 * Redact the event, fix its `ts` (the caller's, else now) and its idempotency
 * key, and serialize the body that every attempt of this event will send. The
 * key is the caller's stable one when valid, else
 * `sha256` of the JSON array `[collector, surface, session, kind, ts, summary, …,
 * canonical payload]` (JSON, so a `|` in a field cannot alias its neighbour): the
 * same content at the same `ts` always yields the same key (so, under the server's
 * `enforce`, two genuinely identical events in the same millisecond collapse to
 * one; a caller that needs both passes a stable `idempotencyKey`), and `ts` is fixed
 * here, so a clock that moves between the live attempt and a replay cannot
 * change it. Redacting first means a planted secret is neither sent in a form
 * the server would store differently nor ever written to the spool file.
 */
export function prepareEvent(event: EventInput, opts: { collector?: string; idempotencyKey?: string | undefined } = {}): PreparedEvent {
	// The server redacts the free-text identifiers, the summary and the payload (`normalizeEvent`),
	// and parses `ts` before redacting anything; so does this, and `surface`, `kind` and `actor` stay as given.
	const safe: EventInput = { ...event };
	for (const field of REDACTED_FIELDS) {
		const value = safe[field];
		if (typeof value === "string") safe[field] = redact(value);
	}
	if (safe.payload !== undefined) safe.payload = redactValue(safe.payload);
	// Whatever `normalizeEvent` reads as a ts: a non-empty string, or a finite non-zero epoch-ms number (both go through
	// `new Date(ts)` there). Anything else counts as absent and is stamped now.
	// The type says string; a JSON caller can send a number, so the value is read as unknown.
	const rawTs: unknown = safe.ts;
	const given = typeof rawTs === "string" && rawTs !== "" ? rawTs : typeof rawTs === "number" && Number.isFinite(rawTs) && rawTs !== 0 ? rawTs : undefined;
	const parsed = given === undefined ? new Date() : new Date(given);
	// An unparseable caller ts is left as it is: the server refuses it (4xx), nothing is spooled.
	const ts = Number.isNaN(parsed.getTime()) ? (given as string) : parsed.toISOString();
	const stamped: EventInput = { ...safe, ts };
	const supplied = opts.idempotencyKey;
	const key =
		supplied !== undefined && IDEMPOTENCY_KEY_PATTERN.test(supplied)
			? supplied
			: contentKey([
					opts.collector ?? "unknown",
					stamped.surface,
					stamped.session_id ?? "",
					stamped.kind,
					ts,
					stamped.summary,
					stamped.repo ?? "",
					stamped.branch ?? "",
					stamped.graph_id ?? "",
					stamped.node_id ?? "",
					stamped.linear_identifier ?? "",
					stamped.step === undefined ? "" : String(stamped.step),
					stamped.actor ?? "",
					canonicalJson(stamped.payload ?? {}),
				]);
	return { event: stamped, key, body: JSON.stringify({ ...stamped, idempotency_key: key }) };
}

/** A failure worth replaying: no answer at all, or a 5xx (503 `stored:false` included). A 4xx and any other status are not. */
function retryable(outcome: { status?: number }): boolean {
	return outcome.status === undefined || outcome.status >= 500;
}

/**
 * Park a prepared event after a retryable failed attempt. The hooks' only spool
 * call: one lock and one append, no network, no drain. False when the flag is
 * off (nothing is opened), the event is over the body cap, or the disk refused;
 * each of the last two leaves a visible `dropped` line.
 */
export function parkEvent(prepared: PreparedEvent, opts: { collector: string; source: string; reason: string }): boolean {
	const spool = eventSpool();
	if (spool === null) return false;
	return spool.append({ key: prepared.key, collector: opts.collector, source: opts.source, event: prepared.event, reason: opts.reason }).ok;
}

function baseUrl(url?: string): string {
	const rawBase = url ?? process.env.SUBSTRATE_URL?.trim() ?? "";
	return (rawBase || DEFAULT_URL).replace(/\/+$/, "");
}

/**
 * POST one event. Never throws and never waits on the network past `timeoutMs`
 * (with the spool on, parking a failure can add up to 500 ms of lock wait and a
 * possible compaction; see the header): 202 is
 * stored, 4xx is refused (and recorded), everything else — 5xx, a network
 * error, a timeout — is failed. With the spool on, a retryable failure is
 * parked for replay and the outcome carries `spooled: true`.
 */
export async function postEvent(event: EventInput, opts: PostEventOptions = {}): Promise<EmitOutcome> {
	const timeoutMs = opts.timeoutMs ?? COLLECTOR_TIMEOUT_MS;
	const collector = opts.collector ?? "unknown";
	const source = opts.source ?? collector;
	const spool = eventSpool();
	let prepared: PreparedEvent | null = null;
	const failed = (outcome: Extract<EmitOutcome, { kind: "failed" }>): EmitOutcome => {
		if (prepared === null || !retryable(outcome)) return outcome;
		const reason = outcome.status === undefined ? (outcome.error ?? "unreachable") : `http-${outcome.status}`;
		return parkEvent(prepared, { collector, source, reason }) ? { ...outcome, spooled: true } : outcome;
	};
	try {
		// Env is read here, on every call, so a rotated URL or token applies
		// without restarting a long-running collector (D19-04). The default
		// bearer is the explicit option or the resolver for the event surface
		// (D20-05), so herdr posts each event under its own surface token.
		const base = baseUrl(opts.url);
		const token = opts.token !== undefined ? opts.token.trim() : (resolveBearer(event.surface, process.env) ?? "");
		if (spool !== null) prepared = prepareEvent(event, { collector, idempotencyKey: opts.idempotencyKey });
		const response = await fetch(`${base}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: prepared !== null ? prepared.body : JSON.stringify(event),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (response.status === 202) return { kind: "stored" };
		const error = await serverError(response);
		if (response.status >= 400 && response.status < 500) {
			recordRefusal({ event: prepared?.event ?? event, collector, source, status: response.status, error });
			return { kind: "refused", status: response.status, error };
		}
		return failed({ kind: "failed", status: response.status, error });
	} catch (cause) {
		// AbortSignal.timeout() rejects with a DOMException named TimeoutError;
		// anything else transport-shaped is an outage, without its details.
		const name = (cause as { name?: unknown } | null)?.name;
		return failed({ kind: "failed", error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable" });
	}
}

// --- replay -----------------------------------------------------------------

type Probe = { ok: true } | { ok: false; reason: string };

/** The parts of the server's `GET /healthz` body the replay gate reads. */
interface HealthBody {
	idempotency?: unknown;
	greptime?: unknown;
	eventsWritable?: unknown;
	ledger?: { writable?: unknown } | null;
}

const probeCache = new Map<string, { at: number; probe: Probe }>();
const heldLoggedAt = new Map<string, number>();

/** How many `/healthz` answers are cached (bounded at 16). Tests read it. */
export function spoolProbeCacheSize(): number {
	return probeCache.size;
}

/** Forget the cached `/healthz` answers and the held-reason rate limit. Tests call this; the collectors do not. */
export function resetSpoolReplayState(): void {
	probeCache.clear();
	heldLoggedAt.clear();
	warnedConfig.clear();
}

/**
 * Whether replaying is safe right now: `/healthz` must advertise `idempotency`
 * as `accept` or `enforce`. A server reporting `off`, an older server without
 * the field, an unreachable one or an unreadable answer all keep the spool.
 * `greptime: false` (the ledger is down), `eventsWritable: false` or
 * `ledger.writable: false` (reachable but refusing writes) and any non-200
 * answer also hold, so a long ledger outage does not burn attempts. The probe
 * sends a replay credential. GET /healthz stays open when no bearer is sent, so
 * an anonymous probe reads the body and the replay's own POST /events is what
 * refuses. A present bearer that names no surface is answered 401 or 403 before
 * the route; that is `healthz-auth` and is NEVER cached, so a corrected or
 * rotated token is tried at once. Every other answer is cached for
 * `PROBE_TTL_MS`, keyed by URL and a fingerprint of the credential (in memory
 * only, never logged or written).
 */
async function probeReplay(base: string, timeoutMs: number, bearer: string): Promise<Probe> {
	const cacheKey = `${base}|${credentialFingerprint(bearer)}`;
	const cached = probeCache.get(cacheKey);
	if (cached !== undefined && Date.now() - cached.at < PROBE_TTL_MS) return cached.probe;
	let probe: Probe;
	try {
		const response = await fetch(`${base}/healthz`, {
			headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (response.status === 401 || response.status === 403) {
			return { ok: false, reason: "healthz-auth" };
		}
		// A degraded server answers 503 with the same body; the body names the reason, so it is read first.
		const body = (await response.json()) as HealthBody | null;
		if (body?.idempotency !== "accept" && body?.idempotency !== "enforce") {
			probe = { ok: false, reason: body?.idempotency === "off" ? "idempotency-off" : "idempotency-not-advertised" };
		} else if (body.greptime === false) {
			probe = { ok: false, reason: "ledger-unavailable" };
		} else if (body.eventsWritable === false || body.ledger?.writable === false) {
			// Reachable but not taking writes (disk full, append mode unknown, failed write probe): every replay would
			// answer 503 and burn an attempt, so the spool waits instead.
			probe = { ok: false, reason: "ledger-not-writable" };
		} else if (!response.ok) {
			probe = { ok: false, reason: `healthz-${response.status}` };
		} else {
			probe = { ok: true };
		}
	} catch {
		probe = { ok: false, reason: "healthz-unreachable" };
	}
	if (probeCache.size >= 16) probeCache.clear();
	probeCache.set(cacheKey, { at: Date.now(), probe });
	return probe;
}

/** First 12 hex of sha256(bearer): tells credentials apart in memory without keeping or printing one. `anon` for none. */
function credentialFingerprint(bearer: string): string {
	return bearer === "" ? "anon" : createHash("sha256").update(bearer).digest("hex").slice(0, 12);
}

/** At most this many distinct credentials are tried for the capability probe in one pass. */
const MAX_PROBE_CREDENTIALS = 4;

/**
 * The capability is server-wide, so any VALID credential proves it. Tries the distinct credentials of the
 * replay-eligible entries (bounded), stops at the first answer that is not an authentication refusal, and holds
 * as `healthz-auth` only when every tried credential was refused.
 */
async function probeAny(base: string, timeoutMs: number, entries: readonly SpoolEntry[], token: string | undefined): Promise<Probe> {
	const tried = new Set<string>();
	for (const entry of entries) {
		const bearer = replayBearer(entry.event.surface, token);
		const fingerprint = credentialFingerprint(bearer);
		if (tried.has(fingerprint)) continue;
		if (tried.size >= MAX_PROBE_CREDENTIALS) break;
		tried.add(fingerprint);
		const probe = await probeReplay(base, timeoutMs, bearer);
		if (probe.ok || probe.reason !== "healthz-auth") return probe;
	}
	return { ok: false, reason: "healthz-auth" };
}

/**
 * The credential for a replay request: the explicit option, else the surface resolver for the entry's event
 * surface (the rule `replayEntry` has always used). The probe uses the same rule per entry, so the probe and
 * the replay are never judged by different credentials. Never logged.
 */
function replayBearer(surface: string, token: string | undefined): string {
	return token !== undefined ? token.trim() : (resolveBearer(surface, process.env) ?? "");
}

function logHeld(reason: string): void {
	const at = Date.now();
	const last = heldLoggedAt.get(reason);
	if (last !== undefined && at - last < HELD_LOG_INTERVAL_MS) return;
	heldLoggedAt.set(reason, at);
	stderrLine(`[collectors] event spool replay held: ${reason}; the spool is kept and retried later\n`);
}

/** Send one parked entry with the replay marker and the body it was first sent with. */
async function replayEntry(entry: SpoolEntry, base: string, timeoutMs: number, token: string | undefined, refusedCredentials: Set<string>): Promise<SpoolDelivery> {
	const bearer = replayBearer(entry.event.surface, token);
	const fingerprint = credentialFingerprint(bearer);
	// This pass already learned the credential is refused: no request, nothing consumed, on to the next surface.
	if (refusedCredentials.has(fingerprint)) return { kind: "skip", reason: "unauthorized" };
	try {
		const response = await fetch(`${base}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-substrate-replay": "1",
				...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
			},
			body: JSON.stringify({ ...entry.event, idempotency_key: entry.key }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (response.status === 202) return { kind: "delivered" };
		const error = await serverError(response);
		// No credentials in this process's environment is not a verdict on the event: keep it.
		// Per credential, not per pass: entries of other surfaces (other credentials) may still be deliverable.
		if (response.status === 401) {
			refusedCredentials.add(fingerprint);
			return { kind: "skip", reason: "unauthorized" };
		}
		// 403 is an attribution refusal: this process's token is not the one for the parked event's surface. The
		// process that parked it may well deliver it, so it stays untouched (the TTL bounds it) and the pass moves on.
		if (response.status === 403) {
			logHeld("forbidden for this credential; those entries are skipped");
			return { kind: "skip", reason: "forbidden" };
		}
		if (response.status >= 400 && response.status < 500) {
			recordRefusal({ event: entry.event, collector: entry.collector, source: entry.source, status: response.status, error });
			return { kind: "refused", status: response.status };
		}
		return { kind: "retry", reason: `http-${response.status}` };
	} catch (cause) {
		const name = (cause as { name?: unknown } | null)?.name;
		if (name === "TimeoutError" || name === "AbortError") return { kind: "retry", reason: "timeout" };
		// Connection refused and the like: the substrate is not there. Nothing is consumed.
		return { kind: "hold", reason: "unreachable" };
	}
}

export interface DrainOptions {
	/** Replay entries that are not yet due (`substrate spool flush`). */
	all?: boolean;
	/** Total time one pass may start new replays for. */
	budgetMs?: number;
	/** Per-request bound. */
	timeoutMs?: number;
	url?: string;
	token?: string;
}

export type DrainResult =
	| { status: "off" }
	/**
	 * `dropped` counts entries the pre-probe local sweep really removed (expired or out of attempts) before the
	 * hold. `failure` is present only when the spool file could not be read ("read") or the sweep's rewrite did
	 * not reach the disk ("write"); nothing was rewritten or removed in the first case. `remaining` is the depth
	 * on disk after the cleanup, or null when the file could not be read and no earlier snapshot or committed rewrite
	 * of this pass gives a trustworthy depth: an unknown depth is never reported as 0.
	 */
	| { status: "held"; reason: string; dropped: number; remaining: number | null; failure?: "read" | "write" }
	| ({ status: "ran" } & SpoolDrainReport);

const NOTHING_TO_DO: SpoolDrainReport = { delivered: 0, refused: 0, retried: 0, skipped: 0, dropped: 0, held: null, budgetExhausted: false, remaining: 0, readFailed: false, writeFailed: false, pendingUnsaved: false };
let draining: Promise<DrainResult> | null = null;

/** The depth on disk right now, or null when the file cannot be read (an unreadable spool is never "0 entries"). */
function currentDepth(spool: EventSpool): number | null {
	const stats = spool.stats();
	return stats.unreadable === null ? stats.depth : null;
}

/**
 * A fresh depth read with its failure kept: the earlier count stands in as the number when the read fails, but the
 * failure is never swallowed, so a caller reports it (`readFailed` / `failure: "read"`) and never treats the state as
 * confirmed.
 */
function freshDepth(spool: EventSpool, earlier: number): { depth: number; readFailed: boolean } {
	const fresh = currentDepth(spool);
	return fresh === null ? { depth: earlier, readFailed: true } : { depth: fresh, readFailed: false };
}

/**
 * The second chance for a failed cleanup. Folds a settle-only sweep into `report`: its drops and committed depth are
 * the newest word on the file, and `writeFailed` stays set only when something unsaved still needs it
 * (`pendingUnsaved`) or the sweep itself failed again.
 */
function settleAgain(spool: EventSpool, report: SpoolDrainReport): void {
	const again = spool.sweepSettled();
	report.dropped += again.dropped;
	// A committed rewrite is the newest word. Without one (another process may have cleaned the file since the depth in
	// `report` was read) the depth is read afresh; the earlier count stays only when that read fails too.
	let freshReadFailed = false;
	if (again.remaining !== null) {
		report.remaining = again.remaining;
	} else {
		const fresh = freshDepth(spool, report.remaining);
		report.remaining = fresh.depth;
		freshReadFailed = fresh.readFailed;
	}
	if (freshReadFailed) {
		// The state could not be read: it is reported, and a pending failure is not cleared on the strength of it.
		report.readFailed = true;
		report.writeFailed = report.writeFailed || again.failure === "write";
	} else if (again.failure === "read") {
		report.readFailed = true;
		report.writeFailed = report.pendingUnsaved;
	} else {
		report.writeFailed = again.failure === "write" || (report.writeFailed && report.pendingUnsaved);
	}
}

async function runDrain(spool: EventSpool, opts: DrainOptions): Promise<DrainResult> {
	const before = spool.stats();
	// An unreadable spool is not an empty one: say so, touch nothing.
	if (before.unreadable !== null) {
		logHeld("spool-unreadable");
		return { status: "held", reason: "spool-unreadable", dropped: 0, remaining: null, failure: "read" };
	}
	// Nothing parked, or nothing due: no probe and no request.
	if (before.depth === 0 || (opts.all !== true && before.due === 0)) return { status: "ran", ...NOTHING_TO_DO, remaining: before.depth };
	const base = baseUrl(opts.url);
	const timeoutMs = opts.timeoutMs ?? COLLECTOR_TIMEOUT_MS;
	// Expiry and attempt cleanup is local and does not depend on the server: it runs first, so an entry that
	// should be gone is never kept alive by a failed probe.
	const swept = spool.sweepSettled();
	if (swept.failure === "read") {
		logHeld("spool-unreadable");
		// The depth read at the start of this pass is the last trustworthy one: the sweep read nothing and wrote nothing.
		return { status: "held", reason: "spool-unreadable", dropped: 0, remaining: freshDepth(spool, before.depth).depth, failure: "read" };
	}
	const sweepWriteFailed = swept.failure === "write";
	const eligible = spool.eligible(opts.all === true);
	if (eligible === null) {
		logHeld("spool-unreadable");
		return { status: "held", reason: "spool-unreadable", dropped: swept.dropped, remaining: swept.remaining ?? freshDepth(spool, before.depth).depth, failure: "read" };
	}
	if (eligible.length === 0) {
		// No replay ran, so the only thing that can be outstanding is the failed cleanup, and it gets its second chance.
		const done: SpoolDrainReport = { ...NOTHING_TO_DO, dropped: swept.dropped, writeFailed: sweepWriteFailed, remaining: swept.remaining ?? before.depth };
		if (sweepWriteFailed) settleAgain(spool, done);
		let depth = done.remaining;
		if (swept.remaining === null && !sweepWriteFailed) {
			const fresh = freshDepth(spool, before.depth);
			depth = fresh.depth;
			if (fresh.readFailed) done.readFailed = true;
		}
		if (done.readFailed) {
			return { status: "held", reason: "spool-unreadable", dropped: done.dropped, remaining: depth, failure: "read" };
		}
		return { status: "ran", ...done, remaining: depth };
	}
	const probe = await probeAny(base, timeoutMs, eligible, opts.token);
	if (!probe.ok) {
		logHeld(probe.reason);
		// The failed cleanup gets its second chance here too: if this rewrite commits, its drops and depth are the truth.
		const again = sweepWriteFailed ? spool.sweepSettled() : null;
		let failure: "read" | "write" | undefined = again === null ? undefined : again.failure === "read" ? "read" : again.failure === "write" ? "write" : undefined;
		let remaining = again?.remaining ?? swept.remaining;
		if (remaining === null) {
			// No committed depth: read afresh, keep the earlier count if that fails, and report the failure either way.
			const fresh = freshDepth(spool, before.depth);
			remaining = fresh.depth;
			// An unreadable state is the stronger report: it outranks a write failure, which only says a rewrite did not land.
			if (fresh.readFailed) failure = "read";
		}
		return {
			status: "held",
			reason: probe.reason,
			dropped: swept.dropped + (again?.dropped ?? 0),
			remaining,
			...(failure !== undefined ? { failure } : {}),
		};
	}
	const refusedCredentials = new Set<string>();
	const report = await spool.drain((entry) => replayEntry(entry, base, timeoutMs, opts.token, refusedCredentials), {
		budgetMs: opts.budgetMs ?? DEFAULT_DRAIN_BUDGET_MS,
		...(opts.all === undefined ? {} : { all: opts.all }),
	});
	// Every entry the pass reached was refused for its credential: nothing was sent, nothing consumed.
	if (report.held === null && refusedCredentials.size > 0 && report.skipped > 0 && report.delivered + report.refused + report.retried === 0) {
		report.held = "unauthorized";
	}
	report.dropped += swept.dropped;
	// A failure is outstanding only while changes that need it are unsaved. A failed first sweep, or a failed
	// write-back whose pending changes were all removals of expired or exhausted entries, is redone by a settle-only
	// sweep, so ask again: the re-sweep is a no-op on a clean file, its drops are counted once (the failed rewrite
	// counted none), and a committed re-sweep clears the failure. Deliveries, refusals and retry deltas the write-back
	// could not save stay reported: those entries are still in the file as they were.
	if (sweepWriteFailed || (report.writeFailed && !report.pendingUnsaved)) {
		settleAgain(spool, report);
	}
	if (report.held !== null) logHeld(report.held);
	return { status: "ran", ...report };
}

/**
 * Replay parked events. One pass per process at a time (overlapping callers
 * share it), a no-op with the flag off (nothing on disk is opened), and never
 * throws. Long-running collectors call this on an `unref`'d tick; the CLI calls
 * it for `substrate spool flush`. Hooks never call it.
 */
export function drainEventSpool(opts: DrainOptions = {}): Promise<DrainResult> {
	if (draining !== null) return draining;
	const spool = eventSpool();
	if (spool === null) return Promise.resolve({ status: "off" });
	draining = runDrain(spool, opts)
		.catch((): DrainResult => ({ status: "held", reason: "error", dropped: 0, remaining: null }))
		.finally(() => {
			draining = null;
		});
	return draining;
}

/** How many entries each cause has dropped, read from the refused journal (and its rotated file). Event bodies are never read out. */
export function countSpoolDrops(dir: string = stateDir()): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const name of [`${REFUSED_FILE}.1`, REFUSED_FILE]) {
		let text: string;
		try {
			text = readFileSync(join(dir, name), "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.includes('"dropped"')) continue;
			try {
				const row = JSON.parse(line) as { kind?: unknown; error?: unknown };
				if (row.kind !== "dropped" || typeof row.error !== "string") continue;
				const match = /^spool-([a-z_]+)(?: more=(\d+))?/.exec(row.error);
				if (!match?.[1]) continue;
				counts[match[1]] = (counts[match[1]] ?? 0) + (match[2] === undefined ? 1 : Number(match[2]));
			} catch {
				// A torn line is not a count.
			}
		}
	}
	return counts;
}
