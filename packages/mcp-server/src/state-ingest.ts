/**
 * Phase 100 (F1): cache-aside STATE ingest into LightRAG with last-good fallback.
 *
 * One STATE/SUMMARY document goes through the existing LightRAG client
 * (`uploadDocument` → `resolveDocumentIds` → `scanDocuments` + `pollParseStatus`;
 * a 409 same-name conflict retries once after an explicit delete of the
 * previous last-good doc ids — the delete-first path the client already owns,
 * not a new route). Success records `last_good_state_reflect` plus a freshness
 * timestamp; failure keeps last-good, stamps `last_attempt` with the reason
 * (never a secret), and returns `{ ok: false, reason, last_good }` — it never
 * throws into an agent turn and never fails silently.
 *
 * The shared `docs_ingest` plane contract is untouched (Phase 102/F3 reuses
 * this same path). Storage is injected (`StateIngestStore`) so tests run fake;
 * `fileStateIngestStore` is the file-backed store over `.lightrag_ingest_state.json`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LightragConfig } from "./config.ts";
import {
	deleteDocuments,
	LIGHTRAG_SAME_NAME_CONFLICT,
	pollParseStatus,
	resolveDocumentIds,
	scanDocuments,
	uploadDocument,
	type FetchLike,
} from "./planes/lightrag.ts";
import { redact } from "./redact.ts";
import { validateT0Provenance, type T0Provenance } from "./t0-provenance.ts";

/** The last successfully ingested STATE reflection. */
export interface LastGoodStateReflect {
	track_id: string;
	doc_ids: string[];
	/** ISO instant of the successful ingest. */
	ingested_at: string;
	commit: string;
	graph_id: string;
	phase: string;
}

/** The durable ingest file: last-good plus the freshness timestamp of the latest attempt. */
export interface StateIngestFile {
	last_good_state_reflect: LastGoodStateReflect | null;
	last_attempt: { at: string; ok: boolean; reason: string | null } | null;
}

/** The document one reflect ingest stores: lineage plus T0 provenance (kind `context`). */
export interface StateReflectDocument {
	/** The LightRAG document name (repo path flattened, e.g. `STATE.md` namespaced per caller). */
	name: string;
	content: string;
	source_url: string;
	commit: string;
	graph_id: string;
	phase: string;
	provenance: T0Provenance;
}

export type StateIngestOutcome =
	| { ok: true; track_id: string; doc_ids: string[] }
	| { ok: false; reason: string; last_good: LastGoodStateReflect | null };

/** Injected durability: load is fail-open (missing/corrupt reads as empty). */
export interface StateIngestStore {
	load(): Promise<StateIngestFile>;
	save(file: StateIngestFile): Promise<void>;
}

export function emptyStateIngestFile(): StateIngestFile {
	return { last_good_state_reflect: null, last_attempt: null };
}

function isStateIngestFile(value: unknown): value is StateIngestFile {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const good = record["last_good_state_reflect"];
	const attempt = record["last_attempt"];
	if (good !== null && (typeof good !== "object" || Array.isArray(good))) return false;
	if (attempt !== null && (typeof attempt !== "object" || Array.isArray(attempt))) return false;
	return true;
}

/**
 * The file-backed store over `.lightrag_ingest_state.json`. `load` never
 * throws (a missing or corrupt file reads as empty, so a fresh checkout
 * ingests everything); `save` creates parent directories. Never carries secrets.
 */
export function fileStateIngestStore(path: string): StateIngestStore {
	return {
		async load(): Promise<StateIngestFile> {
			try {
				const raw = await readFile(path, "utf8");
				const parsed: unknown = JSON.parse(raw);
				return isStateIngestFile(parsed) ? parsed : emptyStateIngestFile();
			} catch {
				return emptyStateIngestFile();
			}
		},
		async save(file: StateIngestFile): Promise<void> {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		},
	};
}

export interface StateIngestOptions {
	timeoutMs?: number;
	maxTrackPolls?: number;
	/** Injected so tests never really wait. */
	sleep?: (ms: number) => Promise<void>;
	/** Injected clock so tests pin the freshness timestamp. */
	nowMs?: () => number;
}

function cleanReason(reason: string): string {
	return redact(reason).slice(0, 300);
}

/**
 * Ingest one STATE/SUMMARY document cache-aside. Order: T0 provenance first
 * (fail-closed: no upload without it), upload, 409 → delete last-good ids and
 * upload once more, resolve doc ids, scan + poll. Every exit stamps
 * `last_attempt`; only a full pass replaces last-good. Never throws.
 */
export async function ingestStateReflectDocument(
	config: LightragConfig,
	doc: StateReflectDocument,
	fetchImpl: FetchLike,
	store: StateIngestStore,
	opts: StateIngestOptions = {},
): Promise<StateIngestOutcome> {
	const nowMs = opts.nowMs ?? Date.now;
	const stamp = (): string => new Date(nowMs()).toISOString();
	const fail = async (reason: string): Promise<StateIngestOutcome> => {
		const file = await store.load().catch(() => emptyStateIngestFile());
		const next: StateIngestFile = { ...file, last_attempt: { at: stamp(), ok: false, reason: cleanReason(reason) } };
		await store.save(next).catch(() => {});
		return { ok: false, reason: cleanReason(reason), last_good: file.last_good_state_reflect };
	};
	try {
		const proven = validateT0Provenance("context", doc.provenance);
		if (!proven.ok) return fail(`state-ingest refused: ${proven.reason}`);
		if (doc.name.trim().length === 0 || doc.content.trim().length === 0) {
			return fail("state-ingest refused: document needs a non-blank name and content");
		}
		const timeoutMs = opts.timeoutMs ?? 8000;
		const first = await uploadDocument(
			config,
			{ name: doc.name, content: doc.content, metadata: { source_url: doc.source_url, commit: doc.commit, heading_path: "" } },
			fetchImpl,
			timeoutMs,
		);
		let uploaded = first;
		if (!uploaded.ok && uploaded.conflict === true) {
			const prior = (await store.load().catch(() => emptyStateIngestFile())).last_good_state_reflect;
			if (prior !== null && prior.doc_ids.length > 0) {
				const removed = await deleteDocuments(config, "", prior.doc_ids, fetchImpl, timeoutMs);
				if (removed.ok) {
					uploaded = await uploadDocument(
						config,
						{ name: doc.name, content: doc.content, metadata: { source_url: doc.source_url, commit: doc.commit, heading_path: "" } },
						fetchImpl,
						timeoutMs,
					);
				} else {
					return fail(`state-ingest 409 delete-first failed: ${removed.reason}`);
				}
			} else {
				return fail(`state-ingest: ${LIGHTRAG_SAME_NAME_CONFLICT} with no prior doc ids to delete`);
			}
		}
		if (!uploaded.ok) return fail(`state-ingest upload failed: ${uploaded.reason}`);
		const tracked = await resolveDocumentIds(config, uploaded.track_id, fetchImpl, {
			maxPolls: opts.maxTrackPolls ?? 10,
			...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
		});
		if (!tracked.ok) return fail(`state-ingest track_status failed: ${tracked.reason}`);
		const scanned = await scanDocuments(config, fetchImpl, timeoutMs);
		if (!scanned.ok) return fail(`state-ingest scan failed: ${scanned.reason}`);
		const parsed = await pollParseStatus(config, { dataset_id: "", document_id: tracked.ids[0] ?? "" }, fetchImpl, {
			...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
		});
		if (!parsed.ok) return fail(`state-ingest parse failed: ${parsed.reason}`);
		const last_good: LastGoodStateReflect = {
			track_id: uploaded.track_id,
			doc_ids: tracked.ids,
			ingested_at: stamp(),
			commit: doc.commit,
			graph_id: doc.graph_id,
			phase: doc.phase,
		};
		await store.save({ last_good_state_reflect: last_good, last_attempt: { at: stamp(), ok: true, reason: null } }).catch(() => {});
		return { ok: true, track_id: uploaded.track_id, doc_ids: tracked.ids };
	} catch (cause) {
		return fail(`state-ingest failed: ${cause instanceof Error ? cause.message : String(cause).slice(0, 120)}`);
	}
}
