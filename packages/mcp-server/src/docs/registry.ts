/**
 * Typed RAGFlow dataset registry (D25-14).
 *
 * Each entry names a dataset the substrate may search or ingest: its registry
 * name (the only thing callers ever pass), the GitHub repo slug its pages must
 * come from, the include/exclude globs that bound those pages, and the trigger
 * that refreshes it. RAGFlow dataset ids are resolved by name through
 * RAGFlow's dataset list and cached in memory — never passed by callers.
 *
 * `SUBSTRATE_DOCS_DATASETS` may point at a JSON file that *replaces* this
 * registry. Only the harness and tests use it. The file is validated without
 * throwing: an unreadable file, invalid JSON, or a non-array falls back to the
 * builtin registry, and entries with the wrong shape are dropped.
 */
import { readFileSync } from "node:fs";

export type DatasetTrigger = "merge-to-main" | "skills-sync-fast-forward";

export interface DatasetEntry {
	name: string;
	slug: string;
	include: string[];
	exclude: string[];
	trigger: DatasetTrigger;
	datasetId?: string;
}

const KNOWN_TRIGGERS: Record<string, true> = { "merge-to-main": true, "skills-sync-fast-forward": true };

export const BUILTIN_REGISTRY: readonly DatasetEntry[] = [
	{
		name: "agent-substrate",
		slug: "swcstudiospace/agent-substrate",
		include: ["README.md", "docs/**/*.md", ".planning/PROJECT.md"],
		// Receipts are a "Never" for RAGFlow in the data-planes table.
		exclude: ["docs/receipts/**"],
		trigger: "merge-to-main",
	},
	{
		name: "agent-skills",
		slug: "swcstudiospace/agent-skills",
		include: ["**/SKILL.md", "**/references/**"],
		exclude: [],
		trigger: "skills-sync-fast-forward",
	},
	{
		name: "programming-desk",
		slug: "swcstudiospace/programming-desk",
		include: ["docs/**", "skills/**", "contracts/**", "ARCHITECTURE.md", "prompts-assembled/**"],
		// Receipts are a "Never" for RAGFlow in the data-planes table.
		exclude: ["docs/receipts/**"],
		trigger: "merge-to-main",
	},
	// Provisional entries (operator open question 3 in 25-CONTEXT.md): the
	// proposed default slug and roots until the operator confirms each repo.
	{
		name: "kanbanos",
		slug: "swcstudiospace/kanbanos",
		include: ["README.md", "docs/**"],
		// Receipts are a "Never" for RAGFlow in the data-planes table.
		exclude: ["docs/receipts/**"],
		trigger: "merge-to-main",
	},
	{
		name: "desklanes",
		slug: "swcstudiospace/desklanes",
		include: ["README.md", "docs/**"],
		// Receipts are a "Never" for RAGFlow in the data-planes table.
		exclude: ["docs/receipts/**"],
		trigger: "merge-to-main",
	},
	{
		name: "clippyos",
		slug: "swcstudiospace/clippyos",
		include: ["README.md", "docs/**"],
		// Receipts are a "Never" for RAGFlow in the data-planes table.
		exclude: ["docs/receipts/**"],
		trigger: "merge-to-main",
	},
	{
		name: "auctioning",
		slug: "swcstudiospace/auctioning",
		include: ["README.md", "docs/**"],
		// Receipts are a "Never" for RAGFlow in the data-planes table.
		exclude: ["docs/receipts/**"],
		trigger: "merge-to-main",
	},
];

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDatasetEntry(value: unknown): value is DatasetEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	if (typeof entry.name !== "string" || entry.name.length === 0) return false;
	if (typeof entry.slug !== "string" || entry.slug.length === 0) return false;
	if (!isStringList(entry.include) || !isStringList(entry.exclude)) return false;
	if (typeof entry.trigger !== "string" || KNOWN_TRIGGERS[entry.trigger] !== true) return false;
	if (entry.datasetId !== undefined && typeof entry.datasetId !== "string") return false;
	return true;
}

function builtin(): DatasetEntry[] {
	return BUILTIN_REGISTRY.map((entry) => ({ ...entry, include: [...entry.include], exclude: [...entry.exclude] }));
}

/**
 * The active registry: the `SUBSTRATE_DOCS_DATASETS` JSON file when set and
 * holding a valid array (invalid entries dropped), else the builtin one.
 * Never throws. `readFile` is a seam for tests.
 */
export function loadRegistry(
	env: Record<string, string | undefined> = process.env,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): DatasetEntry[] {
	const file = env.SUBSTRATE_DOCS_DATASETS?.trim();
	if (!file) return builtin();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFile(file)) as unknown;
	} catch {
		return builtin();
	}
	if (!Array.isArray(parsed)) return builtin();
	return parsed
		.filter(isDatasetEntry)
		.map((entry) => ({ ...entry, include: [...entry.include], exclude: [...entry.exclude] }));
}

export function findDataset(registry: readonly DatasetEntry[], name: string): DatasetEntry | undefined {
	return registry.find((entry) => entry.name === name);
}

/** One row of RAGFlow's dataset list, as `resolveDatasetId` needs it. */
export interface DatasetSummary {
	id: string;
	name: string;
}

export type DatasetResolution = { ok: true; datasetId: string } | { ok: false; reason: "unknown-dataset" };

/** Name → RAGFlow id, so the dataset list is asked once per dataset. */
const idCache = new Map<string, string>();

export function clearDatasetCache(): void {
	idCache.clear();
}

/**
 * Resolve a registry *name* to its RAGFlow id. A static `datasetId` on the
 * entry wins without listing; otherwise the list is consulted once and
 * cached. Unknown names resolve to a typed `unknown-dataset` outcome — raw
 * RAGFlow ids are never accepted here. Rejects only when `listDatasets`
 * itself fails; the caller maps that to its own error.
 */
export async function resolveDatasetId(
	registry: readonly DatasetEntry[],
	name: string,
	listDatasets: () => Promise<readonly DatasetSummary[]>,
): Promise<DatasetResolution> {
	const entry = findDataset(registry, name);
	if (!entry) return { ok: false, reason: "unknown-dataset" };
	if (entry.datasetId) return { ok: true, datasetId: entry.datasetId };
	const cached = idCache.get(name);
	if (cached !== undefined) return { ok: true, datasetId: cached };
	const datasets = await listDatasets();
	const match = datasets.find((dataset) => dataset.name === name);
	if (!match) return { ok: false, reason: "unknown-dataset" };
	idCache.set(name, match.id);
	return { ok: true, datasetId: match.id };
}
