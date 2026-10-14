/**
 * The restart-durable SLO checkpoint (uplift-3 N2).
 *
 * Every deploy used to zero `brief.p95`, the plane windows and the burn
 * ledger: the catalogue is a process-lifetime aggregate and the windows are
 * in-memory rings, so the first hour after a restart judged nothing and an
 * outage that ended at the restart left no trace. The checkpoint is one JSON
 * file the server writes every `SUBSTRATE_SLO_CHECKPOINT_S` and on shutdown,
 * and reads once at boot:
 *
 *   - the cumulative counter and histogram points, with attributes, which the
 *     next epoch seeds as its *prior* layer (`Instrument.seed`) — live
 *     observations start from zero on top of it, so the merged series are
 *     cumulative across restarts and a second restore of the same file
 *     replaces the layer rather than adding to it;
 *   - the plane window buckets and burn ledger samples, so the rolling hour is
 *     still an hour after a restart rather than an empty window;
 *   - the capacity ring (`/healthz` size reads) the runway is fitted over;
 *   - the last state the notifier emitted per objective, so a restart never
 *     re-announces a breach it already announced.
 *
 * `epoch` counts restarts: a fresh process is epoch 1, a restored one is the
 * checkpoint's epoch plus one. `since` is the start of epoch 1 and is carried
 * forward unchanged — it is the oldest sample the merged series reach back to.
 *
 * Validation is hand-rolled narrowing like `config.ts`: this package has no
 * schema library, and the shape is small. Anything that does not narrow
 * throws `CheckpointError`, which the server logs once and starts fresh on.
 * A file over `MAX_CHECKPOINT_BYTES` is refused before it is parsed, and every
 * ring is cut to its own cap (newest kept) so a file written by a release with
 * larger rings cannot grow this one past its bounds.
 */
import type { Attributes, CounterPoint, GaugeSnapshot, HistogramPoint, MetricSnapshot } from "./metrics.ts";
import { BURN_MAX_SAMPLES, type BurnLedger, type BurnSample } from "./burn.ts";
import { PLANES, type PlaneName } from "./breaker.ts";
import {
	CAPACITY_RING_MAX,
	PLANE_BUCKET_MS,
	PLANE_WINDOW_MS,
	type CapacitySample,
	type PlaneCountSample,
	type PlaneWindow,
} from "./slo.ts";

export const CHECKPOINT_VERSION = 1;
/** The largest file that is read. Past this the file is refused unparsed: a 4 MB checkpoint is a bug, not history. */
export const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;

/** The states the notifier announces; `recovered` is the end of either of the other two. */
export const NOTIFY_STATES = ["breached", "open", "recovered"] as const;
export type NotifyState = (typeof NOTIFY_STATES)[number];

/** The last transition emitted for one objective, as the checkpoint remembers it. */
export interface NotifyRecord {
	state: NotifyState;
	/** Epoch ms of the emit. */
	at: number;
}

/** One counter as the checkpoint carries it: name, kind, points — never description or unit, which the running release owns. */
export interface CheckpointCounter {
	kind: "counter";
	name: string;
	points: CounterPoint[];
}

export interface CheckpointHistogram {
	kind: "histogram";
	name: string;
	bounds: number[];
	points: HistogramPoint[];
}

export type CheckpointMetric = CheckpointCounter | CheckpointHistogram;

export interface SloCheckpoint {
	v: typeof CHECKPOINT_VERSION;
	/** Restarts so far; the process that wrote this was this epoch. */
	epoch: number;
	/** ISO time of the write. */
	writtenAt: string;
	/** ISO time the history starts: epoch 1's registry start, carried forward. */
	since: string;
	metrics: CheckpointMetric[];
	planes: Partial<Record<PlaneName, PlaneCountSample[]>>;
	burn: Record<string, BurnSample[]>;
	capacity: CapacitySample[];
	notify: Record<string, NotifyRecord>;
}

/** What the server adds to the observability package's own state when it writes. */
export interface CheckpointExtras {
	/** Carried from the restored checkpoint, or the registry's start on a fresh process. */
	since: string;
	capacity?: readonly CapacitySample[];
	notify?: Record<string, NotifyRecord>;
	/** The write time, epoch ms; defaults to now. */
	now?: number;
}

export class CheckpointError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CheckpointError";
	}
}

/** The checkpoint for this moment: every merged series, every ring, copied. */
export function snapshotCheckpoint(
	instruments: { snapshot(): MetricSnapshot[] },
	planes: PlaneWindow,
	burn: BurnLedger,
	epoch: number,
	extras: CheckpointExtras,
): SloCheckpoint {
	return {
		v: CHECKPOINT_VERSION,
		epoch,
		writtenAt: new Date(extras.now ?? Date.now()).toISOString(),
		since: extras.since,
		// A gauge is a reading, not history: it is recomputed after a restart and never checkpointed.
		metrics: instruments.snapshot().filter((metric): metric is Exclude<MetricSnapshot, GaugeSnapshot> => metric.kind !== "gauge").map((metric): CheckpointMetric =>
			metric.kind === "counter"
				? { kind: "counter", name: metric.name, points: metric.points.map((point) => ({ attributes: { ...point.attributes }, value: point.value })) }
				: {
						kind: "histogram",
						name: metric.name,
						bounds: [...metric.bounds],
						points: metric.points.map((point) => ({ ...point, attributes: { ...point.attributes }, bucketCounts: [...point.bucketCounts] })),
					},
		),
		planes: planes.export(),
		burn: burn.export(),
		capacity: (extras.capacity ?? []).slice(-CAPACITY_RING_MAX).map((sample) => ({ ...sample })),
		notify: Object.fromEntries(Object.entries(extras.notify ?? {}).map(([id, record]) => [id, { ...record }])),
	};
}

export function serializeCheckpoint(checkpoint: SloCheckpoint): string {
	return JSON.stringify(checkpoint);
}

/**
 * Parse and validate a checkpoint file's text. Throws `CheckpointError` for
 * anything that is not a well-formed version-1 checkpoint; the caller starts
 * fresh and says so once. Rings are cut to their caps, newest kept.
 */
export function restoreCheckpoint(json: string): SloCheckpoint {
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes > MAX_CHECKPOINT_BYTES) {
		throw new CheckpointError(`checkpoint is ${bytes} bytes, over the ${MAX_CHECKPOINT_BYTES} byte limit`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (cause) {
		throw new CheckpointError(`checkpoint is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	if (!isRecord(parsed)) throw new CheckpointError("checkpoint is not an object");
	if (parsed.v !== CHECKPOINT_VERSION) throw new CheckpointError(`checkpoint version ${String(parsed.v)} is not ${CHECKPOINT_VERSION}`);
	if (!isNonNegativeInt(parsed.epoch)) throw new CheckpointError("checkpoint epoch is not a non-negative integer");
	if (typeof parsed.writtenAt !== "string" || !Number.isFinite(Date.parse(parsed.writtenAt))) {
		throw new CheckpointError("checkpoint writtenAt is not an ISO time");
	}
	if (typeof parsed.since !== "string" || !Number.isFinite(Date.parse(parsed.since))) {
		throw new CheckpointError("checkpoint since is not an ISO time");
	}
	if (!Array.isArray(parsed.metrics)) throw new CheckpointError("checkpoint metrics is not an array");
	const metrics = parsed.metrics.map((metric, i) => narrowMetric(metric, i));

	if (!isRecord(parsed.planes)) throw new CheckpointError("checkpoint planes is not an object");
	const planeCap = Math.ceil(PLANE_WINDOW_MS / PLANE_BUCKET_MS) + 1;
	const planes: Partial<Record<PlaneName, PlaneCountSample[]>> = {};
	for (const plane of PLANES) {
		const raw = parsed.planes[plane];
		if (raw === undefined) continue;
		if (!Array.isArray(raw)) throw new CheckpointError(`checkpoint planes.${plane} is not an array`);
		const samples = raw.map((sample, i) => narrowPlaneSample(sample, `planes.${plane}[${i}]`)).slice(-planeCap);
		if (samples.length > 0) planes[plane] = samples;
	}

	if (!isRecord(parsed.burn)) throw new CheckpointError("checkpoint burn is not an object");
	const burn: Record<string, BurnSample[]> = {};
	for (const [metric, raw] of Object.entries(parsed.burn)) {
		if (!Array.isArray(raw)) throw new CheckpointError(`checkpoint burn.${metric} is not an array`);
		const samples = raw.map((sample, i) => narrowBurnSample(sample, `burn.${metric}[${i}]`)).slice(-BURN_MAX_SAMPLES);
		if (samples.length > 0) burn[metric] = samples;
	}

	// `capacity` and `notify` arrived with this version too, but a checkpoint
	// may be written by the observability package alone (tests, a future
	// tool), so their absence is an empty ring rather than a refusal.
	const capacityRaw = parsed.capacity ?? [];
	if (!Array.isArray(capacityRaw)) throw new CheckpointError("checkpoint capacity is not an array");
	const capacity = capacityRaw.map((sample, i) => narrowCapacitySample(sample, `capacity[${i}]`)).slice(-CAPACITY_RING_MAX);

	const notifyRaw = parsed.notify ?? {};
	if (!isRecord(notifyRaw)) throw new CheckpointError("checkpoint notify is not an object");
	const notify: Record<string, NotifyRecord> = {};
	for (const [id, raw] of Object.entries(notifyRaw)) {
		if (!isRecord(raw) || !(NOTIFY_STATES as readonly unknown[]).includes(raw.state) || !isFiniteNumber(raw.at)) {
			throw new CheckpointError(`checkpoint notify.${id} is not a {state, at} record`);
		}
		notify[id] = { state: raw.state as NotifyState, at: raw.at };
	}

	return { v: CHECKPOINT_VERSION, epoch: parsed.epoch, writtenAt: parsed.writtenAt, since: parsed.since, metrics, planes, burn, capacity, notify };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInt(value: unknown): value is number {
	return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function narrowAttributes(value: unknown, where: string): Attributes {
	if (!isRecord(value)) throw new CheckpointError(`checkpoint ${where}.attributes is not an object`);
	const out: Attributes = {};
	for (const [key, attribute] of Object.entries(value)) {
		if (typeof attribute !== "string" && typeof attribute !== "boolean" && !isFiniteNumber(attribute)) {
			throw new CheckpointError(`checkpoint ${where}.attributes.${key} is not a string, number or boolean`);
		}
		out[key] = attribute;
	}
	return out;
}

function narrowMetric(value: unknown, index: number): CheckpointMetric {
	const where = `metrics[${index}]`;
	if (!isRecord(value) || typeof value.name !== "string" || value.name === "") {
		throw new CheckpointError(`checkpoint ${where} has no name`);
	}
	if (!Array.isArray(value.points)) throw new CheckpointError(`checkpoint ${where}.points is not an array`);
	if (value.kind === "counter") {
		return {
			kind: "counter",
			name: value.name,
			points: value.points.map((point, i): CounterPoint => {
				if (!isRecord(point) || !isFiniteNumber(point.value) || point.value < 0) {
					throw new CheckpointError(`checkpoint ${where}.points[${i}] is not a non-negative counter point`);
				}
				return { attributes: narrowAttributes(point.attributes, `${where}.points[${i}]`), value: point.value };
			}),
		};
	}
	if (value.kind === "histogram") {
		if (!Array.isArray(value.bounds) || !value.bounds.every(isFiniteNumber)) {
			throw new CheckpointError(`checkpoint ${where}.bounds is not a number array`);
		}
		const bounds = value.bounds as number[];
		return {
			kind: "histogram",
			name: value.name,
			bounds,
			points: value.points.map((point, i): HistogramPoint => {
				if (
					!isRecord(point) ||
					!isNonNegativeInt(point.count) ||
					!isFiniteNumber(point.sum) ||
					!isFiniteNumber(point.min) ||
					!isFiniteNumber(point.max) ||
					!Array.isArray(point.bucketCounts) ||
					point.bucketCounts.length !== bounds.length + 1 ||
					!point.bucketCounts.every(isNonNegativeInt)
				) {
					throw new CheckpointError(`checkpoint ${where}.points[${i}] is not a histogram point over ${bounds.length + 1} buckets`);
				}
				return {
					attributes: narrowAttributes(point.attributes, `${where}.points[${i}]`),
					count: point.count,
					sum: point.sum,
					min: point.min,
					max: point.max,
					bucketCounts: point.bucketCounts as number[],
				};
			}),
		};
	}
	throw new CheckpointError(`checkpoint ${where}.kind ${String(value.kind)} is not counter or histogram`);
}

function narrowPlaneSample(value: unknown, where: string): PlaneCountSample {
	if (
		!isRecord(value) ||
		!isFiniteNumber(value.atMs) ||
		!isFiniteNumber(value.ok) ||
		!isFiniteNumber(value.total) ||
		!isFiniteNumber(value.baseAtMs) ||
		!isFiniteNumber(value.baseOk) ||
		!isFiniteNumber(value.baseTotal)
	) {
		throw new CheckpointError(`checkpoint ${where} is not a plane bucket`);
	}
	return { atMs: value.atMs, ok: value.ok, total: value.total, baseAtMs: value.baseAtMs, baseOk: value.baseOk, baseTotal: value.baseTotal };
}

function narrowBurnSample(value: unknown, where: string): BurnSample {
	if (!isRecord(value) || !isFiniteNumber(value.atMs) || !isFiniteNumber(value.total)) {
		throw new CheckpointError(`checkpoint ${where} is not a burn sample`);
	}
	return { atMs: value.atMs, total: value.total };
}

function narrowCapacitySample(value: unknown, where: string): CapacitySample {
	if (!isRecord(value) || !isFiniteNumber(value.at) || !isFiniteNumber(value.databaseBytes) || value.databaseBytes < 0) {
		throw new CheckpointError(`checkpoint ${where} is not a capacity sample`);
	}
	return { at: value.at, databaseBytes: value.databaseBytes };
}
