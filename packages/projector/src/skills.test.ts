import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
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
	activeRoots,
	apply,
	type ApplyContext,
	GROK_KNOWN_REAL,
	inventory,
	libraryNames,
	main,
	plan,
	ROOTS,
	type Root,
	sameTree,
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
	GROK = { id: "grok", dir: join(T, "grok"), surface: "grok-build", mode: "link", knownReal: GROK_KNOWN_REAL };
	mkdirSync(CLAUDE.dir);
	mkdirSync(GROK.dir);
});

afterEach(() => {
	rmSync(T, { recursive: true, force: true });
});

describe("ROOTS", () => {
	test("Claude, Grok, Cursor (.agents), Muse, the two OpenClaw dirs (repoint-only) and the flag-gated Cursor root", () => {
		expect(ROOTS.map((r) => [r.id, r.dir, r.surface, r.mode])).toEqual([
			["claude", "/root/.claude/skills", "claude-code", "link"],
			["grok", "/root/.grok/skills", "grok-build", "link"],
			["agents", "/root/.agents/skills", "cursor", "link"],
			["muse", "/root/.config/muse/skills", "muse", "link"],
			["openclaw", "/root/.openclaw/skills", "claude-code", "repoint-only"],
			["openclaw-ws", "/root/.openclaw/workspace/skills", "claude-code", "repoint-only"],
			["cursor", "/root/.cursor/skills", "cursor", "link"],
		]);
		const byId = new Map(ROOTS.map((r) => [r.id, r]));
		expect(byId.get("agents")?.disableFlag).toBe("/var/lib/substrate/skills/disable-agents-root");
		expect(byId.get("cursor")?.enableFlag).toBe("/var/lib/substrate/skills/enable-cursor-root");
		expect(byId.get("muse")?.create).toBe(true);
		expect(byId.get("grok")?.knownReal).toBe(GROK_KNOWN_REAL);
	});

	test("GROK_KNOWN_REAL is the 04-01 Grok real-entry list minus the ten library names that become links", () => {
		expect([...GROK_KNOWN_REAL]).toEqual([
			"README.md",
			"autonogrammer-operating",
			"companion-clis",
			"flash",
			"runpod",
			"runpod-mcp",
			"runpod-migrate",
			"runpod-templates",
			"runpod-usage",
			"runpodctl",
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
	test("exports link → repoint; library link → nothing; identical real dir → backup-then-link; differing real dir → real-dir-differs; other link → foreign-link; non-library names untouched", () => {
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
			["skip-warn", "real-diff", "real-dir-differs"],
			["backup-then-link", "real-same"],
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
		expect(log).toEqual(["[projector] grok repoint exp", "[projector] grok link-new fresh"]);
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

	test("a real dir with one differing byte is never touched: nothing copied, nothing removed", async () => {
		skill(LIB, "real", "---\nname: real\ndescription: a\n---\n");
		skill(GROK.dir, "real", "---\nname: real\ndescription: b\n---\n");
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
		skill(CLAUDE.dir, "real", "claude's own");
		skill(GROK.dir, "real", "grok's own");
		symlinkSync("/elsewhere", join(GROK.dir, "foreign"));
		const warnings: WarningEvent[] = [];
		const names = libraryNames(LIB);
		const first = await apply(plan([inventory(CLAUDE), inventory(GROK)], names, dirs()), ctx(warnings));
		expect(first).toEqual({ actions: 1, warnings: 3 });
		expect(warnings.map((w) => [w.surface, w.kind, w.payload.root, w.payload.name, w.payload.reason])).toEqual([
			["claude-code", "warning", "claude", "real", "real-dir-differs"],
			["grok-build", "warning", "grok", "foreign", "foreign-link"],
			["grok-build", "warning", "grok", "real", "real-dir-differs"],
		]);
		const second = await apply(plan([inventory(CLAUDE), inventory(GROK)], names, dirs()), ctx(warnings));
		expect(second).toEqual({ actions: 0, warnings: 0 });
		expect(warnings.length).toBe(3);
	});

	test("a warning the substrate did not accept is retried on the next run", async () => {
		skill(LIB, "real");
		skill(GROK.dir, "real", "grok's own");
		const actions = plan([inventory(GROK)], libraryNames(LIB), dirs());
		const failed = await apply(actions, { ...ctx(), emitWarning: async () => false });
		expect(failed.warnings).toBe(0);
		const warnings: WarningEvent[] = [];
		expect((await apply(actions, ctx(warnings))).warnings).toBe(1);
	});
});

describe("CLI main", () => {
	function opts(warnings: WarningEvent[], out: string[], roots: Root[] = [CLAUDE, GROK]) {
		return {
			roots,
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
		skill(GROK.dir, "real", "grok's own");
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
		skill(GROK.dir, "real", "grok's own");
		symlinkSync(join(LIB, "real"), join(CLAUDE.dir, "real"));
		const out: string[] = [];
		expect(await main(["--check"], opts([], out))).toBe(0);
		expect(out.some((l) => l.includes("already current"))).toBe(true);
	});

	test("a run applies and prints the totals; a second run prints actions=0 warnings=0 and already current", async () => {
		skill(LIB, "a");
		skill(LIB, "real");
		skill(GROK.dir, "real", "grok's own");
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

	test("--check treats a pending backup-then-link and remove-own-link as drift and writes nothing", async () => {
		skill(LIB, "same");
		skill(GROK.dir, "same");
		symlinkSync(join(LIB, "same"), join(CLAUDE.dir, "same"));
		const flag = join(T, "flags", "disable-agents-root");
		mkdirSync(join(T, "flags"));
		writeFileSync(flag, "");
		const agents: Root = { id: "agents", dir: CLAUDE.dir, surface: "cursor", mode: "link", disableFlag: flag };
		const out: string[] = [];
		expect(await main(["--check"], opts([], out, [agents, GROK]))).toBe(1);
		expect(out).toEqual(["[projector] would remove-own-link agents same", "[projector] would backup-then-link grok same"]);
		expect(readlinkSync(join(CLAUDE.dir, "same"))).toBe(join(LIB, "same"));
		expect(lstatSync(join(GROK.dir, "same")).isDirectory()).toBe(true);
		expect(existsSync(join(T, "backup"))).toBe(false);
		expect(existsSync(STATE)).toBe(false);
	});

	test("a flag-gated root joins a run only while its enable flag exists", async () => {
		skill(LIB, "a");
		const flag = join(T, "enable-cursor-root");
		const cursor: Root = { id: "cursor", dir: join(T, "cursor"), surface: "cursor", mode: "link", enableFlag: flag };
		mkdirSync(cursor.dir);
		const out: string[] = [];
		expect(await main([], opts([], out, [CLAUDE, cursor]))).toBe(0);
		expect(existsSync(join(cursor.dir, "a"))).toBe(false);
		expect(existsSync(join(CLAUDE.dir, "a"))).toBe(true);
		writeFileSync(flag, "");
		expect(await main(["--check"], opts([], [], [CLAUDE, cursor]))).toBe(1);
		expect(await main([], opts([], [], [CLAUDE, cursor]))).toBe(0);
		expect(readlinkSync(join(cursor.dir, "a"))).toBe(join(LIB, "a"));
	});
});

describe("sameTree", () => {
	test("equal file lists and bytes, ignoring __pycache__ dirs and *.pyc; one differing byte, an extra file or a missing file is not equal", () => {
		const a = join(T, "a");
		const b = join(T, "b");
		for (const d of [a, b]) {
			skill(d, "s");
			mkdirSync(join(d, "s", "scripts"));
			writeFileSync(join(d, "s", "scripts", "client.py"), "print(1)\n");
		}
		mkdirSync(join(a, "s", "scripts", "__pycache__"));
		writeFileSync(join(a, "s", "scripts", "__pycache__", "client.cpython-312.pyc"), "bytecode");
		writeFileSync(join(b, "s", "scripts", "stale.pyc"), "bytecode");
		expect(sameTree(join(a, "s"), join(b, "s"))).toBe(true);

		writeFileSync(join(b, "s", "scripts", "client.py"), "print(2)\n");
		expect(sameTree(join(a, "s"), join(b, "s"))).toBe(false);
		writeFileSync(join(b, "s", "scripts", "client.py"), "print(1)\n");
		writeFileSync(join(b, "s", "extra.md"), "x");
		expect(sameTree(join(a, "s"), join(b, "s"))).toBe(false);
		rmSync(join(b, "s", "extra.md"));
		rmSync(join(a, "s", "scripts", "client.py"));
		expect(sameTree(join(a, "s"), join(b, "s"))).toBe(false);
	});
});

describe("backup-then-link (D-06)", () => {
	function sha(path: string): string {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	}

	test("an identical real dir is backed up under <backupDir>/<root>/<name>/ with a MANIFEST line per file and a RESTORE line, then replaced by the link", async () => {
		skill(LIB, "same");
		mkdirSync(join(LIB, "same", "scripts"));
		writeFileSync(join(LIB, "same", "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
		skill(GROK.dir, "same");
		mkdirSync(join(GROK.dir, "same", "scripts", "__pycache__"), { recursive: true });
		writeFileSync(join(GROK.dir, "same", "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
		chmodSync(join(GROK.dir, "same", "scripts", "run.sh"), 0o755);
		writeFileSync(join(GROK.dir, "same", "scripts", "__pycache__", "x.pyc"), "bytecode");
		const log: string[] = [];
		const actions = plan([inventory(GROK)], libraryNames(LIB), dirs());
		expect(actions.map((a) => [a.kind, a.name])).toEqual([["backup-then-link", "same"]]);
		expect(await apply(actions, ctx([], log))).toEqual({ actions: 1, warnings: 0 });

		const path = join(GROK.dir, "same");
		const backup = join(BACKUP, "grok", "same");
		expect(readlinkSync(path)).toBe(join(LIB, "same"));
		expect(readdirSync(GROK.dir).sort()).toEqual(["same"]);
		expect(readFileSync(join(backup, "SKILL.md"), "utf8")).toBe(readFileSync(join(LIB, "same", "SKILL.md"), "utf8"));
		expect(readFileSync(join(backup, "scripts", "__pycache__", "x.pyc"), "utf8")).toBe("bytecode");
		expect(lstatSync(join(backup, "scripts", "run.sh")).mode & 0o777).toBe(0o755);

		const manifest = readFileSync(join(BACKUP, "MANIFEST.sha256"), "utf8").trim().split("\n").sort();
		expect(manifest).toEqual(
			["grok/same/SKILL.md", "grok/same/scripts/__pycache__/x.pyc", "grok/same/scripts/run.sh"].map(
				(rel) => `${sha(join(BACKUP, rel))}  ${rel}`,
			).sort(),
		);
		const restore = readFileSync(join(BACKUP, "RESTORE.md"), "utf8");
		const line = `rm '${path}' && cp -a '${backup}' '${path}'`;
		expect(restore).toContain(line);
		expect(log).toEqual(["[projector] grok backup-then-link same"]);

		expect(plan([inventory(GROK)], libraryNames(LIB), dirs())).toEqual([]);
		expect(Bun.spawnSync(["sh", "-c", line]).exitCode).toBe(0);
		expect(lstatSync(path).isDirectory()).toBe(true);
		expect(sameTree(path, join(LIB, "same"))).toBe(true);
		expect(existsSync(join(path, "scripts", "__pycache__", "x.pyc"))).toBe(true);
	});

	test("a dir that stopped being identical between plan and apply is left alone", async () => {
		skill(LIB, "same");
		skill(GROK.dir, "same");
		const actions = plan([inventory(GROK)], libraryNames(LIB), dirs());
		writeFileSync(join(GROK.dir, "same", "local-note.md"), "grok wrote this");
		const log: string[] = [];
		expect(await apply(actions, ctx([], log))).toEqual({ actions: 0, warnings: 0 });
		expect(lstatSync(join(GROK.dir, "same")).isDirectory()).toBe(true);
		expect(existsSync(BACKUP)).toBe(false);
		expect(log).toEqual(["[projector] grok changed-underfoot same"]);
	});
});

describe("agents root (Cursor) and the D-20 disable flag", () => {
	let AGENTS: Root;
	let FLAG: string;
	beforeEach(() => {
		FLAG = join(T, "flags", "disable-agents-root");
		mkdirSync(join(T, "flags"));
		AGENTS = { id: "agents", dir: join(T, "agents"), surface: "cursor", mode: "link", disableFlag: FLAG };
		mkdirSync(AGENTS.dir);
	});

	test("every absent library name gets a link; the root's own unrelated real skills are never touched", async () => {
		for (const n of ["a", "b"]) skill(LIB, n);
		skill(AGENTS.dir, "cursor-own");
		writeFileSync(join(AGENTS.dir, "notes.txt"), "x");
		const actions = plan([inventory(AGENTS)], libraryNames(LIB), dirs());
		expect(actions.map((a) => [a.kind, a.name])).toEqual([
			["link-new", "a"],
			["link-new", "b"],
		]);
		await apply(actions, ctx());
		expect(readdirSync(AGENTS.dir).sort()).toEqual(["a", "b", "cursor-own", "notes.txt"]);
		expect(readFileSync(join(AGENTS.dir, "cursor-own", "SKILL.md"), "utf8")).toContain("name: cursor-own");
	});

	test("with the flag present only the projector's own links are removed (with a RESTORE line); nothing is added", async () => {
		for (const n of ["a", "b", "c"]) skill(LIB, n);
		symlinkSync(join(LIB, "a"), join(AGENTS.dir, "a"));
		symlinkSync(join(LIB, "b"), join(AGENTS.dir, "b"));
		symlinkSync(join(LIB, "a"), join(AGENTS.dir, "alias"));
		symlinkSync("/elsewhere/x", join(AGENTS.dir, "x"));
		skill(AGENTS.dir, "cursor-own");
		writeFileSync(FLAG, "");
		const actions = plan([inventory(AGENTS)], libraryNames(LIB), dirs());
		expect(actions.map((a) => [a.kind, a.name])).toEqual([
			["remove-own-link", "a"],
			["remove-own-link", "b"],
		]);
		expect(await apply(actions, ctx())).toEqual({ actions: 2, warnings: 0 });
		expect(readdirSync(AGENTS.dir).sort()).toEqual(["alias", "cursor-own", "x"]);
		const restore = readFileSync(join(BACKUP, "RESTORE.md"), "utf8");
		expect(restore).toContain(`ln -sfn '${join(LIB, "a")}' '${join(AGENTS.dir, "a")}'`);
		expect(plan([inventory(AGENTS)], libraryNames(LIB), dirs())).toEqual([]);

		rmSync(FLAG);
		expect(plan([inventory(AGENTS)], libraryNames(LIB), dirs()).map((a) => [a.kind, a.name])).toEqual([
			["link-new", "a"],
			["link-new", "b"],
			["link-new", "c"],
		]);
	});
});

describe("muse root (create)", () => {
	test("a missing root marked create is created 0755 and filled with links; the RESTORE route removes the dir after the links", async () => {
		for (const n of ["a", "b"]) skill(LIB, n);
		const MUSE: Root = { id: "muse", dir: join(T, "config", "muse", "skills"), surface: "muse", mode: "link", create: true };
		const log: string[] = [];
		const actions = plan([inventory(MUSE)], libraryNames(LIB), dirs());
		expect(actions.map((a) => [a.kind, a.name])).toEqual([
			["link-new", "a"],
			["link-new", "b"],
		]);
		expect(await apply(actions, ctx([], log))).toEqual({ actions: 2, warnings: 0 });
		expect(lstatSync(MUSE.dir).mode & 0o777).toBe(0o755);
		for (const n of ["a", "b"]) expect(readlinkSync(join(MUSE.dir, n))).toBe(join(LIB, n));
		const restore = readFileSync(join(BACKUP, "RESTORE.md"), "utf8").trim().split("\n");
		expect(restore.slice(-3)).toEqual([`rmdir '${MUSE.dir}'`, `rm '${join(MUSE.dir, "a")}'`, `rm '${join(MUSE.dir, "b")}'`]);
		expect(log).toEqual([`[projector] muse created ${MUSE.dir}`, "[projector] muse link-new a", "[projector] muse link-new b"]);
	});

	test("a missing root without create gets no actions and is not created", () => {
		skill(LIB, "a");
		const GONE: Root = { id: "gone", dir: join(T, "gone"), surface: "cursor", mode: "link" };
		expect(plan([inventory(GONE)], libraryNames(LIB), dirs())).toEqual([]);
		expect(existsSync(GONE.dir)).toBe(false);
	});
});

describe("repoint-only root (OpenClaw)", () => {
	test("exports links for library names are repointed; absent names and library links get no action; other names untouched", async () => {
		for (const n of ["exp", "done", "absent"]) skill(LIB, n);
		skill(EXP, "exp");
		skill(EXP, "catalog-only");
		const OC: Root = { id: "openclaw", dir: join(T, "openclaw"), surface: "claude-code", mode: "repoint-only" };
		mkdirSync(OC.dir);
		symlinkSync(join(EXP, "exp"), join(OC.dir, "exp"));
		symlinkSync(join(EXP, "catalog-only"), join(OC.dir, "catalog-only"));
		symlinkSync(join(LIB, "done"), join(OC.dir, "done"));
		skill(OC.dir, "openclaw-own");
		const actions = plan([inventory(OC)], libraryNames(LIB), dirs());
		expect(actions.map((a) => [a.kind, a.name])).toEqual([["repoint", "exp"]]);
		const warnings: WarningEvent[] = [];
		expect(await apply(actions, ctx(warnings))).toEqual({ actions: 1, warnings: 0 });
		expect(readlinkSync(join(OC.dir, "exp"))).toBe(join(LIB, "exp"));
		expect(readlinkSync(join(OC.dir, "catalog-only"))).toBe(join(EXP, "catalog-only"));
		expect(readlinkSync(join(OC.dir, "done"))).toBe(join(LIB, "done"));
		expect(existsSync(join(OC.dir, "absent"))).toBe(false);
		expect(plan([inventory(OC)], libraryNames(LIB), dirs())).toEqual([]);
	});
});

describe("activeRoots", () => {
	test("a root with an enable flag is active only while the flag exists; others always", () => {
		const flag = join(T, "enable-cursor-root");
		const cursor: Root = { id: "cursor", dir: join(T, "cursor"), surface: "cursor", mode: "link", enableFlag: flag };
		expect(activeRoots([CLAUDE, cursor]).map((r) => r.id)).toEqual(["claude"]);
		writeFileSync(flag, "");
		expect(activeRoots([CLAUDE, cursor]).map((r) => r.id)).toEqual(["claude", "cursor"]);
	});
});

describe("Grok stray real dirs (Pitfall 12)", () => {
	test("a real dir that is neither a library name nor known → one deduped stray-real-dir warning; known names and files → nothing", async () => {
		skill(LIB, "lib");
		symlinkSync(join(LIB, "lib"), join(GROK.dir, "lib"));
		skill(GROK.dir, "runpod");
		writeFileSync(join(GROK.dir, "README.md"), "# grok\n");
		writeFileSync(join(GROK.dir, "loose-file.md"), "x");
		skill(GROK.dir, "grok-habit");
		skill(CLAUDE.dir, "claude-own");
		const actions = plan([inventory(CLAUDE), inventory(GROK)], libraryNames(LIB), dirs());
		expect(actions.map((a) => [a.root.id, a.kind, a.name, a.kind === "skip-warn" ? a.reason : ""])).toEqual([
			["claude", "link-new", "lib", ""],
			["grok", "skip-warn", "grok-habit", "stray-real-dir"],
		]);
		const warnings: WarningEvent[] = [];
		expect(await apply(actions, ctx(warnings))).toEqual({ actions: 1, warnings: 1 });
		expect(warnings.map((w) => [w.surface, w.payload.root, w.payload.name, w.payload.reason])).toEqual([
			["grok-build", "grok", "grok-habit", "stray-real-dir"],
		]);
		expect(lstatSync(join(GROK.dir, "grok-habit")).isDirectory()).toBe(true);
		expect(await apply(plan([inventory(CLAUDE), inventory(GROK)], libraryNames(LIB), dirs()), ctx(warnings))).toEqual({
			actions: 0,
			warnings: 0,
		});
		expect(warnings.length).toBe(1);
	});
});
