/**
 * The file-first planning index (phase 52, SOTA-08).
 *
 * Reads `.planning/` under a checkout and describes each planning document by path, hash and
 * size. A record carries metadata only: the text is hashed and its frontmatter parsed, then the
 * text is dropped. The walk is read-only.
 *
 * Refused, never read: any path whose real location is outside the checkout root, symlinks
 * included. Bounded: at most `maxFiles` documents are described (the rest set `truncated`), and
 * a document over `maxBytes` is an error record, not read. One bad file is an error record for
 * that path; the rest of the index is still built.
 *
 * Every filesystem and hash call goes through the injected `PlanningFs`, so the tests run on a
 * fake tree. `nodePlanningFs()` in `fs.ts` is the production adapter.
 */
import { isAbsolute, join, relative, sep } from "node:path";
import { parseFrontmatter } from "../skills/frontmatter.ts";

export const PLANNING_DIR = ".planning";

export type PlanningKind = "roadmap" | "state" | "project" | "config" | "milestone" | "phase";

export type PlanningRecordErrorCode = "outside-root" | "too-large" | "unreadable" | "malformed-frontmatter";

export interface PlanningFileRecord {
	path: string;
	kind: PlanningKind;
	sha256: string;
	bytes: number;
	phase?: string;
	plan?: string;
	frontmatter?: Record<string, unknown>;
}

export interface PlanningErrorRecord {
	path: string;
	kind?: PlanningKind;
	/** Null when the document was never read, or when it could not be hashed. */
	sha256: string | null;
	bytes: number | null;
	error: { code: PlanningRecordErrorCode; detail: string };
}

export type PlanningRecord = PlanningFileRecord | PlanningErrorRecord;

export function isErrorRecord(record: PlanningRecord): record is PlanningErrorRecord {
	return "error" in record;
}

export interface PlanningIndex {
	/** Sorted by path. Byte-identical across builds of the same files. */
	records: PlanningRecord[];
	/** True when more documents existed than `maxFiles`; the kept ones are the first by path. */
	truncated: boolean;
}

export type PlanningIndexFailure = "root-unavailable" | "planning-dir-unavailable" | "planning-dir-outside-root";

export type PlanningIndexResult = { ok: true; index: PlanningIndex } | { ok: false; code: PlanningIndexFailure };

export interface DirEntry {
	name: string;
	/** `broken` is a symlink whose target cannot be stat'ed. Symlinks are otherwise followed. */
	kind: "file" | "dir" | "broken" | "other";
}

/** The filesystem and hash port. Missing paths answer null; any other failure throws. */
export interface PlanningFs {
	/** The canonical path, or null when nothing exists there. */
	realpath(path: string): Promise<string | null>;
	/** The entries of a directory, or null when it is absent or not a directory. */
	readDir(path: string): Promise<DirEntry[] | null>;
	/** Size and kind of the target, or null when absent. */
	statFile(path: string): Promise<{ isFile: boolean; size: number } | null>;
	readFile(path: string): Promise<Uint8Array>;
	sha256(bytes: Uint8Array): string;
}

export interface PlanningIndexDeps {
	fs: PlanningFs;
	limits: { maxFiles: number; maxBytes: number };
}

const TOP_LEVEL: ReadonlyArray<readonly [string, PlanningKind]> = [
	["ROADMAP.md", "roadmap"],
	["STATE.md", "state"],
	["PROJECT.md", "project"],
	["config.json", "config"],
];

const PHASE_DIR = /^(\d+(?:\.\d+)?)-/;
const FENCE_OPEN = /^\ufeff?---\r?\n/;
/** Trailing spaces or tabs after the opening `---` are not part of the fence. The shared parser wants the newline right after it. */
const OPENING_FENCE_TRAILING = /^(\ufeff?---)[ \t]+(?=\r?\n)/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

interface Walk {
	fs: PlanningFs;
	realRoot: string;
	planningAbs: string;
	maxBytes: number;
}

interface FileEntry {
	type: "file";
	path: string;
	abs: string;
	kind: PlanningKind;
	phase?: string;
	plan?: string;
}

interface ErrorEntry {
	type: "error";
	path: string;
	record: PlanningErrorRecord;
}

type Entry = FileEntry | ErrorEntry;

type Attempt<T> = { ok: true; value: T } | { ok: false; code: string };

type Listing = { state: "absent" } | { state: "entries"; entries: DirEntry[] } | { state: "error"; entry: ErrorEntry };

export type Frontmatter = { state: "none" } | { state: "parsed"; data: Record<string, unknown> } | { state: "malformed" };

/** Build the index of `<root>/.planning`. The root must be absolute; the config layer guarantees it. */
export async function buildPlanningIndex(root: string, deps: PlanningIndexDeps): Promise<PlanningIndexResult> {
	const { fs, limits } = deps;
	assertLimit(limits.maxFiles, "maxFiles");
	assertLimit(limits.maxBytes, "maxBytes");

	const realRootAttempt = await attempt(() => fs.realpath(root));
	const realRoot = realRootAttempt.ok ? realRootAttempt.value : null;
	if (realRoot === null) return { ok: false, code: "root-unavailable" };

	const planningAbs = join(root, PLANNING_DIR);
	const realPlanningAttempt = await attempt(() => fs.realpath(planningAbs));
	const realPlanning = realPlanningAttempt.ok ? realPlanningAttempt.value : null;
	if (realPlanning === null) return { ok: false, code: "planning-dir-unavailable" };
	if (!isInside(realPlanning, realRoot)) return { ok: false, code: "planning-dir-outside-root" };

	const walk: Walk = { fs, realRoot, planningAbs, maxBytes: limits.maxBytes };
	const found = [...(await collectTopLevel(walk)), ...(await collectMilestones(walk)), ...(await collectPhases(walk))];
	found.sort((a, b) => compareText(a.path, b.path));

	const kept = found.slice(0, limits.maxFiles);
	const records: PlanningRecord[] = [];
	for (const entry of kept) {
		records.push(entry.type === "error" ? entry.record : await readDocument(walk, entry));
	}
	return { ok: true, index: { records, truncated: found.length > limits.maxFiles } };
}

/** The frontmatter of a document: none, a parsed mapping, or malformed. Only `---` fenced blocks count. */
export function readFrontmatter(text: string): Frontmatter {
	const normalized = text.replace(OPENING_FENCE_TRAILING, "$1");
	if (!FENCE_OPEN.test(normalized)) return { state: "none" };
	const data = parseFrontmatter(normalized);
	return data === null ? { state: "malformed" } : { state: "parsed", data };
}

/** The code of a Node-style error (`EACCES`), or `UNKNOWN`. Never the message, which can carry host paths. */
export function errnoCode(cause: unknown): string {
	const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
	return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "UNKNOWN";
}

async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
	try {
		return { ok: true, value: await run() };
	} catch (cause) {
		return { ok: false, code: errnoCode(cause) };
	}
}

async function collectTopLevel(walk: Walk): Promise<Entry[]> {
	const out: Entry[] = [];
	for (const [name, kind] of TOP_LEVEL) {
		const path = `${PLANNING_DIR}/${name}`;
		const stat = await attempt(() => walk.fs.statFile(join(walk.planningAbs, name)));
		if (!stat.ok) out.push(errorEntry(path, "unreadable", `stat failed: ${stat.code}`, kind));
		else if (stat.value === null) continue;
		else if (!stat.value.isFile) out.push(errorEntry(path, "unreadable", "not a regular file", kind));
		else out.push({ type: "file", path, abs: join(walk.planningAbs, name), kind });
	}
	return out;
}

async function collectMilestones(walk: Walk): Promise<Entry[]> {
	const relDir = `${PLANNING_DIR}/milestones`;
	const listing = await listDir(walk, relDir, join(walk.planningAbs, "milestones"));
	if (listing.state === "error") return [listing.entry];
	if (listing.state === "absent") return [];
	return documentEntries(relDir, join(walk.planningAbs, "milestones"), listing.entries, "milestone", undefined);
}

async function collectPhases(walk: Walk): Promise<Entry[]> {
	const relDir = `${PLANNING_DIR}/phases`;
	const listing = await listDir(walk, relDir, join(walk.planningAbs, "phases"));
	if (listing.state === "error") return [listing.entry];
	if (listing.state === "absent") return [];
	const out: Entry[] = [];
	for (const dir of listing.entries) {
		if (dir.kind !== "dir") continue;
		const dirRel = `${relDir}/${dir.name}`;
		const dirAbs = join(walk.planningAbs, "phases", dir.name);
		const sub = await listDir(walk, dirRel, dirAbs);
		if (sub.state === "error") out.push(sub.entry);
		else if (sub.state === "entries") out.push(...documentEntries(dirRel, dirAbs, sub.entries, "phase", PHASE_DIR.exec(dir.name)?.[1]));
	}
	return out;
}

/** A directory's entries, after confirming its real location is inside the root. */
async function listDir(walk: Walk, relDir: string, absDir: string): Promise<Listing> {
	const real = await attempt(() => walk.fs.realpath(absDir));
	if (!real.ok) return { state: "error", entry: errorEntry(relDir, "unreadable", `realpath failed: ${real.code}`) };
	if (real.value === null) return { state: "absent" };
	if (!isInside(real.value, walk.realRoot)) {
		return { state: "error", entry: errorEntry(relDir, "outside-root", "directory resolves outside the planning root") };
	}
	const listed = await attempt(() => walk.fs.readDir(absDir));
	if (!listed.ok) return { state: "error", entry: errorEntry(relDir, "unreadable", `read failed: ${listed.code}`) };
	if (listed.value === null) return { state: "absent" };
	return { state: "entries", entries: listed.value };
}

function documentEntries(
	relDir: string,
	absDir: string,
	entries: readonly DirEntry[],
	kind: PlanningKind,
	phase: string | undefined,
): Entry[] {
	const out: Entry[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		const path = `${relDir}/${entry.name}`;
		if (entry.kind === "file") {
			const plan = entry.name.endsWith("PLAN.md") ? entry.name.slice(0, -3) : undefined;
			out.push({ type: "file", path, abs: join(absDir, entry.name), kind, phase, plan });
		} else {
			const detail = entry.kind === "broken" ? "dangling symlink" : "not a regular file";
			out.push(errorEntry(path, "unreadable", detail, kind));
		}
	}
	return out;
}

async function readDocument(walk: Walk, entry: FileEntry): Promise<PlanningRecord> {
	const fail = (code: PlanningRecordErrorCode, detail: string, sha256: string | null = null, bytes: number | null = null) =>
		errorRecord(entry.path, code, detail, { kind: entry.kind, sha256, bytes });

	const real = await attempt(() => walk.fs.realpath(entry.abs));
	if (!real.ok) return fail("unreadable", `realpath failed: ${real.code}`);
	if (real.value === null) return fail("unreadable", "file disappeared during the walk");
	if (!isInside(real.value, walk.realRoot)) return fail("outside-root", "file resolves outside the planning root");

	const stat = await attempt(() => walk.fs.statFile(entry.abs));
	if (!stat.ok) return fail("unreadable", `stat failed: ${stat.code}`);
	if (stat.value === null || !stat.value.isFile) return fail("unreadable", "not a regular file");
	if (stat.value.size > walk.maxBytes) return fail("too-large", `exceeds ${walk.maxBytes} bytes`, null, stat.value.size);

	const read = await attempt(() => walk.fs.readFile(entry.abs));
	if (!read.ok) return fail("unreadable", `read failed: ${read.code}`);
	const sha256 = walk.fs.sha256(read.value);
	const bytes = read.value.byteLength;

	const text = decodeUtf8(read.value);
	if (text === null) return fail("unreadable", "not valid UTF-8", sha256, bytes);
	const frontmatter: Frontmatter = entry.path.endsWith(".md") ? readFrontmatter(text) : { state: "none" };
	if (frontmatter.state === "malformed") {
		return fail("malformed-frontmatter", "frontmatter has no closing fence or is not a YAML mapping", sha256, bytes);
	}

	const record: PlanningFileRecord = { path: entry.path, kind: entry.kind, sha256, bytes };
	if (entry.phase !== undefined) record.phase = entry.phase;
	if (entry.plan !== undefined) record.plan = entry.plan;
	if (frontmatter.state === "parsed") record.frontmatter = frontmatter.data;
	return record;
}

function errorEntry(path: string, code: PlanningRecordErrorCode, detail: string, kind?: PlanningKind): ErrorEntry {
	return { type: "error", path, record: errorRecord(path, code, detail, { kind, sha256: null, bytes: null }) };
}

function errorRecord(
	path: string,
	code: PlanningRecordErrorCode,
	detail: string,
	extra: { kind?: PlanningKind; sha256: string | null; bytes: number | null },
): PlanningErrorRecord {
	const record: PlanningErrorRecord = { path, sha256: extra.sha256, bytes: extra.bytes, error: { code, detail } };
	if (extra.kind !== undefined) record.kind = extra.kind;
	return record;
}

/** Inside `base` by path arithmetic on two real paths. The base itself counts as inside. */
function isInside(real: string, base: string): boolean {
	const rel = relative(base, real);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function decodeUtf8(bytes: Uint8Array): string | null {
	try {
		return UTF8.decode(bytes);
	} catch {
		// Not UTF-8: the caller turns this into an `unreadable` record for the path.
		return null;
	}
}

function assertLimit(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
