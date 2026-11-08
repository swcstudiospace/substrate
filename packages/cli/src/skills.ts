/**
 * `substrate skills` — propose, list and decide skill-registry rows (SKILL-01).
 *
 *   substrate skills propose --dir PATH [--name N] [--rationale R] [--remove a,b]
 *       [--session I] [--graph G] [--dry-run]
 *       [--replace] [--reopen] [--allow-doc-examples pem,jwt]      (operator tokens only)
 *   substrate skills list [--state approved|proposed|declined|retired|all]
 *   substrate skills approve --name N --pr NUMBER --decision approve|decline|retire [--reason R]
 *
 * HTTP over `POST /skills/propose`, `GET /skills` and `POST /skills/approve`, with
 * `SUBSTRATE_TOKEN`. Propose keeps no in-process git path: that would be a second
 * door that skips the token, the audit chain and the event. The server attributes
 * the call to the token's surface. There is no `--surface` flag, because the
 * surface is the token's and a different one is refused.
 *
 * It is not a hook command, so a failure is a non-zero exit, as with `verify` and
 * `drift`: 0 for a proposal status of `opened`, `existing`, `unchanged`, `declined`
 * or `dry_run`, and for a list or an approval that the server accepted; 1 for a
 * refusal, a failure, a 4xx or 5xx, or a server that did not answer; 2 for usage.
 *
 * Output is `key=value` lines on stdout, one `finding=<file>:<line> <rule>` per
 * finding and one `skill=` line per listed entry; a human message goes to stderr.
 * See `docs/skills-propose.md` and `docs/runbooks/skills-governance.md`.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ProposeResult } from "../../mcp-server/src/skills/propose.ts";
import { list, parseArgs, str, type Args } from "./args.ts";

/**
 * The route's cap on a request body, so a directory too big to be accepted is refused
 * here, before it is posted. `skills.test.ts` pins it equal to the engine's own cap.
 */
export const MAX_BODY_BYTES = 1_000_000;

/**
 * Longer than the hooks' 1.5 s on purpose: a proposal runs `git fetch`, `git push` and
 * `gh` behind this request, and a client that gave up first would leave the user
 * not knowing whether a PR was opened.
 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/** Overridable with `SUBSTRATE_SKILLS_TIMEOUT_MS`; anything that is not a positive number is the default. */
export function skillsTimeout(raw: string | undefined): number {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** A directory that must not be proposed, with the reason and the path that caused it. */
export class DirRefused extends Error {}

/**
 * Every file under `dir` as UTF-8 text, keyed by its relative path. Nothing is skipped
 * silently: a symlink, a special file or a file that is not valid UTF-8 refuses the whole
 * directory, naming it, and so does a total size over the route's cap (counted from file sizes
 * before any file is read).
 */
export function readSkillDir(dir: string): Record<string, string> {
	// No prototype: assigning a file named `__proto__` must keep the file, not set the prototype.
	const files: Record<string, string> = Object.create(null);
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let bytes = 0;
	const walk = (absolute: string, relative: string) => {
		for (const entry of readdirSync(absolute).sort()) {
			const path = join(absolute, entry);
			const relativePath = relative ? `${relative}/${entry}` : entry;
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new DirRefused(`${relativePath} is a symlink`);
			if (stat.isDirectory()) walk(path, relativePath);
			else if (!stat.isFile()) throw new DirRefused(`${relativePath} is not a regular file`);
			else {
				// Counted before the file is read, so a huge file cannot be pulled into memory just to be refused.
				bytes += stat.size;
				if (bytes > MAX_BODY_BYTES) throw new DirRefused(`the directory is over the limit of ${MAX_BODY_BYTES} bytes`);
				try {
					Object.defineProperty(files, relativePath, {
						value: decoder.decode(readFileSync(path)),
						enumerable: true,
						writable: true,
						configurable: true,
					});
				} catch {
					throw new DirRefused(`${relativePath} is not valid UTF-8`);
				}
			}
		}
	};
	walk(dir, "");
	return files;
}

export interface SkillsDeps {
	/** The substrate's base URL, without a trailing slash. */
	url: string;
	/** `SUBSTRATE_TOKEN`. Without one nothing is posted: the route refuses anonymous callers. */
	token: string | undefined;
	timeoutMs: number;
	cwd: string;
	out: (text: string) => void;
	err: (text: string) => void;
	/** Test seam. */
	fetch?: typeof fetch;
}

const USAGE =
	"substrate skills propose --dir PATH [--name N] [--rationale R] [--remove a,b] [--session I] [--graph G] [--dry-run]\n" +
	"                         [--replace] [--reopen] [--allow-doc-examples pem,jwt]   (operator tokens only)\n" +
	"substrate skills list [--state approved|proposed|declined|retired|all]\n" +
	"substrate skills approve --name N --pr NUMBER --decision approve|decline|retire [--reason R]\n";

/** What the server answers with when it refuses or fails: `{ error, findings? }`. */
interface ErrorBody {
	error?: string;
	findings?: Array<{ file?: string; line?: number; rule?: string }>;
}

const DOC_EXAMPLE_RULES: readonly string[] = ["pem", "jwt"];
const PROPOSE_STATUSES = new Set(["opened", "existing", "unchanged", "declined", "dry_run"]);
const KNOWN_FLAGS = new Set(["dir", "name", "rationale", "remove", "session", "graph", "dry-run", "replace", "reopen", "allow-doc-examples", "surface", "help"]);

function proposeResult(value: unknown): ProposeResult | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.status !== "string" || !PROPOSE_STATUSES.has(record.status)) return null;
	if (typeof record.content_sha256 !== "string" || record.content_sha256.length === 0) return null;
	return value as ProposeResult;
}

const LIST_STATES = new Set(["approved", "proposed", "declined", "retired", "all"]);
const DECISIONS = new Set(["approve", "decline", "retire"]);
const APPROVE_STATUSES = new Set(["approved", "declined", "retired", "exists"]);

export async function runSkills(argv: string[], deps: SkillsDeps): Promise<number> {
	const command = argv[0];
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		deps.out(USAGE);
		return 0;
	}
	if (command === "propose") {
		// Before the directory is read or anything is posted, including when --dir is also present.
		if (argv.includes("--help") || argv.includes("-h")) {
			deps.out(USAGE);
			return 0;
		}
		return propose(parseArgs(argv.slice(1)), deps);
	}
	if ((command === "list" || command === "approve") && (argv.includes("--help") || argv.includes("-h"))) {
		deps.out(USAGE);
		return 0;
	}
	if (command === "list") return listCommand(parseArgs(argv.slice(1)), deps);
	if (command === "approve") return approveCommand(parseArgs(argv.slice(1)), deps);
	deps.err(USAGE);
	return 2;
}

async function propose(args: Args, deps: SkillsDeps): Promise<number> {
	const field = (key: string, value: string | number | undefined) => {
		if (value !== undefined) deps.out(`${key}=${value}\n`);
	};
	const refused = (message: string): number => {
		field("status", "refused");
		deps.err(`[substrate] skills propose refused: ${message}\n`);
		return 1;
	};
	const failed = (message: string): number => {
		field("status", "failed");
		deps.err(`[substrate] skills propose failed: ${message}\n`);
		return 1;
	};

	if (args.surface !== undefined) {
		return refused("there is no --surface flag: a proposal is made as the surface SUBSTRATE_TOKEN belongs to");
	}
	const unknown = Object.keys(args).find((key) => !KNOWN_FLAGS.has(key));
	if (unknown !== undefined) return refused(`unknown flag --${unknown}`);
	// A flag that takes a value with none given parses as `true`; `str` and `list` would
	// silently drop it, posting a live proposal without the removals or identifiers the
	// user asked for. Refuse before the directory is read or anything is posted.
	const missing = ["dir", "name", "rationale", "remove", "session", "graph"].find((key) => args[key] === true);
	if (missing !== undefined) return refused(`--${missing} takes a value`);
	const dirArg = str(args.dir);
	if (!dirArg) return refused("--dir PATH is required");
	if (!deps.token) {
		return refused("SUBSTRATE_TOKEN is not set; skills propose needs an authenticated surface, and nothing was posted");
	}

	const dir = resolve(deps.cwd, dirArg);
	let files: Record<string, string>;
	try {
		const stat = lstatSync(dir);
		if (stat.isSymbolicLink()) return refused(`${dirArg} is a symlink`);
		if (!stat.isDirectory()) return refused(`${dirArg} is not a directory`);
		files = readSkillDir(dir);
	} catch (cause) {
		return refused(cause instanceof DirRefused ? cause.message : `cannot read ${dirArg}: ${(cause as Error).message}`);
	}

	let allow: string[] | undefined;
	if (args["allow-doc-examples"] !== undefined) {
		const raw = str(args["allow-doc-examples"]);
		if (raw === undefined) return refused("--allow-doc-examples takes pem, jwt or pem,jwt");
		allow = list(raw) ?? [];
		const unknown = allow.find((rule) => !DOC_EXAMPLE_RULES.includes(rule));
		if (unknown !== undefined || allow.length === 0) {
			return refused(`--allow-doc-examples accepts only pem and jwt, not ${JSON.stringify(unknown ?? raw)}`);
		}
	}

	const remove = list(args.remove);
	const session = str(args.session);
	const graph = str(args.graph);
	// The keys are the route's snake_case ones, and no `surface` is ever sent.
	const body = {
		name: str(args.name) ?? basename(dir),
		files,
		rationale: str(args.rationale) ?? `substrate skills propose --dir ${basename(dir)}`,
		...(remove ? { remove } : {}),
		...(session ? { session_id: session } : {}),
		...(graph ? { graph_id: graph } : {}),
		...(args["dry-run"] !== undefined ? { dry_run: true } : {}),
		...(args.replace !== undefined ? { mode: "replace" } : {}),
		...(args.reopen !== undefined ? { reopen: true } : {}),
		...(allow ? { allow_doc_examples: allow } : {}),
	};
	const payload = JSON.stringify(body);
	const size = Buffer.byteLength(payload, "utf8");
	if (size > MAX_BODY_BYTES) {
		return refused(`the proposal is ${size} bytes as JSON, over the limit of ${MAX_BODY_BYTES} bytes`);
	}

	let response: Response;
	try {
		response = await (deps.fetch ?? fetch)(`${deps.url}/skills/propose`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
			body: payload,
			signal: AbortSignal.timeout(deps.timeoutMs),
		});
	} catch (cause) {
		return failed(`the substrate at ${deps.url} did not answer: ${(cause as Error).message}`);
	}

	const text = await response.text().catch(() => "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	if (response.status === 200) {
		const result = proposeResult(parsed);
		if (result === null) return failed(`the substrate answered 200 without a proposal result`);
		field("status", result.status);
		field("pr_url", result.pr_url);
		field("pr_number", result.pr_number);
		field("branch", result.branch);
		field("content_sha256", result.content_sha256);
		field("redactions", Array.isArray(result.redactions) ? result.redactions.length : 0);
		field("diff_added", result.diff_added);
		field("diff_changed", result.diff_changed);
		field("diff_deleted", result.diff_deleted);
		return 0;
	}

	const error = parsed !== null && typeof parsed === "object" ? (parsed as ErrorBody) : {};
	const message = `${response.status}: ${error.error ?? (text.slice(0, 200) || "no message")}`;
	// A refusal is the server saying no to this proposal (or this caller); anything else is a failure.
	if (response.status >= 400 && response.status < 500) {
		for (const finding of error.findings ?? []) field("finding", `${finding.file}:${finding.line} ${finding.rule}`);
		return refused(message);
	}
	return failed(message);
}

function report(verb: string, deps: SkillsDeps) {
	const field = (key: string, value: string | number | boolean | undefined) => {
		if (value !== undefined) deps.out(`${key}=${value}\n`);
	};
	const refused = (message: string): number => {
		field("status", "refused");
		deps.err(`[substrate] skills ${verb} refused: ${message}\n`);
		return 1;
	};
	const failed = (message: string): number => {
		field("status", "failed");
		deps.err(`[substrate] skills ${verb} failed: ${message}\n`);
		return 1;
	};
	return { field, refused, failed };
}

/** Bearer GET or POST. A thrown error is a transport failure; the caller classifies the status. */
async function skillsFetch(deps: SkillsDeps, path: string, init: { method: "GET" | "POST"; body?: string }): Promise<Response> {
	return (deps.fetch ?? fetch)(`${deps.url}${path}`, {
		method: init.method,
		headers: {
			authorization: `Bearer ${deps.token}`,
			...(init.body !== undefined ? { "content-type": "application/json" } : {}),
		},
		...(init.body !== undefined ? { body: init.body } : {}),
		signal: AbortSignal.timeout(deps.timeoutMs),
	});
}

async function readJson(response: Response): Promise<{ parsed: unknown; text: string } | null> {
	const text = await response.text().catch(() => "");
	try {
		return { parsed: JSON.parse(text), text };
	} catch {
		return null;
	}
}

function errorText(status: number, parsed: unknown, text: string): string {
	const error = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ErrorBody).error : undefined;
	return `${status}: ${error ?? (text.slice(0, 200) || "no message")}`;
}

async function listCommand(args: Args, deps: SkillsDeps): Promise<number> {
	const { field, refused, failed } = report("list", deps);
	if (args.surface !== undefined) {
		return refused("there is no --surface flag: a list is read as the surface SUBSTRATE_TOKEN belongs to");
	}
	const unknown = Object.keys(args).find((key) => key !== "state");
	if (unknown !== undefined) return refused(`unknown flag --${unknown}`);
	if (args.state === true) return refused("--state takes a value");
	const state = str(args.state);
	if (state !== undefined && !LIST_STATES.has(state)) {
		return refused("--state is approved, proposed, declined, retired or all");
	}
	if (!deps.token) {
		return refused("SUBSTRATE_TOKEN is not set; skills list needs an authenticated surface, and nothing was sent");
	}

	let response: Response;
	try {
		response = await skillsFetch(deps, state === undefined ? "/skills" : `/skills?state=${state}`, { method: "GET" });
	} catch (cause) {
		return failed(`the substrate at ${deps.url} did not answer: ${(cause as Error).message}`);
	}
	const json = await readJson(response);
	if (json === null) return failed(`${response.status}: the substrate answered with a body that is not JSON`);
	if (response.status >= 400 && response.status < 500) return refused(errorText(response.status, json.parsed, json.text));
	if (response.status !== 200) return failed(errorText(response.status, json.parsed, json.text));

	const body = json.parsed;
	if (body === null || typeof body !== "object" || Array.isArray(body)) return failed("the substrate answered 200 without a skill list");
	const record = body as Record<string, unknown>;
	if (typeof record.governance !== "string" || typeof record.library !== "string" || typeof record.truncated !== "boolean" || !Array.isArray(record.skills)) {
		return failed("the substrate answered 200 without a skill list");
	}
	field("governance", record.governance);
	field("library", record.library);
	field("truncated", record.truncated);
	field("count", record.skills.length);
	for (const entry of record.skills) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return failed("the substrate answered 200 without a skill list");
		const parts: string[] = [];
		for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
			if (value === null || value === undefined) continue;
			parts.push(`${key}=${value}`);
		}
		deps.out(`skill=${parts.join(" ")}\n`);
	}
	return 0;
}

function positivePr(raw: string | undefined): number | null {
	if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : null;
}

async function approveCommand(args: Args, deps: SkillsDeps): Promise<number> {
	const { field, refused, failed } = report("approve", deps);
	if (args.surface !== undefined) {
		return refused("there is no --surface flag: a decision is made as the surface SUBSTRATE_TOKEN belongs to");
	}
	const unknown = Object.keys(args).find((key) => !["name", "pr", "decision", "reason"].includes(key));
	if (unknown !== undefined) return refused(`unknown flag --${unknown}`);
	const missing = ["name", "pr", "decision", "reason"].find((key) => args[key] === true);
	if (missing !== undefined) return refused(`--${missing} takes a value`);
	const name = str(args.name);
	if (!name) return refused("--name N is required");
	const pr = positivePr(str(args.pr));
	if (pr === null) return refused("--pr takes a positive integer");
	const decision = str(args.decision);
	if (decision === undefined || !DECISIONS.has(decision)) return refused("--decision is approve, decline or retire");
	if (!deps.token) {
		return refused("SUBSTRATE_TOKEN is not set; skills approve needs an authenticated surface, and nothing was sent");
	}

	const reason = str(args.reason);
	const payload = JSON.stringify({
		name,
		pr_number: pr,
		decision,
		...(reason !== undefined ? { reason } : {}),
	});

	let response: Response;
	try {
		response = await skillsFetch(deps, "/skills/approve", { method: "POST", body: payload });
	} catch (cause) {
		return failed(`the substrate at ${deps.url} did not answer: ${(cause as Error).message}`);
	}
	const json = await readJson(response);
	if (json === null) return failed(`${response.status}: the substrate answered with a body that is not JSON`);
	if (response.status >= 400 && response.status < 500) return refused(errorText(response.status, json.parsed, json.text));
	if (response.status !== 200) return failed(errorText(response.status, json.parsed, json.text));

	const body = json.parsed;
	if (body === null || typeof body !== "object" || Array.isArray(body)) return failed("the substrate answered 200 without an approval result");
	const record = body as Record<string, unknown>;
	if (
		typeof record.status !== "string" ||
		!APPROVE_STATUSES.has(record.status) ||
		typeof record.state !== "string" ||
		typeof record.name !== "string" ||
		typeof record.pr_number !== "number" ||
		typeof record.content_sha256 !== "string" ||
		typeof record.remaining_approved_for_name !== "number" ||
		(record.pr_url !== null && typeof record.pr_url !== "string" && record.pr_url !== undefined) ||
		(record.merge_sha !== null && typeof record.merge_sha !== "string" && record.merge_sha !== undefined)
	) {
		return failed("the substrate answered 200 without an approval result");
	}
	field("status", record.status);
	field("state", record.state);
	field("name", record.name);
	field("pr_number", record.pr_number);
	field("pr_url", typeof record.pr_url === "string" ? record.pr_url : undefined);
	field("merge_sha", typeof record.merge_sha === "string" ? record.merge_sha : undefined);
	field("content_sha256", record.content_sha256);
	field("remaining_approved_for_name", record.remaining_approved_for_name);
	if (typeof record.noted === "boolean") field("noted", record.noted);
	return 0;
}
