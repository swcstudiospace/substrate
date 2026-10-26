/**
 * The two read tools of anchor verification, driven through a real MCP client (v1.6 phases 59 and 60):
 * `checkpoint_verify` and `memory_verify`.
 *
 * What must hold: both are listed read-only; an unconfigured Solana, an unconfigured ledger or a refused RPC URL is a
 * STATUS (`unverified`, with the reason) decided before any ledger read or chain call; a `CheckpointVerifyError` or a
 * `MemoryVerifyError` is a tool error result; `memory_verify` answers `not_found` for an entry the caller may not read,
 * exactly as for one that does not exist; every output is redacted; and the hour's leaves are read at most
 * `maxLeaves + 1`. The ledger and the index are fakes, the RPC is a Proxy that fails the test if touched: no network.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { formatMemo, HOUR_MS, type Rpc } from "@substrate/ledger";
import { DEFAULT_MAX_LEAVES } from "./checkpoint-verify.ts";
import { loadConfig } from "./config.ts";
import { eventHash } from "./event.ts";
import type { AnchorRow, EventQuery, HourLeaf } from "./greptime.ts";
import { createMcpServer } from "./mcp.ts";
import { contentOf, entryHashFor } from "./memory-record.ts";
import { Substrate } from "./service.ts";
import { buildCheckpointEvent } from "./session-events.ts";
import type { MemoryEntry, SubstrateEvent, Surface } from "./types.ts";

// A real 32-byte public key (the memo program id), so the bootstrap signer set parses.
const SIGNER = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const CKPT = "ckpt_0123456789abcdefghjkmnpqrs";
const HEX_64 = "0123456789abcdef".repeat(4);
const HEX_40 = "0123456789abcdef0123456789abcdef01234567";
const SIGNATURE = `5${"a".repeat(87)}`;
const TOKEN = `ghp_${"a".repeat(40)}`;
/** An hour long closed, in server time, so no clock decides these cases. */
const H = Date.UTC(2025, 0, 1, 10);
const INGESTED = H + 30 * 60_000;

// ── fakes ────────────────────────────────────────────────────────────────────

function event(over: Partial<Omit<SubstrateEvent, "hash">> & { id: string }): SubstrateEvent {
	const base: Omit<SubstrateEvent, "hash"> = {
		ts: new Date(INGESTED).toISOString(),
		surface: "claude-code",
		session_id: "sess-v16",
		graph_id: null,
		node_id: null,
		linear_identifier: null,
		step: null,
		repo: null,
		branch: null,
		actor: "agent",
		kind: "note",
		summary: "a note",
		payload: {},
		prev: null,
		...over,
	};
	return { ...base, hash: eventHash(base) };
}

function checkpointEvent(): SubstrateEvent {
	const draft = buildCheckpointEvent("sess-v16", { ckpt_id: CKPT, seq: 1, trigger: "turn", git_tree: HEX_40, manifest_sha256: HEX_64, file_count: 3, skipped_count: 0 });
	return event({ id: "evt_v16_checkpoint", kind: draft.kind, summary: draft.summary, payload: { ...draft.payload } });
}

const toRow = (e: SubstrateEvent): Record<string, unknown> => ({ ...e, ts: Date.parse(e.ts), payload: JSON.stringify(e.payload) });

/** The ledger reads verification uses, counted. Anything else is not here, so reaching for it fails the test. */
class LedgerSpy {
	events: SubstrateEvent[] = [];
	leaves: HourLeaf[] = [];
	row: AnchorRow | null = null;
	queries: EventQuery[] = [];
	calls = { eventsByIds: 0, cursorPosition: 0, queryEvents: 0, hourLeaves: 0, anchorForPeriod: 0 };

	total(): number {
		return Object.values(this.calls).reduce((sum, count) => sum + count, 0);
	}
	async eventsByIds(positions: ReadonlyArray<string | { id: string }>): Promise<Array<Record<string, unknown>>> {
		this.calls.eventsByIds++;
		const ids = positions.map((position) => (typeof position === "string" ? position : position.id));
		return this.events.filter((candidate) => ids.includes(candidate.id)).map(toRow);
	}
	async cursorPosition(id: string): Promise<{ id: string; ingestedAt: number } | null> {
		this.calls.cursorPosition++;
		return { id, ingestedAt: INGESTED };
	}
	async queryEvents(query: EventQuery = {}): Promise<Array<Record<string, unknown>>> {
		this.calls.queryEvents++;
		this.queries.push(query);
		return [];
	}
	async hourLeaves(): Promise<HourLeaf[]> {
		this.calls.hourLeaves++;
		return this.leaves;
	}
	async anchorForPeriod(ms: number): Promise<AnchorRow | null> {
		this.calls.anchorForPeriod++;
		return ms === H ? this.row : null;
	}
	// The write side is only here so a `Substrate` can be built; verification never emits.
	async ensureAppendMode(): Promise<boolean> {
		return true;
	}
	async lastHash(): Promise<string | null> {
		return null;
	}
	async insertEvent(): Promise<void> {
		throw new Error("verification never writes to the ledger");
	}
}

/** An RPC that fails the test, and says what was asked, if anything reaches the chain. */
function forbiddenRpc(touched: string[]): Rpc {
	return new Proxy(
		{},
		{
			get: (_target, property) => {
				touched.push(String(property));
				throw new Error(`the RPC must not be reached: ${String(property)}`);
			},
		},
	) as unknown as Rpc;
}

function memoryEntry(over: Partial<MemoryEntry> = {}): MemoryEntry {
	const base: MemoryEntry = {
		id: "mem_verify_1",
		scope: "repo:acme/app",
		kind: "decision",
		text: "use pnpm for every install in this repo",
		writer: "cursor",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		created: "2026-10-10T00:00:00.000Z",
		version: 1,
		entry_hash: "",
		needs_reverification: false,
		source_event: "evt_src_1",
		...over,
	};
	return { ...base, entry_hash: over.entry_hash ?? entryHashFor(contentOf(base), base.writer).v2 };
}

function memoryIndex(entries: MemoryEntry[]) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return { readEntry: async (id: string) => byId.get(id) ?? null, graphLifetime: async () => null };
}

interface Connected {
	client: Client;
	substrate: Substrate;
	ledger: LedgerSpy;
	rpcTouched: string[];
}

async function connect(
	options: { env?: Record<string, string>; ledger?: boolean; entries?: MemoryEntry[]; index?: boolean; surface?: Surface | null } = {},
): Promise<Connected> {
	const ledger = new LedgerSpy();
	const rpcTouched: string[] = [];
	const substrate = new Substrate(loadConfig(options.env ?? {}), {
		index: (options.index === false ? null : memoryIndex(options.entries ?? [])) as never,
		greptime: (options.ledger === false ? null : ledger) as never,
		rpc: forbiddenRpc(rpcTouched),
	});
	const server = createMcpServer(substrate, options.surface === undefined ? "omp" : options.surface);
	const client = new Client({ name: "substrate-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, substrate, ledger, rpcTouched };
}

/** A tool's JSON reply. Every substrate tool answers with one text block. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await client.callTool({ name, arguments: args });
	const content = result.content as Array<{ type: string; text?: string }>;
	const text = content[0]?.text ?? "";
	return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

const ANCHOR_ENV = { SOLANA_ANCHOR_PUBKEY: SIGNER };

// ── the tool surface ─────────────────────────────────────────────────────────

describe("checkpoint_verify and memory_verify are listed", () => {
	test("both are read-only, with the documented inputs", async () => {
		const { client } = await connect();
		const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
		for (const name of ["checkpoint_verify", "memory_verify"]) {
			expect(tools.has(name)).toBe(true);
			expect(tools.get(name)?.annotations?.readOnlyHint).toBe(true);
		}
		expect(Object.keys(tools.get("checkpoint_verify")?.inputSchema.properties ?? {}).sort()).toEqual(["ckpt_id", "event_id", "session_id"]);
		expect(Object.keys(tools.get("memory_verify")?.inputSchema.properties ?? {}).sort()).toEqual(["id", "repo"]);
	});

	test("a malformed checkpoint id never reaches the service: the schema refuses it", async () => {
		const { client, ledger } = await connect({ env: ANCHOR_ENV });
		// The SDK reports a schema violation either as an error result or as a rejected call, depending on its version; both are a refusal.
		let refused: boolean;
		try {
			refused = (await client.callTool({ name: "checkpoint_verify", arguments: { ckpt_id: "ckpt_short" } })).isError === true;
		} catch {
			// A rejected call is the refusal itself: nothing was run.
			refused = true;
		}
		expect(refused).toBe(true);
		expect(ledger.total()).toBe(0);
	});
});

// ── checkpoint_verify ────────────────────────────────────────────────────────

describe("checkpoint_verify: not verifiable here is a status, decided before any read", () => {
	test("no ledger configured: unverified, naming GREPTIME_URL", async () => {
		const w = await connect({ env: ANCHOR_ENV, ledger: false });
		const reply = await call(w.client, "checkpoint_verify", { ckpt_id: CKPT });
		expect(reply.isError).toBe(false);
		expect(reply.json()).toMatchObject({ status: "unverified", ref: CKPT });
		expect(String((reply.json().reasons as string[])[0])).toContain("GREPTIME_URL");
		expect(w.rpcTouched).toEqual([]);
	});

	test("no anchor public key: unverified, naming SOLANA_ANCHOR_PUBKEY; the ledger is not read and the chain is not called", async () => {
		const w = await connect();
		const byCheckpoint = await call(w.client, "checkpoint_verify", { ckpt_id: CKPT });
		const byEvent = await call(w.client, "checkpoint_verify", { event_id: "evt_v16_checkpoint" });
		expect(byCheckpoint.isError).toBe(false);
		expect(byCheckpoint.json()).toMatchObject({ status: "unverified", ref: CKPT });
		expect(String((byCheckpoint.json().reasons as string[])[0])).toContain("SOLANA_ANCHOR_PUBKEY");
		expect(byEvent.json()).toMatchObject({ status: "unverified", ref: "evt_v16_checkpoint" });
		expect(w.ledger.total()).toBe(0);
		expect(w.rpcTouched).toEqual([]);
	});

	test("an RPC URL the devnet guard refuses: unverified, the refusal is the reason, the URL is not echoed, nothing is read or sent", async () => {
		const w = await connect({ env: { ...ANCHOR_ENV, SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" } });
		const reply = await call(w.client, "checkpoint_verify", { ckpt_id: CKPT });
		expect(reply.isError).toBe(false);
		expect(reply.json()).toMatchObject({ status: "unverified", ref: CKPT });
		expect(String((reply.json().reasons as string[])[0])).toContain("Solana is not usable: SOLANA_RPC_URL refused");
		expect(reply.text).not.toContain("mainnet-beta");
		expect(w.ledger.total()).toBe(0);
		expect(w.rpcTouched).toEqual([]);
	});
});

describe("checkpoint_verify: a CheckpointVerifyError is a tool error result", () => {
	test("exactly one of ckpt_id and event_id", async () => {
		const w = await connect({ env: ANCHOR_ENV });
		for (const args of [{}, { ckpt_id: CKPT, event_id: "evt_v16_checkpoint" }]) {
			const reply = await call(w.client, "checkpoint_verify", args);
			expect(reply.isError).toBe(true);
			expect(reply.json().error).toBe("invalid-ref: pass exactly one of ckpt_id or event_id");
		}
		expect(w.ledger.total()).toBe(0);
	});

	test("an unknown event id is not-found, and a malformed one is invalid-ref", async () => {
		const w = await connect({ env: ANCHOR_ENV });
		const unknown = await call(w.client, "checkpoint_verify", { event_id: "evt_missing" });
		expect(unknown.isError).toBe(true);
		expect(unknown.json().error).toBe("not-found: no event or checkpoint matches evt_missing");
		const malformed = await call(w.client, "checkpoint_verify", { event_id: "not an id" });
		expect(malformed.isError).toBe(true);
		expect(String(malformed.json().error)).toMatch(/^invalid-ref: /);
		expect(w.rpcTouched).toEqual([]);
	});

	test("an unknown checkpoint id says where it was searched and how to widen the search", async () => {
		const w = await connect({ env: ANCHOR_ENV });
		const own = await call(w.client, "checkpoint_verify", { ckpt_id: CKPT });
		expect(own.isError).toBe(true);
		expect(String(own.json().error)).toMatch(/^not-found: /);
		expect(String(own.json().error)).toContain("pass session_id or the checkpoint's event_id");
		// No session named: the caller's own surface, bounded by the lookback window.
		expect(w.ledger.queries[0]?.match).toEqual({ kind: "note", surface: "omp" });

		const named = await call(w.client, "checkpoint_verify", { ckpt_id: CKPT, session_id: "sess-named" });
		expect(named.isError).toBe(true);
		expect(w.ledger.queries[1]?.match).toEqual({ kind: "note", session_id: "sess-named" });
	});

	test("the error text is redacted", async () => {
		const w = await connect({ env: ANCHOR_ENV });
		const reply = await call(w.client, "checkpoint_verify", { event_id: TOKEN });
		expect(reply.isError).toBe(true);
		expect(reply.text).not.toContain(TOKEN);
		expect(reply.text).toContain("[REDACTED]");
	});
});

describe("checkpoint_verify: the hour's leaves are read at most maxLeaves + 1", () => {
	test("an hour with more leaves than the verifier rebuilds is unverified, and the reader is cut one past the limit", async () => {
		const w = await connect({ env: ANCHOR_ENV });
		const target = checkpointEvent();
		w.ledger.events.push(target);
		w.ledger.row = {
			period_start: new Date(H).toISOString(),
			period_end: new Date(H + HOUR_MS).toISOString(),
			root: HEX_64,
			event_count: 5,
			memo: formatMemo({ periodStartMs: H, rootHex: HEX_64, count: 5 }),
			tx_sig: SIGNATURE,
			signer: SIGNER,
			cluster: "devnet",
			slot: 4242,
			anchored_at: new Date(H + 2 * HOUR_MS).toISOString(),
			stale_hashes: null,
		};
		// The ledger answers with far more than the verifier will hold; the fake records how the adapter cut it.
		const leaves: HourLeaf[] = Array.from({ length: DEFAULT_MAX_LEAVES + 5 }, (_, i) => ({ event_id: `evt_leaf_${i}`, ingested_at: INGESTED, hash: HEX_64 }));
		const sliceCalls: unknown[][] = [];
		const realSlice = leaves.slice.bind(leaves);
		leaves.slice = ((...args: [number?, number?]) => {
			sliceCalls.push(args);
			return realSlice(...args);
		}) as typeof leaves.slice;
		w.ledger.leaves = leaves;

		const reply = await call(w.client, "checkpoint_verify", { event_id: target.id });

		expect(reply.isError).toBe(false);
		expect(reply.json()).toMatchObject({ status: "unverified", ref: target.id });
		expect(String((reply.json().reasons as string[])[0])).toContain(`more than ${DEFAULT_MAX_LEAVES} events`);
		expect(w.ledger.calls.hourLeaves).toBe(1);
		expect(sliceCalls).toEqual([[0, DEFAULT_MAX_LEAVES + 1]]);
		// The proof was never attempted over a partial hour.
		expect(reply.json().evidence).toMatchObject({ leaf_index: null, proof: null, computed_root: null });
	});
});

// ── memory_verify ────────────────────────────────────────────────────────────

describe("memory_verify: not verifiable here is a status", () => {
	test("no ledger, no anchor key, or a refused RPC URL: the entry's own hash is still checked and the anchor is unverified with the reason", async () => {
		const cases: Array<[string, { env?: Record<string, string>; ledger?: boolean }, string]> = [
			["no ledger", { env: ANCHOR_ENV, ledger: false }, "GREPTIME_URL"],
			["no anchor key", {}, "SOLANA_ANCHOR_PUBKEY"],
			["a refused RPC URL", { env: { ...ANCHOR_ENV, SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" } }, "SOLANA_RPC_URL refused"],
		];
		for (const [label, options, reason] of cases) {
			const entry = memoryEntry();
			const w = await connect({ ...options, entries: [entry] });
			const reply = await call(w.client, "memory_verify", { id: entry.id });
			expect(reply.isError).toBe(false);
			const body = reply.json();
			expect([label, body.status]).toEqual([label, "unverified"]);
			expect(body).toMatchObject({ id: entry.id, content_checked: true, hash_version: "v2", source_event: "evt_src_1", anchor: { status: "unverified", proof_ref: null } });
			const reasons = body.reasons as string[];
			expect(reasons[0]).toContain("content hash recomputed and matches");
			expect(reasons.join(" ")).toContain(reason);
			// The reply never carries the entry's text.
			expect(reply.text).not.toContain(entry.text);
			expect(w.ledger.total()).toBe(0);
			expect(w.rpcTouched).toEqual([]);
		}
	});

	test("a row that no longer hashes to its entry_hash is hash-mismatch, and no anchor is asked for", async () => {
		const entry = memoryEntry({ entry_hash: "f".repeat(64) });
		const w = await connect({ env: ANCHOR_ENV, entries: [entry] });
		const reply = await call(w.client, "memory_verify", { id: entry.id });
		expect(reply.isError).toBe(false);
		expect(reply.json()).toMatchObject({ status: "hash-mismatch", content_checked: true, anchor: null });
		expect(w.ledger.total()).toBe(0);
	});
});

describe("memory_verify: an entry the caller may not read answers as if absent", () => {
	const foreign = (): MemoryEntry => memoryEntry({ id: "mem_agent_hermes", scope: "agent:hermes", writer: "hermes", repo: "acme/app" });

	test("another surface's agent-scoped entry is not_found, in the very words used for an id that does not exist", async () => {
		const entry = foreign();
		const w = await connect({ entries: [entry], surface: "omp" });
		const hidden = await call(w.client, "memory_verify", { id: entry.id, repo: "acme/app" });
		const absent = await call(w.client, "memory_verify", { id: "mem_nothing_here", repo: "acme/app" });
		expect(hidden.isError).toBe(true);
		expect(hidden.json().error).toBe(`not_found: no memory entry ${entry.id} in the index`);
		expect(absent.isError).toBe(true);
		expect(absent.json().error).toBe("not_found: no memory entry mem_nothing_here in the index");
		expect(hidden.text).not.toContain(entry.text);
	});

	test("the owning surface reads it only for the repo it was written for", async () => {
		const entry = foreign();
		const w = await connect({ entries: [entry], surface: "hermes" });
		const forRepo = await call(w.client, "memory_verify", { id: entry.id, repo: "acme/app" });
		expect(forRepo.isError).toBe(false);
		expect(forRepo.json()).toMatchObject({ id: entry.id, content_checked: true });
		for (const args of [{ id: entry.id }, { id: entry.id, repo: "acme/other" }]) {
			const reply = await call(w.client, "memory_verify", args);
			expect(reply.isError).toBe(true);
			expect(String(reply.json().error)).toMatch(/^not_found: /);
		}
	});

	test("with no index there is nothing to read", async () => {
		const w = await connect({ index: false });
		const reply = await call(w.client, "memory_verify", { id: "mem_verify_1" });
		expect(reply.isError).toBe(true);
		expect(String(reply.json().error)).toContain("not_found: no memory index is configured");
	});
});

describe("memory_verify: outputs are redacted", () => {
	test("a credential in the entry's source event never leaves the tool", async () => {
		const entry = memoryEntry({ id: "mem_token_src", source_event: TOKEN });
		const w = await connect({ entries: [entry] });
		const reply = await call(w.client, "memory_verify", { id: entry.id });
		expect(reply.isError).toBe(false);
		expect(reply.text).not.toContain(TOKEN);
		expect(reply.text).toContain("[REDACTED]");
		expect(reply.json().status).toBe("unverified");
	});

	test("the error text is redacted too", async () => {
		const w = await connect({ entries: [] });
		const reply = await call(w.client, "memory_verify", { id: TOKEN });
		expect(reply.isError).toBe(true);
		expect(reply.text).not.toContain(TOKEN);
		expect(reply.text).toContain("[REDACTED]");
	});
});
