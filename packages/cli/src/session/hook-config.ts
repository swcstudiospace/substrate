/**
 * `substrate session hook-config <claude-code|git-post-commit|steering|baseline|context>`: PRINTS the text an operator would
 * install so a host calls `substrate session hook` (v1.6, phase 61, success criterion 3). It writes no file, edits no
 * settings and installs nothing: installing a hook in a host is an operator step (ADR 0007).
 *
 * One target per trigger the hook accepts: `turn` (claude-code), `plan-step` (git-post-commit),
 * `steering`, `baseline` and `context`. ADR 0007 maps no host event to the last three, so their text prints the command and
 * names the event the operator must wire it to; it invents none.
 *
 * Every command in the printed text is a command that exists (`substrate session hook <trigger>`), and the
 * text is deterministic, so a test can pin it.
 */
import { HOOK_TIMEOUT_MS } from "./hook.ts";

export const HOOK_CONFIG_TARGETS = ["claude-code", "git-post-commit", "steering", "baseline", "context"] as const;
export type HookConfigTarget = (typeof HOOK_CONFIG_TARGETS)[number];

/** The command line a host runs for a trigger. `substrate` must resolve on the host's PATH. */
export const CLAUDE_CODE_HOOK_COMMAND = "substrate session hook turn";
export const GIT_POST_COMMIT_HOOK_COMMAND = "substrate session hook plan-step";
export const STEERING_HOOK_COMMAND = "substrate session hook steering";
export const BASELINE_HOOK_COMMAND = "substrate session hook baseline";
export const CONTEXT_HOOK_COMMAND = "substrate session hook context";

/** Claude Code takes a hook timeout in whole seconds; leave room above the hook's own budget so the hook ends itself first. */
export const CLAUDE_CODE_TIMEOUT_SECONDS = Math.ceil(HOOK_TIMEOUT_MS / 1000) + 5;

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
		"# Set HISTORICAL_SESSION_ID (the checkpoint/memory label), STEERING_SESSION_ID (the server-issued live handle), BINDING_FILE (the private record path), SURFACE and DIRECTIVE_ID.",
		"# DIRECTIVE_ID must not contain a quote or backslash. Never put a binding proof in this script, its envelope or argv; only reference the record path.",
		"# At host start: substrate steer open --repo OWNER/REPO --surface \"$SURFACE\" --binding-file \"$BINDING_FILE\" --json",
		"# Retain its public session_id as STEERING_SESSION_ID; open writes the proof privately to BINDING_FILE, never to stdout.",
		"# While active: substrate steer heartbeat --session \"$STEERING_SESSION_ID\" --surface \"$SURFACE\" --binding-file \"$BINDING_FILE\"",
		"# At host end: substrate steer close --session \"$STEERING_SESSION_ID\" --surface \"$SURFACE\" --binding-file \"$BINDING_FILE\"",
		"# Use the same configured server URL and surface for open, heartbeat, hook and close; a lost record cannot be recovered from the historical label.",
		"# The command runs in the foreground so the checkpoint reflects the tree as it stood when the directive was applied; it ends itself within its own timeout and is fail-open (`|| true`), so it never blocks the host.",
		`printf '{"directive_id":"%s"}' "$DIRECTIVE_ID" | ${STEERING_HOOK_COMMAND} --session "$HISTORICAL_SESSION_ID" --steering-session "$STEERING_SESSION_ID" --binding-file "$BINDING_FILE" --surface "$SURFACE" >/dev/null 2>&1 || true`,
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
		"# Set SESSION_ID (the string the surface uses for its memory writes) and SURFACE (the surface name the host's memory writes use, e.g. omp or claude-code).",
		"# The command runs in the foreground, so the host must wait for it before the session may write any file: a background run could capture the session's first edits instead of its start state.",
		"# It ends itself within its own timeout and is fail-open (`|| true`), so it never blocks the host for longer than that.",
		`${BASELINE_HOOK_COMMAND} --session "$SESSION_ID" --surface "$SURFACE" </dev/null >/dev/null 2>&1 || true`,
		"exit 0",
		"",
	].join("\n");
}

/**
 * The context hook PRINTS the live-context digest (other sessions of the repository, their claims, recent events, handoffs and
 * planning changes, each with its source and age; at most 4,000 characters), so unlike the others its stdout is kept: the host
 * injects it into the session. It prints nothing and exits 0 whenever the server cannot answer.
 */
function context(): string {
	return [
		"#!/bin/sh",
		"# Run this from the session's worktree, when a session starts or a prompt is submitted. ADR 0007 maps no Claude Code or git event to it; wire it",
		"# to an event of your host whose stdout the host adds to the session's context (Claude Code does this for a SessionStart or UserPromptSubmit hook).",
		"# Set SESSION_ID (the string the surface uses for its memory writes) and SURFACE (the surface name the host's memory writes use, e.g. omp or claude-code).",
		"# The command runs in the foreground, ends itself within its own timeout and is fail-open (`|| true`): when the server cannot answer it prints nothing.",
		"# Its stdout is the digest; stderr is discarded.",
		`${CONTEXT_HOOK_COMMAND} --session "$SESSION_ID" --surface "$SURFACE" </dev/null 2>/dev/null || true`,
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
		case "context":
			return context();
	}
}
