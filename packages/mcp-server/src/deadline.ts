/**
 * One shared deadline for a fan-out of independent reads (uplift-2 R1 for the
 * brief; uplift-3 N5 for docs search).
 *
 * `race` settles a read against the deadline; a read that misses rejects
 * with `DeadlineError`, which the caller treats like any other failed read.
 * The underlying promise is not cancelled — a Postgres query has no abort
 * handle, and a RAGFlow fetch carries its own per-call timeout — but nobody
 * waits for it any more, so the caller's wait is bounded by the budget
 * rather than by the sum of its reads.
 */

/** A read that outlived the budget. Its message is what the stderr line and the reply show. */
export class DeadlineError extends Error {
	constructor(budgetMs: number, label: string) {
		super(`deadline (${budgetMs} ms ${label})`);
		this.name = "DeadlineError";
	}
}

export interface SharedDeadline {
	race: <T>(read: Promise<T>) => Promise<T>;
	clear: () => void;
}

/**
 * A deadline every read of one fan-out races. `budgetMs <= 0` is "no
 * deadline": each read is bounded only by its own timeout, which is the
 * pre-budget behaviour and the rollback.
 */
export function sharedDeadline(budgetMs: number, label: string): SharedDeadline {
	if (budgetMs <= 0) return { race: (read) => read, clear: () => {} };
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new DeadlineError(budgetMs, label)), budgetMs);
		timer.unref?.();
	});
	// A fan-out with nothing to read never races it; without this the timer's
	// rejection would be unhandled.
	expired.catch(() => {});
	return {
		race: (read) => Promise.race([read, expired]),
		clear: () => clearTimeout(timer),
	};
}
