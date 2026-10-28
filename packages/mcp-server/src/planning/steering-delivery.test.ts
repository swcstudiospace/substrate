/**
 * Steering delivery (phase 58): the `steering` notice a session reads, the acknowledgement-to-state mapping, the one hint per
 * queued directive, and the expiry timer. Everything runs on an injected clock, injected timers and in-memory sinks: no network,
 * no real delay. The session state machine here is a stub (see `StubSessionMachine`); the real adapter, `SteeringSessionRegistry`, is tested in `session-state.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { EventInput } from "../types.ts";
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
	acknowledgeSteeringWithState,
	sessionStateForAcknowledgement,
	steeringNoticeFor,
	steeringQueuedEvent,
	type SessionStateName,
	type SessionStatePort,
	type SessionTransitionContext,
	type SessionTransitionResult,
} from "./steering-delivery.ts";
import { queueSteering, type SteeringCaller, type SteeringWiring } from "./steering-tools.ts";

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

/**
 * A stub of the live steering session state machine, for the seam. It MIRRORS main's `steeringStateTransition` (event.ts, SPE-19390: states
 * ACTIVE, CONTEXT_REFRESH, PAUSED, RESUMED; ACTIVE to CONTEXT_REFRESH or PAUSED, CONTEXT_REFRESH to ACTIVE or PAUSED, PAUSED to
 * RESUMED, RESUMED to ACTIVE or PAUSED, a state to itself). The production port is the registry over `nextSteeringSession`
 * (`session-state.ts`). It refuses what the rules refuse and never forces a transition.
 */
class StubSessionMachine implements SessionStatePort {
	readonly states = new Map<string, SessionStateName>();
	readonly calls: Array<[string, SessionStateName]> = [];
	readonly directiveIds: string[] = [];
	throws = false;

	applyTransition(sessionKey: string, target: SessionStateName, context?: SessionTransitionContext): SessionTransitionResult {
		this.calls.push([sessionKey, target]);
		if (context !== undefined) this.directiveIds.push(context.directiveId);
		if (this.throws) throw new Error("state store unavailable");
		const current = this.states.get(sessionKey) ?? "ACTIVE";
		if (!StubSessionMachine.allowed(current, target)) return { ok: false, reason: `steering transition ${current} -> ${target} refused` };
		this.states.set(sessionKey, target);
		return { ok: true, changed: current !== target };
	}

	private static allowed(current: SessionStateName, next: SessionStateName): boolean {
		if (current === next) return true;
		switch (current) {
			case "ACTIVE":
				return next === "CONTEXT_REFRESH" || next === "PAUSED";
			case "CONTEXT_REFRESH":
				return next === "ACTIVE" || next === "PAUSED";
			case "PAUSED":
				return next === "RESUMED";
			case "RESUMED":
				return next === "ACTIVE" || next === "PAUSED";
		}
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

function wiringOver(inbox: SteeringInbox, clock: { nowMs(): number }): SteeringWiring {
	let next = 0;
	return { enabled: true, clock, settingsErrors: [], inbox, newDirectiveId: () => `dir-${++next}` };
}

const QUEUE = { target_session_id: "sess-a", priority: "normal", conflicts_with_active_plan: false, body: "Check the plan." } as const;

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

describe("acknowledgeSteeringWithState", () => {
	async function queued(action: "pause" | "redirect" | "annotate", machine: StubSessionMachine | null, conflicts = false) {
		const clock = clockAt(NOW);
		const inbox = inboxOver(new MemorySink(), clock);
		const wiring = wiringOver(inbox, clock);
		const result = await queueSteering(wiring, OPERATOR, { ...QUEUE, action, conflicts_with_active_plan: conflicts });
		if (result.status !== "queued") throw new Error(`expected queued, got ${result.status}`);
		return { inbox, wiring, machine, id: result.directive_id };
	}

	test("an applied pause moves the session to PAUSED", async () => {
		const machine = new StubSessionMachine();
		const { wiring, id } = await queued("pause", machine);
		const reply = await acknowledgeSteeringWithState(wiring, OPERATOR, { directive_id: id, session_id: "sess-a", outcome: "applied" }, machine);
		expect(reply).toMatchObject({ status: "acknowledged", outcome: "applied", session_state: { status: "applied", state: "PAUSED" } });
		expect(machine.states.get("sess-a")).toBe("PAUSED");
		expect(machine.calls).toEqual([["sess-a", "PAUSED"]]);
		expect(machine.directiveIds).toEqual([id]);
		expect(reply).toMatchObject({ checkpoint_hint: { trigger: "steering", directive_id: id } });
	});

	test("an applied redirect moves the session to CONTEXT_REFRESH, and the machine's own rules take it back to ACTIVE", async () => {
		const machine = new StubSessionMachine();
		const { wiring, id } = await queued("redirect", machine);
		const reply = await acknowledgeSteeringWithState(wiring, OPERATOR, { directive_id: id, session_id: "sess-a", outcome: "applied" }, machine);
		expect(reply).toMatchObject({ session_state: { status: "applied", state: "CONTEXT_REFRESH" } });
		expect(reply).toMatchObject({ checkpoint_hint: { trigger: "steering", directive_id: id } });
		expect(machine.states.get("sess-a")).toBe("CONTEXT_REFRESH");
		expect(machine.applyTransition("sess-a", "ACTIVE")).toEqual({ ok: true, changed: true });
	});

	test("an applied annotate and every declined outcome leave the session where it is and never call the port", async () => {
		for (const [action, outcome] of [["annotate", "applied"], ["pause", "declined"], ["redirect", "declined"], ["annotate", "declined"]] as const) {
			const machine = new StubSessionMachine();
			const { wiring, id } = await queued(action, machine);
			const reply = await acknowledgeSteeringWithState(wiring, OPERATOR, { directive_id: id, session_id: "sess-a", outcome }, machine);
			expect(reply).toMatchObject({ status: "acknowledged", outcome, session_state: { status: "unchanged" } });
			expect(machine.calls).toEqual([]);
			expect(Object.hasOwn(reply, "checkpoint_hint")).toBe(false);
		}
	});

	test("a pause for an already PAUSED session and a redirect for an already CONTEXT_REFRESH session report unchanged and carry no checkpoint hint", async () => {
		for (const [action, held] of [["pause", "PAUSED"], ["redirect", "CONTEXT_REFRESH"]] as const) {
			const machine = new StubSessionMachine();
			machine.states.set("sess-a", held);
			const { wiring, id } = await queued(action, machine);
			const reply = await acknowledgeSteeringWithState(wiring, OPERATOR, { directive_id: id, session_id: "sess-a", outcome: "applied" }, machine);
			expect(reply).toMatchObject({ status: "acknowledged", outcome: "applied", session_state: { status: "unchanged" } });
			expect(machine.calls).toEqual([["sess-a", held]]);
			expect(machine.states.get("sess-a")).toBe(held);
			expect(Object.hasOwn(reply, "checkpoint_hint")).toBe(false);
		}
	});

	test("an illegal transition is refused by the machine, reported, and not forced; the acknowledgement stands", async () => {
		const machine = new StubSessionMachine();
		machine.states.set("sess-a", "PAUSED");
		const { wiring, inbox, id } = await queued("redirect", machine);
		const reply = await acknowledgeSteeringWithState(wiring, OPERATOR, { directive_id: id, session_id: "sess-a", outcome: "applied" }, machine);
		expect(reply).toMatchObject({
			status: "acknowledged",
			session_state: { status: "refused", state: "CONTEXT_REFRESH", reason: "steering transition PAUSED -> CONTEXT_REFRESH refused" },
		});
		expect(machine.states.get("sess-a")).toBe("PAUSED");
		expect(Object.hasOwn(reply, "checkpoint_hint")).toBe(false);
		expect(inbox.get(id)?.state).toBe("acknowledged");
	});

	test("a port that throws is a refused transition, not a failed acknowledgement", async () => {
		const machine = new StubSessionMachine();
		machine.throws = true;
		const { wiring, inbox, id } = await queued("pause", machine);
		const reply = await acknowledgeSteeringWithState(wiring, OPERATOR, { directive_id: id, session_id: "sess-a", outcome: "applied" }, machine);
		expect(reply).toMatchObject({ status: "acknowledged", session_state: { status: "refused", state: "PAUSED", reason: "state store unavailable" } });
		expect(inbox.get(id)?.state).toBe("acknowledged");
	});

	test("with no port the reply is the plain acknowledgement and names no session state", async () => {
		const { wiring, id } = await queued("pause", null);
		const reply = await acknowledgeSteeringWithState(wiring, OPERATOR, { directive_id: id, session_id: "sess-a", outcome: "applied" }, null);
		expect(reply).toEqual({ status: "acknowledged", directive_id: id, outcome: "applied", confirmed: false });
		expect(Object.hasOwn(reply, "session_state")).toBe(false);
	});

	test("a refused acknowledgement never reaches the port", async () => {
		const machine = new StubSessionMachine();
		const { wiring, id } = await queued("pause", machine, true);
		const unconfirmed = await acknowledgeSteeringWithState(wiring, OPERATOR, { directive_id: id, session_id: "sess-a", outcome: "applied" }, machine);
		expect(unconfirmed).toEqual({ status: "refused", error: { code: "confirmation-required" } });
		const wrongSession = await acknowledgeSteeringWithState(wiring, OPERATOR, { directive_id: id, session_id: "sess-b", outcome: "applied", confirm: true }, machine);
		expect(wrongSession).toEqual({ status: "refused", error: { code: "wrong-session" } });
		const notOperator = await acknowledgeSteeringWithState(wiring, { surface: "omp", isOperator: false }, { directive_id: id, session_id: "sess-a", outcome: "applied", confirm: true }, machine);
		expect(notOperator).toEqual({ status: "forbidden", reason: "operator-required" });
		expect(machine.calls).toEqual([]);
	});
});

describe("steeringQueuedEvent and SteeringHintAnnouncer", () => {
	test("the event is a note on the substrate surface that names the directive and carries no body", () => {
		const event = steeringQueuedEvent(directive({ body: `ride ${TOKEN}` }));
		expect(event).toEqual({
			surface: "substrate",
			kind: "note",
			summary: "steering redirect queued for sess-a",
			session_id: "sess-a",
			payload: { action: STEERING_QUEUED_ACTION, directive_id: "dir-1", target_session_id: "sess-a", steering_action: "redirect", priority: "normal" },
		});
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
