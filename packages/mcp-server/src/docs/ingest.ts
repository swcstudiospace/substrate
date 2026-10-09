/**
 * Docs ingest pipeline (D25-08 through D25-11, D25-15, D25-16).
 *
 * Fixed order per D25-10 — nothing reaches RAGFlow before step 5:
 *  1. writer check (already-attributed surface + substrate/operator flag;
 *     routes/MCP enforce D25-07 in plan 25-04, the function refuses otherwise);
 *  2. shape, roots, caps (D25-08, D25-09);
 *  3. image stripping (D25-11);
 *  4. `redactSkillContent` — any high-confidence finding refuses as `secret`;
 *  5. hash, split, idempotency, upload, parse (D25-15 through D25-17).
 *
 * `dry_run` stops after step 4 plus the hash and split: it reports what would
 * happen and performs no upload, parse, manifest write, or RAGFlow call.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { redactSkillContent } from "../redact.ts";
import type { SkillRedactionHit } from "../redact.ts";
import { RagflowError } from "./ragflow.ts";
import { dropDatasetId, findDataset, loadRegistry, resolveDatasetId } from "./registry.ts";
import type { DatasetEntry } from "./registry.ts";
import {
	loadManifest,
	saveManifest,
	withDatasetLock,
} from "./manifest.ts";
import type { DocsManifest, DocsRagflow, SectionDocMeta } from "./manifest.ts";

/** 256 KiB of UTF-8 after image stripping (D25-09). */
export const MAX_CONTENT_BYTES = 256 * 1024;
/** Sections per page (D25-09, D25-16). */
export const MAX_SECTIONS = 200;
/** Title characters (D25-09). */
export const MAX_TITLE_CHARS = 200;
/** Only text files are ingested; anything else posted is `not-text` (D25-14). */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdx", ".markdown", ".txt"]);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

export type IngestRefusalReason =
	| "no-source"
	| "outside-roots"
	| "not-text"
	| "secret"
	| "too-large"
	| "unknown-dataset"
	| "forbidden";

export type IngestFailedReason =
	| "ragflow-error"
	| "ragflow-timeout"
	| "ragflow-unreachable"
	| "ragflow-bad-response"
	| "manifest-error";

export interface IngestPageInput {
	dataset: string;
	sourceUrl: string;
	commit: string;
	content: string;
	title?: string;
	dryRun?: boolean;
	/** Already-attributed caller surface; the writer rule needs substrate/operator. */
	surface: string;
	isSubstrateOrOperator: boolean;
}

export interface IngestDeps {
	registry?: readonly DatasetEntry[];
	client: DocsRagflow;
	stateDir?: string;
	env?: Record<string, string | undefined>;
	embeddingModel?: string;
}

interface IngestOk {
	dataset: string;
	datasetId: string;
	path: string;
	commit: string;
	title: string;
	contentSha256: string;
	sections: number;
	redactions: number;
	imagesStripped: number;
}

export type IngestResult =
	| (IngestOk & { status: "uploaded"; documentIds: string[] })
	| (IngestOk & { status: "unchanged"; documentIds: string[] })
	| (IngestOk & { status: "dry_run"; wouldUpload: boolean })
	| { status: "refused"; reason: IngestRefusalReason; findings?: SkillRedactionHit[] }
	| { status: "failed"; reason: IngestFailedReason; message: string };

// --- Step 3: image stripping (D25-11) ---------------------------------------

const IMAGE_PLACEHOLDER = "image:";

function placeholderFor(alt: string): string {
	const trimmed = alt.trim();
	return trimmed ? `[${IMAGE_PLACEHOLDER} ${trimmed}]` : "";
}

function altOf(tag: string): string {
	const match = tag.match(/\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
	return (match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim();
}

/**
 * Scan for markdown inline images `![alt](dest)` with balanced brackets in
 * the alt text and balanced parens in the destination, so alts like
 * `outer [inner]` and destinations like `images/plot_(wide).png` strip as
 * one image. A newline before the brackets or parens close is not an image.
 *
 * Single forward pass: every character is scanned at most once. When a
 * candidate fails, its scanned extent is emitted literally and the scan
 * continues after it instead of rescanning from inside it, so a long line
 * of unclosed `![` cannot go quadratic. As a consequence, an `![` nested
 * inside a failed candidate on the same line is treated as literal text
 * rather than as a fresh candidate (a nested candidate after a newline
 * still strips, since the scan continues past the newline).
 */
function stripInlineImages(text: string): { text: string; imagesStripped: number } {
	let out = "";
	let stripped = 0;
	let cursor = 0;
	let i = 0;
	while (i < text.length) {
		if (text[i] !== "!" || text[i + 1] !== "[") {
			i += 1;
			continue;
		}
		const start = i;
		let depth = 1;
		let j = start + 2;
		while (depth > 0) {
			if (j >= text.length) break;
			const ch = text[j]!;
			if (ch === "\n") break;
			if (ch === "\\") {
				j += 2;
				continue;
			}
			if (ch === "[") depth += 1;
			else if (ch === "]") depth -= 1;
			j += 1;
		}
		if (depth !== 0) {
			// Unclosed alt (newline or end of input): literal through the
			// end of the scan; never rescan the inside for nested `![`.
			const end = Math.min(j, text.length);
			out += text.slice(cursor, end);
			cursor = end;
			i = end;
			continue;
		}
		if (text[j] !== "(") {
			// Balanced `![alt]` with no destination: literal through `]`.
			out += text.slice(cursor, j);
			cursor = j;
			i = j;
			continue;
		}
		const alt = text.slice(start + 2, j - 1);
		let parens = 1;
		let k = j + 1;
		while (parens > 0) {
			if (k >= text.length) break;
			const ch = text[k]!;
			if (ch === "\n") break;
			if (ch === "\\") {
				k += 2;
				continue;
			}
			if (ch === "(") parens += 1;
			else if (ch === ")") parens -= 1;
			k += 1;
		}
		if (parens !== 0) {
			// Unclosed destination: literal through the end of the scan.
			const end = Math.min(k, text.length);
			out += text.slice(cursor, end);
			cursor = end;
			i = end;
			continue;
		}
		stripped += 1;
		out += text.slice(cursor, start) + placeholderFor(alt);
		cursor = k;
		i = k;
	}
	return { text: out + text.slice(cursor), imagesStripped: stripped };
}

/**
 * Remove every image — markdown inline/reference, `<img>`,
 * `<picture>`/`<source>`, `data:` URIs — replacing each with
 * `[image: <alt>]` or nothing. Links are kept. Returns the stripped text and
 * the count for the reply and event.
 */
export function stripImages(text: string): { text: string; imagesStripped: number } {
	let out = text;
	let count = 0;
	// `<picture>` first: it wraps the `<img>`/`<source>` elements it owns, so
	// stripping the whole element counts one image with the inner alt text.
	out = out.replace(/<picture\b[\s\S]*?<\/picture\s*>/gi, (element) => {
		count += 1;
		return placeholderFor(altOf(element));
	});
	out = out.replace(/<(img|source)\b[\s\S]*?>/gi, (tag) => {
		count += 1;
		return tag.toLowerCase().startsWith("<img") ? placeholderFor(altOf(tag)) : "";
	});
	// Markdown inline images, including `data:` URIs: `![alt](dest)`. The
	// alt brackets and destination parens balance, so nested brackets and
	// parens in either strip as one image.
	const inline = stripInlineImages(out);
	out = inline.text;
	count += inline.imagesStripped;
	// Reference images drain their definitions below; a label shared with a
	// plain link keeps its definition (links are kept).
	const imageLabels = new Set<string>();
	const linkLabels = new Set<string>();
	// Every reference definition, collected once: each shortcut/full usage
	// below is a set lookup instead of a whole-document scan per reference.
	const definitions = new Set<string>();
	for (const match of out.matchAll(/^ {0,3}\[([^\]]+)\]:/gim)) {
		definitions.add(match[1]!.toLowerCase());
	}
	for (const match of out.matchAll(/!\[([^\]\n]*)\]\[([^\]\n]*)\]/g)) {
		count += 1;
		imageLabels.add((match[2] || match[1] || "").toLowerCase());
	}
	for (const match of out.matchAll(/(?<!!)\[([^\]\n]*)\]\[([^\]\n]*)\]/g)) {
		linkLabels.add((match[2] || match[1] || "").toLowerCase());
	}
	out = out.replace(/!\[([^\]\n]*)\]\[([^\]\n]*)\]/g, (_match, alt: string) => {
		return placeholderFor(alt);
	});
	// Shortcut reference `![alt]` is an image only where a definition exists.
	out = out.replace(/!\[([^\]\n]+)\](?!\[|\()/g, (match, alt: string) => {
		const label = alt.toLowerCase();
		if (!definitions.has(label)) return match;
		count += 1;
		imageLabels.add(label);
		return placeholderFor(alt);
	});
	for (const match of out.matchAll(/(?<!!)\[([^\]\n]+)\](?!\[|\()/g)) {
		// The label inside its own definition line is not a link usage.
		const at = match.index ?? 0;
		const lineStart = out.lastIndexOf("\n", at - 1) + 1;
		const lineEnd = out.indexOf("\n", at);
		const line = out.slice(lineStart, lineEnd === -1 ? out.length : lineEnd);
		if (/^ {0,3}\[[^\]]+\]:/.test(line)) continue;
		const text = match[1] ?? "";
		const label = text.toLowerCase();
		if (definitions.has(label)) linkLabels.add(label);
	}
	// Drop definition lines owned solely by stripped images.
	out = out
		.split("\n")
		.filter((line) => {
			const def = line.match(/^ {0,3}\[([^\]]+)\]:[ \t]*\S/);
			if (!def) return true;
			const label = def[1]!.toLowerCase();
			return !imageLabels.has(label) || linkLabels.has(label);
		})
		.join("\n");
	return { text: out, imagesStripped: count };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SplitPage {
	/** Explicit title, else the first H1, else the file name. */
	title: string;
	sections: PageSection[];
}

// --- Hash (D25-15) ----------------------------------------------------------

/**
 * SHA-256 over the final stripped/redacted text plus the normalised path and
 * the final checked title. The commit is excluded, so an unchanged page at a
 * new commit hashes the same and short-circuits the upload; the title is
 * included, so a title-only edit re-uploads instead of short-circuiting.
 */
export function hashPage(finalText: string, normalisedPath: string, title = ""): string {
	return createHash("sha256")
		.update(finalText, "utf8")
		.update("\0path:", "utf8")
		.update(normalisedPath, "utf8")
		.update("\0title:", "utf8")
		.update(title, "utf8")
		.digest("hex");
}

// --- Split (D25-16) ----------------------------------------------------------

export interface PageSection {
	index: number;
	headingPath: string[];
	anchor: string | null;
	sourceUrl: string;
	/** Breadcrumb line, blank line, then the section body. */
	text: string;
}

function slugify(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/[^\p{L}\p{N} _-]/gu, "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
}

const ATX_PATTERN = /^(#{1,3})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE_PATTERN = /^(`{3,}|~{3,})/;

/**
 * Split a page at H1–H3 headings (fence-aware: `#` lines inside fenced code
 * blocks never split). The preamble before the first heading is section 0.
 * Every section text starts with its heading breadcrumb so retrieval can
 * match on headings.
 */
export function splitSections(options: {
	text: string;
	path: string;
	sourceUrl: string;
	commit: string;
	title?: string;
	contentSha256: string;
}): SplitPage {
	const lines = options.text.split("\n");
	interface Block {
		headingPath: string[];
		body: string[];
	}
	const blocks: Block[] = [{ headingPath: [], body: [] }];
	const stack: string[] = [];
	let firstH1: string | undefined;
	let inFence: string | null = null;
	for (const line of lines) {
		const fence = line.match(FENCE_PATTERN);
		if (fence) {
			const marker = fence[1]![0]!;
			if (inFence === null) inFence = marker;
			else if (inFence === marker) inFence = null;
			blocks[blocks.length - 1]!.body.push(line);
			continue;
		}
		const heading = inFence === null ? line.match(ATX_PATTERN) : null;
		if (heading && heading[2]!.trim()) {
			const level = heading[1]!.length;
			const text = heading[2]!.trim();
			if (level === 1 && firstH1 === undefined) firstH1 = text;
			stack.length = Math.min(stack.length, level - 1);
			stack[level - 1] = text;
			blocks.push({ headingPath: stack.slice(0, level), body: [line] });
		} else {
			blocks[blocks.length - 1]!.body.push(line);
		}
	}
	const title = options.title?.trim() || firstH1 || basename(options.path);
	// GitHub-style unique anchors: the second `## Install` on a page links
	// to `#install-1`, the third to `#install-2`. Counts run across the
	// whole page so stored `sourceUrl` fragments never collide.
	const seen = new Map<string, number>();
	const sections = blocks.map((block, index) => {
		const crumb = block.headingPath.length > 0 ? block.headingPath.join(" / ") : title;
		let anchor: string | null = null;
		if (block.headingPath.length > 0) {
			const baseAnchor = slugify(block.headingPath[block.headingPath.length - 1]!);
			const used = seen.get(baseAnchor) ?? 0;
			seen.set(baseAnchor, used + 1);
			anchor = used === 0 ? baseAnchor : `${baseAnchor}-${used}`;
		}
		return {
			index,
			headingPath: block.headingPath,
			anchor,
			sourceUrl: anchor ? `${options.sourceUrl}#${anchor}` : options.sourceUrl,
			text: `${crumb}\n\n${block.body.join("\n")}`,
		};
	});
	return { title, sections };
}

// --- Step 2: shape, roots, caps (D25-08, D25-09) ------------------------------

function globToRegExp(pattern: string): RegExp {
	let out = "^";
	let i = 0;
	while (i < pattern.length) {
		if (pattern.startsWith("**/", i)) {
			out += "(.*/)?";
			i += 3;
		} else if (pattern[i] === "*") {
			out += pattern[i + 1] === "*" ? ".*" : "[^/]*";
			i += pattern[i + 1] === "*" ? 2 : 1;
		} else if (pattern[i] === "?") {
			out += "[^/]";
			i += 1;
		} else {
			out += escapeRegExp(pattern[i]!);
			i += 1;
		}
	}
	return new RegExp(`${out}$`);
}

function matchesAny(patterns: readonly string[], path: string): boolean {
	return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/** C0 controls and DEL never appear in a decoded repo path. */
function hasControlChar(piece: string): boolean {
	for (const ch of piece) {
		const code = ch.codePointAt(0) ?? 0;
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

/** Normalise a repo-relative path; `..`, `.`, empty segments, backslashes,
 * percent-encoded slashes, malformed encodings, and decoded `/`, `\`,
 * control characters, or empty/`.`/`..` segments are refused (D25-08).
 * Matching runs against the decoded path; callers rebuild the canonical
 * URL with per-segment `encodeURIComponent`. */
export function normalisePath(raw: string): { ok: true; path: string } | { ok: false } {
	if (!raw || raw.includes("\\") || /%2f|%5c/i.test(raw)) return { ok: false };
	const decoded: string[] = [];
	for (const segment of raw.split("/")) {
		let piece: string;
		try {
			piece = decodeURIComponent(segment);
		} catch {
			return { ok: false };
		}
		// Decode-then-compare so `%2e%2e` counts as `..`.
		if (piece === "" || piece === "." || piece === "..") return { ok: false };
		if (piece.includes("/") || piece.includes("\\") || hasControlChar(piece)) return { ok: false };
		decoded.push(piece);
	}
	return { ok: true, path: decoded.join("/") };
}

function extensionOf(path: string): string {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

function hasBadEncoding(content: string): boolean {
	if (content.includes("\0")) return true;
	// Lone surrogates cannot come from valid UTF-8.
	return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content);
}

interface CheckedPage {
	path: string;
	title: string;
	/** Canonical blob URL rebuilt from the checked parts (D25-08). */
	sourceUrl: string;
}

function checkShape(input: IngestPageInput, entry: DatasetEntry): CheckedPage | IngestRefusalReason {
	if (!input.sourceUrl) return "no-source";
	if (!COMMIT_PATTERN.test(input.commit)) return "outside-roots";
	let url: URL;
	try {
		url = new URL(input.sourceUrl);
	} catch {
		return "outside-roots";
	}
	if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return "outside-roots";
	// Only canonical blob URLs reach the pipeline: credentials, query
	// strings, and fragments are refused, and the stored URL below is
	// rebuilt from the checked parts so nothing carried survives.
	if (url.username || url.password || url.search || url.hash) return "outside-roots";
	if (/%2f|%5c/i.test(url.pathname)) return "outside-roots";
	const segments = url.pathname.split("/");
	if (segments.length < 6 || !segments[1] || !segments[2] || segments[3] !== "blob") {
		return "outside-roots";
	}
	const slug = `${segments[1]}/${segments[2]}`;
	if (slug.toLowerCase() !== entry.slug.toLowerCase()) return "outside-roots";
	if (segments[4] !== input.commit) return "outside-roots";
	const normalised = normalisePath(segments.slice(5).join("/"));
	if (!normalised.ok) return "outside-roots";
	if (!matchesAny(entry.include, normalised.path) || matchesAny(entry.exclude, normalised.path)) {
		return "outside-roots";
	}
	if (!TEXT_EXTENSIONS.has(extensionOf(normalised.path))) return "not-text";
	if (hasBadEncoding(input.content)) return "not-text";
	if (input.title !== undefined && [...input.title].length > MAX_TITLE_CHARS) return "too-large";
	return {
		path: normalised.path,
		title: input.title?.trim() || "",
		// Re-encode per segment so a decoded `#`, `?`, or space cannot
		// break the stored URL back into a fragment, query, or bare space.
		sourceUrl: `https://github.com/${entry.slug}/blob/${input.commit}/${normalised.path
			.split("/")
			.map((segment) => encodeURIComponent(segment))
			.join("/")}`,
	};
}

function failedFrom(error: unknown): IngestResult {
	if (error instanceof RagflowError) {
		const message = error.message;
		if (message.startsWith("ragflow timeout")) return { status: "failed", reason: "ragflow-timeout", message };
		if (message.startsWith("ragflow unreachable")) return { status: "failed", reason: "ragflow-unreachable", message };
		if (/non-JSON|no chunks|no datasets|no documents|cross-origin|redirected/.test(message)) {
			return { status: "failed", reason: "ragflow-bad-response", message };
		}
		return { status: "failed", reason: "ragflow-error", message };
	}
	return { status: "failed", reason: "manifest-error", message: String(error) };
}

/**
 * Resolve a registry name to its RAGFlow id, creating the dataset on first
 * ingest when the list has no row for it (D25-14). Search never calls this.
 */
export async function resolveIngestDatasetId(
	registry: readonly DatasetEntry[],
	client: DocsRagflow,
	name: string,
	embeddingModel?: string,
): Promise<string> {
	const resolved = await resolveDatasetId(registry, name, () => client.listDatasets());
	if (resolved.ok) return resolved.datasetId;
	return client.ensureDataset(name, embeddingModel ? { embeddingModel } : {});
}
/**
 * Whether RAGFlow rejected the dataset id itself (deleted out of band),
 * as opposed to a document or parse failure. Only this shape drops the
 * cached id and retries: anything else fails the run without touching it.
 */
export function isStaleDatasetId(error: unknown): boolean {
	if (!(error instanceof RagflowError)) return false;
	return /ragflow 404|no such dataset|dataset (not found|unknown|missing)|unknown dataset/i.test(error.message);
}

// --- Step 5: the pipeline -----------------------------------------------------

/** Parse-run states that never recover without a fresh upload (D25-15). */
const FAILED_RUNS: Record<string, true> = {
	FAIL: true,
	CANCEL: true,
	// Numeric forms of the same states (see the ragflow RESEARCH note).
	"2": true,
	"4": true,
};

/**
 * Ids of a prior upload that must be replaced before the unchanged
 * fast-path may fire, or null when the prior upload is intact. A document
 * is stale when RAGFlow no longer lists it or its parse run failed or was
 * cancelled; in-flight runs (UNSTART/RUNNING) still short-circuit.
 */
async function staleDocumentIds(
	client: DocsRagflow,
	datasetId: string,
	documentIds: string[],
): Promise<string[] | null> {
	const wanted = new Set(documentIds);
	const seen = new Set<string>();
	const stale: string[] = [];
	let page = 1;
	for (;;) {
		const rows = await client.listDocuments(datasetId, page, 100);
		if (rows.length === 0) break;
		for (const row of rows) {
			if (!wanted.has(row.id)) continue;
			seen.add(row.id);
			if (FAILED_RUNS[row.run]) stale.push(row.id);
		}
		if (rows.length < 100 || seen.size === wanted.size) break;
		page += 1;
	}
	// Only listed documents are deleted; ids RAGFlow no longer knows need
	// no delete — the fresh upload below replaces them.
	const missing = [...wanted].some((id) => !seen.has(id));
	if (stale.length === 0 && !missing) return null;
	return stale;
}

function sectionMeta(
	section: PageSection,
	input: { path: string; commit: string; title: string; contentSha256: string },
): SectionDocMeta {
	return {
		sourceUrl: section.sourceUrl,
		headingPath: section.headingPath,
		commit: input.commit,
		title: input.title,
		path: input.path,
		contentSha256: input.contentSha256,
		sectionIndex: section.index,
	};
}

/**
 * Run the fixed pipeline. Refusals (steps 1–4) never touch RAGFlow or the
 * manifest; `dry_run` additionally performs no upload, parse, or write.
 */
export async function ingestPage(input: IngestPageInput, deps: IngestDeps): Promise<IngestResult> {
	if (!input.isSubstrateOrOperator) return { status: "refused", reason: "forbidden" };
	const registry = deps.registry ?? loadRegistry();
	const entry = findDataset(registry, input.dataset);
	if (!entry) return { status: "refused", reason: "unknown-dataset" };
	const checked = checkShape(input, entry);
	if (typeof checked === "string") return { status: "refused", reason: checked };
	// The normalised path reaches upload names, source_url, and the
	// basename-title fallback below, so a secret in the file name refuses
	// here before any of them (same line+rule findings shape as content).
	const pathRedacted = redactSkillContent(checked.path);
	if (pathRedacted.findings.length > 0) {
		const findings: SkillRedactionHit[] = pathRedacted.findings.map((hit) => ({
			line: hit.line,
			rule: hit.rule,
		}));
		return { status: "refused", reason: "secret", findings };
	}

	const stripped = stripImages(input.content);
	if (Buffer.byteLength(stripped.text, "utf8") > MAX_CONTENT_BYTES) {
		return { status: "refused", reason: "too-large" };
	}
	const redacted = redactSkillContent(stripped.text);
	if (redacted.findings.length > 0) {
		// Findings name line + rule only — never a value (T-25-04).
		const findings: SkillRedactionHit[] = redacted.findings.map((hit) => ({
			line: hit.line,
			rule: hit.rule,
		}));
		return { status: "refused", reason: "secret", findings };
	}
	// Explicit titles bypass the content pass, so image markup is stripped
	// and publication checks run before the title is split into section
	// text or stored in meta_fields. Findings refuse; quiet redactions
	// apply in place; stripped images count with the page.
	let finalTitle = checked.title;
	let titleRedactions = 0;
	let titleImages = 0;
	if (finalTitle) {
		const titleStripped = stripImages(finalTitle);
		titleImages = titleStripped.imagesStripped;
		finalTitle = titleStripped.text.trim();
	}
	if (finalTitle) {
		const titleRedacted = redactSkillContent(finalTitle);
		if (titleRedacted.findings.length > 0) {
			// Findings name line + rule only — never a value (T-25-04).
			const findings: SkillRedactionHit[] = titleRedacted.findings.map((hit) => ({
				line: hit.line,
				rule: hit.rule,
			}));
			return { status: "refused", reason: "secret", findings };
		}
		finalTitle = titleRedacted.text.trim();
		titleRedactions = titleRedacted.redactions.length;
	}
	const contentSha256 = hashPage(redacted.text, checked.path, finalTitle);
	const split = splitSections({
		text: redacted.text,
		path: checked.path,
		sourceUrl: checked.sourceUrl,
		commit: input.commit,
		title: finalTitle || undefined,
		contentSha256,
	});
	// The shape cap covers only explicit titles; H1-derived and file-name
	// titles are capped here instead.
	if ([...split.title].length > MAX_TITLE_CHARS) return { status: "refused", reason: "too-large" };
	if (split.sections.length > MAX_SECTIONS) return { status: "refused", reason: "too-large" };
	const base: IngestOk = {
		dataset: input.dataset,
		datasetId: "",
		path: checked.path,
		commit: input.commit,
		title: split.title,
		contentSha256,
		sections: split.sections.length,
		redactions: redacted.redactions.length + titleRedactions,
		imagesStripped: stripped.imagesStripped + titleImages,
	};
	const sections = split.sections;
	if (input.dryRun) {
		return { ...base, status: "dry_run", wouldUpload: true };
	}

	const locked = async (): Promise<IngestResult> => {
			const datasetId = await resolveIngestDatasetId(registry, deps.client, input.dataset, deps.embeddingModel);
			const manifest = await loadManifest(input.dataset, {
				stateDir: deps.stateDir,
				env: deps.env,
				client: deps.client,
				datasetId,
			});
			const existing = manifest.paths[checked.path];
			if (existing && existing.hash === contentSha256) {
				// A manifest entry is saved right after the parse is queued,
				// so a FAIL/CANCEL run (or a document deleted out of band)
				// would short-circuit forever. Replace stale documents and
				// fall through to a fresh upload instead.
				const stale = await staleDocumentIds(deps.client, datasetId, existing.documentIds);
				if (stale === null) {
					return { ...base, datasetId, status: "unchanged", documentIds: [...existing.documentIds] };
				}
				if (stale.length > 0) await deps.client.deleteDocuments(datasetId, stale);
			}
			const uploaded = await deps.client.uploadDocuments(
				datasetId,
				sections.map((section) => ({
					filename: `${checked.path.replaceAll("/", "__")}#${section.index}.md`,
					content: section.text,
					contentType: "text/markdown",
				})),
			);
			if (uploaded.length !== sections.length) {
				return {
					status: "failed",
					reason: "ragflow-error",
					message: `ragflow error: upload returned ${uploaded.length} of ${sections.length} documents`,
				};
			}
			const documentIds = uploaded.map((row) => row.documentId);
			for (let index = 0; index < sections.length; index += 1) {
				const section = sections[index]!;
				// RAGFlow meta_fields are snake_case: rebuildManifest and the
				// search fallback read exactly these keys (D25-15, D25-16).
				await deps.client.updateDocument(datasetId, documentIds[index]!, {
					name: `${checked.path} #s${section.index} ${contentSha256.slice(0, 12)}`,
					metaFields: {
						source_url: section.sourceUrl,
						heading_path: section.headingPath,
						commit: input.commit,
						title: base.title,
						path: checked.path,
						content_sha256: contentSha256,
						section_index: section.index,
					},
				});
			}
			await deps.client.parseDocuments(datasetId, documentIds);
			const next: DocsManifest = {
				...manifest,
				paths: {
					...manifest.paths,
					[checked.path]: {
						hash: contentSha256,
						documentIds,
						meta: sections.map((section) => sectionMeta(section, base)),
						updatedCommit: input.commit,
					},
				},
			};
			await saveManifest(input.dataset, next, { stateDir: deps.stateDir, env: deps.env });
			return { ...base, datasetId, status: "uploaded", documentIds };
	};
	try {
		return await withDatasetLock(input.dataset, locked);
	} catch (error) {
		// A cached id for a dataset deleted out of band is rejected by
		// RAGFlow: drop it and resolve again (the list misses, so
		// ensureDataset recreates) exactly once. Anything else fails now.
		if (!isStaleDatasetId(error)) return failedFrom(error);
		dropDatasetId(input.dataset);
		try {
			return await withDatasetLock(input.dataset, locked);
		} catch (retryError) {
			return failedFrom(retryError);
		}
	}
}
