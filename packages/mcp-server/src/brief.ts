/**
 * The session briefing (Notion §5.4).
 *
 * Composed from the index (graphs, nodes, claims), Greptime (recent actions)
 * and memory (warnings, decisions). Every source is optional: a brief with
 * fewer sections is still useful, and a missing store must degrade rather than
 * throw, because this text sits on the critical path of every prompt. The
 * reads run together under one deadline (uplift-2 R1), so the brief costs its
 * slowest source rather than the sum, and a stalled store costs the budget.
 */
import { earliestRefreshAt } from "./cache.ts";
import { normalizeIdentifier } from "./event.ts";
import type { GreptimeClient } from "./greptime.ts";
import { quote } from "./greptime.ts";
import { leaseSnapshot, type IndexStore } from "./index-store.ts";
import { leaseState } from "./lease.ts";
import type { GraphView, MemoryEntry, Surface } from "./types.ts";

export interface BriefRequest {
	repo?: string;
	branch?: string;
	graph_id?: string;
	surface: Surface;
}

export interface BriefSources {
	index: IndexStore | null;
	greptime: GreptimeClient | null;
}

/** The four reads a brief is composed from, in the order their sections appear. */
export const BRIEF_SOURCES = ["graph", "recent actions", "open graphs", "memory"] as const;
export type BriefSource = (typeof BRIEF_SOURCES)[number];

/** uplift-2 R1: one deadline for every read, and a time bound on the ledger scan. */
export interface BriefOptions {
	/** Shared budget for all four reads, ms. `0` (or unset) means no deadline. */
	budgetMs?: number;
	/** How far back the recent-actions query may look. Default `DEFAULT_RECENT_WINDOW_DAYS`. */
	recentWindowDays?: number;
	now?: () => number;
}

const RECENT_ACTION_LIMIT = 5;
export const DEFAULT_RECENT_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Greptime returns a TIMESTAMP column as an integer, not an ISO string, at
 * whatever precision the column was declared with. `new Date(1790186361859)`
 * and `new Date("1790186361859")` disagree, so normalise before formatting.
 */
export function toDate(value: unknown): Date | null {
	if (value instanceof Date) return value;
	if (typeof value === "number" || (typeof value === "string" && /^\d{10,20}$/.test(value))) {
		const epoch = Number(value);
		// Disambiguate by magnitude: s → ms → µs → ns.
		const ms =
			epoch < 1e11 ? epoch * 1000 : epoch < 1e14 ? epoch : epoch < 1e17 ? epoch / 1000 : epoch / 1_000_000;
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	if (typeof value === "string") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	return null;
}

function relativeTime(value: unknown, now = Date.now()): string {
	const date = toDate(value);
	if (!date) return "at an unknown time";
	const delta = now - date.getTime();
	if (delta < 0) return "just now";
	const minutes = Math.floor(delta / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function clock(value: unknown): string {
	return toDate(value)?.toISOString().slice(11, 16) ?? "--:--";
}

/**
 * One node, as a line in the brief.
 *
 * The lease state matters more than `claimed_by` here. A node whose lease has
 * lapsed is *free* — the next claim takes it — so reporting it as "started by
 * hermes" would tell the reading agent the one thing it must not believe, and
 * would keep it off a node it is entitled to. It is named as stale instead,
 * because who was there last is still worth knowing.
 */
function describeNode(node: GraphView["nodes"][number], now = Date.now()): string {
	const label = node.linear_identifier ? `${node.node_id} ${node.linear_identifier}` : node.node_id;
	if (node.state === "completed") return `${label} done${node.claimed_by ? ` (${node.claimed_by})` : ""}`;
	if (node.claimed_by) {
		const state = leaseState(leaseSnapshot(node), now);
		if (state === "held") {
			const since = node.claimed_at ? ` ${relativeTime(node.claimed_at, now)}` : "";
			return `${label} held by ${node.claimed_by}${since}`;
		}
		const lapsed = node.lease_expires_at ? ` ${relativeTime(node.lease_expires_at, now)}` : "";
		return `${label} free — ${node.claimed_by}'s lease expired${lapsed}`;
	}
	if (node.state === "canceled") return `${label} canceled`;
	return `${label} ${node.state ?? "todo"}`;
}

/**
 * Mark an entry whose trust has decayed, or whose lifetime has run out.
 *
 * A decayed entry is still shown — dropping it would quietly lose the only record
 * that a decision was ever taken. What changes is that the brief stops presenting
 * it as settled, which is the whole point of `needs_reverification`: the next agent
 * is told to check before acting, not left to assume a year-old agent-claimed fact
 * still holds.
 *
 * An expired entry (uplift-3 N4) reaches here only under `SUBSTRATE_MEMORY_EXPIRY=report`,
 * where the index still serves it; the brief says so rather than presenting a
 * `30d` note from last quarter as current. Under `enforce` the index leaves it out.
 */
function staleness(entry: MemoryEntry): string {
	if (entry.expired === true) return " — expired";
	return entry.needs_reverification ? " — needs reverification" : "";
}

/** Fail open, but never silently: a swallowed error still reaches the log. */
function swallow<T>(what: string, fallback: T): (cause: unknown) => T {
	return (cause) => {
		process.stderr.write(`[substrate] brief: ${what} unavailable — ${String(cause)}\n`);
		return fallback;
	};
}

/** A read that outlived the budget. Its message is what the stderr line shows. */
class BriefDeadline extends Error {
	constructor(budgetMs: number) {
		super(`deadline (${budgetMs} ms brief budget)`);
		this.name = "BriefDeadline";
	}
}

interface SharedDeadline {
	race: <T>(read: Promise<T>) => Promise<T>;
	clear: () => void;
}

/**
 * One shared deadline for every read. `race` settles a read against it; a
 * read that misses rejects with `BriefDeadline`, which the caller treats like
 * any other failed read. The underlying promise is not cancelled — a Postgres
 * query has no abort handle — but nobody waits for it any more, and the
 * Greptime read carries the same bound as its own fetch timeout.
 */
function sharedDeadline(budgetMs: number): SharedDeadline {
	if (budgetMs <= 0) return { race: (read) => read, clear: () => {} };
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new BriefDeadline(budgetMs)), budgetMs);
		timer.unref?.();
	});
	// A brief with nothing to read never races it; without this the timer's
	// rejection would be unhandled.
	expired.catch(() => {});
	return {
		race: (read) => Promise.race([read, expired]),
		clear: () => clearTimeout(timer),
	};
}

/**
 * Build the Markdown brief. Never throws — a partial brief beats a blocked prompt.
 *
 * The four reads (graph, recent actions, open graphs, memory) are independent,
 * so they start together and are awaited in section order: an uncached brief
 * costs the slowest source, not the sum. Every read races one shared deadline
 * (`options.budgetMs`); a read that misses it is a failed read, no different
 * from a store that threw.
 *
 * `noteRefreshAt` receives the soonest lease expiry or reverify time the text
 * depends on, so a cache can drop the brief when that moment arrives.
 * `noteReadFailed` runs once per source whose read threw or timed out, in
 * section order, after every read has settled. The text is still returned —
 * a partial brief beats a blocked prompt — but a cache must not store it, or
 * the outage would outlive the store.
 */
export async function composeBrief(
	request: BriefRequest,
	sources: BriefSources,
	noteRefreshAt?: (at: number | null) => void,
	noteReadFailed?: (source: BriefSource) => void,
	options: BriefOptions = {},
): Promise<string> {
	const { repo = null, branch = null, graph_id: graphId = null, surface } = request;
	const now = options.now ?? Date.now;
	const budgetMs = options.budgetMs ?? 0;
	const windowDays = options.recentWindowDays ?? DEFAULT_RECENT_WINDOW_DAYS;
	const lines: string[] = [];
	const deadlines: Array<string | null | undefined> = [];
	const failed = new Set<BriefSource>();
	const failOpen = <T>(what: BriefSource, fallback: T): ((cause: unknown) => T) => {
		return (cause) => {
			failed.add(what);
			return swallow(what, fallback)(cause);
		};
	};
	const deadline = sharedDeadline(budgetMs);
	// Start a read now, under the deadline, already failed open. A source whose
	// call throws synchronously (a fake, a client refusing before the socket) is
	// a failed read too, not an exception out of the brief.
	const start = <T>(what: BriefSource, read: () => Promise<T>, fallback: T): Promise<T> => {
		let flight: Promise<T>;
		try {
			flight = read();
		} catch (cause) {
			flight = Promise.reject(cause);
		}
		return deadline.race(flight).catch(failOpen(what, fallback));
	};

	// All four reads leave now; the sections below await them in order.
	const { index, greptime } = sources;
	const graphRead = index && graphId ? start("graph", () => index.getGraph(graphId), null as GraphView | null) : null;
	// Recent actions in this repo, from any surface. The repo is matched in the form
	// the write path stores it, not as the caller spelled it — see normalizeIdentifier.
	// Bounded in time so an uncached brief never scans the repo's whole history,
	// and in wall time by the same budget the deadline enforces, so a stalled
	// ledger is released by the client itself rather than left running. With no
	// budget the client's own default timeout applies.
	const actionsRead =
		greptime && repo
			? start(
					"recent actions",
					() => greptime.sql(recentActionsSql(repo, now() - windowDays * DAY_MS), budgetMs > 0 ? budgetMs : undefined),
					[] as Array<Record<string, unknown>>,
				)
			: null;
	// Other graphs open in this repo.
	const othersRead = index && repo ? start("open graphs", () => index.openGraphs(repo, graphId ?? undefined), [] as GraphView[]) : null;
	// Warnings and decisions worth carrying into this session.
	const memoryRead = index ? start("memory", () => index.memoryForBrief(repo, graphId, undefined, { surface }), [] as MemoryEntry[]) : null;

	const heading = [repo ?? "unknown repo", branch ? `@ ${branch}` : null, graphId ? `— ${graphId}` : null]
		.filter(Boolean)
		.join(" ");
	lines.push(`## Substrate brief: ${heading}`);

	const graph: GraphView | null = graphRead ? await graphRead : null;

	if (graph) {
		const summary = [
			graph.status ? graph.status : "status unknown",
			graph.surface ? `Agent ${graph.surface}` : null,
			graph.pr_url ? `PR ${graph.pr_url}` : "PR none yet",
		]
			.filter(Boolean)
			.join(" · ");
		lines.push(summary);
		if (graph.nodes.length > 0) {
			// Not `map(describeNode)`: map would pass the array index as the `now`
			// argument, and every lease would read as live against a clock at epoch 0.
			lines.push(`Nodes: ${graph.nodes.map((node) => describeNode(node)).join(" · ")}`);
			for (const node of graph.nodes) deadlines.push(node.lease_expires_at);
		}
	} else if (graphId) {
		lines.push("This graph is not in the index yet.");
	}

	if (actionsRead) {
		const rows = await actionsRead;
		if (rows.length > 0) {
			lines.push("", `Last ${rows.length} agent action${rows.length === 1 ? "" : "s"} in this repo`);
			for (const row of rows) {
				const where = row.node_id ? ` (${row.node_id}${row.step ? ` step ${row.step}` : ""})` : "";
				lines.push(`- ${clock(row.ts)} ${String(row.surface).padEnd(12)} ${String(row.summary)}${where}`);
			}
		}
	}

	if (othersRead) {
		const others = await othersRead;
		if (others.length > 0) {
			const described = others
				.slice(0, 4)
				.map((other) => {
					// Live leases only. A graph whose every lease has lapsed has nobody
					// on it, and counting those as started would make the repo look busier
					// than it is — which is the reading that stops an agent picking work up.
					const started = other.nodes.filter((n) => leaseState(leaseSnapshot(n), Date.now()) === "held").length;
					const parts = [
						other.surface,
						other.status,
						started > 0 ? `${started} node${started === 1 ? "" : "s"} held` : null,
					].filter(Boolean);
					for (const node of other.nodes) deadlines.push(node.lease_expires_at);
					return `${other.graph_id} (${parts.join(", ")})`;
				})
				.join(" · ");
			lines.push("", `Other open graphs here: ${described}`);
		}
	}

	const memory: MemoryEntry[] = memoryRead ? await memoryRead : [];
	const warnings = memory.filter((entry) => entry.kind === "warning");
	const decisions = memory.filter((entry) => entry.kind === "decision");
	if (decisions.length > 0) {
		lines.push("", "Decisions in force");
		for (const entry of decisions.slice(0, 4)) {
			const version = entry.version > 1 ? `, v${entry.version}` : "";
			lines.push(`- ${entry.text} (${entry.writer}, ${entry.trust}${version})${staleness(entry)}`);
		}
	}
	if (warnings.length > 0) {
		lines.push("", "Warnings");
		for (const entry of warnings.slice(0, 4)) {
			lines.push(`- ${entry.text} (${entry.writer}, ${relativeTime(entry.created)})${staleness(entry)}`);
		}
	}

	for (const entry of memory) {
		if (!entry.needs_reverification) deadlines.push(entry.reverify_after);
		// A cached brief must not outlive an entry's lifetime either: at `expires_at`
		// the index would hide (enforce) or mark (report) it, and the brief should too.
		if (entry.expired !== true) deadlines.push(entry.expires_at);
	}

	if (lines.length === 1) {
		lines.push(`No substrate history for this repo yet. You are the first ${surface} session here.`);
	}

	deadline.clear();
	for (const source of BRIEF_SOURCES) {
		if (failed.has(source)) noteReadFailed?.(source);
	}
	noteRefreshAt?.(earliestRefreshAt(deadlines));
	return lines.join("\n");
}

/**
 * The recent-actions statement. Exported so a test can read the bound without
 * a ledger; the SQL itself stays in this file (store lock). `since` is the
 * ISO form `queryEvents` already compares `ts` against on the live store.
 */
export function recentActionsSql(repo: string, sinceMs: number): string {
	return `SELECT "ts", "surface", "summary", "node_id", "step" FROM "agent_events"
				 WHERE "repo" = ${quote(normalizeIdentifier(repo) ?? repo)} AND "kind" NOT IN ('session.start','session.end')
				 AND "ts" >= ${quote(new Date(sinceMs).toISOString())}
				 ORDER BY "ts" DESC LIMIT ${RECENT_ACTION_LIMIT}`;
}
