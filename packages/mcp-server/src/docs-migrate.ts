#!/usr/bin/env bun
/**
 * The RAGFlow → LightRAG migration job (phase 46, criterion 4, migration clause). Offline unless the operator sets the
 * live reach: every LightRAG call goes through the injected fetch, and nothing reaches a plane without `LIGHTRAG_URL`.
 *
 *   bun scripts/docs-migrate.ts --archive <dir>
 *   bun scripts/docs-migrate.ts --apply --archive <dir> --part-a <summary.md>
 *   bun scripts/docs-migrate.ts --apply --rehearsal --archive <dir> --part-a <summary.md>
 *
 * Every mode verifies the archive (`verifyArchive`, docs-archive.ts) and refuses on a failed read-back. The job then
 * runs PARITY_GATE (parity-run.ts: Part A, then Part B) as a precondition of any ingestion. Part A checks that
 * each `lightrag::` record of the docs state matches its LightRAG document by dataset, source URL and version; Part B
 * checks that the frozen sample answers from its expected sources at the threshold. A failed gate refuses ingestion.
 * Each archived RAGFlow record must map to an archived dataset, and each archived document must name its commit and
 * source URL, or the replay cannot reproduce it. Both refusals come before the gate.
 *
 * The dry run writes nothing. `--apply` needs the dry run's recorded pass (`--part-a` names a file with the marker line
 * `parity-gate:passed records=<N>`) and the operator's approval for this run (`SUBSTRATE_DOCS_MIGRATE_APPROVED=1`). It
 * replays every archived page at its recorded commit through the LightRAG ingest (`ingestDocs`, backend lightrag),
 * carries the archived per-URL versions onto the records the replay wrote, and persists the state file. A page the plane
 * refuses is counted as failed and is not migrated, so the dataset is refused. A fully successful apply also records the
 * dataset pins and reports the `docs.cutover` event; a refused apply keeps only the confirmed uploads and reports no cutover.
 * `--rehearsal` persists nothing and reports no cutover event. The CLI does not write the event ledger, so the operator
 * records the cutover event.
 *
 * Every document is named under its dataset's mapped repository (`DATASET_REPOS`), and the replay runs only from a checkout whose
 * origin is a mapped repository. A dataset outside the table, or a checkout outside it, is refused, never named bare.
 *
 * Exit codes: 0 the mode's checks passed; 1 a verification, gate or replay failure (the report names each mismatch by
 * kind and dataset, never page content); 2 refused before any effect: bad flags, no archive, no `LIGHTRAG_URL`, no
 * state file, no recorded gate pass, or no approval.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type LightragConfig, lightragFromEnv, ragflowArchiveFromEnv } from "./config.ts";
import { DATASET_REPOS, datasetIdentity } from "./dataset-identity.ts";
import { gitAtCommit, type ReadAtCommit, verifyArchive } from "./docs-archive.ts";
import { type DatasetVersion, recordVersion, type VersionStore } from "./docs-datasets.ts";
import { DEFAULT_INGEST_ROOTS, type IngestPage, type IngestRecord, ingestDocs, loadIngestRecords, saveIngestRecords } from "./docs-ingest.ts";
import { sha256Hex } from "./event.ts";
import type { FetchLike } from "./planes/lightrag.ts";
import type { EventInput } from "./types.ts";
import { runPartA, runPartB } from "./parity-run.ts";
import { repoOf } from "./planning/checkout.ts";
import { nodePlanningFs } from "./planning/fs.ts";
import { SKILL_NAME_RE } from "./skills/propose.ts";

export const APPROVAL_ENV = "SUBSTRATE_DOCS_MIGRATE_APPROVED";
const STATE_ENV = "SUBSTRATE_DOCS_STATE_FILE";
const LIGHTRAG_PREFIX = "lightrag::";
const INVENTORY_DIR = "inventory";
const DATASETS_FILE = "_datasets.json";
const STATE_PATH = "state/docs-ingest.json";
const MIGRATE_USAGE = "usage: bun scripts/docs-migrate.ts [--dry-run] [--apply] [--rehearsal] --archive <dir> [--part-a <file>] [--state-file <file>] [--dataset <name>...]";

export interface ParsedMigrateArgs {
	mode: "dry-run" | "apply";
	archive: string | null;
	partA: string | null;
	rehearsal: boolean;
	stateFile: string | null;
	datasets: string[];
	reason: string | null;
}

export function parseMigrateArgs(argv: readonly string[]): ParsedMigrateArgs {
	const parsed: ParsedMigrateArgs = { mode: "dry-run", archive: null, partA: null, rehearsal: false, stateFile: null, datasets: [], reason: null };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index] ?? "";
		const next = (): string | null => {
			const value = argv[index + 1];
			index += 1;
			return value ?? null;
		};
		if (flag === "--dry-run") parsed.mode = "dry-run";
		else if (flag === "--apply") parsed.mode = "apply";
		else if (flag === "--rehearsal") parsed.rehearsal = true;
		else if (flag === "--archive" || flag === "--part-a" || flag === "--state-file") {
			const value = next();
			if (value === null) return { ...parsed, reason: `${flag} needs a value; ${MIGRATE_USAGE}` };
			if (flag === "--archive") parsed.archive = value;
			else if (flag === "--part-a") parsed.partA = value;
			else parsed.stateFile = value;
		} else if (flag === "--dataset") {
			const value = next();
			if (value === null) return { ...parsed, reason: `--dataset needs a name; ${MIGRATE_USAGE}` };
			parsed.datasets.push(value);
		} else return { ...parsed, reason: `unexpected ${flag}; ${MIGRATE_USAGE}` };
	}
	if (parsed.rehearsal && parsed.mode !== "apply") return { ...parsed, reason: `--rehearsal only applies to --apply; ${MIGRATE_USAGE}` };
	return parsed;
}

/** The marker the dry run prints on a full PARITY_GATE pass, and every apply demands in its `--part-a` file. */
export function partAMarker(records: number): string {
	return `parity-gate:passed records=${String(records)}`;
}

export function partARecorded(text: string): { ok: boolean; records: number | null } {
	const match = /parity-gate:passed records=(\d+)/.exec(text);
	if (match === null) return { ok: false, records: null };
	return { ok: true, records: Number(match[1]) };
}

interface InventoryDocument {
	id: string;
	name: string;
	source_url: string | null;
	commit: string | null;
	heading_path: string | null;
}

interface Inventory {
	dataset: { id: string; name: string };
	documents: InventoryDocument[];
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

/** An inventory file's shape, or null: an unexpected field type fails the whole read, never a partial archive. */
function parseInventory(raw: unknown): Inventory | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { dataset, documents } = raw as { dataset?: unknown; documents?: unknown };
	if (typeof dataset !== "object" || dataset === null || !Array.isArray(documents)) return null;
	const { id, name } = dataset as { id?: unknown; name?: unknown };
	if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "") return null;
	const parsed: InventoryDocument[] = [];
	for (const entry of documents) {
		if (typeof entry !== "object" || entry === null) return null;
		const document = entry as Record<string, unknown>;
		const { source_url, commit, heading_path } = document;
		if (typeof document.id !== "string" || typeof document.name !== "string") return null;
		if (!isNullableString(source_url) || !isNullableString(commit) || !isNullableString(heading_path)) return null;
		parsed.push({ id: document.id, name: document.name, source_url, commit, heading_path });
	}
	return { dataset: { id, name }, documents: parsed };
}

export interface ArchivedDocument {
	id: string;
	name: string;
	/** The repo path: RAGFlow names a document by its path with `/` written as `__` (see docs-archive.ts `pageCheck`). */
	path: string;
	source_url: string | null;
	commit: string | null;
	heading_path: string | null;
}

export interface ArchivedDataset {
	id: string;
	name: string;
	documents: ArchivedDocument[];
}

export interface ArchiveLoad {
	datasets: ArchivedDataset[];
	records: Map<string, IngestRecord>;
	versions: VersionStore;
}

export type ArchiveRead = { ok: true; archive: ArchiveLoad } | { ok: false; reason: string };

/**
 * The archive's inventory and state copy, read after `verifyArchive` has proven the bytes. A malformed inventory fails
 * the whole read: a partial load would replay a partial set.
 */
export async function loadArchive(dir: string): Promise<ArchiveRead> {
	let files: string[];
	try {
		files = readdirSync(join(dir, INVENTORY_DIR))
			.filter((name) => name.endsWith(".json") && name !== DATASETS_FILE)
			.sort();
	} catch {
		return { ok: false, reason: "the archive has no inventory directory" };
	}
	const datasets: ArchivedDataset[] = [];
	for (const file of files) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(dir, INVENTORY_DIR, file), "utf8"));
		} catch {
			return { ok: false, reason: `inventory/${file} is not JSON` };
		}
		const inventory = parseInventory(raw);
		if (inventory === null) return { ok: false, reason: `inventory/${file} is malformed` };
		datasets.push({
			id: inventory.dataset.id,
			name: inventory.dataset.name,
			documents: inventory.documents.map((document) => ({ ...document, path: document.name.replace(/__/g, "/") })),
		});
	}
	const loaded = await loadIngestRecords(join(dir, STATE_PATH));
	if (loaded.problem !== undefined) return { ok: false, reason: loaded.problem };
	return { ok: true, archive: { datasets, records: loaded.records, versions: loaded.versions } };
}

export interface RecordMapping {
	/** The archived RAGFlow records (the non-`lightrag::` keys) whose dataset the inventory names. */
	migrated: Array<{ dataset: string; source_url: string; version: number }>;
	/** Archived RAGFlow records whose dataset id the inventory does not list. Any one refuses the job. */
	unmapped: Array<{ dataset_id: string; source_url: string }>;
}

/** Maps each archived RAGFlow record to its LightRAG dataset by logical name. The inventory resolves id to name. */
export function mapRecords(archive: ArchiveLoad): RecordMapping {
	const nameById = new Map(archive.datasets.map((dataset) => [dataset.id, dataset.name] as const));
	const migrated: RecordMapping["migrated"] = [];
	const unmapped: RecordMapping["unmapped"] = [];
	for (const [key, record] of archive.records) {
		if (key.startsWith(LIGHTRAG_PREFIX)) continue;
		const dataset = nameById.get(record.dataset_id);
		if (dataset === undefined) unmapped.push({ dataset_id: record.dataset_id, source_url: record.source_url });
		else migrated.push({ dataset, source_url: record.source_url, version: record.version });
	}
	return { migrated, unmapped };
}

/** The owner/name of the checkout the replay reads its pages from (`process.cwd()`), or null when git names none. */
async function checkoutRepoOf(root: string): Promise<string | null> {
	const lookup = await repoOf(nodePlanningFs(), root);
	return lookup.state === "known" ? lookup.repo : null;
}

/**
 * The ingest layout each dataset replays under. The default roots (`docs/`, `README.md`, `.planning/`) hold the
 * agent-substrate pages. An agent-skills archive holds skill pages at `<name>/SKILL.md` and `<name>/references/`, which
 * those roots refuse as outside-roots, so a dataset listed as `skills` replays under the skill-checkout layout that the
 * normal refresh reads (`skillsCheckoutRoots`). A dataset listed as `programming-desk` replays under the roots its source
 * documents (`docs/docs-search-ingest.md`, the Datasets table). Every other dataset keeps `DEFAULT_INGEST_ROOTS`.
 */
type IngestLayout = "default" | "skills" | "programming-desk";

export const DATASET_INGEST_LAYOUT: Readonly<Record<string, IngestLayout>> = {
	"agent-skills": "skills",
	"programming-desk": "programming-desk",
};

/** The roots of the `swcstudiospace/programming-desk` source, as `docs/docs-search-ingest.md` documents them. */
const PROGRAMMING_DESK_INGEST_ROOTS: readonly string[] = ["docs/", "skills/", "contracts/", "ARCHITECTURE.md", "prompts-assembled/"];

/**
 * The identity a dataset's documents are replayed under, or null when the job refuses it. Pages are read from the checkout at
 * their archived commits, so a dataset replays from a checkout whose origin is a mapped repository. A commit the checkout does
 * not hold fails its `git show` and refuses the dataset. A dataset outside the table, or a checkout outside it, is refused.
 */
function datasetRepo(dataset: string, checkout: string | null): string | null {
	if (checkout === null || !Object.hasOwn(DATASET_REPOS, dataset)) return null;
	return Object.values(DATASET_REPOS).includes(checkout) ? datasetIdentity(dataset) : null;
}

export interface MigrateIo {
	out: (text: string) => void;
	err: (text: string) => void;
}

export interface MigrateOutcome {
	ok: boolean;
	exit: number;
	report: Record<string, unknown>;
	refused?: string;
}

export interface GateResult {
	ok: boolean;
	records: number;
	parts: { A: Record<string, unknown>; B?: Record<string, unknown> };
}

/**
 * PARITY_GATE: Part A, then Part B only when Part A passes. Both are the CLI's own functions, reading the docs state file
 * and the plane through the injected fetch. The reports carry counts and kinds only.
 */
export async function runGate(config: LightragConfig, stateFile: string, fetchImpl: FetchLike): Promise<GateResult> {
	const partA = await runPartA("A", { [STATE_ENV]: stateFile }, config, { fetch: fetchImpl });
	if (partA.exitCode !== 0) return { ok: false, records: 0, parts: { A: partA.report } };
	const partB = await runPartB("B", config, { fetch: fetchImpl });
	return { ok: partB.exitCode === 0, records: Number(partA.report.records), parts: { A: partA.report, B: partB.report } };
}

export interface JobInput {
	archiveDir: string;
	stateFile: string;
	config: LightragConfig;
	fetchImpl: FetchLike;
}

type Precondition = { ok: true; archive: ArchiveLoad; records: number; report: Record<string, unknown> } | { ok: false; reason: string; report: Record<string, unknown> };

/** Verify, map, check the replayability of every document, then gate. Nothing is written and nothing is ingested here. */
async function precondition(input: JobInput): Promise<Precondition> {
	const verify = await verifyArchive(input.archiveDir);
	if (!verify.ok) return { ok: false, reason: "archive verification failed", report: { verify: { ok: false, mismatches: verify.mismatches } } };
	const read = await loadArchive(input.archiveDir);
	if (!read.ok) return { ok: false, reason: read.reason, report: { verify: { ok: true, mismatches: [] } } };
	const mapping = mapRecords(read.archive);
	const undocumented = read.archive.datasets.flatMap((dataset) =>
		dataset.documents.filter((document) => document.commit === null || document.source_url === null).map((document) => ({ dataset: dataset.name, document: document.id })),
	);
	const base: Record<string, unknown> = { verify: { ok: true, mismatches: [] }, unmapped: mapping.unmapped, undocumented };
	if (mapping.unmapped.length > 0) return { ok: false, reason: "archived RAGFlow records map to no archived dataset", report: base };
	if (undocumented.length > 0) return { ok: false, reason: "archived documents without a commit or source URL cannot be replayed", report: base };
	const gate = await runGate(input.config, input.stateFile, input.fetchImpl);
	const report = { ...base, gate_ok: gate.ok, records: gate.records, gate: gate.parts };
	if (!gate.ok) return { ok: false, reason: "PARITY_GATE failed; refusing ingestion", report };
	return { ok: true, archive: read.archive, records: gate.records, report };
}

/** The dry run: verify, map, gate. No ingestion and no write. */
export async function runDryRun(input: JobInput, io: MigrateIo): Promise<MigrateOutcome> {
	const archiveDir = resolve(input.archiveDir);
	const pre = await precondition({ ...input, archiveDir });
	const report: Record<string, unknown> = { mode: "dry-run", archive: archiveDir, ...pre.report };
	if (pre.ok) report.marker = partAMarker(pre.records);
	else report.refused = pre.reason;
	io.out(`${JSON.stringify(report, null, 2)}\n`);
	if (!pre.ok) io.err(`docs-migrate: ${pre.reason}\n`);
	return { ok: pre.ok, exit: pre.ok ? 0 : 1, report, ...(pre.ok ? {} : { refused: pre.reason }) };
}

export interface ApplyOptions extends JobInput {
	partAFile: string;
	rehearsal: boolean;
	datasets: readonly string[];
	/** The owner/name of the checkout the replay reads pages from (`checkoutRepoOf`), or null when git names none. */
	checkoutRepo: string | null;
	readAtCommit?: ReadAtCommit;
	poll?: { maxPolls?: number; intervalMs?: number };
	now?: () => number;
}

interface DatasetReplay {
	dataset: string;
	commits: number;
	ingested: number;
	replaced: number;
	unchanged: number;
	failed: number;
	refused?: string;
}

/**
 * The roots a skills-layout dataset replays under, derived from its archived page paths by the rule `skillsCheckoutRoots`
 * applies to a checkout: `<name>/SKILL.md` for a skill folder whose name passes SKILL_NAME_RE, and `<name>/references/`.
 * A page outside that layout gets no root, so the ingest refuses it as outside-roots.
 */
function skillsReplayRoots(paths: readonly string[]): string[] {
	const roots = new Set<string>();
	for (const path of paths) {
		const [name, ...rest] = path.split("/");
		if (name === undefined || !SKILL_NAME_RE.test(name)) continue;
		if (rest.length === 1 && rest[0] === "SKILL.md") roots.add(`${name}/SKILL.md`);
		else if (rest.length >= 2 && rest[0] === "references") roots.add(`${name}/references/`);
	}
	return [...roots];
}

/** The roots a dataset's archived pages replay under, by its ingest layout. */
function replayRoots(layout: IngestLayout, paths: readonly string[]): readonly string[] {
	if (layout === "skills") return skillsReplayRoots(paths);
	if (layout === "programming-desk") return PROGRAMMING_DESK_INGEST_ROOTS;
	return DEFAULT_INGEST_ROOTS;
}

/**
 * Replays one dataset's archived pages, grouped per recorded commit, through the LightRAG ingest. Returns the keys the
 * replay wrote, so the version carry touches only those records.
 */
async function replayDataset(
	dataset: ArchivedDataset,
	ctx: { options: ApplyOptions; readAt: ReadAtCommit; seen: Map<string, IngestRecord>; events: EventInput[] },
): Promise<{ replay: DatasetReplay; written: string[] }> {
	const replay: DatasetReplay = { dataset: dataset.name, commits: 0, ingested: 0, replaced: 0, unchanged: 0, failed: 0 };
	const written: string[] = [];
	const { options } = ctx;
	// A dataset with no documents has nothing to name or refuse, so it needs no repository.
	if (dataset.documents.length === 0) return { replay, written };
	const repo = datasetRepo(dataset.name, options.checkoutRepo);
	if (repo === null) {
		const checkout = options.checkoutRepo ?? "unnamed";
		return { replay: { ...replay, refused: `no mapped repository lets ${dataset.name} replay from the checkout ${checkout}` }, written };
	}
	const layout: IngestLayout = Object.hasOwn(DATASET_INGEST_LAYOUT, dataset.name) ? (DATASET_INGEST_LAYOUT[dataset.name] ?? "default") : "default";
	const roots = replayRoots(layout, dataset.documents.map((document) => document.path));
	const pagesByCommit = new Map<string, IngestPage[]>();
	for (const document of dataset.documents) {
		if (document.commit === null || document.source_url === null) {
			return { replay: { ...replay, refused: `document ${document.id} lost its commit or source URL` }, written };
		}
		const bytes = ctx.readAt(document.commit, document.path);
		if (bytes === null) return { replay: { ...replay, refused: `git show failed for ${document.path} at ${document.commit}` }, written };
		const pages = pagesByCommit.get(document.commit) ?? [];
		pages.push({
			path: document.path,
			source_url: document.source_url,
			body: bytes.toString("utf8"),
			...(document.heading_path !== null ? { heading_path: document.heading_path } : {}),
		});
		pagesByCommit.set(document.commit, pages);
	}
	replay.commits = pagesByCommit.size;
	for (const [commit, pages] of pagesByCommit) {
		const outcome = await ingestDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: options.config,
				// The dataset is listed under its repository, so its documents are named and recorded under `owner/name`.
				lightragDatasets: { list: async () => ({ ok: true, datasets: [{ id: repo, name: dataset.name }] }), invalidate: () => undefined },
				lightragFetch: options.fetchImpl,
				// Corpus-style names, so the PARITY_GATE can verify each replayed document.
				corpusNames: true,
				seen: ctx.seen,
				locks: new Map(),
				roots,
				surface: "substrate",
				emit: async (event) => {
					ctx.events.push(event);
					return { stored: false };
				},
				...(options.poll !== undefined ? { poll: options.poll } : {}),
			},
			{ dataset: dataset.name, commit, pages },
		);
		if (!outcome.ok) return { replay: { ...replay, refused: outcome.reason }, written };
		for (const result of outcome.results) {
			if (result.status === "ingested" || result.status === "replaced") written.push(`${LIGHTRAG_PREFIX}${repo}::${result.source_url}`);
			if (result.status === "failed") replay.failed += 1;
			else replay[result.status] += 1;
		}
	}
	const pagesFailed = replay.failed > 0 ? { refused: `${String(replay.failed)} page(s) failed to upload; the dataset is incomplete` } : {};
	return { replay: { ...replay, ...pagesFailed }, written };
}

/**
 * The migrated records take the archived per-URL versions: the replay numbers its own writes, but the version is the
 * migration's metadata. Only the keys this run wrote are touched.
 */
function carryVersions(archive: ArchiveLoad, seen: Map<string, IngestRecord>, written: ReadonlySet<string>, wanted: ReadonlySet<string> | null, checkout: string | null): number {
	let carried = 0;
	for (const migrated of mapRecords(archive).migrated) {
		if (wanted !== null && !wanted.has(migrated.dataset)) continue;
		const repo = datasetRepo(migrated.dataset, checkout);
		if (repo === null) continue;
		const key = `${LIGHTRAG_PREFIX}${repo}::${migrated.source_url}`;
		if (!written.has(key)) continue;
		const prior = seen.get(key);
		if (prior !== undefined && prior.version !== migrated.version) {
			seen.set(key, { ...prior, version: migrated.version });
			carried += 1;
		}
	}
	return carried;
}

/** The archived RAGFlow pin becomes the LightRAG pin, so citations keep their commit and a refresh replaces rather than renumbers. */
function recordPins(archive: ArchiveLoad, versions: VersionStore, wanted: ReadonlySet<string> | null, now: number): number {
	let pins = 0;
	for (const [dataset, list] of archive.versions) {
		if (wanted !== null && !wanted.has(dataset)) continue;
		const latest: DatasetVersion | undefined = [...list].reverse().find((version) => version.backend === "ragflow");
		if (latest === undefined) continue;
		recordVersion(versions, {
			dataset,
			dataset_id: datasetIdentity(dataset),
			version: latest.version,
			commit: latest.commit,
			content_sha256: latest.content_sha256,
			ingested_at: new Date(now).toISOString(),
			backend: "lightrag",
		});
		pins += 1;
	}
	return pins;
}

/** The apply: marker, verify, gate, then replay. Refuses before any ingestion if any step fails. */
export async function runApply(options: ApplyOptions, io: MigrateIo): Promise<MigrateOutcome> {
	const archiveDir = resolve(options.archiveDir);
	const refuse = (reason: string, extra: Record<string, unknown> = {}): MigrateOutcome => {
		const report = { mode: "apply", archive: archiveDir, refused: reason, ...extra };
		io.err(`${JSON.stringify(report)}\n`);
		return { ok: false, exit: 1, report, refused: reason };
	};
	let partAText: string;
	try {
		partAText = readFileSync(options.partAFile, "utf8");
	} catch {
		return refuse("--part-a is unreadable");
	}
	const recorded = partARecorded(partAText);
	if (!recorded.ok) return refuse('--part-a does not record a gate pass (the dry run\'s marker "parity-gate:passed records=<N>")');

	const pre = await precondition({ ...options, archiveDir });
	if (!pre.ok) return refuse(pre.reason, { precondition: pre.report });
	if (recorded.records !== pre.records) {
		return refuse(`--part-a records ${String(recorded.records)} differ from the live gate's ${String(pre.records)}: the recorded pass is stale`);
	}

	const production = await loadIngestRecords(options.stateFile);
	if (production.problem !== undefined) return refuse(production.problem);
	const wanted = options.datasets.length > 0 ? new Set(options.datasets) : null;
	const readAt = options.readAtCommit ?? gitAtCommit(process.cwd());
	const now = options.now ?? Date.now;
	const seen = production.records;
	const versions = production.versions;
	const events: EventInput[] = [];
	const written = new Set<string>();
	const perDataset: DatasetReplay[] = [];
	for (const dataset of pre.archive.datasets) {
		if (wanted !== null && !wanted.has(dataset.name)) continue;
		const result = await replayDataset(dataset, { options, readAt, seen, events });
		perDataset.push(result.replay);
		for (const key of result.written) written.add(key);
	}
	const applied = perDataset.every((entry) => entry.refused === undefined);
	const carried = carryVersions(pre.archive, seen, written, wanted, options.checkoutRepo);
	// Only a full success pins the datasets. A failed run keeps the confirmed uploads (their records and carried versions), so
	// the state never lags the plane; it records no pin and no cutover.
	const pins = applied ? recordPins(pre.archive, versions, wanted, now()) : 0;
	const statePersisted = !options.rehearsal && (applied || written.size > 0);
	if (statePersisted) await saveIngestRecords(options.stateFile, seen, versions, production.freshness);
	const cutover = !options.rehearsal && applied;
	const at = new Date(now()).toISOString();
	const report: Record<string, unknown> = {
		mode: "apply",
		rehearsal: options.rehearsal,
		archive: archiveDir,
		gate: { records: pre.records, marker: partAMarker(pre.records) },
		datasets: perDataset,
		totals: {
			ingested: perDataset.reduce((total, entry) => total + entry.ingested, 0),
			replaced: perDataset.reduce((total, entry) => total + entry.replaced, 0),
			unchanged: perDataset.reduce((total, entry) => total + entry.unchanged, 0),
			failed: perDataset.reduce((total, entry) => total + entry.failed, 0),
		},
		ingest_events: events.length,
		versions_carried: carried,
		versions_recorded: pins,
		state_file_persisted: statePersisted,
		cutover_event: cutover
			? {
					surface: "substrate",
					kind: "note",
					summary: "docs backend cutover ragflow → lightrag",
					session_id: `docs-migrate:${at}`,
					payload: { action: "docs.cutover", from: "ragflow", to: "lightrag", at, parity_sha: sha256Hex(partAText) },
				}
			: null,
	};
	io.out(`${JSON.stringify(report, null, 2)}\n`);
	if (!applied) io.err(`docs-migrate: a replay refused; no cutover is recorded${statePersisted ? ", and the confirmed uploads were saved" : ""}\n`);
	return { ok: applied, exit: applied ? 0 : 1, report, ...(applied ? {} : { refused: "apply failed; see the report" }) };
}


const STDIO: MigrateIo = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) };

/** The CLI entry. Every refusal before a live reach is exit 2; every refused check is exit 1. */
export async function main(argv: readonly string[], env: Record<string, string | undefined> = process.env, io: MigrateIo = STDIO, fetchImpl: FetchLike = fetch): Promise<number> {
	const parsed = parseMigrateArgs(argv);
	if (parsed.reason !== null) {
		io.err(`docs-migrate: ${parsed.reason}\n`);
		return 2;
	}
	const archiveDir = parsed.archive ?? ragflowArchiveFromEnv(env).dir;
	if (archiveDir === null) {
		io.err("docs-migrate: no archive configured; pass --archive <dir> or set SUBSTRATE_RAGFLOW_ARCHIVE_DIR\n");
		return 2;
	}
	const config = lightragFromEnv(env);
	if (config === null) {
		io.err("docs-migrate: LIGHTRAG_URL is unset; no socket was opened\n");
		return 2;
	}
	const stateFile = parsed.stateFile ?? (env[STATE_ENV]?.trim() || null);
	if (stateFile === null) {
		io.err("docs-migrate: no docs state file; pass --state-file or set SUBSTRATE_DOCS_STATE_FILE\n");
		return 2;
	}
	if (parsed.mode === "dry-run") {
		const outcome = await runDryRun({ archiveDir, stateFile, config, fetchImpl }, io);
		return outcome.exit;
	}
	if (parsed.partA === null) {
		io.err("docs-migrate: --apply requires --part-a <file> naming the dry run's recorded gate pass\n");
		return 2;
	}
	if (env[APPROVAL_ENV] !== "1") {
		io.err(`docs-migrate: --apply needs ${APPROVAL_ENV}=1 for this run; the operator approves each live step\n`);
		return 2;
	}
	const outcome = await runApply({ archiveDir, stateFile, config, fetchImpl, partAFile: parsed.partA, rehearsal: parsed.rehearsal, datasets: parsed.datasets, checkoutRepo: await checkoutRepoOf(process.cwd()) }, io);
	return outcome.exit;
}
