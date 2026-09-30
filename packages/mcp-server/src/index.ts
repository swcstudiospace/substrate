#!/usr/bin/env bun
/**
 * substrate-mcp entry point.
 *
 * Boots the HTTP surface even when a store is unreachable: an agent that gets a
 * thin brief is better off than one whose prompt hangs waiting for Railway.
 */
import { configWarnings, loadConfig } from "./config.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

const config = loadConfig();
const substrate = new Substrate(config);

for (const warning of configWarnings(config)) {
	process.stderr.write(`[substrate] misconfigured — ${warning}\n`);
}

const migration = await substrate.migrate();
for (const problem of migration.errors) {
	process.stderr.write(`[substrate] degraded — ${problem}\n`);
}

const server = createHttpServer(substrate, config);

server.listen(config.port, config.host, () => {
	const stores = [migration.index ? "index" : null, migration.greptime ? "greptime" : null]
		.filter(Boolean)
		.join(" + ");
	process.stdout.write(
		`[substrate] listening on http://${config.host}:${config.port} ` +
			`(${stores || "no stores"}, ${config.allowAnonymous ? "anonymous" : `${config.tokens.size} tokens`})\n`,
	);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
	});
}
