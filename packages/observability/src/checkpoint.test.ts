/**
 * The SLO checkpoint (uplift-3 N2): what survives a restart, and what a restore
 * must not do — double-count, accept junk, or grow past its rings.
 */
import { describe, expect, test } from "bun:test";
import { BurnLedger, BURN_MAX_SAMPLES, TOKENS_BURN_ENV, evaluateBurnSlos } from "./burn.ts";
import { CheckpointError, MAX_CHECKPOINT_BYTES, restoreCheckpoint, serializeCheckpoint, snapshotCheckpoint, type SloCheckpoint } from "./checkpoint.ts";
import { METRIC, SubstrateInstruments } from "./instruments.ts";
import { MetricRegistry, findHistogram, mergeHistogram } from "./metrics.ts";
import { CapacityRing, PLANE_BUCKET_MS, PLANE_WINDOW_MS, PlaneWindow, evaluatePlaneSlos, evaluateSlos } from "./slo.ts";

const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const SINCE = new Date(T0 - 3_600_000).toISOString();

/** A process: instruments, a plane window and a burn ledger, optionally restored from a checkpoint. */
function process(prior?: SloCheckpoint) {
	const instruments = new SubstrateInstruments(new MetricRegistry(prior ? Date.parse(prior.since) : T0 - 3_600_000));
	const skipped = prior ? instruments.registry.seed(prior.metrics) : [];
	const planes = new PlaneWindow(PLANE_WINDOW_MS, PLANE_BUCKET_MS, prior?.planes ?? {});
	const burn = new BurnLedger(undefined, undefined, prior?.burn ?? {});
	const capacity = new CapacityRing(prior?.capacity ?? []);
	return { instruments, planes, burn, capacity, skipped, epoch: prior ? prior.epoch + 1 : 1 };
}

function briefP95(instruments: SubstrateInstruments) {
	return evaluateSlos(instruments.snapshot()).find((result) => result.id === "brief.p95")!;
}

describe("snapshotCheckpoint / restoreCheckpoint", () => {
	test("round-trips counters, histograms, plane buckets, burn samples, the capacity ring and the notify map", () => {
		const live = process();
		for (let i = 0; i < 30; i++) live.instruments.recordBrief({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 100 + i * 10 });
		live.instruments.recordEmit({ surface: "omp", graph_id: "ut-1", kind: "note", stored: true, durationMs: 5, payload: {} });
		live.instruments.recordEmit({ surface: "omp", graph_id: "ut-1", kind: "note", stored: false, durationMs: 5, payload: {} });
		for (let i = 0; i < 40; i++) {
			live.instruments.recordPlane({ plane: "index", op: "memory.search", outcome: i % 10 === 0 ? "error" : "ok", durationMs: 3 });
		}
		evaluatePlaneSlos(live.instruments.snapshot(), { configured: { index: true }, window: live.planes, now: T0 - 1_800_000 });
		evaluatePlaneSlos(live.instruments.snapshot(), { configured: { index: true }, window: live.planes, now: T0 });
		live.burn.observe(METRIC.tokens, 1000, T0 - 600_000);
		live.burn.observe(METRIC.tokens, 4000, T0);
		live.capacity.record(T0 - 60_000, 1_000_000);
		live.capacity.record(T0, 1_100_000);

		const checkpoint = snapshotCheckpoint(live.instruments, live.planes, live.burn, 1, {
			since: SINCE,
			capacity: live.capacity.samples(),
			notify: { "brief.p95": { state: "breached", at: T0 - 100 } },
			now: T0,
		});
		const restored = restoreCheckpoint(serializeCheckpoint(checkpoint));

		expect(restored).toEqual(checkpoint);
		expect(restored.v).toBe(1);
		expect(restored.epoch).toBe(1);
		expect(restored.since).toBe(SINCE);
		expect(restored.writtenAt).toBe(new Date(T0).toISOString());
		expect(restored.planes.index).toHaveLength(2);
		expect(restored.burn[METRIC.tokens]).toHaveLength(2);
		expect(restored.capacity).toEqual([
			{ at: T0 - 60_000, databaseBytes: 1_000_000 },
			{ at: T0, databaseBytes: 1_100_000 },
		]);
		expect(restored.notify).toEqual({ "brief.p95": { state: "breached", at: T0 - 100 } });
		const brief = restored.metrics.find((metric) => metric.name === METRIC.briefDuration);
		expect(brief?.kind).toBe("histogram");
		expect(brief?.points[0]?.attributes).toEqual({ surface: "omp", graph_id: "ut-1", outcome: "ok" });
	});

	test("after a restore brief.p95 and plane availability read exactly as before the restart, with no new sample", () => {
		const before = process();
		for (let i = 0; i < 25; i++) before.instruments.recordBrief({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 300 });
		for (let i = 0; i < 5; i++) before.instruments.recordBrief({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 3000 });
		evaluatePlaneSlos(before.instruments.snapshot(), { configured: { index: true }, window: before.planes, now: T0 - 1_200_000 });
		for (let i = 0; i < 50; i++) {
			before.instruments.recordPlane({ plane: "index", op: "ping", outcome: i < 45 ? "ok" : "timeout", durationMs: 1 });
		}
		const planeBefore = evaluatePlaneSlos(before.instruments.snapshot(), { configured: { index: true }, window: before.planes, now: T0 }).find(
			(result) => result.plane === "index",
		)!;
		const briefBefore = briefP95(before.instruments);
		expect(briefBefore.status).toBe("breached");
		expect(planeBefore.status).toBe("breached");
		expect(planeBefore.observed).toBeCloseTo(0.9, 6);

		const text = serializeCheckpoint(snapshotCheckpoint(before.instruments, before.planes, before.burn, 1, { since: SINCE, now: T0 }));
		const after = process(restoreCheckpoint(text));

		expect(after.epoch).toBe(2);
		expect(after.skipped).toEqual([]);
		expect(briefP95(after.instruments)).toEqual(briefBefore);
		const planeAfter = evaluatePlaneSlos(after.instruments.snapshot(), { configured: { index: true }, window: after.planes, now: T0 }).find(
			(result) => result.plane === "index",
		)!;
		expect(planeAfter).toEqual(planeBefore);
	});

	test("a new sample adds to the restored series rather than replacing it", () => {
		const before = process();
		for (let i = 0; i < 20; i++) before.instruments.recordBrief({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 100 });
		const text = serializeCheckpoint(snapshotCheckpoint(before.instruments, before.planes, before.burn, 1, { since: SINCE, now: T0 }));

		const after = process(restoreCheckpoint(text));
		after.instruments.recordBrief({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 100 });
		after.instruments.recordBrief({ surface: "omp", graph_id: "ut-2", ok: true, durationMs: 100 });

		const merged = mergeHistogram(findHistogram(after.instruments.snapshot(), METRIC.briefDuration)!);
		expect(merged.count).toBe(22);
		expect(briefP95(after.instruments).samples).toBe(22);
	});

	test("a second restore of the same checkpoint does not double-count", () => {
		const before = process();
		for (let i = 0; i < 20; i++) before.instruments.recordBrief({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 100 });
		before.instruments.recordEmit({ surface: "omp", graph_id: "ut-1", kind: "note", stored: true, durationMs: 5, payload: {} });
		const restored = restoreCheckpoint(serializeCheckpoint(snapshotCheckpoint(before.instruments, before.planes, before.burn, 1, { since: SINCE, now: T0 })));

		const after = process(restored);
		after.instruments.registry.seed(restored.metrics);
		after.instruments.registry.seed(restored.metrics);

		expect(mergeHistogram(findHistogram(after.instruments.snapshot(), METRIC.briefDuration)!).count).toBe(20);
		const emit = evaluateSlos(after.instruments.snapshot()).find((result) => result.id === "emit.success")!;
		expect(emit.samples).toBe(1);
	});

	test("the burn ledger keeps its span across the restart, so the rate is judged at once", () => {
		const env = { [TOKENS_BURN_ENV]: "100000" };
		const before = process();
		before.instruments.recordUsage({ surface: "omp", graph_id: "ut-1", payload: { usage: { input_tokens: 1000, output_tokens: 0 } } });
		evaluateBurnSlos(before.instruments.snapshot(), { env, ledger: before.burn, now: T0 - 600_000 });
		before.instruments.recordUsage({ surface: "omp", graph_id: "ut-1", payload: { usage: { input_tokens: 9000, output_tokens: 0 } } });
		const resultBefore = evaluateBurnSlos(before.instruments.snapshot(), { env, ledger: before.burn, now: T0 }).find((r) => r.id === "burn.tokens")!;
		expect(resultBefore.status).toBe("ok");
		expect(resultBefore.observed).toBeCloseTo(54_000, 0);

		const after = process(restoreCheckpoint(serializeCheckpoint(snapshotCheckpoint(before.instruments, before.planes, before.burn, 1, { since: SINCE, now: T0 }))));
		const resultAfter = evaluateBurnSlos(after.instruments.snapshot(), { env, ledger: after.burn, now: T0 }).find((r) => r.id === "burn.tokens")!;
		expect(resultAfter).toEqual(resultBefore);

		// The next hour's spend is a delta over the restored base, never a reset.
		after.instruments.recordUsage({ surface: "omp", graph_id: "ut-1", payload: { usage: { input_tokens: 1000, output_tokens: 0 } } });
		const later = evaluateBurnSlos(after.instruments.snapshot(), { env, ledger: after.burn, now: T0 + 60_000 }).find((r) => r.id === "burn.tokens")!;
		expect(later.status).toBe("ok");
		expect(later.samples).toBe(3);
	});

	test("a histogram whose bounds moved is skipped, and reported", () => {
		const text = serializeCheckpoint({
			v: 1,
			epoch: 3,
			writtenAt: new Date(T0).toISOString(),
			since: SINCE,
			metrics: [
				{ kind: "histogram", name: METRIC.briefDuration, bounds: [1, 2], points: [{ attributes: {}, count: 1, sum: 1, min: 1, max: 1, bucketCounts: [1, 0, 0] }] },
				{ kind: "counter", name: "substrate.gone", points: [{ attributes: {}, value: 4 }] },
			],
			planes: {},
			burn: {},
			capacity: [],
			notify: {},
		});
		const after = process(restoreCheckpoint(text));
		expect(after.skipped.sort()).toEqual(["substrate.gone", METRIC.briefDuration].sort());
		expect(mergeHistogram(findHistogram(after.instruments.snapshot(), METRIC.briefDuration)!).count).toBe(0);
		expect(after.epoch).toBe(4);
	});
});

describe("restoreCheckpoint refuses", () => {
	const valid = () => snapshotCheckpoint(new SubstrateInstruments(), new PlaneWindow(), new BurnLedger(), 1, { since: SINCE, now: T0 });

	test("text that is not JSON", () => {
		expect(() => restoreCheckpoint("{not json")).toThrow(CheckpointError);
		expect(() => restoreCheckpoint("")).toThrow(CheckpointError);
	});

	test("another version, a missing epoch, or a bad time", () => {
		expect(() => restoreCheckpoint(JSON.stringify({ ...valid(), v: 2 }))).toThrow(/version 2/);
		expect(() => restoreCheckpoint(JSON.stringify({ ...valid(), epoch: -1 }))).toThrow(/epoch/);
		expect(() => restoreCheckpoint(JSON.stringify({ ...valid(), epoch: 1.5 }))).toThrow(/epoch/);
		expect(() => restoreCheckpoint(JSON.stringify({ ...valid(), since: "yesterday" }))).toThrow(/since/);
		expect(() => restoreCheckpoint(JSON.stringify({ ...valid(), writtenAt: 12 }))).toThrow(/writtenAt/);
	});

	test("a point that is not a point", () => {
		const counter = { ...valid(), metrics: [{ kind: "counter", name: "x", points: [{ attributes: {}, value: -1 }] }] };
		expect(() => restoreCheckpoint(JSON.stringify(counter))).toThrow(/metrics\[0\]\.points\[0\]/);
		const histogram = {
			...valid(),
			metrics: [{ kind: "histogram", name: "x", bounds: [1], points: [{ attributes: {}, count: 1, sum: 1, min: 1, max: 1, bucketCounts: [1] }] }],
		};
		expect(() => restoreCheckpoint(JSON.stringify(histogram))).toThrow(/2 buckets/);
		const attribute = { ...valid(), metrics: [{ kind: "counter", name: "x", points: [{ attributes: { a: { nested: true } }, value: 1 }] }] };
		expect(() => restoreCheckpoint(JSON.stringify(attribute))).toThrow(/attributes\.a/);
		const notify = { ...valid(), notify: { "brief.p95": { state: "fine", at: 1 } } };
		expect(() => restoreCheckpoint(JSON.stringify(notify))).toThrow(/notify\.brief\.p95/);
	});

	test("a file over 4 MB, before parsing it", () => {
		const padded = JSON.stringify({ ...valid(), pad: "x".repeat(MAX_CHECKPOINT_BYTES) });
		expect(() => restoreCheckpoint(padded)).toThrow(/byte limit/);
	});

	test("nothing, but cuts every ring to its cap keeping the newest", () => {
		const planeCap = Math.ceil(PLANE_WINDOW_MS / PLANE_BUCKET_MS) + 1;
		const text = JSON.stringify({
			...valid(),
			planes: { index: Array.from({ length: planeCap + 50 }, (_, i) => ({ atMs: i, ok: i, total: i, baseAtMs: i, baseOk: i, baseTotal: i })) },
			burn: { [METRIC.tokens]: Array.from({ length: BURN_MAX_SAMPLES + 20 }, (_, i) => ({ atMs: i, total: i })) },
			capacity: Array.from({ length: 1500 }, (_, i) => ({ at: i, databaseBytes: i })),
		});
		const restored = restoreCheckpoint(text);
		expect(restored.planes.index).toHaveLength(planeCap);
		expect(restored.planes.index?.[0]?.atMs).toBe(50);
		expect(restored.burn[METRIC.tokens]).toHaveLength(BURN_MAX_SAMPLES);
		expect(restored.burn[METRIC.tokens]?.[0]?.atMs).toBe(20);
		expect(restored.capacity).toHaveLength(1440);
		expect(restored.capacity[0]?.at).toBe(60);
	});

	test("a checkpoint without capacity or notify (an older writer) restores with empty ones", () => {
		const { capacity: _c, notify: _n, ...older } = valid();
		const restored = restoreCheckpoint(JSON.stringify(older));
		expect(restored.capacity).toEqual([]);
		expect(restored.notify).toEqual({});
	});
});
