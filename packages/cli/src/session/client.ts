/**
 * The client side of the three session rollback MCP tools (v1.6, phase 61): `session_checkpoint`,
 * `session_rollback_plan` and `session_rollback_commit`. Each call is one JSON-RPC 2.0 `tools/call` POSTed
 * to `/mcp` with the bearer the CLI resolves for the surface, exactly as `lessons.ts` calls `memory_search`;
 * the server answers statelessly as plain JSON or one SSE `data:` line, and the tool result is JSON text in
 * `content[0].text`: `{ok:true, ...}` or `{ok:false, error:{code, message}}`.
 *
 * The server never touches a worktree; this client carries only ids, digests and counts.
 *
 * The client NEVER throws. Every failure is `{ ok: false, error: { code, message, retryable } }`:
 *   network | timeout          the server did not answer (retryable)
 *   server-error | rate-limited  HTTP 5xx and 429 (retryable)
 *   unauthorized               HTTP 401 or 403 (not retryable; the token is wrong or missing)
 *   http-<status>              any other non-2xx answer without a usable result
 *   bad-response               not JSON, or a result that does not match the contract
 *   rpc-error | tool-error     a JSON-RPC error, or a tool result flagged `isError`
 *   <server code>              an `{ok:false, error:{code}}` answer, passed through (`stale-plan`, ...)
 * The bearer is never put into an error: every diagnostic is scrubbed of it, of URL credentials and
 * query values, and of anything the redactor recognises, and capped.
 *
 * Fetch and the timeout signal are injected, so tests need neither a network nor a real delay.
 */
import { redact, redactKnown } from "../../../mcp-server/src/redact.ts";
import {
	type CheckpointPayload,
	type RollbackRefusalReason,
	type RollbackTranscriptOutcome,
	type TranscriptRef,
	parseTranscriptRef,
} from "../../../mcp-server/src/session-events.ts";

/** The shapes `newCheckpointId` and `newRollbackId` mint: `ckpt_` / `rb_` plus 26 characters of 0-9 a-z. */
export const CKPT_ID_PATTERN = /^ckpt_[0-9a-z]{26}$/;
export const ROLLBACK_ID_PATTERN = /^rb_[0-9a-z]{26}$/;

interface ClientError {
	code: string;
	message: string;
	retryable: boolean;
}

export type ClientFailure = { ok: false; error: ClientError };
export type ClientResult<T> = { ok: true; value: T } | ClientFailure;

/** A `session.checkpoint` payload without `action`, plus the session the checkpoint belongs to. */
export type RecordCheckpointRequest = Omit<CheckpointPayload, "action"> & { session_id: string };
export interface RecordCheckpointOk {
	ckpt_id: string;
	event_id: string;
	stored: boolean;
}

export type AnchorStatus = "anchored" | "pending" | "unanchored" | "unverified" | "mismatch";
const ANCHOR_STATUSES: readonly AnchorStatus[] = ["anchored", "pending", "unanchored", "unverified", "mismatch"];

export interface RollbackPlan {
	rollback_id: string;
	session_id: string;
	target: {
		ckpt_id: string;
		seq: number;
		event_id: string;
		event_hash: string;
		git_tree: string;
		manifest_sha256: string;
		transcript_ref?: TranscriptRef;
	};
	later_checkpoints: Array<{ ckpt_id: string; seq: number }>;
	anchor: { status: AnchorStatus; reasons: string[] } | null;
	memory: { would_forget: number; sample_ids: string[]; truncated: boolean };
	plan_digest: string;
}

export type PlanRollbackRequest = {
	session_id: string;
	target_ckpt_id: string;
	rollback_id?: string;
	/** Epoch ms bounding the memory the plan reaches: what the session wrote after it belongs to the new timeline. Absent means now. */
	until_ms?: number;
};

export type CommittedRollbackFields = {
	from_ckpt_id: string;
	pre_restore_tree: string;
	pre_restore_ckpt_id: string;
	files: { added: number; modified: number; deleted: number };
	transcript: RollbackTranscriptOutcome;
	local_only?: boolean;
	/** The same bound the plan was made with, so a late commit selects the same memory. */
	until_ms?: number;
};

export type CommitRollbackRequest = { session_id: string; rollback_id: string; target_ckpt_id: string; plan_digest?: string } & (
	| ({ outcome: "committed" } & CommittedRollbackFields)
	| { outcome: "refused"; reason: RollbackRefusalReason; detail?: string }
);

export interface CommitRollbackOk {
	event_id: string;
	memory?: { superseded_entries: number; forgotten_documents: number; plane_pending: boolean; truncated: boolean };
}

export type PlanRollbackResult = ClientResult<{ plan: RollbackPlan }>;

export interface RollbackServerClient {
	recordCheckpoint(request: RecordCheckpointRequest): Promise<ClientResult<RecordCheckpointOk>>;
	planRollback(request: PlanRollbackRequest): Promise<PlanRollbackResult>;
	commitRollback(request: CommitRollbackRequest): Promise<ClientResult<CommitRollbackOk>>;
}

/** The subset of `fetch` this client uses. */
export type FetchLike = (input: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface ClientOptions {
	url: string;
	/** The resolved bearer, if any. Never logged and never put in an error. */
	token?: string;
	timeoutMs: number;
	fetch?: FetchLike;
	/** The abort signal for one request. Injected so tests need no real delay; default is `AbortSignal.timeout`. */
	signalFor?: (timeoutMs: number) => AbortSignal;
}

const MAX_DIAGNOSTIC_CHARS = 300;
const MAX_ID_CHARS = 512;

/** Server answers that mean "the server could not do this now", as opposed to "the server refuses". */
const UNREACHABLE_CODES: Record<string, true> = {
	network: true,
	timeout: true,
	"server-error": true,
	"rate-limited": true,
	"ledger-down": true,
	unavailable: true,
};
/** Server-reported codes worth retrying later. */
const RETRYABLE_SERVER_CODES: Record<string, true> = { "ledger-down": true, unavailable: true, busy: true, "session-busy": true, timeout: true };

/** True when the failure means the server (or its ledger) could not be reached or could not answer at all. */
export function isUnreachable(error: ClientError): boolean {
	return Object.hasOwn(UNREACHABLE_CODES, error.code);
}

/** The failure an offline client returns for every call: the caller decides what to do locally. */
function offlineFailure(): ClientFailure {
	return { ok: false, error: { code: "offline", message: "the server was not contacted (offline mode or the server is unreachable)", retryable: true } };
}

/** A client that never contacts a server. Every call fails retryably with code `offline`. */
export function offlineClient(): RollbackServerClient {
	return {
		recordCheckpoint: async () => offlineFailure(),
		planRollback: async () => offlineFailure(),
		commitRollback: async () => offlineFailure(),
	};
}

class ContractError extends Error {}

type Rec = Record<string, unknown>;

function asRec(value: unknown, path: string): Rec {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ContractError(`${path} must be an object`);
	return value as Rec;
}

function asStr(value: unknown, path: string, max = MAX_ID_CHARS): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) throw new ContractError(`${path} must be a non-empty string`);
	return value;
}

function asInt(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ContractError(`${path} must be a non-negative integer`);
	return value;
}

function asBool(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") throw new ContractError(`${path} must be a boolean`);
	return value;
}

function asArr(value: unknown, path: string, max: number): unknown[] {
	if (!Array.isArray(value) || value.length > max) throw new ContractError(`${path} must be an array of at most ${max} items`);
	return value;
}

function parseRecordOk(body: Rec): RecordCheckpointOk {
	return { ckpt_id: asStr(body.ckpt_id, "ckpt_id"), event_id: asStr(body.event_id, "event_id"), stored: asBool(body.stored, "stored") };
}

function parsePlan(value: unknown): RollbackPlan {
	const plan = asRec(value, "plan");
	const target = asRec(plan.target, "plan.target");
	const anchorRaw = plan.anchor;
	let anchor: RollbackPlan["anchor"] = null;
	if (anchorRaw !== null && anchorRaw !== undefined) {
		const rec = asRec(anchorRaw, "plan.anchor");
		const status = asStr(rec.status, "plan.anchor.status", 32);
		if (!(ANCHOR_STATUSES as readonly string[]).includes(status)) throw new ContractError("plan.anchor.status is not a known status");
		anchor = {
			status: status as AnchorStatus,
			reasons: asArr(rec.reasons, "plan.anchor.reasons", 20).map((reason, i) => asStr(reason, `plan.anchor.reasons[${i}]`, 200)),
		};
	}
	const memory = asRec(plan.memory, "plan.memory");
	const parsedTarget: RollbackPlan["target"] = {
		ckpt_id: asStr(target.ckpt_id, "plan.target.ckpt_id"),
		seq: asInt(target.seq, "plan.target.seq"),
		event_id: asStr(target.event_id, "plan.target.event_id"),
		event_hash: asStr(target.event_hash, "plan.target.event_hash"),
		git_tree: asStr(target.git_tree, "plan.target.git_tree"),
		manifest_sha256: asStr(target.manifest_sha256, "plan.target.manifest_sha256"),
	};
	if (target.transcript_ref !== undefined && target.transcript_ref !== null) {
		parsedTarget.transcript_ref = parseTranscriptRef(target.transcript_ref, "plan.target.transcript_ref");
	}
	return {
		rollback_id: asStr(plan.rollback_id, "plan.rollback_id"),
		session_id: asStr(plan.session_id, "plan.session_id"),
		target: parsedTarget,
		later_checkpoints: asArr(plan.later_checkpoints, "plan.later_checkpoints", 100_000).map((item, i) => {
			const rec = asRec(item, `plan.later_checkpoints[${i}]`);
			return { ckpt_id: asStr(rec.ckpt_id, `plan.later_checkpoints[${i}].ckpt_id`), seq: asInt(rec.seq, `plan.later_checkpoints[${i}].seq`) };
		}),
		anchor,
		memory: {
			would_forget: asInt(memory.would_forget, "plan.memory.would_forget"),
			sample_ids: asArr(memory.sample_ids, "plan.memory.sample_ids", 20).map((id, i) => asStr(id, `plan.memory.sample_ids[${i}]`)),
			truncated: asBool(memory.truncated, "plan.memory.truncated"),
		},
		plan_digest: asStr(plan.plan_digest, "plan.plan_digest", 256),
	};
}

function parseCommitOk(body: Rec): CommitRollbackOk {
	const ok: CommitRollbackOk = { event_id: asStr(body.event_id, "event_id") };
	if (body.memory !== undefined && body.memory !== null) {
		const memory = asRec(body.memory, "memory");
		ok.memory = {
			superseded_entries: asInt(memory.superseded_entries, "memory.superseded_entries"),
			forgotten_documents: asInt(memory.forgotten_documents, "memory.forgotten_documents"),
			plane_pending: asBool(memory.plane_pending, "memory.plane_pending"),
			truncated: asBool(memory.truncated, "memory.truncated"),
		};
	}
	return ok;
}

/** The JSON-RPC envelope from a body that is plain JSON or one SSE `data:` line; null when it is neither. */
function parseEnvelope(text: string): Rec | null {
	const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? text;
	try {
		const value: unknown = JSON.parse(data);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : null;
	} catch {
		// Not JSON: the caller reports a bad-response (or the HTTP status) instead.
		return null;
	}
}

export function createRollbackServerClient(options: ClientOptions): RollbackServerClient {
	const base = options.url.replace(/\/+$/, "");
	const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
	const signalFor = options.signalFor ?? ((ms: number) => AbortSignal.timeout(ms));
	const secrets: string[] = [];
	if (options.token) secrets.push(options.token, JSON.stringify(options.token).slice(1, -1));

	function scrub(text: string): string {
		const urls = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (match) => {
			try {
				const url = new URL(match);
				return `${url.origin}${url.pathname}`;
			} catch {
				return "[invalid URL]";
			}
		});
		return redact(redactKnown(urls, secrets)).slice(0, MAX_DIAGNOSTIC_CHARS);
	}

	function fail(code: string, message: string, retryable: boolean): ClientFailure {
		return { ok: false, error: { code, message: scrub(message), retryable } };
	}

	async function call<T>(tool: string, args: Rec, parse: (body: Rec) => T): Promise<ClientResult<T>> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (options.token) headers.authorization = `Bearer ${options.token}`;
		let status: number;
		let text: string;
		try {
			const response = await doFetch(`${base}/mcp`, {
				method: "POST",
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
				signal: signalFor(options.timeoutMs),
			});
			status = response.status;
			text = await response.text();
		} catch (cause) {
			const name = cause instanceof Error ? cause.name : "";
			const reason = cause instanceof Error ? cause.message : String(cause);
			if (name === "TimeoutError" || name === "AbortError") return fail("timeout", `${tool} did not answer within ${options.timeoutMs} ms`, true);
			return fail("network", `${tool} could not reach the server: ${reason}`, true);
		}
		if (status === 401 || status === 403) return fail("unauthorized", `${tool} was refused with HTTP ${status}: check the bearer token for this surface`, false);
		if (status === 429) return fail("rate-limited", `${tool} was rate limited (HTTP 429)`, true);
		const envelope = parseEnvelope(text);
		if (status >= 500) return fail("server-error", `${tool} answered HTTP ${status}`, true);
		if (envelope === null) {
			if (status >= 200 && status < 300) return fail("bad-response", `${tool} answered HTTP ${status} with no JSON-RPC reply`, false);
			return fail(`http-${status}`, `${tool} answered HTTP ${status}`, false);
		}
		const rpcError = envelope.error;
		if (rpcError !== undefined && rpcError !== null) {
			const detail = typeof rpcError === "object" && !Array.isArray(rpcError) ? (rpcError as Rec).message : undefined;
			return fail("rpc-error", `${tool} was refused: ${typeof detail === "string" ? detail : "JSON-RPC error"}`, false);
		}
		const result = typeof envelope.result === "object" && envelope.result !== null ? (envelope.result as Rec) : null;
		if (result === null) return fail(status >= 200 && status < 300 ? "bad-response" : `http-${status}`, `${tool} answered HTTP ${status} without a result`, false);
		const content = Array.isArray(result.content) ? result.content : [];
		const first: unknown = content[0];
		const contentText = typeof first === "object" && first !== null && typeof (first as Rec).text === "string" ? ((first as Rec).text as string) : "";
		if (result.isError === true) return fail("tool-error", `${tool} failed: ${contentText || "no detail"}`, false);
		let body: unknown;
		try {
			body = JSON.parse(contentText);
		} catch {
			// A tool result that is not JSON breaks the contract; reported below as bad-response.
			return fail("bad-response", `${tool} answered with a result that is not JSON`, false);
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("bad-response", `${tool} answered with a result that is not an object`, false);
		const record = body as Rec;
		if (record.ok === false) {
			const error = typeof record.error === "object" && record.error !== null ? (record.error as Rec) : {};
			const code = typeof error.code === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(error.code) ? error.code : "server-rejected";
			const message = typeof error.message === "string" ? error.message : "the server refused the request";
			return fail(code, message, Object.hasOwn(RETRYABLE_SERVER_CODES, code));
		}
		if (record.ok !== true) return fail("bad-response", `${tool} answered with neither ok:true nor ok:false`, false);
		try {
			return { ok: true, value: parse(record) };
		} catch (cause) {
			if (cause instanceof ContractError) return fail("bad-response", `${tool} answered with an invalid result: ${cause.message}`, false);
			if (cause instanceof Error && cause.name === "SessionEventError") return fail("bad-response", `${tool} answered with an invalid result: ${cause.message}`, false);
			throw cause;
		}
	}

	return {
		recordCheckpoint: (request) => call("session_checkpoint", request, parseRecordOk),
		planRollback: (request) => call("session_rollback_plan", request, (body) => ({ plan: parsePlan(body.plan) })),
		commitRollback: (request) => call("session_rollback_commit", request, parseCommitOk),
	};
}
