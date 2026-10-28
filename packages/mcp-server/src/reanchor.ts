/**
 * The guarded re-anchor executor (v1.6, phase 59, criterion 5).
 *
 * After a Solana devnet reset every anchor signature is gone from the cluster while the ledger's hourly roots are intact.
 * `reanchor-plan.ts` plans which stored rows would have to be witnessed again; this module is the executor of a SAVED plan.
 * It is orchestration over injected ports only (ledger, rpc, runner, substrate, clock, env), so every path runs in tests against
 * fakes that record each call. It imports no real executor: `reanchor-run.ts` is the one entry point that builds the real
 * runner, and the send is an operator-run step (`docs/runbooks/devnet-reset-and-reanchor.md`, step e).
 *
 * DRY RUN BY DEFAULT. {@link dryRunReanchor} is pure: it prints `would re-anchor <hour>` per planned hour and touches no port, so
 * no runner can be called. Only {@link executeReanchor} sends, and only after every gate below has passed.
 *
 * Gates of `--execute`, ALL before the first send (the one runner call that spends fee), so no refusal can follow a send except
 * the send's own failure and the note's:
 *  1. `--confirm-genesis` was given, and the endpoint URL passes the devnet guard (`assertDevnetRpcUrl`).
 *  2. The live `getGenesisHash` equals `--confirm-genesis`, equals the plan's observed genesis and every hour's target genesis,
 *     and is not the mainnet-beta or the testnet genesis. A genesis other than `DEVNET_GENESIS_HASH` is accepted HERE ONLY: that is
 *     the reset case (the constant moves to the new genesis in a release, runbook step b, before or after this send).
 *  3. The signer key shown by `solana-keygen pubkey` is the configured anchor public key, it holds the rent-exempt minimum plus
 *     the fees of the sends this run may make, and an operator surface exists to write the record as.
 *  3b. The effective signer set (`deps.signers`: the bootstrap folded with the operator's rotation notes, the set `checkpoint_verify`
 *     judges against) is read ONCE. A failed read, or one whose rotation read may be incomplete, refuses (`signer-set-incomplete`); a
 *     configured key that the set does not accept NOW refuses (`signer-not-current`). A transaction counts for an hour when its payer
 *     is accepted by the set at THAT transaction's block time (a missing block time refuses, `rpc-unreadable`), and discovery lists the
 *     signatures of every key in the set, so an hour an earlier key re-anchored before a rotation is adopted, not sent again.
 *  4. For every plan hour the digest is recomputed from the ledger and refused as `root-mismatch` unless the stored row, the
 *     recomputed root and count, and the stored memo (exactly `formatMemo` of the hour, root and count) all agree with the plan
 *     byte for byte.
 *  5. The run's lock (`deps.lock`; the entry builds `fileLock`: a file beside the plan, create-exclusive, stale after a dead pid or
 *     30 minutes) is held from here to the end of the run, across discovery, send and recording, so two overlapping runs cannot
 *     both pass discovery before either send is visible; the second refuses as `reanchor-locked`.
 *  6. For EVERY plan hour, read-only, before the first send: the stored `tx_sig` is absent on the cluster (present means this is not
 *     a reset); the NEWEST `anchor.reanchor` note bound to the hour (`newestBoundNote`, the same pointer the verifier follows; an
 *     older note is never a fallback), whose transaction verifies on chain, means the hour is done (adopted, never sent); for each hour without one, an earlier send
 *     of its memo by the signer is found by PAGING `getSignaturesForAddress` backwards (`before`) until a signature older than the
 *     plan's earliest period start (or the end of the signer's history) is reached, and is ADOPTED, never duplicated. A listing
 *     that cannot be read refuses (`rpc-unreadable`), and a page cap hit before the horizon refuses (`discovery-incomplete`): a miss
 *     in a bounded listing is never read as proof that nothing was sent. A notes read the verifier would call incomplete (a surface cut
 *     by its page cap) refuses (`notes-incomplete`) before any send, exactly as the verifier leaves the hour unverified.
 *
 * The memo carries period, root and count only, never event content; the keypair is only ever a path on a CLI argv.
 *
 * Recording: one `anchor.reanchor` note per hour (`buildReanchorEvent`, idempotency key `reanchor:<period_start>:<new_tx_sig>`; a repair
 * of a stale newest note hashes that note's event id into the key so it is stored even when an older note names the same signature),
 * written as an operator surface in the hour's anchor session. The `anchors` row is NEVER rewritten (the table's replace-or-ignore
 * behaviour is unverified): the verifier follows the note as a pointer to the new transaction and still judges that transaction
 * from the chain (`anchor-verify-deps.ts`, `followReanchor`).
 */
import {
	acceptsSigner,
	AMOUNT_ZERO,
	assertDevnetRpcUrl,
	formatMemo,
	HOUR_MS,
	hourIso,
	keygenPath,
	parseMemo,
	parseSignature,
	pubkeyArgv,
	transferMemoArgv,
	type AddressMemo,
	type Rpc,
	type RunResult,
	type Runner,
	type SignerSet,
	type TransactionMemo,
} from "@substrate/ledger";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { newestBoundNote, reanchorSessionId, type ReanchorNotes } from "./anchor-verify-deps.ts";
import { ADDRESS_MEMO_LIMIT, DEVNET_GENESIS_HASH, MAX_HOURS_PER_RUN, REQUIRED_BALANCE_LAMPORTS } from "./anchor.ts";
import type { AnchorRow, GreptimeClient } from "./greptime.ts";
import { buildReanchorEvent } from "./reanchor-plan.ts";
import { redact } from "./redact.ts";
import type { HourDigest, Substrate } from "./service.ts";
import type { Surface } from "./types.ts";

/**
 * The genesis hashes of Solana's other public clusters, refused even when confirmed. Source: the Anza validator documentation,
 * https://docs.anza.xyz/clusters/available, whose startup commands pass `--expected-genesis-hash` for each cluster:
 * mainnet-beta 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d, testnet 4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY (and devnet
 * EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG, which is `DEVNET_GENESIS_HASH`).
 */
export const MAINNET_BETA_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

/** The fee of one memo transfer in lamports (a single signature); the same figure `REQUIRED_BALANCE_LAMPORTS` adds to the rent minimum. */
export const SEND_FEE_LAMPORTS = 5_000;

// ---------------------------------------------------------------------------
// Argument grammar
// ---------------------------------------------------------------------------

export const REANCHOR_RUN_USAGE =
	"usage: reanchor-run.ts --plan FILE [--execute --confirm-genesis HASH [--max-hours N] [--surface NAME]]\n" +
	"  --plan FILE            a saved plan: the JSON that `reanchor-plan-run.ts --json` printed (schema 1, dry_run true)\n" +
	"  (default)              DRY RUN: prints `would re-anchor <hour>` per hour; reads nothing, signs nothing, sends nothing\n" +
	"  --execute              OPERATOR ONLY: sends one memo transaction per planned hour, after every gate has passed\n" +
	"  --confirm-genesis HASH the genesis hash the endpoint must report; it must also equal the plan's observed genesis (required with --execute)\n" +
	`  --max-hours N          at most N transactions sent per run, 1..${MAX_HOURS_PER_RUN}, default 1 (an hour already sent is adopted, not counted)\n` +
	"  --surface NAME         the operator surface the anchor.reanchor note is written as (needed when several operator surfaces exist)\n" +
	"  (lock)                 a lock file `.reanchor.lock` beside the plan file is held across discovery, send and recording; an overlapping run refuses (reanchor-locked)\n" +
	"  environment (names only; none is new): GREPTIME_*, SOLANA_RPC_URL, SOLANA_ANCHOR_KEYPAIR, SOLANA_ANCHOR_PUBKEY, SOLANA_CLI\n" +
	"exit: 0 dry run or done, 1 refused or failed (the first line on stderr names the gate), 2 usage or configuration\n";

/** A usage error: the entry prints it with {@link REANCHOR_RUN_USAGE} and exits 2. */
export class ReanchorRunUsageError extends Error {
	override name = "ReanchorRunUsageError";
}

export interface ReanchorOptions {
	planPath: string;
	execute: boolean;
	/** The genesis hash the operator confirms; null when not given. */
	confirmGenesis: string | null;
	/** Transactions this run may send, 1..MAX_HOURS_PER_RUN. */
	maxHours: number;
	/** The operator surface named with `--surface`, or null. */
	surface: string | null;
}

const GENESIS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const ROOT_RE = /^[0-9a-f]{64}$/;
const SURFACE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BOOLEAN_FLAGS = ["execute"] as const;
const VALUE_FLAGS = ["plan", "confirm-genesis", "max-hours", "surface"] as const;

/**
 * Strict: each flag at most once, a value flag always followed by its value (`--plan X`, never `--plan=X`), no positional argument.
 * Pure, so a test pins it without spawning. `--execute` is never implied by another flag.
 */
export function parseReanchorRunArgs(argv: readonly string[]): ReanchorOptions {
	const booleans = new Set<string>();
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (!arg.startsWith("--")) throw new ReanchorRunUsageError(`unexpected argument "${arg.slice(0, 40)}"`);
		const name = arg.slice(2);
		if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
			if (booleans.has(name)) throw new ReanchorRunUsageError(`--${name} given twice`);
			booleans.add(name);
			continue;
		}
		if ((VALUE_FLAGS as readonly string[]).includes(name)) {
			if (values.has(name)) throw new ReanchorRunUsageError(`--${name} given twice`);
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) throw new ReanchorRunUsageError(`--${name} needs a value`);
			values.set(name, value);
			i += 1;
			continue;
		}
		throw new ReanchorRunUsageError(`unknown flag "${arg.slice(0, 40)}" (a value flag takes its value as the next argument)`);
	}
	const planPath = values.get("plan");
	if (planPath === undefined || planPath.length === 0) throw new ReanchorRunUsageError("--plan FILE is required");
	const confirmRaw = values.get("confirm-genesis");
	if (confirmRaw !== undefined && !GENESIS_RE.test(confirmRaw)) throw new ReanchorRunUsageError("--confirm-genesis needs a base58 genesis hash");
	const maxRaw = values.get("max-hours");
	let maxHours = 1;
	if (maxRaw !== undefined) {
		if (!/^[1-9]\d?$/.test(maxRaw) || Number(maxRaw) > MAX_HOURS_PER_RUN) {
			throw new ReanchorRunUsageError(`--max-hours needs an integer from 1 to ${MAX_HOURS_PER_RUN}`);
		}
		maxHours = Number(maxRaw);
	}
	const surfaceRaw = values.get("surface");
	if (surfaceRaw !== undefined && !SURFACE_RE.test(surfaceRaw)) throw new ReanchorRunUsageError("--surface needs a surface name");
	return {
		planPath,
		execute: booleans.has("execute"),
		confirmGenesis: confirmRaw ?? null,
		maxHours,
		surface: surfaceRaw ?? null,
	};
}

// ---------------------------------------------------------------------------
// The saved plan
// ---------------------------------------------------------------------------

/** What this executor needs from `reanchor-plan-run.ts --json`: the plan's hours and the genesis it observed. */
export interface SavedPlanHour {
	period_start: string;
	period_start_ms: number;
	memo: string;
	root: string;
	event_count: number;
	previous_tx_sig: string;
	previous_signer: string;
	target_genesis: string;
}

export interface SavedPlan {
	/** The genesis hash the planning run observed on the cluster the hours would be written to; null only for a plan with no hour (the planner reads no chain then). */
	observed_genesis: string | null;
	/** Ascending by hour. */
	hours: SavedPlanHour[];
}

/** A saved plan that is not a usable schema-1 dry-run plan. The entry exits 2. */
export class ReanchorPlanError extends Error {
	override name = "ReanchorPlanError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function planHour(raw: unknown, index: number, observedGenesis: string): SavedPlanHour {
	const at = `plan.hours[${index}]`;
	if (!isRecord(raw)) throw new ReanchorPlanError(`${at} is not an object`);
	const { period_start, period_start_ms, memo, root, event_count, previous_tx_sig, previous_signer, target_genesis } = raw;
	if (typeof period_start_ms !== "number" || !Number.isSafeInteger(period_start_ms) || period_start_ms % HOUR_MS !== 0) {
		throw new ReanchorPlanError(`${at}.period_start_ms is not a whole UTC hour`);
	}
	if (typeof period_start !== "string" || period_start !== hourIso(period_start_ms)) throw new ReanchorPlanError(`${at}.period_start does not name the hour of period_start_ms`);
	if (typeof root !== "string" || !ROOT_RE.test(root)) throw new ReanchorPlanError(`${at}.root is not 64 lowercase hex`);
	if (typeof event_count !== "number" || !Number.isSafeInteger(event_count) || event_count < 1) throw new ReanchorPlanError(`${at}.event_count is not a positive integer`);
	if (typeof memo !== "string" || memo !== formatMemo({ periodStartMs: period_start_ms, rootHex: root, count: event_count })) {
		throw new ReanchorPlanError(`${at}.memo is not the v1 memo of its own period, root and count`);
	}
	if (typeof previous_tx_sig !== "string" || !SIGNATURE_RE.test(previous_tx_sig)) throw new ReanchorPlanError(`${at}.previous_tx_sig is not a base58 signature`);
	if (typeof previous_signer !== "string" || previous_signer.length === 0) throw new ReanchorPlanError(`${at}.previous_signer is missing`);
	if (typeof target_genesis !== "string" || target_genesis !== observedGenesis) throw new ReanchorPlanError(`${at}.target_genesis is not the plan's observed genesis: a plan names one cluster`);
	return { period_start, period_start_ms, memo, root, event_count, previous_tx_sig, previous_signer, target_genesis };
}

/**
 * Parse the JSON `reanchor-plan-run.ts --json` printed. Refuses anything that is not a schema-1 dry-run report with an observed
 * genesis, or whose hours are not each self-consistent (memo = `formatMemo` of the hour, root and count). A plan with no hours is
 * valid: there is nothing to do, and the planner then reads no chain, so its observed genesis is `null` and that is accepted for
 * an empty plan only.
 */
export function parseSavedPlan(text: string): SavedPlan {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new ReanchorPlanError("the plan file is not JSON");
	}
	if (!isRecord(body)) throw new ReanchorPlanError("the plan file is not a JSON object");
	if (body["schema"] !== 1) throw new ReanchorPlanError("the plan file is not schema 1");
	if (body["dry_run"] !== true) throw new ReanchorPlanError("the plan file is not a dry-run plan (dry_run is not true)");
	const plan = body["plan"];
	const rawHours = isRecord(plan) ? plan["hours"] : undefined;
	if (!isRecord(plan) || plan["dry_run"] !== true || !Array.isArray(rawHours)) throw new ReanchorPlanError("the plan has no plan.hours list");
	const chain = body["chain"];
	const observed = isRecord(chain) ? chain["observed_genesis"] : undefined;
	if (observed === null && rawHours.length === 0) return { observed_genesis: null, hours: [] };
	if (typeof observed !== "string" || !GENESIS_RE.test(observed)) throw new ReanchorPlanError("the plan has no observed genesis hash (chain.observed_genesis)");
	const hours = rawHours.map((raw: unknown, index: number) => planHour(raw, index, observed));
	const seen = new Set<number>();
	for (const hour of hours) {
		if (seen.has(hour.period_start_ms)) throw new ReanchorPlanError(`the plan names ${hour.period_start} twice`);
		seen.add(hour.period_start_ms);
	}
	hours.sort((a, b) => a.period_start_ms - b.period_start_ms);
	return { observed_genesis: observed, hours };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/** Closed refusal names, the first word on a refusal line. */
export type RefusalCode =
	| "genesis-unconfirmed"
	| "rpc-url-refused"
	| "rpc-unreadable"
	| "genesis-mismatch"
	| "wrong-cluster"
	| "signer-mismatch"
	| "signer-set-incomplete"
	| "signer-not-current"
	| "unfunded"
	| "no-operator-surface"
	| "store-failed"
	| "row-missing"
	| "digest-failed"
	| "root-mismatch"
	| "present-on-cluster"
	| "discovery-incomplete"
	| "notes-incomplete"
	| "reanchor-locked"
	| "send-failed"
	| "unexpected";

export interface ReanchorResult {
	code: 0 | 1;
	stdout: string;
	stderr: string;
	/** Transactions this run sent. */
	sent: number;
	/** Hours whose earlier send was adopted instead of sending again. */
	adopted: number;
	/** The refusal that stopped the run, or null. */
	refused: RefusalCode | null;
}

/**
 * The default mode: print what `--execute` would do and touch nothing. Pure: it takes no port, so there is no runner, rpc, ledger
 * or clock it could call.
 */
export function dryRunReanchor(plan: SavedPlan, options: ReanchorOptions): ReanchorResult {
	const lines: string[] = [];
	if (plan.hours.length === 0) {
		lines.push("[reanchor] dry run: the plan has no hour to re-anchor");
	} else {
		for (const hour of plan.hours) lines.push(`[reanchor] would re-anchor ${hour.period_start} (${hour.event_count} events)`);
		lines.push(`[reanchor] dry run: nothing was read, signed or sent; ${plan.hours.length} hour(s) would be re-anchored onto genesis ${plan.observed_genesis}`);
		if (plan.hours.length > options.maxHours) {
			lines.push(`[reanchor] --execute would send at most ${options.maxHours} transaction(s) per run (--max-hours); run it again for the rest`);
		}
		lines.push("[reanchor] to send (OPERATOR ONLY): add --execute --confirm-genesis <the genesis above> [--max-hours N]");
	}
	return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "", sent: 0, adopted: 0, refused: null };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export interface ReanchorEnv {
	rpcUrl: string;
	keypairPath: string;
	/** The configured anchor public key (`SOLANA_ANCHOR_PUBKEY`). */
	pubkey: string;
	cli: string;
}

/** The result of trying to take the run's lock: the held lock to release, or why it is held by another run. */
export type LockAttempt = { release(): void } | { held: string };

/** The inter-process lock a run holds across discovery, send and recording. Synchronous: the file system call is one step. */
export interface ReanchorLock {
	acquire(): LockAttempt;
}

export interface ReanchorDeps {
	/** `anchorForPeriod` is the only ledger read the executor makes; it never writes the `anchors` table. */
	ledger: Pick<GreptimeClient, "anchorForPeriod">;
	rpc: Rpc;
	runner: Runner;
	substrate: Pick<Substrate, "hourDigest" | "emit">;
	env: ReanchorEnv;
	/** The operator surface the note is written as; null when none could be chosen. */
	surface: Surface | null;
	/** The surfaces the verifier trusts for `anchor.reanchor` (`operatorSurfaces(config)`). */
	operatorSurfaces: ReadonlySet<string>;
	clock?: () => number;
	/**
	 * The recorded `anchor.reanchor` notes of an hour that are bound to it, read through the trusted-surface read the verifier uses
	 * (`readReanchorNotes`). A throw refuses (`notes-incomplete`) before any send: the pointer the verifier follows is unknown. A
	 * result with `incomplete` set is refused (`notes-incomplete`), as the verifier leaves the hour unverified.
	 */
	notes: (hour: SavedPlanHour) => Promise<ReanchorNotes>;
	/**
	 * The effective signer set `checkpoint_verify` judges against (`resolveSignerSet`): the bootstrap folded with the operator's rotation
	 * notes. Read ONCE per run, before any send. A throw or a `gap` (the rotation read may be incomplete) refuses (`signer-set-incomplete`).
	 */
	signers: () => Promise<{ set: SignerSet; gap: string | null }>;
	/** The lock held across discovery, send and recording. */
	lock: ReanchorLock;
}

class Refusal extends Error {
	constructor(
		readonly code: RefusalCode,
		detail: string,
	) {
		super(detail);
	}
}

/** A failure's reason: redacted, every URL and address removed (an endpoint may carry a credential), one line, short. */
export function reasonOf(cause: unknown): string {
	return redact(cause instanceof Error ? cause.message : String(cause))
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<addr>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
}

async function liveGenesis(rpc: Rpc): Promise<string> {
	try {
		return await rpc.getGenesisHash();
	} catch (cause) {
		throw new Refusal("rpc-unreadable", `getGenesisHash failed: ${reasonOf(cause)}`);
	}
}

/**
 * Gates 1 to 3: everything that must hold before ANY hour is looked at, so nothing is sent on a wrong cluster, key or balance. The key
 * gate is two checks: the keypair file is the configured public key, and the configured public key is a signer the verifier accepts
 * NOW (`readSigners`, the effective signer set). Returns the confirmed genesis and that signer set.
 */
async function checkGates(plan: SavedPlan, options: ReanchorOptions, deps: ReanchorDeps, sendBudget: number, now: number): Promise<{ genesis: string; signers: SignerSet }> {
	const { rpc, runner, env } = deps;
	if (options.confirmGenesis === null) throw new Refusal("genesis-unconfirmed", "--execute needs --confirm-genesis <hash>: the operator must name the cluster being written to");
	try {
		assertDevnetRpcUrl(env.rpcUrl);
	} catch {
		// The URL itself is not quoted: an endpoint may carry a credential.
		throw new Refusal("rpc-url-refused", "SOLANA_RPC_URL is refused by the devnet-only guard");
	}

	const genesis = await liveGenesis(rpc);
	if (genesis === MAINNET_BETA_GENESIS_HASH || genesis === TESTNET_GENESIS_HASH) {
		throw new Refusal("wrong-cluster", `the endpoint reports the genesis of Solana ${genesis === MAINNET_BETA_GENESIS_HASH ? "mainnet-beta" : "testnet"}; only a reset devnet may be written to`);
	}
	if (genesis !== options.confirmGenesis) throw new Refusal("genesis-mismatch", `the endpoint reports genesis ${genesis}, not the confirmed ${options.confirmGenesis}`);
	if (genesis !== plan.observed_genesis) throw new Refusal("genesis-mismatch", `the endpoint reports genesis ${genesis}, but the plan was made against ${plan.observed_genesis}: re-run the plan`);

	if (!isAbsolute(env.keypairPath)) throw new Refusal("signer-mismatch", "SOLANA_ANCHOR_KEYPAIR must be an absolute path");
	let shown: string;
	try {
		const pubkey = await runner(pubkeyArgv({ keygen: keygenPath(env.cli), keypairPath: env.keypairPath }));
		shown = pubkey.stdout.trim();
		if (pubkey.code !== 0 || shown === "") throw new Error(`solana-keygen pubkey exited ${String(pubkey.code)}: ${pubkey.stderr.slice(0, 200)}`);
	} catch (cause) {
		throw new Refusal("signer-mismatch", `solana-keygen pubkey failed: ${reasonOf(cause)}`);
	}
	if (shown !== env.pubkey) throw new Refusal("signer-mismatch", "solana-keygen pubkey does not equal SOLANA_ANCHOR_PUBKEY");
	// The key file matches; whether the verifier would ACCEPT that key now is the signer set's say (rotation windows), read once per run.
	const signers = await readSigners(deps, now);

	let balance: number;
	try {
		balance = await rpc.balance(env.pubkey);
	} catch (cause) {
		throw new Refusal("rpc-unreadable", `getBalance failed: ${reasonOf(cause)}`);
	}
	const required = REQUIRED_BALANCE_LAMPORTS + SEND_FEE_LAMPORTS * Math.max(0, sendBudget - 1);
	if (balance < required) {
		throw new Refusal("unfunded", `the key holds ${balance} lamports, below the rent-exempt minimum plus the fees of ${sendBudget} send(s) (${required})`);
	}

	// The note is the only thing the verifier follows: refuse to send a transaction that could not be recorded in a way it trusts.
	if (deps.surface === null || !deps.operatorSurfaces.has(deps.surface)) {
		throw new Refusal(
			"no-operator-surface",
			"no operator surface to record the re-anchor as: name one with --surface (it must be a surface an operator token maps to), because the verifier ignores a note from any other",
		);
	}
	return { genesis, signers };
}

/**
 * Gate 3b: the effective signer set, read ONCE per run before any send, judged the way `checkpoint_verify` judges it. A read that
 * fails, or whose rotation read may be incomplete (`gap`), refuses (`signer-set-incomplete`): a missing rotation note could mean the
 * configured key is retired, or that an earlier send was by a key this run does not know. The configured key must be accepted NOW
 * (`signer-not-current`): a replacement it signs outside its window would be rejected by the verifier and then called "already
 * recorded" by every later run.
 */
async function readSigners(deps: ReanchorDeps, now: number): Promise<SignerSet> {
	let signers: { set: SignerSet; gap: string | null };
	try {
		signers = await deps.signers();
	} catch (cause) {
		throw new Refusal("signer-set-incomplete", `the signer set could not be read (${reasonOf(cause)}), so which keys the verifier accepts is unknown: nothing was sent`);
	}
	if (signers.gap !== null) {
		throw new Refusal("signer-set-incomplete", `the signer set may be incomplete (${reasonOf(signers.gap)}), so a rotation the verifier applies may be missing here: nothing was sent`);
	}
	const current = acceptsSigner(signers.set, deps.env.pubkey, now);
	if (!current.ok) throw new Refusal("signer-not-current", `SOLANA_ANCHOR_PUBKEY is not a valid anchor signer now (${current.reason}): a transaction it signed would be rejected by the verifier, so nothing was sent`);
	return signers.set;
}

/**
 * Is this transaction signed by a key the signer set accepts at THE TRANSACTION'S block time (the verifier's rule)? A payer outside
 * the set, or outside its window at that time, is false. A block time the cluster did not report cannot be judged against a window:
 * it refuses (`rpc-unreadable`) rather than being read as "not by the signer", which would send the hour again.
 */
function signedByAcceptedKey(found: TransactionMemo, set: SignerSet, hour: SavedPlanHour, signature: string): boolean {
	if (found.payer === null || !set.some((entry) => entry.pubkey === found.payer)) return false;
	if (found.blockTime === null) {
		throw new Refusal("rpc-unreadable", `${hour.period_start}: transaction ${signature} has no block time, so whether its signer was allowed at the time cannot be told: nothing was sent`);
	}
	return acceptsSigner(set, found.payer, found.blockTime * 1000).ok;
}

/**
 * Gate 4, for one hour: the stored row, the plan and the recomputed digest must agree byte for byte. Read-only. A disagreement is a
 * ledger-integrity question, never something a re-anchor may paper over.
 */
async function checkHour(hour: SavedPlanHour, deps: ReanchorDeps, now: number): Promise<void> {
	let stored: AnchorRow | null;
	try {
		stored = await deps.ledger.anchorForPeriod(hour.period_start_ms);
	} catch (cause) {
		throw new Refusal("store-failed", `${hour.period_start}: the anchors row could not be read: ${reasonOf(cause)}`);
	}
	if (stored === null) throw new Refusal("row-missing", `${hour.period_start}: there is no stored anchors row for this hour, so there is nothing to re-anchor`);
	if (stored.root !== hour.root || stored.event_count !== hour.event_count || stored.memo !== hour.memo || stored.tx_sig !== hour.previous_tx_sig) {
		throw new Refusal("root-mismatch", `${hour.period_start}: the stored anchors row (root, count, memo or signature) differs from the saved plan: re-run the plan`);
	}
	let digest: HourDigest;
	try {
		digest = await deps.substrate.hourDigest(hour.period_start_ms, now);
	} catch (cause) {
		throw new Refusal("digest-failed", `${hour.period_start}: the hour could not be recomputed: ${reasonOf(cause)}`);
	}
	if (digest.root === null || digest.memo === null || digest.root !== hour.root || digest.event_count !== hour.event_count) {
		throw new Refusal("root-mismatch", `${hour.period_start}: the ledger now recomputes root ${String(digest.root)} over ${digest.event_count} events, not the stored ${hour.root} over ${hour.event_count}`);
	}
	if (digest.memo !== hour.memo || hour.memo !== formatMemo({ periodStartMs: hour.period_start_ms, rootHex: digest.root, count: digest.event_count })) {
		throw new Refusal("root-mismatch", `${hour.period_start}: the recomputed memo is not byte for byte the stored memo`);
	}
}

/** The transaction as the cluster answers at either level, highest first; null when it knows neither. */
async function lookup(rpc: Rpc, signature: string): Promise<TransactionMemo | null> {
	for (const level of ["finalized", "confirmed"] as const) {
		const found = await rpc.transactionMemo(signature, level);
		if (found !== null) return found;
	}
	return null;
}

/** Gate 5a: the stored signature must be absent on the cluster. Present means it is not a reset for this hour. */
async function checkPreviousAbsent(hour: SavedPlanHour, rpc: Rpc): Promise<void> {
	let found: TransactionMemo | null;
	try {
		found = await lookup(rpc, hour.previous_tx_sig);
	} catch (cause) {
		throw new Refusal("rpc-unreadable", `${hour.period_start}: the stored signature could not be looked up: ${reasonOf(cause)}`);
	}
	if (found !== null) {
		throw new Refusal("present-on-cluster", `${hour.period_start}: the stored signature exists on this cluster, so this is not a reset for this hour and nothing is re-anchored`);
	}
}

/** Signatures one discovery page asks for. */
export const DISCOVERY_PAGE_SIZE = ADDRESS_MEMO_LIMIT;
/** Pages discovery may read before it refuses: the hard cap on `getSignaturesForAddress` calls. */
export const DISCOVERY_MAX_PAGES = 100;

/** What the recorded notes say about one hour: the signature when the hour is recorded, else the event id of a stale newest note (null when there is none). */
interface RecordedState {
	signature: string | null;
	stale: string | null;
}

/**
 * Gate 6a, for one hour: the NEWEST `anchor.reanchor` note bound to the hour (same root, count and previous signature; chosen by
 * `newestBoundNote`, the same choice the verifier makes) is the only pointer that counts. Its transaction being on this cluster,
 * memo-exact and signed by a key the signer set accepts at the transaction's block time means the hour is done: its signature is returned. A newest note whose transaction the cluster
 * does not know, or that is wrong or failed, means the hour is NOT recorded, whatever older notes say (the verifier never falls back
 * to an older one): `signature` is null, `stale` names that note so the repair note gets its own idempotency key, and discovery runs
 * and adopts an earlier valid send or sends once. A transaction that cannot be read refuses, because a recorded send may be live. A
 * notes read that is incomplete (`incomplete` set: a surface cut by its page cap may hold a NEWER bound note than any returned) refuses
 * with `notes-incomplete`, the way the verifier treats it (`ReanchorReadIncomplete`, hour unverified): the pointer it follows is
 * unknown, so nothing is sent. A notes read that fails refuses the same way: a failed read is never read as "no note".
 */
async function recordedSignature(hour: SavedPlanHour, deps: ReanchorDeps, signers: SignerSet): Promise<RecordedState> {
	let notes: ReanchorNotes;
	try {
		notes = await deps.notes(hour);
	} catch (cause) {
		// An unreadable ledger is not an absent note: a newer bound note may exist, and the note write needs the same ledger.
		throw new Refusal(
			"notes-incomplete",
			`${hour.period_start}: the anchor.reanchor notes could not be read (${reasonOf(cause)}), so the pointer the verifier follows is unknown: nothing was sent`,
		);
	}
	if (notes.incomplete !== null) {
		throw new Refusal(
			"notes-incomplete",
			`${hour.period_start}: the anchor.reanchor notes could not be read completely (${notes.incomplete}), so the pointer the verifier follows is unknown: nothing was sent`,
		);
	}
	const newest = newestBoundNote(notes.records, { root: hour.root, event_count: hour.event_count, tx_sig: hour.previous_tx_sig });
	if (newest === null) return { signature: null, stale: null };
	let found: TransactionMemo | null;
	try {
		found = await lookup(deps.rpc, newest.payload.new_tx_sig);
	} catch (cause) {
		throw new Refusal("rpc-unreadable", `${hour.period_start}: the recorded transaction ${newest.payload.new_tx_sig} could not be read: ${reasonOf(cause)}`);
	}
	if (found !== null && found.memo !== null && found.payerSigned && found.err === null) {
		const memo = parseMemo(found.memo);
		if (
			memo !== null &&
			memo.periodStartMs === hour.period_start_ms &&
			memo.rootHex === hour.root &&
			memo.count === hour.event_count &&
			signedByAcceptedKey(found, signers, hour, newest.payload.new_tx_sig)
		) {
			return { signature: newest.payload.new_tx_sig, stale: null };
		}
	}
	return { signature: null, stale: newest.event_id };
}

/**
 * Gate 6b, one listing for the hours without a recorded note: the signer's signatures are paged backwards (`before` the oldest
 * signature of the previous page) at `confirmed` commitment (a send is read back at `confirmed`, so a confirmed but not yet finalized
 * send must be found by the very next run) and every memo naming a wanted hour is kept as a hint. Paging stops when the signer's history is
 * exhausted (a short page) or a page ends at a block older than the earliest wanted period start: nothing before it can be a send of
 * these hours. A cap hit first is `discovery-incomplete`, an unreadable page `rpc-unreadable`; neither is ever read as "absent".
 */
async function listEarlierSends(hours: readonly SavedPlanHour[], deps: ReanchorDeps, signers: SignerSet): Promise<Map<number, string[]>> {
	const { rpc } = deps;
	const wanted = new Set(hours.map((hour) => hour.period_start_ms));
	const horizonMs = Math.min(...wanted);
	const hints = new Map<number, string[]>();
	// Every distinct key of the signer set: an hour an earlier key sent is listed under that key's address, not the configured one's.
	for (const address of new Set(signers.map((entry) => entry.pubkey))) {
		let before: string | undefined;
		for (let page = 1; ; page++) {
			let listing: AddressMemo[];
			try {
				listing = await rpc.addressMemos(address, DISCOVERY_PAGE_SIZE, before, "confirmed");
			} catch (cause) {
				throw new Refusal("rpc-unreadable", `the signer's signatures could not be listed (page ${page}): ${reasonOf(cause)}`);
			}
			for (const hint of listing) {
				const parsed = hint.memo === null ? null : parseMemo(hint.memo);
				if (parsed === null || !wanted.has(parsed.periodStartMs)) continue;
				const known = hints.get(parsed.periodStartMs);
				if (known === undefined) hints.set(parsed.periodStartMs, [hint.signature]);
				else if (!known.includes(hint.signature)) known.push(hint.signature);
			}
			const oldest = listing[listing.length - 1];
			if (oldest === undefined || listing.length < DISCOVERY_PAGE_SIZE) break;
			if (typeof oldest.blockTime === "number" && oldest.blockTime * 1000 < horizonMs) break;
			if (page >= DISCOVERY_MAX_PAGES) {
				throw new Refusal(
					"discovery-incomplete",
					`the signer's signatures were not listed back to ${hourIso(horizonMs)} within ${DISCOVERY_MAX_PAGES} pages of ${DISCOVERY_PAGE_SIZE}, so an earlier send cannot be ruled out: nothing was sent`,
				);
			}
			before = oldest.signature;
		}
	}
	return hints;
}

/**
 * Gate 6c, for one hour: the hinted transactions are confirmed by reading them. The same root and count adopt; a different root or
 * count for this hour is refused. Returns the signature to adopt, or null when no hinted transaction is this hour's memo by the signer.
 */
async function confirmEarlierSend(hour: SavedPlanHour, signatures: readonly string[], deps: ReanchorDeps, signers: SignerSet): Promise<string | null> {
	const { rpc } = deps;
	for (const signature of signatures) {
		let confirmed: TransactionMemo | null;
		try {
			confirmed = await rpc.transactionMemo(signature, "confirmed");
		} catch (cause) {
			throw new Refusal("rpc-unreadable", `${hour.period_start}: transaction ${signature} could not be read: ${reasonOf(cause)}`);
		}
		// A listed memo for this hour whose transaction cannot be read may already anchor it: sending again could duplicate it.
		if (confirmed === null) throw new Refusal("rpc-unreadable", `${hour.period_start}: transaction ${signature} could not be read, so an earlier send cannot be ruled out`);
		if (confirmed.memo === null || !confirmed.payerSigned || confirmed.err !== null) continue;
		const memo = parseMemo(confirmed.memo);
		if (memo === null || memo.periodStartMs !== hour.period_start_ms) continue;
		if (!signedByAcceptedKey(confirmed, signers, hour, signature)) continue;
		if (memo.rootHex === hour.root && memo.count === hour.event_count) return signature;
		throw new Refusal("root-mismatch", `${hour.period_start}: the cluster already holds a memo by the signer for this hour with root ${memo.rootHex} over ${memo.count} events, not the stored ${hour.root} over ${hour.event_count}`);
	}
	return null;
}

/** Minutes an operator waits after a send that ended without a readable signature: a blockhash is valid for about 150 slots, so two minutes outlast it. */
export const SEND_SETTLE_MINUTES = 2;

/**
 * Said whenever a send ended without a signature to read back (a non-zero exit, a timeout or a signal: `code` null, an output with no
 * signature). The runner kills `solana transfer` at its timeout, so the transaction may already be broadcast and land later; a blockhash
 * is valid for about 150 slots (about a minute), so after two minutes a transaction that did not land never will. Re-running at once
 * could find nothing yet and send the hour a second time (two fees, two memos).
 */
const MAY_STILL_LAND = `the transaction MAY STILL LAND: wait at least ${String(SEND_SETTLE_MINUTES)} minutes (a blockhash expires after about 150 slots) before re-running, after which discovery adopts it if it landed`;

/** The one send: `transferMemoArgv` with the plan's stored memo, then the job's own read-back. Returns the new signature. */
async function sendMemo(hour: SavedPlanHour, deps: ReanchorDeps): Promise<string> {
	const { runner, rpc, env } = deps;
	let argv: string[];
	try {
		argv = transferMemoArgv({ cli: env.cli, pubkey: env.pubkey, memo: hour.memo, rpcUrl: env.rpcUrl, keypairPath: env.keypairPath, amountSol: AMOUNT_ZERO });
	} catch (cause) {
		throw new Refusal("send-failed", `${hour.period_start}: ${reasonOf(cause)}`);
	}
	let sent: RunResult;
	try {
		sent = await runner(argv);
	} catch (cause) {
		throw new Refusal("send-failed", `${hour.period_start}: the send could not run: ${reasonOf(cause)}`);
	}
	if (sent.code !== 0) {
		throw new Refusal("send-failed", `${hour.period_start}: the send exited ${String(sent.code)}: ${reasonOf(sent.stderr)}; ${MAY_STILL_LAND}`);
	}
	let signature: string;
	try {
		signature = parseSignature(sent.stdout);
	} catch (cause) {
		throw new Refusal("send-failed", `${hour.period_start}: ${reasonOf(cause)}; ${MAY_STILL_LAND}`);
	}
	let readBack: TransactionMemo | null;
	try {
		readBack = await rpc.transactionMemo(signature, "confirmed");
	} catch (cause) {
		throw new Refusal("send-failed", `${hour.period_start}: sent ${signature} but its read-back failed (re-run to adopt it if it landed): ${reasonOf(cause)}`);
	}
	const back = readBack?.memo !== null && readBack?.memo !== undefined ? parseMemo(readBack.memo) : null;
	if (
		readBack === null ||
		back === null ||
		back.periodStartMs !== hour.period_start_ms ||
		back.rootHex !== hour.root ||
		back.count !== hour.event_count ||
		readBack.payer !== env.pubkey ||
		!readBack.payerSigned ||
		readBack.err !== null
	) {
		throw new Refusal("send-failed", `${hour.period_start}: sent ${signature} but its read-back does not match the memo (re-run to adopt it if it landed)`);
	}
	return signature;
}

/**
 * The idempotency key of a REPAIR note: `reanchor:<period_start>:r:<first 40 hex of sha256(new_tx_sig + ":" + supersedes)>`, where
 * `supersedes` is the event id of the stale newest note the repair replaces. The plain key (`reanchor:<period_start>:<new_tx_sig>`)
 * would equal that of an older note naming the same signature, so the repair would be deduplicated away and the stale note would stay
 * the verifier's pointer. A full signature plus an event id would overflow the 128-character key limit, hence the hash. A replay of
 * the same repair (same stale note) has the same key; once the repair is stored it is the newest bound note and no further repair is made.
 */
export function repairIdempotencyKey(period_start: string, newTxSig: string, supersedes: string): string {
	return `reanchor:${period_start}:r:${createHash("sha256").update(`${newTxSig}:${supersedes}`).digest("hex").slice(0, 40)}`;
}

/** Write the `anchor.reanchor` note as the operator surface. The transaction is already on chain: a lost note is reported with its full payload and never resent. `supersedes` is the stale newest note a repair replaces. */
async function recordReanchor(hour: SavedPlanHour, newTxSig: string, genesis: string, deps: ReanchorDeps, supersedes: string | null): Promise<void> {
	const draft = buildReanchorEvent({
		period_start: hour.period_start,
		root: hour.root,
		event_count: hour.event_count,
		previous_tx_sig: hour.previous_tx_sig,
		new_tx_sig: newTxSig,
		genesis,
	});
	const idempotencyKey = supersedes === null ? draft.idempotency_key : repairIdempotencyKey(hour.period_start, newTxSig, supersedes);
	const manual = `payload ${JSON.stringify(draft.payload)} as surface ${String(deps.surface)}, session ${reanchorSessionId(hour.period_start)}`;
	let stored = false;
	let why = "the ledger did not store it";
	try {
		const result = await deps.substrate.emit({
			surface: deps.surface as Surface,
			kind: draft.kind,
			summary: draft.summary,
			session_id: reanchorSessionId(hour.period_start),
			payload: { ...draft.payload },
			idempotency_key: idempotencyKey,
		});
		stored = result.stored === true;
		if (!stored && result.error !== undefined) why = reasonOf(result.error);
	} catch (cause) {
		why = reasonOf(cause);
	}
	if (!stored) {
		throw new Refusal(
			"store-failed",
			`${hour.period_start}: re-anchored as ${newTxSig} but the anchor.reanchor note was not stored (${why}); re-run to record it (the transaction is adopted, never resent), or emit by hand: ${manual}`,
		);
	}
}

/**
 * `--execute`: send the plan's hours, at most `options.maxHours` transactions, after every gate. Never throws: every refusal is a
 * result with code 1 and the first word of stderr naming the gate. The only mutating calls are the one `runner` send per hour and the
 * one `substrate.emit` note; the `anchors` table is never written. Every read-only check of every hour (gates 1 to 4, then the lock
 * and gate 6) finishes before the first send; what can still stop a run after a send is that send's own failure, its read-back and
 * its note. Hours already sent and recorded are adopted by a re-run, so stopping there is safe.
 */
export async function executeReanchor(plan: SavedPlan, options: ReanchorOptions, deps: ReanchorDeps): Promise<ReanchorResult> {
	if (!options.execute) return dryRunReanchor(plan, options);
	const out: string[] = [];
	const state = { sent: 0, adopted: 0 };
	const done = (refused: RefusalCode | null, detail: string | null): ReanchorResult => ({
		code: refused === null ? 0 : 1,
		stdout: out.length === 0 ? "" : `${out.join("\n")}\n`,
		stderr: detail === null ? "" : `[reanchor] REFUSED ${String(refused)}: ${detail}\n`,
		sent: state.sent,
		adopted: state.adopted,
		refused,
	});
	try {
		if (plan.hours.length === 0) {
			out.push("[reanchor] the plan has no hour to re-anchor");
			return done(null, null);
		}
		const now = (deps.clock ?? Date.now)();
		const cap = Math.min(options.maxHours, MAX_HOURS_PER_RUN);
		const budget = Math.min(cap, plan.hours.length);
		const { genesis, signers } = await checkGates(plan, options, deps, budget, now);
		for (const hour of plan.hours) await checkHour(hour, deps, now);

		const lock = deps.lock.acquire();
		if ("held" in lock) throw new Refusal("reanchor-locked", `another re-anchor run is in progress (${lock.held}); wait for it to finish, or remove the lock file if that run is gone`);
		try {
			// Every read-only check of every hour first: nothing below this loop and the discovery that follows can refuse before a send.
			const recorded = new Map<number, string>();
			const stale = new Map<number, string>();
			const unrecorded: SavedPlanHour[] = [];
			for (const hour of plan.hours) {
				await checkPreviousAbsent(hour, deps.rpc);
				const noted = await recordedSignature(hour, deps, signers);
				if (noted.signature === null) {
					unrecorded.push(hour);
					if (noted.stale !== null) stale.set(hour.period_start_ms, noted.stale);
				} else recorded.set(hour.period_start_ms, noted.signature);
			}
			const earlier = new Map<number, string>();
			if (unrecorded.length > 0) {
				const hints = await listEarlierSends(unrecorded, deps, signers);
				for (const hour of unrecorded) {
					const adopted = await confirmEarlierSend(hour, hints.get(hour.period_start_ms) ?? [], deps, signers);
					if (adopted !== null) earlier.set(hour.period_start_ms, adopted);
				}
			}

			let left = 0;
			for (const hour of plan.hours) {
				const noted = recorded.get(hour.period_start_ms);
				if (noted !== undefined) {
					state.adopted += 1;
					out.push(`[reanchor] ${hour.period_start} adopted ${noted} (already recorded)`);
					continue;
				}
				const found = earlier.get(hour.period_start_ms);
				let signature: string;
				if (found !== undefined) {
					signature = found;
					state.adopted += 1;
					out.push(`[reanchor] ${hour.period_start} adopted ${signature}`);
				} else {
					if (state.sent >= cap) {
						left += 1;
						continue;
					}
					signature = await sendMemo(hour, deps);
					state.sent += 1;
					out.push(`[reanchor] ${hour.period_start} re-anchored ${signature}`);
				}
				await recordReanchor(hour, signature, genesis, deps, stale.get(hour.period_start_ms) ?? null);
			}
			out.push(`[reanchor] done: ${state.sent} sent, ${state.adopted} adopted, ${left} left in the plan${left > 0 ? " (run again)" : ""}`);
			if (genesis !== DEVNET_GENESIS_HASH) {
				out.push(`[reanchor] note: verification reads anything on genesis ${genesis} as unverified until DEVNET_GENESIS_HASH moves to it (runbook step b)`);
			}
			return done(null, null);
		} finally {
			lock.release();
		}
	} catch (cause) {
		if (cause instanceof Refusal) return done(cause.code, cause.message);
		return done("unexpected", reasonOf(cause));
	}
}
