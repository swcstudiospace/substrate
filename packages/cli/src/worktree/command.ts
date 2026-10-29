/**
 * `substrate worktree list|status|scan|prune|conflicts|provision|disk` (phase 68).
 *
 * The fleet library does the work (`packages/fleet`); this module owns the grammar, the output and the
 * exit codes: 0 done, 1 failed (a removal, a report or a creation did not happen), 2 usage or no
 * worktree root configured. Roots come from `--root` or `SUBSTRATE_WORKTREE_ROOTS`; nothing is assumed.
 *
 * `scan --report` attributes worktrees to sessions from two sources: the server's live claims (one holder
 * session across every live claim of a graph worktree) and `--session ID` / `SUBSTRATE_SESSION_ID`, which names
 * the session that owns the worktree holding the current directory and wins over a claim for that worktree.
 *
 * `prune` is a dry run until `--execute`. With it, only worktrees classified `safe` are removed, each
 * with a plain `git worktree remove` (never `--force`), after the worktree's identity (head, branch) is
 * reloaded from git, it is inspected and classified again, and the server is asked once more for live graph
 * claims on it; the first failed removal stops the run and is reported, not retried. A worktree whose
 * directory under a root is a graph id is `never` while the server reports a live claim on that graph and
 * `review` when that cannot be checked. Every removal leaves one ledger note through the events route
 * (fail-open: a note that was not recorded is said so on stderr, and `--json` carries its delivery result).
 */
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { graphIdForWorktree } from "../../../collectors/src/worktree-graph.ts";
import { SESSION_ID_PATTERN } from "../steer/client.ts";
import {
	assertDiskFloor,
	buildReports,
	CLAIM_CONCURRENCY,
	claimedSessions,
	classifyForPrune,
	type ClaimsFn,
	type ClaimStatus,
	claimStatus,
	collectInventory,
	type CommandRunner,
	type ConflictForecast,
	createPrShared,
	DiskFloorError,
	diskPressure,
	exclusiveBytes,
	forecastConflicts,
	type FreeBytesFn,
	type GitRunner,
	gitOut,
	idleDaysFromEnv,
	inspectWorktree,
	mapLimit,
	measureTree,
	minFreeGbFromEnv,
	NOT_CHECKED,
	parseClaimsBody,
	type PruneClass,
	type PruneClassification,
	type PruneContext,
	reloadWorktree,
	resolveDefaultRef,
	sessionIdFromEnv,
	type TreeLinks,
	type WorktreeInfo,
	type WorktreeReport,
	worktreeRootsFromEnv,
} from "../../../fleet/src/index.ts";
import type { EventInput } from "../../../mcp-server/src/types.ts";
import type { EmitOutcome } from "../../../collectors/src/emit.ts";
import { parseWorktreeArgs, type WorktreeArgs } from "./args.ts";

export const WORKTREE_USAGE =
	"usage: substrate worktree list|status [--root DIR]... [--repo R] [--json]\n" +
	"       substrate worktree scan [--root DIR]... [--report [--session ID]] [--json]\n" +
	"       substrate worktree prune [--root DIR]... [--idle-days N] [--execute] [--json]\n" +
	"       substrate worktree conflicts [--repo R | --root DIR...] [--json]\n" +
	"       substrate worktree provision --repo DIR --branch B [--base REF] [--path DIR] [--json]\n" +
	"       substrate worktree disk [--root DIR]... [--json]\n";

export type PostOutcome = { ok: true; stored: number } | { ok: false; error: string };

export interface WorktreeDeps {
	env: Record<string, string | undefined>;
	cwd: string;
	host: string;
	out: (text: string) => void;
	err: (text: string) => void;
	git: GitRunner;
	gh: CommandRunner;
	now: () => Date;
	freeBytes: FreeBytesFn;
	/** The CLI's event path; never throws. */
	emit: (event: EventInput) => Promise<EmitOutcome>;
	/** `POST /worktrees/report`. */
	postReport: (report: WorktreeReport) => Promise<PostOutcome>;
	/** `GET /worktrees/claims`: the live claims of one graph. Never throws; an unanswered question is a failure, not "no claims". */
	claims: ClaimsFn;
}

const GIB = 1024 ** 3;
const NO_ROOT = "no worktree root is configured: set SUBSTRATE_WORKTREE_ROOTS (colon separated) or pass --root DIR\n";
const CLASS_ORDER: readonly PruneClass[] = ["safe", "review", "never"];
/** Link walks (for the freed-space estimate) in flight at once. */
const LINK_WALK_CONCURRENCY = 2;

function roots(args: WorktreeArgs, deps: WorktreeDeps): string[] {
	if (args.roots.length > 0) return [...new Set(args.roots.map((root) => resolve(deps.cwd, root)))];
	return worktreeRootsFromEnv(deps.env);
}

function megabytes(bytes: number | null): string {
	return bytes === null ? "?" : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function gigabytes(bytes: number): string {
	return `${(bytes / GIB).toFixed(1)} GB`;
}

/** `--repo R` names a repository as `owner/name` or by the directory of its primary checkout. */
function matchesRepo(info: WorktreeInfo, filter: string | undefined, cwd: string): boolean {
	if (filter === undefined) return true;
	return info.repo === filter || sameDirectory(resolve(cwd, filter), info.repo_dir);
}

function idleDays(args: WorktreeArgs, deps: WorktreeDeps): number | null {
	if (args.idleDays === undefined) return idleDaysFromEnv(deps.env);
	const value = Number(args.idleDays);
	return Number.isFinite(value) && value >= 0 ? value : null;
}

interface Classified {
	info: WorktreeInfo;
	prune: PruneClassification;
	/** What the server said about live claims; `not-checked` unless the worktree was otherwise safe and is a graph checkout. */
	claim: ClaimStatus;
}

function pruneContext(days: number, deps: WorktreeDeps): PruneContext {
	return { cwd: deps.cwd, idleDays: days, now: deps.now() };
}

/**
 * Classify every worktree, then ask the server about live claims for the ones that would otherwise be safe and
 * sit at `<root>/<graph_id>`: the others are `never` or `review` already, or have no claim to ask about. A claim
 * that is live makes the worktree `never`; one that could not be checked makes it `review`.
 */
async function classifyAll(worktrees: readonly WorktreeInfo[], days: number, rootList: readonly string[], deps: WorktreeDeps): Promise<Classified[]> {
	return mapLimit(worktrees, CLAIM_CONCURRENCY, async (info): Promise<Classified> => {
		const prune = classifyForPrune(info, pruneContext(days, deps));
		const graphId = prune.class === "safe" ? graphIdForWorktree(info.path, rootList) : null;
		if (graphId === null) return { info, prune, claim: NOT_CHECKED };
		const claim = await claimStatus(graphId, deps.claims);
		return { info, prune: classifyForPrune(info, pruneContext(days, deps), claim), claim };
	});
}

function describe(info: WorktreeInfo): string {
	const parts = [info.branch ?? `(detached ${info.head.slice(0, 8)})`];
	if (info.dirty) parts.push("dirty");
	if (info.ahead !== null && info.behind !== null) parts.push(`+${info.ahead}/-${info.behind}`);
	parts.push(megabytes(info.size_bytes));
	if (info.pr_state !== "none" && info.pr_state !== "unknown") parts.push(`pr:${info.pr_state}`);
	return parts.join(" ");
}

async function gather(args: WorktreeArgs, deps: WorktreeDeps, rootList: string[], options: { pr: boolean; measure: boolean; ignored: boolean; files?: boolean }): Promise<{ worktrees: WorktreeInfo[]; notes: string[]; repos: number }> {
	const inventory = await collectInventory(rootList, {
		git: deps.git,
		measure: options.measure,
		ignored: options.ignored,
		...(options.files === true ? { files: true } : {}),
		...(options.pr ? { pr: createPrShared(deps.gh) } : {}),
	});
	return { worktrees: inventory.worktrees.filter((info) => matchesRepo(info, args.repo, deps.cwd)), notes: inventory.notes, repos: inventory.repos.length };
}

function printNotes(notes: readonly string[], deps: WorktreeDeps): void {
	for (const note of notes) deps.err(`note: ${note}\n`);
}

// ── list / status ───────────────────────────────────────────────────────────

async function commandList(args: WorktreeArgs, deps: WorktreeDeps): Promise<number> {
	const rootList = roots(args, deps);
	if (rootList.length === 0) return usageError(deps, NO_ROOT);
	const days = idleDays(args, deps);
	if (days === null) return usageError(deps, "--idle-days must be a number of days, zero or more\n");
	const inventory = await gather(args, deps, rootList, { pr: true, measure: true, ignored: true });
	const classified = await classifyAll(inventory.worktrees, days, rootList, deps);
	printNotes(inventory.notes, deps);
	if (args.json) {
		deps.out(`${JSON.stringify(classified.map(({ info, prune, claim }) => ({ ...info, prune, claims: claim })), null, 2)}\n`);
		return 0;
	}
	if (classified.length === 0) deps.out("no worktrees found\n");
	for (const { info, prune } of classified) deps.out(`${prune.class.padEnd(6)} ${info.repo}  ${info.path}  ${describe(info)}\n`);
	return 0;
}

// ── scan ────────────────────────────────────────────────────────────────────

/** Why `--session` (or `SUBSTRATE_SESSION_ID`) is refused: the grammar is the server's, so a bad id could never match a brief. */
const SESSION_ID_HELP = "a session id (letters, digits, . _ : -; at most 128 characters)";

type SessionChoice = { ok: true; id: string | null } | { ok: false; message: string };

/** The session this scan attributes its own worktree to: `--session`, else `SUBSTRATE_SESSION_ID`; only a report carries one. */
function scanSession(args: WorktreeArgs, deps: WorktreeDeps): SessionChoice {
	if (!args.report) {
		return args.session === undefined ? { ok: true, id: null } : { ok: false, message: "--session attributes a report: use it with --report\n" };
	}
	if (args.session !== undefined) {
		return SESSION_ID_PATTERN.test(args.session) ? { ok: true, id: args.session } : { ok: false, message: `--session must be ${SESSION_ID_HELP}\n` };
	}
	const fromEnv = sessionIdFromEnv(deps.env);
	if (fromEnv === null) return { ok: true, id: null };
	return SESSION_ID_PATTERN.test(fromEnv) ? { ok: true, id: fromEnv } : { ok: false, message: `SUBSTRATE_SESSION_ID must be ${SESSION_ID_HELP}\n` };
}

/** The path of the worktree that holds `cwd`: the entry whose real path is the deepest prefix of the real path of `cwd`. */
function containingWorktree(worktrees: readonly WorktreeInfo[], cwd: string): string | null {
	const here = realPath(cwd);
	let best: { path: string; length: number } | null = null;
	for (const info of worktrees) {
		const real = realPath(info.path);
		const inside = here === real || here.startsWith(real.endsWith(sep) ? real : `${real}${sep}`);
		if (inside && (best === null || real.length > best.length)) best = { path: info.path, length: real.length };
	}
	return best === null ? null : best.path;
}

async function commandScan(args: WorktreeArgs, deps: WorktreeDeps): Promise<number> {
	const session = scanSession(args, deps);
	if (!session.ok) return usageError(deps, session.message);
	const rootList = roots(args, deps);
	if (rootList.length === 0) return usageError(deps, NO_ROOT);
	// The changed-file lists are for the registry only, so a scan that does not report skips their two git calls per worktree.
	const inventory = await gather(args, deps, rootList, { pr: true, measure: true, ignored: false, files: args.report });
	printNotes(inventory.notes, deps);
	let stored = 0;
	let attributed = 0;
	let failure: string | null = null;
	let skipped: Array<{ path: string; reason: string }> = [];
	if (args.report) {
		// The server's live claims first, then the session this scan runs in: an explicit id beats a claim-derived one for its worktree.
		const sessions = await claimedSessions(inventory.worktrees, rootList, deps.claims);
		if (session.id !== null) {
			const own = containingWorktree(inventory.worktrees, deps.cwd);
			if (own === null) deps.err(`warning: the current directory is inside none of the scanned worktrees, so session ${session.id} is attributed to no worktree\n`);
			else sessions.set(own, session.id);
		}
		attributed = sessions.size;
		const plan = buildReports(deps.host, inventory.worktrees, { now: deps.now(), roots: rootList, sessions });
		skipped = plan.skipped;
		for (const report of plan.reports) {
			const outcome = await deps.postReport(report);
			if (outcome.ok) stored += outcome.stored;
			else {
				failure = outcome.error;
				break;
			}
		}
	}
	// A row too large for any body is left out of the report and named, so the rest of the fleet still gets reported.
	for (const item of skipped) deps.err(`not reported: ${item.path}: ${item.reason}\n`);
	if (args.json) {
		deps.out(`${JSON.stringify({ repositories: inventory.repos, worktrees: inventory.worktrees.length, ...(args.report ? { reported: failure === null && skipped.length === 0, stored, attributed, skipped } : {}) })}\n`);
	} else {
		deps.out(`scanned ${inventory.worktrees.length} worktrees in ${inventory.repos} repositories\n`);
		if (args.report && failure === null) deps.out(`reported to the registry: ${stored} stored${skipped.length > 0 ? `, ${skipped.length} not reported` : ""}${attributed > 0 ? `, ${attributed} attributed to a session` : ""}\n`);
	}
	if (failure !== null) {
		deps.err(`report failed: ${failure}\n`);
		return 1;
	}
	return 0;
}

// ── prune ───────────────────────────────────────────────────────────────────

function emitNote(info: WorktreeInfo, reasons: readonly string[]): EventInput {
	return {
		surface: "claude-code",
		kind: "note",
		summary: `worktree removed: ${info.repo} ${info.branch ?? info.head.slice(0, 12)}`,
		...(info.repo.startsWith("local/") ? {} : { repo: info.repo }),
		...(info.branch === null ? {} : { branch: info.branch }),
		payload: { action: "worktree.prune", path: info.path, head: info.head, size_bytes: info.size_bytes, class: "safe", reasons: [...reasons] },
	};
}

function ledgerLine(outcome: EmitOutcome): string {
	if (outcome.kind === "stored") return "ledger: worktree.prune note recorded";
	const why = outcome.kind === "refused" ? `refused (HTTP ${outcome.status})` : `failed (${outcome.error ?? "no answer"})${outcome.spooled === true ? ", parked in the event spool" : ""}`;
	return `ledger: worktree.prune note NOT RECORDED: ${why}. The worktree is already removed.`;
}

/** How a ledger note was delivered. `spooled` means parked for replay: the note is not recorded yet. */
type LedgerResult = "stored" | "refused" | "failed" | "spooled";

function ledgerResult(outcome: EmitOutcome): LedgerResult {
	if (outcome.kind === "stored" || outcome.kind === "refused") return outcome.kind;
	return outcome.spooled === true ? "spooled" : "failed";
}

/** The size walks of `paths` with the link tables the freed-space estimate needs; a tree that could not be walked has no entry. */
async function linkTables(paths: readonly string[]): Promise<Map<string, TreeLinks>> {
	const walked = await mapLimit(paths, LINK_WALK_CONCURRENCY, async (path) => ({ path, links: (await measureTree(path, { links: true })).links }));
	const tables = new Map<string, TreeLinks>();
	for (const { path, links } of walked) {
		if (links !== null) tables.set(path, links);
	}
	return tables;
}

async function commandPrune(args: WorktreeArgs, deps: WorktreeDeps): Promise<number> {
	const rootList = roots(args, deps);
	if (rootList.length === 0) return usageError(deps, NO_ROOT);
	const days = idleDays(args, deps);
	if (days === null) return usageError(deps, "--idle-days must be a number of days, zero or more\n");
	const inventory = await gather(args, deps, rootList, { pr: true, measure: true, ignored: true });
	printNotes(inventory.notes, deps);
	const classified = await classifyAll(inventory.worktrees, days, rootList, deps);
	const safe = classified.filter((item) => item.prune.class === "safe");
	// Removal frees an inode only when every link to it is inside what is removed (see `exclusiveBytes`), so the
	// estimate is a lower bound: a worktree that shares a hardlinked cache with something that stays frees less.
	const tables = await linkTables(safe.map((item) => item.info.path));
	if (tables.size < safe.length) deps.err(`note: ${safe.length - tables.size} worktrees could not be walked completely; they count as freeing nothing in the estimate\n`);
	const wouldFree = exclusiveBytes([...tables.values()]);

	if (!args.execute) {
		if (args.json) {
			deps.out(`${JSON.stringify({ dry_run: true, idle_days: days, would_free_bytes: wouldFree, worktrees: classified.map(({ info, prune, claim }) => ({ path: info.path, repo: info.repo, branch: info.branch, size_bytes: info.size_bytes, class: prune.class, reasons: prune.reasons, claims: claim })) }, null, 2)}\n`);
			return 0;
		}
		for (const cls of CLASS_ORDER) {
			const group = classified.filter((item) => item.prune.class === cls);
			deps.out(`${cls} (${group.length})\n`);
			for (const { info, prune } of group) deps.out(`  ${info.path}  ${describe(info)}\n    ${prune.reasons.join("; ")}\n`);
		}
		deps.out(`dry run: ${safe.length} worktrees would be removed, freeing at least ${megabytes(wouldFree)}; run again with --execute to remove them\n`);
		return 0;
	}

	const removed: Array<{ path: string; size_bytes: number | null; ledger: LedgerResult }> = [];
	const skipped: Array<{ path: string; reasons: string[] }> = [];
	let failure: { path: string; error: string } | null = null;
	const skip = (path: string, reasons: string[]): void => {
		skipped.push({ path, reasons });
		if (!args.json) deps.err(`skipped ${path}: no longer safe (${reasons.join("; ")})\n`);
	};
	for (const { info } of safe) {
		// The inventory may be minutes old and the worktree may have been used since. Who is on the checkout now (head,
		// branch) comes from git, never from the inventory: a merge proof for an old head says nothing about the new one.
		const current = await reloadWorktree(info.path, info.repo_dir, deps.git);
		if (current === null) {
			skip(info.path, ["git no longer lists this worktree, or could not list the repository"]);
			continue;
		}
		const again = await inspectWorktree(current, { git: deps.git, pr: createPrShared(deps.gh) });
		let check = classifyForPrune(again, pruneContext(days, deps));
		const graphId = check.class === "safe" ? graphIdForWorktree(info.path, rootList) : null;
		// Asked again, last thing before the removal: a session may have claimed the graph since the inventory.
		if (graphId !== null) check = classifyForPrune(again, pruneContext(days, deps), await claimStatus(graphId, deps.claims));
		if (check.class !== "safe") {
			skip(info.path, check.reasons);
			continue;
		}
		const result = await deps.git(["worktree", "remove", info.path], info.repo_dir);
		if (result.code !== 0) {
			failure = { path: info.path, error: result.stderr.trim().slice(0, 300) || `git exited ${result.code}` };
			break;
		}
		const outcome = await deps.emit(emitNote(again, check.reasons));
		removed.push({ path: info.path, size_bytes: again.size_bytes, ledger: ledgerResult(outcome) });
		if (!args.json) deps.out(`removed ${info.path} (${megabytes(again.size_bytes)})\n`);
		// A note that was not recorded is said so on stderr in every mode: the worktree is gone and the trail has no line for it.
		if (outcome.kind === "stored") {
			if (!args.json) deps.out(`${ledgerLine(outcome)}\n`);
		} else deps.err(`${ledgerLine(outcome)}\n`);
	}
	const freed = exclusiveBytes(removed.flatMap((item) => tables.get(item.path) ?? []));
	if (args.json) deps.out(`${JSON.stringify({ dry_run: false, removed, skipped, failed: failure, freed_bytes: freed })}\n`);
	else deps.out(`removed ${removed.length} worktrees, freeing at least ${megabytes(freed)}\n`);
	if (failure !== null) {
		deps.err(`removal failed for ${failure.path}: ${failure.error}\nstopped; nothing further was removed and nothing was retried\n`);
		return 1;
	}
	return 0;
}

// ── conflicts ───────────────────────────────────────────────────────────────

function renderForecast(repo: string, forecast: ConflictForecast, deps: WorktreeDeps): void {
	deps.out(`${repo}${forecast.incomplete ? "  (INCOMPLETE: some changed files could not be listed)" : ""}\n`);
	for (const entry of forecast.worktrees) {
		let known = `${entry.files.length} changed files`;
		if (entry.files.length === 0) known = entry.notes.length > 0 ? "changes unknown" : "no changes";
		else if (entry.notes.length > 0) known += " (list incomplete)";
		deps.out(`  ${entry.path} [${entry.branch ?? "detached"}] ${known}\n`);
		for (const note of entry.notes) deps.out(`      warning: ${note}\n`);
		for (const file of entry.files.slice(0, 10)) deps.out(`      ${file}\n`);
		if (entry.files.length > 10) deps.out(`      ... ${entry.files.length - 10} more\n`);
	}
	if (forecast.overlaps.length === 0) deps.out(forecast.incomplete ? "  no overlap among the files that could be listed (the forecast is incomplete)\n" : "  no overlapping files\n");
	for (const pair of forecast.overlaps) {
		const verdict = pair.prediction === "conflict" ? `CONFLICT in ${pair.conflicted_files.join(", ")}` : pair.prediction === "clean" ? "merges cleanly" : `no prediction${pair.detail === null ? "" : ` (${pair.detail})`}`;
		deps.out(`  overlap ${pair.a} <-> ${pair.b}: ${pair.files.join(", ")}; ${verdict}\n`);
	}
	deps.out("  suggested merge order:\n");
	for (const step of forecast.order) deps.out(`    ${step.position}. ${step.path} (${step.changed_files} files${step.overlaps_with.length === 0 ? "" : `, overlaps ${step.overlaps_with.length}`})\n`);
	for (const need of forecast.rebase) deps.out(`  rebase ${need.path} after ${need.after} merges (${need.files.join(", ")})\n`);
	for (const note of forecast.notes) deps.out(`  note: ${note}\n`);
}

/**
 * Where `conflicts` looks. A directory named with `--repo` is the search target whatever the environment's roots
 * are (a repository outside them would otherwise never be searched); `--root` entries are added to it. Without a
 * directory the configured roots apply, and `--repo owner/name` only filters what they hold.
 */
async function conflictSearchRoots(args: WorktreeArgs, deps: WorktreeDeps): Promise<string[]> {
	if (args.repo !== undefined) {
		const dir = resolve(deps.cwd, args.repo);
		// `git rev-parse --git-dir` also answers inside an ordinary subfolder of a checkout (`owner/name` can be one), so only a
		// directory that is itself the top of a work tree replaces the configured roots.
		// The raw output, minus git's final newline only: `gitOut` trims, which would shorten a directory name that ends in a space.
		const result = await deps.git(["rev-parse", "--show-toplevel"], dir);
		const top = result.code === 0 ? result.stdout.replace(/\n$/, "") : null;
		if (top !== null && sameDirectory(top, dir)) return [...new Set([dir, ...args.roots.map((root) => resolve(deps.cwd, root))])];
	}
	return roots(args, deps);
}

/** The real path of `path`: symbolic links resolved when it exists, else the path made absolute. */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** Whether two paths name one directory, symbolic links resolved when they exist. */
function sameDirectory(a: string, b: string): boolean {
	return realPath(a) === realPath(b);
}

async function commandConflicts(args: WorktreeArgs, deps: WorktreeDeps): Promise<number> {
	const searchRoots = await conflictSearchRoots(args, deps);
	if (searchRoots.length === 0) return usageError(deps, NO_ROOT);
	const inventory = await gather(args, deps, searchRoots, { pr: false, measure: false, ignored: false });
	printNotes(inventory.notes, deps);
	const byRepo = new Map<string, WorktreeInfo[]>();
	for (const info of inventory.worktrees) {
		if (info.prunable) continue;
		byRepo.set(info.repo_dir, [...(byRepo.get(info.repo_dir) ?? []), info]);
	}
	const results: Array<{ repo: string; forecast: ConflictForecast }> = [];
	for (const [, group] of [...byRepo].sort(([a], [b]) => a.localeCompare(b))) {
		const first = group[0];
		if (first === undefined || group.length < 2) continue;
		const forecast = await forecastConflicts(group.map((info) => ({ path: info.path, branch: info.branch, head: info.head, base: info.base })), { git: deps.git });
		results.push({ repo: first.repo, forecast });
	}
	if (args.json) {
		deps.out(`${JSON.stringify(results, null, 2)}\n`);
		return 0;
	}
	if (results.length === 0) deps.out("no repository has two or more worktrees\n");
	for (const { repo, forecast } of results) renderForecast(repo, forecast, deps);
	return 0;
}

// ── provision ───────────────────────────────────────────────────────────────

async function commandProvision(args: WorktreeArgs, deps: WorktreeDeps): Promise<number> {
	if (args.repo === undefined || args.branch === undefined) return usageError(deps, "provision needs --repo DIR and --branch B\n");
	const repoDir = resolve(deps.cwd, args.repo);
	const branch = args.branch;
	if (branch.startsWith("-") || (await deps.git(["check-ref-format", "--branch", branch], deps.cwd)).code !== 0) return usageError(deps, `${branch} is not a valid branch name\n`);
	if ((await gitOut(deps.git, ["rev-parse", "--git-dir"], repoDir)) === null) return usageError(deps, `${repoDir} is not a git repository\n`);
	let target: string;
	if (args.path !== undefined) target = resolve(deps.cwd, args.path);
	else {
		const first = roots(args, deps)[0];
		if (first === undefined) return usageError(deps, `${NO_ROOT.trim()}, or pass --path DIR\n`);
		target = resolve(first, branch.replace(/[\\/]/g, "-"));
	}
	try {
		assertDiskFloor(target, minFreeGbFromEnv(deps.env), deps.freeBytes);
	} catch (error) {
		if (error instanceof DiskFloorError) {
			deps.err(`refused: ${error.message}; nothing was created\n`);
			return 1;
		}
		throw error;
	}
	const base = args.base ?? (await resolveDefaultRef(repoDir, deps.git)) ?? "HEAD";
	const result = await deps.git(["worktree", "add", "-b", branch, target, base], repoDir);
	if (result.code !== 0) {
		deps.err(`git worktree add failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}\n`);
		return 1;
	}
	if (args.json) deps.out(`${JSON.stringify({ path: target, branch, base })}\n`);
	else deps.out(`created ${target} on ${branch} from ${base}\n`);
	return 0;
}

// ── disk ────────────────────────────────────────────────────────────────────

async function commandDisk(args: WorktreeArgs, deps: WorktreeDeps): Promise<number> {
	const rootList = roots(args, deps);
	if (rootList.length === 0) return usageError(deps, NO_ROOT);
	const floorGb = minFreeGbFromEnv(deps.env);
	const pressure = await diskPressure(rootList, floorGb, { git: deps.git, free: deps.freeBytes });
	if (args.json) {
		deps.out(`${JSON.stringify(pressure, null, 2)}\n`);
		return 0;
	}
	deps.out(`free ${gigabytes(pressure.freeBytes)}, floor ${gigabytes(pressure.minFreeBytes)}: ${pressure.ok ? "ok" : "BELOW THE FLOOR"}\n`);
	for (const wt of pressure.worktrees.slice(0, 10)) deps.out(`  ${wt.bytes === null ? "?" : megabytes(wt.bytes)}  ${wt.path}\n`);
	return 0;
}

function usageError(deps: WorktreeDeps, message: string): number {
	deps.err(message);
	return 2;
}

/** `argv` is everything after `worktree`. */
export async function runWorktree(argv: readonly string[], deps: WorktreeDeps): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		deps.out(WORKTREE_USAGE);
		return 0;
	}
	const parsed = parseWorktreeArgs(argv);
	if (!parsed.ok) {
		deps.err(`${parsed.error}\n${WORKTREE_USAGE}`);
		return 2;
	}
	const args = parsed.args;
	switch (args.command) {
		case "list":
		case "status":
			return commandList(args, deps);
		case "scan":
			return commandScan(args, deps);
		case "prune":
			return commandPrune(args, deps);
		case "conflicts":
			return commandConflicts(args, deps);
		case "provision":
			return commandProvision(args, deps);
		case "disk":
			return commandDisk(args, deps);
	}
}

// ── the report route ────────────────────────────────────────────────────────

export interface HttpPosterConfig {
	url: string;
	token: string | undefined;
	timeoutMs: number;
	/** Test seam. */
	fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

function isStoredBody(value: unknown): value is { stored: number } {
	return typeof value === "object" && value !== null && "stored" in value && typeof value.stored === "number";
}

/** A poster for `POST /worktrees/report` with the caller's bearer. */
export function httpReportPoster(config: HttpPosterConfig): (report: WorktreeReport) => Promise<PostOutcome> {
	const doFetch = config.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
	return async (report) => {
		try {
			const response = await doFetch(`${config.url}/worktrees/report`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(config.token === undefined ? {} : { authorization: `Bearer ${config.token}` }) },
				body: JSON.stringify(report),
				signal: AbortSignal.timeout(config.timeoutMs),
			});
			if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
			const body: unknown = await response.json();
			return isStoredBody(body) ? { ok: true, stored: body.stored } : { ok: false, error: "unexpected response body" };
		} catch (error) {
			const name = error instanceof Error ? error.name : "";
			return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "server unreachable" };
		}
	};
}

/** A lookup of live graph claims over `GET /worktrees/claims` with the caller's bearer. Every failure is a refusal to vouch, never "no claims". */
export function httpClaimsLookup(config: HttpPosterConfig): ClaimsFn {
	const doFetch = config.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
	return async (graphId) => {
		if (config.token === undefined) return { ok: false, error: "no bearer token for the claims route" };
		try {
			const response = await doFetch(`${config.url}/worktrees/claims?graph_id=${encodeURIComponent(graphId)}`, {
				method: "GET",
				headers: { authorization: `Bearer ${config.token}` },
				signal: AbortSignal.timeout(config.timeoutMs),
			});
			if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
			const body: unknown = await response.json();
			const claims = parseClaimsBody(body, graphId);
			return claims === null ? { ok: false, error: "unexpected response body" } : { ok: true, claims };
		} catch (error) {
			const name = error instanceof Error ? error.name : "";
			return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "server unreachable" };
		}
	};
}
