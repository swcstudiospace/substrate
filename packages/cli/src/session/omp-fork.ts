/**
 * omp session fork and transcript reference (v1.6, phase 61, unit c).
 *
 * A rollback to a chat moment has to record WHERE in the omp transcript the checkpoint was taken and let the
 * operator continue from that moment. An external tool cannot move omp's live leaf: the format has no
 * persisted leaf field ("loading rebuilds the leaf from the last physical entry", omp://session.md, "Tree and
 * Leaf Semantics"), so the leaf is runtime state. The safe operation is a FORK: write a NEW session file that
 * holds only the root-to-target path of entries, so the target is the last physical entry and therefore the
 * leaf when omp loads it. The original file is never touched. This mirrors omp's own
 * `createBranchedSession(leafId)` ("a new identity containing only the selected root-to-leaf path").
 *
 * Pure: text in, text out. No filesystem, no clock, no randomness; the caller injects the clock and the new id.
 *
 * omp format facts relied on (omp://session.md):
 *  - "File Format": JSONL; current files begin with a fixed-width 256-byte (newline included) `type:"title"`
 *    slot, then the `type:"session"` header, then entries. Legacy files begin directly with the header.
 *  - "Header": `version` 3, string `id`, `timestamp`, `cwd`, optional `title`/`titleSource`,
 *    `additionalDirectories`, `previousSessionFiles`, `providerPromptCacheKey`, `parentSession` (an opaque
 *    lineage string, metadata and not a typed foreign key).
 *  - "Entry Base": every non-header entry has `type`, `id`, `parentId` (string, or null for a root) and
 *    `timestamp`. Ids are normally eight hex characters but consumers must not assume a width.
 *  - "Tree and Leaf Semantics": no persisted leaf; the leaf is the last physical entry on load. A branched
 *    session keeps only the selected root-to-leaf path.
 *  - "Versioning and Migration": current version 3; older files are migrated (and rewritten) by omp on load.
 *    This module refuses them rather than guess at a migration.
 *  - "Load and Compatibility Behavior": omp's own loader skips malformed lines; this parser is strict instead.
 *
 * The title slot's own layout (`{"type":"title","v":1,"title":...,"source":...,"updatedAt":...,"pad":"   "}`
 * padded with spaces to 256 bytes) was read from the shape of a real session file, not from the document.
 */
import { createHash } from "node:crypto";
import { parseTranscriptRef, SessionEventError, type TranscriptRef } from "../../../mcp-server/src/session-events.ts";

/** The only omp session version this module reads and writes (omp://session.md, "Versioning and Migration"). */
const OMP_SESSION_VERSION = 3;
/** The fixed width, in bytes and newline included, of the `type:"title"` slot. */
export const OMP_TITLE_SLOT_BYTES = 256;
/** Hard cap on the session text this module will parse or fork: 32 MiB. */
export const OMP_SESSION_MAX_BYTES = 32 * 1024 * 1024;
/** Canonicalisation depth cap, so a hostile deeply nested entry is a typed error and not a stack overflow. */
const MAX_CANONICAL_DEPTH = 512;

const OMP_FORK_ERROR_CODES = [
	"entry-not-found",
	"chain-broken",
	"header-invalid",
	"malformed-line",
	"too-large",
	"prefix-mismatch",
	"unsupported-version",
	"invalid-argument",
] as const;
type OmpForkErrorCode = (typeof OMP_FORK_ERROR_CODES)[number];

/** `detail` never carries session content: only codes, counts and 1-based line numbers. */
export class OmpForkError extends Error {
	readonly code: OmpForkErrorCode;
	readonly line?: number;
	readonly detail: string;
	constructor(code: OmpForkErrorCode, detail: string, line?: number) {
		super(line === undefined ? `${code}: ${detail}` : `${code}: ${detail} (line ${line})`);
		this.name = "OmpForkError";
		this.code = code;
		this.detail = detail;
		if (line !== undefined) this.line = line;
	}
}

interface OmpForkFailure {
	ok: false;
	code: OmpForkErrorCode;
	detail: string;
	line?: number;
}

type Rec = Record<string, unknown>;

interface OmpSessionEntry {
	id: string;
	parentId: string | null;
	type: string;
	/** The line exactly as it appears in the file (no trailing newline). Forked files copy it byte for byte. */
	raw: string;
	/** 1-based physical line number. */
	line: number;
	value: Rec;
}

interface OmpSession {
	header: Rec;
	headerLine: number;
	/** The slot's current title and source, or null for a legacy file with no slot. */
	titleSlot: { title: string; source?: "auto" | "user" } | null;
	/** Non-header entries in file order. */
	entries: OmpSessionEntry[];
	byId: ReadonlyMap<string, number>;
}

const OPAQUE_ID = /^[A-Za-z0-9._:-]+$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		// The parser's message can quote the offending text, so it is dropped on purpose: errors carry no content.
		return undefined;
	}
}

/**
 * Strictly parse an omp session file. Throws `OmpForkError`. Unlike omp's own lenient loader this rejects any
 * malformed line, so a forked file can never silently drop a record.
 */
export function parseOmpSession(text: string, maxBytes: number = OMP_SESSION_MAX_BYTES): OmpSession {
	if (typeof text !== "string") throw new OmpForkError("invalid-argument", "sessionFileText must be a string");
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new OmpForkError("invalid-argument", "maxBytes must be a positive integer");
	if (text.length > maxBytes || Buffer.byteLength(text, "utf8") > maxBytes) {
		throw new OmpForkError("too-large", `session file exceeds the ${maxBytes} byte cap`);
	}
	if (text.length === 0) throw new OmpForkError("header-invalid", "session file is empty");

	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();

	let index = 0;
	let titleSlot: OmpSession["titleSlot"] = null;
	const first = parseLine(lines[0] ?? "");
	if (isRec(first) && first["type"] === "title") {
		if (Buffer.byteLength(lines[0] ?? "", "utf8") + 1 !== OMP_TITLE_SLOT_BYTES) {
			throw new OmpForkError("header-invalid", `title slot is not ${OMP_TITLE_SLOT_BYTES} bytes wide`, 1);
		}
		const title = first["title"];
		const source = first["source"];
		// omp itself treats a slot that fails these checks as a legacy header, which would make the next line an
		// invalid entry; refusing here names the real problem.
		if (first["v"] !== 1 || typeof title !== "string" || typeof first["updatedAt"] !== "string" || typeof first["pad"] !== "string") {
			throw new OmpForkError("header-invalid", "title slot is not a version 1 slot with string title, updatedAt and pad", 1);
		}
		if (source !== undefined && source !== "auto" && source !== "user") {
			throw new OmpForkError("header-invalid", "title slot source is not auto or user", 1);
		}
		titleSlot = { title, ...(source === undefined ? {} : { source }) };
		index = 1;
	}

	const headerRaw = lines[index];
	if (headerRaw === undefined) throw new OmpForkError("header-invalid", "session header is missing", index + 1);
	const header = parseLine(headerRaw);
	if (!isRec(header) || header["type"] !== "session" || typeof header["id"] !== "string" || header["id"] === "") {
		throw new OmpForkError("header-invalid", 'first record is not a {"type":"session"} header with a string id', index + 1);
	}
	const version = header["version"];
	if (version !== OMP_SESSION_VERSION) {
		throw new OmpForkError(
			"unsupported-version",
			typeof version === "number" ? `session version ${version} is not ${OMP_SESSION_VERSION}` : `session version is missing or not a number; only version ${OMP_SESSION_VERSION} is supported`,
			index + 1,
		);
	}
	const headerLine = index + 1;

	const entries: OmpSessionEntry[] = [];
	const byId = new Map<string, number>();
	for (let i = index + 1; i < lines.length; i++) {
		const raw = lines[i] as string;
		const line = i + 1;
		const value = parseLine(raw);
		if (!isRec(value)) throw new OmpForkError("malformed-line", "line is not a JSON object", line);
		const type = value["type"];
		const id = value["id"];
		const parentId = value["parentId"];
		if (typeof type !== "string" || type === "" || type === "session" || type === "title") {
			throw new OmpForkError("malformed-line", "entry type is missing or reserved", line);
		}
		if (typeof id !== "string" || id === "") throw new OmpForkError("malformed-line", "entry id is missing", line);
		if (parentId !== null && (typeof parentId !== "string" || parentId === "")) {
			throw new OmpForkError("malformed-line", "entry parentId is missing or not a string or null", line);
		}
		if (byId.has(id)) throw new OmpForkError("chain-broken", "duplicate entry id", line);
		byId.set(id, entries.length);
		entries.push({ id, parentId, type, raw, line, value });
	}
	return { header, headerLine, titleSlot, entries, byId };
}

/** The entries from the root to `entryId`, parents first. Throws `entry-not-found` or `chain-broken`. */
function pathTo(session: OmpSession, entryId: string): OmpSessionEntry[] {
	const start = session.byId.get(entryId);
	if (start === undefined) throw new OmpForkError("entry-not-found", "no entry has the requested id");
	const reversed: OmpSessionEntry[] = [];
	let at = start;
	for (;;) {
		const entry = session.entries[at] as OmpSessionEntry;
		reversed.push(entry);
		if (entry.parentId === null) break;
		const parent = session.byId.get(entry.parentId);
		if (parent === undefined) throw new OmpForkError("chain-broken", "parent entry does not exist", entry.line);
		// A parent must precede its child in the file. This also bounds the walk: the index strictly decreases.
		if (parent >= at) throw new OmpForkError("chain-broken", "parent entry does not precede its child", entry.line);
		at = parent;
	}
	return reversed.reverse();
}

function canonicalJson(value: unknown, line: number, depth = 0): string {
	if (depth > MAX_CANONICAL_DEPTH) throw new OmpForkError("malformed-line", "entry nesting is too deep", line);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, line, depth + 1)).join(",")}]`;
	if (isRec(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], line, depth + 1)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * sha256 over the canonical JSON (sorted keys, no whitespace) of each path entry followed by a newline. The
 * header and the title slot are NOT part of it: a fork has a new header, and its prefix must still verify
 * against the original's digest. Any rewrite, compaction or reset that changes an entry on the path changes it.
 */
function prefixDigest(path: readonly OmpSessionEntry[]): string {
	const hash = createHash("sha256");
	for (const entry of path) {
		hash.update(canonicalJson(entry.value, entry.line));
		hash.update("\n");
	}
	return hash.digest("hex");
}

/**
 * The leaf omp would select on load: the last physical entry, except that a `model_usage` entry carrying
 * `activeLeafId` (a late-usage marker) selects the leaf it captured (omp: `resolveSessionLeafId`). A captured
 * leaf that no longer exists falls back to the newest entry that selects itself.
 */
function resolveLeafEntryId(session: OmpSession): string {
	const selects = (entry: OmpSessionEntry): string | null => {
		const captured = entry.type === "model_usage" ? entry.value["activeLeafId"] : undefined;
		return typeof captured === "string" || captured === null ? captured : entry.id;
	};
	const last = session.entries[session.entries.length - 1];
	if (last === undefined) throw new OmpForkError("entry-not-found", "session has no entries");
	const leaf = selects(last);
	if (leaf === null) throw new OmpForkError("entry-not-found", "the session leaf is reset (no active entry)");
	if (leaf === last.id || session.byId.has(leaf)) return leaf;
	for (let i = session.entries.length - 1; i >= 0; i--) {
		const entry = session.entries[i] as OmpSessionEntry;
		if (selects(entry) === entry.id) return entry.id;
	}
	throw new OmpForkError("entry-not-found", "no entry selects itself as the leaf");
}

/** Number of user turns on the path: `message` entries whose `message.role` is `user`. */
function userTurns(path: readonly OmpSessionEntry[]): number {
	let turns = 0;
	for (const entry of path) {
		if (entry.type !== "message") continue;
		const message = entry.value["message"];
		if (isRec(message) && message["role"] === "user") turns++;
	}
	return turns;
}

function checkEntryId(entryId: unknown): string {
	if (typeof entryId !== "string" || entryId.length === 0 || entryId.length > 64 || !OPAQUE_ID.test(entryId)) {
		throw new OmpForkError("invalid-argument", "entryId must be 1 to 64 characters of A-Z a-z 0-9 . _ : -");
	}
	return entryId;
}

interface OmpTranscriptRefInput {
	sessionFileText: string;
	/** An opaque id or file name for the session; never a path and never file content. */
	sessionLocator: string;
	/** Defaults to the leaf as omp defines it: the last physical entry. */
	entryId?: string;
	maxBytes?: number;
}

/**
 * The transcript pointer a checkpoint records for an omp session. Carries no message content: the entry id, its
 * parent, the user-turn count and the prefix digest only. Throws `OmpForkError`; the result passes
 * `parseTranscriptRef`.
 *
 * `turn_no` is the number of `message` entries with role `user` on the root-to-entry path, the entry included.
 * The default `entry_id` is the last physical entry, which is what omp treats as the leaf on load; that can be
 * a metadata entry (a usage or title record), so a caller that means a chat message passes its `entryId`.
 */
export function ompTranscriptRef(input: OmpTranscriptRefInput): TranscriptRef {
	const session = parseOmpSession(input.sessionFileText, input.maxBytes);
	let entryId: string;
	if (input.entryId === undefined) {
		entryId = resolveLeafEntryId(session);
	} else {
		entryId = checkEntryId(input.entryId);
	}
	const path = pathTo(session, entryId);
	const target = path[path.length - 1] as OmpSessionEntry;
	const ref = {
		surface: "omp",
		session_locator: input.sessionLocator,
		entry_id: target.id,
		turn_no: userTurns(path),
		...(target.parentId === null ? {} : { parent_entry_id: target.parentId }),
		prefix_sha256: prefixDigest(path),
	};
	try {
		return parseTranscriptRef(ref);
	} catch (error) {
		if (error instanceof SessionEventError) {
			throw new OmpForkError("invalid-argument", `transcript_ref field ${error.path} failed rule ${error.rule}`);
		}
		throw error;
	}
}

export interface ForkOmpSessionInput {
	sessionFileText: string;
	/** The entry that becomes the leaf of the fork. */
	entryId: string;
	/** When given, the prefix digest the checkpoint recorded; a different one means the transcript changed. */
	expectedPrefixSha256?: string;
	/** The id of the new session (omp writes UUIDv7; any id of 1 to 128 of A-Z a-z 0-9 . _ - is accepted). */
	newSessionId: string;
	/** Injected clock: the fork's header timestamp, title-slot `updatedAt` and file name. */
	now: () => Date;
	/** Names the original in the fork's `parentSession` lineage marker: an id or file name, never a path. */
	parentSessionLocator: string;
	maxBytes?: number;
}

interface OmpForkLineage {
	session_locator: string;
	entry_id: string;
	turn_no: number;
	prefix_sha256: string;
}

export type ForkOmpSessionResult =
	| {
			ok: true;
			/** The whole new session file. */
			text: string;
			/** Number of entries copied (the header and slot are not counted). */
			entries: number;
			/** The file name omp uses for it: `<timestamp>_<id>.jsonl`. */
			file_name: string;
			forked_from: OmpForkLineage;
	  }
	| OmpForkFailure;

/** omp's `<timestamp>_<sessionId>.jsonl`: the ISO time with `:` and `.` replaced by `-`. */
export function ompSessionFileName(newSessionId: string, at: Date): string {
	return `${at.toISOString().replace(/[:.]/g, "-")}_${newSessionId}.jsonl`;
}

const DROPPED_HEADER_KEYS: Record<string, true> = { title: true, titleSource: true, previousSessionFiles: true, providerPromptCacheKey: true };

/** The title slot line (newline included) at exactly 256 bytes; the title is cut to fit when it must be. */
function titleSlotLine(slot: OmpSession["titleSlot"], fallbackTitle: unknown, fallbackSource: unknown, updatedAt: string): string {
	const title = slot?.title ?? (typeof fallbackTitle === "string" ? fallbackTitle : "");
	const rawSource = slot?.source ?? fallbackSource;
	const source = rawSource === "user" || rawSource === "auto" ? rawSource : undefined;
	const build = (candidate: string, pad: string): string =>
		JSON.stringify({
			type: "title",
			v: 1,
			title: candidate,
			...(source === undefined ? {} : { source }),
			updatedAt,
			pad,
		});
	const width = (line: string): number => Buffer.byteLength(line, "utf8") + 1;
	let kept = title;
	if (width(build(title, "")) > OMP_TITLE_SLOT_BYTES) {
		const chars = Array.from(title);
		let lo = 0;
		let hi = chars.length;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (width(build(chars.slice(0, mid).join(""), "")) <= OMP_TITLE_SLOT_BYTES) lo = mid;
			else hi = mid - 1;
		}
		kept = chars.slice(0, lo).join("");
	}
	const bare = build(kept, "");
	const pad = OMP_TITLE_SLOT_BYTES - width(bare);
	if (pad < 0) throw new OmpForkError("invalid-argument", "title slot cannot be made to fit 256 bytes");
	return `${build(kept, " ".repeat(pad))}\n`;
}

function fail(error: unknown): OmpForkFailure {
	if (error instanceof OmpForkError) {
		return { ok: false, code: error.code, detail: error.detail, ...(error.line === undefined ? {} : { line: error.line }) };
	}
	throw error;
}

/**
 * Fork an omp session at `entryId`: a new file holding the header, the title slot and ONLY the root-to-target
 * path of entries, copied byte for byte and in order. Other branches, and everything after the target, are left
 * out. The original text is not modified. Deterministic for the same input and clock.
 *
 * The caller places the result under omp's sessions directory itself (see the report: whether omp resumes from
 * it is not verified here). A `prefix-mismatch` means the transcript no longer matches the checkpoint (a
 * compaction or rewrite); callers report that as transcript outcome `stale`.
 */
export function forkOmpSession(input: ForkOmpSessionInput): ForkOmpSessionResult {
	try {
		const entryId = checkEntryId(input.entryId);
		if (typeof input.newSessionId !== "string" || !SESSION_ID.test(input.newSessionId)) {
			throw new OmpForkError("invalid-argument", "newSessionId must be 1 to 128 characters of A-Z a-z 0-9 . _ -");
		}
		if (typeof input.parentSessionLocator !== "string" || input.parentSessionLocator.length > 128 || !OPAQUE_ID.test(input.parentSessionLocator)) {
			throw new OmpForkError("invalid-argument", "parentSessionLocator must be an id or file name of 1 to 128 characters of A-Z a-z 0-9 . _ : -");
		}
		if (input.expectedPrefixSha256 !== undefined && (typeof input.expectedPrefixSha256 !== "string" || !HEX_64.test(input.expectedPrefixSha256))) {
			throw new OmpForkError("invalid-argument", "expectedPrefixSha256 must be 64 lowercase hex characters");
		}
		const at = input.now();
		if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new OmpForkError("invalid-argument", "now() must return a valid Date");

		const session = parseOmpSession(input.sessionFileText, input.maxBytes);
		if (session.header["id"] === input.newSessionId) {
			throw new OmpForkError("invalid-argument", "newSessionId must differ from the original session id");
		}
		const path = pathTo(session, entryId);
		const tail = path[path.length - 1] as OmpSessionEntry;
		if (tail.type === "model_usage" && tail.value["activeLeafId"] !== undefined) {
			// omp replays such an entry as selecting the leaf it captured, so a fork ending on it would not end on it.
			throw new OmpForkError("invalid-argument", "the target is a late-usage marker that selects another leaf; fork at an ordinary entry");
		}
		const prefix = prefixDigest(path);
		if (input.expectedPrefixSha256 !== undefined && input.expectedPrefixSha256 !== prefix) {
			throw new OmpForkError("prefix-mismatch", "the transcript prefix no longer matches the recorded digest");
		}

		const timestamp = at.toISOString();
		const headerFields: [string, unknown][] = [];
		let wroteParent = false;
		for (const [key, value] of Object.entries(session.header)) {
			if (Object.hasOwn(DROPPED_HEADER_KEYS, key)) continue;
			if (key === "id") headerFields.push([key, input.newSessionId]);
			else if (key === "timestamp") headerFields.push([key, timestamp]);
			else if (key === "parentSession") {
				headerFields.push([key, input.parentSessionLocator]);
				wroteParent = true;
			} else headerFields.push([key, value]);
		}
		if (!wroteParent) headerFields.push(["parentSession", input.parentSessionLocator]);

		const slotLine = titleSlotLine(session.titleSlot, session.header["title"], session.header["titleSource"], timestamp);
		const text = `${slotLine}${JSON.stringify(Object.fromEntries(headerFields))}\n${path.map((entry) => `${entry.raw}\n`).join("")}`;
		return {
			ok: true,
			text,
			entries: path.length,
			file_name: ompSessionFileName(input.newSessionId, at),
			forked_from: {
				session_locator: input.parentSessionLocator,
				entry_id: tail.id,
				turn_no: userTurns(path),
				prefix_sha256: prefix,
			},
		};
	} catch (error) {
		return fail(error);
	}
}
