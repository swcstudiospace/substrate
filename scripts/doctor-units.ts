#!/usr/bin/env bun
/**
 * Read-only check that every substrate unit starts from the pinned release.
 *
 *   bun scripts/doctor-units.ts --dry-run
 *
 * The doctor reads unit files and drop-ins. It does not call systemctl, it does
 * not open an absolute EnvironmentFile (those hold the host secrets), and it
 * does not write. `--dry-run` is the only mode; the flag is accepted so the
 * operator command matches the runbook.
 *
 * A finding is one of:
 * - dev-checkout: WorkingDirectory is the mutable /root/src/repos checkout
 *   (or any path that contains /src/repos/)
 * - missing-entry: ExecStart's entry is not in the deployed commit
 * - restart-loop: Restart=always on a unit systemd reports disabled or masked,
 *   or on a unit whose own Environment= sets a *_DISABLED switch
 * - shared-env: a collector still loads /etc/substrate/substrate.env, or a
 *   substrate unit has no EnvironmentFile of its own
 *
 * Only units named substrate-* are checked, so a directory that also contains
 * distro units is not audited by accident. Pass --all to lift that.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const RELEASE_CURRENT = "/opt/agent-substrate/current";
export const SHARED_ENV_FILE = "/etc/substrate/substrate.env";
export const DEV_CHECKOUT_MARK = "/src/repos/";

export type FindingCode = "dev-checkout" | "missing-entry" | "restart-loop" | "shared-env";

export interface Finding {
	code: FindingCode;
	unit: string;
	detail: string;
}

export interface Unit {
	name: string;
	workingDirectory: string | null;
	execStart: string | null;
	restart: string | null;
	/** Last assignment wins for a repeated key. */
	environment: ReadonlyMap<string, string>;
	environmentFiles: readonly string[];
}

interface MutableUnit {
	workingDirectory: string | null;
	execStart: string | null;
	restart: string | null;
	environment: Map<string, string>;
	environmentFiles: string[];
	section: string;
}

const FINDING_ORDER: readonly FindingCode[] = ["dev-checkout", "missing-entry", "restart-loop", "shared-env"];
const SOURCE_EXT = /\.(?:ts|tsx|js|mjs|cjs|py|sh)$/;
const INTERPRETERS = new Set(["bun", "node", "python", "python3", "bash", "sh"]);

export class DoctorError extends Error {}

export function isSubstrateUnit(name: string): boolean {
	return name.startsWith("substrate-") && name.endsWith(".service");
}

export function normalizeUnitName(name: string): string {
	const trimmed = name.trim();
	return trimmed.endsWith(".service") ? trimmed : `${trimmed}.service`;
}

/** systemd `is-enabled` / `list-unit-files` text. First column is the unit, second is the state. */
export function readEnabledState(text: string): Map<string, string> {
	const enabled = new Map<string, string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const [unit, state] = trimmed.split(/\s+/);
		if (!unit || !state) continue;
		enabled.set(normalizeUnitName(unit), state);
	}
	return enabled;
}

export function parseUnit(name: string, baseText: string, dropIns: readonly string[] = []): Unit {
	const state: MutableUnit = {
		workingDirectory: null,
		execStart: null,
		restart: null,
		environment: new Map(),
		environmentFiles: [],
		section: "",
	};
	applyUnitText(state, baseText);
	for (const text of dropIns) applyUnitText(state, text);
	return {
		name: normalizeUnitName(name),
		workingDirectory: state.workingDirectory,
		execStart: state.execStart,
		restart: state.restart,
		environment: state.environment,
		environmentFiles: state.environmentFiles,
	};
}

export function loadUnits(dir: string, includeAll = false): Unit[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		throw new DoctorError(`cannot read units directory: ${dir}`);
	}
	const units: Unit[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".service")) continue;
		if (!includeAll && !isSubstrateUnit(name)) continue;
		const base = readFileSync(join(dir, name), "utf8");
		const dropInDir = join(dir, `${name}.d`);
		const dropIns: string[] = [];
		let dropInStat: ReturnType<typeof statSync> | null = null;
		try {
			dropInStat = statSync(dropInDir);
		} catch (cause) {
			const code = cause instanceof Error && "code" in cause ? String((cause as { code?: unknown }).code) : "";
			if (code !== "ENOENT") throw new DoctorError(`cannot read drop-ins for ${name}`);
		}
		if (dropInStat?.isDirectory()) {
			for (const conf of readdirSync(dropInDir).sort()) {
				if (!conf.endsWith(".conf")) continue;
				dropIns.push(readFileSync(join(dropInDir, conf), "utf8"));
			}
		}
		const unit = parseUnit(name, base, dropIns);
		units.push({ ...unit, environment: mergeDisableFlags(dir, unit) });
	}
	return units;
}

/**
 * Relative EnvironmentFile paths are read only when they stay inside the units
 * directory, and only `*_DISABLED` assignments are kept. Absolute paths are
 * skipped: `/etc/substrate/substrate.env` holds the host secrets, and a doctor
 * run must not open or print it.
 */
function mergeDisableFlags(unitsDir: string, unit: Unit): Map<string, string> {
	const merged = new Map(unit.environment);
	let root: string;
	try {
		root = realpathSync(unitsDir);
	} catch {
		return merged;
	}
	for (const file of unit.environmentFiles) {
		if (file.startsWith("/") || file.split("/").includes("..")) continue;
		const full = join(root, file);
		let resolved: string;
		try {
			resolved = realpathSync(full);
		} catch {
			continue;
		}
		if (resolved !== root && !resolved.startsWith(root + sep)) continue;
		let text: string;
		try {
			text = readFileSync(resolved, "utf8");
		} catch {
			continue;
		}
		for (const [key, value] of parseDisableAssignments(text)) {
			merged.set(key, value);
		}
	}
	return merged;
}

export function parseDisableAssignments(text: string): Map<string, string> {
	const flags = new Map<string, string>();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const value = stripQuotes(line.slice(eq + 1).trim());
		if (!/_DISABLED$/.test(key)) continue;
		flags.set(key, value);
	}
	return flags;
}

export function diagnose(
	units: readonly Unit[],
	tree: ReadonlySet<string>,
	enabled: ReadonlyMap<string, string> = new Map(),
): Finding[] {
	const findings: Finding[] = [];
	for (const unit of units) {
		if (unit.workingDirectory === null || unit.workingDirectory.trim() === "") {
			findings.push({ code: "dev-checkout", unit: unit.name, detail: "WorkingDirectory is unset" });
		} else if (isDevCheckout(unit.workingDirectory)) {
			findings.push({
				code: "dev-checkout",
				unit: unit.name,
				detail: `WorkingDirectory=${unit.workingDirectory}`,
			});
		}
		const entry = unit.execStart === null ? null : locatedEntry(unit.workingDirectory, entryFromExecStart(unit.execStart));
		if (unit.execStart === null || entry === null) {
			findings.push({ code: "missing-entry", unit: unit.name, detail: "ExecStart has no entry file" });
		} else {
			const present = entryExists(entry, tree);
			if (!present) {
				findings.push({
					code: "missing-entry",
					unit: unit.name,
					detail: entry.kind === "module" ? `python module ${entry.module}` : entry.path,
				});
			}
		}
		const loop = restartLoopDetail(unit, enabled);
		if (loop !== null) {
			findings.push({ code: "restart-loop", unit: unit.name, detail: loop });
		}
		const shared = sharedEnvDetail(unit);
		if (shared !== null) {
			findings.push({ code: "shared-env", unit: unit.name, detail: shared });
		}
	}
	findings.sort((a, b) => a.unit.localeCompare(b.unit) || FINDING_ORDER.indexOf(a.code) - FINDING_ORDER.indexOf(b.code));
	return findings;
}

export function listGitTree(repo: string, commit: string): Set<string> {
	if (commit.startsWith("-") || /[\0\r\n]/.test(commit)) {
		throw new DoctorError("commit revision is not a safe git argument");
	}
	const peeled = git(["-C", repo, "rev-parse", "--verify", `${commit}^{commit}`]);
	const sha = peeled.trim();
	if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) {
		throw new DoctorError("git rev-parse did not return a commit");
	}
	const listed = git(["-C", repo, "ls-tree", "-r", "--name-only", sha]);
	return new Set(listed.split("\n").filter((line) => line !== ""));
}

/** Files under a built release. `node_modules` is skipped; symlinks that leave the tree are not followed. */
export function listReleaseTree(release: string): Set<string> {
	let root: string;
	try {
		root = realpathSync(release);
	} catch {
		throw new DoctorError(`release directory does not exist: ${release}`);
	}
	const tree = new Set<string>();
	function inside(resolved: string): boolean {
		return resolved === root || resolved.startsWith(`${root}${sep}`);
	}
	// `stack` is the realpath chain for this walk. A directory link is walked
	// at the link path so `alias/src/index.ts` is recorded as well as the real
	// path. A link back to a realpath already on this chain stops, so `loop -> .`
	// cannot recurse.
	function walk(dir: string, stack: string[]): void {
		let realDir: string;
		try {
			realDir = realpathSync(dir);
		} catch {
			return;
		}
		if (!inside(realDir) || stack.includes(realDir)) return;
		stack.push(realDir);
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name === "node_modules" || entry.name === ".git") continue;
				const full = join(dir, entry.name);
				if (entry.isSymbolicLink()) {
					let resolved: string;
					try {
						resolved = realpathSync(full);
					} catch {
						continue;
					}
					if (!inside(resolved)) continue;
					let st;
					try {
						st = statSync(resolved);
					} catch {
						continue;
					}
					if (st.isDirectory()) {
						walk(full, stack);
						continue;
					}
					const linkPath = relative(root, full).split(sep).join("/");
					if (linkPath !== "") tree.add(linkPath);
					continue;
				}
				if (entry.isDirectory()) walk(full, stack);
				else tree.add(relative(root, full).split(sep).join("/"));
			}
		} finally {
			stack.pop();
		}
	}
	walk(root, []);
	return tree;
}

export function formatReport(findings: readonly Finding[]): string {
	if (findings.length === 0) return "unit doctor: no findings\n";
	const lines = [`unit doctor: ${findings.length} finding${findings.length === 1 ? "" : "s"}`];
	for (const finding of findings) {
		lines.push(`${finding.code}\t${finding.unit}\t${finding.detail}`);
	}
	return `${lines.join("\n")}\n`;
}

type Entry = { kind: "path"; path: string; absolute: boolean } | { kind: "module"; module: string };

function locatedEntry(workingDirectory: string | null, entry: Entry | null): Entry | null {
	if (entry === null || entry.kind === "module") return entry;
	// An absolute ExecStart is already a repo path. Joining WorkingDirectory again
	// turns /opt/.../current/packages/.../index.ts under a nested directory into a miss.
	if (entry.absolute) return entry;
	const path = qualify(workingDirectory, entry.path);
	return path === null ? null : { kind: "path", path, absolute: false };
}

/** A relative entry is repo-root-relative when WorkingDirectory is the checkout root, and nested under it otherwise. */
function qualify(workingDirectory: string | null, entryPath: string): string | null {
	if (workingDirectory === null) return entryPath;
	const dir = workingDirectory.replace(/\/+$/, "");
	const roots = [RELEASE_CURRENT, "/root/src/repos/agent-substrate"];
	for (const root of roots) {
		if (dir === root) return entryPath;
		if (dir.startsWith(`${root}/`)) return repoJoin(dir.slice(root.length + 1), entryPath);
	}
	const nested = /^\/opt\/agent-substrate\/releases\/[0-9a-f]{40}(?:[0-9a-f]{24})?(?:\/(.*))?$/.exec(dir);
	if (nested) return nested[1] ? repoJoin(nested[1], entryPath) : entryPath;
	return entryPath;
}

function repoJoin(prefix: string, entryPath: string): string | null {
	const parts: string[] = [];
	for (const part of `${prefix}/${entryPath}`.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") return null;
		parts.push(part);
	}
	return parts.length === 0 ? null : parts.join("/");
}

export function entryFromExecStart(execStart: string): Entry | null {
	const tokens = splitCommand(execStart);
	if (tokens.length === 0) return null;
	let index = 0;
	const first = tokens[0] ?? "";
	const base = first.split("/").pop() ?? first;
	if (INTERPRETERS.has(base) || (first.startsWith("/") && !SOURCE_EXT.test(first))) index = 1;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (token === "-m") {
			const moduleName = tokens[index + 1];
			if (!moduleName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName)) return null;
			return { kind: "module", module: moduleName };
		}
		if (token.startsWith("-")) {
			index += 1;
			continue;
		}
		const absolute = token.startsWith("/");
		const path = repoPath(token);
		if (path === null) return null;
		return { kind: "path", path, absolute };
	}
	return null;
}

export function isDevCheckout(workingDirectory: string | null): boolean {
	if (workingDirectory === null || workingDirectory.trim() === "") return false;
	const path = workingDirectory.replace(/\/+$/, "");
	return path === "/root/src/repos" || path.includes(DEV_CHECKOUT_MARK);
}

function entryExists(entry: Entry, tree: ReadonlySet<string>): boolean {
	if (entry.kind === "module") {
		const suffix = `${entry.module}/__main__.py`;
		for (const path of tree) {
			if (path === suffix || path.endsWith(`/${suffix}`)) return true;
		}
		return false;
	}
	return tree.has(entry.path);
}

function restartLoopDetail(unit: Unit, enabled: ReadonlyMap<string, string>): string | null {
	if (unit.restart !== "always") return null;
	const state = enabled.get(unit.name);
	if (state === "disabled" || state === "masked" || state === "disabled-runtime" || state === "masked-runtime") {
		return `Restart=always while systemd reports ${state}`;
	}
	for (const [key, value] of unit.environment) {
		if (/_DISABLED$/.test(key) && /^(1|true|yes)$/i.test(value)) {
			return `Restart=always while ${key}=${value}`;
		}
	}
	return null;
}

function sharedEnvDetail(unit: Unit): string | null {
	if (unit.environmentFiles.length === 0) return "EnvironmentFile is unset";
	if (unit.name.includes("collector") && unit.environmentFiles.includes(SHARED_ENV_FILE)) {
		return `EnvironmentFile=${SHARED_ENV_FILE}`;
	}
	return null;
}

function repoPath(token: string): string | null {
	let path = token;
	if (path.startsWith("/")) {
		const prefixes = [`${RELEASE_CURRENT}/`, "/root/src/repos/agent-substrate/"];
		const matched = prefixes.find((prefix) => path.startsWith(prefix));
		if (matched) path = path.slice(matched.length);
		else {
			const release = /^\/opt\/agent-substrate\/releases\/[0-9a-f]{40}(?:[0-9a-f]{24})?\/(.+)$/.exec(path);
			if (!release?.[1]) return null;
			path = release[1];
		}
	}
	if (path.startsWith("./")) path = path.slice(2);
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") return null;
		parts.push(part);
	}
	return parts.length === 0 ? null : parts.join("/");
}

function applyUnitText(state: MutableUnit, text: string): void {
	for (const line of logicalLines(text)) {
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const section = /^\[([^\]]+)\]$/.exec(line);
		if (section?.[1]) {
			state.section = section[1];
			continue;
		}
		if (state.section !== "Service") continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		applyDirective(state, key, value);
	}
}

function applyDirective(state: MutableUnit, key: string, value: string): void {
	switch (key) {
		case "WorkingDirectory":
			state.workingDirectory = value === "" ? null : stripQuotes(value);
			return;
		case "ExecStart":
			state.execStart = value === "" ? null : value;
			return;
		case "Restart":
			state.restart = value === "" ? null : value;
			return;
		case "Environment":
			if (value === "") {
				state.environment.clear();
				return;
			}
			for (const assignment of splitAssignments(value)) {
				state.environment.set(assignment[0], assignment[1]);
			}
			return;
		case "EnvironmentFile":
			if (value === "") {
				state.environmentFiles = [];
				return;
			}
			state.environmentFiles.push(environmentFilePath(value));
			return;
		default:
			return;
	}
}

function environmentFilePath(value: string): string {
	const stripped = stripQuotes(value);
	// A leading "-" marks the file optional. The path is still the file that would be loaded.
	return stripped.startsWith("-/") ? stripped.slice(1) : stripped;
}

/** Unit-file lines with `\`-continuations joined. Shared with the runtime doctor, which scans the same files for ceilings. */
export function logicalLines(text: string): string[] {
	const lines: string[] = [];
	let pending = "";
	for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const piece = raw.trim();
		if (piece.endsWith("\\") && !piece.endsWith("\\\\")) {
			pending = `${pending}${piece.slice(0, -1)} `;
			continue;
		}
		lines.push(`${pending}${piece}`.trim());
		pending = "";
	}
	if (pending !== "") lines.push(pending.trim());
	return lines;
}

function splitCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (const ch of command) {
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === " " || ch === "\t") {
			if (current !== "") tokens.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current !== "") tokens.push(current);
	return tokens;
}

function splitAssignments(value: string): Array<[string, string]> {
	const assignments: Array<[string, string]> = [];
	for (const token of splitCommand(value)) {
		const eq = token.indexOf("=");
		if (eq <= 0) continue;
		assignments.push([token.slice(0, eq), token.slice(eq + 1)]);
	}
	return assignments;
}

function stripQuotes(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}

function git(args: readonly string[]): string {
	const result = spawnSync("git", args, { encoding: "utf8" });
	if (result.error) throw new DoctorError(`git failed to start: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || "").trim();
		throw new DoctorError(detail === "" ? "git failed" : detail);
	}
	return result.stdout;
}

interface Options {
	dryRun: boolean;
	unitsDir: string;
	repo: string;
	commit: string;
	release: string | null;
	enabledState: string | null;
	includeAll: boolean;
}

function parseArgs(argv: readonly string[]): Options {
	const repoRoot = join(import.meta.dir, "..");
	const options: Options = {
		dryRun: true,
		unitsDir: join(repoRoot, "infra/vps"),
		repo: repoRoot,
		commit: "HEAD",
		release: null,
		enabledState: null,
		includeAll: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		switch (arg) {
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--all":
				options.includeAll = true;
				break;
			case "--help":
			case "-h":
				process.stdout.write(usage());
				process.exit(0);
				break;
			case "--units":
			case "--repo":
			case "--commit":
			case "--release":
			case "--enabled-state": {
				const value = argv[i + 1];
				if (!value || value.startsWith("--")) throw new DoctorError(`${arg} needs a value`);
				i += 1;
				if (arg === "--units") options.unitsDir = value;
				else if (arg === "--repo") options.repo = value;
				else if (arg === "--commit") options.commit = value;
				else if (arg === "--release") options.release = value;
				else options.enabledState = value;
				break;
			}
			default:
				throw new DoctorError(`unknown argument ${arg}`);
		}
	}
	return options;
}

function usage(): string {
	return `usage: bun scripts/doctor-units.ts [--dry-run] [--units dir] [--repo dir] [--commit rev] [--release dir] [--enabled-state file] [--all]

Reads substrate unit files and prints findings. Default mode is read-only.
Exit 0 when there are no findings, 1 when there are, 2 on a usage or git error.
`;
}

function run(argv: readonly string[]): number {
	const options = parseArgs(argv);
	if (!options.dryRun) throw new DoctorError("the unit doctor is read-only");
	process.stderr.write("unit doctor: dry-run\n");
	const units = loadUnits(options.unitsDir, options.includeAll);
	if (units.length === 0) throw new DoctorError(`no substrate units in ${options.unitsDir}`);
	const tree = options.release === null ? listGitTree(options.repo, options.commit) : listReleaseTree(options.release);
	const enabled =
		options.enabledState === null ? new Map<string, string>() : readEnabledState(readFileSync(options.enabledState, "utf8"));
	const findings = diagnose(units, tree, enabled);
	process.stdout.write(formatReport(findings));
	return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	try {
		process.exit(run(process.argv.slice(2)));
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "doctor failed";
		process.stderr.write(`unit doctor: ${message}\n`);
		process.exit(2);
	}
}
