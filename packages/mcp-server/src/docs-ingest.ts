/**
 * DOCS-02: fail-closed docs ingest over RAGFlow (D25-05).
 *
 * Every page is stripped of remote images, scanned by the Phase 18 redactor
 * BEFORE upload and refused — never cleaned-and-published — on any finding.
 * The scan covers the body AND the outgoing metadata (`source_url`,
 * `commit`, `heading_path`): a clean body cannot publish a secret through a
 * heading. Six refusals fail closed with locator-only warning events: a
 * redactor finding, a page with no source URL, a path outside the
 * configured roots, a page or call over the size caps, an unauthenticated
 * caller, a VM guest. Both the posted `path` and the client-resolved
 * `real_path` (when present) must sit under the roots after dot-segment
 * normalization, so `docs/../private.md` and symlink escapes are refused.
 *
 * Uploads are idempotent by content hash, keyed by dataset plus source URL,
 * with per-page in-flight locks so concurrent retries share one upload.
 * Every upload sends `{source_url, commit, heading_path}` metadata (U-03).
 * A replacement reports the superseded document id for the G3 retire step:
 * the delete path is unverified (U-02), so this phase exposes the id rather
 * than calling a guessed endpoint.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	listDatasets,
	pollParseStatus,
	uploadDocument,
	type FetchLike,
	type RagflowConfig,
} from "./planes/ragflow.ts";
import { REDACTION_RULES, redact, redactSkillContent } from "./redact.ts";
import type { EventInput, Surface } from "./types.ts";

/** One page may not exceed 1 MB (D25-05, Phase 21 precedent). */
export const INGEST_PAGE_MAX_BYTES = 1_000_000;
/** One ingest call may not exceed 5 MB total. */
export const INGEST_CALL_MAX_BYTES = 5_000_000;

/**
 * Where ingestable pages live, as path prefixes. Mirrors the
 * `agent-substrate` dataset sources in `docs/data-planes.md`
 * (`README.md`, `docs/`, `.planning/PROJECT.md`).
 */
export const DEFAULT_INGEST_ROOTS: readonly string[] = ["docs/", "README.md", ".planning/PROJECT.md"];

export interface IngestPage {
	path: string;
	/** The client-resolved filesystem path, when the caller read one. Also gated. */
	real_path?: string;
	source_url?: string;
	body: string;
	heading_path?: string;
}

export interface IngestInput {
	dataset: string;
	commit?: string;
	pages: IngestPage[];
	session_id?: string;
}

export interface IngestPageResult {
	path: string;
	source_url: string;
	status: "ingested" | "replaced" | "unchanged";
	document_id: string;
	content_sha256: string;
	/** The prior document this upload supersedes; retired by the G3 step. */
	superseded_document_id?: string;
}

/** One page's upload, shared with concurrent retries for the same key. */
export type PageSettlement =
	| { ok: true; result: IngestPageResult }
	| { ok: false; reason: string };

export type IngestOutcome =
	| { ok: true; results: IngestPageResult[]; stripped_images: number }
	| { ok: false; refused: true; reason: string; rules?: string[]; page?: string };

/** A source URL's last ingest in one dataset, for hash idempotency. */
export interface IngestRecord {
	sha: string;
	dataset_id: string;
	source_url: string;
	document_id: string;
}

export interface IngestDeps {
	config: RagflowConfig | null;
	roots?: readonly string[];
	vmGuest?: boolean;
	/** Records keyed `${dataset_id}::${source_url}`; held by the service, optionally persisted. */
	seen?: Map<string, IngestRecord>;
	/** In-flight uploads by the same key; held by the service so retries share one upload. */
	locks?: Map<string, Promise<PageSettlement>>;
	/** Parse budget; production passes a real delay, tests pass zero. */
	poll?: { maxPolls?: number; intervalMs?: number };
	emit: (event: EventInput) => Promise<unknown>;
	surface: Surface | null;
	sessionId?: string;
	fetchImpl?: FetchLike;
}

const REMOTE_IMG_TAG = /<img\b[^>]*\bsrc\s*=\s*["']https?:[^>]*>/gi;
const REMOTE_MD_IMAGE = /!\[[^\]]*\]\(\s*https?:[^)]+\)/g;

/** Strip remote images pre-upload; local image paths are left for the gates. */
export function stripRemoteImages(body: string): { body: string; stripped: number } {
	let stripped = 0;
	const withoutTags = body.replace(REMOTE_IMG_TAG, () => {
		stripped += 1;
		return "";
	});
	const withoutMd = withoutTags.replace(REMOTE_MD_IMAGE, () => {
		stripped += 1;
		return "";
	});
	return { body: withoutMd, stripped };
}

/**
 * Every redactor rule that fires on the text, by rule name.
 *
 * Runs the event-path rules plus the skill-shaped scan before anything is
 * uploaded: a firing rule is a refusal, never a quiet replacement. If
 * rehearsal surfaces a RAGFlow-shaped secret this misses, the rule lands in
 * Phase 18's `redact.ts`, not here (CONTEXT out-of-scope).
 */
export function findingRules(text: string): string[] {
	const rules = new Set<string>();
	for (const rule of REDACTION_RULES) {
		const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
		if (new RegExp(rule.pattern.source, flags).test(text)) rules.add(rule.name);
	}
	const skill = redactSkillContent(text);
	for (const hit of [...skill.findings, ...skill.redactions]) rules.add(hit.rule);
	if (redact(text) !== text && rules.size === 0) rules.add("unknown-rule");
	return [...rules];
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A repo-rooted path with dot-segments resolved, or null when it escapes.
 *
 * Backslashes become slashes, absolute paths are refused, and `..` that
 * climbs past the repo root yields null — so `docs/../private.md`
 * normalizes to `private.md` and fails the roots check instead of passing
 * it. The CLI carries its own copy (it cannot import this module without
 * breaking the substrate-only door) pinned by a text test.
 */
export function normalizeIngestPath(path: string): string | null {
	const slashed = path.replace(/\\/g, "/");
	if (slashed.startsWith("/")) return null;
	const parts: string[] = [];
	for (const part of slashed.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join("/");
}
function refused(
	deps: IngestDeps,
	sessionId: string,
	reason: string,
	extra?: { rules?: string[]; page?: string },
): Promise<IngestOutcome> {
	const outcome: IngestOutcome = { ok: false, refused: true, reason, ...extra };
	if (deps.surface === null) return Promise.resolve(outcome);
	return deps
		.emit({
			surface: deps.surface,
			kind: "warning",
			summary: `docs ingest refused: ${reason}`,
			session_id: sessionId,
			payload: {
				action: "docs.ingest",
				status: "refused",
				reason,
				...(extra?.rules !== undefined ? { rules: extra.rules } : {}),
				...(extra?.page !== undefined ? { page: extra.page } : {}),
			},
		})
		.then(
			() => outcome,
			() => outcome,
		);
}

function underRoot(path: string, roots: readonly string[]): boolean {
	const clean = normalizeIngestPath(path);
	if (clean === null) return false;
	return roots.some((root) => (root.endsWith("/") ? clean.startsWith(root) : clean === root));
}

function recordKey(datasetId: string, sourceUrl: string): string {
	return `${datasetId}::${sourceUrl}`;
}

export async function ingestDocs(deps: IngestDeps, input: IngestInput): Promise<IngestOutcome> {
	const sessionId = deps.sessionId ?? `docs-ingest:${randomUUID()}`;
	const roots = deps.roots ?? DEFAULT_INGEST_ROOTS;
	const seen = deps.seen ?? new Map<string, IngestRecord>();
	const locks = deps.locks ?? new Map<string, Promise<PageSettlement>>();
	const config = deps.config;
	if (deps.surface === null) return refused(deps, sessionId, "unauthenticated");
	if (deps.vmGuest === true) return refused(deps, sessionId, "vm-guest");
	if (config === null) return refused(deps, sessionId, "ragflow-not-configured");
	if (input.pages.length === 0) return refused(deps, sessionId, "no-pages");

	const prepared: Array<{ page: IngestPage; sourceUrl: string; body: string; sha: string }> = [];
	let total = 0;
	let strippedImages = 0;
	for (const page of input.pages) {
		if (!page.source_url) return refused(deps, sessionId, "no-source-url", { page: page.path });
		if (!underRoot(page.path, roots)) return refused(deps, sessionId, "outside-roots", { page: page.path });
		if (page.real_path !== undefined && !underRoot(page.real_path, roots)) {
			return refused(deps, sessionId, "outside-roots", { page: page.path });
		}
		const stripped = stripRemoteImages(page.body);
		strippedImages += stripped.stripped;
		const size = Buffer.byteLength(stripped.body, "utf8");
		if (size > INGEST_PAGE_MAX_BYTES) return refused(deps, sessionId, "page-too-large", { page: page.path });
		total += size;
		if (total > INGEST_CALL_MAX_BYTES) return refused(deps, sessionId, "call-too-large", { page: page.path });
		const rules = findingRules(`${stripped.body}\n${page.source_url}\n${input.commit ?? ""}\n${page.heading_path ?? ""}`);
		if (rules.length > 0) return refused(deps, sessionId, "secret-findings", { rules, page: page.path });
		prepared.push({ page, sourceUrl: page.source_url, body: stripped.body, sha: sha256(stripped.body) });
	}

	const listed = await listDatasets(config, deps.fetchImpl);
	if (!listed.ok) return refused(deps, sessionId, listed.reason);
	const dataset = listed.datasets.find((entry) => entry.name === input.dataset);
	if (!dataset) return refused(deps, sessionId, "unknown-dataset");
	const commit = input.commit ?? "unpinned";

	const results: IngestPageResult[] = [];
	for (const { page, sourceUrl, body, sha } of prepared) {
		const key = recordKey(dataset.id, sourceUrl);
		const prior = seen.get(key);
		if (prior && prior.sha === sha) {
			results.push({ path: page.path, source_url: sourceUrl, status: "unchanged", document_id: prior.document_id, content_sha256: sha });
			continue;
		}
		// Synchronous check-and-set: no await sits between the lookup and
		// the store, so a concurrent retry for the same key joins this
		// upload instead of starting a second one.
		const running = locks.get(key);
		if (running) {
			const settled = await running;
			if (!settled.ok) return refused(deps, sessionId, settled.reason, { page: page.path });
			results.push(settled.result);
			continue;
		}
		const task: Promise<PageSettlement> = (async (): Promise<PageSettlement> => {
			const uploaded = await uploadDocument(
				config,
				{
					dataset_id: dataset.id,
					content: body,
					metadata: { source_url: sourceUrl, commit, heading_path: page.heading_path ?? "" },
				},
				deps.fetchImpl,
			);
			if (!uploaded.ok) return { ok: false, reason: uploaded.reason };
			const parsed = await pollParseStatus(config, uploaded.document_id, deps.fetchImpl, {
				maxPolls: deps.poll?.maxPolls,
				intervalMs: deps.poll?.intervalMs,
			});
			if (!parsed.ok) return { ok: false, reason: parsed.reason };
			const result: IngestPageResult = {
				path: page.path,
				source_url: sourceUrl,
				status: prior ? "replaced" : "ingested",
				document_id: uploaded.document_id,
				content_sha256: sha,
				...(prior ? { superseded_document_id: prior.document_id } : {}),
			};
			seen.set(key, { sha, dataset_id: dataset.id, source_url: sourceUrl, document_id: uploaded.document_id });
			return { ok: true, result };
		})();
		locks.set(key, task);
		let settled: PageSettlement;
		try {
			settled = await task;
		} finally {
			if (locks.get(key) === task) locks.delete(key);
		}
		if (!settled.ok) return refused(deps, sessionId, settled.reason, { page: page.path });
		results.push(settled.result);
	}

	await deps.emit({
		surface: deps.surface,
		kind: "note",
		summary: `docs ingest ${results.every((result) => result.status === "unchanged") ? "skipped" : "stored"} ${results.length} page(s) into ${dataset.name}`,
		session_id: sessionId,
		payload: {
			action: "docs.ingest",
			dataset_id: dataset.id,
			source_urls: results.map((result) => result.source_url),
			content_sha256: results.map((result) => result.content_sha256),
			superseded_document_ids: results.flatMap((result) => (result.superseded_document_id ? [result.superseded_document_id] : [])),
			stripped_images: strippedImages,
		},
	});
	return { ok: true, results, stripped_images: strippedImages };
}

/**
 * Ingest records on disk, so a restarted server does not re-upload pages it
 * already stored (Greptile P1). A missing or corrupt file means an empty
 * map, never a throw: losing dedup degrades to a duplicate upload, while
 * refusing ingest over an unreadable file would turn a disk hiccup into an
 * outage of the publication path. The caller reports the problem string.
 */
export interface IngestStateFile {
	version: 1;
	records: Record<string, IngestRecord>;
}

export async function loadIngestRecords(file: string): Promise<{ records: Map<string, IngestRecord>; problem?: string }> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return { records: new Map<string, IngestRecord>() };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { records: new Map<string, IngestRecord>(), problem: `${file} is not valid JSON; starting with empty ingest records` };
	}
	if (parsed === null || typeof parsed !== "object" || !("records" in parsed) || parsed.records === null || typeof parsed.records !== "object") {
		return { records: new Map<string, IngestRecord>(), problem: `${file} has no records table; starting with empty ingest records` };
	}
	const records = new Map<string, IngestRecord>();
	for (const [key, record] of Object.entries(parsed.records)) {
		if (record === null || typeof record !== "object") continue;
		if (!("sha" in record) || !("dataset_id" in record) || !("source_url" in record) || !("document_id" in record)) continue;
		if (typeof record.sha !== "string" || typeof record.dataset_id !== "string" || typeof record.source_url !== "string" || typeof record.document_id !== "string") {
			continue;
		}
		records.set(key, { sha: record.sha, dataset_id: record.dataset_id, source_url: record.source_url, document_id: record.document_id });
	}
	return { records };
}

/** Persist ingest records. Throws on I/O failure; the caller logs and continues. */
export async function saveIngestRecords(file: string, seen: Map<string, IngestRecord>): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const state: IngestStateFile = { version: 1, records: Object.fromEntries(seen) };
	await writeFile(file, `${JSON.stringify(state)}\n`, "utf8");
}
