import { describe, expect, test } from "bun:test";
import { merkleRootHex } from "@substrate/ledger";
import {
	buildCapsuleExportEvent,
	buildCapsuleRedactEvent,
	CAPSULE_EXPORT_ACTION,
	CAPSULE_REDACT_ACTION,
	CAPSULE_SCHEMA,
	capsuleExportEvent,
	capsuleRedactEvent,
	CapsuleError,
	exportCapsule,
	importCapsule,
	isTombstone,
	parseCapsuleExportPayload,
	parseCapsuleRedactPayload,
	tombstoneCapsule,
	sha256Bytes,
	type CapsuleEntry,
} from "./capsule.ts";
import { canonicalJson, IDEMPOTENCY_KEY_PATTERN, sha256Hex } from "./event.ts";
import { EVENT_SOURCES } from "./event-sources.ts";
import { toCapsuleRecord } from "./memory-record.ts";
import type { MemoryEntry } from "./types.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const NOW = new Date("2026-10-26T09:00:00.000Z");
const LATER = new Date("2026-10-27T09:00:00.000Z");
const OPTS = { producer: "substrate-mcp", now: () => NOW };

function entry(id: string, text: string, over: Partial<MemoryEntry> = {}, hashVersion: "v1" | "v2" = "v1"): MemoryEntry {
	const base = { scope: `repo:scope-of-${id}`, kind: "fact" as const, subject: `subject.of.${id}` as string | undefined, text, writer: "claude-code", ...over };
	const preimage = { scope: base.scope, kind: base.kind, subject: base.subject ?? null, text: base.text, writer: base.writer };
	const hash = hashVersion === "v1" ? sha256Hex(canonicalJson(preimage)) : sha256Hex(canonicalJson({ ...preimage, hv: 2, tenant: "swc" }));
	return {
		id,
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		created: "2026-10-20T10:00:00.000Z",
		version: 1,
		needs_reverification: false,
		source_event: "evt_0123456789abcdef0123456789",
		session_id: "sess-a",
		graph_id: "graph-a",
		repo: "agent-substrate",
		entry_hash: hash,
		...base,
		...over,
	} as MemoryEntry;
}

function fixtures(): CapsuleEntry[] {
	const entries = [
		entry("mem_c", "GAMMA-BODY-three", {}, "v2"),
		entry("mem_a", "ALPHA-BODY-one", { superseded_by: "mem_b" }),
		entry("mem_b", "BETA-BODY-two", { version: 2, supersedes: "mem_a", trust: "human-confirmed", actor: "human" }),
		entry("mem_d", "DELTA-BODY-four", { subject: undefined, source_event: undefined }),
	];
	return entries.map((e) => toCapsuleRecord(e, { now: () => NOW }));
}

/** Deterministic Fisher-Yates over a fixed LCG: seeded, no system randomness. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let state = seed >>> 0;
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

/** The same value with every object's keys inserted in reverse, to prove nothing depends on insertion order. */
function reverseKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reverseKeys);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]));
	}
	return value;
}

function parts(bytes: Uint8Array): { manifest: Record<string, unknown>; lines: string[] } {
	const [head, ...lines] = dec.decode(bytes).slice(0, -1).split("\n");
	return { manifest: JSON.parse(head as string) as Record<string, unknown>, lines };
}

/** Re-seal edited lines: recompute records_sha256 so only the deeper checks can catch the edit. */
function reseal(manifest: Record<string, unknown>, lines: readonly string[]): Uint8Array {
	const records = `${lines.join("\n")}\n`;
	return enc.encode(`${canonicalJson({ ...manifest, records_sha256: sha256Hex(records) })}\n${records}`);
}

function expectError(bytes: Uint8Array, rule: string): CapsuleError {
	const result = importCapsule(bytes);
	if (result.ok) throw new Error(`expected a ${rule} error, the capsule imported`);
	expect(result.error.rule).toBe(rule as CapsuleError["rule"]);
	return result.error;
}

describe("exportCapsule", () => {
	test("is byte-identical for shuffled input and for any key insertion order", () => {
		const reference = exportCapsule(fixtures(), OPTS);
		for (let seed = 1; seed <= 25; seed++) {
			const out = exportCapsule(shuffled(fixtures(), seed), OPTS);
			expect(out.digest).toBe(reference.digest);
			expect(Buffer.from(out.bytes).equals(Buffer.from(reference.bytes))).toBe(true);
		}
		const reversed = exportCapsule((reverseKeys(fixtures()) as CapsuleEntry[]).reverse(), OPTS);
		expect(Buffer.from(reversed.bytes).equals(Buffer.from(reference.bytes))).toBe(true);
	});

	test("a different clock changes the manifest and nothing else", () => {
		const a = exportCapsule(fixtures(), OPTS);
		const b = exportCapsule(fixtures(), { ...OPTS, now: () => LATER });
		expect(b.digest).not.toBe(a.digest);
		expect(b.manifest.created_at).toBe(LATER.toISOString());
		expect(b.manifest.records_sha256).toBe(a.manifest.records_sha256);
		expect(b.manifest.root_digest).toBe(a.manifest.root_digest);
		expect(parts(b.bytes).lines).toEqual(parts(a.bytes).lines);
	});

	test("layout: manifest line, then records sorted by id, each line newline-terminated and canonical", () => {
		const out = exportCapsule(fixtures(), OPTS);
		const text = dec.decode(out.bytes);
		expect(text.endsWith("\n")).toBe(true);
		const { manifest, lines } = parts(out.bytes);
		expect(canonicalJson(manifest)).toBe(dec.decode(out.bytes).split("\n")[0] as string);
		expect(lines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(["mem_a", "mem_b", "mem_c", "mem_d"]);
		for (const line of lines) expect(canonicalJson(JSON.parse(line))).toBe(line);
		expect(out.manifest).toMatchObject({ capsule_version: 1, schema: CAPSULE_SCHEMA, producer: "substrate-mcp", created_at: NOW.toISOString(), count: 4 });
		expect(out.digest).toBe(sha256Bytes(out.bytes));
		expect(out.manifest.records_sha256).toBe(sha256Hex(`${lines.join("\n")}\n`));
	});

	test("root_digest is the RFC 6962 root over the content hashes in id order", () => {
		const records = fixtures();
		const out = exportCapsule(records, OPTS);
		const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : 1));
		expect(out.manifest.root_digest).toBe(merkleRootHex(sorted.map((r) => r.content_hash)));
	});

	test("a single record exports", () => {
		const out = exportCapsule([fixtures()[0] as CapsuleEntry], OPTS);
		expect(out.manifest.count).toBe(1);
		expect(importCapsule(out.bytes).ok).toBe(true);
	});

	test("refuses bad input with typed errors", () => {
		const expectRule = (fn: () => unknown, rule: string) => {
			try {
				fn();
			} catch (error) {
				expect(error).toBeInstanceOf(CapsuleError);
				expect((error as CapsuleError).rule).toBe(rule as CapsuleError["rule"]);
				return;
			}
			throw new Error(`expected ${rule}`);
		};
		const [first] = fixtures() as [CapsuleEntry];
		expectRule(() => exportCapsule([], OPTS), "empty");
		expectRule(() => exportCapsule([first, first], OPTS), "duplicate_id");
		expectRule(() => exportCapsule([first], { ...OPTS, producer: "bad\nproducer" }), "format");
		expectRule(() => exportCapsule([{ ...first, extra: 1 } as unknown as CapsuleEntry], OPTS), "unknown_key");
		// A record whose content does not hash to its content_hash never gets into a capsule.
		const tampered = structuredClone(first) as Exclude<CapsuleEntry, { tombstone: unknown }>;
		tampered.content.text = "edited";
		expectRule(() => exportCapsule([tampered], OPTS), "record_hash_mismatch");
		const forgottenWithState = { ...(structuredClone(first) as object), state: "forgotten" } as unknown as CapsuleEntry;
		expectRule(() => exportCapsule([forgottenWithState], OPTS), "enum");
	});

	test("a forgotten entry is carried as a tombstone with its hash", () => {
		const forgotten = toCapsuleRecord(entry("mem_z", "ZETA-SECRET", { superseded_by: "forgotten:fg_1" }), { now: () => NOW });
		const out = exportCapsule([...fixtures(), forgotten], OPTS);
		expect(dec.decode(out.bytes)).not.toContain("ZETA-SECRET");
		const imported = importCapsule(out.bytes);
		expect(imported.ok).toBe(true);
		if (imported.ok) {
			const z = imported.capsule.records.find((r) => r.id === "mem_z") as CapsuleEntry;
			expect(isTombstone(z)).toBe(true);
			expect(z.content_hash).toBe(entry("mem_z", "ZETA-SECRET").entry_hash);
		}
	});
});

describe("importCapsule", () => {
	test("round trips records, manifest and digest, and re-export gives the same bytes", () => {
		const records = fixtures();
		const out = exportCapsule(records, OPTS);
		const result = importCapsule(out.bytes);
		if (!result.ok) throw result.error;
		expect(result.capsule.digest).toBe(out.digest);
		expect(result.capsule.manifest).toEqual(out.manifest);
		expect(result.capsule.records.map((r) => r.id)).toEqual(["mem_a", "mem_b", "mem_c", "mem_d"]);
		expect(result.capsule.records).toEqual([...records].sort((a, b) => (a.id < b.id ? -1 : 1)));
		const again = exportCapsule(result.capsule.records, OPTS);
		expect(Buffer.from(again.bytes).equals(Buffer.from(out.bytes))).toBe(true);
	});

	test("any edit to any record byte is caught by records_sha256", () => {
		const out = exportCapsule(fixtures(), OPTS);
		const { lines } = parts(out.bytes);
		const fields: Array<[string, unknown]> = [
			["id", "mem_x"],
			["content_hash", "1".repeat(64)],
			["version", 9],
			["supersedes", "mem_q"],
			["superseded_by", "mem_q"],
			["state", "current"],
			["provenance.writer", "someone-else"],
			["provenance.actor", "human"],
			["provenance.trust", "verified-by-test"],
			["provenance.source_event", "evt_other"],
			["provenance.session_id", "sess-z"],
			["provenance.graph_id", "graph-z"],
			["provenance.repo", "other-repo"],
			["provenance.created", "2001-01-01T00:00:00.000Z"],
			["content.scope", "global"],
			["content.kind", "decision"],
			["content.subject", "other"],
			["content.text", "other"],
		];
		for (const [path, value] of fields) {
			const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
			const keys = path.split(".");
			let target = record;
			for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
			const last = keys.at(-1) as string;
			expect({ path, changed: target[last] !== value }).toEqual({ path, changed: true });
			target[last] = value;
			const edited = [canonicalJson(record), ...lines.slice(1)];
			// Not re-sealed: the manifest still holds the old records_sha256.
			const bytes = enc.encode(`${dec.decode(out.bytes).split("\n")[0]}\n${edited.join("\n")}\n`);
			expect({ path, rule: (importCapsule(bytes) as { error?: CapsuleError }).error?.rule }).toEqual({ path, rule: "records_digest_mismatch" });
		}
	});

	test("content edits that are re-sealed still fail the per-record hash", () => {
		const out = exportCapsule(fixtures(), OPTS);
		const { manifest, lines } = parts(out.bytes);
		for (const [path, value] of [
			["scope", "global"],
			["kind", "decision"],
			["subject", "other"],
			["text", "other"],
		] as const) {
			const edited = [...lines];
			const record = JSON.parse(edited[0] as string);
			record.content[path] = value;
			edited[0] = canonicalJson(record);
			expect(expectError(reseal(manifest, edited), "record_hash_mismatch").path).toBe("records[0].content_hash");
		}
		const writerEdit = [...lines];
		const record = JSON.parse(writerEdit[0] as string);
		record.provenance.writer = "someone-else";
		writerEdit[0] = canonicalJson(record);
		expectError(reseal(manifest, writerEdit), "record_hash_mismatch");
	});

	test("a tombstone whose hash is edited and re-sealed fails the Merkle root", () => {
		const redacted = tombstoneCapsule(exportCapsule(fixtures(), OPTS).bytes, ["mem_b"], "erasure request", () => NOW);
		const { manifest, lines } = parts(redacted.bytes);
		const edited = [...lines];
		const record = JSON.parse(edited[1] as string);
		expect(record.tombstone).toBeDefined();
		record.content_hash = "2".repeat(64);
		edited[1] = canonicalJson(record);
		expectError(reseal(manifest, edited), "root_mismatch");
	});

	test("manifest edits are caught", () => {
		const out = exportCapsule(fixtures(), OPTS);
		const { manifest, lines } = parts(out.bytes);
		expectError(reseal({ ...manifest, root_digest: "3".repeat(64) }, lines), "root_mismatch");
		expectError(reseal({ ...manifest, count: 5 }, lines), "count_mismatch");
		expectError(reseal({ ...manifest, capsule_version: 2 }, lines), "manifest");
		expectError(reseal({ ...manifest, schema: "other/1" }, lines), "manifest");
		expectError(reseal({ ...manifest, extra: true }, lines), "unknown_key");
		expectError(reseal({ ...manifest, created_at: "yesterday" }, lines), "format");
		const noRoot: Record<string, unknown> = { ...manifest };
		delete noRoot["root_digest"];
		expectError(reseal(noRoot, lines), "missing");
		// The records digest in the manifest is itself checked against the file.
		expectError(enc.encode(dec.decode(out.bytes).replace(String(manifest["records_sha256"]), "4".repeat(64))), "records_digest_mismatch");
	});

	test("structure edits are caught: order, duplicates, truncation, whitespace, extra keys, bad JSON", () => {
		const out = exportCapsule(fixtures(), OPTS);
		const { manifest, lines } = parts(out.bytes);
		expectError(reseal(manifest, [lines[1] as string, lines[0] as string, ...lines.slice(2)]), "order");
		expectError(reseal(manifest, [lines[0] as string, lines[0] as string, ...lines.slice(2)]), "duplicate_id");
		expectError(reseal(manifest, lines.slice(0, 3)), "count_mismatch");
		expectError(reseal(manifest, [JSON.stringify(JSON.parse(lines[0] as string), null, 1).replace(/\n/g, " "), ...lines.slice(1)]), "not_canonical");
		const withKey = JSON.parse(lines[0] as string);
		withKey.content.extra = "x";
		expectError(reseal(manifest, [canonicalJson(withKey), ...lines.slice(1)]), "unknown_key");
		expectError(reseal(manifest, ["{not json", ...lines.slice(1)]), "bad_json");
		expectError(out.bytes.subarray(0, out.bytes.length - 5), "records_digest_mismatch");
		expectError(out.bytes.subarray(0, out.bytes.length - 1), "records_digest_mismatch");
		expectError(new Uint8Array(), "empty");
		expectError(enc.encode(canonicalJson(manifest)), "manifest");
		expectError(Uint8Array.from([0xff, 0xfe, 0x0a, 0x7b, 0x7d, 0x0a]), "bad_utf8");
		const state = JSON.parse(lines[2] as string);
		state.state = "superseded";
		expectError(reseal(manifest, [lines[0] as string, lines[1] as string, canonicalJson(state), lines[3] as string]), "format");
	});

	test("known limit: provenance is covered by the digest, not the root, so a re-sealed provenance edit imports", () => {
		// This is why a capsule is checked against the digest the ledger holds in its export note.
		const out = exportCapsule(fixtures(), OPTS);
		const { manifest, lines } = parts(out.bytes);
		const record = JSON.parse(lines[0] as string);
		record.provenance.trust = "verified-by-test";
		const forged = reseal(manifest, [canonicalJson(record), ...lines.slice(1)]);
		const result = importCapsule(forged);
		expect(result.ok).toBe(true);
		expect(sha256Bytes(forged)).not.toBe(out.digest);
	});

	test("never throws for garbage", () => {
		for (const garbage of [new Uint8Array([0]), enc.encode("\n"), enc.encode("[]\n"), enc.encode("{}\n{}\n")]) {
			expect(importCapsule(garbage).ok).toBe(false);
		}
	});
});

describe("tombstoneCapsule", () => {
	const MARKERS = ["BETA-BODY-two", "subject.of.mem_b", "scope-of-mem_b"];

	test("replaces the body with a tombstone, keeps the root and count, and leaves no trace of the content in the bytes", () => {
		const original = exportCapsule(fixtures(), OPTS);
		for (const marker of MARKERS) expect(dec.decode(original.bytes)).toContain(marker);

		const redacted = tombstoneCapsule(original.bytes, ["mem_b"], "erasure request", () => LATER);
		const text = dec.decode(redacted.bytes);
		for (const marker of MARKERS) expect(text).not.toContain(marker);
		expect(Buffer.from(redacted.bytes).indexOf(Buffer.from("BETA-BODY"))).toBe(-1);
		// Other records are untouched.
		expect(text).toContain("ALPHA-BODY-one");
		expect(text).toContain("GAMMA-BODY-three");

		expect(redacted.redacted).toEqual(["mem_b"]);
		expect(redacted.manifest.root_digest).toBe(original.manifest.root_digest);
		expect(redacted.manifest.count).toBe(original.manifest.count);
		expect(redacted.manifest.created_at).toBe(original.manifest.created_at);
		expect(redacted.manifest.records_sha256).not.toBe(original.manifest.records_sha256);
		expect(redacted.digest).not.toBe(original.digest);

		const result = importCapsule(redacted.bytes);
		if (!result.ok) throw result.error;
		const tomb = result.capsule.records.find((r) => r.id === "mem_b") as CapsuleEntry;
		expect(tomb).toEqual({
			id: "mem_b",
			content_hash: entry("mem_b", "BETA-BODY-two").entry_hash,
			tombstone: { reason: "erasure request", at: LATER.toISOString() },
		});
		expect(result.capsule.manifest.root_digest).toBe(original.manifest.root_digest);
	});

	test("redacting several, and then all, keeps the capsule verifiable on the same root", () => {
		const original = exportCapsule(fixtures(), OPTS);
		const some = tombstoneCapsule(original.bytes, ["mem_a", "mem_d"], "retention expired", () => LATER);
		expect(some.redacted).toEqual(["mem_a", "mem_d"]);
		const all = tombstoneCapsule(some.bytes, ["mem_a", "mem_b", "mem_c", "mem_d"], "retention expired", () => LATER);
		expect(all.redacted).toEqual(["mem_b", "mem_c"]);
		for (const marker of ["ALPHA-BODY", "BETA-BODY", "GAMMA-BODY", "DELTA-BODY"]) expect(dec.decode(all.bytes)).not.toContain(marker);
		const result = importCapsule(all.bytes);
		if (!result.ok) throw result.error;
		expect(result.capsule.records.every(isTombstone)).toBe(true);
		expect(result.capsule.manifest.root_digest).toBe(original.manifest.root_digest);
	});

	test("is idempotent: redacting a tombstone changes nothing", () => {
		const original = exportCapsule(fixtures(), OPTS);
		const once = tombstoneCapsule(original.bytes, ["mem_b"], "erasure request", () => NOW);
		const twice = tombstoneCapsule(once.bytes, ["mem_b"], "a different reason", () => LATER);
		expect(twice.redacted).toEqual([]);
		expect(twice.digest).toBe(once.digest);
		expect(Buffer.from(twice.bytes).equals(Buffer.from(once.bytes))).toBe(true);
	});

	test("is deterministic for the same input and clock", () => {
		const original = exportCapsule(fixtures(), OPTS);
		const a = tombstoneCapsule(original.bytes, ["mem_c", "mem_a"], "erasure request", () => NOW);
		const b = tombstoneCapsule(original.bytes, ["mem_a", "mem_c"], "erasure request", () => NOW);
		expect(a.digest).toBe(b.digest);
	});

	test("refuses an unknown id, a missing id list, a reason that is not a short label, and an invalid capsule", () => {
		const original = exportCapsule(fixtures(), OPTS);
		const rule = (fn: () => unknown): string => {
			try {
				fn();
			} catch (error) {
				if (error instanceof CapsuleError) return error.rule;
				throw error;
			}
			return "no error";
		};
		expect(rule(() => tombstoneCapsule(original.bytes, ["mem_nope"], "erasure request", () => NOW))).toBe("unknown_id");
		expect(rule(() => tombstoneCapsule(original.bytes, [], "erasure request", () => NOW))).toBe("empty");
		expect(rule(() => tombstoneCapsule(original.bytes, ["bad id!"], "erasure request", () => NOW))).toBe("format");
		expect(rule(() => tombstoneCapsule(original.bytes, ["mem_a"], "multi\nline", () => NOW))).toBe("format");
		expect(rule(() => tombstoneCapsule(original.bytes, ["mem_a"], "x".repeat(121), () => NOW))).toBe("format");
		expect(rule(() => tombstoneCapsule(original.bytes, ["mem_a"], "", () => NOW))).toBe("range");
		expect(rule(() => tombstoneCapsule(original.bytes.subarray(0, 40), ["mem_a"], "erasure request", () => NOW))).not.toBe("no error");
	});
});

describe("capsule ledger notes", () => {
	const HEX = "ab".repeat(32);
	const HEX2 = "cd".repeat(32);

	test("export note: builds a note with the digest as its idempotency key", () => {
		const out = exportCapsule(fixtures(), OPTS);
		const draft = capsuleExportEvent(out);
		expect(draft.kind).toBe("note");
		expect(draft.payload).toEqual({
			action: CAPSULE_EXPORT_ACTION,
			digest: out.digest,
			count: 4,
			root_digest: out.manifest.root_digest,
			size: out.bytes.byteLength,
		});
		expect(draft.idempotency_key).toBe(`mce:${out.digest}`);
		expect(IDEMPOTENCY_KEY_PATTERN.test(draft.idempotency_key)).toBe(true);
		expect(draft.summary).toContain("4 records");
		expect(JSON.stringify(draft)).not.toContain("ALPHA-BODY");
	});

	test("redact note: builds a note joining both digests", () => {
		const original = exportCapsule(fixtures(), OPTS);
		const redacted = tombstoneCapsule(original.bytes, ["mem_b"], "erasure request", () => NOW);
		const draft = capsuleRedactEvent(original.digest, "erasure request", redacted);
		expect(draft.payload).toEqual({
			action: CAPSULE_REDACT_ACTION,
			digest_before: original.digest,
			digest_after: redacted.digest,
			redacted_count: 1,
			reason: "erasure request",
		});
		expect(IDEMPOTENCY_KEY_PATTERN.test(draft.idempotency_key)).toBe(true);
		expect(draft.idempotency_key).toBe(`mcr:${original.digest.slice(0, 32)}:${redacted.digest.slice(0, 32)}`);
		expect(JSON.stringify(draft)).not.toContain("BETA-BODY");
	});

	test("payload validators are strict: unknown or content keys, bad digests and counts are refused", () => {
		const good = { action: CAPSULE_EXPORT_ACTION, digest: HEX, count: 2, root_digest: HEX2, size: 10 } as const;
		expect(parseCapsuleExportPayload(good)).toEqual(good);
		const refuses = (value: unknown, parse: (v: unknown) => unknown): string => {
			try {
				parse(value);
			} catch (error) {
				return error instanceof CapsuleError ? error.rule : "other";
			}
			return "none";
		};
		expect(refuses({ ...good, text: "body" }, parseCapsuleExportPayload)).toBe("unknown_key");
		expect(refuses({ ...good, records: [] }, parseCapsuleExportPayload)).toBe("unknown_key");
		expect(refuses({ ...good, digest: HEX.toUpperCase() }, parseCapsuleExportPayload)).toBe("format");
		expect(refuses({ ...good, count: 0 }, parseCapsuleExportPayload)).toBe("range");
		expect(refuses({ ...good, count: 1.5 }, parseCapsuleExportPayload)).toBe("type");
		expect(refuses({ ...good, size: "10" }, parseCapsuleExportPayload)).toBe("type");
		expect(refuses({ ...good, action: "memory.capsule.redact" }, parseCapsuleExportPayload)).toBe("enum");
		expect(refuses({ action: CAPSULE_EXPORT_ACTION, digest: HEX }, parseCapsuleExportPayload)).toBe("missing");
		expect(refuses("nope", parseCapsuleExportPayload)).toBe("not_object");
		expect(refuses([], parseCapsuleExportPayload)).toBe("not_object");

		const redact = { action: CAPSULE_REDACT_ACTION, digest_before: HEX, digest_after: HEX2, redacted_count: 1, reason: "erasure request" } as const;
		expect(parseCapsuleRedactPayload(redact)).toEqual(redact);
		expect(refuses({ ...redact, content: "x" }, parseCapsuleRedactPayload)).toBe("unknown_key");
		expect(refuses({ ...redact, redacted_count: 0 }, parseCapsuleRedactPayload)).toBe("range");
		expect(refuses({ ...redact, digest_after: HEX }, parseCapsuleRedactPayload)).toBe("format");
		expect(refuses({ ...redact, reason: "the user said their password was hunter2, please erase it" }, parseCapsuleRedactPayload)).toBe("format");
		expect(refuses({ ...redact, reason: "line\nbreak" }, parseCapsuleRedactPayload)).toBe("format");
		expect(refuses({ ...redact, reason: "r".repeat(121) }, parseCapsuleRedactPayload)).toBe("format");
	});

	test("builders validate before building", () => {
		expect(() => buildCapsuleExportEvent({ digest: "short", count: 1, root_digest: HEX, size: 1 })).toThrow(CapsuleError);
		expect(() => buildCapsuleRedactEvent({ digest_before: HEX, digest_after: HEX, redacted_count: 1, reason: "r" })).toThrow(CapsuleError);
	});

	test("the registry samples are valid payloads and use the existing note kind", () => {
		for (const [id, parse] of [
			["memory.capsule.export", parseCapsuleExportPayload],
			["memory.capsule.redact", parseCapsuleRedactPayload],
		] as const) {
			const row = EVENT_SOURCES.find((r) => r.id === id);
			expect(row?.kind).toBe("note");
			const sample = row?.sample();
			expect(() => parse(sample?.payload)).not.toThrow();
		}
	});
});
