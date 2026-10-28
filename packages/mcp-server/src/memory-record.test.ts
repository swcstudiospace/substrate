import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "./event.ts";
import {
	contentOf,
	entryHashFor,
	FORGOTTEN_PREFIX,
	isForgottenMarker,
	matchEntryHash,
	MAX_CHAIN_HOPS,
	supersessionChain,
	toCapsuleRecord,
	toNexusRecord,
} from "./memory-record.ts";
import type { MemoryEntry } from "./types.ts";

const BODY = "The staging deploy region is fra1; do not move it without the infra lead.";

function entry(over: Partial<MemoryEntry> = {}, hashVersion: "v1" | "v2" = "v1"): MemoryEntry {
	const base = {
		scope: "repo:agent-substrate",
		kind: "fact" as const,
		subject: "deploy.region" as string | undefined,
		text: BODY,
		writer: "claude-code",
		...over,
	};
	// The preimage is spelled out here on purpose: the test must not share code with the module it checks.
	const preimage = { scope: base.scope, kind: base.kind, subject: base.subject ?? null, text: base.text, writer: base.writer };
	const entryHash = hashVersion === "v1" ? sha256Hex(canonicalJson(preimage)) : sha256Hex(canonicalJson({ ...preimage, hv: 2, tenant: "swc" }));
	return {
		id: "mem_0001",
		actor: "agent",
		trust: "verified-by-test",
		ttl: "permanent",
		created: "2026-10-20T10:00:00.000Z",
		version: 1,
		needs_reverification: false,
		source_event: "evt_0123456789abcdef0123456789",
		session_id: "sess-a",
		graph_id: "graph-a",
		repo: "agent-substrate",
		entry_hash: entryHash,
		...base,
		...over,
	} as MemoryEntry;
}

describe("entry hash", () => {
	test("v1 and v2 equal the gate's preimages, computed independently", () => {
		const e = entry();
		const { v1, v2 } = entryHashFor(contentOf(e), e.writer);
		expect(v1).toBe(entry({}, "v1").entry_hash);
		expect(v2).toBe(entry({}, "v2").entry_hash);
		expect(v1).not.toBe(v2);
	});

	test("matchEntryHash reports which preimage matched and rejects any other digest", () => {
		const e1 = entry({}, "v1");
		const e2 = entry({}, "v2");
		expect(matchEntryHash(contentOf(e1), e1.writer, e1.entry_hash)).toBe("v1");
		expect(matchEntryHash(contentOf(e2), e2.writer, e2.entry_hash)).toBe("v2");
		expect(matchEntryHash(contentOf(e1), e1.writer, "0".repeat(64))).toBeNull();
		expect(matchEntryHash({ ...contentOf(e1), text: `${BODY} edited` }, e1.writer, e1.entry_hash)).toBeNull();
		expect(matchEntryHash(contentOf(e1), "other-writer", e1.entry_hash)).toBeNull();
	});

	test("a missing subject hashes as null, not as an absent key", () => {
		const noSubject = entry({ subject: undefined });
		expect(contentOf(noSubject).subject).toBeNull();
		expect(matchEntryHash(contentOf(noSubject), noSubject.writer, noSubject.entry_hash)).toBe("v1");
	});

	test("the constants shared with the gate still match the gate's source", () => {
		// `entryHashFor` calls the gate's exported `contentHash`. The independent preimages above fail when the gate's
		// preimage changes; these facts pin that the gate still exports what this module calls, so it cannot go back
		// to a private copy that drifts.
		const source = readFileSync(join(import.meta.dir, "memory-write.ts"), "utf8");
		expect(source).toMatch(/const HASH_TENANT = "swc";/);
		expect(source).toMatch(/const HASH_VERSION_MARKER = 2;/);
		expect(source).toMatch(/function contentHash\(input: \{[^}]*\}\): string \{\s*return sha256Hex\(canonicalJson\(input\)\);/);
		expect(source).toMatch(/hv: HASH_VERSION_MARKER,\s*tenant: HASH_TENANT,/);
		expect(source).toMatch(/const contentV1 = contentHash\(\{ scope: scope\.canonical, kind, subject, text, writer \}\);/);
		expect(source).toMatch(/export const HASH_TENANT\b/);
		expect(source).toMatch(/export const HASH_VERSION_MARKER\b/);
		expect(source).toMatch(/export function contentHash\(/);
		const record = readFileSync(join(import.meta.dir, "memory-record.ts"), "utf8");
		expect(record).toMatch(/from "\.\/memory-write\.ts"/);
		expect(record).not.toMatch(/sha256Hex\(canonicalJson/);
	});
});

describe("toNexusRecord", () => {
	test("a current entry maps identity, version and provenance, and carries no content", () => {
		const record = toNexusRecord(entry());
		expect(record).toEqual({
			id: "mem_0001",
			version: 1,
			supersedes: null,
			superseded_by: null,
			forgotten_by: null,
			state: "current",
			provenance: {
				writer: "claude-code",
				actor: "agent",
				trust: "verified-by-test",
				source_event: "evt_0123456789abcdef0123456789",
				session_id: "sess-a",
				graph_id: "graph-a",
				repo: "agent-substrate",
				created: "2026-10-20T10:00:00.000Z",
			},
			content_hash: entry().entry_hash,
		});
		expect(JSON.stringify(record)).not.toContain("staging deploy");
		expect(JSON.stringify(record)).not.toContain("deploy.region");
	});

	test("absent optional fields become null", () => {
		const record = toNexusRecord(entry({ source_event: undefined, session_id: undefined, graph_id: undefined, repo: undefined }));
		expect(record.provenance).toMatchObject({ source_event: null, session_id: null, graph_id: null, repo: null });
	});

	test("a superseded entry points at its successor", () => {
		const record = toNexusRecord(entry({ version: 2, supersedes: "mem_0000", superseded_by: "mem_0002" }));
		expect(record).toMatchObject({ state: "superseded", version: 2, supersedes: "mem_0000", superseded_by: "mem_0002", forgotten_by: null });
	});

	test("a forgotten marker is a terminal tombstone, never a pointer", () => {
		const record = toNexusRecord(entry({ superseded_by: `${FORGOTTEN_PREFIX}fg_abc` }));
		expect(record).toMatchObject({ state: "forgotten", superseded_by: null, forgotten_by: "fg_abc" });
	});

	test("an id the caller knows is forgotten reads as forgotten without a marker", () => {
		const record = toNexusRecord(entry(), { forgotten: new Set(["mem_0001"]) });
		expect(record).toMatchObject({ state: "forgotten", superseded_by: null, forgotten_by: null });
	});
});

describe("toCapsuleRecord", () => {
	const now = () => new Date("2026-10-26T09:00:00.000Z");

	test("a current entry carries exactly the hashed content", () => {
		const e = entry();
		const record = toCapsuleRecord(e, { now });
		expect(record).toMatchObject({ id: "mem_0001", state: "current", content: { scope: e.scope, kind: "fact", subject: "deploy.region", text: BODY } });
	});

	test("a forgotten entry is exported as a tombstone with the injected time and never carries content", () => {
		const e = entry({ superseded_by: `${FORGOTTEN_PREFIX}fg_abc` });
		const record = toCapsuleRecord(e, { now });
		expect(record).toEqual({ id: "mem_0001", content_hash: e.entry_hash, tombstone: { reason: "forgotten", at: "2026-10-26T09:00:00.000Z" } });
		expect(JSON.stringify(record)).not.toContain("staging deploy");
	});
});

describe("isForgottenMarker", () => {
	test("only the forgotten: prefix counts", () => {
		expect(isForgottenMarker("forgotten:fg_1")).toBe(true);
		expect(isForgottenMarker("mem_forgotten:1")).toBe(false);
		expect(isForgottenMarker(null)).toBe(false);
		expect(isForgottenMarker(undefined)).toBe(false);
	});
});

type Row = { id: string; supersedes?: string; superseded_by?: string };

describe("supersessionChain", () => {
	test("walks back to the first version and forward to the latest, oldest first", () => {
		const rows: Row[] = [
			{ id: "v3", supersedes: "v2" },
			{ id: "v1", superseded_by: "v2" },
			{ id: "v2", supersedes: "v1", superseded_by: "v3" },
			{ id: "other" },
		];
		const result = supersessionChain(rows, "v2");
		expect(result).toEqual({ id: "v2", chain: ["v1", "v2", "v3"], back: "root", forward: "current", dangling: [], forgotten_marker: null });
		expect(supersessionChain(rows, "v1").chain).toEqual(["v1", "v2", "v3"]);
		expect(supersessionChain(rows, "v3").chain).toEqual(["v1", "v2", "v3"]);
		expect(supersessionChain(rows, "other")).toMatchObject({ chain: ["other"], back: "root", forward: "current" });
	});

	test("a cycle ends the walk and is reported, in both directions", () => {
		const forward = supersessionChain(
			[
				{ id: "a", superseded_by: "b" },
				{ id: "b", supersedes: "a", superseded_by: "a" },
			],
			"a",
		);
		expect(forward.forward).toBe("cycle");
		expect(forward.chain).toEqual(["a", "b"]);

		const back = supersessionChain(
			[
				{ id: "a", supersedes: "b" },
				{ id: "b", supersedes: "a" },
			],
			"a",
		);
		expect(back.back).toBe("cycle");
		expect(back.chain).toEqual(["b", "a"]);

		expect(supersessionChain([{ id: "s", superseded_by: "s", supersedes: "s" }], "s")).toMatchObject({ chain: ["s"], back: "cycle", forward: "cycle" });
	});

	test("a forgotten marker stops the walk and is not followed", () => {
		const rows: Row[] = [
			{ id: "v1", superseded_by: "v2" },
			{ id: "v2", supersedes: "v1", superseded_by: "forgotten:fg_9" },
		];
		const result = supersessionChain(rows, "v1");
		expect(result).toMatchObject({ chain: ["v1", "v2"], forward: "forgotten", forgotten_marker: "forgotten:fg_9", dangling: [] });
	});

	test("a link to a row the input does not hold is dangling, not followed", () => {
		const result = supersessionChain([{ id: "v2", supersedes: "v1", superseded_by: "v3" }], "v2");
		expect(result).toMatchObject({ chain: ["v2"], back: "missing", forward: "missing", dangling: ["v1", "v3"] });
	});

	test("an unknown id is an empty chain", () => {
		expect(supersessionChain([{ id: "a" }], "zzz")).toEqual({ id: "zzz", chain: [], back: "missing", forward: "missing", dangling: ["zzz"], forgotten_marker: null });
	});

	test("each direction is bounded", () => {
		const n = MAX_CHAIN_HOPS * 2 + 10;
		const rows: Row[] = Array.from({ length: n }, (_, i) => ({
			id: `r${i}`,
			...(i > 0 ? { supersedes: `r${i - 1}` } : {}),
			...(i < n - 1 ? { superseded_by: `r${i + 1}` } : {}),
		}));
		const head = supersessionChain(rows, "r0");
		expect(head.forward).toBe("truncated");
		expect(head.chain.length).toBe(MAX_CHAIN_HOPS + 1);
		const tail = supersessionChain(rows, `r${n - 1}`);
		expect(tail.back).toBe("truncated");
		expect(tail.chain.length).toBe(MAX_CHAIN_HOPS + 1);
	});

	test("the first row wins when an id repeats", () => {
		const result = supersessionChain([{ id: "a", superseded_by: "b" }, { id: "a" }, { id: "b", supersedes: "a" }], "a");
		expect(result.chain).toEqual(["a", "b"]);
	});
});
