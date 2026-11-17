/** Pure notice/sweeper coverage and real authority-backed acknowledgement effects. Authored; parent executes. */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { EventInput } from "../types.ts";
import { loadConfig } from "../config.ts";
import { auditToolCalls, createObservability } from "../observe.ts";
import { Substrate } from "../service.ts";
import { createTestLiveSessionAuthority, issueLiveSession } from "./live-session.test-support.ts";
import { LiveSessionStatePort } from "./session-state.ts";
import type { PlanningTimers } from "./observer.ts";
import { SteeringInbox, type SteeringAuditEntry, type SteeringDirective, type SteeringHistorySink } from "./steering.ts";
import {
	ANNOUNCED_MAX,
	SESSION_STATE_NAMES,
	STEERING_NOTICE_BODY_MAX,
	STEERING_NOTICE_MAX_ENTRIES,
	STEERING_QUEUED_ACTION,
	SteeringExpirySweeper,
	SteeringHintAnnouncer,
	sessionStateForAcknowledgement,
	steeringNoticeFor,
	steeringQueuedEvent,
	type SessionStateName,
} from "./steering-delivery.ts";
import { acknowledgeSteeringWithState, queueSteering, type LiveSessionAuditPort, type SteeringCaller } from "./steering-tools.ts";

const NOW = 1_800_000_000_000;
const OPERATOR: SteeringCaller = { surface: "omp", isOperator: true };
const TOKEN = "ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";

class MemorySink implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	failing = false;
	/** When set, an append waits for it: lets a test hold a pass open. */
	gate: Promise<void> | null = null;

	async append(entry: SteeringAuditEntry): Promise<void> {
		if (this.gate !== null) await this.gate;
		if (this.failing) throw new Error("sink unavailable");
		this.entries.push(entry);
	}
}


function clockAt(start: number): { nowMs(): number; set(ms: number): void } {
	let now = start;
	return {
		nowMs: () => now,
		set: (ms) => {
			now = ms;
		},
	};
}

function directive(overrides: Partial<SteeringDirective> = {}): SteeringDirective {
	return {
		id: "dir-1",
		author: { principalId: "omp", kind: "human" },
		createdAtMs: NOW,
		priority: "normal",
		targetSessionId: "sess-a",
		action: "redirect",
		body: "Stop the migration and review the schema first.",
		conflictsWithActivePlan: false,
		...overrides,
	};
}

function inboxOver(history: SteeringHistorySink, clock: { nowMs(): number }, ackTtlMs?: number): SteeringInbox {
	return new SteeringInbox({
		history,
		clock,
		policy: { allowlist: ["omp"], ratePerMin: 1_000, ...(ackTtlMs === undefined ? {} : { ackTtlMs }) },
	});
}


describe("sessionStateForAcknowledgement", () => {
	const table: Array<[string, Parameters<typeof sessionStateForAcknowledgement>[0], SessionStateName | null]> = [
		["pause applied", { action: "pause", outcome: "applied" }, "PAUSED"],
		["redirect applied", { action: "redirect", outcome: "applied" }, "CONTEXT_REFRESH"],
		["annotate applied", { action: "annotate", outcome: "applied" }, null],
		["pause declined", { action: "pause", outcome: "declined" }, null],
		["redirect declined", { action: "redirect", outcome: "declined" }, null],
		["annotate declined", { action: "annotate", outcome: "declined" }, null],
		["pause declined by timeout", { action: "pause", outcome: "declined", reason: "timeout" }, null],
		["redirect declined by timeout", { action: "redirect", outcome: "declined", reason: "timeout" }, null],
	];

	for (const [name, ack, expected] of table) {
		test(`${name} maps to ${expected ?? "no change"}`, () => {
			expect(sessionStateForAcknowledgement(ack)).toBe(expected);
		});
	}

	test("it never asks for ACTIVE or RESUMED: those come from the session machine's own rules", () => {
		for (const action of ["pause", "redirect", "annotate"] as const) {
			for (const outcome of ["applied", "declined"] as const) {
				expect(["ACTIVE", "RESUMED"]).not.toContain(sessionStateForAcknowledgement({ action, outcome }) ?? "none");
			}
		}
		expect(SESSION_STATE_NAMES).toEqual(["ACTIVE", "CONTEXT_REFRESH", "PAUSED", "RESUMED"]);
	});
});

describe("steeringNoticeFor", () => {
	test("is null while nothing is queued for the session", async () => {
		const clock = clockAt(NOW);
		const inbox = inboxOver(new MemorySink(), clock);
		expect(steeringNoticeFor(inbox, "sess-a", NOW)).toBeNull();
		await inbox.enqueue(directive({ targetSessionId: "sess-b" }));
		expect(steeringNoticeFor(inbox, "sess-a", NOW)).toBeNull();
	});

	test("counts every queued directive, lists the first three by priority then age, and measures age from the queue time", async () => {
		const clock = clockAt(NOW);
		const inbox = inboxOver(new MemorySink(), clock);
		await inbox.enqueue(directive({ id: "dir-low", priority: "low", createdAtMs: NOW }));
		clock.set(NOW + 1_000);
		await inbox.enqueue(directive({ id: "dir-normal-1", priority: "normal", createdAtMs: NOW + 1_000 }));
		clock.set(NOW + 2_000);
		await inbox.enqueue(directive({ id: "dir-normal-2", priority: "normal", createdAtMs: NOW + 2_000 }));
		await inbox.enqueue(directive({ id: "dir-high", priority: "high", action: "pause", createdAtMs: NOW + 2_000 }));
		await inbox.enqueue(directive({ id: "dir-annotate", priority: "low", action: "annotate", createdAtMs: NOW + 2_000 }));

		const notice = steeringNoticeFor(inbox, "sess-a", NOW + 10_000);
		expect(notice?.count).toBe(5);
		expect(notice?.entries).toHaveLength(STEERING_NOTICE_MAX_ENTRIES);
		expect(notice?.entries.map((entry) => entry.id)).toEqual(["dir-high", "dir-normal-1", "dir-normal-2"]);
		expect(notice?.entries[0]).toEqual({
			id: "dir-high",
			action: "pause",
			priority: "high",
			age_ms: 8_000,
			body: "Stop the migration and review the schema first.",
		});
		expect(notice?.entries[1]?.age_ms).toBe(9_000);
		expect(notice?.untrusted.length).toBeGreaterThan(0);
	});

	test("an acknowledged directive is no longer offered", async () => {
		const clock = clockAt(NOW);
		const inbox = inboxOver(new MemorySink(), clock);
		await inbox.enqueue(directive({ id: "dir-1" }));
		await inbox.enqueue(directive({ id: "dir-2" }));
		await inbox.acknowledge({ directiveId: "dir-1", sessionId: "sess-a", outcome: "declined" });

		const notice = steeringNoticeFor(inbox, "sess-a", NOW);
		expect(notice?.count).toBe(1);
		expect(notice?.entries.map((entry) => entry.id)).toEqual(["dir-2"]);
	});

	test("the body is redacted and cut to the cap, and an age is never negative", async () => {
		const clock = clockAt(NOW);
		const inbox = inboxOver(new MemorySink(), clock);
		const long = `use ${TOKEN} then ${"word ".repeat(100)}`;
		await inbox.enqueue(directive({ body: long }));

		const notice = steeringNoticeFor(inbox, "sess-a", NOW - 5_000);
		const entry = notice?.entries[0];
		expect(entry?.body.length).toBeLessThanOrEqual(STEERING_NOTICE_BODY_MAX);
		expect(entry?.body).not.toContain(TOKEN);
		expect(entry?.age_ms).toBe(0);
	});

	test("reading the notice changes nothing in the inbox", async () => {
		const sink = new MemorySink();
		const inbox = inboxOver(sink, clockAt(NOW));
		await inbox.enqueue(directive());
		const before = sink.entries.length;
		steeringNoticeFor(inbox, "sess-a", NOW);
		steeringNoticeFor(inbox, "sess-a", NOW);
		expect(sink.entries).toHaveLength(before);
		expect(inbox.get("dir-1")?.state).toBe("queued");
	});
});

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

describe("acknowledgeSteeringWithState", () => {
	async function queued(action: "pause" | "redirect" | "annotate", state: SessionStateName = "ACTIVE", conflicts = false) {
		const env = { SUBSTRATE_PLANNING_STEERING: "on", SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp" };
		const config = loadConfig(env);
		const observability = createObservability(config, env);
		await observability.start();
		stops.push(() => observability.stop());
		const authority = createTestLiveSessionAuthority({ nowMs: NOW });
		const row = await issueLiveSession(authority, { caller: { surface: "cursor", isOperator: false }, state });
		const sink = new MemorySink();
		const events: EventInput[] = [];
		const port = new LiveSessionStatePort({ authority, emit: async event => { events.push(event); } });
		const audit: LiveSessionAuditPort = { auditCalls: (caller, calls, transport) => auditToolCalls(observability, caller.surface, calls, transport) };
		const substrate = new Substrate(config, { index: null, greptime: null, steering: { history: sink, liveSessions: authority, sessionState: port, nowMs: () => NOW } }, observability.observer, audit);
		const wiring = substrate.steering;
		const result = await queueSteering(wiring, OPERATOR, { target_session_id: row.sessionId, action, priority: "normal", body: "Check the plan.", conflicts_with_active_plan: conflicts });
		if (result.status !== "queued") throw new Error("test queue refused");
		const input = { directive_id: result.directive_id, session_id: row.sessionId, outcome: "applied" as const };
		return { authority, row, sink, events, port, wiring, input, id: result.directive_id, inbox: substrate.steering.inbox };
	}

	for (const [action, target] of [["pause", "PAUSED"], ["redirect", "CONTEXT_REFRESH"]] as const) test(`applied ${action} commits state and provides an honest checkpoint hint`, async () => {
		const h = await queued(action);
		expect(await acknowledgeSteeringWithState(h.wiring, OPERATOR, h.input, h.port)).toMatchObject({ status: "acknowledged", session_state: { status: "applied", state: target }, checkpoint_hint: { trigger: "steering", directive_id: h.id } });
		expect(await h.authority.read(h.row.access, "private-read")).toMatchObject({ ok: true, snapshot: { session: { state: target } } });
		expect(h.events).toHaveLength(1);
		expect(h.inbox?.get(h.id)).toMatchObject({ state: "acknowledged", sessionMoved: true });
	});

	for (const [action, state] of [["pause", "PAUSED"], ["redirect", "CONTEXT_REFRESH"]] as const) test(`${action} already held is unchanged without a hint`, async () => {
		const h = await queued(action, state);
		const reply = await acknowledgeSteeringWithState(h.wiring, OPERATOR, h.input, h.port);
		expect(reply).toMatchObject({ status: "acknowledged", session_state: { status: "unchanged" } });
		expect(Object.hasOwn(reply, "checkpoint_hint")).toBe(false);
		expect(h.events).toEqual([]);
	});

	test("illegal transition preserves acknowledgement but never fabricates a state movement", async () => {
		const h = await queued("redirect", "PAUSED");
		const reply = await acknowledgeSteeringWithState(h.wiring, OPERATOR, h.input, h.port);
		expect(reply).toMatchObject({ status: "acknowledged", session_state: { status: "refused", state: "CONTEXT_REFRESH", reason: "invalid-transition" } });
		expect(Object.hasOwn(reply, "checkpoint_hint")).toBe(false);
		expect(h.inbox?.get(h.id)?.state).toBe("acknowledged");
		expect(await h.authority.read(h.row.access, "private-read")).toMatchObject({ ok: true, snapshot: { session: { state: "PAUSED" } } });
	});

	test("annotate and every declined outcome never call the state port", async () => {
		for (const [action, outcome] of [["annotate", "applied"], ["pause", "declined"], ["redirect", "declined"], ["annotate", "declined"]] as const) {
			const h = await queued(action);
			const transition = spyOn(h.port, "applyTransition");
			const reply = await acknowledgeSteeringWithState(h.wiring, OPERATOR, { ...h.input, outcome }, h.port);
			expect(reply).toMatchObject({ status: "acknowledged", session_state: { status: "unchanged" } });
			expect(transition).not.toHaveBeenCalled();
			expect(Object.hasOwn(reply, "checkpoint_hint")).toBe(false);
		}
	});

	test("a refused acknowledgement cannot reach the transition port", async () => {
		const h = await queued("pause", "ACTIVE", true);
		const transition = spyOn(h.port, "applyTransition");
		expect(await acknowledgeSteeringWithState(h.wiring, OPERATOR, h.input, h.port)).toEqual({ status: "refused", error: { code: "confirmation-required" } });
		expect(await acknowledgeSteeringWithState(h.wiring, OPERATOR, { ...h.input, session_id: `ls_${"f".repeat(64)}`, confirm: true }, h.port)).toEqual({ status: "refused", error: { code: "not-found" } });
		expect(transition).not.toHaveBeenCalled();
		expect(h.inbox?.get(h.id)?.state).toBe("queued");
	});

	test("no state port returns exactly the audited plain acknowledgement", async () => {
		const h = await queued("pause");
		expect(await acknowledgeSteeringWithState(h.wiring, OPERATOR, h.input, null)).toEqual({ status: "acknowledged", directive_id: h.id, outcome: "applied", confirmed: false });
		expect(await h.authority.read(h.row.access, "private-read")).toMatchObject({ ok: true, snapshot: { session: { state: "ACTIVE" } } });
	});

	test("close winning during durable acknowledgement preserves the ack and suppresses state and hint", async () => {
		const h = await queued("pause");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const append = h.sink.append.bind(h.sink);
		spyOn(h.sink, "append").mockImplementation(async entry => { entered.resolve(); await release.promise; await append(entry); });
		const pending = acknowledgeSteeringWithState(h.wiring, OPERATOR, h.input, h.port);
		await entered.promise;
		await h.authority.close(h.row.access);
		release.resolve();
		const reply = await pending;
		expect(reply).toMatchObject({ status: "acknowledged", session_state: { status: "refused" } });
		expect(Object.hasOwn(reply, "checkpoint_hint")).toBe(false);
		expect(h.inbox?.get(h.id)?.state).toBe("acknowledged");
		expect(h.events).toEqual([]);
	});

	for (const failure of ["close", "outage"] as const) test(`${failure} after state commit preserves applied receipt but suppresses checkpoint hint`, async () => {
		const h = await queued("pause");
		const moved: string[] = [];
		const transition = h.authority.transition.bind(h.authority);
		const effect = spyOn(h.authority, "transition").mockImplementation(async (access, input, operation) => {
			const result = await transition(access, input, operation);
			if (result.ok) {
				moved.push(result.snapshot.session.state);
				if (failure === "close") await h.authority.close(h.row.access);
				else h.authority.unavailable = true;
			}
			return result;
		});
		const reply = await acknowledgeSteeringWithState(h.wiring, OPERATOR, h.input, h.port);
		expect(effect).toHaveBeenCalledTimes(1);
		expect(moved).toEqual(["PAUSED"]);
		expect(reply).toMatchObject({ status: "acknowledged", session_state: { status: "applied", state: "PAUSED" } });
		expect(Object.hasOwn(reply, "checkpoint_hint")).toBe(false);
		expect(h.inbox?.get(h.id)).toMatchObject({ state: "acknowledged", sessionMoved: true });
		expect(h.sink.entries.filter(entry => entry.event === "acknowledged")).toHaveLength(1);
		expect(await h.authority.read(h.row.access, "private-read")).toEqual({ ok: false, error: { code: failure === "close" ? "not-found" : "session-unavailable" } });
	});

	test("a throwing state port sanitizes diagnostics without undoing acknowledgement", async () => {
		const h = await queued("pause");
		spyOn(h.port, "applyTransition").mockImplementation(() => { throw new Error("PRIVATE-DRIVER-DIAGNOSTIC"); });
		const reply = await acknowledgeSteeringWithState(h.wiring, OPERATOR, h.input, h.port);
		expect(reply).toMatchObject({ status: "acknowledged", session_state: { status: "refused", reason: "session-unavailable" } });
		expect(JSON.stringify(reply)).not.toContain("PRIVATE-DRIVER");
		expect(Object.hasOwn(reply, "checkpoint_hint")).toBe(false);
		expect(h.inbox?.get(h.id)?.state).toBe("acknowledged");
	});
});

describe("steeringQueuedEvent and SteeringHintAnnouncer", () => {
	test("the event is a note on the substrate surface that names the directive and carries no body", () => {
		const event = steeringQueuedEvent(directive({ body: `ride ${TOKEN}` }));
		expect(event).toMatchObject({
			surface: "substrate",
			kind: "note",
			session_id: "sess-a",
			payload: { action: STEERING_QUEUED_ACTION, directive_id: "dir-1", session_id: "sess-a", non_blocking: true },
		});
		expect(Object.keys(event.payload ?? {}).sort()).toEqual(["action", "directive_id", "non_blocking", "session_id"]);
		expect(JSON.stringify(event)).not.toContain(TOKEN);
		expect(JSON.stringify(event)).not.toContain("Stop the migration");
	});

	test("one hint per directive id, however many times it is announced, and a second directive gets its own", async () => {
		const events: EventInput[] = [];
		const announcer = new SteeringHintAnnouncer({
			emit: async (event) => {
				events.push(event);
				return true;
			},
		});
		expect(await announcer.announce(directive())).toBe("announced");
		expect(await announcer.announce(directive())).toBe("duplicate");
		expect(await announcer.announce(directive({ id: "dir-2" }))).toBe("announced");
		expect(events.map((event) => event.payload?.["directive_id"])).toEqual(["dir-1", "dir-2"]);
	});

	test("two concurrent announcements of one directive send one hint", async () => {
		let sent = 0;
		const announcer = new SteeringHintAnnouncer({
			emit: async () => {
				await Promise.resolve();
				sent += 1;
				return true;
			},
		});
		const outcomes = await Promise.all([announcer.announce(directive()), announcer.announce(directive())]);
		expect(outcomes.sort()).toEqual(["announced", "duplicate"]);
		expect(sent).toBe(1);
	});

	test("a hint the ledger did not store, or that threw, is not counted as sent and may be retried", async () => {
		const lines: string[] = [];
		let mode: "refuse" | "throw" | "store" = "refuse";
		const announcer = new SteeringHintAnnouncer({
			emit: async () => {
				if (mode === "throw") throw new Error(`ledger down with ${TOKEN}`);
				return mode === "store";
			},
			report: (line) => lines.push(line),
		});
		expect(await announcer.announce(directive())).toBe("not-stored");
		mode = "throw";
		expect(await announcer.announce(directive())).toBe("failed");
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain(TOKEN);
		mode = "store";
		expect(await announcer.announce(directive())).toBe("announced");
	});

	test("memory is bounded: the oldest id is forgotten past the cap", async () => {
		const announcer = new SteeringHintAnnouncer({ emit: async () => true });
		await announcer.announce(directive({ id: "first" }));
		for (let n = 0; n < ANNOUNCED_MAX; n += 1) await announcer.announce(directive({ id: `id-${n}` }));
		expect(await announcer.announce(directive({ id: "first" }))).toBe("announced");
		expect(await announcer.announce(directive({ id: `id-${ANNOUNCED_MAX - 1}` }))).toBe("duplicate");
	});
});

class FakeTimers implements PlanningTimers {
	runs: Array<() => Promise<unknown>> = [];
	intervals: number[] = [];
	cleared = 0;

	setInterval(run: () => Promise<unknown>, ms: number): number {
		this.runs.push(run);
		this.intervals.push(ms);
		return this.runs.length;
	}

	clearInterval(): void {
		this.cleared += 1;
	}
}

describe("SteeringExpirySweeper", () => {
	const TTL_MS = 60_000;

	async function sweeperOver(options: { sink?: MemorySink; report?: (line: string) => void } = {}) {
		const clock = clockAt(NOW);
		const sink = options.sink ?? new MemorySink();
		const inbox = inboxOver(sink, clock, TTL_MS);
		const timers = new FakeTimers();
		const lines: string[] = [];
		const sweeper = new SteeringExpirySweeper({ inbox, intervalMs: 5_000, nowMs: clock.nowMs, timers, report: options.report ?? ((line) => lines.push(line)) });
		return { clock, sink, inbox, timers, sweeper, lines };
	}

	test("rejects an interval that is not a positive integer", () => {
		const inbox = inboxOver(new MemorySink(), clockAt(NOW), TTL_MS);
		for (const intervalMs of [0, -1, 1.5, Number.NaN]) {
			expect(() => new SteeringExpirySweeper({ inbox, intervalMs })).toThrow(RangeError);
		}
	});

	test("starts one timer at the configured interval, and a second start does nothing", async () => {
		const { sweeper, timers } = await sweeperOver();
		expect(sweeper.start()).toBe(true);
		expect(sweeper.start()).toBe(false);
		expect(timers.intervals).toEqual([5_000]);
	});

	test("a pass closes a directive past its deadline as declined:timeout, audited before it leaves the queue", async () => {
		const { clock, sink, inbox, sweeper, lines } = await sweeperOver();
		await inbox.enqueue(directive());
		clock.set(NOW + TTL_MS - 1);
		expect((await sweeper.pass())?.expired).toEqual([]);
		expect(inbox.get("dir-1")?.state).toBe("queued");

		clock.set(NOW + TTL_MS);
		expect((await sweeper.pass())?.expired).toEqual(["dir-1"]);
		expect(inbox.get("dir-1")).toMatchObject({ state: "acknowledged", outcome: "declined", reason: "timeout" });
		expect(sink.entries.at(-1)).toMatchObject({ event: "acknowledged", directiveId: "dir-1", outcome: "declined", reason: "timeout" });
		expect(lines).toEqual(["[substrate] steering expiry: 1 expired as declined:timeout"]);
		expect(steeringNoticeFor(inbox, "sess-a", clock.nowMs())).toBeNull();
	});

	test("a tick that arrives during a pass shares it: one pass at a time, one audit row", async () => {
		const sink = new MemorySink();
		const { clock, inbox, sweeper } = await sweeperOver({ sink });
		await inbox.enqueue(directive());
		clock.set(NOW + TTL_MS);
		const release = Promise.withResolvers<void>();
		sink.gate = release.promise;
		const first = sweeper.pass();
		const second = sweeper.pass();
		expect(second).toBe(first);
		release.resolve();
		expect((await first)?.expired).toEqual(["dir-1"]);
		expect(sink.entries.filter((entry) => entry.event === "acknowledged")).toHaveLength(1);
	});

	test("stop clears the timer and no pass starts after it: the due directive stays queued and nothing is audited", async () => {
		const { clock, sink, inbox, sweeper, timers } = await sweeperOver();
		await inbox.enqueue(directive());
		sweeper.start();
		const tick = timers.runs[0];
		clock.set(NOW + TTL_MS * 10);
		const audited = sink.entries.length;
		sweeper.stop();
		expect(timers.cleared).toBe(1);
		expect(await tick?.()).toBeNull();
		expect(await sweeper.pass()).toBeNull();
		expect(sink.entries).toHaveLength(audited);
		expect(inbox.get("dir-1")?.state).toBe("queued");
		expect(sweeper.start()).toBe(false);
	});

	test("idle waits for a pass in flight and then resolves", async () => {
		const sink = new MemorySink();
		const { clock, inbox, sweeper } = await sweeperOver({ sink });
		await inbox.enqueue(directive());
		clock.set(NOW + TTL_MS);
		const release = Promise.withResolvers<void>();
		sink.gate = release.promise;
		void sweeper.pass();
		let idle = false;
		const waiting = sweeper.idle().then(() => {
			idle = true;
		});
		await Promise.resolve();
		expect(idle).toBe(false);
		release.resolve();
		await waiting;
		expect(idle).toBe(true);
		expect(inbox.get("dir-1")?.state).toBe("acknowledged");
	});

	test("an audit outage leaves the directive queued, is reported once however many passes see it, and recovers on the next pass", async () => {
		const sink = new MemorySink();
		const { clock, inbox, sweeper, lines } = await sweeperOver({ sink });
		await inbox.enqueue(directive());
		clock.set(NOW + TTL_MS);
		sink.failing = true;
		const first = await sweeper.pass();
		await sweeper.pass();
		expect(first?.failed).toHaveLength(1);
		expect(inbox.get("dir-1")?.state).toBe("queued");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("could not be closed");

		sink.failing = false;
		expect((await sweeper.pass())?.expired).toEqual(["dir-1"]);
		expect(inbox.get("dir-1")?.state).toBe("acknowledged");
	});

	test("a pass never rejects: a clock the inbox refuses is reported", async () => {
		const clock = clockAt(-1);
		const inbox = inboxOver(new MemorySink(), clock, TTL_MS);
		const lines: string[] = [];
		const sweeper = new SteeringExpirySweeper({ inbox, intervalMs: 1_000, nowMs: clock.nowMs, timers: new FakeTimers(), report: (line) => lines.push(line) });
		expect(await sweeper.pass()).toBeNull();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("steering expiry pass failed");
	});
});
