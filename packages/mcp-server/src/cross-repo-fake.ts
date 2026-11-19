/**
 * The cross-repository operation log in memory: the same contract as `PgCrossRepoStore`, for the operation tests and for
 * `cross-repo-store.testkit.ts`, which runs one set of cases against both adapters so this fake cannot drift from the SQL.
 */
import type { CrossRepoDetail, CrossRepoOperation, CrossRepoStatus, CrossRepoStep, CrossRepoStepState, CrossRepoStore, NewCrossRepoOperation } from "./cross-repo-ops.ts";

/** A stored step: the operation's step as the store owns it, so its state and detail can change in place. */
type StoredStep = { -readonly [K in keyof CrossRepoStep]: CrossRepoStep[K] };

interface Row {
	key: string;
	fingerprint: string;
	branch: string;
	status: CrossRepoStatus;
	createdAt: string;
	updatedAt: string;
	steps: StoredStep[];
}

function viewOf(row: Row): CrossRepoOperation {
	return { ...row, steps: row.steps.map((step) => ({ ...step })) };
}

export class MemoryCrossRepoStore implements CrossRepoStore {
	private readonly rows = new Map<string, Row>();
	/** Writes made, so a test can assert that a refused request wrote nothing. */
	writes = 0;

	async create(input: NewCrossRepoOperation): Promise<{ inserted: boolean; operation: CrossRepoOperation }> {
		const existing = this.rows.get(input.key);
		if (existing !== undefined) return { inserted: false, operation: viewOf(existing) };
		const at = input.at.toISOString();
		const row: Row = {
			key: input.key,
			fingerprint: input.fingerprint,
			branch: input.branch,
			status: "running",
			createdAt: at,
			updatedAt: at,
			steps: input.steps.map((step) => ({ ...step, state: "pending", detail: null, updatedAt: at })),
		};
		this.rows.set(input.key, row);
		this.writes += 1;
		return { inserted: true, operation: viewOf(row) };
	}

	async load(key: string): Promise<CrossRepoOperation | null> {
		const row = this.rows.get(key);
		return row === undefined ? null : viewOf(row);
	}

	async moveStep(key: string, index: number, from: readonly CrossRepoStepState[], to: CrossRepoStepState, detail: CrossRepoDetail | null, at: Date): Promise<boolean> {
		const step = this.rows.get(key)?.steps.find((candidate) => candidate.index === index);
		if (step === undefined || !from.includes(step.state)) return false;
		step.state = to;
		step.detail = detail;
		step.updatedAt = at.toISOString();
		this.writes += 1;
		return true;
	}

	async setStatus(key: string, status: CrossRepoStatus, at: Date): Promise<void> {
		const row = this.rows.get(key);
		if (row === undefined) throw new Error("cross-repo operation is not in the store");
		row.status = status;
		row.updatedAt = at.toISOString();
		this.writes += 1;
	}
}
