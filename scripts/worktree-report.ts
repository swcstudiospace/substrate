#!/usr/bin/env bun
/**
 * The scheduled worktree report (phase 68): `substrate worktree scan --report --keep-sessions`, for a host timer.
 *
 *   bun scripts/worktree-report.ts
 *
 * It needs the same environment as the CLI: `SUBSTRATE_WORKTREE_ROOTS` (exit 2 when none is configured), `SUBSTRATE_URL`,
 * and the claude-code bearer. `SUBSTRATE_WORKTREE_REGISTRY` must be on at the server, or the report answers 503 and this
 * exits 1.
 *
 * It reports and never removes: the prune is a separate, deliberate command. `--keep-sessions` keeps the session the
 * registry already holds for each worktree that no live claim and no `--session` names, so a timer does not undo the
 * attribution a session's hook sent. If the registry cannot be read in full, nothing is posted and the run exits 1.
 *
 * Exit codes are the CLI's: 0 reported, 1 the registry listing or the report failed, 2 no root configured.
 * Nothing installs a unit: a host adds one, following infra/vps, with `ExecStart=bun scripts/worktree-report.ts`.
 */
import { hostname } from "node:os";
import { runWorktree } from "../packages/cli/src/worktree/command.ts";
import { worktreeDeps } from "../packages/cli/src/worktree/deps.ts";

if (import.meta.main) {
	process.exitCode = await runWorktree(["scan", "--report", "--keep-sessions"], worktreeDeps({
		env: process.env,
		cwd: process.cwd(),
		host: hostname(),
		out: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text),
	}));
}
