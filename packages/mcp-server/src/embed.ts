/**
 * The embedding service (phase 64): the TEI client behind the Dragonfly read-through cache. The rest of the server
 * embeds text through this and never through the client directly.
 *
 * With `SUBSTRATE_EMBED_CACHE=on` a text's vector is stored under `substrate:v1:emb:<sha256(model + "\n" + text)>` as
 * `{ dim, b64 }` (the Float32 bytes in base64) with the TTL `SUBSTRATE_EMBED_CACHE_TTL_S`, so a key names the model
 * its vector came from and two models never share one. A call reads every key in one `MGET`, embeds only the misses
 * in one batch, then writes them. A cache that fails to read or write costs the call nothing: it embeds as if the
 * cache were off. The cache is cache-only (Dragonfly is never the source of truth): a lost key is embedded again.
 *
 * The cache is read only once the model and dimension are known (pinned, or learned from a first answer), because the
 * key needs the model and a hit has to be compared with the dimension. The first call after a start with no pins is
 * therefore all misses; it still writes.
 */
import { createHash } from "node:crypto";
import { decodeEmbeddingBytes, type ReadThroughCache } from "./cache.ts";
import { MAX_TEXTS_PER_CALL, clampText, type TeiClient, type TeiEmbedOptions, type TeiEmbedResult } from "./planes/tei.ts";
import { reportSilent } from "./silent-failures.ts";

/** The cache surface the service uses; the production `ReadThroughCache` has it. */
export type EmbeddingCacheStore = Pick<ReadThroughCache, "peekMany" | "putEntry">;

interface EmbeddingServiceDeps {
	client: TeiClient;
	/** Null with no Dragonfly: every call goes to TEI. */
	cache: EmbeddingCacheStore | null;
	/** `SUBSTRATE_EMBED_CACHE=on`. */
	cacheEnabled: boolean;
	/** `SUBSTRATE_EMBED_CACHE_TTL_S`: seconds every written entry lives. */
	ttlS: number;
}

export interface EmbeddingService {
	embed(texts: readonly string[], options?: TeiEmbedOptions): Promise<TeiEmbedResult>;
	/** The client's view, for the fabric: model, dimension, last latency. */
	snapshot: TeiClient["snapshot"];
}

/** What a cached vector is stored as. */
interface StoredVector {
	dim: number;
	b64: string;
}

/** Entries written per round of concurrent `SET`s. */
const WRITE_CHUNK = 32;

/** The digest an entry is keyed by: the model and the text, so one model's vectors are never read as another's. */
export function embeddingDigest(model: string, text: string): string {
	return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

export function encodeVector(vector: Float32Array): StoredVector {
	return { dim: vector.length, b64: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64") };
}

/** The vector a stored entry holds, or null when its bytes are not `dim` finite Float32 values or the dimension is not the wanted one. */
export function decodeVector(stored: StoredVector, dim: number): Float32Array | null {
	if (stored.dim !== dim) return null;
	return decodeEmbeddingBytes(dim, stored.b64);
}

export function createEmbeddingService(deps: EmbeddingServiceDeps): EmbeddingService {
	const { client } = deps;

	async function embed(texts: readonly string[], options?: TeiEmbedOptions): Promise<TeiEmbedResult> {
		const cache = deps.cache;
		// Not configured, or no cache: the client answers, and an unconfigured client sends nothing.
		if (!client.configured || !deps.cacheEnabled || cache === null || texts.length === 0) return client.embed(texts, options);
		// The same bound as the client's, checked on the ORIGINAL count before any text is clamped, hashed or looked up, so
		// the answer does not depend on the cache and a huge call allocates nothing.
		if (texts.length > MAX_TEXTS_PER_CALL) return { ok: false, reason: "input-refused" };

		const clamped = texts.map(clampText);
		// The same text twice in one call is embedded once.
		const unique = [...new Set(clamped)];
		const known = client.snapshot();
		const found = new Map<string, Float32Array>();
		if (known.model !== null && known.dim !== null) {
			const knownModel = known.model;
			const knownDim = known.dim;
			// The store never rejects; the guard is for an injected one, so a cache can only cost a miss.
			const stored = await cache
				.peekMany<StoredVector>(
					"emb",
					unique.map((text) => embeddingDigest(knownModel, text)),
				)
				.catch((cause: unknown): Array<StoredVector | null> => {
					reportSilent("embed.cache-peek", cause);
					return [];
				});
			unique.forEach((text, index) => {
				const entry = stored[index];
				const vector = entry === null || entry === undefined ? null : decodeVector(entry, knownDim);
				if (vector !== null) found.set(text, vector);
			});
		}

		const missing = unique.filter((text) => !found.has(text));
		let model = known.model ?? "";
		let dim = known.dim ?? 0;
		if (missing.length > 0) {
			const fresh = await client.embed(missing, options);
			if (!fresh.ok) return fresh;
			model = fresh.model;
			dim = fresh.dim;
			missing.forEach((text, index) => {
				const vector = fresh.vectors[index];
				if (vector !== undefined) found.set(text, vector);
			});
			await store(cache, model, missing, fresh.vectors);
		}

		const vectors: Float32Array[] = [];
		for (const text of clamped) {
			const vector = found.get(text);
			if (vector === undefined) return { ok: false, reason: "bad-response" };
			vectors.push(vector);
		}
		return { ok: true, vectors, model, dim };
	}

	/** Writes the fresh vectors, a chunk at a time, and stops at the first refusal: a cache that is down is not asked again by this call. */
	async function store(cache: EmbeddingCacheStore, model: string, texts: readonly string[], vectors: readonly Float32Array[]): Promise<void> {
		for (let from = 0; from < texts.length; from += WRITE_CHUNK) {
			const writes: Array<Promise<boolean>> = [];
			for (let index = from; index < Math.min(texts.length, from + WRITE_CHUNK); index += 1) {
				const text = texts[index];
				const vector = vectors[index];
				if (text === undefined || vector === undefined) continue;
				writes.push(cache.putEntry("emb", embeddingDigest(model, text), encodeVector(vector), deps.ttlS));
			}
			const results = await Promise.all(writes).catch(() => [false]);
			if (results.includes(false)) return;
		}
	}

	return { embed, snapshot: () => client.snapshot() };
}
