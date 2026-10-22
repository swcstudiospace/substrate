/**
 * Plan 25-03 Task 1: dataset resolve-by-name, refresh with last-five
 * retention, and the skills-sync-not-live degradation — all against the
 * recording fake. Product-dataset creation is proven as a convention here;
 * real creation is a gated live step (G2).
 */
import { describe, expect, test } from "bun:test";
import {
	DATASET_TRIGGER_RETENTION,
	TRIGGER_SCAN_MAX,
	createSkillsSyncTracker,
	createTriggerStore,
	createVersionStore,
	degradedAgentSkillsServe,
	isSyncLive,
	latestVersion,
	lightragSearchDatasets,
	noteSkillsSyncFastForward,
	pinsFromVersions,
	recordTrigger,
	recordVersion,
	refreshDataset,
	resolveDatasets,
	triggersFromJson,
	triggersToJson,
	type RefreshDeps,
} from "./docs-datasets.ts";
import { searchDocs } from "./docs-search.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import type { EventInput } from "./types.ts";

const CONFIG = { url: "http://ragflow.test", apiKey: "test-key" };

function eventsHarness() {
	const events: EventInput[] = [];
	const emit = async (event: EventInput): Promise<unknown> => {
		events.push(event);
		return { stored: false };
	};
	return { events, emit };
}

describe("resolveDatasets", () => {
	test("reuses existing datasets without creating", async () => {
		const fake = new RagflowFake();
		const resolved = await resolveDatasets({ config: CONFIG, fetchImpl: fake.fetch }, ["agent-substrate", "programming-desk"]);
		if (!resolved.ok) throw new Error(`expected resolve: ${resolved.reason}`);
		expect(resolved.datasets).toEqual([
			{ name: "agent-substrate", id: "ds-berlin-agent-substrate", created: false },
			{ name: "programming-desk", id: "ds-hamm-programming-desk", created: false },
		]);
		expect(fake.requests.some((request) => request.method === "POST" && request.path === "/api/v1/datasets")).toBe(false);
	});

	test("creates only on a name-miss with the pinned embedding model", async () => {
		const fake = new RagflowFake();
		const resolved = await resolveDatasets({ config: CONFIG, fetchImpl: fake.fetch }, ["kanbanos"]);
		if (!resolved.ok) throw new Error(`expected resolve: ${resolved.reason}`);
		expect(resolved.datasets[0]?.created).toBe(true);
		const created = fake.requests.find((request) => request.method === "POST" && request.path === "/api/v1/datasets");
		if (created?.body === null || typeof created?.body !== "object" || !("embedding_model" in created.body)) {
			throw new Error("the create call was not recorded");
		}
		expect(created.body).toMatchObject({ name: "kanbanos", embedding_model: "tei-bge-small" });
	});

	test("rehearses discovery without creating when asked", async () => {
		const fake = new RagflowFake();
		const resolved = await resolveDatasets({ config: CONFIG, fetchImpl: fake.fetch, createOnMiss: false }, ["clippyos"]);
		if (!resolved.ok) throw new Error(`expected resolve: ${resolved.reason}`);
		expect(resolved.datasets).toEqual([{ name: "clippyos", id: null, created: false }]);
		expect(fake.datasets.some((dataset) => dataset.name === "clippyos")).toBe(false);
	});
});

describe("lightragSearchDatasets", () => {
	test("keys each wanted dataset by the id its newest version recorded, the same key its pin uses", () => {
		const store = createVersionStore();
		const base = { dataset: "agent-substrate", content_sha256: "sha", commit: "c1", ingested_at: "2026-10-22T00:00:00Z" };
		recordVersion(store, { ...base, dataset_id: "ragflow-uuid-old", version: "v1" });
		recordVersion(store, { ...base, dataset_id: "ragflow-uuid", version: "v2" });
		expect(lightragSearchDatasets(store, ["agent-substrate"])).toEqual({ ok: true, datasets: [{ id: "ragflow-uuid", name: "agent-substrate" }] });
		expect(pinsFromVersions(store)["ragflow-uuid"]?.version).toBe("v2");
	});

	test("a dataset with no version yet stands as its own id", () => {
		expect(lightragSearchDatasets(createVersionStore(), ["agent-substrate"])).toEqual({ ok: true, datasets: [{ id: "agent-substrate", name: "agent-substrate" }] });
	});
});

describe("refreshDataset", () => {
	test("records versions and keeps the last five with monotonic numbers", async () => {
		const fake = new RagflowFake();
		const { emit } = eventsHarness();
		const deps: RefreshDeps = { config: CONFIG, versions: createVersionStore(), emit, fetchImpl: fake.fetch, nowMs: 1_000_000 };
		for (let n = 1; n <= 7; n += 1) {
			const refreshed = await refreshDataset(deps, { dataset: "agent-substrate", commit: `c${n}`, content_sha256: `sha${n}` });
			if (!refreshed.ok) throw new Error(`expected refresh: ${refreshed.reason}`);
		}
		const kept = deps.versions.get("agent-substrate") ?? [];
		expect(kept.map((version) => version.version)).toEqual(["v3", "v4", "v5", "v6", "v7"]);
		expect(latestVersion(deps.versions, "agent-substrate")?.commit).toBe("c7");
	});

	test("pins travel as dataset_commit; an unrecorded document is never cited with the pin as its commit", async () => {
		const fake = new RagflowFake();
		const { emit } = eventsHarness();
		const versions = createVersionStore();
		const refreshed = await refreshDataset(
			{ config: CONFIG, versions, emit, fetchImpl: fake.fetch, nowMs: 1_000_000 },
			{ dataset: "agent-substrate", commit: "pinned-commit", content_sha256: "sha" },
		);
		if (!refreshed.ok) throw new Error(`expected refresh: ${refreshed.reason}`);
		const reply = await searchDocs(
			{ config: CONFIG, emit, fetchImpl: fake.fetch, pins: pinsFromVersions(versions), datasetNames: ["agent-substrate"] },
			"who reads RAGFlow?",
		);
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(reply.chunks.every((citation) => citation.dataset_commit === "pinned-commit")).toBe(true);
		expect(reply.chunks.every((citation) => citation.commit === "dataset-pin:agent-substrate:unrecorded")).toBe(true);
	});
});

describe("skills-sync degradation", () => {
	test("absent fast-forward warns once and serves the pin with its age", async () => {
		const fake = new RagflowFake();
		const { events, emit } = eventsHarness();
		const versions = createVersionStore();
		recordVersion(versions, {
			dataset: "agent-skills",
			dataset_id: "ds-leipzig-agent-skills",
			version: "v2",
			commit: "skill-pin",
			content_sha256: "sha",
			ingested_at: new Date(1_000_000).toISOString(),
		});
		const tracker = createSkillsSyncTracker();
		expect(isSyncLive(tracker)).toBe(false);
		const deps: RefreshDeps = { config: CONFIG, versions, emit, fetchImpl: fake.fetch, nowMs: 1_000_000 + 60_000 };
		const first = await degradedAgentSkillsServe(deps, tracker);
		if (!first.ok) throw new Error(`expected serve: ${first.reason}`);
		expect(first.serve.pin_age_ms).toBe(60_000);
		const warnings = events.filter((event) => event.kind === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.payload).toMatchObject({ action: "docs.ingest", reason: "skills-sync-not-live" });

		const second = await degradedAgentSkillsServe(deps, tracker);
		if (!second.ok) throw new Error(`expected serve: ${second.reason}`);
		expect(events.filter((event) => event.kind === "warning")).toHaveLength(1);
	});

	test("pin age travels in the search reply for degraded datasets", async () => {
		const fake = new RagflowFake();
		const { emit } = eventsHarness();
		const versions = createVersionStore();
		recordVersion(versions, {
			dataset: "agent-skills",
			dataset_id: "ds-leipzig-agent-skills",
			version: "v2",
			commit: "skill-pin",
			content_sha256: "sha",
			ingested_at: new Date(1_000_000).toISOString(),
		});
		const reply = await searchDocs(
			{
				config: CONFIG,
				emit,
				fetchImpl: fake.fetch,
				pins: pinsFromVersions(versions),
				degradedDatasets: ["agent-skills"],
				nowMs: 1_000_000 + 30_000,
			},
			"what skills exist?",
		);
		const marked = reply.chunks.filter((citation) => citation.pin_age_ms !== undefined);
		expect(marked.length).toBeGreaterThan(0);
		expect(marked.every((citation) => citation.pin_age_ms === 30_000)).toBe(true);
	});

	test("a fast-forward flips the tracker live and drives refresh", async () => {
		const fake = new RagflowFake();
		const { events, emit } = eventsHarness();
		const tracker = createSkillsSyncTracker();
		noteSkillsSyncFastForward(tracker);
		expect(isSyncLive(tracker)).toBe(true);
		const refreshed = await refreshDataset(
			{ config: CONFIG, versions: createVersionStore(), emit, fetchImpl: fake.fetch, nowMs: 2_000_000 },
			{ dataset: "agent-skills", commit: "sync-ff", content_sha256: "sha" },
		);
		if (!refreshed.ok) throw new Error(`expected refresh: ${refreshed.reason}`);
		expect(refreshed.version.version).toBe("v1");
		expect(events.some((event) => event.kind === "note")).toBe(true);
	});

	test("degraded serve without a pin is a reason, not a throw", async () => {
		const fake = new RagflowFake();
		const { emit } = eventsHarness();
		const serve = await degradedAgentSkillsServe(
			{ config: CONFIG, versions: createVersionStore(), emit, fetchImpl: fake.fetch },
			createSkillsSyncTracker(),
		);
		if (serve.ok) throw new Error("expected a reason");
		expect(serve.reason).toBe("no-pinned-version");
	});
});

describe("the accepted-trigger store (uplift-4 S7)", () => {
	const at = "2026-10-14T00:00:00.000Z";

	test("keeps the newest DATASET_TRIGGER_RETENTION per dataset, oldest first, and an empty store serialises to nothing", () => {
		const store = createTriggerStore();
		expect(triggersToJson(store)).toBeUndefined();
		for (let i = 0; i < DATASET_TRIGGER_RETENTION + 7; i += 1) recordTrigger(store, "agent-substrate", { commit: `c${i}`, content_sha256: "s", received_at: at });
		const kept = store.get("agent-substrate") ?? [];
		expect(kept).toHaveLength(DATASET_TRIGGER_RETENTION);
		expect(kept[0]?.commit).toBe("c7");
		expect(kept[kept.length - 1]?.commit).toBe(`c${DATASET_TRIGGER_RETENTION + 6}`);
	});

	test("round-trips through JSON, reading only the trigger table's own datasets and skipping bad rows", () => {
		const store = createTriggerStore();
		recordTrigger(store, "kanbanos", { commit: "k1", content_sha256: "s", received_at: at });
		const json = triggersToJson(store);
		expect(triggersFromJson(JSON.parse(JSON.stringify(json))).get("kanbanos")).toEqual([{ commit: "k1", content_sha256: "s", received_at: at }]);
		const hostile = triggersFromJson({ constructor: [{ commit: "c", content_sha256: "s", received_at: at }], kanbanos: [null, 5, { commit: "k", content_sha256: "s", received_at: "nope" }] });
		expect(hostile.size).toBe(0);
		expect(triggersFromJson(null).size).toBe(0);
		expect(triggersFromJson([]).size).toBe(0);
	});

	test("reads at most TRIGGER_SCAN_MAX rows from the tail of an oversized list", () => {
		const rows = Array.from({ length: 10_000 }, (_, i) => ({ commit: `c${i}`, content_sha256: "s", received_at: at }));
		const kept = triggersFromJson({ "agent-substrate": rows }).get("agent-substrate") ?? [];
		expect(kept).toHaveLength(DATASET_TRIGGER_RETENTION);
		expect(kept[kept.length - 1]?.commit).toBe("c9999");
		const garbage = Array.from({ length: TRIGGER_SCAN_MAX + 5 }, () => ({ nope: true }));
		expect(triggersFromJson({ "agent-substrate": [{ commit: "old", content_sha256: "s", received_at: at }, ...garbage] }).size).toBe(0);
	});
});
