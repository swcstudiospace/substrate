/**
 * `substrate corpus scan|plan|ingest|reflect|status` (v1.7 phases 63 and 66).
 *
 *   substrate corpus scan   [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--source fs|github|greptile]...
 *                           [--greptile-dir DIR] [--github-owner OWNER] [--max-repos N] [--json] [--entries]
 *   substrate corpus plan   (scan options) [--server URL]
 *   substrate corpus ingest (plan options) [--execute] [--batch-docs N] [--batch-bytes N]
 *   substrate corpus reflect [--repo R]... [--root DIR]... [--max-bytes N] [--server URL] [--execute] [--json]
 *   substrate corpus status [--server URL] [--json] [--gaps [--limit N]]
 *
 * Discovery runs here, where the files are; the server never reads a path. `scan` needs no server. `plan` sends entries
 * without bodies. `ingest` is a dry run until `--execute`, then sends the tombstones first, as requests of their own, and
 * then the bodies of the documents the plan says must change in bounded batches. `reflect` builds one digest per repository
 * from its `.planning` files and is a dry run until `--execute`. Exit codes: 0 done (every document ingested, updated, unchanged or tombstoned; every digest stored or unchanged), 1 a request failed or any document or digest ended refused or failed, 2 usage.
 */
import { readFileSync } from "node:fs";
import {
	CORPUS_PROTOCOL,
	CORPUS_SOURCES,
	DEFAULT_GITHUB_MAX_REPOS,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_TIER,
	MAX_GAPS_LIMIT,
	MAX_INGEST_DOCUMENTS,
	isCorpusSource,
	isDocTier,
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
import { collectDigests, executeReflect, type ReflectCollection } from "./reflect.ts";
import { printable, renderGaps, renderIngest, renderInventory, renderPlan, renderReflectOutcome, renderReflectPlan, renderStatus, supersededEntries } from "./render.ts";

export const USAGE =
	"substrate corpus scan [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--source fs|github|greptile]... [--greptile-dir DIR]\n" +
	"                      [--github-owner OWNER] [--max-repos N] [--json] [--entries]\n" +
	"substrate corpus plan [scan options] [--server URL] [--json]\n" +
	"substrate corpus ingest [plan options] [--execute] [--batch-docs N] [--batch-bytes N]   (a dry run without --execute; --batch-docs is capped at the server limit of 200)\n" +
	"substrate corpus reflect [--repo R]... [--root DIR]... [--max-bytes N] [--server URL] [--execute] [--json]\n" +
	"                      (digest of each repository's .planning/STATE.md and ROADMAP.md; a dry run without --execute; exits 1 when a digest was refused or failed or a repository could not be digested)\n" +
	"substrate corpus status [--server URL] [--json] [--gaps [--limit N]]   (--gaps lists the queries the corpus could not answer; --limit is capped at the server limit of 200)\n";

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
}

const SCAN_VALUES = ["root", "tier", "max-bytes", "source", "greptile-dir", "github-owner", "max-repos"] as const;

interface FlagSpec {
	values: readonly string[];
	bools: readonly string[];
}

const SPECS: Record<string, FlagSpec> = {
	scan: { values: SCAN_VALUES, bools: ["json", "entries", "help"] },
	plan: { values: [...SCAN_VALUES, "server"], bools: ["json", "help"] },
	ingest: { values: [...SCAN_VALUES, "server", "batch-docs", "batch-bytes"], bools: ["json", "execute", "help"] },
	status: { values: ["server", "limit"], bools: ["json", "gaps", "help"] },
	reflect: { values: ["repo", "root", "max-bytes", "server"], bools: ["json", "execute", "help"] },
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

/** `--root` values, else the colon-separated `SUBSTRATE_CORPUS_ROOTS`, else the default root. */
function resolveRoots(parsed: Parsed, env: Record<string, string | undefined>): string[] {
	const configured = (env.SUBSTRATE_CORPUS_ROOTS ?? "").split(":").filter((root) => root !== "");
	return parsed.values.get("root") ?? (configured.length > 0 ? configured : [DEFAULT_ROOT]);
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
		if (sub === "reflect") return await reflect(parsed, deps);
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
	deps.out(
		parsed.bools.has("json")
			? `${JSON.stringify({ ...result.value, superseded: supersededEntries(inventory.entries) }, null, 2)}\n`
			: renderPlan(result.value, inventory),
	);
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
