#!/usr/bin/env bun
/**
 * Project substrate hooks into Cursor's `hooks.json`.
 *
 *   bun packages/projector/src/cursor.ts [--check] [--remove] [--path P] [--print-desired]
 *
 * The file is GSD-managed: every existing entry carries `gsd-managed: true` and
 * belongs to another owner. This appends its own entries, tagged
 * `substrate-managed: true`, and touches nothing else — so re-running GSD's own
 * projector and this one in either order converges.
 *
 * Only the events this Cursor build actually declares are used. The design doc
 * also names `afterFileEdit` and `afterShellExecution`; whether those fire for
 * the CLI is still unverified (Notion §12), so they are not written here.
 *
 * `stop` runs a script rather than a CLI subcommand: packages/collectors/src/
 * cursor-stop.ts reads the stop envelope on stdin (inherited from the hook),
 * keeps a redacted transcript copy for the skill miner and emits session.end
 * (D-15). `--print-desired` prints the entries this would write, as JSON, and
 * touches no file.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";

const DEFAULT_PATH = "/root/.cursor/hooks.json";
const CLI = process.env.SUBSTRATE_CLI ?? "/root/src/repos/agent-substrate/packages/cli/src/index.ts";
const STOP_SCRIPT =
	process.env.SUBSTRATE_CURSOR_STOP ?? "/root/src/repos/agent-substrate/packages/collectors/src/cursor-stop.ts";

interface HookEntry {
	type: string;
	command: string;
	"gsd-managed"?: boolean;
	"substrate-managed"?: boolean;
}
interface HooksFile {
	hooks?: Record<string, HookEntry[]>;
	version?: number;
	[key: string]: unknown;
}

/** `|| true` keeps a substrate outage from failing the hook and stalling the turn. */
function command(args: string): HookEntry {
	return {
		type: "command",
		command: `bun ${CLI} ${args} >/dev/null 2>&1 || true`,
		"substrate-managed": true,
	};
}

/** A hook that runs a script directly, stdin inherited; same `|| true` rule. */
function script(path: string): HookEntry {
	return {
		type: "command",
		command: `bun ${path} >/dev/null 2>&1 || true`,
		"substrate-managed": true,
	};
}

const DESIRED: Record<string, HookEntry> = {
	// Writes .substrate/BRIEF.md into the workspace so the session can read it.
	sessionStart: command("brief --surface cursor --write"),
	postToolUse: command("emit --kind tool.call --summary 'cursor tool call' --surface cursor --actor human"),
	stop: script(STOP_SCRIPT),
};

const args = process.argv.slice(2);
if (args.includes("--print-desired")) {
	process.stdout.write(`${JSON.stringify(DESIRED, null, 2)}\n`);
	process.exit(0);
}
const checkOnly = args.includes("--check");
const remove = args.includes("--remove");
const pathIndex = args.indexOf("--path");
const path = pathIndex >= 0 ? (args[pathIndex + 1] ?? DEFAULT_PATH) : DEFAULT_PATH;

if (!existsSync(path)) {
	process.stderr.write(`[projector] ${path} does not exist — is Cursor installed here?\n`);
	process.exit(1);
}

const original = readFileSync(path, "utf8");
let file: HooksFile;
try {
	file = JSON.parse(original) as HooksFile;
} catch (cause) {
	process.stderr.write(`[projector] ${path} is not valid JSON, refusing to touch it: ${String(cause)}\n`);
	process.exit(1);
}

file.hooks ??= {};
const changes: string[] = [];

for (const [event, entry] of Object.entries(DESIRED)) {
	const list: HookEntry[] = (file.hooks[event] ??= []);
	const mine = list.findIndex((e) => e["substrate-managed"] === true);

	if (remove) {
		if (mine >= 0) {
			list.splice(mine, 1);
			changes.push(`− ${event}`);
		}
		continue;
	}
	if (mine < 0) {
		list.push(entry);
		changes.push(`+ ${event}`);
	} else if (list[mine]?.command !== entry.command) {
		list[mine] = entry;
		changes.push(`~ ${event}`);
	}
}

const foreign = Object.values(file.hooks)
	.flat()
	.filter((e) => e["gsd-managed"]).length;

if (changes.length === 0) {
	process.stdout.write(`[projector] ${path} already current (${foreign} gsd-managed entries untouched)\n`);
	process.exit(0);
}

if (checkOnly) {
	process.stdout.write(`[projector] would change: ${changes.join(", ")}\n`);
	process.exit(1);
}

copyFileSync(path, `${path}.substrate-backup`);
writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
process.stdout.write(
	`[projector] ${path}: ${changes.join(", ")} (${foreign} gsd-managed entries untouched, backup at ${path}.substrate-backup)\n`,
);
