import { describe, expect, test } from "bun:test";
import { METRIC, SubstrateInstruments, classifyEventRefusal, extractUsage } from "./instruments.ts";
import { findCounter, findHistogram, mergeHistogram, sumCounter } from "./metrics.ts";

describe("extractUsage", () => {
	test("reads the canonical shape", () => {
		expect(extractUsage({ usage: { input_tokens: 1200, output_tokens: 340, cost_usd: 0.0123, model: "claude" } })).toEqual(
			{ inputTokens: 1200, outputTokens: 340, costUsd: 0.0123, model: "claude" },
		);
	});

	test("reads the dialects the five existing collectors already speak", () => {
		// Rewriting them all is not this ticket; normalising on read costs one function
		// and no coordination.
		expect(extractUsage({ tokens_in: 10, tokens_out: 5 })).toMatchObject({ inputTokens: 10, outputTokens: 5 });
		expect(extractUsage({ prompt_tokens: 10, completion_tokens: 5 })).toMatchObject({ inputTokens: 10, outputTokens: 5 });
	});

	test("counts a total-only report on the input side rather than inventing a split", () => {
		// An invented output count would be indistinguishable from a measured one.
		expect(extractUsage({ total_tokens: 99 })).toMatchObject({ inputTokens: 99, outputTokens: 0 });
	});

	test("accepts counts that arrived as strings", () => {
		expect(extractUsage({ usage: { input_tokens: "1200" } })).toMatchObject({ inputTokens: 1200 });
	});

	test("ignores a payload with no usage in it, so a shell event contributes no zero", () => {
		expect(extractUsage({ command: "cargo test", exit: 0 })).toBeNull();
		expect(extractUsage({})).toBeNull();
		expect(extractUsage(undefined)).toBeNull();
	});

	test("ignores a negative or non-numeric count", () => {
		expect(extractUsage({ input_tokens: -5 })).toBeNull();
		expect(extractUsage({ input_tokens: "lots" })).toBeNull();
	});

	test("does not mistake an array under `usage` for the nested form", () => {
		expect(extractUsage({ usage: [1, 2], tokens_in: 4 })).toMatchObject({ inputTokens: 4 });
	});
});

describe("recordEmit", () => {
	test("splits the emit counter by outcome, which is what the SLO reads", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordEmit({ surface: "omp", graph_id: "ut-1", kind: "shell", stored: true, durationMs: 12 });
		instruments.recordEmit({ surface: "omp", graph_id: "ut-1", kind: "shell", stored: false, durationMs: 40 });

		const counter = findCounter(instruments.snapshot(), METRIC.emitTotal)!;
		expect(sumCounter(counter)).toBe(2);
		expect(sumCounter(counter, { outcome: "stored" })).toBe(1);
		expect(sumCounter(counter, { outcome: "dropped" })).toBe(1);
	});

	test("records latency whether or not the ledger took the event", () => {
		// A refused append still cost the caller its wait, so hiding it would make the
		// latency histogram flatter than the agent's experience.
		const instruments = new SubstrateInstruments();
		instruments.recordEmit({ surface: "omp", kind: "shell", stored: false, durationMs: 40 });

		expect(mergeHistogram(findHistogram(instruments.snapshot(), METRIC.emitDuration)!).count).toBe(1);
	});

	test("attributes tokens and cost carried on the payload to the surface and graph", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordEmit({
			surface: "hermes",
			graph_id: "ut-2",
			kind: "prompt",
			stored: true,
			durationMs: 5,
			payload: { usage: { input_tokens: 1000, output_tokens: 250, cost_usd: 0.02, model: "opus" } },
		});

		const tokens = findCounter(instruments.snapshot(), METRIC.tokens)!;
		expect(sumCounter(tokens, { graph_id: "ut-2", direction: "input" })).toBe(1000);
		expect(sumCounter(tokens, { graph_id: "ut-2", direction: "output" })).toBe(250);
		expect(sumCounter(findCounter(instruments.snapshot(), METRIC.cost)!, { graph_id: "ut-2" })).toBeCloseTo(0.02, 10);
	});

	test("an event with no usage creates no token series at all", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordEmit({ surface: "omp", kind: "shell", stored: true, durationMs: 1, payload: { exit: 0 } });

		expect(findCounter(instruments.snapshot(), METRIC.tokens)?.points).toEqual([]);
	});
});

describe("recordRequest", () => {
	test("buckets the status into a class, keeping the series count flat", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordRequest({ surface: "omp", route: "/events", status: 202, durationMs: 3 });
		instruments.recordRequest({ surface: "omp", route: "/events", status: 503, durationMs: 9 });

		const counter = findCounter(instruments.snapshot(), METRIC.requestTotal)!;
		expect(counter.points).toHaveLength(2);
		expect(sumCounter(counter, { status: "2xx" })).toBe(1);
		expect(sumCounter(counter, { status: "5xx" })).toBe(1);
	});
});

describe("recordBrief", () => {
	test("records latency for a failed brief too", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordBrief({ surface: "omp", ok: false, durationMs: 900 });

		const histogram = findHistogram(instruments.snapshot(), METRIC.briefDuration)!;
		expect(histogram.points[0]?.attributes.outcome).toBe("error");
		expect(mergeHistogram(histogram).count).toBe(1);
	});
});

describe("recordClaim", () => {
	test("a stolen claim lands in both the claim counter and the lease-steal counter", () => {
		// The SLO's numerator is the steal counter and its denominator is the claim
		// counter, so a steal has to appear in both or the ratio is wrong.
		const instruments = new SubstrateInstruments();
		instruments.recordClaim({ surface: "omp", graph_id: "ut-1", outcome: "stolen" });
		instruments.recordClaim({ surface: "omp", graph_id: "ut-1", outcome: "granted" });

		const claims = findCounter(instruments.snapshot(), METRIC.claims)!;
		expect(sumCounter(claims)).toBe(2);
		expect(sumCounter(claims, { outcome: "stolen" })).toBe(1);
		expect(sumCounter(findCounter(instruments.snapshot(), METRIC.leaseSteals)!)).toBe(1);
	});

	test("a granted claim does not touch the steal counter", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordClaim({ surface: "omp", outcome: "granted" });

		expect(findCounter(instruments.snapshot(), METRIC.leaseSteals)?.points).toEqual([]);
	});
});

describe("refused events and anonymous callers", () => {
	test("classifies a 4xx by reason and ignores anything else", () => {
		expect(classifyEventRefusal(401, "unknown or missing bearer token")).toBe("auth");
		expect(classifyEventRefusal(403, "cannot act as grok-bot")).toBe("attribution");
		expect(classifyEventRefusal(400, "unknown kind: nope")).toBe("validation");
		expect(classifyEventRefusal(400, "unknown kind: graph_id")).toBe("validation");
		expect(classifyEventRefusal(400, "graph_id must be a string")).toBe("graph_id");
		expect(classifyEventRefusal(503, "ledger down")).toBeNull();
		expect(classifyEventRefusal(202, undefined)).toBeNull();
	});

	test("counts each refusal reason on its own series", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordEventRefusal({ reason: "auth" });
		instruments.recordEventRefusal({ reason: "auth" });
		instruments.recordEventRefusal({ reason: "graph_id" });

		const counter = findCounter(instruments.snapshot(), METRIC.eventsRefused)!;
		expect(sumCounter(counter, { reason: "auth" })).toBe(2);
		expect(sumCounter(counter, { reason: "graph_id" })).toBe(1);
		expect(sumCounter(counter, { reason: "validation" })).toBe(0);
	});

	test("counts an anonymous caller by route and the surface it claimed", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordAnonymous({ route: "/events", claimedSurface: "hermes" });
		instruments.recordAnonymous({ route: "/handoff", claimedSurface: "none" });

		const counter = findCounter(instruments.snapshot(), METRIC.anonymousRequests)!;
		expect(sumCounter(counter, { route: "/events", claimed_surface: "hermes" })).toBe(1);
		expect(sumCounter(counter, { route: "/handoff", claimed_surface: "none" })).toBe(1);
	});
});

describe("recordQuarantine and recordAudit", () => {
	test("a quarantine is filed under its reason", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordQuarantine({ surface: "omp", graph_id: "ut-1", reason: "unrecorded-claim" });

		expect(sumCounter(findCounter(instruments.snapshot(), METRIC.quarantines)!, { reason: "unrecorded-claim" })).toBe(1);
	});

	test("an audit record that could not be written is counted as lost, not as written", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordAudit({ decision: "allowed", written: false });

		expect(sumCounter(findCounter(instruments.snapshot(), METRIC.auditAppends)!, { outcome: "lost" })).toBe(1);
	});
});
