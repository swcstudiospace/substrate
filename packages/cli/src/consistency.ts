/**
 * `substrate consistency verify [--json] [--bank B] [--limit N] [--since ISO] [--repair --server-stopped] [--repair-orphans]`
 * (v1.6, phase 57).
 *
 * Like `substrate ledger`, the work runs in `packages/mcp-server/src/consistency-run.ts` from this checkout (or
 * the pinned release the CLI is installed in) with the operator's environment: the index, plane and ledger
 * credentials are read only inside the server package, so this module never imports a store client and never
 * names a credential variable. What it owns is the command grammar: a wrong flag, a doubled flag, a missing
 * value or a positional argument is refused here, before a process is spawned. The exit code is the runner's:
 * 0 consistent, 1 drift found, 2 usage or a refusal, 3 a store was unreachable or a check could not run, so
 * `ok` cannot be claimed.
 *
 * The grammar is the runner's own (`parseConsistencyArgs`) and is strict on purpose: a value flag takes its
 * value as the NEXT word (never `--bank=B`), a boolean flag takes none, and `--repair-orphans` and `--server-stopped` need
 * `--repair` (which in turn needs `--server-stopped`: the runner refuses it otherwise). Ranges (the `--limit` ceiling, whether `--bank` carries the configured prefix) are the runner's to
 * judge, because they depend on its configuration; the shapes are checked here.
 */

export const CONSISTENCY_USAGE =
	"usage: substrate consistency verify [--json] [--bank B] [--limit N] [--since ISO] [--repair --server-stopped [--repair-orphans]]\n" +
	"  --json            print the report as JSON\n" +
	"  --bank B          one bank only\n" +
	"  --limit N         examine at most N entries, newest first\n" +
	"  --since ISO       only entries created at or after this instant, e.g. 2026-10-01T00:00:00Z\n" +
	"  --repair          carry out the safe repairs (re-retain a missing document, delete a forgotten entry's document)\n" +
	"  --server-stopped  required by --repair: you assert substrate-mcp and every writer are stopped (the runner refuses --repair without it)\n" +
	"  --repair-orphans  with --repair: also delete plane documents nothing in force owns\n" +
	"exit: 0 consistent, 1 drift found, 2 usage or a refusal, 3 a store was unreachable or a check could not run\n";

const BOOLEAN_FLAGS = ["json", "repair", "repair-orphans", "server-stopped"] as const;
const VALUE_FLAGS = ["bank", "limit", "since"] as const;
/** The runner's own shapes, checked here so a malformed value never costs a process. */
const BANK_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const LIMIT = /^[1-9]\d{0,9}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const VALUE_SHAPE: Record<(typeof VALUE_FLAGS)[number], RegExp> = { bank: BANK_NAME, limit: LIMIT, since: ISO_INSTANT };

/**
 * The runner's argv for `substrate consistency <argv>`, or `null` when the grammar is not the runner's. `argv` is
 * everything after `consistency`: the subcommand `verify`, then the flags as typed. The flags are forwarded in
 * the order given.
 */
export function consistencyRunnerArgs(argv: readonly string[]): string[] | null {
	if (argv[0] !== "verify") return null;
	const out: string[] = [];
	const seen = new Set<string>();
	for (let i = 1; i < argv.length; i++) {
		const word = argv[i] ?? "";
		if (!word.startsWith("--")) return null;
		const name = word.slice(2);
		if (seen.has(name)) return null;
		if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
			seen.add(name);
			out.push(word);
			continue;
		}
		if ((VALUE_FLAGS as readonly string[]).includes(name)) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) return null;
			if (!VALUE_SHAPE[name as (typeof VALUE_FLAGS)[number]].test(value)) return null;
			seen.add(name);
			out.push(word, value);
			i += 1;
			continue;
		}
		return null;
	}
	if (seen.has("repair-orphans") && !seen.has("repair")) return null;
	if (seen.has("server-stopped") && !seen.has("repair")) return null;
	return out;
}

interface ConsistencyDeps {
	/** Run the runner with these arguments and return its exit status; any status outside 0..3 (a signal, a crash) is reported as 3. */
	spawn: (runnerArgs: string[]) => number;
	err: (text: string) => void;
}

export function runConsistency(argv: readonly string[], deps: ConsistencyDeps): number {
	const runnerArgs = consistencyRunnerArgs(argv);
	if (runnerArgs === null) {
		deps.err(CONSISTENCY_USAGE);
		return 2;
	}
	const status = deps.spawn(runnerArgs);
	if (status === 0 || status === 1 || status === 2 || status === 3) return status;
	// A runner that was killed or crashed verified nothing. Exit 1 would claim drift and 0 consistency, so this is the
	// "could not verify" code.
	deps.err(`the consistency runner ended abnormally (status ${status}); nothing was verified\n`);
	return 3;
}
