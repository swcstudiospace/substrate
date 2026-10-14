/**
 * Cursor MCP projector. Spawned so importing the script does not write ~/.cursor.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "cursor-mcp.ts");
const SECRET = "super-secret-token-xyz";

const made: string[] = [];
afterEach(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
	made.length = 0;
});

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync(["bun", SCRIPT, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: process.env.PATH ?? "", SUBSTRATE_TOKEN: SECRET, SUBSTRATE_URL: "http://127.0.0.1:7410", ...env },
	});
	return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-mcp-"));
	made.push(dir);
	return dir;
}

describe("cursor MCP projector", () => {
	test("--print-desired names the placeholders and never the token value", () => {
		const result = run(["--print-desired"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("${SUBSTRATE_URL}/mcp");
		expect(result.stdout).toContain("Bearer ${SUBSTRATE_TOKEN}");
		expect(result.stdout).not.toContain(SECRET);
		expect(result.stdout).not.toContain("127.0.0.1");
	});

	test("creates a missing file, is current the second time, and leaves other servers", () => {
		const dir = scratch();
		const path = join(dir, "mcp.json");
		writeFileSync(path, `${JSON.stringify({ mcpServers: { other: { url: "http://example.test" } } }, null, 2)}\n`);
		const check = run(["--check", "--path", path]);
		expect(check.code).toBe(1);
		expect(check.stdout).toContain("would append");
		const applied = run(["--path", path]);
		expect(applied.code).toBe(0);
		const body = readFileSync(path, "utf8");
		expect(body).toContain("${SUBSTRATE_URL}/mcp");
		expect(body).toContain("Bearer ${SUBSTRATE_TOKEN}");
		expect(body).not.toContain(SECRET);
		const parsed = JSON.parse(body) as { mcpServers: Record<string, { url?: string }> };
		expect(parsed.mcpServers.other?.url).toBe("http://example.test");
		expect(run(["--check", "--path", path]).code).toBe(0);
	});

	test("refuses invalid JSON, a differing substrate entry, and a symlink", () => {
		const dir = scratch();
		const path = join(dir, "mcp.json");
		writeFileSync(path, "{");
		const bad = run(["--path", path]);
		expect(bad.code).toBe(2);
		expect(bad.stderr).toContain("not valid JSON");
		expect(readFileSync(path, "utf8")).toBe("{");

		writeFileSync(path, `${JSON.stringify({ mcpServers: { substrate: { url: "http://elsewhere" } } })}\n`);
		const differ = run(["--path", path]);
		expect(differ.code).toBe(2);
		expect(differ.stderr).toContain("differs");
		expect(readFileSync(path, "utf8")).toContain("http://elsewhere");

		const target = join(dir, "real.json");
		const link = join(dir, "link.json");
		writeFileSync(target, "{}\n");
		symlinkSync(target, link);
		const linked = run(["--path", link]);
		expect(linked.code).toBe(2);
		expect(linked.stderr).toContain("symlink");
		expect(readFileSync(target, "utf8")).toBe("{}\n");
	});

	test("--remove drops only substrate", () => {
		const dir = scratch();
		const path = join(dir, "mcp.json");
		expect(run(["--path", path]).code).toBe(0);
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
		parsed.mcpServers.other = { url: "http://example.test" };
		writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
		expect(run(["--remove", "--path", path]).code).toBe(0);
		const after = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
		expect(after.mcpServers.substrate).toBeUndefined();
		expect(after.mcpServers.other).toEqual({ url: "http://example.test" });
		expect(run(["--remove", "--path", path]).stdout).toContain("already current");
	});

	test("the default path is ~/.cursor/mcp.json", () => {
		const home = scratch();
		mkdirSync(join(home, ".cursor"));
		const result = run(["--check"], { HOME: home });
		expect(result.code).toBe(1);
		expect(result.stdout).toContain(join(home, ".cursor", "mcp.json"));
	});
});
