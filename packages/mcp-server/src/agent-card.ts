/**
 * Per-surface A2A Agent Cards (Phase 29, CARD-01/CARD-02).
 *
 * `buildAgentCard` renders the card for one surface from its live teachables;
 * `validateAgentCard` checks the repo-documented v1.0 field set and returns a
 * list of violations (empty = valid).
 *
 * UNVERIFIED against the published A2A spec: the required-field set below is
 * assembled from in-repo research (ROADMAP CARD-01, STACK.md §F, F-D1,
 * ARCHITECTURE §F2), and confirming it against the published spec is
 * OPERATOR-GATED G1. This validator must not calcify an assumed set — G1
 * confirms or corrects it. The executor MUST NOT fetch the spec to resolve
 * this; the G1 marker is the resolution path.
 *
 * `skills[]` lists teachables only in v1.3 (D29-05): no library `SKILL.md`
 * frontmatter entries. No `planes/` import, no `SOLANA_*` names.
 */
import { redact } from "./redact.ts";
import { SKILL_NAME_RE } from "./skills/propose.ts";
import { SURFACES, type MemoryEntry, type Surface } from "./types.ts";

/** Card version stamped on every built card (executor discretion; G1 may correct). */
export const AGENT_CARD_VERSION = "1.0.0";

/**
 * Skill descriptions carry the entry's redacted text, capped (DOCS-01 snippet
 * precedent). Re-passed through shared `redact.ts` defensively: the gate
 * already redacted on write, but a card is a second publication surface.
 */
export const CARD_SKILL_DESCRIPTION_MAX = 1200;

/** The tag every teachable skill entry carries (F-D1 literal). */
export const TEACHABLE_SKILL_TAG = "teachable-moment";

/** One `skills[]` entry: a single accepted teachable (F-D1 shape, `examples` omitted — no source data exists). */
export interface AgentSkill {
	id: string;
	name: string;
	description: string;
	tags: string[];
}

/** The repo-documented A2A v1.0 card shape (UNVERIFIED — see module note). */
export interface AgentCard {
	id: string;
	name: string;
	description: string;
	url: string;
	version: string;
	capabilities: Record<string, unknown>;
	defaultInputModes: string[];
	defaultOutputModes: string[];
	supportedInterfaces: string[];
	skills: AgentSkill[];
}

/**
 * Normalise a teachable slug to a phase-21 skill name: lowercase, separator
 * runs folded to one `-`, padded to `SKILL_NAME_RE`. Unusable slugs (empty
 * after folding) become `teachable`, so the builder never emits an invalid
 * name — the validator still rejects one if it ever sees it.
 */
export function normalizeSkillName(slug: string): string {
	const folded = slug
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	if (folded && SKILL_NAME_RE.test(folded)) return folded;
	const fallback = `teachable-${folded}`.slice(0, 64).replace(/-+$/g, "");
	if (fallback && SKILL_NAME_RE.test(fallback)) return fallback;
	return "teachable";
}

/**
 * Render one surface's card. One `skills[]` entry per teachable, newest
 * first: `id` is the accepted memory id, `name` the slug normalised to
 * `SKILL_NAME_RE` (numeric suffix on fold collision), `description` the
 * redacted text capped at 1,200 chars. A surface with no teachables gets a
 * valid card with empty `skills[]` — untaught is valid, not an error.
 */
export function buildAgentCard(surface: Surface, teachables: readonly MemoryEntry[]): AgentCard {
	const used = new Set<string>();
	const skills: AgentSkill[] = teachables.map((entry) => {
		const slug = (entry.subject ?? "").replace(/^teachable:/i, "");
		const base = normalizeSkillName(slug || entry.id);
		let name = base;
		for (let n = 2; used.has(name); n++) name = `${base.slice(0, 64 - String(n).length - 1)}-${n}`;
		used.add(name);
		return {
			id: entry.id,
			name,
			// A stale entry stays listed but says so: trust decay marks old
			// memories `needs_reverification`, and a card that hid the warning
			// would publish possibly-outdated advice as taught skill.
			description: `${entry.needs_reverification ? "Check this advice before use. " : ""}${redact(entry.text)}`.slice(
				0,
				CARD_SKILL_DESCRIPTION_MAX,
			),
			tags: [TEACHABLE_SKILL_TAG],
		};
	});
	return {
		id: `agent-card:${surface}`,
		name: surface,
		description: `Agent card for the ${surface} surface: ${skills.length === 0 ? "no teachables yet" : `${skills.length} taught skill${skills.length === 1 ? "" : "s"}`}.`,
		url: `/.well-known/agent-card.json?surface=${surface}`,
		version: AGENT_CARD_VERSION,
		capabilities: { streaming: false, pushNotifications: false },
		defaultInputModes: ["text"],
		defaultOutputModes: ["text"],
		supportedInterfaces: ["http"],
		skills,
	};
}

/**
 * Check a card against the repo-documented v1.0 set. Returns violations;
 * empty means valid. UNVERIFIED-in-code until G1 confirms the set.
 */
export function validateAgentCard(card: unknown): string[] {
	const violations: string[] = [];
	if (!card || typeof card !== "object" || Array.isArray(card)) return ["card must be an object"];
	const record = card as Record<string, unknown>;
	for (const field of ["id", "name", "description", "url", "version"]) {
		if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
			violations.push(`${field} must be a non-empty string`);
		}
	}
	if (!record.capabilities || typeof record.capabilities !== "object" || Array.isArray(record.capabilities)) {
		violations.push("capabilities must be an object");
	}
	for (const field of ["defaultInputModes", "defaultOutputModes", "supportedInterfaces"]) {
		const value = record[field];
		if (!Array.isArray(value) || value.length === 0 || !value.every((mode) => typeof mode === "string" && mode.length > 0)) {
			violations.push(`${field} must be a non-empty array of non-empty strings`);
		}
	}
	if (!Array.isArray(record.skills)) {
		violations.push("skills must be an array");
		return violations;
	}
	const names = new Set<string>();
	for (const [index, skill] of record.skills.entries()) {
		const prefix = `skills[${index}]`;
		if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
			violations.push(`${prefix} must be an object`);
			continue;
		}
		const entry = skill as Record<string, unknown>;
		if (typeof entry.id !== "string" || entry.id.length === 0) violations.push(`${prefix}.id must be a non-empty string`);
		if (typeof entry.name !== "string" || !SKILL_NAME_RE.test(entry.name)) {
			violations.push(`${prefix}.name must match SKILL_NAME_RE`);
		} else if (names.has(entry.name)) {
			violations.push(`${prefix}.name duplicates ${JSON.stringify(entry.name)}`);
		} else {
			names.add(entry.name);
		}
		if (typeof entry.description !== "string" || entry.description.length === 0) {
			violations.push(`${prefix}.description must be a non-empty string`);
		}
		if (!Array.isArray(entry.tags) || !entry.tags.includes(TEACHABLE_SKILL_TAG)) {
			violations.push(`${prefix}.tags must include ${JSON.stringify(TEACHABLE_SKILL_TAG)}`);
		}
	}
	return violations;
}

/** Whether a surface name is one this server cards (the route owns the 400). */
export function isKnownCardSurface(surface: unknown): surface is Surface {
	return typeof surface === "string" && (SURFACES as readonly string[]).includes(surface);
}
