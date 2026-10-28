/**
 * The planning index over an in-memory tree: keyed by content hash, determinism, an incremental update that equals a full
 * rebuild, one error record per bad path with the rest of the index intact, refusal of anything that resolves outside the
 * root, and bounds.
 */
import { describe, expect, test } from "bun:test";
import {
	PROBE_CONCURRENCY,
	buildPlanningIndex,
	indexRecords,
	isErrorRecord,
	mapBounded,
	positionOf,
	readFrontmatter,
	snapshotOf,
	updatePlanningIndex,
	type PlanningIndex,
	type PlanningIndexResult,
	type PlanningRecord,
} from "./index.ts";
import { FakeTree, TREE_ROOT } from "./tree.fixtures.ts";

const P = `${TREE_ROOT}/.planning`;
const PHASE = `${P}/phases/52-planning-awareness-core`;
const SECRET_BODY = "BODY-MARKER-roadmap-only";

const BASE: Record<string, string | Uint8Array> = {
	[`${P}/ROADMAP.md`]: `---\nphase: roadmap\n---\n\n# Roadmap\n${SECRET_BODY}\n`,
	[`${P}/STATE.md`]: "# State\n",
	[`${P}/PROJECT.md`]: "# Project\n",
	[`${P}/config.json`]: "{}",
	[`${P}/milestones/v15.md`]: "# v15\n",
	[`${PHASE}/52-01-PLAN.md`]: "---\nphase: 52\nrequirements: [SOTA-08]\n---\n# Plan\n",
	[`${PHASE}/CONTEXT.md`]: "# Context\n",
	[`${P}/phases/50-dragonfly-pubsub/PLAN.md`]: "# 50 plan\n",
	[`${P}/phases/50-dragonfly-pubsub/notes.txt`]: "not indexed",
	[`${P}/phases/50-dragonfly-pubsub/deep/nested.md`]: "not indexed: nested",
};

const ALL_PATHS = [
	".planning/PROJECT.md",
	".planning/ROADMAP.md",
	".planning/STATE.md",
	".planning/config.json",
	".planning/milestones/v15.md",
	".planning/phases/50-dragonfly-pubsub/PLAN.md",
	".planning/phases/52-planning-awareness-core/52-01-PLAN.md",
	".planning/phases/52-planning-awareness-core/CONTEXT.md",
];

const LIMITS = { maxFiles: 500, maxBytes: 262_144 };

async function build(files: Record<string, string | Uint8Array>, links: Record<string, string> = {}, limits = LIMITS): Promise<{ result: PlanningIndexResult; tree: FakeTree }> {
	const tree = new FakeTree(files, links);
	return { result: await buildPlanningIndex(TREE_ROOT, { fs: tree, limits }), tree };
}

async function indexOf(files: Record<string, string | Uint8Array>, links: Record<string, string> = {}, limits = LIMITS): Promise<{ index: PlanningIndex; tree: FakeTree }> {
	const { result, tree } = await build(files, links, limits);
	if (!result.ok) throw new Error(`index failed: ${result.code}`);
	return { index: result.index, tree };
}

function errorFor(records: PlanningRecord[], path: string) {
	const found = records.filter((record) => record.path === path && isErrorRecord(record));
	expect(found).toHaveLength(1);
	return found[0];
}

describe("buildPlanningIndex: determinism and shape", () => {
	test("the same files give identical indexes, and records come out in path order on every build", async () => {
		const first = (await indexOf(BASE)).index;
		const second = (await indexOf(BASE)).index;
		expect(second).toEqual(first);
		expect(indexRecords(first).map((record) => record.path)).toEqual(ALL_PATHS);
		expect(first.truncated).toBe(false);
	});

	test("each record carries the hash and size of its bytes", async () => {
		const { index } = await indexOf(BASE);
		const state = indexRecords(index).find((record) => record.path === ".planning/STATE.md");
		expect(state).toMatchObject({ kind: "state", bytes: "# State\n".length });
		expect(state && !isErrorRecord(state) ? state.sha256 : "").toMatch(/^[0-9a-f]{64}$/);
	});

	test("phase and plan come from the phase directory and file name, frontmatter is parsed", async () => {
		const { index } = await indexOf(BASE);
		const records = indexRecords(index);
		const plan = records.find((record) => record.path.endsWith("52-01-PLAN.md"));
		const context = records.find((record) => record.path.endsWith("CONTEXT.md"));
		expect(plan).toMatchObject({ kind: "phase", phase: "52", plan: "52-01-PLAN", frontmatter: { phase: 52, requirements: ["SOTA-08"] } });
		expect(context).toMatchObject({ kind: "phase", phase: "52" });
		expect(context && "plan" in context).toBe(false);
	});

	test("frontmatter cannot move a document to another phase: a phase 52 directory decides, whatever its frontmatter says", async () => {
		const path = ".planning/phases/52-planning-awareness-core/52-02-PLAN.md";
		const { index } = await indexOf({ ...BASE, [`${PHASE}/52-02-PLAN.md`]: "---\nphase: 53\n---\n# Plan\n" });
		const record = indexRecords(index).find((entry) => entry.path === path);
		expect(record).toMatchObject({ kind: "phase", phase: "52", frontmatter: { phase: 53 } });
	});

	test("no file body reaches the index: the marker in ROADMAP's body is absent from the whole index", async () => {
		const { index } = await indexOf(BASE);
		expect(JSON.stringify(index)).not.toContain(SECRET_BODY);
	});

	test("only the documents the plane names are indexed: nested and non-markdown files are skipped", async () => {
		const { index } = await indexOf(BASE);
		const paths = indexRecords(index).map((record) => record.path);
		expect(paths).not.toContain(".planning/phases/50-dragonfly-pubsub/notes.txt");
		expect(paths).not.toContain(".planning/phases/50-dragonfly-pubsub/deep/nested.md");
	});
});

describe("buildPlanningIndex: keyed by content hash", () => {
	test("identical bytes at two paths share one content entry, and the entry lists both paths", async () => {
		const same = "# the same body\n";
		const dir = `${P}/phases/50-dragonfly-pubsub`;
		const { index } = await indexOf({ ...BASE, [`${dir}/COPY.md`]: same, [`${dir}/ORIGINAL.md`]: same });
		const copy = index.documents[".planning/phases/50-dragonfly-pubsub/COPY.md"];
		const original = index.documents[".planning/phases/50-dragonfly-pubsub/ORIGINAL.md"];
		expect(copy?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(original?.sha256).toBe(copy?.sha256 ?? "");
		expect(index.contents[copy?.sha256 ?? ""]).toMatchObject({
			bytes: same.length,
			paths: [".planning/phases/50-dragonfly-pubsub/COPY.md", ".planning/phases/50-dragonfly-pubsub/ORIGINAL.md"],
		});
		const distinct = new Set(Object.values(index.documents).map((document) => document.sha256)).size;
		expect(Object.keys(index.contents)).toHaveLength(distinct);
	});

	test("every document references a content entry, and every content entry is referenced by a document", async () => {
		const { index } = await indexOf(BASE);
		for (const document of Object.values(index.documents)) expect(index.contents[document.sha256]).toBeDefined();
		const referenced = Object.values(index.contents).flatMap((content) => content.paths);
		expect([...referenced].sort()).toEqual(Object.keys(index.documents).sort());
	});
});

describe("updatePlanningIndex: an incremental update equals a full rebuild", () => {
	async function fullOf(tree: FakeTree, limits = LIMITS): Promise<PlanningIndex> {
		const full = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits });
		if (!full.ok) throw new Error(full.code);
		return full.index;
	}

	async function updatedFrom(tree: FakeTree, previous: PlanningIndex, limits = LIMITS): Promise<PlanningIndex> {
		const updated = await updatePlanningIndex(TREE_ROOT, { fs: tree, limits }, previous);
		if (!updated.ok) throw new Error(updated.code);
		return updated.index;
	}

	test("after an add, an edit and a delete, the incremental result equals the full rebuild each time", async () => {
		const tree = new FakeTree(BASE);
		let index = await fullOf(tree);

		tree.setContent(`${PHASE}/52-02-PLAN.md`, "# a new plan\n");
		index = await updatedFrom(tree, index);
		expect(index).toEqual(await fullOf(tree));
		expect(indexRecords(index).map((record) => record.path)).toContain(".planning/phases/52-planning-awareness-core/52-02-PLAN.md");

		tree.setContent(`${P}/STATE.md`, "# State, edited\n");
		index = await updatedFrom(tree, index);
		expect(index).toEqual(await fullOf(tree));

		tree.remove(`${PHASE}/CONTEXT.md`);
		index = await updatedFrom(tree, index);
		expect(index).toEqual(await fullOf(tree));
		expect(indexRecords(index).map((record) => record.path)).not.toContain(".planning/phases/52-planning-awareness-core/CONTEXT.md");
	});

	test("an update reads and hashes only the documents that changed", async () => {
		const tree = new FakeTree(BASE);
		const first = await fullOf(tree);
		tree.returnedFrom.splice(0);
		tree.setContent(`${P}/STATE.md`, "# State, edited\n");
		await updatedFrom(tree, first);
		expect(tree.returnedFrom).toEqual([`${P}/STATE.md`]);
	});

	test("an unchanged tree is an update that reads no document bytes at all", async () => {
		const tree = new FakeTree(BASE);
		const first = await fullOf(tree);
		tree.returnedFrom.splice(0);
		expect(await updatedFrom(tree, first)).toEqual(first);
		expect(tree.returnedFrom).toEqual([]);
	});

	test("a lower maxBytes applies to a reused document as it would in a full rebuild", async () => {
		const tree = new FakeTree({ ...BASE, [`${PHASE}/CONTEXT.md`]: "x".repeat(2_000) });
		const first = await fullOf(tree);
		const lowered = { maxFiles: 500, maxBytes: 1_024 };
		const updated = await updatedFrom(tree, first, lowered);
		expect(updated).toEqual(await fullOf(tree, lowered));
		expect(updated.errors[".planning/phases/52-planning-awareness-core/CONTEXT.md"]).toMatchObject({ error: { code: "too-large" } });
	});

	test("an in-root link repointed at another file is read again by an incremental update, and equals a full rebuild", async () => {
		const alias = `${P}/phases/50-dragonfly-pubsub/alias.md`;
		const links: Record<string, string> = { [alias]: `${P}/STATE.md` };
		const tree = new FakeTree(BASE, links);
		const first = await fullOf(tree);
		expect(first.documents[".planning/phases/50-dragonfly-pubsub/alias.md"]?.sha256).toBe(first.documents[".planning/STATE.md"]?.sha256);

		links[alias] = `${P}/ROADMAP.md`;
		const updated = await updatedFrom(tree, first);
		expect(updated).toEqual(await fullOf(tree));
		expect(updated.documents[".planning/phases/50-dragonfly-pubsub/alias.md"]?.sha256).toBe(updated.documents[".planning/ROADMAP.md"]?.sha256);
	});
});

describe("buildPlanningIndex: one bad path never breaks the rest", () => {
	test("malformed frontmatter yields exactly one error record, and every other record is unchanged", async () => {
		const baseline = indexRecords((await indexOf(BASE)).index);
		const broken = { ...BASE, [`${PHASE}/CONTEXT.md`]: "---\nphase: 52\n# Context with no closing fence\n" };
		const { index } = await indexOf(broken);

		const error = errorFor(indexRecords(index), ".planning/phases/52-planning-awareness-core/CONTEXT.md");
		expect(error).toMatchObject({ error: { code: "malformed-frontmatter" }, kind: "phase" });
		expect(error && error.sha256).toMatch(/^[0-9a-f]{64}$/);
		const others = (records: PlanningRecord[]) => records.filter((record) => !record.path.endsWith("CONTEXT.md"));
		expect(others(indexRecords(index))).toEqual(others(baseline));
	});

	test("an unreadable file yields one error record with a code, and the rest of the index is intact", async () => {
		const baseline = indexRecords((await indexOf(BASE)).index);
		const tree = new FakeTree(BASE);
		tree.denied.add(`${P}/STATE.md`);
		const index = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: LIMITS });
		if (!index.ok) throw new Error(index.code);

		const error = errorFor(indexRecords(index.index), ".planning/STATE.md");
		expect(error).toMatchObject({ error: { code: "unreadable", detail: "open failed: EACCES" }, sha256: null });
		const others = (records: PlanningRecord[]) => records.filter((record) => record.path !== ".planning/STATE.md");
		expect(others(indexRecords(index.index))).toEqual(others(baseline));
		expect(tree.reads).toContain(`${P}/STATE.md`);
	});

	test("a document that is not valid UTF-8 keeps its hash and is an unreadable error record", async () => {
		const { index } = await indexOf({ ...BASE, [`${P}/phases/50-dragonfly-pubsub/bad.md`]: new Uint8Array([0xff, 0xfe, 0x00]) });
		expect(errorFor(indexRecords(index), ".planning/phases/50-dragonfly-pubsub/bad.md")).toMatchObject({
			error: { code: "unreadable", detail: "not valid UTF-8" },
			bytes: 3,
		});
	});

	test("a dangling symlink is an unreadable error record for its path", async () => {
		const { index } = await indexOf(BASE, { [`${P}/phases/50-dragonfly-pubsub/gone.md`]: `${TREE_ROOT}/nowhere.md` });
		expect(errorFor(indexRecords(index), ".planning/phases/50-dragonfly-pubsub/gone.md")).toMatchObject({
			error: { code: "unreadable", detail: "dangling symlink" },
		});
	});
});

describe("buildPlanningIndex: refuses anything that resolves outside the root", () => {
	test("a file symlink to a file outside the root is an error record, and its bytes are never returned", async () => {
		const leak = `${PHASE}/leak.md`;
		const { index, tree } = await indexOf({ ...BASE, "/outside/secret.md": "OUTSIDE-SECRET-TEXT" }, { [leak]: "/outside/secret.md" });
		expect(errorFor(indexRecords(index), ".planning/phases/52-planning-awareness-core/leak.md")).toMatchObject({
			error: { code: "outside-root" },
			sha256: null,
		});
		expect(JSON.stringify(index)).not.toContain("OUTSIDE-SECRET-TEXT");
		expect(tree.returnedFrom).not.toContain("/outside/secret.md");
	});

	test("a document swapped for an outside link after it was listed is refused, and no outside byte is returned", async () => {
		const swapped = `${PHASE}/swap.md`;
		const links: Record<string, string> = { [swapped]: `${P}/STATE.md` };
		const tree = new FakeTree({ ...BASE, "/outside/secret.md": "OUTSIDE-SWAP-TEXT" }, links);
		// Listed as an in-root alias; the link is repointed at the outside file before it is opened.
		tree.beforeOpen = (path) => {
			if (path === swapped) links[swapped] = "/outside/secret.md";
		};
		const result = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: { maxFiles: 500, maxBytes: 262_144 } });
		if (!result.ok) throw new Error(result.code);
		expect(errorFor(indexRecords(result.index), ".planning/phases/52-planning-awareness-core/swap.md")).toMatchObject({ error: { code: "outside-root" } });
		expect(tree.returnedFrom).not.toContain("/outside/secret.md");
		expect(JSON.stringify(result.index)).not.toContain("OUTSIDE-SWAP-TEXT");
	});

	test("a directory symlink that leaves the root is an error record for the directory, and nothing under it is listed", async () => {
		const { index, tree } = await indexOf({ ...BASE, "/outside/milestones/x.md": "OUTSIDE-MILESTONE" }, { [`${P}/milestones`]: "/outside/milestones" });
		expect(errorFor(indexRecords(index), ".planning/milestones")).toMatchObject({ error: { code: "outside-root" } });
		expect(indexRecords(index).map((record) => record.path)).not.toContain(".planning/milestones/x.md");
		expect(tree.reads.some((path) => path.includes("milestones"))).toBe(false);
	});

	test("a .planning directory that resolves outside the root is refused as a whole", async () => {
		const { result } = await build({ "/outside/planning/ROADMAP.md": "# x" }, { [P]: "/outside/planning" });
		expect(result).toEqual({ ok: false, code: "planning-dir-outside-root" });
	});

	test("a symlink that stays inside the root is followed, and its content is indexed", async () => {
		const { index } = await indexOf(BASE, { [`${P}/phases/50-dragonfly-pubsub/alias.md`]: `${P}/STATE.md` });
		const alias = indexRecords(index).find((record) => record.path.endsWith("alias.md"));
		const state = indexRecords(index).find((record) => record.path === ".planning/STATE.md");
		const aliasSha = alias && !isErrorRecord(alias) ? alias.sha256 : null;
		const stateSha = state && !isErrorRecord(state) ? state.sha256 : null;
		expect(stateSha).not.toBeNull();
		expect(aliasSha).toBe(stateSha);
	});
});

describe("buildPlanningIndex: bounds", () => {
	test("a document over maxBytes is a too-large error record, and no more than maxBytes + 1 bytes are ever read", async () => {
		const big = `${P}/phases/50-dragonfly-pubsub/big.md`;
		const tree = new FakeTree({ ...BASE, [big]: "x".repeat(10_000) });
		const result = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: { maxFiles: 500, maxBytes: 1_024 } });
		if (!result.ok) throw new Error(result.code);
		// No byte count: the file was not read to its end, so its size is not known.
		expect(errorFor(indexRecords(result.index), ".planning/phases/50-dragonfly-pubsub/big.md")).toMatchObject({
			error: { code: "too-large" },
			bytes: null,
			sha256: null,
		});
		expect(tree.largestReturned).toBe(1_025);
	});

	test("a file that grows past the cap is cut off at the cap, whatever its size on the disk now", async () => {
		const grows = `${PHASE}/CONTEXT.md`;
		const tree = new FakeTree({ ...BASE, [grows]: "a".repeat(50) }, {});
		// The file grows between being listed and being opened.
		tree.beforeOpen = (path) => {
			if (path === grows) tree.setContent(grows, "b".repeat(5_000));
		};
		const result = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: { maxFiles: 500, maxBytes: 1_024 } });
		if (!result.ok) throw new Error(result.code);
		expect(errorFor(indexRecords(result.index), ".planning/phases/52-planning-awareness-core/CONTEXT.md")).toMatchObject({ error: { code: "too-large" } });
		expect(tree.largestReturned).toBe(1_025);
	});

	test("more documents than maxFiles keeps the first by path and sets truncated", async () => {
		const { index } = await indexOf(BASE, {}, { maxFiles: 3, maxBytes: 262_144 });
		expect(index.truncated).toBe(true);
		expect(indexRecords(index).map((record) => record.path)).toEqual(ALL_PATHS.slice(0, 3));
	});

	test("collection stops once maxFiles + 1 candidates are held, so a later document is never read", async () => {
		const tree = new FakeTree({
			[`${P}/phases/01-a/one.md`]: "# one",
			[`${P}/phases/01-a/two.md`]: "# two",
			[`${P}/phases/02-b/three.md`]: "# three",
			[`${P}/phases/03-c/four.md`]: "# four",
		});
		const result = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: { maxFiles: 2, maxBytes: 262_144 } });
		if (!result.ok) throw new Error(result.code);
		expect(result.index.truncated).toBe(true);
		expect(indexRecords(result.index).map((record) => record.path)).toEqual([".planning/phases/01-a/one.md", ".planning/phases/01-a/two.md"]);
		expect(tree.reads).not.toContain(`${P}/phases/03-c/four.md`);
		expect(tree.reads).not.toContain(`${P}/phases/02-b/three.md`);
	});

	test("records come out in path order, including where one directory name is a prefix of another", async () => {
		const { index } = await indexOf({ [`${P}/phases/52-a/PLAN.md`]: "# a", [`${P}/phases/52-a-b/PLAN.md`]: "# ab" });
		expect(indexRecords(index).map((record) => record.path)).toEqual([".planning/phases/52-a-b/PLAN.md", ".planning/phases/52-a/PLAN.md"]);
	});

	test("a non-positive limit is refused as a programming error", async () => {
		await expect(build(BASE, {}, { maxFiles: 0, maxBytes: 1 })).rejects.toThrow(RangeError);
	});
});

describe("buildPlanningIndex: missing roots", () => {
	test("a root that does not exist is root-unavailable", async () => {
		const { result } = await build({ "/elsewhere/x.md": "x" });
		expect(result).toEqual({ ok: false, code: "root-unavailable" });
	});

	test("a root without a .planning directory is planning-dir-unavailable", async () => {
		const { result } = await build({ [`${TREE_ROOT}/README.md`]: "x" });
		expect(result).toEqual({ ok: false, code: "planning-dir-unavailable" });
	});
});

describe("buildPlanningIndex: a dangling link is reported, never skipped", () => {
	test("a dangling top-level document is an error record, and the rest of the index is intact", async () => {
		const baseline = indexRecords((await indexOf(BASE)).index);
		const { index } = await indexOf(BASE, { [`${P}/ROADMAP.md`]: `${TREE_ROOT}/nowhere.md` });
		expect(errorFor(indexRecords(index), ".planning/ROADMAP.md")).toMatchObject({
			kind: "roadmap",
			error: { code: "unreadable", detail: "dangling symlink" },
		});
		const others = (records: PlanningRecord[]) => records.filter((record) => record.path !== ".planning/ROADMAP.md");
		expect(others(indexRecords(index))).toEqual(others(baseline));
	});

	test("a dangling phase directory is an error record for that directory", async () => {
		const { index } = await indexOf(BASE, { [`${P}/phases/53-gone`]: `${TREE_ROOT}/nowhere` });
		expect(errorFor(indexRecords(index), ".planning/phases/53-gone")).toMatchObject({ error: { code: "unreadable", detail: "dangling symlink" } });
	});

	test("a dangling .planning is a failure with its own code, never an empty index", async () => {
		const { result } = await build({ [`${TREE_ROOT}/README.md`]: "x" }, { [P]: `${TREE_ROOT}/nowhere` });
		expect(result).toEqual({ ok: false, code: "planning-dir-dangling" });
	});

	test("a milestones entry that is a plain file is an error record, not silently empty", async () => {
		const { index } = await indexOf({ [`${TREE_ROOT}/README.md`]: "x", [`${P}/ROADMAP.md`]: "# r", [`${P}/milestones`]: "not a directory" });
		expect(errorFor(indexRecords(index), ".planning/milestones")).toMatchObject({ error: { code: "unreadable", detail: "not a directory" } });
	});
});

describe("buildPlanningIndex: directory errors keep path order under a cutoff", () => {
	test("a phase link that leaves the root is emitted at its own path, before a later sibling's documents, so maxFiles 1 keeps it", async () => {
		const files = { [`${P}/phases/52-a-b/PLAN.md`]: "# ab", "/outside/phase-a/PLAN.md": "OUTSIDE-PHASE" };
		const links = { [`${P}/phases/52-a`]: "/outside/phase-a" };
		const all = await buildPlanningIndex(TREE_ROOT, { fs: new FakeTree(files, links), limits: { maxFiles: 500, maxBytes: 262_144 } });
		if (!all.ok) throw new Error(all.code);
		expect(indexRecords(all.index).map((record) => record.path)).toEqual([".planning/phases/52-a", ".planning/phases/52-a-b/PLAN.md"]);

		const cut = await buildPlanningIndex(TREE_ROOT, { fs: new FakeTree(files, links), limits: { maxFiles: 1, maxBytes: 262_144 } });
		if (!cut.ok) throw new Error(cut.code);
		expect(cut.index.truncated).toBe(true);
		const cutRecords = indexRecords(cut.index);
		expect(cutRecords).toHaveLength(1);
		expect(cutRecords[0]).toMatchObject({ path: ".planning/phases/52-a", error: { code: "outside-root" } });
		expect(JSON.stringify(cut.index)).not.toContain("OUTSIDE-PHASE");
	});
});

describe("a failed listing sorts at its own path", () => {
	const files = { [`${P}/phases/52-a/PLAN.md`]: "# a", [`${P}/phases/52-a-b/PLAN.md`]: "# ab" };
	const failingListing = (): FakeTree => {
		const tree = new FakeTree(files);
		tree.deniedListings.add(`${P}/phases/52-a`);
		return tree;
	};

	test("52-a fails to list: under maxFiles 1 its error stays first, ahead of the later sibling's document", async () => {
		const cut = await buildPlanningIndex(TREE_ROOT, { fs: failingListing(), limits: { maxFiles: 1, maxBytes: 262_144 } });
		if (!cut.ok) throw new Error(cut.code);
		expect(cut.index.truncated).toBe(true);
		const records = indexRecords(cut.index);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ path: ".planning/phases/52-a", error: { code: "unreadable", detail: "read failed: EACCES" } });
	});

	test("with room for both, the error comes before the sibling's document", async () => {
		const all = await buildPlanningIndex(TREE_ROOT, { fs: failingListing(), limits: { maxFiles: 500, maxBytes: 262_144 } });
		if (!all.ok) throw new Error(all.code);
		expect(indexRecords(all.index).map((record) => record.path)).toEqual([".planning/phases/52-a", ".planning/phases/52-a-b/PLAN.md"]);
	});
});

describe("bounded fan-out", () => {
	test("mapBounded never has more than the limit in flight, and returns results in input order", async () => {
		let inFlight = 0;
		let most = 0;
		const doubled = await mapBounded([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (value) => {
			inFlight += 1;
			most = Math.max(most, inFlight);
			await Promise.resolve();
			await Promise.resolve();
			inFlight -= 1;
			return value * 2;
		});
		expect(doubled).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
		expect(most).toBe(3);
	});

	test("mapBounded refuses a non-positive limit", async () => {
		await expect(mapBounded([1], 0, async (value) => value)).rejects.toThrow(RangeError);
	});

	test("phase children are resolved with at most PROBE_CONCURRENCY probes in flight, observed through the fs", async () => {
		const files: Record<string, string> = {};
		for (let n = 0; n < 12; n += 1) files[`${P}/phases/${String(n).padStart(2, "0")}-x/PLAN.md`] = "# p";
		const tree = new FakeTree(files);
		const result = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: { maxFiles: 500, maxBytes: 262_144 } });
		if (!result.ok) throw new Error(result.code);
		expect(indexRecords(result.index)).toHaveLength(12);
		expect(tree.maxProbesInFlight).toBe(PROBE_CONCURRENCY);
	});

	test("with maxFiles 1 the walk lists at most one batch of phase directories, observed through the fs", async () => {
		const files: Record<string, string> = {};
		for (let n = 0; n < 12; n += 1) files[`${P}/phases/${String(n).padStart(2, "0")}-x/PLAN.md`] = "# p";
		const tree = new FakeTree(files);
		const result = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: { maxFiles: 1, maxBytes: 262_144 } });
		if (!result.ok) throw new Error(result.code);
		expect(result.index.truncated).toBe(true);
		expect(indexRecords(result.index).map((record) => record.path)).toEqual([".planning/phases/00-x/PLAN.md"]);
		// The phases listing, then one batch of PROBE_CONCURRENCY directories (listed during resolution). Nothing past the batch is listed.
		expect(tree.listed.filter((path) => path.startsWith(`${P}/phases`))).toEqual([`${P}/phases`, `${P}/phases/00-x`, `${P}/phases/01-x`, `${P}/phases/02-x`, `${P}/phases/03-x`]);
	});
});

describe("phase probes stop at the cutoff", () => {
	test("with maxFiles 1, phase children stop being probed once the cutoff is reached", async () => {
		const files: Record<string, string> = {};
		for (let n = 0; n < 12; n += 1) files[`${P}/phases/${String(n).padStart(2, "0")}-x/PLAN.md`] = "# p";
		const tree = new FakeTree(files);
		const result = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: { maxFiles: 1, maxBytes: 262_144 } });
		if (!result.ok) throw new Error(result.code);
		expect(indexRecords(result.index).map((record) => record.path)).toEqual([".planning/phases/00-x/PLAN.md"]);
		// One batch of PROBE_CONCURRENCY children is resolved; the first batch already fills the cap, so no later child is probed.
		const childProbes = tree.probed.filter((path) => path.startsWith(`${P}/phases/`));
		expect(childProbes.length).toBeLessThanOrEqual(PROBE_CONCURRENCY);
		expect(childProbes.length).toBeLessThan(12);
	});

	test("the batch that does not fill the cap is followed by the next batch, still in path order", async () => {
		const files: Record<string, string> = {};
		for (let n = 0; n < 12; n += 1) files[`${P}/phases/${String(n).padStart(2, "0")}-x/PLAN.md`] = "# p";
		const tree = new FakeTree(files);
		const result = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: { maxFiles: 6, maxBytes: 262_144 } });
		if (!result.ok) throw new Error(result.code);
		expect(indexRecords(result.index).map((record) => record.path)).toEqual([
			".planning/phases/00-x/PLAN.md",
			".planning/phases/01-x/PLAN.md",
			".planning/phases/02-x/PLAN.md",
			".planning/phases/03-x/PLAN.md",
			".planning/phases/04-x/PLAN.md",
			".planning/phases/05-x/PLAN.md",
		]);
		expect(tree.probed.filter((path) => path.startsWith(`${P}/phases/`)).length).toBeLessThan(12);
	});
});

describe("symlinked documents are probed only as far as the cutoff", () => {
	test("with maxFiles 2, twenty symlinked documents are probed no further than the cutoff needs", async () => {
		const links: Record<string, string> = {};
		for (let n = 0; n < 20; n += 1) links[`${P}/phases/52-x/doc-${String(n).padStart(2, "0")}.md`] = `${P}/STATE.md`;
		const tree = new FakeTree({ [`${P}/STATE.md`]: "# state\n" }, links);
		const result = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: { maxFiles: 2, maxBytes: 262_144 } });
		if (!result.ok) throw new Error(result.code);
		expect(result.index.truncated).toBe(true);
		expect(indexRecords(result.index)).toHaveLength(2);
		// Each link is probed as a candidate, and collection stops at maxFiles + 1 candidates: three probes, not twenty.
		expect(tree.probed.filter((path) => path.startsWith(`${P}/phases/52-x/doc-`)).length).toBeLessThanOrEqual(3);
	});
});

describe("snapshotOf", () => {
	test("gives the diff each record's path and hash, with the truncation and unlisted directories", async () => {
		const { index } = await indexOf(BASE);
		const snapshot = snapshotOf(index);
		expect(snapshot.records.map((record) => record.path)).toEqual(ALL_PATHS);
		expect(snapshot).toMatchObject({ truncated: false, unlisted: [] });
		expect(snapshot.records.every((record) => record.sha256 !== null)).toBe(true);
	});
});

describe("readFrontmatter", () => {
	test("no fence is none, a closed mapping is parsed, an open fence without a mapping is malformed", () => {
		expect(readFrontmatter("# plain")).toEqual({ state: "none" });
		expect(readFrontmatter("---\nphase: 52\n---\n# x")).toEqual({ state: "parsed", data: { phase: 52 } });
		expect(readFrontmatter("---\nphase: 52\n")).toEqual({ state: "malformed" });
	});

	test("trailing spaces or tabs after the opening fence are part of the fence, not the YAML", () => {
		expect(readFrontmatter("---  \nphase: 52\n---\n# x")).toEqual({ state: "parsed", data: { phase: 52 } });
		expect(readFrontmatter("---\t\nphase: 52\n---\n# x")).toEqual({ state: "parsed", data: { phase: 52 } });
		expect(readFrontmatter("---  \r\nphase: 52\r\n---\r\n# x")).toEqual({ state: "parsed", data: { phase: 52 } });
	});

	test("trailing whitespace does not rescue an unclosed fence", () => {
		expect(readFrontmatter("---  \nphase: 52\n")).toEqual({ state: "malformed" });
	});
});

describe("positionOf: the GSD-Core position from the scan that built the index", () => {
	const STATE_BODY_MARKER = "BODY-MARKER-state-only";
	const POSITION_STATE = `---
milestone: v1.6
milestone_name: Live steering
status: executing
stopped_at: "58-02-PLAN step 1"
current_phase: 58
current_phase_name: live-session-steering
---

# State

## Current

${STATE_BODY_MARKER}

## Current Position

Phase: 58 — Live session steering
Plan: 58-02-PLAN
Status: Executing
`;
	const POSITION_ROADMAP = `# Roadmap

## Phase Details

### Phase 58: Live session steering

**Status**: In progress

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 57. Tandem memory | v1.6 | 1/1 | Complete | 2026-10-26 |
| 58. Live session steering | v1.6 | 1/2 | In progress | - |
`;
	const POSITION_FILES: Record<string, string> = {
		[`${P}/STATE.md`]: POSITION_STATE,
		[`${P}/ROADMAP.md`]: POSITION_ROADMAP,
		[`${P}/phases/58-live-session-steering/58-01-PLAN.md`]: "# plan 1\n",
		[`${P}/phases/58-live-session-steering/58-01-SUMMARY.md`]: "# summary 1\n",
	};
	const EXPECTED = {
		errors: [],
		ok: true,
		position: {
			milestone: "v1.6",
			milestone_name: "Live steering",
			phase: { name: "Live session steering", number: "58", slug: "live-session-steering" },
			plan: "58-02-PLAN",
			progress: { phases_done: 1, phases_total: 2 },
			status: "executing",
			step: "58-02-PLAN step 1",
		},
	};

	test("a tree's STATE.md, ROADMAP.md, phase directories and plan files give the exact position", async () => {
		const { index } = await indexOf(POSITION_FILES);
		expect(positionOf(index)).toEqual(EXPECTED);
	});

	test("the plan comes from the files when the state has no Plan line: the first plan without a summary", async () => {
		const state = POSITION_STATE.replace("Plan: 58-02-PLAN\n", "").replace("## Current Position", "## Not The Position");
		const files = { ...POSITION_FILES, [`${P}/STATE.md`]: state, [`${P}/phases/58-live-session-steering/58-02-PLAN.md`]: "# plan 2\n" };
		const { index } = await indexOf(files);
		expect(positionOf(index).position.plan).toBe("58-02-PLAN");
	});

	test("the position adds no file text to the index: the state's body marker is absent from the whole index", async () => {
		const { index } = await indexOf(POSITION_FILES);
		expect(JSON.stringify(index)).not.toContain(STATE_BODY_MARKER);
	});

	test("a state with nothing in it, a missing file and an unreadable one are error entries of the position", async () => {
		const bare = await indexOf(BASE);
		expect(positionOf(bare.index).errors).toEqual([{ code: "no-position", detail: "no frontmatter position and no Current Position section", where: "STATE.md" }]);

		const none = await indexOf({ [`${P}/PROJECT.md`]: "# Project\n" });
		expect(positionOf(none.index)).toEqual({
			errors: [
				{ code: "missing", detail: "ROADMAP.md was not found", where: "ROADMAP.md" },
				{ code: "missing", detail: "STATE.md was not found", where: "STATE.md" },
			],
			ok: false,
			position: { milestone: null, milestone_name: null, phase: null, plan: null, progress: null, status: null, step: null },
		});

		const broken = await indexOf({ ...POSITION_FILES, [`${P}/STATE.md`]: "---\nmilestone: [unclosed\n# State\n" });
		expect(positionOf(broken.index).errors).toEqual([
			{ code: "malformed-frontmatter", detail: "frontmatter has no closing fence or is not a YAML mapping", where: "STATE.md" },
		]);

		const large = await indexOf({ ...POSITION_FILES, [`${P}/STATE.md`]: `${POSITION_STATE}${"x".repeat(2_000)}` }, {}, { maxFiles: 500, maxBytes: 1_024 });
		expect(positionOf(large.index).errors).toEqual([{ code: "too-large", detail: "exceeds 1024 bytes", where: "STATE.md" }]);
	});

	test("an unchanged tree is an update that reads no bytes and keeps the position, and an edit re-reads only the changed file", async () => {
		const tree = new FakeTree(POSITION_FILES);
		const built = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: LIMITS });
		if (!built.ok) throw new Error(built.code);
		tree.returnedFrom.splice(0);

		const same = await updatePlanningIndex(TREE_ROOT, { fs: tree, limits: LIMITS }, built.index);
		if (!same.ok) throw new Error(same.code);
		expect(tree.returnedFrom).toEqual([]);
		expect(same.index).toEqual(built.index);
		expect(positionOf(same.index)).toEqual(EXPECTED);

		tree.setContent(`${P}/STATE.md`, POSITION_STATE.replace("status: executing", "status: blocked"));
		const edited = await updatePlanningIndex(TREE_ROOT, { fs: tree, limits: LIMITS }, same.index);
		if (!edited.ok) throw new Error(edited.code);
		expect(tree.returnedFrom).toEqual([`${P}/STATE.md`]);
		expect(positionOf(edited.index).position.status).toBe("blocked");
		const rebuilt = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: LIMITS });
		if (!rebuilt.ok) throw new Error(rebuilt.code);
		expect(edited.index).toEqual(rebuilt.index);
	});
});
