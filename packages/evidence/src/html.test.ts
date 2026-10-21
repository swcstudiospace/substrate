import { describe, expect, test } from "bun:test";
import { NO_POSITION, buildRecord } from "@substrate/audit";
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

	test("shows the stub warning", () => {
		const html = renderEvidenceHtml(buildEvidence(input()));

		expect(html).toContain("This bundle is a stub");
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

	test("a break with no locatable position reads as its reason, not as a sentinel", () => {
		// An unparseable line is a real failure whose position is unknowable — the line
		// that would have named it is the one that cannot be parsed. Rendering the
		// sentinel would put "broken at -1" in front of an auditor.
		const html = renderEvidenceHtml(
			buildEvidence(
				input({
					audit: {
						chain: { ok: false, records: 3, brokenAt: NO_POSITION, reason: "2 line(s) could not be parsed", unparseable: 2 },
						durable: true,
						path: "/x",
						records: [],
					},
				}),
			),
		);

		expect(html).toContain("pill--broken");
		expect(html).toContain("2 line(s) could not be parsed");
		expect(html).not.toContain("broken at -1");
		expect(html).not.toContain("broken at ?");
	});

	test("a break that does have a position still names it", () => {
		const html = renderEvidenceHtml(
			buildEvidence(
				input({
					audit: {
						chain: { ok: false, records: 5, brokenAt: 3, reason: "hash does not match contents" },
						durable: true,
						path: "/x",
						records: [],
					},
				}),
			),
		);

		expect(html).toContain("broken at 3");
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

	test("renders each anchored hour with its devnet transaction as an explorer link", () => {
		const html = renderEvidenceHtml(
			buildEvidence(
				input({
					anchors: [
						{
							period_start: "2026-09-01T10:00:00.000Z",
							period_end: "2026-09-01T11:00:00.000Z",
							status: "anchored",
							event_count: 2,
							root: "a".repeat(64),
							tx_sig: "sig-anchored-1",
							slot: 42,
							explorer_url: "https://explorer.solana.com/tx/sig-anchored-1?cluster=devnet",
						},
					],
				}),
			),
		);

		expect(html).toContain("<h2>Anchors</h2>");
		expect(html).toContain("2026-09-01T10:00:00.000Z");
		expect(html).toContain('<span class="pill pill--intact">anchored</span>');
		expect(html).toContain('href="https://explorer.solana.com/tx/sig-anchored-1?cluster=devnet"');
		expect(html).toContain("sig-anchored-1");
	});

	test("renders an unverified hour as broken, with the reason it could not be checked", () => {
		const html = renderEvidenceHtml(
			buildEvidence(
				input({
					anchors: [
						{
							period_start: "2026-09-01T10:00:00.000Z",
							period_end: "2026-09-01T11:00:00.000Z",
							status: "unverified",
							event_count: 2,
							root: "a".repeat(64),
							reason: "transaction not found on devnet",
						},
					],
				}),
			),
		);

		expect(html).toContain('<span class="pill pill--broken">unverified</span>');
		expect(html).toContain("transaction not found on devnet");
	});

	test("renders each teachable with its digest, its hour and that hour's transaction", () => {
		const html = renderEvidenceHtml(
			buildEvidence(
				input({
					teachables: [
						{
							event_id: "evt_teach_1",
							graph_id: "ut-abc123-deadbeef",
							session_id: "sess-teach-1",
							content_sha256: "b".repeat(64),
							hour: "2026-09-01T10:00:00.000Z",
							anchored: true,
							tx_sig: "sig-anchored-1",
							explorer_url: "https://explorer.solana.com/tx/sig-anchored-1?cluster=devnet",
						},
						{
							event_id: "evt_teach_2",
							graph_id: "ut-abc123-deadbeef",
							content_sha256: "c".repeat(64),
							hour: null,
							anchored: false,
						},
					],
				}),
			),
		);

		expect(html).toContain("<h2>Teachable moments</h2>");
		expect(html).toContain("evt_teach_1");
		expect(html).toContain("sess-teach-1");
		expect(html).toContain("b".repeat(64));
		expect(html).toContain('<span class="pill pill--intact">anchored</span>');
		expect(html).toContain('href="https://explorer.solana.com/tx/sig-anchored-1?cluster=devnet"');
		expect(html).toContain("no ingest record");
		expect(html).toContain('<span class="pill pill--unknown">not anchored</span>');
	});
});
