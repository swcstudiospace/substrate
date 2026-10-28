/**
 * The grok collector stays fail-open when the substrate refuses an emit, and it
 * says so: status and the server's error, never the event it tried to send.
 * Emits go through the shared postEvent; outcomes land in the reserved
 * counters key of the same state file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	REFUSAL_LOG_INTERVAL_MS,
	logEmitRefusal,
	pass,
	resetEmitRefusalLog,
} from "./grok.ts";

afterEach(() => {
	resetEmitRefusalLog();
});

function captureStderr(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	const patched = (chunk: Uint8Array | string, ...args: unknown[]): boolean => {
		void args;
		lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	};
	process.stderr.write = patched as typeof process.stderr.write;
	return {
		lines,
		restore: () => {
			process.stderr.write = original;
		},
	};
}

interface Fixture {
	root: string;
	logPath: string;
	line: string;
}

function sessionLogFixture(sessionEvent: Record<string, unknown>): Fixture {
	const root = mkdtempSync(join(tmpdir(), "grok-collector-"));
	const sessions = join(root, "sessions");
	const logPath = join(sessions, "not-a-path", "sess-1", "events.jsonl");
	mkdirSync(join(sessions, "not-a-path", "sess-1"), { recursive: true });
	const line = `${JSON.stringify(sessionEvent)}\n`;
	writeFileSync(logPath, line);
	process.env.GROK_SESSIONS_DIR = sessions;
	process.env.SUBSTRATE_COLLECTOR_STATE = join(root, "offsets.json");
	process.env.SUBSTRATE_STATE_DIR = join(root, "state");
	process.env.SUBSTRATE_URL = "http://127.0.0.1:9";
	delete process.env.SUBSTRATE_TOKEN;
	return { root, logPath, line };
}

const savedEnv = { ...process.env };

function restoreEnv(): void {
	for (const key of [
		"GROK_SESSIONS_DIR",
		"SUBSTRATE_COLLECTOR_STATE",
		"SUBSTRATE_STATE_DIR",
		"SUBSTRATE_URL",
		"SUBSTRATE_TOKEN",
	] as const) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
}

function savedState(root: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(root, "offsets.json"), "utf8")) as Record<string, unknown>;
}

function refusedLines(root: string): Record<string, unknown>[] {
	const body = readFileSync(join(root, "state", "refused-emits.jsonl"), "utf8");
	return body
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("logEmitRefusal", () => {
	test("writes status and the server error, and not the event", () => {
		const lines: string[] = [];
		const written = logEmitRefusal(400, "unknown kind: nope", 5_000, (line) => lines.push(line));

		expect(written).toBe(true);
		expect(lines[0]).toContain("status=400");
		expect(lines[0]).toContain("error=unknown kind: nope");
	});

	test("a repeat of the same refusal inside the interval is swallowed", () => {
		const lines: string[] = [];
		logEmitRefusal(400, "nope", 5_000, (line) => lines.push(line));
		const written = logEmitRefusal(400, "nope", 5_000 + REFUSAL_LOG_INTERVAL_MS - 1, (line) =>
			lines.push(line),
		);

		expect(written).toBe(false);
		expect(lines).toHaveLength(1);
	});

	test("varying details of one reason share a window", () => {
		const lines: string[] = [];
		logEmitRefusal(400, "invalid ts: 1", 5_000, (line) => lines.push(line));
		const written = logEmitRefusal(400, "invalid ts: 2", 6_000, (line) => lines.push(line));

		expect(written).toBe(false);
		expect(lines).toHaveLength(1);
	});
});

describe("shared emit outcomes", () => {
	test("a refusal is counted, logged without the event, and does not freeze the offset", async () => {
		const marker = "marker-tool-never-stored";
		const fixture = sessionLogFixture({ type: "tool_completed", tool_name: marker, outcome: "success" });
		const capture = captureStderr();
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "unknown kind: nope" }), { status: 400 })) as unknown as typeof fetch;
		try {
			const offsets: Record<string, number> = {};
			const result = await pass(offsets, true);

			expect(result.read).toBe(1);
			expect(result.emitted).toBe(0);
			expect(offsets[fixture.logPath]).toBe(Buffer.byteLength(fixture.line));
			const saved = savedState(fixture.root);
			expect(saved[fixture.logPath]).toBe(Buffer.byteLength(fixture.line));
			expect(saved["counters"]).toEqual({ stored: 0, refused: 1, failed: 0 });

			const lines = refusedLines(fixture.root);
			expect(lines).toHaveLength(1);
			expect(Object.keys(lines[0] ?? {}).sort()).toEqual([
				"collector",
				"error",
				"kind",
				"source",
				"status",
				"surface",
				"ts",
			]);
			expect(lines[0]).toMatchObject({ collector: "grok", source: "grok", status: 400 });
			const journal = capture.lines.join("");
			expect(journal).toContain("status=400");
			expect(journal).not.toContain(marker);
		} finally {
			globalThis.fetch = original;
			capture.restore();
			restoreEnv();
		}
	});

	test("an accepted emit counts stored and writes no refusal", async () => {
		const fixture = sessionLogFixture({ type: "turn_started", turn_number: 0, model_id: "grok-4.5" });
		const capture = captureStderr();
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response("{}", { status: 202 })) as unknown as typeof fetch;
		try {
			const offsets: Record<string, number> = {};
			const result = await pass(offsets, true);

			expect(result.read).toBe(1);
			expect(result.emitted).toBe(1);
			expect(savedState(fixture.root)["counters"]).toEqual({ stored: 1, refused: 0, failed: 0 });
			expect(capture.lines.join("")).not.toContain("refused emit");
		} finally {
			globalThis.fetch = original;
			capture.restore();
			restoreEnv();
		}
	});

	test("an unreachable substrate counts failed and stays fail-open", async () => {
		const fixture = sessionLogFixture({ type: "turn_started", turn_number: 0, model_id: "grok-4.5" });
		const capture = captureStderr();
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		try {
			const offsets: Record<string, number> = {};
			const result = await pass(offsets, true);

			expect(result.read).toBe(1);
			expect(result.emitted).toBe(0);
			expect(offsets[fixture.logPath]).toBe(Buffer.byteLength(fixture.line));
			expect(savedState(fixture.root)["counters"]).toEqual({ stored: 0, refused: 0, failed: 1 });
			const journal = capture.lines.join("");
			expect(journal).toContain("unreachable");
			expect(journal).not.toContain("ECONNREFUSED");
		} finally {
			globalThis.fetch = original;
			capture.restore();
			restoreEnv();
		}
	});

	test("counters accumulate across passes in one state file", async () => {
		const fixture = sessionLogFixture({ type: "turn_started", turn_number: 0, model_id: "grok-4.5" });
		const capture = captureStderr();
		const original = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return calls === 1
				? new Response(JSON.stringify({ error: "nope" }), { status: 400 })
				: new Response("{}", { status: 202 });
		}) as unknown as typeof fetch;
		try {
			const first = await pass({}, true);
			expect(first.emitted).toBe(0);
			const appended = `${JSON.stringify({ type: "turn_ended", outcome: "done" })}\n`;
			writeFileSync(fixture.logPath, appended, { flag: "a" });
			const second = await pass(savedState(fixture.root) as unknown as Record<string, number>, true);

			expect(second.emitted).toBe(1);
			expect(savedState(fixture.root)["counters"]).toEqual({ stored: 1, refused: 1, failed: 0 });
		} finally {
			globalThis.fetch = original;
			capture.restore();
			restoreEnv();
		}
	});
});
