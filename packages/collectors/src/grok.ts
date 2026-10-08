#!/usr/bin/env bun
/**
 * Grok Build collector.
 *
 * Tails `~/.grok/sessions/<urlencoded-cwd>/<session-uuid>/events.jsonl` and
 * forwards the meaningful events to the substrate.
 *
 *   bun packages/collectors/src/grok.ts --once      one pass (systemd timer)
 *   bun packages/collectors/src/grok.ts --watch     poll every 5s
 *   bun packages/collectors/src/grok.ts --once --backfill   include history
 *
 * A file seen for the first time starts at EOF. There are 89 sessions and
 * ~65,000 historical events on this host; replaying them would say nothing
 * about what is happening now and would bury every brief. `--backfill`
 * overrides that when the history is actually wanted.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { decodeSessionCwd, mapGrokEvent, type GrokEvent } from "./grok-map.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";

const POLL_MS = 5000;
/** One line per status and server error, not one per event. A busy session must not flood the unit log. */
export const REFUSAL_LOG_INTERVAL_MS = 60_000;

function sessionsDir(): string {
	return process.env.GROK_SESSIONS_DIR ?? `${process.env.HOME ?? "/root"}/.grok/sessions`;
}

function stateFile(): string {
	return process.env.SUBSTRATE_COLLECTOR_STATE ?? "/var/lib/substrate/grok-offsets.json";
}

function substrateUrl(): string {
	return (process.env.SUBSTRATE_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, "");
}

type Offsets = Record<string, number>;

function loadOffsets(): Offsets {
	try {
		return JSON.parse(readFileSync(stateFile(), "utf8")) as Offsets;
	} catch {
		return {};
	}
}

function saveOffsets(offsets: Offsets): void {
	try {
		mkdirSync(dirname(stateFile()), { recursive: true });
		writeFileSync(stateFile(), JSON.stringify(offsets));
	} catch (cause) {
		process.stderr.write(`[grok-collector] cannot persist offsets: ${String(cause)}\n`);
	}
}

/** owner/name for a working directory, or undefined when it is not a git repo. */
const repoCache = new Map<string, string | undefined>();
function repoFor(cwd: string): string | undefined {
	if (repoCache.has(cwd)) return repoCache.get(cwd);
	const result = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" });
	const slug =
		result.status === 0 ? result.stdout.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] : undefined;
	repoCache.set(cwd, slug);
	return slug;
}

function branchFor(cwd: string): string | undefined {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

interface SessionLog {
	path: string;
	sessionId: string;
	cwd: string | null;
}

function findSessionLogs(): SessionLog[] {
	const logs: SessionLog[] = [];
	let cwdDirs: string[];
	try {
		cwdDirs = readdirSync(sessionsDir());
	} catch {
		return logs;
	}
	for (const cwdDir of cwdDirs) {
		let sessionDirs: string[];
		try {
			sessionDirs = readdirSync(join(sessionsDir(), cwdDir));
		} catch {
			continue;
		}
		for (const sessionId of sessionDirs) {
			const path = join(sessionsDir(), cwdDir, sessionId, "events.jsonl");
			if (existsSync(path)) logs.push({ path, sessionId, cwd: decodeSessionCwd(cwdDir) });
		}
	}
	return logs;
}

const refusalLoggedAt = new Map<string, number>();
/** A burst of distinct reasons cannot grow the map without bound. */
const REFUSAL_CACHE_LIMIT = 32;

/** Forget the rate limit. Tests call this; the collector does not. */
export function resetEmitRefusalLog(): void {
	refusalLoggedAt.clear();
}

/**
 * The part of a server error that stays put when the rejected value changes.
 *
 * `invalid ts: 1` and `invalid ts: 2` are one reason. Keying the rate limit on
 * the whole message would log every one of them and keep a map entry for each.
 */
function refusalReason(error: string): string {
	const colon = error.indexOf(":");
	return (colon === -1 ? error : error.slice(0, colon)).trim();
}

/**
 * One stderr line for a refused emit: status and the server's error, never the
 * event we posted. Repeat refusals of the same status and reason are swallowed
 * until the interval passes, so a rejected backlog cannot fill the log.
 *
 * Returns whether a line was written.
 */
export function logEmitRefusal(
	status: number,
	error: string | undefined,
	now = Date.now(),
	write: (line: string) => void = (line) => {
		process.stderr.write(line);
	},
): boolean {
	for (const [key, at] of refusalLoggedAt) {
		if (now - at >= REFUSAL_LOG_INTERVAL_MS) refusalLoggedAt.delete(key);
	}
	const safe = (error ?? "").replace(/[\r\n]/g, " ").slice(0, 200);
	const key = `${status}\n${refusalReason(safe)}`;
	const previous = refusalLoggedAt.get(key);
	if (previous !== undefined && now - previous < REFUSAL_LOG_INTERVAL_MS) return false;
	if (refusalLoggedAt.size >= REFUSAL_CACHE_LIMIT) {
		let oldestKey: string | null = null;
		let oldestAt = Infinity;
		for (const [cached, at] of refusalLoggedAt) {
			if (at < oldestAt) {
				oldestKey = cached;
				oldestAt = at;
			}
		}
		if (oldestKey !== null) refusalLoggedAt.delete(oldestKey);
	}
	refusalLoggedAt.set(key, now);
	write(`[grok-collector] substrate refused emit: status=${status}${safe ? ` error=${safe}` : ""}\n`);
	return true;
}

/**
 * Post one event. A non-ok response or a transport failure is logged and
 * reported as false. It does not throw: the caller advances its offset either
 * way, which is the fail-open the collector already had.
 */
export async function emitToSubstrate(
	event: EventInput,
	options: {
		url?: string;
		token?: string;
		fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
		now?: () => number;
		write?: (line: string) => void;
	} = {},
): Promise<boolean> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const write = options.write;
	const url = (options.url ?? substrateUrl()).replace(/\/+$/, "");
	const token = options.token ?? process.env.SUBSTRATE_TOKEN;
	try {
		const response = await fetchImpl(`${url}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(3000),
		});
		if (response.ok) return true;
		let error: string | undefined;
		try {
			const body = (await response.json()) as { error?: unknown };
			if (typeof body.error === "string") error = body.error;
		} catch {
			// A body that is not JSON still has a status, and the status is the part
			// an operator can act on. The body itself is not the payload we sent.
			error = undefined;
		}
		logEmitRefusal(response.status, error, now(), write);
		return false;
	} catch {
		logEmitRefusal(0, "unreachable", now(), write);
		return false;
	}
}

async function emit(event: EventInput): Promise<boolean> {
	return emitToSubstrate(event);
}

export async function pass(offsets: Offsets, backfill: boolean): Promise<{ read: number; emitted: number }> {
	let read = 0;
	let emitted = 0;

	for (const log of findSessionLogs()) {
		let size: number;
		try {
			size = statSync(log.path).size;
		} catch {
			continue;
		}

		const known = offsets[log.path];
		if (known === undefined) {
			// First sight: start at the end unless history was asked for.
			offsets[log.path] = backfill ? 0 : size;
			if (!backfill) continue;
		}
		let from = offsets[log.path] ?? 0;
		// Grok rotates a log by truncating it; a shrunken file means start over.
		if (from > size) from = 0;
		if (from === size) continue;

		let text: string;
		try {
			text = readFileSync(log.path, "utf8").slice(from);
		} catch {
			continue;
		}

		// A trailing partial line is left for the next pass rather than dropped.
		const lines = text.split("\n");
		const complete = text.endsWith("\n") ? lines.slice(0, -1) : lines.slice(0, -1);
		const consumed = complete.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);

		const cwd = log.cwd;
		const context = {
			sessionId: log.sessionId,
			repo: cwd ? repoFor(cwd) : undefined,
			branch: cwd ? branchFor(cwd) : undefined,
		};

		for (const line of complete) {
			if (!line.trim()) continue;
			read++;
			let parsed: GrokEvent;
			try {
				parsed = JSON.parse(line) as GrokEvent;
			} catch {
				continue;
			}
			const event = mapGrokEvent(parsed, context);
			if (!event) continue;
			if (await emit(event)) emitted++;
		}

		offsets[log.path] = from + consumed;
	}

	saveOffsets(offsets);
	return { read, emitted };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const backfill = args.includes("--backfill");
	const watch = args.includes("--watch");

	const offsets = loadOffsets();
	const first = await pass(offsets, backfill);
	process.stdout.write(`[grok-collector] read ${first.read} lines, emitted ${first.emitted}\n`);

	if (watch) {
		process.stdout.write(`[grok-collector] watching ${sessionsDir()} every ${POLL_MS}ms\n`);
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
			const round = await pass(offsets, false);
			if (round.emitted > 0) process.stdout.write(`[grok-collector] emitted ${round.emitted}\n`);
		}
	}
}

if (import.meta.main) {
	await main();
}
