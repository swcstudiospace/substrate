/**
 * The cross-layer reconcile's operator entry (Phase 78, D78-6, D78-8): `report`, `plan` and `repair` over the live ledger,
 * index and cache. `scripts/reconcile.ts` is a thin wrapper around {@link reconcileMain}. This is the one place the feature
 * builds a store client: the store lock keeps ledger and index credentials inside `packages/mcp-server/src`.
 *
 *   reconcile [report]                          the live report as JSON; writes nothing
 *   reconcile plan --out <file>                 runs the report and writes one plan file, and nothing else
 *   reconcile repair --plan <file>              dry run: re-checks the plan and prints what it would do; writes nothing
 *   reconcile repair --plan <file> --execute --server-stopped    flushes the derived cache with the server stopped, then writes `<file>.result.json`; appends one audit record to the MCP audit chain, which must be durable
 *
 * Exit codes: 0 done (a clean report, a plan written, a dry run or an executed repair); 1 a report that is not clean, a
 * refused or unreadable plan, a failed repair, or a failure reading a layer; 2 usage, or configuration this run needs and does not have.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { AuditLog } from "@substrate/audit";
import { createReadThroughCache } from "./cache.ts";
import { loadConfig, type SubstrateConfig } from "./config.ts";
import { GreptimeClient } from "./greptime.ts";
import { IndexStore } from "./index-store.ts";
import type { IndexReader, LedgerReader } from "./reconcile-read.ts";
import { DEFAULT_RECONCILE_CAPS, type ReconcileDeps, runReport } from "./reconcile-run.ts";
import { executePlan, failedRepair, failureReason, planFromReport, type Plan, type RepairResult } from "./reconcile-repair.ts";
import type { Report } from "./reconcile.ts";
import { redact } from "./redact.ts";

/** The three layers a run reads, and the call that releases the index socket once the run is over. */
export interface ReconcileClients {
	ledger: LedgerReader;
	index: IndexReader;
	cache: Pick<ReconcileDeps["cache"], "scanKeys"> & { unlinkKeys(keys: readonly string[], onBatch?: (removed: number) => void): Promise<number> };
	close: () => Promise<void>;
}

/** Where a run writes and what it reads. `open` builds the clients; a test passes fakes. */
export interface ReconcileIo {
	out: (line: string) => void;
	err: (line: string) => void;
	now?: () => Date;
	env?: Record<string, string | undefined>;
	open?: (config: SubstrateConfig) => ReconcileClients;
	/** The MCP audit chain a repair execute records to. Built from `SUBSTRATE_AUDIT_PATH` unless a test passes one. */
	openAudit?: (config: SubstrateConfig) => AuditLog;
}

const USAGE =
	"usage: bun run reconcile -- [report] | plan --out <file> | repair --plan <file> [--execute] [--server-stopped]";

const PLAN_SCHEMA = "substrate.reconcile.plan.v1";

/** A bad command line. Its message is ours, never a value from the environment. */
class UsageError extends Error {}

type Command =
	| { command: "report" }
	| { command: "plan"; out: string }
	| { command: "repair"; plan: string; execute: boolean; serverStopped: boolean };

/** Split a subcommand's flags: `valued` take the next argument, `switches` stand alone. Any other token is a usage error. */
function flagsOf(rest: readonly string[], valued: readonly string[], switches: readonly string[]): Map<string, string | true> {
	const found = new Map<string, string | true>();
	for (let at = 0; at < rest.length; at += 1) {
		const flag = rest[at] ?? "";
		if (switches.includes(flag)) {
			found.set(flag, true);
		} else if (valued.includes(flag)) {
			const value = rest[at + 1];
			if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
			found.set(flag, value);
			at += 1;
		} else {
			throw new UsageError(`unknown argument: ${flag.startsWith("--") ? flag : "(positional)"}`);
		}
	}
	return found;
}

/** The subcommand and its flags. A leading `--`, which `bun run reconcile -- …` may pass through, is dropped. */
export function parseReconcileArgs(argv: readonly string[]): Command {
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	const sub = args[0];
	const rest = args.slice(1);
	if (sub === undefined || sub === "report") {
		flagsOf(rest, [], []);
		return { command: "report" };
	}
	if (sub === "plan") {
		const out = flagsOf(rest, ["--out"], []).get("--out");
		if (typeof out !== "string") throw new UsageError("plan needs --out <file>");
		return { command: "plan", out };
	}
	if (sub === "repair") {
		const found = flagsOf(rest, ["--plan"], ["--execute", "--server-stopped"]);
		const plan = found.get("--plan");
		if (typeof plan !== "string") throw new UsageError("repair needs --plan <file>");
		const execute = found.get("--execute") === true;
		const serverStopped = found.get("--server-stopped") === true;
		// A flush removes keys from a cache a live server may be writing, so it runs only with the server stopped.
		if (execute && !serverStopped) throw new UsageError("reconcile: --execute needs --server-stopped");
		return { command: "repair", plan, execute, serverStopped };
	}
	throw new UsageError(`unknown subcommand: ${sub.startsWith("--") ? sub : "(positional)"}`);
}

/** What this run needs from configuration and does not have, or null when it has all of it. */
export function missingConfig(config: SubstrateConfig): string | null {
	if (config.postgresUrl === undefined) return "SUBSTRATE_PG_URL is not set; the reconcile reads the index";
	if (config.greptime === null) return "GREPTIME_URL is not set; the reconcile reads the ledger";
	// A cache that is off scans nothing, so a report over it is incomplete and must not read clean; this check also makes the
	// CLI refuse before it reads when the cache is not enabled.
	if (!config.cacheEnabled) return "the cache is off (DRAGONFLY_URL is unset, refused, or SUBSTRATE_CACHE=0); the reconcile needs it to read";
	return null;
}

/** The server's own constructors, with the pool bounds the index archive job uses: the reconcile is a short read. */
export function openReconcileClients(config: SubstrateConfig): ReconcileClients {
	const postgresUrl = config.postgresUrl;
	const greptime = config.greptime;
	if (postgresUrl === undefined || greptime === null) throw new Error("the reconcile clients need SUBSTRATE_PG_URL and GREPTIME_URL");
	const index = new IndexStore(postgresUrl, { pool: { max: 2, statementTimeoutMs: 60_000 } });
	const ledger = new GreptimeClient(greptime, { ledger: config.ledger });
	const cache = createReadThroughCache(config);
	return {
		ledger,
		index,
		cache,
		close: () => index.close({ timeout: 1 }).then(
			() => undefined,
			() => undefined,
		),
	};
}

/** The MCP audit chain, the same file the server writes. A repair execute appends its one record here. */
export function openRepairAudit(config: SubstrateConfig): AuditLog {
	return new AuditLog({ path: config.audit.path, redact });
}

/** A plan file as this unit wrote it. Anything else is refused, never guessed at. */
function parsePlan(text: string): Plan {
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null) throw new Error("not a plan record");
	const plan = value as Plan;
	if (plan.schema !== PLAN_SCHEMA || typeof plan.report_digest !== "string" || !Array.isArray(plan.items)) {
		throw new Error(`not a ${PLAN_SCHEMA} record`);
	}
	return plan;
}

/**
 * The one audit record a repair execute writes: `denied` when the plan was refused, `allowed` when the flush was let run. It
 * names the counts and the outcome, the plan's digest (the sha256 of the plan file) and the report's. It is written after the
 * flush, because it carries the outcome; the chain was checked durable before the flush began. Returns why the record was not
 * written, or null when it was.
 */
async function recordRepair(audit: AuditLog, result: RepairResult, planDigest: string, reportDigest: string): Promise<string | null> {
	const outcome = result.refused ? "refused" : result.error !== undefined ? "failed" : result.truncated ? "truncated" : "executed";
	try {
		const appended = await audit.append({
			surface: "operator",
			tool: "reconcile_repair",
			transport: "internal",
			decision: result.refused ? "denied" : "allowed",
			mode: "fail-closed",
			reason: `outcome=${outcome} planned=${result.planned} removed=${result.removed} remaining=${result.remaining} limit=${result.limit} plan_digest=${planDigest} report_digest=${reportDigest}`,
		});
		return appended.written ? null : (appended.error ?? "the chain did not take the record");
	} catch (cause) {
		return failureReason(cause);
	}
}

/**
 * Run one subcommand. Returns the exit code. `report` and the dry run write nothing; `plan` writes only its `--out` file
 * (it refuses to overwrite one); `repair --execute` flushes and then writes `<plan>.result.json`.
 */
export async function reconcileMain(argv: readonly string[], io: ReconcileIo): Promise<number> {
	const env = io.env ?? process.env;
	const now = io.now ?? (() => new Date());

	let command: Command;
	try {
		command = parseReconcileArgs(argv);
	} catch (cause) {
		io.err(`${failureReason(cause)}\n${USAGE}`);
		return 2;
	}

	let config: SubstrateConfig;
	try {
		config = loadConfig(env);
	} catch (cause) {
		io.err(`reconcile: ${failureReason(cause)}`);
		return 2;
	}
	const missing = missingConfig(config);
	if (missing !== null) {
		io.err(`reconcile: ${missing}`);
		return 2;
	}
	// A repair writes one record to the MCP audit chain, so it runs only on a durable chain: a flush that cannot be recorded is
	// not started. Checked before any store client opens.
	let audit: AuditLog | null = null;
	if (command.command === "repair" && command.execute) {
		audit = (io.openAudit ?? openRepairAudit)(config);
		const opened = await audit.open();
		if (!opened.durable) {
			const why = opened.error === undefined ? "SUBSTRATE_AUDIT_PATH is unset" : failureReason(opened.error);
			io.err(`reconcile: the repair records to the MCP audit chain, which is not durable (${why}); nothing was flushed`);
			return 2;
		}
	}

	let clients: ReconcileClients | null = null;
	try {
		clients = (io.open ?? openReconcileClients)(config);
		const deps: ReconcileDeps & { cache: ReconcileClients["cache"] } = {
			ledger: clients.ledger,
			index: clients.index,
			cache: clients.cache,
			now: now(),
			windowHours: config.reconcile.windowHours,
			caps: DEFAULT_RECONCILE_CAPS,
		};

		if (command.command === "report") {
			const report: Report = await runReport(deps);
			io.out(JSON.stringify(report, null, 2));
			return report.clean ? 0 : 1;
		}

		if (command.command === "plan") {
			const report = await runReport(deps);
			const plan = planFromReport(report, now());
			await writeFile(command.out, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
			io.out(`plan written to ${command.out}: ${plan.items.length} item(s) from ${report.findings.length} finding(s)`);
			return 0;
		}

		let plan: Plan;
		let planText: string;
		try {
			planText = await readFile(command.plan, "utf8");
			plan = parsePlan(planText);
		} catch (cause) {
			io.err(`refused: the plan file cannot be read as a ${PLAN_SCHEMA} record: ${failureReason(cause)}`);
			return 1;
		}
		let result: RepairResult;
		try {
			result = await executePlan(plan, deps, { execute: command.execute, serverStopped: command.serverStopped });
		} catch (cause) {
			// Only the re-run report throws before the flush; the flush reports its own failure in the result. An execute still
			// records the failure below. A dry run is an ordinary error.
			if (!command.execute) throw cause;
			result = failedRepair(failureReason(cause));
		}
		// One audit record per execute, after the flush because it carries the outcome. A failure to write it is reported below.
		const auditFailure =
			audit === null ? null : await recordRepair(audit, result, createHash("sha256").update(planText).digest("hex"), plan.report_digest);
		try {
			io.out(JSON.stringify(result, null, 2));
		} finally {
			if (command.execute) {
				// Written after the flush, whether or not the plan was refused or failed, so every outcome of an execute is on
				// record. It overwrites: an earlier record must not block the one that follows a flush.
				await writeFile(`${command.plan}.result.json`, `${JSON.stringify({ result, recorded_at: now().toISOString() }, null, 2)}\n`);
			}
		}
		if (auditFailure !== null) {
			io.err(`reconcile: the repair ran, but its audit record was not written: ${auditFailure}`);
			return 1;
		}
		if (result.refused || result.error !== undefined) {
			io.err(result.reason);
			return 1;
		}
		return 0;
	} catch (cause) {
		io.err(`reconcile failed: ${failureReason(cause)}`);
		return 1;
	} finally {
		await clients?.close();
	}
}
