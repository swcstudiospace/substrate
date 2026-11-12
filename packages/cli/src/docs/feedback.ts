/**
 * `substrate docs feedback` — rate a cited corpus document (REFLECT-02).
 *
 *   substrate docs feedback <document> <verdict> [--session ID] [--json]
 *
 * An HTTP client over `POST /docs/feedback`, the same route and body the
 * `docs_feedback` MCP tool sends: `{ document, verdict, session_id }`, with
 * `session_id` left out when `--session` is not given. `document` is the
 * corpus key a citation names (`repo:path`); `verdict` passes through
 * unchanged, and the server validates the closed set. The CLI never reaches
 * the store directly.
 *
 * The caller in `index.ts` resolves the bearer (the same order every CLI
 * command uses); this command only checks one is present, so nothing is
 * posted anonymously.
 *
 * Output: on a 2xx the server's JSON body goes to stdout, pretty-printed, or
 * on one line with `--json`. A refusal or failure goes to stderr as
 * `[substrate] docs feedback failed: ...` with the server's reason.
 *
 * Exit codes: 0 on HTTP 2xx; 1 on any other status, a network error, a
 * timeout or no bearer configured (nothing posted); 2 on a usage error
 * (a missing positional argument, an unknown flag, `--session` with no value).
 */
import { redact, redactKnown } from "../../../mcp-server/src/redact.ts";

export const FEEDBACK_USAGE = "substrate docs feedback <document> <verdict> [--session ID] [--json]\n";

/** The longest server text quoted back on a failure, so a large HTML error page does not flood the terminal. */
const DETAIL_LIMIT = 500;

export interface FeedbackDeps {
	/** The substrate's base URL, without a trailing slash. */
	url: string;
	/** The resolved bearer. Without one nothing is posted: the route refuses anonymous callers. */
	token: string | undefined;
	timeoutMs: number;
	out: (text: string) => void;
	err: (text: string) => void;
	/** Test seam. */
	fetchImpl?: typeof fetch;
}

/** The parsed command line, or a usage error that names what was wrong. */
export type FeedbackArgs =
	| { ok: true; document: string; verdict: string; session?: string; json: boolean }
	| { ok: false; message: string }
	| { ok: "help" };

/**
 * Read `<document> <verdict> [--session ID] [--json]`.
 *
 * Hand-rolled rather than `parseArgs`: that parser takes the word after a
 * bare `--json` as its value, so `--json repo:path helpful` would lose a
 * positional. Here `--session` is the only flag that takes a value.
 */
export function parseFeedbackArgs(argv: string[]): FeedbackArgs {
	const positional: string[] = [];
	let session: string | undefined;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--help" || arg === "-h") return { ok: "help" };
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--session") {
			const value = argv[i + 1];
			if (value === undefined || value === "" || value.startsWith("--")) return { ok: false, message: "--session takes an ID" };
			session = value;
			i++;
			continue;
		}
		if (arg.startsWith("-")) return { ok: false, message: `unknown flag ${arg}` };
		positional.push(arg);
	}
	if (positional.length < 2 || positional[0] === "" || positional[1] === "") {
		return { ok: false, message: "<document> and <verdict> are both required" };
	}
	if (positional.length > 2) return { ok: false, message: `unexpected argument ${positional[2]}` };
	const document = positional[0] ?? "";
	const verdict = positional[1] ?? "";
	return session === undefined ? { ok: true, document, verdict, json } : { ok: true, document, verdict, session, json };
}

/** The body the route takes: `session_id` only when a session was given. */
export function feedbackBody(args: { document: string; verdict: string; session?: string }): Record<string, string> {
	return args.session === undefined
		? { document: args.document, verdict: args.verdict }
		: { document: args.document, verdict: args.verdict, session_id: args.session };
}

export async function runDocsFeedback(argv: string[], deps: FeedbackDeps): Promise<number> {
	const parsed = parseFeedbackArgs(argv);
	if (parsed.ok === "help") {
		deps.out(FEEDBACK_USAGE);
		return 0;
	}
	if (!parsed.ok) {
		deps.err(`[substrate] docs feedback: ${parsed.message}\n${FEEDBACK_USAGE}`);
		return 2;
	}
	if (!deps.token) {
		deps.err("[substrate] docs feedback failed: no bearer is configured (SUBSTRATE_TOKEN, SUBSTRATE_TOKEN_FILE or the tokens directory); nothing was posted\n");
		return 1;
	}

	const fetchImpl = deps.fetchImpl ?? fetch;
	let response: Response;
	let text: string;
	try {
		response = await fetchImpl(`${deps.url}/docs/feedback`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
			body: JSON.stringify(feedbackBody(parsed)),
			signal: AbortSignal.timeout(deps.timeoutMs),
		});
		text = await response.text();
	} catch (cause) {
		if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
			deps.err(`[substrate] docs feedback failed: the server did not answer within ${deps.timeoutMs} ms\n`);
			return 1;
		}
		const message = cause instanceof Error ? cause.message : String(cause);
		deps.err(`[substrate] docs feedback failed: the server did not answer: ${message.slice(0, DETAIL_LIMIT)}\n`);
		return 1;
	}

	const body = parseJson(text);
	if (!response.ok) {
		deps.err(`[substrate] docs feedback failed: ${redact(redactKnown(refusalText(response.status, body, text), [deps.token]))}\n`);
		return 1;
	}
	if (body === undefined) {
		deps.out(`${text.trim()}\n`);
		return 0;
	}
	deps.out(`${parsed.json ? JSON.stringify(body) : JSON.stringify(body, null, 2)}\n`);
	return 0;
}

/** The parsed JSON, or undefined when the text is not JSON. */
function parseJson(text: string): unknown {
	try {
		const value: unknown = JSON.parse(text);
		return value;
	} catch {
		return undefined;
	}
}

/** The server's reason for a refusal: `reason`, its `error` message and `detail` when present; else the status and a bounded text. */
function refusalText(status: number, body: unknown, text: string): string {
	const reason = stringField(body, "reason");
	const message = stringField(body, "error");
	const detail = stringField(body, "detail");
	if (reason !== undefined || message !== undefined) {
		const head = `HTTP ${status} ${reason ?? "refused"}`;
		const tail = [message, detail].filter((part): part is string => part !== undefined && part !== "").join(": ");
		return tail === "" ? head : `${head}: ${tail}`;
	}
	const quoted = text.trim().slice(0, DETAIL_LIMIT);
	return quoted === "" ? `HTTP ${status}` : `HTTP ${status}: ${quoted}`;
}

/** The string at `key` of a parsed JSON value, or undefined when there is none. */
function stringField(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object" || !(key in value)) return undefined;
	const field: unknown = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}
