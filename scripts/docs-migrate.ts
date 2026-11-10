/**
 * `bun scripts/docs-migrate.ts` — thin forwarder to the runner.
 *
 * The implementation lives at packages/mcp-server/src/docs-migrate-run.ts so the
 * RAGFlow/archive client imports stay inside the MCP server package (the store
 * lock: no plane client outside it). This wrapper spawns that runner with the
 * caller's stdio and env, the same shape `substrate ledger archive` uses for
 * ledger-run/index-run.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const runner = join(import.meta.dir, "..", "packages", "mcp-server", "src", "docs-migrate-run.ts");
const result = spawnSync(process.execPath, [runner, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
