import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "./config.ts";
import { GreptimeBreakerOpen } from "./greptime.ts";
import { Substrate, type SubstrateObserver } from "./service.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

/**
 * A ledger that stores rows the way the real client does: `insertEvent` with `mayExist` leaves a row that is already there
 * alone. `down` makes every write fail, and `lostReplies` makes writes land and then report a timeout.
 */
function fakeLedger() {
	const state = { rows: [] as SubstrateEvent[], attempts: 0, down: false, lostReplies: 0, breakerOpen: false, lookupDown: false, gate: null as null | (() => Promise<void>) };
	const tips = new Map<string, string>();
	const greptime = {
		ensureAppendMode: async () => true,
		lastHash: async (session: string): Promise<string | null> => tips.get(session) ?? null,
		findByIdempotencyKey: async (_cell: unknown, key: string): Promise<{ id: string; hash: string } | null> => {
			if (state.lookupDown) throw new Error("greptime unreachable: lookup timed out");
			const row = state.rows.find((stored) => stored.payload._ik === key);
			return row === undefined ? null : { id: row.id, hash: row.hash };
		},
		cursorPosition: async (id: string): Promise<{ id: string } | null> => (state.rows.some((row) => row.id === id) ? { id } : null),
		insertEvent: async (event: SubstrateEvent, options: { mayExist?: boolean } = {}): Promise<void> => {
			state.attempts += 1;
			if (state.breakerOpen) throw new GreptimeBreakerOpen("greptime breaker open");
			if (state.down) throw new Error("greptime unreachable: connect ETIMEDOUT");
			if (state.gate !== null) await state.gate();
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

function substrateFor(env: Record<string, string>, greptime: unknown, observer?: SubstrateObserver): Substrate {
	const substrate = new Substrate(loadConfig(env), { index: null, greptime: greptime as never }, observer);
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

	test("a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back", async () => {
		const t = telemetry({ SUBSTRATE_CORPUS: "on" });
		const { state, greptime } = fakeLedger();
		const observed: number[] = [];
		const substrate = substrateFor(t.env, greptime, { syncLag: ({ seconds }) => { observed.push(seconds); } });
		state.down = true;

		const held = await substrate.emit({ surface: "omp", kind: "note", summary: "docs sync", session_id: "docs-sync:t", payload: { action: "docs.sync", runtime: "corpus-sync", lag_s: 4000 } });
		expect(held).toMatchObject({ stored: false, buffered: true });
		expect((await substrate.fabricSources().corpus()).readings.syncLagS).toBe(4000);
		expect(observed).toEqual([4000]);

		state.down = false;
		await substrate.drainEventBuffer({ all: true });
		expect(state.rows.map((row) => row.id)).toEqual([held.event.id]);
		expect((await substrate.fabricSources().corpus()).readings.syncLagS).toBe(4000);
		expect(observed).toEqual([4000]);
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

	test("a service that shuts down while a dead-letter file cannot be written reports each held record on stderr, and no summary text", async () => {
		// Neither file can be created under a regular file, so the buffer's save fails as well as the dead-letter write. A buffer that
		// cannot be saved is the one that abandons what it holds at shutdown, and the held record is reported from there.
		const dir = mkdtempSync(join(tmpdir(), "telemetry-buffer-"));
		dirs.push(dir);
		const blocker = join(dir, "not-a-directory");
		writeFileSync(blocker, "");
		const env = {
			SUBSTRATE_EVENT_BUFFER_PATH: join(blocker, "buffer.jsonl"),
			SUBSTRATE_EVENT_DEAD_LETTER_PATH: join(blocker, "dead.jsonl"),
			SUBSTRATE_EVENT_BUFFER_MAX_ATTEMPTS: "3",
		};
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(env, greptime);
		state.down = true;

		const summary = "held event text that must never reach stderr";
		const result = await substrate.emit(input(summary));
		await substrate.drainEventBuffer({ all: true });
		await substrate.drainEventBuffer({ all: true });
		expect(await substrate.health()).toMatchObject({ eventBuffer: { deadLetter: { depth: 1, durable: false } } });

		// The shutdown is the call `index.ts` makes: `drainPendingEvents` with `abandon`. Only its stderr output is captured.
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		let lines: string[];
		try {
			await substrate.drainPendingEvents(50, { abandon: true });
			lines = stderr.mock.calls.map((call) => String(call[0]));
		} finally {
			stderr.mockRestore();
		}

		expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
			{ event_id: result.event.id, hash: result.event.hash, reason: "exhausted" },
		]);
		for (const line of lines) expect(line).not.toContain(summary);
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

describe("the telemetry buffer's refusals, replays and config", () => {
	test("a delivery the breaker refused is not an attempt: the event keeps its budget and lands once the breaker closes", async () => {
		const t = telemetry({ SUBSTRATE_EVENT_BUFFER_MAX_ATTEMPTS: "2" });
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.down = true;
		const queued = await substrate.emit(input("refused"));
		state.down = false;
		state.breakerOpen = true;

		await substrate.drainEventBuffer({ all: true });
		expect(await substrate.health()).toMatchObject({ eventBuffer: { depth: 1, deadLetter: { depth: 0 } } });

		state.breakerOpen = false;
		await substrate.drainEventBuffer({ all: true });
		expect(state.rows.map((row) => row.id)).toEqual([queued.event.id]);
	});

	test("a keyed event queued behind a failed replay lookup still answers as queued, and nothing is appended", async () => {
		const t = telemetry({ SUBSTRATE_EVENT_IDEMPOTENCY: "enforce" });
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.down = true;
		const keyed: EventInput = { ...input("lookup"), idempotency_key: "replay-key-0003" };
		const first = await substrate.emit(keyed);
		state.lookupDown = true;

		const replay = await substrate.emit(keyed);

		expect(replay).toMatchObject({ stored: false, buffered: true });
		expect(replay.event.id).toBe(first.event.id);
		expect(state.rows).toEqual([]);
	});

	test("a keyed replay waits for the buffered delivery of its key, so it reads the ledger only after that write settles", async () => {
		const t = telemetry({ SUBSTRATE_EVENT_IDEMPOTENCY: "enforce" });
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.down = true;
		const keyed: EventInput = { surface: "omp", kind: "note", summary: "keyed", idempotency_key: "replay-key-0002" };
		const first = await substrate.emit(keyed);
		expect(first).toMatchObject({ stored: false, buffered: true });

		state.down = false;
		const release = Promise.withResolvers<void>();
		const inFlight = Promise.withResolvers<void>();
		state.gate = async () => {
			inFlight.resolve();
			await release.promise;
		};
		const delivery = substrate.drainEventBuffer({ all: true });
		await inFlight.promise;
		// Issued while the delivery holds the key's turn: it must not read the ledger until that write has settled.
		const replay = substrate.emit(keyed);

		state.gate = null;
		release.resolve();
		await delivery;
		const answered = await replay;

		expect(answered).toMatchObject({ stored: true, deduplicated: true });
		expect(answered.event.id).toBe(first.event.id);
		expect(state.rows.map((row) => row.id)).toEqual([first.event.id]);
	});

	test("the buffer and the dead-letter store cannot name one file", () => {
		const t = telemetry();
		expect(() => loadConfig({ ...t.env, SUBSTRATE_EVENT_DEAD_LETTER_PATH: t.bufferPath })).toThrow(ConfigError);
	});

	test("a live write the breaker refused is buffered with its full budget, not given up at once", async () => {
		const t = telemetry({ SUBSTRATE_EVENT_BUFFER_MAX_ATTEMPTS: "1" });
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(t.env, greptime);
		state.breakerOpen = true;

		const result = await substrate.emit(input("refused-live"));

		expect(result).toMatchObject({ stored: false, buffered: true });
		expect(result.deadLettered).toBeUndefined();
		state.breakerOpen = false;
		await substrate.drainEventBuffer({ all: true });
		expect(state.rows.map((row) => row.id)).toEqual([result.event.id]);
	});

	test("a keyed replay of a pending give-up is refused as a give-up, not answered as buffered, and appends nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "telemetry-pending-"));
		dirs.push(dir);
		// A file where the dead-letter directory should be: every record write fails, so the give-up stays pending in the buffer.
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "");
		const env = {
			SUBSTRATE_EVENT_BUFFER_PATH: join(dir, "buffer.jsonl"),
			SUBSTRATE_EVENT_DEAD_LETTER_PATH: join(blocker, "dead.jsonl"),
			SUBSTRATE_EVENT_BUFFER_MAX_ATTEMPTS: "1",
			SUBSTRATE_EVENT_IDEMPOTENCY: "enforce",
		};
		const { state, greptime } = fakeLedger();
		const substrate = substrateFor(env, greptime);
		state.down = true;
		const keyed: EventInput = { surface: "omp", kind: "note", summary: "pending", idempotency_key: "replay-key-0004" };

		const first = await substrate.emit(keyed);
		expect(first).toMatchObject({ stored: false, deadLettered: true });
		const replay = await substrate.emit(keyed);

		expect(replay).toMatchObject({ stored: false, deadLettered: true });
		expect(replay.buffered).toBeUndefined();
		expect(state.rows).toEqual([]);
	});
});
