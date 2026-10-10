/**
 * The one-shot hourly anchor job (D28-01, ANCHOR-03/04 execution half).
 *
 * Pure orchestration over injected ports — greptime, substrate, runner, rpc,
 * clock and env — so every path below runs in tests against stubs with no
 * real CLI, RPC or store touched. `anchor-run.ts` is the thin entry point
 * that builds those ports from `loadConfig()` and the `SOLANA_*` env.
 *
 * Per run: read the coverage start (hour of the earliest ingest record) and
 * the anchors window, take the closed, non-empty, unanchored hours ascending
 * (at most 24 non-empty hours per run under a 7-day lookback; empty hours
 * never receive a row, and damaged hours are reported and skipped, so
 * neither consumes the budget), and for each one
 * adopt an existing signer-checked memo or send the digest memo through the
 * solana CLI, then write the production 11-column anchors row and emit
 * `anchor.written`. A `--period` re-run consults that hour's row directly, so
 * an hour older than the lookback is never anchored twice; a send-path hour
 * the sweep map calls absent re-checks its row too, so a memo aged out of
 * the 100-signature listing never anchors an hour twice. Bad hour data
 * emits `anchor.failed` during the peek and is skipped, so a later healthy
 * hour still fits in the budget (a root mismatch also alarms and exits 1);
 * a failed store read, a lost `anchor.failed`
 * warning, and a lost `anchor.written` note are reported as store-failed
 * without resending the transaction. Systemic failures (wrong cluster,
 * signer mismatch, unfunded key, unreadable RPC, CLI or store failure)
 * stop the run before the next send.
 *
 * The memo carries period_start, root and count only — never event content —
 * and the keypair is only ever a path on an argv the CLI reads.
 */
import {
	AMOUNT_ZERO,
	HOUR_MS,
	hourIso,
	hourStart,
	isClosed,
	keygenPath,
	parseMemo,
	parseSignature,
	pubkeyArgv,
	transferMemoArgv,
	type AddressMemo,
	type Rpc,
	type RunResult,
	type Runner,
	type TransactionMemo,
} from "@substrate/ledger";
import { isAbsolute as isAbsPath } from "node:path";
import { InvalidEventError } from "./event.ts";
import { GreptimeError, INGEST_LAG_MS, type GreptimeClient, type NewAnchor } from "./greptime.ts";
import { redact } from "./redact.ts";
import type { HourDigest, Substrate } from "./service.ts";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqaEyCydFLPYGEC";

/** At most this many non-empty hours anchor per run; empty hours are free, older unanchored hours wait for the next tick. */
export const MAX_HOURS_PER_RUN = 24;

/** How far back a run looks for unanchored hours; older ones are verify's `unanchored`. */
export const ANCHOR_LOOKBACK_MS = 7 * 24 * HOUR_MS;

/** Recent signatures scanned for an adoptable memo per candidate hour. */
export const ADDRESS_MEMO_LIMIT = 100;

/**
 * What the key must hold: the rent-exempt minimum for a bare account plus one
 * send's fee. The rent figure is the well-known ~0.00089 SOL for 0 bytes; the
 * job needs the account to stay rent-exempt *and* pay 5,000 lamports a send.
 */
export const REQUIRED_BALANCE_LAMPORTS = 890_880 + 5_000;

/** Closed `anchor.failed` reasons, exactly as EVENT_SOURCES samples them. */
export type AnchorFailReason =
	| "digest-failed"
	| "root-mismatch"
	| "unfunded"
	| "wrong-cluster"
	| "signer-mismatch"
	| "rpc-unreadable"
	| "send-failed"
	| "store-failed";

export interface AnchorEnv {
	rpcUrl: string;
	keypairPath: string;
	pubkey: string;
	cli: string;
}

export interface AnchorDeps {
	greptime: GreptimeClient;
	substrate: Pick<Substrate, "hourDigest" | "emit">;
	runner: Runner;
	rpc: Rpc;
	env: AnchorEnv;
	clock?: () => number;
	options?: AnchorCliOptions;
}

/** What `anchor-run.ts` passes from its flags. */
export interface AnchorCliOptions {
	/** One hour only: re-check it (adopt path for an anchored hour), skip the sweep. */
	onlyPeriodMs?: number;
	/** Preview: print what would anchor, write and send nothing. */
	dryRun?: boolean;
}

export const ANCHOR_USAGE =
	"usage: anchor-run.ts [--period <YYYY-MM-DDTHH:00:00.000Z>] [--dry-run]\n" +
	"  SOLANA_ANCHOR_KEYPAIR and SOLANA_ANCHOR_PUBKEY must be set; nothing is sent without them.\n";

/** A usage error: the entry point prints {@link ANCHOR_USAGE} and exits 2. */
export class UsageError extends Error {}

/**
 * Parse the entry point's flags. Pure, so tests pin it without spawning.
 * `--period` names one whole UTC hour; anything else is a usage error.
 */
export function parseAnchorArgs(argv: readonly string[]): AnchorCliOptions {
	const options: AnchorCliOptions = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run") {
			options.dryRun = true;
		} else if (arg === "--period") {
			const raw = argv[i + 1];
			if (raw === undefined) throw new UsageError("--period needs an hour");
			i++;
			const ms = Date.parse(raw);
			if (!Number.isFinite(ms) || ms !== hourStart(ms)) {
				throw new UsageError(`--period ${raw} is not a whole UTC hour`);
			}
			options.onlyPeriodMs = ms;
		} else {
			throw new UsageError(`unknown argument ${arg ?? ""}`);
		}
	}
	return options;
}

export interface AnchorResult {
	code: 0 | 1;
	anchored: number;
	adopted: number;
	failed: number;
}

/** A systemic failure: stop the run before the next send. */
class SystemicError extends Error {
	constructor(readonly reason: AnchorFailReason, detail: string) {
		super(detail);
	}
}

function anchorSession(periodStartIso: string): string {
	return `anchor:${periodStartIso.slice(0, 13)}`;
}

async function emitWritten(
	substrate: Pick<Substrate, "hourDigest" | "emit">,
	digest: HourDigest,
	txSig: string,
	adopted: boolean,
): Promise<{ stored: boolean }> {
	return substrate.emit({
		surface: "substrate",
		kind: "note",
		summary: `anchored hour ${digest.period_start.slice(0, 13)}: ${digest.event_count} events`,
		session_id: anchorSession(digest.period_start),
		payload: {
			action: "anchor",
			runtime: "anchor",
			period_start: digest.period_start,
			period_end: digest.period_end,
			root: digest.root,
			event_count: digest.event_count,
			tx_sig: txSig,
			cluster: "devnet",
			adopted,
		},
	});
}

/**
 * Whether a failed `hourDigest` is bad hour data (report and continue to
 * the next hour) rather than a store failure (report as store-failed and
 * stop the run before the next send). Production data errors are the `hour
 * member …` GreptimeErrors from the membership read — a member with no
 * row, two hashes, or a non-numeric time — plus refused arguments, which
 * the sweep never passes. Anything else is the store: an unreachable
 * ledger, an unconfirmed table mode, or a refused write.
 */
function isHourDataError(cause: unknown): boolean {
	if (cause instanceof InvalidEventError) return true;
	return cause instanceof GreptimeError && cause.message.startsWith("hour member ");
}

async function emitFailed(
	substrate: Pick<Substrate, "hourDigest" | "emit">,
	periodStartIso: string,
	reason: AnchorFailReason,
): Promise<boolean> {
	const note = await substrate.emit({
		surface: "substrate",
		kind: "warning",
		summary: `anchor failed for hour ${periodStartIso.slice(0, 13)}: ${reason}`,
		session_id: anchorSession(periodStartIso),
		payload: { action: "anchor", runtime: "anchor", period_start: periodStartIso, reason },
	});
	return note?.stored === true;
}

/**
 * D28-07 preconditions, in order, run once before the first send of a run.
 * CLI and RPC output quoted anywhere passes through `redact()`.
 */
async function checkPreconditions(deps: AnchorDeps): Promise<void> {
	const { runner, rpc, env } = deps;
	if (!isAbsPath(env.keypairPath)) {
		throw new SystemicError("send-failed", "SOLANA_ANCHOR_KEYPAIR must be an absolute path");
	}
	const keygen = keygenPath(env.cli);
	let shown: string;
	try {
		const pubkey = await runner(pubkeyArgv({ keygen, keypairPath: env.keypairPath }));
		shown = pubkey.stdout.trim();
		if (pubkey.code !== 0 || shown === "") {
			throw new SystemicError(
				"signer-mismatch",
				`solana-keygen pubkey exited ${String(pubkey.code)}: ${redact(pubkey.stderr.slice(0, 200))}`,
			);
		}
	} catch (cause) {
		if (cause instanceof SystemicError) throw cause;
		throw new SystemicError("signer-mismatch", `solana-keygen pubkey failed: ${redact(String(cause).slice(0, 200))}`);
	}
	if (shown !== env.pubkey) {
		throw new SystemicError("signer-mismatch", "solana-keygen pubkey does not equal SOLANA_ANCHOR_PUBKEY");
	}
	let genesis: string;
	try {
		genesis = await rpc.getGenesisHash();
	} catch (cause) {
		throw new SystemicError("rpc-unreadable", `getGenesisHash failed: ${redact(String(cause).slice(0, 200))}`);
	}
	if (genesis !== DEVNET_GENESIS_HASH) {
		throw new SystemicError("wrong-cluster", "RPC genesis hash is not devnet's");
	}
	let balance: number;
	try {
		balance = await rpc.balance(env.pubkey);
	} catch (cause) {
		throw new SystemicError("rpc-unreadable", `getBalance failed: ${redact(String(cause).slice(0, 200))}`);
	}
	if (balance < REQUIRED_BALANCE_LAMPORTS) {
		throw new SystemicError(
			"unfunded",
			`key holds ${balance} lamports, below the rent-exempt minimum plus fees (${REQUIRED_BALANCE_LAMPORTS})`,
		);
	}
}

type AdoptVerdict =
	| { kind: "adopt"; signature: string; slot: number; memo: string; root: string; count: number }
	| { kind: "alarm"; signature: string; slot: number; memo: string; root: string; count: number }
	| { kind: "none" };

/**
 * D28-08 adopt-before-send: the address listing is hint-only; adoption needs
 * the `transactionMemo` confirm (memo program, payer, signature, err null,
 * v1 parse, this period). Same root+count adopts, a different root+count
 * alarms, no memo sends.
 */
async function assertDevnetCluster(rpc: Rpc): Promise<void> {
	let genesis: string;
	try {
		genesis = await rpc.getGenesisHash();
	} catch (cause) {
		throw new SystemicError("rpc-unreadable", `getGenesisHash failed: ${redact(String(cause).slice(0, 200))}`);
	}
	if (genesis !== DEVNET_GENESIS_HASH) {
		throw new SystemicError("wrong-cluster", "RPC genesis hash is not devnet's");
	}
}

async function checkAdopt(deps: AnchorDeps, periodStartMs: number, digest: HourDigest): Promise<AdoptVerdict> {
	const { rpc, env } = deps;
	let listing: AddressMemo[];
	try {
		listing = await rpc.addressMemos(env.pubkey, ADDRESS_MEMO_LIMIT);
	} catch (cause) {
		throw new SystemicError("rpc-unreadable", `getSignaturesForAddress failed: ${redact(String(cause).slice(0, 200))}`);
	}
	for (const hint of listing) {
		const parsed = hint.memo === null ? null : parseMemo(hint.memo);
		if (parsed === null || parsed.periodStartMs !== periodStartMs) continue;
		// Adoption labels the row `devnet`. A matching memo on another cluster
		// must not count: the genesis check on the send path never runs when
		// this hint is adopted.
		await assertDevnetCluster(rpc);
		let confirmed: TransactionMemo | null;
		try {
			confirmed = await rpc.transactionMemo(hint.signature, "confirmed");
		} catch (cause) {
			throw new SystemicError("rpc-unreadable", `getTransaction failed: ${redact(String(cause).slice(0, 200))}`);
		}
		// A listing hint for this hour whose transaction cannot be read is
		// ambiguous: the memo may already anchor this hour (a send followed
		// by a lost row write). Skipping it would send a second transaction,
		// so stop with rpc-unreadable and retry later instead.
		if (confirmed === null) {
			throw new SystemicError("rpc-unreadable", `anchor transaction ${hint.signature} for ${hourIso(periodStartMs)} could not be read`);
		}
		if (confirmed.memo === null) continue;
		if (confirmed.payer !== env.pubkey || !confirmed.payerSigned || confirmed.err !== null) continue;
		const memo = parseMemo(confirmed.memo);
		if (memo === null || memo.periodStartMs !== periodStartMs) continue;
		const slot = confirmed.slot ?? hint.slot ?? 0;
		if (memo.rootHex === digest.root && memo.count === digest.event_count) {
			return { kind: "adopt", signature: hint.signature, slot, memo: confirmed.memo, root: memo.rootHex, count: memo.count };
		}
		return { kind: "alarm", signature: hint.signature, slot, memo: confirmed.memo, root: memo.rootHex, count: memo.count };
	}
	return { kind: "none" };
}

function anchorRow(
	digest: HourDigest,
	txSig: string,
	signer: string,
	slot: number,
	memo: string,
	root: string,
	count: number,
	now: number,
): NewAnchor {
	return {
		period_start: digest.period_start,
		period_end: digest.period_end,
		root,
		event_count: count,
		memo,
		tx_sig: txSig,
		signer,
		cluster: "devnet",
		slot,
		anchored_at: new Date(now).toISOString(),
	};
}

/**
 * Anchor every closed, non-empty, unanchored hour. Returns the process exit
 * code the entry point exits with: 0 when every candidate anchored or was
 * adopted (or nothing needed doing), 1 otherwise.
 */
export async function runAnchorJob(deps: AnchorDeps): Promise<AnchorResult> {
	const now = (deps.clock ?? Date.now)();
	const { greptime, substrate, runner, rpc, env } = deps;
	const result: AnchorResult = { code: 0, anchored: 0, adopted: 0, failed: 0 };

	const failHour = async (periodStartIso: string, reason: AnchorFailReason): Promise<boolean> => {
		// Reports one hour as failed, and whether its `anchor.failed` warning
		// reached the store. A lost warning is itself a store failure: a
		// caller that would continue to the next hour must stop instead,
		// before the next send.
		result.failed += 1;
		result.code = 1;
		try {
			return await emitFailed(substrate, periodStartIso, reason);
		} catch {
			return false;
		}
	};

	let coverageMs: number | null;
	try {
		coverageMs = await greptime.firstIngestMs();
	} catch {
		process.stdout.write("[anchor] store unreachable reading coverage start\n");
		result.code = 1;
		return result;
	}
	if (coverageMs === null) {
		process.stdout.write("[anchor] nothing to anchor\n");
		return result;
	}
	const coverageHour = hourStart(coverageMs);
	const windowStart = Math.max(coverageHour, now - ANCHOR_LOOKBACK_MS);

	let anchored: Record<string, true> = {};
	try {
		const rows = await greptime.anchorsBetween(windowStart, now);
		for (const row of rows) anchored[row.period_start] = true;
	} catch {
		process.stdout.write("[anchor] store unreachable reading anchors\n");
		result.code = 1;
		return result;
	}

	const only = deps.options?.onlyPeriodMs;
	const dryRun = deps.options?.dryRun === true;
	if (only !== undefined) {
		// The sweep window only reaches back seven days: an older `--period`
		// re-run must still see its row, or a memo outside the 100 recent
		// signatures would anchor the hour twice, replacing the original row.
		try {
			const existing = await greptime.anchorForPeriod(only);
			if (existing) anchored[hourIso(only)] = true;
		} catch (cause) {
			await failHour(hourIso(only), "store-failed");
			process.stderr.write(`[anchor] ${hourIso(only)} store-failed: ${redact(String(cause).slice(0, 200))}\n`);
			return result;
		}
	}
	const candidates: number[] = [];
	const peeked = new Map<number, HourDigest>();
	if (only !== undefined) {
		// A re-run for one hour: the dedup skip is bypassed so an anchored
		// hour takes the adopt path below (emitting adopted:true, writing
		// nothing); an unanchored hour anchors normally.
		candidates.push(only);
	} else {
		// Empty hours never receive an anchors row, so they must not consume
		// the per-run budget: peek the digest and only count non-empty hours,
		// or a long empty gap replays every run and starves later hours.
		// Damaged hour data is reported here and skipped, so it does not
		// take a slot either: later healthy hours still fit. A store failure
		// stops the run before any send. Dry-run logs would-fail and
		// likewise spends nothing.
		for (let h = coverageHour; isClosed(h, now, INGEST_LAG_MS); h += HOUR_MS) {
			if (h < windowStart) continue;
			if (anchored[hourIso(h)] === true) continue;
			try {
				const preview = await substrate.hourDigest(h, now);
				if (preview.root === null || preview.event_count === 0 || preview.memo === null) continue;
				peeked.set(h, preview);
			} catch (cause) {
				const periodIso = hourIso(h);
				// A failed store read must not look like a bad hour, and must
				// not fall through into a send: later hours may already be
				// readable, and continuing would anchor them while the store
				// is unavailable.
				if (!isHourDataError(cause)) {
					if (dryRun) {
						process.stdout.write(`[anchor] would fail ${periodIso} (store-failed)\n`);
						result.code = 1;
						result.failed += 1;
						return result;
					}
					await failHour(periodIso, "store-failed");
					process.stderr.write(`[anchor] ${periodIso} store-failed: ${redact(String(cause).slice(0, 200))}\n`);
					return result;
				}
				if (dryRun) {
					process.stdout.write(`[anchor] would fail ${periodIso} (digest-failed)\n`);
					continue;
				}
				const warned = await failHour(periodIso, "digest-failed");
				process.stderr.write(`[anchor] ${periodIso} digest failed: ${redact(String(cause).slice(0, 200))}\n`);
				if (!warned) {
					process.stderr.write(`[anchor] ${periodIso} store-failed: the anchor.failed warning was not stored\n`);
					return result;
				}
				continue;
			}
			candidates.push(h);
			if (candidates.length >= MAX_HOURS_PER_RUN) break;
		}
	}
	if (candidates.length === 0) {
		// Damaged hours already reported above are not "nothing": the run
		// failed them and simply has no send left.
		if (result.failed === 0) process.stdout.write("[anchor] nothing to anchor\n");
		return result;
	}
	if (dryRun) {
		for (const hour of candidates) {
			const periodIso = hourIso(hour);
			try {
				const preview = peeked.get(hour) ?? (await substrate.hourDigest(hour, now));
				if (preview.root === null || preview.event_count === 0) {
					process.stdout.write(`[anchor] would skip ${periodIso} (empty)\n`);
				} else {
					process.stdout.write(`[anchor] would anchor ${periodIso} (${preview.event_count} events)\n`);
				}
			} catch {
				process.stdout.write(`[anchor] would fail ${periodIso} (digest-failed)\n`);
			}
		}
		return result;
	}

	let preconditionsOk = false;
	for (const hour of candidates) {
		const periodIso = hourIso(hour);
		let digest = peeked.get(hour);
		if (!digest) {
			try {
				digest = await substrate.hourDigest(hour, now);
			} catch (cause) {
				// A failed store read must not look like a bad hour: later
				// hours may already hold cached digests, so continuing would
				// send again while the store is unavailable and lose another
				// row. Only bad hour data reports digest-failed and continues —
				// and only when its warning reached the store.
				if (!isHourDataError(cause)) {
					await failHour(periodIso, "store-failed");
					process.stderr.write(`[anchor] ${periodIso} store-failed: ${redact(String(cause).slice(0, 200))}\n`);
					return result;
				}
				const warned = await failHour(periodIso, "digest-failed");
				process.stderr.write(`[anchor] ${periodIso} digest failed: ${redact(String(cause).slice(0, 200))}\n`);
				if (!warned) {
					process.stderr.write(`[anchor] ${periodIso} store-failed: the anchor.failed warning was not stored\n`);
					return result;
				}
				continue;
			}
		}
		if (digest.root === null || digest.event_count === 0 || digest.memo === null) continue;

		let verdict: AdoptVerdict;
		try {
			verdict = await checkAdopt(deps, hour, digest);
		} catch (cause) {
			const reason = cause instanceof SystemicError ? cause.reason : "rpc-unreadable";
			await failHour(periodIso, reason);
			process.stderr.write(`[anchor] ${periodIso} ${reason}: ${redact(String(cause).slice(0, 200))}\n`);
			return result;
		}

		if (verdict.kind === "alarm") {
			// A `--period` re-run over an anchored hour keeps its row: the
			// alarm is reported, never rewritten over the original.
			if (anchored[periodIso] !== true) {
				try {
					await greptime.insertAnchor(anchorRow(digest, verdict.signature, env.pubkey, verdict.slot, verdict.memo, verdict.root, verdict.count, now));
				} catch {
					await failHour(periodIso, "store-failed");
					return result;
				}
			}
		const warned = await failHour(periodIso, "root-mismatch");
		process.stderr.write(`[anchor] ALARM ${periodIso}: chain root ${verdict.root} != recomputed ${digest.root}\n`);
		// The alarm is reported, but a later hour still anchors — unless the
		// warning itself was not stored, which stops the run like the
		// adopted-note path below.
		if (!warned) {
			process.stderr.write(`[anchor] ${periodIso} store-failed: the anchor.failed warning was not stored\n`);
			return result;
		}
		continue;
		}

		if (verdict.kind === "adopt") {
			// A `--period` re-run over an anchored hour: the memo confirms,
			// so the row stays untouched and only the adopted event is emitted.
			if (anchored[periodIso] !== true) {
				try {
					await greptime.insertAnchor(anchorRow(digest, verdict.signature, env.pubkey, verdict.slot, verdict.memo, verdict.root, verdict.count, now));
				} catch {
					await failHour(periodIso, "store-failed");
					return result;
				}
			}
		const note = await emitWritten(substrate, digest, verdict.signature, true).catch(() => null);
		if (!note || note.stored !== true) {
			// The store already failed one write: a later hour must not send
			// a new transaction after that. Report and stop like the send path.
			await failHour(periodIso, "store-failed");
			process.stderr.write(`[anchor] ${periodIso} adopted but the anchor note was not stored\n`);
			return result;
		}
		result.adopted += 1;
		process.stdout.write(`[anchor] ${periodIso} adopted ${verdict.signature}\n`);
		continue;
		}

		// An anchored hour whose memo fell out of the listing window is left
		// alone: sending again would anchor it twice.
		if (anchored[periodIso] === true) {
			process.stdout.write(`[anchor] ${periodIso} already anchored\n`);
			continue;
		}
		// The sweep's anchors window can miss a row that landed after its
		// read, and a send whose row write was lost leaves no row at all:
		// either way the map says absent, and a memo aged out of the
		// 100-signature listing reads as `none`, which would send a second
		// anchor for the same hour. Re-read the durable row before treating
		// the hour as absent — a lost listing never overrides a stored row —
		// and stop fail-closed when the store cannot answer, before any send.
		try {
			const existing = await greptime.anchorForPeriod(hour);
			if (existing) {
				anchored[periodIso] = true;
				process.stdout.write(`[anchor] ${periodIso} already anchored\n`);
				continue;
			}
		} catch (cause) {
			await failHour(periodIso, "store-failed");
			process.stderr.write(`[anchor] ${periodIso} store-failed: ${redact(String(cause).slice(0, 200))}\n`);
			return result;
		}

		if (!preconditionsOk) {
			try {
				await checkPreconditions(deps);
			} catch (cause) {
				const reason = cause instanceof SystemicError ? cause.reason : "send-failed";
				await failHour(periodIso, reason);
				process.stderr.write(`[anchor] ${periodIso} ${reason}: ${redact(String(cause).slice(0, 200))}\n`);
				return result;
			}
			preconditionsOk = true;
		}

		let argv: string[];
		try {
			argv = transferMemoArgv({
				cli: env.cli,
				pubkey: env.pubkey,
				memo: digest.memo,
				rpcUrl: env.rpcUrl,
				keypairPath: env.keypairPath,
				amountSol: AMOUNT_ZERO,
			});
		} catch (cause) {
			await failHour(periodIso, "send-failed");
			process.stderr.write(`[anchor] ${periodIso} send-failed: ${redact(String(cause).slice(0, 200))}\n`);
			return result;
		}
		let sent: RunResult;
		try {
			sent = await runner(argv);
		} catch (cause) {
			await failHour(periodIso, "send-failed");
			process.stderr.write(`[anchor] ${periodIso} send-failed: ${redact(String(cause).slice(0, 200))}\n`);
			return result;
		}
		if (sent.code !== 0) {
			await failHour(periodIso, "send-failed");
			process.stderr.write(`[anchor] ${periodIso} send failed (exit ${String(sent.code)}): ${redact(sent.stderr.slice(0, 200))}\n`);
			return result;
		}
		let signature: string;
		try {
			signature = parseSignature(sent.stdout);
		} catch (cause) {
			await failHour(periodIso, "send-failed");
			process.stderr.write(`[anchor] ${periodIso} send-failed: ${redact(String(cause).slice(0, 200))}\n`);
			return result;
		}

		let readBack: TransactionMemo | null;
		try {
			readBack = await rpc.transactionMemo(signature, "confirmed");
		} catch (cause) {
			await failHour(periodIso, "send-failed");
			process.stderr.write(`[anchor] ${periodIso} read-back failed: ${redact(String(cause).slice(0, 200))}\n`);
			return result;
		}
		const back = readBack?.memo !== null && readBack?.memo !== undefined ? parseMemo(readBack.memo) : null;
		if (
			readBack === null ||
			back === null ||
			back.periodStartMs !== hour ||
			back.rootHex !== digest.root ||
			back.count !== digest.event_count ||
			readBack.payer !== env.pubkey ||
			!readBack.payerSigned ||
			readBack.err !== null
		) {
			await failHour(periodIso, "send-failed");
			process.stderr.write(`[anchor] ${periodIso} read-back does not match the digest\n`);
			return result;
		}

		try {
			await greptime.insertAnchor(
				anchorRow(digest, signature, env.pubkey, readBack.slot ?? 0, digest.memo, digest.root, digest.event_count, now),
			);
		} catch {
			await failHour(periodIso, "store-failed");
			return result;
		}
		// The row is written, so the transaction is never resent: a lost note
		// is reported as store-failed instead, and the next sweep still skips
		// this hour by its row.
		const note = await emitWritten(substrate, digest, signature, false).catch(() => null);
		if (!note || note.stored !== true) {
			await failHour(periodIso, "store-failed");
			process.stderr.write(`[anchor] ${periodIso} anchored but the anchor note was not stored\n`);
			return result;
		}
		result.anchored += 1;
		process.stdout.write(`[anchor] ${periodIso} anchored ${signature}\n`);
	}

	return result;
}
