/**
 * `substrate memory capsule export|verify|redact`: the grammar, the paged read, the conversion, the files, the
 * ledger note and the anchor lookups, all against fakes. The nexus modules' own behaviour (hashes, root,
 * tombstones) is proved in `packages/mcp-server/src/capsule.test.ts`; here the question is what this command
 * reads, writes and says. No network, no real clock: the MCP client, the filesystem, the store and the event
 * path are injected, and the one real-filesystem test runs in a temporary directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmitOutcome } from "../../collectors/src/emit.ts";
import { LocalBlobStore, type BlobStore } from "../../mcp-server/src/blob-store.ts";
import { exportCapsule, importCapsule, isTombstone, parseCapsuleExportPayload, parseCapsuleRedactPayload, sha256Bytes } from "../../mcp-server/src/capsule.ts";
import { entryHashFor, toCapsuleRecord } from "../../mcp-server/src/memory-record.ts";
import type { EventInput, MemoryEntry } from "../../mcp-server/src/types.ts";
import {
	CAPSULE_USAGE,
	CapsuleMcpError,
	DEFAULT_LIMIT,
	MAX_ANCHOR_SAMPLE,
	MAX_LIMIT,
	MAX_SCANNED_ENTRIES,
	PAGE_SIZE,
	collectEntries,
	entryFromReply,
	httpCapsuleMcp,
	nodeCapsuleFs,
	parseCapsuleArgs,
	runMemory,
	sampleIndexes,
	CapsuleUsageError,
	type CapsuleDeps,
	type CapsuleFs,
	type CapsuleMcp,
} from "./capsule.ts";

// Every fixture is synthetic: ids, bodies, scopes and paths are invented for these tests.

const NOW = new Date("2026-10-26T09:00:00.000Z");
const CWD = "/work";
const BASE_MS = Date.parse("2026-10-20T10:00:00.000Z");

type Rec = Record<string, unknown>;

/** A `memory_search` entry as the server serialises it, with a real gate hash over its content. */
function reply(i: number, over: Rec = {}): Rec {
	const id = `mem_${String(i).padStart(4, "0")}`;
	const base = { scope: "repo:acme", kind: "fact", subject: `subject.${id}`, text: `synthetic body ${i}`, writer: "claude-code", ...over };
	const hash = entryHashFor({ scope: base.scope as string, kind: base.kind as MemoryEntry["kind"], subject: (base.subject ?? null) as string | null, text: base.text as string }, base.writer as string).v1;
	return {
		id,
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		// Newer entries have larger i: the server lists newest first.
		created: new Date(BASE_MS + i * 60_000).toISOString(),
		version: 1,
		needs_reverification: false,
		source_event: "evt_0123456789abcdef0123456789",
		session_id: "sess-a",
		graph_id: "graph-a",
		repo: "acme/app",
		entry_hash: hash,
		...base,
		...over,
	};
}

/** A `memory_search` that pages the way the server does: `created desc, id desc`, keyset cursor `(before, before_id)`. */
class FakeMcp implements CapsuleMcp {
	readonly calls: Array<{ tool: string; args: Rec }> = [];
	verifyReplies = new Map<string, unknown>();
	verifyFailure: CapsuleMcpError | null = null;
	searchFailure: CapsuleMcpError | null = null;
	/** Overrides the whole search answer (a bare list from an old server, a bad cursor...). */
	searchOverride: ((args: Rec) => unknown) | null = null;
	constructor(readonly entries: Rec[]) {}

	async call(tool: "memory_search" | "memory_verify", args: Rec): Promise<unknown> {
		this.calls.push({ tool, args });
		if (tool === "memory_verify") {
			if (this.verifyFailure !== null) throw this.verifyFailure;
			const found = this.verifyReplies.get(String(args.id));
			if (found !== undefined) return found;
			const record = this.entries.find((e) => e.id === args.id);
			return { id: args.id, status: "verified", reasons: ["synthetic"], content_hash: record?.entry_hash ?? "0".repeat(64) };
		}
		if (this.searchFailure !== null) throw this.searchFailure;
		if (this.searchOverride !== null) return this.searchOverride(args);
		const before = args.before as string | undefined;
		const beforeId = args.before_id as string | undefined;
		const limit = (args.limit as number | undefined) ?? 20;
		const sorted = [...this.entries].sort((a, b) => (a.created === b.created ? ((a.id as string) < (b.id as string) ? 1 : -1) : (a.created as string) < (b.created as string) ? 1 : -1));
		const after = sorted.filter((e) => {
			if (before === undefined) return true;
			const created = e.created as string;
			if (created < before) return true;
			return created === before && beforeId !== undefined && (e.id as string) < beforeId;
		});
		const page = after.slice(0, limit);
		const last = page.length === limit ? page[page.length - 1] : undefined;
		return { entries: page, next: last === undefined ? null : { before: last.created, before_id: last.id } };
	}
}

class MemoryCapsuleFs implements CapsuleFs {
	readonly files = new Map<string, Uint8Array>();
	readonly modes = new Map<string, number>();
	readonly created: string[] = [];
	failWrite: string | null = null;
	/** Make `exists` lie (a file that appears between the check and the create). */
	hideExisting = false;

	async readBytes(path: string, maxBytes: number): Promise<Uint8Array> {
		const bytes = this.files.get(path);
		if (bytes === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
		if (bytes.byteLength > maxBytes) throw new Error(`the file is ${bytes.byteLength} bytes; the limit is ${maxBytes}`);
		return bytes;
	}

	async exists(path: string): Promise<boolean> {
		return !this.hideExisting && this.files.has(path);
	}

	async writeNew(path: string, bytes: Uint8Array, mode: number): Promise<void> {
		if (this.failWrite !== null) throw Object.assign(new Error("disk"), { code: this.failWrite });
		if (this.files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
		this.files.set(path, bytes);
		this.modes.set(path, mode);
		this.created.push(path);
	}
}

class FakeStore implements BlobStore {
	readonly blobs = new Map<string, Uint8Array>();
	failPut = false;
	wrongDigest = false;
	async put(bytes: Uint8Array): Promise<string> {
		if (this.failPut) throw new Error("store offline");
		const digest = sha256Bytes(bytes);
		this.blobs.set(digest, bytes);
		return this.wrongDigest ? "f".repeat(64) : digest;
	}
	async get(digest: string): Promise<Uint8Array | null> {
		return this.blobs.get(digest) ?? null;
	}
	async has(digest: string): Promise<boolean> {
		return this.blobs.has(digest);
	}
	async remove(digest: string): Promise<boolean> {
		return this.blobs.delete(digest);
	}
}

interface Rig {
	deps: CapsuleDeps;
	mcp: FakeMcp;
	fs: MemoryCapsuleFs;
	store: FakeStore;
	out: string[];
	err: string[];
	emitted: EventInput[];
	storeDirs: string[];
	setEmit(outcome: EmitOutcome): void;
}

function rig(entries: Rec[] = []): Rig {
	const mcp = new FakeMcp(entries);
	const fs = new MemoryCapsuleFs();
	const store = new FakeStore();
	const out: string[] = [];
	const err: string[] = [];
	const emitted: EventInput[] = [];
	const storeDirs: string[] = [];
	let outcome: EmitOutcome = { kind: "stored" };
	const surfaces: string[] = [];
	const deps: CapsuleDeps = {
		mcpFor: (surface) => {
			surfaces.push(surface);
			return mcp;
		},
		fs,
		openStore: (dir) => {
			storeDirs.push(dir);
			return store;
		},
		emit: async (event) => {
			emitted.push(event);
			return outcome;
		},
		now: () => NOW,
		cwd: CWD,
		out: (text) => out.push(text),
		err: (text) => err.push(text),
	};
	return { deps, mcp, fs, store, out, err, emitted, storeDirs, setEmit: (o) => (outcome = o) };
}

const text = (lines: string[]): string => lines.join("");
const searchCalls = (r: Rig) => r.mcp.calls.filter((c) => c.tool === "memory_search");

describe("grammar", () => {
	test("export: every flag, defaults and normalisation", () => {
		expect(parseCapsuleArgs(["export", "--out", "c.jsonl"])).toEqual({
			command: "export",
			out: "c.jsonl",
			session: null,
			repo: null,
			since: null,
			limit: DEFAULT_LIMIT,
			store: null,
			surface: "claude-code",
		});
		expect(
			parseCapsuleArgs(["export", "--out", "c.jsonl", "--session", "sess-a", "--repo", "acme/app", "--since", "2026-10-01T00:00:00+02:00", "--limit", "250", "--store", "/var/capsules", "--surface", "omp"]),
		).toEqual({ command: "export", out: "c.jsonl", session: "sess-a", repo: "acme/app", since: "2026-09-30T22:00:00.000Z", limit: 250, store: "/var/capsules", surface: "omp" });
	});

	test("verify and redact take the file first", () => {
		expect(parseCapsuleArgs(["verify", "c.jsonl"])).toEqual({ command: "verify", file: "c.jsonl", anchors: false, surface: "claude-code" });
		expect(parseCapsuleArgs(["verify", "c.jsonl", "--anchors"])).toMatchObject({ anchors: true });
		expect(parseCapsuleArgs(["redact", "c.jsonl", "--ids", "mem_a, mem_b,mem_a", "--reason", "erasure request", "--out", "d.jsonl"])).toEqual({
			command: "redact",
			file: "c.jsonl",
			ids: ["mem_a", "mem_b"],
			reason: "erasure request",
			out: "d.jsonl",
			surface: "claude-code",
		});
	});

	test("refuses what is not the grammar, with a usage error", () => {
		const bad: string[][] = [
			[],
			["list"],
			["export"],
			["export", "--out"],
			["export", "--out", "--session"],
			["export", "--out", "a", "--out", "b"],
			["export", "--out=a"],
			["export", "--out", "a", "extra"],
			["export", "--out", "a", "--anchors"],
			["export", "--out", "a", "--limit", "0"],
			["export", "--out", "a", "--limit", String(MAX_LIMIT + 1)],
			["export", "--out", "a", "--limit", "ten"],
			["export", "--out", "a", "--since", "yesterday"],
			["export", "--out", "a", "--since", "2026-10-01"],
			["export", "--out", "a", "--surface", "no-such-surface"],
			["export", "--out", "a\u0000b"],
			["verify"],
			["verify", "--anchors"],
			["verify", "c", "--ids", "a"],
			["verify", "c", "--anchors", "--anchors"],
			["redact", "c.jsonl", "--ids", "a", "--reason", "r"],
			["redact", "c.jsonl", "--ids", "a", "--out", "d"],
			["redact", "c.jsonl", "--reason", "r", "--out", "d"],
			["redact", "c.jsonl", "--ids", ",", "--reason", "r", "--out", "d"],
			["redact", "c.jsonl", "--ids", Array.from({ length: 1001 }, (_, i) => `m${i}`).join(","), "--reason", "r", "--out", "d"],
		];
		for (const words of bad) {
			expect({ words, refused: (() => { try { parseCapsuleArgs(words); return false; } catch (e) { return e instanceof CapsuleUsageError; } })() }).toEqual({ words, refused: true });
		}
	});

	test("runMemory prints the usage and exits 2 for a bad grammar or another subcommand, touching nothing", async () => {
		for (const words of [[], ["capsule"], ["capsule", "export"], ["other"], ["capsule", "verify", "--anchors"]]) {
			const r = rig();
			expect(await runMemory(words, r.deps)).toBe(2);
			expect(text(r.err)).toContain("usage: substrate memory capsule export");
			expect(r.mcp.calls).toEqual([]);
			expect(r.fs.files.size).toBe(0);
			expect(r.emitted).toEqual([]);
		}
		expect(CAPSULE_USAGE).toContain("exit: 0 done, 1 failed or incomplete, 2 usage, 3 verify --anchors could not finish");
	});
});

describe("export", () => {
	const five = [1, 2, 3, 4, 5].map((i) => reply(i));

	test("round trip: pages the read, writes a 0600 capsule that imports, records ONE note, prints digest, count and root", async () => {
		const many = Array.from({ length: 230 }, (_, i) => reply(i + 1));
		const r = rig(many);
		const code = await runMemory(["capsule", "export", "--out", "c.jsonl", "--limit", "500"], r.deps);
		expect(code).toBe(0);

		// Bounded pages: three calls of 100, 100, 30 entries; every call is a paged search from the top of time.
		const calls = searchCalls(r);
		expect(calls.map((c) => c.args.limit)).toEqual([PAGE_SIZE, PAGE_SIZE, PAGE_SIZE]);
		expect(calls[0]?.args).toMatchObject({ query: "", include_superseded: true, before: "9999-12-31T23:59:59Z" });
		expect(calls[1]?.args.before_id).toBeDefined();

		const path = `${CWD}/c.jsonl`;
		expect(r.fs.created).toEqual([path]);
		expect(r.fs.modes.get(path)).toBe(0o600);
		const bytes = r.fs.files.get(path) as Uint8Array;
		const imported = importCapsule(bytes);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw imported.error;
		expect(imported.capsule.manifest.count).toBe(230);
		expect(imported.capsule.manifest.producer).toBe("substrate-cli");
		expect(imported.capsule.manifest.created_at).toBe(NOW.toISOString());
		expect(imported.capsule.records.some(isTombstone)).toBe(false);

		const output = text(r.out);
		expect(output).toContain(`digest: ${imported.capsule.digest}`);
		expect(output).toContain("records: 230 (230 with content, 0 tombstones)");
		expect(output).toContain(`root_digest: ${imported.capsule.manifest.root_digest}`);
		expect(output).toContain("ledger: memory.capsule.export note recorded");

		// ONE note, built by the nexus module, carrying digests and counts and no content.
		expect(r.emitted).toHaveLength(1);
		const note = r.emitted[0] as EventInput;
		expect(note).toMatchObject({ surface: "claude-code", kind: "note" });
		expect(note.repo).toBeUndefined();
		expect(parseCapsuleExportPayload(note.payload)).toEqual({
			action: "memory.capsule.export",
			digest: imported.capsule.digest,
			count: 230,
			root_digest: imported.capsule.manifest.root_digest,
			size: bytes.byteLength,
		});
		expect(note.idempotency_key).toBe(`mce:${imported.capsule.digest}`);
		expect(JSON.stringify(note)).not.toContain("synthetic body");
	});

	test("the export is deterministic: the same entries and clock give the same bytes", async () => {
		const a = rig(five);
		const b = rig([...five].reverse());
		await runMemory(["capsule", "export", "--out", "c.jsonl"], a.deps);
		await runMemory(["capsule", "export", "--out", "c.jsonl"], b.deps);
		expect(sha256Bytes(a.fs.files.get(`${CWD}/c.jsonl`) as Uint8Array)).toBe(sha256Bytes(b.fs.files.get(`${CWD}/c.jsonl`) as Uint8Array));
	});

	test("the surface flag picks the MCP caller and the note's surface", async () => {
		const r = rig(five);
		const surfaces: string[] = [];
		r.deps.mcpFor = (surface) => {
			surfaces.push(surface);
			return r.mcp;
		};
		await runMemory(["capsule", "export", "--out", "c.jsonl", "--surface", "omp"], r.deps);
		expect(surfaces).toEqual(["omp"]);
		expect(r.emitted[0]?.surface).toBe("omp");
	});

	test("never overwrites: an existing --out is refused before any read, and its bytes are untouched", async () => {
		const r = rig(five);
		const existing = new TextEncoder().encode("do not touch");
		r.fs.files.set(`${CWD}/c.jsonl`, existing);
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl"], r.deps)).toBe(1);
		expect(text(r.err)).toContain("already exists");
		expect(r.mcp.calls).toEqual([]);
		expect(r.fs.files.get(`${CWD}/c.jsonl`)).toBe(existing);
		expect(r.emitted).toEqual([]);
	});

	test("never overwrites even when the file appears after the check: the exclusive create refuses and no note is recorded", async () => {
		const r = rig(five);
		const existing = new TextEncoder().encode("appeared meanwhile");
		r.fs.files.set(`${CWD}/c.jsonl`, existing);
		r.fs.hideExisting = true;
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl"], r.deps)).toBe(1);
		expect(text(r.err)).toContain("already exists");
		expect(r.fs.files.get(`${CWD}/c.jsonl`)).toBe(existing);
		expect(r.emitted).toEqual([]);
	});

	test("record cap: --limit stops the read, says it was truncated and exports exactly that many", async () => {
		const r = rig(Array.from({ length: 150 }, (_, i) => reply(i + 1)));
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl", "--limit", "120"], r.deps)).toBe(0);
		const imported = importCapsule(r.fs.files.get(`${CWD}/c.jsonl`) as Uint8Array);
		if (!imported.ok) throw imported.error;
		expect(imported.capsule.manifest.count).toBe(120);
		// The newest 120 entries (i = 31..150) are the ones kept.
		expect(imported.capsule.records.map((rec) => rec.id).sort()[0]).toBe("mem_0031");
		expect(text(r.err)).toContain("stopped at --limit 120");
		// A cap that is not hit is not reported.
		const small = rig(five);
		await runMemory(["capsule", "export", "--out", "c.jsonl", "--limit", "5"], small.deps);
		expect(text(small.err)).toBe("");
	});

	test("the default cap is DEFAULT_LIMIT records", async () => {
		const r = rig(Array.from({ length: DEFAULT_LIMIT + 5 }, (_, i) => reply(i + 1)));
		await runMemory(["capsule", "export", "--out", "c.jsonl"], r.deps);
		const imported = importCapsule(r.fs.files.get(`${CWD}/c.jsonl`) as Uint8Array);
		if (!imported.ok) throw imported.error;
		expect(imported.capsule.manifest.count).toBe(DEFAULT_LIMIT);
	});

	test("the scan is bounded: a filter that matches nothing stops at the scan cap and says so", async () => {
		const r = rig([reply(1)]);
		// An endless supply of entries from other sessions: each page is full and has a fresh cursor.
		let page = 0;
		r.mcp.searchOverride = () => {
			page += 1;
			return {
				entries: Array.from({ length: PAGE_SIZE }, (_, i) => reply(page * 1000 + i, { session_id: "other", created: new Date(BASE_MS - page * 60_000).toISOString() })),
				next: { before: new Date(BASE_MS - page * 60_000 - 1).toISOString(), before_id: `mem_${page}` },
			};
		};
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl", "--session", "sess-a"], r.deps)).toBe(1);
		expect(searchCalls(r)).toHaveLength(MAX_SCANNED_ENTRIES / PAGE_SIZE);
		expect(text(r.err)).toContain("nothing to export");
		const direct = await collectEntries(r.mcp, { session: "sess-a", repo: null, since: null, limit: 10 });
		expect(direct.scanCapped).toBe(true);
		expect(direct.examined).toBe(MAX_SCANNED_ENTRIES);
	});

	test("filters apply to the entry's own fields: --session, --repo and --since", async () => {
		const entries = [
			reply(1, { session_id: "sess-a", repo: "acme/app" }),
			reply(2, { session_id: "sess-b", repo: "acme/app" }),
			reply(3, { session_id: "sess-a", repo: "acme/other" }),
			reply(4, { session_id: "sess-a", repo: "acme/app" }),
		];
		const ids = async (flags: string[]): Promise<string[]> => {
			const r = rig(entries);
			expect(await runMemory(["capsule", "export", "--out", "c.jsonl", ...flags], r.deps)).toBe(0);
			const imported = importCapsule(r.fs.files.get(`${CWD}/c.jsonl`) as Uint8Array);
			if (!imported.ok) throw imported.error;
			return imported.capsule.records.map((rec) => rec.id);
		};
		expect(await ids(["--session", "sess-a"])).toEqual(["mem_0001", "mem_0003", "mem_0004"]);
		expect(await ids(["--repo", "acme/app"])).toEqual(["mem_0001", "mem_0002", "mem_0004"]);
		expect(await ids(["--session", "sess-a", "--repo", "acme/app"])).toEqual(["mem_0001", "mem_0004"]);
		expect(await ids(["--since", new Date(BASE_MS + 3 * 60_000).toISOString()])).toEqual(["mem_0003", "mem_0004"]);
		// The repo filter is also sent to the server, which uses it for `agent:` visibility.
		const sent = rig(entries);
		await runMemory(["capsule", "export", "--out", "c.jsonl", "--repo", "acme/app"], sent.deps);
		expect(searchCalls(sent)[0]?.args.repo).toBe("acme/app");
	});

	test("a filter that matches nothing is a refusal with the counts, and nothing is written", async () => {
		const r = rig(five);
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl", "--session", "nobody"], r.deps)).toBe(1);
		expect(text(r.err)).toContain("nothing to export");
		expect(r.fs.files.size).toBe(0);
		expect(r.emitted).toEqual([]);
	});

	test("a forgotten entry is exported as a tombstone and its body never reaches the file", async () => {
		const entries = [reply(1), reply(2, { superseded_by: "forgotten:fg_0123456789abcdef0123456789", text: "FORGOTTEN-BODY-MUST-NOT-SHIP" })];
		const r = rig(entries);
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl"], r.deps)).toBe(0);
		const bytes = r.fs.files.get(`${CWD}/c.jsonl`) as Uint8Array;
		expect(new TextDecoder().decode(bytes)).not.toContain("FORGOTTEN-BODY-MUST-NOT-SHIP");
		const imported = importCapsule(bytes);
		if (!imported.ok) throw imported.error;
		expect(imported.capsule.records.filter(isTombstone).map((rec) => rec.id)).toEqual(["mem_0002"]);
		expect(text(r.out)).toContain("1 with content, 1 tombstones");
		// A forgotten entry whose body is already gone from the reply is still a tombstone.
		const goneBody = rig([reply(1), { ...reply(2, { superseded_by: "forgotten:fg_0123456789abcdef0123456789" }), text: undefined }]);
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl"], goneBody.deps)).toBe(0);
	});

	test("entries that cannot be made into capsule records are LEFT OUT LOUDLY: the file is written and the exit is 1", async () => {
		// mem_9999 carries a created value like every real row: the fake server pages by created, so without it the row would never be returned.
		const entries = [reply(1), reply(2, { entry_hash: "" }), reply(3, { text: "edited after the hash was taken" }), { id: "mem_9999", scope: "repo:acme", created: "2026-01-01T00:00:00.000Z" }];
		// reply(3) hashes its own text; overwrite the hash to a wrong value so the record fails its content hash.
		(entries[2] as Rec).entry_hash = "a".repeat(64);
		const r = rig(entries);
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl"], r.deps)).toBe(1);
		const imported = importCapsule(r.fs.files.get(`${CWD}/c.jsonl`) as Uint8Array);
		if (!imported.ok) throw imported.error;
		expect(imported.capsule.records.map((rec) => rec.id)).toEqual(["mem_0001"]);
		const err = text(r.err);
		expect(err).toContain("INCOMPLETE: 3 entries");
		expect(err).toContain("mem_0002: no entry_hash");
		expect(err).toContain("mem_0003");
		expect(err).toContain("mem_9999");
		// The note is still recorded for the capsule that WAS written.
		expect(r.emitted).toHaveLength(1);
	});

	test("--store puts the same bytes in the local store and says so; a failing or lying store fails the command after the file is written", async () => {
		const r = rig(five);
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl", "--store", "capsules"], r.deps)).toBe(0);
		const bytes = r.fs.files.get(`${CWD}/c.jsonl`) as Uint8Array;
		expect(r.storeDirs).toEqual([`${CWD}/capsules`]);
		expect(r.store.blobs.get(sha256Bytes(bytes))).toEqual(bytes);
		expect(text(r.out)).toContain(`store: ${CWD}/capsules holds ${sha256Bytes(bytes)}`);

		const down = rig(five);
		down.store.failPut = true;
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl", "--store", "/abs/store"], down.deps)).toBe(1);
		expect(down.storeDirs).toEqual(["/abs/store"]);
		expect(text(down.err)).toContain("the capsule was written");
		expect(text(down.err)).toContain("store");
		expect(down.fs.files.has(`${CWD}/c.jsonl`)).toBe(true);
		expect(down.emitted).toEqual([]);

		const lying = rig(five);
		lying.store.wrongDigest = true;
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl", "--store", "/abs/store"], lying.deps)).toBe(1);
		expect(text(lying.err)).toContain("the store named the capsule");
	});

	test("the note is fail-open and says plainly when it was not recorded", async () => {
		for (const [outcome, expected] of [
			[{ kind: "failed", error: "connect ECONNREFUSED" }, "NOT RECORDED: failed (connect ECONNREFUSED)"],
			[{ kind: "failed", error: "timeout", spooled: true }, "parked in the event spool"],
			[{ kind: "refused", status: 403, error: "forbidden" }, "NOT RECORDED: refused (HTTP 403: forbidden)"],
		] as Array<[EmitOutcome, string]>) {
			const r = rig(five);
			r.setEmit(outcome);
			expect(await runMemory(["capsule", "export", "--out", "c.jsonl"], r.deps)).toBe(0);
			expect(text(r.out)).toContain(expected);
			// The capsule stays written.
			expect(r.fs.files.has(`${CWD}/c.jsonl`)).toBe(true);
			expect(r.emitted).toHaveLength(1);
		}
	});

	test("a server that does not answer, refuses, or cannot page is a typed failure with nothing written", async () => {
		const unreachable = rig(five);
		unreachable.mcp.searchFailure = new CapsuleMcpError("unreachable", "the substrate did not answer memory_search: timeout");
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl"], unreachable.deps)).toBe(1);
		expect(text(unreachable.err)).toContain("export failed (unreachable)");
		expect(unreachable.fs.files.size).toBe(0);

		const bare = rig(five);
		bare.mcp.searchOverride = () => [reply(1)];
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl"], bare.deps)).toBe(1);
		expect(text(bare.err)).toContain("cannot page");

		const stuck = rig(five);
		stuck.mcp.searchOverride = () => ({ entries: [reply(1)], next: { before: "9999-12-31T23:59:59Z", before_id: undefined } });
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl"], stuck.deps)).toBe(1);
		const sameCursor = rig(five);
		sameCursor.mcp.searchOverride = (args) => ({ entries: [reply(1)], next: { before: String(args.before), before_id: String(args.before_id ?? "") } });
		// First answer's cursor differs from the initial one (no before_id), the second repeats itself: refused rather than looped.
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl"], sameCursor.deps)).toBe(1);
		expect(text(sameCursor.err)).toContain("does not advance");
	});

	test("a write failure other than EEXIST is reported with its code", async () => {
		const r = rig(five);
		r.fs.failWrite = "ENOSPC";
		expect(await runMemory(["capsule", "export", "--out", "c.jsonl"], r.deps)).toBe(1);
		expect(text(r.err)).toContain("ENOSPC");
		expect(r.emitted).toEqual([]);
	});
});

describe("entryFromReply", () => {
	test("reads the fields a capsule record needs and refuses what is not an entry", () => {
		const ok = entryFromReply(reply(7));
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.entry).toMatchObject({ id: "mem_0007", scope: "repo:acme", kind: "fact", version: 1, writer: "claude-code" });
		for (const bad of [null, "x", [], {}, { ...reply(1), actor: "robot" }, { ...reply(1), trust: "high" }, { ...reply(1), version: 0 }, { ...reply(1), text: undefined }, { ...reply(1), id: "" }]) {
			expect(entryFromReply(bad).ok).toBe(false);
		}
	});
});

describe("verify", () => {
	function capsuleOf(count: number, tombstones: string[] = []): { bytes: Uint8Array; ids: string[] } {
		const entries = Array.from({ length: count }, (_, i) => {
			const parsed = entryFromReply(reply(i + 1));
			if (!parsed.ok) throw new Error(parsed.reason);
			return parsed.entry;
		});
		const records = entries.map((entry) => toCapsuleRecord(entry, { now: () => NOW, forgotten: new Set(tombstones) }));
		return { bytes: exportCapsule(records, { producer: "substrate-cli", now: () => NOW }).bytes, ids: entries.map((e) => e.id) };
	}

	test("offline: a good capsule verifies, prints digest, counts and root, and calls no server", async () => {
		const r = rig();
		const { bytes } = capsuleOf(4, ["mem_0002"]);
		r.fs.files.set(`${CWD}/c.jsonl`, bytes);
		expect(await runMemory(["capsule", "verify", "c.jsonl"], r.deps)).toBe(0);
		const output = text(r.out);
		expect(output).toContain("capsule ok:");
		expect(output).toContain(`digest: ${sha256Bytes(bytes)}`);
		expect(output).toContain("records: 4 (3 with content, 1 tombstones)");
		expect(output).toContain("not checked: who wrote the file");
		expect(r.mcp.calls).toEqual([]);
	});

	test("a tampered, truncated or missing capsule fails with the rule, exit 1", async () => {
		const { bytes } = capsuleOf(3);
		const tampered = new TextEncoder().encode(new TextDecoder().decode(bytes).replace("synthetic body 2", "synthetic body X"));
		for (const [name, content] of [
			["tampered.jsonl", tampered],
			["truncated.jsonl", bytes.slice(0, bytes.length - 40)],
			["garbage.jsonl", new TextEncoder().encode("not a capsule")],
		] as Array<[string, Uint8Array]>) {
			const r = rig();
			r.fs.files.set(`${CWD}/${name}`, content);
			expect(await runMemory(["capsule", "verify", name], r.deps)).toBe(1);
			expect(text(r.err)).toContain("capsule INVALID:");
		}
		const r = rig();
		expect(await runMemory(["capsule", "verify", "missing.jsonl"], r.deps)).toBe(1);
		expect(text(r.err)).toContain("could not read");
	});

	test("--anchors samples at most 50 records, evenly and deterministically, and prints each status", async () => {
		const { bytes, ids } = capsuleOf(120);
		const r = rig(ids.map((_, i) => reply(i + 1)));
		r.fs.files.set(`${CWD}/c.jsonl`, bytes);
		expect(await runMemory(["capsule", "verify", "c.jsonl", "--anchors"], r.deps)).toBe(0);
		const verifyCalls = r.mcp.calls.filter((c) => c.tool === "memory_verify");
		expect(verifyCalls).toHaveLength(MAX_ANCHOR_SAMPLE);
		expect(new Set(verifyCalls.map((c) => c.args.id)).size).toBe(MAX_ANCHOR_SAMPLE);
		expect(verifyCalls[0]?.args).toEqual({ id: "mem_0001", repo: "acme/app" });
		const output = text(r.out);
		expect(output).toContain("looked up 50 of 120 records");
		expect(output).toContain("tally: verified 50");
		expect(output).toContain("mem_0001  verified");
		// The same capsule samples the same ids.
		const again = rig(ids.map((_, i) => reply(i + 1)));
		again.fs.files.set(`${CWD}/c.jsonl`, bytes);
		await runMemory(["capsule", "verify", "c.jsonl", "--anchors"], again.deps);
		expect(again.mcp.calls.map((c) => c.args.id)).toEqual(r.mcp.calls.map((c) => c.args.id));
	});

	test("sampleIndexes: all when few, strictly increasing and spread when many", () => {
		expect(sampleIndexes(3, 50)).toEqual([0, 1, 2]);
		expect(sampleIndexes(0, 50)).toEqual([]);
		const picked = sampleIndexes(51, 50);
		expect(picked).toHaveLength(50);
		expect(picked.every((v, i) => i === 0 || v > (picked[i - 1] as number))).toBe(true);
		expect(picked[0]).toBe(0);
		expect(picked[49]).toBeLessThan(51);
	});

	test("non-verified statuses are reported, not failures; tombstones are not looked up", async () => {
		const { bytes } = capsuleOf(3, ["mem_0003"]);
		const r = rig([reply(1), reply(2), reply(3)]);
		r.fs.files.set(`${CWD}/c.jsonl`, bytes);
		r.mcp.verifyReplies.set("mem_0001", { id: "mem_0001", status: "pending", reasons: ["x"], content_hash: reply(1).entry_hash });
		r.mcp.verifyReplies.set("mem_0002", { id: "mem_0002", status: "unanchored", reasons: ["x"], content_hash: reply(2).entry_hash });
		expect(await runMemory(["capsule", "verify", "c.jsonl", "--anchors"], r.deps)).toBe(0);
		expect(r.mcp.calls.map((c) => c.args.id)).toEqual(["mem_0001", "mem_0002"]);
		expect(text(r.out)).toContain("pending 1, unanchored 1");
	});

	test("a hash mismatch, an anchor mismatch or a live entry that differs from the capsule is exit 1", async () => {
		for (const verdict of [
			{ id: "mem_0001", status: "hash-mismatch", reasons: ["x"], content_hash: reply(1).entry_hash },
			{ id: "mem_0001", status: "anchor-mismatch", reasons: ["x"], content_hash: reply(1).entry_hash },
			{ id: "mem_0001", status: "verified", reasons: ["x"], content_hash: "b".repeat(64) },
		]) {
			const { bytes } = capsuleOf(2);
			const r = rig([reply(1), reply(2)]);
			r.fs.files.set(`${CWD}/c.jsonl`, bytes);
			r.mcp.verifyReplies.set("mem_0001", verdict);
			expect(await runMemory(["capsule", "verify", "c.jsonl", "--anchors"], r.deps)).toBe(1);
			expect(text(r.err)).toContain("anchor check FAILED");
		}
	});

	test("a server that does not answer or refuses leaves the anchors unclaimed: exit 3, the offline result still printed", async () => {
		const { bytes } = capsuleOf(2);
		for (const failure of [new CapsuleMcpError("unreachable", "no answer"), new CapsuleMcpError("refused", "memory_verify was refused: not_found")]) {
			const r = rig([reply(1), reply(2)]);
			r.fs.files.set(`${CWD}/c.jsonl`, bytes);
			r.mcp.verifyFailure = failure;
			expect(await runMemory(["capsule", "verify", "c.jsonl", "--anchors"], r.deps)).toBe(3);
			expect(text(r.out)).toContain("capsule ok:");
			expect(text(r.out)).toContain("unavailable");
			expect(text(r.err)).toContain("anchor check INCOMPLETE");
		}
		const r = rig([reply(1)]);
		r.fs.files.set(`${CWD}/c.jsonl`, capsuleOf(1).bytes);
		r.mcp.verifyReplies.set("mem_0001", { nonsense: true });
		expect(await runMemory(["capsule", "verify", "c.jsonl", "--anchors"], r.deps)).toBe(3);
	});
});

describe("redact", () => {
	function seed(): { r: Rig; bytes: Uint8Array } {
		const entries = [1, 2, 3].map((i) => {
			const parsed = entryFromReply(reply(i));
			if (!parsed.ok) throw new Error(parsed.reason);
			return parsed.entry;
		});
		const bytes = exportCapsule(
			entries.map((entry) => toCapsuleRecord(entry, { now: () => NOW })),
			{ producer: "substrate-cli", now: () => NOW },
		).bytes;
		const r = rig();
		r.fs.files.set(`${CWD}/c.jsonl`, bytes);
		return { r, bytes };
	}

	test("round trip: writes a new 0600 file with the content gone, leaves the input byte-identical, records ONE note", async () => {
		const { r, bytes } = seed();
		const before = sha256Bytes(bytes);
		expect(await runMemory(["capsule", "redact", "c.jsonl", "--ids", "mem_0002", "--reason", "erasure request", "--out", "d.jsonl"], r.deps)).toBe(0);

		expect(sha256Bytes(r.fs.files.get(`${CWD}/c.jsonl`) as Uint8Array)).toBe(before);
		const outBytes = r.fs.files.get(`${CWD}/d.jsonl`) as Uint8Array;
		expect(r.fs.modes.get(`${CWD}/d.jsonl`)).toBe(0o600);
		expect(new TextDecoder().decode(outBytes)).not.toContain("synthetic body 2");
		expect(new TextDecoder().decode(outBytes)).toContain("synthetic body 1");
		const imported = importCapsule(outBytes);
		if (!imported.ok) throw imported.error;
		expect(imported.capsule.records.filter(isTombstone).map((rec) => rec.id)).toEqual(["mem_0002"]);
		const original = importCapsule(bytes);
		if (!original.ok) throw original.error;
		expect(imported.capsule.manifest.root_digest).toBe(original.capsule.manifest.root_digest);

		const output = text(r.out);
		expect(output).toContain(`digest before: ${before}`);
		expect(output).toContain(`digest after:  ${imported.capsule.digest}`);
		expect(output).toContain("ledger: memory.capsule.redact note recorded");
		expect(r.emitted).toHaveLength(1);
		expect(parseCapsuleRedactPayload(r.emitted[0]?.payload)).toEqual({
			action: "memory.capsule.redact",
			digest_before: before,
			digest_after: imported.capsule.digest,
			redacted_count: 1,
			reason: "erasure request",
		});
		expect(r.emitted[0]?.repo).toBeUndefined();
		// The redacted file verifies through the same command.
		expect(await runMemory(["capsule", "verify", "d.jsonl"], r.deps)).toBe(0);
	});

	test("redacting an already redacted record changes nothing: no file and no note", async () => {
		const { r } = seed();
		await runMemory(["capsule", "redact", "c.jsonl", "--ids", "mem_0002", "--reason", "erasure request", "--out", "d.jsonl"], r.deps);
		const again = await runMemory(["capsule", "redact", "d.jsonl", "--ids", "mem_0002", "--reason", "erasure request", "--out", "e.jsonl"], r.deps);
		expect(again).toBe(0);
		expect(text(r.out)).toContain("nothing to redact");
		expect(r.fs.files.has(`${CWD}/e.jsonl`)).toBe(false);
		expect(r.emitted).toHaveLength(1);
	});

	test("refuses an unknown id, a reason that is prose, the input as output and an existing output; nothing is written or recorded", async () => {
		const cases: Array<[string[], number, string]> = [
			[["--ids", "mem_9999", "--reason", "erasure request", "--out", "d.jsonl"], 1, "unknown_id"],
			[["--ids", "mem_0001", "--reason", "please remove it, the user asked nicely!", "--out", "d.jsonl"], 1, "format"],
			[["--ids", "mem_0001", "--reason", "erasure request", "--out", "c.jsonl"], 2, "different file"],
			[["--ids", "mem_0001", "--reason", "erasure request", "--out", "taken.jsonl"], 1, "already exists"],
		];
		for (const [flags, code, message] of cases) {
			const { r, bytes } = seed();
			const taken = new TextEncoder().encode("taken");
			r.fs.files.set(`${CWD}/taken.jsonl`, taken);
			expect(await runMemory(["capsule", "redact", "c.jsonl", ...flags], r.deps)).toBe(code);
			expect(text(r.err)).toContain(message);
			expect(r.fs.files.get(`${CWD}/c.jsonl`)).toBe(bytes);
			expect(r.fs.files.get(`${CWD}/taken.jsonl`)).toBe(taken);
			expect(r.fs.files.has(`${CWD}/d.jsonl`)).toBe(false);
			expect(r.emitted).toEqual([]);
		}
	});

	test("a damaged input is refused before anything is written", async () => {
		const { r } = seed();
		r.fs.files.set(`${CWD}/c.jsonl`, new TextEncoder().encode("garbage"));
		expect(await runMemory(["capsule", "redact", "c.jsonl", "--ids", "mem_0001", "--reason", "erasure request", "--out", "d.jsonl"], r.deps)).toBe(1);
		expect(r.fs.files.has(`${CWD}/d.jsonl`)).toBe(false);
		expect(r.emitted).toEqual([]);
	});

	test("the note is fail-open here too", async () => {
		const { r } = seed();
		r.setEmit({ kind: "failed", error: "connect ECONNREFUSED" });
		expect(await runMemory(["capsule", "redact", "c.jsonl", "--ids", "mem_0001", "--reason", "erasure request", "--out", "d.jsonl"], r.deps)).toBe(0);
		expect(text(r.out)).toContain("memory.capsule.redact note NOT RECORDED");
		expect(r.fs.files.has(`${CWD}/d.jsonl`)).toBe(true);
	});
});

describe("httpCapsuleMcp", () => {
	function connect(handler: (url: string, init: RequestInit) => Response | Promise<Response>, token?: string) {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(url), init: init ?? {} });
			return handler(String(url), init ?? {});
		}) as typeof fetch;
		return { mcp: httpCapsuleMcp({ url: "http://substrate.invalid:7410/", token, timeoutMs: 1000, fetchImpl }), seen };
	}

	const rpc = (result: unknown): string => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });

	test("posts one JSON-RPC tools/call to /mcp with the bearer and parses plain JSON and an SSE data line", async () => {
		const plain = connect(() => new Response(rpc({ entries: [], next: null })), "tok-synthetic");
		expect(await plain.mcp.call("memory_search", { query: "" })).toEqual({ entries: [], next: null });
		expect(plain.seen[0]?.url).toBe("http://substrate.invalid:7410/mcp");
		const sent = JSON.parse(String(plain.seen[0]?.init.body));
		expect(sent).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "memory_search", arguments: { query: "" } } });
		const plainHeaders = plain.seen[0]?.init.headers as Record<string, string> | undefined;
		if (!plainHeaders) throw new Error("the plain call sent no headers");
		expect(plainHeaders.authorization).toBe("Bearer tok-synthetic");

		const sse = connect(() => new Response(`event: message\ndata: ${rpc({ status: "verified" })}\n\n`));
		expect(await sse.mcp.call("memory_verify", { id: "mem_1" })).toEqual({ status: "verified" });
		const sseHeaders = sse.seen[0]?.init.headers as Record<string, string> | undefined;
		if (!sseHeaders) throw new Error("the SSE call sent no headers");
		expect(sseHeaders.authorization).toBeUndefined();
	});

	test("an unreachable server, a refusal and a malformed answer are typed, and a diagnostic never carries the URL or the token", async () => {
		const down = connect(() => {
			throw new Error("connect ECONNREFUSED http://substrate.invalid:7410/mcp with Bearer tok-synthetic-secret-value-123456");
		}, "tok-synthetic-secret-value-123456");
		const unreachable = await down.mcp.call("memory_search", {}).catch((e: unknown) => e);
		expect(unreachable).toBeInstanceOf(CapsuleMcpError);
		expect((unreachable as CapsuleMcpError).kind).toBe("unreachable");
		expect((unreachable as CapsuleMcpError).message).not.toContain("substrate.invalid");
		expect((unreachable as CapsuleMcpError).message).not.toContain("tok-synthetic-secret-value");

		const refused = connect(() => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
		const r1 = await refused.mcp.call("memory_search", {}).catch((e: unknown) => e);
		expect((r1 as CapsuleMcpError).kind).toBe("refused");
		expect((r1 as CapsuleMcpError).message).toContain("401");

		const toolError = connect(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "not_found: no such entry" }] } })));
		expect(((await toolError.mcp.call("memory_verify", {}).catch((e: unknown) => e)) as CapsuleMcpError).kind).toBe("refused");

		const html = connect(() => new Response("<html>bad gateway</html>", { status: 502 }));
		expect(((await html.mcp.call("memory_search", {}).catch((e: unknown) => e)) as CapsuleMcpError).kind).toBe("invalid");

		const notJson = connect(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "plain words" }] } })));
		expect(((await notJson.mcp.call("memory_search", {}).catch((e: unknown) => e)) as CapsuleMcpError).kind).toBe("invalid");
	});
});

describe("nodeCapsuleFs (a real temporary directory)", () => {
	const dir = mkdtempSync(join(tmpdir(), "capsule-cli-test-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const fs = nodeCapsuleFs();

	test("writeNew creates a 0600 file, never overwrites and leaves the existing bytes alone", async () => {
		const path = join(dir, "a.jsonl");
		await fs.writeNew(path, new TextEncoder().encode("first"), 0o600);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const failure = await fs.writeNew(path, new TextEncoder().encode("second"), 0o600).catch((e: unknown) => e);
		expect((failure as { code?: string }).code).toBe("EEXIST");
		expect(readFileSync(path, "utf8")).toBe("first");
		expect(await fs.exists(path)).toBe(true);
		expect(await fs.exists(join(dir, "missing.jsonl"))).toBe(false);
	});

	test("readBytes refuses an oversized file and one that is not a regular file", async () => {
		const path = join(dir, "big.jsonl");
		writeFileSync(path, "x".repeat(100));
		expect((await fs.readBytes(path, 100)).byteLength).toBe(100);
		await expect(fs.readBytes(path, 99)).rejects.toThrow("limit is 99");
		await expect(fs.readBytes(dir, 1000)).rejects.toThrow("not a regular file");
		expect(existsSync(path)).toBe(true);
	});

	test("a LocalBlobStore accepts the exported bytes under their digest", async () => {
		const store = new LocalBlobStore(join(dir, "store"));
		const entries = [entryFromReply(reply(1))];
		const parsed = entries[0];
		if (parsed === undefined || !parsed.ok) throw new Error("fixture");
		const bytes = exportCapsule([toCapsuleRecord(parsed.entry, { now: () => NOW })], { producer: "substrate-cli", now: () => NOW }).bytes;
		expect(await store.put(bytes)).toBe(sha256Bytes(bytes));
	});
});
