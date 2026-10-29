/**
 * `substrate session hook-config <claude-code|git-post-commit|steering|baseline>`: PRINTS the text an operator would
 * install so a host calls `substrate session hook` (v1.6, phase 61, success criterion 3). It writes no file, edits no
 * settings and installs nothing: installing a hook in a host is an operator step (ADR 0007).
 *
 * One target per checkpoint trigger the hook accepts: `turn` (claude-code), `plan-step` (git-post-commit),
 * `steering` and `baseline`. ADR 0007 maps no host event to the last two, so their text prints the command and
 * names the event the operator must wire it to; it invents none.
 *
 * Every command in the printed text is a command that exists (`substrate session hook <trigger>`), and the
 * text is deterministic, so a test can pin it.
 */
import { HOOK_TIMEOUT_MS } from "./hook.ts";

export const HOOK_CONFIG_TARGETS = ["claude-code", "git-post-commit", "steering", "baseline"] as const;
export type HookConfigTarget = (typeof HOOK_CONFIG_TARGETS)[number];

/** The command line a host runs for a trigger. `substrate` must resolve on the host's PATH. */
export const CLAUDE_CODE_HOOK_COMMAND = "substrate session hook turn";
export const GIT_POST_COMMIT_HOOK_COMMAND = "substrate session hook plan-step";
export const STEERING_HOOK_COMMAND = "substrate session hook steering";
export const BASELINE_HOOK_COMMAND = "substrate session hook baseline";

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

/**
 * The steering hook is run by the session itself, from its own worktree, after it applied a directive: the
 * `steering_acknowledge` reply carries `checkpoint_hint: { trigger: "steering", directive_id }` when a pause or
 * redirect moved the session (ADR 0007). The directive id is only read from the stdin envelope, so it is piped in.
 */
function steering(): string {
	return [
		"#!/bin/sh",
		"# Run this from the session's worktree, by the host that applies a steering directive. ADR 0007 maps no Claude Code or git event to it:",
		"# wire it to the place your host handles the `checkpoint_hint` of a `steering_acknowledge` reply, which carries the directive_id.",
		"# After a directive it takes a steering checkpoint, once per directive id; it is skipped when the tree is unchanged.",
		"# Set SESSION_ID (the string the surface uses for its memory writes) and DIRECTIVE_ID; neither may contain a quote or a backslash.",
		"# The command is fail-open and runs in the background, so the host never waits.",
		`printf '{"directive_id":"%s"}' "$DIRECTIVE_ID" | ${STEERING_HOOK_COMMAND} --session "$SESSION_ID" >/dev/null 2>&1 &`,
		"exit 0",
		"",
	].join("\n");
}

/** The baseline hook has no envelope field of its own: the session id comes from a flag and stdin is empty. */
function baseline(): string {
	return [
		"#!/bin/sh",
		"# Run this from the session's worktree, once when a session starts. ADR 0007 maps no Claude Code or git event to it; it names",
		"# omp's `session_start` and a Swarm lane start (after the lane's worktree and branch exist) as proposals, so wire it to the matching event of your host.",
		"# It takes the first checkpoint of a session that has none yet, so a rollback can reach back to the start; once the session has a checkpoint it does nothing.",
		"# Set SESSION_ID to the string the surface uses for its memory writes. The command is fail-open and runs in the background.",
		`${BASELINE_HOOK_COMMAND} --session "$SESSION_ID" </dev/null >/dev/null 2>&1 &`,
		"exit 0",
		"",
	].join("\n");
}

/** The exact text to install for `target`. */
export function renderHookConfig(target: HookConfigTarget): string {
	switch (target) {
		case "claude-code":
			return claudeCode();
		case "git-post-commit":
			return gitPostCommit();
		case "steering":
			return steering();
		case "baseline":
			return baseline();
	}
}
