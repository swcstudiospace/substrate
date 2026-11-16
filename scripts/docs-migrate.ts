#!/usr/bin/env bun
/**
 * Docs migration CLI. LightRAG is the backend; the job lives in `packages/mcp-server/src/docs-migrate.ts`.
 * Usage and exit codes are documented there. This file only runs it.
 *
 */
import { main } from "../packages/mcp-server/src/docs-migrate.ts";

process.exit(await main(Bun.argv.slice(2)));
