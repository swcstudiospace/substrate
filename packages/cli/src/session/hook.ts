/**
 * `substrate session hook <turn|plan-step|steering|baseline|context>`: the entry point a host hook calls to take an
 * automatic checkpoint (v1.6, phase 61, success criterion 3), and (v1.7, phase 67) to print the live-context digest.
 *
 * The host (Claude Code's `Stop` hook, a git post-commit script, a GSD or Swarm runner) pipes a JSON envelope
 * to stdin: Claude Code's hook fields `session_id`, `cwd`, `transcript_path`, and for `steering` an optional
 * `directive_id`. This module decides with `trigger-policy.ts` whether a checkpoint is due and, if so, makes it
 * with `createCheckpoint`.
 *
 * FAIL-OPEN. A hook runs inside someone else's turn, and a Claude Code hook that exits 2 blocks the turn from
 * ending. So `runHook` never throws and the command that wraps it always exits 0 with nothing on stdout (but the digest of `context`); with
 * `--verbose` it writes at most one line to stderr saying what happened. An overall timeout (default
 * `HOOK_TIMEOUT_MS`) ends the wait even if git or the server hangs; work already done stays (a pinned
 * checkpoint is a local ref, and a ledger record that was not delivered is journaled by `createCheckpoint`).
 *
 * The session id is `--session`, else the envelope's `session_id`, else the one session that has local
 * checkpoints in the worktree (the same rule `substrate session checkpoint` applies). No environment variable
 * names a session and none is added here. `transcript_path` is accepted and ignored: it is a Claude Code
 * transcript, which the omp transcript reference does not describe.
 *
 * A turn costs no extra tree hash over a bare `session checkpoint`: the cheap rules (rate limit, baseline,
 * directive dedupe) run first on an unlocked list; if they pass, `createCheckpoint` takes the one snapshot and
 * re-runs the whole policy, with the tree id of that snapshot, under the checkpoint lock (`admit`), so two
 * overlapping hooks cannot both pass on the same history.
 *
 * Phase 67 (Live Steering). `steering` also reads the server's acknowledged directives and, for each one whose
 * `checkpoint_hint` it has not consumed, takes the checkpoint the hint names through the same writer; consumption is
 * remembered in `steering-consumed.ts`, and a server that cannot answer leaves the plain steering checkpoint. `context`
 * is not a checkpoint: it returns the live-context digest as bounded text, which the command prints (the only stdout a
 * hook has) and which is empty on any error.
 */
import { isAbsolute } from "node:path";
import type { RandomBytes } from "../../../mcp-server/src/session-events.ts";
import { type Clock, type Runner, type SnapshotPolicy, spawnRunner } from "../../../worktree-snapshot/src/index.ts";
import {
	type CheckpointResult,
	type LocalCheckpoint,
	type PlanRef,
	checkpointsOfSession,
	createCheckpoint,
	listLocalCheckpoints,
} from "./checkpoint.ts";
import type { RollbackServerClient } from "./client.ts";
import { resolvePendingDir } from "./pending.ts";
import { readConsumed, consumedPath, writeConsumed } from "./steering-consumed.ts";
import { type CheckpointHookTrigger, type HookTrigger, type PolicyCheckpoint, directiveKey, shouldCheckpoint } from "./trigger-policy.ts";
import { SESSION_ID_PATTERN, type SteerClient, type SteerDirective } from "../steer/client.ts";
import { MAX_DIGEST_CHARS, renderDigest } from "../steer/render.ts";
import { repoSlugOfWorktree } from "../steer/repo.ts";

/** The whole hook, from reading stdin to the pinned checkpoint, is given this long. */
export const HOOK_TIMEOUT_MS = 10_000;
/** The envelope is a few hundred bytes; anything past this is not one. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_SESSION_ID = 512;
const MAX_DIRECTIVE_ID = 256;

export type HookOutcome =
	| { status: "checkpointed"; ckpt_id: string; seq: number; created: boolean; ledger: CheckpointResult["server"]["status"] }
	/** The `context` trigger's digest, already bounded; the command prints it. */
	| { status: "context"; text: string }
	| { status: "skipped"; reason: string }
	| { status: "failed"; reason: string };

export interface HookParams {
	trigger: HookTrigger;
	/** The worktree used when the envelope names no `cwd`. */
	worktree: string;
	surface: string;
	/** `--session`: wins over the envelope. */
	sessionId?: string | undefined;
	/** `--plan-phase` / `--plan-step`: the plan reference of a `plan-step` checkpoint. */
	planRef?: PlanRef | undefined;
	client: RollbackServerClient;
	now: Clock;
	randomBytes: RandomBytes;
	/** Reads the whole of stdin. */
	readStdin: () => Promise<string>;
	/** Default `HOOK_TIMEOUT_MS`. */
	timeoutMs?: number | undefined;
	run?: Runner | undefined;
	pendingDir?: string | undefined;
	policy?: SnapshotPolicy | undefined;
	/**
	 * The server's REST routes for the `steering` hint reader and the `context` trigger. Absent: `steering` takes the
	 * plain checkpoint, `context` prints nothing.
	 */
	steer?: Pick<SteerClient, "directives" | "context"> | undefined;
}

/** Read all of the process's stdin, refusing more than `MAX_ENVELOPE_BYTES`. A terminal has no envelope: that is empty, not a wait. */
export async function readProcessStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.length;
		if (size > MAX_ENVELOPE_BYTES) throw new Error(`the hook envelope is longer than ${MAX_ENVELOPE_BYTES} bytes`);
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

interface Envelope {
	session_id?: string;
	cwd?: string;
	directive_id?: string;
}

/** Parse the stdin text. Empty is an empty envelope; anything that is not a JSON object, or has a mistyped field, is a reason. */
export function parseEnvelope(raw: string): Envelope | string {
	if (raw.length > MAX_ENVELOPE_BYTES) return "the hook envelope is too long";
	if (raw.trim().length === 0) return {};
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return "the hook envelope is not valid JSON";
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "the hook envelope is not a JSON object";
	const rec = value as Record<string, unknown>;
	const envelope: Envelope = {};
	const text = (name: "session_id" | "cwd" | "directive_id", max: number): string | undefined => {
		const field = rec[name];
		if (field === undefined || field === null) return undefined;
		if (typeof field !== "string" || field.length === 0 || field.length > max) throw new Error(`the envelope field ${name} must be a string of 1 to ${max} characters`);
		return field;
	};
	try {
		const sessionId = text("session_id", MAX_SESSION_ID);
		const cwd = text("cwd", 4096);
		const directiveId = text("directive_id", MAX_DIRECTIVE_ID);
		if (sessionId !== undefined) envelope.session_id = sessionId;
		if (cwd !== undefined) envelope.cwd = cwd;
		if (directiveId !== undefined) envelope.directive_id = directiveId;
	} catch (error) {
		return error instanceof Error ? error.message : "the hook envelope is not valid";
	}
	return envelope;
}

const asPolicy = (checkpoint: LocalCheckpoint | undefined): PolicyCheckpoint | undefined =>
	checkpoint === undefined
		? undefined
		: { treeId: checkpoint.tree, trigger: checkpoint.trigger, ...(checkpoint.taken_at_ms === undefined ? {} : { takenAtMs: checkpoint.taken_at_ms }) };

/** The git top level of an envelope `cwd`, or a reason. */
async function worktreeOf(cwd: string, run: Runner): Promise<string | { reason: string }> {
	if (!isAbsolute(cwd)) return { reason: "the envelope cwd is not an absolute path" };
	try {
		const result = await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
		const top = result.stdout.toString("utf8").trim();
		if (result.code !== 0 || top.length === 0) return { reason: "the envelope cwd is not inside a git worktree" };
		return top;
	} catch {
		return { reason: "git could not be run for the envelope cwd" };
	}
}

/** The most unconsumed hints one run acts on; the rest wait for the next run, so a flood of directives cannot make one hook hash the tree without end. */
const MAX_HINTS_PER_RUN = 5;

/** The directive ids whose `checkpoint_hint` asks this session for a steering checkpoint and that the hook has not consumed yet, oldest first. */
export function unconsumedHints(directives: readonly SteerDirective[], sessionId: string, consumed: ReadonlySet<string>): string[] {
	const ids: string[] = [];
	for (const directive of directives) {
		const hint = directive.checkpoint_hint;
		if (hint === null || hint.trigger !== "steering" || directive.session_id !== sessionId) continue;
		if (consumed.has(hint.directive_id) || ids.includes(hint.directive_id)) continue;
		ids.push(hint.directive_id);
		if (ids.length >= MAX_HINTS_PER_RUN) break;
	}
	return ids;
}

/** The `context` trigger: the digest of the repository's other sessions as bounded text, or a reason it is not printed. */
async function contextOutcome(params: HookParams, envelope: Envelope, worktree: string, run: Runner): Promise<HookOutcome> {
	if (params.steer === undefined) return { status: "skipped", reason: "no server client" };
	const repoId = await repoSlugOfWorktree(worktree, run);
	if (repoId === undefined) return { status: "skipped", reason: "the worktree has no origin remote to name the repository" };
	const candidate = params.sessionId ?? envelope.session_id;
	const sessionId = candidate !== undefined && SESSION_ID_PATTERN.test(candidate) ? candidate : undefined;
	const result = await params.steer.context({ repoId, ...(sessionId === undefined ? {} : { sessionId }) });
	if (!result.ok) return { status: "failed", reason: result.message };
	// One less than the bound: the command adds the newline.
	return { status: "context", text: renderDigest(result.value, MAX_DIGEST_CHARS - 1) };
}

async function execute(params: HookParams): Promise<HookOutcome> {
	const run = params.run ?? spawnRunner;
	const parsed = parseEnvelope(await params.readStdin());
	if (typeof parsed === "string") return { status: "failed", reason: parsed };

	let worktree = params.worktree;
	if (parsed.cwd !== undefined) {
		const resolved = await worktreeOf(parsed.cwd, run);
		if (typeof resolved !== "string") return { status: "failed", reason: resolved.reason };
		worktree = resolved;
	}
	// `context` prints a digest and takes no snapshot: it never lists checkpoints or needs a session.
	if (params.trigger === "context") return contextOutcome(params, parsed, worktree, run);
	const trigger: CheckpointHookTrigger = params.trigger;

	const { checkpoints } = await listLocalCheckpoints({ worktree, run, now: params.now });
	let sessionId = params.sessionId ?? parsed.session_id;
	if (sessionId === undefined) {
		const known = [...new Set(checkpoints.map((checkpoint) => checkpoint.session_id))];
		if (known.length !== 1) return { status: "skipped", reason: known.length === 0 ? "no session id in the envelope or --session, and no session is known in this worktree" : "no session id in the envelope or --session, and several sessions have checkpoints in this worktree" };
		sessionId = known[0] as string;
	}
	if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID) return { status: "failed", reason: "the session id must be 1 to 512 characters" };
	const session = sessionId;

	// One checkpoint attempt, for the directive `key` names (none: a plain steering checkpoint of a changed tree).
	const attempt = async (key: string | undefined, planRef: PlanRef | undefined): Promise<HookOutcome> => {
		// The policy input for a history: `own` are the session's checkpoints, ascending by seq.
		const policyInput = (own: readonly LocalCheckpoint[], currentTreeId?: string) => {
			const last = own[own.length - 1];
			const lastOfTrigger = [...own].reverse().find((checkpoint) => checkpoint.trigger === trigger);
			const seen = new Set<string>();
			for (const checkpoint of own) {
				if (checkpoint.trigger === "steering" && checkpoint.plan_ref?.step !== undefined) seen.add(checkpoint.plan_ref.step);
			}
			const lastView = asPolicy(last);
			const lastOfTriggerView = asPolicy(lastOfTrigger);
			return {
				trigger,
				nowMs: params.now().getTime(),
				...(lastView === undefined ? {} : { last: lastView }),
				...(lastOfTriggerView === undefined ? {} : { lastOfTrigger: lastOfTriggerView }),
				...(key === undefined ? {} : { directiveKey: key, seenDirectiveKeys: seen }),
				...(currentTreeId === undefined ? {} : { currentTreeId }),
			};
		};

		// The cheap rules first, on the unlocked list: they need no snapshot.
		const early = shouldCheckpoint(policyInput(checkpointsOfSession(checkpoints, session)));
		if (!early.take) return { status: "skipped", reason: early.reason };

		const result = await createCheckpoint({
			worktree,
			sessionId: session,
			trigger,
			...(planRef === undefined ? {} : { planRef }),
			surface: params.surface,
			client: params.client,
			now: params.now,
			randomBytes: params.randomBytes,
			run,
			pendingDir: params.pendingDir,
			policy: params.policy,
			// The decision that counts: the whole policy again, with the history read under the checkpoint lock and the tree of the snapshot about to be pinned.
			admit: ({ existing, tree }) => {
				const decision = shouldCheckpoint(policyInput(existing, tree));
				return decision.take ? { take: true } : { take: false, reason: decision.reason };
			},
		});
		if ("status" in result) return { status: "skipped", reason: result.reason };
		return { status: "checkpointed", ckpt_id: result.checkpoint.ckpt_id, seq: result.checkpoint.seq, created: result.created, ledger: result.server.status };
	};

	const envelopeKey = trigger === "steering" && parsed.directive_id !== undefined ? directiveKey(parsed.directive_id) : undefined;
	if (trigger !== "steering" || params.steer === undefined || !SESSION_ID_PATTERN.test(session)) {
		return attempt(envelopeKey, envelopeKey === undefined ? params.planRef : { step: envelopeKey });
	}

	// The steering hook also acts on what the server says it was asked to do: each acknowledged directive that carries a
	// `checkpoint_hint` gets the checkpoint it names, once. A server that cannot answer leaves exactly the checkpoint above.
	const statePath = await consumedPathFor(params, worktree, run, session);
	const consumed = new Set(statePath === undefined ? [] : readConsumed(statePath));
	const listed = await params.steer.directives({ sessionId: session, status: "acknowledged" });
	const hintIds = listed.ok ? unconsumedHints(listed.value, session, consumed) : [];

	const outcomes: HookOutcome[] = [];
	const acted: string[] = [];
	for (const id of hintIds) {
		const key = directiveKey(id);
		try {
			const outcome = await attempt(key, { step: key });
			outcomes.push(outcome);
			// A checkpoint taken, or a decision that none is due (already taken, tree unchanged): either way this hint is dealt with.
			acted.push(id);
		} catch (error) {
			// A local failure leaves the hint unconsumed, so the next run tries again.
			outcomes.push({ status: "failed", reason: error instanceof Error ? error.message : "the checkpoint failed" });
		}
	}
	// The envelope's own directive, unless a hint above already covered it; with neither, the plain steering checkpoint.
	if (parsed.directive_id === undefined || !hintIds.includes(parsed.directive_id)) {
		outcomes.push(await attempt(envelopeKey, envelopeKey === undefined ? params.planRef : { step: envelopeKey }));
	}

	if (statePath !== undefined && acted.length > 0) {
		try {
			writeConsumed(statePath, session, [...consumed, ...acted]);
		} catch {
			// Only a cache of decisions: the next run asks the policy again, which skips what already has a checkpoint.
		}
	}
	return outcomes.find((outcome) => outcome.status === "checkpointed") ?? (outcomes[outcomes.length - 1] as HookOutcome);
}

/** Where this session's consumed hints are kept, or undefined when the worktree's git directory cannot be resolved. */
async function consumedPathFor(params: HookParams, worktree: string, run: Runner, sessionId: string): Promise<string | undefined> {
	try {
		return consumedPath(params.pendingDir ?? (await resolvePendingDir(worktree, run)), sessionId);
	} catch {
		return undefined;
	}
}

/** Run the hook. Never throws and never outlives `timeoutMs`: every failure is a `failed` outcome. */
export async function runHook(params: HookParams): Promise<HookOutcome> {
	const timeoutMs = params.timeoutMs ?? HOOK_TIMEOUT_MS;
	const { promise: timeout, resolve } = Promise.withResolvers<HookOutcome>();
	const timer = setTimeout(() => resolve({ status: "failed", reason: `the hook did not finish within ${timeoutMs} ms` }), timeoutMs);
	const work = execute(params).catch((error: unknown): HookOutcome => ({ status: "failed", reason: error instanceof Error ? error.message : "the hook failed" }));
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** The single `--verbose` line for an outcome. */
export function describeOutcome(trigger: HookTrigger, outcome: HookOutcome): string {
	switch (outcome.status) {
		case "checkpointed":
			return `substrate session hook ${trigger}: ${outcome.created ? "created" : "found"} checkpoint ${outcome.ckpt_id} (seq ${outcome.seq}; ledger ${outcome.ledger})`;
		case "context":
			return `substrate session hook ${trigger}: printed ${outcome.text.length} characters of context`;
		case "skipped":
			return `substrate session hook ${trigger}: skipped (${outcome.reason})`;
		default:
			return `substrate session hook ${trigger}: failed open (${outcome.reason})`;
	}
}
