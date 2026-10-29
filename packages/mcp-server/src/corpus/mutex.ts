/**
 * A small async mutex: `run` calls hold the lock one at a time, in the order they asked. Used by the corpus ingest, whose
 * plane writes and plane deletes of two requests must not interleave. A process-local lock is enough because one server
 * process owns the corpus ingest; it is not a distributed lock and never touches Dragonfly.
 */
export class AsyncMutex {
	private tail: Promise<void> = Promise.resolve();

	/** Runs `work` once every earlier `run` has finished; releases the lock when `work` settles, even when it throws. */
	run<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.then(work);
		// The next holder waits for this one to settle either way; the caller still sees the rejection through `result`.
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
