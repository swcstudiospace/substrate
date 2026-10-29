/**
 * The execute half of `substrate corpus ingest`: read the bodies of the documents a plan says must change, send them in
 * bounded batches, then send the tombstones. Bodies are read one document at a time, so memory is bounded by one batch.
 *
 * Re-running is safe: the server skips rows it already recorded, so a run killed half way resumes without re-sending.
 * A rename's old row is removed only when the new document was recorded; otherwise the old text would be lost.
 */
import {
	CORPUS_PROTOCOL,
	documentKey,
	inspectBytes,
	type CorpusDocument,
	type CorpusEntry,
	type CorpusIngestResponse,
	type CorpusPlanResponse,
	type IngestStatus,
	type PlanItem,
} from "@substrate/corpus";
import type { BodyStore } from "./bodies.ts";
import type { ClientError, CorpusClient } from "./client.ts";
import type { Inventory } from "./inventory.ts";
import type { IngestProblem, IngestSummary } from "./render.ts";

/** Tombstones sent per request. */
export const TOMBSTONE_BATCH = 200;

export interface IngestInput {
	plan: CorpusPlanResponse;
	inventory: Inventory;
	client: CorpusClient;
	/** Where GitHub bodies were spilled during the scan; null when the scan used no GitHub source. */
	bodies: BodyStore | null;
	readFile: (path: string) => Uint8Array;
	maxBytes: number;
	batchDocs: number;
	batchBytes: number;
}

export interface IngestOutcome {
	summary: IngestSummary;
	/** Set when a request failed as a whole (transport, auth, protocol); the rest of the run was not attempted. */
	fatal: ClientError | null;
}

type Body = { ok: true; body: string } | { ok: false; reason: string };

function loadBody(entry: CorpusEntry, input: IngestInput): Body {
	if (entry.source === "github") {
		const body = input.bodies?.get(entry.sha256) ?? null;
		return body === null ? { ok: false, reason: "body-unavailable" } : { ok: true, body };
	}
	const location = input.inventory.paths.get(documentKey(entry.repo, entry.path));
	if (location === undefined) return { ok: false, reason: "body-unavailable" };
	let raw: Uint8Array;
	try {
		raw = input.readFile(location);
	} catch {
		// The file went away or became unreadable after the scan; the next run plans it again.
		return { ok: false, reason: "unreadable" };
	}
	const inspected = inspectBytes(raw, input.maxBytes);
	// The plan was made from the scanned hash; a different one means the file changed since, and sending it would
	// record a hash the manifest never planned.
	if (!inspected.ok || inspected.sha256 !== entry.sha256) return { ok: false, reason: "changed-since-scan" };
	return { ok: true, body: inspected.text };
}

/** The old path of a rename: the plan names the manifest row, in this repository, with or without the `repo:` prefix. */
function renamedFromPath(item: PlanItem): string | null {
	if (item.renamedFrom === undefined) return null;
	const prefix = `${item.repo}:`;
	const path = item.renamedFrom.startsWith(prefix) ? item.renamedFrom.slice(prefix.length) : item.renamedFrom;
	return path === "" || path === item.path ? null : path;
}

export async function executeIngest(input: IngestInput): Promise<IngestOutcome> {
	const counts: Record<IngestStatus, number> = { ingested: 0, unchanged: 0, tombstoned: 0, refused: 0, failed: 0 };
	const problems: IngestProblem[] = [];
	const statusOf = new Map<string, IngestStatus>();
	const state: { manifestVersion: number | null; fatal: ClientError | null } = { manifestVersion: null, fatal: null };

	const record = (repo: string, path: string, status: IngestStatus, reason?: string): void => {
		counts[status] += 1;
		statusOf.set(documentKey(repo, path), status);
		if (status === "failed" || status === "refused") problems.push({ repo, path, status, reason });
	};
	const absorb = (response: CorpusIngestResponse, sent: ReadonlyArray<{ repo: string; path: string }>): void => {
		state.manifestVersion = response.manifestVersion;
		const byKey = new Map(response.results.map((result) => [documentKey(result.repo, result.path), result]));
		for (const item of sent) {
			const result = byKey.get(documentKey(item.repo, item.path));
			if (result === undefined) record(item.repo, item.path, "failed", "no-result");
			else record(item.repo, item.path, result.status, result.reason);
		}
	};
	const failAll = (sent: ReadonlyArray<{ repo: string; path: string }>, error: ClientError): void => {
		state.fatal = error;
		for (const item of sent) record(item.repo, item.path, "failed", `request-${error.kind}`);
	};

	const entryByKey = new Map(input.inventory.entries.map((entry) => [documentKey(entry.repo, entry.path), entry]));
	let batch: CorpusDocument[] = [];
	let batchBytes = 0;
	const flush = async (): Promise<void> => {
		if (batch.length === 0) return;
		const sent = batch;
		batch = [];
		batchBytes = 0;
		const response = await input.client.ingest({ protocol: CORPUS_PROTOCOL, documents: sent, tombstones: [] });
		if (response.ok) absorb(response.value, sent);
		else failAll(sent, response.error);
	};

	for (const item of input.plan.items) {
		if (item.action !== "add" && item.action !== "change" && item.action !== "rename") continue;
		if (state.fatal !== null) break;
		const entry = entryByKey.get(documentKey(item.repo, item.path));
		if (entry === undefined) {
			record(item.repo, item.path, "failed", "not-in-scan");
			continue;
		}
		const loaded = loadBody(entry, input);
		if (!loaded.ok) {
			record(item.repo, item.path, "failed", loaded.reason);
			continue;
		}
		if (batch.length > 0 && (batch.length >= input.batchDocs || batchBytes + entry.bytes > input.batchBytes)) await flush();
		if (state.fatal !== null) break;
		batch.push({ ...entry, body: loaded.body });
		batchBytes += entry.bytes;
	}
	if (state.fatal === null) await flush();

	const tombstones: Array<{ repo: string; path: string }> = [];
	for (const item of input.plan.items) {
		if (item.action === "tombstone") {
			tombstones.push({ repo: item.repo, path: item.path });
		} else if (item.action === "rename") {
			const from = renamedFromPath(item);
			const recorded = statusOf.get(documentKey(item.repo, item.path));
			if (from !== null && (recorded === "ingested" || recorded === "unchanged")) tombstones.push({ repo: item.repo, path: from });
		}
	}
	for (let start = 0; start < tombstones.length && state.fatal === null; start += TOMBSTONE_BATCH) {
		const chunk = tombstones.slice(start, start + TOMBSTONE_BATCH);
		const response = await input.client.ingest({ protocol: CORPUS_PROTOCOL, documents: [], tombstones: chunk });
		if (response.ok) absorb(response.value, chunk);
		else failAll(chunk, response.error);
	}

	return { summary: { counts, problems, manifestVersion: state.manifestVersion }, fatal: state.fatal };
}
