/**
 * herdr and the event spool: a parked event is the spool's, so the pane state
 * advances and the transition is never emitted a second time; and the replay
 * tick is single-flight, `unref`'d, absent with the flag off, and gone after
 * `stop()`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmitOutcome } from "./emit.ts";
import { HerdrCollector } from "./herdr.ts";
import type { HerdrPane } from "./herdr-map.ts";
import { isolateSpoolEnv } from "./spool-test-env.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";

let restoreEnv: () => void = () => undefined;
let server: Server | undefined;
let collector: HerdrCollector | undefined;
let panes: HerdrPane[] = [];

beforeEach(() => {
	restoreEnv = isolateSpoolEnv();
});

afterEach(() => {
	collector?.stop();
	collector = undefined;
	server?.close();
	server = undefined;
	panes = [];
	restoreEnv();
});

/** A herdr socket that answers `session.snapshot` with the current `panes` and nothing else. */
async function listen(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "herdr-spool-sock-"));
	const socketPath = join(dir, "herdr.sock");
	server = createServer((socket) => {
		let buf = "";
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			for (let idx = buf.indexOf("\n"); idx >= 0; idx = buf.indexOf("\n")) {
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				const msg = JSON.parse(line) as { id?: string; method?: string };
				if (msg.method !== "session.snapshot") continue;
				socket.write(`${JSON.stringify({ id: msg.id, result: { type: "session_snapshot", snapshot: { panes } } })}\n`);
				socket.end();
			}
		});
		socket.on("error", () => undefined);
	});
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(socketPath, resolve);
	await promise;
	return socketPath;
}

const working: HerdrPane = { pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "working", cwd: "/tmp/repo" };

function build(socketPath: string, post: (event: EventInput) => Promise<EmitOutcome>, extra: { drain?: () => Promise<unknown>; drainMs?: number } = {}): HerdrCollector {
	return new HerdrCollector({
		socketPath,
		statePath: join(mkdtempSync(join(tmpdir(), "herdr-spool-state-")), "herdr-offsets.json"),
		debounceMs: 5,
		pollMs: 3_600_000,
		post,
		attribute: () => ({ repo: "swcstudiospace/agent-substrate", branch: "main" }),
		now: () => "2026-10-09T00:00:00.000Z",
		...extra,
	});
}

describe("a spooled transition", () => {
	test("is not emitted again on the next pass, and is not counted emitted", async () => {
		const socketPath = await listen();
		const posted: EventInput[] = [];
		collector = build(socketPath, async (event) => {
			posted.push(event);
			return { kind: "failed", status: 503, error: "ledger down", spooled: true };
		});
		panes = [working];
		await collector.runPass();
		panes = [{ ...working, agent_status: "idle" }];

		const changed = await collector.runPass();
		const again = await collector.runPass();

		expect(changed).toEqual({ emitted: 0, failed: 0 });
		expect(again).toEqual({ emitted: 0, failed: 0 });
		expect(posted.map((event) => event.kind)).toEqual(["note"]);
	});

	test("a failure that was NOT spooled still blocks and is retried next pass, as today", async () => {
		const socketPath = await listen();
		const posted: EventInput[] = [];
		collector = build(socketPath, async (event) => {
			posted.push(event);
			return { kind: "failed", status: 503, error: "ledger down" };
		});
		panes = [working];
		await collector.runPass();
		panes = [{ ...working, agent_status: "idle" }];

		const first = await collector.runPass();
		await collector.runPass();

		expect(first).toEqual({ emitted: 0, failed: 1 });
		expect(posted.map((event) => event.kind)).toEqual(["note", "note"]);
	});
});

describe("the replay tick", () => {
	test("is single-flight: a pass still running is never overlapped", async () => {
		process.env.SUBSTRATE_EVENT_SPOOL = "on";
		const socketPath = await listen();
		let calls = 0;
		let active = 0;
		let maxActive = 0;
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		collector = build(socketPath, async () => ({ kind: "stored" }), {
			drainMs: 2,
			drain: async () => {
				calls += 1;
				active += 1;
				maxActive = Math.max(maxActive, active);
				entered.resolve();
				await gate.promise;
				active -= 1;
			},
		});

		collector.startWatch();
		await entered.promise;
		// Real timers on purpose: the claim is that interval ticks are skipped while a pass runs.
		await new Promise((resolve) => setTimeout(resolve, 40));
		const whileRunning = calls;
		gate.resolve();

		expect(whileRunning).toBe(1);
		expect(maxActive).toBe(1);
	});

	test("is unref'd, and stop() clears it so no further pass starts", async () => {
		const socketPath = await listen();
		let calls = 0;
		const first = Promise.withResolvers<void>();
		collector = build(socketPath, async () => ({ kind: "stored" }), {
			drainMs: 2,
			drain: async () => {
				calls += 1;
				first.resolve();
			},
		});

		collector.startWatch();
		const timer = (collector as unknown as { drainTimer: { hasRef: () => boolean } | undefined }).drainTimer;
		expect(timer?.hasRef()).toBe(false);
		await first.promise;
		collector.stop();
		const stoppedAt = calls;
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(calls).toBe(stoppedAt);
		expect((collector as unknown as { drainTimer: unknown }).drainTimer).toBeUndefined();
	});

	test("with the flag off there is no tick at all", async () => {
		process.env.SUBSTRATE_EVENT_SPOOL = "off";
		const socketPath = await listen();
		collector = build(socketPath, async () => ({ kind: "stored" }), { drainMs: 2 });

		collector.startWatch();

		expect((collector as unknown as { drainTimer: unknown }).drainTimer).toBeUndefined();
	});
});
