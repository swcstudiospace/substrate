/**
 * The long-poll registry behind `GET /steering/wait` (phase 67): a directive queued before the call returns at once, a queue
 * wakes a waiter, and every other way a wait ends (the timeout, the client's abort, shutdown, a failing check) leaves no waiter,
 * timer or listener behind. The timers are injected and the inbox is in memory, so nothing sleeps.
 */
import { describe, expect, test } from "bun:test";
import { MemorySteeringIdempotencyStore, SteeringInbox, type SteeringAuditEntry, type SteeringHistorySink } from "./steering.ts";
import { STEERING_WAIT_PER_SESSION_MAX, SteeringWaiters, nextQueuedDirective, type QueuedDelivery, type SteeringWaitTimers } from "./steering-waiters.ts";
import { defined } from "../test-support.ts";

class MemorySink implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	async append(entry: SteeringAuditEntry): Promise<void> {
		this.entries.push(entry);
	}
}

class FakeTimers implements SteeringWaitTimers {
	readonly live = new Map<number, () => void>();
	private next = 0;
	cleared = 0;

	set(run: () => void): number {
		this.next += 1;
		this.live.set(this.next, run);
		return this.next;
	}

	clear(handle: unknown): void {
		this.cleared += 1;
		this.live.delete(handle as number);
	}

	/** Fires the one timer still pending, as the clock reaching its deadline would. */
	fire(): void {
		const [handle, run] = defined([...this.live.entries()][0], "a pending timer");
		this.live.delete(handle);
		run();
	}
}

let clockMs = 1_800_000_000_000;
const inboxOf = (): SteeringInbox =>
	new SteeringInbox({ history: new MemorySink(), clock: { nowMs: () => clockMs }, policy: { allowlist: ["omp"], ratePerMin: 1000 } });

async function queue(inbox: SteeringInbox, id: string, session = "sess-a"): Promise<void> {
	clockMs += 1;
	const result = await inbox.enqueue({
		id,
		author: { principalId: "omp", kind: "human" },
		createdAtMs: clockMs,
		priority: "normal",
		targetSessionId: session,
		action: "annotate",
		body: `note ${id}`,
		conflictsWithActivePlan: false,
	});
	expect(result.ok).toBe(true);
}

/** Queues at exactly `atMs` on the injected clock, which may be earlier than the last directive's time. */
async function queueAt(inbox: SteeringInbox, id: string, atMs: number): Promise<void> {
	clockMs = atMs - 1;
	await queue(inbox, id);
}

const idsOf = (delivery: QueuedDelivery | null): string | null => delivery?.record.directive.id ?? null;

describe("nextQueuedDirective", () => {
	test("the oldest queued directive for the session, whatever its priority", async () => {
		const inbox = inboxOf();
		await queue(inbox, "d1");
		await queue(inbox, "d2");
		await queue(inbox, "other", "sess-b");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", null))).toBe("d1");
		expect(idsOf(nextQueuedDirective(inbox, "sess-b", null))).toBe("other");
		expect(idsOf(nextQueuedDirective(inbox, "sess-c", null))).toBeNull();
	});

	test("`after` skips everything up to and including the named directive", async () => {
		const inbox = inboxOf();
		await queue(inbox, "d1");
		await queue(inbox, "d2");
		await queue(inbox, "d3");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", "d1"))).toBe("d2");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", "d2"))).toBe("d3");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", "d3"))).toBeNull();
	});

	test("a cursor the inbox does not hold filters nothing, so a restart never hides a queued directive", async () => {
		const inbox = inboxOf();
		await queue(inbox, "d1");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", "forgotten"))).toBe("d1");
	});

	test("a cursor naming another session's directive filters nothing, so it cannot hide this session's queue", async () => {
		const inbox = inboxOf();
		await queue(inbox, "a1");
		await queue(inbox, "a2");
		await queue(inbox, "b1", "sess-b");
		await queue(inbox, "b2", "sess-b");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", "b2"))).toBe("a1");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", "a1"))).toBe("a2");
	});

	test("an acknowledged directive is not next", async () => {
		const inbox = inboxOf();
		await queue(inbox, "d1");
		await queue(inbox, "d2");
		expect((await inbox.acknowledge({ directiveId: "d1", sessionId: "sess-a", outcome: "declined" })).ok).toBe(true);
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", null))).toBe("d2");
	});

	test("a clock that moves backwards does not sort a later directive before the delivered one", async () => {
		const inbox = inboxOf();
		await queueAt(inbox, "d1", 1_800_000_100_000);
		await queueAt(inbox, "d2", 1_800_000_000_000);
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", null))).toBe("d1");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", "d1"))).toBe("d2");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", "d2"))).toBeNull();
	});

	test("equal timestamps follow the order the directives entered, not the order of their ids", async () => {
		const inbox = inboxOf();
		await queueAt(inbox, "zz-first", 1_800_000_000_000);
		await queueAt(inbox, "aa-second", 1_800_000_000_000);
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", null))).toBe("zz-first");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", "zz-first"))).toBe("aa-second");
	});

	test("directives restored at boot take their sequence in restore order, and a new one comes after them", async () => {
		const inbox = inboxOf();
		const entry = (id: string, queuedAtMs: number): unknown => ({
			directive: {
				id,
				author: { principalId: "omp", kind: "human" },
				createdAtMs: queuedAtMs,
				priority: "normal",
				targetSessionId: "sess-a",
				action: "annotate",
				body: `note ${id}`,
				conflictsWithActivePlan: false,
			},
			queuedAtMs,
		});
		const report = await inbox.restore([entry("r-late", 1_800_000_200_000), entry("r-early", 1_800_000_100_000)]);
		expect(report.restored).toEqual(["r-late", "r-early"]);
		await queueAt(inbox, "fresh", 1_800_000_050_000);
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", null))).toBe("r-late");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", "r-late"))).toBe("r-early");
		expect(idsOf(nextQueuedDirective(inbox, "sess-a", "r-early"))).toBe("fresh");
	});
});

describe("restore at boot", () => {
	test("a restore whose sequence read fails leaves no directive with a record and no number", async () => {
		class SequenceDown extends MemorySteeringIdempotencyStore {
			override async nextSequence(): Promise<number> {
				throw new Error("sequence store down");
			}
		}
		const inbox = new SteeringInbox({ history: new MemorySink(), clock: { nowMs: () => clockMs }, policy: { allowlist: ["omp"], ratePerMin: 1000 }, store: new SequenceDown() });
		const legacy = {
			directive: { id: "r-legacy", author: { principalId: "omp", kind: "human" }, createdAtMs: clockMs, priority: "normal", targetSessionId: "sess-a", action: "annotate", body: "note", conflictsWithActivePlan: false },
			queuedAtMs: clockMs,
		};
		await expect(inbox.restore([legacy])).rejects.toThrow("sequence store down");
		expect(inbox.get("r-legacy")).toBeNull();
		expect(inbox.sequenceOf("r-legacy")).toBeNull();
	});
});

describe("SteeringWaiters.wait", () => {
	test("a directive queued before the call is returned at once and nothing is registered", async () => {
		const timers = new FakeTimers();
		const waiters = new SteeringWaiters({ timers });
		const inbox = inboxOf();
		await queue(inbox, "d1");
		const result = await waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, check: () => nextQueuedDirective(inbox, "sess-a", null) });
		expect(result.status === "directive" && result.record.directive.id).toBe("d1");
		expect(waiters.size).toBe(0);
		expect(timers.live.size).toBe(0);
	});

	test("a queue wakes the waiter of its own session and leaves another session's waiting", async () => {
		const timers = new FakeTimers();
		const waiters = new SteeringWaiters({ timers });
		const inbox = inboxOf();
		const a = waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, check: () => nextQueuedDirective(inbox, "sess-a", null) });
		const b = waiters.wait({ sessionId: "sess-b", timeoutMs: 1000, check: () => nextQueuedDirective(inbox, "sess-b", null) });
		expect(waiters.size).toBe(2);
		await queue(inbox, "d1", "sess-a");
		waiters.notify("sess-a");
		const woken = await a;
		expect(woken.status === "directive" && woken.record.directive.id).toBe("d1");
		expect(waiters.size).toBe(1);
		// The woken waiter's timer is cleared; the other session's is still pending.
		expect(timers.live.size).toBe(1);
		waiters.closeAll();
		expect((await b).status).toBe("closed");
	});

	test("a notify whose check finds nothing keeps the waiter waiting", async () => {
		const timers = new FakeTimers();
		const waiters = new SteeringWaiters({ timers });
		const inbox = inboxOf();
		const waiting = waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, check: () => nextQueuedDirective(inbox, "sess-a", null) });
		waiters.notify("sess-a");
		expect(waiters.size).toBe(1);
		timers.fire();
		expect((await waiting).status).toBe("timeout");
	});

	test("the timeout ends the wait and removes the waiter and its listener", async () => {
		const timers = new FakeTimers();
		const waiters = new SteeringWaiters({ timers });
		const controller = new AbortController();
		const waiting = waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, signal: controller.signal, check: () => null });
		expect(waiters.size).toBe(1);
		timers.fire();
		expect((await waiting).status).toBe("timeout");
		expect(waiters.size).toBe(0);
		// The abort listener is gone: aborting now changes nothing and cannot double-count.
		controller.abort();
		expect(waiters.size).toBe(0);
	});

	test("an abort ends the wait, clears the timer and leaves no waiter", async () => {
		const timers = new FakeTimers();
		const waiters = new SteeringWaiters({ timers });
		const controller = new AbortController();
		const waiting = waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, signal: controller.signal, check: () => null });
		controller.abort();
		expect((await waiting).status).toBe("aborted");
		expect(waiters.size).toBe(0);
		expect(timers.live.size).toBe(0);
		expect(timers.cleared).toBe(1);
	});

	test("an already-aborted signal registers nothing", async () => {
		const timers = new FakeTimers();
		const waiters = new SteeringWaiters({ timers });
		const controller = new AbortController();
		controller.abort();
		expect((await waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, signal: controller.signal, check: () => null })).status).toBe("aborted");
		expect(waiters.size).toBe(0);
		expect(timers.live.size).toBe(0);
	});

	test("a wait that ends one way cannot end again when another arrives late", async () => {
		const timers = new FakeTimers();
		const waiters = new SteeringWaiters({ timers });
		const inbox = inboxOf();
		const controller = new AbortController();
		const waiting = waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, signal: controller.signal, check: () => nextQueuedDirective(inbox, "sess-a", null) });
		await queue(inbox, "d1");
		waiters.notify("sess-a");
		expect((await waiting).status).toBe("directive");
		controller.abort();
		waiters.notify("sess-a");
		waiters.closeAll();
		expect(waiters.size).toBe(0);
	});

	test("one session holds at most its bound; the next is busy and registers nothing", async () => {
		const timers = new FakeTimers();
		const waiters = new SteeringWaiters({ timers });
		const held = Array.from({ length: STEERING_WAIT_PER_SESSION_MAX }, () => waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, check: () => null }));
		expect(await waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, check: () => null })).toEqual({ status: "busy", scope: "session" });
		expect(waiters.size).toBe(STEERING_WAIT_PER_SESSION_MAX);
		// Another session is not affected by it.
		const other = waiters.wait({ sessionId: "sess-b", timeoutMs: 1000, check: () => null });
		expect(waiters.size).toBe(STEERING_WAIT_PER_SESSION_MAX + 1);
		waiters.closeAll();
		await Promise.all([...held, other]);
	});

	test("the whole registry holds at most its total bound", async () => {
		const waiters = new SteeringWaiters({ timers: new FakeTimers(), totalMax: 2 });
		const first = waiters.wait({ sessionId: "s1", timeoutMs: 1000, check: () => null });
		const second = waiters.wait({ sessionId: "s2", timeoutMs: 1000, check: () => null });
		expect(await waiters.wait({ sessionId: "s3", timeoutMs: 1000, check: () => null })).toEqual({ status: "busy", scope: "total" });
		waiters.closeAll();
		await Promise.all([first, second]);
	});

	test("closeAll ends every waiter as closed, clears every timer and refuses later waits", async () => {
		const timers = new FakeTimers();
		const waiters = new SteeringWaiters({ timers });
		const a = waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, check: () => null });
		const b = waiters.wait({ sessionId: "sess-b", timeoutMs: 1000, check: () => null });
		waiters.closeAll();
		expect([(await a).status, (await b).status]).toEqual(["closed", "closed"]);
		expect(waiters.size).toBe(0);
		expect(timers.live.size).toBe(0);
		expect((await waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, check: () => null })).status).toBe("closed");
	});

	test("a check that throws ends that wait rather than holding the socket, and the notify still reaches the others", async () => {
		const waiters = new SteeringWaiters({ timers: new FakeTimers() });
		const inbox = inboxOf();
		const broken = waiters.wait({
			sessionId: "sess-a",
			timeoutMs: 1000,
			check: (() => {
				let calls = 0;
				return () => {
					calls += 1;
					if (calls > 1) throw new Error("inbox unreadable");
					return null;
				};
			})(),
		});
		const healthy = waiters.wait({ sessionId: "sess-a", timeoutMs: 1000, check: () => nextQueuedDirective(inbox, "sess-a", null) });
		await queue(inbox, "d1");
		waiters.notify("sess-a");
		expect((await broken).status).toBe("closed");
		expect((await healthy).status).toBe("directive");
		expect(waiters.size).toBe(0);
	});

	test("closeSession cancels only matching waits, once, without closing the registry", async () => {
		const timers = new FakeTimers();
		const waiters = new SteeringWaiters({ timers });
		const abort = new AbortController();
		const a = waiters.wait({ sessionId: "session-a", timeoutMs: 1000, signal: abort.signal, check: () => null });
		const b = waiters.wait({ sessionId: "session-b", timeoutMs: 1000, check: () => null });
		expect(waiters.closeSession("session-a")).toBe(1);
		expect(await a).toEqual({ status: "closed" });
		expect(waiters.closeSession("session-a")).toBe(0);
		abort.abort();
		expect(waiters.size).toBe(1);
		expect(timers.live.size).toBe(1);
		const fresh = waiters.wait({ sessionId: "session-a", timeoutMs: 1000, check: () => null });
		expect(waiters.size).toBe(2);
		waiters.closeAll();
		expect(await b).toEqual({ status: "closed" });
		expect(await fresh).toEqual({ status: "closed" });
		expect(waiters.size).toBe(0);
		expect(timers.live.size).toBe(0);
	});

	test("synchronous and throwing timer seams cannot leak a waiter or abort listener", async () => {
		for (const throws of [false, true]) {
			const cleared: unknown[] = [];
			const waiters = new SteeringWaiters({ timers: {
				set: run => { if (throws) throw new Error("test timer unavailable"); run(); return "timer"; },
				clear: handle => { cleared.push(handle); },
			} });
			const abort = new AbortController();
			const response = await waiters.wait({ sessionId: "session-a", timeoutMs: 1, signal: abort.signal, check: () => null });
			expect(response.status).toBe(throws ? "closed" : "timeout");
			expect(waiters.size).toBe(0);
			expect(cleared).toEqual(throws ? [] : ["timer"]);
			abort.abort();
			expect(waiters.size).toBe(0);
		}
	});
});

describe("the delivery sequence a wait hands back", () => {
	test("each directive carries its sequence in its own session, and an after cursor walks one session in queue order", async () => {
		const inbox = inboxOf();
		await queue(inbox, "d1");
		await queue(inbox, "d2");
		await queue(inbox, "other", "sess-b");
		const first = nextQueuedDirective(inbox, "sess-a", null);
		expect([first?.record.directive.id, first?.sequence]).toEqual(["d1", 1]);
		const second = nextQueuedDirective(inbox, "sess-a", "d1");
		expect([second?.record.directive.id, second?.sequence]).toEqual(["d2", 2]);
		expect(nextQueuedDirective(inbox, "sess-b", null)?.sequence).toBe(1);
	});
});
