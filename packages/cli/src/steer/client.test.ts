/**
 * The Live Steering REST client: the guards that decide whether an answer is trusted, and how transport problems are
 * typed. Every answer here comes from an injected fetch; nothing opens a socket.
 */
import { describe, expect, test } from "bun:test";
import { defined } from "../../../mcp-server/src/test-support.ts";
import {
	MAX_RESPONSE_CHARS,
	WAIT_MARGIN_MS,
	type SteerDirective,
	type SteerFetch,
	createSteerClient,
	parseContextDigest,
	parseDirective,
	parseWriteReply,
} from "./client.ts";

const goodDirective: SteerDirective = {
	id: "d-1",
	session_id: "sess-1",
	action: "pause",
	body: "stop",
	priority: "low",
	status: "queued",
	author: "operator-1",
	created_at: "2026-01-01T00:00:00.000Z",
	acknowledged_at: null,
	outcome: null,
	checkpoint_hint: null,
};

describe("parseDirective", () => {
	test("accepts the wire shape and defaults an absent acknowledged_at, outcome and hint to null", () => {
		const bare = Object.fromEntries(Object.entries(goodDirective).filter(([key]) => !["acknowledged_at", "outcome", "checkpoint_hint"].includes(key)));
		expect(parseDirective(bare)).toEqual(goodDirective);
	});

	test("accepts a hint and an epoch-millisecond time", () => {
		const parsed = parseDirective({ ...goodDirective, created_at: 1_767_225_600_000, status: "acknowledged", outcome: "applied", checkpoint_hint: { trigger: "steering", directive_id: "d-1" } });
		expect(parsed).toMatchObject({ created_at: 1_767_225_600_000, status: "acknowledged", checkpoint_hint: { trigger: "steering", directive_id: "d-1" } });
	});

	const wrong: Array<[string, Record<string, unknown>, string]> = [
		["an empty id", { id: "" }, "directive.id"],
		["a numeric session", { session_id: 4 }, "directive.session_id"],
		["an unknown action", { action: "delete" }, "directive.action"],
		["a missing body", { body: undefined }, "directive.body"],
		["an unknown priority", { priority: "urgent" }, "directive.priority"],
		["an unknown status", { status: "done" }, "directive.status"],
		["a mistyped author", { author: null }, "directive.author"],
		["an empty created_at", { created_at: "" }, "directive.created_at"],
		["a mistyped acknowledged_at", { acknowledged_at: true }, "directive.acknowledged_at"],
		["a mistyped outcome", { outcome: 3 }, "directive.outcome"],
		["a hint without a directive id", { checkpoint_hint: { trigger: "steering" } }, "directive.checkpoint_hint"],
	];
	for (const [name, change, field] of wrong) {
		test(`${name} names ${field}`, () => {
			expect(parseDirective({ ...goodDirective, ...change })).toBe(field);
		});
	}

	test("a value that is not an object is refused", () => {
		for (const value of [null, "x", 7, [goodDirective]]) expect(parseDirective(value)).toBe("directive is not an object");
	});
});

describe("parseContextDigest", () => {
	const good = {
		generated_at: "2026-01-01T00:00:00.000Z",
		repo_id: "acme/widgets",
		for_session: "sess-1",
		sessions: [{ source: "presence", age_s: 3, session_id: "o", worktree: "/w" }],
		claims: [],
		events: [],
		handoffs: [],
		planning: [],
		truncated: { events: true, handoffs: false },
		notes: ["n"],
	};

	test("keeps source and age apart from the rest of each item, and lists the lists that were cut", () => {
		const parsed = parseContextDigest(good);
		if (typeof parsed === "string") throw new Error(parsed);
		expect(parsed.lists.sessions).toEqual([{ source: "presence", age_s: 3, fields: { session_id: "o", worktree: "/w" } }]);
		expect(parsed.truncated).toEqual(["events"]);
		expect(parsed.for_session).toBe("sess-1");
	});

	const wrong: Array<[string, Record<string, unknown>, string]> = [
		["a missing list", { claims: undefined }, "claims"],
		["an item with no source", { events: [{ age_s: 1 }] }, "events[].source"],
		["an item with a negative age", { events: [{ source: "x", age_s: -1 }] }, "events[].age_s"],
		["an item that is a string", { handoffs: ["x"] }, "handoffs[] is not an object"],
		["a truncated that is a list", { truncated: [] }, "truncated"],
		["notes that are not strings", { notes: [1] }, "notes"],
		["a repo that is not a string", { repo_id: 1 }, "repo_id"],
		["a session that is a number", { for_session: 1 }, "for_session"],
	];
	for (const [name, change, field] of wrong) {
		test(`${name} names ${field}`, () => {
			expect(parseContextDigest({ ...good, ...change })).toBe(field);
		});
	}
});

describe("parseWriteReply", () => {
	test("keeps the whole reply and pulls out what the CLI reads", () => {
		const parsed = parseWriteReply({ status: "refused", error: { code: "rate-limited", retryAfterMs: 9 }, extra: 1 });
		expect(parsed).toMatchObject({ status: "refused", error_code: "rate-limited" });
		if (typeof parsed !== "string") expect(parsed.raw).toEqual({ status: "refused", error: { code: "rate-limited", retryAfterMs: 9 }, extra: 1 });
	});

	test("a reply with no status, or an empty one, is refused by name", () => {
		expect(parseWriteReply({})).toBe("status");
		expect(parseWriteReply({ status: "" })).toBe("status");
		expect(parseWriteReply([])).toBe("reply is not an object");
	});
});

describe("transport", () => {
	interface Seen {
		url: string;
		method: string;
		headers: Record<string, string>;
		body: string | undefined;
		signal: AbortSignal;
	}

	function clientFor(answer: Response | Error, options: { token?: string; url?: string; timeoutMs?: number; signalFor?: (ms: number) => AbortSignal } = {}) {
		const seen: Seen[] = [];
		const fetch: SteerFetch = async (url, init) => {
			seen.push({ url, method: init.method, headers: init.headers, body: init.body, signal: init.signal });
			if (answer instanceof Error) throw answer;
			return answer.clone() as Response;
		};
		const client = createSteerClient({ url: options.url ?? "http://127.0.0.1:7410///", ...(options.token === undefined ? {} : { token: options.token }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.signalFor === undefined ? {} : { signalFor: options.signalFor }), fetch });
		return { client, seen };
	}

	test("trailing slashes of the base are trimmed, parameters are encoded, absent ones are left out, and a GET has no body", async () => {
		const { client, seen } = clientFor(Response.json({ sessions: [], truncated: false }), { token: "tok" });
		await client.sessions({ repoId: "acme/widgets & co", limit: 3 });
		const request = defined(seen[0]);
		expect(request.url).toBe("http://127.0.0.1:7410/steering/sessions?repo_id=acme%2Fwidgets+%26+co&limit=3");
		expect(request.method).toBe("GET");
		expect(request.body).toBeUndefined();
		expect(request.headers).toEqual({ accept: "application/json", authorization: "Bearer tok" });
		await client.sessions({});
		expect(defined(seen[1]).url).toBe("http://127.0.0.1:7410/steering/sessions");
	});

	test("without a token no authorization header is sent", async () => {
		const { client, seen } = clientFor(Response.json({ sessions: [], truncated: false }));
		await client.sessions({});
		expect(Object.keys(defined(seen[0]).headers)).toEqual(["accept"]);
	});

	test("a POST carries a JSON body and its content type", async () => {
		const { client, seen } = clientFor(Response.json({ status: "queued", directive_id: "d" }));
		await client.queue({ sessionId: "s", action: "pause", body: "x" });
		const request = defined(seen[0]);
		expect(request.method).toBe("POST");
		expect(request.headers["content-type"]).toBe("application/json");
		expect(JSON.parse(defined(request.body))).toEqual({ session_id: "s", action: "pause", body: "x" });
	});

	test("the long poll's own timeout is the wait plus a margin, so the client never gives up first", async () => {
		const budgets: number[] = [];
		const { client } = clientFor(new Response(null, { status: 204 }), {
			signalFor: (ms) => {
				budgets.push(ms);
				return AbortSignal.timeout(ms);
			},
		});
		const result = await client.wait({ sessionId: "s", timeoutMs: 20_000 });
		expect(result).toEqual({ ok: true, value: null });
		expect(budgets).toEqual([20_000 + WAIT_MARGIN_MS]);
	});

	test("an answer larger than the cap is a bad response, not a parse", async () => {
		const { client } = clientFor(new Response(JSON.stringify({ sessions: "x".repeat(MAX_RESPONSE_CHARS) }), { status: 200 }));
		const result = await client.sessions({});
		expect(result).toMatchObject({ ok: false, code: "bad-response" });
	});

	test("an empty 200 body is a bad response, never a crash", async () => {
		const { client } = clientFor(new Response("", { status: 200 }));
		expect(await client.directives({ sessionId: "s" })).toMatchObject({ ok: false, code: "bad-response" });
	});

	test("a body that cannot be read is a bad response", async () => {
		const broken = new Response("x", { status: 200 });
		Object.defineProperty(broken, "text", { value: () => Promise.reject(new Error("stream reset")) });
		const client = createSteerClient({ url: "http://h", fetch: async () => broken });
		expect(await client.sessions({})).toMatchObject({ ok: false, code: "bad-response" });
	});

	test("an error value that is not an Error is still unreachable", async () => {
		const client = createSteerClient({
			url: "http://h",
			fetch: () => Promise.reject("refused"),
		});
		expect(await client.sessions({})).toMatchObject({ ok: false, code: "unreachable" });
	});

	test("a 204 on a read is a refusal: only the wait route has an empty answer", async () => {
		const { client } = clientFor(new Response(null, { status: 204 }));
		expect(await client.sessions({})).toMatchObject({ ok: false, code: "refused", status: 204 });
	});

	test("failure messages are cut to a bounded length", async () => {
		const { client } = clientFor(Response.json({ error: "e".repeat(5_000) }, { status: 500 }));
		const result = await client.sessions({});
		if (result.ok) throw new Error("expected a failure");
		expect(result.message.length).toBeLessThanOrEqual(300);
	});
});
