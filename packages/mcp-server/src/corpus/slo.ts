/**
 * The corpus atlas's three readings (v1.7 phase 70), kept in the one place the gauges and the `fabric_status` row both read:
 * the age of the newest manifest change, the documents per second of the last ingest request, and the golden-set recall at 5 the
 * docs canary last reported. Nothing here is persisted: a restart starts with no reading, and a missing reading is never a
 * breach (see `sloBreaches` in `@substrate/corpus`).
 */
import { goldenRecallOf, ingestDocsPerSecond, type SloReadings } from "@substrate/corpus";

/** Where a reading is announced, so the registry's gauges follow it. Both are optional: a server without observability has none. */
export interface CorpusSloSinks {
	ingestRate?: ((docsPerSecond: number) => void) | undefined;
	goldenRecall?: ((recall5: number) => void) | undefined;
}

export class CorpusSloState {
	private newestChangeAtMs: number | null = null;
	/** The reading the SLO judges: null until a request sent documents, and null again after a request that sent none. */
	private ingestReading: number | null = null;
	private golden: number | null = null;

	constructor(private readonly sinks: CorpusSloSinks = {}) {}

	/** The time of the newest manifest change, or `null` while none has been read. The gauge computes its age from this. */
	newestAtMs(): number | null {
		return this.newestChangeAtMs;
	}

	/**
	 * The manifest's last ingest time as `GET /corpus/status` reports it (an ISO string or null). A value that does not parse
	 * leaves the previous reading in place: an unreadable answer is not a change.
	 */
	setLastChangeFrom(lastIngestAt: string | null): void {
		if (lastIngestAt === null) return;
		const at = Date.parse(lastIngestAt);
		if (Number.isFinite(at)) this.newestChangeAtMs = at;
	}

	/**
	 * One finished ingest request: `sent` documents (ingested plus updated) over `elapsedMs` of wall time. The gauge takes the
	 * rate whatever it is, 0 included; the SLO reading takes it only when documents were sent, because a request that found
	 * everything unchanged is idle, not slow.
	 */
	recordIngest(sent: number, elapsedMs: number): void {
		const rate = ingestDocsPerSecond(sent, elapsedMs);
		this.ingestReading = sent > 0 ? rate : null;
		this.sinks.ingestRate?.(rate);
	}

	/** A `docs.canary` payload; a `golden_recall5` that is not a number in [0, 1] is ignored. */
	recordGolden(payload: Record<string, unknown>): void {
		const recall = goldenRecallOf(payload);
		if (recall === null) return;
		this.golden = recall;
		this.sinks.goldenRecall?.(recall);
	}

	/** The three readings at `nowMs`. */
	readings(nowMs: number): SloReadings {
		return {
			freshnessS: this.newestChangeAtMs === null ? null : Math.max(0, (nowMs - this.newestChangeAtMs) / 1000),
			recall5: this.golden,
			ingestDocsPerS: this.ingestReading,
		};
	}
}
