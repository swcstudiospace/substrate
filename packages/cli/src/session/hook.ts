/**
 * `substrate session hook <turn|plan-step|steering|baseline>`: the entry point a host hook calls to take an
 * automatic checkpoint (v1.6, phase 61, success criterion 3).
 *
 * The host (Claude Code's `Stop` hook, a git post-commit script, a GSD or Swarm runner) pipes a JSON envelope
 * to stdin: Claude Code's hook fields `session_id`, `cwd`, `transcript_path`, and for `steering` an optional
 * `directive_id`. This module decides with `trigger-policy.ts` whether a checkpoint is due and, if so, makes it
 * with `createCheckpoint`.
 *
 * FAIL-OPEN. A hook runs inside someone else's turn, and a Claude Code hook that exits 2 blocks the turn from
 * ending. So `runHook` never throws and the command that wraps it always exits 0 with nothing on stdout; with
 * `--verbose` it writes at most one line to stderr saying what happened. An overall timeout (default
 * `HOOK_TIMEOUT_MS`) ends the wait even if git or the server hangs; work already done stays (a pinned
 * checkpoint is a local ref, and a ledger record that was not delivered is journaled by `createCheckpoint`).
 *
 * The session id is `--session`, else the envelope's `session_id`, else the one session that has local
 * checkpoints in the worktree (the same rule `substrate session checkpoint` applies). No environment variable
 * names a session and none is added here. `transcript_path` is accepted and ignored: it is a Claude Code
 * transcript, which the omp transcript reference does not describe.
 *
 * A turn costs one extra tree hash over a bare `session checkpoint`: the cheap rules (rate limit, baseline,
 * directive dedupe) run first, then one snapshot is hashed to compare its tree with the last checkpoint's, and
 * `createCheckpoint` snapshots again only when a checkpoint is really due.
 */
import { isAbsolute } from "node:path";
import type { RandomBytes } from "../../../mcp-server/src/session-events.ts";
import { type Clock, type Runner, type SnapshotPolicy, snapshot, spawnRunner } from "../../../worktree-snapshot/src/index.ts";
import {
	type CheckpointResult,
	type LocalCheckpoint,
	type PlanRef,
	checkpointsOfSession,
	createCheckpoint,
	listLocalCheckpoints,
} from "./checkpoint.ts";
import type { RollbackServerClient } from "./client.ts";
import { type HookTrigger, type PolicyCheckpoint, directiveKey, shouldCheckpoint } from "./trigger-policy.ts";

/** The whole hook, from reading stdin to the pinned checkpoint, is given this long. */
export const HOOK_TIMEOUT_MS = 10_000;
/** The envelope is a few hundred bytes; anything past this is not one. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_SESSION_ID = 512;
const MAX_DIRECTIVE_ID = 256;

export type HookOutcome =
	| { status: "checkpointed"; ckpt_id: string; seq: number; created: boolean; ledger: CheckpointResult["server"]["status"] }
	| { status: "skipped"; reason: string }
	| { status: "failed"; reason: string };

export interface HookParams {
	trigger: HookTrigger;
	/** The worktree used when the envelope names no `cwd`. */
	worktree: string;
	surface: string;
	/** `--session`: wins over the envelope. */
	sessionId?: string;
	/** `--plan-phase` / `--plan-step`: the plan reference of a `plan-step` checkpoint. */
	planRef?: PlanRef;
	client: RollbackServerClient;
	now: Clock;
	randomBytes: RandomBytes;
	/** Reads the whole of stdin. */
	readStdin: () => Promise<string>;
	/** Default `HOOK_TIMEOUT_MS`. */
	timeoutMs?: number;
	run?: Runner;
	pendingDir?: string;
	policy?: SnapshotPolicy;
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

	const { checkpoints } = await listLocalCheckpoints({ worktree, run, now: params.now });
	let sessionId = params.sessionId ?? parsed.session_id;
	if (sessionId === undefined) {
		const known = [...new Set(checkpoints.map((checkpoint) => checkpoint.session_id))];
		if (known.length !== 1) return { status: "skipped", reason: known.length === 0 ? "no session id in the envelope or --session, and no session is known in this worktree" : "no session id in the envelope or --session, and several sessions have checkpoints in this worktree" };
		sessionId = known[0] as string;
	}
	if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID) return { status: "failed", reason: "the session id must be 1 to 512 characters" };

	const own = checkpointsOfSession(checkpoints, sessionId);
	const last = own[own.length - 1];
	const lastOfTrigger = [...own].reverse().find((checkpoint) => checkpoint.trigger === params.trigger);
	const key = params.trigger === "steering" && parsed.directive_id !== undefined ? directiveKey(parsed.directive_id) : undefined;
	const seen = new Set<string>();
	for (const checkpoint of own) {
		if (checkpoint.trigger === "steering" && checkpoint.plan_ref?.step !== undefined) seen.add(checkpoint.plan_ref.step);
	}
	const base = {
		trigger: params.trigger,
		nowMs: params.now().getTime(),
		last: asPolicy(last),
		lastOfTrigger: asPolicy(lastOfTrigger),
		...(key === undefined ? {} : { directiveKey: key, seenDirectiveKeys: seen }),
	};

	// The cheap rules first: they need no snapshot.
	const early = shouldCheckpoint(base);
	if (!early.take) return { status: "skipped", reason: early.reason };
	// Then the one that needs the tree.
	const snap = await snapshot({ worktree, policy: params.policy, now: params.now, run });
	const decision = shouldCheckpoint({ ...base, currentTreeId: snap.tree });
	if (!decision.take) return { status: "skipped", reason: decision.reason };

	const planRef: PlanRef | undefined = key === undefined ? params.planRef : { step: key };
	const result = await createCheckpoint({
		worktree,
		sessionId,
		trigger: params.trigger,
		...(planRef === undefined ? {} : { planRef }),
		surface: params.surface,
		client: params.client,
		now: params.now,
		randomBytes: params.randomBytes,
		run,
		pendingDir: params.pendingDir,
		policy: params.policy,
	});
	return { status: "checkpointed", ckpt_id: result.checkpoint.ckpt_id, seq: result.checkpoint.seq, created: result.created, ledger: result.server.status };
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
		case "skipped":
			return `substrate session hook ${trigger}: skipped (${outcome.reason})`;
		default:
			return `substrate session hook ${trigger}: failed open (${outcome.reason})`;
	}
}
