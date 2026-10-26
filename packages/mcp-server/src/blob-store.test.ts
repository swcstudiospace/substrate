import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDigest, BlobStoreError, LocalBlobStore, sha256Digest } from "./blob-store.ts";

const enc = new TextEncoder();
let base: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "blob-store-"));
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

async function rule(work: () => Promise<unknown> | unknown): Promise<string> {
	try {
		await work();
	} catch (error) {
		return error instanceof BlobStoreError ? error.rule : `other:${String(error)}`;
	}
	return "none";
}

describe("LocalBlobStore", () => {
	test("put, get, has and remove round trip, keyed by the SHA-256 of the bytes", async () => {
		const store = new LocalBlobStore(join(base, "blobs"));
		const bytes = enc.encode("capsule bytes");
		const digest = await store.put(bytes);
		expect(digest).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
		expect(digest).toBe(sha256Digest(bytes));
		expect(await store.has(digest)).toBe(true);
		expect(Buffer.from((await store.get(digest)) as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
		expect(await store.remove(digest)).toBe(true);
		expect(await store.has(digest)).toBe(false);
		expect(await store.get(digest)).toBeNull();
		expect(await store.remove(digest)).toBe(false);
	});

	test("an absent digest is null, false and false, not an error", async () => {
		const store = new LocalBlobStore(join(base, "blobs"));
		const digest = sha256Digest(enc.encode("never stored"));
		expect(await store.get(digest)).toBeNull();
		expect(await store.has(digest)).toBe(false);
		expect(await store.remove(digest)).toBe(false);
	});

	test("put is idempotent and concurrent puts of the same bytes leave one blob and no temp files", async () => {
		const store = new LocalBlobStore(join(base, "blobs"));
		const bytes = enc.encode("same bytes");
		const digests = await Promise.all(Array.from({ length: 8 }, () => store.put(bytes)));
		expect(new Set(digests).size).toBe(1);
		await store.put(bytes);
		const shard = join(base, "blobs", (digests[0] as string).slice(0, 2));
		expect(readdirSync(shard)).toEqual([digests[0] as string]);
	});

	test("directories are 0700 and files 0600, and a looser existing directory is tightened", async () => {
		const root = join(base, "blobs");
		mkdirSync(root, { mode: 0o755 });
		const store = new LocalBlobStore(root);
		const digest = await store.put(enc.encode("perms"));
		expect(mode(root)).toBe(0o700);
		expect(mode(join(root, digest.slice(0, 2)))).toBe(0o700);
		expect(mode(join(root, digest.slice(0, 2), digest))).toBe(0o600);
	});

	test("every read verifies the digest: a damaged file is refused, and a put replaces it", async () => {
		const root = join(base, "blobs");
		const store = new LocalBlobStore(root);
		const bytes = enc.encode("original");
		const digest = await store.put(bytes);
		const file = join(root, digest.slice(0, 2), digest);
		writeFileSync(file, "tampered");
		expect(await rule(() => store.get(digest))).toBe("corrupt");
		expect(await store.has(digest)).toBe(true);
		expect(await store.put(bytes)).toBe(digest);
		expect(readFileSync(file, "utf8")).toBe("original");
		expect(Buffer.from((await store.get(digest)) as Uint8Array).toString()).toBe("original");
	});

	test("a path-shaped or malformed digest is refused before any path is built", async () => {
		const store = new LocalBlobStore(join(base, "blobs"));
		const hostile = [
			"../../etc/passwd",
			"..",
			"/etc/passwd",
			`${"a".repeat(62)}/..`,
			`../${"a".repeat(61)}`,
			"a".repeat(63),
			"a".repeat(65),
			"A".repeat(64),
			`${"a".repeat(63)}\0`,
			"",
		];
		for (const digest of hostile) {
			expect({ digest, get: await rule(() => store.get(digest)) }).toEqual({ digest, get: "bad_digest" });
			expect({ digest, has: await rule(() => store.has(digest)) }).toEqual({ digest, has: "bad_digest" });
			expect({ digest, remove: await rule(() => store.remove(digest)) }).toEqual({ digest, remove: "bad_digest" });
		}
		expect(await rule(() => store.get(undefined as unknown as string))).toBe("bad_digest");
		expect(() => assertDigest("0".repeat(64))).not.toThrow();
	});

	test("a relative directory, a .. segment, an empty path and a NUL are refused at construction", () => {
		for (const dir of ["blobs", "./blobs", "", "/tmp/../etc", "/tmp/a\0b"]) {
			expect(() => new LocalBlobStore(dir)).toThrow(BlobStoreError);
		}
	});

	test("a symlinked shard directory is refused and nothing is written through it", async () => {
		const root = join(base, "blobs");
		const outside = join(base, "outside");
		mkdirSync(root, { mode: 0o700 });
		mkdirSync(outside);
		const bytes = enc.encode("symlink bait");
		const digest = sha256Digest(bytes);
		symlinkSync(outside, join(root, digest.slice(0, 2)));
		const store = new LocalBlobStore(root);
		expect(await rule(() => store.put(bytes))).toBe("unsafe_path");
		expect(readdirSync(outside)).toEqual([]);
	});

	test("a blob that is a symlink is not read", async () => {
		const root = join(base, "blobs");
		const store = new LocalBlobStore(root);
		const bytes = enc.encode("real");
		const digest = await store.put(bytes);
		const file = join(root, digest.slice(0, 2), digest);
		const secret = join(base, "secret.txt");
		writeFileSync(secret, "real");
		rmSync(file);
		symlinkSync(secret, file);
		expect(await rule(() => store.get(digest))).toBe("unsafe_path");
		expect(await store.has(digest)).toBe(false);
	});

	test("the write goes through a temp file: a failed temp create leaves no blob, and nothing partial is ever at the final name", async () => {
		const root = join(base, "blobs");
		const bytes = enc.encode("atomic");
		const digest = sha256Digest(bytes);
		const shard = join(root, digest.slice(0, 2));
		mkdirSync(shard, { recursive: true, mode: 0o700 });
		// Someone else's temp file under the name this writer would use.
		writeFileSync(join(shard, ".tmp-fixed"), "in flight");
		const store = new LocalBlobStore(root, { tempName: () => "fixed" });
		expect(await rule(() => store.put(bytes))).toBe("io");
		expect(await store.has(digest)).toBe(false);
		expect(readFileSync(join(shard, ".tmp-fixed"), "utf8")).toBe("in flight");
		rmSync(join(shard, ".tmp-fixed"));
		expect(await store.put(bytes)).toBe(digest);
		expect(readdirSync(shard)).toEqual([digest]);
	});

	test("a put over the size limit is refused and creates nothing", async () => {
		const root = join(base, "blobs");
		const store = new LocalBlobStore(root, { maxBytes: 4 });
		expect(await rule(() => store.put(enc.encode("12345")))).toBe("too_large");
		expect(await store.put(enc.encode("1234"))).toBe(sha256Digest(enc.encode("1234")));
		expect(await rule(() => store.put("text" as unknown as Uint8Array))).toBe("io");
	});
});
