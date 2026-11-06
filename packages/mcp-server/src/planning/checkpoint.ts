/**
 * Idempotent completion checkpoints and resume (phase 53, SOTA-09).
 *
 * A completion is keyed by `sha256(phase, step, fileHash)`, joined with newlines. The file hash is part of
 * the key, so a step completed against one version of its file is not complete against another.
 *
 * - `recordCompletion` writes through `CompletionStore.putIfAbsent`. Recording the same key twice leaves one
 *   record, and the second call reports `exists`.
 * - `planResume` is pure. Given the most recent checkpoint for a phase and the current file hashes, it says
 *   which steps are already complete and which must run. A step whose file hash changed runs again and is
 *   flagged `fileChanged`. The planner writes nothing; only the executed step's `recordCompletion` writes.
 *
 * Identifiers are restricted to a safe charset, so the newline join is unambiguous.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

const CompletionInputSchema = z
	.object({
		phase: z.string().regex(ID_RE),
		step: z.string().regex(ID_RE),
		fileHash: z.string().regex(HEX_SHA256_RE),
		recordedAtMs: z.number().int().nonnegative(),
	})
	.strict();

type CompletionInput = z.infer<typeof CompletionInputSchema>;

export const CompletionRecordSchema = CompletionInputSchema.extend({
	key: z.string().regex(HEX_SHA256_RE),
}).strict();

export type CompletionRecord = z.infer<typeof CompletionRecordSchema>;

/** The completion key: sha256 over the phase id, the plan step and the file hash, joined with newlines. */
export function completionKey(input: Pick<CompletionInput, "phase" | "step" | "fileHash">): string {
	return createHash("sha256").update([input.phase, input.step, input.fileHash].join("\n")).digest("hex");
}

/** The completion port. `putIfAbsent` is the only write: it never replaces a record. */
export interface CompletionStore {
	putIfAbsent(key: string, record: CompletionRecord): Promise<"inserted" | "exists">;
	/** Every record for one phase, in the order it was first inserted. */
	list(phase: string): Promise<CompletionRecord[]>;
}

/** A process-local store for tests and for reference. It keeps every record and never replaces one. */
export class InMemoryCompletionStore implements CompletionStore {
	private readonly records = new Map<string, CompletionRecord>();

	async putIfAbsent(key: string, record: CompletionRecord): Promise<"inserted" | "exists"> {
		if (this.records.has(key)) return "exists";
		this.records.set(key, copy(CompletionRecordSchema.parse(record)));
		return "inserted";
	}

	async list(phase: string): Promise<CompletionRecord[]> {
		return [...this.records.values()].filter((record) => record.phase === phase).map(copy);
	}
}

interface RecordCompletionResult {
	outcome: "inserted" | "exists";
	key: string;
}

/** Record that a step completed against this file hash. Idempotent: the same input twice is one record. */
export async function recordCompletion(store: CompletionStore, input: CompletionInput): Promise<RecordCompletionResult> {
	const valid = CompletionInputSchema.parse(input);
	const key = completionKey(valid);
	const outcome = await store.putIfAbsent(key, CompletionRecordSchema.parse({ key, ...valid }));
	return { outcome, key };
}

interface PlannedStep {
	step: string;
	/** The sha256 of the file this step works on, as it is now. */
	fileHash: string;
}

interface ResumeInput {
	phase: string;
	/** In execution order. Each step name appears once. */
	steps: readonly PlannedStep[];
	/** The completion records of the most recent checkpoint for this phase, from `CompletionStore.list`. */
	lastCheckpoint: readonly CompletionRecord[];
}

interface ResumeRun {
	step: string;
	fileHash: string;
	key: string;
	/** True when an earlier checkpoint completed this step against a different file hash. */
	fileChanged: boolean;
}

interface ResumeSkip {
	step: string;
	key: string;
}

interface ResumePlan {
	/** Steps to execute, in order. */
	run: ResumeRun[];
	/** Steps already complete against their current file hash, in order. Not to be re-run. */
	completed: ResumeSkip[];
}

export type ResumeResult =
	| { ok: true; plan: ResumePlan }
	| { ok: false; error: { code: "duplicate-step"; step: string } | { code: "checkpoint-key-mismatch"; key: string } };

export function planResume(input: ResumeInput): ResumeResult {
	const phase = z.string().regex(ID_RE).parse(input.phase);
	const seen = new Set<string>();
	for (const planned of input.steps) {
		if (seen.has(planned.step)) return { ok: false, error: { code: "duplicate-step", step: planned.step } };
		seen.add(planned.step);
	}

	const checkpoint = input.lastCheckpoint.filter((record) => record.phase === phase);
	const completedKeys = new Set<string>();
	for (const record of checkpoint) {
		const expected = completionKey(record);
		if (record.key !== expected) return { ok: false, error: { code: "checkpoint-key-mismatch", key: record.key } };
		completedKeys.add(record.key);
	}

	const run: ResumeRun[] = [];
	const completed: ResumeSkip[] = [];
	for (const planned of input.steps) {
		const key = completionKey({ phase, step: planned.step, fileHash: planned.fileHash });
		if (completedKeys.has(key)) {
			completed.push({ step: planned.step, key });
			continue;
		}
		const fileChanged = checkpoint.some(
			(record) => record.step === planned.step && record.fileHash !== planned.fileHash,
		);
		run.push({ step: planned.step, fileHash: planned.fileHash, key, fileChanged });
	}
	return { ok: true, plan: { run, completed } };
}

function copy(record: CompletionRecord): CompletionRecord {
	return { ...record };
}
