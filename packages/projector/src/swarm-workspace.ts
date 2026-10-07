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
 * Exit codes: 0 done (or nothing to do), 1 `--check` found changes, 2 refused or bad usage. Nothing is written
 * unless every file of the plan can be written.
 */
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
	const servers = parsed.mcpServers ?? {};
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
	const unknown = runtimes.filter((runtime) => !(runtime in RUNTIME_FILES));
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
		const before = existsSync(path) ? readFileSync(path, "utf8") : null;
		const planned = format === "json" ? planJson(path, before) : planToml(path, before);
		changes.push({ path, file: rel, runtimes: users, format, before, ...planned });
	}
	return changes;
}

/**
 * Write the changes `plan` returned. Refuses the lot if any file changed since it was planned. A file that existed is
 * copied to `<file>.substrate-backup` first; each write is a rename, so a reader never sees half a file.
 */
export function apply(changes: readonly Change[]): Change[] {
	const pending = changes.filter((change) => change.status !== "current");
	for (const change of pending) {
		const now = existsSync(change.path) ? readFileSync(change.path, "utf8") : null;
		if (now !== change.before) throw new ProjectionRefused(`${change.path} changed since it was planned; re-run`);
	}
	for (const change of pending) {
		mkdirSync(dirname(change.path), { recursive: true });
		if (change.before !== null) copyFileSync(change.path, `${change.path}.substrate-backup`);
		const tmp = `${change.path}.substrate-tmp-${process.pid}`;
		writeFileSync(tmp, change.after);
		renameSync(tmp, change.path);
	}
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
			process.stderr.write(`[projector] refused: ${cause.message}. Nothing was written.\n`);
			return 2;
		}
		throw cause;
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
