/**
 * The durable baseline (phase 58): the directory setting, an atomic round trip through real files in a temporary directory,
 * file and directory modes, a failed rename that leaves the old file, and strict reads: a missing file is none; a corrupt,
 * oversized, misplaced or duplicated file is unusable and never a crash. No result names a path or quotes content.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BaselineStoreError,
	FileBaselineStore,
	MAX_BASELINE_BYTES,
	MAX_BASELINE_RECORDS,
	MAX_BASELINE_UNLISTED,
	PLANNING_BASELINE_DIR_ENV,
	loadBaselineDirectory,
	type StoredBaseline,
} from "./baseline-store.ts";

const KEY = "wt-0123456789abcdef01234567";
const FILE = `${KEY}.baseline.json`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const BASELINE: StoredBaseline = {
	root: "/repo",
	snapshot: {
		truncated: false,
		unlisted: [".planning/phases/53-x"],
		records: [
			{ path: ".planning/ROADMAP.md", sha256: HASH_A },
			{ path: ".planning/STATE.md", sha256: null },
		],
	},
};

const made: string[] = [];

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "baseline-store-"));
	made.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A valid file body, with `patch` applied over it. */
function body(patch: Record<string, unknown> = {}): string {
	return JSON.stringify({
		v: 1,
		key: KEY,
		root: "/repo",
		truncated: false,
		unlisted: [],
		records: [{ path: ".planning/STATE.md", sha256: HASH_A }],
		...patch,
	});
}

describe("the baseline directory setting", () => {
	test("unset or blank is no directory; an absolute path is taken trimmed", () => {
		expect(loadBaselineDirectory({})).toEqual({ ok: true, directory: null });
		expect(loadBaselineDirectory({ [PLANNING_BASELINE_DIR_ENV]: "   " })).toEqual({ ok: true, directory: null });
		expect(loadBaselineDirectory({ [PLANNING_BASELINE_DIR_ENV]: " /var/lib/substrate/baselines " })).toEqual({ ok: true, directory: "/var/lib/substrate/baselines" });
	});

	test("a relative path or one with a NUL is an error that does not echo the value", () => {
		const relative = loadBaselineDirectory({ [PLANNING_BASELINE_DIR_ENV]: "relative/dir" });
		expect(relative).toEqual({ ok: false, errors: [{ key: PLANNING_BASELINE_DIR_ENV, reason: "not-absolute" }] });
		expect(JSON.stringify(relative)).not.toContain("relative/dir");
		expect(loadBaselineDirectory({ [PLANNING_BASELINE_DIR_ENV]: "/a\0b" })).toEqual({ ok: false, errors: [{ key: PLANNING_BASELINE_DIR_ENV, reason: "invalid-characters" }] });
	});

	test("the store itself refuses a directory that is not absolute", () => {
		expect(() => new FileBaselineStore("relative/dir")).toThrow(RangeError);
	});
});

describe("saving and loading", () => {
	test("a saved baseline loads back exactly: root, documents, a null hash, truncation and unlisted directories", async () => {
		const store = new FileBaselineStore(join(await scratch(), "baselines"));
		await store.save(KEY, BASELINE);
		expect(await store.load(KEY)).toEqual({ state: "loaded", baseline: BASELINE });
		await store.save(KEY, { root: "/repo", snapshot: { truncated: true, unlisted: [], records: [{ path: ".planning/STATE.md", sha256: HASH_B }] } });
		expect(await store.load(KEY)).toEqual({
			state: "loaded",
			baseline: { root: "/repo", snapshot: { truncated: true, unlisted: [], records: [{ path: ".planning/STATE.md", sha256: HASH_B }] } },
		});
	});

	test("the file is mode 0600, a directory it creates is 0700, one that exists keeps its mode, and no temporary file is left", async () => {
		const base = await scratch();
		const created = join(base, "nested", "baselines");
		await new FileBaselineStore(created).save(KEY, BASELINE);
		expect((await stat(join(created, FILE))).mode & 0o777).toBe(0o600);
		expect((await stat(created)).mode & 0o777).toBe(0o700);
		expect(await readdir(created)).toEqual([FILE]);

		const existing = join(base, "existing");
		await mkdir(existing, { mode: 0o755 });
		await chmod(existing, 0o755);
		await new FileBaselineStore(existing).save(KEY, BASELINE);
		expect((await stat(existing)).mode & 0o777).toBe(0o755);
	});

	test("the file holds paths and hashes only, as one JSON document", async () => {
		const dir = join(await scratch(), "baselines");
		await new FileBaselineStore(dir).save(KEY, BASELINE);
		const parsed = JSON.parse(await readFile(join(dir, FILE), "utf8")) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual(["key", "records", "root", "truncated", "unlisted", "v"]);
		expect(parsed.key).toBe(KEY);
	});

	test("a crash between the temporary write and the rename leaves the old file whole, and a stray temporary file is ignored", async () => {
		const dir = join(await scratch(), "baselines");
		await new FileBaselineStore(dir).save(KEY, BASELINE);

		const crashing = new FileBaselineStore(dir, {
			rename: async () => {
				throw Object.assign(new Error("simulated crash before the rename"), { code: "EIO" });
			},
		});
		const next: StoredBaseline = { root: "/repo", snapshot: { truncated: false, unlisted: [], records: [{ path: ".planning/STATE.md", sha256: HASH_B }] } };
		const failure = await crashing.save(KEY, next).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(BaselineStoreError);
		expect(failure).toMatchObject({ code: "write-failed", detail: "EIO" });
		expect(String((failure as Error).message)).not.toContain(dir);
		// The old content is what a reader sees, and the failed attempt cleaned up after itself.
		expect(await new FileBaselineStore(dir).load(KEY)).toEqual({ state: "loaded", baseline: BASELINE });
		expect(await readdir(dir)).toEqual([FILE]);

		// A process that died after writing the temporary file leaves it behind. It is not the baseline, and a later save works.
		await writeFile(join(dir, `${FILE}.deadbeef.tmp`), '{"v":1,"half');
		expect(await new FileBaselineStore(dir).load(KEY)).toEqual({ state: "loaded", baseline: BASELINE });
		await new FileBaselineStore(dir).save(KEY, next);
		expect(await new FileBaselineStore(dir).load(KEY)).toEqual({ state: "loaded", baseline: next });
	});

	test("a directory that cannot be created is a typed write failure that names no path", async () => {
		const base = await scratch();
		await writeFile(join(base, "a-file"), "x");
		const failure = await new FileBaselineStore(join(base, "a-file", "baselines")).save(KEY, BASELINE).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(BaselineStoreError);
		expect((failure as BaselineStoreError).code).toBe("write-failed");
		expect((failure as Error).message).not.toContain(base);
	});

	test("a baseline the reader would refuse is refused at save, and nothing is written", async () => {
		const dir = join(await scratch(), "baselines");
		const store = new FileBaselineStore(dir);
		const manyRecords = Array.from({ length: MAX_BASELINE_RECORDS + 1 }, (_, index) => ({ path: `d/${index}.md`, sha256: HASH_A }));
		await expect(store.save(KEY, { root: "/repo", snapshot: { truncated: false, unlisted: [], records: manyRecords } })).rejects.toMatchObject({ code: "too-large" });
		const manyUnlisted = Array.from({ length: MAX_BASELINE_UNLISTED + 1 }, (_, index) => `d/${index}`);
		await expect(store.save(KEY, { root: "/repo", snapshot: { truncated: false, unlisted: manyUnlisted, records: [] } })).rejects.toMatchObject({ code: "too-large" });

		// Within the count limits but past the byte limit.
		const long = "p".repeat(1_000);
		const heavy = {
			root: "/repo",
			snapshot: {
				truncated: false,
				unlisted: Array.from({ length: MAX_BASELINE_UNLISTED }, (_, index) => `${long}${index}`.slice(0, 1_024)),
				records: Array.from({ length: MAX_BASELINE_RECORDS }, (_, index) => ({ path: `${long}${index}`.slice(0, 1_024), sha256: HASH_A })),
			},
		};
		await expect(store.save(KEY, heavy)).rejects.toMatchObject({ code: "too-large" });
		await expect(readdir(dir)).rejects.toThrow();
	});

	test("a key that is not a file name is refused by load and save", async () => {
		const store = new FileBaselineStore(await scratch());
		for (const bad of ["", "../escape", "a/b", ".hidden", "has space", "x".repeat(129)]) {
			await expect(store.load(bad)).rejects.toMatchObject({ code: "invalid-key" });
			await expect(store.save(bad, BASELINE)).rejects.toMatchObject({ code: "invalid-key" });
		}
	});
});

describe("strict reads", () => {
	test("a missing file, and a missing directory, are none", async () => {
		const dir = await scratch();
		expect(await new FileBaselineStore(dir).load(KEY)).toEqual({ state: "none" });
		expect(await new FileBaselineStore(join(dir, "never-created")).load(KEY)).toEqual({ state: "none" });
	});

	test("a file that is not valid JSON, is empty, or is not UTF-8 is unusable and never a crash", async () => {
		const dir = await scratch();
		const store = new FileBaselineStore(dir);
		await writeFile(join(dir, FILE), "{not json");
		expect(await store.load(KEY)).toEqual({ state: "unusable", reason: "not-json", detail: null });
		await writeFile(join(dir, FILE), "");
		expect(await store.load(KEY)).toEqual({ state: "unusable", reason: "not-json", detail: null });
		await writeFile(join(dir, FILE), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
		expect(await store.load(KEY)).toEqual({ state: "unusable", reason: "not-utf8", detail: null });
	});

	test("every deviation from the documented shape is unusable", async () => {
		const dir = await scratch();
		const store = new FileBaselineStore(dir);
		const bad: Array<Record<string, unknown>> = [
			{ v: 2 },
			{ unknownField: true },
			{ root: "" },
			{ truncated: "no" },
			{ unlisted: "none" },
			{ unlisted: [""] },
			{ records: [{ path: "a.md", sha256: "not-a-hash" }] },
			{ records: [{ path: "a.md", sha256: HASH_A.toUpperCase() }] },
			{ records: [{ path: "", sha256: HASH_A }] },
			{ records: [{ path: "a.md", sha256: HASH_A, extra: 1 }] },
			{ records: [{ path: "a.md" }] },
			{ records: "all" },
		];
		for (const patch of bad) {
			await writeFile(join(dir, FILE), body(patch));
			expect(await store.load(KEY)).toEqual({ state: "unusable", reason: "bad-shape", detail: null });
		}
		for (const raw of ["null", "[]", '"text"', "42"]) {
			await writeFile(join(dir, FILE), raw);
			expect(await store.load(KEY)).toEqual({ state: "unusable", reason: "bad-shape", detail: null });
		}
	});

	test("a file written for another worktree key, or one that names a path twice, is unusable", async () => {
		const dir = await scratch();
		const store = new FileBaselineStore(dir);
		await writeFile(join(dir, FILE), body({ key: "wt-another" }));
		expect(await store.load(KEY)).toEqual({ state: "unusable", reason: "key-mismatch", detail: null });
		await writeFile(
			join(dir, FILE),
			body({
				records: [
					{ path: "a.md", sha256: HASH_A },
					{ path: "a.md", sha256: HASH_B },
				],
			}),
		);
		expect(await store.load(KEY)).toEqual({ state: "unusable", reason: "duplicate-path", detail: null });
	});

	test("more records than the bound is unusable", async () => {
		const dir = await scratch();
		const records = Array.from({ length: MAX_BASELINE_RECORDS + 1 }, (_, index) => ({ path: `d/${index}.md`, sha256: HASH_A }));
		await writeFile(join(dir, FILE), body({ records }));
		expect(await new FileBaselineStore(dir).load(KEY)).toEqual({ state: "unusable", reason: "bad-shape", detail: null });
	});

	test("a file past the size cap is unusable without being parsed, and one at the cap is read", async () => {
		const dir = await scratch();
		const store = new FileBaselineStore(dir);
		await writeFile(join(dir, FILE), Buffer.alloc(MAX_BASELINE_BYTES + 1, 0x20));
		expect(await store.load(KEY)).toEqual({ state: "unusable", reason: "oversized", detail: null });

		// Padding is whitespace, which JSON allows: a valid body padded to exactly the cap still loads.
		const valid = body();
		await writeFile(join(dir, FILE), valid + " ".repeat(MAX_BASELINE_BYTES - Buffer.byteLength(valid)));
		expect(await store.load(KEY)).toMatchObject({ state: "loaded" });
	});

	test("something that is not a regular file is unusable", async () => {
		const dir = await scratch();
		await mkdir(join(dir, FILE));
		expect(await new FileBaselineStore(dir).load(KEY)).toEqual({ state: "unusable", reason: "not-a-file", detail: null });
	});

	test("an unusable file is replaced by the next save", async () => {
		const dir = await scratch();
		const store = new FileBaselineStore(dir);
		await writeFile(join(dir, FILE), "garbage");
		expect((await store.load(KEY)).state).toBe("unusable");
		await store.save(KEY, BASELINE);
		expect(await store.load(KEY)).toEqual({ state: "loaded", baseline: BASELINE });
	});

	test("results never carry a path or file content", async () => {
		const dir = await scratch();
		await writeFile(join(dir, FILE), "SECRET-CONTENT {not json");
		const result = await new FileBaselineStore(dir).load(KEY);
		expect(JSON.stringify(result)).not.toContain("SECRET-CONTENT");
		expect(JSON.stringify(result)).not.toContain(dir);
	});
});
