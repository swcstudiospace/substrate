import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decide,
	defaultSyncOptions,
	effectivePorcelain,
	type RunResult,
	runSync,
	type SyncContext,
} from "./skills-sync.ts";
import type { WarningEvent } from "./skills.ts";

const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

let T: string;
let STATE: string;

beforeEach(() => {
	T = mkdtempSync(join(tmpdir(), "p22-sync-"));
	STATE = join(T, "state", "skills-sync-warned.json");
});

afterEach(() => {
	rmSync(T, { recursive: true, force: true });
});

describe("decide", () => {
	const clean = { porcelain: "", branch: "main" };
	test("a dirty tree is refused first", () => {
		expect(decide({ ...clean, porcelain: " M a\n" })).toBe("refuse-dirty");
	});
	test("a branch other than main is refused", () => {
		expect(decide({ porcelain: "", branch: "skill/x" })).toBe("refuse-branch");
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

describe("effectivePorcelain (D22-02)", () => {
	test("untracked __pycache__ and .pyc paths are ignored", () => {
		expect(effectivePorcelain("?? parallel-common/scripts/__pycache__/\n")).toBe("");
		expect(effectivePorcelain("?? parallel-common/scripts/__pycache__/client.cpython-312.pyc\n")).toBe("");
		expect(effectivePorcelain("?? stale.pyc\n")).toBe("");
		expect(effectivePorcelain("?? a/__pycache__/x.pyc\n?? b/y.pyc\n")).toBe("");
	});
	test("any other untracked path still refuses", () => {
		expect(effectivePorcelain("?? notes.md\n")).toBe("?? notes.md\n");
		expect(effectivePorcelain("?? new-skill/SKILL.md\n")).toBe("?? new-skill/SKILL.md\n");
	});
	test("tracked changes refuse, including a tracked .pyc", () => {
		expect(effectivePorcelain(" M docs-agno/SKILL.md\n")).toBe(" M docs-agno/SKILL.md\n");
		expect(effectivePorcelain("M  tracked.pyc\n")).toBe("M  tracked.pyc\n");
		expect(effectivePorcelain(" D gone.md\n")).toBe(" D gone.md\n");
	});
	test("mixed output keeps only the refusing lines", () => {
		expect(effectivePorcelain("?? skill/__pycache__/x.pyc\n?? draft.md\n")).toBe("?? draft.md\n");
		expect(effectivePorcelain("")).toBe("");
	});
});

type Script = { porcelain?: string; branch?: string; fetch?: RunResult; ancestor?: number; head?: string; origin?: string; merge?: RunResult; project?: "ok" | "empty" | "fail" };

function harness(script: Script, clock: () => Date = () => new Date("2026-10-09T07:30:00Z")) {
	const calls: string[][] = [];
	const warnings: WarningEvent[] = [];
	const log: string[] = [];
	let projected = 0;
	const runner = async (argv: readonly string[]): Promise<RunResult> => {
		calls.push([...argv]);
		const verb = argv.slice(3).join(" ");
		switch (verb) {
			case "status --porcelain --untracked-files=all":
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
		libraryDir: join(T, "agent-skills"),
		warnStateFile: STATE,
		log: (line) => log.push(line),
		emitWarning: async (event) => {
			warnings.push(event);
			return true;
		},
		project: async () => {
			projected++;
			if (script.project === "empty") throw new Error("no library skills under /tmp/x; refusing to project");
			if (script.project === "fail") throw new Error("boom");
			return { actions: 0, warnings: 0 };
		},
		clock,
	};
	return { ctx, calls, warnings, log, projected: () => projected };
}

const verbs = (calls: string[][]) => calls.map((c) => c.slice(3).join(" "));

describe("runSync executor", () => {
	test("refuse-dirty: no fetch, no projector, one host-job warning", async () => {
		const h = harness({ porcelain: " M docs-agno/SKILL.md\n" });
		expect(await runSync(h.ctx)).toEqual({ decision: "refuse-dirty", code: 0 });
		expect(verbs(h.calls)).not.toContain("fetch origin main");
		expect(h.projected()).toBe(0);
		expect(h.warnings.map((w) => [w.surface, w.kind, w.payload])).toEqual([
			["substrate", "warning", { action: "skills.sync", runtime: "skills-sync", reason: "dirty", component: "skills-sync" }],
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
		expect(h.calls).toContainEqual(["git", "-C", join(T, "agent-skills"), "merge", "--ff-only", "origin/main"]);
		expect(h.calls[0]).toEqual(["git", "-C", join(T, "agent-skills"), "status", "--porcelain", "--untracked-files=all"]);
		expect(h.calls).toContainEqual(["git", "-C", join(T, "agent-skills"), "fetch", "origin", "main"]);
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

	test("an empty library refuses with exit 1 and a warning", async () => {
		const h = harness({ head: OLD, origin: OLD, project: "empty" });
		expect(await runSync(h.ctx)).toEqual({ decision: "error", code: 1 });
		expect(h.warnings.map((w) => w.payload.reason)).toEqual(["empty-library"]);
	});
});

describe("dirty rule end to end (D22-02)", () => {
	test("only __pycache__/.pyc untracked output proceeds to fetch", async () => {
		const h = harness({ porcelain: "?? parallel-common/scripts/__pycache__/\n?? stale.pyc\n", head: OLD, origin: OLD });
		expect(await runSync(h.ctx)).toEqual({ decision: "current", code: 0 });
		expect(verbs(h.calls)).toContain("fetch origin main");
		expect(h.projected()).toBe(1);
	});

	test("one real untracked file beside the caches still refuses", async () => {
		const h = harness({ porcelain: "?? parallel-common/scripts/__pycache__/\n?? draft.md\n" });
		expect(await runSync(h.ctx)).toEqual({ decision: "refuse-dirty", code: 0 });
		expect(verbs(h.calls)).not.toContain("fetch origin main");
	});
});

describe("host-job event shape (D22-03)", () => {
	test("refusal warnings carry the skills.sync.refused row fields and no repo", async () => {
		const h = harness({ porcelain: " M x\n" });
		await runSync(h.ctx);
		expect(h.warnings.length).toBe(1);
		const [event] = h.warnings;
		expect(event.kind).toBe("warning");
		expect(event.surface).toBe("substrate");
		expect(event.actor).toBe("agent");
		expect(event.payload.action).toBe("skills.sync");
		expect(event.payload.runtime).toBe("skills-sync");
		expect(event.payload.reason).toBe("dirty");
		expect(event.session_id).toBe("skills-sync:2026-10-09T07");
		expect("repo" in event).toBe(false);
	});
});

describe("warned-state cadence (D22-05)", () => {
	const at = (iso: string) => () => new Date(iso);

	test("first refusal warns and records reason, began-at and last-warned", async () => {
		const h = harness({ porcelain: " M x\n" });
		await runSync(h.ctx);
		expect(h.warnings.length).toBe(1);
		const state = JSON.parse(readFileSync(STATE, "utf8"));
		expect(state.reason).toBe("dirty");
		expect(state.beganAt).toBe("2026-10-09T07:30:00.000Z");
		expect(state.lastWarned).toBe("2026-10-09T07:30:00.000Z");
	});

	test("same reason later the same UTC day warns nothing", async () => {
		const first = harness({ porcelain: " M x\n" }, at("2026-10-09T07:30:00Z"));
		await runSync(first.ctx);
		const second = harness({ porcelain: " M x\n" }, at("2026-10-09T18:00:00Z"));
		second.ctx.warnStateFile = STATE;
		expect(await runSync(second.ctx)).toEqual({ decision: "refuse-dirty", code: 0 });
		expect(second.warnings).toEqual([]);
		expect(second.log).toEqual(["[skills-sync] refused dirty (already warned 2026-10-09)"]);
	});

	test("a changed reason warns again and resets began-at", async () => {
		const first = harness({ porcelain: " M x\n" }, at("2026-10-09T07:30:00Z"));
		await runSync(first.ctx);
		const second = harness({ branch: "skill/x" }, at("2026-10-09T08:00:00Z"));
		second.ctx.warnStateFile = STATE;
		await runSync(second.ctx);
		expect(second.warnings.map((w) => w.payload.reason)).toEqual(["branch"]);
		const state = JSON.parse(readFileSync(STATE, "utf8"));
		expect(state.reason).toBe("branch");
		expect(state.beganAt).toBe("2026-10-09T08:00:00.000Z");
	});

	test("a standing refusal warns again on the next UTC day", async () => {
		const first = harness({ porcelain: " M x\n" }, at("2026-10-09T07:30:00Z"));
		await runSync(first.ctx);
		const second = harness({ porcelain: " M x\n" }, at("2026-10-10T00:30:00Z"));
		second.ctx.warnStateFile = STATE;
		await runSync(second.ctx);
		expect(second.warnings.map((w) => w.payload.reason)).toEqual(["dirty"]);
		const state = JSON.parse(readFileSync(STATE, "utf8"));
		expect(state.beganAt).toBe("2026-10-09T07:30:00.000Z");
		expect(state.lastWarned).toBe("2026-10-10T00:30:00.000Z");
	});

	test("a tick that clears the refusal logs cleared, emits nothing, and removes the state", async () => {
		const first = harness({ porcelain: " M x\n" }, at("2026-10-09T07:30:00Z"));
		await runSync(first.ctx);
		expect(existsSync(STATE)).toBe(true);
		const second = harness({ head: OLD, origin: OLD }, at("2026-10-09T08:00:00Z"));
		second.ctx.warnStateFile = STATE;
		expect(await runSync(second.ctx)).toEqual({ decision: "current", code: 0 });
		expect(second.warnings).toEqual([]);
		expect(second.log).toEqual([`[skills-sync] current ${OLD}`, "[skills-sync] cleared dirty"]);
		expect(existsSync(STATE)).toBe(false);
	});
});

describe("seams (D22-07)", () => {
	test("production defaults are September's; overrides move the checkout and the state file", () => {
		expect(defaultSyncOptions({})).toEqual({
			libraryDir: "/root/agent-skills",
			warnStateFile: "/var/lib/substrate/skills/skills-sync-warned.json",
		});
		expect(defaultSyncOptions({ SUBSTRATE_SKILLS_LIBRARY: join(T, "lib"), SUBSTRATE_SKILLS_STATE: join(T, "state") })).toEqual({
			libraryDir: join(T, "lib"),
			warnStateFile: join(T, "state", "skills-sync-warned.json"),
		});
	});
});
