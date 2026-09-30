import { describe, expect, test } from "bun:test";
import { buildRecord } from "@substrate/audit";
import { SubstrateInstruments, evaluateSlos } from "@substrate/observability";
import { escapeHtml, renderEvidenceHtml } from "./html.ts";
import { buildEvidence, type EvidenceInput } from "./report.ts";

function input(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
	return {
		graph_id: "ut-abc123-deadbeef",
		generated: new Date("2026-09-30T06:54:39.000Z"),
		service: { name: "substrate-mcp", version: "0.1.0", instance: "vps-1" },
		slos: [],
		appChain: { ok: true, records: 12 },
		audit: { chain: { ok: true, records: 0 }, durable: true, path: "/var/lib/substrate/mcp-audit.jsonl", records: [] },
		...overrides,
	};
}

describe("escapeHtml", () => {
	test("neutralises every character that could close a tag or an attribute", () => {
		expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
			"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
		);
		expect(escapeHtml("it's")).toBe("it&#39;s");
		expect(escapeHtml("a & b")).toBe("a &amp; b");
	});

	test("escapes the ampersand first, so an escape is not double-encoded into nonsense", () => {
		expect(escapeHtml("&lt;")).toBe("&amp;lt;");
	});
});

describe("renderEvidenceHtml", () => {
	test("is one self-contained document with no external fetch", () => {
		// Evidence has to render years from now, from a filesystem, with no network —
		// and a page that fetched anything would also tell someone it had been opened.
		const html = renderEvidenceHtml(buildEvidence(input()));

		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<link\b/i);
		expect(html).not.toMatch(/https?:\/\//);
		expect(html).not.toMatch(/@import/i);
	});

	test("names the graph and the service", () => {
		const html = renderEvidenceHtml(buildEvidence(input()));

		expect(html).toContain("ut-abc123-deadbeef");
		expect(html).toContain("substrate-mcp");
		expect(html).toContain("vps-1");
	});

	test("escapes agent-supplied text everywhere it appears", () => {
		// A graph id, a tool name and a denial reason are all agent-supplied.
		const nasty = '"><img src=x onerror=alert(1)>';
		const record = buildRecord(
			{ surface: nasty, tool: nasty, decision: "denied", mode: "fail-closed", reason: nasty },
			{ seq: 1, prev: null },
			new Date(),
		);
		const html = renderEvidenceHtml(
			buildEvidence(
				input({
					graph_id: nasty,
					audit: { chain: { ok: true, records: 1 }, durable: true, path: nasty, records: [record] },
				}),
			),
		);

		// The payload appears only as inert text: none of its `<`, `>` or `"` survives
		// unescaped, so no tag and no attribute can form from it.
		expect(html).not.toContain("<img");
		expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
		expect(html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g)?.length).toBeGreaterThan(3);
	});

	test("the embedded JSON cannot break out of its <pre>", () => {
		const record = buildRecord(
			{ surface: "omp", tool: "x", decision: "denied", mode: "fail-open", reason: "</pre><script>x</script>" },
			{ seq: 1, prev: null },
			new Date(),
		);
		const html = renderEvidenceHtml(
			buildEvidence(input({ audit: { chain: { ok: true, records: 1 }, durable: true, path: "/x", records: [record] } })),
		);

		expect(html).not.toContain("</pre><script>");
	});

	test("shows the stub warning and the pending list", () => {
		const html = renderEvidenceHtml(buildEvidence(input()));

		expect(html).toContain("This bundle is a stub");
		expect(html).toContain("Merkle anchor");
	});

	test("renders each SLO verdict with its sample count", () => {
		const instruments = new SubstrateInstruments();
		for (let i = 0; i < 30; i++) instruments.recordBrief({ surface: "omp", ok: true, durationMs: 100 });
		const html = renderEvidenceHtml(buildEvidence(input({ slos: evaluateSlos(instruments.snapshot()) })));

		expect(html).toContain("Brief latency");
		expect(html).toContain("pill--ok");
		expect(html).toContain("not enough data");
	});

	test("a broken chain reads as broken, not as a blank", () => {
		const html = renderEvidenceHtml(
			buildEvidence(
				input({
					appChain: { ok: false, records: 4, brokenAt: "evt_abc", reason: "hash does not match contents" },
				}),
			),
		);

		expect(html).toContain("pill--broken");
		expect(html).toContain("evt_abc");
	});

	test("an unverifiable chain is neither intact nor broken", () => {
		const html = renderEvidenceHtml(
			buildEvidence(input({ appChain: { ok: null, records: 0, reason: "greptime not configured" } })),
		);

		expect(html).toContain("pill--unknown");
		expect(html).toContain("greptime not configured");
	});

	test("says plainly when no usage was attributed, rather than showing zeros", () => {
		const html = renderEvidenceHtml(buildEvidence(input()));
		expect(html).toContain("No token or cost usage");
	});

	test("shows usage when there is some", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordEmit({
			surface: "omp",
			graph_id: "ut-abc123-deadbeef",
			kind: "prompt",
			stored: true,
			durationMs: 1,
			payload: { usage: { input_tokens: 12_345, output_tokens: 678, cost_usd: 0.1234 } },
		});
		const html = renderEvidenceHtml(buildEvidence(input({ metrics: instruments.snapshot() })));

		expect(html).toContain("12,345");
		expect(html).toContain("$0.1234");
	});

	test("the machine-readable bundle is embedded, so the document cannot disagree with it", () => {
		const bundle = buildEvidence(input());
		const html = renderEvidenceHtml(bundle);

		expect(html).toContain(escapeHtml(bundle.graph_id));
		expect(html).toContain("substrate.evidence/v0");
	});

	test("omits the denials section when there are none", () => {
		expect(renderEvidenceHtml(buildEvidence(input()))).not.toContain("<h2>Denials</h2>");
	});

	test("renders in light and dark without a theme toggle", () => {
		const html = renderEvidenceHtml(buildEvidence(input()));
		expect(html).toContain("prefers-color-scheme: dark");
		expect(html).toContain("color-scheme: light dark");
	});
});
