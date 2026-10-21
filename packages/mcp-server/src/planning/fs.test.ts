/**
 * The production adapter on a real temporary checkout: the index is deterministic, a symlink that
 * leaves the root is refused, and a dangling link is reported as unreadable. Only a scratch
 * directory under the OS temp root is touched, and it is removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanningIndex, isErrorRecord, type PlanningRecord } from "./index.ts";
import { nodePlanningFs } from "./fs.ts";

const OUTSIDE_TEXT = "OUTSIDE-REAL-SECRET";
const LIMITS = { maxFiles: 500, maxBytes: 262_144 };
let scratch = "";
let checkout = "";

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "planning-fs-test-"));
	checkout = join(scratch, "checkout");
	const planning = join(checkout, ".planning");
	const phase = join(planning, "phases", "52-planning-awareness-core");
	const outside = join(scratch, "outside");
	await mkdir(phase, { recursive: true });
	await mkdir(outside, { recursive: true });
	await writeFile(join(planning, "ROADMAP.md"), "---\nphase: roadmap\n---\n# Roadmap\n");
	await writeFile(join(planning, "STATE.md"), "# State\n");
	await writeFile(join(phase, "52-01-PLAN.md"), "---\nphase: 52\n---\n# Plan\n");
	await writeFile(join(outside, "secret.md"), OUTSIDE_TEXT);
	await writeFile(join(outside, "milestone.md"), OUTSIDE_TEXT);
	await symlink(join(outside, "secret.md"), join(phase, "leak.md"));
	await symlink(join(scratch, "nowhere.md"), join(phase, "dangling.md"));
	await symlink(outside, join(planning, "phases", "escape"));
	await symlink(outside, join(planning, "milestones"));
});

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

async function build() {
	const result = await buildPlanningIndex(checkout, { fs: nodePlanningFs(), limits: LIMITS });
	if (!result.ok) throw new Error(`index failed: ${result.code}`);
	return result.index.records;
}

function find(records: PlanningRecord[], suffix: string): PlanningRecord | undefined {
	return records.find((record) => record.path.endsWith(suffix));
}

describe("nodePlanningFs on a real checkout", () => {
	test("the same tree gives the same records, and the hash matches the bytes on disk", async () => {
		const first = await build();
		expect(await build()).toEqual(first);
		const state = find(first, "STATE.md");
		expect(state && !isErrorRecord(state) ? state.sha256 : "").toBe(createHash("sha256").update("# State\n").digest("hex"));
	});

	test("a symlink to a file outside the checkout is refused, and its contents never appear", async () => {
		const records = await build();
		expect(find(records, "leak.md")).toMatchObject({ error: { code: "outside-root" } });
		expect(JSON.stringify(records)).not.toContain(OUTSIDE_TEXT);
	});

	test("a directory symlink that leaves the checkout is an outside-root record for that directory", async () => {
		const records = await build();
		expect(records.find((record) => record.path === ".planning/milestones")).toMatchObject({ error: { code: "outside-root" } });
		expect(records.some((record) => record.path === ".planning/milestones/milestone.md")).toBe(false);
	});

	test("a dangling symlink is an unreadable record, and the rest of the index is intact", async () => {
		const records = await build();
		expect(find(records, "dangling.md")).toMatchObject({ error: { code: "unreadable", detail: "dangling symlink" } });
		expect(find(records, "52-01-PLAN.md")).toMatchObject({ kind: "phase", phase: "52", plan: "52-01-PLAN" });
	});

	test("a phase directory that is itself a link outside the checkout is an outside-root record", async () => {
		const records = await build();
		expect(records.some((record) => record.path === ".planning/phases/escape" && isErrorRecord(record))).toBe(true);
	});
});
