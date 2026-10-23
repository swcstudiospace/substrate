/**
 * Plan 25-03 Task 1: dataset resolve-by-name, refresh with last-five
 * retention, and the skills-sync-not-live degradation — all against the
 * recording fake. Product-dataset creation is proven as a convention here;
 * real creation is a gated live step (G2).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Substrate } from "./service.ts";
import {
	DATASET_TRIGGER_RETENTION,
	TRIGGER_SCAN_MAX,
	createSkillsSyncTracker,
	createTriggerStore,
	createVersionStore,
	degradedAgentSkillsServe,
	isSyncLive,
	latestVersion,
	latestVersionFor,
	lightragSearchDatasets,
	noteSkillsSyncFastForward,
	pinsFromVersions,
	pinsByName,
	recordTrigger,
	recordVersion,
	refreshDataset,
	resolveDatasets,
	triggersFromJson,
	triggersToJson,
	versionsFromJson,
	versionsToJson,
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
	test("a LightRAG dataset is identified by its name, whatever id a RAGFlow refresh recorded for it", () => {
		const store = createVersionStore();
		const base = { dataset: "agent-substrate", content_sha256: "sha", commit: "c1", ingested_at: "2026-10-22T00:00:00Z", backend: "ragflow" as const };
		recordVersion(store, { ...base, dataset_id: "ragflow-uuid-old", version: "v1" });
		recordVersion(store, { ...base, dataset_id: "ragflow-uuid", version: "v2" });
		expect(lightragSearchDatasets(["agent-substrate"])).toEqual({ ok: true, datasets: [{ id: "agent-substrate", name: "agent-substrate" }] });
	});

	test("a dataset with no version yet stands as its own id", () => {
		expect(lightragSearchDatasets(["agent-substrate"])).toEqual({ ok: true, datasets: [{ id: "agent-substrate", name: "agent-substrate" }] });
	});

	test("the caller's name order does not change the list or its first dataset", () => {
		const store = createVersionStore();
		recordVersion(store, { dataset: "agent-skills", dataset_id: "uuid-skills", version: "v1", commit: "c1", content_sha256: "sha", ingested_at: "2026-10-22T00:00:00Z", backend: "ragflow" });
		const listed = lightragSearchDatasets(["agent-substrate", "agent-skills"]);
		expect(lightragSearchDatasets(["agent-skills", "agent-substrate"])).toEqual(listed);
		expect(listed).toEqual({
			ok: true,
			datasets: [
				{ id: "agent-skills", name: "agent-skills" },
				{ id: "agent-substrate", name: "agent-substrate" },
			],
		});
	});

	test("the pin is filed under the dataset's name, from that name's newest version of the backend asked for", () => {
		const store = createVersionStore();
		const base = { dataset: "agent-substrate", content_sha256: "sha", commit: "c1", ingested_at: "2026-10-22T00:00:00Z", backend: "ragflow" as const };
		recordVersion(store, { ...base, dataset_id: "ragflow-uuid-old", version: "v1" });
		recordVersion(store, { ...base, dataset_id: "ragflow-uuid", version: "v2" });
		expect(pinsByName(store, ["agent-substrate", "agent-missing"], "ragflow")).toEqual({
			"agent-substrate": { dataset: "agent-substrate", dataset_id: "ragflow-uuid", version: "v2", commit: "c1", ingested_at: "2026-10-22T00:00:00Z" },
		});
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
		expect(latestVersion(deps.versions, "agent-substrate")?.backend).toBe("ragflow");
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
			{ config: CONFIG, emit, fetchImpl: fake.fetch, pins: pinsFromVersions(versions, "ragflow"), datasetNames: ["agent-substrate"] },
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
			backend: "ragflow",
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
			backend: "ragflow",
			content_sha256: "sha",
			ingested_at: new Date(1_000_000).toISOString(),
		});
		const reply = await searchDocs(
			{
				config: CONFIG,
				emit,
				fetchImpl: fake.fetch,
				pins: pinsFromVersions(versions, "ragflow"),
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

describe("a completed version belongs to the backend that indexed it", () => {
	const at = "2026-10-22T00:00:00Z";

	test("the backend round-trips through the state file; a legacy version without one loads as ragflow", () => {
		const store = createVersionStore();
		recordVersion(store, { dataset: "agent-substrate", dataset_id: "agent-substrate", version: "v1", commit: "c1", content_sha256: "s", ingested_at: at, backend: "lightrag" });
		const reloaded = versionsFromJson(JSON.parse(JSON.stringify(versionsToJson(store))));
		expect(reloaded.get("agent-substrate")).toEqual(store.get("agent-substrate"));
		const legacy = versionsFromJson({ "agent-substrate": [{ dataset: "agent-substrate", dataset_id: "uuid", version: "v1", commit: "c0", content_sha256: "s", ingested_at: at }] });
		expect(legacy.get("agent-substrate")?.[0]?.backend).toBe("ragflow");
		expect(versionsFromJson({ "agent-substrate": [{ dataset: "agent-substrate", dataset_id: "uuid", version: "v1", commit: "c0", content_sha256: "s", ingested_at: at, backend: "pinecone" }] }).size).toBe(0);
	});

	test("the newest version a backend recorded is the one it completes against", () => {
		const store = createVersionStore();
		const row = { dataset: "agent-substrate", content_sha256: "s", ingested_at: at };
		recordVersion(store, { ...row, dataset_id: "uuid", version: "v1", commit: "c-ragflow", backend: "ragflow" });
		recordVersion(store, { ...row, dataset_id: "agent-substrate", version: "v2", commit: "c-lightrag", backend: "lightrag" });
		recordVersion(store, { ...row, dataset_id: "uuid", version: "v3", commit: "c-ragflow-2", backend: "ragflow" });
		expect(latestVersionFor(store, "agent-substrate", "lightrag")?.commit).toBe("c-lightrag");
		expect(latestVersionFor(store, "agent-substrate", "ragflow")?.commit).toBe("c-ragflow-2");
		expect(latestVersionFor(store, "agent-skills", "ragflow")).toBeUndefined();
	});

	test("a pin never crosses backends: a RAGFlow-era version supplies no LightRAG pin and a LightRAG version supplies no RAGFlow pin", () => {
		const store = createVersionStore();
		const row = { content_sha256: "s", ingested_at: at };
		recordVersion(store, { ...row, dataset: "agent-substrate", dataset_id: "uuid", version: "v1", commit: "c-ragflow", backend: "ragflow" });
		recordVersion(store, { ...row, dataset: "agent-skills", dataset_id: "agent-skills", version: "v1", commit: "c-lightrag", backend: "lightrag" });
		expect(pinsByName(store, ["agent-substrate"], "lightrag")).toEqual({});
		expect(pinsFromVersions(store, "lightrag")).toEqual({
			"agent-skills": { dataset: "agent-skills", dataset_id: "agent-skills", version: "v1", commit: "c-lightrag", ingested_at: at },
		});
		expect(pinsByName(store, ["agent-skills"], "ragflow")).toEqual({});
		expect(pinsFromVersions(store, "ragflow")).toEqual({
			uuid: { dataset: "agent-substrate", dataset_id: "uuid", version: "v1", commit: "c-ragflow", ingested_at: at },
		});
	});

	test("after a RAGFlow-era version, a LightRAG replay is not complete; the same version still completes a RAGFlow replay", async () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-docs-backend-"));
		try {
			const ragflowEnv = { RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", SUBSTRATE_DOCS_STATE_FILE: join(dir, "docs-ingest.json") };
			const lightragEnv = { ...ragflowEnv, LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_DOCS_BACKEND: "lightrag" };
			const fake = new RagflowFake();
			const ragflowEra = new Substrate(loadConfig(ragflowEnv), { index: null, greptime: null, ragflowFetch: fake.fetch });
			const recorded = await ragflowEra.recordDocsVersion({ dataset: "agent-substrate", commit: "c-cut", content_sha256: "sha-cut" }, "omp");
			if (!recorded.ok) throw new Error(recorded.reason);
			// The cutover keeps the URLs and the state file and selects LightRAG: the RAGFlow version must not complete its replay.
			const cutover = new Substrate(loadConfig(lightragEnv), { index: null, greptime: null, ragflowFetch: fake.fetch });
			expect(await cutover.latestDocsVersion("agent-substrate")).toBeUndefined();
			// A LightRAG refresh records its own version, which then completes the LightRAG replay.
			const lightrag = await cutover.recordDocsVersion({ dataset: "agent-substrate", commit: "c-cut", content_sha256: "sha-cut" }, "omp");
			if (!lightrag.ok) throw new Error(lightrag.reason);
			expect(lightrag.version).toMatchObject({ backend: "lightrag", dataset_id: "agent-substrate", version: "v2" });
			expect(await cutover.latestDocsVersion("agent-substrate")).toMatchObject({ backend: "lightrag", commit: "c-cut", content_sha256: "sha-cut" });
			// The RAGFlow replay of the RAGFlow version still completes after a restart.
			const restarted = new Substrate(loadConfig(ragflowEnv), { index: null, greptime: null, ragflowFetch: fake.fetch });
			expect(await restarted.latestDocsVersion("agent-substrate")).toMatchObject({ backend: "ragflow", commit: "c-cut", content_sha256: "sha-cut", version: "v1" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
