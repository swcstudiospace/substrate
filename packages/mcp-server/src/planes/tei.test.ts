/**
 * The TEI client against a fake server built on an injected fetch. No network and no real sleep: the clock, the
 * jitter and the sleep are injected, so the backoff the client asked for is asserted exactly. Every request is
 * recorded, so the wire contract (method, path, headers, body, abort signal) is checked, not only the outcome.
 */
import { describe, expect, test } from "bun:test";
import { BreakerOpenError, PlaneRegistry, gatedFetch, type PlaneFetch } from "@substrate/observability";
import type { TeiConfig } from "../config.ts";
import { defined } from "../test-support.ts";
import {
	BACKOFF_CAP_MS,
	MAX_ATTEMPTS,
	MAX_TEXTS_PER_CALL,
	MAX_TEXT_CHARS,
	MODEL_RECHECK_MS,
	TEI_REASONS,
	backoffMs,
	clampText,
	createTeiClient,
	parseTeiInfo,
	parseVectors,
	teiOp,
	type TeiDeps,
} from "./tei.ts";

const KEY = "tei-bearer-key-1";
const CONFIG: TeiConfig = { url: "http://tei.test:8080", timeoutMs: 10_000, batch: 32 };

interface Call {
	method: string;
	path: string;
	headers: Headers;
	body: unknown;
	signal: AbortSignal | null;
}

type Reply = Response | Error;

interface FakeState {
	model: string;
	dim: number;
	/** The `max_client_batch_size` `/info` reports; null leaves it out. */
	maxBatch: number | null;
	infoReplies: Reply[];
	embedReplies: Reply[];
	healthStatus: number;
}

function inputsOf(body: unknown): string[] {
	if (body !== null && typeof body === "object" && "inputs" in body && Array.isArray(body.inputs)) {
		return body.inputs.filter((entry): entry is string => typeof entry === "string");
	}
	return [];
}

/** One distinguishable vector per text: its length first, so order is visible in the answer. */
function vectorFor(text: string, dim: number): number[] {
	return Array.from({ length: dim }, (_, index) => text.length + index);
}

function realise(reply: Reply): Response {
	if (reply instanceof Error) throw reply;
	return reply;
}

/** A recording TEI: scripted replies are used first, then the healthy answer. */
function fakeTei(overrides: Partial<FakeState> = {}) {
	const state: FakeState = { model: "test-model", dim: 4, maxBatch: 2, infoReplies: [], embedReplies: [], healthStatus: 200, ...overrides };
	const calls: Call[] = [];
	const fetchImpl: PlaneFetch = async (input, init) => {
		const url = new URL(String(input));
		const raw = init?.body;
		const body: unknown = typeof raw === "string" ? JSON.parse(raw) : undefined;
		calls.push({ method: init?.method ?? "GET", path: url.pathname, headers: new Headers(init?.headers), body, signal: init?.signal ?? null });
		if (url.pathname === "/info") {
			const scripted = state.infoReplies.shift();
			if (scripted !== undefined) return realise(scripted);
			return Response.json({
				model_id: state.model,
				max_input_length: 512,
				...(state.maxBatch === null ? {} : { max_client_batch_size: state.maxBatch }),
			});
		}
		if (url.pathname === "/health") return new Response("", { status: state.healthStatus });
		if (url.pathname === "/embed") {
			const scripted = state.embedReplies.shift();
			if (scripted !== undefined) return realise(scripted);
			return Response.json(inputsOf(body).map((text) => vectorFor(text, state.dim)));
		}
		return new Response("", { status: 404 });
	};
	const embedCalls = () => calls.filter((call) => call.path === "/embed");
	const infoCalls = () => calls.filter((call) => call.path === "/info");
	return { state, calls, fetch: fetchImpl, embedCalls, infoCalls };
}

function clientFor(config: TeiConfig | null, fetchImpl: PlaneFetch, extra: Partial<TeiDeps> = {}) {
	const sleeps: number[] = [];
	let clock = 0;
	const client = createTeiClient(config, {
		fetch: fetchImpl,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		now: () => clock,
		random: () => 0.5,
		...extra,
	});
	return {
		client,
		sleeps,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const status = (code: number, headers: Record<string, string> = {}) => new Response("", { status: code, headers });

describe("embed: batching and order", () => {
	test("splits to the server's max_client_batch_size, keeps the order and reads /info once", async () => {
		const tei = fakeTei({ maxBatch: 2 });
		const { client } = clientFor(CONFIG, tei.fetch);
		const texts = ["a", "bb", "ccc", "dddd", "eeeee"];
		const result = await client.embed(texts);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(tei.embedCalls().map((call) => inputsOf(call.body))).toEqual([["a", "bb"], ["ccc", "dddd"], ["eeeee"]]);
		expect(result.vectors.map((vector) => vector[0])).toEqual([1, 2, 3, 4, 5]);
		expect(result.vectors.every((vector) => vector instanceof Float32Array && vector.length === 4)).toBe(true);
		expect(result).toMatchObject({ model: "test-model", dim: 4 });
		await client.embed(["x"]);
		expect(tei.infoCalls()).toHaveLength(1);
	});

	test("SUBSTRATE_TEI_BATCH lowers the batch below the server's limit, and the server's limit lowers it below the flag", async () => {
		const low = fakeTei({ maxBatch: 8 });
		await clientFor({ ...CONFIG, batch: 1 }, low.fetch).client.embed(["a", "b", "c"]);
		expect(low.embedCalls()).toHaveLength(3);
		const capped = fakeTei({ maxBatch: 2 });
		await clientFor({ ...CONFIG, batch: 100 }, capped.fetch).client.embed(["a", "b", "c"]);
		expect(capped.embedCalls().map((call) => inputsOf(call.body).length)).toEqual([2, 1]);
		const unreported = fakeTei({ maxBatch: null });
		await clientFor({ ...CONFIG, batch: 2 }, unreported.fetch).client.embed(["a", "b", "c"]);
		expect(unreported.embedCalls().map((call) => inputsOf(call.body).length)).toEqual([2, 1]);
	});

	test("the request carries normalize and truncate, a JSON body, an abort signal, and a bearer only when a key is set", async () => {
		const keyed = fakeTei();
		await clientFor({ ...CONFIG, apiKey: KEY }, keyed.fetch).client.embed(["hello"]);
		const call = defined(keyed.embedCalls()[0]);
		expect(call).toMatchObject({ method: "POST", body: { inputs: ["hello"], normalize: true, truncate: true } });
		expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(call.headers.get("content-type")).toBe("application/json");
		expect(call.signal).toBeInstanceOf(AbortSignal);
		expect(defined(keyed.infoCalls()[0]).headers.get("authorization")).toBe(`Bearer ${KEY}`);
		const open = fakeTei();
		await clientFor(CONFIG, open.fetch).client.embed(["hello"]);
		expect(defined(open.embedCalls()[0]).headers.has("authorization")).toBe(false);
	});

	test("empty input is an empty success and sends nothing, not even /info", async () => {
		const tei = fakeTei();
		const { client } = clientFor(CONFIG, tei.fetch);
		expect(await client.embed([])).toMatchObject({ ok: true, vectors: [] });
		expect(tei.calls).toHaveLength(0);
	});

	test("more texts than one call takes are refused before any request", async () => {
		const tei = fakeTei();
		const { client } = clientFor(CONFIG, tei.fetch);
		expect(await client.embed(Array.from({ length: MAX_TEXTS_PER_CALL + 1 }, () => "x"))).toEqual({ ok: false, reason: "input-refused" });
		expect(tei.calls).toHaveLength(0);
	});
});

describe("embed: long text", () => {
	test("a text over the bound is cut at the bound before it is sent", async () => {
		const tei = fakeTei();
		const { client } = clientFor(CONFIG, tei.fetch);
		await client.embed(["x".repeat(MAX_TEXT_CHARS + 500)]);
		expect(defined(inputsOf(defined(tei.embedCalls()[0]).body)[0])).toHaveLength(MAX_TEXT_CHARS);
	});

	test("the cut never splits a surrogate pair", () => {
		const text = `${"a".repeat(MAX_TEXT_CHARS - 1)}😀tail`;
		const cut = clampText(text);
		expect(cut).toHaveLength(MAX_TEXT_CHARS - 1);
		expect(cut.endsWith("a")).toBe(true);
		expect(clampText("short")).toBe("short");
		expect(clampText("x".repeat(MAX_TEXT_CHARS))).toHaveLength(MAX_TEXT_CHARS);
	});
});

describe("embed: retries and backoff", () => {
	test("a 429 is retried after the jittered backoff, and the call then succeeds", async () => {
		const tei = fakeTei({ embedReplies: [status(429)] });
		const { client, sleeps } = clientFor(CONFIG, tei.fetch);
		const result = await client.embed(["a"]);
		expect(result.ok).toBe(true);
		expect(tei.embedCalls()).toHaveLength(2);
		expect(sleeps).toEqual([backoffMs(0, 0.5)]);
	});

	test("successive failures wait exponentially longer, and a 5xx that never clears ends as unavailable after the attempt bound", async () => {
		const tei = fakeTei({ embedReplies: [status(503), status(500), status(502), status(504)] });
		const { client, sleeps } = clientFor(CONFIG, tei.fetch);
		expect(await client.embed(["a"])).toEqual({ ok: false, reason: "unavailable" });
		expect(tei.embedCalls()).toHaveLength(MAX_ATTEMPTS);
		expect(sleeps).toEqual([backoffMs(0, 0.5), backoffMs(1, 0.5), backoffMs(2, 0.5)]);
		expect(sleeps[1]).toBeGreaterThan(defined(sleeps[0]));
		expect(sleeps[2]).toBeGreaterThan(defined(sleeps[1]));
	});

	test("the last attempt's success is returned: three 503s then an answer", async () => {
		const tei = fakeTei({ embedReplies: [status(503), status(503), status(503)] });
		const { client } = clientFor(CONFIG, tei.fetch);
		expect((await client.embed(["a"])).ok).toBe(true);
		expect(tei.embedCalls()).toHaveLength(4);
	});

	test("Retry-After raises the wait, up to the cap", async () => {
		const tei = fakeTei({ embedReplies: [status(429, { "retry-after": "1" }), status(429, { "retry-after": "999" })] });
		const { client, sleeps } = clientFor(CONFIG, tei.fetch);
		await client.embed(["a"]);
		expect(sleeps).toEqual([1000, BACKOFF_CAP_MS]);
	});

	test("backoff is capped, jittered inside its window and never negative", () => {
		for (let attempt = 0; attempt < 12; attempt += 1) {
			for (const random of [0, 0.5, 0.999]) {
				const wait = backoffMs(attempt, random);
				expect(wait).toBeGreaterThanOrEqual(0);
				expect(wait).toBeLessThanOrEqual(BACKOFF_CAP_MS);
			}
		}
		expect(backoffMs(30, 0.999)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
		expect(backoffMs(0, 0)).toBeLessThan(backoffMs(0, 0.999));
	});

	test("a transport error is retried, and one that persists is unavailable without its text", async () => {
		const flaky = fakeTei({ embedReplies: [new Error(`ECONNREFUSED ${KEY}`)] });
		expect((await clientFor({ ...CONFIG, apiKey: KEY }, flaky.fetch).client.embed(["a"])).ok).toBe(true);
		const dead = fakeTei({ embedReplies: Array.from({ length: MAX_ATTEMPTS }, () => new Error(`ECONNREFUSED ${KEY}`)) });
		const result = await clientFor({ ...CONFIG, apiKey: KEY }, dead.fetch).client.embed(["a"]);
		expect(result).toEqual({ ok: false, reason: "unavailable" });
		expect(JSON.stringify(result)).not.toContain(KEY);
	});

	test("413 and 422 are permanent: input-refused, one request, no sleep", async () => {
		for (const code of [413, 422]) {
			const tei = fakeTei({ embedReplies: [status(code)] });
			const { client, sleeps } = clientFor(CONFIG, tei.fetch);
			expect(await client.embed(["a"])).toEqual({ ok: false, reason: "input-refused" });
			expect(tei.embedCalls()).toHaveLength(1);
			expect(sleeps).toEqual([]);
		}
	});

	test("other client errors are not retried: 400 is a bad response, 401 and 404 are unavailable", async () => {
		const expected: Array<[number, "bad-response" | "unavailable"]> = [
			[400, "bad-response"],
			[401, "unavailable"],
			[404, "unavailable"],
		];
		for (const [code, reason] of expected) {
			const tei = fakeTei({ embedReplies: [status(code)] });
			expect(await clientFor(CONFIG, tei.fetch).client.embed(["a"])).toEqual({ ok: false, reason });
			expect(tei.embedCalls()).toHaveLength(1);
		}
	});
});

describe("embed: timeout and breaker", () => {
	test("a request that times out answers timeout at once, with no retry", async () => {
		const timeout = new Error("The operation timed out.");
		timeout.name = "TimeoutError";
		const tei = fakeTei({ embedReplies: [timeout] });
		const { client, sleeps } = clientFor(CONFIG, tei.fetch);
		expect(await client.embed(["a"])).toEqual({ ok: false, reason: "timeout" });
		expect(tei.embedCalls()).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	test("5xx until the breaker opens ends as breaker-open, and the next call sends nothing", async () => {
		const registry = new PlaneRegistry({ enabled: true, failureThreshold: 2, openMs: 60_000 }, null, () => 0);
		const tei = fakeTei({ embedReplies: [status(503), status(503), status(503), status(503)] });
		const gated = gatedFetch(registry.gate("tei"), tei.fetch, teiOp);
		const { client } = clientFor(CONFIG, gated);
		expect(await client.embed(["a"])).toEqual({ ok: false, reason: "breaker-open" });
		expect(registry.gate("tei").breaker?.state()).toBe("open");
		const sent = tei.calls.length;
		expect(tei.embedCalls()).toHaveLength(2);
		expect(await client.embed(["b"])).toEqual({ ok: false, reason: "breaker-open" });
		expect(tei.calls).toHaveLength(sent);
	});

	test("an open breaker on the very first call answers breaker-open from the /info check", async () => {
		const tei = fakeTei({ infoReplies: [new BreakerOpenError("tei", 1000)] });
		expect(await clientFor(CONFIG, tei.fetch).client.embed(["a"])).toEqual({ ok: false, reason: "breaker-open" });
		expect(tei.embedCalls()).toHaveLength(0);
	});
});

describe("embed: model and dimension are pinned", () => {
	test("a TEI that serves another model than the pin is refused before any vector is requested", async () => {
		const tei = fakeTei({ model: "other-model" });
		const { client } = clientFor({ ...CONFIG, model: "test-model" }, tei.fetch);
		expect(await client.embed(["a"])).toEqual({ ok: false, reason: "model-mismatch" });
		expect(tei.embedCalls()).toHaveLength(0);
	});

	test("a matching pin passes, and the result names the model and the pinned dimension", async () => {
		const tei = fakeTei();
		const { client } = clientFor({ ...CONFIG, model: "test-model", dim: 4 }, tei.fetch);
		expect(await client.embed(["a"])).toMatchObject({ ok: true, model: "test-model", dim: 4 });
	});

	test("an unpinned model is learned, and a later change of model is refused at the recheck", async () => {
		const tei = fakeTei();
		const { client, advance } = clientFor(CONFIG, tei.fetch);
		expect((await client.embed(["a"])).ok).toBe(true);
		expect(client.snapshot().model).toBe("test-model");
		tei.state.model = "swapped-model";
		// Inside the recheck interval the model is not asked again.
		expect((await client.embed(["b"])).ok).toBe(true);
		expect(tei.infoCalls()).toHaveLength(1);
		advance(MODEL_RECHECK_MS);
		const before = tei.embedCalls().length;
		expect(await client.embed(["c"])).toEqual({ ok: false, reason: "model-mismatch" });
		expect(tei.infoCalls()).toHaveLength(2);
		expect(tei.embedCalls()).toHaveLength(before);
	});

	test("a failed first /info is the call's answer; a failed recheck keeps the earlier verdict", async () => {
		const down = fakeTei({ infoReplies: [status(503), status(503), status(503), status(503)] });
		expect(await clientFor(CONFIG, down.fetch).client.embed(["a"])).toEqual({ ok: false, reason: "unavailable" });
		expect(down.embedCalls()).toHaveLength(0);

		const tei = fakeTei();
		const { client, advance } = clientFor(CONFIG, tei.fetch);
		expect((await client.embed(["a"])).ok).toBe(true);
		advance(MODEL_RECHECK_MS);
		tei.state.infoReplies.push(status(503), status(503), status(503), status(503));
		expect((await client.embed(["b"])).ok).toBe(true);
	});

	test("an /info without a model_id is a bad response", async () => {
		const tei = fakeTei({ infoReplies: [Response.json({ max_input_length: 512 })] });
		expect(await clientFor(CONFIG, tei.fetch).client.embed(["a"])).toEqual({ ok: false, reason: "bad-response" });
	});

	test("a vector of another length than the pinned dimension is refused, on every response", async () => {
		const tei = fakeTei({ dim: 3, maxBatch: 1 });
		const { client } = clientFor({ ...CONFIG, dim: 4 }, tei.fetch);
		expect(await client.embed(["a"])).toEqual({ ok: false, reason: "dim-mismatch" });
		tei.state.dim = 4;
		expect((await client.embed(["a"])).ok).toBe(true);
		tei.state.dim = 5;
		expect(await client.embed(["a", "b"])).toEqual({ ok: false, reason: "dim-mismatch" });
	});

	test("an unpinned dimension is learned from the first answer, and a later answer of another length is refused", async () => {
		const tei = fakeTei({ dim: 4 });
		const { client } = clientFor(CONFIG, tei.fetch);
		expect(await client.embed(["a"])).toMatchObject({ ok: true, dim: 4 });
		expect(client.snapshot().dim).toBe(4);
		tei.state.dim = 3;
		expect(await client.embed(["b"])).toEqual({ ok: false, reason: "dim-mismatch" });
	});

	test("vectors of different lengths inside one answer are a dimension mismatch", async () => {
		const tei = fakeTei({ embedReplies: [Response.json([[1, 2], [1, 2, 3]])] });
		expect(await clientFor(CONFIG, tei.fetch).client.embed(["a", "b"])).toEqual({ ok: false, reason: "dim-mismatch" });
	});
});

describe("embed: malformed answers", () => {
	const answers: Array<[string, Response]> = [
		["not JSON", new Response("<html>", { status: 200 })],
		["an object", Response.json({ embeddings: [[1]] })],
		["too few vectors", Response.json([[1, 2]])],
		["too many vectors", Response.json([[1], [1], [1]])],
		["an empty vector", Response.json([[], []])],
		["a non-number", Response.json([[1, "x"], [1, 2]])],
		["a null", Response.json([null, [1]])],
	];
	for (const [name, answer] of answers) {
		test(`${name} is a bad response, never vectors`, async () => {
			const tei = fakeTei({ embedReplies: [answer] });
			expect(await clientFor(CONFIG, tei.fetch).client.embed(["a", "b"])).toEqual({ ok: false, reason: "bad-response" });
		});
	}

	test("parseVectors keeps the Float32 values and parseTeiInfo reads the three facts", () => {
		const parsed = parseVectors([[0.5, 1.5]], 1);
		expect(parsed.ok && defined(parsed.vectors[0])).toEqual(new Float32Array([0.5, 1.5]));
		expect(parseTeiInfo({ model_id: "m", max_input_length: 512, max_client_batch_size: 8, extra: true })).toEqual({
			modelId: "m",
			maxInputLength: 512,
			maxClientBatchSize: 8,
		});
		expect(parseTeiInfo({ model_id: "m", max_client_batch_size: 0 })).toEqual({ modelId: "m", maxInputLength: null, maxClientBatchSize: null });
		expect(parseTeiInfo({ model_id: "" })).toBeNull();
		expect(parseTeiInfo([])).toBeNull();
		expect(parseTeiInfo(null)).toBeNull();
	});
});

describe("not configured", () => {
	test("with no config every call answers not-configured and nothing is sent", async () => {
		const tei = fakeTei();
		const { client } = clientFor(null, tei.fetch);
		expect(client.configured).toBe(false);
		expect(await client.embed(["a"])).toEqual({ ok: false, reason: "not-configured" });
		expect(await client.embed([])).toEqual({ ok: false, reason: "not-configured" });
		expect(await client.info()).toEqual({ ok: false, reason: "not-configured" });
		expect(await client.health()).toEqual({ ok: false, reason: "not-configured" });
		expect(await client.probe()).toEqual({ ok: false, reason: "not-configured" });
		expect(tei.calls).toHaveLength(0);
		expect(client.snapshot()).toEqual({ model: null, dim: null, lastLatencyMs: null });
	});

	test("the closed reason list is exactly the eight the callers switch on", () => {
		expect([...TEI_REASONS]).toEqual([
			"not-configured",
			"breaker-open",
			"timeout",
			"unavailable",
			"bad-response",
			"model-mismatch",
			"dim-mismatch",
			"input-refused",
		]);
	});
});

describe("concurrent first calls and the snapshot", () => {
	test("two first calls at once share one /info read", async () => {
		const tei = fakeTei();
		const { client } = clientFor(CONFIG, tei.fetch);
		const [first, second] = await Promise.all([client.embed(["a"]), client.embed(["b"])]);
		expect(first.ok && second.ok).toBe(true);
		expect(tei.infoCalls()).toHaveLength(1);
	});

	test("the snapshot carries the pins or what was seen, and the latency of the last good request", async () => {
		const tei = fakeTei();
		let tick = 0;
		const { client } = clientFor(CONFIG, tei.fetch, { now: () => (tick += 5) });
		expect(client.snapshot()).toEqual({ model: null, dim: null, lastLatencyMs: null });
		await client.embed(["a"]);
		expect(client.snapshot()).toEqual({ model: "test-model", dim: 4, lastLatencyMs: 5 });
		const pinned = clientFor({ ...CONFIG, model: "pinned", dim: 7 }, fakeTei().fetch);
		expect(pinned.client.snapshot()).toEqual({ model: "pinned", dim: 7, lastLatencyMs: null });
	});
});

describe("health and probe", () => {
	test("health is ok on a 200 with its latency, and unavailable on anything else", async () => {
		const tei = fakeTei();
		let tick = 0;
		const { client } = clientFor(CONFIG, tei.fetch, { now: () => (tick += 3) });
		expect(await client.health()).toEqual({ ok: true, latencyMs: 3 });
		tei.state.healthStatus = 503;
		expect(await client.health()).toEqual({ ok: false, reason: "unavailable" });
		expect(tei.calls.every((call) => call.path === "/health")).toBe(true);
	});

	test("health reports a timeout and an open breaker by name", async () => {
		const timeout = new Error("timed out");
		timeout.name = "TimeoutError";
		const slow = clientFor(CONFIG, async () => {
			throw timeout;
		});
		expect(await slow.client.health()).toEqual({ ok: false, reason: "timeout" });
		const open = clientFor(CONFIG, async () => {
			throw new BreakerOpenError("tei", 1);
		});
		expect(await open.client.health()).toEqual({ ok: false, reason: "breaker-open" });
	});

	test("probe is ok when /health answers and /info names the pinned model, with one try of each and no sleep", async () => {
		const tei = fakeTei();
		const { client, sleeps } = clientFor({ ...CONFIG, model: "test-model" }, tei.fetch);
		expect(await client.probe(500)).toEqual({ ok: true });
		expect(tei.calls.map((call) => call.path).sort()).toEqual(["/health", "/info"]);
		expect(sleeps).toEqual([]);
	});

	test("probe fails on a model mismatch, an /info that errors (once, never retried) and a /health that errors", async () => {
		const wrong = fakeTei({ model: "other" });
		expect(await clientFor({ ...CONFIG, model: "test-model" }, wrong.fetch).client.probe()).toEqual({ ok: false, reason: "model-mismatch" });
		const noInfo = fakeTei({ infoReplies: [status(503)] });
		const noInfoClient = clientFor(CONFIG, noInfo.fetch);
		expect(await noInfoClient.client.probe()).toEqual({ ok: false, reason: "unavailable" });
		expect(noInfo.infoCalls()).toHaveLength(1);
		expect(noInfoClient.sleeps).toEqual([]);
		const unhealthy = fakeTei({ healthStatus: 503 });
		expect(await clientFor(CONFIG, unhealthy.fetch).client.probe()).toEqual({ ok: false, reason: "unavailable" });
	});

	test("an unpinned probe never learns a model: only an embed does", async () => {
		const tei = fakeTei();
		const { client } = clientFor(CONFIG, tei.fetch);
		expect(await client.probe()).toEqual({ ok: true });
		expect(client.snapshot().model).toBeNull();
	});
});

describe("teiOp", () => {
	test("is a fixed table, never the path", () => {
		expect(teiOp("POST", "http://tei.test:8080/embed")).toBe("embed");
		expect(teiOp("GET", "http://tei.test:8080/info?x=1")).toBe("info");
		expect(teiOp("GET", "http://tei.test:8080/health")).toBe("health");
		expect(teiOp("GET", "http://tei.test:8080/metrics")).toBe("other");
	});
});
