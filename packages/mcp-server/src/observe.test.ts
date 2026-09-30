import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditUnavailableError, type AuditRecordInput } from "@substrate/audit";
import { METRIC, findCounter, sumCounter } from "@substrate/observability";
import { loadConfig } from "./config.ts";
import {
	auditRefusal,
	auditToolCalls,
	buildGraphEvidence,
	createObservability,
	normalizeRoute,
	toolCallsIn,
	toolLabel,
} from "./observe.ts";
import { Substrate } from "./service.ts";

function rpc(method: string, params?: unknown, id: unknown = 1) {
	return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

/** A path whose parent is a regular file: impossible to create, whoever is running. */
function unwritablePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "substrate-observe-"));
	writeFileSync(join(directory, "not-a-directory"), "");
	return join(directory, "not-a-directory", "mcp-audit.jsonl");
}

describe("normalizeRoute", () => {
	test("keeps the routes that exist", () => {
		expect(normalizeRoute("/brief")).toBe("/brief");
		expect(normalizeRoute("/mcp")).toBe("/mcp");
	});

	test("folds everything else into one bucket", () => {
		// A scanner walking random paths would otherwise mint a metric series per URL it
		// tried, which is a cardinality problem an unauthenticated caller could cause.
		expect(normalizeRoute("/wp-login.php")).toBe("other");
		expect(normalizeRoute("/brief/../../etc/passwd")).toBe("other");
	});
});

describe("toolCallsIn", () => {
	test("finds a single tools/call", () => {
		expect(toolCallsIn(rpc("tools/call", { name: "graph_claim", arguments: { graph_id: "ut-1" } }))).toEqual([
			{ id: 1, tool: "graph_claim", args: { graph_id: "ut-1" } },
		]);
	});

	test("finds every call in a batch", () => {
		const body = [
			rpc("tools/call", { name: "memory_brief" }, 1),
			rpc("tools/call", { name: "graph_claim" }, 2),
		];
		expect(toolCallsIn(body).map((call) => call.tool)).toEqual(["memory_brief", "graph_claim"]);
	});

	test("ignores handshake traffic — a trail of initialize calls buries the decisions", () => {
		expect(toolCallsIn(rpc("initialize"))).toEqual([]);
		expect(toolCallsIn(rpc("tools/list"))).toEqual([]);
		expect(toolCallsIn(rpc("notifications/initialized"))).toEqual([]);
	});

	test("ignores a malformed body rather than throwing on it", () => {
		expect(toolCallsIn(undefined)).toEqual([]);
		expect(toolCallsIn(null)).toEqual([]);
		expect(toolCallsIn("not an object")).toEqual([]);
		expect(toolCallsIn(rpc("tools/call", { arguments: {} }))).toEqual([]); // no name
		expect(toolCallsIn(rpc("tools/call", { name: 7 }))).toEqual([]);
	});

	test("a notification tools/call with no id is still audited, under a null id", () => {
		expect(toolCallsIn({ jsonrpc: "2.0", method: "tools/call", params: { name: "events_emit" } })[0]?.id).toBeNull();
	});
});

describe("auditToolCalls", () => {
	function observability(path: string | null) {
		return createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path ?? undefined }));
	}

	test("records an allowed call, with the graph it names", async () => {
		const observed = observability(null);
		await observed.start();

		const { denials } = await auditToolCalls(observed, "omp", [
			{ id: 1, tool: "graph_claim", args: { graph_id: "ut-1", node_id: "n4", session_id: "sess-1" } },
		]);

		expect(denials.size).toBe(0);
		const [record] = observed.audit.recent();
		expect(record).toMatchObject({
			surface: "omp",
			tool: "graph_claim",
			decision: "allowed",
			graph_id: "ut-1",
			node_id: "n4",
			session_id: "sess-1",
			transport: "mcp",
		});
	});

	test("keeps the argument names and a digest, never the values", async () => {
		const observed = observability(null);
		await observed.start();
		await auditToolCalls(observed, "omp", [
			{ id: 1, tool: "memory_write", args: { scope: "global", text: "the token is sk-ant-secret" } },
		]);

		const [record] = observed.audit.recent();
		expect(record?.arg_keys).toEqual(["scope", "text"]);
		expect(JSON.stringify(record)).not.toContain("sk-ant-secret");
	});

	test("counts the call in the tool-call metric", async () => {
		const observed = observability(null);
		await observed.start();
		await auditToolCalls(observed, "muse", [{ id: 1, tool: "memory_brief", args: {} }]);

		const counter = findCounter(observed.snapshot(), METRIC.toolCalls)!;
		expect(sumCounter(counter, { tool: "memory_brief", decision: "allowed" })).toBe(1);
	});

	test("attributes an unauthenticated caller rather than dropping the record", async () => {
		const observed = observability(null);
		await observed.start();
		await auditToolCalls(observed, null, [{ id: 1, tool: "memory_brief", args: {} }]);

		expect(observed.audit.recent()[0]?.surface).toBe("unknown");
	});

	test("denies a fail-closed tool the chain could not record", async () => {
		// The gate sits in front of the dispatcher, so the tool has not run at the point
		// this decision is made.
		const observed = observability(unwritablePath());
		await observed.start();

		const { denials } = await auditToolCalls(observed, "omp", [{ id: 42, tool: "graph_claim", args: {} }]);

		expect(denials.get("42")).toContain("graph_claim");
		expect(denials.get("42")).toContain("audit chain");
		expect(sumCounter(findCounter(observed.snapshot(), METRIC.toolCalls)!, { decision: "denied" })).toBe(1);
	});

	test("lets a fail-open tool through when the chain could not record it", async () => {
		const observed = observability(unwritablePath());
		await observed.start();

		const { denials } = await auditToolCalls(observed, "omp", [{ id: 1, tool: "events_emit", args: {} }]);

		expect(denials.size).toBe(0);
		expect(sumCounter(findCounter(observed.snapshot(), METRIC.auditAppends)!, { outcome: "lost" })).toBe(1);
	});

	test("an unknown tool is denied, because its audit mode was never decided", async () => {
		const observed = observability(unwritablePath());
		await observed.start();

		const { denials } = await auditToolCalls(observed, "omp", [{ id: 1, tool: "some_new_tool", args: {} }]);
		expect(denials.size).toBe(1);
	});

	test("records every call in a batch, not only the first", async () => {
		const observed = observability(null);
		await observed.start();
		await auditToolCalls(observed, "omp", [
			{ id: 1, tool: "memory_brief", args: {} },
			{ id: 2, tool: "graph_get", args: {} },
		]);

		expect(observed.audit.recent().map((record) => record.seq)).toEqual([1, 2]);
	});

	test("a refused batch leaves no `allowed` record for a call that never ran", async () => {
		// The bug: each call was recorded `allowed` as the loop reached it, so a denial on
		// a later call left the durable trail saying the earlier ones were permitted —
		// when the batch is refused whole and none of them was dispatched. Fail-closed
		// calls are now recorded first, and only they can produce a denial.
		const observed = observability(unwritablePath());
		await observed.start();

		const { denials } = await auditToolCalls(observed, "omp", [
			{ id: 1, tool: "memory_brief", args: {} },
			{ id: 2, tool: "graph_claim", args: { graph_id: "ut-1" } },
		]);

		expect(denials.size).toBe(1);
		const { records } = await observed.audit.readAll();
		expect(records.some((record) => record.tool === "memory_brief" && record.decision === "allowed")).toBe(false);
	});

	test("a denial after an earlier success in the same batch appends a correction", async () => {
		// Two fail-closed calls where only the first is recorded. The chain is append-only,
		// so that `allowed` record cannot be withdrawn — it is corrected by appending a
		// record saying the batch was refused and none of it was dispatched. A stub sink is
		// used because a real one that refuses the second write refuses the correction too,
		// and this is about the correction being attempted and recorded.
		const appended: AuditRecordInput[] = [];
		const audit = {
			async append(input: AuditRecordInput) {
				appended.push(input);
				if (input.tool === "graph_claim" && input.decision === "allowed") {
					throw new AuditUnavailableError(input.tool, "stubbed refusal");
				}
				return { record: {} as never, written: true };
			},
		};
		const observed = observability(null);

		const { denials } = await auditToolCalls(
			{ audit: audit as never, instruments: observed.instruments },
			"omp",
			[
				{ id: 2, tool: "graph_register", args: {} },
				{ id: 3, tool: "graph_claim", args: {} },
			],
		);

		expect(denials.size).toBe(1);
		const correction = appended.find((record) => record.tool === "batch");
		expect(correction).toMatchObject({ decision: "denied", mode: "fail-open" });
		expect(correction?.reason).toContain("refused whole after 1 call(s)");
		expect(correction?.reason).toContain("none of them was dispatched");
	});

	test("an unrecognised tool name is bucketed in the metric but kept exactly in the trail", async () => {
		// `tool` came straight from a caller-supplied JSON-RPC `params.name`, so it let an
		// authenticated caller mint one metric series per name it invented. The audit keeps
		// the real name — that is a log, where the exact value is the point.
		const observed = observability(null);
		await observed.start();
		await auditToolCalls(observed, "omp", [{ id: 1, tool: "wharrgarbl", args: {} }]);

		expect(sumCounter(findCounter(observed.snapshot(), METRIC.toolCalls)!, { tool: "unrecognized" })).toBe(1);
		expect(observed.audit.recent()[0]?.tool).toBe("wharrgarbl");
	});

	test("toolLabel keeps the tools that exist", () => {
		expect(toolLabel("graph_claim")).toBe("graph_claim");
		expect(toolLabel("events")).toBe("events");
		expect(toolLabel("../../etc/passwd")).toBe("unrecognized");
	});
});

describe("auditRefusal", () => {
	test("answers a single request with a JSON-RPC error carrying the reason", () => {
		const body = rpc("tools/call", { name: "graph_claim" }, 7);
		const refusal = auditRefusal(body, new Map([["7", "chain is unwritable"]])) as {
			jsonrpc: string;
			id: unknown;
			error: { code: number; message: string };
		};

		expect(refusal).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: "chain is unwritable" } });
	});

	test("refuses a batch whole, and says why the other calls were not dispatched", () => {
		// Dispatching the allowed half would leave the caller holding a partial result it
		// has no way to tell from a complete one.
		const body = [rpc("tools/call", { name: "memory_brief" }, 1), rpc("tools/call", { name: "graph_claim" }, 2)];
		const refusal = auditRefusal(body, new Map([["2", "chain is unwritable"]])) as Array<{
			id: unknown;
			error: { message: string };
		}>;

		expect(refusal).toHaveLength(2);
		expect(refusal[0]?.error.message).toContain("another call in this batch");
		expect(refusal[1]?.error.message).toBe("chain is unwritable");
	});

	test("an element with no id is answered against a null id, not dropped", () => {
		const refusal = auditRefusal({ jsonrpc: "2.0", method: "tools/call" }, new Map()) as { id: unknown };
		expect(refusal.id).toBeNull();
	});
});

describe("createObservability", () => {
	test("warns at boot when the audit chain is in memory only", async () => {
		const observed = createObservability(loadConfig({}));
		const warnings = await observed.start();

		expect(warnings.join(" ")).toContain("memory only");
		expect(observed.audit.durable).toBe(false);
		observed.stop();
	});

	test("warns at boot when the audit path cannot be written, rather than on the first claim", async () => {
		const observed = createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: unwritablePath() }));
		const warnings = await observed.start();

		expect(warnings.join(" ")).toContain("not durable");
		expect(warnings.join(" ")).toContain("fail-closed tools will be refused");
		observed.stop();
	});

	test("warns when no collector is configured, and still collects", async () => {
		const observed = createObservability(loadConfig({}));
		const warnings = await observed.start();

		expect(warnings.join(" ")).toContain("not exported");
		expect(observed.exporter).toBeNull();
		expect(observed.snapshot().length).toBeGreaterThan(0);
		observed.stop();
	});

	test("the observer records a brief, an emit and a claim", () => {
		const observed = createObservability(loadConfig({}));
		observed.observer.briefed?.({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 120 });
		observed.observer.emitted?.({
			surface: "omp",
			graph_id: "ut-1",
			kind: "shell",
			stored: true,
			durationMs: 5,
			payload: { usage: { input_tokens: 10 } },
		});
		observed.observer.claimed?.({
			surface: "omp",
			graph_id: "ut-1",
			node_id: "n4",
			decision: "revoked",
			reason: "withdrawn",
			quarantineReason: "unrecorded-claim",
		});

		const snapshot = observed.snapshot();
		expect(sumCounter(findCounter(snapshot, METRIC.emitTotal)!, { outcome: "stored" })).toBe(1);
		expect(sumCounter(findCounter(snapshot, METRIC.tokens)!, { direction: "input" })).toBe(10);
		expect(sumCounter(findCounter(snapshot, METRIC.claims)!, { outcome: "revoked" })).toBe(1);
		expect(sumCounter(findCounter(snapshot, METRIC.quarantines)!, { reason: "unrecorded-claim" })).toBe(1);
	});
});

describe("buildGraphEvidence", () => {
	test("reports an unverifiable app chain as unknown, not as broken", async () => {
		// `ok: false` would read as tampering. With no ledger configured there is simply
		// nothing to recompute, and the bundle has to say which of the two it is.
		const observed = createObservability(loadConfig({}));
		await observed.start();
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });

		const bundle = await buildGraphEvidence(observed, substrate, "ut-1");

		expect(bundle.chains.app_events.ok).toBeNull();
		expect(bundle.chains.app_events.reason).toBe("greptime not configured");
		observed.stop();
	});

	test("includes only the audit records naming the graph, and says when there are none", async () => {
		const observed = createObservability(loadConfig({}));
		await observed.start();
		await auditToolCalls(observed, "omp", [{ id: 1, tool: "graph_get", args: { graph_id: "ut-other" } }]);
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });

		const bundle = await buildGraphEvidence(observed, substrate, "ut-1");
		expect(bundle.audit.total).toBe(0);
		expect(bundle.notes.join(" ")).toContain("belong to other graphs");

		const own = await buildGraphEvidence(observed, substrate, "ut-other");
		expect(own.audit.total).toBe(1);
		observed.stop();
	});

	test("carries the SLO verdicts and the stub marker", async () => {
		const observed = createObservability(loadConfig({}));
		await observed.start();
		const bundle = await buildGraphEvidence(observed, new Substrate(loadConfig({}), { index: null, greptime: null }), "ut-1");

		expect(bundle.stub).toBe(true);
		expect(bundle.slos.map((slo) => slo.id)).toEqual(["brief.p95", "emit.success", "lease.steal_rate", "quarantine.rate"]);
		observed.stop();
	});

	test("an operator's note survives into the bundle", async () => {
		const observed = createObservability(loadConfig({}));
		await observed.start();
		const bundle = await buildGraphEvidence(
			observed,
			new Substrate(loadConfig({}), { index: null, greptime: null }),
			"ut-1",
			["collected during the chaos smoke"],
		);

		expect(bundle.notes).toContain("collected during the chaos smoke");
		observed.stop();
	});
});
