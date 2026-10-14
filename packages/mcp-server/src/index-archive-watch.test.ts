/**
 * The archive-age read behind `/healthz.jobs.index`, the age gauge and the
 * `index.archive.age` objective (uplift-4 S2), plus the flag-off parity of the
 * health and SLO surfaces and the tune's default. Scratch directories only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX_ARCHIVE_AGE_METRIC, MetricRegistry, SubstrateInstruments } from "@substrate/observability";
import { createObservability } from "./observe.ts";
import { loadConfig } from "./config.ts";
import { IndexArchiveWatch, evaluateIndexArchiveSlo } from "./index-archive-watch.ts";
import { IndexStore } from "./index-store.ts";
import { Substrate } from "./service.ts";

const T0 = Date.parse("2026-10-14T12:00:00.000Z");
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "index-archive-watch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function snapshot(name: string, createdAt: string | null, kind = "index-archive"): void {
	mkdirSync(join(dir, name), { recursive: true });
	if (createdAt !== null) writeFileSync(join(dir, name, "manifest.json"), JSON.stringify({ kind, createdAt }));
}

describe("IndexArchiveWatch", () => {
	test("the newest snapshot with a manifest wins; one without is incomplete and does not count", async () => {
		snapshot("index-20261012T034500Z", "2026-10-12T03:45:00.000Z");
		snapshot("index-20261013T034500Z", "2026-10-13T03:45:00.000Z");
		snapshot("index-20261014T034500Z", null);
		const reading = await new IndexArchiveWatch(dir).read(T0);
		expect(reading.status).toEqual({ lastArchiveAt: "2026-10-13T03:45:00.000Z", snapshot: "index-20261013T034500Z", ageSeconds: 116_100 });
		expect(reading.reason).toBeNull();
	});

	test("a damaged newest manifest falls back to an older good one", async () => {
		snapshot("index-20261012T034500Z", "2026-10-12T03:45:00.000Z");
		mkdirSync(join(dir, "index-20261013T034500Z"));
		writeFileSync(join(dir, "index-20261013T034500Z", "manifest.json"), "{nope");
		snapshot("index-20261014T034500Z", "2026-10-14T03:45:00.000Z", "something-else");
		expect((await new IndexArchiveWatch(dir).read(T0)).status?.snapshot).toBe("index-20261012T034500Z");
	});

	test("an empty directory reads as no archive; an unreadable one as null with the error code only", async () => {
		expect((await new IndexArchiveWatch(dir).read(T0)).status).toEqual({ lastArchiveAt: null, snapshot: null, ageSeconds: null });
		const missing = await new IndexArchiveWatch(join(dir, "gone")).read(T0);
		expect(missing.status).toBeNull();
		expect(missing.reason).toBe("archive directory could not be read (ENOENT)");
		expect(missing.reason).not.toContain(dir);
	});

	test("one read serves every caller for the memo window, and the age is as of each call", async () => {
		snapshot("index-20261013T034500Z", "2026-10-13T03:45:00.000Z");
		const watch = new IndexArchiveWatch(dir, 60_000);
		const first = await watch.read(T0);
		rmSync(join(dir, "index-20261013T034500Z"), { recursive: true });
		const second = await watch.read(T0 + 30_000);
		expect(second.status?.lastArchiveAt).toBe(first.status?.lastArchiveAt ?? "");
		expect(second.status?.ageSeconds).toBe((first.status?.ageSeconds ?? 0) + 30);
		// Past the window it reads again and sees the directory is empty.
		expect((await watch.read(T0 + 61_000)).status?.lastArchiveAt).toBeNull();
	});

	test("concurrent callers share one read in flight", async () => {
		snapshot("index-20261013T034500Z", "2026-10-13T03:45:00.000Z");
		const watch = new IndexArchiveWatch(dir);
		const readings = await Promise.all([watch.read(T0), watch.read(T0), watch.read(T0)]);
		expect(new Set(readings.map((reading) => reading.status?.snapshot)).size).toBe(1);
	});
});

describe("evaluateIndexArchiveSlo", () => {
	const reading = (ageSeconds: number | null) => ({
		status: { lastArchiveAt: ageSeconds === null ? null : "2026-10-13T03:45:00.000Z", snapshot: ageSeconds === null ? null : "index-20261013T034500Z", ageSeconds },
		reason: null,
	});

	test("report-only while SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H is unset, whatever the age", () => {
		for (const age of [60, 40 * 3600, null]) {
			const row = evaluateIndexArchiveSlo(reading(age), null);
			expect(row.status).toBe("report-only");
			expect(row.target).toBeNull();
			expect(row.id).toBe("index.archive.age");
		}
		expect(evaluateIndexArchiveSlo({ status: null, reason: "x" }, null).status).toBe("report-only");
	});

	test("with a ceiling: ok at or under it, breached over it or with no archive, insufficient-data when unreadable", () => {
		expect(evaluateIndexArchiveSlo(reading(26 * 3600), 26)).toMatchObject({ status: "ok", observed: 26, target: 26 });
		expect(evaluateIndexArchiveSlo(reading(26 * 3600 + 1), 26).status).toBe("breached");
		expect(evaluateIndexArchiveSlo(reading(null), 26).status).toBe("breached");
		expect(evaluateIndexArchiveSlo({ status: null, reason: "archive directory could not be read (EIO)" }, 26)).toMatchObject({ status: "insufficient-data", detail: "archive directory could not be read (EIO)" });
	});
});

describe("flag-off parity", () => {
	test("without SUBSTRATE_INDEX_ARCHIVE_DIR /healthz.jobs carries exactly today's keys and /slo no indexArchive row", async () => {
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });
		const health = await substrate.health();
		expect(Object.keys(health.jobs).sort()).toEqual(["ledger", "ledgerReason"]);
		expect(await substrate.indexArchiveHealth()).toBeNull();
		expect(await substrate.indexArchiveSlo()).toBeNull();
	});

	test("with it set, jobs.index carries the newest archive and /slo's row judges it", async () => {
		snapshot("index-20261013T034500Z", new Date(Date.now() - 3600_000).toISOString());
		const substrate = new Substrate(loadConfig({ SUBSTRATE_INDEX_ARCHIVE_DIR: dir, SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H: "26" }), { index: null, greptime: null });
		const health = await substrate.health();
		expect(health.jobs.index).toMatchObject({ snapshot: "index-20261013T034500Z", reason: null });
		expect(health.jobs.index?.ageSeconds).toBeGreaterThanOrEqual(3600);
		expect((await substrate.indexArchiveSlo())?.status).toBe("ok");
	});

	test("the age gauge comes from the registry snapshot itself, not from a health or SLO poll: the first snapshot starts the read, a later one carries the age", async () => {
		snapshot("index-20261013T034500Z", new Date(Date.now() - 3600_000).toISOString());
		const observed = createObservability(loadConfig({ SUBSTRATE_INDEX_ARCHIVE_DIR: dir }));
		const substrate = new Substrate(loadConfig({ SUBSTRATE_INDEX_ARCHIVE_DIR: dir }), { index: null, greptime: null }, observed.observer);
		const age = () => observed.snapshot().find((metric) => metric.name === INDEX_ARCHIVE_AGE_METRIC);
		const ageValue = (): number => {
			const metric = age();
			return metric?.kind === "gauge" ? (metric.points[0]?.value ?? Number.NaN) : Number.NaN;
		};
		// The first snapshot has nothing to go on yet, and starts the background read.
		expect(age()).toMatchObject({ kind: "gauge", points: [] });
		// Joins that same read (one in flight, shared); it sets nothing on the gauge — the next snapshot computes it.
		await substrate.indexArchiveHealth();
		const first = ageValue();
		expect(first).toBeGreaterThanOrEqual(3600);
		expect(ageValue()).toBeGreaterThanOrEqual(first);
		observed.stop();
	});

	test("without SUBSTRATE_INDEX_ARCHIVE_DIR the observer is never offered an archive and the gauge never exists", () => {
		const offered: unknown[] = [];
		new Substrate(loadConfig({}), { index: null, greptime: null }, { indexArchive: (source) => offered.push(source) });
		expect(offered).toEqual([]);
		const observed = createObservability(loadConfig({}));
		new Substrate(loadConfig({}), { index: null, greptime: null }, observed.observer);
		expect(observed.snapshot().some((metric) => metric.name === INDEX_ARCHIVE_AGE_METRIC)).toBe(false);
		observed.stop();
	});

	test("the gauge has no point until there is an archive, then follows the clock at each snapshot; a source that throws reads as no point", () => {
		const instruments = new SubstrateInstruments(new MetricRegistry(T0));
		expect(instruments.snapshot().some((metric) => metric.name === INDEX_ARCHIVE_AGE_METRIC)).toBe(false);
		let newest: number | null = null;
		let clock = T0;
		instruments.observeIndexArchiveAge(() => newest, () => clock);
		const point = () => instruments.snapshot().find((metric) => metric.name === INDEX_ARCHIVE_AGE_METRIC);
		expect(point()).toMatchObject({ kind: "gauge", unit: "s", points: [] });
		newest = T0 - 3_600_000;
		expect(point()).toMatchObject({ points: [{ attributes: {}, value: 3600 }] });
		clock += 60_000;
		expect(point()).toMatchObject({ points: [{ value: 3660 }] });
		newest = clock + 5_000;
		expect(point()).toMatchObject({ points: [{ value: 0 }] });
		instruments.observeIndexArchiveAge(() => {
			throw new Error("mount gone");
		});
		expect(point()).toMatchObject({ points: [] });
	});

	test("peekCreatedAt answers synchronously from the last read, starts a refresh when stale, and keeps the last archive time through an unreadable directory", async () => {
		snapshot("index-20261013T034500Z", "2026-10-13T03:45:00.000Z");
		const watch = new IndexArchiveWatch(dir, 60_000);
		expect(watch.peekCreatedAt(T0)).toBeNull();
		await watch.read(T0);
		expect(watch.peekCreatedAt(T0 + 1000)).toBe(Date.parse("2026-10-13T03:45:00.000Z"));
		rmSync(dir, { recursive: true });
		// Stale: a refresh starts (and finds the directory gone) but the answer stays the last known time.
		expect(watch.peekCreatedAt(T0 + 61_000)).toBe(Date.parse("2026-10-13T03:45:00.000Z"));
		await watch.read(T0 + 61_000);
		expect(watch.peekCreatedAt(T0 + 62_000)).toBe(Date.parse("2026-10-13T03:45:00.000Z"));
	});
});

describe("the lease-table tune is off unless asked, and the DDL has exactly one home", () => {
	test("a store built without the option, or with the env unset, never tunes", () => {
		expect(new IndexStore("postgres://u@localhost/x").tune).toBe("off");
		expect(loadConfig({}).indexArchive.tune).toBe("off");
		expect(loadConfig({ SUBSTRATE_INDEX_TUNE: "off" }).indexArchive.tune).toBe("off");
		expect(loadConfig({ SUBSTRATE_INDEX_TUNE: "apply" }).indexArchive.tune).toBe("apply");
	});

	test("the alter is only in tuneGraphNodes, migrate() reaches it only under tune === apply, and no index is dropped by code", () => {
		const source = readFileSync(join(import.meta.dir, "index-store.ts"), "utf8");
		expect(source.match(/alter table graph_nodes set \(/g)?.length).toBe(1);
		const migrate = source.slice(source.indexOf("async migrate()"), source.indexOf("// ── graph ──"));
		expect(migrate).toContain('if (this.tune === "apply")');
		expect(migrate).not.toContain("alter table graph_nodes set");
		// The one pre-existing drop is the superseded reviews index; the tune adds none.
		expect([...source.matchAll(/drop index[^`]*/g)].map((match) => match[0].trim())).toEqual(["drop index if exists memory_reviews_hash_idx"]);
	});
});
