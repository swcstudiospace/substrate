/**
 * The dead-letter operator surface (phase 76): `listDeadLetters` / `replayDeadLetter` on the service, the
 * operator gate on both transports, and the `/healthz` count. The ledger underneath is a stub — the point
 * is the wiring: a parked event is inspectable, a replay goes through the delivery path (so it cannot
 * double-ingest), a failed replay re-parks, and neither door opens to a non-operator.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { normalizeEvent } from "./event.ts";
import { DeadLetterStore, type DeadLetter } from "./event-buffer.ts";
import { createMcpServer } from "./mcp.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer, type HttpServerOptions } from "./server.ts";
import { Substrate } from "./service.ts";
import type { EventInput, SubstrateEvent, Surface } from "./types.ts";

const dirs: string[] = [];
const opened: Substrate[] = [];
afterEach(async () => {
	for (const substrate of opened.splice(0)) await substrate.drainPendingEvents(0, { abandon: true });
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "dead-letter-ops-"));
	dirs.push(dir);
	return dir;
}

const TIP = "tip-0";
const input: EventInput = { surface: "omp", kind: "shell", summary: "ran cargo test", session_id: "sess-1" };

/**
 * A ledger that records what it stores. While `failing` is set every insert throws; callers flip it to
 * simulate recovery. `storedIds` holds ids whose row is already there, so `eventStored` answers true for
 * an event whose original write landed but whose reply was lost.
 */
function ledger() {
	const written: SubstrateEvent[] = [];
	const storedIds = new Set<string>();
	let calls = 0;
	let failing = true;
	const greptime = {
		ensureAppendMode: async () => true,
		lastHash: async () => written.at(-1)?.hash ?? TIP,
		eventStored: async (id: string) => storedIds.has(id),
		findByIdempotencyKey: async () => null,
		recordIngest: async () => undefined,
		insertEvent: async (event: SubstrateEvent) => {
			calls += 1;
			if (failing) throw new Error("greptime unreachable: ECONNRESET");
			storedIds.add(event.id);
			written.push(event);
		},
	};
	return {
		written,
		storedIds,
		greptime,
		inserts: () => calls,
		setFailing: (value: boolean) => {
			failing = value;
		},
	};
}

/** A substrate whose first failed write dead-letters at once (attempt budget 1), so tests need no drain. */
function substrateWith(env: Record<string, string>, greptime: unknown): Substrate {
	const substrate = new Substrate(loadConfig({ SUBSTRATE_LEDGER_BUFFER_MAX_ATTEMPTS: "1", ...env }), { index: null, greptime: greptime as never });
	opened.push(substrate);
	return substrate;
}

/** Emit one event that fails its only attempt, leaving one `exhausted` dead letter. */
async function deadLetterOne(substrate: Substrate, override: Partial<EventInput> = {}): Promise<SubstrateEvent> {
	const result = await substrate.emit({ ...input, ...override });
	expect(result.stored).toBe(false);
	expect(result.deadLettered).toBe(true);
	return result.event;
}

function recordOf(event: SubstrateEvent, cause: DeadLetter["cause"], lastReason = "greptime unreachable"): DeadLetter {
	return { id: event.id, hash: event.hash, session_id: event.session_id, cause, attempts: 2, last_reason: lastReason, dead_at: 1, event };
}

describe("DeadLetterStore get/remove", () => {
	test("get returns the record, remove takes it out once, and both answer false on a miss", () => {
		const store = new DeadLetterStore();
		const event = normalizeEvent({ surface: "omp", kind: "note", summary: "never landed", session_id: "s-1" }, null);
		const record = recordOf(event, "exhausted");

		expect(store.get(record.id)).toBeUndefined();
		expect(store.remove(record.id)).toBe(false);

		store.add(record);
		expect(store.get(record.id)).toEqual(record);
		expect(store.depth()).toBe(1);
		expect(store.remove(record.id)).toBe(true);
		expect(store.get(record.id)).toBeUndefined();
		expect(store.depth()).toBe(0);
	});

	test("a file-backed removal survives a restart: the record is not resurrected", () => {
		const path = join(scratch(), "dead.jsonl");
		const store = new DeadLetterStore({ path });
		const event = normalizeEvent({ surface: "omp", kind: "note", summary: "never landed", session_id: "s-1" }, null);
		store.add(recordOf(event, "overflow"));

		expect(store.remove(event.id)).toBe(true);

		const reopened = new DeadLetterStore({ path });
		expect(reopened.depth()).toBe(0);
		expect(reopened.get(event.id)).toBeUndefined();
	});

	test("re-adding one id replaces it: a re-park keeps one record with the new error and the spent attempt", () => {
		const store = new DeadLetterStore();
		const event = normalizeEvent({ surface: "omp", kind: "note", summary: "never landed", session_id: "s-1" }, null);
		const record = recordOf(event, "exhausted", "first failure");
		store.add(record);

		store.add({ ...record, attempts: record.attempts + 1, last_reason: "replay failure" });

		expect(store.list()).toHaveLength(1);
		expect(store.list()[0]).toMatchObject({ id: record.id, attempts: 3, last_reason: "replay failure" });
	});
});

describe("listDeadLetters", () => {
	test("an empty store lists nothing and counts zero", () => {
		const substrate = substrateWith({}, ledger().greptime);

		expect(substrate.listDeadLetters()).toEqual({ dead_letters: [], count: 0 });
	});

	test("a dead-lettered event is listed whole, with its cause, hash and error, and counted", async () => {
		const { greptime } = ledger();
		const substrate = substrateWith({}, greptime);
		const event = await deadLetterOne(substrate);

		const listed = substrate.listDeadLetters();
		expect(listed.count).toBe(1);
		expect(listed.dead_letters).toHaveLength(1);
		const item = listed.dead_letters[0];
		expect(item).toMatchObject({ id: event.id, hash: event.hash, session_id: "sess-1", cause: "exhausted", attempts: 1 });
		expect(item?.event.hash).toBe(event.hash);
		expect(item?.event.id).toBe(event.id);
		expect(item?.last_reason).toContain("ECONNRESET");
		expect(item?.dead_at).toBeGreaterThan(0);
	});

	test("session and cause filters narrow the list while count stays the store total, and limit caps it", async () => {
		const { greptime } = ledger();
		const substrate = substrateWith({ SUBSTRATE_LEDGER_DEAD_LETTER_PATH: join(scratch(), "dead.jsonl") }, greptime);
		const first = await deadLetterOne(substrate);
		await deadLetterOne(substrate, { session_id: "sess-2", summary: "another" });

		expect(substrate.listDeadLetters().count).toBe(2);
		expect(substrate.listDeadLetters({ session_id: "sess-2" }).dead_letters.map((item) => item.id)).not.toContain(first.id);
		expect(substrate.listDeadLetters({ session_id: "sess-2" }).dead_letters).toHaveLength(1);
		expect(substrate.listDeadLetters({ session_id: "sess-9" }).dead_letters).toHaveLength(0);
		expect(substrate.listDeadLetters({ cause: "overflow" }).dead_letters).toHaveLength(0);
		expect(substrate.listDeadLetters({ cause: "exhausted" }).dead_letters).toHaveLength(2);
		expect(substrate.listDeadLetters({ limit: 1 }).dead_letters).toHaveLength(1);
		expect(substrate.listDeadLetters({ limit: 1 }).count).toBe(2);
	});

	test("an invalid cause throws rather than silently widening the read", async () => {
		const substrate = substrateWith({}, ledger().greptime);
		await deadLetterOne(substrate);

		expect(() => substrate.listDeadLetters({ cause: "bogus" as never })).toThrow();
	});
});

describe("replayDeadLetter", () => {
	test("replay after recovery stores the same event, removes the record, and writes one row", async () => {
		const led = ledger();
		const substrate = substrateWith({}, led.greptime);
		const event = await deadLetterOne(substrate);
		expect(led.written).toHaveLength(0);

		led.setFailing(false);
		const replayed = await substrate.replayDeadLetter(event.id);

		expect(replayed).toEqual({ ok: true, id: event.id, stored: true });
		expect(led.written).toHaveLength(1);
		expect(led.written[0]).toMatchObject({ id: event.id, hash: event.hash });
		expect(substrate.listDeadLetters()).toEqual({ dead_letters: [], count: 0 });
	});

	test("an event whose write already landed replays without a second insert: no double-ingest", async () => {
		const led = ledger();
		const substrate = substrateWith({}, led.greptime);
		const event = await deadLetterOne(substrate);
		// The original write landed; only its reply was lost.
		led.storedIds.add(event.id);
		led.setFailing(false);
		const insertsBefore = led.inserts();

		const replayed = await substrate.replayDeadLetter(event.id);

		expect(replayed).toEqual({ ok: true, id: event.id, stored: true });
		expect(led.inserts()).toBe(insertsBefore);
		expect(led.written).toHaveLength(0);
		expect(substrate.listDeadLetters().count).toBe(0);
	});

	test("a failed replay re-parks the record with the new error, and a later replay still lands it", async () => {
		const led = ledger();
		const substrate = substrateWith({}, led.greptime);
		const event = await deadLetterOne(substrate);

		const failed = await substrate.replayDeadLetter(event.id);
		expect(failed.ok).toBe(false);
		expect(failed.reason).toBe("re-parked");
		expect(failed.error).toContain("ECONNRESET");

		const parked = substrate.listDeadLetters();
		expect(parked.count).toBe(1);
		expect(parked.dead_letters[0]).toMatchObject({ id: event.id, attempts: 2 });
		expect(parked.dead_letters[0]?.last_reason).toContain("ECONNRESET");
		expect(led.written).toHaveLength(0);

		led.setFailing(false);
		const retried = await substrate.replayDeadLetter(event.id);
		expect(retried).toEqual({ ok: true, id: event.id, stored: true });
		expect(led.written).toHaveLength(1);
		expect(substrate.listDeadLetters().count).toBe(0);
	});

	test("an unknown id answers not-found and leaves the store alone", async () => {
		const substrate = substrateWith({}, ledger().greptime);
		await deadLetterOne(substrate);

		const missing = await substrate.replayDeadLetter("evt_missing");
		expect(missing.ok).toBe(false);
		expect(missing.reason).toBe("not-found");
		expect(missing.id).toBe("evt_missing");
		expect(substrate.listDeadLetters().count).toBe(1);
	});

	test("an unconfigured ledger replays nothing and keeps the dead letter parked for a later attempt", async () => {
		const deadPath = join(scratch(), "dead.jsonl");
		const withLedger = substrateWith({ SUBSTRATE_LEDGER_DEAD_LETTER_PATH: deadPath }, ledger().greptime);
		const event = await deadLetterOne(withLedger);

		// A boot that dropped the ledger still hydrates the store from the file, so the record survives.
		const noLedger = substrateWith({ SUBSTRATE_LEDGER_DEAD_LETTER_PATH: deadPath }, null);
		expect(noLedger.listDeadLetters().count).toBe(1);

		const refused = await noLedger.replayDeadLetter(event.id);
		expect(refused.ok).toBe(false);
		expect(refused.reason).toBe("no-ledger");
		expect(refused.error).toContain("GREPTIME_URL is not set");
		expect(noLedger.listDeadLetters().count).toBe(1);
	});
});

describe("/healthz carries the dead-letter count", () => {
	test("health names the depth: up when one dead-letters, down when it replays", async () => {
		const led = ledger();
		const substrate = substrateWith({}, led.greptime);

		expect((await substrate.health()).eventBuffer.deadLetters.depth).toBe(0);

		const event = await deadLetterOne(substrate);
		expect((await substrate.health()).eventBuffer.deadLetters.depth).toBe(1);

		led.setFailing(false);
		expect((await substrate.replayDeadLetter(event.id)).ok).toBe(true);
		expect((await substrate.health()).eventBuffer.deadLetters.depth).toBe(0);
	});
});

describe("the MCP tools are operator-gated", () => {
	async function connect(caller: Surface | { surface: Surface | null; isOperator: boolean }, greptime: unknown) {
		const substrate = substrateWith({}, greptime);
		const server = createMcpServer(substrate, caller);
		const client = new Client({ name: "dead-letter-ops-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return { substrate, client };
	}

	async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
		const result = await client.callTool({ name, arguments: args });
		const content = result.content as Array<{ type: string; text?: string }>;
		const text = content[0]?.text ?? "";
		return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
	}

	test("both tools are registered and the list read is read-only", async () => {
		const { client } = await connect({ surface: "omp", isOperator: true }, ledger().greptime);

		const tools = (await client.listTools()).tools;
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		expect(byName.has("events_dead_letter_list")).toBe(true);
		expect(byName.has("events_dead_letter_replay")).toBe(true);
		expect(byName.get("events_dead_letter_list")?.annotations?.readOnlyHint).toBe(true);
	});

	test("a non-operator gets operator-required from both tools and nothing is read or written", async () => {
		const { substrate, client } = await connect("omp", ledger().greptime);
		const event = await deadLetterOne(substrate);

		const listed = await call(client, "events_dead_letter_list");
		expect(listed.json()).toMatchObject({ ok: false, reason: "operator-required" });
		const replayed = await call(client, "events_dead_letter_replay", { id: event.id });
		expect(replayed.json()).toMatchObject({ ok: false, reason: "operator-required" });
		// The refusals read and wrote nothing: the record is still parked.
		expect(substrate.listDeadLetters().count).toBe(1);
	});

	test("an operator lists the parked event, replays it, and the list is then empty", async () => {
		const led = ledger();
		const { substrate, client } = await connect({ surface: "omp", isOperator: true }, led.greptime);
		const event = await deadLetterOne(substrate);

		const listed = await call(client, "events_dead_letter_list");
		expect(listed.json()).toMatchObject({ count: 1 });
		expect(((listed.json().dead_letters as Array<Record<string, unknown>>)[0])).toMatchObject({ id: event.id, hash: event.hash, cause: "exhausted" });

		led.setFailing(false);
		const replayed = await call(client, "events_dead_letter_replay", { id: event.id });
		expect(replayed.json()).toEqual({ ok: true, id: event.id, stored: true });
		expect(led.written).toHaveLength(1);

		expect((await call(client, "events_dead_letter_list")).json()).toEqual({ dead_letters: [], count: 0 });
	});
});

describe("the REST routes mirror the tools, operator-gated", () => {
	/** Boot the real server on an ephemeral port, as server.test.ts does. */
	async function serve(greptime: unknown, env: Record<string, string | undefined> = {}) {
		const config = loadConfig(env);
		const observability = createObservability(config, env);
		await observability.start();
		const substrate = new Substrate(config, { index: null, greptime: greptime as never }, observability.observer);
		opened.push(substrate);
		const server = createHttpServer(substrate, config, observability, {} as HttpServerOptions);
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		return {
			port,
			post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
				fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
			get: (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers }),
			stop: () => {
				const closed = Promise.withResolvers<void>();
				observability.stop();
				server.close(() => closed.resolve());
				return closed.promise;
			},
		};
	}

	const OPERATOR = { authorization: "Bearer tok-omp" };
	const NON_OPERATOR = { authorization: "Bearer tok-hermes" };
	const ENV = { SUBSTRATE_TOKEN_OMP: "tok-omp", SUBSTRATE_TOKEN_HERMES: "tok-hermes", SUBSTRATE_OPERATOR_TOKENS: "tok-omp", SUBSTRATE_LEDGER_BUFFER_MAX_ATTEMPTS: "1", SUBSTRATE_HEALTHZ_CACHE_MS: "0" };

	test("an unauthenticated caller is 401 and a non-operator is 403, before anything is read", async () => {
		const { get, post, stop } = await serve(ledger().greptime, ENV);
		try {
			expect((await get("/events/dead-letters")).status).toBe(401);
			expect((await get("/events/dead-letters", NON_OPERATOR)).status).toBe(403);
			expect((await post("/events/dead-letters/replay", { id: "evt_any" }, NON_OPERATOR)).status).toBe(403);
			// Nothing was read: the refusals carry the operator error, not a store listing.
			const refused = (await get("/events/dead-letters", NON_OPERATOR)).json() as Promise<{ error?: string }>;
			expect((await refused).error).toContain("operator token");
		} finally {
			await stop();
		}
	});

	test("list, replay and healthz end to end over the socket", async () => {
		const led = ledger();
		const { get, post, stop } = await serve(led.greptime, ENV);
		try {
			// Seed one dead letter through the REST emit door.
			const emitted = await post("/events", input, OPERATOR);
			expect(emitted.status).toBe(503);
			const emittedBody = (await emitted.json()) as { id: string; deadLettered?: boolean };
			expect(emittedBody.deadLettered).toBe(true);

			const listed = await get("/events/dead-letters", OPERATOR);
			expect(listed.status).toBe(200);
			const listBody = (await listed.json()) as { count: number; dead_letters: Array<{ id: string }> };
			expect(listBody.count).toBe(1);
			expect(listBody.dead_letters[0]?.id).toBe(emittedBody.id);

			expect(((await (await get("/healthz", OPERATOR)).json()) as { eventBuffer: { deadLetters: { depth: number } } }).eventBuffer.deadLetters.depth).toBe(1);

			led.setFailing(false);
			const replayed = await post("/events/dead-letters/replay", { id: emittedBody.id }, OPERATOR);
			expect(replayed.status).toBe(200);
			expect(await replayed.json()).toMatchObject({ ok: true });
			expect(led.written).toHaveLength(1);

			expect(((await (await get("/events/dead-letters", OPERATOR)).json()) as { count: number }).count).toBe(0);
			expect(((await (await get("/healthz", OPERATOR)).json()) as { eventBuffer: { deadLetters: { depth: number } } }).eventBuffer.deadLetters.depth).toBe(0);

			// A replay of a gone id is a 404, and a malformed limit a 400.
			expect((await post("/events/dead-letters/replay", { id: emittedBody.id }, OPERATOR)).status).toBe(404);
			expect((await get("/events/dead-letters?limit=0", OPERATOR)).status).toBe(400);
			expect((await get("/events/dead-letters?cause=bogus", OPERATOR)).status).toBe(400);
		} finally {
			await stop();
		}
	});
});
