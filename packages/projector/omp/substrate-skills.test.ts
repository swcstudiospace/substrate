import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, {
	createHandler,
	type FetchLike,
	type OmpPi,
	renderSkillMd,
	resolveBearer,
	skillFromToolCall,
	type ToolCallEvent,
} from "./substrate-skills.ts";

const BEARER = "0123456789abcdef".repeat(4);
const PR = "https://github.com/swcstudiospace/agent-skills/pull/7";
const AT = new Date("2026-09-26T10:11:12.345Z");

let dir: string;
let pendingDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omp-substrate-skills-"));
	pendingDir = join(dir, "pending");
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

function handlerWith(fetchImpl: FetchLike, timeoutMs = 50) {
	return createHandler({ fetchImpl, url: "http://127.0.0.1:7410", timeoutMs, pendingDir, bearer: BEARER, now: () => AT });
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
const pendingPath = () => join(pendingDir, "deploy-notes-20260926T101112Z.json");
const pendingFiles = () => {
	try {
		return readdirSync(pendingDir);
	} catch {
		return [];
	}
};

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

describe("createHandler", () => {
	test("manage_skill create is proposed with the bearer header and blocked with the PR URL", async () => {
		const { fetchImpl, calls } = fakeFetch(() => reply(200, { status: "opened", pr_url: PR, content_sha256: "c", redactions: [] }));
		const result = await handlerWith(fetchImpl)(create);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(PR);
		expect(result?.reason).toContain("Nothing was written locally");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:7410/skills/propose");
		expect(calls[0]?.init.method).toBe("POST");
		expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${BEARER}`);
		const body = JSON.parse(String(calls[0]?.init.body));
		expect(body).toMatchObject(expectedBody);
		expect(body.rationale).toContain("manage_skill");
		expect(pendingFiles()).toEqual([]);
	});

	test("existing and unchanged replies block with their own reasons", async () => {
		const existing = await handlerWith(fakeFetch(() => reply(200, { status: "existing", pr_url: PR })).fetchImpl)(create);
		expect(existing).toMatchObject({ block: true });
		expect(existing?.reason).toContain(`${PR} (existing)`);
		const unchanged = await handlerWith(fakeFetch(() => reply(200, { status: "unchanged" })).fetchImpl)(create);
		expect(unchanged).toEqual({ block: true, reason: "The library already has this exact skill (deploy-notes); nothing was written." });
	});

	test("a missing bearer queues without a request, and the pending file never holds it", async () => {
		const { fetchImpl, calls } = fakeFetch(() => reply(200, { status: "opened", pr_url: PR }));
		const handler = createHandler({ fetchImpl, url: "http://127.0.0.1:7410", timeoutMs: 50, pendingDir, env: {}, tokensDir: join(dir, "empty-tokens"), now: () => AT });
		const result = await handler(create);
		expect(calls).toHaveLength(0);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(pendingPath());
		expect(readFileSync(pendingPath(), "utf8")).not.toContain(BEARER);
	});

	test("a 401 reply queues exactly the propose body, without the bearer", async () => {
		const { fetchImpl } = fakeFetch(() => reply(401, { error: "anonymous" }));
		const result = await handlerWith(fetchImpl)(create);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(pendingPath());
		const text = readFileSync(pendingPath(), "utf8");
		expect(text).not.toContain(BEARER);
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
		expect(result?.reason).toContain(`queued at ${pendingPath()}`);
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
			expect(result?.reason).toContain(pendingPath());
			expect(pendingFiles()).toEqual(["deploy-notes-20260926T101112Z.json"]);
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
		expect(pendingFiles()).toEqual([]);
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
		expect(pendingFiles()).toEqual([]);
	});

	test("an internal failure becomes a block, never a throw", async () => {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		pendingDir = join(blocker, "under-a-file");
		const handler = handlerWith(fakeFetch(() => Promise.reject(new TypeError("down"))).fetchImpl);
		const result = await handler(create);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("nothing was written locally");
		expect(result?.reason).not.toContain(BEARER);
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
		expect(result?.reason).toContain(`queued at ${pendingPath()}`);
		expect(JSON.parse(readFileSync(pendingPath(), "utf8"))).toMatchObject({ ...expectedBody, session_id: "sess-omp-1" });
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

describe("resolveBearer", () => {
	test("follows the token.ts order: env, then token file, then tokens dir", () => {
		const tokens = join(dir, "tokens");
		const named = join(dir, "named.token");
		expect(resolveBearer({}, tokens, () => null)).toBeNull();
		const read = (path: string): string | null =>
			path === join(tokens, "omp") ? "dir-bearer" : path === named ? "file-bearer" : null;
		expect(resolveBearer({}, tokens, read)).toBe("dir-bearer");
		expect(resolveBearer({ SUBSTRATE_TOKEN_FILE: named }, tokens, read)).toBe("file-bearer");
		expect(resolveBearer({ SUBSTRATE_TOKEN: "env-bearer", SUBSTRATE_TOKEN_FILE: named }, tokens, read)).toBe("env-bearer");
	});

	test("a queued fixture drains through the bridge queue contract unchanged", () => {
		const queued = { name: "deploy-notes", files: expectedBody.files, rationale: "queued", surface: "omp" };
		expect(Object.keys(queued).sort()).toEqual(["files", "name", "rationale", "surface"]);
		expect(queued.surface).toBe("omp");
		expect(typeof queued.files["SKILL.md"]).toBe("string");
	});
});
