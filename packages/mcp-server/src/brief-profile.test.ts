/**
 * Brief profiles (uplift-4 S1): the compact rendering's cap and determinism,
 * the full rendering's byte parity with the pre-profile text, the flag
 * contract (off and shadow serve full, enforce serves compact to the listed
 * surfaces, an explicit full always wins), the cache's section shape and the
 * estimated-spend counters. Every store is a fake; nothing opens a socket.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { METRIC, SubstrateInstruments, findCounter, sumCounter } from "@substrate/observability";
import { composeBrief, composeBriefSections } from "./brief.ts";
import {
	BRIEF_SECTION_PRIORITY,
	DEFAULT_COMPACT_BYTES,
	MIN_COMPACT_BYTES,
	briefStateLine,
	decodeSections,
	encodeSections,
	loadBriefProfileConfig,
	parseBriefProfile,
	parseSections,
	renderCompactBrief,
	utf8Bytes,
	renderFullBrief,
	resolveBriefProfile,
	type BriefItem,
	type BriefSection,
	type BriefSectionId,
} from "./brief-profile.ts";
import { GRAPHS_GENERATION_KEY, ReadThroughCache, graphGenerationKey, snapshotKey, type CacheRedis } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { Substrate, briefEtag, type SubstrateObserver } from "./service.ts";
import { defined } from "./test-support.ts";
import { SURFACES } from "./types.ts";

const LIMITS = { nodes: 12, memoryChars: 240, bytes: 3500 };
const COMPLETE = "[brief: complete]";

// ── fixtures ─────────────────────────────────────────────────────────────────

function node(id: string, extra: Record<string, unknown> = {}) {
	return { graph_id: "ut-1", node_id: id, linear_identifier: null, state: "todo", lease_epoch: 1, ...extra };
}

function graphWith(nodes: unknown[]) {
	return {
		graph_id: "ut-1",
		notion_task_page: null,
		repo: "acme/app",
		branch: "main",
		surface: "grok-bot",
		status: "active",
		pr_url: null,
		created: null,
		updated: null,
		nodes,
		steps: [],
		edges: [],
	};
}

function entry(kind: "decision" | "warning", text: string, extra: Record<string, unknown> = {}) {
	return {
		id: `m-${kind}-${text.length}`,
		kind,
		text,
		writer: "hermes",
		trust: "human-confirmed",
		version: 1,
		created: new Date(Date.now() - 3 * 3_600_000).toISOString(),
		...extra,
	};
}

const RICH_NODES = [node("n1"), node("n2", { state: "completed", claimed_by: "hermes" })];
const RICH_MEMORY = [entry("decision", "use pnpm\nnot npm", { version: 2 }), entry("warning", "fence it", { writer: "omp" })];

/** A index whose reads are counted, so a cache hit is provable. */
function countingIndex(options: { nodes?: unknown[]; memory?: unknown[]; failGraph?: () => boolean } = {}) {
	const calls = { getGraph: 0, memoryForBrief: 0 };
	const index = {
		getGraph: async () => {
			calls.getGraph += 1;
			if (options.failGraph?.()) throw new Error("postgres is down");
			return graphWith(options.nodes ?? RICH_NODES);
		},
		openGraphs: async () => [{ graph_id: "ut-2", surface: "omp", status: "active", nodes: [] }],
		memoryForBrief: async () => {
			calls.memoryForBrief += 1;
			return options.memory ?? RICH_MEMORY;
		},
	};
	return { index, calls };
}

const ACTION_ROWS = [{ ts: Date.parse("2026-10-14T09:05:00Z"), surface: "omp", summary: "committed a fix", node_id: "n1", step: "2" }];
const GREPTIME = { sql: async () => ACTION_ROWS };

class FakeRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	/** When set, every plain `brief` entry reads back as this raw value, as an older process would have left it. */
	foreign: string | null = null;
	async get(key: string): Promise<string | null> {
		if (this.foreign !== null && key.includes(":brief:")) return this.foreign;
		return this.values.get(key) ?? null;
	}
	async set(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}
	async incr(key: string): Promise<number> {
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

function substrateOf(env: Record<string, string>, index: object, redis: FakeRedis, observer: SubstrateObserver = {}) {
	const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
	return new Substrate(loadConfig(env), { index: index as never, greptime: null, cache }, observer);
}

function observed(): { observer: SubstrateObserver; instruments: SubstrateInstruments } {
	const instruments = new SubstrateInstruments();
	return {
		instruments,
		observer: {
			briefResult: (sample) => instruments.recordBriefResult(sample),
			briefProfiled: (sample) => instruments.recordBriefProfile(sample),
			servedTokens: (sample) => instruments.recordServedTokens(sample),
		},
	};
}

function counterSum(instruments: SubstrateInstruments, name: string, where: Record<string, string> = {}): number {
	const counter = findCounter(instruments.snapshot(), name);
	return counter === null ? 0 : sumCounter(counter, where);
}

const REQUEST = { repo: "acme/app", graph_id: "ut-1" };

// ── configuration ────────────────────────────────────────────────────────────

describe("SUBSTRATE_BRIEF_PROFILE configuration", () => {
	test("defaults: shadow, grok-bot and grok-build, 12 nodes, 240 characters, 3500 bytes, no warnings", () => {
		const config = loadBriefProfileConfig({});
		expect(config.mode).toBe("shadow");
		expect([...config.surfaces].sort()).toEqual(["grok-bot", "grok-build"]);
		expect([config.nodes, config.memoryChars, config.bytes]).toEqual([12, 240, DEFAULT_COMPACT_BYTES]);
		expect(config.warnings).toEqual([]);
		expect(loadConfig({}).briefProfile).toEqual(config);
	});

	test("the three modes parse whatever the case; junk is shadow, with a warning that quotes at most 40 characters", () => {
		expect(loadBriefProfileConfig({ SUBSTRATE_BRIEF_PROFILE: " Enforce " }).mode).toBe("enforce");
		expect(loadBriefProfileConfig({ SUBSTRATE_BRIEF_PROFILE: "OFF" }).mode).toBe("off");
		expect(loadBriefProfileConfig({ SUBSTRATE_BRIEF_PROFILE: "" }).warnings).toEqual([]);
		const junk = loadBriefProfileConfig({ SUBSTRATE_BRIEF_PROFILE: `on${"x".repeat(100)}` });
		expect(junk.mode).toBe("shadow");
		expect(junk.warnings).toHaveLength(1);
		expect(defined(junk.warnings[0]).length).toBeLessThan(260);
	});

	test("the surface list is comma or whitespace separated and closed against SURFACES", () => {
		const config = loadBriefProfileConfig({ SUBSTRATE_BRIEF_PROFILE_SURFACES: "cursor, hermes\tconstructor __proto__ toString" });
		expect([...config.surfaces].sort()).toEqual(["cursor", "hermes"]);
		expect(config.warnings.filter((warning) => warning.includes("not a surface"))).toHaveLength(3);
		const none = loadBriefProfileConfig({ SUBSTRATE_BRIEF_PROFILE_SURFACES: "nope, also-nope" });
		expect([...none.surfaces].sort()).toEqual(["grok-bot", "grok-build"]);
		expect(none.warnings.at(-1)).toContain("default list");
	});

	test("the limits are clamped, never refused: a cap below the floor is raised", () => {
		const config = loadBriefProfileConfig({
			SUBSTRATE_BRIEF_COMPACT_NODES: "0",
			SUBSTRATE_BRIEF_COMPACT_MEMORY_CHARS: "5",
			SUBSTRATE_BRIEF_COMPACT_BYTES: "10",
		});
		expect([config.nodes, config.memoryChars, config.bytes]).toEqual([1, 40, MIN_COMPACT_BYTES]);
		expect(config.warnings).toHaveLength(3);
		const junk = loadBriefProfileConfig({ SUBSTRATE_BRIEF_COMPACT_BYTES: "lots" });
		expect(junk.bytes).toBe(DEFAULT_COMPACT_BYTES);
		expect(junk.warnings).toHaveLength(1);
	});

	test("the entry point prints the profile warnings once", () => {
		const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
		expect(source.match(/briefProfileConfigWarnings\(config\)/g)?.length).toBe(1);
	});
});

describe("profile resolution", () => {
	const of = (env: Record<string, string>) => loadBriefProfileConfig(env);

	test("off and shadow serve full whatever was asked", () => {
		for (const mode of ["off", "shadow"]) {
			const config = of({ SUBSTRATE_BRIEF_PROFILE: mode });
			expect(resolveBriefProfile(config, "grok-bot", undefined)).toBe("full");
			expect(resolveBriefProfile(config, "grok-bot", "compact")).toBe("full");
			expect(resolveBriefProfile(config, "cursor", "compact")).toBe("full");
		}
	});

	test("enforce: the listed surfaces default to compact, an explicit full wins, an explicit compact is honoured anywhere", () => {
		const config = of({ SUBSTRATE_BRIEF_PROFILE: "enforce" });
		expect(resolveBriefProfile(config, "grok-bot", undefined)).toBe("compact");
		expect(resolveBriefProfile(config, "grok-build", undefined)).toBe("compact");
		expect(resolveBriefProfile(config, "cursor", undefined)).toBe("full");
		expect(resolveBriefProfile(config, "grok-bot", "full")).toBe("full");
		expect(resolveBriefProfile(config, "cursor", "compact")).toBe("compact");
		// A surface the REST body invented is not in the list, whatever it is called.
		expect(resolveBriefProfile(config, "constructor", undefined)).toBe("full");
	});

	test("a caller's profile is exactly full or compact; anything else is refused, not coerced", () => {
		expect(parseBriefProfile(undefined)).toEqual({ ok: true, profile: undefined });
		expect(parseBriefProfile(null)).toEqual({ ok: true, profile: undefined });
		expect(parseBriefProfile("full")).toEqual({ ok: true, profile: "full" });
		expect(parseBriefProfile("compact")).toEqual({ ok: true, profile: "compact" });
		for (const bad of ["compat", "", "Full", " full", 1, true, ["full"], {}]) {
			expect(parseBriefProfile(bad).ok).toBe(false);
		}
	});
});

// ── the renderings ───────────────────────────────────────────────────────────

describe("full and compact from one set of reads", () => {
	const sources = { index: countingIndex().index as never, greptime: GREPTIME as never };
	const request = { repo: "acme/app", branch: "main", graph_id: "ut-1", surface: "grok-bot" as const };

	const OLD_TEXT = [
		"## Substrate brief: acme/app @ main — ut-1",
		"active · Agent grok-bot · PR none yet",
		"Nodes: n1 todo · n2 done (hermes)",
		"",
		"Last 1 agent action in this repo",
		`- 09:05 omp${" ".repeat(10)}committed a fix (n1 step 2)`,
		"",
		"Other open graphs here: ut-2 (omp, active)",
		"",
		"Decisions in force",
		"- use pnpm\nnot npm (hermes, human-confirmed, v2)",
		"",
		"Warnings",
		"- fence it (omp, 3h ago)",
	].join("\n");

	test("the full rendering is the text the brief has always been, byte for byte", async () => {
		expect(await composeBrief(request, sources)).toBe(OLD_TEXT);
		const sections = await composeBriefSections(request, sources);
		expect(renderFullBrief(sections)).toBe(OLD_TEXT);
		expect(sections.map((section) => section.id)).toEqual(["heading", "graph", "nodes", "actions", "others", "decisions", "warnings"]);
		for (const section of sections) expect(Object.keys(section)).not.toContain("priority");
	});

	test("the compact rendering: state line first, sections by priority, one physical line each", async () => {
		const sections = await composeBriefSections(request, sources);
		expect(renderCompactBrief(sections, COMPLETE, LIMITS)).toBe(
			[
				COMPLETE,
				"## Substrate brief: acme/app @ main — ut-1",
				"active · Agent grok-bot · PR none yet",
				"Warnings",
				"- fence it (omp, 3h ago)",
				"Decisions in force",
				"- use pnpm not npm (hermes, human-confirmed, v2)",
				"Nodes:",
				"- n1 todo",
				"- n2 done (hermes)",
				"Last 1 agent action in this repo",
				"- 09:05 omp committed a fix (n1 step 2)",
				"Other open graphs here:",
				"- ut-2 (omp, active)",
			].join("\n"),
		);
	});

	test("a title-only notice yields to warnings under the byte cap and is counted when it is omitted", () => {
		const filler = "w".repeat(180);
		const warnings: BriefSection = {
			id: "warnings",
			title: "Warnings",
			lines: [],
			items: [{ text: `first warning stays ${filler}` }, { text: `second warning stays ${filler}` }],
		};
		// Longer than the omitted line, so dropping the notice frees the room the count then uses. The pair of warnings fits in 512; the notice pushes past it.
		const notice: BriefSection = { id: "worktrees", title: `Worktrees: the registry could not be read ${"x".repeat(80)}`, lines: [], items: [] };
		const limits = { nodes: 12, memoryChars: 240, bytes: 512 };
		const alone = renderCompactBrief([warnings], COMPLETE, limits);
		expect(alone).toContain("first warning stays");
		expect(alone).toContain("second warning stays");
		const crowded = renderCompactBrief([warnings, notice], COMPLETE, limits);
		expect(crowded).toContain("first warning stays");
		expect(crowded).toContain("second warning stays");
		expect(crowded).not.toContain("could not be read");
		expect(crowded).toContain("worktrees 1");
	});

	test("the sections survive the cache's encoding, and nothing but that encoding decodes", async () => {
		const sections = await composeBriefSections(request, sources);
		expect(decodeSections(encodeSections(sections))).toEqual(sections);
		expect(parseSections(JSON.parse(encodeSections(sections)).sections)).toEqual(sections);
		// An entry from before profiles is plain Markdown; a foreign value is anything else.
		for (const foreign of [OLD_TEXT, "", "{", "null", "[]", '{"v":2,"sections":[]}', '{"v":1}', '{"v":1,"sections":[{"id":"constructor","lines":[],"items":[]}]}', 42, null, { v: 1 }]) {
			expect(decodeSections(foreign)).toBeNull();
		}
		expect(decodeSections(`{"v":1,"sections":[${"x".repeat(2_000_000)}]}`)).toBeNull();
	});

	test("a tampered cache entry cannot reorder the compact rendering: priority comes from the section id", async () => {
		const sections = await composeBriefSections(request, sources);
		const honest = renderCompactBrief(sections, COMPLETE, LIMITS);
		const raw: { v: number; sections: Array<Record<string, unknown>> } = JSON.parse(encodeSections(sections));
		// Invert every priority, and add one a hostile writer would choose for the heading.
		raw.sections.forEach((section, i) => {
			section.priority = i === 0 ? 99 : -i;
		});
		const decoded = decodeSections(JSON.stringify(raw));
		expect(decoded).not.toBeNull();
		expect(defined(decoded).every((section) => !Object.keys(section).includes("priority"))).toBe(true);
		expect(renderCompactBrief(defined(decoded), COMPLETE, LIMITS)).toBe(honest);
		// And under a tight cap the same lines are dropped as for the honest entry.
		const tight = { ...LIMITS, bytes: MIN_COMPACT_BYTES };
		const crowded = [...defined(decoded), ...defined(decoded).filter((section) => section.id === "decisions")];
		expect(renderCompactBrief(crowded, COMPLETE, tight)).toBe(renderCompactBrief([...sections, ...sections.filter((section) => section.id === "decisions")], COMPLETE, tight));
	});

	test("a memory line is clipped at its text, so the writer, trust and staleness stay readable", async () => {
		const long = "all work stops at the fence ".repeat(80);
		const { index } = countingIndex({ memory: [entry("decision", long, { version: 3, needs_reverification: true })] });
		const sections = await composeBriefSections(request, { index: index as never, greptime: null });
		const text = renderCompactBrief(sections, COMPLETE, LIMITS);
		const line = defined(text.split("\n").find((candidate) => candidate.startsWith("- all work")));
		expect(Array.from(line).length).toBeLessThanOrEqual(240);
		expect(line).toContain("…");
		expect(line.endsWith("(hermes, human-confirmed, v3) — needs reverification")).toBe(true);
	});

	test("nodes: held first, at most the cap, the rest counted in the omitted line", async () => {
		const live = new Date(Date.now() + 600_000).toISOString();
		const nodes = [
			...Array.from({ length: 6 }, (_, i) => node(`done-${i}`, { state: "completed" })),
			...Array.from({ length: 6 }, (_, i) => node(`held-${i}`, { claimed_by: "hermes", claimed_at: new Date().toISOString(), lease_id: `l${i}`, lease_expires_at: live })),
			...Array.from({ length: 4 }, (_, i) => node(`todo-${i}`)),
		];
		const { index } = countingIndex({ nodes, memory: [] });
		const sections = await composeBriefSections(request, { index: index as never, greptime: null });
		const lines = renderCompactBrief(sections, COMPLETE, { ...LIMITS, nodes: 8 }).split("\n");
		const shown = lines.filter((line) => line.startsWith("- held-") || line.startsWith("- todo-") || line.startsWith("- done-"));
		expect(shown.map((line) => line.slice(2).split(" ")[0])).toEqual([...Array.from({ length: 6 }, (_, i) => `held-${i}`), "todo-0", "todo-1"]);
		expect(lines.at(-1)).toBe("...omitted: nodes 8 (profile=compact; request profile=full)");
	});

	test("the state line carries complete, degraded and snapshot, and the vocabulary is not extended", () => {
		expect(briefStateLine("complete", [], null)).toBe("[brief: complete]");
		expect(briefStateLine("degraded", ["memory"], null)).toBe("[brief: degraded; failed: memory]");
		expect(briefStateLine("degraded", ["graph", "memory"], null)).toBe("[brief: degraded; failed: graph, memory]");
		expect(briefStateLine("snapshot", ["graph"], "2026-10-14T09:00:00.000Z")).toBe("[brief: snapshot from 2026-10-14T09:00:00.000Z; failed: graph]");
	});
});

// ── the cap, as a property ───────────────────────────────────────────────────

/** mulberry32: a seeded generator, so a failure names a case that replays. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ALPHABET = ["a", "b", "z", " ", " ", "\n", "é", "日", "🙂", "-", "(", ")"];

function junk(rand: () => number, max: number): string {
	const length = Math.floor(rand() * max);
	let out = "";
	for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
	return out;
}

/** Items carry a unique token first, so which lines survived is readable from the text. */
function token(id: BriefSectionId, index: number): string {
	return `⟦${id}:${index}⟧`;
}

interface Generated {
	sections: BriefSection[];
	counts: Partial<Record<BriefSectionId, number>>;
	ranks: number[];
}

function generate(rand: () => number): Generated {
	const sections: BriefSection[] = [];
	const counts: Partial<Record<BriefSectionId, number>> = {};
	const ranks: number[] = [];
	const add = (id: BriefSectionId, items: BriefItem[], title?: string) => {
		if (items.length === 0) return;
		counts[id] = items.length;
		sections.push({ id, lines: items.map((item) => item.text), ...(title !== undefined ? { title } : {}), items });
	};
	const plain = (id: BriefSectionId, count: number, max: number): BriefItem[] =>
		Array.from({ length: count }, (_, i) => ({ text: `- ${token(id, i)} ${junk(rand, max)}` }));
	const memory = (id: BriefSectionId, count: number): BriefItem[] =>
		Array.from({ length: count }, (_, i) => {
			const body = `${token(id, i)} ${junk(rand, 700)}`;
			return { text: `- ${body} (hermes, human-confirmed)`, clip: [2, 2 + body.length] as const };
		});

	const heading = `## Substrate brief: ${junk(rand, rand() < 0.2 ? 3000 : 60)}`;
	sections.push({ id: "heading", lines: [heading], items: [{ text: heading }] });
	add("graph", plain("graph", 1, 400));
	const nodes = plain("nodes", Math.floor(rand() * 40), 60).map((item) => {
		const rank = Math.floor(rand() * 5);
		ranks.push(rank);
		return { ...item, rank };
	});
	add("nodes", nodes, "Nodes:");
	add("actions", plain("actions", Math.floor(rand() * 7), 300), "Last agent actions");
	add("others", plain("others", Math.floor(rand() * 5), 100), "Other open graphs here:");
	add("decisions", memory("decisions", Math.floor(rand() * 5)), "Decisions in force");
	add("warnings", memory("warnings", Math.floor(rand() * 5)), "Warnings");
	return { sections, counts, ranks };
}

const LABELS: Partial<Record<BriefSectionId, string>> = {
	graph: "status",
	nodes: "nodes",
	actions: "actions",
	others: "graphs",
	decisions: "decisions",
	warnings: "warnings",
};

describe("renderCompactBrief, for random sections", () => {
	test("never exceeds the cap, is deterministic, keeps the highest priorities and counts what it dropped exactly", () => {
		const failures: string[] = [];
		for (let seed = 1; seed <= 300; seed++) {
			const rand = seeded(seed);
			const { sections, counts, ranks } = generate(rand);
			const limits = {
				nodes: 1 + Math.floor(rand() * 30),
				memoryChars: 40 + Math.floor(rand() * 260),
				bytes: MIN_COMPACT_BYTES + Math.floor(rand() * 3500),
			};
			const stateLine = defined([COMPLETE, "[brief: degraded; failed: graph, recent actions, open graphs, memory]"][seed % 2]);
			const check = (ok: boolean, what: string): void => {
				if (!ok) failures.push(`seed ${seed}: ${what}`);
			};

			const text = renderCompactBrief(sections, stateLine, limits);
			check(Buffer.byteLength(text, "utf8") <= limits.bytes, `${Buffer.byteLength(text, "utf8")} bytes over the ${limits.bytes} cap`);
			check(renderCompactBrief(sections, stateLine, limits) === text, "not deterministic");
			check(text.split("\n")[0] === stateLine, "first line is not the state line");
			check(text.split("\n")[1]?.startsWith("## Substrate brief:") === true, "second line is not the heading");

			// Which items survived: tokens lead every line and are never clipped away.
			const present: Partial<Record<BriefSectionId, number[]>> = {};
			for (const id of Object.keys(counts) as BriefSectionId[]) {
				present[id] = Array.from({ length: defined(counts[id]) }, (_, i) => i).filter((i) => text.includes(token(id, i)));
			}

			// Within a section the survivors are a prefix of its compact order.
			const nodeOrder = (counts.nodes ? Array.from({ length: counts.nodes }, (_, i) => i) : []).sort((a, b) => defined(ranks[a]) - defined(ranks[b]) || a - b);
			for (const id of Object.keys(counts) as BriefSectionId[]) {
				const order = id === "nodes" ? nodeOrder : Array.from({ length: defined(counts[id]) }, (_, i) => i);
				const kept = defined(present[id]).length;
				check(
					JSON.stringify([...defined(present[id])].sort((a, b) => a - b)) === JSON.stringify(order.slice(0, kept).sort((a, b) => a - b)),
					`${id} survivors are not a prefix of its order`,
				);
			}

			// The omitted line names exactly what is missing, and only that.
			const last = defined(text.split("\n").at(-1));
			const reported: Record<string, number> = {};
			if (last.startsWith("...omitted: ")) {
				const body = last.slice("...omitted: ".length).replace(" (profile=compact; request profile=full)", "");
				for (const part of body.split(", ")) {
					const [label, count] = part.split(" ");
					reported[defined(label)] = Number(count);
				}
				check(last.endsWith("(profile=compact; request profile=full)"), "omitted line has the wrong ending");
			}
			const expected: Record<string, number> = {};
			for (const id of Object.keys(counts) as BriefSectionId[]) {
				const missing = defined(counts[id]) - defined(present[id]).length;
				if (missing > 0) expected[defined(LABELS[id])] = missing;
			}
			check(JSON.stringify(reported) === JSON.stringify(expected), `omitted ${JSON.stringify(reported)}, expected ${JSON.stringify(expected)}`);

			// Priority: a section that lost a line to the byte cap leaves every lower-priority section empty.
			const byPriority = (Object.keys(counts) as BriefSectionId[]).sort((a, b) => BRIEF_SECTION_PRIORITY[a] - BRIEF_SECTION_PRIORITY[b]);
			for (const id of byPriority) {
				const cappedKeep = id === "nodes" ? Math.min(defined(counts.nodes), limits.nodes) : defined(counts[id]);
				if (defined(present[id]).length < cappedKeep) {
					for (const lower of byPriority) {
						if (BRIEF_SECTION_PRIORITY[lower] > BRIEF_SECTION_PRIORITY[id]) check(defined(present[lower]).length === 0, `${lower} kept a line under a dropped ${id} line`);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	test("a cap below the floor is raised to it, and a heading that cannot fit is cut rather than breaking the cap", () => {
		const heading = `## Substrate brief: ${"日本語".repeat(3000)}`;
		const sections: BriefSection[] = [{ id: "heading", lines: [heading], items: [{ text: heading }] }];
		const huge = { id: "decisions" as const, lines: [], title: "Decisions in force", items: [{ text: `- ${"é".repeat(5000)}` }] };
		for (const bytes of [1, 100, MIN_COMPACT_BYTES]) {
			const text = renderCompactBrief([...sections, huge], "[brief: degraded; failed: graph, recent actions, open graphs, memory]", { ...LIMITS, bytes });
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MIN_COMPACT_BYTES);
			expect(text.split("\n")[0]).toBe("[brief: degraded; failed: graph, recent actions, open graphs, memory]");
		}
	});
});

// ── the service ──────────────────────────────────────────────────────────────

describe("Substrate.briefDetailed under each mode", () => {
	test("off and shadow serve the pre-change text for every surface, with its ETag", async () => {
		for (const surface of SURFACES) {
			const { index } = countingIndex();
			const expected = await composeBrief({ ...REQUEST, surface }, { index: index as never, greptime: null });
			for (const mode of [undefined, "off", "shadow"]) {
				const env: Record<string, string> = mode === undefined ? {} : { SUBSTRATE_BRIEF_PROFILE: mode };
				const detail = await substrateOf(env, index, new FakeRedis()).briefDetailed({ ...REQUEST, surface }, undefined);
				expect(detail.text).toBe(expected);
				expect(detail.profile).toBe("full");
				expect(detail.etag).toBe(briefEtag(expected));
			}
		}
	});

	test("off computes no compact rendering; shadow measures one and still serves full", async () => {
		const { index } = countingIndex();
		const off = await substrateOf({ SUBSTRATE_BRIEF_PROFILE: "off" }, index, new FakeRedis()).briefDetailed({ ...REQUEST, surface: "grok-bot" });
		expect([off.mode, off.bytesSaved]).toEqual(["off", null]);
		const shadow = await substrateOf({}, index, new FakeRedis()).briefDetailed({ ...REQUEST, surface: "grok-bot" }, "compact");
		expect(shadow.mode).toBe("shadow");
		expect(shadow.profile).toBe("full");
		expect(typeof shadow.bytesSaved).toBe("number");
	});

	test("enforce serves compact to grok-bot and grok-build only; the override works both ways; the ETags differ per profile", async () => {
		const { index } = countingIndex();
		const substrate = substrateOf({ SUBSTRATE_BRIEF_PROFILE: "enforce" }, index, new FakeRedis());
		const served = async (surface: (typeof SURFACES)[number], profile?: "full" | "compact") => substrate.briefDetailed({ ...REQUEST, surface }, profile);

		const bot = await served("grok-bot");
		const build = await served("grok-build");
		const cursor = await served("cursor");
		expect([bot.profile, build.profile, cursor.profile]).toEqual(["compact", "compact", "full"]);
		expect(bot.text.split("\n")[0]).toBe(COMPLETE);
		expect(cursor.text).not.toContain("[brief:");
		expect(cursor.text.startsWith("## Substrate brief")).toBe(true);

		const botFull = await served("grok-bot", "full");
		const cursorCompact = await served("cursor", "compact");
		expect([botFull.profile, cursorCompact.profile]).toEqual(["full", "compact"]);
		expect(botFull.text).toBe(cursor.text);
		expect(cursorCompact.text).toBe(bot.text);
		expect(bot.etag).toBe(briefEtag(bot.text));
		expect(botFull.etag).toBe(briefEtag(botFull.text));
		expect(bot.etag).not.toBe(botFull.etag);
	});

	test("SUBSTRATE_BRIEF_PROFILE_SURFACES moves the default", async () => {
		const { index } = countingIndex();
		const substrate = substrateOf({ SUBSTRATE_BRIEF_PROFILE: "enforce", SUBSTRATE_BRIEF_PROFILE_SURFACES: "cursor" }, index, new FakeRedis());
		expect((await substrate.briefDetailed({ ...REQUEST, surface: "cursor" })).profile).toBe("compact");
		expect((await substrate.briefDetailed({ ...REQUEST, surface: "grok-bot" })).profile).toBe("full");
	});

	test("one cache entry serves both modes: a shadow entry is never replayed as full under enforce, nor an enforce one as compact under shadow", async () => {
		const redis = new FakeRedis();
		const first = countingIndex();
		const shadow = substrateOf({}, first.index, redis);
		const written = await shadow.briefDetailed({ ...REQUEST, surface: "grok-bot" });
		expect(written.profile).toBe("full");
		expect(first.calls.getGraph).toBe(1);

		const second = countingIndex();
		const enforcing = substrateOf({ SUBSTRATE_BRIEF_PROFILE: "enforce" }, second.index, redis);
		const replayed = await enforcing.briefDetailed({ ...REQUEST, surface: "grok-bot" });
		expect(second.calls.getGraph).toBe(0);
		expect(replayed.profile).toBe("compact");
		expect(replayed.text.split("\n")[0]).toBe(COMPLETE);

		// And back: the entry an enforcing process wrote is the full text under shadow.
		const third = countingIndex();
		const shadowAgain = await substrateOf({ SUBSTRATE_BRIEF_PROFILE: "shadow" }, third.index, redis).briefDetailed({ ...REQUEST, surface: "grok-bot" });
		expect(third.calls.getGraph).toBe(0);
		expect(shadowAgain.text).toBe(written.text);
		expect(shadowAgain.etag).toBe(written.etag);
	});

	test("an entry from before profiles, a plain string, is a miss: composed afresh, never a throw", async () => {
		const redis = new FakeRedis();
		redis.foreign = JSON.stringify({ v: "## Substrate brief: acme/app\nan old plain-text brief" });
		const { index, calls } = countingIndex();
		const { index: reference } = countingIndex();
		const expected = await composeBrief({ ...REQUEST, surface: "cursor" }, { index: reference as never, greptime: null });
		const detail = await substrateOf({ SUBSTRATE_BRIEF_PROFILE: "enforce" }, index, redis).briefDetailed({ ...REQUEST, surface: "cursor" }, "full");
		expect(calls.getGraph).toBe(1);
		expect(detail.state).toBe("complete");
		expect(detail.text).toBe(expected);
		expect(detail.text).not.toContain("an old plain-text brief");
	});

	test("snapshot: served as compact with its own state line, and as full when the stored snapshot predates sections", async () => {
		const redis = new FakeRedis();
		let down = false;
		const { index } = countingIndex({ failGraph: () => down });
		const substrate = substrateOf({ SUBSTRATE_BRIEF_PROFILE: "enforce" }, index, redis);
		const complete = await substrate.briefDetailed({ ...REQUEST, surface: "grok-bot" }, "full");
		expect(complete.state).toBe("complete");

		down = true;
		await redis.incr(graphGenerationKey("ut-1"));
		const compact = await substrate.briefDetailed({ ...REQUEST, surface: "grok-bot" });
		expect(compact.state).toBe("snapshot");
		expect(compact.profile).toBe("compact");
		expect(compact.text.split("\n")[0]).toMatch(/^\[brief: snapshot from \d{4}-\d\d-\d\dT[\d:.]+Z; failed: graph\]$/);
		const full = await substrate.briefDetailed({ ...REQUEST, surface: "grok-bot" }, "full");
		expect(full.text.split("\n")[0]).toContain("substrate brief snapshot from");
		expect(full.text).toContain(complete.text);

		// A snapshot an older process stored has no sections: there is nothing to build compact from, so full is served.
		const key = snapshotKey("brief-snapshot", "grok-bot", { repo: "acme/app", branch: null, graph_id: "ut-1" });
		const stored = JSON.parse(defined(redis.values.get(key), "stored brief snapshot"));
		delete stored.v.sections;
		redis.values.set(key, JSON.stringify(stored));
		const legacy = await substrate.briefDetailed({ ...REQUEST, surface: "grok-bot" });
		expect(legacy.state).toBe("snapshot");
		expect(legacy.profile).toBe("full");
		expect(legacy.text).toBe(full.text);
	});

	test("a degraded compact brief names the failed sources on its first line; nothing degraded is cached", async () => {
		const redis = new FakeRedis();
		const { index } = countingIndex({ failGraph: () => true });
		const detail = await substrateOf({ SUBSTRATE_BRIEF_PROFILE: "enforce" }, index, redis).briefDetailed({ ...REQUEST, surface: "grok-bot" });
		expect(detail.state).toBe("degraded");
		expect(detail.text.split("\n")[0]).toBe("[brief: degraded; failed: graph]");
		expect([...redis.values.keys()].filter((key) => key.includes(":brief"))).toEqual([]);
	});

	test("brief() is the whole text whatever the wire profile", async () => {
		const { index } = countingIndex();
		const substrate = substrateOf({ SUBSTRATE_BRIEF_PROFILE: "enforce" }, index, new FakeRedis());
		expect((await substrate.brief({ ...REQUEST, surface: "grok-bot" })).startsWith("## Substrate brief")).toBe(true);
	});
});

// ── the metrics ──────────────────────────────────────────────────────────────

describe("brief profile metrics and the estimated spend", () => {
	const BIG = Array.from({ length: 4 }, (_, i) => entry("decision", `decision ${i} ${"words ".repeat(400)}`));

	test("shadow records what compact would have saved and the estimate, for fresh answers only", async () => {
		const { instruments, observer } = observed();
		const { index } = countingIndex({ memory: BIG });
		const substrate = substrateOf({}, index, new FakeRedis(), observer);
		const request = { ...REQUEST, surface: "grok-bot" as const };

		const fresh = await substrate.briefConditional(request, undefined);
		expect(fresh.notModified).toBe(false);
		expect(fresh.detail.profile).toBe("full");
		const saved = counterSum(instruments, METRIC.briefProfileBytesSaved, { surface: "grok-bot" });
		expect(saved).toBe(defined(fresh.detail.bytesSaved, "bytesSaved"));
		expect(saved).toBeGreaterThan(5000);
		const tokens = counterSum(instruments, METRIC.servedTokensEst, { surface: "grok-bot", tool: "brief" });
		expect(tokens).toBe(Math.ceil(Buffer.byteLength(fresh.detail.text, "utf8") / 4));

		const again = await substrate.briefConditional(request, fresh.detail.etag);
		expect(again.notModified).toBe(true);
		expect(counterSum(instruments, METRIC.briefProfileBytesSaved)).toBe(saved);
		expect(counterSum(instruments, METRIC.servedTokensEst)).toBe(tokens);
		expect(counterSum(instruments, METRIC.briefProfile, { surface: "grok-bot", profile: "full", mode: "shadow" })).toBe(2);
		// The model-reported series is never fed from an estimate.
		expect(counterSum(instruments, METRIC.tokens)).toBe(0);
	});

	test("enforce counts the compact answer and its estimate; off records no saving", async () => {
		const { instruments, observer } = observed();
		const { index } = countingIndex({ memory: BIG });
		const enforcing = substrateOf({ SUBSTRATE_BRIEF_PROFILE: "enforce" }, index, new FakeRedis(), observer);
		const answer = await enforcing.briefConditional({ ...REQUEST, surface: "grok-bot" }, undefined);
		expect(answer.detail.profile).toBe("compact");
		expect(Buffer.byteLength(answer.detail.text, "utf8")).toBeLessThanOrEqual(DEFAULT_COMPACT_BYTES);
		expect(counterSum(instruments, METRIC.servedTokensEst, { surface: "grok-bot", tool: "brief" })).toBe(Math.ceil(Buffer.byteLength(answer.detail.text, "utf8") / 4));
		expect(counterSum(instruments, METRIC.briefProfile, { surface: "grok-bot", profile: "compact", mode: "enforce" })).toBe(1);
		expect(counterSum(instruments, METRIC.briefProfileBytesSaved, { surface: "grok-bot" })).toBe(defined(answer.detail.bytesSaved, "bytesSaved"));

		const off = observed();
		await substrateOf({ SUBSTRATE_BRIEF_PROFILE: "off" }, index, new FakeRedis(), off.observer).briefConditional({ ...REQUEST, surface: "grok-bot" }, undefined);
		expect(counterSum(off.instruments, METRIC.briefProfileBytesSaved)).toBe(0);
		expect(counterSum(off.instruments, METRIC.briefProfile, { mode: "off", profile: "full" })).toBe(1);
		expect(counterSum(off.instruments, METRIC.servedTokensEst, { tool: "brief" })).toBeGreaterThan(0);
	});

	test("a surface the body invented is labelled unknown, never echoed", async () => {
		const { instruments, observer } = observed();
		const { index } = countingIndex();
		const substrate = substrateOf({}, index, new FakeRedis(), observer);
		await substrate.briefConditional({ ...REQUEST, surface: "not-a-surface" as never }, undefined);
		expect(counterSum(instruments, METRIC.servedTokensEst, { surface: "unknown", tool: "brief" })).toBeGreaterThan(0);
		expect(counterSum(instruments, METRIC.servedTokensEst, { surface: "not-a-surface" })).toBe(0);
		expect(counterSum(instruments, METRIC.briefProfile, { surface: "unknown" })).toBe(1);
	});

	test("memory_recall and docs_search replies are estimated too, under their own tool label", async () => {
		const { instruments, observer } = observed();
		const substrate = new Substrate(loadConfig({ SUBSTRATE_VM_GUEST: "1" }), { index: null, greptime: null }, observer);
		const recall = await substrate.recallMemories({ query: "lease" }, "grok-bot");
		expect(counterSum(instruments, METRIC.servedTokensEst, { surface: "grok-bot", tool: "recall" })).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(recall), "utf8") / 4));
		const docs = await substrate.searchDocs({ question: "who reads RAGFlow?" }, "grok-bot");
		expect(counterSum(instruments, METRIC.servedTokensEst, { surface: "grok-bot", tool: "docs" })).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(docs), "utf8") / 4));
		expect(counterSum(instruments, METRIC.servedTokensEst, { tool: "brief" })).toBe(0);
	});
});

describe("graph generation keeps the brief entry current", () => {
	test("a graph write moves the entry, so the profile never pins a stale section set", async () => {
		const redis = new FakeRedis();
		const { index, calls } = countingIndex();
		const substrate = substrateOf({ SUBSTRATE_BRIEF_PROFILE: "enforce" }, index, redis);
		await substrate.briefDetailed({ ...REQUEST, surface: "grok-bot" });
		await substrate.briefDetailed({ ...REQUEST, surface: "grok-bot" });
		expect(calls.getGraph).toBe(1);
		await redis.incr(GRAPHS_GENERATION_KEY);
		await substrate.briefDetailed({ ...REQUEST, surface: "grok-bot" });
		expect(calls.getGraph).toBe(2);
	});
});
