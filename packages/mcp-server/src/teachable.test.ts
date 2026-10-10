import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { EVENT_SOURCES } from "./event-sources.ts";
import type { ClaimResult, MemoryStore, NewMemoryEntry } from "./memory-write.ts";
import { Substrate } from "./service.ts";
import {
	TEACHABLE_SUBJECT_PREFIX,
	isTeachable,
	teachableEvent,
	teachableSlug,
} from "./teachable.ts";
import { SURFACES, type MemoryEntry, type SubstrateEvent, type Surface } from "./types.ts";

describe("teachable subject convention", () => {
	test("the prefix is the documented tag", () => {
		expect(TEACHABLE_SUBJECT_PREFIX).toBe("teachable:");
	});

	test("a fact with the prefix is a teachable", () => {
		expect(isTeachable("fact", "teachable:retry-budget")).toBe(true);
	});

	test("only facts qualify — warnings and decisions with the prefix do not", () => {
		expect(isTeachable("warning", "teachable:retry-budget")).toBe(false);
		expect(isTeachable("decision", "teachable:retry-budget")).toBe(false);
		expect(isTeachable("todo", "teachable:retry-budget")).toBe(false);
	});

	test("a fact without the prefix is an ordinary fact", () => {
		expect(isTeachable("fact", "retry-budget")).toBe(false);
		expect(isTeachable("fact", "unteachable:retry-budget")).toBe(false);
		expect(isTeachable("fact", undefined)).toBe(false);
		expect(isTeachable("fact", "")).toBe(false);
	});

	test("the prefix alone names no topic, so it is not a teachable", () => {
		expect(isTeachable("fact", "teachable:")).toBe(false);
		expect(teachableSlug("teachable:")).toBeNull();
	});

	test("matching normalises the way the gate stores a subject", () => {
		expect(isTeachable("fact", "  Teachable:Retry-Budget  ")).toBe(true);
		expect(teachableSlug("  Teachable:Retry-Budget  ")).toBe("retry-budget");
	});

	test("the slug is the part after the prefix", () => {
		expect(teachableSlug("teachable:retry-budget")).toBe("retry-budget");
		expect(teachableSlug("retry-budget")).toBeNull();
		expect(teachableSlug(undefined)).toBeNull();
	});
});

describe("teachableEvent", () => {
	const request = {
		scope: "graph:ut-1",
		kind: "fact" as const,
		text: "retry with a capped budget and backoff",
		writer: "hermes" as Surface,
		subject: "teachable:retry-budget",
		session_id: "sess-1",
		graph_id: "ut-1",
	};
	const entry: MemoryEntry = {
		id: "mem_1",
		scope: "graph:ut-1",
		kind: "fact",
		text: "retry with a capped budget and backoff",
		writer: "hermes",
		subject: "teachable:retry-budget",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "graph",
		created: "2026-10-10T00:00:00.000Z",
		version: 1,
		entry_hash: "ab".repeat(32),
		needs_reverification: false,
	};
	const result = {
		outcome: "accepted" as const,
		reason: "accepted",
		remedy: "Stored and read back.",
		verified_persisted: true,
		idempotency_key: "k1",
		writer: "hermes",
		entry,
	};

	test("carries the entry id and its content hash, never the body", () => {
		const event = teachableEvent("hermes", request, result);

		expect(event.kind).toBe("note");
		expect(event.surface).toBe("hermes");
		expect(event.summary).toBe("teachable accepted: retry-budget");
		expect(event.session_id).toBe("sess-1");
		expect(event.graph_id).toBe("ut-1");
		expect(event.payload).toEqual({
			action: "teachable",
			memory_id: "mem_1",
			subject: "teachable:retry-budget",
			content_sha256: "ab".repeat(32),
		});
		expect(JSON.stringify(event)).not.toContain("capped budget");
	});

	test("omits session and graph where the caller sent none", () => {
		const { session_id: _s, graph_id: _g, ...bare } = request;
		const event = teachableEvent("hermes", bare, result);

		expect(event).not.toHaveProperty("session_id");
		expect(event).not.toHaveProperty("graph_id");
		expect(event.payload).toMatchObject({ action: "teachable", memory_id: "mem_1" });
	});
});

describe("teachable.accepted sample conformance", () => {
	test("the builder matches the mapped sample's shape", () => {
		const mapped = EVENT_SOURCES.find((source) => source.id === "teachable.accepted");
		expect(mapped).toBeDefined();
		expect(mapped?.kind).toBe("note");
		expect(mapped?.actions).toEqual(["teachable"]);

		const sample = mapped?.sample() as { surface: string; kind: string; summary: string; payload: Record<string, unknown> };
		const event = teachableEvent(
			"hermes",
			{
				scope: "graph:ut-1",
				kind: "fact",
				text: "retry with a capped budget and backoff",
				writer: "hermes",
				subject: "teachable:retry-budget",
				session_id: "sess-p17-teachable",
			},
			{
				outcome: "accepted",
				reason: "accepted",
				remedy: "Stored and read back.",
				verified_persisted: true,
				idempotency_key: "k1",
				writer: "hermes",
				entry: {
					id: "mem-p17-1",
					scope: "graph:ut-1",
					kind: "fact",
					text: "retry with a capped budget and backoff",
					writer: "hermes",
					actor: "agent",
					trust: "agent-claimed",
					ttl: "graph",
					created: "2026-10-10T00:00:00.000Z",
					version: 1,
					entry_hash: "0123456789abcdef".repeat(4),
					needs_reverification: false,
				},
			},
		);

		// Shape, not values: kind, the writer-as-surface semantics, the action,
		// and exactly the sample's payload keys — so vocabulary-smoke cannot drift.
		expect(sample.kind).toBe("note");
		expect(event.kind).toBe("note");
		expect((SURFACES as readonly string[])).toContain(event.surface);
		expect(event.summary).toMatch(/^teachable accepted: \S+/);
		expect(event.payload?.["action"]).toBe(sample.payload["action"]);
		expect(Object.keys(event.payload ?? {}).sort()).toEqual(Object.keys(sample.payload).sort());
		expect(event.payload?.["content_sha256"]).toMatch(/^[0-9a-f]{64}$/);
	});
});

/**
 * The narrowest store the gate needs for an append-only fact: claims are
 * honoured, rows land and read back, nothing else the accepted path touches
 * moves. Refusals never reach it — RBAC and classification run first.
 */
class TeachableStore implements MemoryStore {
	readonly rows = new Map<string, MemoryEntry>();
	private readonly claims = new Map<
		string,
		{ holder: string; outcome: string; entry_id: string | null; entry_hash: string; request_hash: string }
	>();
	private holders = 0;
	/** Makes the read-back miss: the only way to reach `accepted.unverified`. */
	hideFromReadBack = false;

	async claimWrite(input: {
		key: string;
		explicit: boolean;
		entryHash: string;
		requestHash: string;
		entryId: string;
	}): Promise<ClaimResult> {
		const existing = this.claims.get(input.key);
		if (existing && existing.outcome !== "in-flight") {
			return {
				claimed: false,
				existing: {
					idempotency_key: input.key,
					explicit: input.explicit,
					outcome: existing.outcome as "accepted",
					entry_id: existing.entry_id,
					entry_hash: existing.entry_hash,
					request_hash: existing.request_hash,
				},
			};
		}
		const holder = `hold_${++this.holders}`;
		this.claims.set(input.key, {
			holder,
			outcome: "in-flight",
			entry_id: input.entryId,
			entry_hash: input.entryHash,
			request_hash: input.requestHash,
		});
		return { claimed: true, holder, tookOverFrom: null };
	}

	async finishWrite(key: string, holder: string, outcome: "accepted" | "conflict" | "quarantined" | "denied", entryId: string | null): Promise<void> {
		const record = this.claims.get(key);
		if (record?.holder === holder) this.claims.set(key, { ...record, outcome, entry_id: entryId });
	}

	async releaseWrite(): Promise<void> {}
	async restoreWrite(): Promise<void> {}
	async standingEntry(): Promise<MemoryEntry | null> {
		return null;
	}

	async insertEntry(
		row: NewMemoryEntry,
		claim: { key: string; holder: string },
	): Promise<{ ok: true; entry: MemoryEntry } | { ok: false; reason: "standing-moved" | "claim-lost" | "standing-exists" }> {
		const owner = this.claims.get(claim.key);
		if (owner?.holder !== claim.holder || owner.outcome !== "in-flight") return { ok: false, reason: "claim-lost" };
		const entry: MemoryEntry = {
			id: row.id,
			scope: row.scope,
			kind: row.kind,
			text: row.text,
			writer: row.writer,
			actor: row.actor,
			trust: row.trust,
			ttl: row.ttl,
			created: new Date().toISOString(),
			version: row.version,
			entry_hash: row.entry_hash,
			needs_reverification: false,
			...(row.subject ? { subject: row.subject } : {}),
			...(row.session_id ? { session_id: row.session_id } : {}),
			...(row.graph_id ? { graph_id: row.graph_id } : {}),
			...(row.idempotency_key ? { idempotency_key: row.idempotency_key } : {}),
		};
		this.rows.set(row.id, entry);
		return { ok: true, entry };
	}

	async readEntry(id: string): Promise<MemoryEntry | null> {
		if (this.hideFromReadBack) return null;
		return this.rows.get(id) ?? null;
	}

	async quarantineEntry(): Promise<string> {
		return "memq_1";
	}

	async enqueueReview(): Promise<string> {
		return "rev_1";
	}

	async releaseReviews(): Promise<number> {
		return 0;
	}
}

function teachableWorld(store: TeachableStore) {
	const emitted: SubstrateEvent[] = [];
	const greptime = {
		ensureAppendMode: async () => true,
		lastHash: async () => null,
		insertEvent: async (event: SubstrateEvent) => {
			emitted.push(event);
		},
	};
	const substrate = new Substrate(loadConfig({}), { index: store as never, greptime: greptime as never });
	return { substrate, emitted };
}

const TEACHABLE = {
	scope: "graph:ut-1",
	kind: "fact" as const,
	text: "retry with a capped budget and backoff",
	writer: "hermes",
	subject: "teachable:retry-budget",
	session_id: "sess-1",
	graph_id: "ut-1",
};

const teachableEvents = (emitted: SubstrateEvent[]) => emitted.filter((event) => event.payload["action"] === "teachable");

describe("writeMemory emits the teachable trail", () => {
	test("an accepted teachable emits one sample-shaped note", async () => {
		const { substrate, emitted } = teachableWorld(new TeachableStore());

		const result = await substrate.writeMemory({ ...TEACHABLE });

		expect(result.outcome).toBe("accepted");
		expect(result.verified_persisted).toBe(true);
		const trail = teachableEvents(emitted);
		expect(trail).toHaveLength(1);
		expect(trail[0]?.kind).toBe("note");
		expect(trail[0]?.surface).toBe("hermes");
		expect(trail[0]?.summary).toBe("teachable accepted: retry-budget");
		expect(trail[0]?.session_id).toBe("sess-1");
		expect(trail[0]?.payload).toEqual({
			action: "teachable",
			memory_id: result.entry?.id,
			subject: "teachable:retry-budget",
			content_sha256: result.entry?.entry_hash,
		});
		expect(trail[0]?.payload["content_sha256"]).toMatch(/^[0-9a-f]{64}$/);
	});

	test("an accepted ordinary fact emits nothing new", async () => {
		const { substrate, emitted } = teachableWorld(new TeachableStore());

		const result = await substrate.writeMemory({ ...TEACHABLE, subject: "retry-budget" });

		expect(result.outcome).toBe("accepted");
		expect(emitted).toEqual([]);
	});

	test("an unverified accept emits no trail — durability is the precondition", async () => {
		const store = new TeachableStore();
		store.hideFromReadBack = true;
		const { substrate, emitted } = teachableWorld(store);

		const result = await substrate.writeMemory({ ...TEACHABLE });

		expect(result.outcome).toBe("accepted");
		expect(result.verified_persisted).toBe(false);
		expect(teachableEvents(emitted)).toEqual([]);
	});

	test("a quarantined teachable emits no teachable event — only the refusal trail", async () => {
		const { substrate, emitted } = teachableWorld(new TeachableStore());

		const result = await substrate.writeMemory({
			...TEACHABLE,
			text: "the poller needs GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa tonight",
		});

		expect(result.outcome).toBe("quarantined");
		expect(teachableEvents(emitted)).toEqual([]);
		// The existing audit trail still records the refusal; the emit adds nothing.
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.kind).toBe("warning");
	});

	test("a denied teachable emits nothing at all", async () => {
		const { substrate, emitted } = teachableWorld(new TeachableStore());

		const result = await substrate.writeMemory({ ...TEACHABLE, writer: "unknown" });

		expect(result.outcome).toBe("denied");
		expect(emitted).toEqual([]);
	});

	test("a conflicting teachable emits no teachable event", async () => {
		const { substrate, emitted } = teachableWorld(new TeachableStore());

		const first = await substrate.writeMemory({ ...TEACHABLE, idempotency_key: "k-teach" });
		expect(first.outcome).toBe("accepted");
		expect(teachableEvents(emitted)).toHaveLength(1);

		// Same key, different content: the key is spent, so the retry collides.
		const clash = await substrate.writeMemory({
			...TEACHABLE,
			text: "a different lesson under the same key",
			idempotency_key: "k-teach",
		});
		expect(clash.outcome).toBe("conflict");
		expect(teachableEvents(emitted)).toHaveLength(1);
	});

	test("a failed trail write never fails the memory write", async () => {
		const store = new TeachableStore();
		const substrate = new Substrate(loadConfig({}), {
			index: store as never,
			greptime: {
				ensureAppendMode: async () => true,
				lastHash: async () => null,
				insertEvent: async () => {
					throw new Error("ledger down");
				},
			} as never,
		});

		const result = await substrate.writeMemory({ ...TEACHABLE });

		expect(result.outcome).toBe("accepted");
		expect(result.verified_persisted).toBe(true);
	});
});
