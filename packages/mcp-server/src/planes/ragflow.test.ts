/**
 * Plan 25-01 Task 1: the plane client sends explicit dataset ids on every
 * retrieval, clamps page_size, parses both known shapes and never throws on
 * transport failures. The fake fails the anti-pattern (no dataset_ids).
 */
import { describe, expect, test } from "bun:test";
import { listDatasets, ragflowFromEnv, retrieveChunks } from "./ragflow.ts";
import { RagflowFake } from "../ragflow-fake.ts";
const CONFIG = { url: "http://ragflow.test", apiKey: "test-key" };

describe("ragflowFromEnv", () => {
	test("trims values and strips trailing slashes", () => {
		const config = ragflowFromEnv({ RAGFLOW_URL: "http://x:9380/// ", RAGFLOW_API_KEY: " k " });
		expect(config).toEqual({ url: "http://x:9380", apiKey: "k" });
	});

	test("is null unless both values are set", () => {
		expect(ragflowFromEnv({})).toBeNull();
		expect(ragflowFromEnv({ RAGFLOW_URL: "http://x" })).toBeNull();
		expect(ragflowFromEnv({ RAGFLOW_API_KEY: "k" })).toBeNull();
	});

	test("never reads the MCP transport URL", () => {
		expect(ragflowFromEnv({ RAGFLOW_MCP_URL: "http://x/mcp" })).toBeNull();
	});
});

describe("retrieveChunks", () => {
	test("every call carries dataset_ids and clamps page_size to 10", async () => {
		const fake = new RagflowFake();
		const outcome = await retrieveChunks(
			CONFIG,
			{ question: "who reads RAGFlow?", dataset_ids: ["ds-berlin-agent-substrate"], page_size: 12 },
			fake.fetch,
		);
		expect(outcome.ok).toBe(true);
		expect(fake.retrievals()).toHaveLength(1);
		const sent = fake.retrievals()[0];
		if (sent === null || typeof sent !== "object" || !("dataset_ids" in sent) || !("page_size" in sent)) {
			throw new Error("fake did not record the retrieval body");
		}
		expect(sent.dataset_ids).toEqual(["ds-berlin-agent-substrate"]);
		expect(sent.page_size).toBe(10);
	});

	test("parses the full shape with ids and scores", async () => {
		const fake = new RagflowFake();
		const outcome = await retrieveChunks(
			CONFIG,
			{ question: "q", dataset_ids: ["ds-berlin-agent-substrate"] },
			fake.fetch,
		);
		if (!outcome.ok) throw new Error(`expected chunks: ${outcome.reason}`);
		expect(outcome.chunks.length).toBeGreaterThan(0);
		expect(outcome.chunks[0]?.document_id).toBeString();
		expect(outcome.chunks[0]?.chunk_id).toBeString();
	});

	test("parses the minimal shape without ids (U-01 version-swap arm)", async () => {
		const fake = new RagflowFake();
		fake.chunkShape = "minimal";
		const outcome = await retrieveChunks(
			CONFIG,
			{ question: "q", dataset_ids: ["ds-berlin-agent-substrate"] },
			fake.fetch,
		);
		if (!outcome.ok) throw new Error(`expected chunks: ${outcome.reason}`);
		expect(outcome.chunks.length).toBeGreaterThan(0);
		expect(outcome.chunks.every((chunk) => chunk.document_id === undefined)).toBe(true);
	});

	test("maps non-OK and transport failures to reasons, never throws", async () => {
		const failing = new RagflowFake();
		failing.failRetrievalWith = 500;
		const refused = await retrieveChunks(CONFIG, { question: "q", dataset_ids: ["x"] }, failing.fetch);
		expect(refused).toEqual({ ok: false, reason: "ragflow 500" });

		const down = await retrieveChunks(CONFIG, { question: "q", dataset_ids: ["x"] }, async () => {
			throw new Error("connect ECONNREFUSED");
		});
		if (down.ok) throw new Error("expected a reason");
		expect(down.reason).toContain("ragflow unreachable");
	});

	test("throws before any network call when dataset_ids are missing", async () => {
		const fake = new RagflowFake();
		let threw = false;
		try {
			await retrieveChunks(CONFIG, { question: "q", dataset_ids: [] }, fake.fetch);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		expect(fake.requests).toHaveLength(0);
	});

	test("the fake fails a raw retrieval without dataset_ids", async () => {
		const fake = new RagflowFake();
		const response = await fake.fetch("http://ragflow.test/api/v1/retrieval", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "q", page: 1, page_size: 4 }),
		});
		expect(response.status).toBe(400);
	});
});

describe("listDatasets", () => {
	test("discovers the seeded datasets by name", async () => {
		const fake = new RagflowFake();
		const outcome = await listDatasets(CONFIG, fake.fetch);
		if (!outcome.ok) throw new Error(`expected datasets: ${outcome.reason}`);
		expect(outcome.datasets.map((dataset) => dataset.name).sort()).toEqual([
			"agent-skills",
			"agent-substrate",
			"programming-desk",
		]);
	});
});
