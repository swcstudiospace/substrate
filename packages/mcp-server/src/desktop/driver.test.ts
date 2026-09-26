import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { geometryArgv, keyArgv, shotArgv, titleArgv, typeArgv, type DesktopRunInput } from "./actions.ts";
import {
	ACTION_TIMEOUT_MS,
	type BufferRunner,
	type BufferRunResult,
	crc32,
	createDesktopDriver,
	decodeXwd,
	type DesktopActionEvent,
	encodePng,
	TYPE_MS_PER_CHAR,
} from "./driver.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmpShots(): string {
	const dir = mkdtempSync(join(tmpdir(), "desktop-driver-"));
	dirs.push(dir);
	return join(dir, "shots");
}

const res = (stdout: string | Buffer, code = 0, stderr = ""): BufferRunResult => ({
	code,
	stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout,
	stderr,
});

/** 4×3 test image: pixel (x, y) is RGB (10x+1, 20y+2, 7x+5y+3). */
const W = 4;
const H = 3;
const pixel = (x: number, y: number) => [10 * x + 1, 20 * y + 2, 7 * x + 5 * y + 3] as const;
const EXPECTED_RGB = Buffer.from(Array.from({ length: W * H }, (_, n) => [...pixel(n % W, Math.floor(n / W))]).flat());

/**
 * A synthetic XWD: big-endian header, window name, ncolors × 12-byte colours, then rows of 4-byte
 * (32 bpp) or packed 3-byte (24 bpp, what this Xvfb's `xwd -root` writes) pixels padded by 4 bytes.
 */
function xwd(o: { byteOrder: 0 | 1; version?: number; format?: number; bpp?: number; ncolors?: number }): Buffer {
	const name = Buffer.from("xwdtest\0");
	const bpp = o.bpp ?? 32;
	const unit = bpp === 24 ? 3 : 4;
	const bytesPerLine = W * unit + 4;
	const header = Buffer.alloc(100);
	const fields = [
		100 + name.length, o.version ?? 7, o.format ?? 2, 24, W, H, 0, o.byteOrder, 32, o.byteOrder, 32, bpp,
		bytesPerLine, 4, 0xff0000, 0xff00, 0xff, 8, 256, o.ncolors ?? 0, W, H, 0, 0, 0,
	];
	fields.forEach((value, i) => header.writeUInt32BE(value, i * 4));
	const pixels = Buffer.alloc(bytesPerLine * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const [r, g, b] = pixel(x, y);
			const at = y * bytesPerLine + x * unit;
			if (o.byteOrder === 0) pixels.writeUIntLE((r << 16) | (g << 8) | b, at, unit);
			else pixels.writeUIntBE((r << 16) | (g << 8) | b, at, unit);
		}
	}
	return Buffer.concat([header, name, Buffer.alloc((o.ncolors ?? 0) * 12), pixels]);
}

function chunks(png: Buffer): Array<{ type: string; data: Buffer; crc: number }> {
	const out: Array<{ type: string; data: Buffer; crc: number }> = [];
	for (let at = 8; at < png.length; ) {
		const length = png.readUInt32BE(at);
		out.push({
			type: png.subarray(at + 4, at + 8).toString("latin1"),
			data: png.subarray(at + 8, at + 8 + length),
			crc: png.readUInt32BE(at + 8 + length),
		});
		at += 12 + length;
	}
	return out;
}

describe("decodeXwd", () => {
	test("decodes a 4×3 ZPixmap TrueColor XWD at 32 and packed 24 bpp in either pixel byte order, skipping the colormap", () => {
		for (const bpp of [32, 24]) {
			for (const byteOrder of [0, 1] as const) {
				expect(decodeXwd(xwd({ byteOrder, bpp }))).toEqual({ width: W, height: H, rgb: EXPECTED_RGB });
			}
		}
		expect(decodeXwd(xwd({ byteOrder: 0, bpp: 24, ncolors: 256 })).rgb).toEqual(EXPECTED_RGB);
	});

	test("refuses version 6, XYPixmap, 16 bpp and a truncated buffer", () => {
		expect(() => decodeXwd(xwd({ byteOrder: 0, version: 6 }))).toThrow();
		expect(() => decodeXwd(xwd({ byteOrder: 0, format: 1 }))).toThrow();
		expect(() => decodeXwd(xwd({ byteOrder: 0, bpp: 16 }))).toThrow();
		expect(() => decodeXwd(xwd({ byteOrder: 0 }).subarray(0, 150))).toThrow();
		expect(() => decodeXwd(Buffer.alloc(40))).toThrow();
	});
});

describe("encodePng", () => {
	test("writes signature, IHDR 4×3 depth 8 RGB, CRC-checked chunks and filter-0 rows", () => {
		const png = encodePng(W, H, EXPECTED_RGB);

		expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const list = chunks(png);
		expect(list.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
		const ihdr = list[0]!.data;
		expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]]).toEqual([W, H, 8, 2, 0, 0, 0]);
		for (const c of list) expect(c.crc).toBe(crc32(Buffer.concat([Buffer.from(c.type, "latin1"), c.data])));
		expect(list[2]!.crc.toString(16)).toBe("ae426082");

		const raw = inflateSync(list[1]!.data);
		expect(raw.length).toBe(H * (1 + W * 3));
		for (let y = 0; y < H; y++) {
			const row = raw.subarray(y * (1 + W * 3), (y + 1) * (1 + W * 3));
			expect(row[0]).toBe(0);
			expect(row.subarray(1)).toEqual(EXPECTED_RGB.subarray(y * W * 3, (y + 1) * W * 3));
		}
	});
});

/** A recording fake: geometry 1280×800, a title per call, the synthetic XWD for xwd, "" otherwise. */
function recorder(overrides: (argv: readonly string[]) => BufferRunResult | Promise<BufferRunResult> | undefined = () => undefined) {
	const calls: string[][] = [];
	const run: BufferRunner = async (argv) => {
		calls.push([...argv]);
		const override = await overrides(argv);
		if (override) return override;
		if (argv.includes("getdisplaygeometry")) return res("1280 800\n");
		if (argv.includes("getwindowname")) return res(`Terminal ${calls.length}\n`);
		if (argv.includes("xwd")) return res(xwd({ byteOrder: 0 }));
		return res("");
	};
	return { calls, run };
}

const FIXED = Date.UTC(2026, 8, 26, 18, 30, 5);
const noSleep = async () => {};
const SMOKE: DesktopRunInput = {
	actions: [
		{ type: "key", keys: "ctrl+alt+t" },
		{ type: "type", text: "TYPED-SECRET-TEXT" },
		{ type: "key", keys: "Return" },
		{ type: "screenshot" },
	],
	timeout: 30,
};

describe("createDesktopDriver", () => {
	test("runs geometry first, then each action and a title read; writes a 0600 PNG; emits 4 redaction-safe events", async () => {
		const shotsDir = tmpShots();
		const { calls, run } = recorder();
		const events: DesktopActionEvent[] = [];
		const driver = createDesktopDriver({ run, shotsDir, now: () => FIXED, sleep: noSleep, emit: async (e) => void events.push(e) });

		const result = await driver.run(SMOKE, { surface: "omp" });

		expect(calls).toEqual([
			geometryArgv(),
			keyArgv({ type: "key", keys: "ctrl+alt+t" }),
			titleArgv(),
			typeArgv({ type: "type", text: "TYPED-SECRET-TEXT" }),
			titleArgv(),
			keyArgv({ type: "key", keys: "Return" }),
			titleArgv(),
			shotArgv(),
			titleArgv(),
		]);
		expect(result.run_id).toMatch(/^dr-20260926T183005Z-[0-9a-f]{6}$/);
		expect(result.log.map((l) => [l.i, l.type, l.ok, l.active_window])).toEqual([
			[0, "key", true, "Terminal 3"],
			[1, "type", true, "Terminal 5"],
			[2, "key", true, "Terminal 7"],
			[3, "screenshot", true, "Terminal 9"],
		]);

		const path = join(shotsDir, result.run_id, "1.png");
		const bytes = readFileSync(path);
		expect(result.screenshots).toEqual([
			{ path, width: W, height: H, sha256: createHash("sha256").update(bytes).digest("hex") },
		]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(shotsDir, result.run_id)).mode & 0o777).toBe(0o700);
		expect(result.images).toEqual([bytes.toString("base64")]);

		expect(events).toHaveLength(4);
		expect(JSON.stringify(events)).not.toContain("TYPED-SECRET-TEXT");
		expect(events.every((e) => e.kind === "desktop.action" && e.surface === "omp")).toBe(true);
		expect(events.map((e) => e.summary)).toEqual(["desktop key ok", "desktop type ok", "desktop key ok", "desktop screenshot ok"]);
		expect(events[1]!.payload).toMatchObject({
			run_id: result.run_id,
			i: 1,
			type: "type",
			ok: true,
			text_chars: 17,
			text_sha256: createHash("sha256").update("TYPED-SECRET-TEXT").digest("hex"),
		});
		expect(events[0]!.payload).toMatchObject({ keys: "ctrl+alt+t", active_window: "Terminal 3" });
		expect(events[3]!.payload).toMatchObject({ screenshot_path: path, screenshot_sha256: result.screenshots[0]!.sha256 });
	});

	test("an out-of-bounds click is refused after the geometry read, before any input and with no event", async () => {
		const { calls, run } = recorder();
		const events: DesktopActionEvent[] = [];
		const driver = createDesktopDriver({ run, shotsDir: tmpShots(), sleep: noSleep, emit: async (e) => void events.push(e) });

		const outcome = driver.run({ actions: [{ type: "key", keys: "a" }, { type: "click", x: 1280, y: 10 }], timeout: 30 }, { surface: "omp" });

		await expect(outcome).rejects.toThrow(/outside the 1280x800 display/);
		expect(calls).toEqual([geometryArgv()]);
		expect(events).toEqual([]);
	});

	test("a call past the per-action timeout is logged as timeout and stops the run", async () => {
		let clock = FIXED;
		const { calls, run } = recorder((argv) => {
			// 1 ms of the run left: the driver's own per-action timer is what this test exercises, so a
			// fake clock cannot stand in for it; the hung call never settles, so there is no race.
			if (argv.includes("getdisplaygeometry")) clock = FIXED + 30_000 - 1;
			if (argv.includes("key")) return Promise.withResolvers<BufferRunResult>().promise;
			return undefined;
		});
		const events: DesktopActionEvent[] = [];
		const driver = createDesktopDriver({ run, shotsDir: tmpShots(), now: () => clock, sleep: noSleep, emit: async (e) => void events.push(e) });

		const result = await driver.run({ actions: [{ type: "key", keys: "Return" }, { type: "screenshot" }], timeout: 30 }, { surface: "omp" });

		expect(result.log).toEqual([{ i: 0, type: "key", ok: false, ms: expect.any(Number), active_window: null, error: "timeout" }]);
		expect(calls).toHaveLength(2);
		expect(events.map((e) => e.payload.error)).toEqual(["timeout"]);
	});

	test("the run deadline stops the remaining actions with deadline", async () => {
		let clock = FIXED;
		const { calls, run } = recorder(() => {
			clock += 20_000;
			return undefined;
		});
		const driver = createDesktopDriver({ run, shotsDir: tmpShots(), now: () => clock, sleep: noSleep, emit: async () => {} });

		const result = await driver.run(
			{ actions: [{ type: "key", keys: "a" }, { type: "key", keys: "b" }, { type: "key", keys: "c" }], timeout: 30 },
			{ surface: "omp" },
		);

		expect(result.log.map((l) => [l.i, l.ok, l.error])).toEqual([
			[0, true, undefined],
			[1, false, "deadline"],
		]);
		expect(calls.some((argv) => argv.at(-1) === "b" || argv.at(-1) === "c")).toBe(false);
	});

	test("a type action's budget grows with its text; the title read keeps the full budget after the deadline", async () => {
		let clock = FIXED;
		const budgets: Array<[string, number]> = [];
		const run: BufferRunner = async (argv, timeoutMs) => {
			budgets.push([argv[6]!, timeoutMs]);
			if (argv.includes("type")) clock = FIXED + 120_000; // typing ends exactly at the run deadline
			return res(argv.includes("getdisplaygeometry") ? "1280 800\n" : "w\n");
		};
		const driver = createDesktopDriver({ run, shotsDir: tmpShots(), now: () => clock, sleep: noSleep, emit: async () => {} });

		const result = await driver.run(
			{ actions: [{ type: "type", text: "x".repeat(300) }, { type: "key", keys: "Return" }], timeout: 120 },
			{ surface: "omp" },
		);

		expect(budgets).toEqual([
			["getdisplaygeometry", ACTION_TIMEOUT_MS],
			["type", ACTION_TIMEOUT_MS + 300 * TYPE_MS_PER_CHAR],
			["getactivewindow", ACTION_TIMEOUT_MS],
		]);
		expect(result.log.map((l) => [l.ok, l.active_window, l.error])).toEqual([
			[true, "w", undefined],
			[false, null, "deadline"],
		]);
	});

	test("a stopped or missing container fails the run as not running", async () => {
		for (const stderr of ["Error response from daemon: container 1917e37f is not running", "Error: No such container: substrate-desktop"]) {
			const { run } = recorder(() => res("", 1, stderr));
			const driver = createDesktopDriver({ run, shotsDir: tmpShots(), sleep: noSleep, emit: async () => {} });

			await expect(driver.run(SMOKE, { surface: "omp" })).rejects.toThrow("substrate-desktop is not running");
		}
	});

	test("a failed title read gives active_window null without failing the action; a throwing emit changes nothing", async () => {
		const noTitle = recorder((argv) => (argv.includes("getwindowname") ? res("", 1, "XGetWindowProperty failed") : undefined));
		const quiet = createDesktopDriver({ run: noTitle.run, shotsDir: tmpShots(), sleep: noSleep, emit: async () => {} });
		const plain = await quiet.run({ actions: [{ type: "key", keys: "Return" }], timeout: 30 }, { surface: "omp" });
		expect(plain.log).toEqual([{ i: 0, type: "key", ok: true, ms: expect.any(Number), active_window: null }]);

		for (const emit of [
			() => {
				throw new Error("greptime down");
			},
			async () => {
				throw new Error("greptime down");
			},
		]) {
			const { run } = recorder((argv) => (argv.includes("getwindowname") ? res("", 1, "no window") : undefined));
			const driver = createDesktopDriver({ run, shotsDir: tmpShots(), sleep: noSleep, emit: emit as never });
			const result = await driver.run({ actions: [{ type: "key", keys: "Return" }], timeout: 30 }, { surface: "omp" });
			expect(result.log).toEqual(plain.log.map((l) => ({ ...l, ms: expect.any(Number) })));
		}
	});

	test("two concurrent runs on separate drivers never interleave (process-wide mutex)", async () => {
		const order: string[] = [];
		const tagged = (tag: string): BufferRunner => async (argv) => {
			order.push(tag);
			if (argv.includes("getdisplaygeometry")) return res("1280 800\n");
			return res("w\n");
		};
		const input: DesktopRunInput = { actions: [{ type: "key", keys: "a" }, { type: "type", text: "x" }, { type: "key", keys: "b" }], timeout: 30 };
		const a = createDesktopDriver({ run: tagged("A"), shotsDir: tmpShots(), sleep: noSleep, emit: async () => {} });
		const b = createDesktopDriver({ run: tagged("B"), shotsDir: tmpShots(), sleep: noSleep, emit: async () => {} });

		await Promise.all([a.run(input, { surface: "omp" }), b.run(input, { surface: "hermes" })]);

		expect(order.join("")).toBe("A".repeat(7) + "B".repeat(7));
	});

	test("retention keeps at most 200 runs, none older than 7 days, and always the new run", async () => {
		const shotsDir = tmpShots();
		const now = Date.now();
		for (let n = 0; n < 205; n++) {
			const dir = join(shotsDir, `dr-20260901T000000Z-${n.toString(16).padStart(6, "0")}`);
			mkdirSync(dir, { recursive: true });
			const age = n < 5 ? 8 * 86_400_000 : (n - 4) * 60_000; // 5 older than 7 days, 200 recent
			utimesSync(dir, (now - age) / 1000, (now - age) / 1000);
		}
		const { run } = recorder();
		const driver = createDesktopDriver({ run, shotsDir, sleep: noSleep, emit: async () => {} });

		const result = await driver.run({ actions: [{ type: "screenshot" }], timeout: 30 }, { surface: "omp" });

		const left = readdirSync(shotsDir);
		expect(left.length).toBeLessThanOrEqual(200);
		expect(left).toContain(result.run_id);
		for (const name of left) expect(now - statSync(join(shotsDir, name)).mtimeMs).toBeLessThan(7 * 86_400_000);
	});
});
