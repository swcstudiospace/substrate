/**
 * What `POST /corpus/plan`, `POST /corpus/ingest`, `GET /corpus/status` and the `corpus_status` and `corpus_ingest` tools
 * answer: the gates, the request parse, the planner or the ingest, and a status code with a closed reason. The HTTP server and
 * the MCP tools only carry the body in and the answer out, so both doors decide the same way.
 *
 * Every gate is checked before anything is read from the manifest or sent to a plane, so a server with `SUBSTRATE_CORPUS`
 * off, no index, or no LightRAG backend does nothing.
 */
import { randomUUID } from "node:crypto";
import { CORPUS_PROTOCOL, type CorpusIngestResponse, type CorpusPlanResponse, type CorpusStatusResponse } from "@substrate/corpus";
import type { CorpusSettings } from "../config.ts";
import type { LightragBulkPlane } from "../planes/lightrag-bulk.ts";
import type { EventInput, Surface } from "../types.ts";
import { corpusGate, ingestCorpus, type GateReason } from "./ingest.ts";
import { planCorpus, planRepos } from "./plan.ts";
import type { CorpusStore } from "./store.ts";
import { parseIngestRequest, parsePlanRequest, type RequestRefusal } from "./validate.ts";

/** Every reason a corpus door refuses: the gates, the request refusals, and an index that does not answer. Closed. */
export type CorpusRefusalReason = GateReason | RequestRefusal | "corpus.index-unavailable";

export interface CorpusRefusal {
	error: string;
	reason: CorpusRefusalReason;
	detail?: string | undefined;
}

export interface CorpusFailure {
	ok: false;
	status: 400 | 401 | 403 | 503;
	body: CorpusRefusal;
}

export type CorpusReply<T> = { ok: true; status: 200; body: T } | CorpusFailure;

export interface CorpusServiceDeps {
	settings: CorpusSettings;
	vmGuest: boolean;
	/** The manifest, or null when this server has no index. */
	store: CorpusStore | null;
	/** The LightRAG bulk plane, or null when the docs backend is not a configured LightRAG. */
	plane: LightragBulkPlane | null;
	emit: (event: EventInput) => Promise<unknown>;
	signal?: AbortSignal | undefined;
}

const MESSAGES: Readonly<Record<CorpusRefusalReason, string>> = {
	unauthenticated: "the corpus needs an authenticated surface; nothing was read or changed",
	"vm-guest": "the corpus is not served to a VM guest; nothing was read or changed",
	"corpus.disabled": "the corpus is switched off (SUBSTRATE_CORPUS is not on); nothing was read or changed",
	"corpus.backend-unavailable": "the corpus ingest needs the LightRAG docs backend, which is not configured; nothing was sent",
	"corpus.index-unavailable": "the corpus manifest is not reachable (no index, or it did not answer); nothing was changed",
	"bad-request": "the request body is not a valid corpus request",
	"bad-protocol": "the request names a corpus protocol version this server does not speak",
	"too-many-entries": "the plan names more entries than one request may carry",
	"too-many-documents": "the ingest carries more documents than one request may",
	"too-many-tombstones": "the ingest carries more tombstones than one request may",
	"empty-request": "the ingest carries no document and no tombstone",
	"bad-scope": "the plan's scope is not valid",
	"bad-repo": "a repository name is not owner/name or local/<directory>",
	"bad-path": "a path is not a normal repository-relative path",
	"bad-kind": "a kind is not in the closed list",
	"bad-tier": "a tier is not 1, 2 or 3",
	"bad-sha256": "a sha256 is not 64 lowercase hex characters",
	"bad-bytes": "a size is not a whole number of bytes in range",
	"bad-source": "a source is not fs, github or greptile",
	"bad-commit": "a commit is not a short printable string",
	"bad-body": "a document body is not a string",
	"duplicate-entry": "one (repo, path) appears twice in the request",
};

function refusal(status: 400 | 401 | 403 | 503, reason: CorpusRefusalReason, detail?: string): CorpusFailure {
	return { ok: false, status, body: { error: MESSAGES[reason], reason, ...(detail === undefined ? {} : { detail }) } };
}

/** The gate every corpus door shares. `needsPlane` is true for the ingest, the only door that writes to the docs plane. */
function gateOf(deps: CorpusServiceDeps, surface: Surface | null, needsPlane: boolean): CorpusFailure | null {
	const gate = corpusGate({
		enabled: deps.settings.enabled,
		surface,
		vmGuest: deps.vmGuest,
		backendReady: !needsPlane || deps.plane !== null,
	});
	if (gate !== null) return refusal(gate.status, gate.reason);
	if (deps.store === null) return refusal(503, "corpus.index-unavailable");
	return null;
}

async function emitRefusal(deps: CorpusServiceDeps, surface: Surface, reason: CorpusRefusalReason, sessionId: string): Promise<void> {
	await deps
		.emit({
			surface,
			kind: "warning",
			summary: `corpus request refused: ${reason}`,
			session_id: sessionId,
			payload: { action: "docs.corpus.refused", status: "refused", reason, count: 1 },
		})
		.then(
			() => undefined,
			() => undefined,
		);
}

/** `POST /corpus/plan`: what an ingest would add, change, update, rename or tombstone. Reads the manifest; writes nothing. */
export async function corpusPlanReply(deps: CorpusServiceDeps, raw: unknown, surface: Surface | null): Promise<CorpusReply<CorpusPlanResponse>> {
	const gated = gateOf(deps, surface, false);
	if (gated !== null) return gated;
	const parsed = parsePlanRequest(raw);
	if (!parsed.ok) return refusal(400, parsed.reason, parsed.detail);
	const { entries, scope } = parsed.value;
	const store = deps.store;
	if (store === null) return refusal(503, "corpus.index-unavailable");
	try {
		// Rows are read for the repositories the entries name (to tell an add from a change or an update) and those the coverage
		// lists (the only ones a row may be tombstoned in); the planner still tombstones only covered (repo, source) pairs.
		const rows = await store.rowsForRepos(planRepos(entries, scope));
		const plan = planCorpus(entries, scope, rows);
		return { ok: true, status: 200, body: { protocol: CORPUS_PROTOCOL, items: plan.items, counts: plan.counts, manifestVersion: await store.manifestVersion() } };
	} catch {
		return refusal(503, "corpus.index-unavailable");
	}
}

/** `POST /corpus/ingest`: the bulk ingest. The only door that sends anything to the docs plane. */
export async function corpusIngestReply(deps: CorpusServiceDeps, raw: unknown, surface: Surface | null): Promise<CorpusReply<CorpusIngestResponse>> {
	const gated = gateOf(deps, surface, true);
	if (gated !== null) {
		if (surface !== null && gated.body.reason !== "corpus.disabled") await emitRefusal(deps, surface, gated.body.reason, `corpus-ingest:${randomUUID()}`);
		return gated;
	}
	const { store, plane } = deps;
	if (surface === null || store === null || plane === null) return refusal(503, "corpus.index-unavailable");
	const sessionId = `corpus-ingest:${randomUUID()}`;
	const parsed = parseIngestRequest(raw);
	if (!parsed.ok) {
		await emitRefusal(deps, surface, parsed.reason, sessionId);
		return refusal(400, parsed.reason, parsed.detail);
	}
	const response = await ingestCorpus(
		{ store, plane, settings: deps.settings, emit: deps.emit, surface, sessionId, signal: deps.signal },
		parsed.value,
	);
	return { ok: true, status: 200, body: response };
}

/** `GET /corpus/status`: the manifest's counts. */
export async function corpusStatusReply(deps: CorpusServiceDeps, surface: Surface | null): Promise<CorpusReply<CorpusStatusResponse>> {
	const gated = gateOf(deps, surface, false);
	if (gated !== null) return gated;
	const store = deps.store;
	if (store === null) return refusal(503, "corpus.index-unavailable");
	try {
		return { ok: true, status: 200, body: { protocol: CORPUS_PROTOCOL, ...(await store.status()) } };
	} catch {
		return refusal(503, "corpus.index-unavailable");
	}
}
