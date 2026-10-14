/**
 * Agent Card fixture corpus (Phase 29, D29-08).
 *
 * One valid card plus one card per missing-field violation, including the
 * acc30a8 stub shape (`{agent, surface, version, skills[{name, framing,
 * tags}], teachables[]}`) as the pinned rejection: it is not spec-valid —
 * no `id`, `description`, `supportedInterfaces`, `capabilities`, or default
 * modes — and the validator must say so field by field.
 */
import type { AgentCard } from "./agent-card.ts";

/** One corpus row: the card plus whether the validator must accept it. */
export interface AgentCardFixture {
	name: string;
	card: unknown;
	valid: boolean;
}

export const VALID_CARD: AgentCard = {
	id: "agent-card:hermes",
	name: "hermes",
	description: "Agent card for the hermes surface: 1 taught skill.",
	url: "/.well-known/agent-card.json?surface=hermes",
	version: "1.0.0",
	capabilities: { streaming: false, pushNotifications: false },
	defaultInputModes: ["text"],
	defaultOutputModes: ["text"],
	supportedInterfaces: ["http"],
	skills: [
		{
			id: "mem_1",
			name: "retry-budget",
			description: "cap retries at three before paging the human",
			tags: ["teachable-moment"],
		},
	],
};

function without(...fields: string[]): Record<string, unknown> {
	const card = { ...VALID_CARD } as Record<string, unknown>;
	for (const field of fields) delete card[field];
	return card;
}

/** The acc30a8 stub shape, recorded only as what the validator rejects. */
export const STUB_SHAPE_CARD = {
	agent: "hermes",
	surface: "hermes",
	version: "v0.3-a2a",
	skills: [{ name: "retry-budget", framing: "cap retries", tags: ["teachable-moment"] }],
	teachables: ["teachable:retry-budget"],
};

export const AGENT_CARD_FIXTURES: AgentCardFixture[] = [
	{ name: "valid", card: VALID_CARD, valid: true },
	{ name: "valid-empty-skills", card: { ...VALID_CARD, skills: [] }, valid: true },
	{ name: "missing-id", card: without("id"), valid: false },
	{ name: "missing-name", card: without("name"), valid: false },
	{ name: "missing-description", card: without("description"), valid: false },
	{ name: "missing-url", card: without("url"), valid: false },
	{ name: "missing-version", card: without("version"), valid: false },
	{ name: "missing-capabilities", card: without("capabilities"), valid: false },
	{ name: "missing-input-modes", card: without("defaultInputModes"), valid: false },
	{ name: "missing-output-modes", card: without("defaultOutputModes"), valid: false },
	{ name: "missing-interfaces", card: without("supportedInterfaces"), valid: false },
	{ name: "missing-skills", card: without("skills"), valid: false },
	{
		name: "skill-empty-description",
		card: { ...VALID_CARD, skills: [{ id: "mem_1", name: "retry-budget", description: "", tags: ["teachable-moment"] }] },
		valid: false,
	},
	{
		name: "skill-bad-name",
		card: { ...VALID_CARD, skills: [{ id: "mem_1", name: "Retry Budget!", description: "x", tags: ["teachable-moment"] }] },
		valid: false,
	},
	{
		name: "skill-missing-tag",
		card: { ...VALID_CARD, skills: [{ id: "mem_1", name: "retry-budget", description: "x", tags: [] }] },
		valid: false,
	},
	{ name: "stub-shape", card: STUB_SHAPE_CARD, valid: false },
	{ name: "not-an-object", card: null, valid: false },
];
