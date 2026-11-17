#!/usr/bin/env bun
/**
 * The `substrate index archive|verify-archive|restore` runner (`ledger-run.ts`
 * precedent, uplift-4 S2).
 *
 *   bun packages/mcp-server/src/index-run.ts archive [--out DIR] [--page-size N] [--json]
 *   bun packages/mcp-server/src/index-run.ts verify-archive <dir> [--json]
 *   bun packages/mcp-server/src/index-run.ts restore --scratch <postgres-url> <dir> [--json]
 *
 * It lives in this package because it is a store client: the index and ledger
 * credentials are read here and nowhere outside `packages/mcp-server/src` (the
 * store lock), so the CLI package spawns this file.
 *
 * `archive` first resends any `note-pending-<snapshot>.json` left by an earlier
 * run — and only the notes: a snapshot is never exported twice for that — then
 * writes one snapshot into `--out` (or `SUBSTRATE_INDEX_ARCHIVE_DIR`) and records
 * it as one `note` through the same `Substrate.emit` path the sweep uses. A
 * refused note leaves the marker and is reported; the archive succeeded, so the
 * run does not fail for it. `verify-archive` needs no database or ledger at all.
 * `restore` loads a snapshot into a scratch database and never touches
 * production: it refuses when `SUBSTRATE_PG_URL` is unset or the scratch URL
 * names the same host, port and database.
 *
 * Exit codes: 0 done (a pending note is reported on stderr), 1 a store or
 * filesystem failure or a restore that did not reproduce the archive, 2 usage or
 * a refusal (an unset archive directory, a directory on the root filesystem or
 * the release root — unless `SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS=1` — the disk
 * floor, a production scratch URL, an archive that does not verify).
 */
import { loadConfig } from "./config.ts";
import { GreptimeClient } from "./greptime.ts";
import {
	ArchiveRefused,
	INDEX_ARCHIVE_USAGE,
	INDEX_ROOTFS_ENV,
	IndexUsageError,
	RestoreMismatch,
	RestoreRefused,
	archiveIndex,
	assertArchiveDir,
	describePgUrl,
	formatIndexManifest,
	formatIndexVerifyReport,
	formatRestoreResults,
	parseIndexArgs,
	recordIndexArchiveNote,
	refusedScratchUrl,
	restoreIndexArchive,
	retryPendingIndexNotes,
	verifyIndexArchive,
	type IndexCommand,
} from "./index-archive.ts";
import { IndexStore } from "./index-store.ts";
import { releaseShaOf } from "./ledger-archive.ts";
import type { NoteOutcome } from "./ledger-archive.ts";
import { redact } from "./redact.ts";
import { Substrate } from "./service.ts";
import type { EventInput } from "./types.ts";

function exitUsage(message: string): never {
	process.stderr.write(`${message}\n${INDEX_ARCHIVE_USAGE}`);
	process.exit(2);
}

/** A failure's message, redacted and short, with any URL this run was given removed: a connection error quotes its URL, password and all. */
function reasonOf(cause: unknown, urls: readonly string[] = []): string {
	let message = redact(String(cause instanceof Error ? cause.message : cause));
	for (const url of urls) if (url !== "") message = message.split(url).join("[url]");
	return message.slice(0, 300);
}

let command: IndexCommand;
try {
	command = parseIndexArgs(process.argv.slice(2));
} catch (cause) {
	exitUsage(cause instanceof IndexUsageError ? cause.message : String(cause));
}

if (command.command === "verify-archive") {
	const report = verifyIndexArchive(command.dir);
	process.stdout.write(command.json ? `${JSON.stringify(report)}\n` : formatIndexVerifyReport(report));
	process.exit(report.ok ? 0 : 2);
}

const config = loadConfig();
const settings = config.indexArchive;

if (command.command === "restore") {
	// A list-valued variable would take its first entry; a URL has no list form, so the value is used whole.
	const scratch = command.scratch ?? (process.env.SUBSTRATE_INDEX_SCRATCH_URL?.trim() || undefined);
	if (scratch === undefined) exitUsage("--scratch is required when SUBSTRATE_INDEX_SCRATCH_URL is unset");
	// Before a connection exists: the comparison needs nothing but the two strings.
	const refusal = refusedScratchUrl(scratch, config.postgresUrl);
	if (refusal !== null) {
		process.stderr.write(`[index] ${refusal}\n`);
		process.exit(2);
	}
	const target = new IndexStore(scratch, { pool: { max: 2, statementTimeoutMs: 120_000 } });
	let code = 0;
	try {
		const done = await restoreIndexArchive(target, { dir: command.dir });
		process.stdout.write(command.json ? `${JSON.stringify({ scratch: describePgUrl(scratch), ...done })}\n` : formatRestoreResults(done.results, describePgUrl(scratch)));
	} catch (cause) {
		if (cause instanceof RestoreMismatch) {
			process.stdout.write(command.json ? `${JSON.stringify({ scratch: describePgUrl(scratch), results: cause.results })}\n` : formatRestoreResults(cause.results, describePgUrl(scratch)));
			process.stderr.write("[index] the scratch database did not reproduce the archive; the restore was rolled back\n");
			code = 1;
		} else if (cause instanceof RestoreRefused) {
			process.stderr.write(`[index] ${cause.message}\n`);
			code = 2;
		} else {
			process.stderr.write(`[index] restore failed: ${reasonOf(cause, [scratch])}\n`);
			code = 1;
		}
	}
	await target.close({ timeout: 1 }).catch(() => undefined);
	process.exit(code);
}

// archive
const outDir = command.out ?? settings.dir;
if (outDir === undefined || outDir === null) exitUsage("--out is required when SUBSTRATE_INDEX_ARCHIVE_DIR is unset");
if (!config.postgresUrl) exitUsage("SUBSTRATE_PG_URL is not set");

const releaseSha = releaseShaOf(process.cwd());
// The same floor and grammar as `deploy-release.sh` (`^[0-9]{1,4}$`, `0` disables); anything else is the default.
const floorRaw = process.env.SUBSTRATE_DEPLOY_MIN_FREE_GB?.trim() ?? "";
const minFreeGb = /^\d{1,4}$/.test(floorRaw) ? Number(floorRaw) : undefined;
// A deliberate local test on a one-disk machine; the unit never sets it.
const allowRootfs = /^(1|true|yes)$/i.test(process.env[INDEX_ROOTFS_ENV]?.trim() ?? "");
const options = {
	outDir,
	...(command.pageSize === undefined ? {} : { pageSize: command.pageSize }),
	...(minFreeGb === undefined ? {} : { minFreeGb }),
	allowRootfs,
	maxSeconds: settings.maxSeconds,
	maxBytes: settings.maxBytes,
	...(releaseSha !== undefined ? { releaseSha } : {}),
};

let code = 0;
// Snapshots on disk whose note the ledger has not stored yet: reported on stderr and retried alone on the next run; the archive itself succeeded, so they never change the exit code.
let unrecorded: string[] = [];
// One pass with a short-lived pool: the export is one transaction on one connection, and the longer statement bound is this job's own.
const index = new IndexStore(config.postgresUrl, { pool: { max: 2, statementTimeoutMs: 60_000 } });
try {
	// The path gates run before anything is written, markers included: an unmounted volume must not collect a note marker on the root disk.
	assertArchiveDir(outDir, options, process.cwd());
	const greptime = config.greptime ? new GreptimeClient(config.greptime, { ledger: config.ledger }) : null;
	const substrate = new Substrate(config, { index, greptime });
	const emitNote = (input: EventInput): Promise<NoteOutcome> => substrate.emit(input);

	const retried = await retryPendingIndexNotes(outDir, emitNote);
	for (const snapshot of retried.sent) process.stdout.write(`[index] archive note for ${snapshot} recorded on retry\n`);
	for (const still of retried.pending) {
		process.stderr.write(`[index] archive note for ${still.snapshot} still not stored after ${still.attempts} attempts: ${still.lastError ?? "unknown"}\n`);
	}
	unrecorded = retried.pending.map((still) => still.snapshot);
	for (const warning of retried.markerWarnings) process.stderr.write(`[index] warning: ${warning}\n`);

	const manifest = await archiveIndex(index, {
		...options,
		onSwept: (names) => process.stderr.write(`[index] removed ${names.length} unfinished snapshot director${names.length === 1 ? "y" : "ies"} a killed run left: ${names.join(", ")}\n`),
	});
	process.stdout.write(command.json ? `${JSON.stringify(manifest)}\n` : formatIndexManifest(manifest));
	// The ledger's own record that the archive exists; refused, it leaves a marker the next run retries.
	const note = await recordIndexArchiveNote(outDir, manifest, emitNote);
	if (!note.stored) {
		process.stderr.write(`[index] archive note for ${manifest.snapshot} not stored in the ledger (marker left, retried next run): ${note.error ?? "unknown"}\n`);
		unrecorded.push(manifest.snapshot);
	}
	// The archive is complete either way; a marker that could not be written or cleared only weakens the note's retry guarantee.
	if (note.markerError !== undefined) process.stderr.write(`[index] warning: ${note.markerError} (the archive is complete; the ledger note ${note.stored ? "was stored" : "may not be retried"})\n`);
} catch (cause) {
	if (cause instanceof ArchiveRefused) {
		process.stderr.write(`[index] ${cause.message}\n`);
		code = 2;
	} else {
		process.stderr.write(`[index] archive failed: ${reasonOf(cause, [config.postgresUrl])}\n`);
		code = 1;
	}
}
await index.close({ timeout: 1 }).catch(() => undefined);
// A note the ledger has not taken is reported above and left as a marker for the next run; the archive itself succeeded, so it does not fail the run.
if (unrecorded.length > 0) process.stderr.write(`[index] ${unrecorded.length} archive note(s) still pending: ${unrecorded.join(", ")}\n`);
process.exit(code);
