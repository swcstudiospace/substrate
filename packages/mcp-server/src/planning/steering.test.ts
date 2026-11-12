/**
 * The steering inbox: audit precedes the transition, human-only authorisation, a per-session rate limit, the
 * confirm rule for conflicting plans, and typed env parsing. Every collaborator is a deterministic fake.
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_STEERING_RATE_PER_MIN,
	STEERING_AUDIT_ATTEMPTS,
	STEERING_ENABLED_ENV,
	STEERING_PRINCIPALS_ENV,
	STEERING_RATE_PER_MIN_ENV,
	SteeringInbox,
	loadSteeringSettings,
	type SteeringAuditEntry,
	type SteeringClock,
	type SteeringHistorySink,
} from "./steering.ts";

const HUMAN = "ops.lead";
const WORKER = "worker-a";

class ManualClock implements SteeringClock {
	constructor(private now: number) {}
	nowMs(): number {
		return this.now;
	}
	advance(ms: number): void {
		this.now += ms;
	}
}

/** Records every entry it accepts, and the directive state the inbox held at the moment of each append. */
class RecordingHistory implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	readonly stateAtAppend: Array<string | null> = [];
	attempts = 0;
	private failures = 0;

	constructor(private readonly inbox: () => SteeringInbox) {}

	failNext(count: number): void {
		this.failures = count;
	}

	async append(entry: SteeringAuditEntry): Promise<void> {
		this.attempts += 1;
		if (this.failures > 0) {
			this.failures -= 1;
			throw Object.assign(new Error("history unavailable"), { code: "ECONNRESET" });
		}
		const id = entry.event === "queued" ? entry.directive.id : entry.directiveId;
		this.stateAtAppend.push(this.inbox().get(id)?.state ?? null);
		this.entries.push(entry);
	}
}

function build(options: { allowlist?: string[]; ratePerMin?: number } = {}) {
	const clock = new ManualClock(1_000_000);
	const history = new RecordingHistory(() => inbox);
	const inbox: SteeringInbox = new SteeringInbox({
		history,
		clock,
		policy: { allowlist: options.allowlist ?? [HUMAN], ratePerMin: options.ratePerMin ?? DEFAULT_STEERING_RATE_PER_MIN },
	});
	return { inbox, history, clock };
}

function directive(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "d-1",
		author: { principalId: HUMAN, kind: "human" },
		createdAtMs: 1_000,
		priority: "normal",
		targetSessionId: WORKER,
		action: "pause",
		body: "Hold the 53-01 plan until the review lands.",
		conflictsWithActivePlan: false,
		...overrides,
	};
}

describe("SteeringInbox: audit precedes the transition", () => {
	test("queued is audited before it takes effect, and acknowledged is audited before it is recorded", async () => {
		const { inbox, history } = build();
		const queued = await inbox.enqueue(directive());
		expect(queued.ok).toBe(true);

		const acked = await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "applied" });
		expect(acked.ok).toBe(true);

		expect(history.entries.map((entry) => entry.event)).toEqual(["queued", "acknowledged"]);
		// Each append saw the state from before its own transition: nothing was in effect yet.
		expect(history.stateAtAppend).toEqual([null, "queued"]);
		expect(inbox.get("d-1")?.state).toBe("acknowledged");
	});

	test("a queue that cannot be audited stores nothing and returns a typed error", async () => {
		const { inbox, history } = build();
		history.failNext(STEERING_AUDIT_ATTEMPTS);

		const result = await inbox.enqueue(directive());

		expect(result).toEqual({
			ok: false,
			error: { code: "audit-unavailable", attempts: STEERING_AUDIT_ATTEMPTS, lastErrorCode: "ECONNRESET" },
		});
		expect(history.attempts).toBe(2);
		expect(inbox.get("d-1")).toBeNull();
		expect(inbox.pendingFor(WORKER)).toEqual([]);
	});

	test("one failed audit write is retried once, and the transition then proceeds", async () => {
		const { inbox, history } = build();
		history.failNext(1);

		const result = await inbox.enqueue(directive());

		expect(result.ok).toBe(true);
		expect(history.attempts).toBe(2);
		expect(history.entries.map((entry) => entry.event)).toEqual(["queued"]);
	});

	test("an acknowledgement that cannot be audited holds the directive queued and leaves it retryable", async () => {
		const { inbox, history } = build();
		await inbox.enqueue(directive());
		history.failNext(STEERING_AUDIT_ATTEMPTS);

		const held = await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "declined" });
		expect(held.ok).toBe(false);
		expect(inbox.get("d-1")?.state).toBe("queued");

		const retried = await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "declined" });
		expect(retried.ok).toBe(true);
		expect(inbox.get("d-1")?.state).toBe("acknowledged");
	});
});

describe("SteeringInbox: human-only authorisation", () => {
	test("a human on the allowlist is accepted", async () => {
		const { inbox } = build({ allowlist: [HUMAN] });
		expect((await inbox.enqueue(directive())).ok).toBe(true);
	});

	test("a human who is not on the allowlist is refused, and nothing is audited", async () => {
		const { inbox, history } = build({ allowlist: ["someone.else"] });
		const result = await inbox.enqueue(directive());
		expect(result).toEqual({ ok: false, error: { code: "principal-not-allowed" } });
		expect(history.attempts).toBe(0);
	});

	test("an agent-kind author is refused even when its principal is on the allowlist", async () => {
		const { inbox, history } = build({ allowlist: [HUMAN] });
		const result = await inbox.enqueue(directive({ author: { principalId: HUMAN, kind: "agent" } }));
		expect(result).toEqual({ ok: false, error: { code: "agent-author-refused" } });
		expect(history.attempts).toBe(0);
	});

	test("an empty allowlist refuses every human author", async () => {
		const { inbox } = build({ allowlist: [] });
		expect(await inbox.enqueue(directive())).toEqual({ ok: false, error: { code: "principal-not-allowed" } });
	});

	test("a directive with a reused id is refused as a duplicate", async () => {
		const { inbox } = build();
		await inbox.enqueue(directive());
		expect(await inbox.enqueue(directive())).toEqual({ ok: false, error: { code: "duplicate-directive" } });
	});
});

describe("SteeringInbox: rate limit per target session", () => {
	test("the eleventh directive in one minute is refused, and the window reopens after a minute", async () => {
		const { inbox, clock } = build({ ratePerMin: 10 });
		for (let index = 0; index < 10; index += 1) {
			expect((await inbox.enqueue(directive({ id: `burst-${index}` }))).ok).toBe(true);
		}

		const refused = await inbox.enqueue(directive({ id: "burst-10" }));
		expect(refused).toEqual({ ok: false, error: { code: "rate-limited", retryAfterMs: 6_000 } });
		expect(inbox.get("burst-10")).toBeNull();

		clock.advance(60_000);
		expect((await inbox.enqueue(directive({ id: "burst-10" }))).ok).toBe(true);
	});

	test("the limit is per target session: another session is not throttled by this one", async () => {
		const { inbox } = build({ ratePerMin: 1 });
		expect((await inbox.enqueue(directive({ id: "a-1", targetSessionId: "worker-a" }))).ok).toBe(true);
		expect((await inbox.enqueue(directive({ id: "a-2", targetSessionId: "worker-a" }))).ok).toBe(false);
		expect((await inbox.enqueue(directive({ id: "b-1", targetSessionId: "worker-b" }))).ok).toBe(true);
	});

	test("a clock that moves backwards mints no tokens", async () => {
		const { inbox, clock } = build({ ratePerMin: 1 });
		expect((await inbox.enqueue(directive({ id: "c-1" }))).ok).toBe(true);
		clock.advance(-120_000);
		expect((await inbox.enqueue(directive({ id: "c-2" }))).ok).toBe(false);
	});
});

describe("SteeringInbox: conflicting plans need an explicit confirm", () => {
	test("applied without confirm is refused and stays queued; applied with confirm is recorded as confirmed", async () => {
		const { inbox, history } = build();
		await inbox.enqueue(directive({ conflictsWithActivePlan: true }));
		const auditedBefore = history.entries.length;

		const unconfirmed = await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "applied" });
		expect(unconfirmed).toEqual({ ok: false, error: { code: "confirmation-required" } });
		expect(inbox.get("d-1")?.state).toBe("queued");
		expect(history.entries.length).toBe(auditedBefore);

		const confirmed = await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "applied", confirm: true });
		expect(confirmed.ok).toBe(true);
		expect(inbox.get("d-1")).toMatchObject({ state: "acknowledged", outcome: "applied", confirmed: true });
	});

	test("declining a conflicting directive needs no confirm", async () => {
		const { inbox } = build();
		await inbox.enqueue(directive({ conflictsWithActivePlan: true }));
		const declined = await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "declined" });
		expect(declined.ok).toBe(true);
		expect(inbox.get("d-1")).toMatchObject({ state: "acknowledged", outcome: "declined", confirmed: false });
	});
});

describe("SteeringInbox: input and acknowledgement rules", () => {
	test("the body is redacted before it is stored", async () => {
		const { inbox } = build();
		const result = await inbox.enqueue(directive({ body: "keep <private>hidden detail</private> visible" }));
		expect(result.ok).toBe(true);
		const stored = inbox.get("d-1");
		expect(stored?.directive.body).not.toContain("hidden detail");
		expect(stored?.directive.body).toContain("visible");
	});

	test("a body over the bound is refused by field path, without echoing the body", async () => {
		const { inbox } = build();
		const secretLike = "x".repeat(5_000);
		const result = await inbox.enqueue(directive({ body: secretLike }));
		expect(result).toEqual({ ok: false, error: { code: "invalid-directive", issues: ["body"] } });
		expect(JSON.stringify(result)).not.toContain("xxxxxxxxxx");
	});

	test("an unknown field is refused", async () => {
		const { inbox } = build();
		const result = await inbox.enqueue(directive({ rogue: true }));
		expect(result).toMatchObject({ ok: false, error: { code: "invalid-directive" } });
	});

	test("an acknowledgement from a session other than the target is refused", async () => {
		const { inbox } = build();
		await inbox.enqueue(directive());
		expect(await inbox.acknowledge({ directiveId: "d-1", sessionId: "worker-b", outcome: "declined" })).toEqual({
			ok: false,
			error: { code: "wrong-session" },
		});
	});

	test("acknowledging an unknown directive or twice is refused", async () => {
		const { inbox } = build();
		expect(await inbox.acknowledge({ directiveId: "missing", sessionId: WORKER, outcome: "declined" })).toEqual({
			ok: false,
			error: { code: "not-found" },
		});
		await inbox.enqueue(directive());
		await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "declined" });
		expect(await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "declined" })).toEqual({
			ok: false,
			error: { code: "already-acknowledged" },
		});
	});

	test("pending directives sort by priority, then age, then id", async () => {
		const { inbox, clock } = build({ ratePerMin: 100 });
		await inbox.enqueue(directive({ id: "low-old", priority: "low", createdAtMs: 1 }));
		clock.advance(1);
		await inbox.enqueue(directive({ id: "high-new", priority: "high", createdAtMs: 9 }));
		await inbox.enqueue(directive({ id: "normal-b", priority: "normal", createdAtMs: 5 }));
		await inbox.enqueue(directive({ id: "normal-a", priority: "normal", createdAtMs: 5 }));
		expect(inbox.pendingFor(WORKER).map((item) => item.id)).toEqual(["high-new", "normal-a", "normal-b", "low-old"]);
	});
});

describe("loadSteeringSettings", () => {
	test("an empty environment is off, refuses everyone, and uses the default rate", () => {
		expect(loadSteeringSettings({})).toEqual({
			ok: true,
			settings: { enabled: false, allowlist: [], ratePerMin: DEFAULT_STEERING_RATE_PER_MIN },
		});
		expect(DEFAULT_STEERING_RATE_PER_MIN).toBe(10);
	});

	test("the enable flag accepts the documented spellings, case-insensitively", () => {
		for (const word of ["1", "true", "YES", " On "]) {
			expect(loadSteeringSettings({ [STEERING_ENABLED_ENV]: word })).toMatchObject({ ok: true, settings: { enabled: true } });
		}
		for (const word of ["0", "false", "No", "off"]) {
			expect(loadSteeringSettings({ [STEERING_ENABLED_ENV]: word })).toMatchObject({ ok: true, settings: { enabled: false } });
		}
	});

	test("an unknown boolean string is a typed error, never a fallback", () => {
		expect(loadSteeringSettings({ [STEERING_ENABLED_ENV]: "maybe" })).toEqual({
			ok: false,
			errors: [{ key: STEERING_ENABLED_ENV, reason: "not-boolean" }],
		});
		expect(loadSteeringSettings({ [STEERING_ENABLED_ENV]: "   " })).toEqual({
			ok: false,
			errors: [{ key: STEERING_ENABLED_ENV, reason: "not-boolean" }],
		});
	});

	test("malformed and out-of-range rates are typed errors with bounds, and the value is not echoed", () => {
		expect(loadSteeringSettings({ [STEERING_RATE_PER_MIN_ENV]: "ten" })).toEqual({
			ok: false,
			errors: [{ key: STEERING_RATE_PER_MIN_ENV, reason: "not-integer" }],
		});
		expect(loadSteeringSettings({ [STEERING_RATE_PER_MIN_ENV]: "" })).toEqual({
			ok: false,
			errors: [{ key: STEERING_RATE_PER_MIN_ENV, reason: "not-integer" }],
		});
		expect(loadSteeringSettings({ [STEERING_RATE_PER_MIN_ENV]: "0" })).toEqual({
			ok: false,
			errors: [{ key: STEERING_RATE_PER_MIN_ENV, reason: "out-of-range", min: 1, max: 1_000 }],
		});
		expect(loadSteeringSettings({ [STEERING_RATE_PER_MIN_ENV]: "25" })).toMatchObject({
			ok: true,
			settings: { ratePerMin: 25 },
		});
	});

	test("the principal list is comma-separated, trimmed and deduplicated; malformed entries are errors", () => {
		expect(loadSteeringSettings({ [STEERING_PRINCIPALS_ENV]: " ops.lead , ops.lead,pm-anna " })).toMatchObject({
			ok: true,
			settings: { allowlist: ["ops.lead", "pm-anna"] },
		});
		expect(loadSteeringSettings({ [STEERING_PRINCIPALS_ENV]: "ops.lead,,pm-anna" })).toEqual({
			ok: false,
			errors: [{ key: STEERING_PRINCIPALS_ENV, reason: "empty-principal" }],
		});
		expect(loadSteeringSettings({ [STEERING_PRINCIPALS_ENV]: "bad name" })).toEqual({
			ok: false,
			errors: [{ key: STEERING_PRINCIPALS_ENV, reason: "invalid-principal" }],
		});
	});

	test("every bad key is reported in one result, not just the first", () => {
		const result = loadSteeringSettings({
			[STEERING_ENABLED_ENV]: "sometimes",
			[STEERING_RATE_PER_MIN_ENV]: "-3",
			[STEERING_PRINCIPALS_ENV]: "a,,b",
		});
		expect(result).toEqual({
			ok: false,
			errors: [
				{ key: STEERING_ENABLED_ENV, reason: "not-boolean" },
				{ key: STEERING_PRINCIPALS_ENV, reason: "empty-principal" },
				{ key: STEERING_RATE_PER_MIN_ENV, reason: "not-integer" },
			],
		});
	});
});

describe("SteeringInbox: reads and writes return copies", () => {
	test("mutating a record returned by a write or a read does not change a later read", async () => {
		const original = "Hold the 53-01 plan until the review lands.";
		const { inbox } = build();
		const written = await inbox.enqueue(directive());
		if (!written.ok) throw new Error("the directive should queue");
		written.value.directive.body = "tampered through the enqueue result";

		const got = inbox.get("d-1");
		if (got === null) throw new Error("the queued directive should be readable");
		got.directive.body = "tampered through get";
		const [pending] = inbox.pendingFor(WORKER);
		if (pending === undefined) throw new Error("the directive should be pending");
		pending.body = "tampered through pendingFor";
		const [listed] = inbox.recordsFor(WORKER);
		if (listed === undefined) throw new Error("the directive should be listed");
		listed.directive.body = "tampered through recordsFor";

		expect(inbox.get("d-1")).toMatchObject({ state: "queued", directive: { body: original } });
		expect(inbox.pendingFor(WORKER).map((item) => item.body)).toEqual([original]);
	});
});

describe("SteeringInbox: a clock that moves backwards adds no tokens", () => {
	test("a clock that moves backwards adds no tokens", async () => {
		const { inbox, clock } = build({ ratePerMin: 2 });
		expect((await inbox.enqueue(directive({ id: "d-1" }))).ok).toBe(true);
		clock.advance(-30_000);
		expect((await inbox.enqueue(directive({ id: "d-2" }))).ok).toBe(true);
		clock.advance(30_000);
		expect(await inbox.enqueue(directive({ id: "d-3" }))).toMatchObject({ ok: false, error: { code: "rate-limited" } });
	});
});

describe("SteeringInbox: a restart keeps queued directives in delivery order", () => {
	test("a legacy row keeps its place below a directive stored after the upgrade, on every restart", async () => {
		// The row queued before the sequence column has no stored sequence. The directive queued after the upgrade is stored with sequence 1.
		const legacy = { directive: directive({ id: "legacy", createdAtMs: 1_000 }), queuedAtMs: 1_000 };
		const first = build();
		expect((await first.inbox.restore([legacy])).restored).toEqual(["legacy"]);
		expect((await first.inbox.enqueue(directive({ id: "fresh", createdAtMs: 2_000 }))).ok).toBe(true);
		const stored = first.history.entries.flatMap((entry) =>
			entry.event === "queued" ? [{ directive: entry.directive, queuedAtMs: entry.atMs, deliverySequence: entry.deliverySequence }] : [],
		);
		const order = (inbox: SteeringInbox): string[] => inbox.queuedFor(WORKER).map((entry) => entry.record.directive.id);
		expect(order(first.inbox)).toEqual(["legacy", "fresh"]);

		// Each restart is a new inbox: it seeds the stored floor, then restores the same rows. The legacy row must not move above `fresh`.
		for (let restart = 0; restart < 2; restart++) {
			const next = build();
			next.inbox.seedSequence(1);
			expect((await next.inbox.restore([legacy, ...stored])).restored).toEqual(["legacy", "fresh"]);
			expect(order(next.inbox)).toEqual(["legacy", "fresh"]);
			expect(next.inbox.pendingFor(WORKER).map((pending) => pending.id)).toEqual(["legacy", "fresh"]);

			// A directive queued after the restart still sorts after every restored one.
			expect((await next.inbox.enqueue(directive({ id: "newer", createdAtMs: 3_000 }))).ok).toBe(true);
			expect(order(next.inbox)).toEqual(["legacy", "fresh", "newer"]);
		}
	});
});
