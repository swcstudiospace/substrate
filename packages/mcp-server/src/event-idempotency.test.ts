/**
 * Idempotent replay for `POST /events` (U5-4a), end to end over the real client.
 *
 * The ledger here is an in-memory `agent_events` behind a replaced `fetch`. It keeps every column of
 * every INSERT and answers the replay lookup by evaluating that statement's own predicates — equality
 * on the cell's columns, `IS NULL`, exact `ts`, and the statement's `LIMIT`. The key is not in that
 * statement: the real client matches it exactly in code, so a lookalike row comes back and is refused — so
 * the assertions are about the statements the real `GreptimeClient` sends and the real
 * `Substrate.emit`, not about a fake's idea of either. No network, no fixed ports.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { METRIC, findCounter } from "@substrate/observability";
import { eventIdempotencyConfigWarnings, loadConfig, type GreptimeConfig } from "./config.ts";
import { IDEMPOTENCY_RULES, IdempotencyRefusal, InvalidEventError, normalizeEvent, verifyChain } from "./event.ts";
import { GreptimeClient, IDEMPOTENCY_LOOKUP_LIMIT, IDEMPOTENCY_LOOKUP_MAX_PAGES } from "./greptime.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate, type SubstrateObserver } from "./service.ts";
import { defined } from "./test-support.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

const config: GreptimeConfig = { url: "http://greptime.test", user: "u", password: "p", db: "substrate" };
const HOUR_MS = 3_600_000;
const KEY = "grok:sess-1:offset-42";
/** The client's fixed first-attempt stamp: yesterday, so a replay of it is a late one, never a future one. */
const FIRST_TS = new Date(Date.now() - 24 * HOUR_MS).toISOString();

function records(columns: string[], rows: unknown[][]) {
	return { output: [{ records: { schema: { column_schemas: columns.map((name) => ({ name })) }, rows } }] };
}
const affected = { output: [{ affectedrows: 1 }] };

/** A stored `agent_events` row: every column, the payload as the text the ledger holds. */
interface Row {
	ts: string;
	id: string;
	surface: string;
	session_id: string | null;
	graph_id: string | null;
	node_id: string | null;
	linear_identifier: string | null;
	step: number | null;
	repo: string | null;
	branch: string | null;
	actor: string;
	kind: string;
	summary: string;
	payload: string;
	hash: string;
	prev: string | null;
}

const COLUMNS = ["ts", "id", "surface", "session_id", "graph_id", "node_id", "linear_identifier", "step", "repo", "branch", "actor", "kind", "summary", "payload", "hash", "prev"] as const;

interface FakeLedger {
	rows: Row[];
	ingests: number;
	/** Every `event_ingest` record written, as (event_id, event_ts, graph_id). */
	ingestRecords: Array<{ event_id: unknown; event_ts: unknown; graph_id: unknown }>;
	/** The same records with their server-time stamp (epoch ms), which the stream and coverage reads order and bucket by. */
	ingestStamps: Array<{ event_id: string; ingested_at: number }>;
	sql: string[];
	/** Runs ahead of every statement; a `Response` answers it instead of the store. */
	before: (statement: string) => Promise<Response | undefined>;
	/** The statements that are the replay lookup. */
	lookups(): string[];
	inserts(): string[];
	events(): SubstrateEvent[];
	/** Store an INSERT as the ledger would, without answering (a write that lands and whose reply is lost). */
	land(statement: string): void;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** The values of an INSERT, in column order, unquoted. */
function insertedValues(statement: string): Array<string | number | null> {
	const list = statement.slice(statement.indexOf(") VALUES (") + ") VALUES (".length, statement.lastIndexOf(")"));
	return [...list.matchAll(/'((?:[^']|'')*)'|NULL|-?\d+(?:\.\d+)?/g)].map((match) =>
		match[1] !== undefined ? match[1].replace(/''/g, "'") : match[0] === "NULL" ? null : Number(match[0]),
	);
}

/** The replay lookup's statement opening, as `GreptimeClient.findByIdempotencyKey` sends it. */
const LOOKUP_PREFIX = 'SELECT "id", "hash", "payload" FROM "agent_events"';

function fakeLedger(): FakeLedger {
	const ledger: FakeLedger = {
		rows: [],
		ingests: 0,
		ingestRecords: [],
		ingestStamps: [],
		sql: [],
		before: async () => undefined,
		lookups: () => ledger.sql.filter((statement) => statement.startsWith(LOOKUP_PREFIX)),
		inserts: () => ledger.sql.filter((statement) => statement.startsWith('INSERT INTO "agent_events"')),
		events: () =>
			ledger.rows.map((row) => ({ ...row, step: row.step, actor: row.actor, payload: JSON.parse(row.payload) }) as unknown as SubstrateEvent),
		land(statement) {
			const values = insertedValues(statement);
			const row = Object.fromEntries(COLUMNS.map((column, index) => [column, values[index] ?? null])) as unknown as Row;
			ledger.rows.push(row);
		},
	};
	const answer = (statement: string): unknown => {
		if (statement.includes("LENGTH")) return records(["n"], [[3]]);
		if (statement.includes("SHOW CREATE TABLE")) return records(["Create Table"], [["... WITH( append_mode = 'true' )"]]);
		if (statement.startsWith('INSERT INTO "agent_events"')) {
			ledger.land(statement);
			return affected;
		}
		if (statement.startsWith('INSERT INTO "event_ingest"')) {
			ledger.ingests++;
			const [ingested_at, event_id, event_ts, graph_id] = insertedValues(statement);
			ledger.ingestRecords.push({ event_id, event_ts, graph_id });
			ledger.ingestStamps.push({ event_id: String(event_id), ingested_at: Date.parse(String(ingested_at)) });
			return affected;
		}
		if (statement.startsWith('SELECT "event_id", "ingested_at" FROM "event_ingest" WHERE "event_id" =')) {
			// `cursorPosition`: the event's earliest record, if any.
			const id = /"event_id" = '([^']*)'/.exec(statement)?.[1];
			const first = ledger.ingestStamps.filter((row) => row.event_id === id).sort((a, b) => a.ingested_at - b.ingested_at)[0];
			return records(["event_id", "ingested_at"], first ? [[first.event_id, first.ingested_at]] : []);
		}
		if (statement.includes("date_bin")) {
			// `anchorCoverage`'s histogram: raw record counts per ingest hour, as the statement counts them.
			const per = new Map<number, number>();
			for (const row of ledger.ingestStamps) {
				const hour = Math.floor(row.ingested_at / HOUR_MS) * HOUR_MS;
				per.set(hour, (per.get(hour) ?? 0) + 1);
			}
			return records(["hour", "n"], [...per].map(([hour, n]) => [hour / 1000, n]));
		}
		if (statement.includes("NOT EXISTS")) {
			// `eventIdsAfter`, as written: an event is NEW unless an earlier record sits inside the one-hour lookback.
			const bounds = [...statement.matchAll(/"ingested_at" >= '([^']*)'/g)].map((match) => Date.parse(defined(match[1])));
			const [at, lookback] = bounds as [number, number];
			const fresh = ledger.ingestStamps
				.filter((row) => row.ingested_at >= at)
				.filter(
					(row) =>
						!ledger.ingestStamps.some(
							(prior) => prior.event_id === row.event_id && prior.ingested_at >= lookback && prior.ingested_at < at,
						),
				)
				.sort((a, b) => a.ingested_at - b.ingested_at);
			return records(["event_id", "ingested_at", "event_ts"], fresh.map((row) => [row.event_id, row.ingested_at, FIRST_TS && Date.parse(FIRST_TS)]));
		}
		if (statement.startsWith(LOOKUP_PREFIX)) {
			// The replay lookup as the client sends it: the cell's rows at the exact `ts`, capped at the
			// statement's own LIMIT. No payload predicate: the client matches the key, so lookalikes come back.
			const text = (column: string): string | null | undefined => {
				const match = new RegExp(`"${column}" (?:= '((?:[^']|'')*)'|(IS NULL))`).exec(statement);
				return match === null ? undefined : match[2] !== undefined ? null : defined(match[1]).replace(/''/g, "'");
			};
			const ts = /"ts" = '([^']*)'/.exec(statement)?.[1];
			const limit = Number(/LIMIT (\d+)$/.exec(statement)?.[1] ?? 0);
			// The keyset bound a later page carries, and id order as `ORDER BY "id"` returns it.
			const after = /"id" > '((?:[^']|'')*)'/.exec(statement)?.[1]?.replace(/''/g, "'");
			const hits = ledger.rows
				.filter(
					(row) =>
						(["surface", "repo", "graph_id", "kind"] as const).every((column) => row[column] === text(column)) &&
						row.ts === ts &&
						(after === undefined || row.id > after),
				)
				.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
				.slice(0, limit);
			return records(["id", "hash", "payload"], hits.map((hit) => [hit.id, hit.hash, hit.payload]));
		}
		// `GreptimeClient.eventStored`: a settled delivery checks the row before it writes, as the real ledger answers it.
		const stored = /^SELECT "id" FROM "agent_events" WHERE "id" = '([^']*)' LIMIT 1$/.exec(statement);
		if (stored) return records(["id"], ledger.rows.filter((row) => row.id === stored[1]).map((row) => [row.id]));
		const session = /WHERE "session_id" = '([^']+)'/.exec(statement);
		if (session) {
			const rows = ledger.rows.filter((row) => row.session_id === session[1]).reverse();
			return records(["hash", "prev"], rows.map((row) => [row.hash, row.prev]));
		}
		return affected;
	};
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const statement = new URLSearchParams(String(init.body)).get("sql") ?? "";
		ledger.sql.push(statement);
		const override = await ledger.before(statement);
		if (override) return override;
		return new Response(JSON.stringify(answer(statement)), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return ledger;
}

interface Seen {
	replays: string[];
	emitted: number;
}

function substrateWith(env: Record<string, string>, seen: Seen = { replays: [], emitted: 0 }): Substrate {
	const observer: SubstrateObserver = {
		eventReplay: (sample) => seen.replays.push(sample.result),
		emitted: () => {
			seen.emitted++;
		},
	};
	const greptime = new GreptimeClient(config, { ledger: loadConfig(env).ledger });
	return new Substrate(loadConfig(env), { index: null, greptime }, observer);
}

/** Overrides for `base`; `undefined` on these three removes the default, so a test can ask for "no ts", "sessionless" or "no key". */
type BaseOverrides = Omit<Partial<EventInput>, "ts" | "session_id" | "idempotency_key"> & {
	ts?: string | undefined;
	session_id?: string | undefined;
	idempotency_key?: string | undefined;
};

const base = (extra: BaseOverrides = {}): EventInput => {
	const { ts, session_id, idempotency_key, ...rest } = {
		surface: "omp" as const,
		kind: "shell" as const,
		summary: "ran cargo test",
		session_id: "sess-1",
		repo: "acme/widgets",
		graph_id: "ut-1",
		ts: FIRST_TS,
		...extra,
	};
	return {
		...rest,
		...(session_id === undefined ? {} : { session_id }),
		...(ts === undefined ? {} : { ts }),
		...(idempotency_key === undefined ? {} : { idempotency_key }),
	};
};

const ACCEPT = { SUBSTRATE_EVENT_IDEMPOTENCY: "accept" };
const ENFORCE = { SUBSTRATE_EVENT_IDEMPOTENCY: "enforce" };

/** The statements a request sends, reduced to their verb and table so two runs compare without ids and hashes. */
const shape = (statements: string[]): string[] => statements.map((statement) => statement.split(" ").slice(0, 3).join(" "));

describe("mode off: today's behaviour, byte for byte", () => {
	test("a key, a malformed key and the replay marker are ignored: same statements, no lookup, no `_ik`", async () => {
		const plain = fakeLedger();
		const first = await substrateWith({}).emit(base());
		const plainShape = shape(plain.sql);

		const keyed = fakeLedger();
		const keyedSeen: Seen = { replays: [], emitted: 0 };
		const keyedResult = await substrateWith({}, keyedSeen).emit(base({ idempotency_key: KEY }), { replay: true });
		const malformed = await substrateWith({}, keyedSeen).emit(base({ idempotency_key: 7 as never, summary: "second" }), { replay: true });

		expect(first.stored && keyedResult.stored && malformed.stored).toBe(true);
		expect(keyedResult.deduplicated).toBeUndefined();
		// The one-event statement sequence is exactly the keyless one; the lookup never ran.
		expect(shape(keyed.sql.slice(0, plainShape.length))).toEqual(plainShape);
		expect(keyed.lookups()).toEqual([]);
		expect(defined(keyed.rows[0]).payload).toBe("{}");
		expect(keyedSeen.replays).toEqual([]);
	});

	test("a payload `_ik` the caller wrote is left alone: stripping is part of the flag, not of today", async () => {
		const ledger = fakeLedger();
		await substrateWith({}).emit(base({ payload: { _ik: "caller-wrote-this", a: 1 } }));
		expect(JSON.parse(defined(ledger.rows[0]).payload)).toEqual({ _ik: "caller-wrote-this", a: 1 });
	});

	test("the same replayed event is appended twice — the duplicate the flag exists to prevent", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith({});
		await substrate.emit(base({ idempotency_key: KEY }));
		const second = await substrate.emit(base({ idempotency_key: KEY }), { replay: true });
		expect(second.deduplicated).toBeUndefined();
		expect(ledger.rows).toHaveLength(2);
	});
});

describe("accept: store the key, look it up only for a marked replay", () => {
	test("an unmarked keyed event stores `_ik` as its last payload key and costs zero extra reads", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		const result = await substrateWith(ACCEPT, seen).emit(base({ idempotency_key: KEY, payload: { a: 1, b: { c: 2 } } }));

		expect(result.stored).toBe(true);
		expect(ledger.lookups()).toEqual([]);
		expect(defined(ledger.rows[0]).payload).toBe(`{"a":1,"b":{"c":2},"_ik":"${KEY}"}`);
		expect(result.event.payload._ik).toBe(KEY);
		expect(seen.replays).toEqual([]);
		// The key is inside the hashed event: the stored hash recomputes from the stored payload.
		expect(verifyChain(ledger.events())).toEqual({ ok: true });
	});

	test("a hit whose membership exists writes NOTHING: no second event, no second ingest record, an unchanged answer", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		const substrate = substrateWith(ACCEPT, seen);
		const first = await substrate.emit(base({ idempotency_key: KEY }));
		const inserts = ledger.inserts().length;
		const ingests = ledger.ingests;
		expect(ingests).toBe(1);

		const replay = await substrate.emit(base({ idempotency_key: KEY }), { replay: true });

		expect(replay.deduplicated).toBe(true);
		expect(replay.stored).toBe(true);
		expect(replay.warning).toBeUndefined();
		expect(replay.event.id).toBe(first.event.id);
		expect(replay.event.hash).toBe(first.event.hash);
		expect(replay.event.ts).toBe(first.event.ts);
		expect(ledger.inserts()).toHaveLength(inserts);
		expect(ledger.ingests).toBe(ingests);
		expect(ledger.rows).toHaveLength(1);
		expect(ledger.lookups()).toHaveLength(1);
		// The dedupe is counted as a replay and NOT as an emit: its tokens and cost were counted once already.
		expect(seen.replays).toEqual(["deduplicated"]);
		expect(seen.emitted).toBe(1);
	});

	test("a hit whose original never wrote its ingest record repairs it: exactly one record for the existing id, no second event", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		// The original's agent_events INSERT lands, then its reply is lost and its ingest record is never written.
		ledger.before = async (statement) => {
			if (!statement.startsWith('INSERT INTO "agent_events"')) return undefined;
			ledger.land(statement);
			return new Response("gateway timeout", { status: 503 });
		};
		const lost = await substrate.emit(base({ idempotency_key: KEY }));
		expect(lost.stored).toBe(false);
		expect(ledger.rows).toHaveLength(1);
		expect(ledger.ingestRecords).toEqual([]);
		ledger.before = async () => undefined;

		const replay = await substrate.emit(base({ idempotency_key: KEY }), { replay: true });

		expect(replay.deduplicated).toBe(true);
		expect(replay.stored).toBe(true);
		expect(replay.warning).toBeUndefined();
		expect(ledger.rows).toHaveLength(1);
		expect(ledger.inserts()).toHaveLength(1);
		expect(ledger.ingestRecords).toEqual([{ event_id: defined(ledger.rows[0]).id, event_ts: FIRST_TS, graph_id: "ut-1" }]);

		// It is now the event's first record: a further replay finds it and writes nothing.
		await substrate.emit(base({ idempotency_key: KEY }), { replay: true });
		expect(ledger.ingestRecords).toHaveLength(1);
	});

	test("a membership read that fails writes nothing and warns, never a failure or a second event", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		const substrate = substrateWith(ACCEPT, seen);
		ledger.before = async (statement) => {
			if (!statement.startsWith('INSERT INTO "agent_events"')) return undefined;
			ledger.land(statement);
			return new Response("gateway timeout", { status: 503 });
		};
		await substrate.emit(base({ idempotency_key: KEY }));
		ledger.before = async (statement) =>
			statement.startsWith('SELECT "event_id", "ingested_at" FROM "event_ingest"') ? new Response("down", { status: 503 }) : undefined;

		const replay = await substrate.emit(base({ idempotency_key: KEY }), { replay: true });

		expect(replay.stored).toBe(true);
		expect(replay.deduplicated).toBe(true);
		expect(replay.lookupFailed).toBeUndefined();
		expect(replay.warning).toContain("Do not re-emit it");
		expect(ledger.ingestRecords).toEqual([]);
		expect(ledger.inserts()).toHaveLength(1);
		expect(ledger.rows).toHaveLength(1);
		expect(seen.replays).toEqual(["deduplicated"]);
	});

	test("a repair write that fails stays stored:true with the normal path's warning, and writes no second event", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		const substrate = substrateWith(ACCEPT, seen);
		ledger.before = async (statement) => {
			if (!statement.startsWith('INSERT INTO "agent_events"')) return undefined;
			ledger.land(statement);
			return new Response("gateway timeout", { status: 503 });
		};
		await substrate.emit(base({ idempotency_key: KEY }));
		ledger.before = async (statement) => (statement.startsWith('INSERT INTO "event_ingest"') ? new Response("nope", { status: 503 }) : undefined);

		const replay = await substrate.emit(base({ idempotency_key: KEY }), { replay: true });

		expect(replay.stored).toBe(true);
		expect(replay.deduplicated).toBe(true);
		expect(replay.lookupFailed).toBeUndefined();
		expect(replay.warning).toContain("Do not re-emit it");
		expect(ledger.inserts()).toHaveLength(1);
		expect(ledger.rows).toHaveLength(1);
		expect(ledger.ingestRecords).toEqual([]);
		expect(seen.replays).toEqual(["deduplicated"]);
	});

	test("a replay hours later with the membership present leaves the stream and the coverage histogram as they were", async () => {
		const ledger = fakeLedger();
		const originalAt = Date.now() - 6 * HOUR_MS - 123_456;
		let now = originalAt;
		const client = new GreptimeClient(config, { ledger: loadConfig(ACCEPT).ledger, clock: () => now });
		const substrate = new Substrate(loadConfig(ACCEPT), { index: null, greptime: client });
		const first = await substrate.emit(base({ idempotency_key: KEY }));
		expect(ledger.ingestStamps).toHaveLength(1);

		// The stream's cursor sits two hours after the event; the replay arrives three hours after it.
		const cursor = { id: "evt_cursor", ingestedAt: originalAt + 2 * HOUR_MS };
		now = originalAt + 3 * HOUR_MS;
		const replay = await substrate.emit(base({ idempotency_key: KEY }), { replay: true });

		expect(replay.deduplicated).toBe(true);
		expect(replay.event.id).toBe(first.event.id);
		expect(ledger.ingestStamps).toHaveLength(1);
		// The stream does not hand the stored event out again as a new position.
		expect(await client.eventIdsAfter(cursor, 10)).toEqual([]);
		// Coverage counts only the hour the membership really sits in — the hour `hourLeaves` would anchor it in.
		const coverage = await client.anchorCoverage({ now: originalAt + 5 * HOUR_MS });
		expect(coverage.uncoveredHours).toEqual([new Date(Math.floor(originalAt / HOUR_MS) * HOUR_MS).toISOString()]);
	});

	test("the lookup is the contract's: exact cell and ts, NULL as IS NULL, a small LIMIT, no key in the SQL", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		await substrate.emit({ surface: "omp", kind: "note", summary: "bare", idempotency_key: KEY, ts: FIRST_TS }, { replay: true });
		const [lookup] = ledger.lookups();
		expect(lookup).toContain(`"surface" = 'omp'`);
		expect(lookup).toContain(`"repo" IS NULL`);
		expect(lookup).toContain(`"graph_id" IS NULL`);
		expect(lookup).toContain(`"kind" = 'note'`);
		expect(lookup).toContain(`"ts" = '${FIRST_TS}'`);
		expect(lookup).toStartWith(LOOKUP_PREFIX);
		expect(lookup).not.toContain(KEY);
		expect(lookup).toEndWith("LIMIT 5");
		// A sessionless keyed event is a miss here, then a normal append with no chain read.
		expect(ledger.rows).toHaveLength(1);
		expect(ledger.sql.some((statement) => statement.includes('"session_id" ='))).toBe(false);
	});

	test("a marked replay of a key the ledger lacks takes one lookup and appends with `_ik`", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		const result = await substrateWith(ACCEPT, seen).emit(base({ idempotency_key: KEY }), { replay: true });
		expect(result.stored).toBe(true);
		expect(result.deduplicated).toBeUndefined();
		expect(ledger.lookups()).toHaveLength(1);
		expect(JSON.parse(defined(ledger.rows[0]).payload)._ik).toBe(KEY);
		expect(seen.replays).toEqual(["appended"]);
	});

	test("a marked replay with no key takes no lookup", async () => {
		const ledger = fakeLedger();
		await substrateWith(ACCEPT).emit(base(), { replay: true });
		expect(ledger.lookups()).toEqual([]);
		expect(ledger.rows).toHaveLength(1);
	});

	test("a replay after a success whose reply was lost finds the stored row — the core case", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		// The first attempt's INSERT lands, then the answer is a 503 the client reads as a failure.
		ledger.before = async (statement) => {
			if (!statement.startsWith('INSERT INTO "agent_events"')) return undefined;
			ledger.before = async () => undefined;
			ledger.land(statement);
			return new Response("gateway timeout", { status: 503 });
		};
		const lost = await substrate.emit(base({ idempotency_key: KEY }));
		expect(lost.stored).toBe(false);
		expect(ledger.rows).toHaveLength(1);

		const replay = await substrate.emit(base({ idempotency_key: KEY }), { replay: true });
		expect(replay.deduplicated).toBe(true);
		expect(replay.event.id).toBe(defined(ledger.rows[0]).id);
		expect(ledger.rows).toHaveLength(1);

		// The session's next event chains onto the row that is really there.
		const next = await substrate.emit(base({ summary: "after", ts: undefined }));
		expect(next.event.prev).toBe(defined(ledger.rows[0]).hash);
		expect(verifyChain(ledger.events())).toEqual({ ok: true });
	});
});

describe("inside the emit turn", () => {
	function stallFirstLookup(ledger: FakeLedger) {
		const release = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		let stalled = false;
		ledger.before = async (statement) => {
			if (!statement.startsWith(LOOKUP_PREFIX) || stalled) return undefined;
			stalled = true;
			reached.resolve();
			await release.promise;
			return undefined;
		};
		return { release: release.resolve, reached: reached.promise };
	}

	test("two concurrent same-key replays in one session leave one row", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		const gate = stallFirstLookup(ledger);
		const pending = Promise.all([
			substrate.emit(base({ idempotency_key: KEY }), { replay: true }),
			substrate.emit(base({ idempotency_key: KEY }), { replay: true }),
		]);
		await gate.reached;
		// The second waits its turn: it has not looked yet, so it cannot have missed.
		expect(ledger.lookups()).toHaveLength(1);
		gate.release();
		const [a, b] = await pending;

		expect(ledger.rows).toHaveLength(1);
		expect([a.deduplicated === true, b.deduplicated === true].sort()).toEqual([false, true]);
		expect(a.event.id).toBe(b.event.id);
		expect(verifyChain(ledger.events())).toEqual({ ok: true });
	});

	test("without a session the key is the turn: two concurrent same-key replays still leave one row", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		const gate = stallFirstLookup(ledger);
		const sessionless = base({ session_id: undefined, idempotency_key: KEY });
		const pending = Promise.all([substrate.emit(sessionless, { replay: true }), substrate.emit(sessionless, { replay: true })]);
		await gate.reached;
		expect(ledger.lookups()).toHaveLength(1);
		gate.release();
		const results = await pending;
		expect(ledger.rows).toHaveLength(1);
		expect(results.filter((result) => result.deduplicated).length).toBe(1);
	});

	test("a replay waits for the original attempt still in flight, so it dedupes against it", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		const release = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		ledger.before = async (statement) => {
			if (!statement.startsWith('INSERT INTO "agent_events"')) return undefined;
			ledger.before = async () => undefined;
			reached.resolve();
			await release.promise;
			return undefined;
		};
		const sessionless = base({ session_id: undefined, idempotency_key: KEY });
		const original = substrate.emit(sessionless);
		await reached.promise;
		const replay = substrate.emit(sessionless, { replay: true });
		release.resolve();
		const [first, second] = await Promise.all([original, replay]);
		expect(first.stored).toBe(true);
		expect(second.deduplicated).toBe(true);
		expect(ledger.rows).toHaveLength(1);
	});
});

describe("enforce", () => {
	test("every keyed request looks up, marked or not; a keyless one never does", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ENFORCE);
		await substrate.emit(base({ idempotency_key: KEY }));
		expect(ledger.lookups()).toHaveLength(1);

		const again = await substrate.emit(base({ idempotency_key: KEY }));
		expect(again.deduplicated).toBe(true);
		expect(ledger.rows).toHaveLength(1);

		await substrate.emit(base({ summary: "keyless" }));
		expect(ledger.lookups()).toHaveLength(2);
	});
});

describe("what the key does not do", () => {
	test("a caller's own `_ik` is stripped and never trusted: it cannot stand in for the key", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		await substrate.emit(base({ payload: { _ik: KEY, a: 1 } }));
		expect(JSON.parse(defined(ledger.rows[0]).payload)).toEqual({ a: 1 });

		// Not stored as a key, so a marked replay of KEY is a miss and appends.
		const replay = await substrate.emit(base({ idempotency_key: KEY }), { replay: true });
		expect(replay.deduplicated).toBeUndefined();
		expect(ledger.rows).toHaveLength(2);
		// With a real key the forged one is replaced, not kept beside it.
		await substrate.emit(base({ idempotency_key: "another-key-0002", payload: { _ik: KEY } }));
		expect(JSON.parse(defined(ledger.rows[2]).payload)).toEqual({ _ik: "another-key-0002" });
	});

	test("a `_ik` nested in someone's payload does not masquerade as the stored key", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		await substrate.emit(base({ payload: { nested: { _ik: KEY } } }));
		const replay = await substrate.emit(base({ idempotency_key: KEY }), { replay: true });
		expect(replay.deduplicated).toBeUndefined();
		expect(ledger.rows).toHaveLength(2);
	});

	test("the same key and ts in another cell is another event", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		await substrate.emit(base({ idempotency_key: KEY }));
		const otherKind = await substrate.emit(base({ idempotency_key: KEY, kind: "note" }), { replay: true });
		const otherRepo = await substrate.emit(base({ idempotency_key: KEY, repo: "acme/other" }), { replay: true });
		const otherTs = await substrate.emit(base({ idempotency_key: KEY, ts: new Date(Date.parse(FIRST_TS) + 1).toISOString() }), { replay: true });
		expect([otherKind, otherRepo, otherTs].some((result) => result.deduplicated)).toBe(false);
		expect(ledger.rows).toHaveLength(4);
	});

	test("a pattern that over-matches on `_` is a miss, never a false hit that swallows a new event", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		await substrate.emit(base({ idempotency_key: "abcd-efghij" }));
		// A `_` is a literal here: this key differs from the stored one only where a LIKE wildcard would have matched it.
		const lookalike = await substrate.emit(base({ idempotency_key: "abcd_efghij" }), { replay: true });
		expect(lookalike.deduplicated).toBeUndefined();
		expect(lookalike.stored).toBe(true);
		expect(ledger.rows).toHaveLength(2);
	});

	test("a matching row beyond the first five is found on a later page: deduplicated, nothing written", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		const substrate = substrateWith(ACCEPT, seen);
		for (const key of ["event001", "event002", "event003", "event004", "event005", "event___"]) {
			await substrate.emit(base({ idempotency_key: key }));
		}
		// Id order is the order the lookup pages through: make the real row the sixth one in it.
		ledger.rows.forEach((row, index) => {
			row.id = `evt_${String(index).padStart(3, "0")}`;
		});
		const inserts = ledger.inserts().length;
		const lookupsBefore = ledger.lookups().length;

		const replay = await substrate.emit(base({ idempotency_key: "event___" }), { replay: true });

		expect(replay.deduplicated).toBe(true);
		expect(replay.stored).toBe(true);
		expect(replay.lookupFailed).toBeUndefined();
		expect(replay.event.id).toBe("evt_005");
		expect(ledger.lookups()).toHaveLength(lookupsBefore + 2);
		expect(ledger.inserts()).toHaveLength(inserts);
		expect(ledger.rows).toHaveLength(6);
		expect(seen.replays).toEqual(["deduplicated"]);
	});

	test("a full page on every lookup page is inconclusive: 503, nothing written, never a miss that appends", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		const substrate = substrateWith(ACCEPT, seen);
		const inserts = ledger.inserts().length;
		// Every page is full of rows that are not the key, so the real row could sit past the bound.
		ledger.before = async (statement) =>
			statement.startsWith(LOOKUP_PREFIX)
				? new Response(
						JSON.stringify(
							records(
								["id", "hash", "payload"],
								Array.from({ length: IDEMPOTENCY_LOOKUP_LIMIT }, (_, index) => [`evt_${index}`, `hash-${index}`, `{"_ik":"other-${index}"}`]),
							),
						),
						{ status: 200, headers: { "content-type": "application/json" } },
					)
				: undefined;

		const replay = await substrate.emit(base({ idempotency_key: "event___" }), { replay: true });

		expect(replay.stored).toBe(false);
		expect(replay.lookupFailed).toBe(true);
		expect(replay.error).toContain("inconclusive");
		expect(ledger.lookups()).toHaveLength(IDEMPOTENCY_LOOKUP_MAX_PAGES);
		expect(ledger.inserts()).toHaveLength(inserts);
		expect(ledger.rows).toHaveLength(0);
		expect(seen.replays).toEqual(["lookup_failed"]);
	});

	test("four lookalikes and no real row is a short read: a genuine miss that appends", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		for (const key of ["event001", "event002", "event003", "event004"]) await substrate.emit(base({ idempotency_key: key }));

		const replay = await substrate.emit(base({ idempotency_key: "event___" }), { replay: true });

		expect(replay.stored).toBe(true);
		expect(replay.deduplicated).toBeUndefined();
		expect(ledger.rows).toHaveLength(5);
	});

	test("a lookalike that sorts first does not hide the real row: the exact-suffix scan still dedupes", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		await substrate.emit(base({ idempotency_key: "abcd-efghij" }));
		const real = await substrate.emit(base({ idempotency_key: "abcd_efghij" }));
		// Both rows sit in the cell at this ts, the lookalike first; only the exact key may match.
		const replay = await substrate.emit(base({ idempotency_key: "abcd_efghij" }), { replay: true });

		expect(ledger.rows).toHaveLength(2);
		expect(replay.deduplicated).toBe(true);
		expect(replay.event.id).toBe(real.event.id);
		expect(replay.event.id).not.toBe(defined(ledger.rows[0]).id);
		expect(ledger.inserts()).toHaveLength(2);
	});

	test("a payload replaced for its size still carries the key, so its replay dedupes", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		const huge = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, "x".repeat(3900)]));
		await substrate.emit(base({ idempotency_key: KEY, payload: huge }));
		expect(JSON.parse(defined(ledger.rows[0]).payload)).toMatchObject({ _dropped: expect.any(String), _ik: KEY });
		const replay = await substrate.emit(base({ idempotency_key: KEY, payload: huge }), { replay: true });
		expect(replay.deduplicated).toBe(true);
		expect(ledger.rows).toHaveLength(1);
	});
});

describe("the chain", () => {
	test("verifies after a deduplicated replay in the middle of a session", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		await substrate.emit(base({ summary: "one", ts: undefined }));
		const keyed = await substrate.emit(base({ summary: "two", idempotency_key: KEY }));
		await substrate.emit(base({ summary: "three", ts: undefined }));
		const replay = await substrate.emit(base({ summary: "two", idempotency_key: KEY }), { replay: true });
		const four = await substrate.emit(base({ summary: "four", ts: undefined }));

		expect(replay.deduplicated).toBe(true);
		expect(replay.event.id).toBe(keyed.event.id);
		expect(ledger.rows).toHaveLength(4);
		expect(four.event.prev).toBe(defined(ledger.rows[2]).hash);
		expect(verifyChain(ledger.events())).toEqual({ ok: true });
	});

	test("verifies after a late replay: a backdated ts that missed chains onto the tip", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		await substrate.emit(base({ summary: "now-ish", ts: new Date().toISOString() }));
		const long = new Date(Date.now() - 72 * HOUR_MS).toISOString();
		const late = await substrate.emit(base({ summary: "lost last week", ts: long, idempotency_key: KEY }), { replay: true });

		expect(late.stored).toBe(true);
		expect(late.event.ts).toBe(long);
		expect(late.event.prev).toBe(defined(ledger.rows[0]).hash);
		expect(verifyChain(ledger.events())).toEqual({ ok: true });
	});
});

describe("every refusal and failure writes nothing", () => {
	test("a lookup that errors is a 503-shaped `stored: false`, never a silent miss", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		const substrate = substrateWith(ACCEPT, seen);
		await substrate.emit(base({ idempotency_key: KEY }));
		const inserts = ledger.inserts().length;
		ledger.before = async (statement) => (statement.startsWith(LOOKUP_PREFIX) ? new Response("boom postgres://u:hunter2@h/db", { status: 503 }) : undefined);

		const result = await substrate.emit(base({ idempotency_key: KEY }), { replay: true });

		expect(result.stored).toBe(false);
		expect(result.lookupFailed).toBe(true);
		expect(result.error).toContain("idempotency lookup failed");
		expect(result.error).not.toContain("hunter2");
		expect(ledger.inserts()).toHaveLength(inserts);
		expect(ledger.rows).toHaveLength(1);
		expect(seen.replays).toEqual(["lookup_failed"]);

		// The client keeps its copy and retries: with the ledger back it dedupes.
		ledger.before = async () => undefined;
		expect((await substrate.emit(base({ idempotency_key: KEY }), { replay: true })).deduplicated).toBe(true);
	});

	test("a lookup row that is not a well-formed event is an error, not a miss", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(ACCEPT);
		ledger.before = async (statement) =>
			statement.startsWith(LOOKUP_PREFIX)
				? new Response(JSON.stringify(records(["id", "hash", "payload"], [[null, null, null]])), { status: 200 })
				: undefined;
		const result = await substrate.emit(base({ idempotency_key: KEY }), { replay: true });
		expect(result.stored).toBe(false);
		expect(result.lookupFailed).toBe(true);
		expect(ledger.rows).toHaveLength(0);
	});

	test("a replay stamped more than 24 hours ahead is refused by rule name before anything is sent", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		const substrate = substrateWith(ACCEPT, seen);
		const future = new Date(Date.now() + 25 * HOUR_MS).toISOString();

		const refused = await substrate.emit(base({ idempotency_key: KEY, ts: future }), { replay: true }).catch((cause: unknown) => cause);
		expect(refused).toBeInstanceOf(IdempotencyRefusal);
		expect((refused as IdempotencyRefusal).rule).toBe("replay_ts_future");
		expect(IDEMPOTENCY_RULES).toContain((refused as IdempotencyRefusal).rule);
		expect((refused as IdempotencyRefusal).message).not.toContain(future);
		expect(ledger.sql).toEqual([]);
		expect(seen.replays).toEqual(["refused"]);

		// Inside the window it is an ordinary replay; and an unmarked request with the same ts is an ordinary append.
		const soon = new Date(Date.now() + 23 * HOUR_MS).toISOString();
		expect((await substrate.emit(base({ idempotency_key: KEY, ts: soon }), { replay: true })).stored).toBe(true);
		expect((await substrate.emit(base({ idempotency_key: "another-key-0003", ts: future }))).stored).toBe(true);
	});

	test("a keyed replay without the original ts is refused before anything is sent: it could never match", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		const substrate = substrateWith(ACCEPT, seen);
		const missing: unknown[] = [undefined, null, "", 0];
		for (const ts of missing) {
			const refused = await substrate.emit(base({ idempotency_key: KEY, ts: ts as never }), { replay: true }).catch((cause: unknown) => cause);
			expect(refused).toBeInstanceOf(IdempotencyRefusal);
			expect((refused as IdempotencyRefusal).rule).toBe("replay_ts_missing");
			expect(IDEMPOTENCY_RULES).toContain("replay_ts_missing");
		}
		expect(ledger.sql).toEqual([]);
		expect(seen.replays).toEqual(["refused", "refused", "refused", "refused"]);

		// Enforce refuses it too once the request is marked; an unmarked keyed request is not a replay and appends.
		await expect(substrateWith(ENFORCE).emit(base({ idempotency_key: KEY, ts: undefined }), { replay: true })).rejects.toBeInstanceOf(IdempotencyRefusal);
		expect((await substrateWith(ACCEPT).emit(base({ idempotency_key: KEY, ts: undefined }))).stored).toBe(true);
		// A marker with no key has nothing to match, so it only meets the future bound.
		expect((await substrateWith(ACCEPT).emit(base({ ts: undefined, summary: "no key" }), { replay: true })).stored).toBe(true);
		// Under off the marker and the key are not read at all.
		expect((await substrateWith({}).emit(base({ idempotency_key: KEY, ts: undefined, summary: "off" }), { replay: true })).stored).toBe(true);
	});

	test("a numeric ts is held to the 24 hour bound exactly like a string", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		const substrate = substrateWith(ACCEPT, seen);
		const far = Date.now() + 48 * HOUR_MS;

		for (const key of [KEY, undefined]) {
			const refused = await substrate.emit(base({ idempotency_key: key, ts: far as never }), { replay: true }).catch((cause: unknown) => cause);
			expect(refused).toBeInstanceOf(IdempotencyRefusal);
			expect((refused as IdempotencyRefusal).rule).toBe("replay_ts_future");
		}
		expect(ledger.sql).toEqual([]);
		expect(seen.replays).toEqual(["refused", "refused"]);

		// Inside the window a numeric ts is a normal replay: the same instant as the string form, stored as its ISO text.
		const near = Date.now() - HOUR_MS;
		const result = await substrate.emit(base({ idempotency_key: KEY, ts: near as never }), { replay: true });
		expect(result.stored).toBe(true);
		expect(result.event.ts).toBe(new Date(near).toISOString());
	});

	test("a replay marker with no key still cannot carry a future ts", async () => {
		const ledger = fakeLedger();
		const future = new Date(Date.now() + 48 * HOUR_MS).toISOString();
		await expect(substrateWith(ACCEPT).emit(base({ ts: future }), { replay: true })).rejects.toBeInstanceOf(IdempotencyRefusal);
		expect(ledger.sql).toEqual([]);
	});

	test("an invalid key is refused by rule name, only when the mode is not off", async () => {
		const ledger = fakeLedger();
		const seen: Seen = { replays: [], emitted: 0 };
		for (const mode of [ACCEPT, ENFORCE]) {
			const substrate = substrateWith(mode, seen);
			for (const [key, rule] of [
				[7, "idempotency_key_type"],
				[["a"], "idempotency_key_type"],
				["", "idempotency_key_format"],
				["short", "idempotency_key_format"],
				["x".repeat(129), "idempotency_key_format"],
				["has space in it", "idempotency_key_format"],
				["quote'inside-key", "idempotency_key_format"],
				["percent%inside-key", "idempotency_key_format"],
			] as const) {
				const refused = await substrate.emit(base({ idempotency_key: key as never })).catch((cause: unknown) => cause);
				expect(refused).toBeInstanceOf(InvalidEventError);
				expect((refused as IdempotencyRefusal).rule).toBe(rule);
			}
		}
		expect(ledger.sql).toEqual([]);
		expect(seen.replays.every((result) => result === "refused")).toBe(true);
		expect(seen.replays).toHaveLength(16);

		// The boundary lengths and the whole alphabet are fine.
		const ok = await substrateWith(ACCEPT).emit(base({ idempotency_key: "Az09._:-" }));
		expect(ok.stored).toBe(true);
		expect((await substrateWith(ACCEPT).emit(base({ idempotency_key: "k".repeat(128), summary: "wide" }))).stored).toBe(true);
		// `null` is no key; and the same bad key under `off` is not even read.
		expect((await substrateWith(ACCEPT).emit(base({ idempotency_key: null as never, summary: "none" }))).stored).toBe(true);
		expect((await substrateWith({}).emit(base({ idempotency_key: "bad key", summary: "off" }))).stored).toBe(true);
	});
});

describe("normalizeEvent", () => {
	test("without the third argument it is exactly what it was: no `_ik` handling at all", () => {
		const event = normalizeEvent({ surface: "omp", kind: "note", summary: "s", payload: { _ik: "x" } }, null);
		expect(event.payload).toEqual({ _ik: "x" });
	});
});

describe("config", () => {
	test("unset, blank and off are off; accept and enforce parse whatever the case and spacing", () => {
		expect(loadConfig({}).eventIdempotency).toBe("off");
		expect(loadConfig({ SUBSTRATE_EVENT_IDEMPOTENCY: "  " }).eventIdempotency).toBe("off");
		expect(loadConfig({ SUBSTRATE_EVENT_IDEMPOTENCY: "off" }).eventIdempotency).toBe("off");
		expect(loadConfig({ SUBSTRATE_EVENT_IDEMPOTENCY: " Accept " }).eventIdempotency).toBe("accept");
		expect(loadConfig({ SUBSTRATE_EVENT_IDEMPOTENCY: "ENFORCE" }).eventIdempotency).toBe("enforce");
		for (const env of [{}, { SUBSTRATE_EVENT_IDEMPOTENCY: "accept" }]) {
			expect(eventIdempotencyConfigWarnings(loadConfig(env))).toEqual([]);
		}
	});

	test("anything else is off with one boot warning that names the value", () => {
		for (const raw of ["on", "true", "1", "enforc", "report"]) {
			const loaded = loadConfig({ SUBSTRATE_EVENT_IDEMPOTENCY: raw });
			expect(loaded.eventIdempotency).toBe("off");
			const warnings = eventIdempotencyConfigWarnings(loaded);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("SUBSTRATE_EVENT_IDEMPOTENCY");
			expect(warnings[0]).toContain(raw);
			expect(warnings[0]).toContain("running as off");
		}
	});
});

describe("over HTTP", () => {
	const running: Array<{ close(): void }> = [];
	afterAll(() => {
		for (const harness of running) harness.close();
	});

	async function serve(env: Record<string, string>): Promise<{ base: string; observability: Observability }> {
		const full = { SUBSTRATE_ALLOW_ANONYMOUS: "1", SUBSTRATE_HEALTHZ_CACHE_MS: "0", SUBSTRATE_LEDGER_WRITE_PROBE_S: "0", ...env };
		const loaded = loadConfig(full);
		const observability = createObservability(loaded, full);
		await observability.start();
		const greptime = new GreptimeClient(config, { ledger: loaded.ledger });
		const substrate = new Substrate(loaded, { index: null, greptime }, observability.observer);
		const server = createHttpServer(substrate, loaded, observability, { anonymousLog: () => {} });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		running.push({
			close() {
				observability.stop();
				server.close();
			},
		});
		return { base: `http://127.0.0.1:${port}`, observability };
	}

	/** `fetch` is replaced by the fake ledger, so the test's own calls go through the real one. */
	const post = (harness: { base: string }, body: unknown, headers: Record<string, string> = {}) =>
		originalFetch(`${harness.base}/events`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

	const wire = (extra: Record<string, unknown> = {}) => ({
		surface: "omp",
		kind: "shell",
		summary: "ran cargo test",
		session_id: "sess-http",
		repo: "acme/widgets",
		ts: FIRST_TS,
		...extra,
	});

	function replayCount(harness: { observability: Observability }, result: string): number {
		const counter = findCounter(harness.observability.snapshot(), METRIC.eventsReplay);
		return counter?.points.find((point) => point.attributes.result === result)?.value ?? 0;
	}

	test("/healthz reports the mode, truthfully for each", async () => {
		fakeLedger();
		for (const [env, expected] of [
			[{}, "off"],
			[{ SUBSTRATE_EVENT_IDEMPOTENCY: "accept" }, "accept"],
			[{ SUBSTRATE_EVENT_IDEMPOTENCY: "enforce" }, "enforce"],
			[{ SUBSTRATE_EVENT_IDEMPOTENCY: "bogus" }, "off"],
		] as const) {
			const harness = await serve(env);
			const body = (await (await originalFetch(`${harness.base}/healthz`)).json()) as { idempotency?: string };
			expect(body.idempotency).toBe(expected);
		}
	});

	test("a marked replay of a stored key is 202 with `deduplicated: true` and the original id", async () => {
		const ledger = fakeLedger();
		const harness = await serve(ACCEPT);
		const first = await post(harness, wire({ idempotency_key: KEY }));
		const firstBody = (await first.json()) as { id: string; hash: string; stored: boolean; deduplicated?: boolean };
		expect(first.status).toBe(202);
		expect(firstBody.deduplicated).toBeUndefined();

		const replay = await post(harness, wire({ idempotency_key: KEY }), { "x-substrate-replay": "1" });
		const replayBody = (await replay.json()) as { id: string; hash: string; ts: string; stored: boolean; deduplicated?: boolean };
		expect(replay.status).toBe(202);
		expect(replayBody).toMatchObject({ id: firstBody.id, hash: firstBody.hash, ts: FIRST_TS, stored: true, deduplicated: true });
		expect(ledger.rows).toHaveLength(1);
		expect(replayCount(harness, "deduplicated")).toBe(1);

		// The same body without the marker is not a replay under accept: it appends.
		await post(harness, wire({ idempotency_key: KEY }));
		expect(ledger.rows).toHaveLength(2);
	});

	test("a lookup the ledger fails is 503 with `stored: false` and nothing written", async () => {
		const ledger = fakeLedger();
		const harness = await serve(ACCEPT);
		ledger.before = async (statement) => (statement.startsWith(LOOKUP_PREFIX) ? new Response("down", { status: 503 }) : undefined);
		const response = await post(harness, wire({ idempotency_key: KEY }), { "x-substrate-replay": "1" });
		const body = (await response.json()) as { stored: boolean; error: string };
		expect(response.status).toBe(503);
		expect(body.stored).toBe(false);
		expect(body.error).toContain("idempotency lookup failed");
		expect(ledger.rows).toHaveLength(0);
		expect(ledger.inserts()).toEqual([]);
		expect(replayCount(harness, "lookup_failed")).toBe(1);
	});

	test("a bad key, a keyed replay without ts and a future replay are 400 with their rule name; nothing is stored", async () => {
		const ledger = fakeLedger();
		const harness = await serve(ACCEPT);
		const bad = await post(harness, wire({ idempotency_key: "no good" }));
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ rule: "idempotency_key_format", error: expect.stringContaining("idempotency_key_format") });

		const missing = await post(harness, wire({ idempotency_key: KEY, ts: undefined }), { "x-substrate-replay": "1" });
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({ rule: "replay_ts_missing", error: expect.stringContaining("replay_ts_missing") });

		const future = await post(harness, wire({ idempotency_key: KEY, ts: new Date(Date.now() + 30 * HOUR_MS).toISOString() }), { "x-substrate-replay": "1" });
		expect(future.status).toBe(400);
		expect(await future.json()).toMatchObject({ rule: "replay_ts_future" });
		expect(ledger.sql).toEqual([]);
		expect(replayCount(harness, "refused")).toBe(3);
	});

	test("under off the header and any key are ignored: 202 both times, two rows, and the body is today's", async () => {
		const ledger = fakeLedger();
		const harness = await serve({});
		const first = await post(harness, wire({ idempotency_key: "no good" }));
		const second = await post(harness, wire({ idempotency_key: "no good" }), { "x-substrate-replay": "1" });
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		expect(Object.keys((await second.json()) as object).sort()).toEqual(["hash", "id", "stored", "ts"]);
		expect(ledger.rows).toHaveLength(2);
		expect(ledger.lookups()).toEqual([]);
		const replayPoints = findCounter(harness.observability.snapshot(), METRIC.eventsReplay)?.points ?? [];
		expect(replayPoints.reduce((total, point) => total + point.value, 0)).toBe(0);
	});
});
