/**
 * The file-first planning index (phase 52, SOTA-08).
 *
 * Reads `.planning/` under a checkout and keys each document's content by its sha256. The index holds metadata only: a
 * content entry has the byte size and the parsed frontmatter, never the text. Identical bytes at any number of paths
 * share one content entry, whose `paths` lists them. Each described document has a path entry that names its content by
 * sha256, and each path that could not be described has an error entry. STATE.md and ROADMAP.md also leave a position part
 * (`positionParts`): the parsed, redacted, capped fields `position.ts` reads out of them, never their text. The part is
 * parsed from the bytes the scan already read and is kept with an unchanged document, so `positionOf` needs no second pass.
 *
 * Superseded phase directories: a phase directory that holds a `SUPERSEDED.md` document is ignored by `positionOf` when
 * another directory carries the same phase number (a replaced plan kept as history). Two or more directories without the
 * marker stay ambiguous.
 *
 * `buildPlanningIndex` is the full rebuild. `updatePlanningIndex` takes the previous index of the same root and reuses a
 * document's content while its stat fingerprint (`signature`) is unchanged, so an unchanged document is neither read nor
 * hashed again. For the same tree the two results are equal.
 *
 * Refused, never read: any path whose real location is outside the checkout root, symlinks included. Bounded: at most
 * `maxFiles` documents are described (the rest set `truncated`), and a document over `maxBytes` is an error record, not
 * read. One bad file is an error record for that path; the rest of the index is still built.
 *
 * Every filesystem and hash call goes through the injected `PlanningFs`, so the tests run on a fake tree.
 * `nodePlanningFs()` in `fs.ts` is the production adapter.
 */
import { isAbsolute, join, relative, sep } from "node:path";
import { parseFrontmatter } from "../skills/frontmatter.ts";
import type { PlanningSnapshot } from "./diff.ts";
import { composePosition, parseRoadmapPart, parseStatePart, type PartOutcome, type PositionError, type PositionResult, type RoadmapPart, type StatePart } from "./position.ts";

export const PLANNING_DIR = ".planning";

export type PlanningKind = "roadmap" | "state" | "project" | "config" | "milestone" | "phase";

export type PlanningRecordErrorCode = "outside-root" | "too-large" | "unreadable" | "malformed-frontmatter";

/** A described document, as a record view shows it: its path facts and the size and frontmatter of its content. */
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

/** The facts of one content, held under its sha256 in `PlanningIndex.contents`. */
export interface PlanningContent {
	bytes: number;
	/** Parsed from the text when the text opens with a `---` fence. Absent otherwise. */
	frontmatter?: Record<string, unknown>;
	/** Every document path whose bytes hash to this key, sorted. */
	paths: string[];
}

/** One described document, held under its path in `PlanningIndex.documents`. */
export interface PlanningDocument {
	kind: PlanningKind;
	/** The key of the document's content in `PlanningIndex.contents`. */
	sha256: string;
	phase?: string;
	plan?: string;
	/** The stat fingerprint the content was read under. An incremental update reuses the content while it still matches. */
	signature: string;
}

/** A parsed position part and the sha256 of the bytes it came from, so an unchanged document keeps its part. */
export interface PositionPartEntry<T> {
	outcome: PartOutcome<T>;
	sha256: string;
}

/** The parsed position parts of the two documents the position reads. Fields only, never text; see `position.ts`. */
export interface PositionParts {
	roadmap?: PositionPartEntry<RoadmapPart>;
	state?: PositionPartEntry<StatePart>;
}

export interface PlanningIndex {
	/** Keyed by sha256, sorted by key. Identical bytes at any paths share one entry. */
	contents: Record<string, PlanningContent>;
	/** Keyed by path, sorted. Every document that was described. */
	documents: Record<string, PlanningDocument>;
	/** Keyed by path, sorted. Every path that could not be described. */
	errors: Record<string, PlanningErrorRecord>;
	/** True when more documents existed than `maxFiles`; the kept ones are the first by path. */
	truncated: boolean;
	/** Directories the walk could not list (an error record names each). Their documents are unknown, so a diff must not read them as removed. Sorted. */
	unlisted: string[];
	/** The position parts of STATE.md and ROADMAP.md, parsed from the bytes the scan read: fields only, never text. See `positionOf`. */
	positionParts: PositionParts;
}

export type PlanningIndexFailure = "root-unavailable" | "planning-dir-unavailable" | "planning-dir-dangling" | "planning-dir-outside-root";

export type PlanningIndexResult = { ok: true; index: PlanningIndex } | { ok: false; code: PlanningIndexFailure };

export interface DirEntry {
	name: string;
	/** `link` is a symbolic link, whatever it points at. A listing does not stat it: the walk probes a link only when it needs to know. */
	kind: "file" | "dir" | "link" | "other";
}

/**
 * What `openRead` found. `refused` means `accept` rejected the real path, and nothing was read. `signature` is the stat
 * fingerprint of the descriptor, taken before any byte is read. `bytes` is null when `reuse` accepted that signature, so
 * the file was not read, and also for a file that is not regular.
 */
export type OpenResult =
	| { state: "absent" }
	| { state: "refused" }
	| { state: "opened"; real: string; isFile: boolean; signature: string; bytes: Uint8Array | null };

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
	 * Open `path` and read through that one descriptor. `accept` receives the real path the descriptor refers to, before any
	 * byte is read; a refusal reads nothing. The descriptor's stat fingerprint is taken next and passed to `reuse`: when
	 * `reuse` returns true, no byte is read. Otherwise at most `limit` bytes are returned, so a file that grows after it was
	 * listed is still read no further than the cap.
	 */
	openRead(path: string, limit: number, accept: (real: string) => boolean, reuse: (signature: string) => boolean): Promise<OpenResult>;
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
const PHASE_PATH = new RegExp(`^${PLANNING_DIR.replace(".", "\\.")}/phases/([^/]+)(?:/([^/]+))?$`);
const PLAN_OR_SUMMARY = /(?:PLAN|SUMMARY)\.md$/;
/** A document of this name in a phase directory marks it superseded by another directory of the same phase number. */
const SUPERSEDED_MARKER = "SUPERSEDED.md";
const FENCE_OPEN = /^\ufeff?---\r?\n/;
/** Trailing spaces or tabs after the opening `---` are not part of the fence. The shared parser wants the newline right after it. */
const OPENING_FENCE_TRAILING = /^(\ufeff?---)[ \t]+(?=\r?\n)/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

interface Walk {
	fs: PlanningFs;
	realRoot: string;
	planningReal: string;
	maxBytes: number;
	/** The index an incremental update starts from, or null for a full rebuild. */
	previous: PlanningIndex | null;
	/** Candidates collected so far, in path order. */
	found: Entry[];
	/** The most candidates collected: one past `maxFiles`. */
	cap: number;
	/** Directories whose contents could not be listed: the documents under them are unknown, never removed. */
	unlisted: string[];
}

interface FileEntry {
	type: "file";
	path: string;
	abs: string;
	kind: PlanningKind;
	phase?: string | undefined;
	plan?: string | undefined;
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
type PhaseUnit = { type: "error"; key: string; entry: ErrorEntry } | { type: "group"; key: string; relDir: string; real: string; name: string; entries: DirEntry[] };

/** A directory resolved: absent, an error record for it, or its real location, which is inside the root. */
type Resolved = { state: "absent" } | { state: "error"; entry: ErrorEntry } | { state: "dir"; real: string } | { state: "file" };

/** The position part of a described STATE.md or ROADMAP.md, with the bytes it came from. */
type PositionPart = { kind: "state"; entry: PositionPartEntry<StatePart> } | { kind: "roadmap"; entry: PositionPartEntry<RoadmapPart> };

/** One document described: its path entry and its content, or the error record for its path. `part` is set for STATE.md and ROADMAP.md only. */
type Described =
	| { ok: true; document: PlanningDocument; sha256: string; bytes: number; frontmatter: Record<string, unknown> | undefined; part: PositionPart | null }
	| { ok: false; record: PlanningErrorRecord };

export type Frontmatter = { state: "none" } | { state: "parsed"; data: Record<string, unknown> } | { state: "malformed" };

/** The full rebuild of `<root>/.planning`. The root must be absolute; the config layer guarantees it. */
export async function buildPlanningIndex(root: string, deps: PlanningIndexDeps): Promise<PlanningIndexResult> {
	return scanPlanning(root, deps, null);
}

/**
 * The index of `<root>/.planning` as it stands now, starting from `previous`, the index of the same root. A document whose
 * stat fingerprint is unchanged keeps its content and is neither read nor hashed again; every other document is read. The
 * result equals `buildPlanningIndex` over the same tree.
 */
export async function updatePlanningIndex(root: string, deps: PlanningIndexDeps, previous: PlanningIndex): Promise<PlanningIndexResult> {
	return scanPlanning(root, deps, previous);
}

async function scanPlanning(root: string, deps: PlanningIndexDeps, previous: PlanningIndex | null): Promise<PlanningIndexResult> {
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
	const walk: Walk = {
		fs,
		realRoot,
		planningReal: planningFound.real,
		maxBytes: limits.maxBytes,
		previous,
		found: [],
		cap: limits.maxFiles + 1,
		unlisted: [],
	};
	await collectTopLevel(walk);
	await collectMilestones(walk);
	await collectPhases(walk);

	const kept = walk.found.slice(0, limits.maxFiles);
	const contents = new Map<string, PlanningContent>();
	const documents: Record<string, PlanningDocument> = {};
	const errors: Record<string, PlanningErrorRecord> = {};
	const positionParts: PositionParts = {};
	for (const entry of kept) {
		if (entry.type === "error") {
			errors[entry.path] = entry.record;
			continue;
		}
		const described = await describeDocument(walk, entry);
		if (!described.ok) {
			errors[entry.path] = described.record;
			continue;
		}
		documents[entry.path] = described.document;
		if (described.part?.kind === "state") positionParts.state = described.part.entry;
		else if (described.part?.kind === "roadmap") positionParts.roadmap = described.part.entry;
		const held = contents.get(described.sha256);
		if (held === undefined) {
			const content: PlanningContent = { bytes: described.bytes, paths: [entry.path] };
			if (described.frontmatter !== undefined) content.frontmatter = described.frontmatter;
			contents.set(described.sha256, content);
		} else {
			held.paths.push(entry.path);
		}
	}
	return {
		ok: true,
		index: {
			contents: sortedRecord(contents),
			documents,
			errors,
			truncated: walk.found.length > limits.maxFiles,
			unlisted: [...walk.unlisted].sort(compareText),
			positionParts,
		},
	};
}

/** The records of an index, sorted by path: every described document, then every error, merged in path order. */
export function indexRecords(index: PlanningIndex): PlanningRecord[] {
	const records: PlanningRecord[] = [];
	for (const [path, document] of Object.entries(index.documents)) {
		const content = index.contents[document.sha256];
		if (content === undefined) throw new Error(`planning index holds no content for ${path}`);
		const record: PlanningFileRecord = { path, kind: document.kind, sha256: document.sha256, bytes: content.bytes };
		if (document.phase !== undefined) record.phase = document.phase;
		if (document.plan !== undefined) record.plan = document.plan;
		if (content.frontmatter !== undefined) record.frontmatter = content.frontmatter;
		records.push(record);
	}
	records.push(...Object.values(index.errors));
	return records.sort((a, b) => compareText(a.path, b.path));
}

/** The diff's view of an index: each record's path and hash (null for an error), with the truncation and unlisted directories. */
export function snapshotOf(index: PlanningIndex): PlanningSnapshot {
	const records = indexRecords(index).map((record) => ({ path: record.path, sha256: record.sha256 }));
	return { records, truncated: index.truncated, unlisted: index.unlisted };
}

/**
 * Where GSD-Core is, from the parts the scan parsed out of STATE.md and ROADMAP.md and the phase directories and plan files
 * the index holds. Nothing is read: the scan that built the index is the only pass over the files. A STATE.md or ROADMAP.md
 * that was not described becomes an error entry of the position, with the index's own reason when it has one.
 *
 * Superseded phase directories: when several directories share a phase number, one that holds a `SUPERSEDED.md` document is
 * ignored, along with its plan files. If more than one directory without the marker remains, the position stays ambiguous.
 * A lone directory is never dropped, marker or not.
 */
export function positionOf(index: PlanningIndex): PositionResult {
	const names = new Set<string>();
	const superseded = new Set<string>();
	const files: Array<{ dir: string; file: string }> = [];
	for (const path of [...Object.keys(index.documents), ...Object.keys(index.errors)]) {
		const match = PHASE_PATH.exec(path);
		if (match === null) continue;
		const dir = match[1] ?? "";
		names.add(dir);
		const file = match[2];
		if (file === undefined) continue;
		if (file === SUPERSEDED_MARKER) superseded.add(dir);
		files.push({ dir, file });
	}
	const byNumber = new Map<string, string[]>();
	for (const name of names) {
		const number = PHASE_DIR.exec(name)?.[1]?.replace(/^0+(?=\d)/, "");
		if (number === undefined) continue;
		byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
	}
	const ignored = new Set<string>();
	for (const dirs of byNumber.values()) {
		if (dirs.length > 1) for (const dir of dirs) if (superseded.has(dir)) ignored.add(dir);
	}
	const plans: string[] = [];
	for (const { dir, file } of files) {
		if (!ignored.has(dir) && PLAN_OR_SUMMARY.test(file)) plans.push(file);
	}
	return composePosition({
		state: partOutcomeOf(index, index.positionParts.state, "STATE.md"),
		roadmap: partOutcomeOf(index, index.positionParts.roadmap, "ROADMAP.md"),
		phases: [...names].filter((name) => !ignored.has(name)),
		plans,
	});
}

function partOutcomeOf<T>(index: PlanningIndex, held: PositionPartEntry<T> | undefined, where: "STATE.md" | "ROADMAP.md"): PartOutcome<T> {
	if (held !== undefined) return held.outcome;
	const record = index.errors[`${PLANNING_DIR}/${where}`];
	if (record === undefined) return { ok: false, error: { code: "missing", detail: `${where} was not found`, where } };
	const code: PositionError["code"] = record.error.code === "too-large" || record.error.code === "malformed-frontmatter" ? record.error.code : "unreadable";
	return { ok: false, error: { code, detail: record.error.detail, where } };
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
	else if (listing.state === "entries") await collectDocuments(walk, relDir, listing.real, listing.entries, "milestone", undefined);
}

/**
 * Phase children are taken in name order, a batch at a time, and emitted in path order. A child that becomes an error
 * record sits at its own path; a listed directory's documents sit under its path and a slash. A resolved unit is emitted
 * once its key sorts before the first child not yet resolved: that child's record can only sit at its own path or under
 * it, so nothing still unresolved can come before the unit. Resolution therefore stops at the cutoff, and the output is
 * still in path order.
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
	const children = [...listing.entries].sort((a, b) => compareText(a.name, b.name));
	let pending: PhaseUnit[] = [];
	let next = 0;
	while (next < children.length && !isFull(walk)) {
		const batch = children.slice(next, next + PROBE_CONCURRENCY);
		next += batch.length;
		const resolved = await mapBounded(batch, PROBE_CONCURRENCY, (child) => resolvePhaseChild(walk, relDir, listing.real, child));
		pending.push(...resolved.filter((unit): unit is PhaseUnit => unit !== null));
		// The first child not yet resolved bounds every unit still to come. With none left, everything pending is ready.
		const nextChild = children[next];
		const frontier = nextChild === undefined ? undefined : `${relDir}/${nextChild.name}`;
		const ready = pending.filter((unit) => frontier === undefined || compareText(unit.key, frontier) < 0).sort((a, b) => compareText(a.key, b.key));
		pending = pending.filter((unit) => !ready.includes(unit));
		for (const unit of ready) {
			if (isFull(walk)) return;
			await emitPhaseUnit(walk, unit);
		}
	}
}

async function emitPhaseUnit(walk: Walk, unit: PhaseUnit): Promise<void> {
	if (unit.type === "error") {
		add(walk, unit.entry);
		return;
	}
	// Decision: a document's phase is its directory's, never its frontmatter's. Frontmatter may supply the plan id only.
	await collectDocuments(walk, unit.relDir, unit.real, unit.entries, "phase", PHASE_DIR.exec(unit.name)?.[1]);
}

/** A directory-level error record. The directory's contents are unknown from here on, so its path is recorded as unlisted. */
function dirError(walk: Walk, relDir: string, code: PlanningRecordErrorCode, detail: string): ErrorEntry {
	walk.unlisted.push(relDir);
	return errorEntry(relDir, code, detail);
}

async function resolvePhaseChild(walk: Walk, relDir: string, realPhases: string, child: DirEntry): Promise<PhaseUnit | null> {
	const dirRel = `${relDir}/${child.name}`;
	// A file is not a phase directory. A directory or a link is probed, and the probe decides what it is.
	if (child.kind !== "dir" && child.kind !== "link") return null;
	const resolved = await resolveDir(walk, dirRel, join(realPhases, child.name));
	if (resolved.state === "absent" || resolved.state === "file") return null;
	if (resolved.state === "error") return { type: "error", key: dirRel, entry: resolved.entry };
	// Listed here, not when emitted: a listing that fails must sort at the directory's own path, which is only known now.
	const sub = await readEntries(walk, dirRel, resolved.real);
	if (sub.state === "absent") return null;
	if (sub.state === "error") return { type: "error", key: dirRel, entry: sub.entry };
	return { type: "group", key: `${dirRel}/`, relDir: dirRel, real: sub.real, name: child.name, entries: sub.entries };
}

/** A directory, resolved: absent, an error record for it, a non-directory, or its real location, which is inside the root. */
async function resolveDir(walk: Walk, relDir: string, absDir: string): Promise<Resolved> {
	const probed = await attempt(() => walk.fs.probe(absDir));
	if (!probed.ok) return { state: "error", entry: dirError(walk, relDir, "unreadable", `probe failed: ${probed.code}`) };
	const found = probed.value;
	if (found.state === "absent") return { state: "absent" };
	if (found.state === "dangling") return { state: "error", entry: dirError(walk, relDir, "unreadable", "dangling symlink") };
	if (!found.isDir) return { state: "file" };
	if (!isInside(found.real, walk.realRoot)) {
		return { state: "error", entry: dirError(walk, relDir, "outside-root", "directory resolves outside the planning root") };
	}
	return { state: "dir", real: found.real };
}

/** The entries of a resolved directory, in path order. */
async function readEntries(walk: Walk, relDir: string, real: string): Promise<Listing> {
	const listed = await attempt(() => walk.fs.readDir(real));
	if (!listed.ok) return { state: "error", entry: dirError(walk, relDir, "unreadable", `read failed: ${listed.code}`) };
	if (listed.value === null) return { state: "absent" };
	return { state: "entries", real, entries: inPathOrder(listed.value) };
}

/** A directory's entries in path order, after confirming it is a directory whose real location is inside the root. */
async function listDir(walk: Walk, relDir: string, absDir: string): Promise<Listing> {
	const resolved = await resolveDir(walk, relDir, absDir);
	if (resolved.state === "absent") return { state: "absent" };
	if (resolved.state === "error") return { state: "error", entry: resolved.entry };
	if (resolved.state === "file") return { state: "error", entry: dirError(walk, relDir, "unreadable", "not a directory") };
	return readEntries(walk, relDir, resolved.real);
}

/** Entries in path order. Every entry is a leaf of its listing (a directory in one is an error at its own path), so the name is the path. */
function inPathOrder(entries: readonly DirEntry[]): DirEntry[] {
	return [...entries].sort((a, b) => compareText(a.name, b.name));
}

/**
 * The documents of one listing, in order. A link is probed here, as a candidate, so a listing stats nothing and the walk
 * stops probing at the cutoff.
 */
async function collectDocuments(
	walk: Walk,
	relDir: string,
	absDir: string,
	entries: readonly DirEntry[],
	kind: PlanningKind,
	phase: string | undefined,
): Promise<void> {
	for (const entry of entries) {
		if (isFull(walk)) return;
		if (!entry.name.endsWith(".md")) continue;
		const path = `${relDir}/${entry.name}`;
		const abs = join(absDir, entry.name);
		const plan = entry.name.endsWith("PLAN.md") ? entry.name.slice(0, -3) : undefined;
		const document: FileEntry = { type: "file", path, abs, kind, phase, plan };
		if (entry.kind === "file") {
			add(walk, document);
			continue;
		}
		if (entry.kind !== "link") {
			add(walk, errorEntry(path, "unreadable", "not a regular file", kind));
			continue;
		}
		const probed = await attempt(() => walk.fs.probe(abs));
		if (!probed.ok) {
			add(walk, errorEntry(path, "unreadable", `probe failed: ${probed.code}`, kind));
			continue;
		}
		const found = probed.value;
		if (found.state === "absent") continue;
		if (found.state === "dangling") add(walk, errorEntry(path, "unreadable", "dangling symlink", kind));
		else if (!found.isFile) add(walk, errorEntry(path, "unreadable", "not a regular file", kind));
		else add(walk, document);
	}
}

/**
 * The content a previous index holds for `path` under `signature`, when it may be reused under the current limits. A
 * document over the current `maxBytes` is never reused, so the limit applies as it would in a full rebuild. STATE.md and
 * ROADMAP.md are reused only with the position part parsed from those same bytes; without it they are read again.
 */
function reusableContent(
	walk: Walk,
	path: string,
	signature: string,
	kind: PlanningKind,
): { sha256: string; bytes: number; frontmatter: Record<string, unknown> | undefined; part: PositionPart | null } | null {
	const prior: PlanningDocument | undefined = walk.previous?.documents[path];
	if (prior === undefined || prior.signature !== signature) return null;
	const content: PlanningContent | undefined = walk.previous?.contents[prior.sha256];
	if (content === undefined || content.bytes > walk.maxBytes) return null;
	let part: PositionPart | null = null;
	if (kind === "state") {
		const held = walk.previous?.positionParts.state;
		if (held === undefined || held.sha256 !== prior.sha256) return null;
		part = { kind, entry: held };
	} else if (kind === "roadmap") {
		const held = walk.previous?.positionParts.roadmap;
		if (held === undefined || held.sha256 !== prior.sha256) return null;
		part = { kind, entry: held };
	}
	return { sha256: prior.sha256, bytes: content.bytes, frontmatter: content.frontmatter, part };
}

async function describeDocument(walk: Walk, entry: FileEntry): Promise<Described> {
	const fail = (code: PlanningRecordErrorCode, detail: string, sha256: string | null = null, bytes: number | null = null): Described => ({
		ok: false,
		record: errorRecord(entry.path, code, detail, { kind: entry.kind, sha256, bytes }),
	});

	// One descriptor does the root check, the fingerprint and the read. The real path is checked before any byte is read, and
	// at most maxBytes + 1 bytes are read, so a file that grows after it was listed is cut off at the cap.
	const opened = await attempt(() =>
		walk.fs.openRead(
			entry.abs,
			walk.maxBytes + 1,
			(real) => isInside(real, walk.realRoot),
			(signature) => reusableContent(walk, entry.path, signature, entry.kind) !== null,
		),
	);
	if (!opened.ok) return fail("unreadable", `open failed: ${opened.code}`);
	const found = opened.value;
	if (found.state === "absent") return fail("unreadable", "file disappeared during the walk");
	if (found.state === "refused") return fail("outside-root", "file resolves outside the planning root");
	if (!found.isFile) return fail("unreadable", "not a regular file");
	if (found.bytes === null) {
		// The fingerprint matched the previous index, so the bytes were not read. The content is the previous one.
		const reused = reusableContent(walk, entry.path, found.signature, entry.kind);
		if (reused === null) return fail("unreadable", "unchanged document has no reusable content");
		return describedOf(entry, found.signature, reused.sha256, reused.bytes, reused.frontmatter, reused.part);
	}
	// Too large is reported without a byte count: the file was not read to its end.
	if (found.bytes.byteLength > walk.maxBytes) return fail("too-large", `exceeds ${walk.maxBytes} bytes`);

	const sha256 = walk.fs.sha256(found.bytes);
	const bytes = found.bytes.byteLength;
	const text = decodeUtf8(found.bytes);
	if (text === null) return fail("unreadable", "not valid UTF-8", sha256, bytes);
	const frontmatter = readFrontmatter(text);
	if (frontmatter.state === "malformed") {
		return fail("malformed-frontmatter", "frontmatter has no closing fence or is not a YAML mapping", sha256, bytes);
	}
	const part = positionPartOf(entry.kind, sha256, text, frontmatter, walk.maxBytes);
	return describedOf(entry, found.signature, sha256, bytes, frontmatter.state === "parsed" ? frontmatter.data : undefined, part);
}

/** The position part of STATE.md or ROADMAP.md, parsed from the text just read. Other documents have none. */
function positionPartOf(kind: PlanningKind, sha256: string, text: string, frontmatter: Frontmatter, maxBytes: number): PositionPart | null {
	if (kind === "state") return { kind, entry: { outcome: parseStatePart(text, frontmatter, maxBytes), sha256 } };
	if (kind === "roadmap") return { kind, entry: { outcome: parseRoadmapPart(text, frontmatter, maxBytes), sha256 } };
	return null;
}

function describedOf(
	entry: FileEntry,
	signature: string,
	sha256: string,
	bytes: number,
	frontmatter: Record<string, unknown> | undefined,
	part: PositionPart | null,
): Described {
	const document: PlanningDocument = { kind: entry.kind, sha256, signature };
	if (entry.phase !== undefined) document.phase = entry.phase;
	if (entry.plan !== undefined) document.plan = entry.plan;
	return { ok: true, document, sha256, bytes, frontmatter, part };
}

function errorEntry(path: string, code: PlanningRecordErrorCode, detail: string, kind?: PlanningKind): ErrorEntry {
	return { type: "error", path, record: errorRecord(path, code, detail, { kind, sha256: null, bytes: null }) };
}

function errorRecord(
	path: string,
	code: PlanningRecordErrorCode,
	detail: string,
	extra: { kind?: PlanningKind | undefined; sha256: string | null; bytes: number | null },
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

/** A map as a record whose keys are in code-unit order. The order of the keys is part of the output. */
function sortedRecord<T>(entries: Map<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const [key, value] of [...entries].sort(([a], [b]) => compareText(a, b))) out[key] = value;
	return out;
}

function assertLimit(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
