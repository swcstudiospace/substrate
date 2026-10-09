/**
 * A recording stand-in for `gh`, for the rehearsal harness's skills fixture (D21-21).
 *
 * The skill proposer runs real `git` against a throwaway repository and calls `gh` only for
 * the three pull request questions it asks: create one, view one, list the open ones for a
 * branch. This answers exactly those from a JSON state file, with URLs under the configured
 * library's slug, and refuses everything else, so the harness can never reach GitHub or
 * quietly grow a second use. Every invocation is recorded first, so a proof can count the
 * `pr create` calls it made.
 *
 * The decisions are `fakeGh`, a pure function of the argv and the state. `runFakeGh` adds the
 * file, and `fakeGhScript` is the executable the engine spawns as `gh`: the engine
 * hands its children an allowlisted environment, so the state path is baked into the script
 * rather than passed through one.
 */
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakePr {
	number: number;
	url: string;
	head: string;
	base: string;
	title: string;
	state: "OPEN" | "CLOSED" | "MERGED";
}

export interface FakeGhState {
	next: number;
	prs: FakePr[];
	/** Every invocation's argv, in order, supported or not. */
	calls: string[][];
	/** The fixture library slug. When set, `pr create` refuses any other `--repo`. */
	repo?: string;
	/** Bare repository. When set, `pr create` requires the head and base refs to exist. */
	origin?: string;
}

export interface FakeGhResult {
	code: number;
	stdout: string;
	stderr: string;
}

export const EMPTY_STATE: FakeGhState = { next: 1, prs: [], calls: [] };

/** This module's own path, so the installed script can import the one implementation. */
export const FAKE_GH_MODULE = import.meta.path;

function flag(argv: readonly string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
}

const fail = (code: number, stderr: string): FakeGhResult => ({ code, stdout: "", stderr: `${stderr}\n` });

/** Answer one `gh` invocation, recording it in `state` (which is updated in place). */
export function fakeGh(argv: readonly string[], state: FakeGhState): FakeGhResult {
	state.calls.push([...argv]);
	const [group, verb, target] = argv;
	if (group !== "pr") return fail(2, `fake gh: unsupported command ${argv.slice(0, 2).join(" ")}`);

	if (verb === "create") {
		const repo = flag(argv, "--repo");
		const head = flag(argv, "--head");
		const base = flag(argv, "--base");
		const title = flag(argv, "--title");
		if (!repo || !head || !base || title === undefined) return fail(2, "fake gh: pr create needs --repo, --head, --base and --title");
		if (state.repo !== undefined && repo !== state.repo) return fail(1, `fake gh: repo is not ${state.repo}`);
		if (state.prs.some((pr) => pr.head === head && pr.base === base && pr.state === "OPEN" && pr.url.startsWith(`https://github.com/${repo}/pull/`))) {
			return fail(1, `fake gh: an open pull request already exists for ${head}`);
		}
		if (state.origin !== undefined) {
			if (!refExists(state.origin, head)) return fail(1, `fake gh: head ${head} does not exist`);
			if (!refExists(state.origin, base)) return fail(1, `fake gh: base ${base} does not exist`);
		}
		const number = state.next++;
		const url = `https://github.com/${repo}/pull/${number}`;
		state.prs.push({ number, url, head, base, title, state: "OPEN" });
		return { code: 0, stdout: `${url}\n`, stderr: "" };
	}

	if (verb === "view") {
		const pr = state.prs.find((candidate) => candidate.url === target);
		if (!pr) return fail(1, `no pull requests found for ${String(target)}`);
		return { code: 0, stdout: `${JSON.stringify({ state: pr.state, url: pr.url, number: pr.number })}\n`, stderr: "" };
	}

	if (verb === "list") {
		const repo = flag(argv, "--repo");
		const head = flag(argv, "--head");
		if (!repo || !head) return fail(2, "fake gh: pr list needs --repo and --head");
		const wanted = (flag(argv, "--state") ?? "open").toUpperCase();
		const rows = state.prs
			.filter((pr) => pr.head === head && pr.url.startsWith(`https://github.com/${repo}/pull/`))
			.filter((pr) => wanted === "ALL" || pr.state === wanted)
			.map((pr) => ({ url: pr.url, number: pr.number, state: pr.state }));
		return { code: 0, stdout: `${JSON.stringify(rows)}\n`, stderr: "" };
	}

	return fail(2, `fake gh: unsupported command pr ${String(verb)}`);
}

/** A branch name that is safe to pass as a git ref and cannot escape `refs/heads`. */
function safeRef(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(name) && !name.includes("..") && !name.endsWith("/") && !name.includes("//");
}

function refExists(origin: string, name: string): boolean {
	if (!safeRef(name)) return false;
	const result = Bun.spawnSync(["git", "--git-dir", origin, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], {
		stdout: "ignore",
		stderr: "ignore",
		env: {
			PATH: process.env.PATH ?? "",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
	return result.exitCode === 0;
}

/** Read the state file; a missing or unreadable one is the empty state. */
export function readState(statePath: string): FakeGhState {
	try {
		const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<FakeGhState>;
		return {
			next: parsed.next ?? 1,
			prs: parsed.prs ?? [],
			calls: parsed.calls ?? [],
			...(typeof parsed.repo === "string" ? { repo: parsed.repo } : {}),
			...(typeof parsed.origin === "string" ? { origin: parsed.origin } : {}),
		};
	} catch {
		return { next: 1, prs: [], calls: [] };
	}
}

/** Write the state through a temp file and a rename, so a reader never sees half of it. */
export function writeState(statePath: string, state: FakeGhState): void {
	const temp = `${statePath}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, statePath);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === "EPERM";
	}
}

const pause = new Int32Array(new SharedArrayBuffer(4));
let takeoverSeq = 0;

/**
 * Whether the lock instance at `lock` is free to take: a dead owner's, or an
 * ownerless one older than the bound. A pid file that is present but unparsable is
 * owned as far as anyone can tell, never stale.
 */
function lockIsStale(lock: string): boolean {
	let pid = Number.NaN;
	let pidMissing = false;
	try {
		pid = Number(readFileSync(join(lock, "pid"), "utf8").trim());
	} catch {
		pidMissing = true;
	}
	if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
	if (!pidMissing) return false;
	let age = 0;
	try {
		age = Date.now() - statSync(lock).mtimeMs;
	} catch {
		return false;
	}
	return age > 250;
}

/**
 * Remove the stale lock without ever deleting a fresh one: rename it aside (atomic,
 * so concurrent recoverers of the same ownerless lock elect exactly one winner),
 * re-check the renamed copy, and restore that exact instance untouched when its
 * owner showed up mid-takeover. Returns true when the stale instance is gone.
 */
function takeStaleLock(lock: string): boolean {
	const stale = `${lock}.stale.${process.pid}.${takeoverSeq++}`;
	try {
		renameSync(lock, stale);
	} catch {
		return false;
	}
	if (!lockIsStale(stale)) {
		// Its owner arrived mid-takeover: put that exact instance back. A fresh lock
		// may occupy the path for a moment; wait for it to drain rather than strand
		// or delete a live lock.
		const deadline = Date.now() + 2_000;
		for (;;) {
			try {
				renameSync(stale, lock);
				return false;
			} catch {
				if (Date.now() >= deadline) return false;
				Atomics.wait(pause, 0, 0, 5);
			}
		}
	}
	try {
		rmSync(stale, { recursive: true, force: true });
	} catch {
		// A uniquely named leftover never blocks acquisition.
	}
	return true;
}

/**
 * One lock around the whole read, change and write. An atomic rename of the state file
 * does not stop two children from reading the same `next` and returning the same PR number.
 */
function acquireStateLock(statePath: string): () => void {
	const lock = `${statePath}.lock`;
	const started = Date.now();
	for (;;) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			try {
				writeFileSync(join(lock, "pid"), String(process.pid));
			} catch (writeCause) {
				// Our mkdir won but the pid never landed: drop exactly that half-made
				// instance. `rmdirSync` only removes an empty directory, so a fresh lock
				// another child has claimed since is never deleted wholesale.
				try {
					rmdirSync(lock);
				} catch {
					// Taken over or claimed meanwhile; age-based recovery covers leftovers.
				}
				throw writeCause;
			}
			const owner = process.pid;
			return () => {
				// Release only the lock still owned by this process, never a successor's.
				try {
					if (readFileSync(join(lock, "pid"), "utf8").trim() !== String(owner)) return;
				} catch {
					return;
				}
				rmSync(lock, { recursive: true, force: true });
			};
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
		}
		// The path is held by someone: reclaim it only when it is identifiably stale,
		// through an atomic takeover that a single recoverer wins.
		try {
			if (lockIsStale(lock)) takeStaleLock(lock);
		} catch {
			// A lock that cannot even be stat'ed is gone already; retry the acquire.
		}
		if (Date.now() - started > 5_000) throw new Error("fake gh state lock busy");
		Atomics.wait(pause, 0, 0, 5);
	}
}

/** What the installed script runs: answer on stdout and stderr, return the exit code. */
export function runFakeGh(argv: readonly string[], statePath: string): number {
	const release = acquireStateLock(statePath);
	try {
		const state = readState(statePath);
		const result = fakeGh(argv, state);
		writeState(statePath, state);
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		return result.code;
	} finally {
		release();
	}
}

function shellSingle(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The executable the engine spawns as `gh`.
 *
 * A shell wrapper so `bun --no-env-file` is actually passed: a shebang can take only one
 * argument, and without the flag the child would reload `.env` from the checkout.
 */
export function fakeGhScript({ bun, statePath }: { bun: string; statePath: string }): string {
	const program =
		`import { runFakeGh } from ${JSON.stringify(FAKE_GH_MODULE)};\n` +
		`process.exit(runFakeGh(process.argv.slice(1), ${JSON.stringify(statePath)}));\n`;
	return `#!/bin/sh\nexec ${shellSingle(bun)} --no-env-file -e ${shellSingle(program)} "$@"\n`;
}
