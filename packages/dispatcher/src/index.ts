/**
 * Dispatcher entry (DISP-01, DISP-08, T-24-04b).
 *
 * The smallest runnable unit the service file ExecStarts: re-read the
 * kill switch from the dispatcher env file, take the process-lifetime
 * flock, and run one tick. Disabled exits 0 without touching Linear; a
 * busy lock exits 0 without entering the tick, so a duplicate is never
 * restarted into a loop. Anything the tick throws exits non-zero, which
 * is the only path `Restart=on-failure` restarts.
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

if (import.meta.main) {
	const status = await runDispatcherOnce();
	console.log(`substrate-dispatcher: ${status}`);
}
