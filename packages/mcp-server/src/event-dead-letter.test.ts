import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEvent } from "./event.ts";
import { DeadLetterStore } from "./event-dead-letter.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dead-letter-"));
	dirs.push(dir);
	return dir;
}

const event = normalizeEvent({ surface: "omp", kind: "note", summary: "never landed", session_id: "s-1" }, null);

describe("DeadLetterStore", () => {
	test("a record carries the event's hash and the reason, and survives a restart", () => {
		const path = join(tempDir(), "dead.jsonl");
		const store = new DeadLetterStore({ path });

		const record = store.record({ event, attempts: 10, enqueued_at: 0, last_reason: "unreachable" }, "exhausted");

		expect(store.durable).toBe(true);
		expect(store.depth()).toBe(1);
		const reopened = new DeadLetterStore({ path });
		expect(reopened.depth()).toBe(1);
		expect(reopened.records()).toMatchObject([{ id: record.id, reason: "exhausted", event_hash: event.hash, attempts: 10, last_reason: "unreachable" }]);
	});

	test("a memory-only store keeps its records and reports that it is not durable", () => {
		const store = new DeadLetterStore();

		store.record({ event, attempts: 1, enqueued_at: 0, last_reason: "unreachable" }, "overflow");

		expect(store.durable).toBe(false);
		expect(store.depth()).toBe(1);
		expect(store.records()).toMatchObject([{ reason: "overflow", event_hash: event.hash }]);
	});

	test("a failed append holds the records in memory and reports the store as not durable", () => {
		// The parent of the path is a regular file, so the directory cannot be created and the append cannot land.
		const dir = tempDir();
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		const store = new DeadLetterStore({ path: join(blocker, "dead.jsonl") });

		store.record({ event, attempts: 1, enqueued_at: 0, last_reason: "unreachable" }, "abandoned");

		expect(store.durable).toBe(false);
		expect(store.depth()).toBe(1);
		expect(store.records()).toHaveLength(1);
	});
});

describe("DeadLetterStore boot read", () => {
	test("a file that cannot be read at boot is not durable, since the records on it are unknown", () => {
		// A directory: the read fails with EISDIR, which is not an empty history.
		expect(new DeadLetterStore({ path: tempDir() }).durable).toBe(false);
	});

	test("a history longer than one read is counted in full, and a torn line is skipped", () => {
		const path = join(tempDir(), "dead.jsonl");
		const big = normalizeEvent({ surface: "omp", kind: "note", summary: "y".repeat(4000), session_id: "s-1" }, null);
		const store = new DeadLetterStore({ path });
		for (let i = 0; i < 40; i++) store.record({ event: big, attempts: 1, enqueued_at: 0, last_reason: "unreachable" }, "exhausted");
		appendFileSync(path, "{torn\n");

		expect(new DeadLetterStore({ path }).depth()).toBe(40);
	});
});
