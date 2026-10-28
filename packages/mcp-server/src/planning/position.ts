/**
 * The GSD-Core position model (phase 58): where a project is, read from `.planning/STATE.md` and `.planning/ROADMAP.md`, so a
 * session that runs for days is steered by a position and not by a free-text plan reference.
 *
 * Pure and total. Nothing here reads the filesystem or the clock, and nothing throws: the callers pass text. A missing,
 * oversize or malformed file is an entry in `errors` and null fields in `position`, never an exception. The same input gives
 * byte-identical JSON: every object is built with its keys in code-unit order, and the errors are sorted.
 *
 * Two layouts are read, and both occur in this repository.
 *  - STATE.md: YAML frontmatter (`milestone`, `milestone_name`, `status`, `stopped_at`, `current_phase`,
 *    `current_phase_name`, `progress.{total_phases,completed_phases}`), then prose with a `## Current Position` section
 *    (`Phase:`, `Plan:`, `Status:` lines) and a `## Session Continuity` section (`Stopped at:`). The frontmatter is kept up
 *    to date by the GSD tools and the prose often is not (a closed milestone's `Phase:` line can outlive it), so a value that
 *    the frontmatter has wins and the prose only fills what it lacks. A `Phase:` line that is not a single phase number
 *    (`Milestone v1.3 complete`, `None active`, `63-66 built`) names no phase.
 *  - ROADMAP.md: `### Phase N: Name` sections with `**Status**:` and `**Plans**:` lines and a `- [ ] NN-MM-PLAN.md` checklist,
 *    the `- [x] **Phase N: Name** - ...` list, and the `| N. Name | milestone | plans | status | date |` progress table. The
 *    table is the source of progress for the state's milestone, because the frontmatter counters go stale.
 *
 * A document is parsed into a small part (`parseStatePart`, `parseRoadmapPart`) that holds only parsed, redacted, capped
 * fields and never the text, so the planning index can keep the part of an unchanged document and compose the position
 * without reading a file again. `composePosition` joins the two parts with the phase directories and plan files present.
 * `parsePosition` does all three steps on text.
 *
 * Every string returned is redacted with the shared `redact()` and capped at `POSITION_STRING_MAX` characters.
 */
import { redact } from "../redact.ts";
import { parseFrontmatter } from "../skills/frontmatter.ts";
import { DEFAULT_MAX_BYTES } from "./config.ts";

/** The text cap: the one the planning reader applies to every document by default. A caller with another cap passes it. */
export const POSITION_MAX_BYTES = DEFAULT_MAX_BYTES;
/** The longest string a position carries. Longer text is cut and ends in an ellipsis, after it was redacted. */
export const POSITION_STRING_MAX = 300;
/** The most phases and the most table rows a roadmap part keeps. More set `truncated`, and the position reports it. */
export const POSITION_MAX_ENTRIES = 2_000;
/** The most plan items kept for one phase of the roadmap. */
const MAX_PLAN_ITEMS = 200;
/** The most phase directories and plan files `composePosition` looks at. */
const MAX_NAMES = 10_000;
/** A line is cut here before it is redacted, so one huge line cannot make the redaction slow. The output cap is far below it. */
const LINE_PREFIX_MAX = 4_096;

export type PositionErrorCode = "missing" | "too-large" | "malformed-frontmatter" | "unreadable" | "no-position" | "truncated" | "ambiguous-phase-dir" | "internal";

export type PositionErrorWhere = "STATE.md" | "ROADMAP.md" | "phases";

export interface PositionError {
	code: PositionErrorCode;
	detail: string;
	where: PositionErrorWhere;
}

export interface PositionPhase {
	/** The title: the roadmap's, else the state's. */
	name: string | null;
	/** The phase number as text, without leading zeros (`8.1`, `58`), so an inserted phase keeps its place. */
	number: string;
	/** The phase directory's name after its number prefix (`52-planning-awareness-core` gives `planning-awareness-core`), or null when there is none or it is ambiguous. */
	slug: string | null;
}

export interface Position {
	milestone: string | null;
	milestone_name: string | null;
	phase: PositionPhase | null;
	/** The plan in progress, as the state names it, else the first plan without a summary, else the first unchecked plan of the roadmap. */
	plan: string | null;
	/** Phases done and phases in the state's milestone. Null when neither the roadmap table nor the state's counters say. */
	progress: { phases_done: number; phases_total: number } | null;
	status: string | null;
	/** Where the last session stopped: the state's `stopped_at`, else its `Stopped at:` line. */
	step: string | null;
}

export interface PositionResult {
	errors: PositionError[];
	/** True when `errors` is empty. The position is returned in either case, with null fields for what is unknown. */
	ok: boolean;
	position: Position;
}

export interface PositionInput {
	/** The text of STATE.md, or null when there is none. */
	state: string | null;
	/** The text of ROADMAP.md, or null when there is none. */
	roadmap: string | null;
	/** The names of the phase directories present (`52-planning-awareness-core`). */
	phases?: readonly string[];
	/** The names of the plan files present (`52-01-PLAN.md`). A `52-01-SUMMARY.md` among them marks that plan done. */
	plans?: readonly string[];
	/** The text cap. Defaults to `POSITION_MAX_BYTES`. */
	maxBytes?: number;
}

/** The frontmatter of a document, as the planning index reads it. The same shape as `Frontmatter` in `index.ts`. */
export type PositionFrontmatter = { state: "none" } | { state: "parsed"; data: Record<string, unknown> } | { state: "malformed" };

export type PartOutcome<T> = { ok: true; part: T } | { ok: false; error: PositionError };

export interface StatePart {
	milestone: string | null;
	milestoneName: string | null;
	phase: { name: string | null; number: string } | null;
	/** `declared` is false when the state has no `Plan:` line at all, which is not the same as a line that says there is no plan. */
	plan: { declared: boolean; value: string | null };
	progress: { done: number; total: number } | null;
	status: string | null;
	step: string | null;
}

export interface RoadmapPhaseEntry {
	/** The box of the `- [x] **Phase N: ...**` list, or null when the list does not name the phase. */
	checked: boolean | null;
	items: Array<{ done: boolean; id: string }>;
	name: string | null;
	number: string;
	plans: { done: number; total: number } | null;
	status: string | null;
}

export interface RoadmapTableRow {
	milestone: string;
	name: string;
	number: string;
	status: string;
}

export interface RoadmapPart {
	phases: RoadmapPhaseEntry[];
	rows: RoadmapTableRow[];
	truncated: boolean;
}

/** The parse of STATE.md. Never throws. `frontmatter` is the caller's parse of the same text, so it is not parsed twice. */
export function parseStatePart(text: string, frontmatter?: PositionFrontmatter, maxBytes: number = POSITION_MAX_BYTES): PartOutcome<StatePart> {
	return guarded("STATE.md", () => {
		const opened = openDocument(text, "STATE.md", frontmatter, maxBytes);
		if (!opened.ok) return opened;
		const { data, lines } = opened;
		const current = sectionOf(lines, "current position");
		const continuity = sectionOf(lines, "session continuity");

		const phaseLine = current === null ? undefined : fieldOf(current, "phase");
		const phaseValue = phaseLine === undefined ? null : parsePhaseValue(phaseLine);
		const fmPhase = phaseNumberOf(data?.current_phase);
		const fmPhaseName = textOf(data?.current_phase_name);

		let phase: StatePart["phase"] = null;
		if (isCompleteStatus(data?.status)) {
			// The tools say the milestone is closed: no phase is in progress, whatever a stale `current_phase` still holds.
			phase = null;
		} else if (fmPhase !== undefined) {
			const sameInProse = phaseValue?.kind === "phase" && phaseValue.number === fmPhase ? phaseValue.name : null;
			phase = { name: fmPhaseName ?? sameInProse, number: fmPhase };
		} else if (phaseValue?.kind === "phase") {
			phase = { name: phaseValue.name, number: phaseValue.number };
		}

		const planLine = current === null ? undefined : fieldOf(current, "plan");
		const plan: StatePart["plan"] =
			planLine === undefined ? { declared: false, value: null } : { declared: true, value: isNoPlan(planLine) ? null : clean(planLine) };
		const statusLine = current === null ? undefined : fieldOf(current, "status");
		const stoppedLine = continuity === null ? undefined : fieldOf(continuity, "stopped at");

		return {
			ok: true,
			part: {
				milestone: textOf(data?.milestone) ?? (phaseValue?.kind === "milestone-complete" ? clean(phaseValue.milestone) : null),
				milestoneName: textOf(data?.milestone_name),
				phase,
				plan,
				progress: counterProgress(data?.progress),
				status: textOf(data?.status) ?? presentText(statusLine),
				step: textOf(data?.stopped_at) ?? presentText(stoppedLine),
			},
		};
	});
}

/** The parse of ROADMAP.md. Never throws. */
export function parseRoadmapPart(text: string, frontmatter?: PositionFrontmatter, maxBytes: number = POSITION_MAX_BYTES): PartOutcome<RoadmapPart> {
	return guarded("ROADMAP.md", () => {
		const opened = openDocument(text, "ROADMAP.md", frontmatter, maxBytes);
		if (!opened.ok) return opened;

		const byNumber = new Map<string, RoadmapPhaseEntry>();
		const rows: RoadmapTableRow[] = [];
		const seenRows = new Set<string>();
		let truncated = false;
		let current: RoadmapPhaseEntry | null = null;
		let columns = { milestone: 1, status: 3 };

		const entryFor = (number: string): RoadmapPhaseEntry | null => {
			const held = byNumber.get(number);
			if (held !== undefined) return held;
			if (byNumber.size >= POSITION_MAX_ENTRIES) {
				truncated = true;
				return null;
			}
			const created: RoadmapPhaseEntry = { checked: null, items: [], name: null, number, plans: null, status: null };
			byNumber.set(number, created);
			return created;
		};

		let currentLevel = 0;
		for (const line of opened.lines) {
			const heading = headingOf(line);
			if (heading !== null) {
				const detail = DETAIL_TITLE.exec(heading.title);
				if (detail !== null && heading.level >= 2 && heading.level <= 4) {
					current = entryFor(canonicalPhase(detail[1] ?? ""));
					currentLevel = heading.level;
					if (current !== null && current.name === null) current.name = clean(detail[2] ?? "") || null;
				} else if (heading.level <= currentLevel) {
					// A heading of the same or a higher level ends the phase's section; a deeper one (`#### Success criteria`) does not.
					current = null;
				}
				continue;
			}
			const bold = CHECKLIST_BOLD.exec(line);
			const listed = bold ?? CHECKLIST_PLAIN.exec(line);
			if (listed !== null) {
				const entry = entryFor(canonicalPhase(listed[2] ?? ""));
				if (entry !== null) {
					if (entry.checked === null) entry.checked = listed[1] !== " ";
					// A bold title ends at its closing `**`; a plain one runs to the end of the line, with its description after a dash.
					const title = bold !== null ? (listed[3] ?? "") : ((listed[3] ?? "").split(/[ \t]+[—–-][ \t]/)[0] ?? "");
					if (entry.name === null) entry.name = clean(title) || null;
				}
				continue;
			}
			if (line.trimStart().startsWith("|")) {
				const cells = cellsOf(line);
				if (cells.length > 0 && /^phase$/i.test(cells[0] ?? "")) {
					columns = headerColumns(cells);
					continue;
				}
				const row = rowOf(cells, columns);
				if (row === null || seenRows.has(row.number)) continue;
				if (rows.length >= POSITION_MAX_ENTRIES) {
					truncated = true;
					continue;
				}
				seenRows.add(row.number);
				rows.push(row);
				continue;
			}
			if (current === null) continue;
			const status = STATUS_LINE.exec(line);
			if (status !== null) {
				if (current.status === null) current.status = clean(status[1] ?? "") || null;
				continue;
			}
			const plans = PLANS_LINE.exec(line);
			if (plans !== null) {
				const counted = /^(\d+)\/(\d+)\b/.exec((plans[1] ?? "").trim());
				if (counted !== null && current.plans === null) current.plans = { done: Number(counted[1]), total: Number(counted[2]) };
				continue;
			}
			const item = PLAN_ITEM.exec(line);
			if (item !== null && current.items.length < MAX_PLAN_ITEMS) current.items.push({ done: item[1] !== " ", id: item[2] ?? "" });
		}

		const phases = [...byNumber.values()].sort((a, b) => compareNumbers(a.number, b.number));
		for (const entry of phases) {
			if (entry.plans === null && entry.items.length > 0) entry.plans = { done: entry.items.filter((item) => item.done).length, total: entry.items.length };
		}
		return { ok: true, part: { phases, rows: rows.sort((a, b) => compareNumbers(a.number, b.number)), truncated } };
	});
}

/** The position from the two parts, the phase directories and the plan files present. Never throws. */
export function composePosition(input: { state: PartOutcome<StatePart>; roadmap: PartOutcome<RoadmapPart>; phases?: readonly string[]; plans?: readonly string[] }): PositionResult {
	try {
		return compose(input);
	} catch {
		// Totality: a defect here must not take planning_status down. The message is dropped because it could carry parsed text.
		return result([{ code: "internal", detail: "the position could not be composed", where: "STATE.md" }], emptyPosition());
	}
}

/** The position from the text of STATE.md and ROADMAP.md, the phase directories and the plan files present. Never throws. */
export function parsePosition(input: PositionInput): PositionResult {
	try {
		const requested = input.maxBytes;
		const cap = typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0 ? requested : POSITION_MAX_BYTES;
		return composePosition({
			state: outcomeOfText(input.state, "STATE.md", (text) => parseStatePart(text, undefined, cap)),
			roadmap: outcomeOfText(input.roadmap, "ROADMAP.md", (text) => parseRoadmapPart(text, undefined, cap)),
			phases: input.phases,
			plans: input.plans,
		});
	} catch {
		// Totality: a hostile input object (a getter that throws) is an error entry, not an exception.
		return result([{ code: "internal", detail: "the position input could not be read", where: "STATE.md" }], emptyPosition());
	}
}

/** The position with every field unknown. */
export function emptyPosition(): Position {
	return { milestone: null, milestone_name: null, phase: null, plan: null, progress: null, status: null, step: null };
}

// ── composition ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function compose(input: { state: PartOutcome<StatePart>; roadmap: PartOutcome<RoadmapPart>; phases?: readonly string[]; plans?: readonly string[] }): PositionResult {
	const errors: PositionError[] = [];
	if (!input.state.ok) errors.push(input.state.error);
	if (!input.roadmap.ok) errors.push(input.roadmap.error);
	const roadmap = input.roadmap.ok ? input.roadmap.part : null;
	if (roadmap?.truncated === true) {
		errors.push({ code: "truncated", detail: `more than ${POSITION_MAX_ENTRIES} phases or table rows: the rest are not read`, where: "ROADMAP.md" });
	}
	if (!input.state.ok) return result(errors, emptyPosition());
	const state = input.state.part;
	if (isEmptyState(state)) {
		errors.push({ code: "no-position", detail: "no frontmatter position and no Current Position section", where: "STATE.md" });
	}

	const number = state.phase?.number ?? null;
	const entry = number === null ? undefined : roadmap?.phases.find((candidate) => candidate.number === number);
	const row = number === null ? undefined : roadmap?.rows.find((candidate) => candidate.number === number);

	let phase: PositionPhase | null = null;
	if (state.phase !== null) {
		const dirs = directoriesOf(input.phases, state.phase.number);
		if (dirs.length > 1) {
			errors.push({ code: "ambiguous-phase-dir", detail: `phase ${state.phase.number} has ${dirs.length} directories: ${dirs.map((dir) => dir.name).join(", ")}`, where: "phases" });
		}
		phase = {
			name: entry?.name ?? state.phase.name ?? row?.name ?? null,
			number: state.phase.number,
			slug: dirs.length === 1 ? (dirs[0]?.slug ?? null) : null,
		};
	}

	const milestone = state.milestone ?? row?.milestone ?? null;
	const position: Position = {
		milestone,
		milestone_name: state.milestoneName,
		phase,
		plan: phase === null ? null : planOf(state, phase.number, entry, input.plans),
		progress: progressOf(milestone, roadmap, state.progress),
		status: state.status ?? (phase === null ? null : (entry?.status ?? row?.status ?? null)),
		step: state.step,
	};
	return result(errors, position);
}

function result(errors: PositionError[], position: Position): PositionResult {
	const sorted = errors
		.map((error): PositionError => ({ code: error.code, detail: clean(error.detail), where: error.where }))
		.sort((a, b) => compareText(a.where, b.where) || compareText(a.code, b.code) || compareText(a.detail, b.detail));
	return { errors: sorted, ok: sorted.length === 0, position: cleanPosition(position) };
}

/** Every string of the position, redacted and capped once more: the slug and the names come from file names and from other parts. */
function cleanPosition(position: Position): Position {
	const phase = position.phase;
	return {
		milestone: cleanOrNull(position.milestone),
		milestone_name: cleanOrNull(position.milestone_name),
		phase: phase === null ? null : { name: cleanOrNull(phase.name), number: clean(phase.number), slug: cleanOrNull(phase.slug) },
		plan: cleanOrNull(position.plan),
		progress: position.progress === null ? null : { phases_done: position.progress.phases_done, phases_total: position.progress.phases_total },
		status: cleanOrNull(position.status),
		step: cleanOrNull(position.step),
	};
}

function isEmptyState(state: StatePart): boolean {
	return state.milestone === null && state.milestoneName === null && state.phase === null && !state.plan.declared && state.progress === null && state.status === null && state.step === null;
}

/** The phase directories whose number is `number`, as `{ name, slug }`, sorted by name. */
function directoriesOf(names: readonly string[] | undefined, number: string): Array<{ name: string; slug: string }> {
	const found = new Map<string, { name: string; slug: string }>();
	for (const name of boundedNames(names)) {
		const match = PHASE_DIR.exec(name);
		if (match === null || canonicalPhase(match[1] ?? "") !== number) continue;
		found.set(name, { name, slug: match[2] ?? "" });
	}
	return [...found.values()].sort((a, b) => compareText(a.name, b.name));
}

/**
 * The plan in progress. The state's own `Plan:` line decides when it has one, and a line that says there is none (`—`,
 * `Not started`) is a decision too. Only a state with no such line is read from the files: the first plan on disk with no
 * summary, then the first unchecked plan of the roadmap's checklist. Null when every plan is done or none is known.
 */
function planOf(state: StatePart, number: string, entry: RoadmapPhaseEntry | undefined, plans: readonly string[] | undefined): string | null {
	if (state.plan.declared) return state.plan.value;
	const planned = new Set<string>();
	const summarized = new Set<string>();
	for (const name of boundedNames(plans)) {
		const match = PLAN_FILE.exec(name.slice(name.lastIndexOf("/") + 1));
		if (match === null || canonicalPhase(match[1] ?? "") !== number) continue;
		const id = `${match[1]}-${match[2]}`;
		if ((match[3] ?? "").toUpperCase() === "PLAN") planned.add(id);
		else summarized.add(id);
	}
	const open = [...planned].filter((id) => !summarized.has(id)).sort(compareText)[0];
	if (open !== undefined) return `${open}-PLAN`;
	if (planned.size > 0) return null;
	const unchecked = entry?.items.find((item) => !item.done);
	return unchecked === undefined ? null : unchecked.id;
}

/**
 * Phases done and total for the milestone, from the roadmap's progress table. A row is done when its status word says
 * complete (`Complete`, `Complete (PR #91)`); `In review`, `Partial`, `Planned` and `Not started` are not. Without a table
 * row for the milestone the state's own counters are used.
 */
function progressOf(milestone: string | null, roadmap: RoadmapPart | null, counters: StatePart["progress"]): Position["progress"] {
	if (milestone !== null && roadmap !== null) {
		const wanted = milestoneKey(milestone);
		const rows = roadmap.rows.filter((row) => milestoneKey(row.milestone) === wanted);
		if (rows.length > 0) return { phases_done: rows.filter((row) => isDoneStatus(row.status)).length, phases_total: rows.length };
	}
	return counters === null ? null : { phases_done: counters.done, phases_total: counters.total };
}

function milestoneKey(milestone: string): string {
	return milestone.trim().toLowerCase().replace(/^v/, "");
}

function outcomeOfText<T>(text: unknown, where: PositionErrorWhere, parse: (text: string) => PartOutcome<T>): PartOutcome<T> {
	if (text === null || text === undefined) return { ok: false, error: { code: "missing", detail: `${where} was not provided`, where } };
	if (typeof text !== "string") return { ok: false, error: { code: "unreadable", detail: `${where} is not text`, where } };
	return parse(text);
}

// ── reading one document ────────────────────────────────────────────────────────────────────────────────────────────────

type Opened = { ok: true; data: Record<string, unknown> | null; lines: string[] } | { ok: false; error: PositionError };

function openDocument(text: string, where: PositionErrorWhere, given: PositionFrontmatter | undefined, maxBytes: number): Opened {
	if (Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, error: { code: "too-large", detail: `${where} exceeds ${maxBytes} bytes`, where } };
	const frontmatter = given ?? frontmatterOf(text);
	if (frontmatter.state === "malformed") {
		return { ok: false, error: { code: "malformed-frontmatter", detail: "frontmatter has no closing fence or is not a YAML mapping", where } };
	}
	const body = frontmatter.state === "parsed" ? text.replace(FRONTMATTER_BLOCK, "") : text;
	return { ok: true, data: frontmatter.state === "parsed" ? frontmatter.data : null, lines: linesOutsideFences(body) };
}

/**
 * The frontmatter of a text, with the planning index's rule for the opening fence (trailing spaces or tabs after `---` are
 * not part of it) and the shared parser. Only used when the caller has not parsed the frontmatter itself.
 */
function frontmatterOf(text: string): PositionFrontmatter {
	const normalized = text.replace(OPENING_FENCE_TRAILING, "$1");
	if (!FENCE_OPEN.test(normalized)) return { state: "none" };
	const data = parseFrontmatter(normalized);
	return data === null ? { state: "malformed" } : { state: "parsed", data };
}

function guarded<T>(where: PositionErrorWhere, run: () => PartOutcome<T>): PartOutcome<T> {
	try {
		return run();
	} catch {
		// Totality: the parsers are written not to throw. If one does, the file is reported unreadable; the message is dropped because it could carry file text.
		return { ok: false, error: { code: "internal", detail: `${where} could not be parsed`, where } };
	}
}

/** The lines of a body, with the lines of fenced code blocks removed: a heading or a `Status:` line in a code sample is not the document's. */
function linesOutsideFences(body: string): string[] {
	const kept: string[] = [];
	let fence: string | null = null;
	for (const full of body.split(/\r?\n/)) {
		// A line is cut before any pattern runs on it, so a hostile line cannot make a pattern slow.
		const line = full.length > LINE_PREFIX_MAX ? full.slice(0, LINE_PREFIX_MAX) : full;
		const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker !== undefined) {
			if (fence === null) fence = marker.charAt(0);
			else if (marker.charAt(0) === fence) fence = null;
			continue;
		}
		if (fence === null) kept.push(line);
	}
	return kept;
}

function headingOf(line: string): { level: number; title: string } | null {
	const match = HEADING.exec(line);
	return match === null ? null : { level: (match[1] ?? "").length, title: (match[2] ?? "").trimEnd().replace(/[ \t]+#+$/, "") };
}

/** The lines under the first heading whose title is `title` (case and decoration aside), up to the next heading of the same or a higher level. Null when there is none. */
function sectionOf(lines: readonly string[], title: string): string[] | null {
	let level = 0;
	let found = false;
	const section: string[] = [];
	for (const line of lines) {
		const heading = headingOf(line);
		if (!found) {
			if (heading !== null && normalizeTitle(heading.title) === title) {
				found = true;
				level = heading.level;
			}
			continue;
		}
		if (heading !== null && heading.level <= level) break;
		section.push(line);
	}
	return found ? section : null;
}

function normalizeTitle(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The value of the first `Key: value` line (a list bullet and bold markers are allowed), or undefined. */
function fieldOf(lines: readonly string[], key: string): string | undefined {
	const matcher = FIELD_MATCHERS[key];
	if (matcher === undefined) return undefined;
	for (const line of lines) {
		const match = matcher.exec(line);
		if (match !== null) return (match[1] ?? "").trim();
	}
	return undefined;
}

const FIELD_MATCHERS: Readonly<Record<string, RegExp>> = Object.fromEntries(
	["phase", "plan", "status", "stopped at"].map((key) => [key, new RegExp(`^[ \\t]*(?:[-*+][ \\t]+)?(?:\\*\\*|__)?${key.replace(" ", "[ \\t]+")}(?:\\*\\*|__)?[ \\t]*:(?:\\*\\*|__)?[ \\t]*(.*)$`, "i")]),
);

const FENCE_OPEN = /^\ufeff?---\r?\n/;
const OPENING_FENCE_TRAILING = /^(\ufeff?---)[ \t]+(?=\r?\n)/;
const FRONTMATTER_BLOCK = /^\ufeff?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const HEADING = /^(#{1,6})[ \t]+(.+)$/;
const PHASE_DIR = /^(\d+(?:\.\d+)?)-(.+)$/;
const PLAN_FILE = /^(\d+(?:\.\d+)?)-(\d+)-(PLAN|SUMMARY)(?:\.md)?$/i;
const DETAIL_TITLE = /^Phase[ \t]+(\d+(?:\.\d+)?)[ \t]*[:\-–—][ \t]*(.+)$/i;
const CHECKLIST_BOLD = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+\*\*Phase[ \t]+(\d+(?:\.\d+)?)[ \t]*[:\-–—][ \t]*(.+?)\*\*/i;
const CHECKLIST_PLAIN = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+Phase[ \t]+(\d+(?:\.\d+)?)[ \t]*:[ \t]*(.+)$/i;
const STATUS_LINE = /^(?:\*\*|__)?Status(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*(.+)$/i;
const PLANS_LINE = /^(?:\*\*|__)?Plans(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*(.+)$/i;
const PLAN_ITEM = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+(\d+(?:\.\d+)?-\d+-PLAN)(?:\.md)?\b/;

// ── the progress table ──────────────────────────────────────────────────────────────────────────────────────────────────

function cellsOf(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

/** The milestone and status columns from a header row (`Phase | Milestone | Plans Complete | Status | Completed`). A missing one keeps its default place. */
function headerColumns(cells: readonly string[]): { milestone: number; status: number } {
	const milestone = cells.findIndex((cell) => /^milestone$/i.test(cell));
	const status = cells.findIndex((cell) => /^status$/i.test(cell));
	return { milestone: milestone === -1 ? 1 : milestone, status: status === -1 ? 3 : status };
}

function rowOf(cells: readonly string[], columns: { milestone: number; status: number }): RoadmapTableRow | null {
	const head = /^(\d+(?:\.\d+)?)\.[ \t]+(.+)$/.exec(cells[0] ?? "");
	if (head === null || cells.length <= Math.max(columns.milestone, columns.status)) return null;
	return {
		milestone: clean(cells[columns.milestone] ?? ""),
		name: clean(head[2] ?? ""),
		number: canonicalPhase(head[1] ?? ""),
		status: clean(cells[columns.status] ?? ""),
	};
}

/** Whether a status word of the progress table says the phase is done: `Complete`, `Complete (PR #91)`, `Done`, `Shipped`. */
export function isDoneStatus(status: string): boolean {
	return /^(?:[✅✔☑][ \t]*)?(?:complete|completed|done|shipped|passed|verified)\b/iu.test(status.trim());
}

// ── values ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

type PhaseValue = { kind: "phase"; number: string; name: string | null } | { kind: "milestone-complete"; milestone: string } | { kind: "none" } | { kind: "unparsed" };

/**
 * A `Phase:` line of the state: `18 — Guard rails`, `3 of 8 (Auth)`, `106 (Command Center polish) — ...`,
 * `Milestone v1.3 complete`, `None active — ...`. A range (`63-66 built`) or prose (`v1.3.x phases 37-44 open`) names no phase.
 */
function parsePhaseValue(raw: string): PhaseValue {
	const value = raw.trim();
	const complete = /^milestone[ \t]+(v?\d+(?:\.\d+)*(?:\.x)?)[ \t]+(?:complete|completed|shipped|closed|archived)\b/i.exec(value);
	if (complete !== null) return { kind: "milestone-complete", milestone: complete[1] ?? "" };
	if (/^(?:none\b|n\/a\b|null\b|[-–—]+$)/i.test(value)) return { kind: "none" };
	const head = /^(?:phase[ \t]+)?(\d+(?:\.\d+)?)(?![\d.])(?![ \t]*[-–][ \t]*\d)/i.exec(value);
	if (head === null) return { kind: "unparsed" };
	const rest = value
		.slice(head[0].length)
		.replace(/^[ \t]*of[ \t]+\d+/i, "")
		.trim();
	let name: string | null = null;
	const paren = /^\(([^)]*)\)/.exec(rest);
	if (paren !== null) {
		// A short parenthesis is a title (`(Command Center polish)`); a long one with a `;` is a note, which is not a name.
		const inner = (paren[1] ?? "").trim();
		if (inner.length > 0 && inner.length <= 80 && !inner.includes(";")) name = clean(inner);
	} else {
		const dash = /^[—–-][ \t]*(.+)$/.exec(rest);
		if (dash !== null) name = clean((dash[1] ?? "").split(/[ \t]+[—–][ \t]+/)[0] ?? "") || null;
	}
	return { kind: "phase", name, number: canonicalPhase(head[1] ?? "") };
}

/** The phase number of a frontmatter value: a number or `58`, `08`, `Phase 8.1`. Undefined for anything else. */
function phaseNumberOf(value: unknown): string | undefined {
	if (typeof value === "number") {
		const text = String(value);
		return Number.isFinite(value) && /^\d+(?:\.\d+)?$/.test(text) ? canonicalPhase(text) : undefined;
	}
	if (typeof value !== "string") return undefined;
	const match = /^(?:phase[ \t]*)?(\d+(?:\.\d+)?)$/i.exec(value.trim());
	return match === null ? undefined : canonicalPhase(match[1] ?? "");
}

/** A frontmatter value as text: a string, or a number (`milestone: 1.6`). Blank, and the words that mean no value, are null. */
function textOf(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return clean(String(value));
	if (typeof value !== "string") return null;
	return presentText(value) ?? null;
}

function presentText(value: string | undefined): string | null {
	if (value === undefined || isBlank(value)) return null;
	return clean(value) || null;
}

function isBlank(value: string): boolean {
	return /^(?:[-–—~]+|none|n\/a|null|tbd)?$/i.test(value.trim());
}

function isNoPlan(value: string): boolean {
	return isBlank(value) || /^not started\.?$/i.test(value.trim());
}

/** A frontmatter `status` the GSD tools write when the milestone is closed. A sentence that merely mentions `complete` is not one. */
function isCompleteStatus(value: unknown): boolean {
	return typeof value === "string" && /^(?:milestone[ _-])?(?:complete|completed|archived)$/i.test(value.trim());
}

/** `progress.completed_phases` of `progress.total_phases`, when both are whole numbers and the first is not above the second. */
function counterProgress(value: unknown): { done: number; total: number } | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const counters = value as Record<string, unknown>;
	const done = counters.completed_phases;
	const total = counters.total_phases;
	if (typeof done !== "number" || typeof total !== "number") return null;
	if (!Number.isSafeInteger(done) || !Number.isSafeInteger(total) || done < 0 || total < 0 || done > total) return null;
	return { done, total };
}

// ── text ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One line of text, made safe to return: whitespace folded, redacted, then capped. Redaction runs before the cut so a cut cannot hide a token from it. */
function clean(value: string): string {
	const flat = value
		.slice(0, LINE_PREFIX_MAX)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strips C0/DEL control characters and line separators from untrusted text
		.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const safe = redact(flat);
	if (safe.length <= POSITION_STRING_MAX) return safe;
	const cut = safe.slice(0, POSITION_STRING_MAX - 1);
	// Never end on half of a surrogate pair.
	const last = cut.charCodeAt(cut.length - 1);
	return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`;
}

function cleanOrNull(value: string | null): string | null {
	return value === null ? null : clean(value);
}

function boundedNames(names: readonly string[] | undefined): string[] {
	if (!Array.isArray(names)) return [];
	return names.slice(0, MAX_NAMES).filter((name): name is string => typeof name === "string");
}

/** A phase number without leading zeros: `08` is `8`, `08.1` is `8.1`, `0` and `0.5` stay. */
function canonicalPhase(number: string): string {
	return number.replace(/^0+(?=\d)/, "");
}

/** Phase numbers in numeric order: `8` before `8.1` before `9` before `10`. */
function compareNumbers(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const difference = (left[index] ?? -1) - (right[index] ?? -1);
		if (difference !== 0) return difference;
	}
	return compareText(a, b);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
