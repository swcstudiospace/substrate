/**
 * `substrate memory capsule export|verify|redact` (v1.6, phase 60): the operator's door to memory capsules.
 *
 *   substrate memory capsule export --out FILE [--session S] [--repo R] [--since ISO] [--limit N] [--store DIR] [--surface S]
 *   substrate memory capsule verify FILE [--anchors] [--surface S]
 *   substrate memory capsule redact FILE --ids a,b --reason TEXT --out FILE2 [--surface S]
 *
 * Exit codes: 0 done, 1 failed (an invalid capsule, a mismatch, an export that is incomplete or could not be
 * written, a server that did not answer an export), 2 usage, 3 `verify --anchors` could not finish the live
 * check (the server did not answer, or refused a lookup) so the anchors cannot be claimed.
 *
 * Export reads memory through the substrate's own `memory_search` MCP tool, exactly as `substrate lessons` does:
 * the server decides what the caller (its token's surface) may read, so a capsule never holds more than a
 * `memory_search` would show that caller. Pages are bounded (100 entries, at most `MAX_SCANNED_ENTRIES` examined)
 * and the records are capped (`--limit`, default `DEFAULT_LIMIT`, at most `MAX_LIMIT`). The conversion to
 * capsule records and the capsule bytes are the nexus modules' (`memory-record.ts`, `capsule.ts`); a forgotten
 * entry is exported as a tombstone, never as content. Nothing here reaches a store: no SQL, no plane, no ledger
 * client; the ledger note goes through the same event path `substrate emit` uses.
 *
 * Files: an export or a redaction creates its output with exclusive create and mode 0600 and never overwrites
 * (an existing path is refused), and never edits the input. `--store DIR` also puts the capsule into a local
 * content-addressed store; no object-storage bucket is ever touched from here.
 *
 * The ledger note (`memory.capsule.export` / `memory.capsule.redact`) is fail-open: a capsule that was written
 * stays written, and the output says plainly when the note was NOT recorded.
 */
import * as nodeFs from "node:fs/promises";
import { resolve } from "node:path";
import type { EmitOutcome } from "../../collectors/src/emit.ts";
import { redact } from "../../mcp-server/src/redact.ts";
import { normalizeIdentifier } from "../../mcp-server/src/event.ts";
import { isForgottenMarker, toCapsuleRecord, type CapsuleRecord } from "../../mcp-server/src/memory-record.ts";
import {
	CapsuleError,
	MAX_CAPSULE_BYTES,
	capsuleExportEvent,
	capsuleRedactEvent,
	exportCapsule,
	importCapsule,
	isTombstone,
	parseCapsuleRecord,
	sha256Bytes,
	tombstoneCapsule,
	type CapsuleEntry,
	type CapsuleEventDraft,
	type CapsuleEventPayload,
	type CapsuleOutput,
	type RedactedCapsule,
} from "../../mcp-server/src/capsule.ts";
import type { BlobStore } from "../../mcp-server/src/blob-store.ts";
import { VERIFY_STATUSES, type VerifyStatus } from "../../mcp-server/src/memory-verify.ts";
import { ACTORS, SURFACES, TRUST_LEVELS, type Actor, type EventInput, type MemoryEntry, type Trust } from "../../mcp-server/src/types.ts";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Records an export holds when `--limit` is not given. */
export const DEFAULT_LIMIT = 1000;
/** The most records `--limit` may ask for: a CLI export is a bounded read, far below the capsule format's own ceiling. */
export const MAX_LIMIT = 10_000;
/** `memory_search`'s own page ceiling. */
export const PAGE_SIZE = 100;
/** Entries examined across all pages, whatever the filters; past it the export stops and says so. */
export const MAX_SCANNED_ENTRIES = 50_000;
/** Records `verify --anchors` looks up. */
export const MAX_ANCHOR_SAMPLE = 50;
/** Ids one `redact` may name. */
export const MAX_REDACT_IDS = 1000;
/** The capsule `producer` the CLI stamps. */
export const CAPSULE_PRODUCER = "substrate-cli";
/** A cursor later than any entry: the way to page a plain query from the top (`memory_search`'s own description). */
const FAR_FUTURE = "9999-12-31T23:59:59Z";
const FILE_MODE = 0o600;
const DEFAULT_SURFACE = "claude-code";
const MAX_FILTER_CHARS = 200;
const MAX_DETAIL = 200;

export const CAPSULE_USAGE =
	"usage: substrate memory capsule export --out FILE [--session S] [--repo R] [--since ISO] [--limit N] [--store DIR] [--surface S]\n" +
	"       substrate memory capsule verify FILE [--anchors] [--surface S]\n" +
	"       substrate memory capsule redact FILE --ids a,b --reason TEXT --out FILE2 [--surface S]\n" +
	`  export   writes a capsule of the memory entries this caller can read (newest first, at most --limit, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT});\n` +
	"           --session and --repo narrow by the entry's own session and repo; --store also puts it in a local content-addressed store\n" +
	"  verify   checks the whole capsule offline (manifest, record hashes, Merkle root); --anchors then looks up to " +
	`${MAX_ANCHOR_SAMPLE} sampled records through the memory_verify tool\n` +
	"  redact   replaces the named records with tombstones (the content is gone, the hash stays) and writes a new file\n" +
	"  --out never overwrites an existing file and is created mode 0600; the input is never edited\n" +
	"exit: 0 done, 1 failed or incomplete, 2 usage, 3 verify --anchors could not finish the live check\n";

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

export class CapsuleUsageError extends Error {}

export interface ExportArgs {
	command: "export";
	out: string;
	session: string | null;
	repo: string | null;
	since: string | null;
	limit: number;
	store: string | null;
	surface: string;
}

export interface VerifyArgs {
	command: "verify";
	file: string;
	anchors: boolean;
	surface: string;
}

export interface RedactArgs {
	command: "redact";
	file: string;
	ids: string[];
	reason: string;
	out: string;
	surface: string;
}

export type CapsuleArgs = ExportArgs | VerifyArgs | RedactArgs;

const FLAGS = {
	export: { bool: [], value: ["out", "session", "repo", "since", "limit", "store", "surface"] },
	verify: { bool: ["anchors"], value: ["surface"] },
	redact: { bool: [], value: ["ids", "reason", "out", "surface"] },
} as const;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
// Control characters are refused in every operator-typed value.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects C0 and DEL control characters in operator-typed values
const CONTROL = /[\u0000-\u001f\u007f]/;

function checkText(flag: string, value: string, max: number): string {
	if (value.length === 0 || value.length > max || CONTROL.test(value)) {
		throw new CapsuleUsageError(`${flag} needs 1 to ${max} printable characters`);
	}
	return value;
}

/**
 * Strict: the flags of the subcommand only, each at most once, a value flag always followed by its value (never
 * `--out=F`), `verify` and `redact` take exactly one file as their first word and nothing else positional.
 * `argv` is everything after `memory capsule`.
 */
export function parseCapsuleArgs(argv: readonly string[]): CapsuleArgs {
	const command = argv[0];
	if (command !== "export" && command !== "verify" && command !== "redact") {
		throw new CapsuleUsageError(command === undefined ? "a subcommand is needed: export, verify or redact" : `unknown subcommand "${command.slice(0, 40)}"`);
	}
	const allowed = FLAGS[command];
	let file: string | null = null;
	let start = 1;
	if (command !== "export") {
		const first = argv[1];
		if (first === undefined || first.startsWith("--")) throw new CapsuleUsageError(`${command} needs the capsule FILE as its first argument`);
		file = checkText("FILE", first, 4096);
		start = 2;
	}
	const bools = new Set<string>();
	const values = new Map<string, string>();
	for (let i = start; i < argv.length; i++) {
		const word = argv[i] ?? "";
		if (!word.startsWith("--")) throw new CapsuleUsageError(`unexpected argument "${word.slice(0, 40)}"`);
		const name = word.slice(2);
		if ((allowed.bool as readonly string[]).includes(name)) {
			if (bools.has(name)) throw new CapsuleUsageError(`--${name} given twice`);
			bools.add(name);
			continue;
		}
		if ((allowed.value as readonly string[]).includes(name)) {
			if (values.has(name)) throw new CapsuleUsageError(`--${name} given twice`);
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) throw new CapsuleUsageError(`--${name} needs a value`);
			values.set(name, value);
			i += 1;
			continue;
		}
		throw new CapsuleUsageError(`unknown flag "${word.slice(0, 40)}" for ${command} (a value flag takes its value as the next argument)`);
	}

	const surface = values.get("surface") ?? DEFAULT_SURFACE;
	if (!(SURFACES as readonly string[]).includes(surface)) throw new CapsuleUsageError(`--surface ${JSON.stringify(surface.slice(0, 40))} is not a known surface`);
	const need = (name: string): string => {
		const value = values.get(name);
		if (value === undefined) throw new CapsuleUsageError(`--${name} is required`);
		return checkText(`--${name}`, value, 4096);
	};
	const optional = (name: string, max: number): string | null => {
		const value = values.get(name);
		return value === undefined ? null : checkText(`--${name}`, value, max);
	};

	if (command === "verify") return { command, file: file as string, anchors: bools.has("anchors"), surface };
	if (command === "redact") {
		const ids = [...new Set(need("ids").split(",").map((id) => id.trim()).filter((id) => id.length > 0))];
		if (ids.length === 0) throw new CapsuleUsageError("--ids needs at least one record id (a,b,c)");
		if (ids.length > MAX_REDACT_IDS) throw new CapsuleUsageError(`--ids names ${ids.length} records; at most ${MAX_REDACT_IDS} per redaction`);
		return { command, file: file as string, ids, reason: checkText("--reason", need("reason"), 200), out: need("out"), surface };
	}

	const limitRaw = values.get("limit");
	let limit = DEFAULT_LIMIT;
	if (limitRaw !== undefined) {
		if (!/^[1-9]\d{0,9}$/.test(limitRaw) || Number(limitRaw) > MAX_LIMIT) throw new CapsuleUsageError(`--limit needs an integer from 1 to ${MAX_LIMIT}`);
		limit = Number(limitRaw);
	}
	const sinceRaw = optional("since", 64);
	let since: string | null = null;
	if (sinceRaw !== null) {
		const parsed = Date.parse(sinceRaw);
		if (!ISO_INSTANT.test(sinceRaw) || Number.isNaN(parsed)) {
			throw new CapsuleUsageError("--since needs an ISO instant with a time and a zone, e.g. 2026-10-01T00:00:00Z");
		}
		since = new Date(parsed).toISOString();
	}
	return { command, out: need("out"), session: optional("session", MAX_FILTER_CHARS), repo: optional("repo", MAX_FILTER_CHARS), since, limit, store: optional("store", 4096), surface };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The two substrate MCP tools this command calls. */
export interface CapsuleMcp {
	/** One `tools/call`; the tool's JSON reply. Throws `CapsuleMcpError`. */
	call(tool: "memory_search" | "memory_verify", args: Record<string, unknown>): Promise<unknown>;
}

export type CapsuleMcpErrorKind = "unreachable" | "refused" | "invalid";

/** `unreachable`: the server did not answer. `refused`: it answered with a refusal. `invalid`: it answered something that is not the contract. */
export class CapsuleMcpError extends Error {
	readonly kind: CapsuleMcpErrorKind;
	constructor(kind: CapsuleMcpErrorKind, message: string) {
		super(message);
		this.name = "CapsuleMcpError";
		this.kind = kind;
	}
}

export interface CapsuleFs {
	/** The whole file, refusing (throwing) a file larger than `maxBytes` or one that is not a regular file. */
	readBytes(path: string, maxBytes: number): Promise<Uint8Array>;
	exists(path: string): Promise<boolean>;
	/** Create a NEW file with `mode`. Exclusive: an existing path throws (EEXIST) and is never touched. */
	writeNew(path: string, bytes: Uint8Array, mode: number): Promise<void>;
}

export interface CapsuleDeps {
	mcpFor: (surface: string) => CapsuleMcp;
	fs: CapsuleFs;
	/** A local content-addressed store rooted at an absolute directory. */
	openStore: (absoluteDir: string) => BlobStore;
	/** The CLI's event path (`postEvent`). Never throws. */
	emit: (event: EventInput) => Promise<EmitOutcome>;
	now: () => Date;
	cwd: string;
	out: (text: string) => void;
	err: (text: string) => void;
}

// ---------------------------------------------------------------------------
// MCP over HTTP (the `substrate lessons` call shape)
// ---------------------------------------------------------------------------

export interface HttpCapsuleMcpConnection {
	url: string;
	token?: string | undefined;
	timeoutMs: number;
	/** Injected so a test never touches the network. Default: the global `fetch`. */
	fetchImpl?: typeof fetch;
}

function diagnostic(value: string): string {
	return redact(value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[url]")).slice(0, MAX_DETAIL);
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * One JSON-RPC `tools/call` POSTed to `/mcp`, which the server answers statelessly with no handshake, as plain
 * JSON or one SSE `data:` line (as `lessons.ts` calls `memory_search`). A diagnostic never names the URL.
 */
export function httpCapsuleMcp(connection: HttpCapsuleMcpConnection): CapsuleMcp {
	const base = connection.url.replace(/\/+$/, "");
	const doFetch = connection.fetchImpl ?? fetch;
	const headers = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}),
	};
	// A refusal or a failure may echo the endpoint or the token; neither may reach an operator's terminal or a log.
	const secrets = [connection.token, base].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
	const safe = (value: string): string => diagnostic(secrets.reduce((cleaned, secret) => cleaned.split(secret).join("[redacted]"), value));
	return {
		async call(tool, args) {
			let status: number;
			let text: string;
			try {
				const response = await doFetch(`${base}/mcp`, {
					method: "POST",
					headers,
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
					signal: AbortSignal.timeout(connection.timeoutMs),
				});
				status = response.status;
				text = await response.text();
			} catch (cause) {
				throw new CapsuleMcpError("unreachable", `the substrate did not answer ${tool}: ${safe(messageOf(cause))}`);
			}
			const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? text;
			let envelope: unknown;
			try {
				envelope = JSON.parse(data);
			} catch {
				throw new CapsuleMcpError("invalid", `${tool} answered HTTP ${status} with no JSON-RPC reply: ${safe(text)}`);
			}
			const result = isRec(envelope) && isRec(envelope.result) ? envelope.result : null;
			if (result === null) {
				const error = isRec(envelope) ? envelope.error : undefined;
				const reason = typeof error === "string" ? error : isRec(error) && typeof error.message === "string" ? error.message : JSON.stringify(envelope);
				throw new CapsuleMcpError("refused", `${tool} answered HTTP ${status}: ${safe(reason)}`);
			}
			const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
			const content = isRec(first) && typeof first.text === "string" ? first.text : "";
			if (result.isError === true) throw new CapsuleMcpError("refused", `${tool} was refused: ${safe(content)}`);
			try {
				return JSON.parse(content) as unknown;
			} catch {
				throw new CapsuleMcpError("invalid", `${tool} answered with a result that is not JSON: ${safe(content)}`);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Reading entries
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A `memory_search` entry as a `MemoryEntry`, or the reason it is not one. Only the fields a capsule record needs
 * are read; every one is checked, none is trusted.
 */
export function entryFromReply(value: unknown): { ok: true; entry: MemoryEntry } | { ok: false; reason: string } {
	if (!isRec(value)) return { ok: false, reason: "not an object" };
	for (const key of ["id", "scope", "kind", "writer", "created"] as const) {
		if (typeof value[key] !== "string" || (value[key] as string).length === 0) return { ok: false, reason: `${key} is missing` };
	}
	if (!(ACTORS as readonly string[]).includes(value.actor as string)) return { ok: false, reason: "actor is missing or unknown" };
	if (!(TRUST_LEVELS as readonly string[]).includes(value.trust as string)) return { ok: false, reason: "trust is missing or unknown" };
	if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) return { ok: false, reason: "version is missing" };
	const supersededBy = optionalString(value.superseded_by);
	// A forgotten entry's body may be gone; it becomes a tombstone and its text is never read.
	const forgotten = isForgottenMarker(supersededBy);
	if (typeof value.text !== "string" && !forgotten) return { ok: false, reason: "text is missing" };
	const entry: MemoryEntry = {
		id: value.id as string,
		scope: value.scope as string,
		kind: value.kind as MemoryEntry["kind"],
		text: typeof value.text === "string" ? value.text : "",
		writer: value.writer as string,
		actor: value.actor as Actor,
		trust: value.trust as Trust,
		ttl: optionalString(value.ttl) ?? "permanent",
		created: value.created as string,
		version: value.version,
		entry_hash: typeof value.entry_hash === "string" ? value.entry_hash : "",
		needs_reverification: value.needs_reverification === true,
		...(optionalString(value.subject) === undefined ? {} : { subject: value.subject as string }),
		...(optionalString(value.source_event) === undefined ? {} : { source_event: value.source_event as string }),
		...(optionalString(value.session_id) === undefined ? {} : { session_id: value.session_id as string }),
		...(optionalString(value.graph_id) === undefined ? {} : { graph_id: value.graph_id as string }),
		...(optionalString(value.repo) === undefined ? {} : { repo: value.repo as string }),
		...(optionalString(value.supersedes) === undefined ? {} : { supersedes: value.supersedes as string }),
		...(supersededBy === undefined ? {} : { superseded_by: supersededBy }),
	};
	return { ok: true, entry };
}

export interface CollectedEntries {
	entries: MemoryEntry[];
	/** Entries the server returned that were not usable, with why (never content). */
	unusable: Array<{ id: string; reason: string }>;
	examined: number;
	/** The export stopped at `--limit` and more entries may exist. */
	truncated: boolean;
	/** The export stopped at `MAX_SCANNED_ENTRIES` examined entries. */
	scanCapped: boolean;
}

interface CollectFilters {
	session: string | null;
	repo: string | null;
	since: string | null;
	limit: number;
}

function filterId(value: string | null): string | null {
	return value === null ? null : (normalizeIdentifier(value) ?? value);
}

/**
 * Page `memory_search` newest first until `limit` entries match the filters, the entries run out, an entry older
 * than `--since` is reached (results are ordered, so the rest is older still) or `MAX_SCANNED_ENTRIES` have been
 * examined. The server filters nothing but visibility, so `--session`, `--repo` and `--since` are applied here
 * to the entry's own fields. Superseded and forgotten entries are asked for: a capsule carries the history.
 */
export async function collectEntries(mcp: CapsuleMcp, filters: CollectFilters): Promise<CollectedEntries> {
	const session = filterId(filters.session);
	const repo = filterId(filters.repo);
	const sinceMs = filters.since === null ? null : Date.parse(filters.since);
	const seen = new Set<string>();
	const entries: MemoryEntry[] = [];
	const unusable: Array<{ id: string; reason: string }> = [];
	let examined = 0;
	let cursor: { before: string; before_id?: string } = { before: FAR_FUTURE };
	let truncated = false;
	let scanCapped = false;

	for (;;) {
		const reply = await mcp.call("memory_search", {
			query: "",
			limit: PAGE_SIZE,
			include_superseded: true,
			...(repo === null ? {} : { repo }),
			before: cursor.before,
			...(cursor.before_id === undefined ? {} : { before_id: cursor.before_id }),
		});
		if (!isRec(reply) || !Array.isArray(reply.entries)) {
			throw new CapsuleMcpError("invalid", "memory_search did not answer a page of entries (an older substrate that cannot page cannot be exported from)");
		}
		let reachedSince = false;
		for (const raw of reply.entries as unknown[]) {
			examined += 1;
			// Filters first, on the raw fields: an entry that is outside them is not "unusable", it is not wanted.
			if (isRec(raw)) {
				if (sinceMs !== null && typeof raw.created === "string" && Date.parse(raw.created) < sinceMs) {
					reachedSince = true;
					continue;
				}
				if (session !== null && raw.session_id !== session) continue;
				if (repo !== null && raw.repo !== repo) continue;
			}
			const parsed = entryFromReply(raw);
			if (!parsed.ok) {
				unusable.push({ id: isRec(raw) && typeof raw.id === "string" ? raw.id.slice(0, 80) : "(no id)", reason: parsed.reason });
				continue;
			}
			const entry = parsed.entry;
			if (seen.has(entry.id)) continue;
			if (entries.length >= filters.limit) {
				truncated = true;
				continue;
			}
			seen.add(entry.id);
			entries.push(entry);
		}
		const next = reply.next;
		if (reachedSince || next === null || next === undefined) break;
		if (!isRec(next) || typeof next.before !== "string" || typeof next.before_id !== "string") {
			throw new CapsuleMcpError("invalid", "memory_search answered a cursor that is not { before, before_id }");
		}
		if (next.before === cursor.before && next.before_id === cursor.before_id) {
			throw new CapsuleMcpError("invalid", "memory_search answered a cursor that does not advance");
		}
		if (entries.length >= filters.limit) {
			truncated = true;
			break;
		}
		if (examined >= MAX_SCANNED_ENTRIES) {
			scanCapped = true;
			break;
		}
		cursor = { before: next.before, before_id: next.before_id };
	}
	return { entries, unusable, examined, truncated, scanCapped };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fail(deps: CapsuleDeps, message: string, code: 1 | 2 | 3 = 1): number {
	deps.err(`${message}\n`);
	return code;
}

function describeCapsuleError(error: CapsuleError): string {
	return `${error.rule}: ${error.message}`;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Record a capsule note through the CLI's event path; fail-open, and say so when it was not recorded. */
async function recordNote(deps: CapsuleDeps, surface: string, draft: CapsuleEventDraft<CapsuleEventPayload>): Promise<string> {
	const outcome = await deps.emit({
		surface: surface as EventInput["surface"],
		kind: draft.kind,
		summary: draft.summary,
		payload: draft.payload as unknown as Record<string, unknown>,
		idempotency_key: draft.idempotency_key,
	});
	const action = draft.payload.action;
	if (outcome.kind === "stored") return `ledger: ${action} note recorded`;
	const why = outcome.kind === "refused" ? `refused (HTTP ${outcome.status}${outcome.error === undefined ? "" : `: ${diagnostic(outcome.error)}`})` : `failed (${outcome.error === undefined ? "no answer" : diagnostic(outcome.error)})${outcome.spooled ? ", parked in the event spool for replay" : ""}`;
	return `ledger: ${action} note NOT RECORDED: ${why}. The capsule file is unaffected; it can be re-announced by re-running the command with a new --out.`;
}

async function createOutput(deps: CapsuleDeps, path: string, bytes: Uint8Array): Promise<string | null> {
	try {
		await deps.fs.writeNew(path, bytes, FILE_MODE);
		return null;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return `${path} already exists; it was not touched. Pick a new --out.`;
		return `could not create ${path}: ${[errorCode(error), diagnostic(messageOf(error))].filter((part) => part !== undefined && part.length > 0).join(": ")}`;
	}
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

async function commandExport(args: ExportArgs, deps: CapsuleDeps): Promise<number> {
	const outPath = resolve(deps.cwd, args.out);
	try {
		if (await deps.fs.exists(outPath)) return fail(deps, `${outPath} already exists; it was not touched. Pick a new --out.`);
	} catch (error) {
		return fail(deps, `could not check ${outPath}: ${diagnostic(messageOf(error))}`);
	}

	let collected: CollectedEntries;
	try {
		collected = await collectEntries(deps.mcpFor(args.surface), { session: args.session, repo: args.repo, since: args.since, limit: args.limit });
	} catch (error) {
		if (error instanceof CapsuleMcpError) return fail(deps, `export failed (${error.kind}): ${error.message}`);
		throw error;
	}

	const records: CapsuleEntry[] = [];
	const skipped: Array<{ id: string; reason: string }> = collected.unusable.map((u) => ({ ...u }));
	for (const entry of collected.entries) {
		if (entry.entry_hash.length === 0) {
			skipped.push({ id: entry.id, reason: "no entry_hash (written before the governance gate)" });
			continue;
		}
		try {
			records.push(parseCapsuleRecord(toCapsuleRecord(entry, { now: deps.now }), `records[${entry.id}]`));
		} catch (error) {
			if (!(error instanceof CapsuleError)) throw error;
			skipped.push({ id: entry.id, reason: describeCapsuleError(error).slice(0, MAX_DETAIL) });
		}
	}
	if (records.length === 0) {
		return fail(
			deps,
			`nothing to export: no entry matched${skipped.length > 0 ? `, and ${skipped.length} could not be made into capsule records` : ""} (examined ${collected.examined})` +
				(collected.scanCapped ? `; the scan stopped at its cap of ${MAX_SCANNED_ENTRIES} entries, so older entries were not looked at` : ""),
		);
	}

	let output: CapsuleOutput;
	try {
		output = exportCapsule(records, { producer: CAPSULE_PRODUCER, now: deps.now });
	} catch (error) {
		if (error instanceof CapsuleError) return fail(deps, `export refused: ${describeCapsuleError(error)}`);
		throw error;
	}

	const writeFailure = await createOutput(deps, outPath, output.bytes);
	if (writeFailure !== null) return fail(deps, writeFailure);

	const lines: string[] = [];
	let code: 0 | 1 = 0;
	if (args.store !== null) {
		const storeDir = resolve(deps.cwd, args.store);
		try {
			const stored = await deps.openStore(storeDir).put(output.bytes);
			if (stored !== output.digest) {
				deps.err(`the store named the capsule ${stored}, not ${output.digest}; the file ${outPath} was written\n`);
				return 1;
			}
			lines.push(`store: ${storeDir} holds ${output.digest}`);
		} catch (error) {
			deps.err(`the capsule was written to ${outPath} (digest ${output.digest}) but the store ${storeDir} failed: ${diagnostic(messageOf(error))}\n`);
			return 1;
		}
	}

	const fullCount = records.filter((record) => !isTombstone(record)).length;
	deps.out(
		[
			`capsule written: ${outPath} (mode 0600)`,
			`digest: ${output.digest}`,
			`records: ${output.manifest.count} (${fullCount} with content, ${output.manifest.count - fullCount} tombstones)`,
			`root_digest: ${output.manifest.root_digest}`,
			`bytes: ${output.bytes.byteLength}`,
			...lines,
			"",
		].join("\n"),
	);
	if (skipped.length > 0) {
		code = 1;
		deps.err(
			`INCOMPLETE: ${skipped.length} entr${skipped.length === 1 ? "y" : "ies"} could not be put in the capsule and ${skipped.length === 1 ? "was" : "were"} left out` +
				` (${skipped.slice(0, 10).map((s) => `${s.id}: ${s.reason}`).join("; ")}${skipped.length > 10 ? "; …" : ""})\n`,
		);
	}
	if (collected.truncated) deps.err(`stopped at --limit ${args.limit}: more matching entries may exist. Raise --limit (max ${MAX_LIMIT}) or narrow with --since.\n`);
	if (collected.scanCapped) deps.err(`stopped after examining ${collected.examined} entries (the scan cap is ${MAX_SCANNED_ENTRIES}): older entries were not looked at. Narrow with --since.\n`);
	deps.out(`${await recordNote(deps, args.surface, capsuleExportEvent(output))}\n`);
	return code;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/** Up to `max` indexes spread evenly over `count` items, in order; all of them when `count <= max`. Deterministic. */
export function sampleIndexes(count: number, max: number): number[] {
	if (count <= max) return Array.from({ length: count }, (_, i) => i);
	return Array.from({ length: max }, (_, i) => Math.floor((i * count) / max));
}

interface AnchorLine {
	id: string;
	status: VerifyStatus | "capsule-differs" | "unavailable";
	note?: string;
}

async function checkAnchors(args: VerifyArgs, deps: CapsuleDeps, records: readonly CapsuleEntry[]): Promise<{ lines: AnchorLine[]; sampled: number; full: number }> {
	const full = records.filter((record): record is CapsuleRecord => !isTombstone(record));
	const sample = sampleIndexes(full.length, MAX_ANCHOR_SAMPLE).map((i) => full[i] as CapsuleRecord);
	const mcp = deps.mcpFor(args.surface);
	const lines: AnchorLine[] = [];
	for (const record of sample) {
		try {
			const reply = await mcp.call("memory_verify", { id: record.id, ...(record.provenance.repo === null ? {} : { repo: record.provenance.repo }) });
			if (!isRec(reply) || typeof reply.status !== "string" || !(VERIFY_STATUSES as readonly string[]).includes(reply.status)) {
				lines.push({ id: record.id, status: "unavailable", note: "the reply was not a memory_verify verdict" });
				continue;
			}
			const status = reply.status as VerifyStatus;
			if (typeof reply.content_hash === "string" && reply.content_hash.length > 0 && reply.content_hash !== record.content_hash) {
				lines.push({ id: record.id, status: "capsule-differs", note: `the live entry's hash differs from the capsule's (live status ${status})` });
				continue;
			}
			lines.push({ id: record.id, status });
		} catch (error) {
			if (!(error instanceof CapsuleMcpError)) throw error;
			lines.push({ id: record.id, status: "unavailable", note: `${error.kind}: ${error.message}`.slice(0, MAX_DETAIL) });
		}
	}
	return { lines, sampled: sample.length, full: full.length };
}

async function commandVerify(args: VerifyArgs, deps: CapsuleDeps): Promise<number> {
	const path = resolve(deps.cwd, args.file);
	let bytes: Uint8Array;
	try {
		bytes = await deps.fs.readBytes(path, MAX_CAPSULE_BYTES);
	} catch (error) {
		return fail(deps, `could not read ${path}: ${diagnostic(messageOf(error))}`);
	}
	const imported = importCapsule(bytes);
	if (!imported.ok) return fail(deps, `capsule INVALID: ${describeCapsuleError(imported.error)}`);
	const { capsule } = imported;
	const tombstones = capsule.records.filter(isTombstone).length;
	const header = [
		`capsule ok: ${path}`,
		`digest: ${capsule.digest}`,
		`schema: ${capsule.manifest.schema}  producer: ${capsule.manifest.producer}  created_at: ${capsule.manifest.created_at}`,
		`records: ${capsule.manifest.count} (${capsule.manifest.count - tombstones} with content, ${tombstones} tombstones)`,
		`root_digest: ${capsule.manifest.root_digest}`,
		"checked: manifest, records_sha256, every record's canonical form, every content hash, the Merkle root.",
		"not checked: who wrote the file (the manifest is not signed). Compare the digest with the memory.capsule.export note in the ledger.",
	];
	if (!args.anchors) {
		deps.out(`${header.join("\n")}\n`);
		return 0;
	}

	const anchors = await checkAnchors(args, deps, capsule.records);
	if (anchors.full === 0) {
		deps.out(`${[...header, "anchors: no record with content to look up"].join("\n")}\n`);
		return 0;
	}
	const tally = new Map<string, number>();
	for (const line of anchors.lines) tally.set(line.status, (tally.get(line.status) ?? 0) + 1);
	const out = [
		...header,
		`anchors: looked up ${anchors.sampled} of ${anchors.full} records with content through memory_verify (evenly spaced, at most ${MAX_ANCHOR_SAMPLE})`,
		...anchors.lines.map((line) => `  ${line.id}  ${line.status}${line.note === undefined ? "" : `  (${line.note})`}`),
		`tally: ${[...tally.entries()].map(([status, count]) => `${status} ${count}`).join(", ")}`,
		"A verified status says the stored hash is intact and the cited ledger event is inside an anchored root; it does not prove that event concerns the entry.",
	];
	deps.out(`${out.join("\n")}\n`);
	const bad = anchors.lines.some((line) => line.status === "hash-mismatch" || line.status === "anchor-mismatch" || line.status === "capsule-differs");
	if (bad) return fail(deps, "anchor check FAILED: at least one record does not match the live substrate (see the statuses above)");
	if (anchors.lines.some((line) => line.status === "unavailable")) {
		return fail(deps, "anchor check INCOMPLETE: at least one lookup could not be completed, so the anchors cannot be claimed", 3);
	}
	return 0;
}

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------

async function commandRedact(args: RedactArgs, deps: CapsuleDeps): Promise<number> {
	const inPath = resolve(deps.cwd, args.file);
	const outPath = resolve(deps.cwd, args.out);
	if (inPath === outPath) return fail(deps, "--out must be a different file from the input: a capsule is never edited in place", 2);
	let bytes: Uint8Array;
	try {
		bytes = await deps.fs.readBytes(inPath, MAX_CAPSULE_BYTES);
	} catch (error) {
		return fail(deps, `could not read ${inPath}: ${diagnostic(messageOf(error))}`);
	}
	let result: RedactedCapsule;
	try {
		result = tombstoneCapsule(bytes, args.ids, args.reason, deps.now);
	} catch (error) {
		if (error instanceof CapsuleError) return fail(deps, `redaction refused: ${describeCapsuleError(error)}`);
		throw error;
	}
	if (result.redacted.length === 0) {
		deps.out("nothing to redact: every named record is already a tombstone. No file was written and no note was recorded.\n");
		return 0;
	}
	const digestBefore = sha256Bytes(bytes);
	const writeFailure = await createOutput(deps, outPath, result.bytes);
	if (writeFailure !== null) return fail(deps, writeFailure);
	deps.out(
		[
			`capsule redacted: ${outPath} (mode 0600); the input ${inPath} was not changed`,
			`redacted: ${result.redacted.length} record${result.redacted.length === 1 ? "" : "s"} (${result.redacted.slice(0, 20).join(", ")}${result.redacted.length > 20 ? ", …" : ""})`,
			`digest before: ${digestBefore}`,
			`digest after:  ${result.digest}`,
			`root_digest: ${result.manifest.root_digest} (unchanged: the hashes stay, the content is gone)`,
			"This redacts THIS file only. Copies of the original, and the live index, are not touched.",
			"",
		].join("\n"),
	);
	deps.out(`${await recordNote(deps, args.surface, capsuleRedactEvent(digestBefore, args.reason, result))}\n`);
	return 0;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/** `substrate memory …`: only `memory capsule …` exists. `argv` is everything after `memory`. */
export async function runMemory(argv: readonly string[], deps: CapsuleDeps): Promise<number> {
	if (argv[0] !== "capsule") {
		deps.err(`${argv[0] === undefined ? "a memory subcommand is needed" : `unknown memory subcommand "${argv[0].slice(0, 40)}"`}\n${CAPSULE_USAGE}`);
		return 2;
	}
	let args: CapsuleArgs;
	try {
		args = parseCapsuleArgs(argv.slice(1));
	} catch (error) {
		if (error instanceof CapsuleUsageError) {
			deps.err(`${error.message}\n${CAPSULE_USAGE}`);
			return 2;
		}
		throw error;
	}
	switch (args.command) {
		case "export":
			return commandExport(args, deps);
		case "verify":
			return commandVerify(args, deps);
		case "redact":
			return commandRedact(args, deps);
	}
}

// ---------------------------------------------------------------------------
// The real filesystem
// ---------------------------------------------------------------------------

/**
 * The real `CapsuleFs`. `writeNew` opens with `wx` (exclusive create, never overwrites, never follows a symlink
 * into an existing file) and mode 0600; a write that fails part-way removes the partial file it created. A
 * process killed mid-write can leave a truncated capsule, which `verify` refuses (its `records_sha256` fails).
 */
export function nodeCapsuleFs(): CapsuleFs {
	const fs = nodeFs; // the module namespace, named for the short calls below
	return {
		async readBytes(path, maxBytes) {
			const info = await fs.lstat(path);
			if (!info.isFile()) throw new Error("not a regular file");
			if (info.size > maxBytes) throw new Error(`the file is ${info.size} bytes; the limit is ${maxBytes}`);
			return new Uint8Array(await fs.readFile(path));
		},
		async exists(path) {
			try {
				await fs.lstat(path);
				return true;
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
				throw error;
			}
		},
		async writeNew(path, bytes, mode) {
			const handle = await fs.open(path, "wx", mode);
			try {
				await handle.writeFile(bytes);
			} catch (error) {
				await handle.close();
				// Best effort: the write error is the one reported, and a partial file that could not be removed fails `verify`.
				await fs.unlink(path).catch(() => undefined);
				throw error;
			}
			await handle.close();
		},
	};
}
