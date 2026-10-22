/**
 * The planning diff: add, change and remove by path and hash only. It never carries text. A truncated side
 * never produces removals (or additions it cannot vouch for), and neither does a directory the walk could not list.
 */
import { describe, expect, test } from "bun:test";
import { diffPlanningIndex, type PlanningSnapshot } from "./diff.ts";
import { buildPlanningIndex, type PlanningIndexResult } from "./index.ts";
import { FakeTree, TREE_ROOT } from "./tree.fixtures.ts";

const H = (tag: string) => tag.repeat(64).slice(0, 64);
const whole = (records: PlanningSnapshot["records"]): PlanningSnapshot => ({ records, truncated: false, unlisted: [] });
const partial = (records: PlanningSnapshot["records"]): PlanningSnapshot => ({ records, truncated: true, unlisted: [] });

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
		const diff = diffPlanningIndex(whole(previous), whole(next));
		expect(diff).toEqual({
			complete: true,
			added: [".planning/new-a.md", ".planning/new-z.md"],
			removed: [".planning/old.md"],
			changed: [".planning/STATE.md"],
		});
		expect(Object.keys(diff).sort()).toEqual(["added", "changed", "complete", "removed"]);
	});

	test("identical hashes are not a change, whatever else differs", () => {
		const same = [{ path: ".planning/PROJECT.md", sha256: H("9") }];
		expect(diffPlanningIndex(whole(same), whole([...same]))).toEqual({ complete: true, added: [], removed: [], changed: [] });
	});

	test("a document that becomes unreadable (hash to null) is a change, and so is its recovery", () => {
		const readable = [{ path: ".planning/STATE.md", sha256: H("1") }];
		const unreadable = [{ path: ".planning/STATE.md", sha256: null }];
		expect(diffPlanningIndex(whole(readable), whole(unreadable)).changed).toEqual([".planning/STATE.md"]);
		expect(diffPlanningIndex(whole(unreadable), whole(readable)).changed).toEqual([".planning/STATE.md"]);
		expect(diffPlanningIndex(whole(unreadable), whole(unreadable)).changed).toEqual([]);
	});

	test("the inputs are not modified", () => {
		const previous = [{ path: ".planning/STATE.md", sha256: H("1") }];
		const next = [{ path: ".planning/STATE.md", sha256: H("2") }];
		diffPlanningIndex(whole(previous), whole(next));
		expect(previous).toEqual([{ path: ".planning/STATE.md", sha256: H("1") }]);
		expect(next).toEqual([{ path: ".planning/STATE.md", sha256: H("2") }]);
	});
});

describe("diffPlanningIndex with a truncated side", () => {
	test("a truncated next side reports no removals, so a path past its cutoff is not a false removal", () => {
		const previous = [
			{ path: ".planning/PROJECT.md", sha256: H("1") },
			{ path: ".planning/ROADMAP.md", sha256: H("2") },
		];
		// The next index was cut after PROJECT.md: ROADMAP.md exists, it is only beyond the cutoff.
		const next = [{ path: ".planning/PROJECT.md", sha256: H("1") }];
		const diff = diffPlanningIndex(whole(previous), partial(next));
		expect(diff.complete).toBe(false);
		expect(diff.removed).toBeNull();
		expect(diff.changed).toEqual([]);
	});

	test("a truncated previous side reports no removals and withholds additions it cannot vouch for", () => {
		const previous = [{ path: ".planning/PROJECT.md", sha256: H("1") }];
		// ROADMAP.md may have existed before, beyond the previous cutoff: it is not an addition.
		const next = [
			{ path: ".planning/PROJECT.md", sha256: H("9") },
			{ path: ".planning/ROADMAP.md", sha256: H("2") },
		];
		const diff = diffPlanningIndex(partial(previous), whole(next));
		expect(diff).toEqual({ complete: false, added: [], removed: null, changed: [".planning/PROJECT.md"] });
	});

	test("paths both sides hold are still compared when either side is truncated", () => {
		const previous = [{ path: ".planning/STATE.md", sha256: H("1") }];
		const next = [{ path: ".planning/STATE.md", sha256: H("2") }];
		expect(diffPlanningIndex(partial(previous), partial(next)).changed).toEqual([".planning/STATE.md"]);
	});

	test("with both sides complete, a real removal is reported again", () => {
		const previous = [{ path: ".planning/old.md", sha256: H("1") }];
		expect(diffPlanningIndex(whole(previous), whole([])).removed).toEqual([".planning/old.md"]);
	});
});

describe("diffPlanningIndex with an unlisted directory", () => {
	test("a document under a directory the next walk could not list is not reported as removed", () => {
		const previous = [
			{ path: ".planning/phases/52-x/PLAN.md", sha256: H("1") },
			{ path: ".planning/STATE.md", sha256: H("2") },
		];
		const next = [
			{ path: ".planning/phases/52-x", sha256: null },
			{ path: ".planning/STATE.md", sha256: H("2") },
		];
		const diff = diffPlanningIndex(whole(previous), { records: next, truncated: false, unlisted: [".planning/phases/52-x"] });
		expect(diff.removed).toEqual([]);
	});

	test("unreadable on the previous scan, readable with a new document now: the new document appears in added exactly once", async () => {
		const limits = { maxFiles: 500, maxBytes: 262_144 };
		const dir = `${TREE_ROOT}/.planning/phases/52-x`;
		const unreadable = new FakeTree({ [`${dir}/PLAN.md`]: "# plan\n" });
		unreadable.deniedListings.add(dir);
		const readable = new FakeTree({ [`${dir}/PLAN.md`]: "# plan\n", [`${dir}/NEW.md`]: "# new\n" });
		const before = await buildPlanningIndex(TREE_ROOT, { fs: unreadable, limits });
		const after = await buildPlanningIndex(TREE_ROOT, { fs: readable, limits });
		if (!before.ok || !after.ok) throw new Error("index failed");
		const diff = diffPlanningIndex(snapshotOf(before), snapshotOf(after));
		expect(diff.added).toEqual([".planning/phases/52-x/NEW.md", ".planning/phases/52-x/PLAN.md"]);
		expect(diff.complete).toBe(false);
	});

	test("a path that merely shares a prefix with an unlisted directory is still a removal", () => {
		const previous = [{ path: ".planning/phases/52-xy/PLAN.md", sha256: H("1") }];
		const diff = diffPlanningIndex(whole(previous), { records: [], truncated: false, unlisted: [".planning/phases/52-x"] });
		expect(diff.removed).toEqual([".planning/phases/52-xy/PLAN.md"]);
	});
});

describe("a failed directory read is unknown, never removed", () => {
	const limits = { maxFiles: 500, maxBytes: 262_144 };
	const P = `${TREE_ROOT}/.planning`;
	const DOCS = {
		[`${P}/STATE.md`]: "# state\n",
		[`${P}/phases/52-x/PLAN.md`]: "# plan\n",
		[`${P}/phases/52-x/CONTEXT.md`]: "# context\n",
	};

	test("an EACCES on a phase directory after a successful scan yields no removal records for its documents", async () => {
		const scanned = await buildPlanningIndex(TREE_ROOT, { fs: new FakeTree(DOCS), limits });
		const failing = new FakeTree(DOCS);
		failing.deniedListings.add(`${P}/phases/52-x`);
		const after = await buildPlanningIndex(TREE_ROOT, { fs: failing, limits });
		if (!scanned.ok || !after.ok) throw new Error("index failed");

		expect(after.index.unlisted).toEqual([".planning/phases/52-x"]);
		const diff = diffPlanningIndex(snapshotOf(scanned), snapshotOf(after));
		expect(diff.removed).toEqual([]);
		expect(diff.removed).not.toContain(".planning/phases/52-x/PLAN.md");
		expect(diff.removed).not.toContain(".planning/phases/52-x/CONTEXT.md");
	});
});

function snapshotOf(result: Extract<PlanningIndexResult, { ok: true }>): PlanningSnapshot {
	return { records: result.index.records, truncated: result.index.truncated, unlisted: result.index.unlisted };
}
