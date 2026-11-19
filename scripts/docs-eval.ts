#!/usr/bin/env bun
/**
 * The docs retrieval harness (v1.7 phase 70): a self-supervised golden set scored for recall at k, MRR and latency.
 *
 *   bun scripts/docs-eval.ts                       # offline: fixtures, the lexical retriever and the server's search code, the committed baselines
 *   bun scripts/docs-eval.ts --json                # the same, as one JSON object
 *   bun scripts/docs-eval.ts --write-baseline      # offline: record today's scores as scripts/docs-eval.baseline.json
 *   bun scripts/docs-eval.ts --live URL [--json]   # read-only: this checkout's docs asked of a running server's POST /docs/search
 *   bun scripts/docs-eval.ts --live --emit [--fixtures DIR]   # the canary the timer runs; see below
 *
 * ## Offline (what CI runs)
 *
 * `docs-eval.test.ts` runs it inside `bun test`, so no workflow step is added. The golden set is generated from
 * `packages/corpus/fixtures/eval/` (about thirty invented documents, with copies, near-duplicates and one title in two
 * repositories) and answered twice: by the deterministic lexical retriever of `eval-lexical.ts` alone (`lexical`), and by the
 * production `Substrate.searchDocs` over a fake LightRAG plane that serves that retriever's hits (`server`,
 * `packages/mcp-server/src/docs-eval-server.ts`). Each has its own baseline in `docs-eval.baseline.json`. They guard the
 * pipeline logic around the embeddings (what reaches ranking, the collapse of exact duplicates, the re-rank step, and for
 * `server` the plane client's parsing, citation, sort and cap), not their quality. A fall of more than 0.02 in recall at 5 or
 * 0.03 in MRR against a baseline fails (exit 1); a rise prints a hint to record a new baseline.
 *
 * ## Live (what the canary reads)
 *
 * `--live URL` needs `SUBSTRATE_TOKEN` (the bearer: named here, never printed). It generates the golden set from the Markdown
 * under this checkout's `docs/` (the repository name is `SUBSTRATE_DOCS_EVAL_REPO`), asks the server's `POST /docs/search`,
 * prints the metrics and exits 1 when recall at 5 is under `SUBSTRATE_DOCS_SLO_RECALL5`. A question that failed or came back
 * degraded is counted and left out of the scores, and any such question makes the exit 3: an outage is not a retrieval miss and
 * a partial score must not read as a pass. A question the shared redactor would change (it looks like a credential) is never
 * sent: it is counted as not sent, and a run where every question was held back is exit 3 too. It never runs in tests.
 *
 * ## Canary (`--live --emit`)
 *
 * `--emit` runs the canary of `docs-golden.ts` from this script, with the same refusals (`SUBSTRATE_DOCS_CANARY=1`, an attested `SUBSTRATE_DOCS_CANARY_MANIFEST`, a loopback `SUBSTRATE_URL`), the same fixture set (`--fixtures DIR`, default `fixtures/docs-golden`), the same warning when the failing set changes, the golden recall note, and the freshness, ingest and recall at 5 breaches. Its exit codes are the canary's: 0 pass, 1 a regression or a breach, 2 not configured, 3 unusable, 4 the dedupe record could not be cleared. The timer runs `bun scripts/docs-eval.ts --live --emit --fixtures fixtures/docs-golden`.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
	LIVE_DEFAULT_DATASET,
	LIVE_MAX_QUERIES,
	createLexicalIndex,
	documentKey,
	generateGolden,
	isRecord,
	loadSloThresholds,
	outlineOf,
	resultOf,
	runLiveQueries,
	scoreRun,
	sloBreaches,
	unsafeSkippedLine,
	type EvalDocument,
	type GoldenQuery,
	type LiveRun,
	type QueryResult,
	type Rerank,
	type RunScore,
} from "../packages/corpus/src/index.ts";
import { createServerEvalSearch } from "../packages/mcp-server/src/docs-eval-server.ts";
import { redact } from "../packages/mcp-server/src/redact.ts";
import { firstLine } from "../packages/cli/src/token.ts";
import { loadGoldenCorpus, searchGoldenOffline } from "../packages/mcp-server/src/docs-golden.ts";
import { CORPUS_DIR as GOLDEN_CORPUS_DIR, DEFAULT_CANARY_STATE, readSloReadings, runCanary as runDocsCanary, writeStateAtomically, type GoldenIo } from "./docs-golden.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
export const FIXTURE_DIR = join(REPO_ROOT, "packages", "corpus", "fixtures", "eval");
export const BASELINE_PATH = join(import.meta.dir, "docs-eval.baseline.json");

/** A fall in recall at 5 larger than this fails the run. */
export const RECALL5_TOLERANCE = 0.02;
/** A fall in MRR larger than this fails the run. */
export const MRR_TOLERANCE = 0.03;
/** A rise of at least this much prints the hint to record a new baseline. */
export const IMPROVEMENT_HINT_MIN = 0.005;
/** The repository name the live run expects this checkout's documents to be ingested under. */
export const DEFAULT_EVAL_REPO = "swcstudiospace/agent-substrate";
/** The most documents and the deepest directory the live run reads from the checkout. */
export const LOCAL_DOCS_MAX_FILES = 5000;
export const LOCAL_DOCS_MAX_DEPTH = 8;
/** The canary asks fewer: it runs beside the fixture set, once a day. */
export const CANARY_GOLDEN_MAX_QUERIES = 200;
export const USAGE = "usage: bun scripts/docs-eval.ts [--json] [--write-baseline | --live URL | --live --emit [--fixtures DIR]]; --live needs SUBSTRATE_TOKEN; --emit needs SUBSTRATE_DOCS_CANARY=1 and SUBSTRATE_DOCS_CANARY_MANIFEST";

/** What a baseline records: scores of the deterministic offline run, so no latency. */
export interface Baseline {
	queries: number;
	recall1: number;
	recall5: number;
	recall10: number;
	mrr: number;
}

/**
 * The two committed baselines. `lexical` is the retriever alone (`eval-lexical.ts`); `server` is the same retriever behind the
 * production search code (`searchDocs` over a fake LightRAG plane, `docs-eval-server.ts`). See `docs/corpus-eval.md` for what
 * each one guards.
 */
export interface Baselines {
	lexical: Baseline;
	server: Baseline;
}

/** The scores rounded to four places, the form the baseline file keeps. */
export function baselineOf(score: RunScore): Baseline {
	const round = (value: number): number => Math.round(value * 10_000) / 10_000;
	return { queries: score.queries, recall1: round(score.recall1), recall5: round(score.recall5), recall10: round(score.recall10), mrr: round(score.mrr) };
}

function baselineEntry(parsed: unknown): Baseline | null {
	if (!isRecord(parsed)) return null;
	const { queries, recall1, recall5, recall10, mrr } = parsed;
	const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
	if (typeof queries !== "number" || !Number.isInteger(queries) || queries < 0 || !unit(recall1) || !unit(recall5) || !unit(recall10) || !unit(mrr)) return null;
	return { queries, recall1, recall5, recall10, mrr };
}

/** A baseline file's contents (a `lexical` and a `server` entry), or null when it is not one. */
export function parseBaselines(text: string): Baselines | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const lexical = baselineEntry(parsed.lexical);
	const server = baselineEntry(parsed.server);
	return lexical === null || server === null ? null : { lexical, server };
}

export interface Comparison {
	ok: boolean;
	failures: string[];
	hints: string[];
}

/** The run against its baseline: a fall beyond the tolerance, or fewer questions than the baseline asked, fails. Improvements pass with a hint. */
export function compareToBaseline(score: RunScore, baseline: Baseline): Comparison {
	const failures: string[] = [];
	const hints: string[] = [];
	const now = baselineOf(score);
	// Rounded values compare, so the same run never trips a tolerance through floating-point noise.
	if (baseline.recall5 - now.recall5 > RECALL5_TOLERANCE + 1e-9) failures.push(`recall@5 fell from ${baseline.recall5} to ${now.recall5} (allowed fall ${RECALL5_TOLERANCE})`);
	if (baseline.mrr - now.mrr > MRR_TOLERANCE + 1e-9) failures.push(`MRR fell from ${baseline.mrr} to ${now.mrr} (allowed fall ${MRR_TOLERANCE})`);
	if (now.queries < baseline.queries) failures.push(`the golden set shrank from ${baseline.queries} to ${now.queries} questions`);
	if (failures.length === 0 && (now.recall5 - baseline.recall5 >= IMPROVEMENT_HINT_MIN || now.mrr - baseline.mrr >= IMPROVEMENT_HINT_MIN || now.queries > baseline.queries)) {
		hints.push("scores improved or the set grew: record them with `bun scripts/docs-eval.ts --write-baseline`");
	}
	return { ok: failures.length === 0, failures, hints };
}

interface FixtureManifest {
	documents: Array<{ repo: string; path: string }>;
}

function parseManifest(text: string): FixtureManifest {
	const parsed: unknown = JSON.parse(text);
	const list = isRecord(parsed) ? parsed.documents : undefined;
	if (!Array.isArray(list)) throw new Error("the fixture manifest has no documents list");
	return {
		documents: list.map((entry) => {
			if (!isRecord(entry) || typeof entry.repo !== "string" || typeof entry.path !== "string") throw new Error("a fixture manifest entry needs a repo and a path");
			return { repo: entry.repo, path: entry.path };
		}),
	};
}

/** The fixture corpus: each manifest entry read from `files/<repo>/<path>`. A path that leaves that directory or a missing file is an error, never skipped. */
export function loadFixtureDocuments(dir: string = FIXTURE_DIR): EvalDocument[] {
	const base = resolve(dir, "files");
	return parseManifest(readFileSync(join(dir, "manifest.json"), "utf8")).documents.map(({ repo, path }) => {
		const file = resolve(base, repo, path);
		if (!file.startsWith(`${base}${sep}`)) throw new Error(`fixture ${repo}:${path} points outside the fixture directory`);
		return { repo, path, text: readFileSync(file, "utf8") };
	});
}

/** The documents of a checkout's docs directory, and why the walk did not reach every Markdown file in it. */
export interface LocalDocuments {
	docs: EvalDocument[];
	/** Closed reasons the scan stopped short (`file-limit`, `depth-limit`); empty is a complete scan. */
	incomplete: Array<"file-limit" | "depth-limit">;
}

/** The bounds of a local walk. */
export interface LocalDocumentLimits {
	maxFiles: number;
	maxDepth: number;
}

/** Every `*.md` under `root/subdir` as a document of `repo`, in path order, within the file and depth bounds; a bound that cut the walk is reported, never silent. */
export function collectLocalDocuments(
	root: string,
	repo: string,
	subdir = "docs",
	limits: LocalDocumentLimits = { maxFiles: LOCAL_DOCS_MAX_FILES, maxDepth: LOCAL_DOCS_MAX_DEPTH },
): LocalDocuments {
	const start = join(root, subdir);
	const found: string[] = [];
	const incomplete = new Set<LocalDocuments["incomplete"][number]>();
	const walk = (dir: string, depth: number): void => {
		if (depth > limits.maxDepth) {
			incomplete.add("depth-limit");
			return;
		}
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				// Once the file bound is reached a directory may still hold Markdown, and nothing more is read to find out.
				if (found.length >= limits.maxFiles) incomplete.add("file-limit");
				else walk(path, depth + 1);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				if (found.length >= limits.maxFiles) incomplete.add("file-limit");
				else found.push(path);
			}
		}
	};
	walk(start, 0);
	return {
		docs: found.map((file) => ({ repo, path: relative(root, file).split(sep).join("/"), text: readFileSync(file, "utf8") })),
		incomplete: [...incomplete],
	};
}

export interface OfflineRun {
	golden: GoldenQuery[];
	results: QueryResult[];
	score: RunScore;
	/** Exact-duplicate groups the retriever failed to collapse to their smallest key. Empty is a pass. */
	duplicateFailures: string[];
}

/**
 * The golden set asks nothing that a de-duplication regression would move (a copy is one answer group, so a retriever that
 * answers either copy scores a hit), so a regression there would not show in the scores. Each group of identical documents is
 * therefore probed directly: asked for by its own title, the answer must hold the smallest key of the group once and no other
 * member.
 */
export async function duplicateCollapseFailures(
	docs: readonly EvalDocument[],
	search: (query: string) => readonly (string | null)[] | Promise<readonly (string | null)[]>,
): Promise<string[]> {
	const groups = new Map<string, string[]>();
	for (const doc of docs) {
		const keys = groups.get(doc.text) ?? [];
		keys.push(documentKey(doc.repo, doc.path));
		groups.set(doc.text, keys);
	}
	const failures: string[] = [];
	for (const [text, keys] of groups) {
		if (keys.length < 2) continue;
		const sorted = [...keys].sort();
		const query = outlineOf(text).title ?? text.split(/\s+/).slice(0, 12).join(" ");
		const present = (await search(query)).filter((key): key is string => key !== null && keys.includes(key));
		if (present.length !== 1 || present[0] !== sorted[0]) failures.push(`${sorted.join(" = ")} answered as ${present.length === 0 ? "nothing" : present.join(", ")}`);
	}
	return failures;
}

/** The golden set of `docs`, each question answered by the lexical retriever alone over the same documents. `rerank` plugs the authority scores in. */
export async function runOffline(docs: readonly EvalDocument[], now: () => number, rerank?: Rerank): Promise<OfflineRun> {
	const index = createLexicalIndex(docs.map((doc) => ({ key: documentKey(doc.repo, doc.path), text: doc.text })));
	return runSearch(docs, now, async (query) => index.search(query, { limit: 10, rerank }).map((hit) => hit.key));
}

/**
 * The same golden set answered through the production search code: the real `Substrate.searchDocs` over a fake LightRAG plane
 * that serves the same retriever's hits (`docs-eval-server.ts`). `rerank` plugs in at the plane, so the answer the server sorts,
 * caps and cites is the re-ranked one.
 */
export async function runServer(docs: readonly EvalDocument[], now: () => number, rerank?: Rerank): Promise<OfflineRun> {
	return runSearch(docs, now, createServerEvalSearch(docs, { rerank }));
}

async function runSearch(docs: readonly EvalDocument[], now: () => number, search: (query: string) => Promise<readonly (string | null)[]>): Promise<OfflineRun> {
	const golden = generateGolden(docs);
	const results: QueryResult[] = [];
	for (const question of golden) {
		const began = now();
		const ranked = await search(question.query);
		results.push(resultOf(question, ranked, now() - began));
	}
	const duplicateFailures = await duplicateCollapseFailures(docs, search);
	return { golden, results, score: scoreRun(results), duplicateFailures };
}

export function formatScore(score: RunScore): string {
	return `queries=${score.queries} recall@1=${score.recall1.toFixed(3)} recall@5=${score.recall5.toFixed(3)} recall@10=${score.recall10.toFixed(3)} mrr=${score.mrr.toFixed(3)} p50=${score.p50Ms.toFixed(1)}ms p95=${score.p95Ms.toFixed(1)}ms`;
}

export interface EvalIo extends Partial<Pick<GoldenIo, "readFile" | "readToken" | "readState" | "writeState">> {
	env: Record<string, string | undefined>;
	fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
	now: () => number;
	fixtureDir?: string | undefined;
	baselinePath?: string | undefined;
	repoRoot?: string | undefined;
}

type Mode =
	| { mode: "offline"; json: boolean; writeBaseline: boolean }
	| { mode: "live"; json: boolean; url: string }
	| { mode: "canary"; fixtures: string | undefined }
	| { error: string };

/** `--fixtures DIR` names the canary's fixture set (its `corpus/` sits beside it); only `--emit` takes it. */
export function parseArgs(argv: readonly string[]): Mode {
	const json = argv.includes("--json");
	const emit = argv.includes("--emit");
	const fixtureAt = argv.indexOf("--fixtures");
	const fixtures = fixtureAt === -1 ? undefined : argv[fixtureAt + 1];
	if (fixtureAt !== -1 && (!emit || fixtures === undefined || fixtures === "" || fixtures.startsWith("--"))) return { error: USAGE };
	const rest = argv.filter((arg, index) => arg !== "--json" && arg !== "--emit" && (fixtureAt === -1 || (index !== fixtureAt && index !== fixtureAt + 1)));
	if (emit) return rest.length === 1 && rest[0] === "--live" && !json ? { mode: "canary", fixtures } : { error: USAGE };
	if (rest.length === 0) return { mode: "offline", json, writeBaseline: false };
	if (rest.length === 1 && rest[0] === "--write-baseline" && !json) return { mode: "offline", json, writeBaseline: true };
	if (rest.length === 2 && rest[0] === "--live" && rest[1] !== undefined && /^https?:\/\/\S+$/.test(rest[1])) return { mode: "live", json, url: rest[1] };
	return { error: USAGE };
}

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Offline: exit 0 within tolerance, 1 on a regression or a missing baseline. Live: 0 the SLO holds, 1 it is breached, 2 not configured, 3 unusable. */
export async function main(argv: readonly string[], io: EvalIo): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		io.stderr(parsed.error);
		return 2;
	}
	if (parsed.mode === "live") return runLive(parsed.url, parsed.json, io);
	if (parsed.mode === "canary") return runDocsCanary(canaryIo(io, parsed.fixtures));

	const docs = loadFixtureDocuments(io.fixtureDir ?? FIXTURE_DIR);
	const lexical = await runOffline(docs, io.now);
	const server = await runServer(docs, io.now);
	const baselinePath = io.baselinePath ?? BASELINE_PATH;
	if (parsed.writeBaseline) {
		writeFileSync(baselinePath, `${JSON.stringify({ lexical: baselineOf(lexical.score), server: baselineOf(server.score) }, null, "\t")}\n`);
		io.stdout(`baseline written: lexical ${formatScore(lexical.score)}`);
		io.stdout(`baseline written: server ${formatScore(server.score)}`);
		return 0;
	}
	const text = readTextOrNull(baselinePath);
	const baselines = text === null ? null : parseBaselines(text);
	if (baselines === null) {
		io.stderr("no usable baseline: record one with `bun scripts/docs-eval.ts --write-baseline`");
		return 1;
	}
	const lexicalComparison = compareToBaseline(lexical.score, baselines.lexical);
	const serverComparison = compareToBaseline(server.score, baselines.server);
	const failures = [
		...lexicalComparison.failures.map((failure) => `lexical: ${failure}`),
		...lexical.duplicateFailures.map((failure) => `lexical de-duplication: ${failure}`),
		...serverComparison.failures.map((failure) => `server: ${failure}`),
		...server.duplicateFailures.map((failure) => `server de-duplication: ${failure}`),
	];
	const hints = [...lexicalComparison.hints, ...serverComparison.hints];
	const ok = failures.length === 0;
	if (parsed.json) {
		io.stdout(
			JSON.stringify({
				mode: "offline",
				score: lexical.score,
				baseline: baselines.lexical,
				server: { score: server.score, baseline: baselines.server },
				ok,
				failures,
				hints,
			}),
		);
	} else {
		io.stdout(`lexical ${formatScore(lexical.score)}`);
		io.stdout(`server  ${formatScore(server.score)}`);
		for (const failure of failures) io.stdout(`FAIL ${failure}`);
		for (const hint of new Set(hints)) io.stdout(`hint: ${hint}`);
		io.stdout(ok ? "docs eval: within the baseline" : "docs eval: REGRESSION against the baseline");
	}
	return ok ? 0 : 1;
}

/** A live run and the walk it was asked from. */
export interface LiveAsked {
	asked: number;
	live: LiveRun;
	/** Why the local scan did not reach every document; empty is a full scan. */
	incomplete: LocalDocuments["incomplete"];
}

/** The golden set of this checkout's `docs/`, asked of the server at `url` as `token`. */
export async function askLive(
	url: string,
	token: string,
	io: Pick<EvalIo, "env" | "fetchImpl" | "now" | "repoRoot">,
	maxQueries: number = LIVE_MAX_QUERIES,
): Promise<LiveAsked> {
	const repo = io.env.SUBSTRATE_DOCS_EVAL_REPO?.trim() || DEFAULT_EVAL_REPO;
	const { docs, incomplete } = collectLocalDocuments(io.repoRoot ?? REPO_ROOT, repo);
	const golden = generateGolden(docs, { maxQueries });
	// The same check ingest applies to a document: a question that the redactor would change is never sent.
	const live = await runLiveQueries(golden, { base: url, token, fetchImpl: io.fetchImpl, now: io.now, unsafe: (text) => redact(text) !== text });
	return { asked: golden.length, live, incomplete };
}

async function runLive(url: string, json: boolean, io: EvalIo): Promise<number> {
	const token = io.env.SUBSTRATE_TOKEN?.trim();
	if (!token) {
		io.stderr(USAGE);
		return 2;
	}
	const { asked, live, incomplete } = await askLive(url, token, io);
	return reportLive(asked, live, json, io, incomplete);
}

/**
 * The canary's outside world, from this script's own: the same fetch and host readers `docs-golden.ts` wires in production, and this
 * checkout's golden recall and SLO readings, so `--emit` runs the canary's checks unchanged. `--fixtures DIR` moves the fixture set and
 * its `corpus/` together; without it the canary reads the repository's own.
 */
function canaryIo(io: EvalIo, fixtures: string | undefined): GoldenIo {
	const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
		io.fetchImpl(input instanceof Request ? input.url : String(input), init);
	const corpusDir = fixtures === undefined ? GOLDEN_CORPUS_DIR : join(fixtures, "corpus");
	const statePath = io.env.SUBSTRATE_DOCS_CANARY_STATE?.trim() || DEFAULT_CANARY_STATE;
	const canary: GoldenIo = {
		env: io.env,
		fetchImpl,
		stdout: io.stdout,
		stderr: io.stderr,
		offline: async (fixture) =>
			(await searchGoldenOffline(loadGoldenCorpus(corpusDir), fixture, { commit: fixture.corpus_manifest.dataset_commit ?? "golden-offline" })).reply,
		corpusDir,
		readToken: io.readToken ?? firstLine,
		readState: io.readState ?? (() => readTextOrNull(statePath)),
		writeState: io.writeState ?? ((text) => writeStateAtomically(statePath, text)),
		now: () => new Date(),
		goldenRecall: (base, bearer) => measureGoldenRecall(base, bearer, io),
		sloReadings: (base, bearer) => readSloReadings(base, bearer, { fetchImpl, now: () => new Date(), stderr: io.stderr }),
	};
	if (io.readFile !== undefined) canary.readFile = io.readFile;
	if (fixtures !== undefined) canary.fixtureDir = fixtures;
	return canary;
}

/**
 * What the canary reports on the events route: the recall at 5 of the golden set and how many questions were measured (answered and
 * scored). A question the credential guard held back was generated but never asked, so it is not in `asked`; the stderr line says
 * how many were held back.
 */
export interface GoldenRecallReport {
	recall5: number;
	asked: number;
}

/**
 * The canary's measurement: null when it could not be taken (no documents to ask about, or any question failed, came back
 * degraded or was left unasked, or the scan of `docs/` was partial), because a recall over the answered questions or the scanned
 * documents alone would read as better than it is. A partial scan says why on stderr.
 */
export async function measureGoldenRecall(
	url: string,
	token: string,
	io: Pick<EvalIo, "env" | "fetchImpl" | "now" | "repoRoot" | "stderr">,
): Promise<GoldenRecallReport | null> {
	const { live, incomplete } = await askLive(url, token, io, CANARY_GOLDEN_MAX_QUERIES);
	if (incomplete.length > 0) {
		io.stderr(`docs canary: golden recall not measured, the scan of docs/ was partial (${incomplete.join(", ")}); a recall over part of the documents is not reported`);
		return null;
	}
	const skipped = unsafeSkippedLine(live.skippedUnsafe);
	if (skipped !== "") io.stderr(`docs canary: ${skipped}`);
	if (live.failed > 0 || live.degraded > 0 || live.aborted !== null || live.results.length === 0) return null;
	return { recall5: scoreRun(live.results).recall5, asked: live.results.length };
}

/**
 * Prints a live run and returns its exit code. Shared with the canary, which reports the same recall. A partial scan is said in
 * both forms and in the verdict line; it never changes the exit code, which is the SLO's.
 */
export function reportLive(
	asked: number,
	live: LiveRun,
	json: boolean,
	io: Pick<EvalIo, "env" | "stdout" | "stderr">,
	incomplete: readonly string[] = [],
): number {
	const score = scoreRun(live.results);
	const thresholds = loadSloThresholds(io.env);
	const breaches = sloBreaches({ freshnessS: null, recall5: live.results.length === 0 ? null : score.recall5, ingestDocsPerS: null }, thresholds);
	const unusable = live.failed > 0 || live.degraded > 0 || live.aborted !== null || live.results.length === 0;
	const partial = incomplete.length > 0;
	if (json) {
		io.stdout(
			JSON.stringify({ mode: "live", dataset: LIVE_DEFAULT_DATASET, asked, answered: live.results.length, failed: live.failed, degraded: live.degraded, skippedUnsafe: live.skippedUnsafe, aborted: live.aborted, partial, incomplete, score, threshold: thresholds.recall5, breaches }),
		);
	} else {
		io.stdout(formatScore(score));
		io.stdout(`asked ${asked}, answered ${live.results.length}, failed ${live.failed}, degraded ${live.degraded}${live.aborted === null ? "" : `, stopped early (${live.aborted})`}`);
		if (live.skippedUnsafe > 0) io.stdout(unsafeSkippedLine(live.skippedUnsafe));
		if (breaches.length > 0) io.stdout(`FAIL recall@5 ${score.recall5.toFixed(3)} is under the SLO ${thresholds.recall5}${partial ? " (partial scan)" : ""}`);
		else if (partial && !unusable) io.stdout(`PARTIAL recall@5 ${score.recall5.toFixed(3)} holds the SLO ${thresholds.recall5} over a partial scan`);
	}
	if (partial) io.stderr(`docs eval: the scan of docs/ was partial (${incomplete.join(", ")}); the scores cover only the documents it reached`);
	if (unusable) {
		io.stderr("docs eval: not every question could be scored (failed, degraded, stopped early or none answered); the scores above cover only the answered ones");
		return 3;
	}
	return breaches.length > 0 ? 1 : 0;
}

if (import.meta.main) {
	process.exit(
		await main(process.argv.slice(2), {
			env: process.env,
			fetchImpl: (input, init) => fetch(input, init),
			stdout: (line) => process.stdout.write(`${line}\n`),
			stderr: (line) => process.stderr.write(`${line}\n`),
			now: () => performance.now(),
		}),
	);
}
