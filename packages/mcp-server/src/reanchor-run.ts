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
 *
 * Exit codes: 0 dry run printed, or every hour done; 1 a gate refused or a send or record failed (stderr starts with
 * `[reanchor] REFUSED <code>`; nothing further was sent); 2 usage, an unreadable or invalid plan, or missing configuration (a bad
 * flag, an unset `GREPTIME_URL`, an unset `SOLANA_ANCHOR_KEYPAIR` or `SOLANA_ANCHOR_PUBKEY`, a `SOLANA_RPC_URL` the devnet guard
 * refuses). No new environment variable: the names `loadConfig` already reads.
 */
import { readFileSync } from "node:fs";
import { createRpc, execFileRunner, RpcError, type Rpc } from "@substrate/ledger";
import { loadConfig, operatorSurfaces, type GreptimeConfig, type SubstrateConfig } from "./config.ts";
import { readReanchorRecords } from "./anchor-verify-deps.ts";
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
	type ReanchorDeps,
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
	const substrate = open.substrateFor !== undefined ? open.substrateFor(config, greptime) : new Substrate(config, { greptime });
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
		recorded: async (periodStartIso, newTxSig) =>
			(await readReanchorRecords({ ledger: greptime, rowToEvent, operatorSurfaces: operators }, Date.parse(periodStartIso))).some((record) => record.payload.new_tx_sig === newTxSig),
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
