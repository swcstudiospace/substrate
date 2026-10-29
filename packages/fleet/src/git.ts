/**
 * The one way the fleet library runs a program: an argv array, no shell, a time bound and an output bound.
 *
 * `GitRunner` is the seam every other module takes, so tests inject a fake (`gh`) or the real git against
 * a temporary repository. A failure to start, a timeout and an output overflow are results with a
 * reserved exit code, never exceptions: callers decide what an unreadable fact means (the classifier
 * treats every unknown as "not safe").
 */

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** `args` exclude the program name; the program is fixed by the runner (`git` or `gh`). */
export type CommandRunner = (args: string[], cwd: string) => Promise<CommandResult>;
export type GitRunner = CommandRunner;

/** Exit codes this module invents, in the shell convention for "killed by timeout" and "could not run". */
export const EXIT_TIMEOUT = 124;
export const EXIT_OUTPUT_LIMIT = 125;
export const EXIT_SPAWN_FAILED = 127;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** Variables that would redirect git to another repository or index, or change committer identity. */
const SCRUBBED = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
];

/** The process environment minus what redirects git, with prompts and optional index locks off. */
function childEnvironment(): Record<string, string> {
	const base: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !SCRUBBED.includes(key)) base[key] = value;
	}
	base.GIT_TERMINAL_PROMPT = "0";
	base.GIT_OPTIONAL_LOCKS = "0";
	base.LC_ALL = "C";
	return base;
}

async function drain(stream: ReadableStream<Uint8Array>, cap: number, onOverflow: () => void): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let overflowed = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value === undefined || overflowed) continue;
		total += value.byteLength;
		if (total > cap) {
			overflowed = true;
			onOverflow();
			continue;
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

export interface SpawnOptions {
	timeoutMs?: number;
	maxOutputBytes?: number;
}

/** A runner for `program` with the bounds above. `cwd` must exist; a missing directory is a spawn failure. */
export function spawnRunner(program: string, options: SpawnOptions = {}): CommandRunner {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	return async (args, cwd) => {
		let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			proc = Bun.spawn([program, ...args], {
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: childEnvironment(),
			});
		} catch (error) {
			return { code: EXIT_SPAWN_FAILED, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
		}
		let timedOut = false;
		let overflowed = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeoutMs);
		const kill = () => {
			overflowed = true;
			proc.kill();
		};
		try {
			const [stdout, stderr, code] = await Promise.all([
				drain(proc.stdout, maxOutputBytes, kill),
				drain(proc.stderr, MAX_STDERR_BYTES, () => undefined),
				proc.exited,
			]);
			if (timedOut) return { code: EXIT_TIMEOUT, stdout: "", stderr: `${program} timed out after ${timeoutMs} ms` };
			if (overflowed) return { code: EXIT_OUTPUT_LIMIT, stdout: "", stderr: `${program} output exceeded ${maxOutputBytes} bytes` };
			return { code, stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	};
}

export const spawnGit: GitRunner = spawnRunner("git");
export const spawnGh: CommandRunner = spawnRunner("gh", { timeoutMs: 20_000, maxOutputBytes: 1024 * 1024 });

/** A command's trimmed stdout when it exited 0, else null. */
export async function gitOut(git: GitRunner, args: string[], cwd: string): Promise<string | null> {
	const result = await git(args, cwd);
	return result.code === 0 ? result.stdout.trim() : null;
}
