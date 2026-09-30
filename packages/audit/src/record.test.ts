import { describe, expect, test } from "bun:test";
import { canonicalJson as ledgerCanonicalJson, sha256Hex as ledgerSha256Hex } from "../../mcp-server/src/event.ts";
import {
	argDigest,
	auditStats,
	buildRecord,
	canonicalJson,
	recordHash,
	sealRecord,
	sha256Hex,
	verifyAuditChain,
	type AuditRecord,
} from "./record.ts";

describe("the digest agrees with the ledger's", () => {
	// The two chains are deliberately separate stores, but they are the same
	// construction: sha256 over canonical JSON with `prev` inside the hash. This
	// pins the encoders together so one verifier's reasoning carries to the other,
	// without this package depending on `mcp-server` at runtime — which would be a
	// cycle, since mcp-server depends on this one.
	const fixtures: unknown[] = [
		{ b: 1, a: 2 },
		{ nested: { z: null, a: [3, 1, 2] } },
		{ unicode: "ünïcode — dash", quote: 'say "hi"', backslash: "C:\\tmp" },
		[1, "two", null, { k: true }],
		{ absent: undefined, present: 0 },
		"bare string",
		null,
	];

	test("canonical JSON is byte-identical", () => {
		for (const fixture of fixtures) expect(canonicalJson(fixture)).toBe(ledgerCanonicalJson(fixture));
	});

	test("so is the hash", () => {
		for (const fixture of fixtures) {
			expect(sha256Hex(canonicalJson(fixture))).toBe(ledgerSha256Hex(ledgerCanonicalJson(fixture)));
		}
	});

	test("both sort object keys and both keep array order", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(canonicalJson([2, 1])).toBe("[2,1]");
	});
});

describe("argDigest", () => {
	test("keeps the argument names and a digest, never the values", () => {
		// Storing the arguments would make the audit a second, permanent copy of
		// everything every agent ever sent to the substrate.
		const { keys, digest } = argDigest({ graph_id: "ut-1", text: "the API key is sk-ant-secret" });

		expect(keys).toEqual(["graph_id", "text"]);
		expect(digest).toHaveLength(64);
		expect(JSON.stringify({ keys, digest })).not.toContain("sk-ant-secret");
	});

	test("is reproducible from the arguments, so a held request can be proved to be the one allowed", () => {
		const args = { graph_id: "ut-1", node_id: "n4" };
		expect(argDigest(args).digest).toBe(argDigest({ node_id: "n4", graph_id: "ut-1" }).digest);
	});

	test("different arguments digest differently", () => {
		expect(argDigest({ node_id: "n4" }).digest).not.toBe(argDigest({ node_id: "n5" }).digest);
	});

	test("no arguments means no digest, not a digest of nothing", () => {
		expect(argDigest(undefined)).toEqual({ keys: [], digest: null });
		expect(argDigest(null)).toEqual({ keys: [], digest: null });
	});

	test("an array of arguments still digests, with no key names to report", () => {
		expect(argDigest([1, 2]).keys).toEqual([]);
		expect(argDigest([1, 2]).digest).not.toBeNull();
	});
});

describe("buildRecord", () => {
	const now = new Date("2026-09-30T06:54:39.000Z");

	test("fills the chain fields and hashes everything but the hash", () => {
		const record = buildRecord(
			{ surface: "omp", tool: "graph_claim", decision: "allowed", mode: "fail-closed", args: { node_id: "n4" } },
			{ seq: 1, prev: null },
			now,
		);

		expect(record).toMatchObject({ seq: 1, prev: null, ts: now.toISOString(), transport: "mcp" });
		const { hash, ...rest } = record;
		expect(recordHash(rest)).toBe(hash);
	});

	test("redacts the reason, because a denial routinely quotes an error", () => {
		const record = buildRecord(
			{
				surface: "omp",
				tool: "graph_claim",
				decision: "denied",
				mode: "fail-closed",
				reason: "postgres://user:hunter2@host/db refused",
			},
			{ seq: 1, prev: null },
			now,
			(text) => text.replace("hunter2", "[REDACTED]"),
		);

		expect(record.reason).not.toContain("hunter2");
		expect(record.reason).toContain("[REDACTED]");
	});

	test("caps a runaway reason", () => {
		const record = buildRecord(
			{ surface: "omp", tool: "x", decision: "denied", mode: "fail-open", reason: "e".repeat(5000) },
			{ seq: 1, prev: null },
			now,
		);

		expect(record.reason?.length).toBeLessThanOrEqual(500);
	});

	test("an empty reason becomes null, so the column is absent rather than blank", () => {
		const record = buildRecord(
			{ surface: "omp", tool: "x", decision: "allowed", mode: "fail-open", reason: "" },
			{ seq: 1, prev: null },
			now,
		);

		expect(record.reason).toBeNull();
	});

	test("prev is inside the digest, so records cannot be reordered undetected", () => {
		const base = { surface: "omp", tool: "x", decision: "allowed", mode: "fail-open" } as const;
		const first = buildRecord(base, { seq: 1, prev: null }, now);
		const second = buildRecord(base, { seq: 1, prev: "aa".repeat(32) }, now);

		expect(first.hash).not.toBe(second.hash);
	});
});

describe("verifyAuditChain", () => {
	function chain(count: number): AuditRecord[] {
		const records: AuditRecord[] = [];
		let prev: string | null = null;
		for (let i = 1; i <= count; i++) {
			const record = buildRecord(
				{ surface: "omp", tool: "graph_get", decision: "allowed", mode: "fail-open" },
				{ seq: i, prev },
				new Date(1_790_186_361_000 + i),
			);
			records.push(record);
			prev = record.hash;
		}
		return records;
	}

	test("an intact chain verifies", () => {
		expect(verifyAuditChain(chain(5))).toEqual({ ok: true, records: 5 });
	});

	test("an empty chain verifies — there is nothing wrong with it", () => {
		expect(verifyAuditChain([])).toEqual({ ok: true, records: 0 });
	});

	test("edited contents are caught by the hash", () => {
		const records = chain(5);
		records[2] = { ...(records[2] as AuditRecord), decision: "denied" };

		expect(verifyAuditChain(records)).toMatchObject({ ok: false, brokenAt: 3, reason: "hash does not match contents" });
	});

	test("a record removed from the middle is caught by prev", () => {
		const records = chain(5);
		records.splice(2, 1);

		expect(verifyAuditChain(records)).toMatchObject({ ok: false, brokenAt: 4 });
	});

	test("a deleted FIRST record is caught by the head check", () => {
		// The hole this closes: remove line one and the untouched second record becomes
		// the new head. Its own hash verifies, every later prev and seq still follows it,
		// and without a head check the shortened chain reported intact — so an evidence
		// bundle would have omitted the removed action and said nothing was wrong.
		const records = chain(5).slice(1);

		const verdict = verifyAuditChain(records);
		expect(verdict.ok).toBe(false);
		expect(verdict).toMatchObject({ brokenAt: 2 });
		expect((verdict as { reason: string }).reason).toContain("does not open at seq 1");
	});

	test("a deliberate window over a chain opts out of the head check", () => {
		// What a memory-only `AuditLog` holds past its retention: a tail that never
		// claimed to be a whole chain. Nothing that reads a file passes this.
		expect(verifyAuditChain(chain(5).slice(2), { genesis: false })).toEqual({ ok: true, records: 3 });
		expect(verifyAuditChain(chain(5).slice(2)).ok).toBe(false);
	});

	test("a head whose prev is set is caught even when its seq is 1", () => {
		// The other half of the head check: a forged head could carry seq 1 while still
		// pointing at a predecessor that is no longer there.
		const [head, ...rest] = chain(3);
		const { hash, ...bare } = head as AuditRecord;
		const forged = sealRecord({ ...bare, prev: "ab".repeat(32) });

		expect(verifyAuditChain([forged, ...rest]).ok).toBe(false);
	});

	test("a rewritten chain that still links is caught by seq", () => {
		// Someone who removed a record and re-chained the rest would produce a chain
		// whose hashes all verify. The sequence number is what still gives it away.
		const records = chain(5).filter((record) => record.seq !== 3);
		let prev: string | null = null;
		const relinked = records.map((record) => {
			const { hash, ...rest } = record;
			const sealed = sealRecord({ ...rest, prev });
			prev = sealed.hash;
			return sealed;
		});

		expect(verifyAuditChain(relinked)).toMatchObject({ ok: false, brokenAt: 4, reason: "seq jumped: expected 3" });
	});
});

describe("auditStats", () => {
	test("tallies by decision, tool and surface", () => {
		const records = [
			buildRecord({ surface: "omp", tool: "graph_claim", decision: "allowed", mode: "fail-closed" }, { seq: 1, prev: null }, new Date()),
			buildRecord({ surface: "omp", tool: "graph_claim", decision: "denied", mode: "fail-closed" }, { seq: 2, prev: null }, new Date()),
			buildRecord({ surface: "muse", tool: "memory_brief", decision: "allowed", mode: "fail-open" }, { seq: 3, prev: null }, new Date()),
		];

		const stats = auditStats(records);
		expect(stats).toMatchObject({ total: 3, allowed: 2, denied: 1 });
		expect(stats.byTool).toEqual([
			{ tool: "graph_claim", allowed: 1, denied: 1 },
			{ tool: "memory_brief", allowed: 1, denied: 0 },
		]);
		expect(stats.bySurface).toEqual([
			{ surface: "muse", allowed: 1, denied: 0 },
			{ surface: "omp", allowed: 1, denied: 1 },
		]);
	});

	test("an empty trail tallies to zero rather than throwing", () => {
		expect(auditStats([])).toEqual({ total: 0, allowed: 0, denied: 0, byTool: [], bySurface: [] });
	});
});
