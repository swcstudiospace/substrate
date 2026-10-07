/**
 * `substrate lessons` — the lessons bank (SPE-5830, Tier 1).
 *
 *   substrate lessons add --text T --phase P ...      one lesson, from text
 *   substrate lessons add --from SUMMARY.md ...       every bullet under `## Lessons`
 *   substrate lessons recall [QUERY]                  a `## Prior Lessons` block for CONTEXT.md
 *   substrate lessons digest <milestone>              roll a milestone's lessons up into one fact
 *   substrate lessons outcome <id> --result R ...     report how a cited lesson worked out
 *
 * A lesson is one governed `fact`, written through `POST /memory` like any other
 * memory, so RBAC, quarantine and exactly-once apply to it without a line of code
 * here. There is no lessons table, kind or write path (the Decision in
 * `docs/research/self-improving-memory-bank-proposal.md`): what the gate has no
 * column for — milestone, phase, outcome, tags, source — travels in a header at
 * the top of the body, and everything derived — ranking, digests, success scores —
 * is computed here on read, from facts that only ever append.
 *
 * See `docs/lessons-bank.md`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { list, parseArgs, str, type Args } from "./args.ts";

/** The gate's cap. A longer body would be cut silently, so it is refused here instead. */
export const MAX_BODY = 4000;
/** `normalizeSubject`'s cap: a subject the server cut would not be the one computed here. */
const MAX_SUBJECT = 200;
const MAX_SLUG = 60;
/** `memory_search`'s own ceiling, and the size of every page this module asks for. */
const SEARCH_LIMIT = 100;
/**
 * How many pages one subject family is read to: 5000 entries. Far past any bank this
 * CLI expects, and a bound on a cursor that, through a bug on either side, never ends.
 * Hitting it is said on stderr, never silently.
 */
const MAX_PAGES = 50;
const DEFAULT_RECALL_LIMIT = 5;
const MAX_RECALL_LIMIT = 20;
const DEFAULT_HALF_LIFE_DAYS = 90;
/** Each term costs one search on an older server; past a handful the query is a paragraph, not a topic. */
const MAX_QUERY_TERMS = 6;
const DAY_MS = 86_400_000;
/**
 * Longer than the hooks' 1.5 s on purpose. Nothing waits on a lessons command, and a
 * write cut off mid-flight is one whose outcome nobody knows.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The word on each body's first line: it says the lines below it are a header.
 *
 * It is also what reads fall back to on a substrate whose `memory_search` predates
 * `subject_prefix`. That search matches bodies only and returns the newest 100 per
 * scope, so without a word every lesson carries, the repo's other memories would crowd
 * the lessons out of their own search; three distinct words, so outcomes and digests
 * cannot crowd lessons out either. On a current substrate reads list by subject and
 * the marker narrows nothing. Either way the subject decides what an entry is.
 */
const MARKERS = { lesson: "lessonbank", digest: "lessonbankdigest", outcome: "lessonbankoutcome" } as const;

export const SUBJECT = { lesson: "lesson:", digest: "lesson-digest:", outcome: "lesson-outcome:" } as const;

export const LESSON_OUTCOMES = ["success", "partial", "blocked", "deferred"] as const;
export type LessonOutcome = (typeof LESSON_OUTCOMES)[number];

export const OUTCOME_RESULTS = ["success", "partial", "failure"] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];
const RESULT_WEIGHT: Record<OutcomeResult, number> = { success: 1, partial: 0.5, failure: 0 };

/** Words that say nothing about what a lesson is about, in a slug or a query. */
const STOPWORDS: Record<string, true> = Object.fromEntries(
	[
		"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "into", "is", "it",
		"its", "of", "on", "or", "that", "the", "their", "this", "to", "was", "were", "when", "with", "not", "no",
	].map((word) => [word, true]),
);

export interface Lesson {
	milestone: string;
	phase: string;
	slug: string;
	outcome: LessonOutcome;
	tags: string[];
	/** The repo-relative path the lesson came from, or `inline:<milestone>/<phase>`. */
	source: string;
	text: string;
}

/** The fields of a `memory_search` entry this module reads. */
export interface StoredEntry {
	id: string;
	kind?: string;
	subject?: string | null;
	text: string;
	created: string;
	needs_reverification?: boolean;
}

/** A lesson or a digest, as recall sees it: something a plan can cite by id. */
export interface Citable {
	id: string;
	subject: string;
	created: string;
	milestone: string;
	phase: string | null;
	outcome: string | null;
	tags: string[];
	source: string | null;
	text: string;
	digest: boolean;
	/** On a digest, the lesson ids it rolls up. */
	rollsUp: string[];
	/** The entry has outlived its trust and should be checked before it is acted on. */
	stale: boolean;
}

export interface OutcomeRecord {
	id: string;
	lesson: string;
	result: OutcomeResult;
	milestone: string | null;
	phase: string | null;
	created: string;
}

class UsageError extends Error {}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

// ── identity ─────────────────────────────────────────────────────────────────

/**
 * Lowercase, and only characters a subject keeps as they are. The server lowercases
 * subjects, so this keeps the subject computed here and the one stored identical.
 */
export function identifier(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
}

/** The first few words that carry meaning, so a subject says what the lesson is about. */
export function slugify(text: string): string {
	const words = text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0 && !STOPWORDS[word]);
	let slug = "";
	for (const word of words.slice(0, 6)) {
		const next = slug ? `${slug}-${word}` : word;
		if (next.length > MAX_SLUG) break;
		slug = next;
	}
	return slug || words[0]?.slice(0, MAX_SLUG) || "lesson";
}

export function lessonSubject(milestone: string, phase: string, slug: string): string {
	const prefix = `${SUBJECT.lesson}${milestone}/${phase}/`;
	const room = MAX_SUBJECT - prefix.length;
	if (room < 8) throw new UsageError(`milestone and phase leave no room for a slug under the 200-character subject cap: ${prefix}`);
	return prefix + slug.slice(0, room).replace(/-+$/, "");
}

/** Whitespace-collapsed, so re-wrapping a SUMMARY bullet does not make it a new lesson. */
export function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * `lesson:` + sha256 of the source path and the content, as the Decision fixes it:
 * the same text from the same artifact is one lesson however often it is added.
 */
export function lessonKey(source: string, text: string): string {
	return `${SUBJECT.lesson}${sha256(`${source}\n${normalizeText(text)}`)}`;
}

/** The marker line, `key: value` header lines, a blank line, then the lesson. */
export function lessonBody(lesson: Lesson): string {
	return [
		`[${MARKERS.lesson}]`,
		`milestone: ${lesson.milestone}`,
		`phase: ${lesson.phase}`,
		`outcome: ${lesson.outcome}`,
		...(lesson.tags.length > 0 ? [`tags: ${lesson.tags.join(", ")}`] : []),
		`source: ${lesson.source}`,
		"",
		normalizeText(lesson.text),
	].join("\n");
}

/**
 * A digest names every lesson it rolls up — that list is what recall excludes by —
 * and then what those lessons said, so the digest is worth recalling in their place.
 * When the whole does not fit the gate's 4000 characters the summaries go first and
 * the ids stay; a digest that cannot list all its ids is refused (null), not cut.
 */
export function digestBody(milestone: string, lessons: ReadonlyArray<Citable | string>, text?: string): string | null {
	const ids = lessons.map((lesson) => (typeof lesson === "string" ? lesson : lesson.id));
	const header = [`[${MARKERS.digest}]`, `milestone: ${milestone}`, `lessons: ${ids.join(", ")}`, ""];
	const intro = text?.trim()
		? normalizeText(text)
		: `Milestone ${milestone} rolls up ${ids.length} lesson${ids.length === 1 ? "" : "s"}.`;
	const full = lessons.map((lesson) => {
		if (typeof lesson === "string") return `- ${lesson}`;
		const said = normalizeText(lesson.text);
		return `- ${lesson.id} ${lesson.subject}: ${said.length > 200 ? `${said.slice(0, 199)}…` : said}`;
	});
	const bare = lessons.map((lesson) => (typeof lesson === "string" ? `- ${lesson}` : `- ${lesson.id} ${lesson.subject}`));
	for (const lines of [full, bare, []]) {
		const body = [...header, intro, ...lines].join("\n");
		if (body.length <= MAX_BODY) return body;
	}
	return null;
}

// ── reading entries back ─────────────────────────────────────────────────────

interface ParsedBody {
	marker: string | null;
	fields: Map<string, string>;
	text: string;
}

function parseBody(body: string): ParsedBody {
	const lines = body.split("\n");
	const marker = /^\[([a-z]+)\]$/.exec(lines[0]?.trim() ?? "")?.[1] ?? null;
	if (!marker) return { marker: null, fields: new Map(), text: body.trim() };
	const fields = new Map<string, string>();
	let line = 1;
	for (; line < lines.length; line++) {
		const raw = lines[line]?.trim() ?? "";
		if (raw === "") break;
		const field = /^([a-z-]+):\s*(.*)$/.exec(raw);
		if (field?.[1]) fields.set(field[1], (field[2] ?? "").trim());
	}
	return { marker, fields, text: lines.slice(line + 1).join("\n").trim() };
}

export function citableLesson(entry: StoredEntry): Citable | null {
	const subject = entry.subject ?? "";
	if ((entry.kind !== undefined && entry.kind !== "fact") || !subject.startsWith(SUBJECT.lesson)) return null;
	const [milestone = "", phase = null] = subject.slice(SUBJECT.lesson.length).split("/");
	const body = parseBody(entry.text);
	// A `lesson:` fact written without the header — by hand, or by a swarm retro that
	// follows the subject convention — is still a lesson: its subject carries the
	// milestone and phase the header would have.
	const headed = body.marker === MARKERS.lesson;
	const fields = headed ? body.fields : new Map<string, string>();
	return {
		id: entry.id,
		subject,
		created: entry.created,
		milestone: fields.get("milestone") ?? milestone,
		phase: fields.get("phase") ?? phase,
		outcome: fields.get("outcome") ?? null,
		tags: splitList(fields.get("tags")),
		source: fields.get("source") ?? null,
		text: headed ? body.text : entry.text.trim(),
		digest: false,
		rollsUp: [],
		stale: entry.needs_reverification === true,
	};
}

export function citableDigest(entry: StoredEntry): Citable | null {
	const subject = entry.subject ?? "";
	if ((entry.kind !== undefined && entry.kind !== "fact") || !subject.startsWith(SUBJECT.digest)) return null;
	const body = parseBody(entry.text);
	// Without its header a digest names no lessons, so it would exclude nothing.
	if (body.marker !== MARKERS.digest) return null;
	return {
		id: entry.id,
		subject,
		created: entry.created,
		milestone: body.fields.get("milestone") ?? subject.slice(SUBJECT.digest.length),
		phase: null,
		outcome: null,
		tags: [],
		source: null,
		text: body.text,
		digest: true,
		rollsUp: splitList(body.fields.get("lessons")).map((id) => id.toLowerCase()),
		stale: entry.needs_reverification === true,
	};
}

export function outcomeRecord(entry: StoredEntry): OutcomeRecord | null {
	const subject = entry.subject ?? "";
	if ((entry.kind !== undefined && entry.kind !== "fact") || !subject.startsWith(SUBJECT.outcome)) return null;
	const body = parseBody(entry.text);
	const result = body.fields.get("result");
	if (body.marker !== MARKERS.outcome || !(OUTCOME_RESULTS as readonly string[]).includes(result ?? "")) return null;
	return {
		id: entry.id,
		// The subject is the identity the gate stored, so it decides which lesson this is about.
		lesson: subject.slice(SUBJECT.outcome.length),
		result: result as OutcomeResult,
		milestone: body.fields.get("milestone") || null,
		phase: body.fields.get("phase") || null,
		created: entry.created,
	};
}

// ── scoring and ranking ──────────────────────────────────────────────────────

/**
 * A lesson's success score, from the outcome facts that name it.
 *
 * Laplace-smoothed, (1 + Σ weight) / (2 + n) with success 1, partial ½, failure 0:
 * a lesson nobody has reported on is 0.5 rather than 0 or 1, and one report moves it
 * without pinning it. Only the newest report per citing phase counts — a phase that
 * changes its verdict appends a second fact, since nothing is edited in place, and
 * counting both would let one phase vote twice.
 */
export function scoreOf(outcomes: readonly OutcomeRecord[]): { score: number; count: number } {
	const latest = new Map<string, OutcomeRecord>();
	for (const outcome of [...outcomes].sort((a, b) => Date.parse(a.created) - Date.parse(b.created))) {
		// A report that names no phase cannot be matched to another use, so it stands alone.
		const use = outcome.milestone && outcome.phase ? `${outcome.milestone}/${outcome.phase}` : outcome.id;
		latest.set(use, outcome);
	}
	let sum = 0;
	for (const outcome of latest.values()) sum += RESULT_WEIGHT[outcome.result];
	return { score: (1 + sum) / (2 + latest.size), count: latest.size };
}

export function queryTerms(query: string): string[] {
	const terms = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length >= 2 && !STOPWORDS[term]);
	return [...new Set(terms)];
}

/** A crude plural fold, so "leases" finds "lease". Anything smarter is the server search's job. */
function stem(word: string): string {
	return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/**
 * How well an entry matches the query, 0..1. A term found in a tag counts 1, a term
 * found only in the subject or the text counts ½: a tag is the author saying what the
 * lesson is about, a word in passing is weaker evidence.
 */
export function matchScore(terms: readonly string[], item: Citable): number {
	if (terms.length === 0) return 1;
	const tagWords = item.tags.flatMap((tag) => tag.toLowerCase().split(/[^a-z0-9]+/));
	const textWords = `${item.subject} ${item.text}`.toLowerCase().split(/[^a-z0-9]+/);
	let total = 0;
	for (const term of terms) {
		const root = stem(term);
		if (tagWords.some((word) => word.startsWith(root))) total += 1;
		else if (textWords.some((word) => word.startsWith(root))) total += 0.5;
	}
	return total / terms.length;
}

export interface RankOptions {
	query: string;
	now: number;
	halfLifeDays: number;
	limit: number;
}

export interface Ranked {
	item: Citable;
	score: number;
	outcomes: number;
	match: number;
	recency: number;
	rank: number;
}

/**
 * Recall's order: match × recency × (0.5 + score).
 *
 * Recency halves every `halfLifeDays`. The score term runs 0.5..1.5, so a lesson that
 * keeps failing sinks without vanishing and one that keeps working rises. An entry
 * matching none of the query is left out rather than ranked last: a block of
 * unrelated lessons pasted into CONTEXT.md is worse than a short one.
 *
 * Digested lessons stand behind their digest, and only the newest digest of a
 * milestone is a candidate, so rolling a milestone up again does not cite it twice.
 */
export function rankLessons(items: readonly Citable[], outcomes: readonly OutcomeRecord[], options: RankOptions): Ranked[] {
	const terms = queryTerms(options.query);
	const digested = new Set(items.filter((item) => item.digest).flatMap((item) => item.rollsUp));
	const newestDigest = new Map<string, Citable>();
	for (const item of items) {
		if (!item.digest) continue;
		const held = newestDigest.get(item.milestone);
		if (!held || Date.parse(item.created) > Date.parse(held.created)) newestDigest.set(item.milestone, item);
	}
	const reports = new Map<string, OutcomeRecord[]>();
	for (const outcome of outcomes) reports.set(outcome.lesson, [...(reports.get(outcome.lesson) ?? []), outcome]);

	return items
		.filter((item) => !digested.has(item.id) && (!item.digest || newestDigest.get(item.milestone) === item))
		.map((item) => {
			const { score, count } = scoreOf(reports.get(item.id) ?? []);
			const match = matchScore(terms, item);
			const age = Math.max(0, options.now - Date.parse(item.created));
			const recency = Number.isFinite(age) ? 0.5 ** (age / (options.halfLifeDays * DAY_MS)) : 0;
			return { item, score, outcomes: count, match, recency, rank: match * recency * (0.5 + score) };
		})
		.filter((ranked) => ranked.match > 0)
		.sort(
			(a, b) =>
				b.rank - a.rank ||
				Date.parse(b.item.created) - Date.parse(a.item.created) ||
				a.item.id.localeCompare(b.item.id),
		)
		.slice(0, options.limit);
}

/** The block a GSD discuss step pastes into CONTEXT.md. Every line leads with the id to cite. */
export function renderPriorLessons(ranked: readonly Ranked[], context: { scope: string; query: string }): string {
	const about = context.query.trim() ? ` for "${context.query.trim()}"` : "";
	const lines = ["## Prior Lessons", ""];
	if (ranked.length === 0) {
		lines.push(`No lessons in \`${context.scope}\` matched${about}.`);
		return `${lines.join("\n")}\n`;
	}
	lines.push(
		`From the lessons bank in \`${context.scope}\`${about}. Cite a lesson in PLAN.md by its entry id, as \`[lesson <id>]\`.`,
		"",
	);
	for (const { item, score, outcomes } of ranked) {
		const facts = [
			item.digest ? `digest of ${item.milestone}` : [item.milestone, item.phase].filter(Boolean).join("/"),
			item.outcome,
			`score ${score.toFixed(2)} from ${outcomes} outcome${outcomes === 1 ? "" : "s"}`,
			item.created.slice(0, 10),
			item.stale ? "needs re-verification" : null,
		].filter(Boolean);
		const said = normalizeText(item.text);
		const tags = item.tags.length > 0 ? ` [tags: ${item.tags.join(", ")}]` : "";
		lines.push(
			`- \`${item.id}\` ${item.subject} (${facts.join("; ")}): ${said.length > 600 ? `${said.slice(0, 599)}…` : said}${tags}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

// ── SUMMARY.md extraction ────────────────────────────────────────────────────

export interface ExtractedLesson {
	text: string;
	slug?: string;
	tags: string[];
	outcome?: string;
}

export interface SummaryLessons {
	milestone?: string;
	phase?: string;
	/** The SUMMARY's frontmatter tags, which every lesson in it inherits. */
	tags: string[];
	/** The bullets under `## Lessons`. */
	lessons: ExtractedLesson[];
	/** The frontmatter `key-decisions`, which `--key-decisions` takes instead. */
	keyDecisions: ExtractedLesson[];
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return String(JSON.parse(trimmed));
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
	return trimmed;
}

/**
 * The YAML subset GSD frontmatter uses: `key: value`, `key: [a, b]`, and `key:`
 * followed by `  - item` lines. Anything nested deeper is skipped, not misread.
 */
function frontmatter(markdown: string): { scalars: Map<string, string>; lists: Map<string, string[]>; body: string } {
	const scalars = new Map<string, string>();
	const lists = new Map<string, string[]>();
	const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	if (!block) return { scalars, lists, body: markdown };
	let open: string[] | null = null;
	for (const line of (block[1] ?? "").split(/\r?\n/)) {
		const field = /^([A-Za-z0-9_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
		if (field?.[1]) {
			const value = (field[2] ?? "").trim();
			open = null;
			if (value === "") {
				open = [];
				lists.set(field[1], open);
			} else if (value.startsWith("[") && value.endsWith("]")) {
				lists.set(field[1], value.slice(1, -1).split(",").map(unquote).filter(Boolean));
			} else {
				scalars.set(field[1], unquote(value));
			}
			continue;
		}
		// Only items directly under a key. `  created:` under `key-files:` closes the list,
		// so the items nested beneath it are not read as the parent's.
		const item = /^ {0,2}- (.*)$/.exec(line);
		if (item && open) open.push(unquote(item[1] ?? ""));
		else if (/^ {1,2}\S/.test(line)) open = null;
	}
	return { scalars, lists, body: markdown.slice(block[0].length) };
}

/** `[tags: a, b]` and `[outcome: partial]` annotations; a bold lead names the slug. */
function bullet(raw: string): ExtractedLesson {
	const tags: string[] = [];
	let outcome: string | undefined;
	const text = raw.replace(/\[(tags?|outcome):\s*([^\]]*)\]/gi, (_whole, key: string, value: string) => {
		if (key.toLowerCase() === "outcome") outcome = value.trim().toLowerCase();
		else tags.push(...splitList(value));
		return "";
	});
	const lead = /^\*\*([^*]+)\*\*/.exec(text.trim());
	return { text: normalizeText(text.replace(/\*\*/g, "")), slug: lead?.[1] ? slugify(lead[1]) : undefined, tags, outcome };
}

const LESSONS_HEADING = /^(#{2,3})\s+lessons?(?:\s+learned)?\s*$/i;

/**
 * The lessons in a SUMMARY.md: one per top-level bullet under `## Lessons` (or
 * `## Lesson`, `## Lessons learned`, at `##` or `###`), up to the next heading of the
 * same or a higher level. Indented lines and nested bullets continue the lesson
 * above them; an unindented paragraph ends it.
 */
export function parseSummary(markdown: string): SummaryLessons {
	const { scalars, lists, body } = frontmatter(markdown);
	const lessons: ExtractedLesson[] = [];
	let level = 0;
	let indent = -1;
	let current: string[] | null = null;
	const flush = () => {
		if (current && normalizeText(current.join(" "))) lessons.push(bullet(current.join(" ")));
		current = null;
	};
	for (const line of body.split(/\r?\n/)) {
		const heading = /^(#{1,6})\s/.exec(line);
		if (heading?.[1]) {
			if (level > 0 && heading[1].length <= level) {
				flush();
				level = 0;
			}
			const opens = LESSONS_HEADING.exec(line.trim());
			if (level === 0 && opens?.[1]) {
				level = opens[1].length;
				indent = -1;
			}
			continue;
		}
		if (level === 0) continue;
		const item = /^(\s*)[-*+]\s+(.*)$/.exec(line);
		if (item) {
			const at = item[1]?.length ?? 0;
			if (indent < 0) indent = at;
			if (at <= indent) {
				flush();
				current = [item[2] ?? ""];
				continue;
			}
		}
		if (line.trim() === "") continue;
		if (current && /^\s/.test(line)) current.push(line.trim().replace(/^[-*+]\s+/, ""));
		else flush();
	}
	flush();
	return {
		milestone: scalars.get("milestone"),
		phase: scalars.get("phase"),
		tags: lists.get("tags") ?? [],
		lessons,
		keyDecisions: (lists.get("key-decisions") ?? []).map((text) => ({ text: normalizeText(text), tags: [] })),
	};
}

/**
 * Where a SUMMARY sits says which milestone and phase it belongs to: an archived
 * phase is filed under `milestones/<milestone>-phases/<phase>/`, a live one under
 * `phases/<phase>/`.
 */
export function placeOf(path: string): { milestone?: string; phase?: string } {
	return {
		milestone: /(?:^|\/)milestones\/([^/]+?)-phases\//.exec(path)?.[1],
		phase: /(?:^|\/)(?:[^/]*-)?phases\/([^/]+)\/[^/]+$/.exec(path)?.[1],
	};
}

/** `milestone:` from `.planning/STATE.md`: the milestone in progress, which a lesson added now belongs to. */
export function milestoneFromState(state: string): string | undefined {
	return frontmatter(state).scalars.get("milestone");
}

// ── the gate's reply ─────────────────────────────────────────────────────────

export interface WriteReply {
	outcome?: string;
	reason?: string;
	remedy?: string;
	verified_persisted?: boolean;
	entry?: { id?: string };
	deduplicated?: boolean;
	quarantine_id?: string;
	review_id?: string;
	conflict_with?: string;
	/** A reply that is not a gate decision: a 401, an audit refusal, a crash. */
	error?: string;
}

export type WriteStatus =
	| "recorded"
	| "duplicate"
	| "unverified"
	| "quarantined"
	| "denied"
	| "review"
	| "conflict"
	| "refused"
	| "unreachable"
	| "too-long"
	| "skipped";

export interface WriteReport {
	subject: string;
	key: string;
	status: WriteStatus;
	/** The entry id, and only on `recorded` / `duplicate`; the parked row's id on `quarantined` / `review`. */
	id: string | null;
	reason: string | null;
	remedy: string | null;
}

/** The two statuses that carry an id anyone may cite. */
export const USABLE: Partial<Record<WriteStatus, true>> = { recorded: true, duplicate: true };

/**
 * What a gate reply means to the bank. A lesson counts only when the gate accepted
 * it *and* read it back — the gate's own contract for anything other agents act
 * on — so an accepted write that was not verified gets no id at all.
 */
export function interpret(reply: WriteReply): Pick<WriteReport, "status" | "id" | "reason" | "remedy"> {
	const reason = reply.reason ?? reply.error ?? null;
	const remedy = reply.remedy ?? null;
	switch (reply.outcome) {
		case "accepted":
			return reply.verified_persisted === true && reply.entry?.id
				? { status: reply.deduplicated ? "duplicate" : "recorded", id: reply.entry.id, reason, remedy }
				: { status: "unverified", id: null, reason, remedy };
		case "quarantined":
			return { status: "quarantined", id: reply.quarantine_id ?? null, reason, remedy };
		case "denied":
			return { status: "denied", id: null, reason, remedy };
		case "conflict":
			return reply.reason === "review.required"
				? { status: "review", id: reply.review_id ?? null, reason, remedy }
				: { status: "conflict", id: null, reason: reply.conflict_with ? `${reason} (${reply.conflict_with})` : reason, remedy };
		default:
			return { status: "refused", id: null, reason: reason ?? "the reply carried no gate decision", remedy };
	}
}

// ── transport ────────────────────────────────────────────────────────────────

export interface Connection {
	url: string;
	token?: string;
	timeoutMs: number;
}

/** The keyset pair a page hands back: the `(created, id)` of its last entry. */
export interface SearchCursor {
	before: string;
	before_id: string;
}

/** One page of a paged `memory_search`: the entries, and the cursor to the next page, or null at the end. */
export interface SearchPage {
	entries: StoredEntry[];
	next: SearchCursor | null;
}

export interface PageRequest {
	scope: string;
	subject_prefix: string;
	limit: number;
	before?: string;
	before_id?: string;
}

/** The calls the bank makes: the seam a test stands a fake server behind. */
export interface MemoryApi {
	write(request: Record<string, unknown>): Promise<WriteReply>;
	/** A full-text search: the newest `limit` entries whose body carries every word of `query`. */
	search(query: string, scope: string, limit: number): Promise<StoredEntry[]>;
	/** One page of a subject family. Throws `LegacySearch` on a server that cannot page. */
	page(request: PageRequest): Promise<SearchPage>;
}

/** The substrate did not answer at all, so a write's outcome is unknown. */
export class Unreachable extends Error {}

/** A substrate whose `memory_search` predates `subject_prefix` and the cursor. */
export class LegacySearch extends Error {}

export function lessonsTimeout(raw: string | undefined): number {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/**
 * A `memory_search` the server answered without results. `invalidArguments` is the
 * server saying it does not know the arguments: the SDK's input-validation refusal,
 * or a JSON-RPC invalid-params error. On a paged read that means an older substrate;
 * a 401 or an audit refusal is something else and must not be taken for one.
 */
class SearchRefused extends Error {
	constructor(
		reason: string,
		readonly invalidArguments: boolean,
	) {
		super(reason);
	}
}

/** JSON-RPC's invalid-params code. */
const INVALID_PARAMS = -32602;

/**
 * Writes go to `POST /memory`. Reads go to the MCP `memory_search` tool, because
 * REST has no search route: one JSON-RPC `tools/call` POSTed to `/mcp`, which the
 * server answers statelessly with no handshake, as plain JSON or one SSE `data:` line.
 */
export function httpMemory(connection: Connection): MemoryApi {
	const base = connection.url.replace(/\/+$/, "");
	const headers = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}),
	};
	async function send(path: string, body: unknown): Promise<{ status: number; text: string }> {
		try {
			const response = await fetch(`${base}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(connection.timeoutMs),
			});
			return { status: response.status, text: await response.text() };
		} catch (cause) {
			throw new Unreachable(`${base}${path} did not answer: ${message(cause)}`);
		}
	}
	/** One `memory_search` call, and the parsed JSON of its reply. */
	async function memorySearch(args: Record<string, unknown>): Promise<unknown> {
		const { status, text } = await send("/mcp", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "memory_search", arguments: args },
		});
		const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? text;
		let envelope: { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: unknown };
		try {
			envelope = JSON.parse(data);
		} catch {
			throw new Error(`memory_search answered HTTP ${status} with no JSON-RPC reply: ${text.slice(0, 200)}`);
		}
		// No `result` is a refusal: a JSON-RPC error from the audit gate, or a plain
		// `{ error }` from the HTTP layer such as a 401 for a missing token.
		if (!envelope?.result) {
			const error = envelope?.error as { code?: unknown; message?: unknown } | string | undefined;
			const reason = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : text.slice(0, 200);
			const invalid = typeof error === "object" && error?.code === INVALID_PARAMS;
			throw new SearchRefused(`memory_search answered HTTP ${status}: ${reason}`, invalid);
		}
		const content = envelope.result.content?.[0]?.text ?? "";
		if (envelope.result.isError) {
			// The SDK's input-validation refusal, about `query`: what a server whose schema
			// still requires it says to a paged call. A current server never refuses on
			// `query` this way, so a malformed cursor is not taken for an older server.
			const invalid = /Invalid arguments for tool memory_search/.test(content) && /\bquery\b/.test(content);
			throw new SearchRefused(`memory_search failed: ${content}`, invalid);
		}
		return JSON.parse(content) as unknown;
	}
	return {
		async write(request) {
			const { status, text } = await send("/memory", request);
			try {
				const reply = JSON.parse(text) as unknown;
				if (reply && typeof reply === "object") return reply as WriteReply;
			} catch {
				// Not JSON at all; reported below with what came back.
			}
			return { error: `HTTP ${status}: ${text.slice(0, 200)}` };
		},
		async search(query, scope, limit) {
			const entries = await memorySearch({ query, scope, limit });
			if (!Array.isArray(entries)) throw new Error("memory_search did not return a list of entries");
			return entries as StoredEntry[];
		},
		async page(request) {
			let reply: unknown;
			try {
				reply = await memorySearch({ ...request });
			} catch (cause) {
				// An older server's schema has no `subject_prefix` and requires `query`.
				if (cause instanceof SearchRefused && cause.invalidArguments) throw new LegacySearch(cause.message);
				throw cause;
			}
			// A server that dropped the arguments it did not know and answered the rest
			// sent the bare list: the newest of everything, which is not this page.
			if (Array.isArray(reply)) throw new LegacySearch("memory_search ignored subject_prefix and answered a bare list");
			const page = reply as Partial<SearchPage> | null;
			if (!page || !Array.isArray(page.entries)) throw new Error("memory_search did not return a page of entries");
			const next = page.next;
			return {
				entries: page.entries,
				next: next && typeof next.before === "string" && typeof next.before_id === "string" ? next : null,
			};
		},
	};
}

// ── commands ─────────────────────────────────────────────────────────────────

export interface LessonsDeps {
	memory: MemoryApi;
	/** owner/name from the origin remote, when there is one. */
	repo: string | undefined;
	/** The checkout's top level: sources are recorded relative to it, so one file is one source wherever the command runs. */
	root: string;
	cwd: string;
	now: () => Date;
	out: (text: string) => void;
	err: (text: string) => void;
}

const USAGE =
	"substrate lessons add --text T --phase P [--milestone M] [--slug S] [--tags a,b] [--outcome O] [--source PATH]\n" +
	"substrate lessons add --from SUMMARY.md [--key-decisions] [--milestone M] [--phase P] [--tags a,b] [--skip slug,...]\n" +
	"substrate lessons recall [QUERY] [--limit N] [--half-life DAYS]\n" +
	"substrate lessons digest <milestone> [--ids a,b [--unchecked]] [--text T]\n" +
	"substrate lessons outcome <lesson id> --result success|partial|failure --phase P [--milestone M] [--note T] [--unchecked]\n" +
	"  every command: [--scope S | --repo owner/name] [--json]; add, digest and outcome also take --dry-run\n" +
	`  --outcome, how the phase that taught the lesson went: ${LESSON_OUTCOMES.join(", ")} (default success)\n`;

export async function runLessons(argv: string[], deps: LessonsDeps): Promise<number> {
	const [command, ...rest] = argv;
	const firstFlag = rest.findIndex((arg) => arg.startsWith("--"));
	const positional = firstFlag < 0 ? rest : rest.slice(0, firstFlag);
	const args = parseArgs(rest);
	try {
		switch (command) {
			case "add":
				return await add(args, deps);
			case "recall":
				return await recall(args, positional.join(" "), deps);
			case "digest":
				return await digest(args, positional[0], deps);
			case "outcome":
				return await outcome(args, positional[0], deps);
			default:
				deps.out(USAGE);
				return command && command !== "help" ? 2 : 0;
		}
	} catch (cause) {
		if (!(cause instanceof UsageError)) throw cause;
		deps.err(`[substrate] ${cause.message}\n`);
		return 2;
	}
}

/** `repo:<owner/name>` unless told otherwise, from the same origin remote `brief` and `drift` read. */
function scopeOf(args: Args, deps: LessonsDeps): string {
	const explicit = str(args.scope)?.trim();
	if (explicit) return explicit;
	const repo = str(args.repo)?.trim() || deps.repo;
	if (!repo) throw new UsageError("lessons need --scope, --repo, or a git origin remote to derive repo:<owner/name> from");
	return `repo:${repo}`;
}

function currentMilestone(deps: LessonsDeps): string | undefined {
	try {
		return milestoneFromState(readFileSync(join(deps.root, ".planning", "STATE.md"), "utf8"));
	} catch {
		return undefined;
	}
}

function repoRelative(path: string, root: string): string {
	const rel = relative(root, path);
	const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	return (inside ? rel : path).split(sep).join("/");
}

function outcomeOf(value: string | undefined): LessonOutcome {
	const outcome = (value ?? "success").trim().toLowerCase();
	if (!(LESSON_OUTCOMES as readonly string[]).includes(outcome)) {
		throw new UsageError(`outcome must be one of ${LESSON_OUTCOMES.join(", ")}; got "${value}"`);
	}
	return outcome as LessonOutcome;
}

/**
 * One governed write, sent again once under the same key when the gate accepted it
 * but could not read it back. That replay re-verifies rather than writing again,
 * which makes it the one retry that is always safe. A quarantine, a denial or a
 * conflict is the gate's answer, and asking again would only get it again.
 */
async function writeGoverned(
	memory: MemoryApi,
	request: Record<string, unknown>,
): Promise<Pick<WriteReport, "status" | "id" | "reason" | "remedy">> {
	for (let attempt = 0; ; attempt++) {
		let reply: WriteReply;
		try {
			reply = await memory.write(request);
		} catch (cause) {
			if (!(cause instanceof Unreachable)) throw cause;
			return {
				status: "unreachable",
				id: null,
				reason: cause.message,
				remedy: "The write may have landed. Run the same command again: its idempotency key replays a landed write instead of adding a second one.",
			};
		}
		const decided = interpret(reply);
		if (decided.status !== "unverified" || attempt > 0) return decided;
	}
}

function printReports(reports: readonly WriteReport[], json: boolean, deps: LessonsDeps): void {
	if (json) {
		deps.out(`${JSON.stringify(reports, null, 2)}\n`);
		return;
	}
	for (const report of reports) {
		deps.out(`${report.status.padEnd(11)} ${(report.id ?? "-").padEnd(36)} ${report.subject}\n`);
		if (!USABLE[report.status] && report.status !== "skipped") {
			deps.out(`${" ".repeat(12)}${[report.reason, report.remedy].filter(Boolean).join(" — ")}\n`);
		}
	}
}

interface Planned {
	subject: string;
	key: string;
	body: string;
	skipped: boolean;
}

function printPlanned(planned: readonly Planned[], scope: string, json: boolean, deps: LessonsDeps): void {
	if (json) {
		deps.out(`${JSON.stringify(planned.map((plan) => ({ scope, ...plan })), null, 2)}\n`);
		return;
	}
	for (const plan of planned) {
		deps.out(`${plan.subject}${plan.skipped ? "   (skipped)" : ""}\n  scope: ${scope}\n  key: ${plan.key}\n`);
		for (const line of plan.body.split("\n")) deps.out(`  | ${line}\n`);
	}
}

async function add(args: Args, deps: LessonsDeps): Promise<number> {
	const scope = scopeOf(args, deps);
	const fallbackOutcome = outcomeOf(str(args.outcome));
	const from = str(args.from);
	let milestone: string | undefined;
	let phase: string | undefined;
	let source: string;
	let items: ExtractedLesson[];
	if (from) {
		const path = resolve(deps.cwd, from);
		let markdown: string;
		try {
			markdown = readFileSync(path, "utf8");
		} catch (cause) {
			throw new UsageError(`cannot read ${from}: ${message(cause)}`);
		}
		source = repoRelative(path, deps.root);
		const summary = parseSummary(markdown);
		const place = placeOf(source);
		milestone = str(args.milestone) ?? place.milestone ?? summary.milestone ?? currentMilestone(deps);
		phase = str(args.phase) ?? summary.phase ?? place.phase;
		items = (args["key-decisions"] ? summary.keyDecisions : summary.lessons).map((item) => ({
			...item,
			tags: [...item.tags, ...summary.tags],
		}));
		if (items.length === 0) {
			deps.err(
				args["key-decisions"]
					? `[substrate] ${from} has no key-decisions in its frontmatter\n`
					: `[substrate] ${from} has no bullets under a "## Lessons" heading; --key-decisions takes the frontmatter key-decisions instead\n`,
			);
			return 1;
		}
	} else {
		const text = str(args.text);
		if (!text?.trim()) throw new UsageError("lessons add needs --text TEXT or --from SUMMARY.md");
		milestone = str(args.milestone) ?? currentMilestone(deps);
		phase = str(args.phase);
		const slug = str(args.slug);
		items = [{ text: normalizeText(text), slug: slug ? identifier(slug) : undefined, tags: [] }];
		const given = str(args.source);
		source = given
			? repoRelative(resolve(deps.cwd, given), deps.root)
			: `inline:${identifier(milestone ?? "")}/${identifier(phase ?? "")}`;
	}
	const m = identifier(milestone ?? "");
	const p = identifier(phase ?? "");
	if (!m || !p) {
		throw new UsageError("a lesson needs a milestone and a phase: pass --milestone and --phase, or a SUMMARY.md filed under one");
	}

	const extraTags = list(args.tags) ?? [];
	const skip = new Set((list(args.skip) ?? []).map(identifier));
	const taken = new Set<string>();
	const planned: Planned[] = items.map((item) => {
		const base = item.slug || slugify(item.text);
		let slug = base;
		// Two bullets opening with the same words would share a subject. Facts append, so
		// both would land, but a subject that names two lessons names neither.
		for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
		taken.add(slug);
		const lesson: Lesson = {
			milestone: m,
			phase: p,
			slug,
			outcome: outcomeOf(item.outcome ?? fallbackOutcome),
			tags: [...new Set([...item.tags, ...extraTags].map(identifier).filter(Boolean))],
			source,
			text: item.text,
		};
		return {
			subject: lessonSubject(m, p, slug),
			key: lessonKey(source, item.text),
			body: lessonBody(lesson),
			skipped: skip.has(slug),
		};
	});

	if (args["dry-run"]) {
		printPlanned(planned, scope, args.json === true, deps);
		return 0;
	}

	const reports: WriteReport[] = [];
	let reachable = true;
	for (const plan of planned) {
		const base = { subject: plan.subject, key: plan.key };
		if (plan.skipped) {
			reports.push({ ...base, status: "skipped", id: null, reason: null, remedy: null });
		} else if (plan.body.length > MAX_BODY) {
			reports.push({
				...base,
				status: "too-long",
				id: null,
				reason: `the body is ${plan.body.length} characters and the gate keeps ${MAX_BODY}`,
				remedy: "Split the lesson, or shorten it.",
			});
		} else if (!reachable) {
			reports.push({
				...base,
				status: "unreachable",
				id: null,
				reason: "not sent: the substrate stopped answering earlier in this run",
				remedy: "Run the same command again once it answers.",
			});
		} else {
			const decided = await writeGoverned(deps.memory, {
				scope,
				kind: "fact",
				subject: plan.subject,
				text: plan.body,
				idempotency_key: plan.key,
			});
			if (decided.status === "unreachable") reachable = false;
			reports.push({ ...base, ...decided });
		}
	}
	printReports(reports, args.json === true, deps);
	return reports.every((report) => report.status === "skipped" || USABLE[report.status]) ? 0 : 1;
}

interface Bank {
	items: Citable[];
	outcomes: OutcomeRecord[];
}

/**
 * Reads one scope's subject families, and remembers what it learned about the server.
 *
 * On a current substrate a family is listed whole: `memory_search` with
 * `subject_prefix` and the `(before, before_id)` cursor, page after page until the
 * cursor comes back null, so a lesson older than the newest 100 entries in the scope
 * is read like any other. On a substrate that cannot page, the reader falls back to the
 * full-text searches below, says so once on stderr, and keeps a note of the gap for the
 * messages that tell a user something is not in the bank.
 */
class BankReader {
	/** Set once the server has shown it cannot page; later reads go straight to the fallback. */
	private legacy = false;
	/** Why a read may have missed entries. */
	private readonly gaps = new Set<string>();

	constructor(
		private readonly memory: MemoryApi,
		readonly scope: string,
		private readonly err: (text: string) => void,
	) {}

	/**
	 * Every entry whose subject starts with `prefix`, newest first; or, on a server that
	 * cannot page, the union of the `fallback` full-text searches, the newest 100 each.
	 */
	async list(prefix: string, fallback: readonly string[]): Promise<StoredEntry[]> {
		if (!this.legacy) {
			try {
				return await this.pages(prefix);
			} catch (cause) {
				if (!(cause instanceof LegacySearch)) throw cause;
				// Reads run side by side, so several can learn this at once; one line says it.
				if (!this.legacy) {
					this.legacy = true;
					this.gaps.add(`among the newest ${SEARCH_LIMIT} per search`);
					this.err(
						`[substrate] this substrate's memory_search cannot list by subject, so lessons are read from the newest ` +
							`${SEARCH_LIMIT} per search and older ones may be missed: ${normalizeText(cause.message).slice(0, 200)}\n`,
					);
				}
			}
		}
		const found = await Promise.all(fallback.map((query) => this.memory.search(query, this.scope, SEARCH_LIMIT)));
		return found.flat();
	}

	private async pages(prefix: string): Promise<StoredEntry[]> {
		const entries: StoredEntry[] = [];
		let cursor: SearchCursor | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const got = await this.memory.page({ scope: this.scope, subject_prefix: prefix, limit: SEARCH_LIMIT, ...cursor });
			entries.push(...got.entries);
			if (!got.next) return entries;
			cursor = got.next;
		}
		this.gaps.add(`among the newest ${entries.length} ${prefix} entries`);
		this.err(
			`[substrate] stopped reading ${prefix} entries in ${this.scope} after ${MAX_PAGES} pages ` +
				`(${entries.length} entries); older ones were not read\n`,
		);
		return entries;
	}

	/** ` (among …)` when a read may have missed entries, else nothing. */
	caveat(): string {
		return this.gaps.size > 0 ? ` (${[...this.gaps].join("; ")})` : "";
	}
}

/**
 * Every lesson and digest in the scope, and with `withOutcomes` every outcome.
 *
 * `terms` matter only on the fallback, where the bare marker search is the newest
 * 100 lessons and each term adds the newest 100 lessons mentioning it — how a lesson
 * older than the newest 100 is found by what it is about when it cannot be listed.
 */
async function readBank(reader: BankReader, terms: readonly string[], withOutcomes: boolean): Promise<Bank> {
	const lessonQueries = [MARKERS.lesson, ...terms.slice(0, MAX_QUERY_TERMS).map((term) => `${MARKERS.lesson} ${term}`)];
	const [lessons, digests, outcomes] = await Promise.all([
		reader.list(SUBJECT.lesson, lessonQueries),
		reader.list(SUBJECT.digest, [MARKERS.digest]),
		withOutcomes ? reader.list(SUBJECT.outcome, [MARKERS.outcome]) : [],
	]);
	const items = new Map<string, Citable>();
	for (const entry of lessons) {
		const lesson = citableLesson(entry);
		if (lesson) items.set(lesson.id, lesson);
	}
	for (const entry of digests) {
		const digested = citableDigest(entry);
		if (digested) items.set(digested.id, digested);
	}
	return { items: [...items.values()], outcomes: outcomes.flatMap((entry) => outcomeRecord(entry) ?? []) };
}

async function recall(args: Args, positional: string, deps: LessonsDeps): Promise<number> {
	const scope = scopeOf(args, deps);
	const query = str(args.query) ?? positional;
	const limit = str(args.limit) === undefined ? DEFAULT_RECALL_LIMIT : Number(str(args.limit));
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECALL_LIMIT) {
		throw new UsageError(`--limit must be a whole number from 1 to ${MAX_RECALL_LIMIT}`);
	}
	const halfLifeDays = str(args["half-life"]) === undefined ? DEFAULT_HALF_LIFE_DAYS : Number(str(args["half-life"]));
	if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) throw new UsageError("--half-life must be a positive number of days");

	let bank: Bank;
	try {
		bank = await readBank(new BankReader(deps.memory, scope, deps.err), queryTerms(query), true);
	} catch (cause) {
		// Fail-open, by the proposal's rule: a phase that cannot reach the bank goes
		// ahead without prior lessons rather than not at all. Said on stderr, so the
		// operator knows the block is missing rather than empty.
		deps.err(`[substrate] the lessons bank did not answer for ${scope}; nothing recalled: ${message(cause)}\n`);
		return 0;
	}
	const ranked = rankLessons(bank.items, bank.outcomes, { query, now: deps.now().getTime(), halfLifeDays, limit });
	if (args.json) {
		deps.out(
			`${JSON.stringify(
				ranked.map(({ item, ...rest }) => ({ ...item, ...rest })),
				null,
				2,
			)}\n`,
		);
	} else {
		deps.out(renderPriorLessons(ranked, { scope, query }));
	}
	return 0;
}

async function digest(args: Args, positional: string | undefined, deps: LessonsDeps): Promise<number> {
	const milestone = identifier(str(args.milestone) ?? positional ?? "");
	if (!milestone) throw new UsageError("usage: substrate lessons digest <milestone> [--ids a,b] [--text T]");
	const scope = scopeOf(args, deps);
	const reader = new BankReader(deps.memory, scope, deps.err);
	let bank: Bank;
	try {
		bank = await readBank(reader, [], false);
	} catch (cause) {
		deps.err(`[substrate] the lessons bank did not answer for ${scope}: ${message(cause)}\n`);
		return 1;
	}
	const lessons = bank.items.filter((item) => !item.digest);
	const asked = list(args.ids)?.map((id) => id.toLowerCase());
	let chosen: Array<Citable | string>;
	if (asked) {
		const known = new Map(lessons.map((lesson) => [lesson.id, lesson] as const));
		const unknown = asked.filter((id) => !known.has(id));
		if (unknown.length > 0 && !args.unchecked) {
			deps.err(
				`[substrate] not lessons in ${scope}${reader.caveat()}: ${unknown.join(", ")}; ` +
					"--unchecked digests them anyway\n",
			);
			return 1;
		}
		chosen = [...new Set(asked)].map((id) => known.get(id) ?? id);
	} else {
		chosen = lessons.filter((lesson) => lesson.subject.startsWith(`${SUBJECT.lesson}${milestone}/`));
	}
	// Oldest first, whichever way the set was named: the key covers the set, so the body
	// has to be the same for the same set or a re-run would be refused as a different write.
	const createdAt = (lesson: Citable | string) => (typeof lesson === "string" ? Number.POSITIVE_INFINITY : Date.parse(lesson.created));
	const idOf = (lesson: Citable | string) => (typeof lesson === "string" ? lesson : lesson.id);
	chosen.sort((a, b) => createdAt(a) - createdAt(b) || idOf(a).localeCompare(idOf(b)));
	if (chosen.length === 0) {
		deps.err(`[substrate] no lessons for ${milestone} in ${scope}; nothing to digest\n`);
		return 1;
	}
	const text = str(args.text);
	const body = digestBody(milestone, chosen, text);
	if (body === null) {
		deps.err(`[substrate] ${chosen.length} ids do not fit one ${MAX_BODY}-character digest; split them with --ids\n`);
		return 1;
	}
	const ids = chosen.map(idOf).sort();
	const subject = `${SUBJECT.digest}${milestone}`;
	const key = `${SUBJECT.digest}${sha256([milestone, ...ids, normalizeText(text ?? "")].join("\n"))}`;
	if (args["dry-run"]) {
		printPlanned([{ subject, key, body, skipped: false }], scope, args.json === true, deps);
		return 0;
	}
	const decided = await writeGoverned(deps.memory, { scope, kind: "fact", subject, text: body, idempotency_key: key });
	printReports([{ subject, key, ...decided }], args.json === true, deps);
	return USABLE[decided.status] ? 0 : 1;
}

/**
 * The outcomes filed against one lesson. `lesson-outcome:<id>` as a prefix also
 * matches the outcomes of any longer id that begins with this one, so the lesson each
 * record names is compared exactly.
 */
async function outcomesFor(reader: BankReader, lessonId: string): Promise<OutcomeRecord[]> {
	const entries = await reader.list(`${SUBJECT.outcome}${lessonId}`, [`${MARKERS.outcome} ${lessonId}`]);
	return entries.flatMap((entry) => {
		const record = outcomeRecord(entry);
		return record && record.lesson === lessonId ? [record] : [];
	});
}

async function outcome(args: Args, positional: string | undefined, deps: LessonsDeps): Promise<number> {
	const lessonId = (str(args.lesson) ?? positional ?? "").trim().toLowerCase();
	const result = str(args.result)?.trim().toLowerCase();
	if (!/^[a-z0-9_-]+$/.test(lessonId) || !result) {
		throw new UsageError("usage: substrate lessons outcome <lesson id> --result success|partial|failure --phase P");
	}
	if (!(OUTCOME_RESULTS as readonly string[]).includes(result)) {
		throw new UsageError(`--result must be one of ${OUTCOME_RESULTS.join(", ")}`);
	}
	const milestone = identifier(str(args.milestone) ?? currentMilestone(deps) ?? "");
	const phase = identifier(str(args.phase) ?? "");
	if (!milestone || !phase) {
		throw new UsageError("--phase, and --milestone unless .planning/STATE.md names one, say which use of the lesson this reports on");
	}
	const scope = scopeOf(args, deps);
	const note = normalizeText(str(args.note) ?? "");
	const reader = new BankReader(deps.memory, scope, deps.err);

	let before: OutcomeRecord[];
	try {
		// An outcome is a permanent fact, so one filed against a mistyped id would sit in
		// the bank forever, scoring nothing.
		if (!args.unchecked) {
			const bank = await readBank(reader, [], false);
			if (!bank.items.some((item) => item.id === lessonId)) {
				deps.err(
					`[substrate] ${lessonId} is not a lesson or digest in ${scope}${reader.caveat()}; ` +
						"--unchecked records the outcome anyway\n",
				);
				return 1;
			}
		}
		before = await outcomesFor(reader, lessonId);
	} catch (cause) {
		deps.err(`[substrate] the lessons bank did not answer for ${scope}: ${message(cause)}\n`);
		return 1;
	}

	const subject = `${SUBJECT.outcome}${lessonId}`;
	const key = `${SUBJECT.outcome}${sha256([lessonId, `${milestone}/${phase}`, result, note].join("\n"))}`;
	const body = [
		`[${MARKERS.outcome}]`,
		`lesson: ${lessonId}`,
		`result: ${result}`,
		`milestone: ${milestone}`,
		`phase: ${phase}`,
		...(note ? ["", note] : []),
	].join("\n");
	if (args["dry-run"]) {
		printPlanned([{ subject, key, body, skipped: false }], scope, args.json === true, deps);
		return 0;
	}

	const report: WriteReport = {
		subject,
		key,
		...(await writeGoverned(deps.memory, { scope, kind: "fact", subject, text: body, idempotency_key: key })),
	};
	const was = scoreOf(before);
	// Read back rather than computed locally, so the score shown is the one recall will see.
	let now: { score: number; count: number } | null = null;
	if (USABLE[report.status]) {
		try {
			now = scoreOf(await outcomesFor(reader, lessonId));
		} catch {
			now = null;
		}
	}
	if (args.json) {
		deps.out(`${JSON.stringify({ ...report, lesson: lessonId, score_before: was, score_after: now }, null, 2)}\n`);
	} else {
		printReports([report], false, deps);
		const [from, to] = [was, now].map((score) =>
			score ? `${score.score.toFixed(2)} (${score.count} outcome${score.count === 1 ? "" : "s"})` : "unknown",
		);
		if (now) deps.out(`${" ".repeat(12)}score of ${lessonId}: ${from} -> ${to}\n`);
	}
	return USABLE[report.status] ? 0 : 1;
}
