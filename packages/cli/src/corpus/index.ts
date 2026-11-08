/**
 * `substrate corpus scan|plan|ingest|reflect|status|prove|verify` (v1.7 phases 63, 66 and 69) and `sync|watch|reconcile|hint|hook` (phase 65).
 *
 *   substrate corpus scan   [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--source fs|github|greptile]...
 *                           [--greptile-dir DIR] [--github-owner OWNER] [--max-repos N] [--json] [--entries]
 *   substrate corpus plan   (scan options) [--server URL] [--neardup [--threshold N] [--neardup-max N]]
 *   substrate corpus ingest (plan options) [--execute] [--batch-docs N] [--batch-bytes N]
 *   substrate corpus reflect [--repo R]... [--root DIR]... [--max-bytes N] [--server URL] [--execute] [--json]
 *   substrate corpus status [--server URL] [--json] [--gaps [--limit N]]
 *   substrate corpus eval [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--max-queries N] [--server URL] [--json]
 *   substrate corpus sync   [--repo R]... [--root DIR]... [--execute] [--fetch] [--json]
 *   substrate corpus watch  [--root DIR]... [--sweep-s N] [--once]
 *   substrate corpus reconcile [--execute] [--json]
 *   substrate corpus hook install|uninstall|status --repo DIR
 *   substrate corpus hint   --repo DIR
 *   substrate corpus prove  --repo R --path P [--out FILE] [--server URL]
 *   substrate corpus verify FILE [--online] [--server URL] [--json]
 *
 * Discovery runs here, where the files are; the server never reads a path. `scan` needs no server. `plan` sends entries
 * without bodies; with `--neardup` it then sends the first 4000 characters of each local document the plan would write to
 * `POST /corpus/neardup` and prints the pairs that look alike (advisory: nothing is dropped on that signal). `ingest` is a dry run until `--execute`, then sends the tombstones first, as requests of their own, and
 * then the bodies of the documents the plan says must change in bounded batches. `reflect` builds one digest per repository
 * from its `.planning` files and is a dry run until `--execute`. Exit codes: 0 done (every document ingested, updated, unchanged or tombstoned; every digest stored or unchanged), 1 a request failed, any document or digest ended refused or failed, or a requested near-duplicate comparison could not be answered, 2 usage.
 * `prove` asks the server for one document's inclusion proof and prints it (and writes it with --out). `verify` checks such a file
 * offline, with no server; with --online it also asks the server whether the root is inside an anchored hour, and with no answer
 * it says the anchor check was skipped. `verify` exits 0 valid, 1 invalid (a proof that does not hold, or an anchor answer that
 * contradicts it), 2 usage.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	CORPUS_PROTOCOL,
	CORPUS_SOURCES,
	DEFAULT_GITHUB_MAX_REPOS,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_TIER,
	MAX_GAPS_LIMIT,
	LIVE_MAX_QUERIES,
	MAX_INGEST_DOCUMENTS,
	loadSloThresholds,
	MAX_NEARDUP_ITEMS,
	MAX_NEARDUP_THRESHOLD,
	MIN_NEARDUP_THRESHOLD,
	isCorpusSource,
	isDocTier,
	type CorpusAnchorResponse,
	type CorpusNeardupResponse,
	type CorpusPlanRequest,
	type CorpusSource,
	type DocTier,
	type GhRunner,
	type GitBytesRunner,
	type GitRunner,
	defaultGitBytesRunner,
} from "@substrate/corpus";
import { createBodyStore, type BodyStore } from "./bodies.ts";
import { createCorpusClient, isProofResponse, type ClientError, type CorpusClient } from "./client.ts";
import { evaluateCorpus, readEvalDocuments } from "./eval.ts";
import { createHttpEmitter, type EmitDocsSync } from "./events.ts";
import { type FlagSpec, last, type Parsed, parseFlags, positiveInt } from "./flags.ts";
import { executeIngest } from "./ingest.ts";
import { collectInventory, type Inventory, type InventoryOptions } from "./inventory.ts";
import { neardupRequest, prefixReaderOf, selectNeardupItems } from "./neardup.ts";
import { conflictWith, MAX_PROOF_FILE_BYTES, verifyProofOffline } from "./proof.ts";
import { collectDigests, executeReflect, type ReflectCollection } from "./reflect.ts";
import {
	isValidReport,
	jsonVerifyReport,
	printable,
	renderGaps,
	renderIngest,
	renderInventory,
	renderNeardup,
	renderPlan,
	renderReflectOutcome,
	renderReflectPlan,
	renderStatus,
	renderVerify,
	supersededEntries,
	type VerifyReport,
} from "./render.ts";
import { corpusScopeRefusal, type LocalAudit, type LocalTarget } from "./scope.ts";
import {
	HOOK_ACTIONS,
	type HookAction,
	type LoopSeams,
	runHintCommand,
	runHookCommand,
	runReconcileCommand,
	runSyncCommand,
	runWatchCommand,
	type WatchContext,
} from "./watch-commands.ts";
import { MAX_SWEEP_S, MIN_SWEEP_S, readWatchSettings } from "./watch-settings.ts";

export const USAGE =
	"substrate corpus scan [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--source fs|github|greptile]... [--greptile-dir DIR]\n" +
	"                      [--github-owner OWNER] [--max-repos N] [--json] [--entries]\n" +
	"substrate corpus plan [scan options] [--server URL] [--json] [--neardup [--threshold 0.5-1] [--neardup-max N]]   (--neardup is advisory: nothing is dropped on it; N is at most 1000)\n" +
	"substrate corpus ingest [plan options] [--execute] [--batch-docs N] [--batch-bytes N]   (a dry run without --execute; --batch-docs is capped at the server limit of 200)\n" +
	"substrate corpus reflect [--repo R]... [--root DIR]... [--max-bytes N] [--server URL] [--execute] [--json]\n" +
	"                      (digest of each repository's .planning/STATE.md and ROADMAP.md; a dry run without --execute; exits 1 when a digest was refused or failed or a repository could not be digested)\n" +
	"substrate corpus status [--server URL] [--json] [--gaps [--limit N]]   (--gaps lists the queries the corpus could not answer; --limit is capped at the server limit of 200)\n" +
	"substrate corpus eval [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--max-queries N] [--server URL] [--json]   (the golden set of the local scan; without --server it only counts the questions; exit 1 when recall at 5 is under SUBSTRATE_DOCS_SLO_RECALL5 or the run could not be scored in full; a scan that skipped a repository is listed and labelled partial)\n" +
	"substrate corpus sync [--repo R]... [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--server URL] [--execute] [--fetch] [--json]\n" +
	"                      (reads only the named repositories through the mirror view; a dry run without --execute; --fetch updates the mirrors first)\n" +
	"substrate corpus watch [--root DIR]... [--sweep-s N] [--server URL] [--once]   (a long-running loop; --once runs one sweep and exits)\n" +
	"substrate corpus reconcile [--root DIR]... [--server URL] [--execute] [--json]   (compares the manifest with the docs plane; a dry run without --execute)\n" +
	"substrate corpus hook install|uninstall|status --repo DIR   (opt-in git hooks for post-merge, post-checkout and post-rewrite hints)\n" +
	"substrate corpus hint --repo DIR   (writes one hint to the spool; what the hooks run; exits 0)\n" +
	"substrate corpus prove --repo R --path P [--out FILE] [--server URL]   (prints the inclusion proof of one document)\n" +
	"substrate corpus verify FILE [--online] [--server URL] [--json]   (0 valid, 1 invalid, 2 usage; offline unless --online)\n";

const DEFAULT_ROOT = "/root/src/repos";
const DEFAULT_BATCH_DOCS = 20;
const DEFAULT_BATCH_BYTES = 1_000_000;
/** A plan or an ingest batch of a few thousand entries is megabytes of JSON; the server needs time to judge it. */
export const CORPUS_TIMEOUT_MS = 120_000;

interface CorpusDeps {
	/** The substrate's base URL, without a trailing slash. */
	url: string;
	token: string | undefined;
	timeoutMs: number;
	env: Record<string, string | undefined>;
	out: (text: string) => void;
	err: (text: string) => void;
	/** Test seams. */
	fetchImpl?: typeof fetch | undefined;
	runner?: GitRunner | undefined;
	gh?: GhRunner | undefined;
	readFile?: ((path: string) => Uint8Array) | undefined;
	/** Test seams of `sync`, `reconcile` and `watch`. */
	git?: GitBytesRunner | undefined;
	emit?: EmitDocsSync | undefined;
	now?: (() => number) | undefined;
	watch?: Partial<LoopSeams> | undefined;
	/** Reads at most `maxBytes` from the start of a file; the near-duplicate excerpts use it so a large file is never loaded whole. Defaults to `readFile` cut to the budget when only that is injected. */
	readPrefix?: ((path: string, maxBytes: number) => Uint8Array) | undefined;
	/** Test seam of `prove --out`. */
	writeFile?: ((path: string, text: string) => void) | undefined;
	/** Audits a refused request (phase 72); the CLI wires the ledger, and a refusal is never blocked by a failed write. */
	audit?: LocalAudit | undefined;
}

const SCAN_VALUES = ["root", "tier", "max-bytes", "source", "greptile-dir", "github-owner", "max-repos"] as const;

const SPECS: Record<string, FlagSpec> = {
	scan: { values: SCAN_VALUES, bools: ["json", "entries", "help"] },
	plan: { values: [...SCAN_VALUES, "server", "threshold", "neardup-max"], bools: ["json", "neardup", "help"] },
	ingest: { values: [...SCAN_VALUES, "server", "batch-docs", "batch-bytes"], bools: ["json", "execute", "help"] },
	status: { values: ["server", "limit"], bools: ["json", "gaps", "help"] },
	reflect: { values: ["repo", "root", "max-bytes", "server"], bools: ["json", "execute", "help"] },
	eval: { values: ["root", "tier", "max-bytes", "max-queries", "server"], bools: ["json", "help"] },
	sync: { values: ["repo", "root", "tier", "max-bytes", "server", "batch-docs", "batch-bytes"], bools: ["execute", "fetch", "json", "help"] },
	watch: { values: ["root", "tier", "max-bytes", "server", "sweep-s", "batch-docs", "batch-bytes"], bools: ["once", "help"] },
	reconcile: { values: ["root", "tier", "max-bytes", "server", "batch-docs", "batch-bytes"], bools: ["execute", "json", "help"] },
	hint: { values: ["repo"], bools: ["help"] },
	hook: { values: ["repo"], bools: ["help"] },
	prove: { values: ["repo", "path", "out", "server"], bools: ["help"] },
	verify: { values: ["server"], bools: ["json", "online", "help"], positionals: 1 },
};

interface ScanArgs {
	roots: string[];
	maxTier: DocTier;
	maxBytes: number;
	sources: CorpusSource[];
	greptileDir: string | undefined;
	githubOwner: string | undefined;
	maxRepos: number;
}

/** `--root` values, else the colon-separated `SUBSTRATE_CORPUS_ROOTS`, else the default root. */
function resolveRoots(parsed: Parsed, env: Record<string, string | undefined>): string[] {
	const configured = (env.SUBSTRATE_CORPUS_ROOTS ?? "").split(":").filter((root) => root !== "");
	return parsed.values.get("root") ?? (configured.length > 0 ? configured : [DEFAULT_ROOT]);
}

/**
 * What a corpus command would run git in, hook, or name, before it runs (phase 72). `scan`, `plan`, `ingest` and `eval` run git
 * over their roots only when the filesystem source is selected. `hint` writes a spool file and runs no git, so it has no target.
 */
function localTargets(sub: string, parsed: Parsed, env: Record<string, string | undefined>): LocalTarget[] {
	const roots = (): LocalTarget[] => resolveRoots(parsed, env).map((path) => ({ path }));
	const repos = (): LocalTarget[] => (parsed.values.get("repo") ?? []).map((repo) => ({ repo }));
	if (sub === "scan" || sub === "plan" || sub === "ingest" || sub === "eval") {
		const sources = (parsed.values.get("source") ?? ["fs"]).flatMap((text) => text.split(","));
		return sources.includes("fs") ? roots() : [];
	}
	if (sub === "reflect" || sub === "sync") return [...roots(), ...repos()];
	if (sub === "watch" || sub === "reconcile") return roots();
	if (sub === "hook") {
		const repo = last(parsed, "repo");
		return repo === undefined ? [] : [{ path: resolve(repo) }];
	}
	return [];
}

function resolveScanArgs(parsed: Parsed, env: Record<string, string | undefined>): ScanArgs | string {
	const tierText = last(parsed, "tier");
	const tier = tierText === undefined ? DEFAULT_MAX_TIER : Number(tierText);
	if (!isDocTier(tier)) return "--tier must be 1, 2 or 3";
	let maxBytes = DEFAULT_MAX_BYTES;
	const bytesText = last(parsed, "max-bytes");
	if (bytesText !== undefined) {
		const value = positiveInt(bytesText);
		if (value === null) return "--max-bytes must be a positive integer";
		maxBytes = value;
	}
	let maxRepos = DEFAULT_GITHUB_MAX_REPOS;
	const reposText = last(parsed, "max-repos");
	if (reposText !== undefined) {
		const value = positiveInt(reposText);
		if (value === null) return "--max-repos must be a positive integer";
		maxRepos = value;
	}
	const sources: CorpusSource[] = [];
	for (const text of parsed.values.get("source") ?? ["fs"]) {
		for (const name of text.split(",")) {
			if (!isCorpusSource(name)) return `--source must be one of ${CORPUS_SOURCES.join(", ")}`;
			if (!sources.includes(name)) sources.push(name);
		}
	}
	const greptileDir = last(parsed, "greptile-dir");
	const githubOwner = last(parsed, "github-owner");
	if (sources.includes("greptile") && greptileDir === undefined) return "--source greptile needs --greptile-dir DIR";
	if (sources.includes("github") && githubOwner === undefined) return "--source github needs --github-owner OWNER";
	return {
		roots: resolveRoots(parsed, env),
		maxTier: tier,
		maxBytes,
		sources,
		greptileDir,
		githubOwner,
		maxRepos,
	};
}

function inventoryOptions(args: ScanArgs, deps: CorpusDeps, onBody: InventoryOptions["onBody"]): InventoryOptions {
	return {
		roots: args.roots,
		maxTier: args.maxTier,
		maxBytes: args.maxBytes,
		sources: args.sources,
		greptileDir: args.greptileDir,
		githubOwner: args.githubOwner,
		maxRepos: args.maxRepos,
		runner: deps.runner,
		gh: deps.gh,
		readFile: deps.readFile,
		onBody,
	};
}

function jsonReport(inventory: Inventory, withEntries: boolean): string {
	const bytes = inventory.entries.reduce((sum, entry) => sum + entry.bytes, 0);
	return `${JSON.stringify(
		{
			...(withEntries ? { entries: inventory.entries } : {}),
			report: {
				sources: inventory.sources,
				maxTier: inventory.maxTier,
				totals: { files: inventory.entries.length, bytes },
				scope: inventory.scope,
				...inventory.report,
			},
		},
		null,
		2,
	)}\n`;
}

function describeError(error: ClientError): string {
	return printable(error.message);
}

export async function runCorpus(argv: string[], deps: CorpusDeps): Promise<number> {
	const sub = argv[0];
	if (sub === "--help" || sub === "-h" || sub === "help") {
		deps.out(USAGE);
		return 0;
	}
	const spec = sub !== undefined && Object.hasOwn(SPECS, sub) ? SPECS[sub] : undefined;
	if (sub === undefined || spec === undefined) {
		deps.err(USAGE);
		return 2;
	}
	if (argv.includes("--help") || argv.includes("-h")) {
		deps.out(USAGE);
		return 0;
	}
	// `hook` takes its action as the word after the subcommand.
	const parsed = parseFlags(argv.slice(sub === "hook" ? 2 : 1), spec);
	if (typeof parsed === "string") {
		deps.err(`[substrate] corpus ${sub}: ${parsed}\n${USAGE}`);
		return 2;
	}
	const usage = (message: string): number => {
		deps.err(`[substrate] corpus ${sub}: ${message}\n`);
		return 2;
	};
	// Phase 72: a root, hook directory or repository the registry does not place is refused before any git call or hook write.
	const refusal = await corpusScopeRefusal(sub, deps.env, localTargets(sub, parsed, deps.env), deps.audit);
	if (refusal !== null) {
		deps.err(`[substrate] corpus ${sub}: ${refusal}`);
		return 2;
	}
	try {
		if (sub === "status") return await status(parsed, deps);
		if (sub === "hint" || sub === "hook") return hintOrHook(sub, argv[1], parsed, deps, usage);
		if (sub === "reflect") return await reflect(parsed, deps);
		if (sub === "prove") return await prove(parsed, deps);
		if (sub === "verify") return await verify(parsed, deps);
		const args = resolveScanArgs(parsed, deps.env);
		if (typeof args === "string") return usage(args);
		if (sub === "scan") {
			const inventory = await collectInventory(inventoryOptions(args, deps, undefined));
			deps.out(parsed.bools.has("json") ? jsonReport(inventory, parsed.bools.has("entries")) : renderInventory(inventory));
			return 0;
		}
		if (sub === "plan") {
			const neardup = resolveNeardupArgs(parsed);
			if (typeof neardup === "string") return usage(neardup);
			return await plan(args, parsed, deps, neardup);
		}
		if (sub === "eval") return await evaluate(args, parsed, deps);
		const docsFlag = last(parsed, "batch-docs");
		const bytesFlag = last(parsed, "batch-bytes");
		const batchDocs = docsFlag === undefined ? positiveInt(deps.env.SUBSTRATE_CORPUS_BATCH_DOCS) ?? DEFAULT_BATCH_DOCS : positiveInt(docsFlag);
		const batchBytes = bytesFlag === undefined ? positiveInt(deps.env.SUBSTRATE_CORPUS_BATCH_BYTES) ?? DEFAULT_BATCH_BYTES : positiveInt(bytesFlag);
		if (batchDocs === null) return usage("--batch-docs must be a positive integer");
		if (batchBytes === null) return usage("--batch-bytes must be a positive integer");
		if (sub === "sync" || sub === "watch" || sub === "reconcile") {
			return await watchFamily(sub, args, parsed, deps, Math.min(batchDocs, MAX_INGEST_DOCUMENTS), batchBytes, usage);
		}
		// The server refuses a request of more documents than its limit, which would stop the whole ingest, so a larger value is lowered.
		const docsPerRequest = Math.min(batchDocs, MAX_INGEST_DOCUMENTS);
		if (docsPerRequest < batchDocs) deps.err(`[substrate] corpus ingest: batch of ${batchDocs} documents is above the server limit; using ${docsPerRequest}\n`);
		return await ingest(args, parsed, deps, docsPerRequest, batchBytes);
	} catch (cause) {
		deps.err(`[substrate] corpus ${sub} failed: ${printable(cause instanceof Error ? cause.message : String(cause))}\n`);
		return 1;
	}
}

function serverUrl(parsed: Parsed, deps: CorpusDeps): string {
	return (last(parsed, "server") ?? deps.url).replace(/\/+$/, "");
}

function hintOrHook(sub: "hint" | "hook", action: string | undefined, parsed: Parsed, deps: CorpusDeps, usage: (message: string) => number): number {
	const repo = last(parsed, "repo");
	if (repo === undefined) return usage("--repo DIR is required");
	if (sub === "hint") return runHintCommand({ settings: readWatchSettings(deps.env), now: deps.now ?? Date.now, err: deps.err }, repo);
	const known = HOOK_ACTIONS.find((candidate): candidate is HookAction => candidate === action);
	if (known === undefined) return usage("hook needs one of install, uninstall, status");
	return runHookCommand({ out: deps.out, env: deps.env }, known, resolve(repo));
}

async function watchFamily(
	sub: "sync" | "watch" | "reconcile",
	args: ScanArgs,
	parsed: Parsed,
	deps: CorpusDeps,
	batchDocs: number,
	batchBytes: number,
	usage: (message: string) => number,
): Promise<number> {
	const url = serverUrl(parsed, deps);
	const context: WatchContext = {
		client: clientFor(parsed, deps),
		roots: args.roots,
		maxTier: args.maxTier,
		maxBytes: args.maxBytes,
		batchDocs,
		batchBytes,
		settings: readWatchSettings(deps.env),
		runner: deps.runner,
		git: deps.git ?? defaultGitBytesRunner,
		readFile: deps.readFile ?? ((path) => readFileSync(path)),
		emit: deps.emit ?? createHttpEmitter({ url, token: deps.token, fetchImpl: deps.fetchImpl }),
		now: deps.now ?? Date.now,
		out: deps.out,
		err: deps.err,
		loop: deps.watch,
	};
	if (sub === "sync") {
		return await runSyncCommand(context, {
			repos: parsed.values.get("repo") ?? [],
			execute: parsed.bools.has("execute"),
			fetch: parsed.bools.has("fetch"),
			json: parsed.bools.has("json"),
		});
	}
	if (sub === "reconcile") return await runReconcileCommand(context, { execute: parsed.bools.has("execute"), json: parsed.bools.has("json") });
	const sweepText = last(parsed, "sweep-s");
	const sweepS = positiveInt(sweepText);
	if (sweepText !== undefined && (sweepS === null || sweepS < MIN_SWEEP_S || sweepS > MAX_SWEEP_S)) {
		return usage(`--sweep-s must be a whole number of seconds from ${MIN_SWEEP_S} to ${MAX_SWEEP_S}`);
	}
	return await runWatchCommand(context, { once: parsed.bools.has("once"), sweepS: sweepS ?? undefined });
}

function clientFor(parsed: Parsed, deps: CorpusDeps): CorpusClient {
	return createCorpusClient({
		url: serverUrl(parsed, deps),
		token: deps.token,
		timeoutMs: deps.timeoutMs,
		fetchImpl: deps.fetchImpl,
	});
}

async function status(parsed: Parsed, deps: CorpusDeps): Promise<number> {
	const gaps = parsed.bools.has("gaps");
	const limitText = last(parsed, "limit");
	if (limitText !== undefined && !gaps) {
		deps.err("[substrate] corpus status: --limit applies to --gaps\n");
		return 2;
	}
	let limit: number | undefined;
	if (limitText !== undefined) {
		limit = positiveInt(limitText) ?? undefined;
		if (limit === undefined) {
			deps.err("[substrate] corpus status: --limit must be a positive integer\n");
			return 2;
		}
		// The server refuses a limit above its maximum, so a larger value is lowered.
		if (limit > MAX_GAPS_LIMIT) {
			deps.err(`[substrate] corpus status: limit of ${limit} is above the server limit; using ${MAX_GAPS_LIMIT}\n`);
			limit = MAX_GAPS_LIMIT;
		}
	}
	const client = clientFor(parsed, deps);
	if (gaps) {
		const answered = await client.gaps(limit);
		if (!answered.ok) {
			deps.err(`[substrate] corpus status --gaps failed: ${describeError(answered.error)}\n`);
			return 1;
		}
		deps.out(parsed.bools.has("json") ? `${JSON.stringify(answered.value, null, 2)}\n` : renderGaps(answered.value));
		return 0;
	}
	const result = await client.status();
	if (!result.ok) {
		deps.err(`[substrate] corpus status failed: ${describeError(result.error)}\n`);
		return 1;
	}
	deps.out(parsed.bools.has("json") ? `${JSON.stringify(result.value, null, 2)}\n` : renderStatus(result.value));
	return 0;
}

/** The digest JSON: what would be sent (the text included), what could not be built and why. */
function digestJson(collection: ReflectCollection): unknown[] {
	return collection.digests.map((digest) => ({
		repo: digest.repo,
		path: digest.path,
		key: digest.key,
		sha256: digest.sha256,
		chars: digest.text.length,
		text: digest.text,
	}));
}

async function reflect(parsed: Parsed, deps: CorpusDeps): Promise<number> {
	const execute = parsed.bools.has("execute");
	const json = parsed.bools.has("json");
	const bytesText = last(parsed, "max-bytes");
	const maxBytes = bytesText === undefined ? DEFAULT_MAX_BYTES : positiveInt(bytesText);
	if (maxBytes === null) {
		deps.err("[substrate] corpus reflect: --max-bytes must be a positive integer\n");
		return 2;
	}
	const collection = collectDigests({
		roots: resolveRoots(parsed, deps.env),
		repos: parsed.values.get("repo") ?? [],
		maxBytes,
		runner: deps.runner,
		readFile: deps.readFile,
	});
	// A repository that has a STATE and could not be digested, or one asked for and not found, is an incomplete run.
	const incomplete = collection.skipped.length > 0;
	if (!execute) {
		deps.out(
			json
				? `${JSON.stringify({ dryRun: true, checkouts: collection.checkouts, digests: digestJson(collection), skipped: collection.skipped, notes: collection.notes }, null, 2)}\n`
				: `${renderReflectPlan(collection, false)}dry run: nothing was sent; add --execute to send these digests\n`,
		);
		return incomplete ? 1 : 0;
	}
	const outcome = await executeReflect({ digests: collection.digests, client: clientFor(parsed, deps) });
	if (!json) deps.out(renderReflectPlan(collection, true));
	deps.out(
		json
			? `${JSON.stringify({ checkouts: collection.checkouts, reflect: outcome.summary, skipped: collection.skipped, notes: collection.notes, fatal: outcome.fatal }, null, 2)}\n`
			: renderReflectOutcome(outcome.summary),
	);
	if (outcome.fatal !== null) deps.err(`[substrate] corpus reflect stopped: ${describeError(outcome.fatal)}\n`);
	const { failed, refused } = outcome.summary.counts;
	return outcome.fatal !== null || failed > 0 || refused > 0 || incomplete ? 1 : 0;
}

/** `corpus eval`: the golden set of the local scan, asked of the server when `--server` names one. Read-only on both sides. */
async function evaluate(args: ScanArgs, parsed: Parsed, deps: CorpusDeps): Promise<number> {
	let maxQueries = LIVE_MAX_QUERIES;
	const queriesFlag = last(parsed, "max-queries");
	if (queriesFlag !== undefined) {
		const value = positiveInt(queriesFlag);
		if (value === null) {
			deps.err("[substrate] corpus eval: --max-queries must be a positive integer\n");
			return 2;
		}
		// The same ceiling the script and the canary ask under, so a typo cannot turn a read into thousands of searches.
		maxQueries = Math.min(value, LIVE_MAX_QUERIES);
		if (maxQueries < value) deps.err(`[substrate] corpus eval: ${value} questions is above the limit; asking ${maxQueries}\n`);
	}
	const serverFlag = last(parsed, "server");
	if (serverFlag !== undefined && !/^https?:\/\/\S+$/.test(serverFlag)) {
		deps.err("[substrate] corpus eval: --server must be an http(s) URL\n");
		return 2;
	}
	if (serverFlag !== undefined && deps.token === undefined) {
		deps.err("[substrate] corpus eval: --server needs a token (SUBSTRATE_TOKEN, SUBSTRATE_TOKEN_FILE or the tokens directory)\n");
		return 2;
	}
	const inventory = await collectInventory(inventoryOptions(args, deps, undefined));
	const documents = readEvalDocuments(inventory, deps.readFile ?? ((path) => readFileSync(path)));
	const fetchImpl = deps.fetchImpl ?? fetch;
	const outcome = await evaluateCorpus({
		documents,
		maxQueries,
		thresholds: loadSloThresholds(deps.env),
		server:
			serverFlag === undefined || deps.token === undefined
				? null
				: { url: serverFlag.replace(/\/+$/, ""), token: deps.token, fetchImpl: (input, init) => fetchImpl(input, init) },
		json: parsed.bools.has("json"),
		now: () => performance.now(),
	});
	deps.out(outcome.text);
	if (outcome.warning !== "") deps.err(outcome.warning);
	return outcome.code;
}

async function prove(parsed: Parsed, deps: CorpusDeps): Promise<number> {
	const repo = last(parsed, "repo");
	const path = last(parsed, "path");
	if (repo === undefined || path === undefined) {
		deps.err("[substrate] corpus prove: --repo and --path are required\n");
		return 2;
	}
	const result = await clientFor(parsed, deps).proof(repo, path);
	if (!result.ok) {
		deps.err(`[substrate] corpus prove failed: ${printable(describeError(result.error))}\n`);
		return 1;
	}
	// A proof is handed on only after it holds, so a server that answers with one that does not is reported, not written.
	const verdict = verifyProofOffline(result.value);
	if (!verdict.valid) {
		deps.err(`[substrate] corpus prove failed: the server's proof does not verify: ${printable(verdict.reason)}\n`);
		return 1;
	}
	// A valid proof of another document is still not the one asked for: the file would claim a document it does not cover.
	if (result.value.repo !== repo || result.value.documentPath !== path) {
		deps.err(
			`[substrate] corpus prove failed: the server answered with a proof for a different document (${printable(result.value.repo)} ${printable(result.value.documentPath)}), not ${printable(repo)} ${printable(path)}\n`,
		);
		return 1;
	}
	const text = `${JSON.stringify(result.value, null, 2)}\n`;
	const file = last(parsed, "out");
	if (file !== undefined) {
		try {
			(deps.writeFile ?? ((target, content) => writeFileSync(target, content)))(file, text);
		} catch (cause) {
			deps.err(`[substrate] corpus prove failed: could not write ${printable(file)}: ${printable(cause instanceof Error ? cause.message : String(cause))}\n`);
			return 1;
		}
		deps.err(`[substrate] corpus prove: proof written to ${printable(file)}\n`);
	}
	deps.out(text);
	return 0;
}

/** Reads a proof file, refusing one over {@link MAX_PROOF_FILE_BYTES} before reading it. */
function readBounded(target: string): Uint8Array {
	if (statSync(target).size > MAX_PROOF_FILE_BYTES) throw new Error(`larger than ${MAX_PROOF_FILE_BYTES} bytes`);
	return readFileSync(target);
}

/** Reads and parses a proof file. A file that cannot be read or is not JSON is a usage error (2); JSON that is not a proof is an invalid one. */
function readProofFile(file: string, deps: CorpusDeps): { ok: true; value: unknown } | { ok: false; message: string } {
	let text: string;
	try {
		const bytes = (deps.readFile ?? readBounded)(file);
		if (bytes.byteLength > MAX_PROOF_FILE_BYTES) return { ok: false, message: `${printable(file)} is larger than ${MAX_PROOF_FILE_BYTES} bytes, which no proof is` };
		text = new TextDecoder().decode(bytes);
	} catch (cause) {
		return { ok: false, message: `cannot read ${printable(file)}: ${printable(cause instanceof Error ? cause.message : String(cause))}` };
	}
	try {
		const value: unknown = JSON.parse(text);
		return { ok: true, value };
	} catch {
		return { ok: false, message: `${printable(file)} is not JSON` };
	}
}

async function verify(parsed: Parsed, deps: CorpusDeps): Promise<number> {
	const file = parsed.positionals[0];
	if (file === undefined) {
		deps.err("[substrate] corpus verify: a proof FILE is required\n");
		return 2;
	}
	const read = readProofFile(file, deps);
	if (!read.ok) {
		deps.err(`[substrate] corpus verify: ${read.message}\n`);
		return 2;
	}
	const proof = read.value;
	if (!isProofResponse(proof)) {
		deps.err(`[substrate] corpus verify: invalid, ${printable(file)} is not a corpus proof (protocol ${CORPUS_PROTOCOL})\n`);
		return 1;
	}
	const offline = verifyProofOffline(proof);
	const online = parsed.bools.has("online");
	let anchor: CorpusAnchorResponse | null = null;
	let anchorSkipped: string | null = null;
	if (online && !offline.valid) {
		anchorSkipped = "the proof is invalid, so the server was not asked";
	} else if (online) {
		// The root was checked as hex by the offline verification above, so what is sent is 64 lowercase hex characters.
		const answer = await clientFor(parsed, deps).anchor(proof.root);
		if (answer.ok) anchor = answer.value;
		else anchorSkipped = describeError(answer.error);
	}
	const report: VerifyReport = { proof, offline, online, anchor, anchorSkipped, conflict: anchor === null ? null : conflictWith(proof, anchor) };
	deps.out(parsed.bools.has("json") ? jsonVerifyReport(report) : renderVerify(report));
	return isValidReport(report) ? 0 : 1;
}

/** The request a plan sends: the entries without bodies, and the coverage of what the scan read completely. */
function planRequest(inventory: Inventory): CorpusPlanRequest {
	return { protocol: CORPUS_PROTOCOL, entries: inventory.entries, scope: inventory.scope };
}

interface NeardupArgs {
	/** Absent: the server's default. */
	threshold: number | undefined;
	max: number;
}

/** `--neardup` with its options, null without `--neardup`, or the usage error. The two options mean nothing without the flag, so they are refused. */
function resolveNeardupArgs(parsed: Parsed): NeardupArgs | string | null {
	const thresholdText = last(parsed, "threshold");
	const maxText = last(parsed, "neardup-max");
	if (!parsed.bools.has("neardup")) return thresholdText === undefined && maxText === undefined ? null : "--threshold and --neardup-max need --neardup";
	let threshold: number | undefined;
	if (thresholdText !== undefined) {
		const value = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(thresholdText) ? Number(thresholdText) : Number.NaN;
		if (!(value >= MIN_NEARDUP_THRESHOLD && value <= MAX_NEARDUP_THRESHOLD)) return `--threshold must be a number from ${MIN_NEARDUP_THRESHOLD} to ${MAX_NEARDUP_THRESHOLD}`;
		threshold = value;
	}
	let max = MAX_NEARDUP_ITEMS;
	if (maxText !== undefined) {
		const value = positiveInt(maxText);
		if (value === null || value > MAX_NEARDUP_ITEMS) return `--neardup-max must be a whole number from 1 to ${MAX_NEARDUP_ITEMS}`;
		max = value;
	}
	return { threshold, max };
}

async function plan(args: ScanArgs, parsed: Parsed, deps: CorpusDeps, neardup: NeardupArgs | null): Promise<number> {
	const inventory = await collectInventory(inventoryOptions(args, deps, undefined));
	const client = clientFor(parsed, deps);
	const result = await client.plan(planRequest(inventory));
	if (!result.ok) {
		deps.err(`[substrate] corpus plan failed: ${describeError(result.error)}\n`);
		return 1;
	}
	const json = parsed.bools.has("json");
	const planJson = { ...result.value, superseded: supersededEntries(inventory.entries) };
	if (neardup === null) {
		deps.out(json ? `${JSON.stringify(planJson, null, 2)}\n` : renderPlan(result.value, inventory));
		return 0;
	}
	// The comparison is asked for, so a failure of it is a failure of the command; the plan is printed either way.
	const selection = selectNeardupItems(result.value, inventory, prefixReaderOf(deps.readPrefix, deps.readFile), neardup.max);
	let reply: CorpusNeardupResponse | null = null;
	let failure: ClientError | null = null;
	if (selection.items.length > 0) {
		const answered = await client.neardup(neardupRequest(selection.items, neardup.threshold));
		if (answered.ok) reply = answered.value;
		else failure = answered.error;
	}
	if (json) {
		const notCompared = { github: selection.github, unreadable: selection.unreadable, overLimit: selection.overLimit };
		const empty: CorpusNeardupResponse = { protocol: CORPUS_PROTOCOL, model: null, dimension: null, compared: 0, pairs: [], truncated: false, skipped: [] };
		const section = failure === null ? { ...(reply ?? empty), notCompared } : { error: failure.message };
		deps.out(`${JSON.stringify({ ...planJson, neardup: section }, null, 2)}\n`);
	} else {
		deps.out(renderPlan(result.value, inventory));
		if (failure === null) deps.out(renderNeardup(selection, reply));
	}
	if (failure !== null) {
		deps.err(`[substrate] corpus plan --neardup: the near-duplicate comparison could not run: ${describeError(failure)}\n`);
		return 1;
	}
	return 0;
}

async function ingest(args: ScanArgs, parsed: Parsed, deps: CorpusDeps, batchDocs: number, batchBytes: number): Promise<number> {
	const execute = parsed.bools.has("execute");
	// GitHub bodies are fetched during the scan; they are kept (on disk) only when they may be sent.
	const store: BodyStore | null = execute && args.sources.includes("github") ? createBodyStore() : null;
	try {
		const inventory = await collectInventory(
			inventoryOptions(args, deps, store === null ? undefined : (entry, body) => store.put(entry.sha256, body)),
		);
		const client = clientFor(parsed, deps);
		const planned = await client.plan(planRequest(inventory));
		if (!planned.ok) {
			deps.err(`[substrate] corpus ingest failed: ${describeError(planned.error)}\n`);
			return 1;
		}
		const json = parsed.bools.has("json");
		if (!execute) {
			deps.out(
				json
					? `${JSON.stringify({ dryRun: true, plan: planned.value }, null, 2)}\n`
					: `${renderPlan(planned.value, inventory)}dry run: nothing was sent; add --execute to ingest this plan\n`,
			);
			return 0;
		}
		if (!json) deps.out(renderPlan(planned.value, inventory));
		const outcome = await executeIngest({
			plan: planned.value,
			inventory,
			client,
			bodies: store,
			readFile: deps.readFile ?? ((path) => readFileSync(path)),
			maxBytes: args.maxBytes,
			batchDocs,
			batchBytes,
		});
		deps.out(
			json
				? `${JSON.stringify({ plan: planned.value.counts, ingest: outcome.summary, fatal: outcome.fatal }, null, 2)}\n`
				: renderIngest(outcome.summary),
		);
		if (outcome.fatal !== null) deps.err(`[substrate] corpus ingest stopped: ${describeError(outcome.fatal)}\n`);
		const { failed, refused } = outcome.summary.counts;
		return outcome.fatal !== null || failed > 0 || refused > 0 ? 1 : 0;
	} finally {
		store?.close();
	}
}
