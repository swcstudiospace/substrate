#!/usr/bin/env bun
/**
 * The RAGFlow → LightRAG migration job (phase 46, SC4/SC5): a dry run by
 * default, an apply that must be earned.
 *
 *   bun scripts/docs-migrate.ts --archive <dir>
 *   bun scripts/docs-migrate.ts --archive <dir> --answers <answers.json>
 *   bun scripts/docs-migrate.ts --apply --archive <dir> --part-a <summary.md>
 *   bun scripts/docs-migrate.ts --apply --rehearsal --archive <dir> --part-a <summary.md>
 *
 * Every mode first re-verifies the archive through `verifyArchive`
 * (docs-archive.ts) and refuses to run when the read-back fails. The dry
 * run maps every archived RAGFlow record to its expected LightRAG record
 * (logical dataset name, source URL, carried per-URL version) and runs
 * PARITY_GATE's Part A over the mapping — zero mismatches or the job fails
 * — with Part B skipped, unless `--answers` names the frozen sample's
 * answers, in which case the full ordered gate runs. The dry run makes no
 * network call and writes nothing.
 *
 * `--apply` refuses unless the Part A pass is recorded: `--part-a` names a
 * file that carries the dry run's marker line
 * (`parity-gate:part-a:passed records=<N>`). It then replays every archived
 * page at its recorded commit (`git show <commit>:<path>`) through the
 * existing LightRAG ingest (`ingestDocs`, docs-ingest.ts, backend
 * lightrag), grouped per dataset and per recorded commit, and records the
 * versions under the `lightrag::` keys with the archived generation counts
 * carried forward — the recorded per-URL versions are metadata of the
 * migration, not data the replay may renumber. Dataset pins are recorded
 * for the LightRAG backend from the archived RAGFlow pins, and the state
 * file is persisted (unless `--rehearsal`, which touches no production
 * state and emits no cutover note). A non-rehearsal apply emits the
 * cutover note event (`docs.cutover`, from, to, at, parity_sha) on the
 * service's emit seam — SC5's logged, reversible switch reads it.
 *
 * Exit codes: 0 the mode's checks passed; 1 a gate, verification or apply
 * failure (the report names each mismatch by dataset and source_url,
 * never page content); 2 refused before any effect — bad flags, no
 * archive configured (`SUBSTRATE_RAGFLOW_ARCHIVE_DIR`), no LightRAG reach
 * (`lightragFromEnv`), or a missing Part A record.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	archiveDirFromEnv,
	verifyArchive,
	type ArchivedBaseline,
	type ArchivedDataset,
} from "./docs-archive.ts";
import { parityGate, type ParityRecord } from "./docs-parity.ts";
import {
	DEFAULT_INGEST_ROOTS,
	ingestDocs,
	saveIngestRecords,
	type IngestPage,
	type IngestRecord,
} from "./docs-ingest.ts";
import { lightragFromEnv } from "./config.ts";
import { createVersionStore, lightragSearchDatasets, recordVersion, versionsFromJson, type VersionStore } from "./docs-datasets.ts";
import { sha256Hex } from "./event.ts";
import type { EventInput } from "./types.ts";
import type { FetchLike } from "./planes/lightrag.ts";

const MIGRATE_USAGE = "usage: bun scripts/docs-migrate.ts [--dry-run] [--apply] [--rehearsal] --archive <dir> [--part-a <file>] [--answers <file>] [--state-file <file>] [--dataset <name>...]";

export interface ParsedMigrateArgs {
	mode: "dry-run" | "apply";
	archive: string | null;
	partA: string | null;
	answers: string | null;
	rehearsal: boolean;
	stateFile: string | null;
	datasets: string[];
	substrateUrl: string | null;
	substrateToken: string | null;
	reason: string | null;
}

export function parseMigrateArgs(argv: readonly string[]): ParsedMigrateArgs {
	const parsed: ParsedMigrateArgs = { mode: "dry-run", archive: null, partA: null, answers: null, rehearsal: false, stateFile: null, datasets: [], substrateUrl: null, substrateToken: null, reason: null };
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
		else if (flag === "--archive" || flag === "--part-a" || flag === "--answers" || flag === "--state-file" || flag === "--substrate-url" || flag === "--substrate-token") {
			const value = next();
			if (value === null) return { ...parsed, reason: `${flag} needs a value; ${MIGRATE_USAGE}` };
			if (flag === "--archive") parsed.archive = value;
			else if (flag === "--part-a") parsed.partA = value;
			else if (flag === "--answers") parsed.answers = value;
			else if (flag === "--substrate-url") parsed.substrateUrl = value;
			else if (flag === "--substrate-token") parsed.substrateToken = value;
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

/** The Part A marker the dry run prints and every apply demands. */
export function partAMarker(records: number): string {
	return `parity-gate:part-a:passed records=${String(records)}`;
}

export function partARecorded(text: string): { ok: boolean; records: number | null } {
	const match = /parity-gate:part-a:passed records=(\d+)/.exec(text);
	if (match === null) return { ok: false, records: null };
	return { ok: true, records: Number(match[1]) };
}

export interface ArchiveLoad {
	datasets: ArchivedDataset[];
	records: Map<string, IngestRecord>;
	versions: VersionStore;
	baselines: ArchivedBaseline[];
	sampleSha256: string | null;
}

/** Read an already-verified archive: inventories, state, baselines, manifest digest. */
export function loadArchive(dir: string): ArchiveLoad {
	const datasets: ArchivedDataset[] = [];
	for (const entry of readArchiveDir(join(dir, "inventory"))) {
		datasets.push(JSON.parse(readFileSync(join(dir, "inventory", entry), "utf8")) as ArchivedDataset);
	}
	const baselines: ArchivedBaseline[] = [];
	for (const entry of readArchiveDir(join(dir, "baseline"))) {
		baselines.push(JSON.parse(readFileSync(join(dir, "baseline", entry), "utf8")) as ArchivedBaseline);
	}
	const statePath = join(dir, "state", "docs-ingest.json");
	const state = JSON.parse(readFileSync(statePath, "utf8")) as { version: number };
	const loaded =
		state.version === 2
			? loadIngestRecordsSync(statePath)
			: { records: new Map<string, IngestRecord>(), versions: createVersionStore() };
	let sampleSha256: string | null = null;
	try {
		const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { sample_sha256?: string };
		sampleSha256 = typeof manifest.sample_sha256 === "string" ? manifest.sample_sha256 : null;
	} catch {
		sampleSha256 = null;
	}
	return { datasets, records: loaded.records, versions: loaded.versions, baselines, sampleSha256 };
}

function readArchiveDir(dir: string): string[] {
	try {
		return readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort();
	} catch {
		return [];
	}
}

function loadIngestRecordsSync(file: string): { records: Map<string, IngestRecord>; versions: VersionStore } {
	// loadIngestRecords is async (fs promises); the archive loader is sync by
	// design, so the same parser runs through the exported async path once.
	// Keep the sync wrapper honest: an unreadable state file is an empty one,
	// exactly as the service hydrates it.
	const raw = readFileSync(file, "utf8");
	const parsed = JSON.parse(raw) as { records?: Record<string, unknown>; versions?: unknown };
	const records = new Map<string, IngestRecord>();
	for (const [key, value] of Object.entries(parsed.records ?? {})) {
		if (value === null || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		if (typeof entry.sha !== "string" || typeof entry.dataset_id !== "string" || typeof entry.source_url !== "string" || typeof entry.document_id !== "string") continue;
		records.set(key, {
			sha: entry.sha,
			dataset_id: entry.dataset_id,
			source_url: entry.source_url,
			document_id: entry.document_id,
			...(typeof entry.commit === "string" ? { commit: entry.commit } : {}),
			version: typeof entry.version === "number" && Number.isInteger(entry.version) && entry.version >= 1 ? entry.version : 1,
		});
	}
	const versions = typeof parsed.versions === "object" && parsed.versions !== null ? versionsFromJson(parsed.versions) : createVersionStore();
	return { records, versions };
}

export interface RecordMapping {
	ragflow: ParityRecord[];
	lightrag: ParityRecord[];
	/** Records whose RAGFlow dataset id has no inventory dataset: the mapping is wrong and Part A will say so. */
	unmapped: Array<{ dataset: string; source_url: string }>;
}

/**
 * The dry run's record mapping: every archived RAGFlow record (the state
 * file's non-`lightrag::` keys) maps onto its expected LightRAG record by
 * LOGICAL dataset name — the inventory resolves id → name, and a record
 * whose id resolves nowhere stays in with an `(unmapped:<id>)` dataset so
 * Part A reports it as missing rather than quietly dropping it.
 */
export function mapRecords(archive: ArchiveLoad): RecordMapping {
	const nameById = new Map<string, string>();
	for (const dataset of archive.datasets) nameById.set(dataset.id, dataset.name);
	const ragflow: ParityRecord[] = [];
	const lightrag: ParityRecord[] = [];
	const unmapped: Array<{ dataset: string; source_url: string }> = [];
	for (const [key, record] of archive.records) {
		if (key.startsWith("lightrag::")) continue; // already the migrated side's keys
		const name = nameById.get(record.dataset_id);
		if (name === undefined) {
			// Version 0 never matches a real migrated record: the unmapped id
			// surfaces as a Part A missing-mismatch naming the dataset id.
			const entry = { dataset: `(unmapped:${record.dataset_id})`, source_url: record.source_url, version: 0 };
			ragflow.push(entry);
			unmapped.push({ dataset: entry.dataset, source_url: entry.source_url });
			continue;
		}
		const migrated = { dataset: name, source_url: record.source_url, version: record.version };
		ragflow.push(migrated);
		lightrag.push({ ...migrated });
	}
	return { ragflow, lightrag, unmapped };
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

export interface DryRunOptions {
	archiveDir: string;
	answersFile?: string | null;
	gitShow?: (commit: string, path: string) => Promise<string>;
}

/** The dry run: verify, map, gate Part A (Part B only with `--answers`); no network, no writes. */
export async function runDryRun(options: DryRunOptions, io: MigrateIo): Promise<MigrateOutcome> {
	const archiveDir = resolve(options.archiveDir);
	const verify = await verifyArchive(archiveDir);
	if (!verify.ok) {
		const report = { mode: "dry-run", archive: archiveDir, verify: { ok: false, mismatches: verify.mismatches }, refused: "archive verification failed" };
		io.err(`${JSON.stringify(report)}\n`);
		return { ok: false, exit: 1, report, refused: "archive verification failed" };
	}
	const archive = loadArchive(archiveDir);
	const mapping = mapRecords(archive);
	let baseline: Array<{ id: string; source_urls: string[] }> = [];
	let sampleAnswers: Array<Record<string, unknown>> = [];
	if (options.answersFile != null) {
		const answers = JSON.parse(readFileSync(options.answersFile, "utf8")) as Array<{ id: string; source_urls: string[]; degraded?: boolean }>;
		sampleAnswers = answers;
		baseline = archive.baselines.map((entry) => ({ id: entry.id, source_urls: entry.citations.map((citation) => citation.source_url ?? "").filter((url) => url.length > 0) }));
	}
	const gate = parityGate({
		ragflowRecords: mapping.ragflow,
		lightragRecords: mapping.lightrag,
		baseline,
		sampleAnswers: sampleAnswers as never,
		minMatchRate: 0.85,
		skipPartB: sampleAnswers.length === 0,
	});
	const partAOk = gate.partA.passed;
	const marker = partAOk && sampleAnswers.length === 0 ? partAMarker(gate.partA.records) : undefined;
	const report: Record<string, unknown> = {
		mode: "dry-run",
		archive: archiveDir,
		verify: { ok: true, mismatches: [] },
		records: gate.partA.records,
		unmapped: mapping.unmapped,
		mismatches: gate.mismatches,
		partA: gate.partA,
		partB: gate.partB,
		matchRate: gate.matchRate,
		sample_sha256: archive.sampleSha256,
		...(marker !== undefined ? { marker } : {}),
	};
	io.out(`${JSON.stringify(report, null, 2)}\n`);
	const ok = sampleAnswers.length === 0 ? partAOk : gate.passed;
	return { ok, exit: ok ? 0 : 1, report, ...(ok ? {} : { refused: partAOk ? "parity gate Part B failed" : "parity gate Part A failed" }) };
}

export interface ApplyOptions {
	archiveDir: string;
	partAFile: string;
	rehearsal: boolean;
	stateFile: string | null;
	datasets: readonly string[];
	lightragUrl: string;
	lightragApiKey?: string;
	fetchImpl: FetchLike;
	gitShow?: (commit: string, path: string) => Promise<string>;
	now?: () => number;
	poll?: { maxPolls?: number; intervalMs?: number };
	/** When set, ledger events (the cutover note) POST to this substrate URL instead of staying in memory. */
	substrateUrl?: string;
	/** Bearer for the substrate events endpoint; SUBSTRATE_TOKEN_SUBSTRATE is the operator's usual source. */
	substrateToken?: string | undefined;
	/** The fetch the events POST uses; tests inject a capture here instead of the global. */
	eventsFetch?: FetchLike;
}

async function defaultGitShow(commit: string, path: string): Promise<string> {
	const run = promisify(execFile);
	const { stdout } = await run("git", ["show", `${commit}:${path}`], { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
	return stdout;
}

/** The apply: verify, demand the Part A record, replay pages through the LightRAG ingest, carry versions, note the cutover. */
export async function runApply(options: ApplyOptions, io: MigrateIo): Promise<MigrateOutcome> {
	const archiveDir = resolve(options.archiveDir);
	const verify = await verifyArchive(archiveDir);
	if (!verify.ok) {
		const refused = "archive verification failed";
		const report = { mode: "apply", archive: archiveDir, verify: { ok: false, mismatches: verify.mismatches }, refused };
		io.err(`${JSON.stringify(report)}\n`);
		return { ok: false, exit: 1, report, refused };
	}
	const partAText = readFileSync(options.partAFile, "utf8");
	const recorded = partARecorded(partAText);
	if (!recorded.ok) {
		const refused = "--part-a does not record a Part A pass (the dry run's marker line \"parity-gate:part-a:passed records=<N>\")";
		const report = { mode: "apply", archive: archiveDir, part_a: { ok: false, records: null }, refused };
		io.err(`${JSON.stringify(report)}\n`);
		return { ok: false, exit: 1, report, refused };
	}
	const archive = loadArchive(archiveDir);
	const wanted = options.datasets.length > 0 ? new Set(options.datasets) : null;
	const gitShow = options.gitShow ?? defaultGitShow;
	const now = options.now ?? Date.now;
	const seen = new Map<string, IngestRecord>();
	const versions = createVersionStore();
	// A prior apply's records, versions and pins survive: the state file is the
	// store of record, so this apply merges into it instead of replacing it
	// (sequential per-dataset applies must not erase each other).
	if (options.stateFile != null && existsSync(options.stateFile)) {
		const loaded = loadIngestRecordsSync(options.stateFile);
		for (const [key, record] of loaded.records) seen.set(key, record);
		for (const [dataset, entry] of loaded.versions) versions.set(dataset, entry);
	}
	const events: EventInput[] = [];
	let lastEventStored = false;
	const postEvent = options.eventsFetch ?? fetch;
	const emit = async (event: EventInput): Promise<unknown> => {
		events.push(event);
		if (options.substrateUrl === undefined) return { stored: false };
		try {
			const response = await postEvent(new URL("/events", options.substrateUrl), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(options.substrateToken !== undefined ? { authorization: `Bearer ${options.substrateToken}` } : {}),
				},
				body: JSON.stringify(event),
				signal: AbortSignal.timeout(5_000),
			});
			lastEventStored = response.ok;
			return { stored: response.ok };
		} catch {
			lastEventStored = false;
			return { stored: false };
		}
	};
	const names = archive.datasets.map((dataset) => dataset.name);
	const totals = { ingested: 0, replaced: 0, unchanged: 0, failed: 0 };
	const perDataset: Array<Record<string, unknown>> = [];
	let applied = true;
	for (const dataset of archive.datasets) {
		if (wanted !== null && !wanted.has(dataset.name)) continue;
		const byCommit = new Map<string, IngestPage[]>();
		for (const document of dataset.documents) {
			if (document.commit === null || document.path === null || document.source_url === null) continue;
			let body: string;
			try {
				body = await gitShow(document.commit, document.path);
			} catch (cause) {
				const reason = cause instanceof Error ? cause.message.slice(0, 200) : String(cause);
				perDataset.push({ dataset: dataset.name, refused: `git show failed for ${document.path}: ${reason}` });
				applied = false;
				continue;
			}
			const pages = byCommit.get(document.commit) ?? [];
			pages.push({ path: document.path, source_url: document.source_url, body, ...(document.heading_path !== null ? { heading_path: document.heading_path } : {}) });
			byCommit.set(document.commit, pages);
		}
		const datasetReport: Record<string, unknown> = { dataset: dataset.name, commits: byCommit.size, ingested: 0, replaced: 0, unchanged: 0, failed: 0 };
		for (const [commit, pages] of byCommit) {
			const outcome = await ingestDocs(
				{
					config: null,
					backend: "lightrag",
					lightragConfig: { url: options.lightragUrl, ...(options.lightragApiKey !== undefined ? { apiKey: options.lightragApiKey } : {}) },
					lightragDatasets: { list: async () => lightragSearchDatasets(names), invalidate: () => undefined },
					lightragFetch: options.fetchImpl,
					seen,
					locks: new Map(),
					roots: DEFAULT_INGEST_ROOTS,
					surface: "substrate",
					emit,
					...(options.poll !== undefined ? { poll: options.poll } : {}),
				},
				{ dataset: dataset.name, commit, pages },
			);
			if (!outcome.ok) {
				datasetReport.refused = outcome.reason;
				applied = false;
				break;
			}
			for (const result of outcome.results) {
				if (result.status === "ingested") datasetReport.ingested = (datasetReport.ingested as number) + 1;
				else if (result.status === "replaced") datasetReport.replaced = (datasetReport.replaced as number) + 1;
				else if (result.status === "unchanged") datasetReport.unchanged = (datasetReport.unchanged as number) + 1;
				else datasetReport.failed = (datasetReport.failed as number) + 1;
			}
			if ((datasetReport.failed as number) > 0) {
				// Partial ingestion is not a successful apply: the state save, the
				// dataset pins and the cutover note all wait until every page landed.
				applied = false;
				datasetReport.partial = true;
			}
		}
		totals.ingested += datasetReport.ingested as number;
		totals.replaced += datasetReport.replaced as number;
		totals.unchanged += datasetReport.unchanged as number;
		totals.failed += datasetReport.failed as number;
		perDataset.push(datasetReport);
	}
	// Carry the archived generation counts forward: the replay produced new
	// documents, but the per-URL VERSION is the migration's own metadata —
	// the record the replay wrote under the `lightrag::` key takes the
	// archived version, so Part A's triple compares equal and a post-cutover
	// replacement increments from the right generation. The mapping reads the
	// ARCHIVE's records: `seen` now holds only the migrated side's keys.
	let carried = 0;
	for (const migrated of mapRecords(archive).ragflow) {
		const key = `lightrag::${migrated.dataset}::${migrated.source_url}`;
		const prior = seen.get(key);
		if (prior !== undefined && prior.version !== migrated.version) {
			seen.set(key, { ...prior, version: migrated.version });
			carried += 1;
		}
	}
	// Dataset pins: the archived RAGFlow pin becomes the LightRAG pin, so
	// citations keep their commit and a second refresh replaces rather than
	// renumbering. A partial apply records none — the pin claims the dataset
	// migrated, and a dataset with failed pages has not.
	let pins = 0;
	if (applied) {
		for (const [dataset, list] of archive.versions) {
			if (wanted !== null && !wanted.has(dataset)) continue;
			const latest = [...list].reverse().find((version) => version.backend === "ragflow");
			if (latest === undefined) continue;
			recordVersion(versions, {
				dataset,
				dataset_id: dataset,
				version: latest.version,
				commit: latest.commit,
				content_sha256: latest.content_sha256,
				ingested_at: new Date(now()).toISOString(),
				backend: "lightrag",
			});
			pins += 1;
		}
	}
	const statePersisted = !options.rehearsal && options.stateFile != null && applied;
	if (statePersisted) await saveIngestRecords(options.stateFile as string, seen, versions);
	const cutover = !options.rehearsal && applied;
	if (cutover) {
		await emit({
			surface: "substrate",
			kind: "note",
			summary: "docs backend cutover ragflow → lightrag",
			session_id: `docs-migrate:${new Date(now()).toISOString()}`,
			payload: {
				action: "docs.cutover",
				from: "ragflow",
				to: "lightrag",
				at: new Date(now()).toISOString(),
				parity_sha: sha256Hex(readFileSync(options.partAFile, "utf8")),
			},
		});
	}
	const report: Record<string, unknown> = {
		mode: "apply",
		rehearsal: options.rehearsal,
		archive: archiveDir,
		verify: { ok: true, mismatches: [] },
		part_a: { ok: recorded.ok, records: recorded.records },
		datasets: perDataset,
		totals,
		records_lightrag: [...seen.keys()].filter((key) => key.startsWith("lightrag::")).length,
		versions_carried: carried,
		versions_recorded: pins,
		state_file_persisted: statePersisted,
		cutover_note_emitted: cutover,
		cutover_note_stored: cutover && lastEventStored,
	};
	io.out(`${JSON.stringify(report, null, 2)}\n`);
	return { ok: applied, exit: applied ? 0 : 1, report, ...(applied ? {} : { refused: "apply failed; see the report" }) };
}

export interface MigrateEnv {
	env: Record<string, string | undefined>;
}

/** The CLI entry: refuse before any effect on bad flags, a missing archive or a missing Part A record. */
export async function main(
	argv: readonly string[],
	env: Record<string, string | undefined> = process.env,
	io: MigrateIo = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
	fetchImpl: FetchLike = fetch,
): Promise<number> {
	const parsed = parseMigrateArgs(argv);
	if (parsed.reason !== null) {
		io.err(`docs-migrate: ${parsed.reason}\n`);
		return 2;
	}
	const archiveDir = parsed.archive ?? archiveDirFromEnv(env);
	if (archiveDir === null) {
		io.err(`docs-migrate: no archive configured; pass --archive <dir> or set SUBSTRATE_RAGFLOW_ARCHIVE_DIR\n`);
		return 2;
	}
	if (parsed.mode === "dry-run") {
		const outcome = await runDryRun({ archiveDir, ...(parsed.answers !== null ? { answersFile: parsed.answers } : {}) }, io);
		return outcome.exit;
	}
	const reach = lightragFromEnv(env);
	if (reach === null) {
		io.err("docs-migrate: LIGHTRAG_URL is unset; refusing to apply before any socket is opened\n");
		return 2;
	}
	if (parsed.partA === null) {
		io.err("docs-migrate: --apply requires --part-a <file> naming the summary that records the Part A pass\n");
		return 2;
	}
	const outcome = await runApply(
		{
			archiveDir,
			partAFile: parsed.partA,
			rehearsal: parsed.rehearsal,
			stateFile: parsed.stateFile ?? (env.SUBSTRATE_DOCS_STATE_FILE?.trim() || null),
			datasets: parsed.datasets,
			lightragUrl: reach.url,
			...(reach.apiKey !== undefined ? { lightragApiKey: reach.apiKey } : {}),
			fetchImpl,
			...(parsed.substrateUrl !== null && parsed.substrateUrl !== "" ? { substrateUrl: parsed.substrateUrl } : env.SUBSTRATE_URL?.trim() ? { substrateUrl: env.SUBSTRATE_URL.trim() } : {}),
			substrateToken: parsed.substrateToken ?? env.SUBSTRATE_TOKEN_SUBSTRATE?.trim() ?? undefined,
		},
		io,
	);
	return outcome.exit;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
