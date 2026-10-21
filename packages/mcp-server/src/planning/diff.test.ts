/**
 * The planning diff: add, change and remove by path and hash only. It never carries text.
 */
import { describe, expect, test } from "bun:test";
import { diffPlanningIndex } from "./diff.ts";

const H = (tag: string) => tag.repeat(64).slice(0, 64);

describe("diffPlanningIndex", () => {
	test("reports added, removed and changed paths, each sorted, and nothing else", () => {
		const previous = [
			{ path: ".planning/STATE.md", sha256: H("a") },
			{ path: ".planning/ROADMAP.md", sha256: H("b") },
			{ path: ".planning/old.md", sha256: H("c") },
		];
		const next = [
			{ path: ".planning/STATE.md", sha256: H("d") },
			{ path: ".planning/ROADMAP.md", sha256: H("b") },
			{ path: ".planning/new-z.md", sha256: H("e") },
			{ path: ".planning/new-a.md", sha256: H("f") },
		];
		const diff = diffPlanningIndex(previous, next);
		expect(diff).toEqual({
			added: [".planning/new-a.md", ".planning/new-z.md"],
			removed: [".planning/old.md"],
			changed: [".planning/STATE.md"],
		});
		expect(Object.keys(diff).sort()).toEqual(["added", "changed", "removed"]);
	});

	test("identical hashes are not a change, whatever else differs", () => {
		const same = [{ path: ".planning/PROJECT.md", sha256: H("9") }];
		expect(diffPlanningIndex(same, [...same])).toEqual({ added: [], removed: [], changed: [] });
	});

	test("a document that becomes unreadable (hash to null) is a change, and so is its recovery", () => {
		const readable = [{ path: ".planning/STATE.md", sha256: H("1") }];
		const unreadable = [{ path: ".planning/STATE.md", sha256: null }];
		expect(diffPlanningIndex(readable, unreadable).changed).toEqual([".planning/STATE.md"]);
		expect(diffPlanningIndex(unreadable, readable).changed).toEqual([".planning/STATE.md"]);
		expect(diffPlanningIndex(unreadable, unreadable).changed).toEqual([]);
	});

	test("the inputs are not modified", () => {
		const previous = [{ path: ".planning/STATE.md", sha256: H("1") }];
		const next = [{ path: ".planning/STATE.md", sha256: H("2") }];
		diffPlanningIndex(previous, next);
		expect(previous).toEqual([{ path: ".planning/STATE.md", sha256: H("1") }]);
		expect(next).toEqual([{ path: ".planning/STATE.md", sha256: H("2") }]);
	});
});
