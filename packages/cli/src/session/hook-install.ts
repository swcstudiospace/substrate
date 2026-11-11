/**
 * `substrate session hook-install claude-code --settings PATH [--write]` (phase 67, live steering GA): merges the Claude Code
 * `Stop` hook that `hook-config claude-code` prints into one Claude Code settings file.
 *
 * Installing a hook in a host is an operator step (ADR 0007), so this command never runs by itself and is never run by this
 * repository. Without `--write` it reads the file, reports what it would change and writes nothing. With `--write` it writes the
 * merged file through a temporary file and a rename, after copying the previous file to `PATH.substrate-backup`. A symbolic link is
 * read but never written: the rename would replace the link. A file that
 * already holds the hook is left as it is, so running the command twice is safe.
 *
 * Only `claude-code` is installable. ADR 0007 maps the `Stop` event to it, and its command reads the session id and worktree from
 * Claude Code's own envelope. The other targets need values from the host (session ids, the binding file) or an event the
 * operator has to choose, so they stay printed text.
 *
 * The settings file can hold credentials (an `env` block), so nothing here prints its contents. Errors name the failed step, never
 * the text that failed to parse.
 */
import { copyFile, lstat, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { CLAUDE_CODE_HOOK_COMMAND, CLAUDE_CODE_TIMEOUT_SECONDS } from "./hook-config.ts";

/** A settings file larger than this is refused unread: a Claude Code settings file is a few kilobytes. */
export const HOOK_INSTALL_MAX_BYTES = 1_048_576;
/** A new settings file may hold credentials, so only its owner may read it. */
const NEW_FILE_MODE = 0o600;
/** Where the previous file is kept beside a rewritten one. A second write replaces this copy. */
export const HOOK_INSTALL_BACKUP_SUFFIX = ".substrate-backup";

export type HookInstallErrorCode = "malformed" | "too-large" | "unreadable" | "unwritable";

export class HookInstallError extends Error {
	readonly code: HookInstallErrorCode;

	constructor(code: HookInstallErrorCode, message: string) {
		super(message);
		this.name = "HookInstallError";
		this.code = code;
	}
}

export interface MergeResult {
	/** False when the Stop hook was already present, so `text` is the file as it was. */
	added: boolean;
	/** The settings text after the merge. */
	text: string;
}

export interface SettingsFile {
	text: string;
	/** Permission bits of the existing file, kept when it is rewritten. */
	mode: number;
}

export interface HookInstallReport {
	added: boolean;
	written: boolean;
	/** The backup path, when a previous file was kept. */
	backup: string | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The `Stop` hook group the printed configuration holds, as Claude Code's settings express it. */
export function claudeCodeStopGroup(): { hooks: Array<{ type: "command"; command: string; timeout: number }> } {
	return { hooks: [{ type: "command", command: CLAUDE_CODE_HOOK_COMMAND, timeout: CLAUDE_CODE_TIMEOUT_SECONDS }] };
}

/**
 * The settings text with the `Stop` hook merged in. `existing` is the file's text, or null when there is no file. An empty file
 * is an empty object. Every other key is kept in its order. Throws `malformed` when the file is not a JSON object, or when
 * `hooks` or `hooks.Stop` has the wrong shape, so the merge never guesses at a file it cannot read.
 */
export function mergeStopHook(existing: string | null): MergeResult {
	let settings: unknown = {};
	if (existing !== null && existing.trim() !== "") {
		try {
			settings = JSON.parse(existing);
		} catch {
			throw new HookInstallError("malformed", "the settings file is not valid JSON; nothing was changed");
		}
	}
	if (!isObject(settings)) throw new HookInstallError("malformed", "the settings file must hold a JSON object; nothing was changed");
	const hooks = settings.hooks ?? {};
	if (!isObject(hooks)) throw new HookInstallError("malformed", "`hooks` in the settings file must be an object; nothing was changed");
	const stop = hooks.Stop ?? [];
	if (!Array.isArray(stop)) throw new HookInstallError("malformed", "`hooks.Stop` in the settings file must be an array; nothing was changed");
	const present = stop.some((group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some((hook) => isObject(hook) && hook.command === CLAUDE_CODE_HOOK_COMMAND));
	if (present) return { added: false, text: existing ?? "" };
	settings.hooks = { ...hooks, Stop: [...stop, claudeCodeStopGroup()] };
	return { added: true, text: `${JSON.stringify(settings, null, 2)}\n` };
}

/** The file's text and permission bits, or null when it does not exist. Refuses what is not a regular file or is too large. */
export async function readSettingsFile(path: string): Promise<SettingsFile | null> {
	let info: Stats;
	try {
		info = await stat(path);
	} catch (error) {
		if (isNotFound(error)) return null;
		throw new HookInstallError("unreadable", "the settings file cannot be read");
	}
	if (!info.isFile()) throw new HookInstallError("unreadable", "the settings path is not a regular file");
	if (info.size > HOOK_INSTALL_MAX_BYTES) throw new HookInstallError("too-large", `the settings file is larger than ${HOOK_INSTALL_MAX_BYTES} bytes; nothing was changed`);
	try {
		return { text: await readFile(path, "utf8"), mode: info.mode & 0o777 };
	} catch {
		throw new HookInstallError("unreadable", "the settings file cannot be read");
	}
}

const isNotFound = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/**
 * Installs the Stop hook into the settings file at `path`. `write` false reports only. With `write` true and a change to make, the
 * previous file is copied to the backup path first, and the new file replaces the old through a temporary file in the same directory.
 */
export async function installClaudeCodeHook(path: string, write: boolean): Promise<HookInstallReport> {
	const existing = await readSettingsFile(path);
	const merged = mergeStopHook(existing?.text ?? null);
	if (!merged.added || !write) return { added: merged.added, written: false, backup: null };
	// A rename over a link would replace the link with a file; the owner points --settings at the target instead.
	if (existing !== null && (await lstat(path)).isSymbolicLink()) {
		throw new HookInstallError("unwritable", "the settings path is a symbolic link; point --settings at the file it names");
	}
	let backup: string | null = null;
	const temporary = `${path}.substrate-tmp-${process.pid}`;
	try {
		if (existing !== null) {
			backup = `${path}${HOOK_INSTALL_BACKUP_SUFFIX}`;
			await copyFile(path, backup);
		}
		await writeFile(temporary, merged.text, { mode: existing?.mode ?? NEW_FILE_MODE, flag: "wx" });
		await rename(temporary, path);
	} catch {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw new HookInstallError("unwritable", "the settings file could not be written; the previous file is unchanged");
	}
	return { added: true, written: true, backup };
}
