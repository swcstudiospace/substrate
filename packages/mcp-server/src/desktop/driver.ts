/**
 * desktop_run's executor (D-13): drives the substrate-desktop container through the fixed argv
 * of actions.ts, one run at a time per process.
 *
 * - The runner is Buffer-mode: an xwd of 1280×800 is ~4.1 MB of binary that a utf8 runner (and
 *   its 4 MiB maxBuffer) would corrupt or kill.
 * - Screenshots are decoded from XWD and written as PNG under /var/lib/substrate/desktop/<run_id>/
 *   (dirs 0700, files 0600; never /tmp, which is private to the service), newest 200 runs and
 *   7 days kept.
 * - Every executed action emits one desktop.action event, fail-open. Typed text is recorded only
 *   as its length and sha256.
 * - The mutex lives at module scope: createMcpServer is rebuilt per request, and two agents
 *   interleaving input on one display would corrupt both runs.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync } from "node:zlib";
import { redact } from "../redact.ts";
import type { Surface } from "../types.ts";
import {
	boundsRefusal,
	clickArgv,
	DEFAULT_SETTLE_MS,
	type DesktopAction,
	DesktopRunInput,
	geometryArgv,
	keyArgv,
	shotArgv,
	titleArgv,
	typeArgv,
} from "./actions.ts";

export const SHOTS_DIR = "/var/lib/substrate/desktop";
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

export type BufferRunResult = { code: number | null; stdout: Buffer; stderr: string };
export type BufferRunner = (argv: readonly string[], timeoutMs: number) => Promise<BufferRunResult>;

/** execFile with an argv (never a shell) and Buffer stdout. Never throws: failures become a result. */
export const bufferRunner: BufferRunner = (argv, timeoutMs) => {
	const { promise, resolve } = Promise.withResolvers<BufferRunResult>();
	execFile(
		argv[0] as string,
		argv.slice(1),
		{ encoding: "buffer", maxBuffer: 16 << 20, timeout: timeoutMs, env: { ...process.env, HOME: "/root" } },
		(error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
			resolve({ code, stdout, stderr: stderr.toString("utf8") || (error?.message ?? "") });
		},
	);
	return promise;
};

// ── XWD → RGB ────────────────────────────────────────────────────────────────

const XWD_HEADER_BYTES = 100;
const XWD_COLOR_BYTES = 12;
const ZPIXMAP = 2;
const TRUE_COLOR = 4;
const DIRECT_COLOR = 5;

/**
 * Decode an X Window Dump: header CARD32s are big-endian, pixels are in the file's byte_order,
 * channels come from the red/green/blue masks. Only version 7, ZPixmap, 32 bpp, TrueColor or
 * DirectColor — what `xwd -root` prints for an Xvfb screen.
 */
export function decodeXwd(buf: Buffer): { width: number; height: number; rgb: Buffer } {
	if (buf.length < XWD_HEADER_BYTES) throw new Error("xwd: shorter than its header");
	const field = (i: number) => buf.readUInt32BE(i * 4);
	const headerSize = field(0);
	const version = field(1);
	const format = field(2);
	const width = field(4);
	const height = field(5);
	const byteOrder = field(7);
	const bpp = field(11);
	const bytesPerLine = field(12);
	const visualClass = field(13);
	const ncolors = field(19);
	if (version !== 7) throw new Error(`xwd: version ${version}, expected 7`);
	if (format !== ZPIXMAP) throw new Error(`xwd: pixmap format ${format}, expected ZPixmap`);
	if (bpp !== 32) throw new Error(`xwd: ${bpp} bits per pixel, expected 32`);
	if (visualClass !== TRUE_COLOR && visualClass !== DIRECT_COLOR) throw new Error(`xwd: visual class ${visualClass}`);
	if (byteOrder > 1) throw new Error(`xwd: byte order ${byteOrder}`);
	if (headerSize < XWD_HEADER_BYTES || width === 0 || height === 0 || bytesPerLine < width * 4) {
		throw new Error("xwd: inconsistent header");
	}
	const offset = headerSize + ncolors * XWD_COLOR_BYTES;
	if (buf.length < offset + bytesPerLine * height) throw new Error("xwd: truncated pixel data");

	const channels = [field(14), field(15), field(16)].map((mask) => {
		if (mask === 0) throw new Error("xwd: empty colour mask");
		const shift = 31 - Math.clz32(mask & -mask);
		return { mask, shift, max: mask >>> shift };
	});
	const littleEndian = byteOrder === 0;
	const rgb = Buffer.allocUnsafe(width * height * 3);
	let out = 0;
	for (let y = 0; y < height; y++) {
		let at = offset + y * bytesPerLine;
		for (let x = 0; x < width; x++, at += 4) {
			const pixel = littleEndian ? buf.readUInt32LE(at) : buf.readUInt32BE(at);
			for (const { mask, shift, max } of channels) {
				const value = (pixel & mask) >>> shift;
				rgb[out++] = max === 255 ? value : Math.round((value * 255) / max);
			}
		}
	}
	return { width, height, rgb };
}

// ── RGB → PNG ────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

/** IEEE CRC-32, as PNG chunks use it. */
export function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	chunk.write(type, 4, "latin1");
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
	return chunk;
}

/** An 8-bit RGB PNG: signature, IHDR, one IDAT of deflated filter-0 rows, IEND. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
	const stride = width * 3;
	if (rgb.length !== stride * height) throw new Error(`png: ${rgb.length} bytes for ${width}x${height} RGB`);
	const rows = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) rgb.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type RGB; compression, filter and interlace stay 0
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(rows)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

// ── the driver ───────────────────────────────────────────────────────────────

export type DesktopActionEvent = {
	kind: "desktop.action";
	surface: Surface;
	summary: string;
	actor: "agent";
	payload: Record<string, unknown>;
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
};

export interface DesktopDriver {
	run(input: DesktopRunInput, ctx: { surface: Surface }): Promise<DesktopRunResult>;
}

const TIMEOUT = Symbol("timeout");
let queue: Promise<unknown> = Promise.resolve();

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function failure(result: BufferRunResult): string {
	if (NOT_RUNNING.test(result.stderr)) return "substrate-desktop is not running";
	return redact(`exit ${result.code}: ${result.stderr.trim().slice(-ERROR_CHARS)}`);
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

export function createDesktopDriver(deps: {
	run: BufferRunner;
	shotsDir?: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<unknown>;
	emit: (event: DesktopActionEvent) => Promise<unknown>;
}): DesktopDriver {
	const shotsDir = deps.shotsDir ?? SHOTS_DIR;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? delay;

	/** The runner raced against the driver's own timer; a hung call resolves to TIMEOUT. */
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

	async function execute(input: DesktopRunInput, surface: Surface): Promise<DesktopRunResult> {
		const started = now();
		const deadline = started + input.timeout * 1000;
		const stamp = new Date(started).toISOString().replace(/[-:]/g, "").slice(0, 15);
		const runId = `dr-${stamp}Z-${randomBytes(3).toString("hex")}`;
		const runDir = join(shotsDir, runId);
		const result: DesktopRunResult = { run_id: runId, screenshots: [], log: [], images: [] };

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
				entry.error = "deadline";
			} else {
				const t0 = now();
				let argv: string[];
				if (action.type === "click") {
					argv = clickArgv(action);
					Object.assign(details, { x: action.x, y: action.y, button: action.button ?? 1 });
				} else if (action.type === "type") {
					argv = typeArgv(action);
					Object.assign(details, { text_chars: action.text.length, text_sha256: sha256(action.text) });
				} else if (action.type === "key") {
					argv = keyArgv(action);
					details.keys = action.keys;
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
						Object.assign(details, { screenshot_path: path, screenshot_sha256: digest });
					} catch (cause) {
						entry.error = redact((cause instanceof Error ? cause.message : String(cause)).slice(0, ERROR_CHARS));
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
			}
			result.log.push(entry);
			try {
				await deps.emit({
					kind: "desktop.action",
					surface,
					summary: `desktop ${action.type} ${entry.ok ? "ok" : "failed"}`,
					actor: "agent",
					payload: { run_id: runId, ...entry, ...details },
				});
			} catch {
				// Fail-open: the audit event is a side effect and never fails the run.
			}
			if (!entry.ok) break;
		}

		try {
			prune(shotsDir, runId, now());
		} catch {
			// Retention is housekeeping; a missing or unreadable dir never fails the run.
		}
		return result;
	}

	return {
		async run(input, { surface }) {
			const parsed = DesktopRunInput.parse(input);
			const turn = queue.then(() => execute(parsed, surface));
			queue = turn.catch(() => undefined);
			return turn;
		},
	};
}
