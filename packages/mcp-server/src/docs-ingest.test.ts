/**
 * Plan 25-02 Task 1: docs_ingest gates plus hash idempotency against the
 * fake. All six refusals fail closed with locator-only warning events;
 * unchanged hashes skip, changed hashes replace; images strip and count.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import {
	INGEST_PAGE_MAX_BYTES,
	extractPlanningGraphHint,
	ingestDocs,
	isPlanningPage,
	loadIngestRecords,
	nodeIo,
	planningPhaseOf,
	saveIngestRecords,
	scanIngestPages,
	stripRemoteImages,
	type IngestDeps,
	type IngestInput,
	type IngestOutcome,
	type IngestRecord,
	type PageSettlement,
	type ScanIo,
} from "./docs-ingest.ts";
import { createMcpServer } from "./mcp.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import { Substrate } from "./service.ts";
import type { EventInput } from "./types.ts";

const CONFIG = { url: "http://ragflow.test", apiKey: "test-key" };

function harness(
	fake: RagflowFake,
	over: Partial<Pick<IngestDeps, "surface" | "vmGuest" | "roots" | "config" | "seen" | "locks" | "poll">> = {},
) {
	const events: EventInput[] = [];
	const seen = new Map<string, IngestRecord>();
	const deps: IngestDeps = {
		config: CONFIG,
		emit: async (event: EventInput): Promise<unknown> => {
			events.push(event);
			return { stored: false };
		},
		surface: "omp",
		seen,
		poll: { intervalMs: 0 },
		fetchImpl: fake.fetch,
		...over,
	};
	const ingest = (input: IngestInput): Promise<IngestOutcome> => ingestDocs(deps, input);
	return { events, seen, ingest };
}

const PAGE = {
	path: "docs/data-planes.md",
	source_url: "https://example.com/agent-substrate/data-planes",
	body: "The substrate is the only door to the data planes.",
};

describe("docs_ingest gates", () => {
	test("ingests a clean page with metadata and a note event", async () => {
		const fake = new RagflowFake();
		const { events, ingest } = harness(fake);
		const outcome = await ingest({ dataset: "agent-substrate", commit: "abc123", pages: [PAGE] });
		if (!outcome.ok) throw new Error(`expected ingest: ${outcome.reason}`);
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]?.status).toBe("ingested");
		expect(outcome.changed).toBe(true);
		expect(fake.uploads).toHaveLength(1);
		expect(fake.uploads[0]?.metadata).toMatchObject({
			source_url: PAGE.source_url,
			commit: "abc123",
		});
		const notes = events.filter((event) => event.kind === "note");
		expect(notes).toHaveLength(1);
		expect(notes[0]?.payload).toMatchObject({ action: "docs.ingest", dataset_id: "ds-berlin-agent-substrate" });
	});

	test("refuses on a redactor finding and never uploads", async () => {
		const fake = new RagflowFake();
		const { events, ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, body: "paste sk-proj-abcdefghij1234567890 here" }],
		});
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toBe("secret-findings");
		// A refusal that touched nothing is not a state change (Greptile round 2).
		expect(outcome.changed).toBe(false);
		expect(outcome.rules).toContain("openai-proj");
		expect(fake.uploads).toHaveLength(0);
		const warnings = events.filter((event) => event.kind === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.payload).toMatchObject({ action: "docs.ingest", status: "refused" });
		expect(JSON.stringify(warnings[0]?.payload)).not.toContain("sk-proj-");
	});

	test("refuses a page without a source URL", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const outcome = await ingest({ dataset: "agent-substrate", pages: [{ path: PAGE.path, body: PAGE.body }] });
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toBe("no-source-url");
		expect(fake.uploads).toHaveLength(0);
	});

	test("refuses a path outside the configured roots", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, path: "../secrets.txt" }],
		});
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toBe("outside-roots");
		expect(fake.uploads).toHaveLength(0);
	});

	test("refuses a page over 1 MB and a call over 5 MB", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const big = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, body: `x${"y".repeat(1_000_000)}` }],
		});
		if (big.ok) throw new Error("expected a page refusal");
		expect(big.reason).toBe("page-too-large");

		const pages = [1, 2, 3, 4, 5, 6].map((n) => ({ ...PAGE, path: `docs/page-${n}.md`, body: `z${"y".repeat(900_000)}` }));
		const wide = await ingest({ dataset: "agent-substrate", pages });
		if (wide.ok) throw new Error("expected a call refusal");
		expect(wide.reason).toBe("call-too-large");
		expect(fake.uploads).toHaveLength(0);
	});

	test("refuses unauthenticated callers and VM guests before any network call", async () => {
		const anonymous = new RagflowFake();
		const anonymousHarness = harness(anonymous, { surface: null });
		const denied = await anonymousHarness.ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (denied.ok) throw new Error("expected a refusal");
		expect(denied.reason).toBe("unauthenticated");
		expect(anonymous.requests).toHaveLength(0);

		const guest = new RagflowFake();
		const guestHarness = harness(guest, { vmGuest: true });
		const refused = await guestHarness.ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (refused.ok) throw new Error("expected a refusal");
		expect(refused.reason).toBe("vm-guest");
		expect(guest.requests).toHaveLength(0);
	});
});

describe("docs_ingest idempotency and images", () => {
	test("skips unchanged hashes and replaces changed ones", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const again = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!again.ok) throw new Error(`expected skip: ${again.reason}`);
		expect(again.results[0]?.status).toBe("unchanged");
		expect(again.changed).toBe(false);
		expect(fake.uploads).toHaveLength(1);

		const changed = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} More.` }] });
		if (!changed.ok) throw new Error(`expected replace: ${changed.reason}`);
		expect(changed.results[0]?.status).toBe("replaced");
		expect(fake.uploads).toHaveLength(2);
	});

	test("strips remote images pre-upload and counts them", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [
				{
					...PAGE,
					body: 'See <img src="https://example.com/logo.png"> and ![arch](https://example.com/a.png) plus ![local](./b.png).',
				},
			],
		});
		if (!outcome.ok) throw new Error(`expected ingest: ${outcome.reason}`);
		expect(outcome.stripped_images).toBe(2);
		expect(fake.uploads[0]?.content).not.toContain("https://example.com/logo.png");
		expect(fake.uploads[0]?.content).toContain("./b.png");
	});

	test("a parse that never finishes is a timeout refusal", async () => {
		const fake = new RagflowFake();
		fake.parseBehavior = "never";
		const { ingest } = harness(fake);
		const outcome = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (outcome.ok) throw new Error("expected a timeout");
		expect(outcome.reason).toBe("parse-timeout");
	});
});

describe("stripRemoteImages", () => {
	test("counts tags and markdown images, keeps local paths", () => {
		const stripped = stripRemoteImages('A <img src="http://x/y.png"> B ![c](https://x/z.png) D ![e](./f.png)');
		expect(stripped.stripped).toBe(2);
		expect(stripped.body).toContain("./f.png");
	});
});

describe("docs_ingest wiring", () => {
	test("Substrate.ingestDocs ingests and refuses anonymous callers", async () => {
		const fake = new RagflowFake();
		const live = new Substrate(loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }), {
			index: null,
			greptime: null,
			ragflowFetch: fake.fetch,
		});
		const reply = await live.ingestDocs({ dataset: "agent-substrate", pages: [PAGE] }, "omp");
		if (!reply.ok) throw new Error(`expected ingest: ${reply.reason}`);
		expect(reply.results[0]?.status).toBe("ingested");

		const denied = await live.ingestDocs({ dataset: "agent-substrate", pages: [PAGE] }, null);
		if (denied.ok) throw new Error("expected a refusal");
		expect(denied.reason).toBe("unauthenticated");
	});

	test("docs_ingest is callable over MCP and refusals are errors", async () => {
		const fake = new RagflowFake();
		const substrate = new Substrate(loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }), {
			index: null,
			greptime: null,
			ragflowFetch: fake.fetch,
		});
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		try {
			const tools = (await client.listTools()).tools;
			expect(tools.some((tool) => tool.name === "docs_ingest")).toBe(true);
			const result = await client.callTool({ name: "docs_ingest", arguments: { dataset: "agent-substrate", pages: [PAGE] } });
			const content = result.content as Array<{ type: string; text?: string }>;
			const reply: unknown = JSON.parse(content[0]?.text ?? "null");
			const first =
				reply !== null && typeof reply === "object" && "results" in reply && Array.isArray(reply.results)
					? reply.results[0]
					: null;
			const state = first !== null && typeof first === "object" && "status" in first ? first.status : null;
			expect(state).toBe("ingested");

			const refused = await client.callTool({
				name: "docs_ingest",
				arguments: { dataset: "agent-substrate", pages: [{ path: PAGE.path, body: PAGE.body }] },
			});
			expect(refused.isError).toBe(true);
		} finally {
			await client.close();
			await server.close();
		}
	});
});

describe("docs_ingest review hardening", () => {
	test("refuses a secret smuggled in the heading metadata", async () => {
		const fake = new RagflowFake();
		const { events, ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, heading_path: "sk-proj-abcdefghij1234567890" }],
		});
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toBe("secret-findings");
		expect(outcome.rules).toContain("openai-proj");
		expect(fake.uploads).toHaveLength(0);
		expect(JSON.stringify(events)).not.toContain("sk-proj-");
	});

	test("refuses dot-segment escapes and out-of-roots real paths", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const escaped = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, path: "docs/../private.md" }] });
		if (escaped.ok) throw new Error("expected a refusal");
		expect(escaped.reason).toBe("outside-roots");
		const linked = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, real_path: "../elsewhere.md" }],
		});
		if (linked.ok) throw new Error("expected a refusal");
		expect(linked.reason).toBe("outside-roots");
		expect(fake.uploads).toHaveLength(0);
	});

	test("refuses a secret in graph strings on the LightRAG path before any upload", async () => {
		const fake = new RagflowFake();
		const events: EventInput[] = [];
		const outcome = await ingestDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: { url: "http://lightrag.test" },
				lightragDatasets: { list: async () => ({ ok: true, datasets: [{ id: "agent-substrate", name: "agent-substrate" }] }), invalidate: () => undefined },
				lightragFetch: fake.fetch,
				seen: new Map<string, IngestRecord>(),
				poll: { intervalMs: 0 },
				emit: async (event: EventInput): Promise<unknown> => {
					events.push(event);
					return { stored: false };
				},
				surface: "omp",
			},
			{ dataset: "agent-substrate", pages: [{ ...PAGE, graph: { phase: "docs", entities: ["sk-proj-abcdefghij1234567890"], relations: [] } }] },
		);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toMatch(/^secret-findings/);
		expect(fake.uploads).toHaveLength(0);
		expect(JSON.stringify(events)).not.toContain("sk-proj-");
	});

	test("keys records by dataset so a second dataset ingests and the first still skips", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const other = await ingest({ dataset: "programming-desk", pages: [PAGE] });
		if (!other.ok) throw new Error(`expected ingest: ${other.reason}`);
		expect(other.results[0]?.status).toBe("ingested");
		const again = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!again.ok) throw new Error(`expected skip: ${again.reason}`);
		expect(again.results[0]?.status).toBe("unchanged");
		expect(fake.uploads).toHaveLength(2);
	});

	test("concurrent retries for one page share a single upload", async () => {
		const fake = new RagflowFake();
		const locks = new Map<string, { task: Promise<PageSettlement>; sha: string }>();
		const left = harness(fake, { locks, poll: { intervalMs: 0 } });
		const right = harness(fake, { locks, seen: left.seen, poll: { intervalMs: 0 } });
		const [a, b] = await Promise.all([
			left.ingest({ dataset: "agent-substrate", pages: [PAGE] }),
			right.ingest({ dataset: "agent-substrate", pages: [PAGE] }),
		]);
		if (!a.ok || !b.ok) throw new Error("expected both to settle");
		expect(fake.uploads).toHaveLength(1);
		expect(a.results[0]?.document_id).toBe(b.results[0]?.document_id);
	});

	test("a concurrent retry with different content uploads its own page", async () => {
		const fake = new RagflowFake();
		const locks = new Map<string, { task: Promise<PageSettlement>; sha: string }>();
		const left = harness(fake, { locks, poll: { intervalMs: 0 } });
		const right = harness(fake, { locks, seen: left.seen, poll: { intervalMs: 0 } });
		const [a, b] = await Promise.all([
			left.ingest({ dataset: "agent-substrate", pages: [PAGE] }),
			right.ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} Newer.` }] }),
		]);
		if (!a.ok || !b.ok) throw new Error("expected both to settle");
		expect(fake.uploads).toHaveLength(2);
		expect(a.results[0]?.status).toBe("ingested");
		expect(b.results[0]?.status).toBe("replaced");
		expect(b.results[0]?.superseded_document_id).toBe(a.results[0]?.document_id);
	});

	test("a replacement reports the superseded document id", async () => {
		const fake = new RagflowFake();
		const { events, ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const changed = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} More.` }] });
		if (!changed.ok) throw new Error(`expected replace: ${changed.reason}`);
		expect(changed.results[0]?.status).toBe("replaced");
		expect(changed.results[0]?.superseded_document_id).toBe(first.results[0]?.document_id);
		const notes = events.filter((event) => event.kind === "note");
		const payload = notes[notes.length - 1]?.payload ?? {};
		expect(payload.superseded_document_ids).toEqual([first.results[0]?.document_id]);
	});
});

describe("ingest record persistence", () => {
	test("records round-trip through the state file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-docs-state-"));
		try {
			const file = join(dir, "ingest.json");
			const seen = new Map<string, IngestRecord>([
				["ds-1::https://example.com/a", { sha: "s1", dataset_id: "ds-1", source_url: "https://example.com/a", document_id: "doc-1" }],
			]);
			await saveIngestRecords(file, seen);
			const loaded = await loadIngestRecords(file);
			expect(loaded.problem).toBeUndefined();
			expect(loaded.records.get("ds-1::https://example.com/a")?.document_id).toBe("doc-1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing or corrupt file means an empty map, never a throw", async () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-docs-state-"));
		try {
			const missing = await loadIngestRecords(join(dir, "absent.json"));
			expect(missing.records.size).toBe(0);
			expect(missing.problem).toBeUndefined();
			const corrupt = join(dir, "corrupt.json");
			writeFileSync(corrupt, "not json{{{");
			const loaded = await loadIngestRecords(corrupt);
			expect(loaded.records.size).toBe(0);
			expect(typeof loaded.problem).toBe("string");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a restarted server skips pages its state file already records", async () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-docs-state-"));
		try {
			const file = join(dir, "ingest.json");
			const env = { RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", SUBSTRATE_DOCS_STATE_FILE: file };
			const fake = new RagflowFake();
			const first = new Substrate(loadConfig(env), { index: null, greptime: null, ragflowFetch: fake.fetch });
			const ingested = await first.ingestDocs({ dataset: "agent-substrate", pages: [PAGE] }, "omp");
			if (!ingested.ok) throw new Error(`expected ingest: ${ingested.reason}`);
			const second = new Substrate(loadConfig(env), { index: null, greptime: null, ragflowFetch: fake.fetch });
			const skipped = await second.ingestDocs({ dataset: "agent-substrate", pages: [PAGE] }, "omp");
			if (!skipped.ok) throw new Error(`expected skip: ${skipped.reason}`);
			expect(skipped.results[0]?.status).toBe("unchanged");
			expect(fake.uploads).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("scanIngestPages", () => {
	test("an oversize page is stat-checked, never read, and counted only by its absence", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-scan-size-"));
		try {
			mkdirSync(join(root, "docs"), { recursive: true });
			writeFileSync(join(root, "docs", "huge.md"), "x".repeat(INGEST_PAGE_MAX_BYTES + 1));
			writeFileSync(join(root, "docs", "small.md"), "small enough");
			// The fs stub records every read the sweep makes, so the proof that
			// the cap applies before any read is that the oversize file's path
			// never appears in it.
			const reads: string[] = [];
			const io: ScanIo = {
				...nodeIo,
				readFile: (path, options) => {
					reads.push(String(path));
					return nodeIo.readFile(path, options);
				},
			};
			const pages = await scanIngestPages(root, ["docs/"], io);
			expect(pages.map((page) => page.path)).toEqual(["docs/small.md"]);
			expect(reads.some((path) => path.endsWith("huge.md"))).toBe(false);
			// A sweep of only oversize files comes back empty, which the guarded
			// ingest refuses as no-pages.
			expect(await scanIngestPages(root, ["docs/huge.md"], io)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a root that is itself a link is skipped, never followed", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-scan-root-"));
		const outside = mkdtempSync(join(tmpdir(), "substrate-scan-out-"));
		try {
			writeFileSync(join(outside, "secret.md"), "outside the checkout");
			mkdirSync(join(root, "docs"), { recursive: true });
			writeFileSync(join(root, "docs", "real.md"), "inside");
			// Links used AS roots — a file link, a directory link bare, and the
			// same directory link in sweep form — are skipped exactly like links
			// found inside the sweep: a link can point outside the checkout, and
			// the roots guards have no real path to check it against.
			symlinkSync(join(outside, "secret.md"), join(root, "linked.md"));
			symlinkSync(join(root, "docs"), join(root, "linked-dir"));
			const pages = await scanIngestPages(root, ["linked.md", "linked-dir", "linked-dir/", "docs/"]);
			expect(pages.map((page) => page.path)).toEqual(["docs/real.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("planning scan graph hints (LightRAG path)", () => {
	test("isPlanningPage admits only .planning markdown", () => {
		expect(isPlanningPage(".planning/PROJECT.md")).toBe(true);
		expect(isPlanningPage(".planning/phases/25-x/PLAN.md")).toBe(true);
		expect(isPlanningPage("docs/data-planes.md")).toBe(false);
		expect(isPlanningPage(".planning/diagram.png")).toBe(false);
		expect(isPlanningPage(".planning/../docs/escape.md")).toBe(false);
	});

	test("planningPhaseOf names the phase directory, else the planning path", () => {
		expect(planningPhaseOf(".planning/phases/25-x/PLAN.md")).toBe("25-x");
		expect(planningPhaseOf(".planning/PROJECT.md")).toBe("PROJECT");
		expect(planningPhaseOf("docs/data-planes.md")).toBe("docs/data-planes");
	});

	test("headings become entities with parent-child contains relations", () => {
		const hint = extractPlanningGraphHint(".planning/phases/25-x/PLAN.md", "# Phase plan\n\n## Access path\n");
		expect(hint?.phase).toBe("25-x");
		expect(hint?.entities).toEqual(["Phase plan", "Access path"]);
		expect(hint?.relations).toEqual([{ source: "Phase plan", target: "Access path", kind: "contains" }]);
	});

	test("markdown links become links-to from the enclosing heading, targets verbatim", () => {
		const hint = extractPlanningGraphHint(
			".planning/phases/25-x/PLAN.md",
			"# Phase plan\n\nImplements the [retriever](../docs/data-planes.md) for the phase.\n\n## Access path\n",
		);
		expect(hint?.relations).toEqual([
			{ source: "Phase plan", target: "Access path", kind: "contains" },
			{ source: "Phase plan", target: "../docs/data-planes.md", kind: "links-to" },
		]);
	});

	test("non-planning pages yield no hint; heading-less planning pages yield empty lists", () => {
		expect(extractPlanningGraphHint("docs/data-planes.md", "# Heading\n")).toBeUndefined();
		expect(extractPlanningGraphHint(".planning/note.md", "Just prose with a [link](target.md).\n")).toEqual({
			phase: "note",
			entities: [],
			relations: [{ source: "note", target: "target.md", kind: "links-to" }],
		});
	});

	test("fences and frontmatter contribute nothing; images and duplicate headings are skipped", () => {
		const hint = extractPlanningGraphHint(
			".planning/PROJECT.md",
			"---\ntitle: sample\n---\n\n```\n# Not a heading\n```\n\n# Real\n\n![diagram](img.png)\n\n# Real\n",
		);
		expect(hint?.entities).toEqual(["Real"]);
		expect(hint?.relations).toEqual([]);
	});

	test("scanIngestPages attaches graph hints to planning pages only", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-scan-graph-"));
		try {
			mkdirSync(join(root, ".planning", "phase-a"), { recursive: true });
			mkdirSync(join(root, "docs"), { recursive: true });
			writeFileSync(join(root, ".planning", "phase-a", "PLAN.md"), "# Phase A\n\nImplements the [retriever](../docs/data-planes.md).\n");
			writeFileSync(join(root, "docs", "small.md"), "# Small\n");
			const pages = await scanIngestPages(root, ["docs/", ".planning/"]);
			expect(pages.map((page) => page.path).sort()).toEqual([".planning/phase-a/PLAN.md", "docs/small.md"]);
			const planning = pages.find((page) => page.path === ".planning/phase-a/PLAN.md");
			expect(planning?.graph).toEqual({
				phase: "phase-a",
				entities: ["Phase A"],
				relations: [{ source: "Phase A", target: "../docs/data-planes.md", kind: "links-to" }],
			});
			const docs = pages.find((page) => page.path === "docs/small.md");
			expect(docs).toBeDefined();
			expect("graph" in (docs as object)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an oversize planning file is stat-checked, never read, and yields no hint", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-scan-graph-size-"));
		try {
			mkdirSync(join(root, ".planning"), { recursive: true });
			writeFileSync(join(root, ".planning", "huge.md"), "x".repeat(INGEST_PAGE_MAX_BYTES + 1));
			const reads: string[] = [];
			const io: ScanIo = {
				...nodeIo,
				readFile: (path, options) => {
					reads.push(String(path));
					return nodeIo.readFile(path, options);
				},
			};
			const pages = await scanIngestPages(root, [".planning/"], io);
			expect(pages).toEqual([]);
			expect(reads.some((path) => path.endsWith("huge.md"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("ingest accepts call-level graphHints on the RAGFlow path unchanged", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			commit: "abc123",
			pages: [PAGE],
			graphHints: [{ phase: "test", entities: ["substrate"], relations: [] }],
		});
		if (!outcome.ok) throw new Error(`expected ingest: ${outcome.reason}`);
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]?.status).toBe("ingested");
		expect(fake.uploads).toHaveLength(1);
	});
});
