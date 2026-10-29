import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopRunInput } from "../packages/mcp-server/src/desktop/actions.ts";
import { decodePng, encodePng } from "../packages/mcp-server/src/desktop/png.ts";
import { RehearsalRefused, refuseSmokeUrl } from "./rehearsal.ts";
import { dumpedHoldsTyped, findBand, markerText, nonceRgb, parseRpcBody, parseSmokeArgs, probeTimeoutMs, refuseUnprovenDockerLocality, sha256Hex, shouldRetryNonce, type NonceRgb } from "./desktop-smoke.ts";

/** Paint a test frame: background wash plus solid exact-RGB rectangles. */
function paintImage(width: number, height: number, bg: NonceRgb, rects: Array<{ x: number; y: number; w: number; h: number; color: NonceRgb }>): Buffer {
	const rgb = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 3;
			rgb[at] = bg.r;
			rgb[at + 1] = bg.g;
			rgb[at + 2] = bg.b;
		}
	}
	for (const rect of rects) {
		for (let y = rect.y; y < rect.y + rect.h; y++) {
			for (let x = rect.x; x < rect.x + rect.w; x++) {
				const at = (y * width + x) * 3;
				rgb[at] = rect.color.r;
				rgb[at + 1] = rect.color.g;
				rgb[at + 2] = rect.color.b;
			}
		}
	}
	return rgb;
}

describe("parseSmokeArgs", () => {
	test("defaults name the proof instance and surfaces", () => {
		expect(parseSmokeArgs([])).toEqual({ name: "p30", surface: "omp", unlisted: "cursor" });
	});

	test("flags override each default", () => {
		expect(parseSmokeArgs(["--name", "p30-retry", "--surface", "cursor", "--unlisted", "omp"])).toEqual({
			name: "p30-retry",
			surface: "cursor",
			unlisted: "omp",
		});
	});

	test("an unknown option refuses", () => {
		expect(() => parseSmokeArgs(["--url", "http://127.0.0.1:17410"])).toThrow(RehearsalRefused);
	});

	test("a flag without a value refuses", () => {
		expect(() => parseSmokeArgs(["--name"])).toThrow(RehearsalRefused);
	});

	test("a stray positional refuses", () => {
		expect(() => parseSmokeArgs(["p30"])).toThrow(RehearsalRefused);
	});
});

describe("sha256Hex", () => {
	test("matches the known digest", () => {
		expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});

describe("nonceRgb", () => {
	test("one channel reaches 0xC0 for every nonce tried", () => {
		for (const nonce of ["", "a", "00", "substrate-smoke-deadbeef", "f".repeat(64), "Terminal - substrate-smoke-6155f173"]) {
			const color = nonceRgb(nonce);
			expect(Math.max(color.r, color.g, color.b) >= 0xc0).toBe(true);
			for (const channel of [color.r, color.g, color.b]) {
				expect(channel >= 0 && channel <= 255 && Number.isInteger(channel)).toBe(true);
			}
		}
	});

	test("the same nonce derives the same colour", () => {
		expect(nonceRgb("stable-nonce")).toEqual(nonceRgb("stable-nonce"));
	});
});

describe("shouldRetryNonce", () => {
	test("retries a polluted baseline from a clean run until attempts run out", () => {
		expect(shouldRetryNonce(1, 1, true)).toBe(true);
		expect(shouldRetryNonce(140, 2, true)).toBe(true);
		expect(shouldRetryNonce(0, 1, true)).toBe(false);
		expect(shouldRetryNonce(1, 3, true)).toBe(false);
		expect(shouldRetryNonce(0, 3, true)).toBe(false);
	});

	test("never retries an attempt whose actions did not all succeed", () => {
		expect(shouldRetryNonce(1, 1, false)).toBe(false);
		expect(shouldRetryNonce(140, 2, false)).toBe(false);
	});
});

describe("markerText", () => {
	test("parses as a type action under the closed vocabulary", () => {
		const text = markerText("abc123", { r: 200, g: 10, b: 30 });
		const parsed = DesktopRunInput.parse({ actions: [{ type: "type", text }], timeout: 30 });
		expect(parsed.actions.length).toBe(1);
		expect(text.length).toBeLessThanOrEqual(2000);
	});

	test("escape sequences are typed literally with one real trailing newline", () => {
		const text = markerText("abc123", { r: 200, g: 10, b: 30 });
		expect(text.includes("\\033")).toBe(true);
		expect(text.includes("\\n")).toBe(true);
		expect(text.endsWith("\n")).toBe(true);
		expect(text.includes("48;2;200;10;30")).toBe(true);
		expect(text.includes("substrate-smoke-abc123")).toBe(true);
	});

	test("no control character besides tab and the trailing newline", () => {
		const text = markerText("abc123", { r: 200, g: 10, b: 30 });
		let controlFound = false;
		for (const ch of text) {
			const code = ch.codePointAt(0) ?? 0;
			if (code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) controlFound = true;
		}
		expect(controlFound).toBe(false);
	});
});

describe("findBand", () => {
	const bg: NonceRgb = { r: 10, g: 10, b: 10 };
	const fg: NonceRgb = { r: 220, g: 30, b: 40 };

	test("finds an exact rectangle through the PNG round trip", () => {
		const rgb = paintImage(64, 48, bg, [{ x: 5, y: 7, w: 48, h: 19, color: fg }]);
		const shot = decodePng(encodePng(64, 48, rgb));
		const band = findBand(shot.rgb, shot.width, shot.height, fg);
		expect(band.count).toBe(48 * 19);
		expect(band.rect).toEqual({ x: 5, y: 7, w: 48, h: 19 });
		expect(band.solid).toBe(true);
	});

	test("an absent colour reports an empty band", () => {
		const rgb = paintImage(64, 48, bg, [{ x: 5, y: 7, w: 48, h: 19, color: fg }]);
		const shot = decodePng(encodePng(64, 48, rgb));
		const band = findBand(shot.rgb, shot.width, shot.height, { r: 1, g: 2, b: 3 });
		expect(band.count).toBe(0);
		expect(band.rect).toBeNull();
		expect(band.solid).toBe(false);
	});

	test("split blobs count but are not solid", () => {
		const rgb = paintImage(64, 48, bg, [
			{ x: 1, y: 1, w: 4, h: 4, color: fg },
			{ x: 20, y: 20, w: 4, h: 4, color: fg },
		]);
		const shot = decodePng(encodePng(64, 48, rgb));
		const band = findBand(shot.rgb, shot.width, shot.height, fg);
		expect(band.count).toBe(32);
		expect(band.solid).toBe(false);
	});
});

describe("smoke target guard", () => {
	test("production ports refuse", () => {
		for (const port of [7410, 7411, 6420]) {
			expect(refuseSmokeUrl(`http://127.0.0.1:${port}/mcp`)).not.toBeNull();
		}
	});

	test("a non-loopback host refuses", () => {
		expect(refuseSmokeUrl("http://192.168.1.5:17410/mcp")).not.toBeNull();
	});

	test("a loopback twin passes", () => {
		expect(refuseSmokeUrl("http://127.0.0.1:17410/mcp")).toBeNull();
	});
});

describe("refuseUnprovenDockerLocality", () => {
	test("a failed or timed-out probe refuses with the could-not-prove reason", () => {
		expect(refuseUnprovenDockerLocality({ ok: false, out: "" })).toContain("could not prove the local docker endpoint");
		// A probe that died after printing a local-looking endpoint still proves nothing.
		expect(refuseUnprovenDockerLocality({ ok: false, out: "unix:///var/run/docker.sock\n" })).toContain("could not prove the local docker endpoint");
	});

	test("an empty answer refuses", () => {
		expect(refuseUnprovenDockerLocality({ ok: true, out: "\n" })).toContain("refusing without locality proof");
	});

	test("a non-local endpoint refuses", () => {
		expect(refuseUnprovenDockerLocality({ ok: true, out: "tcp://other-host:2375\n" })).toContain("refusing non-local docker endpoint");
	});

	test("a local unix socket proceeds", () => {
		expect(refuseUnprovenDockerLocality({ ok: true, out: "unix:///var/run/docker.sock\n" })).toBeNull();
	});
});

describe("parseRpcBody", () => {
	test("plain JSON passes through", () => {
		expect(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
	});

	test("an SSE envelope yields its last data frame with the image block intact", () => {
		const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"},{"type":"image","data":"QUJD","mimeType":"image/png"}]}}\n\n';
		const parsed: unknown = parseRpcBody(sse);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !("result" in parsed)) {
			throw new Error("expected a result envelope");
		}
		const result: unknown = parsed.result;
		if (result === null || typeof result !== "object" || Array.isArray(result) || !("content" in result) || !Array.isArray(result.content)) {
			throw new Error("expected a content array");
		}
		expect(result.content.length).toBe(2);
		const image: unknown = result.content[1];
		if (image === null || typeof image !== "object" || Array.isArray(image) || !("data" in image)) {
			throw new Error("expected an image block");
		}
		expect(image.data).toBe("QUJD");
	});

	test("garbage yields null", () => {
		expect(parseRpcBody("not json at all")).toBeNull();
	});
});

describe("dumpedHoldsTyped", () => {
	test("catches the full marker stored in a payload, trailing newline included", () => {
		const marker = markerText("abcdef01", { r: 0xc0, g: 0x11, b: 0x22 });
		// A ledger row (or audit line) as the smoke reads it: parsed, then
		// re-stringified — newlines and backslashes escaped.
		const dumped = JSON.stringify([{ kind: "tool.call", payload: { tool: "desktop_run", action: "type", text_len: marker.length } }, marker]);
		expect(marker.endsWith("\n")).toBe(true);
		expect(dumped.includes(marker)).toBe(false);
		expect(dumpedHoldsTyped(dumped, [marker, "exit\n"])).toBe(true);
	});

	test("clean rows with hashes only do not trip it", () => {
		const dumped = JSON.stringify([{ kind: "tool.call", payload: { tool: "desktop_run", action: "type", text_len: 90, text_sha256: "ab".repeat(32) } }]);
		expect(dumpedHoldsTyped(dumped, ["exit\n"])).toBe(false);
	});
});

describe("probeTimeoutMs", () => {
	test("defaults to 10 s and accepts only a positive integer seam", () => {
		expect(probeTimeoutMs([])).toBe(10_000);
		expect(probeTimeoutMs(["--name", "x", "--probe-timeout-ms", "250"])).toBe(250);
		expect(probeTimeoutMs(["--probe-timeout-ms"])).toBe(10_000);
		for (const bad of ["", "0", "-5", "1.5", "soon"]) {
			expect(probeTimeoutMs(["--probe-timeout-ms", bad])).toBe(10_000);
		}
	});
});

// The real entry point, run as a child process: a fake `docker` first on PATH
// logs every call, and a local HTTP server counts every request. The smoke
// must refuse (exit 2) on an unproven locality probe before it sends one.
const SMOKE = join(import.meta.dir, "desktop-smoke.ts");
const smokeMade: string[] = [];
afterAll(() => {
	for (const dir of smokeMade.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type ProbeBehaviour = "broken" | "hang" | "local";

interface SmokeRun {
	code: number;
	err: string;
	dockerLog: string[];
	requests: number;
	ms: number;
}

/** Run the smoke's `main` against a counting twin and a fake docker. */
async function runSmoke(probe: ProbeBehaviour, extraArgs: string[] = []): Promise<SmokeRun> {
	const dir = mkdtempSync(join(tmpdir(), "desktop-smoke-entry-"));
	smokeMade.push(dir);
	const stubDir = join(dir, "bin");
	const logFile = join(dir, "docker.log");
	const tokensDir = join(dir, "tokens");
	const runtime = join(dir, "run");
	mkdirSync(stubDir);
	mkdirSync(tokensDir);
	mkdirSync(join(runtime, "substrate-rehearsal", "entry"), { recursive: true });
	writeFileSync(logFile, "");
	// The smoke hands `docker` only PATH and HOME, so the log path is baked in.
	const answer = probe === "broken" ? "exit 1" : probe === "hang" ? "exec sleep 30" : 'echo "unix:///var/run/docker.sock"';
	writeFileSync(join(stubDir, "docker"), `#!/usr/bin/env bash\necho "docker $*" >>"${logFile}"\n${answer}\n`, { mode: 0o755 });
	writeFileSync(join(tokensDir, "omp"), "tok-omp\n");
	writeFileSync(join(tokensDir, "cursor"), "tok-cursor\n");

	let requests = 0;
	const twin = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch() {
			requests++;
			return new Response("no", { status: 500 });
		},
	});
	try {
		writeFileSync(
			join(runtime, "substrate-rehearsal", "entry", "consumer.env"),
			`export SUBSTRATE_URL='http://127.0.0.1:${twin.port}'\nexport SUBSTRATE_REHEARSAL_TOKENS_DIR='${tokensDir}'\n`,
		);
		const start = Date.now();
		const child = Bun.spawn([process.execPath, SMOKE, "--name", "entry", ...extraArgs], {
			env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: dir, XDG_RUNTIME_DIR: runtime },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		return {
			code,
			err,
			dockerLog: readFileSync(logFile, "utf8").split("\n").filter((line) => line.length > 0),
			requests,
			ms: Date.now() - start,
		};
	} finally {
		twin.stop(true);
	}
}

describe("desktop-smoke entry point locality gate", () => {
	test("a failed probe exits 2 before any request or further docker call", async () => {
		const run = await runSmoke("broken");
		expect(run.code).toBe(2);
		expect(run.err).toContain("could not prove the local docker endpoint");
		expect(run.requests).toBe(0);
		expect(run.dockerLog).toEqual(["docker context inspect --format {{.Endpoints.docker.Host}}"]);
	});

	test("a hung probe is bounded by the timeout seam, exits 2, sends nothing", async () => {
		const run = await runSmoke("hang", ["--probe-timeout-ms", "500"]);
		expect(run.code).toBe(2);
		expect(run.err).toContain("could not prove the local docker endpoint");
		expect(run.ms).toBeLessThan(8_000);
		expect(run.requests).toBe(0);
		expect(run.dockerLog).toEqual(["docker context inspect --format {{.Endpoints.docker.Host}}"]);
	});

	test("a proven local socket proceeds to the first request (the counter is wired)", async () => {
		const run = await runSmoke("local");
		expect(run.code).toBe(2);
		expect(run.err).toContain("is not answering /healthz");
		expect(run.requests).toBe(1);
		expect(run.dockerLog).toEqual(["docker context inspect --format {{.Endpoints.docker.Host}}"]);
	});
});
