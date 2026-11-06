#!/usr/bin/env bun
/**
 * The `consistency verify` runner (v1.6, phase 57, unit d; `ledger-run.ts` and `index-sweep-run.ts` precedent).
 *
 *   bun packages/mcp-server/src/consistency-run.ts [--json] [--bank BANK] [--limit N] [--since ISO] [--repair --server-stopped [--repair-orphans]]
 *
 * It compares the TimescaleDB memory index, the Hindsight documents and the ledger's memory-write events
 * (`consistency-verify.ts`) and prints the drift. It lives in this package because it is a store client: the
 * index, plane and ledger credentials are read here (through `loadConfig` and `hindsightFromEnv`) and nowhere
 * outside `packages/mcp-server/src`, so a CLI wrapper spawns this file rather than reading them.
 *
 * Nothing is repaired unless asked. `--repair` carries out the two safe, idempotent plane actions the plan names:
 * re-retain a current entry's missing document through the existing retain path (`replayRetain`), and delete the
 * plane document of a forgotten entry (the forget's pending delete). `--repair-orphans` (only with `--repair`)
 * adds the deletion of a plane document nothing in force owns. Every action re-reads the world first and acts
 * only if the finding still holds. The index and the ledger are NEVER written: the retain path's own warnings are
 * captured here, not emitted.
 *
 * Every repair writes to the plane from this separate process, outside the server's per-document retain queue, so it cannot
 * be made safe against a live server (a forget can delete a document while a repair's retain is in flight and the retain
 * then recreates the forgotten text; a replacement entry saved after the shared-document read shares the document id of the
 * one the repair then deletes). `--repair` therefore requires `--server-stopped`, the operator's assertion that substrate-mcp
 * and every other writer are stopped: without it the run refuses with a usage error (exit 2) before it sends anything.
 * Verification alone is read-only and needs no flag. As defence in depth each repair also re-reads the entry, the
 * shared-document answer and the document right before its write and skips with a named reason if anything changed.
 *
 * Exit codes: 0 consistent, 1 drift found, 2 usage or a refusal (a bad flag, an unset store), 3 a store was
 * unreachable or a check could not run, so `ok` cannot be claimed (it wins over 1: the JSON still lists the drift
 * that was found). Repair does not change the code; re-run the verifier to confirm.
 *
 * Environment: the variables `loadConfig` reads for the index (`SUBSTRATE_PG_URL`) and the ledger (`GREPTIME_*`),
 * `HINDSIGHT_URL`, `HINDSIGHT_API_KEY` and `HINDSIGHT_BANK_PREFIX` through `hindsightFromEnv`, and
 * `SUBSTRATE_RETAIN_OUTBOX_PATH` (read-only, to tell a parked retain from a missing one) and
 * `HINDSIGHT_RETAIN_TIMEOUT_MS` through `loadConfig`. No new variable. It never prints a URL, a token or entry content.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import {
	ConsistencyOptionError,
	MAX_ENTRIES_CEILING,
	ReaderUnsupported,
	STORES,
	defaultDocumentId,
	formatReportJson,
	formatReportText,
	planRepairs,
	scrubReason,
	verifyConsistency,
	type ConsistencyReaders,
	type ConsistencyReport,
	type FindingCode,
	type LedgerReader,
	type LedgerWriteEvent,
	type OutboxReader,
	type PlaneDocumentView,
	type RepairAction,
	type RepairActionName,
	type RepairCondition,
	type RepairPlan,
	type RepairStep,
} from "./consistency-verify.ts";
import { GreptimeClient } from "./greptime.ts";
import { IndexStore } from "./index-store.ts";
import { isForgetMarker } from "./memory-forget.ts";
import { replayRetain } from "./memory-retain.ts";
import {
	bankConfig,
	bankForSurface,
	deleteDocument,
	getDocument,
	hindsightBanksFromEnv,
	hindsightFromEnv,
	type FetchLike,
	type HindsightConfig,
} from "./planes/hindsight.ts";
import { reportSilent } from "./silent-failures.ts";
import { SURFACES, type MemoryEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// Argument grammar
// ---------------------------------------------------------------------------

export const CONSISTENCY_USAGE =
	"usage: consistency-run.ts [--json] [--bank BANK] [--limit N] [--since ISO] [--repair --server-stopped [--repair-orphans]]\n" +
	"  --json            print the report as JSON (default: a short summary)\n" +
	"  --bank BANK       one bank only (a name under the configured bank prefix)\n" +
	`  --limit N         examine at most N entries, newest first (1..${MAX_ENTRIES_CEILING}, default 5000)\n` +
	"  --since ISO       only entries created at or after this instant, e.g. 2026-10-01T00:00:00Z\n" +
	"  --repair          carry out the safe repairs: re-retain a missing document, delete a forgotten entry's document\n" +
	"  --server-stopped  required by --repair: you assert substrate-mcp and every writer are stopped (a repair cannot join the server's write queue)\n" +
	"  --repair-orphans  with --repair: also delete plane documents nothing in force owns\n" +
	"exit: 0 consistent, 1 drift found, 2 usage, 3 a store was unreachable (ok cannot be claimed)\n";

export class ConsistencyUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConsistencyUsageError";
	}
}

export interface ConsistencyArgs {
	json: boolean;
	bank: string | null;
	limit: number | null;
	since: string | null;
	repair: boolean;
	repairOrphans: boolean;
	/** The operator's assertion that the server and every other writer are stopped; `--repair` needs it. */
	serverStopped: boolean;
}

const BOOLEAN_FLAGS = ["json", "repair", "repair-orphans", "server-stopped"] as const;
const VALUE_FLAGS = ["bank", "limit", "since"] as const;
const BANK_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Strict: only the seven flags, each at most once, a value flag always followed by its value (`--bank B`, never
 * `--bank=B`), no positional argument. `--repair-orphans` without `--repair` is refused rather than ignored, and so is `--repair` without `--server-stopped`.
 */
export function parseConsistencyArgs(argv: readonly string[]): ConsistencyArgs {
	const booleans = new Set<string>();
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (!arg.startsWith("--")) throw new ConsistencyUsageError(`unexpected argument "${arg.slice(0, 40)}"`);
		const name = arg.slice(2);
		if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
			if (booleans.has(name)) throw new ConsistencyUsageError(`--${name} given twice`);
			booleans.add(name);
			continue;
		}
		if ((VALUE_FLAGS as readonly string[]).includes(name)) {
			if (values.has(name)) throw new ConsistencyUsageError(`--${name} given twice`);
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) throw new ConsistencyUsageError(`--${name} needs a value`);
			values.set(name, value);
			i += 1;
			continue;
		}
		throw new ConsistencyUsageError(`unknown flag "${arg.slice(0, 40)}" (a value flag takes its value as the next argument)`);
	}

	let bank: string | null = null;
	const bankRaw = values.get("bank");
	if (bankRaw !== undefined) {
		if (!BANK_NAME.test(bankRaw)) throw new ConsistencyUsageError("--bank needs a bank name (letters, digits, . _ -)");
		bank = bankRaw;
	}
	let limit: number | null = null;
	const limitRaw = values.get("limit");
	if (limitRaw !== undefined) {
		if (!/^[1-9]\d{0,9}$/.test(limitRaw) || Number(limitRaw) > MAX_ENTRIES_CEILING) {
			throw new ConsistencyUsageError(`--limit needs an integer from 1 to ${MAX_ENTRIES_CEILING}`);
		}
		limit = Number(limitRaw);
	}
	let since: string | null = null;
	const sinceRaw = values.get("since");
	if (sinceRaw !== undefined) {
		const parsed = Date.parse(sinceRaw);
		if (!ISO_INSTANT.test(sinceRaw) || Number.isNaN(parsed)) {
			throw new ConsistencyUsageError("--since needs an ISO instant with a time and a zone, e.g. 2026-10-01T00:00:00Z");
		}
		since = new Date(parsed).toISOString();
	}
	const repair = booleans.has("repair");
	const repairOrphans = booleans.has("repair-orphans");
	if (repairOrphans && !repair) throw new ConsistencyUsageError("--repair-orphans only applies together with --repair");
	const serverStopped = booleans.has("server-stopped");
	if (serverStopped && !repair) throw new ConsistencyUsageError("--server-stopped only applies together with --repair");
	if (repair && !serverStopped) {
		throw new ConsistencyUsageError(
			"--repair writes to the plane from outside the server's write queue, so a retain or forget in flight could revive a forgotten document or delete a replacement: stop substrate-mcp and every writer, then add --server-stopped",
		);
	}
	return { json: booleans.has("json"), bank, limit, since, repair, repairOrphans, serverStopped };
}

// ---------------------------------------------------------------------------
// Repair execution
// ---------------------------------------------------------------------------

/**
 * The only operations a repair may perform. There is no index write and no ledger write here to call: a plan
 * cannot reach what the ports do not offer.
 */
export interface RepairPorts {
	readEntry(id: string): Promise<MemoryEntry | null>;
	documentShared(entry: MemoryEntry): Promise<boolean>;
	readDocument(bank: string, documentId: string): Promise<PlaneDocumentView | null>;
	/** Re-retain the entry's document through the existing retain path. `forwarded: false` carries the retain's own reason. */
	retain(entry: MemoryEntry, bank: string, documentId: string): Promise<{ forwarded: boolean; reason?: string }>;
	deleteDocument(bank: string, documentId: string): Promise<"deleted" | "absent">;
}

export type RepairOutcomeKind = "repaired" | "already_consistent" | "skipped" | "failed";

export interface RepairOutcome {
	action: RepairActionName;
	finding: FindingCode;
	finding_id: string;
	outcome: RepairOutcomeKind;
	reason?: string;
}

export interface RepairRun {
	orphans_enabled: boolean;
	/** The plan covered every finding the run had; false when the findings list was cut or a store was unreachable. */
	plan_complete: boolean;
	counts: Record<RepairOutcomeKind, number>;
	/** Findings no automatic repair applies to. */
	unrepairable: number;
	outcomes: RepairOutcome[];
}

/** Per action, the steps it may contain and the one write it may end in. */
const ACTION_SHAPE: Record<RepairActionName, { write: "retain_document" | "delete_document"; class: "safe" | "orphan" }> = {
	re_retain: { write: "retain_document", class: "safe" },
	delete_forgotten_document: { write: "delete_document", class: "safe" },
	delete_orphan_document: { write: "delete_document", class: "orphan" },
};

/** True when `action` is exactly the shape the planner produces: a known name and class, reads and checks, then ONE write of its own kind, last. */
function wellFormed(action: RepairAction): string | null {
	const shape = ACTION_SHAPE[action.action];
	if (shape === undefined) return "unknown action";
	if (action.class !== shape.class) return "wrong class for the action";
	const writes = action.steps.filter((step) => step.op === "retain_document" || step.op === "delete_document");
	if (writes.length !== 1 || writes[0]?.op !== shape.write) return "the action must end in exactly one write of its own kind";
	if (action.steps[action.steps.length - 1]?.op !== shape.write) return "the write must be the last step";
	return null;
}

type Verdict = "pass" | { outcome: "already_consistent" | "skipped"; reason: string };

async function evaluate(ports: RepairPorts, step: Extract<RepairStep, { op: "require" }>, entry: MemoryEntry | null | undefined): Promise<Verdict> {
	const condition: RepairCondition = step.condition;
	switch (condition) {
		case "entry_current":
			return entry !== undefined && entry !== null && entry.superseded_by === undefined ? "pass" : { outcome: "skipped", reason: "the entry is no longer current" };
		case "entry_forgotten":
			return entry !== undefined && entry !== null && isForgetMarker(entry.superseded_by) ? "pass" : { outcome: "skipped", reason: "the entry is not forgotten" };
		case "document_absent": {
			if (step.bank === undefined || step.document_id === undefined) return { outcome: "skipped", reason: "the step names no document" };
			return (await ports.readDocument(step.bank, step.document_id)) === null ? "pass" : { outcome: "already_consistent", reason: "the document exists now" };
		}
		case "document_present": {
			if (step.bank === undefined || step.document_id === undefined) return { outcome: "skipped", reason: "the step names no document" };
			return (await ports.readDocument(step.bank, step.document_id)) !== null ? "pass" : { outcome: "already_consistent", reason: "the document is already gone" };
		}
		case "document_not_shared": {
			if (entry === undefined || entry === null) return { outcome: "skipped", reason: "the entry is gone" };
			return (await ports.documentShared(entry)) ? { outcome: "skipped", reason: "a live entry shares the document" } : "pass";
		}
		case "document_orphaned": {
			if (step.bank === undefined || step.document_id === undefined) return { outcome: "skipped", reason: "the step names no document" };
			const document = await ports.readDocument(step.bank, step.document_id);
			if (document === null) return { outcome: "already_consistent", reason: "the document is already gone" };
			if (document.entry_id === undefined) return { outcome: "skipped", reason: "the document names no entry: left for manual review" };
			const owner = await ports.readEntry(document.entry_id);
			if (owner === null) return "pass";
			if (owner.superseded_by === undefined) {
				// A current entry: only a second copy under another id is a stray, and only while the entry's own document exists.
				if (step.expected_document_id === undefined || step.expected_document_id === step.document_id) {
					return { outcome: "skipped", reason: "a current entry owns this document" };
				}
				return (await ports.readDocument(step.bank, step.expected_document_id)) === null
					? { outcome: "skipped", reason: "the entry's own document is absent: re-retain it first" }
					: "pass";
			}
			return (await ports.documentShared(owner)) ? { outcome: "skipped", reason: "a live entry shares the document" } : "pass";
		}
	}
}

/**
 * The check after a repair's retain. This runner is its own process, outside the server's per-document write queue, so a
 * forget can mark the entry and delete its document while the retain's POST is in flight, and the POST then lands after the
 * delete and brings the forgotten text back. The entry is read again once the retain has landed: one forgotten meanwhile has
 * the copy this repair just wrote removed, unless a live entry of the same writer shares the document. The forget's mark
 * always precedes its own delete, so a forget that lands after this read deletes the copy itself.
 */
async function afterRetain(ports: RepairPorts, entry: MemoryEntry, step: Extract<RepairStep, { op: "retain_document" }>): Promise<Pick<RepairOutcome, "outcome" | "reason">> {
	try {
		const current = await ports.readEntry(entry.id);
		if (current === null || !isForgetMarker(current.superseded_by)) return { outcome: "repaired" };
		if (await ports.documentShared(current)) {
			return { outcome: "skipped", reason: "the entry was forgotten while the repair ran; a live entry shares the document, which was left in place" };
		}
		await ports.deleteDocument(step.bank, step.document_id);
		return { outcome: "skipped", reason: "the entry was forgotten while the repair ran; the document the repair re-created was removed" };
	} catch (cause) {
		return {
			outcome: "failed",
			reason: scrubReason(`the document was re-retained but the entry could not be confirmed current, or its stale copy removed: ${cause instanceof Error ? cause.message : String(cause)}`),
		};
	}
}

/** What of an entry row decides whether a repair still applies: the state it is in, and the content a retain would send. */
const rowOf = (entry: MemoryEntry | null | undefined): string =>
	entry === undefined || entry === null ? "absent" : JSON.stringify([entry.id, entry.superseded_by ?? null, entry.version, entry.entry_hash, entry.scope, entry.kind, entry.subject ?? null, entry.writer]);

/**
 * The last look before a plane write (defence in depth: the operator guard `--server-stopped` is what makes a repair safe).
 * Everything the action read and required is read and required again, immediately before the write, and the entry row must
 * be the one the action started from. Anything else is a skip with the reason named, so a row that changed between the
 * plan and the apply is never acted on.
 */
async function changedBeforeWrite(ports: RepairPorts, action: RepairAction, first: MemoryEntry | null | undefined): Promise<Pick<RepairOutcome, "outcome" | "reason"> | null> {
	let entry: MemoryEntry | null | undefined;
	for (const step of action.steps) {
		if (step.op === "read_entry") {
			entry = await ports.readEntry(step.entry_id);
			if (rowOf(entry) !== rowOf(first)) return { outcome: "skipped", reason: "the entry row changed between the plan and the write; nothing was sent" };
		} else if (step.op === "require") {
			const verdict = await evaluate(ports, step, entry);
			if (verdict !== "pass") return { outcome: verdict.outcome, reason: `re-read before the write: ${verdict.reason}` };
		}
	}
	return null;
}

async function runAction(ports: RepairPorts, action: RepairAction): Promise<Pick<RepairOutcome, "outcome" | "reason">> {
	const problem = wellFormed(action);
	if (problem !== null) return { outcome: "failed", reason: `plan refused: ${problem}` };
	let entry: MemoryEntry | null | undefined;
	for (const step of action.steps) {
		switch (step.op) {
			case "read_entry":
				entry = await ports.readEntry(step.entry_id);
				break;
			case "require": {
				const verdict = await evaluate(ports, step, entry);
				if (verdict !== "pass") return verdict;
				break;
			}
			case "retain_document": {
				if (entry === undefined || entry === null) return { outcome: "skipped", reason: "the entry is gone" };
				const changed = await changedBeforeWrite(ports, action, entry);
				if (changed !== null) return changed;
				const retained = await ports.retain(entry, step.bank, step.document_id);
				if (retained.forwarded) return afterRetain(ports, entry, step);
				const reason = scrubReason(retained.reason ?? "the retain did not forward");
				// A refusal by the retain gate (expired, unsourced, unredacted, guest) is the gate's verdict, not a repair that broke.
				return /^(retain\.|vm-guest|hindsight is not configured)/.test(reason) ? { outcome: "skipped", reason } : { outcome: "failed", reason };
			}
			case "delete_document": {
				const changed = await changedBeforeWrite(ports, action, entry);
				if (changed !== null) return changed;
				const deleted = await ports.deleteDocument(step.bank, step.document_id);
				return deleted === "deleted" ? { outcome: "repaired" } : { outcome: "already_consistent", reason: "the document was already gone" };
			}
		}
	}
	return { outcome: "failed", reason: "the plan ended without its write" };
}

/**
 * Carry out a plan's actions one at a time. An orphan action runs only with `allow.orphans`. A throwing port
 * fails that action (its reason redacted and stripped of URLs) and the run goes on; nothing here throws.
 */
export async function executeRepairPlan(plan: RepairPlan, ports: RepairPorts, allow: { orphans: boolean }): Promise<RepairRun> {
	const counts: Record<RepairOutcomeKind, number> = { repaired: 0, already_consistent: 0, skipped: 0, failed: 0 };
	const outcomes: RepairOutcome[] = [];
	for (const action of plan.actions) {
		const base = { action: action.action, finding: action.finding, finding_id: action.finding_id };
		let result: Pick<RepairOutcome, "outcome" | "reason">;
		if (action.class === "orphan" && !allow.orphans) {
			result = { outcome: "skipped", reason: "orphan deletion needs --repair-orphans" };
		} else {
			try {
				result = await runAction(ports, action);
			} catch (cause) {
				result = { outcome: "failed", reason: scrubReason(cause instanceof Error ? cause.message : String(cause)) };
			}
		}
		counts[result.outcome] += 1;
		outcomes.push({ ...base, outcome: result.outcome, ...(result.reason !== undefined ? { reason: result.reason } : {}) });
	}
	return { orphans_enabled: allow.orphans, plan_complete: plan.complete, counts, unrepairable: plan.unrepairable.length, outcomes };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Everything a run needs from the outside world, so a test can hand in fakes. */
export interface RunnerContext {
	readers: ConsistencyReaders;
	bankFor: (writer: string) => string;
	/** The configured bank prefix: `--bank` must name a bank under it (a `pd-*` desk bank is never touched). */
	bankPrefix: string;
	/** Every bank the server is configured to write or recall into: each one is examined, with or without index rows. */
	banks: readonly string[];
	repair: RepairPorts;
	close(): Promise<void>;
}

export interface RunnerDeps {
	now(): number;
	open(): Promise<RunnerContext | { refused: string }>;
}

export interface RunResult {
	code: 0 | 1 | 2 | 3;
	stdout: string;
	stderr: string;
}

const usageFailure = (message: string): RunResult => ({ code: 2, stdout: "", stderr: `${message}\n${CONSISTENCY_USAGE}` });

function exitCodeOf(report: ConsistencyReport): 0 | 1 | 3 {
	const unread = STORES.some((store) => report.stores[store].state !== "ok") || report.coverage.skipped_checks.length > 0;
	if (unread) return 3;
	return report.counts.findings_total > 0 ? 1 : 0;
}

function formatRepairText(run: RepairRun, plan: RepairPlan): string {
	const lines = [
		`repair   ${run.counts.repaired} repaired, ${run.counts.already_consistent} already consistent, ${run.counts.skipped} skipped, ${run.counts.failed} failed` +
			`${run.orphans_enabled ? "" : " (orphan deletion off)"}${run.plan_complete ? "" : " (the plan does not cover every finding)"}`,
	];
	for (const outcome of run.outcomes.filter((o) => o.outcome !== "repaired").slice(0, 10)) {
		lines.push(`  ${outcome.action} ${outcome.finding_id}: ${outcome.outcome}${outcome.reason !== undefined ? ` (${outcome.reason})` : ""}`);
	}
	if (plan.unrepairable.length > 0) lines.push(`  ${plan.unrepairable.length} finding(s) have no automatic repair`);
	lines.push("  re-run the verifier to confirm");
	return `${lines.join("\n")}\n`;
}

/** One run: parse, open the stores, verify, optionally repair, format. Never throws; the result carries the exit code. */
export async function runConsistency(argv: readonly string[], deps: RunnerDeps): Promise<RunResult> {
	let args: ConsistencyArgs;
	try {
		args = parseConsistencyArgs(argv);
	} catch (cause) {
		if (cause instanceof ConsistencyUsageError) return usageFailure(cause.message);
		throw cause;
	}

	let opened: RunnerContext | { refused: string };
	try {
		opened = await deps.open();
	} catch (cause) {
		return usageFailure(scrubReason(cause instanceof Error ? cause.message : String(cause)));
	}
	if ("refused" in opened) return usageFailure(opened.refused);
	const context = opened;

	try {
		if (args.bank !== null && !args.bank.startsWith(context.bankPrefix)) {
			return usageFailure(`--bank must name a substrate bank (one starting with the configured bank prefix "${context.bankPrefix}")`);
		}
		let report: ConsistencyReport;
		try {
			report = await verifyConsistency(context.readers, {
				now: deps.now,
				bankFor: context.bankFor,
				configuredBanks: context.banks,
				...(args.bank !== null ? { bank: args.bank } : {}),
				...(args.since !== null ? { since: args.since } : {}),
				...(args.limit !== null ? { maxEntries: args.limit } : {}),
			});
		} catch (cause) {
			if (cause instanceof ConsistencyOptionError) return usageFailure(cause.message);
			// verifyConsistency reports store trouble as data; anything thrown past it is a defect, and the run says it could not verify.
			return { code: 3, stdout: "", stderr: `the verifier failed: ${scrubReason(cause instanceof Error ? cause.message : String(cause))}\n` };
		}

		const plan = planRepairs(report);
		let repairRun: RepairRun | null = null;
		let repairNote: string | null = null;
		if (args.repair) {
			if (report.stores.index.state !== "ok" || report.stores.plane.state !== "ok") {
				repairNote = "repair skipped: the index and the plane must both have been read";
			} else {
				repairRun = await executeRepairPlan(plan, context.repair, { orphans: args.repairOrphans });
			}
		}

		let stdout: string;
		if (args.json) {
			stdout = formatReportJson(repairRun !== null ? { ...report, repairs: repairRun } : report);
		} else {
			stdout = formatReportText(report);
			if (repairRun !== null) stdout += formatRepairText(repairRun, plan);
			else if (repairNote !== null) stdout += `  ${repairNote}\n`;
			else if (plan.actions.length > 0) {
				const orphan = plan.actions.filter((a) => a.class === "orphan").length;
				stdout += `  repairs available: ${plan.actions.length - orphan} safe, ${orphan} orphan (stop the server, then re-run with --repair --server-stopped${orphan > 0 ? " [--repair-orphans]" : ""})\n`;
			}
		}
		return { code: exitCodeOf(report), stdout, stderr: repairNote !== null && args.json ? `${repairNote}\n` : "" };
	} finally {
		await context.close().catch((cause: unknown) => reportSilent("consistency.close", cause));
	}
}

// ---------------------------------------------------------------------------
// The real readers and ports
// ---------------------------------------------------------------------------

/** One plane request's own bound; the verifier's per-reader timeout is the outer one. */
const PLANE_TIMEOUT_MS = 4000;

/**
 * `GET {bank}/documents?limit&offset`, the plane's document listing, read-only. `planes/hindsight.ts` has no
 * listing yet, so this lives here until it does; it reads only document ids. An answer the route does not have
 * (404 on a bank that exists, 405, 501) is {@link ReaderUnsupported}, never "no documents": the verifier then
 * skips the orphan checks and says so. Failure messages are fixed text: the cause is never repeated, so no URL or
 * credential can ride along.
 */
export async function listBankDocuments(
	config: HindsightConfig,
	bank: string,
	request: { limit: number; cursor: string | null },
	fetchImpl: FetchLike,
	timeoutMs: number,
): Promise<{ ids: string[]; next: string | null }> {
	const offset = request.cursor === null ? 0 : Number(request.cursor);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("plane list documents: bad cursor");
	let response: Response;
	try {
		response = await fetchImpl(`${config.url}/v1/default/banks/${encodeURIComponent(bank)}/documents?limit=${request.limit}&offset=${offset}`, {
			method: "GET",
			headers: { authorization: `Bearer ${config.apiKey}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (cause) {
		const timedOut = cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
		throw new Error(`plane list documents: ${timedOut ? "timed out" : "unreachable"}`);
	}
	if (response.status === 404) {
		// 404 is either "no such route" or "no such bank". The bank's own config route tells them apart.
		const probe = await bankConfig(config, bank, fetchImpl, { timeoutMs });
		if (probe.ok) throw new ReaderUnsupported("the plane has no document listing route");
		if (probe.error.kind === "not-found") return { ids: [], next: null };
		throw new Error(`plane list documents: ${probe.error.kind}`);
	}
	if (response.status === 405 || response.status === 501) throw new ReaderUnsupported(`the plane has no document listing route (http ${response.status})`);
	if (response.status !== 200) throw new Error(`plane list documents: http ${response.status}`);
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new ReaderUnsupported("the plane's document listing was not JSON");
	}
	const items = body !== null && typeof body === "object" && "items" in body && Array.isArray(body.items) ? (body.items as unknown[]) : null;
	if (items === null) throw new ReaderUnsupported("the plane's document listing has no items array");
	const ids: string[] = [];
	for (const item of items) {
		if (item !== null && typeof item === "object" && "id" in item && typeof item.id === "string" && item.id.length > 0) ids.push(item.id);
	}
	const total = body !== null && typeof body === "object" && "total" in body && typeof body.total === "number" && Number.isFinite(body.total) ? body.total : null;
	const seen = offset + items.length;
	// With no total the end is an empty page: a server may cap a page below the limit asked for, and a short page must not read as the end.
	const more = items.length > 0 && (total === null || seen < total);
	return { ids, next: more ? String(seen) : null };
}

/** The ledger's accepted memory-write notes, newest-window first read in ascending order, from `queryEvents`. */
const WRITE_KINDS = ["note", "warning"] as const;

const ACCEPTED_WRITE_SUMMARY = "memory.write accepted";

function writeEventOf(row: Record<string, unknown>): LedgerWriteEvent | null {
	if (typeof row.id !== "string" || typeof row.surface !== "string" || typeof row.summary !== "string") return null;
	if (!row.summary.startsWith(ACCEPTED_WRITE_SUMMARY)) return null;
	const tsMs = Number(row.ts);
	if (!Number.isFinite(tsMs)) return null;
	let payload: unknown;
	try {
		payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
	} catch (cause: unknown) {
		reportSilent("consistency.payload", cause);
		return null;
	}
	if (payload === null || typeof payload !== "object") return null;
	const fields = payload as Record<string, unknown>;
	if (fields.outcome !== "accepted" || typeof fields.scope !== "string" || typeof fields.kind !== "string") return null;
	// Carried only when the payload names one (the key is newer than the events); the key is absent, never `undefined`, so a legacy event keeps its old shape.
	const entryId = typeof fields.entry_id === "string" && fields.entry_id.length > 0 ? { entry_id: fields.entry_id } : {};
	return { id: row.id, ts: new Date(tsMs).toISOString(), surface: row.surface, scope: fields.scope, kind: fields.kind, ...entryId };
}

/**
 * A verified accepted write is a `note`; an accepted one the read-back could not verify is a `warning`
 * (`auditMemoryWrite`). Both are read, notes first. The cursor is `<kind index>|<ISO ts>`: it resumes inclusively
 * at the last timestamp (the verifier de-duplicates by event id) and moves to the next kind when a read comes back short.
 * `skipped` counts the rows that claim to be an accepted write but cannot be read as one, so no event is invented for them.
 * A resumed page can return the same such row again; each row is counted once per reader.
 */
export function ledgerWriteReader(greptime: Pick<GreptimeClient, "queryEvents">): LedgerReader {
	const countedSkips = new Set<string>();
	return {
		memoryWrites: async ({ since, until, limit, cursor }) => {
			let kindIndex = 0;
			let from = since;
			if (cursor !== null) {
				const parsed = /^([01])\|(.+)$/.exec(cursor);
				if (parsed === null || Number.isNaN(Date.parse(parsed[2] ?? ""))) throw new Error("ledger reader: bad cursor");
				kindIndex = Number(parsed[1]);
				from = parsed[2] as string;
			}
			const kind = WRITE_KINDS[kindIndex] as (typeof WRITE_KINDS)[number];
			const rows = await greptime.queryEvents({ match: { kind }, since: from, until, limit, order: "asc", includePayload: true });
			const events: LedgerWriteEvent[] = [];
			let skipped = 0;
			for (const row of rows) {
				const event = writeEventOf(row);
				if (event !== null) {
					events.push(event);
					continue;
				}
				if (typeof row.summary !== "string" || !row.summary.startsWith(ACCEPTED_WRITE_SUMMARY)) continue;
				const key = typeof row.id === "string" ? `id:${row.id}` : `row:${JSON.stringify(row)}`;
				if (countedSkips.has(key)) continue;
				countedSkips.add(key);
				skipped += 1;
			}
			let next: string | null;
			if (rows.length >= limit) {
				const last = Number(rows[rows.length - 1]?.ts);
				if (!Number.isFinite(last)) throw new Error("ledger reader: a row has no usable ts");
				next = `${kindIndex}|${new Date(last).toISOString()}`;
			} else if (kindIndex < WRITE_KINDS.length - 1) {
				next = `${kindIndex + 1}|${since}`;
			} else {
				next = null;
			}
			return { events, next, skipped };
		},
	};
}

/**
 * The parked retains, read from the outbox file WITHOUT opening it as a `RetainOutbox` (that hydrates and then
 * rewrites the file the live server owns). Unset path: `null`, the outbox is in the server's memory and cannot be
 * known. A missing file is an empty outbox. Lines that do not parse are skipped: they are the outbox's own
 * damage to report, not this read's.
 */
export function outboxFileReader(path: string | null, readText: (path: string) => string | null): OutboxReader {
	return {
		parkedEntryIds: async () => {
			if (path === null) return null;
			const body = readText(path);
			const ids = new Set<string>();
			if (body === null) return ids;
			for (const line of body.split("\n")) {
				if (line.trim().length === 0) continue;
				try {
					const parsed: unknown = JSON.parse(line);
					if (parsed !== null && typeof parsed === "object" && "entry_id" in parsed && typeof parsed.entry_id === "string") ids.add(parsed.entry_id);
				} catch {
					// A torn or foreign line is skipped on purpose: see the comment above.
				}
			}
			return ids;
		},
	};
}

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
		throw cause;
	}
}

/**
 * Every bank the server is configured with: the writer bank of each known surface (`bankForSurface`) and the
 * explicit recall set (`HINDSIGHT_BANKS`, already limited to the bank prefix). Sorted and de-duplicated. The
 * verifier examines all of them, so a bank whose index rows were swept still has its documents checked.
 */
export function configuredBanks(plane: HindsightConfig, env: Record<string, string | undefined>): string[] {
	return [...new Set([...SURFACES.map((surface) => bankForSurface(plane, surface)), ...(hindsightBanksFromEnv(env) ?? [])])].sort();
}

/** Open the real stores from the server's environment. Credentials are read here and only here. */
export async function openRealContext(): Promise<RunnerContext | { refused: string }> {
	const config = loadConfig();
	if (!config.postgresUrl) return { refused: "SUBSTRATE_PG_URL is not set" };
	if (!config.greptime) return { refused: "GREPTIME_URL is not set" };
	const plane = hindsightFromEnv(process.env);
	if (plane === null) return { refused: "HINDSIGHT_URL and HINDSIGHT_API_KEY must both be set" };

	const index = new IndexStore(config.postgresUrl);
	const greptime = new GreptimeClient(config.greptime, { ledger: config.ledger });
	const fetchImpl: FetchLike = fetch;
	const retainTimeoutMs = config.hindsightBudgets.retainTimeoutMs;

	const readDocument = async (bank: string, id: string): Promise<PlaneDocumentView | null> => {
		const read = await getDocument(plane, bank, id, fetchImpl, PLANE_TIMEOUT_MS);
		if (!read.ok) throw new Error(read.error.message);
		if (read.value === null) return null;
		const entryId = read.value.metadata.entry_id;
		return { id: read.value.id, ...(typeof entryId === "string" && entryId.length > 0 ? { entry_id: entryId } : {}) };
	};

	return {
		readers: {
			index: {
				page: async ({ limit, cursor }) => {
					// `includeSuperseded` lists every row; no `read` options, so no lifetime or agent-scope filter thins the page.
					const page = await index.searchMemoryPage({
						includeSuperseded: true,
						limit,
						...(cursor !== null ? { before: cursor.before, beforeId: cursor.before_id } : {}),
					});
					return { entries: page.entries, next: page.next };
				},
				entry: (id) => index.readEntry(id),
				documentShared: (entry) => index.memoryDocumentShared(entry),
			},
			plane: {
				getDocument: readDocument,
				listDocuments: (bank, request) => listBankDocuments(plane, bank, request, fetchImpl, PLANE_TIMEOUT_MS),
			},
			ledger: ledgerWriteReader(greptime),
			outbox: outboxFileReader(config.retainOutbox.path, readTextOrNull),
		},
		bankFor: (writer) => bankForSurface(plane, writer),
		bankPrefix: plane.bankPrefix,
		banks: configuredBanks(plane, process.env),
		repair: {
			readEntry: (id) => index.readEntry(id),
			documentShared: (entry) => index.memoryDocumentShared(entry),
			readDocument,
			retain: async (entry, bank, documentId) => {
				// The plan is data: confirm it names the bank and document this entry really maps to before any write.
				if (bank !== bankForSurface(plane, entry.writer)) return { forwarded: false, reason: "the plan names a bank this entry does not retain into" };
				if (defaultDocumentId(entry) !== documentId) return { forwarded: false, reason: "the plan names a document this entry does not map to" };
				const outcome = await replayRetain(
					{
						config: plane,
						fetchImpl,
						retainTimeoutMs,
						graphLifetime: (candidate) => index.graphLifetime(candidate),
						// The retain path would emit its refusal and failure warnings into the ledger. This runner writes
						// nothing there: the reason comes back in the outcome instead.
						emit: async () => undefined,
					},
					{ entry, writer: entry.writer, bank, documentId, ...(entry.session_id !== undefined ? { sessionId: entry.session_id } : {}) },
				);
				return outcome.forwarded ? { forwarded: true } : { forwarded: false, reason: outcome.reason ?? "the retain did not forward" };
			},
			deleteDocument: async (bank, documentId) => {
				const deleted = await deleteDocument(plane, bank, documentId, fetchImpl, PLANE_TIMEOUT_MS);
				if (!deleted.ok) throw new Error(deleted.error.message);
				return deleted.value ? "deleted" : "absent";
			},
		},
		close: () => index.close(),
	};
}

if (import.meta.main) {
	const result = await runConsistency(process.argv.slice(2), { now: Date.now, open: openRealContext });
	if (result.stdout.length > 0) process.stdout.write(result.stdout);
	if (result.stderr.length > 0) process.stderr.write(result.stderr);
	process.exit(result.code);
}
