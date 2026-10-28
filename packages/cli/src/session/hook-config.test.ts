/**
 * `session hook-config`: the printed text is stable, names the exact CLI invocation, references only commands
 * the grammar accepts, and installs nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTemp, makeRepo } from "../../../worktree-snapshot/src/testkit.ts";
import { type SessionDeps, EXIT_DONE, EXIT_USAGE, parseSessionArgs, runSession } from "./command.ts";
import { CLAUDE_CODE_HOOK_COMMAND, GIT_POST_COMMIT_HOOK_COMMAND, HOOK_CONFIG_TARGETS, renderHookConfig } from "./hook-config.ts";
import { HOOK_TIMEOUT_MS } from "./hook.ts";
import { FakeTranscript, seededRandomBytes } from "./testkit.ts";

afterAll(cleanupTemp);

const CLAUDE_CODE_TEXT = `{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "substrate session hook turn",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
`;

const GIT_POST_COMMIT_TEXT = `#!/bin/sh
# Save as .git/hooks/post-commit and make it executable (or append the command line to an existing post-commit, before any exit).
# After each commit it takes a plan-step checkpoint of the worktree, at most one every ten seconds.
# There is no Claude Code envelope on stdin: the session is the one that already has checkpoints in this worktree
# (add \`--session ID\` to name it). The command is fail-open and runs in the background, so the commit never waits.
substrate session hook plan-step --plan-step "$(git rev-parse --short HEAD)" </dev/null >/dev/null 2>&1 &
exit 0
`;

describe("the printed text", () => {
	test("claude-code is exactly the pinned settings JSON", () => {
		expect(renderHookConfig("claude-code")).toBe(CLAUDE_CODE_TEXT);
	});

	test("git-post-commit is exactly the pinned script", () => {
		expect(renderHookConfig("git-post-commit")).toBe(GIT_POST_COMMIT_TEXT);
	});

	test("the claude-code text is valid JSON: a Stop hook running the exact turn command, with room above the hook's own budget", () => {
		const settings = JSON.parse(renderHookConfig("claude-code")) as { hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }> } };
		const entry = settings.hooks.Stop[0]?.hooks[0];
		expect(entry?.type).toBe("command");
		expect(entry?.command).toBe("substrate session hook turn");
		expect(entry?.command).toBe(CLAUDE_CODE_HOOK_COMMAND);
		expect((entry?.timeout ?? 0) * 1000).toBeGreaterThan(HOOK_TIMEOUT_MS);
	});

	test("the git script calls the plan-step hook, backgrounded, with stdin and output discarded, and exits 0", () => {
		const script = renderHookConfig("git-post-commit");
		expect(script.startsWith("#!/bin/sh\n")).toBe(true);
		expect(script).toContain(GIT_POST_COMMIT_HOOK_COMMAND);
		expect(script).toContain("</dev/null >/dev/null 2>&1 &");
		expect(script.endsWith("exit 0\n")).toBe(true);
	});

	test("every target is rendered, deterministically", () => {
		for (const target of HOOK_CONFIG_TARGETS) expect(renderHookConfig(target)).toBe(renderHookConfig(target));
	});
});

describe("only commands that exist", () => {
	test("each printed invocation parses under the session grammar", () => {
		for (const command of [CLAUDE_CODE_HOOK_COMMAND, GIT_POST_COMMIT_HOOK_COMMAND]) {
			const [bin, group, ...argv] = command.split(" ");
			expect(bin).toBe("substrate");
			expect(group).toBe("session");
			expect(typeof parseSessionArgs(argv)).toBe("object");
		}
		// The script adds the plan-step reference the shell substitutes.
		expect(typeof parseSessionArgs(["hook", "plan-step", "--plan-step", "abc1234"])).toBe("object");
	});
});

describe("through the command", () => {
	function rig(): { dir: string; out: string[]; err: string[]; deps: SessionDeps } {
		const dir = makeRepo();
		const out: string[] = [];
		const err: string[] = [];
		const deps: SessionDeps = {
			worktree: dir,
			url: "http://127.0.0.1:7410",
			tokenFor: () => undefined,
			timeoutMs: 1500,
			now: () => new Date("2026-01-01T00:00:00.000Z"),
			randomBytes: seededRandomBytes(1),
			transcript: new FakeTranscript(),
			out: (text) => out.push(text),
			err: (text) => err.push(text),
			fetch: async () => {
				throw new Error("the network must not be used");
			},
		};
		return { dir, out, err, deps };
	}

	for (const target of HOOK_CONFIG_TARGETS) {
		test(`hook-config ${target} prints the text, exits 0, and writes nothing`, async () => {
			const r = rig();
			const before = readdirSync(join(r.dir, ".git")).sort();
			const exit = await runSession(["hook-config", target], r.deps);
			expect(exit).toBe(EXIT_DONE);
			expect(r.out.join("")).toBe(renderHookConfig(target));
			expect(r.err).toEqual([]);
			expect(readdirSync(join(r.dir, ".git")).sort()).toEqual(before);
			expect(existsSync(join(r.dir, ".claude"))).toBe(false);
			expect(existsSync(join(r.dir, ".git", "hooks", "post-commit"))).toBe(false);
		});
	}

	test("an unknown target is a usage error and prints nothing", async () => {
		const r = rig();
		expect(await runSession(["hook-config", "vim"], r.deps)).toBe(EXIT_USAGE);
		expect(r.out).toEqual([]);
		expect(r.err.join("")).toContain("hook-config takes exactly one target: claude-code, git-post-commit");
	});
});
