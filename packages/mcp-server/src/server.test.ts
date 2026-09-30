import { describe, expect, test } from "bun:test";
import { healthStatus, memoryWriteStatus, memoryWriter } from "./server.ts";

/** Shorthand for a health report; every field defaults to the unhealthy value. */
function health(over: Partial<Parameters<typeof healthStatus>[0]> = {}) {
	return { index: false, greptime: false, eventsWritable: false, ...over };
}

describe("healthStatus", () => {
	test("503 when a configured ledger cannot take writes, even with a healthy index", () => {
		// The regression: `eventsWritable || index` answered 200 here, so the one state
		// this hardening exists to catch — every append refused — looked healthy to a
		// monitor watching the status code.
		expect(healthStatus(health({ index: true, greptime: true, eventsWritable: false }), true)).toBe(503);
	});

	test("503 when the configured ledger is unreachable", () => {
		expect(healthStatus(health({ index: true }), true)).toBe(503);
	});

	test("200 once the ledger accepts writes", () => {
		expect(healthStatus(health({ greptime: true, eventsWritable: true }), true)).toBe(200);
		expect(healthStatus(health({ index: true, greptime: true, eventsWritable: true }), true)).toBe(200);
	});

	test("a run with no ledger configured is judged on its remaining stores", () => {
		// Local dev, or a deployment that deliberately has no ledger: an unwritable
		// ledger it never had must not fail it.
		expect(healthStatus(health({ index: true }), false)).toBe(200);
		expect(healthStatus(health(), false)).toBe(503);
	});
});

describe("memoryWriteStatus", () => {
	/** Shorthand for a governance result; only the fields the mapping reads. */
	function result(outcome: string, over: { reason?: string; verified_persisted?: boolean } = {}) {
		return { outcome, reason: over.reason ?? outcome, verified_persisted: over.verified_persisted ?? true };
	}

	test("only a write that was read back gets a 200", () => {
		// A hook that can see nothing but the status code still has to be able to tell
		// "stored and confirmed" from "taken, not confirmed" — the same distinction
		// /events already draws between 202 and 200.
		expect(memoryWriteStatus(result("accepted"))).toBe(200);
		expect(memoryWriteStatus(result("accepted", { verified_persisted: false }))).toBe(202);
	});

	test("the three refusals are distinguishable without parsing the body", () => {
		expect(memoryWriteStatus(result("conflict", { reason: "review.required", verified_persisted: false }))).toBe(409);
		expect(memoryWriteStatus(result("quarantined", { reason: "quarantine.secret", verified_persisted: false }))).toBe(422);
		expect(memoryWriteStatus(result("denied", { reason: "rbac.no-grant", verified_persisted: false }))).toBe(403);
	});

	test("an outage is a 503, not a 403", () => {
		// A monitor must not read "the index is down" as "this agent lacks permission".
		expect(memoryWriteStatus(result("denied", { reason: "store.unavailable", verified_persisted: false }))).toBe(503);
		expect(memoryWriteStatus(result("denied", { reason: "store.write-failed", verified_persisted: false }))).toBe(503);
	});
});

describe("memoryWriter", () => {
	test("the token wins, and a body-supplied writer cannot outrank it", () => {
		// Attribution is what RBAC is decided on, so a caller naming its own surface
		// would make default-deny a formality.
		expect(memoryWriter("muse", "hermes", false)).toBe("muse");
		expect(memoryWriter("muse", "hermes", true)).toBe("muse");
	});

	test("a body-supplied writer is honoured only where no token exists at all", () => {
		// A local run has no token to beat, and forcing `unknown` there would leave
		// memory unwritable rather than protected.
		expect(memoryWriter(null, "hermes", true)).toBe("hermes");
		expect(memoryWriter(null, "hermes", false)).toBe("unknown");
	});

	test("anything missing or empty is the writer that holds no grants", () => {
		expect(memoryWriter(null, undefined, true)).toBe("unknown");
		expect(memoryWriter(null, "   ", true)).toBe("unknown");
		expect(memoryWriter(null, 42, true)).toBe("unknown");
	});
});
