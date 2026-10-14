/**
 * The Grok collector and the event spool. `pass()` advances its offsets whether
 * or not an event landed (D19-06), so with the spool on a failed event is the
 * spool's to replay; what must hold is that a re-read of the same log line
 * carries the same idempotency key, so a replay can never double-store it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grokEventKey, pass } from "./grok.ts";
import { isolateSpoolEnv } from "./spool-test-env.ts";

const GROK_KEYS = ["GROK_SESSIONS_DIR", "SUBSTRATE_COLLECTOR_STATE"] as const;
const savedGrok = { ...process.env };
let restoreSpoolEnv: () => void = () => undefined;
const realFetch = globalThis.fetch;
const realStderrWrite = process.stderr.write.bind(process.stderr);

// Every spool and credential variable is cleared before each test (spool explicitly off) and restored after it.
beforeEach(() => {
	restoreSpoolEnv = isolateSpoolEnv();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	process.stderr.write = realStderrWrite;
	restoreSpoolEnv();
	for (const key of GROK_KEYS) {
		if (savedGrok[key] === undefined) delete process.env[key];
		else process.env[key] = savedGrok[key];
	}
});

interface Fixture {
	root: string;
	stateDir: string;
	logPath: string;
	line: string;
}

function fixture(lines: Record<string, unknown>[]): Fixture {
	const root = mkdtempSync(join(tmpdir(), "grok-spool-"));
	const sessions = join(root, "sessions");
	const logPath = join(sessions, "not-a-path", "sess-1", "events.jsonl");
	mkdirSync(join(sessions, "not-a-path", "sess-1"), { recursive: true });
	const text = lines.map((entry) => `${JSON.stringify(entry)}\n`).join("");
	writeFileSync(logPath, text);
	process.env.GROK_SESSIONS_DIR = sessions;
	process.env.SUBSTRATE_COLLECTOR_STATE = join(root, "offsets.json");
	process.env.SUBSTRATE_STATE_DIR = join(root, "state");
	process.env.SUBSTRATE_URL = "http://127.0.0.1:9";
	process.stderr.write = (() => true) as typeof process.stderr.write;
	return { root, stateDir: join(root, "state"), logPath, line: text };
}

function down(): void {
	globalThis.fetch = (async () => new Response(JSON.stringify({ error: "ledger down" }), { status: 503 })) as unknown as typeof fetch;
}

function spooledKeys(stateDir: string): string[] {
	const path = join(stateDir, "event-spool.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => (JSON.parse(line) as { key: string }).key);
}

const turn = { type: "turn_started", turn_number: 0, model_id: "grok-4.5", ts: "2026-10-09T00:00:00.000Z" };

describe("grokEventKey", () => {
	test("is stable for a line at an offset and differs by offset, content, session and file", () => {
		const base = grokEventKey("/a/events.jsonl", "s1", 10, '{"x":1}');

		expect(grokEventKey("/a/events.jsonl", "s1", 10, '{"x":1}')).toBe(base);
		expect(grokEventKey("/a/events.jsonl", "s1", 11, '{"x":1}')).not.toBe(base);
		expect(grokEventKey("/a/events.jsonl", "s1", 10, '{"x":2}')).not.toBe(base);
		expect(grokEventKey("/a/events.jsonl", "s2", 10, '{"x":1}')).not.toBe(base);
		expect(grokEventKey("/b/events.jsonl", "s1", 10, '{"x":1}')).not.toBe(base);
		expect(base).toMatch(/^gk1:[0-9a-f]{64}$/);
	});
});

describe("pass with the spool on", () => {
	test("a failed event is parked under the key of its file, offset and line, and the offset still advances", async () => {
		const grok = fixture([turn]);
		process.env.SUBSTRATE_EVENT_SPOOL = "on";
		down();

		const offsets: Record<string, number> = {};
		const result = await pass(offsets, true);

		expect(result.emitted).toBe(0);
		expect(offsets[grok.logPath]).toBe(Buffer.byteLength(grok.line));
		expect(spooledKeys(grok.stateDir)).toEqual([grokEventKey(grok.logPath, "sess-1", 0, JSON.stringify(turn))]);
	});

	test("two lines in one file get different keys, by their offsets", async () => {
		const second = { ...turn, turn_number: 1 };
		const grok = fixture([turn, second]);
		process.env.SUBSTRATE_EVENT_SPOOL = "on";
		down();

		await pass({}, true);

		const first = JSON.stringify(turn);
		expect(spooledKeys(grok.stateDir)).toEqual([
			grokEventKey(grok.logPath, "sess-1", 0, first),
			grokEventKey(grok.logPath, "sess-1", Buffer.byteLength(first) + 1, JSON.stringify(second)),
		]);
	});

	test("a re-read of the same line (offsets lost) carries the same key as before", async () => {
		const grok = fixture([turn]);
		process.env.SUBSTRATE_EVENT_SPOOL = "on";
		down();

		await pass({}, true);
		await pass({}, true);

		const keys = spooledKeys(grok.stateDir);
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1] as string);
	});

	test("a stored event parks nothing", async () => {
		const grok = fixture([turn]);
		process.env.SUBSTRATE_EVENT_SPOOL = "on";
		globalThis.fetch = (async () => new Response("{}", { status: 202 })) as unknown as typeof fetch;

		const result = await pass({}, true);

		expect(result.emitted).toBe(1);
		expect(spooledKeys(grok.stateDir)).toEqual([]);
	});
});

describe("pass with the spool off", () => {
	test("a failed event is counted and dropped exactly as before: no spool file and no state-dir file at all", async () => {
		const grok = fixture([turn]);
		down();

		const result = await pass({}, true);

		expect(result.emitted).toBe(0);
		expect(existsSync(grok.stateDir)).toBe(false);
		expect(readdirSync(grok.root).sort()).toEqual(["offsets.json", "sessions"]);
	});
});
