import { describe, expect, test } from "bun:test";
import {
	AGENT_CARD_VERSION,
	buildAgentCard,
	skillDescriptionForTeachable,
	skillNameForTeachable,
	TEACHABLE_SKILL_DESCRIPTION_CHARS,
	validateAgentCard,
	type AgentCard,
} from "./agent-card.ts";
import { loadConfig } from "./config.ts";
import { Substrate } from "./service.ts";
import { SKILL_NAME_RE } from "./skills/propose.ts";
import type { MemoryEntry, MemorySearch, Surface } from "./types.ts";

const BASE = "http://127.0.0.1:7410";

function teachableEntry(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
	return {
		scope: "graph:ut-1",
		kind: "fact",
		text: "retry with a capped budget and backoff",
		writer: "hermes",
		subject: "teachable:retry-budget",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "graph",
		created: "2026-10-10T00:00:00.000Z",
		version: 1,
		entry_hash: "cd".repeat(32),
		needs_reverification: false,
		...over,
	};
}

describe("skillNameForTeachable", () => {
	test("a clean slug passes through", () => {
		expect(skillNameForTeachable("retry-budget", "mem_1")).toBe("retry-budget");
	});

	test("spaces, slashes and shouting fold to the skill rule", () => {
		const name = skillNameForTeachable("Retry Budget/2!", "mem_1");
		expect(name).toBe("retry-budget-2");
		expect(SKILL_NAME_RE.test(name)).toBe(true);
	});

	test("underscores fold too — memory ids are not skill names", () => {
		expect(skillNameForTeachable("my_lesson", "mem_1")).toBe("my-lesson");
	});

	test("nothing usable left falls back to the memory id, never an empty name", () => {
		const name = skillNameForTeachable("---", "mem_9");
		expect(SKILL_NAME_RE.test(name)).toBe(true);
		expect(name).toContain("mem-9");
	});

	test("a long slug caps at the rule's length", () => {
		const name = skillNameForTeachable("a".repeat(100), "mem_1");
		expect(name.length).toBeLessThanOrEqual(64);
		expect(SKILL_NAME_RE.test(name)).toBe(true);
	});
});

describe("skillDescriptionForTeachable", () => {
	test("ordinary text passes through", () => {
		const entry = teachableEntry({ id: "mem_1" });
		expect(skillDescriptionForTeachable(entry, "retry-budget")).toBe(entry.text);
	});

	test("a credential in the body is redacted, not published", () => {
		const leaked = `ghp_${"C".repeat(36)}`;
		const entry = teachableEntry({ id: "mem_1", text: `rotate the token ${leaked} weekly` });
		const description = skillDescriptionForTeachable(entry, "rotation");

		expect(description).not.toContain(leaked);
		expect(description).toContain("[REDACTED]");
	});

	test("a long body caps at the snippet precedent", () => {
		const entry = teachableEntry({ id: "mem_1", text: "x".repeat(2000) });
		expect(skillDescriptionForTeachable(entry, "long")).toHaveLength(TEACHABLE_SKILL_DESCRIPTION_CHARS);
		expect(TEACHABLE_SKILL_DESCRIPTION_CHARS).toBe(1200);
	});

	test("redaction that leaves nothing still yields a non-empty description", () => {
		const entry = teachableEntry({ id: "mem_1", text: `ghp_${"D".repeat(36)}` });
		const description = skillDescriptionForTeachable(entry, "rotation");

		expect(description.length).toBeGreaterThan(0);
		expect(description).not.toContain("ghp_");
	});
});

describe("buildAgentCard", () => {
	test("a surface with teachables gets a validator-clean card with one skill each", () => {
		const teachables = [
			teachableEntry({ id: "mem_2", subject: "teachable:retry-budget", created: "2026-10-10T00:02:00.000Z" }),
			teachableEntry({ id: "mem_1", subject: "teachable:backoff", created: "2026-10-10T00:01:00.000Z" }),
		];

		const card = buildAgentCard("hermes", BASE, teachables);

		expect(validateAgentCard(card)).toEqual([]);
		expect(card.skills).toHaveLength(2);
		expect(card.skills[0]).toMatchObject({ id: "mem_2", name: "retry-budget", tags: ["teachable"] });
		expect(card.skills[0]?.description.length).toBeGreaterThan(0);
		expect(card.skills[1]).toMatchObject({ id: "mem_1", name: "backoff" });
	});

	test("an empty surface still validates — no teachables is a card with no skills", () => {
		const card = buildAgentCard("hermes", BASE, []);

		expect(validateAgentCard(card)).toEqual([]);
		expect(card.skills).toEqual([]);
	});

	test("the url names the loopback base this deployment serves", () => {
		const card = buildAgentCard("hermes", "http://127.0.0.1:7410/", []);

		expect(card.url).toBe("http://127.0.0.1:7410/.well-known/agent-card.json?surface=hermes");
	});

	test("the A2A v1.0 fields are present with their contract values", () => {
		const card = buildAgentCard("omp", BASE, []);

		expect(card.id).toBe("substrate:omp");
		expect(card.version).toBe(AGENT_CARD_VERSION);
		expect(card.supportedInterfaces.length).toBeGreaterThan(0);
		expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false });
		expect(card.defaultInputModes).toEqual(["text"]);
		expect(card.defaultOutputModes).toEqual(["text"]);
	});
});

describe("validateAgentCard", () => {
	function valid(): AgentCard {
		return buildAgentCard("hermes", BASE, [teachableEntry({ id: "mem_1" })]);
	}

	test("catches every missing CARD-01 field", () => {
		const missing: Array<[string, (card: Record<string, unknown>) => void]> = [
			["id", (card) => delete card.id],
			["name", (card) => delete card.name],
			["description", (card) => delete card.description],
			["url", (card) => delete card.url],
			["version", (card) => delete card.version],
			["supportedInterfaces", (card) => delete card.supportedInterfaces],
			["capabilities", (card) => delete card.capabilities],
			["defaultInputModes", (card) => delete card.defaultInputModes],
			["defaultOutputModes", (card) => delete card.defaultOutputModes],
			["skills", (card) => delete card.skills],
		];
		for (const [field, remove] of missing) {
			const card = valid() as unknown as Record<string, unknown>;
			remove(card);
			expect(validateAgentCard(card).length, field).toBeGreaterThan(0);
		}
	});

	test("rejects degraded field shapes, not just absent ones", () => {
		const cases: Array<[string, unknown]> = [
			["empty modes", { ...valid(), defaultInputModes: [] }],
			["blank mode", { ...valid(), defaultOutputModes: [""] }],
			["null capabilities", { ...valid(), capabilities: null }],
			["array capabilities", { ...valid(), capabilities: [] }],
			["empty interfaces", { ...valid(), supportedInterfaces: [] }],
			["non-array skills", { ...valid(), skills: {} }],
		];
		for (const [name, card] of cases) {
			expect(validateAgentCard(card).length, name).toBeGreaterThan(0);
		}
	});

	test("every skill needs an id, a rule-valid name and a non-empty description", () => {
		const badSkills: unknown[] = [
			{ name: "fine", description: "d" },
			{ id: "mem_1", description: "d" },
			{ id: "mem_1", name: "Has Caps", description: "d" },
			{ id: "mem_1", name: "fine", description: "" },
			{ id: "mem_1", name: "fine" },
			"a-string-is-not-a-skill",
		];
		for (const skill of badSkills) {
			expect(validateAgentCard({ ...valid(), skills: [skill] }).length, JSON.stringify(skill)).toBeGreaterThan(0);
		}
	});

	test("rejects non-objects outright", () => {
		expect(validateAgentCard(null)).toHaveLength(1);
		expect(validateAgentCard("card")).toHaveLength(1);
		expect(validateAgentCard([])).toHaveLength(1);
	});
});

describe("teachablesForSurface", () => {
	/**
	 * An index stub that honours the three things the reader relies on —
	 * `subjectPrefix`, the superseded exclusion and newest-first keyset pages —
	 * so the reader test proves the filtering, not the SQL.
	 */
	function reader(rows: MemoryEntry[], surface: Surface | string = "hermes") {
		const ordered = [...rows].sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id));
		const index = {
			searchMemoryPage: async (search: MemorySearch) => {
				let out = search.includeSuperseded ? [...ordered] : ordered.filter((entry) => !entry.superseded_by);
				if (search.subjectPrefix) {
					const prefix = search.subjectPrefix;
					out = out.filter((entry) => (entry.subject ?? "").startsWith(prefix));
				}
				if (search.before) {
					const at = search.before;
					const tie = search.beforeId ?? "";
					out = out.filter((entry) => entry.created < at || (entry.created === at && entry.id < tie));
				}
				const limit = search.limit ?? 20;
				const entries = out.slice(0, limit);
				const last = entries[entries.length - 1];
				return {
					entries,
					next: entries.length === limit && out.length > limit && last ? { before: last.created, before_id: last.id } : null,
				};
			},
		};
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null });
		return substrate.teachablesForSurface(surface);
	}

	test("returns exactly the surface's live teachable facts, newest first", async () => {
		const rows = [
			teachableEntry({ id: "mem_new", subject: "teachable:retry-budget", writer: "hermes", created: "2026-10-10T00:03:00.000Z" }),
			teachableEntry({ id: "mem_warn", subject: "teachable:retry-budget", kind: "warning", writer: "hermes", created: "2026-10-10T00:04:00.000Z" }),
			teachableEntry({ id: "mem_plain", subject: "ordinary-note", writer: "hermes", created: "2026-10-10T00:05:00.000Z" }),
			teachableEntry({ id: "mem_other", subject: "teachable:retry-budget", writer: "omp", created: "2026-10-10T00:06:00.000Z" }),
			teachableEntry({ id: "mem_old", subject: "teachable:backoff", writer: "hermes", created: "2026-10-10T00:01:00.000Z" }),
			teachableEntry({ id: "mem_dead", subject: "teachable:retired", writer: "hermes", superseded_by: "mem_newer", created: "2026-10-10T00:02:00.000Z" }),
		];

		const found = await reader(rows);

		expect(found.map((entry) => entry.id)).toEqual(["mem_new", "mem_old"]);
	});

	test("an unknown surface reads as empty — the route owns the 400", async () => {
		const rows = [teachableEntry({ id: "mem_1", writer: "hermes" })];

		expect(await reader(rows, "nope")).toEqual([]);
	});

	test("no index reads as empty, never a throw", async () => {
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });

		expect(await substrate.teachablesForSurface("hermes")).toEqual([]);
	});

	test("pages past the first page — every live teachable appears once", async () => {
		const rows = Array.from({ length: 105 }, (_, i) =>
			teachableEntry({
				id: `mem_${String(i).padStart(3, "0")}`,
				subject: `teachable:lesson-${i}`,
				writer: "hermes",
				created: new Date(Date.UTC(2026, 9, 10, 0, 0, i)).toISOString(),
			}),
		);

		const found = await reader(rows);
		const ids = found.map((entry) => entry.id).sort();
		const unique = ids.filter((id, at) => ids.indexOf(id) === at);

		expect(found).toHaveLength(105);
		expect(unique).toHaveLength(105);
		expect(found[0]?.subject).toBe("teachable:lesson-104");
	});
});
