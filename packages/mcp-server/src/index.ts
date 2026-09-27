#!/usr/bin/env bun
/**
 * substrate-mcp entry point.
 *
 * Boots the HTTP surface even when a store is unreachable: an agent that gets a
 * thin brief is better off than one whose prompt hangs waiting for Railway.
 */
import { loadConfig } from "./config.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

const config = loadConfig();
const substrate = new Substrate(config);

const migration = await substrate.migrate();
for (const problem of migration.errors) {
	process.stderr.write(`[substrate] degraded — ${problem}\n`);
}

// After migrate: the head of the global ingest chain. An unknown head is retried by the first emit.
const head = await substrate.seedChain();
if (head.startsWith("unknown")) process.stderr.write(`[substrate] degraded — chain head ${head}\n`);
else process.stdout.write(`[substrate] chain head ${head}\n`);

const server = createHttpServer(substrate, config);

server.listen(config.port, config.host, () => {
	const stores = [migration.index ? "index" : null, migration.greptime ? "greptime" : null]
		.filter(Boolean)
		.join(" + ");
	process.stdout.write(
		`[substrate] listening on http://${config.host}:${config.port} ` +
			`(${stores || "no stores"}, ${config.allowAnonymous ? "anonymous" : `${config.tokens.size} tokens`})\n`,
	);
	process.stdout.write(`[substrate] mirror: ${substrate.mirror.describe()}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
	});
}
