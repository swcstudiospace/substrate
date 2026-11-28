/** Subscription filter coverage: default-off, kind/scope matching, loop guard. Authored; parent executes. */
import { describe, expect, test } from "bun:test";
import { matchesSubscription, SteeringSubscriptions, type SteeringSourceEvent, type SteeringSubscription } from "./steering-subscriptions.ts";

const KIND = "planning.changed";

function event(overrides: Partial<SteeringSourceEvent> = {}): SteeringSourceEvent {
	return { id: "evt-1", kind: KIND, occurredAtMs: 1_000, seq: 1, repo: "acme/app", path: "docs/guide.md", ...overrides };
}

function sub(overrides: Partial<SteeringSubscription> = {}): SteeringSubscription {
	return { sessionId: "sess-a", eventKinds: [KIND], optedIn: true, ...overrides };
}

describe("matchesSubscription", () => {
	test("an opted-out subscription matches nothing", () => {
		expect(matchesSubscription(sub({ optedIn: false }), event())).toBe(false);
	});

	test("a kind outside the allow-list drops", () => {
		expect(matchesSubscription(sub({ eventKinds: ["other.kind"] }), event())).toBe(false);
	});

	test("an allowed kind with no scope passes", () => {
		expect(matchesSubscription(sub(), event())).toBe(true);
	});

	test("a path scope mismatch drops, a prefix match passes", () => {
		expect(matchesSubscription(sub({ pathScope: "src/" }), event())).toBe(false);
		expect(matchesSubscription(sub({ pathScope: "docs/" }), event())).toBe(true);
		expect(matchesSubscription(sub({ pathScope: "docs/guide.md" }), event())).toBe(true);
		expect(matchesSubscription(sub({ pathScope: "docs/*" }), event())).toBe(true);
		expect(matchesSubscription(sub({ pathScope: "*" }), event())).toBe(true);
	});

	test("a graph scope mismatch drops, a match passes", () => {
		const graphEvent = event({ path: undefined, graph: "doc:guide" });
		expect(matchesSubscription(sub({ graphScope: "doc:other" }), graphEvent)).toBe(false);
		expect(matchesSubscription(sub({ graphScope: "doc:guide" }), graphEvent)).toBe(true);
	});

	test("steering's own events never match, even when subscribed", () => {
		const self = sub({ eventKinds: ["steering.queued"] });
		expect(matchesSubscription(self, event({ kind: "steering.queued" }))).toBe(false);
	});
});

describe("SteeringSubscriptions", () => {
	test("absent record means default-off: no subscription, nothing active", () => {
		const subs = new SteeringSubscriptions();
		expect(subs.get("sess-a")).toBeNull();
		expect(subs.active()).toEqual([]);
	});

	test("subscribe then unsubscribe removes the record", () => {
		const subs = new SteeringSubscriptions();
		subs.subscribe({ sessionId: "sess-a", eventKinds: [KIND], pathScope: "docs/" });
		expect(subs.get("sess-a")).toMatchObject({ sessionId: "sess-a", eventKinds: [KIND], pathScope: "docs/", optedIn: true });
		expect(subs.active()).toHaveLength(1);
		expect(subs.unsubscribe("sess-a")).toBe(true);
		expect(subs.get("sess-a")).toBeNull();
		expect(subs.unsubscribe("sess-a")).toBe(false);
	});

	test("subscribe replaces the previous filter", () => {
		const subs = new SteeringSubscriptions();
		subs.subscribe({ sessionId: "sess-a", eventKinds: [KIND] });
		subs.subscribe({ sessionId: "sess-a", eventKinds: ["other.kind"] });
		expect(subs.get("sess-a")).toMatchObject({ eventKinds: ["other.kind"] });
	});

	test("malformed session ids and empty kinds are refused", () => {
		const subs = new SteeringSubscriptions();
		expect(() => subs.subscribe({ sessionId: "", eventKinds: [KIND] })).toThrow(RangeError);
		expect(() => subs.subscribe({ sessionId: "sess-a", eventKinds: [] })).toThrow(RangeError);
		expect(() => subs.unsubscribe("no spaces")).toThrow(RangeError);
	});
});
