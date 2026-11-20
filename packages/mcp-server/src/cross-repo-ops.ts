/**
 * Phase 74: a cross-repository operation whose per-repository steps are durable, and whose partial failure is compensated or
 * parked, never reported as success.
 *
 * The operation is a branch fan-out: the same branch is created at a named base in each of two to
 * {@link CROSS_REPO_MAX_REPOS} registered repositories. Each repository is one step, and the steps run in request order.
 *
 * - Durable before effect. A step moves `pending` to `applying` in the store before its git call, and `applied` or `failed` or
 *   `parked` after it. Undo moves `applied` to `compensating` first. A crash between an effect and its record therefore leaves
 *   `applying` (or `compensating`) behind, and the retry inspects the ref instead of guessing.
 * - Outcome from the ref, not the exit code. After every effect the step reads `refs/heads/<branch>` back. A ref at the planned
 *   sha is an applied step, whatever the exit code said. This is what makes a retry adopt a crashed create instead of repeating it.
 * - Create-only. The create is `update-ref <ref> <planned> <zero>`, which fails when the ref exists, so a branch the operation
 *   did not write is never overwritten.
 * - Compare-and-delete. The undo is `update-ref -d <ref> <planned>`, which deletes only the value the operation wrote, and only a
 *   ref it created. A ref that moved since is parked as `ref-moved` and left alone; an adopted ref is parked and never deleted.
 * - One driver per key. A run holds its key's lock, so two drivers of one operation in this process never interleave: the
 *   second waits, then reads what the first left. A step found `applying` is then from a dead process, never a live driver.
 * - Explicit statuses. `done` means every step is applied. `rolled-back` means a step failed and every applied step was undone,
 *   with nothing parked. `needs-attention` means at least one step is parked: its state cannot be proven safe to leave or undo.
 *   A partial operation is never `done`.
 *
 * Every git call goes through `scopedGit` (phase 72) under the caller's allowlist session: the surface, and the repositories its
 * entry names in `SUBSTRATE_REPO_ALLOWLIST`. A repository the session is not granted, or that is not registered, is refused
 * before any spawn, and so is every call of a caller with no surface or a malformed allowlist. The store is a port;
 * `cross-repo-store.ts` is the Postgres adapter and `cross-repo-fake.ts` the in-memory one.
 */
import { createHash } from "node:crypto";
import { scopeRepoId } from "./event.ts";
import { assertRepoAllowed, RepoNotAllowedError, repoAllowlistFromEnv } from "./repo-allowlist.ts";
import { defaultScopedGitRunner, type ScopedGitResult, type ScopedGitRunner, type ScopedSession, scopedGit } from "./repo-executor.ts";
import { authorizeRepo, REPO_REFUSAL_MESSAGES, type RepoRefusalReason, type RepoScope } from "./repo-scope.ts";
import type { Surface } from "./types.ts";

/** Most repositories one operation may name. */
export const CROSS_REPO_MAX_REPOS = 16;
/** Longest operation key, in characters. */
export const CROSS_REPO_KEY_MAX_CHARS = 128;

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** A branch or base name: the first character is a letter or digit, so it can never be read as a git option. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
/** A full object name: SHA-1 (40 hex) or SHA-256 (64 hex). */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const CROSS_REPO_STEP_STATES = ["pending", "applying", "applied", "compensating", "compensated", "failed", "parked"] as const;
export type CrossRepoStepState = (typeof CROSS_REPO_STEP_STATES)[number];

export const CROSS_REPO_STATUSES = ["running", "done", "rolled-back", "needs-attention"] as const;
export type CrossRepoStatus = (typeof CROSS_REPO_STATUSES)[number];

/** Why a step is in the state it is in, when that is not obvious from the state. A closed set: never git output, never a path. */
export const CROSS_REPO_DETAILS = ["adopted", "already-absent", "apply-failed", "apply-unknown", "ref-exists", "ref-moved", "undo-failed", "undo-unknown"] as const;
export type CrossRepoDetail = (typeof CROSS_REPO_DETAILS)[number];

export interface BranchFanoutRepo {
	/** The repository as `owner/name`. Compared case-insensitively. */
	readonly repo: string;
	/** The commit-ish the branch is cut from, in that repository. */
	readonly base: string;
}

export interface BranchFanoutRequest {
	/** The dedupe key. A retry with the same key resumes the same operation; a new attempt needs a new key. */
	readonly key: string;
	readonly branch: string;
	readonly repos: readonly BranchFanoutRepo[];
}

export interface CrossRepoStep {
	readonly index: number;
	readonly repo: string;
	readonly base: string;
	/** The commit the base resolved to when the operation was planned. Every later attempt uses this value, never a fresh resolution. */
	readonly plannedSha: string;
	readonly state: CrossRepoStepState;
	readonly detail: CrossRepoDetail | null;
	readonly updatedAt: string;
}

export interface CrossRepoOperation {
	readonly key: string;
	/** The SHA-256 of the canonical request. A retry with a different fingerprint under the same key is refused. */
	readonly fingerprint: string;
	readonly branch: string;
	readonly status: CrossRepoStatus;
	readonly steps: readonly CrossRepoStep[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface NewCrossRepoStep {
	readonly index: number;
	readonly repo: string;
	readonly base: string;
	readonly plannedSha: string;
}

export interface NewCrossRepoOperation {
	readonly key: string;
	readonly fingerprint: string;
	readonly branch: string;
	readonly steps: readonly NewCrossRepoStep[];
	readonly at: Date;
}

/**
 * The store port. Every transition is a compare-and-set on the stored state, so two drivers cannot both move the same step.
 * A `moveStep` that finds the step outside `from` returns false and writes nothing.
 */
export interface CrossRepoStore {
	/** Inserts the operation and its steps in one transaction, unless `key` already exists. Returns the stored operation either way. */
	create(input: NewCrossRepoOperation): Promise<{ inserted: boolean; operation: CrossRepoOperation }>;
	load(key: string): Promise<CrossRepoOperation | null>;
	moveStep(key: string, index: number, from: readonly CrossRepoStepState[], to: CrossRepoStepState, detail: CrossRepoDetail | null, at: Date): Promise<boolean>;
	setStatus(key: string, status: CrossRepoStatus, at: Date): Promise<void>;
}

export interface CrossRepoDeps {
	readonly scope: RepoScope;
	/** The caller's surface, or null for an anonymous caller. */
	readonly surface: Surface | null;
	readonly store: CrossRepoStore;
	/** Defaults to the real git runner. Tests inject faults and crashes here. */
	readonly run?: ScopedGitRunner | undefined;
	/** The environment `SUBSTRATE_REPO_ALLOWLIST` is read from. Defaults to the process environment; tests inject their own. */
	readonly env?: Readonly<Record<string, string | undefined>> | undefined;
	/** Defaults to the wall clock. */
	readonly now?: (() => Date) | undefined;
}

export type CrossRepoRefusal = RepoRefusalReason | "request-invalid" | "base-unresolved" | "branch-invalid" | "key-reused" | "operator-required" | "operation-not-found";

/** One fixed message per refusal. Never the requested value: the name of the field that is wrong is the most a message says. */
const REFUSAL_MESSAGES: Readonly<Record<CrossRepoRefusal, string>> = {
	...REPO_REFUSAL_MESSAGES,
	"request-invalid": "the request is malformed",
	"base-unresolved": "the base does not name a commit in that repository",
	"branch-invalid": "the branch name is not a valid git branch name",
	"key-reused": "the key was used for a different request; a new attempt needs a new key",
	"operator-required": "this route is for an operator; nothing was changed",
	"operation-not-found": "no operation is stored under that key",
};

export type CrossRepoOutcome = { ok: true; operation: CrossRepoOperation } | { ok: false; reason: CrossRepoRefusal; problem: string };

type Parsed = { ok: true; value: { key: string; branch: string; repos: BranchFanoutRepo[] } } | { ok: false; problem: string };

const KEY_PROBLEM = "key must be 1 to 128 letters, digits, '.', '_', ':' or '-'";
const BODY_FIELDS: Readonly<Record<string, true>> = { key: true, branch: true, repos: true };

/**
 * Narrows an untrusted request. Every field is checked: the key, the branch, the repository count, each canonical repository
 * (once only) and each base. A malformed field is refused with a message that names the field and nothing it carried.
 */
export function parseBranchFanoutRequest(raw: { readonly key: unknown; readonly branch: unknown; readonly repos: unknown }): Parsed {
	if (typeof raw.key !== "string" || !KEY_PATTERN.test(raw.key)) return { ok: false, problem: KEY_PROBLEM };
	if (typeof raw.branch !== "string" || !NAME_PATTERN.test(raw.branch)) {
		return { ok: false, problem: "branch must start with a letter or digit and use letters, digits, '.', '_', '/' or '-'" };
	}
	if (!Array.isArray(raw.repos) || raw.repos.length < 2 || raw.repos.length > CROSS_REPO_MAX_REPOS) {
		return { ok: false, problem: `repos must name between 2 and ${CROSS_REPO_MAX_REPOS} repositories` };
	}
	const seen = new Set<string>();
	const repos: BranchFanoutRepo[] = [];
	for (const [index, entry] of (raw.repos as readonly unknown[]).entries()) {
		const fields = (typeof entry === "object" && entry !== null ? entry : {}) as { repo?: unknown; base?: unknown };
		const repo = typeof fields.repo === "string" ? scopeRepoId(fields.repo) : "";
		if (repo === "") return { ok: false, problem: `repos[${index}].repo must be owner/name` };
		if (seen.has(repo)) return { ok: false, problem: "each repository may appear once" };
		seen.add(repo);
		if (typeof fields.base !== "string" || !NAME_PATTERN.test(fields.base)) {
			return { ok: false, problem: `repos[${index}].base must name a branch, tag or commit` };
		}
		repos.push({ repo, base: fields.base });
	}
	return { ok: true, value: { key: raw.key, branch: raw.branch, repos } };
}

/**
 * Narrows an HTTP or MCP body before {@link parseBranchFanoutRequest}: a JSON object whose fields are `key`, `branch` and
 * `repos` and no others. Any other shape is refused with a fixed message, never with the value it carried.
 */
export function parseBranchFanoutBody(raw: unknown): Parsed {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, problem: "the request must be a JSON object with key, branch and repos" };
	}
	for (const field of Object.keys(raw)) {
		if (!Object.hasOwn(BODY_FIELDS, field)) return { ok: false, problem: "the request has a field it does not accept: only key, branch and repos are read" };
	}
	const { key, branch, repos } = raw as { key?: unknown; branch?: unknown; repos?: unknown };
	return parseBranchFanoutRequest({ key, branch, repos });
}

/** The SHA-256 of the canonical request: the branch and each repository with its base, sorted by repository. */
export function fingerprintOf(branch: string, repos: readonly BranchFanoutRepo[]): string {
	const canonical = [...repos]
		.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
		.map((entry) => [entry.repo, entry.base]);
	return createHash("sha256").update(JSON.stringify({ branch, repos: canonical })).digest("hex");
}

interface Context {
	readonly scope: RepoScope;
	readonly surface: Surface | null;
	/** The caller's allowlist session. Null when the caller is anonymous or the allowlist is malformed: nothing is granted. */
	readonly session: ScopedSession | null;
	readonly store: CrossRepoStore;
	readonly run: ScopedGitRunner;
	readonly now: () => Date;
}

/** The session of `surface` in the allowlist that `env` names. A malformed allowlist grants nothing, as an empty one does. */
function sessionOf(surface: Surface | null, env: Readonly<Record<string, string | undefined>>): ScopedSession | null {
	if (surface === null) return null;
	const parsed = repoAllowlistFromEnv(env);
	return parsed.ok ? { id: surface, allowlist: parsed.value } : null;
}

function contextOf(deps: CrossRepoDeps): Context {
	return {
		scope: deps.scope,
		surface: deps.surface,
		session: sessionOf(deps.surface, deps.env ?? process.env),
		store: deps.store,
		run: deps.run ?? defaultScopedGitRunner,
		now: deps.now ?? (() => new Date()),
	};
}

type GitCall = { ok: true; result: ScopedGitResult } | { ok: false; reason: RepoRefusalReason };

/** One git call through the phase 72 executor, under the caller's allowlist session. A refusal returns before any spawn. */
function git(ctx: Context, repo: string, args: readonly string[]): GitCall {
	if (ctx.session === null) return { ok: false, reason: "repo-not-granted" };
	const outcome = scopedGit({ scope: ctx.scope, surface: ctx.surface, repo, path: null, args, session: ctx.session }, ctx.run);
	return outcome.ok ? { ok: true, result: outcome.result } : { ok: false, reason: outcome.reason };
}

type RefRead = { kind: "at"; sha: string } | { kind: "absent" } | { kind: "unreadable" };

/** The value of `ref` in `repo`. `rev-parse --quiet` exits 1 with no output for a missing ref; anything else is unreadable. */
function readRef(ctx: Context, repo: string, ref: string): RefRead {
	const out = git(ctx, repo, ["rev-parse", "--verify", "--quiet", ref]);
	if (!out.ok) return { kind: "unreadable" };
	const sha = out.result.stdout.trim();
	if (out.result.code === 0 && OBJECT_NAME.test(sha)) return { kind: "at", sha };
	if (out.result.code === 1 && out.result.stdout === "") return { kind: "absent" };
	return { kind: "unreadable" };
}

function refOf(branch: string): string {
	return `refs/heads/${branch}`;
}

/** The null object name of the same width as `sha`: the old value `update-ref` takes to mean "the ref must not exist". */
function nullOf(sha: string): string {
	return "0".repeat(sha.length);
}

/**
 * One driver per operation key, in this process. `run` waits for every earlier driver of `key` to finish, runs `fn`, and frees
 * the key in `finally`, so a driver that throws releases it. Keys are independent: two operations never wait on each other.
 */
class KeyedLock {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const { promise: current, resolve: release } = Promise.withResolvers<void>();
		const tail = previous.then(() => current);
		this.tails.set(key, tail);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}
}

/** The lock every driver of this process takes. A store key is unique, so one lock per key covers every caller. */
const operationLocks = new KeyedLock();

/** The result of one step attempt. `busy` means another driver holds the step; the caller re-reads and reports the state it finds. */
type StepOutcome = "applied" | "failed" | "parked" | "compensated" | "busy";

/** The session's refusal for `repo`, or null when the allowlist grants it. A missing session grants nothing. */
function sessionReason(ctx: Context, repo: string): RepoRefusalReason | null {
	if (ctx.session === null) return "repo-not-granted";
	try {
		assertRepoAllowed(ctx.session.allowlist, ctx.session.id, repo);
		return null;
	} catch (error) {
		if (error instanceof RepoNotAllowedError) return "repo-not-granted";
		throw error;
	}
}

/** Whether `repo` may be operated on: the allowlist grants it, it is registered, and the surface is granted it. */
function gateRepo(ctx: Context, repo: string): { ok: true } | { ok: false; reason: RepoRefusalReason } {
	const granted = sessionReason(ctx, repo);
	if (granted !== null) return { ok: false, reason: granted };
	if (!ctx.scope.registry.has(repo)) return { ok: false, reason: "repo-not-registered" };
	const gate = authorizeRepo(ctx.scope, ctx.surface, repo);
	return gate.ok ? { ok: true } : { ok: false, reason: gate.reason };
}

/**
 * Creates the branch in one repository. The step is `applying` before the git call; the ref decides the outcome. A ref already
 * at the planned sha is adopted (a crashed earlier attempt landed it); a ref at any other value is never overwritten.
 */
async function applyStep(ctx: Context, op: CrossRepoOperation, step: CrossRepoStep): Promise<StepOutcome> {
	const ref = refOf(op.branch);
	// A step is `applying` here only when an earlier process recorded the intent and died. The driver holds the key's lock for its
	// whole run, so no live driver of this operation in this process can be mid-create. Only such a step may have landed its
	// create. A `pending` step never ran one, so a ref it finds was not written by this operation. That ref is never adopted,
	// and the undo never deletes it.
	const resumed = step.state === "applying";
	const settle = async (from: CrossRepoStepState, to: "applied" | "failed" | "parked", detail: CrossRepoDetail | null): Promise<StepOutcome> =>
		(await ctx.store.moveStep(op.key, step.index, [from], to, detail, ctx.now())) ? to : "busy";

	if (step.state === "pending" && !(await ctx.store.moveStep(op.key, step.index, ["pending"], "applying", null, ctx.now()))) return "busy";

	const before = readRef(ctx, step.repo, ref);
	if (before.kind === "unreadable") return resumed ? settle("applying", "parked", "apply-unknown") : settle("applying", "failed", "apply-failed");
	if (before.kind === "at") {
		return resumed && before.sha === step.plannedSha ? settle("applying", "applied", "adopted") : settle("applying", "failed", "ref-exists");
	}

	const created = git(ctx, step.repo, ["update-ref", ref, step.plannedSha, nullOf(step.plannedSha)]);
	const after = readRef(ctx, step.repo, ref);
	if (after.kind === "at" && after.sha === step.plannedSha) {
		const wrote = created.ok && created.result.code === 0;
		return settle("applying", "applied", wrote ? null : "adopted");
	}
	if (after.kind === "absent") return settle("applying", "failed", "apply-failed");
	if (after.kind === "at") return settle("applying", "failed", "ref-moved");
	return settle("applying", "parked", "apply-unknown");
}

/**
 * Removes the branch the operation wrote in one repository. The step is `compensating` before the git call. The delete names the
 * planned sha, so a ref that moved since is never deleted; it is parked. An absent ref is already compensated. A step recorded
 * `adopted` did not write its ref (the ref was present, or it reached the planned sha without this operation's create
 * succeeding), so the operation cannot prove it owns that ref: it is parked and never deleted.
 */
async function undoStep(ctx: Context, op: CrossRepoOperation, step: CrossRepoStep): Promise<StepOutcome> {
	const ref = refOf(op.branch);
	const settle = async (to: "compensated" | "parked", detail: CrossRepoDetail | null): Promise<StepOutcome> =>
		(await ctx.store.moveStep(op.key, step.index, ["compensating"], to, detail, ctx.now())) ? to : "busy";

	if (step.detail === "adopted") {
		if (step.state === "parked") return "parked";
		return (await ctx.store.moveStep(op.key, step.index, ["applied"], "parked", "adopted", ctx.now())) ? "parked" : "busy";
	}
	if (step.state !== "compensating" && !(await ctx.store.moveStep(op.key, step.index, ["applied", "parked"], "compensating", null, ctx.now()))) {
		return "busy";
	}

	const before = readRef(ctx, step.repo, ref);
	if (before.kind === "unreadable") return settle("parked", "undo-unknown");
	if (before.kind === "absent") return settle("compensated", "already-absent");
	if (before.sha !== step.plannedSha) return settle("parked", "ref-moved");

	const removed = git(ctx, step.repo, ["update-ref", "-d", ref, step.plannedSha]);
	const after = readRef(ctx, step.repo, ref);
	if (after.kind === "absent") {
		const deleted = removed.ok && removed.result.code === 0;
		return settle("compensated", deleted ? null : "already-absent");
	}
	if (after.kind === "at" && after.sha === step.plannedSha) return settle("parked", "undo-failed");
	if (after.kind === "at") return settle("parked", "ref-moved");
	return settle("parked", "undo-unknown");
}

async function requireOperation(ctx: Context, key: string): Promise<CrossRepoOperation> {
	const op = await ctx.store.load(key);
	if (op === null) throw new Error("cross-repo operation is missing from the store after it was written");
	return op;
}

/**
 * Drives one stored operation as far as it can go. Forward steps run in order and stop at the first that does not apply.
 * Then every step that may hold an effect is undone, newest first. Terminal operations are returned untouched, so a retry
 * of a finished operation performs no git call.
 */
async function drive(ctx: Context, key: string): Promise<CrossRepoOperation> {
	let op = await requireOperation(ctx, key);
	if (op.status === "done" || op.status === "rolled-back") return op;

	const blocked = op.steps.some((step) => step.state === "failed" || step.state === "parked" || step.state === "compensating" || step.state === "compensated");
	if (op.status === "running" && !blocked) {
		for (const step of op.steps) {
			if (step.state === "applied") continue;
			const outcome = await applyStep(ctx, op, step);
			if (outcome === "busy") return requireOperation(ctx, key);
			if (outcome !== "applied") break;
		}
		op = await requireOperation(ctx, key);
		if (op.steps.every((step) => step.state === "applied")) {
			await ctx.store.setStatus(key, "done", ctx.now());
			return requireOperation(ctx, key);
		}
	}

	for (const step of [...op.steps].reverse()) {
		if (step.state !== "applied" && step.state !== "compensating" && step.state !== "parked") continue;
		if ((await undoStep(ctx, op, step)) === "busy") return requireOperation(ctx, key);
	}
	op = await requireOperation(ctx, key);
	const parked = op.steps.some((step) => step.state === "parked");
	await ctx.store.setStatus(key, parked ? "needs-attention" : "rolled-back", ctx.now());
	return requireOperation(ctx, key);
}

/**
 * Undoes a stored operation without applying any step forward. A step found `applying` is parked as `apply-unknown` and left in
 * place: its create cannot be told apart from one that never ran, and the undo deletes only a ref it can prove it wrote. The
 * other steps the operation may have written are undone newest first, as {@link drive} undoes them. The status is `rolled-back`,
 * or `needs-attention` when a step is parked. A `rolled-back` operation is returned untouched, so a repeat performs no git call.
 */
async function compensate(ctx: Context, key: string): Promise<CrossRepoOperation> {
	let op = await requireOperation(ctx, key);
	if (op.status === "rolled-back") return op;

	const inFlight = new Set<number>();
	for (const step of op.steps) {
		if (step.state !== "applying") continue;
		inFlight.add(step.index);
		if (!(await ctx.store.moveStep(key, step.index, ["applying"], "parked", "apply-unknown", ctx.now()))) return requireOperation(ctx, key);
	}
	op = await requireOperation(ctx, key);
	for (const step of [...op.steps].reverse()) {
		if (inFlight.has(step.index)) continue;
		if (step.state !== "applied" && step.state !== "compensating" && step.state !== "parked") continue;
		if ((await undoStep(ctx, op, step)) === "busy") return requireOperation(ctx, key);
	}
	op = await requireOperation(ctx, key);
	const parked = op.steps.some((step) => step.state === "parked");
	await ctx.store.setStatus(key, parked ? "needs-attention" : "rolled-back", ctx.now());
	return requireOperation(ctx, key);
}

function refused(reason: CrossRepoRefusal, problem?: string): CrossRepoOutcome {
	return { ok: false, reason, problem: problem ?? REFUSAL_MESSAGES[reason] };
}

/**
 * Runs a branch fan-out, or resumes the stored operation with the same key. A refusal returns before the store is written or
 * any git effect runs. A retry with a stored key performs no planning: the stored planned shas are authoritative. The run holds
 * the key's lock, so two drivers of one key never interleave their steps.
 */
export async function runBranchFanout(request: BranchFanoutRequest, deps: CrossRepoDeps): Promise<CrossRepoOutcome> {
	const parsed = parseBranchFanoutRequest(request);
	if (!parsed.ok) return refused("request-invalid", parsed.problem);
	const { key, branch, repos } = parsed.value;
	return operationLocks.run(key, () => fanout(key, branch, repos, deps));
}

/** One run under the key's lock: the gate, the stored-operation check, and the plan for a new key. */
async function fanout(key: string, branch: string, repos: readonly BranchFanoutRepo[], deps: CrossRepoDeps): Promise<CrossRepoOutcome> {
	const ctx = contextOf(deps);

	for (const { repo } of repos) {
		const gate = gateRepo(ctx, repo);
		if (!gate.ok) return refused(gate.reason);
	}

	const fingerprint = fingerprintOf(branch, repos);
	const existing = await ctx.store.load(key);
	if (existing !== null) {
		if (existing.fingerprint !== fingerprint) return refused("key-reused");
		return { ok: true, operation: await drive(ctx, key) };
	}

	const named = git(ctx, repos[0]?.repo ?? "", ["check-ref-format", refOf(branch)]);
	if (!named.ok) return refused(named.reason);
	if (named.result.code !== 0) return refused("branch-invalid");

	const steps: NewCrossRepoStep[] = [];
	for (const [index, { repo, base }] of repos.entries()) {
		const resolved = git(ctx, repo, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
		if (!resolved.ok) return refused(resolved.reason);
		const sha = resolved.result.stdout.trim();
		if (resolved.result.code !== 0 || !OBJECT_NAME.test(sha)) return refused("base-unresolved");
		steps.push({ index, repo, base, plannedSha: sha });
	}

	const created = await ctx.store.create({ key, fingerprint, branch, steps, at: ctx.now() });
	if (created.operation.fingerprint !== fingerprint) return refused("key-reused");
	return { ok: true, operation: await drive(ctx, key) };
}

/**
 * The stored operation under `key`, or null. A surface that is not granted every repository of the operation, or that has no
 * allowlist session, gets null too, so the reply does not reveal that a key exists for a repository it cannot address.
 */
export async function crossRepoStatus(key: string, deps: CrossRepoDeps): Promise<CrossRepoOperation | null> {
	if (typeof key !== "string" || !KEY_PATTERN.test(key)) return null;
	const ctx = contextOf(deps);
	const op = await ctx.store.load(key);
	if (op === null) return null;
	const visible = op.steps.every((step) => sessionReason(ctx, step.repo) === null && authorizeRepo(ctx.scope, ctx.surface, step.repo).ok);
	return visible ? op : null;
}

/**
 * The operator's compensation of a stored operation (`POST /cross-repo/compensate`). Refused before the store is read or any git
 * call runs unless `isOperator` is true, and refused as `operation-not-found` when no operation is stored under `key`. Every
 * repository the operation names must be granted to the caller's surface and listed in its session allowlist, or nothing runs.
 * The run holds the key's lock and only undoes (see {@link compensate}); it never applies a step forward.
 */
export async function compensateBranchFanout(key: string, deps: CrossRepoDeps, isOperator: boolean): Promise<CrossRepoOutcome> {
	if (!isOperator) return refused("operator-required");
	if (typeof key !== "string" || !KEY_PATTERN.test(key)) return refused("request-invalid", KEY_PROBLEM);
	return operationLocks.run<CrossRepoOutcome>(key, async () => {
		const ctx = contextOf(deps);
		const stored = await ctx.store.load(key);
		if (stored === null) return refused("operation-not-found");
		for (const step of stored.steps) {
			const gate = gateRepo(ctx, step.repo);
			if (!gate.ok) return refused(gate.reason);
		}
		return { ok: true, operation: await compensate(ctx, key) };
	});
}

/**
 * The HTTP status of one refusal: a malformed request is 400, a repository the caller may not address or a non-operator on an
 * operator route is 403, an unknown operation is 404, a reused key is 409, and any other refusal is 422.
 */
function refusalStatus(reason: CrossRepoRefusal): number {
	if (reason === "request-invalid") return 400;
	if (reason === "repo-not-granted" || reason === "operator-required") return 403;
	if (reason === "key-reused") return 409;
	if (reason === "operation-not-found") return 404;
	return 422;
}

/** The reply the route and the MCP tool send: the HTTP status and the JSON body. */
export interface CrossRepoReply {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

/** `POST /cross-repo/fanout` and the `cross_repo_fanout` tool: validates the body, runs or resumes the operation, and answers with the stored operation. */
export async function crossRepoFanoutReply(raw: unknown, deps: CrossRepoDeps): Promise<CrossRepoReply> {
	const parsed = parseBranchFanoutBody(raw);
	if (!parsed.ok) return { status: 400, body: { ok: false, reason: "request-invalid", problem: parsed.problem } };
	const outcome = await runBranchFanout(parsed.value, deps);
	if (!outcome.ok) return { status: refusalStatus(outcome.reason), body: { ok: false, reason: outcome.reason, problem: outcome.problem } };
	return { status: 200, body: { ok: true, operation: outcome.operation } };
}

/** `GET /cross-repo/status?key=` and the `cross_repo_status` tool: the stored operation, or a 404 that reveals nothing the caller cannot see. */
export async function crossRepoStatusReply(key: unknown, deps: CrossRepoDeps): Promise<CrossRepoReply> {
	if (typeof key !== "string" || !KEY_PATTERN.test(key)) return { status: 400, body: { ok: false, reason: "request-invalid", problem: KEY_PROBLEM } };
	const operation = await crossRepoStatus(key, deps);
	if (operation === null) return { status: 404, body: { ok: false, reason: "not-found", problem: "no operation under that key is visible to this surface" } };
	return { status: 200, body: { ok: true, operation } };
}

/** `POST /cross-repo/compensate` (operator only): the body is `{"key": "..."}` and no other field. */
export async function crossRepoCompensateReply(raw: unknown, deps: CrossRepoDeps, isOperator: boolean): Promise<CrossRepoReply> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { status: 400, body: { ok: false, reason: "request-invalid", problem: "the request must be a JSON object with key" } };
	}
	for (const field of Object.keys(raw)) {
		if (field !== "key") return { status: 400, body: { ok: false, reason: "request-invalid", problem: "the request has a field it does not accept: only key is read" } };
	}
	const key = "key" in raw ? raw.key : undefined;
	if (typeof key !== "string" || !KEY_PATTERN.test(key)) return { status: 400, body: { ok: false, reason: "request-invalid", problem: KEY_PROBLEM } };
	const outcome = await compensateBranchFanout(key, deps, isOperator);
	if (!outcome.ok) return { status: refusalStatus(outcome.reason), body: { ok: false, reason: outcome.reason, problem: outcome.problem } };
	return { status: 200, body: { ok: true, operation: outcome.operation } };
}
