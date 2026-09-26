import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	apply,
	type ApplyContext,
	inventory,
	libraryNames,
	main,
	plan,
	ROOTS,
	type Root,
	type WarningEvent,
} from "./skills.ts";

let T: string;
let LIB: string;
let EXP: string;
let CLAUDE: Root;
let GROK: Root;
let BACKUP: string;
let STATE: string;

function skill(dir: string, name: string, body = `---\nname: ${name}\ndescription: d\n---\n`): void {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "SKILL.md"), body);
}

function ctx(warnings: WarningEvent[] = [], log: string[] = []): ApplyContext {
	return {
		backupDir: BACKUP,
		stateFile: STATE,
		log: (line) => log.push(line),
		emitWarning: async (event) => {
			warnings.push(event);
			return true;
		},
	};
}

function dirs() {
	return { libraryDir: LIB, exportsDir: EXP };
}

beforeEach(() => {
	T = mkdtempSync(join(tmpdir(), "p4-skills-"));
	LIB = join(T, "agent-skills");
	EXP = join(T, "exports");
	BACKUP = join(T, "backup", "20260926T000000Z");
	STATE = join(T, "state", "projector-warned.json");
	mkdirSync(LIB);
	mkdirSync(EXP);
	CLAUDE = { id: "claude", dir: join(T, "claude"), surface: "claude-code", mode: "link" };
	GROK = { id: "grok", dir: join(T, "grok"), surface: "grok-build", mode: "link" };
	mkdirSync(CLAUDE.dir);
	mkdirSync(GROK.dir);
});

afterEach(() => {
	rmSync(T, { recursive: true, force: true });
});

describe("ROOTS", () => {
	test("this plan projects into Claude Code and Grok Build only", () => {
		expect(ROOTS.map((r) => [r.id, r.dir, r.surface, r.mode])).toEqual([
			["claude", "/root/.claude/skills", "claude-code", "link"],
			["grok", "/root/.grok/skills", "grok-build", "link"],
		]);
	});
});

describe("libraryNames", () => {
	test("sorted skill dirs with SKILL.md and a valid name; .git, README.md, bad names and dirs without SKILL.md ignored", () => {
		skill(LIB, "zeta");
		skill(LIB, "alpha");
		skill(LIB, "Bad_Name");
		mkdirSync(join(LIB, "no-skill-md"));
		mkdirSync(join(LIB, ".git"));
		writeFileSync(join(LIB, ".git", "SKILL.md"), "x");
		writeFileSync(join(LIB, "README.md"), "# library\n");
		expect(libraryNames(LIB)).toEqual(["alpha", "zeta"]);
	});
});

describe("plan and apply on an empty Claude root", () => {
	test("3 library skills → 3 link-new; after apply the plan is empty and a second apply writes nothing", async () => {
		for (const n of ["a", "b", "c"]) skill(LIB, n);
		const names = libraryNames(LIB);
		const first = plan([inventory(CLAUDE)], names, dirs());
		expect(first.map((a) => [a.kind, a.name])).toEqual([
			["link-new", "a"],
			["link-new", "b"],
			["link-new", "c"],
		]);
		const result = await apply(first, ctx());
		expect(result).toEqual({ actions: 3, warnings: 0 });
		for (const n of names) expect(readlinkSync(join(CLAUDE.dir, n))).toBe(join(LIB, n));

		const second = plan([inventory(CLAUDE)], names, dirs());
		expect(second).toEqual([]);
		const restoreBefore = readFileSync(join(BACKUP, "RESTORE.md"), "utf8");
		const again = await apply(second, { ...ctx(), backupDir: join(T, "backup", "second") });
		expect(again).toEqual({ actions: 0, warnings: 0 });
		expect(existsSync(join(T, "backup", "second"))).toBe(false);
		expect(readFileSync(join(BACKUP, "RESTORE.md"), "utf8")).toBe(restoreBefore);
	});
});

describe("Grok root classification", () => {
	test("exports link → repoint; library link → nothing; real dir → skip-warn real-dir; other link → foreign-link; non-library names untouched", () => {
		for (const n of ["exp", "done", "real-same", "real-diff", "foreign", "absent"]) skill(LIB, n);
		skill(EXP, "exp");
		symlinkSync(join(EXP, "exp"), join(GROK.dir, "exp"));
		symlinkSync(join(LIB, "done"), join(GROK.dir, "done"));
		skill(GROK.dir, "real-same");
		skill(GROK.dir, "real-diff", "---\nname: real-diff\ndescription: other\n---\n");
		symlinkSync("/somewhere/else/foreign", join(GROK.dir, "foreign"));
		writeFileSync(join(GROK.dir, "README.md"), "# grok\n");
		skill(GROK.dir, "runpod");

		const actions = plan([inventory(GROK)], libraryNames(LIB), dirs());
		const view = actions.map((a) =>
			a.kind === "skip-warn" ? [a.kind, a.name, a.reason] : a.kind === "repoint" ? [a.kind, a.name, a.from] : [a.kind, a.name],
		);
		expect(view).toEqual([
			["link-new", "absent"],
			["repoint", "exp", join(EXP, "exp")],
			["skip-warn", "foreign", "foreign-link"],
			["skip-warn", "real-diff", "real-dir"],
			["skip-warn", "real-same", "real-dir"],
		]);
		for (const a of actions) expect(a.root.id).toBe("grok");
	});
});

describe("apply writes", () => {
	test("tmp link renamed over the target; RESTORE.md gets the old target before a repoint and rm before a link-new; backup dir 0700", async () => {
		skill(LIB, "exp");
		skill(LIB, "fresh");
		skill(EXP, "exp");
		symlinkSync(join(EXP, "exp"), join(GROK.dir, "exp"));
		const log: string[] = [];
		const actions = plan([inventory(GROK)], libraryNames(LIB), dirs());
		const result = await apply(actions, ctx([], log));
		expect(result).toEqual({ actions: 2, warnings: 0 });
		expect(readlinkSync(join(GROK.dir, "exp"))).toBe(join(LIB, "exp"));
		expect(readlinkSync(join(GROK.dir, "fresh"))).toBe(join(LIB, "fresh"));
		expect(readdirSync(GROK.dir).filter((n) => n.endsWith(".substrate-tmp"))).toEqual([]);
		expect(lstatSync(BACKUP).mode & 0o777).toBe(0o700);
		const restore = readFileSync(join(BACKUP, "RESTORE.md"), "utf8");
		expect(restore).toContain(`ln -sfn '${join(EXP, "exp")}' '${join(GROK.dir, "exp")}'`);
		expect(restore).toContain(`rm '${join(GROK.dir, "fresh")}'`);
		expect(log).toEqual(["[projector] grok link-new fresh", "[projector] grok repoint exp"]);
	});

	test("a stale <name>.substrate-tmp left by an interrupted run is replaced, and the target never goes missing", async () => {
		skill(LIB, "exp");
		skill(EXP, "exp");
		symlinkSync(join(EXP, "exp"), join(GROK.dir, "exp"));
		symlinkSync("/stale", join(GROK.dir, "exp.substrate-tmp"));
		await apply(plan([inventory(GROK)], libraryNames(LIB), dirs()), ctx());
		expect(readlinkSync(join(GROK.dir, "exp"))).toBe(join(LIB, "exp"));
		expect(existsSync(join(GROK.dir, "exp.substrate-tmp"))).toBe(false);
	});

	test("a real dir is never touched", async () => {
		skill(LIB, "real");
		skill(GROK.dir, "real");
		const before = readFileSync(join(GROK.dir, "real", "SKILL.md"), "utf8");
		await apply(plan([inventory(GROK)], libraryNames(LIB), dirs()), ctx());
		expect(lstatSync(join(GROK.dir, "real")).isDirectory()).toBe(true);
		expect(readFileSync(join(GROK.dir, "real", "SKILL.md"), "utf8")).toBe(before);
		expect(existsSync(BACKUP)).toBe(false);
	});
});

describe("warning dedupe", () => {
	test("one warning per (root, name, reason) with the root's surface; a second run emits none", async () => {
		skill(LIB, "real");
		skill(LIB, "foreign");
		skill(CLAUDE.dir, "real");
		skill(GROK.dir, "real");
		symlinkSync("/elsewhere", join(GROK.dir, "foreign"));
		const warnings: WarningEvent[] = [];
		const names = libraryNames(LIB);
		const first = await apply(plan([inventory(CLAUDE), inventory(GROK)], names, dirs()), ctx(warnings));
		expect(first).toEqual({ actions: 1, warnings: 3 });
		expect(warnings.map((w) => [w.surface, w.kind, w.payload.root, w.payload.name, w.payload.reason])).toEqual([
			["claude-code", "warning", "claude", "real", "real-dir"],
			["grok-build", "warning", "grok", "foreign", "foreign-link"],
			["grok-build", "warning", "grok", "real", "real-dir"],
		]);
		const second = await apply(plan([inventory(CLAUDE), inventory(GROK)], names, dirs()), ctx(warnings));
		expect(second).toEqual({ actions: 0, warnings: 0 });
		expect(warnings.length).toBe(3);
	});

	test("a warning the substrate did not accept is retried on the next run", async () => {
		skill(LIB, "real");
		skill(GROK.dir, "real");
		const actions = plan([inventory(GROK)], libraryNames(LIB), dirs());
		const failed = await apply(actions, { ...ctx(), emitWarning: async () => false });
		expect(failed.warnings).toBe(0);
		const warnings: WarningEvent[] = [];
		expect((await apply(actions, ctx(warnings))).warnings).toBe(1);
	});
});

describe("CLI main", () => {
	function opts(warnings: WarningEvent[], out: string[]) {
		return {
			roots: [CLAUDE, GROK],
			libraryDir: LIB,
			exportsDir: EXP,
			backupRoot: join(T, "backup"),
			stateFile: STATE,
			stdout: (line: string) => out.push(line),
			emitWarning: async (event: WarningEvent) => {
				warnings.push(event);
				return true;
			},
		};
	}

	test("--check exits 1 on a pending link and writes nothing (no link, no backup, no warning, no state)", async () => {
		skill(LIB, "a");
		skill(LIB, "real");
		skill(GROK.dir, "real");
		const warnings: WarningEvent[] = [];
		const out: string[] = [];
		expect(await main(["--check"], opts(warnings, out))).toBe(1);
		expect(existsSync(join(CLAUDE.dir, "a"))).toBe(false);
		expect(existsSync(join(T, "backup"))).toBe(false);
		expect(existsSync(STATE)).toBe(false);
		expect(warnings).toEqual([]);
	});

	test("skip-warn entries alone are not drift: --check exits 0 with an already-current line", async () => {
		skill(LIB, "real");
		skill(GROK.dir, "real");
		symlinkSync(join(LIB, "real"), join(CLAUDE.dir, "real"));
		const out: string[] = [];
		expect(await main(["--check"], opts([], out))).toBe(0);
		expect(out.some((l) => l.includes("already current"))).toBe(true);
	});

	test("a run applies and prints the totals; a second run prints actions=0 warnings=0 and already current", async () => {
		skill(LIB, "a");
		skill(LIB, "real");
		skill(GROK.dir, "real");
		const warnings: WarningEvent[] = [];
		const out: string[] = [];
		expect(await main([], opts(warnings, out))).toBe(0);
		expect(out).toContain("[projector] actions=3 warnings=1");
		const out2: string[] = [];
		expect(await main([], opts(warnings, out2))).toBe(0);
		expect(out2).toContain("[projector] actions=0 warnings=0");
		expect(out2.some((l) => l.includes("already current"))).toBe(true);
		expect(await main(["--check"], opts(warnings, []))).toBe(0);
	});

	test("--root limits the run to one root", async () => {
		skill(LIB, "a");
		expect(await main(["--root", "grok"], opts([], []))).toBe(0);
		expect(existsSync(join(GROK.dir, "a"))).toBe(true);
		expect(existsSync(join(CLAUDE.dir, "a"))).toBe(false);
		expect(await main(["--root", "nope"], opts([], []))).toBe(2);
	});
});
