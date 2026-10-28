/**
 * LightRAG LLM bypass: an OpenAI-compatible chat endpoint that never calls a model.
 *
 * Why it exists. LightRAG needs an LLM binding to start and to ingest, but the only real LLM routes this
 * deployment has (the `shunt` and `aio-grok-proxy` gateways) listen on the VPS loopback, and Railway has no path
 * back to the VPS (the Tailscale forwarder only carries VPS to Railway). Exposing a subscription-backed proxy
 * publicly is not acceptable, so LightRAG is pointed here instead.
 *
 * What it does. Every completion answers LightRAG's own completion delimiter and nothing else, so entity
 * extraction finds no entities: ingest stores chunks and their embeddings and builds no knowledge graph. Query
 * the server in `naive` mode (vector chunks only; it makes no LLM call). Graph modes need a real LLM.
 *
 * How it stays honest. The reply carries `x-lightrag-llm: bypass`, `/health` says `mode: "bypass"`, and the
 * model name is `bypass`, so nothing can mistake it for a model. It refuses to serve without `BYPASS_API_KEY`
 * and compares the bearer in constant time. It logs no request content.
 *
 * Deployed as a Railway Function (one file, Bun, Hono-free): the default export is the fetch handler.
 */

/** What LightRAG treats as "the model has finished and found nothing" (its default completion delimiter). */
export const BYPASS_CONTENT = "<|COMPLETE|>";
export const BYPASS_MODEL = "bypass";
/** A completion request is a prompt plus a chunk; far more than this is not LightRAG talking. */
export const MAX_BODY_BYTES = 2_000_000;

const JSON_HEADERS = { "content-type": "application/json", "x-lightrag-llm": "bypass" } as const;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function error(status: number, message: string): Response {
	return json({ error: { message, type: "invalid_request_error" } }, status);
}

/** Constant-time string equality, so a wrong key does not leak its matching prefix through timing. */
export function sameSecret(given: string, expected: string): boolean {
	const a = new TextEncoder().encode(given);
	const b = new TextEncoder().encode(expected);
	let diff = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

function completion(model: string): Record<string, unknown> {
	return {
		id: `chatcmpl-bypass-${crypto.randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, message: { role: "assistant", content: BYPASS_CONTENT }, finish_reason: "stop" }],
		usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
	};
}

function stream(model: string): Response {
	const id = `chatcmpl-bypass-${crypto.randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const body = `${chunk({ role: "assistant", content: BYPASS_CONTENT }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream", "x-lightrag-llm": "bypass" } });
}

/** The whole service, with the key injected so tests need no environment. */
export async function bypassHandler(request: Request, apiKey: string | undefined): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (request.method === "GET" && path === "/health") {
		return json({ status: "ok", mode: "bypass", configured: apiKey !== undefined && apiKey.length >= 16 });
	}
	// Fail closed: with no usable key nothing but /health answers.
	if (apiKey === undefined || apiKey.length < 16) return error(503, "BYPASS_API_KEY is not configured");
	const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
	if (bearer === undefined || !sameSecret(bearer, apiKey)) return error(401, "invalid api key");

	if (request.method === "GET" && path === "/v1/models") {
		return json({ object: "list", data: [{ id: BYPASS_MODEL, object: "model", owned_by: "bypass" }] });
	}
	if (request.method === "POST" && path === "/v1/chat/completions") {
		const declared = Number(request.headers.get("content-length") ?? "0");
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return error(413, "request too large");
		const text = await request.text();
		if (text.length > MAX_BODY_BYTES) return error(413, "request too large");
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return error(400, "body is not JSON");
		}
		if (body === null || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) {
			return error(400, "messages must be an array");
		}
		const requested = "model" in body ? body.model : undefined;
		const model = typeof requested === "string" && requested.length > 0 && requested.length <= 80 ? requested : BYPASS_MODEL;
		return "stream" in body && body.stream === true ? stream(model) : json(completion(model));
	}
	return error(404, "not found");
}

export default {
	fetch: (request: Request): Promise<Response> => bypassHandler(request, Bun.env.BYPASS_API_KEY),
};
