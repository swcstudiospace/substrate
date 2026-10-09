/**
 * Dataset registry (D25-14): eight entries, harness override, cached id
 * resolution. No fixtures hold secrets; dataset ids below are inert test
 * values, never credentials.
 */
import { describe, expect, test } from "bun:test";
import {
	BUILTIN_REGISTRY,
	clearDatasetCache,
	findDataset,
	loadRegistry,
	resolveDatasetId,
} from "./registry.ts";
import type { DatasetEntry } from "./registry.ts";
import { ingestPage } from "./ingest.ts";
import type { DocsRagflow } from "./manifest.ts";

const NAMES = BUILTIN_REGISTRY.map((entry) => entry.name);

/**
 * Shape/exclude refusals and `dry_run` return before any RAGFlow or manifest
 * touch, so path-matching tests fail loudly if that ever changes.
 */
function unreachable(reason: string): never {
	throw new Error(reason);
}

const untouched: DocsRagflow = {
	listDatasets: () => Promise.reject(unreachable("must never reach RAGFlow")),
	listDocuments: () => Promise.reject(unreachable("must never reach RAGFlow")),
	uploadDocuments: () => Promise.reject(unreachable("must never reach RAGFlow")),
	parseDocuments: () => Promise.reject(unreachable("must never reach RAGFlow")),
	updateDocument: () => Promise.reject(unreachable("must never reach RAGFlow")),
	deleteDocuments: () => Promise.reject(unreachable("must never reach RAGFlow")),
	ensureDataset: () => Promise.reject(unreachable("must never reach RAGFlow")),
};

describe("builtin registry", () => {
	test("holds all eight datasets", () => {
		expect(NAMES.sort()).toEqual(
			["agent-substrate", "agent-skills", "programming-desk", "auctioning", "clippyos", "desklanes", "kanbanos"].sort(),
		);
	});

	test("agent-substrate excludes docs/receipts/**", () => {
		const entry = findDataset(BUILTIN_REGISTRY, "agent-substrate");
		expect(entry?.exclude).toContain("docs/receipts/**");
		expect(entry?.include).toEqual(["README.md", "docs/**/*.md", ".planning/PROJECT.md"]);
	});

	test("no registry entry ingests docs/receipts/**", () => {
		for (const entry of BUILTIN_REGISTRY) {
			expect(entry.include.some((glob) => glob.includes("receipts"))).toBe(false);
		}
	});

	test("docs/receipts/r.md is refused by actual path matching on every entry", async () => {
		for (const entry of BUILTIN_REGISTRY) {
			const sha = "d".repeat(40);
			const result = await ingestPage(
				{
					dataset: entry.name,
					sourceUrl: `https://github.com/${entry.slug}/blob/${sha}/docs/receipts/r.md`,
					commit: sha,
					content: "# Receipt\n\nBody.\n",
					surface: "substrate",
					isSubstrateOrOperator: true,
				},
				{ registry: BUILTIN_REGISTRY, client: untouched },
			);
			expect(result).toEqual({ status: "refused", reason: "outside-roots" });
		}
	});

	test("the receipts exclude stays scoped: ordinary docs pages still match", async () => {
		for (const name of ["agent-substrate", "programming-desk", "kanbanos", "desklanes", "clippyos", "auctioning"]) {
			const entry = findDataset(BUILTIN_REGISTRY, name);
			if (!entry) throw new Error(`missing registry entry ${name}`);
			const sha = "e".repeat(40);
			const result = await ingestPage(
				{
					dataset: entry.name,
					sourceUrl: `https://github.com/${entry.slug}/blob/${sha}/docs/guide.md`,
					commit: sha,
					content: "# Guide\n\nBody.\n",
					dryRun: true,
					surface: "substrate",
					isSubstrateOrOperator: true,
				},
				{ registry: BUILTIN_REGISTRY, client: untouched },
			);
			expect(result.status).toBe("dry_run");
		}
	});

	test("provisional entries carry the proposed swcstudiospace/<name> slug", () => {
		for (const name of ["kanbanos", "desklanes", "clippyos", "auctioning"]) {
			const entry = findDataset(BUILTIN_REGISTRY, name);
			expect(entry?.slug).toBe(`swcstudiospace/${name}`);
			expect(entry?.include).toEqual(["README.md", "docs/**"]);
			expect(entry?.trigger).toBe("merge-to-main");
		}
	});

	test("agent-skills refreshes on the skills-sync fast-forward", () => {
		expect(findDataset(BUILTIN_REGISTRY, "agent-skills")?.trigger).toBe("skills-sync-fast-forward");
	});

	test("loadRegistry returns copies, so callers cannot mutate the builtin", () => {
		const loaded = loadRegistry({});
		loaded[0]?.include.push("evil/**");
		expect(BUILTIN_REGISTRY[0]?.include).not.toContain("evil/**");
	});
});

describe("loadRegistry override", () => {
	const entry: DatasetEntry = {
		name: "harness-only",
		slug: "harness/only",
		include: ["docs/**"],
		exclude: [],
		trigger: "merge-to-main",
	};

	test("SUBSTRATE_DOCS_DATASETS replaces the registry", () => {
		const loaded = loadRegistry({ SUBSTRATE_DOCS_DATASETS: "/run/docs.json" }, () => JSON.stringify([entry]));
		expect(loaded).toEqual([entry]);
	});

	test("an unreadable file falls back to the builtin without throwing", () => {
		const loaded = loadRegistry({ SUBSTRATE_DOCS_DATASETS: "/run/missing.json" }, () => {
			throw new Error("ENOENT");
		});
		expect(loaded.map((item) => item.name).sort()).toEqual(NAMES.sort());
	});

	test("invalid JSON falls back to the builtin without throwing", () => {
		expect(loadRegistry({ SUBSTRATE_DOCS_DATASETS: "/run/docs.json" }, () => "not json{").length).toBe(
			BUILTIN_REGISTRY.length,
		);
	});

	test("a non-array falls back to the builtin without throwing", () => {
		const loaded = loadRegistry({ SUBSTRATE_DOCS_DATASETS: "/run/docs.json" }, () => JSON.stringify({ name: "x" }));
		expect(loaded.length).toBe(BUILTIN_REGISTRY.length);
	});

	test("entries with the wrong shape are dropped, valid ones kept", () => {
		const loaded = loadRegistry({ SUBSTRATE_DOCS_DATASETS: "/run/docs.json" }, () =>
			JSON.stringify([entry, { name: "bad" }, { name: "bad-trigger", slug: "s", include: [], exclude: [], trigger: "cron" }]),
		);
		expect(loaded).toEqual([entry]);
	});
});

describe("resolveDatasetId", () => {
	test("an unknown name resolves to unknown-dataset without listing", async () => {
		clearDatasetCache();
		let listed = 0;
		const out = await resolveDatasetId(BUILTIN_REGISTRY, "no-such-dataset", async () => {
			listed += 1;
			return [];
		});
		expect(out).toEqual({ ok: false, reason: "unknown-dataset" });
		expect(listed).toBe(0);
	});

	test("a static datasetId wins without listing", async () => {
		clearDatasetCache();
		const registry: DatasetEntry[] = [{ ...BUILTIN_REGISTRY[0]!, datasetId: "ds-static" }];
		let listed = 0;
		const out = await resolveDatasetId(registry, "agent-substrate", async () => {
			listed += 1;
			return [];
		});
		expect(out).toEqual({ ok: true, datasetId: "ds-static" });
		expect(listed).toBe(0);
	});

	test("a listed name resolves and the second call is cached", async () => {
		clearDatasetCache();
		let listed = 0;
		const list = async () => {
			listed += 1;
			return [{ id: "ds-1", name: "agent-substrate" }];
		};
		expect(await resolveDatasetId(BUILTIN_REGISTRY, "agent-substrate", list)).toEqual({
			ok: true,
			datasetId: "ds-1",
		});
		expect(await resolveDatasetId(BUILTIN_REGISTRY, "agent-substrate", list)).toEqual({
			ok: true,
			datasetId: "ds-1",
		});
		expect(listed).toBe(1);
	});

	test("a name missing from the list resolves to unknown-dataset", async () => {
		clearDatasetCache();
		const out = await resolveDatasetId(BUILTIN_REGISTRY, "kanbanos", async () => [
			{ id: "ds-1", name: "agent-substrate" },
		]);
		expect(out).toEqual({ ok: false, reason: "unknown-dataset" });
	});
});
