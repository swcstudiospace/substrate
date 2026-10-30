/**
 * The brief's live session sections (phase 67, live steering GA), behind `SUBSTRATE_BRIEF_SESSIONS`.
 *
 * Three sections join the brief when the flag is on: `sessions` (the other live sessions of the repository, from the session
 * context digest), `steering` (the caller's own pending directives and session state, when it names a session) and `handoffs`
 * (the open handoff packets of the graph the brief is about). Each is at most {@link BRIEF_SESSIONS_SECTION_MAX_CHARS}
 * characters, counted over the lines it prints, and a section that does not fit says how many lines it left out.
 *
 * They are built per request and appended after the cached sections, never stored in the brief cache: they depend on the
 * caller's session and on who is alive now. Everything here is pure; the service reads the sources. Every string passes the
 * redactor, a directive body is quoted as data under a title that says it is described and not executed, and a coarse age
 * ("5 min ago") keeps the text from changing on every call.
 *
 * A fourth section, `worktrees` (phase 68, FLEET-06), follows the worktree registry instead of this flag: with
 * `SUBSTRATE_WORKTREE_REGISTRY` on and a request that names a repository and its own session, it lists other sessions'
 * worktrees of that repository that touch files this session's worktree touches. It reads one bounded registry query,
 * names only what the registry holds, and is built per request like the others.
 */
import { foldLine, type BriefItem, type BriefSection, type BriefSectionId } from "./brief-profile.ts";
import { DeadlineError } from "./deadline.ts";
import { redact } from "./redact.ts";
import type { SessionContext } from "./session-context.ts";
import type { WorktreePrState } from "./worktree-registry.ts";

/** The most characters one section prints (its blank separator, title and lines). */
export const BRIEF_SESSIONS_SECTION_MAX_CHARS = 1_200;
/** The longest one line may be, so a single long value cannot be the whole section. */
const LINE_MAX_CHARS = 160;
const DIRECTIVE_BODY_CHARS = 120;
/** The most handoff packets the brief's handoffs section lists. */
export const BRIEF_HANDOFFS_MAX = 10;

/** Coarse and stable: whole minutes, hours or days, so the brief's text does not change between two calls a second apart. */
export function coarseAge(ageS: number): string {
	if (ageS < 60) return "just now";
	const minutes = Math.floor(ageS / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

const clip = (text: string, max: number): string => {
	const folded = foldLine(redact(text));
	return folded.length <= max ? folded : `${folded.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
};

/**
 * One section from its title and item lines, held to {@link BRIEF_SESSIONS_SECTION_MAX_CHARS}. Items are kept in order while
 * they fit with a closing "… and N more" line; the rest are counted into that line, which is itself inside the bound.
 */
function bounded(id: BriefSectionId, title: string, lines: readonly string[], omitLabel: string): BriefSection {
	return boundedGroups(id, title, lines.map((line) => [line]), omitLabel);
}

/**
 * {@link bounded} for items of several lines that must stay together: a group is kept whole or not at all, and the closing
 * line counts groups. `extraOmitted` is the number of groups the caller left out before this (a cap of its own), so the
 * notice names them too.
 */
function boundedGroups(
	id: BriefSectionId,
	title: string,
	groups: ReadonlyArray<readonly string[]>,
	omitLabel: string,
	extraOmitted = 0,
	oneItemPerGroup = false,
	itemOf?: (index: number, texts: readonly string[]) => BriefItem,
): BriefSection {
	const heading = clip(title, LINE_MAX_CHARS * 2);
	const fixed = 1 + heading.length + 1;
	const kept: string[] = [];
	const keptGroupsList: string[][] = [];
	let keptGroups = 0;
	let used = fixed;
	for (const group of groups) {
		const texts = group.map((line) => (line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS - 1)}…` : line));
		const size = texts.reduce((sum, text) => sum + text.length + 1, 0);
		const remaining = groups.length - keptGroups - 1 + extraOmitted;
		// A group is kept only when it, and the notice for everything after it, still fit.
		const notice = remaining > 0 ? `… and ${remaining} more ${omitLabel}`.length + 1 : 0;
		if (used + size + notice > BRIEF_SESSIONS_SECTION_MAX_CHARS) break;
		kept.push(...texts);
		keptGroupsList.push(texts);
		keptGroups += 1;
		used += size;
	}
	const left = groups.length - keptGroups + extraOmitted;
	const notice = left > 0 ? `… and ${left} more ${omitLabel}` : null;
	const printed = notice === null ? kept : [...kept, notice];
	// Compact drops items from the end and clips each item to the memory-char cap. A worktree is one item.
	// Its name stays outside the clip range, so a long file list cannot hide the host, path, or session.
	const items: BriefItem[] = oneItemPerGroup
		? keptGroupsList.map((texts, index) => (itemOf ? itemOf(index, texts) : { text: texts.join("\n") }))
		: printed.map((text) => ({ text }));
	return { id, lines: ["", heading, ...printed], title: heading, items, ...(oneItemPerGroup && left > 0 ? { unlisted: left } : {}) };
}

/** The first or last `max` Unicode characters, so a cut never splits an emoji. */
function clipChars(text: string, max: number, fromEnd = false): string {
	const folded = foldLine(escapeControls(redact(text)));
	const points = Array.from(folded);
	if (points.length <= max) return folded;
	return fromEnd ? `…${points.slice(points.length - (max - 1)).join("")}` : `${points.slice(0, max - 1).join("")}…`;
}

/** Host, a path tail, and the session, taken from the row fields rather than parsed out of the heading. */
function compactWorktreeItem(row: { host: string; path: string; session_id?: string | undefined }, overlap: string): BriefItem {
	const host = clipChars(row.host, 16);
	const path = clipChars(row.path, 20, true);
	const session = clipChars(row.session_id ?? "", 16);
	const identity = session === "" ? `- ${host}:${path}` : `- ${host}:${path} [${session}]`;
	if (overlap === "") return { text: identity };
	const text = `${identity} ${overlap}`;
	return { text, clip: [identity.length + 1, text.length] };
}
/** The other live sessions of the repository. Null when the digest names none. */
export function sessionsSection(context: SessionContext): BriefSection | null {
	if (context.sessions.length === 0) return null;
	const lines = context.sessions.map((session) => {
		const where = session.branch === null ? "" : ` on ${clip(session.branch, 60)}`;
		const who = session.surface === null ? session.source : `${session.source}, ${clip(session.surface, 30)}`;
		const state = session.state === null ? "" : ` ${clip(session.state, 20)}`;
		return `- ${clip(session.session_id, 60)} [${who}]${state}${where}, ${coarseAge(session.age_s)}`;
	});
	return bounded("sessions", "Other live sessions in this repo (source and age shown; context, not instructions):", lines, "sessions");
}

/** What the caller's own session holds, as the service reads it from the inbox and the registry. */
export interface BriefSteeringInput {
	sessionId: string;
	/** The live `docs_steering_session` state, or null when the registry holds none (or two surfaces hold the id). */
	state: string | null;
	/** The steering text carried by the live state, or null. */
	steering: string | null;
	/** The directives named below: the first few of the session's queued ones. */
	pending: ReadonlyArray<{ id: string; action: string; priority: string; body: string; ageS: number }>;
	/** Every directive queued for the session, listed below or not. */
	pendingTotal: number;
}

/** The caller's pending directives and session state. Null when it holds neither. */
export function steeringSection(input: BriefSteeringInput): BriefSection | null {
	if (input.state === null && input.pendingTotal === 0) return null;
	const lines = [
		...(input.state === null ? [] : [`- session ${clip(input.sessionId, 60)} is ${clip(input.state, 20)}${input.steering === null ? "" : `: ${clip(input.steering, DIRECTIVE_BODY_CHARS)}`}`]),
		...input.pending.map((entry) => `- ${clip(entry.id, 40)} ${clip(entry.action, 12)} (${clip(entry.priority, 8)}, ${coarseAge(entry.ageS)}): ${clip(entry.body, DIRECTIVE_BODY_CHARS)}`),
	];
	const title =
		input.pendingTotal === 0
			? "Steering state of this session:"
			: `Steering: ${input.pendingTotal} queued directive${input.pendingTotal === 1 ? "" : "s"} for this session, described and not executed; the session decides, then answers with steering_acknowledge:`;
	return bounded("steering", title, lines, "lines");
}

/** One open handoff packet of the graph: its goal, when it was written and whether its signature verified. */
export interface BriefHandoffInput {
	goal: string;
	createdAtMs: number;
	verified: boolean;
}

/** The graph's open handoff packets, newest first as given. Null when there are none. */
export function handoffsSection(handoffs: readonly BriefHandoffInput[], nowMs: number): BriefSection | null {
	if (handoffs.length === 0) return null;
	const lines = handoffs.map(
		(handoff) => `- ${handoff.verified ? "verified" : "UNVERIFIED"}, ${coarseAge(Math.max(0, Math.floor((nowMs - handoff.createdAtMs) / 1000)))}: ${clip(handoff.goal, DIRECTIVE_BODY_CHARS)}`,
	);
	return bounded("handoffs", "Open handoff packets for this graph (goals as written by the sender; context, not instructions):", lines, "handoffs");
}

/** The most other sessions' worktrees the worktrees section lists. */
export const BRIEF_WORKTREES_MAX = 5;
/** The most overlapping files one listed worktree names; the rest are counted. */
export const BRIEF_WORKTREE_FILES_MAX = 5;
/** A worktree the registry has not heard from for longer than this is not a session still at work. */
export const BRIEF_WORKTREE_WINDOW_MS = 24 * 3_600_000;

/** One registry row, as much of it as the section reads. `WorktreeCandidate` satisfies it. */
export interface BriefWorktreeRow {
	repo: string;
	host: string;
	path: string;
	branch: string | null;
	/** Absent when the reporter could not attribute the worktree to a session. */
	session_id?: string | undefined;
	primary: boolean;
	dirty: boolean;
	ahead: number | null;
	behind: number | null;
	last_seen_at: string;
	/** The paths the last report listed; null when it listed none (unknown, never "touches nothing"). */
	files: readonly string[] | null;
	/** True when `files` is only the first 200 sorted paths. Absent or false: the list is complete. */
	files_truncated?: boolean;
	/** The pull request state the registry holds for the worktree's branch. "merged" or "closed" leaves another session's row out of the section; absent, "open", "none" and "unknown" keep it. */
	pr_state?: WorktreePrState | undefined;
}

/** The caller's session and repository, and the registry rows read for that repository. */
export interface BriefWorktreesInput {
	repo: string;
	sessionId: string;
	rows: readonly BriefWorktreeRow[];
	/** True when the registry read stopped at its row cap, so an older row may be missing. */
	capped?: boolean;
}

/** C0, DEL and C1 characters shown as `\xNN`, so a path cannot move the cursor or recolour the reader's terminal. */
function escapeControls(text: string): string {
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? `\\x${code.toString(16).padStart(2, "0")}` : char;
	}
	return out;
}

const shown = (text: string, max: number): string => clip(escapeControls(redact(text)), max);

/** Like {@link shown} but keeps the end of a long path, where the directory or file name that tells two worktrees apart is. */
function shownTail(text: string, max: number): string {
	const folded = foldLine(escapeControls(redact(text)));
	return folded.length <= max ? folded : `…${folded.slice(folded.length - (max - 1))}`;
}

function byCodeUnit(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

/** The line naming the files two worktrees share: at most {@link BRIEF_WORKTREE_FILES_MAX}, fewer when the line would not fit, then "and N more". */
function overlapLine(shared: readonly string[]): string {
	const compose = (count: number): string => {
		const rest = shared.length - count;
		return `  overlap ${shared.length}: ${shared.slice(0, count).map((file) => shownTail(file, 48)).join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
	};
	let count = Math.min(shared.length, BRIEF_WORKTREE_FILES_MAX);
	let line = compose(count);
	while (line.length > LINE_MAX_CHARS && count > 1) {
		count -= 1;
		line = compose(count);
	}
	return line;
}

/**
 * Other sessions' worktrees of the caller's repository that touch a file the caller's own worktrees touch, most overlap
 * first, then most recently seen, at most {@link BRIEF_WORKTREES_MAX}. The caller's files are the union of its own rows'
 * reported paths (rows whose `session_id` is the caller's); with none reported the section is one line saying so, so it never
 * silently vanishes. A row is another session's only when it names a session other than the caller's, is not the primary
 * checkout, whose pull request is not merged or closed, was seen within {@link BRIEF_WORKTREE_WINDOW_MS} and reported its files. A row with `files_truncated` means a
 * shared path may sit past the first 200, so the section says the check is incomplete even when no reported path overlaps.
 * Null when nothing overlaps and every reported list is complete.
 */
export function worktreesSection(input: BriefWorktreesInput, nowMs: number): BriefSection | null {
	const repo = input.repo.toLowerCase();
	// A row of another repository is never read, whatever the caller of this function handed over.
	const inRepo = input.rows.filter((row) => row.repo.toLowerCase() === repo);
	// A merged or closed pull request's row is left out only when its worktree is clean: pr_state describes the branch's PR history, not fresh edits made after it merged.
	const finished = (row: BriefWorktreeRow): boolean => (row.pr_state === "merged" || row.pr_state === "closed") && row.dirty !== true;
	const live = inRepo.filter((row) => row.session_id === input.sessionId || !finished(row));
	const incomplete = live.some((row) => row.files_truncated === true);
	const incompleteLine = "- overlap check incomplete: a report listed only its first 200 changed paths, so a shared path may be missing";
	const own = new Set<string>();
	let ownReported = false;
	for (const row of inRepo) {
		if (row.session_id !== input.sessionId || row.files === null) continue;
		ownReported = true;
		for (const file of row.files) own.add(file);
	}
	const readCapped = input.capped === true;
	const callerInSlice = inRepo.some((row) => row.session_id === input.sessionId);
	if (!ownReported) {
		const line = readCapped && !callerInSlice
			? "- the registry read was capped, so this session's report was not in the slice; overlapping worktrees cannot be named"
			: "- your own worktree has not reported its files, so other sessions' overlapping worktrees cannot be named (substrate worktree scan --report)";
		return bounded("worktrees", "Worktree overlap:", [line], "lines");
	}
	const overlapping: Array<{ row: BriefWorktreeRow; shared: string[]; seenMs: number }> = [];
	for (const row of inRepo) {
		if (row.session_id === undefined || row.session_id === "" || row.session_id === input.sessionId || row.primary || row.files === null || finished(row)) continue;
		const seenMs = Date.parse(row.last_seen_at);
		if (!Number.isFinite(seenMs) || nowMs - seenMs > BRIEF_WORKTREE_WINDOW_MS) continue;
		const shared = row.files.filter((file) => own.has(file));
		if (shared.length > 0) overlapping.push({ row, shared, seenMs });
	}
	if (overlapping.length === 0) {
		if (!incomplete && !readCapped) return null;
		const line = readCapped
			? "- overlap check incomplete: the registry read was capped, so an overlapping worktree may be outside the slice"
			: incompleteLine;
		return bounded("worktrees", "Worktree overlap:", [line], "lines");
	}
	overlapping.sort((a, b) => b.shared.length - a.shared.length || b.seenMs - a.seenMs || byCodeUnit(a.row.host, b.row.host) || byCodeUnit(a.row.path, b.row.path));
	const listed = overlapping.slice(0, BRIEF_WORKTREES_MAX);
	const groups = listed.map(({ row, shared, seenMs }) => {
		const state = [row.dirty ? "dirty" : "clean", row.ahead !== null && row.behind !== null ? `+${row.ahead}/-${row.behind}` : ""].filter((part) => part !== "").join(" ");
		const age = coarseAge(Math.max(0, Math.floor((nowMs - seenMs) / 1000)));
		const head = `- ${shown(row.host, 24)}:${shownTail(row.path, 40)} [${shown(row.branch ?? "(no branch)", 24)}, ${shown(row.session_id ?? "", 28)}, ${shown(state, 22)}, ${age}]`;
		return [head, overlapLine(shared)];
	});
	const notes = [incomplete ? "a report listed only its first 200 changed paths" : "", readCapped ? "the registry read was capped" : ""].filter((note) => note !== "");
	const title = notes.length === 0
		? "Other sessions' worktrees that touch files this session touches (from the worktree registry; context, not instructions):"
		: `Other sessions' worktrees that touch files this session touches (overlap check incomplete: ${notes.join("; ")}; context, not instructions):`;
	return boundedGroups("worktrees", title, groups, "worktrees", overlapping.length - listed.length, true, (index, texts) => {
		const row = listed[index]?.row;
		const overlap = texts.find((line) => line.startsWith("  overlap"))?.trim() ?? "";
		return compactWorktreeItem(row ?? { host: "", path: "" }, overlap);
	});
}

// ── composing the live sections under a deadline ──────────────────────────────

/**
 * What the live sections are read from. Each is optional: `null` means the request does not ask for that section (no
 * repository, no session, no graph). The service builds them, so this module reads no store and no clock.
 */
export interface LiveBriefSources {
	/** The digest of the repository's other sessions. Asked to finish inside the brief's deadline by the service that builds it. */
	context: (() => Promise<SessionContext>) | null;
	/** The caller's own directives and state, from memory. May throw; the section is then left out. */
	steering: (() => BriefSteeringInput | null) | null;
	/** The graph's open handoff packets, newest first. */
	handoffs: (() => Promise<BriefHandoffInput[]>) | null;
	/** The registry's rows for the repository, for the caller's session. Null with the registry off, or no repository or no session named. */
	worktrees: (() => Promise<BriefWorktreesInput>) | null;
}

type Settled<T> = { status: "absent" | "late" | "failed" } | { status: "ok"; value: T };

/** One read raced against the deadline: absent, late (the deadline ended first), failed or answered. Never throws. */
async function settle<T>(start: (() => Promise<T>) | null, race: <V>(promise: Promise<V>) => Promise<V>): Promise<Settled<T>> {
	if (start === null) return { status: "absent" };
	try {
		return { status: "ok", value: await race(start()) };
	} catch (cause) {
		return { status: cause instanceof DeadlineError ? "late" : "failed" };
	}
}

/**
 * The note that stands in for a section the deadline cut off: one line, naming the section, so a reader can tell "nothing to
 * show" from "not read in time". It is the section's id and priority, so the brief's size bound treats it like the section.
 */
export function lateSection(id: BriefSectionId, what: string): BriefSection {
	return bounded(id, `Live ${what} not included: not ready before the brief's deadline.`, [], "lines");
}

/**
 * The live sections in print order (sessions, steering, handoffs, worktrees). The reads that touch a store start together and
 * race `race`, the brief's own deadline: one that is not ready when it ends is dropped for a one-line note, and the rest of the
 * brief is never held for it. A sessions or handoffs read that fails is left out without a note, as an absent one is; a
 * worktrees read that fails is replaced by a one-line note, because its absence would read as "no overlap". Never throws.
 */
export async function composeLiveSections(sources: LiveBriefSources, race: <V>(promise: Promise<V>) => Promise<V>, nowMs: number): Promise<BriefSection[]> {
	const [context, handoffs, worktrees] = await Promise.all([settle(sources.context, race), settle(sources.handoffs, race), settle(sources.worktrees, race)]);
	const sections: Array<BriefSection | null> = [];
	if (context.status === "ok") sections.push(sessionsSection(context.value));
	else if (context.status === "late") sections.push(lateSection("sessions", "sessions"));
	try {
		const input = sources.steering === null ? null : sources.steering();
		sections.push(input === null ? null : steeringSection(input));
	} catch {
		// Fail-open: the steering section is a courtesy, and the in-memory read that failed leaves the rest of the brief alone.
		sections.push(null);
	}
	if (handoffs.status === "ok") {
		const open = handoffs.value
			.filter((entry) => Number.isFinite(entry.createdAtMs))
			.sort((a, b) => b.createdAtMs - a.createdAtMs)
			.slice(0, BRIEF_HANDOFFS_MAX);
		sections.push(handoffsSection(open, nowMs));
	} else if (handoffs.status === "late") {
		sections.push(lateSection("handoffs", "handoffs"));
	}
	if (worktrees.status === "ok") sections.push(worktreesSection(worktrees.value, nowMs));
	else if (worktrees.status === "late") sections.push(lateSection("worktrees", "worktrees"));
	// A failed read is noted, not dropped: its absence would read as "no overlap".
	else if (worktrees.status === "failed") sections.push(bounded("worktrees", "Live worktrees not included: the read failed.", [], "lines"));
	return sections.filter((section): section is BriefSection => section !== null);
}
