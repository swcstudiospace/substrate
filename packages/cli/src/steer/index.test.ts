/**
 * `substrate steer`: the grammar and exit codes, every command against a fake server (fetch injected), and the
 * `listen` loop with a fake clock. Nothing opens a socket and nothing sleeps.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BINDING_RECORDS, bindingRecordPath, loadBindingRecord, saveBindingRecord, serverIdentity, type LiveSessionBindingRecord } from "./binding-record.ts";
import { defined } from "../../../mcp-server/src/test-support.ts";
import {
	EXIT_DONE,
	EXIT_FAILED,
	EXIT_REFUSED,
	EXIT_USAGE,
	LISTEN_BACKOFF_MAX_MS,
	LISTEN_PRINTED_MAX,
	LISTEN_POLL_MS,
	STEER_USAGE,
	type SteerDeps,
	abortableSleep,
	parseSteerArgs,
	runSteer,
} from "./index.ts";

const T0 = Date.parse("2026-01-01T01:00:00.000Z");
const LIVE_ID = `ls_${"1".repeat(64)}`;
const OTHER_LIVE_ID = `ls_${"2".repeat(64)}`;
const PROOF = "a".repeat(64);
const OTHER_PROOF = "b".repeat(64);
const EXPIRES = "2026-01-01T02:00:00.000Z";
const RENEWED_EXPIRES = "2026-01-01T03:00:00.000Z";
const temporaryDirectories = new Set<string>();

afterEach(() => {
	for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
	temporaryDirectories.clear();
});

interface Call {
	method: string;
	path: string;
	params: Record<string, string>;
	body: Record<string, unknown> | undefined;
	authorization: string | undefined;
	sessionBinding?: string;
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
	const bindingDirectory = mkdtempSync(join(tmpdir(), "steer-command-"));
	temporaryDirectories.add(bindingDirectory);
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
			bindingDirectory,
			fetch: async (input, init) => {
				const url = new URL(input);
				calls.push({
					method: init.method,
					path: url.pathname,
					params: Object.fromEntries(url.searchParams.entries()),
					body: init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>),
					authorization: init.headers.authorization,
					...(init.headers["X-Substrate-Session-Binding"] === undefined ? {} : { sessionBinding: init.headers["X-Substrate-Session-Binding"] }),
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

function recordFor(r: Rig, over: Partial<LiveSessionBindingRecord> = {}): LiveSessionBindingRecord {
	return { version: 1, server_identity: serverIdentity(r.deps.url), surface: "claude-code", session_id: LIVE_ID, session_binding: PROOF, expires_at: EXPIRES, ...over };
}

function retain(r: Rig, over: Partial<LiveSessionBindingRecord> = {}, path?: string): string {
	return saveBindingRecord(recordFor(r, over), { directory: defined(r.deps.bindingDirectory), ...(path === undefined ? {} : { path }) });
}

function issued(over: Record<string, unknown> = {}): Record<string, unknown> {
	return { status: "issued", session_id: LIVE_ID, repo_id: "acme/widgets", state: "ACTIVE", updated_at: "2026-01-01T01:00:00.000Z", expires_at: EXPIRES, session_binding: PROOF, ...over };
}

function bindingFileFromOutput(value: unknown): string {
	if (typeof value !== "object" || value === null || !("binding_file" in value) || typeof value.binding_file !== "string") throw new Error("expected public binding file path");
	return value.binding_file;
}

const directive = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	session_id: LIVE_ID,
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
		["list with an unknown status", ["list", "--session", LIVE_ID, "--status", "pending"]],
		["listen without a session", ["listen"]],
		["listen --max-wait-ms 0", ["listen", "--session", LIVE_ID, "--max-wait-ms", "0"]],
		["listen --max-wait-ms not a number", ["listen", "--session", LIVE_ID, "--max-wait-ms", "soon"]],
		["listen --max-wait-ms past a day", ["listen", "--session", LIVE_ID, "--max-wait-ms", "86400001"]],
		["a --limit of zero", ["sessions", "--limit", "0"]],
		["a --limit over the server's 100", ["sessions", "--limit", "101"]],
		["a --limit over 1000", ["sessions", "--limit", "1001"]],
		["a context --limit over the server's 100", ["context", "--limit", "101"]],
		["ack with a directive id the server's routes refuse", ["ack", "bad id", "--applied"]],
		["ack with a directive id that starts with a dot", ["ack", ".d1", "--applied"]],
		["ack with a directive id over 128 characters", ["ack", "d".repeat(129), "--applied"]],
		["listen --after with characters the server refuses", ["listen", "--session", LIVE_ID, "--after", "bad/id"]],
		["listen --after over 128 characters", ["listen", "--session", LIVE_ID, "--after", "d".repeat(129)]],
		["a --format that is not text or json", ["context", "--format", "yaml"]],
		["a --surface that is not a surface name", ["sessions", "--surface", "Not A Surface"]],
		["queue --conflicts with a value", ["queue", "--session", "s", "--action", "pause", "--body", "x", "--conflicts", "yes"]],
		["ack --conflicts", ["ack", "d1", "--applied", "--conflicts"]],
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
		for (const word of ["open", "heartbeat", "close", "forget", "--binding-file", "sessions", "status", "queue", "ack", "list", "listen", "context", "--once", "--max-wait-ms", "exit: 0 done, 1 failed, 2 usage, 3 refused"]) {
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
		r.reply = () => json({ sessions: [sessionRow(LIVE_ID, { pending_directives: 2, steering: { state: "PAUSED" } }), sessionRow(OTHER_LIVE_ID, { updated_at: T0 - 3 * 3_600_000 })], truncated: false });
		expect(await steer(r, "sessions")).toBe(EXIT_DONE);
		const call = defined(r.calls[0], "the request");
		expect(call).toMatchObject({ method: "GET", path: "/steering/sessions", params: { repo_id: "acme/widgets" }, authorization: "Bearer token-for-default" });
		const lines = text(r.out).trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		const handle = defined(lines[0]?.split("  ")[0], "the printed handle");
		expect(handle).toBe(LIVE_ID);
		expect(lines[0]).not.toContain("…");
		const cases: Array<[string, string[]]> = [["queue", ["--action", "annotate", "--body", "note"]], ["list", []], ["close", []]];
		for (const [sub, extra] of cases) {
			const parsed = parseSteerArgs([sub, "--session", handle, ...extra]);
			expect(typeof parsed).toBe("object");
			if (typeof parsed === "string") throw new Error(`${sub} refused the printed handle: ${parsed}`);
			expect(parsed.flags.get("session")).toBe(LIVE_ID);
		}
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
		r.reply = () => json({ sessions: [sessionRow(LIVE_ID)], truncated: true });
		expect(await steer(r, "sessions", "--json")).toBe(EXIT_DONE);
		const printed = JSON.parse(text(r.out)) as { sessions: Array<{ session_id: string }>; truncated: boolean };
		expect(printed.sessions.map((s) => s.session_id)).toEqual([LIVE_ID]);
		expect(printed.truncated).toBe(true);
	});

	test("a truncated list says so", async () => {
		const r = rig();
		r.reply = () => json({ sessions: [sessionRow(LIVE_ID)], truncated: true });
		await steer(r, "sessions");
		expect(text(r.out)).toContain("cut at the server's limit");
	});

	test("a session row with a mistyped field is a reported failure naming the field, exit 1", async () => {
		const r = rig();
		r.reply = () => json({ sessions: [sessionRow(LIVE_ID, { pending_directives: "two" })], truncated: false });
		expect(await steer(r, "sessions")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("session.pending_directives");
		expect(r.out).toEqual([]);
	});
});

describe("failures are typed and mapped to exit codes", () => {
	const cases: Array<[string, Reply, number, string]> = [
		["a 404 says the server predates the feature or the flag is off, and is a refusal", json({ error: "not found" }, 404), EXIT_REFUSED, "predates Live Steering"],
		["a 401 is a refusal about the token", json({ error: "unauthorized" }, 401), EXIT_REFUSED, "SUBSTRATE_TOKEN"],
		["a 500 is a sanitized failure", json({ error: "index down" }, 500), EXIT_FAILED, "HTTP 500: the server could not complete the request"],
		["a 500 with an HTML body is still a failure", new Response("<html>bad gateway</html>", { status: 502 }), EXIT_FAILED, "HTTP 502"],
		["a 200 that is not JSON is a bad response", new Response("<html>", { status: 200 }), EXIT_FAILED, "not JSON"],
		["a 200 with the wrong shape is a bad response", json({ nope: true }), EXIT_FAILED, "no valid sessions"],
		["a 400 is a sanitized refusal", json({ error: "bad repo_id" }, 400), EXIT_REFUSED, "HTTP 400: the server refused the request"],
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

	test("control characters in a server's error text never reach the terminal", async () => {
		const r = rig();
		r.reply = () => json({ error: "nope\u001b[2J\u001b[H gone" }, 400);
		expect(await steer(r, "sessions")).toBe(EXIT_REFUSED);
		expect(text(r.err)).toContain("HTTP 400: the server refused the request");
		expect(text(r.err)).not.toContain("nope");
		expect(text(r.err)).not.toContain("\u001b");
	});
});

describe("status", () => {
	test("untargeted status shows only metadata and public digest, without private fanout or counts", async () => {
		const r = rig();
		r.reply = (call) => {
			if (call.path === "/steering/sessions") return json({ sessions: [sessionRow(LIVE_ID, { pending_directives: 7, steering: "private directions", planning_hash: "private-hash" }), sessionRow(OTHER_LIVE_ID)], truncated: false });
			if (call.path === "/steering/directives") throw new Error("untargeted private fanout");
			return json(digest());
		};
		expect(await steer(r, "status")).toBe(EXIT_DONE);
		const printed = text(r.out);
		expect(printed).toContain("sessions (2):");
		expect(printed).not.toContain("pending");
		expect(printed).not.toContain("private directions");
		expect(printed).not.toContain("planning=");
		expect(printed).toContain("context digest");
		expect(printed).toContain("sessions 1, claims 0, events 1");
		expect(printed).toContain("cut: events");
		expect(r.calls.map((call) => call.path)).toEqual(["/steering/sessions", "/session/context"]);
	});

	test("--session narrows to one session and always asks for its directives", async () => {
		const r = rig();
		r.reply = (call) => {
			if (call.path === "/steering/sessions") return json({ sessions: [sessionRow(LIVE_ID), sessionRow(OTHER_LIVE_ID)], truncated: false });
			if (call.path === "/steering/directives") return json({ directives: [] });
			return json(digest());
		};
		await steer(r, "status", "--session", OTHER_LIVE_ID);
		const printed = text(r.out);
		expect(printed).toContain("sessions (1):");
		expect(printed).not.toContain(LIVE_ID);
		expect(r.calls.find((call) => call.path === "/steering/directives")?.params.session_id).toBe(OTHER_LIVE_ID);
		expect(r.calls.find((call) => call.path === "/session/context")?.params.session_id).toBe(OTHER_LIVE_ID);
	});

	test("the pending-directives heading prints the whole live handle, so the handle it shows can be passed back as --session", async () => {
		const r = rig();
		r.reply = (call) => {
			if (call.path === "/steering/sessions") return json({ sessions: [sessionRow(LIVE_ID)], truncated: false });
			if (call.path === "/steering/directives") return json({ directives: [] });
			return json(digest());
		};
		expect(await steer(r, "status", "--session", LIVE_ID)).toBe(EXIT_DONE);
		expect(text(r.out)).toContain(`pending directives:\n  ${LIVE_ID}:`);
	});

	test("a server without the context route still gives a status, and says why the digest is missing", async () => {
		const r = rig();
		r.reply = (call) => (call.path === "/steering/sessions" ? json({ sessions: [sessionRow(LIVE_ID)], truncated: false }) : json({}, 404));
		expect(await steer(r, "status")).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("context digest unavailable");
		expect(text(r.out)).toContain("predates Live Steering");
	});

	test("a failed session list fails the command", async () => {
		const r = rig();
		r.reply = () => json({}, 500);
		expect(await steer(r, "status")).toBe(EXIT_FAILED);
	});

	test("--json is one object with sessions, directives and the digest counts", async () => {
		const r = rig();
		r.reply = (call) => {
			if (call.path === "/steering/sessions") return json({ sessions: [sessionRow(LIVE_ID, { pending_directives: 1 })], truncated: false });
			if (call.path === "/steering/directives") return json({ directives: [directive("d-1")] });
			return json(digest());
		};
		await steer(r, "status", "--json");
		const printed = JSON.parse(text(r.out)) as { sessions: unknown[]; directives: Array<{ session_id: string; directives: unknown[] }>; context: { counts: Record<string, number>; truncated: string[] } };
		expect(printed.sessions).toHaveLength(1);
		expect(printed.directives).toEqual([]);
		expect(printed.sessions).toEqual([{ session_id: LIVE_ID, surface: "omp", repo_id: "acme/widgets", state: "ACTIVE", updated_at: "2026-01-01T00:55:00.000Z" }]);
		expect(printed.context.counts.events).toBe(1);
		expect(printed.context.truncated).toEqual(["events"]);
	});

	test("server-supplied names and errors in the text status never carry control characters; --json keeps the raw values", async () => {
		const answer = (call: Call): Response => {
			if (call.path === "/steering/sessions") return json({ sessions: [sessionRow(LIVE_ID, { pending_directives: 1 })], truncated: false });
			if (call.path === "/steering/directives") return json({ error: "bad\u001b[2Jdirectives" }, 400);
			return json({ ...digest(), truncated: { "ev\u001b[2Jents": true } });
		};
		const r = rig();
		r.reply = answer;
		expect(await steer(r, "status")).toBe(EXIT_DONE);
		expect(text(r.out)).not.toContain("\u001b");
		expect(text(r.out)).toContain("cut: ev [2Jents");
		expect(text(r.out)).not.toContain("unavailable:");
		expect(r.calls.some((call) => call.path === "/steering/directives")).toBe(false);
		const raw = rig();
		raw.reply = answer;
		await steer(raw, "status", "--json");
		const printed = JSON.parse(text(raw.out)) as { context: { truncated: string[] } };
		expect(printed.context.truncated).toEqual(["ev\u001b[2Jents"]);
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

	test("--json prints only the guarded write reply fields", async () => {
		const r = rig();
		const reply = { status: "queued", directive_id: "d-1", extra: [1, 2] };
		r.reply = () => json(reply);
		expect(await steer(r, "queue", "--session", "s", "--action", "pause", "--body", "x", "--json")).toBe(EXIT_DONE);
		expect(JSON.parse(text(r.out))).toEqual({ status: "queued", directive_id: "d-1" });
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

	test("a 404 says the route is missing, and is a refusal: exit 3", async () => {
		const r = rig();
		r.reply = () => json({}, 404);
		expect(await steer(r, "queue", "--session", "s", "--action", "pause", "--body", "x")).toBe(EXIT_REFUSED);
		expect(text(r.err)).toContain("predates Live Steering");
	});

	test("--conflicts sends conflicts_with_active_plan: true, and without it the key is left out", async () => {
		const r = rig();
		r.reply = () => json({ status: "queued", directive_id: "d-1" });
		expect(await steer(r, "queue", "--session", "s", "--action", "redirect", "--body", "x", "--conflicts")).toBe(EXIT_DONE);
		expect(defined(r.calls[0]).body).toEqual({ session_id: "s", action: "redirect", body: "x", conflicts_with_active_plan: true });
		const without = rig();
		without.reply = () => json({ status: "queued", directive_id: "d-2" });
		await steer(without, "queue", "--session", "s", "--action", "redirect", "--body", "x");
		expect(Object.keys(defined(without.calls[0]).body ?? {})).not.toContain("conflicts_with_active_plan");
	});

	test("a reply that says queued without a directive id is a bad response, exit 1, never a success", async () => {
		const r = rig();
		r.reply = () => json({ status: "queued" });
		expect(await steer(r, "queue", "--session", "s", "--action", "pause", "--body", "x")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("directive_id");
		expect(r.out).toEqual([]);
	});

	test("a reply with a status the tools do not have is a bad response, exit 1", async () => {
		const r = rig();
		r.reply = () => json({ status: "done", directive_id: "d-1" });
		expect(await steer(r, "queue", "--session", "s", "--action", "pause", "--body", "x")).toBe(EXIT_FAILED);
		expect(r.out).toEqual([]);
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
		d.reply = () => json({ status: "acknowledged", directive_id: "d-2", outcome: "declined" });
		await steer(d, "ack", "d-2", "--declined");
		expect(defined(d.calls[0]).body).toEqual({ directive_id: "d-2", outcome: "declined" });
	});

	test("an applied pause reports the session state and the checkpoint hint", async () => {
		const r = rig();
		r.reply = () =>
			json({ status: "acknowledged", directive_id: "d-1", outcome: "applied", session_state: { status: "applied", state: "PAUSED" }, checkpoint_hint: { trigger: "steering", directive_id: "d-1" } });
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
		r.reply = () => json({ status: "acknowledged", directive_id: "d-1", outcome: "applied", checkpoint_hint: { trigger: 7 } });
		expect(await steer(r, "ack", "d-1", "--applied")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("checkpoint_hint");
	});

	test("an acknowledgement without its outcome is a bad response, exit 1", async () => {
		const r = rig();
		r.reply = () => json({ status: "acknowledged", directive_id: "d-1" });
		expect(await steer(r, "ack", "d-1", "--applied")).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("outcome");
		expect(r.out).toEqual([]);
	});

	test("an unknown directive is the server's typed refusal: exit 3, and not blamed on the server's version or flag", async () => {
		const r = rig();
		r.reply = () => json({ status: "refused", error: { code: "not-found" } }, 404);
		expect(await steer(r, "ack", "d-404", "--applied")).toBe(EXIT_REFUSED);
		expect(text(r.err)).toContain("the requested session or directive was not found");
		expect(text(r.err)).not.toContain("predates Live Steering");
		expect(r.out).toEqual([]);
	});

	test("a 404 that is not that refusal is the missing route or steering switched off: exit 3, the message names the flag", async () => {
		const r = rig();
		r.reply = () => json({ error: "live steering is off (SUBSTRATE_PLANNING_STEERING)" }, 404);
		expect(await steer(r, "ack", "d-1", "--applied")).toBe(EXIT_REFUSED);
		expect(text(r.err)).toContain("predates Live Steering");
		expect(text(r.err)).toContain("flag that enables it is off");
	});
});

describe("queue and ack classify a reply by its typed body before its HTTP status", () => {
	const writes: Array<[string, string[]]> = [
		["queue", ["queue", "--session", "s", "--action", "pause", "--body", "x"]],
		["ack", ["ack", "d-1", "--applied"]],
	];
	const outcomes: Array<[string, () => Response, number, string]> = [
		["misconfigured (HTTP 503)", () => json({ status: "misconfigured", errors: [{ key: "SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN", reason: "not-integer" }] }, 503), EXIT_REFUSED, "misconfigured"],
		["not-configured (HTTP 503)", () => json({ status: "not-configured" }, 503), EXIT_REFUSED, "not-configured"],
		["forbidden (HTTP 403)", () => json({ status: "forbidden", reason: "operator-required" }, 403), EXIT_REFUSED, "forbidden: operator-required"],
		["refused with a retry-after class status (HTTP 503 audit-unavailable)", () => json({ status: "refused", error: { code: "audit-unavailable" } }, 503), EXIT_REFUSED, "refused (audit-unavailable)"],
		["the typed not-found of a directive (HTTP 404)", () => json({ status: "refused", error: { code: "not-found" } }, 404), EXIT_REFUSED, "the requested session or directive was not found"],
		["a 404 with no typed body: steering is off or the route is missing", () => json({ error: "not found" }, 404), EXIT_REFUSED, "flag that enables it is off"],
		["a 404 with a body that is not JSON", () => new Response("<html>no</html>", { status: 404 }), EXIT_REFUSED, "predates Live Steering"],
		["a 503 with no typed body is a sanitized server fault", () => json({ error: "index down" }, 503), EXIT_FAILED, "HTTP 503: the server could not complete the request"],
	];
	for (const [command, argv] of writes) {
		for (const [name, reply, exit, message] of outcomes) {
			test(`${command}: ${name} is exit ${exit}`, async () => {
				const r = rig();
				r.reply = reply;
				expect(await steer(r, ...argv)).toBe(exit);
				expect(text(r.err)).toContain(message);
				expect(r.out).toEqual([]);
			});
		}
	}
});

describe("list", () => {
	test("defaults to every status and prints each directive with its body, author and age", async () => {
		const r = rig();
		r.reply = () => json({ directives: [directive("d-1"), directive("d-2", { status: "acknowledged", outcome: "applied", acknowledged_at: "2026-01-01T00:58:00.000Z", checkpoint_hint: { trigger: "steering", directive_id: "d-2" } })] });
		expect(await steer(r, "list", "--session", LIVE_ID)).toBe(EXIT_DONE);
		expect(defined(r.calls[0]).params).toEqual({ session_id: LIVE_ID, status: "all" });
		const printed = text(r.out);
		expect(printed).toContain("d-1  queued  redirect/high  by operator-1  5m ago");
		expect(printed).toContain("acknowledged (applied)");
		expect(printed).toContain("checkpoint_hint=steering");
		expect(printed).toContain("switch to the parser");
	});

	test("--status is passed through; an empty list says so", async () => {
		const r = rig();
		r.reply = () => json({ directives: [] });
		await steer(r, "list", "--session", LIVE_ID, "--status", "queued");
		expect(defined(r.calls[0]).params.status).toBe("queued");
		expect(text(r.out)).toBe("no directives\n");
	});

	test("--json prints the guarded list", async () => {
		const r = rig();
		r.reply = () => json({ directives: [directive("d-1")] });
		await steer(r, "list", "--session", LIVE_ID, "--json");
		expect((JSON.parse(text(r.out)) as Array<{ id: string }>).map((d) => d.id)).toEqual(["d-1"]);
	});

	test("a directive with an unknown action is a bad response naming the field", async () => {
		const r = rig();
		r.reply = () => json({ directives: [directive("d-1", { action: "explode" })] });
		expect(await steer(r, "list", "--session", LIVE_ID)).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("directive.action");
	});

	test("control characters in a body never reach the terminal", async () => {
		const r = rig();
		r.reply = () => json({ directives: [directive("d-1", { body: "\u001b[2Jwipe\u0007" })] });
		await steer(r, "list", "--session", LIVE_ID);
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

	test("a 404 says the server predates the feature, and is a refusal: exit 3", async () => {
		const r = rig();
		r.reply = () => json({}, 404);
		expect(await steer(r, "context")).toBe(EXIT_REFUSED);
		expect(text(r.err)).toContain("predates Live Steering");
	});
});

/** A pause that only an abort ends: what a real 30 s backoff is to a Ctrl-C. */
function untilAbort(signal: AbortSignal | undefined): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	signal?.addEventListener("abort", () => resolve(), { once: true });
	return promise;
}

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
		expect(await steer(r, "listen", "--session", LIVE_ID, "--once")).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("d-1  queued  redirect/high");
		expect(text(r.out)).toContain("switch to the parser");
		expect(r.calls).toHaveLength(2);
		expect(defined(r.calls[0])).toMatchObject({ method: "GET", path: "/steering/wait", authorization: "Bearer token-for-default" });
		expect(defined(r.calls[0]).params).toEqual({ session_id: LIVE_ID, timeout_ms: String(LISTEN_POLL_MS) });
	});

	test("remembers the last id: the next poll asks for what comes after it", async () => {
		const r = rig();
		const script = [delivered("d-1"), delivered("d-2"), delivered("d-3")];
		r.reply = (call) => {
			const next = script.shift();
			return next === undefined ? timedOut(r, call) : next;
		};
		expect(await steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "30000")).toBe(EXIT_DONE);
		expect(r.calls.slice(0, 4).map((call) => call.params.after)).toEqual([undefined, "d-1", "d-2", "d-3"]);
		expect(text(r.out).match(/queued {2}redirect/g)).toHaveLength(3);
	});

	test("--after starts from a given directive", async () => {
		const r = rig();
		r.reply = () => delivered("d-9");
		await steer(r, "listen", "--session", LIVE_ID, "--once", "--after", "d-8");
		expect(defined(r.calls[0]).params.after).toBe("d-8");
	});

	test("the 204 loop: polls again until the bound, asking for no more than is left, then exits 0", async () => {
		const r = rig();
		r.reply = (call) => timedOut(r, call);
		expect(await steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "60000")).toBe(EXIT_DONE);
		expect(r.calls.map((call) => call.params.timeout_ms)).toEqual(["25000", "25000", "10000"]);
		expect(r.sleeps).toEqual([]);
		expect(text(r.err)).toContain("stopped after 60000 ms with 0 directives");
		expect(r.out).toEqual([]);
	});

	test("with --once and no directive inside the bound it ends quietly on stdout", async () => {
		const r = rig();
		r.reply = (call) => timedOut(r, call);
		expect(await steer(r, "listen", "--session", LIVE_ID, "--once", "--max-wait-ms", "1000")).toBe(EXIT_DONE);
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
		expect(await steer(r, "listen", "--session", LIVE_ID, "--once")).toBe(EXIT_DONE);
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
		await steer(r, "listen", "--session", LIVE_ID, "--once");
		expect(r.sleeps).toEqual([1_000, 2_000, 1_000]);
	});

	test("a 5xx and a timeout are retried like a dropped connection", async () => {
		const r = rig();
		const script: Reply[] = [json({ error: "busy" }, 503), Object.assign(new Error("slow"), { name: "TimeoutError" })];
		r.reply = () => script.shift() ?? delivered("d-1");
		expect(await steer(r, "listen", "--session", LIVE_ID, "--once")).toBe(EXIT_DONE);
		expect(r.sleeps).toEqual([1_000, 2_000]);
	});

	test("the backoff never sleeps past the bound, and the loop then ends with exit 0", async () => {
		const r = rig();
		r.reply = () => new TypeError("down");
		expect(await steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "2500")).toBe(EXIT_DONE);
		expect(r.sleeps).toEqual([1_000, 1_500]);
		expect(r.calls).toHaveLength(2);
	});

	/** A request signal that never fires, recording the budget it was asked for. */
	const budgetSignal = (budgets: number[], ms: number): AbortSignal => {
		budgets.push(ms);
		return new AbortController().signal;
	};

	describe("--max-wait-ms is one budget for the whole command", () => {
		test("a request that stalls is cut where the budget ends: its signal carries the remaining budget, and the loop ends at once with exit 0", async () => {
			const budgets: number[] = [];
			const aborters: AbortController[] = [];
			const r = rig({
				signalFor: (ms) => {
					budgets.push(ms);
					const controller = new AbortController();
					aborters.push(controller);
					return controller.signal;
				},
				// A connection that never answers: it only ends when its own signal aborts.
				fetch: (_input, init) => {
					const { promise, reject } = Promise.withResolvers<Response>();
					init.signal.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), { once: true });
					return promise;
				},
			});
			const run = steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "1000");
			for (let turn = 0; turn < 100 && aborters.length === 0; turn++) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setImmediate(resolve);
				await promise;
			}
			// The 25 s long poll plus its margin would be 30 s: the budget caps the request at what is left of the command.
			expect(budgets).toEqual([1_000]);
			r.clock.ms += 1_000;
			defined(aborters[0], "the request's abort controller").abort();

			expect(await run).toBe(EXIT_DONE);
			expect(budgets).toEqual([1_000]);
			expect(r.sleeps).toEqual([]);
			expect(text(r.err)).not.toContain("reconnecting");
			expect(text(r.err)).toContain("stopped after 1000 ms");
		});

		test("each request is capped at what is left, never above the client's own long-poll timeout", async () => {
			const budgets: number[] = [];
			const r = rig({ signalFor: (ms) => budgetSignal(budgets, ms) });
			r.reply = (call) => timedOut(r, call);
			expect(await steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "60000")).toBe(EXIT_DONE);
			// Polls of 25 s, 25 s, 10 s; the request allowance is the poll plus the margin, capped by the time left.
			expect(budgets).toEqual([30_000, 30_000, 10_000]);
		});

		test("without --max-wait-ms the request keeps the client's own long-poll timeout", async () => {
			const budgets: number[] = [];
			const r = rig({ signalFor: (ms) => budgetSignal(budgets, ms) });
			r.reply = () => delivered("d-1");
			await steer(r, "listen", "--session", LIVE_ID, "--once");
			expect(budgets).toEqual([LISTEN_POLL_MS + 5_000]);
		});

		test("the pause after an instant answer is clipped to what is left, and the command then ends with exit 0", async () => {
			const r = rig();
			r.reply = () => new Response(null, { status: 204 });
			expect(await steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "2500")).toBe(EXIT_DONE);
			expect(r.sleeps).toEqual([1_000, 1_000, 500]);
			expect(r.calls).toHaveLength(3);
		});

		test("a pause with nothing left is not slept at all", async () => {
			const r = rig();
			// An answer that takes the whole budget and is still too quick to be a long poll: no pause may follow it.
			r.reply = () => {
				r.clock.ms += 100;
				return new Response(null, { status: 204 });
			};
			expect(await steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "100")).toBe(EXIT_DONE);
			expect(r.sleeps).toEqual([]);
			expect(r.calls).toHaveLength(1);
		});
	});

	test("a failure a reconnect cannot fix stops the loop: 401 and 404 are refusals, a bad body a failure", async () => {
		const expectations: Array<[Response, number]> = [
			[json({}, 401), EXIT_REFUSED],
			[json({}, 404), EXIT_REFUSED],
			[json({ directive: { id: "d-1" } }), EXIT_FAILED],
			[json({ nothing: true }), EXIT_FAILED],
		];
		for (const [response, exit] of expectations) {
			const r = rig();
			r.reply = () => response.clone() as Response;
			expect(await steer(r, "listen", "--session", LIVE_ID)).toBe(exit);
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
		expect(await steer(r, "listen", "--session", LIVE_ID)).toBe(EXIT_DONE);
		expect(r.calls).toHaveLength(1);
		expect(r.sleeps).toEqual([]);
		expect(text(r.err)).not.toContain("reconnecting");
	});

	test("an interrupt before the first poll sends nothing", async () => {
		const r = rig();
		r.interrupt.abort();
		expect(await steer(r, "listen", "--session", LIVE_ID)).toBe(EXIT_DONE);
		expect(r.calls).toEqual([]);
	});

	test("a server that answers 204 at once is paced, so the loop cannot spin", async () => {
		const r = rig();
		r.reply = () => new Response(null, { status: 204 });
		expect(await steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "3000")).toBe(EXIT_DONE);
		expect(r.sleeps.length).toBeGreaterThan(0);
		expect(r.sleeps.every((ms) => ms >= 200)).toBe(true);
		expect(r.calls.length).toBeLessThanOrEqual(4);
	});

	test("a server that clamps the long poll: the next poll asks for what it applied, from the header of a 204", async () => {
		const r = rig();
		// A server whose ceiling is one second answers any longer request after one second, and says so.
		r.reply = (call) => {
			if (r.calls.length > 1) return delivered("d-1");
			r.clock.ms += Math.min(Number(call.params.timeout_ms), 1_000);
			return new Response(null, { status: 204, headers: { "x-steering-wait-ms": "1000" } });
		};
		expect(await steer(r, "listen", "--session", LIVE_ID, "--once")).toBe(EXIT_DONE);
		expect(r.calls.map((call) => call.params.timeout_ms)).toEqual([String(LISTEN_POLL_MS), "1000"]);
		expect(r.sleeps).toEqual([]);
		expect(text(r.out)).toContain("d-1");
	});

	test("the wait_ms of a delivered directive paces the next poll too", async () => {
		const r = rig();
		r.reply = () => {
			if (r.calls.length === 1) return json({ directive: directive("d-1"), wait_ms: 2_000 });
			r.interrupt.abort();
			return new Response(null, { status: 204 });
		};
		expect(await steer(r, "listen", "--session", LIVE_ID)).toBe(EXIT_DONE);
		expect(r.calls.map((call) => call.params.timeout_ms)).toEqual([String(LISTEN_POLL_MS), "2000"]);
	});

	test("a 400 with the server's words is a refusal that ends the loop with exit 3, not a transient error to retry", async () => {
		const r = rig();
		r.reply = () => json({ error: "timeout_ms must be a whole number from 1 to 1000" }, 400);
		expect(await steer(r, "listen", "--session", LIVE_ID)).toBe(EXIT_REFUSED);
		expect(r.calls).toHaveLength(1);
		expect(r.sleeps).toEqual([]);
		expect(text(r.err)).toContain("HTTP 400: the server refused the request");
		expect(text(r.err)).not.toContain("timeout_ms must be");
	});

	test("a reconnect line carries no control characters from the server's error", async () => {
		const r = rig();
		const script: Reply[] = [json({ error: "busy\u001b[2K\u001b[1A" }, 503)];
		r.reply = () => script.shift() ?? delivered("d-1");
		expect(await steer(r, "listen", "--session", LIVE_ID, "--once")).toBe(EXIT_DONE);
		expect(text(r.err)).toContain("reconnecting in 1s");
		expect(text(r.err)).not.toContain("\u001b");
	});

	test("Ctrl-C during the longest backoff ends the loop at once: the pause gets the interrupt signal", async () => {
		const requested: number[] = [];
		const r: Rig = rig({
			sleep: (ms, signal) => {
				requested.push(ms);
				if (requested.length < 6) return Promise.resolve();
				// The operator presses Ctrl-C while the 30 s pause is running.
				queueMicrotask(() => r.interrupt.abort());
				return untilAbort(signal);
			},
		});
		r.reply = () => new TypeError("down");
		expect(await steer(r, "listen", "--session", LIVE_ID)).toBe(EXIT_DONE);
		expect(requested).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, LISTEN_BACKOFF_MAX_MS]);
		expect(r.calls).toHaveLength(6);
	});

	test("Ctrl-C during the pause after an instant answer ends the loop at once", async () => {
		const r: Rig = rig({
			sleep: (_ms, signal) => {
				queueMicrotask(() => r.interrupt.abort());
				return untilAbort(signal);
			},
		});
		r.reply = () => new Response(null, { status: 204 });
		expect(await steer(r, "listen", "--session", LIVE_ID)).toBe(EXIT_DONE);
		expect(r.calls).toHaveLength(1);
	});

	test("a server that restarted and replays directives already printed: each is printed once and the cursor moves on", async () => {
		const r = rig();
		// After the restart the queue still holds d-1 and d-2 (their acknowledgement was lost), so `after: d-2` starts at the first.
		const script = [delivered("d-1"), delivered("d-2"), delivered("d-1"), delivered("d-2"), delivered("d-3")];
		r.reply = (call) => script.shift() ?? timedOut(r, call);
		expect(await steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "30000")).toBe(EXIT_DONE);
		expect(text(r.out).match(/ queued {2}redirect/g)).toHaveLength(3);
		expect(r.calls.slice(0, 6).map((call) => call.params.after)).toEqual([undefined, "d-1", "d-2", "d-1", "d-2", "d-3"]);
		expect(r.sleeps).toEqual([]);
	});

	test("a server that keeps repeating one printed directive is paced, and prints it once", async () => {
		const r = rig();
		r.reply = () => delivered("d-1");
		expect(await steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "3000")).toBe(EXIT_DONE);
		expect(text(r.out).match(/ queued {2}redirect/g)).toHaveLength(1);
		expect(r.sleeps.length).toBeGreaterThan(0);
		expect(r.sleeps.every((ms) => ms >= 200)).toBe(true);
		expect(r.calls.length).toBeLessThanOrEqual(5);
	});

	test("the memory of printed ids is bounded: the oldest is forgotten when it is full", async () => {
		const r = rig();
		const ids = Array.from({ length: LISTEN_PRINTED_MAX + 1 }, (_, index) => `d-${index}`);
		// d-0 was printed first; once LISTEN_PRINTED_MAX newer ids went by it is no longer remembered, so it prints again.
		const script = [...ids, "d-0"].map((id) => delivered(id));
		r.reply = (call) => script.shift() ?? timedOut(r, call);
		expect(await steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "1000")).toBe(EXIT_DONE);
		expect(text(r.out).match(/^d-0 {2}queued/gm)).toHaveLength(2);
	});

	test("--json prints one JSON object per directive and nothing else on stdout", async () => {
		const r = rig();
		r.reply = (call) => (r.calls.length === 1 ? delivered("d-1") : r.calls.length === 2 ? delivered("d-2") : timedOut(r, call));
		expect(await steer(r, "listen", "--session", LIVE_ID, "--max-wait-ms", "1000", "--json")).toBe(EXIT_DONE);
		const lines = text(r.out).trimEnd().split("\n");
		expect(lines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(["d-1", "d-2"]);
		expect(text(r.err)).not.toContain("stopped after");
	});
});

describe("abortableSleep", () => {
	test("an already aborted signal resolves at once, and an abort during the pause ends it; no timer is left to hold the process", async () => {
		const done = new AbortController();
		done.abort();
		await abortableSleep(60_000, done.signal);
		const live = new AbortController();
		const pending = abortableSleep(60_000, live.signal);
		live.abort();
		await pending;
		await abortableSleep(0);
	});
});

describe("strict live lifecycle grammar", () => {
	const invalid: string[][] = [
		["open", "--session", LIVE_ID], ["open", "--binding-file"], ["heartbeat"], ["close"],
		["heartbeat", "--session", "historical-session"], ["close", "--session", "historical-session"],
		["list", "--session", "historical-session"], ["listen", "--session", "historical-session"],
		["status", "--session", "historical-session"], ["status", "--binding-file", "/not-selected"],
		["sessions", "--binding-file", "/not-selected"], ["context", "--binding-file", "/not-selected"],
		["heartbeat", "--session", LIVE_ID, "--repo", "acme/widgets"],
		["close", "--session", LIVE_ID, "--session", OTHER_LIVE_ID],
		["heartbeat", "--session", `ls_${"A".repeat(64)}`],
		["forget"], ["forget", "historical-session"], ["forget", LIVE_ID, OTHER_LIVE_ID], ["forget", LIVE_ID, "--session", LIVE_ID],
	];
	for (const argv of invalid) {
		test(`rejects ${argv.join(" ")} before resolving a bearer or fetching`, async () => {
			const r = rig({ tokenFor: () => { throw new Error("usage must precede credential resolution"); } });
			expect(await steer(r, ...argv)).toBe(EXIT_USAGE);
			expect(r.calls).toEqual([]);
			expect(r.out).toEqual([]);
		});
	}
	for (const sub of ["open", "heartbeat", "close", "list", "listen", "status"]) {
		for (const flag of ["--session-binding", "--binding-proof", "--proof"]) {
			test(`${sub} never accepts ${flag} on argv`, async () => {
				const r = rig();
				const args = sub === "open" ? [sub] : [sub, "--session", LIVE_ID];
				expect(await steer(r, ...args, flag, PROOF)).toBe(EXIT_USAGE);
				expect(r.calls).toEqual([]);
				expect(text(r.out) + text(r.err)).not.toContain(PROOF);
			});
		}
	}
});

describe("open retains the only private proof", () => {
	for (const asJson of [false, true]) {
		test(`real command writes a private record without printing proof (${asJson ? "json" : "text"})`, async () => {
			const r = rig();
			r.reply = () => json(issued({ extra: { session_binding: PROOF, bearer: "token-for-default" } }));
			expect(await steer(r, "open", ...(asJson ? ["--json"] : []))).toBe(EXIT_DONE);
			expect(r.calls).toEqual([{ method: "POST", path: "/steering/sessions", params: {}, body: { repo_id: "acme/widgets", state: "ACTIVE" }, authorization: "Bearer token-for-default" }]);
			const publicReply: unknown = asJson ? JSON.parse(text(r.out)) : undefined;
			const path = asJson ? bindingFileFromOutput(publicReply) : text(r.out).trim().split("; binding file ")[1];
			const recordPath = defined(path);
			expect(loadBindingRecord(recordPath, recordFor(r))).toEqual(recordFor(r));
			expect(statSync(recordPath).mode & 0o777).toBe(0o600);
			expect(statSync(defined(r.deps.bindingDirectory)).mode & 0o777).toBe(0o700);
			expect(text(r.out)).toContain(LIVE_ID);
			expect(text(r.out)).toContain(EXPIRES);
			expect(text(r.out) + text(r.err)).not.toContain(PROOF);
			expect(text(r.out) + text(r.err)).not.toContain("token-for-default");
			expect(text(r.out)).not.toContain("session_binding");
			expect(r.err).toEqual([]);
			if (asJson) expect(publicReply).toEqual({ status: "issued", session_id: LIVE_ID, repo_id: "acme/widgets", state: "ACTIVE", updated_at: "2026-01-01T01:00:00.000Z", expires_at: EXPIRES, binding_file: recordPath });
		});
	}

	test("explicit repo, surface and file path select one issuance record", async () => {
		const r = rig({ repo: () => undefined });
		const path = join(defined(r.deps.bindingDirectory), "selected.json");
		r.reply = () => json(issued({ repo_id: "other/repo" }));
		expect(await steer(r, "open", "--repo", "other/repo", "--surface", "omp", "--binding-file", path, "--json")).toBe(EXIT_DONE);
		expect(defined(r.calls[0]).body).toEqual({ repo_id: "other/repo", state: "ACTIVE" });
		expect(defined(r.calls[0]).authorization).toBe("Bearer token-for-omp");
		expect(loadBindingRecord(path, recordFor(r, { surface: "omp" })).surface).toBe("omp");
		const publicReply: unknown = JSON.parse(text(r.out));
		expect(bindingFileFromOutput(publicReply)).toBe(path);
	});

	for (const fromOrigin of [false, true]) {
		test(`mixed-case ${fromOrigin ? "origin" : "--repo"} retains issuance and prints canonical repository only`, async () => {
			const r = rig({ repo: () => fromOrigin ? "Acme/Widgets" : undefined });
			r.reply = () => json(issued());
			expect(await steer(r, "open", ...(fromOrigin ? [] : ["--repo", "Acme/Widgets"]), "--json")).toBe(EXIT_DONE);
			const publicReply: unknown = JSON.parse(text(r.out));
			expect(publicReply).toMatchObject({ repo_id: "acme/widgets", session_id: LIVE_ID });
			expect(loadBindingRecord(bindingFileFromOutput(publicReply), recordFor(r))).toEqual(recordFor(r));
			expect(text(r.out) + text(r.err)).not.toContain(PROOF);
			expect(text(r.out) + text(r.err)).not.toContain("token-for-default");
		});
	}

	test("no repository refuses locally before issuance", async () => {
		const r = rig({ repo: () => undefined });
		expect(await steer(r, "open")).toBe(EXIT_USAGE);
		expect(r.calls).toEqual([]);
	});

	test("local persistence failure never replaces a credential or claims usable success", async () => {
		const r = rig();
		const path = retain(r, { session_binding: OTHER_PROOF });
		const before = readFileSync(path, "utf8");
		r.reply = () => json(issued());
		expect(await steer(r, "open", "--binding-file", path, "--json")).toBe(EXIT_FAILED);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(r.calls).toHaveLength(1);
		expect(r.out).toEqual([]);
		expect(text(r.err)).toContain("unused issued identity expires");
		expect(text(r.err)).not.toContain(PROOF);
		expect(text(r.err)).not.toContain(OTHER_PROOF);
		expect(text(r.err)).not.toContain("token-for-default");
	});
});

describe("open at capacity clears only records the server names not found", () => {
	const directoryOf = (r: Rig): string => defined(r.deps.bindingDirectory);
	const pathOf = (r: Rig, session: string): string => bindingRecordPath(serverIdentity(r.deps.url), "claude-code", session, { directory: directoryOf(r) });
	const posts = (r: Rig): Call[] => r.calls.filter((call) => call.method === "POST");
	const checks = (r: Rig): Call[] => r.calls.filter((call) => call.path === "/steering/directives");
	const held = (r: Rig): number => readdirSync(directoryOf(r)).length;

	/** Writes `count` valid records for distinct sessions straight to disk; returns their handles. */
	function fill(r: Rig, count: number): string[] {
		return Array.from({ length: count }, (_, index) => {
			const session = `ls_${(index + 1).toString(16).padStart(64, "0")}`;
			writeFileSync(pathOf(r, session), JSON.stringify(recordFor(r, { session_id: session })), { mode: 0o600 });
			return session;
		});
	}

	test("below capacity no liveness check runs and open proceeds", async () => {
		const r = rig();
		fill(r, MAX_BINDING_RECORDS - 1);
		r.reply = (call) => (call.method === "POST" ? json(issued()) : json({ directives: [] }));
		expect(await steer(r, "open", "--json")).toBe(EXIT_DONE);
		expect(checks(r)).toEqual([]);
		expect(held(r)).toBe(MAX_BINDING_RECORDS);
	});

	test("at capacity a record the server answers not-found is cleared, and open proceeds", async () => {
		const r = rig();
		const sessions = fill(r, MAX_BINDING_RECORDS);
		const dead = defined(sessions[0]);
		const kept = defined(sessions[1]);
		r.reply = (call) => {
			if (call.method === "POST") return json(issued());
			return call.params.session_id === dead ? json({ status: "refused", error: { code: "not-found" } }, 404) : json({ directives: [] });
		};
		expect(await steer(r, "open", "--json")).toBe(EXIT_DONE);
		expect(checks(r)).toHaveLength(MAX_BINDING_RECORDS);
		expect(checks(r).every((call) => call.sessionBinding === PROOF)).toBe(true);
		expect(existsSync(pathOf(r, dead))).toBe(false);
		expect(existsSync(pathOf(r, kept))).toBe(true);
		expect(held(r)).toBe(MAX_BINDING_RECORDS);
	});

	test("at capacity live answers keep every record and refuse before any identity is issued", async () => {
		const r = rig();
		const sessions = fill(r, MAX_BINDING_RECORDS);
		r.reply = () => json({ directives: [] });
		expect(await steer(r, "open", "--json")).toBe(EXIT_FAILED);
		expect(checks(r)).toHaveLength(MAX_BINDING_RECORDS);
		expect(posts(r)).toEqual([]);
		expect(existsSync(pathOf(r, defined(sessions[0])))).toBe(true);
		expect(held(r)).toBe(MAX_BINDING_RECORDS);
		expect(r.out).toEqual([]);
		expect(text(r.err)).toContain("unused issued identity expires");
	});

	const failures: Array<[string, () => Response, number, string]> = [
		["a session authority outage", () => json({ status: "refused", error: { code: "session-unavailable" } }, 503), EXIT_REFUSED, "the session authority is unavailable"],
		["a server error", () => json({}, 500), EXIT_FAILED, "could not complete the request"],
		["a route the server does not have", () => json({ error: "not found" }, 404), EXIT_REFUSED, "predates Live Steering"],
	];
	for (const [label, answer, exit, message] of failures) {
		test(`at capacity ${label} is not death: open fails with that error and removes nothing`, async () => {
			const r = rig();
			fill(r, MAX_BINDING_RECORDS);
			r.reply = (call) => (call.method === "POST" ? json(issued()) : answer());
			expect(await steer(r, "open", "--json")).toBe(exit);
			expect(checks(r)).toHaveLength(1);
			expect(posts(r)).toEqual([]);
			expect(held(r)).toBe(MAX_BINDING_RECORDS);
			expect(text(r.err)).toContain(message);
			expect(r.out).toEqual([]);
		});
	}

	test("a record for another server is never checked with this client's bearer", async () => {
		const r = rig();
		const foreign = `ls_${"f".repeat(64)}`;
		const foreignPath = retain(r, { server_identity: serverIdentity("http://127.0.0.1:7411"), session_id: foreign, session_binding: OTHER_PROOF });
		fill(r, MAX_BINDING_RECORDS - 1);
		r.reply = (call) => {
			if (call.method === "POST") return json(issued());
			return call.params.session_id === foreign ? json({ status: "refused", error: { code: "not-found" } }, 404) : json({ directives: [] });
		};
		expect(await steer(r, "open", "--json")).toBe(EXIT_FAILED);
		expect(checks(r)).toHaveLength(MAX_BINDING_RECORDS - 1);
		expect(checks(r).some((call) => call.params.session_id === foreign || call.sessionBinding === OTHER_PROOF)).toBe(false);
		expect(checks(r).every((call) => call.authorization === "Bearer token-for-default")).toBe(true);
		expect(existsSync(foreignPath)).toBe(true);
		expect(posts(r)).toEqual([]);
		expect(text(r.err)).toContain("unused issued identity expires");
	});

	test("at capacity a record for this server and surface answered session-not-found is removed beside foreign records", async () => {
		const r = rig();
		const sessions = fill(r, MAX_BINDING_RECORDS - 2);
		const dead = defined(sessions[0]);
		const foreign = `ls_${"f".repeat(64)}`;
		const foreignPath = retain(r, { server_identity: serverIdentity("http://127.0.0.1:7411"), session_id: foreign, session_binding: OTHER_PROOF });
		const omp = `ls_${"e".repeat(64)}`;
		const ompPath = retain(r, { surface: "omp", session_id: omp, session_binding: OTHER_PROOF });
		r.reply = (call) => {
			if (call.method === "POST") return json(issued());
			const gone = call.params.session_id === dead || call.params.session_id === foreign || call.params.session_id === omp;
			return gone ? json({ status: "refused", error: { code: "not-found" } }, 404) : json({ directives: [] });
		};
		expect(await steer(r, "open", "--json")).toBe(EXIT_DONE);
		expect(checks(r)).toHaveLength(MAX_BINDING_RECORDS - 2);
		expect(checks(r).some((call) => call.params.session_id === foreign || call.params.session_id === omp)).toBe(false);
		expect(existsSync(pathOf(r, dead))).toBe(false);
		expect(existsSync(foreignPath)).toBe(true);
		expect(existsSync(ompPath)).toBe(true);
		expect(held(r)).toBe(MAX_BINDING_RECORDS);
	});

	test("a record for another surface of this server is never removed, even when its server answers not-found", async () => {
		const r = rig();
		const omp = `ls_${"e".repeat(64)}`;
		const ompPath = retain(r, { surface: "omp", session_id: omp, session_binding: OTHER_PROOF });
		fill(r, MAX_BINDING_RECORDS - 1);
		r.reply = (call) => {
			if (call.method === "POST") return json(issued());
			return call.params.session_id === omp ? json({ status: "refused", error: { code: "not-found" } }, 404) : json({ directives: [] });
		};
		expect(await steer(r, "open", "--json")).toBe(EXIT_FAILED);
		expect(checks(r).some((call) => call.params.session_id === omp || call.sessionBinding === OTHER_PROOF)).toBe(false);
		expect(existsSync(ompPath)).toBe(true);
		expect(posts(r)).toEqual([]);
	});
});

describe("selected private records drive reads and lifecycle", () => {
	test("heartbeat sends the exact proof and persists only its renewed expiry", async () => {
		const r = rig();
		const path = retain(r);
		const sibling = retain(r, { session_id: OTHER_LIVE_ID, session_binding: OTHER_PROOF });
		const siblingBefore = readFileSync(sibling, "utf8");
		r.reply = () => json({ status: "renewed", session_id: LIVE_ID, expires_at: RENEWED_EXPIRES, session_binding: PROOF });
		expect(await steer(r, "heartbeat", "--session", LIVE_ID, "--json")).toBe(EXIT_DONE);
		expect(defined(r.calls[0])).toMatchObject({ method: "POST", path: "/steering/sessions/heartbeat", params: {}, body: { session_id: LIVE_ID }, sessionBinding: PROOF });
		expect(loadBindingRecord(path, recordFor(r))).toEqual(recordFor(r, { expires_at: RENEWED_EXPIRES }));
		expect(readFileSync(sibling, "utf8")).toBe(siblingBefore);
		expect(JSON.parse(text(r.out))).toEqual({ status: "renewed", session_id: LIVE_ID, expires_at: RENEWED_EXPIRES });
		expect(text(r.out) + text(r.err)).not.toContain(PROOF);
	});

	test("failed heartbeat keeps the selected expiry and proof unchanged", async () => {
		const r = rig();
		const path = retain(r);
		const before = readFileSync(path, "utf8");
		r.reply = () => json({ status: "refused", error: { code: "not-found" } }, 404);
		expect(await steer(r, "heartbeat", "--session", LIVE_ID)).toBe(EXIT_REFUSED);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(r.out).toEqual([]);
	});

	test("close removes only the matching record after successful acknowledgement", async () => {
		const r = rig();
		const path = retain(r);
		const sibling = retain(r, { session_id: OTHER_LIVE_ID, session_binding: OTHER_PROOF });
		r.reply = () => {
			expect(existsSync(path)).toBe(true);
			return json({ status: "closed", session_id: LIVE_ID, closed_at: EXPIRES, session_binding: PROOF });
		};
		expect(await steer(r, "close", "--session", LIVE_ID, "--json")).toBe(EXIT_DONE);
		expect(existsSync(path)).toBe(false);
		expect(loadBindingRecord(sibling, recordFor(r, { session_id: OTHER_LIVE_ID })).session_binding).toBe(OTHER_PROOF);
		expect(defined(r.calls[0])).toMatchObject({ path: "/steering/sessions/close", body: { session_id: LIVE_ID }, sessionBinding: PROOF });
		expect(JSON.parse(text(r.out))).toEqual({ status: "closed", session_id: LIVE_ID, closed_at: EXPIRES });
		expect(text(r.out) + text(r.err)).not.toContain(PROOF);
	});

	for (const answer of [
		() => json({ status: "refused", error: { code: "not-found" } }, 404),
		() => json({ status: "refused", error: { code: "session-unavailable" } }, 503),
		() => json({ status: "closed", session_id: OTHER_LIVE_ID, closed_at: EXPIRES }),
		() => new TypeError(`${PROOF} Bearer token-for-default`),
	]) {
		test("failed close retains the selected credential", async () => {
			const r = rig();
			const path = retain(r);
			const before = readFileSync(path, "utf8");
			r.reply = answer;
			expect(await steer(r, "close", "--session", LIVE_ID, "--json")).not.toBe(EXIT_DONE);
			expect(readFileSync(path, "utf8")).toBe(before);
			expect(r.out).toEqual([]);
			expect(text(r.err)).not.toContain(PROOF);
			expect(text(r.err)).not.toContain("token-for-default");
		});
	}

	test("close cannot delete a replacement proof written while the request was in flight", async () => {
		const r = rig();
		const path = retain(r);
		r.reply = () => {
			unlinkSync(path);
			retain(r, { session_binding: OTHER_PROOF }, path);
			return json({ status: "closed", session_id: LIVE_ID, closed_at: EXPIRES });
		};
		expect(await steer(r, "close", "--session", LIVE_ID)).toBe(EXIT_FAILED);
		expect(loadBindingRecord(path, recordFor(r)).session_binding).toBe(OTHER_PROOF);
		expect(r.out).toEqual([]);
		expect(text(r.err)).toContain("matching local record could not be removed");
	});

	for (const sub of ["list", "listen", "status"] as const) {
		test(`${sub} uses only the explicitly selected record, never a sibling proof`, async () => {
			const r = rig();
			const selected = join(defined(r.deps.bindingDirectory), "chosen.json");
			retain(r, {}, selected);
			retain(r, { session_id: OTHER_LIVE_ID, session_binding: OTHER_PROOF });
			r.reply = (call) => {
				if (call.path === "/steering/sessions") return json({ sessions: [sessionRow(LIVE_ID), sessionRow(OTHER_LIVE_ID)], truncated: false });
				if (call.path === "/session/context") return json(digest());
				if (call.path === "/steering/wait") return json({ directive: directive("selected-directive") });
				return json({ directives: [directive("selected-directive")] });
			};
			expect(await steer(r, sub, "--session", LIVE_ID, "--binding-file", selected, "--json", ...(sub === "listen" ? ["--once"] : []))).toBe(EXIT_DONE);
			const privateCalls = r.calls.filter((call) => ["/steering/directives", "/steering/wait"].includes(call.path));
			expect(privateCalls).toHaveLength(1);
			expect(defined(privateCalls[0]).sessionBinding).toBe(PROOF);
			expect(defined(privateCalls[0]).params.session_id).toBe(LIVE_ID);
			for (const call of r.calls) {
				expect(JSON.stringify(call.params)).not.toContain(PROOF);
				expect(JSON.stringify(call.body ?? {})).not.toContain(PROOF);
				if (!privateCalls.includes(call)) expect(call.sessionBinding).toBeUndefined();
			}
			expect(text(r.out) + text(r.err)).not.toContain(PROOF);
			expect(text(r.out) + text(r.err)).not.toContain(OTHER_PROOF);
		});
	}

	for (const sub of ["list", "listen", "status"] as const) {
		for (const [status, code, fragment] of [[404, "not-found", "not found"], [503, "session-unavailable", "authority is unavailable"]] as const) {
			test(`${sub} treats typed ${status} as terminal exit 3 without private output`, async () => {
				const r = rig();
				retain(r);
				r.reply = (call) => call.path === "/steering/sessions"
					? json({ sessions: [sessionRow(LIVE_ID)], truncated: false })
					: json({ status: "refused", error: { code, message: `${PROOF} token-for-default` } }, status);
				expect(await steer(r, sub, "--session", LIVE_ID, "--json")).toBe(EXIT_REFUSED);
				expect(r.calls.filter((call) => call.path !== "/steering/sessions")).toHaveLength(1);
				expect(r.sleeps).toEqual([]);
				expect(r.out).toEqual([]);
				expect(text(r.err)).toContain(fragment);
				expect(text(r.err)).not.toContain("predates");
				expect(text(r.err)).not.toContain(PROOF);
				expect(text(r.err)).not.toContain("token-for-default");
			});
		}
	}

	test("missing default permits unproved reads and operator close, but never heartbeat or sibling fallback", async () => {
		for (const sub of ["list", "listen", "status", "close", "heartbeat"] as const) {
			const r = rig();
			retain(r, { session_id: OTHER_LIVE_ID, session_binding: OTHER_PROOF });
			r.reply = (call) => {
				if (call.path === "/steering/sessions") return json({ sessions: [sessionRow(LIVE_ID)], truncated: false });
				if (call.path === "/steering/wait") return json({ directive: directive("d-1") });
				if (call.path === "/steering/sessions/close") return json({ status: "closed", session_id: LIVE_ID, closed_at: EXPIRES });
				if (call.path === "/session/context") return json(digest());
				return json({ directives: [] });
			};
			expect(await steer(r, sub, "--session", LIVE_ID, ...(sub === "listen" ? ["--once"] : []))).toBe(sub === "heartbeat" ? EXIT_FAILED : EXIT_DONE);
			if (sub === "heartbeat") expect(r.calls).toEqual([]);
			else expect(r.calls.length).toBeGreaterThan(0);
			for (const call of r.calls) expect(call.sessionBinding).toBeUndefined();
		}
	});

	for (const sub of ["list", "listen", "status", "heartbeat", "close"] as const) {
		test(`${sub} refuses an explicit absent, corrupt, or context-mismatched record locally`, async () => {
			for (const kind of ["missing", "corrupt", "server", "surface", "handle"] as const) {
				const r = rig();
				const path = join(defined(r.deps.bindingDirectory), "explicit.json");
				retain(r);
				if (kind === "corrupt") writeFileSync(path, `{invalid ${PROOF}`, { mode: 0o600 });
				else if (kind !== "missing") retain(r, kind === "server" ? { server_identity: serverIdentity("http://127.0.0.1:7411") } : kind === "surface" ? { surface: "omp" } : { session_id: OTHER_LIVE_ID }, path);
				expect(await steer(r, sub, "--session", LIVE_ID, "--binding-file", path)).toBe(EXIT_FAILED);
				expect(r.calls).toEqual([]);
				expect(r.out).toEqual([]);
				expect(text(r.err)).not.toContain(PROOF);
				expect(text(r.err)).toContain("missing, unsafe or mismatched");
			}
		});
	}

	test("historical context never selects or sends a live proof", async () => {
		const r = rig();
		retain(r);
		r.reply = () => json(digest());
		expect(await steer(r, "context", "--session", "historical-label", "--format", "json")).toBe(EXIT_DONE);
		expect(defined(r.calls[0]).params.session_id).toBe("historical-label");
		expect(defined(r.calls[0]).sessionBinding).toBeUndefined();
	});

	test("queue and directive-only ack stay unkeyed and never auto-attach a stored proof", async () => {
		const r = rig();
		retain(r);
		r.reply = (call) => call.path === "/steering/queue" ? json({ status: "queued", directive_id: "d-1" }) : json({ status: "acknowledged", directive_id: "d-1", outcome: "applied" });
		expect(await steer(r, "queue", "--session", LIVE_ID, "--action", "pause", "--body", "x")).toBe(EXIT_DONE);
		expect(await steer(r, "ack", "d-1", "--applied", "--confirm")).toBe(EXIT_DONE);
		expect(defined(r.calls[0]).body).toEqual({ session_id: LIVE_ID, action: "pause", body: "x" });
		expect(defined(r.calls[1]).body).toEqual({ directive_id: "d-1", outcome: "applied", confirm: true });
		for (const call of r.calls) expect(call.sessionBinding).toBeUndefined();
	});
});

describe("forget removes a local record without the server", () => {
	test("removes only the named record, contacts no server and prints no proof", async () => {
		const r = rig();
		const path = retain(r);
		const sibling = retain(r, { session_id: OTHER_LIVE_ID, session_binding: OTHER_PROOF });
		const siblingBefore = readFileSync(sibling, "utf8");
		expect(await steer(r, "forget", LIVE_ID)).toBe(EXIT_DONE);
		expect(existsSync(path)).toBe(false);
		expect(readFileSync(sibling, "utf8")).toBe(siblingBefore);
		expect(r.calls).toEqual([]);
		expect(text(r.out)).toContain(LIVE_ID);
		expect(text(r.out) + text(r.err)).not.toContain(PROOF);
	});

	test("--json names the handle, and --binding-file selects the record it removes", async () => {
		const r = rig();
		const chosen = join(defined(r.deps.bindingDirectory), "chosen.json");
		retain(r, {}, chosen);
		expect(await steer(r, "forget", LIVE_ID, "--binding-file", chosen, "--json")).toBe(EXIT_DONE);
		expect(existsSync(chosen)).toBe(false);
		expect(JSON.parse(text(r.out))).toEqual({ session_id: LIVE_ID, forgotten: true });
		expect(r.calls).toEqual([]);
	});

	test("a missing or mismatched record is refused locally and nothing is removed", async () => {
		const r = rig();
		expect(await steer(r, "forget", LIVE_ID)).toBe(EXIT_FAILED);
		expect(text(r.err)).toContain("nothing was removed");
		const other = join(defined(r.deps.bindingDirectory), "other.json");
		retain(r, { session_id: OTHER_LIVE_ID, session_binding: OTHER_PROOF }, other);
		const before = readFileSync(other, "utf8");
		expect(await steer(r, "forget", LIVE_ID, "--binding-file", other)).toBe(EXIT_FAILED);
		expect(readFileSync(other, "utf8")).toBe(before);
		expect(r.calls).toEqual([]);
		expect(text(r.out) + text(r.err)).not.toContain(PROOF);
	});

	test("takes no proof flag on argv", async () => {
		const r = rig();
		expect(await steer(r, "forget", LIVE_ID, "--proof", PROOF)).toBe(EXIT_USAGE);
		expect(r.calls).toEqual([]);
		expect(text(r.out) + text(r.err)).not.toContain(PROOF);
	});
});

describe("lifecycle console failures are credential-free", () => {
	for (const sub of ["open", "heartbeat", "close"] as const) {
		for (const asJson of [false, true]) {
			test(`${sub} sanitizes malformed/error bodies and transport exceptions (${asJson ? "json" : "text"})`, async () => {
				const sensitive = `${PROOF} Bearer token-for-default`;
				const replies: Array<() => Reply> = [
					() => json({ status: "issued", session_binding: PROOF, error: sensitive }),
					() => new Response(sensitive),
					() => json({ error: sensitive }, 500),
					() => json({ status: "refused", error: { code: sensitive, message: sensitive } }, 403),
					() => new TypeError(sensitive),
				];
				for (const reply of replies) {
					const r = rig();
					if (sub !== "open") retain(r);
					r.reply = reply;
					expect(await steer(r, sub, ...(sub === "open" ? [] : ["--session", LIVE_ID]), ...(asJson ? ["--json"] : []))).not.toBe(EXIT_DONE);
					expect(r.out).toEqual([]);
					expect(text(r.err)).not.toContain(PROOF);
					expect(text(r.err)).not.toContain("token-for-default");
					expect(r.err.length).toBeGreaterThan(0);
				}
			});
		}
	}
});

describe("operator write replies omit credential-bearing extras", () => {
	for (const sub of ["queue", "ack"] as const) {
		for (const success of [false, true]) {
			test(`${sub} ${success ? "success" : "refusal"} never prints untrusted response extras`, async () => {
				const r = rig();
				const sensitive = `${PROOF} Bearer token-for-default`;
				r.reply = () => json(success
					? { status: sub === "queue" ? "queued" : "acknowledged", directive_id: "d-1", ...(sub === "ack" ? { outcome: "applied" } : {}), session_binding: PROOF, extra: sensitive }
					: { status: "refused", error: { code: "rate-limited", message: sensitive }, reason: sensitive, extra: sensitive });
				const args = sub === "queue" ? ["queue", "--session", LIVE_ID, "--action", "pause", "--body", "x"] : ["ack", "d-1", "--applied"];
				expect(await steer(r, ...args, "--json")).toBe(success ? EXIT_DONE : EXIT_REFUSED);
				expect(text(r.out) + text(r.err)).not.toContain(PROOF);
				expect(text(r.out) + text(r.err)).not.toContain("token-for-default");
				expect(text(r.out)).not.toContain("session_binding");
				expect(text(r.out)).not.toContain("extra");
			});
		}
	}
});

describe("binding selection cannot manufacture authority", () => {
	test("proof-like joined flags are rejected without echoing their argv value", async () => {
		for (const flag of ["--session-binding", "--binding-proof", "--proof"]) {
			const r = rig();
			expect(await steer(r, "list", "--session", LIVE_ID, `${flag}=${PROOF}`)).toBe(EXIT_USAGE);
			expect(r.calls).toEqual([]);
			expect(text(r.out) + text(r.err)).not.toContain(PROOF);
		}
	});

	test("an expired local timestamp is advisory: heartbeat sends the retained proof to the authority", async () => {
		const r = rig();
		const path = retain(r, { expires_at: "2025-01-01T00:00:00.000Z" });
		r.reply = () => json({ status: "renewed", session_id: LIVE_ID, expires_at: RENEWED_EXPIRES });
		expect(await steer(r, "heartbeat", "--session", LIVE_ID)).toBe(EXIT_DONE);
		expect(defined(r.calls[0]).sessionBinding).toBe(PROOF);
		expect(loadBindingRecord(path, recordFor(r)).expires_at).toBe(RENEWED_EXPIRES);
	});

	test("heartbeat cannot overwrite a replacement proof after renewal", async () => {
		const r = rig();
		const path = retain(r);
		r.reply = () => {
			unlinkSync(path);
			retain(r, { session_binding: OTHER_PROOF }, path);
			return json({ status: "renewed", session_id: LIVE_ID, expires_at: RENEWED_EXPIRES });
		};
		expect(await steer(r, "heartbeat", "--session", LIVE_ID)).toBe(EXIT_FAILED);
		expect(loadBindingRecord(path, recordFor(r))).toEqual(recordFor(r, { session_binding: OTHER_PROOF }));
		expect(r.out).toEqual([]);
		expect(text(r.err)).toContain("renewed on server, but local expiry could not be saved");
	});

	test("a surface name is never substituted for missing proof on an ordinary owner's refused read", async () => {
		const r = rig();
		retain(r, { surface: "omp", session_id: OTHER_LIVE_ID, session_binding: OTHER_PROOF });
		r.reply = () => json({ status: "refused", error: { code: "not-found" } }, 404);
		expect(await steer(r, "list", "--session", LIVE_ID, "--surface", "omp")).toBe(EXIT_REFUSED);
		expect(defined(r.calls[0]).authorization).toBe("Bearer token-for-omp");
		expect(defined(r.calls[0]).sessionBinding).toBeUndefined();
		expect(r.out).toEqual([]);
		expect(text(r.err)).not.toContain("predates");
	});
});
