#!/usr/bin/env bun
/**
 * Project the shared skills library into each agent's skill root (D-05, D-06).
 *
 *   bun packages/projector/src/skills.ts [--check] [--root <id>]
 *
 * Every library skill `<LIBRARY_DIR>/<name>` becomes a per-skill symlink `<root>/<name>`. A pure
 * planner turns the roots' inventories into actions; an executor applies them:
 *   - link-new  — the name is absent: link it;
 *   - repoint   — a link into the docs-scraper exports dir: point it at the library instead;
 *   - skip-warn — a real directory (reason real-dir) or a link elsewhere (reason foreign-link):
 *                 never touched, one deduped `warning` event per (root, name, reason).
 * Names that are not library names (README.md, an agent's own skills) are never looked at.
 *
 * Links are replaced atomically (`<name>.substrate-tmp` + rename). Before each change the executor
 * appends its undo line to `<backupDir>/RESTORE.md` (backupDir created 0700 on the first change).
 * `--check` exits 1 when a link-new or repoint is pending and writes nothing; skip-warn entries are
 * not drift. With nothing pending it prints an "already current" line and exits 0.
 */
import {
	appendFileSync,
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
import type { EventInput, Surface } from "../../mcp-server/src/types.ts";

export interface Root {
	id: string;
	dir: string;
	surface: Surface;
	mode: "link";
}

export const ROOTS: readonly Root[] = [
	{ id: "claude", dir: "/root/.claude/skills", surface: "claude-code", mode: "link" },
	{ id: "grok", dir: "/root/.grok/skills", surface: "grok-build", mode: "link" },
];
export const LIBRARY_DIR = "/root/agent-skills";
export const EXPORTS_DIR = "/root/.openclaw/workspace/projects/docs-scraper/data/exports/skills";
export const BACKUP_ROOT = "/var/lib/substrate/phase4-baseline/projector";
export const WARNED_STATE = "/var/lib/substrate/skills/projector-warned.json";
const TMP_SUFFIX = ".substrate-tmp";
const SUBSTRATE_URL = (process.env.SUBSTRATE_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, "");

export type Entry = { type: "link"; target: string } | { type: "dir" } | { type: "other" };
export interface Inventory {
	root: Root;
	entries: Map<string, Entry>;
}
export type SkipReason = "real-dir" | "foreign-link";
export type Action =
	| { kind: "link-new"; root: Root; name: string; target: string }
	| { kind: "repoint"; root: Root; name: string; target: string; from: string }
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
	if (!existsSync(root.dir)) return { root, entries };
	for (const d of readdirSync(root.dir, { withFileTypes: true })) {
		const path = join(root.dir, d.name);
		if (d.isSymbolicLink()) entries.set(d.name, { type: "link", target: readlinkSync(path) });
		else entries.set(d.name, d.isDirectory() ? { type: "dir" } : { type: "other" });
	}
	return { root, entries };
}

export function plan(
	inventories: readonly Inventory[],
	names: readonly string[],
	dirs: { libraryDir: string; exportsDir: string } = { libraryDir: LIBRARY_DIR, exportsDir: EXPORTS_DIR },
): Action[] {
	const actions: Action[] = [];
	for (const { root, entries } of inventories) {
		for (const name of names) {
			const target = join(dirs.libraryDir, name);
			const entry = entries.get(name);
			if (entry === undefined) {
				actions.push({ kind: "link-new", root, name, target });
			} else if (entry.type !== "link") {
				actions.push({ kind: "skip-warn", root, name, reason: "real-dir" });
			} else {
				const resolved = resolve(root.dir, entry.target);
				if (resolved === target) continue;
				if (resolved === join(dirs.exportsDir, name)) actions.push({ kind: "repoint", root, name, target, from: entry.target });
				else actions.push({ kind: "skip-warn", root, name, reason: "foreign-link", from: entry.target });
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
	return action.kind === "repoint" && stat.isSymbolicLink() && readlinkSync(path) === action.from;
}

export async function apply(actions: readonly Action[], ctx: ApplyContext): Promise<ApplyResult> {
	const restore = join(ctx.backupDir, "RESTORE.md");
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
		if (!existsSync(restore)) {
			mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
			writeFileSync(
				restore,
				`# skills projector run — undo routes (apply bottom-up)\n\n`,
				{ mode: 0o600 },
			);
		}
		appendFileSync(restore, action.kind === "repoint" ? `ln -sfn '${action.from}' '${path}'\n` : `rm '${path}'\n`);
		const tmp = `${path}${TMP_SUFFIX}`;
		rmSync(tmp, { force: true });
		symlinkSync(action.target, tmp);
		renameSync(tmp, path);
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

/** Fail-open POST /events; false when the substrate did not accept it. */
export async function postWarning(event: WarningEvent): Promise<boolean> {
	try {
		const response = await fetch(`${SUBSTRATE_URL}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(process.env.SUBSTRATE_TOKEN ? { authorization: `Bearer ${process.env.SUBSTRATE_TOKEN}` } : {}),
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

export function defaultOptions(): ProjectOptions {
	return {
		roots: ROOTS,
		libraryDir: LIBRARY_DIR,
		exportsDir: EXPORTS_DIR,
		backupRoot: BACKUP_ROOT,
		stateFile: WARNED_STATE,
		stdout: (line) => process.stdout.write(`${line}\n`),
		emitWarning: postWarning,
	};
}

function planFor(opts: ProjectOptions): Action[] {
	const names = libraryNames(opts.libraryDir);
	if (names.length === 0) throw new Error(`no library skills under ${opts.libraryDir}; refusing to project`);
	return plan(opts.roots.map(inventory), names, opts);
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
	if (result.actions === 0) opts.stdout(`[projector] already current (${opts.roots.map((r) => r.id).join(", ")})`);
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
		opts.stdout(`[projector] already current (${opts.roots.map((r) => r.id).join(", ")})`);
		return 0;
	}
	for (const a of pending) opts.stdout(`[projector] would ${a.kind} ${a.root.id} ${a.name}`);
	return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
