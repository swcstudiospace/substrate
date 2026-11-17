/**
 * The git runner of the mirror and the view (v1.7 phase 65): like `GitRunner`, but with binary output, standard input and
 * a timeout, because `git cat-file --batch` needs the first two and a fetch needs the third.
 *
 * Every call runs with `GIT_OPTIONAL_LOCKS=0` (a read never rewrites the index), `GIT_TERMINAL_PROMPT=0` and a no-op askpass
 * (a missing credential fails the command instead of waiting for a person). A caller adds `GIT_NO_LAZY_FETCH=1` when a
 * missing object must be reported and not fetched into the repository it reads.
 */
import { spawnSync } from "node:child_process";

export interface GitCall {
	args: string[];
	cwd: string;
	/** Standard input; absent means none. */
	input?: Uint8Array | string | undefined;
	/** Extra environment for this call (for example `GIT_ALTERNATE_OBJECT_DIRECTORIES`). */
	env?: Record<string, string> | undefined;
	timeoutMs?: number | undefined;
}

export interface GitOutput {
	/** The exit status; 124 when the call was killed for taking longer than `timeoutMs`. */
	code: number;
	stdout: Uint8Array;
	timedOut: boolean;
}

export type GitBytesRunner = (call: GitCall) => GitOutput;

/** A ceiling that only guards against a runaway process; callers bound what they ask for. */
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

export const TIMED_OUT_CODE = 124;

export const defaultGitBytesRunner: GitBytesRunner = (call) => {
	const result = spawnSync("git", call.args, {
		cwd: call.cwd,
		maxBuffer: GIT_MAX_BUFFER,
		...(call.timeoutMs === undefined ? {} : { timeout: call.timeoutMs, killSignal: "SIGKILL" as const }),
		...(call.input === undefined ? {} : { input: call.input }),
		stdio: [call.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
		env: {
			...process.env,
			GIT_OPTIONAL_LOCKS: "0",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "true",
			SSH_ASKPASS: "true",
			...call.env,
		},
	});
	const timedOut = result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT";
	return { code: timedOut ? TIMED_OUT_CODE : (result.status ?? 1), stdout: result.stdout ?? new Uint8Array(0), timedOut };
};

const textDecoder = new TextDecoder("utf-8");

/** The output as text, with invalid sequences replaced (paths are matched and validated afterwards). */
export function outputText(output: GitOutput): string {
	return textDecoder.decode(output.stdout);
}
