/**
 * The HTTP side of `substrate corpus`: three routes of the substrate server, each answer checked by a guard before it is
 * used. A server that speaks another protocol version, answers with the wrong shape, refuses the token or runs with the
 * corpus off is reported as a closed error kind with a message the operator can act on; nothing here throws for those.
 */
import {
	CORPUS_ANCHOR_STATUSES,
	CORPUS_PROTOCOL,
	CORPUS_ROUTES,
	INGEST_STATUSES,
	MAX_PROOF_PATH_LENGTH,
	PLAN_ACTIONS,
	isDocKind,
	isDocTier,
	isRecord,
	isSha256Hex,
	type CorpusAnchorResponse,
	type CorpusIngestRequest,
	type CorpusIngestResponse,
	type CorpusPlanRequest,
	type CorpusPlanResponse,
	type CorpusProofResponse,
	type CorpusStatusResponse,
} from "@substrate/corpus";

export interface ClientConfig {
	/** The substrate's base URL, without a trailing slash. */
	url: string;
	token: string | undefined;
	timeoutMs: number;
	/** Test seam. */
	fetchImpl?: typeof fetch | undefined;
}

export const ERROR_KINDS = ["unauthorized", "forbidden", "disabled", "unavailable", "protocol", "invalid", "http", "network", "timeout"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface ClientError {
	kind: ErrorKind;
	message: string;
	status?: number | undefined;
}

export type ClientResult<T> = { ok: true; value: T } | { ok: false; error: ClientError };

export interface CorpusClient {
	plan(request: CorpusPlanRequest): Promise<ClientResult<CorpusPlanResponse>>;
	ingest(request: CorpusIngestRequest): Promise<ClientResult<CorpusIngestResponse>>;
	status(): Promise<ClientResult<CorpusStatusResponse>>;
	proof(repo: string, path: string): Promise<ClientResult<CorpusProofResponse>>;
	anchor(root: string): Promise<ClientResult<CorpusAnchorResponse>>;
}

/** The marker the server puts in a 503 when the corpus feature flag is off. */
const DISABLED_MARKER = "corpus.disabled";

/** How much of a server's own error text is shown; it is advisory and never trusted. */
const DETAIL_LIMIT = 200;

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function hasCounts(value: unknown, keys: readonly string[]): boolean {
	return isRecord(value) && keys.every((key) => isCount(value[key]));
}

function isPlanItem(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.action === "string" &&
		PLAN_ACTIONS.some((action) => action !== "unchanged" && action === value.action) &&
		typeof value.repo === "string" &&
		typeof value.path === "string" &&
		isOptionalString(value.sha256) &&
		isOptionalString(value.renamedFrom)
	);
}

function isIngestResult(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.repo === "string" &&
		typeof value.path === "string" &&
		INGEST_STATUSES.some((status) => status === value.status) &&
		isOptionalString(value.reason) &&
		isOptionalString(value.documentId)
	);
}

export function isPlanResponse(value: unknown): value is CorpusPlanResponse {
	return (
		isRecord(value) &&
		value.protocol === CORPUS_PROTOCOL &&
		Array.isArray(value.items) &&
		value.items.every(isPlanItem) &&
		hasCounts(value.counts, PLAN_ACTIONS) &&
		isCount(value.manifestVersion)
	);
}

export function isIngestResponse(value: unknown): value is CorpusIngestResponse {
	return (
		isRecord(value) &&
		value.protocol === CORPUS_PROTOCOL &&
		Array.isArray(value.results) &&
		value.results.every(isIngestResult) &&
		hasCounts(value.counts, INGEST_STATUSES) &&
		isCount(value.manifestVersion)
	);
}

export function isStatusResponse(value: unknown): value is CorpusStatusResponse {
	return (
		isRecord(value) &&
		value.protocol === CORPUS_PROTOCOL &&
		isCount(value.total) &&
		isCount(value.active) &&
		isCount(value.tombstoned) &&
		Array.isArray(value.byRepo) &&
		value.byRepo.every((row) => isRecord(row) && typeof row.repo === "string" && isCount(row.active) && isCount(row.tombstoned)) &&
		Array.isArray(value.byKind) &&
		value.byKind.every((row) => isRecord(row) && isDocKind(row.kind) && isCount(row.count)) &&
		Array.isArray(value.byTier) &&
		value.byTier.every((row) => isRecord(row) && isDocTier(row.tier) && isCount(row.count)) &&
		(value.lastIngestAt === null || typeof value.lastIngestAt === "string") &&
		isCount(value.manifestVersion)
	);
}

/** The shape of a proof, as the server answers it and as `prove --out` writes it. Hex values are checked by the verifier, not here. */
export function isProofResponse(value: unknown): value is CorpusProofResponse {
	return (
		isRecord(value) &&
		value.protocol === CORPUS_PROTOCOL &&
		typeof value.repo === "string" &&
		typeof value.documentPath === "string" &&
		typeof value.sha256 === "string" &&
		typeof value.leaf === "string" &&
		isCount(value.index) &&
		isCount(value.treeSize) &&
		Array.isArray(value.path) &&
		value.path.length <= MAX_PROOF_PATH_LENGTH &&
		value.path.every((step) => typeof step === "string") &&
		typeof value.root === "string" &&
		isCount(value.manifestVersion)
	);
}

function isNullableCount(value: unknown): boolean {
	return value === null || isCount(value);
}

function isNullableString(value: unknown): boolean {
	return value === null || typeof value === "string";
}

function isAnchorEvidence(value: unknown): boolean {
	return (
		isRecord(value) &&
		isNullableString(value.anchoredRoot) &&
		isNullableCount(value.hourEventCount) &&
		isNullableString(value.eventHash) &&
		isNullableCount(value.leafIndex) &&
		(value.hourProof === null || (Array.isArray(value.hourProof) && value.hourProof.length <= MAX_PROOF_PATH_LENGTH && value.hourProof.every((step) => typeof step === "string"))) &&
		isNullableString(value.signature) &&
		isNullableCount(value.slot) &&
		isNullableString(value.signer) &&
		isNullableCount(value.blockTimeMs) &&
		(value.finality === null || value.finality === "processed" || value.finality === "confirmed" || value.finality === "finalized")
	);
}

export function isAnchorResponse(value: unknown): value is CorpusAnchorResponse {
	return (
		isRecord(value) &&
		value.protocol === CORPUS_PROTOCOL &&
		isSha256Hex(value.root) &&
		typeof value.status === "string" &&
		(CORPUS_ANCHOR_STATUSES as readonly string[]).includes(value.status) &&
		Array.isArray(value.reasons) &&
		value.reasons.every((reason) => typeof reason === "string") &&
		isNullableString(value.eventId) &&
		isNullableCount(value.count) &&
		isNullableCount(value.manifestVersion) &&
		isNullableString(value.hourStart) &&
		(value.evidence === null || isAnchorEvidence(value.evidence))
	);
}

function fail(kind: ErrorKind, message: string, status?: number): { ok: false; error: ClientError } {
	return { ok: false, error: { kind, message, ...(status === undefined ? {} : { status }) } };
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// A body that is not JSON is the "invalid" answer, handled by the caller.
		return null;
	}
}

/** The server's own explanation, when it sent a short `error` or `reason` string. */
function detailOf(text: string): string {
	const body = parseJson(text);
	const detail = isRecord(body) ? [body.error, body.reason, body.message].find((field) => typeof field === "string") : undefined;
	return typeof detail === "string" && detail !== "" ? `: ${detail.slice(0, DETAIL_LIMIT)}` : "";
}

export function createCorpusClient(config: ClientConfig): CorpusClient {
	const fetchImpl = config.fetchImpl ?? fetch;

	async function call<T>(method: "GET" | "POST", route: string, body: unknown, guard: (value: unknown) => value is T): Promise<ClientResult<T>> {
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (config.token !== undefined) headers.authorization = `Bearer ${config.token}`;
		let response: Response;
		let text: string;
		try {
			response = await fetchImpl(`${config.url}${route}`, {
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(config.timeoutMs),
			});
			text = await response.text();
		} catch (cause) {
			if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
				return fail("timeout", `the server did not answer within ${config.timeoutMs} ms (${route})`);
			}
			return fail("network", `the server did not answer: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, DETAIL_LIMIT)}`);
		}
		if (response.status === 401) {
			return fail("unauthorized", "the server refused the credentials (401): set SUBSTRATE_TOKEN to a token of an operator surface", 401);
		}
		if (response.status === 403) {
			return fail("forbidden", "the server refused this surface (403): the corpus routes need an operator surface", 403);
		}
		if (response.status === 503) {
			return text.includes(DISABLED_MARKER)
				? fail("disabled", "the server runs with the corpus off (corpus.disabled): enable the corpus flag on the server and retry", 503)
				: fail("unavailable", `the server is unavailable (503)${detailOf(text)}`, 503);
		}
		if (!response.ok) return fail("http", `the server answered ${response.status}${detailOf(text)}`, response.status);
		const parsed = parseJson(text);
		if (isRecord(parsed) && typeof parsed.protocol === "number" && parsed.protocol !== CORPUS_PROTOCOL) {
			return fail("protocol", `the server speaks corpus protocol ${parsed.protocol}, this CLI speaks ${CORPUS_PROTOCOL}: update the older side`);
		}
		if (!guard(parsed)) return fail("invalid", `the server answer for ${route} was not the expected shape`);
		return { ok: true, value: parsed };
	}

	return {
		plan: (request) => call("POST", CORPUS_ROUTES.plan, request, isPlanResponse),
		ingest: (request) => call("POST", CORPUS_ROUTES.ingest, request, isIngestResponse),
		status: () => call("GET", CORPUS_ROUTES.status, undefined, isStatusResponse),
		proof: (repo, path) => call("GET", `${CORPUS_ROUTES.proof}?${new URLSearchParams({ repo, path }).toString()}`, undefined, isProofResponse),
		anchor: (root) => call("GET", `${CORPUS_ROUTES.anchor}?${new URLSearchParams({ root }).toString()}`, undefined, isAnchorResponse),
	};
}
