/**
 * The boot-and-prove release gate, driven with an injected runner, HTTP client, clock and file
 * system: no Docker, no server, no network, no real sleeping. The fakes behave like the harness
 * where the gate depends on it (`up` creates a run directory and a labelled container, `down`
 * removes both, `pause` makes the ledger refuse), so the tests prove the gate's own decisions:
 * which assertion turns red for which regression, that teardown runs on every path and in the
 * right order, that a refused start is "unavailable" and never "failed", and that nothing the
 * caller exported reaches a proof.
 */
import { describe, expect, test } from "bun:test";
import {
	CHAOS_REQUEST_TIMEOUT_MS,
	CHECK_IDS,
	childEnv,
	DEFAULT_WINDOW_MS,
	IMAGE_OVERRIDE_KEYS,
	imageOverrides,
	isContention,
	LEDGER_STATEMENT_TIMEOUT_MS,
	formatReceipt,
	GATE_EXTRA_ENV,
	GateInterrupted,
	judgeBrief,
	judgeEmit,
	judgeHealthz,
	judgeLivez,
	judgeOutageBrief,
	judgeProfileTypo,
	judgeSlo,
	MAX_WINDOW_MS,
	MIN_WINDOW_MS,
	OUTAGE_BRIEF_BUDGET_MS,
	parseArgs,
	SLO_CATALOGUE_IDS,
	RECOVERY_WAIT_MS,
	refusalReason,
	runGate,
	summarizeProofOutput,
	type GateDeps,
	type GateOptions,
	type HttpResult,
	type Receipt,
	type RunOptions,
	type RunResult,
} from "./release-gate.ts";

const CC = "cc-token-0123456789abcdef";
const GB = "gb-token-fedcba9876543210";
const RUN_ROOT = "/fake/run";

const ok = (text: string, headers: Record<string, string> = {}, status = 200, ms = 20): HttpResult => ({ status, headers, text, ms });
const json = (value: unknown, status = 200): HttpResult => ok(JSON.stringify(value), { "content-type": "application/json" }, status);
const SLO_BODY = {
	results: SLO_CATALOGUE_IDS.map((id) => ({ id, status: "insufficient-data" })),
	breached: [] as string[],
	planes: [{ id: "plane.greptime.availability", status: "ok" }, { id: "plane.cache.availability", status: "unconfigured" }],
	burn: [],
};
const HEALTHY = { index: true, greptime: true, eventsWritable: true };
const OPTIONS: GateOptions = { name: "gate-test", surfaces: ["claude-code", "grok-bot"], windowMs: 20_000, keep: false, json: false };

type RunKind = "up" | "down" | "smoke" | "pause" | "unpause" | "grok" | "chaos" | "docker-ps";
type RunOverride = Partial<RunResult> | ((argv: string[], options: RunOptions) => Partial<RunResult>);

interface Call {
	kind: RunKind;
	argv: string[];
	env: Record<string, string>;
	interruptible: boolean;
}

interface Harness {
	deps: GateDeps;
	controller: AbortController;
	/** Every child process, in order. */
	calls: Call[];
	/** Every HTTP call as `METHOD path (as who)`, in order. */
	requests: string[];
	files: Map<string, string>;
	containers: string[];
	state: { paused: boolean; healthzBadCalls: number };
	runs: Partial<Record<RunKind, RunOverride>>;
	http: Record<string, (req: { token: string | null; body?: unknown }, count: number) => HttpResult>;
	logs: string[];
	kinds(): RunKind[];
	checkIds(receipt: Receipt): string[];
}

function classify(argv: string[]): RunKind {
	const script = argv.find((part) => part.endsWith(".ts")) ?? "";
	if (script.endsWith("grok-connector-smoke.ts")) return "grok";
	if (script.endsWith("chaos-smoke.ts")) return "chaos";
	if (argv[0] === "docker") return "docker-ps";
	const sub = argv[argv.indexOf(script) + 1];
	return sub as RunKind;
}

/** The healthy world: a harness that works, a twin that answers, a ledger that refuses while paused. */
function harness(parentEnv: Record<string, string | undefined> = {}): Harness {
	const controller = new AbortController();
	const files = new Map<string, string>();
	const containers: string[] = [];
	const calls: Call[] = [];
	const requests: string[] = [];
	const logs: string[] = [];
	const state = { paused: false, healthzBadCalls: 0 };
	let clock = 1_000_000;
	let lastTag = "";
	const dir = `${RUN_ROOT}/${OPTIONS.name}`;
	const h = {} as Harness;
	h.runs = {};
	h.http = {
		"GET /livez": () => json({ ok: true, uptime_s: 4, loop_lag_ms: 0 }),
		"GET /healthz": () => {
			if (state.paused) return json({ index: true, greptime: false, eventsWritable: false }, 503);
			if (state.healthzBadCalls > 0) {
				state.healthzBadCalls -= 1;
				return json({ index: true, greptime: true, eventsWritable: false }, 503);
			}
			return json(HEALTHY);
		},
		"GET /slo": () => json(SLO_BODY),
		"POST /brief": (req) => {
			const body = (req.body ?? {}) as { profile?: string };
			if (body.profile === "compat") return json({ error: "profile must be one of full, compact" }, 400);
			if (state.paused) return ok("## Substrate brief: rehearsal/release-gate\n", { "content-type": "text/markdown", "x-substrate-brief": "degraded", "x-substrate-brief-profile": "full" }, 200, 300);
			return ok(`## Substrate brief: rehearsal/release-gate\n- ${lastTag}\n`, { "content-type": "text/markdown; charset=utf-8", "x-substrate-brief": "complete", "x-substrate-brief-profile": "full" });
		},
		"POST /events": (req) => {
			const summary = String((req.body as { summary?: string } | undefined)?.summary ?? "");
			if (state.paused) return json({ id: "e", stored: false, error: "ledger unreachable" }, 503);
			lastTag = summary;
			return json({ id: "e1", stored: true }, 202);
		},
	};
	h.runs = {};

	const defaults = (kind: RunKind): RunResult => {
		const result: RunResult = { code: 0, out: "", err: "", timedOut: false };
		if (kind === "up") {
			files.set(`${dir}/state.json`, JSON.stringify({ commit: "0123456789abcdef0123456789abcdef01234567" }));
			files.set(`${dir}/consumer.env`, `export SUBSTRATE_URL='http://127.0.0.1:39001'\nexport SUBSTRATE_REHEARSAL_TOKENS_DIR='${dir}/tokens'\n`);
			files.set(`${dir}/tokens/claude-code`, `${CC}\n`);
			files.set(`${dir}/tokens/grok-bot`, `${GB}\n`);
			containers.push("aaaaaaaaaaaa", "bbbbbbbbbbbb");
		} else if (kind === "down") {
			for (const key of [...files.keys()]) if (key.startsWith(`${dir}/`)) files.delete(key);
			containers.length = 0;
			result.out = "[rehearsal] down gate-test: stopped pid 1, removed 2 containers.\n";
		} else if (kind === "pause") {
			state.paused = true;
		} else if (kind === "unpause") {
			state.paused = false;
			state.healthzBadCalls = 3;
		} else if (kind === "docker-ps") {
			result.out = containers.join("\n");
		} else if (kind === "chaos") {
			result.out = "\n18/18 checks passed\n";
		}
		return result;
	};

	Object.assign(h, {
		controller,
		calls,
		requests,
		files,
		containers,
		state,
		logs,
		kinds: () => calls.map((call) => call.kind),
		checkIds: (receipt: Receipt) => receipt.checks.map((check) => check.id),
		deps: {
			async run(argv: string[], options: RunOptions): Promise<RunResult> {
				const kind = classify(argv);
				calls.push({ kind, argv, env: options.env, interruptible: options.interruptible });
				const override = h.runs[kind];
				if (override === undefined) return defaults(kind);
				// A function takes over the world entirely (it may throw, or fail without side effects).
				if (typeof override === "function") return { code: 0, out: "", err: "", timedOut: false, ...override(argv, options) };
				const result: RunResult = { code: 0, out: "", err: "", timedOut: false, ...override };
				// An object that succeeds changes the world the same way the default does.
				if (result.code === 0) defaults(kind);
				return result;
			},
			async http(_base: string, req: { method: "GET" | "POST"; path: string; token: string | null; body?: unknown }): Promise<HttpResult> {
				clock += 1;
				const who = req.token === CC ? "claude-code" : req.token === GB ? "grok-bot" : "anonymous";
				const key = `${req.method} ${req.path}`;
				requests.push(`${key} (${who})`);
				const handler = h.http[key];
				return handler === undefined ? ok("", {}, 404) : handler({ token: req.token, body: req.body }, requests.filter((line) => line.startsWith(key)).length);
			},
			readFile: (path: string) => files.get(path) ?? null,
			exists: (path: string) => [...files.keys()].some((key) => key === path || key.startsWith(`${path}/`)),
			now: () => {
				clock += 1;
				return clock;
			},
			async sleep(ms: number): Promise<void> {
				clock += ms;
			},
			runDir: (name: string) => `${RUN_ROOT}/${name}`,
			freshName: () => "gate-fresh",
			parentEnv,
			log: (line: string) => {
				logs.push(line);
			},
			signal: controller.signal,
		},
	});
	return h;
}

const failedIds = (receipt: Receipt): string[] => receipt.checks.filter((check) => check.status === "fail").map((check) => check.id);

describe("parseArgs", () => {
	test("defaults to both driven surfaces and a 20 s window", () => {
		expect(parseArgs([])).toEqual({ name: null, surfaces: ["claude-code", "grok-bot"], windowMs: 40_000, keep: false, json: false });
	});

	test("reads every flag", () => {
		expect(parseArgs(["--name", "g1", "--surfaces", "grok-bot,claude-code,omp", "--window-ms", "30000", "--keep", "--json"])).toEqual({
			name: "g1",
			surfaces: ["grok-bot", "claude-code", "omp"],
			windowMs: 30_000,
			keep: true,
			json: true,
		});
	});

	test("refuses what it cannot honour: usage errors, never defaults", () => {
		const bad = (argv: string[]): string => {
			const parsed = parseArgs(argv);
			if (!("error" in parsed)) throw new Error(`accepted ${argv.join(" ")}`);
			return parsed.error;
		};
		expect(bad(["--window-ms"])).toContain("needs a value");
		expect(bad(["--name", "--keep"])).toContain("needs a value");
		expect(bad(["--window-ms", "fast"])).toContain("whole number");
		expect(bad(["--window-ms", String(MIN_WINDOW_MS - 1)])).toContain("between");
		expect(bad(["--window-ms", String(MAX_WINDOW_MS + 1)])).toContain("between");
		expect(bad(["--window-ms", "1e4"])).toContain("whole number");
		expect(bad(["--surfaces", "claude-code"])).toContain("must include grok-bot");
		expect(bad(["--surfaces", "grok-bot"])).toContain("must include claude-code");
		expect(bad(["--surfaces", "claude-code,grok-bot,nope"])).toContain("nope");
		expect(bad(["--name", "Bad Name"])).toContain("name");
		expect(bad(["--verbose"])).toBe("unknown option --verbose");
		expect(bad(["extra"])).toBe("unexpected argument extra");
	});
});

describe("childEnv", () => {
	test("forwards where things are, never what they are connected to", () => {
		const env = childEnv({
			PATH: "/usr/bin",
			HOME: "/root",
			XDG_RUNTIME_DIR: "/run/user/0",
			DOCKER_HOST: "unix:///var/run/docker.sock",
			BUN_INSTALL: "/opt/bun",
			SUBSTRATE_URL: "http://127.0.0.1:7410",
			SUBSTRATE_TOKEN: "prod-bearer",
			SUBSTRATE_TOKEN_GROK_BOT: "prod-grok",
			CHAOS_REHEARSAL: "1",
			CHAOS_WINDOW_MS: "1",
			SUBSTRATE_PG_URL: "postgres://production",
		});
		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/root", XDG_RUNTIME_DIR: "/run/user/0", DOCKER_HOST: "unix:///var/run/docker.sock", BUN_INSTALL: "/opt/bun" });
	});

	test("explicit extras win and are the only way a proof learns the twin", () => {
		expect(childEnv({ PATH: "/usr/bin", SUBSTRATE_URL: "http://127.0.0.1:7410" }, { SUBSTRATE_URL: "http://127.0.0.1:39001" })).toEqual({
			PATH: "/usr/bin",
			SUBSTRATE_URL: "http://127.0.0.1:39001",
		});
	});
});

describe("the chaos smoke's timing", () => {
	test("its request timeout clears two serial ledger statement timeouts, which a fresh session pays while the ledger is frozen", async () => {
		const h = harness();
		await runGate(OPTIONS, h.deps);
		const timeout = Number(h.calls.find((call) => call.kind === "chaos")?.env.CHAOS_TIMEOUT_MS);
		// Chain-tip lookup (one statement timeout) then the insert (another): 10 s, so a 10 s client
		// timeout aborts a request the server is about to answer.
		expect(timeout).toBe(CHAOS_REQUEST_TIMEOUT_MS);
		expect(timeout).toBeGreaterThan(2 * LEDGER_STATEMENT_TIMEOUT_MS);
		expect(timeout).toBeGreaterThanOrEqual(2 * 2 * LEDGER_STATEMENT_TIMEOUT_MS);
	});

	test("the default window holds at least three ticks of a worst-case emit plus the 2 s tick", () => {
		expect(DEFAULT_WINDOW_MS).toBeGreaterThanOrEqual(3 * (2 * LEDGER_STATEMENT_TIMEOUT_MS + 2000));
	});
});

describe("the harness's image overrides", () => {
	const PG = IMAGE_OVERRIDE_KEYS[0];
	const LEDGER = IMAGE_OVERRIDE_KEYS[1];

	test("exactly the two override keys are forwarded, and blank ones are not", () => {
		expect(imageOverrides({ [PG]: "postgres:16-local", [LEDGER]: "  ", PATH: "/usr/bin", SUBSTRATE_URL: "x" })).toEqual({ [PG]: "postgres:16-local" });
		expect(IMAGE_OVERRIDE_KEYS).toEqual(["SUBSTRATE_REHEARSAL_PG_IMAGE", `SUBSTRATE_REHEARSAL_${"GREPTIME"}_IMAGE`]);
	});

	test("every rehearsal call sees them and no proof does", async () => {
		const h = harness({ PATH: "/usr/bin", [PG]: "postgres:16-local", [LEDGER]: "ledger:local" });
		await runGate(OPTIONS, h.deps);
		for (const call of h.calls) {
			const isProof = call.kind === "grok" || call.kind === "chaos";
			expect(call.env[PG]).toBe(isProof ? undefined : "postgres:16-local");
			expect(call.env[LEDGER]).toBe(isProof ? undefined : "ledger:local");
		}
		expect(h.calls.some((call) => call.kind === "up" && call.env[PG] !== undefined)).toBe(true);
	});
});

describe("the judges, one per wire check", () => {
	const brief = (over: { status?: number; headers?: Record<string, string>; text?: string; ms?: number } = {}): HttpResult => ({
		status: over.status ?? 200,
		headers: { "content-type": "text/markdown; charset=utf-8", "x-substrate-brief": "complete", "x-substrate-brief-profile": "full", ...over.headers },
		text: over.text ?? "## Substrate brief: x\n",
		ms: over.ms ?? 10,
	});

	test("/livez needs 200 and ok:true", () => {
		expect(judgeLivez(json({ ok: true, uptime_s: 2 })).ok).toBe(true);
		expect(judgeLivez(json({ ok: false })).ok).toBe(false);
		expect(judgeLivez(json({ ok: true }, 503)).ok).toBe(false);
		expect(judgeLivez({ status: null, headers: {}, text: "", ms: 1, error: "refused" }).detail).toContain("no answer");
	});

	test("/healthz needs both stores and ledger writes, whatever the status", () => {
		expect(judgeHealthz(json(HEALTHY)).ok).toBe(true);
		expect(judgeHealthz(json({ ...HEALTHY, greptime: false }, 503)).detail).toContain("greptime=false");
		expect(judgeHealthz(json({ ...HEALTHY, index: false }, 503)).detail).toContain("index=false");
		// A 200 that does not carry the fields proves nothing.
		expect(judgeHealthz(json({ index: true, greptime: true })).ok).toBe(false);
		// The fields true but a 503 is still a failure.
		expect(judgeHealthz(json(HEALTHY, 503)).detail).toContain("HTTP 503");
		expect(judgeHealthz(ok("not json")).ok).toBe(false);
	});

	test("/slo is shape-only: the four objectives with known statuses and well-formed arrays", () => {
		const slo = SLO_BODY;
		const good = judgeSlo(json(slo));
		expect(good.ok).toBe(true);
		expect(good.note).toBeUndefined();
		expect(judgeSlo(json({ ...slo, results: [] })).detail).toContain("lacks objective brief.p95");
		expect(judgeSlo(json({ ...slo, results: slo.results.filter((row) => row.id !== "emit.success") })).detail).toContain("lacks objective emit.success");
		expect(judgeSlo(json({ ...slo, results: [...slo.results, { id: "brief.p95", status: "ok" }] })).detail).toContain("brief.p95 2 times");
		expect(judgeSlo(json({ ...slo, results: slo.results.map((row) => (row.id === "brief.p95" ? { ...row, status: "great" } : row)) })).detail).toContain('unknown status "great"');
		expect(judgeSlo(json({ ...slo, results: [...slo.results.slice(1), { id: "brief.p95" }] })).detail).toContain("id or status");
		expect(judgeSlo(json({ ...slo, planes: [{ id: "plane.x", status: "fine" }] })).detail).toContain("unknown status");
		expect(judgeSlo(json({ ...slo, planes: undefined })).detail).toContain("planes");
		expect(judgeSlo(json({ ...slo, breached: undefined })).detail).toContain("breached");
		expect(judgeSlo(json(slo, 500)).ok).toBe(false);
		expect(judgeSlo(ok("nope")).ok).toBe(false);
	});

	test("a breached objective on a fresh twin passes with an explicit note naming it", () => {
		const breached = judgeSlo(
			json({
				...SLO_BODY,
				results: SLO_BODY.results.map((row) => (row.id === "emit.success" ? { ...row, status: "breached" } : row)),
				breached: ["brief.p95", "emit.success", "plane.greptime.availability"],
			}),
		);
		expect(breached.ok).toBe(true);
		expect(breached.detail).toContain("brief.p95, emit.success, plane.greptime.availability");
		expect(breached.note).toContain("brief.p95, emit.success, plane.greptime.availability");
		expect(breached.note).toContain("outage.chaos");
	});

	test("a brief is a 200 of full markdown with the right profile and state", () => {
		expect(judgeBrief(brief(), { profile: "full", state: "complete" }).ok).toBe(true);
		expect(judgeBrief(brief({ status: 502 }), { profile: "full" }).detail).toBe("HTTP 502");
		expect(judgeBrief(brief({ headers: { "x-substrate-brief-profile": "compact" } }), { profile: "full" }).detail).toContain("served profile compact");
		expect(judgeBrief(brief({ headers: { "x-substrate-brief": "degraded" } }), { profile: "full", state: "complete" }).detail).toContain("brief state degraded");
		expect(judgeBrief(brief({ headers: { "content-type": "application/json" } }), { profile: "full" }).detail).toContain("text/markdown");
		// A compact body (it opens with the state line) is not the full text.
		expect(judgeBrief(brief({ text: "[brief: complete]\n" }), { profile: "full" }).detail).toContain("heading");
	});

	test("the brief during an outage must still be a 200 and inside its budget; its state is reported, not judged", () => {
		expect(judgeOutageBrief(brief({ headers: { "x-substrate-brief": "degraded" }, ms: 400 })).ok).toBe(true);
		expect(judgeOutageBrief(brief({ status: 503 })).detail).toContain("fail open");
		expect(judgeOutageBrief(brief({ status: 500 })).ok).toBe(false);
		expect(judgeOutageBrief(brief({ ms: OUTAGE_BRIEF_BUDGET_MS + 1 })).detail).toContain("over the 1500 ms budget");
		expect(judgeOutageBrief(brief({ ms: OUTAGE_BRIEF_BUDGET_MS })).ok).toBe(true);
	});

	test("an emit is a 202 with stored:true and an id", () => {
		expect(judgeEmit(json({ id: "e1", stored: true }, 202)).ok).toBe(true);
		expect(judgeEmit(json({ id: "e1", stored: false, error: "ledger down" }, 503)).detail).toContain("ledger down");
		expect(judgeEmit(json({ id: "e1", stored: false }, 202)).detail).toContain("stored");
		expect(judgeEmit(json({ stored: true }, 202)).detail).toContain("id");
	});

	test("a typo'd profile must be refused with 400, never served", () => {
		expect(judgeProfileTypo(json({ error: "x" }, 400)).ok).toBe(true);
		expect(judgeProfileTypo(brief()).detail).toContain("wanted 400");
	});
});

describe("proof output and refusal text", () => {
	test("a refusal's reason comes from the harness line, a fallback from the first line", () => {
		expect(refusalReason("[rehearsal] refused: image postgres:16 is not present locally; the harness never pulls.\n")).toBe("image postgres:16 is not present locally; the harness never pulls");
		expect(refusalReason("boom\nmore")).toBe("boom");
		expect(refusalReason("", "out line")).toBe("out line");
		expect(refusalReason("", "")).toBe("no reason given");
	});

	test("the chaos report's counts and failed checks are carried into the receipt", () => {
		const out = ["  ok   a", " FAIL the ledger refused at least one append (0 of 9)", "", "17/18 checks passed", "", "failed:", "  - the ledger refused at least one append (0 of 9) (the ledger stayed healthy)", ""].join("\n");
		const summary = summarizeProofOutput(out);
		expect(summary).toContain("17/18 checks passed");
		expect(summary).toContain("failed: the ledger refused at least one append");
		expect(summarizeProofOutput("nothing useful")).toBe("");
	});
});

describe("runGate: a healthy tree", () => {
	test("passes every check in order, exits 0 and leaves nothing running", async () => {
		const h = harness({ PATH: "/usr/bin", SUBSTRATE_URL: "http://127.0.0.1:7410", CHAOS_REHEARSAL: "1", SUBSTRATE_TOKEN_GROK_BOT: "prod-grok" });
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(0);
		expect(receipt.verdict).toBe("pass");
		expect(h.checkIds(receipt)).toEqual([...CHECK_IDS]);
		expect(failedIds(receipt)).toEqual([]);
		expect(receipt.checks.every((check) => check.status === "pass")).toBe(true);
		expect(receipt.commit).toBe("0123456789ab");
		expect(h.containers).toEqual([]);
		expect([...h.files.keys()]).toEqual([]);
		expect(h.kinds()).toEqual(["up", "smoke", "grok", "pause", "chaos", "unpause", "down", "docker-ps"]);
	});

	test("starts the twin with ephemeral port, both surfaces and only allowlisted extra env", async () => {
		const h = harness();
		await runGate(OPTIONS, h.deps);
		const up = h.calls.find((call) => call.kind === "up")?.argv ?? [];
		const rest = up.slice(up.indexOf("up"));
		expect(rest).toEqual([
			"up", "--name", "gate-test", "--port", "0", "--surfaces", "claude-code,grok-bot",
			...GATE_EXTRA_ENV.flatMap((entry) => ["--extra-env", entry]),
		]);
		expect(up).toContain("--no-env-file");
	});

	test("drives the wire in the contracted order and as the right surface", async () => {
		const h = harness();
		await runGate(OPTIONS, h.deps);
		expect(h.requests.slice(0, 11)).toEqual([
			"GET /livez (anonymous)",
			"GET /healthz (claude-code)",
			"GET /slo (claude-code)",
			"POST /brief (claude-code)",
			"POST /brief (grok-bot)",
			"POST /brief (grok-bot)",
			"POST /brief (grok-bot)",
			"POST /events (claude-code)",
			"POST /brief (claude-code)",
			"POST /brief (grok-bot)",
			"GET /healthz (claude-code)",
		]);
	});

	test("the proofs never see the caller's own URL, tokens or CHAOS_REHEARSAL, and are told the twin's", async () => {
		const h = harness({ PATH: "/usr/bin", SUBSTRATE_URL: "http://127.0.0.1:7410", SUBSTRATE_TOKEN: "prod-bearer", CHAOS_REHEARSAL: "1", SUBSTRATE_TOKEN_GROK_BOT: "prod-grok" });
		await runGate(OPTIONS, h.deps);
		for (const call of h.calls) {
			const joined = JSON.stringify(call.env);
			expect(joined).not.toContain("prod-");
			expect(call.env.CHAOS_REHEARSAL).toBeUndefined();
			expect(call.env.SUBSTRATE_TOKEN_GROK_BOT).toBeUndefined();
		}
		const chaos = h.calls.find((call) => call.kind === "chaos");
		expect(chaos?.env.SUBSTRATE_URL).toBe("http://127.0.0.1:39001");
		expect(chaos?.env.SUBSTRATE_TOKEN).toBe(CC);
		expect(chaos?.env.CHAOS_WINDOW_MS).toBe("20000");
		const grok = h.calls.find((call) => call.kind === "grok");
		expect(grok?.env.SUBSTRATE_TOKENS_DIR).toBe(`${RUN_ROOT}/gate-test/tokens`);
	});

	test("--window-ms reaches the chaos smoke", async () => {
		const h = harness();
		await runGate({ ...OPTIONS, windowMs: 45_000 }, h.deps);
		expect(h.calls.find((call) => call.kind === "chaos")?.env.CHAOS_WINDOW_MS).toBe("45000");
	});

	test("no bearer appears in the receipt, the table, the JSON or the progress log", async () => {
		const h = harness();
		const receipt = await runGate(OPTIONS, h.deps);
		const everything = `${formatReceipt(receipt)}${JSON.stringify(receipt)}${h.logs.join("\n")}`;
		expect(everything).not.toContain(CC);
		expect(everything).not.toContain(GB);
	});
});

describe("runGate: injected regressions turn the right check red", () => {
	test("a brief served 5xx while the ledger is paused fails outage.brief, exits 1, and still thaws and tears down", async () => {
		const h = harness();
		const healthy = h.http["POST /brief"] as NonNullable<Harness["http"][string]>;
		h.http["POST /brief"] = (req, count) => (h.state.paused ? ok("upstream error", {}, 500) : healthy(req, count));
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(failedIds(receipt)).toEqual(["outage.brief"]);
		expect(receipt.checks.find((check) => check.id === "outage.brief")?.detail).toBe("HTTP 500 while the ledger was frozen; the brief must fail open");
		expect(h.kinds().slice(-3)).toEqual(["unpause", "down", "docker-ps"]);
	});

	test("a brief that outlasts its budget while the ledger is paused fails outage.brief", async () => {
		const h = harness();
		const healthy = h.http["POST /brief"] as NonNullable<Harness["http"][string]>;
		h.http["POST /brief"] = (req, count) => (h.state.paused ? ok("## Substrate brief: x", { "content-type": "text/markdown", "x-substrate-brief": "degraded" }, 200, 4000) : healthy(req, count));
		const receipt = await runGate(OPTIONS, h.deps);
		expect(failedIds(receipt)).toEqual(["outage.brief"]);
		expect(receipt.exit).toBe(1);
	});

	test("a chaos smoke that fails (the outage did not degrade as promised) fails outage.chaos with its own words", async () => {
		const h = harness();
		h.runs.chaos = { code: 1, out: "\n16/18 checks passed\n\nfailed:\n  - no claim was granted while the ledger was refusing (2 claim(s) were granted)\n" };
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(failedIds(receipt)).toEqual(["outage.chaos"]);
		expect(receipt.checks.find((check) => check.id === "outage.chaos")?.detail).toContain("no claim was granted");
		expect(h.kinds()).toContain("unpause");
		expect(h.state.paused).toBe(false);
	});

	test("a chaos smoke that hangs past its window is a failure that names the hang", async () => {
		const h = harness();
		h.runs.chaos = { code: null, timedOut: true };
		const receipt = await runGate(OPTIONS, h.deps);
		expect(failedIds(receipt)).toEqual(["outage.chaos"]);
		expect(receipt.checks.find((check) => check.id === "outage.chaos")?.detail).toContain("hung");
	});

	test("a ledger that never recovers fails recovery.healthz after the bounded wait", async () => {
		const h = harness();
		h.state.healthzBadCalls = 0;
		const healthy = h.http["GET /healthz"] as NonNullable<Harness["http"][string]>;
		let afterUnpause = false;
		h.http["GET /healthz"] = (req, count) => (afterUnpause ? json({ index: true, greptime: true, eventsWritable: false }, 503) : healthy(req, count));
		h.runs.unpause = () => {
			afterUnpause = true;
			h.state.paused = false;
			return { code: 0 };
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(failedIds(receipt)).toEqual(["recovery.healthz"]);
		expect(receipt.checks.find((check) => check.id === "recovery.healthz")?.detail).toContain(`${Math.round(RECOVERY_WAIT_MS / 1000)} s after the unpause`);
	});

	test("recovery is waited for, not assumed: a slow but healthy recovery passes", async () => {
		const h = harness();
		const receipt = await runGate(OPTIONS, h.deps);
		// The harness fake reports three bad reads after the unpause.
		expect(receipt.checks.find((check) => check.id === "recovery.healthz")?.status).toBe("pass");
		expect(h.requests.filter((line) => line.startsWith("GET /healthz")).length).toBeGreaterThanOrEqual(5);
	});

	test("a ledger that stays down after recovery fails recovery.emit", async () => {
		const h = harness();
		const events = h.http["POST /events"] as NonNullable<Harness["http"][string]>;
		h.http["POST /events"] = (req, count) => {
			const summary = typeof req.body === "object" && req.body !== null && "summary" in req.body ? String(req.body.summary) : "";
			return summary.includes("recovery") ? json({ id: "e", stored: false }, 503) : events(req, count);
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(failedIds(receipt)).toEqual(["recovery.emit"]);
	});

	test("recovery.emit is polled: a ledger that takes a few more seconds to accept appends still passes", async () => {
		const h = harness();
		const events = h.http["POST /events"] as NonNullable<Harness["http"][string]>;
		let refused = 2;
		h.http["POST /events"] = (req, count) => {
			const summary = typeof req.body === "object" && req.body !== null && "summary" in req.body ? String(req.body.summary) : "";
			if (summary.includes("recovery") && refused > 0) {
				refused -= 1;
				return json({ id: "e", stored: false }, 503);
			}
			return events(req, count);
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(0);
		expect(h.requests.filter((line) => line.startsWith("POST /events")).length).toBe(1 + 3);
	});

	test("a degraded connector smoke (exit 1) passes with an explicit note on the receipt", async () => {
		const h = harness();
		h.runs.grok = { code: 1, out: "degraded" };
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(0);
		const grok = receipt.checks.find((check) => check.id === "smoke.grok");
		expect(grok?.status).toBe("pass");
		expect(grok?.note).toContain("degraded (exit 1)");
		const text = formatReceipt(receipt);
		expect(text).toContain("NOTE  smoke.grok");
		expect(text).toContain(" notes=1 ");
		expect(receipt.checks.filter((check) => check.note !== undefined).map((check) => check.id)).toEqual(["smoke.grok"]);
	});

	test("an exit 0 connector smoke carries no note", async () => {
		const h = harness();
		const receipt = await runGate(OPTIONS, h.deps);
		expect(formatReceipt(receipt)).not.toContain("NOTE");
		expect(formatReceipt(receipt)).toContain(" notes=0 ");
	});

	test("a profile the server serves compact under shadow fails brief.grok-bot, naming which request", async () => {
		const h = harness();
		const healthy = h.http["POST /brief"] as NonNullable<Harness["http"][string]>;
		h.http["POST /brief"] = (req, count) =>
			(req.body as { profile?: string } | undefined)?.profile === "compact"
				? ok("[brief: complete]\n", { "content-type": "text/markdown", "x-substrate-brief": "complete", "x-substrate-brief-profile": "compact" })
				: healthy(req, count);
		const receipt = await runGate(OPTIONS, h.deps);
		expect(failedIds(receipt)).toEqual(["brief.grok-bot"]);
		expect(receipt.checks.find((check) => check.id === "brief.grok-bot")?.detail).toContain("compact asked under shadow");
	});

	test("a typo'd profile that is served instead of refused fails brief.profile-typo", async () => {
		const h = harness();
		const healthy = h.http["POST /brief"] as NonNullable<Harness["http"][string]>;
		h.http["POST /brief"] = (req, count) => healthy({ ...req, body: { ...(req.body as object), profile: undefined } }, count);
		const receipt = await runGate(OPTIONS, h.deps);
		expect(failedIds(receipt)).toEqual(["brief.profile-typo"]);
	});

	test("an event that never reaches the brief fails brief.visibility after the bounded wait", async () => {
		const h = harness();
		const healthy = h.http["POST /brief"] as NonNullable<Harness["http"][string]>;
		h.http["POST /brief"] = (req, count) => {
			const profile = typeof req.body === "object" && req.body !== null && "profile" in req.body ? req.body.profile : undefined;
			if (h.state.paused || profile === "compat") return healthy(req, count);
			return ok("## Substrate brief: rehearsal/release-gate\nnothing here\n", { "content-type": "text/markdown", "x-substrate-brief": "complete", "x-substrate-brief-profile": "full" });
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(failedIds(receipt)).toEqual(["brief.visibility"]);
		expect(receipt.checks.find((check) => check.id === "brief.visibility")?.detail).toContain("answered without the event");
	});

	test("a failed emit skips visibility instead of reporting a second failure", async () => {
		const h = harness();
		h.http["POST /events"] = () => json({ id: "e", stored: false }, 503);
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.checks.find((check) => check.id === "emit")?.status).toBe("fail");
		expect(receipt.checks.find((check) => check.id === "brief.visibility")?.status).toBe("skip");
		expect(receipt.exit).toBe(1);
	});

	test("cold-start SLO noise on a fresh twin does not turn the gate red, and is on the receipt as a note", async () => {
		const h = harness();
		h.http["GET /slo"] = () => json({ ...SLO_BODY, breached: ["brief.p95", "emit.success", "plane.greptime.availability"] });
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(0);
		expect(receipt.checks.find((check) => check.id === "slo")?.status).toBe("pass");
		expect(receipt.checks.find((check) => check.id === "slo")?.note).toContain("emit.success");
		expect(formatReceipt(receipt)).toContain("NOTE  slo");
		expect(formatReceipt(receipt)).toContain(" notes=1 ");
	});

	test("a malformed /slo catalogue fails the slo check and only it", async () => {
		const h = harness();
		h.http["GET /slo"] = () => json({ ...SLO_BODY, results: SLO_BODY.results.slice(1) });
		const receipt = await runGate(OPTIONS, h.deps);
		expect(failedIds(receipt)).toEqual(["slo"]);
		expect(receipt.exit).toBe(1);
	});

	test("one store down at the start fails healthz, and the run continues to the rest", async () => {
		const h = harness();
		h.http["GET /healthz"] = () => json({ index: true, greptime: false, eventsWritable: false }, 503);
		const receipt = await runGate(OPTIONS, h.deps);
		expect(failedIds(receipt)).toContain("healthz");
		expect(receipt.checks.find((check) => check.id === "slo")?.status).toBe("pass");
		expect(receipt.exit).toBe(1);
	});

	test("a child that throws becomes a failed check, not a crash, and teardown still runs", async () => {
		const h = harness();
		h.runs.smoke = () => {
			throw new Error("spawn exploded");
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.checks.find((check) => check.id === "rehearsal.smoke")?.detail).toContain("spawn exploded");
		expect(receipt.exit).toBe(1);
		expect(h.kinds()).toContain("down");
	});

	test("a twin that does not answer /livez skips the proofs and still tears down", async () => {
		const h = harness();
		h.http["GET /livez"] = () => ({ status: null, headers: {}, text: "", ms: 1, error: "connection refused" });
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(failedIds(receipt)).toEqual(["livez"]);
		expect(receipt.checks.find((check) => check.id === "healthz")?.status).toBe("skip");
		expect(h.kinds().slice(-2)).toEqual(["down", "docker-ps"]);
		expect(h.kinds()).not.toContain("pause");
	});

	test("a consumer.env that points at a production port fails consumer and no proof runs against it", async () => {
		const h = harness();
		h.runs.up = () => {
			h.files.set(`${RUN_ROOT}/gate-test/consumer.env`, "export SUBSTRATE_URL='http://127.0.0.1:7410'\nexport SUBSTRATE_REHEARSAL_TOKENS_DIR='/x'\n");
			h.containers.push("aaaaaaaaaaaa");
			return { code: 0 };
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(failedIds(receipt)).toEqual(["consumer"]);
		expect(h.requests).toEqual([]);
		expect(h.kinds()).not.toContain("chaos");
	});
});

describe("runGate: unavailable is not failed", () => {
	test("a refused start (docker missing, image absent, disk floor, port) exits 2 with the reason and runs no teardown", async () => {
		const h = harness();
		h.runs.up = { code: 2, err: "[rehearsal] refused: docker is unreachable.\n" };
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(2);
		expect(receipt.verdict).toBe("unavailable");
		expect(receipt.unavailable).toBe("docker is unreachable");
		expect(h.checkIds(receipt)).toEqual(["up"]);
		expect(receipt.checks[0]?.status).toBe("skip");
		expect(h.kinds()).toEqual(["up"]);
		expect(h.requests).toEqual([]);
	});

	test("each harness refusal reason is carried verbatim", async () => {
		for (const reason of [
			"image postgres:16 is not present locally; the harness never pulls",
			"free disk on /var/lib/docker below the 2 GiB floor; the harness never prunes",
			"refusing non-local DOCKER_HOST tcp://elsewhere:2375",
			"port 7410 is reserved",
		]) {
			const h = harness();
			h.runs.up = { code: 2, err: `[rehearsal] refused: ${reason}.\n` };
			const receipt = await runGate(OPTIONS, h.deps);
			expect(receipt.exit).toBe(2);
			expect(receipt.unavailable).toBe(reason);
		}
	});

	test("an up that ran and failed (stores never healthy, exit 1) is a failure, and down still runs", async () => {
		const h = harness();
		h.runs.up = () => {
			h.containers.push("aaaaaaaaaaaa");
			return { code: 1, err: "[rehearsal] twin never reached healthy /healthz\n" };
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(failedIds(receipt)).toEqual(["up"]);
		expect(h.kinds()).toEqual(["up", "down", "docker-ps"]);
		expect(receipt.checks.filter((check) => check.status === "skip").length).toBeGreaterThan(5);
	});

	test("a killed up (timeout) may have made containers, so down runs", async () => {
		const h = harness();
		h.runs.up = { code: null, timedOut: true };
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(h.kinds()).toContain("down");
	});

	test("a name whose run directory exists is refused before up, and never torn down: it is somebody's twin", async () => {
		const h = harness();
		h.files.set(`${RUN_ROOT}/gate-test/state.json`, "{}");
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(2);
		expect(receipt.unavailable).toContain("already has a run directory");
		expect(h.calls).toEqual([]);
		expect(h.files.has(`${RUN_ROOT}/gate-test/state.json`)).toBe(true);
	});

	test("a refusal that left the run directory behind is swept by the label-scoped down, then proven clean", async () => {
		const h = harness();
		h.runs.up = () => {
			// The harness makes the run dir and writes tokens before some refusals, and removes none of it.
			h.files.set(`${RUN_ROOT}/gate-test/tokens/claude-code`, `${CC}\n`);
			h.files.set(`${RUN_ROOT}/gate-test/server.log`, "");
			return { code: 2, err: "[rehearsal] refused: image postgres:16 is not present locally; the harness never pulls.\n" };
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(2);
		expect(receipt.unavailable).toBe("image postgres:16 is not present locally; the harness never pulls");
		expect(h.kinds()).toEqual(["up", "down", "docker-ps"]);
		expect(h.checkIds(receipt)).toEqual(["up", "cleanup.down", "cleanup.residue"]);
		expect([...h.files.keys()]).toEqual([]);
	});

	test("a refusal that left a run directory the down cannot remove is a failure, not unavailable", async () => {
		const h = harness();
		h.runs.up = () => {
			h.files.set(`${RUN_ROOT}/gate-test/server.log`, "");
			return { code: 2, err: "[rehearsal] refused: port 7410 is reserved.\n" };
		};
		h.runs.down = { code: 2, err: "[rehearsal] refused: could not remove.\n" };
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(failedIds(receipt)).toContain("cleanup.down");
	});

	test("contention refusals leave someone else's twin alone even though a run directory exists", async () => {
		for (const reason of [
			"instance gate-test is already running (pid 123)",
			"instance gate-test is locked by another operation",
			"instance gate-test has live pid 123 that could not be verified; refusing to remove its stores",
		]) {
			const h = harness();
			h.runs.up = () => {
				h.files.set(`${RUN_ROOT}/gate-test/state.json`, "{}");
				return { code: 2, err: `[rehearsal] refused: ${reason}.\n` };
			};
			const receipt = await runGate(OPTIONS, h.deps);
			expect(receipt.exit).toBe(2);
			expect(h.kinds()).toEqual(["up"]);
			expect(h.files.has(`${RUN_ROOT}/gate-test/state.json`)).toBe(true);
		}
		expect(isContention("free disk below the 2 GiB floor")).toBe(false);
	});

	test("a generated name is used when none was given", async () => {
		const h = harness();
		const receipt = await runGate({ ...OPTIONS, name: null }, h.deps);
		expect(receipt.name).toBe("gate-fresh");
		expect(h.calls[0]?.argv).toContain("gate-fresh");
	});
});

describe("runGate: teardown on every path", () => {
	test("down is the last harness call, after unpause, on a pass", async () => {
		const h = harness();
		await runGate(OPTIONS, h.deps);
		const harnessCalls = h.kinds().filter((kind) => kind !== "docker-ps");
		expect(harnessCalls.at(-1)).toBe("down");
		expect(harnessCalls.indexOf("unpause")).toBeLessThan(harnessCalls.indexOf("down"));
		expect(harnessCalls.indexOf("pause")).toBeLessThan(harnessCalls.indexOf("chaos"));
		expect(harnessCalls.indexOf("chaos")).toBeLessThan(harnessCalls.indexOf("unpause"));
	});

	test("an interruption mid-outage thaws the ledger, then tears down, and is unavailable (exit 2), not a pass", async () => {
		const h = harness();
		h.runs.chaos = () => {
			h.controller.abort("interrupted by SIGINT");
			throw new GateInterrupted("interrupted by SIGINT");
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(2);
		expect(receipt.unavailable).toBe("interrupted by SIGINT");
		expect(h.state.paused).toBe(false);
		expect(h.containers).toEqual([]);
		const kinds = h.kinds();
		expect(kinds.indexOf("unpause")).toBeGreaterThan(kinds.indexOf("chaos"));
		expect(kinds.indexOf("down")).toBeGreaterThan(kinds.indexOf("unpause"));
		expect(receipt.checks.map((check) => check.id)).toContain("cleanup.unpause");
		expect(receipt.checks.find((check) => check.id === "cleanup.down")?.status).toBe("pass");
		// Cleanup commands are not interruptible: the signal that stopped the run must not stop them.
		for (const kind of ["down", "docker-ps"] as const) {
			expect(h.calls.filter((call) => call.kind === kind).every((call) => call.interruptible === false)).toBe(true);
		}
		expect(h.calls.filter((call) => call.kind === "unpause").at(-1)?.interruptible).toBe(false);
	});

	test("an interruption before up starts nothing: only the label-scoped down for its own fresh name runs", async () => {
		const h = harness();
		h.controller.abort("interrupted by SIGTERM");
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(2);
		expect(receipt.unavailable).toBe("interrupted by SIGTERM");
		expect(h.kinds()).toEqual(["down", "docker-ps"]);
	});

	test("a pause that fails skips the outage checks, still tries to thaw, and fails the gate", async () => {
		const h = harness();
		h.runs.pause = { code: 2, err: "[rehearsal] refused: rule pause-target: instance gate-test has no running ledger scratch container.\n" };
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(failedIds(receipt)).toEqual(["outage.pause"]);
		expect(receipt.checks.find((check) => check.id === "outage.chaos")?.status).toBe("skip");
		expect(receipt.checks.find((check) => check.id === "outage.brief")?.status).toBe("skip");
		expect(h.kinds()).not.toContain("chaos");
		expect(h.kinds()).toContain("unpause");
	});

	test("an unpause that fails leaves the gate red with the failure named, and cleanup tries once more", async () => {
		const h = harness();
		let attempts = 0;
		h.runs.unpause = () => {
			attempts += 1;
			if (attempts === 1) return { code: 2, err: "[rehearsal] refused: docker unpause of the ledger container failed.\n" };
			h.state.paused = false;
			return { code: 0 };
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(failedIds(receipt)).toContain("outage.unpause");
		expect(attempts).toBe(2);
		expect(receipt.checks.find((check) => check.id === "cleanup.unpause")?.status).toBe("pass");
		expect(h.state.paused).toBe(false);
	});

	test("a down that fails is a failure even when every proof passed, and says the twin may still be running", async () => {
		const h = harness();
		h.runs.down = { code: 2, err: "[rehearsal] refused: could not remove scratch containers for gate-test; keeping state.\n" };
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(failedIds(receipt)).toContain("cleanup.down");
		expect(receipt.checks.find((check) => check.id === "cleanup.down")?.detail).toContain("may still be running");
	});

	test("a failed teardown outranks an interruption: residue is never reported as unavailable", async () => {
		const h = harness();
		h.runs.chaos = () => {
			h.controller.abort("interrupted by SIGINT");
			throw new GateInterrupted("interrupted by SIGINT");
		};
		h.runs.down = { code: 2, err: "[rehearsal] refused: could not remove.\n" };
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
	});

	test("a failure the interrupted step itself produced is recorded before the interruption, so the exit is 1", async () => {
		const h = harness();
		h.runs.chaos = () => {
			h.controller.abort("interrupted by SIGTERM");
			return { code: 1, out: "\n16/18 checks passed\n\nfailed:\n  - no claim was granted while the ledger was refusing\n" };
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(receipt.unavailable).toBe("interrupted by SIGTERM");
		expect(failedIds(receipt)).toEqual(["outage.chaos"]);
		expect(h.state.paused).toBe(false);
		expect(h.containers).toEqual([]);
		// Nothing after the interrupted step ran as a proof.
		expect(h.checkIds(receipt)).not.toContain("recovery.healthz");
	});

	test("a check that already failed is not hidden by a later interruption", async () => {
		const h = harness();
		h.http["POST /events"] = () => json({ id: "e", stored: false }, 503);
		h.runs.chaos = () => {
			h.controller.abort("interrupted by SIGINT");
			throw new GateInterrupted("interrupted by SIGINT");
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(receipt.unavailable).toBe("interrupted by SIGINT");
		expect(failedIds(receipt)).toContain("emit");
	});

	test("labelled containers left after a successful down fail cleanup.residue", async () => {
		const h = harness();
		h.runs.down = () => {
			h.containers.length = 0;
			h.containers.push("cccccccccccc");
			return { code: 0 };
		};
		// A `down` that reports success but leaves one behind: the gate's own listing catches it.
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(receipt.checks.find((check) => check.id === "cleanup.residue")?.detail).toContain("1 labelled container(s) left");
	});

	test("a run directory left behind fails cleanup.residue", async () => {
		const h = harness();
		h.runs.down = () => {
			h.containers.length = 0;
			return { code: 0 };
		};
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(receipt.checks.find((check) => check.id === "cleanup.residue")?.detail).toContain("run directory");
	});

	test("an unlistable docker means residue cannot be ruled out, which fails", async () => {
		const h = harness();
		h.runs["docker-ps"] = { code: 1, err: "Cannot connect to the Docker daemon" };
		const receipt = await runGate(OPTIONS, h.deps);
		expect(receipt.exit).toBe(1);
		expect(receipt.checks.find((check) => check.id === "cleanup.residue")?.detail).toContain("could not list");
	});

	test("--keep leaves the twin up, skips down, and says how to remove it; a frozen ledger is still thawed", async () => {
		const h = harness();
		const receipt = await runGate({ ...OPTIONS, keep: true }, h.deps);
		expect(receipt.exit).toBe(0);
		expect(receipt.kept).toBe(true);
		expect(h.kinds()).not.toContain("down");
		expect(h.containers.length).toBeGreaterThan(0);
		expect(formatReceipt(receipt)).toContain("bun run rehearsal down --name gate-test");

		const interrupted = harness();
		interrupted.runs.chaos = () => {
			interrupted.controller.abort("interrupted by SIGINT");
			throw new GateInterrupted("interrupted by SIGINT");
		};
		await runGate({ ...OPTIONS, keep: true }, interrupted.deps);
		expect(interrupted.state.paused).toBe(false);
		expect(interrupted.kinds()).not.toContain("down");
	});
});

describe("formatReceipt", () => {
	const base: Receipt = {
		kind: "gate-receipt",
		name: "gate-x",
		commit: "0123456789ab",
		verdict: "fail",
		exit: 1,
		ms: 4321,
		checks: [
			{ id: "up", status: "pass", ms: 1200, detail: "twin gate-x healthy" },
			{ id: "outage.chaos", status: "fail", ms: 21000, detail: "exit 1: no claim was granted" },
			{ id: "recovery.emit", status: "skip", ms: 0, detail: "the ledger could not be unfrozen" },
		],
		unavailable: null,
		kept: false,
	};

	test("one row per check with its timing, then exactly one gate-receipt line", () => {
		const text = formatReceipt(base);
		expect(text).toContain("PASS  up");
		expect(text).toContain("FAIL  outage.chaos");
		expect(text).toContain("SKIP  recovery.emit");
		expect(text).toContain("21000 ms");
		const lines = text.split("\n").filter((line) => line.startsWith("gate-receipt "));
		expect(lines).toEqual(["gate-receipt name=gate-x commit=0123456789ab verdict=fail exit=1 checks=3 pass=1 fail=1 skip=1 notes=0 failed=outage.chaos unavailable=- kept=false ms=4321"]);
	});

	test("an unavailable receipt carries its reason JSON-quoted on the one line", () => {
		const text = formatReceipt({ ...base, verdict: "unavailable", exit: 2, checks: [], unavailable: "docker is unreachable" });
		expect(text).toContain('unavailable="docker is unreachable"');
		expect(text).toContain("failed=-");
		expect(text.split("\n").filter((line) => line.startsWith("gate-receipt ")).length).toBe(1);
	});
});
