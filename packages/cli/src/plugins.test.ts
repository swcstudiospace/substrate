/** `substrate plugins`: table and --json output, presence booleans only, fake fs. */
import { describe, expect, test } from "bun:test";
import { collectPlugins, runPlugins, type PluginsDeps, type PluginsFs } from "./plugins.ts";

const SECRET = "sk-secret-never-printed-12345";

function fakeFs(files: Record<string, string>): PluginsFs & { readPaths: string[] } {
	const readPaths: string[] = [];
	return {
		readPaths,
		exists: (path) => path in files,
		read: (path) => {
			readPaths.push(path);
			return files[path] ?? null;
		},
	};
}

function deps(files: Record<string, string>, env: Record<string, string | undefined> = {}): PluginsDeps & { outText: string[]; errText: string[] } {
	const outText: string[] = [];
	const errText: string[] = [];
	return {
		outText,
		errText,
		env,
		home: "/fake/home",
		fs: fakeFs(files),
		out: (text) => outText.push(text),
		err: (text) => errText.push(text),
	};
}

describe("collectPlugins", () => {
	test("reports every registry surface with presence booleans only", () => {
		const rows = collectPlugins(deps({}, { SUBSTRATE_TOKEN: SECRET }));
		expect(rows.map((r) => r.surface)).toEqual([
			"omp",
			"grok-build",
			"grok-bot",
			"hermes",
			"codex",
			"opencode",
			"muse",
			"cursor",
			"claude-code",
			"pi",
		]);
		for (const row of rows) {
			expect(row.surface_in_registry).toBe(true);
			expect(row.token_present).toBe(true);
			// Probes with a known config path read "absent" (fake fs has no files);
			// surfaces with no probed path read "unknown" rather than a guessed absence.
			const PROBED: Record<string, true> = { "claude-code": true, cursor: true, hermes: true, muse: true, "grok-build": true, "grok-bot": true, omp: true, codex: true, opencode: true, pi: true };
			expect(row.mcp_entry).toBe(PROBED[row.surface] === true ? "absent" : "unknown");
			expect(["present", "absent", "unknown"]).toContain(row.hook_present);
			if (row.surface === "hermes") expect(row.hook_present).toBe("unknown");
			else expect(row.hook_present).toBe("absent");
		}
		expect(JSON.stringify(rows)).not.toContain(SECRET);
	});

	test("token absent when no env or file supplies one", () => {
		const rows = collectPlugins(deps({}));
		for (const row of rows) expect(row.token_present).toBe(false);
	});

	test("token present via per-surface file, value never copied into output", () => {
		const rows = collectPlugins(
			deps({ "/tokens/omp": SECRET }, { SUBSTRATE_TOKENS_DIR: "/tokens" }),
		);
		const omp = rows.find((r) => r.surface === "omp");
		expect(omp?.token_present).toBe(true);
		expect(rows.find((r) => r.surface === "pi")?.token_present).toBe(false);
		expect(JSON.stringify(rows)).not.toContain(SECRET);
	});

	test("mcp and hook presence follow file contents", () => {
		const rows = collectPlugins(
			deps({
				"/fake/home/.cursor/mcp.json": '{"mcpServers":{"substrate":{}}}',
				"/fake/home/.cursor/hooks.json": '{"hooks":{}}',
			}),
		);
		const cursor = rows.find((r) => r.surface === "cursor");
		expect(cursor?.mcp_entry).toBe("present");
		expect(cursor?.hook_present).toBe("absent");
	});
});

describe("runPlugins", () => {
	test("--json prints the status array", () => {
		const d = deps({}, { SUBSTRATE_TOKEN: SECRET });
		expect(runPlugins(["--json"], d)).toBe(0);
		const parsed: unknown = JSON.parse(d.outText.join(""));
		expect(Array.isArray(parsed)).toBe(true);
		expect(d.outText.join("")).not.toContain(SECRET);
		expect(d.errText).toEqual([]);
	});

	test("default prints a table naming every surface", () => {
		const d = deps({});
		expect(runPlugins([], d)).toBe(0);
		const text = d.outText.join("");
		for (const surface of ["omp", "grok-build", "claude-code", "pi"]) {
			expect(text).toContain(surface);
		}
		expect(text.startsWith("surface")).toBe(true);
	});

	test("unknown flag is a usage error (exit 2)", () => {
		const d = deps({});
		expect(runPlugins(["--bogus"], d)).toBe(2);
		expect(d.errText.join("")).toContain("usage: substrate plugins");
		expect(d.outText).toEqual([]);
	});
});
