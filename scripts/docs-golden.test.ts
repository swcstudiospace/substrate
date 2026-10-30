/**
 * uplift-3 N5: the committed golden fixtures pass offline through the real
 * `searchDocs`; the scorer itself fails a wrong expectation; `--live`
 * without its variables exits 2 and never opens a socket.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
	resolveEmitBearer,
	resolveSearchBearer,
	scoreReply,
	writeStateAtomically,
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
		// NDCG is undefined with nothing graded: reported as 1, never a failure; the cap is the verdict.
		expect(cited.failures).toEqual(["max_citations"]);
		expect(cited.ndcg).toBe(1);
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

describe("the live canary (uplift-4 S7)", () => {
	const MANIFEST_PATH = "/scratch/canary-manifest.json";
	const goodManifest = (commit: string = COMMIT) => JSON.stringify({ sha256: corpusManifest(), dataset_commit: commit });

	interface Recorded {
		url: string;
		authorization: string | null;
		body: Record<string, unknown>;
	}

	/** A canary run against an in-memory deployment: replies per question, an events sink, a dedupe record and a token reader that logs every path. */
	function canary(options: { env?: Record<string, string | undefined>; manifest?: string | null; state?: string | null; eventStatus?: number; searchStatus?: number; writeOk?: boolean; servedCommit?: string } = {}) {
		const out: string[] = [];
		const err: string[] = [];
		const requests: Recorded[] = [];
		const tokenReads: string[] = [];
		const overrides = new Map<string, (reply: ScoredReply) => ScoredReply>();
		let state: string | null = options.state ?? null;
		const env = {
			SUBSTRATE_DOCS_CANARY: "1",
			SUBSTRATE_DOCS_CANARY_MANIFEST: MANIFEST_PATH,
			SUBSTRATE_TOKEN_OMP: "tok-omp tok-ignored",
			SUBSTRATE_TOKEN_SUBSTRATE: "tok-substrate",
			...options.env,
		};
		const goldenIo: GoldenIo = {
			env,
			fetchImpl: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
				requests.push({ url, authorization: new Headers(init?.headers).get("authorization"), body });
				if (url.endsWith("/events")) return new Response("{}", { status: options.eventStatus ?? 202 });
				if (options.searchStatus !== undefined) return new Response("nope", { status: options.searchStatus });
				const fixture = fixtures.find((candidate) => candidate.question === body.question);
				if (fixture === undefined) throw new Error("unknown question");
				const offline = (await searchGoldenOffline(corpus, fixture, { commit: options.servedCommit ?? COMMIT })).reply as ScoredReply;
				return Response.json(overrides.get(fixture.id)?.(offline) ?? offline);
			},
			stdout: (line: string) => out.push(line),
			stderr: (line: string) => err.push(line),
			offline: async (fixture: GoldenFixture): Promise<ScoredReply> => (await searchGoldenOffline(corpus, fixture, { commit: COMMIT })).reply,
			readFile: (path: string) => (path === MANIFEST_PATH ? (options.manifest === undefined ? goodManifest(options.servedCommit) : options.manifest) : null),
			readToken: (path: string) => {
				tokenReads.push(path);
				return null;
			},
			readState: () => state,
			writeState: (text: string) => {
				if (options.writeOk === false) return false;
				state = text;
				return true;
			},
			now: () => new Date("2026-10-14T03:00:00.000Z"),
		};
		return { goldenIo, out, err, requests, tokenReads, overrides, state: () => state };
	}

	const events = (requests: Recorded[]) => requests.filter((request) => request.url.endsWith("/events"));
	const answerable = () => {
		const first = fixtures.find((fixture) => fixture.answerable && fixture.expected.length > 0);
		if (first === undefined) throw new Error("no answerable fixture");
		return first;
	};

	test("parses --live --emit in either order and refuses --emit alone", () => {
		expect(parseArgs(["--live", "--emit"])).toEqual({ mode: "canary" });
		expect(parseArgs(["--emit", "--live"])).toEqual({ mode: "canary" });
		expect(parseArgs(["--emit"])).toEqual({ error: USAGE });
		expect(parseArgs(["--live"])).toEqual({ mode: "live" });
	});

	test("refuses by name, before reading a token or opening a socket, when it is not configured", async () => {
		for (const [env, named, absent] of [
			[{ SUBSTRATE_DOCS_CANARY: undefined, SUBSTRATE_DOCS_CANARY_MANIFEST: undefined }, ["SUBSTRATE_DOCS_CANARY=1", "SUBSTRATE_DOCS_CANARY_MANIFEST"], []],
			[{ SUBSTRATE_DOCS_CANARY: undefined }, ["SUBSTRATE_DOCS_CANARY=1"], ["SUBSTRATE_DOCS_CANARY_MANIFEST"]],
			[{ SUBSTRATE_DOCS_CANARY: "yes" }, ["SUBSTRATE_DOCS_CANARY=1"], ["SUBSTRATE_DOCS_CANARY_MANIFEST"]],
			[{ SUBSTRATE_DOCS_CANARY_MANIFEST: "  " }, ["SUBSTRATE_DOCS_CANARY_MANIFEST"], ["SUBSTRATE_DOCS_CANARY=1"]],
		] as const) {
			const run = canary({ env });
			expect(await main(["--live", "--emit"], run.goldenIo)).toBe(2);
			for (const name of named) expect(run.err[0]).toContain(name);
			for (const name of absent) expect(run.err[0]).not.toContain(name);
			expect(run.requests).toEqual([]);
			expect(run.tokenReads).toEqual([]);
		}
	});

	test("refuses a SUBSTRATE_URL that is not loopback, and an environment with no omp bearer", async () => {
		const remote = canary({ env: { SUBSTRATE_URL: "https://substrate.example.com" } });
		expect(await main(["--live", "--emit"], remote.goldenIo)).toBe(2);
		expect(remote.err[0]).toContain("not a loopback address");
		expect(remote.requests).toEqual([]);

		const bare = canary({ env: { SUBSTRATE_TOKEN_OMP: undefined, SUBSTRATE_TOKEN: undefined, SUBSTRATE_TOKENS_DIR: "/scratch/tokens" } });
		expect(await main(["--live", "--emit"], bare.goldenIo)).toBe(2);
		expect(bare.err[0]).toContain("SUBSTRATE_TOKEN_OMP");
		expect(bare.requests).toEqual([]);
		// Only the injected directory was asked about, never the host's.
		expect(bare.tokenReads).toEqual([join("/scratch/tokens", "omp")]);
	});

	test("the search bearer is the first entry of SUBSTRATE_TOKEN_OMP, then the injected tokens dir, then SUBSTRATE_TOKEN", () => {
		expect(resolveSearchBearer({ SUBSTRATE_TOKEN_OMP: " a ,b c" }, () => "never")).toBe("a");
		const reads: string[] = [];
		const viaDir = resolveSearchBearer({ SUBSTRATE_TOKENS_DIR: "/scratch/tokens", SUBSTRATE_TOKEN: "fallback" }, (path) => {
			reads.push(path);
			return "from-file";
		});
		expect(viaDir).toBe("from-file");
		expect(reads).toEqual([join("/scratch/tokens", "omp")]);
		expect(resolveSearchBearer({ SUBSTRATE_TOKENS_DIR: "/scratch/tokens", SUBSTRATE_TOKEN: "fallback" }, () => null)).toBe("fallback");
		expect(resolveSearchBearer({ SUBSTRATE_TOKENS_DIR: "/scratch/tokens" }, () => null)).toBeNull();
		expect(resolveEmitBearer({ SUBSTRATE_TOKEN_SUBSTRATE: "x y" }, () => "never")).toBe("x");
	});

	test("an unreadable, malformed or mismatched attested manifest is refused (3) before any search", async () => {
		for (const manifest of [null, "not json", JSON.stringify({ sha256: "x" }), JSON.stringify({ sha256: "0".repeat(64), dataset_commit: COMMIT })]) {
			const run = canary({ manifest });
			expect(await main(["--live", "--emit"], run.goldenIo)).toBe(3);
			expect(run.err[0]).toContain("refusing the docs canary");
			expect(run.requests).toEqual([]);
		}
	});

	test("a corpus ingested under a release sha with a matching manifest passes: the live expectations use the attested commit", async () => {
		const run = canary({ servedCommit: "rel-0123456789ab" });
		expect(await main(["--live", "--emit"], run.goldenIo)).toBe(0);
		expect(run.out.filter((line) => line.startsWith(" FAIL "))).toEqual([]);
		expect(events(run.requests)).toEqual([]);
		// The committed fixtures themselves still state the golden commit (offline tier unchanged).
		expect(fixtures.some((fixture) => fixture.expected.some((entry) => entry.commit === COMMIT))).toBe(true);
	});

	test("a dataset with no recorded version pin is a named setup failure (3): nothing posted, record untouched", async () => {
		const run = canary({ state: JSON.stringify({ failing: ["earlier"] }) });
		const target = answerable();
		run.overrides.set(target.id, (reply) => ({ ...reply, chunks: reply.chunks.map(({ dataset_commit: _pin, ...rest }) => rest) }));
		expect(await main(["--live", "--emit"], run.goldenIo)).toBe(3);
		expect(run.err[0]).toContain("no recorded version pin");
		expect(run.err[0]).toContain(target.id);
		expect(events(run.requests)).toEqual([]);
		expect(JSON.parse(run.state() ?? "{}")).toEqual({ failing: ["earlier"] });
	});

	test("a missing manifest read by the real reader is the named refusal (3), not a crash", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-canary-"));
		try {
			const run = canary({ env: { SUBSTRATE_DOCS_CANARY_MANIFEST: join(dir, "absent.json") } });
			delete run.goldenIo.readFile;
			expect(await main(["--live", "--emit"], run.goldenIo)).toBe(3);
			expect(run.err[0]).toContain("SUBSTRATE_DOCS_CANARY_MANIFEST cannot be read");
			expect(run.requests).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("every fixture passing: a table, exit 0, searches as omp's first token, no event, no state written", async () => {
		const run = canary();
		expect(await main(["--live", "--emit"], run.goldenIo)).toBe(0);
		expect(run.out.filter((line) => line.startsWith("  ok  "))).toHaveLength(fixtures.length);
		expect(run.out.at(-1)).toBe(`${fixtures.length}/${fixtures.length} fixtures passed the live canary`);
		expect(run.requests).toHaveLength(fixtures.length);
		expect(run.requests.every((request) => request.url === "http://127.0.0.1:7410/docs/search" && request.authorization === "Bearer tok-omp")).toBe(true);
		expect(run.state()).toBeNull();
		expect([...run.out, ...run.err].some((line) => line.includes("tok-"))).toBe(false);
	});

	test("a wrong source exits 1 and posts ONE deduped warning as substrate; the same failing set is silent, a pass clears the record, a new failure posts again", async () => {
		const target = answerable();
		const run = canary();
		const wrongSource = (reply: ScoredReply): ScoredReply => ({ ...reply, chunks: reply.chunks.map((chunk) => ({ ...chunk, source_url: "https://example.com/elsewhere/other" })) });
		run.overrides.set(target.id, wrongSource);
		expect(await main(["--live", "--emit"], run.goldenIo)).toBe(1);
		expect(run.out.some((line) => line.startsWith(" FAIL ") && line.includes(target.id))).toBe(true);
		const posted = events(run.requests);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.authorization).toBe("Bearer tok-substrate");
		expect(posted[0]?.body).toMatchObject({ surface: "substrate", kind: "warning", payload: { action: "docs.canary", runtime: "docs-canary", total: fixtures.length } });
		expect(JSON.stringify(posted[0]?.body)).toContain(target.id);
		expect(JSON.parse(run.state() ?? "{}")).toEqual({ failing: [target.id] });

		// The same failing set on the next run: still a non-zero exit, no second warning.
		const again = canary({ state: run.state() });
		again.overrides.set(target.id, wrongSource);
		expect(await main(["--live", "--emit"], again.goldenIo)).toBe(1);
		expect(events(again.requests)).toEqual([]);

		// A passing run clears the record; the next failure announces again.
		const healed = canary({ state: again.state() });
		expect(await main(["--live", "--emit"], healed.goldenIo)).toBe(0);
		expect(JSON.parse(healed.state() ?? "{}")).toEqual({ failing: [] });
		const broken = canary({ state: healed.state() });
		broken.overrides.set(target.id, wrongSource);
		expect(await main(["--live", "--emit"], broken.goldenIo)).toBe(1);
		expect(events(broken.requests)).toHaveLength(1);
	});

	test("a missing commit pin fails commit_match, and a citation from another dataset commit fails the attested pin", async () => {
		const withCommit = fixtures.find((fixture) => fixture.thresholds.commit_match !== undefined && fixture.expected.some((entry) => entry.commit !== undefined));
		if (withCommit === undefined) throw new Error("no fixture with a commit pin");
		const lost = canary();
		lost.overrides.set(withCommit.id, (reply) => ({ ...reply, chunks: reply.chunks.map((chunk) => ({ ...chunk, commit: "some-other-commit" })) }));
		expect(await main(["--live", "--emit"], lost.goldenIo)).toBe(1);
		expect(lost.out.find((line) => line.includes(withCommit.id))).toContain("commit_match");
		expect(JSON.stringify(events(lost.requests)[0]?.body)).toContain("commit_match");

		const foreign = canary();
		foreign.overrides.set(withCommit.id, (reply) => ({ ...reply, chunks: reply.chunks.map((chunk) => ({ ...chunk, dataset_commit: "not-attested" })) }));
		expect(await main(["--live", "--emit"], foreign.goldenIo)).toBe(1);
		expect(foreign.out.find((line) => line.includes(withCommit.id))).toContain("dataset_commit");
	});

	test("a degraded reply is an outage, not a regression: exit 3, a line on stderr, nothing posted and the dedupe record untouched", async () => {
		const degraded = canary({ state: JSON.stringify({ failing: ["earlier"] }) });
		degraded.overrides.set(answerable().id, (reply) => ({ ...reply, degraded: true, reason: "ragflow-unavailable" }));
		expect(await main(["--live", "--emit"], degraded.goldenIo)).toBe(3);
		expect(degraded.err[0]).toContain("answered degraded (ragflow-unavailable)");
		expect(events(degraded.requests)).toEqual([]);
		expect(JSON.parse(degraded.state() ?? "{}")).toEqual({ failing: ["earlier"] });

		const refused = canary({ searchStatus: 401 });
		expect(await main(["--live", "--emit"], refused.goldenIo)).toBe(3);
		expect(refused.err[0]).toContain("answered 401");
		expect(events(refused.requests)).toEqual([]);
	});

	test("a lost clear of the dedupe record is logged distinctly and exits 4; a lost write after a stored warning is logged and still exits 1", async () => {
		const lostClear = canary({ state: JSON.stringify({ failing: ["earlier"] }), writeOk: false });
		expect(await main(["--live", "--emit"], lostClear.goldenIo)).toBe(4);
		expect(lostClear.err.at(-1)).toContain("could not be cleared");
		expect(events(lostClear.requests)).toEqual([]);

		const lostWrite = canary({ writeOk: false });
		lostWrite.overrides.set(answerable().id, (reply) => ({ ...reply, chunks: [] }));
		expect(await main(["--live", "--emit"], lostWrite.goldenIo)).toBe(1);
		expect(events(lostWrite.requests)).toHaveLength(1);
		expect(lostWrite.err.at(-1)).toContain("could not be written");
	});

	test("the dedupe record is written through a temp file and a rename, leaving no temp file, and a failure keeps the old record", () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-canary-"));
		try {
			const file = join(dir, "last.json");
			expect(writeStateAtomically(file, '{"failing":["a"]}\n')).toBe(true);
			expect(writeStateAtomically(file, '{"failing":[]}\n')).toBe(true);
			expect(readFileSync(file, "utf8")).toBe('{"failing":[]}\n');
			expect(readdirSync(dir)).toEqual(["last.json"]);
			// An unwritable location reports false and never touches the record that exists.
			expect(writeStateAtomically(join(dir, "missing", "last.json"), "x")).toBe(false);
			expect(readFileSync(file, "utf8")).toBe('{"failing":[]}\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a warning the ledger did not store keeps the old record so the next run posts again; no substrate bearer posts nothing", async () => {
		const target = answerable();
		const failing = (overrides: Map<string, (reply: ScoredReply) => ScoredReply>) => overrides.set(target.id, (reply) => ({ ...reply, chunks: [] }));
		const unstored = canary({ eventStatus: 500 });
		failing(unstored.overrides);
		expect(await main(["--live", "--emit"], unstored.goldenIo)).toBe(1);
		expect(events(unstored.requests)).toHaveLength(1);
		expect(unstored.state()).toBeNull();
		expect(unstored.err.at(-1)).toContain("will be posted again");

		const silent = canary({ env: { SUBSTRATE_TOKEN_SUBSTRATE: undefined, SUBSTRATE_TOKEN: undefined, SUBSTRATE_TOKENS_DIR: "/scratch/tokens" } });
		failing(silent.overrides);
		expect(await main(["--live", "--emit"], silent.goldenIo)).toBe(1);
		expect(events(silent.requests)).toEqual([]);
		expect(silent.err.at(-1)).toContain("no substrate bearer");
		expect(silent.tokenReads).toEqual([join("/scratch/tokens", "substrate")]);
	});

	test("a measured golden recall above the objective posts one note as substrate with the recall and the question count, and the canary still exits 0", async () => {
		const run = canary({ env: { SUBSTRATE_CORPUS: "on" } });
		run.goldenIo.goldenRecall = async () => ({ recall5: 0.8, asked: 120 });
		expect(await main(["--live", "--emit"], run.goldenIo)).toBe(0);
		const posted = events(run.requests);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.authorization).toBe("Bearer tok-substrate");
		expect(posted[0]?.body).toMatchObject({
			surface: "substrate",
			kind: "note",
			payload: { action: "docs.canary", runtime: "docs-canary", golden_recall5: 0.8, golden_asked: 120 },
		});
		expect(run.out).toContain("golden recall@5 0.800 over 120 questions (objective 0.6)");
		expect(run.state()).toBeNull();
	});

	test("a golden recall under the objective fails the run and says which flag, still reports it, and the objective is the flag's", async () => {
		const low = canary({ env: { SUBSTRATE_CORPUS: "on" } });
		low.goldenIo.goldenRecall = async () => ({ recall5: 0.4, asked: 50 });
		expect(await main(["--live", "--emit"], low.goldenIo)).toBe(1);
		expect(low.err.at(-1)).toContain("SUBSTRATE_DOCS_SLO_RECALL5");
		expect(events(low.requests)).toHaveLength(1);
		expect(events(low.requests)[0]?.body).toMatchObject({ kind: "note", payload: { golden_recall5: 0.4 } });

		const lenient = canary({ env: { SUBSTRATE_CORPUS: "on", SUBSTRATE_DOCS_SLO_RECALL5: "0.3" } });
		lenient.goldenIo.goldenRecall = async () => ({ recall5: 0.4, asked: 50 });
		expect(await main(["--live", "--emit"], lenient.goldenIo)).toBe(0);
	});

	test("a failing fixture and a measured golden recall post the warning with the recall in it, then the note", async () => {
		const target = answerable();
		const run = canary({ env: { SUBSTRATE_CORPUS: "on" } });
		run.goldenIo.goldenRecall = async () => ({ recall5: 0.9, asked: 10 });
		run.overrides.set(target.id, (reply) => ({ ...reply, chunks: [] }));
		expect(await main(["--live", "--emit"], run.goldenIo)).toBe(1);
		const posted = events(run.requests);
		expect(posted.map((request) => request.body.kind)).toEqual(["note", "warning"]);
		expect(posted[1]?.body).toMatchObject({ kind: "warning", payload: { golden_recall5: 0.9, total: fixtures.length } });
	});

	test("a golden recall that could not be measured, or whose documents cannot be read, is said on stderr and changes nothing else", async () => {
		const none = canary({ env: { SUBSTRATE_CORPUS: "on" } });
		none.goldenIo.goldenRecall = async () => null;
		expect(await main(["--live", "--emit"], none.goldenIo)).toBe(0);
		expect(none.err.at(-1)).toContain("golden recall not measured");
		expect(events(none.requests)).toEqual([]);

		const broken = canary({ env: { SUBSTRATE_CORPUS: "on" } });
		broken.goldenIo.goldenRecall = async () => {
			throw new Error("ENOENT: no such directory");
		};
		expect(await main(["--live", "--emit"], broken.goldenIo)).toBe(0);
		expect(broken.err.at(-1)).toContain("golden recall not measured");
		expect(events(broken.requests)).toEqual([]);
	});

	test("a golden report with no substrate bearer, or one the ledger did not store, is said on stderr and the exit code stays the fixtures'", async () => {
		const silent = canary({ env: { SUBSTRATE_CORPUS: "on", SUBSTRATE_TOKEN_SUBSTRATE: undefined, SUBSTRATE_TOKEN: undefined, SUBSTRATE_TOKENS_DIR: "/scratch/tokens" } });
		silent.goldenIo.goldenRecall = async () => ({ recall5: 0.8, asked: 5 });
		expect(await main(["--live", "--emit"], silent.goldenIo)).toBe(0);
		expect(silent.err.at(-1)).toContain("golden recall not reported, no substrate bearer");
		expect(events(silent.requests)).toEqual([]);

		const unstored = canary({ env: { SUBSTRATE_CORPUS: "on" }, eventStatus: 500 });
		unstored.goldenIo.goldenRecall = async () => ({ recall5: 0.8, asked: 5 });
		expect(await main(["--live", "--emit"], unstored.goldenIo)).toBe(0);
		expect(unstored.err.at(-1)).toContain("golden recall report was not stored");
	});

	test("with SUBSTRATE_CORPUS off or unset the golden check never runs: no measurement, no note, and a low recall cannot fail the run", async () => {
		for (const env of [{}, { SUBSTRATE_CORPUS: "off" }, { SUBSTRATE_CORPUS: "true" }, { SUBSTRATE_CORPUS: "" }]) {
			const run = canary({ env });
			let measured = 0;
			run.goldenIo.goldenRecall = async () => {
				measured += 1;
				return { recall5: 0.1, asked: 50 };
			};
			expect(await main(["--live", "--emit"], run.goldenIo)).toBe(0);
			expect(measured).toBe(0);
			expect(events(run.requests)).toEqual([]);
			expect(run.out.some((line) => line.includes("golden recall"))).toBe(false);
			expect(run.err).toEqual([]);
		}
	});

	test("with SUBSTRATE_CORPUS on (any case, padded) the golden check runs", async () => {
		const run = canary({ env: { SUBSTRATE_CORPUS: " ON " } });
		let measured = 0;
		run.goldenIo.goldenRecall = async () => {
			measured += 1;
			return { recall5: 0.1, asked: 50 };
		};
		expect(await main(["--live", "--emit"], run.goldenIo)).toBe(1);
		expect(measured).toBe(1);
	});

	test("plain --live is unchanged: it prints, never asserts, and needs no canary variables", async () => {
		const run = canary({ env: { SUBSTRATE_DOCS_CANARY: undefined, SUBSTRATE_DOCS_CANARY_MANIFEST: undefined, SUBSTRATE_URL: "http://127.0.0.1:7410", SUBSTRATE_TOKEN: "plain" } });
		expect(await main(["--live"], run.goldenIo)).toBe(0);
		expect(run.out.at(-1)).toContain("printed, not asserted");
		expect(events(run.requests)).toEqual([]);
	});
});
