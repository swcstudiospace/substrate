/**
 * The digest's and the brief's live reads through `Substrate` (phase 67): the handoff read is a bounded, handoff-only ledger
 * query and reports its failure, a repository is looked up as the caller spelled it, and the brief's live sections run under
 * the brief's own deadline. The ledger and the index are fakes that record what they were asked; the only timer is the brief
 * deadline's own, which is the thing under test (the same exception `brief-fast-path.test.ts` makes).
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { normalizeEvent } from "./event.ts";
import { buildHandoff, type HandoffPacket } from "./handoff.ts";
import type { EventQuery } from "./greptime.ts";
import { HANDOFF_READ_LIMIT } from "./session-context.ts";
import { Substrate } from "./service.ts";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");

/** A genuine packet, as `coord_handoff` builds it. */
const goodPacket = (goal: string): HandoffPacket => buildHandoff({ from: { surface: "grok-bot", session_id: null }, to: { surface: "hermes", session_id: null }, goal });

/** A handoff row as the ledger returns it: loosely typed, payload as JSON text. */
const handoffRow = (id: string, goal: string, graphId: string): Record<string, unknown> => ({
	id,
	ts: NOW - 5_000,
	surface: "grok-bot",
	kind: "handoff",
	graph_id: graphId,
	summary: `handoff: ${goal}`,
	payload: JSON.stringify({ handoff: goodPacket(goal) }),
	hash: "h",
	prev: null,
	actor: "agent",
	step: null,
});

interface FakeLedger {
	queries: EventQuery[];
	recentFor: string[];
	failGraphs: Set<string>;
	rowsByGraph: Map<string, Array<Record<string, unknown>>>;
	/** Set to make `queryEvents` never answer, so a deadline has something to cut. */
	hang: boolean;
}

function ledger(): { fake: FakeLedger; greptime: unknown } {
	const fake: FakeLedger = { queries: [], recentFor: [], failGraphs: new Set(), rowsByGraph: new Map(), hang: false };
	const greptime = {
		queryEvents: async (query: EventQuery): Promise<Array<Record<string, unknown>>> => {
			fake.queries.push(query);
			if (fake.hang) return new Promise<Array<Record<string, unknown>>>(() => undefined);
			const graphId = query.match?.graph_id ?? "";
			if (fake.failGraphs.has(graphId)) throw new Error("ledger timed out");
			return fake.rowsByGraph.get(graphId) ?? [];
		},
		// The full-history read the digest must not use.
		readEvents: async (): Promise<Array<Record<string, unknown>>> => {
			throw new Error("the digest must not read a graph's whole history");
		},
		recentForRepo: async (repo: string): Promise<Array<Record<string, unknown>>> => {
			fake.recentFor.push(repo);
			return [];
		},
		sql: async (): Promise<Array<Record<string, unknown>>> => [],
	};
	return { fake, greptime };
}

const indexWith = (graphIds: string[], asked: string[] = []) => ({
	openGraphs: async (repo: string) => {
		asked.push(repo);
		return graphIds.map((graph_id) => ({ graph_id }));
	},
	claimedNodesForRepo: async (repo: string) => {
		asked.push(repo);
		return [];
	},
	getGraph: async () => null,
	memoryForBrief: async () => [],
});

describe("the digest's handoff read", () => {
	test("is a bounded, handoff-only ledger query per graph, never a graph's whole history", async () => {
		const { fake, greptime } = ledger();
		fake.rowsByGraph.set("g1", [handoffRow("e1", "finish the parser", "g1")]);
		const substrate = new Substrate(loadConfig({}), { index: indexWith(["g1", "g2"]) as never, greptime: greptime as never });

		const digest = await substrate.sessionContext({ repoId: "owner/name", sessionId: null });

		expect(fake.queries).toHaveLength(2);
		for (const query of fake.queries) expect(query).toMatchObject({ match: { kind: "handoff" }, includePayload: true, limit: HANDOFF_READ_LIMIT, order: "desc" });
		expect(fake.queries.map((query) => query.match?.graph_id).sort()).toEqual(["g1", "g2"]);
		expect(digest.handoffs.map((handoff) => handoff.goal)).toEqual(["finish the parser"]);
		expect(digest.notes.filter((note) => note.startsWith("handoffs"))).toEqual([]);
		expect(digest.truncated.handoffs).toBe(false);
	});

	test("a full window says older packets may exist", async () => {
		const { fake, greptime } = ledger();
		fake.rowsByGraph.set(
			"g1",
			Array.from({ length: HANDOFF_READ_LIMIT }, (_, n) => handoffRow(`e${n}`, `goal ${n}`, "g1")),
		);
		const substrate = new Substrate(loadConfig({}), { index: indexWith(["g1"]) as never, greptime: greptime as never });
		expect((await substrate.sessionContext({ repoId: "owner/name", sessionId: null })).truncated.handoffs).toBe(true);
	});

	test("one graph whose read failed is named and the others' handoffs are kept; it is not an empty list that looks complete", async () => {
		const { fake, greptime } = ledger();
		fake.rowsByGraph.set("g1", [handoffRow("e1", "finish the parser", "g1")]);
		fake.failGraphs.add("g2");
		const substrate = new Substrate(loadConfig({}), { index: indexWith(["g1", "g2"]) as never, greptime: greptime as never });

		const digest = await substrate.sessionContext({ repoId: "owner/name", sessionId: null });

		expect(digest.handoffs).toHaveLength(1);
		expect(digest.notes).toContain("handoffs: 1 of 2 graphs unavailable");
		expect(digest.truncated.handoffs).toBe(true);
	});

	test("when every graph's read failed the source is unavailable", async () => {
		const { fake, greptime } = ledger();
		fake.failGraphs.add("g1");
		fake.failGraphs.add("g2");
		const substrate = new Substrate(loadConfig({}), { index: indexWith(["g1", "g2"]) as never, greptime: greptime as never });

		const digest = await substrate.sessionContext({ repoId: "owner/name", sessionId: null });

		expect(digest.notes.filter((note) => note.startsWith("handoffs"))).toEqual(["handoffs: unavailable"]);
		expect(digest.handoffs).toEqual([]);
	});

	test("a ledger that cannot answer is a typed failure from recentHandoffsForGraph, and a row that does not decode is one fewer packet", async () => {
		const { fake, greptime } = ledger();
		fake.rowsByGraph.set("g1", [handoffRow("e1", "ok", "g1"), { ...handoffRow("e2", "bad", "g1"), ts: "not a time" }]);
		fake.failGraphs.add("g2");
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: greptime as never });

		expect(await substrate.recentHandoffsForGraph("g2")).toEqual({ ok: false });
		const read = await substrate.recentHandoffsForGraph("g1");
		expect(read.ok && read.entries.map((entry) => entry.packet.goal)).toEqual(["ok"]);
	});
});

describe("a hostile handoff payload in the ledger", () => {
	/** What `events_emit` stores for a `handoff` event: any payload is accepted, so the ledger can hold each of these. */
	const storedRow = (id: string, graphId: string, payload: Record<string, unknown>): Record<string, unknown> => {
		const event = normalizeEvent({ surface: "grok-bot", kind: "handoff", summary: `handoff ${id}`, graph_id: graphId, payload }, null);
		return { ...handoffRow(id, "unused", graphId), payload: JSON.stringify(event.payload) };
	};
	const hostile = (graphId: string): Array<Record<string, unknown>> => [
		storedRow("e-empty", graphId, { handoff: {} }),
		storedRow("e-number", graphId, { handoff: { goal: 5 } }),
		storedRow("e-null", graphId, { handoff: null }),
		storedRow("e-text", graphId, { handoff: "a string" }),
		storedRow("e-list", graphId, { handoff: ["goal"] }),
		storedRow("e-huge", graphId, { handoff: { ...goodPacket("x"), goal: "g".repeat(4_000) } }),
		storedRow("e-lists", graphId, { handoff: { ...goodPacket("y"), files: "not a list", blockers: [1, 2] } }),
		handoffRow("e-good", "the good packet", graphId),
	];

	test("is skipped alone: the digest and the typed read keep the good packet and report no failure", async () => {
		const { fake, greptime } = ledger();
		fake.rowsByGraph.set("g1", hostile("g1"));
		const substrate = new Substrate(loadConfig({}), { index: indexWith(["g1"]) as never, greptime: greptime as never });

		const digest = await substrate.sessionContext({ repoId: "owner/name", sessionId: null });
		expect(digest.handoffs.map((handoff) => handoff.goal)).toEqual(["the good packet"]);
		expect(digest.notes.filter((note) => note.startsWith("handoffs"))).toEqual([]);

		const read = await substrate.recentHandoffsForGraph("g1");
		expect(read.ok && read.entries.map((entry) => entry.packet.goal)).toEqual(["the good packet"]);
	});

	test("does not fail the brief: the good packet is listed and the section is not replaced by a note", async () => {
		const { fake, greptime } = ledger();
		fake.rowsByGraph.set("ut-1", hostile("ut-1"));
		const substrate = new Substrate(loadConfig({ SUBSTRATE_BRIEF_SESSIONS: "on" }), { index: indexWith([]) as never, greptime: greptime as never });

		const text = await substrate.brief({ surface: "cursor", repo: "owner/name", graph_id: "ut-1" });

		expect(text).toContain("the good packet");
		expect(text).not.toContain("Live handoffs not included");
	});
});

describe("a repository is looked up as the caller spelled it", () => {
	test("the index and the ledger see Acme/Widgets, while the digest scopes it in lower case", async () => {
		const { fake, greptime } = ledger();
		const asked: string[] = [];
		const substrate = new Substrate(loadConfig({}), { index: indexWith([], asked) as never, greptime: greptime as never });

		const digest = await substrate.sessionContext({ repoId: "Acme/Widgets", sessionId: null });

		expect(fake.recentFor).toEqual(["Acme/Widgets"]);
		expect(asked).toEqual(["Acme/Widgets", "Acme/Widgets"]);
		expect(digest.repo_id).toBe("acme/widgets");
	});
});

describe("the brief's live sections run under the brief's deadline", () => {
	test("a handoff read that never answers is cut at the deadline and named, and the rest of the brief is served", async () => {
		const { fake, greptime } = ledger();
		fake.hang = true;
		const substrate = new Substrate(loadConfig({ SUBSTRATE_BRIEF_SESSIONS: "on", SUBSTRATE_BRIEF_BUDGET_MS: "40" }), { index: indexWith([]) as never, greptime: greptime as never });

		const text = await substrate.brief({ surface: "cursor", repo: "owner/name", graph_id: "ut-1" });

		expect(fake.queries).toHaveLength(1);
		expect(text).toContain("Live handoffs not included: not ready before the brief's deadline.");
		// The normal brief is whole: its own heading is there.
		expect(text.length).toBeGreaterThan(0);
	});

	test("with the flag off the live reads are not started at all", async () => {
		const { fake, greptime } = ledger();
		fake.hang = true;
		const substrate = new Substrate(loadConfig({ SUBSTRATE_BRIEF_BUDGET_MS: "40" }), { index: indexWith([]) as never, greptime: greptime as never });

		const text = await substrate.brief({ surface: "cursor", repo: "owner/name", graph_id: "ut-1" });

		expect(fake.queries).toEqual([]);
		expect(text).not.toContain("Live handoffs");
	});
});
