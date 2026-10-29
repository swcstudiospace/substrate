/**
 * The session context digest (phase 67): bounds and truncation, the caller's own rows left out, redaction, one source failing
 * alone, deterministic order and the byte cap. Every source is an injected function and the clock is a number, so nothing
 * here touches a store or waits.
 */
import { describe, expect, test } from "bun:test";
import { REDACTED } from "./redact.ts";
import {
	SESSION_CONTEXT_LIMITS,
	SESSION_CONTEXT_MAX_BYTES,
	SESSION_CONTEXT_TEXT_MAX,
	assembleSessionContext,
	parseSessionContextArgs,
	planningChangedCount,
	type ClaimRow,
	type HandoffRow,
	type LedgerRow,
	type PresenceRow,
	type SessionContext,
	type SessionContextSources,
	type SteeringStateRow,
} from "./session-context.ts";
import { defined } from "./test-support.ts";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const REPO = "swcstudiospace/agent-substrate";
/** Shaped like a credential the redactor knows; never a real one. */
const SECRET = "ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";

const none: SessionContextSources = { presence: null, steering: null, claims: null, ledger: null, graphs: null, handoffs: null };

const answer =
	<T>(items: readonly T[], truncated?: boolean) =>
	async () => ({ items, ...(truncated === undefined ? {} : { truncated }) });

const sources = (overrides: Partial<SessionContextSources>): SessionContextSources => ({ ...none, ...overrides });

const presenceRow = (n: number, overrides: Partial<PresenceRow> = {}): PresenceRow => ({
	sessionId: `wt-${n}`,
	worktree: `/w/${n}`,
	branch: `b${n}`,
	lastHeartbeatMs: NOW - n * 1000,
	state: "active",
	...overrides,
});
const claimRow = (n: number, overrides: Partial<ClaimRow> = {}): ClaimRow => ({
	graphId: `g${n}`,
	nodeId: `n${n}`,
	holder: "omp",
	sessionId: `s${n}`,
	leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
	claimedAtMs: NOW - n * 1000,
	...overrides,
});
const ledgerRow = (n: number, overrides: Partial<LedgerRow> = {}): LedgerRow => ({
	tsMs: NOW - n * 1000,
	surface: "claude-code",
	sessionId: `e${n}`,
	kind: "note",
	summary: `did ${n}`,
	planningChanged: null,
	...overrides,
});
const handoffRow = (n: number, overrides: Partial<HandoffRow> = {}): HandoffRow => ({ graphId: `g${n}`, goal: `goal ${n}`, createdAtMs: NOW - n * 1000, verified: true, ...overrides });

const bytes = (digest: SessionContext): number => new TextEncoder().encode(JSON.stringify(digest)).byteLength;
const run = (provided: SessionContextSources, request: { sessionId?: string | null; limit?: number } = {}): Promise<SessionContext> =>
	assembleSessionContext({ repoId: REPO, sessionId: request.sessionId ?? null, limit: request.limit }, provided, { nowMs: NOW });

describe("bounds", () => {
	test("every list stops at its bound and `truncated` names exactly the lists that lost items", async () => {
		const digest = await run(
			sources({
				presence: answer(Array.from({ length: 25 }, (_, n) => presenceRow(n))),
				claims: answer(Array.from({ length: 25 }, (_, n) => claimRow(n))),
				ledger: answer([
					...Array.from({ length: 40 }, (_, n) => ledgerRow(n)),
					...Array.from({ length: 15 }, (_, n) => ledgerRow(100 + n, { planningChanged: 2, sessionId: "obs" })),
				]),
				handoffs: answer(Array.from({ length: 15 }, (_, n) => handoffRow(n))),
			}),
		);
		expect({
			sessions: digest.sessions.length,
			claims: digest.claims.length,
			events: digest.events.length,
			handoffs: digest.handoffs.length,
			planning: digest.planning.length,
		}).toEqual(SESSION_CONTEXT_LIMITS);
		expect(digest.truncated).toEqual({ sessions: true, claims: true, events: true, handoffs: true, planning: true });
		expect(bytes(digest)).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_BYTES);
	});

	test("a list inside its bound is not truncated, and a source's own truncation is carried through", async () => {
		const digest = await run(sources({ presence: answer([presenceRow(1)], true), claims: answer([claimRow(1)]), ledger: answer([ledgerRow(1)], false) }));
		expect(digest.truncated).toEqual({ sessions: true, claims: false, events: false, handoffs: false, planning: false });
	});

	test("`limit` lowers every list but never raises one past its bound", async () => {
		const rows = Array.from({ length: 12 }, (_, n) => presenceRow(n));
		expect((await run(sources({ presence: answer(rows) }), { limit: 3 })).sessions).toHaveLength(3);
		expect((await run(sources({ presence: answer(rows) }), { limit: 100 })).sessions).toHaveLength(12);
		const many = Array.from({ length: 30 }, (_, n) => presenceRow(n));
		expect((await run(sources({ presence: answer(many) }), { limit: 100 })).sessions).toHaveLength(SESSION_CONTEXT_LIMITS.sessions);
	});

	test("past the byte cap the oldest events go first and every other list is left whole", async () => {
		const long = "x".repeat(400);
		// Events alone are over the cap; the other lists are small, so dropping events is enough.
		const digest = await run(
			sources({
				presence: answer(Array.from({ length: 20 }, (_, n) => presenceRow(n))),
				claims: answer(Array.from({ length: 20 }, (_, n) => claimRow(n))),
				ledger: answer([
					...Array.from({ length: 30 }, (_, n) => ledgerRow(n, { summary: long, surface: long, kind: long, sessionId: long })),
					...Array.from({ length: 10 }, (_, n) => ledgerRow(200 + n, { planningChanged: 1 })),
				]),
				handoffs: answer(Array.from({ length: 10 }, (_, n) => handoffRow(n))),
			}),
		);
		expect(bytes(digest)).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_BYTES);
		expect(digest.events.length).toBeGreaterThan(0);
		expect(digest.events.length).toBeLessThan(SESSION_CONTEXT_LIMITS.events);
		expect(digest.truncated).toEqual({ sessions: false, claims: false, events: true, handoffs: false, planning: false });
		expect({ sessions: digest.sessions.length, claims: digest.claims.length, handoffs: digest.handoffs.length, planning: digest.planning.length }).toEqual({
			sessions: 20,
			claims: 20,
			handoffs: 10,
			planning: 10,
		});
		// What stays of the events is the newest: the first is the age-0 event, and ages only grow down the list.
		const ages = digest.events.map((event) => event.age_s);
		expect(ages[0]).toBe(0);
		expect(ages).toEqual([...ages].sort((a, b) => a - b));
	});

	test("when events and planning are gone and it is still over, handoffs and then claims lose their oldest", async () => {
		const long = "x".repeat(400);
		const digest = await run(
			sources({
				presence: answer(Array.from({ length: 20 }, (_, n) => presenceRow(n, { worktree: `/w/${long}`, branch: long, sessionId: `wt-${n}-${long}` }))),
				claims: answer(Array.from({ length: 20 }, (_, n) => claimRow(n, { graphId: `g${n}${long}`, nodeId: `n${n}${long}`, holder: long }))),
				ledger: answer(Array.from({ length: 30 }, (_, n) => ledgerRow(n, { summary: long }))),
				handoffs: answer(Array.from({ length: 10 }, (_, n) => handoffRow(n, { goal: long }))),
			}),
		);
		expect(bytes(digest)).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_BYTES);
		expect(digest.events).toEqual([]);
		expect(digest.handoffs).toEqual([]);
		expect(digest.truncated).toMatchObject({ events: true, handoffs: true, claims: true });
		// Claims keep their newest: the first of what is left is the age-0 claim.
		expect(digest.claims[0]?.age_s).toBe(0);
	});
});

describe("the caller's own session", () => {
	test("its presence, steering and ledger rows are left out, and nobody else's", async () => {
		const steering: SteeringStateRow[] = [
			{ surface: "omp", sessionId: "me", state: "ACTIVE", updatedAtMs: NOW },
			{ surface: "hermes", sessionId: "them", state: "PAUSED", updatedAtMs: NOW - 5000 },
		];
		const digest = await run(
			sources({
				presence: answer([presenceRow(1, { sessionId: "me" }), presenceRow(2, { sessionId: "other" })]),
				steering: answer(steering),
				ledger: answer([ledgerRow(1, { sessionId: "me" }), ledgerRow(2, { sessionId: "them" }), ledgerRow(3, { sessionId: null })]),
			}),
			{ sessionId: "me" },
		);
		expect(digest.for_session).toBe("me");
		expect(digest.sessions.map((session) => session.session_id).sort()).toEqual(["other", "them"]);
		expect(digest.events.map((event) => event.session_id)).toEqual(["them", null]);
	});

	test("with no session named every row is kept", async () => {
		const digest = await run(sources({ presence: answer([presenceRow(1, { sessionId: "me" })]) }));
		expect(digest.for_session).toBeNull();
		expect(digest.sessions).toHaveLength(1);
	});
});

describe("redaction and cuts", () => {
	test("a secret-shaped string planted in every free-text field never reaches the digest", async () => {
		const digest = await run(
			sources({
				presence: answer([presenceRow(1, { worktree: `/w/${SECRET}`, branch: `b-${SECRET}` })]),
				steering: answer([{ surface: "omp", sessionId: `s-${SECRET}`, state: "ACTIVE", updatedAtMs: NOW }]),
				claims: answer([claimRow(1, { holder: SECRET, nodeId: `n-${SECRET}` })]),
				ledger: answer([ledgerRow(1, { summary: `pushed with ${SECRET}` })]),
				graphs: answer(["g1"]),
				handoffs: async () => ({ items: [handoffRow(1, { goal: `use ${SECRET} to deploy` })] }),
			}),
		);
		const text = JSON.stringify(digest);
		expect(text).not.toContain(SECRET);
		expect(text).toContain(REDACTED);
	});

	test("a summary and a goal are cut to 200 characters", async () => {
		const digest = await run(sources({ ledger: answer([ledgerRow(1, { summary: "s".repeat(500) })]), handoffs: answer([handoffRow(1, { goal: "g".repeat(500) })]) }));
		expect(defined(digest.events[0]).summary).toHaveLength(SESSION_CONTEXT_TEXT_MAX);
		expect(defined(digest.handoffs[0]).goal).toHaveLength(SESSION_CONTEXT_TEXT_MAX);
	});
});

describe("sources", () => {
	test("a source that fails gives an empty list and one note, and the rest of the digest is intact", async () => {
		const digest = await run(
			sources({
				presence: async () => {
					throw new Error(`connect refused for host.internal ${SECRET}`);
				},
				steering: answer([{ surface: "omp", sessionId: "s1", state: "ACTIVE", updatedAtMs: NOW }]),
				claims: answer([claimRow(1)]),
				ledger: answer([ledgerRow(1)]),
				graphs: answer([]),
				handoffs: answer([handoffRow(1)]),
			}),
		);
		expect(digest.notes).toEqual(["presence: unavailable"]);
		expect(digest.sessions.map((session) => session.source)).toEqual(["steering"]);
		expect({ claims: digest.claims.length, events: digest.events.length, handoffs: digest.handoffs.length }).toEqual({ claims: 1, events: 1, handoffs: 1 });
		// The failure's own message, which may name an internal host or carry a secret, is not in the digest.
		expect(JSON.stringify(digest)).not.toContain("host.internal");
	});

	test("a source that is not configured is a note, never an error", async () => {
		const digest = await run(none);
		expect(digest.notes).toEqual(["claims: not configured", "graphs: not configured", "handoffs: not configured", "ledger: not configured", "presence: not configured", "steering: not configured"]);
		expect({ sessions: digest.sessions, claims: digest.claims, events: digest.events, handoffs: digest.handoffs, planning: digest.planning }).toEqual({
			sessions: [],
			claims: [],
			events: [],
			handoffs: [],
			planning: [],
		});
	});

	test("handoffs are asked about the claims' graphs and the open graphs, once each, in a fixed order", async () => {
		let asked: readonly string[] = [];
		await run(
			sources({
				claims: answer([claimRow(2), claimRow(1)]),
				graphs: answer(["g9", "g1", "g0"]),
				handoffs: async (graphIds) => {
					asked = graphIds;
					return { items: [] };
				},
			}),
		);
		// Claims first, newest claim first (g1 was claimed after g2), then the open graphs by name, without repeats.
		expect(asked).toEqual(["g1", "g2", "g0", "g9"]);
	});

	test("a lapsed lease is a free node, not a claim; a claim from before leases existed is kept", async () => {
		const digest = await run(
			sources({
				claims: answer([
					claimRow(1, { leaseExpiresAt: new Date(NOW - 1).toISOString() }),
					claimRow(2, { leaseExpiresAt: null }),
					claimRow(3),
				]),
			}),
		);
		expect(digest.claims.map((claim) => claim.graph_id)).toEqual(["g2", "g3"]);
	});

	test("every item names its source and its age", async () => {
		const digest = await run(
			sources({
				presence: answer([presenceRow(30)]),
				steering: answer([{ surface: "omp", sessionId: "s", state: "ACTIVE", updatedAtMs: NOW - 90_000 }]),
				claims: answer([claimRow(5)]),
				ledger: answer([ledgerRow(7), ledgerRow(9, { planningChanged: 4 })]),
				handoffs: answer([handoffRow(11)]),
			}),
		);
		expect(digest.sessions.map((s) => [s.source, s.age_s])).toEqual([
			["presence", 30],
			["steering", 90],
		]);
		expect([digest.claims[0]?.source, digest.claims[0]?.age_s]).toEqual(["graph", 5]);
		expect([digest.events[0]?.source, digest.events[0]?.age_s]).toEqual(["ledger", 7]);
		expect([digest.planning[0]?.source, digest.planning[0]?.age_s, digest.planning[0]?.changed]).toEqual(["planning.changed", 9, 4]);
		expect([digest.handoffs[0]?.source, digest.handoffs[0]?.age_s]).toEqual(["handoff", 11]);
	});
});

describe("order", () => {
	test("newest first, ties broken by name, and the order of the source's answer does not matter", async () => {
		const events = [ledgerRow(5), ledgerRow(5, { surface: "a-surface", summary: "tie" }), ledgerRow(1), ledgerRow(9)];
		const forward = await run(sources({ ledger: answer(events), presence: answer([presenceRow(2), presenceRow(2, { sessionId: "wt-a" }), presenceRow(1)]) }));
		const reversed = await run(sources({ ledger: answer([...events].reverse()), presence: answer([presenceRow(1), presenceRow(2, { sessionId: "wt-a" }), presenceRow(2)]) }));
		expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
		expect(forward.events.map((event) => event.age_s)).toEqual([1, 5, 5, 9]);
		// Within the tie, the surface name decides.
		expect(forward.events.slice(1, 3).map((event) => event.surface)).toEqual(["a-surface", "claude-code"]);
	});
});

describe("planningChangedCount", () => {
	test("counts the listed and the omitted paths of a planning.changed payload, and nothing else", () => {
		expect(planningChangedCount({ kind: "planning.changed", added: [{}], removed: [{}, {}], changed: [], truncated: { added: 3, changed: 1 } })).toBe(7);
		expect(planningChangedCount({ kind: "planning.changed", added: [], removed: [], changed: [] })).toBe(0);
	});

	test("a payload that is not a planning change is null", () => {
		expect(planningChangedCount({ kind: "note" })).toBeNull();
		expect(planningChangedCount(null)).toBeNull();
		expect(planningChangedCount([])).toBeNull();
		expect(planningChangedCount("planning.changed")).toBeNull();
	});
});

describe("parseSessionContextArgs", () => {
	test("normalises the repo and accepts a session id and a limit as the tool and the route send them", () => {
		expect(parseSessionContextArgs({ repo_id: " SwcStudioSpace/Agent-Substrate ", session_id: "sess-1", limit: "5" })).toEqual({
			ok: true,
			value: { repoId: REPO, sessionId: "sess-1", limit: 5 },
		});
		expect(parseSessionContextArgs({ repo_id: REPO })).toEqual({ ok: true, value: { repoId: REPO, sessionId: null, limit: undefined } });
	});

	test("refuses a missing repo, a bad session id and a limit out of range, naming the field and never the value", () => {
		for (const [args, field] of [
			[{}, "repo_id"],
			[{ repo_id: "not a repo" }, "repo_id"],
			[{ repo_id: REPO, session_id: `bad id ${SECRET}` }, "session_id"],
			[{ repo_id: REPO, limit: 0 }, "limit"],
			[{ repo_id: REPO, limit: 101 }, "limit"],
			[{ repo_id: REPO, limit: "abc" }, "limit"],
		] as const) {
			const parsed = parseSessionContextArgs(args);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) {
				expect(parsed.error).toContain(field);
				expect(parsed.error).not.toContain(SECRET);
			}
		}
	});
});
