/**
 * The grok collector stays fail-open when the substrate refuses an emit, and it
 * says so: status and the server's error, never the event it tried to send.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	REFUSAL_LOG_INTERVAL_MS,
	emitToSubstrate,
	logEmitRefusal,
	pass,
	resetEmitRefusalLog,
} from "./grok.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";

const event: EventInput = {
	surface: "grok-build",
	kind: "prompt",
	summary: "payload-secret-marker",
	payload: { secret: "payload-secret-marker" },
};

afterEach(() => {
	resetEmitRefusalLog();
});

describe("logEmitRefusal", () => {
	test("writes status and the server error, and not the event", () => {
		const lines: string[] = [];
		const wrote = logEmitRefusal(400, "unknown kind: nope", 1_000, (line) => lines.push(line));

		expect(wrote).toBe(true);
		expect(lines).toEqual(["[grok-collector] substrate refused emit: status=400 error=unknown kind: nope\n"]);
		expect(lines[0]).not.toContain("payload-secret-marker");
	});

	test("a repeat of the same refusal inside the interval is swallowed", () => {
		const lines: string[] = [];
		const write = (line: string) => lines.push(line);
		logEmitRefusal(403, "no", 1_000, write);
		const again = logEmitRefusal(403, "no", 1_000 + REFUSAL_LOG_INTERVAL_MS - 1, write);
		const later = logEmitRefusal(403, "no", 1_000 + REFUSAL_LOG_INTERVAL_MS, write);

		expect(again).toBe(false);
		expect(later).toBe(true);
		expect(lines).toHaveLength(2);
	});
});

describe("emitToSubstrate", () => {
	test("a non-ok response is logged and does not throw", async () => {
		const lines: string[] = [];
		const ok = await emitToSubstrate(event, {
			url: "http://127.0.0.1:9",
			now: () => 5_000,
			write: (line) => lines.push(line),
			fetchImpl: async () => new Response(JSON.stringify({ error: "unknown kind: nope", payload: event }), { status: 400 }),
		});

		expect(ok).toBe(false);
		expect(lines[0]).toContain("status=400");
		expect(lines[0]).toContain("error=unknown kind: nope");
		expect(lines[0]).not.toContain("payload-secret-marker");
	});

	test("an unreachable substrate is fail-open", async () => {
		const lines: string[] = [];
		const ok = await emitToSubstrate(event, {
			now: () => 6_000,
			write: (line) => lines.push(line),
			fetchImpl: async () => {
				throw new Error("connect ECONNREFUSED");
			},
		});

		expect(ok).toBe(false);
		expect(lines[0]).toContain("status=0");
		expect(lines[0]).toContain("unreachable");
		expect(lines[0]).not.toContain("payload-secret-marker");
		expect(lines[0]).not.toContain("ECONNREFUSED");
	});

	test("an accepted response logs nothing", async () => {
		const lines: string[] = [];
		const ok = await emitToSubstrate(event, {
			write: (line) => lines.push(line),
			fetchImpl: async () => new Response("{}", { status: 202 }),
		});

		expect(ok).toBe(true);
		expect(lines).toEqual([]);
	});
});

describe("pass", () => {
	test("a refusal does not block the collector or freeze the offset", async () => {
		const root = mkdtempSync(join(tmpdir(), "grok-collector-"));
		const sessions = join(root, "sessions");
		const logPath = join(sessions, "not-a-path", "sess-1", "events.jsonl");
		mkdirSync(join(sessions, "not-a-path", "sess-1"), { recursive: true });
		const line = `${JSON.stringify({ type: "turn_started", turn_number: 0, model_id: "grok-4.5" })}\n`;
		writeFileSync(logPath, line);

		const previous = {
			sessions: process.env.GROK_SESSIONS_DIR,
			state: process.env.SUBSTRATE_COLLECTOR_STATE,
		};
		process.env.GROK_SESSIONS_DIR = sessions;
		process.env.SUBSTRATE_COLLECTOR_STATE = join(root, "offsets.json");
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "nope" }), { status: 400 })) as unknown as typeof fetch;
		try {
			const offsets: Record<string, number> = {};
			const result = await pass(offsets, true);

			expect(result.read).toBe(1);
			expect(result.emitted).toBe(0);
			expect(offsets[logPath]).toBe(Buffer.byteLength(line));
			const saved = JSON.parse(readFileSync(process.env.SUBSTRATE_COLLECTOR_STATE, "utf8")) as Record<string, number>;
			expect(saved[logPath]).toBe(Buffer.byteLength(line));
		} finally {
			globalThis.fetch = original;
			if (previous.sessions === undefined) delete process.env.GROK_SESSIONS_DIR;
			else process.env.GROK_SESSIONS_DIR = previous.sessions;
			if (previous.state === undefined) delete process.env.SUBSTRATE_COLLECTOR_STATE;
			else process.env.SUBSTRATE_COLLECTOR_STATE = previous.state;
		}
	});
});
