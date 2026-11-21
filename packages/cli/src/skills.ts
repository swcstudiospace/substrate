/**
 * `substrate skills` — propose, list and decide skill-registry rows (SKILL-01).
 *
 *   substrate skills propose --dir PATH [--dir PATH ...] [--glob 'skills/*'] [--name N]
 *       [--rationale R] [--remove a,b] [--session I] [--graph G] [--dry-run] [--json]
 *       [--replace] [--reopen] [--allow-doc-examples pem,jwt]      (operator tokens only)
 *   substrate skills list [--state approved|proposed|declined|retired|all]
 *   substrate skills approve --name N --pr NUMBER --decision approve|decline|retire [--reason R]
 *
 * One `--dir` posts the single proposal body as before; several directories (repeatable
 * `--dir`, or a `--glob` expanded against the working directory) post one
 * `{ proposals: [...] }` body and print every per-item outcome.
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
import { basename, join, relative, resolve } from "node:path";
import { PROPOSE_BATCH_MAX, type ProposeBatchItem, type ProposeResult } from "../../mcp-server/src/skills/propose.ts";
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

export const USAGE =
	"substrate skills propose --dir PATH [--dir PATH ...] [--glob 'skills/*'] [--name N] [--rationale R] [--remove a,b]\n" +
	"                         [--session I] [--graph G] [--dry-run] [--json]      (single --dir only: --name, --remove)\n" +
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
const KNOWN_FLAGS = new Set(["dir", "glob", "name", "rationale", "remove", "session", "graph", "dry-run", "json", "replace", "reopen", "allow-doc-examples", "surface", "help"]);

function proposeResult(value: unknown): ProposeResult | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.status !== "string" || !PROPOSE_STATUSES.has(record.status)) return null;
	if (typeof record.content_sha256 !== "string" || record.content_sha256.length === 0) return null;
	return value as ProposeResult;
}

const BATCH_STATUSES = new Set([...PROPOSE_STATUSES, "refused", "failed"]);

/** A batch answer: the bare array, or `{ results: [...] }`. Each item names its skill and its outcome. */
function batchResults(value: unknown): ProposeBatchItem[] | null {
	let list: unknown;
	if (Array.isArray(value)) list = value;
	else if (value !== null && typeof value === "object" && Array.isArray((value as Record<string, unknown>).results)) {
		list = (value as Record<string, unknown>).results;
	} else return null;
	for (const entry of list as unknown[]) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
		const record = entry as Record<string, unknown>;
		if (typeof record.name !== "string" || typeof record.status !== "string" || !BATCH_STATUSES.has(record.status)) return null;
		if (record.content_sha256 !== undefined && typeof record.content_sha256 !== "string") return null;
		if (record.diff_patch !== undefined && typeof record.diff_patch !== "string") return null;
		if (record.error !== undefined && typeof record.error !== "string") return null;
		if (record.redactions !== undefined && !Array.isArray(record.redactions)) return null;
	}
	return list as ProposeBatchItem[];
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
		// Raw argv too: `--dir`/`--glob` are repeatable, which parseArgs would collapse to the last value.
		return propose(parseArgs(argv.slice(1)), argv.slice(1), deps);
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

/** Every `--dir`/`--glob` value in order, or the flag whose value is missing. */
function repeatedArgs(raw: string[]): { dirs: string[]; globs: string[]; missing?: string } {
	const dirs: string[] = [];
	const globs: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const token = raw[i];
		if (token !== "--dir" && token !== "--glob") continue;
		const value = raw[i + 1];
		if (value === undefined || value.startsWith("--")) return { dirs, globs, missing: token.slice(2) };
		(token === "--dir" ? dirs : globs).push(value);
		i++;
	}
	return { dirs, globs };
}

function segmentMatches(pattern: string, entry: string): boolean {
	const source = pattern
		.split("")
		.map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
		.join("");
	return new RegExp(`^${source}$`).test(entry);
}

/**
 * A relative `--glob` like `skills/*`, expanded read-only against the working directory:
 * only directories match, sorted and de-duplicated. No `**`, no braces, no `..`.
 */
export function expandGlob(cwd: string, pattern: string): string[] {
	const segments = pattern.split("/");
	if (
		pattern.length === 0 ||
		pattern.startsWith("/") ||
		pattern.includes("\\") ||
		segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
		segments.some((segment) => segment.includes("**"))
	) {
		throw new DirRefused(`--glob takes a relative pattern like skills/*, not ${JSON.stringify(pattern)}`);
	}
	let current = [resolve(cwd)];
	for (const segment of segments) {
		const next: string[] = [];
		for (const base of current) {
			if (segment.includes("*") || segment.includes("?")) {
				let entries: string[];
				try {
					entries = readdirSync(base).sort();
				} catch {
					continue;
				}
				for (const entry of entries) {
					if (!segmentMatches(segment, entry)) continue;
					const path = join(base, entry);
					if (lstatSync(path).isDirectory()) next.push(path);
				}
			} else {
				const path = join(base, segment);
				try {
					if (lstatSync(path).isDirectory()) next.push(path);
				} catch {
					// A segment that does not exist matches nothing.
				}
			}
		}
		current = next;
	}
	return [...new Set(current)].sort();
}

async function propose(args: Args, raw: string[], deps: SkillsDeps): Promise<number> {
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
	const { dirs, globs, missing: repeatedMissing } = repeatedArgs(raw);
	if (repeatedMissing !== undefined) return refused(`--${repeatedMissing} takes a value`);
	// A flag that takes a value with none given parses as `true`; `str` and `list` would
	// silently drop it, posting a live proposal without the removals or identifiers the
	// user asked for. Refuse before a directory is read or anything is posted. `--dir`
	// and `--glob` are repeatable, so their missing-value check ran on the raw argv above.
	const missing = ["name", "rationale", "remove", "session", "graph"].find((key) => args[key] === true);
	if (missing !== undefined) return refused(`--${missing} takes a value`);
	if (dirs.length === 0 && globs.length === 0) return refused("--dir PATH is required (repeatable, or --glob PATTERN)");
	if (!deps.token) {
		return refused("SUBSTRATE_TOKEN is not set; skills propose needs an authenticated surface, and nothing was posted");
	}

	const picked: Array<{ dirArg: string; dir: string }> = dirs.map((dirArg) => ({ dirArg, dir: resolve(deps.cwd, dirArg) }));
	for (const pattern of globs) {
		let matched: string[];
		try {
			matched = expandGlob(deps.cwd, pattern);
		} catch (cause) {
			return refused(cause instanceof DirRefused ? cause.message : `cannot expand --glob ${pattern}: ${(cause as Error).message}`);
		}
		if (matched.length === 0) return refused(`--glob ${JSON.stringify(pattern)} matched no directories`);
		for (const dir of matched) picked.push({ dirArg: relative(deps.cwd, dir) || dir, dir });
	}
	const seenDirs = new Set<string>();
	const unique = picked.filter(({ dir }) => {
		if (seenDirs.has(dir)) return false;
		seenDirs.add(dir);
		return true;
	});
	if (unique.length > PROPOSE_BATCH_MAX) {
		return refused(`--dir/--glob may name at most ${PROPOSE_BATCH_MAX} directories, not ${unique.length}`);
	}
	const single = unique.length === 1;
	if (!single && args.name !== undefined) return refused("--name applies to a single --dir; with several directories each skill takes its directory's name");
	if (!single && args.remove !== undefined) return refused("--remove applies to a single --dir");

	// Every directory is read before anything is posted: one bad directory refuses the batch.
	const entries: Array<{ dirArg: string; dir: string; name: string; files: Record<string, string> }> = [];
	const seenNames = new Map<string, string>();
	for (const { dirArg, dir } of unique) {
		const name = basename(dir);
		const earlier = seenNames.get(name);
		if (earlier !== undefined) return refused(`duplicate skill name ${JSON.stringify(name)} from ${earlier} and ${dirArg}`);
		seenNames.set(name, dirArg);
		try {
			const stat = lstatSync(dir);
			if (stat.isSymbolicLink()) return refused(`${dirArg} is a symlink`);
			if (!stat.isDirectory()) return refused(`${dirArg} is not a directory`);
			entries.push({ dirArg, dir, name, files: readSkillDir(dir) });
		} catch (cause) {
			return refused(cause instanceof DirRefused ? cause.message : `cannot read ${dirArg}: ${(cause as Error).message}`);
		}
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
	const rationale = str(args.rationale);
	const shared = {
		...(args["dry-run"] !== undefined ? { dry_run: true } : {}),
		...(args.replace !== undefined ? { mode: "replace" } : {}),
		...(args.reopen !== undefined ? { reopen: true } : {}),
		...(allow ? { allow_doc_examples: allow } : {}),
	};
	// The keys are the route's snake_case ones, and no `surface` is ever sent. One directory
	// posts the single shape as before; several post `{ proposals: [...] }` with shared flags
	// at the top level and each directory's name, files and rationale per item.
	const proposals = entries.map((entry) => ({
		name: entry.name,
		files: entry.files,
		rationale: rationale ?? `substrate skills propose --dir ${entry.name}`,
		...(session ? { session_id: session } : {}),
		...(graph ? { graph_id: graph } : {}),
	}));
	const body = single
		? {
				name: str(args.name) ?? proposals[0]?.name ?? "",
				files: proposals[0]?.files ?? {},
				rationale: proposals[0]?.rationale ?? "",
				...(remove ? { remove } : {}),
				...(session ? { session_id: session } : {}),
				...(graph ? { graph_id: graph } : {}),
				...shared,
			}
		: { proposals, ...shared };
	const payload = JSON.stringify(body);
	const size = Buffer.byteLength(payload, "utf8");
	if (single) {
		if (size > MAX_BODY_BYTES) {
			return refused(`the proposal is ${size} bytes as JSON, over the limit of ${MAX_BODY_BYTES} bytes`);
		}
	} else {
		// The route's per-item cap, plus the batch's total: MAX_BODY_BYTES per proposal.
		for (const proposal of proposals) {
			const itemSize = Buffer.byteLength(JSON.stringify(proposal), "utf8");
			if (itemSize > MAX_BODY_BYTES) {
				return refused(`the proposal for ${proposal.name} is ${itemSize} bytes as JSON, over the limit of ${MAX_BODY_BYTES} bytes`);
			}
		}
		if (size > MAX_BODY_BYTES * PROPOSE_BATCH_MAX) {
			return refused(`the proposals are ${size} bytes as JSON, over the limit of ${MAX_BODY_BYTES * PROPOSE_BATCH_MAX} bytes`);
		}
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
		if (args.json !== undefined) {
			// The whole answer as JSON: one result, or the batch array. Still validated first.
			if (single) {
				if (proposeResult(parsed) === null) return failed(`the substrate answered 200 without a proposal result`);
			} else if (batchResults(parsed) === null) return failed(`the substrate answered 200 without a batch result`);
			deps.out(`${JSON.stringify(parsed ?? null, null, 2)}\n`);
			if (single) return 0;
			const items = batchResults(parsed) ?? [];
			return items.every((item) => PROPOSE_STATUSES.has(item.status) && item.error === undefined) ? 0 : 1;
		}
		if (single) {
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
			if (typeof result.diff_patch === "string" && result.diff_patch.length > 0) deps.out(result.diff_patch + (result.diff_patch.endsWith("\n") ? "" : "\n"));
			return 0;
		}
		const items = batchResults(parsed);
		if (items === null) return failed(`the substrate answered 200 without a batch result`);
		let allOk = true;
		for (const item of items) {
			field("name", item.name);
			field("status", item.status);
			field("pr_url", item.pr_url);
			field("pr_number", item.pr_number);
			field("branch", item.branch);
			field("content_sha256", item.content_sha256);
			field("redactions", Array.isArray(item.redactions) ? item.redactions.length : 0);
			field("diff_added", item.diff_added);
			field("diff_changed", item.diff_changed);
			field("diff_deleted", item.diff_deleted);
			if (item.error !== undefined) field("error", item.error);
			if (typeof item.diff_patch === "string" && item.diff_patch.length > 0) deps.out(item.diff_patch + (item.diff_patch.endsWith("\n") ? "" : "\n"));
			if (item.error !== undefined || !PROPOSE_STATUSES.has(item.status)) allOk = false;
		}
		if (!allOk) deps.err("[substrate] skills propose: one or more proposals were refused or failed\n");
		return allOk ? 0 : 1;
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
