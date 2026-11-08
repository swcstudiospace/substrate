/**
 * The nexus view of a governed memory entry (v1.6, phase 60).
 *
 * A row of `memory_entries` already has everything a verifiable identity needs: a stable `id`, a
 * `version`, the `supersedes` / `superseded_by` links and an `entry_hash` over the governed content. What
 * it lacks is one place that says what those mean together. This module is that place, and it is pure: no
 * I/O, no clock, no store. It takes `MemoryEntry` values and returns plain data.
 *
 * Three things live here:
 *
 * - `toNexusRecord`: the identity and provenance view (never the content).
 * - `toCapsuleRecord`: the same plus the content, for a capsule; a forgotten entry is NEVER exported as
 *   content, only as a tombstone.
 * - `supersessionChain`: the walk over `supersedes` / `superseded_by`, cycle-safe and bounded, which stops
 *   at a forgotten marker.
 *
 * The content hash is the gate's `entry_hash` and nothing else. `entryHashFor` below calls the gate's own
 * `contentHash` (exported from `memory-write.ts`) with the gate's v1 and v2 preimages, so the two cannot drift;
 * `memory-record.test.ts` still pins the call shapes against the gate's source.
 */
import { contentHash, HASH_TENANT, HASH_VERSION_MARKER } from "./memory-write.ts";
import type { Actor, MemoryEntry, MemoryKind, Trust } from "./types.ts";

/**
 * The marker the memory-forget path writes into `superseded_by`. A value that starts with it is a terminal
 * tombstone, not a pointer at another entry: following it would look for a row that does not exist.
 */
export const FORGOTTEN_PREFIX = "forgotten:";

/** Most hops the chain walk takes in either direction. A real chain is a handful of versions. */
export const MAX_CHAIN_HOPS = 256;

type NexusState = "current" | "superseded" | "forgotten";

interface NexusProvenance {
	writer: string;
	actor: Actor;
	trust: Trust;
	/** The ledger event the write rested on; null when the write named none. */
	source_event: string | null;
	session_id: string | null;
	graph_id: string | null;
	repo: string | null;
	/** When the entry was created, ISO as the index stores it. */
	created: string;
}

/** The identity and provenance view of one memory entry. It carries no content. */
interface NexusRecord {
	id: string;
	version: number;
	supersedes: string | null;
	/** The entry that replaced this one. Null for a current entry and for a forgotten one (see `forgotten_by`). */
	superseded_by: string | null;
	/** The tail of a `forgotten:<x>` marker, or null. A forgotten entry has a marker and no successor. */
	forgotten_by: string | null;
	state: NexusState;
	provenance: NexusProvenance;
	/** The gate's `entry_hash`, verbatim. */
	content_hash: string;
}

/** The fields the gate hashes, and therefore the only content a capsule record carries. */
export interface NexusContent {
	scope: string;
	kind: MemoryKind;
	subject: string | null;
	text: string;
}

/** A record with its content: what a capsule holds for an entry that has not been redacted or forgotten. */
export interface CapsuleRecord extends NexusRecord {
	content: NexusContent;
}

/** A record whose content is gone. The hash stays, so the capsule root still verifies. */
export interface TombstoneRecord {
	id: string;
	content_hash: string;
	tombstone: { reason: string; at: string };
}

interface NexusContext {
	/** Ids the caller knows are forgotten even though the row carries no marker. */
	forgotten?: ReadonlySet<string>;
}

interface CapsuleContext extends NexusContext {
	/** The clock, for the `at` of the tombstone a forgotten entry becomes. Injected, never read from the system. */
	now: () => Date;
}

/** Which hash version a stored `entry_hash` matches, or null when it matches neither. */
type HashMatch = "v1" | "v2";

function nullable(value: string | undefined | null): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The two digests the gate may have stored for this content. v1 is the historical preimage; v2 adds the
 * version marker and tenant. `SUBSTRATE_HASH_VERSION` picks which a new row stores, and a row written under
 * either must stay verifiable after the flag flips, so a check accepts both.
 */
export function entryHashFor(content: NexusContent, writer: string): { v1: string; v2: string } {
	const base = { scope: content.scope, kind: content.kind, subject: content.subject, text: content.text, writer };
	return {
		v1: contentHash(base),
		v2: contentHash({ ...base, hv: HASH_VERSION_MARKER, tenant: HASH_TENANT }),
	};
}

/** `v1` or `v2` when `stored` is the digest of this content under that preimage, else null. */
export function matchEntryHash(content: NexusContent, writer: string, stored: string): HashMatch | null {
	const { v1, v2 } = entryHashFor(content, writer);
	if (stored === v1) return "v1";
	if (stored === v2) return "v2";
	return null;
}

/** The content the gate hashed for `entry`. A missing subject is `null` in the preimage, never absent. */
export function contentOf(entry: MemoryEntry): NexusContent {
	return { scope: entry.scope, kind: entry.kind, subject: entry.subject ?? null, text: entry.text };
}

/** Whether a `superseded_by` value is a forgotten marker rather than a pointer. */
export function isForgottenMarker(value: string | null | undefined): boolean {
	return typeof value === "string" && value.startsWith(FORGOTTEN_PREFIX);
}

function stateOf(entry: MemoryEntry, ctx: NexusContext | undefined): { state: NexusState; forgottenBy: string | null } {
	const marker = entry.superseded_by;
	if (isForgottenMarker(marker)) return { state: "forgotten", forgottenBy: (marker as string).slice(FORGOTTEN_PREFIX.length) };
	if (ctx?.forgotten?.has(entry.id)) return { state: "forgotten", forgottenBy: null };
	return { state: nullable(marker) === null ? "current" : "superseded", forgottenBy: null };
}

/** The identity and provenance view of `entry`. Carries no content. */
export function toNexusRecord(entry: MemoryEntry, ctx?: NexusContext): NexusRecord {
	const { state, forgottenBy } = stateOf(entry, ctx);
	return {
		id: entry.id,
		version: entry.version,
		supersedes: nullable(entry.supersedes),
		superseded_by: state === "forgotten" ? null : nullable(entry.superseded_by),
		forgotten_by: forgottenBy,
		state,
		provenance: {
			writer: entry.writer,
			actor: entry.actor,
			trust: entry.trust,
			source_event: nullable(entry.source_event),
			session_id: nullable(entry.session_id),
			graph_id: nullable(entry.graph_id),
			repo: nullable(entry.repo),
			created: entry.created,
		},
		content_hash: entry.entry_hash,
	};
}

/**
 * What a capsule holds for `entry`. A forgotten entry becomes a tombstone: an export must never carry the
 * content a forget removed, even if the row still has it.
 */
export function toCapsuleRecord(entry: MemoryEntry, ctx: CapsuleContext): CapsuleRecord | TombstoneRecord {
	const record = toNexusRecord(entry, ctx);
	if (record.state === "forgotten") {
		return {
			id: record.id,
			content_hash: record.content_hash,
			tombstone: { reason: "forgotten", at: ctx.now().toISOString() },
		};
	}
	return { ...record, content: contentOf(entry) };
}

/** The ends a chain walk can reach. */
type ChainBack = "root" | "missing" | "cycle" | "truncated";
type ChainForward = "current" | "forgotten" | "missing" | "cycle" | "truncated";

interface SupersessionChain {
	/** The id asked for. */
	id: string;
	/** Oldest to newest, including `id`. Empty when `id` is not in the rows. */
	chain: string[];
	back: ChainBack;
	forward: ChainForward;
	/** Ids a link names that the rows do not hold, in the order met. */
	dangling: string[];
	/** The `forgotten:<x>` marker the walk stopped at, or null. */
	forgotten_marker: string | null;
}

type ChainRow = Pick<MemoryEntry, "id" | "supersedes" | "superseded_by">;

/**
 * The versions of one claim, oldest first, around `id`.
 *
 * Walks `supersedes` back to the first version and `superseded_by` forward to the latest. Pure, and safe on
 * hostile data: every id is visited at most once (a cycle ends the walk and is reported, never followed
 * again), each direction is bounded by `MAX_CHAIN_HOPS`, and a `forgotten:` marker is a terminal state, not
 * a pointer. A link at a row the input does not hold is reported in `dangling` and ends that direction.
 */
export function supersessionChain(rows: readonly ChainRow[], id: string): SupersessionChain {
	const byId = new Map<string, ChainRow>();
	for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
	const start = byId.get(id);
	if (!start) return { id, chain: [], back: "missing", forward: "missing", dangling: [id], forgotten_marker: null };

	const seen = new Set<string>([id]);
	const dangling: string[] = [];
	const older: string[] = [];
	let back: ChainBack = "root";
	let cursor = start;
	for (let hops = 0; ; hops++) {
		const prev = nullable(cursor.supersedes);
		if (prev === null) break;
		if (seen.has(prev)) {
			back = "cycle";
			break;
		}
		if (hops >= MAX_CHAIN_HOPS) {
			back = "truncated";
			break;
		}
		const row = byId.get(prev);
		if (!row) {
			dangling.push(prev);
			back = "missing";
			break;
		}
		seen.add(prev);
		older.push(prev);
		cursor = row;
	}

	const newer: string[] = [];
	let forward: ChainForward = "current";
	let marker: string | null = null;
	cursor = start;
	for (let hops = 0; ; hops++) {
		const next = nullable(cursor.superseded_by);
		if (next === null) break;
		if (isForgottenMarker(next)) {
			forward = "forgotten";
			marker = next;
			break;
		}
		if (seen.has(next)) {
			forward = "cycle";
			break;
		}
		if (hops >= MAX_CHAIN_HOPS) {
			forward = "truncated";
			break;
		}
		const row = byId.get(next);
		if (!row) {
			dangling.push(next);
			forward = "missing";
			break;
		}
		seen.add(next);
		newer.push(next);
		cursor = row;
	}

	return { id, chain: [...older.reverse(), id, ...newer], back, forward, dangling, forgotten_marker: marker };
}
