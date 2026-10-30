/**
 * The HTTP side of `substrate corpus`: the corpus routes of the substrate server, each answer checked by a guard before it is
 * used. A server that speaks another protocol version, answers with the wrong shape, refuses the token or runs with the
 * corpus off is reported as a closed error kind with a message the operator can act on; nothing here throws for those.
 */
import {
	CORPUS_ANCHOR_STATUSES,
	CORPUS_PROTOCOL,
	CORPUS_ROUTES,
	DEFAULT_GAPS_LIMIT,
	INGEST_STATUSES,
	MAX_GAPS_LIMIT,
	MAX_PROOF_PATH_LENGTH,
	PLAN_ACTIONS,
	REFLECT_STATUSES,
	isDocKind,
	isDocTier,
	isEmbeddingReason,
	isRecord,
	isSha256Hex,
	type CorpusAnchorResponse,
	type CorpusGapsResponse,
	type CorpusIngestRequest,
	type CorpusIngestResponse,
	type CorpusNeardupRequest,
	type CorpusNeardupResponse,
	type CorpusPlanRequest,
	type CorpusPlanResponse,
	type CorpusProofResponse,
	type CorpusReconcileRequest,
	type CorpusReconcileResponse,
	type CorpusReflectRequest,
	type CorpusReflectResponse,
	type CorpusStatusResponse,
	type EmbeddingReason,
} from "@substrate/corpus";

export interface ClientConfig {
	/** The substrate's base URL, without a trailing slash. */
	url: string;
	token: string | undefined;
	timeoutMs: number;
	/** Test seam. */
	fetchImpl?: typeof fetch | undefined;
}

export const ERROR_KINDS = ["unauthorized", "forbidden", "disabled", "unavailable", "embeddings", "protocol", "invalid", "http", "network", "timeout"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface ClientError {
	kind: ErrorKind;
	message: string;
	status?: number | undefined;
	/** For `embeddings`: the closed reason the server's embedding service gave, when it gave one this CLI knows. */
	reason?: EmbeddingReason | undefined;
}

export type ClientResult<T> = { ok: true; value: T } | { ok: false; error: ClientError };

export interface CorpusClient {
	plan(request: CorpusPlanRequest): Promise<ClientResult<CorpusPlanResponse>>;
	neardup(request: CorpusNeardupRequest): Promise<ClientResult<CorpusNeardupResponse>>;
	ingest(request: CorpusIngestRequest): Promise<ClientResult<CorpusIngestResponse>>;
	status(): Promise<ClientResult<CorpusStatusResponse>>;
	reconcile(request: CorpusReconcileRequest): Promise<ClientResult<CorpusReconcileResponse>>;
	reflect(request: CorpusReflectRequest): Promise<ClientResult<CorpusReflectResponse>>;
	/** The queries the corpus could not answer; `limit` is clamped to the server's maximum. */
	gaps(limit?: number): Promise<ClientResult<CorpusGapsResponse>>;
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
		(value.lagSeconds === null || (typeof value.lagSeconds === "number" && Number.isFinite(value.lagSeconds) && value.lagSeconds >= 0)) &&
		isCount(value.manifestVersion)
	);
}

function isReflectResult(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.repo === "string" &&
		REFLECT_STATUSES.some((status) => status === value.status) &&
		isOptionalString(value.reason)
	);
}

function isGap(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.queryHash === "string" &&
		(value.text === null || typeof value.text === "string") &&
		isCount(value.searches) &&
		typeof value.lastSeen === "string" &&
		(value.best === null || (typeof value.best === "number" && Number.isFinite(value.best)))
	);
}

export function isReflectResponse(value: unknown): value is CorpusReflectResponse {
	return (
		isRecord(value) &&
		value.protocol === CORPUS_PROTOCOL &&
		Array.isArray(value.results) &&
		value.results.every(isReflectResult) &&
		isCount(value.manifestVersion)
	);
}

export function isGapsResponse(value: unknown): value is CorpusGapsResponse {
	return (
		isRecord(value) &&
		value.protocol === CORPUS_PROTOCOL &&
		Array.isArray(value.gaps) &&
		value.gaps.every(isGap) &&
		typeof value.truncated === "boolean"
	);
}

function isNeardupKey(value: unknown): boolean {
	return isRecord(value) && typeof value.repo === "string" && typeof value.path === "string";
}

export function isNeardupResponse(value: unknown): value is CorpusNeardupResponse {
	return (
		isRecord(value) &&
		value.protocol === CORPUS_PROTOCOL &&
		(value.model === null || typeof value.model === "string") &&
		(value.dimension === null || isCount(value.dimension)) &&
		isCount(value.compared) &&
		typeof value.truncated === "boolean" &&
		Array.isArray(value.pairs) &&
		value.pairs.every((pair) => isRecord(pair) && isNeardupKey(pair.a) && isNeardupKey(pair.b) && typeof pair.similarity === "number" && Number.isFinite(pair.similarity)) &&
		Array.isArray(value.skipped) &&
		value.skipped.every((item) => isNeardupKey(item) && isRecord(item) && item.reason === "empty")
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

function isRowRef(value: unknown): boolean {
	return isRecord(value) && typeof value.repo === "string" && typeof value.path === "string";
}

export function isReconcileResponse(value: unknown): value is CorpusReconcileResponse {
	if (!isRecord(value) || value.protocol !== CORPUS_PROTOCOL || !isCount(value.manifestVersion)) return false;
	const { drift, repaired } = value;
	return (
		isRecord(drift) &&
		Array.isArray(drift.missingInPlane) &&
		drift.missingInPlane.every(isRowRef) &&
		Array.isArray(drift.orphansInPlane) &&
		drift.orphansInPlane.every((name) => typeof name === "string") &&
		isCount(drift.checked) &&
		typeof drift.truncated === "boolean" &&
		hasCounts(repaired, ["requeued", "deleted"])
	);
}

function fail(kind: ErrorKind, message: string, status?: number, reason?: EmbeddingReason): { ok: false; error: ClientError } {
	return { ok: false, error: { kind, message, ...(status === undefined ? {} : { status }), ...(reason === undefined ? {} : { reason }) } };
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// A body that is not JSON is the "invalid" answer, handled by the caller.
		return null;
	}
}

/** The marker the server puts in a 503 when the embedding service could not answer; its `detail` is the closed reason. */
const EMBEDDINGS_MARKER = "corpus.embeddings-unavailable";

/** The closed reason of an `embeddings` 503, or undefined when the body is not one or names a reason this CLI does not know. */
function embeddingsReason(text: string): { reason: EmbeddingReason | undefined } | null {
	const body = parseJson(text);
	if (!isRecord(body) || body.reason !== EMBEDDINGS_MARKER) return null;
	return { reason: isEmbeddingReason(body.detail) ? body.detail : undefined };
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
			if (text.includes(DISABLED_MARKER)) {
				return fail("disabled", "the server runs with the corpus off (corpus.disabled): enable the corpus flag on the server and retry", 503);
			}
			const embeddings = embeddingsReason(text);
			if (embeddings !== null) {
				return fail("embeddings", `the embedding service could not answer (${embeddings.reason ?? "unknown reason"}); nothing was compared`, 503, embeddings.reason);
			}
			return fail("unavailable", `the server is unavailable (503)${detailOf(text)}`, 503);
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
		neardup: (request) => call("POST", CORPUS_ROUTES.neardup, request, isNeardupResponse),
		ingest: (request) => call("POST", CORPUS_ROUTES.ingest, request, isIngestResponse),
		status: () => call("GET", CORPUS_ROUTES.status, undefined, isStatusResponse),
		reconcile: (request) => call("POST", CORPUS_ROUTES.reconcile, request, isReconcileResponse),
		reflect: (request) => call("POST", CORPUS_ROUTES.reflect, request, isReflectResponse),
		// The server refuses a limit above its maximum, so the CLI keeps inside it; a limit that is not a positive integer is the default.
		gaps: (limit) => {
			const wanted = limit === undefined || !Number.isInteger(limit) || limit < 1 ? DEFAULT_GAPS_LIMIT : Math.min(limit, MAX_GAPS_LIMIT);
			return call("GET", `${CORPUS_ROUTES.gaps}?limit=${wanted}`, undefined, isGapsResponse);
		},
		proof: (repo, path) => call("GET", `${CORPUS_ROUTES.proof}?${new URLSearchParams({ repo, path }).toString()}`, undefined, isProofResponse),
		anchor: (root) => call("GET", `${CORPUS_ROUTES.anchor}?${new URLSearchParams({ root }).toString()}`, undefined, isAnchorResponse),
	};
}
