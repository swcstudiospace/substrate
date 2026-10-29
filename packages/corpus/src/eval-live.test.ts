import { describe, expect, test } from "bun:test";
import { scoreRun, type GoldenQuery } from "./eval.ts";
import {
	documentKeyOfUrl,
	LIVE_MAX_CONSECUTIVE_FAILURES,
	LIVE_RUN_DEADLINE_MS,
	ranksFromSearchReply,
	runLiveQueries,
	unsafeSkippedLine,
	type LiveOptions,
} from "./eval-live.ts";
import { sourceUrl } from "./protocol.ts";
import { defined } from "./test-support.ts";

const A = "https://github.com/acme/atlas/blob/HEAD/docs/a.md";
const B = "https://github.com/acme/atlas/blob/0123abc/docs/b.md";

function question(i: number): GoldenQuery {
	return { query: `question number ${i}`, expected: "acme/atlas:docs/a.md", kind: "title" };
}

describe("documentKeyOfUrl", () => {
	test("reads the key a citation names, for a GitHub blob at any ref and for a local corpus URL", () => {
		expect(documentKeyOfUrl(A)).toBe("acme/atlas:docs/a.md");
		expect(documentKeyOfUrl(B)).toBe("acme/atlas:docs/b.md");
		expect(documentKeyOfUrl("corpus://local/notes/x/y.md")).toBe("local/notes:x/y.md");
	});

	test("is the inverse of sourceUrl, spaces and all", () => {
		expect(documentKeyOfUrl(sourceUrl("acme/atlas", "docs/a b.md", "abc123"))).toBe("acme/atlas:docs/a b.md");
		expect(documentKeyOfUrl(sourceUrl("local/notes", "deep/dir/n o.md"))).toBe("local/notes:deep/dir/n o.md");
	});

	test("a URL that is not a corpus document's, or has a broken escape, names nothing", () => {
		expect(documentKeyOfUrl("https://example.com/docs/a.md")).toBeNull();
		expect(documentKeyOfUrl("https://github.com/acme/atlas/blob/HEAD/%E0%A4%A")).toBeNull();
		expect(documentKeyOfUrl("")).toBeNull();
	});
});

describe("ranksFromSearchReply", () => {
	test("keeps the first appearance of each corpus document in rank order and a null slot for every result that names none", () => {
		const reply = ranksFromSearchReply({
			chunks: [{ source_url: A }, { source_url: "https://github.com/acme/atlas/blob/other/docs/a.md" }, { source_url: B }, { source_url: "https://example.com/x" }, { title: "no url" }, 3],
		});
		expect(reply).toEqual({ kind: "ranked", keys: ["acme/atlas:docs/a.md", "acme/atlas:docs/b.md", null, null, null] });
	});

	test("an expected document in sixth place behind five non-corpus results misses at 5 and hits at 10", async () => {
		const others = [1, 2, 3, 4, 5].map((n) => ({ source_url: `https://example.com/memory/${n}` }));
		const fetchImpl: LiveOptions["fetchImpl"] = async () => Response.json({ chunks: [...others, { source_url: A }] });
		const run = await runLiveQueries([question(1)], { base: "http://127.0.0.1:7410", token: "t", fetchImpl, now: () => 0 });
		const score = scoreRun(run.results);
		expect(score.recall5).toBe(0);
		expect(score.recall10).toBe(1);
	});

	test("a degraded answer is an outage, and a body that is not an answer is invalid", () => {
		expect(ranksFromSearchReply({ chunks: [], degraded: true, reason: "breaker" })).toEqual({ kind: "degraded" });
		expect(ranksFromSearchReply({ answer: "x" })).toEqual({ kind: "invalid" });
		expect(ranksFromSearchReply(null)).toEqual({ kind: "invalid" });
		expect(ranksFromSearchReply([])).toEqual({ kind: "invalid" });
	});
});

/** A guard that flags nothing; the guard is a required option, so every run passes one. */
const safe = (): boolean => false;

describe("runLiveQueries", () => {
	function options(fetchImpl: LiveOptions["fetchImpl"], clock: { t: number }, unsafe: LiveOptions["unsafe"] = safe): LiveOptions {
		return { base: "http://127.0.0.1:7410/", token: "test-bearer", fetchImpl, now: () => clock.t, unsafe };
	}

	test("asks POST /docs/search once per question as the bearer, with the corpus dataset, and records rank and latency", async () => {
		const clock = { t: 0 };
		const seen: Array<{ url: string; method: string | undefined; authorization: string | null; body: unknown }> = [];
		const fetchImpl: LiveOptions["fetchImpl"] = async (url, init) => {
			clock.t += 7;
			seen.push({
				url,
				method: init?.method,
				authorization: new Headers(init?.headers).get("authorization"),
				body: JSON.parse(String(init?.body)),
			});
			return Response.json({ chunks: [{ source_url: B }, { source_url: A }] });
		};
		const run = await runLiveQueries([question(1), question(2)], options(fetchImpl, clock));
		expect(run).toEqual({
			results: [
				{ query: "question number 1", expected: "acme/atlas:docs/a.md", ranked: ["acme/atlas:docs/b.md", "acme/atlas:docs/a.md"], latencyMs: 7 },
				{ query: "question number 2", expected: "acme/atlas:docs/a.md", ranked: ["acme/atlas:docs/b.md", "acme/atlas:docs/a.md"], latencyMs: 7 },
			],
			failed: 0,
			degraded: 0,
			aborted: null,
			skippedUnsafe: 0,
		});
		expect(seen).toHaveLength(2);
		expect(defined(seen[0]).url).toBe("http://127.0.0.1:7410/docs/search");
		expect(defined(seen[0]).method).toBe("POST");
		expect(defined(seen[0]).authorization).toBe("Bearer test-bearer");
		expect(defined(seen[0]).body).toEqual({ question: "question number 1", datasets: ["corpus"], session_id: "docs-eval:0" });
		expect(JSON.stringify(run)).not.toContain("test-bearer");
	});

	test("one question that fails, throws or comes back degraded is counted and does not stop the others", async () => {
		const clock = { t: 0 };
		const answers = [
			() => Response.json({ chunks: [{ source_url: A }] }),
			() => new Response("boom", { status: 500 }),
			() => Response.json({ chunks: [], degraded: true }),
			() => {
				throw new Error("socket closed");
			},
			() => Response.json({ chunks: [{ source_url: A }] }),
		];
		let call = 0;
		const run = await runLiveQueries(
			[1, 2, 3, 4, 5].map(question),
			options(async () => defined(answers[call++])(), clock),
		);
		expect(run.results.map((result) => result.query)).toEqual(["question number 1", "question number 5"]);
		expect(run.failed).toBe(2);
		expect(run.degraded).toBe(1);
		expect(run.aborted).toBeNull();
	});

	test("a run whose every request is refused stops after a few instead of asking every question", async () => {
		let calls = 0;
		const run = await runLiveQueries(
			Array.from({ length: 20 }, (_, i) => question(i)),
			options(async () => {
				calls += 1;
				return new Response("no", { status: 401 });
			}, { t: 0 }),
		);
		expect(calls).toBe(LIVE_MAX_CONSECUTIVE_FAILURES);
		expect(run.aborted).toBe("consecutive-failures");
		expect(run.failed).toBe(LIVE_MAX_CONSECUTIVE_FAILURES);
		expect(run.results).toEqual([]);
	});

	test("an answer in between resets the count, so scattered failures never abort the run", async () => {
		let call = 0;
		const pattern = Array.from({ length: 10 }, (_, i) => i % 5 === 4);
		const run = await runLiveQueries(
			pattern.map((_, i) => question(i)),
			options(async () => (pattern[call++] === true ? Response.json({ chunks: [{ source_url: A }] }) : new Response("no", { status: 503 })), { t: 0 }),
		);
		expect(run.aborted).toBeNull();
		expect(run.failed).toBe(8);
		expect(run.results).toHaveLength(2);
	});

	test("the whole run has a deadline", async () => {
		const clock = { t: 0 };
		const run = await runLiveQueries(
			[1, 2, 3].map(question),
			options(async () => {
				clock.t += LIVE_RUN_DEADLINE_MS * 0.4;
				return Response.json({ chunks: [{ source_url: A }] });
			}, clock),
		);
		expect(run.results).toHaveLength(3);
		const slow = { t: 0 };
		const stopped = await runLiveQueries(
			[1, 2, 3, 4].map(question),
			options(async () => {
				slow.t += LIVE_RUN_DEADLINE_MS * 0.6;
				return Response.json({ chunks: [{ source_url: A }] });
			}, slow),
		);
		expect(stopped.results).toHaveLength(2);
		expect(stopped.aborted).toBe("deadline");
	});

	describe("a question the guard flags", () => {
		const flagged = (text: string): boolean => text.includes("flagged");
		const asked = (clock: { t: number }, bodies: string[]): LiveOptions["fetchImpl"] => async (_url, init) => {
			clock.t += 1;
			bodies.push(String(init?.body));
			return Response.json({ chunks: [{ source_url: A }] });
		};

		test("is never sent, is counted, and is neither failed nor scored; the others are asked", async () => {
			const clock = { t: 0 };
			const bodies: string[] = [];
			const queries: GoldenQuery[] = [question(1), { ...question(2), query: "a flagged question" }, question(3)];
			const run = await runLiveQueries(queries, options(asked(clock, bodies), clock, flagged));
			expect(run.skippedUnsafe).toBe(1);
			expect(run.failed).toBe(0);
			expect(run.aborted).toBeNull();
			expect(run.results.map((result) => result.query)).toEqual(["question number 1", "question number 3"]);
			expect(bodies).toHaveLength(2);
			expect(bodies.join("")).not.toContain("flagged");
			// The flagged question's text is not kept anywhere in what the run returns.
			expect(JSON.stringify(run)).not.toContain("flagged");
			// A question keeps its position in the session id whether or not its neighbours were sent.
			expect(JSON.parse(defined(bodies[1]))).toMatchObject({ session_id: "docs-eval:2" });
		});

		test("does not count towards the consecutive failures that stop a run", async () => {
			const clock = { t: 0 };
			const bodies: string[] = [];
			const flaggedQuestions = Array.from({ length: LIVE_MAX_CONSECUTIVE_FAILURES + 2 }, (_, i): GoldenQuery => ({ ...question(i), query: `flagged ${i}` }));
			const run = await runLiveQueries([...flaggedQuestions, question(1)], options(asked(clock, bodies), clock, flagged));
			expect(run.skippedUnsafe).toBe(LIVE_MAX_CONSECUTIVE_FAILURES + 2);
			expect(run.results).toHaveLength(1);
			expect(run.aborted).toBeNull();
		});

		test("is still counted when the run stops early", async () => {
			const clock = { t: 0 };
			const run = await runLiveQueries(
				[...[1, 2, 3, 4, 5, 6, 7].map(question), { ...question(8), query: "flagged late" }],
				options(async () => new Response("no", { status: 503 }), clock, flagged),
			);
			expect(run.aborted).toBe("consecutive-failures");
			expect(run.skippedUnsafe).toBe(1);
		});

		test("when every question is flagged, nothing is sent and nothing is scored", async () => {
			const clock = { t: 0 };
			const bodies: string[] = [];
			const run = await runLiveQueries([1, 2].map((i): GoldenQuery => ({ ...question(i), query: `flagged ${i}` })), options(asked(clock, bodies), clock, flagged));
			expect(bodies).toEqual([]);
			expect(run).toEqual({ results: [], failed: 0, degraded: 0, aborted: null, skippedUnsafe: 2 });
		});

		test("a guard that throws keeps the question back", async () => {
			const clock = { t: 0 };
			const bodies: string[] = [];
			const run = await runLiveQueries(
				[question(1)],
				options(asked(clock, bodies), clock, () => {
					throw new Error("guard broke");
				}),
			);
			expect(bodies).toEqual([]);
			expect(run.skippedUnsafe).toBe(1);
		});
	});

	describe("unsafeSkippedLine", () => {
		test("says how many were not sent and why, in the singular and the plural, and nothing for none", () => {
			expect(unsafeSkippedLine(0)).toBe("");
			expect(unsafeSkippedLine(1)).toBe("1 question was not sent: it looks like it contains a credential (the same check ingest applies)");
			expect(unsafeSkippedLine(3)).toBe("3 questions were not sent: they look like they contain a credential (the same check ingest applies)");
		});
	});
});
