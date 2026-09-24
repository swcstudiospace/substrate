#!/usr/bin/env bun
/**
 * herdr collector.
 *
 * herdr 0.9.1's socket seam speaks newline-delimited JSON over a Unix domain
 * socket: one object per line with `id`, `method`, `params`; replies reuse
 * `id` under `result` or `error`. Every `id` here is a string — an integer id
 * is rejected by 0.9.1 (`invalid type: integer 1, expected a string`).
 *
 * Verified live against the running 0.9.1 socket on this host (not just from
 * docs) before this file was written, via `herdr api schema` and raw probes:
 *
 *   - Pushed events arrive as `{"event": "<kind>", "data": {...}}`, not a
 *     flat `{"type": ...}` object.
 *   - `pane.output_matched`'s matched text is `data.matched_line`.
 *   - A connection may carry only ONE `events.subscribe` call — a second
 *     `events.subscribe` on an already-subscribed connection resets the
 *     socket. One call MAY bundle multiple filter entries, though, so every
 *     event type this collector wants for one pane goes in one call.
 *   - One invalid `pane_id` in a subscribe call's `subscriptions` array kills
 *     the WHOLE connection with an error reply for that entry and no ack for
 *     the others, even the valid ones. This is why subscriptions are one
 *     connection PER PANE: a pane going away can only take down its own
 *     connection, never a sibling's.
 *   - Subscribing to `pane.output_matched` immediately evaluates the match
 *     against the pane's current buffer, so a reconnect replays whatever is
 *     already on screen. Left undeduped this would re-emit an unchanged note
 *     on every reconnect; the offsets file's `lastSignature` map is what
 *     "a restart does not re-emit" means for a push (not tailed-file)
 *     collector, where there is no byte offset to persist.
 *
 *   bun packages/collectors/src/herdr.ts --once      one bootstrap pass, then exit
 *   bun packages/collectors/src/herdr.ts --watch     stay subscribed, poll for pane churn every 5s
 *   bun packages/collectors/src/herdr.ts --session <name>   named session socket
 *
 * Note for the record, not for implementation: after a machine restart herdr
 * restores its layout but the original processes do not survive, so this
 * collector is not the durability story — that is Phase 3 (Lane A).
 */
import { createConnection, type Socket } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mapHerdrEvent, type HerdrPane } from "./herdr-map.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";

const HOME = process.env.HOME ?? "/root";
const STATE_FILE = process.env.SUBSTRATE_COLLECTOR_STATE ?? "/var/lib/substrate/herdr-offsets.json";
const SUBSTRATE_URL = (process.env.SUBSTRATE_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, "");
const POLL_MS = 5000;

const args = process.argv.slice(2);
const once = args.includes("--once");
const watch = args.includes("--watch");

/**
 * Socket path resolution order, per the D-02 addendum: CLI `--session`, then
 * `HERDR_SOCKET_PATH`, then `HERDR_SESSION` (a named session under
 * `~/.config/herdr/sessions/<name>/herdr.sock`), then the default socket.
 */
function socketPath(): string {
	const sessionIdx = args.indexOf("--session");
	const sessionArg = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;
	if (sessionArg) return `${HOME}/.config/herdr/sessions/${sessionArg}/herdr.sock`;
	if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
	if (process.env.HERDR_SESSION) return `${HOME}/.config/herdr/sessions/${process.env.HERDR_SESSION}/herdr.sock`;
	return `${HOME}/.config/herdr/herdr.sock`;
}

let reqSeq = 0;
/** Ids are prefixed so they are identifiable in herdr's own logs. Must be a string. */
function nextId(): string {
	reqSeq += 1;
	return `substrate:herdr:${reqSeq}`;
}

// ── offsets: a last-emitted signature per pane+kind, not a byte cursor ──────
//
// herdr's lifecycle streams "start at accept time and do not replay retained
// events" (D-02), so there is nothing to seek to the way grok.ts seeks into a
// log file. What DOES need deduping is `pane.output_matched` replaying the
// pane's current buffer on every fresh subscribe (verified above) — this is
// the sense in which "a restart does not re-emit" applies here.
interface OffsetsState {
	lastSignature: Record<string, string>;
}

function loadOffsets(): OffsetsState {
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<OffsetsState>;
		return { lastSignature: parsed.lastSignature ?? {} };
	} catch {
		return { lastSignature: {} };
	}
}

function saveOffsets(state: OffsetsState): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify(state));
	} catch (cause) {
		process.stderr.write(`[herdr-collector] cannot persist offsets: ${String(cause)}\n`);
	}
}

// ── fail-open emit, same shape as grok.ts ───────────────────────────────────
async function emit(event: EventInput): Promise<boolean> {
	try {
		const response = await fetch(`${SUBSTRATE_URL}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(process.env.SUBSTRATE_TOKEN ? { authorization: `Bearer ${process.env.SUBSTRATE_TOKEN}` } : {}),
			},
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(3000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

// ── raw ND-JSON transport ────────────────────────────────────────────────────
interface RpcMessage {
	id?: string;
	result?: unknown;
	error?: { code?: string; message?: string };
	event?: string;
	data?: unknown;
}

/** Split newline-delimited JSON off a growing buffer, one call site per socket. */
function makeLineReader(onLine: (line: string) => void) {
	let buf = "";
	return (chunk: Buffer) => {
		buf += chunk.toString("utf8");
		let idx: number;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (line.trim()) onLine(line);
		}
	};
}

/**
 * One request over its own short-lived connection, closed after the reply.
 * `session.snapshot` always uses a fresh connection — a connection that has
 * already sent `events.subscribe` must never be reused for another request
 * (verified above: a second request on a subscribed connection resets it).
 */
function call(method: string, params: unknown, timeoutMs = 5000): Promise<{ result?: unknown; error?: { code?: string; message?: string } }> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (out: { result?: unknown; error?: { code?: string; message?: string } }) => {
			if (settled) return;
			settled = true;
			resolve(out);
		};

		const sock = createConnection(socketPath());
		const id = nextId();
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
	});
}

interface SnapshotResult {
	snapshot?: { panes?: HerdrPane[] };
}

async function fetchPanes(): Promise<HerdrPane[]> {
	const { result, error } = await call("session.snapshot", {});
	if (error) {
		process.stderr.write(`[herdr-collector] session.snapshot failed: ${error.code ?? ""} ${error.message ?? ""}\n`);
		return [];
	}
	return (result as SnapshotResult | undefined)?.snapshot?.panes ?? [];
}

// ── per-pane subscription: one long-lived connection per pane ──────────────

const paneSockets = new Map<string, Socket>();
let panesById = new Map<string, HerdrPane>();

function signatureFor(record: Record<string, unknown>, eventKind: string): string {
	if (typeof record.matched_line === "string") return record.matched_line;
	if (typeof record.agent_status === "string") return record.agent_status;
	return eventKind;
}

function handlePush(paneId: string, eventKind: string, data: unknown, offsets: OffsetsState): void {
	const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
	const pane = panesById.get(paneId);
	const herdrEvent = { type: eventKind, pane_id: paneId, ...record };

	const sigKey = `${paneId}:${eventKind}`;
	const sig = signatureFor(record, eventKind);
	if (offsets.lastSignature[sigKey] === sig) return; // unchanged replay, e.g. reconnect

	const mapped = mapHerdrEvent(herdrEvent, pane);
	if (!mapped) return;

	offsets.lastSignature[sigKey] = sig;
	saveOffsets(offsets);
	void emit(mapped);

	if (eventKind === "pane.exited") {
		panesById.delete(paneId);
		paneSockets.get(paneId)?.end();
		paneSockets.delete(paneId);
	}
}

/**
 * A pane's connection ending — subscribe error, socket error, or a plain
 * `close` — is never trusted as "the pane is gone". Pushed events and
 * connection state are invalidation triggers only (a must-have truth this
 * design exists to satisfy): re-fetch `session.snapshot` and, if the pane
 * still appears in it, resubscribe. A genuinely exited pane simply will not
 * be in the fresh snapshot, so this naturally stops retrying it. A whole herdr
 * server restart looks like every pane's connection ending near-simultaneously
 * and is handled the same way, pane by pane, with no separate code path.
 */
async function reconnectPane(paneId: string, offsets: OffsetsState): Promise<void> {
	paneSockets.delete(paneId);
	const panes = await fetchPanes();
	panesById = new Map(panes.map((pane) => [pane.pane_id, pane]));
	if (panesById.has(paneId)) subscribePane(paneId, offsets);
}

/**
 * Subscribe one pane's four event types over its own connection. An `error`
 * reply — most commonly `pane_not_found` once the pane is gone — is logged
 * and this pane's connection is torn down; every other pane's connection is
 * untouched. This isolation is mandatory, not optional: bundling several
 * panes into one subscribe call was probed live and a single bad `pane_id`
 * silently kills the ack for every other entry in that same call too.
 */
function subscribePane(paneId: string, offsets: OffsetsState): void {
	if (paneSockets.has(paneId)) return;

	const sock = createConnection(socketPath());
	const id = nextId();
	paneSockets.set(paneId, sock);

	sock.on("connect", () => {
		const params = {
			subscriptions: [
				{ type: "pane.agent_detected", pane_id: paneId },
				{ type: "pane.agent_status_changed", pane_id: paneId },
				{ type: "pane.exited", pane_id: paneId },
				{ type: "pane.output_matched", pane_id: paneId, source: "recent", match: { type: "regex", value: "." } },
			],
		};
		sock.write(`${JSON.stringify({ id, method: "events.subscribe", params })}\n`);
	});

	sock.on("data", makeLineReader((line) => {
		let msg: RpcMessage;
		try {
			msg = JSON.parse(line) as RpcMessage;
		} catch {
			return;
		}
		if (msg.error) {
			process.stderr.write(
				`[herdr-collector] pane ${paneId} subscribe error, skipping this pane only: ${msg.error.code ?? ""} ${msg.error.message ?? ""}\n`,
			);
			sock.destroy();
			void reconnectPane(paneId, offsets);
			return;
		}
		if (msg.result) return; // subscription_started ack
		if (msg.event) handlePush(paneId, msg.event, msg.data, offsets);
	}));

	sock.on("error", (cause) => {
		process.stderr.write(`[herdr-collector] pane ${paneId} socket error: ${String(cause)}\n`);
		void reconnectPane(paneId, offsets);
	});

	sock.on("close", () => {
		if (paneSockets.get(paneId) === sock) paneSockets.delete(paneId);
	});
}

/**
 * Race-free bootstrap, in the documented order: nothing to buffer here since
 * each pane's subscribe connection only starts pushing after its own ack, and
 * every pane connects independently — there is no shared "subscribe first,
 * then snapshot" ordering hazard across panes the way a single wildcard
 * subscription would have had. The snapshot is still fetched first so pane
 * attribution (`cwd`) is available before any push needs it.
 */
async function bootstrap(offsets: OffsetsState): Promise<number> {
	const panes = await fetchPanes();
	panesById = new Map(panes.map((pane) => [pane.pane_id, pane]));
	for (const pane of panes) subscribePane(pane.pane_id, offsets);
	return panes.length;
}

/** Pane churn: subscribe any pane_id the snapshot lists that isn't already subscribed. */
async function reconcilePanes(offsets: OffsetsState): Promise<void> {
	const panes = await fetchPanes();
	for (const pane of panes) panesById.set(pane.pane_id, pane);
	for (const pane of panes) {
		if (!paneSockets.has(pane.pane_id)) subscribePane(pane.pane_id, offsets);
	}
}

const offsets = loadOffsets();
const subscribedCount = await bootstrap(offsets);
process.stdout.write(`[herdr-collector] subscribed ${subscribedCount} pane(s)\n`);

if (once) {
	// Give the initial output_matched replay a moment to land, then exit.
	await new Promise((resolve) => setTimeout(resolve, 500));
	for (const sock of paneSockets.values()) sock.end();
	process.exit(0);
}

if (watch) {
	process.stdout.write(`[herdr-collector] watching ${socketPath()} every ${POLL_MS}ms\n`);
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		try {
			await reconcilePanes(offsets);
		} catch (cause) {
			process.stderr.write(`[herdr-collector] reconcile failed: ${String(cause)}\n`);
		}
	}
}
