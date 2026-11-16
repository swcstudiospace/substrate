/** `substrate docs ingest` — uses the LightRAG backend for docs dataset ingest (DOCS-02). */
/**
 * `substrate docs ingest` — ingest one page into a docs dataset (DOCS-02).
 *
 *   substrate docs ingest --dataset NAME --path PATH --source-url URL
 *       [--commit C] [--heading H] [--session I]
 *
 * An HTTP client over `POST /docs/ingest`, with the Phase 20 bearer order
 * (the caller in `index.ts` resolves it; this command only checks one is
 * present). Anonymous use and a VM guest are refused before any file is read or anything is posted.
 * It is not a hook command, so a failure is a non-zero exit, as with `skills
 * propose`: 0 for `ingested`, `unchanged` and `replaced`; 1 for a refusal, a
 * failure, a 401, 403 or 5xx, or a server that did not answer.
 *
 * Output is `key=value` lines on stdout; a human message goes to stderr.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs, str, type Args } from "./args.ts";

export const USAGE =
	"substrate docs ingest --dataset NAME --path PATH --source-url URL [--commit C] [--heading H] [--session I]\n";

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
}

const KNOWN_FLAGS = new Set(["dataset", "path", "source-url", "commit", "heading", "session", "help"]);

export async function runDocs(argv: string[], deps: DocsDeps): Promise<number> {
	if (argv[0] !== "ingest") {
		deps.err(USAGE);
		return 2;
	}
	// Before anything is read or posted.
	if (argv.includes("--help") || argv.includes("-h")) {
		deps.out(USAGE);
		return 0;
	}
	return ingest(parseArgs(argv.slice(1)), deps);
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
