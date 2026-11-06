/**
 * `substrate index archive|verify-archive|restore` (uplift-4 S2).
 *
 * Like `substrate ledger`, the work runs in
 * `packages/mcp-server/src/index-run.ts` from this checkout (or the pinned
 * release the CLI is installed in) with the operator's environment: the index
 * credentials are read only inside the server package, so this module never
 * imports the store and never names its variables. What it owns is the command
 * grammar — a wrong flag is refused here, before a process is spawned — and the
 * exit code, which is the runner's: 0 done, 1 failed, 2 usage, a refusal, a
 * verify mismatch or a restore aimed at production.
 */
import type { Args } from "./args.ts";

export const INDEX_ARCHIVE_USAGE =
	"usage: substrate index archive [--out DIR] [--page-size N] [--json]\n" +
	"       substrate index verify-archive <dir> [--json]\n" +
	"       substrate index restore --scratch <postgres-url> <dir> [--json]\n";

export const INDEX_ARCHIVE_SUBCOMMANDS = ["archive", "verify-archive", "restore"] as const;

/** The flags each subcommand takes, in the order the runner's argv carries them (`--json` last). */
const FLAGS: Record<(typeof INDEX_ARCHIVE_SUBCOMMANDS)[number], readonly string[]> = {
	archive: ["out", "page-size", "json"],
	"verify-archive": ["json"],
	restore: ["scratch", "json"],
};

/**
 * The runner's argv for `substrate index <argv>`, or `null` when the
 * subcommand or a flag is not one the runner takes, or a directory is missing
 * or given twice. Values pass through as given — the runner validates sizes
 * and refuses an empty `--out`, which is what systemd expands an unset
 * `SUBSTRATE_INDEX_ARCHIVE_DIR` to.
 */
export function indexArchiveRunnerArgs(argv: readonly string[], args: Args): string[] | null {
	const sub = argv[0];
	if (sub === undefined || !(INDEX_ARCHIVE_SUBCOMMANDS as readonly string[]).includes(sub)) return null;
	const allowed = FLAGS[sub as (typeof INDEX_ARCHIVE_SUBCOMMANDS)[number]];
	for (const key of Object.keys(args)) if (!allowed.includes(key)) return null;
	// The positional words: everything that is neither a flag nor the value of one (`--json` takes none).
	const positional: string[] = [];
	for (let i = 1; i < argv.length; i++) {
		const word = argv[i] ?? "";
		if (word.startsWith("--")) {
			const next = argv[i + 1];
			if (word !== "--json" && next !== undefined && !next.startsWith("--")) i++;
			continue;
		}
		positional.push(word);
	}
	const out: string[] = [sub];
	if (sub === "archive") {
		if (positional.length > 0) return null;
	} else {
		const dir = positional[0];
		if (dir === undefined || dir.length === 0 || positional.length > 1) return null;
		out.push(dir);
	}
	for (const key of allowed) {
		const value = args[key];
		if (value === undefined) continue;
		out.push(`--${key}`);
		// `--json` takes no value: the argument parser would hand it a following directory.
		if (value !== true && key !== "json") out.push(value);
	}
	return out;
}

interface IndexArchiveDeps {
	/** Run the runner with these arguments and return its exit status. */
	spawn: (runnerArgs: string[]) => number;
	err: (text: string) => void;
	/** The environment the runner would inherit: where `SUBSTRATE_INDEX_SCRATCH_URL` is looked for. Injected, never `process.env` read here. */
	env: Readonly<Record<string, string | undefined>>;
}

export function runIndexArchive(argv: readonly string[], args: Args, deps: IndexArchiveDeps): number {
	const runnerArgs = indexArchiveRunnerArgs(argv, args);
	// A restore needs a scratch database from `--scratch` or from the environment; with neither the runner would only refuse, so refuse before spawning.
	const scratchFromEnv = (deps.env.SUBSTRATE_INDEX_SCRATCH_URL ?? "").trim() !== "";
	if (runnerArgs === null || (runnerArgs[0] === "restore" && args.scratch === undefined && !scratchFromEnv)) {
		deps.err(INDEX_ARCHIVE_USAGE);
		return 2;
	}
	return deps.spawn(runnerArgs);
}
