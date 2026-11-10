/**
 * `substrate ledger coverage|archive|verify-archive` (uplift-3 N6).
 *
 * Like `substrate index sweep`, the work runs in
 * `packages/mcp-server/src/ledger-run.ts` from this checkout (or the pinned
 * release the CLI is installed in) with the operator's environment: the ledger
 * credentials are read only inside the server package, so this module never
 * imports the ledger client and never names its variables. What it owns is the
 * command grammar — a wrong flag is refused here, before a process is spawned —
 * and the exit code, which is the runner's: 0 done, 1 failed, 2 usage, a
 * refusal, an uncovered-hours breach or a verify mismatch.
 */
import type { Args } from "./args.ts";

export const LEDGER_USAGE =
	"usage: substrate ledger coverage [--json]\n" +
	"       substrate ledger archive [--until YYYY-MM-DD] [--out DIR] [--page-size N] [--json]\n" +
	"       substrate ledger verify-archive <dir> [--day YYYY-MM-DD] [--json]\n" +
	"       (a per-statement budget override can raise this for a slow store; see docs/config-reference.md, default 5000)\n";

const SUBCOMMANDS = ["coverage", "archive", "verify-archive"] as const;
const FLAGS: Record<(typeof SUBCOMMANDS)[number], readonly string[]> = {
	coverage: ["json"],
	archive: ["json", "until", "out", "page-size"],
	"verify-archive": ["json", "day"],
};

/**
 * The runner's argv for `substrate ledger <argv>`, or `null` when the
 * subcommand or a flag is not one the runner takes. Values pass through as
 * given — the runner validates days and sizes and refuses an empty `--out`,
 * which is what systemd expands an unset `SUBSTRATE_LEDGER_ARCHIVE_DIR` to.
 */
export function ledgerRunnerArgs(argv: readonly string[], args: Args): string[] | null {
	const sub = argv[0];
	if (sub === undefined || !(SUBCOMMANDS as readonly string[]).includes(sub)) return null;
	const allowed = FLAGS[sub as (typeof SUBCOMMANDS)[number]];
	for (const key of Object.keys(args)) if (!allowed.includes(key)) return null;
	const out: string[] = [sub];
	if (sub === "verify-archive") {
		const dir = argv[1];
		if (dir === undefined || dir.startsWith("--")) return null;
		out.push(dir);
	}
	for (const key of allowed) {
		const value = args[key];
		if (value === undefined) continue;
		out.push(`--${key}`);
		if (value !== true) out.push(value);
	}
	return out;
}

export interface LedgerDeps {
	/** Run the runner with these arguments and return its exit status. */
	spawn: (runnerArgs: string[]) => number;
	err: (text: string) => void;
}

export function runLedger(argv: readonly string[], args: Args, deps: LedgerDeps): number {
	const runnerArgs = ledgerRunnerArgs(argv, args);
	if (runnerArgs === null) {
		deps.err(LEDGER_USAGE);
		return 2;
	}
	return deps.spawn(runnerArgs);
}
