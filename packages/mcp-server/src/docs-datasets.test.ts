/**
 * Plan 25-03 Task 1: dataset resolve-by-name, last-five retention on the
 * live version door, and the skills-sync-not-live degradation — all
 * against the recording fake. Product-dataset creation is proven as a
 * convention here; real creation is a gated live step (G2). Version
 * promotion itself runs inside the service doors, covered by the
 * lifecycle suite; resolve/refresh helpers with no runtime caller are
 * documented there, not wired here.
 */
import { describe, expect, test } from "bun:test";
import {
	createSkillsSyncTracker,
	createVersionStore,
	degradedAgentSkillsServe,
	isSyncLive,
	latestVersion,
	noteSkillsSyncFastForward,
	pinsFromVersions,
	recordDatasetVersion,
	recordVersion,
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

describe("recordDatasetVersion", () => {
	test("records versions and keeps the last five with monotonic numbers", () => {
		const versions = createVersionStore();
		for (let n = 1; n <= 7; n += 1) {
			recordDatasetVersion(versions, {
				dataset: "agent-substrate",
				dataset_id: "ds-berlin-agent-substrate",
				commit: `c${n}`,
				content_sha256: `sha${n}`,
				ingested_at: new Date(1_000_000 + n * 1000).toISOString(),
			});
		}
		const kept = versions.get("agent-substrate") ?? [];
		expect(kept.map((version) => version.version)).toEqual(["v3", "v4", "v5", "v6", "v7"]);
		expect(latestVersion(versions, "agent-substrate")?.commit).toBe("c7");
	});

	test("pins cite the commit only for chunks from the pinned documents", async () => {
		const fake = new RagflowFake();
		const { emit } = eventsHarness();
		const versions = createVersionStore();
		recordVersion(versions, {
			dataset: "agent-substrate",
			dataset_id: "ds-berlin-agent-substrate",
			version: "v1",
			commit: "pinned-commit",
			content_sha256: "sha",
			ingested_at: new Date(1_000_000).toISOString(),
			documents: [
				{ source_url: "https://example.com/agent-substrate/data-planes", document_id: "doc-ds-berlin-agent-substrate-1", content_sha256: "s1" },
				{ source_url: "https://example.com/agent-substrate/data-planes", document_id: "doc-ds-berlin-agent-substrate-2", content_sha256: "s2" },
			],
		});
		const reply = await searchDocs(
			{ config: CONFIG, emit, fetchImpl: fake.fetch, pins: pinsFromVersions(versions), datasetNames: ["agent-substrate"] },
			"who reads RAGFlow?",
		);
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(reply.chunks.every((citation) => citation.commit === "pinned-commit")).toBe(true);
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
			documents: [
				{ source_url: "https://example.com/agent-skills/review", document_id: "doc-ds-leipzig-agent-skills-1", content_sha256: "s1" },
				{ source_url: "https://example.com/agent-skills/review", document_id: "doc-ds-leipzig-agent-skills-2", content_sha256: "s2" },
			],
		});
		const reply = await searchDocs(
			{
				config: CONFIG,
				datasetNames: ["agent-skills"],
				emit,
				fetchImpl: fake.fetch,
				pins: pinsFromVersions(versions),
				degradedDatasets: ["agent-skills"],
				nowMs: 1_000_000 + 30_000,
			},
			"what skills exist?",
		);
		const marked = reply.chunks.filter((citation) => citation.pin_age_ms !== undefined);
		expect(marked).toHaveLength(reply.chunks.length);
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(marked.every((citation) => citation.pin_age_ms === 30_000 && citation.commit === "skill-pin")).toBe(true);
	});

	test("a fast-forward flips the tracker live and versions carry manifests", () => {
		const versions = createVersionStore();
		const tracker = createSkillsSyncTracker();
		noteSkillsSyncFastForward(tracker);
		expect(isSyncLive(tracker)).toBe(true);
		const version = recordDatasetVersion(versions, {
			dataset: "agent-skills",
			dataset_id: "ds-leipzig-agent-skills",
			commit: "sync-ff",
			content_sha256: "sha",
			ingested_at: new Date(2_000_000).toISOString(),
			documents: [
				{ source_url: "https://example.com/agent-skills/review", document_id: "doc-1", content_sha256: "sha" },
			],
		});
		expect(version.version).toBe("v1");
		expect(pinsFromVersions(versions)["ds-leipzig-agent-skills"]?.documents).toHaveLength(1);
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
