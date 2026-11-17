/**
 * The pure parts of `/steering/*` (phase 67): query and body parsing that never echoes a value, who sees which session, the
 * REST directive shape with its `checkpoint_hint`, and the HTTP status of every typed result. The inbox is in memory and the
 * clock a number, so nothing here needs a server.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../config.ts";
import { auditToolCalls, createObservability } from "../observe.ts";
import { Substrate } from "../service.ts";
import { defined } from "../test-support.ts";
import { createTestLiveSessionAuthority, issueLiveSession } from "./live-session.test-support.ts";
import {
	listRestDirectives,
	parseAcknowledgeBody,
	parseDirectivesQuery,
	parseQueueBody,
	parseSessionsQuery,
	parseWaitQuery,
	restDirective,
	STEERING_SESSIONS_LIMIT_DEFAULT,
	STEERING_SESSIONS_LIMIT_MAX,
	steeringHttpStatus,
	steeringRetryAfterS,
	steeringUnavailable,
} from "./steering-rest.ts";
import { SteeringInbox, steeringRecordsFromEntries, type SteeringAuditEntry, type SteeringError, type SteeringHistorySink, type SteeringRecord } from "./steering.ts";
import { acknowledgeSteeringWithState, queueSteering, type LiveSessionAuditPort, type SteeringCaller, type SteeringWriteResult } from "./steering-tools.ts";

const NOW = 1_800_000_000_000;
/** A made-up credential shaped like a GitHub token, so the redactor has something to find. */
const TOKEN = "ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";

class MemorySink implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	async append(entry: SteeringAuditEntry): Promise<void> {
		this.entries.push(entry);
	}
}

const inboxOf = (): SteeringInbox => new SteeringInbox({ history: new MemorySink(), clock: { nowMs: () => NOW }, policy: { allowlist: ["omp"], ratePerMin: 1000 } });

async function queue(inbox: SteeringInbox, id: string, action: "pause" | "redirect" | "annotate", session = "sess-a"): Promise<void> {
	const result = await inbox.enqueue({
		id,
		author: { principalId: "omp", kind: "human" },
		createdAtMs: NOW,
		priority: "normal",
		targetSessionId: session,
		action,
		body: `do ${id}`,
		conflictsWithActivePlan: false,
	});
	expect(result.ok).toBe(true);
}

const OPERATOR: SteeringCaller = { surface: "omp", isOperator: true };
const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
async function live(state: "ACTIVE" | "PAUSED" = "ACTIVE") {
	const env = { SUBSTRATE_PLANNING_STEERING: "on", SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp" };
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start(); stops.push(() => observability.stop());
	const authority = createTestLiveSessionAuthority({ nowMs: NOW });
	const row = await issueLiveSession(authority, { caller: { surface: "cursor", isOperator: false }, state, steering: "PRIVATE-DIRECTION", planningHash: "PRIVATE-PLAN" });
	const audit: LiveSessionAuditPort = { auditCalls: (caller, calls, transport) => auditToolCalls(observability, caller.surface, calls, transport) };
	const substrate = new Substrate(config, { index: null, greptime: null, steering: { history: new MemorySink(), liveSessions: authority, nowMs: () => NOW } }, observability.observer, audit);
	return { authority, row, substrate };
}

const params = (query: string): URLSearchParams => new URLSearchParams(query);

describe("parseSessionsQuery", () => {
	test("defaults, the repo scope and the limit bound", () => {
		expect(parseSessionsQuery(params(""))).toEqual({ ok: true, value: { repoId: null, limit: STEERING_SESSIONS_LIMIT_DEFAULT } });
		expect(parseSessionsQuery(params("repo_id=Owner/Name&limit=5"))).toEqual({ ok: true, value: { repoId: "owner/name", limit: 5 } });
		expect(parseSessionsQuery(params(`limit=${STEERING_SESSIONS_LIMIT_MAX}`)).ok).toBe(true);
	});

	test("a bad limit or repository is refused without echoing the value", () => {
		for (const bad of ["limit=0", `limit=${STEERING_SESSIONS_LIMIT_MAX + 1}`, "limit=-1", "limit=1.5", "limit=1e2", "limit=", "repo_id=not-a-repo-xyz-secret"]) {
			const parsed = parseSessionsQuery(params(bad));
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.error).not.toContain("secret");
		}
	});
});

describe("issued-session metadata discovery", () => {
	test("owner/surface and repository filters apply before the cap, without private fields", async () => {
		const h = await live();
		await issueLiveSession(h.authority, { caller: { surface: "omp", isOperator: false } });
		await issueLiveSession(h.authority, { caller: { surface: "cursor", isOperator: false }, repoId: "other/repo" });
		const caller = { surface: "cursor", isOperator: false } as const;
		const own = await h.substrate.listLiveSessions(caller, { repoId: "owner/name", limit: 1 });
		expect(own).toMatchObject({ sessions: [{ session_id: h.row.sessionId, surface: "cursor" }], truncated: false });
		for (const entry of own.sessions) expect(Object.keys(entry).sort()).toEqual(["expires_at", "repo_id", "session_id", "state", "surface", "updated_at"]);
		const operator = await h.substrate.listLiveSessions(OPERATOR, { repoId: null, limit: 1 });
		expect(operator.sessions).toHaveLength(1); expect(operator.truncated).toBe(true);
		expect(operator.next_cursor).toBe(operator.sessions[0]?.session_id);
		const next = await h.substrate.listLiveSessions(OPERATOR, { repoId: null, limit: 1, cursor: defined(operator.next_cursor, "cursor") });
		expect(next.sessions[0]?.session_id).not.toBe(operator.sessions[0]?.session_id);
		expect(JSON.stringify([own, operator, next])).not.toContain("PRIVATE-");
		expect(JSON.stringify([own, operator, next])).not.toContain(h.row.sessionBinding);
	});
});

describe("restDirective and checkpoint_hint", () => {
	test("a queued directive names no acknowledgement and no hint", async () => {
		const inbox = inboxOf();
		await queue(inbox, "d1", "pause");
		const shaped = restDirective(defined(inbox.get("d1"), "d1"));
		expect(shaped).toMatchObject({ id: "d1", session_id: "sess-a", status: "queued", acknowledged_at: null, outcome: null, checkpoint_hint: null, author: "omp", created_at: new Date(NOW).toISOString() });
	});

	test("only a committed acknowledgement state movement creates REST and list checkpoint hints", async () => {
		for (const [state, action, expected] of [["ACTIVE", "pause", "applied"], ["ACTIVE", "redirect", "applied"], ["PAUSED", "redirect", "refused"], ["PAUSED", "pause", "unchanged"]] as const) {
			const h = await live(state);
			const queued = await queueSteering(h.substrate.steering, OPERATOR, { target_session_id: h.row.sessionId, action, priority: "normal", body: "Check plan.", conflicts_with_active_plan: false });
			if (queued.status !== "queued") throw new Error("test queue refused");
			const reply = await acknowledgeSteeringWithState(h.substrate.steering, OPERATOR, { directive_id: queued.directive_id, outcome: "applied" }, h.substrate.sessionState);
			expect(reply).toMatchObject({ status: "acknowledged", session_state: { status: expected } });
			const inbox = defined(h.substrate.steering.inbox, "inbox");
			const shaped = restDirective(defined(inbox.get(queued.directive_id), "acknowledged record"));
			expect(shaped.checkpoint_hint).toEqual(expected === "applied" ? { trigger: "steering", directive_id: queued.directive_id } : null);
			expect(Object.hasOwn(reply, "checkpoint_hint")).toBe(expected === "applied");
			const record = defined(inbox.get(queued.directive_id), "record");
			if (record.state !== "acknowledged") throw new Error("test acknowledgement missing");
			const entry = { directive: record.directive, queuedAtMs: record.queuedAtMs, acknowledgement: { atMs: record.acknowledgedAtMs, outcome: record.outcome, confirmed: record.confirmed } };
			const reloaded = inboxOf(); await reloaded.restore([entry]);
			expect(listRestDirectives(reloaded, { sessionId: h.row.sessionId, status: "acknowledged" })[0]?.checkpoint_hint).toBeNull();
			expect(listRestDirectives(inboxOf(), { sessionId: h.row.sessionId, status: "all" }, steeringRecordsFromEntries([entry]))[0]?.checkpoint_hint).toBeNull();
		}
	});

	test("an annotate, or any declined outcome, moves no session and carries no hint", async () => {
		const inbox = inboxOf();
		await queue(inbox, "a", "annotate");
		await queue(inbox, "p", "pause");
		expect((await inbox.acknowledge({ directiveId: "a", sessionId: "sess-a", outcome: "applied" })).ok).toBe(true);
		expect((await inbox.acknowledge({ directiveId: "p", sessionId: "sess-a", outcome: "declined" })).ok).toBe(true);
		expect(restDirective(defined(inbox.get("a"), "a")).checkpoint_hint).toBeNull();
		expect(restDirective(defined(inbox.get("p"), "p"))).toMatchObject({ outcome: "declined", checkpoint_hint: null });
	});

	test("listing filters by status", async () => {
		const inbox = inboxOf();
		await queue(inbox, "d1", "annotate");
		await queue(inbox, "d2", "annotate");
		await inbox.acknowledge({ directiveId: "d1", sessionId: "sess-a", outcome: "applied" });
		const ids = (status: "queued" | "acknowledged" | "all") => listRestDirectives(inbox, { sessionId: "sess-a", status }).map((entry) => entry.id);
		expect(ids("queued")).toEqual(["d2"]);
		expect(ids("acknowledged")).toEqual(["d1"]);
		expect(ids("all").sort()).toEqual(["d1", "d2"]);
	});

	test("a directive the inbox no longer holds is listed from the durable history, and the inbox's own copy wins", async () => {
		const inbox = inboxOf();
		await queue(inbox, "live", "annotate");
		const history = steeringRecordsFromEntries([
			{
				directive: { id: "gone", author: { principalId: "omp", kind: "human" }, createdAtMs: NOW - 10, priority: "high", targetSessionId: "sess-a", action: "redirect", body: "Look at the parser.", conflictsWithActivePlan: false },
				queuedAtMs: NOW - 10,
				acknowledgement: { atMs: NOW - 5, outcome: "applied", confirmed: false },
			},
			// The inbox holds this one as queued; its live state is the answer, not the history's older row.
			{
				directive: { id: "live", author: { principalId: "omp", kind: "human" }, createdAtMs: NOW, priority: "normal", targetSessionId: "sess-a", action: "annotate", body: "do live", conflictsWithActivePlan: false },
				queuedAtMs: NOW,
				acknowledgement: { atMs: NOW + 1, outcome: "declined", confirmed: false },
			},
			{
				directive: { id: "other-session", author: { principalId: "omp", kind: "human" }, createdAtMs: NOW, priority: "normal", targetSessionId: "sess-b", action: "pause", body: "x", conflictsWithActivePlan: false },
				queuedAtMs: NOW,
				acknowledgement: { atMs: NOW + 1, outcome: "applied", confirmed: false },
			},
			"not an entry",
		]);
		expect(history.map((record) => record.directive.id)).toEqual(["gone", "live", "other-session"]);
		const acknowledged = listRestDirectives(inbox, { sessionId: "sess-a", status: "acknowledged" }, history);
		// The audit history holds no transition result, so a directive read back from it names no hint, whatever its action and outcome.
		expect(acknowledged).toMatchObject([{ id: "gone", status: "acknowledged", outcome: "applied", checkpoint_hint: null }]);
		const all = listRestDirectives(inbox, { sessionId: "sess-a", status: "all" }, history);
		expect(all.map((entry) => [entry.id, entry.status])).toEqual([
			["gone", "acknowledged"],
			["live", "queued"],
		]);
	});

	test("an agent-authored history row is not listed", () => {
		const history = steeringRecordsFromEntries([
			{
				directive: { id: "bot", author: { principalId: "omp", kind: "agent" }, createdAtMs: NOW, priority: "normal", targetSessionId: "sess-a", action: "pause", body: "x", conflictsWithActivePlan: false },
				queuedAtMs: NOW,
				acknowledgement: { atMs: NOW + 1, outcome: "applied", confirmed: false },
			},
		]);
		expect(history).toEqual([]);
	});

	test("a credential in a directive body does not leave the route", async () => {
		const inbox = inboxOf();
		await queue(inbox, "d1", "annotate");
		const record = defined(inbox.get("d1"), "d1");
		const leaky: SteeringRecord = { ...record, directive: { ...record.directive, body: `use ${TOKEN} for the push` } };
		const shaped = restDirective(leaky);
		expect(shaped.body).not.toContain(TOKEN);
		expect(shaped.body).toContain("[REDACTED]");
	});
});

describe("query parsing", () => {
	test("directives need a session id and a known status", () => {
		expect(parseDirectivesQuery(params("session_id=sess-a"))).toEqual({ ok: true, value: { sessionId: "sess-a", status: "all" } });
		expect(parseDirectivesQuery(params("session_id=sess-a&status=queued"))).toEqual({ ok: true, value: { sessionId: "sess-a", status: "queued" } });
		expect(parseDirectivesQuery(params("")).ok).toBe(false);
		expect(parseDirectivesQuery(params("session_id=has space")).ok).toBe(false);
		expect(parseDirectivesQuery(params("session_id=sess-a&status=done")).ok).toBe(false);
	});

	test("wait defaults to the server maximum, validates `after` and refuses a timeout that is not a whole number of at least 1", () => {
		expect(parseWaitQuery(params("session_id=sess-a"), 30_000)).toEqual({ ok: true, value: { sessionId: "sess-a", after: null, timeoutMs: 30_000 } });
		expect(parseWaitQuery(params("session_id=sess-a&after=d1&timeout_ms=500"), 30_000)).toEqual({ ok: true, value: { sessionId: "sess-a", after: "d1", timeoutMs: 500 } });
		for (const bad of ["timeout_ms=0", "timeout_ms=abc", "timeout_ms=-5", "timeout_ms=1.5", "timeout_ms=", "after=bad%20id"]) expect(parseWaitQuery(params(`session_id=sess-a&${bad}`), 30_000).ok).toBe(false);
		expect(parseWaitQuery(params("timeout_ms=5"), 30_000).ok).toBe(false);
	});

	test("a wait above the ceiling is clamped to it, not refused", () => {
		for (const asked of ["30001", "120000", "999999999999999"]) {
			expect(parseWaitQuery(params(`session_id=sess-a&timeout_ms=${asked}`), 30_000)).toEqual({ ok: true, value: { sessionId: "sess-a", after: null, timeoutMs: 30_000 } });
		}
		expect(parseWaitQuery(params("session_id=sess-a&timeout_ms=30000"), 30_000)).toMatchObject({ ok: true, value: { timeoutMs: 30_000 } });
	});
});

describe("body parsing", () => {
	test("a queue body maps to the tool input, defaults the priority and takes the plan conflict flag, false when absent", () => {
		const parsed = parseQueueBody({ session_id: "sess-a", action: "pause", body: "hold" });
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.value).toMatchObject({ target_session_id: "sess-a", action: "pause", priority: "normal", body: "hold", conflicts_with_active_plan: false });
	});

	test("conflicts_with_active_plan is carried when true and refused, by name, when it is not a boolean", () => {
		const conflicting = parseQueueBody({ session_id: "sess-a", action: "redirect", body: "switch", conflicts_with_active_plan: true });
		expect(conflicting.ok).toBe(true);
		if (conflicting.ok) expect(conflicting.value.conflicts_with_active_plan).toBe(true);
		for (const bad of ["true", 1, null, {}]) {
			expect(parseQueueBody({ session_id: "sess-a", action: "redirect", body: "switch", conflicts_with_active_plan: bad })).toEqual({ ok: false, error: "invalid conflicts_with_active_plan" });
		}
	});

	test("an author field, an unknown field, a non-object and an invalid value are refused, naming fields and never values", () => {
		expect(parseQueueBody({ session_id: "sess-a", action: "pause", body: "hold", author: "attacker" })).toEqual({ ok: false, error: "unknown field: author" });
		expect(parseQueueBody([]).ok).toBe(false);
		expect(parseQueueBody("text").ok).toBe(false);
		const invalid = parseQueueBody({ session_id: "sess-a", action: "nuke-secret-value", body: "hold" });
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) {
			expect(invalid.error).toContain("action");
			expect(invalid.error).not.toContain("nuke-secret-value");
		}
		const badSession = parseQueueBody({ session_id: "bad id", action: "pause", body: "hold" });
		expect(badSession.ok).toBe(false);
		if (!badSession.ok) expect(badSession.error).toContain("session_id");
	});

	test("acknowledgement parsing remains pure and accepts the old directive-only unkeyed shape", () => {
		expect(parseAcknowledgeBody({ directive_id: "d1", outcome: "applied", confirm: true })).toEqual({ ok: true, value: { directive_id: "d1", outcome: "applied", confirm: true } });
		expect(parseAcknowledgeBody({ directive_id: "ghost", outcome: "declined" }).ok).toBe(true);
		expect(parseAcknowledgeBody({ directive_id: "d1", outcome: "applied", session_id: "other" }).ok).toBe(false);
		expect(parseAcknowledgeBody({ directive_id: "bad id", outcome: "applied" }).ok).toBe(false);
		expect(parseAcknowledgeBody({ directive_id: "d1", outcome: "maybe" }).ok).toBe(false);
	});
});

describe("statuses", () => {
	const refused = (error: SteeringError): SteeringWriteResult => ({ status: "refused", error });

	test("each typed result has its own HTTP class", () => {
		const cases: Array<[SteeringWriteResult, number]> = [
			[{ status: "forbidden", reason: "operator-required" }, 403],
			[{ status: "misconfigured", errors: [] }, 503],
			[{ status: "not-configured" }, 503],
			[refused({ code: "agent-author-refused" }), 403],
			[refused({ code: "principal-not-allowed" }), 403],
			[refused({ code: "not-found" }), 404],
			[refused({ code: "duplicate-directive" }), 409],
			[refused({ code: "wrong-session" }), 409],
			[refused({ code: "already-acknowledged" }), 409],
			[refused({ code: "confirmation-required" }), 409],
			[refused({ code: "rate-limited", retryAfterMs: 1_500 }), 429],
			[refused({ code: "audit-unavailable", attempts: 2, lastErrorCode: "X" }), 503],
			[refused({ code: "invalid-directive", issues: [] }), 400],
			[refused({ code: "invalid-acknowledgement", issues: [] }), 400],
			[{ status: "queued", directive_id: "d", target_session_id: "s", queued_at_ms: NOW }, 200],
			[{ status: "acknowledged", directive_id: "d", outcome: "applied", confirmed: false }, 200],
		];
		for (const [result, status] of cases) expect(steeringHttpStatus(result)).toBe(status);
	});

	test("Retry-After is whole seconds, at least one, and only for a rate limit", () => {
		expect(steeringRetryAfterS(refused({ code: "rate-limited", retryAfterMs: 1_500 }))).toBe(2);
		expect(steeringRetryAfterS(refused({ code: "rate-limited", retryAfterMs: 1 }))).toBe(1);
		expect(steeringRetryAfterS(refused({ code: "not-found" }))).toBeNull();
	});

	test("steeringUnavailable distinguishes invalid settings from a missing inbox", async () => {
		const h = await live();
		const wiring = h.substrate.steering;
		expect(steeringUnavailable({ ...wiring, inbox: null, settingsErrors: [{ key: "SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN", reason: "not-integer" }] })).toMatchObject({ status: "misconfigured", keys: ["SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN"] });
		expect(steeringUnavailable({ ...wiring, inbox: null })).toMatchObject({ status: "not-configured" });
		expect(steeringUnavailable(wiring)).toBeNull();
	});
});
