/**
 * D25-26 registration tests: docs_search + docs_ingest on every door.
 *
 * Each tool must be registered in mcp.ts, in KNOWN_TOOLS, and as an auditedRest
 * name for its route (both routes in KNOWN_ROUTES); auditMode must be fail-open
 * for search and fail-closed for ingest, explicitly rather than by default; and
 * each search must emit exactly one event whose kind+action matches the Phase 17
 * EVENT_SOURCES rows. The live MCP annotations are asserted here; the tool
 * behaviour behind them lives in mcp.test.ts, server.test.ts and service.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAIL_CLOSED_TOOLS, FAIL_OPEN_TOOLS, auditMode } from "@substrate/audit";
import { loadConfig } from "./config.ts";
import { EVENT_SOURCES } from "./event-sources.ts";
import { createMcpServer } from "./mcp.ts";
import { normalizeRoute, toolLabel } from "./observe.ts";
import { Substrate } from "./service.ts";
import { clearDatasetCache } from "./docs/registry.ts";
import { RagflowError } from "./docs/ragflow.ts";
import type { RagflowDatasetSummary, RagflowDocument, RetrievalHit, UploadFile, UploadedDocument } from "./docs/ragflow.ts";
import type { SubstrateEvent } from "./types.ts";

const SRC = import.meta.dir;

describe("docs doors registration (D25-26)", () => {
	test("both tools are registered in mcp.ts", () => {
		const mcp = readFileSync(join(SRC, "mcp.ts"), "utf8");
		expect(mcp).toMatch(/registerTool\(\s*"docs_search"/);
		expect(mcp).toMatch(/registerTool\(\s*"docs_ingest"/);
	});

	test("both tools are known tools", () => {
		expect(toolLabel("docs_search")).toBe("docs_search");
		expect(toolLabel("docs_ingest")).toBe("docs_ingest");
	});

	test("both routes are audited under their own names and known", () => {
		const server = readFileSync(join(SRC, "server.ts"), "utf8");
		expect(server).toMatch(/auditedRest\(\s*res\s*,\s*observability\s*,\s*surface\s*,\s*"docs_search"\s*,\s*body\s*\)/);
		expect(server).toMatch(/auditedRest\(\s*res\s*,\s*observability\s*,\s*surface\s*,\s*"docs_ingest"\s*,\s*fields\s*\)/);
		expect(normalizeRoute("/docs/search")).toBe("/docs/search");
		expect(normalizeRoute("/docs/ingest")).toBe("/docs/ingest");
	});

	test("audit modes are explicit: search fail-open, ingest fail-closed", () => {
		expect(auditMode("docs_search")).toBe("fail-open");
		expect(FAIL_OPEN_TOOLS.has("docs_search")).toBe(true);
		expect(FAIL_CLOSED_TOOLS.has("docs_search")).toBe(false);
		expect(auditMode("docs_ingest")).toBe("fail-closed");
		expect(FAIL_CLOSED_TOOLS.has("docs_ingest")).toBe(true);
		expect(FAIL_OPEN_TOOLS.has("docs_ingest")).toBe(false);
	});

	test("the MCP annotations mark a read and a non-destructive write", async () => {
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null, ragflow: null });
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const tools = (await client.listTools()).tools;
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		expect(byName.get("docs_search")?.annotations?.readOnlyHint).toBe(true);
		expect(byName.get("docs_search")?.annotations?.openWorldHint).toBe(true);
		expect(byName.get("docs_ingest")?.annotations?.destructiveHint).toBe(false);
		expect(byName.get("docs_ingest")?.annotations?.openWorldHint).toBe(true);
	});
});

describe("docs search events match EVENT_SOURCES (D25-05)", () => {
	class FakeDocs {
		configured = true;
		hits: RetrievalHit[] = [];
		retrievalFailure: unknown;
		docs: RagflowDocument[] = [];
		calls = { retrieval: 0, listDatasets: 0, listDocuments: 0 };

		async retrieval(options: { question: string; datasetIds: string[]; pageSize: number }): Promise<RetrievalHit[]> {
			this.calls.retrieval += 1;
			if (this.retrievalFailure !== undefined) throw this.retrievalFailure;
			return this.hits;
		}

		async listDatasets(): Promise<RagflowDatasetSummary[]> {
			this.calls.listDatasets += 1;
			return [];
		}

		async listDocuments(): Promise<RagflowDocument[]> {
			this.calls.listDocuments += 1;
			return this.docs;
		}

		async uploadDocuments(_datasetId: string, files: UploadFile[]): Promise<UploadedDocument[]> {
			return files.map((file, index) => ({ documentId: `doc-${index}`, name: file.filename }));
		}

		async parseDocuments(): Promise<void> {}

		async updateDocument(): Promise<void> {}

		async deleteDocuments(): Promise<void> {}

		async ensureDataset(name: string): Promise<string> {
			return `ds-${name}`;
		}
	}

	async function searchWorld(fake: FakeDocs) {
		clearDatasetCache();
		const dir = await mkdtemp(join(tmpdir(), "substrate-docs-doors-"));
		const registryFile = join(dir, "datasets.json");
		await writeFile(
			registryFile,
			JSON.stringify([
				{
					name: "guide",
					slug: "example/guide",
					include: ["docs/**"],
					exclude: [],
					trigger: "merge-to-main",
					datasetId: "ds-guide",
				},
			]),
		);
		const emitted: SubstrateEvent[] = [];
		const greptime = {
			ensureAppendMode: async () => true,
			lastHash: async () => null,
			insertEvent: async (event: SubstrateEvent) => {
				emitted.push(event);
			},
		};
		const config = loadConfig({
			SUBSTRATE_DOCS_STATE: join(dir, "state"),
			SUBSTRATE_DOCS_DATASETS: registryFile,
		});
		const substrate = new Substrate(config, { index: null, greptime: greptime as never, ragflow: fake as never });
		return { substrate, emitted };
	}

	// Runtime-assembled fixture host, never a live URL.
	const commit = "a".repeat(40);
	const sourceUrl = "https://" + "github.com/example/guide/blob/" + commit + "/docs/intro.md";

	test("a success note matches the docs.search row", async () => {
		const fake = new FakeDocs();
		fake.hits = [
			{ chunkId: "chunk-1", documentId: "doc-1", datasetId: "ds-guide", content: "sync notes", score: 0.9, documentName: "intro.md", raw: {} },
		];
		fake.docs = [
			{ id: "doc-1", name: "intro.md", run: "DONE", metaFields: { source_url: sourceUrl, title: "Intro", commit }, raw: {} },
		];
		const { substrate, emitted } = await searchWorld(fake);

		await substrate.docsSearch({ query: "how does the sync behave" }, { surface: "claude-code" });

		const row = EVENT_SOURCES.find((entry) => entry.id === "docs.search");
		expect(row?.kind).toBe("note");
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.kind).toBe(row?.kind);
		expect(row?.actions).toContain(String((emitted[0]?.payload as Record<string, unknown>).action));
	});

	test("a failure warning matches the docs.search.failed row", async () => {
		const fake = new FakeDocs();
		fake.retrievalFailure = new RagflowError("ragflow unreachable: connect refused");
		const { substrate, emitted } = await searchWorld(fake);

		await substrate.docsSearch({ query: "how does the sync behave" }, { surface: "claude-code" });

		const row = EVENT_SOURCES.find((entry) => entry.id === "docs.search.failed");
		expect(row?.kind).toBe("warning");
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.kind).toBe(row?.kind);
		expect(row?.actions).toContain(String((emitted[0]?.payload as Record<string, unknown>).action));
	});

	test("the ingest rows exist with the D25-07 writer attribution", () => {
		const ingested = EVENT_SOURCES.find((entry) => entry.id === "docs.ingest");
		expect(ingested?.kind).toBe("note");
		expect(ingested?.actions).toContain("docs.ingest");
		const refused = EVENT_SOURCES.find((entry) => entry.id === "docs.ingest.refused");
		expect(refused?.kind).toBe("warning");
		expect(refused?.actions).toContain("docs.ingest");
	});
});
