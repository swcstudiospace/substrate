#!/usr/bin/env bun
/**
 * Project the shared skills library into each agent's skill root (D-05, D-06, D-20; ported D22-01).
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
 * Phase 22 (D22-03): every warning this projector sends is a host-job event — surface `substrate`,
 * actor `agent`, `payload.action` `skills.sync`, `payload.runtime` `skills-sync`, `payload.reason`,
 * no `repo`, `session_id` `skills-sync:<UTC yyyy-mm-ddThh>` — mapping onto the existing
 * `skills.sync.refused` row, so EVENT_SOURCES and the vocabulary doc do not change. The skip-warn
 * payload keeps its September fields (`root`, `name`, `path`, `link_target`) with September's three
 * reasons. The bearer comes from Phase 20's resolver (`resolveBearer("substrate", env)`), never raw
 * `process.env.SUBSTRATE_TOKEN`; posting stays fail-open with a 3 s timeout.
 *
 * Phase 22 (D22-07) seams — production defaults are September's; each has an override so tests and
 * the smoke never touch `/root/agent-skills`, `/root/.*` or `/var/lib/substrate`:
 *   - `SUBSTRATE_SKILLS_LIBRARY` — the library dir (default `/root/agent-skills`);
 *   - `SUBSTRATE_SKILLS_HOME` — the home the roots live under (default `/root`; each root dir and
 *     the exports dir have their leading `/root` replaced, so `/root/.claude/skills` under
 *     `SUBSTRATE_SKILLS_HOME=/tmp/t` becomes `/tmp/t/.claude/skills`);
 *   - `SUBSTRATE_SKILLS_STATE` — the state dir, shared with Phase 21 (default
 *     `/var/lib/substrate/skills`; holds `projector-warned.json` plus the enable/disable flags,
 *     whose defaults are rewritten the same way when the state dir moves);
 *   - `SUBSTRATE_SKILLS_BACKUP` — the backup root (default
 *     `/var/lib/substrate/phase4-baseline/projector`);
 *   - `SUBSTRATE_URL` — the substrate base URL (default `http://127.0.0.1:7410`).
 * Bearer resolution additionally honours `SUBSTRATE_TOKEN`, `SUBSTRATE_TOKEN_FILE` and
 * `SUBSTRATE_TOKENS_DIR` per Phase 20 (`packages/cli/src/token.ts`).
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
import { resolveBearer } from "../../cli/src/token.ts";
import { SKILL_NAME_RE } from "../../mcp-server/src/skills/propose.ts";
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
/** Phase 21's state dir; shared by the projector warned file, the sync warned file and the flags. */
export const STATE_DIR_DEFAULT = "/var/lib/substrate/skills";
const HOME_DEFAULT = "/root";
const TMP_SUFFIX = ".substrate-tmp";
const OLD_SUFFIX = ".substrate-old";
const SUBSTRATE_URL_DEFAULT = "http://127.0.0.1:7410";

/** `skills-sync:<UTC yyyy-mm-ddThh>` — the hourly host-job session every sync/projector event joins. */
export function syncSessionId(now: Date = new Date()): string {
	return `skills-sync:${now.toISOString().slice(0, 13)}`;
}

/** UTC calendar day `yyyy-mm-dd`, the D22-05 daily-reminder key. */
export function utcDay(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/**
 * One host-job warning for the skills plane (D22-03): fixed surface `substrate`, actor `agent`,
 * `payload.action` `skills.sync`, `payload.runtime` `skills-sync`, the refusal `reason`, no `repo`.
 * Maps onto the existing `skills.sync.refused` row — no new EVENT_SOURCES row.
 */
export function hostJobWarning(reason: string, summary: string, extra: Record<string, unknown>, now: Date = new Date()): WarningEvent {
	return {
		surface: "substrate",
		kind: "warning",
		actor: "agent",
		summary,
		session_id: syncSessionId(now),
		payload: { action: "skills.sync", runtime: "skills-sync", reason, ...extra },
	};
}

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
	return out;
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
			const accepted = await ctx.emitWarning(
				hostJobWarning(
					action.reason,
					`skills projector left ${path} alone (${action.reason})`,
					{
						component: "skills-projector",
						root: action.root.id,
						name: action.name,
						path,
						...(action.from === undefined ? {} : { link_target: action.from }),
					},
				),
			);
			// A refused post is not recorded, so the next run retries it.
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
 * Fail-open POST /events with Phase 20's bearer (D22-04); false when the substrate did not accept it.
 * A refused post never changes the tick's outcome. `env` is injectable so tests prove the resolver
 * order without touching the filesystem.
 */
export async function postWarning(event: WarningEvent, env: Record<string, string | undefined> = process.env): Promise<boolean> {
	try {
		const base = (env.SUBSTRATE_URL ?? SUBSTRATE_URL_DEFAULT).replace(/\/+$/, "");
		const bearer = resolveBearer("substrate", env);
		const response = await fetch(`${base}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
			},
			body: JSON.stringify(event),
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
}

/** Rewrite `path`'s leading `from` prefix as `to`; untouched when the prefix does not match. */
function withPrefix(path: string, from: string, to: string): string {
	if (to === from) return path;
	return path === from || path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

/**
 * Production defaults with the D22-07 seams applied. `SUBSTRATE_SKILLS_HOME` moves every root dir
 * and the exports dir; `SUBSTRATE_SKILLS_STATE` moves the warned file and the enable/disable flags.
 */
export function defaultOptions(env: Record<string, string | undefined> = process.env): ProjectOptions {
	const home = env.SUBSTRATE_SKILLS_HOME?.trim() || HOME_DEFAULT;
	const stateDir = env.SUBSTRATE_SKILLS_STATE?.trim() || STATE_DIR_DEFAULT;
	const roots = ROOTS.map((r) => ({
		...r,
		dir: withPrefix(r.dir, HOME_DEFAULT, home),
		...(r.enableFlag === undefined ? {} : { enableFlag: withPrefix(r.enableFlag, STATE_DIR_DEFAULT, stateDir) }),
		...(r.disableFlag === undefined ? {} : { disableFlag: withPrefix(r.disableFlag, STATE_DIR_DEFAULT, stateDir) }),
	}));
	return {
		roots,
		libraryDir: env.SUBSTRATE_SKILLS_LIBRARY?.trim() || LIBRARY_DIR,
		exportsDir: withPrefix(EXPORTS_DIR, HOME_DEFAULT, home),
		backupRoot: env.SUBSTRATE_SKILLS_BACKUP?.trim() || BACKUP_ROOT,
		stateFile: join(stateDir, "projector-warned.json"),
		stdout: (line) => process.stdout.write(`${line}\n`),
		emitWarning: (event) => postWarning(event, env),
	};
}

function planFor(opts: ProjectOptions): Action[] {
	const names = libraryNames(opts.libraryDir);
	if (names.length === 0) throw new Error(`no library skills under ${opts.libraryDir}; refusing to project`);
	return plan(activeRoots(opts.roots).map(inventory), names, opts);
}

/** One projector run: plan, apply, print the totals. Used by the CLI and by skills-sync. */
export async function project(opts: ProjectOptions): Promise<ApplyResult> {
	const actions = planFor(opts);
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
	const pending = planFor(opts).filter((a) => a.kind !== "skip-warn");
	if (pending.length === 0) {
		opts.stdout(`[projector] already current (${activeRoots(opts.roots).map((r) => r.id).join(", ")})`);
		return 0;
	}
	for (const a of pending) opts.stdout(`[projector] would ${a.kind} ${a.root.id} ${a.name}`);
	return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
