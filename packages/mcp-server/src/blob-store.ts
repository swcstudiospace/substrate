/**
 * A content-addressed blob store for capsules (v1.6, phase 60).
 *
 * A blob is named by the lowercase hex SHA-256 of its bytes, so a name is also a checksum: every read
 * recomputes the digest and refuses bytes that no longer match. The interface is deliberately four verbs;
 * `LocalBlobStore` below is the always-available implementation and `blob-store-s3.ts` is the same contract
 * over an S3-compatible bucket.
 *
 * `LocalBlobStore` is built for a crash at any point:
 * - A write goes to a temp file in the target directory, is fsynced, then renamed over the final name, and
 *   the directory is fsynced after. A reader sees the whole blob or none of it, never a prefix.
 * - A put of bytes already stored is a no-op that returns the same digest (idempotent), unless the stored
 *   file fails its checksum, in which case it is replaced.
 * - The only path component derived from input is a validated 64-character hex digest, so no input can name
 *   a path outside the store; a shard directory or blob that is a symlink is refused.
 * - Directories are 0700 and files 0600.
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface BlobStore {
	/** Store `bytes`; returns their SHA-256 hex. Putting the same bytes twice is safe. */
	put(bytes: Uint8Array): Promise<string>;
	/** The bytes named by `digest`, verified against it; null when absent. */
	get(digest: string): Promise<Uint8Array | null>;
	/** Whether `digest` is stored. Existence only: `get` is what verifies the bytes. */
	has(digest: string): Promise<boolean>;
	/** Delete `digest`; true when something was removed. */
	remove(digest: string): Promise<boolean>;
}

type BlobStoreRule = "bad_digest" | "bad_path" | "too_large" | "corrupt" | "unsafe_path" | "io";

/** A blob-store failure. `rule` names what was refused; the message says what to do. */
export class BlobStoreError extends Error {
	readonly rule: BlobStoreRule;
	constructor(rule: BlobStoreRule, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "BlobStoreError";
		this.rule = rule;
	}
}

export const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;

const DIGEST_RE = /^[0-9a-f]{64}$/;

export function sha256Digest(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Throw unless `digest` is 64 lowercase hex characters. This is the only gate between input and a path or key. */
export function assertDigest(digest: unknown): asserts digest is string {
	if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
		throw new BlobStoreError("bad_digest", "a blob digest is 64 lowercase hex characters (the SHA-256 of its bytes)");
	}
}

interface LocalBlobStoreOptions {
	/** Refuse a put larger than this. Default `DEFAULT_MAX_BLOB_BYTES`. */
	maxBytes?: number;
	/** Names the temp file. Injected so a test is deterministic; default is random. */
	tempName?: () => string;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export class LocalBlobStore implements BlobStore {
	readonly #root: string;
	readonly #maxBytes: number;
	readonly #tempName: () => string;

	/** `dir` must be an absolute path with no `..` segment; it is created (0700) on first use. */
	constructor(dir: string, options: LocalBlobStoreOptions = {}) {
		if (typeof dir !== "string" || dir.length === 0 || dir.includes("\0")) {
			throw new BlobStoreError("bad_path", "the blob directory must be a non-empty path");
		}
		if (!isAbsolute(dir)) throw new BlobStoreError("bad_path", `the blob directory must be absolute, got ${JSON.stringify(dir)}`);
		if (dir.split(/[\\/]+/).includes("..")) {
			throw new BlobStoreError("bad_path", "the blob directory must not contain a '..' segment");
		}
		this.#root = resolve(dir);
		this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BLOB_BYTES;
		this.#tempName = options.tempName ?? (() => randomBytes(8).toString("hex"));
	}

	get root(): string {
		return this.#root;
	}

	#shard(digest: string): string {
		return join(this.#root, digest.slice(0, 2));
	}

	#path(digest: string): string {
		return join(this.#shard(digest), digest);
	}

	/** Create `path` as a real 0700 directory; a symlink or a non-directory in its place is refused. */
	async #ensureDir(path: string): Promise<void> {
		await mkdir(path, { recursive: true, mode: 0o700 });
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new BlobStoreError("unsafe_path", `${path} is not a plain directory (a symlink or file is in its place); remove it and retry`);
		}
		await chmod(path, 0o700);
	}

	async put(bytes: Uint8Array): Promise<string> {
		if (!(bytes instanceof Uint8Array)) throw new BlobStoreError("io", "put takes a Uint8Array");
		if (bytes.byteLength > this.#maxBytes) {
			throw new BlobStoreError("too_large", `blob is ${bytes.byteLength} bytes; the limit is ${this.#maxBytes}`);
		}
		const digest = sha256Digest(bytes);
		try {
			await this.#ensureDir(this.#root);
			const shard = this.#shard(digest);
			await this.#ensureDir(shard);
			const finalPath = this.#path(digest);
			if (await this.#intact(finalPath, digest)) return digest;

			const tempPath = join(shard, `.tmp-${this.#tempName()}`);
			// O_EXCL: a temp name that already exists is someone else's write in flight, so it fails rather than shares.
			const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
			try {
				try {
					await handle.writeFile(bytes);
					await handle.chmod(0o600);
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(tempPath, finalPath);
			} catch (error) {
				// The write already failed and its error is rethrown below. A failed cleanup leaves at worst a
				// `.tmp-` file that no read ever opens (reads name only digests), so it must not mask the real error.
				await unlink(tempPath).catch(() => undefined);
				throw error;
			}
			await this.#syncDir(shard);
			return digest;
		} catch (error) {
			if (error instanceof BlobStoreError) throw error;
			throw new BlobStoreError("io", `could not store blob ${digest}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}

	async get(digest: string): Promise<Uint8Array | null> {
		assertDigest(digest);
		const path = this.#path(digest);
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isFile()) {
				throw new BlobStoreError("unsafe_path", `${path} is not a regular file; refusing to read it`);
			}
			const bytes = new Uint8Array(await readFile(path));
			if (sha256Digest(bytes) !== digest) {
				throw new BlobStoreError("corrupt", `blob ${digest} does not match its digest on disk; restore it from the archive or remove it and re-put`);
			}
			return bytes;
		} catch (error) {
			if (isNotFound(error)) return null;
			if (error instanceof BlobStoreError) throw error;
			throw new BlobStoreError("io", `could not read blob ${digest}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}

	async has(digest: string): Promise<boolean> {
		assertDigest(digest);
		try {
			const info = await lstat(this.#path(digest));
			return info.isFile() && !info.isSymbolicLink();
		} catch (error) {
			if (isNotFound(error)) return false;
			throw new BlobStoreError("io", `could not stat blob ${digest}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}

	async remove(digest: string): Promise<boolean> {
		assertDigest(digest);
		try {
			await unlink(this.#path(digest));
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw new BlobStoreError("io", `could not remove blob ${digest}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}

	/** True when `path` is a regular file whose bytes hash to `digest`. A missing file is false; a damaged one is false and gets replaced. */
	async #intact(path: string, digest: string): Promise<boolean> {
		try {
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink()) return false;
			return sha256Digest(new Uint8Array(await readFile(path))) === digest;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}

	async #syncDir(path: string): Promise<void> {
		const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
}
