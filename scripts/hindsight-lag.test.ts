import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	type BlockedBy,
	type BlockerStatus,
	type Deps,
	FAILURE_LABEL,
	FAILURE_TITLE,
	GitHubApiError,
	type HindsightPin,
	LAG_LABEL,
	LagInputError,
	PIN_PATH,
	RUNBOOK_PATH,
	analyze,
	compareSemver,
	fetchBlockers,
	fetchReleases,
	formatReport,
	issueTitle,
	main,
	mentionsBreaking,
	parseArgs,
	parsePin,
	parseReleases,
	parseSemver,
	parseTag,
	planIssue,
	renderIssueBody,
	createGitHub,
} from "./hindsight-lag.ts";

const ROOT = join(import.meta.dir, "..");
const NOW = new Date("2026-10-27T12:00:00Z");
const REPO = "example-org/example-repo";
const RUN_URL = "https://example.invalid/example-org/example-repo/actions/runs/1";

const PIN: HindsightPin = {
	pinned: "0.9.1",
	pinned_since: "2026-09-29",
	tested_against: "0.9.1",
	images: ["hindsight-api", "hindsight-worker", "hindsight-control-plane"],
	blocked_by: [{ repo: "vectorize-io/hindsight", issue: 4696, reason: "recall hang in 0.10.x" }],
	lag_alert_days: 7,
	notes: "fixture",
};

function release(tag: string, publishedAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { tag_name: tag, published_at: publishedAt, prerelease: false, draft: false, html_url: `https://example.invalid/releases/${tag}`, body: "", ...extra };
}

const RELEASES = [
	release("v1.1.0", "2026-10-21T10:00:00Z", { body: "## Breaking Changes\n- bank ids may not start with an underscore" }),
	release("v1.0.0", "2026-10-13T10:00:00Z", { body: "API stability promise" }),
	release("v0.10.3", "2026-10-08T10:00:00Z", { body: "fixes only" }),
	release("v0.10.3-rc1", "2026-10-01T10:00:00Z", { prerelease: true }),
	release("v0.10.4", null as unknown as string, { draft: true }),
	release("nightly", "2026-10-26T10:00:00Z"),
	release("v0.9.1", "2026-09-20T10:00:00Z"),
	release("v0.9.0", "2026-09-10T10:00:00Z"),
];

const OPEN_BLOCKER: BlockerStatus = { repo: "vectorize-io/hindsight", issue: 4696, reason: "recall hang in 0.10.x", state: "open", closedAt: null, url: "https://example.invalid/4696" };

/** The message of the `LagInputError` parsePin throws for `text`, or a marker when it throws something else or nothing. */
function pinError(text: string): string {
	try {
		parsePin(text);
	} catch (error) {
		return error instanceof LagInputError ? error.message : "threw something other than LagInputError";
	}
	return "did not throw";
}

describe("semver", () => {
	test("parses a strict version and a v-prefixed tag", () => {
		expect(parseSemver("0.10.3")).toEqual({ major: 0, minor: 10, patch: 3 });
		expect(parseTag("v1.1.0")).toEqual({ major: 1, minor: 1, patch: 0 });
		expect(parseTag("1.1.0")).toEqual({ major: 1, minor: 1, patch: 0 });
	});

	test("rejects everything that is not MAJOR.MINOR.PATCH", () => {
		for (const text of ["", "1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "v1.2.3", "1.2.3-rc1", "1.2.3+build", " 1.2.3", "1.2.x", "-1.2.3", "99999999999999999999.0.0"]) {
			expect({ text, parsed: parseSemver(text) }).toEqual({ text, parsed: null });
		}
		for (const tag of ["vv1.2.3", "v1.2.3-rc1", "nightly", "v1"]) expect({ tag, parsed: parseTag(tag) }).toEqual({ tag, parsed: null });
	});

	test("compares numerically, not as text", () => {
		const v = (text: string) => {
			const parsed = parseSemver(text);
			if (parsed === null) throw new Error(`fixture version ${text} does not parse`);
			return parsed;
		};
		expect(compareSemver(v("0.10.0"), v("0.9.9"))).toBe(1);
		expect(compareSemver(v("0.9.1"), v("0.10.3"))).toBe(-1);
		expect(compareSemver(v("1.0.0"), v("0.99.99"))).toBe(1);
		expect(compareSemver(v("1.2.3"), v("1.2.3"))).toBe(0);
		expect(compareSemver(v("1.2.4"), v("1.2.3"))).toBe(1);
	});
});

describe("the pin file", () => {
	test("the committed pin file is well formed, whatever version it pins", () => {
		// Structure and invariants only: a valid pin update after an upgrade or rollback must not fail this test.
		const pin = parsePin(readFileSync(join(ROOT, PIN_PATH), "utf8"));
		expect(pin.images.length).toBeGreaterThan(0);
		expect(parseSemver(pin.pinned)).not.toBeNull();
		expect(parseSemver(pin.tested_against)).not.toBeNull();
		expect(Number.isNaN(Date.parse(`${pin.pinned_since}T00:00:00Z`))).toBe(false);
		expect(Date.parse(`${pin.pinned_since}T00:00:00Z`)).toBeLessThanOrEqual(Date.now());
		expect(Number.isInteger(pin.lag_alert_days)).toBe(true);
		expect(pin.lag_alert_days).toBeGreaterThan(0);
		for (const blocker of pin.blocked_by) {
			expect(blocker.repo).toMatch(/^[^/\s]+\/[^/\s]+$/);
			expect(blocker.issue).toBeGreaterThan(0);
			expect(blocker.reason.trim().length).toBeGreaterThan(0);
		}
	});

	test("accepts the fixture and an empty blocked_by", () => {
		expect(parsePin(JSON.stringify(PIN))).toEqual(PIN);
		expect(parsePin(JSON.stringify({ ...PIN, blocked_by: [] })).blocked_by).toEqual([]);
	});

	test("rejects every malformed shape with a message naming the file", () => {
		const bad: Array<[string, unknown]> = [
			["not an object", []],
			["missing key", { ...PIN, notes: undefined }],
			["unknown key", { ...PIN, extra: 1 }],
			["pinned with v prefix", { ...PIN, pinned: "v0.9.1" }],
			["pinned with suffix", { ...PIN, pinned: "0.9.1-rc1" }],
			["pinned not a string", { ...PIN, pinned: 9 }],
			["tested_against malformed", { ...PIN, tested_against: "latest" }],
			["pinned_since not a date", { ...PIN, pinned_since: "2026-02-30" }],
			["pinned_since wrong format", { ...PIN, pinned_since: "29/09/2026" }],
			["images empty", { ...PIN, images: [] }],
			["images not strings", { ...PIN, images: [1] }],
			["images duplicate", { ...PIN, images: ["hindsight-api", "hindsight-api"] }],
			["images upper case", { ...PIN, images: ["Hindsight-API"] }],
			["blocked_by not an array", { ...PIN, blocked_by: {} }],
			["blocker repo malformed", { ...PIN, blocked_by: [{ repo: "no-slash", issue: 1, reason: "x" }] }],
			["blocker issue zero", { ...PIN, blocked_by: [{ repo: "a/b", issue: 0, reason: "x" }] }],
			["blocker issue a string", { ...PIN, blocked_by: [{ repo: "a/b", issue: "4696", reason: "x" }] }],
			["blocker reason empty", { ...PIN, blocked_by: [{ repo: "a/b", issue: 1, reason: " " }] }],
			["blocker unknown key", { ...PIN, blocked_by: [{ repo: "a/b", issue: 1, reason: "x", url: "u" }] }],
			["lag_alert_days zero", { ...PIN, lag_alert_days: 0 }],
			["lag_alert_days fractional", { ...PIN, lag_alert_days: 1.5 }],
			["lag_alert_days too large", { ...PIN, lag_alert_days: 366 }],
			["notes empty", { ...PIN, notes: "" }],
		];
		for (const [name, value] of bad) {
			expect({ name, message: pinError(JSON.stringify(value)) }).toEqual({ name, message: expect.stringContaining(PIN_PATH) });
		}
		expect(() => parsePin("{not json")).toThrow("is not valid JSON");
	});
});

describe("mentionsBreaking", () => {
	test("a Breaking Changes heading or the word BREAKING counts", () => {
		expect(mentionsBreaking("## Breaking Changes\n- x")).toBe(true);
		expect(mentionsBreaking("### Breaking change\n- x")).toBe(true);
		expect(mentionsBreaking("# Release\n\n#### breaking-changes")).toBe(true);
		expect(mentionsBreaking("feat!: x\n\nBREAKING CHANGE: ids")).toBe(true);
		expect(mentionsBreaking("**BREAKING** the thing")).toBe(true);
	});

	test("ordinary prose and other headings do not", () => {
		expect(mentionsBreaking("")).toBe(false);
		expect(mentionsBreaking("## Fixes\n- fixes a recall hang\n- no breaking things here")).toBe(false);
		expect(mentionsBreaking("breaking changes are listed elsewhere")).toBe(false);
		expect(mentionsBreaking("## Features\n- unbreakable")).toBe(false);
	});
});

describe("parseReleases", () => {
	test("keeps stable semver releases only, oldest version first", () => {
		const parsed = parseReleases(RELEASES);
		expect(parsed.map((r) => r.tag)).toEqual(["v0.9.0", "v0.9.1", "v0.10.3", "v1.0.0", "v1.1.0"]);
	});

	test("two tags for one version keep the earliest publication", () => {
		const parsed = parseReleases([release("1.0.0", "2026-10-14T00:00:00Z"), release("v1.0.0", "2026-10-13T00:00:00Z")]);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.tag).toBe("v1.0.0");
	});

	test("a null body becomes an empty string", () => {
		expect(parseReleases([release("v1.0.0", "2026-10-13T00:00:00Z", { body: null })])[0]?.body).toBe("");
	});

	test("a malformed stable release is an API error, not a skip", () => {
		expect(() => parseReleases({})).toThrow(GitHubApiError);
		expect(() => parseReleases(["x"])).toThrow(GitHubApiError);
		expect(() => parseReleases([{ ...release("v1.0.0", "2026-10-13T00:00:00Z"), tag_name: 5 }])).toThrow(GitHubApiError);
		expect(() => parseReleases([release("v1.0.0", "not a date")])).toThrow(GitHubApiError);
		expect(() => parseReleases([release("v1.0.0", "2026-10-13T00:00:00Z", { html_url: undefined })])).toThrow(GitHubApiError);
		expect(() => parseReleases([release("v1.0.0", "2026-10-13T00:00:00Z", { body: 7 })])).toThrow(GitHubApiError);
	});
});

describe("analyze: state, age and the alert threshold", () => {
	const releases = parseReleases(RELEASES);

	test("current when nothing newer is stable, and when the pin is ahead of upstream", () => {
		const current = analyze({ ...PIN, pinned: "1.1.0" }, releases, [], NOW);
		expect(current.state).toBe("current");
		expect(current.newer).toEqual([]);
		expect(current.ageDays).toBeNull();
		expect(current.alert).toBe(false);
		expect(current.latest?.version).toBe("1.1.0");
		const ahead = analyze({ ...PIN, pinned: "2.0.0" }, releases, [], NOW);
		expect(ahead.state).toBe("current");
		expect(ahead.alert).toBe(false);
		expect(analyze(PIN, [], [], NOW).latest).toBeNull();
	});

	test("classifies by the highest newer release", () => {
		const state = (pinned: string, upstream: string[]) =>
			analyze({ ...PIN, pinned }, parseReleases(upstream.map((tag) => release(tag, "2026-10-20T00:00:00Z"))), [], NOW).state;
		expect(state("0.9.1", ["v0.9.2"])).toBe("newer-patch");
		expect(state("0.9.1", ["v0.9.2", "v0.10.0"])).toBe("newer-minor");
		expect(state("0.9.1", ["v0.9.2", "v0.10.0", "v1.0.0"])).toBe("newer-major");
		expect(state("0.9.1", ["v1.0.0"])).toBe("newer-major");
		expect(state("1.2.3", ["v1.2.4", "v1.3.0"])).toBe("newer-minor");
	});

	test("the age counts from the earliest newer release, and the alert needs lag_alert_days", () => {
		const report = analyze(PIN, releases, [OPEN_BLOCKER], NOW);
		expect(report.state).toBe("newer-major");
		expect(report.newer.map((r) => r.version)).toEqual(["0.10.3", "1.0.0", "1.1.0"]);
		expect(report.ageDays).toBe(19);
		expect(report.alert).toBe(true);
		expect(report.latest?.version).toBe("1.1.0");

		const only = parseReleases([release("v0.9.2", "2026-10-20T12:00:00Z")]);
		const at = (hours: number) => analyze(PIN, only, [], new Date(Date.parse("2026-10-20T12:00:00Z") + hours * 3_600_000));
		expect(at(6 * 24 + 23).ageDays).toBe(6);
		expect(at(6 * 24 + 23).alert).toBe(false);
		expect(at(7 * 24).ageDays).toBe(7);
		expect(at(7 * 24).alert).toBe(true);
		expect(analyze({ ...PIN, lag_alert_days: 30 }, releases, [], NOW).alert).toBe(false);
		// A release dated after the clock reads as age 0, never negative.
		expect(at(-5).ageDays).toBe(0);
	});

	test("an older release does not hide a newer one's age: only newer releases are counted", () => {
		const report = analyze({ ...PIN, pinned: "0.10.3" }, releases, [], NOW);
		expect(report.newer.map((r) => r.version)).toEqual(["1.0.0", "1.1.0"]);
		expect(report.ageDays).toBe(14);
	});

	test("the breaking flag covers newer releases only", () => {
		expect(analyze(PIN, releases, [], NOW).breaking).toBe(true);
		expect(analyze({ ...PIN, pinned: "1.0.0" }, releases, [], NOW).newer.map((r) => r.breaking)).toEqual([true]);
		const quiet = parseReleases([release("v0.9.0", "2026-09-01T00:00:00Z", { body: "BREAKING old news" }), release("v0.10.3", "2026-10-08T00:00:00Z", { body: "fixes" })]);
		expect(analyze({ ...PIN, pinned: "0.9.1" }, quiet, [], NOW).breaking).toBe(false);
	});

	test("the report is deterministic text carrying the decision", () => {
		const text = formatReport(analyze(PIN, releases, [OPEN_BLOCKER], NOW));
		expect(text).toBe(
			[
				"hindsight lag: pinned 0.9.1 (since 2026-09-29, tested against 0.9.1; images hindsight-api, hindsight-worker, hindsight-control-plane)",
				"latest stable upstream: 1.1.0 (published 2026-10-21T10:00:00Z)",
				"state: newer-major",
				"newer stable releases: 0.10.3, 1.0.0, 1.1.0",
				"age: 19 days since the first newer release (alert from 7 days)",
				"breaking change mentioned: yes (1.1.0)",
				"blocker vectorize-io/hindsight#4696 open: recall hang in 0.10.x",
				"decision: alert",
				"",
			].join("\n"),
		);
		expect(formatReport(analyze({ ...PIN, pinned: "1.1.0", blocked_by: [] }, releases, [], NOW))).toContain("blockers: none declared\ndecision: no alert");
	});
});

describe("blockers", () => {
	function fakeFetch(answer: (url: string) => Response) {
		const urls: string[] = [];
		return {
			urls,
			fetch: async (url: string) => {
				urls.push(url);
				return answer(url);
			},
		};
	}
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

	test("an open and a closed upstream issue are read from the issues API", async () => {
		const blockers: BlockedBy[] = [
			{ repo: "vectorize-io/hindsight", issue: 4696, reason: "recall hang" },
			{ repo: "vectorize-io/hindsight", issue: 1, reason: "other" },
		];
		const fake = fakeFetch((url) =>
			url.endsWith("/issues/4696") ? json({ state: "closed", closed_at: "2026-09-28T08:00:00Z", html_url: "https://example.invalid/4696" }) : json({ state: "open", closed_at: null }),
		);
		const statuses = await fetchBlockers(createGitHub({ fetch: fake.fetch, token: null }), blockers);
		expect(fake.urls).toEqual(["https://api.github.com/repos/vectorize-io/hindsight/issues/4696", "https://api.github.com/repos/vectorize-io/hindsight/issues/1"]);
		expect(statuses.map((s) => [s.issue, s.state, s.closedAt])).toEqual([
			[4696, "closed", "2026-09-28T08:00:00Z"],
			[1, "open", null],
		]);
		expect(statuses[1]?.url).toBe("https://github.com/vectorize-io/hindsight/issues/1");
	});

	test("a missing issue, a server error or a state we do not know fails loudly", async () => {
		const blocker: BlockedBy[] = [{ repo: "vectorize-io/hindsight", issue: 4696, reason: "x" }];
		for (const response of [json({ message: "Not Found" }, 404), json({}, 500), json({ state: "merged" }), json([]), new Response("<html>", { status: 200 })]) {
			const gh = createGitHub({ fetch: async () => response.clone() as unknown as Response, token: null });
			await expect(fetchBlockers(gh, blocker)).rejects.toBeInstanceOf(GitHubApiError);
		}
		const down = createGitHub({
			fetch: async () => {
				throw new Error("connect failed");
			},
			token: null,
		});
		await expect(fetchBlockers(down, blocker)).rejects.toThrow("connect failed");
	});

	test("an open blocker is rendered in the issue body and a closed one is not called a fix", () => {
		const report = analyze(PIN, parseReleases(RELEASES), [OPEN_BLOCKER], NOW);
		expect(renderIssueBody(report, REPO)).toContain("**open**");
		const closed = analyze(PIN, parseReleases(RELEASES), [{ ...OPEN_BLOCKER, state: "closed", closedAt: "2026-09-28T08:00:00Z" }], NOW);
		const body = renderIssueBody(closed, REPO);
		expect(body).toContain("**closed** (2026-09-28)");
		expect(body).toContain("A closed blocker is not proof that a release carries the fix");
	});
});

describe("the issue", () => {
	const alerting = analyze(PIN, parseReleases(RELEASES), [OPEN_BLOCKER], NOW);

	test("the body names pin, latest, age, breaking flag, blocker status and the runbook", () => {
		const body = renderIssueBody(alerting, REPO);
		expect(body).toContain("`0.9.1` since 2026-09-29");
		expect(body).toContain("[v1.1.0](https://example.invalid/releases/v1.1.0)");
		expect(body).toContain("19 days since the first newer release (alert from 7 days)");
		expect(body).toContain("**yes**: v1.1.0");
		expect(body).toContain("[vectorize-io/hindsight#4696]");
		expect(body).toContain(RUNBOOK_PATH);
		expect(body).toContain(`https://github.com/${REPO}/blob/main/${RUNBOOK_PATH}`);
		expect(body).toContain("operator only");
		expect(issueTitle(alerting)).toBe("Hindsight pin 0.9.1 is behind upstream 1.1.0");
	});

	test("a current pin renders a closing body without next steps", () => {
		const current = analyze({ ...PIN, pinned: "1.1.0" }, parseReleases(RELEASES), [], NOW);
		expect(issueTitle(current)).toBe("Hindsight pin 1.1.0 is current");
		const body = renderIssueBody(current, REPO);
		expect(body).toContain("closed by the watcher");
		expect(body).not.toContain("Next steps");
	});

	test("a newer release under the threshold gets its own title", () => {
		const young = analyze(PIN, parseReleases([release("v0.9.2", "2026-10-26T00:00:00Z")]), [], NOW);
		expect(young.alert).toBe(false);
		expect(issueTitle(young)).toContain("under the alert threshold");
	});

	test("planIssue creates, updates, closes, and never leaves two open", () => {
		const desired = { title: "t", body: "b", open: true };
		expect(planIssue(desired, [])).toEqual({ kind: "create", title: "t", body: "b" });
		expect(planIssue({ ...desired, open: false }, [])).toEqual({ kind: "none" });
		expect(planIssue(desired, [{ number: 12, title: "old" }])).toEqual({ kind: "update", number: 12, title: "t", body: "b", close: false, extras: [] });
		expect(planIssue(desired, [{ number: 30, title: "" }, { number: 12, title: "" }, { number: 20, title: "" }])).toEqual({
			kind: "update",
			number: 12,
			title: "t",
			body: "b",
			close: false,
			extras: [20, 30],
		});
		expect(planIssue({ ...desired, open: false }, [{ number: 12, title: "" }, { number: 13, title: "" }])).toEqual({
			kind: "update",
			number: 12,
			title: "t",
			body: "b",
			close: true,
			extras: [13],
		});
	});
});

describe("fetchReleases pagination", () => {
	test("follows full pages and stops at the first short one", async () => {
		const pages: string[] = [];
		const full = Array.from({ length: 100 }, (_, i) => release(`v0.0.${i}-rc`, "2026-01-01T00:00:00Z", { prerelease: true }));
		const gh = createGitHub({
			token: null,
			fetch: async (url) => {
				pages.push(new URL(url).searchParams.get("page") ?? "");
				return new Response(JSON.stringify(url.endsWith("page=1") ? full : [release("v1.0.0", "2026-10-13T00:00:00Z")]));
			},
		});
		const releases = await fetchReleases(gh);
		expect(pages).toEqual(["1", "2"]);
		expect(releases.map((r) => r.tag)).toEqual(["v1.0.0"]);
	});
});

// ── main, against a fake GitHub ───────────────────────────────────────────

interface Call {
	method: string;
	path: string;
	body: unknown;
	authorization: string | null;
}

interface World {
	releases?: unknown;
	blockerState?: "open" | "closed";
	open?: Partial<Record<string, unknown[]>>;
	failOn?: (method: string, path: string) => Response | null;
}

function harness(world: World, pinText: string = JSON.stringify(PIN)) {
	const calls: Call[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const reads: string[] = [];
	const deps: Deps = {
		now: () => NOW,
		root: "/repo",
		env: { FIXTURE_TOKEN: "fixture-token-value", EMPTY_TOKEN: "  " },
		readFile: async (path) => {
			reads.push(path);
			return pinText;
		},
		stdout: (text) => void out.push(text),
		stderr: (text) => void err.push(text),
		fetch: async (url, init) => {
			const parsed = new URL(url);
			const path = `${parsed.pathname}${parsed.search}`;
			const method = init.method ?? "GET";
			const headers = init.headers as Record<string, string>;
			calls.push({ method, path, body: init.body === undefined ? undefined : JSON.parse(init.body as string), authorization: headers.authorization ?? null });
			const forced = world.failOn?.(method, path);
			if (forced) return forced;
			const json = (value: unknown) => new Response(JSON.stringify(value));
			if (method === "GET" && parsed.pathname === "/repos/vectorize-io/hindsight/releases") return json(world.releases ?? RELEASES);
			if (method === "GET" && parsed.pathname === "/repos/vectorize-io/hindsight/issues/4696") {
				return json({ state: world.blockerState ?? "open", closed_at: world.blockerState === "closed" ? "2026-09-28T08:00:00Z" : null, html_url: "https://example.invalid/4696" });
			}
			if (method === "GET" && parsed.pathname === `/repos/${REPO}/issues`) return json(world.open?.[parsed.searchParams.get("labels") ?? ""] ?? []);
			if (method === "POST" && parsed.pathname === `/repos/${REPO}/issues`) return json({ number: 99 });
			if (method === "PATCH") return json({ number: Number(parsed.pathname.split("/").pop()) });
			return new Response("unexpected", { status: 500 });
		},
	};
	return { deps, calls, out, err, reads };
}

const ARGS = ["--repo", REPO, "--token-env", "FIXTURE_TOKEN"];
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("main: one lag issue, created, updated and closed", () => {
	test("alert with no open issue creates exactly one labelled issue and opens no pull request", async () => {
		const h = harness({});
		expect(await main(ARGS, h.deps)).toBe(0);
		expect(writes(h.calls)).toEqual([
			{
				method: "POST",
				path: `/repos/${REPO}/issues`,
				authorization: "Bearer fixture-token-value",
				body: { title: "Hindsight pin 0.9.1 is behind upstream 1.1.0", body: renderIssueBody(analyze(PIN, parseReleases(RELEASES), [OPEN_BLOCKER], NOW), REPO), labels: [LAG_LABEL] },
			},
		]);
		expect(h.calls.some((c) => c.path.includes("/pulls"))).toBe(false);
		expect(h.reads).toEqual(["/repo/.github/hindsight-pin.json"]);
		expect(h.out.join("")).toContain("decision: alert");
		expect(h.out.join("")).toContain("issue: opened #99");
	});

	test("the token is sent as a bearer header and never printed", async () => {
		const h = harness({});
		await main(ARGS, h.deps);
		expect(h.calls.every((c) => c.authorization === "Bearer fixture-token-value")).toBe(true);
		expect([...h.out, ...h.err].join("")).not.toContain("fixture-token-value");
	});

	test("an open lag issue is updated in place; duplicates are closed; pull requests in the list are ignored", async () => {
		const h = harness({ open: { [LAG_LABEL]: [{ number: 40, title: "dup" }, { number: 12, title: "old" }, { number: 7, title: "a pr", pull_request: {} }] } });
		expect(await main(ARGS, h.deps)).toBe(0);
		const w = writes(h.calls);
		expect(w.map((c) => [c.method, c.path])).toEqual([
			["PATCH", `/repos/${REPO}/issues/12`],
			["PATCH", `/repos/${REPO}/issues/40`],
		]);
		expect(w[0]?.body).toEqual({ title: "Hindsight pin 0.9.1 is behind upstream 1.1.0", body: expect.stringContaining("Next steps") });
		expect(w[1]?.body).toEqual({ state: "closed", state_reason: "not_planned" });
	});

	test("a current pin closes the open issue with a final body", async () => {
		const h = harness({ open: { [LAG_LABEL]: [{ number: 12, title: "old" }] } }, JSON.stringify({ ...PIN, pinned: "1.1.0", blocked_by: [] }));
		expect(await main(ARGS, h.deps)).toBe(0);
		const [patch, ...rest] = writes(h.calls);
		expect(rest).toEqual([]);
		expect(patch?.path).toBe(`/repos/${REPO}/issues/12`);
		expect(patch?.body).toMatchObject({ title: "Hindsight pin 1.1.0 is current", state: "closed", state_reason: "completed" });
		expect(h.out.join("")).toContain("issue: closed #12");
	});

	test("a current pin with no open issue writes nothing at all", async () => {
		const h = harness({}, JSON.stringify({ ...PIN, pinned: "1.1.0", blocked_by: [] }));
		expect(await main(ARGS, h.deps)).toBe(0);
		expect(writes(h.calls)).toEqual([]);
	});

	test("a newer release under the threshold writes nothing when no issue is open", async () => {
		const h = harness({ releases: [release("v0.9.2", "2026-10-26T12:00:00Z")] });
		expect(await main(ARGS, h.deps)).toBe(0);
		expect(writes(h.calls)).toEqual([]);
		expect(h.out.join("")).toContain("decision: no alert");
	});

	test("a successful run closes an open failure issue", async () => {
		const h = harness({ open: { [FAILURE_LABEL]: [{ number: 55, title: FAILURE_TITLE }] } });
		expect(await main(ARGS, h.deps)).toBe(0);
		const failurePatch = writes(h.calls).find((c) => c.path.endsWith("/issues/55"));
		expect(failurePatch?.body).toMatchObject({ title: FAILURE_TITLE, state: "closed", state_reason: "completed" });
	});

	test("an alert that stays true twice is idempotent: the second run updates, never creates", async () => {
		const first = harness({});
		await main(ARGS, first.deps);
		const second = harness({ open: { [LAG_LABEL]: [{ number: 99, title: "x" }] } });
		await main(ARGS, second.deps);
		expect(writes(second.calls).map((c) => c.method)).toEqual(["PATCH"]);
		expect(writes(first.calls)[0]?.body).toMatchObject({ body: expect.any(String) });
		expect(writes(second.calls)[0]?.body).toMatchObject({ title: "Hindsight pin 0.9.1 is behind upstream 1.1.0", body: expect.stringContaining("Next steps") });
		expect(writes(second.calls)[0]?.body).toEqual({ title: "Hindsight pin 0.9.1 is behind upstream 1.1.0", body: renderIssueBody(analyze(PIN, parseReleases(RELEASES), [OPEN_BLOCKER], NOW), REPO) });
	});

	test("--dry-run reads upstream, prints the issue it would open, and writes nothing (no token needed)", async () => {
		const h = harness({});
		expect(await main(["--dry-run"], h.deps)).toBe(0);
		expect(h.calls.every((c) => c.method === "GET" && c.authorization === null)).toBe(true);
		expect(h.calls.some((c) => c.path.includes(`/repos/${REPO}`))).toBe(false);
		expect(h.out.join("")).toContain("dry run: no issue written");
		expect(h.out.join("")).toContain("Hindsight pin 0.9.1 is behind upstream 1.1.0");
	});
});

describe("main: failures are visible", () => {
	test("a failed upstream call exits 1 and writes nothing", async () => {
		const h = harness({ failOn: (_m, path) => (path.startsWith("/repos/vectorize-io/hindsight/releases") ? new Response("boom", { status: 502 }) : null) });
		expect(await main(ARGS, h.deps)).toBe(1);
		expect(h.err.join("")).toContain("GitHub API failure");
		expect(h.err.join("")).toContain("HTTP 502");
		expect(writes(h.calls)).toEqual([]);
	});

	test("a failed blocker lookup, issue list or issue write exits 1", async () => {
		for (const failOn of [
			(_m: string, path: string) => (path.endsWith("/issues/4696") ? new Response("", { status: 404 }) : null),
			(m: string, path: string) => (m === "GET" && path.startsWith(`/repos/${REPO}/issues`) ? new Response("", { status: 403 }) : null),
			(m: string) => (m === "POST" ? new Response("", { status: 422 }) : null),
		]) {
			expect(await main(ARGS, harness({ failOn }).deps)).toBe(1);
		}
	});

	test("a malformed pin file exits 2 before any network call", async () => {
		const h = harness({}, JSON.stringify({ ...PIN, pinned: "v0.9.1" }));
		expect(await main(ARGS, h.deps)).toBe(2);
		expect(h.err.join("")).toContain("pinned must be MAJOR.MINOR.PATCH");
		expect(h.calls).toEqual([]);
	});

	test("usage errors exit 2: unknown flag, missing values, empty or unset token variable", async () => {
		for (const argv of [["--bogus"], [], ["--repo", REPO], ["--repo", "no-slash", "--token-env", "FIXTURE_TOKEN"], [...ARGS, "--pin"], ["--token-env", "EMPTY_TOKEN", "--repo", REPO], ["--token-env", "UNSET_TOKEN", "--repo", REPO]]) {
			const h = harness({});
			expect({ argv, code: await main(argv, h.deps) }).toEqual({ argv, code: 2 });
			expect(h.calls).toEqual([]);
		}
	});

	test("report-failure opens one failure issue, updates it on the next failure, and needs a run URL", async () => {
		const first = harness({});
		expect(await main([...ARGS, "--report-failure", "--run-url", RUN_URL], first.deps)).toBe(0);
		expect(first.calls.some((c) => c.path.includes("vectorize-io"))).toBe(false);
		expect(writes(first.calls)).toEqual([
			{
				method: "POST",
				path: `/repos/${REPO}/issues`,
				authorization: "Bearer fixture-token-value",
				body: { title: FAILURE_TITLE, body: expect.stringContaining(RUN_URL), labels: [FAILURE_LABEL] },
			},
		]);

		const again = harness({ open: { [FAILURE_LABEL]: [{ number: 55, title: FAILURE_TITLE }] } });
		expect(await main([...ARGS, "--report-failure", "--run-url", RUN_URL], again.deps)).toBe(0);
		expect(writes(again.calls).map((c) => [c.method, c.path])).toEqual([["PATCH", `/repos/${REPO}/issues/55`]]);

		expect(await main([...ARGS, "--report-failure"], harness({}).deps)).toBe(2);
		expect(await main([...ARGS, "--report-failure", "--run-url", "http://example.invalid/x"], harness({}).deps)).toBe(2);
		expect(await main([...ARGS, "--run-url", RUN_URL], harness({}).deps)).toBe(2);
	});

	test("a failing issue write in report-failure mode exits 1", async () => {
		const h = harness({ failOn: (m) => (m === "POST" ? new Response("", { status: 500 }) : null) });
		expect(await main([...ARGS, "--report-failure", "--run-url", RUN_URL], h.deps)).toBe(1);
	});
});

describe("parseArgs", () => {
	test("accepts the three documented forms", () => {
		expect(parseArgs(ARGS)).toMatchObject({ repo: REPO, tokenEnv: "FIXTURE_TOKEN", dryRun: false, reportFailure: false });
		expect(parseArgs(["--dry-run", "--pin", "x.json"])).toMatchObject({ dryRun: true, pin: "x.json", repo: null });
		expect(parseArgs([...ARGS, "--report-failure", "--run-url", RUN_URL])).toMatchObject({ reportFailure: true, runUrl: RUN_URL });
	});

	test("refuses a dry run combined with report-failure and a token name that is not a variable name", () => {
		expect(() => parseArgs(["--dry-run", "--report-failure", "--run-url", RUN_URL])).toThrow(LagInputError);
		expect(() => parseArgs(["--repo", REPO, "--token-env", "has space"])).toThrow(LagInputError);
	});
});

describe("the request budget", () => {
	test("a call that never answers is aborted and reported as an API error", async () => {
		const gh = createGitHub({
			token: null,
			timeoutMs: 1,
			fetch: (_url, init) => {
				const { promise, reject } = Promise.withResolvers<Response>();
				init.signal?.addEventListener("abort", () => reject(new Error("aborted by the request budget")));
				return promise;
			},
		});
		await expect(gh.request("GET", "/repos/example-org/example-repo/issues")).rejects.toThrow(GitHubApiError);
		await expect(gh.request("GET", "/x")).rejects.toThrow("aborted by the request budget");
	});
});
