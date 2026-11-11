/**
 * Argument parsing for `substrate worktree`.
 *
 * Its own parser because `--root` repeats (the shared `parseArgs` keeps only the last value) and
 * because every subcommand has a closed flag set: a misspelt flag must be refused before anything
 * is inspected, never ignored, since one of the subcommands deletes directories.
 */

export const SUBCOMMANDS = ["list", "status", "scan", "prune", "conflicts", "provision", "disk", "guard", "merge-back"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

const VALUE_FLAGS: ReadonlySet<string> = new Set(["root", "repo", "idle-days", "branch", "base", "path", "session"]);
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["json", "report", "execute", "keep-sessions"]);

const ALLOWED: Record<Subcommand, readonly string[]> = {
	list: ["root", "repo", "json"],
	status: ["root", "repo", "json"],
	scan: ["root", "report", "session", "keep-sessions", "json"],
	prune: ["root", "idle-days", "execute", "json"],
	conflicts: ["root", "repo", "json"],
	provision: ["repo", "branch", "base", "path", "json"],
	disk: ["root", "json"],
	guard: ["root", "json"],
	"merge-back": ["execute", "json"],
};

export interface WorktreeArgs {
	command: Subcommand;
	roots: string[];
	positional: string[];
	repo: string | undefined;
	idleDays: string | undefined;
	branch: string | undefined;
	base: string | undefined;
	path: string | undefined;
	session: string | undefined;
	json: boolean;
	report: boolean;
	/** `scan --report` only: keep the session the registry already holds for a worktree no claim or `--session` names. */
	keepSessions: boolean;
	execute: boolean;
}

export type ParseResult = { ok: true; args: WorktreeArgs } | { ok: false; error: string };

export function parseWorktreeArgs(argv: readonly string[]): ParseResult {
	const [first, ...rest] = argv;
	if (first === undefined) return { ok: false, error: "missing subcommand" };
	const command = SUBCOMMANDS.find((name) => name === first);
	if (command === undefined) return { ok: false, error: `unknown subcommand ${first}` };
	const args: WorktreeArgs = { command, roots: [], positional: [], repo: undefined, idleDays: undefined, branch: undefined, base: undefined, path: undefined, session: undefined, json: false, report: false, keepSessions: false, execute: false };
	for (let index = 0; index < rest.length; index++) {
		const token = rest[index];
		if (token === undefined) continue;
		if (!token.startsWith("--")) {
			if ((command !== "guard" && command !== "merge-back") || token === "") return { ok: false, error: `unexpected argument ${token}` };
			args.positional.push(token);
			continue;
		}
		const equals = token.indexOf("=");
		const name = token.slice(2, equals < 0 ? undefined : equals);
		if (!ALLOWED[command].includes(name)) return { ok: false, error: `${command} does not take --${name}` };
		if (BOOLEAN_FLAGS.has(name)) {
			if (equals >= 0) return { ok: false, error: `--${name} takes no value` };
			if (name === "json") args.json = true;
			else if (name === "report") args.report = true;
			else if (name === "keep-sessions") args.keepSessions = true;
			else args.execute = true;
			continue;
		}
		if (!VALUE_FLAGS.has(name)) return { ok: false, error: `unknown flag --${name}` };
		let value: string | undefined;
		if (equals >= 0) value = token.slice(equals + 1);
		else {
			value = rest[index + 1];
			index += 1;
		}
		if (value === undefined || value === "" || (equals < 0 && value.startsWith("--"))) return { ok: false, error: `--${name} needs a value` };
		if (name === "root") args.roots.push(value);
		else if (name === "repo") args.repo = value;
		else if (name === "idle-days") args.idleDays = value;
		else if (name === "branch") args.branch = value;
		else if (name === "base") args.base = value;
		else if (name === "session") args.session = value;
		else args.path = value;
	}
	return { ok: true, args };
}
