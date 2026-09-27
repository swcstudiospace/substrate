import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	canonicalJson,
	eventHash,
	InvalidEventError,
	normalizeEvent,
	rowToEvent,
	verifyChain,
	verifyGlobalChain,
	verifySessions,
} from "./event.ts";
import { REDACTED } from "./redact.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

const base: EventInput = {
	surface: "claude-code",
	kind: "file.edit",
	summary: "edited gateway/ws.rs, ran cargo test (pass)",
	session_id: "sess-1",
	graph_id: "ut-mz3k1q-8a1f2c3d",
	node_id: "n2",
	repo: "swcstudiospace/autonogrammer",
};

describe("canonicalJson", () => {
	test("sorts object keys so two encoders agree", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	test("preserves array order, which is meaningful", () => {
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
	});

	test("sorts nested keys too", () => {
		expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
	});

	test("drops undefined values rather than emitting invalid JSON", () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
	});
});

describe("normalizeEvent", () => {
	test("fills id, ts, actor and hash", () => {
		const event = normalizeEvent(base, null);
		expect(event.id).toMatch(/^evt_[0-9a-f]{32}$/);
		expect(event.actor).toBe("agent");
		expect(event.prev).toBeNull();
		expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(new Date(event.ts).getTime()).toBeGreaterThan(0);
	});

	test("redacts the summary and the payload on the write path", () => {
		const event = normalizeEvent(
			{ ...base, summary: "exported PGPASSWORD=s3cr3t", payload: { api_key: "abc", cmd: "cargo test" } },
			null,
		);
		expect(event.summary).toBe(`exported PGPASSWORD=${REDACTED}`);
		expect(event.payload.api_key).toBe(REDACTED);
		expect(event.payload.cmd).toBe("cargo test");
	});

	test("rejects an unknown surface or kind rather than storing it", () => {
		expect(() => normalizeEvent({ ...base, surface: "nope" as never }, null)).toThrow(InvalidEventError);
		expect(() => normalizeEvent({ ...base, kind: "nope" as never }, null)).toThrow(InvalidEventError);
	});

	test("requires a summary", () => {
		expect(() => normalizeEvent({ ...base, summary: "" }, null)).toThrow(InvalidEventError);
	});

	test("rejects an unparseable timestamp", () => {
		expect(() => normalizeEvent({ ...base, ts: "not-a-date" }, null)).toThrow(InvalidEventError);
	});

	test("truncates a runaway summary", () => {
		const event = normalizeEvent({ ...base, summary: "x".repeat(5000) }, null);
		expect(event.summary.length).toBe(2000);
	});
});

describe("hash chain", () => {
	test("the hash covers prev, so reordering is detectable", () => {
		const first = normalizeEvent(base, null);
		const second = normalizeEvent(base, first.hash);
		const { hash: _h, ...rest } = second;
		expect(eventHash({ ...rest, prev: "something-else" })).not.toBe(second.hash);
	});

	test("verifies an intact chain", () => {
		const a = normalizeEvent(base, null);
		const b = normalizeEvent({ ...base, summary: "ran cargo build" }, a.hash);
		const c = normalizeEvent({ ...base, summary: "committed 3f2a1c" }, b.hash);
		expect(verifyChain([a, b, c])).toEqual({ ok: true });
	});

	test("flags an altered event", () => {
		const a = normalizeEvent(base, null);
		const b = normalizeEvent({ ...base, summary: "ran cargo build" }, a.hash);
		const tampered: SubstrateEvent = { ...b, summary: "ran rm -rf /" };
		const result = verifyChain([a, tampered]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.brokenAt).toBe(b.id);
			expect(result.reason).toContain("hash");
		}
	});

	test("flags a spliced-out event", () => {
		const a = normalizeEvent(base, null);
		const b = normalizeEvent({ ...base, summary: "ran cargo build" }, a.hash);
		const c = normalizeEvent({ ...base, summary: "committed 3f2a1c" }, b.hash);
		const result = verifyChain([a, c]); // b removed
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("prev");
	});
});

/** Rebuild an event with some fields changed and its hash recomputed — a consistent rewrite. */
function rehash(event: SubstrateEvent, changes: Partial<SubstrateEvent>): SubstrateEvent {
	const { hash: _hash, ...rest } = { ...event, ...changes };
	return { ...rest, hash: eventHash(rest) };
}

const ISO = "2026-09-27T12:00:00.123Z";

describe("normalizeEvent with an ingest time", () => {
	test("without the third argument the event has no ingested_at key and hashes as before", () => {
		const event = normalizeEvent(base, null);
		expect("ingested_at" in event).toBe(false);
		const { hash, ...rest } = event;
		expect(canonicalJson(rest)).not.toContain("ingested_at");
		expect(eventHash(rest)).toBe(hash);
	});

	test("ingestedAt becomes ingested_at and the ts of an event with no client ts", () => {
		const event = normalizeEvent(base, "p".repeat(64), ISO);
		expect(event.ingested_at).toBe(ISO);
		expect(event.ts).toBe(ISO);
		expect(event.prev).toBe("p".repeat(64));
	});

	test("a client ts is kept and ingested_at is still set", () => {
		const event = normalizeEvent({ ...base, ts: "2026-09-01T08:00:00.000Z" }, null, ISO);
		expect(event.ts).toBe("2026-09-01T08:00:00.000Z");
		expect(event.ingested_at).toBe(ISO);
	});

	test("the hash covers ingested_at", () => {
		const event = normalizeEvent(base, null, ISO);
		const { hash, ...rest } = event;
		expect(eventHash(rest)).toBe(hash);
		expect(eventHash({ ...rest, ingested_at: "2026-09-27T12:00:00.124Z" })).not.toBe(hash);
	});

	test("an input carrying id, hash, prev or ingested_at cannot set them", () => {
		const forged = {
			...base,
			id: "evt_forged",
			hash: "f".repeat(64),
			prev: "e".repeat(64),
			ingested_at: "2000-01-01T00:00:00.000Z",
		} as unknown as EventInput;
		const chained = normalizeEvent(forged, "a".repeat(64), ISO);
		expect(chained.id).not.toBe("evt_forged");
		expect(chained.hash).not.toBe("f".repeat(64));
		expect(chained.prev).toBe("a".repeat(64));
		expect(chained.ingested_at).toBe(ISO);
		const plain = normalizeEvent(forged, null);
		expect(plain.prev).toBeNull();
		expect("ingested_at" in plain).toBe(false);
	});
});

describe("rowToEvent", () => {
	const row = {
		ts: 1790351438665,
		id: "evt_1",
		surface: "claude-code",
		session_id: "s1",
		graph_id: null,
		node_id: null,
		linear_identifier: null,
		step: "3",
		repo: "r",
		branch: null,
		actor: "agent",
		kind: "claim",
		summary: "claimed node",
		payload: '{"b":1,"a":[2]}',
		hash: "h",
		prev: null,
	};

	test("a NULL or missing ingested_at column leaves the key absent", () => {
		expect("ingested_at" in rowToEvent(row)).toBe(false);
		expect("ingested_at" in rowToEvent({ ...row, ingested_at: null })).toBe(false);
	});

	test("an epoch-ms ingested_at becomes the matching ISO string", () => {
		expect(rowToEvent({ ...row, ingested_at: Date.parse(ISO) }).ingested_at).toBe(ISO);
	});

	test("ts, step, nulls and payload are rebuilt as they were hashed", () => {
		const event = rowToEvent(row);
		expect(event.ts).toBe(new Date(1790351438665).toISOString());
		expect(event.step).toBe(3);
		expect(event.graph_id).toBeNull();
		expect(event.prev).toBeNull();
		expect(event.payload).toEqual({ b: 1, a: [2] });
		expect(rowToEvent({ ...row, payload: "not json" }).payload).toEqual({});
		expect(rowToEvent({ ...row, payload: null }).payload).toEqual({});
		expect(rowToEvent({ ...row, step: null }).step).toBeNull();
	});
});

describe("pre-cutover fixture (06-01, real rows)", () => {
	const rows = JSON.parse(
		readFileSync(new URL("./fixtures/pre-cutover-rows.json", import.meta.url), "utf8"),
	) as Array<Record<string, unknown>>;
	const byGraph = new Map<string, Array<Record<string, unknown>>>();
	for (const row of rows) {
		const key = String(row.graph_id);
		const bucket = byGraph.get(key);
		if (bucket) bucket.push(row);
		else byGraph.set(key, [row]);
	}

	test("every baseline graph verifies and every stored hash recomputes unchanged", () => {
		expect(rows.length).toBe(95);
		expect(byGraph.size).toBe(19);
		for (const [graphId, graphRows] of byGraph) {
			expect({ graphId, result: verifySessions(graphRows.map(rowToEvent)) }).toEqual({ graphId, result: { ok: true } });
		}
		for (const row of rows) {
			const { hash, ...rest } = rowToEvent(row);
			expect(eventHash(rest)).toBe(String(row.hash));
		}
	});

	test("a NULL ingested_at column still recomputes every hash (absent, not null)", () => {
		for (const row of rows) {
			const { hash, ...rest } = rowToEvent({ ...row, ingested_at: null });
			expect(eventHash(rest)).toBe(hash);
		}
	});

	test("an explicit ingested_at: null in the event changes every one of those hashes", () => {
		for (const row of rows) {
			const { hash, ...rest } = rowToEvent(row);
			const withNull = { ...rest, ingested_at: null } as unknown as Omit<SubstrateEvent, "hash">;
			expect(eventHash(withNull)).not.toBe(hash);
		}
		for (const graphRows of byGraph.values()) {
			const events = graphRows.map((row) => ({ ...rowToEvent(row), ingested_at: null }) as unknown as SubstrateEvent);
			const result = verifySessions(events);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("hash does not match contents");
		}
	});
});

describe("verifySessions", () => {
	test("two sessions interleaved by ts both verify", () => {
		const a1 = normalizeEvent({ ...base, session_id: "A", summary: "a1" }, null);
		const b1 = normalizeEvent({ ...base, session_id: "B", summary: "b1" }, null);
		const a2 = normalizeEvent({ ...base, session_id: "A", summary: "a2" }, a1.hash);
		const b2 = normalizeEvent({ ...base, session_id: "B", summary: "b2" }, b1.hash);
		const n1 = normalizeEvent({ ...base, session_id: undefined, summary: "n1" }, null);
		expect(verifySessions([a1, b1, n1, a2, b2])).toEqual({ ok: true });
		expect(verifyChain([a1, b1, a2, b2]).ok).toBe(false);
	});

	test("a tampered summary is reported at that event", () => {
		const a1 = normalizeEvent({ ...base, session_id: "A", summary: "a1" }, null);
		const b1 = normalizeEvent({ ...base, session_id: "B", summary: "b1" }, null);
		const a2 = normalizeEvent({ ...base, session_id: "A", summary: "a2" }, a1.hash);
		const tampered = { ...a2, summary: "ran rm -rf /" };
		expect(verifySessions([a1, b1, tampered])).toEqual({
			ok: false,
			brokenAt: a2.id,
			reason: "hash does not match contents",
		});
	});
});

describe("verifyGlobalChain", () => {
	/** A global chain from the genesis: sessions interleave, prev is always the previous event. */
	function globalChain(n: number): SubstrateEvent[] {
		const events: SubstrateEvent[] = [];
		let prev: string | null = null;
		for (let i = 0; i < n; i++) {
			const iso = new Date(Date.parse(ISO) + i).toISOString();
			const event = normalizeEvent({ ...base, session_id: `s${i % 3}`, summary: `step ${i}` }, prev, iso);
			events.push(event);
			prev = event.hash;
		}
		return events;
	}

	test("an intact chain passes from the genesis and from a boundary", () => {
		const events = globalChain(6);
		expect(verifyGlobalChain(events, null)).toEqual({ ok: true });
		expect(verifyGlobalChain(events.slice(2), events[1]!.hash)).toEqual({ ok: true });
		expect(verifyGlobalChain([], "x")).toEqual({ ok: true });
	});

	test("a first prev that differs from the boundary fails at the first event", () => {
		const events = globalChain(4);
		const rest = events.slice(2);
		expect(verifyGlobalChain(rest, events[0]!.hash)).toEqual({
			ok: false,
			brokenAt: rest[0]!.id,
			reason: "prev does not match the preceding event",
		});
		// A genesis event where a boundary exists is a reset, too.
		const result = verifyGlobalChain(events, "b".repeat(64));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.brokenAt).toBe(events[0]!.id);
			expect(result.reason.startsWith("chain reset")).toBe(true);
		}
	});

	test("a null prev after the first event is a chain reset", () => {
		const events = globalChain(4);
		const reset = rehash(events[2]!, { prev: null });
		const result = verifyGlobalChain([events[0]!, events[1]!, reset], null);
		expect(result).toEqual({ ok: false, brokenAt: reset.id, reason: "chain reset: null prev after genesis" });
	});

	test("a prev naming an event two or more positions back is a fork", () => {
		const events = globalChain(4);
		const forked = rehash(events[3]!, { prev: events[1]!.hash });
		const result = verifyGlobalChain([events[0]!, events[1]!, events[2]!, forked], null);
		expect(result).toEqual({
			ok: false,
			brokenAt: forked.id,
			reason: "fork: prev names an earlier event (ambiguous insert timeout)",
		});
	});

	test("a stale stored hash fails with hash does not match contents", () => {
		const events = globalChain(4);
		const stale = { ...events[2]!, summary: "ran rm -rf /" };
		expect(verifyGlobalChain([events[0]!, events[1]!, stale, events[3]!], null)).toEqual({
			ok: false,
			brokenAt: stale.id,
			reason: "hash does not match contents",
		});
	});

	test("a consistent rewrite of every event passes — only an anchor can catch it", () => {
		const rewritten: SubstrateEvent[] = [];
		let prev: string | null = null;
		for (const event of globalChain(5)) {
			const next = rehash(event, { summary: `${event.summary} (rewritten)`, prev });
			rewritten.push(next);
			prev = next.hash;
		}
		expect(verifyGlobalChain(rewritten, null)).toEqual({ ok: true });
	});
});
