/**
 * `substrate docs ingest` — ingest one page into a docs dataset (DOCS-02).
 *
 *   substrate docs ingest --dataset NAME --path PATH --source-url URL
 *       [--commit C] [--heading H] [--session I]
 *
 * `substrate docs refresh` — ingest a committed corpus after a merge (DOCS-03).
 *
 *   substrate docs refresh --dataset NAME --commit SHA --dir DIR
 *       [--path-prefix P] [--roots R,...] [--session I]
 *
 * Refresh reads every byte from the commit's git objects (`rev-parse`
 * equality, then `ls-tree`/`cat-file` on the commit literal): untracked
 * and dirty working-tree bytes are never read, and a directory outside a
 * checkout on `--commit` is refused. Ordinary `ingest` stays the
 * intentional file path for non-repo pages.
 *
 * Both are HTTP clients over `POST /docs/ingest`, with the Phase 20 bearer
 * order (the caller in `index.ts` resolves it; these commands only check one
 * is present). They keep no RAGFlow path: that would be a second door that
 * skips the token, the audit chain and the ingest gates. Anonymous use and a
 * VM guest are refused before any file is read or anything is posted. The
 * server finalizes the version pin; the CLI never numbers versions.
 *
 * Neither is a hook command, so a failure is a non-zero exit, as with
 * `skills propose`: 0 for a stored refresh or an `ingested`, `unchanged`
 * or `replaced` page; 1 for a refusal, a failure, a 401, 403 or 5xx, or a
 * server that did not answer.
 *
 * Output is `key=value` lines on stdout; a human message goes to stderr.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { parseArgs, str, type Args } from "./args.ts";

export const USAGE =
	"substrate docs ingest --dataset NAME --path PATH --source-url URL [--commit C] [--heading H] [--session I]\n" +
	"substrate docs refresh --dataset NAME --commit SHA --dir DIR [--path-prefix P] [--roots R,...] [--session I]\n";

/**
 * The route's cap on one page, so a file too big to be accepted is refused
 * here, before it is posted. `docs-ingest.test.ts` pins it equal to the
 * engine's own cap by reading this file as text.
 */
export const MAX_PAGE_BYTES = 1_000_000;

/**
 * Past the server's parse budget on purpose: one page may poll for a
 * minute behind this request, and a client that gave up first would leave
 * the user not knowing whether the page landed. The CLI ingests a single
 * page per call, so one budget covers it.
 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/** Overridable with `SUBSTRATE_DOCS_TIMEOUT_MS`; anything that is not a positive number is the default. */
export function docsTimeout(raw: string | undefined): number {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/**
 * The posted path with dot-segments resolved, or null when it escapes.
 *
 * Mirrors `normalizeIngestPath` in `packages/mcp-server/src/docs-ingest.ts`
 * (duplicated because the CLI cannot import that module without breaking
 * the substrate-only door); the text test below pins the two together.
 */
export function normalizePath(path: string): string | null {
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

export interface DocsDeps {
	/** The substrate's base URL, without a trailing slash. */
	url: string;
	/** The resolved bearer. Without one nothing is posted: the route refuses anonymous callers. */
	token: string | undefined;
	timeoutMs: number;
	cwd: string;
	out: (text: string) => void;
	err: (text: string) => void;
	/** True when this machine is a VM guest: ingest is refused before anything is posted. */
	vmGuest: boolean;
	/** Test seam. */
	fetchImpl?: typeof fetch;
	/**
	 * Runs git argv in a directory. Tests inject a stub; production shells
	 * out to git with an argv (never a shell).
	 */
	runGit?: GitRunner;
}

/** A git argv runner bound to one directory. */
export type GitRunner = (dir: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Production git runner: `git -C <dir>` with a bounded wait. */
function defaultGitRunner(dir: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	try {
		const stdout = execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
		return Promise.resolve({ code: 0, stdout, stderr: "" });
	} catch {
		return Promise.resolve({ code: 1, stdout: "", stderr: "" });
	}
}

/** `ls-tree -l` record shape (mirrors the tick leg's committed read). */
const TREE_RECORD = /^(\S+) +(\S+) +(\S+) +(\S+)\t([\s\S]*)$/;

const KNOWN_FLAGS = new Set(["dataset", "path", "source-url", "commit", "heading", "session", "help"]);

export async function runDocs(argv: string[], deps: DocsDeps): Promise<number> {
	if (argv[0] !== "ingest" && argv[0] !== "refresh") {
		deps.err(USAGE);
		return 2;
	}
	// Before anything is read or posted.
	if (argv.includes("--help") || argv.includes("-h")) {
		deps.out(USAGE);
		return 0;
	}
	return argv[0] === "ingest" ? ingest(parseArgs(argv.slice(1)), deps) : refresh(parseArgs(argv.slice(1)), deps);
}

async function ingest(args: Args, deps: DocsDeps): Promise<number> {
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

	const unknown = Object.keys(args).find((key) => !KNOWN_FLAGS.has(key));
	if (unknown !== undefined) return refused(`unknown flag --${unknown}`);
	// A flag that takes a value with none given parses as `true`; posting that
	// would ingest under the wrong dataset or URL. Refuse before anything is read.
	const missing = ["dataset", "path", "source-url", "commit", "heading", "session"].find((key) => args[key] === true);
	if (missing !== undefined) return refused(`--${missing} takes a value`);
	const dataset = str(args.dataset);
	if (!dataset) return refused("--dataset NAME is required");
	const pathArg = str(args.path);
	if (!pathArg) return refused("--path PATH is required");
	const sourceUrl = str(args["source-url"]);
	if (!sourceUrl) return refused("--source-url URL is required");
	if (!deps.token) {
		return refused("no bearer is configured; docs ingest needs an authenticated surface, and nothing was posted");
	}
	if (deps.vmGuest) {
		return refused("this machine is a VM guest; guest bytes are never published, and nothing was posted");
	}

	// The posted path is normalized exactly like the server gates it, so a
	// `docs/../` escape is refused here with the file named instead of
	// passing the server as a different file's bytes. The real path travels
	// alongside so a symlinked parent that escapes the roots is refused
	// server-side too. The normalization mirrors
	// `packages/mcp-server/src/docs-ingest.ts#normalizeIngestPath` (the CLI
	// cannot import that module without breaking the substrate-only door).
	const postedPath = normalizePath(pathArg);
	if (postedPath === null) return refused(`${pathArg} escapes its directory`);
	const absolute = resolve(deps.cwd, postedPath);
	let stat: { isSymbolicLink(): boolean; isFile(): boolean; size: number };
	try {
		stat = lstatSync(absolute);
	} catch {
		return refused(`${pathArg} cannot be read`);
	}
	if (stat.isSymbolicLink()) return refused(`${pathArg} is a symlink`);
	if (!stat.isFile()) return refused(`${pathArg} is not a regular file`);
	let realPath: string | null = null;
	try {
		realPath = realpathSync(absolute);
	} catch {
		realPath = null;
	}
	// Counted before the file is read, so a huge file cannot be pulled into memory just to be refused.
	if (stat.size > MAX_PAGE_BYTES) return refused(`${pathArg} is over the limit of ${MAX_PAGE_BYTES} bytes`);
	let body: string;
	try {
		body = readFileSync(absolute, "utf8");
	} catch {
		return refused(`${pathArg} cannot be read`);
	}

	const commit = str(args.commit);
	const heading = str(args.heading);
	const session = str(args.session);
	let response: Response;
	try {
		const fetchImpl = deps.fetchImpl ?? fetch;
		response = await fetchImpl(`${deps.url}/docs/ingest`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
			body: JSON.stringify({
				dataset,
				pages: [
					{
						path: postedPath,
						...(realPath !== null ? { real_path: relative(deps.cwd, realPath) } : {}),
						source_url: sourceUrl,
						body,
						...(heading !== undefined ? { heading_path: heading } : {}),
					},
				],
				...(commit !== undefined ? { commit } : {}),
				...(session !== undefined ? { session_id: session } : {}),
			}),
			signal: AbortSignal.timeout(deps.timeoutMs),
		});
	} catch (cause) {
		return failed(`the server did not answer: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 300));
	}
	if (response.status === 401 || response.status === 403) {
		field("status", "refused");
		deps.err(`[substrate] docs ingest refused: the server answered ${response.status}\n`);
		return 1;
	}
	if (!response.ok) {
		return failed(`the server answered ${response.status}`);
	}
	const reply: unknown = await response.json().catch((): unknown => null);
	if (reply === null || typeof reply !== "object" || !("results" in reply) || !Array.isArray(reply.results)) {
		return failed("the server answer was not an ingest result");
	}
	const first = reply.results[0];
	const status =
		first !== null && typeof first === "object" && "status" in first && typeof first.status === "string" ? first.status : "unknown";
	const documentId =
		first !== null && typeof first === "object" && "document_id" in first && typeof first.document_id === "string"
			? first.document_id
			: undefined;
	field("status", status);
	field("document_id", documentId);
	return 0;
}

/** Roots a refresh walks when `--roots` is omitted. The server is the final gate. */
const DEFAULT_REFRESH_ROOTS: readonly string[] = ["docs/", "README.md", ".planning/PROJECT.md", "agent-skills/", "skills/", "contracts/"];

/** Mirrors the engine's per-call cap: refresh posts are chunked to stay under it. */
const REFRESH_CALL_MAX_BYTES = 5_000_000;

/** Envelope keys every refresh call carries besides pages, amortized per chunk. */
const REFRESH_ENVELOPE_BYTES = 512;

const REFRESH_FLAGS = new Set(["dataset", "commit", "dir", "path-prefix", "roots", "session", "help"]);

/** Whether a dir-relative path sits under one of the roots, like the server gates it. */
function underRefreshRoot(rel: string, roots: readonly string[]): boolean {
	for (const root of roots) {
		if (root.endsWith("/")) {
			if (rel.startsWith(root)) return true;
		} else if (rel === root) {
			return true;
		}
	}
	return false;
}

async function refresh(args: Args, deps: DocsDeps): Promise<number> {
	const field = (key: string, value: string | number | undefined) => {
		if (value !== undefined) deps.out(`${key}=${value}\n`);
	};
	const refused = (message: string): number => {
		field("status", "refused");
		deps.err(`[substrate] docs refresh refused: ${message}\n`);
		return 1;
	};
	const failed = (message: string): number => {
		field("status", "failed");
		deps.err(`[substrate] docs refresh failed: ${message}\n`);
		return 1;
	};

	const unknown = Object.keys(args).find((key) => !REFRESH_FLAGS.has(key));
	if (unknown !== undefined) return refused(`unknown flag --${unknown}`);
	const missing = ["dataset", "commit", "dir", "path-prefix", "roots", "session"].find((key) => args[key] === true);
	if (missing !== undefined) return refused(`--${missing} takes a value`);
	const dataset = str(args.dataset);
	if (!dataset) return refused("--dataset NAME is required");
	const commit = str(args.commit);
	if (!commit) return refused("--commit SHA is required");
	const dirArg = str(args.dir);
	if (!dirArg) return refused("--dir DIR is required");
	if (!deps.token) {
		return refused("no bearer is configured; docs refresh needs an authenticated surface, and nothing was posted");
	}
	if (deps.vmGuest) {
		return refused("this machine is a VM guest; guest bytes are never published, and nothing was posted");
	}
	const dirPosted = normalizePath(dirArg);
	if (dirPosted === null) return refused(`${dirArg} escapes its directory`);
	const dirAbs = resolve(deps.cwd, dirPosted);
	try {
		const dirStat = lstatSync(dirAbs);
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return refused(`${dirArg} is not a directory`);
	} catch {
		return refused(`${dirArg} cannot be read`);
	}
	const prefix = str(args["path-prefix"]) ?? "";
	if (prefix.includes("..")) return refused("--path-prefix must not contain ..");
	const roots = str(args.roots)?.split(",").map((root) => root.trim()).filter((root) => root.length > 0) ?? [...DEFAULT_REFRESH_ROOTS];
	// The pin names the commit, so every byte comes from that commit's
	// objects: untracked and dirty working-tree bytes are never read, let
	// alone posted. A directory git cannot read, a moved HEAD, a symlink,
	// an over-cap blob or an unreadable object refuses the whole run
	// before any post — never a partial corpus.
	const runGit = deps.runGit ?? defaultGitRunner;
	const head = await runGit(dirAbs, ["rev-parse", "HEAD"]);
	if (head.code !== 0) return refused(`${dirArg} is not a git checkout; refresh posts committed bytes only`);
	const sha = head.stdout.trim();
	if (sha !== commit) return refused(`--dir is at ${sha.slice(0, 12)}, not --commit ${commit.slice(0, 12)}`);
	const tree = await runGit(dirAbs, ["ls-tree", "-r", "-l", "-z", commit]);
	if (tree.code !== 0) return refused(`cannot list ${commit.slice(0, 12)} in ${dirArg}`);
	const rels: string[] = [];
	for (const record of tree.stdout.split("\0")) {
		if (record === "") continue;
		const match = TREE_RECORD.exec(record);
		if (!match) return refused(`cannot list ${commit.slice(0, 12)} in ${dirArg}`);
		const [, mode, kind, , size, path] = match;
		if (path === undefined) return refused(`cannot list ${commit.slice(0, 12)} in ${dirArg}`);
		if (kind !== "blob" || !path.endsWith(".md") || !underRefreshRoot(path, roots)) continue;
		if (mode === "120000") return refused(`${path} is a symlink; refresh posts committed regular files only`);
		const bytes = Number(size);
		if (!Number.isFinite(bytes) || bytes > MAX_PAGE_BYTES) return refused(`${path} is over the limit of ${MAX_PAGE_BYTES} bytes`);
		rels.push(path);
	}
	if (rels.length === 0) return refused(`no ingestible pages under ${dirArg} at ${commit.slice(0, 12)}`);
	const pages: { path: string; source_url: string; body: string }[] = [];
	for (const rel of rels.sort()) {
		const blob = await runGit(dirAbs, ["cat-file", "-p", `${commit}:${rel}`]);
		if (blob.code !== 0) return refused(`${rel} cannot be read`);
		const posted = `${prefix}${rel}`;
		pages.push({ path: posted, source_url: `${dataset}://${posted}`, body: blob.stdout });
	}

	const session = str(args.session);
	const fetchImpl = deps.fetchImpl ?? fetch;
	const chunks: (typeof pages)[] = [];
	let chunk: typeof pages = [];
	let bytes = REFRESH_ENVELOPE_BYTES;
	for (const page of pages) {
		// Serialized size, not body size: escaping counts toward the intake.
		const size = Buffer.byteLength(JSON.stringify(page), "utf8");
		if (chunk.length > 0 && bytes + size > REFRESH_CALL_MAX_BYTES) {
			chunks.push(chunk);
			chunk = [];
			bytes = REFRESH_ENVELOPE_BYTES;
		}
		chunk.push(page);
		bytes = bytes + size;
	}
	if (chunk.length > 0) chunks.push(chunk);
	let calls = 0;
	for (const [index, piece] of chunks.entries()) {
		let response: Response;
		try {
			response = await fetchImpl(`${deps.url}/docs/ingest`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
				body: JSON.stringify({ dataset, commit, pages: piece, refresh: { id: `repo-merge:${dataset}:${commit}`, part: index + 1, parts: chunks.length, trigger: "repo-merge" }, session_id: session ?? `docs-refresh:${commit}` }),
				signal: AbortSignal.timeout(deps.timeoutMs),
			});
		} catch (cause) {
			return failed(`call ${index + 1}/${chunks.length} did not answer: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 300));
		}
		if (response.status === 401 || response.status === 403) {
			field("status", "refused");
			deps.err(`[substrate] docs refresh refused: the server answered ${response.status}\n`);
			return 1;
		}
		if (!response.ok) return failed(`call ${index + 1}/${chunks.length} answered ${response.status}`);
		const reply: unknown = await response.json().catch((): unknown => null);
		if (reply === null || typeof reply !== "object" || !("results" in reply) || !Array.isArray(reply.results)) {
			return failed(`call ${index + 1}/${chunks.length} answer was not an ingest result`);
		}
		calls = calls + 1;
	}
	field("status", "stored");
	field("pages", pages.length);
	field("calls", calls);
	return 0;
}
