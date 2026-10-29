/**
 * `POST /corpus/neardup` at the handler: the request guards, the pairs that are found and the ones that are not, the order
 * and the caps, the closed 503 for each reason the embedding service can give, and that no text ever leaves in a reply. The
 * embedding service is a fake that answers from a table, so no network and no TEI are involved.
 */
import { describe, expect, test } from "bun:test";
import { CORPUS_PROTOCOL, MAX_NEARDUP_ITEMS, MAX_NEARDUP_PAIRS, MAX_NEARDUP_SKIPPED, MAX_NEARDUP_TEXT_CHARS, type CorpusNeardupResponse, type NeardupItem } from "@substrate/corpus";
import type { CorpusSettings } from "../config.ts";
import { TEI_REASONS, type TeiEmbedResult } from "../planes/tei.ts";
import { defined } from "../test-support.ts";
import { corpusNeardupReply, type NeardupDeps } from "./neardup.ts";
import type { CorpusReply } from "./service.ts";
import { parseNeardupRequest } from "./validate.ts";

const ON: CorpusSettings = { enabled: true, concurrency: 4, batchDocs: 20, batchBytes: 1_000_000 };
const OFF: CorpusSettings = { ...ON, enabled: false };
const REPO = "Acme/Alpha";

/** A unit vector whose cosine similarity with `[1, 0, 0]` is `similarity`. */
function similarTo(similarity: number): number[] {
	return [similarity, Math.sqrt(1 - similarity * similarity), 0];
}

const BASE = [1, 0, 0];

type Embed = NeardupDeps["embeddings"]["embed"];

interface Fake {
	deps: NeardupDeps;
	calls: string[][];
}

/** An embedding service answering each text from `vectors` (unit `[0, 0, 1]` for an unknown text), unless `answer` takes over. */
function fake(vectors: Record<string, number[]>, options: { settings?: CorpusSettings; vmGuest?: boolean; answer?: (texts: readonly string[]) => Promise<TeiEmbedResult> } = {}): Fake {
	const calls: string[][] = [];
	const embed: Embed = async (texts) => {
		calls.push([...texts]);
		if (options.answer !== undefined) return options.answer(texts);
		return { ok: true, vectors: texts.map((text) => Float32Array.from(vectors[text] ?? [0, 0, 1])), model: "test-model", dim: 3 };
	};
	return { calls, deps: { settings: options.settings ?? ON, vmGuest: options.vmGuest ?? false, embeddings: { embed } } };
}

function item(path: string, text: string, repo = REPO): NeardupItem {
	return { repo, path, text };
}

function request(items: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { protocol: CORPUS_PROTOCOL, items, ...extra };
}

function okBody(reply: CorpusReply<CorpusNeardupResponse>): CorpusNeardupResponse {
	if (!reply.ok) throw new Error(`expected a 200, got ${reply.status} ${reply.body.reason}`);
	return reply.body;
}

function refusal(reply: CorpusReply<CorpusNeardupResponse>): { status: number; reason: string; detail: string | undefined } {
	if (reply.ok) throw new Error("expected a refusal");
	return { status: reply.status, reason: reply.body.reason, detail: reply.body.detail };
}

function pairNames(body: CorpusNeardupResponse): string[] {
	return body.pairs.map((pair) => `${pair.a.path}~${pair.b.path}`);
}

describe("parseNeardupRequest", () => {
	function reasonOf(raw: unknown): string | undefined {
		const parsed = parseNeardupRequest(raw);
		return parsed.ok ? undefined : parsed.reason;
	}

	test("a minimal request leaves the threshold and the cap absent for the handler to default", () => {
		const parsed = parseNeardupRequest(request([item("a.md", "x")]));
		expect(parsed).toEqual({ ok: true, value: { protocol: CORPUS_PROTOCOL, items: [item("a.md", "x")] } });
	});

	test("the threshold bounds are 0.5 and 1 inclusive and it must be a finite number", () => {
		const items = [item("a.md", "x")];
		expect(parseNeardupRequest(request(items, { threshold: 0.5 })).ok).toBe(true);
		expect(parseNeardupRequest(request(items, { threshold: 1 })).ok).toBe(true);
		for (const threshold of [0.49, 1.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "0.9", null, true]) {
			expect({ threshold, reason: reasonOf(request(items, { threshold })) }).toEqual({ threshold, reason: "bad-threshold" });
		}
	});

	test("maxPairs is a whole number from 1 to 1000", () => {
		const items = [item("a.md", "x")];
		expect(parseNeardupRequest(request(items, { maxPairs: 1 })).ok).toBe(true);
		expect(parseNeardupRequest(request(items, { maxPairs: MAX_NEARDUP_PAIRS })).ok).toBe(true);
		for (const maxPairs of [0, MAX_NEARDUP_PAIRS + 1, 1.5, -3, "5", null, Number.NaN]) {
			expect({ maxPairs, reason: reasonOf(request(items, { maxPairs })) }).toEqual({ maxPairs, reason: "bad-max-pairs" });
		}
	});

	test("at most 1000 items and at most 4000 characters of text", () => {
		const many = (count: number): NeardupItem[] => Array.from({ length: count }, (_, index) => item(`d${index}.md`, "x"));
		expect(parseNeardupRequest(request(many(MAX_NEARDUP_ITEMS))).ok).toBe(true);
		expect(reasonOf(request(many(MAX_NEARDUP_ITEMS + 1)))).toBe("too-many-items");
		expect(parseNeardupRequest(request([item("a.md", "x".repeat(MAX_NEARDUP_TEXT_CHARS))])).ok).toBe(true);
		expect(reasonOf(request([item("a.md", "x".repeat(MAX_NEARDUP_TEXT_CHARS + 1))]))).toBe("text-too-long");
		// The bound is on the JavaScript string length: an astral character counts twice.
		expect(reasonOf(request([item("a.md", "\u{1F600}".repeat(MAX_NEARDUP_TEXT_CHARS / 2 + 1))]))).toBe("text-too-long");
	});

	test("a refusal names the item by repo and path and never carries its text", () => {
		const secret = "the-secret-excerpt-".repeat(300);
		const parsed = parseNeardupRequest(request([item("a.md", secret)]));
		expect(JSON.stringify(parsed)).not.toContain("the-secret-excerpt");
		expect(parsed).toMatchObject({ ok: false, reason: "text-too-long" });
		const badText = parseNeardupRequest(request([{ repo: REPO, path: "a.md", text: { nested: "the-secret-excerpt" } }]));
		expect(badText).toMatchObject({ ok: false, reason: "bad-text" });
		expect(JSON.stringify(badText)).not.toContain("the-secret-excerpt");
	});

	test("a bad repo or path is a closed reason, not a throw", () => {
		expect(reasonOf(request([item("a.md", "x", "not a repo")]))).toBe("bad-repo");
		expect(reasonOf(request([item("a.md", "x", "")]))).toBe("bad-repo");
		expect(reasonOf(request([item("../escape.md", "x")]))).toBe("bad-path");
		expect(reasonOf(request([item("/absolute.md", "x")]))).toBe("bad-path");
		expect(reasonOf(request([item("bad\npath.md", "x")]))).toBe("bad-path");
		expect(reasonOf(request([{ path: "a.md", text: "x" }]))).toBe("bad-repo");
		expect(reasonOf(request([{ repo: REPO, text: "x" }]))).toBe("bad-path");
		expect(reasonOf(request([{ repo: 7, path: "a.md", text: "x" }]))).toBe("bad-repo");
	});

	test("a missing or non-string text is bad-text", () => {
		expect(reasonOf(request([{ repo: REPO, path: "a.md" }]))).toBe("bad-text");
		expect(reasonOf(request([{ repo: REPO, path: "a.md", text: 5 }]))).toBe("bad-text");
		expect(reasonOf(request([{ repo: REPO, path: "a.md", text: null }]))).toBe("bad-text");
	});

	test("the same (repo, path) twice is refused, the same path in two repos is not", () => {
		expect(reasonOf(request([item("a.md", "x"), item("a.md", "y")]))).toBe("duplicate-entry");
		expect(parseNeardupRequest(request([item("a.md", "x"), item("a.md", "y", "Acme/Beta")])).ok).toBe(true);
	});

	test("the body must be an object of the right protocol with an items array", () => {
		expect(reasonOf(null)).toBe("bad-request");
		expect(reasonOf([])).toBe("bad-request");
		expect(reasonOf("text")).toBe("bad-request");
		expect(reasonOf({ items: [] })).toBe("bad-protocol");
		expect(reasonOf({ protocol: 2, items: [] })).toBe("bad-protocol");
		expect(reasonOf({ protocol: CORPUS_PROTOCOL })).toBe("bad-request");
		expect(reasonOf({ protocol: CORPUS_PROTOCOL, items: "no" })).toBe("bad-request");
		expect(reasonOf(request(["not an object"]))).toBe("bad-request");
		expect(parseNeardupRequest(request([])).ok).toBe(true);
	});
});

describe("the pairs", () => {
	test("a pair at or above the threshold is returned and one below it is not, with the default threshold 0.92", async () => {
		const { deps, calls } = fake({ base: BASE, near: similarTo(0.95), far: [0.9, 0, Math.sqrt(1 - 0.81)], other: [0, 1, 0] });
		const body = okBody(await corpusNeardupReply(deps, request([item("base.md", "base"), item("near.md", "near"), item("far.md", "far"), item("other.md", "other")]), "omp"));
		expect(pairNames(body)).toEqual(["base.md~near.md"]);
		expect(defined(body.pairs[0]).similarity).toBe(0.95);
		expect(body).toMatchObject({ protocol: CORPUS_PROTOCOL, model: "test-model", dimension: 3, compared: 4, truncated: false, skipped: [] });
		// One call to the embedding service with every text, in (repo, path) order.
		expect(calls).toEqual([["base", "far", "near", "other"]]);
	});

	test("an explicit threshold moves the line, and the similarity is rounded to four decimals", async () => {
		const { deps } = fake({ base: BASE, close: similarTo(0.8765432) });
		const items = [item("base.md", "base"), item("close.md", "close")];
		expect(okBody(await corpusNeardupReply(deps, request(items, { threshold: 0.9 }), "omp")).pairs).toEqual([]);
		const found = okBody(await corpusNeardupReply(deps, request(items, { threshold: 0.8 }), "omp"));
		expect(found.pairs).toEqual([{ a: { repo: REPO, path: "base.md" }, b: { repo: REPO, path: "close.md" }, similarity: 0.8765 }]);
	});

	test("a threshold of 1 finds identical vectors although their dot product may land a hair under 1", async () => {
		const awkward = [0.1, 0.2, 0.3];
		const { deps } = fake({ one: awkward, two: awkward, three: similarTo(0.99) });
		const body = okBody(await corpusNeardupReply(deps, request([item("one.md", "one"), item("two.md", "two"), item("three.md", "three")], { threshold: 1 }), "omp"));
		expect(pairNames(body)).toEqual(["one.md~two.md"]);
		expect(defined(body.pairs[0]).similarity).toBe(1);
	});

	test("the most similar pair comes first and the answer does not depend on the order the items were listed in", async () => {
		const vectors = { a: BASE, b: similarTo(0.93), c: similarTo(0.99) };
		const forward = fake(vectors);
		const backward = fake(vectors);
		const items = [item("a.md", "a"), item("b.md", "b"), item("c.md", "c")];
		const first = okBody(await corpusNeardupReply(forward.deps, request(items, { threshold: 0.5 }), "omp"));
		const second = okBody(await corpusNeardupReply(backward.deps, request([...items].reverse(), { threshold: 0.5 }), "omp"));
		expect(second).toEqual(first);
		expect(first.pairs.map((pair) => pair.similarity)).toEqual([...first.pairs.map((pair) => pair.similarity)].sort((x, y) => y - x));
		expect(defined(first.pairs[0])).toMatchObject({ a: { path: "a.md" }, b: { path: "c.md" } });
	});

	test("pairs across repositories are found and named by repo and path, a before b in (repo, path) order", async () => {
		const { deps } = fake({ x: BASE, y: BASE });
		const body = okBody(await corpusNeardupReply(deps, request([item("guide.md", "y", "Acme/Beta"), item("guide.md", "x", "Acme/Alpha")]), "omp"));
		expect(body.pairs).toEqual([{ a: { repo: "Acme/Alpha", path: "guide.md" }, b: { repo: "Acme/Beta", path: "guide.md" }, similarity: 1 }]);
	});

	test("ties are broken by (repo, path) and stay in that order past ten items", async () => {
		const same = { t: BASE };
		const { deps } = fake(same);
		const names = Array.from({ length: 12 }, (_, index) => `f${String(index).padStart(2, "0")}.md`);
		const body = okBody(await corpusNeardupReply(deps, request([...names].reverse().map((name) => item(name, "t")), { maxPairs: 1000 }), "omp"));
		expect(body.pairs).toHaveLength(66);
		expect(pairNames(body).slice(0, 3)).toEqual(["f00.md~f01.md", "f00.md~f02.md", "f00.md~f03.md"]);
		for (const pair of body.pairs) expect(pair.a.path < pair.b.path).toBe(true);
	});

	test("maxPairs caps the list, and truncated says whether anything was cut", async () => {
		const { deps } = fake({ t: BASE });
		const items = ["a", "b", "c", "d"].map((name) => item(`${name}.md`, "t"));
		const capped = okBody(await corpusNeardupReply(deps, request(items, { maxPairs: 2 }), "omp"));
		expect(capped.pairs).toHaveLength(2);
		expect(capped.truncated).toBe(true);
		expect(okBody(await corpusNeardupReply(deps, request(items, { maxPairs: 5 }), "omp"))).toMatchObject({ truncated: true });
		const exact = okBody(await corpusNeardupReply(deps, request(items, { maxPairs: 6 }), "omp"));
		expect(exact.pairs).toHaveLength(6);
		expect(exact.truncated).toBe(false);
	});

	test("the default cap is 200 pairs", async () => {
		const { deps } = fake({ t: BASE });
		const items = Array.from({ length: 30 }, (_, index) => item(`d${String(index).padStart(2, "0")}.md`, "t"));
		const body = okBody(await corpusNeardupReply(deps, request(items), "omp"));
		// 30 identical documents make 435 pairs.
		expect(body.pairs).toHaveLength(200);
		expect(body.truncated).toBe(true);
	});

	test("an empty or blank text is not embedded and is counted as skipped, in (repo, path) order", async () => {
		const { deps, calls } = fake({ real: BASE, copy: BASE });
		const body = okBody(await corpusNeardupReply(deps, request([item("z-empty.md", ""), item("real.md", "real"), item("a-blank.md", " \n\t "), item("copy.md", "copy")]), "omp"));
		expect(calls).toEqual([["copy", "real"]]);
		expect(body.compared).toBe(2);
		expect(body.skipped).toEqual([
			{ repo: REPO, path: "a-blank.md", reason: "empty" },
			{ repo: REPO, path: "z-empty.md", reason: "empty" },
		]);
		expect(pairNames(body)).toEqual(["copy.md~real.md"]);
	});

	test("the skipped list is bounded to 100 entries", async () => {
		const { deps } = fake({});
		const items = Array.from({ length: MAX_NEARDUP_SKIPPED + 25 }, (_, index) => item(`e${String(index).padStart(3, "0")}.md`, ""));
		const body = okBody(await corpusNeardupReply(deps, request(items), "omp"));
		expect(body.skipped).toHaveLength(MAX_NEARDUP_SKIPPED);
		expect(body.compared).toBe(0);
	});

	test("nothing to embed is a 200 that never calls the embedding service and names no model", async () => {
		const { deps, calls } = fake({});
		for (const items of [[], [item("a.md", ""), item("b.md", "  ")]]) {
			const body = okBody(await corpusNeardupReply(deps, request(items), "omp"));
			expect(body).toMatchObject({ model: null, dimension: null, compared: 0, pairs: [], truncated: false });
		}
		expect(calls).toEqual([]);
	});

	test("a single document has nothing to pair with but is still embedded and counted", async () => {
		const { deps } = fake({ only: BASE });
		const body = okBody(await corpusNeardupReply(deps, request([item("only.md", "only")]), "omp"));
		expect(body).toMatchObject({ compared: 1, pairs: [], model: "test-model" });
	});
});

describe("when the embedding service cannot answer", () => {
	test.each(TEI_REASONS.map((reason) => [reason] as const))("%s is a 503 corpus.embeddings-unavailable with that reason and nothing else", async (reason) => {
		const { deps } = fake({}, { answer: async () => ({ ok: false, reason }) });
		const secret = "private-excerpt-text";
		const failure = refusal(await corpusNeardupReply(deps, request([item("a.md", secret), item("b.md", secret)]), "omp"));
		expect(failure).toEqual({ status: 503, reason: "corpus.embeddings-unavailable", detail: reason });
	});

	test("a service that rejects is still a 503, not a throw", async () => {
		const { deps } = fake({}, { answer: async () => Promise.reject(new Error("connect ECONNREFUSED http://tei.internal:8080")) });
		const reply = await corpusNeardupReply(deps, request([item("a.md", "a")]), "omp");
		expect(refusal(reply)).toEqual({ status: 503, reason: "corpus.embeddings-unavailable", detail: "unavailable" });
		expect(JSON.stringify(reply)).not.toContain("tei.internal");
	});

	test("vectors of different lengths are 503 dim-mismatch, never a 500", async () => {
		const { deps } = fake(
			{},
			{ answer: async () => ({ ok: true, vectors: [Float32Array.from([1, 0, 0]), Float32Array.from([1, 0])], model: "test-model", dim: 3 }) },
		);
		const reply = await corpusNeardupReply(deps, request([item("a.md", "a"), item("b.md", "b")]), "omp");
		expect(refusal(reply)).toEqual({ status: 503, reason: "corpus.embeddings-unavailable", detail: "dim-mismatch" });
	});

	test("an answer with the wrong number of vectors is 503 bad-response", async () => {
		const { deps } = fake({}, { answer: async () => ({ ok: true, vectors: [Float32Array.from([1, 0, 0])], model: "test-model", dim: 3 }) });
		const reply = await corpusNeardupReply(deps, request([item("a.md", "a"), item("b.md", "b")]), "omp");
		expect(refusal(reply)).toEqual({ status: 503, reason: "corpus.embeddings-unavailable", detail: "bad-response" });
	});
});

describe("the gates", () => {
	const body = request([item("a.md", "a"), item("b.md", "b")]);

	test("with the corpus off the answer is 503 corpus.disabled and nothing is embedded", async () => {
		const { deps, calls } = fake({}, { settings: OFF });
		expect(refusal(await corpusNeardupReply(deps, body, "omp"))).toEqual({ status: 503, reason: "corpus.disabled", detail: undefined });
		expect(calls).toEqual([]);
	});

	test("a caller with no authenticated surface is refused 401 before the body is read or anything is embedded", async () => {
		const { deps, calls } = fake({});
		expect(refusal(await corpusNeardupReply(deps, body, null))).toEqual({ status: 401, reason: "unauthenticated", detail: undefined });
		expect(refusal(await corpusNeardupReply(deps, "not even a request", null)).status).toBe(401);
		expect(calls).toEqual([]);
	});

	test("a VM guest is refused 403", async () => {
		const { deps, calls } = fake({}, { vmGuest: true });
		expect(refusal(await corpusNeardupReply(deps, body, "omp"))).toEqual({ status: 403, reason: "vm-guest", detail: undefined });
		expect(calls).toEqual([]);
	});

	test("a refused request is a 400 with its closed reason and nothing is embedded", async () => {
		const { deps, calls } = fake({});
		expect(refusal(await corpusNeardupReply(deps, request([item("a.md", "a")], { threshold: 0.1 }), "omp"))).toMatchObject({ status: 400, reason: "bad-threshold" });
		expect(refusal(await corpusNeardupReply(deps, request([item("a.md", "a", "nope")]), "omp"))).toMatchObject({ status: 400, reason: "bad-repo" });
		expect(calls).toEqual([]);
	});
});

describe("no text leaves", () => {
	test("no reply, success or failure, carries an excerpt", async () => {
		const secret = "confidential-excerpt-";
		const items = [item("a.md", `${secret}one`), item("b.md", `${secret}two`), item("c.md", "")];
		const ok = fake({ [`${secret}one`]: BASE, [`${secret}two`]: BASE });
		const replies: unknown[] = [await corpusNeardupReply(ok.deps, request(items), "omp")];
		for (const reason of TEI_REASONS) {
			replies.push(await corpusNeardupReply(fake({}, { answer: async () => ({ ok: false, reason }) }).deps, request(items), "omp"));
		}
		replies.push(await corpusNeardupReply(ok.deps, request(items, { threshold: 2 }), "omp"));
		replies.push(await corpusNeardupReply(ok.deps, request([item("a.md", secret.repeat(400))]), "omp"));
		for (const reply of replies) expect(JSON.stringify(reply)).not.toContain(secret);
		expect(JSON.stringify(replies[0])).toContain("a.md");
	});
});
