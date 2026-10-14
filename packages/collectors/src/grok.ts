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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeSessionCwd, mapGrokEvent, type GrokEvent } from "./grok-map.ts";
import { COUNTERS_KEY, countOutcome, drainEventSpool, emptyCounters, postEvent, type EmitCounters } from "./emit.ts";
import { branchFor, repoSlug } from "./git-context.ts";

const POLL_MS = 5000;
/** One line per status and server error, not one per event. A busy session must not flood the unit log. */
export const REFUSAL_LOG_INTERVAL_MS = 60_000;

function sessionsDir(): string {
	return process.env.GROK_SESSIONS_DIR ?? `${process.env.HOME ?? "/root"}/.grok/sessions`;
}

function stateFile(): string {
	return process.env.SUBSTRATE_COLLECTOR_STATE ?? "/var/lib/substrate/grok-offsets.json";
}

type Offsets = Record<string, number | EmitCounters>;

function loadOffsets(): Offsets {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(stateFile(), "utf8")) as unknown;
	} catch {
		return {};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const offsets: Offsets = {};
	for (const [key, value] of Object.entries(raw)) {
		// The live flat path-to-offset map keeps working: only finite numbers
		// survive as offsets, and the counters live under their reserved key.
		if (key === COUNTERS_KEY) {
			if (typeof value === "object" && value !== null) offsets[key] = value as EmitCounters;
			continue;
		}
		if (typeof value === "number" && Number.isFinite(value)) offsets[key] = value;
	}
	return offsets;
}

/** The cumulative outcome counters in a state file, created on first use. */
function countersOf(offsets: Offsets): EmitCounters {
	const found = offsets[COUNTERS_KEY];
	const counters = typeof found === "object" && found !== null ? (found as EmitCounters) : emptyCounters();
	for (const key of ["stored", "refused", "failed"] as const) {
		if (typeof counters[key] !== "number" || !Number.isFinite(counters[key])) counters[key] = 0;
	}
	offsets[COUNTERS_KEY] = counters;
	return counters;
}

function saveOffsets(offsets: Offsets): void {
	try {
		mkdirSync(dirname(stateFile()), { recursive: true });
		writeFileSync(stateFile(), JSON.stringify(offsets));
	} catch (cause) {
		process.stderr.write(`[grok-collector] cannot persist offsets: ${String(cause)}\n`);
	}
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
 * The idempotency key for one source line: file, session, the offset the line
 * starts at and the line's own bytes. A re-read of the same line yields the same
 * key, and a truncated-and-rewritten log (Grok rotates by truncating) cannot
 * reuse an offset for different content, because the content is part of it.
 */
export function grokEventKey(path: string, sessionId: string, offset: number, line: string): string {
	return `gk1:${createHash("sha256").update(JSON.stringify([path, sessionId, offset, line])).digest("hex")}`;
}

export async function pass(offsets: Offsets, backfill: boolean): Promise<{ read: number; emitted: number }> {
	let read = 0;
	let emitted = 0;
	const counters = countersOf(offsets);

	for (const log of findSessionLogs()) {
		let size: number;
		try {
			size = statSync(log.path).size;
		} catch {
			continue;
		}

		const atPath = offsets[log.path];
		const known = typeof atPath === "number" ? atPath : undefined;
		if (known === undefined) {
			// First sight: start at the end unless history was asked for.
			offsets[log.path] = backfill ? 0 : size;
			if (!backfill) continue;
		}
		let from = known ?? 0;
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
			repo: cwd ? repoSlug(cwd) : undefined,
			branch: cwd ? branchFor(cwd) : undefined,
		};

		let lineAt = from;
		for (const line of complete) {
			const at = lineAt;
			lineAt += Buffer.byteLength(line) + 1;
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
			// The shared emit never throws and records refusals itself; the
			// collector only counts the outcome and keeps its rate-limited
			// journal summary. Offsets advance either way: fail-open (D19-06).
			const outcome = await postEvent(event, {
				timeoutMs: 3000,
				collector: "grok",
				source: "grok",
				idempotencyKey: grokEventKey(log.path, log.sessionId, at, line),
			});
			countOutcome(counters, outcome);
			if (outcome.kind === "stored") emitted++;
			else if (outcome.kind === "refused") logEmitRefusal(outcome.status, outcome.error);
			else logEmitRefusal(outcome.status ?? 0, outcome.error ?? "unreachable");
		}

		offsets[log.path] = from + consumed;
	}

	saveOffsets(offsets);
	return { read, emitted };
}

/** Replay parked events once, when the spool is on; says so on stdout only when something moved. */
async function replaySpool(): Promise<void> {
	const result = await drainEventSpool({ budgetMs: 10_000 });
	if (result.status === "off") return;
	const delivered = result.status === "ran" ? result.delivered : 0;
	if (delivered > 0 || result.dropped > 0) {
		const left = result.status === "ran" ? `, left ${result.remaining}` : `, held ${result.reason}`;
		process.stdout.write(`[grok-collector] spool replayed ${delivered}, dropped ${result.dropped}${left}\n`);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const backfill = args.includes("--backfill");
	const watch = args.includes("--watch");

	const offsets = loadOffsets();
	const first = await pass(offsets, backfill);
	process.stdout.write(`[grok-collector] read ${first.read} lines, emitted ${first.emitted}\n`);
	await replaySpool();

	if (watch) {
		process.stdout.write(`[grok-collector] watching ${sessionsDir()} every ${POLL_MS}ms\n`);
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
			const round = await pass(offsets, false);
			if (round.emitted > 0) process.stdout.write(`[grok-collector] emitted ${round.emitted}\n`);
			await replaySpool();
		}
	}
}

if (import.meta.main) {
	await main();
}
