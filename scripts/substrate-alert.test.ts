/**
 * The failure-alert CLI: one warning, a bounded wait for the server, and exit 0
 * whatever happens. Environments are injected objects; the tokens directory is
 * always pointed at a scratch path so no host token can be read.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUEST_TIMEOUT_MS } from "./doctor-runtime.ts";
import {
	type AlertEvent,
	type AlertIo,
	DEFAULT_WAIT_S,
	MAX_WAIT_S,
	normalizeResult,
	normalizeUnit,
	parseTarget,
	POLL_MS,
	PROBE_TIMEOUT_MS,
	runAlert,
	SHOW_TIMEOUT_MS,
} from "./substrate-alert.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "substrate-alert-"));
const NO_TOKENS = join(SCRATCH, "no-such-tokens");
const BEARER = "bearer-first-0123456789ab";
const OTHER = "bearer-second-ba9876543210";
const STAMP = "2026-10-14T08:00:00.000Z";

interface Rig {
	io: AlertIo;
	posts: Array<{ url: string; body: AlertEvent; bearer: string }>;
	probes: string[];
	shows: string[];
	sleeps: number[];
	stderr: string[];
}

function rig(
	env: Record<string, string | undefined>,
	options: { post?: AlertIo["post"]; probeUpAfter?: number; show?: string | null } = {},
): Rig {
	const posts: Rig["posts"] = [];
	const probes: string[] = [];
	const shows: string[] = [];
	const sleeps: number[] = [];
	const stderr: string[] = [];
	const clock = { now: 0 };
	const io: AlertIo = {
		env: { SUBSTRATE_TOKENS_DIR: NO_TOKENS, ...env },
		showResult(unit) {
			shows.push(unit);
			return options.show === undefined ? null : options.show;
		},
		async probe(url) {
			probes.push(url);
			return options.probeUpAfter !== undefined && probes.length > options.probeUpAfter;
		},
		post:
			options.post ??
			(async (url, body, bearer) => {
				posts.push({ url, body, bearer });
				return true;
			}),
		async sleep(ms) {
			sleeps.push(ms);
			clock.now += ms;
		},
		now: () => clock.now,
		stderr: (text) => stderr.push(text),
	};
	return { io, posts, probes, shows, sleeps, stderr };
}

const FAILED = { MONITOR_SERVICE_RESULT: "watchdog", SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "0" };

describe("runAlert", () => {
	test("posts exactly one warning with the unit and result, as the substrate surface, to SUBSTRATE_URL/events, and exits 0", async () => {
		const r = rig({ ...FAILED, SUBSTRATE_URL: "http://127.0.0.1:7410/" });
		expect(await runAlert(["substrate-mcp.service"], r.io, STAMP)).toBe(0);
		expect(r.posts).toHaveLength(1);
		expect(r.posts[0]?.url).toBe("http://127.0.0.1:7410/events");
		expect(r.posts[0]?.body).toEqual({
			surface: "substrate",
			kind: "warning",
			summary: "unit failed: substrate-mcp.service (watchdog)",
			session_id: `alert:${STAMP}`,
			payload: { action: "alert", runtime: "alert", unit: "substrate-mcp.service", result: "watchdog" },
		});
		expect(r.posts[0]?.bearer).toBe(BEARER);
		expect(r.stderr.join("")).toContain("posted one warning");
		// The bearer goes in the Authorization header only: never in the body or on stderr.
		expect(JSON.stringify(r.posts[0]?.body)).not.toContain(BEARER);
		expect(r.stderr.join("")).not.toContain(BEARER);
	});

	test("a failed POST, a rejected POST and a throwing POST all still exit 0 after exactly one attempt", async () => {
		let attempts = 0;
		const refused = rig(FAILED, {
			post: async () => {
				attempts += 1;
				return false;
			},
		});
		expect(await runAlert(["substrate-mcp.service"], refused.io, STAMP)).toBe(0);
		expect(attempts).toBe(1);
		expect(refused.stderr.join("")).toContain("was not stored");
		let rejects = 0;
		const rejected = rig(FAILED, {
			post: async () => {
				rejects += 1;
				throw new Error("network down");
			},
		});
		expect(await runAlert(["substrate-mcp.service"], rejected.io, STAMP)).toBe(0);
		expect(rejects).toBe(1);
		let syncThrows = 0;
		const sync = rig(FAILED, {
			post: () => {
				syncThrows += 1;
				throw new Error("sync failure");
			},
		});
		expect(await runAlert(["substrate-mcp.service"], sync.io, STAMP)).toBe(0);
		expect(syncThrows).toBe(1);
	});

	test("the bearer is the first entry of a rotated token list, never the whole list", async () => {
		const comma = rig({ MONITOR_SERVICE_RESULT: "signal", SUBSTRATE_TOKEN_SUBSTRATE: `${BEARER},${OTHER}`, SUBSTRATE_ALERT_WAIT_S: "0" });
		await runAlert(["substrate-mcp.service"], comma.io, STAMP);
		expect(comma.posts.map((p) => p.bearer)).toEqual([BEARER]);
		const spaced = rig({ MONITOR_SERVICE_RESULT: "signal", SUBSTRATE_TOKEN_SUBSTRATE: ` \n${BEARER} ${OTHER}`, SUBSTRATE_ALERT_WAIT_S: "0" });
		await runAlert(["substrate-mcp.service"], spaced.io, STAMP);
		expect(spaced.posts.map((p) => p.bearer)).toEqual([BEARER]);
	});

	test("a unit name that is not a plain .service name is refused before any command, probe or post", async () => {
		for (const bad of ["", "substrate-mcp", "../etc/passwd.service", "a b.service", "x;rm.service", `${"a".repeat(80)}.service`, "substrate\\x2dmcp.service/evil"]) {
			const r = rig(FAILED);
			expect(await runAlert([bad], r.io, STAMP)).toBe(0);
			expect(r.posts).toHaveLength(0);
			expect(r.probes).toHaveLength(0);
			expect(r.shows).toHaveLength(0);
		}
		const none = rig(FAILED);
		expect(await runAlert([], none.io, STAMP)).toBe(0);
		expect(none.posts).toHaveLength(0);
	});

	test("a success result posts nothing: a deploy restart is not an incident", async () => {
		const r = rig({ ...FAILED, MONITOR_SERVICE_RESULT: undefined, SERVICE_RESULT: "success" });
		expect(await runAlert(["substrate-mcp.service"], r.io, STAMP)).toBe(0);
		expect(r.posts).toHaveLength(0);
		expect(r.probes).toHaveLength(0);
		const viaShow = rig({ ...FAILED, MONITOR_SERVICE_RESULT: undefined }, { show: "success\n" });
		await runAlert(["substrate-mcp.service"], viaShow.io, STAMP);
		expect(viaShow.shows).toEqual(["substrate-mcp.service"]);
		expect(viaShow.posts).toHaveLength(0);
	});

	test("the result falls back to systemctl show, and anything outside systemd's Result words is `unknown`", async () => {
		const shown = rig({ ...FAILED, MONITOR_SERVICE_RESULT: undefined }, { show: "oom-kill\n" });
		await runAlert(["substrate-mcp.service"], shown.io, STAMP);
		expect(shown.posts[0]?.body.payload.result).toBe("oom-kill");
		const unreadable = rig({ ...FAILED, MONITOR_SERVICE_RESULT: undefined }, { show: null });
		await runAlert(["substrate-mcp.service"], unreadable.io, STAMP);
		expect(unreadable.posts[0]?.body.payload.result).toBe("unknown");
		const hostile = rig({ ...FAILED, MONITOR_SERVICE_RESULT: "exit-code\nSECRET=hunter2 and a very long tail ".repeat(20) });
		await runAlert(["substrate-mcp.service"], hostile.io, STAMP);
		expect(hostile.posts[0]?.body.payload.result).toBe("unknown");
		expect(JSON.stringify(hostile.posts)).not.toContain("hunter2");
		expect(hostile.posts[0]?.body.summary.length).toBeLessThanOrEqual(200);
		expect(normalizeResult("timeout")).toBe("timeout");
		expect(normalizeResult("__proto__")).toBe("unknown");
		expect(normalizeResult("toString")).toBe("unknown");
		expect(normalizeUnit("substrate-mcp.service")).toBe("substrate-mcp.service");
	});

	test("no bearer: nothing is posted, the reason is named without a value, and it still exits 0", async () => {
		const r = rig({ MONITOR_SERVICE_RESULT: "watchdog", SUBSTRATE_ALERT_WAIT_S: "0" });
		expect(await runAlert(["substrate-mcp.service"], r.io, STAMP)).toBe(0);
		expect(r.posts).toHaveLength(0);
		expect(r.stderr.join("")).toContain("no bearer");
	});

	test("it waits for /livez (a GET, repeatable) and then posts once", async () => {
		const r = rig({ MONITOR_SERVICE_RESULT: "watchdog", SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "30" }, { probeUpAfter: 3 });
		await runAlert(["substrate-mcp.service"], r.io, STAMP);
		expect(r.probes).toEqual(Array(4).fill("http://127.0.0.1:7410/livez"));
		expect(r.sleeps).toEqual([1000, 1000, 1000]);
		expect(r.posts).toHaveLength(1);
	});

	test("a server that never answers is waited for up to the bound, then the one POST is made anyway", async () => {
		const r = rig({ MONITOR_SERVICE_RESULT: "watchdog", SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "5" });
		await runAlert(["substrate-mcp.service"], r.io, STAMP);
		expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(5000);
		expect(r.probes.length).toBe(6);
		expect(r.posts).toHaveLength(1);
		expect(r.stderr.join("")).toContain("did not answer /livez");
	});

	test("the wait is 60 s by default, bounded at 60, and 0 skips it", async () => {
		expect(DEFAULT_WAIT_S).toBe(60);
		const dflt = rig({ MONITOR_SERVICE_RESULT: "watchdog", SUBSTRATE_TOKEN: BEARER });
		await runAlert(["substrate-mcp.service"], dflt.io, STAMP);
		expect(dflt.sleeps.reduce((a, b) => a + b, 0)).toBe(60_000);
		const bad = rig({ MONITOR_SERVICE_RESULT: "watchdog", SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "9999" });
		await runAlert(["substrate-mcp.service"], bad.io, STAMP);
		expect(bad.sleeps.reduce((a, b) => a + b, 0)).toBe(60_000);
		const zero = rig({ MONITOR_SERVICE_RESULT: "watchdog", SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "0" });
		await runAlert(["substrate-mcp.service"], zero.io, STAMP);
		expect(zero.probes).toHaveLength(0);
		expect(zero.posts).toHaveLength(1);
	});

	test("a wait above the cap falls back to the default: 61 and 300 are refused, 60 is allowed", async () => {
		expect(MAX_WAIT_S).toBe(60);
		for (const value of ["61", "300"]) {
			const r = rig({ MONITOR_SERVICE_RESULT: "watchdog", SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: value });
			await runAlert(["substrate-mcp.service"], r.io, STAMP);
			expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(60_000);
		}
		const ok = rig({ MONITOR_SERVICE_RESULT: "watchdog", SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "30" });
		await runAlert(["substrate-mcp.service"], ok.io, STAMP);
		expect(ok.sleeps.reduce((a, b) => a + b, 0)).toBe(30_000);
	});

	test("the result the caller passed beats systemctl show: a hang whose unit already reads success is still alerted", async () => {
		// The ExecStopPost path: the restart has begun, `systemctl show` still says success from before.
		const suffix = rig({ SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "0" }, { show: "success\n" });
		await runAlert(["substrate-mcp.service:watchdog"], suffix.io, STAMP);
		expect(suffix.posts).toHaveLength(1);
		expect(suffix.posts[0]?.body.payload).toMatchObject({ unit: "substrate-mcp.service", result: "watchdog" });
		expect(suffix.shows).toEqual([]);
		const second = rig({ SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "0" }, { show: "success\n" });
		await runAlert(["substrate-mcp.service", "oom-kill"], second.io, STAMP);
		expect(second.posts[0]?.body.payload.result).toBe("oom-kill");
		// It also beats the environment.
		const overEnv = rig({ ...FAILED, MONITOR_SERVICE_RESULT: "success" }, { show: "success\n" });
		await runAlert(["substrate-mcp.service:signal"], overEnv.io, STAMP);
		expect(overEnv.posts[0]?.body.payload.result).toBe("signal");
	});

	test("only exactly `success` skips: a passed success posts nothing, near-misses post as unknown", async () => {
		const skip = rig({ SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "0" });
		await runAlert(["substrate-mcp.service:success"], skip.io, STAMP);
		expect(skip.posts).toHaveLength(0);
		for (const near of ["Success", "success ", "succes"]) {
			const r = rig({ SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "0" });
			await runAlert(["substrate-mcp.service", near], r.io, STAMP);
			expect(r.posts).toHaveLength(1);
			expect(r.posts[0]?.body.payload.result).toBe("unknown");
		}
		expect(normalizeResult("success\n")).toBe("unknown");
	});

	test("an empty suffix (an empty $SERVICE_RESULT) falls back to the environment and then systemctl show", async () => {
		const viaShow = rig({ SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "0" }, { show: "timeout\n" });
		await runAlert(["substrate-mcp.service:"], viaShow.io, STAMP);
		expect(viaShow.shows).toEqual(["substrate-mcp.service"]);
		expect(viaShow.posts[0]?.body.payload.result).toBe("timeout");
		expect(parseTarget(["substrate-mcp.service:"])).toEqual({ unit: "substrate-mcp.service", result: undefined });
		expect(parseTarget(["substrate-mcp.service:watchdog"])).toEqual({ unit: "substrate-mcp.service", result: "watchdog" });
		expect(parseTarget(["x.service:../evil"])?.unit).toBe("x.service:../evil");
		expect(normalizeUnit(parseTarget(["x.service:../evil"])?.unit)).toBeNull();
	});

	test("TimeoutStartSec in the unit file exceeds the alert's worst case: show + wait cap + probe + poll + POST", () => {
		const unit = readFileSync(join(import.meta.dir, "..", "infra", "vps", "substrate-alert@.service"), "utf8");
		const seconds = Number(/^TimeoutStartSec=(\d+)$/m.exec(unit)?.[1]);
		const worstMs = SHOW_TIMEOUT_MS + MAX_WAIT_S * 1000 + PROBE_TIMEOUT_MS + POLL_MS + REQUEST_TIMEOUT_MS;
		expect(Number.isFinite(seconds)).toBe(true);
		expect(seconds * 1000).toBeGreaterThan(worstMs);
	});

	test("a probe that throws is a miss, not a crash", async () => {
		const r = rig({ MONITOR_SERVICE_RESULT: "watchdog", SUBSTRATE_TOKEN: BEARER, SUBSTRATE_ALERT_WAIT_S: "2" });
		r.io.probe = async () => {
			throw new Error("refused");
		};
		expect(await runAlert(["substrate-mcp.service"], r.io, STAMP)).toBe(0);
		expect(r.posts).toHaveLength(1);
	});
});

describe("the CLI process", () => {
	test("exits 0 when the post cannot be delivered, and prints no token", () => {
		const env = {
			PATH: process.env.PATH ?? "",
			HOME: SCRATCH,
			SUBSTRATE_TOKENS_DIR: NO_TOKENS,
			SUBSTRATE_TOKEN: BEARER,
			SUBSTRATE_URL: "http://127.0.0.1:1",
			SUBSTRATE_ALERT_WAIT_S: "0",
			MONITOR_SERVICE_RESULT: "watchdog",
		};
		const run = Bun.spawnSync(["bun", join(import.meta.dir, "substrate-alert.ts"), "substrate-mcp.service"], { env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
		expect(run.exitCode).toBe(0);
		const output = `${run.stdout.toString()}${run.stderr.toString()}`;
		expect(output).toContain("was not stored");
		expect(output).not.toContain(BEARER);
	});

	test("exits 0 on a refused unit name", () => {
		const run = Bun.spawnSync(["bun", join(import.meta.dir, "substrate-alert.ts"), "../../x"], {
			env: { PATH: process.env.PATH ?? "", HOME: SCRATCH, SUBSTRATE_TOKENS_DIR: NO_TOKENS },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30_000,
		});
		expect(run.exitCode).toBe(0);
		expect(run.stderr.toString()).toContain("refused");
	});
});
