/**
 * The execute half of `substrate corpus ingest`: send the tombstones first, as requests of their own, then read the
 * bodies of the documents a plan says must change and send them in bounded batches. Bodies are read one document at a
 * time, so memory is bounded by one batch.
 *
 * Tombstones go first so that a rename deletes the old plane document before the same text is inserted under the new
 * name: the plane answers an insert of identical text with the old document, which the removal would otherwise leave
 * linked. Re-running is safe: the server skips rows it already recorded, so a run killed half way resumes without
 * re-sending. A rename's old row is removed only when the new document passes every check the server applies (readable, the
 * hash planned, a valid name and path, within the size bound, not empty); otherwise the old row stays, the new document is
 * reported `refused` or `failed`, and nothing is deleted. The new document is sent only when the old row was removed. When
 * the new document is accepted for sending and then fails (plane down, timeout) the old copy is already gone: the next run
 * plans the new path as an `add` and sends it again, so nothing is lost silently.
 */
import {
	CORPUS_PROTOCOL,
	MAX_INGEST_DOCUMENTS,
	MAX_INGEST_TOMBSTONES,
	documentKey,
	documentRefusal,
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

interface IngestInput {
	plan: CorpusPlanResponse;
	inventory: Inventory;
	client: CorpusClient;
	/** Where GitHub bodies were spilled during the scan; null when the scan used no GitHub source. */
	bodies: BodyStore | null;
	readFile: (path: string) => Uint8Array;
	maxBytes: number;
	/** Documents per request; never more than the server accepts (`MAX_INGEST_DOCUMENTS`), whatever is asked. */
	batchDocs: number;
	batchBytes: number;
}

interface IngestOutcome {
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

type Prepared = { ok: true; body: string } | { ok: false; status: "failed" | "refused"; reason: string };

/**
 * The body of a document that is also fit to send: readable, unchanged since the scan, and passing the rules the server
 * would refuse it for (`documentRefusal`, the one shared copy). A document the server would refuse is `refused` here, with the
 * server's own reason code, before anything is sent or deleted for it.
 */
function prepare(entry: CorpusEntry, input: IngestInput): Prepared {
	const loaded = loadBody(entry, input);
	if (!loaded.ok) return { ok: false, status: "failed", reason: loaded.reason };
	const refusal = documentRefusal({ repo: entry.repo, path: entry.path, sha256: entry.sha256, body: loaded.body });
	return refusal === null ? { ok: true, body: loaded.body } : { ok: false, status: "refused", reason: refusal };
}

/** The old path of a rename: the plan names the manifest row, in this repository, with or without the `repo:` prefix. */
function renamedFromPath(item: PlanItem): string | null {
	if (item.renamedFrom === undefined) return null;
	const prefix = `${item.repo}:`;
	const path = item.renamedFrom.startsWith(prefix) ? item.renamedFrom.slice(prefix.length) : item.renamedFrom;
	return path === "" || path === item.path ? null : path;
}

export async function executeIngest(input: IngestInput): Promise<IngestOutcome> {
	const counts: Record<IngestStatus, number> = { ingested: 0, updated: 0, unchanged: 0, tombstoned: 0, refused: 0, failed: 0 };
	const problems: IngestProblem[] = [];
	const statusOf = new Map<string, IngestStatus>();
	const state: { manifestVersion: number | null; fatal: ClientError | null } = { manifestVersion: null, fatal: null };
	const batchDocs = Math.max(1, Math.min(Math.floor(input.batchDocs), MAX_INGEST_DOCUMENTS));

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

	// A file skipped because the server's rules refuse its path never reaches the plan; it is reported here as refused so the run does not look clean.
	let listedBadPaths = 0;
	for (const skip of input.inventory.report.skipped) {
		if (skip.reason !== "bad-path") continue;
		record(skip.repo, skip.path, "refused", "bad-path");
		listedBadPaths += 1;
	}
	// The skip list is capped, the count is exact.
	counts.refused += Math.max(0, (input.inventory.report.skippedByReason["bad-path"] ?? 0) - listedBadPaths);

	// Phase 1: every tombstone, in requests of their own, before any document is inserted.
	const tombstones = new Map<string, { repo: string; path: string }>();
	const removedBefore = new Map<string, string>();
	for (const item of input.plan.items) {
		if (item.action === "tombstone") {
			tombstones.set(documentKey(item.repo, item.path), { repo: item.repo, path: item.path });
		} else if (item.action === "rename") {
			const from = renamedFromPath(item);
			const entry = entryByKey.get(documentKey(item.repo, item.path));
			// The old text is removed only when the new document passes every check the server applies; a replacement
			// that cannot be sent leaves the old row active and is reported as refused or failed in phase 2.
			if (from !== null && entry !== undefined && prepare(entry, input).ok) {
				tombstones.set(documentKey(item.repo, from), { repo: item.repo, path: from });
				removedBefore.set(documentKey(item.repo, item.path), documentKey(item.repo, from));
			}
		}
	}
	const pending = [...tombstones.values()];
	for (let start = 0; start < pending.length && state.fatal === null; start += MAX_INGEST_TOMBSTONES) {
		const chunk = pending.slice(start, start + MAX_INGEST_TOMBSTONES);
		// The scope the plan was built with: the server refuses a tombstone request without it, and judges each tombstone against it.
		const response = await input.client.ingest({ protocol: CORPUS_PROTOCOL, documents: [], tombstones: chunk, scope: input.inventory.scope });
		if (response.ok) absorb(response.value, chunk);
		else failAll(chunk, response.error);
	}

	// Phase 2: the documents, in batches bounded by count and bytes.
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
		if (item.action !== "add" && item.action !== "change" && item.action !== "update" && item.action !== "rename") continue;
		if (state.fatal !== null) break;
		const entry = entryByKey.get(documentKey(item.repo, item.path));
		if (entry === undefined) {
			record(item.repo, item.path, "failed", "not-in-scan");
			continue;
		}
		const source = removedBefore.get(documentKey(item.repo, item.path));
		if (source !== undefined) {
			const removed = statusOf.get(source);
			// Inserting the new name while the old row is still there would link it to the old plane document.
			if (removed !== "tombstoned" && removed !== "unchanged") {
				record(item.repo, item.path, "failed", "rename-source-not-removed");
				continue;
			}
		}
		const loaded = prepare(entry, input);
		if (!loaded.ok) {
			record(item.repo, item.path, loaded.status, loaded.reason);
			continue;
		}
		if (batch.length > 0 && (batch.length >= batchDocs || batchBytes + entry.bytes > input.batchBytes)) await flush();
		if (state.fatal !== null) break;
		batch.push({ ...entry, body: loaded.body });
		batchBytes += entry.bytes;
	}
	if (state.fatal === null) await flush();

	return { summary: { counts, problems, manifestVersion: state.manifestVersion }, fatal: state.fatal };
}
