/**
 * Shared fail-open emit client for every Phase 19 collector and hook.
 *
 * One convention (D19-04): `SUBSTRATE_URL` (default `http://127.0.0.1:7410`)
 * and `SUBSTRATE_TOKEN` as a bearer token when set, both read at call time so
 * tests and long-running collectors never pin a stale value. Timeouts are 3 s
 * in long-running collectors and at most 1.5 s in hooks (D19-06); the caller
 * passes its bound, this module never waits past it.
 *
 * Outcomes (D19-04): 202 is `stored`, any 4xx is `refused`, and 5xx, network
 * errors or timeouts are `failed`. `postEvent` never throws: during an outage
 * events are dropped and counted as `failed` with no spool or retry queue.
 *
 * Refusals are visible (D19-05): `recordRefusal` appends one JSON line holding
 * exactly `ts`, `collector`, `source`, `kind`, `surface`, `status` and `error`
 * to `${SUBSTRATE_STATE_DIR:-/var/lib/substrate}/refused-emits.jsonl` — never
 * the event's summary or payload, with the server's error through `redact()`
 * and truncated to 200 chars — plus one stderr line for the journal.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../../mcp-server/src/redact.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";

/** Long-running collectors wait this long for one emit (D19-06). */
export const COLLECTOR_TIMEOUT_MS = 3000;
/** Hooks never wait past this (D19-06). */
export const HOOK_TIMEOUT_MS = 1500;

const DEFAULT_URL = "http://127.0.0.1:7410";
const DEFAULT_STATE_DIR = "/var/lib/substrate";
const REFUSED_FILE = "refused-emits.jsonl";
const MAX_ERROR_CHARS = 200;

/** The state-file key long-running collectors count outcomes under. */
export const COUNTERS_KEY = "counters";

export type EmitOutcome =
	| { kind: "stored" }
	| { kind: "refused"; status: number; error?: string }
	| { kind: "failed"; status?: number; error?: string };

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

export interface RefusalInput {
	event: EventInput;
	collector: string;
	source: string;
	status: number;
	error?: string;
}

/**
 * One refused emit, where the operator can see it: a single small O_APPEND
 * line plus one stderr line. Never throws; a refusal the module cannot record
 * is still a refusal the journal shows.
 */
export function recordRefusal(input: RefusalInput): void {
	const safeError = redact(input.error ?? `http ${input.status}`).slice(0, MAX_ERROR_CHARS);
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		collector: input.collector,
		source: input.source,
		kind: input.event.kind,
		surface: input.event.surface,
		status: input.status,
		error: safeError,
	});
	try {
		const dir = process.env.SUBSTRATE_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			// A read-only state dir still gets the journal line below.
		}
		appendFileSync(join(dir, REFUSED_FILE), `${line}\n`);
	} catch {
		// The refusal counts even when the file is unwritable.
	}
	try {
		process.stderr.write(
			`[collectors] refused emit collector=${input.collector} source=${input.source} status=${input.status} error=${safeError}\n`,
		);
	} catch {
		// Never throw from a reporting path.
	}
}

async function serverError(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as { error?: unknown };
		return typeof body.error === "string" ? body.error : undefined;
	} catch {
		return undefined;
	}
}

/**
 * POST one event. Never throws and never waits past `timeoutMs`: 202 is
 * stored, 4xx is refused (and recorded), everything else — 5xx, a network
 * error, a timeout — is failed.
 */
export async function postEvent(event: EventInput, opts: PostEventOptions = {}): Promise<EmitOutcome> {
	const timeoutMs = opts.timeoutMs ?? COLLECTOR_TIMEOUT_MS;
	const collector = opts.collector ?? "unknown";
	const source = opts.source ?? collector;
	try {
		// Env is read here, on every call, so a rotated URL or token applies
		// without restarting a long-running collector (D19-04).
		const rawBase = opts.url ?? process.env.SUBSTRATE_URL?.trim() ?? "";
		const base = (rawBase || DEFAULT_URL).replace(/\/+$/, "");
		const token = opts.token !== undefined ? opts.token.trim() : (process.env.SUBSTRATE_TOKEN?.trim() ?? "");
		const response = await fetch(`${base}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (response.status === 202) return { kind: "stored" };
		const error = await serverError(response);
		if (response.status >= 400 && response.status < 500) {
			recordRefusal({ event, collector, source, status: response.status, error });
			return { kind: "refused", status: response.status, error };
		}
		return { kind: "failed", status: response.status, error };
	} catch (cause) {
		// AbortSignal.timeout() rejects with a DOMException named TimeoutError;
		// anything else transport-shaped is an outage, without its details.
		const name = (cause as { name?: unknown } | null)?.name;
		return { kind: "failed", error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable" };
	}
}
