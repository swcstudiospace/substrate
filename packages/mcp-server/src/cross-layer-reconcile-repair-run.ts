#!/usr/bin/env bun
/**
 * The operator's repair path for the cross-layer reconcile (phase 78). `substrate reconcile` spawns it.
 *
 *   bun packages/mcp-server/src/cross-layer-reconcile-repair-run.ts [--plan]
 *   bun packages/mcp-server/src/cross-layer-reconcile-repair-run.ts --apply PLAN_ID --confirm
 *
 * `--plan` (the default) reads the ledger window, the index and the cache as the scheduled tick does, prints what it found,
 * and prints the repairs it calls for. `planRepair` records them as ONE `reconcile.plan` note whose event id is the plan id;
 * nothing is repaired. `--apply PLAN_ID --confirm` applies a printed plan. A fresh read of the layers must hold only repairs the
 * plan holds (a repair an earlier, partial apply made is not in it, and that is fine); a new or altered repair refuses and marks
 * nothing. The marks, the cache invalidation and the `reconcile.applied` note are `applyRepair`'s.
 *
 * Lives in this package, like `cross-layer-reconcile-run.ts`: the store clients and their credentials are read here and
 * nowhere else (the store lock). The CLI package spawns this file. It opens no `Substrate`: one would load and drain the live
 * event buffer and retain outbox beside the running server, so the note writes are direct ledger appends (`directNoteWriter`).
 *
 * Exit codes: 0 nothing to repair, or applied; 1 failed: a layer could not be read, the read was incomplete, the plan id is
 * not a reconcile plan, the plan no longer matches a fresh read, or the apply's own record or cache mark was not confirmed;
 * 2 usage or missing configuration; 3 the layers disagree: a plan was printed, or only report-only findings were read and nothing is planned for them.
 */
import { createReadThroughCache } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { EXIT, reconcileOptionsFor, renderReport } from "./cross-layer-reconcile-run.ts";
import {
	type ApplyRun,
	type Mismatch,
	type NoteWriter,
	type PlanRun,
	type ReconcileDeps,
	type ReconcileOptions,
	type RepairItem,
	applyRepair,
	freshItemsWithinPlan,
	ledgerFromSubstrate,
	planRepair,
	previewRepair,
	storedPlanItems,
} from "./cross-layer-reconcile.ts";
import { normalizeEvent } from "./event.ts";
import { GreptimeClient, IngestNotRecorded } from "./greptime.ts";
import { IndexStore } from "./index-store.ts";
import { redact } from "./redact.ts";

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

/**
 * The ledger write for the repair run's notes (`reconcile.plan`, `reconcile.applied`), without a `Substrate`. A `Substrate` loads the
 * live event buffer and retain outbox from disk and starts their drain timers, and this process runs beside the server: two writers
 * over those files would erase or double-deliver what the server has parked. So the note is appended here the way `Substrate.emit`
 * appends a sessionless note: `normalizeEvent` redacts and hash-chains it, the append-mode check refuses a ledger that may drop rows
 * unless the operator accepted that, and one `insertEvent` writes it. Nothing is parked: a write that fails throws, the reconcile
 * reports the ledger as unavailable, the plan is not recorded, and nothing is repaired.
 */
function directNoteWriter(greptime: GreptimeClient, allowDeduplicatingLedger: boolean): NoteWriter {
	return {
		async emit(input) {
			const event = normalizeEvent(input, null);
			const appendOnly = await greptime.ensureAppendMode().catch(() => null);
			if (appendOnly !== true && !allowDeduplicatingLedger) {
				throw new Error("refusing to append: agent_events is not confirmed in append_mode (SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=true appends anyway)");
			}
			try {
				await greptime.insertEvent(event);
			} catch (cause) {
				// The row is stored and only its ingest record is unconfirmed: the note exists, as `Substrate.emit` reports it.
				if (!(cause instanceof IngestNotRecorded)) throw cause;
			}
			return { stored: true, event: { id: event.id } };
		},
	};
}

function describe(item: RepairItem): string {
	return item.action === "index-mark" ? `  index-mark ${item.entryId} (forget ${item.forgetId})` : `  cache-mark ${item.key} (ttl ${item.ttlS}s)`;
}

/** One finding the report names: its layer, key and reason. Report-only findings have no repair item. */
function describeMismatch(mismatch: Mismatch): string {
	return `  ${mismatch.layer} ${mismatch.key} (${mismatch.reason})`;
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
		if (run.report.mismatches.count === 0) {
			process.stdout.write("nothing to repair: the layers agree\n");
			return EXIT.clean;
		}
		// Report-only findings have no repair, so there is no plan id. The layers still disagree, so this is not clean.
		const { count, items } = run.report.mismatches;
		for (const mismatch of items) process.stdout.write(`${describeMismatch(mismatch)}\n`);
		if (count > items.length) process.stdout.write(`  ... ${count - items.length} more not named\n`);
		process.stdout.write("nothing to repair: the findings above are report-only, and the layers disagree\n");
		return EXIT.mismatch;
	}
	process.stdout.write(`plan ${run.planId}: ${run.items.length} repair(s) recorded as a reconcile.plan note; nothing repaired yet\n`);
	for (const item of run.items) process.stdout.write(`${describe(item)}\n`);
	process.stdout.write(`apply with: substrate reconcile --apply ${run.planId} --confirm\n`);
	return EXIT.mismatch;
}

async function runApply(deps: ReconcileDeps, options: ReconcileOptions, planId: string): Promise<number> {
	const planned = storedPlanItems(await deps.ledger.readEvent(planId));
	if (planned === null) {
		process.stderr.write(`[cross-layer-reconcile] no valid reconcile plan has id ${planId}; nothing was applied\n`);
		return EXIT.failed;
	}
	// The fresh read writes nothing. Its repairs must all be the stored plan's. The ones an earlier, partial apply already made are not
	// in it, so a retry proceeds for the rest; an empty read (every repair already made) proceeds too, and its apply records the note
	// the earlier run did not store. A repair that is new or altered refuses.
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
	if (!freshItemsWithinPlan(planned, fresh.items)) {
		process.stderr.write(`[cross-layer-reconcile] plan ${planId} no longer matches a fresh read of the layers: a repair it does not hold has appeared or changed; nothing was applied. Plan again with \`substrate reconcile\`.\n`);
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
	// The note writes go straight to the ledger. A `Substrate` here would load and drain the live queue files (see `directNoteWriter`).
	try {
		const deps: ReconcileDeps = { ledger: ledgerFromSubstrate("substrate", greptime, directNoteWriter(greptime, config.allowDeduplicatingLedger)), index, cache, now: () => Date.now() };
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
