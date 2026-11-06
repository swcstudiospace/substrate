#!/usr/bin/env bun
/**
 * The re-anchor PLAN runner (v1.6, phase 59, unit c; `consistency-run.ts` and `anchor-run.ts` precedent).
 *
 *   bun packages/mcp-server/src/reanchor-plan-run.ts [--since ISO] [--until ISO] [--max-hours N] [--json]
 *
 * After a Solana devnet reset every anchor signature is gone from the cluster although the ledger's hourly
 * roots are intact. This runner answers one question: which stored anchors rows would have to be written to
 * the new cluster again? It reads the `anchors` rows of a window from the ledger, asks the configured devnet
 * endpoint for its genesis hash and for the status of each row's signature (`finalized`, then `confirmed`),
 * classifies each hour with `classifyChainEvidence`, hands the result to `planReanchor` and prints the plan.
 *
 * READ-ONLY, by construction rather than by promise:
 * - the only chain calls are `getGenesisHash`, `getTransaction` (`Rpc.getGenesisHash`, `Rpc.transactionMemo`) and the paged
 *   `getSignaturesForAddress` of a graph's index address, read by `readGraphPointers`;
 * - the only ledger calls are `GreptimeClient.anchorsBetween` and `hourChainLeaves`, both SELECTs;
 * - this module imports no signer, no solana CLI helper, no runner and no anchor job: from `./anchor.ts` it takes the constant
 *   `DEVNET_GENESIS_HASH` and the read `readGraphPointers`, and `reanchor-plan-run.test.ts` pins that import list;
 * - it never reads a keypair path or a public key, so it needs no `SOLANA_ANCHOR_*` variable at all.
 * A plan is a dry run (`dry_run: true`). Sending is a separate, operator-run step: see
 * `docs/runbooks/devnet-reset-and-reanchor.md`.
 *
 * Flags (strict: each at most once, a value flag takes its value as the NEXT argument, no positional argument):
 *   --since ISO       first hour of the window (a whole UTC hour with a zone, e.g. 2026-10-19T00:00:00Z)
 *   --until ISO       end of the window, exclusive (a whole UTC hour, not later than the current hour)
 *   --max-hours N     hard cap on the window, 1..744, default 168 (seven days); a wider window is refused
 *   --json            print the report as JSON (default: a short summary)
 * Without `--until` the window ends at the start of the current hour; without `--since` it starts `--max-hours`
 * before its end.
 *
 * Exit codes: 0 nothing to re-anchor, 1 a plan exists, 2 usage or missing configuration (a bad flag, an unset
 * `GREPTIME_URL`, a refused `SOLANA_RPC_URL`), 3 the ledger or the chain could not be read, so no plan can be
 * claimed (nothing is printed to stdout). Exit 0 does not mean every hour is fine: the summary and the JSON
 * list hours that are skipped and need a human (`needs_attention`).
 *
 * Environment (names only; none is new): the variables `loadConfig` reads for the ledger (`GREPTIME_URL`,
 * `GREPTIME_USER`, `GREPTIME_PASSWORD`, `GREPTIME_DB`) and for the devnet endpoint (`SOLANA_RPC_URL`, default the
 * public devnet endpoint). A `SOLANA_RPC_URL` the devnet guard refuses (mainnet or testnet host, userinfo, a
 * non-http scheme, a fragment) exits 2 BEFORE any request. Credentials are read here and only here; the report
 * never prints a URL, a token or event content.
 *
 * The expected genesis is `DEVNET_GENESIS_HASH`, the hash the anchor job and the verifier still treat as devnet.
 * Run this BEFORE that constant is changed for a new cluster: with the new hash the wiped signatures read as
 * missing on the expected cluster, which `planReanchor` refuses to re-anchor (history pruning or tampering).
 * Save the plan (`--json > plan.json`) when you run it.
 */
import {
	classifyChainEvidence,
	createRpc,
	HOUR_MS,
	hourEnd,
	hourIso,
	hourStart,
	RpcError,
	type Rpc,
	type SignatureStatus,
} from "@substrate/ledger";
import { DEVNET_GENESIS_HASH, readGraphPointers } from "./anchor.ts";
import { loadConfig, type GreptimeConfig, type SubstrateConfig } from "./config.ts";
import { GreptimeClient, type AnchorRow } from "./greptime.ts";
import { planReanchor, pointerMismatch, type HourChainEvidence, type PointerHint, type ReanchorPlan, type ReanchorSkipCode } from "./reanchor-plan.ts";
import { redact } from "./redact.ts";

// ---------------------------------------------------------------------------
// Argument grammar
// ---------------------------------------------------------------------------

export const REANCHOR_USAGE =
	"usage: reanchor-plan-run.ts [--since ISO] [--until ISO] [--max-hours N] [--json]\n" +
	"  --since ISO     first hour of the window, a whole UTC hour with a zone, e.g. 2026-10-19T00:00:00Z\n" +
	"  --until ISO     end of the window (exclusive), a whole UTC hour, not later than the current hour\n" +
	"  --max-hours N   hard cap on the window in hours (1..744, default 168); a wider window is refused\n" +
	"  --json          print the report as JSON (default: a short summary)\n" +
	"  read-only: nothing is sent, signed or written; it reads GREPTIME_* and SOLANA_RPC_URL only\n" +
	"exit: 0 nothing to re-anchor, 1 a plan exists, 2 usage or configuration, 3 the ledger or the chain was unreachable (no plan can be claimed)\n";

/** The default window: seven days, the anchor job's own lookback. */
export const DEFAULT_MAX_HOURS = 168;
/** The widest window a run may cover: each hour costs up to two requests to a public endpoint. */
export const MAX_HOURS_CEILING = 744;
/** Consecutive unanswered signature lookups after which the run stops asking: the endpoint is down. */
export const MAX_CONSECUTIVE_UNREACHABLE = 3;

/** A usage error: a bad flag or window. The run exits 2 with the usage text. */
export class ReanchorUsageError extends Error {
	override name = "ReanchorUsageError";
}

interface ReanchorArgs {
	json: boolean;
	/** Epoch ms of a whole UTC hour, or null for the default. */
	sinceMs: number | null;
	untilMs: number | null;
	maxHours: number | null;
}

const BOOLEAN_FLAGS = ["json"] as const;
const VALUE_FLAGS = ["since", "until", "max-hours"] as const;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

function hourArg(flag: string, raw: string): number {
	const parsed = Date.parse(raw);
	if (!ISO_INSTANT.test(raw) || !Number.isSafeInteger(parsed)) {
		throw new ReanchorUsageError(`--${flag} needs an ISO instant with a time and a zone, e.g. 2026-10-19T00:00:00Z`);
	}
	if (parsed !== hourStart(parsed)) throw new ReanchorUsageError(`--${flag} ${raw.slice(0, 40)} is not a whole UTC hour`);
	return parsed;
}

/**
 * Strict: only the four flags, each at most once, a value flag always followed by its value (`--since X`, never
 * `--since=X`), no positional argument. Pure, so a test pins it without spawning.
 */
export function parseReanchorArgs(argv: readonly string[]): ReanchorArgs {
	const booleans = new Set<string>();
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (!arg.startsWith("--")) throw new ReanchorUsageError(`unexpected argument "${arg.slice(0, 40)}"`);
		const name = arg.slice(2);
		if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
			if (booleans.has(name)) throw new ReanchorUsageError(`--${name} given twice`);
			booleans.add(name);
			continue;
		}
		if ((VALUE_FLAGS as readonly string[]).includes(name)) {
			if (values.has(name)) throw new ReanchorUsageError(`--${name} given twice`);
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) throw new ReanchorUsageError(`--${name} needs a value`);
			values.set(name, value);
			i += 1;
			continue;
		}
		throw new ReanchorUsageError(`unknown flag "${arg.slice(0, 40)}" (a value flag takes its value as the next argument)`);
	}
	const sinceRaw = values.get("since");
	const untilRaw = values.get("until");
	const maxRaw = values.get("max-hours");
	let maxHours: number | null = null;
	if (maxRaw !== undefined) {
		if (!/^[1-9]\d{0,3}$/.test(maxRaw) || Number(maxRaw) > MAX_HOURS_CEILING) {
			throw new ReanchorUsageError(`--max-hours needs an integer from 1 to ${MAX_HOURS_CEILING}`);
		}
		maxHours = Number(maxRaw);
	}
	return {
		json: booleans.has("json"),
		sinceMs: sinceRaw === undefined ? null : hourArg("since", sinceRaw),
		untilMs: untilRaw === undefined ? null : hourArg("until", untilRaw),
		maxHours,
	};
}

interface ReanchorWindow {
	sinceMs: number;
	/** Exclusive. */
	untilMs: number;
	hours: number;
	maxHours: number;
}

/** The window the run reads, or a usage error. `nowMs` is the run's only clock reading. */
export function resolveWindow(args: ReanchorArgs, nowMs: number): ReanchorWindow {
	const currentHour = hourStart(nowMs);
	const maxHours = args.maxHours ?? DEFAULT_MAX_HOURS;
	const untilMs = args.untilMs ?? currentHour;
	if (untilMs > currentHour) throw new ReanchorUsageError("--until must not be later than the start of the current hour: a later hour has no anchor yet");
	const sinceMs = args.sinceMs ?? untilMs - maxHours * HOUR_MS;
	if (sinceMs >= untilMs) throw new ReanchorUsageError("--since must be earlier than --until");
	const hours = (untilMs - sinceMs) / HOUR_MS;
	if (hours > maxHours) {
		throw new ReanchorUsageError(`the window is ${hours} hours, more than --max-hours ${maxHours}; narrow it, or raise --max-hours (at most ${MAX_HOURS_CEILING})`);
	}
	return { sinceMs, untilMs, hours, maxHours };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** A failure's reason: redacted, every URL and address removed (an endpoint may carry a credential), one line, short. */
function reasonOf(cause: unknown): string {
	const text = cause instanceof Error ? cause.message : String(cause);
	return redact(text)
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<addr>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
}

/** The only ledger calls: a window SELECT and one hour's chain leaves. A test hands in a fake that has nothing else to call. */
export type AnchorsReader = Pick<GreptimeClient, "anchorsBetween" | "hourChainLeaves">;
/** The only chain calls: `getGenesisHash`, `getTransaction`, and the paged signature listing of an index address. */
export type ChainReader = Pick<Rpc, "getGenesisHash" | "transactionMemo" | "addressSignaturePage">;

export interface ReanchorRunContext {
	ledger: AnchorsReader;
	rpc: ChainReader;
	/** The genesis hash this deployment treats as devnet (`DEVNET_GENESIS_HASH`). */
	expectedGenesis: string;
}

interface ReanchorRunDeps {
	/** Epoch ms; read once per run. */
	now(): number;
	open(): Promise<ReanchorRunContext | { refused: string }>;
}

export interface ReanchorRunResult {
	code: 0 | 1 | 2 | 3;
	stdout: string;
	stderr: string;
}

export interface ReanchorReport {
	schema: 1;
	dry_run: true;
	generated_at: string;
	window: { since: string; until: string; hours: number; max_hours: number };
	chain: {
		expected_genesis: string;
		/** Null when no row made a chain read necessary (an empty window reads nothing). */
		observed_genesis: string | null;
		genesis_matches: boolean | null;
		signature_lookups: number;
		/** Rows that were not asked about: a signature that is not base58, or an hour that is not whole. */
		rows_not_looked_up: number;
	};
	summary: {
		rows_examined: number;
		to_reanchor: number;
		skipped_by_code: Record<string, number>;
		/** Skipped hours a human must look at: damaged rows, a missing signature on the EXPECTED cluster, hours with no evidence. */
		needs_attention: number;
	};
	plan: ReanchorPlan;
}

const ATTENTION_CODES: readonly ReanchorSkipCode[] = ["signature-missing-without-reset", "invalid-row", "duplicate-row", "no-evidence", "pointer-mismatch"];
const TEXT_HOURS_SHOWN = 20;

const usageFailure = (message: string): ReanchorRunResult => ({ code: 2, stdout: "", stderr: `${message}\n${REANCHOR_USAGE}` });
const noPlan = (message: string): ReanchorRunResult => ({
	code: 3,
	stdout: "",
	stderr: `${message}\nno plan can be claimed: an unreachable ledger or chain says nothing about a reset. Re-run when both answer.\n`,
});

function wholeHour(periodStart: unknown): number | null {
	if (typeof periodStart !== "string") return null;
	const ms = Date.parse(periodStart);
	return Number.isSafeInteger(ms) && ms % HOUR_MS === 0 ? ms : null;
}

const LOOKUP_LEVELS = ["finalized", "confirmed"] as const;

/**
 * How the cluster answers for one signature, asked highest level first (the verifier's order). A node that does
 * not know the signature at either level answers `not-found`. A node that cannot answer is `unreachable`, never
 * `not-found`: an outage must not look like a wiped cluster.
 */
async function lookupSignature(rpc: ChainReader, signature: string): Promise<{ status: SignatureStatus; failure?: string }> {
	for (const level of LOOKUP_LEVELS) {
		let found: unknown;
		try {
			found = await rpc.transactionMemo(signature, level);
		} catch (cause) {
			return { status: "unreachable", failure: reasonOf(cause) };
		}
		if (found !== null) return { status: level };
	}
	return { status: "not-found" };
}

function byHourThenSignature(a: { hour: number; row: AnchorRow }, b: { hour: number; row: AnchorRow }): number {
	return a.hour - b.hour || (a.row.tx_sig < b.row.tx_sig ? -1 : a.row.tx_sig > b.row.tx_sig ? 1 : 0);
}

function skippedCounts(plan: ReanchorPlan): Record<string, number> {
	const counts = new Map<string, number>();
	for (const skipped of plan.skipped) counts.set(skipped.code, (counts.get(skipped.code) ?? 0) + 1);
	return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function formatText(report: ReanchorReport): string {
	const { plan, chain, summary, window } = report;
	const lines: string[] = [];
	lines.push(
		summary.to_reanchor > 0
			? `re-anchor plan (DRY RUN: nothing was sent): ${summary.to_reanchor} hour${summary.to_reanchor === 1 ? "" : "s"} to re-anchor`
			: "re-anchor plan (DRY RUN: nothing was sent): nothing to re-anchor",
	);
	lines.push(`  window   ${window.since} .. ${window.until} (${window.hours} h, cap ${window.max_hours}), ${summary.rows_examined} anchors row(s)`);
	if (chain.observed_genesis === null) {
		lines.push(`  chain    not read: the window holds no anchors row (expected genesis ${chain.expected_genesis})`);
	} else {
		lines.push(
			`  chain    expected genesis ${chain.expected_genesis}, observed ${chain.observed_genesis} ` +
				`(${chain.genesis_matches === true ? "same cluster" : "DIFFERENT: the devnet was probably reset"}), ${chain.signature_lookups} signature lookup(s)`,
		);
	}
	for (const hour of plan.hours.slice(0, TEXT_HOURS_SHOWN)) {
		lines.push(`  hour     ${hour.period_start}  ${hour.event_count} events  root ${hour.root}  previous ${hour.previous_tx_sig}`);
	}
	if (plan.hours.length > TEXT_HOURS_SHOWN) lines.push(`  ...      ${plan.hours.length - TEXT_HOURS_SHOWN} more hour(s): use --json for the whole plan`);
	const skipped = Object.entries(summary.skipped_by_code);
	if (skipped.length > 0) lines.push(`  skipped  ${skipped.map(([code, count]) => `${code}: ${count}`).join(", ")}`);
	if (summary.needs_attention > 0) {
		lines.push(`  ATTENTION ${summary.needs_attention} skipped hour(s) need a human; they are NOT re-anchorable from this plan (see --json, "plan.skipped")`);
	}
	if (summary.to_reanchor > 0) {
		lines.push("  next     save this plan with --json and follow docs/runbooks/devnet-reset-and-reanchor.md (every sending step is OPERATOR ONLY)");
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Reads the index listing of every graph with a leaf in each hour the plan would re-anchor (its signature is not on the observed cluster)
 * and writes the first v3 pointer of that hour that does not match it onto the hour's evidence. planReanchor then refuses the hour. A
 * listing that cannot be read to its end throws, and the run claims no plan.
 */
async function readPointerMismatches(
	ledger: AnchorsReader,
	rpc: ChainReader,
	evidence: ReadonlyMap<number, HourChainEvidence>,
	askable: ReadonlyArray<{ hour: number; row: AnchorRow }>,
	nowMs: number,
): Promise<void> {
	const txByHour = new Map(askable.map(({ hour, row }) => [hour, row.tx_sig]));
	for (const [hour, found] of evidence) {
		if (found.verdict !== "reset-suspected" || found.signatureStatus !== "not-found") continue;
		const txSig = txByHour.get(hour);
		if (txSig === undefined) continue;
		const graphIds = [...new Set((await ledger.hourChainLeaves(hour)).map((leaf) => leaf.graph_id))].sort();
		const hints: PointerHint[] = [];
		for (const graphId of graphIds) {
			const listing = await readGraphPointers(rpc, graphId, { budgetMs: Number.POSITIVE_INFINITY, nowMs: () => nowMs });
			if (!listing.complete) throw new Error(`the index listing of a graph in ${hourIso(hour)} is incomplete`);
			for (const entry of listing.entries) hints.push({ graphId, signature: entry.signature, memo: entry.memo });
		}
		found.pointerMismatch = pointerMismatch(hour, txSig, hints);
	}
}

/** One run: parse, open, read the ledger and the chain, plan, format. Never throws for an outage; the result carries the exit code. */
export async function runReanchorPlan(argv: readonly string[], deps: ReanchorRunDeps): Promise<ReanchorRunResult> {
	let args: ReanchorArgs;
	try {
		args = parseReanchorArgs(argv);
	} catch (cause) {
		if (cause instanceof ReanchorUsageError) return usageFailure(cause.message);
		throw cause;
	}
	const nowMs = deps.now();
	if (!Number.isFinite(nowMs)) throw new TypeError("runReanchorPlan: deps.now() must return a finite number");
	let window: ReanchorWindow;
	try {
		window = resolveWindow(args, nowMs);
	} catch (cause) {
		if (cause instanceof ReanchorUsageError) return usageFailure(cause.message);
		throw cause;
	}

	let opened: ReanchorRunContext | { refused: string };
	try {
		opened = await deps.open();
	} catch (cause) {
		return usageFailure(reasonOf(cause));
	}
	if ("refused" in opened) return usageFailure(opened.refused);
	const { ledger, rpc, expectedGenesis } = opened;

	let rows: AnchorRow[];
	try {
		rows = await ledger.anchorsBetween(window.sinceMs, window.untilMs);
	} catch (cause) {
		return noPlan(`the ledger could not be read: ${reasonOf(cause)}`);
	}
	if (!Array.isArray(rows)) return noPlan("the ledger answered with something that is not a list of anchors rows");
	// The table holds one row per hour, so more rows than hours is a broken answer, not a plan input.
	if (rows.length > window.hours) {
		return noPlan(`the ledger returned ${rows.length} anchors rows for a window of ${window.hours} hours`);
	}

	let observedGenesis: string | null = null;
	let signatureLookups = 0;
	let notLookedUp = 0;
	const chainEvidenceByHour = new Map<number, HourChainEvidence>();

	if (rows.length > 0) {
		try {
			observedGenesis = await rpc.getGenesisHash();
		} catch (cause) {
			return noPlan(`the cluster's genesis hash could not be read: ${reasonOf(cause)}`);
		}
		if (typeof observedGenesis !== "string" || observedGenesis.length === 0) {
			return noPlan("the cluster answered the genesis hash request with no hash");
		}

		const askable: Array<{ hour: number; row: AnchorRow }> = [];
		for (const row of rows) {
			const hour = wholeHour(row.period_start);
			if (hour === null || typeof row.tx_sig !== "string" || !SIGNATURE_RE.test(row.tx_sig)) {
				notLookedUp += 1;
				continue;
			}
			askable.push({ hour, row });
		}
		askable.sort(byHourThenSignature);

		let consecutiveUnreachable = 0;
		let unreachable = 0;
		let firstFailure: string | undefined;
		const seen = new Set<number>();
		for (const { hour, row } of askable) {
			// One lookup per hour: a second row for the same hour is planReanchor's `duplicate-row`.
			if (seen.has(hour)) continue;
			seen.add(hour);
			const looked = await lookupSignature(rpc, row.tx_sig);
			signatureLookups += 1;
			if (looked.status === "unreachable") {
				unreachable += 1;
				firstFailure ??= looked.failure;
				consecutiveUnreachable += 1;
			} else {
				consecutiveUnreachable = 0;
			}
			const anchoredAtMs = Date.parse(row.anchored_at);
			const verdict = classifyChainEvidence({
				expectedGenesis,
				observedGenesis,
				signatureStatus: looked.status,
				anchoredAtMs: Number.isFinite(anchoredAtMs) ? anchoredAtMs : hourEnd(hour),
				nowMs,
			});
			chainEvidenceByHour.set(hour, { ...verdict, signatureStatus: looked.status, observedGenesis });
			// The endpoint is down: asking for the rest of a long window would only wait out its timeouts.
			if (consecutiveUnreachable >= MAX_CONSECUTIVE_UNREACHABLE) break;
		}
		if (unreachable > 0) {
			return noPlan(
				`the devnet endpoint did not answer ${unreachable} of ${signatureLookups} signature lookup(s)${firstFailure === undefined ? "" : ` (first: ${firstFailure})`}`,
			);
		}
		try {
			await readPointerMismatches(ledger, rpc, chainEvidenceByHour, askable, nowMs);
		} catch (cause) {
			return noPlan(`the index listing of a reset hour could not be read: ${reasonOf(cause)}`);
		}
	}

	const plan = planReanchor({ anchorRows: rows, chainEvidenceByHour, nowMs });
	const skippedByCode = skippedCounts(plan);
	const report: ReanchorReport = {
		schema: 1,
		dry_run: true,
		generated_at: new Date(nowMs).toISOString(),
		window: { since: hourIso(window.sinceMs), until: hourIso(window.untilMs), hours: window.hours, max_hours: window.maxHours },
		chain: {
			expected_genesis: expectedGenesis,
			observed_genesis: observedGenesis,
			genesis_matches: observedGenesis === null ? null : observedGenesis === expectedGenesis,
			signature_lookups: signatureLookups,
			rows_not_looked_up: notLookedUp,
		},
		summary: {
			rows_examined: rows.length,
			to_reanchor: plan.hours.length,
			skipped_by_code: skippedByCode,
			needs_attention: ATTENTION_CODES.reduce((total, code) => total + (skippedByCode[code] ?? 0), 0),
		},
		plan,
	};
	return {
		code: plan.hours.length > 0 ? 1 : 0,
		stdout: args.json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report),
		stderr: "",
	};
}

// ---------------------------------------------------------------------------
// The real readers
// ---------------------------------------------------------------------------

/** Devnet reads: one slow call each, two tries, room to breathe between. */
const RPC_TIMEOUT_MS = 10_000;
const RPC_ATTEMPTS = 2;
const RPC_BACKOFF_MS = 1_000;

interface RealContextOptions {
	/** The environment to read; `process.env` by default. */
	env?: Record<string, string | undefined>;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	/** The ledger reader for a configured store; the real client by default. */
	ledgerFor?: (config: GreptimeConfig) => AnchorsReader;
}

/**
 * Open the real readers from the server's environment. The devnet guard runs first: a refused
 * `SOLANA_RPC_URL` returns `{ refused }` before a ledger client exists and before any request is made.
 */
export async function openRealContext(options: RealContextOptions = {}): Promise<ReanchorRunContext | { refused: string }> {
	let config: SubstrateConfig;
	try {
		config = loadConfig(options.env ?? process.env);
	} catch (cause) {
		return { refused: `the configuration is not valid: ${reasonOf(cause)}` };
	}
	if (!config.greptime) return { refused: "GREPTIME_URL is not set" };
	if (config.solana.problem) return { refused: config.solana.problem };
	let rpc: Rpc;
	try {
		rpc = createRpc({
			url: config.solana.rpcUrl,
			timeoutMs: RPC_TIMEOUT_MS,
			attempts: RPC_ATTEMPTS,
			backoffMs: RPC_BACKOFF_MS,
			...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
			...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
		});
	} catch (cause) {
		if (cause instanceof RpcError) return { refused: `SOLANA_RPC_URL refused: ${reasonOf(cause)}` };
		throw cause;
	}
	const ledger = options.ledgerFor !== undefined ? options.ledgerFor(config.greptime) : new GreptimeClient(config.greptime, { ledger: config.ledger });
	return { ledger, rpc, expectedGenesis: DEVNET_GENESIS_HASH };
}

if (import.meta.main) {
	const result = await runReanchorPlan(process.argv.slice(2), { now: Date.now, open: () => openRealContext() });
	if (result.stdout.length > 0) process.stdout.write(result.stdout);
	if (result.stderr.length > 0) process.stderr.write(result.stderr);
	process.exit(result.code);
}
