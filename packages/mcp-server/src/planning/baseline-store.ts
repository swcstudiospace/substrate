/**
 * The observer's durable baseline (phase 58, multi-day liveness): what the ledger was last told about a checkout's planning
 * documents, kept across an observer restart. With it the first scan of a restarted observer diffs the checkout against the
 * stored baseline and publishes what changed while the observer was down, instead of taking the tree as a fresh baseline.
 *
 * A baseline holds paths and sha256 only (`PlanningSnapshot`), never document text. One file per checkout, named by its
 * worktree key (the observer's session id), inside the directory named by `SUBSTRATE_PLANNING_BASELINE_DIR`. Presence is
 * ephemeral and lives in the cache; this baseline is the durable part, so it never goes there.
 *
 * Writes are atomic: the new content goes to a temporary file in the same directory (mode 0600, created exclusively), is
 * fsync'd, then renamed over the file, and the directory is fsync'd. A crash before the rename leaves the old file whole. The
 * directory is created with mode 0700; an existing directory keeps the mode its owner gave it.
 *
 * Reads are strict. A file larger than `MAX_BASELINE_BYTES`, a file that is not UTF-8 JSON of exactly the documented shape, a
 * file written for another worktree key, and a file naming one path twice are each reported as `unusable` with a short code,
 * and the caller proceeds as with no baseline: a bad file is never a crash and is never repaired silently. A missing file is
 * `none`. No result carries a path or content.
 *
 * The directory comes from a parameter. `loadBaselineDirectory` is the pure settings loader that reads it from an env record.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, rename as renameFile, rm, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { PlanningConfigError } from "./config.ts";
import type { PlanningSnapshot } from "./diff.ts";
import { errnoCode } from "./index.ts";

/** Where the observer's baselines are kept durably. Unset or blank keeps the baseline in memory only. */
export const PLANNING_BASELINE_DIR_ENV = "SUBSTRATE_PLANNING_BASELINE_DIR";

export type BaselineDirectoryResult = { ok: true; directory: string | null } | { ok: false; errors: PlanningConfigError[] };

/** Parse the baseline directory. Set but relative or containing a NUL is an error; the path is never echoed. Unset or blank is no directory. */
export function loadBaselineDirectory(env: Readonly<Record<string, string | undefined>>): BaselineDirectoryResult {
	const directory = (env[PLANNING_BASELINE_DIR_ENV] ?? "").trim();
	if (directory.includes("\0")) return { ok: false, errors: [{ key: PLANNING_BASELINE_DIR_ENV, reason: "invalid-characters" }] };
	if (directory !== "" && !isAbsolute(directory)) return { ok: false, errors: [{ key: PLANNING_BASELINE_DIR_ENV, reason: "not-absolute" }] };
	return { ok: true, directory: directory === "" ? null : directory };
}

/** The largest baseline file read or written, in bytes. A baseline past it is refused on save and reported unusable on load. */
export const MAX_BASELINE_BYTES = 16 * 1_024 * 1_024;
/** The most documents a baseline holds: the most files the planning index may list (`PLANNING_BOUNDS.maxFiles.max`). */
export const MAX_BASELINE_RECORDS = 10_000;
/** The most unlisted directories a baseline holds. */
export const MAX_BASELINE_UNLISTED = 10_000;
const MAX_PATH_CHARS = 1_024;
const MAX_ROOT_CHARS = 4_096;

/** A worktree key is a file name: no separator, no leading dot. The observer's session id (`wt-` and a hex digest) satisfies it. */
const WORKTREE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const BASELINE_SUFFIX = ".baseline.json";

/** What the observer keeps as its publish baseline: the checkout root and the snapshot the ledger was last told about. */
export interface StoredBaseline {
	root: string;
	snapshot: PlanningSnapshot;
}

type BaselineUnusableReason = "oversized" | "not-a-file" | "not-utf8" | "not-json" | "bad-shape" | "key-mismatch" | "duplicate-path" | "unreadable";

export type BaselineLoad =
	| { state: "none" }
	| { state: "loaded"; baseline: StoredBaseline }
	/** The file exists and cannot be used. `detail` is an errno code for `unreadable`, and null otherwise. The caller proceeds as with no baseline. */
	| { state: "unusable"; reason: BaselineUnusableReason; detail: string | null };

export interface BaselineStore {
	/** The stored baseline of a checkout. Never rejects on a bad or missing file; rejects only on a key that is not a valid worktree key. */
	load(worktreeKey: string): Promise<BaselineLoad>;
	/** Replaces the stored baseline of a checkout, atomically. Rejects with a `BaselineStoreError` when it cannot. */
	save(worktreeKey: string, baseline: StoredBaseline): Promise<void>;
}

type BaselineStoreErrorCode = "invalid-key" | "too-large" | "write-failed";

export class BaselineStoreError extends Error {
	constructor(
		readonly code: BaselineStoreErrorCode,
		/** An errno code for a failed write; null for the other codes. Never a path. */
		readonly detail: string | null,
	) {
		super(detail === null ? code : `${code}: ${detail}`);
		this.name = "BaselineStoreError";
	}
}

const BaselineFileSchema = z
	.object({
		v: z.literal(1),
		key: z.string(),
		root: z.string().min(1).max(MAX_ROOT_CHARS),
		truncated: z.boolean(),
		unlisted: z.array(z.string().min(1).max(MAX_PATH_CHARS)).max(MAX_BASELINE_UNLISTED),
		records: z
			.array(z.object({ path: z.string().min(1).max(MAX_PATH_CHARS), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable() }).strict())
			.max(MAX_BASELINE_RECORDS),
	})
	.strict();

/** The file operations a save uses that a test replaces to fail one step. Production uses the real ones. */
interface BaselineFileOps {
	rename: typeof renameFile;
}

export class FileBaselineStore implements BaselineStore {
	private readonly ops: BaselineFileOps;

	constructor(
		private readonly directory: string,
		ops: Partial<BaselineFileOps> = {},
	) {
		if (!isAbsolute(directory) || directory.includes("\0")) throw new RangeError("the baseline directory must be an absolute path");
		this.ops = { rename: ops.rename ?? renameFile };
	}

	async load(worktreeKey: string): Promise<BaselineLoad> {
		assertKey(worktreeKey);
		let handle: FileHandle;
		try {
			handle = await open(this.fileFor(worktreeKey), "r");
		} catch (cause: unknown) {
			const code = errnoCode(cause);
			return code === "ENOENT" ? { state: "none" } : { state: "unusable", reason: "unreadable", detail: code };
		}
		try {
			const info = await handle.stat();
			if (!info.isFile()) return { state: "unusable", reason: "not-a-file", detail: null };
			if (info.size > MAX_BASELINE_BYTES) return { state: "unusable", reason: "oversized", detail: null };
			// One byte more than the stat says is read, so a file that grew past its size since the stat is caught.
			const buffer = Buffer.alloc(info.size + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > info.size) return { state: "unusable", reason: "oversized", detail: null };
			return parseBaseline(worktreeKey, buffer.subarray(0, bytesRead));
		} catch (cause: unknown) {
			return { state: "unusable", reason: "unreadable", detail: errnoCode(cause) };
		} finally {
			// The read is over and its result is decided: a failure to close a read-only handle changes neither.
			await handle.close().catch(() => undefined);
		}
	}

	async save(worktreeKey: string, baseline: StoredBaseline): Promise<void> {
		assertKey(worktreeKey);
		const text = serialize(worktreeKey, baseline);
		const target = this.fileFor(worktreeKey);
		const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
		try {
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			const handle = await open(temp, "wx", 0o600);
			try {
				await handle.writeFile(text);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.ops.rename(temp, target);
		} catch (cause: unknown) {
			// A failed save leaves the old file, and the temporary file is removed. If the removal fails too, the stray file is
			// inert: `load` reads only the named file, and the next save uses a new temporary name.
			await rm(temp, { force: true }).catch(() => undefined);
			throw new BaselineStoreError("write-failed", errnoCode(cause));
		}
		// The rename has landed: a failure to sync the directory loses only the durability of the new name, not the file.
		await syncDirectory(this.directory).catch(() => undefined);
	}

	private fileFor(worktreeKey: string): string {
		return join(this.directory, `${worktreeKey}${BASELINE_SUFFIX}`);
	}
}

function assertKey(worktreeKey: string): void {
	if (!WORKTREE_KEY_RE.test(worktreeKey)) throw new BaselineStoreError("invalid-key", null);
}

/** The file content of a baseline. Refuses one the reader would refuse: too many records or bytes. */
function serialize(worktreeKey: string, baseline: StoredBaseline): string {
	const { snapshot } = baseline;
	if (snapshot.records.length > MAX_BASELINE_RECORDS || snapshot.unlisted.length > MAX_BASELINE_UNLISTED) throw new BaselineStoreError("too-large", null);
	const text = JSON.stringify({
		v: 1,
		key: worktreeKey,
		root: baseline.root,
		truncated: snapshot.truncated,
		unlisted: snapshot.unlisted,
		records: snapshot.records.map((record) => ({ path: record.path, sha256: record.sha256 })),
	});
	if (Buffer.byteLength(text) > MAX_BASELINE_BYTES) throw new BaselineStoreError("too-large", null);
	return text;
}

function parseBaseline(worktreeKey: string, bytes: Uint8Array): BaselineLoad {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { state: "unusable", reason: "not-utf8", detail: null };
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { state: "unusable", reason: "not-json", detail: null };
	}
	const parsed = BaselineFileSchema.safeParse(json);
	if (!parsed.success) return { state: "unusable", reason: "bad-shape", detail: null };
	const file = parsed.data;
	if (file.key !== worktreeKey) return { state: "unusable", reason: "key-mismatch", detail: null };
	if (new Set(file.records.map((record) => record.path)).size !== file.records.length) return { state: "unusable", reason: "duplicate-path", detail: null };
	return {
		state: "loaded",
		baseline: { root: file.root, snapshot: { records: file.records, truncated: file.truncated, unlisted: file.unlisted } },
	};
}

/** Makes a rename durable: the directory's entry for the new file is synced too. */
async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
