#!/usr/bin/env bun
/**
 * Read-only pre-flight doctor for the skills plane (D22-21).
 *
 *   bun run skills:doctor
 *
 * Reports six areas and exits 1 on any finding:
 *   1. library checkout state: clean modulo D22-02 (`__pycache__`/`.pyc`
 *      untracked noise is ignored), on `main`, ahead/behind `origin/main`
 *      from local refs only — no fetch, ever.
 *   2. projection drift: `skills.ts --check` (argv, never a shell).
 *   3. the Omp extension symlink target.
 *   4. the Hermes approval flags (`skills.write_approval`,
 *      `memory.write_approval`) read from `~/.hermes/config.yaml`.
 *   5. the monitor script path when it can be read from Hermes' job file,
 *      compared byte-for-byte with the release copy.
 *   6. the bridge env-file rule (D22-09): no single-token variable.
 *
 * It never calls systemd, GitHub or the substrate, never prints a secret
 * value (findings name variables, paths and counts only), and writes nothing.
 * Seams for tests and the operator: `SUBSTRATE_SKILLS_LIBRARY` moves the
 * library checkout, `HOME` moves the Hermes and Omp paths, and
 * `SUBSTRATE_SKILLS_BRIDGE_ENV` moves the bridge env file.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { effectivePorcelain } from "../packages/projector/src/skills-sync.ts";

export type FindingCode =
	| "library-dirty"
	| "library-branch"
	| "library-position"
	| "projection-drift"
	| "omp-link"
	| "hermes-approval"
	| "monitor-script"
	| "bridge-env";

export interface Finding {
	code: FindingCode;
	detail: string;
}

export interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export interface DoctorDeps {
	git: (dir: string, args: readonly string[]) => RunResult;
	projectorCheck: () => RunResult;
	readFile: (path: string) => string | null;
	readLink: (path: string) => string | null;
}

export interface DoctorPaths {
	libraryDir: string;
	homeDir: string;
	repoRoot: string;
	bridgeEnvFile: string;
}

export const LIBRARY_DIR_DEFAULT = "/root/agent-skills";
export const HOME_DEFAULT = "/root";
export const BRIDGE_ENV_DEFAULT = "/etc/substrate/substrate-bridge.env";
export const OMP_LINK_REL = ".omp/agent/extensions/substrate-skills.ts";
export const OMP_LINK_TARGET = "/opt/agent-substrate/current/packages/projector/omp/substrate-skills.ts";
export const HERMES_CONFIG_REL = ".hermes/config.yaml";
export const HERMES_JOBS_REL = ".hermes/cron/jobs.json";
export const HERMES_SCRIPTS_REL = ".hermes/scripts";
export const MINER_JOB_NAME = "substrate-skill-miner";
export const MONITOR_SCRIPT_RELEASE_REL = "packages/miner/hermes/substrate-skill-miner-monitor.sh";
/** The refusal the bridge prints; the doctor looks for the variable names only. */
export const SINGLE_TOKEN_VARS = ["SUBSTRATE_TOKEN", "SUBSTRATE_TOKEN_FILE"] as const;

export function defaultPaths(env: NodeJS.ProcessEnv, repoRoot: string): DoctorPaths {
	return {
		libraryDir: env.SUBSTRATE_SKILLS_LIBRARY?.trim() || LIBRARY_DIR_DEFAULT,
		homeDir: env.HOME?.trim() || HOME_DEFAULT,
		repoRoot,
		bridgeEnvFile: env.SUBSTRATE_SKILLS_BRIDGE_ENV?.trim() || BRIDGE_ENV_DEFAULT,
	};
}

export function realDeps(): DoctorDeps {
	return {
		git: (dir, args) => {
			const result = spawnSync("git", gitArgv(dir, args), { encoding: "utf8" });
			return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		},
		projectorCheck: () => {
			const entry = join(import.meta.dir, "..", "packages/projector/src/skills.ts");
			const result = spawnSync("bun", [entry, "--check"], { encoding: "utf8" });
			return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		},
		readFile: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
		readLink: (path) => {
			try {
				return readlinkSync(path, "utf8");
			} catch {
				return null;
			}
		},
	};
}

/**
 * Untracked (`??`) `__pycache__` paths and `.pyc` files are ignored (D22-02:
 * skill scripts run through the projected links write caches into the
 * checkout). Anything else — including a tracked `.pyc` — is dirty.
 */
/** The argv `realDeps` gives git: no optional index lock, then `-C dir`, then the caller's args. */
export function gitArgv(dir: string, args: readonly string[]): string[] {
	return ["--no-optional-locks", "-C", dir, ...args];
}

/**
 * Paths the sync would refuse. The ignore rule is the sync's own parser
 * (`effectivePorcelain`): a `__pycache__` path segment or a `.pyc` suffix,
 * not the substring, so `__pycache__-notes.md` stays dirty.
 */
export function dirtyPaths(porcelain: string): string[] {
	const cleaned = effectivePorcelain(porcelain);
	if (cleaned === "") return [];
	const bad: string[] = [];
	for (const line of cleaned.split("\n")) {
		if (line === "") continue;
		const path = line.slice(3).trim();
		if (path !== "") bad.push(path);
	}
	return bad;
}

export function libraryFindings(paths: DoctorPaths, deps: DoctorDeps): Finding[] {
	const findings: Finding[] = [];
	const status = deps.git(paths.libraryDir, ["status", "--porcelain", "--untracked-files=all"]);
	if (status.status !== 0) {
		findings.push({ code: "library-dirty", detail: `cannot read the library checkout at ${paths.libraryDir}` });
		return findings;
	}
	const dirty = dirtyPaths(status.stdout);
	if (dirty.length > 0) {
		const shown = dirty.slice(0, 5).join(", ");
		const more = dirty.length > 5 ? ` and ${dirty.length - 5} more` : "";
		findings.push({ code: "library-dirty", detail: `library checkout is dirty: ${shown}${more}` });
	}
	const branch = deps.git(paths.libraryDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const name = (branch.stdout ?? "").trim();
	if (branch.status !== 0 || name === "") {
		findings.push({ code: "library-branch", detail: "cannot read the library branch" });
	} else if (name !== "main") {
		findings.push({ code: "library-branch", detail: `library is on ${name}, not main` });
	}
	// Local refs only: rev-list never touches the network, so this cannot fetch.
	const position = deps.git(paths.libraryDir, ["rev-list", "--count", "--left-right", "origin/main...HEAD"]);
	if (position.status !== 0) {
		findings.push({ code: "library-position", detail: "origin/main is not a local ref" });
	} else {
		const match = /^(\d+)\s+(\d+)\s*$/.exec(position.stdout);
		if (!match) {
			findings.push({ code: "library-position", detail: "cannot read ahead/behind origin/main" });
		} else {
			const behind = Number(match[1]);
			const ahead = Number(match[2]);
			if (behind > 0 || ahead > 0) {
				findings.push({ code: "library-position", detail: `library is ${ahead} ahead and ${behind} behind origin/main` });
			}
		}
	}
	return findings;
}

export function projectionFindings(deps: DoctorDeps): Finding[] {
	const checked = deps.projectorCheck();
	if (checked.status === 0) return [];
	if (checked.status === 1) {
		// The projector's own lines name actions, roots and skill names only.
		const lines = checked.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.slice(0, 20);
		const shown = lines.length > 0 ? `: ${lines.join("; ")}` : "";
		return [{ code: "projection-drift", detail: `projection drift is pending${shown}` }];
	}
	return [{ code: "projection-drift", detail: "skills.ts --check did not run" }];
}

export function ompLinkFindings(paths: DoctorPaths, deps: DoctorDeps): Finding[] {
	const target = deps.readLink(join(paths.homeDir, OMP_LINK_REL));
	if (target === null) {
		return [{ code: "omp-link", detail: "the Omp extension link is missing or dangling" }];
	}
	if (target !== OMP_LINK_TARGET) {
		return [{ code: "omp-link", detail: `the Omp extension link points at ${target}, not the release copy` }];
	}
	// readlink succeeds for a dangling symlink. The release file has to be there.
	if (deps.readFile(target) === null) {
		return [{ code: "omp-link", detail: "the Omp extension link names the release copy, but that file is not readable" }];
	}
	return [];
}

/** Section-scoped `write_approval` flags. Names leave this function; values never do. */
export function hermesApprovalFindings(configText: string | null): Finding[] {
	if (configText === null) {
		return [{ code: "hermes-approval", detail: "the Hermes config is unreadable" }];
	}
	const flags: { skills?: string; memory?: string } = {};
	let section = "";
	for (const raw of configText.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const indent = line.length - line.trimStart().length;
		if (indent === 0) {
			const sectionMatch = /^([A-Za-z0-9_-]+)\s*:/.exec(line.trim());
			section = sectionMatch?.[1] ?? "";
			continue;
		}
		const flagMatch = /^\s*write_approval\s*:\s*(\S+)/.exec(line);
		if (flagMatch?.[1] && (section === "skills" || section === "memory")) {
			flags[section] = flagMatch[1];
		}
	}
	const findings: Finding[] = [];
	for (const sectionName of ["skills", "memory"] as const) {
		if (flags[sectionName] !== "true") {
			findings.push({ code: "hermes-approval", detail: `${sectionName}.write_approval is not true` });
		}
	}
	return findings;
}

export function monitorScriptFindings(paths: DoctorPaths, deps: DoctorDeps): Finding[] {
	const jobsText = deps.readFile(join(paths.homeDir, HERMES_JOBS_REL));
	if (jobsText === null) {
		return [{ code: "monitor-script", detail: "the Hermes job file is unreadable" }];
	}
	let jobs: unknown;
	try {
		jobs = JSON.parse(jobsText);
	} catch {
		return [{ code: "monitor-script", detail: "the Hermes job file does not parse" }];
	}
	let list: unknown;
	if (Array.isArray(jobs)) {
		list = jobs;
	} else if (jobs !== null && typeof jobs === "object" && "jobs" in jobs) {
		list = jobs.jobs;
	} else {
		return [{ code: "monitor-script", detail: "the Hermes job file has no jobs list" }];
	}
	if (!Array.isArray(list)) {
		return [{ code: "monitor-script", detail: "the Hermes job file has no jobs list" }];
	}
	const job = list.find(
		(entry) => typeof entry === "object" && entry !== null && "name" in entry && entry.name === MINER_JOB_NAME,
	);
	if (job === undefined || !("monitor_script" in job) || typeof job.monitor_script !== "string" || job.monitor_script === "") {
		return [{ code: "monitor-script", detail: "the substrate-skill-miner job names no monitor script" }];
	}
	const name = job.monitor_script.split("/").pop() ?? job.monitor_script;
	const expected = deps.readFile(join(paths.repoRoot, MONITOR_SCRIPT_RELEASE_REL));
	const actual = deps.readFile(join(paths.homeDir, HERMES_SCRIPTS_REL, name));
	if (expected === null || actual === null || actual !== expected) {
		return [{ code: "monitor-script", detail: `monitor script ${name} is not the release copy` }];
	}
	return [];
}

/** Assignment names leave this function; values never do. */
export function bridgeEnvFindings(bridgeEnvFile: string, envText: string | null): Finding[] {
	if (envText === null) {
		return [{ code: "bridge-env", detail: "the bridge env file is not installed yet" }];
	}
	let sawUrl = false;
	for (const raw of envText.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
		const eq = body.indexOf("=");
		if (eq <= 0) continue;
		const name = body.slice(0, eq).trim();
		if ((SINGLE_TOKEN_VARS as readonly string[]).includes(name)) {
			return [{ code: "bridge-env", detail: `the bridge env file defines ${name}` }];
		}
		if (name === "SUBSTRATE_URL" && body.slice(eq + 1).trim() !== "") sawUrl = true;
	}
	if (!sawUrl) {
		return [{ code: "bridge-env", detail: "the bridge env file does not set SUBSTRATE_URL" }];
	}
	return [];
}

export function doctor(paths: DoctorPaths, deps: DoctorDeps): Finding[] {
	return [
		...libraryFindings(paths, deps),
		...projectionFindings(deps),
		...ompLinkFindings(paths, deps),
		...hermesApprovalFindings(deps.readFile(join(paths.homeDir, HERMES_CONFIG_REL))),
		...monitorScriptFindings(paths, deps),
		...bridgeEnvFindings(paths.bridgeEnvFile, deps.readFile(paths.bridgeEnvFile)),
	];
}

export function formatReport(findings: readonly Finding[]): string {
	if (findings.length === 0) return "skills-doctor: no findings\n";
	const lines = [`skills-doctor: ${findings.length} finding${findings.length === 1 ? "" : "s"}`];
	for (const finding of findings) {
		lines.push(`${finding.code}\t${finding.detail}`);
	}
	return `${lines.join("\n")}\n`;
}

function usage(): string {
	return `usage: bun scripts/skills-doctor.ts [--help]

Read-only pre-flight check for the skills plane. Exit 0 when clean,
1 on any finding, 2 on a usage error. Writes nothing and never prints
a secret value.
`;
}

export function run(argv: readonly string[], env: NodeJS.ProcessEnv, deps: DoctorDeps): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(usage());
		return 0;
	}
	if (argv.length > 0) {
		process.stderr.write(`skills-doctor: unknown argument ${argv[0]}\n`);
		return 2;
	}
	const paths = defaultPaths(env, join(import.meta.dir, ".."));
	const findings = doctor(paths, deps);
	process.stdout.write(formatReport(findings));
	return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	try {
		process.exit(run(process.argv.slice(2), process.env, realDeps()));
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "doctor failed";
		process.stderr.write(`skills-doctor: ${message}\n`);
		process.exit(2);
	}
}
