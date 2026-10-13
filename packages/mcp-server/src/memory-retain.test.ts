/**
 * The gate-accepted retain forward proven against the fake banks server.
 *
 * Only accepted, sourced, redacted memories reach their writer's bank
 * exactly once per idempotency key; everything else warns without touching
 * the write — which already succeeded, so the forward never blocks it.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { HindsightFake } from "./hindsight-fake.ts";
import { forwardRetain, type RetainDeps } from "./memory-retain.ts";
import { clearEnsuredBanks, type HindsightConfig } from "./planes/hindsight.ts";
import type { EventInput, MemoryEntry, MemoryWriteResult } from "./types.ts";

const CONFIG: HindsightConfig = { url: "http://fake", apiKey: "test-bearer", bankPrefix: "sub-" };

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: "mem_1",
		scope: "repo:acme/app",
		kind: "fact",
		text: "fence the lease before handoff",
		writer: "cursor",
		actor: "agent",
		trust: "agent-claimed",
		// Permanent, so these forwards never age into `retain.expired`; lifetime has its own tests below.
		ttl: "permanent",
		created: "2026-10-10T00:00:00.000Z",
		version: 1,
		entry_hash: "hash_1",
		needs_reverification: false,
		...overrides,
	};
}

function accepted(overrides: Partial<MemoryWriteResult> = {}): MemoryWriteResult {
	return {
		outcome: "accepted",
		reason: "stored",
		remedy: "durable",
		verified_persisted: true,
		idempotency_key: "mwd_key1",
		writer: "cursor",
		entry: entry(),
		...overrides,
	};
}

function sourced() {
	return { source_event: "evt_proof_run" };
}

function setup(): { fake: HindsightFake; emitted: EventInput[]; deps: RetainDeps } {
	clearEnsuredBanks();
	const fake = new HindsightFake();
	const emitted: EventInput[] = [];
	const deps: RetainDeps = {
		config: CONFIG,
		fetchImpl: fake.fetch,
		emit: async (event: EventInput) => {
			emitted.push(event);
			return { stored: true };
		},
	};
	return { fake, emitted, deps };
}

describe("forwardRetain", () => {
	test("an accepted sourced memory lands once in its writer bank as a faithful copy", async () => {
		const { fake, emitted, deps } = setup();
		const outcome = await forwardRetain(deps, { ...sourced(), scope: "repo:acme/app", kind: "fact", text: "x", writer: "cursor" }, accepted());
		expect(outcome).toEqual({ forwarded: true, bank: "sub-cursor", document_id: "mwd_key1" });
		expect(fake.banks.get("sub-cursor")?.mode).toBe("chunks");
		expect(fake.retains.length).toBe(1);
		expect(fake.retains[0]?.bank).toBe("sub-cursor");
		const item = fake.retains[0]?.item;
		if (item === null || item === undefined || typeof item !== "object") throw new Error("no retained item");
		expect(item).toMatchObject({
			content: "fence the lease before handoff",
			document_id: "mwd_key1",
			update_mode: "replace",
		});
		if (!("tags" in item) || !Array.isArray(item.tags)) throw new Error("retained item had no tags");
		expect(item.tags).toContain("cursor");
		if (!("metadata" in item) || item.metadata === null || typeof item.metadata !== "object") {
			throw new Error("retained item had no metadata");
		}
		for (const value of Object.values(item.metadata)) expect(typeof value).toBe("string");
		expect(emitted).toEqual([]);
	});

	test("a retry under the same key replaces instead of duplicating", async () => {
		const { fake, deps } = setup();
		const request = { ...sourced(), scope: "repo:acme/app", kind: "fact" as const, text: "x", writer: "cursor" };
		await forwardRetain(deps, request, accepted());
		const outcome = await forwardRetain(deps, request, accepted());
		expect(outcome.forwarded).toBe(true);
		expect(fake.banks.get("sub-cursor")?.memories.length).toBe(1);
	});

	test("unaccepted or unverified writes forward nothing and warn nothing", async () => {
		for (const result of [
			accepted({ outcome: "denied", verified_persisted: false, entry: undefined }),
			accepted({ outcome: "quarantined", verified_persisted: false, entry: undefined }),
			accepted({ outcome: "conflict", verified_persisted: false, entry: undefined }),
			accepted({ verified_persisted: false }),
		]) {
			const { fake, emitted, deps } = setup();
			const outcome = await forwardRetain(
				deps,
				{ ...sourced(), scope: "repo:acme/app", kind: "fact", text: "x", writer: "cursor" },
				result,
			);
			expect(outcome).toMatchObject({ forwarded: false, reason: "not-accepted" });
			expect(fake.requests.length).toBe(0);
			expect(emitted).toEqual([]);
		}
	});

	test("an unsourced write is refused with a locator-only warning", async () => {
		const { fake, emitted, deps } = setup();
		const outcome = await forwardRetain(
			deps,
			{ scope: "repo:acme/app", kind: "fact", text: "x", writer: "cursor" },
			accepted(),
		);
		expect(outcome).toMatchObject({ forwarded: false, reason: "retain.unsourced" });
		expect(fake.requests.length).toBe(0);
		expect(emitted.length).toBe(1);
		expect(emitted[0]).toMatchObject({
			kind: "warning",
			payload: { action: "memory.retain", reason: "retain.unsourced", bank: "sub-cursor", document_id: "mwd_key1" },
		});
	});

	test("a secret finding refuses the forward and names the rule, never the value", async () => {
		const { fake, emitted, deps } = setup();
		const outcome = await forwardRetain(
			deps,
			{ ...sourced(), scope: "repo:acme/app", kind: "fact", text: "x", writer: "cursor" },
			accepted({ entry: entry({ text: "deploy password: hunter2" }) }),
		);
		expect(outcome.forwarded).toBe(false);
		expect(outcome.reason).toBe("retain.unredacted");
		expect(outcome.rules).toContain("password");
		expect(fake.requests.length).toBe(0);
		expect(emitted.length).toBe(1);
		const payload = emitted[0]?.payload;
		expect(payload).toMatchObject({ action: "memory.retain", reason: "retain.unredacted", entry_hash: "hash_1" });
		expect(JSON.stringify(emitted[0])).not.toContain("hunter2");
	});

	test("a plane failure warns without re-opening the write", async () => {
		const { fake, emitted, deps } = setup();
		fake.failRetainWith = 500;
		const outcome = await forwardRetain(
			deps,
			{ ...sourced(), scope: "repo:acme/app", kind: "fact", text: "x", writer: "cursor" },
			accepted(),
		);
		expect(outcome).toMatchObject({ forwarded: false });
		expect(outcome.reason).toContain("retain-");
		expect(emitted.length).toBe(1);
		expect(emitted[0]).toMatchObject({ kind: "warning", payload: { action: "memory.retain" } });
	});

	test("a VM guest is refused before any network call", async () => {
		const { fake, emitted, deps } = setup();
		const outcome = await forwardRetain(
			{ ...deps, vmGuest: true },
			{ ...sourced(), scope: "repo:acme/app", kind: "fact", text: "x", writer: "cursor" },
			accepted(),
		);
		expect(outcome).toMatchObject({ forwarded: false, reason: "vm-guest" });
		expect(fake.requests.length).toBe(0);
		expect(emitted.length).toBe(1);
	});

	test("an unconfigured plane is a silent no-op", async () => {
		const { fake, emitted, deps } = setup();
		const outcome = await forwardRetain(
			{ ...deps, config: null },
			{ ...sourced(), scope: "repo:acme/app", kind: "fact", text: "x", writer: "cursor" },
			accepted(),
		);
		expect(outcome).toMatchObject({ forwarded: false, reason: "hindsight is not configured" });
		expect(fake.requests.length).toBe(0);
		expect(emitted).toEqual([]);
	});

	test("an entry past its ttl is refused in either expiry mode — a dead memory is never copied into a bank", async () => {
		// The forward does not know the mode, by design: `report` is about what the
		// index still serves, and a bank keeps what it is given until replaced.
		const { fake, emitted, deps } = setup();
		const request = { ...sourced(), scope: "repo:acme/app", kind: "fact" as const, text: "x", writer: "cursor" };
		const stale = entry({ ttl: "30d", created: new Date(Date.now() - 31 * 86_400_000).toISOString() });
		const outcome = await forwardRetain(deps, request, accepted({ entry: stale }));
		expect(outcome).toMatchObject({ forwarded: false, reason: "retain.expired" });
		expect(fake.requests.length).toBe(0);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({
			kind: "warning",
			payload: { action: "memory.retain", reason: "retain.expired", ttl: "30d", expiry: "30d", bank: "sub-cursor", document_id: "mwd_key1" },
		});
		expect(JSON.stringify(emitted[0])).not.toContain("fence the lease");

		// Day 29 of the same class forwards.
		const fresh = entry({ ttl: "30d", created: new Date(Date.now() - 29 * 86_400_000).toISOString() });
		expect((await forwardRetain(deps, request, accepted({ entry: fresh }))).forwarded).toBe(true);
	});

	test("a graph entry is judged against the graph the index knows, and forwarded when nobody can say", async () => {
		const request = { ...sourced(), scope: "graph:ut-1", kind: "fact" as const, text: "x", writer: "cursor" };
		const scoped = entry({ ttl: "graph", scope: "graph:ut-1", graph_id: "ut-1" });
		const asked: string[] = [];
		for (const [status, forwarded, reason] of [
			["In Progress", true, undefined],
			["Merged", false, "graph-terminal"],
			[null, false, "graph-unindexed"],
		] as const) {
			const { fake, emitted, deps } = setup();
			const outcome = await forwardRetain(
				{
					...deps,
					graphLifetime: async (candidate) => {
						asked.push(candidate.graph_id ?? "");
						return status === null ? null : { status };
					},
				},
				request,
				accepted({ entry: scoped }),
			);
			expect(outcome.forwarded).toBe(forwarded);
			expect(fake.retains.length).toBe(forwarded ? 1 : 0);
			if (!forwarded) expect(emitted[0]).toMatchObject({ payload: { reason: "retain.expired", ttl: "graph", expiry: reason } });
		}
		expect(asked).toEqual(["ut-1", "ut-1", "ut-1"]);

		// No resolver (no index at hand): alive rather than guessed dead. A resolver
		// that fails is the same — this forward, not the entry, pays for the outage.
		const bare = setup();
		expect((await forwardRetain(bare.deps, request, accepted({ entry: scoped }))).forwarded).toBe(true);
		const failing = setup();
		const outcome = await forwardRetain(
			{ ...failing.deps, graphLifetime: async () => { throw new Error("index down"); } },
			request,
			accepted({ entry: scoped }),
		);
		expect(outcome.forwarded).toBe(true);
	});
});

describe("supersede", () => {
	test("a newer version of a subject-addressed memory replaces the retired copy", async () => {
		const { fake, emitted, deps } = setup();
		const request = { ...sourced(), scope: "repo:acme/app", kind: "fact" as const, text: "x", writer: "cursor" };
		const first = await forwardRetain(deps, request, accepted({ idempotency_key: "mwd_old", entry: entry({ subject: "lease", text: "old rule" }) }));
		const second = await forwardRetain(deps, request, accepted({ idempotency_key: "mwd_new", entry: entry({ subject: "lease", text: "new rule" }) }));
		expect(first.forwarded).toBe(true);
		expect(second.forwarded).toBe(true);
		expect(second.document_id).toBe(first.document_id);
		expect(second.document_id).not.toBe("mwd_new");
		const memories = fake.banks.get("sub-cursor")?.memories ?? [];
		expect(memories.length).toBe(1);
		expect(memories.at(0)?.document_id).toBe(first.document_id);
		expect(emitted).toEqual([]);
	});

	test("subject-less appends keep the idempotency key", async () => {
		const { deps } = setup();
		const outcome = await forwardRetain(
			deps,
			{ ...sourced(), scope: "repo:acme/app", kind: "fact", text: "x", writer: "cursor" },
			accepted({ idempotency_key: "mwd_key9", entry: entry({ subject: undefined }) }),
		);
		expect(outcome).toMatchObject({ forwarded: true, document_id: "mwd_key9" });
	});
});
