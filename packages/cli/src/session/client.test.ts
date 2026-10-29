/**
 * The rollback server client against a scripted fetch: the request it sends, the answers it parses, and
 * the way every failure becomes `{ok:false}` instead of an exception. No network and no real delay.
 */
import { describe, expect, test } from "bun:test";
import {
	type ClientOptions,
	type FetchLike,
	type RecordCheckpointRequest,
	type RollbackServerClient,
	createRollbackServerClient,
	isUnreachable,
	offlineClient,
} from "./client.ts";

const TOKEN = "tok-CANARY-0123456789abcdef-secret";
const CKPT = `ckpt_${"a".repeat(26)}`;
const TREE = "b".repeat(40);
const SHA = "c".repeat(64);

const RECORD: RecordCheckpointRequest = {
	session_id: "sess-1",
	ckpt_id: CKPT,
	seq: 1,
	trigger: "manual",
	git_tree: TREE,
	manifest_sha256: SHA,
	file_count: 3,
	skipped_count: 0,
};

type Seen = { url: string; headers: Record<string, string>; body: { method: string; params: { name: string; arguments: Record<string, unknown> } } };

function rpc(result: unknown, init?: { status?: number; isError?: boolean }): Response {
	const body = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(result) }], ...(init?.isError ? { isError: true } : {}) } };
	return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "content-type": "application/json" } });
}

function client(respond: (seen: Seen) => Response | Promise<Response>, extra: Partial<ClientOptions> = {}, bearer: string | null = TOKEN): { api: RollbackServerClient; seen: Seen[] } {
	const seen: Seen[] = [];
	const fetch: FetchLike = async (url, init) => {
		const entry: Seen = { url, headers: init.headers, body: JSON.parse(init.body) as Seen["body"] };
		seen.push(entry);
		return respond(entry);
	};
	return { api: createRollbackServerClient({ url: "http://127.0.0.1:7410/", ...(bearer === null ? {} : { token: bearer }), timeoutMs: 1500, fetch, ...extra }), seen };
}

const PLAN = {
	rollback_id: `rb_${"0".repeat(26)}`,
	session_id: "sess-1",
	target: { ckpt_id: CKPT, seq: 1, event_id: "evt_1", event_hash: SHA, git_tree: TREE, manifest_sha256: SHA },
	later_checkpoints: [{ ckpt_id: `ckpt_${"b".repeat(26)}`, seq: 2 }],
	anchor: { status: "anchored", reasons: [] },
	memory: { would_forget: 3, sample_ids: ["m1"], truncated: false },
	plan_digest: "digest-1",
};

describe("requests", () => {
	test("each call is one JSON-RPC tools/call POST to /mcp with the bearer and the tool's arguments", async () => {
		const { api, seen } = client(() => rpc({ ok: true, ckpt_id: CKPT, event_id: "evt_1", stored: true }));
		const result = await api.recordCheckpoint(RECORD);
		expect(result).toEqual({ ok: true, value: { ckpt_id: CKPT, event_id: "evt_1", stored: true } });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe("http://127.0.0.1:7410/mcp");
		expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(seen[0]?.headers.accept).toBe("application/json, text/event-stream");
		expect(seen[0]?.body.method).toBe("tools/call");
		expect(seen[0]?.body.params.name).toBe("session_checkpoint");
		expect(seen[0]?.body.params.arguments).toEqual(RECORD);
	});

	test("no token means no authorization header", async () => {
		const { api, seen } = client(() => rpc({ ok: true, ckpt_id: CKPT, event_id: "e", stored: false }), {}, null);
		await api.recordCheckpoint(RECORD);
		expect(seen[0]?.headers.authorization).toBeUndefined();
	});

	test("plan and commit use their own tools", async () => {
		const { api, seen } = client((entry) =>
			entry.body.params.name === "session_rollback_plan" ? rpc({ ok: true, plan: PLAN }) : rpc({ ok: true, event_id: "evt_9" }),
		);
		await api.planRollback({ session_id: "sess-1", target_ckpt_id: CKPT, rollback_id: PLAN.rollback_id });
		await api.commitRollback({ session_id: "sess-1", rollback_id: PLAN.rollback_id, target_ckpt_id: CKPT, outcome: "refused", reason: "drift-detected" });
		expect(seen.map((entry) => entry.body.params.name)).toEqual(["session_rollback_plan", "session_rollback_commit"]);
	});

	test("taken_at_ms and until_ms travel as arguments of their tools", async () => {
		const { api, seen } = client((entry) => {
			const tool = entry.body.params.name;
			if (tool === "session_checkpoint") return rpc({ ok: true, ckpt_id: CKPT, event_id: "evt_1", stored: true });
			return tool === "session_rollback_plan" ? rpc({ ok: true, plan: PLAN }) : rpc({ ok: true, event_id: "evt_9" });
		});
		await api.recordCheckpoint({ ...RECORD, taken_at_ms: 1_788_000_000_000 });
		await api.planRollback({ session_id: "sess-1", target_ckpt_id: CKPT, until_ms: 1_788_000_000_500 });
		await api.commitRollback({
			session_id: "sess-1",
			rollback_id: PLAN.rollback_id,
			target_ckpt_id: CKPT,
			plan_digest: "digest-1",
			outcome: "committed",
			from_ckpt_id: CKPT,
			pre_restore_tree: TREE,
			pre_restore_ckpt_id: CKPT,
			files: { added: 0, modified: 0, deleted: 0 },
			transcript: "marker-only",
			until_ms: 1_788_000_000_500,
		});
		expect(seen[0]?.body.params.arguments["taken_at_ms"]).toBe(1_788_000_000_000);
		expect(seen[1]?.body.params.arguments["until_ms"]).toBe(1_788_000_000_500);
		expect(seen[2]?.body.params.arguments["until_ms"]).toBe(1_788_000_000_500);
	});

	test("a reply sent as one SSE data line parses like plain JSON", async () => {
		const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ok: true, ckpt_id: CKPT, event_id: "evt_2", stored: true }) }] } });
		const { api } = client(() => new Response(`event: message\ndata: ${payload}\n\n`, { status: 200 }));
		expect(await api.recordCheckpoint(RECORD)).toEqual({ ok: true, value: { ckpt_id: CKPT, event_id: "evt_2", stored: true } });
	});
});

describe("parsing successful answers", () => {
	test("a plan is parsed field by field, with the transcript pointer checked", async () => {
		const withRef = { ...PLAN, target: { ...PLAN.target, transcript_ref: { surface: "claude-code", session_locator: "abc", turn_no: 4 } } };
		const { api } = client(() => rpc({ ok: true, plan: withRef }));
		const result = await api.planRollback({ session_id: "sess-1", target_ckpt_id: CKPT });
		expect(result.ok && result.value.plan.target.transcript_ref).toEqual({ surface: "claude-code", session_locator: "abc", turn_no: 4 });
		expect(result.ok && result.value.plan.anchor).toEqual({ status: "anchored", reasons: [] });
	});

	test("a plan that breaks the contract is a bad-response, not a crash", async () => {
		const broken: unknown[] = [
			{ ...PLAN, plan_digest: undefined },
			{ ...PLAN, anchor: { status: "shiny", reasons: [] } },
			{ ...PLAN, memory: { would_forget: -1, sample_ids: [], truncated: false } },
			{ ...PLAN, memory: { ...PLAN.memory, sample_ids: Array.from({ length: 21 }, (_, i) => `m${i}`) } },
			{ ...PLAN, target: { ...PLAN.target, transcript_ref: { surface: "claude-code", session_locator: "/etc/passwd", turn_no: 1 } } },
		];
		for (const plan of broken) {
			const { api } = client(() => rpc({ ok: true, plan }));
			const result = await api.planRollback({ session_id: "sess-1", target_ckpt_id: CKPT });
			expect(result.ok).toBe(false);
			expect(!result.ok && result.error.code).toBe("bad-response");
		}
	});

	test("a null anchor is allowed (no anchor information)", async () => {
		const { api } = client(() => rpc({ ok: true, plan: { ...PLAN, anchor: null } }));
		const result = await api.planRollback({ session_id: "sess-1", target_ckpt_id: CKPT });
		expect(result.ok && result.value.plan.anchor).toBeNull();
	});

	test("a commit answer must carry an event id, and its memory block is validated when present", async () => {
		const good = client(() => rpc({ ok: true, event_id: "evt_3", memory: { superseded_entries: 2, forgotten_documents: 1, plane_pending: true, truncated: false } }));
		const committed = await good.api.commitRollback({ session_id: "s", rollback_id: PLAN.rollback_id, target_ckpt_id: CKPT, outcome: "refused", reason: "drift-detected" });
		expect(committed).toEqual({ ok: true, value: { event_id: "evt_3", memory: { superseded_entries: 2, forgotten_documents: 1, plane_pending: true, truncated: false } } });
		const missing = client(() => rpc({ ok: true }));
		expect((await missing.api.commitRollback({ session_id: "s", rollback_id: PLAN.rollback_id, target_ckpt_id: CKPT, outcome: "refused", reason: "drift-detected" })).ok).toBe(false);
		const badMemory = client(() => rpc({ ok: true, event_id: "e", memory: { superseded_entries: "2" } }));
		expect((await badMemory.api.commitRollback({ session_id: "s", rollback_id: PLAN.rollback_id, target_ckpt_id: CKPT, outcome: "refused", reason: "drift-detected" })).ok).toBe(false);
	});
});

describe("failures never throw", () => {
	async function failureOf(respond: () => Response | Promise<Response>, extra: Partial<ClientOptions> = {}) {
		const { api } = client(respond, extra);
		const result = await api.recordCheckpoint(RECORD);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a failure");
		return result.error;
	}

	test("a rejected fetch is a retryable network failure", async () => {
		const error = await failureOf(() => Promise.reject(new TypeError("fetch failed")));
		expect(error).toMatchObject({ code: "network", retryable: true });
		expect(isUnreachable(error)).toBe(true);
	});

	test("a rejection that is not an Error is still a failure", async () => {
		const error = await failureOf(() => Promise.reject("boom"));
		expect(error.code).toBe("network");
	});

	test("an injected expired signal is a retryable timeout, with no real delay", async () => {
		const fetch: FetchLike = async (_url, init) => {
			if (init.signal.aborted) throw init.signal.reason;
			return rpc({ ok: true });
		};
		const api = createRollbackServerClient({
			url: "http://127.0.0.1:7410",
			timeoutMs: 1500,
			fetch,
			signalFor: () => AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
		});
		const result = await api.recordCheckpoint(RECORD);
		expect(result).toMatchObject({ ok: false, error: { code: "timeout", retryable: true } });
	});

	test("401 and 403 are unauthorized and not retryable", async () => {
		for (const status of [401, 403]) {
			const error = await failureOf(() => new Response("no", { status }));
			expect(error).toMatchObject({ code: "unauthorized", retryable: false });
			expect(isUnreachable(error)).toBe(false);
		}
	});

	test("429 and 5xx are retryable server failures", async () => {
		expect(await failureOf(() => new Response("slow down", { status: 429 }))).toMatchObject({ code: "rate-limited", retryable: true });
		expect(await failureOf(() => new Response("<html>bad gateway</html>", { status: 502 }))).toMatchObject({ code: "server-error", retryable: true });
	});

	test("a 200 that is not JSON, and a 404 that is not JSON", async () => {
		expect(await failureOf(() => new Response("<html>hello</html>", { status: 200 }))).toMatchObject({ code: "bad-response", retryable: false });
		expect(await failureOf(() => new Response("nope", { status: 404 }))).toMatchObject({ code: "http-404", retryable: false });
	});

	test("a JSON-RPC error, an isError result and a tool answer that is not JSON", async () => {
		expect(
			await failureOf(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid arguments" } }), { status: 200 })),
		).toMatchObject({ code: "rpc-error", retryable: false });
		expect(await failureOf(() => rpc("session_checkpoint is not enabled", { isError: true }))).toMatchObject({ code: "tool-error" });
		const raw = new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "plain words" }] } }), { status: 200 });
		expect(await failureOf(() => raw)).toMatchObject({ code: "bad-response" });
	});

	test("an {ok:false} answer passes its code through; retryable only for the codes worth retrying", async () => {
		expect(await failureOf(() => rpc({ ok: false, error: { code: "stale-plan", message: "the plan changed" } }))).toEqual({
			code: "stale-plan",
			message: "the plan changed",
			retryable: false,
		});
		expect(await failureOf(() => rpc({ ok: false, error: { code: "ledger-down", message: "ledger unavailable" } }))).toMatchObject({ code: "ledger-down", retryable: true });
		expect(await failureOf(() => rpc({ ok: false, error: { code: "not a code!", message: "x" } }))).toMatchObject({ code: "server-rejected" });
		expect(await failureOf(() => rpc({ ok: false }))).toMatchObject({ code: "server-rejected" });
		expect(await failureOf(() => rpc({ nothing: true }))).toMatchObject({ code: "bad-response" });
	});

	test("the server's not-found for an unknown or foreign checkpoint reaches the caller as that code", async () => {
		expect(await failureOf(() => rpc({ ok: false, error: { code: "not-found", message: "no checkpoint was recorded" } }))).toEqual({
			code: "not-found",
			message: "no checkpoint was recorded",
			retryable: false,
		});
	});

	test("ledger-down counts as unreachable so a rollback can fall back to local refs", async () => {
		const error = await failureOf(() => rpc({ ok: false, error: { code: "ledger-down", message: "ledger unavailable" } }));
		expect(isUnreachable(error)).toBe(true);
	});
});

describe("the token never appears in a failure", () => {
	test("not from a fetch error, a server echo, a URL with credentials, or a JSON-escaped copy", async () => {
		const leaks = [
			() => Promise.reject(new Error(`connect to http://user:${TOKEN}@127.0.0.1:7410/mcp?token=${TOKEN} failed with Bearer ${TOKEN}`)),
			() => rpc({ ok: false, error: { code: "invalid-request", message: `bad bearer ${TOKEN} sent` } }),
			() => rpc(`the key ${TOKEN} is wrong`, { isError: true }),
			() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `denied ${TOKEN}` } }), { status: 200 }),
		];
		for (const respond of leaks) {
			const { api } = client(respond);
			const result = await api.recordCheckpoint(RECORD);
			expect(result.ok).toBe(false);
			const text = JSON.stringify(result);
			expect(text).not.toContain(TOKEN);
			expect(text).not.toContain("0123456789abcdef");
		}
	});

	test("diagnostics are capped", async () => {
		const { api } = client(() => rpc({ ok: false, error: { code: "invalid-request", message: "x".repeat(5000) } }));
		const result = await api.recordCheckpoint(RECORD);
		expect(!result.ok && result.error.message.length).toBeLessThanOrEqual(300);
	});
});

describe("offlineClient", () => {
	test("every call fails retryably with code offline and no fetch", async () => {
		const offline = offlineClient();
		for (const result of [
			await offline.recordCheckpoint(RECORD),
			await offline.planRollback({ session_id: "s", target_ckpt_id: CKPT }),
			await offline.commitRollback({ session_id: "s", rollback_id: PLAN.rollback_id, target_ckpt_id: CKPT, outcome: "refused", reason: "drift-detected" }),
		]) {
			expect(result).toMatchObject({ ok: false, error: { code: "offline", retryable: true } });
		}
	});
});
