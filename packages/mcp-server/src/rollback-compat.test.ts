/**
 * Rollback compatibility (uplift-5 S1a): what `deploy-release.sh rollback`
 * leaves behind must still be readable by the release it rolls back to.
 *
 * A rollback restores CODE only. The state files, cache values and ledger
 * tables the newer release wrote stay where they are, and the older release
 * reads them. The production release at the time of uplifts 3 and 4 is git
 * commit `9231f43`; its source is not in this tree, so these tests cannot run
 * it. They do the next best thing, in two directions:
 *
 *   (i)  the CURRENT writers' REAL output (the real `saveIngestRecords`, the
 *        real `Substrate.briefDetailed` cache write, the real `RetainOutbox`)
 *        is judged against a FROZEN copy of what the 9231f43 readers require,
 *        and may only ADD keys from a short, named allow-list;
 *   (ii) shapes the 9231f43 writers produced, frozen under
 *        `fixtures/rollback-9231f43/`, are fed to the CURRENT readers, because
 *        a rollback followed by a roll-forward reads the old release's writes.
 *
 * Each frozen requirement is a function that returns a list of violations, and
 * every violation names the old `file:line` that imposes it. Dropping or
 * renaming a key the old reader needs therefore fails with, for example,
 * `docs-ingest.ts:574 requires records["…"].sha to be a string`, and the
 * "names the requirement" tests below prove each citation fires by deleting
 * that key from the real output.
 *
 * Not covered, on purpose: the SLO checkpoint (9231f43 has no reader for it:
 * `git grep -n -i "slo-checkpoint\|SLO_CHECKPOINT" 9231f43` is empty), the
 * `metric_samples` ledger table (opt-in, never read by 9231f43), and the
 * `recall-snapshot` cache class (9231f43 never asks for that key). See
 * `docs/runbooks/rollback-compat.md`.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { DOCS_STATE_KNOWN_VERSION, run as runPreflight } from "../../../scripts/deploy-preflight.ts";
import { isAdditiveStatement, normalizedStatements } from "../../../scripts/migration-digests.ts";
import { decodeSections } from "./brief-profile.ts";
import { ReadThroughCache, type CacheRedis } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { createFreshnessState, type FreshnessState } from "./docs-freshness.ts";
import { createVersionStore, recordTrigger, recordVersion, type VersionStore } from "./docs-datasets.ts";
import { loadIngestRecords, saveIngestRecords, type IngestRecord } from "./docs-ingest.ts";
import { RetainOutbox, type RetainOutboxEntry } from "./retain-outbox.ts";
import { Substrate } from "./service.ts";
import { MIGRATION_STEPS, type MigrationStep } from "./index-store.ts";
import { defined } from "./test-support.ts";

const FIXTURES = join(import.meta.dir, "../../../fixtures/rollback-9231f43");

/** Every scratch directory a test made, removed once the file's tests are done. */
const scratchDirs: string[] = [];
afterAll(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "rollback-compat-"));
	scratchDirs.push(dir);
	return dir;
}

function fixtureText(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keys of `value` that are not in `allowed`: what a writer ADDED beyond the shape the old reader was written against. */
function extraKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
	return Object.keys(value).filter((key) => !allowed.includes(key));
}

// ── docs state file ──────────────────────────────────────────────────────────

/** Top-level keys 9231f43's `saveIngestRecords` wrote (`docs-ingest.ts:605`). */
const OLD_DOCS_TOP = ["version", "records", "versions"];
/** Keys of one record (`IngestRecord`, `docs-ingest.ts:218-225`). */
const OLD_DOCS_RECORD = ["sha", "dataset_id", "source_url", "document_id", "commit", "superseded"];
/** Keys of one version row (`DatasetVersion`, `docs-datasets.ts:35-42`). */
const OLD_DOCS_VERSION = ["dataset", "dataset_id", "version", "commit", "content_sha256", "ingested_at"];
/** What uplift-4 S7 added at the top level, both optional (`docs-ingest.ts:546-552`). The only additions allowed. */
const NEW_DOCS_TOP_OPTIONAL = ["triggers", "lag"];
/**
 * What the expected_version change added to each record: `version`. The old reader rebuilds a record from the known
 * keys only, so it ignores this one; a rollback loses the version (it re-reads as 1), not the record.
 */
const NEW_DOCS_RECORD_KEYS = ["version"];

/**
 * Everything the 9231f43 `loadIngestRecords` needs from a state file, frozen.
 * Each entry says which old line imposes it and what the old reader does
 * when it is not met (here: starts with empty records, or skips the row, so
 * the rollback silently loses pins and dedupe).
 */
function oldDocsStateViolations(file: unknown): string[] {
	const violations: string[] = [];
	if (!isObject(file)) return ["docs-ingest.ts:563 requires the file to be a JSON object"];
	// docs-ingest.ts:543 (`version: 2;` in IngestStateFile) and :605 (the writer): the old writer's version. The old reader never checks it; pinned so a bump is a decision, not an accident.
	if (file.version !== 2) violations.push("docs-ingest.ts:543,605 the old writer emits version 2");
	const records = file.records;
	if (!isObject(records)) {
		violations.push("docs-ingest.ts:563 requires a top-level `records` object");
	} else {
		for (const [key, record] of Object.entries(records)) {
			if (!isObject(record)) {
				violations.push(`docs-ingest.ts:572 requires records[${JSON.stringify(key)}] to be an object`);
				continue;
			}
			// docs-ingest.ts:573-574: a record missing or mistyping any of the four is skipped, and the page is re-uploaded.
			for (const name of ["sha", "dataset_id", "source_url", "document_id"]) {
				if (typeof record[name] !== "string") violations.push(`docs-ingest.ts:574 requires records[${JSON.stringify(key)}].${name} to be a string`);
			}
			// docs-ingest.ts:576-590: optional, but read only at these types.
			if (record.commit !== undefined && typeof record.commit !== "string") violations.push(`docs-ingest.ts:590 reads records[${JSON.stringify(key)}].commit only as a string`);
			if (record.superseded !== undefined) {
				if (!Array.isArray(record.superseded)) {
					violations.push(`docs-ingest.ts:578 reads records[${JSON.stringify(key)}].superseded only as an array`);
				} else {
					for (const entry of record.superseded) {
						if (!isObject(entry) || typeof entry.document_id !== "string") violations.push(`docs-ingest.ts:580 requires superseded[].document_id to be a string in ${JSON.stringify(key)}`);
						else if (entry.commit !== undefined && typeof entry.commit !== "string") violations.push(`docs-ingest.ts:581 reads superseded[].commit only as a string in ${JSON.stringify(key)}`);
					}
				}
			}
		}
	}
	// docs-ingest.ts:594 and docs-datasets.ts:88-118: `versions` is an object of arrays of rows with six string fields; other rows are skipped.
	if (file.versions !== undefined) {
		if (!isObject(file.versions)) {
			violations.push("docs-datasets.ts:90 requires `versions` to be an object keyed by dataset");
		} else {
			for (const [dataset, rows] of Object.entries(file.versions)) {
				if (!Array.isArray(rows)) {
					violations.push(`docs-datasets.ts:92 requires versions[${JSON.stringify(dataset)}] to be an array`);
					continue;
				}
				for (const row of rows) {
					for (const name of OLD_DOCS_VERSION) {
						if (!isObject(row) || typeof row[name] !== "string") violations.push(`docs-datasets.ts:97-103 requires versions[${JSON.stringify(dataset)}][].${name} to be a string`);
					}
				}
			}
		}
	}
	return violations;
}

/** A parsed state file, loosely typed so a test can delete keys from a clone of the real output. */
interface DocsStateDoc {
	version?: unknown;
	records?: Record<string, { superseded?: Array<Record<string, unknown>> } & Record<string, unknown>>;
	versions?: Record<string, Array<Record<string, unknown>>>;
}

/** Records with every optional key, two datasets of versions, and (optionally) uplift-4 S7 freshness, all built through the real constructors. */
function docsStateInputs(withFreshness: boolean): { file: string; seen: Map<string, IngestRecord>; versions: VersionStore; freshness: FreshnessState } {
	const file = join(scratch(), "docs-ingest.json");
	const seen = new Map<string, IngestRecord>();
	seen.set("agent-substrate docs/data-planes.md", {
		sha: "a".repeat(64),
		dataset_id: "ds_agent_substrate",
		source_url: "agent-substrate://docs/data-planes.md",
		document_id: "doc_1",
		commit: "c".repeat(40),
		superseded: [{ document_id: "doc_0", commit: "b".repeat(40) }, { document_id: "doc_older" }],
		version: 3,
	});
	seen.set("agent-substrate README.md", {
		sha: "d".repeat(64),
		dataset_id: "ds_agent_substrate",
		source_url: "agent-substrate://README.md",
		document_id: "doc_2",
		version: 1,
	});
	const versions = createVersionStore();
	recordVersion(versions, { dataset: "agent-substrate", dataset_id: "ds_agent_substrate", version: "v1", commit: "b".repeat(40), content_sha256: "e".repeat(64), ingested_at: "2026-10-13T08:00:00.000Z", backend: "ragflow" });
	recordVersion(versions, { dataset: "agent-skills", dataset_id: "ds_agent_skills", version: "v1", commit: "c".repeat(40), content_sha256: "f".repeat(64), ingested_at: "2026-10-13T09:00:00.000Z", backend: "ragflow" });
	const freshness = createFreshnessState();
	if (withFreshness) {
		recordTrigger(freshness.triggers, "agent-substrate", { commit: "c".repeat(40), content_sha256: "e".repeat(64), received_at: "2026-10-14T08:00:00.000Z" });
		freshness.lag.set("agent-substrate", { since: "2026-10-14T08:05:00.000Z", commit: "c".repeat(40), warned: false });
	}
	return { file, seen, versions, freshness };
}

/** The state file as the current `saveIngestRecords` writes it, parsed. */
async function writeRealDocsState(withFreshness: boolean): Promise<{ file: string; parsed: Record<string, unknown> }> {
	const state = docsStateInputs(withFreshness);
	await saveIngestRecords(state.file, state.seen, state.versions, state.freshness);
	return { file: state.file, parsed: JSON.parse(readFileSync(state.file, "utf8")) as Record<string, unknown> };
}

describe("docs state file (docs-ingest.json): the current writer against the 9231f43 reader", () => {
	test("the real output, with uplift-4 triggers and lag set, meets every old requirement and only adds `triggers`, `lag`, the record `version`, and the version row's `backend`", async () => {
		const { parsed } = await writeRealDocsState(true);
		expect(oldDocsStateViolations(parsed)).toEqual([]);
		// The additions are exactly the two optional members: anything else is a new key the old release has never seen.
		expect(extraKeys(parsed, OLD_DOCS_TOP).sort()).toEqual([...NEW_DOCS_TOP_OPTIONAL].sort());
		for (const record of Object.values(parsed.records as Record<string, Record<string, unknown>>)) {
			expect(extraKeys(record, OLD_DOCS_RECORD).sort()).toEqual([...NEW_DOCS_RECORD_KEYS].sort());
		}
		for (const rows of Object.values(parsed.versions as Record<string, Array<Record<string, unknown>>>)) {
			// The backend stamp is the one row addition. A row without it loads as ragflow, so an older state still completes RAGFlow replays.
			for (const row of rows) expect(Object.keys(row).sort()).toEqual([...OLD_DOCS_VERSION, "backend"].sort());
		}
		expect(parsed.version).toBe(2);
	});

	test("with nothing triggered the file has exactly the keys 9231f43 wrote", async () => {
		const { parsed } = await writeRealDocsState(false);
		expect(Object.keys(parsed).sort()).toEqual([...OLD_DOCS_TOP].sort());
		expect(oldDocsStateViolations(parsed)).toEqual([]);
	});

	test("each frozen requirement names its old line: dropping the key from the real output turns exactly that citation red", async () => {
		const { parsed } = await writeRealDocsState(true);
		const cases: Array<[string, (clone: DocsStateDoc) => void, string]> = [
			["records", (clone) => delete clone.records, "docs-ingest.ts:563"],
			["a record's sha", (clone) => delete clone.records?.["agent-substrate README.md"]?.sha, "docs-ingest.ts:574"],
			["a record's dataset_id", (clone) => delete clone.records?.["agent-substrate README.md"]?.dataset_id, "docs-ingest.ts:574"],
			["a record's source_url", (clone) => delete clone.records?.["agent-substrate README.md"]?.source_url, "docs-ingest.ts:574"],
			["a record's document_id", (clone) => delete clone.records?.["agent-substrate README.md"]?.document_id, "docs-ingest.ts:574"],
			["a superseded document_id", (clone) => delete clone.records?.["agent-substrate docs/data-planes.md"]?.superseded?.[0]?.document_id, "docs-ingest.ts:580"],
			["a version row's commit", (clone) => delete clone.versions?.["agent-substrate"]?.[0]?.commit, "docs-datasets.ts:97-103"],
			["a version row's content_sha256", (clone) => delete clone.versions?.["agent-skills"]?.[0]?.content_sha256, "docs-datasets.ts:97-103"],
			["the version number", (clone) => (clone.version = 3), "docs-ingest.ts:543,605"],
			["versions as an array", (clone) => Object.assign(clone, { versions: [] }), "docs-datasets.ts:90"],
		];
		for (const [label, mutate, citation] of cases) {
			const clone = structuredClone(parsed) as DocsStateDoc;
			mutate(clone);
			const violations = oldDocsStateViolations(clone);
			expect(violations.length, `${label} must be a violation`).toBeGreaterThan(0);
			expect(
				violations.some((violation) => violation.startsWith(citation)),
				`${label}: expected a violation citing ${citation}, got ${JSON.stringify(violations)}`,
			).toBe(true);
		}
	});

	test("a state file written by 9231f43 is loaded whole by the current reader, and saved back it still satisfies the old one", async () => {
		const file = join(scratch(), "docs-ingest.json");
		copyFileSync(join(FIXTURES, "docs-ingest.json"), file);
		// The fixture is itself the old shape: guard against it drifting into something else.
		expect(oldDocsStateViolations(JSON.parse(fixtureText("docs-ingest.json")))).toEqual([]);

		const loaded = await loadIngestRecords(file);
		expect(loaded.problem).toBeUndefined();
		expect([...loaded.records.keys()]).toEqual(["agent-substrate docs/data-planes.md", "agent-substrate README.md"]);
		expect(loaded.records.get("agent-substrate docs/data-planes.md")).toEqual({
			sha: "1f0c2a9d5b7e4c63a8d0f1e2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2",
			dataset_id: "ds_agent_substrate",
			source_url: "agent-substrate://docs/data-planes.md",
			document_id: "doc_0001",
			commit: "9231f4396be5e38ef00db1313c6fae79ea2aace1",
			superseded: [{ document_id: "doc_0000", commit: "490e007000000000000000000000000000000000" }, { document_id: "doc_old_no_commit" }],
			// A record written before versions existed loads as version 1: it was ingested once.
			version: 1,
		});
		expect(loaded.versions.get("agent-substrate")?.map((row) => row.version)).toEqual(["v1", "v2"]);
		expect(loaded.versions.get("agent-skills")?.[0]?.commit).toBe("354310c000000000000000000000000000000000");
		// No uplift-4 members in the old file: nothing is owed, nothing is invented.
		expect(loaded.freshness.triggers.size).toBe(0);
		expect(loaded.freshness.lag.size).toBe(0);

		// Roll forward, save, roll back: the file is still one the old release reads, with every record kept.
		await saveIngestRecords(file, loaded.records, loaded.versions, loaded.freshness);
		const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		expect(oldDocsStateViolations(saved)).toEqual([]);
		expect(Object.keys(saved).sort()).toEqual([...OLD_DOCS_TOP].sort());
		expect(Object.keys(saved.records as object)).toHaveLength(2);
	});

	test("what an old release drops on its next save (triggers, lag) is tolerated: the new reader loads the stripped file with empty freshness", async () => {
		const { file, parsed } = await writeRealDocsState(true);
		const stripped = { version: parsed.version, records: parsed.records, versions: parsed.versions };
		writeFileSync(file, `${JSON.stringify(stripped)}\n`);
		const loaded = await loadIngestRecords(file);
		expect(loaded.problem).toBeUndefined();
		expect(loaded.records.size).toBe(2);
		expect(loaded.freshness.triggers.size).toBe(0);
		expect(loaded.freshness.lag.size).toBe(0);
	});
});

// ── brief-snapshot cache envelope ────────────────────────────────────────────

/** `cache.ts:138-157` of 9231f43: keys sorted at every depth, `undefined` dropped. Copied, not imported: the point is the OLD algorithm. */
function frozenCanonical(value: unknown): string {
	const order = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(order);
		if (node && typeof node === "object") {
			const source = node as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(source).sort()) if (source[key] !== undefined) out[key] = order(source[key]);
			return out;
		}
		return node;
	};
	return JSON.stringify(order(value));
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** `cache.ts:175-178`: the generation-free key of a snapshot. */
function oldSnapshotKey(surface: string, args: unknown): string {
	return `substrate:v1:brief-snapshot:${sha256(frozenCanonical({ surface, args }))}`;
}

/** `cache.ts:164-167`: the key of a generation-scoped entry. */
function oldBriefKey(surface: string, generation: string, args: unknown): string {
	return `substrate:v1:brief:${sha256(frozenCanonical({ surface, generation, args }))}`;
}

/**
 * What the 9231f43 `peek("brief-snapshot")` needs from a stored string, frozen:
 * `{ "v": { "text": string, "at": string } }` (`cache.ts:521` writes `{ v: value }`,
 * `:648-655` reads it, `:625-628` is the shape check, `service.ts:1087-1097` uses
 * `snapshot.text` and `snapshot.at`). A value failing any of it is a miss: the
 * old release serves a thin degraded brief instead of the last good one.
 */
function oldSnapshotEnvelopeViolations(raw: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return ["cache.ts:648 requires the stored value to be JSON"];
	}
	if (!isObject(parsed) || !("v" in parsed)) return ['cache.ts:651 requires an object with a "v" member'];
	const value = parsed.v;
	if (!isObject(value)) return ["cache.ts:626 requires v to be an object"];
	const violations: string[] = [];
	if (typeof value.text !== "string") violations.push("cache.ts:628 requires v.text to be a string");
	if (typeof value.at !== "string") violations.push("cache.ts:628 requires v.at to be a string");
	return violations;
}

/** The members the old envelope's `v` had (`service.ts:355-358`) and the only two uplift-4 S1 and S4 added, both optional. */
const OLD_SNAPSHOT_KEYS = ["text", "at"];
const NEW_SNAPSHOT_OPTIONAL = ["sections", "until"];

class MapRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}
	async set(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}
	async incr(key: string): Promise<number> {
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

const REQUEST = { surface: "cursor" as const, repo: "acme/app", graph_id: "ut-1" };
/** What both releases put in the brief's cache arguments at default flags (`service.ts:1047-1051` of 9231f43). */
const OLD_BRIEF_ARGS = { repo: "acme/app", branch: null, graph_id: "ut-1" };

function graphView() {
	return {
		graph_id: "ut-1",
		notion_task_page: null,
		repo: "acme/app",
		branch: null,
		surface: "cursor",
		status: "active",
		pr_url: null,
		created: null,
		updated: null,
		nodes: [],
		steps: [],
		edges: [],
	};
}

/** A default-config Substrate over a fake index and a map-backed cache. `down` makes the graph read throw, which degrades the brief. */
function briefRig() {
	const redis = new MapRedis();
	const state = { down: false };
	const index = {
		getGraph: async () => {
			if (state.down) throw new Error("postgres is down");
			return graphView();
		},
		openGraphs: async () => [],
		memoryForBrief: async () => [],
	};
	const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
	const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null, cache, steering: { history: null, liveSessions: null } });
	return { substrate, redis, state };
}

function keysWithPrefix(redis: MapRedis, prefix: string): string[] {
	return [...redis.values.keys()].filter((key) => key.startsWith(prefix));
}

describe("brief-snapshot envelope: the current writer against the 9231f43 reader", () => {
	test("a complete brief at default flags is stored under the key 9231f43 looks up, in an envelope it accepts, adding only `sections` and `until`", async () => {
		const { substrate, redis } = briefRig();
		const brief = await substrate.briefDetailed(REQUEST);
		expect(brief.state).toBe("complete");

		const snapshotKeys = keysWithPrefix(redis, "substrate:v1:brief-snapshot:");
		// The old release must find it: same class, same hash of (surface, repo, branch, graph_id).
		expect(snapshotKeys).toEqual([oldSnapshotKey("cursor", OLD_BRIEF_ARGS)]);
		const raw = redis.values.get(snapshotKeys[0] ?? "") ?? "";
		expect(oldSnapshotEnvelopeViolations(raw)).toEqual([]);

		const value = (JSON.parse(raw) as { v: Record<string, unknown> }).v;
		expect(extraKeys(value, OLD_SNAPSHOT_KEYS).sort()).toEqual([...NEW_SNAPSHOT_OPTIONAL].sort());
		// What the old release prints is what this one served: `text` is the rendered brief, never the encoded sections.
		expect(value.text).toBe(brief.text);
		expect(decodeSections(value.text)).toBeNull();
		expect(typeof value.at).toBe("string");
	});

	test("the sections-encoded `brief` entry is never under a key 9231f43 reads as brief text", async () => {
		const { substrate, redis } = briefRig();
		await substrate.briefDetailed(REQUEST);
		const briefKeys = keysWithPrefix(redis, "substrate:v1:brief:");
		expect(briefKeys).toHaveLength(1);
		// Fresh generations (no write yet): memory, graphs and the graph's own, all "0" (`service.ts:1059-1062`).
		const oldKey = oldBriefKey("cursor", "0:0:0", OLD_BRIEF_ARGS);
		// The old release's `brief` shape check is only `typeof value === "string"` (`cache.ts:624`), and the new
		// value IS a string: if the keys collided, 9231f43 would answer with a JSON document as the brief.
		const stored = (JSON.parse(redis.values.get(briefKeys[0] ?? "") ?? "null") as { v: string }).v;
		expect(typeof stored).toBe("string");
		expect(decodeSections(stored)).not.toBeNull();
		expect(briefKeys[0]).not.toBe(oldKey);
		expect(redis.values.has(oldKey)).toBe(false);
	});

	test("an envelope written by 9231f43, with no sections and no until, is served as the snapshot while a source is down", async () => {
		const { substrate, redis, state } = briefRig();
		const raw = fixtureText("brief-snapshot-envelope.json").trim();
		expect(oldSnapshotEnvelopeViolations(raw)).toEqual([]);
		const old = JSON.parse(raw) as { v: { text: string; at: string } };
		redis.values.set(oldSnapshotKey("cursor", OLD_BRIEF_ARGS), raw);
		state.down = true;

		const served = await substrate.briefDetailed(REQUEST);
		expect(served.state).toBe("snapshot");
		expect(served.snapshotAt).toBe(old.v.at);
		expect(served.text).toContain(`substrate brief snapshot from ${old.v.at}`);
		expect(served.text).toContain(old.v.text);
		// Nothing about the old value was rewritten by serving it.
		expect(redis.values.get(oldSnapshotKey("cursor", OLD_BRIEF_ARGS))).toBe(raw);
	});

	test("each frozen envelope requirement names its old line: dropping the key from the real value turns that citation red", async () => {
		const { substrate, redis } = briefRig();
		await substrate.briefDetailed(REQUEST);
		const raw = redis.values.get(oldSnapshotKey("cursor", OLD_BRIEF_ARGS)) ?? "";
		const parsed = JSON.parse(raw) as { v: Record<string, unknown> };
		const cases: Array<[string, unknown, string]> = [
			["text", { v: { ...parsed.v, text: undefined } }, "cache.ts:628 requires v.text"],
			["text as a number", { v: { ...parsed.v, text: 1 } }, "cache.ts:628 requires v.text"],
			["at", { v: { ...parsed.v, at: undefined } }, "cache.ts:628 requires v.at"],
			["the v member", { value: parsed.v }, "cache.ts:651"],
		];
		for (const [label, mutated, citation] of cases) {
			const violations = oldSnapshotEnvelopeViolations(JSON.stringify(mutated));
			expect(
				violations.some((violation) => violation.startsWith(citation)),
				`${label}: expected ${citation}, got ${JSON.stringify(violations)}`,
			).toBe(true);
		}
	});
});

// ── retain outbox ────────────────────────────────────────────────────────────

/** Keys of one parked retain (`retain-outbox.ts:121-138` of 9231f43; the entry check is `isEntry` in `retain-outbox.ts` now). `session_id` is optional. */
const OLD_OUTBOX_KEYS = ["id", "bank", "document_id", "entry_id", "surface", "entry_hash", "session_id", "attempts", "next_at", "last_reason", "enqueued_at"];

/**
 * What the 9231f43 `RetainOutbox.hydrate` needs from one JSONL line, frozen. Each line is one JSON object that passes `isEntry`.
 * The line handling 9231f43 did at `:393`, `:406` (write `JSON.stringify(entry)`) and `:359-363` (split on newlines and parse)
 * now lives in `outbox-file.ts` (`OutboxFile.append`, `rewrite` and `read`); `isEntry` (`:121-138` of 9231f43) stays in
 * `retain-outbox.ts`. A line that fails is counted malformed and skipped: the parked retain is lost.
 */
function oldOutboxLineViolations(line: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return ["retain-outbox.ts:363 requires every line to be one JSON value"];
	}
	if (!isObject(parsed)) return ["retain-outbox.ts:122 requires every line to be an object"];
	const violations: string[] = [];
	for (const name of ["id", "bank", "document_id", "entry_id", "surface", "entry_hash", "last_reason"]) {
		if (typeof parsed[name] !== "string") violations.push(`retain-outbox.ts:125-130,134 requires ${name} to be a string`);
	}
	if (parsed.session_id !== undefined && typeof parsed.session_id !== "string") violations.push("retain-outbox.ts:131 reads session_id only as a string");
	for (const name of ["attempts", "next_at", "enqueued_at"]) {
		if (typeof parsed[name] !== "number") violations.push(`retain-outbox.ts:132-133,135 requires ${name} to be a number`);
	}
	return violations;
}

function jsonlLines(path: string): string[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "");
}

describe("retain outbox (retain-outbox.jsonl): the current writer against the 9231f43 reader", () => {
	test("lines written by an enqueue and rewritten by a drain meet every old requirement and add no key", async () => {
		const path = join(scratch(), "retain-outbox.jsonl");
		const outbox = new RetainOutbox({ path, now: () => 1_760_428_800_000, random: () => 0.5, max: 100 });
		outbox.enqueue({ bank: "sub-cursor", document_id: "doc-1", entry_id: "mem_1", surface: "cursor", entry_hash: "h1", reason: "retain-timeout" });
		outbox.enqueue({ bank: "sub-grok-bot", document_id: "doc-2", entry_id: "mem_2", surface: "grok-bot", entry_hash: "h2", session_id: "sess-1", reason: "retain-server" });
		// The appended lines, then the compacted rewrite a failed replay causes: both are writes a rollback can meet.
		const appended = jsonlLines(path);
		expect(appended).toHaveLength(2);
		await outbox.drain(async () => ({ transient: "retain-server" }), { all: true });
		const compacted = jsonlLines(path);
		expect(compacted).toHaveLength(2);

		for (const line of [...appended, ...compacted]) {
			expect(oldOutboxLineViolations(line)).toEqual([]);
			expect(extraKeys(JSON.parse(line) as Record<string, unknown>, OLD_OUTBOX_KEYS)).toEqual([]);
		}
		const second = JSON.parse(compacted[1] ?? "{}") as RetainOutboxEntry;
		expect(second.session_id).toBe("sess-1");
		// The rewrite really did change the attempts, so the compact path was exercised, not a copy of the append.
		expect(second.attempts).toBe(2);
	});

	test("each frozen line requirement names its old line: dropping the key from the real output turns that citation red", () => {
		const path = join(scratch(), "retain-outbox.jsonl");
		const outbox = new RetainOutbox({ path, now: () => 1_760_428_800_000, random: () => 0.5 });
		outbox.enqueue({ bank: "sub-cursor", document_id: "doc-1", entry_id: "mem_1", surface: "cursor", entry_hash: "h1", session_id: "s", reason: "retain-timeout" });
		const real = JSON.parse(jsonlLines(path)[0] ?? "{}") as Record<string, unknown>;
		for (const name of Object.keys(real)) {
			if (name === "session_id") continue;
			const clone = { ...real };
			delete clone[name];
			const violations = oldOutboxLineViolations(JSON.stringify(clone));
			expect(
				violations.some((violation) => violation.includes(`requires ${name} to be`)),
				`dropping ${name}: got ${JSON.stringify(violations)}`,
			).toBe(true);
		}
		expect(oldOutboxLineViolations(JSON.stringify({ ...real, attempts: "2" }))).toContain("retain-outbox.ts:132-133,135 requires attempts to be a number");
	});

	test("a file written by 9231f43 is hydrated by the current outbox (last line per document wins, a torn line is skipped) and rewritten in a shape the old one reads", () => {
		const path = join(scratch(), "retain-outbox.jsonl");
		copyFileSync(join(FIXTURES, "retain-outbox.jsonl"), path);
		const lines = fixtureText("retain-outbox.jsonl").split("\n").filter((line) => line.trim() !== "");
		// The three whole lines are old-shape; the last is torn on purpose.
		for (const line of lines.slice(0, 3)) expect(oldOutboxLineViolations(line)).toEqual([]);
		expect(oldOutboxLineViolations(lines[3] ?? "")).not.toEqual([]);

		const written: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as unknown as typeof process.stderr.write;
		let outbox: RetainOutbox;
		try {
			outbox = new RetainOutbox({ path, now: () => 1_760_428_900_000 });
		} finally {
			process.stderr.write = realWrite;
		}
		expect(written.join("")).toContain("skipped 1 malformed line(s)");
		const parked = outbox.list();
		expect(parked.map((entry) => entry.document_id)).toEqual(["doc-2", "doc-1"]);
		expect(parked.find((entry) => entry.document_id === "doc-1")?.attempts).toBe(3);
		expect(parked.find((entry) => entry.document_id === "doc-2")?.session_id).toBe("sess-1");

		// The boot compaction left one whole line per entry, and the old release can read every one.
		const rewritten = jsonlLines(path);
		expect(rewritten).toHaveLength(2);
		for (const line of rewritten) expect(oldOutboxLineViolations(line)).toEqual([]);
	});
});

// ── the preflight against the real writers ───────────────────────────────────

describe("deploy preflight (scripts/deploy-preflight.ts) reads what the real writers wrote", () => {
	test("a state directory written by the real saveIngestRecords (triggers and lag set) and the real RetainOutbox passes, and the version the preflight knows is the one the writer writes", async () => {
		const { file, parsed } = await writeRealDocsState(true);
		const stateDir = dirname(file);
		const outbox = new RetainOutbox({ path: join(stateDir, "retain-outbox.jsonl"), now: () => 1_760_428_800_000, random: () => 0.5 });
		outbox.enqueue({ bank: "b1", document_id: "d1", entry_id: "e1", surface: "cursor", entry_hash: "h1", reason: "retain-timeout" });
		outbox.enqueue({ bank: "b2", document_id: "d2", entry_id: "e2", surface: "omp", entry_hash: "h2", session_id: "s", reason: "retain-server" });
		// The constant the preflight rejects newer files by is tied to what the writer actually writes.
		expect(parsed.version).toBe(DOCS_STATE_KNOWN_VERSION);

		const out: string[] = [];
		const empty = scratch();
		const code = await runPreflight(
			{ releaseDir: join(import.meta.dir, "../../.."), envFiles: [], stateDir, unitsDir: empty, installedUnitsDir: empty, json: true },
			{ stdout: (text) => out.push(text), stderr: () => {}, env: { SUBSTRATE_DEPLOY_MIN_FREE_GB: "0" } },
		);
		const findings = (JSON.parse(out.join("")) as { findings: Array<{ name: string; level: string; reason: string }> }).findings;
		const pick = (name: string) => findings.find((item) => item.name === name);
		expect(pick("docs-ingest.json")).toMatchObject({ level: "ok", reason: "2 record(s), 2 dataset version list(s)" });
		expect(pick("retain-outbox.jsonl")).toMatchObject({ level: "ok", reason: "2 entries" });
		expect(findings.filter((item) => item.level === "error")).toEqual([]);
		expect(code).toBe(0);
	});
});

// ── the index (Postgres) schema: steps added since the reference release ─────

/**
 * `9231f43` has no `MIGRATION_STEPS` and no `schema_migrations` ledger: `git show 9231f43:packages/mcp-server/src/index-store.ts`
 * contains neither, because its `IndexStore.migrate()` ran the DDL inline and unledgered (the ledger and the step list
 * arrived in `feb597f`). So there is no "step count at the reference release"; what can be proved is which of today's
 * steps create an object the 9231f43 source does not have. `git grep skills_registry 9231f43 -- packages` is empty (steps
 * 17 and 18 create the table and its index, step 32 adds a column to it), and `memory_entries_repo_idx` (step 31) is absent
 * from the 9231f43 index-store.ts. Every other step's table, column or index is in that file's inline DDL (checked by
 * searching the file for each created name).
 *
 * Those are the steps below. Numbering is not release order (steps 19-30 were extracted from inline DDL that 9231f43
 * already had), so the pin is this explicit set plus a rule: any step numbered above `LAST_STEP_AT_PIN`, the highest
 * version when this pin was written, was added after the reference too.
 */
const STEPS_ADDED_SINCE_REFERENCE: Readonly<Record<number, string>> = {
	17: "skills_registry",
	18: "skills_registry_state_idx",
	31: "memory_entries_repo_idx",
	32: "skills_registry_version",
	35: "corpus_documents",
	36: "worktrees",
	37: "steering_sessions",
	38: "corpus_reflect",
	39: "planning_page_hashes",
	40: "worktrees_changed_files",
	41: "worktrees_repo_lower_seen_idx",
};
/** The highest `MIGRATION_STEPS` version when the pin above was written (commit 9aec7a1). */
const LAST_STEP_AT_PIN = 32;

/** The steps an older release has never seen: the pinned set, and every step numbered above the pin. */
function stepsSinceReference(steps: ReadonlyArray<MigrationStep>): MigrationStep[] {
	return steps.filter((step) => STEPS_ADDED_SINCE_REFERENCE[step.version] !== undefined || step.version > LAST_STEP_AT_PIN);
}

/** Statements of `step` that an older release does not survive: anything but create table / create index / add column, all `if not exists`. */
function nonAdditiveStatements(step: Pick<MigrationStep, "sql">): string[] {
	return normalizedStatements(step.sql).filter((statement) => !isAdditiveStatement(statement));
}

/** Steps whose name is not written in backticks in `runbook`. */
function stepsMissingFromRunbook(steps: ReadonlyArray<Pick<MigrationStep, "version" | "name">>, runbook: string): number[] {
	return steps.filter((step) => !runbook.includes(`\`${step.name}\``)).map((step) => step.version);
}

describe("index (Postgres) migration steps added since the 9231f43 reference release", () => {
	const runbook = readFileSync(join(import.meta.dir, "../../../docs/runbooks/rollback-compat.md"), "utf8");

	test("the pinned steps are still the steps with those versions and names", () => {
		for (const [version, name] of Object.entries(STEPS_ADDED_SINCE_REFERENCE)) {
			expect(MIGRATION_STEPS.find((step) => step.version === Number(version))?.name).toBe(name);
		}
	});

	test("every step added since is additive: create table / create index / add column, all if not exists (a NOT NULL column has a default)", () => {
		for (const step of stepsSinceReference(MIGRATION_STEPS)) {
			// Step 48's only non-additive statement is its fail-closed guard: a do block that raises when the index is invalid, and drops nothing. Any other statement still fails the rule.
			const notAdditive = nonAdditiveStatements(step).filter((statement) => !(step.version === 48 && statement.toLowerCase().startsWith("do $$")));
			expect({ step: step.version, name: step.name, notAdditive }).toEqual({ step: step.version, name: step.name, notAdditive: [] });
		}
	});

	test("every step added since is named in docs/runbooks/rollback-compat.md", () => {
		const missing = stepsMissingFromRunbook(stepsSinceReference(MIGRATION_STEPS), runbook);
		expect({ unmentionedSteps: missing }).toEqual({ unmentionedSteps: [] });
	});

	test("the worktree registry step (phase 68) is one of the steps added since: a new table and its index, both guarded, and both named in the runbook", () => {
		const step = stepsSinceReference(MIGRATION_STEPS).find((candidate) => candidate.name === "worktrees");
		expect(step?.phase).toBe("expand");
		expect(nonAdditiveStatements(defined(step, "the worktrees step"))).toEqual([]);
		expect(step?.sql).toContain("create table if not exists worktrees");
		expect(step?.sql).toContain("create index if not exists worktrees_repo_seen_idx");
		expect(runbook).toContain("`worktrees_repo_seen_idx`");
	});

	test("the worktree changed-files step (phase 68) adds two columns to the registry table, nullable or defaulted, and is named in the runbook", () => {
		const step = stepsSinceReference(MIGRATION_STEPS).find((candidate) => candidate.name === "worktrees_changed_files");
		expect(step?.version).toBe(40);
		expect(step?.phase).toBe("expand");
		expect(nonAdditiveStatements(defined(step, "the worktrees_changed_files step"))).toEqual([]);
		expect(step?.sql).toContain("add column if not exists changed_files jsonb");
		expect(step?.sql).toContain("add column if not exists files_truncated boolean not null default false");
		expect(runbook).toContain("`worktrees_changed_files`");
	});

	test("the worktree repo-lookup step (phase 68) adds only the lower(repo) index, and is named in the runbook", () => {
		const step = stepsSinceReference(MIGRATION_STEPS).find((candidate) => candidate.name === "worktrees_repo_lower_seen_idx");
		expect(step?.version).toBe(41);
		expect(step?.phase).toBe("expand");
		expect(nonAdditiveStatements(defined(step, "the worktrees_repo_lower_seen_idx step"))).toEqual([]);
		expect(step?.sql).toContain("create index if not exists worktrees_repo_lower_seen_idx on worktrees (lower(repo), last_seen_at desc)");
		expect(step?.down).toContain("drop index if exists worktrees_repo_lower_seen_idx");
		expect(runbook).toContain("`worktrees_repo_lower_seen_idx`");
	});

	test("the additive rule fires: a drop, a rename, a type change, an unguarded create and a NOT NULL column without a default are each caught", () => {
		const bad = [
			"drop table if exists a",
			"alter table a rename to b",
			"alter table a alter column c type text",
			"create table a (id int)",
			"create index a_idx on a (id)",
			"alter table a add column b int",
			"alter table a add column if not exists b int not null",
			"delete from a",
		];
		for (const sql of bad) expect({ sql, notAdditive: nonAdditiveStatements({ sql }) }).toEqual({ sql, notAdditive: [sql] });
		expect(nonAdditiveStatements({ sql: "create table if not exists a (id int); create unique index if not exists a_idx on a (id); alter table a add column if not exists b int not null default 0" })).toEqual([]);
	});

	test("the runbook rule fires: a step the runbook does not name is reported by version", () => {
		expect(stepsMissingFromRunbook([{ version: 99, name: "no_such_step_anywhere" }, { version: 17, name: "skills_registry" }], runbook)).toEqual([99]);
	});

	test("a step numbered above the pin is held to both rules", () => {
		const future: MigrationStep = { version: LAST_STEP_AT_PIN + 1, name: "future_step", sql: "drop table if exists a" };
		expect(stepsSinceReference([...MIGRATION_STEPS, future]).map((step) => step.version)).toContain(LAST_STEP_AT_PIN + 1);
		expect(nonAdditiveStatements(future)).toEqual(["drop table if exists a"]);
	});
});
