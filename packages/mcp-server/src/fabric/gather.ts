/**
 * The fabric's one I/O step (phase 51, SOTA-07): reads the sources and folds them into the facts the pure
 * builders take.
 *
 * Every source read runs under a deadline. `health()` bounds each of its own probes, so a slow plane answers
 * `unavailable` for itself while the others keep their answers; the deadline here is a backstop for the whole call. A
 * source that misses it, or throws, leaves its resources with no answer, which reports as `unavailable` and names the
 * reason in the row's fixed `source` phrase. The call always returns the facts, and nothing throws to the caller.
 */
import {
	type BreakerReading,
	type FabricCostView,
	type FabricFacts,
	type FabricHealthView,
	type FabricSources,
	type ServiceName,
	type ServiceReading,
} from "./types.ts";

/** The per-source deadline for each read the fabric makes, in ms. */
export const FABRIC_SOURCE_DEADLINE_MS = 1500;

/** How long one health computation is shared by the fabric's calls and `/healthz`, in ms (phase 51, D51-b). */
export const FABRIC_HEALTH_WINDOW_MS = 2_000;

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: "deadline" | "failed" };

/** `work`'s answer, or why there is none: it outlasted `ms`, or it threw. Never rejects. */
async function within<T>(work: () => Promise<T>, ms: number): Promise<Read<T>> {
	const { promise: deadline, resolve: expire } = Promise.withResolvers<Read<T>>();
	const timer = setTimeout(() => expire({ ok: false, reason: "deadline" }), ms);
	const answer = Promise.resolve()
		.then(work)
		.then<Read<T>, Read<T>>(
			(value) => ({ ok: true, value }),
			() => ({ ok: false, reason: "failed" }),
		);
	try {
		return await Promise.race([answer, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** The source phrase for a health-backed row: the path read, or why it was not read. */
function healthSource(path: string, read: Read<FabricHealthView>): string {
	if (read.ok) return `health().${path}`;
	return read.reason === "deadline" ? "health(): no answer in time" : "health(): read failed";
}

function breakerOf(snapshot: { readonly state: "closed" | "open" | "half-open" } | null | undefined): BreakerReading {
	return snapshot ? snapshot.state : "off";
}

/** Reads the sources, under the deadline, and returns the facts. Never throws. */
export async function gatherFabricFacts(
	sources: FabricSources,
	options: { readonly deadlineMs?: number } = {},
): Promise<FabricFacts> {
	const deadlineMs = options.deadlineMs ?? FABRIC_SOURCE_DEADLINE_MS;
	const checkedAt = sources.now();
	const [healthRead, costRead] = await Promise.all([
		within(() => sources.health(), deadlineMs),
		within<FabricCostView>(() => sources.railwayCost(), deadlineMs),
	]);
	const health = healthRead.ok ? healthRead.value : null;
	const config = sources.config;
	const outbox = sources.outbox();

	const services: Record<ServiceName, ServiceReading> = {
		dragonfly: {
			configured: config.configured.dragonfly,
			held: config.configured.dragonfly && (config.dragonflyRefused || (health !== null && !health.cache.enabled)),
			answered: health === null ? null : health.cache.connected,
			breaker: health === null ? "off" : breakerOf(health.planes.cache.breaker),
			degraded: health !== null && health.cache.mode === "degraded",
			source: healthSource("cache", healthRead),
		},
		"timescaledb-index": {
			configured: config.configured["timescaledb-index"],
			held: false,
			answered: health === null ? null : health.index,
			breaker: health === null ? "off" : breakerOf(health.planes.index.breaker),
			degraded: false,
			source: healthSource("index", healthRead),
		},
		greptime: {
			configured: config.configured.greptime,
			held: false,
			answered: health === null ? null : health.greptime,
			breaker: health === null ? "off" : breakerOf(health.planes.greptime.breaker),
			degraded: health !== null && health.greptime && !health.eventsWritable,
			source: healthSource("greptime", healthRead),
		},
		ragflow: {
			configured: config.configured.ragflow,
			held: false,
			answered: health === null ? null : health.planes.ragflow.ok,
			breaker: health === null ? "off" : breakerOf(health.planes.ragflow.breaker),
			degraded: false,
			source: healthSource("planes.ragflow", healthRead),
		},
		hindsight: {
			configured: config.configured.hindsight,
			held: false,
			answered: health === null ? null : health.planes.hindsight.ok,
			breaker: health === null ? "off" : breakerOf(health.planes.hindsight.breaker),
			degraded: outbox.size > 0,
			source: healthSource("planes.hindsight", healthRead),
		},
	};

	const railway: FabricFacts["railway"] = costRead.ok
		? { status: costRead.value.status, projectedMonthlyUsd: costRead.value.projectedMonthlyUsd, budgetUsd: costRead.value.budgetUsd }
		: { status: "unknown", projectedMonthlyUsd: null, budgetUsd: null };

	const cache =
		health === null
			? null
			: {
					mode: health.cache.mode,
					hits: health.cache.hits,
					misses: health.cache.misses,
					errors: health.cache.errors,
					bypasses: health.cache.bypasses,
				};

	return {
		checkedAt,
		endpointPolicy: config.endpointPolicy,
		endpoints: { ...config.endpointClasses },
		services,
		cache,
		eventBusEnabled: health === null ? null : health.eventBus.enabled,
		outbox: { parked: outbox.size, oldestAt: outbox.oldestAt },
		railway,
	};
}
