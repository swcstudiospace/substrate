/**
 * What `POST /corpus/plan`, `POST /corpus/ingest`, `POST /corpus/reconcile`, `GET /corpus/status`, `GET /corpus/root`, `GET /corpus/proof`, `GET /corpus/anchor` and
 * the `corpus_status` and `corpus_ingest` tools answer: the gates, the request parse, the planner, the ingest, the reconcile or the proof, and a status
 * code with a closed reason. The HTTP server and the MCP tools only carry the body in and the answer out, so both doors decide the same way.
 *
 * Every gate is checked before anything is read from the manifest or sent to a plane, so a server with `SUBSTRATE_CORPUS`
 * off, no index, or no LightRAG backend does nothing.
 */
import { randomUUID } from "node:crypto";
import {
	CORPUS_PROTOCOL,
	isSha256Hex,
	isValidPath,
	isValidRepo,
	type CorpusAnchorResponse,
	type CorpusIngestResponse,
	type CorpusPlanResponse,
	type CorpusProofResponse,
	type CorpusReconcileResponse,
	type CorpusRootResponse,
	type CorpusStatusResponse,
} from "@substrate/corpus";
import type { AnchorVerifyPorts } from "../anchor-verify-deps.ts";
import type { CorpusSettings } from "../config.ts";
import type { LightragBulkPlane } from "../planes/lightrag-bulk.ts";
import type { EventInput, Surface } from "../types.ts";
import { authorizeRepo, REPO_REFUSAL_MESSAGES, REPO_SCOPE_OFF, type RepoRefusalReason, type RepoScope } from "../repo-scope.ts";
import { corpusAnchorStatus, type AnchorVerifier } from "./anchor.ts";
import { corpusGate, ingestCorpus, type GateReason } from "./ingest.ts";
import { planCorpus, planRepos } from "./plan.ts";
import { reconcileCorpus } from "./reconcile.ts";
import { inclusionOf, type CorpusRootKeeper } from "./root.ts";
import type { CorpusStore } from "./store.ts";
import { parseIngestRequest, parsePlanRequest, parseReconcileRequest, type RequestRefusal } from "./validate.ts";

/** Every reason a corpus door refuses: the gates, the request refusals, an index or plane or embedding service that does not answer, and the proof lookups. Closed. */
export type CorpusRefusalReason =
	| GateReason
	| RequestRefusal
	| "corpus.index-unavailable"
	| "corpus.plane-unreachable"
	| "corpus.embeddings-unavailable"
	| "corpus.too-large"
	| "not-in-corpus"
	| "bad-root"
	| RepoRefusalReason;

export interface CorpusRefusal {
	error: string;
	reason: CorpusRefusalReason;
	detail?: string | undefined;
}

export interface CorpusFailure {
	ok: false;
	status: 400 | 401 | 403 | 404 | 503;
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
	/** The clock, epoch ms; tests inject one. */
	now?: (() => number) | undefined;
	/** The root cache and the root event, owned by the service so they outlive one request. */
	roots: CorpusRootKeeper;
	/** The ledger and devnet reads the anchor check goes through. */
	anchor: { ports: () => AnchorVerifyPorts; verify?: AnchorVerifier | undefined };
	/** The repository scope the doors that name repositories consult. Absent means scoping is off, as before. */
	repoScope?: RepoScope | undefined;
}

const MESSAGES: Readonly<Record<CorpusRefusalReason, string>> = {
	unauthenticated: "the corpus needs an authenticated surface; nothing was read or changed",
	"vm-guest": "the corpus is not served to a VM guest; nothing was read or changed",
	"corpus.disabled": "the corpus is switched off (SUBSTRATE_CORPUS is not on); nothing was read or changed",
	"corpus.backend-unavailable": "the corpus ingest and reconcile need the LightRAG docs backend, which is not configured; nothing was sent",
	"corpus.index-unavailable": "the corpus manifest is not reachable (no index, or it did not answer); nothing was changed",
	"corpus.plane-unreachable": "the docs plane did not list its documents; nothing was changed",
	"corpus.embeddings-unavailable": "the embedding service could not answer (the closed reason is in detail); nothing was compared",
	"corpus.too-large": "the manifest has more active documents than one root covers; no root was made",
	"not-in-corpus": "no active document has this repository and path",
	"bad-root": "root is not 64 lowercase hex characters",
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
	"too-many-items": "the near-duplicate request names more items than one request may carry",
	"bad-text": "an item text is not a string",
	"text-too-long": "an item text is longer than one request may carry",
	"bad-threshold": "the threshold is not a number from 0.5 to 1",
	"bad-max-pairs": "maxPairs is not a whole number from 1 to 1000",
	...REPO_REFUSAL_MESSAGES,
};

export function refusal(status: 400 | 401 | 403 | 404 | 503, reason: CorpusRefusalReason, detail?: string): CorpusFailure {
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

/**
 * The repository gate the doors that name repositories share. A repository outside the caller's grant is refused before any
 * manifest or plane read. An authenticated refusal is audited with its reason alone: the requested repository and path are not
 * written to the ledger, and an anonymous refusal is recorded by the route audit that runs before every handler.
 */
async function repoRefusalOf(deps: CorpusServiceDeps, surface: Surface | null, repos: readonly string[]): Promise<CorpusFailure | null> {
	const scope = deps.repoScope ?? REPO_SCOPE_OFF;
	for (const repo of repos) {
		const gate = authorizeRepo(scope, surface, repo);
		if (gate.ok) continue;
		if (surface !== null) await emitRefusal(deps, surface, gate.reason, `corpus-scope:${randomUUID()}`);
		return refusal(403, gate.reason);
	}
	return null;
}

/** The doors that read every repository at once (status, reconcile): refused while scoping is on, because no single grant covers them. */
function allReposRefusal(deps: CorpusServiceDeps): CorpusFailure | null {
	return (deps.repoScope ?? REPO_SCOPE_OFF).enforced ? refusal(403, "all-repos-not-granted") : null;
}

/** `POST /corpus/plan`: what an ingest would add, change, update, rename or tombstone. Reads the manifest; writes nothing. */
export async function corpusPlanReply(deps: CorpusServiceDeps, raw: unknown, surface: Surface | null): Promise<CorpusReply<CorpusPlanResponse>> {
	const gated = gateOf(deps, surface, false);
	if (gated !== null) return gated;
	const parsed = parsePlanRequest(raw);
	if (!parsed.ok) return refusal(400, parsed.reason, parsed.detail);
	const { entries, scope } = parsed.value;
	const scoped = await repoRefusalOf(deps, surface, planRepos(entries, scope));
	if (scoped !== null) return scoped;
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
	const scoped = await repoRefusalOf(deps, surface, [...parsed.value.documents, ...parsed.value.tombstones].map((item) => item.repo));
	if (scoped !== null) return scoped;
	// The root cache is unavailable from the first write to the last: each batch saves its rows before the later ones and the cleanup.
	// A request that recorded, changed or removed anything (or failed part-way, or threw) moved the manifest: a root event is owed.
	// The keeper coalesces and dedupes by manifest version, so a request that changed nothing writes nothing.
	deps.roots.writeStarted();
	let changed = true;
	try {
		const response = await ingestCorpus(
			{ store, plane, settings: deps.settings, emit: deps.emit, surface, sessionId, signal: deps.signal },
			parsed.value,
		);
		const { counts } = response;
		changed = counts.ingested + counts.updated + counts.tombstoned + counts.failed > 0;
		return { ok: true, status: 200, body: response };
	} finally {
		deps.roots.writeSettled(changed);
	}
}

/** Whole seconds between an ISO instant and `now` (epoch ms), never negative; null for no instant. */
function ageSeconds(at: string | null, now: number): number | null {
	if (at === null) return null;
	const ms = Date.parse(at);
	return Number.isFinite(ms) ? Math.max(0, Math.round((now - ms) / 1000)) : null;
}

/** `GET /corpus/status`: the manifest's counts, and `lagSeconds`, the age of its newest write. */
export async function corpusStatusReply(deps: CorpusServiceDeps, surface: Surface | null): Promise<CorpusReply<CorpusStatusResponse>> {
	const gated = gateOf(deps, surface, false);
	if (gated !== null) return gated;
	const wide = allReposRefusal(deps);
	if (wide !== null) return wide;
	const store = deps.store;
	if (store === null) return refusal(503, "corpus.index-unavailable");
	try {
		const { newestChangeAt, ...summary } = await store.status();
		return { ok: true, status: 200, body: { protocol: CORPUS_PROTOCOL, ...summary, lagSeconds: ageSeconds(newestChangeAt, (deps.now ?? Date.now)()) } };
	} catch {
		return refusal(503, "corpus.index-unavailable");
	}
}

/**
 * `POST /corpus/reconcile`: compares the manifest's active rows with the docs plane and reports the drift. A dry run
 * (`execute` false or absent) reads the plane's document listing and the manifest and changes nothing; `execute` marks the
 * rows whose plane document is gone as removed (the next plan offers them as `add`) and deletes the `corpus:` documents no
 * row owns. Needs the plane like the ingest does, and shares its lock.
 */
export async function corpusReconcileReply(deps: CorpusServiceDeps, raw: unknown, surface: Surface | null): Promise<CorpusReply<CorpusReconcileResponse>> {
	const gated = gateOf(deps, surface, true);
	if (gated !== null) return gated;
	const wide = allReposRefusal(deps);
	if (wide !== null) return wide;
	const parsed = parseReconcileRequest(raw);
	if (!parsed.ok) return refusal(400, parsed.reason, parsed.detail);
	const { store, plane } = deps;
	if (store === null || plane === null) return refusal(503, "corpus.index-unavailable");
	const { execute } = parsed.value;
	// An executed reconcile moves manifest rows like an ingest does, so it brackets its writes the same way: no root is cached or
	// recorded while it runs, and a request that requeued a row (or failed part-way, or threw) owes a root event. A dry run writes nothing.
	if (execute) deps.roots.writeStarted();
	let changed = true;
	try {
		const result = await reconcileCorpus({ store, plane, signal: deps.signal }, execute);
		if (!result.ok) return refusal(503, result.reason, result.detail);
		changed = result.body.repaired.requeued > 0;
		return { ok: true, status: 200, body: result.body };
	} finally {
		if (execute) deps.roots.writeSettled(changed);
	}
}

/** `GET /corpus/root`: the Merkle root over the active manifest, from the cache while it matches the manifest's version. */
export async function corpusRootReply(deps: CorpusServiceDeps, surface: Surface | null): Promise<CorpusReply<CorpusRootResponse>> {
	const gated = gateOf(deps, surface, false);
	if (gated !== null) return gated;
	try {
		const current = await deps.roots.current();
		if (!current.ok) return refusal(503, "corpus.too-large");
		const { root, count, manifestVersion, skipped } = current.snapshot;
		return { ok: true, status: 200, body: { protocol: CORPUS_PROTOCOL, root, count, manifestVersion, skipped } };
	} catch {
		return refusal(503, "corpus.index-unavailable");
	}
}

/** `GET /corpus/proof`: the inclusion proof of one active document, taken from one read of the manifest so it matches the root it names. */
export async function corpusProofReply(deps: CorpusServiceDeps, query: { repo: string | null; path: string | null }, surface: Surface | null): Promise<CorpusReply<CorpusProofResponse>> {
	const gated = gateOf(deps, surface, false);
	if (gated !== null) return gated;
	const { repo, path } = query;
	if (repo === null || !isValidRepo(repo)) return refusal(400, "bad-repo");
	if (path === null || !isValidPath(path)) return refusal(400, "bad-path");
	const scoped = await repoRefusalOf(deps, surface, [repo]);
	if (scoped !== null) return scoped;
	try {
		const read = await deps.roots.read();
		if (!read.ok) return refusal(503, "corpus.too-large");
		const found = inclusionOf(read.tree, repo, path);
		if (found === null) return refusal(404, "not-in-corpus");
		const { sha256, leaf, index, treeSize, path: auditPath, root } = found;
		return {
			ok: true,
			status: 200,
			body: { protocol: CORPUS_PROTOCOL, repo, documentPath: path, sha256, leaf, index, treeSize, path: auditPath, root, manifestVersion: read.snapshot.manifestVersion },
		};
	} catch {
		return refusal(503, "corpus.index-unavailable");
	}
}

/** `GET /corpus/anchor`: is this root inside an anchored hour? `unanchored` is a 200 answer, not an error. */
export async function corpusAnchorReply(deps: CorpusServiceDeps, root: string | null, surface: Surface | null): Promise<CorpusReply<CorpusAnchorResponse>> {
	const gated = gateOf(deps, surface, false);
	if (gated !== null) return gated;
	if (root === null || !isSha256Hex(root)) return refusal(400, "bad-root");
	return { ok: true, status: 200, body: await corpusAnchorStatus(deps.anchor.ports(), root, deps.anchor.verify) };
}
