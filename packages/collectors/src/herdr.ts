#!/usr/bin/env bun
/**
 * herdr (Lane B persistent runtime) + Orca collector.
 *
 * Tails herdr-managed agent sessions (OMP jsonl referenced from ~/.config/herdr/session.json)
 * under ~/.omp/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl and forwards meaningful
 * events to the substrate /events.
 *
 *   bun packages/collectors/src/herdr.ts --once
 *   bun packages/collectors/src/herdr.ts --watch
 *   bun packages/collectors/src/herdr.ts --once --backfill
 *
 * Native floor (per-agent) first; Orca tee via endpoint.env is the second option
 * (simulation possible by pointing ORCA_AGENT_HOOK_ENDPOINT at a small forwarder
 * that also calls substrate emit; not activated here to keep additive/fail-open).
 *
 * herdr logs in ~/.config/herdr/herdr-*.log supply pane/agent lifecycle as notes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { decodeHerdrCwd, mapHerdrEvent, type HerdrEvent } from "./herdr-map.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";

const HERDR_CONFIG_DIR = process.env.HERDR_CONFIG_DIR ?? `${process.env.HOME ?? "/root"}/.config/herdr`;
const SESSIONS_DIR = process.env.HERDR_SESSIONS_DIR ?? `${process.env.HOME ?? "/root"}/.omp/agent/sessions`;
const STATE_FILE = process.env.SUBSTRATE_COLLECTOR_STATE ?? "/var/lib/substrate/herdr-offsets.json";
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
		process.stderr.write(`[herdr-collector] cannot persist offsets: ${String(cause)}\n`);
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
		// each cwdDir may contain <ts>_<uuid>.jsonl directly or subdirs
		const base = join(SESSIONS_DIR, cwdDir);
		let entries: string[];
		try {
			entries = readdirSync(base);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".jsonl")) continue;
			const path = join(base, entry);
			// session id is the uuid part before .jsonl
			const match = entry.match(/(\d{4}-\d{2}-\d{2}T[^_]+_([0-9a-f-]+))\.jsonl$/);
			const sessionId = (match ? match[2] : entry.replace(/\.jsonl$/, "")) || entry.replace(/\.jsonl$/, "");
			const cwd = decodeHerdrCwd(cwdDir);
			if (existsSync(path)) logs.push({ path, sessionId, cwd });
		}
		// also check one level of subdirs (observed in layout)
		for (const sub of entries) {
			const subPath = join(base, sub);
			try {
				if (!statSync(subPath).isDirectory()) continue;
			} catch {
				continue;
			}
			let subEntries: string[];
			try {
				subEntries = readdirSync(subPath);
			} catch {
				continue;
			}
			for (const e of subEntries) {
				if (!e.endsWith(".jsonl")) continue;
				const path = join(subPath, e);
				const sessionId = sub; // dir name contains the id
				const cwd = decodeHerdrCwd(cwdDir);
				if (existsSync(path)) logs.push({ path, sessionId, cwd });
			}
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
			offsets[log.path] = backfill ? 0 : size;
			if (!backfill) continue;
		}
		let from = offsets[log.path] ?? 0;
		if (from > size) from = 0;
		if (from === size) continue;

		let text: string;
		try {
			text = readFileSync(log.path, "utf8").slice(from);
		} catch {
			continue;
		}

		const lines = text.split("\n");
		const complete = text.endsWith("\n") ? lines.slice(0, -1) : lines.slice(0, -1);
		const consumed = complete.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);

		const cwd = log.cwd;
		const context = {
			sessionId: log.sessionId,
			repo: cwd ? repoFor(cwd) : undefined,
			branch: cwd ? branchFor(cwd) : undefined,
			cwd: cwd || undefined,
		};

		for (const line of complete) {
			if (!line.trim()) continue;
			read++;
			let parsed: HerdrEvent;
			try {
				parsed = JSON.parse(line) as HerdrEvent;
			} catch {
				continue;
			}
			const event = mapHerdrEvent(parsed, context);
			if (!event) continue;
			if (await emit(event)) emitted++;
		}

		offsets[log.path] = from + consumed;
	}

	// Also lightly tail herdr's own logs for pane/agent lifecycle (as notes)
	// This grounds the "poll herdr logs" part of the spec.
	try {
		const serverLog = join(HERDR_CONFIG_DIR, "herdr-server.log");
		if (existsSync(serverLog)) {
			const st = statSync(serverLog);
			const k = offsets[serverLog] ?? st.size;
			if (k < st.size) {
				const tail = readFileSync(serverLog, "utf8").slice(k);
				const newLines = tail.split("\n").filter((l) => /agent changed|pane:/.test(l));
				for (const ln of newLines) {
					if (!ln.trim()) continue;
					read++;
					const ev: EventInput = {
						surface: "omp",
						kind: "note",
						summary: `herdr ${ln.trim().slice(0, 140)}`,
						payload: { source: "herdr-log" },
					};
					if (await emit(ev)) emitted++;
				}
				offsets[serverLog] = st.size;
			}
		}
	} catch {
		// fail open on log tail
	}

	saveOffsets(offsets);
	return { read, emitted };
}

const args = process.argv.slice(2);
const backfill = args.includes("--backfill");
const watch = args.includes("--watch");

const offsets = loadOffsets();
const first = await pass(offsets, backfill);
process.stdout.write(`[herdr-collector] read ${first.read} lines, emitted ${first.emitted}\n`);

if (watch) {
	process.stdout.write(`[herdr-collector] watching ${SESSIONS_DIR} (and ${HERDR_CONFIG_DIR} logs) every ${POLL_MS}ms\n`);
	for (;;) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, POLL_MS);
		await promise;
		const round = await pass(offsets, false);
		if (round.emitted > 0) process.stdout.write(`[herdr-collector] emitted ${round.emitted}\n`);
	}
}