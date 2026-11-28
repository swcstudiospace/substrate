/**
 * `SessionRegistry` (phase 83, E1): which sessions are live for which worktree, as a view over the tables
 * the substrate already writes — `graph_nodes` leases (`index-store.ts:393`), `live_session_bindings`
 * (`index-store.ts:902`) and the `worktrees` registry (`index-store.ts:756`). No schema migration, no new
 * store: this module only reads, joins in memory, and sorts.
 *
 * Three jobs, kept apart so the decisions test without a database:
 *
 * - {@link buildSessionRegistry} and {@link detectSessionConflicts} are pure: they join rows into a
 *   deterministic registry and name every `(worktree, file)` pair two distinct live sessions touch.
 * - {@link SessionRegistry} is the gate-aware reader: a store failure returns the last-known snapshot with
 *   `degraded: true` instead of throwing (the fabric rule, CONTEXT phase 83).
 * - {@link SessionRegistryStore} is the port. `MemorySessionRegistry` is the in-memory adapter for tests;
 *   `PgSessionRegistry` is the Postgres one behind `IndexStore.sessionRegistry()`.
 *
 * Liveness mirrors the readers that already exist: a binding is live while unclosed and unexpired, a lease
 * while `leaseState` says `"held"` (`lease.ts:120`), a worktree while freshly reported (the registry TTL,
 * `worktree-registry.ts:33`). Security: entries never carry a `lease_id` — only the holder may see one
 * (`lease.ts:433`), and a reader that learned it could release a node it never held.
 */
import type { SQL } from "bun";
import { DEFAULT_WORKTREE_REGISTRY_TTL_S } from "./worktree-registry.ts";
import { decideClaim, decideRelease, leaseState, type ClaimDecision, type LeaseHolder, type LeaseSnapshot, type ReleaseDecision } from "./lease.ts";
import type { Surface } from "./types.ts";

/** One `graph_nodes` row a registry read needs: the holder columns and the lease columns, nothing else. */
export interface RegistryGraphNode {
	graph_id: string;
	node_id: string;
	claimed_by: Surface | null;
	claim_session: string | null;
	claimed_at: string | Date | null;
	lease_expires_at: string | Date | null;
	lease_heartbeat_at: string | Date | null;
	lease_epoch: number;
}

/** One `live_session_bindings` row a registry read needs. `closed_at` set means the session is terminal; `expires_at` is its TTL. */
export interface RegistryLiveBinding {
	session_id: string;
	owner_surface: string;
	repo_id: string;
	expires_at: string | Date | null;
	closed_at: string | Date | null;
}

/** One `worktrees` row a registry read needs, with the paths it last reported touching (`changed_files`, `index-store.ts:880`). */
export interface RegistryWorktree {
	host: string;
	path: string;
	repo: string;
	branch: string | null;
	session_id: string | null;
	graph_id: string | null;
	last_seen_at: string | Date | null;
	files: string[] | null;
	files_truncated: boolean;
}

/** Three bounded reads, the exact rows the join needs. */
export interface RegistryRows {
	nodes: readonly RegistryGraphNode[];
	bindings: readonly RegistryLiveBinding[];
	worktrees: readonly RegistryWorktree[];
}

/** Bounds one read may return. Same order of magnitude as the worktree listing's own caps (`worktree-registry.ts:39`). */
export const REGISTRY_NODES_MAX = 1000;
export const REGISTRY_BINDINGS_MAX = 1000;
export const REGISTRY_WORKTREES_MAX = 500;

/** One live session for one worktree (or for no worktree yet), with the files it touches. Proof-free: no `lease_id`, no token. */
export interface RegistryEntry {
	session_id: string;
	surface: Surface | null;
	repo: string | null;
	worktree_path: string | null;
	graph_id: string | null;
	node_id: string | null;
	lease_state: "held" | null;
	epoch: number | null;
	expires_at: string | null;
	files: readonly string[];
	files_truncated: boolean;
}

/** One `(worktree, file)` pair two or more live sessions touch, with the sessions named in sorted order. */
export interface SessionConflict {
	worktree_path: string;
	file: string;
	session_ids: readonly string[];
}

export interface SessionRegistrySnapshot {
	entries: readonly RegistryEntry[];
	conflicts: readonly SessionConflict[];
	as_of: string;
	degraded: boolean;
}

export interface BuildOptions {
	/** How old a worktree's `last_seen_at` may be and still count as live. Defaults to the registry TTL. */
	worktreeTtlMs?: number;
}

export interface SessionRegistryStore {
	/** One bounded read of the three tables. */
	snapshot(): Promise<RegistryRows>;
}

const byCodeUnit = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const isoOrNull = (value: string | Date | number | null | undefined): string | null =>
	value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);

function millis(value: string | Date | number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function leaseSnapshotOf(node: RegistryGraphNode): LeaseSnapshot {
	return {
		lease_id: null,
		surface: node.claimed_by,
		session_id: node.claim_session,
		claimed_at: node.claimed_at,
		heartbeat_at: node.lease_heartbeat_at,
		expires_at: node.lease_expires_at,
		epoch: node.lease_epoch,
	};
}

/** A binding counts while it is open and its TTL has not run out. `state` (ACTIVE/PAUSED/…) is deliberately not a filter: a paused session is still live. */
function isLiveBinding(binding: RegistryLiveBinding, nowMs: number): boolean {
	if (binding.closed_at !== null && binding.closed_at !== undefined) return false;
	const expires = millis(binding.expires_at);
	return expires !== null && expires > nowMs;
}

/**
 * Join rows into the live-session registry. A session is live when any of its three footprints is live:
 * an unexpired open binding, a held node lease, or a freshly reported worktree attributing it. Output is
 * sorted by `(session_id, worktree_path, graph_id, node_id)` code units, nulls as `""`, so two readers of
 * the same rows build the same registry byte for byte. The input is not modified.
 */
export function buildSessionRegistry(rows: RegistryRows, nowMs: number, options: BuildOptions = {}): RegistryEntry[] {
	const worktreeTtlMs = options.worktreeTtlMs ?? DEFAULT_WORKTREE_REGISTRY_TTL_S * 1000;
	const entries: RegistryEntry[] = [];
	const seen = new Set<string>();

	const keyOf = (sessionId: string, worktreePath: string | null, graphId: string | null, nodeId: string | null): string =>
		[sessionId, worktreePath ?? "", graphId ?? "", nodeId ?? ""].join("\0");

	const emit = (entry: RegistryEntry): void => {
		const key = keyOf(entry.session_id, entry.worktree_path, entry.graph_id, entry.node_id);
		if (seen.has(key)) return;
		seen.add(key);
		entries.push(entry);
	};

	const liveWorktreesBySession = new Map<string, RegistryWorktree[]>();
	for (const worktree of rows.worktrees) {
		if (worktree.session_id === null) continue;
		const seenAt = millis(worktree.last_seen_at);
		if (seenAt === null || nowMs - seenAt > worktreeTtlMs) continue;
		const list = liveWorktreesBySession.get(worktree.session_id);
		if (list) list.push(worktree);
		else liveWorktreesBySession.set(worktree.session_id, [worktree]);
	}

	const heldNodesBySession = new Map<string, RegistryGraphNode[]>();
	for (const node of rows.nodes) {
		if (node.claim_session === null || node.claimed_by === null) continue;
		if (leaseState(leaseSnapshotOf(node), nowMs) !== "held") continue;
		const list = heldNodesBySession.get(node.claim_session);
		if (list) list.push(node);
		else heldNodesBySession.set(node.claim_session, [node]);
	}

	const liveBindingsBySession = new Map<string, RegistryLiveBinding>();
	for (const binding of rows.bindings) {
		if (isLiveBinding(binding, nowMs)) liveBindingsBySession.set(binding.session_id, binding);
	}

	const sessionIds = new Set<string>([...liveWorktreesBySession.keys(), ...heldNodesBySession.keys(), ...liveBindingsBySession.keys()]);
	for (const sessionId of sessionIds) {
		const binding = liveBindingsBySession.get(sessionId);
		const nodes = [...(heldNodesBySession.get(sessionId) ?? [])].sort((a, b) => byCodeUnit(a.graph_id, b.graph_id) || byCodeUnit(a.node_id, b.node_id));
		const worktrees = [...(liveWorktreesBySession.get(sessionId) ?? [])].sort((a, b) => byCodeUnit(a.path, b.path));
		const surface: Surface | null = binding ? (binding.owner_surface as Surface) : (nodes[0]?.claimed_by ?? null);

		if (worktrees.length === 0 && nodes.length === 0) {
			emit({
				session_id: sessionId,
				surface,
				repo: binding !== null && binding !== undefined ? binding.repo_id : null,
				worktree_path: null,
				graph_id: null,
				node_id: null,
				lease_state: null,
				epoch: null,
				expires_at: null,
				files: [],
				files_truncated: false,
			});
			continue;
		}

		for (const worktree of worktrees) {
			const files = [...new Set(worktree.files ?? [])].sort(byCodeUnit);
			const matching = nodes.filter((node) => worktree.graph_id !== null && node.graph_id === worktree.graph_id);
			if (matching.length === 0) {
				emit({
					session_id: sessionId,
					surface,
					repo: worktree.repo,
					worktree_path: worktree.path,
					graph_id: worktree.graph_id,
					node_id: null,
					lease_state: null,
					epoch: null,
					expires_at: null,
					files,
					files_truncated: worktree.files_truncated,
				});
				continue;
			}
			for (const node of matching) {
				emit({
					session_id: sessionId,
					surface,
					repo: worktree.repo,
					worktree_path: worktree.path,
					graph_id: node.graph_id,
					node_id: node.node_id,
					lease_state: "held",
					epoch: node.lease_epoch,
					expires_at: isoOrNull(node.lease_expires_at),
					files,
					files_truncated: worktree.files_truncated,
				});
			}
		}

		// Held nodes whose graph no reported worktree names still name the session; their worktree is unknown, so they never conflict.
		const attachedGraphs = new Set(worktrees.flatMap((worktree) => (worktree.graph_id === null ? [] : [worktree.graph_id])));
		for (const node of nodes) {
			if (attachedGraphs.has(node.graph_id)) continue;
			emit({
				session_id: sessionId,
				surface,
				repo: binding !== null && binding !== undefined ? binding.repo_id : null,
				worktree_path: null,
				graph_id: node.graph_id,
				node_id: node.node_id,
				lease_state: "held",
				epoch: node.lease_epoch,
				expires_at: isoOrNull(node.lease_expires_at),
				files: [],
				files_truncated: false,
			});
		}
	}

	entries.sort(
		(a, b) =>
			byCodeUnit(a.session_id, b.session_id) ||
			byCodeUnit(a.worktree_path ?? "", b.worktree_path ?? "") ||
			byCodeUnit(a.graph_id ?? "", b.graph_id ?? "") ||
			byCodeUnit(a.node_id ?? "", b.node_id ?? ""),
	);
	return entries;
}

/**
 * Every `(worktree, file)` pair that two or more distinct live sessions touch, sorted by
 * `(worktree_path, file)`. Read-only and deterministic: entries alone decide, so any observer of the same
 * registry names the same conflicts, just like the planning detector (`planning/conflicts.ts:95`).
 */
export function detectSessionConflicts(entries: readonly RegistryEntry[]): SessionConflict[] {
	const sessionsByKey = new Map<string, { worktree_path: string; file: string; sessions: Set<string> }>();
	for (const entry of entries) {
		if (entry.worktree_path === null) continue;
		for (const file of entry.files) {
			const key = `${entry.worktree_path}\0${file}`;
			const group = sessionsByKey.get(key);
			if (group) group.sessions.add(entry.session_id);
			else sessionsByKey.set(key, { worktree_path: entry.worktree_path, file, sessions: new Set([entry.session_id]) });
		}
	}
	return [...sessionsByKey.values()]
		.filter((group) => group.sessions.size >= 2)
		.map((group) => ({ worktree_path: group.worktree_path, file: group.file, session_ids: [...group.sessions].sort(byCodeUnit) }))
		.sort((a, b) => byCodeUnit(a.worktree_path, b.worktree_path) || byCodeUnit(a.file, b.file));
}

/**
 * Take (or re-take) the operator lease arm for one holder. Thin wrapper over the lease algebra so every
 * caller decides through `decideClaim`: a stranger's token surface renewing somebody else's hold is
 * `denied` with reason `not-holder` (`lease.ts:247`), never a second operator.
 */
export function registryTake(snapshot: LeaseSnapshot, holder: LeaseHolder, caller: Surface | null): ClaimDecision {
	return decideClaim(snapshot, { surface: holder.surface, session_id: holder.session_id, ttl_seconds: 900, caller }, Date.now());
}

/**
 * Release the operator lease arm. Only the holder's fencing token lands: without it the decision refuses
 * `lease-id-required` (`lease.ts:413`) — that refusal is the proof that only the operator session mutates
 * steering for its worktree, without a new auth layer.
 */
export function registryRelease(snapshot: LeaseSnapshot, request: { lease_id?: string | null; force?: boolean }, caller: Surface | null): ReleaseDecision {
	return decideRelease(snapshot, { ...request, caller }, Date.now());
}

/** Gate-aware reader: a store failure degrades to last-known, never to a throw. One instance per process keeps the last-known snapshot. */
export class SessionRegistry {
	private lastKnown: SessionRegistrySnapshot | null = null;

	constructor(
		private readonly store: SessionRegistryStore,
		private readonly options: BuildOptions = {},
	) {}

	async current(nowMs: number = Date.now()): Promise<SessionRegistrySnapshot> {
		try {
			const rows = await this.store.snapshot();
			const entries = buildSessionRegistry(rows, nowMs, this.options);
			const snapshot: SessionRegistrySnapshot = { entries, conflicts: detectSessionConflicts(entries), as_of: new Date(nowMs).toISOString(), degraded: false };
			this.lastKnown = snapshot;
			return snapshot;
		} catch {
			if (this.lastKnown !== null) return { ...this.lastKnown, degraded: true };
			return { entries: [], conflicts: [], as_of: new Date(nowMs).toISOString(), degraded: true };
		}
	}
}

/** Postgres adapter's way to run a call under the index plane's gate; `IndexStore` passes its own. */
export type RunUnderGate = <T>(op: string, fn: () => Promise<T>) => Promise<T>;

/** The Postgres adapter. Reads the three tables it joins; nothing is ever written here. */
export class PgSessionRegistry implements SessionRegistryStore {
	constructor(
		private readonly sql: SQL,
		private readonly run: RunUnderGate = (_op, fn) => fn(),
	) {}

	async snapshot(): Promise<RegistryRows> {
		return this.run("sessions.registry", async () => {
			const [nodeRows, bindingRows, worktreeRows] = await Promise.all([
				this.sql`select graph_id, node_id, claimed_by, claim_session, claimed_at, lease_expires_at, lease_heartbeat_at, lease_epoch from graph_nodes where claimed_by is not null and claim_session is not null order by graph_id, node_id limit ${REGISTRY_NODES_MAX}` as Promise<Array<Record<string, unknown>>>,
				this.sql`select session_id, owner_surface, repo_id, expires_at, closed_at from live_session_bindings where closed_at is null order by session_id limit ${REGISTRY_BINDINGS_MAX}` as Promise<Array<Record<string, unknown>>>,
				this.sql`select host, path, repo, branch, session_id, graph_id, last_seen_at, changed_files::text as changed_files_text, files_truncated from worktrees order by last_seen_at desc, host, path limit ${REGISTRY_WORKTREES_MAX}` as Promise<
					Array<Record<string, unknown>>
				>,
			]);
			return {
				nodes: nodeRows.map((row) => ({
					graph_id: String(row.graph_id),
					node_id: String(row.node_id),
					claimed_by: textOrNull(row.claimed_by) as Surface | null,
					claim_session: textOrNull(row.claim_session),
					claimed_at: isoOrNull(row.claimed_at as string | Date | null),
					lease_expires_at: isoOrNull(row.lease_expires_at as string | Date | null),
					lease_heartbeat_at: isoOrNull(row.lease_heartbeat_at as string | Date | null),
					lease_epoch: Number(row.lease_epoch ?? 0),
				})),
				bindings: bindingRows.map((row) => ({
					session_id: String(row.session_id),
					owner_surface: String(row.owner_surface),
					repo_id: String(row.repo_id),
					expires_at: isoOrNull(row.expires_at as string | Date | null),
					closed_at: isoOrNull(row.closed_at as string | Date | null),
				})),
				worktrees: worktreeRows.map((row) => ({
					host: String(row.host),
					path: String(row.path),
					repo: String(row.repo),
					branch: textOrNull(row.branch),
					session_id: textOrNull(row.session_id),
					graph_id: textOrNull(row.graph_id),
					last_seen_at: isoOrNull(row.last_seen_at as string | Date | null),
					files: filesFromText(row.changed_files_text),
					files_truncated: row.files_truncated === true,
				})),
			};
		});
	}
}

function filesFromText(value: unknown): string[] | null {
	if (typeof value !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return null;
		return [...new Set(parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))].sort(byCodeUnit);
	} catch {
		return null;
	}
}

/**
 * The registry in memory: the same contract as `PgSessionRegistry`, for tests and for callers with no index.
 * The arrays hold the rows exactly as read; ordering is the read's own, and the pure builders sort.
 */
export class MemorySessionRegistry implements SessionRegistryStore {
	private rows: RegistryRows = { nodes: [], bindings: [], worktrees: [] };
	reads = 0;

	seed(rows: RegistryRows): void {
		this.rows = {
			nodes: rows.nodes.map((node) => ({ ...node })),
			bindings: rows.bindings.map((binding) => ({ ...binding })),
			worktrees: rows.worktrees.map((worktree) => ({ ...worktree, files: worktree.files === null ? null : [...worktree.files] })),
		};
	}

	async snapshot(): Promise<RegistryRows> {
		this.reads += 1;
		return {
			nodes: this.rows.nodes.map((node) => ({ ...node })),
			bindings: this.rows.bindings.map((binding) => ({ ...binding })),
			worktrees: this.rows.worktrees.map((worktree) => ({ ...worktree, files: worktree.files === null ? null : [...worktree.files] })),
		};
	}
}

export type { ClaimDecision, ReleaseDecision };
