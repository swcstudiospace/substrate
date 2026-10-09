/**
 * `substrate docs ingest`, `substrate docs refresh`, and the refresh tick (Phase 25, DOCS-02/03).
 *
 *   substrate docs ingest --dataset <name> --file <path> --source-url <url> --commit <sha> [--title <t>] [--dry-run]
 *   substrate docs refresh --dataset <name> --commit <sha> [--repo <path>] [--slug <owner/repo>]
 *
 * Both commands are HTTP clients of `POST /docs/ingest` (D25-12, D25-19): they
 * never talk to RAGFlow directly, never redact locally (the server is the only
 * redaction point — this file must not import `redact.ts`), and never post
 * events (the server records them). They are not hook commands: refusals and
 * failures exit 1.
 *
 * Refresh reads committed objects only (`git ls-tree` / `git show`; D25-19, T-25-13):
 * a dirty file in a working tree can never be ingested. After posting every
 * matching text page it polls via `finalize` (bounded ~10 min) before the
 * version is cut (D25-20): a failed or timed-out parse fails the run without
 * cutting. A refused page warns but does not abort; the version is still cut
 * with that page absent. A run that ingested nothing never calls `finalize`
 * and exits 1.
 *
 * The tick (`import.meta.main`, run by `substrate-docs-refresh.service`) fetches
 * each watched repo's `main` into a bare mirror under `SUBSTRATE_DOCS_STATE`
 * and refreshes on commit drift; `agent-skills` is caught up read-only from
 * `/root/agent-skills` (D25-18, D25-21). Enabling the timer is a live step.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findDataset, loadRegistry } from "../../mcp-server/src/docs/registry.ts";
import { parseArgs, str, type Args } from "./args.ts";

/**
 * The page-content cap, pinned equal to the server's own cap: a file bigger
 * than this is refused before it is posted. `docs-refresh.test.ts` asserts
 * the equality against `packages/mcp-server/src/docs/ingest.ts`.
 */
export const DOCS_MAX_CONTENT_BYTES = 256 * 1024;

/** Only text files are posted; anything else is a counted skip (D25-14). */
export const DOCS_TEXT_EXTENSIONS: Record<string, true> = { ".md": true, ".mdx": true, ".markdown": true, ".txt": true };

/**
 * Separate from the 1.5 s hook default on purpose (D25-12): an ingest posts a
 * page through upload plus a parse request, and a refresh waits out parses.
 */
export const DOCS_DEFAULT_TIMEOUT_MS = 120_000;

/** Bounded parse wait per refresh run before finalize gives up (D25-20). */
export const DOCS_PARSE_DEADLINE_MS = 600_000;
/** Pause between finalize polls while parses are still queued. */
export const DOCS_POLL_INTERVAL_MS = 10_000;

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export const USAGE_DOCS_INGEST =
	"substrate docs ingest --dataset <name> --file <path> --source-url <url> --commit <sha> [--title <t>] [--dry-run]\n";
export const USAGE_DOCS_REFRESH =
	"substrate docs refresh --dataset <name> --commit <sha> [--repo <path>] [--slug <owner/repo>]\n";
export const USAGE_DOCS = USAGE_DOCS_INGEST + USAGE_DOCS_REFRESH;

/** Overridable with `SUBSTRATE_DOCS_TIMEOUT_MS`; anything that is not a positive number is the default. */
export function docsTimeout(raw: string | undefined): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DOCS_DEFAULT_TIMEOUT_MS;
}

/** Overridable parse-wait bound (`SUBSTRATE_DOCS_PARSE_TIMEOUT_MS`); positive numbers only. */
export function parseDeadlineMs(raw: string | undefined): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DOCS_PARSE_DEADLINE_MS;
}

/** Overridable finalize poll interval (`SUBSTRATE_DOCS_POLL_MS`); positive numbers only. */
export function pollIntervalMs(raw: string | undefined): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DOCS_POLL_INTERVAL_MS;
}

export interface DocsDeps {
	url: string;
	token: string | undefined;
	timeoutMs: number;
	cwd: string;
	out: (text: string) => void;
	err: (text: string) => void;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	env?: Record<string, string | undefined>;
}

function defaultSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

export async function runDocs(argv: string[], deps: DocsDeps): Promise<number> {
	const sub = argv[0];
	if (sub === "ingest") return runDocsIngest(argv.slice(1), deps);
	if (sub === "refresh") return runDocsRefresh(argv.slice(1), deps);
	if (sub === "--help" || sub === "-h" || sub === undefined) {
		deps.out(USAGE_DOCS);
		return 0;
	}
	deps.err(USAGE_DOCS);
	return 2;
}

/** Fatal UTF-8 decoder: invalid bytes throw instead of becoming U+FFFD. */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode bytes that must be UTF-8 text. Invalid bytes are an error, never
 * silent U+FFFD replacement (review: invalid text gets replaced).
 */
function decodeUtf8Bytes(bytes: Uint8Array): { content: string } | { error: string } {
	try {
		return { content: utf8Decoder.decode(bytes) };
	} catch {
		return { error: "not valid UTF-8" };
	}
}

/**
 * Encode one repo-relative path into a `source_url` suffix: every segment is
 * `encodeURIComponent`-escaped, so spaces, `#`, `?` (and a literal `%`) never
 * become URL delimiters or vanish in URL parsing (review: file names lose pages).
 */
export function encodePathSegments(path: string): string {
	return path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

/**
 * The inverse of `encodePathSegments`: decode back to the same repo-relative
 * path, refusing anything malformed, empty, or able to escape (`.`, `..`,
 * slashes, backslashes, NUL) instead of guessing.
 */
export function decodePathSegments(encoded: string): { ok: true; path: string } | { ok: false } {
	const parts: string[] = [];
	for (const segment of encoded.split("/")) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			return { ok: false };
		}
		if (decoded === "" || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
			return { ok: false };
		}
		parts.push(decoded);
	}
	return { ok: true, path: parts.join("/") };
}

/** Canonical page URL for a repo-relative path (segments encoded). */
export function docsSourceUrl(slug: string, commit: string, path: string): string {
	return `https://github.com/${slug}/blob/${commit}/${encodePathSegments(path)}`;
}

/**
 * Client mirror of the server's `globToRegExp` in
 * `packages/mcp-server/src/docs/ingest.ts`: a double-star prefix crosses
 * directories, `*` stays inside one segment, `?` is one non-slash character.
 * A pre-post filter only — the server re-checks every post, so a file
 * wrongly let through is still refused there; this copy must stay identical
 * to the server's.
 */
function docsGlobToRegExp(pattern: string): RegExp {
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
			const char = pattern[i] ?? "";
			out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			i += 1;
		}
	}
	return new RegExp(`${out}$`);
}

/** Client mirror of the server's `matchesAny` (same file): any glob matches. */
function matchesDocsGlobs(patterns: readonly string[], path: string): boolean {
	return patterns.some((pattern) => docsGlobToRegExp(pattern).test(path));
}

// ── ingest (D25-12) ──────────────────────────────────────────────────────────

const INGEST_FLAGS: Record<string, true> = { dataset: true, file: true, "source-url": true, commit: true, title: true, "dry-run": true, help: true };
const INGEST_WITH_VALUE = ["dataset", "file", "source-url", "commit", "title"];

interface Finding {
	line: number;
	rule: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asFindings(value: unknown): Finding[] {
	if (!Array.isArray(value)) return [];
	const out: Finding[] = [];
	for (const item of value) {
		const record = asRecord(item);
		if (record && typeof record.line === "number" && typeof record.rule === "string") {
			out.push({ line: record.line, rule: record.rule });
		}
	}
	return out;
}

export async function runDocsIngest(argv: string[], deps: DocsDeps): Promise<number> {
	const field = (key: string, value: string | number | undefined) => {
		if (value !== undefined) deps.out(`${key}=${value}\n`);
	};
	const refused = (message: string): number => {
		field("status", "refused");
		deps.err(`[substrate] docs ingest refused: ${message}\n`);
		return 1;
	};
	const failed = (message: string): number => {
		field("status", "failed");
		deps.err(`[substrate] docs ingest failed: ${message}\n`);
		return 1;
	};

	if (argv.includes("--help") || argv.includes("-h")) {
		deps.out(USAGE_DOCS_INGEST);
		return 0;
	}
	const args = parseArgs(argv);
	const unknown = Object.keys(args).find((key) => !INGEST_FLAGS[key]);
	if (unknown !== undefined) return refused(`unknown flag --${unknown}`);
	const missing = INGEST_WITH_VALUE.find((key) => args[key] === true);
	if (missing !== undefined) return refused(`--${missing} takes a value`);
	const dataset = str(args.dataset);
	const fileArg = str(args.file);
	const sourceUrl = str(args["source-url"]);
	const commit = str(args.commit);
	if (!dataset) return refused("--dataset <name> is required");
	if (!fileArg) return refused("--file <path> is required");
	if (!sourceUrl) return refused("--source-url <url> is required");
	if (!commit) return refused("--commit <sha> is required");
	if (!COMMIT_PATTERN.test(commit)) return refused("--commit must be a 40-hex sha");
	if (!deps.token) {
		return refused("SUBSTRATE_TOKEN is not set; docs ingest needs an authenticated surface, and nothing was posted");
	}

	const file = resolve(deps.cwd, fileArg);
	let raw: Buffer;
	try {
		raw = readFileSync(file);
	} catch (cause) {
		return refused(`cannot read ${fileArg}: ${(cause as Error).message}`);
	}
	// Fatal decode: invalid bytes refuse here instead of reaching the server
	// as U+FFFD, which `hasBadEncoding` could no longer recognise.
	const decodedFile = decodeUtf8Bytes(raw);
	if ("error" in decodedFile) {
		return refused(`${fileArg} is not valid UTF-8; nothing was posted`);
	}
	const content = decodedFile.content;
	// The 256 KiB pre-check happens before posting (D25-12). The server
	// measures after image stripping, so this client-side check is
	// conservative on image-heavy pages — and never a redaction.
	const size = raw.length;
	if (size > DOCS_MAX_CONTENT_BYTES) {
		return refused(`the file is ${size} bytes, over the 256 KiB page cap; nothing was posted`);
	}

	const body = {
		dataset,
		source_url: sourceUrl,
		commit,
		content,
		...(str(args.title) !== undefined ? { title: str(args.title) } : {}),
		...(args["dry-run"] !== undefined ? { dry_run: true } : {}),
		session_id: `docs-ingest:${dataset}:${commit.slice(0, 12)}`,
	};
	let response: Response;
	try {
		response = await (deps.fetch ?? fetch)(`${deps.url}/docs/ingest`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(deps.timeoutMs),
		});
	} catch (cause) {
		return failed(`the substrate at ${deps.url} did not answer: ${(cause as Error).message}`);
	}

	const text = await response.text().catch(() => "");
	let parsed: unknown = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = null;
	}
	if (response.status === 200) {
		const result = asRecord(parsed);
		const status = result?.status;
		if (status !== "uploaded" && status !== "unchanged" && status !== "dry_run") {
			return failed("the substrate answered 200 without an ingest result");
		}
		field("status", status);
		if (typeof result?.datasetId === "string") field("dataset_id", result.datasetId);
		if (typeof result?.contentSha256 === "string") field("content_sha256", result.contentSha256);
		if (typeof result?.sections === "number") field("sections", result.sections);
		if (typeof result?.redactions === "number") field("redactions", result.redactions);
		if (typeof result?.imagesStripped === "number") field("images_stripped", result.imagesStripped);
		if (Array.isArray(result?.documentIds)) {
			const ids: unknown[] = result.documentIds;
			field(
				"document_ids",
				ids.filter((id): id is string => typeof id === "string").join(","),
			);
		}
		if (typeof result?.wouldUpload === "boolean") field("would_upload", String(result.wouldUpload));
		for (const finding of asFindings(result?.findings)) field("finding", `${finding.line} ${finding.rule}`);
		return 0;
	}
	const errorBody = asRecord(parsed);
	if (response.status >= 400 && response.status < 500) {
		const reason = typeof errorBody?.reason === "string" ? errorBody.reason : undefined;
		const message = `${response.status}: ${reason ?? errorBody?.error ?? (text.slice(0, 200) || "no message")}`;
		field("status", "refused");
		if (reason !== undefined) field("reason", reason);
		for (const finding of asFindings(errorBody?.findings)) field("finding", `${finding.line} ${finding.rule}`);
		deps.err(`[substrate] docs ingest refused: ${message}\n`);
		return 1;
	}
	const message = `${response.status}: ${typeof errorBody?.message === "string" ? errorBody.message : text.slice(0, 200) || "no message"}`;
	return failed(message);
}

// ── refresh (D25-19/D25-20) ──────────────────────────────────────────────────

const REFRESH_FLAGS: Record<string, true> = { dataset: true, commit: true, repo: true, slug: true, help: true };

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function git(args: string[], cwd: string): GitResult {
	try {
		const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		if (result.error) return { ok: false, stdout: "", stderr: String((result.error as Error).message) };
		return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	} catch (cause) {
		return { ok: false, stdout: "", stderr: String((cause as Error).message) };
	}
}

function extensionOf(path: string): string {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

/** Committed blobs at a commit — never the working tree, never the index. */
function lsTreeBlobs(repoDir: string, commit: string): { paths: string[] } | { error: string } {
	const listed = git(["-C", repoDir, "ls-tree", "-r", "-z", commit], repoDir);
	if (!listed.ok) return { error: `cannot list ${commit}: ${listed.stderr.trim().slice(0, 200)}` };
	const paths: string[] = [];
	for (const entry of listed.stdout.split("\0")) {
		if (!entry) continue;
		const tab = entry.indexOf("\t");
		if (tab === -1) continue;
		const meta = entry.slice(0, tab).split(" ");
		if (meta[1] !== "blob") continue;
		const path = entry.slice(tab + 1);
		if (path) paths.push(path);
	}
	return { paths };
}

function showAt(repoDir: string, commit: string, path: string): { bytes: Buffer } | { error: string } {
	// Bytes out of git, never replacement-decoded text: the caller
	// fatal-decodes, so invalid UTF-8 stays detectable instead of laundering
	// into U+FFFD before the server's `hasBadEncoding` can refuse it.
	let result: SpawnSyncReturns<Buffer>;
	try {
		result = spawnSync("git", ["-C", repoDir, "show", `${commit}:${path}`], { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 });
	} catch (cause) {
		return { error: String((cause as Error).message).slice(0, 200) };
	}
	if (result.error) return { error: String(result.error.message).slice(0, 200) };
	if (result.status !== 0) return { error: result.stderr.toString("utf8").trim().slice(0, 200) };
	return { bytes: result.stdout };
}

/** owner/name from the origin remote; `--slug` wins when the remote is absent. */
function originSlug(repoDir: string): string | undefined {
	const remote = git(["-C", repoDir, "remote", "get-url", "origin"], repoDir);
	if (!remote.ok) return undefined;
	const match = remote.stdout.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
	return match?.[1];
}

interface RefreshCounts {
	listed: number;
	uploaded: number;
	unchanged: number;
	skipped: number;
	refused: number;
	documents: number;
}

export async function runDocsRefresh(argv: string[], deps: DocsDeps): Promise<number> {
	const env = deps.env ?? process.env;
	const counts: RefreshCounts = { listed: 0, uploaded: 0, unchanged: 0, skipped: 0, refused: 0, documents: 0 };
	const totals = (status: string, dataset: string | undefined, commit: string | undefined) => {
		if (dataset !== undefined) deps.out(`status=${status}\n`);
		if (dataset !== undefined) deps.out(`dataset=${dataset}\n`);
		if (commit !== undefined) deps.out(`commit=${commit}\n`);
		deps.out(`listed=${counts.listed}\n`);
		deps.out(`uploaded=${counts.uploaded}\n`);
		deps.out(`unchanged=${counts.unchanged}\n`);
		deps.out(`skipped=${counts.skipped}\n`);
		deps.out(`refused=${counts.refused}\n`);
		deps.out(`documents=${counts.documents}\n`);
	};
	const failed = (message: string, dataset?: string, commit?: string): number => {
		totals("failed", dataset, commit);
		deps.err(`[substrate] docs refresh failed: ${message}\n`);
		return 1;
	};

	if (argv.includes("--help") || argv.includes("-h")) {
		deps.out(USAGE_DOCS_REFRESH);
		return 0;
	}
	const args = parseArgs(argv);
	const unknown = Object.keys(args).find((key) => !REFRESH_FLAGS[key]);
	if (unknown !== undefined) return failed(`unknown flag --${unknown}`);
	for (const key of ["dataset", "commit", "repo", "slug"]) {
		if (args[key] === true) return failed(`--${key} takes a value`);
	}
	const dataset = str(args.dataset);
	const commit = str(args.commit);
	if (!dataset) return failed("--dataset <name> is required");
	if (!commit) return failed("--commit <sha> is required");
	if (!COMMIT_PATTERN.test(commit)) return failed("--commit must be a 40-hex sha");
	if (!deps.token) {
		return failed("SUBSTRATE_TOKEN is not set; docs refresh needs an authenticated surface, and nothing was posted", dataset, commit);
	}

	const repoArg = str(args.repo);
	const repoDir =
		repoArg !== undefined
			? resolve(deps.cwd, repoArg)
			: dataset === "agent-skills"
				? (env.SUBSTRATE_AGENT_SKILLS_PATH?.trim() || "/root/agent-skills")
				: undefined;
	if (repoDir === undefined) {
		return failed("--repo <path> is required for this dataset (a bare mirror for merge datasets)", dataset, commit);
	}
	const gitDir = git(["-C", repoDir, "rev-parse", "--git-dir"], repoDir);
	if (!gitDir.ok) return failed(`${repoDir} is not a git repository; nothing was posted`, dataset, commit);
	const slug = str(args.slug) ?? originSlug(repoDir);
	if (slug === undefined || !SLUG_PATTERN.test(slug)) {
		return failed("--slug <owner/repo> is required when the repo has no origin remote", dataset, commit);
	}

	const listed = lsTreeBlobs(repoDir, commit);
	if ("error" in listed) return failed(listed.error, dataset, commit);
	counts.listed = listed.paths.length;
	const sessionId = `docs-refresh:${dataset}:${commit.slice(0, 12)}`;
	const headers = { "content-type": "application/json", authorization: `Bearer ${deps.token}` };
	const post = async (payload: unknown): Promise<Response> =>
		(deps.fetch ?? fetch)(`${deps.url}/docs/ingest`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(deps.timeoutMs),
		});

	const ingestedPaths: string[] = [];
	// Registry roots are a pre-post filter only, and only for datasets the
	// registry knows: unknown datasets keep today's behaviour and the server
	// stays the final arbiter (any 400 still refuses the post).
	const entry = findDataset(loadRegistry(env), dataset);
	for (const path of listed.paths) {
		if (!DOCS_TEXT_EXTENSIONS[extensionOf(path)]) {
			counts.skipped += 1;
			continue;
		}
		if (entry !== undefined && (!matchesDocsGlobs(entry.include, path) || matchesDocsGlobs(entry.exclude, path))) {
			counts.skipped += 1;
			continue;
		}
		const shown = showAt(repoDir, commit, path);
		if ("error" in shown) {
			counts.skipped += 1;
			deps.err(`[substrate] docs refresh skipped ${path}: ${shown.error}\n`);
			continue;
		}
		const decoded = decodeUtf8Bytes(shown.bytes);
		if ("error" in decoded) {
			counts.skipped += 1;
			deps.err(`[substrate] docs refresh skipped ${path}: not valid UTF-8; nothing was posted\n`);
			continue;
		}
		// The ingest-side cap, checked before posting (the same conservative
		// pre-check `runDocsIngest` does): a page this big would be refused
		// as too-large — or bounce off the route body cap as a 413 — so it
		// is a refused page without a wasted post.
		if (shown.bytes.length > DOCS_MAX_CONTENT_BYTES) {
			counts.refused += 1;
			deps.err(`[substrate] docs refresh skipped ${path}: the file is ${shown.bytes.length} bytes, over the 256 KiB page cap; nothing was posted\n`);
			continue;
		}
		let response: Response;
		try {
			response = await post({
				dataset,
				source_url: docsSourceUrl(slug, commit, path),
				commit,
				content: decoded.content,
				session_id: sessionId,
			});
		} catch (cause) {
			return failed(`the substrate at ${deps.url} did not answer for ${path}: ${(cause as Error).message}`, dataset, commit);
		}
		const text = await response.text().catch(() => "");
		let parsed: unknown = null;
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			parsed = null;
		}
		const body = asRecord(parsed);
		if (response.status === 200 && (body?.status === "uploaded" || body?.status === "unchanged")) {
			// Finalize matches on the server's manifest key, which is derived
			// from `source_url`: store the echoed key when it decodes back to
			// this exact file, so spaces, `#`, and `?` survive the round-trip.
			const echoed = typeof body?.path === "string" ? body.path : undefined;
			const back = echoed === undefined ? null : decodePathSegments(echoed);
			ingestedPaths.push(echoed !== undefined && back !== null && back.ok && back.path === path ? echoed : path);
			if (body.status === "uploaded") counts.uploaded += 1;
			else counts.unchanged += 1;
			if (Array.isArray(body.documentIds)) {
				const ids: unknown[] = body.documentIds;
				counts.documents += ids.filter((id): id is string => typeof id === "string").length;
			}
			continue;
		}
		if (response.status === 400 && body?.status === "refused") {
			counts.refused += 1;
			const reason = typeof body.reason === "string" ? body.reason : "refused";
			deps.err(`[substrate] docs refresh skipped ${path}: ${reason}\n`);
			continue;
		}
		// A body-size refusal is a refused page, not a failed run: the file
		// stays out of the version and everything else still finalizes.
		if (response.status === 413) {
			counts.refused += 1;
			const reason = typeof body?.error === "string" ? body.error : text.slice(0, 200) || "request body too large";
			deps.err(`[substrate] docs refresh skipped ${path}: ${reason}\n`);
			continue;
		}
		const detail = typeof body?.message === "string" ? body.message : text.slice(0, 200) || "no message";
		return failed(`page ${path} got ${response.status}: ${detail}`, dataset, commit);
	}

	if (ingestedPaths.length === 0) {
		return failed("no pages were ingested; not cutting a version", dataset, commit);
	}

	// Parse wait (D25-20): `finalize` itself verifies every page's documents
	// report run DONE, so polling finalize is polling document run status
	// through the audited door. Terminal FAIL/CANCEL aborts at once; queued
	// or missing documents retry until the bound; anything else aborts.
	const deadline = Date.now() + parseDeadlineMs(env.SUBSTRATE_DOCS_PARSE_TIMEOUT_MS);
	const interval = pollIntervalMs(env.SUBSTRATE_DOCS_POLL_MS);
	for (;;) {
		let response: Response;
		try {
			response = await post({ dataset, commit, paths_present: ingestedPaths, finalize: true, session_id: sessionId });
		} catch {
			if (Date.now() >= deadline) return failed("parse wait timed out without cutting a version", dataset, commit);
			await (deps.sleep ?? defaultSleep)(interval);
			continue;
		}
		const text = await response.text().catch(() => "");
		let parsed: unknown = null;
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			parsed = null;
		}
		const body = asRecord(parsed);
		if (response.status === 200 && body?.status === "version-cut") {
			totals("cut", dataset, commit);
			return 0;
		}
		const message =
			typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : text.slice(0, 200);
		if (response.status === 502) {
			if (/reports run (FAIL|CANCEL)/.test(message)) {
				return failed(`parse failed without cutting a version: ${message.slice(0, 200)}`, dataset, commit);
			}
			if (Date.now() >= deadline) return failed("parse wait timed out without cutting a version", dataset, commit);
			await (deps.sleep ?? defaultSleep)(interval);
			continue;
		}
		return failed(`finalize got ${response.status}: ${message.slice(0, 200) || "no message"}`, dataset, commit);
	}
}

// ── tick: the 10-minute host job (D25-18, D25-21 catch-up) ────────────────────

export interface TickDeps {
	/** Space-separated `dataset=owner/repo` pairs (`SUBSTRATE_DOCS_WATCH`). */
	watch: string;
	stateDir: string;
	url: string;
	token: string | undefined;
	timeoutMs: number;
	agentSkillsPath: string;
	remoteTemplate: string;
	out: (text: string) => void;
	err: (text: string) => void;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	env?: Record<string, string | undefined>;
}

function parseWatch(watch: string): { dataset: string; slug: string }[] | { error: string } {
	const entries: { dataset: string; slug: string }[] = [];
	for (const item of watch.split(/[\s,]+/).filter((part) => part.length > 0)) {
		const eq = item.indexOf("=");
		if (eq <= 0) return { error: `bad watch entry ${JSON.stringify(item)}; want dataset=owner/repo` };
		const dataset = item.slice(0, eq).trim();
		const slug = item.slice(eq + 1).trim();
		if (!dataset || !SLUG_PATTERN.test(slug)) {
			return { error: `bad watch entry ${JSON.stringify(item)}; want dataset=owner/repo` };
		}
		entries.push({ dataset, slug });
	}
	return entries;
}

/** HEAD to refresh: the skills checkout read-only, or the mirror's main. */
function tickHead(repoDir: string, isSkills: boolean): { head: string } | { error: string } {
	const ref = isSkills ? "HEAD" : "refs/heads/main";
	const resolved = git(["-C", repoDir, "rev-parse", ref], repoDir);
	if (!resolved.ok) return { error: `cannot resolve ${ref}: ${resolved.stderr.trim().slice(0, 160)}` };
	const head = resolved.stdout.trim();
	if (!COMMIT_PATTERN.test(head)) return { error: `cannot resolve ${ref}` };
	return { head };
}

export async function runDocsTick(deps: TickDeps): Promise<number> {
	const env = deps.env ?? process.env;
	const parsed = parseWatch(deps.watch);
	if ("error" in parsed) {
		deps.err(`[substrate] docs tick failed: ${parsed.error}\n`);
		return 1;
	}
	if (parsed.length === 0) {
		deps.err("[substrate] docs tick failed: SUBSTRATE_DOCS_WATCH is empty; nothing to refresh\n");
		return 1;
	}
	if (!deps.token) {
		deps.err("[substrate] docs tick failed: SUBSTRATE_TOKEN is not set; nothing was posted\n");
		return 1;
	}
	let refreshed = 0;
	let unchanged = 0;
	let failed = 0;
	const inner = (extraEnv: Record<string, string | undefined>): DocsDeps => ({
		url: deps.url,
		token: deps.token,
		timeoutMs: deps.timeoutMs,
		cwd: process.cwd(),
		out: deps.out,
		err: deps.err,
		...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
		...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
		env: { ...env, ...extraEnv },
	});
	for (const { dataset, slug } of parsed) {
		const skillsDir = dataset === "agent-skills" && existsSync(join(deps.agentSkillsPath, ".git"));
		const repoDir = skillsDir ? deps.agentSkillsPath : join(deps.stateDir, "mirrors", `${slug}.git`);
		if (!skillsDir) {
			if (!existsSync(repoDir)) {
				mkdirSync(dirname(repoDir), { recursive: true });
				const remote = deps.remoteTemplate.replace("{slug}", slug);
				const cloned = git(["clone", "--mirror", remote, repoDir], process.cwd());
				if (!cloned.ok) {
					failed += 1;
					deps.out(`dataset=${dataset} status=failed\n`);
					deps.err(`[substrate] docs tick failed for ${dataset}: cannot clone ${slug}\n`);
					continue;
				}
			} else {
				const fetched = git(["-C", repoDir, "fetch", "origin"], repoDir);
				if (!fetched.ok) {
					failed += 1;
					deps.out(`dataset=${dataset} status=failed\n`);
					deps.err(`[substrate] docs tick failed for ${dataset}: cannot fetch ${slug}\n`);
					continue;
				}
			}
		}
		const head = tickHead(repoDir, skillsDir);
		if ("error" in head) {
			failed += 1;
			deps.out(`dataset=${dataset} status=failed\n`);
			deps.err(`[substrate] docs tick failed for ${dataset}: ${head.error}\n`);
			continue;
		}
		const lastFile = join(deps.stateDir, dataset, "last-refresh-commit");
		let last = "";
		try {
			last = readFileSync(lastFile, "utf8").trim();
		} catch {
			last = "";
		}
		if (last === head.head) {
			unchanged += 1;
			deps.out(`dataset=${dataset} status=unchanged commit=${head.head}\n`);
			continue;
		}
		const code = await runDocsRefresh(
			["--dataset", dataset, "--commit", head.head, "--repo", repoDir, "--slug", slug],
			inner({}),
		);
		if (code === 0) {
			refreshed += 1;
			mkdirSync(dirname(lastFile), { recursive: true });
			writeFileSync(lastFile, `${head.head}\n`);
			deps.out(`dataset=${dataset} status=refreshed commit=${head.head}\n`);
		} else {
			failed += 1;
			deps.out(`dataset=${dataset} status=failed commit=${head.head}\n`);
		}
	}
	deps.out(`datasets=${parsed.length} refreshed=${refreshed} unchanged=${unchanged} failed=${failed}\n`);
	return failed === 0 ? 0 : 1;
}

const DEFAULT_URL = "http://127.0.0.1:7410";

if (import.meta.main) {
	const code = await runDocsTick({
		watch: process.env.SUBSTRATE_DOCS_WATCH ?? "",
		stateDir: process.env.SUBSTRATE_DOCS_STATE?.trim() || "/var/lib/substrate/docs",
		url: process.env.SUBSTRATE_URL?.trim() || DEFAULT_URL,
		token: process.env.SUBSTRATE_TOKEN?.trim() || undefined,
		timeoutMs: docsTimeout(process.env.SUBSTRATE_DOCS_TIMEOUT_MS),
		agentSkillsPath: process.env.SUBSTRATE_AGENT_SKILLS_PATH?.trim() || "/root/agent-skills",
		remoteTemplate: process.env.SUBSTRATE_DOCS_REMOTE_TEMPLATE?.trim() || "https://github.com/{slug}.git",
		out: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text),
	});
	process.exit(code);
}
