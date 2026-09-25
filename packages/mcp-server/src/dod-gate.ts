/**
 * Client for hermes-linear-connector's Definition-of-Done gate,
 * `POST /v1/complete-issue`.
 *
 * The decision belongs to the connector (D-06): it alone checks the evidence
 * and alone moves the Linear issue to Done. This client only forwards the
 * caller's evidence and reports the answer. It never throws — an unreachable
 * or failing gate is a refusal with a reason, so substrate can never mistake
 * a gate outage for a completion.
 */

const DEFAULT_TIMEOUT_MS = 5000;
const BODY_LIMIT = 200;

/** What a completing agent claims about its work; the connector judges it. */
export interface DodEvidence {
	summary: string;
	tests_pass: boolean;
	review_pass?: boolean;
}

export interface GateResult {
	completed: boolean;
	reason: string | null;
}

export class DodGate {
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(
		private readonly baseUrl: string,
		opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
	) {
		this.fetchImpl = opts?.fetchImpl ?? fetch;
		this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async completeIssue(input: {
		linearIssueId: string;
		summary: string;
		testsPass: boolean;
		reviewPass: boolean;
	}): Promise<GateResult> {
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/v1/complete-issue`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					linear_issue_id: input.linearIssueId,
					summary: input.summary,
					tests_pass: input.testsPass,
					review_pass: input.reviewPass,
				}),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (cause) {
			return {
				completed: false,
				reason: `dod gate unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
			};
		}

		const text = await response.text().catch(() => "");
		if (!response.ok) {
			return { completed: false, reason: `dod gate error ${response.status}: ${text.slice(0, BODY_LIMIT)}` };
		}
		// Only an explicit `completed: true` counts; anything unreadable is a refusal.
		try {
			const body = JSON.parse(text) as { completed?: unknown; reason?: unknown };
			if (typeof body.completed === "boolean") {
				return { completed: body.completed, reason: typeof body.reason === "string" ? body.reason : null };
			}
		} catch {
			// fall through to the malformed-answer refusal
		}
		return { completed: false, reason: `dod gate returned a malformed answer: ${text.slice(0, BODY_LIMIT)}` };
	}
}
