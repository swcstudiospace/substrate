/**
 * The digest's and the brief's live reads through `Substrate` (phase 67): the handoff read is a bounded, handoff-only ledger
 * query and reports its failure, a repository is looked up as the caller spelled it, and the brief's live sections run under
 * the brief's own deadline. The ledger and the index are fakes that record what they were asked; the only timer is the brief
 * deadline's own, which is the thing under test (the same exception `brief-fast-path.test.ts` makes).
 */
import { describe, expect, test } from "bun:test";
import { utf8Bytes } from "./brief-profile.ts";
import { loadConfig } from "./config.ts";
import { normalizeEvent } from "./event.ts";
import { buildHandoff, type HandoffPacket } from "./handoff.ts";
import { auditToolCalls, createObservability } from "./observe.ts";
import type { EventQuery } from "./greptime.ts";
import { HANDOFF_READ_LIMIT } from "./session-context.ts";
import { Substrate } from "./service.ts";
import type { LiveSessionCaller } from "./planning/steering-sessions-store.ts";
import { createTestLiveSessionAuthority, issueLiveSession, type TestLiveSessionAuthority } from "./planning/live-session.test-support.ts";

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
		const substrate = new Substrate(loadConfig({}), { index: indexWith(["g1", "g2"]) as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });

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
		const substrate = new Substrate(loadConfig({}), { index: indexWith(["g1"]) as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });
		expect((await substrate.sessionContext({ repoId: "owner/name", sessionId: null })).truncated.handoffs).toBe(true);
	});

	test("one graph whose read failed is named and the others' handoffs are kept; it is not an empty list that looks complete", async () => {
		const { fake, greptime } = ledger();
		fake.rowsByGraph.set("g1", [handoffRow("e1", "finish the parser", "g1")]);
		fake.failGraphs.add("g2");
		const substrate = new Substrate(loadConfig({}), { index: indexWith(["g1", "g2"]) as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });

		const digest = await substrate.sessionContext({ repoId: "owner/name", sessionId: null });

		expect(digest.handoffs).toHaveLength(1);
		expect(digest.notes).toContain("handoffs: 1 of 2 graphs unavailable");
		expect(digest.truncated.handoffs).toBe(true);
	});

	test("when every graph's read failed the source is unavailable", async () => {
		const { fake, greptime } = ledger();
		fake.failGraphs.add("g1");
		fake.failGraphs.add("g2");
		const substrate = new Substrate(loadConfig({}), { index: indexWith(["g1", "g2"]) as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });

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
		const substrate = new Substrate(loadConfig({}), { index: indexWith(["g1"]) as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });

		const digest = await substrate.sessionContext({ repoId: "owner/name", sessionId: null });
		expect(digest.handoffs.map((handoff) => handoff.goal)).toEqual(["the good packet"]);
		expect(digest.notes.filter((note) => note.startsWith("handoffs"))).toEqual([]);

		const read = await substrate.recentHandoffsForGraph("g1");
		expect(read.ok && read.entries.map((entry) => entry.packet.goal)).toEqual(["the good packet"]);
	});

	test("does not fail the brief: the good packet is listed and the section is not replaced by a note", async () => {
		const { fake, greptime } = ledger();
		fake.rowsByGraph.set("ut-1", hostile("ut-1"));
		const substrate = new Substrate(loadConfig({ SUBSTRATE_BRIEF_SESSIONS: "on" }), { index: indexWith([]) as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });

		const text = await substrate.brief({ surface: "cursor", repo: "owner/name", graph_id: "ut-1" });

		expect(text).toContain("the good packet");
		expect(text).not.toContain("Live handoffs not included");
	});
});

describe("a repository is looked up as the caller spelled it", () => {
	test("the index and the ledger see Acme/Widgets, while the digest scopes it in lower case", async () => {
		const { fake, greptime } = ledger();
		const asked: string[] = [];
		const substrate = new Substrate(loadConfig({}), { index: indexWith([], asked) as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });

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
		const substrate = new Substrate(loadConfig({ SUBSTRATE_BRIEF_SESSIONS: "on", SUBSTRATE_BRIEF_BUDGET_MS: "40" }), { index: indexWith([]) as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });

		const text = await substrate.brief({ surface: "cursor", repo: "owner/name", graph_id: "ut-1" });

		expect(fake.queries).toHaveLength(1);
		expect(text).toContain("Live handoffs not included: not ready before the brief's deadline.");
		// The normal brief is whole: its own heading is there.
		expect(text.length).toBeGreaterThan(0);
	});

	test("with the flag off the live reads are not started at all", async () => {
		const { fake, greptime } = ledger();
		fake.hang = true;
		const substrate = new Substrate(loadConfig({ SUBSTRATE_BRIEF_BUDGET_MS: "40" }), { index: indexWith([]) as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });

		const text = await substrate.brief({ surface: "cursor", repo: "owner/name", graph_id: "ut-1" });

		expect(fake.queries).toEqual([]);
		expect(text).not.toContain("Live handoffs");
	});
});

describe("public digest metadata does not require a private proof", () => {
	test("cross-surface metadata retains self-label exclusion and omits all private fields", async () => {
		const authority = createTestLiveSessionAuthority({ nowMs: Date.now() });
		const own = await issueLiveSession(authority, { caller: { surface: "cursor", isOperator: false }, steering: "PRIVATE-DIGEST-OWN", planningHash: "PRIVATE-DIGEST-HASH" });
		const other = await issueLiveSession(authority, { caller: { surface: "hermes", isOperator: false }, steering: "PRIVATE-DIGEST-OTHER" });
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null, steering: { history: null, liveSessions: authority } });
		const digest = await substrate.sessionContext({ repoId: "owner/name", sessionId: own.sessionId });
		expect(digest.for_session).toBe(own.sessionId);
		expect(digest.sessions).toHaveLength(1);
		expect(digest.sessions[0]).toMatchObject({ session_id: other.sessionId, surface: "hermes", source: "steering", state: "ACTIVE" });
		expect(Object.keys(digest.sessions[0] ?? {}).sort()).toEqual(["age_s", "branch", "last_heartbeat", "session_id", "source", "state", "surface", "worktree"]);
		expect(JSON.stringify(digest)).not.toContain("PRIVATE-DIGEST");
		expect(JSON.stringify(digest)).not.toContain(own.sessionBinding);
		expect(JSON.stringify(digest)).not.toContain(other.sessionBinding);
	});

	test("authority outage degrades steering metadata without making the whole public digest private or unavailable", async () => {
		const authority = createTestLiveSessionAuthority();
		authority.unavailable = true;
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null, steering: { history: null, liveSessions: authority } });
		const digest = await substrate.sessionContext({ repoId: "owner/name", sessionId: null });
		expect(digest.sessions).toEqual([]);
		expect(digest.notes).toContain("steering: unavailable");
		expect(digest.repo_id).toBe("owner/name");
	});
});

// ── the brief's live sections: the compact byte cap, and the sessions flag ───

const AGE = /(just now|\d+ min ago|\d+h ago|\d+d ago)/;
const SESSIONS_TITLE = "Other live sessions in this repo";
const HANDOFFS_TITLE = "Open handoff packets";
const STEERING_TITLE = "Steering: 1 queued directive";
const LIVE_REPO = "acme/app";
const LIVE_GRAPH = "ut-1";

/** The graph the brief reads: active, on no branch, with no nodes, so the live sections are the only ones that vary. */
const liveGraph = () => ({
	graph_id: LIVE_GRAPH,
	notion_task_page: null,
	repo: LIVE_REPO,
	branch: null,
	surface: "cursor",
	status: "active",
	pr_url: null,
	created: null,
	updated: null,
	nodes: [],
	steps: [],
	edges: [],
});

/** The fixtures one live brief test reads: the authority, the caller's own session, another surface's session, and the reads. */
interface LiveWorld {
	authority: TestLiveSessionAuthority;
	caller: LiveSessionCaller;
	own: { sessionId: string; sessionBinding: string };
	other: { sessionId: string };
	greptime: unknown;
	index: object;
}

/**
 * The live world: the caller's own session and another surface's session in the repository, one handoff packet of the graph the
 * brief names (five minutes old), and the index and ledger the brief reads. Every read is a fake.
 */
async function liveWorld(): Promise<LiveWorld> {
	const authority = createTestLiveSessionAuthority({ nowMs: Date.now() });
	const caller = { surface: "cursor", isOperator: false } as const;
	const own = await issueLiveSession(authority, { caller, repoId: LIVE_REPO });
	const other = await issueLiveSession(authority, { caller: { surface: "hermes", isOperator: false }, repoId: LIVE_REPO });
	const { fake, greptime } = ledger();
	fake.rowsByGraph.set(LIVE_GRAPH, [{ ...handoffRow("e-live", "ship the parser", LIVE_GRAPH), ts: Date.now() - 5 * 60_000 }]);
	const index = { ...indexWith([]), getGraph: async () => liveGraph() };
	return { authority, caller, own, other, greptime, index };
}

/** A substrate over the world with `env`. The caller stops `observability` when done. */
function liveSubstrate(env: Record<string, string>, world: LiveWorld, liveSessions: TestLiveSessionAuthority | null = world.authority) {
	const config = loadConfig(env);
	const observability = createObservability(config, {});
	const substrate = new Substrate(
		config,
		{ index: world.index as never, greptime: world.greptime as never, steering: { liveSessions, history: { append: async (): Promise<void> => undefined } } },
		observability.observer,
		{ auditCalls: (principal, calls, transport) => auditToolCalls(observability, principal.surface, calls, transport) },
	);
	return { substrate, observability };
}

/** Queue one directive for the caller's own session, so the steering section has a pending line with an age. */
async function queueDirective(substrate: Substrate, sessionId: string): Promise<void> {
	const queued = await substrate.steering.inbox?.enqueue({
		id: "d-live",
		author: { principalId: "omp", kind: "human" },
		createdAtMs: Date.now(),
		priority: "normal",
		targetSessionId: sessionId,
		action: "annotate",
		body: "Check the parser plan before you merge.",
		conflictsWithActivePlan: false,
	});
	expect(queued?.ok).toBe(true);
}

/** The compact brief for the caller's own session, with all three live sections present, held to `cap` bytes. */
async function compactLiveBrief(world: LiveWorld, cap: number): Promise<string> {
	const { substrate, observability } = liveSubstrate(
		{ SUBSTRATE_BRIEF_SESSIONS: "on", SUBSTRATE_PLANNING_STEERING: "on", SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp", SUBSTRATE_BRIEF_PROFILE: "enforce", SUBSTRATE_BRIEF_COMPACT_BYTES: String(cap) },
		world,
	);
	try {
		await queueDirective(substrate, world.own.sessionId);
		const request = { surface: "cursor" as const, repo: LIVE_REPO, graph_id: LIVE_GRAPH, session_id: world.own.sessionId, steering_session_id: world.own.sessionId };
		const detail = await substrate.briefDetailed(request, "compact", "cursor", { caller: world.caller, sessionBinding: world.own.sessionBinding });
		expect(detail.state).toBe("complete");
		expect(detail.profile).toBe("compact");
		return detail.text;
	} finally {
		observability.stop();
	}
}

/**
 * A compact brief under a cap, checked against the uncapped brief's lines. It is within the cap; every line is one the uncapped brief
 * printed (a cut line would not be), apart from the state and omitted lines; each live section is whole (its title with an item, or
 * neither); and every live item names its source and its age.
 */
function expectWholeAndAged(text: string, cap: number, uncapped: ReadonlySet<string>): void {
	expect(utf8Bytes(text)).toBeLessThanOrEqual(cap);
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.startsWith("[brief: ") || line.startsWith("...omitted:")) continue;
		expect(uncapped.has(line)).toBe(true);
	}
	const sessions = lines.filter((line) => line.includes("[steering, hermes]"));
	const handoffs = lines.filter((line) => /^- (verified|UNVERIFIED), /.test(line));
	const pending = lines.filter((line) => /^- \S+ \S+ \(\w+, /.test(line));
	const steering = [...lines.filter((line) => line.startsWith("- session ")), ...pending];
	expect(text.includes(SESSIONS_TITLE)).toBe(sessions.length > 0);
	expect(text.includes(HANDOFFS_TITLE)).toBe(handoffs.length > 0);
	expect(text.includes(STEERING_TITLE)).toBe(steering.length > 0);
	for (const line of [...sessions, ...handoffs, ...pending]) expect(line).toMatch(AGE);
}

describe("the brief's live sections under the compact byte cap", () => {
	test("under a tight compact byte cap, live sections stay within the bound, whole, naming their source and age", async () => {
		const world = await liveWorld();
		const uncapped = await compactLiveBrief(world, 65_536);
		for (const title of [SESSIONS_TITLE, HANDOFFS_TITLE, STEERING_TITLE]) expect(uncapped).toContain(title);
		const everything = new Set(uncapped.split("\n"));

		const tight: string[] = [];
		for (const cap of [512, 640, 800, 1024]) {
			const text = await compactLiveBrief(world, cap);
			expectWholeAndAged(text, cap, everything);
			expect(text.split("\n")[0]).toBe("[brief: complete]");
			tight.push(text);
		}
		// The floor cannot hold the uncapped live sections, so the bound was tested against a brief that had to drop some.
		expect(tight.some((text) => !text.includes(SESSIONS_TITLE) || !text.includes(HANDOFFS_TITLE))).toBe(true);
	});
});

describe("the sessions flag off leaves the brief untouched", () => {
	test("with the sessions flag off, live sessions do not change a byte of the brief", async () => {
		const world = await liveWorld();
		const request = { surface: "cursor" as const, repo: LIVE_REPO, graph_id: LIVE_GRAPH, session_id: world.own.sessionId };
		const off = liveSubstrate({}, world);
		const absent = liveSubstrate({}, world, null);
		const enabled = liveSubstrate({ SUBSTRATE_BRIEF_SESSIONS: "on" }, world);
		try {
			const withSource = await off.substrate.briefDetailed(request);
			const withoutSource = await absent.substrate.briefDetailed(request);
			expect(withSource.state).toBe("complete");
			expect(withSource.text).toBe(withoutSource.text);
			expect(withSource.etag).toBe(withoutSource.etag);
			expect(withSource.text).not.toContain(SESSIONS_TITLE);
			expect(withSource.text).not.toContain("[steering, hermes]");
			expect(withSource.text).not.toContain(HANDOFFS_TITLE);
			// The control: the same world with the flag on shows both sections, so the flag is what hides them.
			const shown = await enabled.substrate.briefDetailed(request);
			expect(shown.text).toContain(SESSIONS_TITLE);
			expect(shown.text).toContain("[steering, hermes]");
			expect(shown.text).toContain(HANDOFFS_TITLE);
		} finally {
			off.observability.stop();
			absent.observability.stop();
			enabled.observability.stop();
		}
	});
});
