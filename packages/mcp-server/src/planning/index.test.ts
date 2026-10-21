/**
 * The planning index over an in-memory tree: determinism, one error record per bad path with
 * the rest of the index intact, refusal of anything that resolves outside the root, and bounds.
 */
import { describe, expect, test } from "bun:test";
import { buildPlanningIndex, isErrorRecord, readFrontmatter, type PlanningIndex, type PlanningIndexResult, type PlanningRecord } from "./index.ts";
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
	test("the same files give identical records, in path order, on every build", async () => {
		const first = (await indexOf(BASE)).index;
		const second = (await indexOf(BASE)).index;
		expect(second).toEqual(first);
		expect(first.records.map((record) => record.path)).toEqual(ALL_PATHS);
		expect(first.truncated).toBe(false);
	});

	test("each record carries the hash and size of its bytes", async () => {
		const { index } = await indexOf(BASE);
		const state = index.records.find((record) => record.path === ".planning/STATE.md");
		expect(state).toMatchObject({ kind: "state", bytes: "# State\n".length });
		expect(state && !isErrorRecord(state) ? state.sha256 : "").toMatch(/^[0-9a-f]{64}$/);
	});

	test("phase and plan come from the phase directory and file name, frontmatter is parsed", async () => {
		const { index } = await indexOf(BASE);
		const plan = index.records.find((record) => record.path.endsWith("52-01-PLAN.md"));
		const context = index.records.find((record) => record.path.endsWith("CONTEXT.md"));
		expect(plan).toMatchObject({ kind: "phase", phase: "52", plan: "52-01-PLAN", frontmatter: { phase: 52, requirements: ["SOTA-08"] } });
		expect(context).toMatchObject({ kind: "phase", phase: "52" });
		expect(context && "plan" in context).toBe(false);
	});

	test("no file body reaches the index: the marker in ROADMAP's body is absent from every record", async () => {
		const { index } = await indexOf(BASE);
		expect(JSON.stringify(index.records)).not.toContain(SECRET_BODY);
	});

	test("only the documents the plane names are indexed: nested and non-markdown files are skipped", async () => {
		const { index } = await indexOf(BASE);
		const paths = index.records.map((record) => record.path);
		expect(paths).not.toContain(".planning/phases/50-dragonfly-pubsub/notes.txt");
		expect(paths).not.toContain(".planning/phases/50-dragonfly-pubsub/deep/nested.md");
	});
});

describe("buildPlanningIndex: one bad path never breaks the rest", () => {
	test("malformed frontmatter yields exactly one error record, and every other record is unchanged", async () => {
		const baseline = (await indexOf(BASE)).index.records;
		const broken = { ...BASE, [`${PHASE}/CONTEXT.md`]: "---\nphase: 52\n# Context with no closing fence\n" };
		const { index } = await indexOf(broken);

		const error = errorFor(index.records, ".planning/phases/52-planning-awareness-core/CONTEXT.md");
		expect(error).toMatchObject({ error: { code: "malformed-frontmatter" }, kind: "phase" });
		expect(error && error.sha256).toMatch(/^[0-9a-f]{64}$/);
		const others = (records: PlanningRecord[]) => records.filter((record) => !record.path.endsWith("CONTEXT.md"));
		expect(others(index.records)).toEqual(others(baseline));
	});

	test("an unreadable file yields one error record with a code, and the rest of the index is intact", async () => {
		const baseline = (await indexOf(BASE)).index.records;
		const tree = new FakeTree(BASE);
		tree.denied.add(`${P}/STATE.md`);
		const index = await buildPlanningIndex(TREE_ROOT, { fs: tree, limits: LIMITS });
		if (!index.ok) throw new Error(index.code);

		const error = errorFor(index.index.records, ".planning/STATE.md");
		expect(error).toMatchObject({ error: { code: "unreadable", detail: "read failed: EACCES" }, sha256: null });
		const others = (records: PlanningRecord[]) => records.filter((record) => record.path !== ".planning/STATE.md");
		expect(others(index.index.records)).toEqual(others(baseline));
		expect(tree.reads).toContain(`${P}/STATE.md`);
	});

	test("a document that is not valid UTF-8 keeps its hash and is an unreadable error record", async () => {
		const { index } = await indexOf({ ...BASE, [`${P}/phases/50-dragonfly-pubsub/bad.md`]: new Uint8Array([0xff, 0xfe, 0x00]) });
		expect(errorFor(index.records, ".planning/phases/50-dragonfly-pubsub/bad.md")).toMatchObject({
			error: { code: "unreadable", detail: "not valid UTF-8" },
			bytes: 3,
		});
	});

	test("a dangling symlink is an unreadable error record for its path", async () => {
		const { index } = await indexOf(BASE, { [`${P}/phases/50-dragonfly-pubsub/gone.md`]: `${TREE_ROOT}/nowhere.md` });
		expect(errorFor(index.records, ".planning/phases/50-dragonfly-pubsub/gone.md")).toMatchObject({
			error: { code: "unreadable", detail: "dangling symlink" },
		});
	});
});

describe("buildPlanningIndex: refuses anything that resolves outside the root", () => {
	test("a file symlink to a file outside the root is an error record, and its target is never read", async () => {
		const leak = `${PHASE}/leak.md`;
		const { index, tree } = await indexOf({ ...BASE, "/outside/secret.md": "OUTSIDE-SECRET-TEXT" }, { [leak]: "/outside/secret.md" });
		expect(errorFor(index.records, ".planning/phases/52-planning-awareness-core/leak.md")).toMatchObject({
			error: { code: "outside-root" },
			sha256: null,
		});
		expect(JSON.stringify(index.records)).not.toContain("OUTSIDE-SECRET-TEXT");
		expect(tree.reads).not.toContain(leak);
	});

	test("a directory symlink that leaves the root is an error record for the directory, and nothing under it is listed", async () => {
		const { index, tree } = await indexOf({ ...BASE, "/outside/milestones/x.md": "OUTSIDE-MILESTONE" }, { [`${P}/milestones`]: "/outside/milestones" });
		expect(errorFor(index.records, ".planning/milestones")).toMatchObject({ error: { code: "outside-root" } });
		expect(index.records.map((record) => record.path)).not.toContain(".planning/milestones/x.md");
		expect(tree.reads.some((path) => path.includes("milestones"))).toBe(false);
	});

	test("a .planning directory that resolves outside the root is refused as a whole", async () => {
		const { result } = await build({ "/outside/planning/ROADMAP.md": "# x" }, { [P]: "/outside/planning" });
		expect(result).toEqual({ ok: false, code: "planning-dir-outside-root" });
	});

	test("a symlink that stays inside the root is followed, and its content is indexed", async () => {
		const { index } = await indexOf(BASE, { [`${P}/phases/50-dragonfly-pubsub/alias.md`]: `${P}/STATE.md` });
		const alias = index.records.find((record) => record.path.endsWith("alias.md"));
		const state = index.records.find((record) => record.path === ".planning/STATE.md");
		expect(alias && !isErrorRecord(alias) ? alias.sha256 : null).toBe(state && !isErrorRecord(state) ? state.sha256 : undefined);
	});
});

describe("buildPlanningIndex: bounds", () => {
	test("a document over maxBytes is a too-large error record and is never read", async () => {
		const big = `${P}/phases/50-dragonfly-pubsub/big.md`;
		const { index, tree } = await indexOf({ ...BASE, [big]: "x".repeat(2_000) }, {}, { maxFiles: 500, maxBytes: 1_024 });
		expect(errorFor(index.records, ".planning/phases/50-dragonfly-pubsub/big.md")).toMatchObject({
			error: { code: "too-large" },
			bytes: 2_000,
			sha256: null,
		});
		expect(tree.reads).not.toContain(big);
	});

	test("more documents than maxFiles keeps the first by path and sets truncated", async () => {
		const { index } = await indexOf(BASE, {}, { maxFiles: 3, maxBytes: 262_144 });
		expect(index.truncated).toBe(true);
		expect(index.records.map((record) => record.path)).toEqual(ALL_PATHS.slice(0, 3));
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

describe("readFrontmatter", () => {
	test("no fence is none, a closed mapping is parsed, an open fence without a mapping is malformed", () => {
		expect(readFrontmatter("# plain")).toEqual({ state: "none" });
		expect(readFrontmatter("---\nphase: 52\n---\n# x")).toEqual({ state: "parsed", data: { phase: 52 } });
		expect(readFrontmatter("---\nphase: 52\n")).toEqual({ state: "malformed" });
	});
});
