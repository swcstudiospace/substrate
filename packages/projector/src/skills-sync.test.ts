import { describe, expect, test } from "bun:test";
import { decide, type RunResult, runSync, type SyncContext } from "./skills-sync.ts";
import type { WarningEvent } from "./skills.ts";

const L = "/tmp/lib";
const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

describe("decide", () => {
	const clean = { porcelain: "", branch: "main" };
	test("a dirty tree is refused first", () => {
		expect(decide({ porcelain: " M x", branch: "main", isAncestor: true, head: OLD, originMain: NEW })).toBe("refuse-dirty");
		expect(decide({ porcelain: "?? new-file\n", branch: "other" })).toBe("refuse-dirty");
	});
	test("a branch other than main is refused", () => {
		expect(decide({ porcelain: "", branch: "other", isAncestor: true, head: OLD, originMain: NEW })).toBe("refuse-branch");
		expect(decide({ porcelain: "", branch: "HEAD" })).toBe("refuse-branch");
	});
	test("clean main with no remote facts yet → fetch", () => {
		expect(decide(clean)).toBe("fetch");
	});
	test("HEAD not an ancestor of origin/main → refuse-diverged", () => {
		expect(decide({ ...clean, isAncestor: false, head: OLD, originMain: NEW })).toBe("refuse-diverged");
	});
	test("HEAD equal to origin/main → current; otherwise ff", () => {
		expect(decide({ ...clean, isAncestor: true, head: OLD, originMain: OLD })).toBe("current");
		expect(decide({ ...clean, isAncestor: true, head: OLD, originMain: NEW })).toBe("ff");
	});
});

type Script = { porcelain?: string; branch?: string; fetch?: RunResult; ancestor?: number; head?: string; origin?: string; merge?: RunResult };

function harness(script: Script) {
	const calls: string[][] = [];
	const warnings: WarningEvent[] = [];
	const log: string[] = [];
	let projected = 0;
	const runner = async (argv: readonly string[]): Promise<RunResult> => {
		calls.push([...argv]);
		const verb = argv.slice(3).join(" ");
		switch (verb) {
			case "status --porcelain":
				return ok(script.porcelain ?? "");
			case "rev-parse --abbrev-ref HEAD":
				return ok(`${script.branch ?? "main"}\n`);
			case "fetch origin main":
				return script.fetch ?? ok();
			case "merge-base --is-ancestor HEAD origin/main":
				return { code: script.ancestor ?? 0, stdout: "", stderr: "" };
			case "rev-parse HEAD origin/main":
				return ok(`${script.head ?? OLD}\n${script.origin ?? OLD}\n`);
			case "merge --ff-only origin/main":
				return script.merge ?? ok("Fast-forward\n");
			default:
				throw new Error(`unexpected argv ${argv.join(" ")}`);
		}
	};
	const ctx: SyncContext = {
		runner,
		libraryDir: L,
		log: (line) => log.push(line),
		emitWarning: async (event) => {
			warnings.push(event);
			return true;
		},
		project: async () => {
			projected++;
			return { actions: 0, warnings: 0 };
		},
	};
	return { ctx, calls, warnings, log, projected: () => projected };
}

const verbs = (calls: string[][]) => calls.map((c) => c.slice(3).join(" "));

describe("runSync executor", () => {
	test("refuse-dirty: no fetch, no projector, one warning", async () => {
		const h = harness({ porcelain: " M docs-agno/SKILL.md\n" });
		expect(await runSync(h.ctx)).toEqual({ decision: "refuse-dirty", code: 0 });
		expect(verbs(h.calls)).not.toContain("fetch origin main");
		expect(h.projected()).toBe(0);
		expect(h.warnings.map((w) => [w.surface, w.kind, w.payload])).toEqual([
			["claude-code", "warning", { component: "skills-sync", reason: "dirty" }],
		]);
		expect(h.log).toEqual(["[skills-sync] refused dirty"]);
	});

	test("refuse-branch: no fetch, no projector, one warning", async () => {
		const h = harness({ branch: "skill/x" });
		expect((await runSync(h.ctx)).decision).toBe("refuse-branch");
		expect(verbs(h.calls)).not.toContain("fetch origin main");
		expect(h.projected()).toBe(0);
		expect(h.warnings.map((w) => w.payload.reason)).toEqual(["branch"]);
		expect(h.log).toEqual(["[skills-sync] refused branch"]);
	});

	test("refuse-diverged: fetched, no merge, no projector, one warning", async () => {
		const h = harness({ ancestor: 1, head: OLD, origin: NEW });
		expect((await runSync(h.ctx)).decision).toBe("refuse-diverged");
		expect(verbs(h.calls)).toContain("fetch origin main");
		expect(verbs(h.calls)).not.toContain("merge --ff-only origin/main");
		expect(h.projected()).toBe(0);
		expect(h.warnings.map((w) => w.payload.reason)).toEqual(["diverged"]);
		expect(h.log).toEqual(["[skills-sync] refused diverged"]);
	});

	test("ff: the exact --ff-only argv, then the projector", async () => {
		const h = harness({ head: OLD, origin: NEW });
		expect(await runSync(h.ctx)).toEqual({ decision: "ff", code: 0 });
		expect(h.calls).toContainEqual(["git", "-C", L, "merge", "--ff-only", "origin/main"]);
		expect(h.calls[0]).toEqual(["git", "-C", L, "status", "--porcelain"]);
		expect(h.calls).toContainEqual(["git", "-C", L, "fetch", "origin", "main"]);
		expect(h.projected()).toBe(1);
		expect(h.warnings).toEqual([]);
		expect(h.log).toEqual([`[skills-sync] ff ${OLD}..${NEW}`]);
	});

	test("current: no merge, the projector still runs (self-heal), no warning", async () => {
		const h = harness({ head: OLD, origin: OLD });
		expect(await runSync(h.ctx)).toEqual({ decision: "current", code: 0 });
		expect(verbs(h.calls)).not.toContain("merge --ff-only origin/main");
		expect(h.projected()).toBe(1);
		expect(h.warnings).toEqual([]);
		expect(h.log).toEqual([`[skills-sync] current ${OLD}`]);
	});

	test("a failed git step ends the tick with exit 1, one warning, and no projector", async () => {
		const h = harness({ fetch: { code: 128, stdout: "", stderr: "fatal: unable to access" } });
		expect(await runSync(h.ctx)).toEqual({ decision: "error", code: 1 });
		expect(verbs(h.calls)).not.toContain("merge --ff-only origin/main");
		expect(h.projected()).toBe(0);
		expect(h.warnings.map((w) => w.payload.reason)).toEqual(["fetch-failed"]);
		expect(h.log[0]).toStartWith("[skills-sync] refused fetch-failed");
	});

	test("a failed ff merge is refused with a warning and no projector", async () => {
		const h = harness({ head: OLD, origin: NEW, merge: { code: 128, stdout: "", stderr: "fatal: Not possible to fast-forward" } });
		expect((await runSync(h.ctx)).code).toBe(1);
		expect(h.projected()).toBe(0);
		expect(h.warnings.map((w) => w.payload.reason)).toEqual(["merge-failed"]);
	});
});
