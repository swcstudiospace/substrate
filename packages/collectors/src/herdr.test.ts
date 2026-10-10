import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "../../mcp-server/src/types.ts";
import { GLOBAL_SUBSCRIPTIONS as GLOBAL, HerdrCollector, resolveSocketPath } from "./herdr.ts";
import type { HerdrPane } from "./herdr-map.ts";
import { loadHerdrState, paneIdentity } from "./herdr-state.ts";

interface Conn {
	socket: Socket;
	subs: unknown[][];
	destroyed: boolean;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1500;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await wait(5);
	}
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

	let snapshotUnavailable = false;
	const directories: string[] = [];

	function scratchDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		directories.push(dir);
		return dir;
	}
	afterEach(async () => {
		collector?.stop();
		await collector?.flush(); // Join an in-flight pass after stopping, never drive a test transition.
		collector = undefined;
		for (const conn of conns) conn.socket.destroy();
		if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;
		conns.length = 0;
		panes = [];
		snapshots = 0;
		snapshotUnavailable = false;
		for (const dir of directories) rmSync(dir, { recursive: true, force: true });
		directories.length = 0;
	});

	async function listen(): Promise<string> {
		const dir = scratchDir("herdr-sock-");
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
						const reply = snapshotUnavailable
							? { id: msg.id, error: { code: "snapshot_unavailable", message: "test snapshot outage" } }
							: { id: msg.id, result: { type: "session_snapshot", snapshot: { panes } } };
						socket.write(`${JSON.stringify(reply)}\n`);
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
		const dir = scratchDir("herdr-state-");
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
		const dir = scratchDir("herdr-state-");
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
		const dir = scratchDir("herdr-state-");
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

	test("watch timers repair missing pushes with exactly one start, note and end", async () => {
		const socketPath = await listen();
		const statePath = join(scratchDir("herdr-state-"), "herdr-offsets.json");
		const posted: EventInput[] = [];
		const identity = paneIdentity("w1:p1", "term_a");
		const now = "2026-10-09T00:00:00.000Z";
		collector = new HerdrCollector({
			socketPath,
			statePath,
			pollMs: 25,
			debounceMs: 2,
			post: async (event) => {
				posted.push(event);
				return { kind: "stored" };
			},
			attribute: () => ({ repo: "substrate-rehearsal/timer", branch: "proof" }),
			now: () => now,
		});
		collector.startWatch();
		await waitFor("empty watch seed", () => existsSync(statePath));
		expect(posted).toEqual([]);

		// No socket writes/pushes or explicit passes after watch starts.
		panes = [{ pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "working", cwd: statePath }];
		await waitFor("timer start committed", () => loadHerdrState(statePath).state.counters.stored === 1);
		const session = loadHerdrState(statePath).state.panes[identity]?.session_id;
		expect(session).toBe(`herdr:term_a:${now}`);
		let before = snapshots;
		await waitFor("unchanged working timer passes", () => snapshots >= before + 3);
		expect(posted).toHaveLength(1);

		panes = [{ ...panes[0]!, agent_status: "idle" }];
		await waitFor("timer note committed", () => loadHerdrState(statePath).state.counters.stored === 2);
		before = snapshots;
		await waitFor("unchanged idle timer passes", () => snapshots >= before + 3);
		expect(posted).toHaveLength(2);

		panes = [];
		await waitFor("timer end committed", () => loadHerdrState(statePath).state.counters.stored === 3);
		before = snapshots;
		await waitFor("unchanged empty timer passes", () => snapshots >= before + 3);
		expect(posted).toEqual([
			{
				kind: "session.start", surface: "omp", actor: "agent", session_id: session,
				repo: "substrate-rehearsal/timer", branch: "proof",
				summary: "herdr detected omp in pane w1:p1",
				payload: { runtime: "herdr", herdr_type: "pane.agent_detected", pane_id: "w1:p1", agent: "omp", status: "working" },
			},
			{
				kind: "note", surface: "omp", actor: "agent", session_id: session,
				repo: "substrate-rehearsal/timer", branch: "proof",
				summary: "herdr: working → idle (pane w1:p1)",
				payload: { runtime: "herdr", herdr_type: "pane.agent_status_changed", pane_id: "w1:p1", agent: "omp", previous_status: "working", status: "idle" },
			},
			{
				kind: "session.end", surface: "omp", actor: "agent", session_id: session,
				repo: "substrate-rehearsal/timer", branch: "proof",
				summary: "herdr pane w1:p1 exited",
				payload: { runtime: "herdr", herdr_type: "pane.exited", pane_id: "w1:p1", agent: "omp", end_reason: "pane_gone" },
			},
		]);
		expect(loadHerdrState(statePath).state).toMatchObject({
			panes: {}, counters: { stored: 3, refused: 0, failed: 0 },
		});
		await waitFor("gone pane subscription closed", () => conns.filter((conn) => !conn.destroyed && conn.subs.length > 0).length === 1);
		collector.stop();
		await collector.flush();
		await waitFor("watch subscriptions stopped", () => conns.every((conn) => conn.destroyed));
		const stoppedSnapshots = snapshots;
		await wait(100);
		expect(snapshots).toBe(stoppedSnapshots);
		expect(posted).toHaveLength(3);
	}, 10000);

	test("timer reconnect preserves the snapshot session and serializes emissions across an outage", async () => {
		const socketPath = await listen();
		const statePath = join(scratchDir("herdr-state-"), "herdr-offsets.json");
		const posted: EventInput[] = [];
		const attempts: EventInput[] = [];
		const identity = paneIdentity("w1:p1", "term_a");
		let active = 0;
		let maxActive = 0;
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		collector = new HerdrCollector({
			socketPath, statePath, pollMs: 25, debounceMs: 2,
			post: async (event) => {
				attempts.push(event);
				active += 1;
				maxActive = Math.max(maxActive, active);
				try {
					if (event.kind === "note" && event.payload?.status === "idle") await gate;
					posted.push(event);
					return { kind: "stored" };
				} finally {
					active -= 1;
				}
			},
			attribute: () => ({ repo: "substrate-rehearsal/reconnect", branch: "proof" }),
			now: () => "2026-10-09T00:00:00.000Z",
		});
		try {
			collector.startWatch();
			await waitFor("empty watch seed", () => existsSync(statePath));
			panes = [{ pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "working", cwd: statePath }];
			await waitFor("working committed and subscriptions open", () =>
				loadHerdrState(statePath).state.counters.stored === 1 &&
				conns.filter((conn) => !conn.destroyed && conn.subs.length === 1).length === 2);
			const original = loadHerdrState(statePath).state.panes[identity];
			const subscriptions = conns.filter((conn) => conn.subs.length > 0);
			snapshotUnavailable = true;
			for (const conn of subscriptions) conn.socket.destroy();
			await waitFor("both old subscriptions severed", () => subscriptions.every((conn) => conn.destroyed));
			await waitFor("multiple timer outage failures", () => loadHerdrState(statePath).state.counters.failed >= 2);
			expect(loadHerdrState(statePath).state.panes[identity]).toEqual(original);
			expect(posted).toHaveLength(1);
			expect(conns.filter((conn) => conn.subs.length > 0)).toHaveLength(subscriptions.length);

			panes = [{ ...panes[0]!, agent_status: "idle" }];
			snapshotUnavailable = false;
			await waitFor("recovery idle emission entered", () => active === 1);
			const heldSnapshots = snapshots;
			await wait(125); // Multiple configured poll periods elapse while the post is gated.
			expect(snapshots).toBe(heldSnapshots);
			expect(attempts.map((event) => event.kind)).toEqual(["session.start", "note"]);
			expect(posted).toHaveLength(1);
			expect(loadHerdrState(statePath).state.panes[identity]).toEqual(original);

			// The queued pass must read the latest snapshot, not replay an outage/push.
			panes = [{ ...panes[0]!, agent_status: "working" }];
			release();
			await waitFor("recovery notes committed", () => loadHerdrState(statePath).state.counters.stored === 3);
			await waitFor("fresh global and pane subscriptions", () =>
				conns.filter((conn) => !conn.destroyed && conn.subs.length > 0).length === 2);
			const before = snapshots;
			await waitFor("stable recovered timer passes", () => snapshots >= before + 3);
			expect(maxActive).toBe(1);
			expect(attempts).toEqual(posted);
			expect(posted.map((event) => ({
				kind: event.kind, session_id: event.session_id, repo: event.repo, branch: event.branch,
				surface: event.surface, actor: event.actor, payload: event.payload,
			}))).toEqual([
				{
					kind: "session.start", session_id: original?.session_id, repo: "substrate-rehearsal/reconnect", branch: "proof",
					surface: "omp", actor: "agent",
					payload: { runtime: "herdr", herdr_type: "pane.agent_detected", pane_id: "w1:p1", agent: "omp", status: "working" },
				},
				{
					kind: "note", session_id: original?.session_id, repo: "substrate-rehearsal/reconnect", branch: "proof",
					surface: "omp", actor: "agent",
					payload: { runtime: "herdr", herdr_type: "pane.agent_status_changed", pane_id: "w1:p1", agent: "omp", status: "idle", previous_status: "working" },
				},
				{
					kind: "note", session_id: original?.session_id, repo: "substrate-rehearsal/reconnect", branch: "proof",
					surface: "omp", actor: "agent",
					payload: { runtime: "herdr", herdr_type: "pane.agent_status_changed", pane_id: "w1:p1", agent: "omp", status: "working", previous_status: "idle" },
				},
			]);
			for (const conn of conns) expect(conn.subs.length).toBeLessThanOrEqual(1);
			const recovered = conns.filter((conn) => !conn.destroyed && conn.subs.length > 0);
			expect(recovered.some((conn) => JSON.stringify(conn.subs[0]) === JSON.stringify([...GLOBAL]))).toBe(true);
			expect(recovered.some((conn) => JSON.stringify(conn.subs[0]) === JSON.stringify([{ type: "pane.agent_status_changed", pane_id: "w1:p1" }]))).toBe(true);
			panes = [];
			await waitFor("recovered end committed", () => loadHerdrState(statePath).state.counters.stored === 4);
			const endedAt = snapshots;
			await waitFor("stable ended timer passes", () => snapshots >= endedAt + 3);
			expect(posted.map((event) => event.kind)).toEqual(["session.start", "note", "note", "session.end"]);
			expect(posted[3]).toMatchObject({
				session_id: original?.session_id, repo: "substrate-rehearsal/reconnect", branch: "proof",
				payload: { runtime: "herdr", end_reason: "pane_gone" },
			});
			expect(loadHerdrState(statePath).state.panes).toEqual({});
		} finally {
			release();
		}
	}, 10000);

	test("a restarted watch repairs failed notes and does not retry an accountable refusal", async () => {
		const socketPath = await listen();
		const statePath = join(scratchDir("herdr-state-"), "herdr-offsets.json");
		const identity = paneIdentity("w1:p1", "term_a");
		const failed: EventInput[] = [];
		const recovered: EventInput[] = [];
		const options = {
			socketPath, statePath, pollMs: 25, debounceMs: 2,
			attribute: () => ({ repo: "substrate-rehearsal/restart", branch: "proof" }),
		};
		panes = [{ pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "working", cwd: statePath }];
		collector = new HerdrCollector({
			...options,
			now: () => "2026-10-09T00:00:00.000Z",
			post: async (event) => {
				failed.push(event);
				return { kind: "failed", error: "test ledger outage" };
			},
		});
		collector.startWatch();
		await waitFor("initial working seed", () => existsSync(statePath));
		const original = loadHerdrState(statePath).state.panes[identity];
		expect(failed).toEqual([]);
		panes = [{ ...panes[0]!, agent_status: "idle" }];
		await waitFor("failed note accounted", () => loadHerdrState(statePath).state.counters.failed >= 1);
		collector.stop();
		await collector.flush();
		await waitFor("old watch connections closed", () => conns.every((conn) => conn.destroyed));
		const saved = loadHerdrState(statePath).state;
		expect(saved.panes[identity]).toEqual(original);
		expect(saved.counters).toEqual({ stored: 0, refused: 0, failed: failed.length, unmapped: {} });
		for (const event of failed) expect(event).toMatchObject({
			kind: "note", session_id: original?.session_id,
			payload: { previous_status: "working", status: "idle" },
		});

		collector = new HerdrCollector({
			...options,
			now: () => "2026-10-09T00:01:00.000Z",
			post: async (event) => {
				recovered.push(event);
				return event.kind === "session.end" ? { kind: "refused", status: 400, error: "test refusal" } : { kind: "stored" };
			},
		});
		collector.startWatch();
		await waitFor("restart note stored", () => loadHerdrState(statePath).state.counters.stored === 1);
		expect(loadHerdrState(statePath).state.panes[identity]?.session_id).toBe(original?.session_id);
		const before = snapshots;
		await waitFor("unchanged restarted timer passes", () => snapshots >= before + 3);
		expect(recovered).toHaveLength(1);
		panes = [];
		await waitFor("end refusal accounted", () => loadHerdrState(statePath).state.counters.refused === 1);
		const endedAt = snapshots;
		await waitFor("refused end not retried", () => snapshots >= endedAt + 3);
		expect(recovered.map((event) => ({
			kind: event.kind, session_id: event.session_id, repo: event.repo, branch: event.branch,
			surface: event.surface, actor: event.actor, payload: event.payload,
		}))).toEqual([
			{
				kind: "note", session_id: original?.session_id, repo: "substrate-rehearsal/restart", branch: "proof",
				surface: "omp", actor: "agent",
				payload: { runtime: "herdr", herdr_type: "pane.agent_status_changed", pane_id: "w1:p1", agent: "omp", previous_status: "working", status: "idle" },
			},
			{
				kind: "session.end", session_id: original?.session_id, repo: "substrate-rehearsal/restart", branch: "proof",
				surface: "omp", actor: "agent",
				payload: { runtime: "herdr", herdr_type: "pane.exited", pane_id: "w1:p1", agent: "omp", end_reason: "pane_gone" },
			},
		]);
		expect(loadHerdrState(statePath).state).toEqual({
			version: 2, panes: {}, seen_unmapped: {},
			counters: { stored: 1, refused: 1, failed: failed.length, unmapped: {} },
		});
	}, 10000);

	test("an initial snapshot outage recovers by seeding silently rather than bursting starts", async () => {
		const socketPath = await listen();
		const statePath = join(scratchDir("herdr-state-"), "herdr-offsets.json");
		const posted: EventInput[] = [];
		panes = [{ pane_id: "w1:p1", terminal_id: "term_a", agent: "omp", agent_status: "working", cwd: statePath }];
		snapshotUnavailable = true;
		collector = new HerdrCollector({
			socketPath, statePath, pollMs: 25, debounceMs: 2,
			post: async (event) => {
				posted.push(event);
				return { kind: "stored" };
			},
			attribute: () => ({ repo: "substrate-rehearsal/bootstrap", branch: "proof" }),
			now: () => "2026-10-09T00:00:00.000Z",
		});
		collector.startWatch();
		await waitFor("multiple initial outage polls", () => snapshots >= 3);
		expect(existsSync(statePath)).toBe(false);
		expect(posted).toEqual([]);
		snapshotUnavailable = false;
		await waitFor("recovered working seed", () => existsSync(statePath));
		expect(loadHerdrState(statePath).state.counters).toEqual({ stored: 0, refused: 0, failed: 0, unmapped: {} });
		const session = loadHerdrState(statePath).state.panes[paneIdentity("w1:p1", "term_a")]?.session_id;
		panes = [{ ...panes[0]!, agent_status: "idle" }];
		await waitFor("post-seed timer note", () => loadHerdrState(statePath).state.counters.stored === 1);
		const before = snapshots;
		await waitFor("no bootstrap start or duplicate note", () => snapshots >= before + 3);
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({
			kind: "note", surface: "omp", actor: "agent", session_id: session,
			repo: "substrate-rehearsal/bootstrap", branch: "proof",
			payload: { runtime: "herdr", herdr_type: "pane.agent_status_changed", pane_id: "w1:p1", agent: "omp", previous_status: "working", status: "idle" },
		});
	}, 10000);

	test("failed posts are journalled with a counter summary", async () => {
		const socketPath = await listen();
		const dir = scratchDir("herdr-state-");
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
