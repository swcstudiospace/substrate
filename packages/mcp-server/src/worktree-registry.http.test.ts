/**
 * The worktree registry over its two doors: `POST /worktrees/report` and `GET /worktrees` on a real socket, and the
 * `worktree_list` tool through a real MCP client. The store is the in-memory adapter the store contract proves equal to the
 * SQL, so these tests are about what the routes decide: who may report, when nothing is read, audited or stored, what is
 * refused, and what an accepted report leaves behind.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";
import type { SubstrateEvent } from "./types.ts";
import { MemoryWorktreeRegistry } from "./worktree-registry-fake.ts";
import { WORKTREE_REPORT_MAX_BYTES } from "./worktree-registry.ts";

const JSON_HEADERS = { "content-type": "application/json" };
const TOKENS = { SUBSTRATE_TOKEN_CLAUDE_CODE: "tok-agent", SUBSTRATE_TOKEN_CURSOR: "tok-cursor" };
const ON = { SUBSTRATE_WORKTREE_REGISTRY: "on", ...TOKENS };

interface Harness {
	base: string;
	observability: Observability;
	store: MemoryWorktreeRegistry;
	written: SubstrateEvent[];
	substrate: Substrate;
}

const running: Array<{ close(): void }> = [];

/** A ledger stub that records the events appended, so a test can read back the note a report leaves. */
function ledger() {
	const written: SubstrateEvent[] = [];
	return {
		written,
		greptime: {
			ensureAppendMode: async () => true,
			lastHash: async (): Promise<string | null> => null,
			insertEvent: async (event: SubstrateEvent) => {
				written.push(event);
			},
			queryEvents: async () => [],
			readEvents: async () => [],
			graphIngest: async () => [],
			firstIngestMs: async () => null,
		},
	};
}

async function start(env: Record<string, string | undefined>, options: { store?: MemoryWorktreeRegistry | null } = {}): Promise<Harness> {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const store = options.store === null ? null : (options.store ?? new MemoryWorktreeRegistry());
	const { written, greptime } = ledger();
	const substrate = new Substrate(config, { index: null, greptime: greptime as never, worktrees: store }, observability.observer);
	const server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	running.push({
		close() {
			observability.stop();
			server.close();
		},
	});
	return { base: `http://127.0.0.1:${port}`, observability, store: store ?? new MemoryWorktreeRegistry(), written, substrate };
}

afterAll(() => {
	for (const entry of running) entry.close();
});

function worktree(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		path: "/work/a",
		repo: "swcstudiospace/agent-substrate",
		branch: "feature/a",
		head: "0123456789abcdef0123456789abcdef01234567",
		base: "origin/main",
		dirty: false,
		ahead: 1,
		behind: 0,
		last_commit_at: "2026-10-28T08:00:00Z",
		size_bytes: 2048,
		locked: false,
		primary: false,
		pr_state: "none",
		...overrides,
	};
}

function body(items: unknown[] = [worktree()], overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { protocol: 1, host: "host-a", reported_at: "2026-10-29T09:00:00Z", worktrees: items, ...overrides };
}

async function post(harness: Harness, token: string | null, payload: unknown, headers: Record<string, string> = JSON_HEADERS) {
	const response = await fetch(`${harness.base}/worktrees/report`, {
		method: "POST",
		headers: { ...headers, ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
		body: typeof payload === "string" ? payload : JSON.stringify(payload),
	});
	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function list(harness: Harness, query = "", token: string | null = "tok-agent") {
	const response = await fetch(`${harness.base}/worktrees${query}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** A path whose parent is a regular file: impossible to create, whoever is running. */
function unwritablePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "substrate-worktrees-"));
	writeFileSync(join(directory, "not-a-directory"), "");
	return join(directory, "not-a-directory", "mcp-audit.jsonl");
}

describe("with the registry off (the default)", () => {
	test("a report is 503 worktrees.disabled before the body is read: nothing stored, nothing audited", async () => {
		const harness = await start(TOKENS);
		// Over the cap on purpose: a refusal that read the body first would answer 413.
		const reply = await post(harness, "tok-agent", "x".repeat(WORKTREE_REPORT_MAX_BYTES + 1));
		expect(reply).toEqual({ status: 503, json: { error: "worktrees.disabled" } });
		expect((await post(harness, "tok-agent", body())).status).toBe(503);
		expect(harness.store.reports).toBe(0);
		expect(harness.observability.audit.recent()).toEqual([]);
	});

	test("the listing and the tool answer the same refusal", async () => {
		const harness = await start(TOKENS);
		expect(await list(harness)).toEqual({ status: 503, json: { error: "worktrees.disabled" } });

		const server = createMcpServer(harness.substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const result = await client.callTool({ name: "worktree_list", arguments: {} });
		const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
		expect({ isError: result.isError, body: JSON.parse(text) }).toEqual({ isError: true, body: { error: "worktrees.disabled" } });
	});

	test("anything but on is off", async () => {
		const harness = await start({ ...TOKENS, SUBSTRATE_WORKTREE_REGISTRY: "true" });
		expect((await post(harness, "tok-agent", body())).status).toBe(503);
		expect(harness.store.reports).toBe(0);
	});
});

describe("POST /worktrees/report: who may report", () => {
	test("an anonymous caller is 401 before the body is read, even on a run that allows anonymous callers", async () => {
		const bridge = await start({ ...ON, SUBSTRATE_ALLOW_ANONYMOUS: "1" });
		const oversize = await post(bridge, null, "x".repeat(WORKTREE_REPORT_MAX_BYTES + 1));
		expect(oversize.status).toBe(401);
		expect(String(oversize.json.error)).toContain("authenticated surface");
		expect((await post(bridge, null, body())).status).toBe(401);
		expect(bridge.store.reports).toBe(0);
		expect(bridge.observability.audit.recent()).toEqual([]);
	});

	test("a run that does not allow anonymous callers refuses a missing or an unknown bearer", async () => {
		const harness = await start(ON);
		expect((await post(harness, null, body())).status).toBe(401);
		expect((await post(harness, "tok-nobody", body())).status).toBe(401);
		expect(harness.store.reports).toBe(0);
	});

	test("a VM guest is 403 and stores nothing", async () => {
		const harness = await start({ ...ON, SUBSTRATE_VM_GUEST: "1" });
		expect(await post(harness, "tok-agent", body())).toEqual({ status: 403, json: { error: "worktrees.vm-guest" } });
		expect(harness.store.reports).toBe(0);
	});

	test("a server with no index is 503 worktrees.unavailable", async () => {
		const harness = await start(ON, { store: null });
		const reply = await post(harness, "tok-agent", body());
		expect(reply.status).toBe(503);
		expect(reply.json.error).toBe("worktrees.unavailable");
	});

	test("a body that is not application/json is 415", async () => {
		const harness = await start(ON);
		expect((await post(harness, "tok-agent", body(), { "content-type": "text/plain" })).status).toBe(415);
		expect(harness.store.reports).toBe(0);
	});
});

describe("POST /worktrees/report: what is refused", () => {
	test("a malformed field is 400 worktrees.invalid naming it, and nothing is audited or stored", async () => {
		const harness = await start(ON);
		const reply = await post(harness, "tok-agent", body([worktree(), worktree({ path: "/work/b", head: "nothex" })]));
		expect(reply.status).toBe(400);
		expect(reply.json).toEqual({ error: "worktrees.invalid", problem: "worktrees[1].head must be 40 or 64 hex characters" });
		expect(harness.store.reports).toBe(0);
		expect(harness.observability.audit.recent()).toEqual([]);
	});

	test("a body that is not JSON is 400", async () => {
		const harness = await start(ON);
		const reply = await post(harness, "tok-agent", "{not json");
		expect(reply).toEqual({ status: 400, json: { error: "request body is not valid JSON" } });
		expect(harness.store.reports).toBe(0);
	});

	test("a body over 1,000,000 bytes is 413 and stores nothing", async () => {
		const harness = await start(ON);
		const reply = await post(harness, "tok-agent", "x".repeat(WORKTREE_REPORT_MAX_BYTES + 1));
		expect(reply.status).toBe(413);
		expect(harness.store.reports).toBe(0);
	});

	test("a chain that cannot take the audit record refuses the report: 503, nothing stored, while the listing is still served", async () => {
		const harness = await start({ ...ON, SUBSTRATE_AUDIT_PATH: unwritablePath() });
		expect((await post(harness, "tok-agent", body())).status).toBe(503);
		expect(harness.store.reports).toBe(0);
		expect((await list(harness)).status).toBe(200);
	});
});

describe("an accepted report", () => {
	test("is stored, audited as worktree_report, answered with the counts, and leaves one counts-only note", async () => {
		const harness = await start(ON);
		const reply = await post(harness, "tok-agent", body([worktree(), worktree({ path: "/work/b", dirty: true })]));

		expect(reply).toEqual({ status: 200, json: { stored: 2, removed: 0 } });
		expect(harness.observability.audit.recent()[0]).toMatchObject({ tool: "worktree_report", transport: "rest", decision: "allowed" });
		const note = defined(harness.written[0], "the report note");
		expect(harness.written).toHaveLength(1);
		expect(note).toMatchObject({ kind: "note", surface: "claude-code", payload: { action: "worktrees.report", stored: 2, removed: 0 } });
		expect(Object.keys(note.payload).sort()).toEqual(["action", "removed", "stored"]);
		expect(JSON.stringify(note)).not.toContain("/work/");
	});

	test("carries the changed files: stored sorted with a hostile path dropped, never returned by the listing, and more than 200 paths is a 400 that stores nothing", async () => {
		const harness = await start(ON);
		const reply = await post(harness, "tok-agent", body([worktree({ session_id: "sess-9", files: ["b.ts", "a.ts", "bad\nname.ts"], files_truncated: false }), worktree({ path: "/work/b", files: null })]));
		expect(reply).toEqual({ status: 200, json: { stored: 2, removed: 0 } });

		const rows = await harness.store.candidates({ repo: "swcstudiospace/agent-substrate", limit: 10 });
		expect(rows.map((row) => [row.path, row.files])).toEqual([
			["/work/a", ["a.ts", "b.ts"]],
			["/work/b", null],
		]);
		const listed = (await list(harness)).json.worktrees as Array<Record<string, unknown>>;
		expect(listed.some((row) => "files" in row)).toBe(false);

		const tooMany = await post(harness, "tok-agent", body([worktree({ files: Array.from({ length: 201 }, (_, index) => `f${index}.ts`) })]));
		expect(tooMany.status).toBe(400);
		expect(tooMany.json).toMatchObject({ error: "worktrees.invalid" });
		expect(harness.store.reports).toBe(1);
	});

	test("reads back through GET /worktrees with the host and the first and last seen stamps", async () => {
		const harness = await start(ON);
		await post(harness, "tok-agent", body([worktree({ session_id: "sess-9", graph_id: "graph-9" }), worktree({ path: "/work/b", dirty: true, pr_state: "merged" })]));

		const reply = await list(harness, "?repo=swcstudiospace/agent-substrate");
		expect(reply.status).toBe(200);
		expect(reply.json.truncated).toBe(false);
		const rows = reply.json.worktrees as Array<Record<string, unknown>>;
		expect(rows.map((row) => row.path)).toEqual(["/work/a", "/work/b"]);
		expect(rows[0]).toMatchObject({
			host: "host-a",
			repo: "swcstudiospace/agent-substrate",
			branch: "feature/a",
			head: "0123456789abcdef0123456789abcdef01234567",
			base: "origin/main",
			dirty: false,
			ahead: 1,
			behind: 0,
			last_commit_at: "2026-10-28T08:00:00.000Z",
			size_bytes: 2048,
			locked: false,
			primary: false,
			pr_state: "none",
			session_id: "sess-9",
			graph_id: "graph-9",
		});
		expect(typeof rows[0]?.first_seen_at).toBe("string");
		expect(rows[0]?.first_seen_at).toBe(rows[0]?.last_seen_at);
		expect(rows[1]).toMatchObject({ dirty: true, pr_state: "merged" });
	});

	test("a second host's report is a separate set of rows, and the host filter tells them apart", async () => {
		const harness = await start(ON);
		await post(harness, "tok-agent", body([worktree()], { host: "host-a" }));
		await post(harness, "tok-cursor", body([worktree({ path: "/work/other" })], { host: "host-b" }));

		const both = (await list(harness)).json.worktrees as Array<Record<string, unknown>>;
		expect(both.map((row) => [row.host, row.path]).sort()).toEqual([
			["host-a", "/work/a"],
			["host-b", "/work/other"],
		]);
		const onlyB = (await list(harness, "?host=host-b")).json.worktrees as Array<Record<string, unknown>>;
		expect(onlyB.map((row) => row.path)).toEqual(["/work/other"]);
	});

	test("the state filter keeps dirty worktrees, and stale ones past the idle window", async () => {
		const harness = await start({ ...ON, SUBSTRATE_WORKTREE_IDLE_DAYS: "14" });
		const now = Date.now();
		const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
		await post(
			harness,
			"tok-agent",
			body([
				worktree({ path: "/work/fresh", last_commit_at: ago(1) }),
				worktree({ path: "/work/old", last_commit_at: ago(30) }),
				worktree({ path: "/work/dirty", dirty: true, last_commit_at: ago(2) }),
			]),
		);

		const paths = async (state: string) => ((await list(harness, `?state=${state}`)).json.worktrees as Array<Record<string, unknown>>).map((row) => row.path);
		expect(await paths("dirty")).toEqual(["/work/dirty"]);
		expect(await paths("stale")).toEqual(["/work/old"]);
		expect((await paths("all")).sort()).toEqual(["/work/dirty", "/work/fresh", "/work/old"]);
	});

	test("a listing past its limit says it was cut", async () => {
		const harness = await start(ON);
		await post(harness, "tok-agent", body([worktree({ path: "/work/a" }), worktree({ path: "/work/b" }), worktree({ path: "/work/c" })]));

		const cut = await list(harness, "?limit=2");
		expect((cut.json.worktrees as unknown[]).length).toBe(2);
		expect(cut.json.truncated).toBe(true);
		const whole = await list(harness, "?limit=3");
		expect((whole.json.worktrees as unknown[]).length).toBe(3);
		expect(whole.json.truncated).toBe(false);
	});

	test("an invalid listing filter is 400 worktrees.invalid, and nothing is audited", async () => {
		const harness = await start(ON);
		for (const query of ["?state=merged", "?limit=501", "?limit=0", "?limit=lots", "?repo=nonsense", "?host=a/b"]) {
			const reply = await list(harness, query);
			expect({ query, status: reply.status, error: reply.json.error }).toEqual({ query, status: 400, error: "worktrees.invalid" });
		}
		expect(harness.observability.audit.recent()).toEqual([]);
	});

	test("the listing is audited as worktree_list", async () => {
		const harness = await start(ON);
		await list(harness, "?state=dirty");
		expect(harness.observability.audit.recent()[0]).toMatchObject({ tool: "worktree_list", transport: "rest", decision: "allowed" });
	});
});

describe("the worktree_list tool", () => {
	test("returns the same rows and the same refusal of a bad filter as the route", async () => {
		const harness = await start(ON);
		await post(harness, "tok-agent", body([worktree(), worktree({ path: "/work/b", dirty: true })]));

		const server = createMcpServer(harness.substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const tools = (await client.listTools()).tools;
		expect(tools.find((tool) => tool.name === "worktree_list")?.annotations?.readOnlyHint).toBe(true);

		const reply = await client.callTool({ name: "worktree_list", arguments: { state: "dirty" } });
		const text = (reply.content as Array<{ text?: string }>)[0]?.text ?? "";
		const parsed = JSON.parse(text) as { worktrees: Array<Record<string, unknown>>; truncated: boolean };
		expect(reply.isError).not.toBe(true);
		expect(parsed.worktrees.map((row) => row.path)).toEqual(["/work/b"]);
		expect(parsed.truncated).toBe(false);

		const bad = await client.callTool({ name: "worktree_list", arguments: { repo: "nonsense" } });
		expect(bad.isError).toBe(true);
		expect(JSON.parse((bad.content as Array<{ text?: string }>)[0]?.text ?? "")).toMatchObject({ error: "worktrees.invalid" });
	});
});
