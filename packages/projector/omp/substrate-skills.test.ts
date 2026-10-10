import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import register, {
	createHandler,
	writeAllSync,
	type FetchLike,
	type OmpPi,
	renderSkillMd,
	resolveOmpToken,
	skillFromToolCall,
	type ToolCallEvent,
} from "./substrate-skills.ts";

const KEY = "0123456789abcdef".repeat(4);
const FILE_KEY = "fedcba9876543210".repeat(4);
const PR = "https://github.com/swcstudiospace/agent-skills/pull/7";
const AT = new Date("2026-09-26T10:11:12.345Z");

let dir: string;
let tokensDir: string;
let pendingDir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omp-substrate-skills-"));
	tokensDir = join(dir, "tokens");
	mkdirSync(tokensDir, { recursive: true });
	writeFileSync(join(tokensDir, "omp"), `${KEY}\n`, { mode: 0o600 });
	pendingDir = join(dir, "pending");
	env = { SUBSTRATE_TOKENS_DIR: tokensDir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Call {
	url: string;
	init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Promise<Response> | Response): { fetchImpl: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		fetchImpl: async (url, init) => {
			const call = { url, init };
			calls.push(call);
			return respond(call);
		},
	};
}

function reply(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function handlerWith(fetchImpl: FetchLike, timeoutMs = 50, envOverride?: Record<string, string | undefined>) {
	return createHandler({ fetchImpl, url: "http://127.0.0.1:7410", timeoutMs, pendingDir, env: envOverride ?? env, now: () => AT });
}

function event(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolCallId: "call-1", toolName, input };
}

const create = event("manage_skill", { action: "create", name: "deploy-notes", description: "How to deploy", body: "1. Build\n2. Ship" });
const expectedBody = {
	name: "deploy-notes",
	files: { "SKILL.md": "---\nname: deploy-notes\ndescription: How to deploy\n---\n\n1. Build\n2. Ship\n" },
	surface: "omp",
};
const pendingPrefix = "deploy-notes-20260926T101112Z-";
const pendingMatch = () => {
	try {
		return readdirSync(pendingDir).filter((f) => f.startsWith(pendingPrefix) && f.endsWith(".json"));
	} catch {
		return [];
	}
};
const pendingPath = () => join(pendingDir, pendingMatch()[0] as string);

describe("skillFromToolCall", () => {
	test("manage_skill create/update are skill writes; delete, learn without skill and other tools are not", () => {
		expect(skillFromToolCall(create)).toEqual({ kind: "manage_skill", action: "create", name: "deploy-notes", description: "How to deploy", body: "1. Build\n2. Ship" });
		expect(skillFromToolCall(event("manage_skill", { action: "update", name: "a", description: "d", body: "b" }))?.action).toBe("update");
		expect(skillFromToolCall(event("manage_skill", { action: "delete", name: "a" }))).toBeNull();
		expect(skillFromToolCall(event("learn", { memory: "m", skill: { action: "create", name: "a", description: "d", body: "b" } }))).toEqual({
			kind: "learn",
			action: "create",
			name: "a",
			description: "d",
			body: "b",
		});
		expect(skillFromToolCall(event("learn", { memory: "m" }))).toBeNull();
		expect(skillFromToolCall(event("write", { path: "x", content: "y" }))).toBeNull();
	});
});

describe("renderSkillMd", () => {
	test("synthesizes frontmatter over a frontmatter-less Omp body", () => {
		expect(renderSkillMd({ name: "x", description: "d", body: "Step 1" })).toBe("---\nname: x\ndescription: d\n---\n\nStep 1\n");
	});

	test("descriptions YAML would misread are quoted and parse back unchanged", () => {
		for (const description of ["Use when: deploying", "line one\nline two", "# not a comment", "true", "42", 'say "hi" \\ back', "trailing "]) {
			const md = renderSkillMd({ name: "x", description, body: "b" });
			const front = md.split("---\n")[1] ?? "";
			expect(Bun.YAML.parse(front)).toEqual({ name: "x", description });
		}
	});
});

describe("resolveOmpToken", () => {
	test("order is SUBSTRATE_TOKEN, then the token-file variable, then <tokens dir>/omp", () => {
		const fileToken = join(dir, "file-token");
		writeFileSync(fileToken, `${FILE_KEY}\n`, { mode: 0o600 });
		expect(resolveOmpToken({ SUBSTRATE_TOKEN: KEY, SUBSTRATE_TOKEN_FILE: fileToken, SUBSTRATE_TOKENS_DIR: tokensDir })).toBe(KEY);
		expect(resolveOmpToken({ SUBSTRATE_TOKEN_FILE: fileToken, SUBSTRATE_TOKENS_DIR: tokensDir })).toBe(FILE_KEY);
		expect(resolveOmpToken({ SUBSTRATE_TOKENS_DIR: tokensDir })).toBe(KEY);
	});

	test("missing everything means no token; blank values are skipped", () => {
		expect(resolveOmpToken({ SUBSTRATE_TOKENS_DIR: join(dir, "absent") })).toBeNull();
		expect(resolveOmpToken({ SUBSTRATE_TOKEN: "  ", SUBSTRATE_TOKEN_FILE: "  ", SUBSTRATE_TOKENS_DIR: join(dir, "absent") })).toBeNull();
		expect(resolveOmpToken({})).toBeNull();
	});

	test("an unreadable token file is no token, never a throw", () => {
		expect(resolveOmpToken({ SUBSTRATE_TOKENS_DIR: tokensDir }, () => {
			throw new Error("disk gone");
		})).toBeNull();
	});
});

describe("createHandler", () => {
	test("manage_skill create is proposed with the bearer header and blocked with the PR URL", async () => {
		const { fetchImpl, calls } = fakeFetch(() => reply(200, { status: "opened", pr_url: PR, content_sha256: "c", redactions: [] }));
		const result = await handlerWith(fetchImpl)(create);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(PR);
		expect(result?.reason).toContain("Nothing was written locally");
		expect(result?.reason).not.toContain(KEY);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:7410/skills/propose");
		expect(calls[0]?.init.method).toBe("POST");
		expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
		expect("x-substrate-propose-key" in ((calls[0]?.init.headers as Record<string, string>) ?? {})).toBe(false);
		const body = JSON.parse(String(calls[0]?.init.body));
		expect(body).toMatchObject(expectedBody);
		expect(body.rationale).toContain("manage_skill");
		expect(pendingMatch()).toEqual([]);
	});

	test("existing and unchanged replies block with their own reasons", async () => {
		const existing = await handlerWith(fakeFetch(() => reply(200, { status: "existing", pr_url: PR })).fetchImpl)(create);
		expect(existing).toMatchObject({ block: true });
		expect(existing?.reason).toContain(`${PR} (existing)`);
		const unchanged = await handlerWith(fakeFetch(() => reply(200, { status: "unchanged" })).fetchImpl)(create);
		expect(unchanged).toEqual({ block: true, reason: "The library already has this exact skill (deploy-notes); nothing was written." });
	});

	test("a short write is retried until every byte is on disk", () => {
		const path = join(dir, "partial.json");
		const fd = openSync(path, "wx", 0o600);
		const text = `${JSON.stringify({ name: "deploy-notes", surface: "omp" })}\n`;
		try {
			writeAllSync(fd, text, (handle, buffer, offset, length) => writeSync(handle, buffer, offset, Math.min(3, length)));
		} finally {
			closeSync(fd);
		}
		expect(readFileSync(path, "utf8")).toBe(text);
	});

	test("a missing token queues without a request, and the pending file never holds the token", async () => {
		const empty = join(dir, "empty-tokens");
		mkdirSync(empty, { recursive: true });
		const { fetchImpl, calls } = fakeFetch(() => reply(200, { status: "opened", pr_url: PR }));
		const result = await handlerWith(fetchImpl, 50, { SUBSTRATE_TOKENS_DIR: empty })(create);
		expect(calls).toHaveLength(0);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(pendingPrefix);
		expect(result?.reason).not.toContain(KEY);
		expect(pendingMatch()).toHaveLength(1);
		expect(readFileSync(pendingPath(), "utf8")).not.toContain(KEY);
	});

	test("a 401 reply queues exactly the propose body, without the token", async () => {
		const { fetchImpl } = fakeFetch(() => reply(401, { error: "unknown surface" }));
		const result = await handlerWith(fetchImpl)(create);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(pendingPrefix);
		expect(pendingMatch()).toHaveLength(1);
		const text = readFileSync(pendingPath(), "utf8");
		expect(text).not.toContain(KEY);
		expect(JSON.parse(text)).toMatchObject(expectedBody);
	});

	test("a 403 reply queues exactly the propose body, without the token", async () => {
		const { fetchImpl, calls } = fakeFetch(() => reply(403, { error: "surface mismatch" }));
		const result = await handlerWith(fetchImpl)(create);
		expect(calls).toHaveLength(1);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(pendingPrefix);
		expect(pendingMatch()).toHaveLength(1);
		const text = readFileSync(pendingPath(), "utf8");
		expect(text).not.toContain(KEY);
		expect(JSON.parse(text)).toMatchObject(expectedBody);
	});

	test("learn with a skill keeps the lesson, drops the skill and names the PR in additionalContext", async () => {
		const input = { memory: "lesson", context: "ctx", skill: { action: "create", name: "deploy-notes", description: "How to deploy", body: "1. Build\n2. Ship" } };
		const { fetchImpl, calls } = fakeFetch(() => reply(200, { status: "opened", pr_url: PR }));
		const result = await handlerWith(fetchImpl)(event("learn", input));
		expect(result?.block).toBeUndefined();
		expect(result?.input).toEqual({ memory: "lesson", context: "ctx" });
		expect(typeof result?.additionalContext).toBe("string");
		expect(result?.additionalContext).toContain(PR);
		expect(JSON.parse(String(calls[0]?.init.body)).rationale).toContain("learn");
	});

	test("a fetch that never resolves is aborted at the timeout and queued 0600 with exactly the propose body", async () => {
		const { fetchImpl } = fakeFetch(
			({ init }) =>
				new Promise<Response>((_, reject) => {
					init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		);
		const started = performance.now();
		const result = await handlerWith(fetchImpl, 50)(create);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(`queued at ${pendingDir}/`);
		expect(result?.reason).toContain(pendingPrefix);
		const queued = JSON.parse(readFileSync(pendingPath(), "utf8"));
		expect(Object.keys(queued).sort()).toEqual(["files", "name", "rationale", "surface"]);
		expect(queued).toMatchObject(expectedBody);
		expect(statSync(pendingPath()).mode & 0o777).toBe(0o600);
		expect(statSync(pendingDir).mode & 0o777).toBe(0o700);
	});

	test("a rejected fetch and a 502 reply queue the same way", async () => {
		for (const respond of [
			() => Promise.reject(new TypeError("connection refused")),
			() => reply(502, { error: "git push failed" }),
		]) {
			rmSync(pendingDir, { recursive: true, force: true });
			const result = await handlerWith(fakeFetch(respond).fetchImpl)(create);
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain(pendingPrefix);
			expect(pendingMatch()).toHaveLength(1);
		}
	});

	test("400, 413 and declined are final: blocked with the reason, nothing queued", async () => {
		const bad = await handlerWith(fakeFetch(() => reply(400, { error: "SKILL.md: secret finding (github)" })).fetchImpl)(create);
		expect(bad?.block).toBe(true);
		expect(bad?.reason).toContain("SKILL.md: secret finding (github)");
		const big = await handlerWith(fakeFetch(() => reply(413, { error: "body over 1000000 bytes" })).fetchImpl)(create);
		expect(big?.block).toBe(true);
		expect(big?.reason).toContain("too large for the propose route");
		const closed = "https://github.com/swcstudiospace/agent-skills/pull/3";
		const declined = await handlerWith(fakeFetch(() => reply(200, { status: "declined", pr_url: closed })).fetchImpl)(create);
		expect(declined?.block).toBe(true);
		expect(declined?.reason).toContain(`closed an identical proposal (${closed})`);
		expect(pendingMatch()).toEqual([]);
	});

	test("an invalid name is blocked without a request; delete and other tools pass through", async () => {
		const { fetchImpl, calls } = fakeFetch(() => reply(200, { status: "opened", pr_url: PR }));
		const handler = handlerWith(fetchImpl);
		const bad = await handler(event("manage_skill", { action: "create", name: "Bad Name", description: "d", body: "b" }));
		expect(bad?.block).toBe(true);
		expect(bad?.reason).toContain("invalid skill name");
		expect(await handler(event("manage_skill", { action: "delete", name: "deploy-notes" }))).toBeUndefined();
		expect(await handler(event("bash", { command: "ls" }))).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(pendingMatch()).toEqual([]);
	});

	test("an internal failure becomes a block, never a throw", async () => {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		const stuck = join(blocker, "under-a-file");
		const handler = createHandler({ fetchImpl: fakeFetch(() => Promise.reject(new TypeError("down"))).fetchImpl, url: "http://127.0.0.1:7410", timeoutMs: 50, pendingDir: stuck, env, now: () => AT });
		const result = await handler(create);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("nothing was written locally");
		expect(result?.reason).not.toContain(KEY);
	});

	test("the ctx session id is sent as session_id, rationale unchanged", async () => {
		const plain = fakeFetch(() => reply(200, { status: "opened", pr_url: PR }));
		await handlerWith(plain.fetchImpl)(create);
		const { fetchImpl, calls } = fakeFetch(() => reply(200, { status: "opened", pr_url: PR }));
		const result = await handlerWith(fetchImpl)(create, { sessionManager: { getSessionId: () => "sess-omp-1" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(PR);
		const body = JSON.parse(String(calls[0]?.init.body));
		expect(body).toMatchObject({ ...expectedBody, session_id: "sess-omp-1" });
		expect(body.rationale).toBe(JSON.parse(String(plain.calls[0]?.init.body)).rationale);
	});

	test("a queued proposal keeps the session_id in its pending file", async () => {
		const { fetchImpl } = fakeFetch(() => Promise.reject(new TypeError("connection refused")));
		const result = await handlerWith(fetchImpl)(create, { sessionManager: { getSessionId: () => "sess-omp-1" } });
		expect(result?.reason).toContain(pendingPrefix);
		expect(JSON.parse(readFileSync(pendingPath(), "utf8"))).toMatchObject({ ...expectedBody, session_id: "sess-omp-1" });
	});

	test("two proposals in the same second keep both files", async () => {
		const { fetchImpl } = fakeFetch(() => reply(401, { error: "unknown surface" }));
		const handler = handlerWith(fetchImpl);
		expect((await handler(create))?.block).toBe(true);
		expect((await handler(create))?.block).toBe(true);
		const files = pendingMatch();
		expect(files).toHaveLength(2);
		expect(new Set(files).size).toBe(2);
		for (const file of files) expect(JSON.parse(readFileSync(join(pendingDir, file), "utf8"))).toMatchObject(expectedBody);
	});

	test("a colliding pending name is retried, never overwritten", async () => {
		mkdirSync(pendingDir, { recursive: true });
		writeFileSync(join(pendingDir, `${pendingPrefix}aa.json`), "original\n");
		const hexes = ["aa", "bb"];
		const { fetchImpl } = fakeFetch(() => reply(401, { error: "unknown surface" }));
		const handler = createHandler({ fetchImpl, url: "http://127.0.0.1:7410", timeoutMs: 50, pendingDir, env, now: () => AT, randomHex: () => hexes.shift() as string });
		const result = await handler(create);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(`${pendingPrefix}bb.json`);
		expect(readFileSync(join(pendingDir, `${pendingPrefix}aa.json`), "utf8")).toBe("original\n");
		expect(pendingMatch()).toHaveLength(2);
	});

	test("learn with an invalid skill name keeps the lesson and reports in additionalContext", async () => {
		const { fetchImpl, calls } = fakeFetch(() => reply(200, { status: "opened", pr_url: PR }));
		const result = await handlerWith(fetchImpl)(
			event("learn", { memory: "lesson", skill: { action: "create", name: "Bad Name", description: "d", body: "b" } }),
		);
		expect(result?.block).toBeUndefined();
		expect(result?.input).toEqual({ memory: "lesson" });
		expect(result?.additionalContext).toContain("invalid skill name");
		expect(calls).toHaveLength(0);
	});

	test("learn survives a queue failure with the lesson intact", async () => {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		const stuck = join(blocker, "under-a-file");
		const handler = createHandler({ fetchImpl: fakeFetch(() => Promise.reject(new TypeError("down"))).fetchImpl, url: "http://127.0.0.1:7410", timeoutMs: 50, pendingDir: stuck, env, now: () => AT });
		const result = await handler(
			event("learn", { memory: "lesson", skill: { action: "create", name: "deploy-notes", description: "d", body: "b" } }),
		);
		expect(result?.block).toBeUndefined();
		expect(result?.input).toEqual({ memory: "lesson" });
		expect(result?.additionalContext).toContain("extension failed");
	});

	test("no ctx, a throwing getter or a blank id sends no session_id key and still proposes", async () => {
		const throwing = {
			sessionManager: {
				getSessionId: (): string => {
					throw new Error("no session");
				},
			},
		};
		for (const ctx of [undefined, throwing, { sessionManager: { getSessionId: () => "" } }, { sessionManager: { getSessionId: () => "  " } }]) {
			const { fetchImpl, calls } = fakeFetch(() => reply(200, { status: "opened", pr_url: PR }));
			const result = await handlerWith(fetchImpl)(create, ctx);
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain(PR);
			expect(calls).toHaveLength(1);
			expect(Object.keys(JSON.parse(String(calls[0]?.init.body)))).not.toContain("session_id");
		}
	});

	test("the session id is read by calling getSessionId as a method (a #private field survives)", async () => {
		class FakeSessionManager {
			#id: string;
			constructor(id: string) {
				this.#id = id;
			}
			getSessionId(): string {
				return this.#id;
			}
		}
		const { fetchImpl, calls } = fakeFetch(() => reply(200, { status: "opened", pr_url: PR }));
		await handlerWith(fetchImpl)(create, { sessionManager: new FakeSessionManager("sess-omp-private") });
		expect(JSON.parse(String(calls[0]?.init.body)).session_id).toBe("sess-omp-private");
	});
});

test("the default export registers exactly one handler, for tool_call", () => {
	const registered: string[] = [];
	const pi: OmpPi = { on: (name) => void registered.push(name) };
	register(pi);
	expect(registered).toEqual(["tool_call"]);
});
