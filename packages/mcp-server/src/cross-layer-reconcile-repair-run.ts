#!/usr/bin/env bun
/**
 * The operator's repair path for the cross-layer reconcile (phase 78). `substrate reconcile` spawns it.
 *
 *   bun packages/mcp-server/src/cross-layer-reconcile-repair-run.ts [--plan]
 *   bun packages/mcp-server/src/cross-layer-reconcile-repair-run.ts --apply PLAN_ID --confirm
 *
 * `--plan` (the default) reads the ledger window, the index and the cache as the scheduled tick does, prints what it found,
 * and prints the repairs it calls for. `planRepair` records them as ONE `reconcile.plan` note whose event id is the plan id;
 * nothing is repaired. `--apply PLAN_ID --confirm` applies a printed plan, and only when a fresh read of the layers yields the
 * digest the stored plan recorded. Otherwise it refuses and marks nothing. The marks, the cache invalidation and the
 * `reconcile.applied` note are `applyRepair`'s.
 *
 * Lives in this package, like `cross-layer-reconcile-run.ts`: the store clients and their credentials are read here and
 * nowhere else (the store lock). The CLI package spawns this file.
 *
 * Exit codes: 0 nothing to repair, or applied; 1 failed: a layer could not be read, the read was incomplete, the plan id is
 * not a reconcile plan, the plan no longer matches a fresh read, or the apply's own record or cache mark was not confirmed;
 * 2 usage or missing configuration; 3 a plan was printed (the layers disagree).
 */
import { createReadThroughCache } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { isRecord } from "./corpus/validate.ts";
import { EXIT, reconcileOptionsFor, renderReport } from "./cross-layer-reconcile-run.ts";
import {
	type ApplyRun,
	type LedgerNote,
	type PlanRun,
	RECONCILE_PLAN_ACTION,
	type ReconcileDeps,
	type ReconcileOptions,
	type RepairItem,
	applyRepair,
	ledgerFromSubstrate,
	planRepair,
	previewRepair,
} from "./cross-layer-reconcile.ts";
import { GreptimeClient } from "./greptime.ts";
import { IndexStore } from "./index-store.ts";
import { redact } from "./redact.ts";
import { Substrate } from "./service.ts";

const USAGE = "usage: cross-layer-reconcile-repair-run.ts [--plan] | --apply PLAN_ID --confirm\n";

export type RepairArgs = { mode: "plan" } | { mode: "apply"; planId: string } | { mode: "refused"; problem: string };

/** `--plan`, or nothing, or `--apply PLAN_ID --confirm` in that order. Anything else is refused before a store is opened. */
export function parseRepairArgs(argv: readonly string[]): RepairArgs {
	if (argv.length === 0 || (argv.length === 1 && argv[0] === "--plan")) return { mode: "plan" };
	const [flag, planId, confirm, ...extra] = argv;
	if (flag !== "--apply" || extra.length > 0) return { mode: "refused", problem: "unknown arguments" };
	if (planId === undefined || planId.startsWith("--")) return { mode: "refused", problem: "--apply needs the PLAN_ID that a --plan run printed" };
	if (confirm !== "--confirm") return { mode: "refused", problem: "--apply writes repairs and needs --confirm after the plan id" };
	return { mode: "apply", planId };
}

/** The digest a stored plan note carries over its items, or null when the note is not a reconcile plan. */
export function storedPlanDigest(note: LedgerNote | null): string | null {
	if (note === null || note.kind !== "note" || note.payload === null || note.payload.action !== RECONCILE_PLAN_ACTION) return null;
	const plan = note.payload.plan;
	return isRecord(plan) && typeof plan.itemsSha256 === "string" ? plan.itemsSha256 : null;
}

function describe(item: RepairItem): string {
	return item.action === "index-mark" ? `  index-mark ${item.entryId} (forget ${item.forgetId})` : `  cache-mark ${item.key} (ttl ${item.ttlS}s)`;
}

const REFUSED: Record<"incomplete-coverage" | "too-many-items", string> = {
	"incomplete-coverage": "the read is incomplete, so nothing is planned from it",
	"too-many-items": "the repairs exceed one plan's size, so nothing is planned",
};

async function runPlan(deps: ReconcileDeps, options: ReconcileOptions): Promise<number> {
	const run: PlanRun = await planRepair(deps, options);
	if (!run.ok) {
		process.stderr.write(`[cross-layer-reconcile] plan failed (${run.reason}): ${run.detail}\n`);
		return EXIT.failed;
	}
	process.stdout.write(renderReport(run.report));
	if (run.refused !== null) {
		process.stderr.write(`[cross-layer-reconcile] no plan: ${REFUSED[run.refused]}; nothing was repaired\n`);
		return EXIT.failed;
	}
	if (run.planId === null) {
		process.stdout.write("nothing to repair: the layers agree\n");
		return EXIT.clean;
	}
	process.stdout.write(`plan ${run.planId}: ${run.items.length} repair(s) recorded as a reconcile.plan note; nothing repaired yet\n`);
	for (const item of run.items) process.stdout.write(`${describe(item)}\n`);
	process.stdout.write(`apply with: substrate reconcile --apply ${run.planId} --confirm\n`);
	return EXIT.mismatch;
}

async function runApply(deps: ReconcileDeps, options: ReconcileOptions, planId: string): Promise<number> {
	const planned = storedPlanDigest(await deps.ledger.readEvent(planId));
	if (planned === null) {
		process.stderr.write(`[cross-layer-reconcile] no reconcile plan has id ${planId}; nothing was applied\n`);
		return EXIT.failed;
	}
	// The fresh read writes nothing. Its digest must be the one the stored plan recorded, or the plan is stale.
	const fresh = await previewRepair(deps, options);
	if (!fresh.ok) {
		process.stderr.write(`[cross-layer-reconcile] fresh read failed (${fresh.reason}): ${fresh.detail}; nothing was applied\n`);
		return EXIT.failed;
	}
	process.stdout.write(renderReport(fresh.report));
	if (!fresh.report.coverage.complete) {
		process.stderr.write("[cross-layer-reconcile] the fresh read is incomplete, so the plan cannot be confirmed; nothing was applied\n");
		return EXIT.failed;
	}
	if (fresh.itemsSha256 !== planned) {
		process.stderr.write(`[cross-layer-reconcile] plan ${planId} no longer matches a fresh read of the layers; nothing was applied. Plan again with \`substrate reconcile\`.\n`);
		return EXIT.failed;
	}
	const run: ApplyRun = await applyRepair(deps, { planId, confirm: planId });
	if (!run.ok) {
		process.stderr.write(`[cross-layer-reconcile] apply failed (${run.reason}): ${run.detail}\n`);
		return EXIT.failed;
	}
	process.stdout.write(`applied plan ${run.planId}: ${run.marked.length} marked, ${run.skipped.length} skipped, cache ${run.cache}\n`);
	for (const id of run.marked) process.stdout.write(`  marked ${id}\n`);
	for (const skip of run.skipped) process.stdout.write(`  skipped ${skip.entryId} (${skip.reason})\n`);
	if (!run.recorded) {
		process.stderr.write(`[cross-layer-reconcile] the reconcile.applied note was not stored${run.recordError === null ? "" : `: ${run.recordError}`}; the repairs above stay made\n`);
		return EXIT.failed;
	}
	if (run.cache === "unverified") {
		process.stderr.write("[cross-layer-reconcile] the cache forget mark was not verified after apply; apply the same plan again to retry it\n");
		return EXIT.failed;
	}
	return EXIT.clean;
}

async function main(argv: string[]): Promise<number> {
	const parsed = parseRepairArgs(argv);
	if (parsed.mode === "refused") {
		process.stderr.write(`${parsed.problem}\n${USAGE}`);
		return EXIT.usage;
	}
	const config = loadConfig();
	if (!config.greptime) {
		process.stderr.write(`GREPTIME_URL is not set\n${USAGE}`);
		return EXIT.usage;
	}
	if (!config.postgresUrl) {
		process.stderr.write(`SUBSTRATE_PG_URL is not set\n${USAGE}`);
		return EXIT.usage;
	}
	const greptime = new GreptimeClient(config.greptime, { ledger: config.ledger });
	const index = new IndexStore(config.postgresUrl);
	// The cache the scheduled tick reads. Its generations and forget mark are what `applyRepair` invalidates.
	const cache = createReadThroughCache(config);
	// The plan record is a write: it goes through the substrate's own redacting, hash-chained path, as the ledger archive note does.
	const substrate = new Substrate(config, { greptime });
	try {
		const deps: ReconcileDeps = { ledger: ledgerFromSubstrate("substrate", greptime, substrate), index, cache, now: () => Date.now() };
		const options = reconcileOptionsFor(config);
		return parsed.mode === "plan" ? await runPlan(deps, options) : await runApply(deps, options, parsed.planId);
	} catch (cause) {
		process.stderr.write(`[cross-layer-reconcile] failed: ${redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 300)}\n`);
		return EXIT.failed;
	} finally {
		await index.close().catch(() => undefined);
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
