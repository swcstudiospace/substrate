#!/usr/bin/env bun
/**
 * Cross-layer reconcile (`bun run reconcile -- report|plan|repair`), Phase 78 D78-8. This file is a thin wrapper: the
 * subcommands, the store clients and the exit codes live in `packages/mcp-server/src/reconcile-main.ts`, which is the only
 * place this feature builds a ledger or index client (the store lock). See `docs/reconcile.md`.
 */
import { reconcileMain } from "../packages/mcp-server/src/reconcile-main.ts";

const code = await reconcileMain(process.argv.slice(2), {
	out: (line) => console.log(line),
	err: (line) => console.error(line),
});
// The cache client has no close, so exit explicitly once the output is written. On Linux a pipe is synchronous, so nothing is cut off.
process.exit(code);
