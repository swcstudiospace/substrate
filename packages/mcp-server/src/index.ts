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
import { existsSync, statSync } from "node:fs";
import {
	ConfigError,
	configWarnings,
	desktopConfigWarnings,
	hindsightConfigWarnings,
	loadConfig,
	memoryExpiryConfigWarnings,
	sloConfigWarnings,
	swarmTokenWarnings,
} from "./config.ts";
import { bufferRunner, createDesktopDriver } from "./desktop/driver.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { SloNotifier } from "./slo-notify.ts";

let config;
try {
	// The one host probe `loadConfig` takes: whether the state directory exists,
	// so an unset SUBSTRATE_SLO_CHECKPOINT lands in it on a deployed host and
	// nowhere on a bare local run (uplift-3 N2).
	config = loadConfig(process.env, { directoryExists: (path) => existsSync(path) && statSync(path).isDirectory() });
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

for (const warning of [
	...configWarnings(config),
	...swarmTokenWarnings(config),
	...desktopConfigWarnings(config),
	...memoryExpiryConfigWarnings(config),
	...hindsightConfigWarnings(config),
	...sloConfigWarnings(config),
]) {
	process.stderr.write(`[substrate] misconfigured — ${warning}\n`);
}

// uplift-3 N2: the SLO transition notifier, scheduled only under
// SUBSTRATE_SLO_NOTIFY=1. Judges the same arrays `/slo` serves, emits through
// the service like every host job, and dedupes through the checkpoint.
const notifier = new SloNotifier({
	settings: config.sloNotify,
	evaluate: () => ({
		catalogue: observability.evaluate(),
		planes: observability.evaluatePlanes(substrate.planesConfigured()),
		burn: observability.evaluateBurn(),
		capacity: observability.evaluateCapacity(),
		breakers: substrate.planes.snapshots(),
	}),
	emit: (event) => substrate.emit(event),
	records: observability.notifyRecords,
});
if (notifier.start()) {
	process.stdout.write(`[substrate] slo notifier: every ${config.sloNotify.intervalS} s, sustain ${config.sloNotify.sustainS} s, webhook ${config.sloNotify.webhookUrl === null ? "off" : "on"}\n`);
}

const migration = await substrate.migrate();
for (const problem of migration.errors) {
	process.stderr.write(`[substrate] degraded — ${problem}\n`);
}

// Mirror target availability, once: a target is on when its key is configured.
process.stdout.write(`[substrate] mirror: ${substrate.mirror?.describe() ?? "linear off, notion off"}\n`);

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
/** How long in-flight background retains may take before shutdown stops waiting for them. */
const SHUTDOWN_RETAIN_MS = 10_000;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		notifier.stop();
		observability.stop();
		server.close(async () => {
			// In-flight background retains finish first (bounded), then the retain
			// outbox gets one due pass inside the same bound: an accepted write
			// answered before its forward landed must not lose that forward
			// silently on restart (the durable outbox keeps the rest).
			await substrate.drainPendingRetains(SHUTDOWN_RETAIN_MS, { abandon: true });
			// The last export before shutdown, so the counters a restart resets are not
			// simply lost — and *awaited*, within a bound. Firing it and exiting
			// immediately lost it on an idle server, where the close callback runs at once
			// and killed the request mid-flight. The bound matters just as much: a
			// collector that hangs must not delay a systemd stop into a SIGKILL.
			// The SLO checkpoint (uplift-3 N2) is written inside the same bound: it is
			// what lets the next epoch pick the series up where this one left them.
			await Promise.race([
				Promise.all([observability.exporter?.flush().catch(() => undefined) ?? Promise.resolve(), observability.checkpoint()]),
				Bun.sleep(SHUTDOWN_FLUSH_MS),
			]);
			process.exit(0);
		});
	});
}
