/**
 * What `POST /corpus/neardup` answers (v1.7 phase 64, EMB-04): document excerpts are embedded through the embedding service
 * (the TEI client behind the `emb` cache) and the pairs whose cosine similarity is at or above a threshold are returned.
 *
 * The signal is advisory. Nothing here reads the manifest, writes a document, drops, skips or tombstones anything: the reply
 * only says which excerpts look alike, and the caller decides what to do with that. The route needs no Postgres.
 *
 * The excerpts travel only to the operator's TEI service (the fabric compliance check requires it to be loopback or an allowed
 * proxy). No text, excerpt or TEI URL is put in a reply, an audit record, an event or a log line: every error message is a
 * fixed string and the only variable part of a refusal is a closed reason or a repo and path the caller itself sent.
 */
import {
	CORPUS_PROTOCOL,
	DEFAULT_NEARDUP_PAIRS,
	DEFAULT_NEARDUP_THRESHOLD,
	MAX_NEARDUP_SKIPPED,
	nearDuplicatesYielding,
	type CorpusNeardupResponse,
	type EmbeddingReason,
	type NearDuplicatePair,
	type NeardupItem,
	type NeardupPair,
} from "@substrate/corpus";
import type { CorpusSettings } from "../config.ts";
import type { EmbeddingService } from "../embed.ts";
import type { TeiEmbedResult } from "../planes/tei.ts";
import type { Surface } from "../types.ts";
import { corpusGate } from "./ingest.ts";
import { refusal, type CorpusFailure, type CorpusReply } from "./service.ts";
import { parseNeardupRequest } from "./validate.ts";

export interface NeardupDeps {
	settings: CorpusSettings;
	vmGuest: boolean;
	/** The cached embedding service: the only way this door embeds anything. */
	embeddings: Pick<EmbeddingService, "embed">;
	/** Releases the event loop between blocks of the comparison. Default: one macrotask (`setImmediate`). A test injects its own. */
	yieldFn?: (() => Promise<void>) | undefined;
}

/**
 * `nearDuplicates` counts a pair at or above its threshold, and the dot product of two identical unit vectors can land a hair
 * under 1, so a threshold of 1 ("identical") is compared at this value instead.
 */
const IDENTICAL_THRESHOLD = 0.999999;

/** One macrotask: queued timers, I/O callbacks and other requests run before the comparison resumes. */
function nextMacrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Items are keyed by their zero-padded index, so `nearDuplicates` (which orders keys as strings) breaks a tie in the items' (repo, path) order. */
const KEY_WIDTH = 4;

function compareItems(a: NeardupItem, b: NeardupItem): number {
	if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function embeddingsUnavailable(reason: EmbeddingReason): CorpusFailure {
	return refusal(503, "corpus.embeddings-unavailable", reason);
}

export async function corpusNeardupReply(deps: NeardupDeps, raw: unknown, surface: Surface | null): Promise<CorpusReply<CorpusNeardupResponse>> {
	const gate = corpusGate({ enabled: deps.settings.enabled, surface, vmGuest: deps.vmGuest, backendReady: true });
	if (gate !== null) return refusal(gate.status, gate.reason);
	const parsed = parseNeardupRequest(raw);
	if (!parsed.ok) return refusal(400, parsed.reason, parsed.detail);
	const threshold = parsed.value.threshold ?? DEFAULT_NEARDUP_THRESHOLD;
	const maxPairs = parsed.value.maxPairs ?? DEFAULT_NEARDUP_PAIRS;

	// Sorted, so the answer does not depend on the order the caller listed the items in. A blank excerpt has no meaning to embed.
	const sorted = [...parsed.value.items].sort(compareItems);
	const embedded = sorted.filter((item) => item.text.trim().length > 0);
	const skipped = sorted
		.filter((item) => item.text.trim().length === 0)
		.slice(0, MAX_NEARDUP_SKIPPED)
		.map((item) => ({ repo: item.repo, path: item.path, reason: "empty" as const }));
	if (embedded.length === 0) {
		return { ok: true, status: 200, body: { protocol: CORPUS_PROTOCOL, model: null, dimension: null, compared: 0, pairs: [], truncated: false, skipped } };
	}

	// The service settles to a value and never rejects; a rejection would still be an unavailable service, not a 500.
	const result: TeiEmbedResult = await deps.embeddings.embed(embedded.map((item) => item.text)).catch((): TeiEmbedResult => ({ ok: false, reason: "unavailable" }));
	if (!result.ok) return embeddingsUnavailable(result.reason);
	if (result.vectors.length !== embedded.length) return embeddingsUnavailable("bad-response");
	const { vectors: embeddings, model, dim } = result;

	const byKey = new Map<string, NeardupItem>();
	const vectors = embedded.map((item, index) => {
		const key = String(index).padStart(KEY_WIDTH, "0");
		byKey.set(key, item);
		return { key, vector: embeddings[index] ?? new Float32Array(0) };
	});
	let found: NearDuplicatePair[];
	try {
		// One more than the cap, to learn whether the cap cut anything off. The comparison is O(n^2) in the items, so it hands the
		// event loop back between blocks instead of holding the HTTP thread for the whole run; a rejection is handled like a throw.
		found = await nearDuplicatesYielding(vectors, { threshold: Math.min(threshold, IDENTICAL_THRESHOLD), maxPairs: maxPairs + 1 }, { yieldFn: deps.yieldFn ?? nextMacrotask });
	} catch (cause) {
		if (cause instanceof RangeError) return embeddingsUnavailable("dim-mismatch");
		throw cause;
	}

	const pairs: NeardupPair[] = [];
	for (const pair of found.slice(0, maxPairs)) {
		const a = byKey.get(pair.a);
		const b = byKey.get(pair.b);
		if (a === undefined || b === undefined) continue;
		pairs.push({ a: { repo: a.repo, path: a.path }, b: { repo: b.repo, path: b.path }, similarity: Math.round(pair.similarity * 10_000) / 10_000 });
	}
	return {
		ok: true,
		status: 200,
		body: { protocol: CORPUS_PROTOCOL, model, dimension: dim, compared: embedded.length, pairs, truncated: found.length > maxPairs, skipped },
	};
}
