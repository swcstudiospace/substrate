import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "./event.ts";
import { verifyMemoryRecord, MemoryVerifyError, type AnchorEvidence, type MemoryVerifyDeps, type VerifyStatus } from "./memory-verify.ts";
import type { MemoryEntry } from "./types.ts";

const BODY = "The staging deploy region is fra1.";
const EVENT = "evt_0123456789abcdef0123456789";

/** A fixture override: a key may be set to `undefined` to drop the default it replaces. */
type EntryOverrides = { [K in keyof MemoryEntry]?: MemoryEntry[K] | undefined };

function entry(over: EntryOverrides = {}, hashVersion: "v1" | "v2" = "v1"): MemoryEntry {
	const base = { scope: "repo:agent-substrate", kind: "fact" as const, subject: "deploy.region", text: BODY, writer: "claude-code", ...over };
	const preimage = { scope: base.scope, kind: base.kind, subject: base.subject ?? null, text: base.text, writer: base.writer };
	const hash = hashVersion === "v1" ? sha256Hex(canonicalJson(preimage)) : sha256Hex(canonicalJson({ ...preimage, hv: 2, tenant: "swc" }));
	return {
		id: "mem_0001",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		created: "2026-10-20T10:00:00.000Z",
		version: 1,
		needs_reverification: false,
		source_event: EVENT,
		entry_hash: hash,
		...base,
		...over,
	} as MemoryEntry;
}

function deps(stored: MemoryEntry | null, evidence: (eventId: string) => Promise<unknown> | unknown, extra: Partial<MemoryVerifyDeps> = {}): MemoryVerifyDeps & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		getEntry: async () => stored,
		anchorEvidence: async (eventId) => {
			calls.push(eventId);
			return (await evidence(eventId)) as AnchorEvidence;
		},
		...extra,
	};
}

const anchored: AnchorEvidence = { status: "anchored", proof_ref: "anchor_2026-10-20T10" };

describe("verifyMemoryRecord verdicts", () => {
	const cases: Array<[string, AnchorEvidence, VerifyStatus]> = [
		["anchored with a proof", anchored, "verified"],
		["pending", { status: "pending", proof_ref: null }, "pending"],
		["unanchored", { status: "unanchored" }, "unanchored"],
		["unverified", { status: "unverified", detail: "checkpoint store down" }, "unverified"],
		["mismatch", { status: "mismatch", proof_ref: "anchor_x" }, "anchor-mismatch"],
	];
	for (const [name, evidence, status] of cases) {
		test(`${name} maps to ${status}`, async () => {
			const d = deps(entry(), () => evidence);
			const result = await verifyMemoryRecord(d, "mem_0001");
			expect(result.status).toBe(status);
			expect(result.reasons.length).toBeGreaterThan(0);
			expect(result.content_checked).toBe(true);
			expect(result.hash_version).toBe("v1");
			expect(result.anchor?.status).toBe(evidence.status);
			expect(d.calls).toEqual([EVENT]);
		});
	}

	test("a verified result names the proof and never carries the body", async () => {
		const result = await verifyMemoryRecord(deps(entry(), () => anchored), "mem_0001");
		expect(result).toMatchObject({ id: "mem_0001", status: "verified", source_event: EVENT, anchor: { status: "anchored", proof_ref: "anchor_2026-10-20T10" } });
		expect(result.reasons.join(" ")).toContain("anchor_2026-10-20T10");
		expect(JSON.stringify(result)).not.toContain("fra1");
	});

	test("a v2 hash verifies too", async () => {
		const result = await verifyMemoryRecord(deps(entry({}, "v2"), () => anchored), "mem_0001");
		expect(result).toMatchObject({ status: "verified", hash_version: "v2" });
	});
});

describe("hash recompute", () => {
	test("a body edited after the write is a hash-mismatch and the anchor is not consulted", async () => {
		const original = entry();
		const d = deps({ ...original, text: `${BODY} Also move it.` }, () => anchored);
		const result = await verifyMemoryRecord(d, "mem_0001");
		expect(result.status).toBe("hash-mismatch");
		expect(result.hash_version).toBeNull();
		expect(d.calls).toEqual([]);
	});

	for (const field of ["scope", "subject", "writer"] as const) {
		test(`an edited ${field} is a hash-mismatch`, async () => {
			const original = entry();
			const result = await verifyMemoryRecord(deps({ ...original, [field]: "changed" } as MemoryEntry, () => anchored), "mem_0001");
			expect(result.status).toBe("hash-mismatch");
		});
	}

	test("an edited kind is a hash-mismatch", async () => {
		const result = await verifyMemoryRecord(deps({ ...entry(), kind: "decision" }, () => anchored), "mem_0001");
		expect(result.status).toBe("hash-mismatch");
	});

	test("a swapped entry_hash is a hash-mismatch", async () => {
		const result = await verifyMemoryRecord(deps({ ...entry(), entry_hash: "0".repeat(64) }, () => anchored), "mem_0001");
		expect(result.status).toBe("hash-mismatch");
	});

	test("a row with no stored hash is unverified, not a mismatch", async () => {
		const result = await verifyMemoryRecord(deps({ ...entry(), entry_hash: "" }, () => anchored), "mem_0001");
		expect(result.status).toBe("unverified");
		expect(result.content_checked).toBe(false);
	});

	test("provenance fields are not part of the gate's hash, so editing them does not change this verdict", async () => {
		// Pinned so nobody reads `verified` as covering trust or timestamps; the capsule digest covers those.
		const result = await verifyMemoryRecord(deps({ ...entry(), trust: "verified-by-test", created: "2020-01-01T00:00:00.000Z" }, () => anchored), "mem_0001");
		expect(result.status).toBe("verified");
	});

	test("a forgotten entry whose body is gone is reported unchecked, then judged on its anchor", async () => {
		const forgotten = { ...entry(), text: "", superseded_by: "forgotten:fg_1" };
		const result = await verifyMemoryRecord(deps(forgotten, () => anchored), "mem_0001");
		expect(result).toMatchObject({ status: "verified", content_checked: false, hash_version: null });
		expect(result.reasons[0]).toContain("forgotten");
	});

	test("a forgotten entry that still has a body is rehashed", async () => {
		const forgotten = { ...entry(), text: "edited", superseded_by: "forgotten:fg_1" };
		expect((await verifyMemoryRecord(deps(forgotten, () => anchored), "mem_0001")).status).toBe("hash-mismatch");
	});
});

describe("source event", () => {
	test("no source_event is unanchored with that reason, never an error", async () => {
		const d = deps(entry({ source_event: undefined }), () => anchored);
		const result = await verifyMemoryRecord(d, "mem_0001");
		expect(result.status).toBe("unanchored");
		expect(result.reasons.join(" ")).toContain("no source_event");
		expect(result.anchor).toBeNull();
		expect(d.calls).toEqual([]);
	});

	test("a session: reference is not a ledger event id", async () => {
		const d = deps(entry({ source_event: "session:sess-a" }), () => anchored);
		const result = await verifyMemoryRecord(d, "mem_0001");
		expect(result.status).toBe("unanchored");
		expect(result.reasons.join(" ")).toContain("session reference");
		expect(d.calls).toEqual([]);
	});
});

describe("a misbehaving anchor reader", () => {
	test("a throwing reader is unverified with the cause, and the hash result is kept", async () => {
		const result = await verifyMemoryRecord(
			deps(entry(), () => {
				throw new Error("checkpoint store unreachable");
			}),
			"mem_0001",
		);
		expect(result.status).toBe("unverified");
		expect(result.hash_version).toBe("v1");
		expect(result.reasons.join(" ")).toContain("checkpoint store unreachable");
	});

	test("anchored without a proof reference is unverified", async () => {
		const result = await verifyMemoryRecord(deps(entry(), () => ({ status: "anchored" })), "mem_0001");
		expect(result.status).toBe("unverified");
		expect(result.reasons.join(" ")).toContain("without a proof reference");
	});

	for (const [name, bad] of [
		["a string", "anchored"],
		["null", null],
		["an unknown status", { status: "fine" }],
		["a proof_ref that is not a string", { status: "anchored", proof_ref: 7 }],
		["an over-long proof_ref", { status: "anchored", proof_ref: "p".repeat(201) }],
	] as const) {
		test(`${name} is unverified`, async () => {
			const result = await verifyMemoryRecord(deps(entry(), () => bad), "mem_0001");
			expect(result.status).toBe("unverified");
		});
	}

	test("a reader that never answers times out as unverified, using the injected timer", async () => {
		const asked: number[] = [];
		const d = deps(entry(), () => new Promise(() => undefined), {
			anchorTimeoutMs: 1234,
			sleep: async (ms) => {
				asked.push(ms);
			},
		});
		const result = await verifyMemoryRecord(d, "mem_0001");
		expect(result.status).toBe("unverified");
		expect(result.reasons.join(" ")).toContain("1234 ms");
		expect(asked).toEqual([1234]);
	});

	test("a detail from the reader is flattened to one line and capped", async () => {
		const result = await verifyMemoryRecord(deps(entry(), () => ({ status: "pending", detail: `line1\nline2 ${"x".repeat(400)}` })), "mem_0001");
		const reason = result.reasons.at(-1) ?? "";
		expect(reason).not.toContain("\n");
		expect(reason.length).toBeLessThan(400);
	});
});

describe("caller errors", () => {
	test("an unknown id is a typed not_found error", async () => {
		const error = await verifyMemoryRecord(deps(null, () => anchored), "mem_missing").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(MemoryVerifyError);
		expect((error as MemoryVerifyError).rule).toBe("not_found");
	});

	test("a malformed id is a typed bad_id error", async () => {
		for (const bad of ["", "x".repeat(201)]) {
			const error = await verifyMemoryRecord(deps(entry(), () => anchored), bad).catch((e: unknown) => e);
			expect((error as MemoryVerifyError).rule).toBe("bad_id");
		}
	});
});
