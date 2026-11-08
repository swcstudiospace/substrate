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
 *   call in this process, and a loopback bind stops a second server process —
 *   separate rehearsal instances each start their own server, but all drive the
 *   same display. The bind is atomic and OS-held, so there is no claim to race
 *   or go stale. A second run while one holds the mutex is refused at once,
 *   naming the active run (D30-08).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
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

const RETAIN_RUNS = 200;
const RETAIN_MS = 7 * 86_400_000;
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

type DesktopScreenshot = { path: string; width: number; height: number; sha256: string };

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
type DesktopEmit = (event: EventInput) => Promise<{ stored: boolean }>;

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

/**
 * Well-known loopback mutex for the host-wide desktop_run exclusion (D30-21):
 * every server process on one host drives the same display, so the in-process
 * `active` flag alone cannot exclude. A file claim cannot do it either — the
 * claim is readable before it is written and deletable after, so two servers
 * can both conclude they hold it. A bind is atomic and the operating system
 * owns it: exactly one process holds the port, and a crashed holder releases
 * it. There is no claim file to read, delete, or go stale.
 */
const DESKTOP_LOCK_PORT = 45931;
/** How long a refused caller waits for the holder to name its run. */
const LOCK_IDENTITY_TIMEOUT_MS = 2000;
/** Lock connections served at once; a connection past this is dropped unanswered. */
const LOCK_MAX_CONNECTIONS = 4;

/** Ask the lock holder for its run id; null when it cannot answer. */
function readDesktopIdentity(port: number): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	let text = "";
	const socket = createConnection(port, "127.0.0.1");
	const timer = setTimeout(() => {
		socket.destroy();
		resolve(null);
	}, LOCK_IDENTITY_TIMEOUT_MS);
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		text += chunk;
	});
	socket.on("end", () => {
		clearTimeout(timer);
		const runId = text.trim().split(/\s+/)[1];
		resolve(runId !== undefined && RUN_ID.test(runId) ? runId : null);
	});
	socket.on("error", () => {
		clearTimeout(timer);
		resolve(null);
	});
	return promise;
}

/** The bind outcome: held with its release, held elsewhere, or unbindable. */
type DesktopPortClaim = { release: () => void } | { other: string | null } | { unavailable: true };

/**
 * Answer one identity probe with this run's id. Best-effort: any local
 * process can connect and reset mid-write, and accepted-socket errors bypass
 * the server error handler — without the sink an ECONNRESET would crash the
 * MCP process. Exported as the unit under test.
 */
export function serveIdentity(socket: Socket, runId: string): void {
	socket.on("error", () => {});
	socket.end(`${process.pid} ${runId}`, "utf8");
}

/**
 * Take the host mutex for `runId`. The holder serves its run id to refused
 * callers over the same port. Anything that keeps the port unbindable refuses
 * the run fail-closed.
 */
function claimDesktopPort(port: number, runId: string): Promise<DesktopPortClaim> {
	const { promise, resolve } = Promise.withResolvers<DesktopPortClaim>();
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		// An idle connection holds a slot; the identity timeout frees it.
		socket.setTimeout(LOCK_IDENTITY_TIMEOUT_MS, () => socket.destroy());
		serveIdentity(socket, runId);
	});
	server.maxConnections = LOCK_MAX_CONNECTIONS;
	server.on("error", (error) => {
		// A bound server only sees accept-time failures; the bind outcome
		// is decided below, once, while `listening` is still false.
		if (server.listening) return;
		const code = (error as NodeJS.ErrnoException)?.code;
		try {
			server.close();
		} catch {
			// Never bound: nothing to release.
		}
		if (code === "EADDRINUSE") {
			void readDesktopIdentity(port).then((other) => resolve({ other }));
		} else {
			resolve({ unavailable: true });
		}
	});
	server.listen(port, "127.0.0.1", () =>
		resolve({
			release: () => {
				for (const socket of sockets) socket.destroy();
				server.close();
			},
		}),
	);
	return promise;
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
function prune(shotsDir: string, keep: string, at: number): void {
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
	/** Host-mutex port override; the well-known default keeps every server process exclusive. Tests pass an ephemeral port. */
	lockPort?: number;
}): DesktopDriver {
	const dir = deps.dir;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? delay;
	const lockPort = deps.lockPort ?? DESKTOP_LOCK_PORT;

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
		// harness's `refuseDockerEnv`/`refuseDockerEndpoint` already require. A probe that
		// fails or times out proves nothing, so it refuses, as an empty endpoint does, and
		// a non-local endpoint is refused the same way. No refusal names the endpoint.
		const locality = await call(contextArgv(), Math.max(1, Math.min(ACTION_TIMEOUT_MS, deadline - now())));
		if (locality === TIMEOUT) throw new Error("docker context probe timed out; refusing desktop_run");
		if (locality.code !== 0) throw new Error("docker context probe failed; refusing desktop_run");
		const endpoint = locality.stdout.toString("utf8").trim().split("\n")[0] ?? "";
		if (endpoint === "") throw new Error("docker context endpoint is empty; refusing desktop_run");
		if (!endpoint.startsWith("unix://")) throw new Error("docker context endpoint is not local; refusing desktop_run");

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
			// The in-process flag is set synchronously, so two calls in this
			// process cannot both reach the host claim; the loopback bind then
			// excludes separate server processes on one host.
			if (active !== null) throw new DesktopBusy(active);
			const started = now();
			const stamp = new Date(started).toISOString().replace(/[-:]/g, "").slice(0, 15);
			const runId = `dr-${stamp}Z-${randomBytes(3).toString("hex")}`;
			active = runId;
			let release: (() => void) | null = null;
			try {
				const claim = await claimDesktopPort(lockPort, runId);
				if ("unavailable" in claim) throw new Error("desktop_run lock unavailable; nothing was run");
				if ("other" in claim) throw new DesktopBusy(claim.other ?? "unknown");
				release = claim.release;
				return await execute(parsed, surface, emit, runId, started);
			} finally {
				active = null;
				release?.();
			}
		},
	};
}
