/**
 * The Hindsight HTTP client, reached ONLY through substrate-mcp (D26-01).
 *
 * No agent config registers a Hindsight MCP server and no package outside
 * `mcp-server` imports this module; `store-lock.test.ts` enforces both.
 * Recall fans out over explicit `sub-*` banks, never a shared fallback bank:
 * the single-`HINDSIGHT_BANK` shape of the acc30a8 stub is forbidden, and the
 * recording fake in `hindsight-fake.ts` fails any recall missing the bank
 * path segment and any retain missing `document_id`.
 *
 * Ported from the ultrathink `src/hindsight/client.ts` surface (tested against
 * Hindsight 0.9.1): the bank URL shape, unauthenticated `GET /health` +
 * `GET /version`, `GET {bank}/config` 404-create-then-`PATCH
 * retain_extraction_mode: "chunks"`, retain upsert items, recall bodies,
 * document GET/DELETE/PATCH, `Result` returns that never reject, and
 * FastAPI array-`detail` never shown. The RESP client, the single-bank shape
 * and recall inside the brief are deliberately not ported.
 *
 * Every call goes out through the `fetchImpl` the caller injects; production
 * hands in a `gatedFetch` over the plane's circuit breaker (uplift-2 R2), and
 * `hindsightOp` is the bounded label that fetch records per route. An open
 * breaker surfaces here as a `network` error whose message says `circuit open`,
 * so every fail-open caller degrades exactly as it does for an unreachable plane.
 */
export interface HindsightConfig {
	url: string;
	apiKey: string;
	/** Bank name prefix; `sub-` names the substrate surfaces' banks (D26-03). */
	bankPrefix: string;
}

/**
 * The bounded operation label for one Hindsight request, from its method and
 * path. A fixed table, never the path itself: bank and document ids would
 * otherwise become metric series.
 */
export function hindsightOp(method: string, url: string): string {
	const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/\?.*$/, "");
	if (path === "/health") return "health";
	if (path === "/version") return "version";
	if (/\/memories\/recall$/.test(path)) return "recall";
	if (/\/memories$/.test(path)) return "retain";
	if (/\/documents\/[^/]+$/.test(path)) return "document";
	if (/\/banks\/[^/]+\/config$/.test(path)) return "bank-config";
	if (/\/banks$/.test(path)) return "bank-list";
	if (/\/banks\/[^/]+\/stats$/.test(path)) return "bank-stats";
	if (/\/banks\/[^/]+$/.test(path)) return method === "DELETE" ? "bank-delete" : "bank-create";
	return "other";
}

/**
 * The substrate's Hindsight reach, or null when it has none.
 *
 * Reads `HINDSIGHT_URL` / `HINDSIGHT_API_KEY` (and the routing-only
 * `HINDSIGHT_BANK_PREFIX` / `HINDSIGHT_BANKS`) here and nowhere else (D26-02).
 * The desk gateway holds its own copies of the URL and key for its own paths;
 * agent-facing recall and retain through the substrate never touch them.
 */
export function hindsightFromEnv(env: Record<string, string | undefined> = process.env): HindsightConfig | null {
	const url = env.HINDSIGHT_URL?.trim();
	const apiKey = env.HINDSIGHT_API_KEY?.trim();
	if (!url || !apiKey) return null;
	const prefix = env.HINDSIGHT_BANK_PREFIX?.trim() || "sub-";
	return { url: url.replace(/\/+$/, ""), apiKey, bankPrefix: prefix };
}

/**
 * The explicit recall fan-out set (D26-03): the `sub-*` banks recall queries
 * beyond the caller's own. Comma- or whitespace-separated, so an operator can
 * wrap the line in the env file. Null when unset — recall then reads the
 * caller's bank only. Names outside the bank prefix (notably the desk's
 * `pd-*` banks) are dropped: the substrate never names them, so a list
 * copied from the desk configuration cannot leak across the boundary.
 */
export function hindsightBanksFromEnv(env: Record<string, string | undefined> = process.env): string[] | null {
	const raw = env.HINDSIGHT_BANKS?.trim();
	if (!raw) return null;
	const prefix = env.HINDSIGHT_BANK_PREFIX?.trim() || "sub-";
	const banks = raw
		.split(/[\s,]+/)
		.map((bank) => bank.trim())
		.filter((bank) => bank.length > 0 && bank.startsWith(prefix));
	return banks.length > 0 ? banks : null;
}

/** The writer's bank on retain: `HINDSIGHT_BANK_PREFIX + surface` (D26-03). */
export function bankForSurface(config: HindsightConfig, surface: string): string {
	return `${config.bankPrefix}${surface}`;
}

/** The most results one bank contributes to a recall (D26-05). */
export const MAX_RECALL_PER_BANK = 4;

/** Recall types the ultrathink client tested (D26-05). */
export const DEFAULT_RECALL_TYPES: readonly string[] = ["world", "experience", "observation"];

/**
 * A fresh string-keyed record from an unknown object value; anything else is
 * an empty record. Plane metadata and feature maps cross as JSON, so the
 * reply carries a copy it owns rather than an alias of the parsed body.
 */
function recordOf(value: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (value !== null && typeof value === "object") {
		for (const [key, entry] of Object.entries(value)) out[key] = entry;
	}
	return out;
}

/** The fetch surface the plane client needs: injectable for rehearsal fakes. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type HindsightErrorKind =
	| "auth"
	| "not-found"
	| "bad-request"
	| "rate-limit"
	| "server"
	| "timeout"
	| "network"
	| "invalid-response";

export interface HindsightError {
	kind: HindsightErrorKind;
	/** Safe to log and to return: never carries the bearer, never an array-detail. */
	message: string;
	status?: number;
}

export type HindsightResult<T> = { ok: true; value: T } | { ok: false; error: HindsightError };

function fail<T>(kind: HindsightErrorKind, message: string, status?: number): HindsightResult<T> {
	return status === undefined ? { ok: false, error: { kind, message } } : { ok: false, error: { kind, message, status } };
}

/** Classify an HTTP status the way the ultrathink client does. */
function statusKind(status: number): HindsightErrorKind {
	if (status === 401 || status === 403) return "auth";
	if (status === 404) return "not-found";
	if (status === 429) return "rate-limit";
	if (status >= 400 && status < 500) return "bad-request";
	return "server";
}

/**
 * A FastAPI error body is `{detail: string | string[]}`. A plain-string
 * detail is safe to repeat; an array-valued one is server validation output
 * and is never shown — only the status travels.
 */
function errorMessage(action: string, status: number, body: unknown): string {
	if (body !== null && typeof body === "object" && "detail" in body && typeof body.detail === "string" && body.detail.length > 0) {
		return `hindsight ${action}: ${body.detail.slice(0, 200)}`;
	}
	return `hindsight ${action}: http ${status}`;
}

async function readJson(response: Response): Promise<{ ok: true; body: unknown } | { ok: false }> {
	try {
		return { ok: true, body: await response.json() };
	} catch {
		return { ok: false };
	}
}

function transportError(action: string, cause: unknown): HindsightError {
	if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
		return { kind: "timeout", message: `hindsight ${action}: timed out` };
	}
	// The plane's breaker refused before anything went out: unreachable by
	// decision rather than by socket, and worded so a degraded reply says why.
	if (cause instanceof Error && cause.name === "BreakerOpenError") {
		return { kind: "network", message: `hindsight ${action}: circuit open` };
	}
	const message = cause instanceof Error ? cause.message : String(cause);
	return { kind: "network", message: `hindsight ${action}: unreachable (${message.slice(0, 120)})` };
}

async function get(
	config: HindsightConfig,
	path: string,
	options: { authed: boolean; fetchImpl: FetchLike; timeoutMs: number; signal?: AbortSignal },
): Promise<HindsightResult<{ status: number; body: unknown }>> {
	let response: Response;
	try {
		response = await options.fetchImpl(`${config.url}${path}`, {
			method: "GET",
			...(options.authed ? { headers: { authorization: `Bearer ${config.apiKey}` } } : {}),
			// A shared fan-out budget signal wins; otherwise one request timeout.
			signal: options.signal ?? AbortSignal.timeout(options.timeoutMs),
		});
	} catch (cause) {
		return { ok: false, error: transportError(`GET ${path}`, cause) };
	}
	const parsed = await readJson(response);
	if (!parsed.ok) return fail("invalid-response", `hindsight GET ${path}: response was not JSON`, response.status);
	return { ok: true, value: { status: response.status, body: parsed.body } };
}

export async function send(
	config: HindsightConfig,
	method: string,
	path: string,
	body: unknown,
	options: { fetchImpl: FetchLike; timeoutMs: number; signal?: AbortSignal },
): Promise<HindsightResult<{ status: number; body: unknown }>> {
	let response: Response;
	try {
		response = await options.fetchImpl(`${config.url}${path}`, {
			method,
			headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			// A shared fan-out budget signal wins; otherwise one request timeout.
			signal: options.signal ?? AbortSignal.timeout(options.timeoutMs),
		});
	} catch (cause) {
		return { ok: false, error: transportError(`${method} ${path}`, cause) };
	}
	// A bodyless success (DELETE answers 204 with no body) is not a shape
	// failure: there is nothing to parse, and the status already says it all.
	if (response.status === 204) return { ok: true, value: { status: response.status, body: {} } };
	const parsed = await readJson(response);
	if (!parsed.ok) return fail("invalid-response", `hindsight ${method} ${path}: response was not JSON`, response.status);
	return { ok: true, value: { status: response.status, body: parsed.body } };
}

export interface HindsightHealth {
	status: string;
	database: string;
}

/** Unauthenticated liveness probe (G1 records the deployment shape). */
export async function probeHealth(
	config: HindsightConfig,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<HindsightResult<HindsightHealth>> {
	const got = await get(config, "/health", { authed: false, fetchImpl, timeoutMs });
	if (!got.ok) return got;
	const { status, body } = got.value;
	if (status !== 200 || body === null || typeof body !== "object") {
		return fail("invalid-response", "hindsight GET /health: unexpected response shape", status);
	}
	return {
		ok: true,
		value: {
			status: "status" in body && typeof body.status === "string" ? body.status : "unknown",
			database: "database" in body && typeof body.database === "string" ? body.database : "unknown",
		},
	};
}

export interface HindsightVersion {
	api_version: string;
	features: Record<string, unknown>;
}

/** Unauthenticated version probe: full and minimal shapes both parse (U-01). */
export async function probeVersion(
	config: HindsightConfig,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<HindsightResult<HindsightVersion>> {
	const got = await get(config, "/version", { authed: false, fetchImpl, timeoutMs });
	if (!got.ok) return got;
	const { status, body } = got.value;
	if (status !== 200 || body === null || typeof body !== "object") {
		return fail("invalid-response", "hindsight GET /version: unexpected response shape", status);
	}
	return {
		ok: true,
		value: {
			api_version: "api_version" in body && typeof body.api_version === "string" ? body.api_version : "unknown",
			features: "features" in body ? recordOf(body.features) : {},
		},
	};
}

function bankConfigPath(bank: string): string {
	return `/v1/default/banks/${encodeURIComponent(bank)}/config`;
}

function bankPath(bank: string): string {
	return `/v1/default/banks/${encodeURIComponent(bank)}`;
}

/**
 * Banks this process already ensured. Only a success stays cached, so a
 * failure retries on the next call — and a restart re-ensures everything.
 */
const ensuredBanks = new Set<string>();

/** Test seam: forget every ensured bank. */
export function clearEnsuredBanks(): void {
	ensuredBanks.clear();
}

/**
 * Forget one ensured bank, so the next retain re-runs `ensureBank`. Called
 * when a retain answers 404 (uplift-2 R3): the bank this process pinned was
 * deleted or renamed out of band, and a cached "ensured" would 404 forever.
 */
export function forgetEnsuredBank(config: HindsightConfig, bank: string): void {
	ensuredBanks.delete(`${config.url} ${bank}`);
}

function extractionMode(body: unknown): string | null {
	if (body === null || typeof body !== "object" || !("config" in body)) return null;
	const nested = body.config;
	if (nested === null || typeof nested !== "object" || !("retain_extraction_mode" in nested)) return null;
	return typeof nested.retain_extraction_mode === "string" ? nested.retain_extraction_mode : null;
}

/**
 * Create-on-404 then `PATCH retain_extraction_mode: "chunks"`, so the bank
 * stores accepted text as-is with no server-side LLM rewrite (D26-04). A
 * bank already in `chunks` mode costs one GET.
 */
export async function ensureBank(
	config: HindsightConfig,
	bank: string,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<HindsightResult<{ created: boolean }>> {
	if (ensuredBanks.has(`${config.url} ${bank}`)) return { ok: true, value: { created: false } };
	const options = { fetchImpl, timeoutMs };
	const current = await get(config, bankConfigPath(bank), { authed: true, ...options });
	if (!current.ok) return current;
	if (current.value.status === 404) {
		const created = await send(config, "PUT", bankPath(bank), {}, options);
		if (!created.ok) return created;
		if (created.value.status !== 200 && created.value.status !== 201) {
			return fail(statusKind(created.value.status), errorMessage(`PUT ${bankPath(bank)}`, created.value.status, created.value.body), created.value.status);
		}
		const patched = await send(config, "PATCH", bankConfigPath(bank), { updates: { retain_extraction_mode: "chunks" } }, options);
		if (!patched.ok) return patched;
		if (patched.value.status !== 200) {
			return fail(
				statusKind(patched.value.status),
				errorMessage(`PATCH ${bankConfigPath(bank)}`, patched.value.status, patched.value.body),
				patched.value.status,
			);
		}
		ensuredBanks.add(`${config.url} ${bank}`);
		return { ok: true, value: { created: true } };
	}
	if (current.value.status !== 200) {
		return fail(
			statusKind(current.value.status),
			errorMessage(`GET ${bankConfigPath(bank)}`, current.value.status, current.value.body),
			current.value.status,
		);
	}
	if (extractionMode(current.value.body) === "chunks") {
		ensuredBanks.add(`${config.url} ${bank}`);
		return { ok: true, value: { created: false } };
	}
	const patched = await send(config, "PATCH", bankConfigPath(bank), { updates: { retain_extraction_mode: "chunks" } }, options);
	if (!patched.ok) return patched;
	if (patched.value.status !== 200) {
		return fail(
			statusKind(patched.value.status),
			errorMessage(`PATCH ${bankConfigPath(bank)}`, patched.value.status, patched.value.body),
			patched.value.status,
		);
	}
	ensuredBanks.add(`${config.url} ${bank}`);
	// The bank pre-existed (it answered the config GET): pinning its mode is
	// not creating it, and the G2 rollback must only delete probe-created banks.
	return { ok: true, value: { created: false } };
}

/** What one bank looks like in `GET /v1/default/banks` (uplift-4 S5): only the fields the inventory reads, each null when absent or mistyped. */
export interface HindsightBankSummary {
	bank_id: string;
	fact_count: number | null;
	last_write_at: string | null;
}

/** The inventory's page size, bank ceiling and the longest bank id kept (an upstream id is never trusted to be short). */
export const BANK_LIST_PAGE = 50;
export const MAX_LISTED_BANKS = 200;
/** Requests one listing may make, whatever page size the server honours. */
export const MAX_LIST_PAGES = 40;
const MAX_BANK_ID_CHARS = 200;

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function textOrNull(value: unknown, max: number): string | null {
	return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

/**
 * `GET /v1/default/banks`, read-only (uplift-4 S5): the banks the deployment
 * holds, in bounded pages (`BANK_LIST_PAGE` per request, at most
 * `MAX_LISTED_BANKS` banks in all; `truncated` says the list went past that).
 * Every page shares the caller's `signal` or its own `timeoutMs`. The first
 * failing page fails the listing: a partial list would read as "bank missing".
 */
export async function listBanks(
	config: HindsightConfig,
	fetchImpl: FetchLike = fetch,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HindsightResult<{ banks: HindsightBankSummary[]; truncated: boolean }>> {
	const banks: HindsightBankSummary[] = [];
	let offset = 0;
	let truncated = false;
	let pages = 0;
	while (true) {
		const path = `/v1/default/banks?limit=${BANK_LIST_PAGE}&offset=${offset}`;
		const got = await get(config, path, {
			authed: true,
			fetchImpl,
			timeoutMs: options.timeoutMs ?? 4000,
			...(options.signal !== undefined ? { signal: options.signal } : {}),
		});
		if (!got.ok) return got;
		if (got.value.status !== 200) {
			return fail(statusKind(got.value.status), errorMessage("GET /v1/default/banks", got.value.status, got.value.body), got.value.status);
		}
		const body = got.value.body;
		if (body === null || typeof body !== "object" || !("banks" in body) || !Array.isArray(body.banks)) {
			return fail("invalid-response", "hindsight GET /v1/default/banks: response had no banks array", got.value.status);
		}
		const total = "total" in body ? numberOrNull(body.total) : null;
		for (const entry of body.banks) {
			if (entry === null || typeof entry !== "object" || !("bank_id" in entry)) continue;
			const id = textOrNull(entry.bank_id, MAX_BANK_ID_CHARS);
			if (id === null) continue;
			if (banks.length >= MAX_LISTED_BANKS) {
				truncated = true;
				break;
			}
			banks.push({
				bank_id: id,
				fact_count: "fact_count" in entry ? numberOrNull(entry.fact_count) : null,
				last_write_at: "last_write_at" in entry ? textOrNull(entry.last_write_at, 64) : null,
			});
		}
		offset += body.banks.length;
		// A server may cap a page below the 50 asked for, so a short page is the end only when the reply
		// states no total; with a total the end is the offset reaching it, or an empty page.
		const done = body.banks.length === 0 || (total !== null ? offset >= total : body.banks.length < BANK_LIST_PAGE);
		if (truncated || done) break;
		pages += 1;
		if (pages >= MAX_LIST_PAGES) {
			// Bounded however the server pages: a list this long is cut and said to be.
			truncated = true;
			break;
		}
		if (banks.length >= MAX_LISTED_BANKS) {
			// Exactly at the ceiling with more pages upstream: say so rather than read one more page to find out.
			truncated = total === null || offset < total;
			break;
		}
	}
	return { ok: true, value: { banks, truncated } };
}

/** `GET {bank}/stats`, read-only: the operation backlog and the last write the bank saw (each null when absent). */
export interface HindsightBankStats {
	pending_operations: number | null;
	failed_operations: number | null;
	last_write_at: string | null;
}

export async function bankStats(
	config: HindsightConfig,
	bank: string,
	fetchImpl: FetchLike = fetch,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HindsightResult<HindsightBankStats>> {
	const path = `${bankPath(bank)}/stats`;
	const got = await get(config, path, {
		authed: true,
		fetchImpl,
		timeoutMs: options.timeoutMs ?? 4000,
		...(options.signal !== undefined ? { signal: options.signal } : {}),
	});
	if (!got.ok) return got;
	if (got.value.status !== 200) {
		return fail(statusKind(got.value.status), errorMessage(`GET ${path}`, got.value.status, got.value.body), got.value.status);
	}
	const body = got.value.body;
	if (body === null || typeof body !== "object") {
		return fail("invalid-response", `hindsight GET ${path}: unexpected response shape`, got.value.status);
	}
	return {
		ok: true,
		value: {
			pending_operations: "pending_operations" in body ? numberOrNull(body.pending_operations) : null,
			failed_operations: "failed_operations" in body ? numberOrNull(body.failed_operations) : null,
			last_write_at: "last_memory_write_at" in body ? textOrNull(body.last_memory_write_at, 64) : null,
		},
	};
}

/** `GET {bank}/config`, read-only: the retain extraction mode the bank resolves to (null when the reply names none). */
export async function bankConfig(
	config: HindsightConfig,
	bank: string,
	fetchImpl: FetchLike = fetch,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HindsightResult<{ retain_extraction_mode: string | null }>> {
	const path = bankConfigPath(bank);
	const got = await get(config, path, {
		authed: true,
		fetchImpl,
		timeoutMs: options.timeoutMs ?? 4000,
		...(options.signal !== undefined ? { signal: options.signal } : {}),
	});
	if (!got.ok) return got;
	if (got.value.status !== 200) {
		return fail(statusKind(got.value.status), errorMessage(`GET ${path}`, got.value.status, got.value.body), got.value.status);
	}
	return { ok: true, value: { retain_extraction_mode: extractionMode(got.value.body) } };
}

export interface RetainItem {
	content: string;
	context?: string;
	tags: string[];
	metadata?: Record<string, string>;
	document_id: string;
	timestamp?: string;
}

/**
 * Retain redacted items with an idempotent upsert (`update_mode: "replace"`
 * over `document_id`, `async: false`), so a safe retry stores exactly once.
 */
export async function retainMemories(
	config: HindsightConfig,
	bank: string,
	items: RetainItem[],
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<HindsightResult<{ items_count: number }>> {
	if (items.length === 0) throw new Error("retainMemories needs at least one item; retaining nothing is forbidden");
	for (const item of items) {
		if (!item.document_id) throw new Error("retainMemories needs a document_id per item; unkeyed retain is forbidden");
	}
	const path = `${bankPath(bank)}/memories`;
	const sent = await send(
		config,
		"POST",
		path,
		{
			items: items.map((item) => ({
				content: item.content,
				...(item.context !== undefined ? { context: item.context } : {}),
				tags: item.tags,
				...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
				document_id: item.document_id,
				...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
				update_mode: "replace",
			})),
			async: false,
		},
		{ fetchImpl, timeoutMs },
	);
	if (!sent.ok) return sent;
	if (sent.value.status !== 200 && sent.value.status !== 201) {
		return fail(statusKind(sent.value.status), errorMessage(`POST ${path}`, sent.value.status, sent.value.body), sent.value.status);
	}
	const body = sent.value.body;
	if (
		body === null ||
		typeof body !== "object" ||
		!("success" in body) ||
		body.success !== true ||
		!("items_count" in body) ||
		typeof body.items_count !== "number"
	) {
		return fail("invalid-response", `hindsight POST ${path}: unexpected response shape`, sent.value.status);
	}
	return { ok: true, value: { items_count: body.items_count } };
}

export interface RecallHit {
	id: string;
	text: string;
	document_id?: string;
	type?: string;
	context?: string;
	tags: string[];
	metadata: Record<string, unknown>;
	score?: number;
}

export interface RecallRequest {
	query: string;
	types?: readonly string[];
	budget?: string;
	max_tokens?: number;
	tags?: string[];
	tags_match?: string;
	signal?: AbortSignal;
	/** Keeps a hit only when true. Applied before the per-bank cap, so a dropped hit never uses up one of its slots. */
	keep?: (hit: RecallHit) => boolean;
}

/**
 * Both known recall response shapes: `{results: [...]}` and the wrapped
 * `{data: {results: [...]}}`. Anything else is null — an invalid-response,
 * never an empty success.
 */
function resultsArray(body: unknown): unknown[] | null {
	if (body === null || typeof body !== "object") return null;
	if ("results" in body && Array.isArray(body.results)) return body.results;
	if (!("data" in body) || body.data === null || typeof body.data !== "object") return null;
	if ("results" in body.data && Array.isArray(body.data.results)) return body.data.results;
	return null;
}

/**
 * Recall over one bank, capped at `MAX_RECALL_PER_BANK` hits (D26-05).
 * Both known response shapes parse: `{results: [...]}` and
 * `{data: {results: [...]}}`. A missing results array is an
 * `invalid-response`, never an empty success.
 */
export async function recallBank(
	config: HindsightConfig,
	bank: string,
	request: RecallRequest,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<HindsightResult<RecallHit[]>> {
	if (!request.query) throw new Error("recallBank needs a query; unscoped recall is forbidden");
	const path = `${bankPath(bank)}/memories/recall`;
	const sent = await send(
		config,
		"POST",
		path,
		{
			query: request.query,
			types: [...(request.types ?? DEFAULT_RECALL_TYPES)],
			budget: request.budget ?? "low",
			max_tokens: request.max_tokens ?? 400,
			...(request.tags !== undefined ? { tags: request.tags } : {}),
			...(request.tags_match !== undefined ? { tags_match: request.tags_match } : {}),
		},
		{ fetchImpl, timeoutMs, ...(request.signal !== undefined ? { signal: request.signal } : {}) },
	);
	if (!sent.ok) return sent;
	if (sent.value.status !== 200) {
		return fail(statusKind(sent.value.status), errorMessage(`POST ${path}`, sent.value.status, sent.value.body), sent.value.status);
	}
	const results = resultsArray(sent.value.body);
	if (results === null) return fail("invalid-response", `hindsight POST ${path}: response had no results array`, sent.value.status);
	const hits: RecallHit[] = [];
	for (const entry of results) {
		if (entry === null || typeof entry !== "object" || !("text" in entry) || typeof entry.text !== "string") continue;
		const id = "id" in entry && typeof entry.id === "string" ? entry.id : "";
		const documentId = "document_id" in entry && typeof entry.document_id === "string" ? entry.document_id : undefined;
		const type = "type" in entry && typeof entry.type === "string" ? entry.type : undefined;
		const context = "context" in entry && typeof entry.context === "string" ? entry.context : undefined;
		const tags = "tags" in entry && Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [];
		const metadata = "metadata" in entry ? recordOf(entry.metadata) : {};
		const score = "score" in entry && typeof entry.score === "number" ? entry.score : undefined;
		const hit: RecallHit = {
			id,
			text: entry.text,
			...(documentId !== undefined ? { document_id: documentId } : {}),
			...(type !== undefined ? { type } : {}),
			...(context !== undefined ? { context } : {}),
			tags,
			metadata,
			...(score !== undefined ? { score } : {}),
		};
		if (request.keep !== undefined && !request.keep(hit)) continue;
		hits.push(hit);
		if (hits.length >= MAX_RECALL_PER_BANK) break;
	}
	return { ok: true, value: hits };
}

export interface HindsightDocument {
	id: string;
	document_id?: string;
	text?: string;
	tags: string[];
	metadata: Record<string, unknown>;
}

/** `GET {bank}/documents/{id}`: 404 is null, not an error. */
export async function getDocument(
	config: HindsightConfig,
	bank: string,
	id: string,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<HindsightResult<HindsightDocument | null>> {
	const path = `${bankPath(bank)}/documents/${encodeURIComponent(id)}`;
	const got = await get(config, path, { authed: true, fetchImpl, timeoutMs });
	if (!got.ok) return got;
	if (got.value.status === 404) return { ok: true, value: null };
	if (got.value.status !== 200) {
		return fail(statusKind(got.value.status), errorMessage(`GET ${path}`, got.value.status, got.value.body), got.value.status);
	}
	const body = got.value.body;
	if (body === null || typeof body !== "object") {
		return fail("invalid-response", `hindsight GET ${path}: unexpected response shape`, got.value.status);
	}
	const documentId = "document_id" in body && typeof body.document_id === "string" ? body.document_id : undefined;
	const text = "text" in body && typeof body.text === "string" ? body.text : undefined;
	const tags = "tags" in body && Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : [];
	const metadata = "metadata" in body ? recordOf(body.metadata) : {};
	return {
		ok: true,
		value: {
			id: "id" in body && typeof body.id === "string" ? body.id : id,
			...(documentId !== undefined ? { document_id: documentId } : {}),
			...(text !== undefined ? { text } : {}),
			tags,
			metadata,
		},
	};
}

/** `DELETE {bank}/documents/{id}`: 404 is false, not an error. */
export async function deleteDocument(
	config: HindsightConfig,
	bank: string,
	id: string,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<HindsightResult<boolean>> {
	const path = `${bankPath(bank)}/documents/${encodeURIComponent(id)}`;
	const sent = await send(config, "DELETE", path, {}, { fetchImpl, timeoutMs });
	if (!sent.ok) return sent;
	if (sent.value.status === 404) return { ok: true, value: false };
	if (sent.value.status !== 200 && sent.value.status !== 204) {
		return fail(statusKind(sent.value.status), errorMessage(`DELETE ${path}`, sent.value.status, sent.value.body), sent.value.status);
	}
	return { ok: true, value: true };
}

/** `PATCH {bank}/documents/{id}` retags one document. */
export async function patchDocumentTags(
	config: HindsightConfig,
	bank: string,
	id: string,
	tags: string[],
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<HindsightResult<void>> {
	const path = `${bankPath(bank)}/documents/${encodeURIComponent(id)}`;
	const sent = await send(config, "PATCH", path, { tags }, { fetchImpl, timeoutMs });
	if (!sent.ok) return sent;
	if (sent.value.status !== 200) {
		return fail(statusKind(sent.value.status), errorMessage(`PATCH ${path}`, sent.value.status, sent.value.body), sent.value.status);
	}
	return { ok: true, value: undefined };
}

/**
 * `DELETE {bank}`: destructive. Never called outside throwaway test banks —
 * the G2 live probe's rollback names it for a bank the probe itself created.
 */
export async function deleteBank(
	config: HindsightConfig,
	bank: string,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<HindsightResult<void>> {
	const path = bankPath(bank);
	const sent = await send(config, "DELETE", path, {}, { fetchImpl, timeoutMs });
	if (!sent.ok) return sent;
	if (sent.value.status !== 200 && sent.value.status !== 204) {
		return fail(statusKind(sent.value.status), errorMessage(`DELETE ${path}`, sent.value.status, sent.value.body), sent.value.status);
	}
	ensuredBanks.delete(`${config.url} ${bank}`);
	return { ok: true, value: undefined };
}
