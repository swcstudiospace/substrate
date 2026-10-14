#!/usr/bin/env bun
/**
 * Project the shared skills library into each agent's skill root (D-05, D-06, D-20).
 *
 *   bun packages/projector/src/skills.ts [--check] [--root <id>]
 *
 * Every library skill `<LIBRARY_DIR>/<name>` becomes a per-skill symlink `<root>/<name>`. A planner
 * turns the roots' inventories into actions; an executor applies them:
 *   - link-new          — the name is absent: link it (mode link only; repoint-only roots never gain links);
 *   - repoint           — a link into the docs-scraper exports dir: point it at the library instead;
 *   - backup-then-link  — a real directory byte-identical to the library copy (ignoring __pycache__/
 *                         and *.pyc): copy it to `<backupDir>/<root-id>/<name>/` with a MANIFEST line
 *                         per file and a RESTORE line, then replace it by the link;
 *   - remove-own-link   — the root's disableFlag exists: remove the links this projector owns there
 *                         (`<root>/<name>` → `<LIBRARY_DIR>/<name>`) and do nothing else in that root;
 *   - skip-warn         — a differing real directory (real-dir-differs), a link elsewhere
 *                         (foreign-link), or in a root with `knownReal` (Grok) a real directory that is
 *                         neither a library name nor known (stray-real-dir, Pitfall 12): never touched,
 *                         one deduped `warning` event per (root, name, reason).
 * Other non-library names (README.md, an agent's own skills) are never looked at.
 *
 * Flags are read at run time: a root with `enableFlag` takes part only while that file exists, and a
 * root with `disableFlag` switches to removing its own links while that file exists. A missing root
 * is skipped unless it is marked `create`, in which case it is created 0755 before its first link.
 *
 * Links are replaced atomically (`<name>.substrate-tmp` + rename). Before each change the executor
 * appends its undo line to `<backupDir>/RESTORE.md` (backupDir created 0700 on the first change).
 * `--check` exits 1 when any change is pending and writes nothing; skip-warn entries are not drift.
 * With nothing pending it prints an "already current" line and exits 0.
 *
 * `SUBSTRATE_SKILLS_GOVERNANCE=off|report|enforce` (default off) adds approval gating — see
 * skills-governance.ts: `report` projects everything and warns once about unapproved skills,
 * `enforce` holds back NEW links for unapproved skills and never unlinks anything.
 */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SKILL_NAME_RE } from "../../mcp-server/src/skills/propose.ts";
import {
	evaluateGovernance,
	type GovernanceOptions,
	type GovernanceRun,
	governanceFromEnv,
	governancePaths,
	resolveSurfaceToken,
	usesHostJobToken,
	RENOTIFY_MS,
	reportGovernance,
	skillsGovernanceConfigWarnings,
} from "./skills-governance.ts";
import type { EventInput, Surface } from "../../mcp-server/src/types.ts";

export interface Root {
	id: string;
	dir: string;
	/** Surface of this root's warning events (OpenClaw has none of its own; payload.root names it). */
	surface: Surface;
	/** link: add, repoint and replace; repoint-only: never add a link for an absent name. */
	mode: "link" | "repoint-only";
	/** Create the root (0755) before its first link when it does not exist. */
	create?: boolean;
	/** While this file exists, remove the projector's own links here instead of projecting (D-20). */
	disableFlag?: string;
	/** The root takes part only while this file exists (D-20 Cursor fallback). */
	enableFlag?: string;
	/** Real directories the agent owned before the library; any other non-library real dir warns. */
	knownReal?: readonly string[];
}

/** 04-BASELINE.md grok-real-entry lines minus the ten library names that become links. */
export const GROK_KNOWN_REAL: readonly string[] = [
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
];

export const ROOTS: readonly Root[] = [
	{ id: "claude", dir: "/root/.claude/skills", surface: "claude-code", mode: "link" },
	{ id: "grok", dir: "/root/.grok/skills", surface: "grok-build", mode: "link", knownReal: GROK_KNOWN_REAL },
	{
		id: "agents",
		dir: "/root/.agents/skills",
		surface: "cursor",
		mode: "link",
		disableFlag: "/var/lib/substrate/skills/disable-agents-root",
	},
	{ id: "muse", dir: "/root/.config/muse/skills", surface: "muse", mode: "link", create: true },
	{ id: "openclaw", dir: "/root/.openclaw/skills", surface: "claude-code", mode: "repoint-only" },
	{ id: "openclaw-ws", dir: "/root/.openclaw/workspace/skills", surface: "claude-code", mode: "repoint-only" },
	{
		id: "cursor",
		dir: "/root/.cursor/skills",
		surface: "cursor",
		mode: "link",
		enableFlag: "/var/lib/substrate/skills/enable-cursor-root",
	},
];
export const LIBRARY_DIR = "/root/agent-skills";
export const EXPORTS_DIR = "/root/.openclaw/workspace/projects/docs-scraper/data/exports/skills";
export const BACKUP_ROOT = "/var/lib/substrate/phase4-baseline/projector";
export const WARNED_STATE = "/var/lib/substrate/skills/projector-warned.json";
const TMP_SUFFIX = ".substrate-tmp";
const OLD_SUFFIX = ".substrate-old";
const SUBSTRATE_URL = (process.env.SUBSTRATE_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, "");

export type Entry = { type: "link"; target: string } | { type: "dir" } | { type: "other" };
export interface Inventory {
	root: Root;
	exists: boolean;
	entries: Map<string, Entry>;
}
export type SkipReason = "real-dir-differs" | "foreign-link" | "stray-real-dir";
export type Action =
	| { kind: "link-new"; root: Root; name: string; target: string }
	| { kind: "repoint"; root: Root; name: string; target: string; from: string }
	| { kind: "backup-then-link"; root: Root; name: string; target: string }
	| { kind: "remove-own-link"; root: Root; name: string; from: string }
	| { kind: "skip-warn"; root: Root; name: string; reason: SkipReason; from?: string };

export type WarningEvent = EventInput & { kind: "warning"; payload: Record<string, unknown> };
export type EmitWarning = (event: WarningEvent) => Promise<boolean>;

export interface ApplyContext {
	backupDir: string;
	stateFile: string;
	log: (line: string) => void;
	emitWarning: EmitWarning;
}
export interface ApplyResult {
	actions: number;
	warnings: number;
}

/** Sorted names of library subdirectories holding a SKILL.md whose name is a valid skill name. */
export function libraryNames(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && SKILL_NAME_RE.test(d.name) && existsSync(join(dir, d.name, "SKILL.md")))
		.map((d) => d.name)
		.sort();
}

/**
 * Whether a repo-relative path belongs to the refresh corpus: a skill's
 * `SKILL.md` or anything under its `references/`. Pure path check for the
 * committed read; the working-tree scan stays in `libraryNames`.
 */
export function isSkillCorpusPath(path: string): boolean {
	const [name, head, ...rest] = path.split("/");
	if (name === undefined || !SKILL_NAME_RE.test(name)) return false;
	if (head === "SKILL.md" && rest.length === 0) return true;
	return head === "references" && rest.length > 0;
}

/** Top-level entries of a root, links with their raw target; a missing root is empty. */
export function inventory(root: Root): Inventory {
	const entries = new Map<string, Entry>();
	if (!existsSync(root.dir)) return { root, exists: false, entries };
	for (const d of readdirSync(root.dir, { withFileTypes: true })) {
		const path = join(root.dir, d.name);
		if (d.isSymbolicLink()) entries.set(d.name, { type: "link", target: readlinkSync(path) });
		else entries.set(d.name, d.isDirectory() ? { type: "dir" } : { type: "other" });
	}
	return { root, exists: true, entries };
}

/** The roots taking part in this run: a root with an enableFlag only while the flag exists. */
export function activeRoots(roots: readonly Root[]): Root[] {
	return roots.filter((r) => r.enableFlag === undefined || existsSync(r.enableFlag));
}

function isIgnored(name: string): boolean {
	return name === "__pycache__" || name.endsWith(".pyc");
}

/** Relative path → kind and content key of every entry below dir, skipping __pycache__ and *.pyc. */
function treeOf(dir: string, rel = "", out = new Map<string, string>()): Map<string, string> {
	for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
		if (isIgnored(d.name)) continue;
		const r = rel === "" ? d.name : `${rel}/${d.name}`;
		if (d.isSymbolicLink()) out.set(r, `link:${readlinkSync(join(dir, r))}`);
		else if (d.isDirectory()) {
			out.set(r, "dir");
			treeOf(dir, r, out);
		} else out.set(r, "file");
	}
	return out;
}

/** Whether two trees hold the same relative entries and the same file bytes (__pycache__/ and *.pyc ignored). */
export function sameTree(a: string, b: string): boolean {
	const ta = treeOf(a);
	const tb = treeOf(b);
	if (ta.size !== tb.size) return false;
	for (const [rel, kind] of ta) {
		if (tb.get(rel) !== kind) return false;
		if (kind === "file" && !readFileSync(join(a, rel)).equals(readFileSync(join(b, rel)))) return false;
	}
	return true;
}

export function plan(
	inventories: readonly Inventory[],
	names: readonly string[],
	dirs: { libraryDir: string; exportsDir: string } = { libraryDir: LIBRARY_DIR, exportsDir: EXPORTS_DIR },
): Action[] {
	const actions: Action[] = [];
	for (const { root, exists, entries } of inventories) {
		if (!exists && !root.create) continue;
		if (root.disableFlag !== undefined && existsSync(root.disableFlag)) {
			for (const [name, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
				if (entry.type === "link" && resolve(root.dir, entry.target) === join(dirs.libraryDir, name)) {
					actions.push({ kind: "remove-own-link", root, name, from: entry.target });
				}
			}
			continue;
		}
		for (const name of names) {
			const target = join(dirs.libraryDir, name);
			const entry = entries.get(name);
			if (entry === undefined) {
				if (root.mode === "link") actions.push({ kind: "link-new", root, name, target });
			} else if (entry.type !== "link") {
				if (entry.type === "dir" && sameTree(join(root.dir, name), target)) {
					actions.push({ kind: "backup-then-link", root, name, target });
				} else actions.push({ kind: "skip-warn", root, name, reason: "real-dir-differs" });
			} else {
				const resolved = resolve(root.dir, entry.target);
				if (resolved === target) continue;
				if (resolved === join(dirs.exportsDir, name)) actions.push({ kind: "repoint", root, name, target, from: entry.target });
				else actions.push({ kind: "skip-warn", root, name, reason: "foreign-link", from: entry.target });
			}
		}
		if (root.knownReal !== undefined) {
			const library = new Set(names);
			const known = new Set(root.knownReal);
			for (const [name, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
				if (entry.type === "dir" && !library.has(name) && !known.has(name)) {
					actions.push({ kind: "skip-warn", root, name, reason: "stray-real-dir" });
				}
			}
		}
	}
	return actions;
}

function readWarned(file: string): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** Whether the live entry still is what the plan saw; anything else is left alone this run. */
function stillAsPlanned(action: Exclude<Action, { kind: "skip-warn" }>, path: string): boolean {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat === undefined) return action.kind === "link-new";
	switch (action.kind) {
		case "link-new":
			return false;
		case "backup-then-link":
			return stat.isDirectory() && sameTree(path, action.target);
		default:
			return stat.isSymbolicLink() && readlinkSync(path) === action.from;
	}
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Relative paths of the regular files below dir (every file, __pycache__ included). */
function filesOf(dir: string, rel = ""): string[] {
	const out: string[] = [];
	for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
		const r = rel === "" ? d.name : `${rel}/${d.name}`;
		if (d.isDirectory()) out.push(...filesOf(dir, r));
		else if (d.isFile()) out.push(r);
	}
	return out.sort();
}

/**
 * Copy the real dir to `<backupDir>/<root-id>/<name>/` and record a MANIFEST line per file; true only
 * when every copied file hashes equal to its source.
 */
function backUp(path: string, rootId: string, name: string, backupDir: string): string | undefined {
	const rel = `${rootId}/${name}`;
	const dest = join(backupDir, rootId, name);
	mkdirSync(join(backupDir, rootId), { recursive: true, mode: 0o700 });
	cpSync(path, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
	const lines: string[] = [];
	for (const file of filesOf(path)) {
		const hash = sha256(join(path, file));
		if (!existsSync(join(dest, file)) || sha256(join(dest, file)) !== hash) return undefined;
		lines.push(`${hash}  ${rel}/${file}\n`);
	}
	appendFileSync(join(backupDir, "MANIFEST.sha256"), lines.join(""), { mode: 0o600 });
	return dest;
}

export async function apply(actions: readonly Action[], ctx: ApplyContext): Promise<ApplyResult> {
	const restore = join(ctx.backupDir, "RESTORE.md");
	const ensureBackupDir = (): void => {
		if (existsSync(restore)) return;
		mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
		writeFileSync(restore, `# skills projector run — undo routes (apply bottom-up)\n\n`, { mode: 0o600 });
	};
	const warned = readWarned(ctx.stateFile);
	let changed = 0;
	let emitted = 0;
	for (const action of actions) {
		const path = join(action.root.dir, action.name);
		if (action.kind === "skip-warn") {
			const key = `${action.root.id}:${action.name}:${action.reason}`;
			if (warned[key]) continue;
			const accepted = await ctx.emitWarning({
				surface: action.root.surface,
				kind: "warning",
				actor: "agent",
				summary: `skills projector left ${path} alone (${action.reason})`,
				payload: {
					component: "skills-projector",
					root: action.root.id,
					name: action.name,
					reason: action.reason,
					path,
					...(action.from === undefined ? {} : { link_target: action.from }),
				},
			});
			if (!accepted) continue;
			warned[key] = new Date().toISOString();
			emitted++;
			ctx.log(`[projector] ${action.root.id} skip-warn ${action.name} (${action.reason})`);
			continue;
		}
		if (!stillAsPlanned(action, path)) {
			ctx.log(`[projector] ${action.root.id} changed-underfoot ${action.name}`);
			continue;
		}
		ensureBackupDir();
		if (!existsSync(action.root.dir) && action.root.create) {
			appendFileSync(restore, `rmdir '${action.root.dir}'\n`);
			mkdirSync(action.root.dir, { recursive: true, mode: 0o755 });
			chmodSync(action.root.dir, 0o755);
			ctx.log(`[projector] ${action.root.id} created ${action.root.dir}`);
		}
		const tmp = `${path}${TMP_SUFFIX}`;
		switch (action.kind) {
			case "remove-own-link":
				appendFileSync(restore, `ln -sfn '${action.from}' '${path}'\n`);
				rmSync(path);
				break;
			case "backup-then-link": {
				const backup = backUp(path, action.root.id, action.name, ctx.backupDir);
				if (backup === undefined) {
					ctx.log(`[projector] ${action.root.id} backup-failed ${action.name}`);
					continue;
				}
				appendFileSync(restore, `rm '${path}' && cp -a '${backup}' '${path}'\n`);
				const old = `${path}${OLD_SUFFIX}`;
				rmSync(tmp, { force: true });
				rmSync(old, { recursive: true, force: true });
				symlinkSync(action.target, tmp);
				renameSync(path, old);
				renameSync(tmp, path);
				rmSync(old, { recursive: true, force: true });
				break;
			}
			default:
				appendFileSync(restore, action.kind === "repoint" ? `ln -sfn '${action.from}' '${path}'\n` : `rm '${path}'\n`);
				rmSync(tmp, { force: true });
				symlinkSync(action.target, tmp);
				renameSync(tmp, path);
		}
		changed++;
		ctx.log(`[projector] ${action.root.id} ${action.kind} ${action.name}`);
	}
	if (emitted > 0) {
		mkdirSync(dirname(ctx.stateFile), { recursive: true, mode: 0o700 });
		const tmp = `${ctx.stateFile}${TMP_SUFFIX}`;
		writeFileSync(tmp, `${JSON.stringify(warned, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, ctx.stateFile);
	}
	return { actions: changed, warnings: emitted };
}

/**
 * Fail-open POST /events; false when the substrate did not accept it. The bearer is the one the
 * governance fetch uses (`resolveSurfaceToken`: the unit's `SUBSTRATE_TOKEN_SUBSTRATE`, then the
 * generic `SUBSTRATE_TOKEN`, first entry of a list), so the shipped unit's events are not anonymous.
 *
 * The unit's token is the `substrate` host-job surface token, and the server refuses (403) an event
 * that names another surface with it. Posted with that token, an event for a root's surface
 * (claude-code, grok-build, ...) therefore goes out as `substrate` and keeps the root's surface in
 * `payload.root_surface`; the root id stays in `payload.root`. With only the generic token (or none)
 * the event goes out exactly as built.
 */
export async function postWarning(event: WarningEvent, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<boolean> {
	const token = resolveSurfaceToken(env);
	const posted: WarningEvent =
		usesHostJobToken(env) && event.surface !== "substrate"
			? { ...event, surface: "substrate", payload: { ...event.payload, root_surface: event.surface } }
			: event;
	try {
		const response = await fetchImpl(`${SUBSTRATE_URL}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token === "" ? {} : { authorization: `Bearer ${token}` }),
			},
			body: JSON.stringify(posted),
			signal: AbortSignal.timeout(3000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export interface ProjectOptions {
	roots: readonly Root[];
	libraryDir: string;
	exportsDir: string;
	backupRoot: string;
	stateFile: string;
	stdout: (line: string) => void;
	emitWarning: EmitWarning;
	/**
	 * Approval-gated projection (skills-governance.ts). Absent or mode `off`: nothing extra runs, the
	 * run is byte-identical to the ungoverned projector. `defaultOptions()` reads it from the env.
	 */
	governance?: GovernanceOptions;
}

export function defaultOptions(): ProjectOptions {
	return {
		roots: ROOTS,
		libraryDir: LIBRARY_DIR,
		exportsDir: EXPORTS_DIR,
		backupRoot: BACKUP_ROOT,
		stateFile: WARNED_STATE,
		stdout: (line) => process.stdout.write(`${line}\n`),
		emitWarning: postWarning,
		governance: governanceFromEnv(),
	};
}

/**
 * The planner's actions for this run. With governance on, the approved list is consulted once (a
 * bounded, fail-open fetch) and in `enforce` the new links for unapproved skills are held back;
 * `persist` lets the real run refresh the approved cache while `--check` writes nothing.
 */
async function planFor(opts: ProjectOptions, persist: boolean): Promise<{ actions: Action[]; governance: GovernanceRun | null; libraryCount: number }> {
	const names = libraryNames(opts.libraryDir);
	if (names.length === 0) throw new Error(`no library skills under ${opts.libraryDir}; refusing to project`);
	const actions = plan(activeRoots(opts.roots).map(inventory), names, opts);
	const gov = opts.governance;
	if (gov === undefined || gov.mode === "off") {
		// A rejected flag value is named once per run; a valid or unset one prints nothing.
		if (gov !== undefined) for (const line of skillsGovernanceConfigWarnings(gov)) opts.stdout(`[projector] ${line}`);
		return { actions, governance: null, libraryCount: names.length };
	}
	const governance = await evaluateGovernance(gov, names, actions, { cache: governancePaths(opts.stateFile).cache, persist });
	return { actions: governance?.actions ?? actions, governance, libraryCount: names.length };
}

/** One projector run: plan, apply, print the totals. Used by the CLI and by skills-sync. */
export async function project(opts: ProjectOptions): Promise<ApplyResult> {
	const { actions, governance, libraryCount } = await planFor(opts, true);
	if (governance !== null && opts.governance !== undefined) {
		await reportGovernance(governance, libraryCount, {
			warnedFile: governancePaths(opts.stateFile).warned,
			emitWarning: opts.emitWarning,
			log: opts.stdout,
			now: opts.governance.now ?? Date.now,
			renotifyMs: opts.governance.renotifyMs ?? RENOTIFY_MS,
		});
	}
	const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	const result = await apply(actions, {
		backupDir: join(opts.backupRoot, ts),
		stateFile: opts.stateFile,
		log: opts.stdout,
		emitWarning: opts.emitWarning,
	});
	opts.stdout(`[projector] actions=${result.actions} warnings=${result.warnings}`);
	if (result.actions === 0) opts.stdout(`[projector] already current (${activeRoots(opts.roots).map((r) => r.id).join(", ")})`);
	return result;
}

export async function main(args: readonly string[], base: ProjectOptions = defaultOptions()): Promise<number> {
	const rootIndex = args.indexOf("--root");
	let opts = base;
	if (rootIndex >= 0) {
		const id = args[rootIndex + 1];
		const roots = base.roots.filter((r) => r.id === id);
		if (roots.length === 0) {
			process.stderr.write(`[projector] unknown root ${JSON.stringify(id)}; known: ${base.roots.map((r) => r.id).join(", ")}\n`);
			return 2;
		}
		opts = { ...base, roots };
	}
	if (!args.includes("--check")) {
		await project(opts);
		return 0;
	}
	const pending = (await planFor(opts, false)).actions.filter((a) => a.kind !== "skip-warn");
	if (pending.length === 0) {
		opts.stdout(`[projector] already current (${activeRoots(opts.roots).map((r) => r.id).join(", ")})`);
		return 0;
	}
	for (const a of pending) opts.stdout(`[projector] would ${a.kind} ${a.root.id} ${a.name}`);
	return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
