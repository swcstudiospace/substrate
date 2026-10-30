/**
 * What a reflect reply says about the Hindsight leg of a digest: the forward's own outcome, never the mere fact that Hindsight is
 * configured. The legs here are real `forwardRetain` runs against the fake banks server (fine, down, not configured) and
 * hand-made ones (still running, parked for a retry); the memory write in front of them is a fake.
 */
import { describe, expect, test } from "bun:test";
import { HindsightFake } from "../hindsight-fake.ts";
import { forwardRetain, type ForwardOutcome, type RetainDeps } from "../memory-retain.ts";
import { clearEnsuredBanks, type HindsightConfig } from "../planes/hindsight.ts";
import type { EventInput, MemoryEntry, MemoryWriteRequest, MemoryWriteResult } from "../types.ts";
import { deliveryOf, retainDigestOutcome, splitDigestRetain, type DigestRetainDeps } from "./digest-retain.ts";

const CONFIG: HindsightConfig = { url: "http://fake", apiKey: "test-bearer", bankPrefix: "sub-" };

const REQUEST: MemoryWriteRequest = { scope: "repo:acme/app", kind: "fact", text: "# digest", writer: "omp", source_event: "evt_digest_run" };

const ENTRY: MemoryEntry = {
	id: "mem_1",
	scope: "repo:acme/app",
	kind: "fact",
	text: "# digest",
	writer: "omp",
	actor: "agent",
	trust: "agent-claimed",
	ttl: "permanent",
	created: "2026-10-10T00:00:00.000Z",
	version: 1,
	entry_hash: "hash_1",
	needs_reverification: false,
};

const ACCEPTED: MemoryWriteResult = { outcome: "accepted", reason: "stored", remedy: "durable", verified_persisted: true, idempotency_key: "mwd_key1", writer: "omp", entry: ENTRY };

function refused(reason: string): MemoryWriteResult {
	return { outcome: "denied", reason, remedy: "no", verified_persisted: false, idempotency_key: "", writer: "omp" };
}

/** A plane that is up or down, and a leg that is the real forward against it. */
function realLeg(config: HindsightConfig | null, fake: HindsightFake): Promise<ForwardOutcome> {
	clearEnsuredBanks();
	const deps: RetainDeps = { config, fetchImpl: fake.fetch, emit: async (_event: EventInput) => ({ stored: true }) };
	return forwardRetain(deps, REQUEST, ACCEPTED);
}

const NEVER = (): Promise<void> => new Promise<void>(() => undefined);

function deps(over: Partial<DigestRetainDeps> & Pick<DigestRetainDeps, "write">): DigestRetainDeps {
	return { delay: NEVER, ...over };
}

describe("retainDigestOutcome", () => {
	test("a forward that landed is a success", async () => {
		const fake = new HindsightFake();
		const outcome = await retainDigestOutcome(deps({ write: async () => ({ result: ACCEPTED, leg: realLeg(CONFIG, fake) }) }), REQUEST);
		expect(outcome).toEqual({ ok: true });
		expect(fake.retains).toHaveLength(1);
	});

	test("a Hindsight that is down is a failure carrying the plane's closed reason, though Hindsight is configured", async () => {
		const fake = new HindsightFake();
		fake.failRetainWith = 503;
		const outcome = await retainDigestOutcome(deps({ write: async () => ({ result: ACCEPTED, leg: realLeg(CONFIG, fake) }) }), REQUEST);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toMatch(/^retain-/);
	});

	test("no Hindsight configured is not-configured", async () => {
		const outcome = await retainDigestOutcome(deps({ write: async () => ({ result: ACCEPTED, leg: realLeg(null, new HindsightFake()) }) }), REQUEST);
		expect(outcome).toEqual({ ok: false, reason: "not-configured" });
	});

	test("a forward still running at the bound is pending, never a success", async () => {
		const stalled = new Promise<ForwardOutcome>(() => undefined);
		const waited: number[] = [];
		const outcome = await retainDigestOutcome(
			{
				write: async () => ({ result: ACCEPTED, leg: stalled }),
				waitMs: 1234,
				delay: async (ms) => {
					waited.push(ms);
				},
			},
			REQUEST,
		);
		expect(outcome).toEqual({ ok: false, reason: "pending" });
		expect(waited).toEqual([1234]);
	});

	test("a forward parked in the retain outbox for a retry is pending", async () => {
		const parked: ForwardOutcome = { forwarded: false, bank: "sub-omp", document_id: "mwd_key1", reason: "retain-unavailable", queued: true };
		expect(await retainDigestOutcome(deps({ write: async () => ({ result: ACCEPTED, leg: Promise.resolve(parked) }) }), REQUEST)).toEqual({ ok: false, reason: "pending" });
	});

	test("a wait of 0 starts the write and reports pending without waiting", async () => {
		let writes = 0;
		const waited: number[] = [];
		const outcome = await retainDigestOutcome(
			{
				write: async () => {
					writes += 1;
					return { result: ACCEPTED, leg: new Promise<ForwardOutcome>(() => undefined) };
				},
				waitMs: 0,
				delay: async (ms) => {
					waited.push(ms);
				},
			},
			REQUEST,
		);
		expect(writes).toBe(1);
		expect(outcome).toEqual({ ok: false, reason: "pending" });
		expect(waited).toEqual([]);
	});

	test("a forward that settles before the bound is read even when the clock would have expired at once", async () => {
		const landed: ForwardOutcome = { forwarded: true, bank: "sub-omp", document_id: "mwd_key1" };
		const outcome = await retainDigestOutcome({ write: async () => ({ result: ACCEPTED, leg: Promise.resolve(landed) }), delay: async () => undefined }, REQUEST);
		expect(outcome).toEqual({ ok: true });
	});

	test("the governance gate's refusal is the reason and no forward is waited for", async () => {
		const outcome = await retainDigestOutcome(deps({ write: async () => ({ result: refused("rbac.no-grant"), leg: null }) }), REQUEST);
		expect(outcome).toEqual({ ok: false, reason: "rbac.no-grant" });
	});

	test("an accepted write that was not read back is not-verified, and a write that throws is memory-write-failed", async () => {
		const unverified: MemoryWriteResult = { ...ACCEPTED, verified_persisted: false };
		expect(await retainDigestOutcome(deps({ write: async () => ({ result: unverified, leg: null }) }), REQUEST)).toEqual({ ok: false, reason: "not-verified" });
		const throwing = deps({
			write: async () => {
				throw new Error("connection lost");
			},
		});
		expect(await retainDigestOutcome(throwing, REQUEST)).toEqual({ ok: false, reason: "memory-write-failed" });
	});
	test("a landed forward whose write was truncated reports the cut and is still a success", async () => {
		const landed: ForwardOutcome = { forwarded: true, bank: "sub-omp", document_id: "mwd_key1" };
		const outcome = await retainDigestOutcome(
			deps({ write: async () => ({ result: { ...ACCEPTED, truncated: true }, leg: Promise.resolve(landed) }) }),
			REQUEST,
		);
		expect(outcome).toEqual({ ok: true, truncated: true });
	});

	test("a landed forward without the truncated flag stays a plain success", async () => {
		const landed: ForwardOutcome = { forwarded: true, bank: "sub-omp", document_id: "mwd_key1" };
		const outcome = await retainDigestOutcome(deps({ write: async () => ({ result: ACCEPTED, leg: Promise.resolve(landed) }) }), REQUEST);
		expect(outcome).toEqual({ ok: true });
	});
});

describe("deliveryOf", () => {
	test("keeps the forward's own refusal reason and falls back to a closed one", () => {
		expect(deliveryOf({ forwarded: false, bank: "b", document_id: "d", reason: "retain.unredacted" })).toEqual({ ok: false, reason: "retain.unredacted" });
		expect(deliveryOf({ forwarded: false, bank: "b", document_id: "d" })).toEqual({ ok: false, reason: "not-forwarded" });
	});
});


describe("splitDigestRetain", () => {
	test("a digest with all three headings yields the three subjects", () => {
		const text = ["# Digest", "", "## Recent decisions (newest first)", "- a", "", "## Open items (unchecked in the live roadmap)", "- b", "", "## Project", "name"].join("\n");
		const parts = splitDigestRetain("acme/app", text);
		expect(parts.map((part) => part.subject)).toEqual(["corpus-digest:acme/app", "corpus-digest:acme/app:decisions", "corpus-digest:acme/app:open"]);
		expect(parts.every((part) => part.cut === false)).toBe(true);
		expect(parts[1]?.text.startsWith("## Recent decisions")).toBe(true);
		expect(parts[1]?.text.includes("## Open items")).toBe(false);
		expect(parts[2]?.text.startsWith("## Open items")).toBe(true);
		expect(parts[2]?.text).not.toContain("## Project");
		expect(parts[0]?.text).toContain("## Project");
	});

	test("a part longer than 4000 is cut and flagged", () => {
		const text = `${"x".repeat(4001)}\n## Recent decisions\nshort\n## Open items\n${"y".repeat(5000)}`;
		const parts = splitDigestRetain("r", text);
		expect(parts[0]?.cut).toBe(true);
		expect(parts[0]?.text.length).toBeLessThanOrEqual(4000);
		expect(parts[0]?.text.endsWith("\n[cut]\n")).toBe(true);
		expect(parts[1]?.cut).toBe(false);
		expect(parts[2]?.cut).toBe(true);
		expect(parts[2]?.text.length).toBeLessThanOrEqual(4000);
		expect(parts[2]?.text.endsWith("\n[cut]\n")).toBe(true);
		expect(parts[2]?.subject).toBe("corpus-digest:r:open");
	});
});
