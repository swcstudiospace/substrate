import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, AuditUnavailableError, type AuditRecordInput } from "@substrate/audit";
import { METRIC, findCounter, sumCounter } from "@substrate/observability";
import { loadConfig } from "./config.ts";
import {
	MAX_EVIDENCE_RECORDS,
	auditRefusal,
	auditToolCalls,
	buildGraphEvidence,
	chainState,
	claimOutcome,
	createObservability,
	normalizeRoute,
	recordClaimWithdrawal,
	renderEvidenceHtml,
	toolCallsIn,
	toolLabel,
} from "./observe.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";

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
		expect(normalizeRoute("/events/stream")).toBe("/events/stream");
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

		const counter = defined(findCounter(observed.snapshot(), METRIC.toolCalls), "toolCalls counter");
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
		expect(sumCounter(defined(findCounter(observed.snapshot(), METRIC.toolCalls), "toolCalls counter"), { decision: "denied" })).toBe(1);
	});

	test("lets a fail-open tool through when the chain could not record it", async () => {
		const observed = observability(unwritablePath());
		await observed.start();

		const { denials } = await auditToolCalls(observed, "omp", [{ id: 1, tool: "events_emit", args: {} }]);

		expect(denials.size).toBe(0);
		expect(sumCounter(defined(findCounter(observed.snapshot(), METRIC.auditAppends), "auditAppends counter"), { outcome: "lost" })).toBe(1);
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

	test("the correction names the graph, so it reaches that graph's evidence", async () => {
		// Without this the correction had no `graph_id`, and `buildGraphEvidence` selects
		// by exactly that field — so it was filtered out of every bundle while the earlier
		// `allowed` record, which does name its graph, was kept. That graph's evidence then
		// showed a claim as allowed with nothing saying it never ran.
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

		await auditToolCalls({ audit: audit as never, instruments: observed.instruments }, "omp", [
			{ id: 1, tool: "graph_register", args: { graph_id: "ut-1" } },
			{ id: 2, tool: "graph_claim", args: { graph_id: "ut-1" } },
		]);

		const correction = appended.find((record) => record.tool === "batch");
		expect(correction?.graph_id).toBe("ut-1");
		expect(correction?.reason).toContain("for this graph");
	});

	test("a batch spanning two graphs gets one correction each, counting only its own calls", async () => {
		// A record carries a single `graph_id`, so one correction could only ever reach one
		// of the affected graphs' bundles.
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

		await auditToolCalls({ audit: audit as never, instruments: observed.instruments }, "omp", [
			{ id: 1, tool: "graph_register", args: { graph_id: "ut-1" } },
			{ id: 2, tool: "graph_register", args: { graph_id: "ut-1" } },
			{ id: 3, tool: "graph_register", args: { graph_id: "ut-2" } },
			{ id: 4, tool: "graph_claim", args: { graph_id: "ut-2" } },
		]);

		const corrections = appended.filter((record) => record.tool === "batch");
		expect(corrections.map((record) => record.graph_id).sort()).toEqual(["ut-1", "ut-2"]);
		expect(corrections.find((record) => record.graph_id === "ut-1")?.reason).toContain("after 2 call(s)");
		expect(corrections.find((record) => record.graph_id === "ut-2")?.reason).toContain("after 1 call(s)");
	});

	test("a call naming no graph is corrected under a null one, where its allowed record sits", async () => {
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

		await auditToolCalls({ audit: audit as never, instruments: observed.instruments }, "omp", [
			{ id: 1, tool: "memory_write", args: { scope: "global" } },
			{ id: 2, tool: "graph_claim", args: {} },
		]);

		const correction = appended.find((record) => record.tool === "batch");
		expect(correction?.graph_id).toBeNull();
		expect(correction?.reason).not.toContain("for this graph");
	});

	test("a batch correction lands in the bundle for the graph it names", async () => {
		// The other half of the property, over a real chain: `buildGraphEvidence` keeps a
		// `tool: "batch"` record when its graph matches, so the correction is read
		// alongside the record it corrects.
		const observed = observability(null);
		await observed.start();
		await observed.audit.append({
			surface: "omp",
			tool: "graph_claim",
			graph_id: "ut-9",
			decision: "allowed",
			mode: "fail-closed",
		});
		await observed.audit.append({
			surface: "omp",
			tool: "batch",
			graph_id: "ut-9",
			decision: "denied",
			mode: "fail-open",
			reason: "the batch was refused whole after 1 call(s) for this graph had already been recorded as allowed",
		});

		const bundle = await buildGraphEvidence(observed, new Substrate(loadConfig({}), { index: null, greptime: null }), "ut-9");

		expect(bundle.audit.total).toBe(2);
		expect(bundle.audit.denied).toBe(1);
		expect(bundle.audit.byTool.map((row) => row.tool).sort()).toEqual(["batch", "graph_claim"]);
		observed.stop();
	});

	test("an unrecognised tool name is bucketed in the metric but kept exactly in the trail", async () => {
		// `tool` came straight from a caller-supplied JSON-RPC `params.name`, so it let an
		// authenticated caller mint one metric series per name it invented. The audit keeps
		// the real name — that is a log, where the exact value is the point.
		const observed = observability(null);
		await observed.start();
		await auditToolCalls(observed, "omp", [{ id: 1, tool: "wharrgarbl", args: {} }]);

		expect(sumCounter(defined(findCounter(observed.snapshot(), METRIC.toolCalls), "toolCalls counter"), { tool: "unrecognized" })).toBe(1);
		expect(observed.audit.recent()[0]?.tool).toBe("wharrgarbl");
	});

	test("the skills proposal door is a known tool and a known route", () => {
		expect(toolLabel("skills_propose")).toBe("skills_propose");
		expect(normalizeRoute("/skills/propose")).toBe("/skills/propose");
		expect(normalizeRoute("/skills/propose/../../etc")).toBe("other");
	});

	test("the skills registry doors are known tools and known routes", () => {
		expect(toolLabel("skills_approve")).toBe("skills_approve");
		expect(toolLabel("skills_list")).toBe("skills_list");
		expect(normalizeRoute("/skills/approve")).toBe("/skills/approve");
		expect(normalizeRoute("/skills")).toBe("/skills");
		expect(normalizeRoute("/skills/approve/../../etc")).toBe("other");
	});

	test("each steering tool is a known tool and keeps its own name as its observe label", () => {
		for (const name of ["steering_queue", "steering_acknowledge", "steering_list"]) {
			expect({ name, label: toolLabel(name) }).toEqual({ name, label: name });
		}
	});

	test("toolLabel keeps the tools that exist", () => {
		expect(toolLabel("graph_claim")).toBe("graph_claim");
		expect(toolLabel("desktop_run")).toBe("desktop_run");
		expect(toolLabel("graph_find")).toBe("graph_find");
		expect(toolLabel("issue_get")).toBe("issue_get");
		expect(toolLabel("docs_search")).toBe("docs_search");
		expect(toolLabel("docs_ingest")).toBe("docs_ingest");
		expect(toolLabel("checkpoint_verify")).toBe("checkpoint_verify");
		expect(toolLabel("memory_verify")).toBe("memory_verify");
		expect(toolLabel("session_checkpoint")).toBe("session_checkpoint");
		expect(toolLabel("session_rollback_plan")).toBe("session_rollback_plan");
		expect(toolLabel("session_rollback_commit")).toBe("session_rollback_commit");
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
			action: "granted",
			reason: "withdrawn",
			quarantineReason: "unrecorded-claim",
		});

		const snapshot = observed.snapshot();
		expect(sumCounter(defined(findCounter(snapshot, METRIC.emitTotal), "emitTotal counter"), { outcome: "stored" })).toBe(1);
		expect(sumCounter(defined(findCounter(snapshot, METRIC.tokens), "tokens counter"), { direction: "input" })).toBe(10);
		expect(sumCounter(defined(findCounter(snapshot, METRIC.claims), "claims counter"), { outcome: "revoked" })).toBe(1);
		expect(sumCounter(defined(findCounter(snapshot, METRIC.quarantines), "quarantines counter"), { reason: "unrecorded-claim" })).toBe(1);
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

describe("claimOutcome", () => {
	test("a takeover of an expired lease is stolen, not granted", () => {
		// `stolen` is the only outcome that increments `substrate.lease.steals`. Reading the
		// verdict alone mapped every takeover to `granted`, so the lease-steal rate the SLO
		// is stated over could not leave zero however many leases were taken — an objective
		// whose numerator cannot move is not one.
		expect(claimOutcome("granted", "stolen")).toBe("stolen");
	});

	test("an ordinary grant, a renewal and a reclaim are granted", () => {
		for (const action of ["granted", "renewed", "reclaimed", undefined]) {
			expect(claimOutcome("granted", action)).toBe("granted");
		}
	});

	test("the verdict wins: a withdrawn steal did not happen, so it is not a steal", () => {
		expect(claimOutcome("revoked", "stolen")).toBe("revoked");
		expect(claimOutcome("contended", "stolen")).toBe("contended");
	});
});

describe("the claim observer", () => {
	test("a steal increments the lease-steal counter the SLO reads", async () => {
		const observed = createObservability(loadConfig({}));
		await observed.start();
		observed.observer.claimed?.({
			surface: "omp",
			graph_id: "ut-1",
			node_id: "n4",
			decision: "granted",
			action: "stolen",
			reason: null,
			quarantineReason: null,
		});

		const snapshot = observed.snapshot();
		expect(sumCounter(defined(findCounter(snapshot, METRIC.leaseSteals), "leaseSteals counter"), {})).toBe(1);
		expect(sumCounter(defined(findCounter(snapshot, METRIC.claims), "claims counter"), { outcome: "stolen" })).toBe(1);
		expect(sumCounter(defined(findCounter(snapshot, METRIC.claims), "claims counter"), { outcome: "granted" })).toBe(0);
		observed.stop();
	});

	test("an ordinary grant does not", async () => {
		const observed = createObservability(loadConfig({}));
		await observed.start();
		observed.observer.claimed?.({
			surface: "omp",
			graph_id: "ut-1",
			node_id: "n4",
			decision: "granted",
			action: "granted",
			reason: null,
			quarantineReason: null,
		});

		expect(sumCounter(defined(findCounter(observed.snapshot(), METRIC.leaseSteals), "leaseSteals counter"), {})).toBe(0);
		observed.stop();
	});
});

describe("a withdrawn claim on the audit chain", () => {
	test("is recorded as denied, so the trail does not read as allowed", async () => {
		// The gate in front of the dispatcher records `graph_claim` as allowed — true of
		// the call. The claim's event then does not reach the ledger and the hold is
		// withdrawn, and nothing wrote that: the audit and the evidence bundle showed the
		// claim allowed and said nothing about the withdrawal, during the one outage this
		// fail-closed behaviour exists for.
		const observed = createObservability(loadConfig({}));
		await observed.start();
		await auditToolCalls(observed, "omp", [{ id: 1, tool: "graph_claim", args: { graph_id: "ut-1", node_id: "n4" } }]);

		await recordClaimWithdrawal(observed.audit, observed.instruments, {
			surface: "omp",
			graph_id: "ut-1",
			node_id: "n4",
			reason: "the claim event did not reach the ledger",
			quarantineReason: "unrecorded-claim",
		});

		const { records } = await observed.audit.readAll();
		expect(records.map((record) => [record.tool, record.decision])).toEqual([
			["graph_claim", "allowed"],
			["graph_claim", "denied"],
		]);
		const withdrawal = defined(records[1]);
		expect(withdrawal.reason).toContain("withdrawn after it was allowed");
		expect(withdrawal.graph_id).toBe("ut-1");
		expect(withdrawal.node_id).toBe("n4");
		expect(withdrawal.transport).toBe("internal");
		// Fail-open: the withdrawal has already happened, and refusing to write it cannot
		// undo it.
		expect(withdrawal.mode).toBe("fail-open");
		expect((await observed.audit.verify()).ok).toBe(true);
		observed.stop();
	});

	test("the observer records it, and a revoked-but-not-withdrawn claim does not", async () => {
		const observed = createObservability(loadConfig({}));
		await observed.start();
		observed.observer.claimed?.({
			surface: "omp",
			graph_id: "ut-1",
			node_id: "n4",
			decision: "contended",
			action: "refused",
			reason: "another surface holds this node",
			quarantineReason: null,
		});
		observed.observer.claimed?.({
			surface: "omp",
			graph_id: "ut-1",
			node_id: "n4",
			decision: "revoked",
			action: "granted",
			reason: "withdrawn",
			quarantineReason: "unrecorded-claim",
		});
		// The observer is synchronous by contract, so the append is fire-and-forget.
		await Bun.sleep(0);

		const { records } = await observed.audit.readAll();
		expect(records).toHaveLength(1);
		expect(records[0]?.decision).toBe("denied");
		observed.stop();
	});

	test("it reaches the graph's evidence bundle beside the allowed record", async () => {
		const observed = createObservability(loadConfig({}));
		await observed.start();
		await auditToolCalls(observed, "omp", [{ id: 1, tool: "graph_claim", args: { graph_id: "ut-1", node_id: "n4" } }]);
		await recordClaimWithdrawal(observed.audit, observed.instruments, {
			surface: "omp",
			graph_id: "ut-1",
			node_id: "n4",
			reason: "the claim event did not reach the ledger",
			quarantineReason: "unrecorded-claim",
		});

		const bundle = await buildGraphEvidence(observed, new Substrate(loadConfig({}), { index: null, greptime: null }), "ut-1");
		expect(bundle.audit.allowed).toBe(1);
		expect(bundle.audit.denied).toBe(1);
		observed.stop();
	});
});

describe("chainState", () => {
	test("tells a chain that could not be verified from one that came back broken", () => {
		// `ok: null` meant both "there is no such chain here" and "the chain exists and the
		// store would not answer", and `substrate evidence` has to exit non-zero on the
		// second and not the first.
		expect(chainState(true)).toBe("verified");
		expect(chainState(false)).toBe("broken");
		expect(chainState(null)).toBe("unverifiable");
	});
});

describe("the evidence bundle's app chain state", () => {
	test("is not-configured when there is no ledger, which is not a failure", async () => {
		const observed = createObservability(loadConfig({}));
		await observed.start();
		const bundle = await buildGraphEvidence(observed, new Substrate(loadConfig({}), { index: null, greptime: null }), "ut-1");

		expect(bundle.chains.app_events.state).toBe("not-configured");
		expect(bundle.chains.app_events.ok).toBeNull();
		observed.stop();
	});

	test("is unverifiable when the ledger is configured and would not answer", async () => {
		const observed = createObservability(loadConfig({}));
		await observed.start();
		const substrate = {
			verifyGraph: () => Promise.reject(new Error("greptime unreachable")),
		} as unknown as Substrate;

		const bundle = await buildGraphEvidence(observed, substrate, "ut-1");
		expect(bundle.chains.app_events.state).toBe("unverifiable");
		expect(bundle.chains.app_events.reason).toContain("greptime unreachable");
		observed.stop();
	});

	test("is verified when the chain checks out", async () => {
		const observed = createObservability(loadConfig({}));
		await observed.start();
		const substrate = {
		verifyGraph: () => Promise.resolve({ ok: true, events: 3, chain: { ok: true }, hours: [], uncovered: { count: 0, ids: [] }, legacy: { count: 0, ids: [] } }),
		} as unknown as Substrate;

		expect((await buildGraphEvidence(observed, substrate, "ut-1")).chains.app_events.state).toBe("verified");
		observed.stop();
	});
});

describe("the evidence bundle reads the audit file once", () => {
	test("and reports the whole file's verdict beside one graph's records", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "substrate-evidence-")), "mcp-audit.jsonl");
		const observed = createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path }));
		await observed.start();
		await auditToolCalls(observed, "omp", [{ id: 1, tool: "graph_get", args: { graph_id: "ut-1" } }]);
		await auditToolCalls(observed, "omp", [{ id: 2, tool: "graph_get", args: { graph_id: "ut-2" } }]);

		const bundle = await buildGraphEvidence(observed, new Substrate(loadConfig({}), { index: null, greptime: null }), "ut-1");
		// The verdict covers the whole file, not just the two records this graph owns one of.
		expect(bundle.chains.mcp_audit.records).toBe(2);
		expect(bundle.audit.records.map((record) => record.graph_id)).toEqual(["ut-1"]);
		expect(bundle.chains.mcp_audit.ok).toBe(true);
		observed.stop();
	});

	test("says so when a graph has more records than a bundle carries", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "substrate-evidence-")), "mcp-audit.jsonl");
		const observed = createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path }));
		await observed.start();
		for (let i = 0; i < 4; i++) {
			await auditToolCalls(observed, "omp", [{ id: i, tool: "graph_get", args: { graph_id: "ut-1" } }]);
		}

		// Through the log directly, so the bound is testable without four thousand appends.
		const view = await observed.audit.verifiedView("ut-1", 2);
		expect(view.records).toHaveLength(2);
		expect(view.total).toBe(4);
		expect(MAX_EVIDENCE_RECORDS).toBeGreaterThan(0);
		observed.stop();
	});

	test("notes a missing-history audit file rather than attesting over it", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "substrate-evidence-")), "mcp-audit.jsonl");
		const first = createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path }));
		await first.start();
		await auditToolCalls(first, "omp", [{ id: 1, tool: "graph_get", args: { graph_id: "ut-1" } }]);
		first.stop();
		rmSync(path);

		const second = createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path }));
		const warnings = await second.start();
		expect(warnings.join(" ")).toContain("missing history");

		const bundle = await buildGraphEvidence(second, new Substrate(loadConfig({}), { index: null, greptime: null }), "ut-1");
		expect(bundle.chains.mcp_audit.ok).toBe(false);
		expect(bundle.notes.join(" ")).toContain("missing history");
		second.stop();
	});
});

describe("audit attribution", () => {
	const secret = `sk-ant-${"a".repeat(30)}`;

	test("an ordinary graph id is attributed exactly", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "substrate-attr-")), "mcp-audit.jsonl");
		const observed = createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path }));
		await observed.start();
		await auditToolCalls(observed, "omp", [{ id: 1, tool: "graph_get", args: { graph_id: "ut-1" } }]);

		const bundle = await buildGraphEvidence(observed, new Substrate(loadConfig({}), { index: null, greptime: null }), "ut-1");
		expect(bundle.audit.attribution).toBe("exact");
		observed.stop();
	});

	test("a graph stored under a cleaned id is ambiguous, not quietly presented as its own", async () => {
		// Two identifiers that clean to the same stored string are indistinguishable once
		// stored, so this selection may hold another graph's decisions and nothing in the file
		// can say which. A bundle labelled for one graph must not present that tally as that
		// graph's — a note saying it might not be is the overstatement this document exists
		// not to make.
		const path = join(mkdtempSync(join(tmpdir(), "substrate-attr-")), "mcp-audit.jsonl");
		const observed = createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path }));
		await observed.start();
		const graphId = `ut-${secret}`;
		await auditToolCalls(observed, "omp", [{ id: 1, tool: "graph_get", args: { graph_id: graphId } }]);

		const bundle = await buildGraphEvidence(observed, new Substrate(loadConfig({}), { index: null, greptime: null }), graphId);
		expect(bundle.audit.attribution).toBe("ambiguous");
		// The records are still there — an investigator needs them — and the note says what
		// they are and names the form in use.
		expect(bundle.audit.total).toBe(1);
		expect(bundle.notes.join(" ")).toContain("stored form");
		// And the document names the graph by its stored key, so the credential the caller put
		// in the identifier is not echoed into an artefact that gets archived and shared.
		expect(bundle.graph_id).toBe("ut-[REDACTED]");
		expect(JSON.stringify(bundle)).not.toContain("sk-ant-");
		observed.stop();
	});
});

describe("the boot warning tells a deleted file from a replaced one", () => {
	test("a truncated file warns about missing history", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "substrate-warn-")), "mcp-audit.jsonl");
		const first = createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path }));
		await first.start();
		await auditToolCalls(first, "omp", [{ id: 1, tool: "graph_get", args: { graph_id: "ut-1" } }]);
		first.stop();
		rmSync(path);

		const warnings = await createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path })).start();
		expect(warnings.join(" ")).toContain("missing history");
		expect(warnings.join(" ")).not.toContain("rewritten");
	});

	test("a replaced file warns about a rewrite, not about a deletion", async () => {
		// The counts are equal in this case, so reporting it as missing history printed two
		// identical numbers and sent the operator after a deletion that did not happen.
		const directory = mkdtempSync(join(tmpdir(), "substrate-warn-"));
		const path = join(directory, "mcp-audit.jsonl");
		const first = createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path }));
		await first.start();
		await auditToolCalls(first, "omp", [{ id: 1, tool: "graph_get", args: { graph_id: "ut-1" } }]);
		first.stop();

		// A different one-record chain, with no checkpoint of its own.
		const other = join(directory, "impostor.jsonl");
		const impostor = new AuditLog({ path: other, checkpointPath: false });
		await impostor.open();
		await impostor.append({ surface: "muse", tool: "graph_get", decision: "allowed", mode: "fail-open" });
		writeFileSync(path, readFileSync(other, "utf8"));

		const warnings = await createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path })).start();
		expect(warnings.join(" ")).toContain("has been rewritten");
		expect(warnings.join(" ")).not.toContain("missing history");
	});
});

describe("no note echoes the identifier the bundle was requested with", () => {
	// A note is bundle content: it lands in the JSON, in the HTML rendered from it, and in
	// whatever archive those end up in. Cleaning `graph_id` and then interpolating the raw
	// identifier into a note puts the credential straight back into the document.
	const graphId = `ut-sk-ant-${"a".repeat(30)}`;

	async function bundleFor(records: Array<Record<string, unknown>>, limit?: number) {
		const path = join(mkdtempSync(join(tmpdir(), "substrate-notes-")), "mcp-audit.jsonl");
		const observed = createObservability(loadConfig({ SUBSTRATE_AUDIT_PATH: path }));
		await observed.start();
		for (const [index, args] of records.entries()) {
			await auditToolCalls(observed, "omp", [{ id: index, tool: "graph_get", args }]);
		}
		const bundle = await buildGraphEvidence(
			observed,
			new Substrate(loadConfig({}), { index: null, greptime: null }),
			graphId,
			[],
			limit,
		);
		observed.stop();
		return bundle;
	}

	test("nor the note for a graph with no records of its own", async () => {
		// `matched === 0 && total > 0`.
		const bundle = await bundleFor([{ graph_id: "ut-other" }]);
		expect(bundle.audit.total).toBe(0);
		expect(bundle.notes.join(" ")).toContain("No MCP audit record names ut-[REDACTED]");
		expect(JSON.stringify(bundle)).not.toContain("sk-ant-");
	});

	test("nor the note for a graph past the listing bound", async () => {
		// `matched > forGraph.length`.
		const bundle = await bundleFor([{ graph_id: graphId }, { graph_id: graphId }, { graph_id: graphId }], 2);
		expect(bundle.audit.records).toHaveLength(2);
		expect(bundle.audit.total).toBe(3);
		expect(bundle.notes.join(" ")).toContain("3 audit records name ut-[REDACTED]");
		expect(JSON.stringify(bundle)).not.toContain("sk-ant-");
	});

	test("and the rendered HTML carries none of it either", async () => {
		const bundle = await bundleFor([{ graph_id: graphId }, { graph_id: graphId }, { graph_id: graphId }], 2);
		expect(renderEvidenceHtml(bundle)).not.toContain("sk-ant-");
	});
});
