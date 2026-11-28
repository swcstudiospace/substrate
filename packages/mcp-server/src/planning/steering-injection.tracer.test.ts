/** Tracer: subscribed session gets one queued directive visible in the inbox; unsubscribed gets nothing. Authored; parent executes. */
import { describe, expect, test } from "bun:test";
import { steeringNoticeFor } from "./steering-delivery.ts";
import { injectionKey, SteeringInjector } from "./steering-injection.ts";
import { SteeringSubscriptions, type SteeringSourceEvent } from "./steering-subscriptions.ts";
import { SteeringInbox, type SteeringAuditEntry, type SteeringHistorySink } from "./steering.ts";

const NOW = 1_800_000_000_000;

class MemorySink implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	async append(entry: SteeringAuditEntry): Promise<void> {
		this.entries.push(entry);
	}
}

function fixture() {
	const history = new MemorySink();
	const inbox = new SteeringInbox({
		history,
		clock: { nowMs: () => NOW },
		policy: { allowlist: ["omp"], ratePerMin: 1_000 },
	});
	const subscriptions = new SteeringSubscriptions();
	const injector = new SteeringInjector({
		inbox,
		subscriptions,
		clock: { nowMs: () => NOW },
		sleep: () => Promise.resolve(),
	});
	return { history, inbox, subscriptions, injector };
}

function changeEvent(id: string): SteeringSourceEvent {
	return { id, kind: "planning.changed", occurredAtMs: NOW, seq: 1, repo: "acme/app", path: "docs/guide.md", summary: "guide refreshed" };
}

describe("steering injection tracer", () => {
	test("subscribed session gets exactly one directive carrying the event reference", async () => {
		const { inbox, subscriptions, injector } = fixture();
		subscriptions.subscribe({ sessionId: "sess-a", eventKinds: ["planning.changed"] });

		const results = await injector.maybeInject(changeEvent("evt-1"));

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ status: "injected", sessionId: "sess-a", duplicate: false });
		if (results[0]?.status !== "injected") throw new Error("tracer did not inject");
		expect(results[0].directiveId).toBe(injectionKey("evt-1", "sess-a"));

		const records = inbox.recordsFor("sess-a");
		expect(records).toHaveLength(1);
		expect(records[0]?.directive.body).toContain("evt-1");
		expect(records[0]?.directive.body).toContain("planning.changed");
		expect(records[0]?.directive.body).toContain("acme/app");

		const notice = steeringNoticeFor(inbox, "sess-a", NOW);
		expect(notice).not.toBeNull();
		expect(notice?.count).toBe(1);
	});

	test("unsubscribed session receives zero directives", async () => {
		const { history, inbox, injector } = fixture();

		const results = await injector.maybeInject(changeEvent("evt-1"));

		expect(results).toEqual([]);
		expect(inbox.recordsFor("sess-a")).toEqual([]);
		expect(steeringNoticeFor(inbox, "sess-a", NOW)).toBeNull();
		expect(history.entries).toEqual([]);
	});

	test("kind mismatch receives nothing even with a subscription", async () => {
		const { inbox, subscriptions, injector } = fixture();
		subscriptions.subscribe({ sessionId: "sess-a", eventKinds: ["other.kind"] });

		expect(await injector.maybeInject(changeEvent("evt-1"))).toEqual([]);
		expect(inbox.recordsFor("sess-a")).toEqual([]);
	});

	test("one-step revert acknowledges the injected directive declined", async () => {
		const { inbox, subscriptions, injector } = fixture();
		subscriptions.subscribe({ sessionId: "sess-a", eventKinds: ["planning.changed"] });
		await injector.maybeInject(changeEvent("evt-1"));

		expect(await injector.revertInjection("sess-a", "evt-1")).toBe(true);
		expect(inbox.get(injectionKey("evt-1", "sess-a"))?.state).toBe("acknowledged");
	});
});
