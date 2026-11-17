/**
 * Brief profiles (uplift-4 S1): one set of source reads, two renderings.
 *
 * `composeBriefSections` (brief.ts) reads the four sources once and returns the
 * brief as structured sections: an id (its compact priority is
 * `BRIEF_SECTION_PRIORITY[id]`, never a stored number), the exact lines the `full`
 * profile prints, and the items the `compact` profile selects from. `full`
 * is the sections' lines joined, byte for byte the text the brief has always
 * been. `compact` is a capped rendering for a model that pays for every byte
 * (the Grok Bot): a first state line, priority-ordered sections, every line
 * clipped, and a hard byte cap met by dropping whole lowest-priority lines and
 * saying exactly what was dropped.
 *
 * Nothing here reads a store, a clock or the environment except
 * `loadBriefProfileConfig`, which takes the environment as an argument.
 */
import {
	BRIEF_PROFILE_MODES,
	BRIEF_PROFILES,
	type BriefProfile,
	type BriefProfileMode,
	type BriefState,
} from "@substrate/observability";
import { z } from "zod";
import { SURFACES } from "./types.ts";

export { BRIEF_PROFILE_MODES, BRIEF_PROFILES, type BriefProfile, type BriefProfileMode };

/**
 * Section ids and their compact priority, lower is kept longer. `heading` is
 * never dropped. `graph` and `empty` never co-occur; the rest are listed in
 * the order the compact profile prints them after the heading.
 */
export const BRIEF_SECTION_PRIORITY = {
	heading: 0,
	graph: 1,
	empty: 1,
	warnings: 2,
	decisions: 3,
	nodes: 4,
	actions: 5,
	others: 6,
	recall: 7,
	// Phase 67: appended live by `SUBSTRATE_BRIEF_SESSIONS`, never cached. A queued directive is as urgent as a warning.
	steering: 2,
	sessions: 8,
	// Phase 68: appended live while the worktree registry is on, never cached. Context on who may collide with this session, as droppable as the sessions list.
	worktrees: 8,
	handoffs: 9,
} as const;
export type BriefSectionId = keyof typeof BRIEF_SECTION_PRIORITY;

/** The noun the omitted line uses for each section. */
const OMIT_LABEL: Record<BriefSectionId, string> = {
	heading: "heading",
	graph: "status",
	empty: "notes",
	warnings: "warnings",
	decisions: "decisions",
	nodes: "nodes",
	actions: "actions",
	others: "graphs",
	recall: "recalled",
	steering: "steering",
	sessions: "sessions",
	worktrees: "worktrees",
	handoffs: "handoffs",
};

/** One selectable line of the compact profile. */
export interface BriefItem {
	/** The whole line as the compact profile prints it before clipping. */
	text: string;
	/**
	 * The `[from, to)` range of `text` that clipping may shorten (a memory
	 * entry's own text, so its writer, trust and staleness stay readable).
	 * Absent: the whole line is clippable.
	 */
	clip?: readonly [number, number];
	/** Nodes only: lower prints first (held, then free, then open, then done, then canceled). */
	rank?: number;
}

/** A section of the brief, in the order the `full` profile prints it. */
export interface BriefSection {
	id: BriefSectionId;
	/** Exactly the lines the `full` profile prints for this section, separators included. */
	lines: string[];
	/** Compact: a line printed above the items. A title with no items is itself the notice (a failed or late read). */
	title?: string;
	/** Compact: the selectable lines, in the section's own order. */
	items: BriefItem[];
	/** Items the compose step left out before any profile applied (nodes past the compose cap): never selectable, always counted as omitted. */
	unlisted?: number;
}

export const DEFAULT_COMPACT_NODES = 12;
export const DEFAULT_COMPACT_MEMORY_CHARS = 240;
export const DEFAULT_COMPACT_BYTES = 3500;
/**
 * The smallest cap that still holds the state line, a clipped heading and the
 * omitted line. A configured value below it is raised, so the cap is a promise
 * `renderCompactBrief` can always keep.
 */
export const MIN_COMPACT_BYTES = 512;
const MAX_COMPACT_BYTES = 65_536;
const MIN_COMPACT_CHARS = 40;
const MAX_COMPACT_CHARS = 4000;
const MAX_COMPACT_NODES = 200;
/** The heading names the repo, branch and graph; it is clipped on its own, shorter, limit. */
const HEADING_CHARS = 160;
/** A line whose fixed parts already exceed the clip still keeps this much of its clippable range. */
const MIN_BODY_CHARS = 24;
const DEFAULT_NODE_RANK = 2;
const ELLIPSIS = "…";

export const DEFAULT_COMPACT_SURFACES: readonly string[] = ["grok-bot", "grok-build"];

export interface CompactLimits {
	nodes: number;
	memoryChars: number;
	bytes: number;
}

export interface BriefProfileConfig extends CompactLimits {
	/** `SUBSTRATE_BRIEF_PROFILE`; default `shadow`. */
	mode: BriefProfileMode;
	/** `SUBSTRATE_BRIEF_PROFILE_SURFACES`, closed against SURFACES; default `grok-bot,grok-build`. */
	surfaces: ReadonlySet<string>;
	/** What loading rejected or clamped, for the boot warning. Values are quoted at most 40 characters. */
	warnings: string[];
}

function quoted(raw: string): string {
	return JSON.stringify(raw.length > 40 ? `${raw.slice(0, 37)}...` : raw);
}

function boundedInt(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number, warnings: string[]): number {
	const raw = env[key];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw.trim());
	if (!Number.isFinite(value)) {
		warnings.push(`${key}=${quoted(raw)} is not a number; using ${fallback}`);
		return fallback;
	}
	const whole = Math.floor(value);
	if (whole < min || whole > max) {
		const clamped = Math.min(max, Math.max(min, whole));
		warnings.push(`${key}=${quoted(raw)} is outside ${min}..${max}; using ${clamped}`);
		return clamped;
	}
	return whole;
}

/**
 * Read the profile settings. Malformed values never throw: the mode falls back
 * to `shadow` (full text served, nothing changes for a caller), a surface list
 * to the default, a number to its default or the nearest bound, each with a
 * warning the entry point prints at boot.
 */
export function loadBriefProfileConfig(env: Record<string, string | undefined>): BriefProfileConfig {
	const warnings: string[] = [];
	let mode: BriefProfileMode = "shadow";
	const rawMode = env.SUBSTRATE_BRIEF_PROFILE?.trim().toLowerCase() ?? "";
	if (rawMode !== "") {
		if ((BRIEF_PROFILE_MODES as readonly string[]).includes(rawMode)) mode = rawMode as BriefProfileMode;
		else warnings.push(`SUBSTRATE_BRIEF_PROFILE=${quoted(rawMode)} is not off, shadow or enforce; running as shadow, so every caller is served the full brief`);
	}

	const surfaces = new Set<string>();
	const rawSurfaces = env.SUBSTRATE_BRIEF_PROFILE_SURFACES?.trim() ?? "";
	if (rawSurfaces !== "") {
		for (const name of rawSurfaces.split(/[\s,]+/)) {
			if (name === "") continue;
			if ((SURFACES as readonly string[]).includes(name)) surfaces.add(name);
			else warnings.push(`SUBSTRATE_BRIEF_PROFILE_SURFACES names ${quoted(name)}, which is not a surface; ignored`);
		}
		if (surfaces.size === 0) warnings.push("SUBSTRATE_BRIEF_PROFILE_SURFACES names no known surface; using the default list");
	}
	if (surfaces.size === 0) for (const name of DEFAULT_COMPACT_SURFACES) surfaces.add(name);

	return {
		mode,
		surfaces,
		nodes: boundedInt(env, "SUBSTRATE_BRIEF_COMPACT_NODES", DEFAULT_COMPACT_NODES, 1, MAX_COMPACT_NODES, warnings),
		memoryChars: boundedInt(env, "SUBSTRATE_BRIEF_COMPACT_MEMORY_CHARS", DEFAULT_COMPACT_MEMORY_CHARS, MIN_COMPACT_CHARS, MAX_COMPACT_CHARS, warnings),
		bytes: boundedInt(env, "SUBSTRATE_BRIEF_COMPACT_BYTES", DEFAULT_COMPACT_BYTES, MIN_COMPACT_BYTES, MAX_COMPACT_BYTES, warnings),
		warnings,
	};
}

/** The boot warnings for a loaded profile config, in the shape `index.ts` prints. */
export function briefProfileConfigWarnings(config: { briefProfile: BriefProfileConfig }): string[] {
	return config.briefProfile.warnings;
}

/**
 * A profile named by a caller. `undefined` or `null` is "not named"; anything
 * that is not exactly `full` or `compact` is refused, never coerced: a typo'd
 * `compat` must not quietly serve the full text a bot asked to avoid.
 */
export function parseBriefProfile(value: unknown): { ok: true; profile: BriefProfile | undefined } | { ok: false; error: string } {
	if (value === undefined || value === null) return { ok: true, profile: undefined };
	if (typeof value === "string" && (BRIEF_PROFILES as readonly string[]).includes(value)) return { ok: true, profile: value as BriefProfile };
	return { ok: false, error: `profile must be one of ${BRIEF_PROFILES.join(", ")}` };
}

/**
 * The profile a caller is served. Only `enforce` ever serves `compact`: `off`
 * and `shadow` serve the full text whatever was asked, so flipping the mode is
 * the one switch. Under `enforce` an explicit `full` always wins, an explicit
 * `compact` is honoured for any surface, and an unnamed profile follows the
 * surface list.
 */
export function resolveBriefProfile(config: BriefProfileConfig, surface: string, requested: BriefProfile | undefined): BriefProfile {
	if (config.mode !== "enforce") return "full";
	if (requested !== undefined) return requested;
	return config.surfaces.has(surface) ? "compact" : "full";
}

export function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** The `full` profile: the sections' own lines, exactly as the brief has always been written. */
export function renderFullBrief(sections: readonly BriefSection[]): string {
	return sections.flatMap((section) => section.lines).join("\n");
}

/**
 * The first line of a compact brief. It carries the state a header-dropping
 * gateway loses: `[brief: complete]`, `[brief: degraded; failed: memory]` or
 * `[brief: snapshot from <time>; failed: graph]`. The state vocabulary is the
 * service's (`complete | degraded | snapshot`), not extended here.
 */
export function briefStateLine(state: BriefState, failed: readonly string[], snapshotAt: string | null, ageS?: number): string {
	const lost = failed.length > 0 ? `; failed: ${failed.join(", ")}` : "";
	// A brief served stale (stale-while-revalidate) says so here: the age header does not survive a gateway that drops headers.
	if (state === "complete" && ageS !== undefined) return `[brief: complete; age ${Math.max(0, Math.floor(ageS))}s]`;
	if (state === "snapshot") return `[brief: snapshot from ${(snapshotAt ?? "unknown time").slice(0, 40)}${lost}]`;
	return `[brief: ${state}${state === "degraded" ? lost : ""}]`;
}

function points(text: string): string[] {
	return Array.from(text);
}

/** One physical line: whitespace runs, newlines included, become one space. */
export function foldLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The first `max` code points, ending in an ellipsis when anything was cut. */
function clipPoints(text: string, max: number): string {
	const all = points(text);
	if (all.length <= max) return text;
	return `${all.slice(0, Math.max(1, max - 1)).join("").trimEnd()}${ELLIPSIS}`;
}

/** The longest prefix of `text` that fits `maxBytes` UTF-8 bytes, ending in an ellipsis when anything was cut. */
export function clipBytes(text: string, maxBytes: number): string {
	if (utf8Bytes(text) <= maxBytes) return text;
	const room = maxBytes - utf8Bytes(ELLIPSIS);
	if (room <= 0) return "";
	let used = 0;
	let out = "";
	for (const point of points(text)) {
		const size = utf8Bytes(point);
		if (used + size > room) break;
		used += size;
		out += point;
	}
	return `${out.trimEnd()}${ELLIPSIS}`;
}

/** An item as one line of at most `max` characters (its fixed parts excepted, see `MIN_BODY_CHARS`). */
function clipLine(item: BriefItem, max: number): string {
	const text = foldLine(item.text);
	if (item.clip === undefined) return clipPoints(text, max);
	// The range indexes the original text; whitespace folding can move it, so a
	// folded line is clipped as a whole rather than at a stale offset.
	if (text !== item.text) return clipPoints(text, max);
	const [from, to] = item.clip;
	const lead = text.slice(0, from);
	const body = text.slice(from, to);
	const tail = text.slice(to);
	const room = max - points(lead).length - points(tail).length;
	return `${lead}${clipPoints(body, Math.max(room, MIN_BODY_CHARS))}${tail}`;
}

interface Group {
	section: BriefSection;
	index: number;
	lines: string[];
	/** Items the node cap left out before any byte budget applied. */
	capped: number;
	kept: number;
	/** A title with no items. It is one droppable unit, not a line that can never be omitted. */
	notice: boolean;
}

function clampLimit(value: number, min: number, max: number): number {
	return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;
}

/**
 * The `compact` profile.
 *
 * Layout: the state line, then every section in priority order (heading,
 * status, warnings, decisions, nodes, actions, other graphs), each section's
 * title above its items. Every line is one physical line clipped to
 * `memoryChars`; nodes are held first and at most `nodes` of them.
 *
 * The cap is on the rendered UTF-8 byte length, omitted line included. It is
 * met by dropping whole lines, lowest-priority section first and the last item
 * of a section before its first, never by cutting a line in the middle, and
 * the final line says exactly how many of each kind are missing:
 * `...omitted: nodes 7, decisions 2 (profile=compact; request profile=full)`.
 * The heading alone is never dropped; if even it cannot fit it is cut to the
 * bytes left, and a last guard cuts the text itself, so the cap always holds.
 * Pure and deterministic: the same sections and limits give the same text.
 */
export function renderCompactBrief(sections: readonly BriefSection[], stateLine: string, limits: CompactLimits): string {
	const nodesCap = clampLimit(limits.nodes, 1, MAX_COMPACT_NODES);
	const chars = clampLimit(limits.memoryChars, MIN_COMPACT_CHARS, MAX_COMPACT_CHARS);
	const cap = clampLimit(limits.bytes, MIN_COMPACT_BYTES, MAX_COMPACT_BYTES);

	const groups: Group[] = sections.map((section, index) => {
		let items = section.items;
		let capped = 0;
		if (section.id === "nodes") {
			items = [...items].sort((a, b) => (a.rank ?? DEFAULT_NODE_RANK) - (b.rank ?? DEFAULT_NODE_RANK));
			if (items.length > nodesCap) {
				capped = items.length - nodesCap;
				items = items.slice(0, nodesCap);
			}
		}
		const lines = items.map((item) => (section.id === "heading" ? clipPoints(foldLine(item.text), HEADING_CHARS) : clipLine(item, chars)));
		const notice = lines.length === 0 && section.title !== undefined && section.title !== "";
		// A title-only notice is one unit. kept starts at 1 so the byte budget can drop it like any other line.
		return { section, index, lines, capped, kept: notice ? 1 : lines.length, notice };
	});
	const priorityOf = (group: Group): number => BRIEF_SECTION_PRIORITY[group.section.id];
	const display = [...groups].sort((a, b) => priorityOf(a) - priorityOf(b) || a.index - b.index);
	const dropOrder = groups.filter((group) => group.section.id !== "heading").sort((a, b) => priorityOf(b) - priorityOf(a) || b.index - a.index);

	const render = (): string => {
		const out = [stateLine];
		for (const group of display) {
			const title = group.section.title === undefined ? undefined : foldLine(group.section.title);
			// A dropped notice (kept 0) is omitted, not printed. A kept notice is the title alone.
			if (group.kept === 0) continue;
			if (title !== undefined && title !== "") out.push(title);
			for (const line of group.lines.slice(0, group.kept)) out.push(line);
		}
		const missing = groups
			.map((group) => ({ label: OMIT_LABEL[group.section.id], count: (group.notice ? (group.kept === 0 ? 1 : 0) : group.capped + group.lines.length - group.kept) + (group.section.unlisted ?? 0) }))
			.filter((entry) => entry.count > 0);
		if (missing.length > 0) {
			out.push(`...omitted: ${missing.map((entry) => `${entry.label} ${entry.count}`).join(", ")} (profile=compact; request profile=full)`);
		}
		return out.join("\n");
	};

	let cursor = 0;
	const dropOne = (): boolean => {
		let group = dropOrder[cursor];
		while (group !== undefined && group.kept === 0) {
			cursor++;
			group = dropOrder[cursor];
		}
		if (group === undefined) return false;
		group.kept--;
		return true;
	};

	let text = render();
	while (utf8Bytes(text) > cap && dropOne()) text = render();
	if (utf8Bytes(text) > cap) {
		const heading = groups.find((group) => group.section.id === "heading" && group.lines.length > 0);
		const original = heading?.lines[0];
		if (heading !== undefined && original !== undefined) {
			heading.lines[0] = "";
			const room = cap - utf8Bytes(render());
			heading.lines[0] = clipBytes(original, Math.max(0, room));
			text = render();
		}
	}
	return utf8Bytes(text) > cap ? clipBytes(text, cap) : text;
}

// ── the cached form ──────────────────────────────────────────────────────────

const ENCODING_VERSION = 1;
/** An encoded brief past this is not one the service wrote; refuse it before parsing. */
export const MAX_ENCODED_CHARS = 1_048_576;
const MAX_SECTIONS = 16;
const MAX_ENTRIES = 2000;

/** The cache value for a composed brief: the sections, so either profile renders from one entry. */
export function encodeSections(sections: readonly BriefSection[]): string {
	return JSON.stringify({ v: ENCODING_VERSION, sections });
}

const ItemSchema = z
	.object({
		text: z.string(),
		clip: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
		rank: z.number().optional(),
	})
	.refine((item) => item.clip === undefined || (item.clip[0] <= item.clip[1] && item.clip[1] <= item.text.length));

const SectionSchema = z.object({
	id: z.string().refine((id) => Object.hasOwn(BRIEF_SECTION_PRIORITY, id)),
	lines: z.array(z.string()).max(MAX_ENTRIES),
	title: z.string().optional(),
	items: z.array(ItemSchema).max(MAX_ENTRIES),
	unlisted: z.number().int().min(0).optional(),
});

const SectionsSchema = z.array(SectionSchema).max(MAX_SECTIONS);
const EncodedSchema = z.object({ v: z.literal(ENCODING_VERSION), sections: SectionsSchema });

/** Sections from an untrusted value (a cache entry, a stored snapshot), or null when it is not what `encodeSections` wrote. */
export function parseSections(value: unknown): BriefSection[] | null {
	const parsed = SectionsSchema.safeParse(value);
	return parsed.success ? (parsed.data as BriefSection[]) : null;
}

/** The sections an `encodeSections` string holds, or null for anything else (an entry from before profiles, a foreign value): a miss, never a throw. */
export function decodeSections(raw: unknown): BriefSection[] | null {
	if (typeof raw !== "string" || raw.length > MAX_ENCODED_CHARS) return null;
	try {
		const parsed = EncodedSchema.safeParse(JSON.parse(raw));
		return parsed.success ? (parsed.data.sections as BriefSection[]) : null;
	} catch {
		return null;
	}
}
