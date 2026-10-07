#!/usr/bin/env bun
/**
 * substrate-mcp entry point.
 *
 * Boots the HTTP surface even when a store is unreachable: an agent that gets a
 * thin brief is better off than one whose prompt hangs waiting for Railway. The
 * same applies to the observability plane — a missing collector or a non-durable
 * audit chain is reported at boot and again on `/healthz`, and never a reason to
 * refuse to start.
 */
import { configWarnings, loadConfig, swarmTokenWarnings } from "./config.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

const config = loadConfig();
const observability = createObservability(config);
const substrate = new Substrate(config, undefined, observability.observer);

for (const problem of await observability.start()) {
	process.stderr.write(`[substrate] degraded — ${problem}\n`);
}

for (const warning of [...configWarnings(config), ...swarmTokenWarnings(config)]) {
	process.stderr.write(`[substrate] misconfigured — ${warning}\n`);
}

const migration = await substrate.migrate();
for (const problem of migration.errors) {
	process.stderr.write(`[substrate] degraded — ${problem}\n`);
}

const server = createHttpServer(substrate, config, observability);

server.listen(config.port, config.host, () => {
	const stores = [migration.index ? "index" : null, migration.greptime ? "greptime" : null]
		.filter(Boolean)
		.join(" + ");
	process.stdout.write(
		`[substrate] listening on http://${config.host}:${config.port} ` +
			`(${stores || "no stores"}, ${config.allowAnonymous ? "anonymous" : `${config.tokens.size} tokens`}, ` +
			`audit ${observability.audit.durable ? observability.audit.path : "in memory"}, ` +
			`claims ${substrate.requireRecordedClaims ? "fail-closed" : "fail-open"})\n`,
	);
});

/** How long the final OTLP export may take before shutdown stops waiting for it. */
const SHUTDOWN_FLUSH_MS = 2000;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		observability.stop();
		server.close(async () => {
			// The last export before shutdown, so the counters a restart resets are not
			// simply lost — and *awaited*, within a bound. Firing it and exiting
			// immediately lost it on an idle server, where the close callback runs at once
			// and killed the request mid-flight. The bound matters just as much: a
			// collector that hangs must not delay a systemd stop into a SIGKILL.
			await Promise.race([
				observability.exporter?.flush().catch(() => undefined) ?? Promise.resolve(),
				Bun.sleep(SHUTDOWN_FLUSH_MS),
			]);
			process.exit(0);
		});
	});
}
