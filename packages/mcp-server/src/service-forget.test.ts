/**
 * `Substrate.memoryForget` end to end over fakes (v1.6 phase 57): a fake index that marks rows the way
 * `IndexStore.markMemoryForgotten` does, the recording Hindsight fake behind the service's gated fetch, a fake cache
 * server that counts generation bumps, and a ledger stub that records the notes. No network, no clock: every
 * ordering is proved by a gate the test opens.
 *
 * What must hold: the marks keep the rows; the plane delete names the bank and document id the retain path wrote, through
 * the gated fetch (an open breaker sends nothing); a document that is not there counts as deleted; a retryable plane
 * error is pending and a re-run retries only that delete; an unconfigured plane is skipped; one ledger note per call,
 * as the caller's surface and session, and a ledger failure is reported and never thrown; both cache generations move
 * when a row changed and neither moves on a no-op re-run; the delete waits behind a retain of the same document; a parked
 * replay of a forgotten entry is dropped; and recall, the brief and memory search stop serving a forgotten entry.
 */
import { describe, expect, test } from "bun:test";
import { MEMORY_GENERATION_KEY, RECALL_GENERATION_KEY, ReadThroughCache, classOf, type CacheRedis } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import { ForgetError, isForgetMarker, type ForgetRequest } from "./memory-forget.ts";
import { ForgetUnavailableError } from "./memory-forget-plane.ts";
import { retainDocumentId } from "./memory-retain.ts";
import { FakeStore } from "./memory-write.test.ts";
import { clearEnsuredBanks, type FetchLike } from "./planes/hindsight.ts";
import { Substrate, type ForgetCaller } from "./service.ts";
import type { MemoryEntry, MemoryWriteResult, SubstrateEvent } from "./types.ts";

const GRANTS = `[{"surfaces":["cursor"],"scopes":["graph"],"kinds":["fact","decision"]}]`;
const HINDSIGHT_ON = { HINDSIGHT_URL: "http://fake", HINDSIGHT_API_KEY: "test-bearer", HINDSIGHT_BANKS: "sub-cursor" };
const HINDSIGHT_OFF = { HINDSIGHT_URL: undefined, HINDSIGHT_API_KEY: undefined, HINDSIGHT_BANKS: undefined };
const CALLER: ForgetCaller = { surface: "omp", session_id: "sess-caller" };

// ── fakes ────────────────────────────────────────────────────────────────────

/** The fake index plus what the service reads of the forget half of `IndexStore`: the one conditional mark, the shared-document read, and a search that hides marked rows. */
class ForgetStore extends FakeStore {
	readonly markCalls: Array<{ ids: string[]; marker: string }> = [];
	/** What `memoryDocumentShared` answers. */
	shared = false;
	/** Makes the mark throw, as an index that went away mid-statement. */
	failMark: string | null = null;

	async markMemoryForgotten(ids: readonly string[], marker: string): Promise<string[]> {
		this.markCalls.push({ ids: [...ids], marker });
		if (this.failMark !== null) throw new Error(this.failMark);
		const changed: string[] = [];
		for (const id of ids) {
			const row = this.rows.get(id);
			if (row === undefined || row.entry.superseded_by) continue;
			row.entry = { ...row.entry, superseded_by: marker };
			changed.push(id);
		}
		return changed;
	}

	async memoryDocumentShared(): Promise<boolean> {
		return this.shared;
	}

	/** The index's search: a body match, and a superseded row (a forgotten one included) only when asked for. */
	async searchMemory(query: string, _scope: string | undefined, _limit: number | undefined, includeSuperseded: boolean | undefined): Promise<MemoryEntry[]> {
		const wanted = query.trim().toLowerCase();
		return this.entries().filter((entry) => (includeSuperseded === true || !entry.superseded_by) && (wanted === "" || entry.text.toLowerCase().includes(wanted)));
	}
}

/** A cache server that counts how often each generation key was bumped. */
class CountingRedis implements CacheRedis {
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

/** A ledger stub that keeps every event it is given; `fail` makes the insert throw. */
class LedgerStub {
	readonly events: SubstrateEvent[] = [];
	fail: string | null = null;
	async ensureAppendMode(): Promise<boolean> {
		return true;
	}
	async lastHash(): Promise<string | null> {
		return null;
	}
	async hasEvent(): Promise<boolean> {
		return true;
	}
	async insertEvent(event: SubstrateEvent): Promise<void> {
		if (this.fail !== null) throw new Error(this.fail);
		this.events.push(event);
	}
	forgetNotes(): SubstrateEvent[] {
		return this.events.filter((event) => event.payload["action"] === "memory.forget");
	}
}

interface Plane {
	/** Answers every plane DELETE with this instead of the fake. */
	deleteAnswer: (() => Response) | null;
	/** Holds every retain POST until it resolves. */
	gate: Promise<void> | null;
	/** Retain POSTs that reached the plane's door, held or not. */
	posts: number;
}

interface World {
	substrate: Substrate;
	store: ForgetStore;
	fake: HindsightFake;
	redis: CountingRedis;
	cache: ReadThroughCache;
	ledger: LedgerStub;
	plane: Plane;
}

function world(options: { env?: Record<string, string>; ledger?: boolean; index?: boolean } = {}): World {
	clearEnsuredBanks();
	const fake = new HindsightFake();
	const store = new ForgetStore();
	const redis = new CountingRedis();
	const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
	const ledger = new LedgerStub();
	const plane: Plane = { deleteAnswer: null, gate: null, posts: 0 };
	const hindsightFetch: FetchLike = async (input, init) => {
		const method = (init?.method ?? "GET").toUpperCase();
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (method === "DELETE" && plane.deleteAnswer !== null) return plane.deleteAnswer();
		if (method === "POST" && url.endsWith("/memories")) {
			plane.posts += 1;
			if (plane.gate !== null) await plane.gate;
		}
		return fake.fetch(input, init);
	};
	const substrate = new Substrate(loadConfig({ SUBSTRATE_MEMORY_GRANTS: GRANTS, ...options.env }), {
		index: (options.index === false ? null : store) as never,
		greptime: (options.ledger === false ? null : ledger) as never,
		cache,
		hindsightFetch,
	});
	return { substrate, store, fake, redis, cache, ledger, plane };
}

function setEnv(values: Record<string, string | undefined>): () => void {
	const saved = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

async function inWorld<T>(options: { env?: Record<string, string>; ledger?: boolean; plane?: boolean }, body: (w: World) => Promise<T>): Promise<T> {
	const restore = setEnv(options.plane === false ? HINDSIGHT_OFF : HINDSIGHT_ON);
	try {
		return await body(world(options));
	} finally {
		restore();
	}
}

/** One macrotask turn: every ready continuation runs, and the fakes' in-memory bodies settle. */
function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

async function settle(rounds = 10): Promise<void> {
	for (let round = 0; round < rounds; round += 1) await tick();
}

/** Yield until `condition` holds, or fail loudly instead of hanging. */
async function until(condition: () => boolean, what: string): Promise<void> {
	for (let round = 0; round < 500; round += 1) {
		if (condition()) return;
		await tick();
	}
	throw new Error(`never reached: ${what}`);
}

/** A write through the governance gate, then every background retain settled. */
async function writeOne(w: World, text: string, subject?: string): Promise<MemoryWriteResult & { entry: MemoryEntry }> {
	const written = await w.substrate.writeMemory({
		scope: "graph:ut-1",
		kind: "fact",
		...(subject !== undefined ? { subject } : {}),
		text,
		writer: "cursor",
		source_event: "evt_e2e",
	});
	expect(written.outcome).toBe("accepted");
	if (written.entry === undefined) throw new Error("an accepted write carries no entry");
	await w.substrate.drainPendingRetains(2000);
	return { ...written, entry: written.entry };
}

/** A row put straight in the index, for the cases that need no plane document. */
function seedRow(store: ForgetStore, id: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
	const entry: MemoryEntry = {
		id,
		scope: "graph:ut-1",
		kind: "decision",
		text: `decision text of ${id}`,
		writer: "cursor",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		created: "2026-10-10T00:00:00.000Z",
		version: 1,
		entry_hash: `hash_${id}`,
		needs_reverification: false,
		idempotency_key: `mwd_${id}`,
		...over,
	};
	store.rows.set(id, { entry, conflict_key: null });
	return entry;
}

const forgetRequest = (ids: string[], over: Partial<ForgetRequest> = {}): ForgetRequest => ({ reason: "operator", entry_ids: ids, actor: "human", ...over });
const deletes = (fake: HindsightFake): string[] => fake.requests.filter((request) => request.method === "DELETE").map((request) => request.path);
const bankDocs = (fake: HindsightFake, bank = "sub-cursor"): string[] => (fake.banks.get(bank)?.memories ?? []).map((memory) => memory.text);
const status = (code: number) => () => Response.json({ detail: "injected" }, { status: code });

// ── the primitive ────────────────────────────────────────────────────────────

describe("Substrate.memoryForget: the index mark and the plane delete", () => {
	test("marks the entries and keeps the rows; the delete names the bank and document id the retain wrote", async () => {
		await inWorld({}, async (w) => {
			const withSubject = await writeOne(w, "fence every handoff of the node lease", "handoff-rule");
			// No subject: the plane document is keyed by the write's idempotency key, the other branch of `retainDocumentId`.
			const bare = await writeOne(w, "order the node handoffs before each merge train");
			expect(w.fake.retains).toHaveLength(2);
			const retainedAs = new Map(w.fake.retains.map((retained) => [String(retained.item.content), { bank: retained.bank, id: String(retained.item.document_id) }]));
			const subjectDoc = retainedAs.get("fence every handoff of the node lease");
			const bareDoc = retainedAs.get("order the node handoffs before each merge train");
			expect(subjectDoc).toEqual({ bank: "sub-cursor", id: retainDocumentId(withSubject.entry, withSubject.idempotency_key) });
			expect(bareDoc).toEqual({ bank: "sub-cursor", id: retainDocumentId(bare.entry, bare.idempotency_key) });
			expect(bareDoc?.id).toBe(bare.idempotency_key);

			const report = await w.substrate.memoryForget(forgetRequest([withSubject.entry.id, bare.entry.id]), CALLER);

			expect(report.counts).toEqual({ marked: 2, already_forgotten: 0, already_superseded: 0, missing: 0 });
			expect(report.plane).toEqual({ deleted: 2, absent: 0, pending: 0, skipped: 0 });
			expect(report.plane_pending).toBe(0);
			expect(isForgetMarker(report.marker)).toBe(true);
			// The rows stay, with their text, marked out of force.
			for (const written of [withSubject, bare]) {
				const row = await w.store.readEntry(written.entry.id);
				expect(row?.superseded_by).toBe(report.marker);
				expect(row?.text).toBe(written.entry.text);
			}
			expect(w.store.standing()).toEqual([]);
			// Exactly the documents the retain wrote, in the bank it wrote them to.
			expect(deletes(w.fake).sort()).toEqual(
				[subjectDoc, bareDoc].map((doc) => `/v1/default/banks/${doc?.bank}/documents/${encodeURIComponent(doc?.id ?? "")}`).sort(),
			);
			expect(bankDocs(w.fake)).toEqual([]);
		});
	});

	test("the delete goes through the gated fetch: an open Hindsight breaker sends nothing, and the deletion is pending and retryable", async () => {
		await inWorld({ env: { SUBSTRATE_BREAKER_FAILURES: "1" } }, async (w) => {
			const written = await writeOne(w, "fence every handoff of the node lease", "handoff-rule");
			const breaker = w.substrate.planes.gate("hindsight").breaker;
			breaker?.onFailure("hindsight down");
			expect(breaker?.state()).toBe("open");
			const before = deletes(w.fake).length;

			const report = await w.substrate.memoryForget(forgetRequest([written.entry.id]), CALLER);

			expect(deletes(w.fake)).toHaveLength(before);
			expect(report.plane).toEqual({ deleted: 0, absent: 0, pending: 1, skipped: 0 });
			expect(report.entries[0]?.plane).toMatchObject({ status: "pending", retryable: true });
			expect(report.entries[0]?.plane).toHaveProperty("reason", expect.stringContaining("circuit open"));
			// The mark stands whatever the plane did.
			expect((await w.store.readEntry(written.entry.id))?.superseded_by).toBe(report.marker);
			expect(bankDocs(w.fake)).toEqual(["fence every handoff of the node lease"]);
		});
	});

	test("a document that is not there counts as deleted", async () => {
		await inWorld({}, async (w) => {
			seedRow(w.store, "mem_never_retained");
			const report = await w.substrate.memoryForget(forgetRequest(["mem_never_retained"]), CALLER);
			expect(deletes(w.fake)).toEqual(["/v1/default/banks/sub-cursor/documents/mwd_mem_never_retained"]);
			expect(report.plane).toEqual({ deleted: 0, absent: 1, pending: 0, skipped: 0 });
			expect(report.plane_pending).toBe(0);
			expect(report.entries[0]?.plane).toEqual({ status: "absent" });
		});
	});

	test("a retryable plane error is pending, and a re-run of the same request retries only the plane delete", async () => {
		await inWorld({}, async (w) => {
			const written = await writeOne(w, "fence every handoff of the node lease", "handoff-rule");
			w.plane.deleteAnswer = status(503);

			const first = await w.substrate.memoryForget(forgetRequest([written.entry.id]), CALLER);
			expect(first.counts.marked).toBe(1);
			expect(first.plane).toEqual({ deleted: 0, absent: 0, pending: 1, skipped: 0 });
			expect(first.plane_pending).toBe(1);
			expect(first.entries[0]?.plane).toMatchObject({ status: "pending", retryable: true });
			expect(bankDocs(w.fake)).toEqual(["fence every handoff of the node lease"]);
			expect(w.store.markCalls).toHaveLength(1);

			// The plane recovers; the same request is the retry.
			w.plane.deleteAnswer = null;
			const second = await w.substrate.memoryForget(forgetRequest([written.entry.id]), CALLER);
			expect(second.forget_id).toBe(first.forget_id);
			expect(second.counts).toEqual({ marked: 0, already_forgotten: 1, already_superseded: 0, missing: 0 });
			expect(second.entries[0]).toMatchObject({ outcome: "already_forgotten", forgotten_by: first.forget_id, plane: { status: "deleted" } });
			expect(second.plane_pending).toBe(0);
			// Nothing was marked again: only the plane delete ran.
			expect(w.store.markCalls).toHaveLength(1);
			expect(deletes(w.fake)).toHaveLength(1);
			expect(bankDocs(w.fake)).toEqual([]);
		});
	});

	test("an auth failure is pending and NOT retryable: re-running will not help until the plane is fixed", async () => {
		await inWorld({}, async (w) => {
			seedRow(w.store, "mem_auth");
			w.plane.deleteAnswer = status(401);
			const report = await w.substrate.memoryForget(forgetRequest(["mem_auth"]), CALLER);
			expect(report.plane_pending).toBe(1);
			expect(report.entries[0]?.plane).toMatchObject({ status: "pending", retryable: false });
		});
	});

	test("an unconfigured plane is skipped, not failed, and nothing is sent", async () => {
		await inWorld({ plane: false }, async (w) => {
			const written = await writeOne(w, "fence every handoff of the node lease", "handoff-rule");
			const report = await w.substrate.memoryForget(forgetRequest([written.entry.id]), CALLER);
			expect(report.plane).toEqual({ deleted: 0, absent: 0, pending: 0, skipped: 1 });
			expect(report.entries[0]?.plane).toEqual({ status: "skipped", reason: "plane-not-configured" });
			expect(report.plane_pending).toBe(0);
			expect(w.fake.requests).toEqual([]);
			expect((await w.store.readEntry(written.entry.id))?.superseded_by).toBe(report.marker);
		});
	});

	test("a document another live entry still maps to is left alone", async () => {
		await inWorld({}, async (w) => {
			seedRow(w.store, "mem_shared");
			w.store.shared = true;
			const report = await w.substrate.memoryForget(forgetRequest(["mem_shared"]), CALLER);
			expect(report.entries[0]?.plane).toEqual({ status: "skipped", reason: "document-shared" });
			expect(deletes(w.fake)).toEqual([]);
		});
	});

	test("without an index nothing can be marked, so nothing is forgotten and no plane document is touched", async () => {
		await inWorld({ ledger: false }, async (w) => {
			const noIndex = new Substrate(loadConfig({}), { index: null, greptime: null, hindsightFetch: w.fake.fetch });
			await expect(noIndex.memoryForget(forgetRequest(["mem_any"]), CALLER)).rejects.toBeInstanceOf(ForgetUnavailableError);
			await expect(noIndex.memoryForget(forgetRequest(["mem_any"]), CALLER)).rejects.toThrow(/SUBSTRATE_PG_URL/);
			expect(w.fake.requests).toEqual([]);
		});
	});

	test("a bad request is refused before the index or the plane is touched, and moves no generation", async () => {
		await inWorld({}, async (w) => {
			await expect(w.substrate.memoryForget(forgetRequest([]), CALLER)).rejects.toBeInstanceOf(ForgetError);
			await expect(w.substrate.memoryForget(forgetRequest(["mem_x"], { reason: "rollback" }), CALLER)).rejects.toThrow(/rollback_id or a checkpoint_id/);
			expect(w.store.markCalls).toEqual([]);
			expect(w.fake.requests).toEqual([]);
			expect(w.redis.bumps()).toEqual({ memory: 0, recall: 0 });
			expect(w.ledger.events).toEqual([]);
		});
	});
});

// ── the ledger note ──────────────────────────────────────────────────────────

describe("Substrate.memoryForget: the ledger note", () => {
	test("exactly one note per call, as the caller's surface and session, carrying the report's counts", async () => {
		await inWorld({}, async (w) => {
			seedRow(w.store, "mem_a");
			seedRow(w.store, "mem_b");
			const request = forgetRequest(["mem_a", "mem_b"], { session_id: "sess-request" });

			const report = await w.substrate.memoryForget(request, CALLER);

			const notes = w.ledger.forgetNotes();
			expect(notes).toHaveLength(1);
			const note = notes[0] as SubstrateEvent;
			expect(note.kind).toBe("note");
			// The authenticated surface is the event's own; the caller's session wins over the request's.
			expect(note.surface).toBe("omp");
			expect(note.session_id).toBe("sess-caller");
			expect(note.payload).toMatchObject({
				action: "memory.forget",
				forget_id: report.forget_id,
				reason: "operator",
				entry_count: 2,
				entry_ids: ["mem_a", "mem_b"],
				counts: report.counts,
				plane: report.plane,
			});
			expect(report.ledger).toMatchObject({ emitted: true });

			// A re-run is a second call and writes its own note, still one per call.
			await w.substrate.memoryForget(request, CALLER);
			expect(w.ledger.forgetNotes()).toHaveLength(2);
		});
	});

	test("a caller with no session falls back to the request's session", async () => {
		await inWorld({}, async (w) => {
			seedRow(w.store, "mem_a");
			await w.substrate.memoryForget(forgetRequest(["mem_a"], { session_id: "sess-request" }), { surface: "omp" });
			expect(w.ledger.forgetNotes()[0]?.session_id).toBe("sess-request");
		});
	});

	test("a ledger that is down is reported in the report, never thrown, and the marks and deletes stand", async () => {
		await inWorld({}, async (w) => {
			const written = await writeOne(w, "fence every handoff of the node lease", "handoff-rule");
			w.ledger.fail = "ledger down";
			const before = w.redis.bumps();
			const report = await w.substrate.memoryForget(forgetRequest([written.entry.id]), CALLER);
			expect(report.ledger.emitted).toBe(false);
			expect(report.ledger).toHaveProperty("reason", expect.stringContaining("ledger down"));
			expect(w.ledger.forgetNotes()).toEqual([]);
			expect((await w.store.readEntry(written.entry.id))?.superseded_by).toBe(report.marker);
			expect(bankDocs(w.fake)).toEqual([]);
			// A mark that moved still moved the generations.
			expect(w.redis.bumps()).toEqual({ memory: before.memory + 1, recall: before.recall + 1 });
		});
	});

	test("with no ledger configured the note is reported as not emitted, not thrown", async () => {
		await inWorld({ ledger: false }, async (w) => {
			seedRow(w.store, "mem_a");
			const report = await w.substrate.memoryForget(forgetRequest(["mem_a"]), CALLER);
			expect(report.ledger.emitted).toBe(false);
			expect(report.counts.marked).toBe(1);
		});
	});
});

// ── the cache generations ────────────────────────────────────────────────────

describe("Substrate.memoryForget: cache generations", () => {
	test("BOTH the recall and the memory generation move when a row changed, and neither moves on a no-op re-run", async () => {
		await inWorld({}, async (w) => {
			seedRow(w.store, "mem_a");
			const before = w.redis.bumps();

			await w.substrate.memoryForget(forgetRequest(["mem_a"]), CALLER);
			const afterFirst = w.redis.bumps();
			expect(afterFirst).toEqual({ memory: before.memory + 1, recall: before.recall + 1 });

			// Everything is already marked and the plane delete is done: nothing changed, so nothing is invalidated.
			const rerun = await w.substrate.memoryForget(forgetRequest(["mem_a"]), CALLER);
			expect(rerun.counts.already_forgotten).toBe(1);
			expect(w.redis.bumps()).toEqual(afterFirst);
		});
	});

	test("an id that names no entry changes nothing and moves no generation", async () => {
		await inWorld({}, async (w) => {
			const before = w.redis.bumps();
			const report = await w.substrate.memoryForget(forgetRequest(["mem_missing"]), CALLER);
			expect(report.counts).toEqual({ marked: 0, already_forgotten: 0, already_superseded: 0, missing: 1 });
			expect(w.redis.bumps()).toEqual(before);
		});
	});

	test("a mark that throws may still have committed, so the generations move and the error is rethrown", async () => {
		await inWorld({}, async (w) => {
			seedRow(w.store, "mem_a");
			w.store.failMark = "index went away";
			const before = w.redis.bumps();
			await expect(w.substrate.memoryForget(forgetRequest(["mem_a"]), CALLER)).rejects.toThrow("index went away");
			expect(w.redis.bumps()).toEqual({ memory: before.memory + 1, recall: before.recall + 1 });
			expect(w.ledger.forgetNotes()).toEqual([]);
		});
	});
});

// ── ordering against the retain path ─────────────────────────────────────────

describe("Substrate.memoryForget: the same chain as the retains", () => {
	test("the plane delete waits behind a retain still in flight for the same document, so it cannot be resurrected", async () => {
		await inWorld({}, async (w) => {
			const { promise: opened, resolve: open } = Promise.withResolvers<void>();
			w.plane.gate = opened;
			const written = await w.substrate.writeMemory({
				scope: "graph:ut-1",
				kind: "fact",
				subject: "handoff-rule",
				text: "fence every handoff of the node lease",
				writer: "cursor",
				source_event: "evt_e2e",
			});
			expect(written.outcome).toBe("accepted");
			const id = written.entry?.id ?? "";
			// The forward is stalled inside the plane: it has not landed.
			await until(() => w.plane.posts === 1, "the retain reached the plane");
			expect(bankDocs(w.fake)).toEqual([]);

			const forgetting = w.substrate.memoryForget(forgetRequest([id]), CALLER);
			await until(() => w.store.markCalls.length === 1, "the entry was marked");
			await settle();
			// Marked at once (recall stops serving it), but the delete is queued behind the retain, not sent ahead of it.
			expect((await w.store.readEntry(id))?.superseded_by).toMatch(/^forgotten:fg_/);
			expect(deletes(w.fake)).toEqual([]);

			open();
			const report = await forgetting;
			await w.substrate.drainPendingRetains(2000);

			expect(report.plane_pending).toBe(0);
			// The retain landed first and the delete removed what it wrote: the document is gone for good.
			const calls = w.fake.requests.filter((request) => request.method === "DELETE" || (request.method === "POST" && request.path.endsWith("/memories")));
			expect(calls.map((request) => request.method)).toEqual(["POST", "DELETE"]);
			expect(report.plane.deleted).toBe(1);
			expect(bankDocs(w.fake)).toEqual([]);
		});
	});

	test("a parked retain replay for a forgotten entry answers gone: it sends nothing and leaves the outbox", async () => {
		await inWorld({}, async (w) => {
			w.fake.failRetainWith = 503;
			const written = await writeOne(w, "fence every handoff of the node lease", "handoff-rule");
			expect(w.substrate.retainOutboxStats().size).toBe(1);

			const report = await w.substrate.memoryForget(forgetRequest([written.entry.id]), CALLER);
			// Nothing was ever retained, so the plane had nothing to delete.
			expect(report.plane.absent).toBe(1);

			w.fake.failRetainWith = null;
			await w.substrate.drainRetainOutbox({ all: true });
			expect(w.fake.retains).toEqual([]);
			expect(bankDocs(w.fake)).toEqual([]);
			expect(w.substrate.retainOutboxStats().size).toBe(0);
		});
	});
});

// ── what the readers serve afterwards ────────────────────────────────────────

describe("Substrate.memoryForget: recall, the brief and memory search stop serving a forgotten entry", () => {
	test("recall: a cached answer is dropped with the document", async () => {
		await inWorld({}, async (w) => {
			const written = await writeOne(w, "fence every handoff of the node lease", "handoff-rule");
			const before = await w.substrate.recallMemories({ query: "handoff" }, "cursor");
			expect(before.results.map((hit) => hit.text)).toEqual(["fence every handoff of the node lease"]);
			// The same query again is a cache hit, so only a bump can change the answer.
			expect((await w.substrate.recallMemories({ query: "handoff" }, "cursor")).results).toHaveLength(1);

			await w.substrate.memoryForget(forgetRequest([written.entry.id]), CALLER);

			expect((await w.substrate.recallMemories({ query: "handoff" }, "cursor")).results).toEqual([]);
		});
	});

	test("memory_search: without include_superseded the entry and its derived hit are gone, with it the row still answers", async () => {
		await inWorld({}, async (w) => {
			const written = await writeOne(w, "fence every handoff of the node lease", "handoff-rule");
			const hot = await w.substrate.searchMemory("handoff", undefined, undefined, false, "cursor");
			expect(hot.entries.map((entry) => entry.id)).toEqual([written.entry.id]);
			expect(hot.derived).toHaveLength(1);

			const report = await w.substrate.memoryForget(forgetRequest([written.entry.id]), CALLER);

			const gone = await w.substrate.searchMemory("handoff", undefined, undefined, false, "cursor");
			expect(gone.entries).toEqual([]);
			expect(gone.derived).toEqual([]);
			const audit = await w.substrate.searchMemory("handoff", undefined, undefined, true, "cursor");
			expect(audit.entries.map((entry) => entry.id)).toEqual([written.entry.id]);
			expect(audit.entries[0]?.superseded_by).toBe(report.marker);
		});
	});

	test("the brief: a cached brief is dropped with the entry", async () => {
		await inWorld({ ledger: false }, async (w) => {
			seedRow(w.store, "mem_decision", { text: "quote versions in every conflict reply" });
			const request = { repo: "acme/app", surface: "cursor" } as const;
			const before = await w.substrate.brief(request);
			expect(before).toContain("quote versions in every conflict reply");
			// The brief is held by the cache, so only the bump can change what the next one says.
			expect([...w.redis.values.keys()].some((key) => classOf(key) === "brief")).toBe(true);
			expect(await w.substrate.brief(request)).toBe(before);

			await w.substrate.memoryForget(forgetRequest(["mem_decision"]), CALLER);

			expect(await w.substrate.brief(request)).not.toContain("quote versions in every conflict reply");
		});
	});
});
