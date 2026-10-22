/**
 * The durable completion store (phase 53, SOTA-09, D53-i) and the view that says whether checkpoints are durable.
 *
 * The store keeps one append-only file of completion records, `completions.jsonl`, inside the directory named by
 * `SUBSTRATE_PLANNING_CHECKPOINT_DIR`: one JSON line per completion, each a valid `CompletionRecord` whose key is its
 * `sha256(phase, step, fileHash)`. Every insert rewrites the whole file through a temporary file in the same directory:
 * write, fsync, rename over the file, then fsync the directory. A reader therefore sees the file before or after an
 * insert, never a part of one. A crash before the rename leaves the old file, so the step runs again and records once.
 *
 * Opening the store loads every stored key. Recording a key already stored is a no-op. A file that does not parse, holds
 * a record whose key does not match its fields, or holds one key twice refuses the open: it is never repaired silently.
 * One process writes a directory at a time; the store takes no lock across processes.
 *
 * With the variable unset (or blank) the checkpoints stay in memory, and the view says they are not durable.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { CompletionRecordSchema, completionKey, type CompletionRecord, type CompletionStore } from "./checkpoint.ts";
import type { CheckpointDirectoryResult } from "./config.ts";

export const COMPLETIONS_FILE = "completions.jsonl";

export type CheckpointStoreErrorCode = "corrupt-record" | "write-failed";

export class CheckpointStoreError extends Error {
	constructor(
		readonly code: CheckpointStoreErrorCode,
		/** The 1-based line of a corrupt record, or null for a failed write. */
		readonly line: number | null,
	) {
		super(line === null ? code : `${code} at line ${line}`);
		this.name = "CheckpointStoreError";
	}
}

/** Whether completion checkpoints survive a restart. The reason names the configuration, never a path. */
export type CompletionStoreView = { durable: true } | { durable: false; reason: "checkpoint-dir-unset" | "checkpoint-dir-invalid" };

export function completionStoreView(config: CheckpointDirectoryResult): CompletionStoreView {
	if (!config.ok) return { durable: false, reason: "checkpoint-dir-invalid" };
	return config.directory === null ? { durable: false, reason: "checkpoint-dir-unset" } : { durable: true };
}

export class DurableCompletionStore implements CompletionStore {
	private readonly records: Map<string, CompletionRecord>;
	private tail: Promise<unknown> = Promise.resolve();

	private constructor(
		private readonly directory: string,
		records: Map<string, CompletionRecord>,
	) {
		this.records = records;
	}

	/** Opens the store in `directory`, creating the directory when it is absent, and loads every stored record. */
	static async open(directory: string): Promise<DurableCompletionStore> {
		await mkdir(directory, { recursive: true });
		const text = await readCompletions(join(directory, COMPLETIONS_FILE));
		return new DurableCompletionStore(directory, parseRecords(text));
	}

	putIfAbsent(key: string, record: CompletionRecord): Promise<"inserted" | "exists"> {
		return this.serial(async () => {
			if (this.records.has(key)) return "exists";
			const valid = CompletionRecordSchema.parse(record);
			if (valid.key !== key || completionKey(valid) !== key) throw new RangeError("completion key does not match its record");
			const lines = [...this.records.values(), valid].map((entry) => JSON.stringify(entry));
			await this.replaceFile(`${lines.join("\n")}\n`);
			this.records.set(key, { ...valid });
			return "inserted";
		});
	}

	async list(phase: string): Promise<CompletionRecord[]> {
		return [...this.records.values()].filter((record) => record.phase === phase).map((record) => ({ ...record }));
	}

	/** Runs one write at a time, in arrival order, so two inserts never race on the file. */
	private serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.tail.then(task);
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Writes the whole file through a temporary file in the same directory, then syncs the directory. */
	private async replaceFile(text: string): Promise<void> {
		const target = join(this.directory, COMPLETIONS_FILE);
		const temp = join(this.directory, `${COMPLETIONS_FILE}.${randomBytes(8).toString("hex")}.tmp`);
		try {
			const handle = await open(temp, "wx");
			try {
				await handle.writeFile(text);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temp, target);
		} catch {
			await rm(temp, { force: true }).catch(() => undefined);
			throw new CheckpointStoreError("write-failed", null);
		}
		await syncDirectory(this.directory);
	}
}

async function readCompletions(file: string): Promise<string> {
	try {
		return await readFile(file, "utf8");
	} catch (cause: unknown) {
		if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return "";
		throw cause;
	}
}

/** Every line must be a record whose key is its own hash, with no key repeated. The file must end with a newline. */
function parseRecords(text: string): Map<string, CompletionRecord> {
	const records = new Map<string, CompletionRecord>();
	if (text === "") return records;
	const lines = text.split("\n");
	if (lines.pop() !== "") throw new CheckpointStoreError("corrupt-record", lines.length + 1);
	for (const [index, line] of lines.entries()) {
		const record = parseRecord(line);
		if (record === null || records.has(record.key)) throw new CheckpointStoreError("corrupt-record", index + 1);
		records.set(record.key, record);
	}
	return records;
}

function parseRecord(line: string): CompletionRecord | null {
	let json: unknown;
	try {
		json = JSON.parse(line);
	} catch {
		return null;
	}
	const parsed = CompletionRecordSchema.safeParse(json);
	return parsed.success && parsed.data.key === completionKey(parsed.data) ? parsed.data : null;
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
