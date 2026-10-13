import { describe, expect, test } from "bun:test";
import {
	ADMISSION_CLASSES,
	ADMISSION_DECISIONS,
	CITATION_PROVENANCES,
	DOCS_LATENCY_BUCKETS_MS,
	DOCS_SEARCH_OUTCOMES,
	MEMORY_EXPIRED_MODES,
	METRIC,
	PLANE_ERROR_REASONS,
	SubstrateInstruments,
	classifyEventRefusal,
	classifyPlaneReason,
	extractUsage,
} from "./instruments.ts";
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

describe("recordMemoryExpired", () => {
	test("served and hidden are separate series under one caller and kind, with no other label", () => {
		// The report→enforce rollout reads this: `served` is what enforce would hide,
		// `hidden` is what it did. A label a caller could type would unbound the series.
		const instruments = new SubstrateInstruments();
		instruments.recordMemoryExpired({ surface: "cursor", kind: "warning", mode: "served" });
		instruments.recordMemoryExpired({ surface: "cursor", kind: "warning", mode: "served" });
		instruments.recordMemoryExpired({ surface: "cursor", kind: "warning", mode: "hidden" });
		instruments.recordMemoryExpired({ surface: "hermes", kind: "decision", mode: "hidden" });

		const counter = findCounter(instruments.snapshot(), METRIC.memoryExpired)!;
		expect(counter.unit).toBe("{entry}");
		expect(sumCounter(counter, { surface: "cursor", kind: "warning", mode: "served" })).toBe(2);
		expect(sumCounter(counter, { surface: "cursor", kind: "warning", mode: "hidden" })).toBe(1);
		expect(sumCounter(counter, { mode: "hidden" })).toBe(2);
		expect(sumCounter(counter)).toBe(4);
		for (const point of counter.points) {
			expect(Object.keys(point.attributes).sort()).toEqual(["kind", "mode", "surface"]);
			expect(MEMORY_EXPIRED_MODES as readonly string[]).toContain(String(point.attributes.mode));
		}
	});
});

describe("recordPlane", () => {
	test("records the duration by plane, op and outcome, and an error by its bounded reason", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordPlane({ plane: "greptime", op: "select", outcome: "ok", durationMs: 120 });
		instruments.recordPlane({ plane: "greptime", op: "insert", outcome: "error", durationMs: 30, reason: "greptime 503: upstream" });
		instruments.recordPlane({ plane: "hindsight", op: "recall", outcome: "timeout", durationMs: 4000, reason: "TimeoutError" });
		instruments.recordPlane({ plane: "ragflow", op: "retrieve", outcome: "open", durationMs: 0 });
		instruments.recordPlane({ plane: "index", op: "query", outcome: "error", durationMs: 1000, reason: "connect ECONNREFUSED 10.0.0.1:5432" });
		instruments.recordPlane({ plane: "cache", op: "get", outcome: "error", durationMs: 1, reason: "WRONGTYPE" });

		const snapshot = instruments.snapshot();
		const duration = findHistogram(snapshot, METRIC.planeDuration)!;
		expect(mergeHistogram(duration, { plane: "greptime" }).count).toBe(2);
		expect(mergeHistogram(duration, { plane: "greptime", op: "select", outcome: "ok" }).count).toBe(1);
		expect(mergeHistogram(duration, { outcome: "open" }).count).toBe(1);
		const errors = findCounter(snapshot, METRIC.planeErrors)!;
		expect(sumCounter(errors, { plane: "greptime", reason: "server" })).toBe(1);
		expect(sumCounter(errors, { plane: "hindsight", reason: "timeout" })).toBe(1);
		expect(sumCounter(errors, { plane: "ragflow", reason: "open" })).toBe(1);
		expect(sumCounter(errors, { plane: "index", reason: "network" })).toBe(1);
		expect(sumCounter(errors, { plane: "cache", reason: "other" })).toBe(1);
		// An ok sample is not an error.
		expect(sumCounter(errors)).toBe(5);
		// Every reason attribute is one of the closed set, and the message never became one.
		for (const point of errors.points) {
			expect(PLANE_ERROR_REASONS as readonly string[]).toContain(String(point.attributes.reason));
			expect(Object.keys(point.attributes).sort()).toEqual(["plane", "reason"]);
		}
	});

	test("classifyPlaneReason keeps the set closed", () => {
		expect(classifyPlaneReason({ plane: "index", op: "ping", outcome: "ok", durationMs: 1 })).toBeNull();
		expect(classifyPlaneReason({ plane: "index", op: "ping", outcome: "error", durationMs: 1, reason: "server 502" })).toBe("server");
		expect(classifyPlaneReason({ plane: "index", op: "ping", outcome: "error", durationMs: 1, reason: "fetch failed" })).toBe("network");
		expect(classifyPlaneReason({ plane: "index", op: "ping", outcome: "error", durationMs: 1 })).toBe("other");
	});
});

describe("recordAdmission", () => {
	test("counts one series per surface, class and decision, with exactly those three labels", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordAdmission({ surface: "grok-bot", klass: "read", decision: "allowed" });
		instruments.recordAdmission({ surface: "grok-bot", klass: "read", decision: "allowed" });
		instruments.recordAdmission({ surface: "grok-bot", klass: "read", decision: "shadow_limited" });
		instruments.recordAdmission({ surface: "anonymous", klass: "write", decision: "limited" });
		instruments.recordAdmission({ surface: "omp", klass: "coordination", decision: "bypass" });

		const counter = findCounter(instruments.snapshot(), METRIC.admissionDecisions)!;
		expect(counter.name).toBe("substrate.admission.decisions");
		expect(sumCounter(counter, { surface: "grok-bot", class: "read", decision: "allowed" })).toBe(2);
		expect(sumCounter(counter, { surface: "grok-bot", decision: "shadow_limited" })).toBe(1);
		expect(sumCounter(counter, { surface: "anonymous", class: "write", decision: "limited" })).toBe(1);
		expect(sumCounter(counter, { decision: "bypass" })).toBe(1);
		expect(sumCounter(counter)).toBe(5);
		for (const point of counter.points) {
			expect(Object.keys(point.attributes).sort()).toEqual(["class", "decision", "surface"]);
			expect(ADMISSION_CLASSES as readonly string[]).toContain(String(point.attributes.class));
			expect(ADMISSION_DECISIONS as readonly string[]).toContain(String(point.attributes.decision));
		}
	});
});

describe("recordDocsSearch (uplift-3 N5)", () => {
	test("counts searches by surface, outcome and cached, times them end to end, and splits citations by provenance", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordDocsSearch({ surface: "grok-bot", outcome: "hit", cached: false, durationMs: 1500, citations: { recorded: 3, unrecorded: 2 } });
		instruments.recordDocsSearch({ surface: "grok-bot", outcome: "hit", cached: true, durationMs: 4, citations: { recorded: 3, unrecorded: 2 } });
		instruments.recordDocsSearch({ surface: "omp", outcome: "empty", cached: false, durationMs: 900, citations: {} });
		instruments.recordDocsSearch({ surface: "omp", outcome: "degraded", cached: false, durationMs: 4100, citations: {} });
		instruments.recordDocsSearch({ surface: "omp", outcome: "hit", cached: false, durationMs: 300, citations: { unpinned: 1 } });

		const snapshot = instruments.snapshot();
		const searches = findCounter(snapshot, METRIC.docsSearch)!;
		expect(sumCounter(searches)).toBe(5);
		expect(sumCounter(searches, { surface: "grok-bot", outcome: "hit", cached: "true" })).toBe(1);
		expect(sumCounter(searches, { surface: "grok-bot", outcome: "hit", cached: "false" })).toBe(1);
		expect(sumCounter(searches, { outcome: "empty" })).toBe(1);
		expect(sumCounter(searches, { outcome: "degraded" })).toBe(1);
		// Every outcome label is one of the closed set; the attribute keys are exactly the three.
		for (const point of searches.points) {
			expect(DOCS_SEARCH_OUTCOMES as readonly string[]).toContain(String(point.attributes.outcome));
			expect(Object.keys(point.attributes).sort()).toEqual(["cached", "outcome", "surface"]);
		}

		// A cache hit is counted per citation it returned too: the share of
		// unrecorded answers is what the counter reads as, hit or loaded.
		const citations = findCounter(snapshot, METRIC.docsCitations)!;
		expect(sumCounter(citations, { provenance: "recorded" })).toBe(6);
		expect(sumCounter(citations, { provenance: "unrecorded" })).toBe(4);
		expect(sumCounter(citations, { provenance: "unpinned" })).toBe(1);
		for (const point of citations.points) {
			expect(CITATION_PROVENANCES as readonly string[]).toContain(String(point.attributes.provenance));
			expect(Object.keys(point.attributes)).toEqual(["provenance"]);
		}

		const duration = findHistogram(snapshot, METRIC.docsDuration)!;
		expect(mergeHistogram(duration).count).toBe(5);
		expect(mergeHistogram(duration, { cached: "true" }).count).toBe(1);
		expect(mergeHistogram(duration, { surface: "omp", cached: "false" }).count).toBe(3);
		// Its edges carry the objective (2,000 ms) and the default budget (4,000 ms), so
		// `docs.search.p95` is decidable and a budget-costing search is visibly past it.
		expect(duration.bounds).toEqual(DOCS_LATENCY_BUCKETS_MS);
		expect(DOCS_LATENCY_BUCKETS_MS).toContain(2000);
		expect(DOCS_LATENCY_BUCKETS_MS).toContain(4000);
	});
});
