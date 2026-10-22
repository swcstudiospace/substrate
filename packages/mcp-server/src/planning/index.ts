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

export type PlanningIndexFailure = "root-unavailable" | "planning-dir-unavailable" | "planning-dir-dangling" | "planning-dir-outside-root";

export type PlanningIndexResult = { ok: true; index: PlanningIndex } | { ok: false; code: PlanningIndexFailure };

export interface DirEntry {
	name: string;
	/** `broken` is a symlink whose target cannot be stat'ed. Symlinks are otherwise followed. */
	kind: "file" | "dir" | "broken" | "other";
}

/** What `openRead` found. `refused` means `accept` rejected the real path, and nothing was read. */
export type OpenResult = { state: "absent" } | { state: "refused" } | { state: "opened"; real: string; isFile: boolean; bytes: Uint8Array };

/** What `probe` found: no entry, a link whose target is missing, or an entry with its real location. */
export type Probe = { state: "absent" } | { state: "dangling" } | { state: "present"; real: string; isFile: boolean; isDir: boolean };

/** The filesystem and hash port. Missing paths answer null; any other failure throws. */
export interface PlanningFs {
	/**
	 * What `path` is, following symlinks. `dangling` is a link whose target is missing, which is not the
	 * same as no entry at all: the walk reports it, it never treats it as absent.
	 */
	probe(path: string): Promise<Probe>;
	/** The entries of a directory, or null when it is absent or not a directory. */
	readDir(path: string): Promise<DirEntry[] | null>;
	/** Size and kind of the target, or null when absent. Used by the .git/config reader, not by the index walk. */
	statFile(path: string): Promise<{ isFile: boolean; size: number } | null>;
	readFile(path: string): Promise<Uint8Array>;
	/**
	 * Open `path` and read through that one descriptor. `accept` receives the real path the descriptor
	 * refers to, before any byte is read; a refusal reads nothing. At most `limit` bytes are returned,
	 * so a file that grows after it was listed is still read no further than the cap.
	 */
	openRead(path: string, limit: number, accept: (real: string) => boolean): Promise<OpenResult>;
	sha256(bytes: Uint8Array): string;
}

export interface PlanningIndexDeps {
	fs: PlanningFs;
	limits: { maxFiles: number; maxBytes: number };
}

const TOP_LEVEL: ReadonlyArray<readonly [string, PlanningKind]> = [
	["PROJECT.md", "project"],
	["ROADMAP.md", "roadmap"],
	["STATE.md", "state"],
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
	planningReal: string;
	maxBytes: number;
	/** Candidates collected so far, in path order. */
	found: Entry[];
	/** The most candidates collected: one past `maxFiles`. */
	cap: number;
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

type Listing = { state: "absent" } | { state: "entries"; real: string; entries: DirEntry[] } | { state: "error"; entry: ErrorEntry };

/** A phase child resolved to what it emits: its own error record, or a directory whose documents sort under its path. */
type PhaseUnit = { type: "error"; key: string; entry: ErrorEntry } | { type: "group"; key: string; relDir: string; real: string; name: string };

/** A directory resolved: absent, an error record for it, or its real location, which is inside the root. */
type Resolved = { state: "absent" } | { state: "error"; entry: ErrorEntry } | { state: "dir"; real: string };

export type Frontmatter = { state: "none" } | { state: "parsed"; data: Record<string, unknown> } | { state: "malformed" };

/** Build the index of `<root>/.planning`. The root must be absolute; the config layer guarantees it. */
export async function buildPlanningIndex(root: string, deps: PlanningIndexDeps): Promise<PlanningIndexResult> {
	const { fs, limits } = deps;
	assertLimit(limits.maxFiles, "maxFiles");
	assertLimit(limits.maxBytes, "maxBytes");

	const rootProbe = await attempt(() => fs.probe(root));
	const rootFound = rootProbe.ok ? rootProbe.value : null;
	if (rootFound === null || rootFound.state !== "present" || !rootFound.isDir) return { ok: false, code: "root-unavailable" };
	const realRoot = rootFound.real;

	const planningAbs = join(root, PLANNING_DIR);
	const planningProbe = await attempt(() => fs.probe(planningAbs));
	const planningFound = planningProbe.ok ? planningProbe.value : null;
	if (planningFound?.state === "dangling") return { ok: false, code: "planning-dir-dangling" };
	if (planningFound === null || planningFound.state !== "present" || !planningFound.isDir) return { ok: false, code: "planning-dir-unavailable" };
	if (!isInside(planningFound.real, realRoot)) return { ok: false, code: "planning-dir-outside-root" };

	// One past the limit is collected and no more: seeing it proves the index is truncated, and nothing past it is listed.
	const walk: Walk = { fs, realRoot, planningReal: planningFound.real, maxBytes: limits.maxBytes, found: [], cap: limits.maxFiles + 1 };
	await collectTopLevel(walk);
	await collectMilestones(walk);
	await collectPhases(walk);

	const kept = walk.found.slice(0, limits.maxFiles);
	const records: PlanningRecord[] = [];
	for (const entry of kept) {
		records.push(entry.type === "error" ? entry.record : await readDocument(walk, entry));
	}
	return { ok: true, index: { records, truncated: walk.found.length > limits.maxFiles } };
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

/** Most stat or probe calls in flight at once, in the walk and in the directory reader. Small and fixed. */
export const PROBE_CONCURRENCY = 4;

/**
 * `run` over `items` with at most `limit` calls in flight. Calls start in input order and the results come back in input
 * order, whatever order the calls finish in, so the output does not depend on timing.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	assertLimit(limit, "limit");
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await run(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** Collectors stop once `cap` candidates are held. Walk order is path order, so the kept set is the first `maxFiles` by path. */
function isFull(walk: Walk): boolean {
	return walk.found.length >= walk.cap;
}

function add(walk: Walk, entry: Entry): void {
	if (!isFull(walk)) walk.found.push(entry);
}

async function collectTopLevel(walk: Walk): Promise<void> {
	for (const [name, kind] of TOP_LEVEL) {
		if (isFull(walk)) return;
		const path = `${PLANNING_DIR}/${name}`;
		const abs = join(walk.planningReal, name);
		const probed = await attempt(() => walk.fs.probe(abs));
		if (!probed.ok) {
			add(walk, errorEntry(path, "unreadable", `probe failed: ${probed.code}`, kind));
			continue;
		}
		const found = probed.value;
		if (found.state === "absent") continue;
		if (found.state === "dangling") {
			add(walk, errorEntry(path, "unreadable", "dangling symlink", kind));
			continue;
		}
		if (!found.isFile) add(walk, errorEntry(path, "unreadable", "not a regular file", kind));
		else add(walk, { type: "file", path, abs, kind });
	}
}

async function collectMilestones(walk: Walk): Promise<void> {
	if (isFull(walk)) return;
	const relDir = `${PLANNING_DIR}/milestones`;
	const listing = await listDir(walk, relDir, join(walk.planningReal, "milestones"));
	if (listing.state === "error") add(walk, listing.entry);
	else if (listing.state === "entries") collectDocuments(walk, relDir, listing.real, listing.entries, "milestone", undefined);
}

/**
 * Phase children are resolved first, then emitted in path order. A child that becomes an error record sits at its own
 * path; one that is listed has its documents under that path and a slash. Sorting by those keys puts each record where
 * its path belongs, so a directory's error is never emitted after a later sibling's documents. Listing stays lazy, so
 * the cutoff still stops it.
 */
async function collectPhases(walk: Walk): Promise<void> {
	if (isFull(walk)) return;
	const relDir = `${PLANNING_DIR}/phases`;
	const listing = await listDir(walk, relDir, join(walk.planningReal, "phases"));
	if (listing.state === "error") {
		add(walk, listing.entry);
		return;
	}
	if (listing.state === "absent") return;
	// Resolution is the only fan-out, and it is bounded: a directory with many links never has more than PROBE_CONCURRENCY probes out.
	const resolved = await mapBounded(listing.entries, PROBE_CONCURRENCY, (child) => resolvePhaseChild(walk, relDir, listing.real, child));
	const units = resolved.filter((unit): unit is PhaseUnit => unit !== null);
	units.sort((a, b) => compareText(a.key, b.key));
	for (const unit of units) {
		if (isFull(walk)) return;
		if (unit.type === "error") {
			add(walk, unit.entry);
			continue;
		}
		const sub = await readEntries(walk, unit.relDir, unit.real);
		if (sub.state === "error") add(walk, sub.entry);
		else if (sub.state === "entries") collectDocuments(walk, unit.relDir, sub.real, sub.entries, "phase", PHASE_DIR.exec(unit.name)?.[1]);
	}
}

async function resolvePhaseChild(walk: Walk, relDir: string, realPhases: string, child: DirEntry): Promise<PhaseUnit | null> {
	const dirRel = `${relDir}/${child.name}`;
	if (child.kind === "broken") return { type: "error", key: dirRel, entry: errorEntry(dirRel, "unreadable", "dangling symlink") };
	if (child.kind !== "dir") return null;
	const resolved = await resolveDir(walk, dirRel, join(realPhases, child.name));
	if (resolved.state === "absent") return null;
	if (resolved.state === "error") return { type: "error", key: dirRel, entry: resolved.entry };
	return { type: "group", key: `${dirRel}/`, relDir: dirRel, real: resolved.real, name: child.name };
}

/** A directory, resolved: absent, an error record for it, or its real location, which is inside the root. */
async function resolveDir(walk: Walk, relDir: string, absDir: string): Promise<Resolved> {
	const probed = await attempt(() => walk.fs.probe(absDir));
	if (!probed.ok) return { state: "error", entry: errorEntry(relDir, "unreadable", `probe failed: ${probed.code}`) };
	const found = probed.value;
	if (found.state === "absent") return { state: "absent" };
	if (found.state === "dangling") return { state: "error", entry: errorEntry(relDir, "unreadable", "dangling symlink") };
	if (!found.isDir) return { state: "error", entry: errorEntry(relDir, "unreadable", "not a directory") };
	if (!isInside(found.real, walk.realRoot)) {
		return { state: "error", entry: errorEntry(relDir, "outside-root", "directory resolves outside the planning root") };
	}
	return { state: "dir", real: found.real };
}

/** The entries of a resolved directory, in path order. */
async function readEntries(walk: Walk, relDir: string, real: string): Promise<Listing> {
	const listed = await attempt(() => walk.fs.readDir(real));
	if (!listed.ok) return { state: "error", entry: errorEntry(relDir, "unreadable", `read failed: ${listed.code}`) };
	if (listed.value === null) return { state: "absent" };
	return { state: "entries", real, entries: inPathOrder(listed.value) };
}

/** A directory's entries in path order, after confirming it is a directory whose real location is inside the root. */
async function listDir(walk: Walk, relDir: string, absDir: string): Promise<Listing> {
	const resolved = await resolveDir(walk, relDir, absDir);
	if (resolved.state === "absent") return { state: "absent" };
	if (resolved.state === "error") return { state: "error", entry: resolved.entry };
	return readEntries(walk, relDir, resolved.real);
}

/** Directory entries in path order. A directory's children sort under its name followed by `/`, as their paths do. */
function inPathOrder(entries: readonly DirEntry[]): DirEntry[] {
	const key = (entry: DirEntry): string => (entry.kind === "dir" ? `${entry.name}/` : entry.name);
	return [...entries].sort((a, b) => compareText(key(a), key(b)));
}

function collectDocuments(
	walk: Walk,
	relDir: string,
	absDir: string,
	entries: readonly DirEntry[],
	kind: PlanningKind,
	phase: string | undefined,
): void {
	for (const entry of entries) {
		if (isFull(walk)) return;
		if (!entry.name.endsWith(".md")) continue;
		const path = `${relDir}/${entry.name}`;
		if (entry.kind === "file") {
			const plan = entry.name.endsWith("PLAN.md") ? entry.name.slice(0, -3) : undefined;
			add(walk, { type: "file", path, abs: join(absDir, entry.name), kind, phase, plan });
		} else {
			add(walk, errorEntry(path, "unreadable", entry.kind === "broken" ? "dangling symlink" : "not a regular file", kind));
		}
	}
}

async function readDocument(walk: Walk, entry: FileEntry): Promise<PlanningRecord> {
	const fail = (code: PlanningRecordErrorCode, detail: string, sha256: string | null = null, bytes: number | null = null) =>
		errorRecord(entry.path, code, detail, { kind: entry.kind, sha256, bytes });

	// One descriptor does the root check and the read. The real path is checked before any byte is read, and
	// at most maxBytes + 1 bytes are read, so a file that grows after it was listed is cut off at the cap.
	const opened = await attempt(() => walk.fs.openRead(entry.abs, walk.maxBytes + 1, (real) => isInside(real, walk.realRoot)));
	if (!opened.ok) return fail("unreadable", `open failed: ${opened.code}`);
	const found = opened.value;
	if (found.state === "absent") return fail("unreadable", "file disappeared during the walk");
	if (found.state === "refused") return fail("outside-root", "file resolves outside the planning root");
	if (!found.isFile) return fail("unreadable", "not a regular file");
	// Too large is reported without a byte count: the file was not read to its end.
	if (found.bytes.byteLength > walk.maxBytes) return fail("too-large", `exceeds ${walk.maxBytes} bytes`);

	const sha256 = walk.fs.sha256(found.bytes);
	const bytes = found.bytes.byteLength;

	const text = decodeUtf8(found.bytes);
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
