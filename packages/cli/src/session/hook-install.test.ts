/**
 * `session hook-install claude-code`: the merge keeps every other key, is idempotent, refuses a file it cannot read without
 * touching it, and writes only with `--write` (a backup of the previous file, a new file owner-only). Every test runs on a
 * scratch directory; nothing touches a real Claude Code settings file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_DONE, EXIT_FAILED, EXIT_USAGE, parseSessionArgs, runSession, type SessionDeps } from "./command.ts";
import { CLAUDE_CODE_HOOK_COMMAND, CLAUDE_CODE_TIMEOUT_SECONDS, renderHookConfig } from "./hook-config.ts";
import { HOOK_INSTALL_BACKUP_SUFFIX, HOOK_INSTALL_MAX_BYTES, HookInstallError, installClaudeCodeHook, mergeStopHook } from "./hook-install.ts";
import { FakeTranscript, seededRandomBytes } from "./testkit.ts";

const scratch: string[] = [];
function dir(): string {
	const made = mkdtempSync(join(tmpdir(), "hook-install-"));
	scratch.push(made);
	return made;
}
afterAll(() => {
	for (const made of scratch) rmSync(made, { recursive: true, force: true });
});

const STOP_GROUP = { hooks: [{ type: "command", command: CLAUDE_CODE_HOOK_COMMAND, timeout: CLAUDE_CODE_TIMEOUT_SECONDS }] };
const parse = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

describe("mergeStopHook", () => {
	test("no file or an empty file becomes the printed Stop hook, and nothing else", () => {
		for (const existing of [null, "", "  \n"]) {
			const merged = mergeStopHook(existing);
			expect(merged.added).toBe(true);
			expect(parse(merged.text)).toEqual({ hooks: { Stop: [STOP_GROUP] } });
			expect(merged.text.endsWith("\n")).toBe(true);
		}
	});

	test("the merged Stop hook is exactly the one hook-config claude-code prints", () => {
		expect(parse(mergeStopHook(null).text)).toEqual(parse(renderHookConfig("claude-code")));
	});

	test("every other key, and every other hook event, is kept in its order", () => {
		const existing = JSON.stringify({ model: "x", env: { A: "1" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }], Stop: [{ hooks: [{ type: "command", command: "ultrathink stop" }] }] } });
		const merged = mergeStopHook(existing);
		expect(merged.added).toBe(true);
		const settings = parse(merged.text);
		expect(Object.keys(settings)).toEqual(["model", "env", "hooks"]);
		expect(settings.env).toEqual({ A: "1" });
		const hooks = settings.hooks as Record<string, unknown>;
		expect(Object.keys(hooks)).toEqual(["PreToolUse", "Stop"]);
		expect(hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }]);
		expect(hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "ultrathink stop" }] }, STOP_GROUP]);
	});

	test("a file that already holds the hook is reported unchanged and its text is returned as it was", () => {
		const existing = `${JSON.stringify({ hooks: { Stop: [STOP_GROUP] } }, null, 4)}\n`;
		expect(mergeStopHook(existing)).toEqual({ added: false, text: existing });
	});

	test("merging twice gives the same file as merging once", () => {
		const once = mergeStopHook('{"theme":"dark"}');
		const twice = mergeStopHook(once.text);
		expect(twice).toEqual({ added: false, text: once.text });
	});

	test("a file that is not a JSON object is refused, and the refusal never echoes the file", () => {
		const secret = "sk-SECRET-DO-NOT-ECHO";
		for (const existing of [`{"env":{"K":"${secret}"`, "[]", "null", "42", '"text"']) {
			let caught: unknown = null;
			try {
				mergeStopHook(existing);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(HookInstallError);
			expect((caught as HookInstallError).code).toBe("malformed");
			expect((caught as Error).message).not.toContain(secret);
		}
	});

	test("hooks or hooks.Stop of the wrong shape is refused rather than rewritten", () => {
		expect(() => mergeStopHook('{"hooks":[]}')).toThrow("`hooks` in the settings file must be an object");
		expect(() => mergeStopHook('{"hooks":{"Stop":{}}}')).toThrow("`hooks.Stop` in the settings file must be an array");
	});

	test("a Stop group with no hook array, or a hook that is not an object, does not count as present", () => {
		const merged = mergeStopHook(JSON.stringify({ hooks: { Stop: [{ matcher: "x" }, "junk", { hooks: [null, { command: "other" }] }] } }));
		expect(merged.added).toBe(true);
		expect(parse(merged.text).hooks).toEqual({ Stop: [{ matcher: "x" }, "junk", { hooks: [null, { command: "other" }] }, STOP_GROUP] });
	});
});

describe("installClaudeCodeHook", () => {
	test("dry run reads the file, reports what it would add, and writes nothing", async () => {
		const home = dir();
		const path = join(home, "settings.json");
		writeFileSync(path, '{"theme":"dark"}\n');
		const report = await installClaudeCodeHook(path, false);
		expect(report).toEqual({ added: true, written: false, backup: null });
		expect(readFileSync(path, "utf8")).toBe('{"theme":"dark"}\n');
		expect(readdirSync(home)).toEqual(["settings.json"]);
	});

	test("write adds the hook, keeps the previous file beside it, and keeps the file's permission bits", async () => {
		const home = dir();
		const path = join(home, "settings.json");
		writeFileSync(path, '{"theme":"dark"}\n', { mode: 0o640 });
		const report = await installClaudeCodeHook(path, true);
		expect(report).toEqual({ added: true, written: true, backup: `${path}${HOOK_INSTALL_BACKUP_SUFFIX}` });
		expect(parse(readFileSync(path, "utf8"))).toEqual({ theme: "dark", hooks: { Stop: [STOP_GROUP] } });
		expect(readFileSync(`${path}${HOOK_INSTALL_BACKUP_SUFFIX}`, "utf8")).toBe('{"theme":"dark"}\n');
		expect(statSync(path).mode & 0o777).toBe(0o640);
		expect(readdirSync(home).sort()).toEqual(["settings.json", `settings.json${HOOK_INSTALL_BACKUP_SUFFIX}`]);
	});

	test("a missing file is created owner-only and has no backup", async () => {
		const home = dir();
		const path = join(home, "fresh.json");
		expect(await installClaudeCodeHook(path, true)).toEqual({ added: true, written: true, backup: null });
		expect(parse(readFileSync(path, "utf8"))).toEqual({ hooks: { Stop: [STOP_GROUP] } });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(home)).toEqual(["fresh.json"]);
	});

	test("a second write finds the hook present, writes nothing, and keeps the backup it made the first time", async () => {
		const home = dir();
		const path = join(home, "settings.json");
		writeFileSync(path, "{}\n");
		await installClaudeCodeHook(path, true);
		const afterFirst = readFileSync(path, "utf8");
		const backupBefore = readFileSync(`${path}${HOOK_INSTALL_BACKUP_SUFFIX}`, "utf8");
		expect(await installClaudeCodeHook(path, true)).toEqual({ added: false, written: false, backup: null });
		expect(readFileSync(path, "utf8")).toBe(afterFirst);
		expect(readFileSync(`${path}${HOOK_INSTALL_BACKUP_SUFFIX}`, "utf8")).toBe(backupBefore);
	});

	test("a directory that does not exist is an unwritable error, and the failed write leaves no temporary file", async () => {
		const home = dir();
		const path = join(home, "missing-dir", "settings.json");
		await expect(installClaudeCodeHook(path, true)).rejects.toMatchObject({ code: "unwritable" });
		expect(existsSync(join(home, "missing-dir"))).toBe(false);
	});

	test("a settings path that is a directory is unreadable and untouched", async () => {
		const home = dir();
		const path = join(home, "settings.d");
		mkdirSync(path);
		await expect(installClaudeCodeHook(path, true)).rejects.toMatchObject({ code: "unreadable" });
		expect(readdirSync(path)).toEqual([]);
	});

	test("a file over the size bound is refused unread", async () => {
		const home = dir();
		const path = join(home, "big.json");
		writeFileSync(path, "x".repeat(HOOK_INSTALL_MAX_BYTES + 1));
		await expect(installClaudeCodeHook(path, true)).rejects.toMatchObject({ code: "too-large" });
		expect(readFileSync(path, "utf8")).toHaveLength(HOOK_INSTALL_MAX_BYTES + 1);
	});

	test("a symlinked settings file is read through the link, and a write refuses it so the link is never replaced", async () => {
		const home = dir();
		const target = join(home, "real.json");
		const link = join(home, "link.json");
		writeFileSync(target, "{}\n");
		symlinkSync(target, link);
		expect(await installClaudeCodeHook(link, false)).toEqual({ added: true, written: false, backup: null });
		await expect(installClaudeCodeHook(link, true)).rejects.toMatchObject({ code: "unwritable" });
		expect(readFileSync(target, "utf8")).toBe("{}\n");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readdirSync(home).sort()).toEqual(["link.json", "real.json"]);
	});

	test("a malformed file is refused and left exactly as it was", async () => {
		const home = dir();
		const path = join(home, "settings.json");
		writeFileSync(path, '{"hooks": ');
		await expect(installClaudeCodeHook(path, true)).rejects.toMatchObject({ code: "malformed" });
		expect(readFileSync(path, "utf8")).toBe('{"hooks": ');
		expect(readdirSync(home)).toEqual(["settings.json"]);
	});
});

describe("hook-install through the command", () => {
	function rig(): { out: string[]; err: string[]; deps: SessionDeps } {
		const out: string[] = [];
		const err: string[] = [];
		const deps: SessionDeps = {
			worktree: dir(),
			url: "http://127.0.0.1:7410",
			tokenFor: () => undefined,
			timeoutMs: 1500,
			now: () => new Date("2026-01-01T00:00:00.000Z"),
			randomBytes: seededRandomBytes(1),
			transcript: new FakeTranscript(),
			out: (text) => out.push(text),
			err: (text) => err.push(text),
			home: "/nonexistent-home-for-test",
			fetch: async () => {
				throw new Error("the network must not be used");
			},
		};
		return { out, err, deps };
	}

	test("the grammar accepts claude-code with --settings, and refuses every other shape", () => {
		expect(typeof parseSessionArgs(["hook-install", "claude-code", "--settings", "/tmp/s.json"])).toBe("object");
		expect(typeof parseSessionArgs(["hook-install", "claude-code", "--settings", "/tmp/s.json", "--write"])).toBe("object");
		const refused = [
			["hook-install", "claude-code"],
			["hook-install", "--settings", "/tmp/s.json"],
			["hook-install", "steering", "--settings", "/tmp/s.json"],
			["hook-install", "claude-code", "git-post-commit", "--settings", "/tmp/s.json"],
			["hook-install", "claude-code", "--settings"],
			["hook-install", "claude-code", "--settings", "/tmp/s.json", "--json"],
		];
		for (const argv of refused) expect(typeof parseSessionArgs(argv)).toBe("string");
	});

	test("a refused command prints usage, exits 2 and touches nothing", async () => {
		const r = rig();
		expect(await runSession(["hook-install", "steering", "--settings", join(dir(), "s.json")], r.deps)).toBe(EXIT_USAGE);
		expect(r.out).toEqual([]);
		expect(r.err.join("")).toContain("usage: substrate session checkpoint");
	});

	test("dry run prints the hook it would add and never the file's contents", async () => {
		const r = rig();
		const home = dir();
		const path = join(home, "settings.json");
		writeFileSync(path, '{"env":{"TOKEN":"tok-DO-NOT-PRINT"}}\n');
		expect(await runSession(["hook-install", "claude-code", "--settings", path], r.deps)).toBe(EXIT_DONE);
		const printed = r.out.join("");
		expect(printed).toContain("dry run: nothing written");
		expect(printed).toContain(CLAUDE_CODE_HOOK_COMMAND);
		expect(printed).not.toContain("tok-DO-NOT-PRINT");
		expect(readFileSync(path, "utf8")).toBe('{"env":{"TOKEN":"tok-DO-NOT-PRINT"}}\n');
	});

	test("--write adds the hook and says where the previous file went; a second run says nothing changed", async () => {
		const r = rig();
		const home = dir();
		const path = join(home, "settings.json");
		writeFileSync(path, "{}\n");
		expect(await runSession(["hook-install", "claude-code", "--settings", path, "--write"], r.deps)).toBe(EXIT_DONE);
		expect(r.out.join("")).toContain(`added the Stop hook to ${path}; the previous file is kept at ${path}${HOOK_INSTALL_BACKUP_SUFFIX}`);
		expect(parse(readFileSync(path, "utf8"))).toEqual({ hooks: { Stop: [STOP_GROUP] } });
		const again = rig();
		expect(await runSession(["hook-install", "claude-code", "--settings", path, "--write"], again.deps)).toBe(EXIT_DONE);
		expect(again.out.join("")).toContain("already in");
		expect(again.out.join("")).toContain("nothing to change");
	});

	test("a malformed file fails with exit 1, a message, and an unchanged file", async () => {
		const r = rig();
		const home = dir();
		const path = join(home, "settings.json");
		writeFileSync(path, '{"env":{"K":"sk-SECRET"}');
		expect(await runSession(["hook-install", "claude-code", "--settings", path, "--write"], r.deps)).toBe(EXIT_FAILED);
		expect(r.err.join("")).toContain("substrate session hook-install: the settings file is not valid JSON");
		expect(r.err.join("")).not.toContain("sk-SECRET");
		expect(readFileSync(path, "utf8")).toBe('{"env":{"K":"sk-SECRET"}');
	});
});
