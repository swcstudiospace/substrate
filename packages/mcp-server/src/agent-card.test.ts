/**
 * Agent Cards (Phase 29, CARD-01/CARD-02).
 *
 * Pins the card builder (per-surface identity, teachable-mapped `skills[]`,
 * fold-collision suffixes), the fake spec validator against its fixture
 * corpus (including the stub-shape rejection), the `teachablesForSurface`
 * reader, and the loopback route over a real listener.
 */
import { describe, expect, test } from "bun:test";
import {
	AGENT_CARD_VERSION,
	buildAgentCard,
	isKnownCardSurface,
	normalizeSkillName,
	TEACHABLE_SKILL_TAG,
	validateAgentCard,
} from "./agent-card.ts";
import { AGENT_CARD_FIXTURES, VALID_CARD } from "./agent-card.fixtures.ts";
import { loadConfig } from "./config.ts";
import { createObservability } from "./observe.ts";
import { Substrate } from "./service.ts";
import { createHttpServer } from "./server.ts";
import { SURFACES, type MemoryEntry, type MemorySearch, type MemorySearchPage } from "./types.ts";

/** A standing memory entry; callers override what their case needs. */
function entry(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
	return {
		scope: "graph:ut-card",
		kind: "fact",
		text: "cap retries at three before paging the human",
		writer: "hermes",
		subject: "teachable:retry-budget",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "graph",
		created: "2026-10-01T10:00:00.000Z",
		version: 1,
		entry_hash: "c".repeat(64),
		needs_reverification: false,
		...over,
	};
}

/**
 * An index stub that honours `subjectPrefix` and `includeSuperseded` the way
 * the real store does (literal prefix via `left()`, newest first), so the
 * reader is exercised against store semantics, not a canned answer.
 */
function prefixIndex(rows: MemoryEntry[]) {
	return {
		searchMemoryPage: async (search: MemorySearch): Promise<MemorySearchPage> => {
			const prefix = search.subjectPrefix ?? null;
			const kept = rows
				.filter((row) => (prefix === null || row.subject?.startsWith(prefix)) ?? false)
				.filter((row) => search.includeSuperseded || !row.superseded_by)
				.sort((a, b) => (b.created === a.created ? (b.id < a.id ? -1 : 1) : b.created < a.created ? -1 : 1));
			const limit = search.limit ?? 20;
			let start = 0;
			if (search.before !== undefined) {
				start = kept.findIndex(
					(row) => row.created < search.before! || (row.created === search.before && row.id < (search.beforeId ?? "")),
				);
				if (start === -1) start = kept.length;
			}
			const page = kept.slice(start, start + limit);
			const rest = kept.slice(start + limit);
			return {
				entries: page,
				next: rest.length === 0 || page.length === 0
					? null
					: { before: page[page.length - 1]!.created, before_id: page[page.length - 1]!.id },
			};
		},
	};
}

describe("normalizeSkillName", () => {
	test("lowercases and folds separators", () => {
		expect(normalizeSkillName("Retry-Budget")).toBe("retry-budget");
		expect(normalizeSkillName("retry_budget")).toBe("retry-budget");
		expect(normalizeSkillName("retry  budget")).toBe("retry-budget");
	});

	test("never emits an invalid name", () => {
		expect(normalizeSkillName("")).toBe("teachable");
		expect(normalizeSkillName("!!!")).toBe("teachable");
	});
});

describe("buildAgentCard", () => {
	test("every known surface gets a validator-clean card with a unique id", () => {
		const ids = new Set<string>();
		for (const surface of SURFACES) {
			const card = buildAgentCard(surface, []);
			expect(validateAgentCard(card)).toEqual([]);
			expect(card.skills).toEqual([]);
			ids.add(card.id);
		}
		expect(ids.size).toBe(SURFACES.length);
	});

	test("one skill entry per teachable, newest first", () => {
		const older = entry({ id: "mem_old", subject: "teachable:retry-budget", created: "2026-10-01T10:00:00.000Z" });
		const newer = entry({ id: "mem_new", subject: "teachable:paging-policy", created: "2026-10-01T11:00:00.000Z" });
		const card = buildAgentCard("hermes", [newer, older]);

		expect(validateAgentCard(card)).toEqual([]);
		expect(card.skills.map((skill) => skill.id)).toEqual(["mem_new", "mem_old"]);
		expect(card.skills[0]).toMatchObject({ name: "paging-policy", tags: [TEACHABLE_SKILL_TAG] });
		expect(card.version).toBe(AGENT_CARD_VERSION);
	});

	test("fold collisions keep both entries with a numeric suffix", () => {
		const a = entry({ id: "mem_a", subject: "teachable:Retry-Budget" });
		const b = entry({ id: "mem_b", subject: "teachable:retry_budget", text: "budgets compose per surface" });
		const card = buildAgentCard("hermes", [a, b]);

		expect(validateAgentCard(card)).toEqual([]);
		expect(card.skills.map((skill) => skill.name)).toEqual(["retry-budget", "retry-budget-2"]);
		expect(card.skills.map((skill) => skill.id)).toEqual(["mem_a", "mem_b"]);
	});

	test("descriptions are redacted and capped at 1200 chars", () => {
		const secret = entry({
			id: "mem_s",
			subject: "teachable:deploy-key",
			text: `rotate it: PGPASSWORD=s3cr3t-do-not-log. ${"padding ".repeat(400)}`,
		});
		const card = buildAgentCard("hermes", [secret]);

		expect(validateAgentCard(card)).toEqual([]);
		expect(card.skills[0]?.description).not.toContain("s3cr3t");
		expect(card.skills[0]?.description.length).toBeLessThanOrEqual(1200);
	});
});

describe("validateAgentCard", () => {
	test("the fixture corpus answers its pinned verdict", () => {
		for (const fixture of AGENT_CARD_FIXTURES) {
			const violations = validateAgentCard(fixture.card);
			if (fixture.valid) expect(violations).toEqual([]);
			else expect(violations.length).toBeGreaterThan(0);
		}
	});

	test("the stub shape is rejected field by field", () => {
		const violations = validateAgentCard({
			agent: "hermes",
			surface: "hermes",
			version: "v0.3-a2a",
			skills: [{ name: "retry-budget", framing: "cap retries", tags: ["teachable-moment"] }],
			teachables: ["teachable:retry-budget"],
		});
		const joined = violations.join("\n");
		for (const field of ["id", "description", "capabilities", "defaultInputModes", "supportedInterfaces", "skills[0].description"]) {
			expect(joined).toContain(field);
		}
	});

	test("duplicate skill names are rejected", () => {
		expect(
			validateAgentCard({
				...VALID_CARD,
				skills: [
					{ id: "mem_1", name: "retry-budget", description: "a", tags: [TEACHABLE_SKILL_TAG] },
					{ id: "mem_2", name: "retry-budget", description: "b", tags: [TEACHABLE_SKILL_TAG] },
				],
			}).join("\n"),
		).toContain("duplicates");
	});
});

describe("teachablesForSurface", () => {
	const rows = [
		entry({ id: "mem_live", subject: "teachable:retry-budget", created: "2026-10-01T10:00:00.000Z" }),
		entry({ id: "mem_newer", subject: "teachable:paging-policy", created: "2026-10-01T12:00:00.000Z" }),
		entry({ id: "mem_warn", kind: "warning", subject: "teachable:noisy", created: "2026-10-01T13:00:00.000Z" }),
		entry({ id: "mem_plain", subject: "n2-status", created: "2026-10-01T14:00:00.000Z" }),
		entry({ id: "mem_omp", writer: "omp", subject: "teachable:other-surface", created: "2026-10-01T15:00:00.000Z" }),
		entry({ id: "mem_old", subject: "teachable:retired", superseded_by: "mem_live", created: "2026-10-01T09:00:00.000Z" }),
	];

	function substrateFor(index: unknown) {
		return new Substrate(loadConfig({}), { index: index as never, greptime: null });
	}

	test("returns exactly the surface's live teachable facts, newest first", async () => {
		const teachables = await substrateFor(prefixIndex(rows)).teachablesForSurface("hermes");

		expect(teachables.map((row) => row.id)).toEqual(["mem_newer", "mem_live"]);
	});

	test("another surface sees only its own", async () => {
		const teachables = await substrateFor(prefixIndex(rows)).teachablesForSurface("omp");

		expect(teachables.map((row) => row.id)).toEqual(["mem_omp"]);
	});

	test("an unknown surface reads as an empty list — the route owns the 400", async () => {
		expect(await substrateFor(prefixIndex(rows)).teachablesForSurface("nope")).toEqual([]);
		expect(isKnownCardSurface("nope")).toBe(false);
		expect(isKnownCardSurface("hermes")).toBe(true);
	});

	test("no index reads as an empty list", async () => {
		expect(await substrateFor(null).teachablesForSurface("hermes")).toEqual([]);
	});
});

describe("GET /.well-known/agent-card.json", () => {
	/** Boot the real server on an ephemeral port; `stop` closes it. */
	async function serve(index: unknown) {
		const config = loadConfig({});
		const observability = createObservability(config, {});
		await observability.start();
		const substrate = new Substrate(config, { index: index as never, greptime: null }, observability.observer);
		const server = createHttpServer(substrate, config, observability);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		return {
			get: (path: string) => fetch(`http://127.0.0.1:${port}${path}`),
			stop: () =>
				new Promise<void>((resolve) => {
					observability.stop();
					server.close(() => resolve());
				}),
		};
	}

	const cardRows = [
		entry({ id: "mem_live", subject: "teachable:retry-budget", session_id: "sess-p29-teachable", graph_id: "ut-card" }),
	];

	test("200 with a validator-clean card for a taught surface", async () => {
		const { get, stop } = await serve(prefixIndex(cardRows));
		try {
			const response = await get("/.well-known/agent-card.json?surface=hermes");
			expect(response.status).toBe(200);
			const card = (await response.json()) as Record<string, unknown>;
			expect(validateAgentCard(card)).toEqual([]);
			const skills = card.skills as Array<Record<string, unknown>>;
			expect(skills).toHaveLength(1);
			expect(skills[0]).toMatchObject({ id: "mem_live", name: "retry-budget" });
		} finally {
			await stop();
		}
	});

	test("200 with empty skills for an untaught surface", async () => {
		const { get, stop } = await serve(prefixIndex(cardRows));
		try {
			const response = await get("/.well-known/agent-card.json?surface=omp");
			expect(response.status).toBe(200);
			const card = (await response.json()) as Record<string, unknown>;
			expect(validateAgentCard(card)).toEqual([]);
			expect(card.skills).toEqual([]);
		} finally {
			await stop();
		}
	});

	test("400 naming the parameter when surface is missing", async () => {
		const { get, stop } = await serve(prefixIndex(cardRows));
		try {
			const response = await get("/.well-known/agent-card.json");
			expect(response.status).toBe(400);
			expect(((await response.json()) as Record<string, unknown>).error).toContain("surface");
		} finally {
			await stop();
		}
	});

	test("400 for an unknown surface", async () => {
		const { get, stop } = await serve(prefixIndex(cardRows));
		try {
			const response = await get("/.well-known/agent-card.json?surface=nope");
			expect(response.status).toBe(400);
		} finally {
			await stop();
		}
	});

	test("anonymous loopback GETs return 200 — discovery needs no bearer", async () => {
		const { get, stop } = await serve(prefixIndex(cardRows));
		try {
			const response = await get("/.well-known/agent-card.json?surface=hermes");
			expect(response.status).toBe(200);
		} finally {
			await stop();
		}
	});
});
