/**
 * The skills registry's rules: the state machine, the value checks, the gh answer, and the
 * binding of a pull request to a skill name. Pure: the only seam is the Runner, and these tests
 * answer it with exactly what `gh pr view --json state,mergeCommit,url,headRefName,baseRefName,files` prints.
 */
import { describe, expect, test } from "bun:test";
import { branchName, type RunResult, type Runner } from "./propose.ts";
import {
	approvalBodyProblem,
	approvalFailure,
	fetchPrView,
	GH_FILES_LIMIT,
	prApprovalViewArgv,
	prRefusal,
	proposalBranchSurface,
	REASON_MAX,
	SkillApprovalDenied,
	SkillApprovalFailed,
	SkillApprovalRefused,
	toListEntry,
	transition,
	validateApproval,
	type PrView,
	type SkillRegistryRow,
	type SkillState,
} from "./registry.ts";

const REPO = "swcstudiospace/agent-skills";
const MERGE = "0123456789abcdef0123456789abcdef01234567";
const OTHER_MERGE = "fedcba9876543210fedcba9876543210fedcba98";
const BRANCH = branchName("claude-code", "demo-skill", new Date("2026-10-14T12:34:56.789Z"), "ab12");

function view(over: Partial<PrView> = {}): PrView {
	return { state: "MERGED", url: `https://github.com/${REPO}/pull/12`, head_ref: BRANCH, base_ref: "main", merge_sha: MERGE, files: [], ...over };
}

function runnerAnswering(result: Partial<RunResult>): { run: Runner; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		run: async (argv) => {
			calls.push([...argv]);
			return { code: 0, stdout: "", stderr: "", ...result };
		},
	};
}

describe("transition", () => {
	const row = (state: SkillState, merge_sha: string | null = null) => ({ state, merge_sha });

	test("a proposed row or no row moves to the decided state", () => {
		expect(transition(null, "approve", MERGE)).toEqual({ kind: "apply", to: "approved" });
		expect(transition(row("proposed"), "approve", MERGE)).toEqual({ kind: "apply", to: "approved" });
		expect(transition(null, "decline", null)).toEqual({ kind: "apply", to: "declined" });
		expect(transition(row("proposed"), "decline", null)).toEqual({ kind: "apply", to: "declined" });
		expect(transition(row("approved", MERGE), "retire", null)).toEqual({ kind: "apply", to: "retired" });
	});

	test("asking again for the state a row has is exists, and approve compares the merge commit", () => {
		expect(transition(row("approved", MERGE), "approve", MERGE)).toEqual({ kind: "exists" });
		expect(transition(row("declined"), "decline", null)).toEqual({ kind: "exists" });
		expect(transition(row("retired", MERGE), "retire", null)).toEqual({ kind: "exists" });
		// One pull request merges once: a row that says another merge commit is not what the operator is looking at.
		expect(transition(row("approved", MERGE), "approve", OTHER_MERGE)).toEqual({ kind: "refuse", rule: "bad_transition" });
	});

	test("declined and retired are final; retire needs an approved row", () => {
		expect(transition(row("declined"), "approve", MERGE)).toEqual({ kind: "refuse", rule: "bad_transition" });
		expect(transition(row("retired", MERGE), "approve", MERGE)).toEqual({ kind: "refuse", rule: "bad_transition" });
		expect(transition(row("approved", MERGE), "decline", null)).toEqual({ kind: "refuse", rule: "bad_transition" });
		expect(transition(row("retired", MERGE), "decline", null)).toEqual({ kind: "refuse", rule: "bad_transition" });
		for (const current of [null, row("proposed"), row("declined")]) {
			expect(transition(current, "retire", null)).toEqual({ kind: "refuse", rule: "no_approved_row" });
		}
	});
});

describe("validateApproval", () => {
	const ok = { name: "demo-skill", pr_number: 12, decision: "approve" };

	test("accepts the documented shape and redacts the reason", () => {
		const secret = ["ghp", "_", "a".repeat(30)].join("");
		const valid = validateApproval({ ...ok, reason: `looked at it; token ${secret}` });
		expect(valid).toMatchObject({ name: "demo-skill", pr_number: 12, decision: "approve" });
		expect(valid.reason).not.toContain(secret);
		expect(validateApproval({ ...ok, reason: "   " }).reason).toBeNull();
		expect(validateApproval(ok).reason).toBeNull();
	});

	test.each([
		[{ decision: "merge" }, "invalid_decision"],
		[{ decision: undefined }, "invalid_decision"],
		[{ name: "Demo Skill" }, "invalid_name"],
		[{ name: "../etc" }, "invalid_name"],
		[{ name: "" }, "invalid_name"],
		[{ name: 7 }, "invalid_name"],
		[{ pr_number: 0 }, "invalid_pr_number"],
		[{ pr_number: -3 }, "invalid_pr_number"],
		[{ pr_number: 1.5 }, "invalid_pr_number"],
		[{ pr_number: 2_147_483_648 }, "invalid_pr_number"],
		[{ pr_number: Number.NaN }, "invalid_pr_number"],
		[{ reason: "x".repeat(REASON_MAX + 1) }, "invalid_reason"],
		[{ reason: 12 }, "invalid_reason"],
	])("%j is refused as %s", (over, rule) => {
		const error = (() => {
			try {
				validateApproval({ ...ok, ...over } as never);
				return null;
			} catch (cause) {
				return cause;
			}
		})();
		expect(error).toBeInstanceOf(SkillApprovalRefused);
		expect((error as SkillApprovalRefused).rule).toBe(rule as never);
		expect((error as SkillApprovalRefused).status).toBe(400);
	});

	test("a reason of exactly the cap is accepted", () => {
		expect(validateApproval({ ...ok, reason: "x".repeat(REASON_MAX) }).reason).toHaveLength(REASON_MAX);
	});
});

describe("fetchPrView", () => {
	const merged = { state: "MERGED", url: `https://github.com/${REPO}/pull/12`, headRefName: BRANCH, baseRefName: "main", mergeCommit: { oid: MERGE.toUpperCase() }, files: [] };

	test("asks gh by number on the configured library, with the six fields", async () => {
		const gh = runnerAnswering({ stdout: JSON.stringify(merged) });
		await fetchPrView(gh.run, REPO, 12);
		expect(gh.calls).toEqual([["gh", "pr", "view", "12", "--repo", REPO, "--json", "state,mergeCommit,url,headRefName,baseRefName,files"]]);
		expect(prApprovalViewArgv(REPO, 12)).toEqual(gh.calls[0] as string[]);
	});

	test("reads a merged pull request, lower-casing the oid, and an open one with no merge commit", async () => {
		expect(await fetchPrView(runnerAnswering({ stdout: JSON.stringify(merged) }).run, REPO, 12)).toEqual(view());
		const open = { ...merged, state: "OPEN", mergeCommit: null };
		expect(await fetchPrView(runnerAnswering({ stdout: JSON.stringify(open) }).run, REPO, 12)).toMatchObject({ state: "OPEN", merge_sha: null });
		const absent = { state: "CLOSED", url: merged.url, headRefName: BRANCH, baseRefName: "main", files: [] };
		expect(await fetchPrView(runnerAnswering({ stdout: JSON.stringify(absent) }).run, REPO, 12)).toMatchObject({ state: "CLOSED", merge_sha: null });
	});

	test("a failed gh is a 502 whose message never carries a credential", async () => {
		const token = ["ghp", "_", "b".repeat(30)].join("");
		const gh = runnerAnswering({ code: 1, stderr: `HTTP 401 with GITHUB_TOKEN=${token}` });
		const error = await fetchPrView(gh.run, REPO, 12).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(SkillApprovalFailed);
		expect((error as SkillApprovalFailed).status).toBe(502);
		expect((error as Error).message).not.toContain(token);
	});

	test.each([
		["not JSON", "no json here"],
		["a JSON array", "[]"],
		["null", "null"],
		["no state", JSON.stringify({ url: merged.url, headRefName: BRANCH })],
		["an unknown state", JSON.stringify({ ...merged, state: "DRAFT" })],
		["no url", JSON.stringify({ ...merged, url: undefined })],
		["no headRefName", JSON.stringify({ ...merged, headRefName: undefined })],
		["no baseRefName", JSON.stringify({ ...merged, baseRefName: undefined })],
		["an empty baseRefName", JSON.stringify({ ...merged, baseRefName: "" })],
		["a baseRefName that is not a string", JSON.stringify({ ...merged, baseRefName: { name: "main" } })],
		["a mergeCommit with no oid", JSON.stringify({ ...merged, mergeCommit: {} })],
		["a mergeCommit that is not an oid", JSON.stringify({ ...merged, mergeCommit: { oid: "HEAD" } })],
		["a mergeCommit that is a string", JSON.stringify({ ...merged, mergeCommit: MERGE })],
	])("%s is a failed step, never a guess", async (_label, stdout) => {
		const error = await fetchPrView(runnerAnswering({ stdout }).run, REPO, 12).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(SkillApprovalFailed);
		expect((error as SkillApprovalFailed).status).toBe(502);
	});

	test("a files list that is missing, not an array, or holds an entry without a string path is a failed step", async () => {
		const files = [{ path: "demo-skill/SKILL.md", additions: 3, deletions: 0 }];
		for (const odd of [undefined, null, "demo-skill/SKILL.md", {}, [null], [{}], [{ path: 5 }], ["demo-skill/SKILL.md"], [...files, { additions: 1 }]]) {
			const error = await fetchPrView(runnerAnswering({ stdout: JSON.stringify({ ...merged, files: odd }) }).run, REPO, 12).catch((cause: unknown) => cause);
			expect({ odd, status: (error as SkillApprovalFailed).status }).toEqual({ odd, status: 502 });
			expect(error).toBeInstanceOf(SkillApprovalFailed);
		}
	});

	test("reads the changed paths in gh's order, and an empty list is an answer", async () => {
		const files = [{ path: "demo-skill/SKILL.md", additions: 3, deletions: 0 }, { path: "demo-skill/references/a.md", additions: 1, deletions: 1 }];
		expect((await fetchPrView(runnerAnswering({ stdout: JSON.stringify({ ...merged, files }) }).run, REPO, 12)).files).toEqual(["demo-skill/SKILL.md", "demo-skill/references/a.md"]);
		expect((await fetchPrView(runnerAnswering({ stdout: JSON.stringify({ ...merged, files: [] }) }).run, REPO, 12)).files).toEqual([]);
	});
});

describe("proposalBranchSurface", () => {
	test("names the surface of a branch this substrate opened for exactly that skill", () => {
		expect(BRANCH).toBe("skill/claude-code/demo-skill-20261014T123456789Z-ab12");
		expect(proposalBranchSurface(BRANCH, "demo-skill")).toBe("claude-code");
	});

	test("never binds a pull request to a neighbouring or hand-named skill", () => {
		// `demo` must not match `demo-skill`'s branch, nor the other way round.
		expect(proposalBranchSurface(BRANCH, "demo")).toBeNull();
		const short = branchName("omp", "demo", new Date("2026-10-14T12:34:56.789Z"), "ab12");
		expect(proposalBranchSurface(short, "demo-skill")).toBeNull();
		for (const hand of ["main", "feature/demo-skill", "skill/omp/demo-skill", "skill/omp/demo-skill-1-abcd", "skill/omp/demo-skill-20261014T123456789Z-ZZZZ", `x${BRANCH}`, `${BRANCH}/y`]) {
			expect({ hand, surface: proposalBranchSurface(hand, "demo-skill") }).toEqual({ hand, surface: null });
		}
	});
});

describe("prRefusal", () => {
	test("approve needs a merged pull request on the library, from a proposal branch of that name, with a merge commit", () => {
		expect(prRefusal("approve", "demo-skill", REPO, 12, view())).toBeNull();
		expect(prRefusal("approve", "demo-skill", REPO, 12, view({ state: "OPEN", merge_sha: null }))).toBe("pr_open");
		expect(prRefusal("approve", "demo-skill", REPO, 12, view({ state: "CLOSED", merge_sha: null }))).toBe("pr_not_merged");
		expect(prRefusal("approve", "demo-skill", REPO, 12, view({ merge_sha: null }))).toBe("no_merge_commit");
	});

	test("decline needs a pull request closed without merging", () => {
		expect(prRefusal("decline", "demo-skill", REPO, 12, view({ state: "CLOSED", merge_sha: null }))).toBeNull();
		expect(prRefusal("decline", "demo-skill", REPO, 12, view({ state: "OPEN", merge_sha: null }))).toBe("pr_open");
		expect(prRefusal("decline", "demo-skill", REPO, 12, view())).toBe("pr_merged");
	});

	test("a pull request of another library, another number or another skill is refused before its state is judged", () => {
		expect(prRefusal("approve", "demo-skill", REPO, 12, view({ url: "https://github.com/someone/else/pull/12" }))).toBe("pr_wrong_repo");
		expect(prRefusal("approve", "demo-skill", REPO, 12, view({ url: `https://github.com/${REPO}/pull/13` }))).toBe("pr_wrong_repo");
		expect(prRefusal("approve", "demo-skill", REPO, 12, view({ url: `https://github.com/${REPO}/pull/123` }))).toBe("pr_wrong_repo");
		expect(prRefusal("approve", "other-skill", REPO, 12, view())).toBe("pr_not_for_skill");
		expect(prRefusal("approve", "demo-skill", REPO, 12, view({ head_ref: "main" }))).toBe("pr_not_for_skill");
	});

	test("a pull request merged into a stacked or other base is refused, for approve and decline, whatever its state or binding", () => {
		for (const base of ["feature/stack", "master", "Main", "main/x", ""]) {
			expect({ base, approve: prRefusal("approve", "demo-skill", REPO, 12, view({ base_ref: base })) }).toEqual({ base, approve: "pr_wrong_base" });
		}
		expect(prRefusal("decline", "demo-skill", REPO, 12, view({ base_ref: "feature/stack", state: "CLOSED", merge_sha: null }))).toBe("pr_wrong_base");
		// The repo is judged first, then the base, then what the pull request is about.
		expect(prRefusal("approve", "demo-skill", REPO, 12, view({ base_ref: "x", url: "https://github.com/someone/else/pull/12" }))).toBe("pr_wrong_repo");
		expect(prRefusal("approve", "other-skill", REPO, 12, view({ base_ref: "x" }))).toBe("pr_wrong_base");
	});

	test("the repo slug compares case-insensitively, as GitHub does", () => {
		expect(prRefusal("approve", "demo-skill", REPO, 12, view({ url: `https://github.com/${REPO.toUpperCase()}/pull/12` }))).toBeNull();
	});

	describe("a pull request that is not a proposal branch binds through the skill's own SKILL.md", () => {
		const hand = (files: string[], over: Partial<PrView> = {}) => view({ head_ref: "feature/add-demo", files, ...over });

		test("a hand-opened branch that changes demo-skill/SKILL.md is the skill's pull request, for approve and decline", () => {
			expect(prRefusal("approve", "demo-skill", REPO, 12, hand(["demo-skill/SKILL.md", "demo-skill/references/a.md"]))).toBeNull();
			expect(prRefusal("decline", "demo-skill", REPO, 12, hand(["demo-skill/SKILL.md"], { state: "CLOSED", merge_sha: null }))).toBeNull();
		});

		test("a hand-opened branch without that file is refused, and so is one that only touches the skill's other files", () => {
			expect(prRefusal("approve", "demo-skill", REPO, 12, hand([]))).toBe("pr_not_for_skill");
			expect(prRefusal("approve", "demo-skill", REPO, 12, hand(["README.md", "demo-skill/references/SKILL.md", "demo-skill/notes.md"]))).toBe("pr_not_for_skill");
		});

		test("only the exact path binds: a prefix, a suffix, a neighbour, a nested or a differently-cased path does not", () => {
			for (const path of ["demo-skill-2/SKILL.md", "demo/SKILL.md", "other/demo-skill/SKILL.md", "demo-skill/sub/SKILL.md", "demo-skill/skill.md", "Demo-Skill/SKILL.md", "demo-skill/SKILL.md.bak", "/demo-skill/SKILL.md", "demo-skill//SKILL.md"]) {
				expect({ path, refusal: prRefusal("approve", "demo-skill", REPO, 12, hand([path])) }).toEqual({ path, refusal: "pr_not_for_skill" });
			}
			// The other direction: the short name's file never binds the longer name.
			expect(prRefusal("approve", "demo", REPO, 12, hand(["demo-skill/SKILL.md"]))).toBe("pr_not_for_skill");
		});

		test("a name that is not a valid skill name binds nothing, even to a path that spells it", () => {
			for (const name of ["../x", "a/b", "", "Demo", "demo skill"]) {
				expect({ name, refusal: prRefusal("approve", name, REPO, 12, hand([`${name}/SKILL.md`])) }).toEqual({ name, refusal: "pr_not_for_skill" });
			}
		});

		test("a list gh cut at its limit that does not hold the path is refused, never guessed; one that holds it still binds", () => {
			const cut = Array.from({ length: GH_FILES_LIMIT }, (_, i) => `other-skill/references/part-${String(i)}.md`);
			expect(cut).toHaveLength(GH_FILES_LIMIT);
			expect(prRefusal("approve", "demo-skill", REPO, 12, hand(cut))).toBe("pr_not_for_skill");
			expect(prRefusal("approve", "demo-skill", REPO, 12, hand([...cut.slice(1), "demo-skill/SKILL.md"]))).toBeNull();
		});

		test("a proposal branch still binds without the file in the list (a proposal that only touches references)", () => {
			expect(prRefusal("approve", "demo-skill", REPO, 12, view({ files: [] }))).toBeNull();
			expect(prRefusal("approve", "demo-skill", REPO, 12, view({ files: ["demo-skill/references/a.md"] }))).toBeNull();
		});

		test("the repo and state checks still come first and still apply to a file-bound pull request", () => {
			expect(prRefusal("approve", "demo-skill", REPO, 12, hand(["demo-skill/SKILL.md"], { url: "https://github.com/someone/else/pull/12" }))).toBe("pr_wrong_repo");
			expect(prRefusal("approve", "demo-skill", REPO, 12, hand(["demo-skill/SKILL.md"], { state: "OPEN", merge_sha: null }))).toBe("pr_open");
			expect(prRefusal("approve", "demo-skill", REPO, 12, hand(["demo-skill/SKILL.md"], { merge_sha: null }))).toBe("no_merge_commit");
		});
	});
});

describe("approvalBodyProblem", () => {
	test("accepts the shape; values are the service's to judge", () => {
		expect(approvalBodyProblem({ name: "x", pr_number: 1, decision: "approve" })).toBeNull();
		expect(approvalBodyProblem({ name: "x", pr_number: 1, decision: "nonsense", reason: "why" })).toBeNull();
	});

	test.each([
		[null, "body must be a JSON object"],
		[[], "body must be a JSON object"],
		[{ pr_number: 1, decision: "approve" }, "name must be a string"],
		[{ name: "x", pr_number: "1", decision: "approve" }, "pr_number must be a number"],
		[{ name: "x", pr_number: 1 }, "decision must be a string"],
		[{ name: "x", pr_number: 1, decision: "approve", reason: 5 }, "reason must be a string"],
	])("%j is %s", (body, message) => {
		expect(approvalBodyProblem(body)).toBe(message);
	});
});

describe("approvalFailure", () => {
	test("maps each error onto its status, carries the rule, and leaves foreign errors to the caller", () => {
		expect(approvalFailure(new SkillApprovalDenied(403, "no"))).toEqual({ status: 403, body: { error: "no" } });
		expect(approvalFailure(new SkillApprovalRefused("pr_open", "open"))).toEqual({ status: 409, body: { error: "open", rule: "pr_open" } });
		expect(approvalFailure(new SkillApprovalRefused("invalid_name", "bad"))).toEqual({ status: 400, body: { error: "bad", rule: "invalid_name" } });
		expect(approvalFailure(new SkillApprovalFailed(503, "down"))).toEqual({ status: 503, body: { error: "down" } });
		expect(approvalFailure(new Error("boom"))).toBeNull();
	});

	test("a gh failure's message is redacted and capped on the way out", () => {
		const token = ["ghp", "_", "c".repeat(30)].join("");
		const failure = approvalFailure(new SkillApprovalFailed(502, `gh pr view exited 1: GITHUB_TOKEN=${token} ${"y".repeat(900)}`));
		expect(failure?.body.error).not.toContain(token);
		expect(failure?.body.error.length).toBeLessThanOrEqual(400);
	});
});

describe("toListEntry", () => {
	const row: SkillRegistryRow = {
		repo: REPO,
		name: "demo-skill",
		pr_number: 12,
		content_sha256: "ab".repeat(32),
		state: "approved",
		proposed_by: "claude-code",
		pr_url: `https://github.com/${REPO}/pull/12`,
		branch: BRANCH,
		merge_sha: MERGE,
		decided_by: "omp",
		decided_at: "2026-10-14T13:00:00.000Z",
		reason: "reviewed",
		created: "2026-10-14T12:00:00.000Z",
		updated: "2026-10-14T13:00:00.000Z",
	};

	test("the default entry is exactly the six fields a projector needs", () => {
		expect(toListEntry(row, false)).toEqual({
			name: "demo-skill",
			content_sha256: "ab".repeat(32),
			merge_sha: MERGE,
			pr_url: `https://github.com/${REPO}/pull/12`,
			approved_at: "2026-10-14T13:00:00.000Z",
			proposed_by: "claude-code",
		});
	});

	test("an extended entry adds where the row stands, and only an approved row has an approved_at", () => {
		const declined = toListEntry({ ...row, state: "declined", merge_sha: null }, true);
		expect(declined).toMatchObject({ state: "declined", pr_number: 12, decided_by: "omp", approved_at: null, reason: "reviewed" });
	});
});
