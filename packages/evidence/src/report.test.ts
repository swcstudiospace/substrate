import { describe, expect, test } from "bun:test";
import { NO_POSITION, buildRecord, type AuditRecord } from "@substrate/audit";
import { SubstrateInstruments, evaluateSlos } from "@substrate/observability";
import { buildEvidence, usageForGraph, type EvidenceInput } from "./report.ts";

const SERVICE = { name: "substrate-mcp", version: "0.1.0", instance: "vps-1" };

function records(count: number, decision: "allowed" | "denied" = "allowed"): AuditRecord[] {
	const out: AuditRecord[] = [];
	let prev: string | null = null;
	for (let i = 1; i <= count; i++) {
		const record = buildRecord(
			{ surface: "omp", tool: decision === "denied" ? "graph_claim" : "memory_brief", decision, mode: "fail-open" },
			{ seq: i, prev },
			new Date(1_790_186_361_000 + i),
		);
		out.push(record);
		prev = record.hash;
	}
	return out;
}

function input(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
	return {
		graph_id: "ut-abc123-deadbeef",
		generated: new Date("2026-09-30T06:54:39.000Z"),
		service: SERVICE,
		slos: [],
		appChain: { ok: true, records: 12 },
		audit: { chain: { ok: true, records: 3 }, durable: true, path: "/var/lib/substrate/mcp-audit.jsonl", records: records(3) },
		...overrides,
	};
}

describe("buildEvidence", () => {
	test("marks itself a stub and names what it cannot yet attest to", () => {
		// An evidence document that overstates itself is worse than one that is honestly
		// partial.
		const bundle = buildEvidence(input());

		expect(bundle.stub).toBe(true);
		expect(bundle.schema).toBe("substrate.evidence/v0");
		expect(bundle.pending.join(" ")).toContain("Merkle anchor");
		expect(bundle.pending.join(" ")).toContain("Phase 2");
	});

	test("carries both chains, separately", () => {
		const bundle = buildEvidence(input());

		expect(bundle.chains.app_events).toMatchObject({ ok: true, records: 12 });
		expect(bundle.chains.mcp_audit).toMatchObject({ ok: true, records: 3, durable: true });
	});

	test("a broken audit chain carries where and why", () => {
		const bundle = buildEvidence(
			input({
				audit: {
					chain: { ok: false, records: 5, brokenAt: 3, reason: "hash does not match contents" },
					durable: true,
					path: "/tmp/a.jsonl",
					records: records(5),
				},
			}),
		);

		expect(bundle.chains.mcp_audit).toMatchObject({ ok: false, brokenAt: 3, reason: "hash does not match contents" });
	});

	test("a verified chain carries no brokenAt, so a reader cannot misread one", () => {
		const bundle = buildEvidence(input());
		expect("brokenAt" in bundle.chains.mcp_audit).toBe(false);
	});

	test("a break with no locatable position carries its reason but no brokenAt", () => {
		const bundle = buildEvidence(
			input({
				audit: {
					chain: { ok: false, records: 3, brokenAt: NO_POSITION, reason: "2 line(s) could not be parsed", unparseable: 2 },
					durable: true,
					path: "/x",
					records: records(3),
				},
			}),
		);

		expect("brokenAt" in bundle.chains.mcp_audit).toBe(false);
		expect(bundle.chains.mcp_audit.reason).toBe("2 line(s) could not be parsed");
		expect(bundle.chains.mcp_audit.ok).toBe(false);
		expect(bundle.chains.mcp_audit.unparseable).toBe(2);
	});

	test("says so, in the bundle, when the audit chain is not durable", () => {
		const bundle = buildEvidence(
			input({ audit: { chain: { ok: true, records: 1 }, durable: false, path: null, records: records(1) } }),
		);

		expect(bundle.notes.join(" ")).toContain("not durable");
		expect(bundle.chains.mcp_audit.path).toBeNull();
	});

	test("summarises the SLO verdicts without flattening the unjudged into passes", () => {
		const instruments = new SubstrateInstruments();
		for (let i = 0; i < 30; i++) instruments.recordBrief({ surface: "omp", ok: true, durationMs: 100 });
		const slos = evaluateSlos(instruments.snapshot());
		const bundle = buildEvidence(input({ slos }));

		expect(bundle.slo_summary.ok).toBe(1);
		expect(bundle.slo_summary.insufficient).toBe(3);
		expect(bundle.slo_summary.ok + bundle.slo_summary.breached + bundle.slo_summary.insufficient + bundle.slo_summary.unmeasurable).toBe(
			slos.length,
		);
	});

	test("tallies the audit records it was given", () => {
		const bundle = buildEvidence(input({ audit: { chain: { ok: true, records: 4 }, durable: true, path: "/x", records: records(4, "denied") } }));

		expect(bundle.audit).toMatchObject({ total: 4, allowed: 0, denied: 4 });
		expect(bundle.audit.byTool).toEqual([{ tool: "graph_claim", allowed: 0, denied: 4 }]);
	});

	test("an operator's note survives alongside the generated ones", () => {
		const bundle = buildEvidence(input({ notes: ["collected during the SPE-4793 chaos smoke"] }));
		expect(bundle.notes).toContain("collected during the SPE-4793 chaos smoke");
	});
});

describe("usageForGraph", () => {
	test("reads this graph's tokens and cost back out of the snapshot", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordEmit({
			surface: "omp",
			graph_id: "ut-1",
			kind: "prompt",
			stored: true,
			durationMs: 1,
			payload: { usage: { input_tokens: 500, output_tokens: 100, cost_usd: 0.01 } },
		});
		instruments.recordEmit({
			surface: "omp",
			graph_id: "ut-2",
			kind: "prompt",
			stored: true,
			durationMs: 1,
			payload: { usage: { input_tokens: 999, cost_usd: 9 } },
		});

		expect(usageForGraph(instruments.snapshot(), "ut-1")).toEqual({ inputTokens: 500, outputTokens: 100, costUsd: 0.01 });
	});

	test("answers null rather than another graph's numbers when the series collapsed", () => {
		// The cardinality guard being honest about its cost at the one place it is
		// visible: a graph folded into `_overflow` is not separable, so its totals are
		// not reported at all.
		const instruments = new SubstrateInstruments();
		instruments.recordEmit({
			surface: "omp",
			graph_id: "ut-other",
			kind: "prompt",
			stored: true,
			durationMs: 1,
			payload: { usage: { input_tokens: 7 } },
		});

		expect(usageForGraph(instruments.snapshot(), "ut-missing")).toBeNull();
	});

	test("answers null when there is no snapshot at all", () => {
		expect(usageForGraph(undefined, "ut-1")).toBeNull();
		expect(usageForGraph(new SubstrateInstruments().snapshot(), "ut-1")).toBeNull();
	});

	test("finds a long graph id, and does not hand it a longer one's totals", () => {
		// The metric attribute used to be truncated at 120 characters while this searches
		// with the full id, so a graph whose id was longer lost its usage — and an id of
		// exactly 120 received the totals of every longer id sharing its prefix, reporting
		// one graph's spend as another's.
		const long = `ut-${"a".repeat(300)}`;
		const longer = `${long}-child`;
		const instruments = new SubstrateInstruments();
		instruments.recordEmit({
			surface: "omp",
			graph_id: long,
			kind: "prompt",
			stored: true,
			durationMs: 1,
			payload: { usage: { input_tokens: 11, cost_usd: 0.5 } },
		});
		instruments.recordEmit({
			surface: "omp",
			graph_id: longer,
			kind: "prompt",
			stored: true,
			durationMs: 1,
			payload: { usage: { input_tokens: 2000, cost_usd: 90 } },
		});

		expect(usageForGraph(instruments.snapshot(), long)).toEqual({ inputTokens: 11, outputTokens: 0, costUsd: 0.5 });
		expect(usageForGraph(instruments.snapshot(), longer)).toEqual({ inputTokens: 2000, outputTokens: 0, costUsd: 90 });
	});
});

describe("usage is read back by the form the identifier is stored under", () => {
	test("a graph whose id redacts still gets its tokens and cost", () => {
		// The metric attribute holds the *normalised* graph_id, because that is what the
		// observer is handed off the stored event. Reading usage back with the raw id matched
		// nothing, and a bundle reporting no tokens is indistinguishable from a graph that
		// spent nothing — the same silent disappearance as selecting audit records raw.
		const stored = "ut-[REDACTED]";
		const instruments = new SubstrateInstruments();
		instruments.recordEmit({
			surface: "omp",
			graph_id: stored,
			kind: "prompt",
			stored: true,
			durationMs: 1,
			payload: { usage: { input_tokens: 500, cost_usd: 0.25 } },
		});

		const bundle = buildEvidence({
			graph_id: stored,
			service: { name: "substrate", version: "0.1.0", instance: "test" },
			slos: [],
			appChain: { ok: true, records: 0 },
			audit: { chain: { ok: true, records: 0 }, durable: true, path: "/tmp/a.jsonl", records: [] },
			metrics: instruments.snapshot(),
		});

		expect(bundle.usage).toEqual({ inputTokens: 500, outputTokens: 0, costUsd: 0.25 });
		// The document names the graph by the key it is stored under, so the raw identifier —
		// which is where the credential was — is not echoed into an archived artefact.
		expect(bundle.graph_id).toBe(stored);
		expect(JSON.stringify(bundle)).not.toContain("sk-ant-");
	});

	test("an identifier nothing cleaned is used as it is", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordEmit({
			surface: "omp",
			graph_id: "ut-mfk2p3-9a3b1c7d",
			kind: "prompt",
			stored: true,
			durationMs: 1,
			payload: { usage: { input_tokens: 7 } },
		});

		const bundle = buildEvidence({
			graph_id: "ut-mfk2p3-9a3b1c7d",
			service: { name: "substrate", version: "0.1.0", instance: "test" },
			slos: [],
			appChain: { ok: true, records: 0 },
			audit: { chain: { ok: true, records: 0 }, durable: true, path: null, records: [] },
			metrics: instruments.snapshot(),
		});

		expect(bundle.usage).toEqual({ inputTokens: 7, outputTokens: 0, costUsd: 0 });
	});
});
