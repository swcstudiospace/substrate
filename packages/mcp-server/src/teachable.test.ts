/**
 * Teachable write path (Phase 29, CARD-02/CARD-03).
 *
 * Pins the `teachable:` predicate, the slug helper, the sample-shaped event
 * builder, the shared fixture corpus outcomes, and the `writeMemory` emit
 * hook: one sample-shaped `note` on accepted + verified teachable facts,
 * nothing new on refused, quarantined, or conflicting writes.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { EVENT_SOURCES } from "./event-sources.ts";
import { governMemoryWrite } from "./memory-write.ts";
import { FakeStore } from "./memory-write.test.ts";
import { Substrate } from "./service.ts";
import {
	isTeachable,
	teachableEvent,
	teachableSlug,
} from "./teachable.ts";
import {
	ACCEPTED_TEACHABLE,
	CONFLICT_TEACHABLE,
	FOLD_COLLISION_TEACHABLES,
	QUARANTINED_TEACHABLE,
	REFUSED_TEACHABLE,
	TEACHABLE_FIXTURES,
} from "./teachable.fixtures.ts";
import type { MemoryWriteRequest, SubstrateEvent } from "./types.ts";

describe("isTeachable", () => {
	test("a fact with the prefix is a teachable", () => {
		expect(isTeachable("fact", "teachable:retry-budget")).toBe(true);
	});

	test("normalisation applies: case and padding do not matter", () => {
		expect(isTeachable("fact", "  Teachable:Retry-Budget ")).toBe(true);
	});

	test("an empty slug is not a teachable", () => {
		expect(isTeachable("fact", "teachable:")).toBe(false);
		expect(isTeachable("fact", "teachable:   ")).toBe(false);
	});

	test("other kinds are not teachables, even with the prefix", () => {
		for (const kind of ["decision", "warning", "handoff", "todo"]) {
			expect(isTeachable(kind, "teachable:retry-budget")).toBe(false);
		}
	});

	test("a missing or non-string subject is not a teachable", () => {
		expect(isTeachable("fact", undefined)).toBe(false);
		expect(isTeachable("fact", null)).toBe(false);
		expect(isTeachable("fact", "")).toBe(false);
		expect(isTeachable("fact", "retry-budget")).toBe(false);
	});
});

describe("teachableSlug", () => {
	test("returns the part after the prefix", () => {
		expect(teachableSlug("teachable:retry-budget")).toBe("retry-budget");
	});

	test("normalises before slicing", () => {
		expect(teachableSlug("Teachable:Retry-Budget")).toBe("retry-budget");
	});

	test("null outside the convention", () => {
		expect(teachableSlug("teachable:")).toBeNull();
		expect(teachableSlug("retry-budget")).toBeNull();
		expect(teachableSlug(undefined)).toBeNull();
	});
});

describe("teachableEvent", () => {
	test("is shaped like the teachable.accepted sample", () => {
		const request: MemoryWriteRequest = { ...ACCEPTED_TEACHABLE.request };
		const event = teachableEvent("hermes", request, {
			outcome: "accepted",
			reason: "ok",
			remedy: "stored",
			verified_persisted: true,
			idempotency_key: "key_1",
			writer: "hermes",
			entry: {
				id: "mem_1",
				scope: "graph:ut-teach",
				kind: "fact",
				text: request.text,
				writer: "hermes",
				subject: "teachable:retry-budget",
				actor: "agent",
				trust: "agent-claimed",
				ttl: "session",
				created: "2026-10-01T10:00:00.000Z",
				version: 1,
				entry_hash: "c".repeat(64),
				needs_reverification: false,
			},
		});

		expect(event.kind).toBe("note");
		expect(event.surface).toBe("hermes");
		expect(event.summary).toBe("teachable accepted: retry-budget");
		expect(event.session_id).toBe("sess-p29-teachable");
		expect(event.graph_id).toBe("ut-teach");
		expect(event.payload).toEqual({
			action: "teachable",
			memory_id: "mem_1",
			subject: "teachable:retry-budget",
			content_sha256: "c".repeat(64),
		});
		// No content bytes ride the trail: id, subject and hash only.
		expect(JSON.stringify(event.payload)).not.toContain("cap retries");
	});

	test("carries no session or graph id when the caller sent none", () => {
		const request: MemoryWriteRequest = {
			scope: "graph:ut-teach",
			kind: "fact",
			text: "x",
			writer: "hermes",
			subject: "teachable:retry-budget",
		};
		const event = teachableEvent("hermes", request, {
			outcome: "accepted",
			reason: "ok",
			remedy: "stored",
			verified_persisted: true,
			idempotency_key: "key_1",
			writer: "hermes",
		});
		expect(event.session_id).toBeUndefined();
		expect(event.graph_id).toBeUndefined();
		expect(event.payload).toMatchObject({ action: "teachable" });
	});
});

describe("teachable.accepted sample conformance", () => {
	test("the emitted event deep-matches the mapped sample shape", () => {
		// The sample is the contract the vocabulary already maps: kind, surface
		// semantics (the writer's surface), action, and payload keys. Values
		// come from the write; keys and shape must not drift from the map.
		const mapped = EVENT_SOURCES.find((source) => source.id === "teachable.accepted");
		expect(mapped).toBeDefined();
		expect(mapped?.kind).toBe("note");
		expect(mapped?.actions).toEqual(["teachable"]);

		const sample = mapped?.sample() as { kind: "note"; surface: string; payload: Record<string, unknown> };
		const event = teachableEvent("hermes", { ...ACCEPTED_TEACHABLE.request }, {
			outcome: "accepted",
			reason: "ok",
			remedy: "stored",
			verified_persisted: true,
			idempotency_key: "key_1",
			writer: "hermes",
			entry: {
				id: "mem_1",
				scope: "graph:ut-teach",
				kind: "fact",
				text: "t",
				writer: "hermes",
				subject: "teachable:retry-budget",
				actor: "agent",
				trust: "agent-claimed",
				ttl: "session",
				created: "2026-10-01T10:00:00.000Z",
				version: 1,
				entry_hash: "c".repeat(64),
				needs_reverification: false,
			},
		});

		expect(event.kind).toBe(sample.kind);
		expect(typeof event.surface).toBe(typeof sample.surface);
		expect(event.summary).toContain("teachable accepted: ");
		expect(Object.keys(event.payload ?? {}).sort()).toEqual(Object.keys(sample.payload as object).sort());
		expect(event.payload).toMatchObject({ action: "teachable" });
	});
});

describe("fixture corpus outcomes", () => {
	function gate(request: MemoryWriteRequest) {
		const store = new FakeStore();
		return governMemoryWrite(request, {
			store,
			isReviewToken: () => false,
			now: () => new Date(store.clock),
			newId: (prefix) => `${prefix}_1`,
			verifySourceEvent: async () => false,
		});
	}

	test("every corpus row answers its pinned outcome", async () => {
		for (const fixture of TEACHABLE_FIXTURES) {
			const result = await gate({ ...fixture.request });
			expect(result.outcome).toBe(fixture.outcome);
			if (fixture.outcome === "accepted") expect(result.verified_persisted).toBe(true);
		}
	});

	test("slugs match the predicate on every row", () => {
		for (const fixture of TEACHABLE_FIXTURES) {
			expect(teachableSlug(fixture.request.subject)).toBe(fixture.slug);
			expect(isTeachable(fixture.request.kind, fixture.request.subject)).toBe(true);
		}
	});
});

describe("writeMemory teachable emit", () => {
	/** A substrate over a real gate (`FakeStore`) that records ledger appends. */
	function scratch() {
		const emitted: SubstrateEvent[] = [];
		const index = new FakeStore();
		const greptime = {
			ensureAppendMode: async () => true,
			lastHash: async () => null,
			insertEvent: async (event: SubstrateEvent) => {
				emitted.push(event);
			},
		};
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });
		return { emitted, substrate };
	}

	const teachableEvents = (emitted: SubstrateEvent[]) =>
		emitted.filter((event) => (event.payload as Record<string, unknown> | undefined)?.action === "teachable");

	test("an accepted teachable fact emits exactly one sample-shaped note", async () => {
		const { emitted, substrate } = scratch();

		const result = await substrate.writeMemory({ ...ACCEPTED_TEACHABLE.request });

		expect(result.outcome).toBe("accepted");
		expect(result.verified_persisted).toBe(true);
		const trail = teachableEvents(emitted);
		expect(trail).toHaveLength(1);
		expect(trail[0]).toMatchObject({
			kind: "note",
			surface: "hermes",
			summary: "teachable accepted: retry-budget",
			session_id: "sess-p29-teachable",
		});
		expect(trail[0]?.payload).toEqual({
			action: "teachable",
			memory_id: result.entry?.id,
			subject: "teachable:retry-budget",
			content_sha256: result.entry?.entry_hash,
		});
		expect(trail[0]?.payload.content_sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("a refused teachable emits no teachable event", async () => {
		const { emitted, substrate } = scratch();

		const result = await substrate.writeMemory({ ...REFUSED_TEACHABLE.request });

		expect(result.outcome).toBe("denied");
		expect(teachableEvents(emitted)).toEqual([]);
	});

	test("a quarantined teachable emits no teachable event", async () => {
		const { emitted, substrate } = scratch();

		const result = await substrate.writeMemory({ ...QUARANTINED_TEACHABLE.request });

		expect(result.outcome).toBe("quarantined");
		expect(teachableEvents(emitted)).toEqual([]);
	});

	test("a conflicting teachable emits no teachable event", async () => {
		const { emitted, substrate } = scratch();

		const result = await substrate.writeMemory({ ...CONFLICT_TEACHABLE.request });

		expect(result.outcome).toBe("conflict");
		expect(teachableEvents(emitted)).toEqual([]);
	});

	test("an accepted non-teachable fact emits nothing new", async () => {
		const { emitted, substrate } = scratch();

		const result = await substrate.writeMemory({
			scope: "graph:ut-teach",
			kind: "fact",
			text: "hermes finished n2",
			writer: "hermes",
			subject: "n2-status",
		});

		expect(result.outcome).toBe("accepted");
		expect(teachableEvents(emitted)).toEqual([]);
	});

	test("a ledger that refuses the trail does not fail the memory write", async () => {
		const index = new FakeStore();
		const greptime = {
			ensureAppendMode: async () => true,
			lastHash: async () => null,
			insertEvent: async () => {
				throw new Error("greptime unreachable");
			},
		};
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		const result = await substrate.writeMemory({ ...ACCEPTED_TEACHABLE.request });

		expect(result.outcome).toBe("accepted");
		expect(result.verified_persisted).toBe(true);
	});

	test("the fold-collision pair both emit, one event each", async () => {
		const { emitted, substrate } = scratch();

		for (const fixture of FOLD_COLLISION_TEACHABLES) {
			const result = await substrate.writeMemory({ ...fixture.request });
			expect(result.outcome).toBe("accepted");
		}

		expect(teachableEvents(emitted)).toHaveLength(2);
	});

	test("an idempotent replay emits no second acceptance note", async () => {
		const { emitted, substrate } = scratch();
		const request = { ...ACCEPTED_TEACHABLE.request, idempotency_key: "key-replay-1" };

		const first = await substrate.writeMemory(request);
		expect(first.outcome).toBe("accepted");
		const replay = await substrate.writeMemory(request);
		expect(replay.outcome).toBe("accepted");
		expect(replay.deduplicated).toBe(true);

		expect(teachableEvents(emitted)).toHaveLength(1);
	});

	test("an unattributed writer emits no teachable event", async () => {
		const { emitted, substrate } = scratch();

		const result = await substrate.writeMemory({ ...ACCEPTED_TEACHABLE.request, writer: "unknown" });

		expect(result.outcome).toBe("denied");
		expect(teachableEvents(emitted)).toEqual([]);
	});
});
