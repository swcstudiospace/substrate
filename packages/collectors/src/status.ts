#!/usr/bin/env bun
/**
 * `collectors:status` — the read-only refusal reporter (D19-05).
 *
 * Prints each collector's cumulative counters from its state file plus the
 * refused-emit lines since `--since`. Changes nothing on disk and always
 * exits 0: a status command that could fail is a status command nobody
 * trusts during an outage. The LANEB-07 proof asserts zero refused emits
 * through this command.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTERS_KEY } from "./emit.ts";

const DEFAULT_STATE_DIR = "/var/lib/substrate";
const REFUSED_FILE = "refused-emits.jsonl";

export interface CollectorCounters {
	stored: number;
	refused: number;
	failed: number;
	/** herdr `unmapped`, writer `fetch_failed`/`no_slug`, and whatever comes next. */
	extras: Record<string, number>;
}

export interface RefusedLine {
	ts: string;
	collector: string;
	source: string;
	kind: string;
	surface: string;
	status: number;
	error: string;
}

export interface StatusSummary {
	collectors: Record<string, CollectorCounters>;
	/** Refused lines with `ts` at or after `since`, in file order. */
	refused: RefusedLine[];
	/** Non-empty lines that were not JSON or carried no `ts`. */
	skipped: number;
}

function countersFrom(state: unknown): CollectorCounters {
	const counters: CollectorCounters = { stored: 0, refused: 0, failed: 0, extras: {} };
	if (typeof state !== "object" || state === null) return counters;
	const raw = (state as Record<string, unknown>)[COUNTERS_KEY];
	if (typeof raw !== "object" || raw === null) return counters;
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		if (key === "stored" || key === "refused" || key === "failed") counters[key] = value;
		else counters.extras[key] = value;
	}
	return counters;
}

/**
 * Pure summarize: counters per collector name, refused lines filtered on
 * `ts >= since`. Garbled lines are skipped, never fatal.
 */
export function summarize(
	states: Record<string, unknown>,
	refusedLines: string[],
	since?: string,
): StatusSummary {
	const collectors: Record<string, CollectorCounters> = {};
	for (const [name, state] of Object.entries(states)) collectors[name] = countersFrom(state);
	const refused: RefusedLine[] = [];
	let skipped = 0;
	for (const line of refusedLines) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			skipped += 1;
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || typeof (parsed as RefusedLine).ts !== "string") {
			skipped += 1;
			continue;
		}
		const entry = parsed as RefusedLine;
		if (since !== undefined && entry.ts < since) continue;
		refused.push(entry);
	}
	return { collectors, refused, skipped };
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function readLines(path: string): string[] {
	try {
		return readFileSync(path, "utf8").split("\n");
	} catch {
		return [];
	}
}

function usage(): void {
	process.stderr.write(
		"usage: collectors:status [--since <iso>] [--state-dir <dir>] [--json]\n",
	);
}

function main(): void {
	const argv = process.argv.slice(2);
	let since: string | undefined;
	let stateDir = process.env.SUBSTRATE_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--json") {
			json = true;
		} else if (arg === "--since") {
			since = argv[i + 1];
			i++;
		} else if (arg === "--state-dir") {
			if (argv[i + 1] !== undefined) stateDir = argv[i + 1] as string;
			i++;
		} else {
			usage();
			return;
		}
	}

	const states: Record<string, unknown> = {
		herdr: readJson(join(stateDir, "herdr-offsets.json")),
		muse: readJson(join(stateDir, "muse-offsets.json")),
		grok: readJson(join(stateDir, "grok-offsets.json")),
	};
	const summary = summarize(states, readLines(join(stateDir, REFUSED_FILE)), since);

	if (json) {
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
		return;
	}
	process.stdout.write(`[collectors:status] state dir: ${stateDir}\n`);
	for (const [name, counters] of Object.entries(summary.collectors)) {
		const extra = Object.entries(counters.extras)
			.map(([key, value]) => ` ${key}=${value}`)
			.join("");
		process.stdout.write(
			`${name}: stored=${counters.stored} refused=${counters.refused} failed=${counters.failed}${extra}\n`,
		);
	}
	const window = since === undefined ? "all" : `since ${since}`;
	process.stdout.write(`refused emits (${window}): ${summary.refused.length} (${summary.skipped} skipped)\n`);
	for (const entry of summary.refused) {
		process.stdout.write(
			`${entry.ts} ${entry.collector} ${entry.source} ${entry.kind} ${entry.surface} status=${entry.status} error=${entry.error ?? ""}\n`,
		);
	}
}

if (import.meta.main) main();
