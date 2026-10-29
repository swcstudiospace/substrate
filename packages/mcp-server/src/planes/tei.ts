/**
 * The TEI (Hugging Face text-embeddings-inference) client (phase 64).
 *
 * Reached ONLY through substrate-mcp, like the other data planes: no package outside `mcp-server` imports this
 * module. Every call settles to a value that never rejects and never carries a secret: `{ ok: true, ... }` or
 * `{ ok: false, reason }` with a closed reason.
 *
 * Endpoint map (the operator's TEI instance is private; `TEI_URL` names it):
 * - `POST /embed` `{ inputs, normalize: true, truncate: true }` answers `number[][]`, one vector per input, in order.
 * - `GET /info` answers JSON with `model_id`, `max_input_length` and `max_client_batch_size` among others.
 * - `GET /health` answers 200 once the model is ready.
 * - `TEI_API_KEY`, when set, goes out as `Authorization: Bearer ...` and nowhere else.
 * A 413 or 422 is a permanent refusal of that input; 429 and 5xx are retried with bounded exponential backoff.
 *
 * Vectors of two models are not comparable, so this client refuses to return any when `/info` names a model other
 * than the pinned one (`SUBSTRATE_TEI_MODEL`) or when a vector's length differs from the pinned dimension
 * (`SUBSTRATE_TEI_DIM`). A pin left unset is learned from the first good answer and held for the life of the client.
 * The model is checked on the first call and again every {@link MODEL_RECHECK_MS}; the length on every response.
 * A refusal (`/info` named another model) stays in force until a later `/info` names the expected model again: while
 * it stands every call answers `model-mismatch`, a failed `/info` read included.
 *
 * The production caller hands in a `gatedFetch` over the plane's circuit breaker, so an open breaker answers
 * `breaker-open` without a request.
 */
import type { PlaneFetch } from "@substrate/observability";
import type { TeiConfig } from "../config.ts";

/** Why a call returned no vectors. Closed: the fabric and the callers switch on it. */
export const TEI_REASONS = [
	"not-configured",
	"breaker-open",
	"timeout",
	"unavailable",
	"bad-response",
	"model-mismatch",
	"dim-mismatch",
	"input-refused",
] as const;
export type TeiReason = (typeof TEI_REASONS)[number];

export type TeiEmbedResult =
	| { ok: true; vectors: Float32Array[]; model: string; dim: number }
	| { ok: false; reason: TeiReason };

/** The facts of `GET /info` the client uses. */
export interface TeiInfo {
	modelId: string;
	maxInputLength: number | null;
	maxClientBatchSize: number | null;
}

export type TeiInfoResult = { ok: true; info: TeiInfo } | { ok: false; reason: TeiReason };
export type TeiHealthResult = { ok: true; latencyMs: number } | { ok: false; reason: TeiReason };

/** Where the model the fabric reports came from. Closed. */
export const TEI_MODEL_SOURCES = ["pinned", "learned", "observed", "none"] as const;
export type TeiModelSource = (typeof TEI_MODEL_SOURCES)[number];

/** What the client has seen, for the fabric row. Names and numbers only. */
export interface TeiSnapshot {
	/** The pinned model, else the one learned from an embed answer; null before either. This is the model cache keys name. */
	model: string | null;
	/** The model `/info` last named, however it was read (a probe included); null before one. Never a cache key. */
	observedModel: string | null;
	/** Which of the pin, the learned model and the observed one the fabric shows: the first that is set, in that order. */
	modelSource: TeiModelSource;
	/** The pinned dimension, else the length of the last good vector; null before either. */
	dim: number | null;
	/** The round trip of the last successful request, ms; null before one. */
	lastLatencyMs: number | null;
}

export interface TeiEmbedOptions {
	/** Overrides the per-request timeout for this call, ms. */
	timeoutMs?: number;
}

export interface TeiClient {
	/** Whether `TEI_URL` is set. When false every call answers `not-configured` and sends nothing. */
	readonly configured: boolean;
	/** One vector per text, in order. Empty input is an empty success and sends nothing. */
	embed(texts: readonly string[], options?: TeiEmbedOptions): Promise<TeiEmbedResult>;
	/** `GET /info`, parsed. */
	info(timeoutMs?: number): Promise<TeiInfoResult>;
	/** `GET /health`; one attempt, no retry. */
	health(timeoutMs?: number): Promise<TeiHealthResult>;
	/**
	 * Health first, then info, one after the other inside one deadline (a half-open breaker admits one request at a time,
	 * so side by side the second would be refused), and the model against its pin: whether embedding can be relied on.
	 */
	probe(timeoutMs?: number): Promise<{ ok: true } | { ok: false; reason: TeiReason }>;
	snapshot(): TeiSnapshot;
}

export interface TeiDeps {
	/** Production passes a `gatedFetch` over the plane's breaker. */
	fetch?: PlaneFetch;
	sleep?: (ms: number) => Promise<void>;
	/** A monotonic-enough clock, ms. */
	now?: () => number;
	/** In [0, 1), for the backoff jitter. */
	random?: () => number;
}

/** Longest text sent, in UTF-16 code units; a longer one is cut at a character boundary. */
export const MAX_TEXT_CHARS = 32 * 1024;
/** Most texts one `embed` call takes; more is refused as `input-refused`. */
export const MAX_TEXTS_PER_CALL = 4096;
/** Attempts per request, the first included. */
export const MAX_ATTEMPTS = 4;
export const BACKOFF_BASE_MS = 250;
export const BACKOFF_CAP_MS = 4000;
/** How long a model check stays good before `/info` is read again, ms. */
export const MODEL_RECHECK_MS = 10 * 60 * 1000;

/** The bounded operation label for one TEI request: a fixed table, never the path. */
export function teiOp(_method: string, url: string): string {
	const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/\?.*$/, "");
	if (path === "/embed") return "embed";
	if (path === "/info") return "info";
	if (path === "/health") return "health";
	return "other";
}

/** `text`, cut to {@link MAX_TEXT_CHARS} without splitting a surrogate pair. */
export function clampText(text: string): string {
	if (text.length <= MAX_TEXT_CHARS) return text;
	let end = MAX_TEXT_CHARS;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return text.slice(0, end);
}

type Sent = { ok: true; body: unknown; latencyMs: number } | { ok: false; reason: TeiReason };

function errorName(cause: unknown): string {
	return cause instanceof Error ? cause.name : "";
}

function isTimeout(cause: unknown): boolean {
	const name = errorName(cause);
	return name === "TimeoutError" || name === "AbortError";
}

/** `Retry-After` in whole seconds, as ms; null when absent or not a plain number. */
function retryAfterMs(response: Response): number | null {
	const raw = response.headers.get("retry-after")?.trim() ?? "";
	if (!/^\d{1,4}$/.test(raw)) return null;
	return Number(raw) * 1000;
}

/** `GET /info`'s body as the facts the client uses, or null when it has no `model_id`. */
export function parseTeiInfo(body: unknown): TeiInfo | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
	const modelId: unknown = Reflect.get(body, "model_id");
	if (typeof modelId !== "string" || modelId === "") return null;
	const positive = (key: string): number | null => {
		const value: unknown = Reflect.get(body, key);
		return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
	};
	return { modelId, maxInputLength: positive("max_input_length"), maxClientBatchSize: positive("max_client_batch_size") };
}

/**
 * `POST /embed`'s body as one Float32Array per vector, or why it is not that. A wrong count, a non-array, a non-finite
 * number or an empty vector is `bad-response`; vectors of different lengths are `dim-mismatch`.
 */
export function parseVectors(body: unknown, expected: number): { ok: true; vectors: Float32Array[] } | { ok: false; reason: "bad-response" | "dim-mismatch" } {
	if (!Array.isArray(body) || body.length !== expected) return { ok: false, reason: "bad-response" };
	const vectors: Float32Array[] = [];
	for (const row of body) {
		if (!Array.isArray(row) || row.length === 0) return { ok: false, reason: "bad-response" };
		const vector = new Float32Array(row.length);
		for (let index = 0; index < row.length; index += 1) {
			const value: unknown = row[index];
			if (typeof value !== "number") return { ok: false, reason: "bad-response" };
			// Checked after the narrowing to Float32: 1e100 is finite as a double and Infinity as a float.
			const narrowed = Math.fround(value);
			if (!Number.isFinite(narrowed)) return { ok: false, reason: "bad-response" };
			vector[index] = narrowed;
		}
		vectors.push(vector);
	}
	const width = vectors[0]?.length;
	if (vectors.some((vector) => vector.length !== width)) return { ok: false, reason: "dim-mismatch" };
	return { ok: true, vectors };
}

/** Delay before retry number `attempt` (0-based): exponential, capped, with equal jitter. */
export function backoffMs(attempt: number, random: number): number {
	const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
	return Math.floor(ceiling / 2 + (ceiling / 2) * random);
}

/**
 * The client. With no config every call answers `not-configured` and sends nothing. Never rejects.
 */
export function createTeiClient(config: TeiConfig | null, deps: TeiDeps = {}): TeiClient {
	const fetchImpl: PlaneFetch = deps.fetch ?? fetch;
	const sleep =
		deps.sleep ??
		((ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		});
	const now = deps.now ?? Date.now;
	const random = deps.random ?? Math.random;

	let learnedModel: string | null = null;
	let learnedDim: number | null = null;
	let batchLimit: number | null = null;
	let modelCheckedAt: number | null = null;
	let lastLatencyMs: number | null = null;
	/** The model `/info` last named, for the fabric row only; never a cache key and never a pin. */
	let observedModel: string | null = null;
	/** Set when a read named a model other than the expected one; cleared only by a read that names the expected one. */
	let modelRefused = false;
	let verifying: Promise<{ ok: true } | { ok: false; reason: TeiReason }> | null = null;

	const expectedModel = (): string | null => config?.model ?? learnedModel;
	const expectedDim = (): number | null => config?.dim ?? learnedDim;

	/** One request with the retry loop: 429 and 5xx and a transport error retry, everything else answers at once. */
	async function send(method: "GET" | "POST", path: string, body: unknown, retry: boolean, timeoutMs: number): Promise<Sent> {
		if (config === null) return { ok: false, reason: "not-configured" };
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (config.apiKey !== undefined) headers.authorization = `Bearer ${config.apiKey}`;
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const attempts = retry ? MAX_ATTEMPTS : 1;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const started = now();
			let wait = backoffMs(attempt, random());
			let response: Response;
			try {
				response = await fetchImpl(`${config.url}${path}`, {
					method,
					headers,
					...(payload === undefined ? {} : { body: payload }),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (cause) {
				if (errorName(cause) === "BreakerOpenError") return { ok: false, reason: "breaker-open" };
				// A wedged server is not asked again: a retry would only spend another full timeout.
				if (isTimeout(cause)) return { ok: false, reason: "timeout" };
				if (attempt + 1 < attempts) {
					await sleep(wait);
					continue;
				}
				return { ok: false, reason: "unavailable" };
			}
			const status = response.status;
			if (status >= 200 && status < 300) {
				try {
					const parsed: unknown = await response.json();
					const latencyMs = Math.max(0, now() - started);
					lastLatencyMs = latencyMs;
					return { ok: true, body: parsed, latencyMs };
				} catch (cause) {
					return { ok: false, reason: isTimeout(cause) ? "timeout" : "bad-response" };
				}
			}
			if (status === 413 || status === 422) return { ok: false, reason: "input-refused" };
			if (status === 429 || status >= 500) {
				if (attempt + 1 < attempts) {
					const asked = retryAfterMs(response);
					if (asked !== null) wait = Math.min(BACKOFF_CAP_MS, Math.max(wait, asked));
					await sleep(wait);
					continue;
				}
				return { ok: false, reason: "unavailable" };
			}
			return { ok: false, reason: status === 400 ? "bad-response" : "unavailable" };
		}
		return { ok: false, reason: "unavailable" };
	}

	async function readInfo(timeoutMs: number, retry: boolean): Promise<TeiInfoResult> {
		if (config === null) return { ok: false, reason: "not-configured" };
		const sent = await send("GET", "/info", undefined, retry, timeoutMs);
		if (!sent.ok) return sent;
		const parsed = parseTeiInfo(sent.body);
		if (parsed === null) return { ok: false, reason: "bad-response" };
		observedModel = parsed.modelId;
		return { ok: true, info: parsed };
	}

	const info = (timeoutMs: number = config?.timeoutMs ?? 0): Promise<TeiInfoResult> => readInfo(timeoutMs, true);

	async function health(timeoutMs: number = config?.timeoutMs ?? 0): Promise<TeiHealthResult> {
		if (config === null) return { ok: false, reason: "not-configured" };
		const started = now();
		const sent = await sendHealth(timeoutMs);
		if (!sent.ok) return sent;
		const latencyMs = Math.max(0, now() - started);
		lastLatencyMs = latencyMs;
		return { ok: true, latencyMs };
	}

	/** `/health` answers 200 with an empty body, so it is not read as JSON. */
	async function sendHealth(timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: TeiReason }> {
		if (config === null) return { ok: false, reason: "not-configured" };
		const headers: Record<string, string> = {};
		if (config.apiKey !== undefined) headers.authorization = `Bearer ${config.apiKey}`;
		let response: Response;
		try {
			response = await fetchImpl(`${config.url}/health`, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
		} catch (cause) {
			if (errorName(cause) === "BreakerOpenError") return { ok: false, reason: "breaker-open" };
			return { ok: false, reason: isTimeout(cause) ? "timeout" : "unavailable" };
		}
		return response.status >= 200 && response.status < 300 ? { ok: true } : { ok: false, reason: "unavailable" };
	}

	/**
	 * Reads `/info` and applies the model pin. Learns the model and the batch limit the first time. A refusal is
	 * remembered and answered until a read names the expected model again, so a failed read cannot lift it.
	 */
	async function verifyModel(timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: TeiReason }> {
		const first = modelCheckedAt === null;
		if (!first && !modelRefused && now() - (modelCheckedAt ?? 0) < MODEL_RECHECK_MS) return { ok: true };
		const read = await readInfo(timeoutMs, true);
		if (!read.ok) {
			if (modelRefused) return { ok: false, reason: "model-mismatch" };
			// A model verified before keeps its verdict through a failed recheck; the next call asks again.
			return first ? read : { ok: true };
		}
		const wanted = expectedModel();
		if (wanted !== null && read.info.modelId !== wanted) {
			modelRefused = true;
			return { ok: false, reason: "model-mismatch" };
		}
		modelRefused = false;
		learnedModel ??= read.info.modelId;
		batchLimit ??= read.info.maxClientBatchSize;
		modelCheckedAt = now();
		return { ok: true };
	}

	function ensureVerified(timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: TeiReason }> {
		verifying ??= verifyModel(timeoutMs).finally(() => {
			verifying = null;
		});
		return verifying;
	}

	async function embed(texts: readonly string[], options: TeiEmbedOptions = {}): Promise<TeiEmbedResult> {
		if (config === null) return { ok: false, reason: "not-configured" };
		if (texts.length > MAX_TEXTS_PER_CALL) return { ok: false, reason: "input-refused" };
		if (texts.length === 0) return { ok: true, vectors: [], model: expectedModel() ?? "", dim: expectedDim() ?? 0 };
		// One timeout for every request of the call, the model check's included.
		const timeoutMs = options.timeoutMs ?? config.timeoutMs;
		const verified = await ensureVerified(timeoutMs);
		if (!verified.ok) return verified;
		const model = expectedModel();
		if (model === null) return { ok: false, reason: "bad-response" };
		const size = Math.max(1, Math.min(config.batch, batchLimit ?? config.batch));
		const vectors: Float32Array[] = [];
		for (let from = 0; from < texts.length; from += size) {
			const inputs = texts.slice(from, from + size).map(clampText);
			const sent = await send("POST", "/embed", { inputs, normalize: true, truncate: true }, true, timeoutMs);
			if (!sent.ok) return sent;
			const parsed = parseVectors(sent.body, inputs.length);
			if (!parsed.ok) return parsed;
			const width = parsed.vectors[0]?.length ?? 0;
			const pinned = expectedDim();
			if (pinned !== null && width !== pinned) return { ok: false, reason: "dim-mismatch" };
			learnedDim ??= width;
			vectors.push(...parsed.vectors);
		}
		return { ok: true, vectors, model, dim: expectedDim() ?? vectors[0]?.length ?? 0 };
	}

	/**
	 * `/health` then `/info`, one try each and no retry, one after the other inside one deadline. Side by side the second
	 * request is refused by a half-open breaker (it admits one), so a recovered TEI would read as down.
	 */
	async function probe(timeoutMs: number = config?.timeoutMs ?? 0): Promise<{ ok: true } | { ok: false; reason: TeiReason }> {
		if (config === null) return { ok: false, reason: "not-configured" };
		const started = now();
		const live = await sendHealth(timeoutMs);
		if (!live.ok) return live;
		const left = timeoutMs - Math.max(0, now() - started);
		if (left <= 0) return { ok: false, reason: "timeout" };
		const read = await readInfo(Math.ceil(left), false);
		if (!read.ok) return read;
		const wanted = expectedModel();
		if (wanted !== null && read.info.modelId !== wanted) return { ok: false, reason: "model-mismatch" };
		return { ok: true };
	}

	function snapshot(): TeiSnapshot {
		const pinned = config?.model ?? null;
		const source: TeiModelSource = pinned !== null ? "pinned" : learnedModel !== null ? "learned" : observedModel !== null ? "observed" : "none";
		return { model: expectedModel(), observedModel, modelSource: source, dim: expectedDim(), lastLatencyMs };
	}

	return {
		embed,
		info,
		health,
		configured: config !== null,
		probe,
		snapshot,
	};
}
