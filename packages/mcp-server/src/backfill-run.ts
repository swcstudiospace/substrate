#!/usr/bin/env bun
/**
 * Load Notion Agent Task Graph rows into the index.
 *
 *   bun packages/mcp-server/src/backfill-run.ts rows.json
 *   cat rows.json | bun packages/mcp-server/src/backfill-run.ts -
 *
 * `rows.json` is a JSON array of Agent Task Graph rows with their native column
 * names. Produce it however you like — the Notion API, the MCP connector, or an
 * export. The mapping in backfill.ts is the part that matters and is tested
 * against real rows; this is just the loader.
 *
 * Idempotent: graph_register upserts by Graph ID, so re-running refreshes
 * rather than duplicating.
 */
import { loadConfig } from "./config.ts";
import { mapNotionRows, type NotionRow } from "./backfill.ts";
import { Substrate } from "./service.ts";

const source = process.argv[2];
if (!source) {
	process.stderr.write("usage: backfill-run.ts <rows.json|->\n");
	process.exit(2);
}

const raw = source === "-" ? await new Response(Bun.stdin.stream()).text() : await Bun.file(source).text();

let rows: NotionRow[];
try {
	const parsed: unknown = JSON.parse(raw);
	// Accept either a bare array or the `{ results: [...] }` envelope a query returns.
	rows = Array.isArray(parsed) ? parsed : ((parsed as { results?: NotionRow[] }).results ?? []);
} catch (cause) {
	process.stderr.write(`could not parse ${source}: ${String(cause)}\n`);
	process.exit(1);
}

const plans = mapNotionRows(rows);
if (plans.length === 0) {
	process.stdout.write("no rows with a Graph ID; nothing to do\n");
	process.exit(0);
}

// A job process never opens the server's telemetry buffer file: the server owns it (see reanchor-run.ts).
const substrate = new Substrate({ ...loadConfig(), eventBuffer: null });
if (!substrate.index) {
	process.stderr.write("SUBSTRATE_PG_URL is not set; nowhere to write the index\n");
	process.exit(1);
}
await substrate.index.migrate();

let ok = 0;
let failed = 0;
for (const plan of plans) {
	try {
		await substrate.registerGraph(plan);
		process.stdout.write(
			`✓ ${plan.graph_id} — ${plan.nodes.length} nodes, ${plan.steps.length} steps` +
				`${plan.repo ? ` (${plan.repo})` : plan.notion_task_page ? " (task row has no repo)" : " (no task row in this batch)"}\n`,
		);
		ok++;
	} catch (cause) {
		process.stdout.write(`✗ ${plan.graph_id} — ${String(cause)}\n`);
		failed++;
	}
}

process.stdout.write(`\n${ok} graph(s) indexed, ${failed} failed\n`);
await substrate.index.close();
process.exit(failed > 0 ? 1 : 0);
