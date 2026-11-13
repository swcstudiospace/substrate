/**
 * `substrate docs feedback`, against a stub of the route over a real socket.
 *
 * Covers what the CLI sends (the body the route takes, the bearer), what it
 * refuses before posting (a usage error, no bearer), and how it reports the
 * route's answers and a network failure.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { FEEDBACK_USAGE, parseFeedbackArgs, runDocsFeedback, type FeedbackDeps } from "./feedback.ts";

interface Seen {
	method: string;
	path: string;
	authorization: string | null;
	contentType: string | null;
	body: unknown;
}

/** The route, as far as the CLI can tell: one scripted reply, and a record of what was posted. */
class RouteStub {
	seen: Seen[] = [];
	reply: { status: number; body: unknown } = {
		status: 200,
		body: { protocol: "corpus.v1", document: "repo:docs/a.md", verdict: "helpful", stored: true },
	};
	readonly server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const raw = await request.text();
			let body: unknown = null;
			try {
				body = raw ? JSON.parse(raw) : null;
			} catch {
				body = raw;
			}
			this.seen.push({
				method: request.method,
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
				contentType: request.headers.get("content-type"),
				body,
			});
			return new Response(typeof this.reply.body === "string" ? this.reply.body : JSON.stringify(this.reply.body), {
				status: this.reply.status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	readonly url = `http://127.0.0.1:${this.server.port}`;
}

const stub = new RouteStub();
afterAll(() => {
	stub.server.stop(true);
});

/** Run the command against the stub, capturing what it prints. */
async function run(argv: string[], overrides: Partial<FeedbackDeps> = {}): Promise<{ code: number; out: string; err: string }> {
	let out = "";
	let err = "";
	const code = await runDocsFeedback(argv, {
		url: stub.url,
		token: "test-bearer",
		timeoutMs: 5_000,
		out: (text) => {
			out += text;
		},
		err: (text) => {
			err += text;
		},
		...overrides,
	});
	return { code, out, err };
}

function resetStub(): void {
	stub.seen = [];
	stub.reply = {
		status: 200,
		body: { protocol: "corpus.v1", document: "repo:docs/a.md", verdict: "helpful", stored: true },
	};
}

describe("argument parsing", () => {
	test("reads the two positionals and the session", () => {
		expect(parseFeedbackArgs(["repo:docs/a.md", "helpful", "--session", "s-1"])).toEqual({
			ok: true,
			document: "repo:docs/a.md",
			verdict: "helpful",
			session: "s-1",
			json: false,
		});
	});

	test("a bare --json before the positionals keeps them", () => {
		expect(parseFeedbackArgs(["--json", "repo:docs/a.md", "stale"])).toEqual({
			ok: true,
			document: "repo:docs/a.md",
			verdict: "stale",
			json: true,
		});
	});

	test("a missing positional is a usage error, whichever is absent", () => {
		expect(parseFeedbackArgs([])).toMatchObject({ ok: false });
		expect(parseFeedbackArgs(["repo:docs/a.md"])).toMatchObject({ ok: false });
		expect(parseFeedbackArgs(["repo:docs/a.md", ""])).toMatchObject({ ok: false });
	});

	test("an extra positional, an unknown flag and a bare --session are usage errors", () => {
		expect(parseFeedbackArgs(["repo:docs/a.md", "helpful", "extra"])).toMatchObject({ ok: false });
		expect(parseFeedbackArgs(["repo:docs/a.md", "helpful", "--verbose"])).toMatchObject({ ok: false });
		expect(parseFeedbackArgs(["repo:docs/a.md", "helpful", "--session"])).toMatchObject({ ok: false });
		expect(parseFeedbackArgs(["repo:docs/a.md", "helpful", "--session", "--json"])).toMatchObject({ ok: false });
	});

	test("--help is recognised", () => {
		expect(parseFeedbackArgs(["--help"])).toEqual({ ok: "help" });
	});
});

describe("usage errors exit 2 before anything is posted", () => {
	test("a missing positional prints the usage on stderr and posts nothing", async () => {
		resetStub();
		const result = await run(["repo:docs/a.md"]);
		expect(result.code).toBe(2);
		expect(result.err).toContain(FEEDBACK_USAGE);
		expect(result.out).toBe("");
		expect(stub.seen).toHaveLength(0);
	});

	test("--help prints the usage on stdout and exits 0", async () => {
		resetStub();
		const result = await run(["--help"]);
		expect(result.code).toBe(0);
		expect(result.out).toBe(FEEDBACK_USAGE);
		expect(stub.seen).toHaveLength(0);
	});
});

describe("the request", () => {
	test("posts the body the route takes, with session_id, under the bearer", async () => {
		resetStub();
		const result = await run(["repo:docs/a.md", "helpful", "--session", "s-1"]);
		expect(result.code).toBe(0);
		expect(stub.seen).toHaveLength(1);
		const [request] = stub.seen;
		expect(request?.method).toBe("POST");
		expect(request?.path).toBe("/docs/feedback");
		expect(request?.authorization).toBe("Bearer test-bearer");
		expect(request?.contentType).toBe("application/json");
		expect(request?.body).toEqual({ document: "repo:docs/a.md", verdict: "helpful", session_id: "s-1" });
	});

	test("omits session_id when no session is given", async () => {
		resetStub();
		await run(["repo:docs/a.md", "wrong"]);
		const [request] = stub.seen;
		expect(request?.body).toEqual({ document: "repo:docs/a.md", verdict: "wrong" });
		expect(request?.body).not.toHaveProperty("session_id");
	});

	test("passes the verdict through unchanged, leaving the closed set to the server", async () => {
		resetStub();
		stub.reply = { status: 400, body: { error: "bad verdict", reason: "invalid-verdict" } };
		const result = await run(["repo:docs/a.md", "bogus"]);
		expect(stub.seen[0]?.body).toMatchObject({ verdict: "bogus" });
		expect(result.code).toBe(1);
	});

	test("with no bearer nothing is posted and the exit is 1", async () => {
		resetStub();
		const result = await run(["repo:docs/a.md", "helpful"], { token: undefined });
		expect(result.code).toBe(1);
		expect(result.err).toContain("no bearer is configured");
		expect(stub.seen).toHaveLength(0);
	});
});

describe("the answer", () => {
	test("a 2xx prints the server's body and exits 0", async () => {
		resetStub();
		const result = await run(["repo:docs/a.md", "helpful"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.out)).toEqual({ protocol: "corpus.v1", document: "repo:docs/a.md", verdict: "helpful", stored: true });
		expect(result.err).toBe("");
	});

	test("--json prints the body on one line", async () => {
		resetStub();
		const result = await run(["--json", "repo:docs/a.md", "helpful"]);
		expect(result.code).toBe(0);
		expect(result.out.trimEnd().split("\n")).toHaveLength(1);
		expect(JSON.parse(result.out)).toMatchObject({ stored: true });
	});

	test("a refusal exits 1 and prints the server's reason on stderr", async () => {
		resetStub();
		stub.reply = {
			status: 404,
			body: { error: "that document is not in the corpus", reason: "unknown-document", detail: "repo:docs/gone.md" },
		};
		const result = await run(["repo:docs/gone.md", "stale"]);
		expect(result.code).toBe(1);
		expect(result.out).toBe("");
		expect(result.err).toContain("HTTP 404 unknown-document");
		expect(result.err).toContain("repo:docs/gone.md");
	});

	test("an unauthorised answer exits 1 and names the 401 reason", async () => {
		resetStub();
		stub.reply = { status: 401, body: { error: "anonymous callers are refused", reason: "unauthenticated" } };
		const result = await run(["repo:docs/a.md", "helpful"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("HTTP 401 unauthenticated");
	});

	test("a non-JSON failure quotes a bounded part of the text", async () => {
		resetStub();
		stub.reply = { status: 502, body: "upstream gone" };
		const result = await run(["repo:docs/a.md", "helpful"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("HTTP 502: upstream gone");
	});

	test("a network failure exits 1", async () => {
		const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
		const url = `http://127.0.0.1:${closed.port}`;
		closed.stop(true);
		const result = await run(["repo:docs/a.md", "helpful"], { url });
		expect(result.code).toBe(1);
		expect(result.err).toContain("the server did not answer");
	});

	test("a bearer in a network error is not printed", async () => {
		resetStub();
		const token = "substrate-bearer-XYZ123";
		const result = await run(["repo:docs/a.md", "helpful"], {
			token,
			fetchImpl: Object.assign(
				async (): Promise<Response> => {
					throw new TypeError(`connection reset while sending Bearer ${token}`);
				},
				{ preconnect: () => undefined },
			),
		});
		expect(result.code).toBe(1);
		expect(result.err).toContain("the server did not answer");
		expect(result.err).not.toContain(token);
		expect(result.err).toContain("[REDACTED]");
	});

	test("a bearer the server echoes in a refusal is not printed, even where the text is cut", async () => {
		resetStub();
		const token = "substrate-bearer-XYZ123";
		stub.reply = { status: 500, body: `${"x".repeat(490)}${token}` };
		const result = await run(["repo:docs/a.md", "helpful"], { token });
		expect(result.code).toBe(1);
		// The cut at 500 characters used to leave this prefix of the token on the terminal.
		expect(result.err).not.toContain(token.slice(0, 10));
		expect(result.err).toContain("[REDACTED]");
	});

	test("a bearer the server echoes in a JSON refusal is not printed", async () => {
		resetStub();
		const token = "substrate-bearer-XYZ123";
		stub.reply = { status: 401, body: { error: `token ${token} was rejected`, reason: "unauthenticated" } };
		const result = await run(["repo:docs/a.md", "helpful"], { token });
		expect(result.code).toBe(1);
		expect(result.err).not.toContain(token);
		expect(result.err).toContain("HTTP 401 unauthenticated");
	});

	test("the server's reason, error and detail are each bounded", async () => {
		resetStub();
		stub.reply = { status: 422, body: { reason: "r".repeat(2_000), error: "e".repeat(2_000), detail: "d".repeat(2_000) } };
		const result = await run(["repo:docs/a.md", "helpful"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain(`HTTP 422 ${"r".repeat(500)}`);
		expect(result.err).not.toContain("r".repeat(501));
		expect(result.err).not.toContain("e".repeat(501));
		expect(result.err).not.toContain("d".repeat(501));
	});
});
