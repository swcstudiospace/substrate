/**
 * desktop_run's executor (DESK-01 / D30-07..D30-12): drives the substrate-desktop container
 * through the fixed argv of actions.ts, one run at a time per process.
 *
 * - The runner is Buffer-mode: an xwd of 1280×800 is ~4.1 MB of binary that a utf8 runner (and
 *   its 4 MiB maxBuffer) would corrupt or kill.
 * - The child environment is an allowlist — PATH and HOME only (D30-07). Spreading
 *   `process.env` would hand every `SUBSTRATE_TOKEN_*` to the child. Because the
 *   child inherits HOME, a saved docker context could still select another engine,
 *   so each run first probes the effective endpoint through the same runner and
 *   proceeds only on a local `unix://` socket.
 * - Screenshots are decoded from XWD and written as PNG under `<dir>/<run_id>/` (dirs 0700,
 *   files 0600), newest 200 runs and 7 days kept.
 * - Every executed action emits one `tool.call` event (D30-11). Typed text is recorded only
 *   as its length and sha256; a key sequence is verbatim only under the tightened keyFields
 *   rule, otherwise length plus sha256. The active-window title and screenshot path stay in
 *   the tool's reply, never in the event.
 * - An event that is not stored stops the run (D30-12): `stored: false` or a throwing emit
 *   ends the run with no image blocks.
 * - Exclusion is host-wide (D30-21): the module-scope `active` flag stops a second
 *   call in this process, and a lock file in the runtime dir stops a second server
 *   process — separate rehearsal instances each start their own server, but all
 *   drive the same display. A second run while one holds the lock is refused at
 *   once, naming the active run (D30-08).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { redact } from "../redact.ts";
import type { EventInput, Surface } from "../types.ts";
import {
	boundsRefusal,
	clickArgv,
	contextArgv,
	DEFAULT_SETTLE_MS,
	type DesktopAction,
	DesktopRunInput,
	geometryArgv,
	keyArgv,
	shotArgv,
	titleArgv,
	typeArgv,
} from "./actions.ts";
import { decodeXwd, encodePng } from "./png.ts";

export const RETAIN_RUNS = 200;
export const RETAIN_MS = 7 * 86_400_000;
/**
 * One docker exec round trip. Measured on this VPS under ~75% CPU steal: 4-7 s for an xdotool
 * call and 8-11 s for an xwd, so a 10 s budget cut real calls off.
 */
export const ACTION_TIMEOUT_MS = 30_000;
/** A type action's budget grows with its text: xdotool types ≥12 ms per character (its --delay), ~160 ms under that steal. */
export const TYPE_MS_PER_CHAR = 200;
const ERROR_CHARS = 300;
const TITLE_CHARS = 256;
const RUN_ID = /^dr-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const NOT_RUNNING = /is not running|No such container/i;

const FALLBACK_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const FALLBACK_HOME = "/root";

export type BufferRunResult = { code: number | null; stdout: Buffer; stderr: string };
export type BufferRunner = (argv: readonly string[], timeoutMs: number) => Promise<BufferRunResult>;

/**
 * The child environment allowlist (D30-07): PATH and HOME only. Everything else in the
 * parent — surface tokens, ledger passwords, handoff keys — never reaches the child.
 */
export function childEnv(parent: Record<string, string | undefined>): { PATH: string; HOME: string } {
	return { PATH: parent.PATH ?? FALLBACK_PATH, HOME: parent.HOME ?? FALLBACK_HOME };
}

/** execFile with an argv (never a shell) and Buffer stdout. Never throws: failures become a result. */
export const bufferRunner: BufferRunner = (argv, timeoutMs) => {
	const { promise, resolve } = Promise.withResolvers<BufferRunResult>();
	execFile(
		argv[0] as string,
		argv.slice(1),
		{ encoding: "buffer", maxBuffer: 16 << 20, timeout: timeoutMs, env: childEnv(process.env) },
		(error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
			// Never `error.message`: the runtime embeds the full argv there, so an
			// empty-stderr failure would publish a failed `type` action's text in
			// the stored event's `error`. An empty stderr stays empty; `code`
			// still reports the failure and `failure()` names it without content.
			resolve({ code, stdout, stderr: stderr.toString("utf8") });
		},
	);
	return promise;
};

export type DesktopLogEntry = {
	i: number;
	type: DesktopAction["type"];
	ok: boolean;
	ms: number;
	active_window: string | null;
	error?: string;
};

export type DesktopScreenshot = { path: string; width: number; height: number; sha256: string };

/** `images` are the screenshots' PNG bytes as base64, in order, for the MCP image blocks. */
export type DesktopRunResult = {
	run_id: string;
	screenshots: DesktopScreenshot[];
	log: DesktopLogEntry[];
	images: string[];
	/** Set when the run stopped early because an event was not stored (D30-12). */
	error?: string;
};

/** Per-call emit: `Substrate.runDesktop` passes `(e) => this.emit(e)` so `stored` can stop the run. */
export type DesktopEmit = (event: EventInput) => Promise<{ stored: boolean }>;

export interface DesktopDriver {
	run(input: unknown, ctx: { surface: Surface; emit: DesktopEmit }): Promise<DesktopRunResult>;
}

/** A second call while a run is active is refused at once, naming the active run (D30-08). */
export class DesktopBusy extends Error {
	readonly runId: string;
	constructor(runId: string) {
		super(`desktop_run is busy with run ${runId}; nothing was run`);
		this.name = "DesktopBusy";
		this.runId = runId;
	}
}

/** Module scope: createMcpServer is rebuilt per request, so per-driver state would not exclude. */
let active: string | null = null;

/** Lock-file name for the host-wide desktop_run exclusion (D30-21). */
const DESKTOP_LOCK_NAME = "substrate-desktop-run.lock";

/**
 * Host-wide lock path: the runtime dir, never a rehearsal's `desktopDir`.
 * Drivers with different shot dirs still drive the same display, so keying
 * the lock by dir would let two servers overlap.
 */
export function desktopLockPath(): string {
	const runtime = process.env.XDG_RUNTIME_DIR;
	const base = runtime !== undefined && runtime !== "" ? runtime : tmpdir();
	return join(base, DESKTOP_LOCK_NAME);
}

/** A parsed lock claim: the holder's pid plus the run it guards. */
interface DesktopLockClaim {
	pid: number;
	runId: string;
}

/** Read the current claim; null when no claim is on file or it does not parse. */
function readDesktopLock(lockPath: string): DesktopLockClaim | null {
	let text: string;
	try {
		text = readFileSync(lockPath, "utf8");
	} catch {
		return null;
	}
	const [pidText, runId] = text.trim().split(/\s+/, 2);
	const pid = Number(pidText);
	if (pidText === undefined || pidText === "" || !Number.isSafeInteger(pid) || pid <= 0 || runId === undefined || runId === "") return null;
	return { pid, runId };
}

/** True when `pid` names a live process; EPERM means alive but unkillable. */
function isLivePid(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * Claim the host lock for `runId`. Returns the competing run id when a live
 * holder owns it, null once this process holds it. A claim from a dead
 * process — or one that does not parse — is unlinked and retried, so a
 * crashed server cannot wedge the display; anything else that keeps the
 * file claimed refuses the run fail-closed.
 */
function claimDesktopLock(lockPath: string, runId: string): string | null {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			try {
				writeSync(fd, `${process.pid} ${runId}`);
			} finally {
				closeSync(fd);
			}
			return null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw new Error("desktop_run lock unavailable; nothing was run");
		}
		const other = readDesktopLock(lockPath);
		if (other !== null && isLivePid(other.pid)) return other.runId;
		try {
			unlinkSync(lockPath);
		} catch {
			// Lost a steal race or the file vanished: re-read on the next pass.
		}
	}
	throw new Error("desktop_run lock unavailable; nothing was run");
}

/** Release the host lock, but only when it still holds this run's claim. */
function releaseDesktopLock(lockPath: string, runId: string): void {
	try {
		if (readDesktopLock(lockPath)?.runId === runId) unlinkSync(lockPath);
	} catch {
		// Housekeeping must never fail the run it guarded.
	}
}

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The failure diagnostic is fixed text: stderr is matched for the not-running
 * case but never echoed. A child can repeat the action's arguments in its
 * error output, so echoing the tail would store a failed `type` action's text
 * in the shared event's `error`, where `redact` preserves ordinary text.
 */
function failure(result: BufferRunResult): string {
	if (NOT_RUNNING.test(result.stderr)) return "substrate-desktop is not running";
	return `action failed with exit ${result.code}`;
}

/** Remove run dirs beyond the newest RETAIN_RUNS or older than RETAIN_MS; `keep` always stays. */
export function prune(shotsDir: string, keep: string, at: number): void {
	const runs = readdirSync(shotsDir)
		.filter((name) => RUN_ID.test(name))
		.map((name) => ({ name, mtime: statSync(join(shotsDir, name)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	let kept = runs.some((r) => r.name === keep) ? 1 : 0;
	for (const run of runs) {
		if (run.name === keep) continue;
		if (at - run.mtime < RETAIN_MS && kept < RETAIN_RUNS) kept++;
		else rmSync(join(shotsDir, run.name), { recursive: true, force: true });
	}
}

/** Chords carrying a non-shift modifier: naming them cannot spell typed text. */
function hasNonShiftModifier(chord: string): boolean {
	return chord
		.split("+")
		.some((part) => part === "ctrl" || part === "alt" || part === "super" || part === "meta" || part.startsWith("Control_") || part.startsWith("Alt_") || part.startsWith("Super_"));
}

/** Non-printing keys whose names carry no typed text. */
const NAMED_KEYS: Record<string, true> = {
	Return: true,
	KP_Enter: true,
	Tab: true,
	Escape: true,
	BackSpace: true,
	Delete: true,
	Insert: true,
	Home: true,
	End: true,
	Page_Up: true,
	Page_Down: true,
	Up: true,
	Down: true,
	Left: true,
	Right: true,
	Menu: true,
	F1: true,
	F2: true,
	F3: true,
	F4: true,
	F5: true,
	F6: true,
	F7: true,
	F8: true,
	F9: true,
	F10: true,
	F11: true,
	F12: true,
};

/**
 * The tightened key rule (D30-11): `keys` verbatim only when every chord either contains a
 * non-shift modifier or is a fixed non-printing key; otherwise length plus sha256. A loose
 * rule would spell text through `shift+a`, `KP_1` or punctuation keysyms, eight chords per
 * action.
 */
export function keyFields(keys: string): Record<string, unknown> {
	const verbatim = keys.split(" ").every((chord) => hasNonShiftModifier(chord) || NAMED_KEYS[chord] === true);
	return verbatim ? { keys } : { keys_len: keys.length, keys_sha256: sha256(keys) };
}

export function createDesktopDriver(deps: {
	run: BufferRunner;
	dir: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<unknown>;
	/** Host-lock override; the runtime-dir default keeps every server process exclusive. Tests pass a tmp file. */
	lockPath?: string;
}): DesktopDriver {
	const dir = deps.dir;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? delay;
	const lockPath = deps.lockPath ?? desktopLockPath();

	/** The runner raced against the driver's own timer; a hung call resolves to TIMEOUT. */
	const TIMEOUT = Symbol("timeout");
	async function call(argv: readonly string[], timeoutMs: number): Promise<BufferRunResult | typeof TIMEOUT> {
		const timer = Promise.withResolvers<typeof TIMEOUT>();
		const handle = setTimeout(() => timer.resolve(TIMEOUT), timeoutMs);
		try {
			return await Promise.race([deps.run(argv, timeoutMs), timer.promise]);
		} catch (cause) {
			return { code: null, stdout: Buffer.alloc(0), stderr: cause instanceof Error ? cause.message : String(cause) };
		} finally {
			clearTimeout(handle);
		}
	}

	async function execute(
		input: DesktopRunInput,
		surface: Surface,
		emit: DesktopEmit,
		runId: string,
		started: number,
	): Promise<DesktopRunResult> {
		const deadline = started + input.timeout * 1000;
		const runDir = join(dir, runId);
		const result: DesktopRunResult = { run_id: runId, screenshots: [], log: [], images: [] };

		// Locality preflight: root's saved docker context can select another engine,
		// and the child inherits HOME (where that context lives) while DOCKER_*
		// never reaches it — so the fixed EXEC prefix alone does not pin the local
		// desktop. The probe runs through the same runner, hence the same child
		// environment, and only `unix://` endpoints proceed, as the rehearsal
		// harness's `refuseDockerEnv`/`refuseDockerEndpoint` already require. A
		// failed or empty probe proves nothing and proceeds: the client is broken,
		// so every later docker call fails with its own truthful error and nothing
		// remote can happen.
		const locality = await call(contextArgv(), Math.max(1, Math.min(ACTION_TIMEOUT_MS, deadline - now())));
		if (locality !== TIMEOUT && locality.code === 0) {
			const endpoint = locality.stdout.toString("utf8").trim().split("\n")[0] ?? "";
			if (endpoint !== "" && !endpoint.startsWith("unix://")) {
				throw new Error(`docker context endpoint is not local (${endpoint}); refusing desktop_run`);
			}
		}

		const geo = await call(geometryArgv(), Math.max(1, Math.min(ACTION_TIMEOUT_MS, deadline - now())));
		if (geo === TIMEOUT) throw new Error("substrate-desktop did not answer the geometry read");
		if (geo.code !== 0) {
			const reason = failure(geo);
			throw new Error(reason === "substrate-desktop is not running" ? reason : `geometry read failed: ${reason}`);
		}
		const size = /^(\d+) (\d+)$/.exec(geo.stdout.toString("utf8").trim());
		if (!size) throw new Error("geometry read failed: unexpected output");
		const refusal = boundsRefusal(input.actions, { width: Number(size[1]), height: Number(size[2]) });
		if (refusal) throw new Error(refusal);

		for (const [i, action] of input.actions.entries()) {
			const details: Record<string, unknown> = {};
			const entry: DesktopLogEntry = { i, type: action.type, ok: false, ms: 0, active_window: null };
			const remaining = deadline - now();
			if (remaining <= 0) {
				// The deadline stops actions that have not started, never one in flight: the
				// action did not run, so it gets a log entry and no event (D30-04, D30-11).
				entry.error = "deadline";
				result.log.push(entry);
				break;
			}
			const t0 = now();
			let argv: string[];
			if (action.type === "click") {
				argv = clickArgv(action);
				Object.assign(details, { x: action.x, y: action.y, button: action.button ?? 1, double: action.double ?? false });
			} else if (action.type === "type") {
				argv = typeArgv(action);
				Object.assign(details, { text_len: action.text.length, text_sha256: sha256(action.text) });
			} else if (action.type === "key") {
				argv = keyArgv(action);
				Object.assign(details, keyFields(action.keys));
			} else {
				argv = shotArgv();
			}
			const budget = action.type === "type" ? ACTION_TIMEOUT_MS + action.text.length * TYPE_MS_PER_CHAR : ACTION_TIMEOUT_MS;
			const outcome = await call(argv, Math.min(budget, remaining));
			if (outcome === TIMEOUT) entry.error = "timeout";
			else if (outcome.code !== 0) entry.error = failure(outcome);
			else if (action.type === "screenshot") {
				try {
					const { width, height, rgb } = decodeXwd(outcome.stdout);
					const png = encodePng(width, height, rgb);
					mkdirSync(runDir, { recursive: true, mode: 0o700 });
					const path = join(runDir, `${result.screenshots.length + 1}.png`);
					writeFileSync(path, png, { mode: 0o600 });
					const digest = sha256(png);
					result.screenshots.push({ path, width, height, sha256: digest });
					result.images.push(png.toString("base64"));
					Object.assign(details, { sha256: digest, width, height });
				} catch {
					// Fixed text: mkdir/write errors name the run dir, and the
					// screenshot path must stay in the caller's reply, never in
					// the shared event's `error`.
					entry.error = "screenshot failed";
				}
			}
			if (entry.error === undefined) {
				entry.ok = true;
				if (action.type !== "screenshot") {
					const settle = action.settle_ms ?? DEFAULT_SETTLE_MS[action.type];
					await sleep(Math.min(settle, Math.max(0, deadline - now())));
				}
				// The title belongs to the action that already ran, so it gets its full budget even
				// past the deadline; the deadline only stops actions that have not started.
				const title = await call(titleArgv(), ACTION_TIMEOUT_MS);
				if (title !== TIMEOUT && title.code === 0) {
					entry.active_window = title.stdout.toString("utf8").trim().slice(0, TITLE_CHARS);
				}
			}
			entry.ms = now() - t0;
			result.log.push(entry);
			let stored = false;
			try {
				({ stored } = await emit({
					surface,
					kind: "tool.call",
					actor: "agent",
					session_id: `desktop:${runId}`,
					summary: `desktop ${action.type} ${entry.ok ? "ok" : "failed"}`,
					payload: {
						tool: "desktop_run",
						action: action.type,
						run_id: runId,
						i,
						ok: entry.ok,
						ms: entry.ms,
						...details,
						...(entry.error === undefined ? {} : { error: redact(entry.error).slice(0, ERROR_CHARS) }),
					},
				}));
			} catch {
				// A throwing emit counts as not stored.
			}
			if (!stored) {
				// Fail closed (D30-12): a bare run without a ledger must not act further, and
				// the caller gets no image blocks.
				result.images = [];
				result.error = `event not stored after action ${i}; run stopped`;
				break;
			}
			if (!entry.ok) break;
		}

		try {
			prune(dir, runId, now());
		} catch {
			// Retention is housekeeping; a missing or unreadable dir never fails the run.
		}
		return result;
	}

	return {
		async run(input, { surface, emit }) {
			const parsed = DesktopRunInput.parse(input);
			// Synchronous check-and-set: no await runs between the in-process
			// check, the host-file claim and the set, so neither two calls in
			// this process nor two server processes on one host can overlap.
			if (active !== null) throw new DesktopBusy(active);
			const started = now();
			const stamp = new Date(started).toISOString().replace(/[-:]/g, "").slice(0, 15);
			const runId = `dr-${stamp}Z-${randomBytes(3).toString("hex")}`;
			const other = claimDesktopLock(lockPath, runId);
			if (other !== null) throw new DesktopBusy(RUN_ID.test(other) ? other : "unknown");
			active = runId;
			try {
				return await execute(parsed, surface, emit, runId, started);
			} finally {
				active = null;
				releaseDesktopLock(lockPath, runId);
			}
		},
	};
}
