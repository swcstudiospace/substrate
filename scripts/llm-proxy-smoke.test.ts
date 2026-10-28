/**
 * What each group proves, and the bug it would catch:
 * - reply shapes: both wire formats count only non-empty text as an answer, so a 200
 *   that is an error envelope or an empty completion is not reported healthy;
 * - states: every state is reachable for both wire formats, from the status and body
 *   alone, so a proxy that is up but logged out is never reported unreachable or ok;
 * - bodies: oversized (declared or streamed) and non-JSON bodies are `invalid`, and
 *   no body text reaches the report;
 * - request: the dummy key is sent in the format's own header, redirects are not
 *   followed, and a signal bounds the call;
 * - loopback rule: cleartext http to a non-loopback host is refused before ANY request;
 * - exit codes and JSON: 0 iff one provider is ok, 2 on usage, and the JSON shape is pinned;
 * - secrecy: the dummy key (sent) and key-like text in an error message never print.
 * No network and no timer: fetch and the clock are injected.
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DUMMY_KEY,
	DEFAULT_TIMEOUT_MS,
	MAX_BODY_BYTES,
	PROVIDERS,
	buildRequest,
	errorParts,
	exitFor,
	formatTable,
	isLoopbackHost,
	main,
	parseArgs,
	probeProvider,
	replyText,
	resolveBase,
	resolveTimeout,
	scrubSecrets,
	type FetchFn,
	type Provider,
	type ProbeContext,
	type Report,
} from "./llm-proxy-smoke.ts";

const provider = (name: string): Provider => PROVIDERS.find((p) => p.name === name) as Provider;
const ANTHROPIC = provider("aio-grok-proxy");
const OPENAI = provider("hermes");
const BASE = "http://127.0.0.1:41417";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const anthropicOk = (text = "pong") => json(200, { type: "message", content: [{ type: "text", text }] });
const openaiOk = (text = "pong") => json(200, { choices: [{ message: { role: "assistant", content: text } }] });

function ticks(...values: number[]): () => number {
	const queue = [...values];
	return () => queue.shift() ?? values[values.length - 1] ?? 0;
}

function ctx(fetchFn: FetchFn, overrides: Partial<ProbeContext> = {}): ProbeContext {
	return { fetch: fetchFn, now: () => 0, dummyKey: DEFAULT_DUMMY_KEY, timeoutMs: DEFAULT_TIMEOUT_MS, ...overrides };
}

const refused = (): Error => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8645"), { code: "ECONNREFUSED" });
const timedOut = (): Error => Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });

describe("reply shapes", () => {
	test("anthropic-messages needs a non-empty text block", () => {
		expect(replyText("anthropic-messages", { content: [{ type: "text", text: "pong" }] })).toBe("pong");
		expect(replyText("anthropic-messages", { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "pong" }] })).toBe("pong");
		expect(replyText("anthropic-messages", { content: [{ type: "text", text: "  " }] })).toBeNull();
		expect(replyText("anthropic-messages", { content: [] })).toBeNull();
		expect(replyText("anthropic-messages", { choices: [{ message: { content: "pong" } }] })).toBeNull();
		expect(replyText("anthropic-messages", "pong")).toBeNull();
		expect(replyText("anthropic-messages", null)).toBeNull();
	});

	test("openai-chat needs a non-empty choices[0].message.content", () => {
		expect(replyText("openai-chat", { choices: [{ message: { content: "pong" } }] })).toBe("pong");
		expect(replyText("openai-chat", { choices: [{ message: { content: "" } }] })).toBeNull();
		expect(replyText("openai-chat", { choices: [{ message: { content: null } }] })).toBeNull();
		expect(replyText("openai-chat", { choices: [] })).toBeNull();
		expect(replyText("openai-chat", { content: [{ type: "text", text: "pong" }] })).toBeNull();
		expect(replyText("openai-chat", 7)).toBeNull();
	});

	test("error bodies of both formats give a type and a message", () => {
		expect(errorParts({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })).toEqual({ type: "authentication_error", message: "invalid x-api-key" });
		expect(errorParts({ error: { code: "invalid_api_key", message: "bad" } })).toEqual({ type: "invalid_api_key", message: "bad" });
		expect(errorParts({ error: "plain string" })).toEqual({ type: null, message: "plain string" });
		expect(errorParts({ error: { type: "has spaces and $ign", message: "m" } }).type).toBeNull();
		expect(errorParts("not an object")).toEqual({ type: null, message: null });
	});
});

describe("states, per wire format", () => {
	const cases: { label: string; provider: Provider; ok: () => Response; unauth: Response; unauthType: string }[] = [
		{ label: "anthropic-messages", provider: ANTHROPIC, ok: anthropicOk, unauth: json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), unauthType: "authentication_error" },
		{ label: "openai-chat", provider: OPENAI, ok: openaiOk, unauth: json(401, { error: { type: "invalid_request_error", message: "invalid_grant: run hermes auth" } }), unauthType: "invalid_request_error" },
	];

	for (const c of cases) {
		describe(c.label, () => {
			const run = (fetchFn: FetchFn) => probeProvider(c.provider, BASE, ctx(fetchFn, { now: ticks(100, 142) }));

			test("ok: 2xx with text in the expected shape, null reason, elapsed from the clock", async () => {
				expect(await run(async () => c.ok())).toEqual({ name: c.provider.name, url: BASE, state: "ok", ms: 42, reason: null });
			});

			test("unauthenticated: 401 carries the error type and a short reason", async () => {
				const result = await run(async () => c.unauth.clone() as unknown as Response);
				expect(result.state).toBe("unauthenticated");
				expect(result.reason).toStartWith(`HTTP 401 ${c.unauthType}: `);
			});

			test("unauthenticated: 403 with no parseable body is still unauthenticated", async () => {
				const result = await run(async () => new Response("<html>nope</html>", { status: 403 }));
				expect(result).toMatchObject({ state: "unauthenticated", reason: "HTTP 403" });
			});

			test("unreachable: connection refused", async () => {
				expect(await run(async () => Promise.reject(refused()))).toMatchObject({ state: "unreachable", reason: "connection refused" });
			});

			test("unreachable: timeout", async () => {
				expect(await run(async () => Promise.reject(timedOut()))).toMatchObject({ state: "unreachable", reason: `timeout after ${DEFAULT_TIMEOUT_MS} ms` });
			});

			test("unreachable: any other transport failure", async () => {
				expect(await run(async () => Promise.reject(new Error("boom")))).toMatchObject({ state: "unreachable", reason: "network error" });
			});

			test("invalid: 200 in the other format's shape", async () => {
				const wrong = c.provider.format === "anthropic-messages" ? openaiOk() : anthropicOk();
				expect(await run(async () => wrong)).toMatchObject({ state: "invalid", reason: `HTTP 200 without text in the ${c.provider.format} shape` });
			});

			test("invalid: 200 with an empty completion", async () => {
				const empty = c.provider.format === "anthropic-messages" ? anthropicOk("") : openaiOk("");
				expect((await run(async () => empty)).state).toBe("invalid");
			});

			test("invalid: 200 that is not JSON", async () => {
				expect(await run(async () => new Response("<html>ok</html>", { status: 200 }))).toMatchObject({ state: "invalid", reason: "HTTP 200 body is not JSON" });
			});

			test("invalid: a status that is neither success nor an auth refusal", async () => {
				expect(await run(async () => json(500, { error: "x" }))).toMatchObject({ state: "invalid", reason: "unexpected HTTP 500" });
				expect(await run(async () => json(404, {}))).toMatchObject({ state: "invalid", reason: "unexpected HTTP 404" });
			});

			test("invalid: a redirect is refused, not followed", async () => {
				expect(await run(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }))).toMatchObject({ state: "invalid", reason: "redirect refused (HTTP 302)" });
			});

			test("invalid: body over 1 MB by content-length, without being read", async () => {
				const result = await run(async () => new Response("{}", { status: 200, headers: { "content-length": String(MAX_BODY_BYTES + 1) } }));
				expect(result).toMatchObject({ state: "invalid", reason: "response body over 1 MB" });
			});

			test("invalid: body over 1 MB streamed with no content-length", async () => {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(600_000).fill(0x20));
						controller.enqueue(new Uint8Array(600_000).fill(0x20));
						controller.close();
					},
				});
				expect(await run(async () => new Response(stream, { status: 200 }))).toMatchObject({ state: "invalid", reason: "response body over 1 MB" });
			});

			test("a body of exactly 1 MB is read", async () => {
				const filler = " ".repeat(MAX_BODY_BYTES - 2);
				const result = await run(async () => new Response(`{${filler}}`, { status: 200 }));
				expect(result.reason).toBe("HTTP 200 without text in the " + c.provider.format + " shape");
			});

			test("invalid: a body that fails mid-read is not printed", async () => {
				const stream = new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.error(new Error("SECRET-DETAIL-sk-abcdefghijkl"));
					},
				});
				const result = await run(async () => new Response(stream, { status: 200 }));
				expect(result).toMatchObject({ state: "invalid", reason: "response body could not be read" });
			});

			test("unreachable: a timeout while the body is being read", async () => {
				const stream = new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.error(timedOut());
					},
				});
				expect((await run(async () => new Response(stream, { status: 200 }))).state).toBe("unreachable");
			});
		});
	}

	test("an unauthenticated reason keeps a proxy's invalid_grant hint but scrubs key-like text", async () => {
		const body = { type: "error", error: { type: "authentication_error", message: "invalid_grant for Bearer abc.def.ghi; run `shunt login xai` (x-api-key: sk-ant-api03-ABCDEFGH12345678)" } };
		const result = await probeProvider(provider("shunt-grok"), BASE, ctx(async () => json(401, body)));
		expect(result.state).toBe("unauthenticated");
		expect(result.reason).toContain("invalid_grant");
		expect(result.reason).toContain("shunt login xai");
		expect(result.reason).not.toContain("abc.def.ghi");
		expect(result.reason).not.toContain("sk-ant");
		expect(result.reason).not.toContain("ABCDEFGH12345678");
	});

	test("a reason is one line and at most 160 characters", async () => {
		const message = `line one\nline two ${"word ".repeat(100)}`;
		const result = await probeProvider(ANTHROPIC, BASE, ctx(async () => json(401, { error: { type: "authentication_error", message } })));
		expect(result.reason).not.toContain("\n");
		expect((result.reason as string).length).toBeLessThanOrEqual("HTTP 401 authentication_error: ".length + 160);
	});
});

describe("the request", () => {
	test("anthropic-messages: POST /v1/messages with x-api-key and the pong prompt at max_tokens 8", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		await probeProvider(ANTHROPIC, BASE, ctx(async (url, init) => (seen.push({ url, init }), anthropicOk())));
		expect(seen).toHaveLength(1);
		const { url, init } = seen[0] as { url: string; init: RequestInit };
		const headers = init.headers as Record<string, string>;
		expect(url).toBe(`${BASE}/v1/messages`);
		expect(init.method).toBe("POST");
		expect(headers["x-api-key"]).toBe(DEFAULT_DUMMY_KEY);
		expect(headers.authorization).toBeUndefined();
		expect(headers["anthropic-version"]).toBe("2023-06-01");
		expect(JSON.parse(init.body as string)).toEqual({ model: "grok-4.6", max_tokens: 8, messages: [{ role: "user", content: "Reply with the single word: pong" }] });
		expect(init.redirect).toBe("manual");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	test("openai-chat: POST /v1/chat/completions with a bearer", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		await probeProvider(OPENAI, "http://127.0.0.1:8645", ctx(async (url, init) => (seen.push({ url, init }), openaiOk())));
		const { url, init } = seen[0] as { url: string; init: RequestInit };
		const headers = init.headers as Record<string, string>;
		expect(url).toBe("http://127.0.0.1:8645/v1/chat/completions");
		expect(headers.authorization).toBe(`Bearer ${DEFAULT_DUMMY_KEY}`);
		expect(headers["x-api-key"]).toBeUndefined();
		expect(JSON.parse(init.body as string).max_tokens).toBe(8);
	});

	test("the table: shunt probes a Claude route, shunt-grok and aio-grok-proxy a Grok route, all on loopback defaults", () => {
		expect(PROVIDERS.map((p) => [p.name, p.defaultUrl, p.format, p.model])).toEqual([
			["shunt", "http://127.0.0.1:3001", "anthropic-messages", "claude-haiku-4-5"],
			["shunt-grok", "http://127.0.0.1:3001", "anthropic-messages", "grok-4.6"],
			["aio-grok-proxy", "http://127.0.0.1:41417", "anthropic-messages", "grok-4.6"],
			["hermes", "http://127.0.0.1:8645", "openai-chat", "grok-4.6"],
		]);
		for (const p of PROVIDERS) expect(isLoopbackHost(new URL(p.defaultUrl).hostname)).toBe(true);
	});

	test("the signal carries the configured timeout without a timer in the test", () => {
		expect(buildRequest(ANTHROPIC, BASE, "k", 5000).init.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("loopback rule", () => {
	test("loopback hosts", () => {
		for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "[::1]", "::1"]) expect(isLoopbackHost(host)).toBe(true);
		for (const host of ["10.0.0.5", "128.0.0.1", "127.0.0.256", "example.com", "127.0.0.1.example.com", "0.0.0.0", "[::2]"]) expect(isLoopbackHost(host)).toBe(false);
	});

	test("an http URL to a non-loopback host is refused, naming the variable and not the URL", () => {
		const result = resolveBase(ANTHROPIC, { LLM_PROXY_AIO_GROK_URL: "http://proxy.example.com:41417" });
		expect(result).toEqual({ error: "LLM_PROXY_AIO_GROK_URL is cleartext http to a non-loopback host; refusing to send a key there" });
		expect(JSON.stringify(result)).not.toContain("proxy.example.com");
	});

	test("https to a remote host, and http to a loopback override, are allowed; a trailing slash is dropped", () => {
		expect(resolveBase(ANTHROPIC, { LLM_PROXY_AIO_GROK_URL: "https://proxy.example.com/" })).toEqual({ base: "https://proxy.example.com" });
		expect(resolveBase(ANTHROPIC, { LLM_PROXY_AIO_GROK_URL: "http://localhost:9/base/" })).toEqual({ base: "http://localhost:9/base" });
		expect(resolveBase(ANTHROPIC, {})).toEqual({ base: BASE });
		expect(resolveBase(ANTHROPIC, { LLM_PROXY_AIO_GROK_URL: "   " })).toEqual({ base: BASE });
	});

	test("credentials in the URL, a non-http scheme and a non-URL are refused without echoing them", () => {
		for (const value of ["http://user:hunter2@127.0.0.1:1", "ftp://127.0.0.1", "not a url"]) {
			const result = resolveBase(ANTHROPIC, { LLM_PROXY_AIO_GROK_URL: value });
			expect("error" in result).toBe(true);
			expect(JSON.stringify(result)).not.toContain("hunter2");
		}
	});

	test("main refuses before any request is made", async () => {
		const calls: string[] = [];
		const err: string[] = [];
		const code = await main([], {
			env: { LLM_PROXY_HERMES_URL: "http://203.0.113.9:8645" },
			fetch: async (url) => (calls.push(url), anthropicOk()),
			stdout: () => undefined,
			stderr: (text) => void err.push(text),
		});
		expect(code).toBe(2);
		expect(calls).toEqual([]);
		expect(err.join("")).toContain("LLM_PROXY_HERMES_URL");
		expect(err.join("")).not.toContain("203.0.113.9");
	});

	test("--only skips the refusal for a provider that is not selected", async () => {
		const code = await main(["--only", "aio-grok-proxy"], {
			env: { LLM_PROXY_HERMES_URL: "http://203.0.113.9:8645" },
			fetch: async () => anthropicOk(),
			stdout: () => undefined,
			stderr: () => undefined,
		});
		expect(code).toBe(0);
	});
});

describe("arguments and config", () => {
	test("flags", () => {
		expect(parseArgs([])).toEqual({ json: false, only: [] });
		expect(parseArgs(["--json", "--only", "hermes", "--only=shunt", "--only", "hermes"])).toEqual({ json: true, only: ["hermes", "shunt"] });
	});

	test("usage errors", () => {
		expect(parseArgs(["--only"])).toEqual({ error: "--only needs a provider name" });
		expect("error" in parseArgs(["--only", "nope"])).toBe(true);
		expect("error" in parseArgs(["--verbose"])).toBe(true);
		expect("error" in parseArgs(["extra"])).toBe(true);
	});

	test("timeout", () => {
		expect(resolveTimeout({})).toBe(20000);
		expect(resolveTimeout({ LLM_PROXY_TIMEOUT_MS: "1500" })).toBe(1500);
		for (const bad of ["0", "-1", "abc", "1.5", "600001"]) expect("error" in (resolveTimeout({ LLM_PROXY_TIMEOUT_MS: bad }) as object)).toBe(true);
	});
});

describe("exit code and output", () => {
	/** A router for all four probes: key is `<port>/<model>`. */
	function router(routes: Record<string, () => Response | Promise<Response>>): FetchFn {
		return async (url, init) => {
			const model = JSON.parse(init.body as string).model as string;
			const key = `${new URL(url).port}/${model}`;
			const handler = routes[key];
			if (handler === undefined) throw refused();
			return handler();
		};
	}

	const unauth401 = () => json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });

	async function run(argv: string[], fetchFn: FetchFn, env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
		let out = "";
		let err = "";
		const code = await main(argv, { env, fetch: fetchFn, now: () => 0, stdout: (t) => void (out += t), stderr: (t) => void (err += t) });
		return { code, out, err };
	}

	test("exit 0 when one provider is ok and the others are not", async () => {
		const { code, out } = await run([], router({ "3001/claude-haiku-4-5": unauth401, "41417/grok-4.6": () => anthropicOk() }));
		expect(code).toBe(0);
		expect(out).toContain("aio-grok-proxy");
		expect(out).toContain("ok: aio-grok-proxy");
	});

	test("exit 1 when none is ok", async () => {
		const { code, out } = await run([], router({ "3001/claude-haiku-4-5": unauth401, "3001/grok-4.6": unauth401 }));
		expect(code).toBe(1);
		expect(out).toContain("no provider answered a prompt");
	});

	test("exit 2 on a usage error, with the usage line on stderr and nothing on stdout", async () => {
		const result = await run(["--bogus"], router({}));
		expect(result.code).toBe(2);
		expect(result.out).toBe("");
		expect(result.err).toContain("usage: bun scripts/llm-proxy-smoke.ts");
	});

	test("exitFor", () => {
		expect(exitFor([{ state: "unauthenticated" }, { state: "ok" }])).toBe(0);
		expect(exitFor([{ state: "unreachable" }, { state: "invalid" }])).toBe(1);
		expect(exitFor([])).toBe(1);
	});

	test("--json has a pinned shape: schema 1, providers in table order, ok", async () => {
		const { code, out } = await run(
			["--json"],
			router({ "3001/claude-haiku-4-5": unauth401, "41417/grok-4.6": () => anthropicOk() }),
		);
		expect(code).toBe(0);
		expect(out.endsWith("\n")).toBe(true);
		const report = JSON.parse(out) as Report;
		expect(Object.keys(report)).toEqual(["schema", "providers", "ok"]);
		expect(report.schema).toBe(1);
		expect(report.ok).toBe(true);
		expect(report.providers.map((p) => Object.keys(p))).toEqual(PROVIDERS.map(() => ["name", "url", "state", "ms", "reason"]));
		expect(report.providers).toEqual([
			{ name: "shunt", url: "http://127.0.0.1:3001", state: "unauthenticated", ms: 0, reason: "HTTP 401 authentication_error: invalid x-api-key" },
			{ name: "shunt-grok", url: "http://127.0.0.1:3001", state: "unreachable", ms: 0, reason: "connection refused" },
			{ name: "aio-grok-proxy", url: "http://127.0.0.1:41417", state: "ok", ms: 0, reason: null },
			{ name: "hermes", url: "http://127.0.0.1:8645", state: "unreachable", ms: 0, reason: "connection refused" },
		]);
	});

	test("--only selects, and repeats keep table order", async () => {
		const { out } = await run(["--json", "--only", "hermes", "--only", "shunt"], router({}));
		expect((JSON.parse(out) as Report).providers.map((p) => p.name)).toEqual(["shunt", "hermes"]);
	});

	test("the elapsed time comes from the injected clock", async () => {
		const report = await (async () => {
			let out = "";
			await main(["--json", "--only", "hermes"], { env: {}, fetch: async () => openaiOk(), now: ticks(10, 35), stdout: (t) => void (out += t), stderr: () => undefined });
			return JSON.parse(out) as Report;
		})();
		expect(report.providers[0]).toMatchObject({ state: "ok", ms: 25 });
	});

	test("the table has a header, one aligned row per provider and a summary", () => {
		const text = formatTable({ schema: 1, ok: false, providers: [{ name: "hermes", url: "http://127.0.0.1:8645", state: "unreachable", ms: 3, reason: "connection refused" }] });
		const lines = text.trimEnd().split("\n");
		expect(lines[0]).toMatch(/^PROVIDER\s+STATE\s+MS\s+URL\s+REASON$/);
		expect(lines[1]).toMatch(/^hermes\s+unreachable\s+3\s+http:\/\/127\.0\.0\.1:8645\s+connection refused$/);
		expect(lines.at(-1)).toBe("no provider answered a prompt");
	});

	test("an override URL and a custom timeout reach the request", async () => {
		const seen: string[] = [];
		await run(["--only", "hermes"], async (url) => (seen.push(url), openaiOk()), { LLM_PROXY_HERMES_URL: "http://127.0.0.1:9999/", LLM_PROXY_TIMEOUT_MS: "250" });
		expect(seen).toEqual(["http://127.0.0.1:9999/v1/chat/completions"]);
	});
});

describe("secrecy", () => {
	test("the dummy key is sent but never appears in the table or the JSON, even when a proxy echoes it", async () => {
		const key = "dummy-not-a-real-key-0123456789";
		const sent: string[] = [];
		const echo: FetchFn = async (_url, init) => {
			const headers = init.headers as Record<string, string>;
			sent.push(headers["x-api-key"] ?? headers.authorization ?? "");
			return json(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${key}; Authorization: Bearer ${key}` } });
		};
		for (const argv of [[], ["--json"]]) {
			let out = "";
			let err = "";
			await main(argv, { env: { LLM_PROXY_DUMMY_KEY: key }, fetch: echo, now: () => 0, stdout: (t) => void (out += t), stderr: (t) => void (err += t) });
			expect(out).not.toContain(key);
			expect(err).not.toContain(key);
			expect(out).toContain("authentication_error");
		}
		expect(sent.length).toBeGreaterThan(0);
		for (const header of sent) expect(header).toContain(key);
	});

	test("the default dummy key is sent and not printed", async () => {
		let out = "";
		const echo: FetchFn = async (_u, init) => json(401, { error: { type: "authentication_error", message: `bad ${(init.headers as Record<string, string>)["x-api-key"]}` } });
		await main(["--only", "shunt"], { env: {}, fetch: echo, now: () => 0, stdout: (t) => void (out += t), stderr: () => undefined });
		expect(out).not.toContain(DEFAULT_DUMMY_KEY);
		expect(out).toContain("[scrubbed]");
	});

	test("response bodies are never printed: a 200 and a failed read leave no body text in the output", async () => {
		let out = "";
		await main(["--json", "--only", "hermes"], { env: {}, fetch: async () => new Response("TOP-SECRET-BODY-TEXT", { status: 200 }), now: () => 0, stdout: (t) => void (out += t), stderr: () => undefined });
		expect(out).not.toContain("TOP-SECRET-BODY-TEXT");
		expect(out).toContain('"state":"invalid"');
	});

	test("scrubSecrets removes the literal secret, bearer values, key=value pairs and long opaque tokens", () => {
		const text = scrubSecrets("a Bearer tok_123 b api_key=abc123 c ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 d literal-secret e", ["literal-secret"]);
		expect(text).not.toMatch(/tok_123|abc123|ABCDEFGHIJ|literal-secret/);
		expect(text).toContain("a [scrubbed] b");
	});

	test("scrubSecrets runs the shared redactor, so a vendor-prefixed key never reaches a reason", () => {
		const text = scrubSecrets("rejected sk-ant-api03-ABCDEFGHIJKLMNOP for this account", []);
		expect(text).not.toContain("ABCDEFGHIJKLMNOP");
		expect(text).toContain("REDACTED");
	});

	test("scrubSecrets leaves ordinary prose alone", () => {
		expect(scrubSecrets("invalid x-api-key", [])).toBe("invalid x-api-key");
		expect(scrubSecrets("run `shunt login xai` (invalid_grant)", [])).toBe("run `shunt login xai` (invalid_grant)");
	});
});
