/**
 * Cursor projector stop entry. Spawned as a process so importing the script
 * does not touch the live hooks file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "cursor.ts");
const CLI = join(import.meta.dir, "..", "..", "cli", "src", "index.ts");
const STOP_SCRIPT = join(import.meta.dir, "..", "..", "collectors", "src", "cursor-stop.ts");
const STOP = `bun ${STOP_SCRIPT} >/dev/null 2>&1 || true`;

const made: string[] = [];
afterEach(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
	made.length = 0;
});

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync(["bun", SCRIPT, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: process.env.PATH ?? "", ...env },
	});
	return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("cursor projector", () => {
	test("--print-desired stop command is the live cursor-stop line, and the other entries are unchanged", () => {
		const result = run(["--print-desired"]);
		expect(result.code).toBe(0);
		const desired = JSON.parse(result.stdout) as Record<string, { command: string }>;
		expect(desired.stop?.command).toBe(STOP);
		expect(desired.sessionStart?.command).toBe(`bun ${CLI} brief --surface cursor --write >/dev/null 2>&1 || true`);
		expect(desired.postToolUse?.command).toBe(
			`bun ${CLI} emit --kind tool.call --summary 'cursor tool call' --surface cursor --actor human >/dev/null 2>&1 || true`,
		);
	});

	test("--check is already current for a live-equal file and exits 1 when stop is stale", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-hooks-"));
		made.push(dir);
		const path = join(dir, "hooks.json");
		const desired = JSON.parse(run(["--print-desired"]).stdout) as Record<string, unknown>;
		const live = {
			version: 1,
			hooks: {
				sessionStart: [desired.sessionStart, { type: "command", command: "other", "gsd-managed": true }],
				postToolUse: [desired.postToolUse],
				stop: [desired.stop],
			},
		};
		writeFileSync(path, `${JSON.stringify(live, null, 2)}\n`);
		const current = run(["--check", "--path", path]);
		expect(current.code).toBe(0);
		expect(current.stdout).toContain("already current");

		const stale = structuredClone(live) as typeof live;
		(stale.hooks.stop[0] as { command: string }).command = "bun old-stop";
		writeFileSync(path, `${JSON.stringify(stale, null, 2)}\n`);
		const drifted = run(["--check", "--path", path]);
		expect(drifted.code).toBe(1);
		expect(drifted.stdout).toContain("~ stop");
	});

	test("SUBSTRATE_CLI and SUBSTRATE_CURSOR_STOP override the checkout paths", () => {
		const result = run(["--print-desired"], {
			SUBSTRATE_CLI: "/opt/substrate/cli.ts",
			SUBSTRATE_CURSOR_STOP: "/opt/substrate/cursor-stop.ts",
		});
		expect(result.code).toBe(0);
		const desired = JSON.parse(result.stdout) as Record<string, { command: string }>;
		expect(desired.sessionStart?.command).toBe(
			"bun /opt/substrate/cli.ts brief --surface cursor --write >/dev/null 2>&1 || true",
		);
		expect(desired.stop?.command).toBe("bun /opt/substrate/cursor-stop.ts >/dev/null 2>&1 || true");
		expect(result.stdout).not.toContain(CLI);
	});

	test("with no --path the hooks file is ~/.cursor/hooks.json", () => {
		const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
		made.push(home);
		const result = run([], { HOME: home });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(join(home, ".cursor", "hooks.json"));
		expect(result.stderr).not.toContain("/root/.cursor/hooks.json");
	});
});
