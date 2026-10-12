/**
 * DOCS-03: the skills-sync fast-forward refresh leg (D25-07).
 *
 * After `runSync` merges a fast-forward, the tick posts the committed
 * library corpus — every skill's `SKILL.md` plus its `references/` files
 * read from the merged commit itself, never from the working tree — to
 * the substrate `docs_ingest` route, the only door. There is no RAGFlow
 * import and no second transport here: the server stages every part and
 * finalizes the version pin only for a whole corpus. A failed refresh
 * never marks anything live; the tick logs it and warns, while the
 * projection that already applied stays untouched. Ticks without a
 * fast-forward post nothing.
 */
import { isSkillCorpusPath } from "./skills.ts";

/** Mirrors the engine's per-page cap: over-cap blobs refuse the run before any post. */
const PAGE_MAX_BYTES = 1_000_000;
/** Mirrors the engine's per-call cap: posts are chunked to stay under it. */
const CALL_MAX_BYTES = 5_000_000;
const SUBSTRATE_URL = (process.env.SUBSTRATE_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, "");
const REFRESH_TIMEOUT_MS = 180_000;
/** Backstop so a runaway corpus cannot stage an unbounded part count. */
const MAX_CHUNKS = 64;

/** Envelope keys every call carries besides pages, amortized per chunk. */
const ENVELOPE_BYTES = 512;

/** Serialized wire size of one posted page: escaping counts, so the route intake cap cannot be overshot. */
function pageWireSize(page: CorpusPage): number {
	return Buffer.byteLength(JSON.stringify({ path: page.path, source_url: page.source_url, body: page.body }), "utf8");
}

export interface CorpusPage {
	/** Posted path, always under `agent-skills/`. */
	path: string;
	source_url: string;
	body: string;
}

export type RefreshOutcome = { ok: true; stored: number } | { ok: false; reason: string; detail?: string };

/** A git argv runner; the tick binds it to `git -C <libraryDir>`. */
export type GitRunner = (args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** The only fetch shape the refresh leg needs: plain POSTs to the substrate route. */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Which whole-corpus flow a refresh belongs to (mirrors the server contract). */
export type RefreshTrigger = "repo-merge" | "skills-sync";

const TREE_RECORD = /^(\S+) +(\S+) +(\S+) +(\S+)\t([\s\S]*)$/;

/**
 * Read the corpus from the verified commit: `HEAD` must equal the merged
 * commit, and every byte comes from `cat-file`, never from the working
 * tree. Symlinks, over-cap blobs, unreadable objects and an empty corpus
 * refuse the whole run before any post — never a partial success.
 */
export async function collectCommittedPages(
	runGit: GitRunner,
	commit: string,
	dataset = "agent-skills",
): Promise<{ ok: true; pages: CorpusPage[] } | { ok: false; reason: string; detail?: string }> {
	const head = await runGit(["rev-parse", "HEAD"]);
	if (head.code !== 0) return { ok: false, reason: "head-unreadable" };
	if (head.stdout.trim() !== commit) return { ok: false, reason: "head-changed", detail: head.stdout.trim().slice(0, 12) };
	const tree = await runGit(["ls-tree", "-r", "-l", "-z", commit]);
	if (tree.code !== 0) return { ok: false, reason: "tree-unreadable" };
	const kept: string[] = [];
	for (const record of tree.stdout.split("\0")) {
		if (record === "") continue;
		const match = TREE_RECORD.exec(record);
		if (!match) return { ok: false, reason: "tree-unreadable", detail: record.slice(0, 80) };
		const [, mode, kind, , size, path] = match;
		if (kind !== "blob" || !isSkillCorpusPath(path ?? "")) continue;
		if (mode === "120000") return { ok: false, reason: "corpus-refused", detail: `symlink:${path}` };
		const bytes = Number(size);
		if (!Number.isFinite(bytes) || bytes > PAGE_MAX_BYTES) return { ok: false, reason: "corpus-refused", detail: `oversize:${path}` };
		kept.push(path ?? "");
	}
	if (kept.length === 0) return { ok: false, reason: "empty-corpus" };
	const pages: CorpusPage[] = [];
	for (const path of kept.sort()) {
		const blob = await runGit(["cat-file", "-p", `${commit}:${path}`]);
		if (blob.code !== 0) return { ok: false, reason: "blob-unreadable", detail: path };
		const segments = path.split("/");
		const name = segments[0] ?? "";
		const rel = segments.slice(1).join("/");
		pages.push({ path: `${dataset}/${name}/${rel}`, source_url: `${dataset}://${name}/${rel}`, body: blob.stdout });
	}
	return { ok: true, pages };
}

export interface RefreshPost {
	url: string;
	token: string | undefined;
	dataset: string;
	commit: string;
	pages: CorpusPage[];
	refresh: { id: string; trigger: RefreshTrigger };
	session?: string;
	timeoutMs?: number;
	fetchImpl?: FetchFn;
}

/**
 * Chunk pages so no serialized call passes the engine's per-call cap (and
 * stays far under the route intake). Sizes measure the posted JSON, so
 * escaping cannot push a call over: a 5 MB body budget is a ~5 MB wire
 * call, never a 6 MB one.
 */
export function chunkPages(pages: CorpusPage[]): CorpusPage[][] {
	const chunks: CorpusPage[][] = [];
	let current: CorpusPage[] = [];
	let bytes = ENVELOPE_BYTES;
	for (const page of pages) {
		const size = pageWireSize(page);
		if (current.length > 0 && bytes + size > CALL_MAX_BYTES) {
			chunks.push(current);
			current = [];
			bytes = ENVELOPE_BYTES;
		}
		current.push(page);
		bytes += size;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

function isResultsReply(reply: unknown): reply is { ok: true; results: Array<{ status: string }> } {
	if (reply === null || typeof reply !== "object" || !("ok" in reply) || reply.ok !== true || !("results" in reply)) return false;
	return Array.isArray(reply.results) && reply.results.every((result: unknown) =>
		result !== null && typeof result === "object" && "status" in result &&
		(result.status === "ingested" || result.status === "replaced" || result.status === "unchanged"),
	);
}

/**
 * Post corpus chunks to `POST /docs/ingest`, every chunk carrying the
 * refresh metadata so the server stages parts and promotes only the whole
 * corpus. Never throws: every failure is a reason the tick logs and warns
 * about.
 */
export async function postCorpusRefresh(post: RefreshPost): Promise<RefreshOutcome> {
	if (!post.token) return { ok: false, reason: "no-bearer" };
	if (post.pages.length === 0) return { ok: false, reason: "empty-corpus" };
	const chunks = chunkPages(post.pages);
	if (chunks.length > MAX_CHUNKS) return { ok: false, reason: "too-many-calls" };
	const fetchImpl = post.fetchImpl ?? fetch;
	let stored = 0;
	let call = 0;
	for (const chunk of chunks) {
		call += 1;
		let response: Response;
		try {
			response = await fetchImpl(`${post.url}/docs/ingest`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${post.token}` },
				body: JSON.stringify({
					dataset: post.dataset,
					commit: post.commit,
					pages: chunk,
					refresh: { id: post.refresh.id, part: call, parts: chunks.length, trigger: post.refresh.trigger },
					session_id: post.session ?? `skills-sync:${post.commit}`,
				}),
				signal: AbortSignal.timeout(post.timeoutMs ?? REFRESH_TIMEOUT_MS),
			});
		} catch {
			return { ok: false, reason: "no-answer" };
		}
		if (!response.ok) return { ok: false, reason: `http-${response.status}` };
		const reply: unknown = await response.json().catch((): unknown => null);
		if (!isResultsReply(reply) || reply.results.length !== chunk.length) return { ok: false, reason: "bad-reply" };
		stored += reply.results.length;
	}
	return { ok: true, stored };
}

export interface LibraryRefresh {
	libraryDir: string;
	commit: string;
	runGit: GitRunner;
	url?: string;
	token?: string;
	fetchImpl?: FetchFn;
}

/**
 * The default refresh leg: read the committed corpus and post it through
 * the substrate. Bearer names the per-unit `SUBSTRATE_TOKEN_SUBSTRATE`
 * first, with `SUBSTRATE_TOKEN` as fallback; without either nothing is
 * posted and the failure stays visible.
 */
export async function refreshLibraryCorpus(refresh: LibraryRefresh): Promise<RefreshOutcome> {
	const collected = await collectCommittedPages(refresh.runGit, refresh.commit);
	if (!collected.ok) return collected;
	return postCorpusRefresh({
		url: (refresh.url ?? SUBSTRATE_URL).replace(/\/+$/, ""),
		token: refresh.token ?? process.env.SUBSTRATE_TOKEN_SUBSTRATE ?? process.env.SUBSTRATE_TOKEN,
		dataset: "agent-skills",
		commit: refresh.commit,
		pages: collected.pages,
		refresh: { id: `skills-sync:${refresh.commit}`, trigger: "skills-sync" },
		fetchImpl: refresh.fetchImpl,
	});
}
