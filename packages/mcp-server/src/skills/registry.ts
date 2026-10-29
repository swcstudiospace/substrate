// The skills governance registry's rules (uplift-5 S5a): what a registry row may become, how an
// operator's decision is checked against GitHub, and how each way a decision can fail maps onto a
// status and a body. Pure apart from the injected Runner: no store, no process, no config.
//
// What "approved" means here. The owner's merge on the skills library is still the publication
// gate; the registry records WHICH merged pull request an operator accepted, as which skill, by
// whom, with the merge commit. Nothing in this module (or in `skills_approve`) installs, links,
// unlinks or deletes a skill: state only. `SUBSTRATE_SKILLS_GOVERNANCE=enforce` is what lets a
// reader (the projector) filter on the approved rows; this module does not enforce anything.
//
// One row per (library repo, skill name, pull request number). A pull request is one content and
// one merge, so an approved name whose later merged content differs arrives through a different
// pull request and is a NEW row beside the first, never a silent replace of it. The row's
// `content_sha256` is the proposal hash `skills_propose` computed ('' when the pull request was
// not proposed through this substrate or the registry was off at the time).
//
// Decisions act on ONE row, but a reader sees NAMES: `skills_list` answers at most one entry per
// name (its most recent approved row: latest decided_at, then highest pull request number), and the
// projector builds a name set from it. So a name stays approved while ANY of its rows is approved;
// declining a later proposal never touches an earlier approval; to withdraw a name, retire every
// approved row (the decision's answer says how many remain: `remaining_approved_for_name`).
//
// State machine (never DELETE; retiring is a state):
//
//   (none) | proposed --approve--> approved --retire--> retired
//   (none) | proposed --decline--> declined
//
// Re-asking for the state a row already has is `exists` (idempotent, no event). Every other move is
// refused: declined and retired are terminal (a reopened, re-merged pull request does not
// resurrect them; the operator proposes again, which is a new pull request).
//
// Why each refusal exists, in the order the service applies them:
//   - not authenticated / not an operator: the merge check spends the owner's GitHub credential
//     and the row becomes what a reader trusts. Swarm surfaces and the `substrate` host-job
//     surface are never operators.
//   - invalid_*: the arguments are not the shape the table and the gh argv can carry.
//   - pr_not_for_skill: the pull request is neither a branch this substrate opened for that name nor
//     one that changes that skill's own `<name>/SKILL.md`, so approving it would attach a merge
//     commit to a name it never touched.
//   - pr_wrong_repo / pr_wrong_base: the pull request is not on the configured library, or was not
//     merged into the library's default branch (a stacked pull request's merge commit never
//     reached `main`, so approving it would approve something nobody receives).
//   - pr_open / pr_not_merged / pr_merged / no_merge_commit: the decision contradicts GitHub.
//   - bad_transition / no_approved_row: the registry state machine above.

import { redact } from "../redact.ts";
import { LIBRARY_BASE, SKILL_NAME_RE, type Runner } from "./propose.ts";

export const SKILL_STATES = ["proposed", "approved", "declined", "retired"] as const;
export type SkillState = (typeof SKILL_STATES)[number];

export const SKILL_DECISIONS = ["approve", "decline", "retire"] as const;
export type SkillDecision = (typeof SKILL_DECISIONS)[number];

/** The `skills_list` filter: one state, or every row. */
export const SKILL_LIST_STATES = ["all", ...SKILL_STATES] as const;
export type SkillListState = (typeof SKILL_LIST_STATES)[number];

export const REASON_MAX = 500;
/** `skills_list` never answers with more rows than this; a longer registry sets `truncated`. */
export const LIST_MAX = 500;
/** The int column's ceiling: a PR number past it cannot be stored. */
const PR_NUMBER_MAX = 2_147_483_647;

/**
 * The closed vocabulary a refused attempt is recorded under. These names (never free text) are the
 * whole of a `skill.approve.refused` event's `rule`.
 */
export const APPROVAL_RULES = [
	"invalid_decision",
	"invalid_name",
	"invalid_pr_number",
	"invalid_reason",
	"invalid_state",
	"pr_wrong_repo",
	"pr_wrong_base",
	"pr_not_for_skill",
	"pr_open",
	"pr_not_merged",
	"pr_merged",
	"no_merge_commit",
	"no_approved_row",
	"bad_transition",
] as const;
export type ApprovalRule = (typeof APPROVAL_RULES)[number];

const RULE_STATUS: Readonly<Record<ApprovalRule, 400 | 409>> = {
	invalid_decision: 400,
	invalid_name: 400,
	invalid_pr_number: 400,
	invalid_reason: 400,
	invalid_state: 400,
	pr_wrong_repo: 409,
	pr_wrong_base: 409,
	pr_not_for_skill: 400,
	pr_open: 409,
	pr_not_merged: 409,
	pr_merged: 409,
	no_merge_commit: 409,
	no_approved_row: 409,
	bad_transition: 409,
};

/** One registry row as the store returns it. Timestamps are ISO strings. */
export interface SkillRegistryRow {
	repo: string;
	name: string;
	pr_number: number;
	content_sha256: string;
	state: SkillState;
	proposed_by: string | null;
	pr_url: string | null;
	branch: string | null;
	merge_sha: string | null;
	decided_by: string | null;
	decided_at: string | null;
	reason: string | null;
	/** Monotonic per (repo, name): the proposal that created the row took the name's next version. */
	version: number;
	created: string;
	updated: string;
}

/**
 * What the store answers an operator decision with: the row it applied or found, or the state
 * machine's refusal. `remaining_approved` is how many approved rows the name has AFTER the
 * decision, counted in the same transaction.
 */
export type SkillDecisionResult =
	| { outcome: "applied" | "exists"; row: SkillRegistryRow; remaining_approved: number }
	| { outcome: "refused"; rule: "bad_transition" | "no_approved_row"; row: SkillRegistryRow | null };

/**
 * What `skills_approve` answers: `exists` when the row already stood in the asked-for state (nothing changed,
 * nothing emitted). `remaining_approved_for_name` is how many approved rows the NAME has after the decision: a
 * name stays approved (`skills_list` still returns it) while any of its rows is approved, so a retire or a
 * decline that leaves this above 0 did not withdraw the name. `noted` is whether the decision's event was stored
 * in the ledger; absent for `exists`, which emits nothing.
 */
export interface SkillApprovalResult {
	status: "approved" | "declined" | "retired" | "exists";
	state: SkillState;
	name: string;
	pr_number: number;
	pr_url: string | null;
	merge_sha: string | null;
	content_sha256: string;
	remaining_approved_for_name: number;
	noted?: boolean;
}

/**
 * What `skills_list` answers. `governance` is the running `SUBSTRATE_SKILLS_GOVERNANCE`, so a reader knows whether an
 * empty list means "nothing approved" or "nobody has populated the registry". `library` is the configured skills
 * library's `owner/repo` slug (what the rows are about; never a URL or a credential), so a reader that caches the
 * answer can bind the cache to the library as well as to the server it came from.
 */
export interface SkillListResult {
	governance: "off" | "report" | "enforce";
	library: string;
	skills: Array<ApprovedSkillEntry | SkillEntry>;
	truncated: boolean;
}

// ── errors ──────────────────────────────────────────────────────────────────

/** Why `skills_approve` or a non-default `skills_list` would not act for this caller: 401 no surface, 403 not an operator. Nothing reached gh or the store. */
export class SkillApprovalDenied extends Error {
	constructor(
		readonly status: 401 | 403,
		message: string,
	) {
		super(message);
		this.name = "SkillApprovalDenied";
	}
}

/** A rule refused the attempt before any row changed. `rule` is from {@link APPROVAL_RULES}. */
export class SkillApprovalRefused extends Error {
	constructor(
		readonly rule: ApprovalRule,
		message: string,
	) {
		super(message);
		this.name = "SkillApprovalRefused";
	}
	get status(): 400 | 409 {
		return RULE_STATUS[this.rule];
	}
}

/** A gh step or the registry store failed: 502 for gh (or the library config), 503 for the registry. No row changed. */
export class SkillApprovalFailed extends Error {
	constructor(
		readonly status: 502 | 503,
		message: string,
	) {
		super(message);
		this.name = "SkillApprovalFailed";
	}
}

/** What a failed approval or list answers with: the route's status and JSON body, and the tool's refusal payload. */
export interface ApprovalFailure {
	status: 400 | 401 | 403 | 409 | 502 | 503;
	body: { error: string; rule?: ApprovalRule };
}

const FAILURE_MESSAGE_MAX = 400;

/** How a failure reaches the caller, or null for an error that is not the approval's own (the caller rethrows it). */
export function approvalFailure(cause: unknown): ApprovalFailure | null {
	if (cause instanceof SkillApprovalDenied) return { status: cause.status, body: { error: cause.message } };
	if (cause instanceof SkillApprovalRefused) return { status: cause.status, body: { error: cause.message, rule: cause.rule } };
	if (cause instanceof SkillApprovalFailed) {
		return { status: cause.status, body: { error: redact(cause.message).slice(0, FAILURE_MESSAGE_MAX) } };
	}
	return null;
}

// ── the request ─────────────────────────────────────────────────────────────

export interface SkillApprovalRequest {
	name: string;
	pr_number: number;
	decision: string;
	reason?: string | undefined;
}

/** A request whose values passed {@link validateApproval}. */
export interface ValidApproval {
	name: string;
	pr_number: number;
	decision: SkillDecision;
	/** Redacted and capped; null when none was given. */
	reason: string | null;
}

/** The REST body's shape, as a message for a 400, or null when it is well formed. Values are the service's to judge. */
export function approvalBodyProblem(body: unknown): string | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
	const b = body as Record<string, unknown>;
	if (typeof b.name !== "string") return "name must be a string";
	if (typeof b.pr_number !== "number") return "pr_number must be a number";
	if (typeof b.decision !== "string") return "decision must be a string";
	if (b.reason !== undefined && typeof b.reason !== "string") return "reason must be a string";
	return null;
}

/** The request `Substrate.approveSkill` takes, from a body `approvalBodyProblem` accepted. */
export function toApprovalRequest(body: Record<string, unknown>): SkillApprovalRequest {
	return {
		name: body.name as string,
		pr_number: body.pr_number as number,
		decision: body.decision as string,
		...(body.reason !== undefined ? { reason: body.reason as string } : {}),
	};
}

/** Every value check in one place. Throws {@link SkillApprovalRefused}; `name` is echoed back only when it was a valid one. */
export function validateApproval(request: SkillApprovalRequest): ValidApproval {
	if (!(SKILL_DECISIONS as readonly string[]).includes(request.decision)) {
		throw new SkillApprovalRefused("invalid_decision", "decision must be approve, decline or retire; nothing was changed");
	}
	if (typeof request.name !== "string" || !SKILL_NAME_RE.test(request.name)) {
		throw new SkillApprovalRefused("invalid_name", "name must be lowercase letters, digits and hyphens (at most 64, starting with a letter or digit); nothing was changed");
	}
	if (!Number.isInteger(request.pr_number) || request.pr_number < 1 || request.pr_number > PR_NUMBER_MAX) {
		throw new SkillApprovalRefused("invalid_pr_number", "pr_number must be a positive integer; nothing was changed");
	}
	if (request.reason !== undefined && (typeof request.reason !== "string" || request.reason.length > REASON_MAX)) {
		throw new SkillApprovalRefused("invalid_reason", `reason must be a string of at most ${String(REASON_MAX)} characters; nothing was changed`);
	}
	const reason = request.reason === undefined || request.reason.trim() === "" ? null : redact(request.reason).slice(0, REASON_MAX);
	return { name: request.name, pr_number: request.pr_number, decision: request.decision as SkillDecision, reason };
}

// ── the state machine ───────────────────────────────────────────────────────

export type Transition =
	| { kind: "apply"; to: SkillState }
	| { kind: "exists" }
	| { kind: "refuse"; rule: "bad_transition" | "no_approved_row" };

const TARGET: Readonly<Record<SkillDecision, SkillState>> = { approve: "approved", decline: "declined", retire: "retired" };

/**
 * What `decision` does to a row in `current` (null: no row yet). `mergeSha` is the merge commit the
 * decision is about (approve only): re-approving the same merge is `exists`, a different one is
 * refused, because one pull request merges once and a row that says otherwise is not what the
 * operator is looking at.
 */
export function transition(
	current: { state: SkillState; merge_sha: string | null } | null,
	decision: SkillDecision,
	mergeSha: string | null,
): Transition {
	const to = TARGET[decision];
	const from = current?.state ?? null;
	if (from === to) {
		if (decision === "approve" && current?.merge_sha !== mergeSha) return { kind: "refuse", rule: "bad_transition" };
		return { kind: "exists" };
	}
	if (decision === "retire") return from === "approved" ? { kind: "apply", to } : { kind: "refuse", rule: "no_approved_row" };
	if (from === null || from === "proposed") return { kind: "apply", to };
	return { kind: "refuse", rule: "bad_transition" };
}

// ── gh ──────────────────────────────────────────────────────────────────────

/** Not prViewArgv: that one is pinned and takes the PR's URL; this one asks by number on the configured library. */
export function prApprovalViewArgv(repo: string, prNumber: number): string[] {
	return ["gh", "pr", "view", String(prNumber), "--repo", repo, "--json", "state,mergeCommit,url,headRefName,baseRefName,files"];
}

export type PrState = "OPEN" | "CLOSED" | "MERGED";

/** The parts of `gh pr view` a decision reads. */
export interface PrView {
	state: PrState;
	url: string;
	head_ref: string;
	/** The branch the pull request targets; a decision needs {@link LIBRARY_BASE}. */
	base_ref: string;
	/** The merge commit's oid; null while the pull request is not merged. */
	merge_sha: string | null;
	/** Paths of the changed files, as gh lists them: at most {@link GH_FILES_LIMIT}. */
	files: string[];
}

const MERGE_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** How many changed files `gh pr view --json files` returns at most (GitHub's GraphQL page). A longer list is cut, silently. */
export const GH_FILES_LIMIT = 100;

/**
 * Ask gh about one pull request. A non-zero exit, output that is not JSON, or a reply missing a
 * field the decision reads is a failed step (502): the registry must never learn from a guess.
 */
export async function fetchPrView(run: Runner, repo: string, prNumber: number): Promise<PrView> {
	const result = await run(prApprovalViewArgv(repo, prNumber));
	if (result.code !== 0) {
		const tail = redact(`${result.stdout}${result.stderr}`.trim()).slice(-FAILURE_MESSAGE_MAX);
		throw new SkillApprovalFailed(502, `gh pr view exited ${String(result.code)}: ${tail}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new SkillApprovalFailed(502, "gh pr view did not answer JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new SkillApprovalFailed(502, "gh pr view did not answer a JSON object");
	}
	const state: unknown = Reflect.get(parsed, "state");
	const url: unknown = Reflect.get(parsed, "url");
	const headRef: unknown = Reflect.get(parsed, "headRefName");
	const baseRef: unknown = Reflect.get(parsed, "baseRefName");
	const mergeCommit: unknown = Reflect.get(parsed, "mergeCommit");
	const filesValue: unknown = Reflect.get(parsed, "files");
	if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
		throw new SkillApprovalFailed(502, "gh pr view answered no usable state");
	}
	if (typeof url !== "string" || typeof headRef !== "string") {
		throw new SkillApprovalFailed(502, "gh pr view answered no url or headRefName");
	}
	if (typeof baseRef !== "string" || baseRef === "") {
		throw new SkillApprovalFailed(502, "gh pr view answered no baseRefName");
	}
	let mergeSha: string | null = null;
	if (mergeCommit !== null && mergeCommit !== undefined) {
		const oid: unknown = typeof mergeCommit === "object" ? Reflect.get(mergeCommit, "oid") : undefined;
		if (typeof oid !== "string" || !MERGE_OID_RE.test(oid)) {
			throw new SkillApprovalFailed(502, "gh pr view answered a mergeCommit without a usable oid");
		}
		mergeSha = oid.toLowerCase();
	}
	// `files` is [{path, additions, deletions}]: every entry must carry a string path, or the answer is not one we can bind a pull request with.
	if (!Array.isArray(filesValue)) throw new SkillApprovalFailed(502, "gh pr view answered no files list");
	const files: string[] = [];
	for (const entry of filesValue) {
		const path: unknown = entry !== null && typeof entry === "object" ? Reflect.get(entry, "path") : undefined;
		if (typeof path !== "string") throw new SkillApprovalFailed(502, "gh pr view answered a file without a path");
		files.push(path);
	}
	return { state, url, head_ref: headRef, base_ref: baseRef, merge_sha: mergeSha, files };
}

/** True when `url` is exactly pull request `prNumber` of `repo` on github.com (case-insensitive slug). */
export function prUrlMatches(url: string, repo: string, prNumber: number): boolean {
	return url.toLowerCase() === `https://github.com/${repo}/pull/${String(prNumber)}`.toLowerCase();
}

/**
 * The surface a proposal branch was opened as when `headRef` is one this substrate opened for
 * `name` (`skill/<surface>/<name>-<UTC yyyymmddThhmmssmmmZ>-<4 hex>`, propose.ts `branchName`);
 * null for any other branch. The name is anchored on both sides, so `foo` never matches `foo-bar`.
 */
export function proposalBranchSurface(headRef: string, name: string): string | null {
	const match = /^skill\/([a-z0-9-]+)\/([a-z0-9][a-z0-9-]{0,63})-\d{8}T\d{9}Z-[0-9a-f]{4}$/.exec(headRef);
	if (match === null || match[2] !== name) return null;
	return match[1] as string;
}

/**
 * Whether a pull request is about skill `name`: EITHER (a) its head branch is one this substrate
 * opened for that name, OR (b) its changed files include exactly the library layout's
 * `<name>/SKILL.md` (a skill is the directory `<name>/` at the library root holding `SKILL.md`, as
 * `writeTree` in propose.ts writes it and `libraryNames` in the projector reads it). (b) is what
 * lets a skill merged through a hand-opened pull request be approved. It is an exact path match,
 * never a prefix or `includes`, so `demo` is not `demo-skill`; `name` must pass the skill-name rule
 * (no `/`, no `..`) or nothing binds. `gh pr view` lists at most `GH_FILES_LIMIT` files: a longer
 * pull request whose `SKILL.md` fell past the cut is not bound (fail safe), never guessed.
 */
export function prBindsToSkill(name: string, view: Pick<PrView, "head_ref" | "files">): boolean {
	if (!SKILL_NAME_RE.test(name)) return false;
	if (proposalBranchSurface(view.head_ref, name) !== null) return true;
	return view.files.includes(`${name}/SKILL.md`);
}

/** The decision-specific checks of a pull request against GitHub's answer. Returns the refusing rule, or null when the decision may proceed. */
export function prRefusal(decision: Exclude<SkillDecision, "retire">, name: string, repo: string, prNumber: number, view: PrView): ApprovalRule | null {
	if (!prUrlMatches(view.url, repo, prNumber)) return "pr_wrong_repo";
	if (view.base_ref !== LIBRARY_BASE) return "pr_wrong_base";
	if (!prBindsToSkill(name, view)) return "pr_not_for_skill";
	if (decision === "approve") {
		if (view.state === "OPEN") return "pr_open";
		if (view.state === "CLOSED") return "pr_not_merged";
		return view.merge_sha === null ? "no_merge_commit" : null;
	}
	if (view.state === "OPEN") return "pr_open";
	if (view.state === "MERGED") return "pr_merged";
	return null;
}

/** The refusal message for a rule: it names the rule's meaning, never a value from the request. */
export function refusalMessage(rule: ApprovalRule): string {
	switch (rule) {
		case "pr_wrong_repo":
			return "that pull request is not on the configured skills library; nothing was changed";
		case "pr_wrong_base":
			return "that pull request does not target the library's default branch, so its merge never reached what agents receive; nothing was changed";
		case "pr_not_for_skill":
			return "that pull request is neither a proposal branch for that skill name nor one that changes that skill's SKILL.md (gh lists at most 100 changed files); nothing was changed";
		case "pr_open":
			return "that pull request is still open; the owner's merge or close comes first; nothing was changed";
		case "pr_not_merged":
			return "approve needs a merged pull request, and that one was closed without merging; nothing was changed";
		case "pr_merged":
			return "decline needs a pull request closed without merging, and that one was merged; nothing was changed";
		case "no_merge_commit":
			return "that pull request is merged but GitHub reported no merge commit; nothing was changed";
		case "no_approved_row":
			return "retire needs an approved row for that skill and pull request; nothing was changed";
		case "bad_transition":
			return "the registry row is already decided in a way that does not allow that; declined and retired are final; nothing was changed";
		default:
			return "refused; nothing was changed";
	}
}

// ── what `skills_list` answers ──────────────────────────────────────────────

/** The default entry: what a reader needs to project one approved skill. */
export interface ApprovedSkillEntry {
	name: string;
	content_sha256: string;
	merge_sha: string | null;
	pr_url: string | null;
	approved_at: string | null;
	proposed_by: string | null;
}

/** An entry of a non-default `state` query: the approved shape plus where the row stands. */
export interface SkillEntry extends ApprovedSkillEntry {
	state: SkillState;
	pr_number: number;
	decided_by: string | null;
	decided_at: string | null;
	reason: string | null;
}

export function toListEntry(row: SkillRegistryRow, extended: boolean): ApprovedSkillEntry | SkillEntry {
	const base: ApprovedSkillEntry = {
		name: row.name,
		content_sha256: row.content_sha256,
		merge_sha: row.merge_sha,
		pr_url: row.pr_url,
		approved_at: row.state === "approved" ? row.decided_at : null,
		proposed_by: row.proposed_by,
	};
	if (!extended) return base;
	return { ...base, state: row.state, pr_number: row.pr_number, decided_by: row.decided_by, decided_at: row.decided_at, reason: row.reason };
}
