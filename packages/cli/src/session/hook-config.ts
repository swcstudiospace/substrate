/**
 * `substrate session hook-config <claude-code|git-post-commit>`: PRINTS the text an operator would install so
 * a host calls `substrate session hook` (v1.6, phase 61, success criterion 3). It writes no file, edits no
 * settings and installs nothing: installing a hook in a host is an operator step (ADR 0007).
 *
 * Every command in the printed text is a command that exists (`substrate session hook <trigger>`), and the
 * text is deterministic, so a test can pin it.
 */
import { HOOK_TIMEOUT_MS } from "./hook.ts";

export const HOOK_CONFIG_TARGETS = ["claude-code", "git-post-commit"] as const;
export type HookConfigTarget = (typeof HOOK_CONFIG_TARGETS)[number];

/** The command line a host runs for a trigger. `substrate` must resolve on the host's PATH. */
export const CLAUDE_CODE_HOOK_COMMAND = "substrate session hook turn";
export const GIT_POST_COMMIT_HOOK_COMMAND = "substrate session hook plan-step";

/** Claude Code takes a hook timeout in whole seconds; leave room above the hook's own budget so the hook ends itself first. */
const CLAUDE_CODE_TIMEOUT_SECONDS = Math.ceil(HOOK_TIMEOUT_MS / 1000) + 5;

/** Claude Code settings JSON, and nothing else, so it can be pasted or merged as is. */
function claudeCode(): string {
	const settings = {
		hooks: {
			Stop: [{ hooks: [{ type: "command", command: CLAUDE_CODE_HOOK_COMMAND, timeout: CLAUDE_CODE_TIMEOUT_SECONDS }] }],
		},
	};
	return `${JSON.stringify(settings, null, 2)}\n`;
}

function gitPostCommit(): string {
	return [
		"#!/bin/sh",
		"# Save as .git/hooks/post-commit and make it executable (or append the command line to an existing post-commit, before any exit).",
		"# After each commit it takes a plan-step checkpoint of the worktree, at most one every ten seconds.",
		"# There is no Claude Code envelope on stdin: the session is the one that already has checkpoints in this worktree",
		"# (add `--session ID` to name it). The command is fail-open and runs in the background, so the commit never waits.",
		`${GIT_POST_COMMIT_HOOK_COMMAND} --plan-step "$(git rev-parse --short HEAD)" </dev/null >/dev/null 2>&1 &`,
		"exit 0",
		"",
	].join("\n");
}

/** The exact text to install for `target`. */
export function renderHookConfig(target: HookConfigTarget): string {
	return target === "claude-code" ? claudeCode() : gitPostCommit();
}
