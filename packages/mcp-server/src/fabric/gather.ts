/**
 * The fabric's one I/O step (phase 51, SOTA-07): reads the sources and folds them into the facts the pure
 * builders take.
 *
 * Every plane is awaited under its own deadline. A plane that answers keeps its real state. A plane that misses the
 * deadline, or throws, reads as `unavailable` for itself alone, and its row names the reason (`timeout` or `failed`)
 * in the fixed `source` phrase. The synchronous counters and breaker states need no wait. The call always returns
 * the facts, and nothing throws to the caller.
 */
import type { BreakerReading, CorpusSourceReading, FabricCostView, FabricFacts, FabricSources, ServiceName, ServiceReading } from "./types.ts";

/** The per-plane deadline for each read the fabric makes, in ms. */
export const FABRIC_SOURCE_DEADLINE_MS = 1500;

/** How long one health computation is shared by the fabric's calls, in ms (phase 51, D51-b). */
export const FABRIC_HEALTH_WINDOW_MS = 2_000;

/**
 * The bound on the corpus manifest read behind the docs SLO readings, in ms. Shorter than {@link FABRIC_SOURCE_DEADLINE_MS} on
 * purpose: a read that outlasts it is reported to the fabric as `timeout` while the fabric is still waiting, so the fabric never
 * takes a late answer for a fresh one.
 */
export const CORPUS_MANIFEST_READ_MS = 1000;

export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: "timeout" | "failed" };

/** `work`'s answer, or why there is none: it outlasted `ms` (timeout), or it threw (failed). Never rejects. */
export async function within<T>(work: () => Promise<T>, ms: number): Promise<Read<T>> {
	const { promise: deadline, resolve: expire } = Promise.withResolvers<Read<T>>();
	const timer = setTimeout(() => expire({ ok: false, reason: "timeout" }), ms);
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

/** The source phrase for one plane: the path read, with the reason it was not read when it was not. */
function sourceOf(path: string, read: Read<unknown>): string {
	return read.ok ? `health().${path}` : `health().${path}: ${read.reason}`;
}

function breakerOf(snapshot: { readonly state: "closed" | "open" | "half-open" } | null): BreakerReading {
	return snapshot ? snapshot.state : "off";
}

/** Reads the sources, each plane under its own deadline, and returns the facts. Never throws. */
export async function gatherFabricFacts(
	sources: FabricSources,
	options: { readonly deadlineMs?: number } = {},
): Promise<FabricFacts> {
	const deadlineMs = options.deadlineMs ?? FABRIC_SOURCE_DEADLINE_MS;
	const checkedAt = sources.now();
	const parts = sources.health();
	const [greptimeRead, indexRead, hindsightRead, lightragRead, teiRead, costRead, corpusRead] = await Promise.all([
		within(() => parts.greptime, deadlineMs),
		within(() => parts.index, deadlineMs),
		within(() => parts.hindsight, deadlineMs),
		within(() => parts.lightrag, deadlineMs),
		within(() => parts.tei, deadlineMs),
		within<FabricCostView>(() => sources.railwayCost(), deadlineMs),
		// A server with the corpus off has no readings and is not asked.
		sources.config.corpusEnabled ? within<CorpusSourceReading>(() => sources.corpus(), deadlineMs) : Promise.resolve(null),
	]);
	const snapshot = sources.snapshot();
	const config = sources.config;
	const outbox = sources.outbox();
	const { cache, breakers } = snapshot;
	const greptime = greptimeRead.ok ? greptimeRead.value : null;
	// A write still waiting at its bound is not a write that succeeded: the Greptime row is unavailable for it, never ok.
	const writeStalled = greptime?.writeTimedOut === true;
	// No write verdict since boot: the fabric reads the last /healthz probe and never writes, so the write is unknown, and unknown is never ok.
	const writeUnread = greptime?.up === true && greptime.writeUnread;

	const services: Record<ServiceName, ServiceReading> = {
		dragonfly: {
			configured: config.configured.dragonfly,
			held: config.configured.dragonfly && (config.dragonflyRefused || !cache.enabled),
			answered: cache.connected,
			breaker: breakerOf(breakers.cache),
			degraded: cache.mode === "degraded",
			source: "health().cache",
		},
		"timescaledb-index": {
			configured: config.configured["timescaledb-index"],
			held: false,
			answered: indexRead.ok ? indexRead.value : null,
			breaker: breakerOf(breakers.index),
			degraded: false,
			source: sourceOf("index", indexRead),
		},
		greptime: {
			configured: config.configured.greptime,
			held: false,
			answered: greptime === null || writeStalled || writeUnread ? null : greptime.up,
			breaker: breakerOf(breakers.greptime),
			degraded: greptime !== null && !writeStalled && greptime.up && !greptime.eventsWritable,
			source: writeStalled ? "health().greptime: timeout" : writeUnread ? "health().greptime: no write reading" : sourceOf("greptime", greptimeRead),
		},
		lightrag: {
			configured: config.configured.lightrag,
			held: false,
			answered: lightragRead.ok ? lightragRead.value : null,
			breaker: breakerOf(breakers.lightrag),
			degraded: false,
			source: sourceOf("planes.lightrag", lightragRead),
		},
		hindsight: {
			configured: config.configured.hindsight,
			held: false,
			answered: hindsightRead.ok ? hindsightRead.value : null,
			breaker: breakerOf(breakers.hindsight),
			degraded: outbox.size > 0,
			source: sourceOf("planes.hindsight", hindsightRead),
		},
		tei: {
			configured: config.configured.tei,
			held: false,
			answered: teiRead.ok ? teiRead.value : null,
			breaker: breakerOf(breakers.tei),
			degraded: false,
			source: teiRead.ok ? "probe().tei" : `probe().tei: ${teiRead.reason}`,
		},
	};

	const railway: FabricFacts["railway"] = costRead.ok
		? { status: costRead.value.status, projectedMonthlyUsd: costRead.value.projectedMonthlyUsd, budgetUsd: costRead.value.budgetUsd }
		: { status: "unknown", projectedMonthlyUsd: null, budgetUsd: null };

	return {
		checkedAt,
		endpointPolicy: config.endpointPolicy,
		endpoints: { ...config.endpointClasses },
		services,
		tei: { endpointClass: config.teiEndpoint, ...snapshot.tei },
		cache: {
			mode: cache.mode,
			hits: cache.hits,
			misses: cache.misses,
			errors: cache.errors,
			bypasses: cache.bypasses,
		},
		eventBusEnabled: snapshot.eventBus.enabled,
		outbox: { parked: outbox.size, oldestAt: outbox.oldestAt },
		railway,
		corpus: {
			enabled: config.corpusEnabled,
			readings: corpusRead?.ok ? corpusRead.value.readings : { freshnessS: null, recall5: null, ingestDocsPerS: null },
			thresholds: { ...config.docsSlo },
			// A read the source itself reports as failed is as unread as one that missed this deadline.
			unread: corpusRead === null ? null : corpusRead.ok ? corpusRead.value.unread : corpusRead.reason,
		},
	};
}
