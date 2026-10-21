/**
 * Pure herdr reconciler and the version-2 state file.
 *
 * Snapshot is truth. A push never becomes an event by itself: the collector
 * diffs the current panes against this state. A missing file, or any file
 * that is not version 2, is a first run — seed silently, emit nothing.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	surfaceForHerdrAgent,
	transitionToEvent,
	type HerdrPane,
	type HerdrTransition,
} from "./herdr-map.ts";
import type { EventInput, Surface } from "../../mcp-server/src/types.ts";
import { graphIdForWorktree } from "./worktree-graph.ts";

export const HERDR_STATE_VERSION = 2 as const;

export interface HerdrPaneRecord {
	agent: string;
	surface: Surface;
	/** Last status that was actually emitted. Stays put across an `unknown` gap. */
	status: string;
	/** Last status the snapshot reported, including `unknown`. */
	raw_status: string;
	session_id: string;
	repo?: string;
	branch?: string;
	/** The graph whose worktree holds the pane's working directory (worktree-graph.ts). */
	graph_id?: string;
	started_at: string;
	pane_id: string;
	terminal_id: string;
}

export interface HerdrCounters {
	stored: number;
	refused: number;
	failed: number;
	unmapped: Record<string, number>;
}

export interface HerdrStateFile {
	version: typeof HERDR_STATE_VERSION;
	panes: Record<string, HerdrPaneRecord>;
	counters: HerdrCounters;
	/** Identity → agent id, so an unmapped pane is counted once. */
	seen_unmapped: Record<string, string>;
}

export interface PlannedTransition {
	identity: string;
	rowId: HerdrTransition["rowId"];
	event: EventInput;
	/** Set to keep the pane; omit to drop it (session.end). */
	pane?: HerdrPaneRecord;
}

export interface ReconcileResult {
	transitions: PlannedTransition[];
	/** Bookkeeping that emits nothing (unknown gaps, return to the same status). */
	silent: Array<{ identity: string; pane: HerdrPaneRecord }>;
	seen_unmapped: Record<string, string>;
	unmapped: Record<string, number>;
	/** Present only on a first-run seed. Save this and emit nothing. */
	seeded?: HerdrStateFile;
}

export interface ReconcileOptions {
	/** First run: write state for the current snapshot and emit nothing. */
	seed?: boolean;
	now?: string;
	/** Repo and branch for a pane. Runs Git, so it is called only where a transition needs it. */
	attribute?: (pane: HerdrPane) => { repo?: string; branch?: string };
	/** The graph a pane's directory names. Pure path work, checked on every snapshot. Defaults to `graphOfPane`. */
	graphOf?: (pane: HerdrPane) => string | undefined;
}

export function emptyHerdrState(): HerdrStateFile {
	return {
		version: HERDR_STATE_VERSION,
		panes: {},
		counters: { stored: 0, refused: 0, failed: 0, unmapped: {} },
		seen_unmapped: {},
	};
}

export function paneIdentity(paneId: string, terminalId: string): string {
	return `${paneId}|${terminalId}`;
}

export function defaultHerdrStatePath(env: NodeJS.ProcessEnv = process.env): string {
	return env.SUBSTRATE_COLLECTOR_STATE ?? "/var/lib/substrate/herdr-offsets.json";
}

function emptyCounters(): HerdrCounters {
	return { stored: 0, refused: 0, failed: 0, unmapped: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Own-property read of an unmapped total. A plain `map[agent] ?? 0` resolves
 * `constructor` through the prototype to a function, turning its total into
 * a string on the next bump.
 */
function unmappedCount(map: Record<string, number>, agent: string): number {
	const count = Object.prototype.hasOwnProperty.call(map, agent) ? map[agent] : 0;
	return typeof count === "number" ? count : 0;
}

/**
 * Own-property write of an unmapped total. A plain `map[agent] = n` invokes
 * the `__proto__` setter and creates no count; defining the data property
 * keeps arbitrary agent names as real keys. (`seen` needs no equivalent:
 * its keys are `paneId|terminalId` identities, which always contain `|` and
 * can never collide with a prototype name. Copies by spread are already
 * safe — spread defines data properties instead of assigning.)
 */
function setUnmappedCount(map: Record<string, number>, agent: string, count: number): void {
	Object.defineProperty(map, agent, { value: count, enumerable: true, configurable: true, writable: true });
}

function normalizeState(raw: Record<string, unknown>): HerdrStateFile {
	const panes: Record<string, HerdrPaneRecord> = {};
	if (isRecord(raw.panes)) {
		for (const [key, value] of Object.entries(raw.panes)) {
			if (!isRecord(value)) continue;
			if (typeof value.agent !== "string" || typeof value.pane_id !== "string" || typeof value.terminal_id !== "string") {
				continue;
			}
			const surface = surfaceForHerdrAgent(value.agent);
			if (!surface) continue;
			panes[key] = {
				agent: value.agent,
				surface,
				status: typeof value.status === "string" ? value.status : "unknown",
				raw_status: typeof value.raw_status === "string" ? value.raw_status : typeof value.status === "string" ? value.status : "unknown",
				session_id: typeof value.session_id === "string" ? value.session_id : `herdr:${value.terminal_id}:restored`,
				repo: typeof value.repo === "string" ? value.repo : undefined,
				branch: typeof value.branch === "string" ? value.branch : undefined,
				graph_id: typeof value.graph_id === "string" ? value.graph_id : undefined,
				started_at: typeof value.started_at === "string" ? value.started_at : new Date(0).toISOString(),
				pane_id: value.pane_id,
				terminal_id: value.terminal_id,
			};
		}
	}
	const counters = emptyCounters();
	if (isRecord(raw.counters)) {
		for (const key of ["stored", "refused", "failed"] as const) {
			const value = raw.counters[key];
			if (typeof value === "number" && Number.isFinite(value)) counters[key] = value;
		}
		if (isRecord(raw.counters.unmapped)) {
			for (const [agent, count] of Object.entries(raw.counters.unmapped)) {
				if (typeof count === "number" && Number.isFinite(count)) setUnmappedCount(counters.unmapped, agent, count);
			}
		}
	}
	const seen: Record<string, string> = {};
	if (isRecord(raw.seen_unmapped)) {
		for (const [identity, agent] of Object.entries(raw.seen_unmapped)) {
			if (typeof agent === "string") seen[identity] = agent;
		}
	}
	return { version: HERDR_STATE_VERSION, panes, counters, seen_unmapped: seen };
}

/** Load version 2, or report a first run for a missing or non-v2 file. */
export function loadHerdrState(path: string): { state: HerdrStateFile; firstRun: boolean } {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw) || raw.version !== HERDR_STATE_VERSION) return { state: emptyHerdrState(), firstRun: true };
		return { state: normalizeState(raw), firstRun: false };
	} catch {
		return { state: emptyHerdrState(), firstRun: true };
	}
}

/** Write version 2 by tmp + rename. Returns false when the write did not land. */
export function saveHerdrState(path: string, state: HerdrStateFile): boolean {
	const temporary = `${path}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(state)}\n`);
		renameSync(temporary, path);
		return true;
	} catch (cause) {
		try {
			unlinkSync(temporary);
		} catch {
			// The temporary file was never created, or is already gone.
		}
		try {
			process.stderr.write(`[herdr-collector] cannot persist state: ${String(cause)}\n`);
		} catch {
			// A closed stderr must not turn a save failure into a throw.
		}
		return false;
	}
}

/** The graph a pane's directory names. Pure path work: no Git, so it is safe on every snapshot. */
export function graphOfPane(pane: HerdrPane): string | undefined {
	return graphIdForWorktree(pane.cwd ?? pane.foreground_cwd) ?? undefined;
}

function graphFor(pane: HerdrPane, options: ReconcileOptions): string | undefined {
	return (options.graphOf ?? graphOfPane)(pane);
}

function attribute(pane: HerdrPane, options: ReconcileOptions): { repo?: string; branch?: string } {
	const cwd = pane.cwd ?? pane.foreground_cwd;
	if (!cwd || !options.attribute) return {};
	return options.attribute(pane);
}

function recordFor(pane: HerdrPane, agent: string, surface: Surface, now: string, options: ReconcileOptions): HerdrPaneRecord {
	const attr = attribute(pane, options);
	const raw = pane.agent_status ?? "unknown";
	return {
		agent,
		surface,
		status: raw,
		raw_status: raw,
		session_id: `herdr:${pane.terminal_id}:${now}`,
		repo: attr.repo,
		branch: attr.branch,
		graph_id: graphFor(pane, options),
		started_at: now,
		pane_id: pane.pane_id,
		terminal_id: pane.terminal_id ?? "",
	};
}

function planned(identity: string, transition: HerdrTransition, pane?: HerdrPaneRecord): PlannedTransition {
	return { identity, rowId: transition.rowId, event: transitionToEvent(transition), pane };
}

function startOf(identity: string, pane: HerdrPane, agent: string, surface: Surface, now: string, options: ReconcileOptions): PlannedTransition {
	const next = recordFor(pane, agent, surface, now, options);
	return planned(identity, {
		rowId: "herdr.agent_detected",
		surface,
		agent,
		pane_id: pane.pane_id,
		terminal_id: pane.terminal_id ?? "",
		session_id: next.session_id,
		repo: next.repo,
		branch: next.branch,
		graph_id: next.graph_id,
		status: next.status,
		herdr_type: "pane.agent_detected",
	}, next);
}

function endOf(identity: string, prev: HerdrPaneRecord, reason: "pane_gone" | "agent_released" | "graph_changed"): PlannedTransition {
	return planned(identity, {
		rowId: "herdr.pane_exited",
		surface: prev.surface,
		agent: prev.agent,
		pane_id: prev.pane_id,
		terminal_id: prev.terminal_id,
		session_id: prev.session_id,
		repo: prev.repo,
		branch: prev.branch,
		graph_id: prev.graph_id,
		end_reason: reason,
		herdr_type: "pane.exited",
	});
}

/**
 * Diff `panes` against `state`.
 *
 * `unknown` is recorded and not emitted on its own. Leaving it compares
 * against the last emitted status, so working → unknown → idle is one note
 * and working → unknown → working is silence.
 */
export function reconcile(state: HerdrStateFile, panes: readonly HerdrPane[], options: ReconcileOptions = {}): ReconcileResult {
	const now = options.now ?? new Date().toISOString();
	if (options.seed) {
		const seeded = emptyHerdrState();
		for (const pane of panes) {
			if (!pane.pane_id || !pane.terminal_id) continue;
			const identity = paneIdentity(pane.pane_id, pane.terminal_id);
			const agent = pane.agent ?? undefined;
			if (!agent) continue;
			const surface = surfaceForHerdrAgent(agent);
			if (!surface) {
				seeded.seen_unmapped[identity] = agent;
				setUnmappedCount(seeded.counters.unmapped, agent, unmappedCount(seeded.counters.unmapped, agent) + 1);
				continue;
			}
			seeded.panes[identity] = recordFor(pane, agent, surface, now, options);
		}
		return { transitions: [], silent: [], seen_unmapped: seeded.seen_unmapped, unmapped: seeded.counters.unmapped, seeded };
	}

	const transitions: PlannedTransition[] = [];
	const silent: Array<{ identity: string; pane: HerdrPaneRecord }> = [];
	const seen = { ...state.seen_unmapped };
	const unmapped = { ...state.counters.unmapped };
	const live = new Set<string>();

	for (const pane of panes) {
		if (!pane.pane_id || !pane.terminal_id) continue;
		const identity = paneIdentity(pane.pane_id, pane.terminal_id);
		live.add(identity);
		const prev = state.panes[identity];
		const agent = pane.agent ?? undefined;
		if (!agent) {
			if (prev) transitions.push(endOf(identity, prev, "agent_released"));
			delete seen[identity];
			continue;
		}
		const surface = surfaceForHerdrAgent(agent);
		if (!surface) {
			if (seen[identity] !== agent) {
				setUnmappedCount(unmapped, agent, unmappedCount(unmapped, agent) + 1);
				seen[identity] = agent;
			}
			if (prev) transitions.push(endOf(identity, prev, "agent_released"));
			continue;
		}
		delete seen[identity];
		if (!prev) {
			transitions.push(startOf(identity, pane, agent, surface, now, options));
			continue;
		}
		if (prev.agent !== agent) {
			transitions.push(endOf(identity, prev, "agent_released"));
			transitions.push(startOf(identity, pane, agent, surface, now, options));
			continue;
		}
		// One session never spans two graphs. A directory that names another graph, or none, ends this session and
		// starts a new one. That also closes a session that began before graph attribution existed. A snapshot that
		// reports no directory says nothing about the graph, so it keeps the session as it is.
		if ((pane.cwd ?? pane.foreground_cwd) && graphFor(pane, options) !== prev.graph_id) {
			transitions.push(endOf(identity, prev, "graph_changed"));
			transitions.push(startOf(identity, pane, agent, surface, now, options));
			continue;
		}
		const raw = pane.agent_status ?? prev.raw_status;
		if (raw === "unknown") {
			if (prev.raw_status !== "unknown") silent.push({ identity, pane: { ...prev, raw_status: "unknown" } });
			continue;
		}
		if (prev.status !== raw) {
			const next: HerdrPaneRecord = { ...prev, status: raw, raw_status: raw, surface };
			const attr = attribute(pane, options);
			next.repo = attr.repo;
			next.branch = attr.branch;
			transitions.push(planned(identity, {
				rowId: "herdr.status_changed",
				surface,
				agent,
				pane_id: pane.pane_id,
				terminal_id: pane.terminal_id,
				session_id: prev.session_id,
				repo: next.repo,
				branch: next.branch,
				graph_id: next.graph_id,
				status: raw,
				previous_status: prev.status,
				herdr_type: "pane.agent_status_changed",
			}, next));
			continue;
		}
		if (prev.raw_status !== raw) silent.push({ identity, pane: { ...prev, raw_status: raw, surface } });
	}

	for (const [identity, prev] of Object.entries(state.panes)) {
		if (!live.has(identity)) transitions.push(endOf(identity, prev, "pane_gone"));
	}
	for (const identity of Object.keys(seen)) {
		if (!live.has(identity)) delete seen[identity];
	}

	return { transitions, silent, seen_unmapped: seen, unmapped };
}

export type TransitionOutcome = "stored" | "refused" | "failed" | "spooled" | "skipped";

/**
 * Apply a pass. A failed transition does not advance, and neither does any
 * later transition for that same identity (`skipped` — not counted, not
 * applied). Stored and refused both advance. `spooled` advances too: the
 * event is parked in the event spool with its own `ts` and key, so emitting it
 * again next pass would write a second row; it is counted `failed` because the
 * live attempt did fail. Silent bookkeeping applies
 * only for identities this pass did not try to emit.
 */
export function commitReconcile(
	prev: HerdrStateFile,
	result: ReconcileResult,
	outcomes: readonly TransitionOutcome[],
): HerdrStateFile {
	if (result.seeded) return result.seeded;
	const emitted = new Set(result.transitions.map((transition) => transition.identity));
	const panes = { ...prev.panes };
	for (const update of result.silent) {
		if (!emitted.has(update.identity)) panes[update.identity] = update.pane;
	}
	const counters: HerdrCounters = {
		stored: prev.counters.stored,
		refused: prev.counters.refused,
		failed: prev.counters.failed,
		unmapped: { ...result.unmapped },
	};
	const stopped = new Set<string>();
	result.transitions.forEach((transition, index) => {
		if (stopped.has(transition.identity)) return;
		const outcome = outcomes[index] ?? "failed";
		if (outcome === "skipped") {
			stopped.add(transition.identity);
			return;
		}
		if (outcome === "failed") {
			counters.failed += 1;
			stopped.add(transition.identity);
			return;
		}
		if (outcome === "stored") counters.stored += 1;
		else if (outcome === "spooled") counters.failed += 1;
		else counters.refused += 1;
		if (transition.pane) panes[transition.identity] = transition.pane;
		else delete panes[transition.identity];
	});
	return { version: HERDR_STATE_VERSION, panes, counters, seen_unmapped: { ...result.seen_unmapped } };
}
