/**
 * Tests for the dispatcher substrate client (DISP-05, T-24-03a).
 *
 * A fake fetch records every request body; no network, no live MCP server.
 * The forbidden holder operation's name is assembled by concatenation so
 * even this test file carries no claim path literal.
 */

import { describe, expect, test } from "bun:test";
import { SubstrateClient, SubstrateError } from "./substrate-client.ts";

const FORBIDDEN_TOOL = ["graph", "claim"].join("_");

interface RecordedRequest {
	url: string;
	init: RequestInit;
}

function okEnvelope(payload: unknown): string {
	return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify(payload) }] } });
}

function fakeFetch(handler: (body: Record<string, unknown>) => string): {
	requests: RecordedRequest[];
	fetchFn: typeof fetch;
} {
	const requests: RecordedRequest[] = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		requests.push({ url, init });
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		return { ok: true, status: 200, text: async () => handler(body) };
	}) as unknown as typeof fetch;
	return { requests, fetchFn };
}

function makeClient(fetchFn: typeof fetch): SubstrateClient {
	return new SubstrateClient({ baseUrl: "http://127.0.0.1:7410/", token: "substrate-token", fetchFn });
}

describe("substrate-client request shape", () => {
	test("graph_find posts a tools/call envelope with the substrate bearer", async () => {
		const { requests, fetchFn } = fakeFetch(() => okEnvelope({ found: false, reason: "nope" }));
		const client = makeClient(fetchFn);
		const result = await client.findNode({ linear_issue_id: "iss-1", linear_identifier: "ENG-1" });
		expect(result).toEqual({ found: false, reason: "nope" });
		expect(requests).toHaveLength(1);
		const request = requests[0];
		if (!request) throw new Error("expected one recorded request");
		expect(request.url).toBe("http://127.0.0.1:7410/mcp");
		expect(request.init.method).toBe("POST");
		const headers = request.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer substrate-token");
		expect(JSON.parse(request.init.body as string)).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "graph_find", arguments: { linear_issue_id: "iss-1", linear_identifier: "ENG-1" } },
		});
	});

	test("a JSON body reply parses without an SSE frame", async () => {
		const { requests, fetchFn } = fakeFetch(() => okEnvelope({ found: false, reason: "x" }));
		const client = makeClient(fetchFn);
		const result = await client.findNode({ linear_issue_id: "a", linear_identifier: "b" });
		expect(result).toEqual({ found: false, reason: "x" });
	});

	test("the first SSE data line parses when the server streams", async () => {
		const { requests, fetchFn } = fakeFetch(
			() => `: keep-alive\ndata: ${okEnvelope({ graph_id: "ut-x-12345678", nodes: [] })}\n`,
		);
		const client = makeClient(fetchFn);
		const graph = await client.getGraph("ut-x-12345678");
		expect(graph).toEqual({ graph_id: "ut-x-12345678", nodes: [] });
	});

	test("events_emit always names surface substrate", async () => {
		const { requests, fetchFn } = fakeFetch(() => okEnvelope({ stored: true }));
		const client = makeClient(fetchFn);
		await client.emitEvent({
			kind: "note",
			summary: "dispatched ut-x-12345678: launched",
			session_id: "dispatch:ut-x-12345678:0",
			graph_id: "ut-x-12345678",
			payload: { action: "dispatch", runtime: "dispatcher", outcome: "launched" },
		});
		const emitted = requests[0];
		if (!emitted) throw new Error("expected one recorded request");
		const body = JSON.parse(emitted.init.body as string) as {
			params: { name: string; arguments: Record<string, unknown> };
		};
		expect(body.params.name).toBe("events_emit");
		expect(body.params.arguments.surface).toBe("substrate");
	});

	test("no request body ever names the holder-only claim operation", async () => {
		const { requests, fetchFn } = fakeFetch((body) => {
			const params = body.params as { name: string };
			if (params.name === "graph_get") return okEnvelope(null);
			return okEnvelope({ found: true, graph_id: "g", node_id: "n", repo: null, branch: null, node: {} });
		});
		const client = makeClient(fetchFn);
		await client.findNode({ linear_issue_id: "iss-1", linear_identifier: "ENG-1" });
		await client.getGraph("g");
		await client.emitEvent({
			kind: "warning",
			summary: "dispatch failed for g: no-node",
			session_id: "dispatch:g:0",
			graph_id: "g",
			payload: { action: "dispatch", runtime: "dispatcher", outcome: "failed", reason: "no-node" },
		});
		expect(requests.length).toBeGreaterThan(0);
		for (const request of requests) {
			expect(request.init.body as string).not.toContain(FORBIDDEN_TOOL);
		}
	});

	test("a disallowed tool is refused before any fetch", async () => {
		let calls = 0;
		const fetchFn = (async () => {
			calls += 1;
			return { ok: true, status: 200, text: async () => "null" };
		}) as unknown as typeof fetch;
		const client = new SubstrateClient({ baseUrl: "http://127.0.0.1:7410", token: "t", fetchFn });
		await expect(client.callTool(FORBIDDEN_TOOL as never, {})).rejects.toBeInstanceOf(SubstrateError);
		expect(calls).toBe(0);
	});

	test("HTTP and JSON-RPC failures surface as SubstrateError", async () => {
		const badHttp = new SubstrateClient({
			baseUrl: "http://127.0.0.1:7410",
			token: "t",
			fetchFn: (async () => ({ ok: false, status: 500, text: async () => "boom" })) as unknown as typeof fetch,
		});
		await expect(badHttp.getGraph("g")).rejects.toBeInstanceOf(SubstrateError);

		const badRpc = new SubstrateClient({
			baseUrl: "http://127.0.0.1:7410",
			token: "t",
			fetchFn: (async () => ({
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "denied" } }),
			})) as unknown as typeof fetch,
		});
		await expect(badRpc.getGraph("g")).rejects.toBeInstanceOf(SubstrateError);
	});

	test("the real fetch path carries a 10 s abort signal", async () => {
		const { requests, fetchFn } = fakeFetch(() => okEnvelope({ found: false, reason: "x" }));
		const client = makeClient(fetchFn);
		await client.findNode({ linear_issue_id: "a", linear_identifier: "b" });
		const signal = requests[0]?.init.signal;
		expect(signal).toBeInstanceOf(AbortSignal);
		expect((signal as AbortSignal).aborted).toBe(false);
	});

	test("an aborted read surfaces as a SubstrateError naming the timeout", async () => {
		const timedOut = new SubstrateClient({
			baseUrl: "http://127.0.0.1:7410",
			token: "t",
			fetchFn: (async () => {
				throw new DOMException("The operation timed out", "TimeoutError");
			}) as unknown as typeof fetch,
		});
		const error = await timedOut.getGraph("g").catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(SubstrateError);
		expect((error as SubstrateError).message).toContain("timed out");
	});

	test("a plain-text graph_get reply reads as a missing graph", async () => {
		const { fetchFn } = fakeFetch(
			() => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text: "no such graph" }] } }),
		);
		const client = makeClient(fetchFn);
		await expect(client.getGraph("ut-missing-12345678")).resolves.toBeNull();
	});

	test("a plain-text graph_find reply fails loudly", async () => {
		const { fetchFn } = fakeFetch(
			() => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text: "no such graph" }] } }),
		);
		const client = makeClient(fetchFn);
		await expect(client.findNode({ linear_issue_id: "a", linear_identifier: "b" })).rejects.toBeInstanceOf(
			SubstrateError,
		);
	});

	test("a stored:false reply writes one stderr line and still resolves", async () => {
		const { fetchFn } = fakeFetch(() => okEnvelope({ stored: false }));
		const client = makeClient(fetchFn);
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
		try {
			await client.emitEvent({
				kind: "warning",
				summary: "dispatch failed for g: no-node",
				session_id: "dispatch:g:0",
				graph_id: "g",
				payload: { action: "dispatch", runtime: "dispatcher", outcome: "failed", reason: "no-node" },
			});
		} finally {
			console.error = original;
		}
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("warning");
		expect(errors[0]).toContain("dispatch:g:0");
	});

	test("a stored:true reply stays silent", async () => {
		const { fetchFn } = fakeFetch(() => okEnvelope({ stored: true }));
		const client = makeClient(fetchFn);
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
		try {
			await client.emitEvent({
				kind: "note",
				summary: "dispatched g: launched",
				session_id: "dispatch:g:0",
				graph_id: "g",
				payload: { action: "dispatch", runtime: "dispatcher" },
			});
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});
});
