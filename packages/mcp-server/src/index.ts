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
import { gatedFetch } from "@substrate/observability";
import {
	ConfigError,
	configWarnings,
	contextualRecallConfigWarnings,
	desktopConfigWarnings,
	eventIdempotencyConfigWarnings,
	hashVersionConfigWarnings,
	memoryLifecycleConfigWarnings,
	hindsightConfigWarnings,
	loadConfig,
	memoryExpiryConfigWarnings,
	requestPathConfigWarnings,
	skillsGovernanceConfigWarnings,
	sloConfigWarnings,
	swarmTokenWarnings,
} from "./config.ts";
import type { SubstrateConfig } from "./config.ts";
import { briefProfileConfigWarnings } from "./brief-profile.ts";
import { planningConfigWarnings } from "./planning/config.ts";
import { hindsightInventoryConfigWarnings } from "./hindsight-inventory.ts";
import { briefRecallConfigWarnings } from "./recall-snapshot.ts";
import { bufferRunner, createDesktopDriver } from "./desktop/driver.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { SloNotifier } from "./slo-notify.ts";
import { DROPPED_METRIC, MetricsHistorySampler } from "./metrics-history.ts";
import { DocsLagTimer } from "./docs-lag-timer.ts";
import { createWatchdog, livezUrlFor } from "./watchdog.ts";
import { MentalModelRefresh } from "./mental-model-refresh.ts";
import { hindsightFromEnv, hindsightOp } from "./planes/hindsight.ts";

let config: SubstrateConfig;
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
substrate.startPlanningPoll();

for (const problem of await observability.start()) {
	process.stderr.write(`[substrate] degraded — ${problem}\n`);
}

for (const warning of [
	...configWarnings(config),
	...swarmTokenWarnings(config),
	...desktopConfigWarnings(config),
	...memoryExpiryConfigWarnings(config),
	...hashVersionConfigWarnings(config),
	...memoryLifecycleConfigWarnings(config),
	...skillsGovernanceConfigWarnings(config),
	...hindsightConfigWarnings(config),
	...sloConfigWarnings(config),
	...briefProfileConfigWarnings(config),
	...config.metricsHistory.problems,
	...briefRecallConfigWarnings(config),
	...hindsightInventoryConfigWarnings(config),
	...requestPathConfigWarnings(config),
	...contextualRecallConfigWarnings(config),
	...eventIdempotencyConfigWarnings(config),
	...config.mentalModels.warnings,
	...planningConfigWarnings(config.planning),
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

// Phase 58 (live steering): restore the durable inbox before the server answers, then start its expiry timer (unref'd).
// Off, with nothing read, unless SUBSTRATE_PLANNING_STEERING and the audit table opt-in are both on; a failed read is
// reported and the inbox starts empty, so it never refuses boot.
await substrate.startSteering();

// uplift-4 S6: the durable metrics history, only under SUBSTRATE_METRICS_HISTORY=on.
// Samples the registry into `metric_samples` through the ledger client; fail-open,
// a failed write is a counted drop. Needs the ledger, so without one it stays off.
const metricsHistory = new MetricsHistorySampler({
	settings: { enabled: config.metricsHistory.enabled, intervalS: config.metricsHistory.intervalS, series: config.metricsHistory.series },
	snapshot: () => observability.snapshot(),
	runwayDays: () => observability.evaluateCapacity()[0]?.observed ?? null,
	beforeSample: () => substrate.refreshCorpusReadings(),
	record: async (rows) =>
		substrate.greptime === null
			? { stored: 0, drops: { unavailable: rows.length } }
			: await substrate.greptime.recordMetricSamples(rows, config.metricsHistory.ttl),
	onDrop: (reason, rows) => observability.instruments.registry.counter(DROPPED_METRIC).add(rows, { reason }),
});
if (metricsHistory.start()) {
	const seriesNote = config.metricsHistory.series === "extended" ? ", extended series" : "";
	process.stdout.write(`[substrate] metrics history: every ${config.metricsHistory.intervalS} s, ttl ${config.metricsHistory.ttl}${seriesNote}\n`);
}

// uplift-4 S7: the docs merge-trigger lag warning is settled here, on an unref'd
// timer, so `/slo` and `/metrics` only read the verdicts. With
// SUBSTRATE_DOCS_TRIGGER_LAG_MIN=0 a pass finds nothing owed and does nothing.
const docsLagTimer = new DocsLagTimer({
	settle: () => substrate.settleDocsLag(),
	idle: () => substrate.docsLagIdle(),
	intervalS: config.docsFreshness.lagCheckS,
});
if (docsLagTimer.start()) {
	process.stdout.write(`[substrate] docs lag check: every ${config.docsFreshness.lagCheckS} s\n`);
}

// Mirror target availability, once: a target is on when its key is configured.
process.stdout.write(`[substrate] mirror: ${substrate.mirror?.describe() ?? "linear off, notion off"}\n`);

const server = createHttpServer(substrate, config, observability);
// uplift-4 S3: the systemd watchdog. A no-op unless SUBSTRATE_WATCHDOG=1 and
// systemd gave this process a NOTIFY_SOCKET (Type=notify); `start()` below is
// where READY=1 goes out, once the server listens.
const { watchdog } = createWatchdog(process.env, livezUrlFor(config.host, config.port), (line) => process.stderr.write(line));

// Memory governance: the weekly mental-model refresh is built inside the listen callback, after startRecall.
// Until then it is null, so a signal that arrives first has nothing to stop.
let mentalModelRefresh: MentalModelRefresh | null = null;

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
	if (watchdog.start()) process.stdout.write("[substrate] watchdog: armed, READY=1 first, then heartbeat gated on event-loop lag and loopback /livez\n");
	// D48-d: one `db.endpoint` note per configured data plane, recorded once at boot. A refused write never blocks boot.
	void substrate.emitDbEndpoints();
	// uplift-4 S5: each timer starts only under its own flag (both default off) and is unref'd.
	const background = substrate.startRecall();
	// Phase 52: the planning observer's scan timer. Off while SUBSTRATE_PLANNING_ROOT is unset; unref'd.
	substrate.startPlanning();
	if (background.recall) process.stdout.write(`[substrate] brief recall: ${config.briefRecall.mode}, refresh every ${config.briefRecall.intervalS} s, snapshot ttl ${config.briefRecall.ttlS} s\n`);
	if (background.inventory) process.stdout.write(`[substrate] hindsight inventory: on, every ${config.hindsightInventory.intervalS} s, read-only\n`);
	// Memory governance: the weekly mental-model refresh, named by HINDSIGHT_MENTAL_MODELS. Unref'd; the first pass
	// is seven days after start. No model named means no timer.
	mentalModelRefresh = new MentalModelRefresh({
		models: config.mentalModels.models,
		hindsight: () => (config.vmGuest ? null : hindsightFromEnv()),
		fetchImpl: gatedFetch(substrate.planes.gate("hindsight"), fetch, hindsightOp),
		emit: (event) => substrate.emit(event),
	});
	if (mentalModelRefresh.start()) process.stdout.write(`[substrate] mental-model refresh: ${config.mentalModels.models.length} model(s), every 7 days\n`);
});

/** How long the final OTLP export may take before shutdown stops waiting for it. */
const SHUTDOWN_FLUSH_MS = 2000;
/** How long in-flight background retains may take before shutdown stops waiting for them. */
const SHUTDOWN_RETAIN_MS = 10_000;
/** How long in-flight planning transition records may take before shutdown stops waiting for them. */
const SHUTDOWN_TRANSITION_MS = 5000;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		notifier.stop();
		metricsHistory.stop();
		// Before the flush below: no new lag pass starts once shutdown began.
		docsLagTimer.stop();
		substrate.stopPlanningPoll();
		// The weekly refresh timer is cleared with the others; a pass in flight is awaited in the bound below.
		mentalModelRefresh?.stop();
		// Cancelled first and awaited with the flush below: no ping after shutdown began,
		// and a stuck systemd-notify child is killed rather than outliving the process.
		const watchdogStopped = watchdog.stop();
		// uplift-4 S5: the recall prefetch and Hindsight inventory timers are cleared now and
		// their in-flight work is awaited inside the same bound as the flush below.
		const recallStopped = substrate.stopRecall();
		// Phase 47: the cache preloader's timer is cleared with them; a tick in flight finishes on its own.
		substrate.stopPreload();
		// Phase 52: the planning observer's timer is cleared now; a scan in flight is awaited inside the bound below.
		const planningStopped = substrate.stopPlanning();
		// Phase 58: the steering expiry timer is cleared with them; a pass in flight is awaited inside the same bound.
		const steeringStopped = substrate.stopSteering();
		// Phase 50: the wake-up hint connections close with the timers; no subscriber outlives the shutdown.
		substrate.stopEventBus();
		observability.stop();
		server.close(async () => {
			// In-flight background retains finish first (bounded), then the retain
			// outbox gets one due pass inside the same bound: an accepted write
			// answered before its forward landed must not lose that forward
			// silently on restart (the durable outbox keeps the rest).
			await substrate.drainPendingRetains(SHUTDOWN_RETAIN_MS, { abandon: true });
			// Planning transition records in flight are awaited within their own bound, after the retains and before the flush below.
			await substrate.planningObserver.settleTransitions(Bun.sleep(SHUTDOWN_TRANSITION_MS));
			// The last export before shutdown, so the counters a restart resets are not
			// simply lost — and *awaited*, within a bound. Firing it and exiting
			// immediately lost it on an idle server, where the close callback runs at once
			// and killed the request mid-flight. The bound matters just as much: a
			// collector that hangs must not delay a systemd stop into a SIGKILL.
			// The SLO checkpoint (uplift-3 N2) is written inside the same bound: it is
			// what lets the next epoch pick the series up where this one left them.
			await Promise.race([
				Promise.all([
					observability.exporter?.flush().catch(() => undefined) ?? Promise.resolve(),
					observability.flush(),
					metricsHistory.flush(),
					docsLagTimer.flush(),
					substrate.planningRefreshIdle(),
					mentalModelRefresh?.flush(),
					watchdogStopped,
					recallStopped,
					planningStopped,
					steeringStopped,
				]),
				Bun.sleep(SHUTDOWN_FLUSH_MS),
			]);
			process.exit(0);
		});
	});
}
