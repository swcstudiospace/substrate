import { createHash, randomUUID } from "node:crypto";
import type { AuditTransport } from "@substrate/audit";
import { z } from "zod";
import { bucketStep, limitFor, retryAfterSeconds, type AdmissionSettings, type BucketState } from "../admission.ts";
import type { AuditOutcome, McpToolCall } from "../observe.ts";
import type { EventInput } from "../types.ts";
import { SESSION_ID_RE } from "./presence.ts";
import { IDEMPOTENCY_KEY_PATTERN, scopeRepoId } from "../event.ts";
import { redact } from "../redact.ts";
import { acknowledgeFingerprint, keyedDirectiveId, queueFingerprint, type QueueRequestFields, type SteeringIdempotency } from "./steering-idempotency.ts";
import type { LiveSessionAccess, LiveSessionAuthority, LiveSessionCaller, LiveSessionOperation, LiveSessionSnapshot } from "./steering-sessions-store.ts";
import { sessionStateForAcknowledgement, type SessionStatePort, type SteeringAcknowledgeReply } from "./steering-delivery.ts";
import { STEERING_ACTIONS, STEERING_BODY_MAX, STEERING_OUTCOMES, STEERING_PRIORITIES, type SteeringAckReason, type SteeringClock, type SteeringConfigError, type SteeringDirective, type SteeringError, type SteeringInbox, type SteeringOutcome } from "./steering.ts";

export type SteeringCaller = LiveSessionCaller;
export const STEERING_REFUSED_ACTION = "steering.refused";
export const SESSION_BINDING_INPUT = z.string().regex(/^[a-f0-9]{64}$/).optional();
/** A client's idempotency key (phase 77): the event rule, so a key means the same thing on both surfaces. Unset means unkeyed. */
export const STEERING_IDEMPOTENCY_KEY_INPUT = z.string().regex(IDEMPOTENCY_KEY_PATTERN).optional();
export const STEERING_QUEUE_INPUT = z.object({
 target_session_id: z.string().regex(SESSION_ID_RE), action: z.enum(STEERING_ACTIONS), priority: z.enum(STEERING_PRIORITIES), body: z.string().min(1).max(STEERING_BODY_MAX),
 plan_ref: z.object({ phase: z.string().min(1).max(64), plan: z.string().min(1).max(64) }).strict().optional(),
 conflicts_with_active_plan: z.boolean(), idempotency_key: STEERING_IDEMPOTENCY_KEY_INPUT, session_binding: SESSION_BINDING_INPUT,
}).strict();
export const STEERING_ACKNOWLEDGE_INPUT = z.object({ directive_id: z.string().min(1).max(128), session_id: z.string().regex(SESSION_ID_RE), outcome: z.enum(STEERING_OUTCOMES), confirm: z.boolean().optional(), idempotency_key: STEERING_IDEMPOTENCY_KEY_INPUT, session_binding: SESSION_BINDING_INPUT }).strict();
export const LIVE_SESSION_UPDATE_INPUT = z.object({
 session_id: z.string().regex(SESSION_ID_RE).optional(), repo_id: z.string().min(1).max(256).refine((repo) => scopeRepoId(repo) !== "", "invalid repository"), state: z.enum(["ACTIVE", "CONTEXT_REFRESH", "PAUSED", "RESUMED"]),
 steering: z.string().max(16000).optional(), planning_hash: z.string().max(256).optional(), previous_state: z.enum(["ACTIVE", "CONTEXT_REFRESH", "PAUSED", "RESUMED"]).optional(), session_binding: SESSION_BINDING_INPUT,
}).strict();
export const LIVE_SESSION_TARGET_INPUT = z.object({ session_id: z.string().regex(SESSION_ID_RE), session_binding: SESSION_BINDING_INPUT }).strict();
export const DOCS_SEARCH_INPUT = z.object({
 question: z.string().max(64000), datasets: z.array(z.string()).max(32).optional(), session_id: z.string().max(128).optional(),
 steering_session_id: z.string().regex(SESSION_ID_RE).optional(), session_binding: SESSION_BINDING_INPUT, repo_id: z.string().max(256).optional(),
 steering: z.string().max(16000).optional(), planning_hash: z.string().max(256).optional(), context: z.boolean().optional(),
}).strict();
export const STEERING_LIST_INPUT = z.object({ session_id: z.string().regex(SESSION_ID_RE), session_binding: SESSION_BINDING_INPUT }).strict();
export type SteeringQueueInput = z.infer<typeof STEERING_QUEUE_INPUT>;
export type SteeringAcknowledgeInput = Omit<z.infer<typeof STEERING_ACKNOWLEDGE_INPUT>, "session_id"> & { session_id?: string | undefined };
export type SteeringListInput = z.infer<typeof STEERING_LIST_INPUT>;
export type LiveSessionRefusal = { status: "refused"; error: { code: "not-found" | "session-unavailable" } } | { status: "refused"; error: { code: "principal-rate-limited"; retry_after_s: number } };
export type LiveSessionAuditFailure = { status: "refused"; error: { code: "audit-unavailable" } };
export interface SteeringForbidden { status: "forbidden"; reason: "operator-required" }
export type LiveCallFailure = LiveSessionRefusal | LiveSessionAuditFailure | SteeringForbidden;
export const liveSessionNotFound = (): LiveSessionRefusal => ({ status: "refused", error: { code: "not-found" } });
export class LiveSessionBoundaryError extends Error {
 constructor(readonly refusal: LiveCallFailure) { super("live session request refused"); this.name = "LiveSessionBoundaryError"; }
}
export interface LiveSessionAuditPort { auditCalls(caller: LiveSessionCaller, calls: McpToolCall[], transport: AuditTransport): Promise<AuditOutcome> }
/** Trusted service invocation, never a client-provided grant. Arguments contain no injected authorization state. */
export interface LiveSessionInvocation {
 caller: LiveSessionCaller; tool: string; args: unknown; operation: LiveSessionOperation; sessionId?: string | undefined; directiveId?: string | undefined; sessionBinding?: string | undefined; kind?: "issue" | "discovery" | undefined; transport?: AuditTransport | undefined;
}
declare const preparedBrand: unique symbol;
export interface PreparedLiveCall { readonly [preparedBrand]: true }
declare const dispatchBrand: unique symbol;
export interface PreparedLiveDispatch { readonly [dispatchBrand]: true }
interface CheckedCall { invocation: LiveSessionInvocation; access: LiveSessionAccess | null; snapshot: LiveSessionSnapshot | null }
/** A SQL-backed boundary. Process-local buckets bound principals, not attacker-selected targets. */
export class LiveSessionBoundary {
 private readonly buckets = new Map<string, BucketState>();
 private readonly prepared = new WeakMap<PreparedLiveCall, CheckedCall>();
 constructor(private readonly deps: { authority: LiveSessionAuthority | null; settings: AdmissionSettings; recordRefusal: (event: EventInput) => Promise<boolean>; resolveDirective: (id: string) => string | null; nowMs?: () => number }) {}
 reserve(invocations: readonly LiveSessionInvocation[]): LiveSessionRefusal | null {
  const costs = new Map<string, { caller: LiveSessionCaller; klass: "read" | "write"; count: number }>();
  for (const invocation of invocations) {
   const klass = invocation.kind === "issue" || invocation.operation !== "private-read" ? "write" : "read";
   const key = `${invocation.caller.surface ?? "anonymous"}:${klass}`;
   const cost = costs.get(key); if (cost) cost.count++; else costs.set(key, { caller: invocation.caller, klass, count: 1 });
  }
  for (const [key, cost] of costs) {
   const step = bucketStep(this.buckets.get(key) ?? null, limitFor(this.deps.settings, cost.caller.surface, cost.klass), this.deps.nowMs?.() ?? Date.now(), cost.count);
   this.buckets.set(key, step.state);
   if (!step.allowed) return { status: "refused", error: { code: "principal-rate-limited", retry_after_s: retryAfterSeconds(step.retryAfterMs) } };
  }
  return null;
 }
 async prepare(invocation: LiveSessionInvocation): Promise<PreparedLiveCall | LiveCallFailure> {
  const limited = this.reserve([invocation]); if (limited) return limited;
  return this.prepareReserved(invocation);
 }
 async prepareBatch(invocations: readonly LiveSessionInvocation[]): Promise<PreparedLiveCall[] | LiveCallFailure> {
  const limited = this.reserve(invocations); if (limited) return limited;
  const entries: PreparedLiveCall[] = [];
  for (const invocation of invocations) { const prepared = await this.prepareReserved(invocation); if ("status" in prepared) return prepared; entries.push(prepared); }
  return entries;
 }
 private async prepareReserved(invocation: LiveSessionInvocation): Promise<PreparedLiveCall | LiveCallFailure> {
  if (this.deps.authority === null) return { status: "refused", error: { code: "session-unavailable" } };
  if (invocation.kind !== undefined) {
   if (invocation.caller.surface === null) return this.deny(invocation, "");
   return this.remember({ invocation, access: null, snapshot: null });
  }
  let sessionId = invocation.sessionId;
  if (invocation.directiveId !== undefined) {
   const target = this.deps.resolveDirective(invocation.directiveId);
   if (target === null || (sessionId !== undefined && sessionId !== target)) return this.deny(invocation, invocation.directiveId);
   sessionId = target;
  }
  const access: LiveSessionAccess = { caller: { surface: invocation.caller.surface, isOperator: invocation.caller.isOperator }, sessionId: sessionId ?? "", ...(invocation.sessionBinding === undefined ? {} : { sessionBinding: invocation.sessionBinding }) };
  const found = await this.read(access, invocation.operation);
  if (!found.ok) return found.error.code === "not-found" ? this.deny(invocation, sessionId ?? "") : { status: "refused", error: { code: "session-unavailable" } };
  if (invocation.operation === "owner-transition" && invocation.args !== null && typeof invocation.args === "object" && "repo_id" in invocation.args && (typeof invocation.args.repo_id !== "string" || scopeRepoId(invocation.args.repo_id) !== found.snapshot.session.repo_id)) return this.deny(invocation, sessionId ?? "");
  if ((invocation.operation === "operator-queue" || invocation.operation === "operator-ack") && !invocation.caller.isOperator) {
   await this.recordDenial(invocation, sessionId ?? "");
   return { status: "forbidden", reason: "operator-required" };
  }
  return this.remember({ invocation, access, snapshot: found.snapshot });
 }
 private remember(value: CheckedCall): PreparedLiveCall { const token = Object.freeze({}) as PreparedLiveCall; this.prepared.set(token, value); return token; }
 checked(prepared: PreparedLiveCall): { access: LiveSessionAccess; snapshot: LiveSessionSnapshot } | null {
  const value = this.prepared.get(prepared); if (!value) throw new LiveSessionBoundaryError(liveSessionNotFound());
  return value.access === null || value.snapshot === null ? null : { access: value.access, snapshot: value.snapshot };
 }
 async recheck(prepared: PreparedLiveCall): Promise<void> {
  const value = this.prepared.get(prepared); if (!value) throw new LiveSessionBoundaryError(liveSessionNotFound());
  if (value.access === null) { if (this.deps.authority === null) throw new LiveSessionBoundaryError({ status: "refused", error: { code: "session-unavailable" } }); return; }
  const found = await this.read(value.access, value.invocation.operation);
  if (!found.ok) {
   if (found.error.code === "not-found") await this.recordDenial(value.invocation, value.access.sessionId);
   throw new LiveSessionBoundaryError(found.error.code === "not-found" ? liveSessionNotFound() : { status: "refused", error: { code: "session-unavailable" } });
  }
  value.snapshot = found.snapshot;
 }
 private async read(access: LiveSessionAccess, operation: LiveSessionOperation) {
  try { return await this.deps.authority?.read(access, operation) ?? { ok: false as const, error: { code: "session-unavailable" as const } }; }
  catch { return { ok: false as const, error: { code: "session-unavailable" as const } }; }
 }
 private async deny(invocation: LiveSessionInvocation, target: string): Promise<LiveSessionRefusal> { await this.recordDenial(invocation, target); return liveSessionNotFound(); }
 private async recordDenial(invocation: LiveSessionInvocation, target: string): Promise<void> {
  const digest = createHash("sha256").update("substrate.live-session-refusal.v1\0").update(target.slice(0, 128)).digest("hex");
  try { await this.deps.recordRefusal({ surface: invocation.caller.surface ?? "substrate", kind: "warning", summary: "live session request refused", payload: { action: STEERING_REFUSED_ACTION, operation: invocation.tool, caller_surface: invocation.caller.surface, operator: invocation.caller.isOperator, target_sha256: digest } }); } catch { /* Refusal remains identical when its audit is unavailable. */ }
 }
}
export interface SteeringWiring {
 readonly enabled: boolean; readonly inbox: SteeringInbox | null; readonly clock: SteeringClock; readonly settingsErrors: readonly SteeringConfigError[]; readonly newDirectiveId?: () => string;
 readonly boundary: LiveSessionBoundary;
 readonly idempotency: SteeringIdempotency<SteeringAcknowledgeReply>;
 readonly executeLiveCall: <T>(invocation: LiveSessionInvocation, effect: (prepared: PreparedLiveCall) => Promise<T>, dispatch?: PreparedLiveDispatch) => Promise<T>;
}
export type SteeringWriteResult = { status: "queued"; directive_id: string; target_session_id: string; queued_at_ms: number; sequence?: number } | { status: "acknowledged"; directive_id: string; outcome: SteeringOutcome; confirmed: boolean; sequence?: number } | LiveCallFailure | { status: "refused"; error: SteeringError } | { status: "misconfigured"; errors: SteeringConfigError[] } | { status: "not-configured" };
export interface ListedSteeringDirective { id: string; author_principal_id: string; priority: string; action: string; body: string; plan_ref: { phase: string; plan: string } | null; conflicts_with_active_plan: boolean; created_at_ms: number; state: "queued" | "acknowledged"; outcome: SteeringOutcome | null; confirmed: boolean; queued_at_ms: number; acknowledged_at_ms: number | null; reason: SteeringAckReason | null }
export type SteeringListResult = { status: "listed"; target_session_id: string; directives: ListedSteeringDirective[]; session_state: { status: "held"; state: string } } | LiveCallFailure | { status: "misconfigured"; errors: SteeringConfigError[] } | { status: "not-configured" };
export function steeringFailed(result: SteeringWriteResult): boolean { return result.status !== "queued" && result.status !== "acknowledged"; }
function settingsFailure(wiring: SteeringWiring): { status: "misconfigured"; errors: SteeringConfigError[] } | null { return wiring.settingsErrors.length ? { status: "misconfigured", errors: [...wiring.settingsErrors] } : null; }
export async function queueSteering(wiring: SteeringWiring, caller: SteeringCaller, input: SteeringQueueInput, dispatch?: PreparedLiveDispatch, transport: AuditTransport = "mcp"): Promise<SteeringWriteResult> {
 try { return await wiring.executeLiveCall<SteeringWriteResult>({ caller, tool: "steering_queue", args: input, operation: "operator-queue", sessionId: input.target_session_id, sessionBinding: input.session_binding, transport }, async () => {
  const failure = settingsFailure(wiring); if (failure) return failure; const inbox = wiring.inbox; if (inbox === null) return { status: "not-configured" };
  if (caller.surface === null) throw new LiveSessionBoundaryError(liveSessionNotFound());
  const surface = caller.surface; const key = input.idempotency_key;
  if (key === undefined) return enqueueDirective(wiring, inbox, surface, input, wiring.newDirectiveId?.() ?? randomUUID());
  return wiring.idempotency.serialize(surface, key, () => keyedQueue(wiring, inbox, surface, key, input));
 }, dispatch); } catch (cause) { if (cause instanceof LiveSessionBoundaryError) return cause.refusal; throw cause; }
}
/** Queues one directive as the inbox answers it. The reply carries no sequence: that is for keyed requests only. */
async function enqueueDirective(wiring: SteeringWiring, inbox: SteeringInbox, surface: string, input: SteeringQueueInput, id: string): Promise<SteeringWriteResult> {
 const result = await inbox.enqueue({ id, author: { principalId: surface, kind: "human" }, createdAtMs: wiring.clock.nowMs(), priority: input.priority, targetSessionId: input.target_session_id, action: input.action, body: input.body, planRef: input.plan_ref, conflictsWithActivePlan: input.conflicts_with_active_plan });
 if (!result.ok) return { status: "refused", error: result.error };
 return { status: "queued", directive_id: result.value.directive.id, target_session_id: result.value.directive.targetSessionId, queued_at_ms: result.value.queuedAtMs };
}
/**
 * A keyed queue (D77-04): the directive the key names is replayed from the inbox when its request fingerprint matches, and the
 * first application carries its sequence. Another request under the key is refused and writes nothing.
 */
async function keyedQueue(wiring: SteeringWiring, inbox: SteeringInbox, surface: string, key: string, input: SteeringQueueInput): Promise<SteeringWriteResult> {
 const id = keyedDirectiveId(surface, key);
 const held = inbox.get(id);
 if (held !== null) {
  if (queueFingerprint(queueRequestFields(input)) !== queueFingerprint(queueRecordFields(held.directive))) return { status: "refused", error: { code: "idempotency-conflict" } };
  return { status: "queued", directive_id: id, target_session_id: held.directive.targetSessionId, queued_at_ms: held.queuedAtMs, sequence: deliverySequence(inbox, id) };
 }
 const queued = await enqueueDirective(wiring, inbox, surface, input, id);
 if (queued.status !== "queued") return queued;
 return { ...queued, sequence: deliverySequence(inbox, id) };
}
function queueRequestFields(input: SteeringQueueInput): QueueRequestFields {
 return { action: input.action, priority: input.priority, targetSessionId: input.target_session_id, body: redact(input.body), planRef: input.plan_ref ?? null, conflictsWithActivePlan: input.conflicts_with_active_plan };
}
/** The same fields as {@link queueRequestFields}, read from a stored directive. Its body is already redacted once, as the request's is. */
function queueRecordFields(directive: SteeringDirective): QueueRequestFields {
 return { action: directive.action, priority: directive.priority, targetSessionId: directive.targetSessionId, body: directive.body, planRef: directive.planRef ?? null, conflictsWithActivePlan: directive.conflictsWithActivePlan };
}
/** The delivery sequence the inbox gave a directive it holds. A missing inbox or sequence is an internal fault, never a guessed number. */
function deliverySequence(inbox: SteeringInbox | null, directiveId: string): number {
 const sequence = inbox?.sequenceOf(directiveId) ?? null;
 if (sequence === null) throw new Error("steering directive held without a delivery sequence");
 return sequence;
}
/**
 * Runs an acknowledgement effect once per key when the request carries one (D77-05). The first applied acknowledgement is kept with
 * its sequence and fingerprint. A replay with the same fingerprint returns that reply and runs nothing; another request under the
 * key is refused. A refused effect is not kept, so a retry runs it again. An unkeyed request runs the effect as before.
 */
async function applyAcknowledgement(wiring: SteeringWiring, input: SteeringAcknowledgeInput, prepared: PreparedLiveCall, run: () => Promise<SteeringAcknowledgeReply>): Promise<SteeringAcknowledgeReply> {
 const key = input.idempotency_key;
 if (key === undefined) return run();
 const checked = wiring.boundary.checked(prepared); if (checked === null) throw new LiveSessionBoundaryError(liveSessionNotFound());
 const surface = checked.access.caller.surface; if (surface === null) throw new LiveSessionBoundaryError(liveSessionNotFound());
 const fingerprint = acknowledgeFingerprint({ directiveId: input.directive_id, sessionId: checked.access.sessionId, outcome: input.outcome, confirmed: input.confirm === true });
 return wiring.idempotency.serialize(surface, key, async (): Promise<SteeringAcknowledgeReply> => {
  const stored = wiring.idempotency.recall(surface, key);
  if (stored !== null) return stored.fingerprint === fingerprint ? stored.reply : { status: "refused", error: { code: "idempotency-conflict" } };
  const reply = await run();
  if (reply.status !== "acknowledged") return reply;
  const keyed: SteeringAcknowledgeReply = { ...reply, sequence: deliverySequence(wiring.inbox, reply.directive_id) };
  wiring.idempotency.remember(surface, key, fingerprint, keyed);
  return keyed;
 });
}
/** Internal inbox effect; only the enclosing executeLiveCall wrapper supplies this opaque checked token. */
async function acknowledgeSteeringEffect(wiring: SteeringWiring, input: SteeringAcknowledgeInput, prepared: PreparedLiveCall): Promise<SteeringWriteResult> {
 const checked = wiring.boundary.checked(prepared); if (checked === null) throw new LiveSessionBoundaryError(liveSessionNotFound());
 const failure = settingsFailure(wiring); if (failure) return failure; if (wiring.inbox === null) return { status: "not-configured" };
 const result = await wiring.inbox.acknowledge({ directiveId: input.directive_id, sessionId: checked.access.sessionId, outcome: input.outcome, confirm: input.confirm });
 if (!result.ok) return { status: "refused", error: result.error };
 return { status: "acknowledged", directive_id: result.value.directive.id, outcome: input.outcome, confirmed: input.confirm === true };
}
export async function acknowledgeSteering(wiring: SteeringWiring, caller: SteeringCaller, input: SteeringAcknowledgeInput, dispatch?: PreparedLiveDispatch): Promise<SteeringWriteResult> {
 try { return await wiring.executeLiveCall<SteeringWriteResult>({ caller, tool: "steering_acknowledge", args: input, operation: "operator-ack", sessionId: input.session_id, directiveId: input.directive_id, sessionBinding: input.session_binding }, prepared => applyAcknowledgement(wiring, input, prepared, () => acknowledgeSteeringEffect(wiring, input, prepared)), dispatch); }
 catch (cause) { if (cause instanceof LiveSessionBoundaryError) return cause.refusal; throw cause; }
}
export async function listSteering(wiring: SteeringWiring, caller: SteeringCaller, input: SteeringListInput, dispatch?: PreparedLiveDispatch): Promise<SteeringListResult> {
 try { return await wiring.executeLiveCall<SteeringListResult>({ caller, tool: "steering_list", args: input, operation: "private-read", sessionId: input.session_id, sessionBinding: input.session_binding }, async prepared => {
  const failure = settingsFailure(wiring); if (failure) return failure; if (wiring.inbox === null) return { status: "not-configured" };
  const checked = wiring.boundary.checked(prepared); if (checked === null) throw new LiveSessionBoundaryError(liveSessionNotFound());
  const directives = wiring.inbox.recordsFor(checked.access.sessionId).map((record): ListedSteeringDirective => {
   const { directive } = record; return { id: directive.id, author_principal_id: directive.author.principalId, priority: directive.priority, action: directive.action, body: directive.body, plan_ref: directive.planRef ?? null, conflicts_with_active_plan: directive.conflictsWithActivePlan, created_at_ms: directive.createdAtMs, queued_at_ms: record.queuedAtMs, state: record.state, outcome: record.state === "acknowledged" ? record.outcome : null, confirmed: record.state === "acknowledged" && record.confirmed, acknowledged_at_ms: record.state === "acknowledged" ? record.acknowledgedAtMs : null, reason: record.state === "acknowledged" ? record.reason ?? null : null };
  });
  await wiring.boundary.recheck(prepared);
  return { status: "listed", target_session_id: checked.access.sessionId, directives, session_state: { status: "held", state: checked.snapshot.session.state } };
 }, dispatch); } catch (cause) { if (cause instanceof LiveSessionBoundaryError) return cause.refusal; throw cause; }
}
/**
 * Acknowledge a directive, then drive the session state from the outcome. The acknowledgement is audited first and stands
 * whatever the port says: a refused transition is reported in `session_state`, not rolled back. An applied pause or redirect
 * that moved the session (its state actually changed) also carries `checkpoint_hint` (the session may checkpoint); one that left it where it was reports `session_state` unchanged and no hint. With no port the reply is exactly the acknowledgement's.
 */
export async function acknowledgeSteeringWithState(
	wiring: SteeringWiring,
	caller: SteeringCaller,
	input: SteeringAcknowledgeInput,
	port: SessionStatePort | null,
	dispatch?: PreparedLiveDispatch,
	transport: AuditTransport = "mcp",
): Promise<SteeringAcknowledgeReply> {
	try {
		return await wiring.executeLiveCall<SteeringAcknowledgeReply>({
			caller,
			tool: "steering_acknowledge",
			args: input,
			operation: "operator-ack",
			sessionId: input.session_id,
			directiveId: input.directive_id,
			sessionBinding: input.session_binding,
			transport,
		}, (prepared): Promise<SteeringAcknowledgeReply> => applyAcknowledgement(wiring, input, prepared, async (): Promise<SteeringAcknowledgeReply> => {
			const checked = wiring.boundary.checked(prepared);
			if (checked === null) return { status: "refused", error: { code: "not-found" } };
			const result = await acknowledgeSteeringEffect(wiring, input, prepared);
			if (result.status !== "acknowledged" || port === null || wiring.inbox === null) return result;
			const record = wiring.inbox.get(result.directive_id);
			if (record === null || record.state !== "acknowledged") return result;
			const target = sessionStateForAcknowledgement({ action: record.directive.action, outcome: record.outcome, reason: record.reason ?? null });
			if (target === null) return { ...result, session_state: { status: "unchanged" } };
			try { await wiring.boundary.recheck(prepared); }
			catch { return { ...result, session_state: { status: "refused", state: target, reason: "session-unavailable" } }; }
			try {
				const moved = await port.applyTransition(record.directive.targetSessionId, target, {
					...checked.access,
					directiveId: result.directive_id,
					operation: "operator-ack",
				});
				if (!moved.ok) {
					const reason = moved.reason === "not-found" || moved.reason === "invalid-transition" ? moved.reason : "session-unavailable";
					return { ...result, session_state: { status: "refused", state: target, reason } };
				}
				if (!moved.changed) return { ...result, session_state: { status: "unchanged" } };
				// Preserve the committed movement receipt; later revocation withholds only the private checkpoint hint.
				wiring.inbox.noteSessionMoved(result.directive_id);
				try { await wiring.boundary.recheck(prepared); }
				catch { return { ...result, session_state: { status: "applied", state: target } }; }
				return { ...result, session_state: { status: "applied", state: target }, checkpoint_hint: { trigger: "steering", directive_id: result.directive_id } };
			} catch {
				// An effective acknowledgement stands; private port/driver diagnostics never enter its reply.
				return { ...result, session_state: { status: "refused", state: target, reason: "session-unavailable" } };
			}
		}), dispatch);
	} catch (cause) {
		if (cause instanceof LiveSessionBoundaryError) return cause.refusal;
		throw cause;
	}
}
