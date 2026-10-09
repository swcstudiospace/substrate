#!/usr/bin/env bun
/**
 * substrate-mcp entry point.
 *
 * Boots the HTTP surface even when a store is unreachable: an agent that gets a
 * thin brief is better off than one whose prompt hangs waiting for Railway. The
 * same applies to the observability plane — a missing collector or a non-durable
 * audit chain is reported at boot and again on `/healthz`, and never a reason to
 * refuse to start.
 *
 * The one exception is a self-contradictory identity config: a token value
 * listed under two surfaces, or a `SUBSTRATE_TOKEN_*` variable naming no
 * surface, refuses boot with one names-only line on stderr and exit 78
 * (EX_CONFIG) rather than silently re-attributing a token.
 */
import { ConfigError, configWarnings, desktopConfigWarnings, loadConfig, swarmTokenWarnings } from "./config.ts";
import { bufferRunner, createDesktopDriver } from "./desktop/driver.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

let config;
try {
	config = loadConfig();
} catch (error) {
	// A contradictory identity config refuses boot: exit 78 (EX_CONFIG) so the
	// unit stops instead of crash-looping. The message names variables only —
	// a refused credential in a log is still a credential in a log.
	if (error instanceof ConfigError) {
		process.stderr.write(`[substrate] refused — ${error.message}\n`);
		process.exit(78);
	}
	throw error;
}
const observability = createObservability(config);
const substrate = new Substrate(
	config,
	{ desktop: createDesktopDriver({ run: bufferRunner, dir: config.desktopDir }) },
	observability.observer,
);

for (const problem of await observability.start()) {
	process.stderr.write(`[substrate] degraded — ${problem}\n`);
}

for (const warning of [...configWarnings(config), ...swarmTokenWarnings(config), ...desktopConfigWarnings(config)]) {
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
	const identity = config.allowAnonymous
		? config.tokens.size > 0
			? `anonymous bridge, ${config.tokens.size} tokens`
			: "anonymous"
		: `${config.tokens.size} tokens`;
	process.stdout.write(
		`[substrate] listening on http://${config.host}:${config.port} ` +
			`(${stores || "no stores"}, ${identity}, ` +
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
