#!/usr/bin/env bun
/**
 * Project the `substrate` MCP server entry into a swarm workspace (ADR 0001 S4; INST-01, INST-02).
 *
 *   bun packages/projector/src/swarm-workspace.ts --workspace <ws> [--runtimes claude,grok,omp] --plan|--check|--apply
 *   bun packages/projector/src/swarm-workspace.ts --spec
 *
 * One entry per runtime the swarm installer configures, in the project file that runtime reads:
 *
 * | Runtime | File                | Format |
 * |---------|---------------------|--------|
 * | claude  | `.mcp.json`         | JSON   |
 * | omp     | `.mcp.json`         | JSON (omp reads Claude's file) |
 * | grok    | `.grok/config.toml` | TOML   |
 *
 * The entry names `${SUBSTRATE_URL}` and `${SUBSTRATE_TOKEN}`; every runtime expands them from its own environment
 * when it loads the file. A token value is never written: the workspace is a git checkout, and the agent's token
 * reaches its process through a 0600 env file outside it (docs/swarm-workspace.md).
 *
 * Ownership is the server name. The projector adds `substrate` where it is missing, leaves every other entry and key
 * as it was, and changes nothing when an identical `substrate` is already there. An entry of that name that differs
 * is refused rather than replaced: the projector cannot tell an older projection from an operator's edit, and
 * overwriting the second is exactly the "replace" the ADR rules out. Unparsable input is refused too, never reset.
 *
 * `--spec` prints the projection itself as JSON. agent-swarm's installer is public and cannot depend on this private
 * checkout at install time, so it applies a vendored copy of that spec (agent-swarm `swarm/substrate_mcp.json`)
 * with the same rules; the PROOF-03 script diffs the two.
 *
 * Exit codes: 0 done (or nothing to do), 1 `--check` found changes, 2 refused or bad usage. All files are staged
 * before commit; a failed commit rolls back only files that still belong to this apply.
 */
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	linkSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const SERVER = "substrate";
/** No `:-default`: a swarm with `SUBSTRATE_URL` unset is off, and a default would quietly point it at a server. */
export const URL_TEMPLATE = "${SUBSTRATE_URL}/mcp";
export const AUTHORIZATION_TEMPLATE = "Bearer ${SUBSTRATE_TOKEN}";

export type Format = "json" | "toml";
export const RUNTIME_FILES: Readonly<Record<string, { path: string; format: Format }>> = {
	claude: { path: ".mcp.json", format: "json" },
	omp: { path: ".mcp.json", format: "json" },
	grok: { path: ".grok/config.toml", format: "toml" },
};
export const RUNTIMES = Object.keys(RUNTIME_FILES);

/** Claude and omp read the same shape: `type`, `url`, `headers`. */
export function jsonEntry(): Record<string, unknown> {
	return { type: "http", url: URL_TEMPLATE, headers: { Authorization: AUTHORIZATION_TEMPLATE } };
}

/** Grok's `[mcp_servers.<name>]`: a URL makes it HTTP, so there is no `type`. */
export function tomlEntry(): Record<string, unknown> {
	return { url: URL_TEMPLATE, headers: { Authorization: AUTHORIZATION_TEMPLATE } };
}

export function tomlBlock(): string {
	return [
		"# substrate-mcp, projected by agent-substrate packages/projector. The token is named here, never written.",
		`[mcp_servers.${SERVER}]`,
		`url = "${URL_TEMPLATE}"`,
		`headers = { Authorization = "${AUTHORIZATION_TEMPLATE}" }`,
		"",
	].join("\n");
}

export interface Spec {
	version: 1;
	server: string;
	runtimes: Record<string, { path: string; format: Format }>;
	json: Record<string, unknown>;
	toml: { entry: Record<string, unknown>; block: string };
}

export function spec(): Spec {
	return {
		version: 1,
		server: SERVER,
		runtimes: { ...RUNTIME_FILES },
		json: jsonEntry(),
		toml: { entry: tomlEntry(), block: tomlBlock() },
	};
}

export class ProjectionRefused extends Error {}

export interface Change {
	/** Absolute path of the file. */
	path: string;
	/** The same file relative to the workspace, as the runtime table names it. */
	file: string;
	runtimes: string[];
	format: Format;
	status: "create" | "append" | "current";
	before: string | null;
	after: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Key-order-insensitive comparison, so a hand-written entry with the same content counts as ours. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (isObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function same(a: unknown, b: unknown): boolean {
	return canonical(a) === canonical(b);
}

/** A write through a symlink could land anywhere, so no component between the workspace and the file may be one. */
function refuseSymlinks(workspace: string, path: string): void {
	let current = path;
	while (current !== workspace) {
		// lstat, not exists: a dangling link is still a link the write would follow
		if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
			throw new ProjectionRefused(`${current} is a symlink; the projector never writes through one`);
		}
		const parent = dirname(current);
		if (parent === current) throw new ProjectionRefused(`${path} is outside ${workspace}`);
		current = parent;
	}
}

function planJson(path: string, before: string | null): Pick<Change, "status" | "after"> {
	if (before === null) {
		return { status: "create", after: `${JSON.stringify({ mcpServers: { [SERVER]: jsonEntry() } }, null, 2)}\n` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(before);
	} catch (cause) {
		throw new ProjectionRefused(`${path} is not valid JSON, refusing to touch it: ${String(cause)}`);
	}
	if (!isObject(parsed)) throw new ProjectionRefused(`${path} is not a JSON object, refusing to touch it`);
	// null is present but unusable. Only a missing key starts an empty map; never replace a non-object.
	const servers = parsed.mcpServers === undefined ? {} : parsed.mcpServers;
	if (!isObject(servers)) throw new ProjectionRefused(`${path} has an mcpServers that is not an object`);
	const existing = servers[SERVER];
	if (existing !== undefined) {
		if (same(existing, jsonEntry())) return { status: "current", after: before };
		throw new ProjectionRefused(
			`${path} already has an mcpServers.${SERVER} entry that differs from the projection; ` +
				"the projector never replaces an entry it did not write identically. Remove it and re-run",
		);
	}
	// Appended last, everything else in its original order.
	parsed.mcpServers = { ...servers, [SERVER]: jsonEntry() };
	return { status: "append", after: `${JSON.stringify(parsed, null, 2)}\n` };
}

function parseToml(path: string, text: string): Json {
	try {
		return Bun.TOML.parse(text) as Json;
	} catch (cause) {
		throw new ProjectionRefused(`${path} is not valid TOML, refusing to touch it: ${String(cause)}`);
	}
}

/** The document minus the entry this projector adds, for checking that appending changed nothing else. */
function withoutOurs(doc: Json, hadServers: boolean): Json {
	const copy: Json = { ...doc };
	if (isObject(copy.mcp_servers)) {
		const { [SERVER]: _ours, ...rest } = copy.mcp_servers;
		if (Object.keys(rest).length === 0 && !hadServers) delete copy.mcp_servers;
		else copy.mcp_servers = rest;
	}
	return copy;
}

function planToml(path: string, before: string | null): Pick<Change, "status" | "after"> {
	if (before === null) return { status: "create", after: tomlBlock() };
	const parsed = parseToml(path, before);
	const servers = parsed.mcp_servers;
	if (servers !== undefined && !isObject(servers)) {
		throw new ProjectionRefused(`${path} has an mcp_servers that is not a table`);
	}
	const existing = isObject(servers) ? servers[SERVER] : undefined;
	if (existing !== undefined) {
		if (same(existing, tomlEntry())) return { status: "current", after: before };
		throw new ProjectionRefused(
			`${path} already has an [mcp_servers.${SERVER}] entry that differs from the projection; ` +
				"the projector never replaces an entry it did not write identically. Remove it and re-run",
		);
	}
	// TOML has no safe in-place edit here, so the block is appended as text and the result re-read: it must parse,
	// hold exactly our entry, and leave every other key as it was. An inline `mcp_servers = { … }` table, for one,
	// cannot be extended this way, and is refused rather than rewritten.
	const body = before.length === 0 || before.endsWith("\n") ? before : `${before}\n`;
	const after = `${body}${body.length > 0 ? "\n" : ""}${tomlBlock()}`;
	let reread: Json;
	try {
		reread = Bun.TOML.parse(after) as Json;
	} catch (cause) {
		throw new ProjectionRefused(`appending to ${path} would not parse, so nothing was written: ${String(cause)}`);
	}
	const ours = isObject(reread.mcp_servers) ? reread.mcp_servers[SERVER] : undefined;
	if (!same(ours, tomlEntry()) || !same(withoutOurs(reread, servers !== undefined), parsed)) {
		throw new ProjectionRefused(`appending [mcp_servers.${SERVER}] to ${path} would change other config; add it by hand`);
	}
	return { status: "append", after };
}

/** Reads only. Throws ProjectionRefused for anything it will not write. */
export function plan(workspace: string, runtimes: readonly string[] = RUNTIMES): Change[] {
	if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
		throw new ProjectionRefused(`workspace ${resolve(workspace)} is not an existing directory`);
	}
	// the real path, so the symlink walk below stops at the workspace however it was spelled
	const root = realpathSync(workspace);
	const unknown = runtimes.filter((runtime) => !Object.hasOwn(RUNTIME_FILES, runtime));
	if (unknown.length > 0) {
		throw new ProjectionRefused(
			`no MCP entry for runtime ${unknown.join(", ")}: an executing swarm agent must reach substrate-mcp, and ` +
				`this projector writes one only for ${RUNTIMES.join(", ")} (ADR 0001 S4 criterion 6)`,
		);
	}
	const byPath = new Map<string, { format: Format; runtimes: string[] }>();
	for (const runtime of runtimes) {
		const file = RUNTIME_FILES[runtime];
		if (file === undefined) continue;
		const entry = byPath.get(file.path) ?? { format: file.format, runtimes: [] };
		if (!entry.runtimes.includes(runtime)) entry.runtimes.push(runtime);
		byPath.set(file.path, entry);
	}
	const changes: Change[] = [];
	for (const [rel, { format, runtimes: users }] of byPath) {
		const path = join(root, rel);
		refuseSymlinks(root, path);
		// The same no-follow, non-blocking regular-file read as apply. A named pipe must not block planning.
		const before = snapshot(path)?.bytes.toString("utf8") ?? null;
		const planned = format === "json" ? planJson(path, before) : planToml(path, before);
		changes.push({ path, file: rel, runtimes: users, format, before, ...planned });
	}
	return changes;
}

type Snapshot = { stat: Stats; bytes: Buffer } | null;
type Directory = { path: string; fd: number; anchor: string; stat: Stats };
type StagedFile = { path: string; snapshot: NonNullable<Snapshot> };
type Write = {
	path: string;
	directory: Directory;
	name: string;
	before: Snapshot;
	next: StagedFile;
	restore: StagedFile | null;
	committed: boolean;
	/** False until the post-publication snapshot records the ctime rename/link changed. */
	verified: boolean;
};

function sameIdentity(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
	return a === null || b === null
		? a === b
		: sameIdentity(a.stat, b.stat) &&
				a.stat.mode === b.stat.mode &&
				a.stat.mtimeMs === b.stat.mtimeMs &&
				a.stat.ctimeMs === b.stat.ctimeMs &&
				a.bytes.equals(b.bytes);
}

/** Publication changes ctime before its verification read. A failed read must not make that look like another writer. */
function ownsPublished(current: Snapshot, write: Write): boolean {
	const expected = write.next.snapshot;
	if (
		!current ||
		!sameIdentity(current.stat, expected.stat) ||
		current.stat.mode !== expected.stat.mode ||
		!current.bytes.equals(expected.bytes)
	) {
		return false;
	}
	return write.verified ? sameSnapshot(current, expected) : true;
}

/** Reading an already-open regular file never follows a substituted final symlink. */
function snapshot(path: string): Snapshot {
	const entry = lstatSync(path, { throwIfNoEntry: false });
	if (!entry) return null;
	if (!entry.isFile()) throw new ProjectionRefused(`${path} is not a regular file`);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || !sameIdentity(entry, stat)) {
			throw new ProjectionRefused(`${path} changed while it was read`);
		}
		const bytes = readFileSync(fd);
		const after = fstatSync(fd);
		if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
			throw new ProjectionRefused(`${path} changed while it was read`);
		}
		return { stat: after, bytes };
	} finally {
		closeSync(fd);
	}
}

/**
 * Stage the entire plan before publishing anything. Directory descriptors pin each destination: even a directory
 * swapped for a symlink between a check and a syscall cannot redirect writes. Each publication is atomic. On error,
 * restore prior files/backups only if their identity and bytes still match our publication; report conflicts instead
 * of overwriting another writer. This is a recoverable transaction, not a crash-atomic multi-file filesystem primitive.
 */
export function apply(changes: readonly Change[]): Change[] {
	const pending = changes.filter((change) => change.status !== "current");
	const directories = new Map<string, Directory>();
	const createdDirectories: { path: string; stat: Stats }[] = [];
	const staged: StagedFile[] = [];
	const writes: Write[] = [];
	const failures: string[] = [];
	let applyError: unknown;

	function checkDirectory(directory: Directory): void {
		refuseSymlinks("/", directory.path);
		const now = lstatSync(directory.path, { throwIfNoEntry: false });
		if (!now?.isDirectory() || !sameIdentity(now, directory.stat)) {
			throw new ProjectionRefused(`${directory.path} changed during apply`);
		}
	}

	function pinDirectory(path: string, create: boolean): Directory {
		const pinned = directories.get(path);
		if (pinned) {
			checkDirectory(pinned);
			return pinned;
		}
		refuseSymlinks("/", path);
		let source = path;
		if (create) {
			const parent = pinDirectory(dirname(path), false);
			checkDirectory(parent);
			source = join(parent.anchor, path.slice(dirname(path).length + 1));
			if (!lstatSync(source, { throwIfNoEntry: false })) {
				mkdirSync(source);
				const stat = lstatSync(source);
				// Record ownership before open. A failed open must still remove this empty directory.
				createdDirectories.push({ path, stat });
			}
		}
		const fd = openSync(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const stat = fstatSync(fd);
		// Bun supports Linux and macOS. Refuse rather than fall back to race-prone path writes if neither FD mount works.
		const anchor = [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`].find((candidate) => {
			try {
				return sameIdentity(statSync(`${candidate}/.`), stat);
			} catch {
				return false;
			}
		});
		if (!anchor) {
			closeSync(fd);
			throw new ProjectionRefused(`no directory-descriptor filesystem is available for ${path}`);
		}
		const directory = { path, fd, anchor, stat };
		directories.set(path, directory);
		checkDirectory(directory);
		return directory;
	}

	function stage(directory: Directory, bytes: string | Buffer, mode?: number): StagedFile {
		checkDirectory(directory);
		const path = join(directory.anchor, `.substrate-tmp-${randomUUID()}`);
		const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		// Register ownership immediately so a failed write can still clean up its own partial file.
		const file: StagedFile = { path, snapshot: { stat: fstatSync(fd), bytes: Buffer.alloc(0) } };
		staged.push(file);
		try {
			writeFileSync(fd, bytes);
			fchmodSync(fd, mode === undefined ? 0o666 & ~process.umask() : mode & 0o777);
			file.snapshot.stat = fstatSync(fd);
		} finally {
			closeSync(fd);
		}
		file.snapshot = snapshot(path)!;
		return file;
	}

	function prepare(path: string, directory: Directory, before: Snapshot, bytes: string | Buffer, mode?: number): void {
		const name = join(directory.anchor, path.slice(dirname(path).length + 1));
		const next = stage(directory, bytes, mode);
		const restore = before ? stage(directory, before.bytes, before.stat.mode) : null;
		writes.push({ path, directory, name, before, next, restore, committed: false, verified: false });
	}

	try {
		for (const change of pending) {
			// The plan's absolute file and relative runtime path recover its canonical workspace root.
			const root = resolve(change.path, ...change.file.split("/").map(() => ".."));
			pinDirectory(root, false);
			const directory = pinDirectory(dirname(change.path), true);
			const name = join(directory.anchor, change.file.split("/").at(-1)!);
			const before = snapshot(name);
			if ((before?.bytes.toString("utf8") ?? null) !== change.before) {
				throw new ProjectionRefused(`${change.path} changed since it was planned; re-run`);
			}
			if (before) {
				const backupPath = `${change.path}.substrate-backup`;
				const backup = snapshot(`${name}.substrate-backup`);
				prepare(backupPath, directory, backup, before.bytes, before.stat.mode);
			}
			prepare(change.path, directory, before, change.after, before?.stat.mode);
		}
		// Detect changes during staging before the first publication, then recheck immediately before each one.
		for (const write of writes) {
			checkDirectory(write.directory);
			if (!sameSnapshot(snapshot(write.name), write.before)) {
				throw new ProjectionRefused(`${write.path} changed during staging; re-run`);
			}
		}
		for (const write of writes) {
			checkDirectory(write.directory);
			if (!sameSnapshot(snapshot(write.name), write.before)) {
				throw new ProjectionRefused(`${write.path} changed during apply; re-run`);
			}
			if (!sameSnapshot(snapshot(write.next.path), write.next.snapshot)) {
				throw new ProjectionRefused(`${write.path} staging file changed during apply`);
			}
			if (write.before) {
				renameSync(write.next.path, write.name);
			} else {
				// Unlike rename, link refuses an intervening creation. The staged file is already complete.
				linkSync(write.next.path, write.name);
			}
			write.committed = true;
			// link/rename changes ctime. If this read fails, rollback still owns the staged inode and bytes.
			const installed = snapshot(write.name);
			if (!installed || !sameIdentity(installed.stat, write.next.snapshot.stat) ||
				!installed.bytes.equals(write.next.snapshot.bytes)) {
				throw new ProjectionRefused(`${write.path} changed during publication`);
			}
			write.next.snapshot = installed;
			write.verified = true;
			checkDirectory(write.directory);
		}
	} catch (cause) {
		applyError = cause;
		for (const write of [...writes].reverse()) {
			if (!write.committed) continue;
			try {
				// Use the pinned directory even if its old pathname was replaced. Never follow the replacement.
				if (!ownsPublished(snapshot(write.name), write)) {
					throw new Error("changed externally; preserved instead of overwriting");
				}
				if (write.restore) {
					if (!sameSnapshot(snapshot(write.restore.path), write.restore.snapshot)) {
						throw new Error("rollback staging file changed externally");
					}
					renameSync(write.restore.path, write.name);
				} else unlinkSync(write.name);
			} catch (rollbackCause) {
				failures.push(`${write.path}: ${String(rollbackCause)}`);
			}
		}
	} finally {
		for (const file of staged) {
			try {
				const current = lstatSync(file.path, { throwIfNoEntry: false });
				// A substituted pathname is not ours to delete, even if it lives in our temp namespace.
				if (current && sameIdentity(current, file.snapshot.stat)) unlinkSync(file.path);
			} catch (cause) {
				failures.push(`staging cleanup: ${String(cause)}`);
			}
		}
		// Only remove a directory we created, still at its original location, and still empty.
		for (const directory of [...createdDirectories].reverse()) {
			try {
				const now = lstatSync(directory.path, { throwIfNoEntry: false });
				if (!now) continue;
				if (!now.isDirectory() || !sameIdentity(now, directory.stat)) {
					throw new Error(`${directory.path} changed externally; preserved instead of removing`);
				}
				rmdirSync(directory.path);
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "ENOTEMPTY") failures.push(`directory cleanup: ${String(cause)}`);
			}
		}
		for (const directory of directories.values()) closeSync(directory.fd);
	}
	if (applyError !== undefined) {
		throw new ProjectionRefused(
			`${String(applyError)}; ${failures.length ? `rollback incomplete: ${failures.join("; ")}` : "no config or backup changes retained"}`,
		);
	}
	if (failures.length) throw new ProjectionRefused(`apply completed but cleanup incomplete: ${failures.join("; ")}`);
	return pending;
}

/** The lines the plan adds, as a reader of a dry run wants them: per file, what is appended. */
export function describe(changes: readonly Change[]): string[] {
	const lines: string[] = [];
	for (const change of changes) {
		const rel = change.file;
		const who = change.runtimes.join(", ");
		if (change.status === "current") {
			lines.push(`= ${rel}: ${SERVER} already present (${who})`);
			continue;
		}
		lines.push(`${change.status === "create" ? "+ create" : "+ append to"} ${rel} (${who}):`);
		const added =
			change.format === "toml"
				? tomlBlock().trimEnd().split("\n")
				: JSON.stringify({ mcpServers: { [SERVER]: jsonEntry() } }, null, 2).split("\n");
		for (const line of added) lines.push(`    ${line}`);
	}
	return lines;
}

function usage(message: string): never {
	process.stderr.write(
		`[projector] ${message}\nusage: swarm-workspace.ts --workspace <ws> [--runtimes ${RUNTIMES.join(",")}] --plan|--check|--apply\n` +
			"       swarm-workspace.ts --spec\n",
	);
	process.exit(2);
}

function main(argv: string[]): number {
	if (argv.includes("--spec")) {
		process.stdout.write(`${JSON.stringify(spec(), null, 2)}\n`);
		return 0;
	}
	const at = argv.indexOf("--workspace");
	const workspace = at >= 0 ? argv[at + 1] : undefined;
	if (!workspace) usage("--workspace is required");
	const modes = ["--plan", "--check", "--apply"].filter((mode) => argv.includes(mode));
	if (modes.length !== 1) usage("give exactly one of --plan, --check, --apply");
	const rt = argv.indexOf("--runtimes");
	const runtimes = rt >= 0 ? (argv[rt + 1] ?? "").split(",").map((r) => r.trim()).filter(Boolean) : RUNTIMES;
	if (runtimes.length === 0) usage("--runtimes needs at least one runtime");
	try {
		const changes = plan(workspace, runtimes);
		const pending = changes.filter((change) => change.status !== "current");
		for (const line of describe(changes)) process.stdout.write(`${line}\n`);
		if (modes[0] === "--check") return pending.length > 0 ? 1 : 0;
		if (modes[0] === "--apply") {
			apply(changes);
			for (const change of pending) {
				const backup = change.before !== null ? ` (backup at ${change.path}.substrate-backup)` : "";
				process.stdout.write(`[projector] wrote ${change.path}${backup}\n`);
			}
		}
		return 0;
	} catch (cause) {
		if (cause instanceof ProjectionRefused) {
			process.stderr.write(`[projector] refused: ${cause.message}.\n`);
			return 2;
		}
		throw cause;
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
