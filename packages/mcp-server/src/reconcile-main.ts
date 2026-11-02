/**
 * The cross-layer reconcile's operator entry (Phase 78, D78-6, D78-8): `report`, `plan` and `repair` over the live ledger,
 * index and cache. `scripts/reconcile.ts` is a thin wrapper around {@link reconcileMain}. This is the one place the feature
 * builds a store client: the store lock keeps ledger and index credentials inside `packages/mcp-server/src`.
 *
 *   reconcile [report]                          the live report as JSON; writes nothing
 *   reconcile plan --out <file>                 runs the report and writes one plan file, and nothing else
 *   reconcile repair --plan <file>              dry run: re-checks the plan and prints what it would do; writes nothing
 *   reconcile repair --plan <file> --execute    flushes the derived cache, then writes `<file>.result.json`
 *
 * Exit codes: 0 done (a clean report, a plan written, a dry run or an executed repair); 1 a report that is not clean, a
 * refused or unreadable plan, or a failure reading a layer; 2 usage, or configuration this run needs and does not have.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createReadThroughCache } from "./cache.ts";
import { loadConfig, type SubstrateConfig } from "./config.ts";
import { GreptimeClient } from "./greptime.ts";
import { IndexStore } from "./index-store.ts";
import type { IndexReader, LedgerReader } from "./reconcile-read.ts";
import { DEFAULT_RECONCILE_CAPS, type ReconcileDeps, runReport } from "./reconcile-run.ts";
import { executePlan, planFromReport, type Plan, type RepairResult } from "./reconcile-repair.ts";
import { redact } from "./redact.ts";
import type { Report } from "./reconcile.ts";

/** The three layers a run reads, and the call that releases the index socket once the run is over. */
export interface ReconcileClients {
	ledger: LedgerReader;
	index: IndexReader;
	cache: Pick<ReconcileDeps["cache"], "scanKeys"> & { unlinkKeys(keys: readonly string[]): Promise<number> };
	close: () => Promise<void>;
}

/** Where a run writes and what it reads. `open` builds the clients; a test passes fakes. */
export interface ReconcileIo {
	out: (line: string) => void;
	err: (line: string) => void;
	now?: () => Date;
	env?: Record<string, string | undefined>;
	open?: (config: SubstrateConfig) => ReconcileClients;
}

const USAGE =
	"usage: bun run reconcile -- [report] | plan --out <file> | repair --plan <file> [--execute]";

const PLAN_SCHEMA = "substrate.reconcile.plan.v1";

/** A bad command line. Its message is ours, never a value from the environment. */
class UsageError extends Error {}

type Command = { command: "report" } | { command: "plan"; out: string } | { command: "repair"; plan: string; execute: boolean };

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
		const found = flagsOf(rest, ["--plan"], ["--execute"]);
		const plan = found.get("--plan");
		if (typeof plan !== "string") throw new UsageError("repair needs --plan <file>");
		return { command: "repair", plan, execute: found.get("--execute") === true };
	}
	throw new UsageError(`unknown subcommand: ${sub.startsWith("--") ? sub : "(positional)"}`);
}

/** A message that names no URL: a connection error can quote the one it was given, password and all. */
function reasonOf(cause: unknown): string {
	const text = String(cause instanceof Error ? cause.message : cause);
	return redact(text)
		.replace(/\b(?:redis|rediss|postgres|postgresql|https?):\/\/\S+/gi, "<url>")
		.slice(0, 300);
}

/** What this run needs from configuration and does not have, or null when it has all of it. */
export function missingConfig(config: SubstrateConfig): string | null {
	if (config.postgresUrl === undefined) return "SUBSTRATE_PG_URL is not set; the reconcile reads the index";
	if (config.greptime === null) return "GREPTIME_URL is not set; the reconcile reads the ledger";
	// A cache that is off scans nothing, so the report would read clean for the wrong reason.
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
		io.err(`${reasonOf(cause)}\n${USAGE}`);
		return 2;
	}

	let config: SubstrateConfig;
	try {
		config = loadConfig(env);
	} catch (cause) {
		io.err(`reconcile: ${reasonOf(cause)}`);
		return 2;
	}
	const missing = missingConfig(config);
	if (missing !== null) {
		io.err(`reconcile: ${missing}`);
		return 2;
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
		try {
			plan = parsePlan(await readFile(command.plan, "utf8"));
		} catch (cause) {
			io.err(`refused: the plan file cannot be read as a ${PLAN_SCHEMA} record: ${reasonOf(cause)}`);
			return 1;
		}
		const result: RepairResult = await executePlan(plan, deps, { execute: command.execute });
		io.out(JSON.stringify(result, null, 2));
		if (command.execute) {
			// Written after the flush, whether or not the plan was refused, so a refusal is on record too. It overwrites: an
			// earlier record must not block the one that follows a flush.
			await writeFile(`${command.plan}.result.json`, `${JSON.stringify({ result, recorded_at: now().toISOString() }, null, 2)}\n`);
		}
		if (result.refused) {
			io.err(result.reason);
			return 1;
		}
		return 0;
	} catch (cause) {
		io.err(`reconcile failed: ${reasonOf(cause)}`);
		return 1;
	} finally {
		await clients?.close();
	}
}
