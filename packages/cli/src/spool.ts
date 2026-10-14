/**
 * `substrate spool status|flush` (uplift-5 U5-4b): the operator's view of the
 * collector event spool and the manual replay.
 *
 * `status` reads the spool file and the drop lines in `refused-emits.jsonl` and
 * prints depth, bytes, the oldest entry's age, how many entries are due, and the
 * drop counters by cause — never an event body, summary, payload or key. It
 * changes nothing and works with the flag off, so an operator can see what a
 * previously enabled spool still holds.
 *
 * `flush` replays parked events now, ignoring the backoff schedule but under the
 * same rules as the collectors' own tick: with `SUBSTRATE_EVENT_SPOOL=off` it
 * does nothing and touches no file; otherwise it probes `GET /healthz` first and
 * keeps the spool when the server's `idempotency` is `off` or absent. A flush
 * that delivered everything, delivered some, or was held (server down, server
 * not ready for replays) is a normal result and exits 0 — an outage is not an
 * error of the command — and only a usage error exits 1.
 */
import { countSpoolDrops, drainEventSpool, openEventSpool, type DrainResult } from "../../collectors/src/emit.ts";
import type { SpoolStats } from "../../collectors/src/spool.ts";

export const SPOOL_USAGE = "usage: substrate spool status [--json]\n       substrate spool flush [--json] [--budget-ms N]\n";

const DEFAULT_FLUSH_BUDGET_MS = 30_000;
const MAX_FLUSH_BUDGET_MS = 600_000;

export interface SpoolStatusReport {
	mode: "off" | "on";
	path: string;
	depth: number;
	bytes: number;
	/** Seconds since the oldest parked entry was first sent; null when empty. */
	oldest_age_s: number | null;
	/** Entries whose backoff has elapsed. */
	due: number;
	/** Lines the reader could not use (a torn tail included). */
	malformed: number;
	/** Why the spool file could not be read (an errno code), or null. An unreadable file is never reported as empty. */
	unreadable: string | null;
	caps: { max: number; max_bytes: number; ttl_h: number; max_attempts: number };
	/** Entries dropped by cause, counted within the retained journal files (`refused-emits.jsonl` and its one rotated `.1`): the counts fall when a rotation discards the older file. */
	dropped: Record<string, number>;
}

export interface SpoolDeps {
	out: (text: string) => void;
	err: (text: string) => void;
	/** Test seam; defaults to the shared replay. */
	drain?: (opts: { all: boolean; budgetMs: number }) => Promise<DrainResult>;
	now?: () => number;
}

/** Flags the subcommands accept; anything else is a usage error. */
const FLAGS: Record<string, readonly string[]> = { status: ["json"], flush: ["json", "budget-ms"] };

function parseFlags(sub: string, rest: readonly string[]): { json: boolean; budgetMs: number } | null {
	const allowed = FLAGS[sub] ?? [];
	let json = false;
	let budgetMs = DEFAULT_FLUSH_BUDGET_MS;
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i] ?? "";
		if (!arg.startsWith("--") || !allowed.includes(arg.slice(2))) return null;
		if (arg === "--json") {
			json = true;
		} else {
			const raw = rest[i + 1];
			if (raw === undefined || !/^\d{1,9}$/.test(raw) || Number(raw) < 1) return null;
			budgetMs = Math.min(Number(raw), MAX_FLUSH_BUDGET_MS);
			i += 1;
		}
	}
	return { json, budgetMs };
}

export function spoolStatus(deps: SpoolDeps): SpoolStatusReport {
	const now = deps.now ?? Date.now;
	const { spool, config } = openEventSpool();
	const stats: SpoolStats = spool.stats();
	return {
		mode: config.mode,
		path: spool.path,
		depth: stats.depth,
		bytes: stats.bytes,
		oldest_age_s: stats.oldestAt === null ? null : Math.max(0, Math.round((now() - stats.oldestAt) / 1000)),
		due: stats.due,
		malformed: stats.malformed,
		unreadable: stats.unreadable,
		caps: { max: config.max, max_bytes: config.maxBytes, ttl_h: config.ttlMs / 3_600_000, max_attempts: config.maxAttempts },
		dropped: countSpoolDrops(),
	};
}

function describeFlush(result: DrainResult): string {
	if (result.status === "off") return "event spool is off (SUBSTRATE_EVENT_SPOOL); nothing to flush";
	if (result.status === "held") {
		const clauses = [
			result.dropped > 0 ? `dropped ${result.dropped} expired or exhausted` : "",
			result.failure === "read" ? "spool file could not be read, nothing was changed" : "",
			result.failure === "write" ? "write failed, settled entries are still in the file" : "",
		].filter((clause) => clause !== "");
		return `replay held: ${result.reason}; the spool is kept${result.remaining === null ? "" : ` (remaining=${result.remaining})`} and retried later${clauses.length > 0 ? ` (${clauses.join("; ")})` : ""}`;
	}
	const base = `delivered=${result.delivered} refused=${result.refused} retried=${result.retried} dropped=${result.dropped} remaining=${result.remaining}${result.skipped > 0 ? ` skipped=${result.skipped}` : ""}`;
	const failures = [
		result.readFailed ? "spool file could not be read, nothing was changed" : "",
		result.writeFailed ? "write failed, settled entries are still in the file and were not counted as removed" : "",
	].filter((clause) => clause !== "");
	const tail = failures.length > 0 ? `; ${failures.join("; ")}` : "";
	if (result.held !== null) return `${base}; replay stopped early (${result.held}), the rest is kept${tail}`;
	return result.budgetExhausted ? `${base}; time budget spent, the rest is kept${tail}` : `${base}${tail}`;
}

export async function runSpool(argv: readonly string[], deps: SpoolDeps): Promise<number> {
	const sub = argv[0];
	if (sub !== "status" && sub !== "flush") {
		deps.err(SPOOL_USAGE);
		return 1;
	}
	const flags = parseFlags(sub, argv.slice(1));
	if (flags === null) {
		deps.err(SPOOL_USAGE);
		return 1;
	}
	if (sub === "status") {
		const report = spoolStatus(deps);
		if (flags.json) {
			deps.out(`${JSON.stringify(report, null, 2)}\n`);
			return 0;
		}
		const dropped = Object.entries(report.dropped)
			.map(([cause, count]) => `${cause}=${count}`)
			.join(" ");
		deps.out(
			`event spool: ${report.mode}\n` +
				`path: ${report.path}\n` +
				`depth: ${report.depth} (due ${report.due}, malformed ${report.malformed})\n` +
				(report.unreadable === null ? "" : `unreadable: ${report.unreadable} (the file exists but could not be read; it was not changed)\n`) +
				`bytes: ${report.bytes}\n` +
				`oldest age: ${report.oldest_age_s === null ? "-" : `${report.oldest_age_s}s`}\n` +
				`caps: max=${report.caps.max} max_bytes=${report.caps.max_bytes} ttl_h=${report.caps.ttl_h} max_attempts=${report.caps.max_attempts}\n` +
				`dropped: ${dropped === "" ? "none" : dropped}\n`,
		);
		return 0;
	}
	const drain = deps.drain ?? ((opts: { all: boolean; budgetMs: number }) => drainEventSpool(opts));
	const result = await drain({ all: true, budgetMs: flags.budgetMs });
	deps.out(flags.json ? `${JSON.stringify(result)}\n` : `${describeFlush(result)}\n`);
	return 0;
}
