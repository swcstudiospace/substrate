#!/usr/bin/env bun
/**
 * Docs golden-question harness (uplift-3 N5): scores a docs search against
 * fixtures that state, per question, which source URLs should be cited.
 *
 *   bun run docs:golden                      # offline: the real searchDocs over the corpus-backed fake
 *   bun run docs:golden -- --live            # the deployment, over POST /docs/search only
 *   bun run docs:golden -- --manifest        # print the corpus manifest hash the fixtures must carry
 *   bun run docs:golden -- --live --emit     # the opt-in canary (uplift-4 S7): scored, exits 1 on regression, one deduped warning
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
 * `--live --emit` is the canary a staged timer runs (`infra/vps/substrate-docs-canary.*`).
 * It needs `SUBSTRATE_DOCS_CANARY=1` and `SUBSTRATE_DOCS_CANARY_MANIFEST` (a JSON
 * file `{"sha256", "dataset_commit"}` the operator attests after ingesting the
 * corpus) and refuses by name — exit 2, no socket opened — when either is
 * missing, or when `SUBSTRATE_URL` is not loopback. It searches as `omp`
 * (`SUBSTRATE_TOKEN_OMP`, first entry of a list, else the tokens dir, else
 * `SUBSTRATE_TOKEN`), ASSERTS every fixture (exit 1 on any regression) and
 * posts one `warning` as `substrate` when the failing set changed since the
 * last run (`SUBSTRATE_DOCS_CANARY_STATE`). Read-only against RAGFlow.
 *
 * ## Scores
 *
 * - `precision_at_k`: share of the top-k citations whose source URL is expected.
 * - `recall`: share of the expected URLs cited anywhere in the reply.
 * - `ndcg`: normalised DCG over the distinct cited URLs in reply order, gains from `grades`; 1 (not applicable) when nothing is graded above 0.
 * - `provenance_coverage`: share of citations whose commit is a recorded one (not a `dataset-pin:` marker).
 * - `commit_match`: share of expected entries with a `commit` whose citation carries that commit.
 * - `redaction_clean`: no citation field changes under the redactor, and none contains a `forbidden` string.
 *
 * A fixture passes when every threshold it declares is met; `failures`
 * names the ones that were not.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TOKENS_DIR, firstLine, resolveBearer } from "../packages/cli/src/token.ts";
import { loadGoldenCorpus, searchGoldenOffline } from "../packages/mcp-server/src/docs-golden.ts";
import { redact } from "../packages/mcp-server/src/redact.ts";
import { loadSloThresholds } from "../packages/corpus/src/index.ts";
import { measureGoldenRecall, type GoldenRecallReport } from "./docs-eval.ts";

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
	// With nothing graded above 0 (an unanswerable fixture) NDCG is undefined:
	// reported as 1 and never a failure — the citation cap is that fixture's verdict.
	const ndcg = idealDcg === 0 ? 1 : dcg(ranked.map((url) => fixture.grades[url] ?? 0)) / idealDcg;

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

export type GoldenMode = { mode: "offline" } | { mode: "live" } | { mode: "manifest" } | { mode: "canary" } | { error: string };

export const USAGE = "usage: bun run docs:golden [--live [--emit] | --manifest]; --live needs SUBSTRATE_URL and SUBSTRATE_TOKEN";

export function parseArgs(argv: readonly string[]): GoldenMode {
	if (argv.length === 0) return { mode: "offline" };
	if (argv.length === 1 && argv[0] === "--live") return { mode: "live" };
	if (argv.length === 1 && argv[0] === "--manifest") return { mode: "manifest" };
	if (argv.length === 2 && argv.includes("--live") && argv.includes("--emit")) return { mode: "canary" };
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
	// uplift-4 S7: the canary's outside world, injected so a test never reads the host.
	/** A text file's contents, or null; the canary manifest. `readFileSync` in production. */
	readFile?: (path: string) => string | null;
	/** The token-file reader the bearer resolution falls back to; `firstLine` in production. */
	readToken?: (path: string) => string | null;
	/** The dedupe record's contents, or null. */
	readState?: () => string | null;
	/** Persist the dedupe record; false when it could not be written. */
	writeState?: (text: string) => boolean;
	/** The clock; the current time when omitted. */
	now?: () => Date;
	/**
	 * The self-supervised golden recall (phase 70), taken after the fixtures with the search bearer: `null` when it could not be
	 * measured. Production reads this checkout's `docs/` through `docs-eval.ts`; a test leaves it out and the canary behaves as it
	 * did before the golden set existed.
	 */
	goldenRecall?: (base: string, bearer: string) => Promise<GoldenRecallReport | null>;
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
	if (parsed.mode === "canary") return runCanary(io);
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

// ── The live canary (uplift-4 S7) ────────────────────────────────────────────

/** The surface the canary searches as; its bearer is never the emit bearer. */
export const CANARY_SURFACE = "omp";

/** Where the canary remembers the failing set it last announced. */
export const DEFAULT_CANARY_STATE = "/var/lib/substrate/docs-canary-last.json";

/** Most failing fixtures one event names. */
const CANARY_EVENT_MAX = 20;

/**
 * The `omp` search bearer, in the Grok smoke's order: the server's variable
 * (a rotation may list several entries, so the first one), then the tokens dir,
 * then `SUBSTRATE_TOKEN`. `read` is injectable; tests never reach the host's tokens.
 */
export function resolveSearchBearer(env: Record<string, string | undefined>, read: (path: string) => string | null = firstLine): string | null {
	const listed = env.SUBSTRATE_TOKEN_OMP?.split(/[\s,]+/).find((entry) => entry.length > 0);
	if (listed) return listed;
	const viaFile = read(join(env.SUBSTRATE_TOKENS_DIR?.trim() || DEFAULT_TOKENS_DIR, CANARY_SURFACE));
	if (viaFile) return viaFile;
	return env.SUBSTRATE_TOKEN?.trim() || null;
}

/** The bearer for the `substrate` surface the warning is posted as: the doctor's rule, with an injectable reader. */
export function resolveEmitBearer(env: Record<string, string | undefined>, read: (path: string) => string | null = firstLine): string | null {
	const listed = env.SUBSTRATE_TOKEN_SUBSTRATE?.split(/[\s,]+/).find((entry) => entry.length > 0);
	return resolveBearer("substrate", { ...env, SUBSTRATE_TOKEN: env.SUBSTRATE_TOKEN?.trim() || listed }, read);
}

/** What the operator attests after ingesting the corpus: its manifest hash and the dataset commit it was ingested under. */
export interface CanaryManifest {
	sha256: string;
	dataset_commit: string;
}

/** The manifest a file holds, or the reason it is unusable. */
export function parseCanaryManifest(text: string): CanaryManifest | { problem: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { problem: "is not valid JSON" };
	}
	const record = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	if (record === null || typeof record.sha256 !== "string" || record.sha256.length === 0 || typeof record.dataset_commit !== "string" || record.dataset_commit.length === 0) {
		return { problem: "must be an object with non-empty string sha256 and dataset_commit" };
	}
	return { sha256: record.sha256, dataset_commit: record.dataset_commit };
}

/** True for the loopback hosts: the canary's bearer never leaves the machine. */
export function isLoopbackBase(base: string): boolean {
	try {
		return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(base).hostname);
	} catch {
		return false;
	}
}

/** The failing fixture ids last announced; anything unreadable means "nothing announced yet". */
export function readCanaryState(text: string | null): string[] {
	if (text === null) return [];
	try {
		const parsed: unknown = JSON.parse(text);
		const failing = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).failing : undefined;
		if (Array.isArray(failing) && failing.length <= 1000 && failing.every((id) => typeof id === "string")) return [...failing].sort();
	} catch {
		// A corrupt record costs one repeated warning, never a lost one.
	}
	return [];
}

export interface CanaryEvent {
	surface: "substrate";
	kind: "warning";
	summary: string;
	session_id: string;
	payload: {
		action: "docs.canary";
		runtime: "docs-canary";
		total: number;
		failing: Array<{ fixture: string; failed: string[] }>;
		/** Present when the golden set was measured in the same run (phase 70). */
		golden_recall5?: number;
	};
}

/** The one warning for a failing set: fixture ids and metric names only, never a citation or a token. */
export function canaryEvent(failing: ReadonlyArray<{ fixture: string; failed: string[] }>, total: number, stampedAt: string, goldenRecall5: number | null = null): CanaryEvent {
	const named = failing.slice(0, CANARY_EVENT_MAX);
	const full = `docs canary regression: ${named.map((entry) => entry.fixture).join(", ")}${failing.length > named.length ? `, +${failing.length - named.length} more` : ""}`;
	return {
		surface: "substrate",
		kind: "warning",
		summary: full.length <= 200 ? full : `${full.slice(0, 199)}…`,
		session_id: `docs-canary:${stampedAt}`,
		payload: { action: "docs.canary", runtime: "docs-canary", total, failing: named, ...(goldenRecall5 === null ? {} : { golden_recall5: goldenRecall5 }) },
	};
}

export interface GoldenReportEvent {
	surface: "substrate";
	kind: "note";
	summary: string;
	session_id: string;
	payload: { action: "docs.canary"; runtime: "docs-canary"; golden_recall5: number; golden_asked: number };
}

/** The note a run posts when it measured the golden set, whatever the fixtures said: the recall and the number of questions, nothing else. */
export function goldenReportEvent(report: GoldenRecallReport, stampedAt: string): GoldenReportEvent {
	return {
		surface: "substrate",
		kind: "note",
		summary: `docs canary: golden recall at 5 is ${report.recall5.toFixed(2)} over ${report.asked} questions`,
		session_id: `docs-canary:${stampedAt}`,
		payload: { action: "docs.canary", runtime: "docs-canary", golden_recall5: report.recall5, golden_asked: report.asked },
	};
}

/**
 * The canary: every fixture through `POST /docs/search` as `omp`, scored by
 * the same scorer as the offline tier and the printed live tier, plus the
 * attested pin. Exit 0 all pass; 1 a regression (one warning posted when the
 * failing set changed) or, when `goldenRecall` measured it (phase 70), a golden
 * recall at 5 under `SUBSTRATE_DOCS_SLO_RECALL5` (a `note` carrying the recall is
 * posted on every run that measured it); 2 not configured (named, nothing sent); 3 unusable
 * (stale fixtures, an unreadable manifest, a dataset with no version pin, service refused or unreachable, or a degraded
 * answer — an open breaker is an outage, which is the SLO's to report, not a
 * regression to announce; nothing is posted); 4 the dedupe record could not be
 * cleared after a pass (a stale record would silently swallow the next
 * identical warning).
 */
export async function runCanary(io: GoldenIo): Promise<number> {
	const missing = [
		...(io.env.SUBSTRATE_DOCS_CANARY?.trim() === "1" ? [] : ["SUBSTRATE_DOCS_CANARY=1"]),
		...(io.env.SUBSTRATE_DOCS_CANARY_MANIFEST?.trim() ? [] : ["SUBSTRATE_DOCS_CANARY_MANIFEST"]),
	];
	if (missing.length > 0) {
		io.stderr(`refusing the docs canary: not configured, missing ${missing.join(", ")}`);
		return 2;
	}
	const base = (io.env.SUBSTRATE_URL?.trim() || "http://127.0.0.1:7410").replace(/\/+$/, "");
	if (!isLoopbackBase(base)) {
		io.stderr("refusing the docs canary: SUBSTRATE_URL is not a loopback address");
		return 2;
	}
	const bearer = resolveSearchBearer(io.env, io.readToken);
	if (bearer === null) {
		io.stderr(`refusing the docs canary: no ${CANARY_SURFACE} bearer (SUBSTRATE_TOKEN_OMP, SUBSTRATE_TOKENS_DIR or SUBSTRATE_TOKEN)`);
		return 2;
	}
	const manifestPath = io.env.SUBSTRATE_DOCS_CANARY_MANIFEST?.trim() ?? "";
	let manifestText: string | null;
	try {
		manifestText = (io.readFile ?? ((path: string) => readFileSync(path, "utf8")))(manifestPath);
	} catch {
		// A missing or unreadable manifest is a setup failure (exit 3), never a crash.
		manifestText = null;
	}
	const manifest = manifestText === null ? { problem: "cannot be read" } : parseCanaryManifest(manifestText);
	if ("problem" in manifest) {
		io.stderr(`refusing the docs canary: SUBSTRATE_DOCS_CANARY_MANIFEST ${manifest.problem}`);
		return 3;
	}
	const fixtures = loadFixtures(io.fixtureDir ?? FIXTURE_DIR);
	const onDisk = corpusManifest(io.corpusDir ?? CORPUS_DIR);
	const stale = fixtures.filter((fixture) => fixture.corpus_manifest.sha256 !== onDisk);
	if (manifest.sha256 !== onDisk || stale.length > 0) {
		io.stderr(
			`refusing the docs canary: the attested manifest or the fixtures do not match the corpus on disk (${onDisk.slice(0, 12)}…)${
				stale.length > 0 ? `; stale fixtures: ${stale.map((fixture) => fixture.id).join(", ")}` : ""
			}`,
		);
		return 3;
	}

	const failing: Array<{ fixture: string; failed: string[] }> = [];
	for (const fixture of fixtures) {
		let reply: ScoredReply;
		try {
			const response = await io.fetchImpl(`${base}/docs/search`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
				body: JSON.stringify({ question: fixture.question, datasets: fixture.datasets, session_id: `docs-canary:${fixture.id}` }),
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) {
				io.stderr(`${fixture.id}: POST /docs/search answered ${response.status}`);
				return 3;
			}
			reply = (await response.json()) as ScoredReply;
			if (!Array.isArray(reply.chunks)) throw new Error("the reply has no chunks list");
		} catch (cause) {
			io.stderr(`${fixture.id}: POST /docs/search failed — ${cause instanceof Error ? cause.message : String(cause)}`);
			return 3;
		}
		if (reply.degraded === true) {
			io.stderr(`${fixture.id}: POST /docs/search answered degraded (${String(reply.reason ?? "no reason").slice(0, 80)}); an outage cannot be scored, nothing posted`);
			return 3;
		}
		// A citation with no dataset_commit means the dataset has no recorded version
		// (no pin): a setup failure to fix before enabling the canary, not a regression.
		const unpinned = reply.chunks.filter((citation) => citation.dataset_commit === undefined);
		if (unpinned.length > 0) {
			io.stderr(
				`refusing the docs canary: ${fixture.id} cited ${unpinned.length} chunk(s) from a dataset with no recorded version pin (datasets: ${fixture.datasets.join(", ")}); seed the pins first (docs/docs-search-ingest.md), nothing posted`,
			);
			return 3;
		}
		// The live expectations use the ATTESTED commit: the corpus may have been
		// ingested under a release SHA, while the committed offline fixtures state
		// the golden commit.
		const live: GoldenFixture = {
			...fixture,
			expected: fixture.expected.map((entry) => (entry.commit === undefined ? entry : { ...entry, commit: manifest.dataset_commit })),
		};
		const score = scoreReply(live, reply);
		// The attested pin is part of the verdict here: a citation from another
		// ingest means the corpus the fixtures describe is not what is served.
		if (reply.chunks.some((citation) => citation.dataset_commit !== manifest.dataset_commit)) score.failures.push("dataset_commit");
		io.stdout(formatScore(fixture.id, score));
		if (score.failures.length > 0) failing.push({ fixture: fixture.id, failed: score.failures });
	}
	io.stdout(`${fixtures.length - failing.length}/${fixtures.length} fixtures passed the live canary`);

	// Phase 70: the self-supervised golden set, asked of the same server. A recall under the objective fails the run like a
	// failing fixture does, so the oneshot's failed state is the visible signal; the note below feeds `corpus.golden_recall5`.
	const golden = await measureGolden(io, base, bearer);
	const goldenFloor = loadSloThresholds(io.env).recall5;
	const goldenBreached = golden !== null && golden.recall5 < goldenFloor;
	if (golden !== null) {
		io.stdout(`golden recall@5 ${golden.recall5.toFixed(3)} over ${golden.asked} questions (objective ${goldenFloor})`);
		if (goldenBreached) io.stderr("docs canary: the golden recall at 5 is under SUBSTRATE_DOCS_SLO_RECALL5");
		await reportGolden(io, base, golden);
	}

	const previous = readCanaryState(io.readState?.() ?? null);
	const current = failing.map((entry) => entry.fixture).sort();
	const unchanged = previous.length === current.length && previous.every((id, index) => id === current[index]);
	if (current.length === 0) {
		if (previous.length > 0 && io.writeState?.(`${JSON.stringify({ failing: [] })}\n`) === false) {
			io.stderr("docs canary: all fixtures pass but the dedupe record could not be cleared; the next identical warning would be dropped until it is");
			return 4;
		}
		return goldenBreached ? 1 : 0;
	}
	if (unchanged) return 1;
	const emitBearer = resolveEmitBearer(io.env, io.readToken);
	if (emitBearer === null) {
		io.stderr("docs canary: warning not posted, no substrate bearer (SUBSTRATE_TOKEN_SUBSTRATE, SUBSTRATE_TOKEN or SUBSTRATE_TOKENS_DIR)");
		return 1;
	}
	const stored = await postEvent(io, base, emitBearer, canaryEvent(failing, fixtures.length, (io.now?.() ?? new Date()).toISOString(), golden?.recall5 ?? null));
	// A failed post leaves the old record, so the next run announces it again.
	if (!stored) io.stderr("docs canary: the warning was not stored; it will be posted again next run");
	else if (io.writeState?.(`${JSON.stringify({ failing: current })}\n`) === false) io.stderr("docs canary: the dedupe record could not be written; the warning will be posted again next run");
	return 1;
}

/** `golden`'s measurement, or `null` with the reason on stderr; it never fails the canary. */
async function measureGolden(io: GoldenIo, base: string, bearer: string): Promise<GoldenRecallReport | null> {
	if (io.goldenRecall === undefined) return null;
	try {
		const report = await io.goldenRecall(base, bearer);
		if (report === null) io.stderr("docs canary: golden recall not measured (no documents to ask about, the scan of docs/ was partial, or a question failed or came back degraded)");
		return report;
	} catch {
		io.stderr("docs canary: golden recall not measured (the documents could not be read)");
		return null;
	}
}

/** Posts the golden report as `substrate`. Best effort: a missing bearer or a refused post is said on stderr and changes no exit code. */
async function reportGolden(io: GoldenIo, base: string, report: GoldenRecallReport): Promise<void> {
	const emitBearer = resolveEmitBearer(io.env, io.readToken);
	if (emitBearer === null) {
		io.stderr("docs canary: golden recall not reported, no substrate bearer (SUBSTRATE_TOKEN_SUBSTRATE, SUBSTRATE_TOKEN or SUBSTRATE_TOKENS_DIR)");
		return;
	}
	if (!(await postEvent(io, base, emitBearer, goldenReportEvent(report, (io.now?.() ?? new Date()).toISOString())))) io.stderr("docs canary: the golden recall report was not stored");
}

/** One event to `POST /events`; true when the server stored it (202). */
async function postEvent(io: GoldenIo, base: string, bearer: string, event: CanaryEvent | GoldenReportEvent): Promise<boolean> {
	try {
		const response = await io.fetchImpl(`${base}/events`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(10_000),
		});
		await response.text();
		return response.status === 202;
	} catch {
		return false;
	}
}

/** Write `text` to `file` through a sibling temp file and a rename, so a crash never leaves half a record; false on any failure. */
export function writeStateAtomically(file: string, text: string): boolean {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, text, { mode: 0o600 });
		renameSync(tmp, file);
		return true;
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// Nothing more to do for a temp file that cannot be removed.
		}
		return false;
	}
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
			goldenRecall: (base, bearer) =>
				measureGoldenRecall(base, bearer, {
					env: process.env,
					fetchImpl: (input, init) => fetch(input, init),
					now: () => performance.now(),
					stderr: (line) => process.stderr.write(`${line}\n`),
				}),
			readState: () => {
				try {
					return readFileSync(process.env.SUBSTRATE_DOCS_CANARY_STATE?.trim() || DEFAULT_CANARY_STATE, "utf8");
				} catch {
					return null;
				}
			},
			writeState: (text) => writeStateAtomically(process.env.SUBSTRATE_DOCS_CANARY_STATE?.trim() || DEFAULT_CANARY_STATE, text),
		}),
	);
}
