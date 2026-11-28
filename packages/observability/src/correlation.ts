/**
 * Correlation ids for the E5 observability loop (phase 86).
 *
 * One id threads the service plane calls into Timescale/Greptime/Dragonfly so
 * a slow hour can be attributed end to end. The alphabet is the graph-bind
 * alphabet (`service.ts`): 1..200 of `[A-Za-z0-9._:-]`. Anything else is
 * dropped, never echoed — that is the redaction rule: only the validated form
 * is emitted on `/healthz`, in logs, or on outgoing plane fetches. Raw header
 * values are untrusted caller input and are never repeated.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The header (and log field) that carries a correlation id. */
export const CORRELATION_HEADER = "x-correlation-id";

const CORRELATION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * Validate a caller-supplied correlation id. Returns the id unchanged when it
 * matches the alphabet, else null. Null in, null out.
 */
export function normalizeCorrelationId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return CORRELATION_ID_RE.test(value) ? value : null;
}

/**
 * The redacted form safe for bodies and logs: the validated id, or null when
 * there is nothing safe to emit. There is no truncation or masking step
 * because the alphabet carries no PII or secrets by construction; validation
 * IS the redaction.
 */
export function redactedCorrelation(value: unknown): string | null {
	return normalizeCorrelationId(value);
}

const storage = new AsyncLocalStorage<string>();

/** Run `fn` with `id` as the ambient correlation id. */
export function runWithCorrelation<T>(id: string, fn: () => T): T {
	return storage.run(id, fn);
}

/** The ambient correlation id, or null outside `runWithCorrelation`. */
export function currentCorrelation(): string | null {
	return storage.getStore() ?? null;
}

/**
 * A fetch `init` with the correlation id set as a header. Pure: the input is
 * never mutated; a null/invalid id returns the init unchanged.
 */
export function applyCorrelationHeader(
	init: RequestInit | undefined,
	correlationId: string | null | undefined,
): RequestInit | undefined {
	const id = correlationId == null ? null : normalizeCorrelationId(correlationId);
	if (id === null) return init;
	const headers = new Headers(init?.headers);
	headers.set(CORRELATION_HEADER, id);
	return { ...init, headers };
}

/** Read a correlation id off an incoming headers mapping (request or plane response). */
export function correlationFromHeaders(
	headers: Headers | Record<string, string | string[] | undefined> | undefined,
): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return normalizeCorrelationId(headers.get(CORRELATION_HEADER));
	const raw = headers[CORRELATION_HEADER] ?? headers[CORRELATION_HEADER.toLowerCase()];
	const first = Array.isArray(raw) ? raw[0] : raw;
	return normalizeCorrelationId(first ?? null);
}
