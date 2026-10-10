/**
 * Dispatcher entry (DISP-01, DISP-08, T-24-04b, T-24-05).
 *
 * Default mode holds the process-lifetime flock and loops every 30 s.
 * Each pass re-reads the kill switch from the dispatcher env file. While
 * the switch is disabled the pass sleeps without commenting and the
 * process does not exit, so `Restart=on-failure` cannot spin. A busy
 * lock exits 0 without entering the loop; only a thrown tick exits 1.
 *
 * `--once` runs a single tick. `--once --dry-run` classifies an injected
 * in-memory queue and prints one outcome line per issue. It never
 * comments, removes a label, runs git, spawns, or opens a socket.
 *
 * Every host seam is injectable: tests pass fakes and never read the
 * real env file, never take the real lock, and never spawn Hermes.
 */

import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LinearClient } from "../../mcp-server/src/linear.ts";
import { DEFAULT_DISPATCHER_ENV_FILE, isDispatchDisabled } from "./kill-switch.ts";
import { dialClaudeCodeHost } from "./launch-claude-code.ts";
import { acquireDispatcherLock, DEFAULT_DISPATCHER_LOCK_FILE, type DispatcherLock } from "./lock.ts";
import { SubstrateClient } from "./substrate-client.ts";
import { runTick, type TickDeps } from "./tick.ts";
import { ensureWorktree } from "./worktree.ts";
import { collectCandidates, type PollIssue } from "./linear-poll.ts";

/** Resident poll interval (DISP-01). */
export const DISPATCHER_INTERVAL_MS = 30_000;

export const DISPATCHER_GIVEN_UP_DIR = "/var/lib/substrate/dispatcher";
export const DISPATCHER_WORKTREE_ROOT = "/var/lib/substrate/worktrees";
export const DISPATCHER_CHECKOUTS_ROOT = "/var/lib/substrate/checkouts";
export const DEFAULT_SUBSTRATE_URL = "http://127.0.0.1:7410";

/** Last `NAME=value` wins; comments, blank lines, and `export ` prefixes are skipped. */
function parseEnvFile(source: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of source.split("\n")) {
		let line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		if (line.startsWith("export ")) line = line.slice("export ".length).trim();
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const name = line.slice(0, eq).trim();
		if (name.length === 0) continue;
		let value = line.slice(eq + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		values[name] = value;
	}
	return values;
}

/** Read the dispatcher env file. Missing or unreadable means no values. */
function readDispatcherEnv(envFile: string): Record<string, string> {
	try {
		return parseEnvFile(readFileSync(envFile, "utf8"));
	} catch {
		return {};
	}
}

/** Production tick dependencies from the dispatcher env file. */
export function buildProductionDeps(envFile: string = DEFAULT_DISPATCHER_ENV_FILE): TickDeps {
	const env = readDispatcherEnv(envFile);
	const substrateUrl = env["SUBSTRATE_URL"]?.trim() ? (env["SUBSTRATE_URL"] as string).trim() : DEFAULT_SUBSTRATE_URL;
	return {
		linear: new LinearClient(env["LINEAR_API_KEY"] ?? ""),
		substrate: new SubstrateClient({ baseUrl: substrateUrl, token: env["SUBSTRATE_TOKEN_SUBSTRATE"] ?? "" }),
		givenUpDir: DISPATCHER_GIVEN_UP_DIR,
		worktree: (input) =>
			ensureWorktree(
				{ graphId: input.graphId, repo: input.repo },
				{
					worktreeRoot: DISPATCHER_WORKTREE_ROOT,
					checkoutsRoot: DISPATCHER_CHECKOUTS_ROOT,
					statfs: (path) => statfsSync(path),
					exists: (path) => existsSync(path),
					runGit: (args, options) => {
						const ran = spawnSync("git", args, { cwd: options?.cwd, encoding: "utf8" });
						return { status: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
					},
				},
			),
		readHermesConfig: () => {
			try {
				return readFileSync(join(homedir(), ".hermes", "config.yaml"), "utf8");
			} catch {
				return null;
			}
		},
		dispatchDisabled: () => isDispatchDisabled(envFile),
		spawn: (argv, options) => {
			const [command, ...args] = argv;
			if (command === undefined) throw new Error("hermes argv is empty");
			const child = spawn(command, args, {
				cwd: options.cwd,
				env: options.env,
				detached: true,
				stdio: ["ignore", "inherit", "inherit"],
			});
			child.unref();
			if (child.pid === undefined) throw new Error("hermes spawn produced no pid");
			return { pid: child.pid };
		},
		dialClaudeCode: () => dialClaudeCodeHost(),
		childEnvSource: { ...env },
		substrateUrl,
		hermesToken: env["SUBSTRATE_TOKEN_HERMES"] ?? "",
		isAlive: (pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		},
		signalProcess: (pid, signal) => {
			try {
				process.kill(-pid, signal);
			} catch {
				process.kill(pid, signal);
			}
		},
		sleep: (ms) => Bun.sleep(ms),
	};
}

export type DispatcherOnceStatus = "disabled" | "lock-busy" | "ticked";

export interface DispatcherSeams {
	envFile?: string;
	isDisabled?: (envFile: string) => boolean;
	acquireLock?: (lockFile?: string) => DispatcherLock;
	buildDeps?: () => TickDeps | Promise<TickDeps>;
	runTick?: (deps: TickDeps) => Promise<unknown>;
}

/**
 * One supervised pass. Disabled and lock-busy both return for an exit-0;
 * only a thrown tick error exits non-zero.
 */
export async function runDispatcherOnce(seams: DispatcherSeams = {}): Promise<DispatcherOnceStatus> {
	const envFile = seams.envFile ?? DEFAULT_DISPATCHER_ENV_FILE;
	if ((seams.isDisabled ?? isDispatchDisabled)(envFile)) return "disabled";
	const lock = (seams.acquireLock ?? acquireDispatcherLock)(DEFAULT_DISPATCHER_LOCK_FILE);
	try {
		if (!lock.held) return "lock-busy";
		const deps = seams.buildDeps ? await seams.buildDeps() : buildProductionDeps(envFile);
		await (seams.runTick ?? runTick)(deps);
		return "ticked";
	} finally {
		lock.release();
	}
}

/** Counters a dry-run attaches to its fakes. Any increment is a side effect. */
export interface DryRunWrites {
	comments: number;
	labelRemovals: number;
	gitArgv: number;
	spawns: number;
	sockets: number;
}

export function emptyDryRunWrites(): DryRunWrites {
	return { comments: 0, labelRemovals: 0, gitArgv: 0, spawns: 0, sockets: 0 };
}

export type ParsedDispatcherArgs =
	| { ok: true; mode: "resident" }
	| { ok: true; mode: "once"; dryRun: boolean }
	| { ok: false; message: string };

function usageLine(): string {
	return "usage: substrate-dispatcher [--once [--dry-run]]";
}

/** Exact-match flags only. A bare `--dry-run` is a usage error. */
export function parseDispatcherArgs(argv: readonly string[]): ParsedDispatcherArgs {
	let once = false;
	let dryRun = false;
	for (const arg of argv) {
		if (arg === "--once") {
			if (once) return { ok: false, message: usageLine() };
			once = true;
			continue;
		}
		if (arg === "--dry-run") {
			if (dryRun) return { ok: false, message: usageLine() };
			dryRun = true;
			continue;
		}
		return { ok: false, message: usageLine() };
	}
	if (dryRun && !once) return { ok: false, message: usageLine() };
	if (once) return { ok: true, mode: "once", dryRun };
	return { ok: true, mode: "resident" };
}

export interface DispatcherCliSeams extends DispatcherSeams {
	sleep?: (ms: number) => Promise<void>;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	/** In-memory queue. Dry-run never reads Linear. */
	dryRunIssues?: PollIssue[];
	dryRunWrites?: DryRunWrites;
	/** Test bound. Production omits it and the resident loop does not return. */
	maxPasses?: number;
	intervalMs?: number;
}

/** One stdout line: the identifier and a classification token, never issue text. */
export function formatDryRunLine(identifier: string, outcome: string): string {
	return `${identifier} ${outcome}`;
}

function dryRunSideEffects(writes: DryRunWrites): boolean {
	return (
		writes.comments !== 0 ||
		writes.labelRemovals !== 0 ||
		writes.gitArgv !== 0 ||
		writes.spawns !== 0 ||
		writes.sockets !== 0
	);
}

/**
 * Classify the injected queue with the real `collectCandidates` and print
 * one line per issue. The recording fake counts any comment, label
 * change, or graphql call; git, spawn, and socket are never constructed,
 * so any increment or reach fails the run.
 */
async function runDryRun(seams: DispatcherCliSeams): Promise<void> {
	const writes = seams.dryRunWrites ?? emptyDryRunWrites();
	const stdout = seams.stdout ?? ((line: string) => console.log(line));
	const issues = seams.dryRunIssues ?? [];
	const linear = {
		listUnstartedIssues: async () => ({
			nodes: issues,
			pageInfo: { hasNextPage: false, endCursor: null as string | null },
		}),
		graphql: async (): Promise<never> => {
			writes.comments += 1;
			throw new Error("dry-run graphql");
		},
		createComment: async (): Promise<void> => {
			writes.comments += 1;
		},
		updateIssue: async (): Promise<void> => {
			writes.labelRemovals += 1;
		},
	};
	const collected = await collectCandidates(linear);
	for (const issue of collected.notDispatchable) {
		stdout(formatDryRunLine(issue.identifier, "not-dispatchable"));
	}
	for (const { issue, surface } of collected.dispatchable) {
		stdout(formatDryRunLine(issue.identifier, `dispatch:${surface}`));
	}
	if (dryRunSideEffects(writes)) throw new Error("dry-run recorded a side effect");
}

function errorLine(error: unknown): string {
	return error instanceof Error ? error.message : "dispatcher tick failed";
}

/**
 * Process-lifetime flock, then a 30 s loop. A disabled pass sleeps without
 * ticking or commenting. The loop returns only at the test bound or on a
 * thrown tick, which is the sole `Restart=on-failure` path.
 */
async function runResident(seams: DispatcherCliSeams): Promise<number> {
	const envFile = seams.envFile ?? DEFAULT_DISPATCHER_ENV_FILE;
	const lock = (seams.acquireLock ?? acquireDispatcherLock)(DEFAULT_DISPATCHER_LOCK_FILE);
	const sleep = seams.sleep ?? ((ms: number) => Bun.sleep(ms));
	const interval = seams.intervalMs ?? DISPATCHER_INTERVAL_MS;
	const stderr = seams.stderr ?? ((line: string) => console.error(line));
	try {
		if (!lock.held) return 0;
		let passes = 0;
		for (;;) {
			const disabled = (seams.isDisabled ?? isDispatchDisabled)(envFile);
			if (!disabled) {
				const deps = seams.buildDeps ? await seams.buildDeps() : buildProductionDeps(envFile);
				await (seams.runTick ?? runTick)(deps);
			}
			await sleep(interval);
			passes += 1;
			if (seams.maxPasses !== undefined && passes >= seams.maxPasses) return 0;
		}
	} catch (error) {
		stderr(errorLine(error));
		return 1;
	} finally {
		lock.release();
	}
}

/**
 * CLI entry. Unknown flags exit 1. `--once` maps a thrown tick to exit 1.
 * The resident loop does not exit while the switch is disabled.
 */
export async function runDispatcher(argv: readonly string[], seams: DispatcherCliSeams = {}): Promise<number> {
	const parsed = parseDispatcherArgs(argv);
	const stderr = seams.stderr ?? ((line: string) => console.error(line));
	if (!parsed.ok) {
		stderr(parsed.message);
		return 1;
	}
	if (parsed.mode === "once" && parsed.dryRun) {
		try {
			await runDryRun(seams);
			return 0;
		} catch (error) {
			stderr(errorLine(error));
			return 1;
		}
	}
	if (parsed.mode === "once") {
		try {
			await runDispatcherOnce(seams);
			return 0;
		} catch (error) {
			stderr(errorLine(error));
			return 1;
		}
	}
	return runResident(seams);
}

if (import.meta.main) {
	process.exit(await runDispatcher(process.argv.slice(2)));
}
