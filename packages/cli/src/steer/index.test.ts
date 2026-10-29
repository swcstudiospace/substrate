/**
 * `substrate steer`: the grammar and exit codes, every command against a fake server (fetch injected), and the
 * `listen` loop with a fake clock. Nothing opens a socket and nothing sleeps.
 */
import { describe, expect, test } from "bun:test";
import { defined } from "../../../mcp-server/src/test-support.ts";
import {
	EXIT_DONE,
	EXIT_FAILED,
	EXIT_REFUSED,
	EXIT_USAGE,
	LISTEN_BACKOFF_MAX_MS,
	LISTEN_POLL_MS,
	STEER_USAGE,
	type SteerDeps,
	parseSteerArgs,
	runSteer,
} from "./index.ts";

const T0 = Date.parse("2026-01-01T01:00:00.000Z");

interface Call {
	method: string;
	path: string;
	params: Record<string, string>;
	body: Record<string, unknown> | undefined;
	authorization: string | undefined;
}

type Reply = Response | Error;

interface Rig {
	out: string[];
	err: string[];
	calls: Call[];
	sleeps: number[];
	clock: { ms: number };
	interrupt: AbortController;
	/** The scripted answer to a request; set per test. Throwing an `Error` value simulates a transport failure. */
	reply: (call: Call) => Reply | Promise<Reply>;
	deps: SteerDeps;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function rig(over: Partial<SteerDeps> = {}): Rig {
	const out: string[] = [];
	const err: string[] = [];
	const calls: Call[] = [];
	const sleeps: number[] = [];
	const clock = { ms: T0 };
	const interrupt = new AbortController();
	const r: Rig = {
		out,
		err,
		calls,
		sleeps,
		clock,
		interrupt,
		reply: () => json({}),
		deps: {
			url: "http://127.0.0.1:7410",
			tokenFor: (surface) => (surface === "omp" ? "token-for-omp" : "token-for-default"),
			timeoutMs: 1500,
			now: () => new Date(clock.ms),
			repo: () => "acme/widgets",
			out: (chunk) => out.push(chunk),
			err: (chunk) => err.push(chunk),
			fetch: async (input, init) => {
				const url = new URL(input);
				calls.push({
					method: init.method,
					path: url.pathname,
					params: Object.fromEntries(url.searchParams.entries()),
					body: init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>),
					authorization: init.headers.authorization,
				});
				const answer = await r.reply(defined(calls[calls.length - 1], "the call just recorded"));
				if (answer instanceof Error) throw answer;
				return answer;
			},
			sleep: async (ms) => {
				sleeps.push(ms);
				clock.ms += ms;
			},
			interrupt: interrupt.signal,
			...over,
		},
	};
	return r;
}

const steer = (r: Rig, ...argv: string[]): Promise<number> => runSteer(argv, r.deps);
const text = (lines: string[]): string => lines.join("");

const directive = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	session_id: "sess-1",
	action: "redirect",
	body: "switch to the parser",
	priority: "high",
	status: "queued",
	author: "operator-1",
	created_at: "2026-01-01T00:55:00.000Z",
	acknowledged_at: null,
	outcome: null,
	checkpoint_hint: null,
	...over,
});

const sessionRow = (id: string, over: Record<string, unknown> = {}) => ({
	session_id: id,
	surface: "omp",
	repo_id: "acme/widgets",
	state: "ACTIVE",
	updated_at: "2026-01-01T00:55:00.000Z",
	planning_hash: "0123456789abcdef",
	steering: null,
	pending_directives: 0,
	...over,
});

const digest = () => ({
	generated_at: "2026-01-01T01:00:00.000Z",
	repo_id: "acme/widgets",
	for_session: null,
	sessions: [{ source: "presence", age_s: 30, session_id: "other", branch: "main" }],
	claims: [],
	events: [{ source: "ledger", age_s: 4, kind: "commit", summary: "fix parser" }],
	handoffs: [],
	planning: [],
	truncated: { events: true },
	notes: ["bounded"],
});

describe("the grammar", () => {
	const refused: Array<[string, string[]]> = [
		["an unknown subcommand", ["frobnicate"]],
		["an unknown flag", ["sessions", "--bogus"]],
		["a flag of another subcommand", ["sessions", "--session", "s"]],
		["a value flag with no value", ["list", "--session"]],
		["a value flag followed by a flag", ["list", "--session", "--json"]],
		["a flag given twice", ["sessions", "--repo", "a/b", "--repo", "c/d"]],
		["a positional argument where none is taken", ["sessions", "extra"]],
		["queue without a session", ["queue", "--action", "pause", "--body", "x"]],
		["queue without an action", ["queue", "--session", "s", "--body", "x"]],
		["queue with an unknown action", ["queue", "--session", "s", "--action", "explode", "--body", "x"]],
		["queue without a body", ["queue", "--session", "s", "--action", "pause"]],
		["queue with a blank body", ["queue", "--session", "s", "--action", "pause", "--body", "   "]],
		["queue with a body over the limit", ["queue", "--session", "s", "--action", "pause", "--body", "x".repeat(4_097)]],
		["queue with an unknown priority", ["queue", "--session", "s", "--action", "pause", "--body", "x", "--priority", "urgent"]],
		["a session id with a space", ["list", "--session", "bad id"]],
		["a session id over 128 characters", ["list", "--session", "s".repeat(129)]],
		["ack with no directive", ["ack", "--applied"]],
		["ack with two directives", ["ack", "d1", "d2", "--applied"]],
		["ack with neither outcome", ["ack", "d1"]],
		["ack with both outcomes", ["ack", "d1", "--applied", "--declined"]],
		["ack --confirm on a declined directive", ["ack", "d1", "--declined", "--confirm"]],
		["list without a session", ["list"]],
		["list with an unknown status", ["list", "--session", "s", "--status", "pending"]],
		["listen without a session", ["listen"]],
		["listen --max-wait-ms 0", ["listen", "--session", "s", "--max-wait-ms", "0"]],
		["listen --max-wait-ms not a number", ["listen", "--session", "s", "--max-wait-ms", "soon"]],
		["listen --max-wait-ms past a day", ["listen", "--session", "s", "--max-wait-ms", "86400001"]],
		["a --limit of zero", ["sessions", "--limit", "0"]],
		["a --limit over 1000", ["sessions", "--limit", "1001"]],
		["a --format that is not text or json", ["context", "--format", "yaml"]],
		["a --surface that is not a surface name", ["sessions", "--surface", "Not A Surface"]],
	];
	for (const [name, argv] of refused) {
		test(`${name}: usage on stderr, exit 2, nothing sent, nothing on stdout`, async () => {
			const r = rig();
			expect(await steer(r, ...argv)).toBe(EXIT_USAGE);
			expect(r.calls).toEqual([]);
			expect(r.out).toEqual([]);
			expect(text(r.err)).toContain("usage: substrate steer");
		});
	}

	test("no arguments is a usage error; help is not", async () => {
		const r = rig();
		expect(await steer(r)).toBe(EXIT_USAGE);
		expect(text(r.err)).toBe(STEER_USAGE);
		const h = rig();
		expect(await steer(h, "help")).toBe(EXIT_DONE);
		expect(text(h.out)).toBe(STEER_USAGE);
	});

	test("every subcommand and the exit codes are in the usage text", () => {
		for (const word of ["sessions", "status", "queue", "ack", "list", "listen", "context", "--once", "--max-wait-ms", "exit: 0 done, 1 failed, 2 usage, 3 refused"]) {
			expect(STEER_USAGE).toContain(word);
		}
	});

	test("flag order is free", () => {
		const a = parseSteerArgs(["ack", "d1", "--applied", "--confirm"]);
		const b = parseSteerArgs(["ack", "--confirm", "--applied", "d1"]);
		for (const parsed of [a, b]) {
			expect(typeof parsed).toBe("object");
			if (typeof parsed === "string") continue;
			expect(parsed.positional).toEqual(["d1"]);
			expect([...parsed.flags.keys()].sort()).toEqual(["applied", "confirm"]);
		}
	});
});

describe("sessions", () => {
	test("asks for the working directory's repository with the bearer, and prints one line per session with its age", async () => {
		const r = rig();
		r.reply = () => json({ sessions: [sessionRow("sess-1", { pending_directives: 2, steering: { state: "PAUSED" } }), sessionRow("sess-2", { updated_at: T0 - 3 * 3_600_000 })], truncated: false });
		expect(await steer(r, "sessions")).toBe(EXIT_DONE);
		const call = defined(r.calls[0], "the request");
		expect(call).toMatchObject({ method: "GET", path: "/steering/sessions", params: { repo_id: "acme/widgets" }, authorization: "Bearer token-for-default" });
		const lines = text(r.out).trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("sess-1");
		expect(lines[0]).toContain("pending=2");
		expect(lines[0]).toContain("steering=PAUSED");
		expect(lines[0]).toContain("updated 5m ago");
		expect(lines[0]).toContain("planning=01234567");
		expect(lines[1]).toContain("updated 3h ago");
	});

	test("--repo and --limit override and pass through; --surface picks the token", async () => {
		const r = rig();
		r.reply = () => json({ sessions: [], truncated: true });
		expect(await steer(r, "sessions", "--repo", "other/repo", "--limit", "5", "--surface", "omp")).toBe(EXIT_DONE);
		expect(defined(r.calls[0]).params).toEqual({ repo_id: "other/repo", limit: "5" });
		expect(defined(r.calls[0]).authorization).toBe("Bearer token-for-omp");
		expect(text(r.out)).toContain("no sessions");
	});

	test("outside a clone no repo filter is sent", async () => {
		const r = rig({ repo: () => undefined });
		r.reply = () => json({ sessions: [], truncated: false });
		await steer(r, "sessions");
		expect(defined(r.calls[0]).params).toEqual({});
	});

	test("--json prints the guarded reply as one line", async () => {
		const r = rig();
		r.reply = () => json({ sessions: [sessionRow("sess-1")], truncated: true });
		expect(await steer(r, "sessions", "--json")).toBe(EXIT_DONE);
		const printed = JSON.parse(text(r.out)) as { sessions: Array<{ session_id: string }>; truncated: boolean };
		expect(printed.sessions.map((s) => s.session_id)).toEqual(["sess-1"]);
		expect(printed.truncated).toBe(true);
	});

	test("a truncated list says so", async () => {
		const r = rig();
		r.reply = () => json({ sessions: [sessionRow("sess-1")], truncated: true });
		await steer(r, "sessions");
		expect(text(r.out)).toContain("cut at the server's limit");
	});

	test("a session row with a mistyped field is a reported failure naming the field, exit 1", async () => {
		const r = rig();
		r.reply = () => json({ sessions: [sessionRow("sess-1", { pending_directives: "two" })], truncated: false });
		expect(await steer(r, "sessions")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("session.pending_directives");
		expect(r.out).toEqual([]);
	});
});

describe("failures are typed and mapped to exit codes", () => {
	const cases: Array<[string, Reply, number, string]> = [
		["a 404 says the server predates the feature or the flag is off", json({ error: "not found" }, 404), EXIT_FAILED, "predates Live Steering"],
		["a 401 is a refusal about the token", json({ error: "unauthorized" }, 401), EXIT_REFUSED, "SUBSTRATE_TOKEN"],
		["a 500 is a failure and carries the server's message", json({ error: "index down" }, 500), EXIT_FAILED, "index down"],
		["a 500 with an HTML body is still a failure", new Response("<html>bad gateway</html>", { status: 502 }), EXIT_FAILED, "HTTP 502"],
		["a 200 that is not JSON is a bad response", new Response("<html>", { status: 200 }), EXIT_FAILED, "not JSON"],
		["a 200 with the wrong shape is a bad response", json({ nope: true }), EXIT_FAILED, "no valid sessions"],
		["a 400 is a refusal with the server's words", json({ error: "bad repo_id" }, 400), EXIT_REFUSED, "bad repo_id"],
		["a connection that fails is unreachable", new TypeError("fetch failed"), EXIT_FAILED, "did not answer"],
	];
	for (const [name, reply, exit, message] of cases) {
		test(name, async () => {
			const r = rig();
			r.reply = () => reply;
			expect(await steer(r, "sessions")).toBe(exit);
			expect(text(r.err)).toContain(message);
			expect(r.out).toEqual([]);
		});
	}

	test("a request that times out names the budget", async () => {
		const r = rig();
		r.reply = () => Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
		expect(await steer(r, "sessions")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("did not answer within 1500 ms");
	});

	test("the bearer never reaches the output", async () => {
		const r = rig();
		r.reply = () => new TypeError("fetch failed");
		await steer(r, "sessions");
		expect(text(r.err) + text(r.out)).not.toContain("token-for-default");
	});
});

describe("status", () => {
	test("shows the sessions, the pending directives of those that have some, and a digest summary", async () => {
		const r = rig();
		r.reply = (call) => {
			if (call.path === "/steering/sessions") return json({ sessions: [sessionRow("sess-1", { pending_directives: 1 }), sessionRow("sess-2")], truncated: false });
			if (call.path === "/steering/directives") return json({ directives: [directive("d-1")] });
			return json(digest());
		};
		expect(await steer(r, "status")).toBe(EXIT_DONE);
		const printed = text(r.out);
		expect(printed).toContain("sessions (2):");
		expect(printed).toContain("pending directives:");
		expect(printed).toContain("d-1");
		expect(printed).toContain("switch to the parser");
		expect(printed).toContain("context digest");
		expect(printed).toContain("sessions 1, claims 0, events 1");
		expect(printed).toContain("cut: events");
		// Directives are asked for only the one session that has some pending.
		const directiveCalls = r.calls.filter((call) => call.path === "/steering/directives");
		expect(directiveCalls.map((call) => call.params)).toEqual([{ session_id: "sess-1", status: "queued" }]);
	});

	test("--session narrows to one session and always asks for its directives", async () => {
		const r = rig();
		r.reply = (call) => {
			if (call.path === "/steering/sessions") return json({ sessions: [sessionRow("sess-1"), sessionRow("sess-2")], truncated: false });
			if (call.path === "/steering/directives") return json({ directives: [] });
			return json(digest());
		};
		await steer(r, "status", "--session", "sess-2");
		const printed = text(r.out);
		expect(printed).toContain("sessions (1):");
		expect(printed).not.toContain("sess-1");
		expect(r.calls.find((call) => call.path === "/steering/directives")?.params.session_id).toBe("sess-2");
		expect(r.calls.find((call) => call.path === "/session/context")?.params.session_id).toBe("sess-2");
	});

	test("a server without the context route still gives a status, and says why the digest is missing", async () => {
		const r = rig();
		r.reply = (call) => (call.path === "/steering/sessions" ? json({ sessions: [sessionRow("sess-1")], truncated: false }) : json({}, 404));
		expect(await steer(r, "status")).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("context digest unavailable");
		expect(text(r.out)).toContain("predates Live Steering");
	});

	test("a failed session list fails the command", async () => {
		const r = rig();
		r.reply = () => json({}, 404);
		expect(await steer(r, "status")).toBe(EXIT_FAILED);
	});

	test("--json is one object with sessions, directives and the digest counts", async () => {
		const r = rig();
		r.reply = (call) => {
			if (call.path === "/steering/sessions") return json({ sessions: [sessionRow("sess-1", { pending_directives: 1 })], truncated: false });
			if (call.path === "/steering/directives") return json({ directives: [directive("d-1")] });
			return json(digest());
		};
		await steer(r, "status", "--json");
		const printed = JSON.parse(text(r.out)) as { sessions: unknown[]; directives: Array<{ session_id: string; directives: unknown[] }>; context: { counts: Record<string, number>; truncated: string[] } };
		expect(printed.sessions).toHaveLength(1);
		expect(printed.directives[0]?.session_id).toBe("sess-1");
		expect(printed.context.counts.events).toBe(1);
		expect(printed.context.truncated).toEqual(["events"]);
	});
});

describe("queue", () => {
	test("posts the directive with snake_case keys, and prints the id the server chose", async () => {
		const r = rig();
		r.reply = () => json({ status: "queued", directive_id: "d-42", target_session_id: "sess-1", queued_at_ms: 1 });
		expect(await steer(r, "queue", "--session", "sess-1", "--action", "redirect", "--body", "look at the parser", "--priority", "high")).toBe(EXIT_DONE);
		expect(r.calls).toEqual([{ method: "POST", path: "/steering/queue", params: {}, body: { session_id: "sess-1", action: "redirect", body: "look at the parser", priority: "high" }, authorization: "Bearer token-for-default" }]);
		expect(text(r.out)).toBe("queued directive d-42\n");
	});

	test("without --priority the key is left out, so the server's default applies", async () => {
		const r = rig();
		r.reply = () => json({ status: "queued", directive_id: "d-1" });
		await steer(r, "queue", "--session", "sess-1", "--action", "annotate", "--body", "fyi");
		expect(Object.keys(defined(defined(r.calls[0]).body))).toEqual(["session_id", "action", "body"]);
	});

	test("--json prints the server's reply untouched", async () => {
		const r = rig();
		const reply = { status: "queued", directive_id: "d-1", extra: [1, 2] };
		r.reply = () => json(reply);
		expect(await steer(r, "queue", "--session", "s", "--action", "pause", "--body", "x", "--json")).toBe(EXIT_DONE);
		expect(JSON.parse(text(r.out))).toEqual(reply);
	});

	const refusals: Array<[string, Response, string]> = [
		["not an operator", json({ status: "forbidden", reason: "operator-required" }, 403), "forbidden: operator-required"],
		["a principal that is not allowed", json({ status: "refused", error: { code: "principal-not-allowed" } }), "refused (principal-not-allowed)"],
		["the rate limit", json({ status: "refused", error: { code: "rate-limited", retryAfterMs: 5000 } }, 429), "refused (rate-limited)"],
		["steering switched off", json({ status: "not-configured" }), "not-configured"],
	];
	for (const [name, response, message] of refusals) {
		test(`${name} is the server's refusal: exit 3, on stderr, nothing on stdout`, async () => {
			const r = rig();
			r.reply = () => response.clone() as Response;
			expect(await steer(r, "queue", "--session", "s", "--action", "pause", "--body", "x")).toBe(EXIT_REFUSED);
			expect(text(r.err)).toContain(message);
			expect(r.out).toEqual([]);
		});
	}

	test("a reply with no status is a bad response, exit 1", async () => {
		const r = rig();
		r.reply = () => json({ ok: true });
		expect(await steer(r, "queue", "--session", "s", "--action", "pause", "--body", "x")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("status");
	});

	test("a 404 says the route is missing, exit 1", async () => {
		const r = rig();
		r.reply = () => json({}, 404);
		expect(await steer(r, "queue", "--session", "s", "--action", "pause", "--body", "x")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("predates Live Steering");
	});
});

describe("ack", () => {
	test("posts the directive id and outcome; --confirm is sent only when given", async () => {
		const r = rig();
		r.reply = () => json({ status: "acknowledged", directive_id: "d-1", outcome: "applied", confirmed: true });
		expect(await steer(r, "ack", "d-1", "--applied", "--confirm")).toBe(EXIT_DONE);
		expect(defined(r.calls[0]).body).toEqual({ directive_id: "d-1", outcome: "applied", confirm: true });
		expect(text(r.out)).toBe("acknowledged directive d-1\n");
		const d = rig();
		d.reply = () => json({ status: "acknowledged", directive_id: "d-2" });
		await steer(d, "ack", "d-2", "--declined");
		expect(defined(d.calls[0]).body).toEqual({ directive_id: "d-2", outcome: "declined" });
	});

	test("an applied pause reports the session state and the checkpoint hint", async () => {
		const r = rig();
		r.reply = () =>
			json({ status: "acknowledged", directive_id: "d-1", session_state: { status: "applied", state: "PAUSED" }, checkpoint_hint: { trigger: "steering", directive_id: "d-1" } });
		expect(await steer(r, "ack", "d-1", "--applied")).toBe(EXIT_DONE);
		const printed = text(r.out);
		expect(printed).toContain("session state: applied -> PAUSED");
		expect(printed).toContain("checkpoint hint");
		expect(printed).toContain("steering checkpoint for d-1");
	});

	test("a directive that conflicts with the plan is refused until --confirm: exit 3", async () => {
		const r = rig();
		r.reply = () => json({ status: "refused", error: { code: "confirmation-required" } });
		expect(await steer(r, "ack", "d-1", "--applied")).toBe(EXIT_REFUSED);
		expect(text(r.err)).toContain("confirmation-required");
	});

	test("a checkpoint_hint of the wrong type is a bad response", async () => {
		const r = rig();
		r.reply = () => json({ status: "acknowledged", directive_id: "d-1", checkpoint_hint: { trigger: 7 } });
		expect(await steer(r, "ack", "d-1", "--applied")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("checkpoint_hint");
	});
});

describe("list", () => {
	test("defaults to every status and prints each directive with its body, author and age", async () => {
		const r = rig();
		r.reply = () => json({ directives: [directive("d-1"), directive("d-2", { status: "acknowledged", outcome: "applied", acknowledged_at: "2026-01-01T00:58:00.000Z", checkpoint_hint: { trigger: "steering", directive_id: "d-2" } })] });
		expect(await steer(r, "list", "--session", "sess-1")).toBe(EXIT_DONE);
		expect(defined(r.calls[0]).params).toEqual({ session_id: "sess-1", status: "all" });
		const printed = text(r.out);
		expect(printed).toContain("d-1  queued  redirect/high  by operator-1  5m ago");
		expect(printed).toContain("acknowledged (applied)");
		expect(printed).toContain("checkpoint_hint=steering");
		expect(printed).toContain("switch to the parser");
	});

	test("--status is passed through; an empty list says so", async () => {
		const r = rig();
		r.reply = () => json({ directives: [] });
		await steer(r, "list", "--session", "sess-1", "--status", "queued");
		expect(defined(r.calls[0]).params.status).toBe("queued");
		expect(text(r.out)).toBe("no directives\n");
	});

	test("--json prints the guarded list", async () => {
		const r = rig();
		r.reply = () => json({ directives: [directive("d-1")] });
		await steer(r, "list", "--session", "sess-1", "--json");
		expect((JSON.parse(text(r.out)) as Array<{ id: string }>).map((d) => d.id)).toEqual(["d-1"]);
	});

	test("a directive with an unknown action is a bad response naming the field", async () => {
		const r = rig();
		r.reply = () => json({ directives: [directive("d-1", { action: "explode" })] });
		expect(await steer(r, "list", "--session", "sess-1")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("directive.action");
	});

	test("control characters in a body never reach the terminal", async () => {
		const r = rig();
		r.reply = () => json({ directives: [directive("d-1", { body: "\u001b[2Jwipe\u0007" })] });
		await steer(r, "list", "--session", "sess-1");
		expect(text(r.out)).not.toContain("\u001b");
		expect(text(r.out)).not.toContain("\u0007");
		expect(text(r.out)).toContain("[2Jwipe");
	});
});

describe("context", () => {
	test("prints the digest as text with the source and age of every item", async () => {
		const r = rig();
		r.reply = () => json(digest());
		expect(await steer(r, "context")).toBe(EXIT_DONE);
		expect(defined(r.calls[0])).toMatchObject({ path: "/session/context", params: { repo_id: "acme/widgets" } });
		const printed = text(r.out);
		expect(printed).toContain("[presence, 30s old]");
		expect(printed).toContain("[ledger, 4s old]");
		expect(printed).toContain("summary=fix parser");
		expect(printed).toContain("cut by the server: events");
	});

	test("--session and --repo pass through; --format json prints the guarded digest", async () => {
		const r = rig();
		r.reply = () => json(digest());
		expect(await steer(r, "context", "--repo", "x/y", "--session", "sess-1", "--format", "json")).toBe(EXIT_DONE);
		expect(defined(r.calls[0]).params).toEqual({ repo_id: "x/y", session_id: "sess-1" });
		const printed = JSON.parse(text(r.out)) as { repo_id: string; truncated: string[] };
		expect(printed.repo_id).toBe("acme/widgets");
		expect(printed.truncated).toEqual(["events"]);
	});

	test("an item with no source is a bad response", async () => {
		const r = rig();
		r.reply = () => json({ ...digest(), events: [{ age_s: 1, kind: "x" }] });
		expect(await steer(r, "context")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("events[].source");
	});

	test("a 404 says the server predates the feature", async () => {
		const r = rig();
		r.reply = () => json({}, 404);
		expect(await steer(r, "context")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("predates Live Steering");
	});
});

describe("listen", () => {
	/** A long poll: a 204 that, like the server, returns after the whole wait. */
	const timedOut = (r: Rig, call: Call): Response => {
		r.clock.ms += Number(call.params.timeout_ms);
		return new Response(null, { status: 204 });
	};
	const delivered = (id: string): Response => json({ directive: directive(id) });

	test("prints a directive that arrives, then with --once stops at the first", async () => {
		const r = rig();
		r.reply = (call) => (r.calls.length === 1 ? timedOut(r, call) : delivered("d-1"));
		expect(await steer(r, "listen", "--session", "sess-1", "--once")).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("d-1  queued  redirect/high");
		expect(text(r.out)).toContain("switch to the parser");
		expect(r.calls).toHaveLength(2);
		expect(defined(r.calls[0])).toMatchObject({ method: "GET", path: "/steering/wait", authorization: "Bearer token-for-default" });
		expect(defined(r.calls[0]).params).toEqual({ session_id: "sess-1", timeout_ms: String(LISTEN_POLL_MS) });
	});

	test("remembers the last id: the next poll asks for what comes after it", async () => {
		const r = rig();
		const script = [delivered("d-1"), delivered("d-2"), delivered("d-3")];
		r.reply = (call) => {
			const next = script.shift();
			return next === undefined ? timedOut(r, call) : next;
		};
		expect(await steer(r, "listen", "--session", "sess-1", "--max-wait-ms", "30000")).toBe(EXIT_DONE);
		expect(r.calls.slice(0, 4).map((call) => call.params.after)).toEqual([undefined, "d-1", "d-2", "d-3"]);
		expect(text(r.out).match(/queued {2}redirect/g)).toHaveLength(3);
	});

	test("--after starts from a given directive", async () => {
		const r = rig();
		r.reply = () => delivered("d-9");
		await steer(r, "listen", "--session", "sess-1", "--once", "--after", "d-8");
		expect(defined(r.calls[0]).params.after).toBe("d-8");
	});

	test("the 204 loop: polls again until the bound, asking for no more than is left, then exits 0", async () => {
		const r = rig();
		r.reply = (call) => timedOut(r, call);
		expect(await steer(r, "listen", "--session", "sess-1", "--max-wait-ms", "60000")).toBe(EXIT_DONE);
		expect(r.calls.map((call) => call.params.timeout_ms)).toEqual(["25000", "25000", "10000"]);
		expect(r.sleeps).toEqual([]);
		expect(text(r.err)).toContain("stopped after 60000 ms with 0 directives");
		expect(r.out).toEqual([]);
	});

	test("with --once and no directive inside the bound it ends quietly on stdout", async () => {
		const r = rig();
		r.reply = (call) => timedOut(r, call);
		expect(await steer(r, "listen", "--session", "sess-1", "--once", "--max-wait-ms", "1000")).toBe(EXIT_DONE);
		expect(r.calls.map((call) => call.params.timeout_ms)).toEqual(["1000"]);
		expect(r.out).toEqual([]);
	});

	test("a transport error reconnects with doubling backoff, capped, and the delay resets after an answer", async () => {
		const r = rig();
		let failures = 0;
		r.reply = (call) => {
			if (failures < 8) {
				failures++;
				return new TypeError("fetch failed");
			}
			return r.calls.length === 9 ? timedOut(r, call) : delivered("d-1");
		};
		expect(await steer(r, "listen", "--session", "sess-1", "--once")).toBe(EXIT_DONE);
		expect(r.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, LISTEN_BACKOFF_MAX_MS, LISTEN_BACKOFF_MAX_MS, LISTEN_BACKOFF_MAX_MS]);
		expect(text(r.err)).toContain("reconnecting in 1s");
		expect(text(r.err)).toContain("reconnecting in 30s");
		expect(text(r.out)).toContain("d-1");
	});

	test("the backoff starts over after a good answer", async () => {
		const r = rig();
		const script: Reply[] = [new TypeError("down"), new TypeError("down"), new Response(null, { status: 204 }), new TypeError("down")];
		r.reply = (call) => {
			const next = script.shift();
			if (next === undefined) return delivered("d-1");
			if (next instanceof Response) return timedOut(r, call);
			return next;
		};
		await steer(r, "listen", "--session", "sess-1", "--once");
		expect(r.sleeps).toEqual([1_000, 2_000, 1_000]);
	});

	test("a 5xx and a timeout are retried like a dropped connection", async () => {
		const r = rig();
		const script: Reply[] = [json({ error: "busy" }, 503), Object.assign(new Error("slow"), { name: "TimeoutError" })];
		r.reply = () => script.shift() ?? delivered("d-1");
		expect(await steer(r, "listen", "--session", "sess-1", "--once")).toBe(EXIT_DONE);
		expect(r.sleeps).toEqual([1_000, 2_000]);
	});

	test("the backoff never sleeps past the bound, and the loop then ends with exit 0", async () => {
		const r = rig();
		r.reply = () => new TypeError("down");
		expect(await steer(r, "listen", "--session", "sess-1", "--max-wait-ms", "2500")).toBe(EXIT_DONE);
		expect(r.sleeps).toEqual([1_000, 1_500]);
		expect(r.calls).toHaveLength(2);
	});

	test("a failure a reconnect cannot fix stops the loop: 401 is a refusal, 404 a failure, a bad body a failure", async () => {
		const expectations: Array<[Response, number]> = [
			[json({}, 401), EXIT_REFUSED],
			[json({}, 404), EXIT_FAILED],
			[json({ directive: { id: "d-1" } }), EXIT_FAILED],
			[json({ nothing: true }), EXIT_FAILED],
		];
		for (const [response, exit] of expectations) {
			const r = rig();
			r.reply = () => response.clone() as Response;
			expect(await steer(r, "listen", "--session", "sess-1")).toBe(exit);
			expect(r.calls).toHaveLength(1);
			expect(r.sleeps).toEqual([]);
		}
	});

	test("an interrupt ends the loop at once with exit 0, even in the middle of a poll", async () => {
		const r = rig();
		r.reply = () => {
			r.interrupt.abort();
			return Object.assign(new Error("aborted"), { name: "AbortError" });
		};
		expect(await steer(r, "listen", "--session", "sess-1")).toBe(EXIT_DONE);
		expect(r.calls).toHaveLength(1);
		expect(r.sleeps).toEqual([]);
		expect(text(r.err)).not.toContain("reconnecting");
	});

	test("an interrupt before the first poll sends nothing", async () => {
		const r = rig();
		r.interrupt.abort();
		expect(await steer(r, "listen", "--session", "sess-1")).toBe(EXIT_DONE);
		expect(r.calls).toEqual([]);
	});

	test("a server that answers 204 at once is paced, so the loop cannot spin", async () => {
		const r = rig();
		r.reply = () => new Response(null, { status: 204 });
		expect(await steer(r, "listen", "--session", "sess-1", "--max-wait-ms", "3000")).toBe(EXIT_DONE);
		expect(r.sleeps.length).toBeGreaterThan(0);
		expect(r.sleeps.every((ms) => ms >= 200)).toBe(true);
		expect(r.calls.length).toBeLessThanOrEqual(4);
	});

	test("--json prints one JSON object per directive and nothing else on stdout", async () => {
		const r = rig();
		r.reply = (call) => (r.calls.length === 1 ? delivered("d-1") : r.calls.length === 2 ? delivered("d-2") : timedOut(r, call));
		expect(await steer(r, "listen", "--session", "sess-1", "--max-wait-ms", "1000", "--json")).toBe(EXIT_DONE);
		const lines = text(r.out).trimEnd().split("\n");
		expect(lines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(["d-1", "d-2"]);
		expect(text(r.err)).not.toContain("stopped after");
	});
});
