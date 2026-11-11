#!/usr/bin/env bun
/**
 * The RAGFlow → LightRAG migration job's CLI entry. The job lives in `packages/mcp-server/src/docs-migrate.ts`, inside the
 * MCP server, so the RAGFlow isolation lock holds: nothing outside that package imports the ingest, archive or RAGFlow
 * modules. Usage and exit codes are documented there. This file only runs it.
 */
import { main } from "../packages/mcp-server/src/docs-migrate.ts";

process.exit(await main(Bun.argv.slice(2)));
