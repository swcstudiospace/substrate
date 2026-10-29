/**
 * What `POST /docs/feedback` and the `docs_feedback` tool, `POST /corpus/reflect` and `GET /corpus/gaps` answer (v1.7 phase
 * 66): the gates, the request parse, the store or the ingest, and a status code with a closed reason. The HTTP server and the
 * MCP tool only carry the body in and the answer out, so both doors decide the same way.
 *
 * Every gate is checked before anything is read or written, so a server with `SUBSTRATE_CORPUS` off or no index does nothing.
 * One bad digest never fails a request: it is reported by itself with a closed reason and the others go on.
 */
import { randomUUID } from "node:crypto";
import {
	CORPUS_PROTOCOL,
	DEFAULT_GAPS_LIMIT,
	DIGEST_PATH,
	MAX_DIGEST_CHARS,
	MAX_GAPS_LIMIT,
	MAX_REFLECT_DIGESTS,
	documentKey,
	isValidPath,
	isValidRepo,
	type CorpusDocument,
	type CorpusGapsResponse,
	type CorpusReflectResponse,
	type CorpusReflectResultItem,
} from "@substrate/corpus";
import { redact } from "../redact.ts";
import type { Surface } from "../types.ts";
import { corpusGate, ingestCorpus, type GateReason } from "./ingest.ts";
import { FEEDBACK_VERDICTS, GAP_WINDOW_DAYS, isFeedbackVerdict, type FeedbackVerdict, type ReflectStore } from "./reflect-store.ts";
import type { CorpusServiceDeps } from "./service.ts";
import { isRecord, isSha256Hex } from "./validate.ts";

/** The tier a digest is stored at: the classifier gives the virtual digest path tier 1, and the server writes the same. */
export const DIGEST_TIER = 1;
/** The longest session id a feedback row keeps. */
export const FEEDBACK_SESSION_CHARS = 200;
/** The longest repository name a digest result echoes when the name itself was not valid. */
const ECHO_CHARS = 80;
/** The longest closed reason the Hindsight leg adds to a result. */
const RETAIN_REASON_CHARS = 80;

export const REFLECT_REQUEST_REFUSALS = ["bad-request", "bad-protocol", "empty-request", "too-many-digests"] as const;
export const FEEDBACK_REFUSALS = ["bad-request", "bad-document", "bad-verdict", "unknown-document"] as const;
/** Why one digest of a reflect request is refused before the ingest sees it. Closed; the ingest adds its own reasons after. */
export const DIGEST_REFUSALS = ["bad-digest", "bad-repo", "bad-sha256", "too-large", "duplicate-entry"] as const;

type DigestRefusal = (typeof DIGEST_REFUSALS)[number];

export type ReflectRefusalReason =
	| GateReason
	| "corpus.index-unavailable"
	| (typeof REFLECT_REQUEST_REFUSALS)[number]
	| (typeof FEEDBACK_REFUSALS)[number];

export interface ReflectRefusal {
	error: string;
	reason: ReflectRefusalReason;
	detail?: string | undefined;
}

export interface ReflectFailure {
	ok: false;
	status: 400 | 401 | 403 | 404 | 503;
	body: ReflectRefusal;
}

export type ReflectReply<T> = { ok: true; status: 200; body: T } | ReflectFailure;

/** The outcome of retaining one digest in Hindsight through the governance gate. */
export type RetainOutcome = { ok: true } | { ok: false; reason: string };

export interface ReflectServiceDeps extends CorpusServiceDeps {
	/** Feedback, retrieval telemetry and the gap aggregate, or null when this server has no index. */
	reflect: ReflectStore | null;
	/** `SUBSTRATE_DOCS_GAP_SCORE`. */
	gapScore: number;
	/** Retains one stored digest as a governed memory entry; best effort, never throws. */
	retainDigest: (input: { repo: string; text: string; surface: Surface; sessionId: string }) => Promise<RetainOutcome>;
}

const MESSAGES: Readonly<Record<ReflectRefusalReason, string>> = {
	unauthenticated: "this door needs an authenticated surface; nothing was read or changed",
	"vm-guest": "this door is not served to a VM guest; nothing was read or changed",
	"corpus.disabled": "the corpus is switched off (SUBSTRATE_CORPUS is not on); nothing was read or changed",
	"corpus.backend-unavailable": "the digest ingest needs the LightRAG docs backend, which is not configured; nothing was sent",
	"corpus.index-unavailable": "the corpus manifest or its learning tables are not reachable (no index, or it did not answer); nothing was changed",
	"bad-request": "the request body is not valid",
	"bad-protocol": "the request names a corpus protocol version this server does not speak",
	"empty-request": "the reflect request carries no digest",
	"too-many-digests": "the reflect request carries more digests than one request may",
	"bad-document": "a document is not a corpus document key, repo:path",
	"bad-verdict": `a verdict is not one of ${FEEDBACK_VERDICTS.join(", ")}`,
	"unknown-document": "the document is not an active row of the corpus manifest; nothing was stored",
};

function refusal(status: ReflectFailure["status"], reason: ReflectRefusalReason, detail?: string): ReflectFailure {
	return { ok: false, status, body: { error: MESSAGES[reason], reason, ...(detail === undefined ? {} : { detail }) } };
}

function gateOf(deps: CorpusServiceDeps, surface: Surface | null, needsPlane: boolean): ReflectFailure | null {
	const gate = corpusGate({ enabled: deps.settings.enabled, surface, vmGuest: deps.vmGuest, backendReady: !needsPlane || deps.plane !== null });
	if (gate !== null) return refusal(gate.status, gate.reason);
	if (deps.store === null) return refusal(503, "corpus.index-unavailable");
	return null;
}

// ── feedback ─────────────────────────────────────────────────────────────────

export interface FeedbackRequest {
	repo: string;
	path: string;
	verdict: FeedbackVerdict;
	/** The caller's own session id, cut and redacted; null when it named none. */
	sessionId: string | null;
}

export type ParsedFeedback = { ok: true; value: FeedbackRequest } | { ok: false; reason: (typeof FEEDBACK_REFUSALS)[number]; detail?: string | undefined };

/** `{document, verdict, session_id?, note?}`; the note is ignored and never stored. */
export function parseFeedbackRequest(raw: unknown): ParsedFeedback {
	if (!isRecord(raw)) return { ok: false, reason: "bad-request", detail: "the body must be a JSON object" };
	const { document, verdict, session_id: sessionId } = raw;
	if (typeof document !== "string") return { ok: false, reason: "bad-document", detail: "document must be a string" };
	// A repository never holds a colon, so the first one separates it from the path.
	const colon = document.indexOf(":");
	const repo = colon < 1 ? "" : document.slice(0, colon);
	const path = colon < 1 ? "" : document.slice(colon + 1);
	if (!isValidRepo(repo) || !isValidPath(path)) return { ok: false, reason: "bad-document", detail: document.slice(0, ECHO_CHARS) };
	if (!isFeedbackVerdict(verdict)) return { ok: false, reason: "bad-verdict" };
	if (sessionId !== undefined && typeof sessionId !== "string") return { ok: false, reason: "bad-request", detail: "session_id must be a string" };
	const session = typeof sessionId === "string" ? redact(sessionId.trim()).slice(0, FEEDBACK_SESSION_CHARS) : "";
	return { ok: true, value: { repo, path, verdict, sessionId: session.length > 0 ? session : null } };
}

export interface FeedbackStored {
	protocol: typeof CORPUS_PROTOCOL;
	document: string;
	verdict: FeedbackVerdict;
	stored: true;
}

/**
 * `POST /docs/feedback`: one verdict for one active manifest document, idempotent per (surface, session, document): the latest
 * verdict wins. A document the manifest does not hold as active is `unknown-document` and nothing is stored. The row is keyed by
 * the caller's own surface as well as its session id, so one surface can never overwrite another surface's verdict.
 */
export async function docsFeedbackReply(deps: ReflectServiceDeps, raw: unknown, surface: Surface | null): Promise<ReflectReply<FeedbackStored>> {
	const gated = gateOf(deps, surface, false);
	if (gated !== null) return gated;
	const { store, reflect } = deps;
	if (surface === null || store === null || reflect === null) return refusal(503, "corpus.index-unavailable");
	const parsed = parseFeedbackRequest(raw);
	if (!parsed.ok) return refusal(400, parsed.reason, parsed.detail);
	const { repo, path, verdict, sessionId } = parsed.value;
	try {
		const row = await store.rowFor(repo, path);
		if (row === null || row.state !== "active") return refusal(404, "unknown-document", documentKey(repo, path));
		await reflect.upsertFeedback({ documentKey: documentKey(repo, path), sessionId: `${surface}/${sessionId ?? "surface"}`, verdict, surface });
	} catch {
		return refusal(503, "corpus.index-unavailable");
	}
	return { ok: true, status: 200, body: { protocol: CORPUS_PROTOCOL, document: documentKey(repo, path), verdict, stored: true } };
}

// ── digests ──────────────────────────────────────────────────────────────────

type DigestItem = { ready: true; repo: string; text: string; sha256: string } | { ready: false; repo: string; reason: DigestRefusal };

type ParsedReflect = { ok: true; items: DigestItem[] } | { ok: false; reason: (typeof REFLECT_REQUEST_REFUSALS)[number]; detail?: string | undefined };

/**
 * The request's bounds and shape; each digest is judged by itself. A digest that is not an object, names a bad repository,
 * carries a malformed hash, a text that is not a string or too long, or repeats an earlier repository is reported with its own
 * reason and the rest are kept.
 */
export function parseReflectRequest(raw: unknown): ParsedReflect {
	if (!isRecord(raw)) return { ok: false, reason: "bad-request", detail: "the body must be a JSON object" };
	if (raw.protocol !== CORPUS_PROTOCOL) return { ok: false, reason: "bad-protocol", detail: `this server speaks protocol ${CORPUS_PROTOCOL}` };
	if (!Array.isArray(raw.digests)) return { ok: false, reason: "bad-request", detail: "digests must be an array" };
	if (raw.digests.length === 0) return { ok: false, reason: "empty-request" };
	if (raw.digests.length > MAX_REFLECT_DIGESTS) return { ok: false, reason: "too-many-digests", detail: `at most ${MAX_REFLECT_DIGESTS}` };
	const seen = new Set<string>();
	const items: DigestItem[] = [];
	for (const item of raw.digests) {
		if (!isRecord(item)) {
			items.push({ ready: false, repo: "", reason: "bad-digest" });
			continue;
		}
		const { repo, text, sha256 } = item;
		const named = typeof repo === "string" ? repo.slice(0, ECHO_CHARS) : "";
		if (typeof repo !== "string" || !isValidRepo(repo)) items.push({ ready: false, repo: named, reason: "bad-repo" });
		else if (typeof text !== "string") items.push({ ready: false, repo, reason: "bad-digest" });
		else if (text.length > MAX_DIGEST_CHARS) items.push({ ready: false, repo, reason: "too-large" });
		else if (!isSha256Hex(sha256)) items.push({ ready: false, repo, reason: "bad-sha256" });
		else if (seen.has(repo)) items.push({ ready: false, repo, reason: "duplicate-entry" });
		else {
			seen.add(repo);
			items.push({ ready: true, repo, text, sha256 });
		}
	}
	return { ok: true, items };
}

function documentOf(item: { repo: string; text: string; sha256: string }): CorpusDocument {
	return { repo: item.repo, path: DIGEST_PATH, kind: "digest", tier: DIGEST_TIER, sha256: item.sha256, bytes: Buffer.byteLength(item.text, "utf8"), source: "fs", body: item.text };
}

/**
 * `POST /corpus/reflect`: stores each repository digest as the corpus document `(repo, DIGEST_PATH)` through the one ingest
 * path (so redaction, naming, the manifest and the plane rules all apply, and the request waits behind the same single-flight
 * lock as any ingest), then retains each stored digest in Hindsight through the governance gate. The Hindsight leg is best
 * effort: a refusal or an outage becomes the digest's `reason` while its plane document stays stored. A digest the manifest
 * already holds unchanged is not retained again.
 */
export async function corpusReflectReply(deps: ReflectServiceDeps, raw: unknown, surface: Surface | null): Promise<ReflectReply<CorpusReflectResponse>> {
	const gated = gateOf(deps, surface, true);
	if (gated !== null) return gated;
	const { store, plane } = deps;
	if (surface === null || store === null || plane === null) return refusal(503, "corpus.index-unavailable");
	const parsed = parseReflectRequest(raw);
	if (!parsed.ok) return refusal(400, parsed.reason, parsed.detail);

	const sessionId = `corpus-reflect:${randomUUID()}`;
	const documents = parsed.items.flatMap((item) => (item.ready ? [documentOf(item)] : []));
	const ingested = new Map<string, { status: string; reason?: string | undefined }>();
	let manifestVersion = 0;
	if (documents.length > 0) {
		const response = await ingestCorpus({ store, plane, settings: deps.settings, emit: deps.emit, surface, sessionId, signal: deps.signal }, { protocol: CORPUS_PROTOCOL, documents, tombstones: [] });
		for (const result of response.results) ingested.set(result.repo, { status: result.status, reason: result.reason });
		manifestVersion = response.manifestVersion;
	} else {
		try {
			manifestVersion = await store.manifestVersion();
		} catch {
			// The version is only a freshness hint; every digest was refused before the store was asked.
		}
	}

	const results: CorpusReflectResultItem[] = [];
	for (const item of parsed.items) {
		if (!item.ready) {
			results.push({ repo: item.repo, status: "refused", reason: item.reason });
			continue;
		}
		const outcome = ingested.get(item.repo);
		if (outcome === undefined) results.push({ repo: item.repo, status: "failed", reason: "manifest-unavailable" });
		else if (outcome.status === "unchanged") results.push({ repo: item.repo, status: "unchanged" });
		else if (outcome.status === "refused") results.push({ repo: item.repo, status: "refused", ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) });
		else if (outcome.status !== "ingested" && outcome.status !== "updated") results.push({ repo: item.repo, status: "failed", ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) });
		else {
			const retained = await deps.retainDigest({ repo: item.repo, text: item.text, surface, sessionId });
			results.push({ repo: item.repo, status: "stored", ...(retained.ok ? {} : { reason: `hindsight:${redact(retained.reason).slice(0, RETAIN_REASON_CHARS)}` }) });
		}
	}
	return { ok: true, status: 200, body: { protocol: CORPUS_PROTOCOL, results, manifestVersion } };
}

// ── gaps ─────────────────────────────────────────────────────────────────────

/** `limit` as the query string carried it: a whole number clamped into the documented range, else the default. */
export function gapsLimitOf(raw: string | null): number {
	const text = raw?.trim() ?? "";
	if (!/^\d+$/.test(text)) return DEFAULT_GAPS_LIMIT;
	return Math.min(MAX_GAPS_LIMIT, Math.max(1, Number(text)));
}

/**
 * `GET /corpus/gaps`: the queries whose best answer in the last {@link GAP_WINDOW_DAYS} days was no citation or one below
 * `SUBSTRATE_DOCS_GAP_SCORE`, aggregated by query hash, most searched first. A search the plane could not answer is not a gap.
 * `truncated` says more gaps exist than `limit` returned.
 */
export async function corpusGapsReply(deps: ReflectServiceDeps, rawLimit: string | null, surface: Surface | null): Promise<ReflectReply<CorpusGapsResponse>> {
	const gated = gateOf(deps, surface, false);
	if (gated !== null) return gated;
	const reflect = deps.reflect;
	if (reflect === null) return refusal(503, "corpus.index-unavailable");
	const limit = gapsLimitOf(rawLimit);
	try {
		const rows = await reflect.gaps({ gapScore: deps.gapScore, days: GAP_WINDOW_DAYS, limit: limit + 1 });
		return { ok: true, status: 200, body: { protocol: CORPUS_PROTOCOL, gaps: rows.slice(0, limit), truncated: rows.length > limit } };
	} catch {
		return refusal(503, "corpus.index-unavailable");
	}
}
