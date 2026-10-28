import { describe, expect, test } from "bun:test";
import { BlobStoreError, sha256Digest } from "./blob-store.ts";
import { normalizePrefix, S3BlobStore, type S3Like } from "./blob-store-s3.ts";

const enc = new TextEncoder();

/** An in-memory bucket. No network, no credentials: the adapter only ever sees this interface. */
class FakeBucket implements S3Like {
	readonly objects = new Map<string, Uint8Array>();
	readonly calls: string[] = [];
	failWith: Error | null = null;

	async write(key: string, data: Uint8Array): Promise<number> {
		this.calls.push(`write ${key}`);
		if (this.failWith) throw this.failWith;
		this.objects.set(key, new Uint8Array(data));
		return data.byteLength;
	}

	file(key: string): { arrayBuffer(): Promise<ArrayBuffer> } {
		this.calls.push(`file ${key}`);
		return {
			arrayBuffer: async () => {
				if (this.failWith) throw this.failWith;
				const value = this.objects.get(key);
				if (!value) throw new Error("NoSuchKey");
				return value.slice().buffer as ArrayBuffer;
			},
		};
	}

	async exists(key: string): Promise<boolean> {
		this.calls.push(`exists ${key}`);
		if (this.failWith) throw this.failWith;
		return this.objects.has(key);
	}

	async delete(key: string): Promise<void> {
		this.calls.push(`delete ${key}`);
		if (this.failWith) throw this.failWith;
		this.objects.delete(key);
	}
}

async function rule(work: () => Promise<unknown> | unknown): Promise<string> {
	try {
		await work();
	} catch (error) {
		return error instanceof BlobStoreError ? error.rule : `other:${String(error)}`;
	}
	return "none";
}

describe("Bun.S3Client compatibility", () => {
	test("Bun.S3Client is assignable to S3Like (checked by the compiler, not at runtime)", () => {
		// If a Bun release changes write, file, exists or delete, `bun run typecheck` fails here.
		type Check = Bun.S3Client extends S3Like ? true : never;
		const check: Check = true;
		expect(check).toBe(true);
	});
});

describe("S3BlobStore", () => {
	test("put, get, has and remove round trip under the key prefix, keyed by digest", async () => {
		const bucket = new FakeBucket();
		const store = new S3BlobStore(bucket, { prefix: "memory-capsules" });
		const bytes = enc.encode("capsule bytes");
		const digest = await store.put(bytes);
		expect(digest).toBe(sha256Digest(bytes));
		expect([...bucket.objects.keys()]).toEqual([`memory-capsules/${digest}`]);
		expect(store.keyFor(digest)).toBe(`memory-capsules/${digest}`);
		expect(await store.has(digest)).toBe(true);
		expect(Buffer.from((await store.get(digest)) as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
		expect(await store.remove(digest)).toBe(true);
		expect(bucket.objects.size).toBe(0);
		expect(await store.has(digest)).toBe(false);
		expect(await store.get(digest)).toBeNull();
		expect(await store.remove(digest)).toBe(false);
	});

	test("works with no prefix, and a trailing slash is not doubled", async () => {
		const bucket = new FakeBucket();
		const bare = new S3BlobStore(bucket);
		const digest = await bare.put(enc.encode("a"));
		expect([...bucket.objects.keys()]).toEqual([digest]);
		const slash = new S3BlobStore(new FakeBucket(), { prefix: "a/b/" });
		expect(slash.keyFor(digest)).toBe(`a/b/${digest}`);
	});

	test("put is idempotent", async () => {
		const bucket = new FakeBucket();
		const store = new S3BlobStore(bucket, { prefix: "p" });
		const first = await store.put(enc.encode("same"));
		const second = await store.put(enc.encode("same"));
		expect(second).toBe(first);
		expect(bucket.objects.size).toBe(1);
	});

	test("every read verifies the digest: an object that no longer hashes to its key is refused", async () => {
		const bucket = new FakeBucket();
		const store = new S3BlobStore(bucket, { prefix: "p" });
		const digest = await store.put(enc.encode("original"));
		bucket.objects.set(`p/${digest}`, enc.encode("tampered"));
		expect(await rule(() => store.get(digest))).toBe("corrupt");
		// A put heals it: the key is the digest, so the same bytes go back.
		expect(await store.put(enc.encode("original"))).toBe(digest);
		expect(Buffer.from((await store.get(digest)) as Uint8Array).toString()).toBe("original");
	});

	test("a malformed digest is refused before the bucket is touched", async () => {
		const bucket = new FakeBucket();
		const store = new S3BlobStore(bucket, { prefix: "p" });
		for (const digest of ["../x", "p/../../y", "a".repeat(63), "A".repeat(64), "", "a/".repeat(32)]) {
			expect({ digest, rule: await rule(() => store.get(digest)) }).toEqual({ digest, rule: "bad_digest" });
			expect(await rule(() => store.has(digest))).toBe("bad_digest");
			expect(await rule(() => store.remove(digest))).toBe("bad_digest");
		}
		expect(() => store.keyFor("../x")).toThrow(BlobStoreError);
		expect(bucket.calls).toEqual([]);
	});

	test("a size over the limit is refused before the bucket is touched", async () => {
		const bucket = new FakeBucket();
		const store = new S3BlobStore(bucket, { maxBytes: 3 });
		expect(await rule(() => store.put(enc.encode("1234")))).toBe("too_large");
		expect(await rule(() => store.put("text" as unknown as Uint8Array))).toBe("io");
		expect(bucket.calls).toEqual([]);
	});

	test("backend failures surface as typed io errors with the cause kept", async () => {
		const bucket = new FakeBucket();
		const store = new S3BlobStore(bucket);
		const digest = await store.put(enc.encode("x"));
		bucket.failWith = new Error("503 SlowDown");
		for (const work of [() => store.put(enc.encode("y")), () => store.get(digest), () => store.has(digest), () => store.remove(digest)]) {
			const error = await work().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(BlobStoreError);
			expect((error as BlobStoreError).rule).toBe("io");
			expect((error as BlobStoreError).message).toContain("503 SlowDown");
			expect(((error as BlobStoreError).cause as Error).message).toBe("503 SlowDown");
		}
	});
});

describe("normalizePrefix", () => {
	test("accepts relative segments and adds a trailing slash", () => {
		expect(normalizePrefix(undefined)).toBe("");
		expect(normalizePrefix("")).toBe("");
		expect(normalizePrefix("capsules")).toBe("capsules/");
		expect(normalizePrefix("a/b.c_d-e")).toBe("a/b.c_d-e/");
		expect(normalizePrefix("a/b/")).toBe("a/b/");
	});

	test("refuses absolute paths, traversal, empty segments and odd characters", () => {
		for (const prefix of ["/abs", "a/../b", "..", ".", "a//b", "a b", "a\\b", "a?b", "a/./b", "a\0"]) {
			expect({ prefix, rule: (() => { try { normalizePrefix(prefix); return "none"; } catch (e) { return (e as BlobStoreError).rule; } })() }).toEqual({ prefix, rule: "bad_path" });
		}
	});
});
