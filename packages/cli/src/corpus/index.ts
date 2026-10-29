/**
 * `substrate corpus scan|plan|ingest|status` (v1.7 phase 63).
 *
 *   substrate corpus scan   [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--source fs|github|greptile]...
 *                           [--greptile-dir DIR] [--github-owner OWNER] [--max-repos N] [--json] [--entries]
 *   substrate corpus plan   (scan options) [--server URL] [--neardup [--threshold N] [--neardup-max N]]
 *   substrate corpus ingest (plan options) [--execute] [--batch-docs N] [--batch-bytes N]
 *   substrate corpus status [--server URL] [--json]
 *
 * Discovery runs here, where the files are; the server never reads a path. `scan` needs no server. `plan` sends entries
 * without bodies; with `--neardup` it then sends the first 4000 characters of each local document the plan would write to
 * `POST /corpus/neardup` and prints the pairs that look alike (advisory: nothing is dropped on that signal). `ingest` is a dry run until `--execute`, then sends the tombstones first, as requests of their own, and
 * then the bodies of the documents the plan says must change in bounded batches. Exit codes: 0 done (every document ingested, updated, unchanged or tombstoned), 1 a request failed, any document ended refused or failed, or a requested near-duplicate comparison could not be answered, 2 usage.
 */
import { readFileSync } from "node:fs";
import {
	CORPUS_PROTOCOL,
	CORPUS_SOURCES,
	DEFAULT_GITHUB_MAX_REPOS,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_TIER,
	MAX_INGEST_DOCUMENTS,
	MAX_NEARDUP_ITEMS,
	MAX_NEARDUP_THRESHOLD,
	MIN_NEARDUP_THRESHOLD,
	isCorpusSource,
	isDocTier,
	type CorpusNeardupResponse,
	type CorpusPlanRequest,
	type CorpusSource,
	type DocTier,
	type GhRunner,
	type GitRunner,
} from "@substrate/corpus";
import { createBodyStore, type BodyStore } from "./bodies.ts";
import { createCorpusClient, type ClientError, type CorpusClient } from "./client.ts";
import { executeIngest } from "./ingest.ts";
import { collectInventory, type Inventory, type InventoryOptions } from "./inventory.ts";
import { neardupRequest, prefixReaderOf, selectNeardupItems } from "./neardup.ts";
import { printable, renderIngest, renderInventory, renderNeardup, renderPlan, renderStatus } from "./render.ts";

export const USAGE =
	"substrate corpus scan [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--source fs|github|greptile]... [--greptile-dir DIR]\n" +
	"                      [--github-owner OWNER] [--max-repos N] [--json] [--entries]\n" +
	"substrate corpus plan [scan options] [--server URL] [--json] [--neardup [--threshold 0.5-1] [--neardup-max N]]   (--neardup is advisory: nothing is dropped on it; N is at most 1000)\n" +
	"substrate corpus ingest [plan options] [--execute] [--batch-docs N] [--batch-bytes N]   (a dry run without --execute; --batch-docs is capped at the server limit of 200)\n" +
	"substrate corpus status [--server URL] [--json]\n";

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
	/** Reads at most `maxBytes` from the start of a file; the near-duplicate excerpts use it so a large file is never loaded whole. Defaults to `readFile` cut to the budget when only that is injected. */
	readPrefix?: ((path: string, maxBytes: number) => Uint8Array) | undefined;
}

const SCAN_VALUES = ["root", "tier", "max-bytes", "source", "greptile-dir", "github-owner", "max-repos"] as const;

interface FlagSpec {
	values: readonly string[];
	bools: readonly string[];
}

const SPECS: Record<string, FlagSpec> = {
	scan: { values: SCAN_VALUES, bools: ["json", "entries", "help"] },
	plan: { values: [...SCAN_VALUES, "server", "threshold", "neardup-max"], bools: ["json", "neardup", "help"] },
	ingest: { values: [...SCAN_VALUES, "server", "batch-docs", "batch-bytes"], bools: ["json", "execute", "help"] },
	status: { values: ["server"], bools: ["json", "help"] },
};

interface Parsed {
	values: Map<string, string[]>;
	bools: Set<string>;
}

function parseFlags(argv: readonly string[], spec: FlagSpec): Parsed | string {
	const values = new Map<string, string[]>();
	const bools = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (!arg.startsWith("--")) return `unexpected argument ${JSON.stringify(arg)}`;
		const eq = arg.indexOf("=");
		const name = arg.slice(2, eq === -1 ? undefined : eq);
		if (spec.bools.includes(name)) {
			if (eq !== -1) return `--${name} takes no value`;
			bools.add(name);
		} else if (spec.values.includes(name)) {
			const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
			if (value === undefined || (eq === -1 && value.startsWith("--")) || value === "") return `--${name} takes a value`;
			if (eq === -1) i += 1;
			values.set(name, [...(values.get(name) ?? []), value]);
		} else {
			return `unknown flag --${name}`;
		}
	}
	return { values, bools };
}

function positiveInt(text: string | undefined): number | null {
	if (text === undefined || !/^[0-9]+$/.test(text)) return null;
	const value = Number(text);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

interface ScanArgs {
	roots: string[];
	maxTier: DocTier;
	maxBytes: number;
	sources: CorpusSource[];
	greptileDir: string | undefined;
	githubOwner: string | undefined;
	maxRepos: number;
}

function last(parsed: Parsed, name: string): string | undefined {
	return parsed.values.get(name)?.at(-1);
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
	const parsed = parseFlags(argv.slice(1), spec);
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
		const docsFlag = last(parsed, "batch-docs");
		const bytesFlag = last(parsed, "batch-bytes");
		const batchDocs = docsFlag === undefined ? positiveInt(deps.env.SUBSTRATE_CORPUS_BATCH_DOCS) ?? DEFAULT_BATCH_DOCS : positiveInt(docsFlag);
		const batchBytes = bytesFlag === undefined ? positiveInt(deps.env.SUBSTRATE_CORPUS_BATCH_BYTES) ?? DEFAULT_BATCH_BYTES : positiveInt(bytesFlag);
		if (batchDocs === null) return usage("--batch-docs must be a positive integer");
		if (batchBytes === null) return usage("--batch-bytes must be a positive integer");
		// The server refuses a request of more documents than its limit, which would stop the whole ingest, so a larger value is lowered.
		const docsPerRequest = Math.min(batchDocs, MAX_INGEST_DOCUMENTS);
		if (docsPerRequest < batchDocs) deps.err(`[substrate] corpus ingest: batch of ${batchDocs} documents is above the server limit; using ${docsPerRequest}\n`);
		return await ingest(args, parsed, deps, docsPerRequest, batchBytes);
	} catch (cause) {
		deps.err(`[substrate] corpus ${sub} failed: ${printable(cause instanceof Error ? cause.message : String(cause))}\n`);
		return 1;
	}
}

function clientFor(parsed: Parsed, deps: CorpusDeps): CorpusClient {
	return createCorpusClient({
		url: (last(parsed, "server") ?? deps.url).replace(/\/+$/, ""),
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
	if (neardup === null) {
		deps.out(json ? `${JSON.stringify(result.value, null, 2)}\n` : renderPlan(result.value, inventory));
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
		deps.out(`${JSON.stringify({ ...result.value, neardup: section }, null, 2)}\n`);
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
