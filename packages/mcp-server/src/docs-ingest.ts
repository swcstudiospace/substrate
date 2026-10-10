/**
 * DOCS-02: fail-closed docs ingest over RAGFlow (D25-05).
 *
 * Every page is stripped of remote images, scanned by the Phase 18 redactor
 * BEFORE upload and refused — never cleaned-and-published — on any finding.
 * Six refusals fail closed with locator-only warning events: a redactor
 * finding, a page with no source URL, a path outside the configured roots,
 * a page or call over the size caps, an unauthenticated caller, a VM guest.
 * Uploads are idempotent by content hash and always carry
 * `{source_url, commit, heading_path}` metadata (U-03).
 */
import { createHash, randomUUID } from "node:crypto";
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
}

export type IngestOutcome =
	| { ok: true; results: IngestPageResult[]; stripped_images: number }
	| { ok: false; refused: true; reason: string; rules?: string[]; page?: string };

/** A source URL's last ingest, for hash idempotency. */
export interface IngestRecord {
	sha: string;
	dataset_id: string;
	document_id: string;
}

export interface IngestDeps {
	config: RagflowConfig | null;
	roots?: readonly string[];
	vmGuest?: boolean;
	seen?: Map<string, IngestRecord>;
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
	return roots.some((root) => (root.endsWith("/") ? path.startsWith(root) : path === root));
}

export async function ingestDocs(deps: IngestDeps, input: IngestInput): Promise<IngestOutcome> {
	const sessionId = deps.sessionId ?? `docs-ingest:${randomUUID()}`;
	const roots = deps.roots ?? DEFAULT_INGEST_ROOTS;
	const seen = deps.seen ?? new Map<string, IngestRecord>();
	if (deps.surface === null) return refused(deps, sessionId, "unauthenticated");
	if (deps.vmGuest === true) return refused(deps, sessionId, "vm-guest");
	if (deps.config === null) return refused(deps, sessionId, "ragflow-not-configured");
	if (input.pages.length === 0) return refused(deps, sessionId, "no-pages");

	const prepared: Array<{ page: IngestPage; sourceUrl: string; body: string; sha: string }> = [];
	let total = 0;
	let strippedImages = 0;
	for (const page of input.pages) {
		if (!page.source_url) return refused(deps, sessionId, "no-source-url", { page: page.path });
		if (!underRoot(page.path, roots)) return refused(deps, sessionId, "outside-roots", { page: page.path });
		const stripped = stripRemoteImages(page.body);
		strippedImages += stripped.stripped;
		const size = Buffer.byteLength(stripped.body, "utf8");
		if (size > INGEST_PAGE_MAX_BYTES) return refused(deps, sessionId, "page-too-large", { page: page.path });
		total += size;
		if (total > INGEST_CALL_MAX_BYTES) return refused(deps, sessionId, "call-too-large", { page: page.path });
		const rules = findingRules(stripped.body);
		if (rules.length > 0) return refused(deps, sessionId, "secret-findings", { rules, page: page.path });
		prepared.push({ page, sourceUrl: page.source_url, body: stripped.body, sha: sha256(stripped.body) });
	}

	const listed = await listDatasets(deps.config, deps.fetchImpl);
	if (!listed.ok) return refused(deps, sessionId, listed.reason);
	const dataset = listed.datasets.find((entry) => entry.name === input.dataset);
	if (!dataset) return refused(deps, sessionId, "unknown-dataset");
	const commit = input.commit ?? "unpinned";

	const results: IngestPageResult[] = [];
	for (const { page, sourceUrl, body, sha } of prepared) {
		const prior = seen.get(sourceUrl);
		if (prior && prior.sha === sha && prior.dataset_id === dataset.id) {
			results.push({ path: page.path, source_url: sourceUrl, status: "unchanged", document_id: prior.document_id, content_sha256: sha });
			continue;
		}
		const uploaded = await uploadDocument(
			deps.config,
			{
				dataset_id: dataset.id,
				content: body,
				metadata: { source_url: sourceUrl, commit, heading_path: page.heading_path ?? "" },
			},
			deps.fetchImpl,
		);
		if (!uploaded.ok) return refused(deps, sessionId, uploaded.reason, { page: page.path });
		const parsed = await pollParseStatus(deps.config, uploaded.document_id, deps.fetchImpl, { intervalMs: 0 });
		if (!parsed.ok) return refused(deps, sessionId, parsed.reason, { page: page.path });
		seen.set(sourceUrl, { sha, dataset_id: dataset.id, document_id: uploaded.document_id });
		results.push({
			path: page.path,
			source_url: sourceUrl,
			status: prior ? "replaced" : "ingested",
			document_id: uploaded.document_id,
			content_sha256: sha,
		});
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
			stripped_images: strippedImages,
		},
	});
	return { ok: true, results, stripped_images: strippedImages };
}
