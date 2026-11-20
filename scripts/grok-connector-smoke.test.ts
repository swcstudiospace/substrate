/**
 * The Grok connector smoke (uplift-3 N7), run against a real `substrate-mcp`
 * on a loopback port with fake stores — the same harness `http.test.ts` and
 * `brief-fast-path.test.ts` use — so every check is judged on the wire it will
 * see in production, bearer included. Nothing here opens a socket to anything
 * but its own server, and no fixture value is a real-looking secret.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../packages/mcp-server/src/config.ts";
import { createObservability, type Observability } from "../packages/mcp-server/src/observe.ts";
import { createHttpServer } from "../packages/mcp-server/src/server.ts";
import { Substrate } from "../packages/mcp-server/src/service.ts";
import {
	BEARER_HINT,
	BRIEF_BUDGET_MS,
	CHECK_IDS,
	briefStructured,
	exitFor,
	formatReport,
	parseArgs,
	planesNotUp,
	resolveGrokBearer,
	runSmoke,
	worst,
	type Report,
} from "./grok-connector-smoke.ts";

const GROK = "tok-grok";
const OMP = "tok-omp";
/** The server's token list: a grok-bot entry and an omp entry, both short fixture values. */
const TOKENS = { SUBSTRATE_TOKEN_GROK_BOT: GROK, SUBSTRATE_TOKEN_OMP: OMP };

function graphView(graphId: string) {
	return {
		graph_id: graphId,
		notion_task_page: null,
		repo: "swcstudiospace/agent-substrate",
		branch: null,
		surface: "grok-bot",
		status: "active",
		pr_url: null,
		created: null,
		updated: null,
		nodes: [],
		steps: [],
		edges: [],
	};
}

/** An index whose every read answers, so the brief is complete and `/healthz` is 200. */
const UP_INDEX = {
	ping: async () => true,
	capacity: async () => null,
	getGraph: async () => graphView("ut-1"),
	openGraphs: async () => [],
	memoryForBrief: async () => [],
};
/** An index that is down: the brief degrades and `/healthz` reports the plane unreachable. */
const DOWN_INDEX = {
	ping: async () => false,
	capacity: async () => null,
	getGraph: () => Promise.reject(new Error("postgres is down")),
	openGraphs: async () => [],
	memoryForBrief: () => Promise.reject(new Error("postgres is down")),
};

interface Harness {
	base: string;
	observability: Observability;
	close(): void;
}
const running: Harness[] = [];
afterAll(() => {
	for (const harness of running) harness.close();
});

async function start(env: Record<string, string>, index: Record<string, unknown>): Promise<Harness> {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const substrate = new Substrate(config, { index: index as never, greptime: null, steering: { history: null, liveSessions: null } }, observability.observer);
	const server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	const harness: Harness = {
		base: `http://127.0.0.1:${port}`,
		observability,
		close() {
			observability.stop();
			server.close();
		},
	};
	running.push(harness);
	return harness;
}

function verdicts(report: Report): Record<string, string> {
	return Object.fromEntries(report.checks.map((check) => [check.id, check.verdict]));
}

describe("parseArgs", () => {
	test("accepts --json and nothing else", () => {
		expect(parseArgs([])).toEqual({ json: false });
		expect(parseArgs(["--json"])).toEqual({ json: true });
		expect(parseArgs(["--plane", "index"])).toMatchObject({ error: expect.stringContaining("unknown argument --plane") });
	});
});

describe("resolveGrokBearer", () => {
	const never = (path: string): string | null => {
		throw new Error(`read ${path}`);
	};

	test("SUBSTRATE_TOKEN_GROK_BOT first (its first list entry), then the tokens-dir file, then SUBSTRATE_TOKEN", () => {
		expect(resolveGrokBearer({ SUBSTRATE_TOKEN_GROK_BOT: " tok-a, tok-b", SUBSTRATE_TOKEN: "tok-other" }, never)).toEqual({ token: "tok-a", source: "SUBSTRATE_TOKEN_GROK_BOT" });
		const reads: string[] = [];
		const read = (path: string) => {
			reads.push(path);
			return "tok-file";
		};
		expect(resolveGrokBearer({ SUBSTRATE_TOKENS_DIR: "/tmp/tokens", SUBSTRATE_TOKEN: "tok-other" }, read)).toEqual({ token: "tok-file", source: "SUBSTRATE_TOKENS_DIR" });
		expect(reads).toEqual(["/tmp/tokens/grok-bot"]);
		expect(resolveGrokBearer({ SUBSTRATE_TOKEN: " tok-other " }, () => null)).toEqual({ token: "tok-other", source: "SUBSTRATE_TOKEN" });
		expect(resolveGrokBearer({ SUBSTRATE_TOKEN_GROK_BOT: " , " }, () => null)).toBeNull();
		expect(resolveGrokBearer({}, () => null)).toBeNull();
	});

	test("the hint names variables, never a value", () => {
		expect(BEARER_HINT).toContain("SUBSTRATE_TOKEN_GROK_BOT");
		expect(BEARER_HINT).toContain("SUBSTRATE_TOKENS_DIR");
		expect(BEARER_HINT).not.toContain("tok-");
	});
});

describe("verdict arithmetic", () => {
	test("one failed fails the run, one degraded degrades it, and the exit codes follow", () => {
		expect(worst(["ok", "ok"])).toBe("ok");
		expect(worst(["ok", "degraded"])).toBe("degraded");
		expect(worst(["degraded", "failed", "ok"])).toBe("failed");
		expect(worst([])).toBe("ok");
		expect([exitFor("ok"), exitFor("degraded"), exitFor("failed")]).toEqual([0, 1, 2]);
	});

	test("briefStructured narrows a tool reply and refuses anything else", () => {
		expect(briefStructured(null)).toBeNull();
		expect(briefStructured({ error: { message: "nope" } })).toBeNull();
		expect(briefStructured({ result: { content: [{ type: "text", text: "# brief" }], structuredContent: { etag: 'W/"a"', state: "complete", surface: "grok-bot" } } })).toEqual({
			etag: 'W/"a"',
			state: "complete",
			surface: "grok-bot",
			notModified: false,
			text: "# brief",
			isError: false,
		});
		expect(briefStructured({ result: { content: [{ type: "text", text: "unchanged" }], structuredContent: { not_modified: true, etag: 'W/"a"', state: "complete" } } })?.notModified).toBe(true);
		expect(briefStructured({ result: { content: [{ type: "text", text: "{}" }], isError: true } })).toMatchObject({ isError: true, etag: null, state: null });
	});

	test("planesNotUp reads ok:false and non-closed breakers, and ignores unconfigured planes and older bodies", () => {
		const body = {
			planes: {
				index: { ok: true, breaker: { state: "closed" } },
				greptime: { ok: false, breaker: { state: "closed" } },
				hindsight: { ok: null, breaker: null },
				lightrag: { ok: true, breaker: { state: "half-open" } },
				cache: { ok: true, breaker: { state: "open" } },
			},
		};
		expect(planesNotUp(body)).toEqual(["greptime unreachable", "lightrag breaker half-open", "cache breaker open"]);
		expect(planesNotUp({ index: true })).toEqual([]);
		expect(planesNotUp("# text")).toEqual([]);
	});
});

describe("against the harness", () => {
	test("every check ok as the grok-bot bearer: exit 0, timings reported, one line per check", async () => {
		const harness = await start(TOKENS, UP_INDEX);
		const report = await runSmoke({ base: harness.base, bearer: GROK });
		expect(verdicts(report)).toEqual({ "mcp.brief": "ok", "mcp.brief.not_modified": "ok", "rest.brief.304": "ok", "healthz.planes": "ok" });
		expect(report.verdict).toBe("ok");
		expect(report.exit).toBe(0);
		expect(report.checks.map((check) => check.id)).toEqual([...CHECK_IDS]);
		for (const check of report.checks) {
			expect(check.ms).toBeGreaterThanOrEqual(0);
			expect(check.ms).toBeLessThan(BRIEF_BUDGET_MS);
			expect(check.detail).not.toContain(GROK);
		}
		expect(report.checks[0]?.detail).toContain("state complete");
		expect(report.checks[1]?.detail).toContain("not_modified");
		expect(report.checks[2]?.detail).toContain("200 then 304");
		const text = formatReport(report);
		expect(text.split("\n").filter((line) => line.startsWith("ok ")).length).toBe(4);
		expect(text).toContain("verdict: ok (exit 0)");
		expect(text).not.toContain(GROK);
		// Read-only: the smoke made briefs and a health read, and nothing else was counted.
		const metrics = harness.observability.snapshot();
		const requests = metrics.find((metric) => metric.name === "substrate.request.total");
		expect(requests?.kind).toBe("counter");
		if (requests?.kind === "counter") {
			const routes = new Set(requests.points.map((point) => point.attributes.route));
			expect([...routes].sort()).toEqual(["/brief", "/healthz", "/mcp"]);
		}
	});

	test("a degraded brief and a down plane: exit 1 with the checks marked degraded, not failed", async () => {
		const harness = await start(TOKENS, DOWN_INDEX);
		const report = await runSmoke({ base: harness.base, bearer: GROK });
		expect(verdicts(report)).toEqual({
			"mcp.brief": "degraded",
			"mcp.brief.not_modified": "ok",
			"rest.brief.304": "degraded",
			"healthz.planes": "degraded",
		});
		expect(report.verdict).toBe("degraded");
		expect(report.exit).toBe(1);
		expect(report.checks[0]?.detail).toContain("state degraded");
		expect(report.checks[3]?.detail).toContain("index unreachable");
	});

	test("a refused bearer: exit 2 with a hint naming the variable and never the token", async () => {
		const harness = await start(TOKENS, UP_INDEX);
		const report = await runSmoke({ base: harness.base, bearer: "tok-wrong" });
		expect(report.exit).toBe(2);
		expect(report.verdict).toBe("failed");
		expect(report.checks).toHaveLength(1);
		expect(report.checks[0]?.id).toBe("mcp.brief");
		expect(report.checks[0]?.detail).toContain("401");
		expect(report.checks[0]?.detail).toContain("SUBSTRATE_TOKEN_GROK_BOT");
		expect(JSON.stringify(report)).not.toContain("tok-wrong");
	});

	test("a bearer the server resolves to another surface is refused by check 1", async () => {
		const harness = await start(TOKENS, UP_INDEX);
		const report = await runSmoke({ base: harness.base, bearer: OMP });
		expect(report.exit).toBe(2);
		expect(report.checks[0]?.verdict).toBe("failed");
		expect(report.checks[0]?.detail).toContain("resolved to surface omp, not grok-bot");
		expect(JSON.stringify(report)).not.toContain(OMP);
	});

	test("an unreachable service is a failed first check, exit 2", async () => {
		const report = await runSmoke({ base: "http://127.0.0.1:9", bearer: GROK, timeoutMs: 2000 });
		expect(report.exit).toBe(2);
		expect(report.checks[0]?.detail).toContain("unreachable");
	});

	test("a server that reports no caller surface fails check 1: the identity is not proven", async () => {
		// A pre-N7 server, or one whose metadata dropped the field: text, state and
		// etag are all there, only `surface` is missing.
		const seen: string[] = [];
		const fetchImpl = (async (input: string | URL | Request) => {
			seen.push(String(input));
			const reply = {
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: "# acme/app\nNo substrate history for this repo yet." }],
					structuredContent: { etag: 'W/"00000000000000000000000000000000"', state: "complete", failed_sources: [], snapshot_at: null },
				},
			};
			return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;
		const report = await runSmoke({ base: "http://127.0.0.1:1", bearer: GROK, fetchImpl });
		expect(report.exit).toBe(2);
		expect(report.checks[0]?.verdict).toBe("failed");
		expect(report.checks[0]?.detail).toContain("no `surface` in structuredContent");
		expect(report.checks[1]?.detail).toContain("not run");
		// Check 3 stops after the first /brief (no ETag header to condition on); check 4 still reads health.
		expect(seen).toEqual(["http://127.0.0.1:1/mcp", "http://127.0.0.1:1/brief", "http://127.0.0.1:1/healthz"]);
	});
});
