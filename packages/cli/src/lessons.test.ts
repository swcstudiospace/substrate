import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Citable,
	citableLesson,
	type LessonsDeps,
	httpMemory,
	lessonBody,
	lessonKey,
	lessonSubject,
	type MemoryApi,
	type OutcomeRecord,
	parseSummary,
	placeOf,
	rankLessons,
	runLessons,
	scoreOf,
	slugify,
} from "./lessons.ts";

interface FakeEntry {
	id: string;
	scope: string;
	kind: string;
	subject: string | null;
	text: string;
	created: string;
}

type Reply = Record<string, unknown>;

/** The plural fold Postgres' english stemmer would make, near enough for these tests. */
function lexemes(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map((word) => word.replace(/s$/, ""));
}

/**
 * A fake substrate, reached over real HTTP.
 *
 * `POST /memory` runs a toy gate with the real one's reply shapes: a bearer token or
 * 401, `person:` scopes denied, a hedge word quarantined, and an explicit key that
 * replays its first write and refuses a different one. `POST /mcp` answers
 * `memory_search` the way the index does — exact scope, every query lexeme present,
 * newest first, a limit — as an SSE frame, as the stateless transport does. With
 * `subject_prefix`, `before` or `before_id` it answers a page, `{ entries, next }`,
 * ordered `created desc, id desc` and cut at the keyset pair. With `legacy` set it is
 * a substrate from before paging: its schema requires `query` and drops arguments it
 * does not know, as the MCP SDK's does.
 */
class FakeSubstrate {
	readonly token = "tok-test";
	entries: FakeEntry[] = [];
	writes: Reply[] = [];
	keys = new Map<string, { asked: string; id: string }>();
	/** Replies to send instead of deciding, for the next writes in order. */
	scripted: Reply[] = [];
	/** Raw HTTP replies for exercising diagnostic boundaries without replacing fetch. */
	rawReplies: Response[] = [];
	/** Every `memory_search` call's arguments, in order. */
	searches: Array<Record<string, unknown>> = [];
	legacy = false;
	clock = Date.parse("2026-10-01T00:00:00Z");
	private counter = 0;
	readonly server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.handle(request) });
	readonly url = `http://127.0.0.1:${this.server.port}`;

	reset(): void {
		this.entries = [];
		this.writes = [];
		this.keys.clear();
		this.scripted = [];
		this.rawReplies = [];
		this.searches = [];
		this.legacy = false;
		this.clock = Date.parse("2026-10-01T00:00:00Z");
	}

	/** An entry put straight into the index, as if written long ago: no gate, no key. */
	plant(subject: string | null, text: string, scope = "repo:acme/widgets"): string {
		const id = `mem_${(++this.counter).toString(16).padStart(32, "0")}`;
		this.entries.push({ id, scope, kind: "fact", subject, text, created: new Date(this.clock).toISOString() });
		this.clock += 60_000;
		return id;
	}

	private async handle(request: Request): Promise<Response> {
		if (request.headers.get("authorization") !== `Bearer ${this.token}`) {
			return Response.json({ error: "unknown or missing bearer token" }, { status: 401 });
		}
		const body = (await request.json()) as Reply;
		const path = new URL(request.url).pathname;
		if (path === "/memory") return this.write(body);
		if (path === "/mcp") return this.search(body);
		return Response.json({ error: "no route" }, { status: 404 });
	}

	private write(request: Reply): Response {
		this.writes.push(request);
		const raw = this.rawReplies.shift();
		if (raw) return raw;
		const scripted = this.scripted.shift();
		if (scripted) return Response.json(scripted, { status: 202 });
		const scope = String(request.scope);
		const text = String(request.text);
		const key = String(request.idempotency_key);
		const base = { verified_persisted: false, idempotency_key: key, writer: "claude-code" };
		if (scope.startsWith("person:")) {
			return Response.json(
				{ ...base, outcome: "denied", reason: "rbac.no-grant", remedy: "No grant lets claude-code write a fact at person scope." },
				{ status: 403 },
			);
		}
		if (/\b(?:probably|might|likely)\b/i.test(text)) {
			return Response.json(
				{
					...base,
					outcome: "quarantined",
					reason: "quarantine.speculative",
					remedy: "State it as a fact.",
					quarantine_id: `memq_${++this.counter}`,
				},
				{ status: 422 },
			);
		}
		const asked = JSON.stringify([scope, request.kind, request.subject, text]);
		const spent = this.keys.get(key);
		if (spent) {
			if (spent.asked !== asked) {
				return Response.json(
					{ ...base, outcome: "conflict", reason: "idempotency.reused", remedy: "Use its own key.", conflict_with: spent.id },
					{ status: 409 },
				);
			}
			const entry = this.entries.find((candidate) => candidate.id === spent.id);
			return Response.json({ ...base, outcome: "accepted", reason: "idempotent.replay", verified_persisted: true, deduplicated: true, entry });
		}
		const entry: FakeEntry = {
			id: `mem_${(++this.counter).toString(16).padStart(32, "0")}`,
			scope,
			kind: String(request.kind),
			subject: typeof request.subject === "string" ? request.subject.toLowerCase() : null,
			text: text.trim(),
			created: new Date(this.clock).toISOString(),
		};
		// A minute apart, so "newest first" is never a tie.
		this.clock += 60_000;
		this.entries.push(entry);
		this.keys.set(key, { asked, id: entry.id });
		return Response.json({ ...base, outcome: "accepted", reason: "accepted", verified_persisted: true, entry });
	}

	private search(body: Reply): Response {
		const params = body.params;
		const given = params && typeof params === "object" && "arguments" in params ? params.arguments : null;
		const args: Record<string, unknown> = given && typeof given === "object" ? { ...given } : {};
		this.searches.push(args);
		const raw = this.rawReplies.shift();
		if (raw) return raw;
		const reply = (value: unknown, isError = false) => {
			const result = { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError } : {}) };
			return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		};
		const paged = !this.legacy && (args.subject_prefix !== undefined || args.before !== undefined || args.before_id !== undefined);
		if (typeof args.query !== "string" && (this.legacy || args.subject_prefix === undefined)) {
			return this.legacy
				? reply("Input validation error: Invalid arguments for tool memory_search: Invalid input: expected string, received undefined at query", true)
				: reply({ error: "memory_search needs `query`, or `subject_prefix` to list a subject family" }, true);
		}
		const wanted = lexemes(typeof args.query === "string" ? args.query : "");
		const prefix = paged && typeof args.subject_prefix === "string" ? args.subject_prefix.toLowerCase() : null;
		const before = paged && typeof args.before === "string" ? args.before : null;
		const beforeId = paged && typeof args.before_id === "string" ? args.before_id : null;
		const limit = Number(args.limit ?? 20);
		const found = this.entries
			.filter((entry) => entry.scope === args.scope)
			.filter((entry) => prefix === null || (entry.subject ?? "\u0000").startsWith(prefix))
			.filter((entry) => before === null || entry.created < before || (beforeId !== null && entry.created === before && entry.id < beforeId))
			.filter((entry) => {
				const words = lexemes(entry.text);
				return wanted.every((word) => words.includes(word));
			})
			.sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id))
			.slice(0, limit);
		if (!paged) return reply(found);
		const last = found.length === limit ? found.at(-1) : undefined;
		return reply({ entries: found, next: last ? { before: last.created, before_id: last.id } : null });
	}
}

const fake = new FakeSubstrate();
const root = mkdtempSync(join(tmpdir(), "lessons-"));
const ARCHIVED = join(".planning", "milestones", "v1.1-phases", "08-memory-structures", "08-01-SUMMARY.md");

mkdirSync(join(root, ".planning", "milestones", "v1.1-phases", "08-memory-structures"), { recursive: true });
writeFileSync(join(root, ".planning", "STATE.md"), '---\nmilestone: v1.2\nstatus: planning\n---\n\n# State\n');

afterAll(() => {
	fake.server.stop(true);
});

beforeEach(() => {
	fake.reset();
});

function harness(overrides: Partial<LessonsDeps> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const deps: LessonsDeps = {
		memory: httpMemory({ url: fake.url, token: fake.token, timeoutMs: 2000 }),
		repo: "acme/widgets",
		root,
		cwd: root,
		now: () => new Date(fake.clock),
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		...overrides,
	};
	return {
		run: (argv: string[]) => runLessons(argv, deps),
		out: () => out.join(""),
		err: () => err.join(""),
	};
}

function summaryWith(lessons: string): string {
	return [
		"---",
		"phase: 08-memory-structures",
		"tags: [memory, governance]",
		"key-decisions:",
		'  - "quarantined and review.required are returned to the caller, never retried."',
		"---",
		"",
		"# Plan 08-01 Summary",
		"",
		"## Lessons",
		"",
		lessons,
		"",
		"## Evidence",
		"- 998 pass / 0 fail.",
		"",
	].join("\n");
}

const TWO_LESSONS = summaryWith(
	[
		"- **Version conflicts carry the standing version**: a stale write gets current_version back. [tags: decisions]",
		"- The swarm client reuses one idempotency key across retries of the same write.",
	].join("\n"),
);

function lessonAt(id: string, created: string, text: string, tags: string[] = []): Citable {
	return {
		id,
		subject: `lesson:v1.1/08-memory-structures/${id}`,
		created,
		milestone: "v1.1",
		phase: "08-memory-structures",
		outcome: "success",
		tags,
		source: null,
		text,
		digest: false,
		rollsUp: [],
		stale: false,
	};
}

function reported(lesson: string, result: OutcomeRecord["result"], phase: string, created: string): OutcomeRecord {
	return { id: `${lesson}-${phase}-${created}`, lesson, result, milestone: "v1.2", phase, created };
}

describe("lesson identity", () => {
	test("the subject is lesson:<milestone>/<phase>/<slug>, from the words that carry meaning", () => {
		const slug = slugify("The ledger refuses UPDATE and DELETE on agent_events");
		expect(lessonSubject("v1.1", "08-memory-structures", slug)).toBe(
			"lesson:v1.1/08-memory-structures/ledger-refuses-update-delete-agent-events",
		);
	});

	test("the subject never passes the gate's 200-character cap, where the server would cut it", () => {
		const subject = lessonSubject("v1.2", "p".repeat(150), "s".repeat(60));
		expect(subject.length).toBeLessThanOrEqual(200);
		expect(subject.startsWith(`lesson:v1.2/${"p".repeat(150)}/s`)).toBe(true);
		expect(() => lessonSubject("v1.2", "p".repeat(190), "slug")).toThrow();
	});

	test("the header carries milestone, phase, outcome, tags and source, and reads back as written", () => {
		const body = lessonBody({
			milestone: "v1.1",
			phase: "08-memory-structures",
			slug: "keys",
			outcome: "partial",
			tags: ["memory", "idempotency"],
			source: ARCHIVED,
			text: "One idempotency key   is reused\nacross retries.",
		});
		const lesson = citableLesson({
			id: "mem_1",
			kind: "fact",
			subject: "lesson:v1.1/08-memory-structures/keys",
			text: body,
			created: "2026-10-07T00:00:00.000Z",
		});
		expect(lesson).toMatchObject({
			milestone: "v1.1",
			phase: "08-memory-structures",
			outcome: "partial",
			tags: ["memory", "idempotency"],
			source: ARCHIVED,
			text: "One idempotency key is reused across retries.",
		});
	});

	test("a lesson: fact written without the header is still a lesson, placed by its subject", () => {
		const lesson = citableLesson({
			id: "mem_2",
			kind: "fact",
			subject: "lesson:v1.1/10-swarm-orchestrate/retro",
			text: "A retro the swarm wrote by hand.",
			created: "2026-10-07T00:00:00.000Z",
		});
		expect(lesson).toMatchObject({ milestone: "v1.1", phase: "10-swarm-orchestrate", text: "A retro the swarm wrote by hand." });
		expect(citableLesson({ id: "mem_3", kind: "warning", subject: "lesson:v1.1/x/y", text: "x", created: "" })).toBeNull();
	});

	test("the key is the scope, the source and the content, so re-wrapping a lesson does not make it a new one", () => {
		const scope = "repo:acme/widgets";
		const key = lessonKey(scope, ARCHIVED, "One key\n  across retries.");
		expect(key).toBe(lessonKey(scope, ARCHIVED, "One key across retries."));
		expect(key).toMatch(/^lesson:[0-9a-f]{64}$/);
		expect(key).not.toBe(lessonKey(scope, "other/SUMMARY.md", "One key across retries."));
		expect(key).not.toBe(lessonKey(scope, ARCHIVED, "Two keys across retries."));
		// The server's keys are global: the same lesson in another scope must not reuse this one.
		expect(key).not.toBe(lessonKey("repo:acme/gadgets", ARCHIVED, "One key across retries."));
	});
});

describe("SUMMARY.md extraction", () => {
	test("one lesson per top-level bullet under ## Lessons, with continuations, tags, outcome and a slug from the bold lead", () => {
		const parsed = parseSummary(
			summaryWith(
				[
					"- **Leases fence on epoch**: a stale holder cannot release",
					"  a lease it lost.",
					"  - Nested detail stays with its lesson.",
					"- Heartbeats run well inside the TTL. [tags: lease, heartbeat] [outcome: partial]",
					"",
					"Unindented prose is not a lesson.",
				].join("\n"),
			),
		);
		expect(parsed.lessons).toEqual([
			{
				text: "Leases fence on epoch: a stale holder cannot release a lease it lost. Nested detail stays with its lesson.",
				slug: "leases-fence-epoch",
				tags: [],
				outcome: undefined,
			},
			{ text: "Heartbeats run well inside the TTL.", slug: undefined, tags: ["lease", "heartbeat"], outcome: "partial" },
		]);
		expect(parsed.tags).toEqual(["memory", "governance"]);
		expect(parsed.phase).toBe("08-memory-structures");
	});

	test("the section ends at the next heading of its level, and a SUMMARY without one has no lessons", () => {
		expect(parseSummary(TWO_LESSONS).lessons.map((lesson) => lesson.text)).not.toContain("998 pass / 0 fail.");
		expect(parseSummary("---\nphase: x\n---\n\n## What shipped\n- a thing\n").lessons).toEqual([]);
	});

	test("frontmatter key-decisions are read as written, and nested key-files items are not mistaken for them", () => {
		const parsed = parseSummary(
			[
				"---",
				"key-files:",
				"  created:",
				"    - agent-swarm: swarm/memory.py",
				"key-decisions:",
				'  - "Kind map decision/retro/pattern -> decision/fact/fact; patterns default to repo scope."',
				"  - 'It''s quoted with single quotes.'",
				"completed: 2026-10-07",
				"---",
				"",
			].join("\n"),
		);
		expect(parsed.keyDecisions.map((lesson) => lesson.text)).toEqual([
			"Kind map decision/retro/pattern -> decision/fact/fact; patterns default to repo scope.",
			"It's quoted with single quotes.",
		]);
	});

	test("an archived phase is placed by the directory it was filed under", () => {
		expect(placeOf(ARCHIVED)).toEqual({ milestone: "v1.1", phase: "08-memory-structures" });
		expect(placeOf(".planning/phases/15-lessons-bank/15-01-SUMMARY.md")).toEqual({
			milestone: undefined,
			phase: "15-lessons-bank",
		});
	});
});

describe("lessons add", () => {
	test("each SUMMARY lesson is one fact at repo scope, and adding them again yields the same entries", async () => {
		writeFileSync(join(root, ARCHIVED), TWO_LESSONS);
		const first = harness();
		expect(await first.run(["add", "--from", ARCHIVED])).toBe(0);
		expect(fake.entries).toHaveLength(2);
		expect(fake.entries[0]).toMatchObject({
			scope: "repo:acme/widgets",
			kind: "fact",
			subject: "lesson:v1.1/08-memory-structures/version-conflicts-carry-standing-version",
		});
		expect(fake.writes[1]?.idempotency_key).toBe(
			lessonKey("repo:acme/widgets", ARCHIVED, "The swarm client reuses one idempotency key across retries of the same write."),
		);
		// The SUMMARY's own tags travel with every lesson in it.
		expect(fake.entries[0]?.text).toContain("tags: decisions, memory, governance");
		for (const entry of fake.entries) expect(first.out()).toContain(`recorded    ${entry.id}`);

		const again = harness();
		expect(await again.run(["add", "--from", ARCHIVED])).toBe(0);
		expect(fake.entries).toHaveLength(2);
		for (const entry of fake.entries) expect(again.out()).toContain(`duplicate   ${entry.id}`);
	});

	test("a hedged lesson is reported as quarantined, sent once, and given no citable id", async () => {
		const cli = harness();
		expect(await cli.run(["add", "--text", "The poller probably needs a backoff.", "--phase", "15-lessons-bank"])).toBe(1);
		expect(fake.writes).toHaveLength(1);
		expect(fake.entries).toHaveLength(0);
		expect(cli.out()).toMatch(/^quarantined memq_\d+/);
		expect(cli.out()).toContain("quarantine.speculative");
	});

	test("a denied lesson is reported with the gate's reason and sent once", async () => {
		const cli = harness();
		const code = await cli.run(["add", "--text", "Leases expire lazily.", "--phase", "15-lessons-bank", "--scope", "person:sam"]);
		expect(code).toBe(1);
		expect(fake.writes).toHaveLength(1);
		expect(cli.out()).toMatch(/^denied {6}- /);
		expect(cli.out()).toContain("rbac.no-grant");
	});

	test("an accepted write that was never read back is re-sent once under the same key and never cited", async () => {
		const unverified = { outcome: "accepted", reason: "accepted.unverified", verified_persisted: false, entry: { id: "mem_ghost" } };
		fake.scripted = [unverified, unverified];
		const cli = harness();
		expect(await cli.run(["add", "--text", "Leases expire lazily.", "--phase", "15-lessons-bank"])).toBe(1);
		expect(fake.writes).toHaveLength(2);
		expect(fake.writes[0]?.idempotency_key).toBe(fake.writes[1]?.idempotency_key);
		expect(cli.out()).toMatch(/^unverified {2}- /);
		expect(cli.out()).not.toContain("mem_ghost");
	});

	test("an unverified write that the replay verifies is recorded", async () => {
		fake.scripted = [{ outcome: "accepted", reason: "accepted.unverified", verified_persisted: false }];
		const cli = harness();
		expect(await cli.run(["add", "--text", "Leases expire lazily.", "--phase", "15-lessons-bank"])).toBe(0);
		expect(fake.writes).toHaveLength(2);
		expect(cli.out()).toContain(`recorded    ${fake.entries[0]?.id}`);
	});

	test("a text lesson takes its milestone from STATE.md and records where it came from", async () => {
		const cli = harness();
		expect(await cli.run(["add", "--text", "Leases expire lazily.", "--phase", "15-lessons-bank", "--tags", "lease"])).toBe(0);
		expect(fake.entries[0]?.subject).toBe("lesson:v1.2/15-lessons-bank/leases-expire-lazily");
		expect(fake.entries[0]?.text).toContain("source: inline:v1.2/15-lessons-bank");
	});

	test("a lesson too long for the gate is refused before anything is sent", async () => {
		const cli = harness();
		expect(await cli.run(["add", "--text", "word ".repeat(1000), "--phase", "15-lessons-bank"])).toBe(1);
		expect(fake.writes).toHaveLength(0);
		expect(cli.out()).toMatch(/^too-long/);
	});

	test("--dry-run shows each lesson for review and sends nothing; --skip leaves one out", async () => {
		writeFileSync(join(root, ARCHIVED), TWO_LESSONS);
		const review = harness();
		expect(await review.run(["add", "--from", ARCHIVED, "--dry-run"])).toBe(0);
		expect(fake.writes).toHaveLength(0);
		expect(review.out()).toContain("lesson:v1.1/08-memory-structures/version-conflicts-carry-standing-version");
		expect(review.out()).toContain("| [lessonbank]");

		const cli = harness();
		expect(await cli.run(["add", "--from", ARCHIVED, "--skip", "version-conflicts-carry-standing-version"])).toBe(0);
		expect(fake.entries.map((entry) => entry.subject)).toEqual([
			"lesson:v1.1/08-memory-structures/swarm-client-reuses-one-idempotency-key",
		]);
	});

	test("a SUMMARY without a lessons section is an error that names --key-decisions, which then reads the frontmatter", async () => {
		writeFileSync(join(root, ARCHIVED), "---\nphase: 08-memory-structures\nkey-decisions:\n  - \"Denials are not retried.\"\n---\n");
		const missing = harness();
		expect(await missing.run(["add", "--from", ARCHIVED])).toBe(1);
		expect(missing.err()).toContain("--key-decisions");

		const cli = harness();
		expect(await cli.run(["add", "--from", ARCHIVED, "--key-decisions"])).toBe(0);
		expect(fake.entries[0]?.subject).toBe("lesson:v1.1/08-memory-structures/denials-retried");
	});
});

describe("score and ranking", () => {
	test("an unreported lesson scores 0.5, and each phase's newest report is the one that counts", () => {
		expect(scoreOf([])).toEqual({ score: 0.5, count: 0 });
		expect(scoreOf([reported("l", "success", "11", "2026-10-02")]).score).toBeCloseTo(2 / 3);
		expect(scoreOf([reported("l", "success", "11", "2026-10-02"), reported("l", "failure", "12", "2026-10-03")])).toEqual({
			score: 0.5,
			count: 2,
		});
		// Phase 11 changed its verdict: the later failure replaces its success rather than adding to it.
		expect(scoreOf([reported("l", "failure", "11", "2026-10-03"), reported("l", "success", "11", "2026-10-02")])).toEqual({
			score: 1 / 3,
			count: 1,
		});
	});

	test.each(["2026-10-03T00:00:00.123Z", "2026-10-03T00:00:00.123456Z"])(
		"scoring preserves server newest-first order when %s ties at millisecond precision",
		(created) => {
			const newest = { ...reported("l", "failure", "11", created), id: "mem_a" };
			const older = { ...reported("l", "success", "11", "2026-10-03T00:00:00.123Z"), id: "mem_z" };
			expect(scoreOf([newest, older])).toEqual({ score: 1 / 3, count: 1 });
		},
	);

	test("a tag match outranks a passing mention, a newer lesson outranks an older one, and a non-match is left out", () => {
		const items = [
			lessonAt("mention", "2026-10-06T00:00:00Z", "The lease table is in Postgres."),
			lessonAt("tagged", "2026-10-06T00:00:00Z", "Renew well inside the TTL.", ["lease"]),
			lessonAt("older", "2026-09-01T00:00:00Z", "Renew well inside the TTL.", ["lease"]),
			lessonAt("unrelated", "2026-10-06T00:00:00Z", "Quarantine is not a refusal."),
		];
		const ranked = rankLessons(items, [], { query: "leases", now: Date.parse("2026-10-07T00:00:00Z"), halfLifeDays: 90, limit: 5 });
		expect(ranked.map((entry) => entry.item.id)).toEqual(["tagged", "older", "mention"]);
		expect(
			rankLessons(items, [], { query: "lease", now: Date.parse("2026-10-07T00:00:00Z"), halfLifeDays: 90, limit: 1 }),
		).toHaveLength(1);
	});

	test("a lesson that keeps failing sinks below an otherwise equal one", () => {
		const items = [
			lessonAt("failing", "2026-10-06T00:00:00Z", "Renew inside the TTL.", ["lease"]),
			lessonAt("working", "2026-10-06T00:00:00Z", "Renew inside the TTL.", ["lease"]),
		];
		const outcomes = [reported("failing", "failure", "11", "2026-10-06"), reported("working", "success", "11", "2026-10-06")];
		const ranked = rankLessons(items, outcomes, { query: "lease", now: Date.parse("2026-10-07T00:00:00Z"), halfLifeDays: 90, limit: 5 });
		expect(ranked.map((entry) => entry.item.id)).toEqual(["working", "failing"]);
	});
});

describe("recall, digest and outcome", () => {
	async function seed(): Promise<{ lease: string; heartbeat: string; quarantine: string; current: string }> {
		const cli = harness();
		const add = (text: string, phase: string, tags: string, milestone = "v1.1") =>
			cli.run(["add", "--text", text, "--milestone", milestone, "--phase", phase, "--tags", tags]);
		expect(await add("Lease takeover waits one TTL after the holder dies.", "11-lease-authority", "lease")).toBe(0);
		expect(await add("Heartbeats stop on a lost or expired refusal.", "11-lease-authority", "lease,heartbeat")).toBe(0);
		expect(await add("Quarantine is not a refusal; the entry is kept.", "08-memory-structures", "memory")).toBe(0);
		expect(await add("Lease renewal keeps the lease id.", "15-lessons-bank", "lease", "v1.2")).toBe(0);
		const [lease, heartbeat, quarantine, current] = fake.entries.map((entry) => entry.id);
		return { lease: lease ?? "", heartbeat: heartbeat ?? "", quarantine: quarantine ?? "", current: current ?? "" };
	}

	test("recall returns a Prior Lessons block citing each matching entry id, best match first", async () => {
		const ids = await seed();
		const cli = harness();
		expect(await cli.run(["recall", "lease", "heartbeat"])).toBe(0);
		const block = cli.out();
		expect(block.startsWith("## Prior Lessons\n")).toBe(true);
		const cited = [...block.matchAll(/^- `(mem_[0-9a-f]+)`/gm)].map((match) => match[1]);
		expect(cited[0]).toBe(ids.heartbeat);
		expect(cited).toContain(ids.lease);
		expect(cited).not.toContain(ids.quarantine);
	});

	test("a digest lists the milestone's lesson ids, deletes nothing, and recall cites it in their place", async () => {
		const ids = await seed();
		const cli = harness();
		expect(await cli.run(["digest", "v1.1"])).toBe(0);
		expect(fake.entries).toHaveLength(5);
		const digestEntry = fake.entries[4];
		expect(digestEntry).toMatchObject({ kind: "fact", subject: "lesson-digest:v1.1", scope: "repo:acme/widgets" });
		expect(digestEntry?.text).toContain(`lessons: ${ids.lease}, ${ids.heartbeat}, ${ids.quarantine}`);

		const recall = harness();
		expect(await recall.run(["recall", "lease"])).toBe(0);
		const cited = [...recall.out().matchAll(/^- `(mem_[0-9a-f]+)`/gm)].map((match) => match[1]);
		expect(cited).toContain(digestEntry?.id);
		expect(cited).toContain(ids.current);
		expect(cited).not.toContain(ids.lease);
		expect(cited).not.toContain(ids.heartbeat);

		// Rolling the same lessons up again is the same digest, not a second one.
		expect(await harness().run(["digest", "v1.1"])).toBe(0);
		expect(fake.entries).toHaveLength(5);
	});

	test.each(["disjoint", "overlapping"])("partial %s digest batches remain citable until a later digest covers each whole batch", async (overlap) => {
		const ids = await seed();
		expect(await harness().run(["digest", "v1.1", "--ids", `${ids.lease},${ids.heartbeat}`])).toBe(0);
		const first = fake.entries.at(-1)?.id ?? "";
		const nextIds = overlap === "overlapping" ? `${ids.heartbeat},${ids.quarantine}` : ids.quarantine;
		expect(await harness().run(["digest", "v1.1", "--ids", nextIds])).toBe(0);
		const second = fake.entries.at(-1)?.id ?? "";

		const recall = harness();
		expect(await recall.run(["recall", "--json"])).toBe(0);
		const cited = (JSON.parse(recall.out()) as Array<{ id: string }>).map((entry) => entry.id);
		expect(cited.sort()).toEqual([first, second, ids.current].sort());
		const topic = harness();
		expect(await topic.run(["recall", "takeover", "--json"])).toBe(0);
		expect((JSON.parse(topic.out()) as Array<{ id: string }>).map((entry) => entry.id)).toEqual([first]);

		expect(await harness().run(["digest", "v1.1"])).toBe(0);
		const covering = fake.entries.at(-1)?.id ?? "";
		const after = harness();
		expect(await after.run(["recall", "--json"])).toBe(0);
		expect((JSON.parse(after.out()) as Array<{ id: string }>).map((entry) => entry.id).sort()).toEqual(
			[covering, ids.current].sort(),
		);
	});

	test("an oversized digest preserves topic recall by refusing until a summary fits beside all ids", async () => {
		const ids = Array.from({ length: 90 }, (_, i) =>
			fake.plant(
				`lesson:v1.1/08-memory-structures/entry-${i}`,
				i === 0 ? "Zircon leases fence stale holders." : `Cache entry ${i} persists across restarts.`,
			),
		);
		const refused = harness();
		expect(await refused.run(["digest", "v1.1"])).toBe(1);
		expect(fake.writes).toHaveLength(0);
		expect(refused.err()).toContain("--text");
		const original = harness();
		expect(await original.run(["recall", "zircon", "--json"])).toBe(0);
		expect((JSON.parse(original.out()) as Array<{ id: string }>).map((entry) => entry.id)).toEqual(ids.slice(0, 1));

		const summary = "Zircon leases fence stale holders; cache entries persist across restarts.";
		expect(await harness().run(["digest", "v1.1", "--text", summary])).toBe(0);
		const digest = fake.entries.at(-1);
		expect(digest?.text).toContain(`lessons: ${ids.join(", ")}`);
		expect(digest?.text).toContain(summary);
		expect(digest?.text.length).toBeLessThanOrEqual(4000);
		const recalled = harness();
		expect(await recalled.run(["recall", "zircon", "--json"])).toBe(0);
		expect((JSON.parse(recalled.out()) as Array<{ id: string }>).map((entry) => entry.id)).toEqual([digest?.id ?? ""]);
	});

	test("unchecked digest ids require summary content and still refuse an oversized id list", async () => {
		const refused = harness();
		expect(await refused.run(["digest", "v1.1", "--ids", "mem_unknown", "--unchecked"])).toBe(1);
		expect(fake.writes).toHaveLength(0);
		expect(refused.err()).toContain("--text");
		expect(
			await harness().run(["digest", "v1.1", "--ids", "mem_unknown", "--unchecked", "--text", "Lease holders are fenced by epoch."]),
		).toBe(0);
		const digest = fake.entries.at(-1)?.id ?? "";
		const recalled = harness();
		expect(await recalled.run(["recall", "epoch", "--json"])).toBe(0);
		expect((JSON.parse(recalled.out()) as Array<{ id: string }>).map((entry) => entry.id)).toEqual([digest]);

		const tooMany = Array.from({ length: 120 }, (_, i) => `mem_${i.toString(16).padStart(32, "0")}`).join(",");
		const over = harness();
		expect(await over.run(["digest", "v1.1", "--ids", tooMany, "--unchecked", "--text", "Lease epochs fence holders."])).toBe(1);
		expect(fake.writes).toHaveLength(1);
		expect(over.err()).toContain("--ids");
	});

	test("returning to an earlier outcome appends a correction while every identical retry stays duplicate", async () => {
		const ids = await seed();
		const lessonBefore = { ...fake.entries[0] };
		const command = (result: string, note = "Takeover held under load.") =>
			["outcome", ids.lease, "--result", result, "--phase", "15-lessons-bank", "--note", note, "--json"];
		const keys: string[] = [];
		const outcomeIds: string[] = [];
		for (const result of ["success", "failure", "success"]) {
			const cli = harness();
			expect(await cli.run(command(result))).toBe(0);
			const report = JSON.parse(cli.out());
			expect(report.status).toBe("recorded");
			expect(report.score_after).toEqual({ score: result === "success" ? 2 / 3 : 1 / 3, count: 1 });
			keys.push(report.key);
			outcomeIds.push(report.id);

			const retry = harness();
			expect(await retry.run(command(result, "Takeover held\n  under load."))).toBe(0);
			expect(JSON.parse(retry.out())).toMatchObject({ status: "duplicate", id: report.id, key: report.key });
		}
		expect(new Set(keys).size).toBe(3);
		expect(fake.entries.filter((entry) => entry.subject === `lesson-outcome:${ids.lease}`).map((entry) => entry.id)).toEqual(outcomeIds);
		expect(fake.entries[0]).toEqual(lessonBefore as FakeEntry);
		const recall = harness();
		expect(await recall.run(["recall", "lease", "--json"])).toBe(0);
		expect((JSON.parse(recall.out()) as Array<{ id: string }>).find((entry) => entry.id === ids.lease)).toMatchObject({
			score: 2 / 3,
			outcomes: 1,
		});
	});

	test("note-only corrections get new keys, independent of reports by other phases or scopes", async () => {
		const ids = await seed();
		const command = (note: string, scope = "repo:acme/widgets", phase = "15-lessons-bank") =>
			["outcome", ids.lease, "--result", "success", "--phase", phase, "--note", note, "--scope", scope, "--unchecked", "--json"];
		const first = harness();
		expect(await first.run(command("Takeover held."))).toBe(0);
		const original = JSON.parse(first.out());
		const otherPhase = harness();
		expect(await otherPhase.run(command("Other phase held.", "repo:acme/widgets", "16-next-phase"))).toBe(0);
		const retry = harness();
		expect(await retry.run(command("Takeover held."))).toBe(0);
		expect(JSON.parse(retry.out())).toMatchObject({ status: "duplicate", id: original.id, key: original.key });

		const corrected = harness();
		expect(await corrected.run(command("Takeover held under load."))).toBe(0);
		const correction = JSON.parse(corrected.out());
		expect(correction).toMatchObject({ status: "recorded", score_after: { score: 3 / 4, count: 2 } });
		expect(correction.key).not.toBe(original.key);
		const restored = harness();
		expect(await restored.run(command("Takeover held."))).toBe(0);
		const restoration = JSON.parse(restored.out());
		expect(restoration.status).toBe("recorded");
		expect(restoration.key).not.toBe(original.key);
		expect(restoration.key).not.toBe(correction.key);

		const otherScope = harness();
		expect(await otherScope.run(command("Takeover held.", "repo:acme/gadgets"))).toBe(0);
		const scoped = JSON.parse(otherScope.out());
		expect(scoped).toMatchObject({ status: "recorded", score_after: { score: 2 / 3, count: 1 } });
		expect(scoped.key).not.toBe(original.key);
		const scopeRetry = harness();
		expect(await scopeRetry.run(command("Takeover held.", "repo:acme/gadgets"))).toBe(0);
		expect(JSON.parse(scopeRetry.out())).toMatchObject({ status: "duplicate", id: scoped.id, key: scoped.key });
	});

	test("an outcome correction reuses its key for the governed unverified-write retry", async () => {
		const ids = await seed();
		const command = ["outcome", ids.lease, "--phase", "15-lessons-bank", "--note", "Takeover held."];
		expect(await harness().run([...command, "--result", "success"])).toBe(0);
		expect(await harness().run([...command, "--result", "failure"])).toBe(0);
		const before = fake.writes.length;
		fake.scripted = [{ outcome: "accepted", reason: "accepted.unverified", verified_persisted: false }];
		const corrected = harness();
		expect(await corrected.run([...command, "--result", "success", "--json"])).toBe(0);
		const report = JSON.parse(corrected.out());
		expect(report).toMatchObject({ status: "recorded", score_after: { score: 2 / 3, count: 1 } });
		expect(fake.writes.slice(before).map((write) => write.idempotency_key)).toEqual([report.key, report.key]);
		const retry = harness();
		expect(await retry.run([...command, "--result", "success", "--json"])).toBe(0);
		expect(JSON.parse(retry.out())).toMatchObject({ status: "duplicate", id: report.id, key: report.key });
	});

	test("outcomes accept exactly 4000 body characters and refuse 4001 before writing", async () => {
		const ids = await seed();
		const command = ["outcome", ids.lease, "--result", "success", "--phase", "15-lessons-bank"];
		const preview = harness();
		expect(await preview.run([...command, "--note", "x", "--dry-run", "--json"])).toBe(0);
		const [planned] = JSON.parse(preview.out()) as Array<{ body: string }>;
		if (!planned) throw new Error("outcome dry-run did not return a planned write");
		const note = "x".repeat(4000 - planned.body.length + 1);
		const before = fake.writes.length;
		const refused = harness();
		expect(await refused.run([...command, "--note", `${note}x`])).toBe(1);
		expect(refused.err()).toContain("4001");
		expect(fake.writes).toHaveLength(before);
		const dry = harness();
		expect(await dry.run([...command, "--note", `${note}x`, "--dry-run"])).toBe(1);
		expect(fake.writes).toHaveLength(before);

		const accepted = harness();
		expect(await accepted.run([...command, "--note", note, "--json"])).toBe(0);
		expect(JSON.parse(accepted.out()).status).toBe("recorded");
		expect(fake.entries.at(-1)?.text.length).toBe(4000);
	});

	test("an outcome appends a fact naming the lesson and moves its score, and the lesson is untouched", async () => {
		const ids = await seed();
		const lessonBefore = { ...fake.entries[0] };
		const cli = harness();
		expect(await cli.run(["outcome", ids.lease, "--result", "success", "--phase", "15-lessons-bank"])).toBe(0);
		expect(cli.out()).toContain(`score of ${ids.lease}: 0.50 (0 outcomes) -> 0.67 (1 outcome)`);
		const appended = fake.entries.at(-1);
		expect(appended).toMatchObject({ kind: "fact", subject: `lesson-outcome:${ids.lease}`, scope: "repo:acme/widgets" });
		expect(fake.entries[0]).toEqual(lessonBefore as FakeEntry);

		const recall = harness();
		expect(await recall.run(["recall", "lease", "--json"])).toBe(0);
		const ranked = JSON.parse(recall.out()) as Array<{ id: string; score: number; outcomes: number }>;
		expect(ranked.find((entry) => entry.id === ids.lease)).toMatchObject({ outcomes: 1 });
		expect(ranked.find((entry) => entry.id === ids.lease)?.score).toBeCloseTo(2 / 3);
	});

	test("an outcome for an id that is not in the bank is refused before anything is written", async () => {
		await seed();
		const writes = fake.writes.length;
		const cli = harness();
		expect(await cli.run(["outcome", "mem_typo", "--result", "success", "--phase", "15-lessons-bank"])).toBe(1);
		expect(fake.writes).toHaveLength(writes);
		expect(cli.err()).toContain("mem_typo");
	});

	test("recall fails open: an unreachable bank prints nothing and exits 0", async () => {
		const cli = harness({ memory: httpMemory({ url: "http://127.0.0.1:1", token: fake.token, timeoutMs: 500 }) });
		expect(await cli.run(["recall", "lease"])).toBe(0);
		expect(cli.out()).toBe("");
		expect(cli.err()).toContain("nothing recalled");
	});

	test("a search the server refuses is not mistaken for an empty bank", async () => {
		const cli = harness({ memory: httpMemory({ url: fake.url, token: "wrong", timeoutMs: 2000 }) });
		expect(await cli.run(["recall", "lease"])).toBe(0);
		expect(cli.out()).toBe("");
		expect(cli.err()).toContain("HTTP 401");
	});
});

describe("lesson transport diagnostics", () => {
	test("an unreachable credentialed URL never exposes its userinfo, query or fragment", async () => {
		const cli = harness({
			memory: httpMemory({
				url: "http://canary-user:canary%2Dpassword@127.0.0.1:1/?access_token=canary-query#canary-fragment",
				token: "canary-bearer",
				timeoutMs: 500,
			}),
		});
		expect(await cli.run(["recall", "lease"])).toBe(0);
		expect(cli.out()).toBe("");
		expect(cli.err()).toContain("127.0.0.1:1");
		expect(cli.err()).toContain("did not answer");
		for (const secret of ["canary-user", "canary%2Dpassword", "canary-password", "canary-query", "canary-fragment", "canary-bearer"]) {
			expect(cli.err()).not.toContain(secret);
		}
	});

	test.each(["non-JSON", "HTTP error", "JSON-RPC error", "tool error", "invalid result"])(
		"%s search diagnostics redact credential echoes and retain the HTTP status",
		async (shape) => {
			const reason = `denied ${fake.token} canary-query Bearer remote-canary-token http://remote-user:remote-pass@example.test/route?token=remote-query`;
			const status = shape === "tool error" || shape === "invalid result" ? 200 : 403;
			const payload = shape === "HTTP error"
				? { error: reason }
				: shape === "JSON-RPC error"
					? { error: { code: -32000, message: reason } }
					: { result: { isError: shape === "tool error", content: [{ type: "text", text: reason }] } };
			fake.rawReplies = [shape === "non-JSON" ? new Response(reason, { status }) : Response.json(payload, { status })];
			// Existing URL construction still sends to /mcp with its query intact.
			const memory = httpMemory({ url: `${fake.url}/mcp?access_token=canary-query`, token: fake.token, timeoutMs: 2000 });
			const failure = await memory.page({ scope: "repo:acme/widgets", subject_prefix: "lesson:", limit: 100 }).catch((cause: unknown) => cause);
			if (!(failure instanceof Error)) throw new Error("memory_search accepted a refused or malformed reply");
			expect(failure.message).toContain(`HTTP ${status}`);
			expect(failure.message).toContain(shape === "invalid result" ? "invalid result" : "denied");
			for (const secret of [fake.token, "canary-query", "remote-canary-token", "remote-user", "remote-pass", "remote-query"]) {
				expect(failure.message).not.toContain(secret);
			}
		},
	);

	test("non-JSON write refusals redact before truncating and preserve the request and HTTP status", async () => {
		const remoteToken = "z".repeat(64);
		fake.rawReplies = [new Response(`denied ${fake.token} ${".".repeat(155)} Bearer ${remoteToken}`, { status: 503 })];
		const cli = harness();
		expect(await cli.run(["add", "--text", "Lease epochs fence stale holders.", "--phase", "15-lessons-bank", "--json"])).toBe(1);
		const [report] = JSON.parse(cli.out()) as Array<{ status: string; reason: string }>;
		expect(report).toMatchObject({ status: "refused" });
		expect(report?.reason).toContain("HTTP 503");
		expect(report?.reason).toContain("denied");
		expect(cli.out()).not.toContain(fake.token);
		expect(cli.out()).not.toContain("zzzz");
		expect(fake.writes).toHaveLength(1);
		expect(fake.writes[0]).toMatchObject({ kind: "fact", subject: "lesson:v1.2/15-lessons-bank/lease-epochs-fence-stale-holders" });
		expect(fake.writes[0]?.text).toContain("Lease epochs fence stale holders.");
	});

	test("governed refusal reason and remedy are scrubbed without changing the denial", async () => {
		fake.scripted = [{
			outcome: "denied",
			reason: `rbac.no-grant ${fake.token}`,
			remedy: "Contact http://remote-user:remote-pass@example.test/help?token=remote-query with Bearer remote-canary-token",
		}];
		const cli = harness();
		expect(await cli.run(["add", "--text", "Lease epochs fence stale holders.", "--phase", "15-lessons-bank", "--json"])).toBe(1);
		const [report] = JSON.parse(cli.out()) as Array<{ status: string; reason: string; remedy: string; id: string | null }>;
		expect(report).toMatchObject({ status: "denied", id: null });
		expect(report?.reason).toContain("rbac.no-grant");
		expect(report?.remedy).toContain("example.test/help");
		for (const secret of [fake.token, "remote-user", "remote-pass", "remote-query", "remote-canary-token"]) {
			expect(cli.out()).not.toContain(secret);
		}
		expect(fake.entries).toHaveLength(0);
	});

	test("successful recall keeps lesson URL content untouched by diagnostic redaction", async () => {
		const text = "Lease documentation lives at https://example.test/guide?topic=lease#renewal.";
		const id = fake.plant("lesson:v1.2/15-lessons-bank/documentation", text);
		const cli = harness();
		expect(await cli.run(["recall", "lease", "--json"])).toBe(0);
		expect(JSON.parse(cli.out())).toMatchObject([{ id, text }]);
		expect(cli.err()).toBe("");
	});
});

describe("reading every lesson in scope", () => {
	const SCOPE = "repo:acme/widgets";

	/** A lesson planted straight into the index, with the header `add` writes. */
	function plantLesson(milestone: string, phase: string, slug: string, text: string, tags: string[] = []): string {
		const body = lessonBody({ milestone, phase, slug, outcome: "success", tags, source: `inline:${milestone}/${phase}`, text });
		return fake.plant(lessonSubject(milestone, phase, slug), body);
	}

	/**
	 * 130 lessons, oldest first: the five oldest about lease takeover, the rest about
	 * something else. Then 150 newer facts that are not lessons at all, so by age the
	 * five relevant lessons sit behind 275 newer entries in the scope.
	 */
	function bury(): string[] {
		const relevant = Array.from({ length: 5 }, (_, i) =>
			plantLesson("v1.1", "11-lease-authority", `takeover-${i}`, `Lease takeover waits one TTL, case ${i}.`, ["lease"]),
		);
		for (let i = 0; i < 125; i++) plantLesson("v1.2", "13-workspace", `cache-${i}`, `The build cache is warm after install ${i}.`);
		for (let i = 0; i < 150; i++) fake.plant(`note:build-${i}`, `The nightly build ${i} passed.`);
		return relevant;
	}

	const lessonPages = () => fake.searches.filter((args) => args.subject_prefix === "lesson:");

	test("recall pages through all 130 lessons, so the oldest relevant ones are all considered", async () => {
		const relevant = bury();
		const cli = harness();
		expect(await cli.run(["recall", "lease", "takeover", "--limit", "20", "--json"])).toBe(0);
		const cited = (JSON.parse(cli.out()) as Array<{ id: string }>).map((entry) => entry.id);
		expect(cited.sort()).toEqual([...relevant].sort());
		expect(cli.err()).toBe("");
		// 100 and then 30: the cursor ran to the end, and no query was sent with it.
		expect(lessonPages()).toHaveLength(2);
		expect(lessonPages().every((args) => args.query === undefined)).toBe(true);
		expect(lessonPages()[1]).toMatchObject({ before: expect.any(String), before_id: expect.any(String) });
		// Digests and outcomes are read by their own prefixes too.
		const prefixes = new Set(fake.searches.map((args) => args.subject_prefix));
		expect(prefixes).toEqual(new Set(["lesson:", "lesson-digest:", "lesson-outcome:"]));
	});

	test("recall finds an old relevant lesson that the newest-100 window would have missed", async () => {
		const [oldest] = bury();
		// What one search for every lesson used to see: the newest 100, and not this one.
		const window = await httpMemory({ url: fake.url, token: fake.token, timeoutMs: 2000 }).search("lessonbank", SCOPE, 100);
		expect(window).toHaveLength(100);
		expect(window.map((entry) => entry.id)).not.toContain(oldest);

		const cli = harness();
		expect(await cli.run(["recall", "lease", "takeover", "case", "0"])).toBe(0);
		expect(cli.out()).toContain(`\`${oldest}\``);
	});

	test("an outcome on a lesson older than the newest 100 is accepted, and every prior outcome is scored", async () => {
		const [oldest = ""] = bury();
		for (let i = 0; i < 105; i++) {
			fake.plant(
				`lesson-outcome:${oldest}`,
				[`[lessonbankoutcome]`, `lesson: ${oldest}`, "result: success", "milestone: v1.2", `phase: p-${i}`].join("\n"),
			);
		}
		const cli = harness();
		expect(await cli.run(["outcome", oldest, "--result", "success", "--phase", "15-lessons-bank"])).toBe(0);
		// (1 + 105) / (2 + 105) before, (1 + 106) / (2 + 106) after.
		expect(cli.out()).toContain(`score of ${oldest}: 0.99 (105 outcomes) -> 0.99 (106 outcomes)`);
		expect(fake.searches.filter((args) => args.subject_prefix === `lesson-outcome:${oldest}`).length).toBeGreaterThanOrEqual(4);
	});

	test("a digest rolls up a milestone's lessons however far back they are", async () => {
		const relevant = bury();
		const cli = harness();
		expect(await cli.run(["digest", "v1.1"])).toBe(0);
		const digestEntry = fake.entries.at(-1);
		expect(digestEntry?.subject).toBe("lesson-digest:v1.1");
		expect(digestEntry?.text).toContain(`lessons: ${relevant.join(", ")}`);
	});

	test("against a substrate that rejects subject_prefix, recall falls back to the old search and says so once", async () => {
		fake.legacy = true;
		const seeded = harness();
		expect(
			await seeded.run(["add", "--text", "Lease takeover waits one TTL.", "--milestone", "v1.1", "--phase", "11-lease-authority", "--tags", "lease"]),
		).toBe(0);
		const lease = fake.entries[0]?.id;

		const cli = harness();
		expect(await cli.run(["recall", "lease"])).toBe(0);
		expect(cli.out()).toContain(`\`${lease}\``);
		const warning = cli.err().trim().split("\n");
		expect(warning).toHaveLength(1);
		expect(warning[0]).toContain("cannot list by subject");
		// Each family asked once with the prefix, then the marker searches.
		expect(fake.searches.some((args) => args.query === "lessonbank lease")).toBe(true);

		// The outcome command reads three times and still warns once.
		const outcome = harness();
		expect(await outcome.run(["outcome", lease ?? "", "--result", "success", "--phase", "15-lessons-bank"])).toBe(0);
		expect(outcome.err().trim().split("\n")).toHaveLength(1);
		expect(outcome.out()).toContain(`score of ${lease}: 0.50 (0 outcomes) -> 0.67 (1 outcome)`);
	});

	test("a cursor that never ends stops at the page cap, and says so", async () => {
		const pages = new Map<string, number>();
		const endless: MemoryApi = {
			write: async () => ({ error: "not used" }),
			search: async () => [],
			page: async (request) => {
				const n = (pages.get(request.subject_prefix) ?? 0) + 1;
				pages.set(request.subject_prefix, n);
				const created = new Date(Date.parse("2026-10-01T00:00:00Z") - n * 60_000).toISOString();
				const entry = {
					id: `mem_${request.subject_prefix}${n}`,
					kind: "fact",
					subject: `${request.subject_prefix}v1.2/15/${n}`,
					text: `lease ${n}`,
					created,
				};
				return { entries: [entry], next: { before: created, before_id: entry.id } };
			},
		};
		const cli = harness({ memory: endless });
		expect(await cli.run(["recall", "lease"])).toBe(0);
		expect(pages.get("lesson:")).toBe(50);
		expect(cli.err()).toContain("stopped reading lesson: entries in repo:acme/widgets after 50 pages");
		expect(cli.out()).toContain("## Prior Lessons");
	});
});
