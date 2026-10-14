import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "../../mcp-server/src/types.ts";
import { GLOBAL_SUBSCRIPTIONS as GLOBAL, HerdrCollector, resolveSocketPath } from "./herdr.ts";
import type { HerdrPane } from "./herdr-map.ts";

interface Conn {
	socket: Socket;
	subs: unknown[][];
	destroyed: boolean;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("socket resolution", () => {
	test("session wins, then the env, then the default under HOME or /root", () => {
		expect(resolveSocketPath(["--session", "proof"], { HOME: "/home/a", HERDR_SOCKET_PATH: "/tmp/x.sock" })).toBe(
			"/home/a/.config/herdr/sessions/proof/herdr.sock",
		);
		expect(resolveSocketPath([], { HOME: "/home/a", HERDR_SOCKET_PATH: "/tmp/x.sock", HERDR_SESSION: "named" })).toBe("/tmp/x.sock");
		expect(resolveSocketPath([], { HOME: "/home/a", HERDR_SESSION: "named" })).toBe("/home/a/.config/herdr/sessions/named/herdr.sock");
		expect(resolveSocketPath([], {})).toBe("/root/.config/herdr/herdr.sock");
		expect(resolveSocketPath(["--once", "--watch"], { HOME: "/home/a" })).toBe("/home/a/.config/herdr/herdr.sock");
	});
});

describe("transport", () => {
	let server: Server | undefined;
	let collector: HerdrCollector | undefined;
	const conns: Conn[] = [];
	let panes: HerdrPane[] = [];
	let snapshots = 0;

	afterEach(() => {
		collector?.stop();
		collector = undefined;
		server?.close();
		server = undefined;
		for (const conn of conns) conn.socket.destroy();
		conns.length = 0;
		panes = [];
		snapshots = 0;
	});

	async function listen(): Promise<string> {
		const dir = mkdtempSync(join(tmpdir(), "herdr-sock-"));
		const socketPath = join(dir, "herdr.sock");
		server = createServer((socket) => {
			const conn: Conn = { socket, subs: [], destroyed: false };
			conns.push(conn);
			socket.on("close", () => {
				conn.destroyed = true;
			});
			let buf = "";
			socket.on("data", (chunk) => {
				buf += chunk.toString("utf8");
				let idx = buf.indexOf("\n");
				while (idx >= 0) {
					const line = buf.slice(0, idx);
					buf = buf.slice(idx + 1);
					idx = buf.indexOf("\n");
					if (!line.trim()) continue;
					const msg = JSON.parse(line) as { id?: string; method?: string; params?: { subscriptions?: unknown[] } };
					if (msg.method === "session.snapshot") {
						snapshots += 1;
						socket.write(`${JSON.stringify({ id: msg.id, result: { type: "session_snapshot", snapshot: { panes } } })}\n`);
						socket.end();
						return;
					}
					if (msg.method === "events.subscribe") {
						const subscriptions = msg.params?.subscriptions ?? [];
						conn.subs.push(subscriptions);
						const bad = subscriptions.some((entry) => {
							const paneId = (entry as { pane_id?: string }).pane_id;
							return paneId === "w999:p999";
						});
						if (bad) {
							socket.write(
								`${JSON.stringify({ id: `${msg.id}:sub:0:probe`, error: { code: "pane_not_found", message: "pane w999:p999 not found" } })}\n`,
							);
							socket.destroy();
							return;
						}
						socket.write(`${JSON.stringify({ id: msg.id, result: { type: "subscription_started" } })}\n`);
					}
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server?.once("error", reject);
			server?.listen(socketPath, resolve);
		});
		return socketPath;
	}

	test("one subscribe per connection, and a bad pane closes only itself", async () => {
		const socketPath = await listen();
		const dir = mkdtempSync(join(tmpdir(), "herdr-state-"));
		panes = [
			{ pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "working", cwd: "/tmp/repo" },
			{ pane_id: "w999:p999", terminal_id: "term_bad", agent: "omp", agent_status: "idle" },
		];
		collector = new HerdrCollector({
			socketPath,
			statePath: join(dir, "herdr-offsets.json"),
			debounceMs: 20,
			post: async () => ({ kind: "stored" }),
			attribute: () => ({ repo: "swcstudiospace/agent-substrate", branch: "main" }),
			now: () => "2026-10-09T00:00:00.000Z",
		});
		await collector.runPass();
		await wait(80);
		const subscribed = conns.filter((conn) => conn.subs.length > 0);
		expect(subscribed.length).toBeGreaterThanOrEqual(3);
		for (const conn of conns) expect(conn.subs.length).toBeLessThanOrEqual(1);
		const global = subscribed.find((conn) => JSON.stringify(conn.subs[0]).includes("pane.created"));
		expect(global?.subs[0]).toEqual([...GLOBAL]);
		const panesSubs = subscribed.filter((conn) => conn !== global);
		for (const conn of panesSubs) {
			const first = conn.subs[0]?.[0] as { type?: string; pane_id?: string };
			expect(first?.type).toBe("pane.agent_status_changed");
			expect(JSON.stringify(conn.subs)).not.toContain("output_matched");
		}
		const bad = panesSubs.find((conn) => JSON.stringify(conn.subs).includes("w999:p999"));
		const good = panesSubs.find((conn) => JSON.stringify(conn.subs).includes("w1:p1"));
		expect(bad?.destroyed).toBe(true);
		expect(good?.destroyed).toBe(false);
		expect(global?.destroyed).toBe(false);
	});

	test("two near-simultaneous pushes yield one session.start", async () => {
		const socketPath = await listen();
		const dir = mkdtempSync(join(tmpdir(), "herdr-state-"));
		const posted: EventInput[] = [];
		collector = new HerdrCollector({
			socketPath,
			statePath: join(dir, "herdr-offsets.json"),
			debounceMs: 40,
			post: async (event) => {
				posted.push(event);
				return { kind: "stored" };
			},
			attribute: () => ({ repo: "swcstudiospace/agent-substrate", branch: "main" }),
			now: () => "2026-10-09T00:00:00.000Z",
		});
		panes = [];
		await collector.runPass();
		await wait(50);
		const global = conns.find((conn) => conn.subs.length === 1 && JSON.stringify(conn.subs[0]).includes("pane.agent_detected"));
		expect(global).toBeDefined();
		const before = snapshots;
		panes = [{ pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "working", cwd: "/tmp/repo" }];
		const push = `${JSON.stringify({ event: "pane_agent_detected", data: { agent: "omp", pane_id: "w1:p1", type: "pane_agent_detected" } })}\n`;
		global?.socket.write(push);
		global?.socket.write(push);
		await wait(120);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.kind).toBe("session.start");
		expect(posted[0]?.surface).toBe("omp");
		expect(posted[0]?.repo).toBe("swcstudiospace/agent-substrate");
		expect(posted[0]?.payload).toMatchObject({ runtime: "herdr", herdr_type: "pane.agent_detected" });
		expect(snapshots - before).toBe(1);
	});

	test("startWatch runs the first pass through the single-flight pump", async () => {
		const socketPath = await listen();
		const dir = mkdtempSync(join(tmpdir(), "herdr-state-"));
		let active = 0;
		let maxActive = 0;
		let entered = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const posted: EventInput[] = [];
		collector = new HerdrCollector({
			socketPath,
			statePath: join(dir, "herdr-offsets.json"),
			debounceMs: 10,
			post: async (event) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				entered += 1;
				try {
					if (entered === 1) await gate;
					posted.push(event);
				} finally {
					active -= 1;
				}
				return { kind: "stored" };
			},
			attribute: () => ({ repo: "swcstudiospace/agent-substrate", branch: "main" }),
			now: () => "2026-10-09T00:00:00.000Z",
		});
		panes = [{ pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "working", cwd: "/tmp/repo" }];
		await collector.runPass();
		expect(entered).toBe(0);
		panes = [{ pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "idle", cwd: "/tmp/repo" }];
		collector.startWatch();
		await wait(60);
		panes = [{ pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "working", cwd: "/tmp/repo" }];
		collector.markDirty();
		await wait(40);
		release();
		await collector.flush();
		expect(entered).toBe(2);
		expect(maxActive).toBe(1);
		expect(posted.map((event) => event.kind)).toEqual(["note", "note"]);
	});

	test("failed posts are journalled with a counter summary", async () => {
		const socketPath = await listen();
		const dir = mkdtempSync(join(tmpdir(), "herdr-state-"));
		const lines: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			lines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			collector = new HerdrCollector({
				socketPath,
				statePath: join(dir, "herdr-offsets.json"),
				post: async () => ({ kind: "failed", error: "boom" }),
				attribute: () => ({ repo: "swcstudiospace/agent-substrate", branch: "main" }),
				now: () => "2026-10-09T00:00:00.000Z",
			});
			panes = [{ pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "working", cwd: "/tmp/repo" }];
			await collector.runPass();
			panes = [{ pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "idle", cwd: "/tmp/repo" }];
			const result = await collector.runPass();
			expect(result.failed).toBe(1);
			expect(lines.some((line) => line.includes("emit failed"))).toBe(true);
		} finally {
			process.stderr.write = original;
		}
	});
});
