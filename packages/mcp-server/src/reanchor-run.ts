#!/usr/bin/env bun
/**
 * The guarded RE-ANCHOR entry point (v1.6, phase 59, criterion 5; `anchor-run.ts` and `reanchor-plan-run.ts` precedent).
 *
 *   bun packages/mcp-server/src/reanchor-run.ts --plan FILE                       # DRY RUN (the default)
 *   bun packages/mcp-server/src/reanchor-run.ts --plan FILE --execute --confirm-genesis HASH [--max-hours N] [--surface NAME]
 *
 * After a devnet reset the anchor job cannot re-send an hour that already has an `anchors` row. This entry executes a plan saved by
 * `reanchor-plan-run.ts --json`: it recomputes each planned hour from the ledger, refuses unless it is byte for byte the stored row,
 * sends the stored memo again onto the new cluster, and records an `anchor.reanchor` note that `checkpoint_verify` follows (the
 * `anchors` row is never rewritten). The gates and the rules are in `reanchor.ts`.
 *
 * It is the ONLY module that constructs the real executor (`execFileRunner`). Nothing else imports it: no test, no CI job, no
 * workflow, no package script, no systemd unit. The default mode opens nothing at all (no config, no ledger, no endpoint, no
 * runner). `--execute` is OPERATOR ONLY and is run by hand from the runbook (`docs/runbooks/devnet-reset-and-reanchor.md`, step e).
 * `--execute` holds a lock file (`substrate-reanchor-<signer>.lock` in `SUBSTRATE_STATE_DIR`, else the temp directory) across discovery, send and recording, and touches only the
 * ledger: its `Substrate` has an in-memory retain outbox, so it never opens the live server's `SUBSTRATE_RETAIN_OUTBOX_PATH` file or
 * starts a drain timer. A plan with no hour (the planner read no chain, so no observed genesis) is done at once, exit 0.
 *
 * Exit codes: 0 dry run printed, or every hour done; 1 a gate refused or a send or record failed (stderr starts with
 * `[reanchor] REFUSED <code>`; nothing further was sent); 2 usage, an unreadable or invalid plan, or missing configuration (a bad
 * flag, an unset `GREPTIME_URL`, an unset `SOLANA_ANCHOR_KEYPAIR` or `SOLANA_ANCHOR_PUBKEY`, a `SOLANA_RPC_URL` the devnet guard
 * refuses). No new environment variable: the names `loadConfig` already reads.
 */
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createRpc, execFileRunner, RpcError, type Rpc } from "@substrate/ledger";
import { loadConfig, operatorSurfaces, type GreptimeConfig, type SubstrateConfig } from "./config.ts";
import { readReanchorNotes, resolveSignerSet } from "./anchor-verify-deps.ts";
import { GreptimeClient } from "./greptime.ts";
import {
	dryRunReanchor,
	executeReanchor,
	parseReanchorRunArgs,
	parseSavedPlan,
	REANCHOR_RUN_USAGE,
	ReanchorPlanError,
	ReanchorRunUsageError,
	reasonOf,
	type LockAttempt,
	type ReanchorDeps,
	type ReanchorLock,
	type ReanchorOptions,
	type SavedPlan,
} from "./reanchor.ts";
import { rowToEvent, Substrate } from "./service.ts";
import type { Surface } from "./types.ts";

/** Devnet reads and the send's read-back: one slow call each, three tries, room to breathe between (the anchor job's figures). */
const RPC_TIMEOUT_MS = 15_000;
const RPC_ATTEMPTS = 3;
const RPC_BACKOFF_MS = 2_000;

export interface ReanchorCliResult {
	code: 0 | 1 | 2;
	stdout: string;
	stderr: string;
}

export interface ReanchorCliDeps {
	/** The saved plan's text; throws when the file cannot be read. */
	readPlan(path: string): string;
	/** The real ports for `--execute`; never called in the default dry run. */
	open(options: ReanchorOptions): Promise<ReanchorDeps | { refused: string }>;
}

const usageFailure = (message: string): ReanchorCliResult => ({ code: 2, stdout: "", stderr: `${message}\n${REANCHOR_RUN_USAGE}` });

/** The whole run behind the process boundary: pure over its two deps, so a test drives it with fakes and no process. */
export async function runReanchorCli(argv: readonly string[], deps: ReanchorCliDeps): Promise<ReanchorCliResult> {
	let options: ReanchorOptions;
	try {
		options = parseReanchorRunArgs(argv);
	} catch (cause) {
		if (cause instanceof ReanchorRunUsageError) return usageFailure(cause.message);
		throw cause;
	}
	let plan: SavedPlan;
	try {
		plan = parseSavedPlan(deps.readPlan(options.planPath));
	} catch (cause) {
		return usageFailure(cause instanceof ReanchorPlanError ? cause.message : `the plan file cannot be read: ${reasonOf(cause)}`);
	}
	if (!options.execute) {
		const dry = dryRunReanchor(plan, options);
		return { code: 0, stdout: dry.stdout, stderr: dry.stderr };
	}
	if (options.confirmGenesis === null) return usageFailure("--execute needs --confirm-genesis <hash>");
	if (plan.hours.length === 0) return { code: 0, stdout: "[reanchor] the plan has no hour to re-anchor\n", stderr: "" };
	const opened = await deps.open(options);
	if ("refused" in opened) return usageFailure(opened.refused);
	const result = await executeReanchor(plan, options, opened);
	return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

export interface OpenOptions {
	/** The environment to read; `process.env` by default. */
	env?: Record<string, string | undefined>;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	/** The ledger client for a configured store; the real one by default. */
	ledgerFor?: (config: GreptimeConfig) => GreptimeClient;
	/** The substrate for a configured store; the real one by default (a test seam: the real one starts the server's planes). */
	substrateFor?: (config: SubstrateConfig, greptime: GreptimeClient) => ReanchorDeps["substrate"];
}

/** An unreadable lock file (garbage, a half-written file) older than this is broken; a lock with a live pid never is. */
export const LOCK_STALE_MS = 30 * 60_000;

export interface LockFileOptions {
	pid?: number;
	now?: () => number;
	/** Whether the process of a pid is alive; the real one signals it with signal 0. */
	alive?: (pid: number) => boolean;
}

function errorCode(cause: unknown): unknown {
	return typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		// No permission to signal means the process exists.
		return errorCode(cause) === "EPERM";
	}
}

/** The lock file as read: its raw text (to compare before breaking it), the holder's pid when it parses, and when it started. */
function readHolder(path: string): { raw: string; pid: number | null; startedMs: number } | null {
	let raw: string;
	let mtimeMs: number;
	try {
		raw = readFileSync(path, "utf8");
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		// The file vanished between the failed create and this read.
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && "pid" in parsed && "started_ms" in parsed) {
			const { pid, started_ms: startedMs } = parsed;
			if (typeof pid === "number" && Number.isSafeInteger(pid) && typeof startedMs === "number" && Number.isFinite(startedMs)) return { raw, pid, startedMs };
		}
	} catch {
		// A file another run is still writing, or garbage: judged by its age alone.
	}
	return { raw, pid: null, startedMs: mtimeMs };
}

/**
 * The lock file of a signer's re-anchor runs: `substrate-reanchor-<first 12 characters of the signer's public key>.lock` in
 * `SUBSTRATE_STATE_DIR` when that is set and absolute, else in the OS temp directory. Keyed by the signer and not by the plan file, so
 * two copies of a plan in different directories (or two plans) share one lock.
 */
export function reanchorLockPath(env: Record<string, string | undefined>, pubkey: string): string {
	const configured = env["SUBSTRATE_STATE_DIR"]?.trim() ?? "";
	const stateDir = configured !== "" && isAbsolute(configured) ? configured : tmpdir();
	return join(stateDir, `substrate-reanchor-${pubkey.slice(0, 12)}.lock`);
}

/**
 * The real lock of a run: `path` created exclusively (`wx`) with the holder's pid and start time, held across discovery, send and
 * recording. An existing file is broken ONLY when its recorded pid is not alive on this host, or when it cannot be read (not a lock
 * this code wrote: garbage or a half-written file) and is older than {@link LOCK_STALE_MS}. A live pid is never broken, however old
 * the lock: a degraded run (a 120 s send timeout, read-back retries, several hours) can outlast any fixed age, and breaking its lock
 * would let a second run send the same hours. The price is pid reuse: a dead run's pid that the OS handed to an unrelated live process
 * keeps the lock held until the operator removes the file (named in the `held` message), which is the safe direction. The release
 * removes the file only while it still holds this run's own text, so a lock taken over after a break is never removed by the old
 * holder. A second run finding a live lock gets `held`, never waits.
 *
 * Accepted race: two runs that both find the same dead lock can interleave so that one removes the fresh lock the other has just
 * created in the instant between the other's compare and its unlink, and both then hold a lock. That window is a few microseconds
 * wide and needs two operators starting a re-anchor at the same moment; for a hand-run CLI it is accepted and no machinery guards it.
 */
export function fileLock(path: string, options: LockFileOptions = {}): ReanchorLock {
	const pid = options.pid ?? process.pid;
	const now = options.now ?? Date.now;
	const alive = options.alive ?? processAlive;
	return {
		acquire(): LockAttempt {
			for (let attempt = 0; attempt < 3; attempt++) {
				const mine = JSON.stringify({ pid, started_ms: now() });
				try {
					writeFileSync(path, mine, { flag: "wx", mode: 0o600 });
					return {
						release: () => {
							try {
								if (readFileSync(path, "utf8") === mine) unlinkSync(path);
							} catch {
								// Already gone: nothing to release.
							}
						},
					};
				} catch (cause) {
					if (errorCode(cause) !== "EEXIST") return { held: `the lock file ${path} could not be created: ${reasonOf(cause)}` };
				}
				const holder = readHolder(path);
				if (holder === null) continue;
				// A live pid is never stale (see above); an unreadable lock has no pid and is judged by its age.
				const stale = holder.pid !== null ? !alive(holder.pid) : now() - holder.startedMs > LOCK_STALE_MS;
				if (!stale) {
					const by = holder.pid === null ? "another run" : `pid ${holder.pid}`;
					return { held: `${by} holds ${path} since ${new Date(holder.startedMs).toISOString()} (remove the file only after confirming no re-anchor run is alive)` };
				}
				// Break it only while it is still the very file judged stale.
				try {
					if (readFileSync(path, "utf8") === holder.raw) unlinkSync(path);
				} catch {
					// Taken or removed by another run meanwhile: the next create decides.
				}
			}
			return { held: `the lock file ${path} is contended` };
		},
	};
}

/**
 * Build the real ports from the server's environment. The devnet guard runs first: a refused `SOLANA_RPC_URL` returns
 * `{ refused }` before a ledger client exists and before any request is made. The keypair is only ever a path on a CLI argv.
 */
export function openRealContext(options: ReanchorOptions, open: OpenOptions = {}): ReanchorDeps | { refused: string } {
	let config: SubstrateConfig;
	try {
		config = loadConfig(open.env ?? process.env);
	} catch (cause) {
		return { refused: `the configuration is not valid: ${reasonOf(cause)}` };
	}
	if (!config.greptime) return { refused: "GREPTIME_URL is not set" };
	if (config.solana.problem) return { refused: config.solana.problem };
	const { rpcUrl, keypairPath, pubkey, cli } = config.solana;
	if (!keypairPath || !pubkey) return { refused: "SOLANA_ANCHOR_KEYPAIR and SOLANA_ANCHOR_PUBKEY must be set" };
	let rpc: Rpc;
	try {
		rpc = createRpc({
			url: rpcUrl,
			timeoutMs: RPC_TIMEOUT_MS,
			attempts: RPC_ATTEMPTS,
			backoffMs: RPC_BACKOFF_MS,
			...(open.fetchImpl !== undefined ? { fetchImpl: open.fetchImpl } : {}),
			...(open.sleep !== undefined ? { sleep: open.sleep } : {}),
		});
	} catch (cause) {
		if (cause instanceof RpcError) return { refused: `SOLANA_RPC_URL refused: ${reasonOf(cause)}` };
		throw cause;
	}
	const greptime = open.ledgerFor !== undefined ? open.ledgerFor(config.greptime) : new GreptimeClient(config.greptime);
	// The server's retain outbox file (SUBSTRATE_RETAIN_OUTBOX_PATH) belongs to the running server: constructing a Substrate with it would
	// hydrate and rewrite that file and start a second drain timer. This process needs only the ledger, so the outbox is memory-only (and,
	// never fed, empty and timer-less), and the Postgres index and the event bus the re-anchor never uses are not built either.
	const isolated: SubstrateConfig = { ...config, retainOutbox: { ...config.retainOutbox, path: null } };
	const substrate = open.substrateFor !== undefined ? open.substrateFor(isolated, greptime) : new Substrate(isolated, { greptime, index: null, eventBus: () => null });
	const operators = operatorSurfaces(config);
	// An explicit --surface is judged by the executor against the operator set; with none, a single operator surface is the answer.
	const sole = operators.size === 1 ? ([...operators][0] as Surface) : null;
	const surface = options.surface !== null ? (options.surface as Surface) : sole;
	return {
		ledger: greptime,
		rpc,
		runner: execFileRunner,
		substrate,
		env: { rpcUrl, keypairPath, pubkey, cli },
		surface,
		operatorSurfaces: operators,
		// The same trusted-surface read the verifier uses, bound to the hour's stored row.
		notes: (hour) =>
			readReanchorNotes({ ledger: greptime, rowToEvent, operatorSurfaces: operators }, hour.period_start_ms, {
				root: hour.root,
				event_count: hour.event_count,
				tx_sig: hour.previous_tx_sig,
			}),
		// The same effective signer set `checkpoint_verify` judges against, read from the same ports as the notes.
		signers: () =>
			resolveSignerSet({
				ledger: greptime,
				rowToEvent,
				rpc: () => rpc,
				solana: { pubkey, problem: null, signerSet: config.solana.signerSet, signerSetProblem: config.solana.signerSetProblem },
				operatorSurfaces: operators,
				nowMs: () => Date.now(),
			}),
		// One lock per signer, in one directory per host, not beside the plan file: a copy of the plan elsewhere must not be a second lock.
		lock: fileLock(reanchorLockPath(open.env ?? process.env, pubkey)),
	};
}

if (import.meta.main) {
	const result = await runReanchorCli(process.argv.slice(2), {
		readPlan: (path) => readFileSync(path, "utf8"),
		open: async (options) => openRealContext(options),
	});
	if (result.stdout.length > 0) process.stdout.write(result.stdout);
	if (result.stderr.length > 0) process.stderr.write(result.stderr);
	process.exit(result.code);
}
