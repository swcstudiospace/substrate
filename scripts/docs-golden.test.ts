/**
 * uplift-3 N5: the committed golden fixtures pass offline through the real
 * `searchDocs`; the scorer itself fails a wrong expectation; `--live`
 * without its variables exits 2 and never opens a socket.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGoldenCorpus, searchGoldenOffline } from "../packages/mcp-server/src/docs-golden.ts";
import {
	CORPUS_DIR,
	USAGE,
	corpusManifest,
	formatScore,
	loadFixtures,
	main,
	parseArgs,
	scoreReply,
	type GoldenFixture,
	type GoldenIo,
	type ScoredReply,
} from "./docs-golden.ts";

const corpus = loadGoldenCorpus(CORPUS_DIR);
const fixtures = loadFixtures();
const COMMIT = "golden-v1";

describe("the committed fixtures, offline", () => {
	test("there are fixtures, and every one carries the manifest of the corpus on disk", () => {
		expect(fixtures.length).toBeGreaterThanOrEqual(3);
		const onDisk = corpusManifest();
		for (const fixture of fixtures) expect({ id: fixture.id, sha256: fixture.corpus_manifest.sha256 }).toEqual({ id: fixture.id, sha256: onDisk });
	});

	for (const fixture of fixtures) {
		test(`${fixture.id}: meets its thresholds through the real searchDocs, retrieving only its datasets`, async () => {
			const { reply, retrievedDatasetIds, events } = await searchGoldenOffline(corpus, fixture, { commit: COMMIT });
			const score = scoreReply(fixture, reply);
			expect({ id: fixture.id, failures: score.failures, line: formatScore(fixture.id, score) }).toEqual({
				id: fixture.id,
				failures: [],
				line: formatScore(fixture.id, score),
			});
			// Scope isolation: exactly one retrieval per named dataset, none for the others.
			const retrievedNames = retrievedDatasetIds.map((id) => id.replace(/^ds-[a-z]+-/, "")).sort();
			expect(retrievedNames).toEqual([...fixture.datasets].sort());
			// Never degraded, never more than the cap, every citation pinned to the corpus commit.
			expect(reply.degraded).toBeUndefined();
			expect(reply.degraded_datasets).toBeUndefined();
			expect(reply.chunks.length).toBeLessThanOrEqual(10);
			expect(reply.chunks.every((citation) => citation.dataset_commit === COMMIT)).toBe(true);
			expect(reply.chunks.every((citation) => citation.commit === COMMIT)).toBe(true);
			// One note event listing exactly the cited URLs, like any search.
			const notes = events.filter((event) => event.kind === "note");
			expect(notes).toHaveLength(1);
			expect(notes[0]?.payload?.urls).toEqual(reply.chunks.map((citation) => citation.source_url));
			// Answerable fixtures cite something; unanswerable ones cite nothing.
			expect(reply.chunks.length > 0).toBe(fixture.answerable);
		});
	}

	test("the planted placeholder is redacted in the snippet and never travels in any field", async () => {
		const fixture = fixtures.find((entry) => entry.id === "credentials-redacted");
		if (fixture === undefined) throw new Error("credentials-redacted fixture missing");
		const { reply } = await searchGoldenOffline(corpus, fixture, { commit: COMMIT });
		expect(reply.chunks).toHaveLength(1);
		expect(reply.chunks[0]?.snippet).toContain("[REDACTED]");
		expect(JSON.stringify(reply)).not.toContain("sk-proj-");
	});
});

describe("the scorer", () => {
	const substrateDoor = fixtures.find((entry) => entry.id === "substrate-door");
	if (substrateDoor === undefined) throw new Error("substrate-door fixture missing");
	const base: GoldenFixture = substrateDoor;

	async function replyFor(fixture: GoldenFixture): Promise<ScoredReply> {
		return (await searchGoldenOffline(corpus, fixture, { commit: COMMIT })).reply;
	}

	test("a deliberately wrong expected URL fails precision, recall and ndcg — the fixture cannot pass by accident", async () => {
		const wrong: GoldenFixture = {
			...base,
			id: "wrong-url",
			expected: [{ source_url: "https://example.com/agent-substrate/not-this-page" }],
			grades: { "https://example.com/agent-substrate/not-this-page": 2 },
		};
		const score = scoreReply(wrong, await replyFor(wrong));
		expect(score.citations).toBeGreaterThan(0);
		expect(score.precision_at_k).toBe(0);
		expect(score.recall).toBe(0);
		expect(score.ndcg).toBe(0);
		expect(score.failures).toEqual(["precision_at_k", "recall", "ndcg"]);
		expect(formatScore(wrong.id, score)).toStartWith(" FAIL ");
	});

	test("a wrong expected commit fails commit_match alone; an unrecorded citation lowers provenance_coverage", () => {
		const reply: ScoredReply = {
			chunks: [
				{ title: "t", source_url: "https://example.com/agent-substrate/data-planes", heading_path: "", commit: "other", snippet: "s", score: 1 },
				{ title: "t", source_url: "https://example.com/agent-substrate/elsewhere", heading_path: "", commit: "dataset-pin:agent-substrate:unrecorded", snippet: "s", score: 0.5 },
			],
		};
		const score = scoreReply({ ...base, grades: { ...base.grades, "https://example.com/agent-substrate/elsewhere": 0 } }, reply);
		expect(score.commit_match).toBe(0);
		expect(score.provenance_coverage).toBe(0.5);
		expect(score.precision_at_k).toBe(0.5);
		expect(score.recall).toBe(1);
		expect(score.failures).toEqual(["precision_at_k", "provenance_coverage", "commit_match"]);
	});

	test("ndcg rewards order: the answer ranked second scores below the answer ranked first, and duplicates of one page count once", () => {
		const answer = "https://example.com/programming-desk/review-gate";
		const useful = "https://example.com/programming-desk/draft-pr";
		const fixture: GoldenFixture = { ...base, id: "order", expected: [{ source_url: answer }], grades: { [answer]: 2, [useful]: 1 }, thresholds: {} };
		const cite = (url: string, score: number) => ({ title: "t", source_url: url, heading_path: "", commit: "c", snippet: "s", score });
		const right = scoreReply(fixture, { chunks: [cite(answer, 0.9), cite(useful, 0.5)] });
		const swapped = scoreReply(fixture, { chunks: [cite(useful, 0.9), cite(answer, 0.5)] });
		const duplicated = scoreReply(fixture, { chunks: [cite(answer, 0.9), cite(answer, 0.8), cite(useful, 0.5)] });
		expect(right.ndcg).toBe(1);
		expect(swapped.ndcg).toBeLessThan(right.ndcg);
		expect(swapped.ndcg).toBeGreaterThan(0);
		expect(duplicated.ndcg).toBe(1);
		expect(right.failures).toEqual([]);
	});

	test("a forbidden string or a redactor hit in any field fails redaction_clean; a degraded reply always fails", () => {
		const fixture: GoldenFixture = { ...base, forbidden: ["hunter2"], thresholds: { redaction_clean: true } };
		const clean = scoreReply(fixture, { chunks: [{ title: "t", source_url: base.expected[0]?.source_url ?? "", heading_path: "", commit: "c", snippet: "[REDACTED]", score: 1 }] });
		expect(clean.redaction_clean).toBe(true);
		expect(clean.failures).toEqual([]);
		const forbidden = scoreReply(fixture, { chunks: [{ title: "t", source_url: "u", heading_path: "", commit: "c", snippet: "the password is hunter2", score: 1 }] });
		expect(forbidden.redaction_clean).toBe(false);
		expect(forbidden.failures).toEqual(["redaction_clean"]);
		const leaked = scoreReply(fixture, { chunks: [{ title: "sk-proj-abcdefghij1234567890", source_url: "u", heading_path: "", commit: "c", snippet: "s", score: 1 }] });
		expect(leaked.redaction_clean).toBe(false);
		const degraded = scoreReply(fixture, { chunks: [], degraded: true, reason: "ragflow 503" });
		expect(degraded.failures).toEqual(["degraded"]);
	});

	test("an unanswerable fixture passes on an empty reply and fails max_citations on any citation", () => {
		const fixture = fixtures.find((entry) => entry.id === "unanswerable");
		if (fixture === undefined) throw new Error("unanswerable fixture missing");
		expect(scoreReply(fixture, { chunks: [] })).toMatchObject({ precision_at_k: 1, recall: 1, ndcg: 1, failures: [] });
		const cited = scoreReply(fixture, { chunks: [{ title: "t", source_url: "u", heading_path: "", commit: "c", snippet: "s", score: 1 }] });
		expect(cited.failures).toEqual(["max_citations"]);
		expect(cited.ndcg).toBe(0);
	});
});

describe("the CLI", () => {
	/** One recorded live request: what the fake deployment saw. */
	interface LiveRequest {
		url: string;
		method: string;
		authorization: string | null;
		body: { question?: unknown; datasets?: unknown };
	}

	function io(env: Record<string, string | undefined>, answer: ScoredReply = { chunks: [] }) {
		const out: string[] = [];
		const err: string[] = [];
		const requests: LiveRequest[] = [];
		const goldenIo: GoldenIo = {
			env,
			fetchImpl: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const headers = new Headers(init?.headers);
				requests.push({
					url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
					method: init?.method ?? "GET",
					authorization: headers.get("authorization"),
					body: typeof init?.body === "string" ? (JSON.parse(init.body) as LiveRequest["body"]) : {},
				});
				return Response.json(answer);
			},
			stdout: (line: string) => out.push(line),
			stderr: (line: string) => err.push(line),
			offline: async (fixture: GoldenFixture): Promise<ScoredReply> => (await searchGoldenOffline(corpus, fixture, { commit: COMMIT })).reply,
		};
		return { goldenIo, out, err, requests };
	}

	test("parses its three modes and nothing else", () => {
		expect(parseArgs([])).toEqual({ mode: "offline" });
		expect(parseArgs(["--live"])).toEqual({ mode: "live" });
		expect(parseArgs(["--manifest"])).toEqual({ mode: "manifest" });
		expect(parseArgs(["--plane", "x"])).toEqual({ error: USAGE });
	});

	test("--live without SUBSTRATE_URL and SUBSTRATE_TOKEN exits 2 with the usage line and never calls fetch", async () => {
		for (const env of [{}, { SUBSTRATE_URL: "http://127.0.0.1:7410" }, { SUBSTRATE_TOKEN: "t" }, { SUBSTRATE_URL: "", SUBSTRATE_TOKEN: "t" }]) {
			const { goldenIo, err, requests } = io(env);
			expect(await main(["--live"], goldenIo)).toBe(2);
			expect(err).toEqual([USAGE]);
			expect(requests).toEqual([]);
		}
	});

	test("--live refuses before any network call when a fixture's manifest is stale or its pin is unattested", async () => {
		const env = { SUBSTRATE_URL: "http://127.0.0.1:7410", SUBSTRATE_TOKEN: "secret-bearer" };
		const dir = mkdtempSync(join(tmpdir(), "docs-golden-"));
		try {
			const base = fixtures[0];
			if (base === undefined) throw new Error("no fixtures");
			writeFileSync(join(dir, "stale.json"), JSON.stringify({ ...base, id: "stale", corpus_manifest: { sha256: "0".repeat(64), dataset_commit: "x" } }));
			const stale = io(env);
			stale.goldenIo.fixtureDir = dir;
			expect(await main(["--live"], stale.goldenIo)).toBe(3);
			expect(stale.err[0]).toContain("stale fixtures: stale");
			expect(stale.requests).toEqual([]);

			writeFileSync(join(dir, "stale.json"), JSON.stringify({ ...base, id: "unattested", corpus_manifest: { sha256: corpusManifest() } }));
			const unattested = io(env);
			unattested.goldenIo.fixtureDir = dir;
			expect(await main(["--live"], unattested.goldenIo)).toBe(3);
			expect(unattested.err[0]).toContain("no attested corpus_manifest.dataset_commit on: unattested");
			expect(unattested.requests).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("--live refuses after the search when the live pin differs; a matching pin is printed, not asserted", async () => {
		const env = { SUBSTRATE_URL: "http://127.0.0.1:7410/", SUBSTRATE_TOKEN: "secret-bearer" };
		// The committed fixtures match the corpus on disk, so the only refusal
		// left is the live pin: a reply pinned elsewhere is refused, never scored.
		const foreign = io(env, {
			chunks: [{ title: "t", source_url: "u", heading_path: "", commit: "c", dataset_commit: "not-the-attested-pin", snippet: "s", score: 1 }],
		});
		expect(await main(["--live"], foreign.goldenIo)).toBe(3);
		expect(foreign.err[0]).toContain("not the attested pin");
		expect(foreign.out).toEqual([]);

		// A matching pin is printed, not asserted: a reply that fails every
		// threshold still exits 0, one line per fixture.
		const printed = io(env, { chunks: [] });
		expect(await main(["--live"], printed.goldenIo)).toBe(0);
		expect(printed.out.filter((line) => line.startsWith(" FAIL ")).length).toBeGreaterThan(0);
		expect(printed.out.at(-1)).toContain("printed, not asserted");
		// Only `POST /docs/search` is spoken, one call per fixture, the bearer in the header and never on a printed line.
		expect(printed.requests).toHaveLength(fixtures.length);
		expect(printed.requests.every((request) => request.url === "http://127.0.0.1:7410/docs/search" && request.method === "POST")).toBe(true);
		expect(printed.requests.every((request) => request.authorization === "Bearer secret-bearer")).toBe(true);
		expect(printed.requests.map((request) => request.body.question)).toEqual(fixtures.map((fixture) => fixture.question));
		expect([...printed.out, ...printed.err].some((line) => line.includes("secret-bearer"))).toBe(false);
	});

	test("offline mode exits 0 on the committed fixtures and prints one line each", async () => {
		const { goldenIo, out, requests } = io({});
		expect(await main([], goldenIo)).toBe(0);
		expect(out.filter((line) => line.startsWith("  ok  "))).toHaveLength(fixtures.length);
		expect(out.at(-1)).toBe(`${fixtures.length}/${fixtures.length} fixtures passed offline`);
		expect(requests).toEqual([]);
	});

	test("--manifest prints the hash the fixtures carry", async () => {
		const { goldenIo, out } = io({});
		expect(await main(["--manifest"], goldenIo)).toBe(0);
		expect(out).toEqual([corpusManifest()]);
	});
});
