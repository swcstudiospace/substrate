/**
 * `session hook-config`: the printed text is stable, names the exact CLI invocation, references only commands
 * the grammar accepts, and installs nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTemp, makeRepo } from "../../../worktree-snapshot/src/testkit.ts";
import { type SessionDeps, EXIT_DONE, EXIT_USAGE, parseSessionArgs, runSession } from "./command.ts";
import { BASELINE_HOOK_COMMAND, CLAUDE_CODE_HOOK_COMMAND, CONTEXT_HOOK_COMMAND, GIT_POST_COMMIT_HOOK_COMMAND, HOOK_CONFIG_TARGETS, STEERING_HOOK_COMMAND, renderHookConfig } from "./hook-config.ts";
import { HOOK_TIMEOUT_MS } from "./hook.ts";
import { HOOK_TRIGGERS, type HookTrigger } from "./trigger-policy.ts";
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

const STEERING_TEXT = `#!/bin/sh
# Run this from the session's worktree, by the host that applies a steering directive. ADR 0007 maps no Claude Code or git event to it:
# wire it to the place your host handles the \`checkpoint_hint\` of a \`steering_acknowledge\` reply, which carries the directive_id.
# After a directive it takes a steering checkpoint, once per directive id; it is skipped when the tree is unchanged.
# Set HISTORICAL_SESSION_ID (the checkpoint/memory label), STEERING_SESSION_ID (the server-issued live handle), BINDING_FILE (the private record path), SURFACE and DIRECTIVE_ID.
# DIRECTIVE_ID must not contain a quote or backslash. Never put a binding proof in this script, its envelope or argv; only reference the record path.
# At host start: substrate steer open --repo OWNER/REPO --surface "$SURFACE" --binding-file "$BINDING_FILE" --json
# Retain its public session_id as STEERING_SESSION_ID; open writes the proof privately to BINDING_FILE, never to stdout.
# While active: substrate steer heartbeat --session "$STEERING_SESSION_ID" --surface "$SURFACE" --binding-file "$BINDING_FILE"
# At host end: substrate steer close --session "$STEERING_SESSION_ID" --surface "$SURFACE" --binding-file "$BINDING_FILE"
# Use the same configured server URL and surface for open, heartbeat, hook and close; a lost record cannot be recovered from the historical label.
# The command runs in the foreground so the checkpoint reflects the tree as it stood when the directive was applied; it ends itself within its own timeout and is fail-open (\`|| true\`), so it never blocks the host.
printf '{"directive_id":"%s"}' "$DIRECTIVE_ID" | substrate session hook steering --session "$HISTORICAL_SESSION_ID" --steering-session "$STEERING_SESSION_ID" --binding-file "$BINDING_FILE" --surface "$SURFACE" >/dev/null 2>&1 || true
exit 0
`;

const BASELINE_TEXT = `#!/bin/sh
# Run this from the session's worktree, once when a session starts. ADR 0007 maps no Claude Code or git event to it; it names
# omp's \`session_start\` and a Swarm lane start (after the lane's worktree and branch exist) as proposals, so wire it to the matching event of your host.
# It takes the first checkpoint of a session that has none yet, so a rollback can reach back to the start; once the session has a checkpoint it does nothing.
# Set SESSION_ID (the string the surface uses for its memory writes) and SURFACE (the surface name the host's memory writes use, e.g. omp or claude-code).
# The command runs in the foreground, so the host must wait for it before the session may write any file: a background run could capture the session's first edits instead of its start state.
# It ends itself within its own timeout and is fail-open (\`|| true\`), so it never blocks the host for longer than that.
substrate session hook baseline --session "$SESSION_ID" --surface "$SURFACE" </dev/null >/dev/null 2>&1 || true
exit 0
`;

const CONTEXT_TEXT = `#!/bin/sh
# Run this from the session's worktree, when a session starts or a prompt is submitted. ADR 0007 maps no Claude Code or git event to it; wire it
# to an event of your host whose stdout the host adds to the session's context (Claude Code does this for a SessionStart or UserPromptSubmit hook).
# Set SESSION_ID (the string the surface uses for its memory writes) and SURFACE (the surface name the host's memory writes use, e.g. omp or claude-code).
# The command runs in the foreground, ends itself within its own timeout and is fail-open (\`|| true\`): when the server cannot answer it prints nothing.
# Its stdout is the digest; stderr is discarded.
substrate session hook context --session "$SESSION_ID" --surface "$SURFACE" </dev/null 2>/dev/null || true
exit 0
`;

describe("the printed text", () => {
	test("claude-code is exactly the pinned settings JSON", () => {
		expect(renderHookConfig("claude-code")).toBe(CLAUDE_CODE_TEXT);
	});

	test("git-post-commit is exactly the pinned script", () => {
		expect(renderHookConfig("git-post-commit")).toBe(GIT_POST_COMMIT_TEXT);
	});

	test("steering is exactly the pinned script", () => {
		expect(renderHookConfig("steering")).toBe(STEERING_TEXT);
	});

	test("baseline is exactly the pinned script", () => {
		expect(renderHookConfig("baseline")).toBe(BASELINE_TEXT);
	});

	test("context is exactly the pinned script", () => {
		expect(renderHookConfig("context")).toBe(CONTEXT_TEXT);
	});

	test("there are five targets, one per trigger the hook accepts, and the context script keeps stdout (it is the digest) while discarding stderr", () => {
		expect(HOOK_CONFIG_TARGETS).toHaveLength(5);
		expect(HOOK_TRIGGERS).toHaveLength(5);
		const script = renderHookConfig("context");
		expect(script).toContain(`${CONTEXT_HOOK_COMMAND} --session "$SESSION_ID" --surface "$SURFACE" </dev/null 2>/dev/null || true`);
		expect(script).not.toContain(">/dev/null 2>&1");
		expect(script).not.toContain("2>&1 &");
		expect(script.endsWith("exit 0\n")).toBe(true);
	});

	test("the steering script pipes the directive id as the envelope, runs the steering hook in the foreground with --surface, fail-open, and exits 0", () => {
		const script = renderHookConfig("steering");
		expect(script.startsWith("#!/bin/sh\n")).toBe(true);
		expect(script).toContain(`| ${STEERING_HOOK_COMMAND} --session "$HISTORICAL_SESSION_ID" --steering-session "$STEERING_SESSION_ID" --binding-file "$BINDING_FILE" --surface "$SURFACE" >/dev/null 2>&1 || true`);
		for (const lifecycle of ["open --repo", "heartbeat --session", "close --session"]) expect(script).toContain(`substrate steer ${lifecycle}`);
		expect(script).not.toContain("$SESSION_BINDING");
		expect(script).not.toContain('"session_binding"');
		expect(script).not.toContain("2>&1 &");
		expect(script).toContain(`'{"directive_id":"%s"}'`);
		expect(script.endsWith("exit 0\n")).toBe(true);
	});

	test("the baseline script runs the baseline hook in the foreground with --surface, fail-open, stdin and output discarded, and exits 0", () => {
		const script = renderHookConfig("baseline");
		expect(script.startsWith("#!/bin/sh\n")).toBe(true);
		expect(script).toContain(`${BASELINE_HOOK_COMMAND} --session "$SESSION_ID" --surface "$SURFACE" </dev/null >/dev/null 2>&1 || true`);
		expect(script).not.toContain("2>&1 &");
		expect(script.endsWith("exit 0\n")).toBe(true);
	});

	test("the targets together cover every trigger `session hook` accepts", () => {
		const printedCommand: Record<HookTrigger, string> = {
			turn: CLAUDE_CODE_HOOK_COMMAND,
			"plan-step": GIT_POST_COMMIT_HOOK_COMMAND,
			steering: STEERING_HOOK_COMMAND,
			baseline: BASELINE_HOOK_COMMAND,
			context: CONTEXT_HOOK_COMMAND,
		};
		const text = HOOK_CONFIG_TARGETS.map((target) => renderHookConfig(target)).join("\n");
		for (const trigger of HOOK_TRIGGERS) {
			expect(printedCommand[trigger]).toBe(`substrate session hook ${trigger}`);
			expect(text).toContain(printedCommand[trigger]);
		}
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
		for (const command of [CLAUDE_CODE_HOOK_COMMAND, GIT_POST_COMMIT_HOOK_COMMAND, STEERING_HOOK_COMMAND, BASELINE_HOOK_COMMAND, CONTEXT_HOOK_COMMAND]) {
			const [bin, group, ...argv] = command.split(" ");
			expect(bin).toBe("substrate");
			expect(group).toBe("session");
			expect(typeof parseSessionArgs(argv)).toBe("object");
		}
		// The script adds the plan-step reference the shell substitutes.
		expect(typeof parseSessionArgs(["hook", "plan-step", "--plan-step", "abc1234"])).toBe("object");
		expect(typeof parseSessionArgs(["hook", "steering", "--session", "HISTORY", "--steering-session", `ls_${"a".repeat(64)}`, "--binding-file", "/private/live.json", "--surface", "omp"])).toBe("object");
		expect(typeof parseSessionArgs(["hook", "baseline", "--session", "ID"])).toBe("object");
		expect(typeof parseSessionArgs(["hook", "context", "--session", "ID", "--surface", "omp"])).toBe("object");
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
		expect(r.err.join("")).toContain("hook-config takes exactly one target: claude-code, git-post-commit, steering, baseline, context");
	});
});
