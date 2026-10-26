/**
 * `substrate session checkpoint|checkpoints|rollback|recover|sync` (v1.6, phase 61).
 *
 * The grammar, the exit codes and the output live here; the work lives in `checkpoint.ts`, `rollback.ts`
 * and `pending.ts`. Like `substrate ledger`, a wrong flag is refused BEFORE any work, with the usage text
 * on stderr and exit 2. This parser is its own (not `parseArgs`) because that one cannot tell
 * `--dry-run ckpt_x` from `--dry-run` taking `ckpt_x` as its value.
 *
 * Exit codes: 0 done, 1 failed, 2 usage, 3 refused (drift, an anchor mismatch, an unknown or foreign
 * target), 4 files restored but the ledger commit is pending.
 *
 * The session id comes from `--session`; with no flag it is the one session that has local checkpoints in
 * this worktree, and with none or several the command refuses and asks for `--session` (no environment
 * variable names a session today, and this adds none). The surface comes from `--surface`, default
 * `claude-code` like the other commands, and selects the bearer through the token resolver.
 *
 * Every line of output is scrubbed: the bearer, anything the redactor recognises, and absolute paths (the
 * worktree becomes `<worktree>` and the home directory `~`).
 */
import { homedir } from "node:os";
import { basename } from "node:path";
import { open } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { redact, redactKnown } from "../../../mcp-server/src/redact.ts";
import {
	CHECKPOINT_TRIGGERS,
	type CheckpointTrigger,
	type RandomBytes,
	type TranscriptRef,
	parseTranscriptRef,
} from "../../../mcp-server/src/session-events.ts";
import { SURFACES } from "../../../mcp-server/src/types.ts";
import {
	type Clock,
	type RestoreHooks,
	type Runner,
	type SnapshotPolicy,
	WorktreeSnapshotError,
	recoverRestore,
	spawnRunner,
} from "../../../worktree-snapshot/src/index.ts";
import {
	CheckpointError,
	type CheckpointResult,
	type LocalCheckpoint,
	type PlanRef,
	checkpointsOfSession,
	createCheckpoint,
	listLocalCheckpoints,
} from "./checkpoint.ts";
import { CKPT_ID_PATTERN, type FetchLike, type RollbackServerClient, createRollbackServerClient, isUnreachable } from "./client.ts";
import { OMP_SESSION_MAX_BYTES, OmpForkError, ompTranscriptRef } from "./omp-fork.ts";
import { PendingJournalError, listPending, replayPending, resolvePendingDir } from "./pending.ts";
import { type RollbackResult, type TranscriptPort, RollbackInputError, rollback } from "./rollback.ts";

export const EXIT_DONE = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;
export const EXIT_LEDGER_PENDING = 4;

export const SESSION_USAGE =
	"usage: substrate session checkpoint [--session ID] [--surface S] [--trigger T] [--transcript-ref JSON | --omp-session FILE] [--plan-phase P] [--plan-step S] [--json]\n" +
	"       substrate session checkpoints [--session ID] [--surface S] [--offline] [--json]\n" +
	"       substrate session rollback <ckpt|seq|previous> [--session ID] [--surface S] [--dry-run] [--force] [--offline] [--json]\n" +
	"       substrate session recover [--json]\n" +
	"       substrate session sync [--json]\n" +
	`triggers: ${CHECKPOINT_TRIGGERS.join(", ")}\n` +
	"exit: 0 done, 1 failed, 2 usage, 3 refused (drift, anchor mismatch, unknown or foreign target), 4 files restored but the ledger commit is pending\n" +
	"--omp-session FILE records where in that omp session file the checkpoint was taken (entry id, turn number, prefix digest; never content or the path). A file that cannot be read or parsed does not fail the checkpoint: it is made without a transcript reference and the output says why.\n";

/** A plan can take the server longer than a hook's emit budget (it counts what a rollback would forget). */
export const ROLLBACK_MIN_TIMEOUT_MS = 10_000;
/** `checkpoints` asks the server about at most this many of the newest checkpoints. */
export const MAX_SERVER_STATUS_QUERIES = 20;
const DEFAULT_SURFACE = "claude-code";
const MAX_SKIPPED_SHOWN = 10;

export interface SessionDeps {
	/** The worktree's top level. */
	worktree: string;
	url: string;
	/** The resolved bearer for a surface, if any. */
	tokenFor: (surface: string) => string | undefined;
	timeoutMs: number;
	now: Clock;
	randomBytes: RandomBytes;
	transcript: TranscriptPort;
	out: (text: string) => void;
	err: (text: string) => void;
	run?: Runner;
	fetch?: FetchLike;
	signalFor?: (timeoutMs: number) => AbortSignal;
	/** Replaces the home directory scrubbed from output (default: the OS home directory). */
	home?: string;
	/**
	 * Reads a session file for `--omp-session`, throwing when it is unreadable or longer than `maxBytes`.
	 * Default: a regular file read through a bounded buffer. A test seam, like `run` and `fetch`.
	 */
	readFile?: (path: string, maxBytes: number) => Promise<string>;
	/** Test seams. */
	pendingDir?: string;
	policy?: SnapshotPolicy;
	hooks?: RestoreHooks;
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

type Sub = "checkpoint" | "checkpoints" | "rollback" | "recover" | "sync";

const SUBCOMMANDS: readonly Sub[] = ["checkpoint", "checkpoints", "rollback", "recover", "sync"];
const VALUE_FLAGS: readonly string[] = ["session", "surface", "trigger", "transcript-ref", "omp-session", "plan-phase", "plan-step"];
const ALLOWED: Record<Sub, readonly string[]> = {
	checkpoint: ["json", "session", "surface", "trigger", "transcript-ref", "omp-session", "plan-phase", "plan-step"],
	checkpoints: ["json", "session", "surface", "offline"],
	rollback: ["json", "session", "surface", "dry-run", "force", "offline"],
	recover: ["json"],
	sync: ["json"],
};

interface Parsed {
	sub: Sub;
	flags: Map<string, string | true>;
	positional: string[];
}

/** Parse `argv` strictly. Returns the reason on a refusal. */
export function parseSessionArgs(argv: readonly string[]): Parsed | string {
	const sub = argv[0];
	if (sub === undefined || !(SUBCOMMANDS as readonly string[]).includes(sub)) return "expected a subcommand";
	const allowed = ALLOWED[sub as Sub];
	const flags = new Map<string, string | true>();
	const positional: string[] = [];
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i] as string;
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const name = token.slice(2);
		if (!allowed.includes(name)) return `unknown flag ${token} for \`session ${sub}\``;
		if (flags.has(name)) return `${token} given more than once`;
		if (VALUE_FLAGS.includes(name)) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) return `${token} needs a value`;
			flags.set(name, value);
			i++;
		} else {
			flags.set(name, true);
		}
	}
	if (sub === "rollback") {
		if (positional.length !== 1) return "rollback takes exactly one target: a checkpoint id, a seq number, or `previous`";
		const target = positional[0] as string;
		if (target !== "previous" && !/^[0-9]+$/.test(target) && !CKPT_ID_PATTERN.test(target)) {
			return "the rollback target must be a checkpoint id (ckpt_...), a seq number, or `previous`";
		}
	} else if (positional.length > 0) {
		return `\`session ${sub}\` takes no positional argument`;
	}
	return { sub: sub as Sub, flags, positional };
}

const flagValue = (parsed: Parsed, name: string): string | undefined => {
	const value = parsed.flags.get(name);
	return typeof value === "string" ? value : undefined;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

class Output {
	private readonly secrets: string[] = [];
	private readonly roots: Array<[path: string, replacement: string]> = [];
	private readonly deps: SessionDeps;

	constructor(deps: SessionDeps) {
		this.deps = deps;
		const add = (path: string | undefined, replacement: string): void => {
			if (path !== undefined && path.length > 1) this.roots.push([path, replacement]);
		};
		add(deps.worktree, "<worktree>");
		try {
			add(realpathSync(deps.worktree), "<worktree>");
		} catch {
			// The worktree path is only being scrubbed from output; one that cannot be resolved needs no second spelling.
		}
		add(deps.home ?? homedir(), "~");
		// Longest first, so a worktree under the home directory becomes <worktree>, not ~/...
		this.roots.sort((a, b) => b[0].length - a[0].length);
	}

	/** Remember a bearer so no output can carry it. */
	protect(token: string | undefined): void {
		if (token) this.secrets.push(token, JSON.stringify(token).slice(1, -1));
	}

	clean(text: string): string {
		let cleaned = text;
		for (const [path, replacement] of this.roots) cleaned = cleaned.split(path).join(replacement);
		return redact(redactKnown(cleaned, this.secrets));
	}

	line(text: string): void {
		this.deps.out(`${this.clean(text)}\n`);
	}

	json(value: unknown): void {
		this.deps.out(`${this.clean(JSON.stringify(value))}\n`);
	}

	error(text: string): void {
		this.deps.err(`${this.clean(text)}\n`);
	}
}

function ledgerLine(server: CheckpointResult["server"]): string {
	switch (server.status) {
		case "recorded":
			return `ledger: recorded (event ${server.event_id})`;
		case "pending":
			return `ledger: PENDING (${server.code}: ${server.message}); run \`substrate session sync\` when the server is reachable`;
		default:
			return `ledger: NOT RECORDED (${server.code}: ${server.message}); the pending journal could not take it either (${server.journal_error})`;
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSession(argv: readonly string[], deps: SessionDeps): Promise<number> {
	const parsed = parseSessionArgs(argv);
	if (typeof parsed === "string") {
		deps.err(`${parsed}\n${SESSION_USAGE}`);
		return EXIT_USAGE;
	}
	const surface = flagValue(parsed, "surface") ?? DEFAULT_SURFACE;
	if (!(SURFACES as readonly string[]).includes(surface)) {
		deps.err(`unknown surface ${JSON.stringify(surface.slice(0, 64))}\n${SESSION_USAGE}`);
		return EXIT_USAGE;
	}
	const out = new Output(deps);
	const json = parsed.flags.has("json");
	const run = deps.run ?? spawnRunner;

	const clientFor = (forSurface: string, timeoutMs: number): RollbackServerClient => {
		const token = deps.tokenFor(forSurface);
		out.protect(token);
		return createRollbackServerClient({ url: deps.url, token, timeoutMs, fetch: deps.fetch, signalFor: deps.signalFor });
	};
	const failure = (code: string, message: string, exit = EXIT_FAILED): number => {
		if (json) out.json({ ok: false, error: { code, message } });
		else out.error(`substrate session ${parsed.sub}: ${message}`);
		return exit;
	};
	const usage = (message: string): number => {
		out.error(`${message}\n${SESSION_USAGE.trimEnd()}`);
		return EXIT_USAGE;
	};

	try {
		switch (parsed.sub) {
			case "checkpoint":
				return await commandCheckpoint(parsed, deps, out, run, surface, clientFor, usage);
			case "checkpoints":
				return await commandCheckpoints(parsed, deps, out, run, surface, clientFor, usage);
			case "rollback":
				return await commandRollback(parsed, deps, out, run, surface, clientFor, usage);
			case "recover":
				return await commandRecover(deps, out, run, json, failure);
			default:
				return await commandSync(deps, out, run, json, clientFor);
		}
	} catch (error) {
		if (error instanceof CheckpointError) return failure(error.code, error.message, error.code === "invalid-input" ? EXIT_USAGE : EXIT_FAILED);
		if (error instanceof RollbackInputError) return failure(error.code, error.message, EXIT_USAGE);
		if (error instanceof WorktreeSnapshotError || error instanceof PendingJournalError) return failure(error.code, error.message);
		return failure("unexpected", error instanceof Error ? error.message : String(error));
	}
}

type ClientFor = (surface: string, timeoutMs: number) => RollbackServerClient;
type Usage = (message: string) => number;
type Failure = (code: string, message: string, exit?: number) => number;

/** The explicit `--session`, else the only session with local checkpoints; a message when neither decides. */
async function resolveSession(
	parsed: Parsed,
	deps: SessionDeps,
	run: Runner,
	{ required }: { required: boolean },
): Promise<{ sessionId: string } | { error: string } | { sessionId: undefined }> {
	const flag = flagValue(parsed, "session");
	if (flag !== undefined) {
		if (flag.length === 0 || flag.length > 512) return { error: "--session must be 1 to 512 characters" };
		return { sessionId: flag };
	}
	const { checkpoints } = await listLocalCheckpoints({ worktree: deps.worktree, run, now: deps.now });
	const sessions = [...new Set(checkpoints.map((checkpoint) => checkpoint.session_id))];
	if (sessions.length === 1) return { sessionId: sessions[0] as string };
	if (!required) return { sessionId: undefined };
	return {
		error:
			sessions.length === 0
				? "no session is known in this worktree yet: pass --session ID"
				: `${sessions.length} sessions have checkpoints in this worktree: pass --session ID`,
	};
}

// ---------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------

async function commandCheckpoint(
	parsed: Parsed,
	deps: SessionDeps,
	out: Output,
	run: Runner,
	surface: string,
	clientFor: ClientFor,
	usage: Usage,
): Promise<number> {
	const trigger = flagValue(parsed, "trigger") ?? "manual";
	if (!(CHECKPOINT_TRIGGERS as readonly string[]).includes(trigger)) return usage(`--trigger must be one of ${CHECKPOINT_TRIGGERS.join(", ")}`);
	let transcriptRef: TranscriptRef | undefined;
	const rawRef = flagValue(parsed, "transcript-ref");
	const ompFile = flagValue(parsed, "omp-session");
	if (rawRef !== undefined && ompFile !== undefined) return usage("--transcript-ref and --omp-session are mutually exclusive: pass one");
	if (ompFile !== undefined && (ompFile.length === 0 || ompFile.length > 4096)) return usage("--omp-session must be a file path of 1 to 4096 characters");
	if (rawRef !== undefined) {
		try {
			transcriptRef = parseTranscriptRef(JSON.parse(rawRef));
		} catch (cause) {
			return usage(`--transcript-ref is not a valid transcript pointer: ${cause instanceof Error ? cause.message : "invalid JSON"}`);
		}
	}
	let transcriptSkipped: string | undefined;
	if (ompFile !== undefined) {
		const read = await ompTranscriptRefFromFile(ompFile, deps.readFile ?? readBounded);
		if ("ref" in read) transcriptRef = read.ref;
		else transcriptSkipped = read.reason;
	}
	const phase = flagValue(parsed, "plan-phase");
	const step = flagValue(parsed, "plan-step");
	const planRef: PlanRef | undefined = phase === undefined && step === undefined ? undefined : { ...(phase === undefined ? {} : { phase }), ...(step === undefined ? {} : { step }) };
	const session = await resolveSession(parsed, deps, run, { required: true });
	if ("error" in session) return usage(session.error);
	const sessionId = session.sessionId as string;

	const result = await createCheckpoint({
		worktree: deps.worktree,
		sessionId,
		trigger: trigger as CheckpointTrigger,
		...(transcriptRef === undefined ? {} : { transcriptRef }),
		...(planRef === undefined ? {} : { planRef }),
		surface,
		client: clientFor(surface, deps.timeoutMs),
		now: deps.now,
		randomBytes: deps.randomBytes,
		run,
		pendingDir: deps.pendingDir,
		policy: deps.policy,
	});
	if (parsed.flags.has("json")) {
		out.json({
			ok: true,
			command: "checkpoint",
			session_id: sessionId,
			created: result.created,
			checkpoint: checkpointView(result.checkpoint),
			file_count: result.file_count,
			skipped: result.skipped,
			...(transcriptSkipped === undefined ? {} : { transcript_ref_skipped: { source: "omp-session", reason: transcriptSkipped } }),
			ledger: result.server,
		});
		return EXIT_DONE;
	}
	const c = result.checkpoint;
	if (transcriptSkipped !== undefined) out.line(`transcript reference NOT recorded (--omp-session: ${transcriptSkipped}); the checkpoint was made without one`);
	out.line(`${result.created ? "created" : "found"} checkpoint ${c.ckpt_id} (seq ${c.seq}, ${c.trigger}) for session ${sessionId}`);
	out.line(`  tree ${c.tree}; ${result.file_count} file(s)${result.skipped.length > 0 ? `; ${result.skipped.length} skipped` : ""}`);
	for (const skipped of result.skipped.slice(0, MAX_SKIPPED_SHOWN)) out.line(`  skipped ${skipped.path} (${skipped.reason})`);
	if (result.skipped.length > MAX_SKIPPED_SHOWN) out.line(`  ... and ${result.skipped.length - MAX_SKIPPED_SHOWN} more skipped`);
	out.line(`  ${ledgerLine(result.server)}`);
	return EXIT_DONE;
}

/**
 * The checkpoint's omp transcript reference for `--omp-session`. Never throws: a file that cannot be read or
 * parsed is a typed reason (`unreadable`, or an `OmpForkError` code such as `too-large`), never its content, so
 * the checkpoint itself still succeeds. The session locator is the file's basename, never the path.
 */
async function ompTranscriptRefFromFile(
	file: string,
	readFile: (path: string, maxBytes: number) => Promise<string>,
): Promise<{ ref: TranscriptRef } | { reason: string }> {
	let sessionFileText: string;
	try {
		sessionFileText = await readFile(file, OMP_SESSION_MAX_BYTES);
	} catch (cause) {
		// The system error text names the path, so only a code is kept.
		return { reason: cause instanceof OmpForkError ? cause.code : "unreadable" };
	}
	try {
		return { ref: ompTranscriptRef({ sessionFileText, sessionLocator: basename(file), maxBytes: OMP_SESSION_MAX_BYTES }) };
	} catch (cause) {
		// Only `OmpForkError` carries a code with no session content; anything else is an unknown fault.
		return { reason: cause instanceof OmpForkError ? cause.code : "invalid-argument" };
	}
}

/** Read a regular file as UTF-8, refusing one longer than `maxBytes` without buffering more than `maxBytes + 1`. */
async function readBounded(path: string, maxBytes: number): Promise<string> {
	const handle = await open(path, "r");
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error("not a regular file");
		if (stats.size > maxBytes) throw new OmpForkError("too-large", `session file exceeds the ${maxBytes} byte cap`);
		const buffer = Buffer.allocUnsafe(Math.min(stats.size, maxBytes) + 1);
		let filled = 0;
		while (filled < buffer.length) {
			const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		// The file grew while it was read.
		if (filled > maxBytes) throw new OmpForkError("too-large", `session file exceeds the ${maxBytes} byte cap`);
		return buffer.toString("utf8", 0, filled);
	} finally {
		await handle.close();
	}
}

function checkpointView(c: LocalCheckpoint): Record<string, unknown> {
	return {
		ckpt_id: c.ckpt_id,
		seq: c.seq,
		trigger: c.trigger,
		session_id: c.session_id,
		tree: c.tree,
		created_at: c.createdAt,
		...(c.prev_ckpt_id === undefined ? {} : { prev_ckpt_id: c.prev_ckpt_id }),
		...(c.transcript_ref === undefined ? {} : { transcript_ref: c.transcript_ref }),
		...(c.plan_ref === undefined ? {} : { plan_ref: c.plan_ref }),
	};
}

// ---------------------------------------------------------------------------
// checkpoints
// ---------------------------------------------------------------------------

type LedgerView = { state: "pending" | "recorded" | "not-on-server" | "unreachable" | "unknown" | "error"; anchor?: string; code?: string };

async function commandCheckpoints(
	parsed: Parsed,
	deps: SessionDeps,
	out: Output,
	run: Runner,
	surface: string,
	clientFor: ClientFor,
	usage: Usage,
): Promise<number> {
	const session = await resolveSession(parsed, deps, run, { required: false });
	if ("error" in session) return usage(session.error);
	const { checkpoints, invalid } = await listLocalCheckpoints({ worktree: deps.worktree, run, now: deps.now });
	const shown = session.sessionId === undefined ? checkpoints : checkpointsOfSession(checkpoints, session.sessionId);
	const pendingDir = deps.pendingDir ?? (await resolvePendingDir(deps.worktree, run));
	const pending = listPending(pendingDir);
	const pendingIds = new Set(pending.items.filter((item) => item.kind === "checkpoint").map((item) => item.id));

	// Server status, newest first, when reachable: one read-only plan per checkpoint, stopping at the first unreachable answer.
	const views = new Map<string, LedgerView>();
	const client = parsed.flags.has("offline") ? null : clientFor(surface, deps.timeoutMs);
	let reachable = client !== null;
	let queried = 0;
	const newest = [...shown].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.seq - a.seq));
	for (const checkpoint of newest) {
		if (pendingIds.has(checkpoint.ckpt_id)) {
			views.set(checkpoint.ckpt_id, { state: "pending" });
		} else if (client === null || queried >= MAX_SERVER_STATUS_QUERIES) {
			views.set(checkpoint.ckpt_id, { state: "unknown" });
		} else if (!reachable) {
			views.set(checkpoint.ckpt_id, { state: "unreachable" });
		} else {
			queried++;
			const planned = await client.planRollback({ session_id: checkpoint.session_id, target_ckpt_id: checkpoint.ckpt_id });
			if (planned.ok) {
				views.set(checkpoint.ckpt_id, { state: "recorded", anchor: planned.value.plan.anchor?.status ?? "unverified" });
			} else if (planned.error.code === "target-not-found") {
				views.set(checkpoint.ckpt_id, { state: "not-on-server" });
			} else if (isUnreachable(planned.error)) {
				reachable = false;
				views.set(checkpoint.ckpt_id, { state: "unreachable", code: planned.error.code });
			} else {
				views.set(checkpoint.ckpt_id, { state: "error", code: planned.error.code });
			}
		}
	}

	const summary = {
		pending_checkpoints: pending.items.filter((item) => item.kind === "checkpoint").length,
		pending_rollbacks: pending.items.filter((item) => item.kind === "rollback").length,
		corrupt_pending: pending.corrupt.length,
	};
	if (parsed.flags.has("json")) {
		out.json({
			ok: true,
			command: "checkpoints",
			...(session.sessionId === undefined ? {} : { session_id: session.sessionId }),
			checkpoints: shown.map((checkpoint) => ({ ...checkpointView(checkpoint), ledger: views.get(checkpoint.ckpt_id) ?? { state: "unknown" } })),
			invalid,
			pending: summary,
			corrupt_pending: pending.corrupt,
		});
		return EXIT_DONE;
	}
	if (shown.length === 0) out.line("no local checkpoints");
	for (const checkpoint of shown) {
		const view = views.get(checkpoint.ckpt_id) ?? { state: "unknown" };
		const anchor = view.anchor === undefined ? "" : `, anchor ${view.anchor}`;
		out.line(`${checkpoint.session_id}  seq ${checkpoint.seq}  ${checkpoint.ckpt_id}  ${checkpoint.trigger}  ${checkpoint.createdAt}  ledger ${view.state}${anchor}`);
	}
	for (const bad of invalid) out.line(`invalid checkpoint ref ${bad.id}: ${bad.reason}`);
	if (summary.pending_checkpoints + summary.pending_rollbacks + summary.corrupt_pending > 0) {
		out.line(
			`pending: ${summary.pending_checkpoints} checkpoint(s), ${summary.pending_rollbacks} rollback commit(s)${summary.corrupt_pending > 0 ? `, ${summary.corrupt_pending} corrupt file(s)` : ""}; run \`substrate session sync\``,
		);
	}
	return EXIT_DONE;
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

function exitFor(result: RollbackResult): number {
	switch (result.status) {
		case "committed":
		case "dry-run":
			return EXIT_DONE;
		case "refused":
			return EXIT_REFUSED;
		case "commit-pending":
			return EXIT_LEDGER_PENDING;
		default:
			return EXIT_FAILED;
	}
}

async function commandRollback(
	parsed: Parsed,
	deps: SessionDeps,
	out: Output,
	run: Runner,
	surface: string,
	clientFor: ClientFor,
	usage: Usage,
): Promise<number> {
	const session = await resolveSession(parsed, deps, run, { required: true });
	if ("error" in session) return usage(session.error);
	const result = await rollback({
		worktree: deps.worktree,
		sessionId: session.sessionId as string,
		target: parsed.positional[0] as string,
		dryRun: parsed.flags.has("dry-run"),
		force: parsed.flags.has("force"),
		offline: parsed.flags.has("offline"),
		surface,
		client: clientFor(surface, Math.max(deps.timeoutMs, ROLLBACK_MIN_TIMEOUT_MS)),
		transcript: deps.transcript,
		now: deps.now,
		randomBytes: deps.randomBytes,
		run,
		pendingDir: deps.pendingDir,
		policy: deps.policy,
		hooks: deps.hooks,
	});
	const exit = exitFor(result);
	if (parsed.flags.has("json")) {
		out.json({ ok: exit === EXIT_DONE, command: "rollback", exit, ...result });
		return exit;
	}
	renderRollback(out, result);
	return exit;
}

function renderRollback(out: Output, r: RollbackResult): void {
	const target = r.target === null ? "(unresolved target)" : `${r.target.ckpt_id} (seq ${r.target.seq})`;
	if (r.recovered !== null) {
		out.line(`recovered an interrupted restore ${r.recovered.id} (${r.recovered.direction}); safety ref ${r.recovered.safety_ref}`);
	}
	for (const warning of r.warnings) out.line(`warning: ${warning}`);
	if (r.mode === "local-only") out.line(`mode: local only (${r.local_only_reason}); checkpoint is UNANCHORED`);
	else if (r.anchor !== null) out.line(`anchor: ${r.anchor.status}${r.anchor.reasons.length > 0 ? ` (${r.anchor.reasons.join("; ")})` : ""}`);
	if (r.plan !== undefined) {
		const c = r.plan.counts;
		out.line(`plan: ${c.add} add, ${c.modify} modify, ${c.delete} delete, ${c.chmod} chmod, ${c.retype} retype (${c.total} total)`);
		if (r.status === "dry-run") {
			for (const op of r.plan.operations) out.line(`  ${op.op} ${op.path}`);
			if (r.plan.operations_truncated) out.line("  ...");
		}
		if (r.plan.drift_count > 0) out.line(`drift: ${r.plan.drift_count} path(s) changed since the newest checkpoint`);
	}
	if (r.memory_preview !== undefined && r.memory_preview.would_forget > 0) {
		out.line(`memory: ${r.memory_preview.would_forget} entr${r.memory_preview.would_forget === 1 ? "y" : "ies"} would be forgotten`);
	}
	switch (r.status) {
		case "dry-run":
			out.line(`dry run: nothing was changed${r.blocked_by !== undefined && r.blocked_by.length > 0 ? `; a real run would refuse (${r.blocked_by.join(", ")})` : ""}`);
			break;
		case "refused":
			out.line(`refused (${r.refusal?.reason}): ${r.refusal?.detail}`);
			break;
		case "failed": {
			const f = r.failure;
			out.line(`failed (${f?.code}): ${f?.message}`);
			if (f !== undefined && f.safety_ref !== null) out.line(`  safety ref ${f.safety_ref}; rolled back: ${f.rolled_back === null ? "unknown" : f.rolled_back ? "yes" : "NO"}`);
			if (f?.recover) out.line(`  recover with: ${f.recover}`);
			break;
		}
		case "commit-pending":
			out.line(`rolled back to ${target}: files restored, ledger commit pending (run \`substrate session sync\`)`);
			if (r.ledger.message !== undefined) out.line(`  ${r.ledger.message}`);
			break;
		default:
			out.line(`rolled back to ${target}; ledger event ${r.ledger.event_id}`);
	}
	if (r.restore !== undefined) {
		const f = r.restore.files;
		out.line(`files: ${f.added} added, ${f.modified} modified, ${f.deleted} deleted; safety ref ${r.restore.safety_ref}`);
	}
	if (r.pre_restore !== undefined) out.line(`pre-restore checkpoint ${r.pre_restore.ckpt_id} (ledger ${r.pre_restore.server})`);
	if (r.transcript !== undefined) out.line(`transcript: ${r.transcript.outcome}${r.transcript.detail === undefined ? "" : ` (${r.transcript.detail})`}`);
	if (r.memory !== undefined) {
		out.line(`memory: ${r.memory.superseded_entries} superseded, ${r.memory.forgotten_documents} forgotten${r.memory.plane_pending ? " (plane pending)" : ""}`);
	}
}

// ---------------------------------------------------------------------------
// recover and sync
// ---------------------------------------------------------------------------

async function commandRecover(deps: SessionDeps, out: Output, run: Runner, json: boolean, failure: Failure): Promise<number> {
	try {
		const result = await recoverRestore({ worktree: deps.worktree, now: deps.now, run, hooks: deps.hooks });
		if (!result.recovered) {
			if (json) out.json({ ok: true, command: "recover", recovered: false });
			else out.line("nothing to recover");
			return EXIT_DONE;
		}
		const files = { added: result.counts.add, modified: result.counts.modify + result.counts.chmod + result.counts.retype, deleted: result.counts.delete };
		if (json) {
			out.json({ ok: true, command: "recover", recovered: true, id: result.id, direction: result.direction, files, safety_ref: result.safetyRef });
		} else {
			out.line(`recovered restore ${result.id} (${result.direction === "forward" ? "completed" : "rolled back"}): ${files.added} added, ${files.modified} modified, ${files.deleted} deleted; safety ref ${result.safetyRef}`);
		}
		return EXIT_DONE;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return failure(error instanceof WorktreeSnapshotError ? error.code : "unexpected", message);
	}
}

async function commandSync(deps: SessionDeps, out: Output, run: Runner, json: boolean, clientFor: ClientFor): Promise<number> {
	const dir = deps.pendingDir ?? (await resolvePendingDir(deps.worktree, run));
	const outcome = await replayPending({ dir, clientFor: (surface) => clientFor(surface, Math.max(deps.timeoutMs, ROLLBACK_MIN_TIMEOUT_MS)) });
	const clean = outcome.failed.length === 0 && outcome.skipped === 0 && outcome.corrupt.length === 0 && outcome.remaining === 0;
	if (json) {
		out.json({ ok: clean, command: "sync", ...outcome });
	} else {
		if (outcome.delivered.length + outcome.failed.length + outcome.skipped + outcome.corrupt.length === 0) out.line("nothing pending");
		for (const item of outcome.delivered) out.line(`delivered ${item.kind} ${item.id} (event ${item.event_id})`);
		for (const item of outcome.failed) out.line(`not delivered ${item.kind} ${item.id}: ${item.code}: ${item.message}`);
		if (outcome.skipped > 0) out.line(`${outcome.skipped} item(s) not attempted: the server was unreachable`);
		for (const bad of outcome.corrupt) out.line(`corrupt pending file ${bad.file}: ${bad.reason} (skipped, not deleted)`);
		if (outcome.remaining > 0) out.line(`${outcome.remaining} item(s) still pending`);
	}
	return clean ? EXIT_DONE : EXIT_FAILED;
}
