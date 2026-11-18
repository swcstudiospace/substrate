/**
 * The Postgres adapter of the cross-repository operation log (phase 74). Built by `IndexStore.crossRepoStore()` over the
 * index's own pool; the tables are created by migration step 44. Each transition is one statement whose `where` clause is
 * the compare-and-set: a step is moved only from a state the caller names, and the statement reports whether it moved.
 *
 * A row is read back through closed-set checks: a stored status, step state or detail outside its set is a thrown error,
 * never a value passed on as if it were valid.
 */
import type { SQL } from "bun";
import {
	CROSS_REPO_DETAILS,
	CROSS_REPO_STATUSES,
	CROSS_REPO_STEP_STATES,
	type CrossRepoDetail,
	type CrossRepoOperation,
	type CrossRepoStatus,
	type CrossRepoStep,
	type CrossRepoStepState,
	type CrossRepoStore,
	type NewCrossRepoOperation,
} from "./cross-repo-ops.ts";
import type { RunUnderGate } from "./worktree-registry.ts";

function textOf(value: unknown, column: string): string {
	if (typeof value !== "string") throw new Error(`cross-repo row has a non-text ${column}`);
	return value;
}

function memberOf<T extends string>(values: readonly T[], value: unknown, column: string): T {
	const found = values.find((candidate) => candidate === value);
	if (found === undefined) throw new Error(`cross-repo row has an unknown ${column}`);
	return found;
}

function isoOf(value: unknown, column: string): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return new Date(value).toISOString();
	throw new Error(`cross-repo row has a non-timestamp ${column}`);
}

/** The operation under `key`, read through `db` (the pool or a transaction). Null when no row has the key. */
async function loadWith(db: SQL, key: string): Promise<CrossRepoOperation | null> {
	const ops = (await db`
		select op_key, fingerprint, branch, status, created_at, updated_at
		from cross_repo_operations where op_key = ${key}`) as Array<Record<string, unknown>>;
	const op = ops[0];
	if (op === undefined) return null;
	const rows = (await db`
		select idx, repo, base_ref, planned_sha, state, detail, updated_at
		from cross_repo_steps where op_key = ${key} order by idx asc`) as Array<Record<string, unknown>>;
	const steps: CrossRepoStep[] = rows.map((row) => ({
		index: Number(row.idx),
		repo: textOf(row.repo, "repo"),
		base: textOf(row.base_ref, "base_ref"),
		plannedSha: textOf(row.planned_sha, "planned_sha"),
		state: memberOf<CrossRepoStepState>(CROSS_REPO_STEP_STATES, row.state, "state"),
		detail: row.detail === null ? null : memberOf<CrossRepoDetail>(CROSS_REPO_DETAILS, row.detail, "detail"),
		updatedAt: isoOf(row.updated_at, "updated_at"),
	}));
	return {
		key: textOf(op.op_key, "op_key"),
		fingerprint: textOf(op.fingerprint, "fingerprint"),
		branch: textOf(op.branch, "branch"),
		status: memberOf<CrossRepoStatus>(CROSS_REPO_STATUSES, op.status, "status"),
		steps,
		createdAt: isoOf(op.created_at, "created_at"),
		updatedAt: isoOf(op.updated_at, "updated_at"),
	};
}

export class PgCrossRepoStore implements CrossRepoStore {
	constructor(
		private readonly sql: SQL,
		private readonly run: RunUnderGate,
	) {}

	async create(input: NewCrossRepoOperation): Promise<{ inserted: boolean; operation: CrossRepoOperation }> {
		const at = input.at.toISOString();
		return this.run("cross_repo.create", async () =>
			// One transaction: a reader sees the operation with all its steps or not at all.
			this.sql.begin(async (tx: SQL) => {
				const inserted = (await tx`
					insert into cross_repo_operations (op_key, fingerprint, branch, status, created_at, updated_at)
					values (${input.key}, ${input.fingerprint}, ${input.branch}, 'running', ${at}::timestamptz, ${at}::timestamptz)
					on conflict (op_key) do nothing
					returning op_key`) as unknown[];
				if (inserted.length === 0) {
					const existing = await loadWith(tx, input.key);
					if (existing === null) throw new Error("cross-repo operation conflicted on insert but cannot be read back");
					return { inserted: false, operation: existing };
				}
				for (const step of input.steps) {
					await tx`
						insert into cross_repo_steps (op_key, idx, repo, base_ref, planned_sha, state, detail, updated_at)
						values (${input.key}, ${step.index}, ${step.repo}, ${step.base}, ${step.plannedSha}, 'pending', null, ${at}::timestamptz)`;
				}
				const operation = await loadWith(tx, input.key);
				if (operation === null) throw new Error("cross-repo operation was written but cannot be read back");
				return { inserted: true, operation };
			}),
		);
	}

	async load(key: string): Promise<CrossRepoOperation | null> {
		return this.run("cross_repo.load", async () => loadWith(this.sql, key));
	}

	async moveStep(key: string, index: number, from: readonly CrossRepoStepState[], to: CrossRepoStepState, detail: CrossRepoDetail | null, at: Date): Promise<boolean> {
		const atIso = at.toISOString();
		return this.run("cross_repo.move", async () => {
			const moved = (await this.sql`
				update cross_repo_steps
				set state = ${to}, detail = ${detail}, updated_at = ${atIso}::timestamptz
				where op_key = ${key} and idx = ${index} and state = any(string_to_array(${from.join("|")}::text, '|'))
				returning idx`) as unknown[];
			return moved.length === 1;
		});
	}

	async setStatus(key: string, status: CrossRepoStatus, at: Date): Promise<void> {
		const atIso = at.toISOString();
		await this.run("cross_repo.status", async () => {
			const updated = (await this.sql`
				update cross_repo_operations set status = ${status}, updated_at = ${atIso}::timestamptz
				where op_key = ${key} returning op_key`) as unknown[];
			if (updated.length !== 1) throw new Error("cross-repo operation is not in the store");
		});
	}
}
