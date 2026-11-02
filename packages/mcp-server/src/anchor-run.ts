#!/usr/bin/env bun
/**
 * One-shot hourly anchor job entry point (`backfill-run.ts` precedent).
 *
 *   bun packages/mcp-server/src/anchor-run.ts [--period <hour>] [--dry-run]
 *
 * Builds the job's ports from `loadConfig()` and the `SOLANA_*` env and exits
 * with the job's code: 0 when every candidate anchored or was adopted (or
 * there was nothing to do), 1 otherwise. Missing config exits 2 with usage
 * and sends nothing — the keypair is only ever a path on a CLI argv. A
 * `SOLANA_RPC_URL` the devnet guard refuses exits 2 the same way.
 */
import { createRpc, execFileRunner, isClosed } from "@substrate/ledger";
import { ANCHOR_USAGE, UsageError, parseAnchorArgs, runAnchorJob } from "./anchor.ts";
import type { AnchorCliOptions } from "./anchor.ts";
import { loadConfig } from "./config.ts";
import { GreptimeClient, INGEST_LAG_MS } from "./greptime.ts";
import { Substrate } from "./service.ts";

/** Devnet reads: one slow call each, three tries, room to breathe between. */
const RPC_TIMEOUT_MS = 15_000;
const RPC_ATTEMPTS = 3;
const RPC_BACKOFF_MS = 2_000;

function exitUsage(message: string): never {
	process.stderr.write(`${message}\n${ANCHOR_USAGE}`);
	process.exit(2);
}

let flags: AnchorCliOptions;
try {
	flags = parseAnchorArgs(process.argv.slice(2));
} catch (cause) {
	exitUsage(cause instanceof UsageError ? cause.message : String(cause));
}

const config = loadConfig();
if (!config.greptime) exitUsage("GREPTIME_URL is not set");
// Before any CLI or request: a refused URL (mainnet/testnet host, userinfo, non-http scheme) never anchors.
if (config.solana.problem) exitUsage(config.solana.problem);
const { rpcUrl, keypairPath, pubkey, cli } = config.solana;
if (!keypairPath || !pubkey) exitUsage("SOLANA_ANCHOR_KEYPAIR and SOLANA_ANCHOR_PUBKEY must be set");
if (flags.onlyPeriodMs !== undefined && !isClosed(flags.onlyPeriodMs, Date.now(), INGEST_LAG_MS)) {
	exitUsage("that hour is not closed yet");
}

const greptime = new GreptimeClient(config.greptime);
// A job process never opens the server's telemetry buffer file: the server owns it (see reanchor-run.ts).
const substrate = new Substrate({ ...config, eventBuffer: null }, { greptime });
const rpc = createRpc({ url: rpcUrl, timeoutMs: RPC_TIMEOUT_MS, attempts: RPC_ATTEMPTS, backoffMs: RPC_BACKOFF_MS });

const result = await runAnchorJob({
	greptime,
	substrate,
	runner: execFileRunner,
	rpc,
	env: { rpcUrl, keypairPath, pubkey, cli },
	options: flags,
});
process.exit(result.code);
