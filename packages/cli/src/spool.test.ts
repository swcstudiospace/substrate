/**
 * `substrate spool status|flush` and `substrate emit` with the spool on: what
 * the operator sees (never an event body), what the exit codes mean, and the
 * whole round trip through the real CLI process against a loopback stub.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSpool } from "../../collectors/src/spool.ts";
import { isolateSpoolEnv, isolatedChildEnv } from "../../collectors/src/spool-test-env.ts";
import { resetSpoolReplayState, type DrainResult } from "../../collectors/src/emit.ts";
import { runSpool, type SpoolStatusReport } from "./spool.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(ROOT, "packages/cli/src/index.ts");
const MARKER = "event-body-marker-never-printed";

let restoreEnv: () => void = () => undefined;
let stateDir = "";

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "cli-spool-"));
	// Every spool and credential variable cleared (spool explicitly off) so an inherited cap changes no default asserted here.
	restoreEnv = isolateSpoolEnv();
	process.env.SUBSTRATE_STATE_DIR = stateDir;
	resetSpoolReplayState();
});

afterEach(() => {
	restoreEnv();
});

function park(count: number, at = Date.now()): void {
	const spool = new EventSpool({ path: join(stateDir, "event-spool.jsonl"), now: () => at });
	for (let i = 0; i < count; i += 1) {
		spool.append({
			key: `key-${String(i).padStart(6, "0")}`,
			collector: "t",
			source: "t.row",
			event: { surface: "claude-code", kind: "note", summary: `${MARKER} ${i}`, payload: { marker: MARKER } },
			reason: "unreachable",
		});
	}
}

function capture(): { out: string[]; err: string[]; deps: { out: (text: string) => void; err: (text: string) => void } } {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, deps: { out: (text) => out.push(text), err: (text) => err.push(text) } };
}

describe("status", () => {
	test("reports depth, bytes, oldest age, due count and caps, and never an event body", async () => {
		park(3, Date.now() - 90_000);
		const io = capture();

		const code = await runSpool(["status"], { ...io.deps, now: () => Date.now() });

		expect(code).toBe(0);
		const text = io.out.join("");
		expect(text).toContain("depth: 3 (due 3, malformed 0)");
		expect(text).toMatch(/oldest age: (89|9\d)s/);
		expect(text).toContain("caps: max=5000 max_bytes=8388608 ttl_h=48 max_attempts=12");
		expect(text).toContain("event spool: off");
		expect(text).not.toContain(MARKER);
		expect(text).not.toContain("key-0000");
	});

	test("--json carries the same fields and the drop counters by cause, still without a body", async () => {
		park(2);
		writeFileSync(
			join(stateDir, "refused-emits.jsonl"),
			[
				{ ts: "2026-01-01T00:00:00.000Z", collector: "t", source: "s", kind: "dropped", surface: "claude-code", status: 0, error: "spool-overflow event_kind=note" },
				{ ts: "2026-01-01T00:00:00.000Z", collector: "t", source: "s", kind: "dropped", surface: "claude-code", status: 0, error: "spool-ttl more=7" },
				{ ts: "2026-01-01T00:00:00.000Z", collector: "t", source: "s", kind: "note", surface: "claude-code", status: 400, error: "refused, not a drop" },
			]
				.map((row) => JSON.stringify(row))
				.join("\n"),
		);
		process.env.SUBSTRATE_EVENT_SPOOL = "on";
		const io = capture();

		await runSpool(["status", "--json"], io.deps);

		const report = JSON.parse(io.out.join("")) as SpoolStatusReport;
		expect(report).toMatchObject({ mode: "on", depth: 2, due: 0, malformed: 0, dropped: { overflow: 1, ttl: 7 } });
		expect(report.bytes).toBeGreaterThan(0);
		expect(io.out.join("")).not.toContain(MARKER);
	});

	test("an empty or absent spool reads zero and creates nothing", async () => {
		const io = capture();

		await runSpool(["status", "--json"], io.deps);

		expect(JSON.parse(io.out.join(""))).toMatchObject({ depth: 0, bytes: 0, oldest_age_s: null, due: 0, dropped: {} });
		expect(readdirSync(stateDir)).toEqual([]);
	});
});

describe("flush", () => {
	test("with the flag off it does nothing, says so, exits 0, and touches no file", async () => {
		park(1);
		const before = readFileSync(join(stateDir, "event-spool.jsonl"), "utf8");
		const io = capture();

		const code = await runSpool(["flush"], io.deps);

		expect(code).toBe(0);
		expect(io.out.join("")).toContain("event spool is off");
		expect(readFileSync(join(stateDir, "event-spool.jsonl"), "utf8")).toBe(before);
	});

	test("replays everything regardless of backoff, under the budget it was given, and exits 0 whatever happened", async () => {
		const calls: Array<{ all: boolean; budgetMs: number }> = [];
		const results: DrainResult[] = [
			{ status: "ran", delivered: 2, refused: 1, retried: 0, skipped: 0, dropped: 0, held: null, budgetExhausted: false, remaining: 0, readFailed: false, writeFailed: false },
			{ status: "held", reason: "idempotency-off", dropped: 0, remaining: 4 },
			{ status: "ran", delivered: 0, refused: 0, retried: 0, skipped: 0, dropped: 0, held: "unreachable", budgetExhausted: false, remaining: 4, readFailed: false, writeFailed: false },
		];
		const lines: string[] = [];
		for (const result of results) {
			const io = capture();
			const code = await runSpool(["flush", "--budget-ms", "5000"], {
				...io.deps,
				drain: async (opts) => {
					calls.push(opts);
					return result;
				},
			});
			expect(code).toBe(0);
			lines.push(io.out.join("").trim());
		}

		expect(calls).toEqual([
			{ all: true, budgetMs: 5000 },
			{ all: true, budgetMs: 5000 },
			{ all: true, budgetMs: 5000 },
		]);
		expect(lines[0]).toBe("delivered=2 refused=1 retried=0 dropped=0 remaining=0");
		expect(lines[1]).toBe("replay held: idempotency-off; the spool is kept (remaining=4) and retried later");
		expect(lines[2]).toContain("replay stopped early (unreachable), the rest is kept");
	});

	test("a flush that could not read or write the spool says so, and never reports a write that failed as a removal", async () => {
		const results: DrainResult[] = [
			{ status: "ran", delivered: 0, refused: 0, retried: 0, skipped: 0, dropped: 0, held: null, budgetExhausted: false, remaining: 3, readFailed: false, writeFailed: true },
			{ status: "held", reason: "spool-unreadable", dropped: 0, remaining: 4, failure: "read" },
			{ status: "held", reason: "healthz-auth", dropped: 0, remaining: 4, failure: "write" },
		];
		const lines: string[] = [];
		for (const result of results) {
			const io = capture();
			expect(await runSpool(["flush"], { ...io.deps, drain: async () => result })).toBe(0);
			lines.push(io.out.join(""));
		}

		expect(lines[0]).toContain("write failed, settled entries are still in the file and were not counted as removed");
		expect(lines[1]).toContain("spool file could not be read, nothing was changed");
		expect(lines[2]).toContain("write failed, settled entries are still in the file");
	});

	test("a held result with an unknown depth prints no remaining clause, and the JSON keeps null", async () => {
		const held: DrainResult = { status: "held", reason: "spool-unreadable", dropped: 0, remaining: null, failure: "read" };
		const text = capture();
		const json = capture();

		await runSpool(["flush"], { ...text.deps, drain: async () => held });
		await runSpool(["flush", "--json"], { ...json.deps, drain: async () => held });

		expect(text.out.join("")).not.toContain("remaining");
		expect(text.out.join("")).toContain("spool file could not be read, nothing was changed");
		expect(JSON.parse(json.out.join("")).remaining).toBeNull();
	});

	test("status reports an unreadable spool instead of an empty one", async () => {
		mkdirSync(join(stateDir, "event-spool.jsonl"));
		const io = capture();

		await runSpool(["status"], io.deps);

		expect(io.out.join("")).toContain("unreadable: EISDIR");
		expect(io.out.join("")).toContain("depth: 0");
	});

	test("the default budget is 30 s and an absurd one is clamped", async () => {
		const budgets: number[] = [];
		const drain = async (opts: { all: boolean; budgetMs: number }): Promise<DrainResult> => {
			budgets.push(opts.budgetMs);
			return { status: "off" };
		};

		await runSpool(["flush"], { ...capture().deps, drain });
		await runSpool(["flush", "--budget-ms", "999999999"], { ...capture().deps, drain });

		expect(budgets).toEqual([30_000, 600_000]);
	});
});

describe("usage errors exit 1", () => {
	test("no subcommand, an unknown one, an unknown flag, a flag from the other subcommand, a bad budget", async () => {
		for (const argv of [[], ["purge"], ["status", "--apply"], ["status", "--budget-ms", "5"], ["flush", "--nope"], ["flush", "--budget-ms"], ["flush", "--budget-ms", "0"], ["flush", "--budget-ms", "soon"], ["status", "positional"]]) {
			const io = capture();
			const code = await runSpool(argv, { ...io.deps, drain: async () => ({ status: "off" }) });
			expect({ argv, code, usage: io.err.join("").startsWith("usage: substrate spool") }).toEqual({ argv, code: 1, usage: true });
		}
	});
});

/** The real CLI, a real stub: emit parks on an outage, flush replays once the server is ready. */
describe("the CLI end to end", () => {
	const stubs: Array<{ stop: (force?: boolean) => void }> = [];
	afterAll(() => {
		for (const server of stubs) server.stop(true);
	});

	async function cli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
		const child = Bun.spawn(["bun", "--no-env-file", CLI, ...args], {
			cwd: ROOT,
			env: isolatedChildEnv(env),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		return { code, stdout, stderr };
	}

	test("emit with the spool on parks an outage event and exits 0; flush replays it with the marker once the server accepts", async () => {
		const seen: Array<{ path: string; replay: string | null; body: string }> = [];
		let ledgerUp = false;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) => {
				const path = new URL(req.url).pathname;
				seen.push({ path, replay: req.headers.get("x-substrate-replay"), body: await req.text() });
				if (path === "/healthz") return Response.json({ idempotency: "accept", greptime: true });
				return ledgerUp ? Response.json({ stored: true }, { status: 202 }) : Response.json({ stored: false, error: "ledger down" }, { status: 503 });
			},
		});
		stubs.push(server);
		const env = { SUBSTRATE_URL: `http://127.0.0.1:${server.port}`, SUBSTRATE_STATE_DIR: stateDir, SUBSTRATE_EVENT_SPOOL: "on" };

		const emitted = await cli(["emit", "--kind", "note", "--summary", `${MARKER} outage`, "--repo", "o/r", "--branch", "b", "--surface", "claude-code"], env);
		expect(emitted.code).toBe(0);
		const spoolText = readFileSync(join(stateDir, "event-spool.jsonl"), "utf8");
		expect(spoolText.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
		const live = seen.find((hit) => hit.path === "/events");
		expect(live?.replay).toBeNull();
		expect(JSON.parse(live?.body ?? "{}")).toMatchObject({ kind: "note", repo: "o/r" });

		const status = await cli(["spool", "status"], env);
		expect(status.code).toBe(0);
		expect(status.stdout).toContain("depth: 1");
		expect(status.stdout).not.toContain(MARKER);

		ledgerUp = true;
		const flushed = await cli(["spool", "flush"], env);
		expect(flushed.code).toBe(0);
		expect(flushed.stdout).toContain("delivered=1");
		const replay = seen.filter((hit) => hit.path === "/events").at(-1);
		expect(replay?.replay).toBe("1");
		expect(replay?.body).toBe(live?.body as string);
		expect(readFileSync(join(stateDir, "event-spool.jsonl"), "utf8")).toBe("");
	});

	test("emit with the flag off is the single POST it always was and writes no file; flush says the spool is off", async () => {
		let events = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => {
				if (new URL(req.url).pathname === "/events") events += 1;
				return Response.json({ stored: false }, { status: 503 });
			},
		});
		stubs.push(server);
		const env = { SUBSTRATE_URL: `http://127.0.0.1:${server.port}`, SUBSTRATE_STATE_DIR: stateDir };

		const emitted = await cli(["emit", "--kind", "note", "--summary", "off", "--repo", "o/r", "--branch", "b"], env);
		const flushed = await cli(["spool", "flush"], env);

		expect(emitted.code).toBe(0);
		expect(events).toBe(1);
		expect(readdirSync(stateDir)).toEqual([]);
		expect(flushed.code).toBe(0);
		expect(flushed.stdout).toContain("event spool is off");
		expect(existsSync(join(stateDir, "event-spool.jsonl"))).toBe(false);
	});

	test("a usage error exits 1 and the help text lists the command", async () => {
		const bad = await cli(["spool", "purge"], { SUBSTRATE_STATE_DIR: stateDir });
		const help = await cli([], { SUBSTRATE_STATE_DIR: stateDir });

		expect(bad.code).toBe(1);
		expect(bad.stderr).toContain("usage: substrate spool status");
		expect(help.stdout).toContain("substrate spool status [--json] | flush");
	});
});
