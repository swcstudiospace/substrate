#!/usr/bin/env bun
/**
 * Project the `substrate` HTTP MCP entry into Cursor's mcp.json.
 *
 *   bun packages/projector/src/cursor-mcp.ts [--check] [--remove] [--path P] [--print-desired]
 *
 * The default file is ~/.cursor/mcp.json (`HOME` when set). The entry is the same
 * object the swarm workspace projector writes for Claude and omp: type http,
 * url `${SUBSTRATE_URL}/mcp`, Authorization `Bearer ${SUBSTRATE_TOKEN}`.
 * Those strings are written literally. A token value in the environment is never
 * interpolated.
 *
 * A missing file is created. Invalid JSON, a non-object document, a non-object
 * `mcpServers`, a symlink, or an existing `substrate` entry that is not identical
 * is refused and the file is left untouched. An identical entry is left as it is.
 * `--remove` deletes only the `substrate` key.
 *
 * Exit codes: 0 done or already current, 1 `--check` would change the file, 2 refused.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { jsonEntry, SERVER } from "./swarm-workspace.ts";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
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

function cursorHome(env: Record<string, string | undefined> = process.env): string {
	const fromEnv = env.HOME?.trim();
	return fromEnv ? fromEnv : homedir();
}

function defaultMcpPath(env: Record<string, string | undefined> = process.env): string {
	return join(cursorHome(env), ".cursor", "mcp.json");
}

/** The entry written under mcpServers.substrate. Placeholders only. */
function substrateEntry(): Record<string, unknown> {
	return jsonEntry();
}

class ProjectionRefused extends Error {}

interface Plan {
	status: "create" | "append" | "current" | "remove";
	after: string;
}

/**
 * Decide the next file body. `before` null means the file is absent.
 * `remove` drops the substrate key and leaves every other server.
 */
function planMcp(path: string, before: string | null, remove: boolean): Plan {
	const entry = substrateEntry();
	if (before === null) {
		if (remove) return { status: "current", after: "" };
		return { status: "create", after: `${JSON.stringify({ mcpServers: { [SERVER]: entry } }, null, 2)}\n` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(before);
	} catch (cause) {
		throw new ProjectionRefused(`${path} is not valid JSON, refusing to touch it: ${String(cause)}`);
	}
	if (!isObject(parsed)) throw new ProjectionRefused(`${path} is not a JSON object, refusing to touch it`);
	const servers = parsed.mcpServers === undefined ? {} : parsed.mcpServers;
	if (!isObject(servers)) throw new ProjectionRefused(`${path} has an mcpServers that is not an object`);
	const existing = servers[SERVER];
	if (remove) {
		if (existing === undefined) return { status: "current", after: before };
		const rest: Json = {};
		for (const [key, value] of Object.entries(servers)) {
			if (key !== SERVER) rest[key] = value;
		}
		parsed.mcpServers = rest;
		return { status: "remove", after: `${JSON.stringify(parsed, null, 2)}\n` };
	}
	if (existing !== undefined) {
		if (same(existing, entry)) return { status: "current", after: before };
		throw new ProjectionRefused(
			`${path} already has an mcpServers.${SERVER} entry that differs from the projection; ` +
				"the projector never replaces an entry it did not write identically. Remove it and re-run",
		);
	}
	parsed.mcpServers = { ...servers, [SERVER]: entry };
	return { status: "append", after: `${JSON.stringify(parsed, null, 2)}\n` };
}

function readFile(path: string): string | null {
	if (!existsSync(path)) return null;
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) throw new ProjectionRefused(`${path} is a symlink; the projector never writes through one`);
	if (!stat.isFile()) throw new ProjectionRefused(`${path} is not a regular file, refusing to touch it`);
	return readFileSync(path, "utf8");
}

function writeFile(path: string, body: string): void {
	const dir = dirname(path);
	if (existsSync(dir)) {
		if (lstatSync(dir).isSymbolicLink()) throw new ProjectionRefused(`${dir} is a symlink; the projector never writes through one`);
	} else {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, body, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

function fail(message: string): never {
	process.stderr.write(`[projector] ${message}\n`);
	process.exit(2);
}

function main(argv: string[]): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write("Usage: bun packages/projector/src/cursor-mcp.ts [--check] [--remove] [--path P] [--print-desired]\n");
		return 0;
	}
	if (argv.includes("--print-desired")) {
		process.stdout.write(`${JSON.stringify({ mcpServers: { [SERVER]: substrateEntry() } }, null, 2)}\n`);
		return 0;
	}
	const pathIndex = argv.indexOf("--path");
	const path = pathIndex >= 0 ? argv[pathIndex + 1] : undefined;
	if (pathIndex >= 0 && (path === undefined || path.startsWith("--"))) fail("missing value for --path");
	const file = path ?? defaultMcpPath();
	const checkOnly = argv.includes("--check");
	const remove = argv.includes("--remove");
	let before: string | null;
	try {
		before = readFile(file);
	} catch (cause) {
		if (cause instanceof ProjectionRefused) fail(cause.message);
		throw cause;
	}
	let plan: Plan;
	try {
		plan = planMcp(file, before, remove);
	} catch (cause) {
		if (cause instanceof ProjectionRefused) fail(cause.message);
		throw cause;
	}
	if (plan.status === "current") {
		process.stdout.write(`[projector] ${file} already current\n`);
		return 0;
	}
	if (checkOnly) {
		process.stdout.write(`[projector] would ${plan.status}: ${file}\n`);
		return 1;
	}
	if (before !== null) {
		writeFileSync(`${file}.substrate-backup`, before, { mode: 0o600 });
	}
	writeFile(file, plan.after);
	process.stdout.write(`[projector] ${file}: ${plan.status}\n`);
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
