/**
 * Restart-durable SLO history over a real socket (uplift-3 N2): the harness is
 * started, fed, checkpointed, closed and started again on the same checkpoint
 * path, which is what a deploy does to the service.
 */
import { afterAll, describe, expect, test, vi } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BurnLedger,
	MAX_CHECKPOINT_BYTES,
	METRIC,
	PlaneWindow,
	SubstrateInstruments,
	restoreCheckpoint,
	serializeCheckpoint,
	snapshotCheckpoint,
	type CapacitySample,
} from "@substrate/observability";
import { loadConfig } from "./config.ts";
import { createObservability, type CheckpointFiles, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";

interface Harness {
	base: string;
	observability: Observability;
	warnings: string[];
	close(): Promise<void>;
}

const running: Harness[] = [];
const directories: string[] = [];

async function start(env: Record<string, string | undefined> = {}, stores: Partial<{ index: unknown; greptime: unknown }> = {}): Promise<Harness> {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	const warnings = await observability.start();
	const substrate = new Substrate(config, { index: null, greptime: null, ...stores } as ConstructorParameters<typeof Substrate>[1], observability.observer);
	const server = createHttpServer(substrate, config, observability);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	let closed = false;
	const harness: Harness = {
		base: `http://127.0.0.1:${port}`,
		observability,
		warnings,
		async close() {
			if (closed) return;
			closed = true;
			observability.stop();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
	running.push(harness);
	return harness;
}

afterAll(async () => {
	for (const harness of running) await harness.close();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function checkpointPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "substrate-slo-"));
	directories.push(directory);
	return join(directory, "slo-checkpoint.json");
}

interface SloBody {
	results: Array<{ id: string; status: string; observed: number | null; samples: number }>;
	breached: string[];
	planes: Array<{ id: string; status: string; observed: number | null; samples: number }>;
	burn: Array<{ id: string; status: string; observed: number | null }>;
	capacity: Array<{ id: string; status: string; observed: number | null; detail: string; samples: number }>;
	history: { epoch: number; since: string; checkpointAt: string | null };
}

async function slo(harness: Harness): Promise<SloBody> {
	return (await (await fetch(`${harness.base}/slo`)).json()) as SloBody;
}

/** Thirty briefs, five of them slow enough to breach `brief.p95`. */
function breachBriefs(harness: Harness): void {
	for (let i = 0; i < 25; i++) harness.observability.observer.briefed?.({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 200 });
	for (let i = 0; i < 5; i++) harness.observability.observer.briefed?.({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 3000 });
}

describe("/slo.history across restarts", () => {
	test("the epoch increments per restart on the same checkpoint, and the series carry over with no new sample", async () => {
		const path = checkpointPath();
		const first = await start({ SUBSTRATE_SLO_CHECKPOINT: path });
		expect(first.warnings.join("\n")).not.toContain("slo checkpoint");
		breachBriefs(first);
		const before = await slo(first);
		expect(before.history).toMatchObject({ epoch: 1, checkpointAt: null });
		expect(Number.isNaN(Date.parse(before.history.since))).toBe(false);
		expect(before.results.find((r) => r.id === "brief.p95")).toMatchObject({ status: "breached", samples: 30 });
		expect(before.breached).toEqual(["brief.p95"]);

		const write = await first.observability.checkpoint();
		expect(write).toMatchObject({ written: true, error: null });
		expect(existsSync(path)).toBe(true);
		expect(existsSync(`${path}.part`)).toBe(false);
		expect((await slo(first)).history.checkpointAt).not.toBeNull();
		await first.close();

		const second = await start({ SUBSTRATE_SLO_CHECKPOINT: path });
		expect(second.warnings.join("\n")).not.toContain("slo checkpoint");
		const restored = await slo(second);
		expect(restored.history.epoch).toBe(2);
		expect(restored.history.since).toBe(before.history.since);
		expect(restored.history.checkpointAt).toBe(restoreCheckpoint(readFileSync(path, "utf8")).writtenAt);
		expect(restored.results.find((r) => r.id === "brief.p95")).toEqual(before.results.find((r) => r.id === "brief.p95"));
		expect(restored.breached).toEqual(["brief.p95"]);
		// `/metrics.startedAt` is the history's start, not this process's.
		const metrics = (await (await fetch(`${second.base}/metrics`)).json()) as { startedAt: string };
		expect(metrics.startedAt).toBe(before.history.since);

		// A new sample adds to the restored series.
		second.observability.observer.briefed?.({ surface: "omp", graph_id: "ut-2", ok: true, durationMs: 100 });
		expect((await slo(second)).results.find((r) => r.id === "brief.p95")?.samples).toBe(31);
		await second.observability.checkpoint();
		await second.close();

		const third = await start({ SUBSTRATE_SLO_CHECKPOINT: path });
		const again = await slo(third);
		expect(again.history.epoch).toBe(3);
		expect(again.results.find((r) => r.id === "brief.p95")?.samples).toBe(31);
	});

	test("a corrupt checkpoint is one boot warning and a fresh start; so is one over 4 MB", async () => {
		const corrupt = checkpointPath();
		writeFileSync(corrupt, "{not a checkpoint");
		const fresh = await start({ SUBSTRATE_SLO_CHECKPOINT: corrupt });
		expect(fresh.warnings.filter((w) => w.includes("slo checkpoint"))).toHaveLength(1);
		expect(fresh.warnings.find((w) => w.includes("slo checkpoint"))).toContain("starts fresh");
		expect((await slo(fresh)).history.epoch).toBe(1);
		// And the next write replaces it, so the following boot is clean.
		expect((await fresh.observability.checkpoint()).written).toBe(true);
		await fresh.close();
		const clean = await start({ SUBSTRATE_SLO_CHECKPOINT: corrupt });
		expect(clean.warnings.join("\n")).not.toContain("slo checkpoint");
		expect((await slo(clean)).history.epoch).toBe(2);

		const huge = checkpointPath();
		writeFileSync(huge, `{"v":1,"pad":"${"x".repeat(MAX_CHECKPOINT_BYTES)}"}`);
		const refused = await start({ SUBSTRATE_SLO_CHECKPOINT: huge });
		expect(refused.warnings.find((w) => w.includes("slo checkpoint"))).toContain("byte limit");
		expect((await slo(refused)).history.epoch).toBe(1);
	});

	test("no path means no checkpoint: a restart starts at epoch 1 and the boot says so", async () => {
		const harness = await start({});
		expect(harness.warnings.join("\n")).toContain("no SLO checkpoint path");
		expect((await slo(harness)).history).toMatchObject({ epoch: 1, checkpointAt: null });
		expect(await harness.observability.checkpoint()).toEqual({ written: false, bytes: 0, error: null });
		expect(loadConfig({}).sloCheckpointPath).toBeNull();
		expect(loadConfig({}, { directoryExists: () => true }).sloCheckpointPath).toBe("/var/lib/substrate/slo-checkpoint.json");
		expect(loadConfig({}, { directoryExists: () => false }).sloCheckpointPath).toBeNull();
		expect(loadConfig({ SUBSTRATE_SLO_CHECKPOINT: "off" }, { directoryExists: () => true }).sloCheckpointPath).toBeNull();
		expect(loadConfig({ SUBSTRATE_SLO_CHECKPOINT: "relative/slo.json" })).toMatchObject({ sloCheckpointPath: null, sloCheckpointRejected: "relative/slo.json" });
	});

	test("the periodic writer saves on its interval, atomically", async () => {
		const path = checkpointPath();
		const harness = await start({ SUBSTRATE_SLO_CHECKPOINT: path, SUBSTRATE_SLO_CHECKPOINT_S: "1" });
		harness.observability.observer.briefed?.({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 100 });
		// A real wait, on purpose: the interval is `setInterval` inside `start()`,
		// behind no clock seam, and this is the one test that proves the timer
		// itself fires and writes. Everything else drives `checkpoint()` directly.
		await Bun.sleep(1400);
		expect(existsSync(path)).toBe(true);
		expect(existsSync(`${path}.part`)).toBe(false);
		const saved = restoreCheckpoint(readFileSync(path, "utf8"));
		expect(saved.epoch).toBe(1);
		expect(saved.metrics.find((m) => m.name === METRIC.briefDuration)?.points[0]).toMatchObject({ count: 1 });
	});

	test("an unwritable path is one log line and `written: false`, never a throw", async () => {
		const directory = mkdtempSync(join(tmpdir(), "substrate-slo-"));
		directories.push(directory);
		writeFileSync(join(directory, "file"), "");
		const harness = await start({ SUBSTRATE_SLO_CHECKPOINT: join(directory, "file", "slo.json") });
		const write = await harness.observability.checkpoint();
		expect(write.written).toBe(false);
		expect(write.error).not.toBeNull();
	});

	test("overlapping triggers share one write; the next trigger after it starts another (Greptile round 1, PR #61)", async () => {
		// The periodic timer, `checkpoint()` and the shutdown path all go through
		// the same single-flight door, so a slow disk never has two `.part` +
		// rename sequences racing over one path.
		const path = checkpointPath();
		const harness = await start({ SUBSTRATE_SLO_CHECKPOINT: path, SUBSTRATE_SLO_CHECKPOINT_S: "1" });
		harness.observability.observer.briefed?.({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 100 });
		const first = harness.observability.checkpoint();
		const second = harness.observability.checkpoint();
		expect(second).toBe(first);
		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(b);
		expect(a).toMatchObject({ written: true, error: null });
		const writtenAt = restoreCheckpoint(readFileSync(path, "utf8")).writtenAt;

		// Once it has settled, a new trigger is a new write.
		harness.observability.observer.briefed?.({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 100 });
		const third = harness.observability.checkpoint();
		expect(third).not.toBe(first);
		expect((await third).written).toBe(true);
		const saved = restoreCheckpoint(readFileSync(path, "utf8"));
		expect(Date.parse(saved.writtenAt)).toBeGreaterThanOrEqual(Date.parse(writtenAt));
		expect(saved.metrics.find((m) => m.name === METRIC.briefDuration)?.points[0]).toMatchObject({ count: 2 });
		expect(existsSync(`${path}.part`)).toBe(false);
	});

	test("the timer and a manual checkpoint never write concurrently; the shutdown flush waits for the write in flight, then writes fresh (Greptile round 1, PR #61)", async () => {
		// The timer used to call the raw writer, so a slow write could overlap the
		// next tick or the shutdown checkpoint: two `.part` writers and renames
		// over one path. A held-open writeFile makes the overlap observable, and
		// fake timers drive the ticks without a wall-clock wait.
		const path = checkpointPath();
		const env = { SUBSTRATE_SLO_CHECKPOINT: path, SUBSTRATE_SLO_CHECKPOINT_S: "1" };
		let active = 0;
		let maxActive = 0;
		let started = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const files: CheckpointFiles = {
			async writeFile(target, data, encoding) {
				started++;
				active++;
				maxActive = Math.max(maxActive, active);
				try {
					await gate;
					await writeFile(target, data, encoding);
				} finally {
					active--;
				}
			},
			rename,
		};
		vi.useFakeTimers();
		const observability = createObservability(loadConfig(env), env, files);
		try {
			await observability.start();
			observability.observer.briefed?.({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 100 });
			// The first timer tick starts a write, which then hangs on the gate.
			vi.advanceTimersByTime(1000);
			expect(started).toBe(1);

			// Something is observed after that write took its snapshot, then the
			// shutdown flush arrives mid-write, and a second and third timer tick
			// fall inside the wait as well: none may start another writer.
			observability.observer.briefed?.({ surface: "omp", graph_id: "ut-1", ok: true, durationMs: 100 });
			let shutdownSettled = false;
			const flush = observability.flush();
			const shutdown = flush.then((write) => {
				shutdownSettled = true;
				return write;
			});
			// A second shutdown call joins the final write rather than starting one.
			expect(observability.flush()).toBe(flush);
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
			expect(started).toBe(1);
			expect(maxActive).toBe(1);
			expect(shutdownSettled).toBe(false);

			release();
			expect(await shutdown).toMatchObject({ written: true, error: null });
			// The in-flight write finished first, then exactly one fresh write ran,
			// never overlapping it: the file holds the post-write observation.
			expect(started).toBe(2);
			expect(maxActive).toBe(1);
			expect(restoreCheckpoint(readFileSync(path, "utf8")).metrics.find((m) => m.name === METRIC.briefDuration)?.points[0]).toMatchObject({ count: 2 });
			expect(existsSync(`${path}.part`)).toBe(false);
		} finally {
			observability.stop();
			vi.useRealTimers();
		}
	});
});

describe("/slo.breached folds in plane and burn breaches", () => {
	test("a plane and a burn breach appear beside the catalogue's, with the per-array detail unchanged", async () => {
		// Seed the rolling windows ten minutes back through a checkpoint, so one
		// live read spans enough to judge both; that is exactly what a restart
		// mid-hour now looks like.
		const path = checkpointPath();
		const tenMinutesAgo = Date.now() - 10 * 60_000;
		const seed = snapshotCheckpoint(
			new SubstrateInstruments(),
			new PlaneWindow(undefined, undefined, { index: [{ atMs: tenMinutesAgo, ok: 0, total: 0, baseAtMs: tenMinutesAgo, baseOk: 0, baseTotal: 0 }] }),
			new BurnLedger(undefined, undefined, { [METRIC.tokens]: [{ atMs: tenMinutesAgo, total: 0 }] }),
			1,
			{ since: new Date(tenMinutesAgo).toISOString() },
		);
		writeFileSync(path, serializeCheckpoint(seed));

		const harness = await start({ SUBSTRATE_SLO_CHECKPOINT: path, SUBSTRATE_BURN_TOKENS_PER_HOUR: "1000" }, { index: { ping: async () => true } });
		for (let i = 0; i < 50; i++) {
			harness.observability.observer.plane?.({ plane: "index", op: "ping", outcome: i < 40 ? "ok" : "timeout", durationMs: 1 });
		}
		harness.observability.observer.emitted?.({
			surface: "omp",
			graph_id: "ut-1",
			kind: "note",
			stored: true,
			durationMs: 1,
			payload: { usage: { input_tokens: 5000, output_tokens: 0 } },
		});
		breachBriefs(harness);

		const body = await slo(harness);
		expect(body.history.epoch).toBe(2);
		expect(body.planes.find((p) => p.id === "plane.index.availability")).toMatchObject({ status: "breached", observed: 0.8, samples: 50 });
		expect(body.burn.find((b) => b.id === "burn.tokens")?.status).toBe("breached");
		expect(body.breached).toEqual(["brief.p95", "plane.index.availability", "burn.tokens"]);
	});
});

describe("/slo.capacity", () => {
	test("is insufficient-data until the ring spans a day, and names the unset volume", async () => {
		const capacity = { databaseBytes: 11_000_000, tables: [] };
		const harness = await start({}, { index: { ping: async () => true, capacity: async () => capacity } });
		await fetch(`${harness.base}/healthz`);
		const body = await slo(harness);
		expect(body.capacity).toHaveLength(1);
		expect(body.capacity[0]).toMatchObject({ id: "capacity.index.runway_days", status: "insufficient-data", samples: 1 });
		expect(body.capacity[0]?.detail).toContain("SUBSTRATE_INDEX_VOLUME_BYTES");
	});

	test("fits the runway over the restored ring and judges it against the volume", async () => {
		const path = checkpointPath();
		const now = Date.now();
		const MB = 1_048_576;
		const samples: CapacitySample[] = [];
		for (let minute = 48 * 60; minute >= 0; minute -= 10) {
			samples.push({ at: now - minute * 60_000, databaseBytes: Math.round(2048 * MB + (100 * MB * (48 * 60 - minute)) / (24 * 60)) });
		}
		writeFileSync(
			path,
			serializeCheckpoint(
				snapshotCheckpoint(new SubstrateInstruments(), new PlaneWindow(), new BurnLedger(), 1, { since: new Date(now - 48 * 3_600_000).toISOString(), capacity: samples }),
			),
		);
		const harness = await start({ SUBSTRATE_SLO_CHECKPOINT: path, SUBSTRATE_INDEX_VOLUME_BYTES: String(10 * 1024 * MB) });
		const body = await slo(harness);
		const current = defined(samples[samples.length - 1], "last capacity sample").databaseBytes;
		expect(body.capacity[0]).toMatchObject({ status: "ok", samples: samples.length });
		expect(body.capacity[0]?.observed).toBeCloseTo((10 * 1024 * MB - current) / (100 * MB), 0);
		expect(body.breached).toEqual([]);

		const tight = await start({ SUBSTRATE_SLO_CHECKPOINT: path, SUBSTRATE_INDEX_VOLUME_BYTES: String(2300 * MB) });
		expect((await slo(tight)).capacity[0]?.status).toBe("breached");
	});
});

describe("/slo.forecast", () => {
	const LEDGER_URL_KEY = ["GREPTIME", "URL"].join("_");
	const OBJECTIVES = ["brief.p95", "emit.success", "lease.steal_rate", "quarantine.rate"];
	interface ForecastBody {
		forecast: Array<{ id: string; status: string; predicted: number | null; samples: number }>;
		breached: string[];
	}

	test("one row per objective; history off says so with no value; a predicted breach is report-only and never folds into breached", async () => {
		const off = await start({});
		const offBody = (await (await fetch(`${off.base}/slo`)).json()) as ForecastBody;
		expect(offBody.forecast.map((row) => row.id)).toEqual(OBJECTIVES);
		expect(offBody.forecast.every((row) => row.status === "history-off" && row.predicted === null)).toBe(true);

		const now = Date.now();
		const greptime = {
			async readMetricHistory(query: { series: string; stepS: number }) {
				const rising = query.series === "brief.p95";
				const points = rising ? Array.from({ length: 24 }, (_, i) => ({ tsMs: now - (24 - i) * 300_000, labels: { surface: "chat" }, value: 100 + 40 * i, count: 5 })) : [];
				return { points, stepS: query.stepS };
			},
		};
		const on = await start({ [LEDGER_URL_KEY]: "http://ledger.test", SUBSTRATE_METRICS_HISTORY: "on" }, { greptime });
		const onBody = (await (await fetch(`${on.base}/slo`)).json()) as ForecastBody;
		expect(onBody.forecast.map((row) => row.id)).toEqual(OBJECTIVES);
		const latency = onBody.forecast.find((row) => row.id === "brief.p95");
		expect(latency).toMatchObject({ status: "predicted-breach", samples: 24 });
		expect(latency?.predicted).toBeGreaterThan(800);
		expect(onBody.forecast.find((row) => row.id === "emit.success")).toMatchObject({ status: "insufficient-data", predicted: null, samples: 0 });
		expect(onBody.breached).toEqual(offBody.breached);
		expect(onBody.breached).not.toContain("brief.p95");
	});
});
