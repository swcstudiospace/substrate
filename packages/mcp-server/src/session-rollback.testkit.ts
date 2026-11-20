/**
 * Fakes for the session rollback tests (v1.6 phase 61): an in-memory ledger and index that stand in for Greptime and
 * Postgres behind a real `Substrate`, an in-process MCP client, and id helpers. Imported only by tests; no network, no
 * clock of its own (events carry the real ingest time, memory entries are placed relative to an event's `ts`).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.ts";
import type { EventQuery } from "./greptime.ts";
import type { GreptimeClient } from "./greptime.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import type { IndexStore } from "./index-store.ts";
import { createMcpServer, type McpCaller } from "./mcp.ts";
import { isForgetMarker } from "./memory-forget.ts";
import { Substrate } from "./service.ts";
import type { SessionRollbackDeps } from "./session-rollback.ts";
import type { MemoryEntry, Surface, SubstrateEvent } from "./types.ts";

export const GIT_TREE = "a".repeat(40);
export const MANIFEST = "b".repeat(64);
export const SESSION = "sess-rollback-1";

/** `ckpt_` plus 26 characters of 0-9 a-z, from a counter: deterministic, valid. */
export const ckptId = (n: number): string => `ckpt_${n.toString(36).padStart(26, "0")}`;
/** `rb_` plus 26 characters of 0-9 a-z, from a counter. */
export const rbId = (n: number): string => `rb_${n.toString(36).padStart(26, "0")}`;

/** A valid `session_checkpoint` request body for checkpoint number `n` of `session`. */
export function checkpointRequest(n: number, over: Record<string, unknown> = {}, session = SESSION): Record<string, unknown> {
	return {
		session_id: session,
		ckpt_id: ckptId(n),
		seq: n,
		trigger: "turn",
		git_tree: GIT_TREE,
		manifest_sha256: MANIFEST,
		file_count: 3,
		skipped_count: 0,
		...(n > 1 ? { prev_ckpt_id: ckptId(n - 1) } : {}),
		...over,
	};
}

const toRow = (event: SubstrateEvent, includePayload: boolean): Record<string, unknown> => ({
	...event,
	ts: Date.parse(event.ts),
	payload: includePayload ? JSON.stringify(event.payload) : undefined,
});

/** The ledger reads and writes `Substrate` uses, over an array. Newest first means last inserted first. */
export class FakeLedger {
	readonly events: SubstrateEvent[] = [];
	/** Set to make every insert throw (the ledger is down for writes). */
	failInsert: string | null = null;
	/** Makes the insert of the events this matches throw (a ledger that refuses only some writes). */
	failInsertFor: ((event: SubstrateEvent) => boolean) | null = null;
	/** Set to make every query throw (the ledger is down for reads). */
	failQuery: string | null = null;
	readonly queries: EventQuery[] = [];

	async ensureAppendMode(): Promise<boolean> {
		return true;
	}

	async lastHash(sessionId: string): Promise<string | null> {
		const last = [...this.events].reverse().find((event) => event.session_id === sessionId);
		return last?.hash ?? null;
	}

	/** The row for an event id, as `GreptimeClient.eventStored` answers it: a settled delivery checks the row before it writes. */
	async eventStored(id: string): Promise<boolean> {
		return this.events.some((event) => event.id === id);
	}

	async insertEvent(event: SubstrateEvent): Promise<void> {
		if (this.failInsert !== null) throw new Error(this.failInsert);
		if (this.failInsertFor?.(event) === true) throw new Error("the ledger refused this write");
		this.events.push(event);
	}

	async recordIngest(): Promise<void> {}

	async cursorPosition(id: string): Promise<{ id: string; ingestedAt: number } | null> {
		const found = this.events.find((event) => event.id === id);
		return found === undefined ? null : { id, ingestedAt: Date.parse(found.ts) };
	}

	async findByIdempotencyKey(cell: Pick<SubstrateEvent, "surface">, key: string): Promise<{ id: string; hash: string } | null> {
		const found = this.events.find((event) => event.surface === cell.surface && event.payload["_ik"] === key);
		return found === undefined ? null : { id: found.id, hash: found.hash };
	}

	async queryEvents(query: EventQuery): Promise<Array<Record<string, unknown>>> {
		this.queries.push(query);
		if (this.failQuery !== null) throw new Error(this.failQuery);
		const since = query.since === undefined ? -Infinity : Date.parse(query.since);
		const until = query.until === undefined ? Infinity : Date.parse(query.until);
		const indexed = this.events.map((event, at) => ({ event, at }));
		const matched = indexed.filter(({ event }) => {
			for (const [column, value] of Object.entries(query.match ?? {})) {
				if (value === undefined || value === null) continue;
				if ((event as unknown as Record<string, unknown>)[column] !== value) return false;
			}
			const ts = Date.parse(event.ts);
			return ts >= since && ts <= until;
		});
		matched.sort((a, b) => (query.order === "asc" ? 1 : -1) * (Date.parse(a.event.ts) - Date.parse(b.event.ts) || a.at - b.at));
		return matched.slice(0, query.limit ?? 50).map(({ event }) => toRow(event, query.includePayload === true));
	}

	/** Events of one action, oldest first. */
	byAction(action: string): SubstrateEvent[] {
		return this.events.filter((event) => event.payload["action"] === action);
	}
}

/** A memory entry with every required field; override what the test cares about. */
export function entry(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
	return {
		scope: "repo:acme/app",
		kind: "fact",
		text: "a fact",
		writer: "claude-code",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "30d",
		created: new Date(0).toISOString(),
		version: 1,
		entry_hash: "h".repeat(64),
		needs_reverification: false,
		session_id: SESSION,
		idempotency_key: `idem-${over.id}`,
		...over,
	};
}

/** The memory index calls the rollback path makes, over an array. */
export class FakeIndex {
	entries: MemoryEntry[] = [];
	/** Set to make the selection throw. */
	failSelect: string | null = null;
	/** Set to make the mark throw. */
	failMark: string | null = null;
	/** Mark calls that succeed before every later one throws; null means no such limit. */
	markFailsAfter: number | null = null;
	readonly marks: Array<{ ids: string[]; marker: string }> = [];
	selectLimits: number[] = [];
	/** The bounds each selection was asked with, in order: `[afterIso, untilIso]`. */
	selectBounds: Array<[string, string | null]> = [];

	async readEntry(id: string): Promise<MemoryEntry | null> {
		const found = this.entries.find((candidate) => candidate.id === id);
		return found === undefined ? null : { ...found };
	}

	async markMemoryForgotten(ids: readonly string[], marker: string): Promise<string[]> {
		if (!isForgetMarker(marker)) throw new Error("not a forget marker");
		if (this.failMark !== null) throw new Error(this.failMark);
		if (this.markFailsAfter !== null && this.marks.length >= this.markFailsAfter) throw new Error("the index connection dropped");
		this.marks.push({ ids: [...ids], marker });
		const changed: string[] = [];
		for (const candidate of this.entries) {
			if (ids.includes(candidate.id) && candidate.superseded_by === undefined) {
				candidate.superseded_by = marker;
				changed.push(candidate.id);
			}
		}
		return changed;
	}

	/** The writer each selection was asked to keep, in order (null: every writer's). */
	selectWriters: Array<string | null> = [];

	async memoryEntriesCreatedAfter(
		session: string,
		afterIso: string,
		_graph: string | null,
		limit: number,
		untilIso: string | null = null,
		writer: string | null = null,
	): Promise<{ entries: MemoryEntry[]; truncated: boolean }> {
		this.selectLimits.push(limit);
		this.selectBounds.push([afterIso, untilIso]);
		this.selectWriters.push(writer);
		if (this.failSelect !== null) throw new Error(this.failSelect);
		const after = Date.parse(afterIso);
		const until = untilIso === null ? Infinity : Date.parse(untilIso);
		// The writer filter runs before the limit, as the SQL does.
		const found = this.entries
			.filter(
				(candidate) =>
					candidate.session_id === session &&
					(writer === null || candidate.writer === writer) &&
					candidate.superseded_by === undefined &&
					Date.parse(candidate.created) > after &&
					Date.parse(candidate.created) <= until,
			)
			.sort((a, b) => Date.parse(a.created) - Date.parse(b.created) || (a.id < b.id ? -1 : 1));
		return { entries: found.slice(0, limit).map((candidate) => ({ ...candidate })), truncated: found.length > limit };
	}

	/** Another entry in force, of the same writer, with the same scope, kind and subject. */
	async memoryDocumentShared(entry: Pick<MemoryEntry, "id" | "scope" | "kind" | "subject" | "writer">): Promise<boolean> {
		if (entry.subject === undefined || entry.subject.length === 0) return false;
		return this.entries.some(
			(candidate) =>
				candidate.id !== entry.id &&
				candidate.scope === entry.scope &&
				candidate.kind === entry.kind &&
				candidate.subject === entry.subject &&
				candidate.writer === entry.writer &&
				candidate.superseded_by === undefined,
		);
	}

	async forgottenEntryIds(ids: readonly string[]): Promise<Set<string>> {
		return new Set(this.entries.filter((candidate) => ids.includes(candidate.id) && isForgetMarker(candidate.superseded_by)).map((candidate) => candidate.id));
	}

	forgotten(): string[] {
		return this.entries.filter((candidate) => candidate.superseded_by !== undefined && isForgetMarker(candidate.superseded_by)).map((candidate) => candidate.id);
	}
}

/** The fetch shape the Hindsight plane client takes. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The ports `Substrate` builds for the rollback tools. They are private (nothing outside the service should call them);
 * a test reaches them to swap one port, such as the anchor check, for a slow or failing one.
 */
export function rollbackDepsOf(substrate: Substrate): SessionRollbackDeps {
	const seam = substrate as unknown as { sessionRollbackDeps(): SessionRollbackDeps };
	return seam.sessionRollbackDeps();
}

export interface World {
	substrate: Substrate;
	ledger: FakeLedger;
	index: FakeIndex;
	plane: HindsightFake;
}

/** A `Substrate` over the fakes. The Hindsight plane is the repo's recording fake; `planeEnv` points the env reads at it. */
export function world(env: Record<string, string> = {}, options: { wrapPlane?: (plane: FetchLike) => FetchLike } = {}): World {
	const ledger = new FakeLedger();
	const index = new FakeIndex();
	const plane = new HindsightFake();
	const substrate = new Substrate(loadConfig(env), {
		index: index as unknown as IndexStore,
		steering: { history: null, liveSessions: null },
		greptime: ledger as unknown as GreptimeClient,
		hindsightFetch: options.wrapPlane === undefined ? plane.fetch : options.wrapPlane(plane.fetch),
	});
	return { substrate, ledger, index, plane };
}

/** Point the Hindsight env reads at the fake for one body; restores every touched variable. */
export async function withPlaneEnv<T>(body: () => Promise<T>): Promise<T> {
	const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANK_PREFIX"];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	process.env["HINDSIGHT_URL"] = "http://hindsight.test";
	process.env["HINDSIGHT_API_KEY"] = "test-bearer";
	delete process.env["HINDSIGHT_BANK_PREFIX"];
	try {
		return await body();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/** The bank a surface's writes go to under the default prefix. */
export const bankOf = (surface: string): string => `sub-${surface}`;

/** Seed the plane with one retained document per entry (its id is the entry's idempotency key, as the retain wrote it). */
export function seedDocuments(plane: HindsightFake, entries: readonly MemoryEntry[]): void {
	for (const memory of entries) {
		const bank = bankOf(String(memory.writer));
		const existing = plane.banks.get(bank)?.memories ?? [];
		plane.seed(bank, [...existing, { id: `doc-${memory.id}`, text: memory.text, document_id: memory.idempotency_key ?? memory.id, tags: [], metadata: {} }]);
	}
}

export interface McpHarness {
	client: Client;
	/** A tool's JSON answer (every session tool answers one JSON text block). */
	call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; json: Record<string, unknown>; text: string }>;
}

/** An in-process MCP client for `surface`, the way `mcp.test.ts` connects one. */
export async function connect(substrate: Substrate, surface: Surface | null = "claude-code", isOperator = false): Promise<McpHarness> {
	return connectAs(substrate, { surface, isOperator });
}

/** The same, for a caller with the bridge restrictions an untokened local run has. */
export async function connectAs(substrate: Substrate, caller: McpCaller): Promise<McpHarness> {
	const server = createMcpServer(substrate, caller);
	const client = new Client({ name: "session-rollback-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return {
		client,
		async call(name, args = {}) {
			const result = await client.callTool({ name, arguments: args });
			const content = result.content as Array<{ type: string; text?: string }>;
			const text = content[0]?.text ?? "";
			return { isError: result.isError === true, text, json: JSON.parse(text) as Record<string, unknown> };
		},
	};
}
