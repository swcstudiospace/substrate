/**
 * Skills governance, server half (uplift-5 S5a): `skills_approve`, `skills_list`, the registry
 * writes `skills_propose` makes under SUBSTRATE_SKILLS_GOVERNANCE, and the three doors.
 *
 * The registry store is an in-memory stand-in that runs the REAL state machine
 * (`transition`), so what is under test is the service's ordering: who may ask, what is checked
 * before gh is asked, what survives a failure at each step. The Runner records every gh call, so
 * "refused before any gh call" is an assertion about an empty call list, not a mock echo.
 * The Postgres half is `index-store.skills.test.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, skillsGovernanceConfigWarnings, type SubstrateConfig } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { branchName, type ProposeResult, type Runner, type SkillProposer } from "./skills/propose.ts";
import {
	LIST_MAX,
	SkillApprovalDenied,
	SkillApprovalFailed,
	SkillApprovalRefused,
	transition,
	type SkillDecisionResult,
	type SkillRegistryRow,
} from "./skills/registry.ts";
import type { SubstrateEvent, Surface } from "./types.ts";

const REPO = "swcstudiospace/agent-skills";
const MERGE = "0123456789abcdef0123456789abcdef01234567";
const HASH = "ab".repeat(32);
const BRANCH = branchName("claude-code", "demo-skill", new Date("2026-10-14T12:34:56.789Z"), "ab12");
const PR_URL = (n: number) => `https://github.com/${REPO}/pull/${String(n)}`;

const asOperator = { surface: "omp" as Surface, isOperator: true };
const asAgent = { surface: "claude-code" as Surface, isOperator: false };

/** What `gh pr view --json state,mergeCommit,url,headRefName,baseRefName,files` prints for a pull request. */
function ghView(over: Record<string, unknown> = {}, number = 12): string {
	return JSON.stringify({ state: "MERGED", url: PR_URL(number), headRefName: BRANCH, baseRefName: "main", mergeCommit: { oid: MERGE }, files: [], ...over });
}

/** A registry store that holds rows in memory and judges moves with the real state machine. */
class FakeRegistry {
	readonly rows: SkillRegistryRow[] = [];
	readonly calls: string[] = [];
	failWrites: Error | null = null;
	failReads: Error | null = null;

	private find(repo: string, name: string, pr: number): SkillRegistryRow | undefined {
		return this.rows.find((row) => row.repo === repo && row.name === name && row.pr_number === pr);
	}

	async upsertProposedSkill(input: {
		repo: string;
		name: string;
		pr_number: number;
		pr_url: string;
		branch: string | null;
		content_sha256: string;
		proposed_by: string;
	}): Promise<void> {
		this.calls.push("upsert");
		if (this.failWrites) throw this.failWrites;
		if (this.find(input.repo, input.name, input.pr_number)) return;
		const now = new Date().toISOString();
		this.rows.push({
			...input,
			state: "proposed",
			merge_sha: null,
			decided_by: null,
			decided_at: null,
			reason: null,
			created: now,
			updated: now,
		});
	}

	async decideSkill(input: {
		repo: string;
		name: string;
		pr_number: number;
		decision: "approve" | "decline" | "retire";
		merge_sha: string | null;
		pr_url: string | null;
		branch: string | null;
		proposed_by: string | null;
		decided_by: string;
		reason: string | null;
	}): Promise<SkillDecisionResult> {
		this.calls.push("decide");
		if (this.failWrites) throw this.failWrites;
		const current = this.find(input.repo, input.name, input.pr_number) ?? null;
		const verdict = transition(current, input.decision, input.merge_sha);
		if (verdict.kind === "refuse") return { outcome: "refused", rule: verdict.rule, row: current };
		if (verdict.kind === "exists" && current) return { outcome: "exists", row: current, remaining_approved: this.approvedCount(input.repo, input.name) };
		if (verdict.kind !== "apply") throw new Error("unreachable");
		const now = new Date().toISOString();
		if (current) {
			Object.assign(current, {
				state: verdict.to,
				merge_sha: input.merge_sha ?? current.merge_sha,
				pr_url: input.pr_url ?? current.pr_url,
				branch: input.branch ?? current.branch,
				decided_by: input.decided_by,
				decided_at: now,
				reason: input.reason,
				updated: now,
			});
			return { outcome: "applied", row: current, remaining_approved: this.approvedCount(input.repo, input.name) };
		}
		const row: SkillRegistryRow = {
			repo: input.repo,
			name: input.name,
			pr_number: input.pr_number,
			content_sha256: "",
			state: verdict.to,
			proposed_by: input.proposed_by,
			pr_url: input.pr_url,
			branch: input.branch,
			merge_sha: input.merge_sha,
			decided_by: input.decided_by,
			decided_at: now,
			reason: input.reason,
			created: now,
			updated: now,
		};
		this.rows.push(row);
		return { outcome: "applied", row, remaining_approved: this.approvedCount(input.repo, input.name) };
	}

	private approvedCount(repo: string, name: string): number {
		return this.rows.filter((row) => row.repo === repo && row.name === name && row.state === "approved").length;
	}

	async listSkills(repo: string, state: string | null, limit: number): Promise<SkillRegistryRow[]> {
		this.calls.push("list");
		if (this.failReads) throw this.failReads;
		const matching = this.rows.filter((row) => row.repo === repo && (state === null || row.state === state));
		// The store's contract: `approved` is one row per name (latest decided_at, then highest pull request), the rest are every row.
		const kept =
			state === "approved"
				? matching.filter(
						(row) =>
							!matching.some(
								(other) =>
									other.name === row.name &&
									((other.decided_at ?? "") > (row.decided_at ?? "") || ((other.decided_at ?? "") === (row.decided_at ?? "") && other.pr_number > row.pr_number)),
							),
					)
				: matching;
		return kept.sort((a, b) => (a.name === b.name ? a.pr_number - b.pr_number : a.name < b.name ? -1 : 1)).slice(0, limit);
	}
}

interface World {
	substrate: Substrate;
	registry: FakeRegistry;
	events: SubstrateEvent[];
	gh: string[][];
	proposals: unknown[];
	/** Replace what gh answers, by pull request number. */
	answer(number: number, reply: { code?: number; stdout?: string; stderr?: string }): void;
}

function world(
	env: Record<string, string | undefined> = {},
	options: { propose?: ProposeResult; ledgerFails?: boolean; noIndex?: boolean; config?: (config: SubstrateConfig) => void } = {},
): World {
	const registry = new FakeRegistry();
	const events: SubstrateEvent[] = [];
	const gh: string[][] = [];
	const replies = new Map<number, { code?: number; stdout?: string; stderr?: string }>();
	const proposals: unknown[] = [];
	const run: Runner = async (argv) => {
		gh.push([...argv]);
		const number = Number(argv[3]);
		const reply = replies.get(number) ?? { stdout: ghView({}, number) };
		return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
	};
	const proposer: SkillProposer = {
		propose: async (input) => {
			proposals.push(input);
			return (
				options.propose ?? {
					status: "opened",
					pr_url: PR_URL(12),
					pr_number: 12,
					branch: BRANCH,
					content_sha256: HASH,
					redactions: [],
				}
			);
		},
	};
	const greptime = {
		ensureAppendMode: async () => true,
		lastHash: async () => null,
		insertEvent: async (event: SubstrateEvent) => {
			if (options.ledgerFails) throw new Error("greptime unreachable");
			events.push(event);
		},
	};
	const config = loadConfig(env);
	options.config?.(config);
	const substrate = new Substrate(config, {
		index: options.noIndex ? null : (registry as never),
		greptime: greptime as never,
		skills: proposer,
		skillRun: run,
	});
	return {
		substrate,
		registry,
		events,
		gh,
		proposals,
		answer: (number, reply) => void replies.set(number, reply),
	};
}

const approve = { name: "demo-skill", pr_number: 12, decision: "approve" };

async function error(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => null,
		(cause: unknown) => cause,
	);
}

describe("skills_approve: authority comes before anything else", () => {
	test("an anonymous caller is 401 and nothing happened: no gh, no row, no event", async () => {
		const w = world();
		const failure = await error(w.substrate.approveSkill(approve, { surface: null, isOperator: true }));
		expect(failure).toBeInstanceOf(SkillApprovalDenied);
		expect((failure as SkillApprovalDenied).status).toBe(401);
		expect(w.gh).toEqual([]);
		expect(w.registry.calls).toEqual([]);
		expect(w.events).toEqual([]);
	});

	test("a surface without an operator token is 403 and nothing happened", async () => {
		const w = world();
		const failure = await error(w.substrate.approveSkill(approve, asAgent));
		expect(failure).toBeInstanceOf(SkillApprovalDenied);
		expect((failure as SkillApprovalDenied).status).toBe(403);
		expect((failure as Error).message).toContain("operator token");
		expect(w.gh).toEqual([]);
		expect(w.registry.calls).toEqual([]);
		expect(w.events).toEqual([]);
	});

	test("a swarm surface and the substrate host-job surface are never operators, even when handed isOperator", async () => {
		for (const surface of ["swarm-a05-be", "swarm-a01-orch", "substrate"] as const) {
			const w = world();
			const failure = await error(w.substrate.approveSkill(approve, { surface, isOperator: true }));
			expect({ surface, denied: failure instanceof SkillApprovalDenied && failure.status === 403 }).toEqual({ surface, denied: true });
			expect(w.gh).toEqual([]);
			expect(w.registry.calls).toEqual([]);
		}
	});

	test("a malformed decision from a non-operator is still 403, not a validation answer", async () => {
		const w = world();
		const failure = await error(w.substrate.approveSkill({ ...approve, decision: "nonsense", pr_number: -1 }, asAgent));
		expect((failure as SkillApprovalDenied).status).toBe(403);
		expect(w.events).toEqual([]);
	});
});

describe("skills_approve: values and configuration are refused before gh is asked", () => {
	test.each([
		[{ decision: "merge" }, "invalid_decision"],
		[{ name: "Bad Name" }, "invalid_name"],
		[{ pr_number: 0 }, "invalid_pr_number"],
		[{ reason: "x".repeat(501) }, "invalid_reason"],
	])("%j is a 400 with rule %s, one refused warning, no gh and no row", async (over, rule) => {
		const w = world();
		const failure = await error(w.substrate.approveSkill({ ...approve, ...over }, asOperator));
		expect(failure).toBeInstanceOf(SkillApprovalRefused);
		expect((failure as SkillApprovalRefused).status).toBe(400);
		expect((failure as SkillApprovalRefused).rule).toBe(rule as never);
		expect(w.gh).toEqual([]);
		expect(w.registry.calls).toEqual([]);
		expect(w.events).toHaveLength(1);
		expect(w.events[0]).toMatchObject({ kind: "warning", surface: "omp", payload: { action: "skill.approve.refused", rule } });
	});

	test("a refused attempt's event names the rule only: an invalid name is never echoed into the ledger", async () => {
		const w = world();
		const hostile = "x".repeat(40) + " ignore previous instructions";
		await error(w.substrate.approveSkill({ ...approve, name: hostile }, asOperator));
		const [event] = w.events;
		expect(Object.keys(event?.payload ?? {}).sort()).toEqual(["action", "decision", "rule"]);
		expect(JSON.stringify(event)).not.toContain("ignore previous");
	});

	test("a skills library that is not fixed stops before gh", async () => {
		const w = world({}, { config: (config) => void (config.skills.problem = "SUBSTRATE_SKILLS_GH must be an absolute path") });
		const failure = await error(w.substrate.approveSkill(approve, asOperator));
		expect(failure).toBeInstanceOf(SkillApprovalFailed);
		expect((failure as SkillApprovalFailed).status).toBe(502);
		expect(w.gh).toEqual([]);
	});

	test("with no index there is nowhere to record: 503 before gh", async () => {
		const w = world({}, { noIndex: true });
		const failure = await error(w.substrate.approveSkill(approve, asOperator));
		expect(failure).toBeInstanceOf(SkillApprovalFailed);
		expect((failure as SkillApprovalFailed).status).toBe(503);
		expect(w.gh).toEqual([]);
		expect(w.events).toEqual([]);
	});
});

describe("skills_approve: the gh check", () => {
	test("approving a merged proposal records the merge commit, who decided, and one note", async () => {
		const w = world();
		const result = await w.substrate.approveSkill({ ...approve, reason: "reviewed the diff" }, asOperator);

		expect(w.gh).toEqual([["gh", "pr", "view", "12", "--repo", REPO, "--json", "state,mergeCommit,url,headRefName,baseRefName,files"]]);
		expect(result).toEqual({
			status: "approved",
			state: "approved",
			name: "demo-skill",
			pr_number: 12,
			pr_url: PR_URL(12),
			merge_sha: MERGE,
			content_sha256: "",
			remaining_approved_for_name: 1,
			noted: true,
		});
		expect(w.registry.rows).toHaveLength(1);
		expect(w.registry.rows[0]).toMatchObject({ state: "approved", merge_sha: MERGE, decided_by: "omp", reason: "reviewed the diff", proposed_by: "claude-code" });
		expect(w.events).toHaveLength(1);
		expect(w.events[0]).toMatchObject({
			kind: "note",
			surface: "omp",
			repo: REPO,
			payload: { action: "skill.approve", name: "demo-skill", pr_number: 12, pr_url: PR_URL(12), merge_sha: MERGE, decided_by: "omp" },
		});
	});

	test("the reason is redacted before it reaches the row", async () => {
		const w = world();
		const secret = ["ghp", "_", "d".repeat(30)].join("");
		await w.substrate.approveSkill({ ...approve, reason: `see ${secret}` }, asOperator);
		expect(w.registry.rows[0]?.reason).not.toContain(secret);
	});

	test("asking again for the same merge answers exists: no second row, no second event", async () => {
		const w = world();
		await w.substrate.approveSkill(approve, asOperator);
		const again = await w.substrate.approveSkill(approve, asOperator);
		expect(again).toMatchObject({ status: "exists", state: "approved", merge_sha: MERGE });
		expect(w.registry.rows).toHaveLength(1);
		expect(w.events).toHaveLength(1);
	});

	test("a gh failure is 502 with no row and no event", async () => {
		const w = world();
		w.answer(12, { code: 1, stderr: "HTTP 502: bad gateway" });
		const failure = await error(w.substrate.approveSkill(approve, asOperator));
		expect(failure).toBeInstanceOf(SkillApprovalFailed);
		expect((failure as SkillApprovalFailed).status).toBe(502);
		expect(w.registry.calls).toEqual([]);
		expect(w.registry.rows).toEqual([]);
		expect(w.events).toEqual([]);
	});

	test("an answer gh gave without the fields the decision reads is a failed step, not a guess", async () => {
		const w = world();
		w.answer(12, { stdout: JSON.stringify({ state: "MERGED", url: PR_URL(12) }) });
		const failure = await error(w.substrate.approveSkill(approve, asOperator));
		expect((failure as SkillApprovalFailed).status).toBe(502);
		expect(w.registry.rows).toEqual([]);
		expect(w.events).toEqual([]);
	});

	test.each([
		["still open", { state: "OPEN", mergeCommit: null }, "pr_open"],
		["closed without merging", { state: "CLOSED", mergeCommit: null }, "pr_not_merged"],
		["merged but reported no merge commit", { mergeCommit: null }, "no_merge_commit"],
		["on another library", { url: "https://github.com/someone/else/pull/12" }, "pr_wrong_repo"],
		["merged into a stacked base that is not the library's main", { baseRefName: "feature/stack" }, "pr_wrong_base"],
		["a hand-opened branch that does not change the skill's SKILL.md", { headRefName: "feature/demo-skill" }, "pr_not_for_skill"],
		["another skill's branch", { headRefName: branchName("claude-code", "other-skill", new Date("2026-10-14T12:34:56.789Z"), "ab12") }, "pr_not_for_skill"],
	])("approving a pull request that is %s is refused as %s, leaving no row", async (_label, over, rule) => {
		const w = world();
		w.answer(12, { stdout: ghView(over) });
		const failure = await error(w.substrate.approveSkill(approve, asOperator));
		expect(failure).toBeInstanceOf(SkillApprovalRefused);
		expect((failure as SkillApprovalRefused).rule).toBe(rule as never);
		expect((failure as SkillApprovalRefused).status).toBe(rule === "pr_not_for_skill" ? 400 : 409);
		expect(w.registry.calls).toEqual([]);
		expect(w.events).toHaveLength(1);
		expect(w.events[0]).toMatchObject({ kind: "warning", payload: { action: "skill.approve.refused", rule, decision: "approve", name: "demo-skill" } });
	});

	describe("a hand-opened pull request binds through the skill's own SKILL.md", () => {
		const handOpened = (paths: string[], over: Record<string, unknown> = {}) =>
			ghView({ headRefName: "feature/add-demo-skill", files: paths.map((path) => ({ path, additions: 1, deletions: 0 })), ...over });

		test("merged, hand-opened, and it changes demo-skill/SKILL.md: approved, recorded with no proposer and an empty hash", async () => {
			const w = world();
			w.answer(12, { stdout: handOpened(["demo-skill/SKILL.md", "demo-skill/references/a.md"]) });
			const result = await w.substrate.approveSkill(approve, asOperator);
			expect(result).toMatchObject({ status: "approved", merge_sha: MERGE, content_sha256: "" });
			expect(w.registry.rows[0]).toMatchObject({ state: "approved", proposed_by: null, branch: "feature/add-demo-skill", merge_sha: MERGE });
			expect(w.events.map((event) => event.payload.action)).toEqual(["skill.approve"]);
			// gh was asked for the files too.
			expect(w.gh[0]?.at(-1)).toBe("state,mergeCommit,url,headRefName,baseRefName,files");
		});

		test("hand-opened without that file, with a prefix-lookalike path, or with only a cut list that lacks it: pr_not_for_skill, no row", async () => {
			const cut = Array.from({ length: 100 }, (_, i) => `other-skill/references/part-${String(i)}.md`);
			for (const paths of [[], ["README.md"], ["demo-skill-2/SKILL.md"], ["demo/SKILL.md"], ["demo-skill/references/SKILL.md"], cut]) {
				const w = world();
				w.answer(12, { stdout: handOpened(paths) });
				const failure = await error(w.substrate.approveSkill(approve, asOperator));
				expect({ count: paths.length, rule: (failure as SkillApprovalRefused).rule }).toEqual({ count: paths.length, rule: "pr_not_for_skill" });
				expect(w.registry.calls).toEqual([]);
				expect(w.events).toHaveLength(1);
				expect(w.events[0]).toMatchObject({ kind: "warning", payload: { action: "skill.approve.refused", rule: "pr_not_for_skill" } });
			}
		});

		test("a proposal branch is still approved when its file list does not name the skill's SKILL.md", async () => {
			const w = world();
			w.answer(12, { stdout: ghView({ files: [{ path: "demo-skill/references/a.md", additions: 1, deletions: 0 }] }) });
			expect((await w.substrate.approveSkill(approve, asOperator)).status).toBe("approved");
		});

		test("a files list gh did not give, or gave in an odd shape, is a failed step with no row", async () => {
			for (const files of [undefined, "demo-skill/SKILL.md", [{ additions: 1 }]]) {
				const w = world();
				w.answer(12, { stdout: ghView({ files }) });
				const failure = await error(w.substrate.approveSkill(approve, asOperator));
				expect({ files, status: (failure as SkillApprovalFailed).status }).toEqual({ files, status: 502 });
				expect(w.registry.calls).toEqual([]);
				expect(w.events).toEqual([]);
			}
		});

		test("a hand-opened closed pull request that changes the skill's SKILL.md can be declined", async () => {
			const w = world();
			w.answer(12, { stdout: handOpened(["demo-skill/SKILL.md"], { state: "CLOSED", mergeCommit: null }) });
			expect(await w.substrate.approveSkill({ ...approve, decision: "decline" }, asOperator)).toMatchObject({ status: "declined" });
		});
	});
});

describe("skills_approve: decline and retire", () => {
	test("declining needs a closed, unmerged pull request and emits a note without a merge sha", async () => {
		const w = world();
		w.answer(12, { stdout: ghView({ state: "CLOSED", mergeCommit: null }) });
		const result = await w.substrate.approveSkill({ ...approve, decision: "decline" }, asOperator);
		expect(result).toMatchObject({ status: "declined", state: "declined", merge_sha: null });
		expect(w.events).toHaveLength(1);
		expect(w.events[0]?.payload).toMatchObject({ action: "skill.decline", name: "demo-skill", pr_number: 12 });
		expect(w.events[0]?.payload).not.toHaveProperty("merge_sha");
	});

	test("declining a merged pull request, or an open one, is refused", async () => {
		const merged = world();
		expect(((await error(merged.substrate.approveSkill({ ...approve, decision: "decline" }, asOperator))) as SkillApprovalRefused).rule).toBe("pr_merged");
		const open = world();
		open.answer(12, { stdout: ghView({ state: "OPEN", mergeCommit: null }) });
		expect(((await error(open.substrate.approveSkill({ ...approve, decision: "decline" }, asOperator))) as SkillApprovalRefused).rule).toBe("pr_open");
		expect(merged.registry.rows).toEqual([]);
		expect(open.registry.rows).toEqual([]);
	});

	test("a declined row is final: approving or declining otherwise is refused and the row is untouched", async () => {
		const w = world();
		w.answer(12, { stdout: ghView({ state: "CLOSED", mergeCommit: null }) });
		await w.substrate.approveSkill({ ...approve, decision: "decline" }, asOperator);
		// The owner reopens and merges it: the registry still says declined.
		w.answer(12, { stdout: ghView() });
		const failure = await error(w.substrate.approveSkill(approve, asOperator));
		expect((failure as SkillApprovalRefused).rule).toBe("bad_transition");
		expect(w.registry.rows[0]?.state).toBe("declined");
		expect(w.events.map((event) => event.payload.action)).toEqual(["skill.decline", "skill.approve.refused"]);
	});

	test("retiring an approved row is a local state change: no gh call, a retire note carrying the approved merge", async () => {
		const w = world();
		await w.substrate.approveSkill(approve, asOperator);
		w.gh.length = 0;
		const result = await w.substrate.approveSkill({ ...approve, decision: "retire", reason: "superseded" }, asOperator);
		expect(w.gh).toEqual([]);
		expect(result).toMatchObject({ status: "retired", state: "retired", merge_sha: MERGE });
		expect(w.registry.rows[0]).toMatchObject({ state: "retired", reason: "superseded" });
		expect(w.events.at(-1)?.payload).toMatchObject({ action: "skill.retire", merge_sha: MERGE });
		// Nothing was deleted, and retiring twice is exists.
		expect(w.registry.rows).toHaveLength(1);
		expect(await w.substrate.approveSkill({ ...approve, decision: "retire" }, asOperator)).toMatchObject({ status: "exists" });
		expect(w.events).toHaveLength(2);
	});

	test("retiring with no approved row is refused as no_approved_row, whether the row is missing or only proposed", async () => {
		const missing = world();
		expect(((await error(missing.substrate.approveSkill({ ...approve, decision: "retire" }, asOperator))) as SkillApprovalRefused).rule).toBe("no_approved_row");
		const proposed = world({ SUBSTRATE_SKILLS_GOVERNANCE: "report" });
		await proposed.substrate.proposeSkill({ name: "demo-skill", files: {}, rationale: "r" }, asAgent);
		expect(proposed.registry.rows[0]?.state).toBe("proposed");
		const failure = await error(proposed.substrate.approveSkill({ ...approve, decision: "retire" }, asOperator));
		expect((failure as SkillApprovalRefused).rule).toBe("no_approved_row");
		expect(proposed.registry.rows[0]?.state).toBe("proposed");
	});
});

describe("skills_approve: what survives a failure", () => {
	test("a registry write that fails is 503: no event, and the next attempt is not blocked", async () => {
		const w = world();
		w.registry.failWrites = new Error("connection terminated");
		const failure = await error(w.substrate.approveSkill(approve, asOperator));
		expect(failure).toBeInstanceOf(SkillApprovalFailed);
		expect((failure as SkillApprovalFailed).status).toBe(503);
		expect(w.events).toEqual([]);
		w.registry.failWrites = null;
		expect(await w.substrate.approveSkill(approve, asOperator)).toMatchObject({ status: "approved" });
	});

	test("an event the ledger cannot store never changes the decision: the row stands, the answer says noted:false, and stderr names the row", async () => {
		const w = world({}, { ledgerFails: true });
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const result = await w.substrate.approveSkill(approve, asOperator);
			expect(result.status).toBe("approved");
			expect(result.noted).toBe(false);
			expect(w.registry.rows[0]?.state).toBe("approved");
			const lines = written.filter((line) => line.includes("skill.approve event was not stored"));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(`${REPO}/demo-skill#12`);
			// A re-run answers exists and emits nothing: the lost note is not recovered by retrying.
			const again = await w.substrate.approveSkill(approve, asOperator);
			expect(again.status).toBe("exists");
			expect(again).not.toHaveProperty("noted");
			expect(w.events).toEqual([]);
		} finally {
			process.stderr.write = original;
		}
	});

	test("a stored note is noted:true", async () => {
		const w = world();
		expect((await w.substrate.approveSkill(approve, asOperator)).noted).toBe(true);
	});
});

describe("a name stays approved while any of its rows is approved", () => {
	const OTHER = "9".repeat(40);
	const retire = (number: number) => ({ ...approve, pr_number: number, decision: "retire" });

	/** demo-skill approved through PR 12 (merge MERGE) and then PR 20 (merge OTHER). */
	async function twoApprovals() {
		const w = world();
		await w.substrate.approveSkill(approve, asOperator);
		w.answer(20, { stdout: ghView({ mergeCommit: { oid: OTHER } }, 20) });
		const second = await w.substrate.approveSkill({ ...approve, pr_number: 20 }, asOperator);
		return { w, second };
	}

	test("each decision answers how many approved rows the name has left, and the list is one entry for the name", async () => {
		const { w, second } = await twoApprovals();
		expect(second).toMatchObject({ status: "approved", remaining_approved_for_name: 2 });
		const listed = await w.substrate.listSkills({}, asAgent);
		expect(listed.skills.map((skill) => skill.name)).toEqual(["demo-skill"]);
		expect(listed.skills[0]?.merge_sha).toBe(OTHER);
	});

	test("retiring the newer pull request leaves the name approved through the older one; retiring that too withdraws it", async () => {
		const { w } = await twoApprovals();
		const first = await w.substrate.approveSkill(retire(20), asOperator);
		expect(first).toMatchObject({ status: "retired", pr_number: 20, remaining_approved_for_name: 1 });
		const stillListed = await w.substrate.listSkills({}, asAgent);
		expect(stillListed.skills.map((skill) => [skill.name, skill.merge_sha])).toEqual([["demo-skill", MERGE]]);

		const last = await w.substrate.approveSkill(retire(12), asOperator);
		expect(last).toMatchObject({ status: "retired", pr_number: 12, remaining_approved_for_name: 0 });
		expect((await w.substrate.listSkills({}, asAgent)).skills).toEqual([]);
		// Nothing was deleted: both rows are still there, retired.
		expect(w.registry.rows.map((row) => row.state)).toEqual(["retired", "retired"]);
	});

	test("declining a LATER proposal never touches the earlier approval", async () => {
		const w = world();
		await w.substrate.approveSkill(approve, asOperator);
		w.answer(21, { stdout: ghView({ state: "CLOSED", mergeCommit: null }, 21) });
		const declined = await w.substrate.approveSkill({ ...approve, pr_number: 21, decision: "decline" }, asOperator);
		expect(declined).toMatchObject({ status: "declined", pr_number: 21, remaining_approved_for_name: 1 });
		expect(w.registry.rows.find((row) => row.pr_number === 12)?.state).toBe("approved");
		expect((await w.substrate.listSkills({}, asAgent)).skills.map((skill) => skill.name)).toEqual(["demo-skill"]);
	});

	test("an exists answer reports the count too, and another skill's approvals are not counted", async () => {
		const w = world();
		await w.substrate.approveSkill(approve, asOperator);
		w.answer(30, { stdout: ghView({ headRefName: branchName("claude-code", "other-skill", new Date("2026-10-14T12:34:56.789Z"), "ab12") }, 30) });
		await w.substrate.approveSkill({ ...approve, name: "other-skill", pr_number: 30 }, asOperator);
		expect(await w.substrate.approveSkill(approve, asOperator)).toMatchObject({ status: "exists", remaining_approved_for_name: 1 });
	});
});

describe("skills_propose and the registry", () => {
	const request = { name: "demo-skill", files: { "SKILL.md": "x" }, rationale: "why" };

	test("with governance off (the default) a proposal writes nothing to the registry and answers as before", async () => {
		const w = world();
		const result = await w.substrate.proposeSkill(request, asAgent);
		expect(result.status).toBe("opened");
		expect(w.registry.calls).toEqual([]);
		expect(w.events.map((event) => event.payload.action)).toEqual(["skill.propose"]);
	});

	test.each(["report", "enforce"])("under %s a proposal records a proposed row with its content hash and branch", async (mode) => {
		const w = world({ SUBSTRATE_SKILLS_GOVERNANCE: mode });
		await w.substrate.proposeSkill(request, asAgent);
		expect(w.registry.rows).toHaveLength(1);
		expect(w.registry.rows[0]).toMatchObject({
			repo: REPO,
			name: "demo-skill",
			pr_number: 12,
			pr_url: PR_URL(12),
			branch: BRANCH,
			content_sha256: HASH,
			state: "proposed",
			proposed_by: "claude-code",
		});
	});

	test("approving a recorded proposal keeps its content hash on the same row", async () => {
		const w = world({ SUBSTRATE_SKILLS_GOVERNANCE: "report" });
		await w.substrate.proposeSkill(request, asAgent);
		const result = await w.substrate.approveSkill(approve, asOperator);
		expect(result).toMatchObject({ status: "approved", content_sha256: HASH });
		expect(w.registry.rows).toHaveLength(1);
	});

	test("only a proposal that has a pull request is recorded: not a dry run, declined, unchanged or refused", async () => {
		for (const propose of [
			{ status: "declined", pr_url: PR_URL(12), pr_number: 12, content_sha256: HASH, redactions: [] },
			{ status: "unchanged", content_sha256: HASH, redactions: [] },
			{ status: "dry_run", content_sha256: HASH, redactions: [] },
		] as ProposeResult[]) {
			const w = world({ SUBSTRATE_SKILLS_GOVERNANCE: "report" }, { propose });
			await w.substrate.proposeSkill(request, asAgent);
			expect({ status: propose.status, calls: w.registry.calls }).toEqual({ status: propose.status, calls: [] });
		}
		const dry = world({ SUBSTRATE_SKILLS_GOVERNANCE: "report" });
		await dry.substrate.proposeSkill({ ...request, dry_run: true }, asAgent);
		expect(dry.registry.calls).toEqual([]);
	});

	test("an existing pull request is recorded too, so a retry fills in a write that failed", async () => {
		const w = world({ SUBSTRATE_SKILLS_GOVERNANCE: "report" }, { propose: { status: "existing", pr_url: PR_URL(12), pr_number: 12, branch: BRANCH, content_sha256: HASH, redactions: [] } });
		await w.substrate.proposeSkill(request, asAgent);
		expect(w.registry.rows).toHaveLength(1);
	});

	test("a registry that throws never fails the proposal, warns once per streak, and the next success writes the row", async () => {
		const w = world({ SUBSTRATE_SKILLS_GOVERNANCE: "report" });
		w.registry.failWrites = new Error("connection terminated");
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const first = await w.substrate.proposeSkill(request, asAgent);
			const second = await w.substrate.proposeSkill(request, asAgent);
			expect(first.status).toBe("opened");
			expect(second.status).toBe("opened");
			expect(w.registry.rows).toEqual([]);
			expect(written.filter((line) => line.includes("skills registry write failed"))).toHaveLength(1);
			// The proposal's own event still went out both times.
			expect(w.events.filter((event) => event.payload.action === "skill.propose")).toHaveLength(2);

			w.registry.failWrites = null;
			await w.substrate.proposeSkill(request, asAgent);
			expect(w.registry.rows).toHaveLength(1);
			w.registry.failWrites = new Error("again");
			await w.substrate.proposeSkill({ ...request, name: "other-skill" }, asAgent);
			expect(written.filter((line) => line.includes("skills registry write failed"))).toHaveLength(2);
		} finally {
			process.stderr.write = original;
		}
	});

	test("with no index the proposal is unaffected under report", async () => {
		const w = world({ SUBSTRATE_SKILLS_GOVERNANCE: "report" }, { noIndex: true });
		expect((await w.substrate.proposeSkill(request, asAgent)).status).toBe("opened");
	});
});

describe("skills_list", () => {
	async function seeded() {
		const w = world({ SUBSTRATE_SKILLS_GOVERNANCE: "report" });
		const now = "2026-10-14T12:00:00.000Z";
		const row = (name: string, pr: number, state: SkillRegistryRow["state"]): SkillRegistryRow => ({
			repo: REPO,
			name,
			pr_number: pr,
			content_sha256: HASH,
			state,
			proposed_by: "claude-code",
			pr_url: PR_URL(pr),
			branch: BRANCH,
			merge_sha: state === "approved" || state === "retired" ? MERGE : null,
			decided_by: state === "proposed" ? null : "omp",
			decided_at: state === "proposed" ? null : now,
			reason: null,
			created: now,
			updated: now,
		});
		w.registry.rows.push(
			row("zeta", 3, "approved"),
			row("alpha", 1, "approved"),
			row("beta", 2, "proposed"),
			row("gamma", 4, "declined"),
			row("delta", 5, "retired"),
			{ ...row("elsewhere", 9, "approved"), repo: "someone/else" },
		);
		return w;
	}

	test("the default is the approved rows of this library, sorted by name, in the six-field shape, for any surface", async () => {
		const w = await seeded();
		for (const caller of [asAgent, { surface: "substrate" as Surface, isOperator: false }, { surface: "omp" as Surface, isOperator: true }]) {
			const listed = await w.substrate.listSkills({}, caller);
			expect(listed.governance).toBe("report");
			expect(listed.library).toBe(REPO);
			expect(listed.truncated).toBe(false);
			expect(listed.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
			expect(Object.keys(listed.skills[0] ?? {}).sort()).toEqual(["approved_at", "content_sha256", "merge_sha", "name", "pr_url", "proposed_by"]);
		}
		expect(await w.substrate.listSkills({ state: "approved" }, asAgent)).toMatchObject({ skills: [{ name: "alpha" }, { name: "zeta" }] });
	});

	test("a caller with no surface is 401 even on the default state, with no read of the registry", async () => {
		const w = await seeded();
		w.registry.calls.length = 0;
		for (const state of [undefined, "approved", "all"]) {
			const failure = await error(w.substrate.listSkills(state === undefined ? {} : { state }, { surface: null, isOperator: state === "all" }));
			expect({ state, status: (failure as SkillApprovalDenied).status }).toEqual({ state, status: 401 });
		}
		expect(w.registry.calls).toEqual([]);
	});

	test("the default list is by NAME: one entry per name, its most recent approved row, even when an older row has the higher pull request number", async () => {
		const w = await seeded();
		const later = (name: string, pr: number, decided_at: string, merge: string) =>
			w.registry.rows.push({
				repo: REPO, name, pr_number: pr, content_sha256: HASH, state: "approved", proposed_by: "claude-code", pr_url: PR_URL(pr),
				branch: BRANCH, merge_sha: merge, decided_by: "omp", decided_at, reason: null, created: decided_at, updated: decided_at,
			});
		// alpha already has PR 1 approved at 12:00. PR 30 decided later wins; PR 31 decided at the same instant loses to the higher number only on a tie.
		later("alpha", 30, "2026-10-14T13:00:00.000Z", "a".repeat(40));
		later("alpha", 2, "2026-10-14T14:00:00.000Z", "b".repeat(40));
		later("zeta", 4, "2026-10-14T12:00:00.000Z", "c".repeat(40));
		const listed = await w.substrate.listSkills({}, asAgent);
		expect(listed.skills.map((skill) => [skill.name, skill.merge_sha])).toEqual([
			["alpha", "b".repeat(40)],
			["zeta", "c".repeat(40)],
		]);
		// The operator's `approved` view of rows is the same list; `all` still shows every row.
		const all = await w.substrate.listSkills({ state: "all" }, asOperator);
		expect(all.skills.filter((skill) => skill.name === "alpha")).toHaveLength(3);
	});

	test("every other state is an operator action, and says where each row stands", async () => {
		const w = await seeded();
		for (const state of ["all", "proposed", "declined", "retired"]) {
			const failure = await error(w.substrate.listSkills({ state }, asAgent));
			expect({ state, status: (failure as SkillApprovalDenied).status }).toEqual({ state, status: 403 });
		}
		const all = await w.substrate.listSkills({ state: "all" }, asOperator);
		expect(all.skills.map((skill) => `${skill.name}:${"state" in skill ? skill.state : "?"}`)).toEqual(["alpha:approved", "beta:proposed", "delta:retired", "gamma:declined", "zeta:approved"]);
		const declined = await w.substrate.listSkills({ state: "declined" }, asOperator);
		expect(declined.skills).toMatchObject([{ name: "gamma", state: "declined", pr_number: 4, decided_by: "omp", approved_at: null }]);
	});

	test("an unknown state is a 400, and the registry is returned in every governance mode", async () => {
		const w = await seeded();
		const failure = await error(w.substrate.listSkills({ state: "pending" }, asOperator));
		expect((failure as SkillApprovalRefused).rule).toBe("invalid_state");
		const off = world();
		off.registry.rows.push(...w.registry.rows);
		const listed = await off.substrate.listSkills({}, asAgent);
		expect(listed.governance).toBe("off");
		expect(listed.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
	});

	test("the list names the configured library and shows only that library's rows", async () => {
		const w = await seeded();
		const other = world({ SUBSTRATE_SKILLS_REPO: "rehearsal/agent-skills", SUBSTRATE_SKILLS_REMOTE_URL: "file:///tmp/rehearsal/agent-skills.git", SUBSTRATE_SKILLS_GH: "/run/fake-gh" });
		other.registry.rows.push(...w.registry.rows);
		const listed = await other.substrate.listSkills({}, asAgent);
		expect(listed.library).toBe("rehearsal/agent-skills");
		// Every seeded row belongs to the default library, so none is this library's.
		expect(listed.skills).toEqual([]);
		// A slug, never a URL: nothing with userinfo or a scheme.
		expect(listed.library).not.toMatch(/[:@]/);
	});

	test("more than LIST_MAX rows is cut at LIST_MAX and says so", async () => {
		const w = world();
		for (let i = 0; i < LIST_MAX + 1; i++) {
			w.registry.rows.push({
				repo: REPO,
				name: `skill-${String(i).padStart(4, "0")}`,
				pr_number: i + 1,
				content_sha256: HASH,
				state: "approved",
				proposed_by: null,
				pr_url: null,
				branch: null,
				merge_sha: MERGE,
				decided_by: "omp",
				decided_at: "2026-10-14T12:00:00.000Z",
				reason: null,
				created: "2026-10-14T12:00:00.000Z",
				updated: "2026-10-14T12:00:00.000Z",
			});
		}
		const listed = await w.substrate.listSkills({}, asAgent);
		expect(listed.skills).toHaveLength(LIST_MAX);
		expect(listed.truncated).toBe(true);
		expect(listed.skills.at(-1)?.name).toBe(`skill-${String(LIST_MAX - 1).padStart(4, "0")}`);
		w.registry.rows.pop();
		expect((await w.substrate.listSkills({}, asAgent)).truncated).toBe(false);
	});

	test("an unreadable or unconfigured registry is 503, never an empty list an enforcing reader would trust", async () => {
		const w = await seeded();
		w.registry.failReads = new Error("connection terminated");
		const failure = await error(w.substrate.listSkills({}, asAgent));
		expect((failure as SkillApprovalFailed).status).toBe(503);
		const bare = world({}, { noIndex: true });
		expect(((await error(bare.substrate.listSkills({}, asAgent))) as SkillApprovalFailed).status).toBe(503);
	});
});

describe("SUBSTRATE_SKILLS_GOVERNANCE", () => {
	test("defaults to off, accepts the three modes case-insensitively, and never throws on a typo", () => {
		expect(loadConfig({}).skillsGovernance).toBe("off");
		expect(loadConfig({ SUBSTRATE_SKILLS_GOVERNANCE: " Report " }).skillsGovernance).toBe("report");
		expect(loadConfig({ SUBSTRATE_SKILLS_GOVERNANCE: "ENFORCE" }).skillsGovernance).toBe("enforce");
		const typo = loadConfig({ SUBSTRATE_SKILLS_GOVERNANCE: "enfroce" });
		// A typo must never filter what agents receive.
		expect(typo.skillsGovernance).toBe("off");
		expect(skillsGovernanceConfigWarnings(typo).join("\n")).toContain("enfroce");
		expect(skillsGovernanceConfigWarnings(loadConfig({ SUBSTRATE_SKILLS_GOVERNANCE: "report" }))).toEqual([]);
		expect(skillsGovernanceConfigWarnings(loadConfig({}))).toEqual([]);
	});
});

describe("the MCP doors", () => {
	async function connect(w: World, caller: { surface: Surface | null; isOperator: boolean }) {
		const server = createMcpServer(w.substrate, caller);
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client;
	}
	async function call(client: Client, name: string, args: Record<string, unknown>) {
		const result = await client.callTool({ name, arguments: args });
		const content = result.content as Array<{ type: string; text?: string }>;
		const text = content[0]?.text ?? "";
		return { isError: result.isError === true, json: () => JSON.parse(text) as Record<string, unknown> };
	}

	test("an operator approves and lists; the list tool is read-only, the approve tool is not", async () => {
		const w = world();
		const client = await connect(w, asOperator);
		const tools = (await client.listTools()).tools;
		expect(tools.find((tool) => tool.name === "skills_list")?.annotations?.readOnlyHint).toBe(true);
		expect(tools.find((tool) => tool.name === "skills_approve")?.annotations?.readOnlyHint).not.toBe(true);

		const approved = await call(client, "skills_approve", approve);
		expect(approved.isError).toBe(false);
		expect(approved.json()).toMatchObject({ status: "approved", merge_sha: MERGE });
		const listed = await call(client, "skills_list", {});
		expect(listed.json()).toMatchObject({ governance: "off", library: REPO, skills: [{ name: "demo-skill", merge_sha: MERGE }], truncated: false });
	});

	test("a non-operator is refused with no gh call, and may still read the approved list but not other states", async () => {
		const w = world();
		const client = await connect(w, asAgent);
		const refused = await call(client, "skills_approve", approve);
		expect(refused.isError).toBe(true);
		expect(String(refused.json().error)).toContain("operator token");
		expect(w.gh).toEqual([]);
		expect((await call(client, "skills_list", {})).isError).toBe(false);
		expect((await call(client, "skills_list", { state: "all" })).isError).toBe(true);
	});

	test("a caller with no surface is refused by both tools, with no read and no gh call", async () => {
		const w = world();
		const client = await connect(w, { surface: null, isOperator: false });
		const listed = await call(client, "skills_list", {});
		expect(listed.isError).toBe(true);
		expect(String(listed.json().error)).toContain("authenticated surface");
		expect((await call(client, "skills_approve", approve)).isError).toBe(true);
		expect(w.registry.calls).toEqual([]);
		expect(w.gh).toEqual([]);
	});

	test("a refusal carries its rule, and a gh failure its 502 message", async () => {
		const w = world();
		const client = await connect(w, asOperator);
		const bad = await call(client, "skills_approve", { ...approve, decision: "merge" });
		expect(bad.isError).toBe(true);
		expect(bad.json()).toMatchObject({ rule: "invalid_decision" });
		w.answer(12, { code: 1, stderr: "boom" });
		const failed = await call(client, "skills_approve", approve);
		expect(failed.isError).toBe(true);
		expect(String(failed.json().error)).toContain("gh pr view exited 1");
	});
});

describe("the REST doors", () => {
	const TOKENS = {
		SUBSTRATE_TOKEN_CLAUDE_CODE: "tok-agent",
		SUBSTRATE_TOKEN_SUBSTRATE: "tok-substrate",
		SUBSTRATE_TOKEN_OMP: "tok-operator",
		SUBSTRATE_OPERATOR_TOKENS: "tok-operator",
	};
	const running: Array<{ close(): void }> = [];
	afterAll(() => {
		for (const harness of running) harness.close();
	});

	async function start(w: World, env: Record<string, string | undefined> = TOKENS): Promise<{ base: string; observability: Observability }> {
		const config = loadConfig({ ...env });
		const observability = createObservability(config, env);
		await observability.start();
		// The service the doors serve is the world's own stores under this config.
		const substrate = new Substrate(
			config,
			{ index: w.registry as never, greptime: { ensureAppendMode: async () => true, lastHash: async () => null, insertEvent: async (event: SubstrateEvent) => void w.events.push(event) } as never, skillRun: async (argv) => {
				w.gh.push([...argv]);
				return { code: 0, stdout: ghView(), stderr: "" };
			} },
			observability.observer,
		);
		const server = createHttpServer(substrate, config, observability);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		running.push({
			close() {
				observability.stop();
				server.close();
			},
		});
		return { base: `http://127.0.0.1:${port}`, observability };
	}

	async function post(base: string, token: string | null, payload: unknown) {
		const response = await fetch(`${base}/skills/approve`, {
			method: "POST",
			headers: token === null ? {} : { authorization: `Bearer ${token}` },
			body: typeof payload === "string" ? payload : JSON.stringify(payload),
		});
		return { status: response.status, json: (await response.json()) as Record<string, unknown> };
	}
	async function get(base: string, token: string | null, query = "") {
		const response = await fetch(`${base}/skills${query}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
		return { status: response.status, json: (await response.json()) as Record<string, unknown> };
	}

	test("an anonymous caller is 401 before the body is read, and an unknown bearer is 401", async () => {
		const w = world();
		const bare = await start(w, {});
		// Over the cap on purpose: a refusal that read the body first would answer 413.
		expect((await post(bare.base, null, "x".repeat(1_000_001))).status).toBe(401);
		const tokened = await start(w);
		expect((await post(tokened.base, "tok-nobody", approve)).status).toBe(401);
		expect(w.gh).toEqual([]);
	});

	test("a non-operator, the substrate surface included, is 403 and nothing runs", async () => {
		const w = world();
		const { base } = await start(w);
		for (const token of ["tok-agent", "tok-substrate"]) {
			const reply = await post(base, token, approve);
			expect({ token, status: reply.status }).toEqual({ token, status: 403 });
			expect(String(reply.json.error)).toContain("operator token");
		}
		// A malformed body from a non-operator is still the authority answer.
		expect((await post(base, "tok-agent", { name: 1 })).status).toBe(403);
		expect(w.gh).toEqual([]);
		expect(w.registry.calls).toEqual([]);
	});

	test("a non-operator is 403 before the body is read, parsed or audited: oversize, invalid JSON and an audit outage change nothing", async () => {
		const w = world();
		const directory = mkdtempSync(join(tmpdir(), "substrate-skills-"));
		writeFileSync(join(directory, "not-a-directory"), "");
		const env = {
			SUBSTRATE_AUDIT_PATH: join(directory, "not-a-directory", "audit.jsonl"),
			...TOKENS,
			SUBSTRATE_TOKEN_SWARM_A05_BE: "tok-swarm",
			// A swarm token listed as an operator is still no operator.
			SUBSTRATE_OPERATOR_TOKENS: "tok-operator,tok-swarm",
		};
		const { base, observability } = await start(w, env);
		for (const token of ["tok-agent", "tok-substrate", "tok-swarm"]) {
			for (const payload of ["x".repeat(1_000_001), "{not json", approve]) {
				const reply = await post(base, token, payload);
				expect({ token, size: typeof payload === "string" ? payload.length : 0, status: reply.status }).toEqual({ token, size: typeof payload === "string" ? payload.length : 0, status: 403 });
				expect(String(reply.json.error)).toContain("operator token");
			}
		}
		expect(observability.audit.recent()).toEqual([]);
		expect(w.gh).toEqual([]);
		expect(w.registry.calls).toEqual([]);
	});

	test("an operator's oversize body is 413 and invalid JSON is 400, still before any gh call", async () => {
		const w = world();
		const { base } = await start(w);
		expect((await post(base, "tok-operator", "x".repeat(1_000_001))).status).toBe(413);
		expect((await post(base, "tok-operator", "{not json")).status).toBe(400);
		expect(w.gh).toEqual([]);
	});

	test("an operator approves: 200, the row, and the same call again is exists", async () => {
		const w = world();
		const { base } = await start(w);
		const first = await post(base, "tok-operator", approve);
		expect(first.status).toBe(200);
		expect(first.json).toMatchObject({ status: "approved", merge_sha: MERGE });
		const again = await post(base, "tok-operator", approve);
		expect(again.json).toMatchObject({ status: "exists" });
		expect(w.registry.rows).toHaveLength(1);
		expect(w.events.filter((event) => event.payload.action === "skill.approve")).toHaveLength(1);
	});

	test("a malformed body is 400 for an operator, and a refusal answers 400 or 409 with its rule", async () => {
		const w = world();
		const { base } = await start(w);
		expect((await post(base, "tok-operator", { name: "demo-skill" })).status).toBe(400);
		expect((await post(base, "tok-operator", "not json")).status).toBe(400);
		const refused = await post(base, "tok-operator", { ...approve, decision: "merge" });
		expect(refused).toMatchObject({ status: 400, json: { rule: "invalid_decision" } });
		expect(w.gh).toEqual([]);
	});

	test("it is audited as skills_approve, fail-closed: an unwritable chain is 503 with no gh call and no row", async () => {
		const w = world();
		const directory = mkdtempSync(join(tmpdir(), "substrate-skills-"));
		writeFileSync(join(directory, "not-a-directory"), "");
		const broken = await start(w, { SUBSTRATE_AUDIT_PATH: join(directory, "not-a-directory", "audit.jsonl"), ...TOKENS });
		expect((await post(broken.base, "tok-operator", approve)).status).toBe(503);
		expect(w.gh).toEqual([]);
		expect(w.registry.rows).toEqual([]);

		const healthy = await start(w, { SUBSTRATE_AUDIT_PATH: join(mkdtempSync(join(tmpdir(), "substrate-skills-")), "audit.jsonl"), ...TOKENS });
		await post(healthy.base, "tok-operator", approve);
		const record = healthy.observability.audit.recent()[0];
		expect(record).toMatchObject({ tool: "skills_approve", transport: "rest", decision: "allowed", surface: "omp" });
	});

	test("GET /skills answers the contract the projector reads, for the substrate token, and the audit never blocks it", async () => {
		const w = world({ SUBSTRATE_SKILLS_GOVERNANCE: "report" });
		const now = "2026-10-14T12:00:00.000Z";
		w.registry.rows.push({
			repo: REPO,
			name: "demo-skill",
			pr_number: 12,
			content_sha256: HASH,
			state: "approved",
			proposed_by: "claude-code",
			pr_url: PR_URL(12),
			branch: BRANCH,
			merge_sha: MERGE,
			decided_by: "omp",
			decided_at: now,
			reason: null,
			created: now,
			updated: now,
		});
		const directory = mkdtempSync(join(tmpdir(), "substrate-skills-"));
		writeFileSync(join(directory, "not-a-directory"), "");
		const { base } = await start(w, { SUBSTRATE_AUDIT_PATH: join(directory, "not-a-directory", "audit.jsonl"), SUBSTRATE_SKILLS_GOVERNANCE: "report", ...TOKENS });
		const reply = await get(base, "tok-substrate", "?state=approved");
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({
			governance: "report",
			library: REPO,
			skills: [{ name: "demo-skill", content_sha256: HASH, merge_sha: MERGE, pr_url: PR_URL(12), approved_at: now, proposed_by: "claude-code" }],
			truncated: false,
		});
		expect((await get(base, "tok-agent")).status).toBe(200);
	});

	test("GET /skills needs a token, other states need an operator, and an unknown state is 400", async () => {
		const w = world();
		const { base } = await start(w);
		expect((await get(base, null)).status).toBe(401);
		expect((await get(base, "tok-agent", "?state=all")).status).toBe(403);
		expect((await get(base, "tok-operator", "?state=all")).status).toBe(200);
		expect((await get(base, "tok-operator", "?state=bogus")).status).toBe(400);
	});

	test("GET /skills is 401 for a caller with no surface even on a run that accepts untokened callers, before the read", async () => {
		const w = world();
		const bare = await start(w, {});
		const reply = await get(bare.base, null);
		expect(reply.status).toBe(401);
		expect(String(reply.json.error)).toContain("authenticated surface");
		const bridge = await start(w, { SUBSTRATE_ALLOW_ANONYMOUS: "1", ...TOKENS });
		expect((await get(bridge.base, null)).status).toBe(401);
		expect(w.registry.calls).toEqual([]);
	});
});
