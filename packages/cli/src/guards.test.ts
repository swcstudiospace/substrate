import { describe, expect, test } from "bun:test";
import { renderEvidenceHtml, type EvidenceBundle } from "@substrate/evidence";
import { driftExitCode, isRecord, parseEmitPayload, parseEvidenceBundle } from "./guards.ts";

/** A complete bundle in the shape `substrate-mcp` composes, with every optional section present. */
function bundle(): EvidenceBundle {
	return {
		schema: "substrate.evidence/v0",
		stub: true,
		graph_id: "ut-guards-1",
		generated: "2026-10-01T10:00:00.000Z",
		service: { name: "substrate-mcp", version: "0.1.0", instance: "test" },
		chains: {
			app_events: { ok: true, state: "verified", records: 4 },
			mcp_audit: { ok: true, state: "verified", records: 2, durable: true, path: "/var/audit.jsonl", unparseable: 0 },
		},
		slos: [
			{
				id: "slo-1",
				title: "Event latency",
				statement: "p95 <= 800 ms",
				status: "ok",
				observed: 120,
				unit: "ms",
				target: 800,
				samples: 40,
				detail: "met",
			},
		],
		slo_summary: { ok: 1, breached: 0, insufficient: 0, unmeasurable: 0 },
		audit: {
			total: 2,
			allowed: 1,
			denied: 1,
			byTool: [{ tool: "events_emit", allowed: 1, denied: 1 }],
			bySurface: [{ surface: "claude-code", allowed: 1, denied: 1 }],
			attribution: "exact",
			records: [
				{
					seq: 1,
					ts: "2026-10-01T10:00:01.000Z",
					surface: "claude-code",
					tool: "events_emit",
					transport: "mcp",
					decision: "denied",
					mode: "fail-open",
					reason: "rbac.no-grant",
					graph_id: "ut-guards-1",
					node_id: null,
					session_id: null,
					actor: null,
					arg_keys: [],
					arg_digest: null,
					hash: "h1",
					prev: null,
				},
			],
		},
		usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.5 },
		anchors: [
			{
				period_start: "2026-10-01T10:00:00.000Z",
				period_end: "2026-10-01T11:00:00.000Z",
				status: "anchored",
				event_count: 3,
				root: "abc",
				tx_sig: "sig-1",
				explorer_url: "https://explorer.solana.com/tx/sig-1?cluster=devnet",
			},
		],
		teachables: [
			{
				event_id: "evt-1",
				graph_id: "ut-guards-1",
				content_sha256: "f".repeat(64),
				hour: "2026-10-01T10:00:00.000Z",
				anchored: true,
				tx_sig: "sig-1",
				explorer_url: "https://explorer.solana.com/tx/sig-1?cluster=devnet",
			},
		],
		pending: ["per-node cross-check"],
		notes: ["a note"],
	};
}

const REMOVE = Symbol("remove");

function child(node: unknown, key: string): Record<string, unknown> {
	if (typeof node !== "object" || node === null) throw new Error(`no ${key} under a non-object`);
	return node as Record<string, unknown>;
}

/**
 * The bundle as the server sends it, with each `[path, value]` edit applied to the parsed JSON before it is
 * stringified again. A path is dot-separated (`slos.0.samples`); the value `REMOVE` deletes the key.
 */
function bodyWith(...edits: Array<[string, unknown]>): string {
	const root: unknown = JSON.parse(JSON.stringify(bundle()));
	for (const [path, value] of edits) {
		const keys = path.split(".");
		const last = keys.pop();
		if (last === undefined) throw new Error("empty edit path");
		let node: unknown = root;
		for (const key of keys) node = child(node, key)[key];
		const holder = child(node, last);
		if (value === REMOVE) delete holder[last];
		else holder[last] = value;
	}
	return JSON.stringify(root);
}

function malformed(body: string): string {
	const parsed = parseEvidenceBundle(body);
	if (parsed.ok || parsed.reason !== "malformed") throw new Error(`expected a malformed bundle, got ${JSON.stringify(parsed)}`);
	return parsed.detail;
}

describe("isRecord", () => {
	test("accepts a plain object and refuses null, lists and primitives", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ a: 1 })).toBe(true);
		for (const value of [null, undefined, [], [1], "x", 3, true]) expect(isRecord(value)).toBe(false);
	});
});

describe("parseEmitPayload", () => {
	test("a JSON object is the payload, unchanged", () => {
		expect(parseEmitPayload('{"a":1,"b":{"c":[2]}}')).toEqual({ kind: "ok", payload: { a: 1, b: { c: [2] } } });
		expect(parseEmitPayload("{}")).toEqual({ kind: "ok", payload: {} });
	});

	test("text that is not JSON is reported as such", () => {
		expect(parseEmitPayload("{nope")).toEqual({ kind: "invalid-json" });
	});

	test("JSON that is not an object is refused, not passed through as a payload", () => {
		for (const raw of ["[1,2]", "null", "42", '"text"', "true"]) expect(parseEmitPayload(raw)).toEqual({ kind: "not-object" });
	});
});

describe("driftExitCode", () => {
	test("a clean report exits 0, whether it says ok or lists no findings", () => {
		expect(driftExitCode(JSON.stringify({ ok: true, findings: [] }))).toBe(0);
		expect(driftExitCode(JSON.stringify({ ok: true }))).toBe(0);
		expect(driftExitCode(JSON.stringify({ ok: false, findings: [] }))).toBe(0);
	});

	test("a report with findings exits 1", () => {
		expect(driftExitCode(JSON.stringify({ ok: false, findings: [{ kind: "lease.expired" }] }))).toBe(1);
	});

	test("a body that is not a drift report is not a clean scan", () => {
		for (const body of ["not json", "null", "[]", "7", "{}", JSON.stringify({ ok: "yes" }), JSON.stringify({ findings: "none" })]) {
			expect(driftExitCode(body)).toBe(1);
		}
	});
});

describe("parseEvidenceBundle", () => {
	test("a complete bundle parses to itself, and renders the same as the original", () => {
		const original = bundle();
		const parsed = parseEvidenceBundle(JSON.stringify(original));
		if (!parsed.ok) throw new Error(`rejected a valid bundle: ${JSON.stringify(parsed)}`);
		expect(parsed.bundle).toEqual(original);
		expect(renderEvidenceHtml(parsed.bundle)).toBe(renderEvidenceHtml(original));
	});

	test("the optional sections may be absent", () => {
		const parsed = parseEvidenceBundle(
			bodyWith(["anchors", REMOVE], ["teachables", REMOVE], ["usage", REMOVE], ["audit.attribution", REMOVE]),
		);
		expect(parsed.ok).toBe(true);
	});

	test("an older chain without `state` and a null usage are accepted", () => {
		const parsed = parseEvidenceBundle(
			bodyWith(["chains.app_events.state", REMOVE], ["chains.app_events.ok", null], ["usage", null]),
		);
		expect(parsed.ok).toBe(true);
	});

	test("a node member is carried beside the bundle, whether an artifact or an error", () => {
		const artifact = {
			node_id: "n1",
			claim: [{ ts: null, action: "granted" }],
			linear: [{ ts: "t", op: "relate", status: "ok", reason: null, blocker_node: "n0", edge_kind: "blocks" }],
			notion: [{ ts: "t", op: "page", status: "failed", reason: "rate-limited" }],
			dod: [{ ts: "t", status: "refused", reason: "dod-refused" }],
		};
		const withArtifact = parseEvidenceBundle(bodyWith(["node", artifact]));
		if (!withArtifact.ok) throw new Error(`rejected a valid node: ${JSON.stringify(withArtifact)}`);
		expect<unknown>(withArtifact.node).toEqual(artifact);
		const withError = parseEvidenceBundle(bodyWith(["node", { error: "GREPTIME_URL is not set" }]));
		if (!withError.ok) throw new Error(`rejected a node error: ${JSON.stringify(withError)}`);
		expect(withError.node).toEqual({ error: "GREPTIME_URL is not set" });
		const without = parseEvidenceBundle(bodyWith());
		if (!without.ok) throw new Error("rejected a bundle without a node");
		expect(without.node).toBeUndefined();
	});

	test("a node member of the wrong shape is malformed and names the field", () => {
		expect(malformed(bodyWith(["node", "n1"]))).toBe("bundle.node must be an object");
		expect(malformed(bodyWith(["node", { error: 7 }]))).toBe("bundle.node.error must be a string");
		expect(malformed(bodyWith(["node", { node_id: "n1", claim: "x", linear: [], notion: [], dod: [] }]))).toBe(
			"bundle.node.claim must be a list",
		);
		expect(
			malformed(bodyWith(["node", { node_id: "n1", claim: [], linear: [], notion: [], dod: [{ ts: null, status: "maybe", reason: null }] }])),
		).toBe("bundle.node.dod[0].status must be one of approved, refused, warning");
	});

	test("text that is not JSON takes the invalid-json path", () => {
		expect(parseEvidenceBundle("<html>502</html>")).toEqual({ ok: false, reason: "invalid-json" });
	});

	test("JSON that is not an object is malformed", () => {
		for (const body of ["null", "[]", "5", '"bundle"']) expect(malformed(body)).toBe("bundle must be an object");
	});

	test("a missing or mistyped section names the field", () => {
		expect(malformed(bodyWith(["chains", REMOVE]))).toBe("bundle.chains must be an object");
		expect(malformed(bodyWith(["chains.mcp_audit", REMOVE]))).toBe("bundle.chains.mcp_audit must be an object");
		expect(malformed(bodyWith(["slos", "none"]))).toBe("bundle.slos must be a list");
		expect(malformed(bodyWith(["graph_id", 7]))).toBe("bundle.graph_id must be a string");
		expect(malformed(bodyWith(["pending", [1]]))).toBe("bundle.pending[0] must be a string");
		expect(malformed(bodyWith(["anchors", {}]))).toBe("bundle.anchors must be a list");
	});

	test("a number the HTML writes unescaped has to be a number", () => {
		expect(malformed(bodyWith(["slos.0.samples", "<script>alert(1)</script>"]))).toBe("bundle.slos[0].samples must be a finite number");
		expect(malformed(bodyWith(["audit.byTool.0.denied", "1<b>"]))).toBe("bundle.audit.byTool[0].denied must be a finite number");
		expect(malformed(bodyWith(["anchors.0.event_count", null]))).toBe("bundle.anchors[0].event_count must be a finite number");
		expect(malformed(bodyWith(["slo_summary.breached", "0"]))).toBe("bundle.slo_summary.breached must be a finite number");
		expect(malformed(bodyWith(["audit.records.0.seq", "1"]))).toBe("bundle.audit.records[0].seq must be a finite number");
		expect(malformed(bodyWith(["usage.costUsd", "free"]))).toBe("bundle.usage.costUsd must be a finite number");
	});

	test("a value that becomes a CSS class or an href is constrained", () => {
		expect(malformed(bodyWith(["slos.0.status", 'ok"><script>']))).toContain("bundle.slos[0].status must be one of");
		expect(malformed(bodyWith(["anchors.0.status", "done"]))).toContain("bundle.anchors[0].status must be one of");
		expect(malformed(bodyWith(["anchors.0.explorer_url", "javascript:alert(1)"]))).toBe("bundle.anchors[0].explorer_url must be an http(s) URL");
		expect(malformed(bodyWith(["teachables.0.explorer_url", "data:text/html,x"]))).toBe("bundle.teachables[0].explorer_url must be an http(s) URL");
		expect(malformed(bodyWith(["chains.app_events.state", "fine"]))).toContain("bundle.chains.app_events.state must be one of");
		expect(malformed(bodyWith(["audit.attribution", "maybe"]))).toContain("bundle.audit.attribution must be one of");
	});
});
