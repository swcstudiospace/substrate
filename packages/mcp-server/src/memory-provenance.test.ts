import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "./event.ts";
import { memoryProvenance, type MemoryProvenanceDeps } from "./memory-provenance.ts";
import { MemoryVerifyError, type AnchorEvidence } from "./memory-verify.ts";
import type { MemoryEntry } from "./types.ts";

const EVENT = "evt_0123456789abcdef0123456789";
const QUARANTINE_BODY = "quarantined body holding a private email address";

/** A fixture override: a key may be set to `undefined` to drop the default it replaces. */
type EntryOverrides = { [K in keyof MemoryEntry]?: MemoryEntry[K] | undefined };

function entry(id: string, text: string, over: EntryOverrides = {}): MemoryEntry {
	const base = { scope: "repo:agent-substrate", kind: "fact" as const, subject: "deploy.region", text, writer: "claude-code", ...over };
	const preimage = { scope: base.scope, kind: base.kind, subject: base.subject ?? null, text: base.text, writer: base.writer };
	return {
		id,
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		created: "2026-10-20T10:00:00.000Z",
		version: 1,
		needs_reverification: false,
		source_event: EVENT,
		entry_hash: sha256Hex(canonicalJson(preimage)),
		...base,
		...over,
	} as MemoryEntry;
}

const anchored: AnchorEvidence = { status: "anchored", proof_ref: "anchor_2026-10-20T10" };

function deps(
	rows: MemoryEntry[],
	options: {
		evidence?: (eventId: string) => AnchorEvidence;
		reviews?: Map<string, string>;
		quarantines?: Map<string, string>;
	} = {},
): MemoryProvenanceDeps & { anchorCalls: string[] } {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const anchorCalls: string[] = [];
	return {
		anchorCalls,
		getEntry: async (id) => byId.get(id) ?? null,
		anchorEvidence: async (eventId) => {
			anchorCalls.push(eventId);
			return options.evidence ? options.evidence(eventId) : anchored;
		},
		findPendingReviewByHash: async (hash) => options.reviews?.get(hash) ?? null,
		findQuarantineByHash: async (hash) => options.quarantines?.get(hash) ?? null,
	};
}

describe("memoryProvenance chain walk", () => {
	const v1 = entry("mem_0001", "first body");
	const v2 = entry("mem_0002", "second body", { version: 2, supersedes: "mem_0001" });
	const v3 = entry("mem_0003", "third body", { version: 3, supersedes: "mem_0002" });
	const v1b = { ...v1, superseded_by: "mem_0002" };
	const v2b = { ...v2, superseded_by: "mem_0003" };
	const rows = [v1b, v2b, v3];

	test("walks supersedes back and superseded_by forward, oldest first, with a verdict per hop", async () => {
		const d = deps(rows);
		const result = await memoryProvenance(d, "mem_0002");
		expect(result.id).toBe("mem_0002");
		expect(result.chain.map((hop) => hop.id)).toEqual(["mem_0001", "mem_0002", "mem_0003"]);
		expect(result.chain.map((hop) => hop.version)).toEqual([1, 2, 3]);
		expect(result.chain.map((hop) => hop.state)).toEqual(["superseded", "superseded", "current"]);
		expect(result.back).toBe("root");
		expect(result.forward).toBe("current");
		expect(result.dangling).toEqual([]);
		expect(result.forgotten_marker).toBeNull();
		for (const hop of result.chain) {
			expect(hop.verify.status).toBe("verified");
			expect(hop.verify.id).toBe(hop.id);
			expect(hop.content_hash).toBe(hop.verify.content_hash);
			expect(hop.source_event).toBe(EVENT);
			expect(hop.review).toBeNull();
			expect(hop.quarantine).toBeNull();
		}
		// One anchor lookup per hop, in chain order.
		expect(d.anchorCalls).toEqual([EVENT, EVENT, EVENT]);
	});

	test("a single current entry is a one-hop chain", async () => {
		const result = await memoryProvenance(deps([v1]), "mem_0001");
		expect(result.chain.map((hop) => hop.id)).toEqual(["mem_0001"]);
		expect(result.back).toBe("root");
		expect(result.forward).toBe("current");
	});

	test("a forgotten marker is terminal and reported, never followed", async () => {
		const forgotten = { ...v1, superseded_by: "forgotten:fg_0123456789abcdef0123456789" };
		const result = await memoryProvenance(deps([forgotten]), "mem_0001");
		expect(result.forward).toBe("forgotten");
		expect(result.forgotten_marker).toBe("forgotten:fg_0123456789abcdef0123456789");
		expect(result.chain.map((hop) => hop.id)).toEqual(["mem_0001"]);
		expect(result.chain[0]?.state).toBe("forgotten");
	});

	test("a link to a missing entry is dangling and ends that direction", async () => {
		const orphan = entry("mem_0002", "second body", { version: 2, supersedes: "mem_gone" });
		const result = await memoryProvenance(deps([orphan]), "mem_0002");
		expect(result.back).toBe("missing");
		expect(result.dangling).toEqual(["mem_gone"]);
		expect(result.chain.map((hop) => hop.id)).toEqual(["mem_0002"]);
	});

	test("a supersession cycle ends the walk instead of looping", async () => {
		const a = entry("mem_a", "body a", { supersedes: "mem_b" });
		const b = entry("mem_b", "body b", { supersedes: "mem_a" });
		const result = await memoryProvenance(deps([a, b]), "mem_a");
		expect(result.back).toBe("cycle");
		expect(result.chain.map((hop) => hop.id)).toEqual(["mem_b", "mem_a"]);
	});

	test("an unknown starting id is the caller's error, like memory_verify", async () => {
		await expect(memoryProvenance(deps([v1]), "mem_nope")).rejects.toBeInstanceOf(MemoryVerifyError);
		await expect(memoryProvenance(deps([v1]), "")).rejects.toMatchObject({ rule: "bad_id" });
	});

	test("per-hop verdicts differ: a hop whose anchor is pending reports pending", async () => {
		const result = await memoryProvenance(deps(rows, { evidence: () => ({ status: "pending", proof_ref: null }) }), "mem_0002");
		expect(result.chain.map((hop) => hop.verify.status)).toEqual(["pending", "pending", "pending"]);
	});

	test("a hop whose content changed after the write reports hash-mismatch", async () => {
		const tampered = { ...v2b, text: "edited after the gate wrote it" };
		const result = await memoryProvenance(deps([v1b, tampered, v3]), "mem_0002");
		expect(result.chain.map((hop) => hop.verify.status)).toEqual(["verified", "hash-mismatch", "verified"]);
	});
});

describe("memoryProvenance governance rows", () => {
	test("review and quarantine rows are matched on entry_hash and returned as ids", async () => {
		const v1 = entry("mem_0001", "first body");
		const v2 = entry("mem_0002", "second body", { version: 2, supersedes: "mem_0001", superseded_by: "mem_0003" });
		const v3 = entry("mem_0003", "third body", { version: 3, supersedes: "mem_0002" });
		const d = deps([v1, v2, v3], {
			reviews: new Map([[v2.entry_hash, "rev_0001"]]),
			quarantines: new Map([[v3.entry_hash, "quar_0001"]]),
		});
		const result = await memoryProvenance(d, "mem_0002");
		expect(result.chain.map((hop) => hop.review)).toEqual([null, { id: "rev_0001" }, null]);
		expect(result.chain.map((hop) => hop.quarantine)).toEqual([null, null, { id: "quar_0001" }]);
	});

	test("never returns entry text or a quarantined body, on any hop", async () => {
		const v1 = entry("mem_0001", "first body with fra1 secret");
		const v2 = entry("mem_0002", "second body", { version: 2, supersedes: "mem_0001" });
		const d = deps([v1, v2], { quarantines: new Map([[v1.entry_hash, "quar_0001"]]) });
		const result = await memoryProvenance(d, "mem_0002");
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("fra1");
		expect(serialized).not.toContain(QUARANTINE_BODY);
		expect(serialized).not.toContain('"text"');
		expect(serialized).not.toContain('"subject"');
		// hashes and statuses are the payload
		expect(serialized).toContain(v1.entry_hash);
		expect(result.chain[0]?.quarantine).toEqual({ id: "quar_0001" });
	});

	test("an entry with no stored hash matches no governance row", async () => {
		const bare = { ...entry("mem_0001", "first body"), entry_hash: "" };
		const d = deps([bare], { quarantines: new Map([["", "quar_should_not_match"]]) });
		const result = await memoryProvenance(d, "mem_0001");
		expect(result.chain[0]?.review).toBeNull();
		expect(result.chain[0]?.quarantine).toBeNull();
		expect(result.chain[0]?.verify.status).toBe("unverified");
	});
});
