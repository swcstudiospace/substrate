import { describe, expect, test } from "bun:test";
import { BYPASS_CONTENT, BYPASS_MODEL, MAX_BODY_BYTES, bypassHandler, sameSecret } from "./lightrag-llm-bypass.ts";

const KEY = "test-key-0123456789abcdef";
const URL_BASE = "http://bypass.test";

function call(path: string, init: RequestInit & { key?: string | null } = {}): Promise<Response> {
	const { key = KEY, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (key !== null && !headers.has("authorization")) headers.set("authorization", `Bearer ${key}`);
	return bypassHandler(new Request(`${URL_BASE}${path}`, { ...rest, headers }), KEY);
}

const CHAT = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("the bypass LLM", () => {
	test("a completion answers only LightRAG's delimiter, labelled as a bypass", async () => {
		const response = await call("/v1/chat/completions", CHAT({ model: "gpt-x", messages: [{ role: "user", content: "extract entities" }] }));
		expect(response.status).toBe(200);
		expect(response.headers.get("x-lightrag-llm")).toBe("bypass");
		const body = (await response.json()) as { model: string; choices: Array<{ message: { content: string } }> };
		expect(body.choices[0]?.message.content).toBe(BYPASS_CONTENT);
		expect(body.model).toBe("gpt-x");
	});

	test("a streamed completion ends with [DONE] and carries the same delimiter", async () => {
		const response = await call("/v1/chat/completions", CHAT({ messages: [], stream: true }));
		const text = await response.text();
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(text).toContain(BYPASS_CONTENT);
		expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});

	test("without the key, with a wrong key, or with a key of the same length, every route but /health refuses", async () => {
		expect((await call("/v1/models", { key: null })).status).toBe(401);
		expect((await call("/v1/models", { key: "wrong" })).status).toBe(401);
		expect((await call("/v1/models", { key: "x".repeat(KEY.length) })).status).toBe(401);
		expect((await call("/v1/chat/completions", { ...CHAT({ messages: [] }), key: "nope" })).status).toBe(401);
		expect((await call("/v1/models")).status).toBe(200);
	});

	test("it fails closed with no usable key: only /health answers, and says it is unconfigured", async () => {
		for (const key of [undefined, "", "short"]) {
			const health = await bypassHandler(new Request(`${URL_BASE}/health`), key);
			expect(await health.json()).toEqual({ status: "ok", mode: "bypass", configured: false });
			const models = await bypassHandler(new Request(`${URL_BASE}/v1/models`, { headers: { authorization: `Bearer ${key ?? ""}` } }), key);
			expect(models.status).toBe(503);
		}
	});

	test("/health needs no key and names the mode", async () => {
		const response = await call("/health", { key: null });
		expect(await response.json()).toEqual({ status: "ok", mode: "bypass", configured: true });
	});

	test("malformed, oversized and unknown requests are refused with a status, never an exception", async () => {
		expect((await call("/v1/chat/completions", { method: "POST", body: "{not json" })).status).toBe(400);
		expect((await call("/v1/chat/completions", CHAT({ messages: "nope" }))).status).toBe(400);
		expect((await call("/v1/chat/completions", CHAT(null))).status).toBe(400);
		const big = await call("/v1/chat/completions", { method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) });
		expect(big.status).toBe(413);
		expect((await call("/v1/embeddings", CHAT({}))).status).toBe(404);
	});

	test("an absent or hostile model name falls back to the bypass name", async () => {
		const hostile = await call("/v1/chat/completions", CHAT({ model: "m".repeat(500), messages: [] }));
		expect(((await hostile.json()) as { model: string }).model).toBe(BYPASS_MODEL);
		const absent = await call("/v1/chat/completions", CHAT({ messages: [] }));
		expect(((await absent.json()) as { model: string }).model).toBe(BYPASS_MODEL);
	});

	test("secret comparison is exact, including length and the empty string", () => {
		expect(sameSecret("abc", "abc")).toBe(true);
		expect(sameSecret("abc", "abd")).toBe(false);
		expect(sameSecret("abc", "abcd")).toBe(false);
		expect(sameSecret("", "abc")).toBe(false);
		expect(sameSecret("", "")).toBe(true);
	});
});
