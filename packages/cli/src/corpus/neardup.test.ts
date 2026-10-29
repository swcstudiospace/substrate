/**
 * The candidates of `plan --neardup`: which planned documents are compared, in which order, how many, and what an excerpt is.
 * Pure over a hand-built inventory and an injected reader, so nothing touches the disk.
 */
import { describe, expect, test } from "bun:test";
import { CORPUS_PROTOCOL, MAX_NEARDUP_TEXT_CHARS, type CorpusEntry, type CorpusPlanResponse, type PlanItem } from "@substrate/corpus";
import { defined } from "../../../corpus/src/test-support.ts";
import type { Inventory } from "./inventory.ts";
import { excerptOf, neardupRequest, selectNeardupItems } from "./neardup.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function entry(repo: string, path: string, source: CorpusEntry["source"] = "fs"): CorpusEntry {
	return { repo, path, kind: "doc", tier: 1, sha256: "a".repeat(64), bytes: 1, source };
}

function inventoryOf(entries: CorpusEntry[], located: Record<string, string>): Inventory {
	return {
		entries,
		paths: new Map(Object.entries(located)),
		sources: ["fs"],
		maxTier: 2,
		scope: { coverage: [], maxTier: 2 },
		report: { checkouts: 0, repos: [], collapsed: { clones: 0, worktrees: 0, identical: 0, identicalGroups: 0, identicalCopies: [] }, skipped: [], skippedByReason: {}, emptyCollections: 0, notes: [] },
	};
}

function planOf(items: PlanItem[]): CorpusPlanResponse {
	return { protocol: CORPUS_PROTOCOL, items, counts: { add: 0, change: 0, update: 0, rename: 0, tombstone: 0, unchanged: 0 }, manifestVersion: 1 };
}

const item = (action: PlanItem["action"], repo: string, path: string): PlanItem => ({ action, repo, path });

describe("excerptOf", () => {
	test("is the whole text when it fits, a byte-order mark included", () => {
		expect(excerptOf(encode("# title\nbody"))).toBe("# title\nbody");
		expect(excerptOf(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))).toBe("\uFEFFa");
	});

	test("is cut to 4000 characters", () => {
		const text = excerptOf(encode("x".repeat(MAX_NEARDUP_TEXT_CHARS + 500)));
		expect(text).toHaveLength(MAX_NEARDUP_TEXT_CHARS);
	});

	test("replaces an invalid sequence instead of failing", () => {
		expect(excerptOf(Uint8Array.from([0x61, 0xff, 0x62]))).toBe("a\uFFFDb");
	});

	test("never leaves half of a surrogate pair at the cut", () => {
		// 3999 ASCII characters, then an astral character that would straddle the 4000-character cut.
		const text = excerptOf(encode(`${"x".repeat(MAX_NEARDUP_TEXT_CHARS - 1)}\u{1F600}tail`));
		expect(text).toBe("x".repeat(MAX_NEARDUP_TEXT_CHARS - 1));
		const last = text.charCodeAt(text.length - 1);
		expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
	});

	test("takes 4000 characters of multi-byte text from the first 16000 bytes, not the whole file", () => {
		// Each character is three bytes; the file is far longer than the excerpt needs.
		const text = excerptOf(encode("\u20AC".repeat(10_000)));
		expect(text).toBe("\u20AC".repeat(MAX_NEARDUP_TEXT_CHARS));
	});
});

describe("selectNeardupItems", () => {
	const reads: string[] = [];
	const readFile = (path: string): Uint8Array => {
		reads.push(path);
		if (path.includes("unreadable")) throw new Error("EACCES");
		return encode(`text of ${path}`);
	};

	test("takes add, update, change and rename in (repo, path) order and never a tombstone", () => {
		reads.length = 0;
		const entries = [entry("Acme/B", "b.md"), entry("Acme/A", "z.md"), entry("Acme/A", "a.md"), entry("Acme/A", "r.md"), entry("Acme/A", "u.md"), entry("Acme/A", "c.md")];
		const located = Object.fromEntries(entries.map((candidate) => [`${candidate.repo}:${candidate.path}`, `/disk/${candidate.repo}/${candidate.path}`]));
		const plan = planOf([item("add", "Acme/B", "b.md"), item("add", "Acme/A", "z.md"), item("add", "Acme/A", "a.md"), item("rename", "Acme/A", "r.md"), item("update", "Acme/A", "u.md"), item("change", "Acme/A", "c.md"), item("tombstone", "Acme/A", "gone.md")]);
		const selection = selectNeardupItems(plan, inventoryOf(entries, located), readFile, 1000);
		expect(selection.items.map((candidate) => `${candidate.repo}:${candidate.path}`)).toEqual(["Acme/A:a.md", "Acme/A:c.md", "Acme/A:r.md", "Acme/A:u.md", "Acme/A:z.md", "Acme/B:b.md"]);
		expect(defined(selection.items[0]).text).toBe("text of /disk/Acme/A/a.md");
		expect(selection).toMatchObject({ candidates: 6, overLimit: 0, github: 0, unreadable: 0 });
	});

	test("a GitHub document is counted and never read", () => {
		reads.length = 0;
		const entries = [entry("Acme/A", "a.md"), entry("Acme/G", "g.md", "github"), entry("Acme/G", "h.md", "github")];
		const plan = planOf(entries.map((candidate) => item("add", candidate.repo, candidate.path)));
		const selection = selectNeardupItems(plan, inventoryOf(entries, { "Acme/A:a.md": "/disk/a.md" }), readFile, 1000);
		expect(selection.items.map((candidate) => candidate.path)).toEqual(["a.md"]);
		expect(selection).toMatchObject({ github: 2, candidates: 1, unreadable: 0 });
		expect(reads).toEqual(["/disk/a.md"]);
	});

	test("a file that cannot be read is counted and skipped, and does not use up the limit", () => {
		reads.length = 0;
		const entries = [entry("Acme/A", "a.md"), entry("Acme/A", "b-unreadable.md"), entry("Acme/A", "c.md"), entry("Acme/A", "d.md")];
		const located = Object.fromEntries(entries.map((candidate) => [`${candidate.repo}:${candidate.path}`, `/disk/${candidate.path}`]));
		const plan = planOf(entries.map((candidate) => item("add", candidate.repo, candidate.path)));
		const selection = selectNeardupItems(plan, inventoryOf(entries, located), readFile, 2);
		expect(selection.items.map((candidate) => candidate.path)).toEqual(["a.md", "c.md"]);
		expect(selection).toMatchObject({ unreadable: 1, candidates: 4, overLimit: 1 });
		// The fourth file was never opened: the limit was reached first.
		expect(reads).toEqual(["/disk/a.md", "/disk/b-unreadable.md", "/disk/c.md"]);
	});

	test("the limit says how many candidates were left out", () => {
		const entries = Array.from({ length: 5 }, (_, index) => entry("Acme/A", `d${index}.md`));
		const located = Object.fromEntries(entries.map((candidate) => [`${candidate.repo}:${candidate.path}`, `/disk/${candidate.path}`]));
		const plan = planOf(entries.map((candidate) => item("add", candidate.repo, candidate.path)));
		const selection = selectNeardupItems(plan, inventoryOf(entries, located), readFile, 3);
		expect(selection.items).toHaveLength(3);
		expect(selection).toMatchObject({ candidates: 5, overLimit: 2 });
	});

	test("a planned document with no location, or none in the inventory, is counted as not read", () => {
		const entries = [entry("Acme/A", "a.md"), entry("Acme/A", "nowhere.md")];
		const plan = planOf([item("add", "Acme/A", "a.md"), item("add", "Acme/A", "nowhere.md"), item("add", "Acme/A", "unknown.md")]);
		const selection = selectNeardupItems(plan, inventoryOf(entries, { "Acme/A:a.md": "/disk/a.md" }), readFile, 1000);
		expect(selection.items.map((candidate) => candidate.path)).toEqual(["a.md"]);
		expect(selection.unreadable).toBe(2);
	});

	test("nothing planned to write leaves nothing to compare", () => {
		const selection = selectNeardupItems(planOf([item("tombstone", "Acme/A", "a.md")]), inventoryOf([entry("Acme/A", "b.md")], {}), readFile, 1000);
		expect(selection).toEqual({ items: [], candidates: 0, overLimit: 0, github: 0, unreadable: 0 });
	});
});

describe("neardupRequest", () => {
	test("leaves the threshold out when none was given, so the server's default applies", () => {
		expect(neardupRequest([], undefined)).toEqual({ protocol: CORPUS_PROTOCOL, items: [] });
		expect("threshold" in neardupRequest([], undefined)).toBe(false);
		expect(neardupRequest([], 0.8)).toEqual({ protocol: CORPUS_PROTOCOL, items: [], threshold: 0.8 });
	});
});
