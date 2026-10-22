/**
 * The steering MCP tools (phase 53, SOTA-09): queue a directive, acknowledge one, and list the directives for a session.
 * Each tool is a thin shell over the inbox in `steering.ts`, which owns the allowlist, the rate limit, audit before effect,
 * and the confirm rule for a conflicting directive.
 *
 * What this module adds:
 * - Authorship comes from the authenticated caller, never from an argument. A write needs an operator caller that has a
 *   surface; the surface is the principal, and the author is a human. The allowlist stays as a second check in the inbox.
 *   The argument schemas have no author fields, so an argument that tries to name one is refused as an unknown field.
 * - Strict argument schemas. An unknown field is refused at the MCP boundary, not dropped.
 * - A typed result per tool. A write by a caller that is not an operator answers `forbidden`; a write with no injected
 *   audit sink answers `not-configured` and records nothing; a refused write carries the inbox's typed error.
 * - The sink is never built here. The inbox arrives injected through `SteeringWiring`, so this module never touches the
 *   store, the filesystem or a clock of its own.
 */
import { z } from "zod";
import { SESSION_ID_RE } from "./presence.ts";
import {
	STEERING_ACTIONS,
	STEERING_BODY_MAX,
	STEERING_OUTCOMES,
	STEERING_PRIORITIES,
	type SteeringClock,
	type SteeringError,
	type SteeringInbox,
	type SteeringOutcome,
} from "./steering.ts";

/** The inbox the tools run against, and the clock that stamps a queued directive. `inbox` is null with no audit sink. */
export interface SteeringWiring {
	/** Whether SUBSTRATE_PLANNING_STEERING is on. The tools are registered only when it is. */
	readonly enabled: boolean;
	readonly inbox: SteeringInbox | null;
	readonly clock: SteeringClock;
}

/**
 * The authenticated caller, as `createMcpServer` establishes it from the bearer token. `surface` is the token's named
 * surface, or null on a bare local run. `isOperator` is whether the token is an operator's. Neither is a tool argument.
 */
export interface SteeringCaller {
	readonly surface: string | null;
	readonly isOperator: boolean;
}

const DIRECTIVE_ID_MAX = 128;
const PLAN_ID_MAX = 64;

/** `steering_queue`. Field names are snake_case, like the other tools in `mcp.ts`. Unknown fields are refused. */
export const STEERING_QUEUE_INPUT = z
	.object({
		id: z.string().min(1).max(DIRECTIVE_ID_MAX).describe("The directive id: letters, digits and . _ : -, starting with a letter or digit."),
		target_session_id: z.string().regex(SESSION_ID_RE).describe("The planning session the directive is for."),
		action: z.enum(STEERING_ACTIONS).describe("pause, redirect or annotate."),
		priority: z.enum(STEERING_PRIORITIES).describe("low, normal or high."),
		body: z.string().min(1).max(STEERING_BODY_MAX).describe("The directive text. Secret-shaped values are redacted before they are stored."),
		plan_ref: z
			.object({
				phase: z.string().min(1).max(PLAN_ID_MAX),
				plan: z.string().min(1).max(PLAN_ID_MAX),
			})
			.strict()
			.optional()
			.describe("The phase and plan the directive refers to, when it names one."),
		conflicts_with_active_plan: z.boolean().describe("True when the directive contradicts the session's active plan. Such a directive needs confirm to be applied."),
	})
	.strict();

/** `steering_acknowledge`. The operator acknowledges for the target session with `applied` or `declined`. */
export const STEERING_ACKNOWLEDGE_INPUT = z
	.object({
		directive_id: z.string().min(1).max(DIRECTIVE_ID_MAX).describe("The id of the queued directive."),
		session_id: z.string().regex(SESSION_ID_RE).describe("The session the directive is for. It must match the directive's target."),
		outcome: z.enum(STEERING_OUTCOMES).describe("applied or declined."),
		confirm: z.boolean().optional().describe("Required true to apply a directive that conflicts with the active plan."),
	})
	.strict();

/** `steering_list`. The directives for one session, queued or acknowledged. */
export const STEERING_LIST_INPUT = z
	.object({
		session_id: z.string().regex(SESSION_ID_RE).describe("The planning session whose directives to list."),
	})
	.strict();

export type SteeringQueueInput = z.infer<typeof STEERING_QUEUE_INPUT>;
export type SteeringAcknowledgeInput = z.infer<typeof STEERING_ACKNOWLEDGE_INPUT>;
export type SteeringListInput = z.infer<typeof STEERING_LIST_INPUT>;

/** Why a write was not allowed to proceed for this caller. */
export type SteeringForbiddenReason = "operator-required" | "caller-identity-missing";

/** The result of a write. `forbidden` is the caller's; `refused` carries the inbox's typed error; `not-configured` means no audit sink. */
export type SteeringWriteResult =
	| { status: "queued"; directive_id: string; target_session_id: string; queued_at_ms: number }
	| { status: "acknowledged"; directive_id: string; outcome: SteeringOutcome; confirmed: boolean }
	| { status: "forbidden"; reason: SteeringForbiddenReason }
	| { status: "refused"; error: SteeringError }
	| { status: "not-configured" };

export interface ListedSteeringDirective {
	id: string;
	author_principal_id: string;
	priority: string;
	action: string;
	body: string;
	plan_ref: { phase: string; plan: string } | null;
	conflicts_with_active_plan: boolean;
	created_at_ms: number;
	state: "queued" | "acknowledged";
	/** Null while queued. */
	outcome: SteeringOutcome | null;
	/** False while queued. */
	confirmed: boolean;
	queued_at_ms: number;
	/** Null while queued. */
	acknowledged_at_ms: number | null;
}

/** The directives for one session, queued or acknowledged. A read: `not-configured` is not an error. */
export type SteeringListResult =
	| { status: "listed"; target_session_id: string; directives: ListedSteeringDirective[] }
	| { status: "not-configured" };

/** Whether a write was not allowed, refused, or had no sink to write to. All three are error replies. */
export function steeringFailed(result: SteeringWriteResult): boolean {
	return result.status === "forbidden" || result.status === "refused" || result.status === "not-configured";
}

type Writer = { status: "allowed"; principalId: string } | { status: "forbidden"; reason: SteeringForbiddenReason };

/** The principal a write acts as. Only an operator with a surface may write; the surface is the principal. */
function writerFor(caller: SteeringCaller): Writer {
	if (!caller.isOperator) return { status: "forbidden", reason: "operator-required" };
	if (caller.surface === null) return { status: "forbidden", reason: "caller-identity-missing" };
	return { status: "allowed", principalId: caller.surface };
}

/** Queue a directive as the calling operator. The inbox validates, checks the allowlist, rate-limits and audits. */
export async function queueSteering(wiring: SteeringWiring, caller: SteeringCaller, input: SteeringQueueInput): Promise<SteeringWriteResult> {
	const writer = writerFor(caller);
	if (writer.status === "forbidden") return writer;
	if (wiring.inbox === null) return { status: "not-configured" };
	const result = await wiring.inbox.enqueue({
		id: input.id,
		author: { principalId: writer.principalId, kind: "human" },
		createdAtMs: wiring.clock.nowMs(),
		priority: input.priority,
		targetSessionId: input.target_session_id,
		action: input.action,
		body: input.body,
		planRef: input.plan_ref,
		conflictsWithActivePlan: input.conflicts_with_active_plan,
	});
	if (!result.ok) return { status: "refused", error: result.error };
	return {
		status: "queued",
		directive_id: result.value.directive.id,
		target_session_id: result.value.directive.targetSessionId,
		queued_at_ms: result.value.queuedAtMs,
	};
}

/** Acknowledge a queued directive as the calling operator. Applying a conflicting directive needs `confirm: true`. */
export async function acknowledgeSteering(
	wiring: SteeringWiring,
	caller: SteeringCaller,
	input: SteeringAcknowledgeInput,
): Promise<SteeringWriteResult> {
	const writer = writerFor(caller);
	if (writer.status === "forbidden") return writer;
	if (wiring.inbox === null) return { status: "not-configured" };
	const result = await wiring.inbox.acknowledge({
		directiveId: input.directive_id,
		sessionId: input.session_id,
		outcome: input.outcome,
		confirm: input.confirm,
	});
	if (!result.ok) return { status: "refused", error: result.error };
	return {
		status: "acknowledged",
		directive_id: result.value.directive.id,
		outcome: input.outcome,
		confirmed: input.confirm === true,
	};
}

/** The directives for one session, queued or acknowledged, highest priority first. A read: it writes nothing. */
export function listSteering(wiring: SteeringWiring, input: SteeringListInput): SteeringListResult {
	if (wiring.inbox === null) return { status: "not-configured" };
	const directives = wiring.inbox.recordsFor(input.session_id).map((record): ListedSteeringDirective => {
		const { directive } = record;
		const base = {
			id: directive.id,
			author_principal_id: directive.author.principalId,
			priority: directive.priority,
			action: directive.action,
			body: directive.body,
			plan_ref: directive.planRef ?? null,
			conflicts_with_active_plan: directive.conflictsWithActivePlan,
			created_at_ms: directive.createdAtMs,
			queued_at_ms: record.queuedAtMs,
		};
		if (record.state === "acknowledged") {
			return {
				...base,
				state: "acknowledged",
				outcome: record.outcome,
				confirmed: record.confirmed,
				acknowledged_at_ms: record.acknowledgedAtMs,
			};
		}
		return { ...base, state: "queued", outcome: null, confirmed: false, acknowledged_at_ms: null };
	});
	return { status: "listed", target_session_id: input.session_id, directives };
}
