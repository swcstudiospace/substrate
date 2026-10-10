import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bridgeEnvFindings,
	defaultPaths,
	dirtyPaths,
	doctor,
	gitArgv,
	hermesApprovalFindings,
	libraryFindings,
	monitorScriptFindings,
	ompLinkFindings,
	OMP_LINK_TARGET,
	projectionFindings,
	realDeps,
	run,
	type DoctorDeps,
} from "./skills-doctor.ts";

const repoRoot = join(import.meta.dir, "..");

function git(dir: string, args: readonly string[]): void {
	const result = spawnSync("git", [...args], { cwd: dir, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	}
}

/** A library checkout with no remote: any fetch attempt fails, so green runs prove local-refs-only. */
function fixtureLibrary(): string {
	const dir = mkdtempSync(join(tmpdir(), "skills-doctor-lib-"));
	git(dir, ["init", "-b", "main"]);
	git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"]);
	git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	return dir;
}

function fixtureHome(): string {
	const home = mkdtempSync(join(tmpdir(), "skills-doctor-home-"));
	mkdirSync(join(home, ".hermes/cron"), { recursive: true });
	mkdirSync(join(home, ".hermes/scripts"), { recursive: true });
	mkdirSync(join(home, ".omp/agent/extensions"), { recursive: true });
	writeFileSync(join(home, ".hermes/config.yaml"), "skills:\n  write_approval: true\nmemory:\n  write_approval: true\n");
	writeFileSync(
		join(home, ".hermes/cron/jobs.json"),
		JSON.stringify({ jobs: [{ name: "substrate-skill-miner", monitor_script: "substrate-skill-miner-monitor.sh" }] }),
	);
	writeFileSync(
		join(home, ".hermes/scripts/substrate-skill-miner-monitor.sh"),
		readFileSync(join(repoRoot, "packages/miner/hermes/substrate-skill-miner-monitor.sh"), "utf8"),
	);
	symlinkSync(OMP_LINK_TARGET, join(home, ".omp/agent/extensions/substrate-skills.ts"));
	return home;
}

describe("dirtyPaths", () => {
	test("untracked pycache and pyc noise is ignored but tracked changes refuse", () => {
		expect(dirtyPaths("?? parallel-common/scripts/__pycache__/x.pyc\n?? notes/__pycache__/\n")).toEqual([]);
		expect(dirtyPaths("?? notes/todo.md\n")).toEqual(["notes/todo.md"]);
		expect(dirtyPaths("?? __pycache__-notes.md\n")).toEqual(["__pycache__-notes.md"]);
		expect(dirtyPaths(" M tracked.pyc\n")).toEqual(["tracked.pyc"]);
		expect(dirtyPaths("")).toEqual([]);
	});

	test("git argv disables optional locks", () => {
		expect(gitArgv("/src", ["status", "--porcelain"])).toEqual([
			"--no-optional-locks",
			"-C",
			"/src",
			"status",
			"--porcelain",
		]);
	});
});

describe("hermesApprovalFindings", () => {
	test("both flags true is clean and never repeats a value", () => {
		const text =
			"skills:\n  write_approval: true\nmemory:\n  write_approval: true\nextra:\n  token: hunter2-planted-secret\n";
		const findings = hermesApprovalFindings(text);
		expect(findings).toEqual([]);
	});

	test("a false flag names the flag, not its value", () => {
		const findings = hermesApprovalFindings("skills:\n  write_approval: false\nmemory:\n  write_approval: true\n");
		expect(findings.map((finding) => finding.code)).toEqual(["hermes-approval"]);
		expect(findings[0]?.detail).toContain("skills.write_approval");
		expect(JSON.stringify(findings)).not.toContain("false");
	});

	test("an unreadable config is a finding", () => {
		expect(hermesApprovalFindings(null).map((finding) => finding.code)).toEqual(["hermes-approval"]);
	});
});

describe("bridgeEnvFindings", () => {
	test("a tokenless env file is clean", () => {
		expect(bridgeEnvFindings("/etc/substrate/substrate-bridge.env", "SUBSTRATE_URL=http://127.0.0.1:7410\n")).toEqual(
			[],
		);
	});

	test("a single-token variable names the variable and never its value", () => {
		for (const name of ["SUBSTRATE_TOKEN", "SUBSTRATE_TOKEN_FILE"] as const) {
			const findings = bridgeEnvFindings(
				"/etc/substrate/substrate-bridge.env",
				`${name}=hunter2-bridge-secret\n`,
			);
			expect(findings.map((finding) => finding.code)).toEqual(["bridge-env"]);
			expect(findings[0]?.detail).toContain(name);
			expect(JSON.stringify(findings)).not.toContain("hunter2-bridge-secret");
		}
	});

	test("a missing env file is a finding", () => {
		expect(bridgeEnvFindings("/etc/substrate/substrate-bridge.env", null).map((finding) => finding.code)).toEqual([
			"bridge-env",
		]);
	});
});

describe("libraryFindings", () => {
	test("a clean main checkout at origin/main is clean and never fetches", () => {
		const dir = fixtureLibrary();
		const seen: string[][] = [];
		const base = realDeps();
		const deps: DoctorDeps = {
			...base,
			git: (target, args) => {
				seen.push([...args]);
				return base.git(target, args);
			},
		};
		const paths = defaultPaths(
			{ SUBSTRATE_SKILLS_LIBRARY: dir } as NodeJS.ProcessEnv,
			repoRoot,
		);
		expect(libraryFindings(paths, deps)).toEqual([]);
		expect(seen.flat()).not.toContain("fetch");
	});

	test("dirty, branch and position each report without values", () => {
		const dir = fixtureLibrary();
		const base = realDeps();
		const paths = defaultPaths(
			{ SUBSTRATE_SKILLS_LIBRARY: dir } as NodeJS.ProcessEnv,
			repoRoot,
		);
		writeFileSync(join(dir, "draft.md"), "unreviewed\n");
		mkdirSync(join(dir, "pkg/__pycache__"), { recursive: true });
		writeFileSync(join(dir, "pkg/__pycache__/cached.pyc"), "noise");
		const dirty = libraryFindings(paths, base);
		expect(dirty.map((finding) => finding.code)).toEqual(["library-dirty"]);
		expect(dirty[0]?.detail).toContain("draft.md");

		git(dir, ["checkout", "-b", "feature"]);
		const branched = libraryFindings(paths, base);
		expect(branched.map((finding) => finding.code)).toContain("library-branch");

		git(dir, ["checkout", "main"]);
		git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "ahead"]);
		const ahead = libraryFindings(paths, base);
		expect(ahead.map((finding) => finding.code)).toContain("library-position");
		expect(ahead.find((finding) => finding.code === "library-position")?.detail).toContain("1 ahead");
	});
});

describe("ompLinkFindings", () => {
	test("the release target is clean, anything else is a finding", () => {
		const home = fixtureHome();
		const base = realDeps();
		// The fixture link names the release path. This sandbox has no
		// /opt/agent-substrate tree, so readability is stubbed for the clean case.
		const deps: DoctorDeps = {
			...base,
			readFile: (path) => (path === OMP_LINK_TARGET ? "extension\n" : base.readFile(path)),
		};
		const paths = defaultPaths({ HOME: home } as NodeJS.ProcessEnv, repoRoot);
		expect(ompLinkFindings(paths, deps)).toEqual([]);
		expect(ompLinkFindings(defaultPaths({ HOME: join(home, "missing") } as NodeJS.ProcessEnv, repoRoot), base).map(
			(finding) => finding.code,
		)).toEqual(["omp-link"]);
	});

	test("a link that names the release copy but cannot be read is a finding", () => {
		const deps: DoctorDeps = {
			...realDeps(),
			readLink: () => OMP_LINK_TARGET,
			readFile: () => null,
		};
		const findings = ompLinkFindings(defaultPaths({} as NodeJS.ProcessEnv, repoRoot), deps);
		expect(findings.map((finding) => finding.code)).toEqual(["omp-link"]);
		expect(findings[0]?.detail).toContain("not readable");
	});
});

describe("monitorScriptFindings", () => {
	test("the release copy is clean, a stale copy is a finding", () => {
		const home = fixtureHome();
		const base = realDeps();
		const paths = defaultPaths({ HOME: home } as NodeJS.ProcessEnv, repoRoot);
		expect(monitorScriptFindings(paths, base)).toEqual([]);
		writeFileSync(join(home, ".hermes/scripts/substrate-skill-miner-monitor.sh"), "#!/bin/sh\n# stale\n");
		const stale = monitorScriptFindings(paths, base);
		expect(stale.map((finding) => finding.code)).toEqual(["monitor-script"]);
		expect(JSON.stringify(stale)).not.toContain("stale");
	});
});

describe("projectionFindings", () => {
	test("exit 0 is clean, 1 names drift, anything else is a failed check", () => {
		const base = realDeps();
		expect(projectionFindings({ ...base, projectorCheck: () => ({ status: 0, stdout: "", stderr: "" }) })).toEqual(
			[],
		);
		const drift = projectionFindings({
			...base,
			projectorCheck: () => ({ status: 1, stdout: "[projector] would link grok demo\n", stderr: "" }),
		});
		expect(drift.map((finding) => finding.code)).toEqual(["projection-drift"]);
		const failed = projectionFindings({
			...base,
			projectorCheck: () => ({ status: 2, stdout: "", stderr: "boom" }),
		});
		expect(failed.map((finding) => finding.code)).toEqual(["projection-drift"]);
		expect(JSON.stringify(failed)).not.toContain("boom");
	});
});

describe("run", () => {
	test("a fully green fixture exits 0 and an unknown argument exits 2", () => {
		const dir = fixtureLibrary();
		const home = fixtureHome();
		const bridgeEnv = join(mkdtempSync(join(tmpdir(), "skills-doctor-env-")), "skills-bridge.env");
		writeFileSync(bridgeEnv, "SUBSTRATE_URL=http://127.0.0.1:7410\n");
		const base = realDeps();
		const env = {
			HOME: home,
			SUBSTRATE_SKILLS_LIBRARY: dir,
			SUBSTRATE_SKILLS_BRIDGE_ENV: bridgeEnv,
		} as NodeJS.ProcessEnv;
		const green: DoctorDeps = {
			...base,
			projectorCheck: () => ({ status: 0, stdout: "", stderr: "" }),
			readFile: (path) => (path === OMP_LINK_TARGET ? "extension\n" : base.readFile(path)),
		};
		const paths = defaultPaths(env, repoRoot);
		expect(doctor(paths, green)).toEqual([]);
		expect(run(["--bogus"], env, green)).toBe(2);
		expect(run(["--help"], env, green)).toBe(0);
	});
});
