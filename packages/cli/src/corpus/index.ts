/**
 * `substrate corpus scan|plan|ingest|status|prove|verify` (v1.7 phases 63 and 69) and `sync|watch|reconcile|hint|hook` (phase 65).
 *
 *   substrate corpus scan   [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--source fs|github|greptile]...
 *                           [--greptile-dir DIR] [--github-owner OWNER] [--max-repos N] [--json] [--entries]
 *   substrate corpus plan   (scan options) [--server URL]
 *   substrate corpus ingest (plan options) [--execute] [--batch-docs N] [--batch-bytes N]
 *   substrate corpus status [--server URL] [--json]
 *   substrate corpus sync   [--repo R]... [--root DIR]... [--execute] [--fetch] [--json]
 *   substrate corpus watch  [--root DIR]... [--sweep-s N] [--once]
 *   substrate corpus reconcile [--execute] [--json]
 *   substrate corpus hook install|uninstall|status --repo DIR
 *   substrate corpus hint   --repo DIR
 *   substrate corpus prove  --repo R --path P [--out FILE] [--server URL]
 *   substrate corpus verify FILE [--online] [--server URL] [--json]
 *
 * Discovery runs here, where the files are; the server never reads a path. `scan` needs no server. `plan` sends entries
 * without bodies. `ingest` is a dry run until `--execute`, then sends the tombstones first, as requests of their own, and
 * then the bodies of the documents the plan says must change in bounded batches. Exit codes: 0 done (every document ingested, updated, unchanged or tombstoned), 1 a request failed or any document ended refused or failed, 2 usage.
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
	MAX_INGEST_DOCUMENTS,
	isCorpusSource,
	isDocTier,
	type CorpusAnchorResponse,
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
import { createHttpEmitter, type EmitDocsSync } from "./events.ts";
import { type FlagSpec, last, type Parsed, parseFlags, positiveInt } from "./flags.ts";
import { executeIngest } from "./ingest.ts";
import { collectInventory, type Inventory, type InventoryOptions } from "./inventory.ts";
import { conflictWith, MAX_PROOF_FILE_BYTES, verifyProofOffline } from "./proof.ts";
import { isValidReport, jsonVerifyReport, printable, renderIngest, renderInventory, renderPlan, renderStatus, renderVerify, type VerifyReport } from "./render.ts";
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
	"substrate corpus plan [scan options] [--server URL] [--json]\n" +
	"substrate corpus ingest [plan options] [--execute] [--batch-docs N] [--batch-bytes N]   (a dry run without --execute; --batch-docs is capped at the server limit of 200)\n" +
	"substrate corpus status [--server URL] [--json]\n" +
	"substrate corpus sync [--repo R]... [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--server URL] [--execute] [--fetch] [--json]\n" +
	"                      (reads only the named repositories through the mirror view; a dry run without --execute; --fetch updates the mirrors first)\n" +
	"substrate corpus watch [--root DIR]... [--sweep-s N] [--server URL] [--once]   (a long-running loop; --once runs one sweep and exits)\n" +
	"substrate corpus reconcile [--root DIR]... [--server URL] [--execute] [--json]   (compares the manifest with the docs plane; a dry run without --execute)\n" +
	"substrate corpus hook install|uninstall|status --repo DIR   (opt-in git hooks for post-merge, post-checkout and post-rewrite hints)\n" +
	"substrate corpus hint --repo DIR   (writes one hint to the spool; what the hooks run; exits 0)\n" +
	"substrate corpus prove --repo R --path P [--out FILE] [--server URL]   (prints the inclusion proof of one document)\n" +
	"substrate corpus verify FILE [--online] [--server URL] [--json]   (0 valid, 1 invalid, 2 usage; offline unless --online)\n";

export const DEFAULT_ROOT = "/root/src/repos";
export const DEFAULT_BATCH_DOCS = 20;
export const DEFAULT_BATCH_BYTES = 1_000_000;
/** A plan or an ingest batch of a few thousand entries is megabytes of JSON; the server needs time to judge it. */
export const CORPUS_TIMEOUT_MS = 120_000;

export interface CorpusDeps {
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
	/** Test seam of `prove --out`. */
	writeFile?: ((path: string, text: string) => void) | undefined;
}

const SCAN_VALUES = ["root", "tier", "max-bytes", "source", "greptile-dir", "github-owner", "max-repos"] as const;

const SPECS: Record<string, FlagSpec> = {
	scan: { values: SCAN_VALUES, bools: ["json", "entries", "help"] },
	plan: { values: [...SCAN_VALUES, "server"], bools: ["json", "help"] },
	ingest: { values: [...SCAN_VALUES, "server", "batch-docs", "batch-bytes"], bools: ["json", "execute", "help"] },
	status: { values: ["server"], bools: ["json", "help"] },
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
	const configured = (env.SUBSTRATE_CORPUS_ROOTS ?? "").split(":").filter((root) => root !== "");
	const given = parsed.values.get("root");
	return {
		roots: given ?? (configured.length > 0 ? configured : [DEFAULT_ROOT]),
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
	try {
		if (sub === "status") return await status(parsed, deps);
		if (sub === "hint" || sub === "hook") return hintOrHook(sub, argv[1], parsed, deps, usage);
		if (sub === "prove") return await prove(parsed, deps);
		if (sub === "verify") return await verify(parsed, deps);
		const args = resolveScanArgs(parsed, deps.env);
		if (typeof args === "string") return usage(args);
		if (sub === "scan") {
			const inventory = await collectInventory(inventoryOptions(args, deps, undefined));
			deps.out(parsed.bools.has("json") ? jsonReport(inventory, parsed.bools.has("entries")) : renderInventory(inventory));
			return 0;
		}
		if (sub === "plan") return await plan(args, parsed, deps);
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
	return runHookCommand({ out: deps.out }, known, resolve(repo));
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
	const result = await clientFor(parsed, deps).status();
	if (!result.ok) {
		deps.err(`[substrate] corpus status failed: ${describeError(result.error)}\n`);
		return 1;
	}
	deps.out(parsed.bools.has("json") ? `${JSON.stringify(result.value, null, 2)}\n` : renderStatus(result.value));
	return 0;
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

async function plan(args: ScanArgs, parsed: Parsed, deps: CorpusDeps): Promise<number> {
	const inventory = await collectInventory(inventoryOptions(args, deps, undefined));
	const result = await clientFor(parsed, deps).plan(planRequest(inventory));
	if (!result.ok) {
		deps.err(`[substrate] corpus plan failed: ${describeError(result.error)}\n`);
		return 1;
	}
	deps.out(parsed.bools.has("json") ? `${JSON.stringify(result.value, null, 2)}\n` : renderPlan(result.value, inventory));
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
