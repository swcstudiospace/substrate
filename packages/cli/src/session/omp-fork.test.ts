import { describe, expect, test } from "bun:test";
import { parseTranscriptRef } from "../../../mcp-server/src/session-events.ts";
import {
	OMP_TITLE_SLOT_BYTES,
	OmpForkError,
	forkOmpSession,
	ompSessionFileName,
	ompTranscriptRef,
	parseOmpSession,
	type ForkOmpSessionInput,
	type ForkOmpSessionResult,
} from "./omp-fork.ts";

// Every fixture below is synthetic: ids, prompts, paths and titles are invented for these tests.

const ORIGINAL_ID = "01900000-0000-7000-8000-00000000aaaa";
const NEW_ID = "01900000-0000-7000-8000-00000000bbbb";
const FIXED = new Date("2026-10-26T12:00:00.000Z");
const clock = () => FIXED;
const LOCATOR = "2026-10-20T08-00-00-000Z_01900000-0000-7000-8000-00000000aaaa.jsonl";

type Obj = Record<string, unknown>;

function slotLine(title: string): string {
	const base = { type: "title", v: 1, title, source: "auto", updatedAt: "2026-10-20T08:00:00.000Z" };
	const bare = JSON.stringify({ ...base, pad: "" });
	return `${JSON.stringify({ ...base, pad: " ".repeat(OMP_TITLE_SLOT_BYTES - Buffer.byteLength(bare) - 1) })}\n`;
}

function header(overrides: Obj = {}): Obj {
	return {
		type: "session",
		version: 3,
		id: ORIGINAL_ID,
		timestamp: "2026-10-20T08:00:00.000Z",
		cwd: "/synthetic/project",
		additionalDirectories: ["/synthetic/shared"],
		previousSessionFiles: ["/synthetic/old/location.jsonl"],
		providerPromptCacheKey: "synthetic-cache-key",
		...overrides,
	};
}

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string): Obj {
	return { type: "message", id, parentId, timestamp: "2026-10-20T08:00:01.000Z", message: { role, content: [{ type: "text", text }] } };
}

function custom(id: string, parentId: string | null): Obj {
	return { type: "custom", id, parentId, timestamp: "2026-10-20T08:00:02.000Z", customType: "synthetic.marker", data: { n: 1 } };
}

/** a1 -> a2 -> a3 -> a4 -> a5, with b3 a second child of a2. File order: a1 a2 a3 b3 a4 a5 (leaf a5). */
function treeEntries(): Obj[] {
	return [
		message("a1a1a1a1", null, "user", "synthetic prompt one"),
		message("a2a2a2a2", "a1a1a1a1", "assistant", "synthetic answer one"),
		message("a3a3a3a3", "a2a2a2a2", "user", "synthetic prompt two"),
		message("b3b3b3b3", "a2a2a2a2", "assistant", "synthetic side branch"),
		message("a4a4a4a4", "a3a3a3a3", "assistant", "synthetic answer two"),
		custom("a5a5a5a5", "a4a4a4a4"),
	];
}

function build(entries: Obj[], options: { header?: Obj; slot?: boolean; title?: string } = {}): string {
	const slot = options.slot === false ? "" : slotLine(options.title ?? "synthetic title");
	return `${slot}${[options.header ?? header(), ...entries].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function input(text: string, entryId: string, extra: Partial<ForkOmpSessionInput> = {}): ForkOmpSessionInput {
	return { sessionFileText: text, entryId, newSessionId: NEW_ID, now: clock, parentSessionLocator: LOCATOR, ...extra };
}

function mustFork(result: ForkOmpSessionResult) {
	if (!result.ok) throw new Error(`fork failed: ${result.code} ${result.detail}`);
	return result;
}

function ids(text: string): string[] {
	return parseOmpSession(text).entries.map((entry) => entry.id);
}

describe("forkOmpSession: which entries are kept", () => {
	const original = build(treeEntries());

	test("fork at the first entry keeps only that root entry", () => {
		const forked = mustFork(forkOmpSession(input(original, "a1a1a1a1")));
		expect(ids(forked.text)).toEqual(["a1a1a1a1"]);
		expect(forked.entries).toBe(1);
		expect(forked.forked_from.turn_no).toBe(1);
	});

	test("fork at a middle entry keeps the path from the root and drops what follows and every other branch", () => {
		const forked = mustFork(forkOmpSession(input(original, "a3a3a3a3")));
		expect(ids(forked.text)).toEqual(["a1a1a1a1", "a2a2a2a2", "a3a3a3a3"]);
		expect(forked.forked_from.turn_no).toBe(2);
	});

	test("fork at the leaf keeps its whole path but not the side branch", () => {
		const forked = mustFork(forkOmpSession(input(original, "a5a5a5a5")));
		expect(ids(forked.text)).toEqual(["a1a1a1a1", "a2a2a2a2", "a3a3a3a3", "a4a4a4a4", "a5a5a5a5"]);
		expect(forked.text).not.toContain("b3b3b3b3");
	});

	test("a branched tree: forking at one child of a shared parent keeps only the path to that child", () => {
		const forked = mustFork(forkOmpSession(input(original, "b3b3b3b3")));
		expect(ids(forked.text)).toEqual(["a1a1a1a1", "a2a2a2a2", "b3b3b3b3"]);
		expect(forked.text).not.toContain("a3a3a3a3");
		expect(forked.forked_from.turn_no).toBe(1);
	});

	test("entry lines are copied byte for byte and in order", () => {
		const forked = mustFork(forkOmpSession(input(original, "a4a4a4a4")));
		const originalLines = original.split("\n");
		const wanted = [2, 3, 4, 6].map((index) => originalLines[index] as string); // header is line index 1; a1 a2 a3 a4 skip b3
		expect(forked.text.split("\n").slice(2, -1)).toEqual(wanted);
	});

	test("a model_usage target that selects another leaf is refused", () => {
		const entries = [...treeEntries(), { type: "model_usage", id: "c1c1c1c1", parentId: "a5a5a5a5", timestamp: "t", activeLeafId: "a2a2a2a2" }];
		const result = forkOmpSession(input(build(entries), "c1c1c1c1"));
		expect(result).toMatchObject({ ok: false, code: "invalid-argument" });
	});
});

describe("forkOmpSession: the new file's header and title slot", () => {
	const original = build(treeEntries());
	const forked = mustFork(forkOmpSession(input(original, "a3a3a3a3")));
	const lines = forked.text.split("\n");

	test("the title slot is exactly 256 bytes including its newline and carries the injected time", () => {
		const slot = `${lines[0]}\n`;
		expect(Buffer.byteLength(slot)).toBe(OMP_TITLE_SLOT_BYTES);
		expect(JSON.parse(lines[0] as string)).toMatchObject({ type: "title", v: 1, title: "synthetic title", source: "auto", updatedAt: FIXED.toISOString() });
	});

	test("the header has a new id and timestamp, lineage to the original, and no stale location facts", () => {
		const head = JSON.parse(lines[1] as string) as Obj;
		expect(head).toMatchObject({ type: "session", version: 3, id: NEW_ID, timestamp: FIXED.toISOString(), cwd: "/synthetic/project", parentSession: LOCATOR });
		expect(head["additionalDirectories"]).toEqual(["/synthetic/shared"]);
		expect(head["previousSessionFiles"]).toBeUndefined();
		expect(head["providerPromptCacheKey"]).toBeUndefined();
		expect(head["title"]).toBeUndefined();
	});

	test("an existing parentSession is replaced, in place", () => {
		const text = build(treeEntries(), { header: header({ parentSession: "older-parent" }) });
		const head = JSON.parse(mustFork(forkOmpSession(input(text, "a1a1a1a1"))).text.split("\n")[1] as string) as Obj;
		expect(head["parentSession"]).toBe(LOCATOR);
	});

	test("the file name follows omp's <timestamp>_<id>.jsonl form", () => {
		expect(forked.file_name).toBe(`2026-10-26T12-00-00-000Z_${NEW_ID}.jsonl`);
		expect(ompSessionFileName(NEW_ID, FIXED)).toBe(forked.file_name);
	});

	test("a long multibyte title is cut to fit and the slot stays 256 bytes and parses", () => {
		const text = build(treeEntries(), { slot: false, header: header({ title: "synthetic ✓ title ".repeat(40), titleSource: "auto" }) });
		const out = mustFork(forkOmpSession(input(text, "a1a1a1a1")));
		expect(Buffer.byteLength(`${out.text.split("\n")[0]}\n`)).toBe(OMP_TITLE_SLOT_BYTES);
		expect(parseOmpSession(out.text).titleSlot?.title.startsWith("synthetic ✓ title")).toBe(true);
	});

	test("a legacy file with no title slot forks into a file that has one, keeping the header title", () => {
		const text = build(treeEntries(), { slot: false, header: header({ title: "synthetic legacy title", titleSource: "user" }) });
		const out = mustFork(forkOmpSession(input(text, "a2a2a2a2")));
		const parsed = parseOmpSession(out.text);
		expect(parsed.titleSlot).toEqual({ title: "synthetic legacy title", source: "user" });
		expect(parsed.header["title"]).toBeUndefined();
	});
});

describe("forkOmpSession: immutability, determinism, round trip", () => {
	test("the original text is unchanged by a fork", () => {
		const original = build(treeEntries());
		const copy = `${original}`;
		forkOmpSession(input(original, "a3a3a3a3"));
		expect(original).toBe(copy);
		expect(original).toContain("b3b3b3b3");
	});

	test("the same input and injected clock give identical text", () => {
		const original = build(treeEntries());
		const a = mustFork(forkOmpSession(input(original, "a4a4a4a4")));
		const b = mustFork(forkOmpSession(input(original, "a4a4a4a4")));
		expect(b.text).toBe(a.text);
		expect(b.forked_from).toEqual(a.forked_from);
	});

	test("the forked text re-parses with the same parser and its ref carries the same prefix digest", () => {
		const original = build(treeEntries());
		const sourceRef = ompTranscriptRef({ sessionFileText: original, sessionLocator: "orig", entryId: "a3a3a3a3" });
		const forked = mustFork(forkOmpSession(input(original, "a3a3a3a3", { expectedPrefixSha256: sourceRef.prefix_sha256 as string })));
		expect(forked.forked_from.prefix_sha256).toBe(sourceRef.prefix_sha256 as string);
		const forkRef = ompTranscriptRef({ sessionFileText: forked.text, sessionLocator: "fork", entryId: "a3a3a3a3" });
		expect(forkRef.prefix_sha256).toBe(sourceRef.prefix_sha256);
		expect(forkRef.turn_no).toBe(sourceRef.turn_no);
		expect(forkRef.parent_entry_id).toBe(sourceRef.parent_entry_id);
	});

	test("the target is the leaf of the fork (the last physical entry, which is what omp rebuilds on load)", () => {
		const forked = mustFork(forkOmpSession(input(build(treeEntries()), "b3b3b3b3")));
		expect(ompTranscriptRef({ sessionFileText: forked.text, sessionLocator: "fork" }).entry_id).toBe("b3b3b3b3");
	});
});

describe("forkOmpSession: typed failures", () => {
	const original = build(treeEntries());

	test("target not found", () => {
		expect(forkOmpSession(input(original, "ffffffff"))).toMatchObject({ ok: false, code: "entry-not-found" });
	});

	test("a parent that does not exist breaks the chain, with the line number", () => {
		const entries = treeEntries();
		entries[4] = message("a4a4a4a4", "deadbeef", "assistant", "synthetic orphan");
		const result = forkOmpSession(input(build(entries), "a5a5a5a5"));
		expect(result).toMatchObject({ ok: false, code: "chain-broken", line: 7 });
	});

	test("a parent that comes after its child breaks the chain", () => {
		const entries = treeEntries();
		entries[1] = message("a2a2a2a2", "a3a3a3a3", "assistant", "synthetic cycle");
		expect(forkOmpSession(input(build(entries), "a2a2a2a2"))).toMatchObject({ ok: false, code: "chain-broken" });
	});

	test("a duplicate entry id breaks the chain", () => {
		const entries = [...treeEntries(), message("a1a1a1a1", null, "user", "synthetic dupe")];
		expect(forkOmpSession(input(build(entries), "a5a5a5a5"))).toMatchObject({ ok: false, code: "chain-broken" });
	});

	test("a wrong or missing session version is unsupported", () => {
		expect(forkOmpSession(input(build(treeEntries(), { header: header({ version: 2 }) }), "a1a1a1a1"))).toMatchObject({ ok: false, code: "unsupported-version" });
		expect(forkOmpSession(input(build(treeEntries(), { header: header({ version: undefined }) }), "a1a1a1a1"))).toMatchObject({ ok: false, code: "unsupported-version" });
	});

	test("an oversize file is refused", () => {
		expect(forkOmpSession(input(original, "a1a1a1a1", { maxBytes: 100 }))).toMatchObject({ ok: false, code: "too-large" });
		expect(forkOmpSession(input(original, "a1a1a1a1", { maxBytes: Buffer.byteLength(original) }))).toMatchObject({ ok: true });
	});

	test("a changed prefix is a prefix-mismatch, and a change after the target is not", () => {
		const recorded = ompTranscriptRef({ sessionFileText: original, sessionLocator: "orig", entryId: "a3a3a3a3" }).prefix_sha256 as string;
		const rewritten = original.replace("synthetic answer one", "synthetic answer ONE");
		expect(forkOmpSession(input(rewritten, "a3a3a3a3", { expectedPrefixSha256: recorded }))).toMatchObject({ ok: false, code: "prefix-mismatch" });
		const tail = original.replace("synthetic answer two", "synthetic answer TWO");
		expect(forkOmpSession(input(tail, "a3a3a3a3", { expectedPrefixSha256: recorded }))).toMatchObject({ ok: true });
	});

	test("a malformed line is reported with its line number and none of its content", () => {
		const lines = original.split("\n");
		lines.splice(5, 0, "{not json SECRET-SYNTHETIC-CONTENT");
		const result = forkOmpSession(input(lines.join("\n"), "a1a1a1a1"));
		expect(result).toMatchObject({ ok: false, code: "malformed-line", line: 6 });
		expect(JSON.stringify(result)).not.toContain("SECRET-SYNTHETIC-CONTENT");
	});

	test("a blank line, a non-object line and an entry without an id are malformed", () => {
		for (const bad of ["", "[1,2]", JSON.stringify({ type: "message", parentId: null })]) {
			const lines = original.split("\n");
			lines.splice(4, 0, bad);
			expect(forkOmpSession(input(lines.join("\n"), "a1a1a1a1"))).toMatchObject({ ok: false, code: "malformed-line", line: 5 });
		}
	});

	test("header problems: empty file, no header, a slot of the wrong width, a stray header mid-file", () => {
		expect(forkOmpSession(input("", "a1a1a1a1"))).toMatchObject({ ok: false, code: "header-invalid" });
		const noHeader = `${slotLine("t")}${JSON.stringify(treeEntries()[0])}\n`;
		expect(forkOmpSession(input(noHeader, "a1a1a1a1"))).toMatchObject({ ok: false, code: "header-invalid" });
		const narrow = original.replace(/^(.*?)\n/, (_m, slot: string) => `${slot.replace(/ {3}"\}$/, '"}')}\n`);
		expect(forkOmpSession(input(narrow, "a1a1a1a1"))).toMatchObject({ ok: false, code: "header-invalid", line: 1 });
		const stray = build([...treeEntries(), header({ id: "other" })]);
		expect(forkOmpSession(input(stray, "a1a1a1a1"))).toMatchObject({ ok: false, code: "malformed-line" });
	});

	test("invalid arguments are typed, not thrown", () => {
		expect(forkOmpSession(input(original, "a1a1a1a1", { newSessionId: ORIGINAL_ID }))).toMatchObject({ ok: false, code: "invalid-argument" });
		expect(forkOmpSession(input(original, "a1a1a1a1", { newSessionId: "has/slash" }))).toMatchObject({ ok: false, code: "invalid-argument" });
		expect(forkOmpSession(input(original, "a1a1a1a1", { parentSessionLocator: "/abs/path.jsonl" }))).toMatchObject({ ok: false, code: "invalid-argument" });
		expect(forkOmpSession(input(original, "a1a1a1a1", { expectedPrefixSha256: "ABC" }))).toMatchObject({ ok: false, code: "invalid-argument" });
		expect(forkOmpSession(input(original, "bad id!"))).toMatchObject({ ok: false, code: "invalid-argument" });
		expect(forkOmpSession(input(original, "a1a1a1a1", { now: () => new Date("nope") }))).toMatchObject({ ok: false, code: "invalid-argument" });
	});

	test("an unterminated last line is still accepted", () => {
		expect(forkOmpSession(input(original.slice(0, -1), "a5a5a5a5"))).toMatchObject({ ok: true, entries: 5 });
	});
});

describe("ompTranscriptRef", () => {
	const original = build(treeEntries());

	test("defaults to the leaf: the last physical entry", () => {
		const ref = ompTranscriptRef({ sessionFileText: original, sessionLocator: LOCATOR });
		expect(ref).toMatchObject({ surface: "omp", session_locator: LOCATOR, entry_id: "a5a5a5a5", parent_entry_id: "a4a4a4a4", turn_no: 2 });
		expect(ref.prefix_sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("a root entry carries no parent_entry_id", () => {
		const ref = ompTranscriptRef({ sessionFileText: original, sessionLocator: "orig", entryId: "a1a1a1a1" });
		expect(ref.parent_entry_id).toBeUndefined();
		expect(ref.turn_no).toBe(1);
	});

	test("every output passes parseTranscriptRef and carries no message content", () => {
		for (const entryId of ["a1a1a1a1", "a2a2a2a2", "a3a3a3a3", "b3b3b3b3", "a4a4a4a4", "a5a5a5a5"]) {
			const ref = ompTranscriptRef({ sessionFileText: original, sessionLocator: "orig", entryId });
			expect(parseTranscriptRef(ref)).toEqual(ref);
			expect(JSON.stringify(ref)).not.toContain("synthetic");
		}
	});

	test("the prefix digest ignores key order and whitespace but not content", () => {
		const base = ompTranscriptRef({ sessionFileText: original, sessionLocator: "orig", entryId: "a2a2a2a2" }).prefix_sha256;
		const entries = treeEntries();
		const reordered = JSON.stringify({ message: (entries[0] as Obj)["message"], parentId: null, id: "a1a1a1a1", timestamp: (entries[0] as Obj)["timestamp"], type: "message" }, null, 1).replace(/\n\s*/g, " ");
		const lines = original.split("\n");
		lines[2] = reordered;
		expect(ompTranscriptRef({ sessionFileText: lines.join("\n"), sessionLocator: "orig", entryId: "a2a2a2a2" }).prefix_sha256).toBe(base);
		const changed = original.replace("synthetic prompt one", "synthetic prompt 1");
		expect(ompTranscriptRef({ sessionFileText: changed, sessionLocator: "orig", entryId: "a2a2a2a2" }).prefix_sha256).not.toBe(base);
	});

	test("a late-usage marker as the last entry selects the leaf it captured", () => {
		const entries = [...treeEntries(), { type: "model_usage", id: "c1c1c1c1", parentId: "a5a5a5a5", timestamp: "t", activeLeafId: "b3b3b3b3" }];
		expect(ompTranscriptRef({ sessionFileText: build(entries), sessionLocator: "orig" }).entry_id).toBe("b3b3b3b3");
		const dangling = [...treeEntries(), { type: "model_usage", id: "c1c1c1c1", parentId: "a5a5a5a5", timestamp: "t", activeLeafId: "gone0000" }];
		expect(ompTranscriptRef({ sessionFileText: build(dangling), sessionLocator: "orig" }).entry_id).toBe("a5a5a5a5");
		const reset = [...treeEntries(), { type: "model_usage", id: "c1c1c1c1", parentId: "a5a5a5a5", timestamp: "t", activeLeafId: null }];
		expect(() => ompTranscriptRef({ sessionFileText: build(reset), sessionLocator: "orig" })).toThrow(OmpForkError);
	});

	test("throws typed errors: unknown entry, bad locator, bad version", () => {
		const code = (fn: () => unknown): string => {
			try {
				fn();
			} catch (error) {
				return error instanceof OmpForkError ? error.code : "other";
			}
			return "none";
		};
		expect(code(() => ompTranscriptRef({ sessionFileText: original, sessionLocator: "orig", entryId: "ffffffff" }))).toBe("entry-not-found");
		expect(code(() => ompTranscriptRef({ sessionFileText: original, sessionLocator: "/home/user/x.jsonl" }))).toBe("invalid-argument");
		expect(code(() => ompTranscriptRef({ sessionFileText: build(treeEntries(), { header: header({ version: 1 }) }), sessionLocator: "orig" }))).toBe("unsupported-version");
		expect(code(() => ompTranscriptRef({ sessionFileText: build([]), sessionLocator: "orig" }))).toBe("entry-not-found");
	});
});
