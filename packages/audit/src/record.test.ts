import { describe, expect, test } from "bun:test";
import { canonicalJson as ledgerCanonicalJson, sha256Hex as ledgerSha256Hex } from "../../mcp-server/src/event.ts";
import {
	ChainWalker,
	MAX_IDENTIFIER,
	MAX_RECORD_BYTES,
	MAX_TOOL_NAME,
	NO_POSITION,
	argDigest,
	auditStats,
	buildRecord,
	canonicalJson,
	isAuditRecord,
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

describe("what the audit stores of a caller's identifiers", () => {
	const chain = { seq: 1, prev: null };
	const now = new Date("2026-09-30T06:54:39.000Z");
	// The same redactor shape `packages/mcp-server` injects: enough of it to prove the
	// field is passed through one, not to re-test the rules.
	const redact = (text: string) => text.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
	const secret = `sk-ant-${"a".repeat(30)}`;

	test("a credential in graph_id, node_id or session_id is redacted, not stored", () => {
		// `buildRecord` runs before any tool validates its arguments, so these are whatever
		// was in the envelope — including on a call that was refused and never ran, which
		// is the call an audit is most likely to be holding. The app-event write path has
		// stripped these since SPE-4791; a trail that kept what the ledger drops would be
		// the more attractive copy of the two.
		const record = buildRecord(
			{
				surface: "omp",
				tool: "graph_claim",
				decision: "allowed",
				mode: "fail-closed",
				graph_id: `ut-${secret}`,
				node_id: secret,
				session_id: `s-${secret}`,
			},
			chain,
			now,
			redact,
		);

		expect(JSON.stringify(record)).not.toContain("sk-ant-");
		expect(record.graph_id).toBe("ut-[REDACTED]");
		expect(record.node_id).toBe("[REDACTED]");
		expect(record.session_id).toBe("s-[REDACTED]");
	});

	test("so is one in the tool name, the surface and the actor", () => {
		const record = buildRecord(
			{ surface: secret, tool: `tool_${secret}`, decision: "denied", mode: "fail-closed", actor: secret },
			chain,
			now,
			redact,
		);

		expect(JSON.stringify(record)).not.toContain("sk-ant-");
		expect(record.tool).toBe("tool_[REDACTED]");
		expect(record.surface).toBe("[REDACTED]");
		expect(record.actor).toBe("[REDACTED]");
	});

	test("and one in an argument *name*, which is stored where the values are not", () => {
		const record = buildRecord(
			{ surface: "omp", tool: "graph_get", decision: "allowed", mode: "fail-open", args: { [secret]: 1, graph_id: "ut-1" } },
			chain,
			now,
			redact,
		);

		expect(record.arg_keys).toEqual(["[REDACTED]", "graph_id"]);
		expect(JSON.stringify(record.arg_keys)).not.toContain("sk-ant-");
	});

	test("the digest is over the arguments as submitted, so redaction cannot move it", () => {
		// The digest's whole job is proving that a request an investigator holds is the one
		// that was allowed. Digesting a redacted copy would break that for every request
		// with a credential-shaped string anywhere in it.
		const args = { graph_id: secret };
		const redacted = buildRecord(
			{ surface: "omp", tool: "graph_get", decision: "allowed", mode: "fail-open", args },
			chain,
			now,
			redact,
		);
		expect(redacted.arg_digest).toBe(argDigest(args).digest);
	});

	test("every stored field is capped, whatever the caller sends", () => {
		const record = buildRecord(
			{
				surface: "s".repeat(4000),
				tool: "t".repeat(4000),
				decision: "denied",
				mode: "fail-closed",
				reason: "r".repeat(4000),
				graph_id: "g".repeat(4000),
				node_id: "n".repeat(4000),
				session_id: "i".repeat(4000),
				actor: "a".repeat(4000),
			},
			chain,
			now,
		);

		expect(record.surface).toHaveLength(MAX_IDENTIFIER);
		expect(record.graph_id).toHaveLength(MAX_IDENTIFIER);
		expect(record.node_id).toHaveLength(MAX_IDENTIFIER);
		expect(record.session_id).toHaveLength(MAX_IDENTIFIER);
		expect(record.actor).toHaveLength(MAX_IDENTIFIER);
		expect(record.tool).toHaveLength(MAX_TOOL_NAME);
		// An identifier this substrate will actually accept is 512 bytes at most on the
		// event path, so nothing it serves is truncated here.
		expect(MAX_IDENTIFIER).toBe(512);
	});

	test("a record is smaller than the bound the recovery window is sized against", () => {
		const args: Record<string, unknown> = {};
		for (let i = 0; i < 400; i++) args[`${i}-${"k".repeat(900)}`] = i;
		const record = buildRecord(
			{
				surface: "s".repeat(4000),
				tool: "t".repeat(4000),
				decision: "denied",
				mode: "fail-closed",
				reason: "r".repeat(4000),
				graph_id: "g".repeat(4000),
				node_id: "n".repeat(4000),
				session_id: "i".repeat(4000),
				actor: "a".repeat(4000),
				args,
			},
			chain,
			now,
		);

		expect(JSON.stringify(record).length).toBeLessThan(MAX_RECORD_BYTES);
	});

	test("an empty string is stored as null, not as an empty identifier", () => {
		const record = buildRecord(
			{ surface: "omp", tool: "graph_get", decision: "allowed", mode: "fail-open", graph_id: "" },
			chain,
			now,
		);
		expect(record.graph_id).toBeNull();
	});
});

describe("isAuditRecord", () => {
	test("rejects the JSON values that parse but are not records", () => {
		// A line holding `null` is valid JSONL. Verification read `.hash` off it and threw,
		// so `/evidence` answered 500 rather than reporting a corrupt audit file.
		for (const value of [null, undefined, 1, "x", [], [1, 2], {}, { seq: 1 }, { hash: "h" }, { hash: "h", seq: 1.5 }]) {
			expect(isAuditRecord(value)).toBe(false);
		}
	});

	test("accepts a record, and one carrying a field it does not know about", () => {
		const record = buildRecord(
			{ surface: "omp", tool: "graph_get", decision: "allowed", mode: "fail-open" },
			{ seq: 1, prev: null },
			new Date(),
		);
		expect(isAuditRecord(record)).toBe(true);
		expect(isAuditRecord({ ...record, somethingNew: true })).toBe(true);
	});
});

describe("verifyAuditChain on a malformed line", () => {
	test("reports a verdict instead of throwing", () => {
		const first = buildRecord(
			{ surface: "omp", tool: "graph_get", decision: "allowed", mode: "fail-open" },
			{ seq: 1, prev: null },
			new Date(),
		);
		const verdict = verifyAuditChain([first, null as unknown as AuditRecord]);

		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.brokenAt).toBe(NO_POSITION);
		expect(verdict.ok === false && verdict.reason).toContain("is not an audit record");
		expect(verdict.records).toBe(2);
	});
});

describe("ChainWalker", () => {
	function chainOf(count: number): AuditRecord[] {
		const records: AuditRecord[] = [];
		let prev: string | null = null;
		for (let seq = 1; seq <= count; seq++) {
			const record = buildRecord(
				{ surface: "omp", tool: "graph_get", decision: "allowed", mode: "fail-open" },
				{ seq, prev },
				new Date(2026, 0, seq),
			);
			records.push(record);
			prev = record.hash;
		}
		return records;
	}

	test("agrees with verifyAuditChain, which is the point of there being one of it", () => {
		// The streaming caller and the in-memory one must not be able to disagree about
		// whether a file verifies.
		const records = chainOf(4);
		const walker = new ChainWalker();
		for (const record of records) walker.push(record);

		expect(walker.verdict()).toEqual(verifyAuditChain(records));
		expect(walker.ok).toBe(true);
	});

	test("keeps the first break and counts every record after it", () => {
		const records = chainOf(4);
		const tampered = [...records];
		tampered[1] = { ...(records[1] as AuditRecord), surface: "muse" };
		const walker = new ChainWalker();
		for (const record of tampered) walker.push(record);

		expect(walker.verdict()).toEqual({ ok: false, records: 4, brokenAt: 2, reason: "hash does not match contents" });
	});

	test("genesis: false lets a bounded window open past seq 1", () => {
		const walker = new ChainWalker({ genesis: false });
		for (const record of chainOf(3).slice(1)) walker.push(record);
		expect(walker.verdict().ok).toBe(true);
	});
});
