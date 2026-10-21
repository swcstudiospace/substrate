#!/usr/bin/env bun
/**
 * herdr collector.
 *
 * herdr 0.9.1's socket seam speaks newline-delimited JSON over a Unix domain
 * socket: one object per line with a string `id`. A connection may carry only
 * one `events.subscribe`. Pushes are triggers, not truth: every push and the
 * 5 s timer mark one debounced pass that snapshots, reconciles and emits.
 *
 *   bun packages/collectors/src/herdr.ts --once
 *   bun packages/collectors/src/herdr.ts --watch
 *   bun packages/collectors/src/herdr.ts --session <name>
 */
import { createConnection, type Socket } from "node:net";
import { drainEventSpool, postEvent, SPOOL_DRAIN_MS, type EmitOutcome } from "./emit.ts";
import { spoolConfig } from "./spool.ts";
import { branchFor, repoSlug } from "./git-context.ts";
import { graphIdForWorktree } from "./worktree-graph.ts";
import type { HerdrPane } from "./herdr-map.ts";
import {
	commitReconcile,
	defaultHerdrStatePath,
	loadHerdrState,
	reconcile,
	saveHerdrState,
	type TransitionOutcome,
} from "./herdr-state.ts";

export const POLL_MS = 5000;
export const DEBOUNCE_MS = 150;
const CALL_TIMEOUT_MS = 5000;
const JOURNAL_INTERVAL_MS = 60_000;

/** Repo, branch and graph for a pane, from its working directory. Empty when the pane reports none. */
export function attributePane(pane: HerdrPane): { repo?: string; branch?: string; graph_id?: string } {
	const cwd = pane.cwd ?? pane.foreground_cwd;
	if (!cwd) return {};
	return { repo: repoSlug(cwd), branch: branchFor(cwd), graph_id: graphIdForWorktree(cwd) ?? undefined };
}

/** Global lifecycle types. One subscribe, no pane id. */
export const GLOBAL_SUBSCRIPTIONS = [
	{ type: "pane.created" },
	{ type: "pane.closed" },
	{ type: "pane.exited" },
	{ type: "pane.agent_detected" },
] as const;

/** The only per-pane subscription. `pane.output_matched` is intentionally absent. */
export function paneSubscription(paneId: string): [{ type: "pane.agent_status_changed"; pane_id: string }] {
	return [{ type: "pane.agent_status_changed", pane_id: paneId }];
}

/**
 * `--session`, then `HERDR_SOCKET_PATH`, then `HERDR_SESSION`, then
 * `$HOME/.config/herdr/herdr.sock`. HOME falls back to `/root`.
 */
export function resolveSocketPath(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME && env.HOME.length > 0 ? env.HOME : "/root";
	const sessionIdx = argv.indexOf("--session");
	const sessionArg = sessionIdx >= 0 ? argv[sessionIdx + 1] : undefined;
	if (sessionArg) return `${home}/.config/herdr/sessions/${sessionArg}/herdr.sock`;
	if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
	if (env.HERDR_SESSION) return `${home}/.config/herdr/sessions/${env.HERDR_SESSION}/herdr.sock`;
	return `${home}/.config/herdr/herdr.sock`;
}

/** Split newline-delimited JSON off a growing buffer. */
export function makeLineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
	let buf = "";
	return (chunk) => {
		buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let idx = buf.indexOf("\n");
		while (idx >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (line.trim()) onLine(line);
			idx = buf.indexOf("\n");
		}
	};
}

interface RpcError {
	code?: string;
	message?: string;
}

interface RpcMessage {
	id?: string;
	result?: unknown;
	error?: RpcError;
	event?: string;
	data?: unknown;
}

export interface HerdrCollectorOptions {
	socketPath: string;
	statePath: string;
	debounceMs?: number;
	pollMs?: number;
	post?: (event: Parameters<typeof postEvent>[0], source: string) => Promise<EmitOutcome>;
	attribute?: (pane: HerdrPane) => { repo?: string; branch?: string };
	now?: () => string;
	/**
	 * The spool replay run on a tick while watching. Defaults to `drainEventSpool` when
	 * `SUBSTRATE_EVENT_SPOOL=on` and to nothing otherwise (no timer is created).
	 */
	drain?: () => Promise<unknown>;
	drainMs?: number;
}

interface LiveSocket {
	socket: Socket;
	role: "global" | "pane";
	paneId?: string;
	subscribed: boolean;
}

/**
 * One collector loop. Safe to import: nothing connects until `runPass` or
 * `startWatch`.
 */
export class HerdrCollector {
	readonly socketPath: string;
	readonly statePath: string;
	private readonly debounceMs: number;
	private readonly pollMs: number;
	private readonly post: (event: Parameters<typeof postEvent>[0], source: string) => Promise<EmitOutcome>;
	private readonly attribute: (pane: HerdrPane) => { repo?: string; branch?: string };
	private readonly now: () => string;
	private readonly drain: (() => Promise<unknown>) | null;
	private readonly drainMs: number;
	private drainTimer: ReturnType<typeof setInterval> | undefined;
	private draining: Promise<unknown> | null = null;
	private seq = 0;
	private dirty = false;
	private stopped = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private poll: ReturnType<typeof setInterval> | undefined;
	private pumping: Promise<void> | null = null;
	private global: LiveSocket | undefined;
	private readonly paneSockets = new Map<string, LiveSocket>();
	private lastJournal = 0;

	constructor(options: HerdrCollectorOptions) {
		this.socketPath = options.socketPath;
		this.statePath = options.statePath;
		this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
		this.pollMs = options.pollMs ?? POLL_MS;
		this.post = options.post ?? ((event, source) => postEvent(event, { timeoutMs: 3000, collector: "herdr", source }));
		this.attribute = options.attribute ?? attributePane;
		this.now = options.now ?? (() => new Date().toISOString());
		this.drain = options.drain ?? (spoolConfig().mode === "on" ? () => drainEventSpool({ budgetMs: 10_000 }) : null);
		this.drainMs = options.drainMs ?? SPOOL_DRAIN_MS;
	}

	static fromArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): HerdrCollector {
		return new HerdrCollector({
			socketPath: resolveSocketPath(argv, env),
			statePath: defaultHerdrStatePath(env),
		});
	}

	/** A push or the poll timer. Coalesced; never runs two passes at once. */
	markDirty(): void {
		if (this.stopped) return;
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.pump();
		}, this.debounceMs);
	}

	/** Run the scheduled pass now. Tests use this to avoid the debounce wait. */
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (!this.dirty && !this.pumping) return;
		this.dirty = true;
		await this.pump();
	}

	private pump(): Promise<void> {
		if (this.pumping) return this.pumping;
		this.pumping = (async () => {
			while (this.dirty && !this.stopped) {
				this.dirty = false;
				await this.runPass();
			}
		})().finally(() => {
			this.pumping = null;
		});
		return this.pumping;
	}

	startWatch(): void {
		this.stopped = false;
		this.dirty = true;
		void this.pump();
		this.poll = setInterval(() => this.markDirty(), this.pollMs);
		this.startDrain();
	}

	/**
	 * Replay the spool on its own tick, single-flight: a pass that is still running is
	 * never overlapped, the timer is `unref`'d so it cannot keep the process alive, and
	 * `stop()` clears it on every exit path.
	 */
	private startDrain(): void {
		const drain = this.drain;
		if (drain === null || this.drainTimer) return;
		this.drainTimer = setInterval(() => {
			if (this.stopped || this.draining) return;
			this.draining = drain()
				.catch(() => undefined)
				.finally(() => {
					this.draining = null;
				});
		}, this.drainMs);
		this.drainTimer.unref();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		if (this.poll) clearInterval(this.poll);
		clearInterval(this.drainTimer);
		this.timer = undefined;
		this.poll = undefined;
		this.drainTimer = undefined;
		this.global?.socket.destroy();
		this.global = undefined;
		for (const live of this.paneSockets.values()) live.socket.destroy();
		this.paneSockets.clear();
	}

	/**
	 * Snapshot, reconcile, emit, then open or close subscriptions.
	 * A snapshot outage counts as failed and does not advance pane state.
	 */
	async runPass(): Promise<{ emitted: number; failed: number }> {
		const panes = await this.fetchPanes();
		if (!panes) {
			this.noteOutage();
			return { emitted: 0, failed: 1 };
		}
		const loaded = loadHerdrState(this.statePath);
		const result = reconcile(loaded.state, panes, { seed: loaded.firstRun, now: this.now(), attribute: this.attribute });
		let emitted = 0;
		let failed = 0;
		let next = result.seeded;
		if (!loaded.firstRun || !next) {
			const outcomes: TransitionOutcome[] = [];
			const blocked = new Set<string>();
			for (const transition of result.transitions) {
				if (blocked.has(transition.identity)) {
					outcomes.push("skipped");
					continue;
				}
				let outcome: EmitOutcome;
				try {
					outcome = await this.post(transition.event, transition.rowId);
				} catch {
					outcome = { kind: "failed", error: "post threw" };
				}
			// An event parked in the spool is owned by the spool (same key and ts on every replay);
			// re-emitting it next pass would write a second row, so it advances like a stored one.
			const spooled = outcome.kind === "failed" && outcome.spooled === true;
			outcomes.push(spooled ? "spooled" : outcome.kind);
			if (spooled) {
				continue;
			}
			if (outcome.kind === "failed") {
				failed += 1;
				blocked.add(transition.identity);
			} else {
				emitted += 1;
			}
		}
		if (failed > 0) this.journal(`emit failed (failed=${failed} emitted=${emitted})`);
		next = commitReconcile(loaded.state, result, outcomes);
		}
		if (!saveHerdrState(this.statePath, next)) this.journal("cannot persist state");
		this.syncSockets(panes);
		return { emitted, failed };
	}

	private noteOutage(): void {
		const loaded = loadHerdrState(this.statePath);
		// A first run that cannot see the snapshot must stay a first run.
		// Writing an empty version-2 file would make the next pass emit a start per pane.
		if (!loaded.firstRun) {
			saveHerdrState(this.statePath, {
				...loaded.state,
				counters: { ...loaded.state.counters, failed: loaded.state.counters.failed + 1 },
			});
		}
		this.journal("session.snapshot failed");
	}

	private journal(message: string): void {
		const now = Date.now();
		if (now - this.lastJournal < JOURNAL_INTERVAL_MS) return;
		this.lastJournal = now;
		try {
			process.stderr.write(`[herdr-collector] ${message}\n`);
		} catch {
			// Journaling is best-effort.
		}
	}

	private nextId(): string {
		this.seq += 1;
		return `substrate:herdr:${this.seq}`;
	}

	private call(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<{ result?: unknown; error?: RpcError }> {
		const { promise, resolve } = Promise.withResolvers<{ result?: unknown; error?: RpcError }>();
		let settled = false;
		const finish = (out: { result?: unknown; error?: RpcError }) => {
			if (settled) return;
			settled = true;
			resolve(out);
		};
		const sock = createConnection(this.socketPath);
		const id = this.nextId();
		const timer = setTimeout(() => {
			sock.destroy();
			finish({ error: { code: "timeout", message: `${method} timed out` } });
		}, timeoutMs);
		sock.on("data", makeLineReader((line) => {
			let msg: RpcMessage;
			try {
				msg = JSON.parse(line) as RpcMessage;
			} catch {
				return;
			}
			if (msg.id !== id) return;
			clearTimeout(timer);
			sock.end();
			finish({ result: msg.result, error: msg.error });
		}));
		sock.on("error", (cause) => {
			clearTimeout(timer);
			finish({ error: { code: "socket_error", message: String(cause) } });
		});
		sock.on("connect", () => {
			sock.write(`${JSON.stringify({ id, method, params })}\n`);
		});
		return promise;
	}

	private async fetchPanes(): Promise<HerdrPane[] | null> {
		const { result, error } = await this.call("session.snapshot", {});
		if (error || !result || typeof result !== "object") return null;
		const snapshot = (result as { snapshot?: { panes?: HerdrPane[] } }).snapshot;
		return snapshot?.panes ?? [];
	}

	private syncSockets(panes: readonly HerdrPane[]): void {
		if (this.stopped) return;
		this.ensureGlobal();
		const wanted = new Set(panes.map((pane) => pane.pane_id).filter((id) => id.length > 0));
		for (const id of [...this.paneSockets.keys()]) {
			if (!wanted.has(id)) this.closePane(id);
		}
		for (const id of wanted) {
			if (!this.paneSockets.has(id)) this.openPane(id);
		}
	}

	private ensureGlobal(): void {
		if (this.global && !this.global.socket.destroyed) return;
		const socket = createConnection(this.socketPath);
		const live: LiveSocket = { socket, role: "global", subscribed: false };
		this.global = live;
		this.arm(live, GLOBAL_SUBSCRIPTIONS);
	}

	private openPane(paneId: string): void {
		const socket = createConnection(this.socketPath);
		const live: LiveSocket = { socket, role: "pane", paneId, subscribed: false };
		this.paneSockets.set(paneId, live);
		this.arm(live, paneSubscription(paneId));
	}

	private closePane(paneId: string): void {
		const live = this.paneSockets.get(paneId);
		this.paneSockets.delete(paneId);
		live?.socket.destroy();
	}

	private arm(live: LiveSocket, subscriptions: readonly object[]): void {
		const socket = live.socket;
		socket.on("connect", () => {
			if (live.subscribed || this.stopped) return;
			live.subscribed = true;
			const id = this.nextId();
			socket.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`);
		});
		socket.on("data", makeLineReader((line) => {
			let msg: RpcMessage;
			try {
				msg = JSON.parse(line) as RpcMessage;
			} catch {
				return;
			}
			if (msg.error) {
				this.drop(live);
				return;
			}
			if (msg.event) this.markDirty();
		}));
		socket.on("error", () => {
			// The 5 s pass reopens a socket that died. Reconnecting here would loop.
			this.drop(live);
		});
		socket.on("close", () => {
			this.drop(live);
		});
	}

	/** Close this connection only. A dead pane must not take its siblings down. */
	private drop(live: LiveSocket): void {
		if (live.role === "global") {
			if (this.global === live) this.global = undefined;
		} else if (live.paneId && this.paneSockets.get(live.paneId) === live) {
			this.paneSockets.delete(live.paneId);
		}
		if (!live.socket.destroyed) live.socket.destroy();
	}
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const once = argv.includes("--once");
	const watch = argv.includes("--watch");
	const collector = HerdrCollector.fromArgs(argv);
	if (watch && !once) {
		process.stdout.write(`[herdr-collector] watching ${collector.socketPath} every ${POLL_MS}ms\n`);
		collector.startWatch();
	} else {
		const result = await collector.runPass();
		await drainEventSpool({ budgetMs: 10_000 });
		process.stdout.write(`[herdr-collector] pass emitted ${result.emitted}\n`);
		collector.stop();
	}
}
