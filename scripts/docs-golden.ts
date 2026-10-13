#!/usr/bin/env bun
/**
 * Docs golden-question harness (uplift-3 N5): scores a docs search against
 * fixtures that state, per question, which source URLs should be cited.
 *
 *   bun run docs:golden                      # offline: the real searchDocs over the corpus-backed fake
 *   bun run docs:golden -- --live            # the deployment, over POST /docs/search only
 *   bun run docs:golden -- --manifest        # print the corpus manifest hash the fixtures must carry
 *
 * ## Two tiers, one scorer
 *
 * Offline (the default, and what `docs-golden.test.ts` asserts in CI) runs
 * every fixture through `packages/mcp-server/src/docs-golden.ts`: the real
 * `searchDocs` against a `RagflowFake` that retrieves by lexical overlap
 * from `fixtures/docs-golden/corpus/`. That proves the pipeline — scope
 * isolation, provenance, ordering, the cap, redaction — and this scorer;
 * it says nothing about the deployment's relevance, and the fixture
 * thresholds are set for the toy retriever.
 *
 * `--live` is opt-in, needs `SUBSTRATE_URL` and `SUBSTRATE_TOKEN` (the
 * bearer; named, never printed — the same two `scripts/chaos-smoke.ts`
 * reads), speaks only `POST /docs/search` over HTTP, **prints** scores and
 * never asserts them: a live relevance number is for an operator to read
 * against the previous run, not for CI to gate on. It refuses (exit 3)
 * before printing a score when the corpus the fixtures were written
 * against is not what the deployment serves: the fixture's
 * `corpus_manifest.sha256` must equal the hash of the corpus on disk, the
 * fixture must carry an operator-attested `corpus_manifest.dataset_commit`,
 * and every live citation's `dataset_commit` must equal it. Without the
 * two variables it exits 2 with a usage line and never opens a socket.
 *
 * ## Scores
 *
 * - `precision_at_k`: share of the top-k citations whose source URL is expected.
 * - `recall`: share of the expected URLs cited anywhere in the reply.
 * - `ndcg`: normalised DCG over the distinct cited URLs in reply order, gains from `grades`.
 * - `provenance_coverage`: share of citations whose commit is a recorded one (not a `dataset-pin:` marker).
 * - `commit_match`: share of expected entries with a `commit` whose citation carries that commit.
 * - `redaction_clean`: no citation field changes under the redactor, and none contains a `forbidden` string.
 *
 * A fixture passes when every threshold it declares is met; `failures`
 * names the ones that were not.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadGoldenCorpus, searchGoldenOffline } from "../packages/mcp-server/src/docs-golden.ts";
import { redact } from "../packages/mcp-server/src/redact.ts";

/** Where the fixtures and their corpus live, relative to the repository root. */
export const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "docs-golden");
export const CORPUS_DIR = join(FIXTURE_DIR, "corpus");

/** Relevance grade of one URL: 0 off-topic, 1 useful, 2 the answer. */
export type Grade = 0 | 1 | 2;

export interface GoldenThresholds {
	precision_at_k?: number;
	recall?: number;
	ndcg?: number;
	provenance_coverage?: number;
	commit_match?: number;
	redaction_clean?: boolean;
	/** Most citations the reply may carry; `0` for an unanswerable question. */
	max_citations?: number;
}

export interface GoldenFixture {
	id: string;
	question: string;
	datasets: string[];
	expected: Array<{ source_url: string; commit?: string }>;
	grades: Record<string, Grade>;
	answerable: boolean;
	/** The cut-off for `precision_at_k` and `ndcg`; 5 when omitted. */
	k?: number;
	/** Strings that must never appear in any citation field (the planted placeholders). */
	forbidden?: string[];
	thresholds: GoldenThresholds;
	corpus_manifest: {
		/** `corpusManifest(CORPUS_DIR)` at the time the fixture was written. */
		sha256: string;
		/** The dataset version pin a live deployment that ingested this corpus reports; attested by the operator. */
		dataset_commit?: string;
	};
}

/** The citation fields the scorer reads; the reply shape `POST /docs/search` and `searchDocs` share. */
export interface ScoredCitation {
	title: string;
	source_url: string;
	heading_path: string;
	commit: string;
	dataset_commit?: string;
	snippet: string;
	score: number;
}

export interface ScoredReply {
	chunks: ScoredCitation[];
	degraded?: true;
	reason?: string;
	degraded_datasets?: Array<{ dataset: string; reason: string }>;
}

export interface GoldenScore {
	citations: number;
	precision_at_k: number;
	recall: number;
	ndcg: number;
	provenance_coverage: number;
	commit_match: number;
	redaction_clean: boolean;
	/** The thresholds that were not met; empty is a pass. */
	failures: string[];
}

export const DEFAULT_K = 5;

/** Every `*.json` fixture under `dir`, sorted by file name, shape-checked. */
export function loadFixtures(dir: string = FIXTURE_DIR): GoldenFixture[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.sort()
		.map((file) => parseFixture(JSON.parse(readFileSync(join(dir, file), "utf8")), file));
}

function parseFixture(raw: unknown, file: string): GoldenFixture {
	if (raw === null || typeof raw !== "object") throw new Error(`${file}: fixture must be a JSON object`);
	const fixture = raw as Record<string, unknown>;
	const id = fixture.id;
	const question = fixture.question;
	const datasets = fixture.datasets;
	const expected = fixture.expected;
	const grades = fixture.grades;
	const thresholds = fixture.thresholds;
	const manifest = fixture.corpus_manifest;
	if (typeof id !== "string" || id.length === 0) throw new Error(`${file}: id is required`);
	if (typeof question !== "string" || question.trim().length === 0) throw new Error(`${file}: question is required`);
	if (!Array.isArray(datasets) || datasets.length === 0 || !datasets.every((name) => typeof name === "string")) {
		throw new Error(`${file}: datasets must name at least one dataset`);
	}
	if (!Array.isArray(expected) || !expected.every((entry) => entry !== null && typeof entry === "object" && typeof entry.source_url === "string")) {
		throw new Error(`${file}: expected must be a list of {source_url, commit?}`);
	}
	if (grades === null || typeof grades !== "object" || !Object.values(grades).every((grade) => grade === 0 || grade === 1 || grade === 2)) {
		throw new Error(`${file}: grades must map source URLs to 0, 1 or 2`);
	}
	if (typeof fixture.answerable !== "boolean") throw new Error(`${file}: answerable must be a boolean`);
	if (thresholds === null || typeof thresholds !== "object") throw new Error(`${file}: thresholds is required`);
	if (manifest === null || typeof manifest !== "object" || typeof (manifest as Record<string, unknown>).sha256 !== "string") {
		throw new Error(`${file}: corpus_manifest.sha256 is required`);
	}
	return raw as GoldenFixture;
}

/**
 * The corpus manifest hash: sha256 over `<relative path>\n<sha256 of the
 * file>\n` for every file under `dir`, sorted by path. Stated this plainly
 * so an operator can recompute it with `sha256sum` and attest a live
 * ingest against it.
 */
export function corpusManifest(dir: string = CORPUS_DIR): string {
	const files: string[] = [];
	const walk = (relative: string): void => {
		for (const entry of readdirSync(join(dir, relative)).sort()) {
			const path = relative.length === 0 ? entry : `${relative}/${entry}`;
			if (statSync(join(dir, path)).isDirectory()) walk(path);
			else files.push(path);
		}
	};
	walk("");
	const manifest = createHash("sha256");
	for (const path of files.sort()) {
		const digest = createHash("sha256").update(readFileSync(join(dir, path))).digest("hex");
		manifest.update(`${path}\n${digest}\n`);
	}
	return manifest.digest("hex");
}

/** Discounted cumulative gain of a graded list in rank order. */
function dcg(gains: number[]): number {
	return gains.reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
}

/** The pure scorer: one fixture against one reply. */
export function scoreReply(fixture: GoldenFixture, reply: ScoredReply): GoldenScore {
	const k = fixture.k ?? DEFAULT_K;
	const citations = reply.chunks;
	const expectedUrls = new Set(fixture.expected.map((entry) => entry.source_url));
	const top = citations.slice(0, k);

	const precisionAtK = top.length === 0 ? (expectedUrls.size === 0 ? 1 : 0) : top.filter((citation) => expectedUrls.has(citation.source_url)).length / top.length;

	const citedUrls = new Set(citations.map((citation) => citation.source_url));
	const recall = expectedUrls.size === 0 ? 1 : [...expectedUrls].filter((url) => citedUrls.has(url)).length / expectedUrls.size;

	// Distinct URLs in reply order, so several chunks of one document count as
	// one ranked hit rather than inflating the gain.
	const ranked: string[] = [];
	for (const citation of top) if (!ranked.includes(citation.source_url)) ranked.push(citation.source_url);
	const ideal = Object.values(fixture.grades)
		.filter((grade) => grade > 0)
		.sort((left, right) => right - left)
		.slice(0, k);
	const idealDcg = dcg(ideal);
	const ndcg = idealDcg === 0 ? (ranked.length === 0 ? 1 : 0) : dcg(ranked.map((url) => fixture.grades[url] ?? 0)) / idealDcg;

	const provenanceCoverage =
		citations.length === 0 ? 1 : citations.filter((citation) => !citation.commit.startsWith("dataset-pin:")).length / citations.length;

	const withCommit = fixture.expected.filter((entry) => entry.commit !== undefined);
	const commitMatch =
		withCommit.length === 0
			? 1
			: withCommit.filter((entry) => citations.some((citation) => citation.source_url === entry.source_url && citation.commit === entry.commit)).length /
				withCommit.length;

	const forbidden = fixture.forbidden ?? [];
	const redactionClean = citations.every((citation) =>
		[citation.title, citation.source_url, citation.heading_path, citation.snippet].every(
			(field) => redact(field) === field && !forbidden.some((needle) => field.includes(needle)),
		),
	);

	const t = fixture.thresholds;
	const failures: string[] = [];
	if (t.precision_at_k !== undefined && precisionAtK < t.precision_at_k) failures.push("precision_at_k");
	if (t.recall !== undefined && recall < t.recall) failures.push("recall");
	if (t.ndcg !== undefined && ndcg < t.ndcg) failures.push("ndcg");
	if (t.provenance_coverage !== undefined && provenanceCoverage < t.provenance_coverage) failures.push("provenance_coverage");
	if (t.commit_match !== undefined && commitMatch < t.commit_match) failures.push("commit_match");
	if (t.redaction_clean === true && !redactionClean) failures.push("redaction_clean");
	if (t.max_citations !== undefined && citations.length > t.max_citations) failures.push("max_citations");
	if (reply.degraded === true) failures.push("degraded");

	return {
		citations: citations.length,
		precision_at_k: precisionAtK,
		recall,
		ndcg,
		provenance_coverage: provenanceCoverage,
		commit_match: commitMatch,
		redaction_clean: redactionClean,
		failures,
	};
}

/** One printed line per fixture, numbers to two places; never a citation body, never a token. */
export function formatScore(id: string, score: GoldenScore): string {
	const verdict = score.failures.length === 0 ? "  ok  " : " FAIL ";
	const numbers = [
		`p@k=${score.precision_at_k.toFixed(2)}`,
		`recall=${score.recall.toFixed(2)}`,
		`ndcg=${score.ndcg.toFixed(2)}`,
		`prov=${score.provenance_coverage.toFixed(2)}`,
		`commit=${score.commit_match.toFixed(2)}`,
		`redacted=${score.redaction_clean ? "clean" : "LEAK"}`,
		`n=${score.citations}`,
	].join(" ");
	return `${verdict} ${id} ${numbers}${score.failures.length > 0 ? ` — failed: ${score.failures.join(", ")}` : ""}`;
}

export type GoldenMode = { mode: "offline" } | { mode: "live" } | { mode: "manifest" } | { error: string };

export const USAGE = "usage: bun run docs:golden [--live | --manifest]; --live needs SUBSTRATE_URL and SUBSTRATE_TOKEN";

export function parseArgs(argv: readonly string[]): GoldenMode {
	if (argv.length === 0) return { mode: "offline" };
	if (argv.length === 1 && argv[0] === "--live") return { mode: "live" };
	if (argv.length === 1 && argv[0] === "--manifest") return { mode: "manifest" };
	return { error: USAGE };
}

/** The fetch surface the live tier needs; injectable so a test can prove it is never called without the variables. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The outside world `main` touches. */
export interface GoldenIo {
	env: Record<string, string | undefined>;
	fetchImpl: FetchLike;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
	/** The offline runner: `searchGoldenOffline` over the corpus in production, a stub in the scorer's own tests. */
	offline: (fixture: GoldenFixture) => Promise<ScoredReply>;
	/** Where the fixtures and the corpus are read from; the repository's own when omitted. */
	fixtureDir?: string;
	corpusDir?: string;
}

/**
 * Offline: every fixture must pass (exit 1 otherwise). Live: every fixture is
 * printed, none asserted (exit 0), after the corpus/pin refusals (exit 3).
 */
export async function main(argv: readonly string[], io: GoldenIo): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		io.stderr(parsed.error);
		return 2;
	}
	if (parsed.mode === "manifest") {
		io.stdout(corpusManifest(io.corpusDir ?? CORPUS_DIR));
		return 0;
	}
	const fixtures = loadFixtures(io.fixtureDir ?? FIXTURE_DIR);
	const onDisk = corpusManifest(io.corpusDir ?? CORPUS_DIR);

	if (parsed.mode === "offline") {
		let failed = 0;
		for (const fixture of fixtures) {
			const score = scoreReply(fixture, await io.offline(fixture));
			if (score.failures.length > 0) failed += 1;
			io.stdout(formatScore(fixture.id, score));
		}
		io.stdout(`${fixtures.length - failed}/${fixtures.length} fixtures passed offline`);
		return failed === 0 ? 0 : 1;
	}

	const base = io.env.SUBSTRATE_URL?.trim();
	const token = io.env.SUBSTRATE_TOKEN?.trim();
	if (!base || !token) {
		io.stderr(USAGE);
		return 2;
	}
	const stale = fixtures.filter((fixture) => fixture.corpus_manifest.sha256 !== onDisk);
	if (stale.length > 0) {
		io.stderr(`refusing --live: corpus manifest on disk is ${onDisk.slice(0, 12)}…; stale fixtures: ${stale.map((fixture) => fixture.id).join(", ")}`);
		return 3;
	}
	const unattested = fixtures.filter((fixture) => fixture.corpus_manifest.dataset_commit === undefined);
	if (unattested.length > 0) {
		io.stderr(`refusing --live: no attested corpus_manifest.dataset_commit on: ${unattested.map((fixture) => fixture.id).join(", ")}`);
		return 3;
	}
	for (const fixture of fixtures) {
		let reply: ScoredReply;
		try {
			const response = await io.fetchImpl(`${base.replace(/\/+$/, "")}/docs/search`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
				body: JSON.stringify({ question: fixture.question, datasets: fixture.datasets, session_id: `docs-golden:${fixture.id}` }),
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) {
				io.stderr(`${fixture.id}: POST /docs/search answered ${response.status}`);
				return 3;
			}
			reply = (await response.json()) as ScoredReply;
		} catch (cause) {
			io.stderr(`${fixture.id}: POST /docs/search failed — ${cause instanceof Error ? cause.message : String(cause)}`);
			return 3;
		}
		const pin = fixture.corpus_manifest.dataset_commit;
		const foreign = reply.chunks.filter((citation) => citation.dataset_commit !== pin);
		if (foreign.length > 0) {
			io.stderr(`refusing --live: ${fixture.id} cited ${foreign.length} chunk(s) whose dataset_commit is not the attested pin`);
			return 3;
		}
		io.stdout(formatScore(fixture.id, scoreReply(fixture, reply)));
	}
	io.stdout(`${fixtures.length} fixtures scored live (printed, not asserted)`);
	return 0;
}

if (import.meta.main) {
	const corpus = loadGoldenCorpus(CORPUS_DIR);
	process.exit(
		await main(process.argv.slice(2), {
			env: process.env,
			fetchImpl: fetch,
			stdout: (line) => process.stdout.write(`${line}\n`),
			stderr: (line) => process.stderr.write(`${line}\n`),
			offline: async (fixture) =>
				(await searchGoldenOffline(corpus, fixture, { commit: fixture.corpus_manifest.dataset_commit ?? "golden-offline" })).reply,
		}),
	);
}
