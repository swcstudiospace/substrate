/**
 * uplift-4 S7: the docs freshness SLI, the merge-trigger lag and the lag
 * warning's dedupe. Pure logic with an injected clock, the state-file
 * round trip in a scratch directory, and the service's bookkeeping with a
 * spy on its event path — no network, no host file, no store.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { FakeStore } from "./corpus/testkit.ts";
import {
	DATASET_TRIGGER_RETENTION,
	TRIGGER_SCAN_MAX,
	createVersionStore,
	recordTrigger,
	recordVersion,
	type DatasetVersion,
	type TriggerStore,
	type VersionStore,
} from "./docs-datasets.ts";
import {
	CORPUS_FRESHNESS_DATASET,
	GAUGE_FRESHNESS_SECONDS,
	GAUGE_TRIGGER_LAG_SECONDS,
	applyLagActions,
	corpusFreshnessRow,
	LagSettler,
	createFreshnessState,
	evaluateFreshness,
	type DatasetFreshness,
	freshnessGauges,
	freshnessStateFromJson,
	freshnessStateToJson,
	lagRecoveryEvent,
	lagWarningEvent,
	planLagTransitions,
	type FreshnessSettings,
	type LagMarkers,
} from "./docs-freshness.ts";
import { DocsLagTimer } from "./docs-lag-timer.ts";
import { loadIngestRecords, saveIngestRecords } from "./docs-ingest.ts";
import { normalizeEvent } from "./event.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate, type EmitResult } from "./service.ts";
import type { EventInput } from "./types.ts";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const SETTINGS: FreshnessSettings = { maxAgeHours: 168, triggerLagMinutes: 15 };

function version(dataset: string, commit: string, agoMs: number, n = 1): DatasetVersion {
	return {
		dataset,
		dataset_id: `ds-${dataset}`,
		version: `v${n}`,
		commit,
		content_sha256: `sha-${commit}`,
		ingested_at: new Date(NOW - agoMs).toISOString(),
		backend: "ragflow",
	};
}

function store(...versions: DatasetVersion[]): VersionStore {
	const versionStore = createVersionStore();
	for (const entry of versions) recordVersion(versionStore, entry);
	return versionStore;
}

function triggers(entries: Array<[string, string, number]>): TriggerStore {
	const result: TriggerStore = new Map();
	for (const [dataset, commit, agoMs] of entries) {
		recordTrigger(result, dataset, { commit, content_sha256: `sha-${commit}`, received_at: new Date(NOW - agoMs).toISOString() });
	}
	return result;
}

describe("freshness math", () => {
	test("is now minus the newest ingested_at per dataset, over several datasets", () => {
		const rows = evaluateFreshness({
			versions: store(
				version("agent-substrate", "c1", 5 * HOUR, 1),
				version("agent-substrate", "c2", 2 * HOUR, 2),
				version("programming-desk", "d1", 200 * HOUR),
				version("kanbanos", "k1", 30 * MIN),
			),
			triggers: new Map(),
			now: NOW,
			settings: SETTINGS,
		});
		expect(rows.map((row) => [row.dataset, row.freshness_seconds, row.stale])).toEqual([
			["agent-substrate", 2 * 3600, false],
			["programming-desk", 200 * 3600, true],
			["kanbanos", 1800, false],
		]);
	});

	test("the newest by timestamp wins even when it is not the last row", () => {
		const rows = evaluateFreshness({
			versions: store(version("agent-substrate", "c1", HOUR, 1), version("agent-substrate", "c2", 9 * HOUR, 2)),
			triggers: new Map(),
			now: NOW,
			settings: SETTINGS,
		});
		expect(rows[0]?.freshness_seconds).toBe(3600);
	});

	test("a dataset with no data is omitted, a name outside the trigger table never appears, a future stamp reads 0, max age 0 never judges", () => {
		const versions = store(version("not-a-dataset", "x", HOUR), version("agent-substrate", "c1", -10 * MIN));
		const rows = evaluateFreshness({ versions, triggers: new Map(), now: NOW, settings: { maxAgeHours: 0, triggerLagMinutes: 15 } });
		expect(rows.map((row) => row.dataset)).toEqual(["agent-substrate"]);
		expect(rows[0]?.freshness_seconds).toBe(0);
		const old = evaluateFreshness({ versions: store(version("agent-substrate", "c1", 9999 * HOUR)), triggers: new Map(), now: NOW, settings: { maxAgeHours: 0, triggerLagMinutes: 15 } });
		expect(old[0]?.stale).toBe(false);
	});
});

describe("trigger lag", () => {
	test("an accepted trigger with no recorded version lags once it has waited the threshold, per dataset", () => {
		const rows = evaluateFreshness({
			versions: store(version("agent-substrate", "c0", HOUR), version("kanbanos", "k0", HOUR)),
			triggers: triggers([
				["agent-substrate", "c1", 20 * MIN],
				["kanbanos", "k1", 5 * MIN],
			]),
			now: NOW,
			settings: SETTINGS,
		});
		const byName = Object.fromEntries(rows.map((row) => [row.dataset, row]));
		expect(byName["agent-substrate"]).toMatchObject({ lagging: true, trigger_lag_seconds: 1200, lagging_commit: "c1" });
		// Waiting, not yet lagging.
		expect(byName.kanbanos).toMatchObject({ lagging: false, trigger_lag_seconds: 300, lagging_commit: "k1" });
	});

	test("a recorded version for the commit clears it", () => {
		const rows = evaluateFreshness({
			versions: store(version("agent-substrate", "c1", 10 * MIN)),
			triggers: triggers([["agent-substrate", "c1", 20 * MIN]]),
			now: NOW,
			settings: SETTINGS,
		});
		expect(rows[0]).toMatchObject({ lagging: false, trigger_lag_seconds: 0, lagging_commit: null });
	});

	test("the newest trigger is the one judged: a later landed commit supersedes an older unresolved one", () => {
		const rows = evaluateFreshness({
			versions: store(version("agent-substrate", "c2", 10 * MIN)),
			triggers: triggers([
				["agent-substrate", "c1", 60 * MIN],
				["agent-substrate", "c2", 30 * MIN],
			]),
			now: NOW,
			settings: SETTINGS,
		});
		expect(rows[0]?.lagging).toBe(false);
	});

	test("a trigger the version history has rolled past is not reported", () => {
		const many = Array.from({ length: 5 }, (_, i) => version("agent-substrate", `n${i}`, (30 - i) * MIN, i + 1));
		const rows = evaluateFreshness({ versions: store(...many), triggers: triggers([["agent-substrate", "gone", 90 * MIN]]), now: NOW, settings: SETTINGS });
		expect(rows[0]).toMatchObject({ lagging: false, trigger_lag_seconds: 0 });
	});

	test("lag minutes 0 detects nothing", () => {
		const rows = evaluateFreshness({
			versions: store(version("agent-substrate", "c0", HOUR)),
			triggers: triggers([["agent-substrate", "c1", 600 * MIN]]),
			now: NOW,
			settings: { maxAgeHours: 168, triggerLagMinutes: 0 },
		});
		expect(rows[0]?.lagging).toBe(false);
	});

	test("a retry of the same identity keeps its first received_at", () => {
		const held: TriggerStore = new Map();
		recordTrigger(held, "agent-substrate", { commit: "c1", content_sha256: "s", received_at: "2026-10-14T10:00:00.000Z" });
		const list = recordTrigger(held, "agent-substrate", { commit: "c1", content_sha256: "s", received_at: "2026-10-14T11:59:00.000Z" });
		expect(list).toEqual([{ commit: "c1", content_sha256: "s", received_at: "2026-10-14T10:00:00.000Z" }]);
	});
});

describe("the gauges", () => {
	test("carry only the dataset label, with freshness for data and lag for triggered datasets", () => {
		const rows = evaluateFreshness({
			versions: store(version("agent-substrate", "c0", HOUR)),
			triggers: triggers([["agent-substrate", "c1", 20 * MIN]]),
			now: NOW,
			settings: SETTINGS,
		});
		const samples = freshnessGauges(rows);
		expect(samples.map((sample) => [sample.name, sample.attributes, sample.value])).toEqual([
			[GAUGE_FRESHNESS_SECONDS, { dataset: "agent-substrate" }, 3600],
			[GAUGE_TRIGGER_LAG_SECONDS, { dataset: "agent-substrate" }, 1200],
		]);
		expect(freshnessGauges([])).toEqual([]);
	});
});

describe("the lag warning's dedupe", () => {
	function harness() {
		const events: EventInput[] = [];
		const markers: LagMarkers = new Map();
		let failEmit = false;
		let persisted = 0;
		const effects = {
			persist: async () => {
				persisted += 1;
			},
			emit: async (event: EventInput) => {
				if (failEmit) throw new Error("ledger down");
				events.push(event);
			},
			report: () => undefined,
		};
		const tick = async (versions: VersionStore, trig: TriggerStore, now: number) => {
			const rows = evaluateFreshness({ versions, triggers: trig, now, settings: SETTINGS });
			return applyLagActions(planLagTransitions(rows, markers), markers, SETTINGS, new Date(now).toISOString(), effects);
		};
		return { events, markers, tick, fail: (value: boolean) => (failEmit = value), persisted: () => persisted };
	}

	test("one warning on the breach, none while it lasts, one recovery note when it clears", async () => {
		const h = harness();
		const trig = triggers([["agent-substrate", "c1", 20 * MIN]]);
		const waiting = store(version("agent-substrate", "c0", HOUR));
		await h.tick(waiting, trig, NOW);
		await h.tick(waiting, trig, NOW + 5 * MIN);
		await h.tick(waiting, trig, NOW + 60 * MIN);
		expect(h.events.map((event) => event.kind)).toEqual(["warning"]);
		expect(h.events[0]?.payload).toMatchObject({ action: "docs.freshness", runtime: "docs-freshness", state: "lagging", dataset: "agent-substrate", commit: "c1" });
		expect(h.markers.get("agent-substrate")).toMatchObject({ commit: "c1", warned: true });

		const landed = store(version("agent-substrate", "c1", 0, 2));
		await h.tick(landed, trig, NOW + 61 * MIN);
		await h.tick(landed, trig, NOW + 70 * MIN);
		expect(h.events.map((event) => event.kind)).toEqual(["warning", "note"]);
		expect(h.events[1]?.payload).toMatchObject({ state: "recovered", dataset: "agent-substrate" });
		expect(h.markers.size).toBe(0);

		// A second breach later is a new transition: one more warning.
		await h.tick(waiting, triggers([["agent-substrate", "c9", 30 * MIN]]), NOW + 200 * MIN);
		expect(h.events.map((event) => event.kind)).toEqual(["warning", "note", "warning"]);
	});

	test("the marker is persisted before the emit, and a failed emit is retried next evaluation without being lost", async () => {
		const h = harness();
		const trig = triggers([["agent-substrate", "c1", 20 * MIN]]);
		const waiting = store(version("agent-substrate", "c0", HOUR));
		h.fail(true);
		await h.tick(waiting, trig, NOW);
		expect(h.events).toEqual([]);
		expect(h.markers.get("agent-substrate")).toMatchObject({ warned: false });
		expect(h.persisted()).toBeGreaterThanOrEqual(1);
		h.fail(false);
		await h.tick(waiting, trig, NOW + MIN);
		await h.tick(waiting, trig, NOW + 2 * MIN);
		expect(h.events.map((event) => event.kind)).toEqual(["warning"]);
		expect(h.markers.get("agent-substrate")).toMatchObject({ warned: true });
	});

	test("a breach that was never announced clears silently; a lost recovery note is retried", async () => {
		const h = harness();
		const trig = triggers([["agent-substrate", "c1", 20 * MIN]]);
		const waiting = store(version("agent-substrate", "c0", HOUR));
		const landed = store(version("agent-substrate", "c1", 0, 2));
		h.fail(true);
		await h.tick(waiting, trig, NOW);
		await h.tick(landed, trig, NOW + MIN);
		expect(h.events).toEqual([]);
		expect(h.markers.size).toBe(0);

		h.fail(false);
		await h.tick(waiting, trig, NOW + 2 * MIN);
		h.fail(true);
		await h.tick(landed, trig, NOW + 3 * MIN);
		expect(h.markers.size).toBe(1);
		h.fail(false);
		await h.tick(landed, trig, NOW + 4 * MIN);
		expect(h.events.map((event) => event.kind)).toEqual(["warning", "note"]);
		expect(h.markers.size).toBe(0);
	});

	test("both events pass the real write-path gate, bounded whatever the commit was", () => {
		const long = "c".repeat(200);
		const warning = lagWarningEvent({ type: "breach", dataset: "agent-substrate", commit: long, lagSeconds: 1200 }, SETTINGS);
		const note = lagRecoveryEvent({ type: "recover", dataset: "agent-substrate", commit: long, warned: true }, SETTINGS);
		for (const event of [warning, note]) {
			const stored = normalizeEvent(event, null);
			expect(stored.surface).toBe("substrate");
			expect((event.summary ?? "").length).toBeLessThan(120);
			expect(String(event.payload?.commit).length).toBe(64);
			expect(stored.kind).toBe(event.kind);
		}
		expect(warning.kind).toBe("warning");
		expect(note.kind).toBe("note");
	});
});

describe("the state file members", () => {
	test("an old state file without them loads exactly as before", () => {
		const state = freshnessStateFromJson({ version: 2, records: {}, versions: {} });
		expect(state.triggers.size).toBe(0);
		expect(state.lag.size).toBe(0);
		expect(freshnessStateToJson(state)).toEqual({});
	});

	test("10k bogus trigger rows are truncated while reading: the newest 20 valid rows survive, nothing earlier is touched", () => {
		const rows: unknown[] = [];
		rows.push({ commit: "ancient", content_sha256: "s", received_at: "2020-01-01T00:00:00.000Z" });
		for (let i = 0; i < 10_000; i += 1) rows.push(i % 2 === 0 ? { nope: i } : { commit: `bogus-${i}`, content_sha256: "s", received_at: "not a date" });
		for (let i = 0; i < 30; i += 1) rows.push({ commit: `good-${i}`, content_sha256: "s", received_at: new Date(NOW + i * 1000).toISOString(), extra: { deep: [1, 2, 3] } });
		let reads = 0;
		const watched = new Proxy(rows, {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
				return Reflect.get(target, key, receiver);
			},
		});
		const state = freshnessStateFromJson({ triggers: { "agent-substrate": watched } });
		const kept = state.triggers.get("agent-substrate") ?? [];
		expect(kept).toHaveLength(DATASET_TRIGGER_RETENTION);
		expect(kept[0]?.commit).toBe("good-10");
		expect(kept[kept.length - 1]?.commit).toBe("good-29");
		expect(kept.every((row) => Object.keys(row).sort().join() === "commit,content_sha256,received_at")).toBe(true);
		// The scan stops at the cap: never the 10k rows, never the first.
		expect(reads).toBeLessThanOrEqual(TRIGGER_SCAN_MAX);
	});

	test("unknown datasets, inherited names, oversized fields and malformed markers are ignored, never thrown on", () => {
		const parsed: unknown = JSON.parse(
			JSON.stringify({
				triggers: {
					"agent-substrate": [{ commit: "x".repeat(5000), content_sha256: "s", received_at: "2026-10-14T00:00:00.000Z" }, { commit: "ok", content_sha256: "s", received_at: "2026-10-14T00:00:00.000Z" }],
					constructor: [{ commit: "c", content_sha256: "s", received_at: "2026-10-14T00:00:00.000Z" }],
					"not-a-dataset": [{ commit: "c", content_sha256: "s", received_at: "2026-10-14T00:00:00.000Z" }],
					kanbanos: "nope",
				},
				lag: {
					"agent-substrate": { since: "2026-10-14T00:00:00.000Z", commit: "ok", warned: true },
					kanbanos: { since: "garbage", commit: "c", warned: true },
					desklanes: { since: "2026-10-14T00:00:00.000Z", commit: "c", warned: "yes" },
					toString: { since: "2026-10-14T00:00:00.000Z", commit: "c", warned: true },
				},
			}),
		);
		const state = freshnessStateFromJson(parsed);
		expect([...state.triggers.keys()]).toEqual(["agent-substrate"]);
		expect(state.triggers.get("agent-substrate")?.map((row) => row.commit)).toEqual(["ok"]);
		expect([...state.lag.keys()]).toEqual(["agent-substrate"]);
		expect(freshnessStateFromJson("string").triggers.size).toBe(0);
		expect(freshnessStateFromJson({ triggers: [], lag: [] }).lag.size).toBe(0);
	});

	test("flag-off parity: a state file with nothing triggered carries exactly today's keys, and triggers add only their own", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-freshness-"));
		try {
			const file = join(dir, "state.json");
			const versions = store(version("agent-substrate", "c1", HOUR));
			await saveIngestRecords(file, new Map(), versions, createFreshnessState());
			expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as object)).toEqual(["version", "records", "versions"]);
			await saveIngestRecords(file, new Map(), versions);
			expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as object)).toEqual(["version", "records", "versions"]);

			const state = createFreshnessState();
			recordTrigger(state.triggers, "agent-substrate", { commit: "c2", content_sha256: "s", received_at: new Date(NOW).toISOString() });
			state.lag.set("agent-substrate", { since: new Date(NOW).toISOString(), commit: "c2", warned: false });
			await saveIngestRecords(file, new Map(), versions, state);
			expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as object)).toEqual(["version", "records", "versions", "triggers", "lag"]);
			const loaded = await loadIngestRecords(file);
			expect(loaded.freshness.triggers.get("agent-substrate")).toHaveLength(1);
			expect(loaded.freshness.lag.get("agent-substrate")).toMatchObject({ commit: "c2", warned: false });
			expect(loaded.versions.get("agent-substrate")?.[0]?.commit).toBe("c1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the service bookkeeping", () => {
	function spy(substrate: Substrate): EventInput[] {
		const events: EventInput[] = [];
		spyOn(substrate, "emit").mockImplementation(async (event) => {
			events.push(event);
			return { event: normalizeEvent(event, null), stored: true };
		});
		return events;
	}
	const request = (commit: string) => ({ dataset: "agent-substrate", commit, content_sha256: `sha-${commit}`, pages: async () => [] });

	test("an accepted trigger is persisted before its job; with no version it lags, warns once, and a restart does not repeat it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-freshness-"));
		try {
			const file = join(dir, "state.json");
			const env = { SUBSTRATE_DOCS_STATE_FILE: file };
			const first = new Substrate(loadConfig(env), { index: null, greptime: null });
			const events = spy(first);
			// No docs plane is configured, so the job fails: exactly the trigger that never became an ingest.
			const outcome = await first.startDocsRefresh(request("c-lost"), "omp", { wait: true });
			expect(outcome.status).toBe(503);
			const saved = JSON.parse(readFileSync(file, "utf8")) as { triggers: Record<string, Array<{ commit: string }>> };
			expect(saved.triggers["agent-substrate"]?.map((row) => row.commit)).toEqual(["c-lost"]);

			const early = await first.evaluateDocsFreshness(Date.now() + 5 * MIN);
			expect(early[0]).toMatchObject({ dataset: "agent-substrate", lagging: false });
			const late = Date.now() + 30 * MIN;
			expect((await first.evaluateDocsFreshness(late))[0]).toMatchObject({ lagging: true, lagging_commit: "c-lost" });
			// A read only reports the verdict: nothing is emitted and no marker is written.
			await first.docsLagIdle();
			expect(events).toEqual([]);
			expect(JSON.parse(readFileSync(file, "utf8")).lag).toBeUndefined();
			// The timer's pass settles it: one warning, however many passes the breach lasts.
			await first.settleDocsLag(late);
			await first.docsLagIdle();
			await first.settleDocsLag(late + MIN);
			await first.docsLagIdle();
			expect(events.map((event) => event.kind)).toEqual(["warning"]);

			// A restarted process reads the marker back and stays quiet while the breach lasts.
			const second = new Substrate(loadConfig(env), { index: null, greptime: null });
			const restarted = spy(second);
			await second.settleDocsLag(late + 2 * MIN);
			await second.docsLagIdle();
			expect(restarted).toEqual([]);

			// The version lands (written the way an ingest persists it): one recovery note, then silence.
			const state = await loadIngestRecords(file);
			recordVersion(state.versions, version("agent-substrate", "c-lost", 0, 1));
			await saveIngestRecords(file, new Map(), state.versions, state.freshness);
			const third = new Substrate(loadConfig(env), { index: null, greptime: null });
			const recovered = spy(third);
			await third.settleDocsLag(late + 3 * MIN);
			await third.docsLagIdle();
			await third.settleDocsLag(late + 4 * MIN);
			await third.docsLagIdle();
			expect(recovered.map((event) => event.kind)).toEqual(["note"]);
			expect(JSON.parse(readFileSync(file, "utf8")).lag).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a failing event path or an unwritable state file never fails the trigger", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-freshness-"));
		try {
			const blocked = join(dir, "blocked");
			writeFileSync(blocked, "a file where a directory is needed");
			const substrate = new Substrate(loadConfig({ SUBSTRATE_DOCS_STATE_FILE: join(blocked, "state.json") }), { index: null, greptime: null });
			spyOn(substrate, "emit").mockImplementation(async () => {
				throw new Error("ledger down");
			});
			const outcome = await substrate.startDocsRefresh(request("c1"), "omp", { wait: true });
			expect(outcome.status).toBe(503);
			await expect(substrate.evaluateDocsFreshness(Date.now() + HOUR)).resolves.toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("SUBSTRATE_DOCS_TRIGGER_LAG_MIN=0 records nothing and writes no state file; an oversized commit is not recorded", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-freshness-"));
		try {
			const off = join(dir, "off.json");
			const disabled = new Substrate(loadConfig({ SUBSTRATE_DOCS_STATE_FILE: off, SUBSTRATE_DOCS_TRIGGER_LAG_MIN: "0" }), { index: null, greptime: null });
			await disabled.startDocsRefresh(request("c1"), "omp", { wait: true });
			expect(await Bun.file(off).exists()).toBe(false);
			expect(await disabled.evaluateDocsFreshness(Date.now() + HOUR)).toEqual([]);

			const on = join(dir, "on.json");
			const big = new Substrate(loadConfig({ SUBSTRATE_DOCS_STATE_FILE: on }), { index: null, greptime: null });
			await big.startDocsRefresh(request("x".repeat(5000)), "omp", { wait: true });
			expect(await Bun.file(on).exists()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the settings default to 168 h, 15 min and a 60 s lag check, take overrides, and fall back on garbage", () => {
		expect(loadConfig({}).docsFreshness).toEqual({ maxAgeHours: 168, triggerLagMinutes: 15, lagCheckS: 60 });
		expect(loadConfig({ SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H: "24", SUBSTRATE_DOCS_TRIGGER_LAG_MIN: "5" }).docsFreshness).toEqual({ maxAgeHours: 24, triggerLagMinutes: 5, lagCheckS: 60 });
		expect(loadConfig({ SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H: "soon", SUBSTRATE_DOCS_TRIGGER_LAG_MIN: "" }).docsFreshness).toEqual({ maxAgeHours: 168, triggerLagMinutes: 15, lagCheckS: 60 });
	});

	test("SUBSTRATE_DOCS_LAG_CHECK_S is bounded to 15..3600 and falls back to 60 on garbage", () => {
		const check = (raw: string | undefined) => loadConfig(raw === undefined ? {} : { SUBSTRATE_DOCS_LAG_CHECK_S: raw }).docsFreshness.lagCheckS;
		expect(check("120")).toBe(120);
		expect(check("1")).toBe(15);
		expect(check("0")).toBe(15);
		expect(check("99999")).toBe(3600);
		expect(check("soon")).toBe(60);
		expect(check("")).toBe(60);
		expect(check(undefined)).toBe(60);
	});

	test("a timer pass with SUBSTRATE_DOCS_TRIGGER_LAG_MIN=0 and no marker emits nothing and writes no state file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-freshness-"));
		try {
			const file = join(dir, "off.json");
			const substrate = new Substrate(loadConfig({ SUBSTRATE_DOCS_STATE_FILE: file, SUBSTRATE_DOCS_TRIGGER_LAG_MIN: "0" }), { index: null, greptime: null });
			const events = spy(substrate);
			await substrate.settleDocsLag(Date.now() + HOUR);
			await substrate.docsLagIdle();
			expect(events).toEqual([]);
			expect(await Bun.file(file).exists()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the timer pass emits once per breach transition, however many ticks the breach lasts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-freshness-"));
		try {
			const file = join(dir, "state.json");
			const state = createFreshnessState();
			recordTrigger(state.triggers, "agent-substrate", { commit: "c-lost", content_sha256: "s", received_at: new Date(Date.now() - 40 * MIN).toISOString() });
			await saveIngestRecords(file, new Map(), createVersionStore(), state);
			const substrate = new Substrate(loadConfig({ SUBSTRATE_DOCS_STATE_FILE: file }), { index: null, greptime: null });
			const events = spy(substrate);
			let tick: () => void = () => undefined;
			const timer = new DocsLagTimer({
				settle: () => substrate.settleDocsLag(),
				idle: () => substrate.docsLagIdle(),
				intervalS: 60,
				timers: { setInterval: (handler) => { tick = handler; return { unref: () => undefined }; }, clearInterval: () => undefined },
			});
			timer.start();
			await timer.flush();
			tick();
			await timer.flush();
			tick();
			await timer.flush();
			expect(events.map((event) => event.kind)).toEqual(["warning"]);
			timer.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("GET /slo and GET /metrics", () => {
	async function serveWith(env: Record<string, string>) {
		const config = loadConfig(env);
		const observability = createObservability(config, env);
		await observability.start();
		const substrate = new Substrate(config, { index: null, greptime: null }, observability.observer);
		const events: EventInput[] = [];
		spyOn(substrate, "emit").mockImplementation(async (event) => {
			events.push(event);
			return { event: normalizeEvent(event, null), stored: true };
		});
		// The state file is loaded the way the timer's first pass loads it; the routes never wait on it.
		await substrate.latestDocsVersion("agent-substrate");
		const server = createHttpServer(substrate, config, observability);
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		return {
			events,
			substrate,
			get: async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`)).json(),
			stop: () => {
				const closed = Promise.withResolvers<void>();
				observability.stop();
				server.close(() => closed.resolve());
				return closed.promise;
			},
		};
	}

	test("the docs.freshness row and the gauges appear only once a dataset has data, and never join `breached`", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-freshness-"));
		try {
			const empty = await serveWith({ SUBSTRATE_DOCS_STATE_FILE: join(dir, "empty.json") });
			try {
				const slo = (await empty.get("/slo")) as { docs: Array<{ id: string }> };
				expect(slo.docs.map((row) => row.id)).toEqual(["docs.search.p95"]);
				expect(Object.hasOwn((await empty.get("/metrics")) as object, "gauges")).toBe(false);
			} finally {
				await empty.stop();
			}

			const file = join(dir, "state.json");
			const state = createFreshnessState();
			const received = new Date(Date.now() - 40 * MIN).toISOString();
			recordTrigger(state.triggers, "agent-substrate", { commit: "c-lost", content_sha256: "s", received_at: received });
			const ingested = { ...version("agent-substrate", "c-old", 0), ingested_at: new Date(Date.now() - 2 * HOUR).toISOString() };
			await saveIngestRecords(file, new Map(), store(ingested), state);
			const served = await serveWith({ SUBSTRATE_DOCS_STATE_FILE: file });
			try {
				const slo = (await served.get("/slo")) as { docs: Array<{ id: string; status: string; datasets: Array<{ dataset: string; lagging: boolean }> }>; breached: string[] };
				const row = slo.docs.find((entry) => entry.id === "docs.freshness");
				expect(row?.status).toBe("breached");
				expect(row?.datasets).toMatchObject([{ dataset: "agent-substrate", lagging: true }]);
				expect(slo.breached).not.toContain("docs.freshness");
				const metrics = (await served.get("/metrics")) as { gauges: Array<{ name: string; attributes: { dataset: string }; value: number }> };
				expect(metrics.gauges.map((gauge) => [gauge.name, gauge.attributes.dataset])).toEqual([
					[GAUGE_FRESHNESS_SECONDS, "agent-substrate"],
					[GAUGE_TRIGGER_LAG_SECONDS, "agent-substrate"],
				]);
			} finally {
				await served.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a read emits nothing and writes no state file; only the timer pass settles the lag", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-freshness-"));
		try {
			const file = join(dir, "state.json");
			const state = createFreshnessState();
			recordTrigger(state.triggers, "agent-substrate", { commit: "c-lost", content_sha256: "s", received_at: new Date(Date.now() - 40 * MIN).toISOString() });
			await saveIngestRecords(file, new Map(), store(version("agent-substrate", "c-old", 2 * HOUR)), state);
			const before = readFileSync(file, "utf8");
			const served = await serveWith({ SUBSTRATE_DOCS_STATE_FILE: file });
			try {
				const slo = (await served.get("/slo")) as { docs: Array<{ id: string; datasets: Array<{ lagging: boolean }> }> };
				expect(slo.docs.find((row) => row.id === "docs.freshness")?.datasets).toMatchObject([{ lagging: true }]);
				await served.get("/metrics");
				await served.get("/slo");
				await served.substrate.docsLagIdle();
				expect(served.events).toEqual([]);
				expect(readFileSync(file, "utf8")).toBe(before);

				await served.substrate.settleDocsLag();
				await served.substrate.docsLagIdle();
				await served.get("/slo");
				await served.substrate.settleDocsLag();
				await served.substrate.docsLagIdle();
				expect(served.events.map((event) => event.kind)).toEqual(["warning"]);
				expect(JSON.parse(readFileSync(file, "utf8")).lag).toBeDefined();
			} finally {
				await served.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the lag timer", () => {
	function rig() {
		const calls = { setInterval: [] as number[], cleared: 0, unref: 0, settle: 0, idle: 0 };
		let tick: () => void = () => undefined;
		const gate = { held: null as Promise<void> | null };
		const timer = new DocsLagTimer({
			settle: () => {
				calls.settle += 1;
				return gate.held ?? Promise.resolve();
			},
			idle: async () => {
				calls.idle += 1;
			},
			intervalS: 90,
			timers: {
				setInterval: (handler, ms) => {
					calls.setInterval.push(ms);
					tick = handler;
					return {
						unref: () => {
							calls.unref += 1;
						},
					};
				},
				clearInterval: () => {
					calls.cleared += 1;
				},
			},
		});
		return { timer, calls, tick: () => tick(), gate };
	}

	test("start schedules one unref'd interval of the configured seconds and runs a pass at once", () => {
		const { timer, calls } = rig();
		expect(timer.start()).toBe(true);
		expect(timer.start()).toBe(true);
		expect(calls.setInterval).toEqual([90_000]);
		expect(calls.unref).toBe(1);
		expect(calls.settle).toBe(1);
	});

	test("a tick while a pass is in flight starts nothing; after it ends the next tick runs", async () => {
		const { timer, calls, tick, gate } = rig();
		const held = Promise.withResolvers<void>();
		gate.held = held.promise;
		timer.start();
		tick();
		tick();
		expect(calls.settle).toBe(1);
		held.resolve();
		await timer.flush();
		gate.held = null;
		tick();
		expect(calls.settle).toBe(2);
	});

	test("stop clears the interval once, and flush waits for the pass and the settle behind it", async () => {
		const { timer, calls, gate } = rig();
		const held = Promise.withResolvers<void>();
		gate.held = held.promise;
		timer.start();
		timer.stop();
		timer.stop();
		expect(calls.cleared).toBe(1);
		let flushed = false;
		const flushing = timer.flush().then(() => {
			flushed = true;
		});
		await Promise.resolve();
		expect(flushed).toBe(false);
		held.resolve();
		await flushing;
		expect(calls.idle).toBe(1);
	});
});

describe("a trigger is landed only by a version with its commit AND its content hash", () => {
	test("a re-trigger of one commit under a different hash still lags until that identity is recorded", () => {
		const held: TriggerStore = new Map();
		recordTrigger(held, "agent-substrate", { commit: "c1", content_sha256: "sha-other", received_at: new Date(NOW - 20 * MIN).toISOString() });
		const lagging = evaluateFreshness({ versions: store(version("agent-substrate", "c1", HOUR)), triggers: held, now: NOW, settings: SETTINGS });
		expect(lagging[0]).toMatchObject({ lagging: true, lagging_commit: "c1", trigger_lag_seconds: 1200 });
		const landed = evaluateFreshness({ versions: store({ ...version("agent-substrate", "c1", 5 * MIN), content_sha256: "sha-other" }), triggers: held, now: NOW, settings: SETTINGS });
		expect(landed[0]).toMatchObject({ lagging: false, trigger_lag_seconds: 0 });
	});
});

describe("the background settler", () => {
	const breach = () =>
		evaluateFreshness({ versions: store(version("agent-substrate", "c0", HOUR)), triggers: triggers([["agent-substrate", "c1", 20 * MIN]]), now: NOW, settings: SETTINGS });

	function rig(options: { retryMs?: number; emitDeadlineMs?: number; emit?: (event: EventInput) => Promise<unknown> } = {}) {
		const markers: LagMarkers = new Map();
		const emitted: EventInput[] = [];
		const lines: string[] = [];
		let persists = 0;
		let emitCalls = 0;
		const started = Promise.withResolvers<void>();
		let emit = options.emit;
		const settler = new LagSettler(
			markers,
			{
				persist: async () => {
					persists += 1;
				},
				emit: async (event) => {
					emitCalls += 1;
					started.resolve();
					if (emit !== undefined) return emit(event);
					emitted.push(event);
					return undefined;
				},
				report: (line) => lines.push(line),
			},
			{ retryMs: options.retryMs ?? 60_000, emitDeadlineMs: options.emitDeadlineMs ?? 5_000 },
		);
		return { settler, markers, emitted, lines, started: started.promise, calls: () => emitCalls, persists: () => persists, setEmit: (next: ((event: EventInput) => Promise<unknown>) | undefined) => (emit = next) };
	}

	test("settle returns at once and concurrent reads start exactly one pass", async () => {
		const gate = Promise.withResolvers<void>();
		const r = rig({ emit: async () => gate.promise });
		const rows = breach();
		expect(r.settler.settle(rows, SETTINGS, NOW)).toBe(true);
		// The pass is still held by the ledger: the caller is not.
		expect(r.settler.settle(rows, SETTINGS, NOW)).toBe(false);
		expect(r.settler.settle(rows, SETTINGS, NOW + 1)).toBe(false);
		// The pass persists its marker before it emits: wait for the emit to begin, then count.
		await r.started;
		expect(r.calls()).toBe(1);
		gate.resolve();
		await r.settler.flight;
		expect(r.calls()).toBe(1);
		expect(r.markers.get("agent-substrate")).toMatchObject({ warned: true });
		expect(r.settler.flight).toBeNull();
	});

	test("a failed emit is not retried (nor the marker rewritten) before the retry interval, then is", async () => {
		const r = rig({
			emit: async () => {
				throw new Error("ledger down");
			},
		});
		const rows = breach();
		expect(r.settler.settle(rows, SETTINGS, NOW)).toBe(true);
		await r.settler.flight;
		const persistsAfterFailure = r.persists();
		expect(r.calls()).toBe(1);
		expect(r.markers.get("agent-substrate")).toMatchObject({ warned: false });
		expect(r.lines).toHaveLength(1);

		for (const offset of [1, 30_000, 59_999]) expect(r.settler.settle(rows, SETTINGS, NOW + offset)).toBe(false);
		expect(r.calls()).toBe(1);
		expect(r.persists()).toBe(persistsAfterFailure);
		expect(r.lines).toHaveLength(1);

		r.setEmit(undefined);
		expect(r.settler.settle(rows, SETTINGS, NOW + 60_000)).toBe(true);
		await r.settler.flight;
		expect(r.emitted.map((event) => event.kind)).toEqual(["warning"]);
		expect(r.markers.get("agent-substrate")).toMatchObject({ warned: true });
	});

	test("an emit that never answers is cut off by the deadline, counts as a failure and frees the settler", async () => {
		const r = rig({ emitDeadlineMs: 20, emit: () => new Promise(() => undefined) });
		expect(r.settler.settle(breach(), SETTINGS, NOW)).toBe(true);
		const outcome = await Promise.race([r.settler.flight, Bun.sleep(2000).then(() => "pinned")]);
		expect(outcome).toBeUndefined();
		expect(r.settler.flight).toBeNull();
		expect(r.markers.get("agent-substrate")).toMatchObject({ warned: false });
		expect(r.lines).toHaveLength(1);
		// Inside the interval nothing starts; after it the pass runs again.
		expect(r.settler.settle(breach(), SETTINGS, NOW + 10_000)).toBe(false);
		expect(r.settler.settle(breach(), SETTINGS, NOW + 60_000)).toBe(true);
		await r.settler.flight;
	});

	test("a slow ledger never delays the timer pass or GET /slo: both answer while the warning is still hung", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-freshness-"));
		try {
			const substrate = new Substrate(loadConfig({ SUBSTRATE_DOCS_STATE_FILE: join(dir, "state.json") }), { index: null, greptime: null });
			let emitCalls = 0;
			const started = Promise.withResolvers<void>();
			spyOn(substrate, "emit").mockImplementation(() => {
				emitCalls += 1;
				started.resolve();
				return new Promise<EmitResult>(() => undefined);
			});
			await substrate.startDocsRefresh({ dataset: "agent-substrate", commit: "c-lost", content_sha256: "sha-c-lost", pages: async () => [] }, "omp", { wait: true });
			const late = Date.now() + 30 * MIN;
			const settled = await Promise.race([substrate.settleDocsLag(late).then(() => "settled" as const), Bun.sleep(1500).then(() => "blocked" as const)]);
			expect(settled).toBe("settled");
			const answered = await Promise.race([substrate.evaluateDocsFreshness(late), Bun.sleep(1500).then(() => "blocked" as const)]);
			expect(answered).not.toBe("blocked");
			expect(answered).toMatchObject([{ dataset: "agent-substrate", lagging: true }]);
			// The pass persists its marker before it emits: wait for the emit to begin, then pass again while it hangs.
			await started.promise;
			await substrate.settleDocsLag(late + 1);
			await substrate.settleDocsLag(late + 2);
			expect(emitCalls).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("a resolved stored:false emit is a failed delivery", () => {
	const lagging = (): DatasetFreshness[] =>
		evaluateFreshness({ versions: store(version("agent-substrate", "c0", HOUR)), triggers: triggers([["agent-substrate", "c1", 20 * MIN]]), now: NOW, settings: SETTINGS });
	const landed = (): DatasetFreshness[] =>
		evaluateFreshness({ versions: store(version("agent-substrate", "c1", 0, 2)), triggers: triggers([["agent-substrate", "c1", 20 * MIN]]), now: NOW, settings: SETTINGS });

	function effects(storedFlag: { value: boolean }, sent: EventInput[], lines: string[]) {
		return {
			persist: async () => undefined,
			emit: async (event: EventInput) => {
				sent.push(event);
				return { stored: storedFlag.value };
			},
			report: (line: string) => lines.push(line),
		};
	}

	test("the warning keeps its marker unwarned, counts as failed, and is retried once the ledger stores it", async () => {
		const markers: LagMarkers = new Map();
		const sent: EventInput[] = [];
		const lines: string[] = [];
		const flag = { value: false };
		const first = await applyLagActions(planLagTransitions(lagging(), markers), markers, SETTINGS, new Date(NOW).toISOString(), effects(flag, sent, lines));
		expect(first.applied).toEqual([]);
		expect(first.failed).toHaveLength(1);
		expect(markers.get("agent-substrate")).toMatchObject({ warned: false });
		expect(lines).toHaveLength(1);

		flag.value = true;
		const second = await applyLagActions(planLagTransitions(lagging(), markers), markers, SETTINGS, new Date(NOW).toISOString(), effects(flag, sent, lines));
		expect(second.applied).toHaveLength(1);
		expect(markers.get("agent-substrate")).toMatchObject({ warned: true });
		expect(sent.map((event) => event.kind)).toEqual(["warning", "warning"]);
	});

	test("the recovery note keeps its marker until the ledger stores it", async () => {
		const markers: LagMarkers = new Map([["agent-substrate", { since: new Date(NOW).toISOString(), commit: "c1", warned: true }]]);
		const sent: EventInput[] = [];
		const lines: string[] = [];
		const flag = { value: false };
		const first = await applyLagActions(planLagTransitions(landed(), markers), markers, SETTINGS, new Date(NOW).toISOString(), effects(flag, sent, lines));
		expect(first.failed).toHaveLength(1);
		expect(markers.has("agent-substrate")).toBe(true);

		flag.value = true;
		const second = await applyLagActions(planLagTransitions(landed(), markers), markers, SETTINGS, new Date(NOW).toISOString(), effects(flag, sent, lines));
		expect(second.applied).toHaveLength(1);
		expect(markers.has("agent-substrate")).toBe(false);
		expect(sent.map((event) => event.kind)).toEqual(["note", "note"]);
	});

	test("the settler retries a stored:false warning only after the retry interval", async () => {
		const markers: LagMarkers = new Map();
		const sent: EventInput[] = [];
		const flag = { value: false };
		const settler = new LagSettler(markers, effects(flag, sent, []), { retryMs: 60_000, emitDeadlineMs: 5_000 });
		expect(settler.settle(lagging(), SETTINGS, NOW)).toBe(true);
		await settler.flight;
		expect(settler.settle(lagging(), SETTINGS, NOW + 30_000)).toBe(false);
		flag.value = true;
		expect(settler.settle(lagging(), SETTINGS, NOW + 60_000)).toBe(true);
		await settler.flight;
		expect(markers.get("agent-substrate")).toMatchObject({ warned: true });
	});
});

describe("accepting a merge-trigger never waits on the state save", () => {
	test("a hung state-file save does not delay the 202 (the job is queued first; the record is bounded to the deadline)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-freshness-"));
		try {
			const substrate = new Substrate(loadConfig({ SUBSTRATE_DOCS_STATE_FILE: join(dir, "state.json") }), { index: null, greptime: null });
			// Reaching the private save method is the only way to hang it; a named seam type states why.
			interface SaveSeam {
				persistDocsSeen(): Promise<void>;
			}
			const seam: SaveSeam = substrate as unknown as SaveSeam;
			spyOn(seam, "persistDocsSeen").mockImplementation(() => new Promise<void>(() => undefined));
			const started = Date.now();
			const answered = await Promise.race([
				substrate.startDocsRefresh({ dataset: "agent-substrate", commit: "c1", content_sha256: "s1", pages: async () => [] }, "omp"),
				Bun.sleep(3000).then(() => "blocked" as const),
			]);
			expect(answered).not.toBe("blocked");
			expect(answered).toMatchObject({ status: 202, body: { accepted: true, dataset: "agent-substrate", commit: "c1" } });
			expect(Date.now() - started).toBeLessThan(2500);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the corpus's freshness (v1.7 phase 65)", () => {
	const DAY_S = 86_400;
	const LIMIT_S = 2 * DAY_S;
	const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();
	const judged = (lastIngestAt: string | null, maxAgeS = LIMIT_S) => corpusFreshnessRow({ lastIngestAt, now: NOW, maxAgeS });
	/** The service's corpus readings, reached through the seam the lag pass reads: a stored `docs.sync` note sets the lag. */
	interface SyncSeam {
		corpusSlo: { recordSyncLag(payload: Record<string, unknown>): void };
	}

	test("a corpus is stale only past the age limit; with the limit at 0, nothing ingested, or an unreadable instant it is not judged", () => {
		expect(judged(ago(LIMIT_S))).toMatchObject({ dataset: CORPUS_FRESHNESS_DATASET, stale: false, lagging: false, trigger_lag_seconds: LIMIT_S });
		expect(judged(ago(LIMIT_S + 1))).toMatchObject({ stale: true, lagging: true, trigger_lag_seconds: LIMIT_S + 1 });
		expect(judged(ago(99 * DAY_S), 0)).toBeNull();
		expect(judged(null)).toBeNull();
		expect(judged("not a date")).toBeNull();
		// A manifest stamped ahead of this clock is fresh, never negative.
		expect(judged(new Date(NOW + HOUR).toISOString())).toMatchObject({ trigger_lag_seconds: 0, stale: false });
	});

	test("its events name the corpus, the age and the limit in seconds, and carry no commit", () => {
		const settings: FreshnessSettings = { ...SETTINGS, corpusMaxAgeS: LIMIT_S };
		const warning = lagWarningEvent({ type: "breach", dataset: CORPUS_FRESHNESS_DATASET, commit: ago(3 * DAY_S), lagSeconds: 3 * DAY_S }, settings);
		expect(warning).toMatchObject({ kind: "warning", surface: "substrate", payload: { action: "docs.freshness", state: "lagging", dataset: "corpus", lag_seconds: 3 * DAY_S, threshold_seconds: LIMIT_S } });
		expect(warning.payload).not.toHaveProperty("commit");
		const recovered = lagRecoveryEvent({ type: "recover", dataset: CORPUS_FRESHNESS_DATASET, commit: ago(3 * DAY_S), warned: true }, settings);
		expect(recovered).toMatchObject({ kind: "note", payload: { action: "docs.freshness", state: "recovered", dataset: "corpus", threshold_seconds: LIMIT_S } });
		expect(recovered.payload).not.toHaveProperty("commit");
	});

	test("its marker survives the state file like a dataset's, and a marker for an unknown name is still dropped", () => {
		const marker = { since: ago(60), commit: ago(3 * DAY_S), warned: true };
		const state = freshnessStateFromJson({ lag: { corpus: marker, "not-a-dataset": marker } });
		expect([...state.lag.keys()]).toEqual(["corpus"]);
		expect(freshnessStateToJson(state).lag).toEqual({ corpus: marker });
	});

	function corpusServer(env: Record<string, string>, fake: FakeStore) {
		const substrate = new Substrate(loadConfig({ SUBSTRATE_CORPUS: "on", ...env }), { index: null, greptime: null, corpus: { store: fake } });
		const events: EventInput[] = [];
		spyOn(substrate, "emit").mockImplementation(async (event) => {
			events.push(event);
			return { event: normalizeEvent(event, null), stored: true };
		});
		const pass = async (now: number): Promise<void> => {
			await substrate.settleDocsLag(now);
			await substrate.docsLagIdle();
		};
		const sync = (lagS: number): void => {
			(substrate as unknown as SyncSeam).corpusSlo.recordSyncLag({ action: "docs.sync", runtime: "corpus-sync", lag_s: lagS });
		};
		return { events, pass, sync };
	}

	test("a corpus past the limit warns once however many passes the breach lasts, and says so once when a fresh ingest clears it", async () => {
		const fake = new FakeStore();
		fake.lastIngestAt = ago(3 * DAY_S);
		const { events, pass } = corpusServer({}, fake);
		await pass(NOW);
		await pass(NOW + MIN);
		await pass(NOW + 2 * MIN);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "warning", payload: { action: "docs.freshness", dataset: "corpus", state: "lagging", lag_seconds: 3 * DAY_S, threshold_seconds: LIMIT_S } });

		fake.lastIngestAt = new Date(NOW + 3 * MIN).toISOString();
		await pass(NOW + 4 * MIN);
		await pass(NOW + 5 * MIN);
		expect(events.map((event) => [event.kind, event.payload?.state])).toEqual([
			["warning", "lagging"],
			["note", "recovered"],
		]);
	});

	test("a manifest that cannot be read in a pass is not a recovery: the warning stays and is not repeated when it answers again", async () => {
		const fake = new FakeStore();
		fake.lastIngestAt = ago(3 * DAY_S);
		const { events, pass } = corpusServer({}, fake);
		await pass(NOW);
		const status = spyOn(fake, "status").mockRejectedValue(new Error("connection lost"));
		await pass(NOW + MIN);
		await pass(NOW + 2 * MIN);
		status.mockRestore();
		await pass(NOW + 3 * MIN);
		expect(events.map((event) => event.payload?.state)).toEqual(["lagging"]);
	});

	test("with the corpus off, the limit at 0, or nothing ever ingested, no pass judges it", async () => {
		const stale = new FakeStore();
		stale.lastIngestAt = ago(30 * DAY_S);
		const off = corpusServer({ SUBSTRATE_CORPUS: "off" }, stale);
		await off.pass(NOW);
		const unlimited = corpusServer({ SUBSTRATE_CORPUS_FRESH_MAX_AGE_S: "0" }, stale);
		await unlimited.pass(NOW);
		const empty = corpusServer({}, new FakeStore());
		await empty.pass(NOW);
		expect([off.events, unlimited.events, empty.events]).toEqual([[], [], []]);
	});

	test("the limit is the one the operator set", async () => {
		const fake = new FakeStore();
		fake.lastIngestAt = ago(2 * 3600);
		const tight = corpusServer({ SUBSTRATE_CORPUS_FRESH_MAX_AGE_S: "3600" }, fake);
		await tight.pass(NOW);
		expect(tight.events).toHaveLength(1);
		expect(tight.events[0]?.payload).toMatchObject({ threshold_seconds: 3600 });
		const loose = corpusServer({}, fake);
		await loose.pass(NOW);
		expect(loose.events).toEqual([]);
	});

	test("a sync lag over its objective raises the warning and names the sync breach; on the objective, under it or with no objective it does not", async () => {
		const fake = new FakeStore();
		fake.lastIngestAt = ago(3600);
		const over = corpusServer({ SUBSTRATE_DOCS_SLO_SYNC_LAG_S: "3600" }, fake);
		over.sync(3601);
		await over.pass(NOW);
		expect(over.events).toHaveLength(1);
		expect(over.events[0]).toMatchObject({
			kind: "warning",
			payload: { action: "docs.freshness", dataset: "corpus", state: "lagging", breaches: ["sync_lag"], sync_lag_seconds: 3601, sync_threshold_seconds: 3600 },
		});
		expect(over.events[0]?.summary).toContain("sync lag 3601 s");
		over.sync(3600);
		await over.pass(NOW + MIN);
		expect(over.events.map((event) => [event.kind, event.payload?.state])).toEqual([
			["warning", "lagging"],
			["note", "recovered"],
		]);

		const on = corpusServer({ SUBSTRATE_DOCS_SLO_SYNC_LAG_S: "3600" }, fake);
		on.sync(3600);
		await on.pass(NOW);
		on.sync(12);
		await on.pass(NOW + MIN);
		expect(on.events).toEqual([]);

		const unset = corpusServer({}, fake);
		unset.sync(999_999);
		await unset.pass(NOW);
		expect(unset.events).toEqual([]);
	});

	test("the warning names the age breach alone while no sync objective is set, both breaches when the sync lag is over its objective too, and the sync breach alone when the age limit is 0", async () => {
		const stale = new FakeStore();
		stale.lastIngestAt = ago(3 * DAY_S);
		const ageOnly = corpusServer({}, stale);
		ageOnly.sync(7200);
		await ageOnly.pass(NOW);
		expect(ageOnly.events[0]?.payload).toMatchObject({ breaches: ["ingest_age"], lag_seconds: 3 * DAY_S });
		expect(ageOnly.events[0]?.payload).not.toHaveProperty("sync_lag_seconds");

		const both = corpusServer({ SUBSTRATE_DOCS_SLO_SYNC_LAG_S: "3600" }, stale);
		both.sync(7200);
		await both.pass(NOW);
		expect(both.events).toHaveLength(1);
		expect(both.events[0]?.payload).toMatchObject({ breaches: ["ingest_age", "sync_lag"], sync_lag_seconds: 7200, sync_threshold_seconds: 3600, threshold_seconds: LIMIT_S });

		const ageOff = corpusServer({ SUBSTRATE_CORPUS_FRESH_MAX_AGE_S: "0", SUBSTRATE_DOCS_SLO_SYNC_LAG_S: "3600" }, stale);
		ageOff.sync(7200);
		await ageOff.pass(NOW);
		expect(ageOff.events[0]?.payload).toMatchObject({ breaches: ["sync_lag"], sync_lag_seconds: 7200 });
		expect(ageOff.events[0]?.payload).not.toHaveProperty("threshold_seconds");
	});
});
