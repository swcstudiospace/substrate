/**
 * Agent Cards: per-surface A2A v1.0 cards whose `skills[]` list that surface's
 * accepted teachables.
 *
 * A card is what an A2A client reads to learn what an agent has been taught:
 * one skill entry per live teachable fact, served on loopback at
 * `/.well-known/agent-card.json?surface=<name>`. The builder here is pure —
 * the surface's teachables in, a spec-valid card out — so the route stays a
 * thin reader and the validator pins the CARD-01 contract in tests.
 *
 * Skill entries follow the phase-21 frontmatter contract the same way skill
 * proposals do: `name` satisfies `SKILL_NAME_RE`, `description` is non-empty.
 * The description is the teachable's redacted text capped at 1,200 chars (the
 * DOCS-01 snippet precedent), redacted again defensively — the gate already
 * redacted it, but a card is a new reader and readers do not trust writers.
 */
import { redact } from "./redact.ts";
import { SKILL_NAME_RE } from "./skills/propose.ts";
import { teachableSlug } from "./teachable.ts";
import type { MemoryEntry, Surface } from "./types.ts";
/** Card version: the contract version, not the package version. */
export const AGENT_CARD_VERSION = "1.0";

/** The binding this deployment's card speaks: JSON over loopback HTTP. */
export const AGENT_CARD_PROTOCOL_BINDING = "HTTP+JSON";

/** `http://host:port`, with an IPv6 host in brackets so the result is a URL. */
export function agentCardOrigin(host: string, port: number): string {
	const literal = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	return `http://${literal}:${port}`;
}

/** Skill description cap: the DOCS-01 snippet precedent, in characters. */
export const TEACHABLE_SKILL_DESCRIPTION_CHARS = 1200;

/** One A2A interface: where this card is served, and which binding it speaks. */
export interface AgentCardInterface {
	url: string;
	protocolBinding: string;
	protocolVersion: string;
}

/** One `skills[]` entry: a single lesson this surface was taught. */
export interface AgentCardSkill {
	id: string;
	name: string;
	description: string;
	tags: string[];
}

/** The per-surface A2A v1.0 card the route serves. */
export interface AgentCard {
	id: string;
	name: string;
	description: string;
	url: string;
	version: string;
	supportedInterfaces: AgentCardInterface[];
	capabilities: { streaming: boolean; pushNotifications: boolean };
	defaultInputModes: string[];
	defaultOutputModes: string[];
	skills: AgentCardSkill[];
}

/**
 * A slug the skill-name rule accepts. Teachable slugs are already lowercase,
 * but may carry characters the rule refuses (spaces, slashes, underscores),
 * so anything outside `[a-z0-9-]` folds to a dash and edge dashes are trimmed.
 * Total: where nothing usable remains, the memory id stands in rather than
 * dropping the entry — every accepted teachable appears exactly once.
 */
export function skillNameForTeachable(slug: string, memoryId: string): string {
	const clean = (value: string): string =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64);
	const fromSlug = clean(slug);
	if (fromSlug && SKILL_NAME_RE.test(fromSlug)) return fromSlug;
	const fromId = clean(`teachable-${memoryId}`);
	if (fromId && SKILL_NAME_RE.test(fromId)) return fromId;
	return "teachable-lesson";
}

/**
 * A skill description that is never empty and never raw: the teachable's
 * redacted body, capped, redacted again defensively, with a named fallback
 * where redaction left nothing to show.
 */
export function skillDescriptionForTeachable(entry: MemoryEntry, slug: string): string {
	const capped = redact(entry.text).slice(0, TEACHABLE_SKILL_DESCRIPTION_CHARS).trim();
	const body = capped || `Teachable moment ${slug} recorded by ${entry.writer}.`;
	// A fact past its reverify window is not a lesson to act on yet. Briefs say
	// so; the card says so in the description rather than presenting it as fresh.
	if (!entry.needs_reverification) return body;
	const warned = `Needs reverification before use. ${body}`;
	return warned.slice(0, TEACHABLE_SKILL_DESCRIPTION_CHARS);
}

function skillForTeachable(entry: MemoryEntry): AgentCardSkill {
	const slug = teachableSlug(entry.subject) ?? entry.id;
	return {
		id: entry.id,
		name: skillNameForTeachable(slug, entry.id),
		description: skillDescriptionForTeachable(entry, slug),
		tags: ["teachable"],
	};
}

/**
 * A name not already on this card. Folded slugs collide (`Retry Budget` and
 * `retry-budget` are the same rule-name); the later entry takes `-2`, `-3`,
 * …, still inside the 64-character skill-name rule.
 */
function fitSkillName(base: string, suffix: string): string | null {
	if (suffix.length >= 64) return null;
	const trimmed = base.slice(0, 64 - suffix.length).replace(/-+$/g, "");
	const candidate = `${trimmed}${suffix}`;
	return SKILL_NAME_RE.test(candidate) ? candidate : null;
}

/**
 * A name not already on this card. Folded slugs collide; later entries take
 * `-2`, `-3`, … and keep going past 999 rather than reusing the base name.
 * `next` remembers the first suffix still worth trying for this base, so a
 * long run of the same name does not rescan the suffixes it already took.
 */
function uniqueSkillName(base: string, used: Set<string>, next: Map<string, number>): string {
	let n = next.get(base) ?? 2;
	if (!used.has(base) && n === 2) {
		next.set(base, 2);
		return base;
	}
	for (; n < 1_000_000; n++) {
		const candidate = fitSkillName(base, `-${n}`);
		if (candidate && !used.has(candidate)) {
			next.set(base, n + 1);
			return candidate;
		}
	}
	throw new Error("could not allocate a unique skill name");
}

function skillsForTeachables(teachables: MemoryEntry[]): AgentCardSkill[] {
	const used = new Set<string>();
	const next = new Map<string, number>();
	return teachables.map((entry) => {
		const skill = skillForTeachable(entry);
		const name = uniqueSkillName(skill.name, used, next);
		used.add(name);
		return { ...skill, name };
	});
}

/**
 * The card for one surface: its loopback URL, the A2A v1.0 fields, and one
 * skill entry per teachable, newest first as the reader returns them.
 *
 * `baseUrl` is the config-exposed loopback base (`http://host:port`), so the
 * card's `url` names where this deployment actually serves it.
 */
export function buildAgentCard(surface: Surface, baseUrl: string, teachables: MemoryEntry[]): AgentCard {
	const base = baseUrl.replace(/\/+$/, "");
	return {
		id: `substrate:${surface}`,
		name: `substrate/${surface}`,
		description:
			`Agent card for the ${surface} surface: ${teachables.length} teachable ` +
			`${teachables.length === 1 ? "moment" : "moments"} this surface has been taught.`,
		url: `${base}/.well-known/agent-card.json?surface=${encodeURIComponent(surface)}`,
		version: AGENT_CARD_VERSION,
		supportedInterfaces: [
			{
				url: `${base}/.well-known/agent-card.json?surface=${encodeURIComponent(surface)}`,
				protocolBinding: AGENT_CARD_PROTOCOL_BINDING,
				protocolVersion: AGENT_CARD_VERSION,
			},
		],
		capabilities: { streaming: false, pushNotifications: false },
		defaultInputModes: ["text"],
		defaultOutputModes: ["text"],
		skills: skillsForTeachables(teachables),
	};
}

/** A violation of the CARD-01 contract; empty means the card is valid. */
export function validateAgentCard(card: unknown): string[] {
	const violations: string[] = [];
	if (!card || typeof card !== "object" || Array.isArray(card)) return ["card must be an object"];
	const record = card as Record<string, unknown>;
	const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.length > 0;
	if (!nonEmpty(record.id)) violations.push("id must be a non-empty string");
	if (!nonEmpty(record.name)) violations.push("name must be a non-empty string");
	if (!nonEmpty(record.description)) violations.push("description must be a non-empty string");
	if (!nonEmpty(record.url)) violations.push("url must be a non-empty string");
	if (!nonEmpty(record.version)) violations.push("version must be a non-empty string");
	if (!Array.isArray(record.supportedInterfaces) || record.supportedInterfaces.length === 0) {
		violations.push("supportedInterfaces must be a non-empty array");
	} else {
		record.supportedInterfaces.forEach((item: unknown, index: number) => {
			const prefix = `supportedInterfaces[${index}]`;
			if (!item || typeof item !== "object" || Array.isArray(item)) {
				violations.push(`${prefix} must be an object`);
				return;
			}
			const iface = item as Record<string, unknown>;
			if (!nonEmpty(iface.url)) violations.push(`${prefix}.url must be a non-empty string`);
			if (!nonEmpty(iface.protocolBinding)) violations.push(`${prefix}.protocolBinding must be a non-empty string`);
			if (!nonEmpty(iface.protocolVersion)) violations.push(`${prefix}.protocolVersion must be a non-empty string`);
		});
	}
	if (!record.capabilities || typeof record.capabilities !== "object" || Array.isArray(record.capabilities)) {
		violations.push("capabilities must be an object");
	}
	for (const field of ["defaultInputModes", "defaultOutputModes"] as const) {
		const modes = record[field];
		if (!Array.isArray(modes) || modes.length === 0 || !modes.every(nonEmpty)) {
			violations.push(`${field} must be a non-empty array of non-empty strings`);
		}
	}
	if (!Array.isArray(record.skills)) {
		violations.push("skills must be an array");
		return violations;
	}
	record.skills.forEach((skill: unknown, index: number) => {
		const prefix = `skills[${index}]`;
		if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
			violations.push(`${prefix} must be an object`);
			return;
		}
		const entry = skill as Record<string, unknown>;
		if (!nonEmpty(entry.id)) violations.push(`${prefix}.id must be a non-empty string`);
		if (typeof entry.name !== "string" || !SKILL_NAME_RE.test(entry.name)) {
			violations.push(`${prefix}.name must match ${SKILL_NAME_RE.source}`);
		}
		if (!nonEmpty(entry.description)) violations.push(`${prefix}.description must be a non-empty string`);
	});
	return violations;
}
