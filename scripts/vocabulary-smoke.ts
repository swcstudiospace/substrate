#!/usr/bin/env bun
/**
 * Vocabulary sample-emit proof for Phase 17 (event vocabulary).
 *
 * Run as `bun run smoke:vocabulary --name <instance>` against the Phase 16
 * rehearsal harness (`bun run rehearsal up --name <instance>`). It posts one
 * sample per `EVENT_SOURCES` row to `POST /events` and requires `202` with
 * `stored: true` for each with zero refusals, then reads them back through
 * `POST /events/query` to confirm one stored row per source.
 *
 * The twin's URL and bearer come only from the named instance's
 * `consumer.env` (`${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/<name>/`);
 * there is no default URL and the process environment is never read for a
 * URL or a bearer. `refuseTarget` runs before any request, so a production
 * port or a non-loopback host exits 2 with zero requests sent. Reports
 * carry ids, counts and statuses only — never the bearer or reply bodies.
 *
 * Exit codes: 0 every sample stored and read back with zero refusals,
 * 1 a check failed, 2 precondition refused (no consumer.env, a refused
 * target, or an unreachable twin).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_SOURCES } from "../packages/mcp-server/src/event-sources.ts";

/** Production ports the smoke never drives, mirroring the harness. */
const PRODUCTION_PORTS = [7410, 7411, 6420] as const;

/** Loopback hosts the smoke may drive; anything else is a production risk. */
const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, "::1": true, localhost: true };

const REQUEST_TIMEOUT_MS = 10_000;
const READBACK_RETRIES = 12;
const READBACK_WAIT_MS = 1000;

/**
 * Parse `export KEY='value'` lines, undoing the POSIX single-quote escape
 * (`'\''`). Lines that are not exports are ignored.
 */
export function parseConsumerEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("export ")) continue;
		const rest = trimmed.slice("export ".length);
		const eq = rest.indexOf("=");
		if (eq <= 0) continue;
		const key = rest.slice(0, eq).trim();
		let value = rest.slice(eq + 1).trim();
		if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
			value = value.slice(1, -1).replace(/'\\''/g, "'");
		}
		out[key] = value;
	}
	return out;
}

/**
 * Refuse a smoke target before any request: a production port or a
 * non-loopback host. Returns the reason, or null when the target is a
 * scratch twin.
 */
export function refuseTarget(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return `unparseable smoke target ${raw}`;
	}
	if ((PRODUCTION_PORTS as readonly number[]).includes(Number(url.port))) {
		return `refusing to smoke production :${url.port}`;
	}
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	if (LOOPBACK_HOSTS[host] !== true) return `refusing non-loopback smoke host ${url.hostname}`;
	return null;
}

/** Graph tag for one proof run: `rh-vocab-<epoch-ms>`. */
export function runTag(nowMs: number): string {
	return `rh-vocab-${nowMs}`;
}

/**
 * Session id for one sample in a run: the run tag suffixed with the entry
 * id, kept under 512 chars so a long source id cannot breach the cap.
 */
export function runSession(tag: string, entryId: string): string {
	return `${tag}-${entryId}`.slice(0, 511);
}

interface PostResult {
	id: string;
	status: number | null;
	stored: boolean;
	refused: boolean;
	postedId: string | null;
	error?: string;
}

/**
 * A post counts as refused when it is anything but a stored 202: a 400
 * rejected input, a 401/403 denied attribution, a 503 failed storage, an
 * unreachable twin, or a 202 the ledger did not store. Counting only 403s
 * let every other rejection report zero refusals.
 */
export function isRefused(status: number | null, stored: boolean): boolean {
	return !(status === 202 && stored);
}

async function postEvent(base: string, bearer: string, body: Record<string, unknown>): Promise<{ status: number | null; stored: boolean; refused: boolean; postedId: string | null; error?: string }> {
	try {
		const res = await fetch(`${base}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				authorization: `Bearer ${bearer}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		let stored = false;
		let postedId: string | null = null;
		try {
			const parsed = (await res.json()) as { stored?: boolean; id?: unknown };
			stored = parsed.stored === true;
			postedId = typeof parsed.id === "string" ? parsed.id : null;
		} catch {
			stored = false;
		}
		return { status: res.status, stored, refused: isRefused(res.status, stored), postedId };
	} catch (cause) {
		return { status: null, stored: false, refused: true, postedId: null, error: String(cause) };
	}
}

async function readBack(base: string, bearer: string, tag: string): Promise<number | null> {
	for (let attempt = 0; attempt < READBACK_RETRIES; attempt++) {
		try {
			const res = await fetch(`${base}/events/query`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
					authorization: `Bearer ${bearer}`,
				},
				body: JSON.stringify({ graph_id: tag, limit: 500, include_payload: true, order: "asc" }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (res.status !== 200) return null;
			const parsed = (await res.json()) as { events?: unknown[]; count?: number };
			const count = Array.isArray(parsed.events) ? parsed.events.length : (parsed.count ?? null);
			if (count === EVENT_SOURCES.length) return count;
		} catch {
			// Retry below.
		}
		await Bun.sleep(READBACK_WAIT_MS);
	}
	return null;
}

export async function main(argv: string[]): Promise<number> {
	const at = argv.indexOf("--name");
	const name = at >= 0 && argv[at + 1] ? (argv[at + 1] as string) : "default";
	const base = process.env.XDG_RUNTIME_DIR ?? "/tmp";
	const envPath = join(base, "substrate-rehearsal", name, "consumer.env");
	if (!existsSync(envPath)) {
		process.stderr.write(`[vocab-smoke] no consumer.env for instance ${name}: run rehearsal up first.\n`);
		return 2;
	}
	const record = parseConsumerEnv(readFileSync(envPath, "utf8"));
	const target = (record["SUBSTRATE_URL"] ?? "").replace(/\/+$/, "");
	const bearer = record["SUBSTRATE_TOKEN"] ?? "";
	if (!target) {
		process.stderr.write(`[vocab-smoke] consumer.env for ${name} has no twin url.\n`);
		return 2;
	}
	const refused = refuseTarget(target);
	if (refused !== null) {
		process.stderr.write(`[vocab-smoke] ${refused}.\n`);
		return 2;
	}

	const tag = runTag(Date.now());
	process.stdout.write(`\nVocabulary smoke — ${name}, graph ${tag}, ${EVENT_SOURCES.length} sources\n\n`);

	const results: PostResult[] = [];
	for (const entry of EVENT_SOURCES) {
		const sample = entry.sample();
		const outcome = await postEvent(target, bearer, {
			...sample,
			session_id: runSession(tag, entry.id),
			graph_id: tag,
		});
		results.push({ id: entry.id, ...outcome });
		const ok = outcome.status === 202 && outcome.stored;
		process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${entry.id} — status ${outcome.status ?? "unreachable"}${outcome.error ? ` (${outcome.error})` : ""}\n`);
	}

	const stored = results.filter((result) => result.status === 202 && result.stored).length;
	const refusals = results.filter((result) => result.refused).length;
	process.stdout.write(`\nstored ${stored}/${results.length}, refusals ${refusals}\n`);

	const failed = results.filter((result) => !(result.status === 202 && result.stored));
	const readback = await readBack(target, bearer, tag);
	const readbackOk = readback === EVENT_SOURCES.length;
	process.stdout.write(`read back ${readback ?? 0}/${EVENT_SOURCES.length}\n`);
	process.stdout.write(`\n${results.length - failed.length + (readbackOk ? 1 : 0)}/${results.length + 1} checks passed\n`);

	if (failed.length > 0 || refusals > 0 || !readbackOk) {
		if (refusals > 0) process.stderr.write(`[vocab-smoke] ${refusals} refusal(s); the closed vocabulary did not hold over the wire.\n`);
		if (!readbackOk) process.stderr.write("[vocab-smoke] readback mismatch: expected one stored row per source.\n");
		return 1;
	}
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
