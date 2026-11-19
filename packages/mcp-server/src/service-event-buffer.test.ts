import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "./config.ts";
import { Substrate, type ForgetCaller } from "./service.ts";
import type { ForgetRequest } from "./memory-forget.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

/**
 * A ledger that stores rows the way the real client does: `insertEvent` with `mayExist` leaves a row that is already there
 * alone. `down` makes every write fail, and `lostReplies` makes writes land and then report a timeout.
 */
function fakeLedger() {
	const state = { rows: [] as SubstrateEvent[], attempts: 0, down: false, lostReplies: 0 };
	const tips = new Map<string, string>();
	const greptime = {
		timeoutMs: 5_000,
		// The rollback's note read (`GreptimeClient.queryEvents`), answered from the rows this fake keeps.
		queryEvents: async (query: { match: Record<string, unknown>; limit: number }) =>
			state.rows
				.filter((row) => Object.entries(query.match).every(([column, value]) => Reflect.get(row, column) === value))
				.reverse()
				.slice(0, query.limit)
				.map((row) => ({ ...row, ts: Date.parse(row.ts), payload: JSON.stringify(row.payload) })),
		ensureAppendMode: async () => true,
		lastHash: async (session: string): Promise<string | null> => tips.get(session) ?? null,
		insertEvent: async (event: SubstrateEvent, options: { mayExist?: boolean } = {}): Promise<void> => {
			state.attempts += 1;
			if (state.down) throw new Error("greptime unreachable: connect ETIMEDOUT");
			if (options.mayExist === true && state.rows.some((row) => row.id === event.id)) return;
			state.rows.push(event);
			if (event.session_id !== null) tips.set(event.session_id, event.hash);
			if (state.lostReplies > 0) {
				state.lostReplies -= 1;
				throw new Error("greptime timed out waiting for the reply");
			}
		},
	};
	return { state, greptime };
}

const dirs: string[] = [];

/** The buffer's two files in a fresh directory, and the environment that turns the buffer on with them. */
function telemetry(extra: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "telemetry-buffer-"));
	dirs.push(dir);
	const bufferPath = join(dir, "buffer.jsonl");
	const deadPath = join(dir, "dead.jsonl");
	return { bufferPath, deadPath, env: { SUBSTRATE_EVENT_BUFFER_PATH: bufferPath, SUBSTRATE_EVENT_DEAD_LETTER_PATH: deadPath, ...extra } };
}

/** Every substrate a test built: each is abandoned after its test, which stops its timer and keeps a durable buffer for the next boot. */
const opened: Substrate[] = [];

function substrateFor(env: Record<string, string>, greptime: unknown): Substrate {
	const substrate = new Substrate(loadConfig(env), { index: null, greptime: greptime as never });
	opened.push(substrate);
	return substrate;
}

const input = (summary: string, session = "s-1"): EventInput => ({ surface: "omp", kind: "note", summary, session_id: session });

function readRecords(path: string): Array<Record<string, unknown>> {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
	for (const substrate of opened.splice(0)) await substrate.drainPendingEvents(50, { abandon: true });
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the telemetry buffer", () => {
	test("a failed write is buffered, not dropped, and lands once the ledger is back", async () => {
		const t = telemetry();
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.down = true;

		const queued = await substrate.emit(input("first"));
		expect(queued).toMatchObject({ stored: false, buffered: true });
		expect(queued.error).toContain("unreachable");
		expect((await substrate.health()).eventBuffer).toMatchObject({ enabled: true, depth: 1, deadLetter: { depth: 0 } });

		state.down = false;
		await substrate.drainEventBuffer({ all: true });

		expect(state.rows.map((row) => row.id)).toEqual([queued.event.id]);
		expect((await substrate.health()).eventBuffer).toMatchObject({ enabled: true, depth: 0 });
	});

	test("a later event of the session waits behind the buffered one, and both land once, in order", async () => {
		const t = telemetry();
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.down = true;

		const first = await substrate.emit(input("first"));
		const second = await substrate.emit(input("second"));
		expect(second).toMatchObject({ stored: false, buffered: true });
		expect(second.event.prev).toBe(first.event.hash);

		state.down = false;
		await substrate.drainEventBuffer({ all: true });

		expect(state.rows.map((row) => row.summary)).toEqual(["first", "second"]);
		expect(state.rows[1]?.prev).toBe(state.rows[0]?.hash);
	});

	test("a write that landed but lost its reply is not stored a second time on retry", async () => {
		const t = telemetry();
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.lostReplies = 1;

		const result = await substrate.emit(input("ambiguous"));
		expect(result).toMatchObject({ stored: false, buffered: true });

		await substrate.drainEventBuffer({ all: true });
		expect(state.rows.filter((row) => row.id === result.event.id)).toHaveLength(1);
	});

	test("a write that exhausts its budget is dead-lettered with its hash and its reason", async () => {
		const t = telemetry({ SUBSTRATE_EVENT_BUFFER_MAX_ATTEMPTS: "3" });
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.down = true;

		const result = await substrate.emit(input("doomed"));
		await substrate.drainEventBuffer({ all: true });
		await substrate.drainEventBuffer({ all: true });

		expect(state.rows).toEqual([]);
		expect(readRecords(t.deadPath)).toMatchObject([
			{ reason: "exhausted", event_id: result.event.id, event_hash: result.event.hash, attempts: 3 },
		]);
		expect(await substrate.health()).toMatchObject({ eventBuffer: { enabled: true, depth: 0, deadLetter: { depth: 1, durable: true } } });
	});

	test("overflow dead-letters the oldest buffered event and its session's later events, and never drops them silently", async () => {
		const t = telemetry({ SUBSTRATE_EVENT_BUFFER_MAX: "3" });
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.down = true;

		const a = await substrate.emit(input("a", "s-1"));
		const b = await substrate.emit(input("b", "s-1"));
		await substrate.emit(input("c", "s-2"));
		const d = await substrate.emit(input("d", "s-3"));

		expect(d).toMatchObject({ stored: false, buffered: true });
		expect(readRecords(t.deadPath).map((record) => [record.event_id, record.reason])).toEqual([
			[a.event.id, "overflow"],
			[b.event.id, "predecessor-dead-lettered"],
		]);
		expect(await substrate.health()).toMatchObject({ eventBuffer: { enabled: true, depth: 2, max: 3 } });
	});

	test("a keyed replay of a queued event answers that event and writes nothing", async () => {
		const t = telemetry({ SUBSTRATE_EVENT_IDEMPOTENCY: "accept" });
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.down = true;
		const keyed: EventInput = { ...input("keyed"), idempotency_key: "replay-key-0001" };

		const first = await substrate.emit(keyed);
		const replay = await substrate.emit(keyed);
		expect(replay).toMatchObject({ stored: false, buffered: true });
		expect(replay.event.id).toBe(first.event.id);

		state.down = false;
		await substrate.drainEventBuffer({ all: true });
		expect(state.rows.map((row) => row.id)).toEqual([first.event.id]);
	});

	test("a restart re-reads the buffer, and the event that was waiting lands once", async () => {
		const t = telemetry();
		const before = fakeLedger();
		before.state.down = true;
		const first = substrateFor(t.env, before.greptime);
		const waiting = await first.emit(input("kept"));
		// Stops the first process's timer and keeps the durable buffer, as a shutdown does.
		await first.drainPendingEvents(50, { abandon: true });

		const after = fakeLedger();
		const second = substrateFor(t.env, after.greptime);
		expect((await second.health()).eventBuffer).toMatchObject({ enabled: true, depth: 1, durable: true });
		await second.drainEventBuffer({ all: true });

		expect(after.state.rows.map((row) => row.id)).toEqual([waiting.event.id]);
	});

	test("with the buffer unset, a failed write answers stored false, buffers nothing and writes nothing later", async () => {
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor({}, greptime);
		state.down = true;

		const result = await substrate.emit(input("unbuffered"));
		expect(result).toMatchObject({ stored: false });
		expect(result.error).toContain("unreachable");
		expect(result.buffered).toBeUndefined();
		expect(result.deadLettered).toBeUndefined();
		expect(await substrate.health()).toMatchObject({ eventBuffer: { enabled: false } });

		state.down = false;
		await substrate.drainEventBuffer({ all: true });
		expect(state.rows).toEqual([]);
	});
});

describe("/healthz and the flags", () => {
	test("the health body reports the buffer's depth and the dead-letter depth, each with its durability", async () => {
		const t = telemetry({ SUBSTRATE_EVENT_BUFFER_MAX: "5" });
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.down = true;
		await substrate.emit(input("waiting"));

		expect(await substrate.health()).toMatchObject({
			eventBuffer: { enabled: true, depth: 1, max: 5, durable: true, deadLetter: { depth: 0, durable: true } },
		});
	});

	test("a buffer with no dead-letter path refuses boot, and the message names the missing variable", () => {
		expect(() => loadConfig({ SUBSTRATE_EVENT_BUFFER_PATH: "/var/lib/substrate/buffer.jsonl" })).toThrow(ConfigError);
		expect(() => loadConfig({ SUBSTRATE_EVENT_BUFFER_PATH: "/var/lib/substrate/buffer.jsonl" })).toThrow(/SUBSTRATE_EVENT_DEAD_LETTER_PATH/);
	});

	test("the buffer is off unless its path is set, and the bound comes from the flag with an unusable value falling back", () => {
		expect(loadConfig({}).eventBuffer).toBeNull();
		const on = { SUBSTRATE_EVENT_BUFFER_PATH: "/var/lib/substrate/buffer.jsonl", SUBSTRATE_EVENT_DEAD_LETTER_PATH: "/var/lib/substrate/dead.jsonl" };
		expect(loadConfig({ ...on, SUBSTRATE_EVENT_BUFFER_MAX: "2" }).eventBuffer?.max).toBe(2);
		expect(loadConfig({ ...on, SUBSTRATE_EVENT_BUFFER_MAX: "0" }).eventBuffer?.max).toBe(256);
		expect(loadConfig(on).eventBuffer).toMatchObject({
			path: "/var/lib/substrate/buffer.jsonl",
			deadLetterPath: "/var/lib/substrate/dead.jsonl",
			maxAttempts: 10,
			backoffMs: 1000,
			backoffCapMs: 60_000,
		});
	});
});

describe("a write settles the session's parked events first", () => {
	test("a later write settles the parked event first once the ledger is back, and chains onto it", async () => {
		const t = telemetry();
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.down = true;

		const first = await substrate.emit(input("first"));
		expect(first.buffered).toBe(true);

		state.down = false;
		const second = await substrate.emit(input("second"));
		expect(second).toMatchObject({ stored: true });
		expect(second.event.prev).toBe(first.event.hash);
		expect(state.rows.map((row) => row.summary)).toEqual(["first", "second"]);
		expect((await substrate.health()).eventBuffer).toMatchObject({ depth: 0 });
	});

	test("a settle the ledger never answers holds a write for one call's budget at most, and the write parks behind the session's tip", async () => {
		const t = telemetry();
		const ledger = fakeLedger();
		let hung = false;
		const release = Promise.withResolvers<void>();
		let blockedInserts = 0;
		const greptime = {
			...ledger.greptime,
			timeoutMs: 150,
			insertEvent: async (event: SubstrateEvent, options: { mayExist?: boolean } = {}): Promise<void> => {
				if (!hung) return ledger.greptime.insertEvent(event, options);
				blockedInserts += 1;
				await release.promise;
				return ledger.greptime.insertEvent(event, options);
			},
		};
		const substrate = substrateFor(t.env, greptime);
		ledger.state.down = true;
		const parked = await substrate.emit(input("first"));
		expect(parked.buffered).toBe(true);

		hung = true;
		const started = performance.now();
		const next = await substrate.emit(input("second"));
		const elapsed = performance.now() - started;

		expect(next).toMatchObject({ stored: false, buffered: true });
		expect(next.event.prev).toBe(parked.event.hash);
		expect(elapsed).toBeLessThan(150 + 500);
		// The settle's one blocked attempt. The write itself asked the ledger for no insert.
		expect(blockedInserts).toBe(1);

		// The ledger answers again: the blocked attempt lands, and the parked events land in chain order.
		ledger.state.down = false;
		release.resolve();
		await substrate.drainEventBuffer({ all: true });
		expect(ledger.state.rows.map((row) => row.summary)).toEqual(["first", "second"]);
		expect(ledger.state.rows[1]?.prev).toBe(ledger.state.rows[0]?.hash);
	});
});

describe("shutdown stops the drain tick, and a zero budget touches no ledger", () => {
	test("a write after the close parks without re-arming the tick; an open instance holding the same event delivers it", async () => {
		const closedEnv = telemetry({ SUBSTRATE_EVENT_BUFFER_BACKOFF_MS: "200" });
		const openEnv = telemetry({ SUBSTRATE_EVENT_BUFFER_BACKOFF_MS: "200" });
		const closedLedger = fakeLedger();
		const openLedger = fakeLedger();
		closedLedger.state.down = true;
		openLedger.state.down = true;
		const closed = substrateFor(closedEnv.env, closedLedger.greptime);
		const open = substrateFor(openEnv.env, openLedger.greptime);
		expect((await closed.emit(input("kept"))).buffered).toBe(true);
		expect((await open.emit(input("kept"))).buffered).toBe(true);
		await closed.drainPendingEvents(0, { abandon: true });

		// A write after the close still parks, but must not re-arm the tick the close stopped.
		expect((await closed.emit(input("after close"))).buffered).toBe(true);
		closedLedger.state.down = false;
		openLedger.state.down = false;
		// The tick is a real interval with no clock to inject: four seconds clears the 200 ms backoff and several 1 s ticks.
		await Bun.sleep(4_000);

		expect(closedLedger.state.rows).toEqual([]);
		expect(openLedger.state.rows.map((row) => row.summary)).toEqual(["kept"]);
	});

	test("a shutdown with a zero budget makes no ledger call, and the parked event stays for the next pass", async () => {
		const t = telemetry();
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.down = true;
		await substrate.emit(input("waiting"));

		state.down = false;
		const attempts = state.attempts;
		await substrate.drainPendingEvents(0, { abandon: true });
		expect(state.attempts).toBe(attempts);
		expect(state.rows).toEqual([]);
		expect((await substrate.health()).eventBuffer).toMatchObject({ depth: 1, durable: true });
	});
});

describe("a parked claim is recorded", () => {
	test("a claim whose event is parked is recorded, so its node is not released", async () => {
		const t = telemetry();
		const { state, greptime } = fakeLedger();
		const released: unknown[] = [];
		const index = {
			claimNode: async (graph_id: string, node_id: string, surface: string, session_id: string) => ({
				claimed: true,
				node: { graph_id, node_id, linear_identifier: "SPE-1" },
				lease: { lease_id: "lse_1", epoch: 1, expires_at: "2026-09-30T12:15:00.000Z", state: "held" },
				decision: {
					action: "granted",
					granted: true,
					lease_id: "lse_1",
					epoch: 1,
					observed_epoch: 0,
					ttl_seconds: 900,
					evicted: null,
					holder: { surface, session_id },
					observed_expiry: null,
					reason: null,
				},
			}),
			getGraph: async () => ({ repo: "r", branch: "main" }),
			releaseNode: async (...args: unknown[]) => {
				released.push(args);
				return { released: true };
			},
		};
		const substrate = new Substrate(loadConfig(t.env), { index: index as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });
		opened.push(substrate);
		state.down = true;

		const result = await substrate.claimNode("ut-1", "n4", "omp", "sess-1", null);
		expect(result.claimed).toBe(true);
		expect(state.rows).toEqual([]);
		expect(released).toEqual([]);
	});
});

describe("a rollback's repeated forget note", () => {
	test("a repeat writes a note only when it finishes more plane deletions than the notes already recorded", async () => {
		const saved = { url: process.env.HINDSIGHT_URL, key: process.env.HINDSIGHT_API_KEY, banks: process.env.HINDSIGHT_BANKS };
		process.env.HINDSIGHT_URL = "http://fake";
		process.env.HINDSIGHT_API_KEY = "test-bearer";
		process.env.HINDSIGHT_BANKS = "sub-cursor";
		try {
			const { state, greptime } = fakeLedger();
			let planeDown = true;
			const hindsightFetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
				if ((init?.method ?? "GET").toUpperCase() !== "DELETE") return new Response(null, { status: 404 });
				return planeDown ? Response.json({ detail: "injected" }, { status: 503 }) : Response.json({ detail: "document not found" }, { status: 404 });
			};
			const index = {
				readEntry: async (id: string) => ({
					id,
					writer: "cursor",
					scope: "graph",
					kind: "fact",
					text: "remember this",
					created: "2026-11-01T00:00:00.000Z",
					idempotency_key: `idem-${id}`,
					session_id: "s-1",
				}),
				markMemoryForgotten: async (ids: string[]) => ids,
				memoryDocumentShared: async () => false,
			};
			const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never, hindsightFetch: hindsightFetch as never, steering: { history: null, liveSessions: null } });
			opened.push(substrate);
			const request: ForgetRequest = { reason: "operator", entry_ids: ["mem-forget-1"], actor: "human" };
			const caller: ForgetCaller = { surface: "omp", session_id: "s-1" };
			const notePending = () =>
				state.rows
					.filter((row) => row.payload["action"] === "memory.forget")
					.map((row) => {
						const plane = row.payload["plane"];
						return plane !== null && typeof plane === "object" && "pending" in plane ? plane.pending : null;
					});

			await substrate.memoryForget(request, caller);
			expect(notePending()).toEqual([1]);

			planeDown = false;
			await substrate.memoryForget(request, caller);
			expect(notePending()).toEqual([1, 0]);

			// Nothing is left to finish: this repeat reports no more pending than the notes already show, so it writes no note.
			await substrate.memoryForget(request, caller);
			expect(notePending()).toEqual([1, 0]);
		} finally {
			if (saved.url === undefined) delete process.env.HINDSIGHT_URL;
			else process.env.HINDSIGHT_URL = saved.url;
			if (saved.key === undefined) delete process.env.HINDSIGHT_API_KEY;
			else process.env.HINDSIGHT_API_KEY = saved.key;
			if (saved.banks === undefined) delete process.env.HINDSIGHT_BANKS;
			else process.env.HINDSIGHT_BANKS = saved.banks;
		}
	});
});
