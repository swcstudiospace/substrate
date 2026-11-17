/**
 * Fakes and helpers for the multi-day soak (v1.6 phase 62, criterion 1). Imported only by tests.
 *
 * Builds on `session-rollback.testkit.ts` (the in-process `Substrate` over an in-memory ledger and memory index, the
 * recording Hindsight fake and an in-process MCP client) and adds what a 72 hour run needs and that file has not:
 *
 * - a clock: `SoakClock` moves Bun's system time, so the service's own `Date.now()` and `new Date()` (event times,
 *   deadlines, breakers) follow the simulated hours and no test ever sleeps;
 * - a ledger that can go down and come back (`SoakLedger`), answers the reads anchor verification makes, and a fake
 *   anchor job (`SoakChain`) that writes the hourly row and the devnet transaction from what the ledger holds;
 * - a fake Solana RPC that can be unreachable or answer from another cluster (`SoakRpc`);
 * - a memory index with a by-id map (the base fake scans a list), an outage switch and the pager the consistency
 *   verifier reads (`SoakIndex`), plus the plane and ledger readers of that verifier;
 * - the structural size readers and caps, and a timer tracker that proves production code leaves no timer behind.
 *
 * Nothing here opens a socket or sleeps. Randomness is the seeded generator of the snapshot library's testkit.
 */
import { setSystemTime } from "bun:test";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatMemo, HOUR_MS, hourStart, isClosed, merkleRootHex, type Rpc, type TransactionMemo } from "@substrate/ledger";
import { seeded, writeFiles } from "../../worktree-snapshot/src/testkit.ts";
import { DEVNET_GENESIS_HASH } from "./anchor.ts";
import { MEMORY_GENERATION_KEY, RECALL_GENERATION_KEY, ReadThroughCache, type CacheRedis } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { ledgerWriteReader } from "./consistency-run.ts";
import type { ConsistencyReaders, IndexCursor, PlaneReader } from "./consistency-verify.ts";
import { eventHash } from "./event.ts";
import { INGEST_LAG_MS, type AnchorRow, type EventQuery, type GreptimeClient, type HourLeaf } from "./greptime.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import type { IndexStore } from "./index-store.ts";
import { isForgetMarker } from "./memory-forget.ts";
import { contentHash } from "./memory-write.ts";
import { clearEnsuredBanks, type RecallHit } from "./planes/hindsight.ts";
import { Substrate } from "./service.ts";
import { FakeIndex, FakeLedger, ckptId, connect, type McpHarness } from "./session-rollback.testkit.ts";
import type { MemoryEntry, SubstrateEvent } from "./types.ts";

export { seeded };

export const MINUTE = 60_000;
export { HOUR_MS };
/** Day 0 of every simulated run: a whole hour, so hour numbers in assertions are plain. */
export const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);
/** A real 32-byte public key (the memo program id), so the bootstrap signer set parses. */
export const SOAK_SIGNER = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
export const SOAK_SCOPE = "repo:acme/app";

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/** The simulated wall clock. `set` moves Bun's system time, which `Date.now()` and `new Date()` read. Reset it in `afterEach`/`finally`. */
export class SoakClock {
	private ms: number;

	constructor(start: number = T0) {
		this.ms = start;
		setSystemTime(new Date(start));
	}

	now(): number {
		return this.ms;
	}

	set(ms: number): void {
		if (ms < this.ms) throw new Error(`the soak clock only moves forward (${ms} < ${this.ms})`);
		this.ms = ms;
		setSystemTime(new Date(ms));
	}

	advance(delta: number): void {
		this.set(this.ms + delta);
	}

	/** Back to the real clock. */
	restore(): void {
		setSystemTime();
	}
}

// ---------------------------------------------------------------------------
// Ids and requests
// ---------------------------------------------------------------------------

const hex = (n: number, length: number): string => n.toString(16).padStart(length, "0");
export const hex40 = (n: number): string => hex(n, 40);
export const hex64 = (n: number): string => hex(n, 64);

export interface CkptSpec {
	/** Counter behind the id (`ckptId(n)`), the git tree and the manifest digest: unique per checkpoint. */
	n: number;
	seq: number;
	prev: number | null;
	session: string;
	trigger?: string;
	/** Epoch ms the snapshot was pinned; left out when null. */
	takenAtMs?: number | null;
}

/** A valid `session_checkpoint` body. The git tree and manifest differ per checkpoint so no two hash alike. */
export function ckptRequest(spec: CkptSpec): Record<string, unknown> {
	return {
		session_id: spec.session,
		ckpt_id: ckptId(spec.n),
		seq: spec.seq,
		trigger: spec.trigger ?? "turn",
		git_tree: hex40(spec.n),
		manifest_sha256: hex64(spec.n),
		file_count: 3 + (spec.n % 5),
		skipped_count: 0,
		...(spec.prev === null ? {} : { prev_ckpt_id: ckptId(spec.prev) }),
		...(spec.takenAtMs === undefined || spec.takenAtMs === null ? {} : { taken_at_ms: spec.takenAtMs }),
	};
}

/** A governed-looking memory entry whose `entry_hash` really is the content hash, so verification and the consistency check judge it. */
export function soakEntry(input: { n: number; session: string; createdMs: number; sourceEvent: string; writer?: string }): MemoryEntry {
	const writer = input.writer ?? "claude-code";
	const text = `soak fact ${input.n}`;
	return {
		id: `mem_soak_${input.n}`,
		scope: SOAK_SCOPE,
		kind: "fact",
		text,
		writer,
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		created: new Date(input.createdMs).toISOString(),
		version: 1,
		entry_hash: contentHash({ scope: SOAK_SCOPE, kind: "fact", subject: null, text, writer }),
		needs_reverification: false,
		source_event: input.sourceEvent,
		session_id: input.session,
		idempotency_key: `mwd_soak_${input.n}`,
	};
}

// ---------------------------------------------------------------------------
// The ledger, the anchor job and the chain
// ---------------------------------------------------------------------------

const rowOf = (event: SubstrateEvent): Record<string, unknown> => ({ ...event, ts: Date.parse(event.ts), payload: JSON.stringify(event.payload) });

/**
 * The ledger fake with an outage switch and the reads anchor verification makes (`eventsByIds`, `hourLeaves`,
 * `anchorForPeriod`). `events` is the one structure the soak lets grow linearly.
 */
export class SoakLedger extends FakeLedger {
	readonly anchors = new Map<number, AnchorRow>();

	get down(): boolean {
		return this.failInsert !== null;
	}

	/** Take the ledger down (every read and write throws) or bring it back. */
	setDown(down: boolean): void {
		const reason = down ? "the event ledger is unreachable (simulated outage)" : null;
		this.failInsert = reason;
		this.failQuery = reason;
	}

	/** The base fake keeps every query for its own assertions; a 72 hour run would grow that log without bound, so it is cut after each read. */
	override async queryEvents(query: EventQuery): Promise<Array<Record<string, unknown>>> {
		try {
			return await super.queryEvents(query);
		} finally {
			this.queries.length = 0;
		}
	}

	async eventsByIds(positions: ReadonlyArray<string | { id: string }>): Promise<Array<Record<string, unknown>>> {
		if (this.failQuery !== null) throw new Error(this.failQuery);
		const ids = new Set(positions.map((position) => (typeof position === "string" ? position : position.id)));
		return this.events.filter((event) => ids.has(event.id)).map(rowOf);
	}

	/** The hour's members in ingest (insertion) order. */
	leavesOf(startMs: number): HourLeaf[] {
		const end = startMs + HOUR_MS;
		const leaves: HourLeaf[] = [];
		for (const event of this.events) {
			const at = Date.parse(event.ts);
			if (at >= startMs && at < end) leaves.push({ event_id: event.id, ingested_at: at, hash: event.hash });
		}
		return leaves;
	}

	async hourLeaves(startMs: number): Promise<HourLeaf[]> {
		if (this.failQuery !== null) throw new Error(this.failQuery);
		return this.leavesOf(startMs);
	}

	async anchorForPeriod(periodStartMs: number): Promise<AnchorRow | null> {
		if (this.failQuery !== null) throw new Error(this.failQuery);
		return this.anchors.get(periodStartMs) ?? null;
	}

	/**
	 * Append a `memory.write accepted` note the way the write audit does, at an explicit time and without the service's emit.
	 * The memory write path is not under test here, so its audit lands even while the session tools see the ledger down;
	 * the event is a real ledger event all the same (a valid hash, an hourly leaf, a source an entry can name).
	 */
	appendMemoryWrite(input: { id: string; tsMs: number; surface: string; scope: string; kind: string }): SubstrateEvent {
		const base: Omit<SubstrateEvent, "hash"> = {
			id: input.id,
			ts: new Date(input.tsMs).toISOString(),
			surface: input.surface as SubstrateEvent["surface"],
			session_id: null,
			graph_id: null,
			node_id: null,
			linear_identifier: null,
			step: null,
			repo: null,
			branch: null,
			actor: "agent",
			kind: "note",
			summary: `memory.write accepted ${input.kind} at ${input.scope}`,
			payload: { outcome: "accepted", scope: input.scope, kind: input.kind },
			prev: null,
		};
		const event: SubstrateEvent = { ...base, hash: eventHash(base) };
		this.events.push(event);
		return event;
	}
}

/** A fake Solana RPC: transactions by signature, an outage switch and a cluster identity. */
export class SoakRpc implements Rpc {
	readonly memos = new Map<string, TransactionMemo>();
	/** Set to make every call throw, as an unreachable RPC does. */
	down: string | null = null;
	/** The genesis hash this cluster reports; another value is a devnet reset. */
	genesis = DEVNET_GENESIS_HASH;
	calls = 0;

	async transactionMemo(signature: string): Promise<TransactionMemo | null> {
		this.calls++;
		if (this.down !== null) throw new Error(this.down);
		return this.memos.get(signature) ?? null;
	}
	async addressMemos(): Promise<never[]> {
		throw new Error("verification never lists addresses");
	}
	async getGenesisHash(): Promise<string> {
		this.calls++;
		if (this.down !== null) throw new Error(this.down);
		return this.genesis;
	}
	async balance(): Promise<number> {
		throw new Error("verification never reads a balance");
	}
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A syntactically valid, unique transaction signature: `5`, padding, then the index in base-8 digits drawn from the base58 alphabet. */
export function signatureFor(index: number): string {
	const digits = [...index.toString(8)].map((digit) => BASE58[Number(digit)] as string).join("");
	return `5${digits.padStart(87, "a")}`;
}

/**
 * The anchor job, reduced to what verification reads: for every hour that has closed (plus the ingest lag) and holds an event,
 * the hourly row in the ledger and the memo transaction on the RPC, both from the ledger's own events in ingest order. It skips
 * while the ledger is down and catches the missed hours up on the next call, as the real job does.
 */
export class SoakChain {
	private next: number;
	private written = 0;
	/** Hour starts that got an anchor, oldest first (one per simulated hour: the only thing here that grows). */
	readonly hours: number[] = [];

	constructor(
		private readonly ledger: SoakLedger,
		private readonly rpc: SoakRpc,
		startMs: number = T0,
		private readonly signer: string = SOAK_SIGNER,
	) {
		this.next = hourStart(startMs);
	}

	anchorDue(nowMs: number): number {
		if (this.ledger.down) return 0;
		let wrote = 0;
		while (isClosed(this.next, nowMs, INGEST_LAG_MS)) {
			const hour = this.next;
			this.next += HOUR_MS;
			const leaves = this.ledger.leavesOf(hour);
			if (leaves.length === 0) continue;
			const root = merkleRootHex(leaves.map((leaf) => leaf.hash));
			const memo = formatMemo({ periodStartMs: hour, rootHex: root, count: leaves.length });
			const signature = signatureFor(this.written);
			const slot = 1_000 + this.written;
			this.written++;
			this.ledger.anchors.set(hour, {
				period_start: new Date(hour).toISOString(),
				period_end: new Date(hour + HOUR_MS).toISOString(),
				root,
				event_count: leaves.length,
				memo,
				tx_sig: signature,
				signer: this.signer,
				cluster: "devnet",
				slot,
				anchored_at: new Date(nowMs).toISOString(),
				stale_hashes: null,
			});
			this.rpc.memos.set(signature, { memo, payer: this.signer, payerSigned: true, err: null, fee: 5000, slot, blockTime: Math.floor(nowMs / 1000) });
			this.hours.push(hour);
			wrote++;
		}
		return wrote;
	}
}

// ---------------------------------------------------------------------------
// The memory index and the cache server
// ---------------------------------------------------------------------------

/** The memory index with a by-id map, an outage switch, and the pager the consistency verifier reads. */
export class SoakIndex extends FakeIndex {
	/** Set to make every call throw, as an index that went away. */
	down: string | null = null;
	private readonly byId = new Map<string, MemoryEntry>();

	private refuse(): void {
		if (this.down !== null) throw new Error(this.down);
	}

	/** Put an entry in the index (the one way in: the by-id map and the list stay the same set). */
	add(entry: MemoryEntry): void {
		if (this.byId.has(entry.id)) throw new Error(`entry ${entry.id} already exists`);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
	}

	override async readEntry(id: string): Promise<MemoryEntry | null> {
		this.refuse();
		const found = this.byId.get(id);
		return found === undefined ? null : { ...found };
	}

	override async markMemoryForgotten(ids: readonly string[], marker: string): Promise<string[]> {
		this.refuse();
		if (!isForgetMarker(marker)) throw new Error("not a forget marker");
		if (this.failMark !== null) throw new Error(this.failMark);
		if (this.markFailsAfter !== null && this.marks.length >= this.markFailsAfter) throw new Error("the index connection dropped");
		this.marks.push({ ids: [...ids], marker });
		const changed: string[] = [];
		for (const id of ids) {
			const found = this.byId.get(id);
			if (found !== undefined && found.superseded_by === undefined) {
				found.superseded_by = marker;
				changed.push(id);
			}
		}
		return changed;
	}

	override async memoryEntriesCreatedAfter(session: string, afterIso: string, graph: string | null, limit: number, untilIso: string | null = null): Promise<{ entries: MemoryEntry[]; truncated: boolean }> {
		this.refuse();
		return super.memoryEntriesCreatedAfter(session, afterIso, graph, limit, untilIso);
	}
}

/** A cache server that keeps values and counts how often each generation key was bumped. TTLs are ignored: the soak moves hours, not keys. */
export class SoakRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	readonly incrs = new Map<string, number>();
	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}
	async set(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}
	async incr(key: string): Promise<number> {
		this.incrs.set(key, (this.incrs.get(key) ?? 0) + 1);
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
	bumps(): { memory: number; recall: number } {
		return { memory: this.incrs.get(MEMORY_GENERATION_KEY) ?? 0, recall: this.incrs.get(RECALL_GENERATION_KEY) ?? 0 };
	}
}

// ---------------------------------------------------------------------------
// The world, the boot and the shutdown
// ---------------------------------------------------------------------------

/** The stores that outlive a restart: tearing a `Substrate` down and building another over these is the restart. */
export interface Fakes {
	ledger: SoakLedger;
	index: SoakIndex;
	plane: HindsightFake;
	rpc: SoakRpc;
	redis: SoakRedis;
	chain: SoakChain;
	faults: { planeDown: boolean };
}

export function makeFakes(startMs: number = T0): Fakes {
	const ledger = new SoakLedger();
	const rpc = new SoakRpc();
	return { ledger, index: new SoakIndex(), plane: new HindsightFake(), rpc, redis: new SoakRedis(), chain: new SoakChain(ledger, rpc, startMs), faults: { planeDown: false } };
}

export interface Boot {
	substrate: Substrate;
	mcp: McpHarness;
	cache: ReadThroughCache;
}

/** A new `Substrate` and its in-process MCP client over `fakes`: a process start. Call inside `withPlaneEnv`. */
export async function boot(fakes: Fakes, env: Record<string, string> = {}): Promise<Boot> {
	// A restarted process has not ensured any bank yet.
	clearEnsuredBanks();
	const cache = new ReadThroughCache({ redis: fakes.redis, enabled: true, log: () => {} });
	const substrate = new Substrate(loadConfig({ SOLANA_ANCHOR_PUBKEY: SOAK_SIGNER, ...env }), {
		index: fakes.index as unknown as IndexStore,
		steering: { history: null, liveSessions: null },
		greptime: fakes.ledger as unknown as GreptimeClient,
		hindsightFetch: async (input, init) => (fakes.faults.planeDown ? Response.json({ detail: "injected outage" }, { status: 503 }) : fakes.plane.fetch(input, init)),
		cache,
		rpc: fakes.rpc,
	});
	return { substrate, mcp: await connect(substrate, "claude-code"), cache };
}

/** The shutdown path of `index.ts`, minus the process exit: stop what has a timer, drain the retains, close the client. */
export async function shutdown(running: Boot): Promise<void> {
	await running.substrate.stopRecall();
	running.substrate.stopPreload();
	running.substrate.stopEventBus();
	running.substrate.stopPlanningPoll();
	await running.substrate.drainPendingRetains(1_000, { abandon: true });
	await running.mcp.client.close();
}

/** Seed one plane document for `entry`, the way a retain wrote it (document id = the idempotency key, the entry id in its metadata). */
export function seedPlaneDocument(plane: HindsightFake, entry: MemoryEntry): void {
	const bank = `sub-${String(entry.writer)}`;
	let found = plane.banks.get(bank);
	if (found === undefined) {
		found = { mode: "server-default", memories: [] };
		plane.banks.set(bank, found);
	}
	const hit: RecallHit = { id: `doc-${entry.id}`, text: entry.text, document_id: entry.idempotency_key ?? entry.id, tags: [], metadata: { entry_id: entry.id } };
	found.memories.push(hit);
}

/** The documents a bank holds, as document ids. */
export const planeDocuments = (plane: HindsightFake, bank: string): string[] => (plane.banks.get(bank)?.memories ?? []).map((memory) => memory.document_id ?? memory.id);

/** The `DELETE` requests the plane saw, as document ids. */
export const planeDeletes = (plane: HindsightFake): string[] => plane.requests.filter((request) => request.method === "DELETE").map((request) => decodeURIComponent(request.path.split("/").pop() ?? ""));

// ---------------------------------------------------------------------------
// The consistency verifier's readers
// ---------------------------------------------------------------------------

/** The three stores as `verifyConsistency` reads them: the index pager, the plane's current documents, the ledger's accepted memory-write notes. */
export function consistencyReaders(fakes: Fakes): ConsistencyReaders {
	const documents = new Map<string, Map<string, string | null>>();
	for (const [bank, state] of fakes.plane.banks) {
		const inBank = new Map<string, string | null>();
		for (const memory of state.memories) {
			const entryId = memory.metadata["entry_id"];
			inBank.set(memory.document_id ?? memory.id, typeof entryId === "string" ? entryId : null);
		}
		documents.set(bank, inBank);
	}
	const plane: PlaneReader = {
		getDocument: async (bank, id) => {
			const entryId = documents.get(bank)?.get(id);
			if (entryId === undefined) return null;
			return entryId === null ? { id } : { id, entry_id: entryId };
		},
		listDocuments: async (bank, request) => {
			const ids = [...(documents.get(bank)?.keys() ?? [])].sort();
			const from = request.cursor === null ? 0 : Number(request.cursor);
			const slice = ids.slice(from, from + request.limit);
			return { ids: slice, next: from + request.limit < ids.length ? String(from + request.limit) : null };
		},
	};
	return {
		index: {
			page: async (request) => {
				const sorted = [...fakes.index.entries].sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? 1 : -1));
				const after = request.cursor;
				const rest = after === null ? sorted : sorted.filter((e) => e.created < after.before || (e.created === after.before && e.id < after.before_id));
				const slice = rest.slice(0, request.limit);
				const last = slice[slice.length - 1];
				const next: IndexCursor | null = last !== undefined && rest.length > request.limit ? { before: last.created, before_id: last.id } : null;
				return { entries: slice, next };
			},
			entry: async (id) => fakes.index.readEntry(id),
			documentShared: async (entry) => fakes.index.memoryDocumentShared(entry),
		},
		plane,
		ledger: ledgerWriteReader(fakes.ledger as unknown as Pick<GreptimeClient, "queryEvents">),
		outbox: { parkedEntryIds: async () => new Set<string>() },
	};
}

// ---------------------------------------------------------------------------
// Bounded structures and handles
// ---------------------------------------------------------------------------

/** The structures that could grow without bound in a long run, by name. The ledger's event count is the only thing allowed to grow linearly and is not here. */
export interface BoundedSizes {
	/** `Substrate`'s per-session append queue: empty whenever no call is in flight. */
	emitChains: number;
	/** The per-document retain/delete queue. */
	retainChains: number;
	/** The per-key completion queue. */
	completionChains: number;
	/** Parked Hindsight retains. */
	retainOutbox: number;
	/** Cache keys the run created (the two generation keys and a few cached answers). */
	redisKeys: number;
	/** Single-flight loads the read-through cache holds. */
	cacheInflight: number;
	/** The pending journal: files and total bytes. */
	journalItems: number;
	journalBytes: number;
	/** `.tmp` files a crashed journal write could leave. */
	journalTemps: number;
	/** Timers production code created and has not cleared or fired. */
	timers: number;
}

/** Explicit caps. Each is the most the structure may hold at an hour boundary of the soak; a measurement above its cap fails the run. */
export const CAPS: BoundedSizes = {
	emitChains: 0,
	retainChains: 0,
	completionChains: 0,
	retainOutbox: 0,
	redisKeys: 16,
	cacheInflight: 0,
	journalItems: 40,
	journalBytes: 40 * 6 * 1024,
	journalTemps: 0,
	timers: 0,
};

/** The pending journal's footprint: `*.json` items and their bytes, and stray `.tmp` files. No dependency on the CLI's own reader, so a regression there cannot hide a leak here. */
export function journalStats(dir: string | null): { items: number; bytes: number; temps: number } {
	if (dir === null || !existsSync(dir)) return { items: 0, bytes: 0, temps: 0 };
	let items = 0;
	let bytes = 0;
	let temps = 0;
	for (const name of readdirSync(dir)) {
		if (name.endsWith(".tmp")) temps++;
		else if (name.endsWith(".json")) {
			items++;
			bytes += statSync(join(dir, name)).size;
		}
	}
	return { items, bytes, temps };
}

/** A private `Map` field of `target`, as the live map. A renamed or retyped field throws, so the soak cannot go quiet by a refactor. */
export function privateMap<K, V>(target: object, field: string): Map<K, V> {
	const value = (target as Record<string, unknown>)[field];
	if (value instanceof Map) return value as Map<K, V>;
	throw new Error(`${target.constructor.name}.${field} is not a Map any more: update the soak's structural measurements`);
}

/** The size of a private `Map` or `Set` field of `target`. */
export function privateSize(target: object, field: string): number {
	const value = (target as Record<string, unknown>)[field];
	if (value instanceof Map || value instanceof Set) return value.size;
	throw new Error(`${target.constructor.name}.${field} is not a Map or Set any more: update the soak's structural measurements`);
}

/** Read every bounded structure. */
export function measure(running: Boot, fakes: Fakes, journalDir: string | null, tracker: HandleTracker): BoundedSizes {
	const journal = journalStats(journalDir);
	return {
		emitChains: privateSize(running.substrate, "emitChains"),
		retainChains: privateSize(running.substrate, "retainChains"),
		completionChains: privateSize(running.substrate, "completionChains"),
		retainOutbox: running.substrate.retainOutboxStats().size,
		redisKeys: fakes.redis.values.size,
		cacheInflight: privateSize(running.cache, "inflight"),
		journalItems: journal.items,
		journalBytes: journal.bytes,
		journalTemps: journal.temps,
		timers: tracker.outstanding().length,
	};
}

/** The names of the structures over their cap, with the numbers. Empty means within bounds. */
export function violations(sizes: BoundedSizes, caps: BoundedSizes = CAPS): string[] {
	return (Object.keys(caps) as Array<keyof BoundedSizes>).filter((name) => sizes[name] > caps[name]).map((name) => `${name}: ${sizes[name]} > cap ${caps[name]}`);
}

interface TrackedTimer {
	kind: "timeout" | "interval";
	origin: string;
	production: boolean;
}

const STACK_FILE = /((?:\/[^\s():]+)+\.(?:ts|js|mjs)):(\d+):(\d+)/;

function isProductionFile(file: string): boolean {
	if (/node_modules/.test(file)) return false;
	if (/\.test\.ts$|\.testkit\.ts$|-fake\.ts$/.test(file)) return false;
	return /\/packages\//.test(file);
}

/** The file that asked for a timer, from the stack at creation: the first frame outside this kit. */
function originOfCaller(): { origin: string; production: boolean } {
	for (const line of (new Error().stack ?? "").split("\n").slice(1)) {
		const match = STACK_FILE.exec(line);
		if (match === null) continue;
		const file = match[1] as string;
		if (file.endsWith("soak.testkit.ts")) continue;
		return { origin: `${file.split("/").slice(-2).join("/")}:${match[2]}`, production: isProductionFile(file) };
	}
	return { origin: "unknown", production: false };
}

type TimerFn = (callback: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => unknown;
type ClearFn = (handle: unknown) => void;

/**
 * Records every `setTimeout` and `setInterval` made through the global functions while installed, and forgets one when it
 * fires (a timeout) or is cleared. `outstanding()` is what production code (anything under `packages/` that is not a test,
 * a testkit or a fake) asked for and has not released. A module that captured the functions before `install` is not seen;
 * that is the limit of this seam, and the production code under test reads the globals at call time.
 */
export class HandleTracker {
	private readonly live = new Map<unknown, TrackedTimer>();
	private saved: { setTimeout: unknown; setInterval: unknown; clearTimeout: unknown; clearInterval: unknown } | null = null;

	install(): void {
		if (this.saved !== null) throw new Error("the handle tracker is already installed");
		const scope = globalThis as unknown as Record<string, unknown>;
		const rawSetTimeout = scope["setTimeout"] as TimerFn;
		const rawSetInterval = scope["setInterval"] as TimerFn;
		const rawClearTimeout = scope["clearTimeout"] as ClearFn;
		const rawClearInterval = scope["clearInterval"] as ClearFn;
		this.saved = { setTimeout: rawSetTimeout, setInterval: rawSetInterval, clearTimeout: rawClearTimeout, clearInterval: rawClearInterval };
		const live = this.live;
		scope["setTimeout"] = (callback: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]): unknown => {
			const handle: unknown = rawSetTimeout(
				(...args: unknown[]) => {
					live.delete(handle);
					callback(...args);
				},
				ms,
				...rest,
			);
			live.set(handle, { kind: "timeout", ...originOfCaller() });
			return handle;
		};
		scope["setInterval"] = (callback: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]): unknown => {
			const handle = rawSetInterval(callback, ms, ...rest);
			live.set(handle, { kind: "interval", ...originOfCaller() });
			return handle;
		};
		scope["clearTimeout"] = (handle: unknown): void => {
			live.delete(handle);
			rawClearTimeout(handle);
		};
		scope["clearInterval"] = (handle: unknown): void => {
			live.delete(handle);
			rawClearInterval(handle);
		};
	}

	/** Put the real timer functions back and clear what is still live, so a failed test leaves no interval running. */
	uninstall(): void {
		if (this.saved === null) return;
		const scope = globalThis as unknown as Record<string, unknown>;
		const rawClearTimeout = this.saved.clearTimeout as ClearFn;
		for (const handle of this.live.keys()) rawClearTimeout(handle);
		this.live.clear();
		scope["setTimeout"] = this.saved.setTimeout;
		scope["setInterval"] = this.saved.setInterval;
		scope["clearTimeout"] = this.saved.clearTimeout;
		scope["clearInterval"] = this.saved.clearInterval;
		this.saved = null;
	}

	/** Timers production code created and has not released; `includeTests` also counts the ones tests and fakes made. */
	outstanding(options: { includeTests?: boolean } = {}): Array<{ kind: "timeout" | "interval"; origin: string }> {
		return [...this.live.values()].filter((timer) => options.includeTests === true || timer.production).map(({ kind, origin }) => ({ kind, origin }));
	}
}

// ---------------------------------------------------------------------------
// A small real worktree
// ---------------------------------------------------------------------------

const SRC_FILES = 10;
const DOC_FILES = 6;
const RING_FILES = 8;

/** The files a soak worktree starts with: a README, ten sources and six notes, all untracked (a snapshot includes them). */
export function seedWorktree(dir: string): void {
	const files: Record<string, string> = { "README.md": "soak worktree\n" };
	for (let i = 0; i < SRC_FILES; i++) files[`src/mod-${i}.ts`] = `export const v${i} = ${i};\n`;
	for (let i = 0; i < DOC_FILES; i++) files[`docs/note-${i}.md`] = `note ${i}\n`;
	writeFiles(dir, files);
}

/**
 * One step of work: three seeded edits, one file in a ring of eight that always carries the step number (so no two steps
 * share a tree, and the worktree stays at a bounded size), and now and then a deleted note.
 */
export function mutateWorktree(dir: string, rand: () => number, step: number): void {
	const edits: Record<string, string> = {};
	for (let i = 0; i < 3; i++) {
		const target = rand() < 0.6 ? `src/mod-${Math.floor(rand() * SRC_FILES)}.ts` : `docs/note-${Math.floor(rand() * DOC_FILES)}.md`;
		edits[target] = `// step ${step} edit ${i}\nexport const v = ${Math.floor(rand() * 1_000_000)};\n`;
	}
	edits[`ring/step-${step % RING_FILES}.txt`] = `step ${step}\n`;
	writeFiles(dir, edits);
	if (rand() < 0.25) rmSync(join(dir, `docs/note-${Math.floor(rand() * DOC_FILES)}.md`), { force: true });
}
