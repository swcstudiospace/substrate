/**
 * The docs learning loop on the `docs_search` path (v1.7 phase 66), through `Substrate` with a fake LightRAG `/query`, a fake
 * corpus manifest and a fake telemetry store: the authority re-rank (`SUBSTRATE_DOCS_RERANK=off|shadow|on`) and the retrieval
 * telemetry (`SUBSTRATE_DOCS_TELEMETRY`). What matters here is the seam between the answer and the learning loop: a switched-off
 * loop changes no byte of an answer, and a loop that fails or stalls never costs a search anything.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { corpusDocumentName, documentKey } from "@substrate/corpus";
import { loadConfig } from "./config.ts";
import { RETRIEVAL_MAX_RETURNED, RETRIEVAL_QUERY_TEXT_CHARS, RETRIEVAL_SWEEP_BATCH, type RetrievalRow } from "./corpus/reflect-store.ts";
import { FakeReflectStore } from "./corpus/reflect-testkit.ts";
import type { ManifestRow } from "./corpus/store.ts";
import { FakeStore, makeRow, sha256Hex } from "./corpus/testkit.ts";
import type { SearchReply } from "./docs-search.ts";
import type { FetchLike } from "./planes/ragflow.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";

const REPO = "swcstudiospace/agent-substrate";
const QUESTION = "Where is the Data Plane described?";
const LIGHTRAG = { LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_DOCS_BACKEND: "lightrag", SUBSTRATE_CORPUS: "on" };

interface PlaneChunk {
	content: string;
	document_name: string;
	source_url: string;
	score: number;
	document_id?: string;
}

/** A corpus document as LightRAG reports it: its file path is the corpus document name, which the citation turns into `repo:path`. */
function corpusChunk(path: string, score: number): PlaneChunk {
	const name = corpusDocumentName(REPO, path, sha256Hex(path));
	return { content: `Body of ${path}.`, document_name: name, source_url: name, score };
}

/** Any other LightRAG result: no corpus name, so the re-rank must leave it where it is. */
function plainChunk(name: string, score: number): PlaneChunk {
	return { content: `Notes in ${name}.`, document_name: name, document_id: `doc-${name}`, source_url: `https://example.com/${name}`, score };
}

/** The plane answer that every test of the re-rank reads. Scores fall with the position, which is the order the plane gives. */
const MIXED: PlaneChunk[] = [
	plainChunk("plan.md", 0.95),
	corpusChunk("docs/b.md", 0.9),
	corpusChunk("docs/c.md", 0.8),
	corpusChunk("docs/old.md", 0.7),
	corpusChunk("docs/new.md", 0.6),
	plainChunk("notes.md", 0.5),
];

/**
 * Four tier-1/3 documents, one superseded: with every document freshly ingested and unrated, authority is 0.81 for tier 1 and
 * 0.565 for tier 3, times 0.4 when superseded. The factor `0.5 + 0.5 * authority` then gives c 0.8 * 0.905 = 0.724 above
 * b 0.9 * 0.7825 = 0.704 above new 0.6 * 0.905 = 0.543 above old 0.7 * 0.662 = 0.463.
 */
function seedManifest(store: FakeStore): void {
	const ingestedAt = new Date().toISOString();
	const seed = (path: string, over: Partial<ManifestRow> = {}): void => store.seed(makeRow({ repo: REPO, path, sha256: sha256Hex(path), ingestedAt, ...over }));
	seed("docs/b.md", { tier: 3 });
	seed("docs/c.md");
	seed("docs/old.md", { supersededBy: "docs/new.md" });
	seed("docs/new.md");
	seed("docs/t1.md");
	seed("docs/t2.md");
}

interface World {
	substrate: Substrate;
	reflect: FakeReflectStore;
	queries: string[];
	clock: { now: number };
}

function world(env: Record<string, string>, answer: PlaneChunk[], options: { reflect?: FakeReflectStore | null } = {}): World {
	const queries: string[] = [];
	const fetch: FetchLike = async (input, init) => {
		const url = new URL(String(input));
		if (init?.method !== "POST" || url.pathname !== "/query") return Response.json({ detail: "no route" }, { status: 404 });
		queries.push(String(init.body));
		return Response.json({ status: "success", data: { chunks: answer } });
	};
	const store = new FakeStore();
	seedManifest(store);
	const clock = { now: Date.parse("2026-06-01T00:00:00.000Z") };
	const reflect = options.reflect === undefined ? new FakeReflectStore(() => clock.now) : options.reflect;
	const substrate = new Substrate(loadConfig({ ...LIGHTRAG, ...env }), {
		index: null,
		greptime: null,
		lightragFetch: fetch,
		corpus: { store },
		...(reflect === null ? {} : { reflect }),
	});
	return { substrate, reflect: reflect ?? new FakeReflectStore(), queries, clock };
}

const ask = (built: World, question = QUESTION): Promise<SearchReply> => built.substrate.searchDocs({ question }, "omp");

/** Lets every settled promise run and every write the recorder started finish. */
function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

const titles = (reply: SearchReply): string[] => reply.chunks.map((citation) => citation.title);
const key = (path: string): string => documentKey(REPO, path);

describe("SUBSTRATE_DOCS_RERANK", () => {
	test("off, and a flag left unset, answer byte for byte what a service with none of the new flags answers", async () => {
		const baseline = await ask(world({}, MIXED));
		const off = await ask(world({ SUBSTRATE_DOCS_RERANK: "off", SUBSTRATE_DOCS_TELEMETRY: "off" }, MIXED));
		const unknown = await ask(world({ SUBSTRATE_DOCS_RERANK: "sometimes" }, MIXED));
		expect(JSON.stringify(off)).toBe(JSON.stringify(baseline));
		expect(JSON.stringify(unknown)).toBe(JSON.stringify(baseline));
		// The comparison would pass trivially if the plane's order already were the authority order.
		const on = await ask(world({ SUBSTRATE_DOCS_RERANK: "on" }, MIXED));
		expect(JSON.stringify(on)).not.toBe(JSON.stringify(baseline));
		expect(baseline.rerank).toBeUndefined();
		expect(baseline.chunks.some((citation) => "stale" in citation || "superseded_by" in citation)).toBe(false);
	});

	test("shadow answers byte for byte what off answers, and records on the telemetry row what on would have changed", async () => {
		const baseline = await ask(world({}, MIXED));
		const built = world({ SUBSTRATE_DOCS_RERANK: "shadow", SUBSTRATE_DOCS_TELEMETRY: "on" }, MIXED);
		const shadow = await ask(built);
		await settle();
		expect(JSON.stringify(shadow)).toBe(JSON.stringify(baseline));
		const stored = defined(built.reflect.retrievals[0], "the telemetry row").row;
		expect(stored.rerank).toEqual({ mode: "shadow", order: [key("docs/c.md"), key("docs/b.md"), key("docs/new.md"), key("docs/old.md")], moved: 4 });
		// The row names what the answer returned, which in shadow is still the plane's order.
		expect(stored.returned.map((entry) => entry.key)).toEqual([
			"https://example.com/plan.md",
			key("docs/b.md"),
			key("docs/c.md"),
			key("docs/old.md"),
			key("docs/new.md"),
			"https://example.com/notes.md",
		]);
		expect(built.substrate.reflectCounters().shadow).toEqual({ searches: 1, moved: 4 });
	});

	test("shadow with the telemetry off still counts what it would have moved and writes no row", async () => {
		const built = world({ SUBSTRATE_DOCS_RERANK: "shadow" }, MIXED);
		await ask(built);
		await settle();
		expect(built.reflect.retrievals).toEqual([]);
		expect(built.substrate.reflectCounters().shadow).toEqual({ searches: 1, moved: 4 });
	});

	test("on re-orders the corpus citations by score times (0.5 + 0.5 * authority), keeps every other citation in place, and says what it did", async () => {
		const baseline = await ask(world({}, MIXED));
		const reply = await ask(world({ SUBSTRATE_DOCS_RERANK: "on" }, MIXED));
		expect(titles(baseline)).toEqual(["plan.md", `${REPO}:docs/b.md`, `${REPO}:docs/c.md`, `${REPO}:docs/old.md`, `${REPO}:docs/new.md`, "notes.md"]);
		// Positions 0 and 5 held plain citations, so the four corpus citations are permuted inside positions 1 to 4.
		expect(titles(reply)).toEqual(["plan.md", `${REPO}:docs/c.md`, `${REPO}:docs/b.md`, `${REPO}:docs/new.md`, `${REPO}:docs/old.md`, "notes.md"]);
		expect(reply.rerank).toEqual({ applied: true, moved: 4 });
		for (const position of [0, 5]) {
			const plain = defined(reply.chunks[position], "a non-corpus citation");
			expect(plain).toEqual(defined(baseline.chunks[position], "the same citation without the re-rank"));
			expect("stale" in plain || "superseded_by" in plain).toBe(false);
		}
	});

	test("on drops a superseded document below the document that replaced it, and its citation carries stale and superseded_by", async () => {
		// The superseded document scores higher in the plane: only the authority puts the replacement first.
		const reply = await ask(world({ SUBSTRATE_DOCS_RERANK: "on" }, [corpusChunk("docs/old.md", 0.9), corpusChunk("docs/new.md", 0.8)]));
		expect(titles(reply)).toEqual([`${REPO}:docs/new.md`, `${REPO}:docs/old.md`]);
		expect(reply.chunks[0]).toMatchObject({ stale: false, superseded_by: null });
		expect(reply.chunks[1]).toMatchObject({ stale: true, superseded_by: key("docs/new.md") });
		expect(reply.rerank).toEqual({ applied: true, moved: 2 });
	});

	test("on keeps the plane's order between documents of equal authority and equal score, and reports no moved position", async () => {
		const reply = await ask(world({ SUBSTRATE_DOCS_RERANK: "on" }, [corpusChunk("docs/t2.md", 0.7), corpusChunk("docs/t1.md", 0.7)]));
		expect(titles(reply)).toEqual([`${REPO}:docs/t2.md`, `${REPO}:docs/t1.md`]);
		expect(reply.rerank).toEqual({ applied: true, moved: 0 });
	});

	test("on leaves an answer that cites no document the manifest holds exactly as off answers it, with no rerank member", async () => {
		const answer = [plainChunk("plan.md", 0.9), corpusChunk("docs/never-ingested.md", 0.8)];
		const baseline = await ask(world({}, answer));
		const on = await ask(world({ SUBSTRATE_DOCS_RERANK: "on" }, answer));
		expect(JSON.stringify(on)).toBe(JSON.stringify(baseline));
		expect(on.rerank).toBeUndefined();
	});

	test("on without a corpus manifest answers as off does: the re-rank is fail-open", async () => {
		const baseline = await ask(world({ SUBSTRATE_CORPUS: "off" }, MIXED));
		const on = await ask(world({ SUBSTRATE_DOCS_RERANK: "on", SUBSTRATE_CORPUS: "off" }, MIXED));
		expect(JSON.stringify(on)).toBe(JSON.stringify(baseline));
	});
});

describe("SUBSTRATE_DOCS_TELEMETRY", () => {
	test("one search appends exactly one row: the query hash, the redacted capped text, at most ten returned keys with scores, the backend and the surface", async () => {
		const answer = Array.from({ length: 12 }, (_, index) => plainChunk(`doc-${index}.md`, 0.9 - index / 100));
		const built = world({ SUBSTRATE_DOCS_TELEMETRY: "on" }, answer);
		const reply = await ask(built);
		await settle();
		expect(built.reflect.retrievals).toHaveLength(1);
		const stored = defined(built.reflect.retrievals[0], "the telemetry row").row;
		expect(stored.queryHash).toBe(createHash("sha256").update("where is the data plane described?", "utf8").digest("hex"));
		expect(stored.queryText).toBe(QUESTION);
		expect(stored.surface).toBe("omp");
		expect(stored.backend).toBe("lightrag");
		expect(stored.degraded).toBe(false);
		expect(stored.rerank).toBeNull();
		expect(stored.returned.length).toBeLessThanOrEqual(RETRIEVAL_MAX_RETURNED);
		expect(stored.returned).toEqual(reply.chunks.slice(0, RETRIEVAL_MAX_RETURNED).map((citation) => ({ key: citation.source_url, score: citation.score })));
		expect(stored.returnedCount).toBe(reply.chunks.length);
		expect(stored.topScore).toBe(Math.max(...reply.chunks.map((citation) => citation.score)));
		// No snippet and no citation text is ever part of a row.
		expect(JSON.stringify(stored)).not.toContain("Notes in");
		expect(built.substrate.reflectCounters().telemetry).toEqual({ written: 1, failed: 0, timedOut: 0, dropped: 0 });
	});

	test("a question holding a credential keeps no text at all, only its hash", async () => {
		const secret = `use ghp_${"a".repeat(40)} to push the branch`;
		const built = world({ SUBSTRATE_DOCS_TELEMETRY: "on" }, MIXED);
		await ask(built, secret);
		await settle();
		const stored = defined(built.reflect.retrievals[0], "the telemetry row").row;
		expect(stored.queryText).toBeNull();
		expect(stored.queryHash).toHaveLength(64);
		expect(JSON.stringify(stored)).not.toContain("ghp_");
	});

	test("a long question is cut to the text limit", async () => {
		const built = world({ SUBSTRATE_DOCS_TELEMETRY: "on" }, MIXED);
		await ask(built, "plan ".repeat(200));
		await settle();
		expect(defined(defined(built.reflect.retrievals[0], "the telemetry row").row.queryText, "the cut text")).toHaveLength(RETRIEVAL_QUERY_TEXT_CHARS);
	});

	test("an empty question writes one row with no text and the hash of the empty string", async () => {
		const built = world({ SUBSTRATE_DOCS_TELEMETRY: "on" }, MIXED);
		await ask(built, "   ");
		await settle();
		expect(built.reflect.retrievals).toHaveLength(1);
		const stored = defined(built.reflect.retrievals[0], "the telemetry row").row;
		expect(stored.queryText).toBeNull();
		expect(stored.queryHash).toBe(createHash("sha256").update("", "utf8").digest("hex"));
	});

	test("with the flag off nothing is written, counted or swept", async () => {
		const reflect = new FakeReflectStore();
		let sweeps = 0;
		reflect.sweepRetrievals = async () => {
			sweeps += 1;
			return 0;
		};
		const built = world({}, MIXED, { reflect });
		await ask(built);
		built.substrate.startRetrievalSweep();
		await settle();
		expect(sweeps).toBe(0);
		expect(reflect.retrievals).toEqual([]);
		expect(built.substrate.reflectCounters().telemetry).toEqual({ written: 0, failed: 0, timedOut: 0, dropped: 0 });
	});

	test("a store that never answers does not hold the search: the answer is returned while the write is still pending", async () => {
		const reflect = new FakeReflectStore();
		reflect.hangAppend = true;
		const built = world({ SUBSTRATE_DOCS_TELEMETRY: "on" }, MIXED, { reflect });
		const reply = await ask(built);
		expect(reply.chunks.length).toBeGreaterThan(0);
		await settle();
		expect(reflect.retrievals).toEqual([]);
		// Neither written nor failed: the write is still in flight, bounded by its own budget.
		expect(built.substrate.reflectCounters().telemetry).toEqual({ written: 0, failed: 0, timedOut: 0, dropped: 0 });
	});

	test("a store that throws never fails the search, and the failure is counted", async () => {
		const reflect = new FakeReflectStore();
		reflect.failAppend = new Error("connection lost");
		const built = world({ SUBSTRATE_DOCS_TELEMETRY: "on" }, MIXED, { reflect });
		const reply = await ask(built);
		expect(reply.chunks.length).toBeGreaterThan(0);
		await settle();
		expect(built.substrate.reflectCounters().telemetry).toEqual({ written: 0, failed: 1, timedOut: 0, dropped: 0 });
	});

	test("a server with no index drops the row, counts it and answers the search", async () => {
		const built = world({ SUBSTRATE_DOCS_TELEMETRY: "on" }, MIXED, { reflect: null });
		const reply = await ask(built);
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(built.substrate.reflectCounters().telemetry).toEqual({ written: 0, failed: 0, timedOut: 0, dropped: 1 });
	});

	test("retention drains every expired batch in one pass, and only rows older than the retention window", async () => {
		const day = 86_400_000;
		const bare = (hash: string): RetrievalRow => ({ surface: "omp", queryHash: hash, queryText: null, backend: "lightrag", returned: [], topScore: null, returnedCount: 0, degraded: false, rerank: null });
		const built = world({ SUBSTRATE_DOCS_TELEMETRY: "on", SUBSTRATE_DOCS_TELEMETRY_RETENTION_DAYS: "30" }, MIXED);
		const base = built.clock.now;
		const old = RETRIEVAL_SWEEP_BATCH + 500;
		for (let index = 0; index < old; index += 1) await built.reflect.appendRetrieval(bare(`old-${index}`));
		// Exactly 30 days old when the sweeps run: the boundary is not past the window.
		built.clock.now = base + day;
		await built.reflect.appendRetrieval(bare("boundary"));
		built.clock.now = base + 10 * day;
		await built.reflect.appendRetrieval(bare("recent"));
		built.clock.now = base + 31 * day;

		expect(await built.substrate.sweepRetrievals()).toBe(old);
		expect(built.reflect.retrievals.map((entry) => entry.row.queryHash)).toEqual(["boundary", "recent"]);
		expect(await built.substrate.sweepRetrievals()).toBe(0);
	});

	test("a retention sweep against a store that fails deletes nothing and does not throw", async () => {
		const reflect = new FakeReflectStore();
		reflect.sweepRetrievals = async () => {
			throw new Error("connection lost");
		};
		const built = world({ SUBSTRATE_DOCS_TELEMETRY: "on" }, MIXED, { reflect });
		expect(await built.substrate.sweepRetrievals()).toBe(0);
	});
});
