/**
 * Restart-durable SLO history over a real socket (uplift-3 N2): the harness is
 * started, fed, checkpointed, closed and started again on the same checkpoint
 * path, which is what a deploy does to the service.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

interface Harness {
	base: string;
	observability: Observability;
	warnings: string[];
	close(): Promise<void>;
}

const running: Harness[] = [];
const directories: string[] = [];

async function start(env: Record<string, string | undefined> = {}, stores: Partial<{ index: unknown }> = {}): Promise<Harness> {
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
		const current = samples[samples.length - 1]!.databaseBytes;
		expect(body.capacity[0]).toMatchObject({ status: "ok", samples: samples.length });
		expect(body.capacity[0]?.observed).toBeCloseTo((10 * 1024 * MB - current) / (100 * MB), 0);
		expect(body.breached).toEqual([]);

		const tight = await start({ SUBSTRATE_SLO_CHECKPOINT: path, SUBSTRATE_INDEX_VOLUME_BYTES: String(2300 * MB) });
		expect((await slo(tight)).capacity[0]?.status).toBe("breached");
	});
});
