#!/usr/bin/env bun
/**
 * The `substrate ledger` runner (`index-sweep-run.ts` precedent, uplift-3 N6).
 *
 *   bun packages/mcp-server/src/ledger-run.ts coverage [--json]
 *   bun packages/mcp-server/src/ledger-run.ts archive [--until YYYY-MM-DD] [--out DIR] [--page-size N] [--json]
 *   bun packages/mcp-server/src/ledger-run.ts verify-archive <dir> [--day YYYY-MM-DD] [--json]
 *
 * It lives in this package because it is a store client: `GREPTIME_*` is read
 * here and nowhere outside `packages/mcp-server/src` (the store lock), so the
 * CLI package spawns this file rather than importing the ledger client.
 *
 * `coverage` prints the anchor's coverage and exits 2 when more eligible
 * hours are uncovered than `SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS` allows.
 * `archive` first resends any `note-pending-<day>.json` left by an earlier run,
 * then writes every closed day up to `--until` (yesterday by default) that has
 * no manifest yet into `--out` (or `SUBSTRATE_LEDGER_ARCHIVE_DIR`) and records
 * each day as one `note` on surface `substrate` through the same
 * `Substrate.emit` path the sweep uses — the note is what `coverage` and
 * `/healthz.jobs.ledger.lastArchiveDay` read, so a refused note leaves the
 * marker and the run is not a success. `verify-archive` needs no ledger at
 * all: it checks the files and exits 2 on any mismatch.
 *
 * Exit codes: 0 done, 1 a ledger or filesystem failure or a day whose note the
 * ledger still has not taken, 2 usage or a refusal (unset `GREPTIME_URL`, an
 * unclosed day, a refused directory, a directory not on a dedicated mount —
 * unless `SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS=1` — the disk floor, an
 * uncovered-hours breach, a verify mismatch).
 */
import { loadConfig } from "./config.ts";
import { GreptimeClient } from "./greptime.ts";
import {
	ArchiveRefused,
	archiveWindow,
	archivedDays,
	dayOf,
	daysToArchive,
	formatCoverage,
	formatManifest,
	formatVerifyReport,
	isDayClosed,
	LEDGER_USAGE,
	LedgerUsageError,
	newestClosedDay,
	parseLedgerArgs,
	recordArchiveNote,
	releaseShaOf,
	retryPendingNotes,
	verifyArchive,
} from "./ledger-archive.ts";
import type { LedgerCommand, NoteOutcome } from "./ledger-archive.ts";
import type { EventInput } from "./types.ts";
import { redact } from "./redact.ts";
import { Substrate } from "./service.ts";

function exitUsage(message: string): never {
	process.stderr.write(`${message}\n${LEDGER_USAGE}`);
	process.exit(2);
}

/** A failure's message, redacted and short: a connection error quotes its URL, password and all. */
function reasonOf(cause: unknown): string {
	return redact(String(cause instanceof Error ? cause.message : cause)).slice(0, 300);
}

let command: LedgerCommand;
try {
	command = parseLedgerArgs(process.argv.slice(2));
} catch (cause) {
	exitUsage(cause instanceof LedgerUsageError ? cause.message : String(cause));
}

if (command.command === "verify-archive") {
	const days = command.day !== undefined ? [command.day] : archivedDays(command.dir);
	if (days.length === 0) {
		process.stderr.write(`[ledger] no manifest-<day>.json in ${command.dir}; nothing to verify\n`);
		process.exit(1);
	}
	let mismatched = 0;
	for (const day of days) {
		const report = verifyArchive(command.dir, day);
		process.stdout.write(command.json ? `${JSON.stringify(report)}\n` : formatVerifyReport(report));
		if (!report.ok) mismatched++;
	}
	process.exit(mismatched > 0 ? 2 : 0);
}

const config = loadConfig();
if (!config.greptime) exitUsage("GREPTIME_URL is not set");
const greptime = new GreptimeClient(config.greptime, { ledger: config.ledger });

if (command.command === "coverage") {
	try {
		const coverage = await greptime.anchorCoverage({ now: Date.now() });
		const limit = config.ledger.maxUncoveredHours;
		process.stdout.write(command.json ? `${JSON.stringify({ ...coverage, maxUncoveredHours: limit })}\n` : formatCoverage(coverage, limit));
		const breached = coverage.more || coverage.uncoveredHours.length > limit;
		if (breached) process.stderr.write(`[ledger] ${coverage.uncoveredHours.length}${coverage.more ? "+" : ""} uncovered hours exceed SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS=${limit}\n`);
		process.exit(breached ? 2 : 0);
	} catch (cause) {
		process.stderr.write(`[ledger] coverage failed: ${reasonOf(cause)}\n`);
		process.exit(1);
	}
}

// archive
const now = Date.now();
const outDir = command.out ?? config.ledger.archiveDir;
if (outDir === undefined || outDir === null) exitUsage("--out is required when SUBSTRATE_LEDGER_ARCHIVE_DIR is unset");
let until = command.until;
if (until === undefined) {
	const newest = newestClosedDay(now);
	if (newest === null) exitUsage("yesterday is not closed yet; try again in a few minutes or pass --until");
	until = newest;
} else if (!isDayClosed(until, now)) {
	exitUsage(`day ${until} is not closed yet`);
}

const substrate = new Substrate(config, { greptime });
const releaseSha = releaseShaOf(process.cwd());
// The same floor and grammar as `deploy-release.sh` (`^[0-9]{1,4}$`, `0` disables); anything else is the default.
const floorRaw = process.env.SUBSTRATE_DEPLOY_MIN_FREE_GB?.trim() ?? "";
const minFreeGb = /^\d{1,4}$/.test(floorRaw) ? Number(floorRaw) : undefined;
// A deliberate local test on a one-disk machine; the unit never sets it.
const allowRootfs = /^(1|true|yes)$/i.test(process.env.SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS?.trim() ?? "");
const emitNote = (input: EventInput): Promise<NoteOutcome> => substrate.emit(input);
let code = 0;
// Days archived earlier whose note the ledger refused: sent again before
// anything new, so a one-off ledger outage never leaves a day archived on
// disk and missing from every coverage report.
let unrecorded: string[] = [];
try {
	const retried = await retryPendingNotes(outDir, emitNote);
	for (const day of retried.sent) process.stdout.write(`[ledger] archive note for ${day} recorded on retry\n`);
	for (const still of retried.pending) {
		process.stderr.write(`[ledger] archive note for ${still.day} still not stored after ${still.attempts} attempts: ${still.lastError ?? "unknown"}\n`);
	}
	unrecorded = retried.pending.map((still) => still.day);

	const firstMs = await greptime.firstEventMs();
	if (firstMs === null) {
		process.stdout.write("[ledger] the ledger holds no events; nothing to archive\n");
	} else {
		const days = daysToArchive({ firstDay: dayOf(firstMs), until, dir: outDir });
		if (days.length === 0) process.stdout.write(`[ledger] every day up to ${until} already has a manifest in ${outDir}\n`);
		for (const day of days) {
			const manifest = await archiveWindow(greptime, {
				day,
				outDir,
				pageSize: command.pageSize,
				minFreeGb,
				allowRootfs,
				...(releaseSha !== undefined ? { releaseSha } : {}),
			});
			process.stdout.write(command.json ? `${JSON.stringify(manifest)}\n` : formatManifest(manifest));
			// The ledger's own record that the day left (what `coverage` reads
			// back); refused, it leaves a marker the next run retries.
			const note = await recordArchiveNote(outDir, manifest, emitNote);
			if (!note.stored) {
				process.stderr.write(`[ledger] archive note for ${day} not stored in the ledger (marker left, retried next run): ${note.error ?? "unknown"}\n`);
				unrecorded.push(day);
			}
		}
	}
} catch (cause) {
	if (cause instanceof ArchiveRefused) {
		process.stderr.write(`[ledger] ${cause.message}\n`);
		code = 2;
	} else {
		process.stderr.write(`[ledger] archive failed: ${reasonOf(cause)}\n`);
		code = 1;
	}
}
// Files on disk but the ledger not told: not a success, so the timer shows failed and the next tick retries.
if (code === 0 && unrecorded.length > 0) code = 1;
process.exit(code);
