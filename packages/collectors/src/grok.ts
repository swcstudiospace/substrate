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

const SESSIONS_DIR = process.env.GROK_SESSIONS_DIR ?? `${process.env.HOME ?? "/root"}/.grok/sessions`;
const STATE_FILE = process.env.SUBSTRATE_COLLECTOR_STATE ?? "/var/lib/substrate/grok-offsets.json";
const SUBSTRATE_URL = (process.env.SUBSTRATE_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, "");
const POLL_MS = 5000;

type Offsets = Record<string, number>;

function loadOffsets(): Offsets {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8")) as Offsets;
	} catch {
		return {};
	}
}

function saveOffsets(offsets: Offsets): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify(offsets));
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
		cwdDirs = readdirSync(SESSIONS_DIR);
	} catch {
		return logs;
	}
	for (const cwdDir of cwdDirs) {
		let sessionDirs: string[];
		try {
			sessionDirs = readdirSync(join(SESSIONS_DIR, cwdDir));
		} catch {
			continue;
		}
		for (const sessionId of sessionDirs) {
			const path = join(SESSIONS_DIR, cwdDir, sessionId, "events.jsonl");
			if (existsSync(path)) logs.push({ path, sessionId, cwd: decodeSessionCwd(cwdDir) });
		}
	}
	return logs;
}

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

async function pass(offsets: Offsets, backfill: boolean): Promise<{ read: number; emitted: number }> {
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

const args = process.argv.slice(2);
const backfill = args.includes("--backfill");
const watch = args.includes("--watch");

const offsets = loadOffsets();
const first = await pass(offsets, backfill);
process.stdout.write(`[grok-collector] read ${first.read} lines, emitted ${first.emitted}\n`);

if (watch) {
	process.stdout.write(`[grok-collector] watching ${SESSIONS_DIR} every ${POLL_MS}ms\n`);
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		const round = await pass(offsets, false);
		if (round.emitted > 0) process.stdout.write(`[grok-collector] emitted ${round.emitted}\n`);
	}
}
