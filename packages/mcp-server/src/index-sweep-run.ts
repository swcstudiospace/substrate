#!/usr/bin/env bun
/**
 * One-shot daily index sweep entry point (`anchor-run.ts` precedent).
 *
 *   bun packages/mcp-server/src/index-sweep-run.ts [--apply | --dry-run] [--json]
 *
 * The mode comes from `SUBSTRATE_INDEX_SWEEP` (`dry-run` by default, `apply`,
 * `off`); `--apply` is refused unless the env says `apply` too, and `--dry-run`
 * always wins. `off` exits 0 and touches nothing. Otherwise the job runs
 * `IndexStore.sweep`, prints the report (text, or the object with `--json`) and
 * emits exactly one ledger event on surface `substrate` through the same
 * `Substrate.emit` path the anchor job uses — a `note` carrying the counts, or a
 * `warning` when the sweep itself failed. Counts only: no ids, no bodies.
 *
 * `SUBSTRATE_MEMORY_EXPIRY` (uplift-3 N4) reaches the sweep through `loadConfig`:
 * under `enforce` the two `entries-ttl-*` classes delete on `apply`; under the
 * default `report` they only count, whatever the sweep mode.
 *
 * Exit codes: 0 when the sweep ran (or was off), 1 when it failed, 2 on usage —
 * a refused `--apply`, an unknown flag, or no `SUBSTRATE_PG_URL`.
 */
import { loadConfig } from "./config.ts";
import { GreptimeClient } from "./greptime.ts";
import { IndexStore } from "./index-store.ts";
import {
	SWEEP_MODE_ENV,
	formatMemoryLifecycleReport,
	formatSweepReport,
	memoryLifecycleReport,
	resolveSweepMode,
	sweepCounts,
	sweepPolicyFromEnv,
	type SweepReport,
} from "./index-sweep.ts";
import { hindsightFromEnv } from "./planes/hindsight.ts";
import { redact } from "./redact.ts";
import { Substrate } from "./service.ts";

const USAGE =
	"usage: index-sweep-run.ts [--apply | --dry-run] [--json]\n" +
	`  ${SWEEP_MODE_ENV}=dry-run|apply|off picks the mode (default dry-run); --apply also needs it set to apply.\n`;

function exitUsage(message: string): never {
	process.stderr.write(`${message}\n${USAGE}`);
	process.exit(2);
}

const flags = { apply: false, dryRun: false, json: false };
for (const arg of process.argv.slice(2)) {
	if (arg === "--apply") flags.apply = true;
	else if (arg === "--dry-run") flags.dryRun = true;
	else if (arg === "--json") flags.json = true;
	else exitUsage(`unknown argument ${arg}`);
}
if (flags.apply && flags.dryRun) exitUsage("--apply and --dry-run exclude each other");

const resolved = resolveSweepMode({ env: process.env, apply: flags.apply, dryRun: flags.dryRun });
if (resolved.refused !== undefined) exitUsage(resolved.refused);
const mode = resolved.mode;
if (mode === "off") {
	process.stdout.write(`[index-sweep] off (${SWEEP_MODE_ENV}=off); nothing to do\n`);
	process.exit(0);
}

const config = loadConfig();
if (!config.postgresUrl) exitUsage("SUBSTRATE_PG_URL is not set");

const index = new IndexStore(config.postgresUrl);
const greptime = config.greptime ? new GreptimeClient(config.greptime) : null;
// A job process never opens the server's telemetry buffer file: the server owns it (see reanchor-run.ts).
const substrate = new Substrate({ ...config, eventBuffer: null }, { index, greptime });
const policy = sweepPolicyFromEnv(process.env);
const now = Date.now();
const session = `index-sweep:${new Date(now).toISOString().slice(0, 10)}`;

let lifecycleRaw: Array<Record<string, unknown>> | null = null;
let lifecycleError: string | null = null;
if (config.memoryLifecycle === "report") {
	// Before any delete. An apply under expiry enforce removes the rows this report exists to name.
	try {
		lifecycleRaw = await index.memoryLifecycleCandidates({ now, policy });
	} catch (cause) {
		lifecycleError = redact(String(cause instanceof Error ? cause.message : cause)).slice(0, 200);
	}
}

let report: SweepReport | null = null;
let failure: string | null = null;
try {
	report = await index.sweep({ apply: mode === "apply", now, policy, expiry: config.memoryExpiry });
} catch (cause) {
	failure = redact(String(cause instanceof Error ? cause.message : cause)).slice(0, 200);
}

if (report) {
	const hindsight = hindsightFromEnv();
	const view = { batch: policy.batch, hindsight };
	const lifecycle = lifecycleRaw === null ? null : memoryLifecycleReport(lifecycleRaw, view);
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(lifecycle === null ? report : { ...report, lifecycle })}\n`);
	} else {
		process.stdout.write(formatSweepReport(report));
		if (lifecycleRaw !== null) process.stdout.write(formatMemoryLifecycleReport(lifecycleRaw, view));
	}
	if (lifecycleError !== null) process.stderr.write(`[index-sweep] lifecycle report failed: ${lifecycleError}\n`);
	const candidates = report.classes.reduce((sum, cls) => sum + cls.candidates, 0);
	const deleted = report.classes.reduce((sum, cls) => sum + cls.deleted, 0);
	const note = await substrate.emit({
		surface: "substrate",
		kind: "note",
		summary: `index sweep (${mode}): ${candidates} candidates, ${deleted} deleted`,
		session_id: session,
		payload: {
			action: "index.sweep",
			runtime: "index-sweep",
			mode,
			memory_expiry: report.expiry,
			batch: report.batch,
			classes: sweepCounts(report),
		},
	});
	if (!note.stored) process.stderr.write(`[index-sweep] report not stored in the ledger: ${note.error ?? "unknown"}\n`);
} else {
	process.stderr.write(`[index-sweep] ${mode} failed: ${failure}\n`);
	await substrate.emit({
		surface: "substrate",
		kind: "warning",
		summary: `index sweep (${mode}) failed: ${failure}`,
		session_id: session,
		payload: { action: "index.sweep", runtime: "index-sweep", mode, reason: failure },
	});
}

await index.close().catch(() => undefined);
process.exit(report ? 0 : 1);
