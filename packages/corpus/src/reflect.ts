/**
 * The repository digest: one short markdown document per repository that says where its planning stands (v1.7 phase 66).
 *
 * Deterministic and pure: the text of `.planning/STATE.md`, `.planning/ROADMAP.md` and `.planning/PROJECT.md` in, one
 * document out. No model, no network, no clock: the text carries no time of its own, so the digest is byte-identical
 * while its sources are, and a reflect run that changed nothing stores nothing.
 */
import { createHash } from "node:crypto";
import { hasControlCharacter } from "./names.ts";
import { DIGEST_PATH } from "./protocol.ts";

export interface DigestSource {
	/** Repository-relative path with forward slashes, as it sits in the checkout. */
	path: string;
	text: string;
}

export interface RepoDigest {
	repo: string;
	/** The virtual path the digest is stored under; see `DIGEST_PATH`. */
	path: string;
	text: string;
	/** The deterministic Hindsight key. */
	key: string;
	/** sha256 of `text` as UTF-8, lowercase hex. */
	sha256: string;
}

/** The newest decisions listed, and the longest decision, open item or status line kept. */
export const DIGEST_MAX_DECISIONS = 10;
export const DIGEST_MAX_OPEN_ITEMS = 20;
export const DIGEST_MAX_DECISION_CHARS = 300;
export const DIGEST_MAX_ITEM_CHARS = 200;
const DIGEST_MAX_FIELD_CHARS = 200;
const DIGEST_MAX_STATUS_CHARS = 300;

export const DIGEST_KEY_PREFIX = "corpus-digest:";

const STATE_PATH = ".planning/state.md";
const ROADMAP_PATH = ".planning/roadmap.md";
const PROJECT_PATH = ".planning/project.md";
const NONE = "- none found";
const FRONT_MATTER_KEYS = ["milestone", "milestone_name", "status", "current_phase", "current_phase_name"] as const;

/** The first `max` UTF-16 units of `text`, never ending on half of a surrogate pair, so the result stays well-formed. */
function cutWell(text: string, max: number): string {
	const cut = text.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** One line of text with no control characters, no emphasis markers and no runs of blanks, cut to `max` characters. */
function tidy(text: string, max: number): string {
	let plain = "";
	for (const char of text) plain += hasControlCharacter(char) ? " " : char;
	const line = plain.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${cutWell(line, max - 3).trimEnd()}...`;
}

function lines(text: string): string[] {
	return text.replace(/^\uFEFF/, "").split(/\r\n|[\n\r\u2028\u2029]/);
}

/** `key: value` pairs of the opening `---` block, for the keys the digest reads; and the lines after the block. */
function splitFrontMatter(text: string): { fields: Map<string, string>; body: string[] } {
	const all = lines(text);
	const fields = new Map<string, string>();
	if (all[0]?.trim() !== "---") return { fields, body: all };
	const end = all.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end === -1) return { fields, body: all };
	for (const line of all.slice(1, end)) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		if (!(FRONT_MATTER_KEYS as readonly string[]).includes(key) || fields.has(key)) continue;
		const value = line.slice(colon + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
		if (value !== "") fields.set(key, value);
	}
	return { fields, body: all.slice(end + 1) };
}

interface Heading {
	level: number;
	title: string;
}

function headingOf(line: string): Heading | null {
	const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
	return match === null ? null : { level: (match[1] ?? "").length, title: match[2] ?? "" };
}

/** The bullet items (`- x`, `* x`, at the start of a line) of every section whose heading says "decision", in document order. */
function decisionItems(body: readonly string[]): string[] {
	const items: string[] = [];
	let sectionLevel = 0;
	for (const line of body) {
		const heading = headingOf(line);
		if (heading !== null) {
			if (sectionLevel !== 0 && heading.level <= sectionLevel) sectionLevel = 0;
			if (sectionLevel === 0 && /decisions?/i.test(heading.title)) sectionLevel = heading.level;
			continue;
		}
		if (sectionLevel === 0) continue;
		const bullet = /^[-*]\s+(.+)$/.exec(line);
		if (bullet?.[1] !== undefined) items.push(bullet[1]);
	}
	return items;
}

/** Unchecked boxes of the live roadmap: those outside any `<details>` block, which holds the archived milestones. */
function openItems(roadmap: readonly string[]): string[] {
	const items: string[] = [];
	let depth = 0;
	for (const line of roadmap) {
		depth += (line.match(/<details[\s>]/gi) ?? []).length;
		if (depth === 0) {
			const box = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(line);
			if (box?.[1] !== undefined) items.push(box[1]);
		}
		depth = Math.max(0, depth - (line.match(/<\/details>/gi) ?? []).length);
	}
	return items;
}

function firstMatch(body: readonly string[], pattern: RegExp): string | null {
	for (const line of body) {
		const found = pattern.exec(line);
		if (found?.[1] !== undefined && found[1].trim() !== "") return found[1];
	}
	return null;
}

/** The first heading and the first plain paragraph line of PROJECT.md. */
function projectSummary(text: string): { title: string | null; summary: string | null } {
	const body = splitFrontMatter(text).body;
	const title = firstMatch(body, /^#\s+(.+)$/);
	const summary = firstMatch(body, /^([A-Za-z0-9`*_[(].*)$/);
	return { title: title === null ? null : tidy(title, DIGEST_MAX_FIELD_CHARS), summary: summary === null ? null : tidy(summary, DIGEST_MAX_STATUS_CHARS) };
}

function find(files: readonly DigestSource[], path: string): string | undefined {
	return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).find((file) => file.path.toLowerCase() === path)?.text;
}

/**
 * Build the digest of one repository from the working-tree text of its planning files, or null when it has neither a
 * STATE nor a ROADMAP to read. The sections and their order are fixed:
 * current position (frontmatter and status line of STATE), the newest decisions (newest first), the open roadmap items,
 * and the project line. Every line is capped, so the text stays far below `MAX_DIGEST_CHARS` (the tests pin the worst case).
 */
export function buildDigest(repo: string, files: readonly DigestSource[]): RepoDigest | null {
	const state = find(files, STATE_PATH);
	const roadmap = find(files, ROADMAP_PATH);
	if (state === undefined && roadmap === undefined) return null;
	const project = find(files, PROJECT_PATH);

	const stateParts = state === undefined ? null : splitFrontMatter(state);
	const field = (key: (typeof FRONT_MATTER_KEYS)[number]): string | null => {
		const value = stateParts?.fields.get(key);
		return value === undefined ? null : tidy(value, DIGEST_MAX_FIELD_CHARS);
	};
	const statusLine = stateParts === null ? null : firstMatch(stateParts.body, /^Status:\s*(.+)$/);
	const positionLine = stateParts === null ? null : firstMatch(stateParts.body, /^Phase:\s*(.+)$/);
	const milestone = field("milestone");
	const milestoneName = field("milestone_name");
	const phase = field("current_phase");
	const phaseName = field("current_phase_name");

	const current: string[] = [];
	if (milestone !== null) current.push(`- Milestone: ${milestone}${milestoneName === null ? "" : ` (${milestoneName})`}`);
	if (phase !== null) current.push(`- Phase: ${phase}${phaseName === null ? "" : ` (${phaseName})`}`);
	const frontStatus = field("status");
	if (frontStatus !== null) current.push(`- State status: ${frontStatus}`);
	if (positionLine !== null) current.push(`- Position: ${tidy(positionLine, DIGEST_MAX_STATUS_CHARS)}`);
	if (statusLine !== null) current.push(`- Status: ${tidy(statusLine, DIGEST_MAX_STATUS_CHARS)}`);

	// STATE lists decisions as they were made, so the newest are the last bullets; the digest lists them newest first.
	const decisions = stateParts === null ? [] : decisionItems(stateParts.body).slice(-DIGEST_MAX_DECISIONS).reverse();
	const open = roadmap === undefined ? [] : openItems(lines(roadmap)).slice(0, DIGEST_MAX_OPEN_ITEMS);
	const about = project === undefined ? { title: null, summary: null } : projectSummary(project);

	const out: string[] = [
		`# Documentation digest: ${tidy(repo, DIGEST_MAX_FIELD_CHARS)}`,
		"",
		"## Current position",
		...(current.length === 0 ? [NONE] : current),
		"",
		"## Recent decisions (newest first)",
		...(decisions.length === 0 ? [NONE] : decisions.map((item) => `- ${tidy(item, DIGEST_MAX_DECISION_CHARS)}`)),
		"",
		"## Open items (unchecked in the live roadmap)",
		...(open.length === 0 ? [NONE] : open.map((item) => `- ${tidy(item, DIGEST_MAX_ITEM_CHARS)}`)),
		"",
		"## Project",
		...(about.title === null && about.summary === null
			? [NONE]
			: [...(about.title === null ? [] : [`- Name: ${about.title}`]), ...(about.summary === null ? [] : [`- Summary: ${about.summary}`])]),
	];
	const text = `${out.join("\n")}\n`;
	return {
		repo,
		path: DIGEST_PATH,
		text,
		key: `${DIGEST_KEY_PREFIX}${repo}`,
		sha256: createHash("sha256").update(text, "utf8").digest("hex"),
	};
}
