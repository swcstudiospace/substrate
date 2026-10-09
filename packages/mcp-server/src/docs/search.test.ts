/**
 * docs_search core against an in-process fake RAGFlow (D25-01..D25-04).
 * No test performs a real network call: the client below records calls and
 * returns canned hits. Secrets and hostile URLs are runtime-assembled
 * fixtures, and no reply echoes a key, a URL, or a raw body.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { DatasetEntry, DatasetSummary } from "./registry.ts";
import { clearDatasetCache } from "./registry.ts";
import { RagflowError } from "./ragflow.ts";
import type { RagflowDocument, RetrievalHit } from "./ragflow.ts";
import type { RunSearchDeps, SearchRagflow, SearchReason, SourceMeta } from "./search.ts";
import { MAX_SNIPPET_CHARS, SEARCH_NOTICE, runSearch, validateSearchInput } from "./search.ts";

// Inert fixtures assembled at runtime, never credentials or live hosts.
const COMMIT = "a".repeat(40);
const SOURCE_BASE = "https://" + "github.com/example/guide/blob/" + COMMIT + "/docs/";
const PLANTED = "ghp_" + "c".repeat(36);
const HOSTILE_HOST = "evil" + ".example/hook";

const REGISTRY: DatasetEntry[] = [
	{
		name: "guide",
		slug: "example/guide",
		include: ["docs/**"],
		exclude: [],
		trigger: "merge-to-main",
		datasetId: "ds-guide",
	},
	{
		name: "api",
		slug: "example/api",
		include: ["docs/**"],
		exclude: [],
		trigger: "merge-to-main",
		datasetId: "ds-api",
	},
];

interface RetrievalCall {
	question: string;
	datasetIds: string[];
	pageSize: number;
	similarityThreshold?: number;
}

interface FakeState {
	retrievalCalls: RetrievalCall[];
	listCalls: string[];
	listDatasetCalls: number;
	hits: RetrievalHit[];
	failure?: unknown;
	docs: RagflowDocument[];
	docFailure?: unknown;
}

function fakeState(over: Partial<FakeState> = {}): FakeState {
	return { retrievalCalls: [], listCalls: [], listDatasetCalls: 0, hits: [], docs: [], ...over };
}

function fakeClient(state: FakeState, configured = true): SearchRagflow {
	return {
		configured,
		async retrieval(options: RetrievalCall): Promise<RetrievalHit[]> {
			state.retrievalCalls.push({ ...options });
			if (state.failure !== undefined) throw state.failure;
			return state.hits;
		},
		async listDocuments(datasetId: string): Promise<RagflowDocument[]> {
			state.listCalls.push(datasetId);
			if (state.docFailure !== undefined) throw state.docFailure;
			return state.docs;
		},
	};
}

function depsFor(
	state: FakeState,
	over: Partial<RunSearchDeps> & { sources?: Record<string, SourceMeta> } = {},
): RunSearchDeps {
	const { sources, ...rest } = over;
	const client = fakeClient(state);
	return {
		registry: REGISTRY,
		listDatasets: async (): Promise<DatasetSummary[]> => {
			state.listDatasetCalls += 1;
			return [];
		},
		client,
		authenticated: true,
		lookupSource: sources ? (documentId: string) => sources[documentId] : undefined,
		...rest,
	};
}

function hit(over: Partial<RetrievalHit> = {}): RetrievalHit {
	return {
		chunkId: "chunk-1",
		documentId: "doc-1",
		datasetId: "ds-guide",
		content: "how to run the sync",
		score: 0.9,
		documentName: "intro.md",
		raw: {},
		...over,
	};
}

function source(over: Partial<SourceMeta> = {}): SourceMeta {
	return {
		sourceUrl: SOURCE_BASE + "intro.md",
		title: "Intro",
		headingPath: ["Intro", "Sync"],
		commit: COMMIT,
		...over,
	};
}

function doc(over: Partial<RagflowDocument> = {}): RagflowDocument {
	return {
		id: "doc-1",
		name: "intro.md",
		run: "DONE",
		metaFields: {
			source_url: SOURCE_BASE + "intro.md",
			title: "Intro",
			heading_path: ["Intro", "Sync"],
			commit: COMMIT,
		},
		raw: {},
		...over,
	};
}

beforeEach(() => {
	clearDatasetCache();
});

describe("validateSearchInput (D25-01)", () => {
	test("limit boundaries 0/1/10/11", async () => {
		const base = { query: "how?" };
		const at = async (limit: number) =>
			validateSearchInput({ ...base, limit }, { registry: REGISTRY, listDatasets: async () => [] });
		expect((await at(0)).ok).toBe(false);
		expect(await at(0)).toEqual({ ok: false, reason: "invalid-request" });
		expect(await at(1)).toEqual({
			ok: true,
			query: "how?",
			datasetIds: ["ds-guide", "ds-api"],
			limit: 1,
			similarityThreshold: undefined,
		});
		expect(((await at(10)) as { ok: true; limit: number }).limit).toBe(10);
		expect(await at(11)).toEqual({ ok: false, reason: "invalid-request" });
	});

	test("empty and 1001-char queries are invalid", async () => {
		const list = async () => [];
		expect(await validateSearchInput({ query: "" }, { registry: REGISTRY, listDatasets: list })).toEqual({
			ok: false,
			reason: "invalid-request",
		});
		expect(
			await validateSearchInput({ query: "q".repeat(1001) }, { registry: REGISTRY, listDatasets: list }),
		).toEqual({ ok: false, reason: "invalid-request" });
		expect(
			await validateSearchInput({ query: "q".repeat(1000) }, { registry: REGISTRY, listDatasets: list }),
		).toMatchObject({ ok: true });
	});

	test("malformed shapes are invalid-request", async () => {
		const list = async () => [];
		const bad = [
			undefined,
			null,
			"query",
			{},
			{ query: 42 },
			{ query: "ok", datasets: "guide" },
			{ query: "ok", datasets: [] },
			{ query: "ok", datasets: ["guide", 7] },
			{ query: "ok", limit: 2.5 },
			{ query: "ok", limit: Number.NaN },
			{ query: "ok", similarity_threshold: "high" },
			{ query: "ok", similarity_threshold: Number.NaN },
		];
		for (const input of bad) {
			expect(await validateSearchInput(input, { registry: REGISTRY, listDatasets: list })).toEqual({
				ok: false,
				reason: "invalid-request",
			});
		}
	});

	test("unknown names and raw ids resolve to unknown-dataset", async () => {
		const list = async () => [];
		expect(
			await validateSearchInput({ query: "q", datasets: ["nope"] }, { registry: REGISTRY, listDatasets: list }),
		).toEqual({ ok: false, reason: "unknown-dataset" });
		// A same-tenant raw id is not a registry name, so it never widens the search.
		expect(
			await validateSearchInput(
				{ query: "q", datasets: ["ds-guide"] },
				{ registry: REGISTRY, listDatasets: list },
			),
		).toEqual({ ok: false, reason: "unknown-dataset" });
	});

	test("default expansion resolves every id-known registry dataset", async () => {
		const validated = await validateSearchInput({ query: "q" }, { registry: REGISTRY, listDatasets: async () => [] });
		expect(validated).toEqual({
			ok: true,
			query: "q",
			datasetIds: ["ds-guide", "ds-api"],
			limit: 5,
			similarityThreshold: undefined,
		});
	});

	test("a registry with no known ids yields unknown-dataset, never an empty send", async () => {
		const ghost: DatasetEntry[] = [
			{ name: "ghost", slug: "example/ghost", include: ["docs/**"], exclude: [], trigger: "merge-to-main" },
		];
		expect(
			await validateSearchInput({ query: "q" }, { registry: ghost, listDatasets: async () => [] }),
		).toEqual({ ok: false, reason: "unknown-dataset" });
	});
});

describe("runSearch validation short-circuits (D25-01)", () => {
	test("unknown name answers without any RAGFlow call", async () => {
		const state = fakeState();
		const reply = await runSearch({ query: "q", datasets: ["nope"] }, depsFor(state));
		expect(reply).toMatchObject({ untrusted: true, notice: SEARCH_NOTICE, results: [], reason: "unknown-dataset" });
		expect(state.retrievalCalls.length).toBe(0);
		expect(state.listDatasetCalls).toBe(0);
	});

	test("invalid input answers without any RAGFlow call", async () => {
		const state = fakeState();
		const reply = await runSearch({ query: "" }, depsFor(state));
		expect(reply.reason).toBe("invalid-request");
		expect(reply.results).toEqual([]);
		expect(state.retrievalCalls.length).toBe(0);
		expect(state.listDatasetCalls).toBe(0);
	});

	test("explicit names, limit, and threshold reach retrieval scoped and sized", async () => {
		const state = fakeState({ hits: [], docs: [] });
		const reply = await runSearch(
			{ query: "how?", datasets: ["api"], limit: 3, similarity_threshold: 0.7 },
			depsFor(state),
		);
		expect(reply.results).toEqual([]);
		expect("reason" in reply).toBe(false);
		expect(state.retrievalCalls).toEqual([
			{ question: "how?", datasetIds: ["ds-api"], pageSize: 3, similarityThreshold: 0.7 },
		]);
	});

	test("default input searches every id-known dataset with page_size=limit", async () => {
		const state = fakeState();
		await runSearch({ query: "how?" }, depsFor(state));
		expect(state.retrievalCalls).toEqual([
			{ question: "how?", datasetIds: ["ds-guide", "ds-api"], pageSize: 5, similarityThreshold: undefined },
		]);
	});
});

describe("runSearch mapping (D25-02/D25-04)", () => {
	test("a full-field result carries every DOCS-01 field", async () => {
		const state = fakeState({ hits: [hit()] });
		const reply = await runSearch(
			{ query: "sync?" },
			depsFor(state, { sources: { "doc-1": source() } }),
		);
		expect(reply.untrusted).toBe(true);
		expect(reply.notice).toBe(SEARCH_NOTICE);
		expect(reply.results).toEqual([
			{
				title: "Intro",
				source_url: SOURCE_BASE + "intro.md",
				heading_path: ["Intro", "Sync"],
				commit: COMMIT,
				snippet: "how to run the sync",
				score: 0.9,
				ids: { dataset_id: "ds-guide", document_id: "doc-1", chunk_id: "chunk-1" },
			},
		]);
		expect("reason" in reply).toBe(false);
		expect("dropped" in reply).toBe(false);
	});
	test("snippets redact first, then cut to 1200 chars", async () => {
		// Spaces around the secret so the word-anchored rule matches; the
		// secret still straddles the cut boundary.
		const content = "a".repeat(1180) + " " + PLANTED + " " + "b".repeat(200);
		const state = fakeState({ hits: [hit({ content })] });
		const reply = await runSearch(
			{ query: "q" },
			depsFor(state, { sources: { "doc-1": source() } }),
		);
		const snippet = reply.results[0]!.snippet;
		// The planted secret at the cut boundary is redacted whole, never half-echoed.
		expect(snippet).toContain("[REDACTED]");
		expect(snippet).not.toContain("c".repeat(36));
		expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
		expect(snippet.length).toBe(MAX_SNIPPET_CHARS);
	});

	test("sourceless chunks are dropped and counted", async () => {
		const state = fakeState({
			hits: [hit({ chunkId: "chunk-1", documentId: "doc-1" }), hit({ chunkId: "chunk-2", documentId: "doc-x" })],
		});
		const reply = await runSearch(
			{ query: "q" },
			depsFor(state, { sources: { "doc-1": source() } }),
		);
		expect(reply.results.length).toBe(1);
		expect(reply.results[0]!.ids.chunk_id).toBe("chunk-1");
		expect(reply.dropped).toBe(1);
		expect("reason" in reply).toBe(false);
	});

	test("zero-result success carries no reason", async () => {
		const state = fakeState({ hits: [] });
		const reply = await runSearch({ query: "q" }, depsFor(state));
		expect(reply).toEqual({ untrusted: true, notice: SEARCH_NOTICE, results: [] });
	});

	test("the RAGFlow document fallback resolves meta_fields when the manifest misses", async () => {
		const state = fakeState({ hits: [hit()], docs: [doc()] });
		const reply = await runSearch({ query: "q" }, depsFor(state));
		expect(state.listCalls).toEqual(["ds-guide"]);
		expect(reply.results[0]).toMatchObject({
			title: "Intro",
			source_url: SOURCE_BASE + "intro.md",
			heading_path: ["Intro", "Sync"],
			commit: COMMIT,
		});
	});

	test("a failing document fallback drops the chunk instead of failing", async () => {
		const state = fakeState({ hits: [hit()], docFailure: new RagflowError("ragflow error 101: gone") });
		const reply = await runSearch({ query: "q" }, depsFor(state));
		expect(reply.results).toEqual([]);
		expect(reply.dropped).toBe(1);
		expect("reason" in reply).toBe(false);
	});

	test("results are cut to limit", async () => {
		const state = fakeState({
			hits: [
				hit({ chunkId: "c1", documentId: "d1" }),
				hit({ chunkId: "c2", documentId: "d2" }),
				hit({ chunkId: "c3", documentId: "d3" }),
			],
		});
		const reply = await runSearch(
			{ query: "q", limit: 2 },
			depsFor(state, {
				sources: { d1: source(), d2: source(), d3: source() },
				lookupDocument: async () => undefined,
			}),
		);
		expect(reply.results.map((result) => result.ids.chunk_id)).toEqual(["c1", "c2"]);
	});
});

describe("runSearch never throws (D25-03)", () => {
	test("missing or unusable config answers not-configured", async () => {
		const nullState = fakeState();
		const nullDeps = depsFor(nullState, { client: null });
		expect(await runSearch({ query: "q" }, nullDeps)).toMatchObject({
			results: [],
			reason: "not-configured",
		});
		expect(nullState.retrievalCalls.length).toBe(0);

		const offState = fakeState();
		const offDeps = depsFor(offState, { client: fakeClient(offState, false) });
		expect(await runSearch({ query: "q" }, offDeps)).toMatchObject({
			results: [],
			reason: "not-configured",
		});
		expect(offState.retrievalCalls.length).toBe(0);
	});

	test("anonymous callers answer unauthenticated without a RAGFlow call", async () => {
		const state = fakeState({ hits: [hit()] });
		const reply = await runSearch({ query: "q" }, depsFor(state, { authenticated: false }));
		expect(reply).toMatchObject({ results: [], reason: "unauthenticated" });
		expect(state.retrievalCalls.length).toBe(0);
		expect(state.listDatasetCalls).toBe(0);
	});

	test("every failure returns the 200 shape with untrusted and notice", async () => {
		const cases: Array<{ failure: unknown; reason: SearchReason }> = [
			{ failure: new RagflowError("ragflow timeout after 1000ms"), reason: "ragflow-timeout" },
			{ failure: new RagflowError("ragflow unreachable: reset"), reason: "ragflow-unreachable" },
			{ failure: new RagflowError("ragflow error 101: bad"), reason: "ragflow-error" },
			{ failure: new RagflowError("ragflow 503: down"), reason: "ragflow-error" },
			{ failure: new RagflowError("ragflow returned non-JSON"), reason: "ragflow-bad-response" },
			{ failure: new RagflowError("ragflow returned no chunks"), reason: "ragflow-bad-response" },
			{ failure: new Error("plain transport boom"), reason: "ragflow-error" },
		];
		for (const { failure, reason } of cases) {
			const state = fakeState({ failure });
			const reply = await runSearch({ query: "q" }, depsFor(state));
			expect(reply.untrusted).toBe(true);
			expect(reply.notice).toBe(SEARCH_NOTICE);
			expect(reply.results).toEqual([]);
			expect(reply.reason).toBe(reason);
		}
	});

	test("a hostile RAGFlow message is redacted, URL-stripped, and cut to 200 chars", async () => {
		const hostile =
			"leak " + PLANTED + " at " + "http://" + HOSTILE_HOST + " " + "y".repeat(400);
		const state = fakeState({ failure: new Error(hostile) });
		const reply = await runSearch({ query: "q" }, depsFor(state));
		expect(reply.reason).toBe("ragflow-error");
		expect(reply.results).toEqual([]);
		const flat = JSON.stringify(reply);
		expect(flat).not.toContain("c".repeat(36));
		expect(flat).not.toContain("evil");
		expect(flat).not.toContain("http://");
		expect(reply.detail).toBeDefined();
		expect(reply.detail!.length).toBeLessThanOrEqual(200);
	});

	test("a failing dataset list maps to the transport reason instead of throwing", async () => {
		const ghost: DatasetEntry[] = [
			{ name: "ghost", slug: "example/ghost", include: ["docs/**"], exclude: [], trigger: "merge-to-main" },
		];
		const state = fakeState();
		const reply = await runSearch(
			{ query: "q", datasets: ["ghost"] },
			{
				...depsFor(state),
				registry: ghost,
				listDatasets: async () => {
					throw new RagflowError("ragflow timeout after 1000ms");
				},
			},
		);
		expect(reply).toMatchObject({ results: [], reason: "ragflow-timeout" });
	});
});
