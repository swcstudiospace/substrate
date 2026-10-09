/**
 * The Definition-of-Done gate on `graph_complete` (MIRROR-04).
 *
 * Only hermes-linear-connector's explicit approval moves a Linear issue to
 * Done: without `dod` evidence the connector is never called (its
 * `SyncEngine.complete_issue` also approves on a stored Kanban `dod_pass`, so
 * an evidence-free call could let an empty completion reach Done), and only an
 * explicit `completed: true` counts.
 *
 * Sequence (D23-15 steps 2-6; step 1, the fenced review write, lives in
 * service.ts because it owns the index):
 *
 * 2. Linear already reports `completed` (an earlier gate timed out after the
 *    connector moved it) → approved, skipping review and the connector.
 * 3. Mirror review to In Review on both trackers; a failure is a warning in
 *    the returned `mirrorFailures` and the sequence continues.
 * 4. No `dod` → no connector call, `dod-required`. With `dod`, POST
 *    `{hermesLinearUrl}/v1/complete-issue` with `{linear_issue_id, summary,
 *    tests_pass, review_pass}` and no auth. Only an explicit `completed: true`
 *    approves. Non-2xx, unreachable and malformed replies refuse; a timeout
 *    settles by reading the issue's Linear state.
 * 5/6. Approval and refusal handling live in service.ts, which owns the fenced
 *    completion and the warning events.
 *
 * The gate never sees a lease id: it takes a MirrorContext, and the connector
 * request carries only the issue ref and the evidence. Never throws.
 *
 * A leaf module: imports only ./mirror.ts types — never service.ts,
 * index-store.ts or lease.ts.
 */
import type { Mirror, MirrorContext, MirrorFailure } from "./mirror.ts";

/** Pinned from hermes-linear-connector@6e532fe `webhook_app.py:126-141`. */
export const CONNECTOR_COMPLETE_PATH = "/v1/complete-issue";

export interface DodEvidence {
	summary: string;
	tests_pass: boolean;
	review_pass?: boolean;
}

export interface DodGateDeps {
	mirror: Mirror;
	fetchImpl?: typeof fetch;
	hermesLinearUrl: string;
	timeoutMs: number;
}

export type DodGateResult =
	| { gate: "approved"; alreadyDone: boolean; mirrorFailures: MirrorFailure[] }
	| {
			gate: "refused";
			reason: "dod-required" | "dod-refused" | "dod-unavailable";
			detail: string;
			mirrorFailures: MirrorFailure[];
	  };

const DETAIL_LIMIT = 300;

function detailOf(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : String(cause);
	return message.slice(0, DETAIL_LIMIT);
}

export async function runDodGate(
	deps: DodGateDeps,
	ctx: MirrorContext,
	dod?: DodEvidence,
): Promise<DodGateResult> {
	const mirrorFailures: MirrorFailure[] = [];

	// Step 2: an earlier gate may have timed out after the connector moved the
	// issue. Linear already Done means approved without another review or call.
	const state = await deps.mirror.linearState(ctx);
	if (state?.type === "completed") return { gate: "approved", alreadyDone: true, mirrorFailures };

	// Step 3: review mirror. A failure is a warning; the sequence continues.
	mirrorFailures.push(...(await deps.mirror.review(ctx)));

	// Step 4: no evidence, no call — an evidence-free completion must never
	// reach the connector's stored-dod_pass fallback.
	if (!dod) {
		return {
			gate: "refused",
			reason: "dod-required",
			detail: "graph_complete on a Linear-linked node needs dod { summary, tests_pass }; the node stays started_review with the lease held",
			mirrorFailures,
		};
	}

	const url = `${deps.hermesLinearUrl.replace(/\/+$/, "")}${CONNECTOR_COMPLETE_PATH}`;
	let reply: Response;
	try {
		reply = await (deps.fetchImpl ?? fetch)(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				linear_issue_id: ctx.linearRef,
				summary: dod.summary,
				tests_pass: dod.tests_pass,
				...(dod.review_pass === undefined ? {} : { review_pass: dod.review_pass }),
			}),
			signal: AbortSignal.timeout(deps.timeoutMs),
		});
	} catch (cause) {
		if (cause instanceof Error && cause.name === "TimeoutError") {
			// The connector may have moved the issue before the wait ran out.
			// Settle by reading Linear, never by assuming.
			const settled = await deps.mirror.linearState(ctx);
			if (settled?.type === "completed") return { gate: "approved", alreadyDone: true, mirrorFailures };
			return {
				gate: "refused",
				reason: "dod-unavailable",
				detail: `connector timed out after ${deps.timeoutMs}ms and Linear still shows ${settled?.name ?? "unknown"}`,
				mirrorFailures,
			};
		}
		return {
			gate: "refused",
			reason: "dod-unavailable",
			detail: `connector unreachable: ${detailOf(cause)}`.slice(0, DETAIL_LIMIT),
			mirrorFailures,
		};
	}

	const text = await reply.text();
	if (!reply.ok) {
		return {
			gate: "refused",
			reason: "dod-unavailable",
			detail: `connector ${reply.status}: ${text.slice(0, DETAIL_LIMIT)}`,
			mirrorFailures,
		};
	}

	let body: unknown;
	try {
		body = JSON.parse(text) as unknown;
	} catch {
		return {
			gate: "refused",
			reason: "dod-unavailable",
			detail: `connector returned non-JSON: ${text.slice(0, DETAIL_LIMIT)}`,
			mirrorFailures,
		};
	}
	if (typeof body !== "object" || body === null || !("completed" in body)) {
		return {
			gate: "refused",
			reason: "dod-unavailable",
			detail: `connector reply has no completed flag: ${text.slice(0, DETAIL_LIMIT)}`,
			mirrorFailures,
		};
	}
	if (body.completed === true) return { gate: "approved", alreadyDone: false, mirrorFailures };
	const reason =
		"reason" in body && typeof body.reason === "string" && body.reason.length > 0
			? body.reason
			: "connector refused";
	return { gate: "refused", reason: "dod-refused", detail: reason.slice(0, DETAIL_LIMIT), mirrorFailures };
}
