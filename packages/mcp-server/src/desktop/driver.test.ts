import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "../types.ts";
import { contextArgv, geometryArgv, keyArgv, shotArgv, titleArgv, typeArgv, type DesktopRunInput } from "./actions.ts";
import {
	ACTION_TIMEOUT_MS,
	bufferRunner,
	type BufferRunner,
	type BufferRunResult,
	childEnv,
	createDesktopDriver,
	DesktopBusy,
	keyFields,
	serveIdentity,
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
	fields.forEach((value, i) => {
		header.writeUInt32BE(value, i * 4);
	});
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

/** A recording fake: geometry 1280×800, a title per call, the synthetic XWD for xwd, a local docker socket for the context probe, "" otherwise. */
function recorder(overrides: (argv: readonly string[]) => BufferRunResult | Promise<BufferRunResult> | undefined = () => undefined) {
	const calls: string[][] = [];
	const run: BufferRunner = async (argv) => {
		calls.push([...argv]);
		const override = await overrides(argv);
		if (override) return override;
		if (argv.includes("getdisplaygeometry")) return res("1280 800\n");
		if (argv.includes("getwindowname")) return res(`Terminal ${calls.length}\n`);
		if (argv.includes("xwd")) return res(xwd({ byteOrder: 0 }));
		if (argv[1] === "context") return res("unix:///var/run/docker.sock\n");
		return res("");
	};
	return { calls, run };
}

const FIXED = Date.UTC(2026, 8, 26, 18, 30, 5);
const noSleep = async () => {};
const storedTrue = async () => ({ stored: true });
const recording = (events: EventInput[]) => async (event: EventInput) => {
	events.push(event);
	return { stored: true };
};
const SMOKE: DesktopRunInput = {
	actions: [
		{ type: "key", keys: "ctrl+alt+t" },
		{ type: "type", text: "TYPED-SECRET-TEXT" },
		{ type: "key", keys: "Return" },
		{ type: "screenshot" },
	],
	timeout: 30,
};

describe("keyFields (D30-11 tightened rule)", () => {
	test("records modifier chords and fixed non-printing keys verbatim", () => {
		expect(keyFields("ctrl+alt+t")).toEqual({ keys: "ctrl+alt+t" });
		expect(keyFields("Return")).toEqual({ keys: "Return" });
		expect(keyFields("ctrl+alt+t Return")).toEqual({ keys: "ctrl+alt+t Return" });
		expect(keyFields("alt+F4")).toEqual({ keys: "alt+F4" });
		expect(keyFields("F5")).toEqual({ keys: "F5" });
		expect(keyFields("Control_L")).toEqual({ keys: "Control_L" });
		expect(keyFields("KP_Enter")).toEqual({ keys: "KP_Enter" });
	});

	test("hashes shift chords, keypad digits and punctuation keysyms that would spell text", () => {
		for (const keys of ["shift+a", "KP_1", "space", "period", "a", "ctrl+alt+t password"]) {
			expect(keyFields(keys)).toEqual({
				keys_len: keys.length,
				keys_sha256: createHash("sha256").update(keys).digest("hex"),
			});
		}
	});
});

describe("childEnv (D30-07 allowlist)", () => {
	test("passes only PATH and HOME, even with a poisoned parent", () => {
		// Built at runtime so no credential name sits in a tracked file next to a value.
		const tokenKey = ["SUBSTRATE", "TOKEN", "OMP"].join("_");
		const ledgerKey = ["GREPTIME", "PASSWORD"].join("_");
		const poisoned: Record<string, string | undefined> = {
			PATH: "/usr/bin",
			HOME: "/home/u",
			[tokenKey]: "x",
			[ledgerKey]: "y",
		};

		expect(childEnv(poisoned)).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
	});

	test("falls back to a standard PATH and /root", () => {
		expect(childEnv({})).toEqual({
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			HOME: "/root",
		});
	});
});

describe("createDesktopDriver", () => {
	test("runs a locality probe, then geometry, then each action and a title read; writes a 0600 PNG; emits 4 tool.call events", async () => {
		const shotsDir = tmpShots();
		const { calls, run } = recorder();
		const events: EventInput[] = [];
		const driver = createDesktopDriver({ run, dir: shotsDir, now: () => FIXED, sleep: noSleep });

		const result = await driver.run(SMOKE, { surface: "omp", emit: recording(events) });

		expect(calls).toEqual([
			contextArgv(),
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
		expect(result.error).toBeUndefined();
		expect(result.log.map((l) => [l.i, l.type, l.ok, l.active_window])).toEqual([
			[0, "key", true, "Terminal 4"],
			[1, "type", true, "Terminal 6"],
			[2, "key", true, "Terminal 8"],
			[3, "screenshot", true, "Terminal 10"],
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
		expect(JSON.stringify(events)).not.toContain("iVBOR");
		expect(events.every((e) => e.kind === "tool.call" && e.surface === "omp" && e.actor === "agent")).toBe(true);
		expect(events.map((e) => e.session_id)).toEqual(Array(4).fill(`desktop:${result.run_id}`));
		expect(events.map((e) => e.summary)).toEqual(["desktop key ok", "desktop type ok", "desktop key ok", "desktop screenshot ok"]);
		expect(Object.keys(events[0]!.payload!).sort()).toEqual(["action", "i", "keys", "ms", "ok", "run_id", "tool"]);
		expect(Object.keys(events[1]!.payload!).sort()).toEqual(["action", "i", "ms", "ok", "run_id", "text_len", "text_sha256", "tool"]);
		expect(Object.keys(events[2]!.payload!).sort()).toEqual(["action", "i", "keys", "ms", "ok", "run_id", "tool"]);
		expect(Object.keys(events[3]!.payload!).sort()).toEqual(["action", "height", "i", "ms", "ok", "run_id", "sha256", "tool", "width"]);
		expect(events[1]!.payload).toMatchObject({
			tool: "desktop_run",
			action: "type",
			run_id: result.run_id,
			i: 1,
			ok: true,
			text_len: 17,
			text_sha256: createHash("sha256").update("TYPED-SECRET-TEXT").digest("hex"),
		});
		expect(events[0]!.payload).toMatchObject({ keys: "ctrl+alt+t" });
		expect(events[2]!.payload).toMatchObject({ keys: "Return" });
		expect(events[3]!.payload).toMatchObject({
			sha256: result.screenshots[0]!.sha256,
			width: W,
			height: H,
		});
	});

	test("hashes key sequences that would spell text, with no keys field anywhere", async () => {
		const { run } = recorder();
		const events: EventInput[] = [];
		const driver = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });

		await driver.run(
			{ actions: [{ type: "key", keys: "shift+a" }, { type: "key", keys: "KP_1" }, { type: "key", keys: "space" }], timeout: 30 },
			{ surface: "omp", emit: recording(events) },
		);

		expect(events).toHaveLength(3);
		for (const [event, keys] of events.map((e, n) => [e, ["shift+a", "KP_1", "space"][n]!] as const)) {
			expect(event.payload).toMatchObject({
				keys_len: keys.length,
				keys_sha256: createHash("sha256").update(keys).digest("hex"),
			});
			expect(event.payload).not.toHaveProperty("keys");
		}
		expect(JSON.stringify(events)).not.toContain("shift");
	});

	test("an out-of-bounds click is refused after the geometry read, before any input and with no event", async () => {
		const { calls, run } = recorder();
		const events: EventInput[] = [];
		const driver = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });

		const outcome = driver.run(
			{ actions: [{ type: "key", keys: "a" }, { type: "click", x: 1280, y: 10 }], timeout: 30 },
			{ surface: "omp", emit: storedTrue },
		);

		await expect(outcome).rejects.toThrow(/outside the 1280x800 display/);
		expect(calls).toEqual([contextArgv(), geometryArgv()]);
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
		const events: EventInput[] = [];
		const driver = createDesktopDriver({ run, dir: tmpShots(), now: () => clock, sleep: noSleep });

		const result = await driver.run(
			{ actions: [{ type: "key", keys: "Return" }, { type: "screenshot" }], timeout: 30 },
			{ surface: "omp", emit: recording(events) },
		);

		expect(result.log).toEqual([{ i: 0, type: "key", ok: false, ms: expect.any(Number), active_window: null, error: "timeout" }]);
		expect(calls).toHaveLength(3);
		expect(events.map((e) => e.payload!.error)).toEqual(["timeout"]);
	});

	test("the run deadline stops the remaining actions with deadline and no event for the not-started action", async () => {
		let clock = FIXED;
		const { calls, run } = recorder((argv) => {
			// The local probe answers at once: the test's clock models docker round trips.
			if (argv[1] === "context") return res("unix:///var/run/docker.sock\n");
			clock += 20_000;
			return undefined;
		});
		const events: EventInput[] = [];
		const driver = createDesktopDriver({ run, dir: tmpShots(), now: () => clock, sleep: noSleep });

		const result = await driver.run(
			{ actions: [{ type: "key", keys: "a" }, { type: "key", keys: "b" }, { type: "key", keys: "c" }], timeout: 30 },
			{ surface: "omp", emit: recording(events) },
		);

		expect(result.log.map((l) => [l.i, l.ok, l.error])).toEqual([
			[0, true, undefined],
			[1, false, "deadline"],
		]);
		expect(calls.some((argv) => argv.at(-1) === "b" || argv.at(-1) === "c")).toBe(false);
		expect(events.map((e) => e.payload!.i)).toEqual([0]);
	});

	test("a type action's budget grows with its text; the title read keeps the full budget after the deadline", async () => {
		let clock = FIXED;
		const budgets: Array<[string | undefined, number]> = [];
		const run: BufferRunner = async (argv, timeoutMs) => {
			budgets.push([argv[6], timeoutMs]);
			if (argv[1] === "context") return res("unix:///var/run/docker.sock\n");
			if (argv.includes("type")) clock = FIXED + 120_000; // typing ends exactly at the run deadline
			return res(argv.includes("getdisplaygeometry") ? "1280 800\n" : "w\n");
		};
		const driver = createDesktopDriver({ run, dir: tmpShots(), now: () => clock, sleep: noSleep });

		const result = await driver.run(
			{ actions: [{ type: "type", text: "x".repeat(300) }, { type: "key", keys: "Return" }], timeout: 120 },
			{ surface: "omp", emit: storedTrue },
		);

		expect(budgets).toEqual([
			// The locality probe leads: five argv hold no sixth word.
			[undefined, ACTION_TIMEOUT_MS],
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
			const { run } = recorder((argv) => (argv.includes("getdisplaygeometry") ? res("", 1, stderr) : undefined));
			const driver = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });

			await expect(driver.run(SMOKE, { surface: "omp", emit: storedTrue })).rejects.toThrow("substrate-desktop is not running");
		}
	});

	test("a failed title read gives active_window null without failing the action", async () => {
		const noTitle = recorder((argv) => (argv.includes("getwindowname") ? res("", 1, "XGetWindowProperty failed") : undefined));
		const quiet = createDesktopDriver({ run: noTitle.run, dir: tmpShots(), sleep: noSleep });
		const plain = await quiet.run({ actions: [{ type: "key", keys: "Return" }] }, { surface: "omp", emit: storedTrue });
		expect(plain.log).toEqual([{ i: 0, type: "key", ok: true, ms: expect.any(Number), active_window: null }]);
	});

	test("an unstored event stops the run with the D30-12 error and no images", async () => {
		for (const emit of [
			async () => ({ stored: false }),
			async () => {
				throw new Error("greptime down");
			},
		]) {
			const { run } = recorder();
			const driver = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });
			const result = await driver.run(
				{ actions: [{ type: "key", keys: "Return" }, { type: "key", keys: "Return" }], timeout: 30 },
				{ surface: "omp", emit },
			);
			expect(result.error).toBe("event not stored after action 0; run stopped");
			expect(result.images).toEqual([]);
			expect(result.log).toHaveLength(1);
		}
	});

	test("a second run while one is active is refused at once, naming the active run (D30-08)", async () => {
		const calls: string[][] = [];
		let release!: (result: BufferRunResult) => void;
		const gate = new Promise<BufferRunResult>((resolve) => {
			release = resolve;
		});
		const run: BufferRunner = async (argv) => {
			calls.push([...argv]);
			if (argv[1] === "context") return res("unix:///var/run/docker.sock\n");
			if (argv.includes("getdisplaygeometry")) return res("1280 800\n");
			if (argv.includes("getwindowname")) return res("w\n");
			return gate;
		};
		const input: DesktopRunInput = { actions: [{ type: "key", keys: "Return" }], timeout: 30 };
		const a = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });
		const b = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });

		const pending = a.run(input, { surface: "omp", emit: storedTrue });
		const refused = await b.run(input, { surface: "hermes", emit: storedTrue }).then(
			() => null,
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(DesktopBusy);
		expect((refused as Error).message).toContain("nothing was run");
		release(res(""));
		const done = await pending;

		expect((refused as DesktopBusy).runId).toBe(done.run_id);
		expect((refused as Error).message).toContain(done.run_id);
		expect(calls).toEqual([contextArgv(), geometryArgv(), keyArgv({ type: "key", keys: "Return" }), titleArgv()]);
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
		const driver = createDesktopDriver({ run, dir: shotsDir, sleep: noSleep });

		const result = await driver.run({ actions: [{ type: "screenshot" }], timeout: 30 }, { surface: "omp", emit: storedTrue });

		const left = readdirSync(shotsDir);
		expect(left.length).toBeLessThanOrEqual(200);
		expect(left).toContain(result.run_id);
		for (const name of left) expect(now - statSync(join(shotsDir, name)).mtimeMs).toBeLessThan(7 * 86_400_000);
	});
	describe("docker locality preflight", () => {
		test("a non-local context endpoint refuses the run before anything runs, naming no endpoint", async () => {
			const { calls, run } = recorder((argv) => (argv[1] === "context" ? res("tcp://other-host:2375\n") : undefined));
			const driver = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });

			const refused = await driver.run(SMOKE, { surface: "omp", emit: storedTrue }).then(
				() => null,
				(error: unknown) => error,
			);

			expect(refused).toBeInstanceOf(Error);
			expect((refused as Error).message).toContain("is not local");
			expect((refused as Error).message).not.toContain("other-host");
			expect((refused as Error).message).not.toContain("tcp://");
			expect(calls).toEqual([contextArgv()]);
		});

		test("an empty context endpoint refuses the run before anything runs", async () => {
			const { calls, run } = recorder((argv) => (argv[1] === "context" ? res("\n") : undefined));
			const driver = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });

			const refused = await driver.run(SMOKE, { surface: "omp", emit: storedTrue }).then(
				() => null,
				(error: unknown) => error,
			);

			expect(refused).toBeInstanceOf(Error);
			expect((refused as Error).message).toContain("is empty");
			expect(calls).toEqual([contextArgv()]);
		});

		test("a local socket endpoint proceeds to the geometry read", async () => {
			const { calls, run } = recorder((argv) => (argv[1] === "context" ? res("unix:///var/run/docker.sock\n") : undefined));
			const events: EventInput[] = [];
			const driver = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });

			const result = await driver.run({ actions: [{ type: "key", keys: "Return" }] }, { surface: "omp", emit: recording(events) });

			expect(result.log[0]?.ok).toBe(true);
			expect(calls[0]).toEqual(contextArgv());
			expect(events).toHaveLength(1);
		});

		test("a failed probe refuses the run before anything runs, naming no stderr", async () => {
			const { calls, run } = recorder((argv) =>
				argv[1] === "context" ? res("", 1, "cannot connect to the Docker daemon at tcp://other-host:2375") : undefined,
			);
			const driver = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });

			const refused = await driver.run(SMOKE, { surface: "omp", emit: storedTrue }).then(
				() => null,
				(error: unknown) => error,
			);

			expect(refused).toBeInstanceOf(Error);
			expect((refused as Error).message).toContain("docker context probe failed; refusing desktop_run");
			expect((refused as Error).message).not.toContain("other-host");
			expect(calls).toEqual([contextArgv()]);
		});

		test("a hung context probe refuses the run before any action runs, naming no endpoint", async () => {
			let hang = true;
			const { calls, run } = recorder((argv) => (argv[1] === "context" && hang ? new Promise<BufferRunResult>(() => {}) : undefined));
			const events: EventInput[] = [];
			const driver = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });

			const refused = await driver
				.run({ actions: [{ type: "key", keys: "Return" }], timeout: 1 }, { surface: "omp", emit: recording(events) })
				.then(
					() => null,
					(error: unknown) => error,
				);

			expect(refused).toBeInstanceOf(Error);
			expect((refused as Error).message).toContain("docker context probe timed out; refusing desktop_run");
			expect(calls).toEqual([contextArgv()]);
			expect(events).toEqual([]);

			hang = false;
			const later = await driver.run({ actions: [{ type: "key", keys: "Return" }], timeout: 30 }, { surface: "omp", emit: recording(events) });
			expect(later.log[0]?.ok).toBe(true);
			expect(events).toHaveLength(1);
		});
	});

	describe("failure diagnostics carry no caller text", () => {
		test("bufferRunner never substitutes the argv-bearing error message for empty stderr", async () => {
			const result = await bufferRunner(["/definitely/not/a/real/binary-9f3k", "TYPE-TEXT-MUST-NOT-LEAK"], 5000);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toBe("");
		});

		test("a failed type whose child echoes the text stores only the fixed diagnostic", async () => {
			const secret = "TYPE-TEXT-MUST-NOT-LEAK";
			const { run } = recorder((argv) => (argv.includes("type") ? res(`xdotool failed typing ${secret}\n`, 1, `cannot type ${secret}\n`) : undefined));
			const events: EventInput[] = [];
			const driver = createDesktopDriver({ run, dir: tmpShots(), sleep: noSleep });

			const result = await driver.run({ actions: [{ type: "type", text: secret }], timeout: 30 }, { surface: "omp", emit: recording(events) });

			expect(result.log).toEqual([{ i: 0, type: "type", ok: false, ms: expect.any(Number), active_window: null, error: "action failed with exit 1" }]);
			expect(events).toHaveLength(1);
			expect(events[0]?.payload).toMatchObject({ ok: false, error: "action failed with exit 1" });
			expect(JSON.stringify(events)).not.toContain(secret);
			expect(JSON.stringify(result)).not.toContain(secret);
		});
	});

	describe("host-wide exclusion (D30-21)", () => {
		/** A port no other test holds: bound ephemeral, then released. */
		async function freePort(): Promise<number> {
			const probe = createServer();
			await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
			const port = (probe.address() as AddressInfo).port;
			await new Promise<void>((resolve) => probe.close(() => resolve()));
			return port;
		}

		test("a live lock from another process refuses the run, naming its run", async () => {
			const port = await freePort();
			const other = "dr-20260901T000000Z-abcdef";
			const holder = createServer((socket) => socket.end(`${process.pid} ${other}`, "utf8"));
			await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", () => resolve()));
			try {
				const { calls, run } = recorder();
				const driver = createDesktopDriver({ run, dir: tmpShots(), lockPort: port, sleep: noSleep });

				const refused = await driver
					.run({ actions: [{ type: "key", keys: "Return" }] }, { surface: "omp", emit: storedTrue })
					.then(
						() => null,
						(error: unknown) => error,
					);

				expect(refused).toBeInstanceOf(DesktopBusy);
				expect((refused as DesktopBusy).runId).toBe(other);
				expect((refused as Error).message).toContain(other);
				expect(calls).toEqual([]);
			} finally {
				await new Promise<void>((resolve) => holder.close(() => resolve()));
			}
		});

		test("the mutex releases when the run ends, so the next run proceeds", async () => {
			const port = await freePort();
			const driver = createDesktopDriver({ run: recorder().run, dir: tmpShots(), lockPort: port, sleep: noSleep });

			const first = await driver.run({ actions: [{ type: "key", keys: "Return" }] }, { surface: "omp", emit: storedTrue });
			expect(first.log[0]?.ok).toBe(true);
			const second = await driver.run({ actions: [{ type: "key", keys: "Return" }] }, { surface: "omp", emit: storedTrue });
			expect(second.log[0]?.ok).toBe(true);

			// The port is free again: another server can bind it.
			const probe = createServer();
			await new Promise<void>((resolve) => probe.listen(port, "127.0.0.1", () => resolve()));
			await new Promise<void>((resolve) => probe.close(() => resolve()));
		});

		test("answering a reset probe fails silently, never crashing", async () => {
			const port = await freePort();
			const server = createServer();
			await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
			try {
				const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
				const probe = createConnection(port, "127.0.0.1");
				probe.on("error", () => {});
				const acceptedSocket = await accepted;
				// Abortive reset: the RST lands before answering, so the write
				// must fail — and fail silently instead of crashing.
				probe.resetAndDestroy();
				await new Promise<void>((resolve) => probe.once("close", () => resolve()));
				for (let n = 0; n < 20; n++) await new Promise((resolve) => setImmediate(resolve));
				let crashed: unknown = null;
				const watcher = (cause: unknown): void => {
					crashed = cause;
				};
				process.once("uncaughtException", watcher);
				try {
					serveIdentity(acceptedSocket, "dr-20260901T000000Z-abcdef");
					for (let n = 0; n < 20; n++) await new Promise((resolve) => setImmediate(resolve));
				} finally {
					process.removeListener("uncaughtException", watcher);
				}
				expect(crashed).toBeNull();
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		});

		/**
		 * Holds the host lock from a real run parked at its geometry read, so the lock
		 * server is the driver's own. `release` lets the run finish and free the port.
		 */
		async function holdLock(port: number): Promise<{ release: () => Promise<void> }> {
			const reached = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const { run } = recorder((argv) => {
				if (!argv.includes("getdisplaygeometry")) return undefined;
				reached.resolve();
				return gate.promise.then(() => res("1280 800\n"));
			});
			const driver = createDesktopDriver({ run, dir: tmpShots(), lockPort: port, sleep: noSleep });
			const running = driver.run({ actions: [{ type: "key", keys: "Return" }] }, { surface: "omp", emit: storedTrue });
			await reached.promise;
			return { release: async () => { gate.resolve(); await running; } };
		}

		/** A client that connects and never reads, so the server's side of the socket stays open. */
		function openIdle(port: number): Promise<Socket> {
			const socket = createConnection(port, "127.0.0.1");
			socket.on("error", () => {});
			const { promise, resolve } = Promise.withResolvers<Socket>();
			socket.once("connect", () => resolve(socket));
			return promise;
		}

		/** Reads what the server sends before it closes; "" when the server drops the connection unanswered. */
		async function readToClose(socket: Socket): Promise<string> {
			let text = "";
			socket.setEncoding("utf8");
			socket.on("error", () => {});
			socket.on("data", (chunk: string) => {
				text += chunk;
			});
			const { promise, resolve } = Promise.withResolvers<void>();
			socket.once("close", () => resolve());
			await promise;
			return text;
		}

		test("the lock serves at most four connections; a fifth is dropped unanswered", async () => {
			const port = await freePort();
			const held = await holdLock(port);
			try {
				const idle = await Promise.all([openIdle(port), openIdle(port), openIdle(port), openIdle(port)]);
				expect(await readToClose(await openIdle(port))).toBe("");
				for (const socket of idle) socket.destroy();
			} finally {
				await held.release();
			}
		});

		test("a lock connection idle past the identity timeout frees its slot", async () => {
			const port = await freePort();
			const held = await holdLock(port);
			try {
				const idle = await Promise.all([openIdle(port), openIdle(port), openIdle(port), openIdle(port)]);
				// Real time on purpose: the identity timeout is a net-layer socket timer that fake timers cannot advance.
				await Bun.sleep(3_000);
				const text = await readToClose(await openIdle(port));
				expect(text).toMatch(/^\d+ dr-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
				for (const socket of idle) socket.destroy();
			} finally {
				await held.release();
			}
		}, 15_000);
	});

	describe("screenshot storage errors stay out of the event", () => {
		test("a failed screenshot write stores the fixed diagnostic, never the path", async () => {
			const parent = mkdtempSync(join(tmpdir(), "desktop-lock-"));
			dirs.push(parent);
			const shotFile = join(parent, "shots");
			writeFileSync(shotFile, "not a dir");
			const { run } = recorder();
			const events: EventInput[] = [];
			const driver = createDesktopDriver({ run, dir: shotFile, sleep: noSleep });

			const result = await driver.run({ actions: [{ type: "screenshot" }] }, { surface: "omp", emit: recording(events) });

			expect(result.log).toEqual([{ i: 0, type: "screenshot", ok: false, ms: expect.any(Number), active_window: null, error: "screenshot failed" }]);
			expect(events).toHaveLength(1);
			expect(events[0]?.payload).toMatchObject({ ok: false, error: "screenshot failed" });
			expect(JSON.stringify(events)).not.toContain(shotFile);
			expect(JSON.stringify(result)).not.toContain(shotFile);
		});
	});
});
