import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import {
	createTrackerProxy,
	linearStateChange,
	MAX_BODY_BYTES,
	notionTerminalWrite,
	StdioBridge,
	startTrackerProxy,
	type Tracker,
	type TrackerChild,
	TRACKERS,
} from "./mcp-proxy.ts";

/** A fake `ultrathink-mcp serve <tracker>` child: records written lines, replies on demand. */
class FakeChild implements TrackerChild {
	lines: string[] = [];
	killed = false;
	private lineCb: ((line: string) => void) | null = null;
	private exitCb: (() => void) | null = null;
	private waiters: Array<{ count: number; resolve: () => void }> = [];
	constructor(public tracker: Tracker) {}
	write(line: string): void {
		this.lines.push(line);
		this.waiters = this.waiters.filter((w) => {
			if (this.lines.length < w.count) return true;
			w.resolve();
			return false;
		});
	}
	onLine(cb: (line: string) => void): void {
		this.lineCb = cb;
	}
	onExit(cb: () => void): void {
		this.exitCb = cb;
	}
	kill(): void {
		this.killed = true;
	}
	/** Resolves once at least `count` lines have been written (the proxy's write is the awaited signal). */
	written(count: number): Promise<void> {
		if (this.lines.length >= count) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push({ count, resolve }));
	}
	/** Emit a reply line as the real child would (one JSON-RPC message per line). */
	reply(message: unknown): void {
		this.lineCb?.(JSON.stringify(message));
	}
	exit(): void {
		this.exitCb?.();
	}
}

type Reply = { status: number; text: string; json: unknown; type: string | null };

type Harness = {
	server: Server;
	children: FakeChild[];
	spawned: Tracker[];
	logs: string[];
	/** Resolves with the child at `index` once it has been spawned. */
	child(index: number): Promise<FakeChild>;
	post(path: string, body: unknown, init?: { method?: string; raw?: string }): Promise<Reply>;
};

const open: Server[] = [];

async function harness(opts: { timeoutMs?: number } = {}): Promise<Harness> {
	const children: FakeChild[] = [];
	const spawned: Tracker[] = [];
	const logs: string[] = [];
	let spawnWaiters: Array<{ index: number; resolve: (child: FakeChild) => void }> = [];
	const server = createTrackerProxy({
		spawn: (tracker) => {
			const child = new FakeChild(tracker);
			children.push(child);
			spawned.push(tracker);
			spawnWaiters = spawnWaiters.filter((w) => {
				const ready = children[w.index];
				if (!ready) return true;
				w.resolve(ready);
				return false;
			});
			return child;
		},
		log: (line) => logs.push(line),
		timeoutMs: opts.timeoutMs,
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	open.push(server);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const base = `http://127.0.0.1:${port}`;
	return {
		server,
		children,
		spawned,
		logs,
		child: (index) => {
			const ready = children[index];
			if (ready) return Promise.resolve(ready);
			return new Promise((resolve) => spawnWaiters.push({ index, resolve }));
		},
		post: async (path, body, init = {}) => {
			const response = await fetch(`${base}${path}`, {
				method: init.method ?? "POST",
				headers: { "content-type": "application/json" },
				body: init.method && init.method !== "POST" ? undefined : (init.raw ?? JSON.stringify(body)),
			});
			const text = await response.text();
			let json: unknown = null;
			try {
				json = JSON.parse(text);
			} catch {}
			return { status: response.status, text, json, type: response.headers.get("content-type") };
		},
	};
}

afterEach(async () => {
	for (const server of open.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("tracker proxy routing", () => {
	test("POST /mcp/notion forwards the message as one line and returns the child's reply for that id only", async () => {
		const h = await harness();
		const pending = h.post("/mcp/notion", LIST);
		const child = await h.child(0);
		await child.written(1);
		expect(h.spawned).toEqual(["notion"]);
		expect(child.lines).toEqual([JSON.stringify(LIST)]);
		expect(child.lines[0]).not.toContain("\n");
		child.reply({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "wrong" }] } });
		child.reply({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "ignored" } });
		child.reply({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "notion-search" }] } });
		const r = await pending;
		expect(r.status).toBe(200);
		expect(r.type).toBe("application/json");
		expect(r.json).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "notion-search" }] } });
	});

	test("a notification (no id) is forwarded and answered 202 with an empty body", async () => {
		const h = await harness();
		const r = await h.post("/mcp/linear", { jsonrpc: "2.0", method: "notifications/initialized" });
		expect(r.status).toBe(202);
		expect(r.text).toBe("");
		expect(h.spawned).toEqual(["linear"]);
		expect((await h.child(0)).lines).toEqual([JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })]);
	});

	test("unknown tracker 404, GET/DELETE 405, array body 400, malformed JSON 400 (-32700), oversized body 413", async () => {
		const h = await harness();
		expect((await h.post("/mcp/other", LIST)).status).toBe(404);
		expect((await h.post("/mcp", LIST)).status).toBe(404);
		expect((await h.post("/mcp/notion", LIST, { method: "GET" })).status).toBe(405);
		expect((await h.post("/mcp/notion", LIST, { method: "DELETE" })).status).toBe(405);
		expect((await h.post("/mcp/notion", [LIST])).status).toBe(400);
		const bad = await h.post("/mcp/notion", null, { raw: "{not json" });
		expect(bad.status).toBe(400);
		expect((bad.json as { error: { code: number } }).error.code).toBe(-32700);
		const big = await h.post("/mcp/notion", null, { raw: `{"jsonrpc":"2.0","id":1,"method":"x","params":{"p":"${"a".repeat(MAX_BODY_BYTES)}"}}` });
		expect(big.status).toBe(413);
		expect(h.spawned).toEqual([]);
	});
});

describe("linearStateChange (Phase 2 D-06/D-07)", () => {
	test("true for state, stateId or statusId at any depth including arrays; false otherwise", () => {
		expect(linearStateChange({ id: "SWC-1", state: "Done" })).toBe(true);
		expect(linearStateChange({ id: "SWC-1", stateId: "uuid" })).toBe(true);
		expect(linearStateChange({ input: { issue: { statusId: "uuid" } } })).toBe(true);
		expect(linearStateChange({ issues: [{ id: "a" }, { id: "b", state: "Done" }] })).toBe(true);
		expect(linearStateChange({ batch: [[{ stateId: 1 }]] })).toBe(true);
		expect(linearStateChange({ id: "SWC-1", title: "x", description: "state: Done" })).toBe(false);
		expect(linearStateChange({ id: "SWC-1", links: [{ url: "https://x", title: "PR #1" }] })).toBe(false);
		expect(linearStateChange({ State: "Done" })).toBe(false);
		expect(linearStateChange(undefined)).toBe(false);
		expect(linearStateChange("state")).toBe(false);
		expect(linearStateChange(null)).toBe(false);
	});

	test("a Linear tools/call with a state key is refused (-32001, names graph_complete and the DoD gate) and never written; the same on /mcp/notion is forwarded", async () => {
		const h = await harness();
		const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "save_issue", arguments: { id: "SWC-0", state: "Done" } } };
		const r = await h.post("/mcp/linear", call);
		expect(r.status).toBe(200);
		const reply = r.json as { id: number; error: { code: number; message: string } };
		expect(reply.id).toBe(7);
		expect(reply.error.code).toBe(-32001);
		expect(reply.error.message).toContain("graph_complete");
		expect(reply.error.message).toMatch(/DoD gate/);
		expect(h.spawned).toEqual([]);
		expect(h.logs).toContain("[substrate-host] tracker mcp refused linear state change save_issue");

		const pending = h.post("/mcp/notion", call);
		const child = await h.child(0);
		await child.written(1);
		expect(h.spawned).toEqual(["notion"]);
		expect(child.lines).toEqual([JSON.stringify(call)]);
		child.reply({ jsonrpc: "2.0", id: 7, result: { content: [] } });
		expect((await pending).status).toBe(200);
	});
});

describe("notionTerminalWrite (03-07: sync moves no Notion Status)", () => {
	test("true for Completed / date:Completed:* keys and terminal Status values at any depth, including JSON strings", () => {
		expect(notionTerminalWrite({ properties: { Completed: "2026-09-25" } })).toBe(true);
		expect(notionTerminalWrite({ properties: { "date:Completed:start": "2026-09-25" } })).toBe(true);
		expect(notionTerminalWrite({ properties: { "date:Completed:end": null } })).toBe(true);
		expect(notionTerminalWrite({ data: { command: "update_properties", properties: { Status: "Done" } } })).toBe(true);
		expect(notionTerminalWrite({ properties: { Status: "merged" } })).toBe(true);
		expect(notionTerminalWrite({ properties: { Status: "FAILED" } })).toBe(true);
		expect(notionTerminalWrite({ properties: { Status: "Blocked" } })).toBe(true);
		expect(notionTerminalWrite({ properties: { Status: { name: "Done" } } })).toBe(true);
		expect(notionTerminalWrite({ properties: { Status: { status: { name: "Merged" } } } })).toBe(true);
		expect(notionTerminalWrite({ pages: [{ properties: { Status: "Done" } }] })).toBe(true);
		expect(notionTerminalWrite({ properties: JSON.stringify({ Status: "Done" }) })).toBe(true);
		expect(notionTerminalWrite({ data: { properties: JSON.stringify({ nested: [{ Completed: true }] }) } })).toBe(true);
	});

	test("false for Status Implementing and the PR fields sync owns", () => {
		expect(notionTerminalWrite({ data: { command: "update_properties", properties: { Status: "Implementing" } } })).toBe(false);
		expect(notionTerminalWrite({ properties: { Status: { name: "Implementing" } } })).toBe(false);
		expect(notionTerminalWrite({ properties: { "PR URL": "https://github.com/x/y/pull/1", "PR #": 1, "PR State": "Open", Repo: "x/y", Branch: "substrate/g" } })).toBe(false);
		expect(notionTerminalWrite({ properties: { "PR State": "Merged" } })).toBe(false);
		expect(notionTerminalWrite({ properties: { Summary: "Done with the work" } })).toBe(false);
		expect(notionTerminalWrite({ properties: { Status: "Done?" } })).toBe(false);
		expect(notionTerminalWrite(undefined)).toBe(false);
		expect(notionTerminalWrite("Completed")).toBe(false);
	});

	test("a Notion tools/call setting Status Done is refused (-32001) and never written; Status Implementing is forwarded", async () => {
		const h = await harness();
		const done = {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "notion-update-page",
				arguments: { data: { page_id: "00000000000000000000000000000000", command: "update_properties", properties: { Status: "Done" } } },
			},
		};
		const r = await h.post("/mcp/notion", done);
		expect(r.status).toBe(200);
		const reply = r.json as { id: number; error: { code: number; message: string } };
		expect(reply.id).toBe(3);
		expect(reply.error.code).toBe(-32001);
		expect(reply.error.message).toContain("graph_complete");
		expect(reply.error.message).toMatch(/DoD gate/);
		expect(h.spawned).toEqual([]);
		expect(h.logs).toContain("[substrate-host] tracker mcp refused notion status change notion-update-page");

		const implementing = { ...done, id: 4, params: { ...done.params, arguments: { data: { page_id: "0", command: "update_properties", properties: { Status: "Implementing" } } } } };
		const pending = h.post("/mcp/notion", implementing);
		const child = await h.child(0);
		await child.written(1);
		expect(h.spawned).toEqual(["notion"]);
		child.reply({ jsonrpc: "2.0", id: 4, result: { content: [] } });
		expect((await pending).status).toBe(200);
	});
});

describe("StdioBridge child lifecycle", () => {
	test("spawns lazily once per tracker, respawns after exit, and answers 504 on timeout", async () => {
		// The 504 path exercises the bridge's real timer; 60 ms keeps it short without faking time.
		const h = await harness({ timeoutMs: 60 });
		expect(h.spawned).toEqual([]);
		const first = h.post("/mcp/notion", { ...LIST, id: 10 });
		const second = h.post("/mcp/notion", { ...LIST, id: 11 });
		const child = await h.child(0);
		await child.written(2);
		expect(h.spawned).toEqual(["notion"]);
		child.reply({ jsonrpc: "2.0", id: 10, result: {} });
		child.reply({ jsonrpc: "2.0", id: 11, result: {} });
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);

		const timedOut = await h.post("/mcp/notion", { ...LIST, id: 12 });
		expect(timedOut.status).toBe(504);
		expect(h.spawned).toEqual(["notion"]);

		child.exit();
		const afterExit = h.post("/mcp/notion", { ...LIST, id: 13 });
		const respawned = await h.child(1);
		await respawned.written(1);
		expect(h.spawned).toEqual(["notion", "notion"]);
		expect(respawned.lines).toEqual([JSON.stringify({ ...LIST, id: 13 })]);
		respawned.reply({ jsonrpc: "2.0", id: 13, result: { ok: true } });
		expect((await afterExit).status).toBe(200);
		expect(child.lines).toHaveLength(3);
	});

	test("a request in flight when the child exits is answered 502", async () => {
		const h = await harness();
		const pending = h.post("/mcp/linear", { ...LIST, id: 20 });
		const child = await h.child(0);
		await child.written(1);
		child.exit();
		expect((await pending).status).toBe(502);
	});

	test("colliding ids from two clients are both answered with their own reply", async () => {
		const h = await harness();
		const a = h.post("/mcp/notion", { jsonrpc: "2.0", id: 1, method: "ping" });
		const child = await h.child(0);
		await child.written(1);
		const b = h.post("/mcp/notion", { jsonrpc: "2.0", id: 1, method: "tools/list" });
		await child.written(2);
		const ids = child.lines.map((l) => (JSON.parse(l) as { id: unknown }).id);
		expect(ids[0]).toBe(1);
		expect(ids[1]).not.toBe(1);
		child.reply({ jsonrpc: "2.0", id: ids[1], result: { tools: [] } });
		child.reply({ jsonrpc: "2.0", id: 1, result: {} });
		expect((await a).json).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
		expect((await b).json).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
	});

	test("StdioBridge.close kills every child", async () => {
		const spawned: FakeChild[] = [];
		const bridge = new StdioBridge({
			spawn: (tracker) => {
				const child = new FakeChild(tracker);
				const original = child.write.bind(child);
				child.write = (line) => {
					original(line);
					child.reply({ jsonrpc: "2.0", id: (JSON.parse(line) as { id: unknown }).id, result: {} });
				};
				spawned.push(child);
				return child;
			},
			log: () => {},
		});
		expect(TRACKERS).toEqual(["notion", "linear"]);
		await bridge.request("notion", { jsonrpc: "2.0", id: 1, method: "ping" });
		await bridge.request("linear", { jsonrpc: "2.0", id: 1, method: "ping" });
		bridge.close();
		expect(spawned.map((c) => c.killed)).toEqual([true, true]);
	});
});

describe("log lines", () => {
	test("every line is `[substrate-host] tracker mcp <tracker> <method>` (+ tool name) and never carries params, replies or stderr", async () => {
		const h = await harness();
		const secretish = "lin_api_SECRETVALUE1234567890abcdef";
		const call = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_issues", arguments: { query: secretish } } };
		const pending = h.post("/mcp/linear", call);
		const child = await h.child(0);
		await child.written(1);
		child.reply({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: `REPLY ${secretish}` }] } });
		await pending;
		await h.post("/mcp/linear", { jsonrpc: "2.0", method: "notifications/initialized" });
		expect(h.logs).toEqual([
			"[substrate-host] tracker mcp linear tools/call list_issues",
			"[substrate-host] tracker mcp linear notifications/initialized",
		]);
		for (const line of h.logs) {
			expect(line).toMatch(/^\[substrate-host\] tracker mcp (notion|linear) \S+( \S+)?$/);
			expect(line).not.toContain(secretish);
			expect(line).not.toContain("REPLY");
		}
	});
});

describe("startTrackerProxy", () => {
	test("listens on 127.0.0.1:7412 only (injected listen)", () => {
		const calls: Array<{ port: number; host: string }> = [];
		const server = startTrackerProxy({
			spawn: (tracker) => new FakeChild(tracker),
			log: () => {},
			listen: (_srv, port, host, cb) => {
				calls.push({ port, host });
				cb();
			},
		});
		expect(calls).toEqual([{ port: 7412, host: "127.0.0.1" }]);
		server.close();
	});
});
