/**
 * `BlobStore` over an S3-compatible bucket (v1.6, phase 60).
 *
 * The same contract as `LocalBlobStore` (see `blob-store.ts`): blobs are keyed by the SHA-256 hex of their
 * bytes under an optional key prefix, and every read recomputes the digest.
 *
 * `S3Like` is the four calls this adapter needs, written so that `Bun.S3Client` satisfies it structurally
 * (`write`, `file(key).arrayBuffer()`, `exists`, `delete`). This module imports no S3 client and holds no
 * credential: the caller constructs a `Bun.S3Client` (or a fake) and passes it in. The live ledger-archive
 * bucket stays operator-gated: nothing here, and nothing in the tests, reaches a real bucket.
 */
import { assertDigest, BlobStoreError, DEFAULT_MAX_BLOB_BYTES, sha256Digest, type BlobStore } from "./blob-store.ts";

/** The slice of `Bun.S3Client` this adapter uses. */
export interface S3Like {
	write(key: string, data: Uint8Array): Promise<number>;
	file(key: string): { arrayBuffer(): Promise<ArrayBuffer> };
	exists(key: string): Promise<boolean>;
	delete(key: string): Promise<void>;
}

export interface S3BlobStoreOptions {
	/** Key prefix, for instance `memory-capsules/`. Letters, digits, `. _ -` and `/` only; a trailing `/` is added. */
	prefix?: string;
	/** Refuse a put larger than this. Default `DEFAULT_MAX_BLOB_BYTES`. */
	maxBytes?: number;
}

const PREFIX_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/;

/** Validate and normalise a key prefix: relative, no `..`, no empty segment, ending in `/` (or empty). */
export function normalizePrefix(prefix: string | undefined): string {
	if (prefix === undefined || prefix === "") return "";
	if (typeof prefix !== "string" || !PREFIX_RE.test(prefix) || prefix.split("/").includes("..") || prefix.split("/").includes(".")) {
		throw new BlobStoreError("bad_path", `invalid S3 key prefix ${JSON.stringify(prefix)}: use relative segments of letters, digits, '.', '_' and '-' joined by '/'`);
	}
	return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class S3BlobStore implements BlobStore {
	readonly #client: S3Like;
	readonly #prefix: string;
	readonly #maxBytes: number;

	constructor(client: S3Like, options: S3BlobStoreOptions = {}) {
		this.#client = client;
		this.#prefix = normalizePrefix(options.prefix);
		this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BLOB_BYTES;
	}

	/** The object key for `digest`. The digest is validated first, so no input shapes the key beyond 64 hex characters. */
	keyFor(digest: string): string {
		assertDigest(digest);
		return `${this.#prefix}${digest}`;
	}

	async put(bytes: Uint8Array): Promise<string> {
		if (!(bytes instanceof Uint8Array)) throw new BlobStoreError("io", "put takes a Uint8Array");
		if (bytes.byteLength > this.#maxBytes) {
			throw new BlobStoreError("too_large", `blob is ${bytes.byteLength} bytes; the limit is ${this.#maxBytes}`);
		}
		const digest = sha256Digest(bytes);
		try {
			// An S3 PUT is atomic, and the key is the digest, so a repeat put rewrites identical bytes. It is not
			// skipped when the key exists: that would leave a damaged object in place.
			await this.#client.write(this.keyFor(digest), bytes);
		} catch (error) {
			throw new BlobStoreError("io", `could not store blob ${digest} in the bucket: ${describe(error)}`, { cause: error });
		}
		return digest;
	}

	async get(digest: string): Promise<Uint8Array | null> {
		const key = this.keyFor(digest);
		let bytes: Uint8Array;
		try {
			if (!(await this.#client.exists(key))) return null;
			bytes = new Uint8Array(await this.#client.file(key).arrayBuffer());
		} catch (error) {
			throw new BlobStoreError("io", `could not read blob ${digest} from the bucket: ${describe(error)}`, { cause: error });
		}
		if (sha256Digest(bytes) !== digest) {
			throw new BlobStoreError("corrupt", `object ${key} does not match its digest; re-put the blob from a verified copy`);
		}
		return bytes;
	}

	async has(digest: string): Promise<boolean> {
		const key = this.keyFor(digest);
		try {
			return await this.#client.exists(key);
		} catch (error) {
			throw new BlobStoreError("io", `could not check blob ${digest} in the bucket: ${describe(error)}`, { cause: error });
		}
	}

	async remove(digest: string): Promise<boolean> {
		const key = this.keyFor(digest);
		try {
			if (!(await this.#client.exists(key))) return false;
			await this.#client.delete(key);
			return true;
		} catch (error) {
			throw new BlobStoreError("io", `could not remove blob ${digest} from the bucket: ${describe(error)}`, { cause: error });
		}
	}
}
